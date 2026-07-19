import type { AshForecastPeriod, ParsedVolcanoAshfallInfo } from "../../../types";

// 降灰予報 (VFVO53/54/55) の ashForecasts を構造化データから決定的に長文化する (spec §3-2)。
// 通知・統計の真実源は構造化データのまま。ここは表示用の文章合成。
// 全 period が最低情報量 (時間帯 + 現象(ashName) + (距離 or 対象地域)) を満たすときのみ非 null。
// 1 period でも欠ければ null → 呼び出し側が従来平文 (info.bodyText) へフォールバック。

// PlumeDirection の description 属性に現れる、方位ではなく場所寄りの語 (fixture 上この2系統のみ確認)。
// 「方向に」を付けると不自然 (例「火口近傍方向に」) なため、「方向」含みケースと同じ「に」直結にする。
const LOCATION_LIKE_DIRECTIONS = new Set(["直上", "火口近傍"]);

/** ISO 8601 (ローカル +09:00) から日と時を切り出す。Date 解析せず TZ ずれ回避。 */
function splitDayHour(iso: string): { day: number; hour: string } | null {
  const m = /-(\d{2})T(\d{2}):/.exec(iso);
  if (m == null) return null;
  return { day: Number(m[1]), hour: m[2] };
}

/** period が最低情報量を満たすか。時間帯あり + 現象(ashName 非空) + (対象地域非空 or いずれかの距離あり)。 */
function periodIsComplete(p: AshForecastPeriod): boolean {
  const hasTime = p.startTime !== "" && p.endTime !== "";
  const hasPhenomenon = p.areas.length > 0 && p.areas.every((a) => a.ashName !== "");
  const hasTargetOrDistance = p.areas.length > 0 || p.areas.some((a) => a.distanceKm != null);
  return hasTime && hasPhenomenon && hasTargetOrDistance;
}

/** 1 period を「{時間帯}、{方向}方向に{現象}（火口から{距離}kmまで）、…」の句にする。 */
function periodPhrase(p: AshForecastPeriod): string | null {
  const start = splitDayHour(p.startTime);
  const end = splitDayHour(p.endTime);
  let timeClause: string | null = null;
  if (start != null && end != null) {
    const startLabel = `${start.day}日${start.hour}時`;
    // 同日なら終端の日付は省略 (「17日15時から18時まで」)、日を跨ぐ場合のみ終端にも日を付す
    const endLabel = end.day === start.day ? `${end.hour}時` : `${end.day}日${end.hour}時`;
    timeClause = `${startLabel}から${endLabel}まで`;
  } else if (start != null) {
    timeClause = `${start.day}日${start.hour}時`;
  } else if (end != null) {
    timeClause = `${end.day}日${end.hour}時`;
  }
  if (timeClause == null) return null;
  // ashName ごとに畳み込み (出現順保持)。方向・距離はその現象の最初の非 null を代表に採る。
  const order: string[] = [];
  const byKind = new Map<string, { direction: string | null; distanceKm: number | null }>();
  for (const a of p.areas) {
    const cur = byKind.get(a.ashName);
    if (cur == null) {
      order.push(a.ashName);
      byKind.set(a.ashName, { direction: a.plumeDirection, distanceKm: a.distanceKm });
    } else {
      if (cur.direction == null && a.plumeDirection != null) cur.direction = a.plumeDirection;
      if (cur.distanceKm == null && a.distanceKm != null) cur.distanceKm = a.distanceKm;
    }
  }
  const clauses = order.map((name) => {
    const { direction, distanceKm } = byKind.get(name)!;
    // description 属性 (例「東（鹿屋市輝北方向）」) は既に「方向」を含むことがあるため、
    // 二重化を避けて「に」のみ付す。「直上」「火口近傍」は場所寄りの語で「方向に」が不自然なため同様に「に」のみ。
    // 単純方位 (例「東」) には「方向に」を補う。
    const dir =
      direction != null && direction !== "" && direction !== "全域"
        ? direction.includes("方向") || LOCATION_LIKE_DIRECTIONS.has(direction)
          ? `${direction}に`
          : `${direction}方向に`
        : "";
    const dist = distanceKm != null ? `（火口から${distanceKm}kmまで）` : "";
    return `${dir}${name}${dist}`;
  });
  return `${timeClause}、${clauses.join("、")}`;
}

export function volcanoAshfallToText(info: ParsedVolcanoAshfallInfo): string | null {
  if (info.ashForecasts.length === 0) return null;
  if (!info.ashForecasts.every(periodIsComplete)) return null;
  const phrases = info.ashForecasts.map(periodPhrase);
  if (!phrases.every((phrase): phrase is string => phrase != null)) return null;
  const head = info.volcanoName !== "" ? `【${info.volcanoName}】` : "";
  return `${head}${phrases.join("\n")}`;
}
