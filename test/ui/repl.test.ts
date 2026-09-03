import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import { EventEmitter } from "events";
import chalk from "chalk";
import { testTelegramMeta } from "../helpers/telegram-meta";

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
import { ConnectionManager } from "../../src/dmdata/connection-manager";
import {
  listEarthquakes,
  listContracts,
  listSockets,
} from "../../src/dmdata/rest-client";
import { printConfig, loadConfig, saveConfig } from "../../src/config";
import { Notifier } from "../../src/engine/notification/notifier";
import { EewEventLogger } from "../../src/engine/eew/eew-logger";
import { AppConfig, DEFAULT_CONFIG } from "../../src/types";
import { TelegramStats } from "../../src/engine/messages/telegram-stats";
import * as themeModule from "../../src/ui/theme";
import type {
  ResolveOperationalV2AlertOmissionResult,
  VolcanoRepairAdministration,
  VolcanoRestRepairResult,
} from "../../src/engine/messages/volcano-transaction-coordinator";

const mockListEarthquakes = vi.mocked(listEarthquakes);
const mockListContracts = vi.mocked(listContracts);
const mockListSockets = vi.mocked(listSockets);

function createConfig(): AppConfig {
  return {
    // 既定値を土台に敷き、テストが主張したい値だけ後ろで上書きする
    // (AppConfig に項目が増えてもこのフィクスチャは追随する)
    ...DEFAULT_CONFIG,
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
      volcano: true,
      weather: true,
      tornado: true,
      briefing: true,
      earlyWeather: true,
      weatherWarningTimeseries: true,
      climateInfo: true,
      weatherExplanation: true,
      heatAlert: true,
      typhoonAnalysis: true,
      typhoonProbability: true,
      floodForecast: true,
    },
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
  };
}

function createMockWsManager(): ConnectionManager {
  return {
    connect: vi.fn(),
    getStatus: vi.fn(() => ({
      connected: true,
      socketId: 42,
      reconnectAttempt: 0,
      heartbeatDeadlineAt: Date.now() + 30_000,
    })),
    close: vi.fn(),
  };
}

describe("ReplHandler", () => {
  let consoleSpy: MockInstance<typeof console.log>;
  let mockRl: EventEmitter & { prompt: ReturnType<typeof vi.fn>; setPrompt: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; line: string };

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // stdout.isTTY を false にして StatusLine の render を抑制
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    // mock の createInterface は引数を無視して常に同じ EventEmitter を返す (vi.mock 冒頭)
    mockRl = readline.createInterface({ input: process.stdin }) as unknown as typeof mockRl;
    mockRl.setMaxListeners(0);
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function simulateLine(line: string): void {
    mockRl.emit("line", line);
  }

  it("PromptStatus の role を REPL 境界で ANSI 色へ変換する", () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    process.stdout.isTTY = true;
    try {
      const handler = new ReplHandler(
        createConfig(),
        createMockWsManager(),
        new Notifier(),
        new EewEventLogger(),
        vi.fn(),
        new TelegramStats(),
        [{
          getPromptStatus: () => ({
            text: "津波警報",
            role: "tsunamiWarning",
            priority: 10,
          }),
        }],
      );

      const prompt = (handler as unknown as { buildPromptString(): string }).buildPromptString();
      const colored = themeModule.getRoleChalk("tsunamiWarning")("津波警報");
      expect(colored).toMatch(/\u001b\[/);
      expect(prompt).toContain(colored);
    } finally {
      chalk.level = previousLevel;
    }
  });

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

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("history abc");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("0件の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("history 0");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("負数の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("history -5");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });
  });

  describe("status コマンド", () => {
    it("接続状態を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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

      const handler = new ReplHandler(createConfig(), wsManager, new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("config");

      expect(printConfig).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("不明コマンド", () => {
    it("フォールバックメッセージを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("");
      simulateLine("  ");

      // プロンプトが表示されるだけ
      expect(mockRl.prompt).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("help コマンド", () => {
    it("引数なしでガイドを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("help");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("help <command>");
      expect(output).toContain("commands");

      handler.stop();
    });

    it("help <command> でコマンド詳細を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("help notify");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("notify");
      expect(output).toContain("通知設定");

      handler.stop();
    });

    it("サブコマンドの大文字小文字を正規化する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("help eewlog ON");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("on");
      expect(output).not.toContain("不明なサブコマンド");

      handler.stop();
    });
  });

  describe("commands コマンド", () => {
    it("引数なしで全コマンド一覧を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("commands");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("利用可能なコマンド");
      expect(output).toContain("help <command>");
      expect(output).toContain("help");
      expect(output).toContain("notify");
      expect(output).toContain("quit");

      handler.stop();
    });

    it("カテゴリ絞り込みが機能する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("commands settings");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("[設定]");
      expect(output).toContain("notify");
      expect(output).not.toContain("[情報]");
      expect(output).not.toContain("[操作]");

      handler.stop();
    });

    it("検索が機能する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("commands 通知");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("検索結果");
      expect(output).toContain("notify");

      handler.stop();
    });

    it("サブコマンドがあるコマンドに + マーカーが付く", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("commands");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // notify にはサブコマンドがあるので + が出る
      const notifyLine = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("notify") && line.includes("通知設定"));
      expect(notifyLine).toContain("+");

      handler.stop();
    });

    it("cmds エイリアスが動作する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("cmds");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("利用可能なコマンド");

      handler.stop();
    });
  });

  describe("tablewidth コマンド", () => {
    const mockLoadConfig = vi.mocked(loadConfig);
    const mockSaveConfig = vi.mocked(saveConfig);

    it("引数なしで現在のテーブル幅を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("tablewidth");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("現在のテーブル幅: 60");

      handler.stop();
    });

    it("有効な数値でテーブル幅を変更・永続化する", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("tablewidth 10");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("40〜200");

      handler.stop();
    });

    it("数値でない引数でエラーを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("tablewidth abc");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("40〜200");

      handler.stop();
    });

    it("境界値40が受け入れられる", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("tablewidth 40");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("テーブル幅を 40 に変更しました");

      handler.stop();
    });

    it("境界値200が受け入れられる", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("tipinterval");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("待機中ヒント間隔: 30分");

      handler.stop();
    });

    it("有効な数値でヒント間隔を変更・永続化する", () => {
      mockLoadConfig.mockReturnValue({});

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
    const emptyTsunamiProvider = {
      category: "tsunami" as const,
      emptyMessage: "現在、継続中の津波情報はありません。",
      getDetail: () => null,
    };

    it("情報なし時にメッセージを表示する", () => {
      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(),
        new TelegramStats(), [], [emptyTsunamiProvider],
      );
      handler.start();

      simulateLine("detail");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("継続中の津波情報はありません");

      handler.stop();
    });

    it("detail tsunami でも同様に動作する", () => {
      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(),
        new TelegramStats(), [], [emptyTsunamiProvider],
      );
      handler.start();

      simulateLine("detail tsunami");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("継続中の津波情報はありません");

      handler.stop();
    });

    it("不明なサブコマンドでエラーを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
      handler.start();

      simulateLine("detail unknown");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("不明なサブコマンド");

      handler.stop();
    });

    it("DetailProvider がある場合に snapshot を描画する", () => {
      const getDetail = vi.fn(() => ({
        kind: "tsunami" as const,
        info: {
          meta: testTelegramMeta(false),
          type: "VTSE41",
          infoType: "発表",
          title: "津波警報・注意報・予報",
          reportDateTime: "2025-01-01T00:00:00+09:00",
          headline: null,
          publishingOffice: "気象庁",
          forecast: [],
          warningComment: "",
          isTest: false,
        },
      }));
      const mockProvider = {
        category: "tsunami" as const,
        emptyMessage: "情報なし",
        getDetail,
      };

      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(),
        new TelegramStats(), [], [mockProvider],
      );
      handler.start();

      simulateLine("detail");

      expect(getDetail).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("stats コマンド", () => {
    it("stats コマンドで統計フレームを表示する", () => {
      const stats = new TelegramStats();
      stats.record({ headType: "VXSE53", category: "earthquake" });

      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), stats,
      );
      handler.start();

      simulateLine("stats");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("統計");

      handler.stop();
    });

    it("stats コマンドが commands に表示される", () => {
      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats(),
      );
      handler.start();

      simulateLine("commands");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("stats");
      expect(output).toContain("電文統計");

      handler.stop();
    });
  });

  describe("volcanorepair コマンド", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;

    function administration(
      result: ResolveOperationalV2AlertOmissionResult = {
        kind: "committed",
        resolutionId: `sha256:${"b".repeat(64)}`,
      },
    ): VolcanoRepairAdministration & {
      status: ReturnType<typeof vi.fn>;
      resolveOperationalV2AlertOmission: ReturnType<typeof vi.fn>;
    } {
      return {
        status: vi.fn(() => [{
          omissionFingerprint: fingerprint,
          scope: "volcano" as const,
          volcanoCode: "506",
          lastKnownComparison: null,
          actions: ["acceptCurrent" as const, "clearCurrent" as const],
          expectedRuntimeVersion: 7,
        }]),
        resolveOperationalV2AlertOmission: vi.fn(() => result),
      };
    }

    function repairHandler(admin: VolcanoRepairAdministration): ReplHandler {
      return new ReplHandler(
        createConfig(),
        createMockWsManager(),
        new Notifier(),
        new EewEventLogger(),
        vi.fn(),
        new TelegramStats(),
        [],
        [],
        undefined,
        undefined,
        undefined,
        admin,
      );
    }

    it("status は fingerprint・scope・comparison・version だけを表示する", () => {
      const admin = administration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair status");

      const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("code=506");
      expect(output).toContain("comparison=unknown");
      expect(output).toContain(`fingerprint=${fingerprint}`);
      expect(output).toContain("version=7");
      expect(output).not.toContain("sourceEventId");
      handler.stop();
    });

    it("accept は status と同じ version で facade を一度だけ呼び committed だけ成功表示する", () => {
      const admin = administration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine(`volcanorepair accept ${fingerprint} 現況を確認済み`);

      expect(admin.status).toHaveBeenCalledTimes(1);
      expect(admin.resolveOperationalV2AlertOmission).toHaveBeenCalledWith({
        omissionFingerprint: fingerprint,
        action: "acceptCurrent",
        reason: "現況を確認済み",
        expectedRuntimeVersion: 7,
      });
      const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("火山 provenance 修復を記録しました");
      handler.stop();
    });

    // ---- spec §14.1 volcanorepair rest ----

    /** rest 用: restRepair mock 付き administration */
    function restAdministration(
      result: VolcanoRestRepairResult = {
        kind: "completed",
        dryRun: false,
        backupFiles: [{ source: "v2", path: "/tmp/standby.v2.json.1.0.manual-backup", reused: false }],
        targets: [{ target: "vfvo50", kind: "committed" }],
      },
    ): VolcanoRepairAdministration & { restRepair: ReturnType<typeof vi.fn> } {
      return {
        ...administration(),
        restRepair: vi.fn(async () => result),
      };
    }

    /** handler の Promise が解決するまでマイクロタスクを流す */
    async function flush(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
    }

    function outputText(): string {
      return consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    }

    it("spec §14.1 #1: rest の target 省略時は vfvo50 だけを既定にする", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest --confirm 既定確認");
      await flush();

      expect(admin.restRepair).toHaveBeenCalledTimes(1);
      expect(admin.restRepair.mock.calls[0]![0]).toEqual({
        targets: ["vfvo50"],
        dryRun: false,
        reason: "既定確認",
      });
      // VFVO50 単独では破壊性の警告を出さない
      expect(outputText()).not.toContain("警告: ashfall force");
      handler.stop();
    });

    it("spec §14.1 #2: rest ashfall / rest all は target を解決し破壊性の警告を出す", async () => {
      for (const [token, targets] of [
        ["ashfall", ["ashfall"]],
        ["all", ["vfvo50", "ashfall"]],
      ] as const) {
        consoleSpy.mockClear();
        const admin = restAdministration();
        const handler = repairHandler(admin);
        handler.start();

        simulateLine(`volcanorepair rest ${token} --confirm 破壊確認`);
        await flush();

        expect(admin.restRepair.mock.calls[0]![0].targets).toEqual(targets);
        const output = outputText();
        expect(output).toContain("警告: ashfall force は現在の降灰 slice と gate を全削除してから 7 日窓を replay します。");
        expect(output).toContain("窓外・REST 取得漏れの降灰情報は復元されません。");
        handler.stop();
      }
    });

    it("spec §14.1 #3: 未知 target token は使い方表示だけで restRepair を呼ばない", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest vfvo51 --confirm 未知");
      await flush();

      expect(admin.restRepair).not.toHaveBeenCalled();
      expect(outputText()).toContain("使い方: volcanorepair rest");
      handler.stop();
    });

    it("spec §14.1 #4: --confirm 無しの非 dry-run は使い方表示だけで終わる", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest all");
      await flush();

      expect(admin.restRepair).not.toHaveBeenCalled();
      expect(outputText()).toContain("使い方: volcanorepair rest");
      handler.stop();
    });

    it("spec §14.1 #5: --confirm の reason が空なら使い方表示だけで終わる", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest --confirm    ");
      await flush();

      expect(admin.restRepair).not.toHaveBeenCalled();
      expect(outputText()).toContain("使い方: volcanorepair rest");
      handler.stop();
    });

    it("spec §14.1 #6: --dry-run は --confirm 無しでも restRepair を呼ぶ", async () => {
      const admin = restAdministration({
        kind: "completed",
        dryRun: true,
        backupFiles: [],
        targets: [{ target: "vfvo50", kind: "proved", historicalCount: 3, journalCount: 1 }],
      });
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest --dry-run");
      await flush();

      expect(admin.restRepair).toHaveBeenCalledWith({
        targets: ["vfvo50"],
        dryRun: true,
        reason: "",
      });
      expect(outputText()).toContain("vfvo50: proved (historical=3 journal=1)");
      handler.stop();
    });

    it("spec §14.1 #7: rest all --dry-run --confirm <理由> を受理する", async () => {
      const admin = restAdministration({
        kind: "completed",
        dryRun: true,
        backupFiles: [],
        targets: [],
      });
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest all --dry-run --confirm 動作確認");
      await flush();

      expect(admin.restRepair).toHaveBeenCalledWith({
        targets: ["vfvo50", "ashfall"],
        dryRun: true,
        reason: "動作確認",
      });
      handler.stop();
    });

    it("spec §14.1 #8: --confirm より後の --dry-run は使い方表示で終わる", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest all --confirm 動作確認 --dry-run");
      await flush();

      expect(admin.restRepair).not.toHaveBeenCalled();
      expect(outputText()).toContain("使い方: volcanorepair rest");
      handler.stop();
    });

    it("spec §14.1 #9: --dry-run=1 は完全一致しないので reason 本文として通す", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair rest all --confirm 手順 --dry-run=1");
      await flush();

      expect(admin.restRepair).toHaveBeenCalledWith({
        targets: ["vfvo50", "ashfall"],
        dryRun: false,
        reason: "手順 --dry-run=1",
      });
      handler.stop();
    });

    it("spec §14.1 #10: administration や restRepair が無い構成では利用できませんと出す", async () => {
      const withoutAdministration = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(),
        new TelegramStats(),
      );
      withoutAdministration.start();
      expect(() => simulateLine("volcanorepair rest --confirm 未提供")).not.toThrow();
      await flush();
      expect(outputText()).toContain("火山修復管理はこの構成では利用できません");
      withoutAdministration.stop();

      consoleSpy.mockClear();
      const handler = repairHandler(administration());
      handler.start();
      expect(() => simulateLine("volcanorepair rest --confirm 未実装")).not.toThrow();
      await flush();
      expect(outputText()).toContain("火山 REST repair はこの構成では利用できません");
      handler.stop();
    });

    it("spec §14.1 #11: handler の Promise を repl が await して commandRunning を解除する", async () => {
      let release: (() => void) | null = null;
      const admin: VolcanoRepairAdministration = {
        ...administration(),
        restRepair: vi.fn(() => new Promise<VolcanoRestRepairResult>((resolve) => {
          release = () => resolve({
            kind: "completed", dryRun: true, backupFiles: [], targets: [],
          });
        })),
      };
      const handler = repairHandler(admin);
      handler.start();
      mockRl.prompt.mockClear();

      simulateLine("volcanorepair rest --dry-run");
      await flush();
      // await 中はプロンプトを描き直さない (commandRunning = true)
      expect(mockRl.prompt).not.toHaveBeenCalled();

      release!();
      await flush();
      expect(mockRl.prompt).toHaveBeenCalled();
      handler.stop();
    });

    it("spec §14.1 #12: 既存 status / accept / clear / acknowledge-domain の挙動は変わらない", async () => {
      const admin = restAdministration();
      const handler = repairHandler(admin);
      handler.start();

      simulateLine("volcanorepair status");
      await flush();
      expect(outputText()).toContain(`fingerprint=${fingerprint}`);

      consoleSpy.mockClear();
      simulateLine(`volcanorepair accept ${fingerprint} 現況を確認済み`);
      await flush();
      expect(admin.resolveOperationalV2AlertOmission).toHaveBeenCalledWith({
        omissionFingerprint: fingerprint,
        action: "acceptCurrent",
        reason: "現況を確認済み",
        expectedRuntimeVersion: 7,
      });

      consoleSpy.mockClear();
      simulateLine("volcanorepair accept");
      await flush();
      expect(outputText())
        .toContain("使い方: volcanorepair status | accept/clear/acknowledge-domain <fingerprint> <reason...>");
      expect(admin.restRepair).not.toHaveBeenCalled();
      handler.stop();
    });

    it("stale/admission reject と scope 不一致は成功表示しない", () => {
      for (const kind of ["staleVersion", "admissionRejected", "invalidAction"] as const) {
        consoleSpy.mockClear();
        const admin = administration({ kind });
        const handler = repairHandler(admin);
        handler.start();

        simulateLine(`volcanorepair clear ${fingerprint} reject-${kind}`);

        const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(output).toContain(`適用されませんでした (${kind})`);
        expect(String(consoleSpy.mock.calls.at(-1)?.[0]))
          .toContain(`適用されませんでした (${kind})`);
        handler.stop();
      }
    });
  });

  describe("stop() の責務分離", () => {
    it("stop() を呼んでも process.exit が呼ばれない", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as (code?: string | number | null) => never);

      const handler = new ReplHandler(createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(), vi.fn(), new TelegramStats());
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
      const handler = new ReplHandler(createConfig(), wsManager, new Notifier(), new EewEventLogger(), onQuit, new TelegramStats());
      handler.start();

      // stop() を呼ばずに close イベントを直接発火 → handleQuit が呼ばれる
      mockRl.emit("close");

      expect(onQuit).toHaveBeenCalled();
    });

    it("quit の shutdown adapter rejection は process.exitCode=1 にする", async () => {
      const onQuit = vi.fn().mockRejectedValue(new Error("save failed"));
      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(),
        onQuit, new TelegramStats(),
      );
      handler.start();

      simulateLine("quit");

      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(onQuit).toHaveBeenCalledTimes(1);
    });

    it("readline close の shutdown adapter rejection も process.exitCode=1 にする", async () => {
      const onQuit = vi.fn().mockRejectedValue(new Error("save failed"));
      const handler = new ReplHandler(
        createConfig(), createMockWsManager(), new Notifier(), new EewEventLogger(),
        onQuit, new TelegramStats(),
      );
      handler.start();

      mockRl.emit("close");

      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(onQuit).toHaveBeenCalledTimes(1);
    });
  });
});
