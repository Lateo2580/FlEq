import type { WsDataMessage, ParsedVolcanoInfo, ParsedVolcanoAlertInfo } from "../../../types";
import type { VolcanoOutcome } from "../types";
import type { VolcanoStateHolder } from "../../messages/volcano-state";
import { resolveVolcanoPresentation } from "../../notification/volcano-presentation";

/**
 * パース済み火山情報から VolcanoOutcome を構築する。
 * VolcanoRouteHandler から使用される。
 */
export function buildVolcanoOutcome(
  msg: WsDataMessage,
  volcanoInfo: ParsedVolcanoInfo,
  volcanoState: VolcanoStateHolder,
): VolcanoOutcome {
  const presentation = resolveVolcanoPresentation(volcanoInfo, volcanoState);
  const isRenotification =
    volcanoInfo.kind === "alert"
      ? volcanoState.isRenotification(volcanoInfo as ParsedVolcanoAlertInfo)
      : false;

  // Track state before/after for alert types
  const trackedBefore = volcanoInfo.volcanoCode
    ? (volcanoState.getEntry(volcanoInfo.volcanoCode)?.alertLevel?.toString() ?? null)
    : null;

  return {
    domain: "volcano",
    msg,
    headType: msg.head.type,
    statsCategory: "volcano",
    parsed: volcanoInfo,
    volcanoPresentation: presentation,
    state: {
      isRenotification,
      trackedBefore,
      // trackedAfter will be set by router after volcanoState.update()
      trackedAfter: undefined,
    },
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: presentation.frameLevel,
      soundLevel: presentation.soundLevel,
      notifyCategory: "volcano",
    },
  };
}
