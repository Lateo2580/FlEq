import type { XmlElement } from "../../contracts/p1-parser-boundary.types";
import type { UnreadableMark, UnreadableMarkView, UnreadablePart } from "../../contracts/p2-shared-runtime.types";
import { boundedString } from "../runtime/runtime-diagnostic";

// P3-UNREADABLE-MARK-001（K14、H51）: 記録の読めなかった所の印・原文の欠片・原文の予算の正本。無いと 10 unit が欠片の書き直しと
// 予算の外し方と codec の検査を別々に持ち、上限の直しが 10 か所に散る（notice-mark.ts と同じ理由）。

type Reason = UnreadablePart["reason"];
// P3-UM-RES-03・AC01 (4)・RES-02・RES-08（置き値）。
const PART_LIMIT = 16, SCOPE_BYTES = 128, RAW_BYTES = 1538, KEYS_LIMIT = 128;
// P3-UM-RES-01（置き値）: unit ごとの原文の予算。U-F は付加事項の原文が多いので広い（P3-UM-D-ADDITION-MARK）。
const RAW_BUDGET = 131_072, WEATHER_TIMESERIES_RAW_BUDGET = 1_048_576;
// P3-UM-D-ADDITION-MARK: U-F の付加事項の site。view の一覧に入れず、part の上限と予算ではほかより先に外す。
const ADDITION_SITE = "addition";
const HEX16 = /^[0-9a-f]{16}$/;
const encoder = new TextEncoder();
const jsonBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength;

// ---- 欠片の書き直し（P3-UM-D-RAW-FORM: 要素名・属性・文字を順に、実体参照は 5 つだけに戻す） ----

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => ENTITIES[character]);
// boundedString は 1 文字 1 byte 以上で数えて 1,515 文字目までに切るので、UTF-16 で 4,096 単位を集めれば切り方は全体を書いたときと同じ。
// 無いと巨大な部分木（VPWP50 の Item は p90 24 KB）を毎回全部書く（P3-UM-AC17 (1)）。
const REWRITE_STOP = 4096;
// 文字列の欠片は読み飛ばした地の文（Q-WS-LEVELS の「地の文」、実体参照だけ戻す）。U-F の付加事項は 1 Type の要素を順につなげる（P3-UM-D-ADDITION-MARK）。
function rewriteXml(...nodes: readonly (XmlElement | string)[]): string {
  let out = "";
  const walk = (element: XmlElement): boolean => {
    out += `<${element.name}${element.attributes.map((item) => ` ${item.name}="${escape(item.value)}"`).join("")}>`;
    // 子要素のある要素の空白だけの文字（字下げ）は書かない（正規形。残存リスク (16) の「空白が電文の byte と違う」）。
    const mixed = element.children.some((node) => node.kind === "element");
    for (const child of element.children) {
      if (out.length >= REWRITE_STOP) return false;
      if (child.kind === "text") { if (!mixed || child.value.trim() !== "") out += escape(child.value); }
      else if (!walk(child)) return false;
    }
    out += `</${element.name}>`;
    return out.length < REWRITE_STOP;
  };
  for (const node of nodes) {
    if (typeof node === "string") out += escape(node);
    else if (!walk(node)) break;
    if (out.length >= REWRITE_STOP) break;
  }
  return boundedString(out);
}

// AC01 (4): scope は JSON にした長さ（引用符を含む）で 128 byte まで。越える分は code point の境で切る。
function fitScope(value: string): string {
  if (jsonBytes(value) <= SCOPE_BYTES) return value;
  let kept = "";
  for (const character of value) {
    if (jsonBytes(kept + character) > SCOPE_BYTES) break;
    kept += character;
  }
  return kept;
}

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
const child = (parent: XmlElement | undefined, name: string): XmlElement | undefined =>
  parent?.children.find((node): node is XmlElement => node.kind === "element" && localName(node) === name);
// AC02 (3): 見出し文は Head/Headline/Text の文字（Q-UM-JMA の (1)）。無いか空なら null。
function headlineOf(root: XmlElement): string | null {
  const text = child(child(child(root, "Head"), "Headline"), "Text");
  const value = text?.children.flatMap((node) => node.kind === "text" ? [node.value] : []).join("").trim() ?? "";
  return value === "" ? null : boundedString(value);
}

// ---- 印の作成（domain の warn から。AC01 (2)(3)・AC02 (1)） ----

type Note = Readonly<{ site: string; reason: Reason; scope?: string; nodes: (XmlElement | string)[] }>;
type Unreadable = Readonly<{
  // node は読めなかった要素（欠けなら親）か読み飛ばした地の文。欠片は印に残す 16 件だけ書き直す（AC17 (1)）。
  note: (site: string, reason: Reason, node: XmlElement | string | null, scope?: string) => void;
  mark: (root: XmlElement) => UnreadableMark | null;
}>;
// (site, scope) の組で 1 件（先着）。16 件を越えたら残す順位の低い所（U-F の addition、ほかは warn の後の所）から省き partsCut を付ける。
function unreadableNotes(): Unreadable {
  const notes = new Map<string, Note>();
  return {
    note(site, reason, node, scope) {
      const fitted = scope == null ? undefined : fitScope(scope);
      const key = fitted == null ? site : `${site}\u0000${fitted}`;
      const found = notes.get(key);
      // 付加事項は同じ Type の要素を順につなげる（ほかは先着の 1 つ）。要素は 1 文字以上に書けるので、REWRITE_STOP 個より先は欠片に入らない。
      if (found == null) notes.set(key, { site, reason, ...fitted == null ? {} : { scope: fitted }, nodes: node == null ? [] : [node] });
      else if (site === ADDITION_SITE && node != null && found.nodes.length < REWRITE_STOP) found.nodes.push(node);
    },
    mark(root) {
      if (notes.size === 0) return null;
      const all = [...notes.values()];
      const kept = all.length <= PART_LIMIT ? all
        : [...all.filter((item) => item.site !== ADDITION_SITE), ...all.filter((item) => item.site === ADDITION_SITE)].slice(0, PART_LIMIT);
      const keep = new Set(kept);
      const parts = all.filter((item) => keep.has(item)).map((item): UnreadablePart => ({ site: item.site, reason: item.reason,
        ...item.scope == null ? {} : { scope: item.scope }, raw: item.nodes.length === 0 ? null : rewriteXml(...item.nodes) }));
      return { parts, headline: headlineOf(root), ...all.length > PART_LIMIT ? { partsCut: true as const } : {} };
    },
  };
}

// AC01 (3)(6): 前の版から引き継ぐ要素（U-T の観測点・推定区域）の part を、この版の part と (site, scope) で 1 件にまとめる（引き継ぐ方が先）。
// 丸ごとの置き換えでないので、外した履歴の旗（partsCut・rawDropped）は前の印から持ち越す。何も残らなければ印を外す。
function inheritMark(previous: UnreadableMark, inherited: readonly UnreadablePart[], incoming: UnreadableMark | null): UnreadableMark | undefined {
  const parts: UnreadablePart[] = [], seen = new Set<string>();
  for (const part of [...inherited, ...incoming?.parts ?? []]) {
    const key = part.scope == null ? part.site : `${part.site}\u0000${part.scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  const cut = parts.length > PART_LIMIT || previous.partsCut === true || incoming?.partsCut === true, dropped = previous.rawDropped === true;
  if (parts.length === 0 && !cut && !dropped) return undefined;
  return { parts: parts.slice(0, PART_LIMIT), headline: incoming == null ? previous.headline : incoming.headline,
    ...dropped ? { rawDropped: true } : {}, ...cut ? { partsCut: true } : {} };
}

// ---- 原文の byte（AC03 (1)。受信と復元で同じ関数） ----

// 索引の型は、事実を持たない枝（印の欄の無い記録）を含む判別共用体の記録も受けるため（全部が任意の欄の型は TS の weak type で弾かれる）。
type Marked = Readonly<{ unreadable?: UnreadableMark; marineUnreadable?: UnreadableMark; [key: string]: unknown }>;
const markBytesCache = new WeakMap<UnreadableMark, number>();
// null でない raw と見出し文の JSON.stringify の UTF-8 の長さの和。印は不変なので印ごとに 1 回だけ数える。
function markRawBytes(mark: UnreadableMark | undefined): number {
  if (mark == null) return 0;
  let size = markBytesCache.get(mark);
  if (size == null) {
    size = mark.parts.reduce((sum, part) => sum + (part.raw == null ? 0 : jsonBytes(part.raw)), mark.headline == null ? 0 : jsonBytes(mark.headline));
    markBytesCache.set(mark, size);
  }
  return size;
}
const recordRawBytes = (record: Marked): number => markRawBytes(record.unreadable) + markRawBytes(record.marineUnreadable);
// AC03 (2): unit の合計は記録ごとの加算。配列に結び付けて覚え、新しい配列だけ記録ごとの覚えた値を足し直す（索引の indexOf と同じ作り）。
// bytesOf は記録の原文の byte（印を中に持つ記録、U-Q の地震は寄与の和）。1 つの配列は 1 つの数え方でだけ数える。
const totalCache = new WeakMap<readonly object[], number>();
function rawTotalBy<T extends object>(slice: readonly T[], bytesOf: (record: T) => number): number {
  let size = totalCache.get(slice);
  if (size == null) { size = slice.reduce((sum, item) => sum + bytesOf(item), 0); totalCache.set(slice, size); }
  return size;
}
const rawTotal = (...slices: readonly (readonly Marked[])[]): number => slices.reduce((sum, slice) => sum + rawTotalBy(slice, recordRawBytes), 0);

// ---- 予算（AC03 (3)(4)、P3-UM-D-RAW-BUDGET） ----

function stripMark(mark: UnreadableMark | undefined, additionOnly: boolean): UnreadableMark | undefined {
  if (mark == null || markRawBytes(mark) === 0) return mark;
  const strip = (part: UnreadablePart) => !additionOnly || part.site === ADDITION_SITE;
  if (!mark.parts.some((part) => part.raw != null && strip(part)) && (additionOnly || mark.headline == null)) return mark;
  return { ...mark, parts: mark.parts.map((part) => part.raw != null && strip(part) ? { ...part, raw: null } : part),
    headline: additionOnly ? mark.headline : null, rawDropped: true };
}
function stripRecord<T extends Marked>(record: T, additionOnly: boolean): T {
  const unreadable = stripMark(record.unreadable, additionOnly), marine = stripMark(record.marineUnreadable, additionOnly);
  return unreadable === record.unreadable && marine === record.marineUnreadable ? record
    : { ...record, ...unreadable == null ? {} : { unreadable }, ...marine == null ? {} : { marineUnreadable: marine } };
}
const dropped = (record: Marked): boolean => record.unreadable?.rawDropped === true || record.marineUnreadable?.rawDropped === true;
// modes は外す記録ごとの外し方（true は付加事項の原文だけ）。記録の型を保つため、適用は各 unit が slice ごとに stripRaw で行う。
// newly は rawDropped の付いていなかった記録の subject（key の 2 つ目）、subjectOf はその key。
type RawPlan<T extends Marked = Marked> = Readonly<{ modes: ReadonlyMap<object, boolean>; newly: ReadonlySet<string>; subjectOf: (record: T) => string }>;
// 合計（total、rawTotal で数えた値）が予算を越えたら、原文を持つ記録を ReportDateTime の古い順（同じなら subject の順、key）に 1 回並べ、
// その順に原文を外して予算の内で止める。U-F（additionFirst）はまず付加事項の原文だけを同じ順に外す。H39 は rawDropped の付いていなかった
// 記録ごとに 1 件（選び直しで数えない）で、数えるのは droppedIn。records は予算を越えたときだけ呼ぶ。
// ponytail: 並べ替えは予算を越えたときだけで、記録の上限（U-Q の寄与 2,304）の O(n log n)（P3-UM-AC17 (3)）。
function fitRawBudget<T extends Marked>(total: number, budget: number, records: () => readonly T[],
  key: (record: T) => readonly [number, string], additionFirst = false): RawPlan<T> | null {
  if (total <= budget) return null;
  const order = (left: T, right: T) => {
    const [leftMs, leftSubject] = key(left), [rightMs, rightSubject] = key(right);
    return leftMs - rightMs || (leftSubject < rightSubject ? -1 : leftSubject > rightSubject ? 1 : 0);
  };
  const holders = records().filter((item) => recordRawBytes(item) !== 0).sort(order);
  const current = new Map<T, T>(), modes = new Map<object, boolean>();
  let rest = total;
  for (const additionOnly of additionFirst ? [true, false] : [false])
    for (const original of holders) {
      if (rest <= budget) break;
      const before = current.get(original) ?? original, after = stripRecord(before, additionOnly);
      if (after === before) continue;
      rest += recordRawBytes(after) - recordRawBytes(before);
      current.set(original, after);
      modes.set(original, additionOnly);
    }
  return { modes, newly: new Set(holders.flatMap((item) => modes.has(item) && !dropped(item) ? [key(item)[1]] : [])),
    subjectOf: (record) => key(record)[1] };
}
// H39 の unreadableDropped の件数: 返す state（records は期限の回収・容量の退去・記憶への移しを終えた記録）に残った、この受信で新しく
// rawDropped にした記録の数。仮の state で外した後に拒否・退去・置き換え・回収で消えた記録は数えない（r1 ヘルツ P2-2: U-F の件数超過の
// 拒否で再送のたびに H39 が増えた。r2 ヘルツ P2: U-L で外した直後に期限切れの記憶へ移した記録を数えた）。
// ponytail: 予算を越えた受信だけ記録を 1 回なめる（予算の計画と同じ稀な処理）。
function droppedIn<T extends Marked>(plan: RawPlan<T> | null, records: readonly T[]): number {
  if (plan == null || plan.newly.size === 0) return 0;
  return records.reduce((sum, item) => dropped(item) && plan.newly.has(plan.subjectOf(item)) ? sum + 1 : sum, 0);
}
// 計画どおりに 1 つの記録の原文を外す（計画に無い記録はそのまま）。
function stripRaw<T extends Marked>(record: T, plan: Pick<RawPlan, "modes"> | null): T {
  const mode = plan?.modes.get(record);
  return mode == null ? record : stripRecord(record, mode);
}

// ---- codec（AC16 (3)(a)(c)） ----

type Fields = Readonly<Record<string, unknown>>;
const record = (value: unknown): Fields | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
const PART_KEYS = new Set(["site", "reason", "scope", "compare", "compareKeys", "raw"]);
const MARK_KEYS = new Set(["parts", "headline", "rawDropped", "partsCut"]);
const rawText = (value: unknown): value is string | null => value === null || typeof value === "string" && jsonBytes(value) <= RAW_BYTES;
function readPart(value: unknown, sites: ReadonlySet<string>): UnreadablePart | null {
  const row = record(value);
  if (row == null || Object.keys(row).some((key) => !PART_KEYS.has(key)) || typeof row.site !== "string" || !sites.has(row.site)
    || row.reason !== "requiredStructureMissing" && row.reason !== "requiredStructureInvalid" || !rawText(row.raw)) return null;
  const { scope, compare, compareKeys } = row;
  if (scope !== undefined && (typeof scope !== "string" || jsonBytes(scope) > SCOPE_BYTES)) return null;
  if (compare !== undefined && (typeof compare !== "string" || !HEX16.test(compare))) return null;
  if (compareKeys !== undefined && (!Array.isArray(compareKeys) || compareKeys.length > KEYS_LIMIT
    || !compareKeys.every((item): item is string => typeof item === "string" && HEX16.test(item)) || new Set(compareKeys).size !== compareKeys.length)) return null;
  return { site: row.site, reason: row.reason, ...typeof scope === "string" ? { scope } : {}, ...typeof compare === "string" ? { compare } : {},
    ...Array.isArray(compareKeys) ? { compareKeys: [...compareKeys] } : {}, raw: row.raw };
}
// 形の外は null（その記録と保存は invalid）。rawDropped・partsCut は履歴の旗で、raw や part の数との組み合わせは見ない（AC16 (3)(b)）。
function readUnreadableMark(value: unknown, sites: ReadonlySet<string>): UnreadableMark | null {
  const row = record(value);
  if (row == null || Object.keys(row).some((key) => !MARK_KEYS.has(key)) || !Array.isArray(row.parts) || row.parts.length > PART_LIMIT
    || !rawText(row.headline) || row.rawDropped !== undefined && row.rawDropped !== true || row.partsCut !== undefined && row.partsCut !== true) return null;
  const parts: UnreadablePart[] = [], seen = new Set<string>();
  for (const item of row.parts) {
    const part = readPart(item, sites);
    const key = part == null ? "" : part.scope == null ? part.site : `${part.site}\u0000${part.scope}`;
    if (part == null || seen.has(key)) return null;
    seen.add(key);
    parts.push(part);
  }
  return { parts, headline: row.headline, ...row.rawDropped === true ? { rawDropped: true } : {}, ...row.partsCut === true ? { partsCut: true } : {} };
}

// ---- view（AC10、P3-UM-D-VIEW） ----

const viewCache = new WeakMap<UnreadableMark, UnreadableMarkView>();
function markView(mark: UnreadableMark): UnreadableMarkView {
  let view = viewCache.get(mark);
  if (view == null) {
    const addition = mark.parts.some((part) => part.site === ADDITION_SITE && part.raw != null);
    view = { parts: mark.parts.filter((part) => part.site !== ADDITION_SITE).map((part) => ({ site: part.site,
      ...part.scope == null ? {} : { scope: part.scope }, raw: part.raw != null })), headline: mark.headline != null,
    ...addition ? { addition: true } : {}, ...mark.rawDropped === true ? { rawDropped: true } : {}, ...mark.partsCut === true ? { partsCut: true } : {} };
    viewCache.set(mark, view);
  }
  return view;
}

// ---- 器の式（AC03 (6)、P3-UM-RES-09。noticeMarkBytes と同じ作り） ----

// 印 1 件の上界（キーの ,"<key>": を含む JSON UTF-8）。原文は予算で数えるので raw と見出し文は null。listColumns は compareKeys を持つ part の数
// （一覧の欄の数、Q-UM-BYTES の (1)）。site は 32 文字で数える（各 unit の表の最長より長い）。
function unreadableMarkBytes(key: string, listColumns = 0): number {
  const part = (keys: boolean): UnreadablePart => ({ site: "s".repeat(32), reason: "requiredStructureMissing", scope: "s".repeat(SCOPE_BYTES - 2),
    compare: "0".repeat(16), ...keys ? { compareKeys: Array.from({ length: KEYS_LIMIT }, () => "0".repeat(16)) } : {}, raw: null });
  const longest: UnreadableMark = { parts: Array.from({ length: PART_LIMIT }, (_, index) => part(index < listColumns)), headline: null,
    rawDropped: true, partsCut: true };
  return encoder.encode(`,${JSON.stringify(key)}:${JSON.stringify(longest)}`).byteLength;
}
// P3-UM-AC11 (4)・Q-UM-BYTES の (3)（置き値）: envelope のカードの上界。カード 1 枚の固定の欄 3,438 byte×枚数＋原文の予算。
// U-Y だけ areas（1 枚 24,576 byte）を 8 枚分足す。カードの形と読み戻しは発注 3（Q-UM-PRECHECK の (7)(a)）。
const UNREADABLE_CARD_BYTES = 3_438;
const UNREADABLE_CARDS_MAX_BYTES = 8 * UNREADABLE_CARD_BYTES + 65_536;
const LOCAL_BULLETINS_CARDS_MAX_BYTES = 16 * UNREADABLE_CARD_BYTES + 131_072;
const TYPHOON_CARDS_MAX_BYTES = UNREADABLE_CARDS_MAX_BYTES + 8 * 24_576;

export {
  ADDITION_SITE, LOCAL_BULLETINS_CARDS_MAX_BYTES, RAW_BUDGET, TYPHOON_CARDS_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, WEATHER_TIMESERIES_RAW_BUDGET,
  droppedIn, fitRawBudget, fitScope, inheritMark, markRawBytes, markView, rawTotal, rawTotalBy, readUnreadableMark, recordRawBytes, rewriteXml, stripRaw,
  unreadableMarkBytes, unreadableNotes,
};
export type { RawPlan, Unreadable };
