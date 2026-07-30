// 表示用の時刻整形・震度ランク変換の純関数群。
// UI コンポーネント間で重複していたロジック (ConnectionBadge の時刻整形など) をここに集約する。
import type { DisplayRecentQuakeV1 } from "./protocol";

// 直近地震の安定 ID (2026-07-14 履歴クリック overlay)。訂正報や 5 件押し出しを跨いで同じ地震を
// 追跡するため、配列 index を含めず eventId を第一に使う。eventId が null の古い/簡易電文では
// originTime|震央名 で代替する: 発表時刻 (reportDateTime) は訂正報で変わるが発生時刻 (originTime)
// は同じ地震で不変になりやすいため主キーにし、reportDateTime は originTime も null の最終手段に降格。
// これは client 側の暫定強化で、本筋は「サーバが訂正不変の系列 ID を供給する」(今回スコープ外の残課題)。
export function recentQuakeId(q: DisplayRecentQuakeV1): string {
  if (q.eventId != null) return q.eventId;
  const base = q.originTime ?? q.reportDateTime;
  return `${base}|${q.hypocenterName ?? ""}`;
}

export function formatHm(iso: string | null): string {
  if (iso == null || iso === "") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 発生時刻は "HH:MM" だけだと日付を跨いだ (数日前の) 事象が今日の出来事に見えてしまうため、
// 月/日を前置する ("3/11 14:46")。ゼロ埋めしないカレンダー表記 (JMA 発表文の慣行に合わせる)
export function formatMdHm(iso: string | null): string {
  if (iso == null || iso === "") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getMonth() + 1}/${d.getDate()} ${formatHm(iso)}`;
}

export function formatHms(iso: string | null): string {
  if (iso == null || iso === "") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return (
    `${String(d.getHours()).padStart(2, "0")}:` +
    `${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}`
  );
}

// 震度文字列 → --int-1..9 ランク。CLI intensity ロールと同じ 9 段階変換
// ("1"..."4" はそのまま、"5弱"→5, "5強"→6, "6弱"→7, "6強"→8, "7"→9)。
const INTENSITY_RANK: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5弱": 5,
  "5強": 6,
  "6弱": 7,
  "6強": 8,
  "7": 9,
};

export function intensityRank(intensity: string): number | null {
  return INTENSITY_RANK[intensity] ?? null;
}

// 待機画面のチップ表示専用の短縮記法 ("5弱"→"5-" 等)。緊急パネル側は "5弱" 表記のまま扱う。
const INTENSITY_SHORT: Record<string, string> = {
  "5弱": "5-",
  "5強": "5+",
  "6弱": "6-",
  "6強": "6+",
};

export function formatIntShort(maxInt: string | null): string {
  if (maxInt == null) return "-";
  return INTENSITY_SHORT[maxInt] ?? maxInt;
}

export function formatDepth(depth: string | null): string {
  if (depth == null || depth === "") return "-";
  return depth;
}

// 整形済みの「数値+単位」文字列 ("20km" 等) を、数値部と末尾単位に割る。
// NumberUnit 表示 (数値大・単位小) 用。末尾の英字/スラッシュを単位とみなし、"~" 等の接頭記号は
// 数値側に残す。単位が無い ("-" 等) 場合は unit を空文字にする。
export function splitNumberUnit(text: string): { value: string; unit: string } {
  const match = /^(.*?)([a-zA-Z/]+)$/.exec(text);
  if (match == null) return { value: text, unit: "" };
  return { value: match[1], unit: match[2] };
}
