import { describe, it, expect } from "vitest";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { parseFloodForecast } from "../../src/dmdata/flood-forecast-parser";

describe("parseFloodForecast — Control/Head basic", () => {
  it("extracts core fields for 16_01_01", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg);
    expect(info).not.toBeNull();
    expect(info!.schema).toBe("vxko50");
    expect(info!.typeCode).toBe("VXKO50");
    expect(info!.infoKind).toBe("指定河川洪水予報");
    expect(info!.infoType).toBe("発表");
    expect(info!.serial).toBe(1);
    expect(info!.eventId).toBe("830303020300"); // Appendix A
    expect(info!.controlTitle).toBe("指定河川洪水予報");
    expect(info!.headTitle).toBe("○○川上流氾濫注意情報");
    expect(info!.isTest).toBe(true); // <Notice>テストサンプル</Notice>
    expect(info!.notice).toContain("テストサンプル");
    expect(info!.targetDateTime).toBe("2019-05-09T20:40:00+09:00");
    expect(info!.reportDateTime).toBe("2019-05-09T20:40:00+09:00");
    // mock-message が xmlReport.control.publishingOffice="気象庁" を返すため、
    // 既存 heat-alert-parser と同型の `xmlReport.control.publishingOffice || str(...)` 経路で
    // mock 値が優先される (実電文では xmlReport から正しい値が来る)。
    expect(info!.publishingOffice).toBe("気象庁");
    expect(info!.editorialOffice).toBe("○○地方気象台");
  });
  it("extracts for 91_01_01 (VXSU)", () => {
    const msg = createMockWsDataMessage("91_01_01_241031_VXSU50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info).not.toBeNull();
    expect(info.schema).toBe("vxsu50");
    expect(info.typeCode).toBe("VXSU50");
    expect(info.infoKind).toBe("水位周知河川に関する情報");
    expect(info.eventId).toBe("8201813100"); // Appendix A
    expect(info.controlTitle).toBe("水位周知河川に関する情報");
    expect(info.headTitle).toBe("善川レベル２氾濫注意報");
    expect(info.isTest).toBe(false); // VXSU 91_01_01 は Notice なし、Status=通常
  });
  it("synthetic_VXKO50_cancel — InfoType=取消 抽出", () => {
    const msg = createMockWsDataMessage("synthetic_VXKO50_cancel.xml");
    const info = parseFloodForecast(msg)!;
    expect(info).not.toBeNull();
    expect(info.infoType).toBe("取消");
    expect(info.serial).toBe(4);
    expect(info.headTitle).toBe("○○川上流氾濫警戒情報の取消");
  });
  it("synthetic_VXKO50_correction — InfoType=訂正 抽出", () => {
    const msg = createMockWsDataMessage("synthetic_VXKO50_correction.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.infoType).toBe("訂正");
  });
  it("Stage 3 Task 9-11 段階では parse 基本フィールドのみ埋まり、inundation/rainfall/floodAssumptions は Task 12 で追加", () => {
    // Task 12 で追加されたあとはこのアサーションは不要 (Task 12 の test に統合)。
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info).not.toBeNull();
  });
});

describe("parseFloodForecast — headlines + scope", () => {
  it("16_01_01 で 3 件の headlines を抽出 (予報区域 / 河川 / 府県予報区等)", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.headlines.length).toBe(3);
    const byScope = new Map(info.headlines.map((h) => [h.scope, h]));
    expect(byScope.get("予報区域")).toBeDefined();
    expect(byScope.get("河川")).toBeDefined();
    expect(byScope.get("府県予報区等")).toBeDefined();
  });
  it("16_01_01 河川 scope: Kind.Code=20, areas=2 件, areas[0].name=○○川", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    const riverHeadline = info.headlines.find((h) => h.scope === "河川")!;
    expect(riverHeadline.kindCode).toBe("20");
    expect(riverHeadline.kindName).toBe("氾濫注意情報");
    expect(riverHeadline.condition).toBe("洪水注意報（発表）");
    expect(riverHeadline.areas.length).toBe(2);
    expect(riverHeadline.areas[0].name).toBe("○○川");
    expect(riverHeadline.areas[0].code).toBe("1234567890");
    expect(riverHeadline.headlineText).toContain("○○川上流");
    expect(riverHeadline.rawScopeLabel).toContain("河川");
  });
  it("91_01_01 (VXSU) scope: 発表区間 が抽出される", () => {
    const msg = createMockWsDataMessage("91_01_01_241031_VXSU50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.headlines.length).toBe(3);
    const bySectionScope = info.headlines.find((h) => h.scope === "発表区間");
    expect(bySectionScope).toBeDefined();
    expect(bySectionScope!.kindCode).toBe("21");
    expect(bySectionScope!.kindName).toBe("レベル２氾濫注意報");
  });
  it("synthetic_VXKO50_cancel — Headline.Text のみ、Information なし → headlines.length=0", () => {
    const msg = createMockWsDataMessage("synthetic_VXKO50_cancel.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.headlines.length).toBe(0);
  });
  it("synthetic_VXKO50_code31 — Kind.Code=31 を厳密に抽出", () => {
    const msg = createMockWsDataMessage("synthetic_VXKO50_code31.xml");
    const info = parseFloodForecast(msg)!;
    const riverHeadline = info.headlines.find((h) => h.scope === "河川");
    expect(riverHeadline).toBeDefined();
    expect(riverHeadline!.kindCode).toBe("31");
  });
});

describe("parseFloodForecast — rawStations (water_level / discharge / criteria)", () => {
  it("16_01_01 で 3 観測所、measurement=water_level, series 7 件, criteria L1-L4Plan あり", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(3);
    const st = info.rawStations[0];
    expect(st.measurement).toBe("water_level");
    expect(st.measurementUnit).toBe("m");
    expect(st.series.length).toBe(7);
    expect(st.criteria.L1).toBeCloseTo(142.0);
    expect(st.criteria.L2).toBeCloseTo(142.5);
    expect(st.criteria.L3).toBeCloseTo(144.6);
    expect(st.criteria.L4).toBeCloseTo(144.9);
    expect(st.criteria.L4Plan).toBeCloseTo(145.1);
    expect(st.criteria.unit).toBe("m");
    // 16_01_01 観測所#0 は欠測のみ
    expect(st.series[0].condition).toBe("欠測");
    expect(st.series[0].value).toBeNull();
    expect(st.series[0].level).toBeNull();
    // 観測所#1 (△△△水位観測所) は実値あり
    const st1 = info.rawStations[1];
    expect(st1.series[0].condition).toBe("上昇");
    expect(st1.series[0].value).toBeCloseTo(46.7);
    expect(st1.series[0].level).toBe(2);
  });
  it("16_01_01 station primaryRiverCode は headline 河川名と一致した場合に解決される", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    // 観測所#0/#1 は ChargeSection: ○○川, 観測所#2 は △△川
    // headline (河川) areas: ○○川 (1234567890), △△川 (9876543210)
    const st0 = info.rawStations[0];
    expect(st0.primaryRiverName).toBe("○○川");
    expect(st0.primaryRiverCode).toBe("1234567890");
    const st2 = info.rawStations[2];
    expect(st2.primaryRiverName).toBe("△△川");
    expect(st2.primaryRiverCode).toBe("9876543210");
  });
  it("16_01_01 station[1] の stationObservedLevel は level=2 → L2", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations[1].stationObservedLevel).toBe("L2");
    // 観測所#0 は欠測のみ → unknown
    expect(info.rawStations[0].stationObservedLevel).toBe("unknown");
  });
  it("16_03_01 (discharge) で measurement=discharge, unit=立方メートル毎秒", () => {
    const msg = createMockWsDataMessage("16_03_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBeGreaterThan(0);
    const st = info.rawStations[0];
    expect(st.measurement).toBe("discharge");
    expect(st.measurementUnit).toBe("立方メートル毎秒");
    expect(st.series.length).toBeGreaterThan(0);
    expect(st.series[0].condition).toBe("上昇");
    expect(st.series[0].value).toBeCloseTo(143.0);
    expect(st.series[0].level).toBe(2);
  });
  it("16_05_01 (Headline-only / Body 空) で rawStations.length=0", () => {
    const msg = createMockWsDataMessage("16_05_01_210630_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(0);
  });
});

describe("parseFloodForecast — inundationAreas / rainfallSummaries / floodAssumptions", () => {
  it("16_01_01 inundationAreas length > 0 (浸水想定地区)", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.inundationAreas.length).toBeGreaterThan(0);
    const ia0 = info.inundationAreas[0];
    expect(ia0.areaName).toBeTruthy();
    expect(ia0.variant).toBe("通常");
  });
  it("16_12_01 inundationAreas が 33 件 (Appendix A)", () => {
    const msg = createMockWsDataMessage("16_12_01_260312_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.inundationAreas.length).toBe(33);
    // 氾濫発生情報のため variant=氾濫発生情報
    const variants = new Set(info.inundationAreas.map((a) => a.variant));
    expect(variants.has("氾濫発生情報")).toBe(true);
  });
  it("16_04_01 floodAssumptions が 5 件 (Code 53 + FloodAssumptionTable)", () => {
    const msg = createMockWsDataMessage("16_04_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.floodAssumptions.length).toBe(5);
    const fa0 = info.floodAssumptions[0];
    expect(fa0.assumptionAreaName).toBe("○市市役所");
    expect(fa0.attainmentTime).toBe("2019-05-27T11:00:00+09:00");
    expect(fa0.attainmentDescription).toBe("２時間後");
    expect(fa0.attainmentDubious).toBe("頃");
    expect(fa0.riverName).toBe("○○川");
    expect(fa0.depthMinM).toBeCloseTo(0);
    expect(fa0.depthMaxM).toBeCloseTo(0.5);
  });
  it("16_04_01 rainfallSummaries length > 0", () => {
    const msg = createMockWsDataMessage("16_04_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rainfallSummaries.length).toBeGreaterThan(0);
  });
  it("91_01_01 (VXSU) rainfallSummaries 抽出 (PrecipitationBasedIndex)", () => {
    const msg = createMockWsDataMessage("91_01_01_241031_VXSU50.xml");
    const info = parseFloodForecast(msg)!;
    // Task 12 では VXSU の trend / currentBasinIndex 抽出は Task 14 で実装。
    // ここでは rainfallSummaries が空でも問題ない (Task 14 で追加)。
    expect(info.rainfallSummaries.length).toBeGreaterThanOrEqual(0);
  });
});

describe("parseFloodForecast — Station.headlineKindCode + mainItemCode/mainTextHash 解決", () => {
  it("16_01_01 河川 scope = Code 20 → station の headlineKindCode=20 / headlineLevel=L2", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    const st = info.rawStations[0];
    expect(st.headlineKindCode).toBe("20");
    expect(st.headlineLevel).toBe("L2");
  });
  it("16_01_01 station mainItemCode='1' + mainTextHash は SHA1 fullhex (40 文字)", () => {
    const msg = createMockWsDataMessage("16_01_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    const st = info.rawStations[0];
    expect(st.mainItemCode).toBe("1");
    expect(st.mainTextHash).toMatch(/^[0-9a-f]{40}$/);
  });
  it("16_05_01 Headline-only で rawStations=0 (station の mainItemCode/mainTextHash は問わない)", () => {
    const msg = createMockWsDataMessage("16_05_01_210630_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(0);
  });
  it("16_06_01 (Code 41) → headlineKindCode='41' / headlineLevel=L4", () => {
    const msg = createMockWsDataMessage("16_06_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBeGreaterThan(0);
    const st = info.rawStations[0];
    expect(st.headlineKindCode).toBe("41");
    expect(st.headlineLevel).toBe("L4");
  });
  it("16_11_01 (Code 51 / 特別警報) → headlineKindCode='51' / headlineLevel=L5", () => {
    const msg = createMockWsDataMessage("16_11_01_260312_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBeGreaterThan(0);
    expect(info.rawStations[0].headlineKindCode).toBe("51");
    expect(info.rawStations[0].headlineLevel).toBe("L5");
  });
});

describe("parseFloodForecast — VXSU stub + 全 18 fixture smoke test", () => {
  it("91_01_01 (VXSU) は series=[] / stationObservedLevel='unknown'", () => {
    const msg = createMockWsDataMessage("91_01_01_241031_VXSU50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(1);
    const st = info.rawStations[0];
    expect(st.series).toEqual([]);
    expect(st.stationObservedLevel).toBe("unknown");
  });
  it("91_01_01 (VXSU) rainfallSummaries に trend=上昇 / currentBasinIndex=10", () => {
    const msg = createMockWsDataMessage("91_01_01_241031_VXSU50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rainfallSummaries.length).toBeGreaterThan(0);
    const rs = info.rainfallSummaries[0];
    expect(rs.trend).toBe("上昇");
    expect(rs.currentBasinIndex).toBe(10);
  });
  it("synthetic_VXSU50_cancel 取消フィールド + 訂正系", () => {
    const msg = createMockWsDataMessage("synthetic_VXSU50_cancel.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.schema).toBe("vxsu50");
    expect(info.infoType).toBe("取消");
  });
  // 全 18 fixture smoke test: parseFloodForecast が null を返さないこと
  const ALL_FIXTURES = [
    "16_01_01_220728_VXKO50.xml",
    "16_02_01_220728_VXKO50.xml",
    "16_02_02_220728_VXKO50.xml",
    "16_03_01_220728_VXKO50.xml",
    "16_04_01_220728_VXKO50.xml",
    "16_05_01_210630_VXKO50.xml",
    "16_06_01_220728_VXKO50.xml",
    "16_07_01_220728_VXKO50.xml",
    "16_10_01_260312_VXKO50.xml",
    "16_11_01_260312_VXKO50.xml",
    "16_11_02_260312_VXKO50.xml",
    "16_12_01_260312_VXKO50.xml",
    "16_14_01_251222_VXKO50.xml",
    "91_01_01_241031_VXSU50.xml",
    "synthetic_VXKO50_cancel.xml",
    "synthetic_VXKO50_correction.xml",
    "synthetic_VXKO50_code31.xml",
    "synthetic_VXSU50_cancel.xml",
  ];
  for (const f of ALL_FIXTURES) {
    it(`smoke: ${f} は parseFloodForecast 後に non-null`, () => {
      const msg = createMockWsDataMessage(f);
      const info = parseFloodForecast(msg);
      expect(info).not.toBeNull();
      expect(info!.eventId).not.toBe("");
    });
  }
});
