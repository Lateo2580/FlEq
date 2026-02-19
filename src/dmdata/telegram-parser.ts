import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import {
  WsDataMessage,
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
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
    ];
    return arrayTags.includes(name);
  },
});

/** 展開後の最大許容サイズ (10 MB) */
const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024;

/** body フィールドをデコードしてXML文字列を返す */
export function decodeBody(msg: WsDataMessage): string {
  let buf: Buffer;

  if (msg.encoding === "base64") {
    buf = Buffer.from(msg.body, "base64");
  } else {
    buf = Buffer.from(msg.body, "utf-8");
  }

  if (msg.compression === "gzip") {
    buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
  } else if (msg.compression === "zip") {
    buf = zlib.unzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
  }

  if (buf.length > MAX_DECOMPRESSED_SIZE) {
    throw new Error(
      `展開後のサイズが上限を超えています: ${buf.length} bytes (上限: ${MAX_DECOMPRESSED_SIZE} bytes)`
    );
  }

  return buf.toString("utf-8");
}

/** XML文字列をパースしてJSオブジェクトを返す */
export function parseXml(xmlStr: string): Record<string, unknown> {
  return xmlParser.parse(xmlStr);
}

// ── ヘルパー: 安全なプロパティアクセス ──

function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function str(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

function first<T>(val: T | T[]): T {
  return Array.isArray(val) ? val[0] : val;
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
  const coordStr = str(
    dig(area, "jmx_eb:Coordinate", "#text") ||
      dig(area, "Coordinate", "#text") ||
      dig(area, "jmx_eb:Coordinate") ||
      dig(area, "Coordinate")
  );
  const { lat, lon, depth } = parseCoordinate(coordStr);

  const mag = str(
    dig(earthquake, "jmx_eb:Magnitude", "#text") ||
      dig(earthquake, "Magnitude", "#text") ||
      dig(earthquake, "jmx_eb:Magnitude") ||
      dig(earthquake, "Magnitude") ||
      ""
  );

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

// ── 公開API ──

/** 地震関連電文(VXSE51/52/53等)をパース */
export function parseEarthquakeTelegram(
  msg: WsDataMessage
): ParsedEarthquakeInfo | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = parseXml(xmlStr);

    // Report > Body を探す
    const report =
      dig(parsed, "Report") ||
      dig(parsed, "jmx:Report") ||
      dig(parsed, "jmx_seis:Report");

    if (!report) {
      log.debug("Report ノードが見つかりません");
      return null;
    }

    const body = dig(report, "Body");
    const head = dig(report, "Head");

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
    const xmlStr = decodeBody(msg);
    const parsed = parseXml(xmlStr);

    const report =
      dig(parsed, "Report") ||
      dig(parsed, "jmx:Report") ||
      dig(parsed, "jmx_seis:Report");

    if (!report) return null;

    const head = dig(report, "Head");
    const body = dig(report, "Body");

    // 仮定震源要素の検出
    const earthquake = dig(body, "Earthquake");
    const earthquakeCondition = str(dig(earthquake, "Condition"));
    let isAssumedHypocenter = earthquakeCondition.includes("仮定震源要素");

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

    // Appendix: MaxIntChangeReason (Intensity > Forecast > Appendix)
    const maxIntChangeReasonStr = str(
      dig(body, "Intensity", "Forecast", "Appendix", "MaxIntChangeReason")
    );
    if (maxIntChangeReasonStr) {
      const parsed = parseInt(maxIntChangeReasonStr, 10);
      if (!isNaN(parsed)) {
        info.maxIntChangeReason = parsed;
      }
    }

    // 震源
    if (earthquake) {
      info.earthquake = extractEarthquake(earthquake);

      // 仮定震源要素のフォールバック検出: M=1.0 + depth=10km
      if (!isAssumedHypocenter && info.earthquake) {
        const mag = parseFloat(info.earthquake.magnitude);
        const depthMatch = info.earthquake.depth.match(/^(\d+)km$/);
        const depthKm = depthMatch ? parseInt(depthMatch[1], 10) : -1;
        if (mag === 1.0 && depthKm === 10) {
          isAssumedHypocenter = true;
        }
      }
    }
    info.isAssumedHypocenter = isAssumedHypocenter;

    // 予測震度
    const forecast = dig(body, "Intensity", "Forecast");
    if (forecast) {
      // 全体の最大予測長周期地震動階級
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

              // 長周期地震動階級
              const rawLgInt = dig(area, "ForecastLgInt");
              const lgInt = Array.isArray(rawLgInt)
                ? str(dig(rawLgInt[0], "From"))
                : str(dig(rawLgInt, "From"));

              // Condition パース
              const condition = str(dig(area, "Condition"));
              const isPlum = condition.includes("ＰＬＵＭ法で推定") || undefined;
              const hasArrived = condition.includes("既に主要動到達と推測") || undefined;

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
      if (areas.length > 0) {
        info.forecastIntensity = { ...(maxLgInt ? { maxLgInt } : {}), areas };
      }
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

    const head = dig(report, "Head");
    const body = dig(report, "Body");
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

    const rawObservation = dig(tsunami, "Observation");
    const observationsNodes = Array.isArray(rawObservation)
      ? rawObservation
      : rawObservation
        ? [rawObservation]
        : [];
    if (observationsNodes.length > 0) {
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
      if (observations.length > 0) {
        info.observations = observations;
      }
    }

    const rawEstimation = dig(tsunami, "Estimation");
    const estimationNodes = Array.isArray(rawEstimation)
      ? rawEstimation
      : rawEstimation
        ? [rawEstimation]
        : [];
    if (estimationNodes.length > 0) {
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
      if (estimations.length > 0) {
        info.estimations = estimations;
      }
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

/** 地震活動テキスト電文(VXSE56/VXSE60)をパース */
export function parseSeismicTextTelegram(
  msg: WsDataMessage
): ParsedSeismicTextInfo | null {
  try {
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

    const head = dig(report, "Head");
    const body = dig(report, "Body");

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
