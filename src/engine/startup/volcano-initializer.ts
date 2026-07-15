import { listTelegrams } from "../../dmdata/rest-client";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { VolcanoStateHolder } from "../messages/volcano-state";
import { toWsDataMessage } from "./telegram-adapter";
import * as log from "../../logger";

/** 起動時復元で取得する VFVO50 履歴窓 (dmdata REST /v2/telegram の limit 上限) */
const VOLCANO_RESTORE_WINDOW = 100;

/**
 * 起動時に直近の VFVO50 電文履歴を取得し、古い順に replay して火山警報状態を復元する。
 * 解除・取消・レベル1 復帰の削除は VolcanoStateHolder.update() の既存分岐に任せる。
 * エラー時は警告ログのみ出力し、アプリの起動を妨げない。
 */
export async function restoreVolcanoState(
  apiKey: string,
  volcanoState: VolcanoStateHolder
): Promise<void> {
  try {
    const res = await listTelegrams(apiKey, "VFVO50", VOLCANO_RESTORE_WINDOW);

    if (res.items.length === 0) {
      log.debug("VFVO50 電文なし: 火山状態の復元をスキップ");
      return;
    }

    // 古い順に replay することで、窓内の解除・取消が後から正しく適用される
    const items = [...res.items].sort(
      (a, b) => Date.parse(a.head.time) - Date.parse(b.head.time)
    );

    let replayed = 0;
    for (const item of items) {
      if (!item.body) {
        log.debug(`VFVO50 電文に body なし: skip (id=${item.id})`);
        continue;
      }
      const info = parseVolcanoTelegram(toWsDataMessage(item, item.body));
      if (info == null) {
        log.debug(`VFVO50 電文のパースに失敗: skip (id=${item.id})`);
        continue;
      }
      volcanoState.update(info);
      replayed++;
    }

    if (volcanoState.size() > 0) {
      log.info(
        `火山警報状態を復元しました (${volcanoState.size()} 火山 / ${replayed} 電文を replay)`
      );
    } else {
      log.debug(`VFVO50 replay 完了: 継続中の警報なし (${replayed} 電文)`);
    }
  } catch (err) {
    log.warn(
      `火山状態の復元に失敗しました: ${err instanceof Error ? err.message : err}`
    );
  }
}
