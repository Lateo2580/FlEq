import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import {
  intensityColor,
  displayEarthquakeInfo,
  displayEewInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  formatElapsedTime,
  formatRelativeTime,
  formatTimestamp,
} from "../../src/ui/formatter";
import type { EewDiff } from "../../src/features/eew-tracker";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
} from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VTSE41_WARN,
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
    expect(output).toContain("EventID:");
  });

  it("EEW差分情報: マグニチュード変化が表示される", () => {
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

    const diff: EewDiff = { magnitudeChange: "+0.3" };
    displayEewInfo(info!, { activeCount: 1, diff });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    expect(output).toContain("+0.3");
  });
});

describe("displayTsunamiInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VTSE41 の大津波警報を critical フレームで表示する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN, {
      head: {
        type: "VTSE41",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });
    const info = parseTsunamiTelegram(msg);
    expect(info).not.toBeNull();

    displayTsunamiInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("╔");
    expect(output).toContain("岩手県");
    expect(output).toContain("巨大");
  });
});

describe("displaySeismicTextInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VXSE56 の本文とタイトルを表示する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1, {
      head: {
        type: "VXSE56",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });
    const info = parseSeismicTextTelegram(msg);
    expect(info).not.toBeNull();

    displaySeismicTextInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("伊豆東部");
    expect(output).toContain("地震の活動状況等に関する情報");
  });
});

// ── フレーム描画テスト ──

describe("フレーム描画", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("地震情報にフレーム文字が含まれる", () => {
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

    // フレーム文字が含まれる（normal レベルの場合 ┌ / └ / │）
    expect(output).toMatch(/[┌└│┐┘├┤─╔╚║╗╝╠╣═]/);
  });

  it("EEW予報にフレーム文字が含まれる", () => {
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

    // EEW 予報は warning レベル → 二重枠
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
  });
});

// ── 時刻フォーマットテスト ──

describe("formatRelativeTime", () => {
  it("数秒前を正しく表示", () => {
    const now = new Date();
    now.setSeconds(now.getSeconds() - 5);
    expect(formatRelativeTime(now.toISOString())).toBe("5秒前");
  });

  it("数分前を正しく表示", () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - 3);
    expect(formatRelativeTime(now.toISOString())).toBe("3分前");
  });

  it("数時間前を正しく表示", () => {
    const now = new Date();
    now.setHours(now.getHours() - 2);
    expect(formatRelativeTime(now.toISOString())).toBe("2時間前");
  });
});

describe("formatTimestamp", () => {
  it("絶対+相対時刻を併記する", () => {
    const now = new Date();
    now.setSeconds(now.getSeconds() - 10);
    const result = formatTimestamp(now.toISOString());
    expect(result).toContain("10秒前");
    expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe("formatElapsedTime", () => {
  it("1時間2分3秒を HH:MM:SS で表示する", () => {
    expect(formatElapsedTime(3_723_000)).toBe("01:02:03");
  });

  it("負の値は 00:00:00 に丸める", () => {
    expect(formatElapsedTime(-10)).toBe("00:00:00");
  });
});
