// VPWW55-61 の取消パス / 解除のみパス判定。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.6)
import type { WarningEntry } from "./weather-core-entry";

export interface ActiveReleaseCount {
  activeCount: number;
  releaseCount: number;
}

export function countActiveAndRelease(entries: WarningEntry[]): ActiveReleaseCount {
  let activeCount = 0;
  let releaseCount = 0;
  for (const e of entries) {
    if (e.status === "発表" || e.status === "継続") activeCount++;
    else if (e.status === "解除") releaseCount++;
  }
  return { activeCount, releaseCount };
}

/** 形式的取消 (infoType=取消)。 */
export function isCancelPath(infoType: string, _c: ActiveReleaseCount): boolean {
  return infoType === "取消";
}

/** 通常更新報だが active がゼロで解除遷移のみ → cancel 扱い。 */
export function isReleaseOnlyPath(infoType: string, c: ActiveReleaseCount): boolean {
  return infoType !== "取消" && c.activeCount === 0 && c.releaseCount > 0;
}
