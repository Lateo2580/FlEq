import type { ParsedEewInfo } from "../types";
import { jstDayKey } from "./jst-day-key";

/** 取消の通知・見出しが「何を取り消したか」を指す句を組む。 */

/** 地震情報の取消で、既存の状態から引けた地震 */
export interface RecentQuakeRef {
  hypocenterName: string | null;
  originTime: string | null;
}
export type FindRecentQuake = (eventId: string) => RecentQuakeRef | null;

interface DateClock {
  ymd: string; // YYYY-MM-DD
  clock: string; // HH:MM
}

/** EventID は JST の yyyyMMddHHmmss。EEW は検知時刻と一致、地震情報は国内なら分まで発生時刻と一致、遠地地震はずれる */
function eventIdDateClock(eventId: string | null | undefined): DateClock | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}$/.exec(eventId ?? "");
  return m ? { ymd: `${m[1]}-${m[2]}-${m[3]}`, clock: `${m[4]}:${m[5]}` } : null;
}

/** 気象庁電文の ISO 時刻 (+09:00) から日付と HH:MM を取る */
function isoDateClock(iso: string | null | undefined): DateClock | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso ?? "");
  return m ? { ymd: m[1], clock: m[2] } : null;
}

/** 今日でない日付には「M/D 」を付ける (翌日に届く取消のため) */
function dayPrefix(ymd: string): string {
  if (ymd === jstDayKey(Date.now())) return "";
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))} `;
}

/** 取り消された EEW を指す句。震源名と最終報の発表時刻、無ければ EventID の検知時刻 */
export function eewCancelTargetPhrase(
  target: ParsedEewInfo | undefined,
  eventId: string | null | undefined,
): string | null {
  const name = target?.earthquake?.hypocenterName ?? null;
  const at = isoDateClock(target?.reportDateTime)?.clock ?? null;
  if (name != null && at != null) return `${name} ${at} 発表`;
  if (name != null) return name;
  const detected = eventIdDateClock(eventId);
  return detected != null ? `${detected.clock} 頃検知の地震` : null;
}

/** 取り消された地震情報を指す句。引けたら記憶の発生時刻と震源名、引けなければ EventID の時刻 (発生とは言わない) */
export function quakeCancelTargetPhrase(
  eventId: string | null | undefined,
  findRecentQuake?: FindRecentQuake,
): string | null {
  const ref = eventId != null ? findRecentQuake?.(eventId) ?? null : null;
  const name = ref?.hypocenterName != null ? `${ref.hypocenterName}の` : "";
  const origin = isoDateClock(ref?.originTime);
  if (origin != null) return `${dayPrefix(origin.ymd)}${origin.clock} 頃発生の${name}地震`;
  const fromId = eventIdDateClock(eventId);
  if (fromId != null) return `${dayPrefix(fromId.ymd)}${fromId.clock} 頃の${name}地震`;
  return name !== "" ? `${name}地震` : null;
}
