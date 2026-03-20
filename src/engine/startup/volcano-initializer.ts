import { TelegramListItem, WsDataMessage } from "../../types";
import { listTelegrams } from "../../dmdata/rest-client";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { VolcanoStateHolder } from "../messages/volcano-state";
import * as log from "../../logger";

/** TelegramListItem を WsDataMessage 互換の形に変換する (body は呼び出し側で確認済み前提) */
function toWsDataMessage(item: TelegramListItem, body: string): WsDataMessage {
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
    body,
  };
}

/**
 * 起動時に最新の VFVO50 電文を取得し、火山警報状態を復元する。
 * エラー時は警告ログのみ出力し、アプリの起動を妨げない。
 */
export async function restoreVolcanoState(
  apiKey: string,
  volcanoState: VolcanoStateHolder
): Promise<void> {
  try {
    const res = await listTelegrams(apiKey, "VFVO50", 1);

    if (res.items.length === 0) {
      log.debug("VFVO50 電文なし: 火山状態の復元をスキップ");
      return;
    }

    const item = res.items[0];

    if (!item.body) {
      log.debug("VFVO50 電文に body が含まれていません: 火山状態の復元をスキップ");
      return;
    }

    const msg = toWsDataMessage(item, item.body);
    const info = parseVolcanoTelegram(msg);

    if (info == null) {
      log.debug("VFVO50 電文のパースに失敗: 火山状態の復元をスキップ");
      return;
    }

    volcanoState.update(info);

    if (volcanoState.size() > 0) {
      log.info(`火山警報状態を復元しました (${volcanoState.size()} 件)`);
    } else {
      log.debug("最新の VFVO50 は警報なし (解除または平常)");
    }
  } catch (err) {
    log.warn(
      `火山状態の復元に失敗しました: ${err instanceof Error ? err.message : err}`
    );
  }
}
