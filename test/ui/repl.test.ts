import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ── モック ──

vi.mock("readline", () => {
  const mockRl = new EventEmitter();
  Object.assign(mockRl, {
    prompt: vi.fn(),
    setPrompt: vi.fn(),
    close: vi.fn(),
    line: "",
  });
  return {
    default: {
      createInterface: vi.fn(() => mockRl),
    },
  };
});

vi.mock("../../src/dmdata/rest-client", () => ({
  listEarthquakes: vi.fn(),
  listContracts: vi.fn(),
  listSockets: vi.fn(),
}));

vi.mock("../../src/config", () => ({
  printConfig: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
  VALID_EEW_LOG_FIELDS: ["hypocenter", "magnitude", "forecastIntensity", "forecastAreas", "diff"],
}));

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setLogPrefixBuilder: vi.fn(),
  setLogHooks: vi.fn(),
}));

vi.mock("../../src/engine/eew/eew-logger", () => ({
  EewEventLogger: class {
    isEnabled() { return true; }
    setEnabled() { /* noop */ }
    getFields() {
      return { hypocenter: true, magnitude: true, forecastIntensity: true, forecastAreas: true, diff: true };
    }
    setFields() { /* noop */ }
    toggleField() { return false; }
  },
}));

vi.mock("../../src/engine/notification/notifier", () => ({
  Notifier: class {
    getSettings() { return { eew: true, earthquake: true, tsunami: true, seismicText: true, nankaiTrough: true, lgObservation: true }; }
    toggleCategory() { return false; }
    setAll() { /* noop */ }
    isMuted() { return false; }
    muteRemaining() { return 0; }
    mute() { /* noop */ }
    unmute() { /* noop */ }
    getSoundEnabled() { return true; }
    setSoundEnabled() { /* noop */ }
  },
  NOTIFY_CATEGORY_LABELS: {
    eew: "緊急地震速報",
    earthquake: "地震情報",
    tsunami: "津波情報",
    seismicText: "地震活動テキスト",
    nankaiTrough: "南海トラフ関連",
    lgObservation: "長周期地震動",
  },
}));

import readline from "readline";
import { ReplHandler } from "../../src/ui/repl";
import { WebSocketManager } from "../../src/dmdata/ws-client";
import {
  listEarthquakes,
  listContracts,
  listSockets,
} from "../../src/dmdata/rest-client";
import { printConfig, loadConfig, saveConfig } from "../../src/config";
import { Notifier } from "../../src/engine/notification/notifier";
import { EewEventLogger } from "../../src/engine/eew/eew-logger";
import { AppConfig } from "../../src/types";

const mockListEarthquakes = vi.mocked(listEarthquakes);
const mockListContracts = vi.mocked(listContracts);
const mockListSockets = vi.mocked(listSockets);

function createConfig(): AppConfig {
  return {
    apiKey: "test-api-key",
    classifications: ["telegram.earthquake"],
    testMode: "no",
    appName: "test-app",
    maxReconnectDelaySec: 60,
    keepExistingConnections: false,
    tableWidth: 60,
    infoFullText: false,
    displayMode: "normal",
    promptClock: "elapsed",
    waitTipIntervalMin: 30,
    sound: true,
    notify: {
      eew: true,
      earthquake: true,
      tsunami: true,
      seismicText: true,
      nankaiTrough: true,
      lgObservation: true,
    },
    eewLog: true,
    eewLogFields: {
      hypocenter: true,
      magnitude: true,
      forecastIntensity: true,
      forecastAreas: true,
      diff: true,
    },
  };
}

function createMockWsManager(): WebSocketManager {
  return {
    getStatus: vi.fn(() => ({
      connected: true,
      socketId: 42,
      reconnectAttempt: 0,
      heartbeatDeadlineAt: Date.now() + 30_000,
    })),
    close: vi.fn(),
  } as unknown as WebSocketManager;
}

describe("ReplHandler", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let mockRl: EventEmitter & { prompt: ReturnType<typeof vi.fn>; setPrompt: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; line: string };

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // stdout.isTTY を false にして StatusLine の render を抑制
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    mockRl = (readline.createInterface as ReturnType<typeof vi.fn>)() as typeof mockRl;
    mockRl.setMaxListeners(0);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function simulateLine(line: string): void {
    mockRl.emit("line", line);
  }

  describe("history コマンド", () => {
    it("地震履歴を表示する", async () => {
      mockListEarthquakes.mockResolvedValue({
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [
          {
            id: 1,
            type: "normal",
            eventId: "ev1",
            originTime: "2024-06-01T12:00:00+09:00",
            arrivalTime: "2024-06-01T12:00:00+09:00",
            hypocenter: {
              code: "001",
              name: "千葉県北西部",
              coordinate: null,
              depth: { type: "深さ", unit: "km", value: "30" },
              detailed: null,
            },
            magnitude: { type: "Mj", unit: "Mj", value: "4.5" },
            maxInt: "3",
          },
        ],
      });

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("history");

      // async handler なので待機
      await vi.waitFor(() => {
        expect(mockListEarthquakes).toHaveBeenCalledWith("test-api-key", 10);
      });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("千葉県北西部");
      expect(output).toContain("M4.5");
      expect(output).toContain("30km");

      handler.stop();
    });

    it("不正な件数でエラーメッセージを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("history abc");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("0件の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("history 0");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("負数の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("history -5");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });
  });

  describe("status コマンド", () => {
    it("接続状態を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("status");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("接続中");
      expect(output).toContain("42");

      handler.stop();
    });

    it("切断時の状態を表示する", () => {
      const wsManager = createMockWsManager();
      vi.mocked(wsManager.getStatus).mockReturnValue({
        connected: false,
        socketId: null,
        reconnectAttempt: 3,
        heartbeatDeadlineAt: null,
      });

      const handler = new ReplHandler(createConfig(), wsManager, new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("status");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("切断");
      expect(output).toContain("#3");

      handler.stop();
    });
  });

  describe("contract コマンド", () => {
    it("契約区分一覧を表示する", async () => {
      mockListContracts.mockResolvedValue([
        "telegram.earthquake",
        "eew.forecast",
      ]);

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("contract");

      await vi.waitFor(() => {
        expect(mockListContracts).toHaveBeenCalledWith("test-api-key");
      });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("telegram.earthquake");
      expect(output).toContain("eew.forecast");

      handler.stop();
    });
  });

  describe("socket コマンド", () => {
    it("ソケット一覧を表示する", async () => {
      mockListSockets.mockResolvedValue({
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [
          {
            id: 42,
            ticket: null,
            types: [],
            test: "no",
            classifications: ["telegram.earthquake"],
            ipAddress: "1.2.3.4",
            status: "open",
            server: "sv1",
            start: "2024-01-01T00:00:00Z",
            end: null,
            ping: null,
            appName: "test-app",
          },
        ],
      });

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("socket");

      await vi.waitFor(() => {
        expect(mockListSockets).toHaveBeenCalledWith("test-api-key");
      });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("id=42");
      expect(output).toContain("status=open");

      handler.stop();
    });
  });

  describe("config コマンド", () => {
    it("printConfig を呼び出す", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("config");

      expect(printConfig).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("不明コマンド", () => {
    it("フォールバックメッセージを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("unknown-cmd");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("不明なコマンド");
      expect(output).toContain("unknown-cmd");

      handler.stop();
    });
  });

  describe("空行", () => {
    it("空行を入力してもエラーにならない", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("");
      simulateLine("  ");

      // プロンプトが表示されるだけ
      expect(mockRl.prompt).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("help コマンド", () => {
    it("コマンド一覧を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("help");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("help");
      expect(output).toContain("history");
      expect(output).toContain("status");
      expect(output).toContain("quit");

      handler.stop();
    });
  });

  describe("tablewidth コマンド", () => {
    const mockLoadConfig = vi.mocked(loadConfig);
    const mockSaveConfig = vi.mocked(saveConfig);

    it("引数なしで現在のテーブル幅を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("現在のテーブル幅: 60");

      handler.stop();
    });

    it("有効な数値でテーブル幅を変更・永続化する", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth 100");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("テーブル幅を 100 に変更しました");
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ tableWidth: 100 })
      );

      handler.stop();
    });

    it("範囲外の数値でエラーを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth 10");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("40〜200");

      handler.stop();
    });

    it("数値でない引数でエラーを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth abc");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("40〜200");

      handler.stop();
    });

    it("境界値40が受け入れられる", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth 40");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("テーブル幅を 40 に変更しました");

      handler.stop();
    });

    it("境界値200が受け入れられる", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tablewidth 200");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("テーブル幅を 200 に変更しました");

      handler.stop();
    });
  });

  describe("tipinterval コマンド", () => {
    const mockLoadConfig = vi.mocked(loadConfig);
    const mockSaveConfig = vi.mocked(saveConfig);

    it("引数なしで現在のヒント間隔を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tipinterval");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("待機中ヒント間隔: 30分");

      handler.stop();
    });

    it("有効な数値でヒント間隔を変更・永続化する", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("tipinterval 15");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("待機中ヒント間隔を 15分 に変更しました");
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ waitTipIntervalMin: 15 })
      );

      handler.stop();
    });
  });

  describe("detail コマンド", () => {
    it("情報なし時にメッセージを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("detail");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("継続中の津波情報はありません");

      handler.stop();
    });

    it("detail tsunami でも同様に動作する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("detail tsunami");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("継続中の津波情報はありません");

      handler.stop();
    });

    it("不明なサブコマンドでエラーを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();

      simulateLine("detail unknown");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("不明なサブコマンド");

      handler.stop();
    });

    it("DetailProvider がある場合に showDetail() を呼ぶ", () => {
      const mockProvider = {
        category: "tsunami",
        emptyMessage: "情報なし",
        hasDetail: () => true,
        showDetail: vi.fn(),
      };

      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(),
        [], [mockProvider],
      );
      handler.start();

      simulateLine("detail");

      expect(mockProvider.showDetail).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("stop() の責務分離", () => {
    it("stop() を呼んでも process.exit が呼ばれない", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as (code?: number) => never);

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn());
      handler.start();
      handler.stop();

      // readline の close イベントを手動発火 (stop 後なので handleQuit に到達しない)
      mockRl.emit("close");

      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it("close イベントが stop() を経由せずに発火した場合は onQuit が呼ばれる", () => {
      const onQuit = vi.fn();
      const wsManager = createMockWsManager();
      const handler = new ReplHandler(createConfig(), wsManager, new Notifier(), new EewEventLogger(), onQuit);
      handler.start();

      // stop() を呼ばずに close イベントを直接発火 → handleQuit が呼ばれる
      mockRl.emit("close");

      expect(onQuit).toHaveBeenCalled();
    });
  });
});
