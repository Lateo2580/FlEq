import { TelegramListItem, WsDataMessage, ParsedTsunamiInfo } from "../../types";
import { listTelegrams } from "../../dmdata/rest-client";
import { parseTsunamiTelegram } from "../../dmdata/telegram-parser";
import { TsunamiStateHolder } from "../messages/tsunami-state";
import * as log from "../../logger";

/** TelegramListItem を WsDataMessage 互換の形に変換する */
function toWsDataMessage(item: TelegramListItem): WsDataMessage {
  return {
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
    body: item.body,
  };
}

/**
 * 起動時に最新の VTSE41 電文を取得し、津波警報状態を復元する。
 * エラー時は警告ログのみ出力し、アプリの起動を妨げない。
 */
export async function restoreTsunamiState(
  apiKey: string,
  tsunamiState: TsunamiStateHolder
): Promise<ParsedTsunamiInfo | null> {
  try {
    const res = await listTelegrams(apiKey, "VTSE41", 1);

    if (res.items.length === 0) {
      log.debug("VTSE41 電文なし: 津波状態の復元をスキップ");
      return null;
    }

    const item = res.items[0];
    const msg = toWsDataMessage(item);
    const info = parseTsunamiTelegram(msg);

    if (info == null) {
      log.debug("VTSE41 電文のパースに失敗: 津波状態の復元をスキップ");
      return null;
    }

    tsunamiState.update(info);

    // 状態が実際にセットされた場合のみログ出力
    if (tsunamiState.getLevel() != null) {
      log.info(`津波警報状態を復元しました: ${tsunamiState.getLevel()}`);
      return info;
    }

    log.debug("最新の VTSE41 は警報なし (取消または津波予報のみ)");
    return null;
  } catch (err) {
    log.warn(
      `津波状態の復元に失敗しました: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
