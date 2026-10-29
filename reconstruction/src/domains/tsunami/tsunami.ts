import { isDeepStrictEqual } from "node:util";

import type { DecodedMaterial, MaterialValue, Operation, XmlElement } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef, UnreadableMark } from "../../../contracts/p2-shared-runtime.types";
import type {
  TsunamiAreaClass, TsunamiEstimation, TsunamiForecastArea, TsunamiHeight, TsunamiObservationFamily, TsunamiStation,
  TsunamiUnkeyedArea, TsunamiUnreadableSite,
} from "../../../contracts/p3-tsunami-unit.types";
import { attribute, blank, children, leafValues, localName, scalar } from "../../decode-material/xml-read";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime"; import { controlDateTimeOf } from "../../contracts-revision/version";
import { unreadableNotes } from "../../units/unreadable";

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
// unreadable は読めなかった所の印（P3-UM-AC01）。
type Common = Readonly<{ operation: Operation; eventId: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; headline: string | null; title: string | null; unreadable: UnreadableMark | null }>;
type ForecastCandidate = Common & Readonly<{ kind: "forecast"; family: "VTSE41";
  areas: readonly TsunamiForecastArea[]; unkeyedAreas: readonly TsunamiUnkeyedArea[] }>;
type ObservationCandidate = Common & Readonly<{ kind: "observation"; family: TsunamiObservationFamily;
  stations: readonly TsunamiStation[]; estimations: readonly TsunamiEstimation[] }>;
type TsunamiCandidate = ForecastCandidate | ObservationCandidate;
// diagnostics は受けた報の読めなかった所（P3-EF-AC13、H51 の B）。
type ParseResult = Readonly<{ kind: "accepted"; candidate: TsunamiCandidate; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{ kind: "noObservation"; subject: string; operation: Operation; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

// 0 個は null、1 個の葉はその文字列。2 個以上か葉でなければ invalid（呼出し側で拒否）。
function optionalText(parent: XmlElement | null, name: string): string | null | "invalid" {
  const found = children(parent, name);
  if (found.length === 0) return null;
  const text = found.length === 1 ? scalar(found[0]) : null;
  return text ?? "invalid";
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
// H51 の B（P3-EF-AC13）: 読めない所は報を断らず null にし、所ごとに WARN を 1 件残す。node は読めなかった要素か親、scope は予報区・観測点・
// 推定区域の code（P3-UM-AC01 (2)(4)）。
type Warn = (site: TsunamiUnreadableSite, reason: "requiredStructureMissing" | "requiredStructureInvalid", node: XmlElement | null, scope?: string) => void;
function soft(parent: XmlElement | null, name: string, warn: Warn, site: TsunamiUnreadableSite, scope?: string): string | null {
  const value = optionalText(parent, name);
  if (value !== "invalid") return value;
  const found = children(parent, name);
  warn(site, "requiredStructureInvalid", found.length === 1 ? found[0] : parent, scope);
  return null;
}
function one(parent: XmlElement | null, name: string, warn: Warn, site: TsunamiUnreadableSite, scope?: string): XmlElement | null {
  const found = children(parent, name);
  if (found.length > 1) warn(site, "requiredStructureInvalid", parent, scope);
  return found.length === 1 ? found[0] : null;
}

function height(node: XmlElement | null, values: ReadonlyMap<XmlElement, MaterialValue>, warn: Warn, site: TsunamiUnreadableSite,
  scope?: string): TsunamiHeight | null {
  if (node == null) return null;
  const value = values.get(node);
  // 値は数値・NaN（unknown）・範囲表記だけを合法とする（Q-ENUM.invalid）。
  if (value == null || value.kind !== "number" && value.kind !== "unknown" && value.kind !== "range") {
    warn(site, "requiredStructureInvalid", node, scope);
    return null;
  }
  return { value, condition: attribute(node, "condition"), description: attribute(node, "description") };
}

function forecastArea(item: XmlElement, values: ReadonlyMap<XmlElement, MaterialValue>, warn: Warn):
  Readonly<{ code: string | null; area: Omit<TsunamiForecastArea, "code"> }> {
  const area = single(item, "Area");
  const name = text(area, "Name");
  // 予報区の Kind と鍵は区域ごとの警報級の値で拒否のまま（H51 の C、設計メモ §13 の統合担当の読み）。unknown にして受けると、
  // 大津波警報 → 読めない報 → 大津波警報の列で次の正しい報を「引上げ」と読んで鳴らす。
  const kind = single(single(item, "Category"), "Kind");
  const kindCode = text(kind, "Code");
  const kindName = text(kind, "Name");
  if (name == null || kindCode == null || kindName == null) return missing();
  const code = text(area, "Code");
  if (code != null && !/^\d{3}$/.test(code)) return invalid();
  const scope = code ?? undefined;
  const first = one(item, "FirstHeight", warn, "forecastHeight", scope);
  const max = one(item, "MaxHeight", warn, "forecastHeight", scope);
  const node = one(max, "TsunamiHeight", warn, "forecastHeight", scope);
  const condition = soft(max, "Condition", warn, "forecastHeight", scope);
  const measured = height(node, values, warn, "forecastHeight", scope);
  const maxHeight: TsunamiHeight | null = measured != null ? { ...measured, condition: attribute(node!, "condition") ?? condition }
    : condition == null ? null : { value: { kind: "missing" }, condition, description: null };
  return { code, area: { name, areaClass: KIND_CLASS.get(kindCode) ?? "unknown", kindCode, kindName,
    firstHeight: { arrivalTimeRaw: soft(first, "ArrivalTime", warn, "forecastHeight", scope), condition: soft(first, "Condition", warn, "forecastHeight", scope) },
    maxHeight } };
}

function forecastBody(body: XmlElement, values: ReadonlyMap<XmlElement, MaterialValue>, warn: Warn) {
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
    const { code, area } = forecastArea(item, values, warn);
    if (code == null) { unkeyedAreas.push({ name: area.name, kindCode: area.kindCode, kindName: area.kindName }); continue; }
    if (codes.has(code)) return invalid();
    codes.add(code);
    areas.push({ code, ...area });
  }
  return { areas, unkeyedAreas };
}

function station(item: XmlElement, node: XmlElement, revision: Revision,
  values: ReadonlyMap<XmlElement, MaterialValue>, warn: Warn): TsunamiStation {
  const code = text(node, "Code");
  const name = text(node, "Name");
  if (code == null || name == null) return missing();
  if (code === "") return invalid();
  const site = "station";
  const area = one(item, "Area", warn, site, code);
  const first = one(node, "FirstHeight", warn, site, code);
  const max = one(node, "MaxHeight", warn, site, code);
  return {
    code, name, areaCode: blank(soft(area, "Code", warn, site, code)), areaName: blank(soft(area, "Name", warn, site, code)),
    sensor: soft(node, "Sensor", warn, site, code),
    firstHeight: { arrivalTimeRaw: soft(first, "ArrivalTime", warn, site, code), initial: soft(first, "Initial", warn, site, code),
      condition: soft(first, "Condition", warn, site, code) },
    maxHeight: { dateTimeRaw: soft(max, "DateTime", warn, site, code), condition: soft(max, "Condition", warn, site, code),
      height: height(one(max, "TsunamiHeight", warn, site, code), values, warn, site, code) },
    revision,
  };
}

function observationBody(body: XmlElement, family: TsunamiObservationFamily, revision: Revision,
  values: ReadonlyMap<XmlElement, MaterialValue>, warn: Warn) {
  const tsunami = single(body, "Tsunami");
  const items = children(single(tsunami, "Observation"), "Item");
  if (items.length === 0) return missing();
  for (const node of items.flatMap((item) => children(item, "Station")))
    if (children(node, "Code").length === 0 || children(node, "Name").length === 0) return missing();
  const stations: TsunamiStation[] = [];
  const codes = new Set<string>();
  for (const item of items) for (const node of children(item, "Station")) {
    const value = station(item, node, revision, values, warn);
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
    const site = "estimation";
    const first = one(item, "FirstHeight", warn, site, code);
    const max = one(item, "MaxHeight", warn, site, code);
    estimations.push({ areaCode: code, areaName: soft(area[0], "Name", warn, site, code) ?? "",
      firstHeight: { arrivalTimeRaw: soft(first, "ArrivalTime", warn, site, code), condition: soft(first, "Condition", warn, site, code) },
      maxHeight: { condition: soft(max, "Condition", warn, site, code),
        height: height(one(max, "TsunamiHeight", warn, site, code), values, warn, site, code) } });
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
  // P3-UM-AC01 (2): 同じ所を印の part にもする（WARN は所ごとに 1 件のまま、part は (site, scope) ごと）。
  const warnings = new Map<string, "requiredStructureMissing" | "requiredStructureInvalid">();
  const notes = unreadableNotes();
  const warn: Warn = (site, reason, node, scope) => {
    if (!warnings.has(site)) warnings.set(site, reason);
    notes.note(site, reason, node, scope);
  };
  const report = () => [...warnings.values()].map((reason) => diagnostic(material, reason));
  // P3-EF-AC13 (5): 観測の Serial の欠け・形の外は空にして受ける（新旧に Serial を使わない、K7）。
  let serialRaw = material.serialRaw;
  if (family !== "VTSE41") {
    const raw = serialRaw.trim(), serialNode = children(head, "Serial")[0] ?? head;
    if (raw === "") warn("serial", "requiredStructureMissing", serialNode);
    else if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) warn("serial", "requiredStructureInvalid", serialNode);
    if (warnings.has("serial")) serialRaw = "";
  }
  const subject = family === "VTSE41" ? `${material.operation}/VTSE41/${eventId}`
    : `${material.operation}/tsunamiObservation:${family}/${eventId}`;
  const infoRank = INFO_RANK.get(material.infoTypeRaw.trim());
  if (infoRank == null) return reject("requiredStructureInvalid", subject);
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation, family,
    subject, reportDateTimeRaw: material.reportDateTimeRaw, controlDateTimeRaw: controlDateTimeOf(material.controlDateTimeRaw), serialRaw, infoTypeRaw: material.infoTypeRaw };
  const cancelled = infoRank === 3;
  // P3-NL-AC10 (1): 取消の文面の種類（Head/Title、ほかの分野と同じく 128 文字で切る）。無ければ null で、unit が今の固定の題を使う。
  const titleNodes = children(head, "Title");
  const titleRaw = titleNodes.length === 1 ? blank(scalar(titleNodes[0])) : null;
  const base = { operation: material.operation, eventId, subject, source, reportDateTimeMs: common.envelope.reportDateTimeMs,
    infoRank, cancelled, title: titleRaw == null ? null : titleRaw.slice(0, 128).replace(/[\ud800-\udbff]$/, "") };
  try {
    const headlineNodes = children(children(head, "Headline")[0] ?? null, "Text");
    const headline = headlineNodes.length === 1 ? blank(scalar(headlineNodes[0])) : null;
    // 取消は Body が Text だけでよい（38-39_03_01・38-39_03_03）。
    const body = single(material.xml, "Body");
    if (cancelled) return { kind: "accepted", diagnostics: report(), candidate: family === "VTSE41"
      ? { ...base, headline, kind: "forecast", family, areas: [], unkeyedAreas: [], unreadable: notes.mark(material.xml) }
      : { ...base, headline, kind: "observation", family, stations: [], estimations: [], unreadable: notes.mark(material.xml) } };
    // Q-ENUM の VTSE51.legalMissing: Observation の無い報（満潮時刻・到達予想時刻の情報）は合法で、state を変えない。
    if (family === "VTSE51" && children(single(body, "Tsunami"), "Observation").length === 0)
      return { kind: "noObservation", subject, operation: material.operation, diagnostics: report() };
    const values = leafValues(material);
    if (family === "VTSE41") {
      const forecast = forecastBody(body, values, warn);
      return { kind: "accepted", diagnostics: report(), candidate: { ...base, headline, kind: "forecast", family, ...forecast,
        unreadable: notes.mark(material.xml) } };
    }
    const revision = { reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw: material.infoTypeRaw };
    const observed = observationBody(body, family, revision, values, warn);
    return { kind: "accepted", diagnostics: report(), candidate: { ...base, headline, kind: "observation", family, ...observed,
      unreadable: notes.mark(material.xml) } };
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
