/**
 * 火山電文のルーティング処理を一元管理するハンドラ。
 *
 * 火山は VFVO53 アグリゲータによるバッチ集約があるため、
 * 他ドメインの processMessage() → outcome → display の線形フローとは異なる。
 * このハンドラが火山の パース → キャッシュ → 集約 → 通知 → 表示 を担当する。
 */

import type { WsDataMessage, ParsedVolcanoInfo } from "../../types";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { VolcanoVfvo53Aggregator, type FlushOptions, type Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";
import { VolcanoStateHolder } from "./volcano-state";
import { Notifier } from "../notification/notifier";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../notification/volcano-presentation";
import { buildVolcanoOutcome } from "../presentation/processors/process-volcano";
import type { VolcanoBatchOutcome, ProcessOutcome } from "../presentation/types";
import type { DisplayCallbacks } from "./display-callbacks";

// ── 型定義 ──

/** 表示パイプライン関数 (message-router から注入) */
export type DisplayPipelineFn = (
  outcome: ProcessOutcome | VolcanoBatchOutcome,
  displayFn: () => void,
) => boolean;

/** VolcanoRouteHandler の設定 */
export interface VolcanoRouteHandlerDeps {
  volcanoState: VolcanoStateHolder;
  notifier: Notifier;
  runDisplayPipeline: DisplayPipelineFn;
  display?: DisplayCallbacks;
}

// ── 定数 ──

const VOLCANO_CACHE_TTL_MS = 10 * 60 * 1000; // 10分

// ── 本体 ──

export class VolcanoRouteHandler {
  private readonly volcanoState: VolcanoStateHolder;
  private readonly notifier: Notifier;
  private readonly runDisplayPipeline: DisplayPipelineFn;
  private readonly display?: DisplayCallbacks;
  private readonly aggregator: VolcanoVfvo53Aggregator;
  private readonly msgCache = new Map<string, { msg: WsDataMessage; cachedAt: number }>();

  constructor(deps: VolcanoRouteHandlerDeps) {
    this.volcanoState = deps.volcanoState;
    this.notifier = deps.notifier;
    this.runDisplayPipeline = deps.runDisplayPipeline;
    this.display = deps.display;

    this.aggregator = new VolcanoVfvo53Aggregator(
      (info, opts) => this.emitSingle(info, opts),
      (batch, opts) => this.emitBatch(batch, opts),
    );
  }

  /**
   * 火山電文を処理する。
   * @returns パース成功なら ParsedVolcanoInfo (統計記録用)、失敗なら null。
   */
  handle(msg: WsDataMessage): ParsedVolcanoInfo | null {
    this.pruneMsgCache();

    const volcanoInfo = parseVolcanoTelegram(msg);
    if (!volcanoInfo) return null;

    this.msgCache.set(volcanoInfo.volcanoCode, { msg, cachedAt: Date.now() });
    this.aggregator.handle(volcanoInfo);
    return volcanoInfo;
  }

  /** 保留中の火山バッファを flush してリソースを破棄する */
  flushAndDispose(): void {
    this.aggregator.flushAndDispose();
  }

  // ── private: emit callbacks ──

  private emitSingle(info: ParsedVolcanoInfo, opts?: FlushOptions): void {
    const cacheEntry = this.msgCache.get(info.volcanoCode);
    const cachedMsg = cacheEntry?.msg;
    const outcome = cachedMsg
      ? buildVolcanoOutcome(cachedMsg, info, this.volcanoState)
      : null;

    const presentation = resolveVolcanoPresentation(info, this.volcanoState);
    this.volcanoState.update(info);

    // 通知は filter 非適用
    if (opts?.notify !== false) {
      this.notifier.notifyVolcano(info, presentation);
    }

    // PresentationEvent パイプライン
    if (outcome) {
      this.runDisplayPipeline(outcome, () =>
        this.display?.displayVolcano(info, presentation),
      );
    } else {
      // msg キャッシュがない場合はフォールバック表示
      this.display?.displayVolcano(info, presentation);
    }

    this.msgCache.delete(info.volcanoCode);
  }

  private emitBatch(batch: Vfvo53BatchItems, opts: FlushOptions): void {
    const presentation = resolveVolcanoBatchPresentation(batch);

    if (opts.notify) {
      this.notifier.notifyVolcanoBatch(batch, presentation);
    }

    const firstItem = batch.items[0];
    const cacheEntry = firstItem ? this.msgCache.get(firstItem.volcanoCode) : undefined;
    const cachedMsg = cacheEntry?.msg;

    if (cachedMsg) {
      const batchOutcome: VolcanoBatchOutcome = {
        domain: "volcano",
        msg: cachedMsg,
        headType: cachedMsg.head.type,
        statsCategory: "volcano",
        parsed: batch.items,
        isBatch: true,
        volcanoPresentation: presentation,
        batchReportDateTime: batch.reportDateTime,
        batchIsTest: batch.isTest,
        stats: {
          shouldRecord: false,
        },
        presentation: {
          frameLevel: presentation.frameLevel,
          soundLevel: presentation.soundLevel,
          notifyCategory: "volcano",
        },
      };

      this.runDisplayPipeline(batchOutcome, () =>
        this.display?.displayVolcanoBatch(batch, presentation),
      );
    } else {
      this.display?.displayVolcanoBatch(batch, presentation);
    }

    this.cleanupBatchCache(batch);
  }

  // ── private: cache management ──

  private pruneMsgCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.msgCache) {
      if (now - entry.cachedAt > VOLCANO_CACHE_TTL_MS) {
        this.msgCache.delete(key);
      }
    }
  }

  private cleanupBatchCache(batch: Vfvo53BatchItems): void {
    for (const item of batch.items) {
      this.msgCache.delete(item.volcanoCode);
    }
  }
}
