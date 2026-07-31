import {
  WsDataMessage,
  ParsedClimateInfo,
  ClimateArea,
  ClimateBodyText,
  ClimateSeasonEvent,
  ClimateStationValue,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf, nodeText } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import { requireTelegramMeta } from "./telegram-ingress";
import * as log from "../logger";

/**
 * 全般天候情報用 XML パーサ。
 * MeteorologicalInfos / MeteorologicalInfo / Item / Kind / Areas / Area / Text / ClimateValuesPart を配列化。
 * parseTagValue:false で Code/Area.Code の先頭ゼロを保持する。
 */
const climateInfoXmlParser = createJmxXmlParser((name) => {
  const arrayTags = [
    "MeteorologicalInfos",
    "MeteorologicalInfo",
    "Item",
    "Kind",
    "Areas",
    "Area",
    "Text",
    "ClimateValuesPart",
  ];
  return arrayTags.includes(name);
});

function parseClimateInfoXml(xmlStr: string): Record<string, unknown> {
  return climateInfoXmlParser.parse(xmlStr);
}

/**
 * 数値変換 (失敗時 null)。"+1.6" や "−0.5" のような符号付き表記にも対応する。
 * 「－」(全角マイナス) / "−" (U+2212) / 半角 "-" を統一して扱う。
 */
function toNumberOrNull(value: string): number | null {
  if (!value) return null;
  const normalized = value
    .replace(/[＋]/g, "+")
    .replace(/[−－]/g, "-")
    .trim();
  if (normalized.length === 0) return null;
  const n = parseFloat(normalized);
  return Number.isNaN(n) ? null : n;
}

/** Headline.Text を抽出 (配列対応) */
function extractHeadlineText(headline: unknown): string | null {
  if (headline == null) return null;
  const textRaw = dig(headline, "Text");
  const list: unknown[] = Array.isArray(textRaw)
    ? textRaw
    : textRaw != null
    ? [textRaw]
    : [];
  const parts: string[] = [];
  for (const t of list) {
    if (t == null) continue;
    if (typeof t === "object") {
      const inner = str(dig(t, "#text"));
      if (inner) parts.push(inner);
    } else {
      const s = str(t);
      if (s) parts.push(s);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

/** Areas/Area の配列から ClimateArea[] を抽出 */
function extractAreas(item: unknown): ClimateArea[] {
  const result: ClimateArea[] = [];
  const areasRaw = dig(item, "Areas");
  const areasList: unknown[] = Array.isArray(areasRaw)
    ? areasRaw
    : areasRaw != null
    ? [areasRaw]
    : [];
  for (const areasNode of areasList) {
    const areaListRaw = dig(areasNode, "Area");
    const areaList: unknown[] = Array.isArray(areaListRaw)
      ? areaListRaw
      : areaListRaw != null
      ? [areaListRaw]
      : [];
    for (const area of areaList) {
      const name = str(dig(area, "Name"));
      const code = nodeText(dig(area, "Code"));
      if (name && !result.some((a) => a.code === code)) {
        result.push({ name, code });
      }
    }
  }
  return result;
}

/** Body.TargetArea を ClimateArea として取り出す */
function extractTargetArea(body: unknown): ClimateArea | null {
  if (body == null) return null;
  const ta = dig(body, "TargetArea");
  if (ta == null) return null;
  const name = str(dig(ta, "Name"));
  const code = nodeText(dig(ta, "Code"));
  if (!name) return null;
  return { name, code };
}

/**
 * Property.Type="本文" の Text 群を抽出し ClimateBodyText[] に変換する。
 * Text は type 属性 (概況/今後の見通し/防災事項) で区別される。
 */
function extractBodyTextsFromProperty(
  prop: unknown,
  areas: ClimateArea[],
  periodLabel: string | null,
): ClimateBodyText[] {
  const result: ClimateBodyText[] = [];
  const textRaw = dig(prop, "Text");
  const list: unknown[] = Array.isArray(textRaw)
    ? textRaw
    : textRaw != null
    ? [textRaw]
    : [];
  for (const t of list) {
    if (t == null) continue;
    if (typeof t === "object") {
      const textType = str(dig(t, "@_type")) || null;
      const text = str(dig(t, "#text"));
      if (text) result.push({ textType, text, areas, periodLabel });
    } else {
      const text = str(t);
      if (text) result.push({ textType: null, text, areas, periodLabel });
    }
  }
  return result;
}

/**
 * ClimateValuesPart 配列から平均気温/降水量と平年差/比/平年値を抽出する。
 * Comparison の type 属性で「平均気温平年差」「総降水量平年比」を判別。
 * Temperature / Precipitation は type 違いの兄弟要素として実測値と平年値が
 * 並ぶことがある (例: 30_02 VPCI50 の type="降水量" / "降水量日別平滑平年値合計")
 * ため配列対応し、type に「平年値」を含む方を平年値側へ振り分ける。
 */
function extractClimateValues(prop: unknown): {
  temperatureCelsius: number | null;
  temperatureAnomalyCelsius: number | null;
  temperatureNormalCelsius: number | null;
  precipitationMm: number | null;
  precipitationAnomalyPercent: number | null;
  precipitationNormalMm: number | null;
} {
  const result = {
    temperatureCelsius: null as number | null,
    temperatureAnomalyCelsius: null as number | null,
    temperatureNormalCelsius: null as number | null,
    precipitationMm: null as number | null,
    precipitationAnomalyPercent: null as number | null,
    precipitationNormalMm: null as number | null,
  };
  const partsRaw = dig(prop, "ClimateValuesPart");
  const parts: unknown[] = Array.isArray(partsRaw)
    ? partsRaw
    : partsRaw != null
    ? [partsRaw]
    : [];
  for (const part of parts) {
    const partType = str(dig(part, "@_type"));
    // 平均気温 (実測 / 平年値の兄弟ペアに対応)
    for (const temp of listOf(dig(part, "jmx_eb:Temperature"))) {
      const v = toNumberOrNull(nodeText(temp));
      if (v == null) continue;
      const tempType = str(dig(temp, "@_type"));
      if (tempType.includes("平年値")) {
        result.temperatureNormalCelsius = v;
      } else {
        result.temperatureCelsius = v;
      }
    }
    // 降水量 (実測 / 平年値の兄弟ペアに対応)
    for (const precip of listOf(dig(part, "jmx_eb:Precipitation"))) {
      const v = toNumberOrNull(nodeText(precip));
      if (v == null) continue;
      const precipType = str(dig(precip, "@_type"));
      if (precipType.includes("平年値")) {
        result.precipitationNormalMm = v;
      } else {
        result.precipitationMm = v;
      }
    }
    // Comparison (平年差 or 平年比) を抽出。
    // [Codex R1 W2] Comparison の @_type を最優先で見る。
    // @_type が無いときだけ partType (ClimateValuesPart.@_type) にフォールバック。
    // 以前は両者を OR していたため、矛盾入力時に誤フィールドへ格納し得た。
    const comp = dig(part, "jmx_eb:Comparison");
    if (comp != null) {
      const compType = str(dig(comp, "@_type"));
      const v = toNumberOrNull(nodeText(comp));
      if (v != null) {
        const judgeSource = compType !== "" ? compType : partType;
        if (judgeSource.includes("平年差")) {
          result.temperatureAnomalyCelsius = v;
        } else if (judgeSource.includes("平年比")) {
          result.precipitationAnomalyPercent = v;
        }
      }
    }
  }
  return result;
}

/** EventDatePart の子要素 (Date/Normal/LastYear) から description と dubious を取り出す */
function eventDateAttr(
  node: unknown,
): { description: string | null; dubious: string | null } {
  if (node == null) return { description: null, dubious: null };
  return {
    description: str(dig(node, "@_description")) || null,
    dubious: str(dig(node, "@_dubious")) || null,
  };
}

/**
 * Station 要素から観測点名・コードを取り出す。
 * Code は属性 type="国際地点番号" を持つ。
 */
function extractStation(item: unknown): { name: string; code: string } | null {
  const station = dig(item, "Station");
  if (station == null) return null;
  const name = str(dig(station, "Name"));
  const code = nodeText(dig(station, "Code"));
  if (!name) return null;
  return { name, code };
}

/**
 * Body.MeteorologicalInfos を走査し、bodyTexts / stations / seasonEvents に振り分ける。
 *   - Property.Type === "本文" → bodyTexts
 *   - Property に EventDatePart (梅雨入り/明け等。VPCI50 のみ) → seasonEvents
 *   - Property.Type === "天候の状況（速報値）" など + Station + ClimateValuesPart → stations
 *   - 表題のみの行 (ClimateValuesPart も Station も無い) はスキップ
 */
function extractBodyContents(body: unknown): {
  bodyTexts: ClimateBodyText[];
  stations: ClimateStationValue[];
  seasonEvents: ClimateSeasonEvent[];
} {
  const bodyTexts: ClimateBodyText[] = [];
  const stations: ClimateStationValue[] = [];
  const seasonEvents: ClimateSeasonEvent[] = [];
  if (body == null) return { bodyTexts, stations, seasonEvents };

  const infosRaw = dig(body, "MeteorologicalInfos");
  const infosList: unknown[] = Array.isArray(infosRaw)
    ? infosRaw
    : infosRaw != null
    ? [infosRaw]
    : [];

  for (const infos of infosList) {
    const infoListRaw = dig(infos, "MeteorologicalInfo");
    const infoList: unknown[] = Array.isArray(infoListRaw)
      ? infoListRaw
      : infoListRaw != null
      ? [infoListRaw]
      : [];
    for (const info of infoList) {
      const periodLabel = str(dig(info, "Name")) || null;
      const itemsRaw = dig(info, "Item");
      const itemList: unknown[] = Array.isArray(itemsRaw)
        ? itemsRaw
        : itemsRaw != null
        ? [itemsRaw]
        : [];
      for (const item of itemList) {
        const areas = extractAreas(item);
        const station = extractStation(item);
        const kindsRaw = dig(item, "Kind");
        const kindList: unknown[] = Array.isArray(kindsRaw)
          ? kindsRaw
          : kindsRaw != null
          ? [kindsRaw]
          : [];
        for (const kind of kindList) {
          for (const prop of listOf(dig(kind, "Property"))) {
            if (prop == null) continue;
            const propType = str(dig(prop, "Type"));
            if (propType === "本文") {
              bodyTexts.push(
                ...extractBodyTextsFromProperty(prop, areas, periodLabel),
              );
              continue;
            }
            // EventDatePart (梅雨入り/明け等の季節イベント)。VPCI50 のみ出現
            const eventDatePart = dig(prop, "EventDatePart");
            if (eventDatePart != null) {
              const date = eventDateAttr(dig(eventDatePart, "Date"));
              const normal = eventDateAttr(dig(eventDatePart, "Normal"));
              const lastYear = eventDateAttr(dig(eventDatePart, "LastYear"));
              seasonEvents.push({
                eventType: propType,
                dateDescription: date.description,
                dateDubious: date.dubious,
                normalDescription: normal.description,
                normalDubious: normal.dubious,
                lastYearDescription: lastYear.description,
                lastYearDubious: lastYear.dubious,
                areas,
              });
              continue;
            }
            // 観測点ベース (天候の状況（速報値）など)
            if (station != null) {
              // ClimateValuesPart 系がある場合のみ stations に積む
              // (「表題」だけの Item は ClimateValuesPart を持たないため自動でスキップされる)
              const valuesPart = dig(prop, "ClimateValuesPart");
              if (valuesPart == null) continue;
              const values = extractClimateValues(prop);
              stations.push({
                stationName: station.name,
                stationCode: station.code,
                temperatureCelsius: values.temperatureCelsius,
                temperatureAnomalyCelsius: values.temperatureAnomalyCelsius,
                temperatureNormalCelsius: values.temperatureNormalCelsius,
                precipitationMm: values.precipitationMm,
                precipitationAnomalyPercent: values.precipitationAnomalyPercent,
                precipitationNormalMm: values.precipitationNormalMm,
                periodLabel,
              });
            }
          }
        }
      }
    }
  }
  return { bodyTexts, stations, seasonEvents };
}

/** Body.Comment の末文 (Text type="末文") を抽出 */
function extractComment(body: unknown): string | null {
  if (body == null) return null;
  const comment = dig(body, "Comment");
  if (comment == null) return null;
  const textRaw = dig(comment, "Text");
  // Comment.Text は配列化されないことがあるため両対応
  const list: unknown[] = Array.isArray(textRaw)
    ? textRaw
    : textRaw != null
    ? [textRaw]
    : [];
  const parts: string[] = [];
  for (const t of list) {
    if (t == null) continue;
    if (typeof t === "object") {
      const inner = str(dig(t, "#text"));
      if (inner) parts.push(inner);
    } else {
      const s = str(t);
      if (s) parts.push(s);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

/**
 * 天候情報電文 (VPZI50 全般 / VPCI50 地方) をパースする。
 * パース失敗時は null を返す。
 */
export function parseClimateInfo(
  msg: WsDataMessage,
): ParsedClimateInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const xmlStr = decodeBody(msg);
    const parsed = parseClimateInfoXml(xmlStr);

    const report = dig(parsed, "Report") || dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseClimateInfo: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    // Head 欠落 / 必須メタ完全空時は null を返して raw フォールバックに回す。
    if (head == null) {
      log.debug("parseClimateInfo: Head ノードが見つかりません");
      return null;
    }
    const infoType = str(dig(head, "InfoType"));
    const title = str(dig(head, "Title"));
    // [Codex R1 W1] InfoType / Title はそれぞれ必須扱い。
    // 片方だけ欠落しても通すと、取消判定不能 (InfoType 空) / 通知タイトル空 (Title 空) を招く。
    if (!infoType) {
      log.debug("parseClimateInfo: Head.InfoType が欠落しています");
      return null;
    }
    if (!title) {
      log.debug("parseClimateInfo: Head.Title が欠落しています");
      return null;
    }

    const headline = extractHeadlineText(dig(head, "Headline"));
    const targetArea = extractTargetArea(body);
    const { bodyTexts, stations, seasonEvents } = extractBodyContents(body);
    const comment = extractComment(body);

    return {
      type: msg.head.type,
      infoType,
      title,
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      targetDateTime: str(dig(head, "TargetDateTime")) || null,
      validDateTime: str(dig(head, "ValidDateTime")) || null,
      headline,
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      targetArea,
      bodyTexts,
      stations,
      seasonEvents,
      comment,
      meta,
      isTest: meta.isTest,
    };
  } catch (err) {
    log.error(
      `parseClimateInfo: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
