import type { WsDataMessage } from "../../../types";
import type { ClimateInfoOutcome } from "../types";
import { parseClimateInfo } from "../../../dmdata/climate-info-parser";
import {
  climateInfoFrameLevel,
  climateInfoSoundLevel,
} from "../level-helpers";

/** 全般天候情報 (VPZI50) を処理し ClimateInfoOutcome を返す。パース失敗時は null。 */
export function processClimateInfo(
  msg: WsDataMessage,
): ClimateInfoOutcome | null {
  const info = parseClimateInfo(msg);
  if (!info) return null;

  return {
    domain: "climateInfo",
    msg,
    headType: msg.head.type,
    statsCategory: "climateInfo",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: climateInfoFrameLevel(info),
      soundLevel: climateInfoSoundLevel(info),
      notifyCategory: "climateInfo",
    },
  };
}
