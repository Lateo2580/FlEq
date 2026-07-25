export const DISPLAY_SUMMARY_WIDTH = 120;
export const RECENT_TICKER_MAX = 200;
/** snapshot 縮退の最初の段で tickerBody を残す recentTicker の先頭件数 (それ以降は null 化)。
 *  2 レーン × 数件先読み相当。preview 調整前提 (spec §3) */
export const RECENT_TICKER_BODY_MAX = 8;
export const RECENT_QUAKES_MAX = 5;
export const MAX_CLIENTS = 8;
export const MAX_EVENT_BYTES = 32 * 1024;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_WRITABLE_LENGTH = 128 * 1024;
export const MAX_BLOCKED_MS = 5_000;
export const HEARTBEAT_MS = 15_000;
export const SWEEP_INTERVAL_MS = 5_000;
export const STATE_DEBOUNCE_MS = 500;
export const EEW_TTL_MIN = 10;
export const EEW_FINAL_HOLD_SEC = 120;
export const LARGE_QUAKE_HOLD_MIN = 10;
export const TSUNAMI_DEMOTE_MIN = 10;
/** 気象警報 (L4/L5 相当) の主役パネル保持時間。SWEEP_INTERVAL_MS 駆動のため
 *  実際の降格は「30 分 + 最大 5 秒」で起きる (契約)。 */
export const WEATHER_PROMOTION_DEMOTE_MIN = 30;
/** 復元時に「保存時刻が未来」と判定する許容誤差。RTC を持たない Pi は NTP 同期前に時刻がずれる。
 *  sweep 1 周期 (SWEEP_INTERVAL_MS) 以内のズレは通常運転と区別できないため未来扱いしない。 */
export const WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS = SWEEP_INTERVAL_MS;
/** これより古い保存データは復元しない (丸ごと破棄)。
 *  demoted record は tier / weatherL5Active を保持し続けるため、電文が流れない環境
 *  (API キー不正・オフライン起動) では古い record が無期限に画面を緊張状態へ固定してしまう。
 *  継続中の警報なら VPWS50 の定期再掲で復元後すぐ上書きされるので、
 *  「1 日確認が取れないものは主張しない」を上限に据える。 */
export const WEATHER_PROMOTION_MAX_RESTORE_AGE_MS = 24 * 60 * 60 * 1000;
export const KILL_SWITCH_ERRORS = 10;
export const QUAKE_CARD_TTL_LOW_MIN = 5;    // 震度1-2
export const QUAKE_CARD_TTL_MID_MIN = 15;   // 震度3-4
export const QUAKE_CARD_TTL_HIGH_MIN = 30;  // 震度5弱+
export const TICKER_TTL_HIGH_MIN = 30;  // high の recentTicker 寿命 (spec §3)
export const TICKER_TTL_MID_MIN = 120;  // mid の寿命 (EEW/津波 active は別で残す)
export const TICKER_TTL_LOW_MIN = 180;  // low の寿命
/** EEW の recentTicker 寿命。activeEews の EEW_TTL_MIN と同値に保つ。
 *  inactive になった EEW テロップを長時間残さないための専用 TTL。 */
export const TICKER_TTL_EEW_MIN = 10;
/** tickerSync 完全同期が縮退で送れず持ち越しになったときの明示的な再試行間隔 (spec §3-5)。
 *  外部 dirty 契機が偶然来なくても pending が永久に残らないようにする。調整前提の暫定値 */
export const TICKER_SYNC_RETRY_MS = 30_000;
