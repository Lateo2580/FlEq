/**
 * 気象電文の受理から昇格状態を更新する。
 *
 * monitor の displaySink (display の on/off に関わらず必ず通る経路) から呼ぶ。
 * hub 側では更新しない —— display は表示の都合であって受理の事実とは無関係なので、
 * hub に置くと `display off` の間だけ昇格・続報・解除がすべて失われる。
 * 更新経路をこの 1 か所に一本化することで二重適用も防いでいる。
 */

import type { PresentationEvent } from "../presentation/types";
import type { Vpws50CurrentAreasForDisplay } from "../../types";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "./weather-alert-view";
import type { WeatherPromotionStore } from "./weather-promotion-store";

export interface WeatherPromotionViewSources {
  /** VPWS50 (Vpws50StateHolder.getCurrentAreasForDisplay) */
  vpws50: () => Vpws50CurrentAreasForDisplay | undefined;
  /** VPWW56 (Vpww56StateHolder.getCurrentAreasForDisplay) */
  vpww56: () => Vpws50CurrentAreasForDisplay | undefined;
}

/**
 * 気象電文 (VPWS50 / VPWW55 / VPWW56 / VPNO50) の confirmed な受理で昇格状態を更新する。
 * 対象外の電文・unsafe 報 (state を更新しないまま outcome が通った報) は何もしない。
 * nowMs は engine 受理時刻 —— 電文の updatedAt / reportDateTime は判定に使わない。
 */
export function applyWeatherPromotionOnIngest(
  store: WeatherPromotionStore,
  views: WeatherPromotionViewSources,
  event: PresentationEvent,
  nowMs: number,
): boolean {
  if (event.type !== "VPWS50" && event.type !== "VPWW55" && event.type !== "VPWW56" && event.type !== "VPNO50") return false;
  if (event.weatherConfidence === "unsafe") return false;
  if ((event.type === "VPWW55" || event.type === "VPWW56" || event.type === "VPNO50")
      && event.weatherStateMutationAccepted !== true) return false;
  const source = event.type === "VPWW56" ? "vpww56" : "vpws50";
  // **holder view をそのまま渡す** (spec 追補 C2)。表示用 view へ射影すると kindCode / areaCode が
  // 落ちて、L4→L5 の悪化で同じ地域が「追加された地域」に化ける
  return store.apply(source, source === "vpws50" ? views.vpws50() : views.vpww56(), nowMs);
}
