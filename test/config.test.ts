import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// config.ts はモジュールレベルで CONFIG_PATH を計算するため、
// テスト用 tmpDir を使うように os.homedir をモックする
let tmpDir: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

// 各テストで config モジュールを再 import するため動的に扱う
async function importConfig() {
  // モジュールキャッシュをクリアして再評価
  vi.resetModules();
  return await import("../src/config");
}

describe("Config", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-config-test-"));
  });

  afterEach(() => {
    // tmpDir をクリーンアップ
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("loadConfig", () => {
    it("ファイルが存在しない場合に空オブジェクトを返す", async () => {
      const config = await importConfig();
      const result = config.loadConfig();
      expect(result).toEqual({});
    });

    it("正常な設定ファイルを読み込む", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          apiKey: "my-api-key",
          classifications: ["telegram.earthquake", "eew.forecast"],
          testMode: "including",
          appName: "my-app",
          maxReconnectDelaySec: 30,
          keepExistingConnections: true,
        })
      );

      const result = config.loadConfig();
      expect(result.apiKey).toBe("my-api-key");
      expect(result.classifications).toEqual([
        "telegram.earthquake",
        "eew.forecast",
      ]);
      expect(result.testMode).toBe("including");
      expect(result.appName).toBe("my-app");
      expect(result.maxReconnectDelaySec).toBe(30);
      expect(result.keepExistingConnections).toBe(true);
    });

    it("JSON 構文エラーの場合に空オブジェクトを返す", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        "invalid json {{{}"
      );

      const result = config.loadConfig();
      expect(result).toEqual({});
    });

    it("不正な形式 (配列) の場合に空オブジェクトを返す", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), "[]");

      const result = config.loadConfig();
      expect(result).toEqual({});
    });
  });

  describe("validateConfig (loadConfig 経由で間接テスト)", () => {
    it("不正な classification をフィルタする", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          classifications: ["telegram.earthquake", "invalid.type"],
        })
      );

      const result = config.loadConfig();
      expect(result.classifications).toEqual(["telegram.earthquake"]);
    });

    it("不正な testMode を無視する", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ testMode: "invalid" })
      );

      const result = config.loadConfig();
      expect(result.testMode).toBeUndefined();
    });

    it("空文字列の apiKey を無視する", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey: "" })
      );

      const result = config.loadConfig();
      expect(result.apiKey).toBeUndefined();
    });

    it("負の maxReconnectDelaySec を無視する", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ maxReconnectDelaySec: -5 })
      );

      const result = config.loadConfig();
      expect(result.maxReconnectDelaySec).toBeUndefined();
    });

    it("文字列カンマ区切りの classifications をパースする", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          classifications: "telegram.earthquake,eew.warning",
        })
      );

      const result = config.loadConfig();
      expect(result.classifications).toEqual([
        "telegram.earthquake",
        "eew.warning",
      ]);
    });
  });

  describe("setConfigValue", () => {
    it("apiKey を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("apiKey", "new-key");

      const result = config.loadConfig();
      expect(result.apiKey).toBe("new-key");
    });

    it("classifications をカンマ区切りで設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue(
        "classifications",
        "telegram.earthquake,eew.forecast"
      );

      const result = config.loadConfig();
      expect(result.classifications).toEqual([
        "telegram.earthquake",
        "eew.forecast",
      ]);
    });

    it("不正な classifications で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() =>
        config.setConfigValue("classifications", "invalid")
      ).toThrow(config.ConfigError);
    });

    it("testMode を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("testMode", "only");

      const result = config.loadConfig();
      expect(result.testMode).toBe("only");
    });

    it("不正な testMode で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("testMode", "invalid")).toThrow(
        config.ConfigError
      );
    });

    it("maxReconnectDelaySec を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("maxReconnectDelaySec", "120");

      const result = config.loadConfig();
      expect(result.maxReconnectDelaySec).toBe(120);
    });

    it("不正な maxReconnectDelaySec で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() =>
        config.setConfigValue("maxReconnectDelaySec", "abc")
      ).toThrow(config.ConfigError);
    });

    it("keepExistingConnections を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("keepExistingConnections", "true");

      const result = config.loadConfig();
      expect(result.keepExistingConnections).toBe(true);
    });

    it("不正な keepExistingConnections で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() =>
        config.setConfigValue("keepExistingConnections", "yes")
      ).toThrow(config.ConfigError);
    });

    it("不明なキーで ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("unknown", "val")).toThrow(
        config.ConfigError
      );
    });

    it("既存値を上書きできる", async () => {
      const config = await importConfig();
      config.setConfigValue("appName", "first");
      config.setConfigValue("appName", "second");

      const result = config.loadConfig();
      expect(result.appName).toBe("second");
    });
  });

  describe("unsetConfigValue", () => {
    it("設定を削除できる", async () => {
      const config = await importConfig();
      config.setConfigValue("appName", "to-remove");
      config.unsetConfigValue("appName");

      const result = config.loadConfig();
      expect(result.appName).toBeUndefined();
    });

    it("不明なキーで ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() => config.unsetConfigValue("unknown")).toThrow(
        config.ConfigError
      );
    });
  });

  describe("printConfig", () => {
    it("APIキーがマスクされて表示される", async () => {
      const config = await importConfig();
      config.setConfigValue("apiKey", "abcdefghijklmnop");

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      config.printConfig();

      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("abcd****mnop");
      expect(output).not.toContain("abcdefghijklmnop");

      spy.mockRestore();
    });

    it("設定なしの場合のメッセージ", async () => {
      const config = await importConfig();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      config.printConfig();

      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("設定なし");

      spy.mockRestore();
    });

    it("短い APIキー は **** でマスクされる", async () => {
      const config = await importConfig();
      config.setConfigValue("apiKey", "short");

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      config.printConfig();

      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("****");
      expect(output).not.toContain("short");

      spy.mockRestore();
    });
  });

  describe("getConfigPath / printConfigKeys", () => {
    it("設定ファイルパスを返す", async () => {
      const config = await importConfig();
      const p = config.getConfigPath();
      expect(p).toContain("config.json");
      expect(p).toContain("fleq");
    });

    it("設定可能なキー一覧を表示する", async () => {
      const config = await importConfig();
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      config.printConfigKeys();

      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("apiKey");
      expect(output).toContain("classifications");
      expect(output).toContain("testMode");

      spy.mockRestore();
    });
  });

  describe("ファイルパーミッション", () => {
    it("保存時に 0o600 パーミッションで書き込む", async () => {
      // Windows ではパーミッションチェックがスキップされるため、
      // Unix 系のみテスト
      if (process.platform === "win32") {
        return;
      }

      const config = await importConfig();
      config.setConfigValue("apiKey", "test-key");

      const configPath = config.getConfigPath();
      const stat = fs.statSync(configPath);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
