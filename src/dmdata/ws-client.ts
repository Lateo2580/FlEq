import WebSocket from "ws";
import { AppConfig, WsDataMessage, WsPingMessage } from "../types";
import { prepareAndStartSocket } from "./rest-client";
import { EndpointSelector } from "./endpoint-selector";
import { ConnectionManager } from "./connection-manager";
import {
  CLASSIFICATION_HEAD_TYPE_REGISTRY,
  cloneDeliveryCapabilities,
  createUnknownDeliveryCapabilities,
  getVerifiedContractClassifications,
  guaranteedHeadTypesForClassifications,
  ClassificationHeadTypeRegistry,
  DeliveryCapabilities,
} from "./delivery-capabilities";
import * as log from "../logger";
import { normalizeTelegramMessage } from "./telegram-ingress";

export interface WsManagerStatus {
  connected: boolean;
  socketId: number | null;
  reconnectAttempt: number;
  heartbeatDeadlineAt: number | null;
}

export interface WsManagerEvents {
  onData: (msg: WsDataMessage, transport?: WsTransportIdentity) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}

/** start acknowledgement に固定された repair proof 用 transport identity。 */
export interface WsSubscriptionAcknowledgement {
  subscriptionGeneration: number;
  socketId: number;
  transportId: string;
  acknowledgedAtMs: number;
  classifications: string[];
}

/** 一つの data message が属する acknowledged subscription。 */
export interface WsTransportIdentity extends WsSubscriptionAcknowledgement {
  receivedAtMs: number;
}

/** WebSocketManager の接続時計・世代を差し替えるための依存性注入。 */
export interface WsManagerOptions {
  now?: () => number;
  nextSocketGeneration?: () => number;
  verifiedContractClassifications?: readonly string[];
  deliveryCapabilityRegistry?: ClassificationHeadTypeRegistry;
}

/** サーバーからの ping が途絶えたとみなすまでのミリ秒 */
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** 再接続ジッターの最大値 (ミリ秒) */
const RECONNECT_JITTER_MS = 1_000;

/** 受信オブジェクトが WsDataMessage の必須フィールドを持つか確認 */
export function isWsDataMessage(parsed: unknown): parsed is WsDataMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  if (typeof msg["id"] !== "string") return false;
  if (typeof msg["head"] !== "object" || msg["head"] == null) return false;
  const head = msg["head"] as Record<string, unknown>;
  if (typeof head["type"] !== "string" || typeof head["test"] !== "boolean") {
    return false;
  }
  const xmlReport = msg["xmlReport"];
  if (xmlReport != null) {
    if (typeof xmlReport !== "object" || Array.isArray(xmlReport)) return false;
    const control = (xmlReport as Record<string, unknown>)["control"];
    if (control != null) {
      if (typeof control !== "object" || Array.isArray(control)) return false;
      const status = (control as Record<string, unknown>)["status"];
      if (status != null && typeof status !== "string") return false;
    }
  }
  return true;
}

interface WsCapabilityStartMessage {
  type: "start";
  socketId: number;
  classifications: string[];
}

function isWsCapabilityStartMessage(
  parsed: unknown,
): parsed is WsCapabilityStartMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  if (msg["type"] !== "start") return false;
  if (typeof msg["socketId"] !== "number" || !Number.isFinite(msg["socketId"])) {
    return false;
  }
  const classifications = msg["classifications"];
  return Array.isArray(classifications)
    && classifications.every((classification) => typeof classification === "string");
}

function sameClassifications(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((classification, index) => classification === right[index]);
}

function isWsPingMessage(parsed: unknown): parsed is WsPingMessage {
  if (typeof parsed !== "object" || parsed == null) return false;
  const msg = parsed as Record<string, unknown>;
  return typeof msg["pingId"] === "string";
}

export class WebSocketManager implements ConnectionManager {
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
  private endpointSelector = new EndpointSelector();
  /** connect 世代番号 — close() 時にインクリメントして in-flight connect を無効化する */
  private connectSeq = 0;
  private readonly now: () => number;
  private readonly nextSocketGeneration: () => number;
  private readonly verifiedContractClassifications: readonly string[] | null;
  private readonly deliveryCapabilityRegistry: ClassificationHeadTypeRegistry;
  /** WebSocket インスタンス単位の capability 世代。古い start を現行世代へ混ぜない。 */
  private activeSocketGeneration: number | null = null;
  private startConfirmedGeneration: number | null = null;
  private effectiveClassifications: readonly string[] = [];
  private latchedStart: WsCapabilityStartMessage | null = null;
  private invalidatedSocketGeneration: number | null = null;
  private acknowledgement: WsSubscriptionAcknowledgement | null = null;
  private readonly acknowledgementWaiters = new Set<{
    resolve: (value: WsSubscriptionAcknowledgement) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(
    config: AppConfig,
    events: WsManagerEvents,
    options?: WsManagerOptions,
  ) {
    this.config = config;
    this.events = events;
    this.now = options?.now ?? Date.now;
    let localSocketGeneration = 0;
    this.nextSocketGeneration = options?.nextSocketGeneration
      ?? (() => ++localSocketGeneration);
    const verifiedClassifications =
      options?.verifiedContractClassifications
      ?? getVerifiedContractClassifications(config);
    this.verifiedContractClassifications = verifiedClassifications == null
      ? null
      : Object.freeze([...verifiedClassifications]);
    this.deliveryCapabilityRegistry =
      options?.deliveryCapabilityRegistry ?? CLASSIFICATION_HEAD_TYPE_REGISTRY;
  }

  /** 接続を開始する */
  async connect(): Promise<void> {
    this.shouldRun = true;
    this.resetDeliveryCapability();
    // 既存の再接続タイマーと CONNECTING 中のソケットを中止してから新規接続する
    this.cancelInflight();
    const seq = ++this.connectSeq;
    await this.doConnect(seq);
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

  /** 現行 primary subscription の start acknowledgement。 */
  getSubscriptionAcknowledgement(): WsSubscriptionAcknowledgement | null {
    return this.acknowledgement == null ? null : structuredClone(this.acknowledgement);
  }

  /**
   * open ではなく server の start acknowledgement まで待つ。
   * 切断・世代交代・不正 start は pending proof を明示的に失敗させる。
   */
  waitForSubscriptionAcknowledgement(): Promise<WsSubscriptionAcknowledgement> {
    if (this.acknowledgement != null) {
      return Promise.resolve(structuredClone(this.acknowledgement));
    }
    if (!this.shouldRun) return Promise.reject(new Error("WebSocket manager is closed"));
    return new Promise((resolve, reject) => {
      this.acknowledgementWaiters.add({ resolve, reject });
    });
  }

  /** 現行 socket の start と契約情報から配送 capability を返す。 */
  getDeliveryCapabilities(): DeliveryCapabilities {
    const connected = this.ws != null && this.ws.readyState === WebSocket.OPEN;
    const generation = this.activeSocketGeneration;
    if (
      !connected
      || generation == null
      || this.startConfirmedGeneration !== generation
    ) {
      return createUnknownDeliveryCapabilities(connected);
    }

    const effectiveClassifications = [...this.effectiveClassifications];
    if (this.verifiedContractClassifications == null) {
      return cloneDeliveryCapabilities({
        connected,
        effectiveClassifications,
        guaranteedHeadTypes: new Set<string>(),
        source: "socket-start",
      });
    }

    const verified = new Set(this.verifiedContractClassifications);
    const contractedSocketClassifications = effectiveClassifications.filter(
      (classification) => verified.has(classification),
    );
    return cloneDeliveryCapabilities({
      connected,
      effectiveClassifications,
      guaranteedHeadTypes: guaranteedHeadTypesForClassifications(
        contractedSocketClassifications,
        this.deliveryCapabilityRegistry,
      ),
      source: "contract-and-socket",
    });
  }

  /** 接続を停止する */
  close(): void {
    this.shouldRun = false;
    this.connectSeq++;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "client shutdown");
      this.ws = null;
    }
    this.heartbeatDeadlineAt = null;
    this.rejectAcknowledgementWaiters("subscription closed");
    this.resetDeliveryCapability();
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

  /** 新しい WebSocket 世代を開始し、start 確認前の unknown へ戻す。 */
  private beginSocketGeneration(generation: number): void {
    if (this.activeSocketGeneration != null) {
      this.rejectAcknowledgementWaiters("subscription generation changed");
    }
    this.activeSocketGeneration = generation;
    this.startConfirmedGeneration = null;
    this.effectiveClassifications = [];
    this.latchedStart = null;
    this.invalidatedSocketGeneration = null;
    this.acknowledgement = null;
  }

  /** start の保証根拠を破棄する。transport の切断・再接続開始時に必ず呼ぶ。 */
  private resetDeliveryCapability(): void {
    this.activeSocketGeneration = null;
    this.startConfirmedGeneration = null;
    this.effectiveClassifications = [];
    this.latchedStart = null;
    this.invalidatedSocketGeneration = null;
    this.acknowledgement = null;
  }

  private rejectAcknowledgementWaiters(reason: string): void {
    const error = new Error(reason);
    for (const waiter of this.acknowledgementWaiters) waiter.reject(error);
    this.acknowledgementWaiters.clear();
  }

  private resolveAcknowledgementWaiters(value: WsSubscriptionAcknowledgement): void {
    for (const waiter of this.acknowledgementWaiters) waiter.resolve(structuredClone(value));
    this.acknowledgementWaiters.clear();
  }

  /** 現行 socket 世代を unknown に固定する。切断までは後続 start で回復させない。 */
  private invalidateDeliveryCapability(socketGeneration: number): void {
    if (this.activeSocketGeneration !== socketGeneration) return;
    this.startConfirmedGeneration = null;
    this.effectiveClassifications = [];
    this.invalidatedSocketGeneration = socketGeneration;
    this.acknowledgement = null;
    this.rejectAcknowledgementWaiters("subscription acknowledgement invalidated");
  }

  /** 再接続タイマーと CONNECTING 中のソケットを中止する */
  private cancelInflight(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // CONNECTING 中のソケットがあれば閉じて孤立を防止
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {
        // close() 自体の失敗は無視
      }
      this.ws = null;
    }
  }

  /** close/error 共通の切断後処理 */
  private onDisconnect(reason: string): void {
    this.clearTimers();
    this.rejectAcknowledgementWaiters(`subscription disconnected: ${reason}`);
    this.resetDeliveryCapability();
    this.ws = null;
    this.previousSocketId = this.socketId;
    this.socketId = null;
    this.heartbeatDeadlineAt = null;
    this.endpointSelector.recordDisconnected();
    this.events.onDisconnected(reason);
    this.scheduleReconnect();
  }

  private async doConnect(seq: number): Promise<void> {
    try {
      // REST API 呼び出し前に世代チェック — 古い再接続タイマーやシャットダウン後の呼び出しを弾く
      if (!this.shouldRun || seq !== this.connectSeq) {
        log.debug("接続中断(pre-API): shouldRun=false または世代不一致");
        return;
      }

      log.info("Socket Start を実行中...");
      const startRes = await prepareAndStartSocket(this.config, this.previousSocketId ?? undefined);

      // REST API 完了後に再度世代チェック — API 呼び出し中に close() や新しい connect() が来た場合を検出
      if (!this.shouldRun || seq !== this.connectSeq) {
        log.debug("接続中断(post-API): close() または新しい connect() が呼ばれたため新しいソケットを作成しません");
        return;
      }

      if (!startRes.websocket) {
        throw new Error("WebSocket URL が取得できませんでした");
      }

      const wsUrl = this.endpointSelector.resolveUrl(startRes.websocket.url);
      log.info(`WebSocket に接続中: ${wsUrl.replace(/ticket=.*/, "ticket=***")}`);

      // WebSocket 作成前に最終チェック
      if (!this.shouldRun || seq !== this.connectSeq) {
        log.debug("接続中断(pre-WS): close() または新しい connect() が呼ばれたため WebSocket を作成しません");
        return;
      }

      const socket = new WebSocket(wsUrl, ["dmdata.v2"]);
      const socketGeneration = this.nextSocketGeneration();
      this.beginSocketGeneration(socketGeneration);
      this.ws = socket;

      socket.on("open", () => {
        // 古いソケットのイベントが遅延到着した場合はスキップ
        if (this.ws !== socket) return;
        this.reconnectAttempt = 0;
        this.previousSocketId = null;
        this.endpointSelector.recordConnected(wsUrl);
        log.info("WebSocket 接続成功");
        this.resetHeartbeat();
        this.events.onConnected();
      });

      socket.on("message", (raw: WebSocket.Data) => {
        if (this.ws !== socket) return;
        this.handleMessage(raw, socketGeneration);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        // 古いソケット or 既に処理済みならスキップ
        if (this.ws !== socket) return;
        const reasonStr = reason.toString() || `code=${code}`;
        log.warn(`WebSocket 切断: ${reasonStr}`);
        this.onDisconnect(reasonStr);
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
        this.onDisconnect(`error: ${err.message}`);
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

  private handleMessage(raw: WebSocket.Data, socketGeneration: number): void {
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
        this.handleStartMessage(parsed, socketGeneration);
        break;

      case "ping":
        this.handlePingMessage(parsed);
        break;

      case "pong":
        log.debug("Pong 受信");
        break;

      case "data":
        this.handleDataMessage(parsed, socketGeneration);
        break;

      case "error":
        this.logServerError(messageObject);
        break;

      default:
        log.debug(`未知のメッセージタイプ: ${messageType ?? "(型なし)"}`);
    }
  }

  private handleStartMessage(parsed: unknown, socketGeneration: number): void {
    if (this.activeSocketGeneration !== socketGeneration) return;
    if (!isWsCapabilityStartMessage(parsed)) {
      this.invalidateDeliveryCapability(socketGeneration);
      log.warn("start メッセージのスキーマが不正です");
      return;
    }

    if (this.invalidatedSocketGeneration === socketGeneration) return;

    if (this.latchedStart != null) {
      const isExactDuplicate = this.latchedStart.socketId === parsed.socketId
        && sameClassifications(
          this.latchedStart.classifications,
          parsed.classifications,
        );
      if (isExactDuplicate) return;

      this.invalidateDeliveryCapability(socketGeneration);
      log.warn("同一 socket 世代で内容の異なる start を受信したため capability を unknown に戻します");
      return;
    }

    this.latchedStart = {
      type: "start",
      socketId: parsed.socketId,
      classifications: [...parsed.classifications],
    };
    this.socketId = parsed.socketId;
    this.startConfirmedGeneration = socketGeneration;
    this.effectiveClassifications = [...parsed.classifications];
    const acknowledgement: WsSubscriptionAcknowledgement = {
      subscriptionGeneration: socketGeneration,
      socketId: parsed.socketId,
      transportId: `socket:${parsed.socketId}:generation:${socketGeneration}`,
      acknowledgedAtMs: this.now(),
      classifications: [...parsed.classifications],
    };
    this.acknowledgement = acknowledgement;
    this.resolveAcknowledgementWaiters(acknowledgement);
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

  private handleDataMessage(parsed: unknown, socketGeneration: number): void {
    if (!isWsDataMessage(parsed)) {
      log.warn("data メッセージのスキーマが不正です (id/head/head.type が欠落)");
      return;
    }
    const receivedAtMs = this.now();
    // `meta` is locally owned.  Never accept a transport-supplied object that
    // could replace the receipt clock used by revision retention and repair.
    const { meta: _untrustedMeta, ...transportMessage } = parsed;
    const normalized = normalizeTelegramMessage(transportMessage, receivedAtMs).message;
    this.resetHeartbeat();
    log.debug(
      `データ受信: type=${normalized.head.type}, id=${normalized.id.slice(0, 16)}...`
    );
    const acknowledged = this.acknowledgement;
    const transport = acknowledged != null
      && acknowledged.subscriptionGeneration === socketGeneration
      ? { ...structuredClone(acknowledged), receivedAtMs }
      : undefined;
    if (transport == null) this.events.onData(normalized);
    else this.events.onData(normalized, transport);
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
    this.heartbeatDeadlineAt = this.now() + HEARTBEAT_TIMEOUT_MS;
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

    const currentSeq = this.connectSeq;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // タイマー発火時に世代が変わっていたら（手動 retry や close() があった）何もしない
      if (!this.shouldRun || currentSeq !== this.connectSeq) {
        log.debug("再接続タイマー発火をスキップ: shouldRun=false または世代不一致");
        return;
      }
      await this.doConnect(currentSeq);
    }, delay);
  }
}
