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
) => LegacyCounterpartSeverity;

function isConfirmedVpoaActiveEvidence(
  evidence: ParsedLegacyCounterpartInfo["severityEvidence"][number],
): boolean {
  if (evidence.severity !== "high" || evidence.kindCode !== "1") return false;
  return evidence.source === "head"
    ? evidence.condition === "発表"
    : evidence.source === "body" && evidence.status === "発表";
}

function resolveVpoa50Severity(parsed: ParsedLegacyCounterpartInfo): LegacyCounterpartSeverity {
  if (parsed.infoType === "取消") return "unknown";
  if (parsed.infoType !== "発表" && parsed.infoType !== "訂正") return "unknown";
  return parsed.severityEvidence.length === 2
    && new Set(parsed.severityEvidence.map((evidence) => evidence.source)).size === 2
    && parsed.severityEvidence.every(isConfirmedVpoaActiveEvidence)
    ? "high"
    : "unknown";
}

/** 実 fixture で確認済みの VPOA50 severity rule。counterpart rule は別単位で有効化する。 */
export const PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES:
ReadonlyMap<LegacyCounterpartSourceType, LegacyCounterpartSeverityRule> = new Map([
  ["VPOA50", resolveVpoa50Severity],
]);

/**
 * 旧形式防災情報の表示経路。対応電文の確定は Phase 6B 単位 2 に委ねる。
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
      frameLevel: severity === "high" ? "warning" : "info",
      ...(severity === "high"
        ? { soundLevel: "warning" as const, notifyCategory: "weather" as const }
        : {}),
    },
  };
}
