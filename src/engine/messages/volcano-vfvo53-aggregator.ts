/**
 * VFVO53（降灰予報・定時）アグリゲータ
 *
 * 定時で一斉に届く複数火山の VFVO53 をバッファリングし、
 * まとめて1フレームとして表示・通知するための集約モジュール。
 *
 * - バッチキー: reportDateTime + isTest で同一発表サイクルをグルーピング
 * - 同一火山は volcanoCode で上書き（訂正/重複対応）
 * - 取消電文は即時表示 + バッファから除去
 * - VFVO54 等の割り込みはバッファを通知なし flush してから通常処理
 * - 単発なら既存の単発表示にフォールバック
 */

import type { ParsedVolcanoAshfallInfo, ParsedVolcanoInfo, WsDataMessage } from "../../types";
import * as log from "../../logger";

// ── 公開型 ──

/** バッチ flush 時に渡されるまとめデータ */
export interface Vfvo53BatchItems {
  reportDateTime: string;
  isTest: boolean;
  items: ParsedVolcanoAshfallInfo[];
  sources?: Vfvo53SourceItem[];
}

/** Parsed item paired with the websocket message that produced it. */
export interface Vfvo53SourceItem {
  info: ParsedVolcanoAshfallInfo;
  msg?: WsDataMessage;
}

/** flush オプション */
export interface FlushOptions {
  notify: boolean;
}

// ── デフォルト定数 ──

const DEFAULT_QUIET_MS = 8_000;
const DEFAULT_MAX_WAIT_MS = 90_000;
const DEFAULT_MAX_ITEMS = 20;

// ── flush reason ──

type FlushReason = "quiet" | "maxWait" | "maxItems" | "interrupt" | "shutdown" | "newBatchKey" | "dispose";

// ── 本体 ──

export class VolcanoVfvo53Aggregator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private batchKey: string | null = null;
  private startedAt = 0;
  private items = new Map<string, Vfvo53SourceItem>();
  private disposed = false;

  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly maxItems: number;

  constructor(
    private readonly emitSingle: (
      info: ParsedVolcanoInfo,
      opts?: FlushOptions,
      msg?: WsDataMessage,
    ) => void,
    private readonly emitBatch: (batch: Vfvo53BatchItems, opts: FlushOptions) => void,
    opts?: { quietMs?: number; maxWaitMs?: number; maxItems?: number },
  ) {
    this.quietMs = opts?.quietMs ?? DEFAULT_QUIET_MS;
    this.maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  /** 火山電文を処理する。VFVO53 定時ならバッファリング、それ以外は即時委譲 */
  handle(info: ParsedVolcanoInfo, msg?: WsDataMessage): void {
    if (this.disposed) {
      this.emitSingleWithSource(info, undefined, msg);
      return;
    }

    // VFVO53 ashfall の判定
    if (info.kind === "ashfall" && info.type === "VFVO53") {
      // 取消電文: 即時表示 + バッファから該当火山を除去
      if (info.infoType === "取消") {
        this.removeCancelled(info);
        this.emitSingleWithSource(info, undefined, msg);
        return;
      }
      // 定時 → バッファリング対象
      this.buffer(info, msg);
      return;
    }

    // その他の火山電文: pending があれば通知なし flush してから即時委譲
    if (this.items.size > 0) {
      this.flush("interrupt", { notify: false });
    }
    this.emitSingleWithSource(info, undefined, msg);
  }

  /** 保留中のバッファを全 flush し、タイマーを破棄する */
  flushAndDispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.items.size > 0) {
      this.flush("dispose", { notify: true });
    }
    this.clearTimer();
  }

  // ── private ──

  private buffer(info: ParsedVolcanoAshfallInfo, msg?: WsDataMessage): void {
    const key = `${info.reportDateTime}:${info.isTest}`;

    // バッチキー不一致 → 先行バッチを flush してから新バッチ開始
    if (this.batchKey !== null && this.batchKey !== key) {
      this.flush("newBatchKey", { notify: true });
    }

    const now = Date.now();
    if (this.batchKey === null) {
      this.startedAt = now;
    }
    this.batchKey = key;
    this.items.set(info.volcanoCode, { info, msg });

    // maxItems 到達で即 flush
    if (this.items.size >= this.maxItems) {
      this.flush("maxItems", { notify: true });
      return;
    }

    this.armTimer();
  }

  private removeCancelled(info: ParsedVolcanoAshfallInfo): void {
    if (this.items.has(info.volcanoCode)) {
      this.items.delete(info.volcanoCode);
      log.debug(`VFVO53 aggregator: removed cancelled ${info.volcanoCode} from buffer`);

      if (this.items.size === 0) {
        this.clearTimer();
        this.batchKey = null;
        this.startedAt = 0;
      }
    }
  }

  private armTimer(): void {
    this.clearTimer();
    const elapsed = Date.now() - this.startedAt;
    const remainMax = this.maxWaitMs - elapsed;
    const delay = Math.max(10, Math.min(this.quietMs, remainMax));
    this.timer = setTimeout(() => {
      const reason: FlushReason = delay < this.quietMs ? "maxWait" : "quiet";
      this.flush(reason, { notify: true });
    }, delay);
  }

  private flush(reason: FlushReason, opts: FlushOptions): void {
    this.clearTimer();

    const sources = [...this.items.values()].sort((a, b) =>
      a.info.volcanoName.localeCompare(b.info.volcanoName, "ja"),
    );
    const items = sources.map((source) => source.info);

    log.debug(`VFVO53 aggregator: flush reason=${reason}, count=${items.length}`);

    if (items.length === 1) {
      this.emitSingleWithSource(items[0], opts, sources[0].msg);
    } else if (items.length > 1) {
      this.emitBatch(
        {
          reportDateTime: items[0].reportDateTime,
          isTest: items[0].isTest,
          items,
          sources,
        },
        opts,
      );
    }

    this.items.clear();
    this.batchKey = null;
    this.startedAt = 0;
  }

  private emitSingleWithSource(
    info: ParsedVolcanoInfo,
    opts?: FlushOptions,
    msg?: WsDataMessage,
  ): void {
    if (msg == null) {
      if (opts == null) {
        this.emitSingle(info);
      } else {
        this.emitSingle(info, opts);
      }
      return;
    }
    this.emitSingle(info, opts, msg);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
