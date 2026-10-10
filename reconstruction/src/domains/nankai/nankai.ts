import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { NankaiCurrentLine, NankaiCurrentStatus, NankaiInfoSerial, NankaiReportFamily } from "../../../contracts/p3-nankai-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-UNIT-N-001 の adapter: VYSE50/51/52/60 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);
const FAMILIES: readonly NankaiReportFamily[] = ["VYSE50", "VYSE51", "VYSE52", "VYSE60"];

// P3-C8-CODE-TABLE=A（旧築 nankai-status.ts と同じ表）。end は active の investigating だけを終える。
const CODE_EFFECT: ReadonlyMap<string, NankaiCurrentStatus | "end"> = new Map([
  ["111", "investigating"], ["112", "investigating"], ["113", "investigating"],
  ["120", "megaquakeWarning"], ["130", "megaquakeAdvisory"], ["190", "end"],
]);

// I-U-N.bounds（UTF-16 の長さ）。
const BOUNDS = { title: 128, headline: 512, text: 4_096, nextAdvisory: 512, infoKind: 64, code: 8, name: 32 } as const;
// I-U-N.bounds の現況 1 件の上限 4,718 byte が仮定する ReportRef の長さ（Q-ENUM.identity）。
const LIMITS = { inputId: 64, reportDateTime: 40, infoType: 8 } as const;

// ---- Q-ENUM.identity ----

// 印字可能な ASCII（0x21〜0x7E）で「/」「"」「\」を含まず 64 byte 以下（subject の区切りを壊さず、JSON のエスケープで byte が
// 増えないので保存する現況の byte 上限を件数から決められる、I-U-N.capacityReserve）。
function validEventId(value: string): boolean {
  return value.length <= 64 && /^[\x21\x23-\x2e\x30-\x5b\x5d-\x7e]+$/.test(value);
}
function validSerial(value: string): boolean {
  return value === "" || /^[1-9]\d{0,9}$/.test(value);
}

// ---- XML の読み取り（domains/seismic・domains/tsunami と同じ写し。共有化は統合担当が決める、AC12） ----

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
const blank = (value: string | null): string | null => value == null || value === "" ? null : value;

// 切り詰めでサロゲートの対を割らない（割ると JSON で \uXXXX の 6 byte になり、I-U-N.bounds の最悪の byte を超える）。
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

// ---- 候補 ----

// headingTruncated は現況に残す見出し（title・headline・infoSerial）の切り詰め、truncated は情報 subject の全 field の切り詰め。
type NankaiFacts = Readonly<{ infoKind: string | null; infoSerial: NankaiInfoSerial | null; title: string; headline: string | null;
  text: string | null; nextAdvisory: string | null; truncated: boolean; headingTruncated: boolean }>;
// effect は報が現況に何を求めるか（P3-C8-CODE-TABLE=A・P3-C8-VYSE60=A）。null は現況に効かない code。
type NankaiCandidate = Readonly<{
  operation: Operation; family: NankaiReportFamily; line: NankaiCurrentLine; eventId: string;
  currentSubject: string; subject: string; source: ReportRef; reportDateTimeMs: number; infoRank: number; cancelled: boolean;
  effect: NankaiCurrentStatus | "subsequentAdvisory" | "end" | null; facts: NankaiFacts;
}>;
type ParseResult = Readonly<{ kind: "accepted"; candidate: NankaiCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "nankai", reason, inputId: material.inputId, unit: "U-N" };
}

// 子要素の無い要素の直下 text だけを読む。2 個以上か子要素があれば文字列として読めない（Q-ENUM.familyTable.invalid）。
function single(parent: XmlElement | null, name: string, leaf: boolean): XmlElement | null {
  const found = children(parent, name);
  if (found.length > 1 || leaf && found.length === 1 && children(found[0]).length !== 0) invalid();
  return found[0] ?? null;
}

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。識別できない拒否の subject は空文字。
function parseNankai(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult =>
    ({ kind: "rejected", subject, reason, diagnostic: diagnostic(material, reason) });
  const family = FAMILIES.find((item) => item === material.headType);
  if (family == null) return reject("requiredStructureInvalid");
  const eventId = material.eventIdRaw.trim();
  if (eventId === "") return reject("identityMissing");
  const serialRaw = material.serialRaw.trim();
  if (!validEventId(eventId) || !validSerial(serialRaw)) return reject("identityInvalid");
  const subject = `${material.operation}/${family}/${eventId}`;
  // 保存する ReportRef の byte の上限（Q-ENUM.identity）。inputId は host が作る値だが、上限を受理と decode で揃える。
  if (material.reportDateTimeRaw.length > LIMITS.reportDateTime || material.infoTypeRaw.length > LIMITS.infoType
    || material.inputId.length > LIMITS.inputId) return reject("identityInvalid", subject);
  const infoTypeRaw = material.infoTypeRaw.trim();
  const infoRank = INFO_RANK.get(infoTypeRaw);
  if (infoRank == null) return reject("requiredStructureInvalid", subject);
  const line: NankaiCurrentLine = family === "VYSE60" ? "VYSE60" : "nankai";
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation, family,
    subject, reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw };
  const cancelled = infoRank === 3;
  const head = first(material.xml, "Head");
  let truncated = false;
  const bound = (value: string | null, limit: number): string | null => {
    if (value == null || value.length <= limit) return value;
    truncated = true;
    return cut(value, limit);
  };
  const title = bound(text(head, "Title") || text(first(material.xml, "Control"), "Title") || family, BOUNDS.title)!;
  const headline = bound(blank(text(first(head, "Headline"), "Text")), BOUNDS.headline);
  try {
    const body = first(material.xml, "Body");
    // 取消は Body が Text だけでよい（74_03_01）。事実を持たない。
    if (cancelled) return { kind: "accepted", candidate: { operation: material.operation, family, line, eventId,
      currentSubject: `${material.operation}/${line}/current`, subject, source, reportDateTimeMs: common.envelope.reportDateTimeMs,
      infoRank, cancelled, effect: null,
      facts: { infoKind: null, infoSerial: null, title, headline, text: null, nextAdvisory: null, truncated, headingTruncated: truncated } } };
    // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）。
    const infos = children(body, "EarthquakeInfo");
    if (infos.length === 0) missing();
    if (infos.length > 1) invalid();
    const info = infos[0];
    const serial = single(info, "InfoSerial", false);
    const codeNode = single(serial, "Code", true), nameNode = single(serial, "Name", true);
    const code = codeNode == null ? null : blank(scalar(codeNode));
    const infoSerial = code == null ? null : { code: bound(code, BOUNDS.code)!, name: bound(nameNode == null ? null : blank(scalar(nameNode)), BOUNDS.name) };
    const headingTruncated = truncated;
    // P3-C8-VYSE60=A: VYSE60 は InfoSerial によらず後発地震注意の系統を active にする。
    const effect = family === "VYSE60" ? "subsequentAdvisory" as const : infoSerial == null ? null : CODE_EFFECT.get(infoSerial.code) ?? null;
    const facts = { infoKind: bound(blank(text(info, "InfoKind")), BOUNDS.infoKind), infoSerial, title, headline,
      text: bound(blank(text(info, "Text")), BOUNDS.text), nextAdvisory: bound(blank(text(body, "NextAdvisory")), BOUNDS.nextAdvisory) };
    return { kind: "accepted", candidate: { operation: material.operation, family, line, eventId,
      currentSubject: `${material.operation}/${line}/current`, subject, source, reportDateTimeMs: common.envelope.reportDateTimeMs,
      infoRank, cancelled, effect, facts: { ...facts, truncated, headingTruncated } } };
  } catch (error) {
    if (error instanceof Rejected) return reject(error.reason, subject);
    throw error;
  }
}

export { BOUNDS, FAMILIES, INFO_RANK, LIMITS, cut, parseNankai, validEventId, validSerial };
export type { NankaiCandidate, NankaiFacts };
