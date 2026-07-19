import type { WsDataMessage } from "../../../types";
import type { BriefingOutcome } from "../types";
import { parseWeatherBriefing } from "../../../dmdata/briefing-parser";
import { briefingFrameLevel, briefingSoundLevel } from "../level-helpers";

/** 気象防災速報 (VPBS50) を処理し BriefingOutcome を返す。パース失敗時は null。 */
export function processBriefing(msg: WsDataMessage): BriefingOutcome | null {
  const info = parseWeatherBriefing(msg);
  if (!info) return null;

  return {
    domain: "briefing",
    msg,
    headType: msg.head.type,
    statsCategory: "briefing",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: briefingFrameLevel(info),
      soundLevel: briefingSoundLevel(info),
      notifyCategory: "briefing",
    },
  };
}
