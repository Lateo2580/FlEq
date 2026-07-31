import {
  WsDataMessage,
  ParsedEarlyWeatherInfo,
  EarlyWeatherPhenomenon,
  EarlyWeatherBodyText,
  EarlyWeatherArea,
  EarlyWeatherTrend,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf, nodeText } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import { requireTelegramMeta } from "./telegram-ingress";
import * as log from "../logger";

/**
 * 早期天候情報用 XML パーサ。
 * Information / Item / Kind / Areas / Area / Text / MeteorologicalInfo を配列化。
 * parseTagValue:false で Code/Area.Code の先頭ゼロを保持する。
 */
const earlyWeatherXmlParser = createJmxXmlParser((name) => {
  const arrayTags = [
    "Information",
    "MeteorologicalInfo",
    "Item",
    "Kind",
    "Areas",
    "Area",
    "Text",
  ];
  return arrayTags.includes(name);
});

function parseEarlyWeatherXml(xmlStr: string): Record<string, unknown> {
  return earlyWeatherXmlParser.parse(xmlStr);
}

/** 数値変換 (失敗時 null) */
function toNumberOrNull(value: string): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
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

/** Areas/Area の配列から EarlyWeatherArea[] を抽出 */
function extractAreas(item: unknown): EarlyWeatherArea[] {
  const result: EarlyWeatherArea[] = [];
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

/** Headline.Information.Item.Kind.Condition を集約 */
function extractHeadlineConditions(headline: unknown): string[] {
  const conditions: string[] = [];
  const infoRaw = dig(headline, "Information");
  const infoList: unknown[] = Array.isArray(infoRaw)
    ? infoRaw
    : infoRaw != null
    ? [infoRaw]
    : [];
  for (const info of infoList) {
    const itemsRaw = dig(info, "Item");
    const itemList: unknown[] = Array.isArray(itemsRaw)
      ? itemsRaw
      : itemsRaw != null
      ? [itemsRaw]
      : [];
    for (const item of itemList) {
      const kindsRaw = dig(item, "Kind");
      const kindList: unknown[] = Array.isArray(kindsRaw)
        ? kindsRaw
        : kindsRaw != null
        ? [kindsRaw]
        : [];
      for (const k of kindList) {
        const cond = str(dig(k, "Condition"));
        if (cond && !conditions.includes(cond)) conditions.push(cond);
      }
    }
  }
  return conditions;
}

/**
 * Property の ClimateFeaturePart から閾値・確率・trend を抽出する。
 * jmx_eb:SignificantClimateElement の Above/Below 系要素を順に見る。
 */
function extractClimateMetrics(prop: unknown): {
  climateKind: string | null;
  climateText: string | null;
  trend: EarlyWeatherTrend;
  probabilityPercent: number | null;
  thresholdValue: number | null;
  thresholdUnit: string | null;
} {
  const result = {
    climateKind: null as string | null,
    climateText: null as string | null,
    trend: "unknown" as EarlyWeatherTrend,
    probabilityPercent: null as number | null,
    thresholdValue: null as number | null,
    thresholdUnit: null as string | null,
  };
  const featurePart = dig(prop, "ClimateFeaturePart");
  if (featurePart == null) return result;
  const element = dig(featurePart, "jmx_eb:SignificantClimateElement");
  if (element == null) return result;

  result.climateKind = str(dig(element, "@_kind")) || null;
  result.climateText = str(dig(element, "jmx_eb:Text")) || null;

  // Above 系 (高温, 大雪 等)
  const probAbove = dig(element, "jmx_eb:ProbabilityOfSignificantlyAboveNormal");
  const threshAbove = dig(element, "jmx_eb:ThresholdOfSignificantlyAboveNormal");
  if (probAbove != null || threshAbove != null) {
    result.trend = "above";
    const probValue = toNumberOrNull(nodeText(probAbove));
    if (probValue != null) result.probabilityPercent = probValue;
    const thrValue = toNumberOrNull(nodeText(threshAbove));
    if (thrValue != null) result.thresholdValue = thrValue;
    const thrUnit = str(dig(threshAbove, "@_unit"));
    if (thrUnit) result.thresholdUnit = thrUnit;
    return result;
  }

  // Below 系 (低温 等)
  const probBelow = dig(element, "jmx_eb:ProbabilityOfSignificantlyBelowNormal");
  const threshBelow = dig(element, "jmx_eb:ThresholdOfSignificantlyBelowNormal");
  if (probBelow != null || threshBelow != null) {
    result.trend = "below";
    const probValue = toNumberOrNull(nodeText(probBelow));
    if (probValue != null) result.probabilityPercent = probValue;
    const thrValue = toNumberOrNull(nodeText(threshBelow));
    if (thrValue != null) result.thresholdValue = thrValue;
    const thrUnit = str(dig(threshBelow, "@_unit"));
    if (thrUnit) result.thresholdUnit = thrUnit;
  }
  return result;
}

/**
 * Body.MeteorologicalInfos.MeteorologicalInfo から現象群と補足本文を抽出。
 * Item.Kind.Property.Type が "本文" のものは bodyTexts、それ以外は phenomena に振り分ける。
 */
function extractPhenomenaAndBodyTexts(body: unknown): {
  phenomena: EarlyWeatherPhenomenon[];
  bodyTexts: EarlyWeatherBodyText[];
} {
  const phenomena: EarlyWeatherPhenomenon[] = [];
  const bodyTexts: EarlyWeatherBodyText[] = [];
  if (body == null) return { phenomena, bodyTexts };

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
      const periodStartTime = str(dig(info, "DateTime")) || null;
      const periodDuration = str(dig(info, "Duration")) || null;
      const periodLabel = str(dig(info, "Name")) || null;
      const itemsRaw = dig(info, "Item");
      const itemList: unknown[] = Array.isArray(itemsRaw)
        ? itemsRaw
        : itemsRaw != null
        ? [itemsRaw]
        : [];
      for (const item of itemList) {
        const areas = extractAreas(item);
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
            // 本文系は bodyTexts へ
            if (propType === "本文") {
              const text = str(dig(prop, "Text"));
              if (text) bodyTexts.push({ text, areas });
              continue;
            }
            // それ以外は現象として扱う
            const metrics = extractClimateMetrics(prop);
            phenomena.push({
              type: propType,
              climateKind: metrics.climateKind,
              climateText: metrics.climateText,
              trend: metrics.trend,
              probabilityPercent: metrics.probabilityPercent,
              thresholdValue: metrics.thresholdValue,
              thresholdUnit: metrics.thresholdUnit,
              areas,
              periodLabel,
              periodDuration,
              periodStartTime,
            });
          }
        }
      }
    }
  }
  return { phenomena, bodyTexts };
}

/** Body.TargetArea を EarlyWeatherArea として取り出す */
function extractTargetArea(body: unknown): EarlyWeatherArea | null {
  if (body == null) return null;
  const ta = dig(body, "TargetArea");
  if (ta == null) return null;
  const name = str(dig(ta, "Name"));
  const code = nodeText(dig(ta, "Code"));
  if (!name) return null;
  return { name, code };
}

/**
 * 早期天候情報電文 (VPAW51) をパースする。
 * パース失敗時は null を返す。
 */
export function parseEarlyWeather(
  msg: WsDataMessage,
): ParsedEarlyWeatherInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const xmlStr = decodeBody(msg);
    const parsed = parseEarlyWeatherXml(xmlStr);

    const report = dig(parsed, "Report") || dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseEarlyWeather: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    // Head 欠落・必須メタ不足の場合は raw フォールバックに回すため null を返す。
    // 空タイトル・空 infoType のまま通知・統計記録に進めない安全網。
    if (head == null) {
      log.debug("parseEarlyWeather: Head ノードが見つかりません");
      return null;
    }
    const infoType = str(dig(head, "InfoType"));
    const title = str(dig(head, "Title"));
    if (!infoType && !title) {
      log.debug("parseEarlyWeather: Head の必須メタ (InfoType/Title) がありません");
      return null;
    }

    const headline = extractHeadlineText(dig(head, "Headline"));
    const headlineConditions = extractHeadlineConditions(dig(head, "Headline"));
    const { phenomena, bodyTexts } = extractPhenomenaAndBodyTexts(body);
    const targetArea = extractTargetArea(body);

    return {
      type: msg.head.type,
      infoType,
      title,
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      targetDateTime: str(dig(head, "TargetDateTime")) || null,
      targetDuration: str(dig(head, "TargetDuration")) || null,
      validDateTime: str(dig(head, "ValidDateTime")) || null,
      headline,
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      headlineConditions,
      targetArea,
      phenomena,
      bodyTexts,
      meta,
      isTest: meta.isTest,
    };
  } catch (err) {
    log.error(
      `parseEarlyWeather: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
