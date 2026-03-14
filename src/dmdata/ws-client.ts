import WebSocket from "ws";
import { AppConfig, WsDataMessage, WsStartMessage, WsPingMessage } from "../types";
import { prepareAndStartSocket } from "./rest-client";
import * as log from "../logger";

export interface WsManagerStatus {
  connected: boolean;
  socketId: number | null;
  reconnectAttempt: number;
  heartbeatDeadlineAt: number | null;
}

export interface WsManagerEvents {
  onData: (msg: WsDataMessage) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}

/** サーバーからの ping が途絶えたとみなすまでのミリ秒 */
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** 再接続ジッターの最大値 (ミリ秒) */
const RECONNECT_JITTER_MS = 1_000;

/** 受信オブジェクトが WsDataMessage の必須フィールドを持つか確認 */
function isWsDataMessage(parsed: unknown): parsed is WsDataMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  if (typeof msg["id"] !== "string") return false;
  if (typeof msg["head"] !== "object" || msg["head"] == null) return false;
  const head = msg["head"] as Record<string, unknown>;
  return typeof head["type"] === "string";
}

function isWsStartMessage(parsed: unknown): parsed is WsStartMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  return typeof msg["socketId"] === "number" && Array.isArray(msg["classifications"]);
}

function isWsPingMessage(parsed: unknown): parsed is WsPingMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  return typeof msg["pingId"] === "string";
}

export class WebSocketManager {
  private config: AppConfig;
  private events: WsManagerEvents;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shouldRun = true;
  private socketId: number | null = null;
  private previousSocketId: number | null = null;
  private heartbeatDeadlineAt: number | null = null;

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
      heartbeatDeadlineAt: this.heartbeatDeadlineAt,
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
    this.heartbeatDeadlineAt = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      log.info("Socket Start を実行中...");
      const startRes = await prepareAndStartSocket(this.config, this.previousSocketId ?? undefined);

      if (!startRes.websocket) {
        throw new Error("WebSocket URL が取得できませんでした");
      }

      const wsUrl = startRes.websocket.url;
      log.info(`WebSocket に接続中: ${wsUrl.replace(/ticket=.*/, "ticket=***")}`);

      const socket = new WebSocket(wsUrl, ["dmdata.v2"]);
      this.ws = socket;

      socket.on("open", () => {
        // 古いソケットのイベントが遅延到着した場合はスキップ
        if (this.ws !== socket) return;
        this.reconnectAttempt = 0;
        this.previousSocketId = null;
        log.info("WebSocket 接続成功");
        this.resetHeartbeat();
        this.events.onConnected();
      });

      socket.on("message", (raw: WebSocket.Data) => {
        if (this.ws !== socket) return;
        this.handleMessage(raw);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        // 古いソケット or 既に処理済みならスキップ
        if (this.ws !== socket) return;
        const reasonStr = reason.toString() || `code=${code}`;
        log.warn(`WebSocket 切断: ${reasonStr}`);
        this.clearTimers();
        this.ws = null;
        this.previousSocketId = this.socketId;
        this.socketId = null;
        this.heartbeatDeadlineAt = null;
        this.events.onDisconnected(reasonStr);
        this.scheduleReconnect();
      });

      socket.on("error", (err: Error) => {
        log.error(`WebSocket エラー: ${err.message}`);
        // 古いソケットのエラーは無視
        if (this.ws !== socket) return;
        try {
          socket.close();
        } catch {
          // close() 自体の失敗は無視
        }
        this.clearTimers();
        this.ws = null;
        this.previousSocketId = this.socketId;
        this.socketId = null;
        this.heartbeatDeadlineAt = null;
        this.events.onDisconnected(`error: ${err.message}`);
        this.scheduleReconnect();
      });
    } catch (err) {
      log.error(
        `接続失敗: ${err instanceof Error ? err.message : err}`
      );
      this.scheduleReconnect();
    }
  }

  /** WebSocket.Data を文字列に安全に変換する */
  private static normalizeWsData(raw: WebSocket.Data): string {
    if (typeof raw === "string") return raw;
    if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf-8");
    if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf-8");
    return String(raw);
  }

  private handleMessage(raw: WebSocket.Data): void {
    let parsed: unknown;
    try {
      const text = WebSocketManager.normalizeWsData(raw);
      parsed = JSON.parse(text);
    } catch {
      log.error("受信データのJSONパースに失敗");
      return;
    }

    if (typeof parsed !== "object" || parsed == null) {
      log.warn("受信データが不正な形式です");
      return;
    }

    const messageObject = parsed as Record<string, unknown>;
    const messageType = typeof messageObject["type"] === "string" ? messageObject["type"] : null;

    switch (messageType) {
      case "start":
        this.handleStartMessage(parsed);
        break;

      case "ping":
        this.handlePingMessage(parsed);
        break;

      case "pong":
        log.debug("Pong 受信");
        break;

      case "data":
        this.handleDataMessage(parsed);
        break;

      case "error":
        this.logServerError(messageObject);
        break;

      default:
        log.debug(`未知のメッセージタイプ: ${messageType ?? "(型なし)"}`);
    }
  }

  private handleStartMessage(parsed: unknown): void {
    if (!isWsStartMessage(parsed)) {
      log.warn("start メッセージのスキーマが不正です");
      return;
    }
    this.socketId = parsed.socketId;
    log.info(`セッション開始: socketId=${parsed.socketId}`);
    log.info(`区分: [${parsed.classifications.join(", ")}]`);
  }

  private handlePingMessage(parsed: unknown): void {
    if (!isWsPingMessage(parsed)) {
      log.warn("ping メッセージのスキーマが不正です");
      return;
    }
    this.resetHeartbeat();
    this.sendPong(parsed.pingId);
  }

  private handleDataMessage(parsed: unknown): void {
    if (!isWsDataMessage(parsed)) {
      log.warn("data メッセージのスキーマが不正です (id/head/head.type が欠落)");
      return;
    }
    this.resetHeartbeat();
    log.debug(
      `データ受信: type=${parsed.head.type}, id=${parsed.id.slice(0, 16)}...`
    );
    this.events.onData(parsed);
  }

  private logServerError(messageObject: Record<string, unknown>): void {
    const errorObj = messageObject["error"];
    let errMsg: string;
    let errCode: string;
    if (typeof errorObj === "object" && errorObj != null) {
      // error がオブジェクト形式: { error: { message, code } }
      const e = errorObj as Record<string, unknown>;
      errMsg = String(e["message"] ?? "unknown");
      errCode = String(e["code"] ?? "unknown");
    } else if (typeof errorObj === "string") {
      // error が文字列形式: { error: "Closed by user.", code: 4808 }
      errMsg = errorObj;
      errCode = String(messageObject["code"] ?? "unknown");
    } else {
      errMsg = JSON.stringify(messageObject);
      errCode = "unknown";
    }
    log.error(`サーバーエラー: ${errMsg} (code=${errCode})`);
  }

  private sendPong(pingId: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pong", pingId }));
      log.debug(`Pong 送信: pingId=${pingId}`);
    }
  }

  /** ハートビートタイマーをリセット (ping/data 受信時に呼ぶ) */
  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatDeadlineAt = Date.now() + HEARTBEAT_TIMEOUT_MS;
    this.heartbeatTimer = setTimeout(() => {
      log.warn(
        `ハートビートタイムアウト: ${HEARTBEAT_TIMEOUT_MS / 1000}秒間 ping を受信していません`
      );
      this.heartbeatDeadlineAt = null;
      if (this.ws) {
        this.ws.close(4000, "heartbeat timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  /** 指数バックオフで再接続をスケジュール */
  private scheduleReconnect(): void {
    if (!this.shouldRun) return;

    // 既にタイマーがスケジュール済みなら重複を防止
    if (this.reconnectTimer) {
      log.debug("再接続タイマーは既にスケジュール済みです");
      return;
    }

    this.reconnectAttempt++;
    // 指数バックオフ: 1, 2, 4, 8, ... 秒（上限あり）+ ジッター
    const baseDelay = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.config.maxReconnectDelaySec * 1000
    );
    const jitter = Math.random() * RECONNECT_JITTER_MS;
    const delay = baseDelay + jitter;

    log.info(
      `${(delay / 1000).toFixed(1)}秒後に再接続します (試行 #${this.reconnectAttempt})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.doConnect();
    }, delay);
  }
}
