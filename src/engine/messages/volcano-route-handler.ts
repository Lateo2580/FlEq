/**
 * 火山電文のルーティング処理を一元管理するハンドラ。
 *
 * 火山は VFVO53 アグリゲータによるバッチ集約があるため、
 * 他ドメインの processMessage() → outcome → display の線形フローとは異なる。
 * このハンドラが火山の パース → 集約 → 通知 → 表示 を担当する。
 */

import type { WsDataMessage, ParsedVolcanoAshfallInfo, ParsedVolcanoInfo } from "../../types";
import * as log from "../../logger";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { VolcanoVfvo53Aggregator, type FlushOptions, type Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";
import { VolcanoStateHolder } from "./volcano-state";
import { Notifier } from "../notification/notifier";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../presentation/volcano-presentation";
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

// ── 本体 ──

export class VolcanoRouteHandler {
  private readonly volcanoState: VolcanoStateHolder;
  private readonly notifier: Notifier;
  private readonly runDisplayPipeline: DisplayPipelineFn;
  private readonly display?: DisplayCallbacks;
  private readonly aggregator: VolcanoVfvo53Aggregator;

  constructor(deps: VolcanoRouteHandlerDeps) {
    this.volcanoState = deps.volcanoState;
    this.notifier = deps.notifier;
    this.runDisplayPipeline = deps.runDisplayPipeline;
    this.display = deps.display;

    this.aggregator = new VolcanoVfvo53Aggregator(
      (info, opts, msg) => this.emitSingle(info, opts, msg),
      (batch, opts) => this.emitBatch(batch, opts),
    );
  }

  /**
   * 火山電文を処理する。
   * @returns パース成功なら ParsedVolcanoInfo (統計記録用)、失敗なら null。
   */
  handle(msg: WsDataMessage): ParsedVolcanoInfo | null {
    const volcanoInfo = parseVolcanoTelegram(msg);
    if (!volcanoInfo) return null;

    this.aggregator.handle(volcanoInfo, msg);
    return volcanoInfo;
  }

  /** 保留中の火山バッファを flush してリソースを破棄する */
  flushAndDispose(): void {
    this.aggregator.flushAndDispose();
  }

  // ── private: emit callbacks ──

  private emitSingle(
    info: ParsedVolcanoInfo,
    opts?: FlushOptions,
    msg?: WsDataMessage,
  ): void {
    const outcome = msg
      ? buildVolcanoOutcome(msg, info, this.volcanoState)
      : null;

    const presentation = resolveVolcanoPresentation(info, this.volcanoState);
    if (!this.volcanoState.update(info)) return;

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

  }

  private emitBatch(batch: Vfvo53BatchItems, opts: FlushOptions): void {
    const presentation = resolveVolcanoBatchPresentation(batch);

    if (opts.notify) {
      this.notifier.notifyVolcanoBatch(batch, presentation);
    }

    const rawSources = batch.sources ?? [];
    const complete = rawSources.filter(
      (source): source is { info: ParsedVolcanoAshfallInfo; msg: WsDataMessage } => source.msg != null,
    );
    const batchMsg = complete[0]?.msg;
    const sources = complete.length === rawSources.length ? complete : [];

    if (batchMsg && sources.length !== rawSources.length) {
      log.warn(`VFVO53 バッチ: source msg 欠落のため表示分割を縮退 (${complete.length}/${rawSources.length})`);
    }

    if (batchMsg) {
      const batchOutcome: VolcanoBatchOutcome = {
        domain: "volcano",
        msg: batchMsg,
        headType: batchMsg.head.type,
        statsCategory: "volcano",
        parsed: batch.items,
        sources,
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

  }
}
