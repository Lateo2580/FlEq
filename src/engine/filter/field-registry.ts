import type { PresentationEvent } from "../presentation/types";
import type { FilterField, FilterKind } from "./types";

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
  depth: field("number", [], (e) => parseDepth(e.depth), true),
  magnitude: field("number", ["mag"], (e) => parseMagnitude(e.magnitude), true),

  // 強度
  maxInt: field("enum:intensity", [], (e) => e.maxInt, true),
  maxLgInt: field("enum:lgInt", [], (e) => e.maxLgInt, true),
  forecastMaxInt: field("enum:intensity", [], (e) => e.forecastMaxInt, true),
  alertLevel: field("number", [], (e) => e.alertLevel, true),

  // テキスト
  title: field("string", [], (e) => e.title),
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
