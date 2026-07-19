// 津波継続バナー (TsunamiStandbyBanner.svelte) の marquee 種別シーケンス用の純関数群 (第3波 Fix12)。
// 「いま流れている種別」の状態遷移とチップ強調判定をテスト容易な形で切り出す。
import type { DisplayTsunamiLevel } from "./protocol";
import type { CoastGroup } from "./tsunami-banner";

export interface MarqueeSegment {
  level: DisplayTsunamiLevel | null;
  text: string;
}

/** CoastGroup[] (レベル別グループ、groupCoastsByLevel の出力) を marquee セグメントへ変換する。
 *  各グループの見出しラベルはセグメント本文にも残す (チップとの二重化で判別性を高める) */
export function buildMarqueeSegments(groups: CoastGroup[]): MarqueeSegment[] {
  return groups.map((g) => ({
    level: g.level,
    text: g.label != null ? `【${g.label}】${g.names.join("・")}` : g.names.join("・"),
  }));
}

/** 全セグメントを 1 本の文字列に連結する (reduced-motion の静的フォールバック用) */
export function joinMarqueeSegments(segments: MarqueeSegment[]): string {
  return segments.map((s) => s.text).join("　");
}

/** 種別シーケンスが複数種別を巡回するモードかどうか。1 種別以下なら現行 (常時強調・単一ループ) と同じ */
export function isMultiSegment(segments: MarqueeSegment[]): boolean {
  return segments.length > 1;
}

/** 次のセグメント index (末尾なら先頭へ循環)。空配列は 0 を返す */
export function nextSegmentIndex(current: number, length: number): number {
  if (length <= 0) return 0;
  return (current + 1) % length;
}

/** currentIndex が配列範囲外 (種別の増減で長さが変わった場合) なら 0 に丸める */
export function clampSegmentIndex(current: number, length: number): number {
  if (length <= 0) return 0;
  return current >= length ? 0 : current;
}

/** count-chip (レベル別カウント) を「流れている種別」に同期して強調するかどうか。
 *  多種別巡回時は一致する種別だけ強調、単一種別 (isMultiSegment=false) のときは常時強調、
 *  未分類セグメント (currentLevel=null、対応チップが存在しない) 中は差をつけない (常時強調のまま) */
export function isChipEmphasized(
  chipLevel: DisplayTsunamiLevel,
  currentLevel: DisplayTsunamiLevel | null,
  multiSegment: boolean,
): boolean {
  if (!multiSegment) return true;
  if (currentLevel == null) return true;
  return chipLevel === currentLevel;
}
