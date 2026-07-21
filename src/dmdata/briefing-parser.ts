import {
  WsDataMessage,
  ParsedWeatherBriefing,
  WeatherBriefingTag,
  WeatherObservation,
  BriefingTargetArea,
  BriefingSeverityEvidence,
  DisplaySeverity,
  SoundLevel,
} from "../types";
import {
  resolveBriefingSeverity,
  BriefingConditionOrigin,
  DISPLAY_SEVERITY_RANK,
  SOUND_LEVEL_RANK,
} from "./weather-warning-level";
import { decodeBody, dig, str, first } from "./telegram-parser";
import { listOf, nodeText } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import * as log from "../logger";

/**
 * 気象防災速報用 XML パーサ。
 * MeteorologicalInfo / Item / Areas / Area / Text を必ず配列として扱う。
 * parseTagValue:false で Code/Area.Code の先頭ゼロを保持する。
 */
const briefingXmlParser = createJmxXmlParser((name) => {
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

function parseBriefingXml(xmlStr: string): Record<string, unknown> {
  return briefingXmlParser.parse(xmlStr);
}

/**
 * Condition (原文) から WeatherBriefingTag を導出する。
 * NFKC 正規化後、明示的な語句から順にマッチさせる。
 */
export function deriveBriefingTag(condition: string): WeatherBriefingTag {
  const c = condition.normalize("NFKC");
  // 順序付きテーブル: 限定語句から汎用語句の順
  const TABLE: { keywords: string[]; tag: WeatherBriefingTag }[] = [
    { keywords: ["線状降水帯", "直前"], tag: "linearRainPredicted" },
    { keywords: ["線状降水帯", "予測"], tag: "linearRainPredicted" },
    { keywords: ["線状降水帯"], tag: "linearRainObserved" },
    { keywords: ["記録的短時間大雨"], tag: "recordRain" },
    { keywords: ["記録雨"], tag: "recordRain" },
    { keywords: ["短時間大雪"], tag: "shortSnow" },
  ];
  for (const row of TABLE) {
    if (row.keywords.every((k) => c.includes(k))) return row.tag;
  }
  return "other";
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

/**
 * Headline.Information の Item から全 Condition と TargetAreas を抽出する。
 * VPBS50 では Information type="情報タグ" の Item.Kind.Condition が中核情報。
 *
 * Phase D 集合ベース化: 先頭 1 件だけでなく全 Condition を出自 (情報タグ / fallback)
 * つきで収集する。先頭 Kind が軽い条件 (短時間大雪) でも後続の重い条件 (記録雨) が
 * 沈まないよう、parseWeatherBriefing 側で集合の max を取る。重複 Condition は除去。
 */
function extractConditions(
  headline: unknown,
): {
  conditions: { condition: string; origin: BriefingConditionOrigin }[];
  targetAreas: BriefingTargetArea[];
} {
  const conditions: { condition: string; origin: BriefingConditionOrigin }[] = [];
  const targetAreas: BriefingTargetArea[] = [];
  const seen = new Set<string>();
  const infoRaw = dig(headline, "Information");
  const infoList: unknown[] = Array.isArray(infoRaw)
    ? infoRaw
    : infoRaw != null
    ? [infoRaw]
    : [];

  // 優先順: 情報タグ → その他 (Phase D: 全 Condition を出自つきで収集)
  const ordered: { info: unknown; origin: BriefingConditionOrigin }[] = [
    ...infoList
      .filter((info) => str(dig(info, "@_type")) === "情報タグ")
      .map((info) => ({ info, origin: "tagInformation" as const })),
    ...infoList
      .filter((info) => str(dig(info, "@_type")) !== "情報タグ")
      .map((info) => ({ info, origin: "fallback" as const })),
  ];

  for (const { info, origin } of ordered) {
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
        if (cond && !seen.has(cond)) {
          seen.add(cond);
          conditions.push({ condition: cond, origin });
        }
      }
      const areasRaw = dig(item, "Areas");
      const areasNodes: unknown[] = Array.isArray(areasRaw)
        ? areasRaw
        : areasRaw != null
        ? [areasRaw]
        : [];
      for (const areasNode of areasNodes) {
        const areaListRaw = dig(areasNode, "Area");
        const areaList: unknown[] = Array.isArray(areaListRaw)
          ? areaListRaw
          : areaListRaw != null
          ? [areaListRaw]
          : [];
        for (const area of areaList) {
          const name = str(dig(area, "Name"));
          const code = nodeText(dig(area, "Code"));
          if (name && !targetAreas.some((a) => a.code === code)) {
            targetAreas.push({ name, code });
          }
        }
      }
    }
  }
  return { conditions, targetAreas };
}

/**
 * description のフォールバックチェーン: @_description → @_type → `${value}${unit}` → ""。
 */
function deriveObservationDescription(
  desc: string,
  altType: string,
  value: number | null,
  unit: string | null,
): string {
  if (desc) return desc;
  if (altType) return altType;
  if (value != null && unit) return `${value}${unit}`;
  if (value != null) return String(value);
  return "";
}

/**
 * Body.MeteorologicalInfos > MeteorologicalInfo > Item を WeatherObservation[] に変換。
 * Item.Kind.Property の Type と各 *Part の構造から description / value / unit / time を抽出。
 *
 * 対応するパターン:
 *   - EventPart (Event type="線状降水帯", EventName, Time)
 *   - PrecipitationPart (jmx_eb:Precipitation + Time)
 *   - SnowfallDepthPart (jmx_eb:SnowfallDepth + Time)
 *   - その他: Property.Type の文字列だけでも記録
 *
 * sourceType (MeteorologicalInfos.@_type) と contextTime (MeteorologicalInfo.DateTime)
 * を各 observation に保持し、Part.Time 欠落時の参照に使えるようにする。
 */
function extractObservations(body: unknown): WeatherObservation[] {
  const result: WeatherObservation[] = [];
  if (body == null) return result;

  const infosRaw = dig(body, "MeteorologicalInfos");
  const infosList: unknown[] = Array.isArray(infosRaw)
    ? infosRaw
    : infosRaw != null
    ? [infosRaw]
    : [];

  for (const infos of infosList) {
    const sourceType = str(dig(infos, "@_type")) || null;
    const infoListRaw = dig(infos, "MeteorologicalInfo");
    const infoList: unknown[] = Array.isArray(infoListRaw)
      ? infoListRaw
      : infoListRaw != null
      ? [infoListRaw]
      : [];

    for (const info of infoList) {
      const contextTime = str(dig(info, "DateTime")) || null;
      const itemsRaw = dig(info, "Item");
      const itemList: unknown[] = Array.isArray(itemsRaw)
        ? itemsRaw
        : itemsRaw != null
        ? [itemsRaw]
        : [];

      for (const item of itemList) {
        // location: Area or Station
        const area = first(dig(item, "Area") as unknown);
        const station = first(dig(item, "Station") as unknown);
        const locationName =
          (area != null ? str(dig(area, "Name")) : "") ||
          (station != null ? str(dig(station, "Name")) : "") ||
          null;
        // Code は属性付き要素 (<Code type="...">VALUE</Code>) のことがあるので nodeText 経由で
        const locationCode =
          (area != null ? nodeText(dig(area, "Code")) : "") ||
          (station != null ? nodeText(dig(station, "Code")) : "") ||
          null;

        const kindsRaw = dig(item, "Kind");
        const kindList: unknown[] = Array.isArray(kindsRaw)
          ? kindsRaw
          : kindsRaw != null
          ? [kindsRaw]
          : [];

        for (const kind of kindList) {
          for (const prop of listOf(dig(kind, "Property"))) {
            if (prop == null) continue;
            const propType = str(dig(prop, "Type")) || "観測";

            // EventPart (線状降水帯 など)
            const eventPart = dig(prop, "EventPart");
            if (eventPart != null) {
              const event = dig(eventPart, "Event");
              // observationType は Event.@_type を優先 (線状降水帯 等)
              const eventTypeAttr = str(dig(event, "@_type"));
              const observationType = eventTypeAttr || propType;
              const eventName =
                str(dig(event, "EventName")) ||
                str(dig(eventPart, "EventName")) ||
                "";
              const time =
                str(dig(event, "Time")) ||
                str(dig(eventPart, "Time")) ||
                contextTime;
              result.push({
                observationType,
                description: eventName || observationType,
                value: null,
                unit: null,
                time,
                locationName,
                locationCode,
                sourceType,
                contextTime,
              });
              continue;
            }

            // PrecipitationPart (雨量)
            const precipPart = dig(prop, "PrecipitationPart");
            if (precipPart != null) {
              const precip = dig(precipPart, "jmx_eb:Precipitation");
              const description = str(dig(precip, "@_description"));
              const altType = str(dig(precip, "@_type"));
              const unit = str(dig(precip, "@_unit")) || null;
              const valueStr = nodeText(precip);
              const valueNum = parseFloat(valueStr);
              const time = str(dig(precipPart, "Time")) || contextTime;
              const value = isNaN(valueNum) ? null : valueNum;
              result.push({
                observationType: propType,
                description: deriveObservationDescription(description, altType, value, unit),
                value,
                unit,
                time,
                locationName,
                locationCode,
                sourceType,
                contextTime,
              });
              continue;
            }

            // SnowfallDepthPart (降雪深)
            const snowPart = dig(prop, "SnowfallDepthPart");
            if (snowPart != null) {
              const snow = dig(snowPart, "jmx_eb:SnowfallDepth");
              const description = str(dig(snow, "@_description"));
              const altType = str(dig(snow, "@_type"));
              const unit = str(dig(snow, "@_unit")) || null;
              const valueStr = nodeText(snow);
              const valueNum = parseFloat(valueStr);
              const time = str(dig(snowPart, "Time")) || contextTime;
              const value = isNaN(valueNum) ? null : valueNum;
              result.push({
                observationType: propType,
                description: deriveObservationDescription(description, altType, value, unit),
                value,
                unit,
                time,
                locationName,
                locationCode,
                sourceType,
                contextTime,
              });
              continue;
            }

            // フォールバック: Type だけでも記録
            result.push({
              observationType: propType,
              description: propType,
              value: null,
              unit: null,
              time: contextTime,
              locationName,
              locationCode,
              sourceType,
              contextTime,
            });
          }
        }
      }
    }
  }
  return result;
}

/**
 * 気象防災速報電文 (VPBS50) をパースする。
 */
export function parseWeatherBriefing(msg: WsDataMessage): ParsedWeatherBriefing | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = parseBriefingXml(xmlStr);

    const report =
      dig(parsed, "Report") ||
      dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseWeatherBriefing: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    const infoType = dig(head, "InfoType");
    const title = dig(head, "Title");
    if (
      msg.head.type !== "VPBS50" ||
      head == null ||
      typeof head !== "object" ||
      Array.isArray(head) ||
      typeof infoType !== "string" ||
      !infoType.trim() ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      log.debug("parseWeatherBriefing: 対象外または必須 Head フィールドが不正です");
      return null;
    }

    const headline = extractHeadlineText(dig(head, "Headline"));
    const { conditions, targetAreas } = extractConditions(dig(head, "Headline"));
    const observations = extractObservations(body);

    // Condition ごとに tag → severity を解決して evidence 化 (監査用)
    const briefingSeverityEvidence: BriefingSeverityEvidence[] = conditions.map(
      ({ condition, origin }) => {
        const tag = deriveBriefingTag(condition);
        const r = resolveBriefingSeverity(tag, origin);
        return {
          condition,
          tag,
          displaySeverity: r.displaySeverity,
          soundLevel: r.soundLevel,
          source: r.source,
        };
      },
    );

    // 集合ベース max (表示と音は独立。release は VPBS50 語彙に出ないので考慮不要)
    let maxDisplaySeverity: DisplaySeverity | null = null;
    let maxSoundLevel: Exclude<SoundLevel, "cancel"> | null = null;
    for (const e of briefingSeverityEvidence) {
      if (
        e.displaySeverity != null &&
        (maxDisplaySeverity == null ||
          DISPLAY_SEVERITY_RANK[e.displaySeverity] >
            DISPLAY_SEVERITY_RANK[maxDisplaySeverity])
      ) {
        maxDisplaySeverity = e.displaySeverity;
      }
      if (
        e.soundLevel != null &&
        (maxSoundLevel == null ||
          SOUND_LEVEL_RANK[e.soundLevel] > SOUND_LEVEL_RANK[maxSoundLevel])
      ) {
        maxSoundLevel = e.soundLevel;
      }
    }

    // 代表値: 最大 displaySeverity を与えた最初の evidence。全 null なら先頭 (旧挙動互換)
    const rep =
      briefingSeverityEvidence.find(
        (e) => e.displaySeverity === maxDisplaySeverity,
      ) ??
      briefingSeverityEvidence[0] ??
      null;

    return {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline,
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      briefingTag: rep?.tag ?? "other",
      briefingCondition: rep?.condition ?? "",
      briefingConditions: conditions.map((c) => c.condition),
      briefingSeverityEvidence,
      maxDisplaySeverity,
      maxSoundLevel,
      unknownConditions: briefingSeverityEvidence
        .filter((e) => e.source === "unknown")
        .map((e) => e.condition),
      targetAreas,
      observations,
      isTest: msg.head.test,
    };
  } catch (err) {
    log.error(
      `parseWeatherBriefing: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
