import type { SpecialValue, SpecialValueDiagnostic } from "../types";
import {
  isGiantMagnitudeText,
  SHALLOW_DEPTH_UPPER_BOUND_KM,
  withShallowDepthUpperBound,
} from "../utils/magnitude";
import type {
  DisplayDepthSemanticV1,
  DisplayMagnitudeSemanticV1,
} from "./display/protocol";
import {
  projectDepthSemantic,
  projectMagnitudeSemantic,
} from "./display/magnitude-depth-semantic";

const PRESENCES = new Set([
  "value", "missing", "empty", "unknown", "qualitative", "range",
]);
const DIAGNOSTICS = new Set<SpecialValueDiagnostic>([
  "unmappedSpecialValue", "specialValueConflict", "legacyNullUnknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value == null ? value !== undefined : typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value == null
    ? value !== undefined
    : typeof value === "number" && Number.isFinite(value);
}

function parseDiagnostics(value: unknown): SpecialValueDiagnostic[] | null {
  if (!Array.isArray(value) || !value.every(
    (item): item is SpecialValueDiagnostic => typeof item === "string"
      && DIAGNOSTICS.has(item as SpecialValueDiagnostic),
  )) return null;
  return [...value];
}

/**
 * 永続化する canonical SpecialValue は、未設定の optional bounds を省略する。
 * reader は移行期間の明示 null も受理し、同じ省略形へ正規化する。
 */
export function parsePersistedNumericSpecialValue(value: unknown): SpecialValue<number> | null {
  if (
    !isRecord(value)
    || !["raw", "value", "condition", "description", "presence"].every(
      (key) => Object.hasOwn(value, key),
    )
    || !isNullableString(value.raw)
    || !isNullableFiniteNumber(value.value)
    || !isNullableString(value.condition)
    || !isNullableString(value.description)
    || typeof value.presence !== "string"
    || !PRESENCES.has(value.presence)
    || Object.hasOwn(value, "lowerBound") && !isNullableFiniteNumber(value.lowerBound)
    || Object.hasOwn(value, "upperBound") && !isNullableFiniteNumber(value.upperBound)
    || Object.hasOwn(value, "rawLowerBound") && !isNullableString(value.rawLowerBound)
    || Object.hasOwn(value, "rawUpperBound") && !isNullableString(value.rawUpperBound)
  ) return null;
  const hasDiagnostics = Object.hasOwn(value, "diagnostics");
  const diagnostics = hasDiagnostics ? parseDiagnostics(value.diagnostics) : undefined;
  if (hasDiagnostics && diagnostics == null) return null;

  const parsed: SpecialValue<number> = {
    raw: value.raw,
    value: value.value,
    condition: value.condition,
    description: value.description,
    presence: value.presence as SpecialValue<number>["presence"],
    ...(value.lowerBound == null ? {} : { lowerBound: value.lowerBound as number }),
    ...(value.upperBound == null ? {} : { upperBound: value.upperBound as number }),
    ...(value.rawLowerBound == null ? {} : { rawLowerBound: value.rawLowerBound as string }),
    ...(value.rawUpperBound == null ? {} : { rawUpperBound: value.rawUpperBound as string }),
    ...(diagnostics == null ? {} : { diagnostics }),
  };
  const hasBounds = parsed.lowerBound != null || parsed.upperBound != null;
  const hasRawLower = parsed.rawLowerBound != null;
  const hasRawUpper = parsed.rawUpperBound != null;
  if (parsed.presence === "value") {
    return parsed.value != null && parsed.raw != null && !hasBounds ? parsed : null;
  }
  if (parsed.value != null) return null;
  if (parsed.presence === "missing") {
    return parsed.raw == null
      && parsed.condition == null
      && parsed.description == null
      && !hasBounds
      && !hasRawLower
      && !hasRawUpper
      ? parsed
      : null;
  }
  if (parsed.presence === "empty") {
    return parsed.raw != null
      && parsed.raw.trim() === ""
      && !hasBounds
      && !hasRawLower
      && !hasRawUpper
      ? parsed
      : null;
  }
  if (parsed.presence === "range") {
    return parsed.raw != null && hasBounds ? parsed : null;
  }
  return parsed.raw != null ? parsed : null;
}

export function normalizeNumericSpecialValueForPersistence(
  value: SpecialValue<number>,
): SpecialValue<number> {
  const normalized = parsePersistedNumericSpecialValue(value);
  if (normalized == null) throw new Error("invalid Magnitude/Depth SpecialValue");
  return normalized;
}

/** Depth reader は旧 canonical の「ごく浅い」に 5km 未満の上限を補う。 */
export function parsePersistedDepthSpecialValue(
  value: unknown,
): SpecialValue<number> | null {
  const parsed = parsePersistedNumericSpecialValue(value);
  return parsed == null ? null : withShallowDepthUpperBound(parsed);
}

function missingNumericValue(): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
  };
}

export function magnitudeValueFromLegacyScalar(value: string | null): SpecialValue<number> {
  if (value == null || value.trim() === "") return missingNumericValue();
  const normalized = value.normalize("NFKC").trim();
  const numericText = normalized.startsWith("M") ? normalized.slice(1) : normalized;
  const numeric = Number(numericText);
  if (numericText !== "" && Number.isFinite(numeric)) {
    return {
      raw: value,
      value: numeric,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  if (isGiantMagnitudeText(normalized.replace(/\s+/g, ""))) {
    return {
      raw: value,
      value: null,
      condition: null,
      description: value,
      presence: "qualitative",
    };
  }
  if (normalized === "M不明" || normalized === "不明") {
    return {
      raw: value,
      value: null,
      condition: null,
      description: null,
      presence: "unknown",
    };
  }
  return {
    raw: value,
    value: null,
    condition: null,
    description: null,
    presence: "qualitative",
    diagnostics: ["unmappedSpecialValue"],
  };
}

export function depthValueFromLegacyScalar(value: string | null): SpecialValue<number> {
  if (value == null || value.trim() === "") return missingNumericValue();
  const normalized = value.normalize("NFKC").trim();
  if (normalized === "ごく浅い") {
    return {
      raw: value,
      value: null,
      condition: null,
      description: value,
      presence: "qualitative",
      upperBound: SHALLOW_DEPTH_UPPER_BOUND_KM,
    };
  }
  const numericMatch = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*km$/i.exec(normalized);
  if (numericMatch != null) {
    const numeric = Number(numericMatch[1]);
    if (Number.isFinite(numeric)) {
      return numeric === 0
        ? {
            raw: value,
            value: null,
            condition: null,
            description: "ごく浅い",
            presence: "qualitative",
            upperBound: SHALLOW_DEPTH_UPPER_BOUND_KM,
          }
        : {
            raw: value,
            value: numeric,
            condition: null,
            description: null,
            presence: "value",
          };
    }
  }
  if (normalized === "不明") {
    return {
      raw: value,
      value: null,
      condition: null,
      description: null,
      presence: "unknown",
    };
  }
  return {
    raw: value,
    value: null,
    condition: null,
    description: null,
    presence: "qualitative",
    diagnostics: ["unmappedSpecialValue"],
  };
}

export function numericSpecialValueFromDisplaySemantic(
  semantic: DisplayDepthSemanticV1 | DisplayMagnitudeSemanticV1,
): SpecialValue<number> | null {
  return parsePersistedNumericSpecialValue({
    raw: semantic.raw,
    value: semantic.value,
    condition: semantic.condition,
    description: semantic.description,
    presence: semantic.presence,
    lowerBound: semantic.lowerBound,
    upperBound: semantic.upperBound,
    rawLowerBound: semantic.rawLowerBound,
    rawUpperBound: semantic.rawUpperBound,
  });
}

/** Depth semantic reader だけが旧「ごく浅い」の内部上限を補う。 */
export function depthValueFromDisplaySemantic(
  semantic: DisplayDepthSemanticV1,
): SpecialValue<number> | null {
  const parsed = numericSpecialValueFromDisplaySemantic(semantic);
  return parsed == null ? null : withShallowDepthUpperBound(parsed);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

/** display semantic の bounds は protocol と同じく常に明示 null。 */
export function parsePersistedMagnitudeSemantic(value: unknown): DisplayMagnitudeSemanticV1 | null {
  if (!isRecord(value)) return null;
  const semantic = value as unknown as DisplayMagnitudeSemanticV1;
  const source = numericSpecialValueFromDisplaySemantic(semantic);
  if (source == null) return null;
  const projected = projectMagnitudeSemantic(source);
  return projected != null && sameJson(projected, value) ? projected : null;
}

/** display semantic の bounds は protocol と同じく常に明示 null。 */
export function parsePersistedDepthSemantic(value: unknown): DisplayDepthSemanticV1 | null {
  if (!isRecord(value)) return null;
  const semantic = value as unknown as DisplayDepthSemanticV1;
  const persistedSource = parsePersistedNumericSpecialValue({
    raw: semantic.raw,
    value: semantic.value,
    condition: semantic.condition,
    description: semantic.description,
    presence: semantic.presence,
    lowerBound: semantic.lowerBound,
    upperBound: semantic.upperBound,
    rawLowerBound: semantic.rawLowerBound,
    rawUpperBound: semantic.rawUpperBound,
  });
  if (persistedSource == null) return null;
  const source = withShallowDepthUpperBound(persistedSource);
  const projected = projectDepthSemantic(source);
  if (projected == null) return null;
  if (sameJson(projected, value)) return projected;
  // 2026-08-10 裁定前の bounds なし「ごく浅い」semantic だけ読込方向で移行する。
  const legacyProjected = projectDepthSemantic(persistedSource);
  return source !== persistedSource
    && legacyProjected != null
    && sameJson(legacyProjected, value)
    ? projected
    : null;
}

export function magnitudeSemanticFromLegacyScalar(
  value: string | null,
): DisplayMagnitudeSemanticV1 {
  return projectMagnitudeSemantic(magnitudeValueFromLegacyScalar(value))!;
}

export function depthSemanticFromLegacyScalar(value: string | null): DisplayDepthSemanticV1 {
  return projectDepthSemantic(depthValueFromLegacyScalar(value))!;
}
