import { listTelegrams } from "../../dmdata/rest-client";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { VolcanoStateHolder } from "../messages/volcano-state";
import { toWsDataMessage } from "./telegram-adapter";
import * as log from "../../logger";
import { volcanoRevisionFamilyPolicy } from "../messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  type TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "../messages/telegram-revision-gate";

/** 起動時復元で取得する VFVO50 履歴窓 (dmdata REST /v2/telegram の limit 上限) */
const VOLCANO_RESTORE_WINDOW = 100;

/**
 * 起動時に直近の VFVO50 電文履歴を取得し、古い順に replay して火山警報状態を復元する。
 * 解除・取消・レベル1 復帰の削除は VolcanoStateHolder.update() の既存分岐に任せる。
 * エラー時は警告ログのみ出力し、アプリの起動を妨げない。
 */
export async function restoreVolcanoState(
  apiKey: string,
  volcanoState: VolcanoStateHolder,
  revisionGate?: TelegramRevisionGate,
  foundationAuthoritative = false,
  onMutation?: () => void,
): Promise<"success" | "failed"> {
  try {
    const res = await listTelegrams(apiKey, "VFVO50", VOLCANO_RESTORE_WINDOW);

    if (res.items.length === 0) {
      log.debug("VFVO50 電文なし: 火山状態の復元をスキップ");
      return "success";
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
      if (info.kind !== "alert") continue;
      const policy = volcanoRevisionFamilyPolicy(info.type);
      const extracted = policy?.extractStateSubjectKey(info.meta, info);
      const subject = typeof extracted === "string" ? extracted : null;
      if (policy == null || revisionGate == null || subject == null) {
        if (!foundationAuthoritative) volcanoState.update(info);
        replayed++;
        continue;
      }
      const { meta: _meta, isTest: _isTest, ...payload } = info;
      const targets = info.meta.infoType.value === "取消"
        ? policy.extractCancellationTarget(info.meta, info)
        : null;
      const input: TelegramRevisionGateInput = {
        domain: policy.domain,
        revisionFamily: policy.revisionFamily,
        stateSubjectKey: subject,
        meta: info.meta,
        comparator: policy.comparator,
        cancellationPolicy: policy.cancellationPolicy,
        terminal: policy.terminalPredicate(info.meta, info),
        deactivation: policy.deactivationPredicate(info.meta, info),
        cancellationTargetMatches: targets == null
          ? info.meta.infoType.value !== "取消"
          : targets.includes(subject),
        durable: policy.durable,
        tombstoneRetentionMs: policy.tombstoneRetentionMs,
        maxSubjects: policy.maxSubjects,
        allowMissingSerial: policy.allowMissingSerial,
        payloadFingerprint: semanticPayloadFingerprint(payload),
      };
      const evaluation = revisionGate.evaluate(input);
      if (!evaluation.accepted) {
        if (
          foundationAuthoritative
          && (evaluation.kind === "duplicate" || evaluation.kind === "semanticDuplicate")
          && volcanoState.getEntry(info.volcanoCode) == null
          && revisionGate.matchesCurrentAcceptedPayload(input)
        ) {
          volcanoState.applyAcceptedAlert(info);
        }
        replayed++;
        continue;
      }
      const decision = revisionGate.decide(input);
      if (!decision.accepted) continue;
      if (decision.kind === "clearCurrent") volcanoState.clearAlert(info.volcanoCode);
      else volcanoState.applyAcceptedAlert(info);
      onMutation?.();
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
    return "failed";
  }
  return "success";
}
