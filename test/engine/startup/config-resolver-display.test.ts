import { describe, it, expect, vi, beforeEach } from "vitest";

// ── モック ──

vi.mock("../../../src/config", () => ({
  loadConfig: vi.fn(() => ({})),
  getConfigPath: vi.fn(() => "/mock/config.json"),
  VALID_CLASSIFICATIONS: [
    "telegram.earthquake",
    "eew.forecast",
    "eew.warning",
    "telegram.volcano",
    "telegram.weather",
  ],
}));

vi.mock("../../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setLogLevel: vi.fn(),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

import { resolveConfig } from "../../../src/engine/startup/config-resolver";
import { loadConfig } from "../../../src/config";
import * as log from "../../../src/logger";

const mockLoadConfig = vi.mocked(loadConfig);

describe("resolveConfig — 情報ディスプレイ設定", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
  });

  it("① デフォルト値 (display=false, displayPort=7788, displayHost=127.0.0.1)", () => {
    const config = resolveConfig({ apiKey: "test-key" });

    expect(config.display).toBe(false);
    expect(config.displayPort).toBe(7788);
    expect(config.displayHost).toBe("127.0.0.1");
  });

  it("② opts 指定が fileConfig より勝つ", () => {
    mockLoadConfig.mockReturnValue({
      display: false,
      displayPort: 8080,
      displayHost: "192.168.1.1",
    });

    const config = resolveConfig({
      apiKey: "test-key",
      display: true,
      displayPort: "9999",
      displayBind: "0.0.0.0",
    });

    expect(config.display).toBe(true);
    expect(config.displayPort).toBe(9999);
    expect(config.displayHost).toBe("0.0.0.0");
  });

  it("③ fileConfig のみ指定が DEFAULT より勝つ", () => {
    mockLoadConfig.mockReturnValue({
      display: true,
      displayPort: 8080,
      displayHost: "192.168.1.1",
    });

    const config = resolveConfig({ apiKey: "test-key" });

    expect(config.display).toBe(true);
    expect(config.displayPort).toBe(8080);
    expect(config.displayHost).toBe("192.168.1.1");
  });

  it("④ --display-port の非数値はデフォルトへフォールバック + warn", () => {
    const config = resolveConfig({ apiKey: "test-key", displayPort: "abc" });

    expect(config.displayPort).toBe(7788);
    expect(log.warn).toHaveBeenCalled();
  });

  it("④ --display-port の範囲外 (0) はデフォルトへフォールバック + warn", () => {
    const config = resolveConfig({ apiKey: "test-key", displayPort: "0" });

    expect(config.displayPort).toBe(7788);
    expect(log.warn).toHaveBeenCalled();
  });

  it("④ --display-port の範囲外 (65536) はデフォルトへフォールバック + warn", () => {
    const config = resolveConfig({ apiKey: "test-key", displayPort: "65536" });

    expect(config.displayPort).toBe(7788);
    expect(log.warn).toHaveBeenCalled();
  });

  it("④ --display-port が非数値でも fileConfig の値へフォールバックする", () => {
    mockLoadConfig.mockReturnValue({ displayPort: 8080 });

    const config = resolveConfig({ apiKey: "test-key", displayPort: "abc" });

    expect(config.displayPort).toBe(8080);
    expect(log.warn).toHaveBeenCalled();
  });
  it("⑤ --display-token が config より優先される", () => {
    mockLoadConfig.mockReturnValue({ displayToken: "from-file" });

    const config = resolveConfig({ apiKey: "test-key", displayToken: "from-cli" });

    expect(config.displayToken).toBe("from-cli");
  });

  it("⑤ 空文字の --display-token は未設定扱いに正規化される (fileConfig へフォールバック)", () => {
    mockLoadConfig.mockReturnValue({ displayToken: "from-file" });

    const config = resolveConfig({ apiKey: "test-key", displayToken: "" });

    expect(config.displayToken).toBe("from-file");
  });

  it("⑤ CLI・config とも空/未設定なら displayToken は undefined (空文字を通さない)", () => {
    mockLoadConfig.mockReturnValue({});

    const config = resolveConfig({ apiKey: "test-key", displayToken: "" });

    expect(config.displayToken).toBeUndefined();
  });
});
