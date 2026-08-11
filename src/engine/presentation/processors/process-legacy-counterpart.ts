import type {
  LegacyCounterpartSeverity,
  LegacyCounterpartSourceType,
  ParsedLegacyCounterpartInfo,
  WsDataMessage,
} from "../../../types";
import { parseLegacyCounterpart } from "../../../dmdata/legacy-counterpart-parser";
import type { LegacyCounterpartOutcome } from "../types";

export type LegacyCounterpartSeverityRule = (
  parsed: ParsedLegacyCounterpartInfo,
) => Exclude<LegacyCounterpartSeverity, "unknown">;

/** 実 code fixture の確認前は空のまま維持する production severity registry。 */
export const PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES:
ReadonlyMap<LegacyCounterpartSourceType, LegacyCounterpartSeverityRule> = new Map();

/**
 * 旧形式防災情報の最小表示経路。
 * body はこの段階では解釈せず、対応電文の確定は Phase 6B 単位 3 に委ねる。
 */
export function processLegacyCounterpart(msg: WsDataMessage): LegacyCounterpartOutcome | null {
  const parsed = parseLegacyCounterpart(msg);
  if (parsed == null) return null;
  const severity = PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES.get(parsed.type)?.(parsed)
    ?? "unknown";
  return {
    domain: "legacyCounterpart",
    msg,
    headType: msg.head.type,
    statsCategory: "other",
    parsed,
    reason: "counterpartRuleUnconfirmed",
    severity,
    stats: {
      shouldRecord: true,
      eventId: parsed.eventId,
    },
    presentation: {
      frameLevel: "info",
    },
  };
}
