import type { DecodedMaterial, MaterialValue, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type {
  VolcanoAreaGroup, VolcanoAshfallGroup, VolcanoKind, VolcanoReportFamily,
} from "../../../contracts/p3-volcano-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-UNIT-V-001 の adapter: VFVO50〜56・VFVO60・VFSV50〜61・VZVO40 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);
const MARINE = ["VFSV50", "VFSV51", "VFSV52", "VFSV53", "VFSV54", "VFSV55", "VFSV56", "VFSV57", "VFSV58", "VFSV59", "VFSV60",
  "VFSV61"] as const;
const FAMILIES: readonly VolcanoReportFamily[] = ["VFVO50", "VFVO51", ...MARINE, "VFVO52", "VFVO53", "VFVO54", "VFVO55", "VFVO56",
  "VFVO60", "VZVO40"];
const isMarine = (family: string): boolean => family.startsWith("VFSV");

// I-U-V.bounds（UTF-16 の長さ）。
const BOUNDS = { volcanoName: 32, kindName: 32, condition: 8, headline: 256, areaKind: 32, phenomenon: 16, crater: 32,
  direction: 16, value: 32, ashName: 32, areaName: 32, title: 128, text: 4_096, nextAdvisory: 512, activity: 4_096,
  prevention: 1_024 } as const;
// I-U-V.bounds の件数と ASCII の上限、Q-ENUM.identity の ReportRef の長さ。
const LIMITS = { inputId: 64, reportDateTime: 40, infoType: 8, volcanoCode: 16, areaCode: 16, code: 8, coordinate: 40,
  eventDateTime: 40, municipalityGroups: 8, municipalityCodes: 128, marineGroups: 4, marineCodes: 32, eruptionAreas: 128,
  bulletinVolcanoes: 128, entries: 128 } as const;
// P3-C9-ASHFALL-PROJECTION=A（旧築 volcano-ashfall-projector.ts と同じ値）。
const ASH = { periods: 24, areasPerPeriod: 256, areas: 2_048, groups: 8, topAreas: 3, spanMs: 48 * 3_600_000,
  beforeReportMs: 6 * 3_600_000 } as const;
// 既知の降灰の区分（重い順）。表に無い code は unknown で名前が要る。
const ASH_ORDER: ReadonlyMap<string, Readonly<{ hazardClass: "ballistic" | "ash"; order: number }>> = new Map([
  ["75", { hazardClass: "ballistic", order: 0 }], ["73", { hazardClass: "ash", order: 1 }], ["72", { hazardClass: "ash", order: 2 }],
  ["71", { hazardClass: "ash", order: 3 }], ["70", { hazardClass: "ash", order: 4 }]]);

// ---- Q-ENUM.identity ----

// 印字可能な ASCII（0x21〜0x7E）で「/」「"」「\」を含まない（subject の区切りを壊さず、JSON のエスケープで byte が増えない）。
function identityText(value: string, limit: number): boolean {
  return value.length <= limit && /^[\x21\x23-\x2e\x30-\x5b\x5d-\x7e]+$/.test(value);
}
const validEventId = (value: string): boolean => identityText(value, 64);
const validVolcanoCode = (value: string): boolean => identityText(value, LIMITS.volcanoCode);
// Serial は空を合法とし、あれば 10 桁以下の数字列（先頭の 0 を許す、corpus の 001）。
const validSerial = (value: string): boolean => value === "" || /^\d{1,10}$/.test(value);
const asciiCode = (value: string, limit: number): boolean => value.length <= limit && /^[\x21-\x7e]+$/.test(value);

// ---- XML の読み取り（domains/nankai・domains/seismic と同じ写し。共有化は統合担当が決める、AC14） ----

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
function attribute(node: XmlElement | null, name: string): string | null {
  return node?.attributes.find((item) => item.name === name)?.value ?? null;
}
const blank = (value: string | null): string | null => value == null || value === "" ? null : value;
const typed = (parent: XmlElement | null, name: string, part: string): XmlElement[] =>
  children(parent, name).filter((node) => (attribute(node, "type") ?? "").includes(part));

// 切り詰めでサロゲートの対を割らない（割ると JSON で \uXXXX の 6 byte になり、I-U-V.capacityReserve の最悪の byte を超える）。
function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}

class Rejected extends Error {
  constructor(readonly reason: RejectionReason) { super(reason); }
}
const missing = (): never => { throw new Rejected("requiredStructureMissing"); };
const invalid = (): never => { throw new Rejected("requiredStructureInvalid"); };

// 子要素の無い要素の直下 text だけを読む。2 個以上か子要素があれば文字列として読めない（Q-ENUM.familyTable.invalid）。
function leaf(parent: XmlElement | null, name: string): string | null {
  const found = children(parent, name);
  if (found.length > 1 || found.length === 1 && children(found[0]).length !== 0) invalid();
  return found.length === 0 ? null : scalar(found[0]);
}

// ---- 候補 ----

type AlertFacts = Readonly<{ volcanoName: string; kind: VolcanoKind; lastKind: Readonly<{ code: string; name: string }> | null;
  headline: string | null; municipalities: readonly VolcanoAreaGroup[]; marineAreas: readonly VolcanoAreaGroup[];
  coordinate: string | null; marineCodes: readonly string[]; activity: string | null; prevention: string | null }>;
type EruptionFacts = Readonly<{ volcanoName: string; phenomenon: Readonly<{ code: string; name: string }>;
  eventDateTimeRaw: string | null; craterName: string | null; plumeAboveCrater: MaterialValue; plumeAboveSeaLevel: MaterialValue;
  plumeDirection: string | null; headline: string | null; municipalities: readonly string[] }>;
type AshfallFacts = Readonly<{ volcanoName: string; headline: string | null; forecastStartsAt: number; forecastEndsAt: number;
  groups: readonly VolcanoAshfallGroup[]; omittedGroupCount: number }>;
type BulletinFacts = Readonly<{ title: string; headline: string | null; volcanoCodes: readonly string[]; extraordinary: boolean;
  text: string | null; nextAdvisory: string | null; volcanoName: string | null }>;
// VFVO51 の火山 entry（同じ報の同じ火山は電文順の最後、P3-C9-VFVO51-ATOMIC）。
type VolcanoEntry = Readonly<{ volcanoCode: string; volcanoName: string; kind: VolcanoKind; truncated: boolean }>;

type CandidateBase = Readonly<{
  operation: Operation; family: VolcanoReportFamily; eventId: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; volcanoCode: string | null;
  // 通知の題（Head/Title から先頭の「火山名　山名　」を除いた値、旧築 volcano-parser.ts の extractVolcanoBase）。
  title: string; truncated: boolean;
}>;
type VolcanoCandidate = CandidateBase & (
  | Readonly<{ slice: "alert"; facts: AlertFacts | null }>
  | Readonly<{ slice: "eruption"; facts: EruptionFacts | null }>
  | Readonly<{ slice: "ashfall"; facts: AshfallFacts | null }>
  | Readonly<{ slice: "scheduled"; volcanoName: string | null; topAshName: string | null }>
  | Readonly<{ slice: "bulletin"; facts: BulletinFacts | null; entries: readonly VolcanoEntry[] }>
);
type ParseResult = Readonly<{ kind: "accepted"; candidate: VolcanoCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "volcano", reason, inputId: material.inputId, unit: "U-V" };
}

// Body/VolcanoInfo/Item のうち codeType「火山名」の Areas を持つもの（対象火山の Item の先頭）。
function volcanoItems(body: XmlElement | null): XmlElement[] {
  return children(body, "VolcanoInfo").flatMap((info) => children(info, "Item"))
    .filter((item) => children(item, "Areas").some((areas) => attribute(areas, "codeType") === "火山名"));
}
const volcanoAreas = (item: XmlElement): XmlElement[] => children(item, "Areas")
  .filter((areas) => attribute(areas, "codeType") === "火山名").flatMap((areas) => children(areas, "Area"));

// 火山コード（codeType「火山名」の Area/Code）は EventID と同じ文字の集合で 16 byte 以下（Q-ENUM.identity）。
function volcanoCodeOf(area: XmlElement): string {
  const code = blank(leaf(area, "Code"));
  if (code == null) return missing();
  if (!validVolcanoCode(code)) throw new Rejected("identityInvalid");
  return code;
}
// 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）: 対象火山の Item の Kind/Code と火山名の Area/Code。
function present(item: XmlElement, area: XmlElement | undefined): XmlElement {
  const code = (node: XmlElement | null | undefined) => children(node ?? null, "Code").some((value) => blank(scalar(value) ?? "x") != null);
  if (area == null || !code(area) || !children(item, "Kind").some((kind) => code(kind))) missing();
  return area!;
}
function kindOf(item: XmlElement, bound: (value: string | null, limit: number) => string | null): VolcanoKind {
  const kind = children(item, "Kind");
  if (kind.length === 0) missing();
  if (kind.length > 1) invalid();
  const code = blank(leaf(kind[0], "Code"));
  if (code == null) return missing();
  if (!asciiCode(code, LIMITS.code)) invalid();
  return { code, name: bound(leaf(kind[0], "Name") ?? "", BOUNDS.kindName)!,
    condition: bound(blank(leaf(kind[0], "Condition")), BOUNDS.condition) };
}
// 対象市町村・対象海上予報区: Kind の名前ごとの Area/Code（I-U-V.bounds の件数で切る）。
function areaGroups(body: XmlElement | null, part: string, groupLimit: number, codeLimit: number,
  bound: (value: string | null, limit: number) => string | null, mark: () => void): Readonly<{ groups: VolcanoAreaGroup[]; codes: string[] }> {
  const groups: VolcanoAreaGroup[] = [], kinds: string[] = [];
  let total = 0;
  for (const item of typed(body, "VolcanoInfo", part).flatMap((info) => children(info, "Item"))) {
    const kind = first(item, "Kind");
    const kindCode = kind == null ? null : blank(leaf(kind, "Code"));
    if (kindCode != null) {
      if (!asciiCode(kindCode, LIMITS.code)) invalid();
      kinds.push(kindCode);
    }
    const codes: string[] = [];
    for (const area of children(item, "Areas").flatMap((areas) => children(areas, "Area"))) {
      const code = blank(leaf(area, "Code"));
      if (code == null) continue;
      if (!asciiCode(code, LIMITS.areaCode)) invalid();
      if (total >= codeLimit) { mark(); continue; }
      codes.push(code);
      total++;
    }
    if (groups.length >= groupLimit) { mark(); continue; }
    groups.push({ kindName: bound(kind == null ? "" : leaf(kind, "Name") ?? "", BOUNDS.areaKind)!, codes });
  }
  return { groups, codes: kinds };
}

function boundValue(value: MaterialValue, bound: (value: string | null, limit: number) => string | null): MaterialValue {
  if (value.kind === "missing") return value;
  const raw = bound(value.raw, BOUNDS.value)!;
  return value.kind === "text" ? { ...value, value: bound(value.value, BOUNDS.value)!, raw } : { ...value, raw };
}
// classifyMaterial と同じ順の葉に MaterialValue を対応させる（domains/seismic の leafValues の写し、AC14）。
function leafValues(material: DecodedMaterial): ReadonlyMap<XmlElement, MaterialValue> {
  const leaves: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    const nested = children(node);
    if (nested.length === 0) leaves.push(node);
    else nested.forEach(visit);
  };
  visit(material.xml);
  const values = classifyMaterial(material).materialValues;
  return new Map(leaves.map((node, index) => [node, values[index]]));
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function timeOf(value: string | null): number {
  const at = value != null && TIME.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : invalid();
}

// P3-C9-ASHFALL-PROJECTION=A: 旧築の投影と同じ規則で有界な形にする。区分は code だけで引き、名前は確かめない。
function projectAshfall(body: XmlElement | null, reportMs: number, bound: (value: string | null, limit: number) => string | null):
  Readonly<{ forecastStartsAt: number; forecastEndsAt: number; groups: VolcanoAshfallGroup[]; omittedGroupCount: number }> {
  const periods = children(first(body, "AshInfos"), "AshInfo");
  if (periods.length === 0) missing();
  if (periods.length > ASH.periods) invalid();
  type Group = { hazardClass: VolcanoAshfallGroup["hazardClass"]; order: number; ashCode: string; ashName: string;
    areas: Map<string, Readonly<{ code: string | null; name: string; firstForecastEndAt: number }>> };
  const groups = new Map<string, Group>();
  let occurrences = 0, startsAt = Infinity, endsAt = -Infinity;
  for (const period of periods) {
    const start = timeOf(text(period, "StartTime")), end = timeOf(text(period, "EndTime"));
    if (start >= end || end - start > ASH.spanMs || start < reportMs - ASH.beforeReportMs || end > reportMs + ASH.spanMs) invalid();
    startsAt = Math.min(startsAt, start);
    endsAt = Math.max(endsAt, end);
    let count = 0;
    for (const item of children(period, "Item")) {
      const kind = first(item, "Kind");
      const ashCode = blank(kind == null ? null : leaf(kind, "Code"));
      if (ashCode == null || !asciiCode(ashCode, LIMITS.code)) invalid();
      const known = ASH_ORDER.get(ashCode!);
      const name = blank(leaf(kind, "Name"));
      if (known == null && name == null) invalid();
      const key = ashCode!;
      const group = groups.get(key) ?? { hazardClass: known?.hazardClass ?? "unknown", order: known?.order ?? 5, ashCode: key,
        ashName: bound(name ?? "", BOUNDS.ashName)!, areas: new Map() };
      groups.set(key, group);
      for (const area of children(item, "Areas").flatMap((areas) => children(areas, "Area"))) {
        count++;
        const code = blank(leaf(area, "Code")), areaName = leaf(area, "Name") ?? "";
        if (code != null && !asciiCode(code, LIMITS.areaCode) || code == null && areaName === "") invalid();
        const identity = code == null ? `name:${areaName}` : `code:${code}`;
        const found = group.areas.get(identity);
        if (found == null || end < found.firstForecastEndAt)
          group.areas.set(identity, { code, name: bound(areaName, BOUNDS.areaName)!, firstForecastEndAt: end });
      }
    }
    if (count === 0 || count > ASH.areasPerPeriod || (occurrences += count) > ASH.areas) invalid();
  }
  // 合成した予報の期間も 48 時間以内（decode と同じ境界。各期間が通っても [T−6h, T]・[T, T+48h] で 54 時間になる）。
  if (endsAt - startsAt > ASH.spanMs) invalid();
  // 既知の降灰の区分では、地域を最も重い区分にだけ数える（小さな噴石の落下は別に数える）。
  const worst = new Map<string, number>();
  for (const group of groups.values()) if (group.hazardClass === "ash")
    for (const identity of group.areas.keys()) worst.set(identity, Math.min(worst.get(identity) ?? Infinity, group.order));
  const ordered = [...groups.values()].map((group) => ({ group, areas: [...group.areas.entries()]
    .filter(([identity]) => group.hazardClass !== "ash" || worst.get(identity) === group.order)
    .sort(([leftKey, left], [rightKey, right]) => left.firstForecastEndAt - right.firstForecastEndAt
      || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)).map(([, area]) => area) }))
    .filter((item) => item.areas.length !== 0)
    .sort((left, right) => left.group.order - right.group.order || (left.group.ashCode < right.group.ashCode ? -1 : 1));
  const kept = ordered.slice(0, ASH.groups).map(({ group, areas }) => ({ hazardClass: group.hazardClass, ashCode: group.ashCode,
    ashName: group.ashName, areaCount: areas.length, topAreas: areas.slice(0, ASH.topAreas),
    omittedAreaCount: Math.max(areas.length - ASH.topAreas, 0) }));
  return { forecastStartsAt: startsAt, forecastEndsAt: endsAt, groups: kept, omittedGroupCount: ordered.length - kept.length };
}

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は識別できた単一の subject、識別できなければ空文字
// （Q-C9-IMPL-AMEND(7)）。噴火・解説は EventID で、警報・降灰・定時は火山コードを読めた時点で決まる。
function parseVolcano(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  let subject = "";
  const reject = (reason: RejectionReason): ParseResult => ({ kind: "rejected", subject, reason, diagnostic: diagnostic(material, reason) });
  const family = FAMILIES.find((item) => item === material.headType);
  if (family == null) return reject("requiredStructureInvalid");
  const eventId = material.eventIdRaw.trim();
  if (eventId === "") return reject("identityMissing");
  const serialRaw = material.serialRaw.trim();
  if (!validEventId(eventId)) return reject("identityInvalid");
  const op = material.operation;
  if (family === "VFVO52" || family === "VFVO56") subject = `${op}/volcano:eruption/${eventId}`;
  if (family === "VFVO51" || family === "VFVO60" || family === "VZVO40") subject = `${op}/${family}/${eventId}`;
  if (!validSerial(serialRaw)) return reject("identityInvalid");
  const identified = (code: string): string => {
    subject = family === "VFVO53" ? `${op}/VFVO53/${code}` : family === "VFVO54" || family === "VFVO55" ? `${op}/volcano:ashfall/${code}`
      : family === "VFVO50" || isMarine(family) ? `${op}/volcano:alert/${code}` : subject;
    return code;
  };
  // 保存する ReportRef の byte の上限（Q-ENUM.identity）。inputId は host が作る値だが、上限を受理と decode で揃える。
  if (material.reportDateTimeRaw.length > LIMITS.reportDateTime || material.infoTypeRaw.length > LIMITS.infoType
    || material.inputId.length > LIMITS.inputId) return reject("identityInvalid");
  const infoTypeRaw = material.infoTypeRaw.trim();
  const infoRank = INFO_RANK.get(infoTypeRaw);
  if (infoRank == null) return reject("requiredStructureInvalid");
  const reportDateTimeMs = common.envelope.reportDateTimeMs;
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation, family,
    subject: "", reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw };
  const cancelled = infoRank === 3;
  let truncated = false;
  const bound = (value: string | null, limit: number): string | null => {
    if (value == null || value.length <= limit) return value;
    truncated = true;
    return cut(value, limit);
  };
  const mark = () => { truncated = true; };
  const head = first(material.xml, "Head"), body = first(material.xml, "Body");
  const rawTitle = text(head, "Title") || text(first(material.xml, "Control"), "Title") || family;
  const title = cut(rawTitle.replace(/^火山名\s+\S+\s+/, "") || rawTitle, BOUNDS.title);
  const headline = () => bound(blank(text(first(head, "Headline"), "Text")), BOUNDS.headline);
  const content = first(body, "VolcanoInfoContent");
  try {
    const items = volcanoItems(body);
    // 取消は Body が Text だけでよい。火山コードがあれば使い、無ければ記録の eventId で結び付ける（P3-C9-CANCEL-SCOPE）。
    const base = (volcanoCode: string | null) => ({ operation: material.operation, family, eventId, source, reportDateTimeMs, infoRank,
      cancelled, volcanoCode, title });
    if (cancelled) {
      const area = items.flatMap(volcanoAreas)[0];
      const volcanoCode = area == null ? null : identified(volcanoCodeOf(area));
      const reduced = { ...base(volcanoCode), truncated };
      if (family === "VFVO50" || isMarine(family)) return accepted({ ...reduced, slice: "alert", facts: null });
      if (family === "VFVO52" || family === "VFVO56") return accepted({ ...reduced, slice: "eruption", facts: null });
      if (family === "VFVO54" || family === "VFVO55") return accepted({ ...reduced, slice: "ashfall", facts: null });
      if (family === "VFVO53") return accepted({ ...reduced, slice: "scheduled", volcanoName: null, topAshName: null });
      return accepted({ ...reduced, slice: "bulletin", facts: null, entries: [] });
    }
    if (family === "VFVO50" || isMarine(family)) {
      const item = typed(body, "VolcanoInfo", "対象火山").flatMap((info) => children(info, "Item"))[0] ?? missing();
      const area = present(item, volcanoAreas(item)[0]);
      const volcanoCode = identified(volcanoCodeOf(area));
      const kind = kindOf(item, bound);
      const last = children(item, "LastKind");
      if (last.length > 1) invalid();
      const lastCode = last.length === 0 ? null : blank(leaf(last[0], "Code"));
      if (lastCode != null && !asciiCode(lastCode, LIMITS.code)) invalid();
      const coordinate = blank(leaf(area, "Coordinate"));
      const municipalities = areaGroups(body, "対象市町村等", LIMITS.municipalityGroups, LIMITS.municipalityCodes, bound, mark);
      const marine = areaGroups(body, "対象海上予報区", LIMITS.marineGroups, LIMITS.marineCodes, bound, mark);
      const facts: AlertFacts = { volcanoName: bound(leaf(area, "Name") ?? "", BOUNDS.volcanoName)!, kind,
        lastKind: lastCode == null ? null : { code: lastCode, name: bound(leaf(last[0], "Name") ?? "", BOUNDS.kindName)! },
        headline: headline(), municipalities: municipalities.groups, marineAreas: marine.groups,
        coordinate: coordinate != null && asciiCode(coordinate, LIMITS.coordinate) ? coordinate : null, marineCodes: marine.codes,
        activity: cut(blank(text(content, "VolcanoActivity")) ?? "", BOUNDS.activity) || null,
        prevention: cut(blank(text(content, "VolcanoPrevention")) ?? "", BOUNDS.prevention) || null };
      return accepted({ ...base(volcanoCode), truncated, slice: "alert", facts });
    }
    if (family === "VFVO52" || family === "VFVO56") {
      const item = items[0] ?? missing();
      const area = present(item, volcanoAreas(item)[0]);
      const volcanoCode = identified(volcanoCodeOf(area));
      const kind = kindOf(item, bound);
      const eventTime = blank(text(first(item, "EventTime"), "EventDateTime"));
      if (eventTime != null && !asciiCode(eventTime, LIMITS.eventDateTime)) invalid();
      const plume = first(first(body, "VolcanoObservation"), "ColorPlume");
      const values = plume == null ? null : leafValues(material);
      const valueOf = (name: string): MaterialValue => {
        const node = first(plume, name);
        return node == null || values == null ? { kind: "missing" } : boundValue(values.get(node) ?? { kind: "unknown", raw: "" }, bound);
      };
      const municipalities = typed(body, "VolcanoInfo", "対象市町村等").flatMap((info) => children(info, "Item"))
        .flatMap((entry) => children(entry, "Areas")).flatMap((areas) => children(areas, "Area"))
        .flatMap((entry) => { const code = blank(leaf(entry, "Code")); return code == null ? [] : [code]; });
      if (municipalities.some((code) => !asciiCode(code, LIMITS.areaCode))) invalid();
      if (municipalities.length > LIMITS.eruptionAreas) mark();
      const direction = blank(text(plume, "PlumeDirection"));
      const facts: EruptionFacts = { volcanoName: bound(leaf(area, "Name") ?? "", BOUNDS.volcanoName)!,
        phenomenon: { code: kind.code, name: bound(kind.name, BOUNDS.phenomenon)! }, eventDateTimeRaw: eventTime,
        craterName: bound(blank(text(area, "CraterName")), BOUNDS.crater), plumeAboveCrater: valueOf("PlumeHeightAboveCrater"),
        plumeAboveSeaLevel: valueOf("PlumeHeightAboveSeaLevel"), plumeDirection: bound(direction, BOUNDS.direction),
        headline: headline(), municipalities: municipalities.slice(0, LIMITS.eruptionAreas) };
      return accepted({ ...base(volcanoCode), truncated, slice: "eruption", facts });
    }
    if (family === "VFVO54" || family === "VFVO55" || family === "VFVO53") {
      const areas = items.flatMap(volcanoAreas);
      if (areas.length === 0 || family !== "VFVO53" && children(first(body, "AshInfos"), "AshInfo").length === 0) missing();
      const volcanoCode = identified(volcanoCodeOf(areas[0]));
      if (areas.some((area) => volcanoCodeOf(area) !== volcanoCode)) invalid();
      const volcanoName = bound(leaf(areas[0], "Name") ?? "", BOUNDS.volcanoName)!;
      if (family === "VFVO53") {
        // 最も重い降灰の区分名（通知の body、旧築 buildAshfallSummary）。AshInfos は欠落してよい。
        const kinds = children(first(body, "AshInfos"), "AshInfo").flatMap((info) => children(info, "Item"))
          .flatMap((item) => children(item, "Kind")).map((kind) => ({ code: text(kind, "Code") ?? "", name: text(kind, "Name") ?? "" }));
        const top = kinds.sort((left, right) => (ASH_ORDER.get(left.code)?.order ?? 5) - (ASH_ORDER.get(right.code)?.order ?? 5))[0];
        return accepted({ ...base(volcanoCode), truncated, slice: "scheduled", volcanoName,
          topAshName: top == null || top.name === "" ? null : bound(top.name, BOUNDS.ashName) });
      }
      const projection = projectAshfall(body, reportDateTimeMs, bound);
      return accepted({ ...base(volcanoCode), truncated, slice: "ashfall", facts: { volcanoName, headline: headline(), ...projection } });
    }
    // VFVO51・VFVO60・VZVO40（解説、P3-C9-BULLETIN=A）。
    const titleNode = first(head, "Title");
    if (titleNode == null) missing();
    if (children(titleNode).length !== 0) invalid();
    const entries = new Map<string, VolcanoEntry>();
    let count = 0;
    if (family === "VFVO51") for (const item of typed(first(head, "Headline"), "Information", "対象火山").flatMap((info) => children(info, "Item"))) {
      for (const area of volcanoAreas(item)) {
        if (++count > LIMITS.entries) invalid();
        const before: boolean = truncated;
        truncated = false;
        const kind = kindOf(item, bound);
        const volcanoCode = volcanoCodeOf(area);
        const volcanoName = bound(leaf(area, "Name") ?? "", BOUNDS.volcanoName)!;
        // 同じ報の中で同じ火山が二度出たら電文順の最後を採る（旧築 volcano-route-handler.ts の同一 subject）。
        entries.delete(volcanoCode);
        entries.set(volcanoCode, { volcanoCode, volcanoName, kind, truncated });
        truncated = before;
      }
    }
    const codes = family === "VFVO51" ? [...entries.keys()] : items.flatMap(volcanoAreas).map(volcanoCodeOf);
    if (codes.length > LIMITS.bulletinVolcanoes) mark();
    const infoKind = text(head, "InfoKind") ?? "";
    const facts: BulletinFacts = { title: bound(rawTitle, BOUNDS.title)!, headline: headline(),
      volcanoCodes: codes.slice(0, LIMITS.bulletinVolcanoes), extraordinary: rawTitle.includes("臨時") || infoKind.includes("臨時"),
      text: bound(blank(text(content, "VolcanoActivity")) ?? blank(text(body, "Text")), BOUNDS.text),
      nextAdvisory: bound(blank(text(content, "NextAdvisory")), BOUNDS.nextAdvisory),
      volcanoName: items.flatMap(volcanoAreas).map((area) => cut(leaf(area, "Name") ?? "", BOUNDS.volcanoName))[0] ?? null };
    return accepted({ ...base(codes[0] ?? null), truncated, slice: "bulletin", facts, entries: [...entries.values()] });
  } catch (error) {
    if (error instanceof Rejected) return reject(error.reason);
    throw error;
  }
}
const accepted = (candidate: VolcanoCandidate): ParseResult => ({ kind: "accepted", candidate });

export { ASH, ASH_ORDER, BOUNDS, FAMILIES, INFO_RANK, LIMITS, asciiCode, isMarine, parseVolcano, validEventId, validSerial,
  validVolcanoCode };
export type { AlertFacts, VolcanoCandidate, VolcanoEntry };
