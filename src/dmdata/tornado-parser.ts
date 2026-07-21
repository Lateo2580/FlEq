import {
  WsDataMessage,
  ParsedTornadoAdvisory,
  TornadoArea,
  TornadoAreaLayer,
  TornadoStatus,
} from "../types";
import { decodeBody, dig, str, first } from "./telegram-parser";
import { resolveTornadoSeverity } from "./weather-warning-level";
import { createJmxXmlParser } from "./xml-shape";
import * as log from "../logger";

/**
 * 竜巻注意情報用 XML パーサ。
 * Information / Warning / Item / Kind / Areas / Area / Text を配列化。
 * parseTagValue:false で Code/Area.Code の先頭ゼロを保持する。
 */
const tornadoXmlParser = createJmxXmlParser((name) => {
  const arrayTags = [
    "Information",
    "Warning",
    "Item",
    "Kind",
    "Areas",
    "Area",
    "Text",
  ];
  return arrayTags.includes(name);
});

/** XML 文字列をパースする (tornado 系専用) */
function parseTornadoXml(xmlStr: string): Record<string, unknown> {
  return tornadoXmlParser.parse(xmlStr);
}

/** Code から TornadoStatus を判定する */
function deriveTornadoStatus(name: string, code: string): TornadoStatus {
  if (name === "なし" || code === "0") return "none";
  return "active";
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

/** Headline.Information の Item から TornadoArea[] を抽出する */
function extractHeadlineItemAreas(item: unknown): TornadoArea[] {
  const results: TornadoArea[] = [];
  const kindsRaw = dig(item, "Kind");
  const kindNodes: unknown[] = Array.isArray(kindsRaw)
    ? kindsRaw
    : kindsRaw != null
    ? [kindsRaw]
    : [];

  // 複数 Kind を走査し、いずれかが active なら active 扱い (active 優先)
  let status: TornadoStatus = "none";
  for (const k of kindNodes) {
    const kindName = str(dig(k, "Name"));
    const kindCode = str(dig(k, "Code"));
    if (deriveTornadoStatus(kindName, kindCode) === "active") {
      status = "active";
      break;
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
      results.push({
        name: str(dig(area, "Name")),
        code: str(dig(area, "Code")),
        status,
      });
    }
  }
  return results;
}

/**
 * Headline.Information から階層別 layers を抽出。
 * 「目撃情報あり」階層 (VPHW51) は別途 sightingAreas に格納する。
 */
function extractLayers(headline: unknown): {
  layers: TornadoAreaLayer[];
  sightingAreas: TornadoArea[];
} {
  const layers: TornadoAreaLayer[] = [];
  const sightingAreas: TornadoArea[] = [];

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

    const areas: TornadoArea[] = [];
    for (const item of itemList) {
      areas.push(...extractHeadlineItemAreas(item));
    }

    // 「目撃情報あり」層は別管理 (VPHW51 のみ存在)
    if (type.includes("目撃情報あり")) {
      sightingAreas.push(...areas.filter((a) => a.status === "active"));
      continue;
    }

    // 「なし」の地域は集計・表示対象外
    const filtered = areas.filter((a) => a.status === "active");
    if (filtered.length === 0) continue;
    layers.push({ type, areas: filtered });
  }

  return { layers, sightingAreas };
}

/**
 * Body.Warning から status を取り、必要に応じて layers にマージする。
 * Headline.Information に同 type 層がない場合 (全 area が「なし」で除外された等)
 * は新規 layer を作って補完する。
 */
function mergeBodyWarnings(body: unknown, layers: TornadoAreaLayer[]): void {
  const warningRaw = dig(body, "Warning");
  const warningList: unknown[] = Array.isArray(warningRaw)
    ? warningRaw
    : warningRaw != null
    ? [warningRaw]
    : [];

  for (const warning of warningList) {
    const type = str(dig(warning, "@_type"));
    let layer = layers.find((l) => l.type === type);

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
      // 複数 Kind を走査して active 判定 (Headline 側と同じロジック)
      const kindsRaw = dig(item, "Kind");
      const kindList: unknown[] = Array.isArray(kindsRaw)
        ? kindsRaw
        : kindsRaw != null
        ? [kindsRaw]
        : [];
      let status: TornadoStatus = "none";
      for (const k of kindList) {
        const kindName = str(dig(k, "Name"));
        const kindCode = str(dig(k, "Code"));
        if (deriveTornadoStatus(kindName, kindCode) === "active") {
          status = "active";
          break;
        }
      }

      // active の地域だけ反映
      if (status !== "active") continue;

      // layer がまだ無ければ新規作成して layers に追加
      if (!layer) {
        layer = { type, areas: [] };
        layers.push(layer);
      }

      // 既存 layer に同 areaCode があればスキップ
      if (layer.areas.some((a) => a.code === areaCode)) continue;
      layer.areas.push({ name: areaName, code: areaCode, status });
    }
  }
}

/**
 * 表示・集計用に最も粒度の細かい階層を選ぶ。
 * 「市町村等」を最優先 (まとめた / 一次細分 / 発表細分 / 最後の順でフォールバック)。
 */
export function selectPreferredTornadoLayer(
  layers: TornadoAreaLayer[],
): TornadoAreaLayer | undefined {
  if (layers.length === 0) return undefined;
  return (
    layers.find(
      (l) => l.type.includes("市町村等") && !l.type.includes("まとめた"),
    ) ??
    layers.find((l) => l.type.includes("市町村等をまとめた地域等")) ??
    layers.find((l) => l.type.includes("一次細分区域等")) ??
    layers.find((l) => l.type.includes("発表細分")) ??
    layers[layers.length - 1]
  );
}

/** 集計: active 地域数 */
function summarizeAreas(layers: TornadoAreaLayer[]): number {
  const preferred = selectPreferredTornadoLayer(layers);
  if (!preferred) return 0;
  return preferred.areas.length;
}

/**
 * 竜巻注意情報電文 (VPHW50, VPHW51) をパースする。
 * パース失敗時は null を返す。
 */
export function parseTornadoAdvisory(msg: WsDataMessage): ParsedTornadoAdvisory | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = parseTornadoXml(xmlStr);

    const report =
      dig(parsed, "Report") ||
      dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseTornadoAdvisory: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    const infoType = dig(head, "InfoType");
    const title = dig(head, "Title");
    const isSupportedType = msg.head.type === "VPHW50" || msg.head.type === "VPHW51";
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
      log.debug("parseTornadoAdvisory: 対象外または必須 Head フィールドが不正です");
      return null;
    }

    const headline = extractHeadlineText(dig(head, "Headline"));
    const { layers, sightingAreas } = extractLayers(dig(head, "Headline"));
    if (body != null) {
      mergeBodyWarnings(body, layers);
    }
    const activeAreaCount = summarizeAreas(layers);
    const isSightingTelegram = msg.head.type === "VPHW51";
    const hasSightingAreas = sightingAreas.length > 0;
    const resolved = resolveTornadoSeverity(hasSightingAreas, isSightingTelegram, activeAreaCount);

    return {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      validDateTime: str(dig(head, "ValidDateTime")) || null,
      headline,
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      serial: str(dig(head, "Serial")) || null,
      layers,
      sightingAreas,
      isSightingTelegram,
      hasSightingAreas,
      activeAreaCount,
      displaySeverity: resolved.displaySeverity,
      soundLevel: resolved.soundLevel,
      isTest: msg.head.test,
    };
  } catch (err) {
    log.error(
      `parseTornadoAdvisory: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
