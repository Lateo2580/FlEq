import type { JsonValue, RuntimeUnitId, SubjectOutcome, UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { DmdataConnectFailure } from "../../contracts/p3-dmdata-connect.types";
import type { RecoveryDigestView } from "../../contracts/p3-recovery.types";
import type {
  TerminalBandLevel, TerminalHypocenter, TerminalReport, TerminalTsunamiArea, TerminalValue,
} from "../../contracts/p3-terminal-output.types";
import { BAND_ROLES, INTENSITY_ROLES, LG_ROLES, painter } from "./color";
import type { ColorLevel, Paint, Role } from "./color";

// P3-TO-AC03〜AC07: worker が書く文字を作る。見た目と文面の真実源は docs/specs/cli-terminal-output.md（§3〜§5）。
// main は材料を列に積むだけで、ここは worker（と試験）の中だけで動く（D-WRITER）。

// main が列に積む単位（AC02 (3)）。prompt は電文のブロックを書いた後に書き直す prompt と入力中の文字（readline が無ければ null）。
// line は数える出力（REPL の返事・起動の行）、echo は readline が書く echo と prompt（D-DROP で数えない）。
type TerminalUnit =
  | Readonly<{ kind: "report"; report: TerminalReport; prompt: string | null }>
  | Readonly<{ kind: "eew"; subject: SubjectOutcome; prompt: string | null }>
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
  | Readonly<{ kind: "debug"; text: string }>;
// worker への 1 回の送り。columns は送る時に読んだ端末の桁数（AC04 (1)）、dropped はその前に落とした単位の数（AC02 (3)）。
type TerminalBatch = Readonly<{ columns: number; dropped: number; units: readonly TerminalUnit[] }>;

type Seg = Readonly<{ text: string; role: Role | null }>;
type Line = Readonly<{ segs: readonly Seg[]; url?: true }>;

const RULE_LIMIT = 80, NARROW_BELOW = 60, MEMORY_LIMIT = 64;

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

const seg = (text: string, role: Role | null = null): Seg => ({ text, role });
const line = (...segs: Seg[]): Line => ({ segs });
const segsWidth = (segs: readonly Seg[]): number => segs.reduce((total, part) => total + width(part.text), 0);
const pad = (text: string, size: number): string => text + " ".repeat(Math.max(0, size - width(text)));
// 地域名だけを詰める（AC04 (4)）。末尾を … にする。
function fit(text: string, size: number): string {
  if (width(text) <= size) return text;
  let kept = "", used = 0;
  for (const char of text) {
    if (used + charWidth(char) + 1 > size) break;
    kept += char;
    used += charWidth(char);
  }
  return `${kept}…`;
}

// 字の境目で折り返し、2 行目から indent で字下げする（電文の文・ほかの行の止め、AC04 (4)(5)）。
function wrapChars(segs: readonly Seg[], cols: number, indent: string): Seg[][] {
  const lead = width(indent) + 2 <= cols ? indent : "";
  const lines: Seg[][] = [];
  let current: Seg[] = [], used = 0;
  const append = (char: string, role: Role | null) => {
    const last = current.at(-1);
    if (last != null && last.role === role) current[current.length - 1] = seg(last.text + char, role);
    else current.push(seg(char, role));
    used += charWidth(char);
  };
  for (const part of segs) for (const char of part.text) {
    if (used + charWidth(char) > cols && used > width(lead)) {
      lines.push(current);
      current = lead === "" ? [] : [seg(lead)];
      used = width(lead);
      if (char === " " || char === "　") continue;
    }
    append(char, part.role);
  }
  lines.push(current);
  return lines;
}

// 地域の一覧（AC04 (4)）: 全角の空白で区切って並べ、幅で折り返し、2 行目からは indent 桁の位置まで字下げする。
function flow(prefix: readonly Seg[], items: readonly (readonly Seg[])[], cols: number, indent: number): Line[] {
  const lines: Line[] = [];
  let current: Seg[] = [...prefix], used = segsWidth(prefix), empty = true;
  for (const item of items) {
    const size = segsWidth(item);
    if (!empty && used + 2 + size > cols) {
      lines.push({ segs: current });
      current = [seg(" ".repeat(indent))];
      used = indent;
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

// ---- 表（AC04 (3)(4)） ----
type Column = Readonly<{ header: string; min: number }>;
type Cell = Seg | null;
// 行の表。最後の列は詰めない。幅が足りなければ地域の列（region）だけを詰め、詰めても入らなければ 2 行の形にする。
function rowTable(columns: readonly Column[], rows: readonly (readonly Cell[])[], region: number, cols: number, narrow: boolean): Line[] {
  const last = columns.length - 1;
  const sizes = columns.map((column, index) => index === last
    ? Math.max(width(column.header), ...rows.map((row) => row[index] == null ? 0 : width(row[index]!.text)))
    : Math.max(column.min, width(column.header) + 2, ...rows.map((row) => row[index] == null ? 0 : width(row[index]!.text) + 2)));
  let two = narrow;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!two && total > cols) {
    sizes[region] -= total - cols;
    two = sizes[region] < width("地域") + 2;
  }
  if (two) {
    const pair = (cells: readonly Cell[]): Line[] => {
      const rest = cells.filter((cell, index): cell is Seg => index !== region && cell != null && cell.text !== "");
      return [line(seg(fit(cells[region]?.text ?? "", cols), cells[region]?.role ?? null)),
        line(seg("  "), ...rest.flatMap((cell, index) => index === 0 ? [cell] : [seg("  "), cell]))];
    };
    return [...pair(columns.map((column) => seg(column.header, "dim"))), ...rows.flatMap(pair)];
  }
  const render = (cells: readonly Cell[]): Line => line(...cells.flatMap((cell, index) => {
    const text = cell == null ? "" : index === region ? fit(cell.text, sizes[index] - 2) : cell.text;
    return index === last ? [seg(text, cell?.role ?? null)] : [seg(text, cell?.role ?? null), seg(" ".repeat(Math.max(0, sizes[index] - width(text))))];
  }));
  return [render(columns.map((column) => seg(column.header, "dim"))), ...rows.map(render)];
}

// 段ごとに地域を 1 行にまとめる表（地震の震度・長周期階級）。60 桁未満は段の行と地域の行に分ける。
function listTable(headers: readonly [string, string], rows: readonly Readonly<{ label: Seg; items: readonly (readonly Seg[])[] }>[],
  min: number, cols: number, narrow: boolean): Line[] {
  if (narrow) {
    return [line(seg(headers[0], "dim")), line(seg(`  ${headers[1]}`, "dim")),
      ...rows.flatMap((row) => [line(row.label), ...flow([seg("  ")], row.items, cols, 2)])];
  }
  const size = Math.max(min, width(headers[0]) + 2, ...rows.map((row) => width(row.label.text) + 2));
  return [line(seg(pad(headers[0], size) + headers[1], "dim")),
    ...rows.flatMap((row) => flow([row.label, seg(" ".repeat(size - width(row.label.text)))], row.items, cols, size))];
}

// ---- 共通の行 ----
const clockOf = (raw: string | null | undefined): string | null => /T(\d{2}:\d{2}:\d{2})/.exec(raw ?? "")?.[1] ?? null;
const minuteOf = (raw: string | null | undefined): string | null => /T(\d{2}:\d{2})/.exec(raw ?? "")?.[1] ?? null;
const nfkc = (text: string): string => text.normalize("NFKC").trim();

// 帯（spec §5 の見出しの罫線）。60 桁以上は 1 行で、罫線は min(桁数, 80) まで。60 桁未満か入らないときは発表時刻を次の行に出す。
// label は時刻の後ろの字（回線の帯は時刻だけ、処理できなかった報で発表時刻が無ければ「受信」）。roles は短い形の最も重い段の帯の字（白の地）。
function band(title: string, level: TerminalBandLevel, time: string | null, cols: number, narrow: boolean, label = "発表",
  roles: Readonly<{ band: Role; rule: Role }> = BAND_ROLES[level]): Line[] {
  const total = Math.min(cols, RULE_LIMIT), size = width(title), stamp = time == null ? "" : label === "" ? time : `${time} ${label}`;
  const timeLine = time == null ? [] : [line(seg(stamp, "dim"))];
  if (size + 4 > total) return [...wrapChars([seg(title, roles.band)], total, "").map((segs) => ({ segs })), line(seg("━".repeat(total), roles.rule)), ...timeLine];
  const fill = total - size - 6 - width(stamp);
  if (!narrow && time != null && fill >= 1) {
    return [line(seg("━ ", roles.rule), seg(title, roles.band), seg(` ${"━".repeat(fill)} `, roles.rule), seg(stamp, "dim"), seg(" ━", roles.rule))];
  }
  return [line(seg("━ ", roles.rule), seg(title, roles.band), seg(` ${"━".repeat(total - size - 3)}`, roles.rule)), ...timeLine];
}
const separator = (cols: number): Line => line(seg("─".repeat(Math.min(cols, RULE_LIMIT)), "dim"));
const footer = (headType: string, eventId: string | null): Line => line(seg(eventId == null || eventId === "" ? headType : `${headType} | ${eventId}`, "dim"));
const textLines = (text: string | null): Line[] => text == null ? [] : text.split(/\n+/).map((part) => part.trim()).filter((part) => part !== "").map((part) => line(seg(part)));
// P3-TO-D-STATUS-MARK（作者裁定 A）: 通常でない報は帯の題名の後ろに印を付ける。
const statusMark = (status: string | null): string => status === "訓練" ? "（訓練）" : status === "試験" ? "（試験）" : "";

// ---- 特殊値（AC05 (5)・AC06 (3)、O02） ----
const INTENSITY_ORDER = ["1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
const intensityLabel = (raw: string): string => {
  const text = nfkc(raw);
  return { "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強" }[text] ?? text;
};
// 先頭の震度の段（「5弱以上未入電」は 5 弱）。段が読めなければ -1。
const intensityRank = (label: string): number => INTENSITY_ORDER.indexOf(/^[1-7][弱強]?/.exec(label)?.[0] ?? "");
const intensityRole = (label: string): Role | null => INTENSITY_ROLES[label] ?? null;
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
function hypocenterLine(hypocenter: TerminalHypocenter, extra: readonly Seg[] = [], depth = true): Line {
  return line(seg(`震源: ${hypocenter.name ?? "不明"} ・ ${magnitudeText(hypocenter.magnitude)}${depth ? ` ・ 深さ${depthText(hypocenter.coordinate)}` : ""}`), ...extra);
}

// ---- 地震（AC06） ----
// H08: 最大震度 5 弱以上か長周期地震動階級 2 以上は warning、4 は caution（通知の音の段と同じ境目）。
// 「5弱以上未入電」（値の字か、値が空で condition の字）は 5 弱に当てる（危ない側）。
function seismicLevel(report: Extract<TerminalReport, { kind: "seismic" }>): TerminalBandLevel {
  if (report.head.infoType === "取消") return "cancel";
  const observed = report.maxInt == null || report.maxInt === "" ? report.maxIntCondition : report.maxInt;
  const rank = intensityRank(observed == null ? "" : intensityLabel(observed));
  const lg = Number(nfkc(report.maxLgInt ?? ""));
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

function seismic(report: Extract<TerminalReport, { kind: "seismic" }>, cols: number, narrow: boolean): Line[] {
  const { head } = report, cancel = head.infoType === "取消", level = seismicLevel(report);
  const title = `${head.controlTitle ?? head.title ?? head.headType}${statusMark(head.status)}${cancel ? " 取消" : ""}`;
  const lines: Line[] = [...band(title, level, clockOf(head.reportDateTimeRaw), cols, narrow), ...textLines(head.headline)];
  if (cancel) {
    if (head.headline == null || head.headline === "") lines.push(...textLines(report.text));
    return [...lines, separator(cols), footer(head.headType, head.eventId)];
  }
  const longPeriod = head.headType === "VXSE62";
  const max = report.maxInt == null && report.maxIntCondition == null ? null : areaIntensity(report.maxInt, report.maxIntCondition);
  const maxLg = report.maxLgInt == null ? null : nfkc(report.maxLgInt);
  if (longPeriod && maxLg != null) {
    lines.push(line(seg("最大長周期階級 "), seg(maxLg, lgRole(maxLg)), ...max == null ? [] : [seg(" ・ 最大震度 "), seg(max, intensityRole(max))]));
  } else if (max != null) lines.push(line(seg("最大震度 "), seg(max, intensityRole(max))));
  lines.push(report.hypocenter == null ? line(seg("震源: 調査中")) : hypocenterLine(report.hypocenter));
  lines.push(separator(cols));
  if (report.areas.length > 0) {
    const rows = longPeriod
      ? grouped(report.areas, (area) => area.maxLgInt == null || area.maxLgInt === "" ? "不明" : nfkc(area.maxLgInt)).map((group) => ({
        label: seg(`階級${group.label}`, lgRole(group.label)),
        // 階級の中は名前順（旧築 lg-observation-formatter.ts の buildLgAreaRows と同じ localeCompare の ja、spec §5.2 の図の並び）。
        items: [...group.items].sort((left, right) => left.name.localeCompare(right.name, "ja"))
          .map((area) => [seg(`${area.name}（震度${areaIntensity(area.maxInt, area.maxIntCondition)}）`)]) }))
      : grouped(report.areas, (area) => areaIntensity(area.maxInt, area.maxIntCondition)).map((group) => ({
        label: seg(group.label, intensityRole(group.label)), items: group.items.map((area) => [seg(area.name)]) }));
    lines.push(...listTable(longPeriod ? ["長周期階級", "地域"] : ["震度", "地域"], rows, longPeriod ? 12 : 8, cols, narrow),
      ...omittedLine(report.omitted), separator(cols));
  }
  lines.push(...textLines(report.forecastComment));
  // Q-TO-Q-5: 気象庁ホームページへのリンクである旨を明示する 1 行と、折らない URI。
  if (longPeriod && report.uri != null) {
    lines.push(line(seg("長周期地震動についての詳しい情報は、以下のURL（気象庁ホームページ）からご確認ください")), { segs: [seg(report.uri)], url: true });
  }
  return [...lines, footer(head.headType, head.eventId)];
}

// ---- 津波（AC07） ----
const kindOf = (area: TerminalTsunamiArea): string => (area.kindName ?? "").split("：")[0];
function tsunamiLevel(report: Extract<TerminalReport, { kind: "tsunami" }>): TerminalBandLevel {
  if (report.head.infoType === "取消") return "cancel";
  const kinds = report.areas.map(kindOf).filter((kind) => !kind.includes("解除"));
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "purple";
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
// 区分の名前はその区分の最初の行にだけ出す（旧築と同じ）。沿岸で推定される津波（Estimation）は区分を持たないので区分の列を外す。
function forecastTable(areas: readonly TerminalTsunamiArea[], reportRaw: string | null, cols: number, narrow: boolean, kinds: boolean): Line[] {
  let previous: string | null = null;
  const rows = areas.map((area): Cell[] => {
    const kind = kindOf(area), shown = kind === previous ? null : seg(kind, kind.includes("大津波警報") ? "rulePurple" : kind.startsWith("津波警報") ? "ruleWarning" : "ruleCaution");
    previous = kind;
    const height = heightText(area.height), arrival = arrivalText(area.arrivalTimeRaw, reportRaw) ?? area.arrivalCondition;
    return [...kinds ? [shown] : [], seg(area.name), height == null ? null : seg(height), arrival == null ? null : seg(arrival)];
  });
  const columns: Column[] = [{ header: "地域", min: 22 }, { header: "予想される高さ", min: 16 }, { header: "到達予想時刻", min: 0 }];
  return kinds ? rowTable([{ header: "区分", min: 12 }, ...columns], rows, 1, cols, narrow) : rowTable(columns, rows, 0, cols, narrow);
}

function tsunami(report: Extract<TerminalReport, { kind: "tsunami" }>, cols: number, narrow: boolean): Line[] {
  const { head } = report, cancel = head.infoType === "取消", reportRaw = head.reportDateTimeRaw;
  // 帯の題名: 大津波警報・津波警報…（VTSE41）は段を名前に持つ Head/Title、ほかは Control/Title（末尾の「a」は電文の版の印なので外す）。
  const base = head.headType === "VTSE41" ? head.title ?? head.controlTitle : head.controlTitle?.replace(/a$/, "") ?? head.title;
  const title = `${base ?? head.headType}${statusMark(head.status)}${cancel ? " 取消" : ""}`;
  const lines: Line[] = [...band(title, tsunamiLevel(report), clockOf(reportRaw), cols, narrow), ...textLines(head.headline)];
  if (cancel) return [...lines, separator(cols), footer(head.headType, head.eventId)];
  // 深さは沖合の情報（VTSE52）だけ出す（spec §5.3 の図のとおり、作者裁定。VTSE41・VTSE51 の図は M までで止める）。
  if (report.hypocenter != null) lines.push(hypocenterLine(report.hypocenter, [], head.headType === "VTSE52"));
  lines.push(separator(cols));
  const forecast = report.areas.filter((area) => kindOf(area) !== "津波なし" && !kindOf(area).startsWith("津波予報"));
  const slight = report.areas.filter((area) => kindOf(area).startsWith("津波予報"));
  if (forecast.length > 0) lines.push(...forecastTable(forecast, reportRaw, cols, narrow, true), separator(cols));
  if (slight.length > 0) {
    lines.push(line(seg(kindOf(slight[0]))), ...flow([seg(" ".repeat(narrow ? 2 : 12))], slight.map((area) => [seg(area.name)]), cols, narrow ? 2 : 12), separator(cols));
  }
  const tides = report.areas.filter((area) => area.stations.length > 0);
  if (tides.length > 0) {
    const size = Math.max(22, ...tides.map((area) => width(area.name) + 2));
    lines.push(line(seg("満潮時刻")), ...tides.flatMap((area) => {
      const items = area.stations.map((station) => [seg(`${station.name} ${minuteOf(station.highTideDateTimeRaw) ?? ""}`.trimEnd())]);
      return narrow ? [line(seg(fit(area.name, cols))), ...flow([seg("  ")], items, cols, 2)] : flow([seg(pad(area.name, size))], items, cols, size);
    }), separator(cols));
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
    if (!offshore) lines.push(line(seg("観測した津波")));
    lines.push(...rowTable([{ header: offshore ? "沖合の観測点" : "観測点", min: 14 }, { header: "第1波", min: 15 }, { header: "これまでの最大波", min: 0 }],
      rows, 0, cols, narrow), separator(cols));
  }
  if (report.estimations.length > 0) lines.push(line(seg("沿岸で推定される津波")), ...forecastTable(report.estimations, reportRaw, cols, narrow, false), separator(cols));
  if (report.omitted > 0) lines.push(...omittedLine(report.omitted), separator(cols));
  // 固定付加文は沖合の情報（VTSE52）だけ出す（VTSE41・VTSE51 の WarningComment は見出し文の繰り返しと長い定型文）。
  if (head.headType === "VTSE52") lines.push(...textLines(report.warningComment));
  return [...lines, footer(head.headType, head.eventId)];
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
function eewArrival(condition: string | null, arrivalRaw: string | null): Seg | null {
  const text = condition == null ? "" : condition.normalize("NFKC").replace(/\s+/g, "");
  if (text.includes("既に主要動到達")) return seg("到達済み", "arrived");
  if (text.includes("PLUM法")) return seg("PLUM法で推定");
  const at = clockOf(arrivalRaw);
  return at != null ? seg(at) : text === "" ? null : seg(text);
}
// 見出し文の地方名を太字にする（spec §5.1 の表）。全角の空白で区切られた 2 つ目から先が地方名。
function headlineSegs(headline: string): Seg[] {
  const [lead, ...rest] = headline.split("　");
  return [seg(lead), ...rest.flatMap((part) => {
    const [, name, tail] = /^(.*?)(で強い揺れ.*)?$/.exec(part)!;
    return [seg("　"), seg(name, "strong"), ...tail == null ? [] : [seg(tail)]];
  })];
}

type Memory = Map<string, Readonly<{ max: string | null; name: string | null; time: string | null }>>;
// P3-TO-RET-01: EventID ごとの覚えは 64 件、古い順に捨てる（保存しない）。
// 鍵は operation と EventID（unit の subject と同じ分け方）。無いと同じ EventID の訓練の報が通常の報の覚えを上書きする。
function remember(memory: Memory, key: string, entry: Readonly<{ max: string | null; name: string | null; time: string | null }>): void {
  memory.delete(key);
  memory.set(key, entry);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}
// P3-TO-D-CANCEL-PHRASE: 覚えがあれば前の報の震源名と発表時刻、無ければ EventID の時刻（検知時刻）。文は spec §5.1 の図の字。
function cancelPhrase(memory: Memory, key: string | null, eventId: string | null): string | null {
  const known = key == null ? undefined : memory.get(key);
  if (known?.name != null) return known.time == null ? `取り消したのは${known.name}の地震です` : `取り消したのは ${known.time} 発表の${known.name}の地震です`;
  const detected = /^\d{8}(\d{2})(\d{2})\d{2}$/.exec(eventId ?? "");
  return detected == null ? null : `取り消したのは ${detected[1]}:${detected[2]} 頃に検知した地震です`;
}

function eew(subject: SubjectOutcome, memory: Memory, cols: number, narrow: boolean): Line[] {
  const facts = subject.facts, report = record(facts.report);
  const family = string(facts.family) ?? subject.source?.family ?? "VXSE", eventId = string(facts.eventId);
  const warning = facts.warningClass === "warning", cancel = subject.informationType === "取消";
  const mark = subject.operation === "training" ? "（訓練）" : subject.operation === "test" ? "（試験）" : "";
  const serial = typeof facts.serial === "number" ? facts.serial : null;
  const title = `緊急地震速報（${warning ? "警報" : "予報"}）${mark}${cancel ? " 取消" : `${serial == null ? "" : ` 第${serial}報`}${facts.terminal === true ? " 最終報" : ""}`}`;
  const time = clockOf(subject.source?.reportDateTimeRaw), key = eventId == null ? null : `${subject.operation}/${eventId}`;
  const lines: Line[] = [...band(title, cancel ? "cancel" : warning ? "warning" : "caution", time, cols, narrow)];
  const headline = string(report?.headline) ?? "";
  if (cancel) {
    lines.push(...textLines(headline === "" ? string(report?.cancelText) : headline));
    const phrase = cancelPhrase(memory, key, eventId);
    if (phrase != null) lines.push(line(seg(phrase)));
    return [...lines, separator(cols), footer(family, eventId)];
  }
  const prediction = record(facts.prediction), max = forecastLabel(prediction?.maximum) ?? "不明";
  const previous = key == null ? undefined : memory.get(key);
  const maxLine = line(seg("最大予測震度 "), ...previous?.max != null && previous.max !== max ? [seg(`${previous.max} → `, "dim")] : [],
    seg(max, intensityRole(max)));
  const name = string(report?.hypocenter), assumed = report?.isAssumedHypocenter === true, lg = lgLabel(report?.maxLgInt);
  // 仮定の震源（PLUM）は M と深さを出さない（旧築と同じ）。長周期階級 0 と無い報は項目を出さない。
  const lgSegs = lg == null || lg === "0" ? [] : [seg(" ・ 長周期階級 "), seg(lg, lgRole(lg))];
  const hypocenter = assumed ? line(seg(`震源: ${name ?? "不明"}（仮定の震源、PLUM法で推定）`), ...lgSegs)
    : hypocenterLine({ name, coordinate: rawValue(report?.coordinate), magnitude: rawValue(report?.magnitude) }, lgSegs);
  lines.push(...headline === "" ? [hypocenter, maxLine] : [line(...headlineSegs(headline)), maxLine, hypocenter], separator(cols));
  const areas = list(report?.areas), predicted = list(prediction?.areas);
  if (areas.length > 0) {
    const rows = areas.map((value, index): Cell[] => {
      const area = record(value), intensity = record(record(predicted[index])?.intensity);
      const label = forecastLabel(intensity), areaLg = lgLabel(area?.lgInt);
      return [label == null ? null : seg(label, intensityRole(label)), seg(string(area?.name) ?? string(area?.code) ?? ""),
        eewArrival(string(intensity?.condition), string(area?.arrivalTimeRaw)), areaLg == null || areaLg === "0" ? null : seg(`階級${areaLg}`, lgRole(areaLg))];
    });
    lines.push(...rowTable([{ header: "予測震度", min: 12 }, { header: "地域", min: 14 }, { header: "到達予想時刻", min: 14 }, { header: "長周期階級", min: 0 }],
      rows, 1, cols, narrow), separator(cols));
  }
  lines.push(...textLines(string(report?.nextAdvisory)));
  if (key != null) remember(memory, key, { max, name, time });
  return [...lines, footer(family, eventId)];
}

// ---- 短い形（AC09、spec §5.4）と処理できなかった報（P3-TO-D-UNREADABLE） ----
function shortForm(report: Extract<TerminalReport, { kind: "short" }>, cols: number, narrow: boolean): Line[] {
  const { head } = report;
  // 版の印「（Ｒ０６）」は題名から除く（Q-TO-S-1）。
  const base = (head.controlTitle ?? head.title ?? head.headType).replace(/（Ｒ[０-９]+）/g, "");
  const title = `${base}${statusMark(head.status)}${head.infoType === "取消" ? " 取消" : ""}${report.target == null || report.target === "" ? "" : ` ${report.target}`}`;
  // 最も重い段は罫線を紫、帯の字を白の地に黒にする（Q-TO-S-2）。
  const roles = report.level === "purple" ? { band: "bandPurpleShort", rule: "rulePurple" } as const : BAND_ROLES[report.level];
  // 見出し文は省略せず、電文の改行は空白 1 つにする（spec §5.4 の図）。
  const headline = head.headline?.trim().replace(/\n+/g, " ") ?? "";
  return [...band(title, report.level, clockOf(head.reportDateTimeRaw), cols, narrow, "発表", roles),
    ...headline === "" ? [] : [line(seg(headline))],
    line(seg(head.publishingOffice == null || head.publishingOffice === "" ? head.headType : `${head.headType} | ${head.publishingOffice}`, "dim"))];
}
const two = (value: number): string => String(value).padStart(2, "0");
const localClock = (ms: number): string => { const at = new Date(ms); return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`; };
function unreadable(card: UnreadableCardView, cols: number, narrow: boolean): Line[] {
  const reported = clockOf(card.reportDateTimeRaw);
  return [...band(`処理できなかった電文 ${card.headType}`, "plain", reported ?? localClock(card.receivedAt), cols, narrow, reported == null ? "受信" : "発表"),
    line(seg(`${card.title == null || card.title === "" ? card.headType : card.title} を処理できませんでした。`))];
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
// 起動時のまとめの分野の名前（spec §6.6 の図は 津波・地震・気象警報。ほかは unit の受け持ちの名前）。
const UNIT_NAMES: Readonly<Record<RuntimeUnitId, string>> = {
  "U-E": "緊急地震速報", "U-W": "気象警報", "U-F": "気象の時系列", "U-T": "津波", "U-Q": "地震", "U-N": "南海トラフ", "U-V": "火山",
  "U-L": "土砂災害", "U-R": "洪水", "U-B": "気象解説", "U-M": "地方の情報", "U-Y": "台風",
};
function digest(view: RecoveryDigestView, cols: number, narrow: boolean): Line[] {
  const lines: Line[] = [...band("止まっていた間に出た情報（7 日前まで）", "plain", null, cols, narrow)];
  if (view.units.some((unit) => unit.beforeWindow)) lines.push(line(seg("7 日より前の情報は取り直していません", "dim")));
  const size = Math.max(11, ...view.units.map((unit) => width(UNIT_NAMES[unit.unit]) + 3));
  for (const unit of view.units) {
    const name = pad(UNIT_NAMES[unit.unit], size);
    if (unit.kind === "unsatisfied") { lines.push(line(seg(`${name}取り直せませんでした`))); continue; }
    const omitted = Object.entries(unit.omitted);
    lines.push(line(seg(`${name}${unit.heads.length + omitted.reduce((total, [, count]) => total + count, 0)} 件`)));
    const titles = Math.max(0, ...unit.heads.map((head) => width(head.title)));
    for (const head of unit.heads) {
      const at = minuteOf(head.reportDateTime) ?? localClock(head.receivedAt).slice(0, 5);
      lines.push(line(seg(`  ${at}  ${pad(head.title, titles)}  ${head.headline ?? ""}`)));
    }
    // 残りは種類のコードと件数（Q-TO-D-2）。種類が 2 つ以上なら全角の空白で並べる。
    if (omitted.length > 0) lines.push(line(seg(`  ほか ${omitted.map(([type, count]) => `${type} ${count} 件`).join("　")}`)));
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
function notice(item: TerminalNotice, cols: number, narrow: boolean): Line[] {
  switch (item.kind) {
    case "lost": {
      const from = item.fromWallMs == null ? "--:--:--" : localClock(item.fromWallMs);
      return [...band("回線が切れました", "plain", localClock(item.noticedWallMs), cols, narrow, ""),
        line(seg(`${from} から受信できていません。自動で繋ぎ直しています。`))];
    }
    case "restored": return [line(seg(`── 回線が戻りました ── ${item.fromWallMs == null ? "--:--:--" : localClock(item.fromWallMs)} から ${localClock(item.toWallMs)} まで（${span(item.fromWallMs, item.toWallMs)}）受信できていませんでした ──`))];
    case "failure": return [line(seg(FAILURE_TEXT[item.reason]))];
    case "summary": return [line(seg(summary(item.fromWallMs, item.toWallMs, item.counts)))];
    case "tip": return [line(seg(`  ${item.text}`, "dim"))];
    case "update": return [line(seg(`新しい版があります: v${item.current.replace(/^v/, "")} → v${item.latest.replace(/^v/, "")}  `), seg(`npm install -g ${item.packageName}@latest`, "dim"))];
    case "digest": return digest(item.digest, cols, narrow);
    case "debug": return [line(seg(item.text, "dim"))];
    default: { const unknown: never = item; throw new Error(`unknown terminal notice ${String(unknown)}`); }
  }
}

// ---- 書き出す文字 ----
function trimEnd(segs: readonly Seg[]): Seg[] {
  const kept = [...segs];
  while (kept.length > 0) {
    const last = kept.at(-1)!, trimmed = last.text.replace(/[ 　]+$/, "");
    if (trimmed !== "") { kept[kept.length - 1] = seg(trimmed, last.role); break; }
    kept.pop();
  }
  return kept;
}
// どの桁数でも、出す行は桁数を越えない（URL の行を除く、AC04 (5)）。
function paintLines(lines: readonly Line[], cols: number, paint: Paint): string {
  return lines.flatMap((item) => {
    const segs = trimEnd(item.segs);
    return item.url === true || segsWidth(segs) <= cols ? [segs] : wrapChars(segs, cols, "  ").map(trimEnd);
  }).map((segs) => segs.map((part) => paint(part.role, part.text)).join("")).join("\n");
}

// 1 つの端末の整形。EventID ごとの覚え（AC05 (3)(4)）は worker の中だけに持つ。
function createRenderer(level: ColorLevel): Readonly<{ render(batch: TerminalBatch): string }> {
  const paint = painter(level);
  const memory: Memory = new Map();
  const block = (lines: readonly Line[], cols: number, prompt: string | null): string =>
    `${prompt == null ? "" : "\r\x1b[K"}${paintLines(lines, cols, paint)}\n${prompt ?? ""}`;
  return {
    render(batch) {
      const cols = Math.max(1, batch.columns), narrow = cols < NARROW_BELOW;
      let out = batch.dropped === 0 ? "" : `${paint("dim", `（表示が間に合わなかったため、${batch.dropped} 件の表示を省きました）`)}\n`;
      for (const unit of batch.units) {
        switch (unit.kind) {
          case "echo": out += unit.text; break;
          case "line": out += `${unit.text}\n`; break;
          case "eew": out += block(eew(unit.subject, memory, cols, narrow), cols, unit.prompt); break;
          case "report": {
            const { report } = unit;
            out += block(report.kind === "seismic" ? seismic(report, cols, narrow) : report.kind === "tsunami" ? tsunami(report, cols, narrow) : shortForm(report, cols, narrow), cols, unit.prompt);
            break;
          }
          case "unreadable": out += block(unreadable(unit.card, cols, narrow), cols, unit.prompt); break;
          case "notice": out += block(notice(unit.notice, cols, narrow), cols, unit.prompt); break;
          default: { const unknown: never = unit; throw new Error(`unknown terminal unit ${String(unknown)}`); }
        }
      }
      return out;
    },
  };
}

export {
  createRenderer, depthText, intensityLabel, intensityRank, list as jsonList, localClock, magnitudeText, rawValue, record as jsonRecord, seismicLevel,
  string as jsonString, tsunamiLevel, width,
};
export type { SummaryCounts, TerminalBatch, TerminalNotice, TerminalUnit };
