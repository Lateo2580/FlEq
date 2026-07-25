/**
 * 気象警報の主役パネル昇格判定 (集合ベース)。
 * rank 1 点代表 (maxDisplaySeverity) ではなく全 item を走査して最大昇格レベルを採る —
 * L4 (rank 90) と特別警報級 nonLevelSpecial (rank 85) の共存で L5 相当が潰れないようにする
 * (computeMaxSoundLevel と同じ集合ベース判定)。alert.role は使わない。
 */

import * as log from "../../logger";
import { displayWeatherPromotionLevel, isDisplayWeatherSeverity } from "./protocol";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherPromotionLevelV1,
  DisplayWeatherSourceV1,
} from "./types";

export const WEATHER_PROMOTION_SOURCES: readonly DisplayWeatherSourceV1[] = ["vpws50", "vpww56"];

/** 既に warn を出した未知 displaySeverity。未知コードの配信が始まってもログを埋めない */
const warnedUnknownSeverities = new Set<string>();

export interface WeatherPromotionClassification {
  level: DisplayWeatherPromotionLevelV1;
  /** 昇格対象 item の集合を表す安定キー。変化したら generation を更新する */
  signature: string;
  /**
   * 昇格の根拠になった item そのもの (L4/L5 相当のみ)。record と一緒に永続化して、
   * 再起動直後に live な view がまだ空でも主役パネルが中身を持てるようにする。
   * L3 以下は主役パネルに出ないので載せない (保存サイズの削減)。
   */
  items: DisplayWeatherAlertItemV1[];
}

/**
 * 1 source 分の気象カード view から昇格レベルを判定する。null = 昇格対象なし (L3 以下のみ)。
 * 未知の displaySeverity は昇格判定に使わず warn ログのみ出す。
 */
export function classifyWeatherPromotion(
  alerts: DisplayWeatherAlertV1[],
): WeatherPromotionClassification | null {
  let level: DisplayWeatherPromotionLevelV1 | null = null;
  const members: string[] = [];
  const items: DisplayWeatherAlertItemV1[] = [];
  for (const alert of alerts) {
    for (const item of alert.items) {
      if (!isDisplayWeatherSeverity(item.displaySeverity)) {
        // 値ごとに 1 回だけ警告する (異常検知としては初回で足りる)
        if (!warnedUnknownSeverities.has(item.displaySeverity)) {
          warnedUnknownSeverities.add(item.displaySeverity);
          log.warn(
            `display: 未知の displaySeverity "${item.displaySeverity}" (${alert.source} ${item.kind}) を昇格判定から除外しました`,
          );
        }
        continue;
      }
      const itemLevel = displayWeatherPromotionLevel(item.displaySeverity);
      if (itemLevel == null) continue;
      if (level == null || itemLevel > level) level = itemLevel;
      items.push(item);
      const prefix = `${itemLevel}|${item.displaySeverity}|${item.kind}`;
      if (item.shownAreas.length === 0) members.push(prefix);
      else for (const area of item.shownAreas) members.push(`${prefix}|${area}`);
    }
  }
  if (level == null) return null;
  members.sort();
  return { level, signature: members.join("\n"), items };
}

/** テスト用: 値ごと 1 回の warn 抑制状態をリセットする */
export function __test_resetUnknownSeverityWarnings(): void {
  warnedUnknownSeverities.clear();
}
