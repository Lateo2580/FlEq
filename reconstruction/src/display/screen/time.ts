// P4-SHELL-TYPES-001（P4-ST-D-TIME）日本時間の字。カードの部品が frame.ts を import すると frame.ts → cards.ts → 部品 → frame.ts の輪になるので、時刻の関数はこの file に置く。
// epoch ms に 32,400,000 を足して getUTC* で読む。端末の時差に依らない（P2-A9-AC10、P4-DS-AC09 (3)(4)）。

const JST_OFFSET_MS = 32_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const OFFSET_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// 暦に無い日付（2026-02-30）と 24 時は、Date.parse が繰り上げて読むので、項目を読み戻して照らす
function isCalendar(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second = 0, offsetHour = 0, offsetMinute = 0] = match.slice(1).map((part) => (part == null ? 0 : Number(part)));
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function jst(epochMs: number): Date | null {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return Number.isFinite(shifted.getTime()) ? shifted : null;
}

// formatJst と formatJstTime が同じ照らしを使うための 1 か所（P4-ST-AC05 (2)）。読めない値は null
function readJst(value: number | string | null): Date | null {
  const parts = typeof value === "string" ? OFFSET_ISO.exec(value) : null;
  const epoch = typeof value === "number" ? value : parts != null && isCalendar(parts) ? Date.parse(parts[0]) : Number.NaN;
  return Number.isFinite(epoch) ? jst(epoch) : null;
}

const hourMinute = (at: Date): string => `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

function formatJst(value: number | string | null): string {
  const at = readJst(value);
  return at == null ? "時刻不明" : `${pad(at.getUTCFullYear(), 4)}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${hourMinute(at)}:${pad(at.getUTCSeconds())}`;
}

function formatJstTime(value: number | string | null, unit: "second" | "minute"): string {
  const at = readJst(value);
  if (at == null) return "時刻不明";
  return unit === "second" ? `${hourMinute(at)}:${pad(at.getUTCSeconds())}` : hourMinute(at);
}

function clockText(epochMs: number): string {
  const at = jst(epochMs);
  if (at == null) return "時刻不明";
  return `${pad(at.getUTCFullYear(), 4)}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} (${WEEKDAYS[at.getUTCDay()]}) ${hourMinute(at)}`;
}

export { clockText, formatJst, formatJstTime };
