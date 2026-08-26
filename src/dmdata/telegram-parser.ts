import {
  WsDataMessage,
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  EewAccuracy,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  LgObservationArea,
  TsunamiForecastItem,
  TsunamiStationItem,
  TsunamiObservationStation,
  TsunamiEstimationItem,
  ParsedEarthquakeIntensityArea,
  ParsedEarthquakeIntensityMunicipality,
  ParsedEarthquakeIntensityStation,
  ParsedEarthquakeIntensityPref,
  LgObservationPref,
  SpecialValue,
  TsunamiParserDiagnostic,
} from "../types";
import {
  createJmxShadowXmlParser,
  createJmxXmlParser,
  dig,
  str,
  first,
  listOf,
} from "./xml-shape";
import { extractSpecialValue } from "./special-value";
import { depthScalar, magnitudeScalar } from "../utils/magnitude";
import { decodeTelegramBody } from "./telegram-body";
import { requireTelegramMeta } from "./telegram-ingress";
import * as log from "../logger";

// 汎用ノードアクセスヘルパは xml-shape に集約済み。従来 telegram-parser から
// import している各所を壊さないよう re-export する。
export { dig, str, first };

const isTelegramArrayTag = (name: string): boolean => {
  // 震度観測地域、市町村等は配列として扱う
  const arrayTags = [
    "Pref",
    "Area",
    "City",
    "IntensityStation",
    "Item",
    "Kind",
    "Category",
    "ForecastInt",
    "Observation",
    "Station",
    "Estimation",
    // 火山電文
    "VolcanoInfo",
    "AshInfo",
    "WindAboveCraterElements",
  ];
  return arrayTags.includes(name);
};

const xmlParser = createJmxXmlParser(isTelegramArrayTag);
// Phase 4A 対象値だけは、表示本文等の既存 trim 契約と分離した tree から読む。
const specialValueXmlParser = createJmxShadowXmlParser(isTelegramArrayTag);

const SPECIAL_VALUE_TELEGRAM_TYPES = new Set([
  "VXSE43",
  "VXSE44",
  "VXSE45",
  "VXSE51",
  "VXSE52",
  "VXSE53",
  "VXSE61",
  "VXSE62",
  "VTSE41",
  "VTSE51",
  "VTSE52",
]);

/** body フィールドをデコードしてXML文字列を返す */
export function decodeBody(msg: WsDataMessage): string {
  return decodeTelegramBody(msg);
}

/** XML文字列をパースしてJSオブジェクトを返す */
export function parseXml(xmlStr: string): Record<string, unknown> {
  return xmlParser.parse(xmlStr);
}

function normalizeConditionText(condition: string): string {
  if (!condition) return "";
  return condition.normalize("NFKC").replace(/\s+/g, "");
}

function isAssumedHypocenterCondition(condition: string): boolean {
  return normalizeConditionText(condition).includes("仮定震源要素");
}

function isPlumAreaCondition(condition: string): boolean {
  return /PLUM法/.test(normalizeConditionText(condition));
}

function hasArrivedAreaCondition(condition: string): boolean {
  return normalizeConditionText(condition).includes("既に主要動到達");
}

function isAssumedHypocenterFallbackPattern(
  earthquake: ParsedEarthquakeInfo["earthquake"] | undefined
): boolean {
  if (!earthquake) return false;
  const mag = parseFloat(earthquake.magnitude);
  const depthMatch = earthquake.depth.match(/^(\d+)km$/);
  const depthKm = depthMatch ? parseInt(depthMatch[1], 10) : -1;
  return mag === 1.0 && depthKm === 10;
}

/** 震源関連の情報を抽出 */
function extractEarthquake(
  earthquake: unknown,
  specialValueEarthquake: unknown = earthquake,
): ParsedEarthquakeInfo["earthquake"] | undefined {
  if (!earthquake) return undefined;

  const originTime = str(dig(earthquake, "OriginTime"));
  const hypo = dig(earthquake, "Hypocenter");
  const area = first(dig(hypo, "Area") as unknown[]);
  const name = str(dig(area, "Name"));

  // 座標パース: "+35.7+139.8-10000/" 形式
  // VXSE61 等では jmx_eb:Coordinate が複数 (十進度 + 度分) 存在し配列になる。
  // type="震源位置（度分）" を除外して十進度を優先選択する。
  const rawCoord = dig(area, "jmx_eb:Coordinate") || dig(area, "Coordinate");
  const coordNode = Array.isArray(rawCoord)
    ? rawCoord.find(
        (c: unknown) => str(dig(c, "@_type")) !== "震源位置（度分）"
      ) ?? rawCoord[0]
    : rawCoord;
  const rawSpecialArea = first(dig(specialValueEarthquake, "Hypocenter", "Area") as unknown[]);
  const rawSpecialCoord = dig(rawSpecialArea, "jmx_eb:Coordinate") || dig(rawSpecialArea, "Coordinate");
  const specialCoordNode = Array.isArray(rawSpecialCoord)
    ? rawSpecialCoord.find(
        (c: unknown) => str(dig(c, "@_type")) !== "震源位置（度分）"
      ) ?? rawSpecialCoord[0]
    : rawSpecialCoord;
  const coordStr = str(
    coordNode != null && typeof coordNode === "object"
      ? dig(coordNode, "#text")
      : coordNode
  );
  const coordinate = parseCoordinate(coordStr, specialCoordNode);
  const depthValue = extractSpecialValue("Depth", coordinate.depthCarrier);

  const magnitudeNode =
    dig(specialValueEarthquake, "jmx_eb:Magnitude")
    || dig(specialValueEarthquake, "Magnitude");
  const magnitudeValue = extractSpecialValue("Magnitude", magnitudeNode);

  return {
    originTime,
    hypocenterName: name,
    latitude: coordinate.lat,
    longitude: coordinate.lon,
    depth: depthScalar(depthValue),
    depthValue,
    magnitude: magnitudeScalar(magnitudeValue),
    magnitudeValue,
    magnitudeInfo: {
      value: magnitudeValue.raw ?? "",
      condition: magnitudeValue.condition,
      description: magnitudeValue.description,
    },
  };
}

/** 座標文字列をパースし、深さ第3成分を SpecialValue 用 carrier へ載せる。 */
function parseCoordinate(coord: string, rawCoordinateNode: unknown): {
  lat: string;
  lon: string;
  depthCarrier: unknown;
} {
  if (!coord) return { lat: "", lon: "", depthCarrier: undefined };

  // 形式: "+緯度+経度-深さ/" or "+緯度+経度/"
  const numberComponent = String.raw`[+-](?:\d+(?:\.\d+)?|\.\d+)`;
  const match = coord.match(new RegExp(
    `^(${numberComponent})(${numberComponent})(?:(${numberComponent}))?/$`,
  ));
  if (!match) return { lat: "", lon: "", depthCarrier: undefined };

  const latNum = parseFloat(match[1]);
  const lonNum = parseFloat(match[2]);
  const rawDepth = match[3];
  const depthNum = rawDepth == null ? null : Math.abs(parseFloat(rawDepth));
  const rawCondition = dig(rawCoordinateNode, "@_condition");
  const rawDescription = dig(rawCoordinateNode, "@_description");
  const depthCarrier = rawDepth == null || depthNum == null || !Number.isFinite(depthNum)
    ? undefined
    : {
        "#text": rawDepth,
        ...(rawCondition === undefined ? {} : { "@_condition": str(rawCondition) }),
        ...(rawDescription === undefined ? {} : { "@_description": str(rawDescription) }),
        "@_unit": depthNum >= 1000 ? "m" : "km",
      };

  return {
    lat: `${latNum >= 0 ? "N" : "S"}${Math.abs(latNum).toFixed(1)}`,
    lon: `${lonNum >= 0 ? "E" : "W"}${Math.abs(lonNum).toFixed(1)}`,
    depthCarrier,
  };
}

function optionalCode(node: unknown): string | null {
  const code = str(dig(node, "Code")).trim();
  return code === "" ? null : code;
}

/**
 * 津波コードは表示名用の既存コード helper と分離して raw を保持する。
 * 空要素だけは欠落として null にするが、先頭ゼロ・空白を含む非空文字列は変更しない。
 */
function optionalRawTsunamiCode(node: unknown): string | null {
  const raw = dig(node, "Code");
  if (raw == null) return null;
  const value = typeof raw === "object" && raw != null
    ? str(dig(raw, "#text"))
    : str(raw);
  return value.trim() === "" ? null : value;
}

// 現行 JMAXML の津波予報区コード (66 区域)。未収載の将来コードは raw のまま診断へ送る。
const KNOWN_TSUNAMI_FORECAST_AREA_CODES = new Set([
  "100", "101", "102", "110", "111", "120", "200", "201", "202",
  "210", "220", "230", "240", "250", "300", "310", "311", "312",
  "320", "321", "330", "340", "341", "350", "360", "361", "370",
  "380", "390", "391", "400", "500", "510", "520", "521", "522",
  "530", "540", "550", "551", "560", "570", "580", "590", "600",
  "601", "610", "700", "701", "710", "711", "712", "720", "730",
  "731", "740", "750", "751", "760", "770", "771", "772", "773",
  "800", "801", "802",
]);

// 予報区の Kind.Code は fixture corpus に現れる JMAXML code を網羅する。
const KNOWN_TSUNAMI_KIND_CODES = new Set(["51", "52", "53", "60", "62", "71"]);

function tsunamiCodeDiagnostic(
  code: string | null,
  knownCodes: ReadonlySet<string>,
  diagnostic: TsunamiParserDiagnostic,
): TsunamiParserDiagnostic | null {
  return code == null || !knownCodes.has(code) ? diagnostic : null;
}

function tsunamiHeightNode(node: unknown): unknown {
  const namespaced = dig(node, "MaxHeight", "jmx_eb:TsunamiHeight");
  return namespaced !== undefined
    ? namespaced
    : dig(node, "MaxHeight", "TsunamiHeight");
}

/**
 * VTSE51/52 の「観測中」は TsunamiHeight 要素ではなく MaxHeight/Condition に
 * 出る実 fixture がある。値要素が欠落していても、その進行状態だけを同じ
 * SpecialValue 抽出器へ渡すための carrier を作る。
 */
function tsunamiObservationHeightNode(node: unknown): unknown {
  const height = tsunamiHeightNode(node);
  const condition = str(dig(node, "MaxHeight", "Condition"));
  if (height === undefined) {
    return condition.includes("観測中")
      ? { "#text": "", "@_condition": condition }
      : undefined;
  }
  if (condition === "") return height;
  if (typeof height === "object" && height != null && !Array.isArray(height)) {
    const childCondition = str(dig(height, "@_condition"));
    return childCondition.trim() === ""
      ? { ...height, "@_condition": condition }
      : height;
  }
  return { "#text": str(height), "@_condition": condition };
}

/** SpecialValue を既存表示用 scalar へ投影する互換 adapter。 */
function specialValueScalar<T extends string>(specialValue: SpecialValue<T>): string {
  switch (specialValue.presence) {
    case "value":
      return specialValue.value ?? specialValue.raw ?? "";
    case "range":
      return specialValue.lowerBound
        ?? specialValue.rawLowerBound
        ?? specialValue.raw
        ?? "";
    case "qualitative":
      return "";
    case "missing":
    case "empty":
    case "unknown":
      return "";
  }
}

/** EEW ForecastInt/To の既存 adapter。exact pair は To を省略する。 */
function specialValueUpperScalar<T extends string>(
  specialValue: SpecialValue<T>,
): string | undefined {
  if (specialValue.presence !== "range") return undefined;
  const upper = specialValue.upperBound ?? specialValue.rawUpperBound;
  if (upper == null || upper === "") return undefined;
  return upper === specialValueScalar(specialValue) ? undefined : upper;
}

function emptyIntensityCarrier(
  rawCarrier: unknown,
): ParsedEarthquakeInfo["intensity"] {
  const maxIntValue = extractSpecialValue("Intensity", rawCarrier);
  const maxLgIntValue = extractSpecialValue("LgInt", rawCarrier);
  return {
    maxIntValue,
    maxInt: specialValueScalar(maxIntValue),
    maxLgIntValue,
    prefs: [],
    areas: [],
    municipalities: [],
    stations: [],
  };
}

/** 震度観測地域を Observation/Pref/Area/City から抽出 */
function extractIntensity(
  body: unknown,
  rawBody: unknown,
): ParsedEarthquakeInfo["intensity"] | undefined {
  const intensity = dig(body, "Intensity");
  if (intensity === undefined) return undefined;
  const rawIntensity = dig(rawBody, "Intensity");

  const observationNode = dig(intensity, "Observation");
  if (observationNode === undefined) {
    return emptyIntensityCarrier(rawIntensity);
  }
  const observation = first(listOf(observationNode));
  const rawValueObservation = first(listOf(dig(rawIntensity, "Observation")));
  if (typeof observation !== "object" || observation == null) {
    return emptyIntensityCarrier(rawValueObservation);
  }

  const maxIntValue = extractSpecialValue("Intensity", dig(rawValueObservation, "MaxInt"));
  const maxInt = specialValueScalar(maxIntValue);
  const maxLgIntValue = extractSpecialValue("LgInt", dig(rawValueObservation, "MaxLgInt"));
  const maxLgInt = specialValueScalar(maxLgIntValue) || undefined;

  const prefs: ParsedEarthquakeIntensityPref[] = [];
  const areas: ParsedEarthquakeIntensityArea[] = [];
  const municipalities: ParsedEarthquakeIntensityMunicipality[] = [];
  const stations: ParsedEarthquakeIntensityStation[] = [];
  const prefNodes = listOf(dig(observation, "Pref"));
  const rawPrefNodes = listOf(dig(rawValueObservation, "Pref"));
  for (const [prefIndex, pref] of prefNodes.entries()) {
    const rawPref = rawPrefNodes[prefIndex];
    const prefMaxIntValue = extractSpecialValue("Intensity", dig(rawPref, "MaxInt"));
    const prefMaxLgIntValue = extractSpecialValue("LgInt", dig(rawPref, "MaxLgInt"));
    const prefMaxLgInt = specialValueScalar(prefMaxLgIntValue);
    prefs.push({
      name: str(dig(pref, "Name")),
      code: optionalCode(pref),
      maxIntValue: prefMaxIntValue,
      maxInt: specialValueScalar(prefMaxIntValue),
      maxLgIntValue: prefMaxLgIntValue,
      ...(prefMaxLgInt ? { maxLgInt: prefMaxLgInt } : {}),
    });
    const areaNodes = listOf(dig(pref, "Area"));
    const rawAreaNodes = listOf(dig(rawPref, "Area"));
    for (const [areaIndex, area] of areaNodes.entries()) {
      const rawArea = rawAreaNodes[areaIndex];
      const intensityValue = extractSpecialValue("Intensity", dig(rawArea, "MaxInt"));
      const lgIntensityValue = extractSpecialValue("LgInt", dig(rawArea, "MaxLgInt"));
      const lgInt = specialValueScalar(lgIntensityValue);
      areas.push({
        name: str(dig(area, "Name")),
        code: optionalCode(area),
        intensityValue,
        intensity: specialValueScalar(intensityValue),
        lgIntensityValue,
        ...(lgInt ? { lgIntensity: lgInt } : {}),
      });
      const cityNodes = listOf(dig(area, "City"));
      const rawCityNodes = listOf(dig(rawArea, "City"));
      for (const [cityIndex, city] of cityNodes.entries()) {
        const rawCity = rawCityNodes[cityIndex];
        const cityMaxInt = dig(rawCity, "MaxInt");
        const cityCondition = dig(rawCity, "Condition");
        const cityIntensityValue = extractSpecialValue(
          "Intensity",
          cityMaxInt === undefined && cityCondition !== undefined
            ? { "@_condition": cityCondition }
            : cityMaxInt,
        );
        const cityLgIntensityValue = extractSpecialValue("LgInt", dig(rawCity, "MaxLgInt"));
        const cityLgInt = specialValueScalar(cityLgIntensityValue);
        municipalities.push({
          name: str(dig(city, "Name")),
          code: optionalCode(city),
          intensityValue: cityIntensityValue,
          intensity: specialValueScalar(cityIntensityValue),
          lgIntensityValue: cityLgIntensityValue,
          ...(cityLgInt ? { lgIntensity: cityLgInt } : {}),
        });
        const stationNodes = listOf(dig(city, "IntensityStation"));
        const rawStationNodes = listOf(dig(rawCity, "IntensityStation"));
        for (const [stationIndex, station] of stationNodes.entries()) {
          const rawStation = rawStationNodes[stationIndex];
          const stationIntensityValue = extractSpecialValue("Intensity", dig(rawStation, "Int"));
          stations.push({
            name: str(dig(station, "Name")),
            code: optionalCode(station),
            intensityValue: stationIntensityValue,
            intensity: specialValueScalar(stationIntensityValue),
          });
        }
      }
    }
  }

  return {
    maxIntValue,
    maxInt,
    maxLgIntValue,
    ...(maxLgInt ? { maxLgInt } : {}),
    prefs,
    areas,
    municipalities,
    stations,
  };
}

/** 津波情報を抽出 */
function extractTsunami(body: unknown): ParsedEarthquakeInfo["tsunami"] | undefined {
  const comments = dig(body, "Comments");
  if (!comments) return undefined;

  const forecast = dig(comments, "ForecastComment");
  const text =
    str(dig(forecast, "Text")) ||
    str(dig(comments, "ForecastComment", "Text"));

  if (!text) return undefined;
  return { text };
}

// ── EEW ヘルパー ──

/** Headline Information の Kind Code に警報コード (31) が含まれるか */
function hasWarningHeadlineCode(head: unknown): boolean {
  const headline = dig(head, "Headline");
  const informations = dig(headline, "Information");
  const infoList = Array.isArray(informations) ? informations : informations ? [informations] : [];
  for (const info of infoList) {
    const items = dig(info, "Item");
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    for (const item of itemList) {
      const kinds = dig(item, "Kind");
      const kindList = Array.isArray(kinds) ? kinds : kinds ? [kinds] : [];
      for (const kind of kindList) {
        const code = parseInt(str(dig(kind, "Code")), 10);
        if (code === 31) return true;
      }
    }
  }
  return false;
}

/** 予測地域の Category Kind Code に警報コード (10-19) が含まれるか */
function hasWarningAreaKind(body: unknown): boolean {
  const forecast = dig(body, "Intensity", "Forecast");
  if (!forecast) return false;
  const prefs = dig(forecast, "Pref");
  if (!Array.isArray(prefs)) return false;
  for (const pref of prefs) {
    const areas = dig(pref, "Area");
    if (!Array.isArray(areas)) continue;
    for (const area of areas) {
      const categories = dig(area, "Category");
      const catList = Array.isArray(categories) ? categories : categories ? [categories] : [];
      for (const cat of catList) {
        const kinds = dig(cat, "Kind");
        const kindList = Array.isArray(kinds) ? kinds : kinds ? [kinds] : [];
        for (const kind of kindList) {
          const code = parseInt(str(dig(kind, "Code")), 10);
          if (code >= 10 && code <= 19) return true;
        }
      }
    }
  }
  return false;
}

function parseMaxIntChangeReason(body: unknown): number | undefined {
  const raw = str(dig(body, "Intensity", "Forecast", "Appendix", "MaxIntChangeReason"));
  if (!raw) return undefined;
  const code = Number.parseInt(raw, 10);
  return Number.isNaN(code) ? undefined : code;
}

function extractEewForecastAreas(
  body: unknown,
  rawBody: unknown,
): {
  areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"];
  maxInt?: string;
  maxIntValue: NonNullable<ParsedEewInfo["forecastIntensity"]>["maxIntValue"];
  maxLgInt?: string;
  maxLgIntValue: NonNullable<ParsedEewInfo["forecastIntensity"]>["maxLgIntValue"];
  hasPlumArea: boolean;
} | undefined {
  const forecast = dig(body, "Intensity", "Forecast");
  if (!forecast) return undefined;
  const rawForecast = dig(rawBody, "Intensity", "Forecast");

  const overallInt = dig(rawForecast, "ForecastInt");
  const overallIntNode = Array.isArray(overallInt)
    ? overallInt[0]
    : overallInt;
  const maxIntValue = extractSpecialValue("Intensity", overallIntNode);
  const maxInt = specialValueScalar(maxIntValue) || undefined;

  const overallLgInt = dig(rawForecast, "ForecastLgInt");
  const overallLgIntNode = Array.isArray(overallLgInt)
    ? overallLgInt[0]
    : overallLgInt;
  const maxLgIntValue = extractSpecialValue("LgInt", overallLgIntNode);
  const maxLgInt = specialValueScalar(maxLgIntValue) || undefined;

  const areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"] = [];
  const prefs = listOf(dig(forecast, "Pref"));
  const rawPrefs = listOf(dig(rawForecast, "Pref"));
  for (const [prefIndex, pref] of prefs.entries()) {
    const rawPref = rawPrefs[prefIndex];
    const prefAreas = listOf(dig(pref, "Area"));
    const rawPrefAreas = listOf(dig(rawPref, "Area"));
    for (const [areaIndex, area] of prefAreas.entries()) {
      const rawArea = rawPrefAreas[areaIndex];
      const rawForecastInt = dig(rawArea, "ForecastInt") || dig(rawArea, "ForecastIntFrom");
      const forecastInt = Array.isArray(rawForecastInt) ? rawForecastInt[0] : rawForecastInt;

      const rawLgInt = dig(rawArea, "ForecastLgInt");
      const lgIntNode = Array.isArray(rawLgInt) ? rawLgInt[0] : rawLgInt;
      const lgIntensityValue = extractSpecialValue("LgInt", lgIntNode);
      const lgInt = specialValueScalar(lgIntensityValue);

      const conditionNode = dig(area, "Condition");
      const condition = str(conditionNode);
      const isPlum = isPlumAreaCondition(condition) || undefined;
      const hasArrived = hasArrivedAreaCondition(condition) || undefined;

      const intensityValue = extractSpecialValue("Intensity", forecastInt);
      const intensityFrom = specialValueScalar(intensityValue);
      const intensityTo = specialValueUpperScalar(intensityValue);
      const areaArrivalTime = str(dig(area, "ArrivalTime"));

      areas.push({
        name: str(dig(area, "Name")),
        intensityValue,
        intensity: intensityFrom,
        ...(intensityTo ? { intensityTo } : {}),
        ...(areaArrivalTime ? { arrivalTime: areaArrivalTime } : {}),
        lgIntensityValue,
        ...(lgInt ? { lgIntensity: lgInt } : {}),
        ...(conditionNode !== undefined ? { condition } : {}),
        ...(isPlum ? { isPlum } : {}),
        ...(hasArrived ? { hasArrived } : {}),
      });
    }
  }

  const hasPlumArea = areas.some((a) => a.isPlum === true);
  return { areas, maxInt, maxIntValue, maxLgInt, maxLgIntValue, hasPlumArea };
}

/** rank 属性・数値要素を number | null に正規化 (欠落・非数値は null。0 は有効値) */
function eewRankNum(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * EEW 専用: Earthquake/Hypocenter/Accuracy を抽出。
 * 精度は rank 属性側にある (要素値は "NaN" 文字列 — 混同しない、spec 4.4)。
 * 共有 extractEarthquake / ParsedEarthquakeInfo は触らない (実装が割れるのを防ぐ)
 */
function extractEewAccuracy(earthquake: unknown): EewAccuracy | undefined {
  const accuracy = dig(earthquake, "Hypocenter", "Accuracy");
  if (!accuracy) return undefined;
  return {
    epicenterRank: eewRankNum(dig(accuracy, "Epicenter", "@_rank")),
    epicenterRank2: eewRankNum(dig(accuracy, "Epicenter", "@_rank2")),
    depthRank: eewRankNum(dig(accuracy, "Depth", "@_rank")),
    magnitudeRank: eewRankNum(dig(accuracy, "MagnitudeCalculation", "@_rank")),
    magnitudeCalcCount: eewRankNum(dig(accuracy, "NumberOfMagnitudeCalculation")),
  };
}

// ── 津波ヘルパー ──

function extractTsunamiObservations(
  tsunamiNode: unknown,
  specialValueTsunamiNode: unknown,
): TsunamiObservationStation[] {
  const observationsNodes = listOf(dig(tsunamiNode, "Observation"));
  const specialObservationNodes = listOf(dig(specialValueTsunamiNode, "Observation"));
  const observations: TsunamiObservationStation[] = [];
  for (const [observationIndex, node] of observationsNodes.entries()) {
    const specialNode = specialObservationNodes[observationIndex];
    const items = listOf(dig(node, "Item"));
    const specialItems = listOf(dig(specialNode, "Item"));
    for (const [itemIndex, item] of items.entries()) {
      const specialItem = specialItems[itemIndex];
      const area = first(dig(item, "Area") as unknown[]);
      const specialArea = first(dig(specialItem, "Area") as unknown[]);
      const areaName = str(dig(area, "Name")).trim() || null;
      const areaCode = specialArea == null
        ? optionalRawTsunamiCode(area)
        : optionalRawTsunamiCode(specialArea);
      const stations = listOf(dig(item, "Station"));
      const specialStations = listOf(dig(specialItem, "Station"));
      for (const [stationIndex, station] of stations.entries()) {
        const specialStation = specialStations[stationIndex];
        const rawTsunamiHeight = tsunamiHeightNode(station);
        const maxHeight = extractSpecialValue(
          "TsunamiHeight",
          tsunamiObservationHeightNode(specialStation),
        );
        const maxHeightValue = maxHeight.description == null
          ? null
          : maxHeight.description.trim() || null;
        observations.push({
          areaName,
          areaCode,
          stationCode: str(dig(station, "Code")).trim() || null,
          name: str(dig(station, "Name")),
          sensor: str(dig(station, "Sensor")),
          arrivalTime: str(dig(station, "FirstHeight", "ArrivalTime")),
          initial: str(dig(station, "FirstHeight", "Initial")),
          maxHeightCondition: str(dig(station, "MaxHeight", "Condition")),
          maxHeightValue,
          maxHeight,
          maxHeightValueCondition: rawTsunamiHeight === undefined
            ? ""
            : str(dig(rawTsunamiHeight, "@_condition")),
        });
      }
    }
  }
  return observations;
}

function extractTsunamiEstimations(tsunamiNode: unknown): TsunamiEstimationItem[] {
  const rawEstimation = dig(tsunamiNode, "Estimation");
  const estimationNodes = Array.isArray(rawEstimation)
    ? rawEstimation
    : rawEstimation
      ? [rawEstimation]
      : [];

  const estimations: TsunamiEstimationItem[] = [];
  for (const node of estimationNodes) {
    const items = dig(node, "Item");
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      const area = first(dig(item, "Area") as unknown[]);
      const areaName = str(dig(area, "Name")).trim();
      if (!areaName) {
        continue;
      }
      const maxHeightDescription =
        str(dig(item, "MaxHeight", "jmx_eb:TsunamiHeight", "@_description")) ||
        str(dig(item, "MaxHeight", "TsunamiHeight", "@_description")) ||
        str(dig(item, "MaxHeight", "Condition"));
      const firstHeight =
        str(dig(item, "FirstHeight", "ArrivalTime")) ||
        str(dig(item, "FirstHeight", "Condition"));
      estimations.push({
        areaName,
        maxHeightDescription,
        firstHeight,
      });
    }
  }
  return estimations;
}

// ── 長周期地震動ヘルパー ──

function extractLgObservationDetails(body: unknown, rawBody: unknown): {
  maxInt?: string;
  maxLgInt?: string;
  maxIntValue: ParsedLgObservationInfo["maxIntValue"];
  maxLgIntValue: ParsedLgObservationInfo["maxLgIntValue"];
  lgCategory?: string;
  prefs: LgObservationPref[];
  areas: LgObservationArea[];
} {
  const result: {
    maxInt?: string;
    maxLgInt?: string;
    maxIntValue: ParsedLgObservationInfo["maxIntValue"];
    maxLgIntValue: ParsedLgObservationInfo["maxLgIntValue"];
    lgCategory?: string;
    prefs: LgObservationPref[];
    areas: LgObservationArea[];
  } = {
    maxIntValue: extractSpecialValue("Intensity", undefined),
    maxLgIntValue: extractSpecialValue("LgInt", undefined),
    prefs: [],
    areas: [],
  };

  const intensity = dig(body, "Intensity");
  if (!intensity) return result;
  const rawIntensity = dig(rawBody, "Intensity");

  const observationNode = dig(intensity, "Observation");
  if (!observationNode) return result;

  const observation = first(observationNode as unknown[]);
  const rawValueObservation = first(listOf(dig(rawIntensity, "Observation")));
  result.maxIntValue = extractSpecialValue("Intensity", dig(rawValueObservation, "MaxInt"));
  result.maxLgIntValue = extractSpecialValue("LgInt", dig(rawValueObservation, "MaxLgInt"));
  result.maxInt = specialValueScalar(result.maxIntValue) || undefined;
  result.maxLgInt = specialValueScalar(result.maxLgIntValue) || undefined;
  result.lgCategory = str(dig(observation, "LgCategory")) || undefined;

  const prefs = listOf(dig(observation, "Pref"));
  const rawPrefs = listOf(dig(rawValueObservation, "Pref"));
  for (const [prefIndex, pref] of prefs.entries()) {
    const rawPref = rawPrefs[prefIndex];
    const prefMaxIntValue = extractSpecialValue("Intensity", dig(rawPref, "MaxInt"));
    const prefMaxLgIntValue = extractSpecialValue("LgInt", dig(rawPref, "MaxLgInt"));
    result.prefs.push({
      name: str(dig(pref, "Name")),
      code: optionalCode(pref),
      maxIntValue: prefMaxIntValue,
      maxInt: specialValueScalar(prefMaxIntValue),
      maxLgIntValue: prefMaxLgIntValue,
      maxLgInt: specialValueScalar(prefMaxLgIntValue),
    });
    const prefAreas = listOf(dig(pref, "Area"));
    const rawPrefAreas = listOf(dig(rawPref, "Area"));
    for (const [areaIndex, area] of prefAreas.entries()) {
      const rawArea = rawPrefAreas[areaIndex];
      const maxIntValue = extractSpecialValue("Intensity", dig(rawArea, "MaxInt"));
      const maxLgIntValue = extractSpecialValue("LgInt", dig(rawArea, "MaxLgInt"));
      const areaMaxInt = specialValueScalar(maxIntValue);
      const areaMaxLgInt = specialValueScalar(maxLgIntValue);
      if (
        maxIntValue.presence !== "missing"
        || maxLgIntValue.presence !== "missing"
      ) {
        result.areas.push({
          name: str(dig(area, "Name")),
          maxIntValue,
          maxInt: areaMaxInt,
          maxLgIntValue,
          maxLgInt: areaMaxLgInt,
        });
      }
    }
  }

  return result;
}

// ── 共通前処理 ──

/** decodeBody → parseXml → Report/Head/Body を抽出する共通前処理 */
export function extractBaseReport(msg: WsDataMessage): {
  report: unknown;
  head: unknown;
  body: unknown;
  specialValueBody: unknown;
} | null {
  const xmlStr = decodeBody(msg);
  const parsed = parseXml(xmlStr);

  const report =
    dig(parsed, "Report") ||
    dig(parsed, "jmx:Report") ||
    dig(parsed, "jmx_seis:Report");

  if (!report) {
    log.debug("Report ノードが見つかりません");
    return null;
  }

  let specialValueBody = dig(report, "Body");
  if (SPECIAL_VALUE_TELEGRAM_TYPES.has(msg.head.type)) {
    const specialParsed = specialValueXmlParser.parse(xmlStr) as Record<string, unknown>;
    const specialReport =
      dig(specialParsed, "Report")
      || dig(specialParsed, "jmx:Report")
      || dig(specialParsed, "jmx_seis:Report");
    specialValueBody = dig(specialReport, "Body");
  }

  return {
    report,
    head: dig(report, "Head"),
    body: dig(report, "Body"),
    specialValueBody,
  };
}

// ── 公開API ──

/** 地震関連電文(VXSE51/52/53等)をパース */
export function parseEarthquakeTelegram(
  msg: WsDataMessage
): ParsedEarthquakeInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body, specialValueBody } = base;

    const info: ParsedEarthquakeInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      eventId: str(dig(head, "EventID")) || null,
      meta,
      isTest: meta.isTest,
    };

    // 震源
    // Earthquakeノードの取得（配列の場合は先頭を使用）
    let earthquake = dig(body, "Earthquake");
    if (Array.isArray(earthquake)) {
      earthquake = earthquake[0];
    }
    if (earthquake) {
      const specialEarthquake = dig(specialValueBody, "Earthquake");
      info.earthquake = extractEarthquake(
        earthquake,
        Array.isArray(specialEarthquake) ? specialEarthquake[0] : specialEarthquake,
      );
    }

    // 震度
    info.intensity = extractIntensity(body, specialValueBody);

    // 津波
    info.tsunami = extractTsunami(body);

    return info;
  } catch (err) {
    log.error(
      `地震電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** EEW電文をパース */
export function parseEewTelegram(
  msg: WsDataMessage
): ParsedEewInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body, specialValueBody } = base;

    // 仮定震源要素の検出
    const earthquake = dig(body, "Earthquake");
    const earthquakeCondition = str(dig(earthquake, "Condition"));
    const assumedHypocenterByCondition = isAssumedHypocenterCondition(earthquakeCondition);

    const info: ParsedEewInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      serial: str(dig(head, "Serial")) || null,
      eventId: str(dig(head, "EventID")) || null,
      meta,
      isTest: meta.isTest,
      isWarning: false, // 仮値 — 後で XML から判定
      isAssumedHypocenter: false,
    };

    info.maxIntChangeReason = parseMaxIntChangeReason(body);

    if (earthquake) {
      const specialEarthquake = dig(specialValueBody, "Earthquake");
      info.earthquake = extractEarthquake(
        earthquake,
        Array.isArray(specialEarthquake) ? specialEarthquake[0] : specialEarthquake,
      );
      const arrivalTime = str(dig(earthquake, "ArrivalTime"));
      if (arrivalTime) info.arrivalTime = arrivalTime;
      const hypoArea = first(dig(earthquake, "Hypocenter", "Area") as unknown[]);
      const landOrSea = str(dig(hypoArea, "LandOrSea"));
      if (landOrSea) info.landOrSea = landOrSea;
      const accuracy = extractEewAccuracy(earthquake);
      if (accuracy) info.accuracy = accuracy;
    }

    const forecastResult = extractEewForecastAreas(body, specialValueBody);
    const hasPlumArea = forecastResult?.hasPlumArea ?? false;
    if (
      forecastResult
      && (
        forecastResult.areas.length > 0
        || forecastResult.maxIntValue?.presence !== "missing"
        || forecastResult.maxLgIntValue?.presence !== "missing"
      )
    ) {
      info.forecastIntensity = {
        ...(forecastResult.maxInt ? { maxInt: forecastResult.maxInt } : {}),
        maxIntValue: forecastResult.maxIntValue,
        ...(forecastResult.maxLgInt ? { maxLgInt: forecastResult.maxLgInt } : {}),
        maxLgIntValue: forecastResult.maxLgIntValue,
        areas: forecastResult.areas,
      };
    }

    const assumedHypocenterByFallback =
      isAssumedHypocenterFallbackPattern(info.earthquake) &&
      (info.maxIntChangeReason === 9 || hasPlumArea);
    info.isAssumedHypocenter =
      assumedHypocenterByCondition || assumedHypocenterByFallback;

    // isWarning: XML ベース主判定 + classification を安全側フォールバック
    // xmlWarning / classWarning を先に変数化し、判定と観測ログで同じ値を共用する。
    const xmlWarning =
      msg.head.type === "VXSE43" ||
      hasWarningAreaKind(body) ||
      hasWarningHeadlineCode(head);
    const classWarning = msg.classification === "eew.warning";
    info.isWarning = xmlWarning || classWarning;

    // 観測ログ (仕様不整合の検知用):
    // (1) classification=eew.warning だが XML ベース判定で警報条件を検出できない
    // (2) VXSE43 電文なのに classification が eew.warning ではない（契約差分・仕様変更の兆候）
    // 逆方向の一般形 (xmlWarning && !classWarning) は VXSE44/VXSE45 警報相当の正常パターンなのでログしない。
    if (classWarning && !xmlWarning) {
      log.warn(
        `EEW classification=eew.warning だが XML ベース判定で警報条件を検出できず: ` +
        `type=${msg.head.type} EventID=${str(dig(head, "EventID"))}`
      );
    } else if (msg.head.type === "VXSE43" && !classWarning) {
      log.warn(
        `EEW VXSE43 電文だが classification=${msg.classification} (eew.warning ではない): ` +
        `EventID=${str(dig(head, "EventID"))}`
      );
    }

    // NextAdvisory (最終報)
    const nextAdvisory = str(dig(body, "NextAdvisory"));
    if (nextAdvisory) {
      info.nextAdvisory = nextAdvisory.trim();
    }

    if (info.infoType === "取消") {
      const cancelText = str(dig(body, "Text")).trim();
      if (cancelText) info.cancelText = cancelText;
    }

    return info;
  } catch (err) {
    log.error(
      `EEW電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** 津波電文(VTSE41/51/52)をパース */
export function parseTsunamiTelegram(
  msg: WsDataMessage
): ParsedTsunamiInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body, specialValueBody } = base;
    const warningComment = dig(body, "Comments", "WarningComment");
    const warningCommentText = Array.isArray(warningComment)
      ? str(dig(warningComment[0], "Text"))
      : str(dig(warningComment, "Text"));

    const info: ParsedTsunamiInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      warningComment: warningCommentText,
      meta,
      isTest: meta.isTest,
    };

    const tsunami = dig(body, "Tsunami");
    const specialValueTsunami = dig(specialValueBody, "Tsunami");
    const parserDiagnostics = new Set<TsunamiParserDiagnostic>();

    const forecastItems = dig(tsunami, "Forecast", "Item");
    if (Array.isArray(forecastItems)) {
      const forecast: TsunamiForecastItem[] = [];
      const specialForecastItems = listOf(dig(specialValueTsunami, "Forecast", "Item"));
      for (const [itemIndex, item] of forecastItems.entries()) {
        const specialItem = specialForecastItems[itemIndex];
        const area = first(dig(item, "Area") as unknown[]);
        const category = first(dig(item, "Category") as unknown[]);
        const kind = first(dig(category, "Kind") as unknown[]);
        const specialArea = first(dig(specialItem, "Area") as unknown[]);
        const specialCategory = first(dig(specialItem, "Category") as unknown[]);
        const specialKind = first(dig(specialCategory, "Kind") as unknown[]);
        const areaName = str(dig(area, "Name")).trim();
        if (!areaName) {
          continue;
        }
        const areaCode = optionalRawTsunamiCode(specialArea);
        const kindCode = optionalRawTsunamiCode(specialKind);
        const itemDiagnostics: TsunamiParserDiagnostic[] = [];
        const areaDiagnostic = tsunamiCodeDiagnostic(
          areaCode,
          KNOWN_TSUNAMI_FORECAST_AREA_CODES,
          "unknownTsunamiAreaCode",
        );
        if (areaDiagnostic != null) itemDiagnostics.push(areaDiagnostic);
        const kindDiagnostic = tsunamiCodeDiagnostic(
          kindCode,
          KNOWN_TSUNAMI_KIND_CODES,
          "unknownTsunamiKindCode",
        );
        if (kindDiagnostic != null) itemDiagnostics.push(kindDiagnostic);
        for (const diagnostic of itemDiagnostics) parserDiagnostics.add(diagnostic);

        const maxHeight = extractSpecialValue(
          "TsunamiHeight",
          tsunamiHeightNode(specialItem),
        );
        const maxHeightDescription = maxHeight.description == null
          ? ""
          : maxHeight.description.trim();
        const firstHeight =
          str(dig(item, "FirstHeight", "ArrivalTime")) ||
          str(dig(item, "FirstHeight", "Condition"));
        const stationsRaw = dig(item, "Station");
        const stationNodes = Array.isArray(stationsRaw)
          ? stationsRaw
          : stationsRaw
            ? [stationsRaw]
            : [];
        const stations: TsunamiStationItem[] = [];
        for (const station of stationNodes) {
          const stationName = str(dig(station, "Name")).trim();
          if (!stationName) {
            continue;
          }
          stations.push({
            name: stationName,
            highTideDateTime: str(dig(station, "HighTideDateTime")),
            arrivalTime:
              str(dig(station, "FirstHeight", "ArrivalTime")) ||
              str(dig(station, "FirstHeight", "Condition")),
          });
        }
        const kindName = str(dig(kind, "Name"));
        forecast.push({
          areaCode,
          areaName,
          kind: kindName,
          kindCode,
          kindName,
          maxHeight,
          maxHeightDescription,
          firstHeight,
          ...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
          ...(stations.length > 0 ? { stations } : {}),
        });
      }
      if (forecast.length > 0) {
        info.forecast = forecast;
      }
    }

    if (parserDiagnostics.size > 0) {
      info.diagnostics = [...parserDiagnostics];
    }

    const observations = extractTsunamiObservations(tsunami, specialValueTsunami);
    if (observations.length > 0) {
      info.observations = observations;
    }

    const estimations = extractTsunamiEstimations(tsunami);
    if (estimations.length > 0) {
      info.estimations = estimations;
    }

    let earthquake = dig(body, "Earthquake");
    if (Array.isArray(earthquake)) {
      earthquake = earthquake[0];
    }
    if (earthquake) {
      const specialEarthquake = dig(specialValueBody, "Earthquake");
      info.earthquake = extractEarthquake(
        earthquake,
        Array.isArray(specialEarthquake) ? specialEarthquake[0] : specialEarthquake,
      );
    }

    return info;
  } catch (err) {
    log.error(
      `津波電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** 地震活動テキスト電文(VXSE56/VXSE60/VZSE40)をパース */
export function parseSeismicTextTelegram(
  msg: WsDataMessage
): ParsedSeismicTextInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;

    const info: ParsedSeismicTextInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      bodyText: str(dig(body, "Text")),
      meta,
      isTest: meta.isTest,
    };

    return info;
  } catch (err) {
    log.error(
      `地震活動テキスト電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** 南海トラフ関連電文(VYSE50/51/52/VYSE60)をパース */
export function parseNankaiTroughTelegram(
  msg: WsDataMessage
): ParsedNankaiTroughInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;

    const info: ParsedNankaiTroughInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      bodyText: "",
      meta,
      isTest: meta.isTest,
    };

    // EarthquakeInfo がある場合 (通常の発表電文)
    const eqInfo = dig(body, "EarthquakeInfo");
    if (eqInfo) {
      // InfoSerial (VYSE60 には存在しない場合がある)
      const infoSerial = dig(eqInfo, "InfoSerial");
      if (infoSerial) {
        const name = str(dig(infoSerial, "Name"));
        const code = str(dig(infoSerial, "Code"));
        if (name && code) {
          info.infoSerial = { name, code };
        }
      }

      info.bodyText = str(dig(eqInfo, "Text"));
    } else {
      // 取消電文等: Body > Text 直下
      info.bodyText = str(dig(body, "Text"));
    }

    // NextAdvisory
    const nextAdvisory = str(dig(body, "NextAdvisory"));
    if (nextAdvisory) {
      info.nextAdvisory = nextAdvisory.trim();
    }

    return info;
  } catch (err) {
    log.error(
      `南海トラフ関連電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** 長周期地震動観測情報(VXSE62)をパース */
export function parseLgObservationTelegram(
  msg: WsDataMessage
): ParsedLgObservationInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body, specialValueBody } = base;

    const info: ParsedLgObservationInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      maxIntValue: extractSpecialValue("Intensity", undefined),
      maxLgIntValue: extractSpecialValue("LgInt", undefined),
      areas: [],
      meta,
      isTest: meta.isTest,
    };

    // 震源
    let earthquake = dig(body, "Earthquake");
    if (Array.isArray(earthquake)) {
      earthquake = earthquake[0];
    }
    if (earthquake) {
      const specialEarthquake = dig(specialValueBody, "Earthquake");
      info.earthquake = extractEarthquake(
        earthquake,
        Array.isArray(specialEarthquake) ? specialEarthquake[0] : specialEarthquake,
      );
    }

    const lgDetails = extractLgObservationDetails(body, specialValueBody);
    info.maxInt = lgDetails.maxInt;
    info.maxLgInt = lgDetails.maxLgInt;
    info.maxIntValue = lgDetails.maxIntValue;
    info.maxLgIntValue = lgDetails.maxLgIntValue;
    info.lgCategory = lgDetails.lgCategory;
    info.prefs = lgDetails.prefs;
    info.areas = lgDetails.areas;

    // コメント
    const freeComment = str(dig(body, "Comments", "FreeFormComment"));
    if (freeComment) {
      info.comment = freeComment.trim();
    }

    // 詳細URI
    const uri = str(dig(body, "Comments", "URI"));
    if (uri) {
      info.detailUri = uri.trim();
    }

    return info;
  } catch (err) {
    log.error(
      `長周期地震動観測情報パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
