import { isDeepStrictEqual } from "node:util";

import type { DecodedMaterial, MaterialValue, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type {
  TsunamiAreaClass, TsunamiEstimation, TsunamiForecastArea, TsunamiHeight, TsunamiObservationFamily, TsunamiStation,
  TsunamiUnkeyedArea,
} from "../../../contracts/p3-tsunami-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-TSUNAMI-UNIT-001 の adapter: VTSE41/51/52 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

// Q-ENUM.kindTable。表外は unknown（P3-C5-KIND-ENUM=B）。Map は自分の key だけを引く。
const KIND_CLASS: ReadonlyMap<string, TsunamiAreaClass> = new Map([
  ["52", "majorWarning"], ["53", "majorWarning"], ["51", "warning"], ["62", "advisory"],
  ["71", "forecast"], ["72", "forecast"], ["73", "forecast"], ["50", "released"], ["60", "released"], ["00", "none"],
]);
// P3-C5-NOTICE-LEVELS=A の区域の順位。unknown は警報と同じ 3。
const AREA_RANK: Readonly<Record<TsunamiAreaClass, number>> = {
  none: 0, released: 0, forecast: 1, advisory: 2, warning: 3, unknown: 3, majorWarning: 4,
};
// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);

type Revision = Pick<ReportRef, "reportDateTimeRaw" | "serialRaw" | "infoTypeRaw">;
type Common = Readonly<{ operation: Operation; eventId: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; headline: string | null }>;
type ForecastCandidate = Common & Readonly<{ kind: "forecast"; family: "VTSE41";
  areas: readonly TsunamiForecastArea[]; unkeyedAreas: readonly TsunamiUnkeyedArea[] }>;
type ObservationCandidate = Common & Readonly<{ kind: "observation"; family: TsunamiObservationFamily; serial: number;
  stations: readonly TsunamiStation[]; estimations: readonly TsunamiEstimation[] }>;
type TsunamiCandidate = ForecastCandidate | ObservationCandidate;
type ParseResult = Readonly<{ kind: "accepted"; candidate: TsunamiCandidate }>
  | Readonly<{ kind: "noObservation"; subject: string; operation: Operation }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
// 0 個は null、1 個の葉はその文字列。2 個以上か葉でなければ invalid（呼出し側で拒否）。
function optionalText(parent: XmlElement | null, name: string): string | null | "invalid" {
  const found = children(parent, name);
  if (found.length === 0) return null;
  const text = found.length === 1 ? scalar(found[0]) : null;
  return text ?? "invalid";
}
function attribute(node: XmlElement, name: string): string | null {
  return node.attributes.find((item) => item.name === name)?.value ?? null;
}

class Rejected extends Error {
  constructor(readonly reason: RejectionReason) { super(reason); }
}
const missing = (): never => { throw new Rejected("requiredStructureMissing"); };
const invalid = (): never => { throw new Rejected("requiredStructureInvalid"); };
function text(parent: XmlElement | null, name: string): string | null {
  const value = optionalText(parent, name);
  return value === "invalid" ? invalid() : value;
}
function single(parent: XmlElement | null, name: string): XmlElement {
  const found = children(parent, name);
  return found.length === 0 ? missing() : found.length !== 1 ? invalid() : found[0];
}
const blank = (value: string | null): string | null => value == null || value === "" ? null : value;

// classifyMaterial と同じ順の葉に MaterialValue を対応させる（TsunamiHeight の値の射影、Q-ENUM.invalid）。
function leafValues(material: DecodedMaterial): ReadonlyMap<XmlElement, MaterialValue> {
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

function height(node: XmlElement, values: ReadonlyMap<XmlElement, MaterialValue>): TsunamiHeight {
  const value = values.get(node);
  // 値は数値・NaN（unknown）・範囲表記だけを合法とする（Q-ENUM.invalid）。
  if (value == null || value.kind !== "number" && value.kind !== "unknown" && value.kind !== "range") return invalid();
  return { value, condition: attribute(node, "condition"), description: attribute(node, "description") };
}
function heightNode(parent: XmlElement): XmlElement | null {
  const found = children(parent, "TsunamiHeight");
  return found.length === 0 ? null : found.length !== 1 ? invalid() : found[0];
}

function forecastArea(item: XmlElement, values: ReadonlyMap<XmlElement, MaterialValue>):
  Readonly<{ code: string | null; area: Omit<TsunamiForecastArea, "code"> }> {
  const area = single(item, "Area");
  const name = text(area, "Name");
  const kind = single(single(item, "Category"), "Kind");
  const kindCode = text(kind, "Code");
  const kindName = text(kind, "Name");
  if (name == null || kindCode == null || kindName == null) return missing();
  const code = text(area, "Code");
  if (code != null && !/^\d{3}$/.test(code)) return invalid();
  const first = children(item, "FirstHeight");
  const maxNodes = children(item, "MaxHeight");
  if (first.length > 1 || maxNodes.length > 1) return invalid();
  const max = maxNodes[0] ?? null;
  const node = max == null ? null : heightNode(max);
  const condition = text(max, "Condition");
  const maxHeight: TsunamiHeight | null = node != null ? { ...height(node, values),
    condition: attribute(node, "condition") ?? condition }
    : condition == null ? null : { value: { kind: "missing" }, condition, description: null };
  return { code, area: { name, areaClass: KIND_CLASS.get(kindCode) ?? "unknown", kindCode, kindName,
    firstHeight: { arrivalTimeRaw: text(first[0] ?? null, "ArrivalTime"), condition: text(first[0] ?? null, "Condition") },
    maxHeight } };
}

function forecastBody(body: XmlElement, values: ReadonlyMap<XmlElement, MaterialValue>) {
  const items = children(single(single(body, "Tsunami"), "Forecast"), "Item");
  if (items.length === 0) return missing();
  // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule: 存在 → 妥当性）。
  for (const item of items) {
    const area = children(item, "Area")[0];
    const kind = children(children(item, "Category")[0] ?? null, "Kind")[0] ?? null;
    if (area == null || children(area, "Name").length === 0 || kind == null
      || children(kind, "Code").length === 0 || children(kind, "Name").length === 0) return missing();
  }
  const areas: TsunamiForecastArea[] = [];
  const unkeyedAreas: TsunamiUnkeyedArea[] = [];
  const codes = new Set<string>();
  for (const item of items) {
    const { code, area } = forecastArea(item, values);
    if (code == null) { unkeyedAreas.push({ name: area.name, kindCode: area.kindCode, kindName: area.kindName }); continue; }
    if (codes.has(code)) return invalid();
    codes.add(code);
    areas.push({ code, ...area });
  }
  return { areas, unkeyedAreas };
}

function station(item: XmlElement, node: XmlElement, revision: Revision,
  values: ReadonlyMap<XmlElement, MaterialValue>): TsunamiStation {
  const area = children(item, "Area");
  if (area.length > 1) return invalid();
  const code = text(node, "Code");
  const name = text(node, "Name");
  if (code == null || name == null) return missing();
  if (code === "") return invalid();
  const first = children(node, "FirstHeight");
  const max = children(node, "MaxHeight");
  if (first.length > 1 || max.length > 1) return invalid();
  const heightElement = max[0] == null ? null : heightNode(max[0]);
  return {
    code, name, areaCode: blank(text(area[0] ?? null, "Code")), areaName: blank(text(area[0] ?? null, "Name")),
    sensor: text(node, "Sensor"),
    firstHeight: { arrivalTimeRaw: text(first[0] ?? null, "ArrivalTime"), initial: text(first[0] ?? null, "Initial"),
      condition: text(first[0] ?? null, "Condition") },
    maxHeight: { dateTimeRaw: text(max[0] ?? null, "DateTime"), condition: text(max[0] ?? null, "Condition"),
      height: heightElement == null ? null : height(heightElement, values) },
    revision,
  };
}

function observationBody(body: XmlElement, family: TsunamiObservationFamily, revision: Revision,
  values: ReadonlyMap<XmlElement, MaterialValue>) {
  const tsunami = single(body, "Tsunami");
  const items = children(single(tsunami, "Observation"), "Item");
  if (items.length === 0) return missing();
  for (const node of items.flatMap((item) => children(item, "Station")))
    if (children(node, "Code").length === 0 || children(node, "Name").length === 0) return missing();
  const stations: TsunamiStation[] = [];
  const codes = new Set<string>();
  for (const item of items) for (const node of children(item, "Station")) {
    const value = station(item, node, revision, values);
    if (codes.has(value.code)) return invalid();
    codes.add(value.code);
    stations.push(value);
  }
  const estimations: TsunamiEstimation[] = [];
  const estimationNodes = family === "VTSE52" ? children(tsunami, "Estimation") : [];
  if (estimationNodes.length > 1) return invalid();
  const areas = new Set<string>();
  for (const item of children(estimationNodes[0] ?? null, "Item")) {
    const area = children(item, "Area");
    const code = area.length === 1 ? text(area[0], "Code") : null;
    if (code == null || code === "" || areas.has(code)) return invalid();
    areas.add(code);
    const first = children(item, "FirstHeight");
    const max = children(item, "MaxHeight");
    if (first.length > 1 || max.length > 1) return invalid();
    const heightElement = max[0] == null ? null : heightNode(max[0]);
    estimations.push({ areaCode: code, areaName: text(area[0], "Name") ?? "",
      firstHeight: { arrivalTimeRaw: text(first[0] ?? null, "ArrivalTime"), condition: text(first[0] ?? null, "Condition") },
      maxHeight: { condition: text(max[0] ?? null, "Condition"), height: heightElement == null ? null : height(heightElement, values) } });
  }
  return { stations, estimations };
}

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "tsunami", reason, inputId: material.inputId, unit: "U-T" };
}

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。識別できない拒否の subject は空文字（P3-TSUNAMI-UNIT-001 の artifactRequirements）。
function parseTsunami(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult =>
    ({ kind: "rejected", subject, reason, diagnostic: diagnostic(material, reason) });
  const family = material.headType === "VTSE41" || material.headType === "VTSE51" || material.headType === "VTSE52"
    ? material.headType : null;
  if (family == null) return reject("requiredStructureInvalid");
  const eventId = material.eventIdRaw.trim();
  if (eventId === "") return reject("identityMissing");
  const head = children(material.xml, "Head")[0] ?? null;
  const eventNodes = children(head, "EventID");
  if (!/^\d{14}$/.test(eventId) || eventNodes.length !== 1 || scalar(eventNodes[0]) !== eventId) return reject("identityInvalid");
  let serial = 0;
  if (family !== "VTSE41") {
    const raw = material.serialRaw.trim();
    if (raw === "") return reject("identityMissing");
    serial = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(serial)) return reject("identityInvalid");
  }
  const subject = family === "VTSE41" ? `${material.operation}/VTSE41/${eventId}`
    : `${material.operation}/tsunamiObservation:${family}/${eventId}`;
  const infoRank = INFO_RANK.get(material.infoTypeRaw.trim());
  if (infoRank == null) return reject("requiredStructureInvalid", subject);
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation, family,
    subject, reportDateTimeRaw: material.reportDateTimeRaw, serialRaw: material.serialRaw, infoTypeRaw: material.infoTypeRaw };
  const cancelled = infoRank === 3;
  const base = { operation: material.operation, eventId, subject, source, reportDateTimeMs: common.envelope.reportDateTimeMs,
    infoRank, cancelled };
  try {
    const headlineNodes = children(children(head, "Headline")[0] ?? null, "Text");
    const headline = headlineNodes.length === 1 ? blank(scalar(headlineNodes[0])) : null;
    // 取消は Body が Text だけでよい（38-39_03_01・38-39_03_03）。
    const body = single(material.xml, "Body");
    if (cancelled) return { kind: "accepted", candidate: family === "VTSE41"
      ? { ...base, headline, kind: "forecast", family, areas: [], unkeyedAreas: [] }
      : { ...base, headline, kind: "observation", family, serial, stations: [], estimations: [] } };
    // Q-ENUM の VTSE51.legalMissing: Observation の無い報（満潮時刻・到達予想時刻の情報）は合法で、state を変えない。
    if (family === "VTSE51" && children(single(body, "Tsunami"), "Observation").length === 0)
      return { kind: "noObservation", subject, operation: material.operation };
    const values = leafValues(material);
    if (family === "VTSE41") return { kind: "accepted", candidate: { ...base, headline, kind: "forecast", family,
      ...forecastBody(body, values) } };
    const revision = { reportDateTimeRaw: material.reportDateTimeRaw, serialRaw: material.serialRaw, infoTypeRaw: material.infoTypeRaw };
    return { kind: "accepted", candidate: { ...base, headline, kind: "observation", family, serial,
      ...observationBody(body, family, revision, values) } };
  } catch (error) {
    if (error instanceof Rejected) return reject(error.reason, subject);
    throw error;
  }
}

// 同じ station・同じ予想区域の比較では、出所の revision を除いた中身だけを見る（P3-C5-OBS-MERGE=A）。
function sameStation(left: TsunamiStation, right: TsunamiStation): boolean {
  return isDeepStrictEqual({ ...left, revision: null }, { ...right, revision: null });
}

export { AREA_RANK, INFO_RANK, KIND_CLASS, parseTsunami, sameStation };
export type { ForecastCandidate, ObservationCandidate, TsunamiCandidate };
