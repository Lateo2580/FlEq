import { AppConfig, WsDataMessage, Classification } from "../types";
import { ConnectionManager } from "./connection-manager";
import {
  WebSocketManager,
  WsManagerOptions,
  WsManagerStatus,
  WsManagerEvents,
} from "./ws-client";
import {
  ClassificationHeadTypeRegistry,
  cloneDeliveryCapabilities,
  CLASSIFICATION_HEAD_TYPE_REGISTRY,
  createUnknownDeliveryCapabilities,
  DeliveryCapabilities,
  getVerifiedContractClassifications,
} from "./delivery-capabilities";
import * as log from "../logger";

/** startBackup() の結果 */
export type StartBackupResult =
  | "started"
  | "already_running"
  | "no_eew_contract";

/** 重複排除の最大キープ数 */
const SEEN_IDS_MAX = 500;

/** EEW 関連の分類区分 */
const EEW_CLASSIFICATIONS: Classification[] = ["eew.forecast", "eew.warning"];

/** 複線 manager の capability 解決へ渡す依存性注入。 */
export interface MultiConnectionManagerOptions extends WsManagerOptions {}

/**
 * 複線接続管理。primary (通常回線) に加え、backup (EEW 副回線) を動的に起動/停止できる。
 * backup からの受信は msg.id で重複排除した上で、同じ onData イベントに委譲する。
 */
export class MultiConnectionManager implements ConnectionManager {
  private primary: WebSocketManager;
  private backup: WebSocketManager | null = null;
  private config: AppConfig;
  private events: WsManagerEvents;
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private readonly verifiedContractClassifications: readonly string[] | null;
  private readonly deliveryCapabilityRegistry: ClassificationHeadTypeRegistry;
  private readonly now: (() => number) | undefined;
  private readonly nextSocketGeneration: (() => number) | undefined;

  constructor(
    config: AppConfig,
    events: WsManagerEvents,
    options?: MultiConnectionManagerOptions,
  ) {
    this.config = config;
    this.events = events;
    const verifiedClassifications =
      options?.verifiedContractClassifications
      ?? getVerifiedContractClassifications(config);
    this.verifiedContractClassifications = verifiedClassifications == null
      ? null
      : Object.freeze([...verifiedClassifications]);
    this.deliveryCapabilityRegistry = options?.deliveryCapabilityRegistry
      ?? CLASSIFICATION_HEAD_TYPE_REGISTRY;
    this.now = options?.now;
    this.nextSocketGeneration = options?.nextSocketGeneration;

    this.primary = new WebSocketManager(
      config,
      {
        onData: (msg) => this.handleData(msg),
        onConnected: events.onConnected,
        onDisconnected: events.onDisconnected,
      },
      {
        now: this.now,
        nextSocketGeneration: this.nextSocketGeneration,
        verifiedContractClassifications: this.verifiedContractClassifications ?? undefined,
        deliveryCapabilityRegistry: this.deliveryCapabilityRegistry,
      },
    );
  }

  /** primary の接続を開始する */
  async connect(): Promise<void> {
    await this.primary.connect();
  }

  /** primary の接続状態を返す */
  getStatus(): WsManagerStatus {
    return this.primary.getStatus();
  }

  /** primary と、存在する backup の全経路を保守的に合成した capability。 */
  getDeliveryCapabilities(): DeliveryCapabilities {
    const snapshots = [this.readDeliveryCapabilities(this.primary)];
    if (this.backup != null) {
      snapshots.push(this.readDeliveryCapabilities(this.backup));
    }

    const connected = snapshots.every((snapshot) => snapshot.connected);
    const effectiveClassifications = new Set(
      snapshots[0].effectiveClassifications,
    );
    for (const snapshot of snapshots.slice(1)) {
      const currentClassifications = new Set(
        snapshot.effectiveClassifications,
      );
      for (const classification of effectiveClassifications) {
        if (!currentClassifications.has(classification)) {
          effectiveClassifications.delete(classification);
        }
      }
    }

    const firstSource = snapshots[0].source;
    const source: DeliveryCapabilities["source"] = connected
      && firstSource !== "unknown"
      && snapshots.every((snapshot) => snapshot.source === firstSource)
      ? firstSource
      : "unknown";

    const guaranteedHeadTypes = new Set<string>();
    if (source !== "unknown") {
      for (const headType of snapshots[0].guaranteedHeadTypes) {
        guaranteedHeadTypes.add(headType);
      }
      for (const snapshot of snapshots.slice(1)) {
        for (const headType of guaranteedHeadTypes) {
          if (!snapshot.guaranteedHeadTypes.has(headType)) {
            guaranteedHeadTypes.delete(headType);
          }
        }
      }
    }

    return cloneDeliveryCapabilities({
      connected,
      effectiveClassifications: [...effectiveClassifications],
      guaranteedHeadTypes,
      source,
    });
  }

  /** primary と backup の両方を停止する */
  close(): void {
    this.primary.close();
    if (this.backup) {
      this.backup.close();
      this.backup = null;
    }
  }

  /** 全ソケットの ID を返す (シャットダウン時の API クローズ用) */
  getAllSocketIds(): number[] {
    const ids: number[] = [];
    const primaryId = this.primary.getStatus().socketId;
    if (primaryId != null) ids.push(primaryId);
    if (this.backup) {
      const backupId = this.backup.getStatus().socketId;
      if (backupId != null) ids.push(backupId);
    }
    return ids;
  }

  /** backup の接続状態を返す (未起動時は null) */
  getBackupStatus(): WsManagerStatus | null {
    return this.backup?.getStatus() ?? null;
  }

  /** backup が起動中か */
  isBackupRunning(): boolean {
    return this.backup != null;
  }

  /** EEW 副回線を起動する。戻り値で起動結果を返す */
  async startBackup(): Promise<StartBackupResult> {
    if (this.backup) {
      log.warn("副回線は既に起動中です");
      return "already_running";
    }

    // EEW 区分と契約済み区分の積集合
    const backupClassifications = this.config.classifications.filter(
      (c): c is Classification => EEW_CLASSIFICATIONS.includes(c)
    );

    if (backupClassifications.length === 0) {
      log.warn("EEW 区分 (eew.forecast, eew.warning) が契約に含まれていないため、副回線を起動できません");
      return "no_eew_contract";
    }

    const backupConfig: AppConfig = {
      ...this.config,
      classifications: backupClassifications,
      appName: `${this.config.appName}-backup`,
      keepExistingConnections: true,
    };

    this.backup = new WebSocketManager(backupConfig, {
      onData: (msg) => this.handleData(msg),
      onConnected: () => {
        log.info("副回線: 接続成功");
      },
      onDisconnected: (reason) => {
        log.warn(`副回線: 切断 — ${reason}`);
      },
    }, {
      now: this.now,
      nextSocketGeneration: this.nextSocketGeneration,
      verifiedContractClassifications: this.verifiedContractClassifications ?? undefined,
      deliveryCapabilityRegistry: this.deliveryCapabilityRegistry,
    });

    log.info("副回線を起動中...");
    await this.backup.connect();
    return "started";
  }

  /** EEW 副回線を停止する */
  stopBackup(): void {
    if (!this.backup) {
      log.warn("副回線は起動していません");
      return;
    }
    this.backup.close();
    this.backup = null;
    log.info("副回線を停止しました");
  }

  /** 重複排除付きデータハンドラ */
  private handleData(msg: WsDataMessage): void {
    if (this.seenIds.has(msg.id)) {
      log.debug(`重複排除: id=${msg.id.slice(0, 16)}...`);
      return;
    }

    // FIFO window: 古い ID を先頭から削除
    this.seenIds.add(msg.id);
    this.seenOrder.push(msg.id);
    while (this.seenOrder.length > SEEN_IDS_MAX) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenIds.delete(oldest);
    }

    this.events.onData(msg);
  }

  private readDeliveryCapabilities(manager: WebSocketManager): DeliveryCapabilities {
    if (typeof manager.getDeliveryCapabilities !== "function") {
      return createUnknownDeliveryCapabilities(manager.getStatus().connected);
    }
    return cloneDeliveryCapabilities(manager.getDeliveryCapabilities());
  }
}
