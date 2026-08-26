import chalk from "chalk";
import {
  ParsedWeatherWarning,
  WeatherItem,
  WeatherKind,
  WeatherSeverity,
  DisplaySeverity,
  OfficialAlertLevel,
  Vpws50Diff,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
} from "../types";
import {
  resolvePhenomenonFamily,
  resolveDisplaySeverity,
  DISPLAY_SEVERITY_RANK,
} from "../dmdata/weather-warning-level";
import {
  getDisplaySeverityTierPrefix,
  getDisplaySeverityText,
  getDisplaySeverityChip,
  renderDividerChip,
  DISPLAY_SEVERITY_DIVIDER_LABEL,
} from "./weather-warning-level-theme";
import {
  FrameLevel,
  FrameLinePurpose,
  SEVERITY_LABELS,
  frameLine,
  frameDivider,
  frameDividerColored,
  frameDividerLabeledColored,
  frameTop,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  getFrameWidth,
  wrapFrameLines,
  wrapFrameLinesColored,
  pushWrappedFrameLine,
  visualWidth,
  clipToVisualWidth,
} from "./formatter";
import { predictionRegionCodeToCluster } from "./weather-area-cluster";

// ── 型 ──

type ListSeverity = "specialWarning" | "warning" | "advisory";

interface VpwsItemRow {
  areaName: string;
  /** DISPLAY_SEVERITY_RANK ベースのソートキー (Codex 最終レビュー F-4: unknown 含む降順) */
  maxDisplayRank: number;
  /** 旧 3 段階の最大 (compact の警/注カウント互換用)。unknown のみの予報区は null */
  maxSeverity: ListSeverity | null;
  tokens: string[];           // displaySeverity 降順の整形済みトークン
}

interface Vpws50AggregateResult {
  rows: VpwsItemRow[];
  releasedItems: { areaName: string; lastKinds: string[] }[];
}

// ── 定数 ──

/** Kind.code → 短縮ラベル (R06 公式コード表ベース) */
const KIND_CODE_LABELS: Record<string, string> = {
  "00": "解除",  // 通常呼ばれない (release は別 section へ分離)
  "02": "暴風雪",
  "03": "大雨",
  "04": "洪水",
  "05": "暴風",
  "06": "大雪",
  "07": "波浪",
  "08": "高潮",
  "09": "土砂災害",
  "10": "大雨",
  "12": "大雪",
  "13": "風雪",
  "14": "雷",
  "15": "強風",
  "16": "波浪",
  "17": "融雪",
  "18": "洪水",
  "19": "高潮",
  "20": "濃霧",
  "21": "乾燥",
  "22": "なだれ",
  "23": "低温",
  "24": "霜",
  "25": "着氷",
  "26": "着雪",
  "27": "その他注意報",
  "29": "土砂災害",
  "32": "暴風雪",
  "33": "大雨",
  "35": "暴風",
  "36": "大雪",
  "37": "波浪",
  "38": "高潮",
  "39": "土砂災害",
  "43": "大雨",
  "48": "高潮",
  "49": "土砂災害",
};

/** SEVERITY_RANK (既存 weather-formatter.ts と同値) */
const SEVERITY_RANK: Record<WeatherSeverity, number> = {
  specialWarning: 4,
  warning: 3,
  advisory: 2,
  release: 1,
  unknown: 0,
};

// ── helper ──

/** Code map 主 + regex fallback */
function kindToShortLabel(kind: WeatherKind): string {
  const fromMap = KIND_CODE_LABELS[kind.code];
  if (fromMap != null) return fromMap;
  const stripped = kind.name
    .replace(/^レベル[０-９0-9]+/, "")
    .replace(/特別警報$/, "")
    .replace(/危険警報$/, "")
    .replace(/警戒情報$/, "")
    .replace(/警報$/, "")
    .replace(/注意報$/, "")
    .trim();
  return stripped || kind.name;
}

/** chalk が色対応しているか (chalk.level > 0 主体で判定、非TTY環境のテストとも整合) */
function isColorAvailable(): boolean {
  return chalk.level > 0;
}

// ── Phase C Task 6: displaySeverity トークン (tier prefix + L 後置注釈) ──

/** bg-chip にする displaySeverity (確定 chip 運用ルール) */
const CHIP_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
  "officialL5", "officialL4", "nonLevelSpecial",
]);

/**
 * Phase C: kind (code+name) → `☆大雨(L3)` / `◆暴風` 形式の色付きトークン。
 * production の差分経路は formatDisplayTokenResolved を使う。
 * これは {code,name} API のテスト/将来 Task 7-8 用。
 * @internal
 */
export function formatDisplayToken(kind: { code: string; name: string }): string {
  const family = resolvePhenomenonFamily(kind.code, kind.name);
  const r = resolveDisplaySeverity(kind.code, kind.name, family);
  // kindToShortLabel は severity を短縮名解決に使わないため "unknown" 固定で渡す
  const shortName = kindToShortLabel({ code: kind.code, name: kind.name, severity: "unknown" });
  return formatDisplayTokenResolved(shortName, r.displaySeverity, r.officialAlertLevel);
}

/** 解決済み displaySeverity を直接受ける版 (transition 経由で使う) */
function formatDisplayTokenResolved(
  shortName: string,
  displaySeverity: DisplaySeverity,
  officialAlertLevel: OfficialAlertLevel | null,
): string {
  const text = `${getDisplaySeverityTierPrefix(displaySeverity)}${displayTokenLabel(shortName, officialAlertLevel)}`;
  if (!isColorAvailable()) return text;
  return CHIP_SEVERITIES.has(displaySeverity)
    ? getDisplaySeverityChip(displaySeverity)(text)
    : getDisplaySeverityText(displaySeverity)(text);
}

/** 短縮名 + L 後置注釈 (officialAlertLevel が無い災害は注釈なし) */
function displayTokenLabel(
  shortName: string,
  officialAlertLevel: OfficialAlertLevel | null,
): string {
  return officialAlertLevel != null ? `${shortName}(L${officialAlertLevel})` : shortName;
}

/** prev 側トークン (グレー、tier prefix + L 注釈は維持) — 昇降格/解除の左側に使う */
function formatPrevDisplayToken(
  shortName: string,
  prevDisplaySeverity: DisplaySeverity | null,
  prevOfficialAlertLevel: OfficialAlertLevel | null,
): string {
  const prefix = getDisplaySeverityTierPrefix(prevDisplaySeverity ?? "unknown");
  return chalk.gray(`${prefix}${displayTokenLabel(shortName, prevOfficialAlertLevel)}`);
}

// ── 集約 ──

/** 1 WeatherItem を VpwsItemRow に変換。非 release Kind が 1 つもなければ null */
function buildVpws50Row(item: WeatherItem): VpwsItemRow | null {
  // Codex 最終レビュー F-4: 旧 3 段階フィルタ → displaySeverity ベースの release 除外に変更。
  // unknown kind も `?謎` トークンとして表示対象に含める (unknown-only 電文の「発令なし」化防止)。
  // 旧 severity=release の防御除外は infoToSnapshot (vpws50-state.ts) と同規則
  const resolved = item.kinds
    .map((k) => {
      const family = resolvePhenomenonFamily(k.code, k.name);
      const r = resolveDisplaySeverity(k.code, k.name, family);
      return { kind: k, displaySeverity: r.displaySeverity };
    })
    .filter((e) => e.displaySeverity !== "release" && e.kind.severity !== "release");
  if (resolved.length === 0) return null;
  const sorted = [...resolved].sort(
    (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity]
  );
  // 旧 3 段階の最大 (compact カウント互換用)。unknown のみなら null
  let maxSeverity: ListSeverity | null = null;
  for (const e of resolved) {
    const s = e.kind.severity;
    if (s === "specialWarning" || s === "warning" || s === "advisory") {
      if (maxSeverity == null || SEVERITY_RANK[s] > SEVERITY_RANK[maxSeverity]) maxSeverity = s;
    }
  }
  return {
    areaName: item.areaName,
    maxDisplayRank: DISPLAY_SEVERITY_RANK[sorted[0].displaySeverity],
    maxSeverity,
    // Task 7: 旧 `大雨[警]` 形式から displaySeverity トークン (`☆大雨(L3)`) に統一
    tokens: sorted.map((e) => formatDisplayToken({ code: e.kind.code, name: e.kind.name })),
  };
}

/** 府県予報区等レイヤーから rows と releasedItems を集約 */
function aggregateVpws50ByForecastZone(
  info: ParsedWeatherWarning
): Vpws50AggregateResult {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (!layer) return { rows: [], releasedItems: [] };

  const rows: VpwsItemRow[] = [];
  for (const item of layer.items) {
    const row = buildVpws50Row(item);
    if (row != null) rows.push(row);
  }
  // 行間 displaySeverity rank 降順 (Array.sort は安定、電文出現順を維持。
  // F-4: unknown rows も rank 30 で末尾側に並ぶ)
  rows.sort((a, b) => b.maxDisplayRank - a.maxDisplayRank);

  // 解除セクション: statuses[].lastKindName から抽出 (R1 指摘の核心)
  const releasedItems: { areaName: string; lastKinds: string[] }[] = [];
  for (const item of layer.items) {
    const released = item.statuses
      .filter((s) => s.status === "解除" && s.lastKindName != null)
      .map((s) => s.lastKindName!);
    if (released.length > 0) {
      releasedItems.push({ areaName: item.areaName, lastKinds: released });
    }
  }

  return { rows, releasedItems };
}

// ── renderer ──

/** 府県予報区等レイヤーが info に存在するか (branch 判定用) */
function hasForecastZoneLayer(info: ParsedWeatherWarning): boolean {
  return info.layers.some((l) => l.type.includes("府県予報区等"));
}

// ── Phase C Task 8: フレーム罫線色の注入 (確定配色言語) ──

/**
 * 本文罫線色 (Task 8 配色言語)。tail = 本文・footer 直前 divider・下辺の罫線色
 * (白系。取消は release 単色)。上辺+タイトル系の head 色は weather-formatter.ts 側が
 * frameTopColored / frameLineColored に直接使うため、ここには注入しない。
 * 未指定時は従来の frameLine / frameDivider (level 色) にフォールバック
 * (REPL detail 等の既存呼び出し互換)。
 */
export interface Vpws50BodyBorderColors {
  tail: (s: string) => string;
}

/** 本文系 frame 行。可変本文は用途別 wrapper 経由で幅を証明する。 */
function pushBodyLine(
  buf: ReturnType<typeof createRenderBuffer>,
  level: FrameLevel,
  content: string,
  width: number,
  colors: Vpws50BodyBorderColors | undefined,
  purpose: FrameLinePurpose = "prose",
): void {
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose, ...(colors == null ? {} : { borderColor: colors.tail }) },
    content,
  );
}

/** 本文系 divider (colors 指定時は tail 色、未指定は level 色) */
function bodyDivider(
  level: FrameLevel,
  width: number,
  colors: Vpws50BodyBorderColors | undefined,
): string {
  return colors == null
    ? frameDivider(level, width)
    : frameDividerColored(level, colors.tail, width);
}

/** 本文系折返し行 (colors 指定時は tail 色、未指定は level 色) */
function bodyWrap(
  level: FrameLevel,
  content: string,
  width: number,
  colors: Vpws50BodyBorderColors | undefined,
  indent: number = 0,
): string[] {
  return colors == null
    ? wrapFrameLines(level, content, width, indent)
    : wrapFrameLinesColored(level, colors.tail, content, width, indent);
}

// ── Phase C Task 8: バナー判定 + 本文 ──

/** バナー発火対象の displaySeverity (Codex R2 確定条件) */
const BANNER_HIGH_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
  "officialL5", "officialL4", "nonLevelSpecial",
]);

/**
 * バナー発火判定 (Codex R2 確定条件)。戻り値 = バナー色の displaySeverity、null = 発火なし。
 * ① 取消 → release ② added/upgraded の new displaySeverity に L5/L4/nonLevelSpecial が
 * あれば最高の 1 点 ③ 初回起動は現況 max が同等なら発火。
 * 解除のみ・降格のみ・L3 以下のみは発火しない (全国集約で頻度が高く騒音になるため —
 * VPWW の「解除のみ → cancel バナー」とは意図的に違う)。
 */
export function vpws50BannerSeverity(
  info: ParsedWeatherWarning,
  diff: Vpws50Diff | undefined,
): DisplaySeverity | null {
  if (info.infoType === "取消") return "release";
  if (diff == null || diff.confidence === "unsafe") return null;
  // 初回起動: 現況 max が HIGH なら発火
  if (diff.isFirstReport) {
    return info.maxDisplaySeverity != null && BANNER_HIGH_SEVERITIES.has(info.maxDisplaySeverity)
      ? info.maxDisplaySeverity : null;
  }
  // added/upgraded の new displaySeverity に HIGH があれば最高の 1 点
  let best: DisplaySeverity | null = null;
  for (const group of [diff.added, diff.upgraded]) {
    for (const a of group) {
      for (const c of a.changes) {
        const ds = c.newDisplaySeverity;
        if (ds != null && BANNER_HIGH_SEVERITIES.has(ds)) {
          if (best == null || DISPLAY_SEVERITY_RANK[ds] > DISPLAY_SEVERITY_RANK[best]) best = ds;
        }
      }
    }
  }
  return best;
}

/**
 * バナー本文: `★ 土砂災害(L4) 千葉県北西部 ほか2予報区 新規1/昇格2` (部品優先度落とし)。
 * 幅不足時は 遷移サマリー → 地域 の順に部品を落とし、最後は clip で末尾省略。
 * (Codex R3 P1: 初回起動はフォールバックで現況グループから代表を取る)
 */
export function buildVpws50BannerText(
  severity: DisplaySeverity,
  info: ParsedWeatherWarning,
  diff: Vpws50Diff | undefined,
  maxWidth: number,
): string {
  if (info.infoType === "取消") {
    return clipToVisualWidth(`気象警報・注意報（全国集約） 取消`, maxWidth);
  }
  type Hit = { areaName: string; shortName: string; level: OfficialAlertLevel | null };
  const hits: Hit[] = [];
  if (diff != null) {
    for (const group of [diff.added, diff.upgraded]) {
      for (const a of group) {
        for (const c of a.changes) {
          if (c.newDisplaySeverity === severity) {
            hits.push({ areaName: a.areaName, shortName: c.kindShortName, level: c.newOfficialAlertLevel });
          }
        }
      }
    }
  }
  let trailing = "";  // 部品 3: 遷移サマリー or 起動時ラベル
  if (hits.length === 0 && diff != null && diff.isFirstReport) {
    const groups = buildVpws50DisplayGroups(info);
    const rep = groups.find((g) => g.displaySeverity === severity);
    if (rep != null) {
      const repArea = rep.areas[0];
      hits.push({
        areaName: repArea != null ? repArea.areaName : "",
        shortName: rep.kindShortName,
        level: rep.officialAlertLevel,
      });
      trailing = "起動時現況";
    }
  } else {
    // 到達条件: hits 1 件以上、または diff==null/非初回 — diff==null で取消以外は
    // vpws50BannerSeverity が null を返すため実際には到達しない (防御的フォールバック)
    const addedN = diff?.added.length ?? 0;
    const upN = diff?.upgraded.length ?? 0;
    trailing = [addedN > 0 ? `新規${addedN}` : "", upN > 0 ? `昇格${upN}` : ""].filter(Boolean).join("/");
  }
  const prefix = getDisplaySeverityTierPrefix(severity);
  const first: Hit | undefined = hits[0];
  const label = first == null
    ? DISPLAY_SEVERITY_DIVIDER_LABEL[severity]
    : first.level != null ? `${first.shortName}(L${first.level})` : first.shortName;
  const part1 = `${prefix} ${label}`;                                   // 絶対残す
  const areaCount = new Set(hits.map((h) => h.areaName)).size;
  const part2 = first == null ? "" :
    areaCount > 1 ? `${first.areaName} ほか${areaCount - 1}予報区` : first.areaName;
  const join = (p: string[]): string => p.filter((s) => s.length > 0).join("　");
  let text = join([part1, part2, trailing]);
  if (visualWidth(text) <= maxWidth) return text;
  text = join([part1, part2]);
  if (visualWidth(text) <= maxWidth) return text;
  text = join([part1]);
  if (visualWidth(text) <= maxWidth) return text;
  return clipToVisualWidth(text, maxWidth);
}

// ── 新 6 状態分岐用 ヘルパ ──

/** サブ行 (タイトル直下、インデント 2、グレー、区切り線なし) を生成 */
function renderSubline(
  text: string,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  pushBodyLine(buf, level, `  ${chalk.gray(text)}`, width, colors);
}

/** 差分セクション (★ 今回の変化) を描く。added/upgraded/downgraded のみ (released は別枠) */
function renderChangeSection(
  diff: Vpws50Diff,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  pushBodyLine(buf, level, "★ 今回の変化", width, colors, "type");
  for (const a of diff.added) {
    const kindsText = a.changes
      .map((c) => formatDisplayTokenResolved(
        c.kindShortName, c.newDisplaySeverity ?? "unknown", c.newOfficialAlertLevel))
      .join(" ");
    const line = `  ▲ 新規発令   ${chalk.white(a.areaName)}  ${kindsText}`;
    for (const wrapped of bodyWrap(level, line, width, colors)) {
      buf.push(wrapped);
    }
  }
  for (const a of diff.upgraded) {
    for (const c of a.changes) {
      const prevToken = formatPrevDisplayToken(
        c.kindShortName, c.prevDisplaySeverity, c.prevOfficialAlertLevel);
      const arrow = chalk.gray(" → ");
      const newToken = formatDisplayTokenResolved(
        c.kindShortName, c.newDisplaySeverity ?? "unknown", c.newOfficialAlertLevel);
      const line = `  ▲ 昇格       ${chalk.white(a.areaName)}  ${prevToken}${arrow}${newToken}`;
      for (const wrapped of bodyWrap(level, line, width, colors)) {
        buf.push(wrapped);
      }
    }
  }
  for (const a of diff.downgraded) {
    for (const c of a.changes) {
      const prevToken = formatPrevDisplayToken(
        c.kindShortName, c.prevDisplaySeverity, c.prevOfficialAlertLevel);
      const arrow = chalk.gray(" → ");
      const newToken = formatDisplayTokenResolved(
        c.kindShortName, c.newDisplaySeverity ?? "unknown", c.newOfficialAlertLevel);
      const line = `  ▽ 降格       ${chalk.white(a.areaName)}  ${prevToken}${arrow}${newToken}`;
      for (const wrapped of bodyWrap(level, line, width, colors)) {
        buf.push(wrapped);
      }
    }
  }
}

/** 解除セクション (▼ 今回解除、独立) を描く */
function renderReleasedSection(
  diff: Vpws50Diff,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  if (diff.released.length === 0) return;
  buf.push(bodyDivider(level, width, colors));
  pushBodyLine(buf, level, "▼ 今回解除", width, colors, "type");
  for (const a of diff.released) {
    const kindsText = a.changes.map((c) =>
      formatPrevDisplayToken(c.kindShortName, c.prevDisplaySeverity, c.prevOfficialAlertLevel),
    ).join(" ");
    const line = `  ${chalk.white(a.areaName)}  ${kindsText}`;
    for (const wrapped of bodyWrap(level, line, width, colors)) {
      buf.push(wrapped);
    }
  }
}

/**
 * 府県予報区等レイヤーから displaySeverity グループを組み立てる (RANK 降順、release 除外)。
 * kindCode 単位でグループし、areaCode は重複排除、同 rank は電文出現順 (Array.sort の安定性)。
 * Task 8 のバナー本文フォールバックでも使う。
 */
export function buildVpws50DisplayGroups(info: ParsedWeatherWarning): Vpws50DisplayKindGroup[] {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (!layer) return [];
  const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
  for (const item of layer.items) {
    for (const k of item.kinds) {
      const family = resolvePhenomenonFamily(k.code, k.name);
      const r = resolveDisplaySeverity(k.code, k.name, family);
      if (r.displaySeverity === "release") continue;
      let group = byKindCode.get(k.code);
      if (group == null) {
        group = {
          kindCode: k.code,
          kindShortName: kindToShortLabel(k),
          kindName: k.name,
          displaySeverity: r.displaySeverity,
          officialAlertLevel: r.officialAlertLevel,
          areas: [],
        };
        byKindCode.set(k.code, group);
      }
      if (!group.areas.some((a) => a.areaCode === item.areaCode)) {
        group.areas.push({ areaName: item.areaName, areaCode: item.areaCode });
      }
    }
  }
  return Array.from(byKindCode.values()).sort(
    (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
  );
}

/** 現況サマリの 1 displaySeverity セクション。useCluster=true なら地方クラスタ集約 (注意報級用) */
function renderDisplaySeveritySection(
  groups: Vpws50DisplayKindGroup[],
  displaySeverity: DisplaySeverity,
  useCluster: boolean,
  styleLevel: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
): void {
  const sectionGroups = groups.filter((g) => g.displaySeverity === displaySeverity);
  if (sectionGroups.length === 0) return;
  const sectionColor = getDisplaySeverityText(displaySeverity);
  const chipLabel = renderDividerChip(displaySeverity, DISPLAY_SEVERITY_DIVIDER_LABEL[displaySeverity]);
  buf.push(frameDividerLabeledColored(styleLevel, sectionColor, chipLabel, width));
  for (const g of sectionGroups) {
    const token = formatDisplayTokenResolved(g.kindShortName, g.displaySeverity, g.officialAlertLevel);
    // 折返し invariant: 色 token は行頭 1 個、以後は " / " 区切りの無着色テキスト
    // (wrapSingleLine が " / " で分割するため、折り返しても token 内に ANSI 断面ができない)
    const tail = useCluster
      ? [
          ...Array.from(new Set(g.areas.map((a) => predictionRegionCodeToCluster(a.areaCode)))),
          `${g.areas.length}予報区`,
        ]
      : g.areas.map((a) => a.areaName);
    const line = `  ${token} / ${tail.join(" / ")}`;
    for (const wrapped of wrapFrameLinesColored(styleLevel, sectionColor, line, width, 4)) {
      buf.push(wrapped);
    }
  }
}

/** 地方クラスタ集約で表示する displaySeverity (注意報級)。それ以外は予報区フル名 */
const CLUSTER_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
  "officialL2", "nonLevelAdvisory", "officialL1",
]);

/**
 * グループ列を RANK 降順セクションで描画。unknown は nonLevelWarning 直後
 * (VPWP50 Phase B と同じ見落とし防止)。info 経由と display 経由の両方が使う。
 * groups は未ソートでも良い (内部で RANK 降順に再ソートする)。
 */
function renderSummarySections(
  groups: Vpws50DisplayKindGroup[],
  styleLevel: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
): void {
  const present = Array.from(new Set(groups.map((g) => g.displaySeverity)));
  const hasUnknown = present.includes("unknown");
  const ordered = present
    .filter((ds) => ds !== "unknown")
    .sort((a, b) => DISPLAY_SEVERITY_RANK[b] - DISPLAY_SEVERITY_RANK[a]);
  const result: DisplaySeverity[] = [];
  for (const ds of ordered) {
    result.push(ds);
    if (ds === "nonLevelWarning" && hasUnknown) result.push("unknown");
  }
  if (hasUnknown && !result.includes("unknown")) result.push("unknown");
  for (const ds of result) {
    renderDisplaySeveritySection(groups, ds, CLUSTER_SEVERITIES.has(ds), styleLevel, width, buf);
  }
}

/** サマリ行 (`■ 現況サマリ  N予報区  特X / 警Y / 注Z  (詳細: ...)`) を push する */
function pushSummaryHeadline(
  totalAreas: number,
  specialAreas: number,
  warningAreas: number,
  advisoryAreas: number,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  // 旧 3 段階カウントは互換維持 (displaySeverity セクション化後も全体感を 1 行で掴む用)
  const counts = `特${specialAreas} / 警${warningAreas} / 注${advisoryAreas}`;
  const hint = chalk.gray("(詳細: `detail vpws50`)");
  const line = `■ 現況サマリ  ${totalAreas}予報区  ${counts}  ${hint}`;
  for (const wrapped of bodyWrap(level, line, width, colors, 2)) {
    buf.push(wrapped);
  }
}

/** 現況サマリ (■ サマリ行 + displaySeverity divider chip セクション) を描く */
function renderCurrentSummary(
  info: ParsedWeatherWarning,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (!layer) return;

  const allAreas = new Set<string>();
  const specialAreas = new Set<string>();
  const warningAreas = new Set<string>();
  const advisoryAreas = new Set<string>();
  for (const item of layer.items) {
    for (const k of item.kinds) {
      // Codex 最終レビュー F-5: N (totalAreas) は「非 release kind を 1 つ以上持つ予報区数」
      // (displaySeverity ベース、unknown を含む)。vpws50-state.buildCurrentAreasForDisplay の
      // totalAreas と同規則に揃える (unknown-only で「0予報区 + unknown セクション」の矛盾防止)。
      // 特/警/注の内訳は旧 3 段階のまま互換維持
      const family = resolvePhenomenonFamily(k.code, k.name);
      const r = resolveDisplaySeverity(k.code, k.name, family);
      if (r.displaySeverity !== "release" && k.severity !== "release") {
        allAreas.add(item.areaCode);
      }
      if (k.severity === "specialWarning") {
        specialAreas.add(item.areaCode);
      } else if (k.severity === "warning") {
        warningAreas.add(item.areaCode);
      } else if (k.severity === "advisory") {
        advisoryAreas.add(item.areaCode);
      }
    }
  }
  pushSummaryHeadline(
    allAreas.size, specialAreas.size, warningAreas.size, advisoryAreas.size,
    level, width, buf, colors,
  );
  renderSummarySections(buildVpws50DisplayGroups(info), level, width, buf);
}

/** Plan-R1: rollback 後 state の現況サマリを描画 (info を使わず diff.currentAreasForDisplay を使う) */
function renderCurrentSummaryFromDisplay(
  display: Vpws50CurrentAreasForDisplay,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  pushSummaryHeadline(
    display.totalAreas, display.specialAreas, display.warningAreas, display.advisoryAreas,
    level, width, buf, colors,
  );
  renderSummarySections(display.kinds, level, width, buf);
}

/** 凡例行 (Phase C: tier prefix + L 表記の新凡例。色付きでも NO_COLOR でも同じ文言) */
function renderLegend(
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  buf.push(bodyDivider(level, width, colors));
  const legend = chalk.gray(
    "凡例: ★★L5/★L4/☆L3/△L2=公式警戒レベル (L表記)  ◆◆=特別警報級 ◆=警報級 △=注意報級 ?=未知",
  );
  for (const wrapped of bodyWrap(level, legend, width, colors)) {
    buf.push(wrapped);
  }
}

// ── 旧 list 用の中核ロジック (差分情報が無い fallback 時のために維持) ──

/** 差分情報無しの fallback: 既存ロジック相当でフル表示する */
function renderLegacyVpws50List(
  info: ParsedWeatherWarning,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  const { rows, releasedItems } = aggregateVpws50ByForecastZone(info);

  // セクションヘッダ (R2 修正: rows=0 でも凡例/解除を出すため必ず先に push)
  buf.push(bodyDivider(level, width, colors));
  pushBodyLine(
    buf,
    level,
    chalk.gray("[気象警報・注意報（府県予報区等）]"),
    width,
    colors,
    "type",
  );

  if (rows.length === 0) {
    pushBodyLine(buf, level, chalk.gray("現在発令中の警報・注意報はありません"), width, colors);
  } else {
    const maxAreaWidth = Math.max(...rows.map((r) => visualWidth(r.areaName)));
    for (const row of rows) {
      const areaWidth = visualWidth(row.areaName);
      const fillWidth = Math.max(0, maxAreaWidth - areaWidth);
      const leader = fillWidth >= 4
        ? ` ${chalk.gray("─".repeat(fillWidth - 2))} `
        : " ".repeat(fillWidth + 2);
      // Task 7: トークン間区切りを " / " に統一 (wrapSingleLine の分割 delimiter と一致させ、
      // 折返しでも各 token が独立 chunk として ANSI を保つ — token 内に " / " は無い)
      const tokensText = row.tokens.join(" / ");
      const line = `  ${chalk.white(row.areaName)}${leader}${tokensText}`;
      for (const wrapped of bodyWrap(level, line, width, colors)) {
        buf.push(wrapped);
      }
    }
  }

  // 凡例
  renderLegend(level, width, buf, colors);

  // 解除セクション (lastKindName をフル名で出す)
  if (releasedItems.length > 0) {
    buf.pushEmpty();
    pushBodyLine(
      buf,
      level,
      chalk.gray(`■ 今回解除された警報・注意報 (${releasedItems.length}予報区)`),
      width,
      colors,
      "type",
    );
    for (const item of releasedItems) {
      const lastKindsText = item.lastKinds.join("、");
      const line = `  ${chalk.white(item.areaName)} — ${chalk.gray(lastKindsText)}`;
      for (const wrapped of bodyWrap(level, line, width, colors)) {
        buf.push(wrapped);
      }
    }
  }
}

// ── 6 状態分岐 メインエントリ ──

/**
 * VPWS50 normal モード本体 (RenderBuffer に push)。
 * diff があれば 6 状態 (unsafe / cancelRollback / unchanged-compact /
 * unchanged-recap / firstReport / hasChanges) に分岐。
 * diff が無い場合は legacy fallback 表示。
 */
function displayVpws50List(
  info: ParsedWeatherWarning,
  diff: Vpws50Diff | undefined,
  level: FrameLevel,
  width: number,
  buf: ReturnType<typeof createRenderBuffer>,
  colors?: Vpws50BodyBorderColors,
): void {
  // (1) unsafe: §4.7
  if (diff?.confidence === "unsafe") {
    renderSubline("解析不能 — state を更新せず維持", level, width, buf, colors);
    buf.push(bodyDivider(level, width, colors));
    const reasonText = diff.unsafeReason === "layer_missing"
      ? "府県予報区レイヤーを抽出できませんでした"
      : diff.unsafeReason === "abnormal_release_rate"
        ? "異常な解除率を検出しました"
        : "解析できませんでした";
    pushBodyLine(buf, level, `⚠ ${reasonText}`, width, colors, "diagnostic");
    pushBodyLine(buf, level, "  入力電文の構造を確認してください", width, colors, "diagnostic");
    return;
  }

  // (2) 取消ロールバック: §4.8 (colors は head=tail=release 単色で注入される)
  if (diff?.isCancelRollback) {
    renderSubline("取消報 — 直前報を巻き戻し", level, width, buf, colors);
    buf.push(bodyDivider(level, width, colors));
    pushBodyLine(buf, level, "直前報を取り消しました", width, colors);
    pushBodyLine(buf, level, "現況を巻き戻し後の状態に戻して再表示します", width, colors);
    buf.push(bodyDivider(level, width, colors));
    if (diff.currentAreasForDisplay != null) {
      renderCurrentSummaryFromDisplay(diff.currentAreasForDisplay, level, width, buf, colors);
    } else {
      pushBodyLine(
        buf,
        level,
        "現況: state を保持していません (次回受信時にフル現況を表示します)",
        width,
        colors,
        "diagnostic",
      );
    }
    return;
  }

  // (3) 変化なし + 定期再掲なし: §4.3 compact 1 行
  // 本来は weather-formatter.ts の早期 return で捕捉されるが、防御的に処理
  if (diff?.isUnchanged && !diff.shouldRecap) {
    displayVpws50Unchanged(info);
    return;
  }

  // (4) 変化なし + 定期再掲: §4.5
  if (diff?.isUnchanged && diff.shouldRecap) {
    renderSubline("定期再掲 (60 分間隔) — 警報級発令中", level, width, buf, colors);
    buf.push(bodyDivider(level, width, colors));
    renderCurrentSummary(info, level, width, buf, colors);
    renderLegend(level, width, buf, colors);
    return;
  }

  // (5) 初回起動: §4.6
  if (diff?.isFirstReport) {
    renderSubline("起動時現況", level, width, buf, colors);
    buf.push(bodyDivider(level, width, colors));
    renderCurrentSummary(info, level, width, buf, colors);
    renderLegend(level, width, buf, colors);
    return;
  }

  // (6) 差分あり: §4.1
  if (
    diff != null &&
    (diff.added.length > 0 ||
      diff.upgraded.length > 0 ||
      diff.downgraded.length > 0 ||
      diff.released.length > 0)
  ) {
    const changeCount = diff.added.length + diff.upgraded.length + diff.downgraded.length;
    const releasedCount = diff.released.length;
    renderSubline(
      `更新報 — ${changeCount + releasedCount}予報区 (変化 ${changeCount} / 解除 ${releasedCount})`,
      level,
      width,
      buf,
      colors,
    );

    if (changeCount > 0) {
      buf.push(bodyDivider(level, width, colors));
      renderChangeSection(diff, level, width, buf, colors);
    }
    if (releasedCount > 0) {
      renderReleasedSection(diff, level, width, buf, colors);
    }
    buf.push(bodyDivider(level, width, colors));
    renderCurrentSummary(info, level, width, buf, colors);
    renderLegend(level, width, buf, colors);
    return;
  }

  // フォールバック (diff 無し or 6 状態いずれにも該当しない): 既存 list ロジック
  renderLegacyVpws50List(info, level, width, buf, colors);
}

/** VPWS50 compact モード (1 行表示)、`[[警告]]` の二重括弧バグなし */
function displayVpws50Compact(
  info: ParsedWeatherWarning,
  level: FrameLevel,
  diff?: Vpws50Diff,
): void {
  const levelLabel = SEVERITY_LABELS[level];
  const typeLabel = "気象警報・注意報（全国集約）";

  // Codex 最終レビュー F-2: unsafe / cancelRollback は layer 不在・空がありうるため、
  // 集約カウント (「発令なし」化) より先に専用 1 行で compact ユーザーに届ける
  if (diff?.confidence === "unsafe") {
    console.log(
      [levelLabel, info.type, typeLabel, "解析不能 — state を更新せず維持"].join("  "),
    );
    return;
  }
  if (diff?.isCancelRollback) {
    const parts: string[] = [levelLabel, info.type, typeLabel, "取消報 — 直前報を巻き戻し"];
    const display = diff.currentAreasForDisplay;
    if (display != null) {
      parts.push(`特${display.specialAreas} / 警${display.warningAreas} / 注${display.advisoryAreas}`);
    }
    console.log(parts.join("  "));
    return;
  }

  const { rows } = aggregateVpws50ByForecastZone(info);
  const warnZones = rows.filter(
    (r) => r.maxSeverity === "warning" || r.maxSeverity === "specialWarning"
  ).length;
  const advZones = rows.filter((r) => r.maxSeverity === "advisory").length;
  // Codex 最終レビュー F-4: unknown のみの予報区 (maxSeverity=null)。警/注には数えず、
  // unknown-only 電文が「発令なし」に化けないよう独立カウントで出す
  const unknownZones = rows.filter((r) => r.maxSeverity == null).length;

  const parts: string[] = [levelLabel, info.type, typeLabel];

  if (info.infoType === "取消") {
    parts.push("取消");
  } else if (warnZones === 0 && advZones === 0 && unknownZones === 0) {
    parts.push("発令なし");
  } else {
    const sevParts: string[] = [];
    if (warnZones > 0) sevParts.push(`警報 ${warnZones}予報区`);
    if (advZones > 0) sevParts.push(`注意報 ${advZones}予報区`);
    if (unknownZones > 0) sevParts.push(`未知 ${unknownZones}予報区`);
    parts.push(sevParts.join(" / "));
  }
  // Phase C Task 8 (Codex R3 P1): 高 displaySeverity は compact でも強調ラベルで追随
  // (バナー発火対象と同じ集合 = BANNER_HIGH_SEVERITIES に統一)
  const maxDs = info.maxDisplaySeverity;
  if (maxDs != null && BANNER_HIGH_SEVERITIES.has(maxDs)) {
    parts.push(DISPLAY_SEVERITY_DIVIDER_LABEL[maxDs]);
  }
  console.log(parts.join("  "));
}

/**
 * detail renderer (ui/detail-renderers.ts) から呼ぶ薄い表示関数。
 * フレーム + 現況サマリを出す (REPL `detail vpws50` 用)。
 */
export function displayVpws50FromState(display: Vpws50CurrentAreasForDisplay): void {
  const level: FrameLevel = "info";
  const width = getFrameWidth();
  const buf = createRenderBuffer();
  buf.pushEmpty();
  buf.push(frameTop(level, width));
  buf.push(frameLine(level, "気象警報・注意報（全国集約） [情報]", width));
  buf.push(frameLine(level, "  最新受信内容 (REPL detail)", width));
  buf.push(frameDivider(level, width));
  renderCurrentSummaryFromDisplay(display, level, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}

/**
 * §4.3 変化なし compact 1 行 (フレーム外で console.log)。
 * weather-formatter.ts の早期 return から呼ばれる。
 * 仕様上「変化なし」は常に info レベルで出すため level 引数は持たない (SEVERITY_LABELS["info"] 直書き)。
 */
export function displayVpws50Unchanged(info: ParsedWeatherWarning): void {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (!layer) return; // 念のため (本来は呼ばれない想定)
  const allAreas = new Set<string>();
  const specialAreas = new Set<string>();
  const warningAreas = new Set<string>();
  const advisoryAreas = new Set<string>();
  for (const item of layer.items) {
    for (const k of item.kinds) {
      if (k.severity === "specialWarning") {
        specialAreas.add(item.areaCode);
        allAreas.add(item.areaCode);
      } else if (k.severity === "warning") {
        warningAreas.add(item.areaCode);
        allAreas.add(item.areaCode);
      } else if (k.severity === "advisory") {
        advisoryAreas.add(item.areaCode);
        allAreas.add(item.areaCode);
      }
    }
  }
  const levelLabel = SEVERITY_LABELS["info"]; // "[通知]"
  const time = info.reportDateTime.length >= 19 ? info.reportDateTime.substring(11, 19) : "";
  const timeSuffix = time !== "" ? `  ${time}` : "";
  console.log(
    `${levelLabel} 気象警報・注意報（全国集約）  ${allAreas.size}予報区  特${specialAreas.size} / 警${warningAreas.size} / 注${advisoryAreas.size}  最後に受信した VPWS50 から変化なし${timeSuffix}`,
  );
}

export {
  aggregateVpws50ByForecastZone,
  displayVpws50List,
  displayVpws50Compact,
  hasForecastZoneLayer,
};

/**
 * テスト用 internal export。production code から import 禁止。
 * @internal
 */
export const __vpws50_internals = {
  KIND_CODE_LABELS,
  kindToShortLabel,
  isColorAvailable,
  formatDisplayToken,
  formatDisplayTokenResolved,
  formatPrevDisplayToken,
  vpws50BannerSeverity,
  buildVpws50BannerText,
  buildVpws50Row,
  buildVpws50DisplayGroups,
  aggregateVpws50ByForecastZone,
  hasForecastZoneLayer,
  displayVpws50List,
  displayVpws50Compact,
  displayVpws50Unchanged,
  displayVpws50FromState,
  renderSubline,
  renderChangeSection,
  renderReleasedSection,
  renderCurrentSummary,
  renderCurrentSummaryFromDisplay,
  renderDisplaySeveritySection,
  renderSummarySections,
  renderLegend,
  renderLegacyVpws50List,
};
