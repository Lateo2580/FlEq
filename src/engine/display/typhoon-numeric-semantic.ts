import type { SpecialValue } from "../../types";
import {
  formatNumericSpecialValue,
  numericSpecialValueSerializableRank,
  type NumericSpecialValueUnit,
} from "../../utils/numeric-special-value";
import { specialValueDisplaySemantic } from "../../utils/intensity";
import type { DisplayTyphoonNumericSemanticV1 } from "./protocol";

/** 台風数値 canonical を raw 再解析不要かつ JSON-safe な wire semantic へ射影する。 */
export function projectTyphoonNumericSemantic(
  source: SpecialValue<number> | undefined,
  unit: NumericSpecialValueUnit,
): DisplayTyphoonNumericSemanticV1 | undefined {
  if (source == null) return undefined;
  const display = specialValueDisplaySemantic(source);
  return {
    raw: source.raw,
    presence: source.presence,
    label: formatNumericSpecialValue(source, unit),
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
    rank: numericSpecialValueSerializableRank(source),
  };
}
