import { XMLParser } from "fast-xml-parser";
import {
  WsDataMessage,
  ParsedWeatherWarning,
  WeatherAreaLayer,
  WeatherItem,
  WeatherKind,
  WeatherSeverity,
} from "../types";
import { decodeBody, dig, str, first } from "./telegram-parser";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "./weather-warning-level";
import * as log from "../logger";

/**
 * 気象警報・注意報用 XML パーサ。
 * Information / Warning / Areas / Comment / Office を必ず配列として扱う。
 *
 * parseTagValue: false は重要。"03" や "011000" のような先頭ゼロを含む
 * Code / Area.Code を数値化されないよう文字列のまま保持するため。
 * 数値化されると severity 判定や Code 比較が壊れる。
 */
const weatherXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  isArray: (name) => {
    const arrayTags = [
      "Information",
      "Warning",
      "Item",
      "Kind",
      "Areas",
      "Area",
      "Text",
      "Office",
    ];
    return arrayTags.includes(name);
  },
});

/** XML 文字列をパースする (weather 系専用) */
function parseWeatherXml(xmlStr: string): Record<string, unknown> {
  return weatherXmlParser.parse(xmlStr);
}

/**
 * Kind の Code から重大度を判定する。
 *
 * DMDATA 仕様 / JMA コード体系 (主要):
 *   - "00"           : 解除
 *   - "01"-"09"      : 警報 (大雨警報=03、暴風警報=05 など)
 *   - "10"-"29"      : 注意報 (大雨注意報=10、雷注意報=14 など)
 *   - "30"-"39"      : 特別警報 (大雨特別警報=33、レベル5土砂災害特別警報=39 など)
 *   - "40"-"49"      : 警報相当の高位警報 (レベル4土砂災害危険警報=49 など)
 *                      → DMDATA / JMA 準拠で `warning` 扱い
 *   - "50"-"59"      : 予備 (現状未使用)
 *
 * Name の文字列も補助的に判定に使う ("特別警報" / "警報" / "注意報" / "解除")。
 * 「危険警報」は警報レベル4相当だが、severity 上は `warning`。
 */
export function deriveWeatherSeverity(name: string, code: string): WeatherSeverity {
  // Name の文字列から先に判定 (より正確)
  if (name.includes("解除")) return "release";
  if (name.includes("特別警報")) return "specialWarning";
  // 「危険警報」「警報」は warning (DMDATA / JMA 準拠)
  if (name.includes("警報")) return "warning";
  if (name.includes("注意報")) return "advisory";

  // Code フォールバック
  if (!/^\d+$/.test(code)) return "unknown";
  const codeNum = Number(code);
  if (codeNum === 0) return "release";
  if (codeNum >= 30 && codeNum <= 39) return "specialWarning";
  if (codeNum >= 40 && codeNum <= 49) return "warning"; // 危険警報相当も警報
  if (codeNum >= 1 && codeNum <= 9) return "warning";
  if (codeNum >= 10 && codeNum <= 29) return "advisory";
  return "unknown";
}

/** 重大度の優先順位 (高いほど重大) */
const SEVERITY_RANK: Record<WeatherSeverity, number> = {
  specialWarning: 4,
  warning: 3,
  advisory: 2,
  release: 1,
  unknown: 0,
};

/** 2つの重大度のうち高い方を返す */
function maxSeverity(a: WeatherSeverity, b: WeatherSeverity): WeatherSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * 集計・代表表示用に最も粒度の細かい階層を返す。
 *
 * 優先順位: 市町村等 > 市町村等をまとめた地域等 > 一次細分区域等 > 最後のレイヤー。
 * 文字列マッチは「市町村等」を含み「まとめた」を含まない、で判定する。
 * (XML の閉じ括弧は全角 "）" のため、ASCII 括弧をハードコードしない)
 */
export function selectPreferredWeatherLayer(
  layers: WeatherAreaLayer[],
): WeatherAreaLayer | undefined {
  if (layers.length === 0) return undefined;
  return (
    layers.find(
      (l) => l.type.includes("市町村等") && !l.type.includes("まとめた"),
    ) ??
    layers.find((l) => l.type.includes("市町村等をまとめた地域等")) ??
    layers.find((l) => l.type.includes("一次細分区域等")) ??
    layers[layers.length - 1]
  );
}

/** Item ノードから WeatherItem を構築する (Headline.Information 用) */
function extractHeadlineItem(item: unknown): WeatherItem[] {
  const results: WeatherItem[] = [];
  const kindsRaw = dig(item, "Kind");
  const kindNodes: unknown[] = Array.isArray(kindsRaw)
    ? kindsRaw
    : kindsRaw != null
    ? [kindsRaw]
    : [];

  const kinds: WeatherKind[] = [];
  for (const k of kindNodes) {
    const name = str(dig(k, "Name"));
    const code = str(dig(k, "Code"));
    // 空 Kind や「発表警報・注意報はなし」は表示・集計対象外
    if (isEmptyOrNoneKind(name, code)) continue;
    kinds.push({
      name,
      code,
      severity: deriveWeatherSeverity(name, code),
    });
  }

  // 全 Kind が除外された Item はそもそも追加しない
  if (kinds.length === 0) return results;

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
      results.push({
        areaName: str(dig(area, "Name")),
        areaCode: str(dig(area, "Code")),
        kinds: [...kinds],
        statuses: [],
      });
    }
  }
  return results;
}

/** Headline.Information から階層別 layers を抽出する */
function extractLayers(headline: unknown): WeatherAreaLayer[] {
  const layers: WeatherAreaLayer[] = [];
  const infoRaw = dig(headline, "Information");
  const infoList: unknown[] = Array.isArray(infoRaw)
    ? infoRaw
    : infoRaw != null
    ? [infoRaw]
    : [];

  for (const info of infoList) {
    const type = str(dig(info, "@_type"));
    const itemsRaw = dig(info, "Item");
    const itemList: unknown[] = Array.isArray(itemsRaw)
      ? itemsRaw
      : itemsRaw != null
      ? [itemsRaw]
      : [];

    const items: WeatherItem[] = [];
    for (const item of itemList) {
      items.push(...extractHeadlineItem(item));
    }
    layers.push({ type, items });
  }
  return layers;
}

/**
 * 「警報・注意報なし」相当の Kind かどうかを判定する。
 * 空 Code/空 Name や「発表警報・注意報はなし」「特になし」等は表示・集計から除外する。
 */
function isEmptyOrNoneKind(name: string, code: string): boolean {
  if (!name && !code) return true;
  if (name.includes("発表警報・注意報はなし")) return true;
  if (name.includes("特になし")) return true;
  return false;
}

/** Body.Warning から Status / LastKind を取り出し、layers の WeatherItem にマージする */
function mergeBodyWarningStatuses(body: unknown, layers: WeatherAreaLayer[]): void {
  const warningRaw = dig(body, "Warning");
  const warningList: unknown[] = Array.isArray(warningRaw)
    ? warningRaw
    : warningRaw != null
    ? [warningRaw]
    : [];

  for (const warning of warningList) {
    const type = str(dig(warning, "@_type"));
    const layer = layers.find((l) => l.type === type);
    if (!layer) continue;

    const itemsRaw = dig(warning, "Item");
    const itemList: unknown[] = Array.isArray(itemsRaw)
      ? itemsRaw
      : itemsRaw != null
      ? [itemsRaw]
      : [];

    for (const item of itemList) {
      const area = first(dig(item, "Area") as unknown);
      const areaName = str(dig(area, "Name"));
      const areaCode = str(dig(area, "Code"));
      const changeStatus = str(dig(item, "ChangeStatus")) || undefined;
      const fullStatus = str(dig(item, "FullStatus")) || undefined;
      const kindsRaw = dig(item, "Kind");
      const kindList: unknown[] = Array.isArray(kindsRaw)
        ? kindsRaw
        : kindsRaw != null
        ? [kindsRaw]
        : [];

      // layer + areaCode で既存 Item を引き、なければ 1 つだけ作って追加
      let targetItem = layer.items.find((i) => i.areaCode === areaCode);
      let isNewItem = false;
      if (!targetItem) {
        targetItem = {
          areaName,
          areaCode,
          kinds: [],
          statuses: [],
        };
        isNewItem = true;
      }

      targetItem.changeStatus = changeStatus;
      targetItem.fullStatus = fullStatus;

      // Body の各 Kind を統合
      let pushedAnyMeaningful = false;
      for (const k of kindList) {
        const kindName = str(dig(k, "Name"));
        const kindCode = str(dig(k, "Code"));
        const status = str(dig(k, "Status"));
        const lastKindName = str(dig(k, "LastKind", "Name")) || undefined;
        const lastKindCode = str(dig(k, "LastKind", "Code")) || undefined;

        // 空 Kind や「発表警報・注意報はなし」は表示対象に含めない
        if (isEmptyOrNoneKind(kindName, kindCode)) continue;

        targetItem.statuses.push({
          kindCode,
          status,
          lastKindName,
          lastKindCode,
        });

        // 新規 Item の場合のみ Kind を accumulate
        // (既存 Item は Headline 由来で kinds が確定済み)
        if (isNewItem && !targetItem.kinds.some((kk) => kk.code === kindCode)) {
          targetItem.kinds.push({
            name: kindName,
            code: kindCode,
            severity: deriveWeatherSeverity(kindName, kindCode),
          });
        }
        pushedAnyMeaningful = true;
      }

      // 新規 Item でかつ意味のある Kind が一つも入らなかった場合は追加しない
      if (isNewItem && pushedAnyMeaningful) {
        layer.items.push(targetItem);
      }
    }
  }
}

/**
 * Headline.Text を文字列に抽出する。
 * `Text` は isArray 対象なので配列で来るが、属性付きの場合は object になる。
 * 複数 Text は改行で連結する。
 */
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

/** Body.Comment.Text 配列を抽出 */
function extractComments(body: unknown): { type: string; text: string }[] {
  const result: { type: string; text: string }[] = [];
  const commentRaw = dig(body, "Comment");
  if (!commentRaw) return result;

  const textRaw = dig(commentRaw, "Text");
  const textList: unknown[] = Array.isArray(textRaw)
    ? textRaw
    : textRaw != null
    ? [textRaw]
    : [];

  for (const t of textList) {
    if (t == null) continue;
    if (typeof t === "object") {
      const type = str(dig(t, "@_type"));
      const text = str(dig(t, "#text"));
      if (text) result.push({ type, text });
    } else {
      const text = str(t);
      if (text) result.push({ type: "", text });
    }
  }
  return result;
}

/** 集計: maxSeverity, warningAreaCount, advisoryAreaCount */
function summarizeSeverity(layers: WeatherAreaLayer[]): {
  maxSeverity: WeatherSeverity;
  warningAreaCount: number;
  advisoryAreaCount: number;
} {
  const preferred = selectPreferredWeatherLayer(layers);

  let max: WeatherSeverity = "unknown";
  let warningCount = 0;
  let advisoryCount = 0;

  if (!preferred) {
    return { maxSeverity: max, warningAreaCount: 0, advisoryAreaCount: 0 };
  }

  for (const item of preferred.items) {
    let itemMax: WeatherSeverity = "unknown";
    for (const k of item.kinds) {
      itemMax = maxSeverity(itemMax, k.severity);
      max = maxSeverity(max, k.severity);
    }
    if (itemMax === "specialWarning" || itemMax === "warning") {
      warningCount++;
    } else if (itemMax === "advisory") {
      advisoryCount++;
    }
  }
  return { maxSeverity: max, warningAreaCount: warningCount, advisoryAreaCount: advisoryCount };
}

/**
 * 気象警報・注意報電文 (VPWW55-61, VPWS50) をパースする。
 * パース失敗時は null を返し、router 側で displayRawHeader にフォールバックする。
 */
export function parseWeatherWarning(msg: WsDataMessage): ParsedWeatherWarning | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = parseWeatherXml(xmlStr);

    const report =
      dig(parsed, "Report") ||
      dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseWeatherWarning: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    const infoType = dig(head, "InfoType");
    const title = dig(head, "Title");
    const isSupportedType = /^(VPWW5[5-9]|VPWW6[0-1]|VPWS50)$/.test(msg.head.type);
    if (
      !isSupportedType ||
      head == null ||
      typeof head !== "object" ||
      Array.isArray(head) ||
      typeof infoType !== "string" ||
      !infoType.trim() ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      log.debug("parseWeatherWarning: 対象外または必須 Head フィールドが不正です");
      return null;
    }

    const headline = extractHeadlineText(dig(head, "Headline"));
    const layers = extractLayers(dig(head, "Headline"));
    if (body != null) {
      mergeBodyWarningStatuses(body, layers);
    }
    const comments = body != null ? extractComments(body) : [];
    const summary = summarizeSeverity(layers);

    return {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      headline,
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      controlTitle: str(dig(control, "Title")),
      layers,
      comments,
      maxSeverity: summary.maxSeverity,
      maxDisplaySeverity: computeMaxDisplaySeverity(layers),
      maxSoundLevel: computeMaxSoundLevel(layers),
      warningAreaCount: summary.warningAreaCount,
      advisoryAreaCount: summary.advisoryAreaCount,
      isTest: msg.head.test,
    };
  } catch (err) {
    log.error(
      `parseWeatherWarning: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
