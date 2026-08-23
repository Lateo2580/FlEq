import type {
  LegacyCounterpartSourceType,
  TelegramInfoTypeValue,
  TelegramMeta,
} from "../../types";

export const LEGACY_SOURCE_HOLDBACK_MS = 60_000;
export const LEGACY_CORRELATION_WINDOW_BEFORE_MS = 5 * 60_000;
export const LEGACY_CORRELATION_WINDOW_AFTER_MS = 5 * 60_000;
export const LEGACY_CORRELATION_RETENTION_MS = 11 * 60_000;

export interface LegacyCounterpartRevisionRef {
  reportDateTimeMs: number;
  serial: number | null;
}

/** 名称を含めない、code-only fallback identity。 */
export interface LegacyCounterpartCorrelationKey {
  officeCode: string | null;
  areaCodes: readonly string[];
  phenomenonCodes: readonly string[];
  kindCodes: readonly string[];
  targetTimeMs: number | null;
  /** synthetic rule と将来の実 fixture rule が訂正・取消対象を明示するための参照。 */
  targetRevision?: LegacyCounterpartRevisionRef | null;
}

export interface LegacyCounterpartEventIdNormalizationInput {
  side: "source" | "counterpart";
  headType: string;
  /** trim 済みの raw EventID。比較だけに使い、meta／表示の raw 値は変更しない。 */
  eventId: string;
  /** eventId と同じ値。hook 実装で raw 性を明示したい場合の additive alias。 */
  rawEventId: string;
}

export interface LegacyCounterpartRule {
  sourceType: LegacyCounterpartSourceType;
  status: "unconfirmed" | "confirmed";
  counterpartTypes: readonly string[];
  extractEventKey: (
    meta: TelegramMeta,
    parsed: unknown,
  ) => LegacyCounterpartCorrelationKey | null;
  windowBeforeMs: number;
  windowAfterMs: number;
  holdbackMs: number;
  /** 両側に raw EventID があるときだけ、比較用 canonical EventID を返す additive hook。 */
  normalizeEventId?: (
    input: LegacyCounterpartEventIdNormalizationInput,
  ) => string | null;
  /** 相関 cache へ入れる InfoType。未指定時は既存の全 InfoType を受理する。 */
  eligibleInfoTypes?: readonly TelegramInfoTypeValue[];
}

export interface LegacyCounterpartRegistry {
  readonly rules: readonly LegacyCounterpartRule[];
  readonly ruleBySourceType: ReadonlyMap<LegacyCounterpartSourceType, LegacyCounterpartRule>;
  readonly ruleByCounterpartType: ReadonlyMap<string, LegacyCounterpartRule>;
  readonly activeCounterpartTypes: ReadonlySet<string>;
}

function freezeRule(rule: LegacyCounterpartRule): LegacyCounterpartRule {
  return Object.freeze({
    ...rule,
    counterpartTypes: Object.freeze([...rule.counterpartTypes]),
    ...(rule.eligibleInfoTypes == null
      ? {}
      : { eligibleInfoTypes: Object.freeze([...rule.eligibleInfoTypes]) }),
  });
}

export function createLegacyCounterpartRegistry(
  inputRules: readonly LegacyCounterpartRule[],
): LegacyCounterpartRegistry {
  const rules = inputRules.map(freezeRule);
  const ruleBySourceType = new Map<LegacyCounterpartSourceType, LegacyCounterpartRule>();
  const ruleByCounterpartType = new Map<string, LegacyCounterpartRule>();

  for (const rule of rules) {
    if (ruleBySourceType.has(rule.sourceType)) {
      throw new Error(`duplicate legacy source rule: ${rule.sourceType}`);
    }
    if (rule.status === "unconfirmed" && rule.counterpartTypes.length !== 0) {
      throw new Error(`unconfirmed legacy rule must not declare counterparts: ${rule.sourceType}`);
    }
    ruleBySourceType.set(rule.sourceType, rule);
    if (rule.status !== "confirmed") continue;
    for (const counterpartType of rule.counterpartTypes) {
      const normalizedType = counterpartType.trim();
      if (normalizedType === "") {
        throw new Error(`blank legacy counterpart type: ${rule.sourceType}`);
      }
      const owner = ruleByCounterpartType.get(normalizedType);
      if (owner != null) {
        throw new Error(
          `legacy counterpart type ${normalizedType} is owned by both ${owner.sourceType} and ${rule.sourceType}`,
        );
      }
      ruleByCounterpartType.set(normalizedType, rule);
    }
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    ruleBySourceType,
    ruleByCounterpartType,
    activeCounterpartTypes: new Set(ruleByCounterpartType.keys()),
  });
}

function unconfirmedRule(sourceType: LegacyCounterpartSourceType): LegacyCounterpartRule {
  return {
    sourceType,
    status: "unconfirmed",
    counterpartTypes: [],
    extractEventKey: () => null,
    windowBeforeMs: LEGACY_CORRELATION_WINDOW_BEFORE_MS,
    windowAfterMs: LEGACY_CORRELATION_WINDOW_AFTER_MS,
    holdbackMs: LEGACY_SOURCE_HOLDBACK_MS,
  };
}

function normalizeVpoa50EventId(
  input: LegacyCounterpartEventIdNormalizationInput,
): string | null {
  if (input.side === "source") return input.eventId;
  if (input.headType !== "VPBS50") return null;
  return /^K(JP[A-Z]{2}\d{12}_\d{12})$/.exec(input.eventId)?.[1] ?? null;
}

/** 実 pair で確認済みの VPOA50→VPBS50 rule。code fallback は未確認のため成立させない。 */
const vpoa50Rule: LegacyCounterpartRule = {
  sourceType: "VPOA50",
  status: "confirmed",
  counterpartTypes: ["VPBS50"],
  extractEventKey: () => null,
  windowBeforeMs: LEGACY_CORRELATION_WINDOW_BEFORE_MS,
  windowAfterMs: LEGACY_CORRELATION_WINDOW_AFTER_MS,
  holdbackMs: LEGACY_SOURCE_HOLDBACK_MS,
  normalizeEventId: normalizeVpoa50EventId,
  eligibleInfoTypes: ["発表"],
};

/** VPOA50→VPBS50 だけを実 pair で確認済みとして有効化する production registry。 */
export const PRODUCTION_LEGACY_COUNTERPART_REGISTRY = createLegacyCounterpartRegistry([
  vpoa50Rule,
  unconfirmedRule("VPNO50"),
  unconfirmedRule("VXWW50"),
]);
