import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
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
  EewNoticeFamily,
  EewNoticeMark,
  EewNotificationPayload,
  EewPrediction,
  EewPredictionIntensity,
  EewUnitState,
  EewUnitStep,
} from "../../../contracts/p2-eew-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime"; import { controlDateTimeOf, stepVersion, versionKey } from "../../contracts-revision/version";
import { cancelText, freshState, noticeId } from "../../units/notice-mark"; import type { EewReportFacts } from "../../../contracts/p3-eew-facts.types";

const EEW_FAMILIES = ["VXSE43", "VXSE45"] as const;
type EewFamily = typeof EEW_FAMILIES[number];

// P3-NL-RES-01（置き値）: EventID ごとの印は gate と別に 2,048 件まで。
const NOTICE_LIMIT = 2_048;
type EewIntent = EewUnitState["intents"][number];

// Immutable notification objects own the data; this only memoizes their UTF-8 size.
const notificationByteCache = new WeakMap<object, number>();
function notificationArrayBytes(values: readonly object[]): number {
  return values.reduce((sum, value) => {
    let bytes = notificationByteCache.get(value);
    if (bytes == null) {
      bytes = Buffer.byteLength(JSON.stringify(value));
      notificationByteCache.set(value, bytes);
    }
    return sum + bytes;
  }, 2 + Math.max(values.length - 1, 0));
}

type Candidate = Readonly<{
  operation: DecodedMaterial["operation"];
  family: EewFamily;
  subject: string;
  serial: number;
  cancelled: boolean;
  terminal: boolean;
  prediction: EewPrediction | null;
  warningAreas: readonly string[];
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

function diagnostic(material: DecodedMaterial, reason: DiagnosticDetails["reason"]): DiagnosticDetails {
  return { level: "WARN", component: "eew", reason, inputId: material.inputId, unit: "U-E" };
}

function rejection(state: EewUnitState, material: DecodedMaterial, reason: RejectionReason,
  details = diagnostic(material, reason)): Omit<EewUnitStep, "displayChanges" | "confirmationEvidence"> {
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
  let warningAreas: readonly string[] = [];

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
    warningAreas = projectedAreas.filter((_, index) => elements(areas[index], "Category")
      .flatMap((category) => elements(category, "Kind")).some((kind) => {
        const code = first(kind, "Code");
        const value = Number.parseInt(code == null ? "" : scalar(code) ?? "", 10);
        return value >= 10 && value <= 19;
      })).map(({ code }) => code);
  }

  const subject = `${material.operation}/${family}/${eventId}`;
  return { kind: "accepted", candidate: {
    operation: material.operation, family, subject, serial, cancelled, terminal, prediction, warningAreas,
    source: {
      inputId: material.inputId, origin: material.origin, operation: material.operation,
      family, subject, reportDateTimeRaw: material.reportDateTimeRaw, controlDateTimeRaw: controlDateTimeOf(material.controlDateTimeRaw),
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

function isAssumedHypocenter(earthquake: XmlElement | null, forecast: XmlElement | null,
  magnitudeRaw: string | null): boolean {
  if (earthquake == null) return false;
  const condition = scalar(first(earthquake, "Condition") ?? earthquake)?.normalize("NFKC").replace(/\s+/g, "") ?? "";
  if (condition.includes("仮定震源要素")) return true;
  const area = first(first(earthquake, "Hypocenter") ?? earthquake, "Area");
  const coordinates = area == null ? [] : elements(area).filter((node) => node.name.endsWith("Coordinate"));
  const coordinate = coordinates.find((node) => attribute(node, "type") !== "震源位置（度分）") ?? coordinates[0];
  const component = String.raw`[+-](?:\d+(?:\.\d+)?|\.\d+)`;
  const depth = coordinate == null ? null : directText(coordinate)?.match(new RegExp(`^${component}${component}(${component})/$`));
  const depthKm = depth == null ? null : Math.abs(Number(depth[1])) / (Math.abs(Number(depth[1])) >= 1000 ? 1000 : 1);
  const appendix = forecast == null ? null : first(forecast, "Appendix");
  const reason = appendix == null ? null : scalar(first(appendix, "MaxIntChangeReason") ?? appendix)?.trim();
  const plum = forecast != null && elements(forecast, "Pref").flatMap((pref) => elements(pref, "Area"))
    .some((item) => /PLUM法/.test((scalar(first(item, "Condition") ?? item) ?? "").normalize("NFKC").replace(/\s+/g, "")));
  return Number.parseFloat(Number.parseFloat(magnitudeRaw ?? "").toFixed(1)) === 1
    && depthKm === 10 && (Number.parseInt(reason ?? "", 10) === 9 || plum);
}

// P3-LIFE-SEM-01・RET-01・SEM-02: 起点 base＝min(ReportDateTime, 受信時刻) からの current・gate の期限と新規 subject の horizon。
const CURRENT_MS = 600_000;
const GATE_MS = 86_400_000;
const HORIZON_MS = 600_000;

// gates 配列（不変）ごとの期限の最小。無いと記録の整理の後や期限回収の後に nextDeadline を出し直すたびに全 gate を読み直し、
// 受信・期限処理 1 回で gates の線形 1 回を超える（P3-LIFE-RES-01）。
const gateDeadlineCache = new WeakMap<EewUnitState["gates"], number>();
function gateDeadline(gates: EewUnitState["gates"]): number {
  let at = gateDeadlineCache.get(gates);
  if (at == null) {
    at = Infinity;
    for (const gate of gates) at = Math.min(at, gate.currentUntil ?? Infinity, gate.retainUntil);
    gateDeadlineCache.set(gates, at);
  }
  return at;
}

// 印の配列（不変）ごとの retainUntil の最小（gateDeadline と同じ理由。無いと期限の出し直しのたびに 2,048 件を読み直す）。
const noticeDeadlineCache = new WeakMap<EewUnitState["notices"], number>();
function noticeDeadline(notices: EewUnitState["notices"]): number {
  let at = noticeDeadlineCache.get(notices);
  if (at == null) { at = notices.reduce((min, item) => Math.min(min, item.retainUntil), Infinity); noticeDeadlineCache.set(notices, at); }
  return at;
}

function nextEewDeadline(state: EewUnitState): RuntimeUnitDeadline | null {
  let wallTimeMs = Infinity;
  for (const item of state.intents) wallTimeMs = Math.min(wallTimeMs, item.expiresAt);
  // current/gate が残る限り null にしない（P3-LIFE-AC01）。currentUntil は retainUntil より前なので両方を見る。印の期限も入れる（P3-NL-AC04 (6)）。
  wallTimeMs = Math.min(wallTimeMs, gateDeadline(state.gates), noticeDeadline(state.notices));
  return wallTimeMs === Infinity ? null : { wallTimeMs, monotonicMs: null };
}

// ---- 通知の印（P3-NL-AC04。EventID ごとに保存し、gate の退去・期限に縛られない） ----

const noticeKey = (operation: string, eventId: string) => `${operation}/${eventId}`;
// 印の位置（配列に結び付けた Map。受理 1 回に 1 回の参照、P3-NL-AC16）。
const noticeIndexCache = new WeakMap<EewUnitState["notices"], ReadonlyMap<string, number>>();
function noticeAt(notices: EewUnitState["notices"], operation: string, eventId: string): number | undefined {
  let index = noticeIndexCache.get(notices);
  if (index == null) { index = new Map(notices.map((item, at) => [noticeKey(item.operation, item.eventId), at])); noticeIndexCache.set(notices, index); }
  return index.get(noticeKey(operation, eventId));
}
const familyOf = (mark: EewNoticeMark | undefined, family: EewFamily) => mark?.families.find((item) => item.family === family);
// 受けた報の比べる材料を保存の形にそろえる（ReportDateTime も Control/DateTime と同じ 40 文字の上限、Serial は trim。EEW の版の比べは
// Control/DateTime と Serial だけなので比べ方は変わらない）。
function familyRecord(source: ReportRef, family: EewFamily, cancelled: boolean, kinds: EewNoticeFamily["kinds"]): EewNoticeFamily {
  return { family, reportDateTimeRaw: controlDateTimeOf(source.reportDateTimeRaw), controlDateTimeRaw: source.controlDateTimeRaw,
    serialRaw: source.serialRaw.trim(), cancelled, kinds };
}
// (2): 版の材料は通知を作らない採用でも最後に採った版へ進める。kind は admit を通った種類（無ければ null）で、同じ版なら足し、版が変われば作り直す。
function nextFamilies(families: readonly EewNoticeFamily[], source: ReportRef, family: EewFamily, cancelled: boolean,
  kind: "report" | "cancel" | null): readonly EewNoticeFamily[] {
  const previous = families.find((item) => item.family === family);
  const same = previous != null && versionKey(previous) === versionKey(source);
  const kinds = (["report", "cancel"] as const).filter((item) => item === kind || same && previous.kinds.includes(item));
  const record = familyRecord(source, family, cancelled, kinds);
  return [...families.filter((item) => item.family !== family), record].sort((left, right) => left.family < right.family ? -1 : 1);
}
// (4): その family の記録に同じ版の鍵と種類があれば、もう作らない（family をまたぐ重複は latch の規則で抑える）。
function noticed(mark: EewNoticeMark | undefined, family: EewFamily, source: ReportRef, kind: "report" | "cancel"): boolean {
  const record = familyOf(mark, family);
  return record != null && record.kinds.includes(kind) && versionKey(record) === versionKey(source);
}
// 欄ごとの比べ（family 2 件・種類 2 件まで）。同じなら印の配列を作り直さず、保存世代も進めない。
function sameMark(left: EewNoticeMark, right: EewNoticeMark): boolean {
  return left.firstReportNotified === right.firstReportNotified && left.warningNotified === right.warningNotified
    && left.vxse45Accepted === right.vxse45Accepted && left.deliveryEvidence === right.deliveryEvidence
    && left.notifiedMaximumRank === right.notifiedMaximumRank && left.notifiedWarningAreas === right.notifiedWarningAreas
    && left.retainUntil === right.retainUntil && left.families.length === right.families.length
    && left.families.every((item, at) => {
      const other = right.families[at];
      return item.family === other.family && item.reportDateTimeRaw === other.reportDateTimeRaw && item.controlDateTimeRaw === other.controlDateTimeRaw
        && item.serialRaw === other.serialRaw && item.cancelled === other.cancelled && item.kinds.join() === other.kinds.join();
    });
}
// (7): 印を置き換えるか足す。2,048 件を越えるなら、gate も current も pending の intent も無い印のうち retainUntil の最小（同じなら
// operation・EventID の順）を 1 件捨てる。
// ponytail: 越えた採用だけ印を線形に 1 回探す（上限 2,048、AGENTS.md の上限のある稀な一括処理）。
function placeNotice(notices: readonly EewNoticeMark[], mark: EewNoticeMark, at: number | undefined,
  gates: readonly EewGate[], current: readonly EewCurrent[], intents: readonly EewIntent[]): Readonly<{ notices: readonly EewNoticeMark[]; evicted: number }> {
  if (at != null) return { notices: sameMark(notices[at], mark) ? notices : notices.map((item, position) => position === at ? mark : item), evicted: 0 };
  if (notices.length < NOTICE_LIMIT) return { notices: [...notices, mark], evicted: 0 };
  const owned = new Set([...gates, ...current, ...intents].map((item) => noticeKey(item.operation, item.subject.split("/")[2])));
  owned.add(noticeKey(mark.operation, mark.eventId));
  let victim: EewNoticeMark | null = null;
  for (const item of notices) {
    if (owned.has(noticeKey(item.operation, item.eventId))) continue;
    if (victim == null || item.retainUntil < victim.retainUntil || item.retainUntil === victim.retainUntil
      && (item.operation < victim.operation || item.operation === victim.operation && item.eventId < victim.eventId)) victim = item;
  }
  return victim == null ? { notices: [...notices, mark], evicted: 0 } : { notices: [...notices.filter((item) => item !== victim), mark], evicted: 1 };
}

// P3-LIFE-AC01: deadline 入力での current・gate の期限回収（期限ちょうどで失効）。失効は取消ではないので取消の表示・通知を作らない。
// current・gate は非保存なので、ここでは保存世代を進めない。
function reclaimEewLifetime(state: EewUnitState, wallTimeMs: number,
  changed: (before: EewCurrent | null, after: EewCurrent | null) => void): Readonly<{ state: EewUnitState; expired: readonly EewCurrent[] }> {
  // 既知の最小がまだ先なら走査しない。走査するときは判定と残る gate の最小を同じ 1 回で求める。
  if ((gateDeadlineCache.get(state.gates) ?? -Infinity) > wallTimeMs) return { state, expired: [] };
  const ending = new Set<string>();
  let gateRemoved = false;
  let next = Infinity;
  const gates = state.gates.flatMap((gate) => {
    const { currentUntil, retainUntil } = gate;
    const currentEnds = currentUntil != null && currentUntil <= wallTimeMs;
    if (currentEnds) ending.add(gate.subject);
    if (retainUntil <= wallTimeMs) { gateRemoved = true; return []; }
    next = Math.min(next, currentEnds ? Infinity : currentUntil ?? Infinity, retainUntil);
    return currentEnds ? [{ ...gate, currentUntil: null }] : [gate];
  });
  if (ending.size === 0 && !gateRemoved) { gateDeadlineCache.set(state.gates, next); return { state, expired: [] }; }
  gateDeadlineCache.set(gates, next);
  const expired = state.current.filter((item) => ending.has(item.subject));
  expired.forEach((item) => changed(item, null));
  const current = expired.length === 0 ? state.current : state.current.filter((item) => !ending.has(item.subject));
  // 印は gate の除去で消えず、evidenceUnknownUntil も延ばさない（P3-NL-AC04 (6)）。
  return { state: { ...state, current, gates }, expired };
}

function expiredOutcome(current: EewCurrent): SubjectOutcome {
  return {
    subject: current.subject, operation: current.operation, informationType: current.source.infoTypeRaw,
    transition: "expired", severity: null, source: current.source,
    facts: { family: current.family, serial: current.serial, eventId: current.eventId, warningClass: current.warningClass },
    changedFields: ["current"],
  };
}

function dirty(persistence: PersistenceStatus, nowMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? nowMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

function outcome(candidate: Candidate, transition: string, prediction: EewPrediction | null, warning: boolean): SubjectOutcome {
  const facts: Readonly<Record<string, JsonValue>> = {
    family: candidate.family, serial: candidate.serial, terminal: candidate.terminal,
    eventId: candidate.subject.split("/")[2], warningClass: warning ? "warning" : "forecast",
    ...(prediction == null ? {} : { prediction }),
  };
  return {
    subject: candidate.subject, operation: candidate.operation,
    informationType: candidate.source.infoTypeRaw, transition, severity: null,
    source: candidate.source, facts, changedFields: ["current", "gates"],
  };
}

function reduceEew(state: EewUnitState, input: Extract<EewInput, { kind: "receive" }>,
  changed: (before: EewCurrent | null, after: EewCurrent | null) => void = () => {}): Omit<EewUnitStep, "displayChanges" | "confirmationEvidence"> {
  const validated = validateCandidate(input.material);
  if (validated.kind === "rejected")
    return rejection(state, input.material, validated.reason, validated.diagnostic);
  const candidate = validated.candidate;
  if (candidate.source.origin === "recovery") return {
    state, nextDeadline: nextEewDeadline(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }],
    intents: [], outcomes: [], diagnostics: [],
  };
  const body = first(input.material.xml, "Body")!;
  const forecast = first(first(body, "Intensity") ?? body, "Forecast");
  const earthquake = first(body, "Earthquake");
  const hypocenter = earthquake == null ? null : first(first(first(earthquake, "Hypocenter") ?? earthquake, "Area") ?? earthquake, "Name");
  const magnitude = earthquake == null ? null : elements(earthquake).find((node) =>
    node.name === "Magnitude" || node.name.endsWith(":Magnitude")) ?? null;
  const magnitudeRaw = magnitude == null ? null : scalar(magnitude)?.normalize("NFKC").trim() ?? "";
  const magnitudeDescription = magnitude == null ? null : attribute(magnitude, "description")?.normalize("NFKC").trim();
  const magnitudeLabel = magnitudeRaw == null ? null
    : magnitudeDescription != null && /巨大地震/.test(magnitudeDescription) ? magnitudeDescription
    : magnitudeRaw !== "" && Number.isFinite(Number(magnitudeRaw)) ? `M${Number(magnitudeRaw).toFixed(1)}`
    : "M不明";
  const assumed = isAssumedHypocenter(earthquake, forecast, magnitudeRaw);
  const noticeSource = { hypocenter: hypocenter == null ? null : scalar(hypocenter),
    magnitude: assumed ? null : magnitudeLabel, isAssumedHypocenter: assumed };
  const eventId = candidate.subject.split("/")[2];
  const warningAreas = candidate.warningAreas;
  const headline = first(first(input.material.xml, "Head")!, "Headline");
  const headlineWarning = (headline == null ? [] : elements(headline, "Information"))
    .flatMap((info) => elements(info, "Item")).flatMap((item) => elements(item, "Kind")).some((kind) => {
      const code = first(kind, "Code");
      return Number.parseInt(code == null ? "" : scalar(code) ?? "", 10) === 31;
    });
  const warning = candidate.family === "VXSE43" || warningAreas.length > 0 || headlineWarning;
  const warningClass = warning ? "warning" as const : "forecast" as const;
  const gate = state.gates.find((item) => item.subject === candidate.subject);
  const previous = state.current.find((item) => item.subject === candidate.subject);
  const retainedPrediction = previous != null && candidate.prediction != null
    && !hasKnownPrediction(candidate.prediction)
    ? hasKnownPrediction(previous.prediction)
      ? { prediction: previous.prediction, source: previous.source } : previous.retainedPrediction
    : null;
  // P3-LIFE-D-F17KEY: 今回報の予測の JSON 化はこの 1 回だけ。current の無い同版では gate の比較材料で予測と warningClass の差を見る。
  const predictionKey = candidate.cancelled ? null
    : createHash("sha256").update(JSON.stringify([candidate.prediction, warningClass])).digest("hex");
  const predictionChanged = previous != null ? !isDeepStrictEqual(previous.prediction, candidate.prediction)
    : gate != null && candidate.serial === gate.serial ? gate.predictionKey !== predictionKey : !candidate.terminal;
  const projected: EewCurrent | null = candidate.cancelled || candidate.terminal ? null : {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    eventId, warningClass,
    source: candidate.source, serial: candidate.serial, terminal: false, prediction: candidate.prediction!, retainedPrediction,
    isAssumedHypocenter: assumed,
  };
  // P3-VM-AC03・AC04: gate と Control/DateTime で比べ、同じ秒なら Serial の大きい方を新しい版とする（P3-VM-D-SAMETIME=A の EEW の例外）。
  // P3-NL-AC04 (3): gate の無い報（再起動・退去の後）は、その EventID・family の印の記録を手元の版として同じ規則で比べる。
  const markAt = noticeAt(state.notices, candidate.operation, eventId);
  const mark = markAt == null ? undefined : state.notices[markAt];
  const recorded = gate == null ? familyOf(mark, candidate.family) : undefined;
  let version = stepVersion(gate != null ? { version: gate.source, source: gate.source, cancelled: gate.source.infoTypeRaw === "取消" }
    : recorded == null ? null : { version: recorded, source: null, cancelled: recorded.cancelled },
  gate?.unconfirmed ?? null, candidate.source, () => gate != null && gate.terminal === candidate.terminal
      && gate.source.reportDateTimeRaw === candidate.source.reportDateTimeRaw
      && (gate.source.infoTypeRaw === candidate.source.infoTypeRaw
        || candidate.source.infoTypeRaw === "訂正" && assumed && gate.noticeSource.isAssumedHypocenter)
      && !predictionChanged && (previous == null || candidate.cancelled || candidate.terminal
        || previous.warningClass === warningClass)
      && isDeepStrictEqual(gate.noticeSource, noticeSource), candidate.cancelled);
  // 記録しか無いときは中身を比べないので、同じ版を duplicate に寄せず採る（current は作り直し、種類の照合で鳴らない）。取消済みの取消の
  // 再送は stale（P3-NL-AC04 (3)(5)）。
  if (recorded != null && version.kind === "held")
    version = recorded.cancelled && candidate.cancelled && !version.missing ? { kind: "older" } : { kind: "adopt", mark: null, missing: version.missing };
  const missing = (version.kind === "held" || version.kind === "adopt") && version.missing
    ? [diagnostic(input.material, "requiredStructureMissing")] : [];
  if (version.kind !== "adopt") {
    // 印は gate の項目（非保存）なので保存世代を進めない。
    const unconfirmed = version.kind === "held" ? version.mark : null;
    const gates = unconfirmed != null && unconfirmed !== gate?.unconfirmed
      ? state.gates.map((item) => item === gate ? { ...item, unconfirmed } : item) : state.gates;
    return { state: gates === state.gates ? state : { ...state, gates }, nextDeadline: nextEewDeadline(state),
      decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged",
        reason: version.kind === "duplicate" ? "duplicate" : "stale" }], intents: [], outcomes: [], diagnostics: missing };
  }
  const prefix = candidate.operation === "normal" ? "" : candidate.operation === "training" ? "【訓練】" : "【試験】";
  const lead = candidate.operation === "normal" ? "" : candidate.operation === "training"
    ? "訓練の電文です。通常運用の警報ではありません。\n" : "試験の電文です。通常運用の警報ではありません。\n";
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const intentsOf = (payload: EewNotificationPayload, transition: EewIntent["transition"]): EewIntent[] => channels.map((channel) => ({
    id: noticeId("U-E", candidate.subject, "", candidate.source, transition, channel),
    unit: "U-E", subject: candidate.subject, operation: candidate.operation, source: candidate.source, transition,
    channel, payload, createdAt: input.clock.wallTimeMs, expiresAt: input.clock.wallTimeMs + 15_000,
    nextAttemptAt: input.clock.wallTimeMs, attempts: 0, configRevision: "p2-eew-unit-v1", disposition: "pending" as const,
    ...freshState("U-E", candidate.operation),
  }));
  // P3-NL-AC10: 取消の種類は取消の報の Head/Title（128 文字で切る）。時刻と震源名は取り消した記録（gate、無ければ印の family の記録の
  // 時刻だけ）から。どちらも無い取消は種類だけ（AC10 の (3)）。
  const titleNode = first(first(input.material.xml, "Head")!, "Title");
  const cancelWords = cancelText((titleNode == null ? "" : scalar(titleNode) ?? "").slice(0, 128).replace(/[\ud800-\udbff]$/, "").trim() || "緊急地震速報",
    gate?.source.reportDateTimeRaw ?? recorded?.reportDateTimeRaw ?? null, gate?.noticeSource.hypocenter ?? null);
  const cancelPayload: EewNotificationPayload = { domain: "earthquake-eew", level: "cancel", title: prefix + cancelWords.title,
    body: lead + cancelWords.body };
  // P3-NL-AC04 (5) の (a)(b): 採らない取消でも取消の intent だけは作る（H48 の「鳴らないか二重かなら二重」、2026-10-22 作者裁定）。
  // 通知するかは印の latch の証拠（H19）、印が無ければ通知する。決定と診断は P2 の実装どおり（stale か capacityExceeded）。
  const cancelOnly = (refused: Omit<EewUnitStep, "displayChanges" | "confirmationEvidence">): Omit<EewUnitStep, "displayChanges" | "confirmationEvidence"> => {
    if (!candidate.cancelled || mark != null && mark.deliveryEvidence === "unattempted"
      || noticed(mark, candidate.family, candidate.source, "cancel")) return refused;
    const placed = admitIntents(state, candidate, eventId, intentsOf(cancelPayload, "cancelled"), new Set(), true, input.clock.wallTimeMs);
    if (!placed.admitted) return refused;
    // 印の期限は intent を採った時の wall＋24 時間を下げない（ヘルツ r4 の P1。起点＋24 時間はもう過去でありうる）。family の記録は取消の報。
    const nextMark: EewNoticeMark = { eventId, operation: candidate.operation, firstReportNotified: mark?.firstReportNotified ?? false,
      warningNotified: mark?.warningNotified ?? false, vxse45Accepted: mark?.vxse45Accepted ?? false,
      deliveryEvidence: mark?.deliveryEvidence ?? "unknown", notifiedMaximumRank: mark?.notifiedMaximumRank ?? -1,
      notifiedWarningAreas: mark?.notifiedWarningAreas ?? "0", retainUntil: Math.max(mark?.retainUntil ?? -Infinity, Math.ceil(input.clock.wallTimeMs) + GATE_MS),
      families: nextFamilies(mark?.families ?? [], candidate.source, candidate.family, true, "cancel") };
    const notices = placeNotice(state.notices, nextMark, markAt, state.gates, state.current, placed.intents);
    const next: EewUnitState = { ...state, intents: placed.intents, notices: notices.notices,
      persistence: dirty(state.persistence, input.clock.monotonicMs) };
    return { ...refused, state: next, nextDeadline: nextEewDeadline(next), intents: placed.fresh,
      diagnostics: [...refused.diagnostics, ...placed.diagnostics, ...notices.evicted === 0 ? [] : [{ level: "INFO" as const, component: "eew",
        reason: "noticeMarkEvicted" as const, unit: "U-E" as const, count: notices.evicted }]] };
  };
  // P3-LIFE-D-LATE=A・D-SKEW=A: horizon は duplicate・版の older（P3-VM-AC03）の後、容量の前。既知 subject の取消だけは horizon 外でも採用する。
  // 既知は gate があるか、gate は無いがその EventID・family の印の記録があること（P3-NL-AC04 (5)）。
  // P3-EVICT-AC01(7): 退去した normal の gate の報時刻以下の新規 subject は時計によらず horizon 外と同じに捨てる（時計の後退での採り直し、B12）。
  const reportMs = Date.parse(candidate.source.reportDateTimeRaw);
  const base = Math.min(reportMs, input.clock.wallTimeMs);
  if ((base + HORIZON_MS <= input.clock.wallTimeMs || gate == null && candidate.operation === "normal"
    && reportMs <= (state.evictedNormalReportMs?.[candidate.family] ?? -Infinity)) && !(candidate.cancelled && (gate != null || recorded != null))) return cancelOnly({
    state, nextDeadline: nextEewDeadline(state), decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "unchanged", reason: "stale" }], intents: [], outcomes: [],
    // 無いと host の時計の進みで全 EEW が黙って捨てられる。既知 subject の遅れた版は時刻の逆転した異常データなので出さない。
    diagnostics: gate == null ? [diagnostic(input.material, "eewHorizonStale")] : [],
  });

  // Gate source wins; current-only subjects still consume the same family budget.
  const subjects = new Map<string, EewCurrent | EewGate>();
  for (const item of [...state.current, ...state.gates])
    if (item.family === candidate.family && item.subject !== candidate.subject) subjects.set(item.subject, item);
  const needed = Math.max(0, subjects.size + 1 - 512);
  const eligible = [...subjects.values()].filter((item) => item.operation !== "normal");
  // P2-A4-RES-02 の順（報時刻の昇順、同時刻は operation/subject/inputId の文字列 tuple）。
  const res02 = (left: EewCurrent | EewGate, right: EewCurrent | EewGate) => {
    const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
    if (time !== 0) return time;
    const a = [left.operation, left.subject, left.source.inputId];
    const b = [right.operation, right.subject, right.source.inputId];
    for (let index = 0; index < a.length; index++)
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    return 0;
  };
  // P3-EVICT-AC01(2)(3): normal の受理で、報時刻＋10 分を過ぎ current も intent も無い normal の gate のうち RES-02 の順の先頭を探す。
  // 報時刻は起点 base でなく生値で数える（未来時刻の報の再送を復活させない、B10）。採るか拒むかは下の件数の比較が決め、
  // ここの「1 件だけ足りない」は、使われない走査を省くだけ（2 件以上が要るのは上限を超えて注入した state で、normal は 1 件しか足さない）。
  // sort せず gates の線形 1 回（P3-EVICT-RES-02）。
  let aged: EewGate | null = null;
  if (candidate.operation === "normal" && needed - eligible.length === 1) {
    const owned = new Set(state.intents.map((intent) => intent.subject));
    let agedTime = Infinity;
    for (const item of state.gates) {
      if (item.family !== candidate.family || item.operation !== "normal" || item.subject === candidate.subject
        || item.currentUntil != null || owned.has(item.subject)) continue;
      const time = Date.parse(item.source.reportDateTimeRaw);
      if (time + HORIZON_MS <= input.clock.wallTimeMs
        && (aged == null || time < agedTime || time === agedTime && res02(item, aged) < 0)) {
        aged = item;
        agedTime = time;
      }
    }
  }
  if (eligible.length + (aged == null ? 0 : 1) < needed) return cancelOnly({
    state, nextDeadline: nextEewDeadline(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "capacityExceeded" }],
    // P3-CC-AC07: 失敗そのものを入力ごとに 1 行残す（U-E は容量の印を持たない、Q-CC-UE）。
    intents: [], outcomes: [], diagnostics: [{ level: "WARN", component: "eew", reason: "capacityRejected", unit: "U-E",
      inputId: candidate.source.inputId }],
  });
  const evicted = new Set(needed === 0 ? []
    : [...eligible.sort(res02).slice(0, needed), ...(aged == null ? [] : [aged])].map((item) => item.subject));
  let currents = state.current.filter((item) => {
    if (evicted.has(item.subject)) changed(item, null);
    return item.subject !== candidate.subject && !evicted.has(item.subject);
  });
  if (previous !== projected) changed(previous ?? null, projected);
  let gates = state.gates.filter((item) => item.subject !== candidate.subject && !evicted.has(item.subject));
  if (projected != null) currents = [...currents, projected];
  const nextGate: EewGate = {
    subject: candidate.subject, operation: candidate.operation, family: candidate.family,
    serial: candidate.serial, terminal: candidate.terminal, source: candidate.source, noticeSource,
    currentUntil: projected == null ? null : base + CURRENT_MS, retainUntil: base + GATE_MS, predictionKey,
    ...version.mark == null ? {} : { unconfirmed: version.mark },
  };
  gates = [...gates, nextGate];

  // P3-NL-AC04 (6): latch は EventID の印として保存し、gate の退去・期限に縛られない。印が無いのは初めての EventID か、gate・current・pending の
  // 無い印を捨てた後なので、証拠は取消か復元の後の 10 分なら unknown、ほかは unattempted。
  const evidenceUnknownUntil = state.evidenceUnknownUntil ?? 0;
  const deliveryEvidence = mark?.deliveryEvidence
    ?? (candidate.cancelled || input.clock.wallTimeMs < evidenceUnknownUntil ? "unknown" : "unattempted");
  const correction = candidate.source.infoTypeRaw === "訂正";
  const notify = candidate.cancelled ? deliveryEvidence !== "unattempted"
    : correction || candidate.terminal
    || (!mark?.vxse45Accepted || candidate.family !== "VXSE43")
      && (!mark?.firstReportNotified || warning && !mark.warningNotified);
  const eligibleNotice = candidate.family !== "VXSE43" || !mark?.vxse45Accepted;
  let opportunity = notify && eligibleNotice;
  const baseTitle = warning ? "緊急地震速報（警報）" : "緊急地震速報（予報）";
  const title = candidate.cancelled ? "[取消] 緊急地震速報" : correction ? `[訂正] ${baseTitle}` : baseTitle;
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
  const notifiedAreas = BigInt(`0x${mark?.notifiedWarningAreas ?? "0"}`);
  let newWarningAreas = 0n;
  for (const area of warningAreas) if (/^\d{3}$/.test(area)) {
    const bit = 1n << BigInt(area);
    if ((notifiedAreas & bit) === 0n) newWarningAreas |= bit;
  }
  const hazardIncrease = warning && mark?.warningNotified === true && !candidate.cancelled
    && (maximumRank > mark.notifiedMaximumRank || newWarningAreas !== 0n);
  opportunity = opportunity || hazardIncrease && eligibleNotice;
  // P3-NL-AC04 (4): その family の記録に同じ版の鍵と種類があれば作らない（再起動・取り直しの後に受け直した同じ報）。
  const kind = candidate.cancelled ? "cancel" as const : "report" as const;
  if (noticed(mark, candidate.family, candidate.source, kind)) opportunity = false;
  const parts = [assumed ? "仮定震源" : noticeSource.hypocenter, noticeSource.magnitude,
    `最大予測震度${maxIntensity}`].filter((part): part is string => part != null && part !== "");
  let bodyText = earthquake == null ? title : parts.join(" / ");
  if (correction) bodyText = `訂正: ${bodyText}`;
  // P3-NL-AC12・P3-NL-D-FINAL-OVERLAP=A: 最終報は本文の頭に「最終報: 」（続報の頭書きより前）。第 1 報・警報への切替・危険が増した続報に当たらない
  // 最終報だけ普通の音。
  const finalHead = candidate.terminal ? "最終報: " : "";
  const finalOnly = candidate.terminal && mark?.firstReportNotified === true && !(warning && !mark.warningNotified) && !hazardIncrease;
  const payload: EewNotificationPayload = candidate.cancelled ? cancelPayload : { domain: "earthquake-eew",
    level: finalOnly ? "normal" : warning ? "critical" : "warning",
    title: prefix + title, body: hazardIncrease && !correction ? `${finalHead}続報: ${lead}${bodyText}` : lead + finalHead + bodyText };
  const transition = candidate.cancelled ? "cancelled" : candidate.terminal ? "released" : previous == null ? "activated" : "updated";
  const placed = admitIntents(state, candidate, eventId, opportunity ? intentsOf(payload, transition) : [], evicted, opportunity,
    input.clock.wallTimeMs);
  const admitted = placed.admitted;
  const notified = admitted && opportunity;
  // P3-NL-AC04 (1)(2): EventID の印。latch は採用で進め、retainUntil は今回の版の起点＋24 時間を下げない（別 family の遅い報で短くしない）。
  const nextMark: EewNoticeMark = { eventId, operation: candidate.operation,
    firstReportNotified: (mark?.firstReportNotified ?? false) || notified && !candidate.cancelled,
    warningNotified: (mark?.warningNotified ?? false) || notified && !candidate.cancelled && warning,
    vxse45Accepted: (mark?.vxse45Accepted ?? false) || candidate.family === "VXSE45",
    deliveryEvidence,
    notifiedMaximumRank: notified && warning && !candidate.cancelled
      ? Math.max(mark?.notifiedMaximumRank ?? -1, maximumRank) : mark?.notifiedMaximumRank ?? -1,
    notifiedWarningAreas: (notified && warning && !candidate.cancelled ? notifiedAreas | newWarningAreas : notifiedAreas).toString(16),
    // 整数に切り上げる（下げない）。保存の上界を整数の桁で数えるため（P3-NL-AC04 (8)、時計の小数は試験の境界値だけ）。
    retainUntil: Math.max(mark?.retainUntil ?? -Infinity, Math.ceil(base) + GATE_MS),
    families: nextFamilies(mark?.families ?? [], candidate.source, candidate.family, candidate.cancelled,
      notified && placed.fresh.length !== 0 ? kind : null) };
  const notices = placeNotice(state.notices, nextMark, markAt, gates, currents, placed.intents);
  const semanticChanged = predictionChanged
    || gate?.terminal !== candidate.terminal || evicted.size !== 0
    || projected != null && previous?.warningClass !== projected.warningClass;
  const change = semanticChanged ? "semantic" : "revisionOnly";
  const next: EewUnitState = {
    ...state, current: currents, gates, evidenceUnknownUntil,
    // P3-EVICT-AC01(7): normal を退去したときだけ覚える（training/test の退去では覚えない）。
    ...(aged == null ? {} : { evictedNormalReportMs: { ...state.evictedNormalReportMs, [candidate.family]:
      Math.max(state.evictedNormalReportMs?.[candidate.family] ?? -Infinity, Date.parse(aged.source.reportDateTimeRaw)) } }),
    intents: placed.intents, notices: notices.notices,
    persistence: notices.notices !== state.notices || placed.intents.length !== state.intents.length
      || placed.intents.some((intent, index) => intent !== state.intents[index]) ? dirty(state.persistence, input.clock.monotonicMs) : state.persistence,
  };
  return {
    state: next, nextDeadline: nextEewDeadline(next),
    decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: Date.parse(candidate.source.reportDateTimeRaw), affectedScope: "subject" } }],
    intents: placed.fresh,
    outcomes: [{ kind: "accepted", change, subjects: [withReport(outcome(candidate, transition, candidate.prediction, warning), eewReportFacts(body, headline, earthquake, forecast, candidate.cancelled, assumed))] }],
    diagnostics: [...missing, ...placed.diagnostics,
      ...(evicted.size === 0 ? [] : [{ level: "INFO" as const, component: "eew", reason: "eewCapacityEvicted" as const,
        unit: "U-E" as const, count: evicted.size }]),
      ...(notices.evicted === 0 ? [] : [{ level: "INFO" as const, component: "eew", reason: "noticeMarkEvicted" as const,
        unit: "U-E" as const, count: notices.evicted }]),
    ],
  };
}

// 新しい intent の収容（P2-A7-TIME.complexity）: 期限の来た pending を外し、同じ EventID の置換と退去した subject の intent を外し、上限を越えれば
// 下位の運用区分の pending を外す。置換・退去した intent は intents から外す（結果は印に残る、P3-NL-AC05 (1)）。admitted は全部の新しい intent が入ったか。
function admitIntents(state: EewUnitState, candidate: Candidate, eventId: string, fresh: readonly EewIntent[], evicted: ReadonlySet<string>,
  replacing: boolean, wallTimeMs: number): Readonly<{ intents: readonly EewIntent[]; fresh: readonly EewIntent[]; admitted: boolean;
    diagnostics: readonly DiagnosticDetails[] }> {
  const expired = state.intents.filter((intent) => intent.expiresAt <= wallTimeMs);
  const active = state.intents.filter((intent) => intent.expiresAt > wallTimeMs);
  const sameEvent = (intent: NotificationIntent) => intent.operation === candidate.operation
    && intent.subject.split("/")[2] === eventId;
  const replace = (intent: NotificationIntent) => evicted.has(intent.subject)
    || (candidate.cancelled || replacing) && sameEvent(intent)
      && (candidate.cancelled || fresh.some((item) => item.channel === intent.channel));
  const retained = active.filter((intent) => !replace(intent));
  let proposed = [...retained, ...fresh];
  const evictedIntents: EewIntent[] = [];
  // 配送の更新の予約は notificationArrayBytes（U-E の世代の計量と cache を共有）の外で足す（P3-INTENT-UPDATE-RESERVE-001）。
  let proposedBytes = notificationArrayBytes(proposed) + proposed.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  let proposedCount = proposed.length;
  const fits = () => proposedCount <= 128 && proposedBytes <= 131_072;
  if (!fits() && candidate.operation === "normal") {
    const lower = retained.filter((intent) => intent.operation !== "normal").sort((left, right) =>
      right.expiresAt - left.expiresAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    for (const intent of lower) {
      proposedBytes -= notificationArrayBytes([intent]) - 2 + (proposedCount > 1 ? 1 : 0) + deliveryGrowth(intent);
      proposedCount -= 1;
      evictedIntents.push(intent);
      if (fits()) break;
    }
    // Decide the whole eviction set first, then remove it in one pass (P2-A7-TIME.complexity).
    const dropped = new Set(evictedIntents);
    if (dropped.size !== 0) proposed = proposed.filter((item) => !dropped.has(item));
  }
  const admitted = fits();
  if (!admitted) {
    proposed = candidate.cancelled ? active.filter((intent) => !sameEvent(intent) && !evicted.has(intent.subject))
      : active.filter((intent) => !evicted.has(intent.subject));
    evictedIntents.length = 0;
  }
  const diagnostics: DiagnosticDetails[] = [];
  if (expired.length !== 0) diagnostics.push({ level: "INFO", component: "eew", reason: "notificationExpired", unit: "U-E", count: expired.length });
  if (evictedIntents.length !== 0) diagnostics.push({ level: "INFO", component: "eew", reason: "notificationCapacityEvicted", unit: "U-E",
    count: evictedIntents.length });
  return { intents: proposed, fresh: admitted ? fresh : [], admitted, diagnostics };
}

// P3-EWF-AC01〜AC04: 端末と EEW ログが要る 1 報分の材料を、採った報の受信の outcome にだけ載せる。無いと C19 が
// 今の facts から作れない値（震源・座標・精度・区域名など）を持てない。XML の生の文字のまま、採った報ごとに線形 1 回で読む。
function eewReportFacts(body: XmlElement, headline: XmlElement | null, earthquake: XmlElement | null,
  forecast: XmlElement | null, cancelled: boolean, assumed: boolean): EewReportFacts {
  const text = (parent: XmlElement | null, name: string): string | null => {
    const node = parent == null ? null : first(parent, name);
    return node == null ? null : scalar(node);
  };
  const lgInt = (parent: XmlElement | null): EewReportFacts["maxLgInt"] => {
    const node = parent == null ? null : first(parent, "ForecastLgInt");
    return node == null ? null : { from: text(node, "From"), to: text(node, "To") };
  };
  const rawOf = (node: XmlElement | null): EewReportFacts["magnitude"] => {
    const raw = node == null ? null : scalar(node);
    return node == null || raw == null ? null : { raw, description: attribute(node, "description"), condition: attribute(node, "condition") };
  };
  const hypocenter = earthquake == null ? null : first(earthquake, "Hypocenter");
  const area = hypocenter == null ? null : first(hypocenter, "Area");
  // 座標の選び方は isAssumedHypocenter と同じ規則（type が「震源位置（度分）」でないものを先に採る）。
  const coordinates = (area == null ? [] : elements(area)).filter((node) => node.name.endsWith("Coordinate"));
  const accuracy = hypocenter == null ? null : first(hypocenter, "Accuracy");
  const rank = (name: string): string | null => {
    const node = accuracy == null ? null : first(accuracy, name);
    return attribute(node, "rank");
  };
  const fc = cancelled || forecast == null ? null : forecast;
  const appendix = fc == null ? null : first(fc, "Appendix");
  return {
    headline: text(headline, "Text"),
    hypocenter: text(area, "Name"),
    landOrSea: text(area, "LandOrSea"),
    originTimeRaw: text(earthquake, "OriginTime"),
    arrivalTimeRaw: text(earthquake, "ArrivalTime"),
    coordinate: rawOf(coordinates.find((node) => attribute(node, "type") !== "震源位置（度分）") ?? coordinates[0] ?? null),
    magnitude: rawOf(earthquake == null ? null : elements(earthquake).find((node) =>
      node.name === "Magnitude" || node.name.endsWith(":Magnitude")) ?? null),
    accuracy: accuracy == null ? null : {
      epicenterRank: rank("Epicenter"), depthRank: rank("Depth"), magnitudeRank: rank("MagnitudeCalculation"),
      magnitudeCalculationCount: text(accuracy, "NumberOfMagnitudeCalculation"),
    },
    isAssumedHypocenter: assumed,
    maxIntChangeReasonRaw: text(appendix, "MaxIntChangeReason"),
    maxLgInt: lgInt(fc),
    areas: fc == null ? [] : elements(fc, "Pref").flatMap((pref) => elements(pref, "Area")).map((item) => ({
      code: text(item, "Code")?.trim() ?? "", name: text(item, "Name"), lgInt: lgInt(item), arrivalTimeRaw: text(item, "ArrivalTime"),
    })),
    nextAdvisory: text(body, "NextAdvisory"),
    cancelText: cancelled ? text(body, "Text") : null,
  };
}

function withReport(subject: SubjectOutcome, report: EewReportFacts): SubjectOutcome {
  return { ...subject, facts: { ...subject.facts, report } };
}

export { reduceEew, nextEewDeadline, reclaimEewLifetime, expiredOutcome, dirty, notificationArrayBytes, noticeAt };
