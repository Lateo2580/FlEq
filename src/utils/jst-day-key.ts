/** UTC ミリ秒を JST 暦日キー (YYYY-MM-DD) に変換する */
export function jstDayKey(ts: number): string {
  return new Date(ts + 9 * 3_600_000).toISOString().slice(0, 10);
}
