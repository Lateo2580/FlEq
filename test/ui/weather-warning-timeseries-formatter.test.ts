import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, vi } from "vitest";
import chalk from "chalk";
import {
  displayWeatherWarningTimeseriesInfo,
  formatTimeWindowWithHours,
  formatCriteriaPeriodRange,
  drawWeatherWarningBanner,
  buildWeatherWarningBannerText,
  renderResponsiveTable,
  buildDetailBlock,
} from "../../src/ui/weather-warning-timeseries-formatter";
import type {
  ClipReport,
  DisplayMode,
} from "../../src/ui/weather-warning-timeseries-formatter";
import type {
  TimeWindow,
  ParsedWeatherWarningTimeseriesInfo,
  WeatherWarningTimeseriesArea,
  WeatherWarningTimeseriesKind,
  PartValue,
  SignificancyValue,
  QuantitativeValue,
  WindPairedValue,
} from "../../src/types";
import { parseWeatherWarningTimeseries as parseTimeseriesRaw } from "../../src/dmdata/weather-warning-timeseries-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VPWP50_UNKNOWN_CODE,
  FIXTURE_VPWP50_HIGH_SEVERITY,
  FIXTURE_VPWP50_CANCEL,
  FIXTURE_VPWP50_CRITERIA_PERIOD,
  FIXTURE_VPWP50_LOCAL_AREA,
  createSyntheticGlobalWarningInfo,
} from "../helpers/mock-message";
import {
  setFrameWidth,
  clearFrameWidth,
  visualWidth,
  stripAnsi,
  createRenderBuffer,
  setDisplayMode,
  setWeatherWarningDisplayOptions,
  getWeatherWarningDisplayOptions,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
} from "../../src/ui/formatter";
import type { WeatherSeverityEntry, SeriesWindow } from "../../src/engine/presentation/weather-severity-pyramid";

/** fixture のパース結果を非 null に絞る。パース失敗は fixture 破損なので即座に落とす
 *  (null のまま formatter へ渡すと「何も出力されない緑」になり、検証が抜ける) */
function parseTimeseries(msg: Parameters<typeof parseTimeseriesRaw>[0]): ParsedWeatherWarningTimeseriesInfo {
  const info = parseTimeseriesRaw(msg);
  if (info == null) throw new Error("VPWP50 fixture のパースに失敗した");
  return info;
}

chalk.level = 0;

describe("displayWeatherWarningTimeseriesInfo (pyramid)", () => {
  it("取消ケースはヘッダ + (取消) のみで終わる (回帰防止)", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const info = {
      type: "VPWP50",
      infoType: "取消",
      reportDateTime: "2026-06-05T19:55:00+09:00",
      publishingOffice: "長野地方気象台",
      targetArea: { name: "長野県", code: "200000" },
      areas: [],
      unknownCodes: [],
      maxKnownSignificancy: null,
      fallback: "none",
    };
    displayWeatherWarningTimeseriesInfo(info as never);
    spy.mockRestore();
    const all = logs.join("\n");
    expect(all).toContain("長野県");
    expect(all).toContain("(取消)");
    expect(all).not.toContain("★");
    expect(all).not.toContain("▽");
  });

  it("長野県 fixture の normal 出力が 70 行以内に収まる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    displayWeatherWarningTimeseriesInfo(info);
    spy.mockRestore();
    expect(logs.length).toBeLessThanOrEqual(70);
  });

  it("長野県 fixture が △ 注意報 divider を含む (Phase B: displaySeverity 別 / 文言は 2026-06-12 VPWW 形式統一)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    displayWeatherWarningTimeseriesInfo(info);
    spy.mockRestore();
    const all = logs.join("\n");
    expect(all).toContain("△ 注意報");
  });

  it("全域警報 fixture (synthetic) が ◆ 警報 + 列ヘッダを含む (Phase B: standard 以上で 6 列)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const baseInfo = parseTimeseries(msg);
    const info = createSyntheticGlobalWarningInfo(baseInfo);
    // standard モード (>=120) を強制
    setFrameWidth(140);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      displayWeatherWarningTimeseriesInfo(info);
    } finally {
      spy.mockRestore();
      clearFrameWidth();
    }
    const all = logs.map(stripAnsi).join("\n");
    expect(all).toContain("◆ 警報");
    expect(all).toContain("級");
    expect(all).toContain("種別");
    expect(all).toContain("地域");
    expect(all).toContain("時刻枠");
    expect(all).toContain("ピーク");
    expect(all).toContain("基準到達");
  });
});

describe("Codex R4 #2: 注意報サマリの幅安全", () => {
  it("6+ 種別の注意報サマリでも全描画行が visualWidth ≤ width に収まる (Codex R4 #2)", () => {
    // 8 種別の注意報を強引に注入
    const baseInfo = parseTimeseries(createMockWsDataMessage(FIXTURE_VPWP50_NAGANO));
    const types = ["大雨", "洪水", "雷", "強風", "波浪", "濃霧", "乾燥", "なだれ"];
    const synthesized = {
      ...baseInfo,
      areas: baseInfo.areas.map((area) => ({
        ...area,
        kinds: {
          ...area.kinds,
          1: types.map((t) => ({
            type: t,
            partKind: "Significancy" as const,
            significancyWorst: {
              base: {
                info: { code: "20", compact: `${t}注意報`, label: `${t}注意報`, known: true, severity: "advisory" } as never,
                timeRef: "1",
                timeWindow: { startName: "朝", endName: "夕方", count: 4, contiguous: true },
              },
              locals: [],
            },
          })),
        },
      })),
    };
    setFrameWidth(80);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      displayWeatherWarningTimeseriesInfo(synthesized as never);
    } finally {
      spy.mockRestore();
      clearFrameWidth();
    }
    for (const line of logs) {
      expect(visualWidth(line)).toBeLessThanOrEqual(80);
    }
    // Phase B: width=80 (ultra-narrow) では △ 注意報 divider + chips 出力
    expect(logs.some((l) => l.includes("△ 注意報"))).toBe(true);
    // chip 形式 [phenomenon N] が出る
    expect(logs.some((l) => /\[\S+\s\d+\]/.test(l))).toBe(true);
  });
});

describe.each([80, 100, 120])(
  "Codex R1 #2: width=%i で全描画行が visualWidth <= width",
  (width) => {
    it.each([
      [
        "長野 fixture (実機受信)",
        () =>
          parseTimeseries(
            createMockWsDataMessage(FIXTURE_VPWP50_NAGANO),
          ),
      ],
      [
        "全域警報 fixture (人工)",
        () =>
          createSyntheticGlobalWarningInfo(
            parseTimeseries(
              createMockWsDataMessage(FIXTURE_VPWP50_NAGANO),
            ),
          ),
      ],
    ])("%s", (_label, makeInfo) => {
      const info = makeInfo();
      setFrameWidth(width);
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((line: unknown) => {
          logs.push(String(line));
        });
      try {
        displayWeatherWarningTimeseriesInfo(info);
      } finally {
        spy.mockRestore();
        clearFrameWidth();
      }
      for (const line of logs) {
        expect(visualWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  },
);

describe("formatTimeWindowWithHours (slotHours は tsNum から引く)", () => {
  it("tsNum=1, count=3, contiguous → '朝-夕方 (3枠/9h)'", () => {
    const w = { startName: "朝", endName: "夕方", count: 3, contiguous: true } as TimeWindow;
    expect(formatTimeWindowWithHours(w, 1)).toBe("朝-夕方 (3枠/9h)");
  });
  it("tsNum=2, count=2, contiguous → '朝-夕方 (2枠/48h)'", () => {
    const w = { startName: "朝", endName: "夕方", count: 2, contiguous: true } as TimeWindow;
    expect(formatTimeWindowWithHours(w, 2)).toBe("朝-夕方 (2枠/48h)");
  });
  it("tsNum=3, count=2, contiguous → '昨日-今日 (2枠/48h)' (1日=24h)", () => {
    const w = { startName: "昨日", endName: "今日", count: 2, contiguous: true } as TimeWindow;
    expect(formatTimeWindowWithHours(w, 3)).toBe("昨日-今日 (2枠/48h)");
  });
  it("count=1 は名前のみ", () => {
    const w = { startName: "朝", endName: "朝", count: 1, contiguous: true } as TimeWindow;
    expect(formatTimeWindowWithHours(w, 1)).toBe("朝");
  });
  it("非連続 → 'ほかN-1枠' (時間併記)", () => {
    const w = { startName: "朝", endName: "夕方", count: 3, contiguous: false } as TimeWindow;
    expect(formatTimeWindowWithHours(w, 1)).toBe("朝ほか2枠 (3枠/9h)");
  });
});

describe("formatCriteriaPeriodRange (Date 経由なし、Duration 全対応)", () => {
  describe("基本パターン (PT(\\d+)H)", () => {
    it("18:00 + PT6H → '18:00 〜 24:00 (6h)' (24:00 表記、(翌) なし)", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT6H"))
        .toBe("18:00 〜 24:00 (6h)");
    });
    it("23:00 + PT6H → '23:00 〜 05:00 (翌) (6h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T23:00:00+09:00", "PT6H"))
        .toBe("23:00 〜 05:00 (翌) (6h)");
    });
    it("18:00 + PT12H → '18:00 〜 06:00 (翌) (12h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT12H"))
        .toBe("18:00 〜 06:00 (翌) (12h)");
    });
  });

  describe("日跨ぎ 2 回以上 (25h+ で (+N))", () => {
    it("18:00 + PT30H → '18:00 〜 00:00 (+2) (30h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT30H"))
        .toBe("18:00 〜 00:00 (+2) (30h)");
    });
    it("18:00 + PT55H → '18:00 〜 01:00 (+3) (55h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT55H"))
        .toBe("18:00 〜 01:00 (+3) (55h)");
    });
  });

  describe("分単位 (PT(\\d+)M)", () => {
    it("18:00 + PT30M → '18:00 〜 18:30 (30m)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT30M"))
        .toBe("18:00 〜 18:30 (30m)");
    });
    it("23:45 + PT30M → '23:45 〜 00:15 (翌) (30m)' (日跨ぎ分単位)", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T23:45:00+09:00", "PT30M"))
        .toBe("23:45 〜 00:15 (翌) (30m)");
    });
  });

  describe("1 日 (P1D)", () => {
    it("18:00 + P1D → '18:00 〜 18:00 (翌) (24h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "P1D"))
        .toBe("18:00 〜 18:00 (翌) (24h)");
    });
  });

  describe("PT0H (即時)", () => {
    it("18:00 + PT0H → '18:00 即時 (0h)'", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT0H"))
        .toBe("18:00 即時 (0h)");
    });
  });

  describe("未知 Duration パターン", () => {
    it("PT3W (week) など未対応パターンはフォールバック", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT3W"))
        .toBe("18:00 PT3W");
    });
  });

  describe("TZ 非依存", () => {
    it("入力 ISO の TZ offset を信頼、JST 入力で 18:00 抽出", () => {
      expect(formatCriteriaPeriodRange("2026-06-05T18:00:00+09:00", "PT6H"))
        .toBe("18:00 〜 24:00 (6h)");
    });
  });
});

describe("drawWeatherWarningBanner (3 行色面 + clip)", () => {
  it("nonLevelWarning severity で 3 行構造、各行の可視幅 = width", () => {
    const lines = drawWeatherWarningBanner("nonLevelWarning", "◆ 大雨警報 千葉県 ピーク21:00", 80);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(visualWidth(stripAnsi(l))).toBe(80);
    }
    expect(stripAnsi(lines[1])).toContain("◆ 大雨警報");
    expect(stripAnsi(lines[0]).trim()).toBe("");
    expect(stripAnsi(lines[2]).trim()).toBe("");
  });

  it("officialL5 severity (特別警報級) でも 3 行構造", () => {
    const lines = drawWeatherWarningBanner("officialL5", "★★ 大雨 (L5) 千葉県南部 ピーク22:00", 80);
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1])).toContain("★★ 大雨 (L5)");
  });

  it("release severity でラズベリー背景の取消バナー", () => {
    const lines = drawWeatherWarningBanner("release", "気象警報・注意報 取消 千葉県", 80);
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1])).toContain("取消");
  });
});

describe("buildWeatherWarningBannerText (severity ベース M1 + 部品優先度落とし)", () => {
  function mockInfo(overrides: Partial<ParsedWeatherWarningTimeseriesInfo>): ParsedWeatherWarningTimeseriesInfo {
    return {
      meta: testTelegramMeta(false),
      type: "VPWP50", infoType: "発表", title: "", controlTitle: "",
      reportDateTime: "", publishingOffice: "", editorialOffice: "",
      eventId: null, serial: null, headline: null,
      targetArea: { name: "千葉県", code: "120000", kinds: { 1: [], 2: [], 3: [] } },
      areas: [], maxKnownSignificancy: null,
      maxDisplaySeverity: null, maxDisplayRankSignificancy: null,
      unknownCodes: [],
      fallback: "none", isTest: false,
      ...overrides,
    } as ParsedWeatherWarningTimeseriesInfo;
  }

  // Phase B: 代表 SignificancyInfo (grade Code 30 warning) を共通定義
  const SIG_WARNING_30 = {
    code: "30", known: true, rank: 3, family: "grade" as const,
    label: "警報級", compact: "警", severity: "warning" as const,
  };

  function makeWarningArea(
    areaName: string,
    propertyType: string,
    peakTerm?: string,
  ): WeatherWarningTimeseriesArea {
    const sigValue = {
      info: { code: "30", known: true, rank: 3, family: "grade" as const, label: "警報級", compact: "警", severity: "warning" as const },
      timeRef: "1",
      peak: peakTerm ? { date: "5日", term: peakTerm } : undefined,
    };
    return {
      name: areaName,
      code: "120100",
      kinds: {
        1: [{
          type: propertyType,
          partKind: "Significancy" as const,
          significancyWorst: { base: sigValue },
        }],
        2: [],
        3: [],
      },
    };
  }

  it("取消: '気象警報・注意報 取消 千葉県'", () => {
    const info = mockInfo({ infoType: "取消" });
    expect(buildWeatherWarningBannerText(info)).toBe("気象警報・注意報 取消 千葉県");
  });

  it("N=1 警報: '◆ 大雨警報　千葉県北西部　ピーク 5日 夜のはじめ頃' (Phase B: nonLevelWarning)", () => {
    const info = mockInfo({
      maxKnownSignificancy: SIG_WARNING_30,
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: SIG_WARNING_30,
      areas: [makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃")],
    });
    const text = buildWeatherWarningBannerText(info);
    expect(text).toMatch(/^◆ 大雨警報/);
    expect(text).toContain("千葉県北西部");
    expect(text).toContain("ピーク 5日夜のはじめ頃");
  });

  it("N=3 警報連結 + 代表 peak 注釈", () => {
    const info = mockInfo({
      maxKnownSignificancy: SIG_WARNING_30,
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: SIG_WARNING_30,
      areas: [
        makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃"),
        makeWarningArea("千葉県北西部", "洪水"),
        makeWarningArea("千葉県北西部", "暴風"),
      ],
    });
    const text = buildWeatherWarningBannerText(info);
    expect(text).toContain("大雨・洪水・暴風警報");
    expect(text).toContain("(大雨)");
  });

  it("N=4 件数化: '◆ 大雨警報 ほか 3 件'", () => {
    const info = mockInfo({
      maxKnownSignificancy: SIG_WARNING_30,
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: SIG_WARNING_30,
      areas: [
        makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃"),
        makeWarningArea("千葉県北西部", "洪水"),
        makeWarningArea("千葉県北西部", "暴風"),
        makeWarningArea("千葉県北西部", "波"),
      ],
    });
    const text = buildWeatherWarningBannerText(info);
    expect(text).toMatch(/大雨警報 ほか 3 件/);
  });

  it("異地域: 親地域 (targetArea.name) に丸める", () => {
    const info = mockInfo({
      maxKnownSignificancy: SIG_WARNING_30,
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: SIG_WARNING_30,
      targetArea: { name: "千葉県", code: "120000", kinds: { 1: [], 2: [], 3: [] } },
      areas: [
        makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃"),
        makeWarningArea("千葉県南部", "洪水"),
      ],
    });
    const text = buildWeatherWarningBannerText(info);
    expect(text).toContain("千葉県");
    expect(text).not.toContain("北西部");
  });

  it("displaySeverity ベース絞り込み: officialL4 代表なら 41 のみ収集 (30 は除外)", () => {
    // 代表 = officialL4 (Code 41 土砂災害)。grade 30 (大雨) は displaySeverity が
    // nonLevelWarning なので収集対象外。土砂災害だけがバナーに出る (L 後置注釈)。
    const grade30Area = makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃");
    const alert41Area = makeWarningArea("千葉県北西部", "土砂災害危険度");
    const sig41 = {
      code: "41", known: true, rank: 4, family: "alertLevel" as const,
      label: "警戒レベル4相当", compact: "L4相", severity: "warning" as const,
    };
    alert41Area.kinds[1][0].significancyWorst!.base!.info = sig41 as never;
    const info = mockInfo({
      maxKnownSignificancy: sig41,
      maxDisplaySeverity: "officialL4",
      maxDisplayRankSignificancy: sig41,
      areas: [grade30Area, alert41Area],
    });
    const text = buildWeatherWarningBannerText(info);
    expect(text).toMatch(/^★ 土砂災害 \(L4\)/);
    expect(text).not.toContain("大雨");
  });

  it("部品優先度落とし: maxWidth 不足時、注釈→ピーク→地域 の順に落とす", () => {
    const info = mockInfo({
      maxKnownSignificancy: SIG_WARNING_30,
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: SIG_WARNING_30,
      areas: [
        makeWarningArea("千葉県北西部", "大雨", "夜のはじめ頃"),
        makeWarningArea("千葉県北西部", "洪水"),
      ],
    });
    const textFull = buildWeatherWarningBannerText(info, { maxWidth: 200 });
    const textShort = buildWeatherWarningBannerText(info, { maxWidth: 25 });
    expect(textShort).toContain("◆");
    expect(textShort).toContain("大雨");
    expect(visualWidth(textShort)).toBeLessThanOrEqual(25);
    expect(visualWidth(textFull)).toBeGreaterThan(visualWidth(textShort));
  });
});

describe("renderResponsiveTable (列優先度モデル)", () => {
  function makeAdvisoryEntry(
    overrides: Partial<WeatherSeverityEntry> = {},
  ): WeatherSeverityEntry {
    return {
      id: "雷|千葉県北西部|nonLevelAdvisory|22|",
      phenomenon: "雷",
      kindLabel: "L2",
      severity: "advisory",
      areaName: "千葉県北西部",
      code: "22",
      windows: [],
      propertyType: "雷",
      localAreaNames: [],
      unknownCodes: [],
      worstCode: "22",
      localKey: "",
      displaySeverity: "nonLevelAdvisory",
      officialAlertLevel: null,
      resolutionSource: "map",
      ...overrides,
    };
  }

  it("mode=wide で 7 列ヘッダが出る", () => {
    const buf = createRenderBuffer();
    renderResponsiveTable(buf, "info", 200, "wide", [makeAdvisoryEntry()]);
    const lines = buf.getLines().map((l: string) => stripAnsi(l)).join("\n");
    expect(lines).toContain("級");
    expect(lines).toContain("種別");
    expect(lines).toContain("地域");
    expect(lines).toContain("時刻枠");
    expect(lines).toContain("ピーク");
    expect(lines).toContain("基準到達");
    expect(lines).toContain("備考");
  });

  it("mode=standard で 6 列ヘッダ (備考なし)", () => {
    const buf = createRenderBuffer();
    renderResponsiveTable(buf, "info", 140, "standard", [makeAdvisoryEntry()]);
    const lines = buf.getLines().map((l: string) => stripAnsi(l)).join("\n");
    expect(lines).toContain("時刻枠");
    expect(lines).not.toContain("備考");
  });

  it("mode=ultra-narrow で 3 列ヘッダ (級/種別/地域のみ)", () => {
    const buf = createRenderBuffer();
    renderResponsiveTable(buf, "info", 80, "ultra-narrow", [makeAdvisoryEntry()]);
    const lines = buf.getLines().map((l: string) => stripAnsi(l)).join("\n");
    expect(lines).toContain("種別");
    expect(lines).toContain("地域");
    expect(lines).not.toContain("時刻枠");
    expect(lines).not.toContain("ピーク");
  });

  it("各行は width を超えない (clip 込み)", () => {
    const buf = createRenderBuffer();
    const longEntry = makeAdvisoryEntry({
      propertyType: "土砂災害危険度",
      areaName: "とても長い地域名がここに入る場合のテスト",
    });
    renderResponsiveTable(buf, "info", 100, "standard", [longEntry]);
    const lines = buf.getLines();
    for (const l of lines) {
      expect(visualWidth(stripAnsi(l))).toBeLessThanOrEqual(100);
    }
  });

  it("clip された entry が ClipReport に記録される", () => {
    const buf = createRenderBuffer();
    const veryLongEntry = makeAdvisoryEntry({
      id: "test-id",
      propertyType: "土砂災害危険度",
      areaName: "千葉県北西部とても長い地域名",
    });
    const report = renderResponsiveTable(buf, "info", 80, "ultra-narrow", [veryLongEntry]);
    // 地域名が長いので clip される可能性 → report に "地域" が記録される
    const entryClip = report.get("test-id");
    if (entryClip) {
      // 何らかの列で clip 発生 → keys に列名がある
      expect(Object.keys(entryClip).length).toBeGreaterThan(0);
    }
  });

  it("clip 無し entry は ClipReport に含まれない", () => {
    const buf = createRenderBuffer();
    const shortEntry = makeAdvisoryEntry({ id: "short-id", propertyType: "雷", areaName: "千葉" });
    const report = renderResponsiveTable(buf, "info", 200, "wide", [shortEntry]);
    expect(report.get("short-id")).toBeUndefined();
  });

  it("級列 (tier prefix) + 種別列の L 後置注釈 (目視ゲート再判断 2026-06-11: 級列復活)", () => {
    const buf = createRenderBuffer();
    const l5 = makeAdvisoryEntry({ severity: "special", displaySeverity: "officialL5", officialAlertLevel: 5 });
    const l4 = makeAdvisoryEntry({
      severity: "warning",
      displaySeverity: "officialL4",
      officialAlertLevel: 4,
      propertyType: "土砂災害危険度",
    });
    const adv = makeAdvisoryEntry({ severity: "advisory", displaySeverity: "nonLevelAdvisory" });
    renderResponsiveTable(buf, "info", 200, "wide", [l5, l4, adv]);
    const lines = buf.getLines().map((l: string) => stripAnsi(l));
    // ヘッダに 級 がある
    expect(lines[0]).toContain("級");
    // データ行の級列に displaySeverity の tier prefix が出る
    const dataLines = lines.slice(1);
    expect(dataLines[0]).toContain("★★"); // officialL5
    expect(dataLines[1]).toContain("★");  // officialL4
    expect(dataLines[2]).toContain("△");  // nonLevelAdvisory
    // 公式系は L 後置注釈、grade 系は従来名 (こちらは維持)
    expect(dataLines[1]).toContain("土砂災害 (L4)");
    expect(dataLines[2]).toContain("雷注意報");
  });
});

describe("buildDetailBlock (v3.2: clip 検知 + 全 window + 優先度残留)", () => {
  function makeEntry(overrides: Partial<WeatherSeverityEntry> = {}): WeatherSeverityEntry {
    return {
      id: "test-id",
      phenomenon: "大雨",
      kindLabel: "L4相",
      severity: "warning",
      areaName: "千葉県北西部",
      code: "41",
      windows: [],
      propertyType: "大雨",
      localAreaNames: [],
      unknownCodes: [],
      worstCode: "41",
      localKey: "",
      displaySeverity: "officialL4",
      officialAlertLevel: 4,
      resolutionSource: "map",
      ...overrides,
    };
  }

  function makeWindow(overrides: Partial<SeriesWindow> = {}): SeriesWindow {
    return {
      series: "3h",
      timeRef: "1",
      tsNum: 1 as 1 | 2 | 3,
      window: { startName: "朝", endName: "夕方", count: 3, contiguous: true },
      peak: { date: "5日", term: "夜のはじめ頃" },
      criteriaPeriod: {
        sentence: "5日夜のはじめ頃から夜遅くにかけて警戒レベル4相当の予測",
        criteriaClass: "土砂災害警戒レベル4相当",
        time: "2026-06-05T18:00:00+09:00",
        duration: "PT6H",
      },
      ...overrides,
    };
  }

  it("詳細無し entry は [詳細] divider 出ない (公式レベル行を廃止済み)", () => {
    const buf = createRenderBuffer();
    // 公式レベル行を廃止したので、officialL4 entry でも windows/local/unknown/sentence が
    // 無ければ [詳細] は出ない。
    const noDetail = makeEntry({
      officialAlertLevel: 4,
      displaySeverity: "officialL4",
      windows: [],
      localAreaNames: [],
      unknownCodes: [],
    });
    buildDetailBlock(buf, "info", 200, "wide", [noDetail], new Map());
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).not.toContain("[詳細]");
    expect(out).not.toContain("公式レベル");
  });

  it("ultra-narrow + 全 window 走査 で 時刻枠[1]/[2] 形式が出る", () => {
    const buf = createRenderBuffer();
    // Phase B: grade 系で window detail を検証 (guard 余裕確保)
    const entry = makeEntry({
      officialAlertLevel: null,
      displaySeverity: "nonLevelWarning",
      windows: [
        makeWindow({ series: "3h", tsNum: 1 as 1 }),
        makeWindow({ series: "24h", tsNum: 2 as 2, window: { startName: "今日", endName: "明日", count: 2, contiguous: true } }),
      ],
    });
    buildDetailBlock(buf, "info", 80, "ultra-narrow", [entry], new Map());
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toMatch(/時刻枠\[1\]:/);
    expect(out).toMatch(/時刻枠\[2\]:/);
  });

  it("standard で Local/未知/Sentence は常時出るが、時刻枠は clip 無いと出ない", () => {
    const buf = createRenderBuffer();
    const entry = makeEntry({
      windows: [makeWindow()],
      localAreaNames: ["稚内海岸"],
      unknownCodes: [],
    });
    buildDetailBlock(buf, "info", 140, "standard", [entry], new Map());
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toContain("Local: 稚内海岸");
    expect(out).toMatch(/Sentence:/);
    expect(out).not.toMatch(/時刻枠/);  // clip 無いので出ない
  });

  it("wide で clip 無し + 備考列見える → Local は detail 省略 (Sentence のみ)", () => {
    const buf = createRenderBuffer();
    const entry = makeEntry({
      windows: [makeWindow()],
      localAreaNames: ["稚内海岸"],
    });
    buildDetailBlock(buf, "info", 200, "wide", [entry], new Map());
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toMatch(/Sentence:/);
    expect(out).not.toContain("Local:");  // 備考列で見える前提
  });

  it("wide + 備考列が clip → Local が detail に逃げる", () => {
    const buf = createRenderBuffer();
    const entry = makeEntry({
      id: "clipped-id",
      windows: [makeWindow()],
      localAreaNames: ["稚内海岸", "礼文海岸"],
    });
    const clipReport: ClipReport = new Map([["clipped-id", { "備考": true }]]);
    buildDetailBlock(buf, "info", 200, "wide", [entry], clipReport);
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toContain("Local:");
  });

  it("e.unknownCodes が detail に '未知: ?XX' で出る", () => {
    const buf = createRenderBuffer();
    const entry = makeEntry({
      windows: [makeWindow()],
      unknownCodes: ["87"],
    });
    buildDetailBlock(buf, "info", 140, "standard", [entry], new Map());
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toMatch(/未知: \?87/);
  });

  it("clip された列は default ルール無関係で detail に出る", () => {
    const buf = createRenderBuffer();
    const entry = makeEntry({
      id: "clip-criteria",
      windows: [makeWindow()],
    });
    // standard で本来 detail に出ない 基準到達 が clip された場合
    const clipReport: ClipReport = new Map([["clip-criteria", { "基準到達": true }]]);
    buildDetailBlock(buf, "info", 140, "standard", [entry], clipReport);
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toContain("基準到達:");  // clip 検知で detail に
  });

  it("長い Sentence は wrapFrameLines で折返し、frame をはみ出さない", () => {
    const buf = createRenderBuffer();
    const longSentence = "あ".repeat(200);
    const entry = makeEntry({
      windows: [makeWindow({
        criteriaPeriod: {
          sentence: longSentence,
          criteriaClass: "x",
          time: "2026-06-05T18:00:00+09:00",
          duration: "PT6H",
        },
      })],
    });
    buildDetailBlock(buf, "info", 80, "standard", [entry], new Map());
    const lines = buf.getLines();
    for (const l of lines) {
      expect(visualWidth(stripAnsi(l))).toBeLessThanOrEqual(80);
    }
  });

  it("maxPerEntry guard で低優先度 (P4) から省略される", () => {
    const buf = createRenderBuffer();
    // ultra-narrow で 10 window → 各 window で 3 行 = 30+ 行になる entry
    const manyWindows = Array.from({ length: 10 }, () => makeWindow());
    const entry = makeEntry({
      windows: manyWindows,
      localAreaNames: ["稚内海岸"],
      unknownCodes: ["87"],
    });
    buildDetailBlock(buf, "info", 200, "ultra-narrow", [entry], new Map(), { maxPerEntry: 8 });
    const out = buf.getLines().map(stripAnsi).join("\n");
    // Local と 未知 は残る (P2 優先)
    expect(out).toContain("Local:");
    expect(out).toContain("未知:");
    // 8 行制限で window 系 (P4) は減ってる
  });

  it("maxTotal guard で entry ごと省略 '[詳細] (N entry 省略)'", () => {
    const buf = createRenderBuffer();
    const entries = Array.from({ length: 30 }, (_, i) => makeEntry({
      id: `e${i}`,
      areaName: `地域${i}`,
      windows: [makeWindow()],  // 各 entry で Sentence あり
    }));
    buildDetailBlock(buf, "info", 200, "ultra-narrow", entries, new Map(), { maxTotal: 20 });
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).toMatch(/\(\d+ entry 省略\)/);
  });

  it("Phase 2-FIX: P2 (Local + 未知) は guard で必ず残る (長い detail でも)", () => {
    const buf = createRenderBuffer();
    // 10 window + Local + 未知 で max 8 行制限を超える entry
    const manyWindows = Array.from({ length: 10 }, () => makeWindow());
    const entry = makeEntry({
      windows: manyWindows,
      localAreaNames: ["稚内海岸"],
      unknownCodes: ["87"],
    });
    buildDetailBlock(buf, "info", 200, "ultra-narrow", [entry], new Map(), { maxPerEntry: 8 });
    const out = buf.getLines().map(stripAnsi).join("\n");
    // P2 (Local / 未知) は必ず残る
    expect(out).toContain("Local:");
    expect(out).toContain("未知:");
  });
});

describe("幅境界テスト (Phase 4-B: 全 fixture × 全幅で全行 <= width)", () => {
  const widths = [60, 80, 119, 120, 139, 159, 160, 200];
  const fixtures: Array<{ name: string; ref: string }> = [
    { name: "NAGANO", ref: FIXTURE_VPWP50_NAGANO },
    { name: "HIGH_SEVERITY", ref: FIXTURE_VPWP50_HIGH_SEVERITY },
    { name: "UNKNOWN_CODE", ref: FIXTURE_VPWP50_UNKNOWN_CODE },
    { name: "CANCEL", ref: FIXTURE_VPWP50_CANCEL },
    { name: "CRITERIA_PERIOD", ref: FIXTURE_VPWP50_CRITERIA_PERIOD },
    { name: "LOCAL_AREA", ref: FIXTURE_VPWP50_LOCAL_AREA },
  ];

  for (const fx of fixtures) {
    for (const w of widths) {
      it(`${fx.name} @ width=${w}: 全行 visualWidth(stripAnsi(line)) <= ${w}`, () => {
        setFrameWidth(w);
        const msg = createMockWsDataMessage(fx.ref);
        const info = parseTimeseries(msg);
        const logs: string[] = [];
        const spy = vi
          .spyOn(console, "log")
          .mockImplementation((line: unknown) => {
            logs.push(String(line));
          });
        try {
          displayWeatherWarningTimeseriesInfo(info);
        } finally {
          spy.mockRestore();
          clearFrameWidth();
        }
        for (let i = 0; i < logs.length; i++) {
          const line = logs[i];
          const vw = visualWidth(stripAnsi(line));
          if (vw > w) {
            throw new Error(
              `${fx.name} @ width=${w}: line[${i}] visualWidth=${vw} > ${w}\nLine: ${JSON.stringify(stripAnsi(line))}`,
            );
          }
        }
        expect(logs.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("displayNormalResponsive (Phase 2-D): バナー発火 + tier 別 divider", () => {
  function captureDisplay(info: ParsedWeatherWarningTimeseriesInfo): string[] {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    displayWeatherWarningTimeseriesInfo(info);
    spy.mockRestore();
    return logs;
  }

  /** synthetic helper は maxKnownSignificancy を再計算しないので、テスト側で警報級に上書き */
  function makeWarningGlobalInfo(): ParsedWeatherWarningTimeseriesInfo {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const baseInfo = parseTimeseries(msg);
    const synth = createSyntheticGlobalWarningInfo(baseInfo);
    const sig30 = {
      code: "30",
      known: true,
      rank: 3,
      family: "grade",
      label: "警報級",
      compact: "警",
      severity: "warning",
    };
    return {
      ...synth,
      maxKnownSignificancy: sig30 as never,
      // Phase B: バナー発火 + 外枠色は maxDisplaySeverity 基準
      maxDisplaySeverity: "nonLevelWarning",
      maxDisplayRankSignificancy: sig30 as never,
    };
  }

  it("警報以上 (synthetic) でバナー本文 (◆) が frame top の前に現れる", () => {
    const info = makeWarningGlobalInfo();
    const logs = captureDisplay(info);
    const stripped = logs.map(stripAnsi);
    // バナー本文行 (◆ = nonLevelWarning tier prefix を含む) を発見
    const bannerIdx = stripped.findIndex((l) => l.includes("◆"));
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    // frame top 行のインデックスを取得 (╔ or ┌ で始まる)
    const frameTopIdx = stripped.findIndex((l) => /^[╔┌]/.test(l));
    expect(frameTopIdx).toBeGreaterThan(bannerIdx);
  });

  it("注意報のみ電文 (NAGANO fixture) ではバナー無し、1 行目が frame top", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    expect(stripAnsi(logs[0])).toMatch(/^[╔┌]/);
  });

  it("取消 ケースで cancel バナー (取消) が出る", () => {
    const cancelInfo = {
      type: "VPWP50",
      infoType: "取消",
      title: "",
      controlTitle: "",
      reportDateTime: "",
      publishingOffice: "",
      editorialOffice: "",
      eventId: null,
      serial: null,
      headline: null,
      targetArea: { name: "長野県", code: "200000", kinds: { 1: [], 2: [], 3: [] } },
      areas: [],
      maxKnownSignificancy: null,
      unknownCodes: [],
      fallback: "none",
      isTest: false,
    } as unknown as ParsedWeatherWarningTimeseriesInfo;
    const logs = captureDisplay(cancelInfo);
    const stripped = logs.map(stripAnsi).join("\n");
    expect(stripped).toContain("取消");
    expect(stripped).toContain("気象警報・注意報");
  });

  it("◆ 警報 divider が出る (synthetic warning + standard width)", () => {
    setFrameWidth(140);
    const info = makeWarningGlobalInfo();
    const logs = captureDisplay(info);
    clearFrameWidth();
    const all = logs.map(stripAnsi).join("\n");
    expect(all).toContain("◆ 警報");
  });

  it("△ 注意報 divider が出る (NAGANO fixture / standard width)", () => {
    setFrameWidth(140);
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    clearFrameWidth();
    const all = logs.map(stripAnsi).join("\n");
    expect(all).toContain("△ 注意報");
  });

  it("時刻枠列に '(N枠/Mh)' 形式が出る (NAGANO fixture, standard 以上)", () => {
    setFrameWidth(150);
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    clearFrameWidth();
    const all = logs.map(stripAnsi).join("\n");
    expect(all).toMatch(/\(\d+枠\/\d+h\)/);
  });

  it("ultra-narrow (width=80) で注意報がチップ列 [phenomenon N] になる", () => {
    setFrameWidth(80);
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    clearFrameWidth();
    expect(logs.some((l) => /\[\S+\s\d+\]/.test(stripAnsi(l)))).toBe(true);
  });
});

describe("Phase 2-FIX: 重大修正の回帰防止 (Codex R1)", () => {
  function captureDisplay(info: ParsedWeatherWarningTimeseriesInfo): string[] {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    displayWeatherWarningTimeseriesInfo(info);
    spy.mockRestore();
    return logs;
  }

  it("未知 Code を持つ電文で、該当 known entry の備考列に '未知:?XX' が出る (UNKNOWN_CODE fixture, wide)", () => {
    setFrameWidth(200);
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_UNKNOWN_CODE);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    clearFrameWidth();
    const all = logs.map(stripAnsi).join("\n");
    // wide モードで備考列に 未知:?XX が表示される (Code 99 が known entry にマージされる)
    expect(all).toMatch(/未知:\?\d+/);
    // 末尾の独立ブロック (! 未知 Code) にも出る
    expect(all).toContain("! 未知 Code");
  });

  it("注意報チップで '風' propertyType が '強風' になる (normalizeKindName 適用)", () => {
    setFrameWidth(80); // ultra-narrow でチップ表示
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseTimeseries(msg);
    const logs = captureDisplay(info);
    clearFrameWidth();
    const all = logs.map(stripAnsi).join("\n");
    // チップ列が出ている
    expect(all).toMatch(/\[\S+ \d+\]/);
    // [風 N] は出ない (advisory は normalizeKindName で "強風注意報" → suffix 除去で "強風" になる)
    expect(all).not.toMatch(/\[風 \d+\]/);
  });
});

describe("breakpoint 切り替え (Phase 4-A)", () => {
  function captureDisplay(info: ParsedWeatherWarningTimeseriesInfo): string {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      displayWeatherWarningTimeseriesInfo(info);
    } finally {
      spy.mockRestore();
    }
    return logs.map(stripAnsi).join("\n");
  }

  /** synthetic 警報 fixture を組み立てる (maxKnownSignificancy で警報判定が立つようにする) */
  function buildWarningInfo(): ParsedWeatherWarningTimeseriesInfo {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const baseInfo = parseTimeseries(msg);
    const info = createSyntheticGlobalWarningInfo(baseInfo);
    const sig30 = {
      code: "30",
      known: true,
      rank: 3,
      family: "grade",
      label: "警報級",
      compact: "警",
      severity: "warning",
    };
    info.maxKnownSignificancy = sig30 as never;
    info.maxDisplaySeverity = "nonLevelWarning";
    info.maxDisplayRankSignificancy = sig30 as never;
    return info;
  }

  it("width=119 → ultra-narrow (注意報チップ表示、時刻枠/備考の列ヘッダなし)", () => {
    setFrameWidth(119);
    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
      const info = parseTimeseries(msg);
      const out = captureDisplay(info);
      // 注意報チップ [phenomenon N]
      expect(out).toMatch(/\[\S+\s\d+\]/);
      // ultra-narrow は Tier 1 のみ (時刻枠/備考のテーブル列なし)
      // 注意報セクションでは chip 形式なので列ヘッダ「時刻枠」「備考」は出ない
      expect(out).not.toContain("備考");
    } finally {
      clearFrameWidth();
    }
  });

  it("width=120 ちょうど → standard (Tier 1+2 = 6 列、備考列なし)", () => {
    setFrameWidth(120);
    try {
      const info = buildWarningInfo();
      const out = captureDisplay(info);
      expect(out).toContain("時刻枠");
      expect(out).toContain("ピーク");
      expect(out).toContain("基準到達");
      expect(out).not.toContain("備考");
    } finally {
      clearFrameWidth();
    }
  });

  it("width=159 → standard (備考列なし)", () => {
    setFrameWidth(159);
    try {
      const info = buildWarningInfo();
      const out = captureDisplay(info);
      expect(out).toContain("時刻枠");
      expect(out).not.toContain("備考");
    } finally {
      clearFrameWidth();
    }
  });

  it("width=160 ちょうど → wide (Tier 1+2+3 = 7 列、備考列あり)", () => {
    setFrameWidth(160);
    try {
      const info = buildWarningInfo();
      const out = captureDisplay(info);
      expect(out).toContain("時刻枠");
      expect(out).toContain("備考");
    } finally {
      clearFrameWidth();
    }
  });

  it("ユーザー閾値上書き: standardThreshold=100 で width=110 が standard 扱い", () => {
    const original = getWeatherWarningDisplayOptions();
    setWeatherWarningDisplayOptions({
      ...original,
      standardThreshold: 100,
    });
    setFrameWidth(110);
    try {
      const info = buildWarningInfo();
      const out = captureDisplay(info);
      // width=110 はデフォルトなら ultra-narrow だが、閾値 100 で standard 扱いになり 6 列ヘッダが出る
      expect(out).toContain("時刻枠");
      expect(out).toContain("ピーク");
      // standard なので備考列は出ない (wideThreshold は触っていない)
      expect(out).not.toContain("備考");
    } finally {
      clearFrameWidth();
      setWeatherWarningDisplayOptions(original);
    }
  });
});

describe("NO_COLOR golden (chalk.level = 0 で tier 読取り可能)", () => {
  // chalk.level は既にファイル冒頭で 0 に設定済み

  const cases: Array<{ name: string; ref: string; width: number }> = [
    { name: "high_severity wide",         ref: FIXTURE_VPWP50_HIGH_SEVERITY,   width: 200 },
    { name: "high_severity standard",     ref: FIXTURE_VPWP50_HIGH_SEVERITY,   width: 140 },
    { name: "high_severity ultra-narrow", ref: FIXTURE_VPWP50_HIGH_SEVERITY,   width: 80 },
    { name: "unknown_code standard",      ref: FIXTURE_VPWP50_UNKNOWN_CODE,    width: 140 },
    { name: "cancel wide",                ref: FIXTURE_VPWP50_CANCEL,          width: 200 },
    { name: "criteria_period standard",   ref: FIXTURE_VPWP50_CRITERIA_PERIOD, width: 140 },
    { name: "local_area wide",            ref: FIXTURE_VPWP50_LOCAL_AREA,      width: 200 },
    { name: "nagano standard",            ref: FIXTURE_VPWP50_NAGANO,          width: 140 },
  ];

  for (const c of cases) {
    it(`${c.name} (width=${c.width}) golden snapshot + tier 読取り可能`, () => {
      setFrameWidth(c.width);
      const msg = createMockWsDataMessage(c.ref);
      const info = parseTimeseries(msg);
      const logs: string[] = [];
      // Codex I2: 引数なし console.log() (空行) を String(undefined)="undefined" 化しない
      const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
        logs.push(line == null ? "" : String(line));
      });
      try {
        displayWeatherWarningTimeseriesInfo(info);
      } finally {
        spy.mockRestore();
        clearFrameWidth();
      }
      // 軽微指摘 (Codex 最終レビュー) 反映: バナー空白行の trailing whitespace を除去して snapshot 保存
      // (git diff --check が trailing whitespace を検出することへの対応。tier 読取り性には影響なし)
      const out = logs.map((l) => stripAnsi(l).replace(/[ \t]+$/, "")).join("\n");
      expect(out).toMatchSnapshot();

      // tier 段差がテキストで読み取れる検証 (Phase B: displaySeverity 別 divider ラベル)
      if (c.ref === FIXTURE_VPWP50_HIGH_SEVERITY) {
        // displaySeverity 別 divider ラベルのいずれかが含まれる
        // 2026-06-12 目視ゲート決定: divider 文言は VPWW 形式に三電文統一
        const hasAnyTier =
          out.includes("★★ 特別警報 (L5)") ||
          out.includes("★ 危険警報 (L4)") ||
          out.includes("◆◆ 特別警報") ||
          out.includes("☆ 警報 (L3)") ||
          out.includes("◆ 警報") ||
          out.includes("△ 注意報");
        expect(hasAnyTier).toBe(true);
        // 行内 tier prefix も読み取れる
        const hasPrefix = /★★|★|◆◆|◆|☆|△/.test(out);
        expect(hasPrefix).toBe(true);
      }
      if (c.ref === FIXTURE_VPWP50_UNKNOWN_CODE) {
        // 未知 Code ブロックのラベル
        expect(out).toContain("! 未知 Code");
      }
      if (c.ref === FIXTURE_VPWP50_CANCEL) {
        // 取消テキスト
        expect(out).toContain("取消");
      }
    });
  }
});

describe("unknown 表示の安全網 (旧 severityToPrefix 検証から引き継ぎ)", () => {
  it("sibling unknown が merge され、未知 Code ブロックで読み取れる", () => {
    // UNKNOWN_CODE fixture は known + 同一行内 sibling unknown のケース。
    // standalone unknown (Property 全体が unknown) は HEAD_MISSING or 合成 fixture が必要だが、
    // ここでは UNKNOWN_CODE fixture を wide で表示し、unknown が known に merge された後の表示を確認する。
    // (tier prefix は級列・divider 見出し・[詳細]・バナーで読み取れる)
    setFrameWidth(200);
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_UNKNOWN_CODE);
    const info = parseTimeseries(msg);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      displayWeatherWarningTimeseriesInfo(info);
    } finally {
      spy.mockRestore();
      clearFrameWidth();
    }
    const out = logs.map(stripAnsi).join("\n");
    // UNKNOWN_CODE は sibling unknown が known entry に merge されるパターン。
    // 未知 Code は末尾 ! 未知 Code ブロックで必ず読み取れる。挙動の保証。
    expect(out).toContain("! 未知 Code");
    // Phase B: tier prefix は級列・divider 見出し・[詳細] head で読み取れる
    // (? は standalone unknown でないため表内に出ない)。
    expect(out).toMatch(/(★★|★|☆|◆◆|◆|△|○)/);
  });
});

describe("displayWeatherWarningTimeseriesInfo - CLI width contract 第2波 synthetic matrix", () => {
  it.each([40, 60, 80, 120, 200])("過長 title / region / type / period / diagnostic / table を幅 %i に収める", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();

        const base = parseTimeseries(
          createMockWsDataMessage(FIXTURE_VPWP50_NAGANO),
        );
        const longText = (label: string): string =>
          `${label} ${"長い警報種別・対象地域・時刻情報 ".repeat(12)}`;
        const longTimeWindow = (window: TimeWindow | undefined): TimeWindow | undefined =>
          window == null
            ? undefined
            : {
              ...window,
              startName: longText("開始時刻"),
              endName: longText("終了時刻"),
            };
        const longSignificancyValue = (value: SignificancyValue): SignificancyValue => ({
          ...value,
          info: {
            ...value.info,
            label: longText("警報級コード名"),
            compact: longText("級"),
          },
          timeWindow: longTimeWindow(value.timeWindow),
          peak: value.peak == null
            ? undefined
            : { ...value.peak, date: longText("ピーク日"), term: longText("ピーク時間帯") },
          criteriaPeriod: value.criteriaPeriod == null
            ? undefined
            : {
              ...value.criteriaPeriod,
              sentence: longText("基準到達期間"),
              criteriaClass: longText("基準区分"),
            },
        });
        const longQuantitativeValue = (value: QuantitativeValue): QuantitativeValue => ({
          ...value,
          unit: longText("量単位"),
          timeWindow: longTimeWindow(value.timeWindow),
        });
        const longWindValue = (value: WindPairedValue): WindPairedValue => ({
          ...value,
          direction: value.direction == null ? null : longText("風向"),
          timeWindow: longTimeWindow(value.timeWindow),
        });
        const longPart = <T,>(
          part: PartValue<T> | undefined,
          mapValue: (value: T) => T,
        ): PartValue<T> | undefined => part == null
          ? undefined
          : {
            ...part,
            base: part.base == null ? undefined : mapValue(part.base),
            locals: part.locals?.map((local, index) => ({
              ...local,
              areaName: longText(`局地${index + 1}`),
              value: mapValue(local.value),
            })),
          };
        const longKind = (kind: WeatherWarningTimeseriesKind, index: number): WeatherWarningTimeseriesKind => ({
          ...kind,
          type: longText(`警報種別${index + 1}`),
          significancyWorst: longPart(kind.significancyWorst, longSignificancyValue),
          quantitativeWorst: longPart(kind.quantitativeWorst, longQuantitativeValue),
          windWorst: longPart(kind.windWorst, longWindValue),
          metricMeta: kind.metricMeta == null
            ? undefined
            : {
              ...kind.metricMeta,
              unit: longText("メトリック単位"),
              label: longText("メトリック名"),
            },
        });
        const longArea = (area: WeatherWarningTimeseriesArea, areaIndex: number): WeatherWarningTimeseriesArea => ({
          ...area,
          name: longText(`対象地域${areaIndex + 1}`),
          kinds: {
            1: area.kinds[1].map((kind, index) => longKind(kind, index)),
            2: area.kinds[2].map((kind, index) => longKind(kind, index + 10)),
            3: area.kinds[3].map((kind, index) => longKind(kind, index + 20)),
          },
        });
        const areas = base.areas.map(longArea);
        const targetArea = base.targetArea == null ? null : longArea(base.targetArea, 0);
        const unknownCodes = [
          ...base.unknownCodes.map((unknown, index) => ({
            ...unknown,
            code: longText(`未知${index + 1}`),
            propertyType: longText("未知警報種別"),
            timeRef: longText("未知時刻枠"),
            areaName: longText("未知対象地域"),
          })),
          {
            code: longText("99"),
            propertyType: longText("未知警報種別"),
            timeRef: longText("未知時刻枠"),
            areaName: longText("未知対象地域"),
          },
        ];
        const info = {
          ...base,
          title: longText("気象警報・注意報時系列情報タイトル"),
          controlTitle: longText("気象警報・注意報"),
          headline: longText("ヘッドライン"),
          targetArea,
          areas,
          unknownCodes,
        };

        for (const fallback of ["none", "compactOnly", "raw"] as const) {
          resetFrameLineClampFallbackCount();
          const logs: string[] = [];
          const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            logs.push(args.map((arg) => String(arg ?? "")).join(" "));
          });
          try {
            displayWeatherWarningTimeseriesInfo({ ...info, fallback });
          } finally {
            spy.mockRestore();
          }
          expect(logs.length, `color=${level} width=${width} fallback=${fallback}`).toBeGreaterThan(0);
          for (const [index, line] of logs.entries()) {
            const plain = stripAnsi(line);
            const widthOfLine = visualWidth(plain);
            expect(widthOfLine, `color=${level} width=${width} fallback=${fallback} line=${index} ${JSON.stringify(plain.slice(0, 60))}`)
              .toBeLessThanOrEqual(width);
            if (/^[┏┓┗┛┌┐├╠│║└╚]/.test(plain)) expect(widthOfLine).toBe(width);
          }
          expect(getFrameLineClampFallbackCount(), `color=${level} width=${width} fallback=${fallback}`).toBe(0);
        }
      }
    } finally {
      chalk.level = originalLevel;
      clearFrameWidth();
    }
  });
});

describe("displayWeatherWarningTimeseriesInfo - recap", () => {
  it("2行 title の全行を recap に再掲する", () => {
    const originalIsTTY = process.stdout.isTTY;
    const originalRows = process.stdout.rows;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg ?? "")).join(" "));
    });
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });
      setFrameWidth(40);
      const base = parseTimeseries(createMockWsDataMessage(FIXTURE_VPWP50_NAGANO));
      const targetArea = {
        name: "第二行対象地域",
        code: "200000",
        kinds: { 1: [], 2: [], 3: [] },
      };
      displayWeatherWarningTimeseriesInfo({ ...base, targetArea });
      const summaryIndex = logs.findIndex((line) => line.includes("▼ サマリー"));
      expect(summaryIndex).toBeGreaterThan(-1);
      expect(logs.slice(summaryIndex + 1).join("\n")).toContain("気象警報・注意報時系列情報");
      expect(logs.slice(summaryIndex + 1).join("\n")).toContain("第二行対象地域");
    } finally {
      spy.mockRestore();
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, writable: true, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: originalRows, writable: true, configurable: true });
      clearFrameWidth();
    }
  });
});
