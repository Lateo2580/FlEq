import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import {
  WsDataMessage,
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  LgObservationArea,
  TsunamiForecastItem,
  TsunamiObservationStation,
  TsunamiEstimationItem,
} from "../types";
import * as log from "../logger";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => {
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
  },
});

/** 展開後の最大許容サイズ (10 MB) */
const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

/** body フィールドをデコードしてXML文字列を返す */
export function decodeBody(msg: WsDataMessage): string {
  let buf: Buffer;

  if (msg.encoding === "base64") {
    buf = Buffer.from(msg.body, "base64");
  } else {
    buf = Buffer.from(msg.body, "utf-8");
  }

  if (msg.compression === "gzip") {
    buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } else if (msg.compression === "zip") {
    buf = zlib.unzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  }

  if (buf.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error(
      `展開後のサイズが上限を超えています: ${buf.length} bytes (上限: ${MAX_DECOMPRESSED_BYTES} bytes)`
    );
  }

  return buf.toString("utf-8");
}

/** XML文字列をパースしてJSオブジェクトを返す */
export function parseXml(xmlStr: string): Record<string, unknown> {
  return xmlParser.parse(xmlStr);
}

// ── ヘルパー: 安全なプロパティアクセス ──

export function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function str(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

export function first<T>(val: T | T[]): T {
  return Array.isArray(val) ? val[0] : val;
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
  earthquake: unknown
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
  const coordStr = str(
    coordNode != null && typeof coordNode === "object"
      ? dig(coordNode, "#text")
      : coordNode
  );
  const { lat, lon, depth } = parseCoordinate(coordStr);

  const magRaw = str(
    dig(earthquake, "jmx_eb:Magnitude", "#text") ||
      dig(earthquake, "Magnitude", "#text") ||
      dig(earthquake, "jmx_eb:Magnitude") ||
      dig(earthquake, "Magnitude") ||
      ""
  );
  // "4" → "4.0" のように小数点第1位を保証する
  const mag = magRaw && !isNaN(parseFloat(magRaw))
    ? parseFloat(magRaw).toFixed(1)
    : magRaw;

  return {
    originTime,
    hypocenterName: name,
    latitude: lat,
    longitude: lon,
    depth,
    magnitude: mag,
  };
}

/** 座標文字列をパース: "+35.7+139.8-10000/" → lat, lon, depth */
function parseCoordinate(coord: string): {
  lat: string;
  lon: string;
  depth: string;
} {
  if (!coord) return { lat: "", lon: "", depth: "" };

  // 形式: "+緯度+経度-深さ/" or "+緯度+経度/"
  const match = coord.match(
    /([+-][\d.]+)([+-][\d.]+)(?:([+-][\d.]+))?/
  );
  if (!match) return { lat: "", lon: "", depth: "" };

  const latNum = parseFloat(match[1]);
  const lonNum = parseFloat(match[2]);
  const depthNum = match[3] ? Math.abs(parseFloat(match[3])) : 0;

  // 深さはメートル単位で来る場合とキロメートル単位で来る場合がある
  const depthKm = depthNum >= 1000 ? depthNum / 1000 : depthNum;

  return {
    lat: `${latNum >= 0 ? "N" : "S"}${Math.abs(latNum).toFixed(1)}`,
    lon: `${lonNum >= 0 ? "E" : "W"}${Math.abs(lonNum).toFixed(1)}`,
    depth: depthKm > 0 ? `${depthKm}km` : "ごく浅い",
  };
}

/** 震度観測地域を抽出 */
function extractIntensity(
  body: unknown
): ParsedEarthquakeInfo["intensity"] | undefined {
  const intensity = dig(body, "Intensity");
  if (!intensity) return undefined;

  const rawObservation = dig(intensity, "Observation");
  if (!rawObservation) return undefined;
  const observation = first(rawObservation as unknown[]);

  const maxInt = str(dig(observation, "MaxInt"));
  const maxLgIntRaw = str(dig(observation, "MaxLgInt"));
  const maxLgInt = maxLgIntRaw || undefined;

  const areas: { name: string; intensity: string; lgIntensity?: string }[] = [];
  const prefs = dig(observation, "Pref");
  if (Array.isArray(prefs)) {
    for (const pref of prefs) {
      const prefAreas = dig(pref, "Area");
      if (Array.isArray(prefAreas)) {
        for (const area of prefAreas) {
          const lgInt = str(dig(area, "MaxLgInt"));
          areas.push({
            name: str(dig(area, "Name")),
            intensity: str(dig(area, "MaxInt")),
            ...(lgInt ? { lgIntensity: lgInt } : {}),
          });
        }
      }
    }
  }

  return { maxInt, ...(maxLgInt ? { maxLgInt } : {}), areas };
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

function parseMaxIntChangeReason(body: unknown): number | undefined {
  const raw = str(dig(body, "Intensity", "Forecast", "Appendix", "MaxIntChangeReason"));
  if (!raw) return undefined;
  const code = Number.parseInt(raw, 10);
  return Number.isNaN(code) ? undefined : code;
}

function extractEewForecastAreas(
  body: unknown
): {
  areas: { name: string; intensity: string; lgIntensity?: string; isPlum?: boolean; hasArrived?: boolean }[];
  maxLgInt?: string;
  hasPlumArea: boolean;
} | undefined {
  const forecast = dig(body, "Intensity", "Forecast");
  if (!forecast) return undefined;

  const overallLgInt = dig(forecast, "ForecastLgInt");
  const overallLgIntFrom = str(
    Array.isArray(overallLgInt)
      ? dig(overallLgInt[0], "From")
      : dig(overallLgInt, "From")
  );
  const maxLgInt = overallLgIntFrom || undefined;

  const areas: {
    name: string;
    intensity: string;
    lgIntensity?: string;
    isPlum?: boolean;
    hasArrived?: boolean;
  }[] = [];
  const prefs = dig(forecast, "Pref");
  if (Array.isArray(prefs)) {
    for (const pref of prefs) {
      const prefAreas = dig(pref, "Area");
      if (Array.isArray(prefAreas)) {
        for (const area of prefAreas) {
          const rawForecastInt = dig(area, "ForecastInt") || dig(area, "ForecastIntFrom");
          const forecastInt = Array.isArray(rawForecastInt) ? rawForecastInt[0] : rawForecastInt;

          const rawLgInt = dig(area, "ForecastLgInt");
          const lgInt = Array.isArray(rawLgInt)
            ? str(dig(rawLgInt[0], "From"))
            : str(dig(rawLgInt, "From"));

          const condition = str(dig(area, "Condition"));
          const isPlum = isPlumAreaCondition(condition) || undefined;
          const hasArrived = hasArrivedAreaCondition(condition) || undefined;

          areas.push({
            name: str(dig(area, "Name")),
            intensity: str(dig(forecastInt, "From") || forecastInt || ""),
            ...(lgInt ? { lgIntensity: lgInt } : {}),
            ...(isPlum ? { isPlum } : {}),
            ...(hasArrived ? { hasArrived } : {}),
          });
        }
      }
    }
  }

  const hasPlumArea = areas.some((a) => a.isPlum === true);
  return { areas, maxLgInt, hasPlumArea };
}

// ── 津波ヘルパー ──

function extractTsunamiObservations(tsunamiNode: unknown): TsunamiObservationStation[] {
  const rawObservation = dig(tsunamiNode, "Observation");
  const observationsNodes = Array.isArray(rawObservation)
    ? rawObservation
    : rawObservation
      ? [rawObservation]
      : [];

  const observations: TsunamiObservationStation[] = [];
  for (const node of observationsNodes) {
    const items = dig(node, "Item");
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      const stationsRaw = dig(item, "Station");
      const stations = Array.isArray(stationsRaw)
        ? stationsRaw
        : stationsRaw
          ? [stationsRaw]
          : [];
      for (const station of stations) {
        observations.push({
          name: str(dig(station, "Name")),
          sensor: str(dig(station, "Sensor")),
          arrivalTime: str(dig(station, "FirstHeight", "ArrivalTime")),
          initial: str(dig(station, "FirstHeight", "Initial")),
          maxHeightCondition: str(dig(station, "MaxHeight", "Condition")),
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

function extractLgObservationDetails(body: unknown): {
  maxInt?: string;
  maxLgInt?: string;
  lgCategory?: string;
  areas: LgObservationArea[];
} {
  const result: {
    maxInt?: string;
    maxLgInt?: string;
    lgCategory?: string;
    areas: LgObservationArea[];
  } = { areas: [] };

  const intensity = dig(body, "Intensity");
  if (!intensity) return result;

  const rawObservation = dig(intensity, "Observation");
  if (!rawObservation) return result;

  const observation = first(rawObservation as unknown[]);
  result.maxInt = str(dig(observation, "MaxInt")) || undefined;
  result.maxLgInt = str(dig(observation, "MaxLgInt")) || undefined;
  result.lgCategory = str(dig(observation, "LgCategory")) || undefined;

  const prefs = dig(observation, "Pref");
  if (Array.isArray(prefs)) {
    for (const pref of prefs) {
      const prefAreas = dig(pref, "Area");
      if (Array.isArray(prefAreas)) {
        for (const area of prefAreas) {
          const areaMaxInt = str(dig(area, "MaxInt"));
          const areaMaxLgInt = str(dig(area, "MaxLgInt"));
          if (areaMaxLgInt) {
            result.areas.push({
              name: str(dig(area, "Name")),
              maxInt: areaMaxInt,
              maxLgInt: areaMaxLgInt,
            });
          }
        }
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

  return {
    report,
    head: dig(report, "Head"),
    body: dig(report, "Body"),
  };
}

// ── 公開API ──

/** 地震関連電文(VXSE51/52/53等)をパース */
export function parseEarthquakeTelegram(
  msg: WsDataMessage
): ParsedEarthquakeInfo | null {
  try {
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;

    const info: ParsedEarthquakeInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      isTest: msg.head.test,
    };

    // 震源
    // Earthquakeノードの取得（配列の場合は先頭を使用）
    let earthquake = dig(body, "Earthquake");
    if (Array.isArray(earthquake)) {
      earthquake = earthquake[0];
    }
    if (earthquake) {
      info.earthquake = extractEarthquake(earthquake);
    }

    // 震度
    info.intensity = extractIntensity(body);

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
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;

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
      isTest: msg.head.test,
      isWarning: msg.classification === "eew.warning",
      isAssumedHypocenter: false,
    };

    info.maxIntChangeReason = parseMaxIntChangeReason(body);

    if (earthquake) {
      info.earthquake = extractEarthquake(earthquake);
    }

    const forecastResult = extractEewForecastAreas(body);
    const hasPlumArea = forecastResult?.hasPlumArea ?? false;
    if (forecastResult && forecastResult.areas.length > 0) {
      info.forecastIntensity = {
        ...(forecastResult.maxLgInt ? { maxLgInt: forecastResult.maxLgInt } : {}),
        areas: forecastResult.areas,
      };
    }

    const assumedHypocenterByFallback =
      isAssumedHypocenterFallbackPattern(info.earthquake) &&
      (info.maxIntChangeReason === 9 || hasPlumArea);
    info.isAssumedHypocenter =
      assumedHypocenterByCondition || assumedHypocenterByFallback;

    // NextAdvisory (最終報)
    const nextAdvisory = str(dig(body, "NextAdvisory"));
    if (nextAdvisory) {
      info.nextAdvisory = nextAdvisory.trim();
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
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;
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
      isTest: msg.head.test,
    };

    const tsunami = dig(body, "Tsunami");

    const forecastItems = dig(tsunami, "Forecast", "Item");
    if (Array.isArray(forecastItems)) {
      const forecast: TsunamiForecastItem[] = [];
      for (const item of forecastItems) {
        const area = first(dig(item, "Area") as unknown[]);
        const category = first(dig(item, "Category") as unknown[]);
        const kind = first(dig(category, "Kind") as unknown[]);
        const areaName = str(dig(area, "Name")).trim();
        if (!areaName) {
          continue;
        }
        const maxHeightDescription =
          str(dig(item, "MaxHeight", "jmx_eb:TsunamiHeight", "@_description")) ||
          str(dig(item, "MaxHeight", "TsunamiHeight", "@_description"));
        const firstHeight =
          str(dig(item, "FirstHeight", "ArrivalTime")) ||
          str(dig(item, "FirstHeight", "Condition"));
        forecast.push({
          areaName,
          kind: str(dig(kind, "Name")),
          maxHeightDescription,
          firstHeight,
        });
      }
      if (forecast.length > 0) {
        info.forecast = forecast;
      }
    }

    const observations = extractTsunamiObservations(tsunami);
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
      info.earthquake = extractEarthquake(earthquake);
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
      isTest: msg.head.test,
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
      isTest: msg.head.test,
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
    const base = extractBaseReport(msg);
    if (!base) return null;
    const { head, body } = base;

    const info: ParsedLgObservationInfo = {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline: str(dig(head, "Headline", "Text")) || null,
      publishingOffice: msg.xmlReport?.control?.publishingOffice || "",
      areas: [],
      isTest: msg.head.test,
    };

    // 震源
    let earthquake = dig(body, "Earthquake");
    if (Array.isArray(earthquake)) {
      earthquake = earthquake[0];
    }
    if (earthquake) {
      info.earthquake = extractEarthquake(earthquake);
    }

    const lgDetails = extractLgObservationDetails(body);
    info.maxInt = lgDetails.maxInt;
    info.maxLgInt = lgDetails.maxLgInt;
    info.lgCategory = lgDetails.lgCategory;
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
