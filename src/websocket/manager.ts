import WebSocket from "ws";
import { AppConfig, WsMessage, WsDataMessage } from "../types";
import { prepareAndStartSocket } from "../api/client";
import * as log from "../utils/logger";

export interface WsManagerStatus {
  connected: boolean;
  socketId: number | null;
  reconnectAttempt: number;
}

export interface WsManagerEvents {
  onData: (msg: WsDataMessage) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}

export class WebSocketManager {
  private config: AppConfig;
  private events: WsManagerEvents;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPingId: string | null = null;
  private shouldRun = true;
  private socketId: number | null = null;

  constructor(config: AppConfig, events: WsManagerEvents) {
    this.config = config;
    this.events = events;
  }

  /** 接続を開始する */
  async connect(): Promise<void> {
    this.shouldRun = true;
    await this.doConnect();
  }

  /** 接続状態を返す */
  getStatus(): WsManagerStatus {
    return {
      connected: this.ws != null && this.ws.readyState === WebSocket.OPEN,
      socketId: this.socketId,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  /** 接続を停止する */
  close(): void {
    this.shouldRun = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "client shutdown");
      this.ws = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      log.info("Socket Start を実行中...");
      const startRes = await prepareAndStartSocket(this.config);

      if (!startRes.websocket) {
        throw new Error("WebSocket URL が取得できませんでした");
      }

      const wsUrl = startRes.websocket.url;
      log.info(`WebSocket に接続中: ${wsUrl.replace(/ticket=.*/, "ticket=***")}`);

      this.ws = new WebSocket(wsUrl, ["dmdata.v2"]);

      this.ws.on("open", () => {
        this.reconnectAttempt = 0;
        log.info("WebSocket 接続成功");
        this.events.onConnected();
      });

      this.ws.on("message", (raw: WebSocket.Data) => {
        this.handleMessage(raw);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || `code=${code}`;
        log.warn(`WebSocket 切断: ${reasonStr}`);
        this.clearTimers();
        this.ws = null;
        this.events.onDisconnected(reasonStr);
        this.scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
        log.error(`WebSocket エラー: ${err.message}`);
      });
    } catch (err) {
      log.error(
        `接続失敗: ${err instanceof Error ? err.message : err}`
      );
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: WebSocket.Data): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log.error("受信データのJSONパースに失敗");
      return;
    }

    switch (msg.type) {
      case "start":
        this.socketId = msg.socketId;
        log.info(
          `セッション開始: socketId=${msg.socketId}, 区分=[${msg.classifications.join(", ")}]`
        );
        break;

      case "ping":
        this.lastPingId = msg.pingId;
        this.sendPong(msg.pingId);
        break;

      case "pong":
        log.debug("Pong 受信");
        break;

      case "data":
        log.debug(
          `データ受信: type=${msg.head.type}, id=${msg.id.slice(0, 16)}...`
        );
        this.events.onData(msg);
        break;

      case "error":
        log.error(
          `サーバーエラー: ${msg.error.message} (code=${msg.error.code})`
        );
        break;

      default:
        log.debug(`未知のメッセージタイプ: ${(msg as { type: string }).type}`);
    }
  }

  private sendPong(pingId: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pong", pingId }));
      log.debug(`Pong 送信: pingId=${pingId}`);
    }
  }

  /** 指数バックオフで再接続をスケジュール */
  private scheduleReconnect(): void {
    if (!this.shouldRun) return;

    this.reconnectAttempt++;
    // 指数バックオフ: 1, 2, 4, 8, ... 秒（上限あり）
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.config.maxReconnectDelaySec * 1000
    );

    log.info(
      `${(delay / 1000).toFixed(0)}秒後に再接続します (試行 #${this.reconnectAttempt})`
    );

    this.reconnectTimer = setTimeout(async () => {
      await this.doConnect();
    }, delay);
  }
}
