import type { SpecialValue } from "../../types";
import {
  formatDepthSpecialValue,
  formatMagnitudeSpecialValue,
  magnitudeSerializableRank,
} from "../../utils/magnitude";
import { specialValueDisplaySemantic } from "../../utils/intensity";
import type {
  DisplayDepthSemanticV1,
  DisplayMagnitudeSemanticV1,
  DisplayNumericSpecialValueSemanticV1,
} from "./protocol";

function projectNumericSemantic(
  source: SpecialValue<number>,
  label: string | null,
): DisplayNumericSpecialValueSemanticV1 {
  const display = specialValueDisplaySemantic(source);
  return {
    raw: source.raw,
    presence: source.presence,
    label,
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

/** Magnitude canonical を raw 再解析不要かつ JSON-safe な wire semantic へ射影する。 */
export function projectMagnitudeSemantic(
  source: SpecialValue<number> | undefined,
): DisplayMagnitudeSemanticV1 | undefined {
  if (source == null) return undefined;
  return {
    ...projectNumericSemantic(source, formatMagnitudeSpecialValue(source)),
    rank: magnitudeSerializableRank(source),
  };
}

/** Depth canonical を bounds を明示 null に固定した wire semantic へ射影する。 */
export function projectDepthSemantic(
  source: SpecialValue<number> | undefined,
): DisplayDepthSemanticV1 | undefined {
  if (source == null) return undefined;
  return projectNumericSemantic(source, formatDepthSpecialValue(source));
}
