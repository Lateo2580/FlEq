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
import type { QuakeExtremeStore } from "../display/quake-extreme-store";

export interface DisplaySinkDeps {
  /** monitor 所有の待機画面 state */
  standby: { applyEvent(event: PresentationEvent, nowMs: number): unknown };
  /** monitor 所有の昇格 lifecycle */
  promotions: WeatherPromotionStore;
  /** 震度 7 の 12 時間保持。display off 中も電文受理と同時に更新する。 */
  quakeExtreme?: QuakeExtremeStore;
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
      const quakeExtremeChanged = deps.quakeExtreme?.applyPresentationEvent(event, nowMs) ?? false;
      const hub = deps.getHub();
      // monitor 側で先に更新した store は hub の state-store からは差分に見えない。
      // 特に取消・下方修正を即時に snapshot へ反映するため、外部 dirty を明示する。
      if (quakeExtremeChanged) hub?.markExternalStateDirty?.();
      hub?.ingest(event);
    },
  };
}
