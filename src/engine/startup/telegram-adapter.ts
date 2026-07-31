import { TelegramListItem, WsDataMessage } from "../../types";
import { normalizeTelegramMessage } from "../../dmdata/telegram-ingress";

/** TelegramListItem を WsDataMessage 互換の形に変換する (body は呼び出し側で確認済み前提) */
export function toWsDataMessage(item: TelegramListItem, body: string): WsDataMessage {
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
  return normalizeTelegramMessage(message).message;
}
