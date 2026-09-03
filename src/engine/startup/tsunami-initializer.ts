import { ParsedTsunamiInfo } from "../../types";
import { fetchTelegramBody, listTelegrams } from "../../dmdata/rest-client";
import { TsunamiStateHolder } from "../messages/tsunami-state";
import { TelegramRevisionGate } from "../messages/telegram-revision-gate";
import { processTsunami } from "../presentation/processors/process-tsunami";
import {
  strictRestReceivedTimeMs,
  toWsDataMessageFromRestBody,
} from "./telegram-adapter";
import * as log from "../../logger";
import type { StandbyPersistenceAdmissionCoordinator } from "../display/standby-persistence-admission";

/**
 * 起動時に最新の VTSE41 電文を取得し、津波警報状態を復元する。
 *
 * 一覧 API (`/v2/telegram`) の item は本文を持たない (実採取 2026-09-03 で確定)。
 * 本文は Telegram Data v1 から item の `id` で別途取得し、一覧の `url` と
 * 突き合わせてから `processTsunami` へ流す。取得失敗は reason 付き warn に留め、
 * アプリの起動を妨げない。
 *
 * `persistenceAdmission` がある場合、REST 結果は `processTsunami` の admission
 * transaction を通る。transaction は await 後の最新 composition を capture して
 * candidate を作るので、永続復元済み state や REST 待ちの間に届いた live 電文を
 * 上書きしない (stale なら staleVersion で reject)。
 */
export async function restoreTsunamiState(
  apiKey: string,
  tsunamiState: TsunamiStateHolder,
  revisionGate: TelegramRevisionGate,
  onAcceptedRevision?: () => void,
  persistenceAdmission?: StandbyPersistenceAdmissionCoordinator,
): Promise<ParsedTsunamiInfo | null> {
  try {
    const res = await listTelegrams(apiKey, { type: "VTSE41", limit: 1 });

    if (res.items.length === 0) {
      log.debug("VTSE41 電文なし: 津波状態の復元をスキップ");
      return null;
    }

    const item = res.items[0];
    const body = await fetchTelegramBody(apiKey, item.id, item.url);
    if (body.kind === "failed") {
      log.warn(
        `VTSE41 本文の取得に失敗しました (reason=${body.reason}, id=${item.id}): 津波状態の復元をスキップ`,
      );
      return null;
    }

    const receivedAtMs = strictRestReceivedTimeMs(item.head.time);
    const msg = toWsDataMessageFromRestBody(item, body.xml, receivedAtMs ?? undefined);
    const hadPersistedActive = tsunamiState.getLastInfo() != null;
    const result = processTsunami(msg, {
      tsunamiState,
      revisionGate,
      onTsunamiRevisionDecision: onAcceptedRevision,
      restoreStateOnDuplicate: true,
      persistenceAdmission,
    });
    if (result.kind !== "ok") {
      if (result.kind === "suppressed" && tsunamiState.getLastInfo() != null) {
        if (!hadPersistedActive) onAcceptedRevision?.();
        log.info(`津波警報状態を復元しました: ${tsunamiState.getLevel()}`);
        return tsunamiState.getLastInfo();
      }
      log.debug("VTSE41 電文のパースに失敗: 津波状態の復元をスキップ");
      return null;
    }
    const info = result.outcome.parsed;

    // 状態が実際にセットされた場合のみログ出力
    if (tsunamiState.getLevel() != null) {
      log.info(`津波警報状態を復元しました: ${tsunamiState.getLevel()}`);
      return info;
    }

    log.debug("最新の VTSE41 は警報なし (取消・解除または津波予報のみ)");
    return null;
  } catch (err) {
    log.warn(
      `津波状態の復元に失敗しました: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
