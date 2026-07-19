import type { WsDataMessage } from "../../../types";
import type { TornadoOutcome } from "../types";
import { parseTornadoAdvisory } from "../../../dmdata/tornado-parser";
import { tornadoFrameLevel, tornadoSoundLevel } from "../level-helpers";

/**
 * 竜巻注意情報電文 (VPHW50, VPHW51) を処理し TornadoOutcome を返す。
 * パース失敗時は null を返し、router 側で raw にフォールバックさせる。
 */
export function processTornado(msg: WsDataMessage): TornadoOutcome | null {
  const info = parseTornadoAdvisory(msg);
  if (!info) return null;

  return {
    domain: "tornado",
    msg,
    headType: msg.head.type,
    statsCategory: "tornado",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: tornadoFrameLevel(info),
      soundLevel: tornadoSoundLevel(info),
      notifyCategory: "tornado",
    },
  };
}
