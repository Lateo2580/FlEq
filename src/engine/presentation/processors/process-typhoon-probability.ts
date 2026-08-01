import type { WsDataMessage } from "../../../types";
import type { TyphoonProbabilityOutcome } from "../types";
import { parseTyphoonProbability } from "../../../dmdata/typhoon-probability-parser";
import { resolveTyphoonProbabilityLevels } from "../level-helpers";
import type { ProcessDeps } from "./process-message";

/**
 * VPTA50 台風の暴風域に入る確率 を処理し TyphoonProbabilityOutcome を返す。
 * パース失敗時は null。
 *
 * deps?.typhoonProbabilityState が渡された場合、同一 EventID の連続ゼロ発表を
 * suppressNotify=true で静音化する (TyphoonProbabilityStateHolder 経由)。
 */
export function processTyphoonProbability(
  msg: WsDataMessage,
  deps?: Pick<ProcessDeps, "typhoonProbabilityState">,
): TyphoonProbabilityOutcome | null {
  const info = parseTyphoonProbability(msg);
  if (!info) return null;

  let { frameLevel, soundLevel, maxDaily5 } = resolveTyphoonProbabilityLevels(info);
  let suppressNotify = false;
  if (deps?.typhoonProbabilityState != null) {
    if (info.infoType === "取消") deps.typhoonProbabilityState.rollback(info.eventId ?? "");
    else {
      const diff = deps.typhoonProbabilityState.diffAndUpdate(info.eventId ?? "", maxDaily5, info.reportDateTime);
      if (diff.isUnchangedZero && !diff.shouldRecap) {
        soundLevel = "info";
        suppressNotify = true;
      }
    }
  }

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
      typhoonProbabilityMaxDaily5: info.infoType === "取消" ? null : maxDaily5,
      suppressNotify,
    },
  };
}
