import type { ScreenMode } from "./derive";

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** standby かつ 4 時台 かつ本日まだリロードしていない場合のみ true。 */
export function shouldReload(
  lastReloadIso: string | null,
  now: Date,
  mode: ScreenMode,
): boolean {
  if (mode !== "standby") return false;
  if (now.getHours() !== 4) return false;
  if (lastReloadIso == null) return true;
  return !isSameDay(new Date(lastReloadIso), now);
}
