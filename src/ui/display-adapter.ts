/**
 * engine 層の DisplayCallbacks を実装する UI アダプター。
 * 全ての display 関数をここに集約し、engine → ui の逆方向依存を断つ。
 */

import type { DisplayCallbacks } from "../engine/messages/display-callbacks";
import type { ProcessOutcome } from "../engine/presentation/types";
import type { WsDataMessage, ParsedVolcanoInfo } from "../types";
import type { VolcanoPresentation } from "../engine/notification/volcano-presentation";
import type { Vfvo53BatchItems } from "../engine/messages/volcano-vfvo53-aggregator";
import { displayRawHeader, getDisplayMode } from "./formatter";
import { renderSummaryLine } from "./summary";
import { displayEewInfo } from "./eew-formatter";
import {
  displayEarthquakeInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
} from "./earthquake-formatter";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "./volcano-formatter";

/** DisplayCallbacks の実装を生成する */
export function createDisplayAdapter(): DisplayCallbacks {
  return {
    displayOutcome(outcome: ProcessOutcome): void {
      switch (outcome.domain) {
        case "eew":
          displayEewInfo(outcome.parsed, {
            activeCount: outcome.eewResult.activeCount,
            diff: outcome.eewResult.diff,
            colorIndex: outcome.eewResult.colorIndex,
          });
          break;
        case "earthquake":
          displayEarthquakeInfo(outcome.parsed);
          break;
        case "seismicText":
          displaySeismicTextInfo(outcome.parsed);
          break;
        case "lgObservation":
          displayLgObservationInfo(outcome.parsed);
          break;
        case "tsunami":
          displayTsunamiInfo(outcome.parsed);
          break;
        case "nankaiTrough":
          displayNankaiTroughInfo(outcome.parsed);
          break;
        case "raw":
          displayRawHeader(outcome.msg);
          break;
        // volcano: VolcanoRouteHandler 経由で displayVolcano/displayVolcanoBatch を直接呼ぶ
      }
    },

    displayRawHeader(msg: WsDataMessage): void {
      displayRawHeader(msg);
    },

    displayVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void {
      displayVolcanoInfo(info, presentation);
    },

    displayVolcanoBatch(batch: Vfvo53BatchItems, presentation: VolcanoPresentation): void {
      displayVolcanoAshfallBatch(batch, presentation);
    },

    getDisplayMode(): string {
      return getDisplayMode();
    },

    renderSummaryLine,
  };
}
