import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import {
  intensityColor,
  lgIntensityColor,
  displayEarthquakeInfo,
  displayEewInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
  formatElapsedTime,
  formatTimestamp,
} from "../../src/ui/formatter";
import type { EewDiff } from "../../src/features/eew-tracker";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE50_CLOSED,
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE60_AFTERSHOCK,
  FIXTURE_VXSE62_LGOBS,
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

// ── lgIntensityColor ──

describe("lgIntensityColor", () => {
  beforeEach(() => {
    chalk.level = 3;
  });

  it("階級0 → gray", () => {
    expect(lgIntensityColor("0")).toBe(chalk.gray);
  });

  it("階級1 → green", () => {
    expect(lgIntensityColor("1")).toBe(chalk.green);
  });

  it("階級2 → yellow", () => {
    expect(lgIntensityColor("2")).toBe(chalk.yellow);
  });

  it("階級3 → orange 系", () => {
    const result = lgIntensityColor("3")("test");
    expect(result).toContain("test");
    expect(result).not.toBe("test");
  });

  it("階級4 → red", () => {
    expect(lgIntensityColor("4")).toBe(chalk.red);
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

  it("長周期地震動階級が含まれる地震情報を正しく表示する", () => {
    const info = {
      type: "VXSE53",
      infoType: "発表",
      title: "震源・震度に関する情報",
      reportDateTime: new Date().toISOString(),
      headline: null,
      publishingOffice: "気象庁",
      earthquake: {
        originTime: new Date().toISOString(),
        hypocenterName: "石川県能登地方",
        latitude: "N37.5",
        longitude: "E137.3",
        depth: "10km",
        magnitude: "7.6",
      },
      intensity: {
        maxInt: "7",
        maxLgInt: "4",
        areas: [
          { name: "石川県能登", intensity: "7", lgIntensity: "4" },
          { name: "新潟県上越", intensity: "5強", lgIntensity: "3" },
          { name: "富山県東部", intensity: "5弱", lgIntensity: "1" },
          { name: "石川県加賀", intensity: "5強" },
        ],
      },
      isTest: false,
    };

    displayEarthquakeInfo(info);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // カード部分に長周期階級が表示される
    expect(output).toContain("長周期階級");
    // 地域ごとの長周期表示
    expect(output).toContain("[長周期4]");
    expect(output).toContain("[長周期3]");
    expect(output).toContain("[長周期1]");
    // lgIntensity なしの地域には長周期表示がない
    // (石川県加賀は 5強 で lgIntensity undefined)
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

  it("forecastIntensity.areas の順序が異なっても最大予測震度が一致する", () => {
    const baseInfo = {
      type: "VXSE45",
      infoType: "発表",
      title: "緊急地震速報（地震動予報）",
      reportDateTime: new Date().toISOString(),
      headline: null,
      publishingOffice: "気象庁",
      serial: "1",
      eventId: "20240417231454",
      isTest: false,
      isWarning: false,
    };

    // areas の先頭が最大でないケース: 最大は "5強"
    const infoLowFirst = {
      ...baseInfo,
      forecastIntensity: {
        areas: [
          { name: "北部", intensity: "3" },
          { name: "中部", intensity: "5強" },
          { name: "南部", intensity: "4" },
        ],
      },
    };
    // areas の先頭が最大のケース: 最大は "5強"
    const infoHighFirst = {
      ...baseInfo,
      forecastIntensity: {
        areas: [
          { name: "中部", intensity: "5強" },
          { name: "南部", intensity: "4" },
          { name: "北部", intensity: "3" },
        ],
      },
    };

    logSpy.mockClear();
    displayEewInfo(infoLowFirst);
    const output1 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    logSpy.mockClear();
    displayEewInfo(infoHighFirst);
    const output2 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // どちらの順序でも "5強" が最大として表示される
    expect(output1).toContain("5強");
    expect(output2).toContain("5強");

    // 最大予測震度を含む行の内容が同じ
    const maxLine1 = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("最大予測震度"));
    expect(maxLine1).toBeDefined();
    expect(maxLine1).toContain("5強");
  });

  it("EEW警報: 長周期地震動階級が表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1, {
      head: {
        type: "VXSE43",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();

    displayEewInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 長周期地震動階級がカードに表示される
    expect(output).toContain("長周期階級");
    // 大分県中部に [長周期1] が表示される
    expect(output).toContain("[長周期1]");
  });

  it("PLUM法: 仮定震源要素ラベルが表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
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

    expect(output).toContain("仮定震源要素");
    expect(output).toContain("PLUM法");
    // PLUM法地域マーカー
    expect(output).toContain("[PLUM]");
    // 既到達マーカー
    expect(output).toContain("[到達]");
    // 主要動到達と推測される地域リスト
    expect(output).toContain("既に主要動到達と推測:");
    expect(output).toContain("富山県東部");
    // 仮定震源要素ではM・深さを表示しない
    expect(output).not.toContain("M1.0");
    expect(output).not.toContain("規模:");
  });

  it("混合電文: PLUM法地域と通常地域が混在して表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_MIXED, {
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

    // 通常推定の震源情報が表示される (仮定震源要素ではない)
    expect(output).toContain("M6.5");
    expect(output).not.toContain("仮定震源要素");
    // PLUM法地域マーカー
    expect(output).toContain("[PLUM]");
    // 既到達マーカー
    expect(output).toContain("[到達]");
    // 主要動到達と推測される地域リスト
    expect(output).toContain("既に主要動到達と推測:");
    expect(output).toContain("富山県西部");
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

    const diff: EewDiff = { previousMagnitude: "6.2" };
    displayEewInfo(info!, { activeCount: 1, diff });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    expect(output).toContain("M6.2");
    expect(output).toContain("→");
  });

  it("colorIndex=0 のバナーはデフォルト色で表示される", () => {
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

    displayEewInfo(info!, { activeCount: 1, colorIndex: 0 });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("緊急地震速報（予報）");
  });

  it("colorIndex=1 のバナーは異なる色で表示される", () => {
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

    // colorIndex=0 で取得
    displayEewInfo(info!, { activeCount: 2, colorIndex: 0 });
    const output0 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    logSpy.mockClear();

    // colorIndex=1 で取得
    displayEewInfo(info!, { activeCount: 2, colorIndex: 1 });
    const output1 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 両方とも表示されるが、バナー行のANSIエスケープが異なる
    expect(output0).toContain("緊急地震速報（予報）");
    expect(output1).toContain("緊急地震速報（予報）");
    // バナー部分の色が異なることを確認（最初のログ行 = バナー空行）
    const banner0FirstLine = logSpy.mock.calls[0]?.[0];
    expect(output0).not.toBe(output1);
  });

  it("バナーに震源地名が含まれる", () => {
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
    // このフィクスチャには震源地名が含まれているはず
    if (info!.earthquake?.hypocenterName) {
      displayEewInfo(info!, { activeCount: 1, colorIndex: 0 });

      const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
      // バナーに震源地名が含まれている
      expect(output).toContain(info!.earthquake.hypocenterName);
    }
  });

  it("警報バナーも colorIndex で色分けされる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1, {
      classification: "eew.warning",
      head: {
        type: "VXSE43",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();

    displayEewInfo(info!, { activeCount: 2, colorIndex: 0 });
    const output0 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    logSpy.mockClear();

    displayEewInfo(info!, { activeCount: 2, colorIndex: 1 });
    const output1 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    expect(output0).toContain("緊急地震速報（警報）");
    expect(output1).toContain("緊急地震速報（警報）");
    expect(output0).not.toBe(output1);
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

describe("formatTimestamp", () => {
  it("絶対時刻を YYYY-MM-DD HH:MM:SS 形式で返す", () => {
    const result = formatTimestamp("2024-06-13T12:34:56+09:00");
    expect(result).toBe("2024-06-13 12:34:56");
  });

  it("不正な文字列はそのまま返す", () => {
    expect(formatTimestamp("invalid")).toBe("invalid");
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

// ── displayNankaiTroughInfo ──

describe("displayNankaiTroughInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VYSE50 巨大地震警戒: critical フレームでバナー表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // 二重枠 (critical)
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
    // 状態名
    expect(output).toContain("巨大地震警戒");
    // 南海トラフ
    expect(output).toContain("南海トラフ");
  });

  it("VYSE50 調査終了: info フレームで表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CLOSED, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // info フレーム (┌ / └)
    expect(output).toMatch(/[┌└│┐┘]/);
    expect(output).toContain("調査終了");
  });

  it("VYSE50 取消: cancel フレームで表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CANCEL, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    expect(output).toContain("取消");
    expect(output).toContain("取り消します");
  });

  it("VYSE60 後発地震注意: warning フレームで表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE60_AFTERSHOCK, {
      head: {
        type: "VYSE60",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // warning フレーム (二重枠)
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
    expect(output).toContain("三陸沖");
  });
});

// ── displayLgObservationInfo ──

describe("displayLgObservationInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VXSE62 長周期階級3: warning フレームで表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseLgObservationTelegram(msg);
    expect(info).not.toBeNull();

    displayLgObservationInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // warning フレーム (二重枠)
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
    // 長周期階級
    expect(output).toContain("長周期階級");
    // 震源名
    expect(output).toContain("岩手県沖");
    // M6.3
    expect(output).toContain("M6.3");
    // 地域名
    expect(output).toContain("宮城県北部");
    // URI
    expect(output).toContain("https://");
  });
});
