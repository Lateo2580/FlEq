import { describe, it, expect, vi, beforeEach } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { parseFloodForecast } from "../../src/dmdata/flood-forecast-parser";
import {
  parseIsoDurationMinutes,
  buildFloodTimeDefineMap,
  type FloodTimeDefine,
} from "../../src/dmdata/flood-shared";

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import * as log from "../../src/logger";

function parseFragment(xml: string): unknown {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
}

describe("parseIsoDurationMinutes", () => {
  it.each([
    ["PT48H", 2880],
    ["PT6H", 360],
    ["PT12H40M", 760],
    ["PT13H40M", 820],
    ["PT23H10M", 1390],
    ["PT36H50M", 2210],
    ["PT96H", 5760],
    ["PT3H", 180],
  ] as const)("実 fixture で出現する Duration: %s → %d", (iso, expected) => {
    expect(parseIsoDurationMinutes(iso)).toBe(expected);
  });

  it.each([
    ["", "空文字"],
    ["PT", "PT 単独"],
    ["PT0H", "全部ゼロ"],
    ["PT0H0M", "全部ゼロ"],
    ["PT0M", "PT{M}M 単独 (regex 範囲外)"],
    ["P1Y", "年範囲外"],
    ["PT1.5H", "小数時間範囲外"],
    ["PT30M", "PT{M}M 単独 (実 fixture に出現せず範囲外)"],
  ] as const)("境界・範囲外: %s (%s) → null", (iso, _reason) => {
    expect(parseIsoDurationMinutes(iso)).toBe(null);
  });

  it("PT0H30M (実 fixture には出ないが regex は hit する形): 30 を返す (formatter 側の防御 fallback で < 60 をハンドリング)", () => {
    expect(parseIsoDurationMinutes("PT0H30M")).toBe(30);
  });
});

describe("buildFloodTimeDefineMap", () => {
  it("Duration ありの TimeDefine を durationIso / durationMinutes 両方に取り込む", () => {
    const parsed = parseFragment(`
      <root>
        <TimeDefines>
          <TimeDefine timeId="1">
            <DateTime>2019-05-07T20:20:00+09:00</DateTime>
            <Duration>PT48H</Duration>
            <Name>７日２０時２０分から９日２０時２０分までの流域平均雨量</Name>
          </TimeDefine>
          <TimeDefine timeId="2">
            <DateTime>2019-05-09T20:20:00+09:00</DateTime>
            <Duration>PT3H</Duration>
            <Name>９日２０時２０分から９日２３時２０分までの流域平均雨量の見込み</Name>
          </TimeDefine>
        </TimeDefines>
      </root>
    `);
    const map = buildFloodTimeDefineMap((parsed as { root: { TimeDefines: unknown } }).root.TimeDefines);
    expect(map.size).toBe(2);
    expect(map.get("1")).toMatchObject<Partial<FloodTimeDefine>>({
      refId: "1",
      durationIso: "PT48H",
      durationMinutes: 2880,
    });
    expect(map.get("2")).toMatchObject<Partial<FloodTimeDefine>>({
      refId: "2",
      durationIso: "PT3H",
      durationMinutes: 180,
    });
  });

  it("Duration なし (VXSU 想定) は durationIso=null / durationMinutes=null", () => {
    const parsed = parseFragment(`
      <root>
        <TimeDefines>
          <TimeDefine timeId="1">
            <DateTime>2023-07-10T16:00:00+09:00</DateTime>
            <Name>１０日１６時００分</Name>
          </TimeDefine>
        </TimeDefines>
      </root>
    `);
    const map = buildFloodTimeDefineMap((parsed as { root: { TimeDefines: unknown } }).root.TimeDefines);
    expect(map.get("1")).toMatchObject<Partial<FloodTimeDefine>>({
      durationIso: null,
      durationMinutes: null,
    });
  });
});

describe("parseRainfallSummaries (multi-TimeSeriesInfo + windowMinutes 駆動)", () => {
  beforeEach(() => {
    vi.mocked(log.debug).mockClear();
  });

  it("16_01_01 (PT48H + PT3H, 流域 1 件)", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_01_01_220728_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(2880);
    expect(info.rainfallSummaries[0].forecastShort?.windowMinutes).toBe(180);
  });

  it("16_10_01 (multi-TSI, 流域 4 件、3 番目が PT13H40M)", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_10_01_260312_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(4);
    expect(info.rainfallSummaries.map((r) => r.cumulativeActual?.windowMinutes)).toEqual([760, 760, 820, 760]);
    expect(info.rainfallSummaries.every((r) => r.forecastShort?.windowMinutes === 180)).toBe(true);
  });

  it("16_11_01 (multi-TSI, 流域 3 件、2 番目が PT23H10M)", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_11_01_260312_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(3);
    expect(info.rainfallSummaries.map((r) => r.cumulativeActual?.windowMinutes)).toEqual([2880, 1390, 2880]);
  });

  it("16_12_01 (PT96H, 流域 1 件)", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_12_01_260312_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(5760);
  });

  it("16_14_01 (PT36H50M, 流域 1 件)", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_14_01_251222_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(2210);
  });

  it("16_05_01 (雨量情報なし) → 空配列", () => {
    const info = parseFloodForecast(createMockWsDataMessage("16_05_01_210630_VXKO50.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(0);
  });

  it("91_01_01 (VXSU): 既存 trend / currentBasinIndex 経路が回帰しない", () => {
    const info = parseFloodForecast(createMockWsDataMessage("91_01_01_241031_VXSU50.xml"))!;
    expect(info.rainfallSummaries.length).toBeGreaterThan(0);
    const vxsu = info.rainfallSummaries[0];
    expect(vxsu.cumulativeActual).toBeNull();
    expect(vxsu.forecastShort).toBeNull();
    expect(vxsu.trend).toBe("上昇");
    expect(vxsu.currentBasinIndex).toBe(10);
  });

  it("synthetic forecast Name 欠落 + Duration=PT3H → cumulativeActual.windowMinutes=180 (forecast に誤分類されない、W1 反映)", () => {
    // Codex review W1: Duration PT3H fallback 廃止 → "見込み" を含まない PT3H は cumulative 側 (1 件目) として扱う
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_forecast_no_namekey.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].forecastShort).toBeNull();
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(180);
    // Duration PT3H 補完ログ は出ない (補完 fallback 自体を廃止)
    const debugCalls = vi.mocked(log.debug).mock.calls.map((c) => String(c[0] ?? ""));
    expect(debugCalls.some((m) => m.includes("Name 欠落 forecast"))).toBe(false);
  });

  it("synthetic cumulative Name に '3時間' + Duration 欠落 → cumulativeActual.windowMinutes=180 (Name fallback)、forecast に誤振り分けされない", () => {
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_cumulative_with_namekey.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(180);
    expect(info.rainfallSummaries[0].forecastShort).toBeNull();
    const debugCalls = vi.mocked(log.debug).mock.calls.map((c) => String(c[0] ?? ""));
    expect(debugCalls.some((m) => m.includes("Name 欠落 forecast"))).toBe(false);
  });

  it("synthetic 多重 cumulative → 先頭のみ採用、2 件目で log.debug", () => {
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_multi_cumulative.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual).not.toBeNull();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("多窓累積を検知"));
  });

  it("synthetic 多重 forecast → 先頭のみ採用、2 件目で log.debug", () => {
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_multi_forecast.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].forecastShort).not.toBeNull();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("多重 forecast を検知"));
  });

  it("synthetic forecast Name fallback (Duration 欠落 + Name '６時間…見込み' 全角) → forecastShort.windowMinutes=360 (NFKC normalize 検証、W2)", () => {
    // Codex review W2: Name regex は NFKC normalize 後に `\d+時間` を抽出。全角数字 "６" でも 360 を返す
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_forecast_name_fallback.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].forecastShort?.windowMinutes).toBe(360);
    expect(info.rainfallSummaries[0].cumulativeActual).toBeNull();
  });

  it("synthetic cumulative windowMinutes=null (Duration も Name regex も hit せず) → null を保持", () => {
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_cumulative_no_window.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].cumulativeActual).not.toBeNull();
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBeNull();
    expect(info.rainfallSummaries[0].forecastShort).toBeNull();
  });

  it("synthetic PT6H (refID=1) + PT3H Name 欠落 (refID=2) → cumulativeActual=360 を 1 件目で確定、refID=2 は多窓累積扱いで log.debug (W1 反映)", () => {
    // Codex review W1: PT3H Name 欠落は forecast に振り分けず cumulative 側 (2 件目) として扱う → "多窓累積を検知" log.debug
    const info = parseFloodForecast(createMockWsDataMessage("synthetic_VXKO50_forecast_with_cumulative.xml"))!;
    expect(info.rainfallSummaries).toHaveLength(1);
    expect(info.rainfallSummaries[0].forecastShort).toBeNull();
    expect(info.rainfallSummaries[0].cumulativeActual?.windowMinutes).toBe(360);
    const debugCalls = vi.mocked(log.debug).mock.calls.map((c) => String(c[0] ?? ""));
    expect(debugCalls.some((m) => m.includes("Name 欠落 forecast"))).toBe(false);
    expect(debugCalls.some((m) => m.includes("多窓累積を検知"))).toBe(true);
  });
});

describe("formatWindowLabel / formatForecastLabel 防御 fallback (Codex review W4 反映)", () => {
  // formatForecastLabel は parser 側の 180 default invent 廃止 (W3) に伴い nullable を受けるよう変更
  // cumulative と対称に null/< 60 防御 fallback を持つ (W4)
  it.each([
    [180, "3時間予測"],
    [360, "6時間予測"],
    [760, "12時間40分予測"],
    [null, "(?時間)予測"],
    [0, "(?時間)予測"],
    [30, "(?時間)予測"],
    [59, "(?時間)予測"],
    [60, "1時間予測"],
  ] as const)("formatForecastLabel(%s) → %s", async (input, expected) => {
    const { formatForecastLabel } = await import("../../src/ui/flood-forecast-formatter");
    expect(formatForecastLabel(input)).toBe(expected);
  });

  it.each([
    [180, "3時間累積"],
    [2880, "48時間累積"],
    [760, "12時間40分累積"],
    [null, "(?時間)累積"],
    [0, "(?時間)累積"],
    [30, "(?時間)累積"],
    [59, "(?時間)累積"],
    [60, "1時間累積"],
  ] as const)("formatWindowLabel(%s) → %s", async (input, expected) => {
    const { formatWindowLabel } = await import("../../src/ui/flood-forecast-formatter");
    expect(formatWindowLabel(input)).toBe(expected);
  });
});
