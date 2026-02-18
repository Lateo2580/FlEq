import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── モック ──

vi.mock("../../src/config", () => ({
  loadConfig: vi.fn(() => ({})),
  getConfigPath: vi.fn(() => "/mock/config.json"),
  VALID_CLASSIFICATIONS: [
    "telegram.earthquake",
    "eew.forecast",
    "eew.warning",
  ],
}));

vi.mock("../../src/dmdata/rest-client", () => ({
  listContracts: vi.fn(),
}));

vi.mock("../../src/app/start-monitor", () => ({
  startMonitor: vi.fn(),
}));

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setLogLevel: vi.fn(),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

import { runMonitor } from "../../src/cli/run-command";
import { loadConfig } from "../../src/config";
import { listContracts } from "../../src/dmdata/rest-client";
import { startMonitor } from "../../src/app/start-monitor";
import * as log from "../../src/logger";

const mockLoadConfig = vi.mocked(loadConfig);
const mockListContracts = vi.mocked(listContracts);
const mockStartMonitor = vi.mocked(startMonitor);

// process.exit をモック (vitest が独自のエラーを投げる場合があるため、
// rejects.toThrow() ではなく try/catch + exit 呼び出し検証を使う)
let mockExit: ReturnType<typeof vi.spyOn>;

describe("runMonitor", () => {
  const originalEnv = process.env.DMDATA_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DMDATA_API_KEY;
    mockLoadConfig.mockReturnValue({});
    mockListContracts.mockResolvedValue([
      "telegram.earthquake",
      "eew.forecast",
      "eew.warning",
    ]);
    mockStartMonitor.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
  });

  afterEach(() => {
    if (originalEnv != null) {
      process.env.DMDATA_API_KEY = originalEnv;
    } else {
      delete process.env.DMDATA_API_KEY;
    }
    vi.restoreAllMocks();
  });

  /** process.exit(1) が呼ばれることを検証するヘルパー */
  async function expectExit(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      // process.exit が呼ばれなかった場合
      expect.fail("process.exit(1) が呼ばれませんでした");
    } catch {
      expect(mockExit).toHaveBeenCalledWith(1);
    }
  }

  describe("設定優先順位", () => {
    it("CLI の apiKey が最優先", async () => {
      process.env.DMDATA_API_KEY = "env-key";
      mockLoadConfig.mockReturnValue({ apiKey: "config-key" });

      await runMonitor({
        apiKey: "cli-key",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "cli-key" })
      );
    });

    it("環境変数の apiKey が config より優先", async () => {
      process.env.DMDATA_API_KEY = "env-key";
      mockLoadConfig.mockReturnValue({ apiKey: "config-key" });

      await runMonitor({ debug: false });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "env-key" })
      );
    });

    it("config の apiKey をフォールバックで使用", async () => {
      mockLoadConfig.mockReturnValue({ apiKey: "config-key" });

      await runMonitor({ debug: false });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "config-key" })
      );
    });

    it("CLI の classifications が config より優先", async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: "key",
        classifications: ["eew.warning"],
      });

      await runMonitor({
        apiKey: "key",
        classifications: "telegram.earthquake",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          classifications: ["telegram.earthquake"],
        })
      );
    });

    it("config の classifications をフォールバックで使用", async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: "key",
        classifications: ["eew.warning"],
      });

      await runMonitor({
        apiKey: "key",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          classifications: ["eew.warning"],
        })
      );
    });

    it("classifications も config もなければデフォルト値", async () => {
      await runMonitor({
        apiKey: "key",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          classifications: [
            "telegram.earthquake",
            "eew.forecast",
            "eew.warning",
          ],
        })
      );
    });
  });

  describe("APIキー未設定", () => {
    it("apiKey が未設定で process.exit(1) する", async () => {
      await expectExit(() => runMonitor({ debug: false }));

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("APIキーが指定されていません")
      );
    });
  });

  describe("classifications バリデーション", () => {
    it("不正な classification のみの場合 process.exit(1) する", async () => {
      await expectExit(() =>
        runMonitor({
          apiKey: "key",
          classifications: "invalid.type",
          debug: false,
        })
      );

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("有効な区分が指定されていません")
      );
    });

    it("不正な classification を含む場合、有効な値のみ残る", async () => {
      await runMonitor({
        apiKey: "key",
        classifications: "telegram.earthquake,invalid.type",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          classifications: ["telegram.earthquake"],
        })
      );
    });
  });

  describe("契約状況チェック", () => {
    it("未契約の区分をスキップする", async () => {
      mockListContracts.mockResolvedValue(["telegram.earthquake"]);

      await runMonitor({
        apiKey: "key",
        classifications: "telegram.earthquake,eew.forecast",
        debug: false,
      });

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("未契約")
      );
      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          classifications: ["telegram.earthquake"],
        })
      );
    });

    it("有効な契約区分がない場合に process.exit(1) する", async () => {
      mockListContracts.mockResolvedValue(["other.type"]);

      await expectExit(() =>
        runMonitor({
          apiKey: "key",
          debug: false,
        })
      );
    });

    it("契約確認失敗時は指定区分のまま続行する", async () => {
      mockListContracts.mockRejectedValue(new Error("network error"));

      await runMonitor({
        apiKey: "key",
        debug: false,
      });

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("契約状況の確認に失敗しました")
      );
      expect(mockStartMonitor).toHaveBeenCalled();
    });
  });

  describe("テストモード", () => {
    it("CLI の test オプションが優先", async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: "key",
        testMode: "only",
      });

      await runMonitor({
        apiKey: "key",
        test: "including",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ testMode: "including" })
      );
    });

    it("config の testMode をフォールバックで使用", async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: "key",
        testMode: "only",
      });

      await runMonitor({
        apiKey: "key",
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ testMode: "only" })
      );
    });
  });

  describe("keepExisting オプション", () => {
    it("CLI の keepExisting が config より優先", async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: "key",
        keepExistingConnections: false,
      });

      await runMonitor({
        apiKey: "key",
        keepExisting: true,
        debug: false,
      });

      expect(mockStartMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ keepExistingConnections: true })
      );
    });
  });

  describe("デバッグモード", () => {
    it("debug=true で LogLevel.DEBUG を設定する", async () => {
      await runMonitor({
        apiKey: "key",
        debug: true,
      });

      expect(log.setLogLevel).toHaveBeenCalledWith(log.LogLevel.DEBUG);
    });
  });
});
