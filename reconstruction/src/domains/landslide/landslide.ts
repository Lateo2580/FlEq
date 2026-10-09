import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { LandslideKindGroup } from "../../../contracts/p3-landslide-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-UNIT-L-001 の adapter: VPWW56 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

const FAMILY = "VPWW56";
// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);
// Q-ENUM.statuses（U-W の STATUSES と同じ語彙）。active かどうかは P3-C10-ACTIVE-STATUS=A。
const STATUSES: ReadonlySet<string> = new Set(["発表", "継続", "解除", "発表警報・注意報はなし", "警報から注意報",
  "危険警報から注意報", "危険警報から警報", "特別警報から警報", "特別警報から注意報", "特別警報から危険警報"]);
const RELEASED = "解除", NONE = "発表警報・注意報はなし";
// Q-ENUM.codeTable（旧築 weather-warning-level.ts の土砂の表、R39: Code が正本）。表に無い 2 桁の code は null で active。
const LEVELS: ReadonlyMap<string, 2 | 3 | 4 | 5> = new Map([["29", 2], ["09", 3], ["49", 4], ["39", 5]]);
const MUNICIPALITY = "気象警報・注意報（市町村等）";

// I-U-L.bounds（UTF-16 の長さ）と件数・ASCII の上限、Q-ENUM.identity の ReportRef の長さ。
const BOUNDS = { title: 128, kindName: 32, areaName: 32, headline: 256, office: 64 } as const;
const LIMITS = { inputId: 64, reportDateTime: 40, infoType: 8, areaCode: 16, items: 256, kinds: 8 } as const;

// Serial は空を合法とし、あれば 10 桁以下の数字列（比較は数として、Q-ENUM.identity）。
const validSerial = (value: string): boolean => value === "" || /^\d{1,10}$/.test(value);
// 官署は 64 単位以下で制御文字なし（subject と保存の byte 上限、I-U-L.capacityReserve）。
const validOffice = (value: string): boolean => value !== "" && value.length <= BOUNDS.office && !/[\u0000-\u001f\u007f]/.test(value);
const validAreaCode = (value: string): boolean => value.length <= LIMITS.areaCode && /^\d+$/.test(value);
const validKindCode = (value: string): boolean => /^\d{2}$/.test(value);
const levelOf = (code: string): 2 | 3 | 4 | 5 | null => LEVELS.get(code) ?? null;
// LandslideKindGroup の順（level の高い順、null は 3 の直後、同じ順位は code の昇順）。
const groupRank = (level: 2 | 3 | 4 | 5 | null): number => level ?? 2.5;
const groupOrder = (left: LandslideKindGroup, right: LandslideKindGroup): number =>
  groupRank(right.level) - groupRank(left.level) || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0);

// ---- XML の読み取り（domains/nankai・domains/volcano と同じ写し。共有化は統合担当が決める、AC12） ----

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
// 切り詰めでサロゲートの対を割らない（割ると JSON で \uXXXX の 6 byte になり、I-U-L.capacityReserve の最悪の byte を超える）。
function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}

// ---- 候補 ----

// kinds は active の Kind/Code ごとの group（types.ts の順）。released は Status「解除」の区域を持つか（Q-NOTICE の inactiveAdoption）。
// areaNames は採用時の outcome の facts だけに載せる区域の名前（保存しない、P3-C10-AREAS=A）。
type LandslideCandidate = Readonly<{
  operation: Operation; office: string; subject: string; source: ReportRef; reportDateTimeMs: number; infoRank: number;
  cancelled: boolean; title: string; headline: string | null; kinds: readonly LandslideKindGroup[]; released: boolean;
  truncated: boolean; areaNames: Readonly<Record<string, string>>;
}>;
type ParseResult = Readonly<{ kind: "accepted"; candidate: LandslideCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は官署を読めた後だけ官署の subject。
function parseLandslide(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "landslide", reason, inputId: material.inputId, unit: "U-L" } });

  // Q-ENUM.identity: Control/EditorialOffice（P3-C10-SUBJECTS=A）。
  const controls = children(material.xml, "Control");
  const offices = controls.flatMap((node) => children(node, "EditorialOffice"));
  const officeValues = offices.map(scalar);
  if (controls.length === 0 || controls.length === 1 && (offices.length === 0 || officeValues.some((value) => value === "")))
    return reject("identityMissing");
  const office = officeValues[0];
  if (controls.length !== 1 || offices.length !== 1 || office == null || !validOffice(office)) return reject("identityInvalid");
  const subject = `${material.operation}/${FAMILY}/${office}`;
  const serialRaw = material.serialRaw.trim();
  // 保存する ReportRef の byte の上限（Q-ENUM.identity、C8 の Q-C8-IMPL-AMEND(a)）。
  if (!validSerial(serialRaw) || material.reportDateTimeRaw.length > LIMITS.reportDateTime
    || material.infoTypeRaw.length > LIMITS.infoType || material.inputId.length > LIMITS.inputId) return reject("identityInvalid", subject);

  // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）。
  let missing = false, invalid = false;
  const head = children(material.xml, "Head")[0] ?? null;
  const titles = children(head, "Title");
  const titleText = titles.length === 0 ? null : scalar(titles[0]);
  if (titles.length === 0 || titleText === "") missing = true;
  if (titles.length > 1 || titles.length === 1 && titleText == null) invalid = true;
  // Head/InfoType も 1 個の scalar を確かめる（P1 は最初の要素の直下 text だけを読むので、重複や子要素を取消と読まない）。
  const infoTypes = children(head, "InfoType");
  const infoTypeText = infoTypes.length === 0 ? null : scalar(infoTypes[0]);
  const infoTypeRaw = material.infoTypeRaw.trim();
  const infoRank = infoTypes.length === 1 && infoTypeText === infoTypeRaw ? INFO_RANK.get(infoTypeRaw) : undefined;
  if (infoTypes.length === 0 || infoTypeText === "") missing = true;
  else if (infoRank == null) invalid = true;
  const cancelled = infoRank === 3;

  const groups = new Map<string, { name: string; areas: string[] }>();
  const areaNames: Record<string, string> = {};
  let released = false, truncated = false;
  const bound = (value: string, limit: number): string => {
    if (value.length > limit) truncated = true;
    return cut(value, limit);
  };
  // 取消は Body/Warning を読まない（無いか空でよい、Q-ENUM.familyTable.legalMissing）。
  if (!cancelled) {
    const bodies = children(material.xml, "Body");
    if (bodies.length === 0) missing = true;
    if (bodies.length > 1) invalid = true;
    // 市町村等以外の Warning は読まず形も確かめない。
    const warnings = children(bodies[0] ?? null, "Warning").filter((node) =>
      node.attributes.some((item) => item.name === "type" && item.value.trim() === MUNICIPALITY));
    if (bodies.length === 1 && warnings.length === 0) missing = true;
    if (warnings.length > 1) invalid = true;
    const items = children(warnings[0] ?? null, "Item");
    if (warnings.length === 1 && items.length === 0) missing = true;
    // Q-ENUM.familyTable.invalid: Item 256 を超える報は中を読まない（受理と decode の区域の延べを 256 で揃える）。
    if (items.length > LIMITS.items) invalid = true;
    const seen = new Set<string>();
    for (const item of items.length > LIMITS.items ? [] : items) {
      const areas = children(item, "Area"), kinds = children(item, "Kind");
      const codes = areas.length === 1 ? children(areas[0], "Code") : [];
      const code = codes.length === 1 ? scalar(codes[0]) : null;
      if (areas.length === 0 || areas.length === 1 && (codes.length === 0 || code === "")) missing = true;
      else if (areas.length > 1 || code == null || !validAreaCode(code) || seen.has(code)) invalid = true;
      else seen.add(code);
      // 非取消の Item の Kind は 1 個（0 個も 2 個以上も requiredStructureInvalid）。
      if (kinds.length !== 1) { invalid = true; continue; }
      const kind = kinds[0];
      const statuses = children(kind, "Status");
      const status = statuses.length === 0 ? null : scalar(statuses[0]);
      if (statuses.length === 0 || status === "") { missing = true; continue; }
      if (statuses.length > 1 || status == null || !STATUSES.has(status)) { invalid = true; continue; }
      if (status === NONE) continue;
      const kindCodes = children(kind, "Code"), names = children(kind, "Name");
      const kindCode = kindCodes.length === 0 ? null : scalar(kindCodes[0]);
      const name = names.length === 0 ? null : scalar(names[0]);
      if (kindCodes.length === 0 || kindCode === "" || names.length === 0 || name === "") { missing = true; continue; }
      if (kindCodes.length > 1 || names.length > 1 || kindCode == null || name == null || !validKindCode(kindCode)) { invalid = true; continue; }
      if (status === RELEASED) released = true;
      // P3-C10-ACTIVE-STATUS=A: 「解除」「発表警報・注意報はなし」と code 00 は inactive。
      if (status === RELEASED || kindCode === "00" || code == null) continue;
      const nameNode = children(areas[0], "Name")[0];
      const areaName = nameNode == null ? null : scalar(nameNode);
      if (areaName != null && areaName !== "") areaNames[code] = cut(areaName, BOUNDS.areaName);
      const group = groups.get(kindCode);
      if (group == null) groups.set(kindCode, { name: bound(name, BOUNDS.kindName), areas: [code] });
      else group.areas.push(code);
    }
    if (groups.size > LIMITS.kinds) invalid = true;
  }
  if (missing) return reject("requiredStructureMissing", subject);
  if (invalid || infoRank == null || titleText == null) return reject("requiredStructureInvalid", subject);
  const kinds = [...groups].map(([code, group]): LandslideKindGroup => ({ code, name: group.name, level: levelOf(code),
    areas: group.areas })).sort(groupOrder);
  const headlineNode = children(children(head, "Headline")[0] ?? null, "Text")[0];
  const headline = headlineNode == null ? null : scalar(headlineNode);
  return { kind: "accepted", candidate: { operation: material.operation, office, subject,
    source: { inputId: material.inputId, origin: material.origin, operation: material.operation, family: FAMILY, subject,
      reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw },
    reportDateTimeMs: common.envelope.reportDateTimeMs, infoRank, cancelled, title: bound(titleText, BOUNDS.title),
    headline: headline == null || headline === "" ? null : cut(headline, BOUNDS.headline), kinds, released, truncated, areaNames } };
}

export { BOUNDS, FAMILY, INFO_RANK, LIMITS, cut, groupOrder, levelOf, parseLandslide, validAreaCode, validKindCode, validOffice, validSerial };
export type { LandslideCandidate };
