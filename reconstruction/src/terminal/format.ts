import type { JsonValue, RuntimeUnitId, SubjectOutcome, UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { DmdataConnectFailure } from "../../contracts/p3-dmdata-connect.types";
import type { RecoveryDigestUnit, RecoveryDigestView } from "../../contracts/p3-recovery.types";
import type {
  TerminalBandLevel, TerminalHypocenter, TerminalReport, TerminalTsunamiArea, TerminalValue,
} from "../../contracts/p3-terminal-output.types";
import { BAND_ROLES, INTENSITY_ROLES, LG_ROLES, painter } from "./color";
import type { BandRoles, ColorLevel, Paint, Role } from "./color";

// P3-TO-AC03〜AC07 と P3-TL-AC01〜AC11: worker が書く文字を作る。見た目と文面の真実源は docs/specs/cli-terminal-output.md（§3〜§5）。
// main は材料を列に積むだけで、ここは worker（と試験）の中だけで動く（D-WRITER）。

// main が列に積む単位（AC02 (3)）。prompt は電文のブロックを書いた後に書き直す prompt と入力中の文字（readline が無ければ null）。
// line は数える出力（REPL の返事・起動の行）、echo は readline が書く echo と prompt（D-DROP で数えない）。
type TerminalUnit =
  | Readonly<{ kind: "report"; report: TerminalReport; prompt: string | null }>
  // nowMs は受信した時刻（wall の ms）。同時に進む EEW の 10 分の期限を電文の時刻でなく端末の時計で測る（P3-TL2-AC11）。
  | Readonly<{ kind: "eew"; subject: SubjectOutcome; prompt: string | null; nowMs: number }>
  | Readonly<{ kind: "line"; text: string }>
  | Readonly<{ kind: "echo"; text: string }>
  // 【発注 2】処理できなかった報（P3-TO-D-UNREADABLE）と、電文以外の出力（AC10〜AC14・AC17）。時刻は wall の ms で、worker が地方時の字にする。
  | Readonly<{ kind: "unreadable"; card: UnreadableCardView; prompt: string | null }>
  | Readonly<{ kind: "notice"; notice: TerminalNotice; prompt: string | null }>;
// 定期要約の数（AC11 (3)）。maxInt は地震の報の最大震度の字（無ければ null）。
type SummaryCounts = Readonly<{ eew: number; quake: number; maxInt: string | null; tsunami: number; nankai: number; volcano: number; weather: number }>;
type TerminalNotice =
  | Readonly<{ kind: "lost"; fromWallMs: number | null; noticedWallMs: number }>
  | Readonly<{ kind: "restored"; fromWallMs: number | null; toWallMs: number }>
  | Readonly<{ kind: "failure"; reason: DmdataConnectFailure }>
  | Readonly<{ kind: "summary"; fromWallMs: number; toWallMs: number; counts: SummaryCounts }>
  | Readonly<{ kind: "tip"; text: string }>
  | Readonly<{ kind: "update"; current: string; latest: string; packageName: string }>
  | Readonly<{ kind: "digest"; digest: RecoveryDigestView }>
  | Readonly<{ kind: "debug"; text: string }>
  // Q-TO8-BANNER（spec §6.7）: 起動の帯と、最初の接続の確立で 1 回の区分の行。missing は求めて start に無かった区分。
  | Readonly<{ kind: "banner"; appName: string; version: string }>
  | Readonly<{ kind: "session"; socketId: number; classifications: readonly string[]; missing: readonly string[]; testMode: string }>;
// worker への 1 回の送り。columns は送る時に読んだ端末の桁数（AC04 (1)）、dropped はその前に落とした単位の数（AC02 (3)）。
type TerminalBatch = Readonly<{ columns: number; dropped: number; units: readonly TerminalUnit[] }>;

// bold は要点の太字（役目の色の上に重ねる）。fixed は塗る帯の行（右端の空白を消さず、折らない）。
type Seg = Readonly<{ text: string; role: Role | null; bold: boolean }>;
type Line = Readonly<{ segs: readonly Seg[]; url?: true; fixed?: true }>;
// 1 つの出力の幅。total は線と帯の右端（P3-TL-AC02 (2)）、body は縦線の分を引いた本文の右端、bar は縦線を出すか、color は色を付けるか。
type Ctx = Readonly<{ total: number; body: number; bar: boolean; color: boolean }>;
// 電文のブロック: 帯の行（縦線の外）と、その下の行（縦線の中）。bar は縦線の役目。
type Rendered = Readonly<{ head: Line[]; body: Line[]; bar: Role }>;

const RULE_LIMIT = 100, BAR_MIN = 60, MEMORY_LIMIT = 64, RECAP_LINES = 20;

// ---- 幅（AC04 (2)） ----
// East Asian Width が W か F の範囲。罫線の ━ ─ は A なので 1 桁（spec の図の数え方と同じ）。
// shortcut: 表に無い字（結合文字・異体字セレクタ・表に無い絵文字）は 1 桁に数える。崩れる字が出たら範囲を足す。
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}
function width(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total;
}

const seg = (text: string, role: Role | null = null, bold = false): Seg => ({ text, role, bold });
const line = (...segs: Seg[]): Line => ({ segs });
const segsWidth = (segs: readonly Seg[]): number => segs.reduce((total, part) => total + width(part.text), 0);
const pad = (text: string, size: number): string => text + " ".repeat(Math.max(0, size - width(text)));

// 行頭に置かない字（P3-TL-AC09、P3-TL6-AC04 (1)）。次の行へ送る時は、行末の NO_HEAD の字の続きの全部とその前の 1 字をいっしょに送る。
const NO_HEAD = "、。，．）」』］】〉》)]！？ーぁぃぅぇぉっゃゅょァィゥェォッャュョ";
// 字の境目で折り返し、2 行目から indent で字下げする（電文の文・ほかの行の止め、AC04 (4)(5)）。
function wrapChars(segs: readonly Seg[], cols: number, indent: string): Seg[][] {
  const lead = width(indent) + 2 <= cols ? indent : "";
  const lines: Seg[][] = [];
  let current: Seg[] = [], used = 0;
  const append = (char: string, role: Role | null, bold: boolean) => {
    const last = current.at(-1);
    if (last != null && last.role === role && last.bold === bold) current[current.length - 1] = seg(last.text + char, role, bold);
    else current.push(seg(char, role, bold));
    used += charWidth(char);
  };
  // 行末の空白を捨て、NO_HEAD の字の続きの全部とその前の 1 字を取り出す（role と bold は字ごとに保つ）。
  // 送った後の行（字下げ・送る字・next）が cols に入らないとき、行の中身が lead だけになるときは取り出さない。
  // 無いと「…）。」で。の前に折るとき行頭に。が出る（続きの全部を送らないと、）だけ送って。が行頭に残る）。
  const popChars = (target: readonly Seg[], next: string): { rest: Seg[]; chars: Seg[] } | null => {
    const all = target.flatMap((part) => [...part.text].map((char) => seg(char, part.role, part.bold)));
    while (all.length > 0 && /[ 　]/.test(all.at(-1)!.text)) all.pop();
    let take = all.length;
    while (take > 0 && (NO_HEAD.includes(all[take - 1].text) || /[ 　]/.test(all[take - 1].text))) take -= 1;
    if (take > 0) take -= 1;
    const chars = all.slice(take), rest: Seg[] = [];
    for (const item of all.slice(0, take)) {
      const last = rest.at(-1);
      if (last != null && last.role === item.role && last.bold === item.bold) rest[rest.length - 1] = seg(last.text + item.text, item.role, item.bold);
      else rest.push(item);
    }
    return chars.length > 0 && segsWidth(rest) > width(lead) && width(lead) + segsWidth(chars) + charWidth(next) <= cols ? { rest, chars } : null;
  };
  for (const part of segs) for (const char of part.text) {
    const head = NO_HEAD.includes(char);
    if (used + charWidth(char) > cols && used > width(lead)) {
      const carry = head ? popChars(current, char) : null;
      if (carry != null) current = carry.rest;
      lines.push(current);
      current = lead === "" ? [] : [seg(lead)];
      used = width(lead);
      if (carry != null) for (const item of carry.chars) append(item.text, item.role, item.bold);
      else if (char === " " || char === "　") continue;
    } else if (head && lines.length > 0 && used === width(lead)) {
      // 空白で折って捨てた直後の句読点: 前の行の最後の字を送る。
      const carry = popChars(lines.at(-1)!, char);
      if (carry != null) { lines[lines.length - 1] = carry.rest; for (const item of carry.chars) append(item.text, item.role, item.bold); }
    }
    append(char, part.role, part.bold);
  }
  lines.push(current);
  return lines;
}

// 地域の一覧（AC04 (4)）: 全角の空白で区切って並べ、幅で折り返し、2 行目からは indent 桁の位置まで字下げする。
// cont は続きの行の頭（既定は空白 indent 桁。震度の一覧は段の字、満潮は「満潮」を続きの行にも出す、P3-TL2-AC06）。
function flow(prefix: readonly Seg[], items: readonly (readonly Seg[])[], cols: number, indent: number, cont: readonly Seg[] = [seg(" ".repeat(indent))]): Line[] {
  const lines: Line[] = [];
  let current: Seg[] = [...prefix], used = segsWidth(prefix), empty = true;
  for (const item of items) {
    const size = segsWidth(item);
    if (!empty && used + 2 + size > cols) {
      lines.push({ segs: current });
      current = [...cont];
      used = segsWidth(cont);
      empty = true;
    }
    if (!empty) { current.push(seg("　")); used += 2; }
    if (used + size > cols) {
      // 1 つの名前が残りの幅より長いときだけ、名前の中で折る。
      const parts = wrapChars([...current, ...item], cols, " ".repeat(indent));
      for (const part of parts.slice(0, -1)) lines.push({ segs: part });
      current = parts.at(-1)!;
      used = segsWidth(current);
    } else {
      current.push(...item);
      used += size;
    }
    empty = false;
  }
  lines.push({ segs: current });
  return lines;
}

// ---- 表（AC02 (4)(5)） ----
type Column = Readonly<{ header: string; min: number; short?: string }>;
type Cell = Seg | null;
// 行の表。全部の行が空の列は出さない。入る形を、図の列幅 → 短い見出しで値に合わせた列幅 → 列の間 1 桁 → 地域の行と値の行の 2 行、の順に探す。
// 地域名などの中身は詰めない。
function rowTable(allColumns: readonly Column[], allRows: readonly (readonly Cell[])[], allRegion: number, cols: number): Line[] {
  const keep = allColumns.map((_, index) => index === allRegion || allRows.some((row) => row[index] != null && row[index]!.text !== ""));
  const columns = allColumns.filter((_, index) => keep[index]), rows = allRows.map((row) => row.filter((_, index) => keep[index]));
  const region = keep.slice(0, allRegion).filter(Boolean).length, last = columns.length - 1;
  const cellWidth = (row: readonly Cell[], index: number) => row[index] == null ? 0 : width(row[index]!.text);
  const plan = (compact: boolean, gap: number) => {
    const headers = columns.map((column) => compact ? column.short ?? column.header : column.header);
    const sizes = columns.map((column, index) => index === last
      ? Math.max(width(headers[index]), ...rows.map((row) => cellWidth(row, index)))
      : Math.max(compact ? 0 : column.min, width(headers[index]) + gap, ...rows.map((row) => cellWidth(row, index) + gap)));
    return { headers, sizes, total: sizes.reduce((sum, size) => sum + size, 0) };
  };
  const chosen = [plan(false, 2), plan(true, 2), plan(true, 1)].find((item) => item.total <= cols);
  if (chosen == null) {
    const pair = (cells: readonly Cell[]): Line[] => {
      const rest = cells.filter((cell, index): cell is Seg => index !== region && cell != null && cell.text !== "");
      const first = line(cells[region] ?? seg(""));
      return rest.length === 0 ? [first] : [first, line(seg("  "), ...rest.flatMap((cell, index) => index === 0 ? [cell] : [seg("  "), cell]))];
    };
    return [...pair(columns.map((column) => seg(column.header, "dim"))), ...rows.flatMap(pair)];
  }
  const render = (cells: readonly Cell[]): Line => line(...cells.flatMap((cell, index) => {
    const text = cell == null ? "" : cell.text;
    return index === last ? [seg(text, cell?.role ?? null)] : [seg(text, cell?.role ?? null), seg(" ".repeat(Math.max(0, chosen.sizes[index] - width(text))))];
  }));
  return [render(chosen.headers.map((header) => seg(header, "dim"))), ...rows.map(render)];
}

// 段ごとに地域を 1 行にまとめる表（地震の震度・長周期階級）。2 行目からは段の欄の幅で字下げする。
function listTable(headers: readonly [string, string] | null, rows: readonly Readonly<{ label: Seg; rest?: Seg; items: readonly (readonly Seg[])[] }>[],
  min: number, cols: number): Line[] {
  const size = Math.max(min, headers == null ? 0 : width(headers[0]) + 2, ...rows.map((row) => width(row.label.text) + 2));
  return [...headers == null ? [] : [line(seg(pad(headers[0], size) + headers[1], "dim"))],
    ...rows.flatMap((row) => {
      const gap = seg(" ".repeat(size - width(row.label.text))), lead = [row.label, gap];
      return flow(lead, row.items, cols, size, row.rest == null ? lead : [row.rest, gap]);
    })];
}

// ---- 共通の行 ----
const clockOf = (raw: string | null | undefined): string | null => /T(\d{2}:\d{2}:\d{2})/.exec(raw ?? "")?.[1] ?? null;
const minuteOf = (raw: string | null | undefined): string | null => /T(\d{2}:\d{2})/.exec(raw ?? "")?.[1] ?? null;
const nfkc = (text: string): string => text.normalize("NFKC").trim();

// 帯（spec §5.0）。roles.fill の段は、色のあるとき幅いっぱいに地の色で塗る（時刻も帯の字）。入らなければ「発表」を落とし、それでも入らなければ時刻を次の行。
// 塗らない帯は「━ 題名 ━━ 時刻 発表 ━」で、時刻が同じ行に入らなければ次の行（NARROW_BELOW の一律の形はやめた、P3-TL-AC02 (3)）。
// label は時刻の後ろの字（回線の帯は時刻だけ、処理できなかった報で発表時刻が無ければ「受信」）。
function band(title: string, roles: BandRoles, time: string | null, ctx: Ctx, label = "発表"): Line[] {
  const total = ctx.total, size = width(title), stamp = time == null ? "" : label === "" ? time : `${time} ${label}`;
  if (roles.fill && ctx.color) {
    // 幅に入らないほど狭い端末では右端を揃えられないので、固定にせず折る。
    const filled = (left: string, right: string): Line => {
      const text = ` ${left}${" ".repeat(Math.max(right === "" ? 0 : 1, total - width(left) - width(right) - 2))}${right} `;
      return width(text) <= total ? { fixed: true, segs: [seg(text, roles.band)] } : { segs: [seg(text, roles.band)] };
    };
    const timeLine = stamp === "" ? [] : [filled("", stamp)];
    if (size + 2 > total) return [...wrapChars([seg(title)], total - 2, "").map((part) => filled(part.map((item) => item.text).join(""), "")), ...timeLine];
    const pick = [stamp, time ?? ""].find((item) => item !== "" && size + 1 + width(item) + 2 <= total);
    return pick == null ? [filled(title, ""), ...timeLine] : [filled(title, pick)];
  }
  const timeLine = time == null ? [] : [line(seg(stamp, "dim"))];
  if (size + 4 > total) return [...wrapChars([seg(title, roles.band)], total, "").map((segs) => ({ segs })), line(seg("━".repeat(total), roles.rule)), ...timeLine];
  const fill = total - size - 6 - width(stamp);
  if (time != null && fill >= 1) {
    return [line(seg("━ ", roles.rule), seg(title, roles.band), seg(` ${"━".repeat(fill)} `, roles.rule), seg(stamp, "dim"), seg(" ━", roles.rule))];
  }
  return [line(seg("━ ", roles.rule), seg(title, roles.band), seg(` ${"━".repeat(total - size - 3)}`, roles.rule)), ...timeLine];
}
// 区切りの罫線は本文の右端ではなく帯の右端まで引く（縦線の 2 桁の分を本文から引いてあるので、本文の幅で引けば帯の右端に揃う）。
const separator = (ctx: Ctx): Line => line(seg("─".repeat(ctx.body), "dim"));
const footer = (headType: string, eventId: string | null): Line => line(seg(eventId == null || eventId === "" ? headType : `${headType} ・ ID ${eventId}`, "dim"));
// 電文の文（見出し文・本文の引用）: 改行ごとの段落を、1 行に入ればそのまま、入らなければ句点で分ける。それでも入らない文は書き出す時に字の境目で折る（AC09）。
const textLines = (text: string | null, room: number, bold = false): Line[] => text == null ? [] : text.split(/\n+/).map((part) => part.trim()).filter((part) => part !== "")
  .flatMap((part) => width(part) <= room ? [part] : part.split(/(?<=。)/).map((piece) => piece.trim()).filter((piece) => piece !== "")).map((part) => line(seg(part, null, bold)));
// P3-TO-D-STATUS-MARK（作者裁定 A）: 通常でない報は帯の題名の後ろに印を付ける。
const statusMark = (status: string | null): string => status === "訓練" ? "（訓練）" : status === "試験" ? "（試験）" : "";
// 再掲の時刻の括弧（P3-TL-AC08）。訓練と試験の報は印を足す。
const recapStamp = (time: string | null, status: string | null): string =>
  time == null ? "" : `（${time} 発表${status === "訓練" || status === "試験" ? `・${status}` : ""}）`;
// 項目を「 ・ 」でつないだ行（震源の行）。入らなければ「 ・ 」の境で折り、折り目の「 ・ 」は出さず続きの行を 2 字下げる（P3-TL2-AC06 (1)）。
// 1 項目が幅を超えるときはその項目だけの行になり、書き出す時に字の境目で折る。
const SEP_WIDTH = width(" ・ ");
function joined(items: readonly (readonly Seg[])[], cols: number): Line[] {
  const lines: Line[] = [];
  let current: Seg[] = [], used = 0, fresh = true;
  for (const item of items) {
    const size = segsWidth(item);
    if (!fresh && used + SEP_WIDTH + size > cols) { lines.push({ segs: current }); current = [seg("  ")]; used = 2; fresh = true; }
    if (!fresh) { current.push(seg(" ・ ")); used += SEP_WIDTH; }
    current.push(...item);
    used += size;
    fresh = false;
  }
  lines.push({ segs: current });
  return lines;
}
// 最後の行に時刻の括弧を足す（再掲）。
const stampLast = (lines: readonly Line[], stamp: string): Line[] =>
  lines.map((item, index) => index === lines.length - 1 && stamp !== "" ? { ...item, segs: [...item.segs, seg(stamp, "dim")] } : item);
// 震度 7 の塗りは色を付けるときだけ前後に空白を足して 3 桁にする（P3-TL2-AC02 (5)、6 強と同じ幅）。比べる字は変えず、描く字だけ変える。
const solid = (label: string, ctx: Ctx): string => ctx.color && label === "7" ? " 7 " : label;
// 要点の行に並べる地域: 入る分だけ並べ、残りは「ほか n 地域」（P3-TL-AC01）。1 つ目は入らなくても出す（折り返しは書き出す時に行う）。
function fitAreas(names: readonly string[], room: number): { text: string; all: boolean } {
  let shown = "", count = 0;
  for (const name of names) {
    const next = shown === "" ? name : `${shown}　${name}`, left = names.length - count - 1;
    if (width(next) + (left > 0 ? width(`　ほか ${left} 地域`) : 0) > room && count > 0) break;
    shown = next;
    count += 1;
  }
  return count === names.length ? { text: shown, all: true } : { text: `${shown}　ほか ${names.length - count} 地域`, all: false };
}
// 要点の最大の行（太字）。was は前の報の値（薄い字の「旧 →」）、suffix は再掲の時刻の括弧。
const topRoom = (label: string, value: string, was: string | null, ctx: Ctx, suffix: readonly Seg[]): number =>
  ctx.body - width(`${label}${was == null ? "" : `${was} →  `}${solid(value, ctx)}  `) - segsWidth(suffix);
function maxLine(label: string, value: string, was: string | null, names: readonly string[], ctx: Ctx, suffix: readonly Seg[] = []): Line {
  const room = topRoom(label, value, was, ctx, suffix);
  return line(seg(label, null, true), ...was == null ? [] : [seg(`${was} →  `, "dim")], seg(solid(value, ctx), intensityRole(value), true),
    ...names.length === 0 ? [] : [seg("  ", null, true), seg(fitAreas(names, room).text, null, true)], ...suffix);
}

// ---- 組み立て（spec §5.0、P3-TL-AC01・AC08） ----
type Parts = Readonly<{ summary: Line[]; tables: Line[][]; supplement: Line[]; tail: Line; recap: Line[] }>;
// 書き出す時の 1 行（折り返しの後）。塗る帯と URL は折らない。
function physical(item: Line, room: number): Seg[][] {
  if (item.fixed === true) return [[...item.segs]];
  const segs = trimEnd(item.segs);
  return item.url === true || segsWidth(segs) <= room ? [segs] : wrapChars(segs, room, "  ").map(trimEnd);
}
// 要点・表・補足の間に区切りの罫線を 1 本ずつ引き、表の直後は次が末尾の行でも 1 本引く。表も補足も無い報は引かない。
// 帯から末尾の行までが折り返しの後で RECAP_LINES 行以上のとき、要点の再掲を補足の最後（末尾の行の上）に足す。無いと流れ終わった後の画面に危険が残らない。
function compose(head: Line[], roles: BandRoles, parts: Parts, ctx: Ctx): Rendered {
  const tables = parts.tables.filter((table) => table.length > 0);
  const build = (extra: readonly Line[]): Line[] => {
    const supplement = [...parts.supplement, ...extra];
    const groups = [parts.summary, ...tables, supplement].filter((group) => group.length > 0);
    return [...groups.flatMap((group, index) => index === 0 ? group : [separator(ctx), ...group]),
      ...tables.length > 0 && supplement.length === 0 ? [separator(ctx)] : [], parts.tail];
  };
  const plain = build([]);
  const shown = head.flatMap((item) => physical(item, ctx.total)).length + plain.flatMap((item) => physical(item, ctx.body)).length;
  return { head, bar: roles.bar, body: parts.recap.length > 0 && shown >= RECAP_LINES ? build(parts.recap) : plain };
}

// ---- 特殊値（AC05 (5)・AC06 (3)、O02） ----
const INTENSITY_ORDER = ["1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
const intensityLabel = (raw: string): string => {
  const text = nfkc(raw);
  return { "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強" }[text] ?? text;
};
// 先頭の震度の段（「5弱以上未入電」は 5 弱）。段が読めなければ -1。
const intensityRank = (label: string): number => INTENSITY_ORDER.indexOf(/^[1-7][弱強]?/.exec(label)?.[0] ?? "");
// 合成の字（7程度以上、6強〜7）は 7 の役目、7 を含まない合成（6強程度以上）は先頭の段の役目（3 桁の詰めは solid が字ちょうど 7 のときだけ）。
const intensityRole = (label: string): Role | null =>
  INTENSITY_ROLES[label] ?? (label.includes("7") ? INTENSITY_ROLES["7"] : INTENSITY_ROLES[/^[1-7][弱強]?/.exec(label)?.[0] ?? ""] ?? null);
const lgRole = (label: string): Role | null => LG_ROLES[label] ?? null;

function magnitudeText(value: TerminalValue | null): string {
  if (value == null) return "M不明";
  const number = Number(value.raw);
  if (value.raw.trim() !== "" && Number.isFinite(number)) return `M${number.toFixed(1)}`;
  const description = value.description == null ? "" : nfkc(value.description);
  return description === "" ? "M不明" : description;
}
// 深さは description の特殊値（ごく浅い・700km以上など）を先に見て、無ければ座標の 3 つ目（m）を km にする。
function depthText(value: TerminalValue | null): string {
  if (value == null) return "不明";
  const description = value.description == null ? "" : nfkc(value.description);
  if (/ごく浅い$/.test(description)) return "ごく浅い";
  const bound = /([0-9.]+)\s*km\s*(以上|超|以下|未満)$/.exec(description);
  if (bound != null) return `${bound[1]}km${bound[2]}`;
  const depth = /^[+-][0-9.]+[+-][0-9.]+([+-][0-9.]+)\/$/.exec(value.raw.trim());
  if (depth == null) return "不明";
  const km = Math.abs(Number(depth[1])) / 1000;
  return km === 0 ? "ごく浅い" : `${km}km`;
}
function hypocenterLines(hypocenter: TerminalHypocenter, ctx: Ctx, extra: readonly (readonly Seg[])[] = [], depth = true): Line[] {
  return joined([[seg(`震源: ${hypocenter.name ?? "不明"}`)], [seg(magnitudeText(hypocenter.magnitude))],
    ...depth ? [[seg(`深さ${depthText(hypocenter.coordinate)}`)]] : [], ...extra], ctx.body);
}

// ---- 地震（AC06） ----
// H08: 最大震度 5 弱以上か長周期地震動階級 2 以上は warning、4 は caution（通知の音の段と同じ境目）。
// 「5弱以上未入電」（値の字か、値が空で condition の字）は 5 弱に当てる（危ない側）。
function seismicLevel(report: Extract<TerminalReport, { kind: "seismic" }>): TerminalBandLevel {
  if (report.head.infoType === "取消") return "cancel";
  const observed = report.maxInt == null || report.maxInt === "" ? report.maxIntCondition : report.maxInt;
  const rank = intensityRank(observed == null ? "" : intensityLabel(observed));
  const lg = Number(nfkc(report.maxLgInt ?? ""));
  if (rank === INTENSITY_ORDER.indexOf("7")) return "top";
  if (rank >= INTENSITY_ORDER.indexOf("5弱") || lg >= 2) return "warning";
  return rank === INTENSITY_ORDER.indexOf("4") ? "caution" : "plain";
}
// 区域の段の値（AC06 (3)）: 値が文字ならその字、値が空なら condition の字、要素も condition も無ければ「不明」。区域の行は落とさない。
const areaIntensity = (maxInt: string | null, condition: string | null): string =>
  maxInt != null && maxInt !== "" ? intensityLabel(maxInt) : condition ?? "不明";
// 段ごとにまとめる。段は重い順、段の読めない字（未入電など）は先頭、段の中は電文の順。
function grouped<T>(items: readonly T[], label: (item: T) => string): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = label(item);
    const group = groups.get(key);
    if (group == null) groups.set(key, [item]); else group.push(item);
  }
  const rank = (key: string) => INTENSITY_ORDER.includes(key) ? INTENSITY_ORDER.indexOf(key) : /^[0-9]+$/.test(key) ? Number(key) : 99;
  return [...groups].map(([key, list]) => ({ label: key, items: list })).sort((left, right) => rank(right.label) - rank(left.label));
}
const omittedLine = (omitted: number): Line[] => omitted === 0 ? [] : [line(seg(`ほか ${omitted} 件`, "dim"))];

function seismic(report: Extract<TerminalReport, { kind: "seismic" }>, ctx: Ctx): Rendered {
  const { head } = report, cancel = head.infoType === "取消", level = seismicLevel(report), roles = BAND_ROLES[level];
  const title = `${head.controlTitle ?? head.title ?? head.headType}${statusMark(head.status)}${cancel ? " 取消" : ""}`;
  const time = clockOf(head.reportDateTimeRaw), bandLines = band(title, roles, time, ctx), tail = footer(head.headType, head.eventId);
  if (cancel) {
    const summary = [...textLines(head.headline, ctx.body), ...head.headline == null || head.headline === "" ? textLines(report.text, ctx.body) : []];
    return compose(bandLines, roles, { summary, tables: [], supplement: [], tail, recap: [] }, ctx);
  }
  const longPeriod = head.headType === "VXSE62";
  const max = report.maxInt == null && report.maxIntCondition == null ? null : areaIntensity(report.maxInt, report.maxIntCondition);
  const maxLg = report.maxLgInt == null ? null : nfkc(report.maxLgInt);
  const groups = grouped(report.areas, (area) => areaIntensity(area.maxInt, area.maxIntCondition));
  const tops = longPeriod || max == null ? [] : groups.find((group) => group.label === max)?.items.map((area) => area.name) ?? [];
  const stamp = recapStamp(time, head.status);
  // 最大の行（P3-TL-AC06 (1)）。長周期地震動の観測情報は階級の行で、地域を添えない。
  const lead = (suffix: readonly Seg[]): Line[] => longPeriod && maxLg != null
    ? [line(seg("最大長周期階級 ", null, true), seg(maxLg, lgRole(maxLg), true), ...max == null ? [] : [seg(" ・ 最大震度 ", null, true), seg(solid(max, ctx), intensityRole(max), true)], ...suffix)]
    : max != null ? [maxLine("最大震度 ", max, null, tops, ctx, suffix)] : [];
  // 発生の時刻（Q-TO2-ORIGIN）。発表の日と違う日は日を添える。
  const origin = arrivalText(report.originDateTimeRaw, head.reportDateTimeRaw);
  const originItems = origin == null ? [] : [[seg(`発生 ${origin}ころ`)]];
  // 震源の要素が無い報は「震源: 調査中」と書かず、発生の時刻だけの行にする（P3-TL2-AC03 (3)）。
  const hypocenter = report.hypocenter == null ? origin == null ? [] : joined(originItems, ctx.body) : hypocenterLines(report.hypocenter, ctx, originItems);
  const comment = textLines(report.forecastComment, ctx.body);
  const first = lead([]);
  const summary = first.length > 0 ? [...first, ...comment, ...hypocenter] : [...hypocenter, ...comment];
  // 震度が 1 段だけで、要点の行に全部の地域が入る報は表を出さない（VXSE62 は除く）。
  const covered = tops.length > 0 && tops.length === report.areas.length && report.omitted === 0 && max != null && fitAreas(tops, topRoom("最大震度 ", max, null, ctx, [])).all;
  const tables: Line[][] = [];
  if (report.areas.length > 0 && !covered) {
    const rows = longPeriod
      ? grouped(report.areas, (area) => area.maxLgInt == null || area.maxLgInt === "" ? "不明" : nfkc(area.maxLgInt)).map((group) => ({
        label: seg(`階級${group.label}`, lgRole(group.label)),
        // 階級の中は名前順（旧築 lg-observation-formatter.ts の buildLgAreaRows と同じ localeCompare の ja、spec §5.2 の図の並び）。
        items: [...group.items].sort((left, right) => left.name.localeCompare(right.name, "ja"))
          .map((area) => [seg(`${area.name}（震度${areaIntensity(area.maxInt, area.maxIntCondition)}）`)]) }))
      : groups.map((group) => ({ label: seg(solid(group.label, ctx), intensityRole(group.label)), items: group.items.map((area) => [seg(area.name)]) }));
    tables.push([...listTable(longPeriod ? ["長周期階級", "地域"] : ["震度", "地域"], rows, longPeriod ? 12 : 8, ctx.body), ...omittedLine(report.omitted)]);
  }
  // 見出し文は定型の文なので表の下（Q-TO2-LAYOUT）。Q-TO-Q-5: 気象庁ホームページへのリンクである旨を明示する 1 行と、折らない URI。
  const supplement = [...textLines(head.headline, ctx.body),
    ...longPeriod && report.uri != null ? [line(seg("長周期地震動についての詳しい情報は、以下のURL（気象庁ホームページ）からご確認ください")), { segs: [seg(report.uri)], url: true as const }] : []];
  const recap = stamp === "" || first.length === 0 ? [] : [...lead([seg(stamp, "dim")]), ...longPeriod ? [] : comment];
  return compose(bandLines, roles, { summary, tables, supplement, tail, recap }, ctx);
}

// ---- 津波（AC07） ----
const kindOf = (area: TerminalTsunamiArea): string => (area.kindName ?? "").split("：")[0];
// 区分の重さ（P3-TL2-AC09）。解除と津波予報、前の報に無い地域は 0。
const kindRank = (kind: string): number => kind.includes("解除") ? 0 : kind.includes("大津波警報") ? 3 : kind.startsWith("津波警報") ? 2 : kind.startsWith("津波注意報") ? 1 : 0;
const TSUNAMI_KINDS = [["大津波警報", 3], ["津波警報", 2], ["津波注意報", 1]] as const;
// 文ごとの行（VTSE51 の行動の文、複数の文は文ごと、P3-TL2-AC04 (3)）。
const sentenceLines = (text: string | null): Line[] => text == null ? [] : text.split(/\n+/).flatMap((part) => part.split(/(?<=。)/))
  .map((piece) => piece.trim()).filter((piece) => piece !== "").map((piece) => line(seg(piece, null, true)));
function tsunamiLevel(report: Extract<TerminalReport, { kind: "tsunami" }>): TerminalBandLevel {
  if (report.head.infoType === "取消") return "cancel";
  const kinds = report.areas.map(kindOf).filter((kind) => !kind.includes("解除"));
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "top";
  if (kinds.some((kind) => kind.startsWith("津波警報"))) return "warning";
  return kinds.some((kind) => kind.startsWith("津波注意報")) ? "caution" : "plain";
}
// 高さは description の字（全角を半角に）を先に、無ければ値に m を付ける。
function heightText(value: TerminalValue | null): string | null {
  if (value == null) return null;
  if (value.description != null && value.description !== "") return nfkc(value.description);
  // 数値の無い区域（津波注意報の condition「不明」など）は欄を空ける（spec §5.3、旧築の「―」は出さない）。
  return Number.isFinite(Number(value.raw)) && value.raw.trim() !== "" ? `${nfkc(value.raw)}m` : null;
}
// Q-TO-T-2: 時と分。発表の日と違う日だけ日を添える。
function arrivalText(raw: string | null, reportRaw: string | null): string | null {
  const minute = minuteOf(raw);
  if (raw == null || minute == null) return null;
  return reportRaw != null && raw.slice(0, 10) !== reportRaw.slice(0, 10) ? `${Number(raw.slice(8, 10))}日 ${minute}` : minute;
}
// 区分の名前は全部の地域の行に出す（Q-TO2-T）。沿岸で推定される津波（Estimation）は区分を持たないので区分の列を外す。
// 時刻の無い到達の文（第１波の到達を確認など）は警報の色の字にする（P3-TL-AC07 (3)）。
function forecastTable(areas: readonly TerminalTsunamiArea[], reportRaw: string | null, cols: number, kinds: boolean): Line[] {
  const rows = areas.map((area): Cell[] => {
    const kind = kindOf(area);
    const height = heightText(area.height), arrival = arrivalText(area.arrivalTimeRaw, reportRaw) ?? area.arrivalCondition;
    return [...kinds ? [seg(kind, kind.includes("大津波警報") ? "rulePurple" : kind.startsWith("津波警報") ? "ruleWarning" : "ruleCaution")] : [],
      seg(area.name), height == null ? null : seg(height), arrival == null ? null : seg(arrival, area.arrivalTimeRaw == null ? "arrived" : null)];
  });
  const columns: Column[] = [{ header: "地域", min: 22 }, { header: "予想される高さ", short: "予想", min: 16 }, { header: "到達予想時刻", short: "到達", min: 0 }];
  return kinds ? rowTable([{ header: "区分", min: 12 }, ...columns], rows, 1, cols) : rowTable(columns, rows, 0, cols);
}

function tsunami(report: Extract<TerminalReport, { kind: "tsunami" }>, memory: Memory, ctx: Ctx): Rendered {
  const { head } = report, cancel = head.infoType === "取消", reportRaw = head.reportDateTimeRaw, level = tsunamiLevel(report), roles = BAND_ROLES[level];
  // 帯の題名: 大津波警報・津波警報…（VTSE41）は段を名前に持つ Head/Title、ほかは Control/Title（末尾の「a」は電文の版の印なので外す）。
  const base = head.headType === "VTSE41" ? head.title ?? head.controlTitle : head.controlTitle?.replace(/a$/, "") ?? head.title;
  const title = `${base ?? head.headType}${statusMark(head.status)}${cancel ? " 取消" : ""}`;
  const time = clockOf(reportRaw), bandLines = band(title, roles, time, ctx), tail = footer(head.headType, head.eventId);
  // 区分の覚えは同じ運用区分・EventID の前の VTSE41 だけ（P3-TL2-AC09）。取消で消す。
  const followKey = head.eventId == null ? null : `${head.status}/${head.eventId}`;
  if (cancel) {
    if (head.headType === "VTSE41" && followKey != null) memory.tsunami.delete(followKey);
    return compose(bandLines, roles, { summary: textLines(head.headline, ctx.body), tables: [], supplement: [], tail, recap: [] }, ctx);
  }
  // 要点（P3-TL-AC07 (2)）: 「＊＊＊これは訓練です＊＊＊」、「避難」を含む文（太字）、区分ごとの地域数（太字）、残りの見出し文、震源。電文の文は言い換えない。
  const said = (head.headline ?? "").split(/\n+/).map((part) => part.trim()).filter((part) => part !== "");
  const notes = said.filter((part) => part.startsWith("＊")), acts = said.filter((part) => !part.startsWith("＊") && part.includes("避難"));
  const rest = said.filter((part) => !part.startsWith("＊") && !part.includes("避難"));
  const counts = TSUNAMI_KINDS.flatMap(([kind]) => {
    const names = report.areas.filter((area) => kindOf(area) === kind).map((area) => area.name);
    return names.length === 0 ? [] : [{ kind, names }];
  });
  // 区分の行（Q-TO3-RECAP）: 最も重い区分は地域数と地域名、残りの区分は数だけを次の行に出す。suffix は最後の行の時刻の括弧。
  const countLines = (suffix: readonly Seg[]): Line[] => {
    if (counts.length === 0) return [];
    const [top, ...others] = counts, label = `${top.kind} ${top.names.length}地域`;
    const names = fitAreas(top.names, ctx.body - width(`${label}  `) - (others.length === 0 ? segsWidth(suffix) : 0));
    return [line(seg(label, null, true), seg("  ", null, true), seg(names.text, null, true), ...others.length === 0 ? suffix : []),
      ...others.length === 0 ? [] : [line(seg(others.map((item) => `${item.kind} ${item.names.length}地域`).join(" ・ "), null, true), ...suffix)]];
  };
  // 前の VTSE41 より区分が上がった地域（VTSE41 だけ、覚えの無い報には出さない）。
  const before = head.headType === "VTSE41" && followKey != null ? memory.tsunami.get(followKey) : undefined;
  const raised = before == null ? [] : TSUNAMI_KINDS.flatMap(([kind, level]) => {
    const names = report.areas.filter((area) => kindRank(kindOf(area)) === level && (before.get(area.name) ?? 0) < level).map((area) => area.name);
    return names.length === 0 ? [] : [line(seg(`${kind}に引き上げ  ${fitAreas(names, ctx.body - width(`${kind}に引き上げ  `)).text}`))];
  });
  if (head.headType === "VTSE41" && followKey != null) remember(memory.tsunami, followKey, new Map(report.areas.map((area) => [area.name, kindRank(kindOf(area))])));
  // 深さは沖合の情報（VTSE52）だけ出す（spec §5.3 の図のとおり、作者裁定。VTSE41・VTSE51 の図は M までで止める）。
  const summary = [...notes.map((part) => line(seg(part))), ...acts.flatMap((part) => textLines(part, ctx.body, true)),
    ...countLines([]), ...raised, ...rest.flatMap((part) => textLines(part, ctx.body)),
    ...report.hypocenter == null ? [] : hypocenterLines(report.hypocenter, ctx, [], head.headType === "VTSE52")];
  const tables: Line[][] = [];
  const forecast = report.areas.filter((area) => kindOf(area) !== "津波なし" && !kindOf(area).startsWith("津波予報"));
  const slight = report.areas.filter((area) => kindOf(area).startsWith("津波予報"));
  if (forecast.length > 0) tables.push(forecastTable(forecast, reportRaw, ctx.body, true));
  if (slight.length > 0) {
    // 津波予報の地域の字下げは 60 桁未満で 2 桁、ほかは 12 桁（P3-TL-AC02 (7)）。
    const indent = ctx.total < BAR_MIN ? 2 : 12;
    tables.push([line(seg(kindOf(slight[0]), "slightForecast")), ...flow([seg(" ".repeat(indent))], slight.map((area) => [seg(area.name)]), ctx.body, indent)]);
  }
  const tides = report.areas.filter((area) => area.stations.length > 0);
  if (tides.length > 0) {
    const size = Math.max(22, ...tides.map((area) => width(area.name) + 2));
    // 各行（折り返した行も）の観測点の前に「満潮」を付ける（P3-TL2-AC06 (3)）。見出しが流れると到達の時刻と読み違えるため。満潮の字は全部薄い字（Q-TO5-TIDE-ROW）。
    const tide = seg("満潮 ", "dim");
    tables.push([line(seg("満潮時刻")), ...tides.flatMap((area) => {
      const items = area.stations.map((station) => [seg(`${station.name} ${minuteOf(station.highTideDateTimeRaw) ?? ""}`.trimEnd())]);
      // 観測点の 1 組が地域の欄の後ろに入らないときだけ、地域の行と観測点の行に分ける。
      return items.some((item) => size + segsWidth([tide]) + segsWidth(item) > ctx.body) ? [line(seg(area.name)), ...flow([seg("  "), tide], items, ctx.body, 2, [seg("  "), tide])]
        : flow([seg(pad(area.name, size)), tide], items, ctx.body, size, [seg(" ".repeat(size)), tide]);
    })]);
  }
  if (report.stations.length > 0) {
    // VTSE52 は沖合の観測点の表だけ。観測の機器の種類は出さない（Q-TO-T-4）。最大波の高さはどの形でも値の行に残す（監査 A1）。
    const offshore = head.headType === "VTSE52";
    const rows = report.stations.map((station): Cell[] => {
      const firstWave = station.arrivalTimeRaw == null ? station.arrivalCondition : `${minuteOf(station.arrivalTimeRaw) ?? ""}${station.initial == null ? "" : ` ${station.initial}`}`;
      const height = heightText(station.maxHeight), at = minuteOf(station.maxHeightDateTimeRaw);
      const max = height == null ? station.maxHeightCondition
        : `${height}${station.maxHeight?.condition == null ? "" : ` ${station.maxHeight.condition}`}${at == null ? "" : `（${at}）`}`;
      return [seg(station.name), firstWave == null ? null : seg(firstWave), max == null ? null : seg(max, height == null ? null : "strong")];
    });
    tables.push([...offshore ? [] : [line(seg("観測した津波"))],
      ...rowTable([{ header: offshore ? "沖合の観測点" : "観測点", min: 14 }, { header: "第1波", min: 15 }, { header: "これまでの最大波", min: 0 }], rows, 0, ctx.body)]);
  }
  if (report.estimations.length > 0) tables.push([line(seg("沿岸で推定される津波")), ...forecastTable(report.estimations, reportRaw, ctx.body, false)]);
  if (report.omitted > 0) tables.push(omittedLine(report.omitted));
  // 固定付加文は沖合の情報（VTSE52、今のまま）と、VTSE51 の太字（流れ終わった画面に残す、Q-TO3-ACTION）。VTSE41 は見出し文の繰り返しなので出さない。
  const supplement = head.headType === "VTSE52" ? textLines(report.warningComment, ctx.body) : head.headType === "VTSE51" ? sentenceLines(report.warningComment) : [];
  // 再掲: 区分の 2 行と「避難」の文。「避難」の文が無ければ最後の区分の行に時刻（地域数の無い報には出さない）。
  const stamp = recapStamp(time, head.status);
  const recap = counts.length === 0 || stamp === "" ? [] : [...countLines(acts.length === 0 ? [seg(stamp, "dim")] : []),
    ...acts.map((part, index) => line(seg(part, null, true), ...index === acts.length - 1 ? [seg(stamp, "dim")] : []))];
  return compose(bandLines, roles, { summary, tables, supplement, tail, recap }, ctx);
}

// ---- 緊急地震速報（AC05） ----
// facts は U-E の outcome（P3-EEW-FACTS-001）。worker へは structured clone で届くので、使う欄だけを確かめて組み立てる。
type Json = JsonValue | undefined;
// Array.isArray は readonly の配列を絞らないので、型の述語で包む。
const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);
const record = (value: Json): Readonly<{ [key: string]: JsonValue }> | null =>
  value == null || typeof value !== "object" || isList(value) ? null : value;
const string = (value: Json): string | null => typeof value === "string" ? value : null;
const list = (value: Json): readonly JsonValue[] => value != null && isList(value) ? value : [];
const rawValue = (value: Json): TerminalValue | null => {
  const item = record(value), raw = string(item?.raw);
  return item == null || raw == null ? null : { raw, description: string(item.description), condition: string(item.condition) };
};
// 予測震度の From・To（MaterialValue の raw）。To が over なら「程度以上」、範囲なら「〜」。
function forecastLabel(value: Json): string | null {
  const item = record(value), from = string(record(item?.from)?.raw), to = string(record(item?.to)?.raw);
  if (from == null) return null;
  const low = intensityLabel(from), high = to == null ? low : intensityLabel(to);
  return high === "over" ? `${low}程度以上` : high === low ? low : `${low}〜${high}`;
}
function lgLabel(value: Json): string | null {
  const item = record(value), from = string(item?.from), to = string(item?.to);
  if (from == null) return null;
  const low = nfkc(from), high = to == null ? low : nfkc(to);
  return high === low ? low : `${low}〜${high}`;
}
// 到達予想時刻の欄（Q-TO-EEW-6）: 主要動の到達と PLUM は Condition を短くして出す。
// 電文の確かさを変えずに出す（Q-TO3-MEANING）。発表時刻より前の到達予想時刻は到達と推測と同じ警報の字（P3-TL2-AC07 (2)）。
function eewArrival(condition: string | null, arrivalRaw: string | null, reportRaw: string | null): Seg | null {
  const text = condition == null ? "" : condition.normalize("NFKC").replace(/\s+/g, "");
  if (text.includes("既に主要動到達")) return seg("到達と推測", "arrived");
  if (text.includes("PLUM法")) return seg("PLUM法で推定");
  const at = clockOf(arrivalRaw);
  return at != null ? seg(at, arrivalRaw != null && reportRaw != null && Date.parse(arrivalRaw) < Date.parse(reportRaw) ? "arrived" : null) : text === "" ? null : seg(text);
}
// 見出し文の地方名を太字にする（spec §5.1 の表）。全角の空白で区切られた部分が地方名で、先頭が震源の文のままのときは先頭だけ地方名でない。
function headlineSegs(headline: string, regions: boolean): Seg[] {
  return headline.replace(/\s*\n+\s*/g, "　").split("　").flatMap((part, index) => {
    if (index === 0 && !regions) return [seg(part)];
    const [, name, tail] = /^(.*?)(で強い揺れ.*)?$/.exec(part)!;
    return [...index === 0 ? [] : [seg("　")], seg(name, null, true), ...tail == null ? [] : [seg(tail)]];
  });
}

// 前の報の覚え（P3-TL-AC05）。鍵は operation・family・EventID。仮定の震源（PLUM）の報は M と深さを覚えない。
type Remembered = Readonly<{ max: string; name: string | null; time: string | null; mag: string | null; depth: string | null; lg: string | null }>;
// 同じ地震の報の重なり（AC10）と同時に進む EEW（AC11）の覚え。鍵は operation・EventID（family をまたぐ）。
type Event = Readonly<{ seen45: boolean; cancelShown: boolean; ended: boolean; lastMs: number; name: string | null }>;
// follow は続報の比べ、events は EEW の重なりと同時進行、tsunami は VTSE41 の区分（地域名→区分の重さ）。どれも EventID ごとで 64 件まで。
type Memory = Readonly<{ follow: Map<string, Remembered>; events: Map<string, Event>; tsunami: Map<string, ReadonlyMap<string, number>> }>;
const ACTIVE_MS = 10 * 60_000;
// P3-TO-RET-01: EventID ごとの覚えは 64 件、古い順に捨てる（保存しない）。
// 鍵に operation を入れないと同じ EventID の訓練の報が通常の報の覚えを上書きする。family を入れないと VXSE43 と VXSE45 が別の番号で並走して比べ違える（P3-TL-D-FOLLOW-KEY）。
function remember<T>(memory: Map<string, T>, key: string, entry: T): void {
  memory.delete(key);
  memory.set(key, entry);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}
// P3-TO-D-CANCEL-PHRASE: 覚えがあれば前の報の震源名と発表時刻、無ければ EventID の時刻（検知時刻）。文は spec §5.1 の図の字。
function cancelPhrase(memory: ReadonlyMap<string, Remembered>, key: string | null, eventId: string | null): string | null {
  const known = key == null ? undefined : memory.get(key);
  if (known?.name != null) return known.time == null ? `取り消したのは${known.name}の地震です` : `取り消したのは ${known.time} 発表の${known.name}の地震です`;
  const detected = /^\d{8}(\d{2})(\d{2})\d{2}$/.exec(eventId ?? "");
  return detected == null ? null : `取り消したのは ${detected[1]}:${detected[2]} 頃に検知した地震です`;
}
// 旧の値と矢印は補足の薄い字（値が変わったときだけ）。
const was = (old: string | null | undefined, now: string): Seg[] => old != null && old !== now ? [seg(`${old} →  `, "dim")] : [];

// null は畳む報（P3-TL2-AC10）。畳んでも覚えは更新する（取消の 3 行目の震源名と、AC11 の最後の時刻に要る）。
function eew(subject: SubjectOutcome, memory: Memory, ctx: Ctx, nowMs: number): Rendered | null {
  const facts = subject.facts, report = record(facts.report);
  const family = string(facts.family) ?? subject.source?.family ?? "VXSE", eventId = string(facts.eventId);
  const warning = facts.warningClass === "warning", cancel = subject.informationType === "取消";
  const status = subject.operation === "training" ? "訓練" : subject.operation === "test" ? "試験" : null;
  const serial = typeof facts.serial === "number" ? facts.serial : null;
  const title = `緊急地震速報（${warning ? "警報" : "予報"}）${status == null ? "" : `（${status}）`}${cancel ? " 取消" : `${serial == null ? "" : ` 第${serial}報`}${facts.terminal === true ? " 最終報" : ""}`}`;
  const time = clockOf(subject.source?.reportDateTimeRaw), key = eventId == null ? null : `${subject.operation}/${family}/${eventId}`;
  const prediction = record(facts.prediction), max = forecastLabel(prediction?.maximum) ?? "不明";
  // 最大予測震度の字に 7 を含む報（7、7程度以上、6強〜7）は最も重い段（P3-TL2-AC01）。
  const roles = BAND_ROLES[cancel ? "cancel" : max.includes("7") ? "top" : warning ? "warning" : "caution"], bandLines = band(title, roles, time, ctx), tail = footer(family, eventId);
  const headline = string(report?.headline) ?? "";
  // 同じ operation・EventID で VXSE45 を受けた後の VXSE43 と、2 通目以降の取消を畳む（旧築 eew-tracker の hasSeen45、P3-TL2-AC10）。
  const eventKey = eventId == null ? null : `${subject.operation}/${eventId}`, known = eventKey == null ? undefined : memory.events.get(eventKey);
  const fold = cancel ? known?.cancelShown === true : family === "VXSE43" && known?.seen45 === true;
  const settle = (name: string | null): void => {
    if (eventKey == null) return;
    remember(memory.events, eventKey, { seen45: known?.seen45 === true || family === "VXSE45", cancelShown: known?.cancelShown === true || (cancel && !fold),
      ended: known?.ended === true || cancel || facts.terminal === true, lastMs: nowMs, name: name ?? known?.name ?? null });
  };
  if (cancel) {
    const phrase = cancelPhrase(memory.follow, key, eventId);
    const summary = [...textLines(headline === "" ? string(report?.cancelText) : headline, ctx.body), ...phrase == null ? [] : [line(seg(phrase))]];
    settle(null);
    return fold ? null : compose(bandLines, roles, { summary, tables: [], supplement: [], tail, recap: [] }, ctx);
  }
  const previous = key == null ? undefined : memory.follow.get(key);
  const areas = list(report?.areas), predicted = list(prediction?.areas);
  const topNames = areas.flatMap((value, index) => forecastLabel(record(record(predicted[index])?.intensity)) === max ? [string(record(value)?.name) ?? ""] : []);
  const name = string(report?.hypocenter), assumed = report?.isAssumedHypocenter === true, lg = lgLabel(report?.maxLgInt);
  const mag = magnitudeText(rawValue(report?.magnitude)), depth = depthText(rawValue(report?.coordinate));
  // 長周期階級 0 と無い報は項目を出さない。旧か新が 0 か無いときは矢印を付けない（旧の覚えも 0・無しは null で持つ）。
  const shownLg = lg == null || lg === "0" ? null : lg;
  const compared = assumed || previous == null ? null : previous;
  const lgItem = shownLg == null ? [] : [[seg("長周期階級 "), ...was(compared?.lg, shownLg), seg(shownLg, lgRole(shownLg))]];
  // 仮定の震源（PLUM）は M と深さを出さず、その報の震源の行に矢印を付けない（旧築と同じ、P3-TL-AC05 (6)）。
  const numeric = /^M[0-9.]+$/;
  const magSegs = compared?.mag != null && numeric.test(mag) && numeric.test(compared.mag)
    ? [seg("M"), ...was(compared.mag.slice(1), mag.slice(1)), seg(mag.slice(1))] : [...was(compared?.mag, mag), seg(mag)];
  const hypocenter = assumed ? joined([[seg(`震源: ${name ?? "不明"}（仮定の震源、PLUM法で推定）`)], ...lgItem], ctx.body)
    : joined([[seg("震源: "), ...name == null ? [] : was(compared?.name, name), seg(name ?? "不明")], magSegs, [seg("深さ"), ...was(compared?.depth, depth), seg(depth)], ...lgItem], ctx.body);
  // 見出し文の先頭が「<震源名>で地震」のときだけ外す（震源の行と重なる、P3-TL-AC04 (2)）。
  const cut = name != null && headline.startsWith(`${name}で地震`) ? headline.slice(`${name}で地震`.length).replace(/^　+/, "") : null;
  const rest = cut ?? headline;
  // 行動の文は言い換えずに太字で見出し文の下へ（Q-TO3-ACTION）。
  const action = textLines(string(report?.warningComment), ctx.body, true);
  // 別の EventID の EEW が進んでいる間は要点の最後に件数（訓練と通常は別、最終報・取消を受けた地震と 10 分を過ぎた地震は数えない、P3-TL2-AC11）。
  const active = [...memory.events].filter(([other, item]) => other !== eventKey && other.startsWith(`${subject.operation}/`) && !item.ended && nowMs - item.lastMs <= ACTIVE_MS);
  const others = active.length === 0 ? []
    : [line(seg(`ほかに ${active.length} 件の緊急地震速報${active.length === 1 && active[0][1].name != null ? `（${active[0][1].name}）` : ""}`))];
  const summary = [maxLine("最大予測震度 ", max, previous != null && previous.max !== max ? previous.max : null, topNames, ctx),
    ...rest === "" ? [] : [line(...headlineSegs(rest, cut != null))], ...action, ...hypocenter, ...others];
  const tables: Line[][] = [];
  const labels = areas.map((_, index) => forecastLabel(record(record(predicted[index])?.intensity)));
  const rows = areas.map((value, index): Cell[] => {
    const area = record(value), intensity = record(record(predicted[index])?.intensity);
    const label = labels[index], areaLg = lgLabel(area?.lgInt);
    return [label == null ? null : seg(solid(label, ctx), intensityRole(label)), seg(string(area?.name) ?? string(area?.code) ?? ""),
      eewArrival(string(intensity?.condition), string(area?.arrivalTimeRaw), subject.source?.reportDateTimeRaw ?? null), areaLg == null || areaLg === "0" ? null : seg(`階級${areaLg}`, lgRole(areaLg))];
  });
  // 地域が 1 つで到達も長周期階級も無い報は、表が要点の行の繰り返しになるので出さない（P3-TL-AC04 (3)）。
  const repeated = rows.length === 1 && labels[0] === max && rows[0][2] == null && rows[0][3] == null;
  if (rows.length > 0 && !repeated) {
    tables.push(rowTable([{ header: "予測震度", min: 12 }, { header: "地域", min: 14 }, { header: "到達予想時刻", short: "到達", min: 14 },
      { header: "長周期階級", short: "長周期", min: 0 }], rows, 1, ctx.body));
  }
  // 再掲: 最大の行と行動の文（発表時刻つき）。行動の文が無い報は最大の行に発表時刻（P3-TL2-AC05 (3)）。
  const stamp = recapStamp(time, status), topLine = (suffix: readonly Seg[]) => maxLine("最大予測震度 ", max, null, topNames, ctx, suffix);
  const recap = stamp === "" ? [] : action.length === 0 ? [topLine([seg(stamp, "dim")])] : [topLine([]), ...stampLast(action, stamp)];
  if (key != null) remember(memory.follow, key, { max, name, time, mag: assumed ? null : mag, depth: assumed ? null : depth, lg: shownLg });
  settle(name);
  return fold ? null : compose(bandLines, roles, { summary, tables, supplement: textLines(string(report?.nextAdvisory), ctx.body), tail, recap }, ctx);
}

// ---- 短い形（AC09、spec §5.4）と処理できなかった報（P3-TO-D-UNREADABLE） ----
const TOWN_LABEL = "対象の市町村  ";
const MONTHLY_URL = "https://www.data.jma.go.jp/vois/data/report/monthly_v-act_doc/monthly_vact.php";
// 短い形の文の組版の空白（P3-TL3-AC06、Q-TO4-SPACE）。端末の側の整形で、material は生の字を写す。
// 無いと電文の字下げと折り返しがそのまま出て「（ 平成」「詳しくは 月間」のように語の途中に空白が入る。短い形でない報の textLines は変えない。
const SENTENCE_ITEM = /^[^\s：:。、]*[^\s：:。、0-9０-９][：:]/, SENTENCE_JOIN = /[\p{L}\p{N}\p{Ps}]$/u;
function shortSentence(raw: string | null): string {
  const rows = (raw ?? "").split(/\n/).map((row) => row.trim().replace(/^(\S)[ 　]+(\S)(?=[：:])/, "$1$2"));
  return rows.reduce((sentence, row, index) => row === "" ? sentence : sentence === "" ? row : `${sentence}${SENTENCE_JOIN.test(rows[index - 1]) && !SENTENCE_ITEM.test(row) ? "" : " "}${row}`, "")
    .replace(/[ 　]+(?=[、。])/g, "");
}
function shortForm(report: Extract<TerminalReport, { kind: "short" }>, ctx: Ctx): Rendered {
  const { head } = report;
  // 版の印「（Ｒ０６）」は題名から除く（Q-TO-S-1）。
  const base = (head.controlTitle ?? head.title ?? head.headType).replace(/（Ｒ[０-９]+）/g, "");
  const title = `${base}${statusMark(head.status)}${head.infoType === "取消" ? " 取消" : ""}${report.target == null || report.target === "" ? "" : ` ${report.target}`}`;
  const roles = BAND_ROLES[report.level];
  // 見出し文は省略しない（spec §5.4 の図）。取消の報は Body の取消の文を代わりに出す（Q-TO4-CANCEL。空は無いものとして見出し文）。
  const headline = shortSentence(report.cancelText == null || report.cancelText === "" ? head.headline : report.cancelText);
  // 警報以上の段を決めた Kind の名前（P3-TL2-AC08）。見出し文か帯の題名に同じ字があるときは出さない。
  const reason = report.reason == null || headline.includes(report.reason) || title.includes(report.reason) ? [] : [line(seg(report.reason, null, true))];
  const office = head.publishingOffice == null || head.publishingOffice === "" ? head.headType : `${head.headType} ・ ${head.publishingOffice}`;
  // 全国の月間火山概況（Q-TO4-MONTHLY）: 「以下」の指す火山の表（見出し無し）と、「参照ください」の行き先。URL は電文に無いので固定の字（無いと文だけが残り行き先が画面に無い）。
  const { monthly } = report;
  const tables = monthly == null ? [] : [[...listTable(null, monthly.rows.map((row) => { const name = row.label.split("（")[0]; return { label: seg(name), rest: seg(name, "dim"), items: row.areas.map((area) => [seg(area)]) }; }), 0, ctx.body),
    ...monthly.others === 0 ? [] : [line(seg(`ほか ${monthly.others} 火山`, "dim"))]]];
  const supplement = monthly == null ? [] : [line(seg("月間火山概況・火山活動解説資料（気象庁ホームページ）")), { segs: [seg(MONTHLY_URL)], url: true as const }];
  // 噴火速報（Q-TO5-FLASH）: 見出し文の下に活動の文、その下に罫線と対象の市町村の表。表の下に罫線は足さない（spec の図）ので supplement に置く。
  const { flash } = report;
  const activity = flash == null ? [] : textLines(shortSentence(flash.activity), ctx.body);
  // 市町村は 1 つのまとまりなので、折り返した行に左の列を繰り返さない（繰り返すと別の区分に読める。作者の目視）。
  const towns = flash == null || flash.towns.length === 0 ? [] : [...flow([seg(TOWN_LABEL)], flash.towns.map((town) => [seg(town)]), ctx.body, width(TOWN_LABEL)),
    ...flash.others === 0 ? [] : [line(seg(`ほか ${flash.others} 市町村`, "dim"))]];
  // 理由の行がある報は見出し文を 2 桁下げる（Q-TO7-REASON-INDENT）。太字の差だけでは理由の行と本文の境が読めないため。折り返した行はさらに 2 桁下げる。
  const sentences = reason.length === 0 ? textLines(headline, ctx.body)
    : textLines(headline, ctx.body - 2).flatMap((item) => wrapChars([seg("  "), ...item.segs], ctx.body, "    ").map((segs) => ({ segs })));
  // 全国の集約通報（P3-TL8-AC02・AC03）: 表は要点のまとまりに置き（罫線なし）、理由の行と見出し文の行は出さない。警報以上は Code ごとの行で折り返した行にも左の列を薄い字、
  // 注意報だけの報は Kind の名前の並び（続きの行は字下げしない）、今の Kind の無い報は行なし。読まなかった予報区は段によらず薄い字の 1 行。
  const { national } = report;
  const nationwide = national == null ? null : [...report.level === "caution" ? flow([], national.rows.map((row) => [seg(row.label)]), ctx.body, 0)
    : listTable(null, national.rows.map((row) => ({ label: seg(row.label), rest: seg(row.label, "dim"), items: row.areas.map((area) => [seg(area)]) })), 0, ctx.body),
    ...national.others === 0 ? [] : [line(seg(`ほか ${national.others} 予報区は読んでいません`, "dim"))]];
  return compose(band(title, roles, clockOf(head.reportDateTimeRaw), ctx), roles,
    { summary: nationwide ?? [...reason, ...sentences, ...activity], tables, supplement: [...supplement, ...towns], tail: line(seg(office, "dim")), recap: [] }, ctx);
}
const two = (value: number): string => String(value).padStart(2, "0");
const localClock = (ms: number): string => { const at = new Date(ms); return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`; };
function unreadable(card: UnreadableCardView, ctx: Ctx): Rendered {
  const reported = clockOf(card.reportDateTimeRaw), roles = BAND_ROLES.plain;
  return { head: band(`処理できなかった電文 ${card.headType}`, roles, reported ?? localClock(card.receivedAt), ctx, reported == null ? "受信" : "発表"), bar: roles.bar,
    body: [line(seg(`${card.title == null || card.title === "" ? card.headType : card.title} を処理できませんでした。`))] };
}

// ---- 電文以外の出力（spec §6） ----
// Q-TO-C-4 の表の字（理由 5 種）。
const FAILURE_TEXT: Readonly<Record<DmdataConnectFailure, string>> = {
  network: "dmdata.jp に繋がりません。ネットワークの接続を確かめてください。繋がるまで自動で試し続けます。",
  authRejected: "API キーが dmdata.jp に受け付けられませんでした。fleq init か fleq config set apiKey <key> で設定し直してください。",
  capacity: "この API キーで開ける接続の数が上限に達しています。ほかのパソコンなどで動いている FlEq を止めるか、dmdata.jp の契約の接続数を確かめてください。",
  dmdata: "dmdata.jp が接続を受け付けませんでした。しばらくしてから自動で繋ぎ直します。",
  startUncertain: "接続を始められたか確かめられませんでした。自動で繋ぎ直します。",
};
const CONN_LOST: BandRoles = { band: "connLost", rule: "connLost", bar: "barPlain", fill: false };
const CONN_RESTORED: BandRoles = { band: "connRestored", rule: "connRestored", bar: "barPlain", fill: false };
// 起動時のまとめの分野の名前（spec §6.6 の図は 津波・地震・気象警報。ほかは unit の受け持ちの名前）。
const UNIT_NAMES: Readonly<Record<RuntimeUnitId, string>> = {
  "U-E": "緊急地震速報", "U-W": "気象警報", "U-F": "気象の時系列", "U-T": "津波", "U-Q": "地震", "U-N": "南海トラフ", "U-V": "火山",
  "U-L": "土砂災害", "U-R": "洪水", "U-B": "気象解説", "U-M": "地方の情報", "U-Y": "台風",
};
// Q-TO8-NO-CODE: まとめの「ほか」の題名。実物の電文の Control の Title から（Ｒ０６）・（Ｈ３０）と末尾の a を除いた名前。
// 4 字の鍵は番号が河川・海域・台風の割当で種類の違いでない型（VXKO50〜89、VXSU50〜59 など）。まとめに載る unit の ready の型を全部覆う（P3-TL7-T02）。
const TYPE_NAMES: Readonly<Record<string, string>> = {
  VTSE41: "津波警報・注意報・予報", VTSE51: "津波情報", VTSE52: "沖合の津波観測に関する情報",
  VXSE51: "震度速報", VXSE52: "震源に関する情報", VXSE53: "震源・震度に関する情報", VXSE61: "顕著な地震の震源要素更新のお知らせ", VXSE62: "長周期地震動に関する観測情報",
  VXSE56: "地震の活動状況等に関する情報", VXSE60: "地震回数に関する情報", VZSE40: "地震・津波に関するお知らせ",
  VYSE50: "南海トラフ地震臨時情報", VYSE51: "南海トラフ地震関連解説情報", VYSE52: "南海トラフ地震関連解説情報", VYSE60: "北海道・三陸沖後発地震注意情報",
  VFVO50: "噴火警報・予報", VFVO51: "火山の状況に関する解説情報", VFVO52: "噴火に関する火山観測報", VFVO53: "降灰予報（定時）", VFVO54: "降灰予報（速報）",
  VFVO55: "降灰予報（詳細）", VFVO56: "噴火速報", VFVO60: "推定噴煙流向報", VFSV: "火山現象に関する海上警報・海上予報", VZVO40: "火山に関するお知らせ",
  VPWS50: "気象警報・注意報（集約通報）", VPWW55: "気象警報・注意報（大雨）", VPWW56: "気象警報・注意報（土砂）", VPWW57: "気象警報・注意報（高潮）",
  VPWW58: "気象警報・注意報（暴風）", VPWW59: "気象警報・注意報（波浪）", VPWW60: "気象警報・注意報（大雪）", VPWW61: "気象警報・注意報（その他注意報）",
  VPNO50: "気象特別警報報知", VPWP50: "気象警報・注意報時系列情報", VXKO: "指定河川洪水予報", VXSU: "水位周知河川に関する情報", VPOA50: "記録的短時間大雨情報", VPBS50: "府県気象防災速報",
  VPZJ51: "全般気象解説情報", VPCJ51: "地方気象解説情報", VPFJ51: "府県気象解説情報", VMCJ53: "全般気象解説情報（潮位）", VMCJ54: "地方気象解説情報（潮位）",
  VMCJ55: "府県気象解説情報（潮位）", VPZI50: "全般天候情報", VPCI50: "地方天候情報", VPAW51: "早期天候情報", VPHW50: "竜巻注意情報",
  VPHW51: "竜巻注意情報（目撃情報付き）", VPFT50: "熱中症警戒アラート", VPTW: "台風解析・予報情報（５日予報）", VPTA: "台風の暴風域に入る確率",
};
// 表に無い種類はコードを出さず「その他」にまとめる（P3-TL7-D-UNKNOWN）。
const typeName = (headType: string): string => TYPE_NAMES[headType] ?? TYPE_NAMES[headType.slice(0, 4)] ?? "その他";
// 取り直しの 256 バイトの上限の印（recovery.ts の TRUNCATED_MARKER）は端末に出さず、切れたことだけを … で示す（P3-TL7-D-TRUNCATED）。
const TRUNCATED = "[truncated:fieldLimit]";
const untruncated = (text: string): string => text.endsWith(TRUNCATED) ? `${text.slice(0, -TRUNCATED.length)}…` : text;
function digest(view: RecoveryDigestView, ctx: Ctx): Line[] {
  // Q-TO8-DIGEST: 0 件の分野は出さない。「ほか」は同じ題名の件数を足し、多い順（同じ件数は omitted の順、sort は安定）。
  const units = view.units.flatMap((unit): { unit: RecoveryDigestUnit; total: number | null; rest: (readonly [string, number])[] }[] => {
    if (unit.kind === "unsatisfied") return [{ unit, total: null, rest: [] }];
    const rest = new Map<string, number>();
    for (const [type, count] of Object.entries(unit.omitted)) rest.set(typeName(type), (rest.get(typeName(type)) ?? 0) + count);
    const total = unit.heads.length + [...rest.values()].reduce((sum, count) => sum + count, 0);
    return total === 0 ? [] : [{ unit, total, rest: [...rest].sort((left, right) => right[1] - left[1]) }];
  });
  // 全部 0 件なら帯ごと出さない（作者裁定 A。C16 の不具合で再起動のたびに beforeWindow が立ち、帯と 1 行が毎回出るため）。
  if (units.length === 0) return [];
  const lines: Line[] = [...band("止まっていた間に出た情報（7 日前まで）", BAND_ROLES.plain, null, ctx)];
  if (view.units.some((unit) => unit.beforeWindow)) lines.push(line(seg("7 日より前の情報は取り直していません", "dim")));
  const size = Math.max(11, ...units.map(({ unit }) => width(UNIT_NAMES[unit.unit]) + 3));
  const digits = Math.max(0, ...units.map(({ total }) => total == null ? 0 : String(total).length));
  for (const { unit, total, rest } of units) {
    const name = seg(UNIT_NAMES[unit.unit], null, true), gap = seg(" ".repeat(size - width(UNIT_NAMES[unit.unit])));
    if (unit.kind === "unsatisfied" || total == null) { lines.push(line(name, gap, seg("取り直せませんでした"))); continue; }
    lines.push(line(name, gap, seg(`${String(total).padStart(digits)} 件`)));
    for (const head of unit.heads) lines.push(line(seg(`  ${minuteOf(head.reportDateTime) ?? localClock(head.receivedAt).slice(0, 5)}  ${untruncated(head.title)}`)));
    if (rest.length > 0) lines.push(line(seg(`  ほか ${rest.map(([title, count]) => `${title} ${count} 件`).join("　")}`)));
  }
  return lines;
}
const span = (fromMs: number | null, toMs: number): string => {
  const seconds = fromMs == null ? 0 : Math.max(0, Math.round((toMs - fromMs) / 1000));
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
function summary(fromMs: number, toMs: number, counts: SummaryCounts): string {
  const parts = [["EEW", counts.eew, ""], ["地震", counts.quake, counts.maxInt == null ? "" : `（最大震度 ${counts.maxInt}）`], ["津波", counts.tsunami, ""],
    ["南海トラフ", counts.nankai, ""], ["火山", counts.volcano, ""], ["気象", counts.weather, ""]] as const;
  const shown = parts.filter(([, count]) => count > 0).map(([name, count, extra]) => `${name} ${count}件${extra}`);
  return `── ${localClock(fromMs).slice(0, 5)}〜${localClock(toMs).slice(0, 5)} の受信 ── ${shown.length === 0 ? "受信なし" : shown.join(" ・ ")}`;
}
// 回線の行と起動時のまとめは線の上限と時刻の置き方だけ電文に合わせる（P3-TL-AC02 (8)。まとめの分野の名前の太字は Q-TO8-DIGEST）。空行も縦線も足さない。
function notice(item: TerminalNotice, ctx: Ctx): Line[] {
  switch (item.kind) {
    case "lost": {
      const from = item.fromWallMs == null ? "--:--:--" : localClock(item.fromWallMs);
      // 作者裁定 2026-11-03: 切れたとき・戻ったときとも帯・本文・罫線の 3 行を同じ色（クリーム／明るい緑）で出す。
      return [...band("回線が切れました", CONN_LOST, localClock(item.noticedWallMs), ctx, ""),
        line(seg(`${from} から受信できていません。自動で繋ぎ直しています。`, "connLost")),
        line(seg("━".repeat(ctx.total), "connLost"))];
    }
    case "restored": {
      const from = item.fromWallMs == null ? "--:--:--" : localClock(item.fromWallMs);
      return [...band("回線が戻りました", CONN_RESTORED, null, ctx, ""),
        line(seg(`${from} から ${localClock(item.toWallMs)} まで（${span(item.fromWallMs, item.toWallMs)}）受信できていませんでした`, "connRestored")),
        line(seg("━".repeat(ctx.total), "connRestored"))];
    }
    case "failure": return [line(seg(FAILURE_TEXT[item.reason]))];
    case "summary": return [line(seg(summary(item.fromWallMs, item.toWallMs, item.counts)))];
    case "tip": return [line(seg(`  ${item.text}`, "dim"))];
    case "update": return [line(seg(`新しい版があります: v${item.current.replace(/^v/, "")} → v${item.latest.replace(/^v/, "")}  `), seg(`npm install -g ${item.packageName}@latest`, "dim"))];
    case "digest": return digest(item.digest, ctx);
    case "debug": return [line(seg(item.text, "dim"))];
    // 旧築 src/engine/cli/cli-run.ts の帯（前後に空行）と、src/dmdata/ws-client.ts・src/engine/monitor/monitor.ts の接続の行の形（spec §6.7）。
    case "banner": return [line(), line(seg(`${item.appName} v${item.version} — Project DM-D.S.S リアルタイム地震・津波情報モニター`, "banner")), line()];
    case "session": return [...item.missing.map((name) => line(seg(`${name} は未契約のため受信できません`, "warn"))),
      line(seg(`セッション開始: socketId=${item.socketId}`)), line(seg(`区分: [${item.classifications.join(", ")}]`)), line(seg(`テスト電文: ${item.testMode}`)),
      line(seg("リアルタイム受信中...", "connRestored")), line(seg("help でコマンド一覧を表示（終了は quit か Ctrl+C）", "dim"))];
    default: { const unknown: never = item; throw new Error(`unknown terminal notice ${String(unknown)}`); }
  }
}

// ---- 書き出す文字 ----
function trimEnd(segs: readonly Seg[]): Seg[] {
  const kept = [...segs];
  while (kept.length > 0) {
    const last = kept.at(-1)!, trimmed = last.text.replace(/[ 　]+$/, "");
    if (trimmed !== "") { kept[kept.length - 1] = seg(trimmed, last.role, last.bold); break; }
    kept.pop();
  }
  return kept;
}
const paintSegs = (segs: readonly Seg[], paint: Paint): string =>
  segs.map((part) => part.bold ? paint("strong", paint(part.role, part.text)) : paint(part.role, part.text)).join("");
// どの桁数でも、出す行は桁数を越えない（URL の行を除く、AC04 (5)）。
function paintLines(lines: readonly Line[], ctx: Ctx, paint: Paint): string {
  return lines.flatMap((item) => physical(item, ctx.total)).map((segs) => paintSegs(segs, paint)).join("\n");
}
// 電文のブロック: 空行 1 行、帯、縦線のついた本文（P3-TL-AC01）。縦線は地の色の空白 1 桁と空白 1 桁。
function paintBlock(block: Rendered, ctx: Ctx, paint: Paint): string {
  const bar = ctx.bar ? [seg(" ", block.bar), seg(" ")] : [];
  const body = block.body.flatMap((item) => physical(item, ctx.body)).map((segs) => paintSegs([...bar, ...segs], paint));
  return `\n${[...block.head.flatMap((item) => physical(item, ctx.total)).map((segs) => paintSegs(segs, paint)), ...body].join("\n")}`;
}

// 1 つの端末の整形。EventID ごとの覚え（AC05 (3)(4)）は worker の中だけに持つ。
function createRenderer(level: ColorLevel): Readonly<{ render(batch: TerminalBatch): string }> {
  const paint = painter(level);
  // 畳んだ EEW の直後の debug の行は「出した」でなく「出さない・畳んだ」と書く。debug は次のバッチに回ることがあるので render をまたいで持つ。
  let folded = false;
  const memory: Memory = { follow: new Map(), events: new Map(), tsunami: new Map() };
  // prompt があれば、電文を書く前に入力の行を消し、書いた後に書き直す。
  const emit = (text: string, prompt: string | null): string => `${prompt == null ? "" : "\r\x1b[K"}${text}\n${prompt ?? ""}`;
  return {
    render(batch) {
      // 線と本文の右端は端末の幅、100 桁で止める。縦線は色のある 60 桁以上だけ（P3-TL-AC02 (2)(6)、AC03 (4)）。
      const total = Math.min(Math.max(1, batch.columns), RULE_LIMIT), bar = level > 0 && total >= BAR_MIN;
      const ctx: Ctx = { total, body: bar ? total - 2 : total, bar, color: level > 0 };
      let out = batch.dropped === 0 ? "" : `${paint("dim", `（表示が間に合わなかったため、${batch.dropped} 件の表示を省きました）`)}\n`;
      // 落とした単位があるとき、畳んだ報の debug の行は落ちている（旗は別の入力のものになる）。
      if (batch.dropped > 0) folded = false;
      for (const unit of batch.units) {
        const afterFold = folded;
        folded = false;
        switch (unit.kind) {
          case "echo": out += unit.text; break;
          case "line": out += `${unit.text}\n`; break;
          case "eew": {
            const block = eew(unit.subject, memory, ctx, unit.nowMs);
            folded = block == null;
            if (block != null) out += emit(paintBlock(block, ctx, paint), unit.prompt);
            break;
          }
          case "report": {
            const { report } = unit;
            out += emit(paintBlock(report.kind === "seismic" ? seismic(report, ctx) : report.kind === "tsunami" ? tsunami(report, memory, ctx) : shortForm(report, ctx), ctx, paint), unit.prompt);
            break;
          }
          case "unreadable": out += emit(paintBlock(unreadable(unit.card, ctx), ctx, paint), unit.prompt); break;
          case "notice": {
            const shown = afterFold && unit.notice.kind === "debug" ? { ...unit.notice, text: unit.notice.text.replace("、出した）", "、出さない・畳んだ）") } : unit.notice;
            // 行の無い知らせ（全部 0 件のまとめ）は空行も入力の行の書き直しも出さない。
            const lines = notice(shown, ctx);
            if (lines.length > 0) out += emit(paintLines(lines, ctx, paint), unit.prompt);
            break;
          }
          default: { const unknown: never = unit; throw new Error(`unknown terminal unit ${String(unknown)}`); }
        }
      }
      return out;
    },
  };
}

export {
  createRenderer, depthText, intensityLabel, intensityRank, list as jsonList, localClock, magnitudeText, rawValue, record as jsonRecord, seismicLevel,
  string as jsonString, tsunamiLevel, typeName, width,
};
export type { SummaryCounts, TerminalBatch, TerminalNotice, TerminalUnit };
