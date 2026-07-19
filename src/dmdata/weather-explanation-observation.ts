import { dig, str } from "./telegram-parser";
import {
  listOf,
  nodeText,
  buildTimeDefineMap,
  parseJmxEbElement,
  type TimeDefineEntry,
} from "./timeseries-common";
import type {
  WeatherExplanationObservation,
  ObservationSeries,
  StationObservation,
  StationMeasurement,
  ForecastMetricValue,
  ForecastTimeDefine,
} from "../types";

/** observation 用: Part タグ → 値タグ名の配列 (WindPart は WindDirection + WindSpeed の同居あり) */
const OBSERVATION_PART_TO_TAGS: Record<string, string[]> = {
  PrecipitationPart: ["jmx_eb:Precipitation"],
  WindPart: ["jmx_eb:WindDirection", "jmx_eb:WindSpeed"],
  WaveHeightPart: ["jmx_eb:WaveHeight"],
  SnowDepthPart: ["jmx_eb:SnowDepth"],
  SnowfallDepthPart: ["jmx_eb:SnowfallDepth"],
};

function seriesKeyOf(
  propertyType: string,
  element: string | null,
  partType: string,
  observedAt: string | null,
): string {
  return `${propertyType}|${element ?? ""}|${partType}|${observedAt ?? ""}`;
}

function resolveTimeName(refID: string, map: Map<string, TimeDefineEntry>): string | null {
  return map.get(refID)?.name ?? null;
}

/** Body から MeteorologicalInfos[type=観測実況] を抽出 */
export function extractObservation(body: unknown): WeatherExplanationObservation | null {
  if (body == null) return null;
  const infosList = listOf(dig(body, "MeteorologicalInfos")).filter(
    (n) => str(dig(n, "@_type")) === "観測実況",
  );
  if (infosList.length === 0) return null;

  const seriesByKey = new Map<string, ObservationSeries>();
  // StationObservation → stationKey の外部管理 (WeakMap)
  const stationKeyMap = new WeakMap<StationObservation, string>();

  for (const infos of infosList) {
    // パターン (i): TimeSeriesInfo[] 入れ子
    for (const tsi of listOf(dig(infos, "TimeSeriesInfo"))) {
      const map = buildTimeDefineMap(dig(tsi, "TimeDefines"));
      const tdEntries: ForecastTimeDefine[] = [...map.values()].map((e) => ({
        timeId: e.timeId,
        dateTime: e.dateTime,
        duration: e.duration,
        name: e.name,
      }));
      const observedAt = tdEntries[0]?.dateTime ?? null;
      ingestItems(
        listOf(dig(tsi, "Item")),
        seriesByKey,
        map,
        tdEntries,
        observedAt,
        stationKeyMap,
      );
    }
    // パターン (ii): MeteorologicalInfo[] 直下
    for (const info of listOf(dig(infos, "MeteorologicalInfo"))) {
      const observedAt = str(dig(info, "DateTime")) || null;
      ingestItems(
        listOf(dig(info, "Item")),
        seriesByKey,
        new Map(),
        [],
        observedAt,
        stationKeyMap,
      );
    }
  }

  const series = [...seriesByKey.values()];
  if (series.length === 0) return null;
  return { series, fallback: computeObservationFallback(series) };
}

/**
 * Item 群を seriesByKey に振り分ける。
 *
 *   - Station 無し Item (intro/element/supplement テキストのみ) は pendingContext
 *     (propertyType + observedAt キー) に蓄積。
 *   - 後続の Station 付き Part Item で同 propertyType+observedAt なら、その pending
 *     context を upsertSeries 時に intro/element/supplement に注入。
 *   - element が変わる Station 無し Item が来たら、前 pending を **置換** (蓄積マージしない)。
 *   - Part に pending を注入したら、その pending は **delete** する。
 */
function ingestItems(
  items: unknown[],
  seriesByKey: Map<string, ObservationSeries>,
  timeDefineMap: Map<string, TimeDefineEntry>,
  tdEntries: ForecastTimeDefine[],
  observedAt: string | null,
  stationKeyMap: WeakMap<StationObservation, string>,
): void {
  type PendingContext = { element: string | null; intro: string[]; supplement: string[] };
  const pendingContext = new Map<string, PendingContext>();
  const pendingKey = (propertyType: string) => `${propertyType}|${observedAt ?? ""}`;

  let itemIndex = 0;
  for (const item of items) {
    const stationNode = dig(item, "Station");
    for (const kind of listOf(dig(item, "Kind"))) {
      for (const prop of listOf(dig(kind, "Property"))) {
        const propertyType = str(dig(prop, "Type"));
        const texts = classifyTexts(prop);
        const pKey = pendingKey(propertyType);
        let foundPart = false;
        for (const [partTag, valueTags] of Object.entries(OBSERVATION_PART_TO_TAGS)) {
          const part = dig(prop, partTag);
          if (part == null) continue;
          foundPart = true;
          const pending = pendingContext.get(pKey);
          const mergedElement = texts.element ?? pending?.element ?? null;
          const mergedIntro = [...(pending?.intro ?? []), ...texts.intro];
          const mergedSupplement = [...(pending?.supplement ?? []), ...texts.supplement];
          const key = seriesKeyOf(propertyType, mergedElement, partTag, observedAt);
          const series = upsertSeries(
            seriesByKey,
            key,
            propertyType,
            mergedElement,
            partTag,
            observedAt,
            tdEntries,
          );
          for (const t of mergedIntro) if (!series.intro.includes(t)) series.intro.push(t);
          for (const t of mergedSupplement) if (!series.supplement.includes(t)) series.supplement.push(t);
          if (stationNode != null) {
            const station = upsertStation(series, stationNode, itemIndex, key, stationKeyMap);
            const measurement = parsePart(part, partTag, valueTags, timeDefineMap);
            station.measurements.push(measurement);
          }
        }
        if (foundPart) {
          pendingContext.delete(pKey);
        } else {
          const existing = pendingContext.get(pKey);
          if (
            existing != null &&
            texts.element != null &&
            existing.element != null &&
            existing.element !== texts.element
          ) {
            // element が変わったら pending を置換
            pendingContext.set(pKey, {
              element: texts.element,
              intro: [...texts.intro],
              supplement: [...texts.supplement],
            });
          } else {
            // element 同じ or 片方 null なら蓄積マージ
            pendingContext.set(pKey, {
              element: texts.element ?? existing?.element ?? null,
              intro: [...(existing?.intro ?? []), ...texts.intro],
              supplement: [...(existing?.supplement ?? []), ...texts.supplement],
            });
          }
        }
      }
    }
    itemIndex++;
  }
}

function upsertSeries(
  map: Map<string, ObservationSeries>,
  key: string,
  propertyType: string,
  element: string | null,
  partType: string,
  observedAt: string | null,
  timeDefines: ForecastTimeDefine[],
): ObservationSeries {
  let s = map.get(key);
  if (s == null) {
    s = {
      propertyType,
      element,
      partType,
      observedAt,
      intro: [],
      supplement: [],
      stations: [],
      timeDefines,
    };
    map.set(key, s);
  }
  return s;
}

/**
 * Station ノードから StationObservation を upsert (3 段優先 key で重複統合)。
 *
 * - code あり: `code:<code>` で同一 series 内の station と統合
 * - code 空 + name あり: `name:<name>|loc:<location>` で統合
 * - code/name 両空: `anon:<seriesKey>:<itemIndex>` で別エントリ (統合しない)
 *
 * WeakMap で外部管理することで StationObservation 自体は公開フィールドのみを持つ。
 */
function upsertStation(
  series: ObservationSeries,
  stationNode: unknown,
  itemIndex: number,
  seriesKey: string,
  stationKeyMap: WeakMap<StationObservation, string>,
): StationObservation {
  const stationName = str(dig(stationNode, "Name"));
  const stationCode = nodeText(dig(stationNode, "Code"));
  const stationLocation = str(dig(stationNode, "Location"));
  let stationKey: string;
  if (stationCode) {
    stationKey = `code:${stationCode}`;
  } else if (stationName) {
    stationKey = `name:${stationName}|loc:${stationLocation}`;
  } else {
    stationKey = `anon:${seriesKey}:${itemIndex}`;
  }
  let st = series.stations.find((x) => stationKeyMap.get(x) === stationKey);
  if (st == null) {
    st = { stationName, stationCode, stationLocation, measurements: [] };
    stationKeyMap.set(st, stationKey);
    series.stations.push(st);
  }
  return st;
}

/** Part 1 個を StationMeasurement に */
function parsePart(
  part: unknown,
  partType: string,
  valueTags: string[],
  map: Map<string, TimeDefineEntry>,
): StationMeasurement {
  const sentence = str(dig(part, "Sentence"));
  const time = str(dig(part, "Time")) || null;
  const remark = str(dig(part, "Remark")) || null;
  const values: ForecastMetricValue[] = [];
  for (const valueTag of valueTags) {
    for (const raw of listOf(dig(part, valueTag))) {
      const el = parseJmxEbElement(raw);
      values.push({
        timeRef: el.refID,
        timeName: resolveTimeName(el.refID, map),
        subType: el.type,
        unit: el.unit,
        value: el.value,
        condition: el.condition,
        description: el.description,
        raw: el.raw,
      });
    }
    // Base.Local 配下にも jmx_eb が来うる (将来防衛)
    const base = dig(part, "Base");
    if (base != null) {
      for (const local of listOf(dig(base, "Local"))) {
        for (const raw of listOf(dig(local, valueTag))) {
          const el = parseJmxEbElement(raw);
          values.push({
            timeRef: el.refID,
            timeName: resolveTimeName(el.refID, map),
            subType: el.type,
            unit: el.unit,
            value: el.value,
            condition: el.condition,
            description: el.description,
            raw: el.raw,
          });
        }
      }
    }
  }
  return { partType, sentence, time, remark, values };
}

/** Text を @type で intro/supplement/element に振り分け */
function classifyTexts(prop: unknown): {
  intro: string[];
  supplement: string[];
  element: string | null;
} {
  const intro: string[] = [];
  const supplement: string[] = [];
  let element: string | null = null;
  for (const t of listOf(dig(prop, "Text"))) {
    const type = str(dig(t, "@_type"));
    const text = str(dig(t, "#text"));
    if (!text) continue;
    if (type === "解説" || type === "時系列解説") intro.push(text);
    else if (type === "補足" || type === "時系列補足") supplement.push(text);
    else if (type === "気象要素") element = text;
  }
  return { intro, supplement, element };
}

/** 行数換算 (forecast と同じ閾値) */
function computeObservationFallback(series: ObservationSeries[]): "none" | "compactOnly" | "raw" {
  let rows = 0;
  for (const s of series) {
    rows += s.intro.length;
    for (const st of s.stations) {
      rows += 1;
      for (const m of st.measurements) rows += m.values.length;
    }
  }
  if (rows > 200) return "raw";
  if (rows > 80) return "compactOnly";
  return "none";
}
