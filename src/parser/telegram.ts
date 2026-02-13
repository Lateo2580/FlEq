import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import {
  WsDataMessage,
  ParsedEarthquakeInfo,
  ParsedEewInfo,
} from "../types";
import * as log from "../utils/logger";

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
    ];
    return arrayTags.includes(name);
  },
});

/** body フィールドをデコードしてXML文字列を返す */
export function decodeBody(msg: WsDataMessage): string {
  let buf: Buffer;

  if (msg.encoding === "base64") {
    buf = Buffer.from(msg.body, "base64");
  } else {
    buf = Buffer.from(msg.body, "utf-8");
  }

  if (msg.compression === "gzip") {
    buf = zlib.gunzipSync(buf);
  } else if (msg.compression === "zip") {
    buf = zlib.inflateSync(buf);
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
  const area = dig(hypo, "Area");
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

  const observation = dig(intensity, "Observation");
  if (!observation) return undefined;

  const maxInt = str(dig(observation, "MaxInt"));

  const areas: { name: string; intensity: string }[] = [];
  const prefs = dig(observation, "Pref");
  if (Array.isArray(prefs)) {
    for (const pref of prefs) {
      const prefAreas = dig(pref, "Area");
      if (Array.isArray(prefAreas)) {
        for (const area of prefAreas) {
          areas.push({
            name: str(dig(area, "Name")),
            intensity: str(dig(area, "MaxInt")),
          });
        }
      }
    }
  }

  return { maxInt, areas };
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
    };

    // 震源
    const earthquake = dig(body, "Earthquake");
    if (earthquake) {
      info.earthquake = extractEarthquake(earthquake);
    }

    // 予測震度
    const forecast = dig(body, "Intensity", "Forecast");
    if (forecast) {
      const areas: { name: string; intensity: string }[] = [];
      const prefs = dig(forecast, "Pref");
      if (Array.isArray(prefs)) {
        for (const pref of prefs) {
          const prefAreas = dig(pref, "Area");
          if (Array.isArray(prefAreas)) {
            for (const area of prefAreas) {
              const forecastInt = dig(area, "ForecastInt") || dig(area, "ForecastIntFrom");
              areas.push({
                name: str(dig(area, "Name")),
                intensity: str(dig(forecastInt, "From") || forecastInt || ""),
              });
            }
          }
        }
      }
      if (areas.length > 0) {
        info.forecastIntensity = { areas };
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
