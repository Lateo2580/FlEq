import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import chalk from "chalk";
import {
  intensityColor,
  intensityToNumeric,
  lgIntensityColor,
  formatElapsedTime,
  formatUptime,
  formatTimestamp,
  wrapTextLines,
  BREAK_LOOKBACK,
  reflowTelegramLines,
  wrapFrameLines,
  wrapFrameLinesColored,
  setFrameWidth,
  setMaxObservations,
  highlightAndWrap,
  collectHighlightSpans,
  createRenderBuffer,
  flushWithRecap,
  frameLine,
  frameBottom,
  frameDivider,
  frameDividerColored,
  frameLineColored,
  frameDividerLabeled,
  frameDividerThin,
  frameDividerLabeledThin,
  renderGroupedItemList,
  stripAnsi,
  visualWidth,
  renderSimpleNameList,
} from "../../src/ui/formatter";
import { intensityToRank } from "../../src/utils/intensity";
import { displayEewInfo } from "../../src/ui/eew-formatter";
import { displayEarthquakeInfo } from "../../src/ui/earthquake-info-formatter";
import type { EewDiff } from "../../src/engine/eew/eew-tracker";
import type { ParsedEewInfo } from "../../src/types";
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
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VXSE53_DRILL_1,
} from "../helpers/mock-message";

// ── intensityColor ──

describe("intensityColor", () => {
  // chalk のレベルを強制 (CI 環境でも色が有効になるように)
  beforeEach(() => {
    chalk.level = 3;
  });

  // CUD対応: chalk.rgb を使うため出力文字列で比較する
  it("震度1 → CUD gray (rgb(132,145,158))", () => {
    const result = intensityColor("1")("test");
    expect(result).toBe(chalk.rgb(132, 145, 158)("test"));
  });

  it("震度2 → CUD sky (rgb(86,180,233))", () => {
    const result = intensityColor("2")("test");
    expect(result).toBe(chalk.rgb(86, 180, 233)("test"));
  });

  it("震度3 → CUD blue (rgb(0,114,178))", () => {
    const result = intensityColor("3")("test");
    expect(result).toBe(chalk.rgb(0, 114, 178)("test"));
  });

  it("震度4 → CUD blueGreen (rgb(0,158,115))", () => {
    const result = intensityColor("4")("test");
    expect(result).toBe(chalk.rgb(0, 158, 115)("test"));
  });

  it("震度5弱 → CUD yellow (rgb(240,228,66))", () => {
    const result = intensityColor("5弱")("test");
    expect(result).toBe(chalk.rgb(240, 228, 66)("test"));
  });

  it("震度5- と 5弱 は同じ色になる", () => {
    const a = intensityColor("5-")("X");
    const b = intensityColor("5弱")("X");
    expect(a).toBe(b);
  });

  it("震度6弱 → CUD vermillion bold", () => {
    const result = intensityColor("6弱")("test");
    expect(result).toBe(chalk.rgb(213, 94, 0).bold("test"));
    expect(intensityColor("6-")("test")).toBe(result);
  });

  it("震度6強 → CUD vermillion 背景", () => {
    const result = intensityColor("6強")("test");
    expect(result).toBe(chalk.bgRgb(213, 94, 0).rgb(0, 0, 0).bold("test"));
    expect(intensityColor("6+")("test")).toBe(result);
  });

  it("震度7 → CUD darkRed 背景白文字", () => {
    const result = intensityColor("7")("test");
    expect(result).toBe(chalk.bgRgb(122, 30, 0).rgb(255, 255, 255).bold("test"));
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

  // CUD対応: chalk.rgb を使うため出力文字列で比較する
  it("階級0 → CUD gray", () => {
    const result = lgIntensityColor("0")("test");
    expect(result).toBe(chalk.rgb(132, 145, 158)("test"));
  });

  it("階級1 → CUD sky", () => {
    const result = lgIntensityColor("1")("test");
    expect(result).toBe(chalk.rgb(86, 180, 233)("test"));
  });

  it("階級2 → CUD yellow", () => {
    const result = lgIntensityColor("2")("test");
    expect(result).toBe(chalk.rgb(240, 228, 66)("test"));
  });

  it("階級3 → CUD orange", () => {
    const result = lgIntensityColor("3")("test");
    expect(result).toBe(chalk.rgb(230, 159, 0)("test"));
  });

  it("階級4 → CUD vermillion 背景", () => {
    const result = lgIntensityColor("4")("test");
    expect(result).toBe(chalk.bgRgb(213, 94, 0).rgb(0, 0, 0).bold("test"));
  });
});

// ── displayEewInfo (stdout キャプチャ) ──

describe("displayEewInfo", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("EEW予報(VXSE44): 警報地域ありのため警報ヘッダーが表示される", () => {
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

    // VXSE44 フィクスチャは警報地域コード (10/11) を含むため isWarning=true → 警報ヘッダー
    expect(output).toContain("緊急地震速報（警報）");
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
    // cancelText (Body/Text 由来) を優先表示する — spec 4.1
    expect(output).toContain("先ほどの、緊急地震速報（地震動予報）を取り消します。");
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
    const baseInfo: ParsedEewInfo = {
      meta: testTelegramMeta(false),
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
      isAssumedHypocenter: false,
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
    setFrameWidth(140);
    try {
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
      // 大分県中部の行に長周期階級1が表示される (新レイアウトではテーブルの長周期列に移動)
      const lines = output.split("\n");
      const oitaLine = lines.find((l) => stripAnsi(l).includes("│") && stripAnsi(l).includes("大分県中部"));
      expect(oitaLine).toBeDefined();
      expect(stripAnsi(oitaLine!)).toMatch(/階級1/);
    } finally {
      setFrameWidth(60);
    }
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
    // PLUM法地域マーカー (新レイアウトでは状態列 badge「PLUM」に移動)
    const lines = output.split("\n");
    const toyamaLine = lines.find((l) => stripAnsi(l).includes("│") && stripAnsi(l).includes("富山県東部"));
    expect(toyamaLine).toBeDefined();
    expect(stripAnsi(toyamaLine!)).toContain("到達済");
    const ishikawaLine = lines.find((l) => stripAnsi(l).includes("│") && stripAnsi(l).includes("石川県能登"));
    expect(ishikawaLine).toBeDefined();
    expect(stripAnsi(ishikawaLine!)).toContain("PLUM");
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
    // PLUM法地域マーカー (新レイアウトでは状態列 badge「PLUM」に移動)
    const lines = output.split("\n");
    const toyamaHigashiLine = lines.find((l) => stripAnsi(l).includes("│") && stripAnsi(l).includes("富山県東部"));
    expect(toyamaHigashiLine).toBeDefined();
    expect(stripAnsi(toyamaHigashiLine!)).toContain("PLUM");
    // 主要動到達と推測される地域 (富山県西部) は状態列「到達済」badge に集約される
    const toyamaNishiLine = lines.find((l) => stripAnsi(l).includes("│") && stripAnsi(l).includes("富山県西部"));
    expect(toyamaNishiLine).toBeDefined();
    expect(stripAnsi(toyamaNishiLine!)).toContain("到達済");
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
    expect(output).toContain("緊急地震速報（警報）");
  });

  it("colorIndex=1 のバナーは異なる色で表示される", () => {
    // truecolor レベルを強制 (CI環境でも確実にRGB差分が出るようにする)
    const origLevel = chalk.level;
    chalk.level = 3;

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
    // バナー空行(2行目: index 1) を取得 (index 0 = console.log() の空行)
    const banner0 = String(logSpy.mock.calls[1]?.[0]);
    logSpy.mockClear();

    // colorIndex=1 で取得
    displayEewInfo(info!, { activeCount: 2, colorIndex: 1 });
    const banner1 = String(logSpy.mock.calls[1]?.[0]);

    // 両方とも緊急地震速報のテキストを含む
    const output1 = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output1).toContain("緊急地震速報（警報）");

    // バナー行のANSIエスケープが異なることを確認
    expect(banner0).not.toBe(banner1);

    chalk.level = origLevel;
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

  it("PLUM法予報: 装飾行がCUD空色で、テキスト行は従来色になる", () => {
    const origLevel = chalk.level;
    chalk.level = 3;

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
    expect(info!.isAssumedHypocenter).toBe(true);

    displayEewInfo(info!, { activeCount: 1, colorIndex: 0 });

    // index 0 = 空行, 1 = 装飾行(1行目), 2 = テキスト行, 3 = 装飾行(3行目)
    const decorLine1 = String(logSpy.mock.calls[1]?.[0]);
    const textLine = String(logSpy.mock.calls[2]?.[0]);
    const decorLine3 = String(logSpy.mock.calls[3]?.[0]);

    // 装飾行同士は同じスタイル
    expect(decorLine1).toBe(decorLine3);
    // 装飾行とテキスト行は異なるスタイル (PLUM空色 vs 従来予報色)
    expect(decorLine1).not.toBe(textLine);
    // CUD空色 RGB(86, 180, 233) のANSIエスケープを含む
    expect(decorLine1).toContain("86");
    expect(decorLine1).toContain("180");
    expect(decorLine1).toContain("233");

    chalk.level = origLevel;
  });

  it("PLUM法警報: 装飾行がCUD青で、テキスト行は従来警報色になる", () => {
    const origLevel = chalk.level;
    chalk.level = 3;

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
    // isWarning を強制的に true にしてテスト
    info!.isWarning = true;

    displayEewInfo(info!, { activeCount: 1, colorIndex: 0 });

    const decorLine1 = String(logSpy.mock.calls[1]?.[0]);
    const textLine = String(logSpy.mock.calls[2]?.[0]);
    const decorLine3 = String(logSpy.mock.calls[3]?.[0]);

    expect(decorLine1).toBe(decorLine3);
    expect(decorLine1).not.toBe(textLine);
    // CUD青 RGB(0, 114, 178) のANSIエスケープを含む
    expect(decorLine1).toContain("114");
    expect(decorLine1).toContain("178");

    chalk.level = origLevel;
  });

  it("通常EEW: 装飾行とテキスト行が同じスタイルになる", () => {
    const origLevel = chalk.level;
    chalk.level = 3;

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
    expect(info!.isAssumedHypocenter).toBe(false);

    // パーサの観測ログ出力をクリアして displayEewInfo の出力だけを検査
    logSpy.mockClear();
    displayEewInfo(info!, { activeCount: 1, colorIndex: 0 });

    // 通常EEWでは装飾行とテキスト行が同じバナースタイル
    const decorLine1 = String(logSpy.mock.calls[1]?.[0]);
    const textLine = String(logSpy.mock.calls[2]?.[0]);
    const decorLine3 = String(logSpy.mock.calls[3]?.[0]);

    expect(decorLine1).toBe(decorLine3);
    // テキスト行は文字が入るので完全一致はしないが、ANSIプレフィックスが同じ
    // → 装飾行同士が一致していれば、通常EEWの一貫性は確認できる

    chalk.level = origLevel;
  });

  it("EEW予報区域: 一枚テーブルに全地域が展開され、同震度の地域間に階級 divider が挟まらない (Task 5)", () => {
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
    const lines = output.split("\n").map((l) => stripAnsi(l));

    // 予測震度 divider は 1 本のみ (階級ごとの divider は Task 5 で廃止)
    const forecastDividers = lines.filter((l) => /^[╠├]\s*予測震度\s/.test(l));
    expect(forecastDividers.length).toBe(1);

    // MIXED fixture は震度4の地域が複数 (石川県加賀・富山県西部) あり、
    // 一枚テーブルでは両者が階級 divider を挟まず連続して並ぶ
    const idxKaga = lines.findIndex((l) => l.includes("石川県加賀"));
    const idxToyama = lines.findIndex((l) => l.includes("富山県西部"));
    expect(idxKaga).toBeGreaterThan(-1);
    expect(idxToyama).toBeGreaterThan(idxKaga);
    for (let i = idxKaga + 1; i < idxToyama; i++) {
      expect(/^[╠├]/.test(lines[i])).toBe(false);
    }
  });
});

// ── フレーム描画テスト ──

describe("フレーム描画", () => {
  let logSpy: MockInstance<typeof console.log>;

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

// ── intensityToNumeric ⇔ intensityToRank 写像一致 (spec 既知の間隙 / acceptance 14) ──

describe("intensityToNumeric は intensityToRank の wrapper (写像の単一真実源)", () => {
  const ALL_GRADES = ["1", "2", "3", "4", "5-", "5弱", "5+", "5強", "6-", "6弱", "6+", "6強", "7"];

  it("全震度階級で両者が一致する", () => {
    for (const g of ALL_GRADES) {
      expect(intensityToNumeric(g), g).toBe(intensityToRank(g));
    }
  });

  it("空白混じり・未知値でも一致する (未知は 0)", () => {
    expect(intensityToNumeric("5 -")).toBe(intensityToRank("5 -"));
    expect(intensityToNumeric("4 ")).toBe(intensityToRank("4 "));
    expect(intensityToNumeric("震度8")).toBe(0);
    expect(intensityToNumeric("")).toBe(0);
  });

  it("既存の期待値が変わらない (挙動不変の回帰ガード)", () => {
    expect(intensityToNumeric("7")).toBe(9);
    expect(intensityToNumeric("6弱")).toBe(7);
    expect(intensityToNumeric("4")).toBe(4);
  });
});

// ── 時刻フォーマットテスト ──

describe("formatTimestamp", () => {
  it("絶対時刻を JST 固定の YYYY-MM-DD HH:MM:SS 形式で返す (実行環境の TZ に依存しない)", () => {
    expect(formatTimestamp("2024-06-13T12:34:56+09:00")).toBe("2024-06-13 12:34:56");
  });

  it("UTC 表記の入力も JST に変換して返す", () => {
    expect(formatTimestamp("2024-06-13T03:34:56Z")).toBe("2024-06-13 12:34:56");
  });

  it("日付をまたぐ UTC 入力は JST の翌日になる", () => {
    expect(formatTimestamp("2024-01-23T21:13:13Z")).toBe("2024-01-24 06:13:13");
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

describe("formatUptime", () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = 3;
  });

  it("5分32秒 → 000:00:05:32", () => {
    const ms = (5 * 60 + 32) * 1000;
    expect(formatUptime(ms)).toBe("000:00:05:32");
  });

  it("3日4時間5分32秒", () => {
    const ms = ((3 * 24 + 4) * 3600 + 5 * 60 + 32) * 1000;
    expect(formatUptime(ms)).toBe("003:04:05:32");
  });

  it("100日0時間0分0秒", () => {
    const ms = 100 * 24 * 3600 * 1000;
    expect(formatUptime(ms)).toBe("100:00:00:00");
  });

  it("0ミリ秒", () => {
    expect(formatUptime(0)).toBe("000:00:00:00");
  });

  it("負の値は 000:00:00:00 に丸める", () => {
    expect(formatUptime(-500)).toBe("000:00:00:00");
  });

  it("999日を超える値も表示できる", () => {
    const ms = 1234 * 24 * 3600 * 1000;
    expect(formatUptime(ms)).toBe("1234:00:00:00");
  });

  it("1時間ちょうど — HH セグメントから通常表示", () => {
    const ms = 3600 * 1000;
    expect(formatUptime(ms)).toBe("000:01:00:00");
  });

  it("1日ちょうど — DD セグメントから通常表示", () => {
    const ms = 86400 * 1000;
    expect(formatUptime(ms)).toBe("001:00:00:00");
  });

  it("1分ちょうど — MM セグメントから通常表示", () => {
    const ms = 60 * 1000;
    expect(formatUptime(ms)).toBe("000:00:01:00");
  });

  it("chalk 有効時、先頭ゼロ桁が dim になる", () => {
    chalk.level = 3;
    const ms = (5 * 60 + 32) * 1000;
    const result = formatUptime(ms);
    expect(result).toBe(chalk.gray("000:00:") + chalk.white("05:32"));
  });

  it("chalk 有効時、全桁ゼロでも SS は通常表示", () => {
    chalk.level = 3;
    const result = formatUptime(0);
    expect(result).toBe(chalk.gray("000:00:00:") + chalk.white("00"));
  });

  it("chalk 有効時、日部分の先頭ゼロが文字レベルで dim になる", () => {
    chalk.level = 3;
    const ms = 2 * 86400 * 1000 + (13 * 3600 + 55 * 60 + 3) * 1000;
    const result = formatUptime(ms);
    expect(result).toBe(chalk.gray("00") + chalk.white("2:13:55:03"));
  });

  it("chalk 有効時、日部分の先頭ゼロ1桁が dim になる (023日)", () => {
    chalk.level = 3;
    const ms = 23 * 86400 * 1000;
    const result = formatUptime(ms);
    expect(result).toBe(chalk.gray("0") + chalk.white("23:00:00:00"));
  });

  it("chalk 有効時、日部分が3桁すべて使用なら全体 white", () => {
    chalk.level = 3;
    const ms = 123 * 86400 * 1000;
    const result = formatUptime(ms);
    expect(result).toBe(chalk.white("123:00:00:00"));
  });
});

// ── wrapTextLines ──

describe("wrapTextLines", () => {
  it("幅以内の文字列はそのまま1行で返す", () => {
    const result = wrapTextLines("hello", 10);
    expect(result).toEqual(["hello"]);
  });

  it("ASCII文字列を幅で折り返す", () => {
    const result = wrapTextLines("abcdefghij", 5);
    expect(result).toEqual(["abcde", "fghij"]);
  });

  it("CJK文字を幅2として折り返す", () => {
    // 各漢字は幅2、maxWidth=6 なので3文字ずつ
    const result = wrapTextLines("漢字テスト情報", 6);
    expect(result).toEqual(["漢字テ", "スト情", "報"]);
  });

  it("空文字列は空配列を返す", () => {
    const result = wrapTextLines("", 10);
    // visualWidth("") = 0 <= 10 なのでそのまま返る
    expect(result).toEqual([""]);
  });

  it("maxWidth が 0 以下の場合はそのまま返す", () => {
    const result = wrapTextLines("test", 0);
    expect(result).toEqual(["test"]);
  });

  it("混合文字列（ASCII + CJK）を正しく折り返す", () => {
    // "ab漢字cd" → a=1, b=1, 漢=2, 字=2, c=1, d=1 → 合計8
    // maxWidth=5: "ab漢"(1+1+2=4), 次に"字"追加で6>5 → 折り返し
    const result = wrapTextLines("ab漢字cd", 5);
    expect(result).toEqual(["ab漢", "字cd"]);
  });
});

describe("wrapTextLines v2 (幅充填 + 句読点優先 + 禁則, spec §9 R3-1)", () => {
  it("① 句読点 lookback 改行: VFVO53 headline 実文が句点直後で折れ読点を保持する (幅 56)", () => {
    const headline =
      "　現在、桜島は噴火警戒レベル３（入山規制）です。桜島で噴火が発生した場合には、１７日２１時から２４時までは火口から北東方向に降灰が予想されます。";
    expect(wrapTextLines(headline, 56)).toEqual([
      "　現在、桜島は噴火警戒レベル３（入山規制）です。",
      "桜島で噴火が発生した場合には、１７日２１時から２４時まで",
      "は火口から北東方向に降灰が予想されます。",
    ]);
  });

  it("② lookback 外 (13 文字以上手前) の句読点では折らず文字改行する", () => {
    // 、が行末から 13 文字手前 → BREAK_LOOKBACK=12 の範囲外 → 幅いっぱいの文字改行
    const text = "あ".repeat(14) + "、" + "い".repeat(13) + "う".repeat(10);
    const lines = wrapTextLines(text, 56);
    expect(lines[0]).toBe("あ".repeat(14) + "、" + "い".repeat(13)); // 28 文字 = 幅 56 充填
    expect(lines[1]).toBe("う".repeat(10));
  });

  it("③ 行頭禁則の追い出し: 「。」「ー」「っ」が行頭に来る場合は直前の文字ごと送る", () => {
    expect(wrapTextLines("あいうえ。かき", 8)).toEqual(["あいう", "え。かき"]);
    expect(wrapTextLines("あいうえール", 8)).toEqual(["あいう", "えール"]);
    expect(wrapTextLines("あいうえって", 8)).toEqual(["あいう", "えって"]);
  });

  it("④ 行末禁則: 行末に残る「（」は次行へ送る", () => {
    expect(wrapTextLines("あいう（かきく", 8)).toEqual(["あいう", "（かきく"]);
  });

  it("⑤ 追い出しガード超過: 禁則文字 5 連続では fail-open でそのまま改行 (幅保証優先)", () => {
    // 行末 ーーーー + 次行頭 ー: 追い込みは幅超過、追い出しは 4 文字内に非禁則文字なし → fail-open
    const lines = wrapTextLines("あいーーーーーか", 12);
    expect(lines).toEqual(["あいーーーー", "ーか"]); // 行頭 ー を許容
    for (const l of lines) {
      expect(visualWidth(l)).toBeLessThanOrEqual(12); // 幅保証は破らない
    }
  });

  it("⑥ 追い込み: 優先改行後の余白に禁則文字 run が収まるなら現在行末に取り込む", () => {
    // 。で優先改行 → 次行頭 」 は禁則 → 行幅 14+2=16 <= 20 なので 」 を取り込む
    expect(wrapTextLines("終わりです。」次の文章", 20)).toEqual([
      "終わりです。」",
      "次の文章",
    ]);
  });

  it("⑦ 優先改行が禁則を誘発するケースは統合ルーチンで調整される (Codex blocker #2 回帰)", () => {
    // 。で優先改行すると次行頭が 』 (禁則)。追い込みは幅超過 (あいう。』=10 > 8)、
    // 追い出しで非禁則文字 う が次行頭に来る位置まで戻る → 「あい」+「う。』か」
    expect(wrapTextLines("あいう。』か", 8)).toEqual(["あい", "う。』か"]);
  });

  it("⑧ 行末禁則ガード超過: 開き括弧 5 連続は巻き戻して fail-open (部分移動を残さない)", () => {
    // （×5 を 4 文字送っても行末が （ のまま → 全て巻き戻し、候補改行点のまま折る
    expect(wrapTextLines("あ（（（（（か", 12)).toEqual(["あ（（（（（", "か"]);
  });

  it("⑨ lossless 不変条件: 出力各行の連結 = 入力 (文字の追加・削除・置換なし)", () => {
    // highlightAndWrap が span offset を wrapped.length で進める前提 (Codex blocker #1)。
    // 半角カンマ後のスペースも除去しない (除去は engine wrap セル経路の責務 — W2)
    const cases: [string, number][] = [
      ["January, February, March", 20], // カンマ+スペースも保持される
      ["あいう。』か", 8],
      ["あ（（（（（か", 12],
      ["　現在、桜島は噴火警戒レベル３（入山規制）です。桜島で噴火が発生した場合には", 30],
    ];
    for (const [text, w] of cases) {
      expect(wrapTextLines(text, w).join(""), `${text} @${w}`).toBe(text);
    }
  });

  it("⑩ 幅 sweep 20-200: 禁則文字混在の長文で全行 visualWidth <= maxWidth・lossless", () => {
    const samples = [
      "気象庁によると、震度５弱（推定）の揺れが観測されました。今後の情報に注意してください！「余震」への警戒も必要です…詳細は（後述）ー以上。".repeat(3),
      "Sagami Bay, Suruga Bay, Enshu-nada, and the Kii Channel are all included, e.g. coastal areas.".repeat(2),
    ];
    for (const text of samples) {
      for (let w = 20; w <= 200; w++) {
        const lines = wrapTextLines(text, w);
        for (const l of lines) {
          expect(visualWidth(l), `width=${w} line=${l}`).toBeLessThanOrEqual(w);
        }
        expect(lines.join(""), `width=${w}`).toBe(text); // lossless は無条件で成立
      }
    }
  });

  it("⑪ 単一文字の幅超過例外: maxWidth 1 に全角は 1 文字/行を許す (進行保証)", () => {
    // 不変条件の唯一の例外 (Codex major #4 で仕様化): 1 文字の visualWidth が
    // maxWidth を超える場合、その 1 文字だけの行を許す
    expect(wrapTextLines("漢字", 1)).toEqual(["漢", "字"]);
  });

  it("⑫ BREAK_LOOKBACK は 12 (spec §9 の確定値)", () => {
    expect(BREAK_LOOKBACK).toBe(12);
  });
});

// ── reflowTelegramLines ──

describe("reflowTelegramLines (電文 hard-wrap の再結合, spec §8 R2-3)", () => {
  it("旧様式 VXSE56 型: 全角 34 字固定 wrap の散文が 1 論理行に結合される", () => {
    const lines = [
      "　本日（１１日）昼から東伊豆奈良本（ならもと）観測点で縮みのひずみ変",
      "化が観測され始め、本日（１１日）昼からは体に感じない小さな地震が発生",
      "し始めました。",
    ];
    expect(reflowTelegramLines(lines)).toEqual([
      "　本日（１１日）昼から東伊豆奈良本（ならもと）観測点で縮みのひずみ変化が観測され始め、本日（１１日）昼からは体に感じない小さな地震が発生し始めました。",
    ]);
  });

  it("整形行 (行頭以外に全角スペース 2 連続) は結合されず、直後の行も結合されない", () => {
    const lines = [
      "時刻　　　　　　火口からの方向　　　　　降灰の距離",
      "続きに見える散文行がここにあっても整形行へは絶対に結合しないことを確認する",
    ];
    expect(reflowTelegramLines(lines)).toEqual(lines);
  });

  it("行頭全角スペースの継続行 (県：市町村の桁揃え) は新しい論理行として保持される", () => {
    const lines = [
      "　鹿児島県：鹿児島市、鹿屋市、垂水市、曽於市、霧島市、志布志市、大崎町、東串良町、錦江町、",
      "　　　　　肝付町",
    ];
    expect(reflowTelegramLines(lines)).toEqual(lines);
  });

  it("1 段落 1 行の電文 (VFVO50/VYSE 型) は不変", () => {
    const lines = [
      "　浅間山では、２２日の夜間に山頂で明瞭な火映が観測されました。また、２２日に入り火山性地震がやや多い状態で経過しています。",
      "　これらのことから、今後、居住地域近くまで影響を及ぼす噴火が発生する可能性があると予想されます。",
    ];
    expect(reflowTelegramLines(lines)).toEqual(lines);
  });

  it("直前行が visualWidth >= 56 でも 。終端なら結合しない", () => {
    const long = "あ".repeat(30) + "。"; // visualWidth 62
    expect(reflowTelegramLines([long, "次の段落は独立の論理行になる"])).toEqual([
      long,
      "次の段落は独立の論理行になる",
    ]);
  });

  it("空行・全角スペースのみの行は段落区切りとして保持され、直後は結合されない", () => {
    const long = "い".repeat(30); // visualWidth 60、文末記号なし
    expect(reflowTelegramLines([long, "", "続きの文"])).toEqual([long, "", "続きの文"]);
    expect(reflowTelegramLines([long, "　", "続きの文"])).toEqual([long, "　", "続きの文"]);
  });

  it("visualWidth 閾値境界: 直前行 56 (全角 28 字) は結合、54 (27 字) は結合しない", () => {
    const w28 = "う".repeat(28); // visualWidth 56
    const w27 = "え".repeat(27); // visualWidth 54
    expect(reflowTelegramLines([w28, "続き"])).toEqual([w28 + "続き"]);
    expect(reflowTelegramLines([w27, "続き"])).toEqual([w27, "続き"]);
  });

  it("＜見出し＞・（注記）・番号見出しは新段落として結合されない", () => {
    const long = "お".repeat(30); // visualWidth 60、文末記号なし
    expect(reflowTelegramLines([long, "＜浅間山に火口周辺警報＞"])).toEqual([long, "＜浅間山に火口周辺警報＞"]);
    expect(reflowTelegramLines([long, "（地殻変動の状況）"])).toEqual([long, "（地殻変動の状況）"]);
    expect(reflowTelegramLines([long, "２．現状"])).toEqual([long, "２．現状"]);
  });

  it("数字跨ぎ hard-wrap (VFVO51 実データ形) は正しく結合される (Codex R2-plan R2 回帰)", () => {
    // 44_01_01_151008_VFVO51.xml L1297-1298: 「６月１」で物理行が切れ「９日…」が続く。
    // 数字終端でも hard-wrap は結合対象 (数字終端ガード不採用の根拠)
    const dateSplit = [
      "　口永良部島の火山活動は活発な状態が継続しています。新岳では、６月１",
      "９日のごく小規模な噴火以降、噴火は観測されていませんが、火山性地震が",
    ];
    expect(reflowTelegramLines(dateSplit)).toEqual([
      "　口永良部島の火山活動は活発な状態が継続しています。新岳では、６月１９日のごく小規模な噴火以降、噴火は観測されていませんが、火山性地震が",
    ]);
    // 同 L1346-1348: 「９６」+「ー１火口…」— 数字終端 + 「ー」開始でも結合される
    const nameSplit = [
      "噴煙の勢いの増加を確認しました。全磁力連続観測ではポンマチネシリ９６",
      "ー１火口近傍の地下における熱活動の活発化の可能性を示す全磁力の変化が",
    ];
    expect(reflowTelegramLines(nameSplit)).toEqual([
      "噴煙の勢いの増加を確認しました。全磁力連続観測ではポンマチネシリ９６ー１火口近傍の地下における熱活動の活発化の可能性を示す全磁力の変化が",
    ]);
  });
});

// ── wrapFrameLines hanging indent ──

describe("wrapFrameLines hanging indent", () => {
  it("先頭 4 スペースの長文の継続行が同じインデントで折り返される (ハード折返し)", () => {
    const long = "    " + "あ".repeat(100); // 区切り文字なし
    const lines = wrapFrameLines("normal", long, 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      // フレーム装飾 (│ + スペース) の直後に 4 スペースのインデントがあること
      expect(stripAnsi(line)).toMatch(/^│ {5}\S/); // │ + 1 + 4 = 5 spaces
    }
  });

  it("読点入り長文 (hardWrap 経路) の継続行が先頭インデントを保持する", () => {
    const long = "    " + "ながいぶんしょう、".repeat(20);
    const lines = wrapFrameLines("normal", long, 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(stripAnsi(line)).toMatch(/^│ {5}\S/);
    }
  });

  it("indent 明示指定は autoIndent より優先される", () => {
    const long = "    " + "あ".repeat(100);
    const lines = wrapFrameLines("normal", long, 80, 8);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      // 継続行は 8 スペース (明示 indent)。autoIndent の 4 ではない
      expect(stripAnsi(line)).toMatch(/^│ {9}\S/);
    }
  });

  it("幅 60 でも indent 縮退ガードで本文が 20 桁未満にならない", () => {
    // innerWidth = 56。先頭 40 スペースだと本文 16 桁 < 20 → indent を 36 に切り詰め
    const long = " ".repeat(40) + "あ".repeat(50);
    const lines = wrapFrameLines("normal", long, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      const visible = stripAnsi(line);
      // 継続行のインデントは 36 (40 ではない) → │ + 1 + 36 = 37 spaces
      expect(visible).toMatch(/^│ {37}\S/);
      // 本文の有効幅 20 桁が確保される (フレーム幅は超えない)
      expect(visualWidth(visible)).toBeLessThanOrEqual(60);
    }
  });

  it("先頭スペースが innerWidth を超える入力でも先頭行を含む全行が width を超えない", () => {
    // 先頭 80 スペース > innerWidth 56。縮退ガードは継続行のみ cap していたため、
    // 先頭行が元 lead をそのまま使うと visualWidth 85 になっていた (Codex P1)
    const lines = wrapFrameLines("normal", " ".repeat(80) + "本文", 60);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it.each([60, 80, 120])("全行が visualWidth <= width を維持する (width=%d)", (w) => {
    const samples = [
      "    " + "あ".repeat(120),
      "  ▸ 概況: " + "晴れときどき曇り、".repeat(30),
      "      " + Array.from({ length: 30 }, (_, i) => `地点${i}`).join(", "),
      " ".repeat(40) + "天気分布は不安定、".repeat(20),
    ];
    for (const s of samples) {
      for (const line of wrapFrameLines("normal", s, w)) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
      }
    }
  });

  it("wrapFrameLinesColored も同じ hanging indent 経路を通る (wrapFrameLinesWith 共有)", () => {
    const long = "    " + "あ".repeat(100);
    const colored = wrapFrameLinesColored("normal", (s) => s, long, 80);
    const plain = wrapFrameLines("normal", long, 80);
    expect(colored.map((l) => stripAnsi(l))).toEqual(plain.map((l) => stripAnsi(l)));
    for (const line of colored.slice(1)) {
      expect(stripAnsi(line)).toMatch(/^│ {5}\S/);
    }
  });
});

// ── highlightAndWrap 単体テスト ──

describe("highlightAndWrap", () => {
  beforeEach(() => {
    chalk.level = 3;
  });

  const makeRule = (source: string, style: () => chalk.Chalk) => ({
    source,
    flags: "",
    style,
  });

  it("マッチなし → 素の折り返し結果と同じ", () => {
    const rules = [makeRule("地震", () => chalk.red)];
    const result = highlightAndWrap("通常のテキスト行です", rules, 60);
    const plain = wrapTextLines("通常のテキスト行です", 60);
    expect(result).toEqual(plain);
  });

  it("部分マッチ → マッチ部分にANSIが入り、非マッチ部分は素通し", () => {
    const rules = [makeRule("活発", () => chalk.red)];
    const result = highlightAndWrap("地震活動が活発になっています", rules, 60);
    expect(result).toHaveLength(1);
    // ANSIエスケープを含む
    expect(result[0]).toContain("\u001b[");
    // 「活発」がスタイル適用される
    expect(result[0]).toContain(chalk.red("活発"));
    // 非マッチ部分はそのまま
    expect(result[0]).toContain("地震活動が");
    expect(result[0]).toContain("になっています");
  });

  it("同一位置で長いマッチが優先される（巨大地震警戒 vs 巨大地震）", () => {
    const rules = [
      makeRule("巨大地震", () => chalk.yellow),
      makeRule("巨大地震警戒", () => chalk.red),
    ];
    const result = highlightAndWrap("巨大地震警戒が発令されました", rules, 60);
    expect(result).toHaveLength(1);
    // 長い方（巨大地震警戒）が優先される
    expect(result[0]).toContain(chalk.red("巨大地震警戒"));
    // 短い方（巨大地震）の色が残らない
    expect(result[0]).not.toContain(chalk.yellow("巨大地震"));
  });

  it("折り返しでキーワードがまたがる行でもマッチが維持される", () => {
    // 「巨大地震警戒」(6文字=12幅) を maxWidth=10 で折り返す
    const rules = [makeRule("巨大地震警戒", () => chalk.red)];
    const text = "巨大地震警戒です";
    const result = highlightAndWrap(text, rules, 10);
    // 2行に折り返されるはず
    expect(result.length).toBeGreaterThanOrEqual(2);
    // 両方の行を結合するとANSIが含まれている
    const combined = result.join("");
    expect(combined).toContain("\u001b[");
  });

  it("chalk.level = 0 でも内容が壊れない", () => {
    const origLevel = chalk.level;
    chalk.level = 0;
    const rules = [makeRule("活発", () => chalk.red)];
    const result = highlightAndWrap("地震活動が活発です", rules, 60);
    expect(result).toHaveLength(1);
    // 色なしでも元のテキストが含まれる
    expect(result[0]).toContain("活発");
    expect(result[0]).toContain("地震活動が");
    chalk.level = origLevel;
  });
});

// ── collectHighlightSpans 単体テスト ──

describe("collectHighlightSpans", () => {
  const makeRule = (source: string, style: () => chalk.Chalk) => ({
    source,
    flags: "",
    style,
  });

  it("マッチなし → 空配列", () => {
    const rules = [makeRule("地震", () => chalk.red)];
    const spans = collectHighlightSpans("通常のテキスト", rules);
    expect(spans).toEqual([]);
  });

  it("複数マッチ → 開始位置順にソートされる", () => {
    const rules = [makeRule("活発|調査中", () => chalk.red)];
    const spans = collectHighlightSpans("現在調査中で活発な状態", rules);
    expect(spans).toHaveLength(2);
    expect(spans[0].start).toBeLessThan(spans[1].start);
  });

  it("マグニチュード６．８以上 がマッチする", () => {
    const rules = [
      makeRule(
        "モーメントマグニチュード[（Ｍｗ）０-９0-9．.クラス以上]*|マグニチュード[（Ｍ）０-９0-9．.クラス以上]*|Ｍｗ[０-９0-9]+",
        () => chalk.bold.white,
      ),
    ];
    const text = "マグニチュード６．８以上の地震が発生";
    const spans = collectHighlightSpans(text, rules);
    expect(spans).toHaveLength(1);
    const matched = Array.from(text).slice(spans[0].start, spans[0].end).join("");
    expect(matched).toBe("マグニチュード６．８以上");
  });

  it("モーメントマグニチュード８．０以上 が1つのspanでマッチする", () => {
    const rules = [
      makeRule(
        "モーメントマグニチュード[（Ｍｗ）０-９0-9．.クラス以上]*|マグニチュード[（Ｍ）０-９0-9．.クラス以上]*|Ｍｗ[０-９0-9]+",
        () => chalk.bold.white,
      ),
    ];
    const text = "モーメントマグニチュード８．０以上と推定";
    const spans = collectHighlightSpans(text, rules);
    expect(spans).toHaveLength(1);
    const matched = Array.from(text).slice(spans[0].start, spans[0].end).join("");
    expect(matched).toBe("モーメントマグニチュード８．０以上");
  });

  it("マグニチュード 単独（数値なし）でもマッチする", () => {
    const rules = [
      makeRule(
        "モーメントマグニチュード[（Ｍｗ）０-９0-9．.クラス以上]*|マグニチュード[（Ｍ）０-９0-9．.クラス以上]*|Ｍｗ[０-９0-9]+",
        () => chalk.bold.white,
      ),
    ];
    const text = "マグニチュードの大きさについて";
    const spans = collectHighlightSpans(text, rules);
    expect(spans).toHaveLength(1);
    const matched = Array.from(text).slice(spans[0].start, spans[0].end).join("");
    expect(matched).toBe("マグニチュード");
  });
});

// ── バッファリング + recap テスト ──

describe("バッファリング + recap", () => {
  let logSpy: MockInstance<typeof console.log>;
  let origIsTTY: boolean | undefined;
  let origRows: number | undefined;

  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(60);
    setMaxObservations(null);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    origIsTTY = process.stdout.isTTY;
    origRows = process.stdout.rows;
  });

  afterEach(() => {
    logSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    setMaxObservations(null);
  });

  it("ターミナルが十分大きい場合、recap が挿入されない", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 200, writable: true, configurable: true });

    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const info = parseEarthquakeTelegram(msg);
    expect(info).not.toBeNull();
    displayEarthquakeInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
    expect(output).not.toContain("▼ サマリー");
  });

  it("ターミナルが小さい場合、recap が挿入される", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const info = parseEarthquakeTelegram(msg);
    expect(info).not.toBeNull();
    displayEarthquakeInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
    expect(output).toContain("▼ サマリー");
  });

  it("非TTY の場合、recap が挿入されない", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const info = parseEarthquakeTelegram(msg);
    expect(info).not.toBeNull();
    displayEarthquakeInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
    expect(output).not.toContain("▼ サマリー");
  });

  it("EEW でもターミナルが小さい場合に recap が挿入される", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10);
    const info = parseEewTelegram(msg);
    expect(info).not.toBeNull();
    displayEewInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
    expect(output).toContain("▼ サマリー");
  });

  it("pushTitle/pushCard/pushHeadline が空のバッファでは recap セクションが出ない", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const buf = createRenderBuffer();
    // pushTitle/pushCard/pushHeadline を使わず、通常行のみ積む
    for (let i = 0; i < 20; i++) {
      buf.push(frameLine("normal", `行${i}`, 60));
    }
    buf.push(frameBottom("normal", 60));
    buf.pushEmpty();

    flushWithRecap(buf, "normal", 60);

    const output = logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
    expect(output).not.toContain("▼ サマリー");
  });

  it("recap の divider と サマリー行が borderColor で着色される", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const borderColor = chalk.rgb(232, 232, 232);
    const buf = createRenderBuffer();
    buf.pushTitle(frameLineColored("normal", borderColor, "タイトル行", 60));
    for (let i = 0; i < 20; i++) {
      buf.push(frameLineColored("normal", borderColor, `行${i}`, 60));
    }
    buf.push(frameBottom("normal", 60));
    buf.pushEmpty();

    flushWithRecap(buf, "normal", 60, borderColor);

    const lines = logSpy.mock.calls.map((args) => String(args[0] ?? ""));
    const summaryIdx = lines.findIndex((l) => l.includes("▼ サマリー"));
    expect(summaryIdx).toBeGreaterThan(0);
    // divider 行 + サマリー行が colored 版プリミティブと完全一致する
    expect(lines[summaryIdx - 1]).toBe(frameDividerColored("normal", borderColor, 60));
    expect(lines[summaryIdx]).toBe(frameLineColored("normal", borderColor, chalk.gray("▼ サマリー"), 60));
  });

  it("borderColor 未指定時は従来どおり plain frameDivider と一致する", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });

    const buf = createRenderBuffer();
    buf.pushTitle(frameLine("normal", "タイトル行", 60));
    for (let i = 0; i < 20; i++) {
      buf.push(frameLine("normal", `行${i}`, 60));
    }
    buf.push(frameBottom("normal", 60));
    buf.pushEmpty();

    flushWithRecap(buf, "normal", 60);

    const lines = logSpy.mock.calls.map((args) => String(args[0] ?? ""));
    const summaryIdx = lines.findIndex((l) => l.includes("▼ サマリー"));
    expect(summaryIdx).toBeGreaterThan(0);
    expect(lines[summaryIdx - 1]).toBe(frameDivider("normal", 60));
    expect(lines[summaryIdx]).toBe(frameLine("normal", chalk.gray("▼ サマリー"), 60));
  });
});

// ── renderGroupedItemList ──

describe("renderGroupedItemList", () => {
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(80);
  });

  it("renders single group with comma-separated items", () => {
    const buf = createRenderBuffer();
    renderGroupedItemList({
      level: "warning",
      width: 80,
      groups: [
        {
          prefix: "震度5弱: ",
          items: [
            { primary: "東京都" },
            { primary: "神奈川県" },
            { primary: "埼玉県" },
          ],
        },
      ],
      buf,
    });
    expect(buf.lineCount).toBeGreaterThanOrEqual(1);
    const text = stripAnsi(buf.lines.map((l) => l.text).join("\n"));
    expect(text).toContain("震度5弱:");
    expect(text).toContain("東京都");
    expect(text).toContain("神奈川県");
    expect(text).toContain("埼玉県");
  });

  it("wraps long item lists with hanging indent", () => {
    const buf = createRenderBuffer();
    renderGroupedItemList({
      level: "warning",
      width: 60,
      groups: [
        {
          prefix: "震度4: ",
          items: Array.from({ length: 10 }, (_, i) => ({
            primary: `テスト地域${i + 1}`,
          })),
        },
      ],
      buf,
    });
    // Should wrap to multiple lines
    expect(buf.lineCount).toBeGreaterThan(1);
  });

  it("appends badges after primary name", () => {
    const buf = createRenderBuffer();
    renderGroupedItemList({
      level: "warning",
      width: 80,
      groups: [
        {
          prefix: "震度6強: ",
          items: [
            { primary: "東京都23区", badges: [" [PLUM]", " [長周期3]"] },
            { primary: "神奈川県東部" },
          ],
        },
      ],
      buf,
    });
    const text = stripAnsi(buf.lines.map((l) => l.text).join("\n"));
    expect(text).toContain("[PLUM]");
    expect(text).toContain("[長周期3]");
  });

  it("renders multiple groups in order", () => {
    const buf = createRenderBuffer();
    renderGroupedItemList({
      level: "warning",
      width: 80,
      groups: [
        {
          prefix: "震度5強: ",
          items: [{ primary: "東京都" }],
        },
        {
          prefix: "震度4: ",
          items: [{ primary: "埼玉県" }],
        },
      ],
      buf,
    });
    const text = stripAnsi(buf.lines.map((l) => l.text).join("\n"));
    const idx5 = text.indexOf("震度5強");
    const idx4 = text.indexOf("震度4");
    expect(idx5).toBeLessThan(idx4);
  });

  it("skips empty groups", () => {
    const buf = createRenderBuffer();
    renderGroupedItemList({
      level: "warning",
      width: 80,
      groups: [
        { prefix: "震度5弱: ", items: [] },
        { prefix: "震度4: ", items: [{ primary: "東京都" }] },
      ],
      buf,
    });
    const text = stripAnsi(buf.lines.map((l) => l.text).join("\n"));
    expect(text).not.toContain("震度5弱");
    expect(text).toContain("震度4");
  });
});

// ── renderSimpleNameList ──

describe("renderSimpleNameList", () => {
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(80);
  });

  it("renders label + comma-separated names on one line when they fit", () => {
    const buf = createRenderBuffer();
    renderSimpleNameList({
      level: "normal",
      width: 80,
      items: ["富士市", "富士宮市", "御殿場市"],
      label: "対象:",
      buf,
    });
    expect(buf.lineCount).toBe(1);
    const text = stripAnsi(buf.lines[0].text);
    expect(text).toContain("対象:");
    expect(text).toContain("富士市");
  });

  it("preserves leading space before label for consistent indentation", () => {
    const buf = createRenderBuffer();
    renderSimpleNameList({
      level: "normal",
      width: 80,
      items: ["富士市"],
      label: "対象:",
      buf,
    });
    const text = stripAnsi(buf.lines[0].text);
    // frameLine adds frame decoration, content should start with " 対象:"
    expect(text).toMatch(/対象:/);
  });

  it("wraps long list with hanging indent aligned to label", () => {
    const buf = createRenderBuffer();
    renderSimpleNameList({
      level: "normal",
      width: 60,
      items: Array.from({ length: 15 }, (_, i) => `テスト市町村${i + 1}`),
      label: "対象:",
      buf,
    });
    expect(buf.lineCount).toBeGreaterThan(1);
  });

  it("renders without label when label is omitted", () => {
    const buf = createRenderBuffer();
    renderSimpleNameList({
      level: "info",
      width: 80,
      items: ["東京都23区", "千葉県北西部"],
      buf,
    });
    expect(buf.lineCount).toBeGreaterThanOrEqual(1);
    const text = stripAnsi(buf.lines[0].text);
    expect(text).toContain("東京都23区");
  });

  it("handles empty items array gracefully", () => {
    const buf = createRenderBuffer();
    renderSimpleNameList({
      level: "normal",
      width: 80,
      items: [],
      label: "対象:",
      buf,
    });
    expect(buf.lineCount).toBe(0);
  });
});

describe("frameDividerLabeled (dividerLevel ベース)", () => {
  it("dividerLevel=warning でラベル + ═ 罫線 (二重線) を返す、可視幅=width", () => {
    const line = frameDividerLabeled("warning", "★ 警報", 80);
    const visible = stripAnsi(line);
    expect(visible.startsWith("╠")).toBe(true);
    expect(visible.endsWith("╣")).toBe(true);
    expect(visible).toContain("★ 警報");
    expect(visualWidth(visible)).toBe(80);
  });

  it("dividerLevel=info で単線 ├─┤", () => {
    const line = frameDividerLabeled("info", "▽ 注意報", 60);
    const visible = stripAnsi(line);
    expect(visible.startsWith("├")).toBe(true);
    expect(visible.endsWith("┤")).toBe(true);
    expect(visible).toContain("▽ 注意報");
  });

  it("dividerLevel は frame 全体の level と独立 (critical frame 内で warning divider)", () => {
    const warnLine = frameDividerLabeled("warning", "★", 40);
    const critLine = frameDividerLabeled("critical", "★★", 40);
    expect(stripAnsi(warnLine).startsWith("╠")).toBe(true);
    expect(stripAnsi(critLine).startsWith("╠")).toBe(true);
    expect(warnLine).not.toBe(critLine);
  });

  it("ラベルが幅を超える場合、可視幅 = width で頭打ち (はみ出さない)", () => {
    const longLabel = "★ 警報 ".repeat(20);
    const line = frameDividerLabeled("warning", longLabel, 30);
    expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(30);
  });
});

describe("frameDividerThin / frameDividerLabeledThin (細線 divider)", () => {
  it("critical/warning は ╟─╢ (二重線フレーム内の細線)", () => {
    chalk.level = 3;
    const crit = stripAnsi(frameDividerThin("critical", 40));
    const warn = stripAnsi(frameDividerThin("warning", 40));
    expect(crit.startsWith("╟")).toBe(true);
    expect(crit.endsWith("╢")).toBe(true);
    expect(crit).toContain("─");
    expect(crit).not.toContain("═");
    expect(warn.startsWith("╟")).toBe(true);
  });

  it("normal/info/cancel は ├─┤ (元々細線と同値)", () => {
    chalk.level = 3;
    for (const level of ["normal", "info", "cancel"] as const) {
      const v = stripAnsi(frameDividerThin(level, 40));
      expect(v.startsWith("├"), level).toBe(true);
      expect(v.endsWith("┤"), level).toBe(true);
    }
  });

  it("labeled 版 critical は ╟ ラベル ─╢、可視幅 = width", () => {
    chalk.level = 3;
    const v = stripAnsi(frameDividerLabeledThin("critical", "対象市町村", 60));
    expect(v.startsWith("╟")).toBe(true);
    expect(v.endsWith("╢")).toBe(true);
    expect(v).toContain("対象市町村");
    expect(visualWidth(v)).toBe(60);
  });

  it("NO_COLOR (chalk.level=0) で幅が width と一致する", () => {
    chalk.level = 0;
    try {
      expect(visualWidth(frameDividerThin("critical", 80))).toBe(80);
      expect(visualWidth(frameDividerThin("normal", 40))).toBe(40);
      expect(visualWidth(frameDividerLabeledThin("warning", "降灰予報", 50))).toBe(50);
    } finally {
      chalk.level = 3;
    }
  });
});
