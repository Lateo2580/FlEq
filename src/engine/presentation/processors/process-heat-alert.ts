import type { WsDataMessage } from "../../../types";
import type { HeatAlertOutcome } from "../types";
import { parseHeatAlert } from "../../../dmdata/heat-alert-parser";
import {
  heatAlertFrameLevel,
  heatAlertSoundLevel,
} from "../level-helpers";

/** 熱中症警戒アラート (VPFT50) を処理し HeatAlertOutcome を返す。パース失敗時は null。 */
export function processHeatAlert(msg: WsDataMessage): HeatAlertOutcome | null {
  const info = parseHeatAlert(msg);
  if (!info) return null;

  return {
    domain: "heatAlert",
    msg,
    headType: msg.head.type,
    statsCategory: "heatAlert",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: heatAlertFrameLevel(info),
      soundLevel: heatAlertSoundLevel(info),
      notifyCategory: "heatAlert",
    },
  };
}
