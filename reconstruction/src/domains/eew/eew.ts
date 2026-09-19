import { isDeepStrictEqual } from "node:util";
import type {
  DecodedMaterial,
  MaterialValue,
  XmlElement,
  XmlNode,
} from "../../../contracts/p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  JsonValue,
  NotificationIntent,
  PersistenceStatus,
  ReportRef,
  RejectionReason,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  EewCurrent,
  EewGate,
  EewInput,
  EewPrediction,
  EewPredictionIntensity,
  EewUnitState,
  EewUnitStep,
} from "../../../contracts/p2-eew-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

const EEW_FAMILIES = ["VXSE43", "VXSE44", "VXSE45"] as const;
type EewFamily = typeof EEW_FAMILIES[number];

type Candidate = Readonly<{
  operation: DecodedMaterial["operation"];
  family: EewFamily;
  subject: string;
  serial: number;
  cancelled: boolean;
  terminal: boolean;
  prediction: EewPrediction | null;
  source: ReportRef;
}>;

type CandidateResult =
  | Readonly<{ kind: "accepted"; candidate: Candidate }>
  | Readonly<{ kind: "rejected"; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

function elements(parent: XmlElement, name?: string): readonly XmlElement[] {
  return parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || node.name === name));
}

function directText(element: XmlElement): string | null {
  const nodes = element.children.filter((node): node is Extract<XmlNode, { kind: "text" }> => node.kind === "text");
  return nodes.length === 0 ? null : nodes.map((node) => node.value).join("");
}

function scalar(element: XmlElement): string | null {
  return elements(element).length === 0 ? directText(element) ?? "" : null;
}

function first(parent: XmlElement, name: string): XmlElement | null {
  return elements(parent, name)[0] ?? null;
}

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "eew", reason, inputId: material.inputId, unit: "U-E" };
}

function rejection(state: EewUnitState, material: DecodedMaterial, reason: RejectionReason,
  details = diagnostic(material, reason)): EewUnitStep {
  return {
    state,
    decisions: [{ subject: "", operation: material.operation, decision: "rejected", reason }],
    intents: [], outcomes: [], diagnostics: [details],
  };
}

function leafValues(material: DecodedMaterial): ReadonlyMap<XmlElement, MaterialValue> {
  const leaves: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    const nested = elements(node);
    if (nested.length === 0) leaves.push(node);
    else nested.forEach(visit);
  };
  visit(material.xml);
  const values = classifyMaterial(material).materialValues;
  return new Map(leaves.map((leaf, index) => [leaf, values[index]]));
}

function attribute(element: XmlElement | null, name: string): string | null {
  return element?.attributes.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function qualifier(area: XmlElement | null, forecast: XmlElement, from: XmlElement | null,
  to: XmlElement | null, name: "Condition" | "Description"): string | null {
  const nested = first(area ?? forecast, name) ?? first(forecast, name);
  const text = nested == null ? null : scalar(nested);
  return text ?? attribute(forecast, name) ?? attribute(from, name) ?? attribute(to, name) ?? null;
}

function intensity(forecast: XmlElement, area: XmlElement | null,
  values: ReadonlyMap<XmlElement, MaterialValue>): EewPredictionIntensity | null {
  const fromNodes = elements(forecast, "From");
  const toNodes = elements(forecast, "To");
  if ((directText(forecast)?.trim() ?? "") !== ""
    || elements(forecast).some((node) => !["From", "To", "Condition", "Description"].includes(node.name))
    || ["Condition", "Description"].some((name) => elements(forecast, name).length > 1
      || elements(forecast, name).some((node) => scalar(node) == null))
    || fromNodes.length > 1 || toNodes.length > 1
    || fromNodes.some((node) => scalar(node) == null)
    || toNodes.some((node) => scalar(node) == null)) return null;
  const from = fromNodes[0] == null ? { kind: "missing" as const } : values.get(fromNodes[0]);
  const to = toNodes[0] == null ? { kind: "missing" as const } : values.get(toNodes[0]);
  if (from == null || to == null) return null;
  return {
    from, to,
    condition: qualifier(area, forecast, fromNodes[0] ?? null, toNodes[0] ?? null, "Condition"),
    description: qualifier(area, forecast, fromNodes[0] ?? null, toNodes[0] ?? null, "Description"),
  };
}

function validateCandidate(material: DecodedMaterial): CandidateResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return common;

  if (typeof material.eventIdRaw !== "string" || material.eventIdRaw.trim() === "")
    return { kind: "rejected", reason: "identityMissing", diagnostic: diagnostic(material, "identityMissing") };
  if (typeof material.serialRaw !== "string" || material.serialRaw.trim() === "")
    return { kind: "rejected", reason: "identityMissing", diagnostic: diagnostic(material, "identityMissing") };

  const head = first(material.xml, "Head");
  const eventNodes = head == null ? [] : elements(head, "EventID");
  const serialNodes = head == null ? [] : elements(head, "Serial");
  const eventId = material.eventIdRaw.trim();
  if (!/^\d{14}$/.test(eventId) || eventNodes.length !== 1 || scalar(eventNodes[0])?.trim() !== eventId)
    return { kind: "rejected", reason: "identityInvalid", diagnostic: diagnostic(material, "identityInvalid") };
  if (!/^[1-9]\d*$/.test(material.serialRaw.trim()) || serialNodes.length !== 1
    || scalar(serialNodes[0])?.trim() !== material.serialRaw.trim())
    return { kind: "rejected", reason: "identityInvalid", diagnostic: diagnostic(material, "identityInvalid") };
  const serial = Number(material.serialRaw.trim());
  if (!Number.isSafeInteger(serial))
    return { kind: "rejected", reason: "identityInvalid", diagnostic: diagnostic(material, "identityInvalid") };

  const family = EEW_FAMILIES.find((family) => family === material.headType);
  if (family == null)
    return { kind: "rejected", reason: "requiredStructureInvalid", diagnostic: diagnostic(material, "requiredStructureInvalid") };
  const bodyNodes = elements(material.xml, "Body");
  if (bodyNodes.length === 0)
    return { kind: "rejected", reason: "requiredStructureMissing", diagnostic: diagnostic(material, "requiredStructureMissing") };
  if (bodyNodes.length !== 1)
    return { kind: "rejected", reason: "requiredStructureInvalid", diagnostic: diagnostic(material, "requiredStructureInvalid") };
  const body = bodyNodes[0];
  const cancelled = material.infoTypeRaw === "取消";
  const nextAdvisory = first(body, "NextAdvisory");
  const terminal = cancelled || (nextAdvisory != null && (scalar(nextAdvisory)?.trim() ?? "") !== "");
  let prediction: EewPrediction | null = null;

  if (!cancelled) {
    const intensityNodes = elements(body, "Intensity");
    // Inspect descendants before cardinality: a duplicate parent is not a missing child.
    const forecastNodes = intensityNodes.flatMap((node) => elements(node, "Forecast"));
    const maximumNodes = forecastNodes.flatMap((node) => elements(node, "ForecastInt"));
    const prefs = forecastNodes.flatMap((node) => elements(node, "Pref"));
    const areas = prefs.flatMap((pref) => elements(pref, "Area"));
    if (intensityNodes.length === 0 || forecastNodes.length === 0 || maximumNodes.length === 0
      || ((family === "VXSE43" || family === "VXSE44") && areas.length === 0)
      || areas.some((area) => elements(area, "ForecastInt").length === 0))
      return { kind: "rejected", reason: "requiredStructureMissing", diagnostic: diagnostic(material, "requiredStructureMissing") };
    if (intensityNodes.length !== 1 || forecastNodes.length !== 1 || maximumNodes.length !== 1
      || prefs.some((pref) => elements(pref, "Area").length === 0)
      || areas.some((area) => elements(area, "ForecastInt").length !== 1))
      return { kind: "rejected", reason: "requiredStructureInvalid", diagnostic: diagnostic(material, "requiredStructureInvalid") };

    const values = leafValues(material);
    const maximum = intensity(maximumNodes[0], null, values);
    const validCode = (node: XmlElement): boolean => {
      const codes = elements(node, "Code");
      return codes.length === 1 && /^\d+$/.test(scalar(codes[0])?.trim() ?? "");
    };
    const projectedAreas = areas.map((area) => {
      const codes = elements(area, "Code");
      const code = codes.length === 1 ? scalar(codes[0])?.trim() ?? "" : "";
      const projected = intensity(elements(area, "ForecastInt")[0], area, values);
      return { codes, code, projected };
    });
    if (maximum == null || prefs.some((pref) => !validCode(pref)) || projectedAreas.some(({ codes, code, projected }) =>
      codes.length !== 1 || !/^\d+$/.test(code) || projected == null))
      return { kind: "rejected", reason: "requiredStructureInvalid", diagnostic: diagnostic(material, "requiredStructureInvalid") };
    prediction = {
      maximum,
      areaCoverage: projectedAreas.length === 0 ? "none" : "present",
      areas: projectedAreas.map(({ code, projected }) => ({ code, intensity: projected! })),
    };
  }

  const subject = `${material.operation}/${family}/${eventId}`;
  return { kind: "accepted", candidate: {
    operation: material.operation, family, subject, serial, cancelled, terminal, prediction,
    source: {
      inputId: material.inputId, origin: material.origin, operation: material.operation,
      family, subject, reportDateTimeRaw: material.reportDateTimeRaw,
      serialRaw: material.serialRaw, infoTypeRaw: material.infoTypeRaw,
    },
  } };
}

function losesKnownPrediction(previous: EewPrediction, latest: EewPrediction): boolean {
  const losesBound = (before: MaterialValue, after: MaterialValue): boolean =>
    after.kind === "unknown" && (before.kind === "number" || before.kind === "text" || before.kind === "range");
  const losesIntensity = (before: EewPredictionIntensity, after: EewPredictionIntensity): boolean =>
    losesBound(before.from, after.from) || losesBound(before.to, after.to);
  return losesIntensity(previous.maximum, latest.maximum) || latest.areas.some((area) => {
    const before = previous.areas.find((item) => item.code === area.code);
    return before != null && losesIntensity(before.intensity, area.intensity);
  });
}

function dirty(persistence: PersistenceStatus, nowMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? nowMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

function outcome(candidate: Candidate, transition: string, prediction: EewPrediction | null): SubjectOutcome {
  const facts: Readonly<Record<string, JsonValue>> = {
    family: candidate.family, serial: candidate.serial, terminal: candidate.terminal,
    ...(prediction == null ? {} : { prediction }),
  };
  return {
    subject: candidate.subject, operation: candidate.operation,
    informationType: candidate.source.infoTypeRaw, transition, severity: null,
    source: candidate.source, facts, changedFields: ["current", "gates"],
  };
}

function supersede(intents: readonly NotificationIntent[], subjects: ReadonlySet<string>): Readonly<{
  intents: readonly NotificationIntent[];
  records: EewUnitState["deliveryRecords"];
}> {
  const removed = intents.filter((intent) => subjects.has(intent.subject));
  return {
    intents: intents.filter((intent) => !subjects.has(intent.subject)),
    records: removed.map((intent) => ({ intentId: intent.id, disposition: "superseded", expiresAt: intent.expiresAt })),
  };
}

function reduceEew(state: EewUnitState, input: Extract<EewInput, { kind: "receive" }>): EewUnitStep {
  const validated = validateCandidate(input.material);
  if (validated.kind === "rejected")
    return rejection(state, input.material, validated.reason, validated.diagnostic);
  const candidate = validated.candidate;
  const gate = state.gates.find((item) => item.subject === candidate.subject);
  const previous = state.current.find((item) => item.subject === candidate.subject);
  if (gate != null && candidate.serial < gate.serial) return {
    state, decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "unchanged", reason: "stale" }], intents: [], outcomes: [], diagnostics: [],
  };
  // The frozen public type has one prediction/source pair. Preserve that evidence
  // on unknown follow-ups; gate tracks the latest revision, outcome carries latest raw.
  // A simultaneous latest+retained view needs the contract addition in a4-report.md.
  const retain = previous != null && candidate.prediction != null
    && losesKnownPrediction(previous.prediction, candidate.prediction);
  // A shared source reference means current still contains the gate's received raw.
  // Compare that raw before retention can hide a same-version correction. Once
  // retained, the frozen gate has no raw field; its gate-only fallback remains
  // until the latest/retained prediction contract is extended.
  const predictionChanged = previous == null ? !candidate.terminal
    : previous.source === gate?.source
      ? !isDeepStrictEqual(previous.prediction, candidate.prediction)
      : !retain;
  const projected: EewCurrent | null = candidate.cancelled || candidate.terminal ? null : retain ? previous : {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    source: candidate.source, serial: candidate.serial, terminal: false, prediction: candidate.prediction!,
  };
  if (gate != null && candidate.serial === gate.serial) {
    const candidateTime = Date.parse(candidate.source.reportDateTimeRaw);
    const gateTime = Date.parse(gate.source.reportDateTimeRaw);
    if (candidateTime < gateTime || (gate.terminal && !candidate.terminal && candidateTime <= gateTime)) return {
      state, decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "unchanged", reason: "stale" }], intents: [], outcomes: [], diagnostics: [],
    };
    if (gate.terminal === candidate.terminal && gate.source.reportDateTimeRaw === candidate.source.reportDateTimeRaw
      && gate.source.infoTypeRaw === candidate.source.infoTypeRaw
      && !predictionChanged) return {
      state, decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "unchanged", reason: "duplicate" }], intents: [], outcomes: [], diagnostics: [],
    };
  }

  let currents = state.current.filter((item) => item.subject !== candidate.subject);
  let gates = state.gates.filter((item) => item.subject !== candidate.subject);
  const evicted = new Set<string>();
  if (gate == null) {
    const familyGates = gates.filter((item) => item.family === candidate.family);
    if (familyGates.length >= 512) {
      const oldest = familyGates[0];
      gates = gates.filter((item) => item.subject !== oldest.subject);
      currents = currents.filter((item) => item.subject !== oldest.subject);
      evicted.add(oldest.subject);
    }
  }
  if (projected != null) currents = [...currents, projected];
  const nextGate: EewGate = {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    serial: candidate.serial, terminal: candidate.terminal, source: candidate.source,
  };
  gates = [...gates, nextGate];

  const supersededSubjects = new Set([candidate.subject, ...evicted]);
  const delivery = supersede(state.intents, supersededSubjects);
  const durableChanged = delivery.records.length !== 0;
  const semanticChanged = predictionChanged
    || gate?.terminal !== candidate.terminal || evicted.size !== 0;
  const change = semanticChanged ? "semantic" : "revisionOnly";
  const next: EewUnitState = {
    ...state, current: currents, gates,
    intents: delivery.intents,
    deliveryRecords: delivery.records.length === 0
      ? state.deliveryRecords : [...state.deliveryRecords, ...delivery.records],
    persistence: durableChanged ? dirty(state.persistence, input.nowMs) : state.persistence,
  };
  const transition = candidate.cancelled ? "cancelled" : candidate.terminal ? "released"
    : previous == null ? "activated" : "updated";
  return {
    state: next,
    decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "changed", reason: null, change }],
    intents: [],
    outcomes: [{ kind: "accepted", change, subjects: [outcome(candidate, transition, candidate.prediction)] }],
    diagnostics: [],
  };
}

export { reduceEew };
