import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../../src/logger", () => ({
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
  return await import("../../src/config");
}

describe("Config", () => {
  let savedXdgConfigHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-config-test-"));
    // XDG_CONFIG_HOME を tmpDir/.config に固定して OS 差異を吸収
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, ".config");
  });

  afterEach(() => {
    // tmpDir をクリーンアップ
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    }
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

    it("正常な maxObservations を読み込む", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ maxObservations: 10 })
      );

      const result = config.loadConfig();
      expect(result.maxObservations).toBe(10);
    });

    it("範囲外の maxObservations を無視する", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ maxObservations: 0 })
      );

      const result = config.loadConfig();
      expect(result.maxObservations).toBeUndefined();
    });

    it("非整数の maxObservations を無視する", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ maxObservations: 5.5 })
      );

      const result = config.loadConfig();
      expect(result.maxObservations).toBeUndefined();
    });
  });

  describe("setConfigValue", () => {
    it("apiKey を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("apiKey", "new-key");

      const result = config.loadConfig();
      expect(result.apiKey).toBe("new-key");
    });

    it("保存後に Config ファイル権限を 0600 に寄せる", async () => {
      const config = await importConfig();
      config.setConfigValue("apiKey", "new-key");

      if (process.platform !== "win32") {
        const stat = fs.statSync(path.join(tmpDir, ".config", "fleq", "config.json"));
        expect(stat.mode & 0o777).toBe(0o600);
      }
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

    it("infoFullText を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("infoFullText", "true");

      const result = config.loadConfig();
      expect(result.infoFullText).toBe(true);
    });

    it("infoFullText を false に設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("infoFullText", "false");

      const result = config.loadConfig();
      expect(result.infoFullText).toBe(false);
    });

    it("不正な infoFullText で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() =>
        config.setConfigValue("infoFullText", "yes")
      ).toThrow(config.ConfigError);
    });

    it("waitTipIntervalMin を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("waitTipIntervalMin", "45");

      const result = config.loadConfig();
      expect(result.waitTipIntervalMin).toBe(45);
    });

    it("不正な waitTipIntervalMin で ConfigError をスローする", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("waitTipIntervalMin", "1500")).toThrow(
        config.ConfigError
      );
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

    it("maxObservations に正常な整数値をセットできる", async () => {
      const config = await importConfig();
      config.setConfigValue("maxObservations", "10");
      const result = config.loadConfig();
      expect(result.maxObservations).toBe(10);
    });

    it("maxObservations の off で設定を削除できる", async () => {
      const config = await importConfig();
      config.setConfigValue("maxObservations", "10");
      config.setConfigValue("maxObservations", "off");
      const result = config.loadConfig();
      expect(result.maxObservations).toBeUndefined();
    });

    it("maxObservations に範囲外の値でエラーになる", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("maxObservations", "0")).toThrow();
      expect(() => config.setConfigValue("maxObservations", "1000")).toThrow();
      expect(() => config.setConfigValue("maxObservations", "abc")).toThrow();
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

  describe("truncation (ドットキー)", () => {
    it("truncation.volcanoAlertLines を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("truncation.volcanoAlertLines", "20");
      const result = config.loadConfig();
      expect(result.truncation?.volcanoAlertLines).toBe(20);
    });

    it("truncation.volcanoAlertLines に範囲外の値でエラーになる", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("truncation.volcanoAlertLines", "0")).toThrow(config.ConfigError);
      expect(() => config.setConfigValue("truncation.volcanoAlertLines", "1000")).toThrow(config.ConfigError);
      expect(() => config.setConfigValue("truncation.volcanoAlertLines", "abc")).toThrow(config.ConfigError);
    });

    it("不明な truncation サブキーでエラーになる", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("truncation.unknown", "5")).toThrow(config.ConfigError);
    });

    it("unsetConfigValue で truncation サブキーを削除できる", async () => {
      const config = await importConfig();
      config.setConfigValue("truncation.volcanoAlertLines", "20");
      config.unsetConfigValue("truncation.volcanoAlertLines");
      const result = config.loadConfig();
      expect(result.truncation).toBeUndefined();
    });

    it("unsetConfigValue で truncation 全体を削除できる", async () => {
      const config = await importConfig();
      config.setConfigValue("truncation.volcanoAlertLines", "20");
      config.setConfigValue("truncation.volcanoTextLines", "12");
      config.unsetConfigValue("truncation");
      const result = config.loadConfig();
      expect(result.truncation).toBeUndefined();
    });

    it("validateConfig で truncation オブジェクトをバリデーションする", async () => {
      const config = await importConfig();
      const fs = await import("fs");
      const configPath = config.getConfigPath();
      // ディレクトリを作成してから直接JSONを書き込む
      const dir = (await import("path")).dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        truncation: {
          volcanoAlertLines: 20,
          floodInundationLines: 10,
          invalidKey: 99,
          volcanoTextLines: -1,
        },
      }));
      const result = config.loadConfig();
      expect(result.truncation?.volcanoAlertLines).toBe(20);
      expect(result.truncation).not.toHaveProperty("floodInundationLines");
      expect(result.truncation).not.toHaveProperty("invalidKey");
      expect(result.truncation).not.toHaveProperty("volcanoTextLines");
    });
  });

  describe("マイグレーション", () => {
    it("旧アプリ名 (dmdata-monitor) から移行できる", async () => {
      const oldDir = path.join(tmpDir, ".config", "dmdata-monitor");
      fs.mkdirSync(oldDir, { recursive: true });
      const oldPath = path.join(oldDir, "config.json");
      fs.writeFileSync(oldPath, JSON.stringify({ apiKey: "legacy-key" }));
      if (process.platform !== "win32") {
        fs.chmodSync(oldPath, 0o644);
      }

      const config = await importConfig();
      const result = config.loadConfig();

      expect(result.apiKey).toBe("legacy-key");
      if (process.platform !== "win32") {
        const configPath = config.getConfigPath();
        const stat = fs.statSync(configPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it("レガシーパス (~/.config/fleq/) からの移行が優先される", async () => {
      // macOS/Windows で XDG_CONFIG_HOME 指定時、~/.config/fleq/ がレガシーパスになるケース
      const customDir = path.join(tmpDir, "custom-xdg");
      process.env.XDG_CONFIG_HOME = customDir;

      try {
        // レガシーパス (~/.config/fleq/) にファイルを作成
        const legacyDir = path.join(tmpDir, ".config", "fleq");
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(
          path.join(legacyDir, "config.json"),
          JSON.stringify({ apiKey: "legacy-fleq-key" })
        );

        // 旧アプリ名パスにもファイルを作成
        const oldDir = path.join(tmpDir, ".config", "dmdata-monitor");
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(
          path.join(oldDir, "config.json"),
          JSON.stringify({ apiKey: "dmdata-key" })
        );

        const config = await importConfig();
        const result = config.loadConfig();

        // レガシーパスが優先される
        expect(result.apiKey).toBe("legacy-fleq-key");
      } finally {
        delete process.env.XDG_CONFIG_HOME;
      }
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
      expect(output).toContain("waitTipIntervalMin");

      spy.mockRestore();
    });
  });

  describe("getConfigDir (OS別パス)", () => {
    it("XDG_CONFIG_HOME が設定されている場合はそちらを優先する", async () => {
      const customDir = path.join(tmpDir, "custom-xdg");
      process.env.XDG_CONFIG_HOME = customDir;
      const config = await importConfig();
      const dir = config.getConfigDir();
      expect(dir).toBe(path.join(customDir, "fleq"));
    });

    it("XDG_CONFIG_HOME 未設定時はパスに fleq を含む", async () => {
      delete process.env.XDG_CONFIG_HOME;
      const config = await importConfig();
      const dir = config.getConfigDir();
      expect(dir).toContain("fleq");
    });
  });

  describe("resolveConfigDir (純粋関数テスト)", () => {
    const HOME = "/mock/home";

    it.each([
      {
        label: "XDG_CONFIG_HOME 優先 (全OS共通)",
        platform: "linux" as NodeJS.Platform,
        env: { XDG_CONFIG_HOME: "/custom/xdg" },
        expected: path.join("/custom/xdg", "fleq"),
      },
      {
        label: "macOS デフォルト",
        platform: "darwin" as NodeJS.Platform,
        env: {},
        expected: path.join(HOME, "Library", "Application Support", "fleq"),
      },
      {
        label: "Windows (APPDATA あり)",
        platform: "win32" as NodeJS.Platform,
        env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
        expected: path.join("C:\\Users\\test\\AppData\\Roaming", "fleq"),
      },
      {
        label: "Windows (APPDATA なし → フォールバック)",
        platform: "win32" as NodeJS.Platform,
        env: {},
        expected: path.join(HOME, "AppData", "Roaming", "fleq"),
      },
      {
        label: "Linux デフォルト",
        platform: "linux" as NodeJS.Platform,
        env: {},
        expected: path.join(HOME, ".config", "fleq"),
      },
      {
        label: "FreeBSD (default branch)",
        platform: "freebsd" as NodeJS.Platform,
        env: {},
        expected: path.join(HOME, ".config", "fleq"),
      },
    ])("$label", async ({ platform, env, expected }) => {
      const config = await importConfig();
      expect(config.resolveConfigDir(platform, env, HOME)).toBe(expected);
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

  describe("weatherWarning thresholds + detail guards (Phase 4-A)", () => {
    async function importTypes() {
      vi.resetModules();
      return await import("../../src/types");
    }

    it("DEFAULT_CONFIG.weatherWarningStandardThreshold = 120", async () => {
      const { DEFAULT_CONFIG } = await importTypes();
      expect(DEFAULT_CONFIG.weatherWarningStandardThreshold).toBe(120);
    });

    it("DEFAULT_CONFIG.weatherWarningWideThreshold = 160", async () => {
      const { DEFAULT_CONFIG } = await importTypes();
      expect(DEFAULT_CONFIG.weatherWarningWideThreshold).toBe(160);
    });

    it("DEFAULT_CONFIG.weatherWarningDetailMaxPerEntry = 8", async () => {
      const { DEFAULT_CONFIG } = await importTypes();
      expect(DEFAULT_CONFIG.weatherWarningDetailMaxPerEntry).toBe(8);
    });

    it("DEFAULT_CONFIG.weatherWarningDetailMaxTotal = 60", async () => {
      const { DEFAULT_CONFIG } = await importTypes();
      expect(DEFAULT_CONFIG.weatherWarningDetailMaxTotal).toBe(60);
    });

    it("ユーザー設定ファイルで 4 値すべてを上書きできる", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          weatherWarningStandardThreshold: 100,
          weatherWarningWideThreshold: 180,
          weatherWarningDetailMaxPerEntry: 10,
          weatherWarningDetailMaxTotal: 80,
        })
      );

      const result = config.loadConfig();
      expect(result.weatherWarningStandardThreshold).toBe(100);
      expect(result.weatherWarningWideThreshold).toBe(180);
      expect(result.weatherWarningDetailMaxPerEntry).toBe(10);
      expect(result.weatherWarningDetailMaxTotal).toBe(80);
    });

    it("整数でない / 0 以下の値は無視される (validateConfig)", async () => {
      const config = await importConfig();
      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          weatherWarningStandardThreshold: 0,
          weatherWarningWideThreshold: -1,
          weatherWarningDetailMaxPerEntry: 5.5,
          weatherWarningDetailMaxTotal: "60",
        })
      );

      const result = config.loadConfig();
      expect(result.weatherWarningStandardThreshold).toBeUndefined();
      expect(result.weatherWarningWideThreshold).toBeUndefined();
      expect(result.weatherWarningDetailMaxPerEntry).toBeUndefined();
      expect(result.weatherWarningDetailMaxTotal).toBeUndefined();
    });

    it("config set で 4 値を設定できる", async () => {
      const config = await importConfig();
      config.setConfigValue("weatherWarningStandardThreshold", "100");
      config.setConfigValue("weatherWarningWideThreshold", "180");
      config.setConfigValue("weatherWarningDetailMaxPerEntry", "10");
      config.setConfigValue("weatherWarningDetailMaxTotal", "80");

      const result = config.loadConfig();
      expect(result.weatherWarningStandardThreshold).toBe(100);
      expect(result.weatherWarningWideThreshold).toBe(180);
      expect(result.weatherWarningDetailMaxPerEntry).toBe(10);
      expect(result.weatherWarningDetailMaxTotal).toBe(80);
    });

    it("config set と config 読込で 1〜999 の範囲外を拒否する", async () => {
      const config = await importConfig();
      expect(() => config.setConfigValue("weatherWarningStandardThreshold", "0")).toThrow(config.ConfigError);
      expect(() => config.setConfigValue("weatherWarningWideThreshold", "1000")).toThrow(config.ConfigError);

      const configDir = path.join(tmpDir, ".config", "fleq");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ weatherWarningDetailMaxTotal: 1000 }),
      );
      expect(config.loadConfig().weatherWarningDetailMaxTotal).toBeUndefined();
    });
  });
});

describe("DEFAULT_CONFIG.notify の既定値スナップショット", () => {
  it("地震系を有効、気象系 11 カテゴリを無効にする", async () => {
    const { DEFAULT_CONFIG } = await import("../../src/types");

    expect(DEFAULT_CONFIG.notify).toEqual({
      eew: true,
      earthquake: true,
      tsunami: true,
      seismicText: true,
      nankaiTrough: true,
      lgObservation: true,
      volcano: true,
      weather: false,
      tornado: false,
      briefing: false,
      earlyWeather: false,
      weatherWarningTimeseries: false,
      climateInfo: false,
      weatherExplanation: false,
      heatAlert: false,
      typhoonAnalysis: false,
      typhoonProbability: false,
      floodForecast: false,
    });
  });
});
