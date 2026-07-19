import type { WsDataMessage } from "../../../types";
import type {
  SuppressibleProcessResult,
  TsunamiOutcome,
} from "../types";
import { parseTsunamiTelegram } from "../../../dmdata/telegram-parser";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import { tsunamiFrameLevel, tsunamiSoundLevel } from "../level-helpers";

/** processTsunami の戻り値。抑制とパース失敗を呼び出し側で区別する。 */
export type TsunamiProcessResult = SuppressibleProcessResult<TsunamiOutcome>;

/**
 * 津波電文 (VTSE41/51/52) を処理し TsunamiOutcome を返す。
 * VTSE41 のみ TsunamiStateHolder の状態更新を行い、更新前後のレベルを記録する。
 * 古い VTSE41・重複 VTSE41 は suppressed、パース失敗は parse-failed を返す。
 */
export function processTsunami(
  msg: WsDataMessage,
  tsunamiState: TsunamiStateHolder,
): TsunamiProcessResult {
  const tsunamiInfo = parseTsunamiTelegram(msg);
  if (!tsunamiInfo) return { kind: "parse-failed" };

  const levelBefore = tsunamiState.getLevel();

  // VTSE41 のみ状態更新
  if (msg.head.type === "VTSE41") {
    const updateResult = tsunamiState.update(tsunamiInfo);
    if (updateResult.kind === "suppressed") return { kind: "suppressed" };
  }

  const levelAfter = tsunamiState.getLevel();

  return {
    kind: "ok",
    outcome: {
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
    },
  };
}
