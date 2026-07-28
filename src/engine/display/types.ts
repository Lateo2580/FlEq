export * from "./protocol";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayServerMessage, DisplayStatsV1 } from "./protocol";

/** broadcast 1 回の配送結果。authoritative sync (tickerSynced) が全 client に届いたかを判定する */
export interface DisplayBroadcastResult {
  /** 配信対象だった client 総数 (broadcast 開始時点) */
  total: number;
  /** 既に blocked (backpressure) で今回の配信をスキップされた、または上限超過で切断され、
   *  この message を受け取れなかった client 数。0 なら全 client の socket buffer へ届いている */
  blockedSkipped: number;
}

export interface DisplayTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(msg: DisplayServerMessage): DisplayBroadcastResult;
  clientCount(): number;
}

export interface DisplayIngestSink {
  ingest(event: PresentationEvent): void;
  /** monitor 所有の表示状態が変化したとき、snapshot の再配信を要求する。 */
  markExternalStateDirty?(): void;
  publishStats?(stats: DisplayStatsV1): void;
}
