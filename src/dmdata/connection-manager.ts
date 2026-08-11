import { WsManagerStatus } from "./ws-client";
import type { DeliveryCapabilities } from "./delivery-capabilities";

/**
 * WebSocket 接続管理の共通インターフェース。
 * 単一接続 (WebSocketManager) と複線接続 (MultiConnectionManager) の両方がこれを実装する。
 */
export interface ConnectionManager {
  connect(): Promise<void>;
  getStatus(): WsManagerStatus;
  /** 配送 capability。旧実装・UI 用 mock との互換性のため optional な additive API とする。 */
  getDeliveryCapabilities?(): DeliveryCapabilities;
  close(): void;
}
