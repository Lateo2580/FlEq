import type { PlumeHeightSemantic, SpecialValue } from "../../types";
import {
  formatPlumeHeightSpecialValue,
  plumeHeightSerializableRank,
} from "../../utils/plume-height";
import { specialValueDisplaySemantic } from "../../utils/intensity";
import type {
  DisplayPlumeHeightSemanticV1,
} from "./protocol";

/** PlumeHeight canonical を raw 再解析不要かつ JSON-safe な wire semantic へ射影する。 */
export function projectPlumeHeightSemantic(
  source: PlumeHeightSemantic | undefined,
): DisplayPlumeHeightSemanticV1 | undefined {
  if (source == null) return undefined;
  const display = specialValueDisplaySemantic(source.value);
  return {
    reference: source.reference,
    unit: source.unit,
    raw: source.value.raw,
    presence: source.value.presence,
    label: formatPlumeHeightSpecialValue(source, "card"),
    condition: source.value.condition,
    description: source.value.description,
    value: source.value.value ?? null,
    lowerBound: source.value.lowerBound ?? null,
    upperBound: source.value.upperBound ?? null,
    rawLowerBound: source.value.rawLowerBound ?? null,
    rawUpperBound: source.value.rawUpperBound ?? null,
    diagnostics: [...(source.value.diagnostics ?? [])],
    badge: display.badge,
    color: display.color,
    render: display.render,
    rank: plumeHeightSerializableRank(source),
  };
}

function missingValue(diagnostic = false): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...(diagnostic
      ? { diagnostics: ["legacyNullUnknown" as const] }
      : {}),
  };
}

/** 旧 scalar/boolean volcano snapshot を読込方向だけ canonical 化する。 */
export function plumeHeightFromLegacyScalar(
  plumeHeightM: number | null,
  plumeHeightUnknown: boolean,
): PlumeHeightSemantic {
  if (plumeHeightM != null) {
    return {
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: String(plumeHeightM),
        value: plumeHeightM,
        condition: null,
        description: null,
        presence: "value",
      },
    };
  }
  if (plumeHeightUnknown) {
    return {
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: null,
        value: null,
        condition: "不明",
        description: null,
        presence: "unknown",
      },
    };
  }
  return { reference: "aboveCrater", unit: "m", value: missingValue(true) };
}

export function missingSeaLevelPlumeHeight(): PlumeHeightSemantic {
  return { reference: "aboveSeaLevel", unit: "FT", value: missingValue() };
}

export function legacyDisplayPlumeHeightSemantics(
  plumeHeightM: number | null,
  plumeHeightUnknown: boolean,
): {
  plumeHeightAboveCraterSemantic: DisplayPlumeHeightSemanticV1;
  plumeHeightAboveSeaLevelSemantic: DisplayPlumeHeightSemanticV1;
} {
  return {
    plumeHeightAboveCraterSemantic:
      projectPlumeHeightSemantic(plumeHeightFromLegacyScalar(
        plumeHeightM,
        plumeHeightUnknown,
      ))!,
    plumeHeightAboveSeaLevelSemantic:
      projectPlumeHeightSemantic(missingSeaLevelPlumeHeight())!,
  };
}

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

const PLUME_SEMANTIC_KEYS = [
  "reference", "unit", "raw", "presence", "label", "condition", "description",
  "value", "lowerBound", "upperBound", "diagnostics", "badge", "color", "render", "rank",
] as const;

/** persistence reader 用。wire 全 field と canonical invariant を同時検証する。 */
export function isDisplayPlumeHeightSemantic(
  value: unknown,
  reference: PlumeHeightSemantic["reference"],
  unit: PlumeHeightSemantic["unit"],
): value is DisplayPlumeHeightSemanticV1 {
  if (
    !isRecord(value)
    || !PLUME_SEMANTIC_KEYS.every((key) => Object.hasOwn(value, key))
    || value.reference !== reference
    || value.unit !== unit
    || !isNullableString(value.raw)
    || !isNullableString(value.label)
    || !isNullableString(value.condition)
    || !isNullableString(value.description)
    || !isNullableFiniteNumber(value.value)
    || !isNullableFiniteNumber(value.lowerBound)
    || !isNullableFiniteNumber(value.upperBound)
    || !(value.rawLowerBound === undefined || isNullableString(value.rawLowerBound))
    || !(value.rawUpperBound === undefined || isNullableString(value.rawUpperBound))
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every((diagnostic) =>
      diagnostic === "unmappedSpecialValue"
      || diagnostic === "specialValueConflict"
      || diagnostic === "legacyNullUnknown")
    || !["value", "missing", "empty", "unknown", "qualitative", "range"]
      .includes(typeof value.presence === "string" ? value.presence : "")
  ) return false;

  const specialValue: SpecialValue<number> = {
    raw: value.raw,
    value: value.value,
    condition: value.condition,
    description: value.description,
    presence: value.presence as SpecialValue<number>["presence"],
    ...(value.lowerBound == null ? {} : { lowerBound: value.lowerBound }),
    ...(value.upperBound == null ? {} : { upperBound: value.upperBound }),
    ...(value.rawLowerBound == null ? {} : { rawLowerBound: value.rawLowerBound }),
    ...(value.rawUpperBound == null ? {} : { rawUpperBound: value.rawUpperBound }),
    ...(value.diagnostics.length === 0
      ? {}
      : { diagnostics: [...value.diagnostics] }),
  };
  const hasBound = specialValue.lowerBound != null || specialValue.upperBound != null;
  if (specialValue.presence === "value") {
    if (specialValue.raw == null || specialValue.value == null || hasBound) return false;
  } else if (specialValue.value != null) return false;
  if (specialValue.presence === "missing" && (
    specialValue.raw != null
    || specialValue.condition != null
    || specialValue.description != null
    || hasBound
  )) return false;
  if (specialValue.presence === "empty" && (
    specialValue.raw == null
    || specialValue.raw.trim() !== ""
    || hasBound
  )) return false;
  if (specialValue.presence === "range" && (
    specialValue.raw == null || !hasBound
  )) return false;
  if (specialValue.presence === "unknown" && hasBound) return false;

  const expected = projectPlumeHeightSemantic({ reference, unit, value: specialValue });
  return expected != null && PLUME_SEMANTIC_KEYS.every((key) =>
    JSON.stringify(value[key]) === JSON.stringify(expected[key]))
    && (value.rawLowerBound ?? null) === expected.rawLowerBound
    && (value.rawUpperBound ?? null) === expected.rawUpperBound;
}

export function copyDisplayPlumeHeightSemantic(
  semantic: DisplayPlumeHeightSemanticV1 | undefined,
): DisplayPlumeHeightSemanticV1 | undefined {
  return semantic == null ? undefined : {
    ...semantic,
    rawLowerBound: semantic.rawLowerBound ?? null,
    rawUpperBound: semantic.rawUpperBound ?? null,
    diagnostics: [...semantic.diagnostics],
    rank: { ...semantic.rank },
  };
}
