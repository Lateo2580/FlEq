import {
  FLOOD_KIND_CODE_TO_LEVEL,
} from "../types";
import type {
  FloodHeadline,
  FloodMeasurement,
  FloodMeasurementUnit,
  FloodSeriesWindow,
  FloodStation,
} from "../types";
import { dig, str } from "./telegram-parser";
import { listOf, nodeText, toNumberOrNull } from "./timeseries-common";
import * as log from "../logger";
import {
  buildFloodTimeDefineMap,
  computeMainItemCodeAndHash,
  computeStationObservedLevel,
  parseCriteriaFromPart,
  resolveHeadlineKindForStation,
} from "./flood-shared";

/**
 * VXKO50-89 (指定河川洪水予報) の station 集約パーサ。
 *
 * 旧 `flood-forecast-parser.ts` の `buildStationSeriesMap` +
 * `parseStationsAndAggregate` 一式を切り出した。
 *
 * 入口は `parseStationsAndAggregate(body, headlines)` のみ。
 * 内部 helper (toSeriesCondition / toSeriesLevel / buildStationSeriesMap) は
 * このファイル内に閉じる。共有 helper (parseCriteriaFromPart / 観測レベル /
 * Headline kind 解決 / mainItemCode/Hash) は `flood-shared.ts` に置く。
 */

/** condition 文字列を `FloodSeriesWindow["condition"]` に narrowing。未知は "unknown"。 */
const KNOWN_SERIES_CONDITIONS: ReadonlySet<string> = new Set([
  "正常",
  "上昇",
  "下降",
  "未計算",
  "欠測",
  "一定",
  "無効",
]);

function toSeriesCondition(raw: string): FloodSeriesWindow["condition"] {
  return KNOWN_SERIES_CONDITIONS.has(raw)
    ? (raw as FloodSeriesWindow["condition"])
    : "unknown";
}

function toSeriesLevel(value: number | null): FloodSeriesWindow["level"] {
  if (value == null) return null;
  const v = Math.floor(value);
  if (v === 0 || v === 1 || v === 2 || v === 3 || v === 4 || v === 5) {
    return v;
  }
  return null;
}

/**
 * MeteorologicalInfos.type="水位・流量情報" の TimeSeriesInfo を読んで
 * 観測所ごとの `FloodSeriesWindow[]` を組み立てる。
 *
 * @returns Map<stationName | stationCode, { measurement, series, rawUnit, stationName, stationCode, location }>
 */
interface StationSeriesEntry {
  stationName: string;
  stationCode: string;
  location: string;
  measurement: FloodMeasurement;
  series: FloodSeriesWindow[];
  rawUnit: string;
}

function buildStationSeriesMap(
  body: unknown,
): Map<string, StationSeriesEntry> {
  const result = new Map<string, StationSeriesEntry>();
  // stationCode 重複は実電文では発生しない想定だが、fixture placeholder
  // (例: 16_02_01 の "12345678901234567") や仕様外の電文では起きうる。
  // 衝突しても result は stationName keyed で一意化されるため動作は壊れないが、
  // 観察可能性のため初回の重複を debug ログに残しておく。
  // (DEBUG 時のみ出力 — snapshot を汚さず、log level=DEBUG で本番調査時に拾える)
  const seenStationCodes = new Set<string>();
  const warnedStationCodes = new Set<string>();
  const meteoInfos = listOf(dig(body, "MeteorologicalInfos"));
  const waterInfo = meteoInfos.find(
    (m) => str(dig(m, "@_type")) === "水位・流量情報",
  );
  if (waterInfo == null) return result;
  // TimeSeriesInfo は ARRAY_TAGS に含まれるため配列化される。先頭を採用。
  const tsi = listOf(dig(waterInfo, "TimeSeriesInfo"))[0];
  if (tsi == null) return result;

  const timeMap = buildFloodTimeDefineMap(dig(tsi, "TimeDefines"));
  const items = listOf(dig(tsi, "Item"));

  for (const item of items) {
    if (item == null) continue;
    // Kind は ARRAY_TAGS に含まれるため配列化される
    const kindNode = listOf(dig(item, "Kind"))[0];
    // Property も同様
    const propertyNode = listOf(dig(kindNode, "Property"))[0];
    const propType = str(dig(propertyNode, "Type"));
    const measurement: FloodMeasurement =
      propType === "流量" ? "discharge" : "water_level";
    const unit: FloodMeasurementUnit =
      measurement === "discharge" ? "立方メートル毎秒" : "m";
    const partKey = measurement === "discharge" ? "DischargePart" : "WaterLevelPart";
    const elementKey =
      measurement === "discharge" ? "jmx_eb:Discharge" : "jmx_eb:WaterLevel";

    const partNode = dig(propertyNode, partKey);
    const elements = listOf(dig(partNode, elementKey));

    // refId 単位で集約 (type=水位/流量 と type=レベル の同 refId が組)
    interface RawEntry {
      value: number | null;
      level: FloodSeriesWindow["level"];
      condition: FloodSeriesWindow["condition"];
      rawUnit: string;
    }
    const byRefId = new Map<string, RawEntry>();
    let lastRawUnit: string = unit;
    for (const el of elements) {
      if (el == null) continue;
      const refId = str(dig(el, "@_refID"));
      if (refId === "") continue;
      const type = str(dig(el, "@_type"));
      const conditionAttr = str(dig(el, "@_condition"));
      const unitAttr = str(dig(el, "@_unit"));
      if (unitAttr !== "") lastRawUnit = unitAttr;
      const raw = nodeText(el);
      const value = toNumberOrNull(raw);

      const entry: RawEntry = byRefId.get(refId) ?? {
        value: null,
        level: null,
        condition: "unknown",
        rawUnit: unit,
      };
      if (type === "水位" || type === "流量") {
        entry.value = value;
        entry.condition = toSeriesCondition(conditionAttr);
        entry.rawUnit = unitAttr !== "" ? unitAttr : entry.rawUnit;
      } else if (type === "レベル") {
        entry.level = toSeriesLevel(value);
      }
      byRefId.set(refId, entry);
    }

    const series: FloodSeriesWindow[] = Array.from(byRefId.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([refId, e]) => {
        const td = timeMap.get(refId);
        return {
          refId,
          dateTime: td?.dateTime ?? "",
          name: td?.name ?? "",
          value: e.value,
          unit,
          rawUnit: e.rawUnit,
          condition: e.condition,
          level: e.level,
        };
      });

    // Item.Station は ARRAY_TAGS に含まれるため配列化される
    const stationNode = listOf(dig(item, "Station"))[0];
    const stationName = str(dig(stationNode, "Name"));
    // Station.Code は @_type 属性を持つ要素 → #text を読む必要がある
    const stationCode = nodeText(dig(stationNode, "Code"));
    const location = str(dig(stationNode, "Location"));
    if (stationCode === "" && stationName === "") continue;

    // stationCode 重複検知 (fixture placeholder や仕様外電文用の observability hook)
    if (stationCode !== "") {
      if (seenStationCodes.has(stationCode)) {
        if (!warnedStationCodes.has(stationCode)) {
          log.debug(
            `[flood-forecast-parser] stationCode 重複検知: code=${stationCode} (stationName keyed map で一意化済み)`,
          );
          warnedStationCodes.add(stationCode);
        }
      } else {
        seenStationCodes.add(stationCode);
      }
    }

    // fixture placeholder では stationCode が重複することがあるため、
    // 観測点名で一意化する (実電文では code+name で衝突しない)。
    // 観測点名 → entry の map を構築する。
    result.set(stationName !== "" ? stationName : stationCode, {
      stationName,
      stationCode,
      location,
      measurement,
      series,
      rawUnit: lastRawUnit,
    });
  }

  return result;
}

/**
 * Body.AdditionalInfo.FloodForecastAddition.HydrometricStationPart を読んで
 * 各観測所のメタ情報 + Criteria + ChargeSection を抽出し、水位・流量系列と
 * join して `FloodStation[]` を組む。
 *
 * primaryRiverCode は §3.1: ChargeSection の先頭行を河川名候補とし、
 * headline (scope=河川) の area.name と一致するものを引いて Code を解決する。
 * 一致しない場合は null。
 */
export function parseStationsAndAggregate(
  body: unknown,
  headlines: FloodHeadline[],
): FloodStation[] {
  if (body == null) return [];
  const stationSeriesMap = buildStationSeriesMap(body);

  // headline (scope=河川) の Area.Name → Code map
  const riverNameToCode = new Map<string, string>();
  for (const h of headlines) {
    if (h.scope !== "河川") continue;
    for (const a of h.areas) {
      if (a.name !== "" && a.code !== "") {
        riverNameToCode.set(a.name, a.code);
      }
    }
  }

  const addition = dig(body, "AdditionalInfo", "FloodForecastAddition");
  const stationParts = listOf(dig(addition, "HydrometricStationPart"));
  const result: FloodStation[] = [];
  for (const part of stationParts) {
    if (part == null) continue;
    // Area は HydrometricStationPart 直下 1 件 (ARRAY_TAGS に含まれるが配列化される)
    const areaNode = listOf(dig(part, "Area"))[0];
    const stationCode = str(dig(areaNode, "Code"));
    const stationName = str(dig(areaNode, "Name"));
    const location = str(dig(areaNode, "Location"));

    const chargeSections = listOf(dig(part, "ChargeSection"));
    const riverNames: string[] = [];
    for (const cs of chargeSections) {
      const text = nodeText(cs) || str(cs);
      const firstLine = text.split("\n")[0].trim();
      if (firstLine !== "") riverNames.push(firstLine);
    }
    const primaryRiverName = riverNames[0] ?? null;
    const primaryRiverCode =
      primaryRiverName != null
        ? riverNameToCode.get(primaryRiverName) ?? null
        : null;

    const criteria = parseCriteriaFromPart(dig(part, "Criteria"));
    // stationName で lookup (fixture placeholder で code が重複しても観測点名は一意)。
    // 実電文では Station.Name と HydrometricStationPart.Area.Name は対応する。
    const ss = stationSeriesMap.get(stationName) ?? stationSeriesMap.get(stationCode);
    const measurement: FloodMeasurement = ss?.measurement ?? "water_level";
    const measurementUnit: FloodMeasurementUnit =
      measurement === "discharge" ? "立方メートル毎秒" : "m";
    const series = ss?.series ?? [];
    const stationObservedLevel = computeStationObservedLevel(series);

    const resolvedStationName =
      ss?.stationName !== undefined && ss?.stationName !== ""
        ? ss.stationName
        : stationName;
    // §3.1 ルールで headlineKindCode を解決
    const headlineKindCode = resolveHeadlineKindForStation(
      headlines,
      primaryRiverCode,
    );
    const headlineLevel = FLOOD_KIND_CODE_TO_LEVEL[headlineKindCode];
    // Warning.Item から mainItemCode / mainTextHash を解決
    const { mainItemCode, mainTextHash } = computeMainItemCodeAndHash(
      body,
      stationCode,
      resolvedStationName,
    );

    result.push({
      stationName: resolvedStationName,
      stationCode,
      riverNames,
      primaryRiverCode,
      primaryRiverName,
      prefName: null,
      cityName: null,
      cityCode: null,
      location:
        ss?.location !== undefined && ss?.location !== ""
          ? ss.location
          : location || null,
      measurement,
      measurementUnit,
      rawUnit: ss?.rawUnit ?? measurementUnit,
      series,
      criteria,
      stationObservedLevel,
      headlineKindCode,
      headlineLevel,
      mainItemCode,
      mainTextHash,
    });
  }
  return result;
}
