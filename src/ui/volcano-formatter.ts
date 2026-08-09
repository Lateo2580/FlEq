import chalk from "chalk";
import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoTextInfo,
  ParsedVolcanoPlumeInfo,
  AshArea,
  AshForecastPeriod,
  WindProfileEntry,
  VolcanoMunicipality,
  VolcanoAlertEntrySnapshot,
} from "../types";
import type { Vfvo53BatchItems } from "../engine/messages/volcano-vfvo53-aggregator";
import {
  FrameLevel,
  RenderBuffer,
  HighlightRule,
  SEVERITY_LABELS,
  createRenderBuffer,
  flushWithRecap,
  getFrameWidth,
  getInfoFullText,
  getTruncation,
  frameTop,
  frameLine,
  frameDivider,
  frameDividerThin,
  frameDividerLabeled,
  frameDividerLabeledThin,
  frameBottom,
  wrapFrameLines,
  visualPadEnd,
  renderFooter,
  highlightAndWrap,
  renderSimpleNameList,
  reflowTelegramLines,
} from "./formatter";
import {
  ColumnSpec,
  ResponsiveDisplayMode,
  DetailItem,
  decideDisplayMode,
  renderResponsiveTable,
  pushClampedFrameLine,
  clampFrameContent,
  collectDetailForTable,
} from "./responsive-table-engine";
import { getRoleChalk, RoleName } from "./theme";
import { VolcanoPresentation } from "../engine/presentation/volcano-presentation";
import {
  formatPlumeHeightSpecialValue,
  plumeHeightUsesLegacyDisplay,
} from "../utils/plume-height";

type VolcanoWithPlumeHeight =
  | ParsedVolcanoEruptionInfo
  | ParsedVolcanoAshfallInfo
  | ParsedVolcanoPlumeInfo;

function visiblePlumeHeightLabel(
  info: VolcanoWithPlumeHeight,
  allowExplicitUnknown: boolean,
): string | null {
  if (info.plumeHeightAboveCraterValue != null) {
    if (plumeHeightUsesLegacyDisplay(info.plumeHeightAboveCraterValue)) {
      return info.plumeHeight == null ? null : `${info.plumeHeight}m`;
    }
    return formatPlumeHeightSpecialValue(info.plumeHeightAboveCraterValue, "detail");
  }
  if (info.plumeHeight != null) return `${info.plumeHeight}m`;
  return allowExplicitUnknown && info.kind === "eruption" && info.plumeHeightUnknown
    ? "不明"
    : null;
}

function visiblePlumeHeightDetail(
  info: VolcanoWithPlumeHeight,
  allowExplicitUnknown: boolean,
): string | null {
  const label = visiblePlumeHeightLabel(info, allowExplicitUnknown);
  if (label == null) return null;
  const semantic = info.plumeHeightAboveCraterValue;
  const value = semantic?.value;
  if (value == null) return info.plumeHeight == null ? `高度${label}` : `火口上${label}`;
  if (semantic != null && plumeHeightUsesLegacyDisplay(semantic)) {
    return `火口上${label}`;
  }
  if (value.presence === "value" || value.presence === "range" || value.lowerBound != null) {
    return `火口上${label}`;
  }
  return value.presence === "unknown" ? `高度${label}` : label;
}

function detailLevelRole(level: number | null): RoleName {
  switch (level) {
    case 5: return "frameCritical";
    case 4: return "frameCritical";
    case 3: return "frameWarning";
    case 2: return "frameWarning";
    case 1: return "frameNormal";
    default: return "frameNormal";
  }
}

/** REPL detail 用の継続中火山警報一覧を描画する。 */
export function renderVolcanoDetail(entries: VolcanoAlertEntrySnapshot[]): void {
  if (entries.length === 0) return;

  console.log("");
  console.log("  継続中の火山警報:");
  console.log("");

  const sorted = [...entries].sort(
    (a, b) => (b.alertLevel ?? 0) - (a.alertLevel ?? 0),
  );

  for (const entry of sorted) {
    const colorFn = getRoleChalk(detailLevelRole(entry.alertLevel));
    const levelStr = entry.alertLevel != null
      ? `Lv${entry.alertLevel}`
      : entry.alertLevelCode ?? "—";
    console.log(
      `    ${colorFn(entry.volcanoName)}  ${colorFn(levelStr)}  ${entry.warningKind}`,
    );
  }
  console.log("");
}

// ── ヘルパー ──

/** 電文タイプの日本語名 */
export function volcanoTypeLabel(type: string): string {
  const map: Record<string, string> = {
    VFVO50: "噴火警報・予報",
    VFVO51: "火山の状況に関する解説情報",
    VFVO52: "噴火に関する火山観測報",
    VFVO53: "降灰予報（定時）",
    VFVO54: "降灰予報（速報）",
    VFVO55: "降灰予報（詳細）",
    VFVO56: "噴火速報",
    VFVO60: "推定噴煙流向報",
    VZVO40: "火山に関するお知らせ",
  };
  // VFSVii は先頭4文字 "VFSV" でマッチ
  if (type.startsWith("VFSV")) return "火山現象に関する海上警報";
  return map[type] || type;
}

/** 噴火警戒レベルに対応するテーマロール */
function levelRole(level: number | null): RoleName {
  switch (level) {
    case 1: return "volcanoLevel1";
    case 2: return "volcanoLevel2";
    case 3: return "volcanoLevel3";
    case 4: return "volcanoLevel4";
    case 5: return "volcanoLevel5";
    default: return "textMuted";
  }
}

/** 現象コードに対応するテーマロール */
function phenomenonRole(code: string): RoleName {
  switch (code) {
    case "51": return "volcanoPhenomenonExplosion";    // 爆発
    case "52": return "volcanoPhenomenonEruption";     // 噴火
    case "56": return "volcanoPhenomenonFrequent";     // 噴火多発
    case "62": return "volcanoPhenomenonPossible";     // 噴火したもよう
    default: return "textMuted";
  }
}

/** 降灰コードに対応するテーマロール */
export function ashfallRole(code: string): RoleName {
  switch (code) {
    case "75": return "volcanoAshfallBallistic";   // 小さな噴石
    case "73": return "volcanoAshfallHeavy";       // 多量
    case "72": return "volcanoAshfallModerate";    // やや多量
    case "71": return "volcanoAshfallLight";       // 少量
    case "70": return "volcanoAshfallLight";       // 降灰
    default: return "textMuted";
  }
}

/** ashCode (string) の数値ランク。不正値は 0 (型・parser とも ashCode は string が正) */
export function ashCodeNum(code: string): number {
  return parseInt(code, 10) || 0;
}

/** 注目降灰かどうか (やや多量 72 / 多量 73 / 小さな噴石 75) */
export function isNotableAshCode(code: string): boolean {
  return ashCodeNum(code) >= 72;
}

// ── 降灰 row 基盤 (単発とバッチで ColumnSpec は共有しない。共有は colorize・ランク helper のみ) ──

/** 降灰予報表の 1 行 (ashCode ごとに集約、地域はカンマ結合 + wrap 列, spec §3.2) */
export interface AshfallGroupRow {
  ashName: string;       // 降灰量ラベル (ashfallRole で colorize)
  ashCode: string;       // ソート・notable 判定用 (string が正)
  areaNames: string;     // 該当降灰量の全地域をカンマ結合
}

/** AshArea 群を ashCode ごとに集約し、降灰コード数値降順で row 化する */
export function buildAshfallGroupRows(areas: AshArea[]): AshfallGroupRow[] {
  const byCode = new Map<string, { ashName: string; ashCode: string; names: string[] }>();
  for (const a of areas) {
    const g = byCode.get(a.ashCode);
    if (g == null) {
      byCode.set(a.ashCode, { ashName: a.ashName, ashCode: a.ashCode, names: [a.name] });
    } else {
      g.names.push(a.name);
    }
  }
  return [...byCode.values()]
    .sort((x, y) => ashCodeNum(y.ashCode) - ashCodeNum(x.ashCode))
    .map((g) => ({ ashName: g.ashName, ashCode: g.ashCode, areaNames: g.names.join(", ") }));
}

// ── 降灰予報 列定義 (2 列: 降灰量 + 地域 wrap。テーブルは omitHeader で描画, spec §3.2) ──
// watch-point: ultra-narrow minWidth 8+20 + sep 3 = 31 <= 56 (幅 60 の innerWidth)
// 列順は 降灰量 → 地域 (NO_COLOR 3 重冗長性 ①: 降灰量ラベルが行内 prefix を兼ねる)

export function ashfallColumns(mode: ResponsiveDisplayMode): ColumnSpec<AshfallGroupRow>[] {
  const ashCol: ColumnSpec<AshfallGroupRow> = {
    header: "降灰量",
    minWidth: 8,
    maxWidth: 16, // 「小さな噴石の落下」(全角 8 字 = 幅 16) を全文表示 (spec §9 R3-3)
    cell: (r) => r.ashName,
    colorize: (r, padded) => getRoleChalk(ashfallRole(r.ashCode))(padded),
  };
  const areaCol: ColumnSpec<AshfallGroupRow> = {
    header: "地域",
    minWidth: 20,
    maxWidth: mode === "wide" ? 160 : 100,
    wrap: true,
    cell: (r) => r.areaNames,
    colorize: (_r, padded) => chalk.white(padded),
  };
  return [ashCol, areaCol];
}

/**
 * ISO 文字列 (dmdata 電文時刻 `YYYY-MM-DDThh:mm:ss+09:00`) の wall-clock 部を正規表現で抜く。
 * Date 経由だと表示が実行環境のローカル TZ に依存する (+09:00 電文を UTC 環境で render
 * すると 9 時間ずれる — Codex blocker) ため、電文に書かれた時刻をそのまま使う。
 */
function parseIsoWallClock(iso: string): { date: string; MM: string; dd: string; hh: string; mm: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (m == null) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, MM: m[2], dd: m[3], hh: m[4], mm: m[5] };
}

/** period の short label (MM-DD HH:MM〜HH:MM。終端が開始と同日なら終端の日付を省略, spec §3.2)。TZ 非依存 */
export function ashfallPeriodLabel(period: AshForecastPeriod): string {
  const fmt = (iso: string, withDate: boolean): string => {
    const p = parseIsoWallClock(iso);
    if (p == null) return iso;
    return withDate ? `${p.MM}-${p.dd} ${p.hh}:${p.mm}` : `${p.hh}:${p.mm}`;
  };
  const s = period.startTime;
  const e = period.endTime;
  if (s && e) {
    const sp = parseIsoWallClock(s);
    const ep = parseIsoWallClock(e);
    // 同日判定も文字列の日付部比較 (offset 換算で日付が動かない)
    const sameDay = sp != null && ep != null && sp.date === ep.date;
    return `${fmt(s, true)}〜${fmt(e, !sameDay)}`;
  }
  if (e) return `〜${fmt(e, true)}`;
  if (s) return `${fmt(s, true)}〜`;
  return "時間帯不明";
}

// ── 風向表 列定義 (VFVO60。3 列固定・元々小さいため全 mode 共通、spec §3 Tier) ──
// watch-point: minWidth 10+7+7 + sep 6 = 30 <= 56 (幅 60 の innerWidth)

export function plumeWindColumns(): ColumnSpec<WindProfileEntry>[] {
  return [
    {
      header: "高度",
      minWidth: 10,
      maxWidth: 16,
      cell: (r) => r.altitude,
      colorize: (_r, padded) => chalk.white(padded),
    },
    {
      header: "風向(°)",
      minWidth: 7,
      maxWidth: 9,
      cell: (r) => (r.degree != null ? `${r.degree}°` : "—"),
      colorize: (_r, padded) => chalk.white(padded),
    },
    {
      header: "風速",
      minWidth: 7,
      maxWidth: 10,
      cell: (r) => (r.speed != null ? `${r.speed}kt` : "—"),
      colorize: (_r, padded) => chalk.gray(padded),
    },
  ];
}

// ── 火山専用 詳細ブロック (spec §3。engine の DETAIL_MAX_* 行 cap は使わない —
//    VFVO53 実測 84 area item の全件復元と衝突するため。必要 entry 数を事前計算し、
//    名前復元に必要な分は全部出す。hard cap 超過は fail-closed: 明示打切り +
//    名前必須 invariant テストが失敗として検出する) ──

/** 実測上界 84 (66_01_01_210517_VFVO53.xml の全 area item) × 安全係数 2 */
export const VOLCANO_DETAIL_HARD_CAP = 168;

export interface VolcanoDetailCapResult {
  items: DetailItem[];
  omitted: number;
}

/** 必要 entry 数の事前計算 + hard cap 超過打切り (純粋関数、fail-closed の判定部) */
export function applyVolcanoDetailCap(items: DetailItem[]): VolcanoDetailCapResult {
  if (items.length <= VOLCANO_DETAIL_HARD_CAP) return { items, omitted: 0 };
  return {
    items: items.slice(0, VOLCANO_DETAIL_HARD_CAP),
    omitted: items.length - VOLCANO_DETAIL_HARD_CAP,
  };
}

export function pushVolcanoDetailBlock(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  items: DetailItem[],
): void {
  if (items.length === 0) return;
  const capped = applyVolcanoDetailCap(items);
  buf.push(frameDividerLabeled(level, "[詳細]", width));
  for (const d of capped.items) {
    for (const l of wrapFrameLines(level, chalk.white(d.head), width, 2)) buf.push(l);
    for (const line of d.body) {
      for (const l of wrapFrameLines(level, chalk.gray(line), width, 6)) buf.push(l);
    }
  }
  if (capped.omitted > 0) {
    // fail-closed: silent に嘘をつかない。打切りは明示 divider で可視化し、
    // 名前必須 invariant テストがこの状態を「失敗」として検出する
    buf.push(frameDividerLabeled(level, `[詳細] (上限超過 ${capped.omitted} entry 省略)`, width));
  }
}

/** 末尾サマリ (NO_COLOR 3 重冗長性の 3 点目: 最大降灰量と地域数・時間帯数) */
export function buildAshfallSummaryLine(info: ParsedVolcanoAshfallInfo): string {
  const allAreas = info.ashForecasts.flatMap((p) => p.areas);
  const totalAreas = new Set(allAreas.map((a) => a.name)).size;
  const maxName = getMaxAshName(info);
  const parts: string[] = [];
  if (maxName) {
    parts.push(getRoleChalk(ashfallRole(getMaxAshCode(info)))(`最大 ${maxName}`));
  }
  parts.push(chalk.white(`${totalAreas} 地域`));
  parts.push(chalk.white(`${info.ashForecasts.length} 時間帯`));
  return parts.join(chalk.gray(" ・ "));
}

/** アクションの日本語ラベル */
function actionLabel(action: string): string {
  const map: Record<string, string> = {
    raise: "引上げ",
    lower: "引下げ",
    release: "解除",
    continue: "継続",
    issue: "発表",
    cancel: "取消",
  };
  return map[action] ?? action;
}

/** レベルコード表示変換 */
function levelCodeToDisplay(code: string): string {
  const map: Record<string, string> = {
    "11": "Lv1", "12": "Lv2", "13": "Lv3", "14": "Lv4", "15": "Lv5",
    "21": "活火山であることに留意",
    "22": "火口周辺危険",
    "23": "入山危険",
    "31": "海上警報",
    "33": "海上予報",
    "35": "活火山であることに留意（海底火山）",
    "36": "周辺海域警戒",
  };
  return map[code] ?? code;
}

/**
 * 対象市町村を kind (火口周辺警報 / 噴火警報 / 噴火予報：警報解除 等) 単位にグループ化する。
 * 出現順保持。kind 1 種なら呼び出し側は現状の name 羅列のまま (divider を増やさない、spec §2-4)。
 * code は表示しない (市町村名が県名込みで十分)
 */
export function groupMunicipalitiesByKind(
  munis: VolcanoMunicipality[],
): { kind: string; names: string[] }[] {
  const map = new Map<string, string[]>();
  for (const m of munis) {
    if (!map.has(m.kind)) map.set(m.kind, []);
    map.get(m.kind)!.push(m.name);
  }
  return [...map.entries()].map(([kind, names]) => ({ kind, names }));
}

// ── 火山本文ハイライト ──

/** 火山本文キーワード強調ルール */
const VOLCANO_HIGHLIGHT_RULES: HighlightRule[] = [
  // 警戒・危険語
  { source: "噴火警報|噴火予報|噴火速報|海上警報|海上予報", flags: "", style: () => chalk.bold.white },
  { source: "噴火警戒レベル[1-5１-５]?|レベル[1-5１-５]|Lv[1-5]", flags: "", style: () => chalk.bold.white },
  { source: "避難|警戒|規制|立入禁止|危険|注意", flags: "", style: () => getRoleChalk("warningComment") },
  // 現象語
  { source: "噴火|爆発|噴煙|降灰|噴石|大きな噴石|小さな噴石|火砕流|溶岩流|火山泥流|火山ガス", flags: "", style: () => getRoleChalk("warningComment") },
  // 観測語
  { source: "火山性微動|山体膨張|傾斜変動|空振|火映|鳴動", flags: "", style: () => chalk.white },
  // レベル変更語
  { source: "引き上げ|引き下げ|引上げ|引下げ|継続|解除|発表", flags: "", style: () => chalk.white },
  // 海域関連
  { source: "海底火山|周辺海域警戒|周辺海域", flags: "", style: () => chalk.white },
];

/**
 * 火山本文をハイライト付きで表示する共通ヘルパー。
 * 改行で段落分割 → 各行にハイライト+折り返し → frameLine で出力。
 */
function pushHighlightedBody(
  buf: RenderBuffer,
  level: FrameLevel,
  bodyText: string,
  width: number,
  maxLines: number,
): void {
  const innerWidth = width - 4;
  // 電文由来の固定幅 hard-wrap を解除 (spec §8 R2-3)。空行保持の現挙動は reflow が維持する
  const bodyLines = reflowTelegramLines(
    bodyText.split(/\r?\n/).map((line) => line.trimEnd()),
  );

  const outputLines: string[] = [];
  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      outputLines.push("");
      continue;
    }
    const highlighted = highlightAndWrap(` ${line}`, VOLCANO_HIGHLIGHT_RULES, innerWidth);
    outputLines.push(...highlighted);
  }

  const displayLines = outputLines.slice(0, maxLines);
  for (const line of displayLines) {
    buf.push(frameLine(level, line, width));
  }
  if (outputLines.length > maxLines) {
    buf.push(frameLine(level, ` ${chalk.gray(`(以下省略、全${outputLines.length}行)`)}`, width));
  }
}

/** バナー表示仕様 */
interface VolcanoBannerSpec {
  role: RoleName;
  text: string;
}

/** 電文・レベルに基づくバナー表示判定 */
function getVolcanoBannerSpec(
  info: ParsedVolcanoInfo,
  level: FrameLevel,
): VolcanoBannerSpec | null {
  if (info.kind === "alert" && level === "critical") {
    return { role: "volcanoAlertBanner", text: volcanoTypeLabel(info.type) };
  }
  if (info.kind === "eruption" && info.isFlashReport && level === "critical") {
    return { role: "volcanoFlashBanner", text: "噴火速報" };
  }
  if (info.kind === "ashfall" && level === "warning" && info.type === "VFVO54") {
    return { role: "volcanoAlertBanner", text: volcanoTypeLabel(info.type) };
  }
  return null;
}

/** フレーム外全幅バナー描画 */
function pushFullWidthBanner(
  buf: RenderBuffer,
  style: ReturnType<typeof getRoleChalk>,
  text: string,
  width: number,
): void {
  buf.push(style(" ".repeat(width)));
  buf.push(style(visualPadEnd(` ${text}`, width)));
  buf.push(style(" ".repeat(width)));
}

// ── 共通ヘッダー ──

function renderVolcanoHeader(
  info: ParsedVolcanoInfo,
  level: FrameLevel,
  width: number,
  buf: RenderBuffer,
): void {
  buf.push(frameTop(level, width));

  // タイトル行 — pushTitle で recap 対応
  const titleContent = info.isTest
    ? ` ${getRoleChalk("testBadge")(" TEST ")} ${info.title}  ${chalk.gray(SEVERITY_LABELS[level])}`
    : ` ${info.title}  ${chalk.gray(SEVERITY_LABELS[level])}`;
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // 火山名（日時はフッターに表示するため省略）
  const volcanoLabel = info.volcanoName || "(不明)";
  pushClampedFrameLine(buf, level, width, ` ${volcanoLabel}`);

  // ヘッドライン — pushHeadline で recap 対応（最初の行のみ）
  if (info.headline) {
    buf.push(frameDivider(level, width));
    // 複数行ヘッドラインの各行に先頭スペースを付与して整列
    const indentedHeadline = info.headline.replace(/\r\n?/g, "\n").split("\n").map((l) => ` ${l}`).join("\n");
    const wrapped = wrapFrameLines(level, indentedHeadline, width)
      // ＜＞内は他セクションと重複するためグレーアウト（折り返し後に適用）
      .map((line) => line.replace(/＜[^＞]*＞/g, (m) => chalk.gray(m)));
    for (let i = 0; i < wrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(wrapped[i]);
      } else {
        buf.push(wrapped[i]);
      }
    }
  }
}

// ── 電文タイプ別レンダラ ──

function renderAlert(info: ParsedVolcanoAlertInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDividerThin(level, width));

  // カード行 (recap 用 1行サマリー)
  if (info.alertLevel != null) {
    const role = levelRole(info.alertLevel);
    const colorFn = getRoleChalk(role);
    const actionStr = actionLabel(info.action);
    // 引上げ/引下げ時: 矢印形式で前回→現在を1行表示
    if (info.previousLevelCode && (info.action === "raise" || info.action === "lower")) {
      const prevDisplay = levelCodeToDisplay(info.previousLevelCode);
      const content = ` ${chalk.gray(prevDisplay)} → ${colorFn(`Lv${info.alertLevel}`)} ${chalk.white(info.warningKind)}  (${actionStr})`;
      buf.pushCard(frameLine(level, clampFrameContent(content, width), width));
    } else {
      const content = ` ${colorFn(`Lv${info.alertLevel}`)} ${chalk.white(info.warningKind)}  (${actionStr})`;
      buf.pushCard(frameLine(level, clampFrameContent(content, width), width));
    }
  } else if (info.isMarine) {
    // 海上警報: warningKind + marineWarningKind + action で情報を強化
    const cardParts: string[] = [];
    if (info.warningKind) cardParts.push(chalk.bold.white(info.warningKind));
    if (info.marineWarningKind) cardParts.push(chalk.white(info.marineWarningKind));
    cardParts.push(`(${actionLabel(info.action)})`);
    const content = ` ${cardParts.join("  ")}`;
    buf.pushCard(frameLine(level, clampFrameContent(content, width), width));
  }

  // 対象市町村 (wrap 全件表示 = 情報欠落なし)。レベル変化カードと 1 ブロックに統合 (spec §3.1)。
  if (info.municipalities.length > 0) {
    const groups = groupMunicipalitiesByKind(info.municipalities);
    if (groups.length <= 1) {
      renderSimpleNameList({
        level,
        width,
        items: info.municipalities.map((m) => m.name),
        label: "対象:",
        buf,
      });
    } else {
      for (const g of groups) {
        renderSimpleNameList({ level, width, items: g.names, label: `${g.kind}:`, buf });
      }
    }
  }

  // 対象海上予報区
  if (info.marineAreas.length > 0) {
    buf.push(frameDividerThin(level, width));
    const areaNames = info.marineAreas.map((a) => a.name);
    renderSimpleNameList({
      level,
      width,
      items: areaNames,
      label: "対象海域:",
      buf,
    });
  }

  // 本文 (VolcanoActivity) / 防災事項 (VolcanoPrevention)
  if (info.bodyText) {
    buf.push(frameDividerThin(level, width));
    const fullText = getInfoFullText();
    const bodyLines = info.bodyText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const maxLines = fullText ? bodyLines.length * 2 : getTruncation().volcanoAlertLines;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }
  if (info.isMarine && info.preventionText) {
    buf.push(frameDividerThin(level, width));
    pushHighlightedBody(buf, level, info.preventionText, width, getTruncation().volcanoPreventionLines);
  }
}

function renderEruption(info: ParsedVolcanoEruptionInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 現象 — pushCard で recap 用サマリー
  const phenRole = phenomenonRole(info.phenomenonCode);
  const phenFn = getRoleChalk(phenRole);
  const cardContent = info.craterName
    ? ` ${phenFn(info.phenomenonName)}  ${chalk.gray(info.craterName)}`
    : ` ${phenFn(info.phenomenonName)}`;
  buf.pushCard(frameLine(level, clampFrameContent(cardContent, width), width));

  // 火口名
  if (info.craterName) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("火口:")} ${info.craterName}`);
  }

  // 噴煙高度・流向
  const plumeHeight = visiblePlumeHeightDetail(info, true);
  if (plumeHeight != null) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("噴煙:")} ${plumeHeight}`);
  }
  if (info.plumeDirection) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("流向:")} ${info.plumeDirection}`);
  }

  // 本文
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const maxLines = fullText ? 999 : getTruncation().volcanoEruptionLines;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }
}

function renderAshfall(info: ParsedVolcanoAshfallInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);

  // カード行 (recap 用 1行サマリー) — 全降灰Kindを表示
  {
    const totalAreas = new Set(info.ashForecasts.flatMap((p) => p.areas).map((a) => a.name)).size;
    // ashCode ごとに一意化し、重い順に全Kindを並べる
    const allAreas = info.ashForecasts.flatMap((p) => p.areas);
    const ashKinds = Array.from(
      new Map(
        [...allAreas]
          .sort((a, b) => (parseInt(b.ashCode, 10) || 0) - (parseInt(a.ashCode, 10) || 0))
          .map((a) => [a.ashCode, a])
      ).values()
    );
    const cardParts = ashKinds.map((a) => getRoleChalk(ashfallRole(a.ashCode))(a.ashName));
    cardParts.push(`${totalAreas}地域`);
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, clampFrameContent(` ${cardParts.join("  ")}`, width), width));
  }

  // 火口名
  if (info.craterName) {
    buf.push(frameDivider(level, width));
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("火口:")} ${info.craterName}`);
  }

  // 噴煙高度
  const plumeHeight = visiblePlumeHeightDetail(info, false);
  if (plumeHeight != null) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("噴煙:")} ${plumeHeight}`);
  }

  // 本文 (VolcanoActivity) — 降灰テーブルより先に表示
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const t = getTruncation();
    const maxLines = fullText ? 999
      : info.type === "VFVO55" ? t.volcanoAshfallDetailLines
      : info.type === "VFVO54" ? t.volcanoAshfallQuickLines
      : t.volcanoAshfallRegularLines;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }

  // 降灰予報データ: 降灰量ごとに地域をカンマ結合した 2 列 wrap テーブル (ヘッダ省略)。
  // 時間帯は先頭 (直近) 3 つまで表示、残りは集約 1 行 (spec §3.2)。先頭 period にセクション
  // ラベルを合流させ「降灰予報」単独 divider の 2 連続 (二重線) を解消する。
  if (info.ashForecasts.length > 0) {
    const mode = decideDisplayMode(width);
    // 時間帯は先頭 (直近) 3 つまで表示、残りは集約 1 行 (spec §3.2)。
    const MAX_PERIODS = 3;
    const shownPeriods = info.ashForecasts.slice(0, MAX_PERIODS);
    const overflowPeriods = info.ashForecasts.slice(MAX_PERIODS);

    shownPeriods.forEach((period, pIdx) => {
      const periodLabel = ashfallPeriodLabel(period);
      // 先頭 period にセクションラベルを合流 (単独「降灰予報」divider の 2 連続を回避)。
      // 2 つ目以降は細線 labeled divider。
      if (pIdx === 0) {
        buf.push(frameDividerLabeled(level, `降灰予報 ${periodLabel}`, width));
      } else {
        buf.push(frameDividerLabeledThin(level, periodLabel, width));
      }
      const rows = buildAshfallGroupRows(period.areas);
      // 2 列で自明のためヘッダ省略。地域は wrap 列で全件表示 (clip 回収不要)。
      renderResponsiveTable(buf, level, width, ashfallColumns(mode), rows, { omitHeader: true });
    });

    if (overflowPeriods.length > 0) {
      const heaviest = overflowPeriods
        .flatMap((p) => p.areas)
        .sort((a, b) => ashCodeNum(b.ashCode) - ashCodeNum(a.ashCode))[0];
      const heaviestName = heaviest?.ashName ?? "―";
      // frameLine は overflow を clamp しない (formatter.ts:326) ため、幅 40-50 での
      // はみ出し防止に pushClampedFrameLine 経由で出す (Codex R1 #1)。
      pushClampedFrameLine(buf, level, width, chalk.gray(`ほか ${overflowPeriods.length} 時間帯（最大: ${heaviestName}）`));
    }

    buf.push(frameDividerLabeled(level, "サマリ", width));
    pushClampedFrameLine(buf, level, width, ` ${buildAshfallSummaryLine(info)}`);
  }
}

function renderText(info: ParsedVolcanoTextInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);

  // レベル (VFVO51)
  if (info.alertLevel != null) {
    buf.push(frameDivider(level, width));
    const role = levelRole(info.alertLevel);
    const colorFn = getRoleChalk(role);
    pushClampedFrameLine(buf, level, width, ` ${colorFn(`Lv${info.alertLevel}`)}`);
  }

  // 臨時バッジ（インライン表示）
  if (info.isExtraordinary) {
    const bannerFn = getRoleChalk("volcanoAlertBanner");
    pushClampedFrameLine(buf, level, width, ` ${bannerFn(" 臨時 ")}`);
  }

  // 本文 — getInfoFullText() で全文表示
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const maxLines = fullText ? 999 : getTruncation().volcanoTextLines;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }

  // NextAdvisory
  if (info.nextAdvisory) {
    buf.push(frameDivider(level, width));
    const naFn = getRoleChalk("nextAdvisory");
    for (const wl of wrapFrameLines(level, ` ${naFn(info.nextAdvisory)}`, width)) {
      buf.push(wl);
    }
  }
}

function renderPlume(info: ParsedVolcanoPlumeInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 現象 — pushCard で recap 用サマリー
  if (info.phenomenonCode) {
    const phenRole = phenomenonRole(info.phenomenonCode);
    const phenFn = getRoleChalk(phenRole);
    const phenNames: Record<string, string> = {
      "51": "爆発", "52": "噴火", "56": "噴火多発", "62": "噴火したもよう",
    };
    const name = phenNames[info.phenomenonCode] ?? info.phenomenonCode;
    const cardParts = [phenFn(name)];
    const plumeHeight = visiblePlumeHeightLabel(info, false);
    if (plumeHeight != null) cardParts.push(plumeHeight);
    if (info.plumeDirection) cardParts.push(info.plumeDirection);
    buf.pushCard(frameLine(level, clampFrameContent(` ${cardParts.join("  ")}`, width), width));
  }

  // 火口名
  if (info.craterName) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("火口:")} ${info.craterName}`);
  }

  // 噴煙高度・流向
  const plumeHeight = visiblePlumeHeightDetail(info, false);
  if (plumeHeight != null) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("噴煙:")} ${plumeHeight}`);
  }
  if (info.plumeDirection) {
    pushClampedFrameLine(buf, level, width, ` ${chalk.gray("流向:")} ${info.plumeDirection}`);
  }

  // 風向データ — engine テーブル (3 列固定)。plumeWindSampleRows の間引きは維持し、
  // 間引かれた行数を「他 N 高度」として表末尾に明示する (spec §3)
  if (info.windProfile.length > 0) {
    buf.push(frameDividerLabeled(level, "風向", width));
    const maxWind = getTruncation().plumeWindSampleRows;
    const step = Math.max(1, Math.floor(info.windProfile.length / maxWind));
    const sampled = info.windProfile.filter((_, i) => i % step === 0).slice(0, maxWind);
    renderResponsiveTable(buf, level, width, plumeWindColumns(), sampled);
    const omitted = info.windProfile.length - sampled.length;
    if (omitted > 0) {
      pushClampedFrameLine(buf, level, width, ` ${chalk.gray(`他 ${omitted} 高度 (間引き)`)}`);
    }
  }
}

// ── 取消報 ──

function renderCancel(info: ParsedVolcanoInfo, width: number, buf: RenderBuffer): void {
  const level: FrameLevel = "cancel";
  buf.push(frameTop(level, width));
  const titleContent = ` ${SEVERITY_LABELS[level]} ${info.title}`;
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));
  pushClampedFrameLine(buf, level, width, ` ${info.volcanoName}`);
  // ヘッドライン — 取消対象を特定する情報 (火山名・日時・現象等) を落とさない
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const indentedHeadline = info.headline.replace(/\r\n?/g, "\n").split("\n").map((l) => ` ${l}`).join("\n");
    const wrapped = wrapFrameLines(level, indentedHeadline, width);
    for (let i = 0; i < wrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(wrapped[i]);
      } else {
        buf.push(wrapped[i]);
      }
    }
  }
  buf.push(frameDivider(level, width));
  const cancelFn = getRoleChalk("cancelText");
  pushClampedFrameLine(buf, level, width, ` ${cancelFn("この情報は取り消されました")}`);
}

// ── 公開 API ──

/** 火山電文の表示 */
export function displayVolcanoInfo(
  info: ParsedVolcanoInfo,
  presentation: VolcanoPresentation,
): void {
  const width = getFrameWidth();
  const level = presentation.frameLevel;

  const renderBuf = createRenderBuffer();

  // 前方空行
  renderBuf.pushEmpty();

  // フレーム外バナー（EEW/津波方式に統一）
  const banner = getVolcanoBannerSpec(info, level);
  if (banner != null) {
    pushFullWidthBanner(renderBuf, getRoleChalk(banner.role), banner.text, width);
  }

  if (info.infoType === "取消") {
    renderCancel(info, width, renderBuf);
  } else {
    switch (info.kind) {
      case "alert":
        renderAlert(info, level, width, renderBuf);
        break;
      case "eruption":
        renderEruption(info, level, width, renderBuf);
        break;
      case "ashfall":
        renderAshfall(info, level, width, renderBuf);
        break;
      case "text":
        renderText(info, level, width, renderBuf);
        break;
      case "plume":
        renderPlume(info, level, width, renderBuf);
        break;
    }
  }

  // 共通フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, renderBuf);
  renderBuf.push(frameBottom(level, width));
  renderBuf.pushEmpty();

  flushWithRecap(renderBuf, level, width);
}

// ── VFVO53 バッチ表示 ──

/** 各火山の最大降灰コードを取得 */
function getMaxAshCode(info: ParsedVolcanoAshfallInfo): string {
  let max = "0";
  for (const period of info.ashForecasts) {
    for (const area of period.areas) {
      if (area.ashCode > max) max = area.ashCode;
    }
  }
  return max;
}

/** 各火山の最大降灰名を取得 */
function getMaxAshName(info: ParsedVolcanoAshfallInfo): string {
  let maxCode = "0";
  let maxName = "";
  for (const period of info.ashForecasts) {
    for (const area of period.areas) {
      if (area.ashCode > maxCode) {
        maxCode = area.ashCode;
        maxName = area.ashName;
      }
    }
  }
  return maxName;
}

/** 注目地域（最大降灰コードの地域名、最大3件） */
function getNotableAreas(info: ParsedVolcanoAshfallInfo, maxCount: number): string[] {
  const maxCode = getMaxAshCode(info);
  const names = new Set<string>();
  for (const period of info.ashForecasts) {
    for (const area of period.areas) {
      if (area.ashCode === maxCode) names.add(area.name);
      if (names.size >= maxCount) return [...names];
    }
  }
  return [...names];
}

/** 注目火山かどうか（やや多量72以上 or 小さな噴石75） */
function isNotable(info: ParsedVolcanoAshfallInfo): boolean {
  return isNotableAshCode(getMaxAshCode(info));
}

// ── VFVO53 バッチ row 基盤 (行=火山。単発の AshfallGroupRow と ColumnSpec は共有しない — spec §3) ──
// watch-point: ultra-narrow minWidth 12+8 + sep 3 = 23 <= 56 (幅 60 の innerWidth)

export interface VolcanoBatchRow {
  volcanoName: string;
  maxAshCode: string;
  maxAshName: string;    // 最大降灰 (colorize、notable = ashCode 72+ 強調)
  notableAreas: string;  // 注目地域 (clip → 詳細復元)
  periodCount: number;
  notable: boolean;
}

/** 降灰強度順ソート (現行 :741-746 の localeCompare 踏襲) で row 化する */
export function buildVolcanoBatchRows(items: ParsedVolcanoAshfallInfo[]): VolcanoBatchRow[] {
  const sorted = [...items].sort((a, b) => {
    const codeA = getMaxAshCode(a);
    const codeB = getMaxAshCode(b);
    if (codeB !== codeA) return codeB.localeCompare(codeA);
    return a.volcanoName.localeCompare(b.volcanoName, "ja");
  });
  return sorted.map((info) => ({
    volcanoName: info.volcanoName,
    maxAshCode: getMaxAshCode(info),
    maxAshName: getMaxAshName(info),
    notableAreas: getNotableAreas(info, 3).join(", "),
    periodCount: info.ashForecasts.length,
    notable: isNotable(info),
  }));
}

export function volcanoBatchColumns(mode: ResponsiveDisplayMode): ColumnSpec<VolcanoBatchRow>[] {
  const volcanoCol: ColumnSpec<VolcanoBatchRow> = {
    header: "火山",
    minWidth: 12,
    maxWidth: 24,
    cell: (r) => r.volcanoName,
    colorize: (r, padded) => (r.notable ? chalk.bold(padded) : chalk.white(padded)),
  };
  const ashCol: ColumnSpec<VolcanoBatchRow> = {
    header: "最大降灰",
    minWidth: 8,
    maxWidth: 16, // 「小さな噴石の落下」(全角 8 字 = 幅 16) を全文表示 (spec §9 R3-3)
    cell: (r) => r.maxAshName,
    colorize: (r, padded) =>
      r.notable ? getRoleChalk(ashfallRole(r.maxAshCode))(padded) : chalk.white(padded),
  };
  const areasCol: ColumnSpec<VolcanoBatchRow> = {
    header: "注目地域",
    minWidth: 16,
    maxWidth: mode === "wide" ? 80 : 50,
    wrap: true,
    cell: (r) => r.notableAreas,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const periodCol: ColumnSpec<VolcanoBatchRow> = {
    header: "時間帯数",
    minWidth: 8,
    maxWidth: 8,
    cell: (r) => `${r.periodCount}`,
    colorize: (_r, padded) => chalk.gray(padded),
  };
  if (mode === "ultra-narrow") return [volcanoCol, ashCol];
  if (mode === "standard") return [volcanoCol, ashCol, areasCol];
  return [volcanoCol, ashCol, areasCol, periodCol];
}

/** 末尾サマリ (NO_COLOR 3 重冗長性の 3 点目) */
export function buildBatchSummaryLine(batch: Vfvo53BatchItems): string {
  const notableCount = batch.items.filter(isNotable).length;
  return [chalk.white(`注目 ${notableCount} 火山`), chalk.white(`全 ${batch.items.length} 火山`)].join(
    chalk.gray(" ・ "),
  );
}

/** VFVO53 バッチのまとめ表示 */
export function displayVolcanoAshfallBatch(
  batch: Vfvo53BatchItems,
  presentation: VolcanoPresentation,
): void {
  const width = getFrameWidth();
  const level = presentation.frameLevel;
  const count = batch.items.length;
  const notableCount = batch.items.filter(isNotable).length;

  // バッチタイトル
  const titleBase = `降灰予報（定時） ${count}火山`;
  const title = batch.isTest
    ? `${getRoleChalk("testBadge")(" TEST ")} ${titleBase}`
    : titleBase;

  const buf = createRenderBuffer();
  buf.pushEmpty();

  // フレーム開始
  buf.push(frameTop(level, width));

  // タイトル行
  const titleContent = ` ${title}  ${chalk.gray(SEVERITY_LABELS[level])}`;
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // カード行 (recap用)
  {
    const totalAreas = new Set(
      batch.items.flatMap((i) => i.ashForecasts.flatMap((p) => p.areas).map((a) => a.name)),
    ).size;
    const cardText = notableCount > 0
      ? `${count}火山  注目${notableCount}  計${totalAreas}地域`
      : `${count}火山  計${totalAreas}地域`;
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, clampFrameContent(` ${cardText}`, width), width));
  }

  // テーブル (行=火山、engine 経由。旧: 幅 80 二分岐 :748/:766)
  buf.push(frameDivider(level, width));
  const mode = decideDisplayMode(width);
  const rows = buildVolcanoBatchRows(batch.items);
  renderResponsiveTable(buf, level, width, volcanoBatchColumns(mode), rows);
  const details: DetailItem[] = [];
  // hidden-only 化 (spec §2.4): clip 検知用の hidden:false 列 (火山/最大降灰) は不要になったため削除。
  // 幅で隠れる列 (注目地域=ultra-narrow, 時間帯数=非 wide) のみ回収する。
  collectDetailForTable(
    rows,
    (r) => r.volcanoName,
    [
      { header: "注目地域", value: (r) => r.notableAreas, hidden: mode === "ultra-narrow" },
      { header: "時間帯数", value: (r) => `${r.periodCount} 時間帯`, hidden: mode !== "wide" },
    ],
    details,
  );
  pushVolcanoDetailBlock(buf, level, width, details);
  buf.push(frameDividerLabeled(level, "サマリ", width));
  pushClampedFrameLine(buf, level, width, ` ${buildBatchSummaryLine(batch)}`);

  // 共通フッター
  renderFooter(level, "VFVO53", batch.reportDateTime, batch.items[0].publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}
