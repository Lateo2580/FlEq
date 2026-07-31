import type { SpecialValue } from "../types";

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
  const normalized = raw.trim();
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

function includesAny(value: string | null, terms: readonly string[]): boolean {
  return value != null && terms.some((term) => value.includes(term));
}

function includesInBodyOrCondition(parts: NodeParts, pattern: RegExp): boolean {
  return pattern.test(parts.raw) || pattern.test(parts.condition ?? "");
}

function specialPresence(
  domain: SpecialValueDomain,
  parts: NodeParts,
): "unknown" | "qualitative" | null {
  switch (domain) {
    case "Magnitude": {
      // 巨大地震の description は「不明」condition より具体的な意味を持つ。
      if (
        /巨大地震|Ｍ?8を超える巨大地震/.test(parts.description ?? "")
        || includesInBodyOrCondition(parts, /巨大地震|Ｍ?8を超える巨大地震/)
      ) return "qualitative";
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || includesAny(parts.raw, UNKNOWN_TERMS)
        || includesAny(parts.condition, UNKNOWN_TERMS)
      ) return "unknown";
      return null;
    }
    case "Depth":
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || includesAny(parts.raw, UNKNOWN_TERMS)
        || includesAny(parts.condition, UNKNOWN_TERMS)
      ) return "unknown";
      return includesInBodyOrCondition(parts, /ごく浅い/) ? "qualitative" : null;
    case "Intensity":
      if (includesInBodyOrCondition(parts, /5弱以上未入電/)) return "qualitative";
      if (
        includesInBodyOrCondition(parts, /未入電/)
        || includesAny(parts.raw, UNKNOWN_TERMS)
        || includesAny(parts.condition, UNKNOWN_TERMS)
      ) return "unknown";
      return null;
    case "TsunamiHeight":
      // 高さの定性 description は NaN/不明 condition より表示上の意味が具体的。
      if (
        /巨大|高い/.test(parts.description ?? "")
        || includesInBodyOrCondition(parts, /巨大|高い/)
      ) return "qualitative";
      if (includesInBodyOrCondition(parts, /観測中/)) return "qualitative";
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || includesAny(parts.raw, UNKNOWN_TERMS)
        || includesAny(parts.condition, UNKNOWN_TERMS)
      ) return "unknown";
      return null;
    case "LgInt":
      return includesInBodyOrCondition(parts, /未入電|不明|不詳/)
        ? "unknown"
        : null;
    case "Pressure":
      return (
        parts.raw.trim().toLowerCase() === "nan"
        || includesInBodyOrCondition(parts, /解析不能|不明|不詳/)
      ) ? "unknown" : null;
    case "WindSpeed":
      if (parts.condition === "なし") return "qualitative";
      return (
        parts.raw.trim().toLowerCase() === "nan"
        || includesInBodyOrCondition(parts, /不明|不詳/)
      ) ? "unknown" : null;
    case "MovementSpeed":
      if (includesInBodyOrCondition(parts, /ゆっくり|ほとんど停滞/)) {
        return "qualitative";
      }
      return (
        parts.raw.trim().toLowerCase() === "nan"
        || includesInBodyOrCondition(parts, /不明|不詳/)
      ) ? "unknown" : null;
    case "PlumeHeight":
      // 観測阻害 condition/body を最優先し、description は分類に使わない。
      if (includesInBodyOrCondition(parts, /観測できず/)) return "unknown";
      if (
        parts.raw.trim().toLowerCase() === "nan"
        || includesInBodyOrCondition(parts, /不明|不詳/)
      ) return "unknown";
      return includesInBodyOrCondition(parts, /雲中/) ? "qualitative" : null;
    default:
      return null;
  }
}

function rangeDirection(parts: NodeParts): "lower" | "upper" | null {
  const candidates = [parts.condition, parts.description];
  if (candidates.some((value) => includesAny(value, RANGE_LOWER_TERMS))) return "lower";
  if (candidates.some((value) => includesAny(value, RANGE_UPPER_TERMS))) return "upper";
  return null;
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
  const lowerBound = parts.lowerRaw == null
    ? null
    : parseDomainValue(domain, parts.lowerRaw);
  const upperBound = parts.upperRaw == null
    ? null
    : parseDomainValue(domain, parts.upperRaw);

  if (lowerBound != null || upperBound != null) {
    return {
      ...common,
      value: null,
      presence: "range",
      lowerBound,
      upperBound,
    };
  }

  const parsedValue = parseDomainValue(domain, parts.raw);
  const numericTsunamiObservation = domain === "TsunamiHeight"
    && parsedValue != null
    && includesAny(parts.condition, ["観測中"]);
  if (numericTsunamiObservation) {
    return { ...common, value: parsedValue, presence: "value" };
  }

  const special = specialPresence(domain, parts);
  if (special === "qualitative") {
    const intensityLower = domain === "Intensity"
      && [parts.raw, parts.condition, parts.description]
        .some((value) => value?.includes("5弱以上未入電"));
    return {
      ...common,
      value: null,
      presence: "qualitative",
      ...(intensityLower ? { lowerBound: "5-" } : {}),
    };
  }

  if (special === "unknown") {
    return { ...common, value: null, presence: "unknown" };
  }

  const direction = rangeDirection(parts);
  if (direction != null && parsedValue != null) {
    return {
      ...common,
      value: null,
      presence: "range",
      lowerBound: direction === "lower" ? parsedValue : null,
      upperBound: direction === "upper" ? parsedValue : null,
    };
  }

  if (parts.raw.trim() === "") {
    return { ...common, value: null, presence: "empty" };
  }

  if (parsedValue != null) {
    return { ...common, value: parsedValue, presence: "value" };
  }

  // 未知の定性語は値や unknown へ推定せず、そのまま保持する。
  return { ...common, value: null, presence: "qualitative" };
}
