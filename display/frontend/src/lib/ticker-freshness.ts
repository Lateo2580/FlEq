import type { DisplayEventDtoV1, DisplayStateSnapshotV1 } from "./protocol";

/** サーバ T1 の 10 分 TTL と配信・再接続の遷移マージン。 */
export const EEW_TICKER_STALE_MS = 10 * 60_000 + 60_000;

/** snapshot / tickerSync の再構築時だけ古い inactive EEW を除外する。 */
export function filterStaleEews(
  recentTicker: DisplayEventDtoV1[],
  snapshot: Pick<DisplayStateSnapshotV1, "generatedAt" | "activeEews">,
): DisplayEventDtoV1[] {
  const baseMs = Date.parse(snapshot.generatedAt);
  if (Number.isNaN(baseMs)) return recentTicker;
  const activeKeys = new Set(
    snapshot.activeEews.filter((e) => e.eventId != null).map((e) => `eew:${e.eventId}`),
  );
  return recentTicker.filter((dto) => {
    if (dto.domain !== "eew") return true;
    if (dto.groupKey != null && activeKeys.has(dto.groupKey)) return true;
    const reportMs = Date.parse(dto.reportDateTime);
    if (Number.isNaN(reportMs)) {
      console.warn("[ticker] inactive EEW with invalid reportDateTime removed", dto.eventKey);
      return false;
    }
    return baseMs - reportMs <= EEW_TICKER_STALE_MS;
  });
}
