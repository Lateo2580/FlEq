import type { WsDataMessage } from "../../../types";
import { parseLegacyCounterpart } from "../../../dmdata/legacy-counterpart-parser";
import type { LegacyCounterpartOutcome } from "../types";

/**
 * 旧形式防災情報の最小表示経路。
 * body はこの段階では解釈せず、対応電文の確定は Phase 6B 単位 3 に委ねる。
 */
export function processLegacyCounterpart(msg: WsDataMessage): LegacyCounterpartOutcome | null {
  const parsed = parseLegacyCounterpart(msg);
  if (parsed == null) return null;
  return {
    domain: "legacyCounterpart",
    msg,
    headType: msg.head.type,
    statsCategory: "other",
    parsed,
    reason: "counterpartRuleUnconfirmed",
    severity: "unknown",
    stats: {
      shouldRecord: true,
      eventId: parsed.eventId,
    },
    presentation: {
      frameLevel: "info",
    },
  };
}
