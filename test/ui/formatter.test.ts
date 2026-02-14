import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import {
  intensityColor,
  displayEarthquakeInfo,
  displayEewInfo,
} from "../../src/ui/formatter";
import { ParsedEarthquakeInfo, ParsedEewInfo } from "../../src/types";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
} from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_CANCEL,
} from "../helpers/mock-message";

// ── intensityColor ──

describe("intensityColor", () => {
  // chalk のレベルを強制 (CI 環境でも色が有効になるように)
  beforeEach(() => {
    chalk.level = 3;
  });

  it("震度1 → gray", () => {
    expect(intensityColor("1")).toBe(chalk.gray);
  });

  it("震度2 → blue", () => {
    expect(intensityColor("2")).toBe(chalk.blue);
  });

  it("震度3 → green", () => {
    expect(intensityColor("3")).toBe(chalk.green);
  });

  it("震度4 → yellow", () => {
    expect(intensityColor("4")).toBe(chalk.yellow);
  });

  it("震度5弱 → orange 系", () => {
    const color = intensityColor("5弱");
    // chalk.rgb は毎回新しい関数を返すので、出力文字列で比較
    const result = color("test");
    expect(result).toContain("test");
    expect(result).not.toBe("test"); // 色コードが付加されている
  });

  it("震度5- と 5弱 は同じ色になる", () => {
    const a = intensityColor("5-")("X");
    const b = intensityColor("5弱")("X");
    expect(a).toBe(b);
  });

  it("震度6弱 → redBright", () => {
    expect(intensityColor("6弱")).toBe(chalk.redBright);
    expect(intensityColor("6-")).toBe(chalk.redBright);
  });

  it("震度6強 → red", () => {
    expect(intensityColor("6強")).toBe(chalk.red);
    expect(intensityColor("6+")).toBe(chalk.red);
  });

  it("震度7 → bgRed.white", () => {
    expect(intensityColor("7")).toBe(chalk.bgRed.white);
  });

  it("不明な震度 → white", () => {
    expect(intensityColor("不明")).toBe(chalk.white);
  });
});

// ── displayEarthquakeInfo (stdout キャプチャ) ──

describe("displayEarthquakeInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VXSE53 遠地地震: タイトル・震源名・M7.1・津波情報が出力に含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      head: {
        type: "VXSE53",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEarthquakeTelegram(msg);
    expect(info).not.toBeNull();

    displayEarthquakeInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 遠地地震のタイトルが含まれる
    expect(output).toContain("震源・震度に関する情報");
    // 震源名
    expect(output).toContain("南太平洋");
    // マグニチュード
    expect(output).toContain("M7.1");
    // 津波情報
    expect(output).toContain("津波の心配はありません");
  });

  it("VXSE51 震度速報: 地域名と震度が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO, {
      head: {
        type: "VXSE51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEarthquakeTelegram(msg);
    expect(info).not.toBeNull();

    displayEarthquakeInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 震度速報のタイトル
    expect(output).toContain("震度速報");
    // 地域名
    expect(output).toContain("岩手県沿岸南部");
    // 震度表示
    expect(output).toContain("震度4");
    expect(output).toContain("震度3");
  });
});

// ── displayEewInfo (stdout キャプチャ) ──

describe("displayEewInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("EEW予報: 予報ヘッダーが表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10, {
      classification: "eew.forecast",
      head: {
        type: "VXSE44",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();

    displayEewInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 予報ヘッダー
    expect(output).toContain("緊急地震速報（予報）");
    // Serial とEventID
    expect(output).toContain("10");
    expect(output).toContain("20240417231454");
  });

  it("EEW取消: 取消メッセージが表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL, {
      classification: "eew.forecast",
      head: {
        type: "VXSE45",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();

    displayEewInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 取消関連の表示
    expect(output).toContain("取消");
    expect(output).toContain("取り消されました");
  });

  it("複数イベント同時: activeCount > 1 で「同時N件」表示", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10, {
      classification: "eew.forecast",
      head: {
        type: "VXSE44",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();

    displayEewInfo(info!, { activeCount: 3 });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    expect(output).toContain("同時3件");
    expect(output).toContain("Event:");
  });
});
