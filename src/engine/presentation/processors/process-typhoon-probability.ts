import type { ParsedTyphoonProbability, WsDataMessage } from "../../../types";
import type { TyphoonProbabilityOutcome } from "../types";
import { parseTyphoonProbability } from "../../../dmdata/typhoon-probability-parser";
import { resolveTyphoonProbabilityLevels } from "../level-helpers";
import type { ProcessDeps } from "./process-message";
import type { CanonicalVptaInfoType } from "../../display/project-typhoon-probability";

export function prepareTyphoonProbability(
  msg: WsDataMessage,
): ParsedTyphoonProbability | null {
  return parseTyphoonProbability(msg);
}

/** Admission 後も holder を触らない stateless notification baseline。 */
export function createTyphoonProbabilityOutcomeBaseline(
  msg: WsDataMessage,
  info: ParsedTyphoonProbability,
  canonicalInfoType: CanonicalVptaInfoType = info.infoType as CanonicalVptaInfoType,
): TyphoonProbabilityOutcome {
  const canonical = info.infoType === canonicalInfoType
    ? info
    : { ...info, infoType: canonicalInfoType };
  const { frameLevel, soundLevel, maxDaily5 } = resolveTyphoonProbabilityLevels(canonical);
  return {
    domain: "typhoonProbability",
    msg,
    headType: msg.head.type,
    statsCategory: "typhoonProbability",
    parsed: info,
    stats: { shouldRecord: true, eventId: info.eventId },
    presentation: {
      frameLevel,
      soundLevel,
      notifyCategory: "typhoonProbability",
      typhoonProbabilityMaxDaily5: canonicalInfoType === "取消" ? null : maxDaily5,
      suppressNotify: false,
    },
  };
}

/**
 * VPTA50 台風の暴風域に入る確率 を処理し TyphoonProbabilityOutcome を返す。
 * パース失敗時は null。
 *
 * holder mutation は accepted finalized classification の completion 経路だけが行う。
 * 第2引数は source compatibility のため残すが、直接呼出しでは state を変更しない。
 */
export function processTyphoonProbability(
  msg: WsDataMessage,
  _deps?: Pick<ProcessDeps, "typhoonProbabilityState">,
): TyphoonProbabilityOutcome | null {
  const info = prepareTyphoonProbability(msg);
  if (!info) return null;
  return createTyphoonProbabilityOutcomeBaseline(msg, info);
}
