import { describe, it, expect } from "vitest";
import {
  createMockWsDataMessage,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL,
  FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE,
  FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE,
} from "../helpers/mock-message";
import { parseWeatherExplanation } from "../../src/dmdata/weather-explanation-parser";

describe("parseWeatherExplanation VPFJ51", () => {
  it("台風 fixture (85_01_01): controlTitle/forecast/observation すべて非 null", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_KANTO);
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.controlTitle).toBe("府県気象解説情報");
    expect(info!.forecast).not.toBeNull();
    expect(info!.observation).not.toBeNull();
    // forecast に Becoming を含む系列がある (風の予想)
    const windSeries = info!.forecast!.series.find((s) =>
      s.metrics.some((m) => m.metricType === "風の予想"),
    );
    expect(windSeries).toBeDefined();
    const becomingFound = windSeries!.metrics.some((m) =>
      m.locals.some((l) => l.phases.some((p) => p.kind === "becoming")),
    );
    expect(becomingFound).toBe(true);
    // observation に三宅島 (雨/風) が居る
    const stations = info!.observation!.series.flatMap((s) =>
      s.stations.map((st) => st.stationName),
    );
    expect(stations).toContain("三宅島");
  });

  it("福井大雪初報 (85(82)_02_01): forecast に SnowfallDepth + Local AreaName='平地'", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL);
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.forecast).not.toBeNull();
    expect(info!.observation).toBeNull();
    // SnowfallDepth を含む系列
    const snowMetric = info!.forecast!.series
      .flatMap((s) => s.metrics)
      .find((m) => m.locals.some((l) => l.areaName === "平地"));
    expect(snowMetric).toBeDefined();
    // Area が CodeList のみのケース: codes が非空、primaryCode に値がある
    const areaForHirachi = info!.forecast!.series
      .flatMap((s) => s.metrics)
      .find((m) => m.areaName === "嶺北北部平地");
    expect(areaForHirachi).toBeDefined();
    expect(areaForHirachi!.codes.length).toBeGreaterThan(0);
    expect(areaForHirachi!.primaryCode).toBe("180011");
  });

  it("福井追加報 (85(82)_02_04): forecast != null かつ observation の同 propertyType に 2 element", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE);
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.forecast).not.toBeNull();
    expect(info!.observation).not.toBeNull();
    const snowSeries = info!.observation!.series.filter(
      (s) => s.propertyType === "雪の実況",
    );
    const elementSet = new Set(snowSeries.map((s) => s.element));
    // fixture は全角数字 "１２時間降雪量" を使う
    expect([...elementSet].some((e) => e?.includes("１２時間降雪量"))).toBe(true);
    expect([...elementSet].some((e) => e?.includes("積雪の深さ"))).toBe(true);
  });

  it("福井続報 (85(82)_02_07): 02_04 と同構造、Headline 差分のみ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE);
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.forecast).not.toBeNull();
    expect(info!.observation).not.toBeNull();
  });

  it("取消 fixture: infoType=取消", () => {
    const msg = createMockWsDataMessage("synthetic/vpfj51_cancel.xml", {
      head: {
        type: "VPFJ51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
    });
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.infoType).toBe("取消");
    expect(info!.forecast).toBeNull();
    expect(info!.observation).toBeNull();
  });

  it("Head 欠落 fixture: parseWeatherExplanation は null を返す", () => {
    const msg = createMockWsDataMessage("synthetic/vpfj51_no_head.xml", {
      head: {
        type: "VPFJ51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
    });
    const info = parseWeatherExplanation(msg);
    expect(info).toBeNull();
  });
});
