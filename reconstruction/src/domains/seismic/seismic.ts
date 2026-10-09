import type { DecodedMaterial, MaterialValue, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type {
  EarthquakeContribution, EarthquakeFamily, SeismicHypocenter, SeismicIntensityItem, SeismicIntensityObservation,
  SeismicIntensityValue, SeismicTsunamiComment,
} from "../../../contracts/p3-seismic-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-UNIT-Q-001 の adapter: VXSE51/52/53/61/62 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);
const EARTHQUAKE_FAMILIES: readonly EarthquakeFamily[] = ["VXSE51", "VXSE52", "VXSE53", "VXSE61"];

// ---- I-U-Q.intensityScale（震度の段階と safety rank の唯一の表） ----

// 既知の段階 10 段。rank は旧築 INTENSITY_RANK と同じ。
const STAGE_RANK: ReadonlyMap<string, number> = new Map([
  ["0", 0], ["1", 1], ["2", 2], ["3", 3], ["4", 4], ["5-", 5], ["5弱", 5], ["5+", 6], ["5強", 6],
  ["6-", 7], ["6弱", 7], ["6+", 8], ["6強", 8], ["7", 9],
]);
const STAGE_LABEL = ["0", "1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"] as const;

// 既知の段階の rank。range・fromTo・欠落・空・unknown・表に無い値は null（当日履歴の件数と強震保持に使う）。
function knownStage(value: SeismicIntensityValue): number | null {
  if (value.kind === "number") return STAGE_RANK.get(String(value.value)) ?? null;
  if (value.kind === "text") return STAGE_RANK.get(value.value.normalize("NFKC").trim()) ?? null;
  return null;
}
// range の境界の段階: 5 と 6 は lower なら弱、upper なら強。0〜4 と 7 はそのまま。
function boundRank(value: number, bound: "lower" | "upper"): number | null {
  if (value === 5) return bound === "lower" ? 5 : 6;
  if (value === 6) return bound === "lower" ? 7 : 8;
  if (value === 7) return 9;
  return Number.isInteger(value) && value >= 0 && value <= 4 ? value : null;
}
// 通知の段階に使う safety rank（fromTo は To を先に使う。旧築 level-helpers の「upper ?? lower」と同じ向き）。
function safetyRank(value: SeismicIntensityValue): number | null {
  if (value.kind === "fromTo") return safetyRank(value.to) ?? safetyRank(value.from);
  if (value.kind === "range") return boundRank(value.value, value.bound);
  return knownStage(value);
}
// 長周期地震動階級の別の表（0〜4）。震度の rank と比べない（I-U-Q.longPeriodSemantics）。
function lgRank(value: SeismicIntensityValue): number | null {
  if (value.kind === "fromTo") return lgRank(value.to) ?? lgRank(value.from);
  const number = value.kind === "number" || value.kind === "range" ? value.value
    : value.kind === "text" ? Number(value.value.normalize("NFKC").trim()) : NaN;
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : null;
}

// ---- Q-ENUM.identity ----

// 印字可能な ASCII（0x21〜0x7E）で「/」「"」「\」を含まず 40 byte 以下（subject の区切りと、JSON に書いた後の byte が文字数と
// 同じになるので取消記憶の byte 上限を件数から決められる。実際の EventID は 14 桁、corpus の最長は synthetic の 34 文字、Q-C7-IMPL-AMEND）。
function validEventId(value: string): boolean {
  return value.length <= 40 && /^[\x21\x23-\x2e\x30-\x5b\x5d-\x7e]+$/.test(value);
}
// 予約の式（I-U-Q.capacityReserve）が仮定する ReportDateTime の長さ（Serial は trim して保存し、validSerial が 10 桁以内を保証する）。
const REPORT_TIME_LIMIT = 25;
function validSerial(value: string): boolean {
  return value === "" || /^[1-9]\d{0,9}$/.test(value);
}

// ---- XML の読み取り（domains/tsunami と同じ写し。共有化は統合担当が決める、AC13） ----

type Values = ReadonlyMap<XmlElement, MaterialValue>;
const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function first(parent: XmlElement | null, name: string): XmlElement | null {
  return children(parent, name)[0] ?? null;
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
function text(parent: XmlElement | null, name: string): string | null {
  const node = first(parent, name);
  return node == null ? null : scalar(node);
}
function attribute(node: XmlElement, name: string): string | null {
  return node.attributes.find((item) => item.name === name)?.value ?? null;
}
const blank = (value: string | null): string | null => value == null || value === "" ? null : value;

// classifyMaterial と同じ順の葉に MaterialValue を対応させる（値は P1 のまま書き換えない、P3-C7-VALUE-UNKNOWN=A）。
function leafValues(material: DecodedMaterial): Values {
  const leaves: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    const nested = children(node);
    if (nested.length === 0) leaves.push(node);
    else nested.forEach(visit);
  };
  visit(material.xml);
  const values = classifyMaterial(material).materialValues;
  return new Map(leaves.map((leaf, index) => [leaf, values[index]]));
}

class Rejected extends Error {
  constructor(readonly reason: RejectionReason) { super(reason); }
}
const missing = (): never => { throw new Rejected("requiredStructureMissing"); };
const invalid = (): never => { throw new Rejected("requiredStructureInvalid"); };

// 欠落は missing、From/To を持つ値は fromTo、子要素を持つその他の値は射影できないので unknown（P3-C7-VALUE-UNKNOWN=A）。
function valueOf(node: XmlElement | null, values: Values): SeismicIntensityValue {
  if (node == null) return { kind: "missing" };
  const leaf = values.get(node);
  if (leaf != null) return leaf;
  const from = first(node, "From"), to = first(node, "To");
  if (from == null && to == null) return { kind: "unknown", raw: "" };
  const part = (value: XmlElement | null): MaterialValue => value == null ? { kind: "missing" } : values.get(value) ?? { kind: "unknown", raw: "" };
  return { kind: "fromTo", from: part(from), to: part(to) };
}
function materialOf(node: XmlElement | null, values: Values): MaterialValue {
  return node == null ? { kind: "missing" } : values.get(node) ?? { kind: "unknown", raw: "" };
}

// ---- 必須構造（Q-ENUM.familyTable） ----

const LEVELS = [["Pref", "pref"], ["Area", "area"], ["City", "city"], ["IntensityStation", "station"]] as const;
type Level = SeismicIntensityItem["level"];

// Pref → Area → City → IntensityStation（VXSE62 は Area の直下に IntensityStation）を親子の順に辿る。
function walk(observation: XmlElement, visit: (node: XmlElement, level: Level, parent: string | null) => string | null): void {
  const step = (parent: XmlElement, depth: number, parentCode: string | null): void => {
    for (let index = depth; index < LEVELS.length; index++) {
      for (const node of children(parent, LEVELS[index][0])) step(node, index + 1, visit(node, LEVELS[index][1], parentCode));
      // City を飛ばす IntensityStation は Area の直下だけ（それ以外の飛び越しは読まない）。
      if (!(depth === 2 && index === 2)) break;
    }
  };
  step(observation, 0, null);
}

function observationPresent(observation: XmlElement): void {
  walk(observation, (node) => { if (children(node, "Name").length === 0) missing(); return null; });
}

const UNREPORTED_CITY = "震度5弱以上未入電";
function observationOf(observation: XmlElement, values: Values): SeismicIntensityObservation {
  const items: SeismicIntensityItem[] = [];
  const codes: Record<Level, Set<string>> = { pref: new Set(), area: new Set(), city: new Set(), station: new Set() };
  walk(observation, (node, level, parentCode) => {
    const code = blank(text(node, "Code"));
    // Q-ENUM.invalid: 同じ階層の区域・観測点の code の重複。code の無い要素は鍵にしない。
    if (code != null) {
      if (codes[level].has(code)) invalid();
      codes[level].add(code);
    }
    const station = level === "station";
    let maxInt = valueOf(first(node, station ? "Int" : "MaxInt"), values);
    // Q-ENUM の VXSE53.legalMissing: MaxInt の無い City の Condition「震度５弱以上未入電」は range lower 5 に畳む。
    const condition = level === "city" && maxInt.kind === "missing" ? text(node, "Condition") : null;
    if (condition != null && condition.normalize("NFKC") === UNREPORTED_CITY)
      maxInt = { kind: "range", bound: "lower", value: 5, raw: condition };
    items.push({ level, code, name: text(node, "Name") ?? "", parentCode, maxInt,
      maxLgInt: valueOf(first(node, station ? "LgInt" : "MaxLgInt"), values) });
    return code;
  });
  return { maxInt: valueOf(first(observation, "MaxInt"), values), maxLgInt: valueOf(first(observation, "MaxLgInt"), values),
    lgCategory: blank(text(observation, "LgCategory")), items };
}

function earthquakePresent(earthquake: XmlElement): void {
  if (first(earthquake, "OriginTime") == null || first(first(first(earthquake, "Hypocenter"), "Area"), "Name") == null
    || first(earthquake, "Magnitude") == null) missing();
}

const COORDINATE = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/$/;
// 座標・深さは射影できなければ unknown（P3-C7-VALUE-UNKNOWN=A）。深さの欠落は missing で 0 にしない。
function hypocenterOf(earthquake: XmlElement, values: Values): SeismicHypocenter {
  const area = first(first(earthquake, "Hypocenter"), "Area");
  const coordinate = first(area, "Coordinate");
  const coordinateRaw = coordinate == null ? null : scalar(coordinate);
  const parsed = coordinateRaw == null ? null : COORDINATE.exec(coordinateRaw);
  const absent = (): MaterialValue => coordinate == null ? { kind: "missing" } : { kind: "unknown", raw: coordinateRaw ?? "" };
  // 桁の多い座標は Number() が Infinity になる。有限でなければ unknown（P3-C7-VALUE-UNKNOWN=A。JSON では null になり復元できない）。
  const number = (raw: string, value: number): MaterialValue => Number.isFinite(value) ? { kind: "number", value, raw } : { kind: "unknown", raw };
  let depthKm: MaterialValue = parsed == null ? absent() : parsed[3] == null ? { kind: "missing" }
    : number(parsed[3], -Number(parsed[3]) / 1000);
  let depthConflict = false;
  // description の「深さ６００ｋｍ以上」は下限 range。数値と食い違えば数値を採る（旧築と同じ）。
  const bound = /深さ\s*(\d+)\s*km\s*(以上|未満|以下)/.exec((coordinate == null ? "" : attribute(coordinate, "description") ?? "").normalize("NFKC"));
  if (bound != null && depthKm.kind === "number") {
    if (depthKm.value === Number(bound[1])) depthKm = { kind: "range", bound: bound[2] === "以上" ? "lower" : "upper",
      value: depthKm.value, raw: depthKm.raw };
    else depthConflict = true;
  }
  const magnitude = first(earthquake, "Magnitude");
  return {
    originTimeRaw: text(earthquake, "OriginTime"), arrivalTimeRaw: text(earthquake, "ArrivalTime"),
    name: text(area, "Name"), code: blank(text(area, "Code")), coordinateRaw,
    latitude: parsed == null ? absent() : number(parsed[1], Number(parsed[1])),
    longitude: parsed == null ? absent() : number(parsed[2], Number(parsed[2])),
    depthKm, depthConflict, magnitude: materialOf(magnitude, values),
    magnitudeType: magnitude == null ? null : attribute(magnitude, "type"),
    magnitudeCondition: magnitude == null ? null : attribute(magnitude, "condition"),
    magnitudeDescription: magnitude == null ? null : attribute(magnitude, "description"),
  };
}

// Comments/ForecastComment の固定付加文。無ければ null（「なし」にしない、spec:1466）。
function tsunamiCommentOf(body: XmlElement): SeismicTsunamiComment | null {
  const comment = first(first(body, "Comments"), "ForecastComment");
  if (comment == null) return null;
  return { codes: (text(comment, "Code") ?? "").split(/\s+/).filter((code) => code !== ""), text: blank(text(comment, "Text")) };
}

// ---- 候補 ----

type Common = Readonly<{ operation: Operation; eventId: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; title: string; headline: string | null }>;
type EarthquakeCandidate = Common & Readonly<{ kind: "earthquake"; family: EarthquakeFamily; contribution: EarthquakeContribution }>;
type LongPeriodCandidate = Common & Readonly<{ kind: "longPeriod"; family: "VXSE62";
  hypocenter: SeismicHypocenter | null; intensity: SeismicIntensityObservation | null }>;
type SeismicCandidate = EarthquakeCandidate | LongPeriodCandidate;
type ParseResult = Readonly<{ kind: "accepted"; candidate: SeismicCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "seismic", reason, inputId: material.inputId, unit: "U-Q" };
}

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。識別できない拒否の subject は空文字。
function parseSeismic(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult =>
    ({ kind: "rejected", subject, reason, diagnostic: diagnostic(material, reason) });
  // A1 の共通検証は小数秒の桁数を限らないので、予約の式の 25 文字を超える ReportDateTime はここで拒否する。
  if (material.reportDateTimeRaw.length > REPORT_TIME_LIMIT) return reject("reportDateTimeInvalid");
  const family = EARTHQUAKE_FAMILIES.find((item) => item === material.headType)
    ?? (material.headType === "VXSE62" ? "VXSE62" as const : null);
  if (family == null) return reject("requiredStructureInvalid");
  const eventId = material.eventIdRaw.trim();
  if (eventId === "") return reject("identityMissing");
  const serialRaw = material.serialRaw.trim();
  if (!validEventId(eventId) || !validSerial(serialRaw)) return reject("identityInvalid");
  const subject = `${material.operation}/${family}/${eventId}`;
  const infoTypeRaw = material.infoTypeRaw.trim();
  const infoRank = INFO_RANK.get(infoTypeRaw);
  if (infoRank == null) return reject("requiredStructureInvalid", subject);
  // 保存する生の文字列は trim した値（取消記憶の byte を件数から決めるため、I-U-Q.capacityReserve）。
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation, family,
    subject, reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw };
  const cancelled = infoRank === 3;
  const head = first(material.xml, "Head");
  const title = text(head, "Title") || text(first(material.xml, "Control"), "Title") || family;
  const base = { operation: material.operation, eventId, subject, source, reportDateTimeMs: common.envelope.reportDateTimeMs,
    infoRank, cancelled, title, headline: blank(text(first(head, "Headline"), "Text")) };
  try {
    const bodies = children(material.xml, "Body");
    if (bodies.length === 0) return missing();
    const body = bodies[0];
    // 取消は Body が Text だけでよい（32-35_10_01・32-35_06_02・32-35_06_10）。事実を持たない。
    if (cancelled) return { kind: "accepted", candidate: family === "VXSE62"
      ? { ...base, kind: "longPeriod", family, hypocenter: null, intensity: null }
      : { ...base, kind: "earthquake", family, contribution: { family, source, effective: "cancelled", targetDateTimeRaw: null,
        title: "", headline: null, hypocenter: null, intensity: null, tsunamiComment: null } } };
    const earthquake = first(body, "Earthquake");
    const intensity = first(body, "Intensity");
    const observation = first(intensity, "Observation");
    // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule: 存在 → 妥当性）。
    if (family === "VXSE51" || family === "VXSE62") { if (observation == null) missing(); }
    else if (family === "VXSE53") {
      if (earthquake == null && intensity == null) missing();
      if (intensity != null && observation == null) missing();
    } else if (earthquake == null) missing();
    if (family === "VXSE62" && first(observation, "MaxLgInt") == null) missing();
    if (earthquake != null && family !== "VXSE51") earthquakePresent(earthquake);
    if (observation != null) observationPresent(observation);
    const values = leafValues(material);
    const hypocenter = earthquake == null || family === "VXSE51" ? null : hypocenterOf(earthquake, values);
    const observed = observation == null ? null : observationOf(observation, values);
    if (family === "VXSE62") return { kind: "accepted", candidate: { ...base, kind: "longPeriod", family, hypocenter, intensity: observed } };
    return { kind: "accepted", candidate: { ...base, kind: "earthquake", family, contribution: { family, source, effective: "active",
      targetDateTimeRaw: text(head, "TargetDateTime"), title, headline: base.headline, hypocenter,
      intensity: family === "VXSE52" || family === "VXSE61" ? null : observed,
      // VXSE61 は FreeFormComment だけなので津波の有無に使わない（I-U-Q.earthquakeSemantics）。
      tsunamiComment: family === "VXSE61" ? null : tsunamiCommentOf(body) } } };
  } catch (error) {
    if (error instanceof Rejected) return reject(error.reason, subject);
    throw error;
  }
}

export { EARTHQUAKE_FAMILIES, INFO_RANK, STAGE_LABEL, knownStage, lgRank, parseSeismic, safetyRank, validEventId, validSerial };
export type { EarthquakeCandidate, LongPeriodCandidate, SeismicCandidate };
