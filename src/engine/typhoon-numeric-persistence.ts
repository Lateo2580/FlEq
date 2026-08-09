import type { SpecialValue } from "../types";
import {
  parsePersistedNumericSpecialValue,
} from "./magnitude-depth-persistence";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** scalar-only 台風 snapshot の読込方向 migration。null の意味不明性を診断へ残す。 */
export function typhoonNumericValueFromLegacyScalar(
  value: number | null,
): SpecialValue<number> {
  if (value != null) {
    return {
      raw: String(value),
      value,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "unknown",
    diagnostics: ["legacyNullUnknown"],
  };
}

/** 台風 canonical reader。lower／upper の raw bound は独立 optional として扱う。 */
export function parsePersistedTyphoonNumericValue(
  value: unknown,
): SpecialValue<number> | null {
  if (!isRecord(value)) return null;
  const hasRawLowerBound = Object.hasOwn(value, "rawLowerBound");
  const hasRawUpperBound = Object.hasOwn(value, "rawUpperBound");
  if (
    value.raw === null
    && value.value === null
    && value.condition === null
    && value.description === null
    && value.presence === "unknown"
    && Array.isArray(value.diagnostics)
    && value.diagnostics.length === 1
    && value.diagnostics[0] === "legacyNullUnknown"
    && !Object.hasOwn(value, "lowerBound")
    && !Object.hasOwn(value, "upperBound")
    && !hasRawLowerBound
    && !hasRawUpperBound
  ) {
    return {
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "unknown",
      diagnostics: ["legacyNullUnknown"],
    };
  }
  return parsePersistedNumericSpecialValue(value);
}

export function normalizeTyphoonNumericValueForPersistence(
  value: SpecialValue<number>,
): SpecialValue<number> {
  const normalized = parsePersistedTyphoonNumericValue(value);
  if (normalized == null) throw new Error("invalid typhoon numeric SpecialValue");
  return normalized;
}
