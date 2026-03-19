import { WsManagerStatus } from "./ws-client";

/**
 * WebSocket 接続管理の共通インターフェース。
 * 単一接続 (WebSocketManager) と複線接続 (MultiConnectionManager) の両方がこれを実装する。
 */
export interface ConnectionManager {
  connect(): Promise<void>;
  getStatus(): WsManagerStatus;
  close(): void;
}
