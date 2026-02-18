import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ── モック ──

vi.mock("readline", () => {
  const mockRl = new EventEmitter();
  Object.assign(mockRl, {
    prompt: vi.fn(),
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
}));

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import readline from "readline";
import { ReplHandler } from "../../src/ui/repl";
import { WebSocketManager } from "../../src/dmdata/ws-client";
import {
  listEarthquakes,
  listContracts,
  listSockets,
} from "../../src/dmdata/rest-client";
import { printConfig } from "../../src/config";
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
  };
}

function createMockWsManager(): WebSocketManager {
  return {
    getStatus: vi.fn(() => ({
      connected: true,
      socketId: 42,
      reconnectAttempt: 0,
    })),
    close: vi.fn(),
  } as unknown as WebSocketManager;
}

describe("ReplHandler", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let mockRl: EventEmitter & { prompt: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; line: string };

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // stdout.isTTY を false にして StatusLine の render を抑制
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    mockRl = (readline.createInterface as ReturnType<typeof vi.fn>)() as typeof mockRl;
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

      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager());
      handler.start();

      simulateLine("history abc");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("0件の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager());
      handler.start();

      simulateLine("history 0");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });

    it("負数の場合のメッセージ", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager());
      handler.start();

      simulateLine("history -5");

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("正の整数");

      handler.stop();
    });
  });

  describe("status コマンド", () => {
    it("接続状態を表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
      });

      const handler = new ReplHandler(createConfig(), wsManager);
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

      const handler = new ReplHandler(createConfig(), createMockWsManager());
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

      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager());
      handler.start();

      simulateLine("config");

      expect(printConfig).toHaveBeenCalled();

      handler.stop();
    });
  });

  describe("不明コマンド", () => {
    it("フォールバックメッセージを表示する", () => {
      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
      const handler = new ReplHandler(createConfig(), createMockWsManager());
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
});
