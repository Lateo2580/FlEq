import {
  WsDataMessage,
  ParsedWeatherExplanation,
  WeatherExplanationArea,
  WeatherExplanationInformationTag,
  WeatherExplanationSection,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { extractForecast } from "./weather-explanation-forecast";
import { extractObservation } from "./weather-explanation-observation";
import { extractTidal } from "./weather-explanation-tidal";
import { listOf, nodeText } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import { requireTelegramMeta } from "./telegram-ingress";
import * as log from "../logger";

/**
 * 気象解説情報 (地方=VPCJ51 / 全般=VPZJ51) 用 XML パーサ。
 *
 * 配列化対象:
 *   - MeteorologicalInfos / MeteorologicalInfo / Item / Kind / Areas / Area / Text
 *   - Information / Headline (Headline.Information は配列化、内側の Item / Kind も配列化)
 *   - TimeSeriesInfo / TimeDefine / Local (VPZJ51 予想ブロック用)
 * parseTagValue:false で Area.Code の先頭ゼロを保持する。
 */
const weatherExplanationXmlParser = createJmxXmlParser((name) => {
  const arrayTags = [
    "MeteorologicalInfos",
    "MeteorologicalInfo",
    "Item",
    "Kind",
    "Areas",
    "Area",
    "Text",
    "Information",
    "TimeSeriesInfo",
    "TimeDefine",
    "Local",
    // VMCJ53-55 潮位用。Station は追加しない (extractObservation が単一ノード前提)
    "Sequence",
    "TidalLevelPart",
  ];
  return arrayTags.includes(name);
});

function parseWeatherExplanationXml(xmlStr: string): Record<string, unknown> {
  return weatherExplanationXmlParser.parse(xmlStr);
}

/** Headline.Text を抽出 (配列対応、複数 Text の場合は改行連結) */
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

/** Areas / Area の配列から WeatherExplanationArea[] を抽出 */
function extractAreas(parent: unknown): WeatherExplanationArea[] {
  const result: WeatherExplanationArea[] = [];
  const areasRaw = dig(parent, "Areas");
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

/**
 * Headline.Information の Item.Kind.Condition を集約し、
 * 情報タグ (条件 + 対象地域) として返す。
 * Condition は半角または全角スペース区切りで複数キーワードを含みうる
 * (例: "強い冬型 大雪")。`keywords` には split 後の語を入れる。
 *
 * [Codex R1 W1] Headline.Information は `@_type="情報タグ"` を優先採用する。
 * 将来 `type="...別系統"` が混ざったとき、Condition/Areas を巻き込んで
 * バナー・targetAreas・cluster region を汚染しないための防衛。
 * `@_type="情報タグ"` がひとつも無い場合に限り、type 属性に関係なく全件
 * 走査して fallback する (既存電文の互換性確保)。
 */
function extractInformationTags(
  headline: unknown,
): WeatherExplanationInformationTag[] {
  const result: WeatherExplanationInformationTag[] = [];
  if (headline == null) return result;
  const infoRaw = dig(headline, "Information");
  const infoListAll: unknown[] = Array.isArray(infoRaw)
    ? infoRaw
    : infoRaw != null
    ? [infoRaw]
    : [];
  // 第一優先: @_type="情報タグ" のもののみ
  const tagged = infoListAll.filter((node) => {
    if (node == null || typeof node !== "object") return false;
    return str(dig(node, "@_type")) === "情報タグ";
  });
  const infoList = tagged.length > 0 ? tagged : infoListAll;
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
      const areas = extractAreas(item);
      for (const kind of kindList) {
        const kindName = str(dig(kind, "Name"));
        if (kindName === "台風番号" || kindName === "TC番号") continue; // [Codex R1] 台風コードはタグ化しない
        const condition = str(dig(kind, "Condition"));
        if (!condition) continue;
        // 半角・全角スペースで分割。空要素は捨てる。
        const keywords = condition
          .split(/[\s　]+/)
          .map((k) => k.trim())
          .filter((k) => k.length > 0);
        result.push({ condition, keywords, areas });
      }
    }
  }
  return result;
}

/**
 * Body.MeteorologicalInfos の各セクションから本文を抽出する。
 *   - sectionType: MeteorologicalInfos の @_type (例: "概況" / "防災事項" / "付加情報")
 *   - propertyType: Item.Kind.Property.Type (例: "気象概況" / "防災事項" / "補足事項")
 *   - text: Property.Text の本文
 *
 * 同じセクションに複数の MeteorologicalInfo / Item があれば全て積む。
 */
function extractSections(body: unknown): WeatherExplanationSection[] {
  const result: WeatherExplanationSection[] = [];
  if (body == null) return result;
  const infosListRaw = dig(body, "MeteorologicalInfos");
  const infosList: unknown[] = Array.isArray(infosListRaw)
    ? infosListRaw
    : infosListRaw != null
    ? [infosListRaw]
    : [];
  for (const infos of infosList) {
    const sectionType = str(dig(infos, "@_type"));
    const infoListRaw = dig(infos, "MeteorologicalInfo");
    const infoList: unknown[] = Array.isArray(infoListRaw)
      ? infoListRaw
      : infoListRaw != null
      ? [infoListRaw]
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
        for (const kind of kindList) {
          const propList = listOf(dig(kind, "Property"));
          for (const prop of propList) {
            if (prop == null) continue;
            const propertyType = str(dig(prop, "Type"));
            const textRaw = dig(prop, "Text");
            const textList: unknown[] = Array.isArray(textRaw)
              ? textRaw
              : textRaw != null
              ? [textRaw]
              : [];
            for (const t of textList) {
              if (t == null) continue;
              let textType: string | null = null;
              let body = "";
              if (typeof t === "object") {
                textType = str(dig(t, "@_type")) || null;
                body = str(dig(t, "#text"));
              } else {
                body = str(t);
              }
              if (!body) continue;
              result.push({ sectionType, propertyType, textType, text: body });
            }
          }
        }
      }
    }
  }
  return result;
}

/**
 * 気象解説情報電文 (地方=VPCJ51 / 全般=VPZJ51) をパースする。
 * パース失敗時は null を返す。
 *
 * 必須メタ:
 *   - Head が存在し、かつ InfoType と Title の両方が空でないこと
 *     (VPZI50 R1 教訓: 片方欠落でも null を返さないと取消判定不能・通知タイトル空を招く)
 */
export function parseWeatherExplanation(
  msg: WsDataMessage,
): ParsedWeatherExplanation | null {
  try {
    const meta = requireTelegramMeta(msg);
    const xmlStr = decodeBody(msg);
    const parsed = parseWeatherExplanationXml(xmlStr);

    const report = dig(parsed, "Report") || dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseWeatherExplanation: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    if (head == null) {
      log.debug("parseWeatherExplanation: Head ノードが見つかりません");
      return null;
    }
    const infoType = str(dig(head, "InfoType"));
    const title = str(dig(head, "Title"));
    if (!infoType) {
      log.debug("parseWeatherExplanation: Head.InfoType が欠落しています");
      return null;
    }
    if (!title) {
      log.debug("parseWeatherExplanation: Head.Title が欠落しています");
      return null;
    }

    const headlineNode = dig(head, "Headline");
    const headline = extractHeadlineText(headlineNode);
    const informationTags = extractInformationTags(headlineNode);
    // 対象地域は情報タグの Areas を平坦化 (重複は Code でユニーク化)
    const targetAreas: WeatherExplanationArea[] = [];
    for (const tag of informationTags) {
      for (const a of tag.areas) {
        if (!targetAreas.some((t) => t.code === a.code)) {
          targetAreas.push(a);
        }
      }
    }
    const sections = extractSections(body);

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
      informationTags,
      targetAreas,
      sections,
      forecast: extractForecast(body),
      observation: extractObservation(body),
      tidal: extractTidal(body),
      meta,
      isTest: meta.isTest,
    };
  } catch (err) {
    log.error(
      `parseWeatherExplanation: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
