import { extractSpecialValue } from "../../dmdata/special-value";
import * as log from "../../logger";
import type { SpecialValue } from "../../types";
import type { DisplayTsunamiHeightSemanticV1 } from "./protocol";
import { specialValueDisplaySemantic } from "../../utils/intensity";

function scalarTsunamiHeightValue(scalar: string): SpecialValue<number> {
  const normalized = scalar.normalize("NFKC").trim();
  const numericRaw = normalized.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/)?.[0] ?? normalized;
  const extracted = extractSpecialValue("TsunamiHeight", {
    "#text": numericRaw,
    "@_description": scalar,
  });
  return { ...extracted, raw: scalar };
}

function nonEmptyLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function numericLabel(value: number): string {
  return `${value}m`;
}

function boundLabel(value: number | null): string | null {
  return value == null ? null : numericLabel(value);
}

function isFiniteNonNegative(value: number | null | undefined): boolean {
  return value == null || Number.isFinite(value) && value >= 0;
}

/** display 境界で SpecialValue の numeric domain invariant を再確認する。 */
function tsunamiHeightValidationError(value: SpecialValue<number>): string | null {
  const exact = value.value ?? null;
  const lower = value.lowerBound ?? null;
  const upper = value.upperBound ?? null;
  if (!isFiniteNonNegative(exact)) return "value is not finite and non-negative";
  if (!isFiniteNonNegative(lower)) return "lowerBound is not finite and non-negative";
  if (!isFiniteNonNegative(upper)) return "upperBound is not finite and non-negative";
  if (lower != null && upper != null && lower > upper) {
    return "lowerBound exceeds upperBound";
  }

  switch (value.presence) {
    case "value":
      if (exact == null) return "value presence requires value";
      if (lower != null || upper != null) return "value presence forbids bounds";
      return value.raw == null ? "value presence requires raw" : null;
    case "missing":
      return exact == null
        && lower == null
        && upper == null
        && value.raw == null
        && value.condition == null
        && value.description == null
        ? null
        : "missing presence forbids value, bounds, raw, condition, and description";
    case "empty":
      return exact == null
        && lower == null
        && upper == null
        && value.raw != null
        && value.raw.trim() === ""
        ? null
        : "empty presence requires blank raw and forbids value and bounds";
    case "unknown":
      return exact == null && lower == null && upper == null
        ? null
        : "unknown presence forbids value and bounds";
    case "qualitative":
      return exact == null && upper == null
        ? null
        : "qualitative presence forbids value and upperBound";
    case "range":
      if (exact != null) return "range presence forbids value";
      return lower != null || upper != null ? null : "range presence requires a bound";
  }
}

function rawBound(
  raw: string | null | undefined,
  numeric: number | null | undefined,
): string | null {
  return raw ?? (numeric == null ? null : String(numeric));
}

function malformedSemantic(
  value: SpecialValue<number>,
): DisplayTsunamiHeightSemanticV1 {
  return {
    raw: value.raw,
    presence: "unknown",
    label: "不明",
    condition: value.condition,
    description: value.description,
    value: null,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: rawBound(value.rawLowerBound, value.lowerBound),
    rawUpperBound: rawBound(value.rawUpperBound, value.upperBound),
    badge: "?",
    color: "unknown",
    render: true,
  };
}

function fallbackLabel(
  value: SpecialValue<number>,
  scalar: string | null | undefined,
): string | null {
  const scalarLabel = nonEmptyLabel(scalar);
  const description = nonEmptyLabel(value.description);
  const condition = nonEmptyLabel(value.condition);
  const raw = nonEmptyLabel(value.raw);

  switch (value.presence) {
    case "value":
      if (scalarLabel != null) return scalarLabel;
      if (description != null) return description;
      if (raw != null) {
        return /m|メートル/i.test(raw) || value.value == null
          ? raw
          : numericLabel(value.value);
      }
      return value.value == null ? null : numericLabel(value.value);
    case "missing":
      return null;
    case "empty":
      return "空欄";
    case "unknown":
      return description ?? condition ?? scalarLabel ?? "不明";
    case "qualitative":
      if (description != null) return description;
      if (condition != null) return condition;
      if (scalarLabel != null) return scalarLabel;
      if (raw != null && Number.isNaN(Number(raw))) return raw;
      break;
    case "range":
      if (description != null) return description;
      if (scalarLabel != null) return scalarLabel;
      break;
  }

  const lower = boundLabel(value.lowerBound ?? null);
  const upper = boundLabel(value.upperBound ?? null);
  if (lower != null && upper != null) return lower === upper ? lower : `${lower}〜${upper}`;
  if (lower != null) {
    return value.rawUpperBound?.normalize("NFKC").trim().toLowerCase() === "over"
      ? `${lower}程度以上`
      : `${lower}以上`;
  }
  if (upper != null) return `${upper}以下`;
  return value.presence === "qualitative" ? "不明" : null;
}

/** SpecialValue<number> を frontend が再解析せず使う V1 additive semantic へ射影する。 */
export function projectTsunamiHeightSemantic(
  value: SpecialValue<number> | undefined,
  scalar?: string | null,
): DisplayTsunamiHeightSemanticV1 | undefined {
  const source = value ?? (scalar == null ? undefined : scalarTsunamiHeightValue(scalar));
  if (source == null) return undefined;
  const validationError = tsunamiHeightValidationError(source);
  if (validationError != null) {
    log.warn(
      "[tsunami-height-semantic] specialValueConflict: malformed TsunamiHeight "
      + `downgraded to unknown (${validationError}; presence=${source.presence}; `
      + `raw=${JSON.stringify(source.raw)}; value=${String(source.value)}; `
      + `lowerBound=${String(source.lowerBound)}; upperBound=${String(source.upperBound)})`,
    );
    return malformedSemantic(source);
  }
  const display = specialValueDisplaySemantic(source);
  return {
    raw: source.raw,
    presence: source.presence,
    label: fallbackLabel(source, scalar),
    condition: source.condition,
    description: source.description,
    value: source.value ?? null,
    lowerBound: source.lowerBound ?? null,
    upperBound: source.upperBound ?? null,
    rawLowerBound: source.rawLowerBound ?? null,
    rawUpperBound: source.rawUpperBound ?? null,
    badge: display.badge,
    color: display.color,
    render: display.render,
  };
}
