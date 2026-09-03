// 待機画面の津波継続バナー (TsunamiStandbyBanner.svelte) 用の純関数群。
// レベル別カウント集計・最高レベル判定をテスト容易な形で切り出す。
import type { DisplayTsunamiLevel, DisplayTsunamiStateV1 } from "./protocol";

const LEVEL_ORDER: readonly DisplayTsunamiLevel[] = ["majorWarning", "warning", "advisory"];

const LEVEL_LABEL: Record<DisplayTsunamiLevel, string> = {
  majorWarning: "大津波警報",
  warning: "津波警報",
  advisory: "津波注意報",
};

/**
 * coasts[].kind をレベルへ分類する。project-event.ts の normalizeTsunamiKind によりサーバ側で
 * 接尾辞 (「大津波警報：発表」等) は既に正規化済みのはずだが、起動時 seed 復元など古い形の state に
 * 備え前方一致で判定する (server 側と同方針)。「大津波警報」を「津波警報」に誤判定しないよう
 * 大津波警報 → 津波警報 → 津波注意報 の順で判定する。
 * 解除 (Kind Code 60: 「津波注意報解除」等) は前方一致だと発表扱いになってしまうため、
 * 最初に弾いて null にする。継続バナーの件数からは外れるが、テロップでは isReleasedKind で
 * 拾い直して独立した「解除」グループとして表示する (混在報でどこが解除されたかを残すため)。
 */
function classifyKind(kind: string): DisplayTsunamiLevel | null {
  if (kind.includes("解除")) return null;
  if (kind.startsWith("大津波警報")) return "majorWarning";
  if (kind.startsWith("津波警報")) return "warning";
  if (kind.startsWith("津波注意報")) return "advisory";
  return null;
}

/**
 * 解除 (Kind Code 60: 「津波注意報解除」等) かどうか。classifyKind が解除を null に落とすため、
 * 「解除された沿岸」と「そもそも分類対象でない沿岸 (津波予報等)」を区別するにはこちらで判定する。
 */
function isReleasedKind(kind: string): boolean {
  return kind.includes("解除");
}

/** 解除グループの見出しラベル。LEVEL_LABEL (警報区分の正式名) とは別語彙 */
const RELEASED_LABEL = "解除";

export interface TsunamiLevelSummary {
  level: DisplayTsunamiLevel;
  label: string;
  count: number;
}

/**
 * coasts を kind でレベル分類しグルーピングして件数を出す。レベル降順 (大津波警報 → 津波警報 → 津波注意報)。
 * 分類できない kind (津波予報等) はカウントに含めない。
 */
export function summarizeTsunamiLevels(
  coasts: DisplayTsunamiStateV1["coasts"],
): TsunamiLevelSummary[] {
  const counts = new Map<DisplayTsunamiLevel, number>();
  for (const c of coasts) {
    const level = classifyKind(c.kind);
    if (level == null) continue;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  return LEVEL_ORDER.filter((level) => counts.has(level)).map((level) => ({
    level,
    label: LEVEL_LABEL[level],
    count: counts.get(level)!,
  }));
}

/** 最高レベル (大津波警報 > 津波警報 > 津波注意報)。coasts から分類できなければ fallback (state.level) を使う */
export function highestTsunamiLevel(
  summaries: TsunamiLevelSummary[],
  fallback: DisplayTsunamiLevel,
): DisplayTsunamiLevel {
  return summaries[0]?.level ?? fallback;
}

/** チップ表示用の短縮ラベル ([大津波 3] [警報 4] [注意報 3] 相当)。banner-header の正式名とは別語彙 */
export function shortLevelLabel(level: DisplayTsunamiLevel): string {
  if (level === "majorWarning") return "大津波";
  if (level === "warning") return "警報";
  return "注意報";
}

/**
 * marquee テロップ用の沿岸グループ。3 種を判別共用体で分ける:
 * - `level`: 発表中の警報区分 (大津波警報 / 津波警報 / 津波注意報)
 * - `released`: 解除された沿岸。件数チップには載らないが、混在報でどこが解除されたかを読めるよう
 *   テロップには「【解除】…」として残す
 * - `unclassified`: 分類対象外 (津波予報「若干の海面変動」等)。ラベルなしでそのまま並べる
 * 解除と未分類はどちらも level=null だが、label の有無が異なるため型で取り違えられないようにする。
 */
export type CoastGroup =
  | { kind: "level"; level: DisplayTsunamiLevel; label: string; names: string[] }
  | { kind: "released"; level: null; label: string; names: string[] }
  | { kind: "unclassified"; level: null; label: null; names: string[] };

/**
 * marquee テロップ用に coasts をグルーピングする。
 * 並びはレベル降順 → 解除 → 未分類。どの地域がどの区分かを判別できるよう、
 * 各グループの見出しラベルをテロップ側で付与する。
 */
export function groupCoastsByLevel(
  coasts: DisplayTsunamiStateV1["coasts"],
): CoastGroup[] {
  const byLevel = new Map<DisplayTsunamiLevel, string[]>();
  const released: string[] = [];
  const unclassified: string[] = [];
  for (const c of coasts) {
    if (isReleasedKind(c.kind)) {
      released.push(c.name);
      continue;
    }
    const level = classifyKind(c.kind);
    if (level == null) {
      unclassified.push(c.name);
      continue;
    }
    const names = byLevel.get(level) ?? [];
    names.push(c.name);
    byLevel.set(level, names);
  }
  const groups: CoastGroup[] = [];
  for (const level of LEVEL_ORDER) {
    const names = byLevel.get(level);
    if (names != null) groups.push({ kind: "level", level, label: LEVEL_LABEL[level], names });
  }
  if (released.length > 0) {
    groups.push({ kind: "released", level: null, label: RELEASED_LABEL, names: released });
  }
  if (unclassified.length > 0) {
    groups.push({ kind: "unclassified", level: null, label: null, names: unclassified });
  }
  return groups;
}
