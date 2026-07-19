/** 津波種別の canonical ラベル (優先度順: 大津波警報 > 津波警報 > 津波注意報) */
export const TSUNAMI_LEVEL_LABELS = ["大津波警報", "津波警報", "津波注意報"] as const;
export type TsunamiLevelLabel = (typeof TSUNAMI_LEVEL_LABELS)[number];

/**
 * 津波種別の接尾辞つき表記 (「大津波警報：発表」「津波警報：発表」等、実電文で観測される表記ゆれ)
 * を canonical ラベルへ正規化する (前方一致)。先頭・末尾の空白は判定前に trim する。
 * 一致しなければ trim 後の文字列をそのまま返す (津波予報等)。
 * 「大津波警報」を含む文字列が「津波警報」に誤判定されないよう、大津波警報 → 津波警報 → 津波注意報
 * の順で判定する。
 * CLI (engine/messages/tsunami-state.ts) / display (engine/display/project-event.ts) /
 * presentation (engine/presentation/events/tsunami-observations.ts) の 3 層すべてがこの関数を
 * 経由する (判定ロジックの単一集約)。utils 配下に置くことで各層からの import 方向を揃え、
 * 循環 import を避ける。
 */
export function normalizeTsunamiKind(kind: string): string {
  const trimmed = kind.trim();
  for (const label of TSUNAMI_LEVEL_LABELS) {
    if (trimmed.startsWith(label)) return label;
  }
  return trimmed;
}

export interface TsunamiLevelInfo {
  level: "majorWarning" | "warning" | "advisory";
  label: TsunamiLevelLabel;
}

/**
 * tsunamiKinds (複数予報区の kind 列) から最上位の津波レベルを判定する
 * (大津波警報 > 津波警報 > 津波注意報)。project-event.ts の非 export ローカル関数から
 * ここへ移設 (関数本体は無改変)。summaryRole / projectEmergency / ticker-sentence の
 * 3 箇所以上が共通利用するための単一集約 (二重実装禁止)。
 */
export function resolveTsunamiLevel(kinds: string[]): TsunamiLevelInfo | null {
  const normalized = kinds.map(normalizeTsunamiKind);
  if (normalized.includes("大津波警報")) return { level: "majorWarning", label: "大津波警報" };
  if (normalized.includes("津波警報")) return { level: "warning", label: "津波警報" };
  if (normalized.includes("津波注意報")) return { level: "advisory", label: "津波注意報" };
  return null;
}
