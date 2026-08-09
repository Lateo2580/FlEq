import type { PresentationEvent } from "../presentation/types";
import type { SpecialValue } from "../../types";
import type { CompOp, FilterField, FilterKind } from "./types";

function field<T>(kind: FilterKind, aliases: string[], get: (e: PresentationEvent) => T | null | undefined, supportsOrder?: boolean): FilterField<T> {
  return { kind, aliases, get, supportsOrder };
}

/** depth 文字列 "10km" → 数値 10 */
function parseDepth(d: string | null | undefined): number | null {
  if (d == null) return null;
  const m = d.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/** magnitude 文字列 → 数値 */
function parseMagnitude(m: string | null | undefined): number | null {
  if (m == null) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

function compareCanonicalNumber(
  value: SpecialValue<number>,
  op: CompOp,
  right: number,
): boolean {
  if (value.presence === "value" && value.value != null) {
    switch (op) {
      case "=": return value.value === right;
      case "!=": return value.value !== right;
      case "<": return value.value < right;
      case "<=": return value.value <= right;
      case ">": return value.value > right;
      case ">=": return value.value >= right;
      default: return false;
    }
  }
  if (value.presence !== "range") return false;
  const lower = value.lowerBound ?? null;
  const upper = value.upperBound ?? null;
  switch (op) {
    case "=": return lower != null && upper != null && lower === right && upper === right;
    case "!=": return (upper != null && upper < right) || (lower != null && lower > right);
    case "<": return upper != null && upper < right;
    case "<=": return upper != null && upper <= right;
    case ">": return lower != null && lower > right;
    case ">=": return lower != null && lower >= right;
    default: return false;
  }
}

function semanticNumberField(
  scalar: (event: PresentationEvent) => number | null,
  semantic: (event: PresentationEvent) => SpecialValue<number> | undefined,
): FilterField<number> {
  return {
    kind: "number",
    aliases: [],
    get: (event) => semantic(event)?.presence === "value"
      ? semantic(event)?.value
      : semantic(event) == null
        ? scalar(event)
        : null,
    supportsOrder: true,
    compareNumber: (event, op, right) => {
      const canonical = semantic(event);
      if (canonical != null) return compareCanonicalNumber(canonical, op, right);
      const value = scalar(event);
      if (value == null) return false;
      return compareCanonicalNumber({
        presence: "value",
        raw: String(value),
        condition: null,
        description: null,
        value,
      }, op, right);
    },
  };
}

const FILTER_INTENSITY_BY_RANK = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"] as const;

function forecastIntensityForFilter(event: PresentationEvent): string | null | undefined {
  const rank = event.forecastMaxIntRank;
  if (rank != null && Number.isInteger(rank) && rank >= 0 && rank < FILTER_INTENSITY_BY_RANK.length) {
    return FILTER_INTENSITY_BY_RANK[rank];
  }
  return event.forecastMaxInt;
}

export const FILTER_FIELDS: Record<string, FilterField> = {
  // 識別
  domain: field("string", [], (e) => e.domain),
  type: field("string", ["headType"], (e) => e.type),
  subType: field("string", [], (e) => e.subType),
  classification: field("string", [], (e) => e.classification),
  id: field("string", [], (e) => e.id),
  infoType: field("string", [], (e) => e.infoType),

  // レベル
  frameLevel: field("enum:frameLevel", ["level"], (e) => e.frameLevel, true),

  // 状態フラグ
  isCancellation: field("boolean", ["isCancelled"], (e) => e.isCancellation),
  isWarning: field("boolean", [], (e) => e.isWarning),
  isFinal: field("boolean", [], (e) => e.isFinal),
  isTest: field("boolean", [], (e) => e.isTest),
  isRenotification: field("boolean", [], (e) => e.isRenotification),

  // イベント追跡
  eventId: field("string", [], (e) => e.eventId),
  serial: field("string", [], (e) => e.serial),
  volcanoCode: field("string", [], (e) => e.volcanoCode),
  volcanoName: field("string", [], (e) => e.volcanoName),

  // 震源情報
  hypocenterName: field("string", ["hypocenter"], (e) => e.hypocenterName),
  depth: semanticNumberField((e) => parseDepth(e.depth), (e) => e.depthValue),
  magnitude: {
    ...semanticNumberField((e) => parseMagnitude(e.magnitude), (e) => e.magnitudeValue),
    aliases: ["mag"],
  },

  // 強度
  maxInt: field("enum:intensity", [], (e) => e.maxInt, true),
  maxLgInt: field("enum:lgInt", [], (e) => e.maxLgInt, true),
  // 表示 label が unknown／qualifier でも、保持済み safety rank があれば閾値比較に使用する。
  forecastMaxInt: field("enum:intensity", [], forecastIntensityForFilter, true),
  forecastMaxIntSafetyRank: field("number", [], (e) => e.forecastMaxIntRank, true),
  alertLevel: field("number", [], (e) => e.alertLevel, true),

  // テキスト
  title: field("string", [], (e) => e.title),
  controlTitle: field("string", [], (e) => e.controlTitle),
  headline: field("string", [], (e) => e.headline),

  // 地域集約
  areaNames: field("string[]", [], (e) => e.areaNames),
  forecastAreaNames: field("string[]", [], (e) => e.forecastAreaNames),
  municipalityNames: field("string[]", [], (e) => e.municipalityNames),
  observationNames: field("string[]", [], (e) => e.observationNames),
  areaCount: field("number", [], (e) => e.areaCount),

  // 津波
  tsunamiKinds: field("string[]", [], (e) => e.tsunamiKinds),
};

/** フィールド名 or エイリアスから FilterField を解決する */
export function resolveField(name: string): FilterField | null {
  if (name in FILTER_FIELDS) return FILTER_FIELDS[name];
  for (const [, f] of Object.entries(FILTER_FIELDS)) {
    if (f.aliases.includes(name)) return f;
  }
  return null;
}

/** 公開フィールド名一覧 (エラーメッセージ用) */
export function fieldNames(): string[] {
  return Object.keys(FILTER_FIELDS);
}
