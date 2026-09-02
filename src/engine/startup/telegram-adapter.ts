import { TelegramListItem, WsDataMessage } from "../../types";
import { normalizeTelegramMessage } from "../../dmdata/telegram-ingress";
import { parseStrictReportDateTime } from "../../dmdata/telegram-meta";

const ECMASCRIPT_DATE_LIMIT_MS = 8_640_000_000_000_000;

/** REST transport clock. ReportDateTime and the local startup clock are separate. */
export function strictRestReceivedTimeMs(value: string): number | null {
  const parsed = parseStrictReportDateTime(value, ECMASCRIPT_DATE_LIMIT_MS);
  return parsed.valid && parsed.epochMs != null && Number.isSafeInteger(parsed.epochMs)
    ? parsed.epochMs
    : null;
}

/** TelegramListItem を WsDataMessage 互換の形に変換する (body は呼び出し側で確認済み前提) */
export function toWsDataMessage(
  item: TelegramListItem,
  body: string,
  receivedAtMs?: number,
): WsDataMessage {
  const message: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification: item.classification,
    id: item.id,
    passing: [],
    head: item.head,
    xmlReport: item.xmlReport,
    format: item.format,
    compression: item.compression ?? null,
    encoding: item.encoding ?? null,
    body,
  };
  return normalizeTelegramMessage(message, receivedAtMs).message;
}

/**
 * Telegram Data v1 から取得した生 XML を WsDataMessage 互換の形へ包む。
 *
 * 一覧 item の `compression` / `encoding` は**読まない**。あれは data API 側の
 * リクエスト条件を表す欄であって、我々が実際に受け取った表現ではない
 * (実採取 2026-09-02: 一覧 item に両欄は存在しない)。data API は生 XML を
 * 無圧縮で返すので `compression: null` / `encoding: "utf-8"` を固定で立てる。
 */
export function toWsDataMessageFromRestBody(
  item: TelegramListItem,
  xml: string,
  receivedAtMs?: number,
): WsDataMessage {
  const message: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification: item.classification,
    id: item.id,
    passing: [],
    head: item.head,
    xmlReport: item.xmlReport,
    format: item.format ?? "xml",
    compression: null,
    encoding: "utf-8",
    body: xml,
  };
  return normalizeTelegramMessage(message, receivedAtMs).message;
}
