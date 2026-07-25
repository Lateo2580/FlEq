/**
 * router へ渡す表示系の sink。
 *
 * display runtime は `display on/off` で作り直されるため、router には実体 hub ではなく
 * この遅延 sink を渡し、向き先 (getHub) を差し替える。
 *
 * monitor 所有の状態 (standby active-state・気象警報の昇格) は **hub の有無に関わらず**
 * ここで更新する。display は表示の都合であって電文受理の事実とは無関係で、hub 側に置くと
 * `display off` の間だけ更新が失われる。
 */

import type { PresentationEvent } from "../presentation/types";
import type { DisplayIngestSink } from "../display/types";
import {
  applyWeatherPromotionOnIngest,
  type WeatherPromotionViewSources,
} from "../display/weather-promotion-ingest";
import type { WeatherPromotionStore } from "../display/weather-promotion-store";

export interface DisplaySinkDeps {
  /** monitor 所有の待機画面 state */
  standby: { applyEvent(event: PresentationEvent, nowMs: number): unknown };
  /** monitor 所有の昇格 lifecycle */
  promotions: WeatherPromotionStore;
  /** 昇格判定に使う現況 view (state holder) */
  weatherViews: WeatherPromotionViewSources;
  /** 現在の display hub (未起動なら null) */
  getHub: () => DisplayIngestSink | null;
  /** テスト注入用。省略時 Date.now */
  now?: () => number;
}

export function createDisplaySink(deps: DisplaySinkDeps): DisplayIngestSink {
  const now = deps.now ?? Date.now;
  return {
    ingest: (event) => {
      const nowMs = now();
      deps.standby.applyEvent(event, nowMs);
      applyWeatherPromotionOnIngest(deps.promotions, deps.weatherViews, event, nowMs);
      deps.getHub()?.ingest(event);
    },
  };
}
