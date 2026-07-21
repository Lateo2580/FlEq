import { WsDataMessage, ParsedHeatAlertInfo } from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf, nodeText } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import * as log from "../logger";

/**
 * 熱中症警戒アラート (VPFT50) 用 XML パーサ。
 * Body は Notice + Comment/Text の平文のみで構造化データを持たない。
 * parseTagValue:false で数値の暗黙変換を防ぐ (系統別パーサの現行流儀)。
 * isArray は不要 (配列化するタグを持たない)。
 */
const heatAlertXmlParser = createJmxXmlParser();

/**
 * 本文先頭文を抽出する (最初の「。」まで)。
 * VPFT50 は Headline が空のため、通知 body や PresentationEvent の
 * 表示 headline 合成に使う。「。」が無い長文は先頭 100 文字に切る。
 */
export function extractLeadSentence(text: string | null): string | null {
  if (text == null) return null;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return null;
  const firstParagraph = normalized.split("\n")[0].trim();
  const idx = firstParagraph.indexOf("。");
  if (idx >= 0) return firstParagraph.slice(0, idx + 1);
  return firstParagraph.slice(0, 100);
}

/**
 * Head.Title (例: "埼玉県熱中症警戒アラート") から対象府県名を抽出する。
 * 「特別警戒」が挟まる将来形・題名内スペースにも寛容。マッチしなければ null。
 */
function extractTargetAreaName(title: string): string | null {
  const m = title.match(/^(.+?)\s*熱中症\s*(?:特別)?\s*警戒アラート/);
  if (m && m[1].trim() !== "") return m[1].trim();
  return null;
}

/**
 * Headline.Text を抽出 (空タグは null)。
 * 兄弟パーサと違い配列非対応 (VPFT50 の Headline は常に単一空 Text のため)。
 */
function extractHeadlineText(head: unknown): string | null {
  const text = nodeText(dig(dig(head, "Headline"), "Text"));
  return text === "" ? null : text;
}

/**
 * Body.Comment.Text を抽出。
 * Text が配列になるケースに耐性を持たせる:
 * `@_type === "本文"` を優先採用し、無ければ非空 Text を改行 join。
 */
function extractBodyText(body: unknown): string | null {
  const comment = dig(body, "Comment");
  if (comment == null) return null;
  const list = listOf(dig(comment, "Text"));
  const honbun = list.filter(
    (t) => t != null && typeof t === "object" && str(dig(t, "@_type")) === "本文",
  );
  const candidates = honbun.length > 0 ? honbun : list;
  const parts: string[] = [];
  for (const t of candidates) {
    const s = nodeText(t);
    if (s) parts.push(s);
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

/**
 * 熱中症警戒アラート電文 (VPFT50) をパースする。パース失敗時は null。
 * 必須メタ: Head + InfoType + Title (VPZI50 R1 教訓: 片方欠落でも null)
 */
export function parseHeatAlert(msg: WsDataMessage): ParsedHeatAlertInfo | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = heatAlertXmlParser.parse(xmlStr) as Record<string, unknown>;

    const report = dig(parsed, "Report") ?? dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug("parseHeatAlert: Report ノードが見つかりません");
      return null;
    }
    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");
    if (head == null) {
      log.debug("parseHeatAlert: Head ノードが見つかりません");
      return null;
    }
    const infoType = str(dig(head, "InfoType"));
    const title = str(dig(head, "Title"));
    if (!infoType) {
      log.debug("parseHeatAlert: Head.InfoType が欠落しています");
      return null;
    }
    if (!title) {
      log.debug("parseHeatAlert: Head.Title が欠落しています");
      return null;
    }

    const noticeText = nodeText(dig(body, "Notice"));

    return {
      type: msg.head.type,
      infoType,
      title,
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      targetDateTime: str(dig(head, "TargetDateTime")) || null,
      headline: extractHeadlineText(head),
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      targetAreaName: extractTargetAreaName(title),
      notice: noticeText === "" ? null : noticeText,
      bodyText: extractBodyText(body),
      isTest: msg.head.test,
    };
  } catch (err) {
    log.error(`parseHeatAlert: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
