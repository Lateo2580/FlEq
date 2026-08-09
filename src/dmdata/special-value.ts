import type {
  JmaIntensity,
  JmaLgIntensity,
  SpecialValue,
  SpecialValueDiagnostic,
} from "../types";
import {
  isGiantMagnitudeText,
  SHALLOW_DEPTH_UPPER_BOUND_KM,
} from "../utils/magnitude";

export type SpecialValueDomain =
  | "Magnitude"
  | "Depth"
  | "Intensity"
  | "TsunamiHeight"
  | "LgInt"
  | "Pressure"
  | "WindSpeed"
  | "MovementSpeed"
  | "PlumeHeight";

export type NumericSpecialValueDomain = Exclude<
  SpecialValueDomain,
  "Intensity" | "LgInt"
>;

type ExtractedSpecialValue = SpecialValue<number | string>;
type XmlNode = Record<string, unknown>;

interface NodeParts {
  raw: string;
  condition: string | null;
  description: string | null;
  unit: string | null;
  lowerRaw: string | null;
  upperRaw: string | null;
}

const UNKNOWN_TERMS = ["不明", "不詳", "観測できず", "未入電", "解析不能"] as const;
const RANGE_LOWER_TERMS = ["以上", "超"] as const;
const RANGE_UPPER_TERMS = ["以下", "未満"] as const;
const INTENSITY_CONDITION_TERMS = [
  ...UNKNOWN_TERMS,
  "5弱以上未入電",
  ...RANGE_LOWER_TERMS,
  ...RANGE_UPPER_TERMS,
  "予測幅",
] as const;
const LG_INT_CONDITION_TERMS = [
  "未入電",
  "不明",
  "不詳",
  ...RANGE_LOWER_TERMS,
  ...RANGE_UPPER_TERMS,
  "予測幅",
] as const;
const TSUNAMI_HEIGHT_CONDITION_TERMS = [
  ...UNKNOWN_TERMS,
  "観測中",
  "上昇中",
  "下降中",
  "重要",
  ...RANGE_LOWER_TERMS,
  ...RANGE_UPPER_TERMS,
] as const;
const PLUME_HEIGHT_CONDITION_TERMS = [
  "雲中",
  "観測できず",
  "不明",
  "不詳",
  ...RANGE_LOWER_TERMS,
  ...RANGE_UPPER_TERMS,
] as const;

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function rawString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function attribute(node: unknown, name: string): string | null {
  if (!isXmlNode(node)) return null;
  return rawString(node[`@_${name}`]);
}

function childRaw(node: unknown, name: string): string | null {
  if (!isXmlNode(node) || !Object.hasOwn(node, name)) return null;
  const child = Array.isArray(node[name]) ? node[name][0] : node[name];
  if (isXmlNode(child)) return rawString(child["#text"]) ?? "";
  return rawString(child) ?? "";
}

function nodeParts(node: unknown): NodeParts {
  const raw = isXmlNode(node)
    ? rawString(node["#text"]) ?? ""
    : rawString(node) ?? "";
  return {
    raw,
    condition: attribute(node, "condition"),
    description: attribute(node, "description"),
    unit: attribute(node, "unit"),
    lowerRaw: childRaw(node, "From"),
    upperRaw: childRaw(node, "To"),
  };
}

function normalizeNumberSource(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replaceAll("．", ".")
    .replaceAll("＋", "+")
    .replaceAll("－", "-");
}

function parseNumber(raw: string): number | null {
  const normalized = normalizeNumberSource(raw);
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseIntensity(raw: string, domain: "Intensity" | "LgInt"): string | null {
  const normalized = normalizeNumberSource(raw);
  const pattern = domain === "Intensity"
    ? /^(?:0|1|2|3|4|5-|5\+|6-|6\+|7)$/
    : /^(?:0|1|2|3|4)$/;
  return pattern.test(normalized) ? normalized : null;
}

function parseDomainValue(domain: SpecialValueDomain, raw: string): number | string | null {
  return domain === "Intensity" || domain === "LgInt"
    ? parseIntensity(raw, domain)
    : parseNumber(raw);
}

function parseDepthValue(raw: string, unit: string | null): number | null {
  const value = parseNumber(raw);
  if (value == null) return null;
  const absolute = Math.abs(value);
  return unit === "m" ? absolute / 1000 : absolute;
}

function parseNodeDomainValue(
  domain: SpecialValueDomain,
  raw: string,
  unit: string | null,
): number | string | null {
  return domain === "Depth"
    ? parseDepthValue(raw, unit)
    : parseDomainValue(domain, raw);
}

function includesAny(value: string | null, terms: readonly string[]): boolean {
  return value != null && terms.some((term) => value.includes(term));
}

function includesInBodyOrCondition(parts: NodeParts, pattern: RegExp): boolean {
  return pattern.test(parts.raw) || pattern.test(parts.condition ?? "");
}

function normalizeSpecialTerm(value: string | null): string | null {
  return value == null ? null : value.normalize("NFKC").trim();
}

function matchesAnySpecialTerm(value: string | null, terms: readonly string[]): boolean {
  const normalized = normalizeSpecialTerm(value);
  return normalized != null && terms.includes(normalized);
}

type TyphoonNumericDomain = "Pressure" | "WindSpeed" | "MovementSpeed";

function isTyphoonNumericDomain(domain: SpecialValueDomain): domain is TyphoonNumericDomain {
  return domain === "Pressure" || domain === "WindSpeed" || domain === "MovementSpeed";
}

/** NFKC 後の完全一致、または否定形を拾わない肯定的な終端一致だけを許す。 */
function matchesTerminalSpecialTerm(value: string | null, terms: readonly string[]): boolean {
  const normalized = normalizeSpecialTerm(value);
  return normalized != null && terms.some(
    (term) => normalized === term || normalized.endsWith(term),
  );
}

interface TyphoonClassificationSource {
  kind: "raw" | "condition" | "description";
  value: string | null;
}

function typhoonClassificationSources(
  domain: TyphoonNumericDomain,
  parts: NodeParts,
): TyphoonClassificationSource[] {
  const common: TyphoonClassificationSource[] = [
    { kind: "condition", value: parts.condition },
    { kind: "raw", value: parts.raw },
  ];
  return domain === "MovementSpeed"
    ? [{ kind: "description", value: parts.description }, ...common]
    : common;
}

function isNormalizedNan(value: string | null): boolean {
  return normalizeSpecialTerm(value)?.toLowerCase() === "nan";
}

function isKnownTyphoonSpecialSource(
  domain: TyphoonNumericDomain,
  source: string | null,
): boolean {
  switch (domain) {
    case "Pressure":
      return matchesTerminalSpecialTerm(source, ["解析不能", "不明", "不詳"]);
    case "WindSpeed":
      return matchesAnySpecialTerm(source, ["なし"])
        || matchesTerminalSpecialTerm(source, ["不明", "不詳"]);
    case "MovementSpeed":
      return matchesTerminalSpecialTerm(
        source,
        ["ゆっくり", "ほとんど停滞", "不明", "不詳"],
      );
  }
}

function isKnownTyphoonCondition(
  domain: TyphoonNumericDomain,
  condition: string | null,
): boolean {
  const normalized = normalizeSpecialTerm(condition);
  if (normalized == null || normalized === "") return true;
  if (isKnownTyphoonSpecialSource(domain, normalized)) return true;
  if (domain === "WindSpeed") {
    return normalized === "中心付近"
      || normalized === "値なし"
      || terminalRangeDirection(normalized) != null;
  }
  return false;
}

function hasUnmappedTyphoonQualitativeSource(
  domain: TyphoonNumericDomain,
  parts: NodeParts,
): boolean {
  // valid 本文は unknown Condition から無効化せず、診断だけを付ける。
  if (parseNodeDomainValue(domain, parts.raw, parts.unit) != null) return false;
  return typhoonClassificationSources(domain, parts).some(({ kind, value }) => {
    const normalized = normalizeSpecialTerm(value);
    if (normalized == null || normalized === "") return false;
    if (parseNumber(normalized) != null || normalized.toLowerCase() === "nan") return false;
    if (isKnownTyphoonSpecialSource(domain, normalized)) return false;
    if (kind === "condition" && isKnownTyphoonCondition(domain, normalized)) return false;
    if (domain === "WindSpeed" && terminalRangeDirection(normalized) != null) return false;
    return true;
  });
}

function hasUnsupportedTyphoonStructuredBounds(
  domain: SpecialValueDomain,
  parts: NodeParts,
): boolean {
  return (domain === "Pressure" || domain === "MovementSpeed")
    && (parts.lowerRaw != null || parts.upperRaw != null);
}

function isMagnitudeUnknownTerm(value: string | null): boolean {
  return matchesAnySpecialTerm(value, [...UNKNOWN_TERMS, "M不明"]);
}

function isDepthShallowTerm(value: string | null): boolean {
  const normalized = normalizeSpecialTerm(value);
  return normalized === "ごく浅い"
    || (normalized != null && /深さ\s*ごく浅い$/.test(normalized));
}

function terminalRangeDirection(
  value: string | null,
): "lower" | "upper" | null {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null) return null;
  if (RANGE_LOWER_TERMS.some((term) => normalized.endsWith(term))) return "lower";
  if (RANGE_UPPER_TERMS.some((term) => normalized.endsWith(term))) return "upper";
  return null;
}

function magnitudeRangeDirectionForSource(
  source: string | null,
): "lower" | "upper" | null {
  return terminalRangeDirection(source);
}

function isKnownMagnitudeCondition(value: string | null): boolean {
  return isMagnitudeUnknownTerm(value)
    || isGiantMagnitudeText(value)
    || magnitudeRangeDirectionForSource(value) != null;
}

interface DepthBound {
  value: number;
  direction: "lower" | "upper";
}

function depthBoundFromSource(source: string | null): DepthBound | null {
  if (source == null) return null;
  const normalized = normalizeNumberSource(source).normalize("NFKC");
  const match = normalized.match(
    /(?:^|深さ\s*)([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:km|キロメートル)?\s*(以上|超|以下|未満)\s*$/,
  );
  if (match == null) return null;
  const value = parseNumber(match[1]);
  if (value == null) return null;
  return {
    value: Math.abs(value),
    direction: RANGE_LOWER_TERMS.includes(match[2] as typeof RANGE_LOWER_TERMS[number])
      ? "lower"
      : "upper",
  };
}

function depthRangeDirectionForSource(
  source: string | null,
): "lower" | "upper" | null {
  if (matchesAnySpecialTerm(source, RANGE_LOWER_TERMS)) return "lower";
  if (matchesAnySpecialTerm(source, RANGE_UPPER_TERMS)) return "upper";
  return depthBoundFromSource(source)?.direction ?? null;
}

function plumeSpecialPresenceForSource(
  value: string | null,
): SpecialPresence | null {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null) return null;
  // 完全一致を基本とし、複合 condition は安全な終端一致だけを許す。
  const terminalMatch = (term: string): boolean => {
    if (normalized === term) return true;
    if (!normalized.endsWith(term)) return false;
    const prefix = normalized.slice(0, -term.length);
    return !/[非未不無]$/.test(prefix);
  };
  if (terminalMatch("観測できず") || terminalMatch("不明") || terminalMatch("不詳")) {
    return "unknown";
  }
  return terminalMatch("雲中") ? "qualitative" : null;
}

function plumeRangeDirectionForSource(
  value: string | null,
): "lower" | "upper" | null {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null) return null;
  if (RANGE_LOWER_TERMS.includes(normalized as typeof RANGE_LOWER_TERMS[number])) {
    return "lower";
  }
  if (RANGE_UPPER_TERMS.includes(normalized as typeof RANGE_UPPER_TERMS[number])) {
    return "upper";
  }
  return plumeBoundFromSource(normalized)?.direction ?? null;
}

interface PlumeBound {
  value: number;
  direction: "lower" | "upper";
}

function plumeBoundFromSource(source: string | null): PlumeBound | null {
  if (source == null) return null;
  const normalized = normalizeNumberSource(source.normalize("NFKC"));
  const match = normalized.match(
    /^(?:火口上|海抜)?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:m|FT)?\s*(以上|超|以下|未満)\s*$/i,
  );
  if (match == null) return null;
  const value = parseNumber(match[1]);
  if (value == null) return null;
  return {
    value,
    direction: RANGE_LOWER_TERMS.includes(match[2] as typeof RANGE_LOWER_TERMS[number])
      ? "lower"
      : "upper",
  };
}

function isKnownPlumeHeightCondition(value: string | null): boolean {
  const normalized = normalizeSpecialTerm(value);
  return normalized == null || normalized === ""
    || plumeSpecialPresenceForSource(normalized) != null
    || plumeRangeDirectionForSource(normalized) != null;
}

function isMappedPlumeHeightText(
  value: string | null,
  allowHeightLabel: boolean,
): boolean {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null || normalized === "") return true;
  if (parseNumber(normalized) != null || normalized.toLowerCase() === "nan") return true;
  if (plumeSpecialPresenceForSource(normalized) != null) return true;
  if (plumeRangeDirectionForSource(normalized) != null) {
    return /[+-]?(?:\d+(?:\.\d+)?|\.\d+)/.test(normalized);
  }
  return allowHeightLabel
    && /^(?:火口上|海抜)?[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:m|FT)$/i.test(normalized);
}

function isMappedMagnitudeSource(value: string | null): boolean {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null || normalized === "") return true;
  return parseNumber(normalized) != null
    || normalized.toLowerCase() === "nan"
    || isKnownMagnitudeCondition(normalized)
    || /^M[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized);
}

function isMappedDepthSource(value: string | null): boolean {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null || normalized === "") return true;
  return parseNumber(normalized) != null
    || normalized.toLowerCase() === "nan"
    || matchesAnySpecialTerm(normalized, UNKNOWN_TERMS)
    || isDepthShallowTerm(normalized)
    || depthRangeDirectionForSource(normalized) != null
    || /深さ\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:km|キロメートル)\s*$/.test(normalized);
}

function hasUnmappedQualitativeSource(
  domain: "Magnitude" | "Depth",
  parts: NodeParts,
): boolean {
  if (parseNodeDomainValue(domain, parts.raw, parts.unit) != null) return false;
  const isMapped = domain === "Magnitude"
    ? isMappedMagnitudeSource
    : isMappedDepthSource;
  return [parts.raw, parts.description].some((source) => {
    const normalized = normalizeSpecialTerm(source);
    return normalized != null && normalized !== "" && !isMapped(source);
  });
}

function isMappedTsunamiHeightText(
  value: string | null,
  allowHeightLabel: boolean,
): boolean {
  const normalized = normalizeSpecialTerm(value);
  if (normalized == null || normalized === "") return true;
  if (parseNumber(normalized) != null || normalized.toLowerCase() === "nan") return true;
  if (/巨大|高い|観測中|上昇中|下降中|不明|不詳/.test(normalized)) return true;
  if (RANGE_LOWER_TERMS.some((term) => normalized.includes(term))) return true;
  if (RANGE_UPPER_TERMS.some((term) => normalized.includes(term))) return true;
  return allowHeightLabel && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:m|メートル)$/.test(normalized);
}

type SpecialPresence = "unknown" | "qualitative";

interface ResolvedSpecialPresence {
  presence: SpecialPresence;
  conflict: boolean;
}

function specialPresenceForSource(
  domain: "Intensity" | "LgInt",
  value: string | null,
): SpecialPresence | null {
  if (domain === "Intensity") {
    // 同一 source 内では、より具体的な語を先に判定する。
    if (matchesAnySpecialTerm(value, ["5弱以上未入電"])) return "qualitative";
    if (matchesAnySpecialTerm(value, UNKNOWN_TERMS)) return "unknown";
    return null;
  }
  return matchesAnySpecialTerm(value, ["未入電", "不明", "不詳"])
    ? "unknown"
    : null;
}

function resolvePrioritySpecialPresence(
  domain: "Intensity" | "LgInt",
  parts: NodeParts,
): ResolvedSpecialPresence | null {
  // 既知語の source 優先は Condition > Description > 本文。
  const candidates = [parts.condition, parts.description, parts.raw]
    .map((value) => specialPresenceForSource(domain, value));
  const presence = candidates.find((candidate) => candidate != null);
  if (presence == null) return null;
  return {
    presence,
    conflict: candidates.some(
      (candidate) => candidate != null && candidate !== presence,
    ),
  };
}

function specialPresence(
  domain: SpecialValueDomain,
  parts: NodeParts,
): "unknown" | "qualitative" | null {
  switch (domain) {
    case "Magnitude": {
      // 巨大地震の description は「不明」condition より具体的な意味を持つ。
      if ([parts.description, parts.condition, parts.raw].some(isGiantMagnitudeText)) {
        return "qualitative";
      }
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || [parts.raw, parts.condition, parts.description].some(isMagnitudeUnknownTerm)
      ) return "unknown";
      if (hasUnmappedQualitativeSource(domain, parts)) return "qualitative";
      return null;
    }
    case "Depth":
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || [parts.raw, parts.condition, parts.description]
          .some((value) => matchesAnySpecialTerm(value, UNKNOWN_TERMS))
      ) return "unknown";
      if ([parts.raw, parts.condition, parts.description].some(isDepthShallowTerm)) {
        return "qualitative";
      }
      return hasUnmappedQualitativeSource(domain, parts) ? "qualitative" : null;
    case "Intensity":
      return resolvePrioritySpecialPresence(domain, parts)?.presence ?? null;
    case "TsunamiHeight":
      // 高さの定性 description は NaN/不明 condition より表示上の意味が具体的。
      if (
        /巨大|高い/.test(parts.description ?? "")
        || includesInBodyOrCondition(parts, /巨大|高い/)
      ) return "qualitative";
      if (
        !isMappedTsunamiHeightText(parts.description, true)
        && parseNumber(parts.raw) == null
      ) return "qualitative";
      if (includesInBodyOrCondition(parts, /観測中/)) return "qualitative";
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || includesAny(parts.raw, UNKNOWN_TERMS)
        || includesAny(parts.condition, UNKNOWN_TERMS)
      ) return "unknown";
      return null;
    case "LgInt":
      return resolvePrioritySpecialPresence(domain, parts)?.presence ?? null;
    case "Pressure":
      if (
        isNormalizedNan(parts.raw)
        || typhoonClassificationSources(domain, parts).some(({ value }) =>
          matchesTerminalSpecialTerm(value, ["解析不能", "不明", "不詳"])
        )
      ) return "unknown";
      return hasUnmappedTyphoonQualitativeSource(domain, parts) ? "qualitative" : null;
    case "WindSpeed":
      if (typhoonClassificationSources(domain, parts).some(({ value }) =>
        matchesAnySpecialTerm(value, ["なし"])
      )) return "qualitative";
      if (
        isNormalizedNan(parts.raw)
        || typhoonClassificationSources(domain, parts).some(({ value }) =>
          matchesTerminalSpecialTerm(value, ["不明", "不詳"])
        )
      ) return "unknown";
      return hasUnmappedTyphoonQualitativeSource(domain, parts) ? "qualitative" : null;
    case "MovementSpeed":
      if (typhoonClassificationSources(domain, parts).some(({ value }) =>
        matchesTerminalSpecialTerm(value, ["ゆっくり", "ほとんど停滞"])
      )) return "qualitative";
      if (
        isNormalizedNan(parts.raw)
        || typhoonClassificationSources(domain, parts).some(({ value }) =>
          matchesTerminalSpecialTerm(value, ["不明", "不詳"])
        )
      ) return "unknown";
      return hasUnmappedTyphoonQualitativeSource(domain, parts) ? "qualitative" : null;
    case "PlumeHeight":
      // 観測阻害 condition/body を最優先し、description は分類に使わない。
      // condition は本文 NaN より優先する（雲中 + NaN は qualitative）。
      const conditionSpecial = plumeSpecialPresenceForSource(parts.condition);
      if (conditionSpecial != null) return conditionSpecial;
      if (parts.raw.trim().toLowerCase() === "nan") return "unknown";
      return plumeSpecialPresenceForSource(parts.raw);
    default:
      return null;
  }
}

function rangeDirection(
  domain: SpecialValueDomain,
  parts: NodeParts,
): "lower" | "upper" | null {
  if (domain === "Depth") {
    const directions = [parts.condition, parts.description]
      .map(depthRangeDirectionForSource);
    if (directions.includes("lower")) return "lower";
    if (directions.includes("upper")) return "upper";
    return null;
  }
  if (domain === "Magnitude") {
    const directions = [parts.condition, parts.description]
      .map(magnitudeRangeDirectionForSource);
    if (directions.includes("lower")) return "lower";
    if (directions.includes("upper")) return "upper";
    return null;
  }
  if (domain === "Pressure" || domain === "MovementSpeed") return null;
  if (domain === "WindSpeed") {
    const directions = [parts.condition, parts.description]
      .map(terminalRangeDirection);
    if (directions.includes("lower")) return "lower";
    if (directions.includes("upper")) return "upper";
    return null;
  }
  if (domain === "PlumeHeight") {
    const directions = [parts.condition, parts.description]
      .map(plumeRangeDirectionForSource);
    if (directions.includes("lower")) return "lower";
    if (directions.includes("upper")) return "upper";
    return null;
  }
  const exactCondition = domain === "Intensity"
    || domain === "LgInt";
  const conditionHas = (terms: readonly string[]): boolean => exactCondition
    ? matchesAnySpecialTerm(parts.condition, terms)
    : includesAny(parts.condition, terms);
  const descriptionHas = (terms: readonly string[]): boolean =>
    includesAny(parts.description, terms);
  if (
    conditionHas(RANGE_LOWER_TERMS)
    || descriptionHas(RANGE_LOWER_TERMS)
  ) return "lower";
  if (
    conditionHas(RANGE_UPPER_TERMS)
    || descriptionHas(RANGE_UPPER_TERMS)
  ) return "upper";
  return null;
}

function depthBound(parts: NodeParts): DepthBound | null {
  for (const source of [parts.condition, parts.description]) {
    const bound = depthBoundFromSource(source);
    if (bound != null) return bound;
  }
  return null;
}

function specialValueDiagnostics(
  domain: SpecialValueDomain,
  parts: NodeParts,
  hasCanonicalValue: boolean,
  hasSpecialSourceConflict: boolean,
  hasUnmappedQualitativeSource: boolean,
): SpecialValueDiagnostic[] | undefined {
  if (
    domain !== "Intensity"
    && domain !== "LgInt"
    && domain !== "TsunamiHeight"
    && domain !== "Magnitude"
    && domain !== "Depth"
    && domain !== "Pressure"
    && domain !== "WindSpeed"
    && domain !== "MovementSpeed"
    && domain !== "PlumeHeight"
  ) {
    return undefined;
  }
  const diagnostics: SpecialValueDiagnostic[] = [];
  const normalizedCondition = normalizeSpecialTerm(parts.condition);
  if (normalizedCondition != null && normalizedCondition !== "") {
    const knownTerms = domain === "Intensity"
      ? INTENSITY_CONDITION_TERMS
      : domain === "LgInt"
        ? LG_INT_CONDITION_TERMS
        : domain === "TsunamiHeight"
          ? TSUNAMI_HEIGHT_CONDITION_TERMS
          : domain === "PlumeHeight"
            ? PLUME_HEIGHT_CONDITION_TERMS
          : UNKNOWN_TERMS;
    const isKnown = isTyphoonNumericDomain(domain)
      ? isKnownTyphoonCondition(domain, normalizedCondition)
      : domain === "Magnitude"
      ? isKnownMagnitudeCondition(normalizedCondition)
      : domain === "Depth"
        ? matchesAnySpecialTerm(normalizedCondition, UNKNOWN_TERMS)
          || isDepthShallowTerm(normalizedCondition)
          || depthRangeDirectionForSource(normalizedCondition) != null
        : domain === "PlumeHeight"
          ? isKnownPlumeHeightCondition(normalizedCondition)
        : knownTerms.some((term) => term === normalizedCondition);
    if (!isKnown) {
      diagnostics.push("unmappedSpecialValue");
      if (hasCanonicalValue) diagnostics.push("specialValueConflict");
    }
  }
  if (hasUnmappedQualitativeSource && !diagnostics.includes("unmappedSpecialValue")) {
    diagnostics.push("unmappedSpecialValue");
  }
  if (domain === "TsunamiHeight") {
    const hasUnmappedText = !isMappedTsunamiHeightText(parts.raw, false)
      || !isMappedTsunamiHeightText(parts.description, true);
    if (hasUnmappedText && !diagnostics.includes("unmappedSpecialValue")) {
      diagnostics.push("unmappedSpecialValue");
      if (hasCanonicalValue) diagnostics.push("specialValueConflict");
    }
  }
  if (domain === "PlumeHeight") {
    const hasUnmappedText = !isMappedPlumeHeightText(parts.raw, false)
      || !isMappedPlumeHeightText(parts.description, true);
    if (hasUnmappedText && !diagnostics.includes("unmappedSpecialValue")) {
      diagnostics.push("unmappedSpecialValue");
      if (hasCanonicalValue) diagnostics.push("specialValueConflict");
    }
  }
  if (hasSpecialSourceConflict && !diagnostics.includes("specialValueConflict")) {
    diagnostics.push("specialValueConflict");
  }
  return diagnostics.length === 0 ? undefined : diagnostics;
}

function baseResult(parts: NodeParts): Pick<
  ExtractedSpecialValue,
  "raw" | "condition" | "description"
> {
  return {
    raw: parts.raw,
    condition: parts.condition,
    description: parts.description,
  };
}

/**
 * fast-xml-parser の要素 node を属性込みで読む shadow extractor。
 *
 * `undefined` だけを要素欠落とし、self-closing、空文字、空白のみはすべて
 * 「存在する要素」として raw を変更せず保持する。
 */
export function extractSpecialValue(
  domain: "Intensity",
  node: unknown,
): SpecialValue<JmaIntensity>;
export function extractSpecialValue(
  domain: "LgInt",
  node: unknown,
): SpecialValue<JmaLgIntensity>;
export function extractSpecialValue(
  domain: NumericSpecialValueDomain,
  node: unknown,
): SpecialValue<number>;
export function extractSpecialValue(
  domain: SpecialValueDomain,
  node: unknown,
): ExtractedSpecialValue;
export function extractSpecialValue(
  domain: SpecialValueDomain,
  node: unknown,
): ExtractedSpecialValue {
  if (node === undefined) {
    return {
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing",
    };
  }

  const parts = nodeParts(node);
  const common = baseResult(parts);
  const parsedValue = parseNodeDomainValue(domain, parts.raw, parts.unit);
  const lowerBound = parts.lowerRaw == null
    ? null
    : parseNodeDomainValue(domain, parts.lowerRaw, parts.unit);
  const upperBound = parts.upperRaw == null
    ? null
    : parseNodeDomainValue(domain, parts.upperRaw, parts.unit);
  const hasBoundElements = parts.lowerRaw != null || parts.upperRaw != null;
  const prioritySpecial = domain === "Intensity" || domain === "LgInt"
    ? resolvePrioritySpecialPresence(domain, parts)
    : null;
  const special = prioritySpecial?.presence ?? specialPresence(domain, parts);
  const hasUnsupportedStructuredBounds = hasUnsupportedTyphoonStructuredBounds(
    domain,
    parts,
  );
  const hasUnmappedQualitative = (
    domain === "Magnitude" || domain === "Depth"
  )
    ? special === "qualitative" && hasUnmappedQualitativeSource(domain, parts)
    : isTyphoonNumericDomain(domain)
      ? hasUnmappedTyphoonQualitativeSource(domain, parts)
        || hasUnsupportedStructuredBounds
      : false;
  const parsedDepthBound = domain === "Depth" ? depthBound(parts) : null;
  const isShallowDepth = domain === "Depth" && (
    parsedValue === 0
    || [parts.raw, parts.condition, parts.description].some(isDepthShallowTerm)
  );
  const parsedPlumeBound = domain === "PlumeHeight"
    ? plumeBoundFromSource(parts.raw)
    : null;
  const depthSpecialConflict = domain === "Depth" && parsedValue != null && (
    (parsedDepthBound != null && parsedDepthBound.value !== parsedValue)
    || (parsedDepthBound == null && special === "qualitative" && parsedValue !== 0)
    || special === "unknown"
  );
  const magnitudeSpecialConflict = domain === "Magnitude"
    && parsedValue != null
    && special != null;
  const unsupportedStructuredBoundsConflict = hasUnsupportedStructuredBounds
    && (
      parsedValue != null
      || (special != null && (lowerBound != null || upperBound != null))
    );
  const plumeHeightSpecialConflict = domain === "PlumeHeight"
    && (
      parsedValue != null
      || lowerBound != null
      || upperBound != null
      || parsedPlumeBound != null
    )
    && special != null;
  const diagnostics = specialValueDiagnostics(
    domain,
    parts,
    parsedValue != null
      || lowerBound != null
      || upperBound != null
      || parsedPlumeBound != null,
    (prioritySpecial?.conflict ?? false)
      || depthSpecialConflict
      || magnitudeSpecialConflict
      || plumeHeightSpecialConflict
      || unsupportedStructuredBoundsConflict,
    hasUnmappedQualitative,
  );
  const diagnosticFields = diagnostics == null ? {} : { diagnostics };
  const rawBoundFields = hasBoundElements
    ? {
        rawLowerBound: parts.lowerRaw,
        rawUpperBound: parts.upperRaw,
      }
    : {};

  // Intensity/LgInt の既知特殊語は canonical bounds より優先する。
  if (prioritySpecial?.presence === "qualitative") {
    return {
      ...common,
      value: null,
      presence: "qualitative",
      ...(domain === "Intensity" ? { lowerBound: "5-" } : {}),
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }
  if (prioritySpecial?.presence === "unknown") {
    return {
      ...common,
      value: null,
      presence: "unknown",
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }

  // 台風の既知特殊語は構造化 bounds より優先する。
  if (isTyphoonNumericDomain(domain) && special === "qualitative") {
    return {
      ...common,
      value: null,
      presence: "qualitative",
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }
  if (isTyphoonNumericDomain(domain) && special === "unknown") {
    return {
      ...common,
      value: null,
      presence: "unknown",
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }

  // PlumeHeight の観測阻害は本文数値だけでなく明示 From/To よりも優先する。
  if (domain === "PlumeHeight" && special === "qualitative") {
    return {
      ...common,
      value: null,
      presence: "qualitative",
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }
  if (domain === "PlumeHeight" && special === "unknown") {
    return {
      ...common,
      value: null,
      presence: "unknown",
      ...rawBoundFields,
      ...diagnosticFields,
    };
  }

  if (
    !hasUnsupportedStructuredBounds
    && lowerBound != null
    && upperBound != null
    && lowerBound === upperBound
  ) {
    return {
      ...common,
      value: lowerBound,
      presence: "value",
      rawLowerBound: parts.lowerRaw,
      rawUpperBound: parts.upperRaw,
      ...diagnosticFields,
    };
  }

  if (!hasUnsupportedStructuredBounds && (lowerBound != null || upperBound != null)) {
    return {
      ...common,
      value: null,
      presence: "range",
      lowerBound,
      upperBound,
      rawLowerBound: parts.lowerRaw,
      rawUpperBound: parts.upperRaw,
      ...diagnosticFields,
    };
  }

  if (hasBoundElements) {
    if (hasUnsupportedStructuredBounds && parsedValue != null) {
      return {
        ...common,
        value: parsedValue,
        presence: "value",
        ...rawBoundFields,
        ...diagnosticFields,
      };
    }
    return {
      ...common,
      value: null,
      presence: "qualitative",
      rawLowerBound: parts.lowerRaw,
      rawUpperBound: parts.upperRaw,
      ...diagnosticFields,
    };
  }

  if (domain === "Depth" && parsedValue != null) {
    if (parsedDepthBound != null && parsedDepthBound.value === parsedValue) {
      return {
        ...common,
        value: null,
        presence: "range",
        lowerBound: parsedDepthBound.direction === "lower" ? parsedValue : null,
        upperBound: parsedDepthBound.direction === "upper" ? parsedValue : null,
        ...diagnosticFields,
      };
    }
    if (parsedValue === 0) {
      return {
        ...common,
        value: null,
        presence: "qualitative",
        upperBound: SHALLOW_DEPTH_UPPER_BOUND_KM,
        ...diagnosticFields,
      };
    }
    if (depthSpecialConflict) {
      return { ...common, value: parsedValue, presence: "value", ...diagnosticFields };
    }
  }
  if (domain === "PlumeHeight" && parsedPlumeBound != null) {
    return {
      ...common,
      value: null,
      presence: "range",
      lowerBound: parsedPlumeBound.direction === "lower" ? parsedPlumeBound.value : null,
      upperBound: parsedPlumeBound.direction === "upper" ? parsedPlumeBound.value : null,
      ...diagnosticFields,
    };
  }

  const numericTsunamiObservation = domain === "TsunamiHeight"
    && parsedValue != null
    && includesAny(parts.condition, ["観測中"]);
  if (numericTsunamiObservation) {
    return { ...common, value: parsedValue, presence: "value", ...diagnosticFields };
  }

  if (special === "qualitative") {
    return {
      ...common,
      value: null,
      presence: "qualitative",
      ...(domain === "Intensity" ? { lowerBound: "5-" } : {}),
      ...(isShallowDepth ? { upperBound: SHALLOW_DEPTH_UPPER_BOUND_KM } : {}),
      ...diagnosticFields,
    };
  }

  if (special === "unknown") {
    return { ...common, value: null, presence: "unknown", ...diagnosticFields };
  }

  const direction = rangeDirection(domain, parts);
  if (direction != null && parsedValue != null) {
    return {
      ...common,
      value: null,
      presence: "range",
      lowerBound: direction === "lower" ? parsedValue : null,
      upperBound: direction === "upper" ? parsedValue : null,
      ...diagnosticFields,
    };
  }

  if (domain === "Intensity" && parsedValue != null && parts.condition != null) {
    // 未知 Condition から値の無効化を推定せず、valid 本文を保持する。
    return { ...common, value: parsedValue, presence: "value", ...diagnosticFields };
  }

  if (parts.raw.trim() === "") {
    return { ...common, value: null, presence: "empty", ...diagnosticFields };
  }

  if (parsedValue != null) {
    return { ...common, value: parsedValue, presence: "value", ...diagnosticFields };
  }

  // 未知の定性語は値や unknown へ推定せず、そのまま保持する。
  return { ...common, value: null, presence: "qualitative", ...diagnosticFields };
}
