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
 * 最初に弾いて null (未分類) にする。継続バナーの件数・グルーピングから外れる。
 */
function classifyKind(kind: string): DisplayTsunamiLevel | null {
  if (kind.includes("解除")) return null;
  if (kind.startsWith("大津波警報")) return "majorWarning";
  if (kind.startsWith("津波警報")) return "warning";
  if (kind.startsWith("津波注意報")) return "advisory";
  return null;
}

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

export interface CoastGroup {
  /** 分類できなかった coasts (津波予報等) は null。marquee ではラベルなしでそのまま並べる */
  level: DisplayTsunamiLevel | null;
  label: string | null;
  names: string[];
}

/**
 * marquee テロップ用に coasts をレベル別にグルーピングする (レベル降順、未分類は末尾)。
 * どの地域がどの警報区分かを判別できるよう、各グループの見出しラベルをテロップ側で付与する。
 */
export function groupCoastsByLevel(
  coasts: DisplayTsunamiStateV1["coasts"],
): CoastGroup[] {
  const byLevel = new Map<DisplayTsunamiLevel | null, string[]>();
  for (const c of coasts) {
    const level = classifyKind(c.kind);
    const names = byLevel.get(level) ?? [];
    names.push(c.name);
    byLevel.set(level, names);
  }
  const groups: CoastGroup[] = [];
  for (const level of LEVEL_ORDER) {
    const names = byLevel.get(level);
    if (names != null) groups.push({ level, label: LEVEL_LABEL[level], names });
  }
  const unclassified = byLevel.get(null);
  if (unclassified != null) groups.push({ level: null, label: null, names: unclassified });
  return groups;
}
