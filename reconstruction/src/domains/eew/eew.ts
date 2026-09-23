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
  RuntimeUnitDeadline,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  EewCurrent,
  EewGate,
  EewInput,
  EewNotificationPayload,
  EewPrediction,
  EewPredictionIntensity,
  EewUnitState,
  EewUnitStep,
} from "../../../contracts/p2-eew-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

const EEW_FAMILIES = ["VXSE43", "VXSE45"] as const;
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
    state, nextDeadline: nextEewDeadline(state),
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
      || (family === "VXSE43" && areas.length === 0)
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

function hasKnownPrediction(prediction: EewPrediction): boolean {
  const intensities = prediction.areas.length === 0
    ? [prediction.maximum] : prediction.areas.map((area) => area.intensity);
  return intensities.some(({ from, to }) => [from, to].some((value) =>
    value.kind === "number" || value.kind === "text" || value.kind === "range"));
}

function nextEewDeadline(state: EewUnitState): RuntimeUnitDeadline | null {
  const pending = [...state.intents.filter((item) => item.disposition === "pending"), ...state.deliveryRecords];
  return pending.length === 0 ? null
    : { wallTimeMs: Math.min(...pending.map((item) => item.expiresAt)), monotonicMs: null };
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

function reduceEew(state: EewUnitState, input: Extract<EewInput, { kind: "receive" }>): EewUnitStep {
  const validated = validateCandidate(input.material);
  if (validated.kind === "rejected")
    return rejection(state, input.material, validated.reason, validated.diagnostic);
  const candidate = validated.candidate;
  const gate = state.gates.find((item) => item.subject === candidate.subject);
  const previous = state.current.find((item) => item.subject === candidate.subject);
  if (gate != null && candidate.serial < gate.serial) return {
    state, nextDeadline: nextEewDeadline(state), decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "unchanged", reason: "stale" }], intents: [], outcomes: [], diagnostics: [],
  };
  const retainedPrediction = previous != null && candidate.prediction != null
    && !hasKnownPrediction(candidate.prediction)
    ? hasKnownPrediction(previous.prediction)
      ? { prediction: previous.prediction, source: previous.source } : previous.retainedPrediction
    : null;
  const predictionChanged = previous == null ? !candidate.terminal
    : !isDeepStrictEqual(previous.prediction, candidate.prediction);
  const projected: EewCurrent | null = candidate.cancelled || candidate.terminal ? null : {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    source: candidate.source, serial: candidate.serial, terminal: false, prediction: candidate.prediction!, retainedPrediction,
  };
  if (gate != null && candidate.serial === gate.serial) {
    const candidateTime = Date.parse(candidate.source.reportDateTimeRaw);
    const gateTime = Date.parse(gate.source.reportDateTimeRaw);
    if (candidateTime < gateTime || (gate.terminal && !candidate.terminal && candidateTime <= gateTime)) return {
      state, nextDeadline: nextEewDeadline(state), decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "unchanged", reason: "stale" }], intents: [], outcomes: [], diagnostics: [],
    };
    if (gate.terminal === candidate.terminal && gate.source.reportDateTimeRaw === candidate.source.reportDateTimeRaw
      && gate.source.infoTypeRaw === candidate.source.infoTypeRaw
      && !predictionChanged) return {
      state, nextDeadline: nextEewDeadline(state), decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "unchanged", reason: "duplicate" }], intents: [], outcomes: [], diagnostics: [],
    };
  }

  // Gate source wins; current-only subjects still consume the same family budget.
  const subjects = new Map<string, EewCurrent | EewGate>();
  for (const item of [...state.current, ...state.gates])
    if (item.family === candidate.family && item.subject !== candidate.subject) subjects.set(item.subject, item);
  const needed = Math.max(0, subjects.size + 1 - 512);
  const eligible = [...subjects.values()].filter((item) => item.operation !== "normal");
  if (eligible.length < needed) return {
    state, nextDeadline: nextEewDeadline(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "capacityExceeded",
      rejection: { family: candidate.family, reportDateTimeMs: Date.parse(candidate.source.reportDateTimeRaw), affectedScope: "subject" } }],
    intents: [], outcomes: [], diagnostics: [],
  };
  const evicted = new Set(needed === 0 ? [] : eligible.sort((left, right) => {
    const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
    if (time !== 0) return time;
    const a = [left.operation, left.subject, left.source.inputId];
    const b = [right.operation, right.subject, right.source.inputId];
    for (let index = 0; index < a.length; index++)
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    return 0;
  }).slice(0, needed).map((item) => item.subject));
  let currents = state.current.filter((item) => item.subject !== candidate.subject && !evicted.has(item.subject));
  let gates = state.gates.filter((item) => item.subject !== candidate.subject && !evicted.has(item.subject));
  if (projected != null) currents = [...currents, projected];
  const nextGate: EewGate = {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    serial: candidate.serial, terminal: candidate.terminal, source: candidate.source,
  };
  gates = [...gates, nextGate];

  const eventId = candidate.subject.split("/")[2];
  const previousLatch = state.notificationLatches.find((item) => item.operation === candidate.operation && item.eventId === eventId);
  const head = first(input.material.xml, "Head")!;
  const body = first(input.material.xml, "Body")!;
  const forecast = first(first(body, "Intensity") ?? body, "Forecast");
  const areaWarning = (forecast == null ? [] : elements(forecast, "Pref"))
    .flatMap((pref) => elements(pref, "Area")).flatMap((area) => elements(area, "Category"))
    .flatMap((category) => elements(category, "Kind")).some((kind) => {
      const code = first(kind, "Code");
      const value = Number.parseInt(code == null ? "" : scalar(code) ?? "", 10);
      return value >= 10 && value <= 19;
    });
  const headline = first(head, "Headline");
  const headlineWarning = (headline == null ? [] : elements(headline, "Information"))
    .flatMap((info) => elements(info, "Item")).flatMap((item) => elements(item, "Kind")).some((kind) => {
      const code = first(kind, "Code");
      return Number.parseInt(code == null ? "" : scalar(code) ?? "", 10) === 31;
    });
  const warning = candidate.family === "VXSE43" || areaWarning || headlineWarning;
  const correction = candidate.source.infoTypeRaw === "訂正";
  const notify = candidate.cancelled || correction || candidate.terminal
    || (!previousLatch?.vxse45Accepted || candidate.family !== "VXSE43")
      && (!previousLatch?.firstReportNotified || warning && !previousLatch.warningNotified);
  const eligibleNotice = candidate.family !== "VXSE43" || !previousLatch?.vxse45Accepted;
  const opportunity = notify && eligibleNotice;
  const baseTitle = warning ? "緊急地震速報（警報）" : "緊急地震速報（予報）";
  const title = candidate.cancelled ? "[取消] 緊急地震速報" : correction ? `[訂正] ${baseTitle}` : baseTitle;
  const earthquake = first(first(input.material.xml, "Body") ?? input.material.xml, "Earthquake");
  const hypocenter = earthquake == null ? null : first(first(first(earthquake, "Hypocenter") ?? earthquake, "Area") ?? earthquake, "Name");
  const magnitude = earthquake == null ? null : elements(earthquake).find((node) =>
    node.name === "Magnitude" || node.name.endsWith(":Magnitude")) ?? null;
  // The notification label preserves bounds; the largest bound is only used to choose the maximum.
  const intensityLabels = ["0", "1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
  let maxIntensity = "不明";
  let maximumRank = -1;
  let maximumPriority = -1;
  let maximumOpen = false;
  let uncertain = 0;
  const predictions = candidate.prediction == null ? []
    : [...candidate.prediction.areas.map((area) => area.intensity), candidate.prediction.maximum];
  // Arrival/PLUM conditions on Area remain raw prediction evidence, not intensity qualifiers.
  const forecastIntNodes = candidate.prediction == null ? [] : [
    ...elements(forecast!, "Pref").flatMap((pref) => elements(pref, "Area")).map((area) => first(area, "ForecastInt")!),
    first(forecast!, "ForecastInt")!,
  ];
  for (const [index, prediction] of predictions.entries()) {
    const node = forecastIntNodes[index];
    const condition = qualifier(null, node, first(node, "From"), first(node, "To"), "Condition");
    const description = qualifier(null, node, first(node, "From"), first(node, "To"), "Description");
    const [from, to] = [prediction.from, prediction.to].map((value) => value.kind === "missing" ? null
      : value.raw.normalize("NFKC").trim().replace("5-", "5弱").replace("5+", "5強").replace("6-", "6弱").replace("6+", "6強"));
    const special = [condition, description, from, to]
      .map((value) => value?.normalize("NFKC").trim().replace(/^震度(?=5弱以上未入電$|未入電$)/, ""))
      .find((value) => value != null && ["5弱以上未入電", "不明", "不詳", "観測できず", "未入電", "解析不能"].includes(value));
    const qualitative = special === "5弱以上未入電";
    if (from == null && to == null && condition == null && description == null) continue;
    const lower = intensityLabels.indexOf(from ?? to ?? "");
    const upper = intensityLabels.indexOf(to ?? from ?? "");
    const open = lower >= 0 && to?.toLowerCase() === "over";
    const rank = qualitative ? 5 : special != null ? -1 : upper >= lower ? upper : open ? lower : -1;
    const range = open || lower !== upper;
    const label = special ?? (open ? `${from}程度以上`
      : lower >= 0 && upper >= 0 ? lower === upper ? intensityLabels[lower] : `${from}〜${to}`
      : condition || description || [...new Set([from, to].filter((value) => value != null && value !== ""))].join("〜") || "空欄");
    const priority = qualitative ? 3 : range || rank < 0 && label !== "空欄" ? 2 : 1;
    if (rank < 0) uncertain++;
    if (rank > maximumRank || rank === maximumRank && priority > maximumPriority) {
      maxIntensity = label;
      maximumRank = rank;
      maximumPriority = priority;
      maximumOpen = open || qualitative;
    }
  }
  if (maximumRank >= 0 && uncertain !== 0)
    maxIntensity += maximumOpen ? "・一部不明" : "以上の可能性・一部不明";
  const magnitudeRaw = magnitude == null ? null : scalar(magnitude)?.normalize("NFKC").trim() ?? "";
  const magnitudeDescription = magnitude == null ? null : attribute(magnitude, "description")?.normalize("NFKC").trim();
  const magnitudeLabel = magnitudeRaw == null ? null
    : magnitudeDescription != null && /巨大地震/.test(magnitudeDescription) ? magnitudeDescription
    : magnitudeRaw !== "" && Number.isFinite(Number(magnitudeRaw)) ? `M${Number(magnitudeRaw).toFixed(1)}`
    : "M不明";
  const parts = [hypocenter == null ? null : scalar(hypocenter), magnitudeLabel,
    `最大予測震度${maxIntensity}`].filter((part): part is string => part != null && part !== "");
  let bodyText = candidate.cancelled ? "緊急地震速報は取り消されました。" : earthquake == null ? title : parts.join(" / ");
  if (correction && !candidate.cancelled) bodyText = `訂正: ${bodyText}`;
  const prefix = candidate.operation === "normal" ? "" : candidate.operation === "training" ? "【訓練】" : "【試験】";
  const lead = candidate.operation === "normal" ? "" : candidate.operation === "training"
    ? "訓練の電文です。通常運用の警報ではありません。\n" : "試験の電文です。通常運用の警報ではありません。\n";
  const payload: EewNotificationPayload = { domain: "earthquake-eew", level: candidate.cancelled ? "cancel" : warning ? "critical" : "warning",
    title: prefix + title, body: lead + bodyText };
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const newIntents: EewUnitState["intents"][number][] = opportunity ? channels.map((channel) => ({
    id: `U-E:${candidate.operation}:${eventId}:${state.persistence.currentGeneration + 1}:${channel}`,
    unit: "U-E", subject: candidate.subject, operation: candidate.operation, source: candidate.source,
    transition: candidate.cancelled ? "cancelled" : candidate.terminal ? "released" : previous == null ? "activated" : "updated",
    channel, payload, createdAt: input.clock.wallTimeMs, expiresAt: input.clock.wallTimeMs + 15_000,
    nextAttemptAt: input.clock.wallTimeMs, attempts: 0, configRevision: "p2-eew-unit-v1", disposition: "pending" as const,
  })) : [];
  const expired = state.intents.filter((intent) => intent.expiresAt <= input.clock.wallTimeMs);
  const active = state.intents.filter((intent) => intent.expiresAt > input.clock.wallTimeMs);
  const sameEvent = (intent: NotificationIntent) => intent.operation === candidate.operation
    && intent.subject.split("/")[2] === eventId;
  const replace = (intent: NotificationIntent) => evicted.has(intent.subject)
    || (candidate.cancelled || opportunity) && sameEvent(intent)
      && (candidate.cancelled || newIntents.some((item) => item.channel === intent.channel));
  const retained = active.filter((intent) => !replace(intent));
  const removed = active.filter(replace);
  let proposed = [...retained, ...newIntents];
  const evictedIntents: EewUnitState["intents"][number][] = [];
  const fits = () => proposed.length <= 128 && new TextEncoder().encode(JSON.stringify(proposed)).byteLength <= 131_072;
  if (!fits() && candidate.operation === "normal") {
    const lower = retained.filter((intent) => intent.operation !== "normal").sort((left, right) =>
      right.expiresAt - left.expiresAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    for (const intent of lower) {
      proposed = proposed.filter((item) => item !== intent);
      evictedIntents.push(intent);
      if (fits()) break;
    }
  }
  const admitted = fits();
  if (!admitted) {
    proposed = candidate.cancelled ? active.filter((intent) => !sameEvent(intent) && !evicted.has(intent.subject))
      : active.filter((intent) => !evicted.has(intent.subject));
    evictedIntents.length = 0;
  }
  const superseded = admitted ? removed : active.filter((intent) => evicted.has(intent.subject)
    || candidate.cancelled && sameEvent(intent));
  const records = [...state.deliveryRecords,
    ...expired.map((intent) => ({ intentId: intent.id, disposition: "expired" as const, expiresAt: intent.expiresAt })),
    ...[...superseded, ...evictedIntents].map((intent) => ({ intentId: intent.id, disposition: "superseded" as const, expiresAt: intent.expiresAt }))];
  const durableChanged = records.length !== state.deliveryRecords.length || proposed.length !== state.intents.length
    || proposed.some((intent, index) => intent !== state.intents[index]);
  const semanticChanged = predictionChanged
    || gate?.terminal !== candidate.terminal || evicted.size !== 0;
  const change = semanticChanged ? "semantic" : "revisionOnly";
  const next: EewUnitState = {
    ...state, current: currents, gates,
    intents: proposed,
    deliveryRecords: records,
    notificationLatches: [...state.notificationLatches.filter((item) =>
      (item.operation !== candidate.operation || item.eventId !== eventId)
      && [...currents, ...gates].some((owner) => owner.operation === item.operation && owner.subject.endsWith(`/${item.eventId}`))),
    { operation: candidate.operation, eventId,
      firstReportNotified: (previousLatch?.firstReportNotified ?? false) || admitted && opportunity && !candidate.cancelled,
      warningNotified: (previousLatch?.warningNotified ?? false) || admitted && opportunity && !candidate.cancelled && warning,
      vxse45Accepted: (previousLatch?.vxse45Accepted ?? false) || candidate.family === "VXSE45" }],
    persistence: durableChanged ? dirty(state.persistence, input.clock.monotonicMs) : state.persistence,
  };
  const transition = candidate.cancelled ? "cancelled" : candidate.terminal ? "released"
    : previous == null ? "activated" : "updated";
  return {
    state: next, nextDeadline: nextEewDeadline(next),
    decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: Date.parse(candidate.source.reportDateTimeRaw), affectedScope: "subject" } }],
    intents: admitted ? newIntents : [],
    outcomes: [{ kind: "accepted", change, subjects: [outcome(candidate, transition, candidate.prediction)] }],
    diagnostics: [
      ...(expired.length === 0 ? [] : [{ level: "INFO" as const, component: "eew", reason: "notificationExpired" as const,
        unit: "U-E" as const, count: expired.length }]),
      ...(evicted.size === 0 ? [] : [{ level: "INFO" as const, component: "eew", reason: "eewCapacityEvicted" as const,
        unit: "U-E" as const, count: evicted.size }]),
      ...(evictedIntents.length === 0 ? [] : [{ level: "INFO" as const, component: "eew", reason: "notificationCapacityEvicted" as const,
        unit: "U-E" as const, count: evictedIntents.length }]),
    ],
  };
}

export { reduceEew, nextEewDeadline, dirty };
