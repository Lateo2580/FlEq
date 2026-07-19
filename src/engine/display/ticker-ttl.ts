import { TICKER_TTL_HIGH_MIN, TICKER_TTL_MID_MIN, TICKER_TTL_LOW_MIN } from "./constants";
import type { DisplayTickerPriority } from "./types";

const MIN_MS = 60_000;

/** テロップ優先度別の recentTicker 寿命 (ms)。spec §3-1 */
export function tickerTtlMs(priority: DisplayTickerPriority): number {
  if (priority === "high") return TICKER_TTL_HIGH_MIN * MIN_MS;
  if (priority === "mid") return TICKER_TTL_MID_MIN * MIN_MS;
  return TICKER_TTL_LOW_MIN * MIN_MS;
}
