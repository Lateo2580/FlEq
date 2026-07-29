const JST_DAY_MS = 24 * 60 * 60_000;

/** UTC ミリ秒を JST 暦日キー (YYYY-MM-DD) に変換する。 */
export function jstDayKey(ts: number): string {
  return new Date(ts + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** JST の基準時刻から見た日付ラベル。対象外は null で呼び出し元に絶対表記を委ねる。 */
export function relativeJstDayLabel(dayKey: string, nowMs: number): "きょう" | "あす" | null {
  if (dayKey === jstDayKey(nowMs)) return "きょう";
  if (dayKey === jstDayKey(nowMs + JST_DAY_MS)) return "あす";
  return null;
}
