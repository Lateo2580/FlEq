import type { WsDataMessage } from "../../../types";
import type { TsunamiOutcome } from "../types";
import { parseTsunamiTelegram } from "../../../dmdata/telegram-parser";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import { tsunamiFrameLevel, tsunamiSoundLevel } from "../level-helpers";

/**
 * 津波電文 (VTSE41/51/52) を処理し TsunamiOutcome を返す。
 * VTSE41 のみ TsunamiStateHolder の状態更新を行い、更新前後のレベルを記録する。
 * パース失敗の場合は null を返す。
 */
export function processTsunami(
  msg: WsDataMessage,
  tsunamiState: TsunamiStateHolder,
): TsunamiOutcome | null {
  const tsunamiInfo = parseTsunamiTelegram(msg);
  if (!tsunamiInfo) return null;

  const levelBefore = tsunamiState.getLevel();

  // VTSE41 のみ状態更新
  if (msg.head.type === "VTSE41") {
    tsunamiState.update(tsunamiInfo);
  }

  const levelAfter = tsunamiState.getLevel();

  return {
    domain: "tsunami",
    msg,
    headType: msg.head.type,
    statsCategory: "tsunami",
    parsed: tsunamiInfo,
    state: {
      levelBefore,
      levelAfter,
      changed: levelBefore !== levelAfter,
    },
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: tsunamiFrameLevel(tsunamiInfo),
      soundLevel: tsunamiSoundLevel(tsunamiInfo),
      notifyCategory: "tsunami",
    },
  };
}
