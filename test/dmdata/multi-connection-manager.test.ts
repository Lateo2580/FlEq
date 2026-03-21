import { describe, it, expect, vi, beforeEach } from "vitest";

// WebSocketManager のモック (後で mockImplementation を差し替える)
const wsManagerFactory = vi.fn();
vi.mock("../../src/dmdata/ws-client", () => {
  return {
    WebSocketManager: class MockWebSocketManager {
      constructor(...args: unknown[]) {
        const instance = wsManagerFactory(...args);
        Object.assign(this, instance);
      }
    },
  };
});

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { WsManagerEvents } from "../../src/dmdata/ws-client";
import { MultiConnectionManager } from "../../src/dmdata/multi-connection-manager";
import { AppConfig, DEFAULT_CONFIG, WsDataMessage } from "../../src/types";
import * as log from "../../src/logger";

function createConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    apiKey: "test-key",
    classifications: ["telegram.earthquake", "eew.forecast", "eew.warning"],
    testMode: "no",
    appName: "fleq",
    maxReconnectDelaySec: 60,
    keepExistingConnections: true,
    tableWidth: null,
    infoFullText: false,
    displayMode: "normal",
    promptClock: "elapsed",
    waitTipIntervalMin: 30,
    notify: {
      eew: true,
      earthquake: true,
      tsunami: true,
      seismicText: true,
      nankaiTrough: true,
      lgObservation: true,
    },
    sound: true,
    eewLog: true,
    eewLogFields: {
      hypocenter: true,
      originTime: true,
      coordinates: true,
      magnitude: true,
      forecastIntensity: true,
      maxLgInt: true,
      forecastAreas: true,
      lgIntensity: true,
      isPlum: true,
      hasArrived: true,
      diff: true,
      maxIntChangeReason: true,
    },
    maxObservations: null,
    backup: false,
    truncation: { ...DEFAULT_CONFIG.truncation },
    ...overrides,
  };
}

function createMockMsg(id: string): WsDataMessage {
  return {
    type: "data",
    version: "2.0",
    classification: "eew.forecast",
    id,
    passing: [],
    head: { type: "VXSE44", author: "test", time: "2024-01-01T00:00:00Z", test: false },
    format: "xml",
    compression: null,
    encoding: "utf-8",
    body: "<test/>",
  };
}

describe("MultiConnectionManager", () => {
  let capturedPrimaryEvents: WsManagerEvents;
  let capturedBackupEvents: WsManagerEvents;
  let mockPrimaryInstance: {
    connect: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockBackupInstance: {
    connect: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let constructorCallCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    constructorCallCount = 0;

    mockPrimaryInstance = {
      connect: vi.fn(),
      getStatus: vi.fn(() => ({
        connected: true,
        socketId: 100,
        reconnectAttempt: 0,
        heartbeatDeadlineAt: null,
      })),
      close: vi.fn(),
    };

    mockBackupInstance = {
      connect: vi.fn(),
      getStatus: vi.fn(() => ({
        connected: true,
        socketId: 200,
        reconnectAttempt: 0,
        heartbeatDeadlineAt: null,
      })),
      close: vi.fn(),
    };

    wsManagerFactory.mockImplementation((_config: AppConfig, events: WsManagerEvents) => {
      constructorCallCount++;
      if (constructorCallCount === 1) {
        capturedPrimaryEvents = events;
        return mockPrimaryInstance;
      }
      capturedBackupEvents = events;
      return mockBackupInstance;
    });
  });

  it("primary のみで動作する", async () => {
    const onData = vi.fn();
    const manager = new MultiConnectionManager(createConfig(), {
      onData,
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await manager.connect();
    expect(mockPrimaryInstance.connect).toHaveBeenCalled();

    const status = manager.getStatus();
    expect(status.socketId).toBe(100);

    expect(manager.isBackupRunning()).toBe(false);
    expect(manager.getBackupStatus()).toBeNull();
  });

  it("startBackup / stopBackup のライフサイクル", async () => {
    const manager = new MultiConnectionManager(createConfig(), {
      onData: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await manager.connect();

    // backup 起動
    const result = await manager.startBackup();
    expect(result).toBe("started");
    expect(manager.isBackupRunning()).toBe(true);
    expect(mockBackupInstance.connect).toHaveBeenCalled();

    // backup 状態取得
    const backupStatus = manager.getBackupStatus();
    expect(backupStatus?.socketId).toBe(200);

    // backup 停止
    manager.stopBackup();
    expect(manager.isBackupRunning()).toBe(false);
    expect(mockBackupInstance.close).toHaveBeenCalled();
    expect(manager.getBackupStatus()).toBeNull();
  });

  describe("重複排除", () => {
    it("primary と backup の両方から同じ msg.id が来た場合、onData は 1 回だけ発火", async () => {
      const onData = vi.fn();
      const manager = new MultiConnectionManager(createConfig(), {
        onData,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      await manager.startBackup();

      const msg = createMockMsg("duplicate-id-001");

      // primary 経由で受信
      capturedPrimaryEvents.onData(msg);
      expect(onData).toHaveBeenCalledTimes(1);

      // backup 経由で同じ msg.id を受信 → 排除される
      capturedBackupEvents.onData(msg);
      expect(onData).toHaveBeenCalledTimes(1);

      // debug ログで重複排除が記録される
      expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
        expect.stringContaining("重複排除")
      );
    });

    it("異なる msg.id は両方とも onData に渡される", async () => {
      const onData = vi.fn();
      const manager = new MultiConnectionManager(createConfig(), {
        onData,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();

      capturedPrimaryEvents.onData(createMockMsg("msg-001"));
      capturedPrimaryEvents.onData(createMockMsg("msg-002"));
      expect(onData).toHaveBeenCalledTimes(2);
    });

    it("SEEN_IDS_MAX (500件) 超過時に古い ID が evict される", async () => {
      const onData = vi.fn();
      const manager = new MultiConnectionManager(createConfig(), {
        onData,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();

      // 500件の異なる ID を送信
      for (let i = 0; i < 500; i++) {
        capturedPrimaryEvents.onData(createMockMsg(`msg-${String(i).padStart(4, "0")}`));
      }
      expect(onData).toHaveBeenCalledTimes(500);

      // msg-0000 はまだ seenIds にある → 重複排除される
      onData.mockClear();
      capturedPrimaryEvents.onData(createMockMsg("msg-0000"));
      expect(onData).toHaveBeenCalledTimes(0);

      // 1件追加すると msg-0000 が evict される
      capturedPrimaryEvents.onData(createMockMsg("msg-0500"));
      expect(onData).toHaveBeenCalledTimes(1);

      // evict された msg-0000 は再度通過する
      capturedPrimaryEvents.onData(createMockMsg("msg-0000"));
      expect(onData).toHaveBeenCalledTimes(2);
    });
  });

  describe("getAllSocketIds", () => {
    it("primary のみ", async () => {
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      expect(manager.getAllSocketIds()).toEqual([100]);
    });

    it("primary + backup", async () => {
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      await manager.startBackup();
      expect(manager.getAllSocketIds()).toEqual([100, 200]);
    });

    it("backup 停止後は primary のみ", async () => {
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      await manager.startBackup();
      manager.stopBackup();
      expect(manager.getAllSocketIds()).toEqual([100]);
    });

    it("socketId が null の場合は含まれない", async () => {
      mockPrimaryInstance.getStatus.mockReturnValue({
        connected: false,
        socketId: null,
        reconnectAttempt: 1,
        heartbeatDeadlineAt: null,
      });

      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      expect(manager.getAllSocketIds()).toEqual([]);
    });
  });

  it("close() で primary と backup の両方が閉じられる", async () => {
    const manager = new MultiConnectionManager(createConfig(), {
      onData: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await manager.connect();
    await manager.startBackup();

    manager.close();
    expect(mockPrimaryInstance.close).toHaveBeenCalled();
    expect(mockBackupInstance.close).toHaveBeenCalled();
  });

  describe("startBackup 結果", () => {
    it("EEW 区分が契約にない場合、no_eew_contract を返す", async () => {
      const config = createConfig({
        classifications: ["telegram.earthquake"],
      });
      const manager = new MultiConnectionManager(config, {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      const result = await manager.startBackup();

      expect(result).toBe("no_eew_contract");
      expect(manager.isBackupRunning()).toBe(false);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("EEW 区分")
      );
    });

    it("二重起動は already_running を返す", async () => {
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      await manager.startBackup();
      const result = await manager.startBackup();

      expect(result).toBe("already_running");
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith("副回線は既に起動中です");
    });
  });

  it("backup 未起動時の stopBackup() は警告を出す", async () => {
    const manager = new MultiConnectionManager(createConfig(), {
      onData: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await manager.connect();
    manager.stopBackup();

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith("副回線は起動していません");
  });

  it("backup config は EEW 区分のみ・appName-backup・keepExistingConnections:true", async () => {
    const config = createConfig({
      classifications: ["telegram.earthquake", "eew.forecast", "eew.warning"],
      appName: "myapp",
      keepExistingConnections: false,
    });

    const manager = new MultiConnectionManager(config, {
      onData: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await manager.connect();
    await manager.startBackup();

    // 2回目の wsManagerFactory 呼び出しの引数を検証
    const backupCallArgs = wsManagerFactory.mock.calls[1];
    const backupConfig = backupCallArgs[0] as AppConfig;
    expect(backupConfig.classifications).toEqual(["eew.forecast", "eew.warning"]);
    expect(backupConfig.appName).toBe("myapp-backup");
    expect(backupConfig.keepExistingConnections).toBe(true);
  });

  describe("backup イベント", () => {
    it("backup の onConnected はログのみで外部イベントに影響しない", async () => {
      const onConnected = vi.fn();
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected,
        onDisconnected: vi.fn(),
      });

      await manager.connect();
      await manager.startBackup();

      // backup の onConnected を発火
      capturedBackupEvents.onConnected();

      // 外部の onConnected は呼ばれない (primary の onConnected のみが外部に伝搬する)
      // backup の onConnected はログのみ
      expect(vi.mocked(log.info)).toHaveBeenCalledWith("副回線: 接続成功");
    });

    it("backup の onDisconnected はログのみで外部イベントに影響しない", async () => {
      const onDisconnected = vi.fn();
      const manager = new MultiConnectionManager(createConfig(), {
        onData: vi.fn(),
        onConnected: vi.fn(),
        onDisconnected,
      });

      await manager.connect();
      await manager.startBackup();

      // backup の onDisconnected を発火
      capturedBackupEvents.onDisconnected("test reason");

      // 外部の onDisconnected は呼ばれない
      expect(onDisconnected).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith("副回線: 切断 — test reason");
    });
  });
});
