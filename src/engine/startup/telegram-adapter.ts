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
    compression: item.compression,
    encoding: item.encoding,
    body,
  };
  return normalizeTelegramMessage(message, receivedAtMs).message;
}
