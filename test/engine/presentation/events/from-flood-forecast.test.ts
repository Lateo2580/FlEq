import { describe, it, expect } from "vitest";
import { fromFloodForecastOutcome } from "../../../../src/engine/presentation/events/from-flood-forecast";
import type { FloodForecastOutcome } from "../../../../src/engine/presentation/types";
import type { WsDataMessage, ParsedFloodForecastInfo, FloodStation, FloodHeadline, FloodKindCode } from "../../../../src/types";

function mkHeadline(opts: Partial<FloodHeadline> & { kindCode: FloodKindCode }): FloodHeadline {
  return {
    scope: opts.scope ?? "河川",
    rawScopeLabel: opts.rawScopeLabel ?? "河川",
    kindName: opts.kindName ?? "氾濫警戒情報",
    kindCode: opts.kindCode,
    headlineText: opts.headlineText ?? "headline",
    condition: opts.condition ?? "",
    areas: opts.areas ?? [],
  };
}

function mkStation(opts: { stationName: string; stationCode: string; headlineLevel?: FloodStation["headlineLevel"]; stationObservedLevel?: FloodStation["stationObservedLevel"] }): FloodStation {
  return {
    stationName: opts.stationName,
    stationCode: opts.stationCode,
    riverNames: [],
    primaryRiverCode: null,
    primaryRiverName: null,
    prefName: null,
    cityName: null,
    cityCode: null,
    location: null,
    measurement: "water_level",
    measurementUnit: "m",
    rawUnit: "m",
    series: [],
    criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
    stationObservedLevel: opts.stationObservedLevel ?? "L2",
    headlineKindCode: "30",
    headlineLevel: opts.headlineLevel ?? "L3",
    mainItemCode: "1",
    mainTextHash: "deadbeef",
  };
}

function mkMsg(): WsDataMessage {
  return {
    type: "data",
    id: "msg-1",
    classification: "telegram.weather",
    head: { type: "VXKO50", author: "JMA", time: "2019-05-09T20:40:00+09:00", designation: null, test: false, xml: 1 },
    passing: [],
    format: "xml",
    compression: null,
    encoding: "utf-8",
    body: "",
  } as WsDataMessage;
}

function mkParsed(overrides: Partial<ParsedFloodForecastInfo> = {}): ParsedFloodForecastInfo {
  return {
    schema: "vxko50", typeCode: "VXKO50",
    infoKind: "指定河川洪水予報", infoType: "発表",
    serial: 1, eventId: "e1",
    controlTitle: "指定河川洪水予報", headTitle: "○○川氾濫警戒情報",
    reportDateTime: "2019-05-09T20:40:00+09:00", targetDateTime: null,
    isTest: false, notice: null,
    headlines: [], rawStations: [],
    inundationAreas: [], rainfallSummaries: [], floodAssumptions: [],
    publishingOffice: "気象庁", editorialOffice: "気象庁",
    ...overrides,
  };
}

function mkOutcome(parsed: ParsedFloodForecastInfo, presOverrides: Partial<FloodForecastOutcome["presentation"]> = {}): FloodForecastOutcome {
  return {
    domain: "floodForecast",
    msg: mkMsg(),
    headType: "VXKO50",
    statsCategory: "floodForecast",
    parsed,
    diff: null,
    stats: { shouldRecord: true, eventId: parsed.eventId },
    presentation: {
      frameLevel: "warning",
      soundLevel: "warning",
      notifyCategory: "floodForecast",
      suppressNotify: false,
      ...presOverrides,
    },
  };
}

describe("fromFloodForecastOutcome", () => {
  it("converts FloodForecastOutcome to PresentationEvent with §17.1 field 規約", () => {
    const parsed = mkParsed({
      headlines: [mkHeadline({ scope: "河川", kindCode: "30", headlineText: "○○川で水位上昇" })],
      rawStations: [
        mkStation({ stationName: "S1", stationCode: "s1", headlineLevel: "L3", stationObservedLevel: "L2" }),
        mkStation({ stationName: "S2", stationCode: "s2", headlineLevel: "L3", stationObservedLevel: "L3" }),
      ],
    });
    const outcome = mkOutcome(parsed);
    const ev = fromFloodForecastOutcome(outcome);

    // 識別
    expect(ev.id).toBe("msg-1");
    expect(ev.classification).toBe("telegram.weather");
    expect(ev.domain).toBe("floodForecast");
    expect(ev.type).toBe("VXKO50");

    // 共通メタ
    expect(ev.infoType).toBe("発表");
    expect(ev.title).toBe("○○川氾濫警戒情報");
    expect(ev.controlTitle).toBe("指定河川洪水予報");
    expect(ev.headline).toBe("○○川で水位上昇");
    expect(ev.reportDateTime).toBe("2019-05-09T20:40:00+09:00");
    expect(ev.publishingOffice).toBe("気象庁");
    expect(ev.isTest).toBe(false);

    // レベル
    expect(ev.frameLevel).toBe("warning");
    expect(ev.soundLevel).toBe("warning");
    expect(ev.notifyCategory).toBe("floodForecast");

    // 状態フラグ
    expect(ev.isCancellation).toBe(false);
    // frameLevel === "warning" → isWarning=true (field-registry filter から漏れないよう)
    expect(ev.isWarning).toBe(true);

    // イベント追跡
    expect(ev.eventId).toBe("e1");
    expect(ev.serial).toBe("1");

    // 地域集約 (§17.1: rawStations.map で展開)
    expect(ev.areaNames).toEqual(["S1", "S2"]);
    expect(ev.areaCount).toBe(2);
    expect(ev.forecastAreaNames).toEqual([]);
    expect(ev.municipalityNames).toEqual([]);
    expect(ev.observationNames).toEqual([]);
    expect(ev.forecastAreaCount).toBe(0);
    expect(ev.municipalityCount).toBe(0);
    expect(ev.observationCount).toBe(0);

    // areaItems
    expect(ev.areaItems.length).toBe(2);
    expect(ev.areaItems[0]).toEqual({
      name: "S1",
      code: "s1",
      flags: ["L3", "L2"],
    });
    expect(ev.areaItems[1]).toEqual({
      name: "S2",
      code: "s2",
      flags: ["L3", "L3"],
    });

    // raw
    expect(ev.raw).toBe(parsed);
  });

  it("headline fallback: scope=河川 がなければ headTitle を使う", () => {
    const parsed = mkParsed({
      headlines: [mkHeadline({ scope: "府県予報区等", kindCode: "30", headlineText: "府県側の headline" })],
      rawStations: [mkStation({ stationName: "S1", stationCode: "s1" })],
    });
    const ev = fromFloodForecastOutcome(mkOutcome(parsed));
    // §17.1: 河川 scope の headlineText、なければ headTitle fallback
    expect(ev.headline).toBe("○○川氾濫警戒情報");
  });

  it("headlines が空ならば headTitle を使う", () => {
    const parsed = mkParsed({
      headlines: [],
      rawStations: [mkStation({ stationName: "S1", stationCode: "s1" })],
    });
    const ev = fromFloodForecastOutcome(mkOutcome(parsed));
    expect(ev.headline).toBe("○○川氾濫警戒情報");
  });

  it("取消パス: isCancellation=true", () => {
    const parsed = mkParsed({
      infoType: "取消",
      headTitle: "取消",
      headlines: [],
      rawStations: [],
    });
    const ev = fromFloodForecastOutcome(mkOutcome(parsed, { frameLevel: "cancel", soundLevel: "cancel" }));
    expect(ev.isCancellation).toBe(true);
    expect(ev.frameLevel).toBe("cancel");
    // frameLevel === "cancel" → isWarning=false
    expect(ev.isWarning).toBe(false);
    expect(ev.areaNames).toEqual([]);
    expect(ev.areaCount).toBe(0);
    expect(ev.areaItems).toEqual([]);
  });

  it("VXSU schema パターン: station 1 件のみ、headlines[0] fallback", () => {
    const parsed = mkParsed({
      schema: "vxsu50",
      typeCode: "VXSU50",
      infoKind: "水位周知河川に関する情報",
      headTitle: "VXSU 水位通知",
      headlines: [mkHeadline({ scope: "発表区間", kindCode: "21", headlineText: "○○川 水位到達" })],
      rawStations: [mkStation({ stationName: "VXSU観測所", stationCode: "vxsu-1", headlineLevel: "L2", stationObservedLevel: "L2" })],
    });
    const outcome = mkOutcome(parsed, { frameLevel: "normal", soundLevel: "normal" });
    const ev = fromFloodForecastOutcome(outcome);
    expect(ev.areaNames).toEqual(["VXSU観測所"]);
    expect(ev.areaCount).toBe(1);
    expect(ev.areaItems[0]).toEqual({
      name: "VXSU観測所",
      code: "vxsu-1",
      flags: ["L2", "L2"],
    });
    // VXSU の headline は scope=河川 がないため headlines[0] fallback (発表区間 scope) を使う
    expect(ev.headline).toBe("○○川 水位到達");
    // frameLevel === "normal" → isWarning=false
    expect(ev.isWarning).toBe(false);
  });

  it("isWarning: critical 級 (L5/L4) → true", () => {
    const parsed = mkParsed({
      headlines: [mkHeadline({ scope: "河川", kindCode: "51", kindName: "氾濫発生情報" })],
      rawStations: [mkStation({ stationName: "S1", stationCode: "s1", headlineLevel: "L5", stationObservedLevel: "L5" })],
    });
    const ev = fromFloodForecastOutcome(
      mkOutcome(parsed, { frameLevel: "critical", soundLevel: "critical" }),
    );
    // frameLevel === "critical" → isWarning=true (field-registry filter で拾われる)
    expect(ev.isWarning).toBe(true);
  });

  it("isWarning: L2 (frameLevel=normal) → false", () => {
    const parsed = mkParsed({
      headlines: [mkHeadline({ scope: "河川", kindCode: "21", kindName: "氾濫注意情報" })],
      rawStations: [mkStation({ stationName: "S1", stationCode: "s1", headlineLevel: "L2", stationObservedLevel: "L2" })],
    });
    const ev = fromFloodForecastOutcome(
      mkOutcome(parsed, { frameLevel: "normal", soundLevel: "normal" }),
    );
    // frameLevel === "normal" (L2 / L1 相当) → isWarning=false
    expect(ev.isWarning).toBe(false);
  });

  it("type は outcome.headType を見る (msg.head.type ではなく)", () => {
    const parsed = mkParsed({ typeCode: "VXKO50" });
    const outcome = mkOutcome(parsed);
    outcome.headType = "VXKO51";  // outcome.headType を上書き
    const ev = fromFloodForecastOutcome(outcome);
    expect(ev.type).toBe("VXKO51");
  });

  it("raw field は outcome.parsed をそのまま参照する", () => {
    const parsed = mkParsed({
      headlines: [mkHeadline({ kindCode: "30" })],
      rawStations: [mkStation({ stationName: "S1", stationCode: "s1" })],
    });
    const ev = fromFloodForecastOutcome(mkOutcome(parsed));
    expect(ev.raw).toBe(parsed);
  });
});
