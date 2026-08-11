import type {
  LegacyCounterpartSourceType,
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

/** 実在 counterpart を推定しない production registry。 */
export const PRODUCTION_LEGACY_COUNTERPART_REGISTRY = createLegacyCounterpartRegistry([
  unconfirmedRule("VPOA50"),
  unconfirmedRule("VPNO50"),
  unconfirmedRule("VXWW50"),
]);

