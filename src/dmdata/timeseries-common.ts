import { dig, str, listOf, nodeText } from "./xml-shape";

// listOf / nodeText は xml-shape に集約済み。従来 timeseries-common から
// import している各所を壊さないよう re-export する。
export { listOf, nodeText };

/** 数値文字列を number|null に (空/非数は null。"0" は 0 を返す) */
export function toNumberOrNull(value: string): number | null {
  if (value === "" || value == null) return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

/** TimeDefine 1 件 */
export interface TimeDefineEntry {
  timeId: string;
  dateTime: string;
  duration: string;
  name: string;
}

/** strict forecast-card 用の TimeDefine 解決結果。重複 timeId は ambiguous として null にする。 */
export interface StrictTimeDefineMap {
  entries: Map<string, TimeDefineEntry>;
  ambiguousIds: Set<string>;
}

/**
 * 従来の worst projection 用 map を変えず、card 用だけ duplicate timeId を明示する。
 */
export function buildStrictTimeDefineMap(timeDefinesNode: unknown): StrictTimeDefineMap {
  const entries = new Map<string, TimeDefineEntry>();
  const ambiguousIds = new Set<string>();
  for (const td of listOf(dig(timeDefinesNode, "TimeDefine"))) {
    const timeId = str(dig(td, "@_timeId")).trim();
    if (timeId === "") continue;
    if (entries.has(timeId)) {
      ambiguousIds.add(timeId);
      continue;
    }
    entries.set(timeId, {
      timeId,
      dateTime: str(dig(td, "DateTime")).trim(),
      duration: str(dig(td, "Duration")).trim(),
      name: str(dig(td, "Name")).trim(),
    });
  }
  return { entries, ambiguousIds };
}

const OFFSET_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const ELAPSED_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** ISO 8601 の day/hour/minute/second 正の elapsed duration だけをミリ秒へ変換する。 */
export function parseStrictElapsedDuration(value: string): number | null {
  const match = ELAPSED_DURATION.exec(value);
  if (match == null) return null;
  if (value.includes("T") && match[2] == null && match[3] == null && match[4] == null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const result = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

/** DateTime/Duration が正しいときだけ canonical UTC interval を返す。 */
export function resolveStrictTimeDefine(entry: TimeDefineEntry): { startsAt: string; endsAt: string } | null {
  const match = OFFSET_ISO.exec(entry.dateTime);
  if (match == null) return null;
  const startsAtMs = Date.parse(entry.dateTime);
  const durationMs = parseStrictElapsedDuration(entry.duration);
  if (!Number.isSafeInteger(startsAtMs) || durationMs == null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23
    || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const signedOffsetMinutes = match[8] === "Z"
    ? 0
    : (match[9] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const local = new Date(startsAtMs + signedOffsetMinutes * 60_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month
    || local.getUTCDate() !== day || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond) return null;
  const endsAtMs = startsAtMs + durationMs;
  if (!Number.isSafeInteger(endsAtMs) || endsAtMs <= startsAtMs) return null;
  try {
    return { startsAt: new Date(startsAtMs).toISOString(), endsAt: new Date(endsAtMs).toISOString() };
  } catch {
    return null;
  }
}

/** <TimeDefines> から timeId→TimeDefineEntry の Map を構築 (系列ローカル) */
export function buildTimeDefineMap(
  timeDefinesNode: unknown,
): Map<string, TimeDefineEntry> {
  const map = new Map<string, TimeDefineEntry>();
  if (timeDefinesNode == null) return map;
  for (const td of listOf(dig(timeDefinesNode, "TimeDefine"))) {
    const timeId = str(dig(td, "@_timeId"));
    if (!timeId) continue;
    map.set(timeId, {
      timeId,
      dateTime: str(dig(td, "DateTime")),
      duration: str(dig(td, "Duration")),
      name: str(dig(td, "Name")),
    });
  }
  return map;
}

/** jmx_eb 要素 1 件のパース結果 (worst 選定せず全属性保持) */
export interface JmxEbElement {
  refID: string;
  type: string;             // @type ("最大風速" / "波高" 等)
  unit: string;             // @unit ("m/s" / "m" / "mm")
  condition: string | null; // @condition ("値なし" / "うねり" 等)
  description: string | null; // @description ("２２メートル")
  value: number | null;     // #text の数値 (condition=値なし 等で null)
  raw: string;              // #text 原文
}

/** jmx_eb:WindSpeed / Precipitation / WaveHeight など 1 要素を欠落なくパース */
export function parseJmxEbElement(node: unknown): JmxEbElement {
  const raw = nodeText(node);
  return {
    refID: str(dig(node, "@_refID")),
    type: str(dig(node, "@_type")),
    unit: str(dig(node, "@_unit")),
    condition: str(dig(node, "@_condition")) || null,
    description: str(dig(node, "@_description")) || null,
    value: toNumberOrNull(raw),
    raw,
  };
}
