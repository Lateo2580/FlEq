import { describe, expect, it } from "vitest";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { DISPLAY_PROTOCOL_VERSION } from "../../../src/engine/display/types";
import type {
  DisplayEventDtoV1,
  DisplayTsunamiLevel,
  DisplayTsunamiObservationV1,
  DisplayWeatherAlertV1,
} from "../../../src/engine/display/types";

const MIN = 60_000;
const T0 = Date.parse("2026-07-06T21:00:00+09:00");

function eewDto(over: Partial<{ eventId: string; serial: string; isFinal: boolean; isCancellation: boolean; isWarning: boolean; isCorrection: boolean; hypocenterName: string }>): DisplayEventDtoV1 {
  const o = { eventId: "E1", serial: "1", isFinal: false, isCancellation: false, isWarning: true, isCorrection: false, hypocenterName: "X", ...over };
  return {
    version: 1, seq: 0, id: `m-${o.eventId}-${o.serial}`, eventKey: `eew:${o.eventId}:${o.serial}`,
    groupKey: `eew:${o.eventId}`, domain: "eew", type: "VXSE45", infoType: "発表",
    reportDateTime: "2026-07-06T21:00:00+09:00", title: "緊急地震速報", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "critical", isCancellation: o.isCancellation,
    summary: { text: "t", role: "eewWarning" },
    emergency: {
      kind: "eew", eventId: o.eventId, serial: o.serial, isWarning: o.isWarning, isFinal: o.isFinal,
      isCancellation: o.isCancellation, isCorrection: o.isCorrection, hypocenterName: o.hypocenterName, forecastMaxInt: "5強",
      forecastMaxIntRank: 6, magnitude: "6.0", colorIndex: 0, reportDateTime: "2026-07-06T21:00:00+09:00",
    },
    recentQuake: null,
  } as DisplayEventDtoV1;
}

function quakeDto(over: Partial<{ eventId: string; maxInt: string; maxIntRank: number | null; reportDateTime: string }>): DisplayEventDtoV1 {
  const o = { eventId: "Q1", maxInt: "5強", maxIntRank: 6, reportDateTime: "2026-07-06T21:00:00+09:00", ...over };
  return {
    version: 1, seq: 0, id: `m-${o.eventId}-${o.reportDateTime}`, eventKey: `quake:${o.eventId}:${o.reportDateTime}`,
    groupKey: `quake:${o.eventId}`, domain: "earthquake", type: "VXSE53", infoType: "発表",
    reportDateTime: o.reportDateTime, title: "震源・震度情報", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "warning", isCancellation: false,
    summary: { text: "t", role: "quakeMajor" },
    emergency: {
      kind: "largeQuake", eventId: o.eventId, originTime: null, hypocenterName: "X",
      magnitude: "6.0", maxInt: o.maxInt, maxIntRank: 6, intensityGroups: [], reportDateTime: o.reportDateTime,
      depth: null, maxLgInt: null, tsunamiWarning: false,
    },
    recentQuake: {
      eventId: o.eventId, reportDateTime: o.reportDateTime, originTime: null,
      hypocenterName: "X", magnitude: "6.0", maxInt: o.maxInt, maxIntRank: 6,
      depth: null, tsunamiWarning: false,
    },
    latestQuake: {
      eventId: o.eventId, headline: null, originTime: null, hypocenterName: "X",
      depth: null, magnitude: "6.0", maxInt: o.maxInt, maxIntRank: o.maxIntRank,
      tsunamiWarning: false, intensityGroups: [], reportDateTime: o.reportDateTime,
    },
    tickerDetail: null,
  };
}

function largeQuakeOnlyDto(over: Partial<{ eventId: string; maxInt: string; maxIntRank: number; reportDateTime: string }>): DisplayEventDtoV1 {
  const o = { eventId: "Q1", maxInt: "5弱", maxIntRank: 5, reportDateTime: "2026-07-06T21:00:00+09:00", ...over };
  return {
    version: 1, seq: 0, id: `m-${o.eventId}-${o.reportDateTime}`, eventKey: `quake:${o.eventId}:${o.reportDateTime}`,
    groupKey: `quake:${o.eventId}`, domain: "earthquake", type: "VXSE53", infoType: "発表",
    reportDateTime: o.reportDateTime, title: "震源・震度情報", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "warning", isCancellation: false,
    summary: { text: "t", role: "quakeMajor" },
    emergency: {
      kind: "largeQuake", eventId: o.eventId, originTime: null, hypocenterName: "X",
      magnitude: "6.0", maxInt: o.maxInt, maxIntRank: o.maxIntRank, intensityGroups: [], reportDateTime: o.reportDateTime,
      depth: null, maxLgInt: null, tsunamiWarning: false,
    },
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
  } as DisplayEventDtoV1;
}

function latestQuakeOnlyDto(over: Partial<{ eventId: string | null; maxInt: string; maxIntRank: number | null; reportDateTime: string; isCancellation: boolean }>): DisplayEventDtoV1 {
  const o = { eventId: "Q1", maxInt: "5弱", maxIntRank: 5, reportDateTime: "2026-07-06T21:00:00+09:00", isCancellation: false, ...over };
  return {
    version: 1, seq: 0, id: `m-${o.eventId}-${o.reportDateTime}`, eventKey: `quake:${o.eventId}:${o.reportDateTime}`,
    groupKey: `quake:${o.eventId}`, domain: "earthquake", type: "VXSE53", infoType: "発表",
    reportDateTime: o.reportDateTime, title: "震源・震度情報", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "warning", isCancellation: o.isCancellation,
    summary: { text: "t", role: "quakeMajor" },
    emergency: null,
    recentQuake: null,
    latestQuake: o.isCancellation ? null : {
      eventId: o.eventId, headline: null, originTime: null, hypocenterName: "X",
      depth: null, magnitude: "6.0", maxInt: o.maxInt, maxIntRank: o.maxIntRank,
      tsunamiWarning: false, intensityGroups: [], reportDateTime: o.reportDateTime,
    },
    tickerDetail: null,
  } as DisplayEventDtoV1;
}

function tsunamiDto(over: Partial<{
  type: string;
  hasEmergency: boolean;
  level: DisplayTsunamiLevel;
  reportDateTime: string;
  serial: string | null;
  infoType: string;
}>): DisplayEventDtoV1 {
  const o = {
    type: "VTSE41",
    hasEmergency: true,
    level: "warning" as DisplayTsunamiLevel,
    reportDateTime: "2026-07-06T21:00:00+09:00",
    serial: null,
    infoType: "発表",
    ...over,
  };
  const labels: Record<DisplayTsunamiLevel, string> = { majorWarning: "大津波警報", warning: "津波警報", advisory: "津波注意報" };
  return {
    version: 1, seq: 0, id: `t-${o.type}-${o.reportDateTime}`, eventKey: `tsunami:${o.type}:${o.reportDateTime}`,
    groupKey: "tsunami", domain: "tsunami", type: o.type, infoType: o.infoType,
    reportDateTime: o.reportDateTime, title: "津波警報・注意報・予報", headline: null,
    serial: o.serial,
    publishingOffice: "気象庁", isTest: false, frameLevel: "critical", isCancellation: false,
    summary: { text: "t", role: "tsunamiWarning" },
    emergency: o.hasEmergency
      ? {
          kind: "tsunami", level: o.level, levelLabel: labels[o.level],
          coasts: [{ name: "千葉県九十九里・外房", kind: labels[o.level], maxHeight: null, firstHeight: null }],
          warningComment: null, observations: [],
          reportDateTime: o.reportDateTime,
        }
      : null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
  };
}

describe("DisplayStateStore: EEW", () => {
  it("新規 EEW が activeEews に載る", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({}), T0)).toBe(true);
    const snap = store.snapshot(1, T0);
    expect(snap.activeEews.length).toBe(1);
    expect(snap.activeEews[0]).toMatchObject({ eventId: "E1", serial: "1" });
  });

  it("続報 (serial 大) が上書きし、古い serial は無視される", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "3" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ serial: "2" }), T0 + 1_000)).toBe(false);
    const snap = store.snapshot(1, T0 + 1_000);
    expect(snap.activeEews.length).toBe(1);
    expect(snap.activeEews[0].serial).toBe("3");
  });

  it("古い serial は最終報 (isFinal) でも無視される。同 serial の final は受理される", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "3" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ serial: "2", isFinal: true }), T0 + 1_000)).toBe(false);
    let snap = store.snapshot(1, T0 + 1_000);
    expect(snap.activeEews[0]).toMatchObject({ serial: "3", isFinal: false });
    expect(store.applyEvent(eewDto({ serial: "3", isFinal: true }), T0 + 2_000)).toBe(true);
    snap = store.snapshot(2, T0 + 2_000);
    expect(snap.activeEews.length).toBe(1);
    expect(snap.activeEews[0]).toMatchObject({ serial: "3", isFinal: true });
  });

  it("同一 serial の訂正は state を置換する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({
      serial: "3",
      hypocenterName: "訂正前",
    }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({
      serial: "3",
      isCorrection: true,
      hypocenterName: "訂正後",
    }), T0 + 1_000)).toBe(true);

    expect(store.snapshot(1, T0 + 1_000).activeEews[0]).toMatchObject({
      serial: "3",
      isCorrection: true,
      hypocenterName: "訂正後",
    });
  });

  it("別 eventId は並存する (複数 EEW)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ eventId: "E1" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ eventId: "E2" }), T0)).toBe(true);
    const snap = store.snapshot(1, T0);
    expect(snap.activeEews.length).toBe(2);
    expect(snap.activeEews.map((e) => e.eventId).sort()).toEqual(["E1", "E2"]);
  });

  it("取消で除去される", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "1" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ serial: "2", isCancellation: true }), T0 + 1_000)).toBe(true);
    expect(store.snapshot(1, T0 + 1_000).activeEews.length).toBe(0);
  });

  it("遅延到着した古い serial の取消は無視される (新しい報を消さない)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "3" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ serial: "2", isCancellation: true }), T0 + 1_000)).toBe(false);
    const snap = store.snapshot(1, T0 + 1_000);
    expect(snap.activeEews.length).toBe(1);
    expect(snap.activeEews[0].serial).toBe("3");
  });

  it("保持中と同じ serial の取消は除去する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "3" }), T0)).toBe(true);
    expect(store.applyEvent(eewDto({ serial: "3", isCancellation: true }), T0 + 1_000)).toBe(true);
    expect(store.snapshot(1, T0 + 1_000).activeEews.length).toBe(0);
  });

  it("最終報は EEW_FINAL_HOLD_SEC 後の sweep で除去される", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({ serial: "5", isFinal: true }), T0)).toBe(true);
    expect(store.sweep(T0 + 119_000)).toBe(false);
    expect(store.snapshot(1, T0 + 119_000).activeEews.length).toBe(1);
    expect(store.sweep(T0 + 121_000)).toBe(true);
    expect(store.snapshot(2, T0 + 121_000).activeEews.length).toBe(0);
  });

  it("TTL: 続報が来ず EEW_TTL_MIN 経過で sweep が除去する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({}), T0)).toBe(true);
    expect(store.sweep(T0 + 11 * MIN)).toBe(true);
    expect(store.snapshot(1, T0 + 11 * MIN).activeEews.length).toBe(0);
  });

  it("変化のない sweep は false を返す", () => {
    const store = new DisplayStateStore();
    expect(store.sweep(T0)).toBe(false);
    expect(store.applyEvent(eewDto({}), T0)).toBe(true);
    expect(store.sweep(T0 + 1_000)).toBe(false);
    expect(store.snapshot(1, T0 + 1_000).activeEews.length).toBe(1);
  });
});

describe("DisplayStateStore: largeQuakes / recentQuakes", () => {
  it("largeQuake DTO が largeQuakes と recentQuakes 両方に載る", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({}), T0)).toBe(true);
    const snap = store.snapshot(1, T0);
    expect(snap.largeQuakes.length).toBe(1);
    expect(snap.largeQuakes[0]).toMatchObject({ eventId: "Q1", maxInt: "5強" });
    expect(snap.recentQuakes.length).toBe(1);
    expect(snap.recentQuakes[0].eventId).toBe("Q1");
  });

  it("同一 eventId の続報 (VXSE51→53) は largeQuakes を置換し recentQuakes を重複させない", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "5強" }), T0)).toBe(true);
    expect(store.applyEvent(quakeDto({ maxInt: "6弱", reportDateTime: "2026-07-06T21:05:00+09:00" }), T0 + 5 * MIN)).toBe(true);
    const snap = store.snapshot(1, T0 + 5 * MIN);
    expect(snap.largeQuakes.length).toBe(1);
    expect(snap.largeQuakes[0].maxInt).toBe("6弱");
    expect(snap.recentQuakes.length).toBe(1);
    expect(snap.recentQuakes[0].maxInt).toBe("6弱");
  });

  it("LARGE_QUAKE_HOLD_MIN 経過で sweep が largeQuakes から除去する (recentQuakes には残る)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({}), T0)).toBe(true);
    expect(store.sweep(T0 + 11 * MIN)).toBe(true);
    const snap = store.snapshot(1, T0 + 11 * MIN);
    expect(snap.largeQuakes.length).toBe(0);
    expect(snap.recentQuakes.length).toBe(1);
    expect(snap.recentQuakes[0].eventId).toBe("Q1");
  });

  it("recentQuakes は RECENT_QUAKES_MAX 件で新しい順に丸める", () => {
    const store = new DisplayStateStore();
    for (let i = 1; i <= 6; i++) {
      expect(store.applyEvent(quakeDto({ eventId: `Q${i}` }), T0 + i * MIN)).toBe(true);
    }
    const snap = store.snapshot(1, T0 + 7 * MIN);
    expect(snap.recentQuakes.length).toBe(5);
    expect(snap.recentQuakes.map((q) => q.eventId)).toEqual(["Q6", "Q5", "Q4", "Q3", "Q2"]);
  });

  it("JST 日付が変わる sweep で前日分だけを recentQuakes から除く", () => {
    const store = new DisplayStateStore();
    const beforeMidnight = Date.parse("2026-07-06T23:59:00+09:00");
    expect(store.applyEvent(quakeDto({ reportDateTime: "2026-07-06T23:59:00+09:00" }), beforeMidnight)).toBe(true);
    expect(store.sweep(Date.parse("2026-07-07T00:00:01+09:00"))).toBe(true);
    expect(store.snapshot(1, Date.parse("2026-07-07T00:00:01+09:00")).recentQuakes).toEqual([]);
  });
});

describe("DisplayStateStore: 津波", () => {
  it("津波 DTO で tsunami state が立つ", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({ level: "majorWarning" }), T0)).toBe(true);
    const snap = store.snapshot(1, T0);
    expect(snap.tsunami).toMatchObject({
      level: "majorWarning", levelLabel: "大津波警報", updatedAtMs: T0,
    });
  });

  it("津波は時間経過だけでは sweep で消えない", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    expect(store.sweep(T0 + 11 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 11 * MIN).tsunami).toMatchObject({ level: "warning", updatedAtMs: T0 });
  });

  it("継続中の津波は続報 DTO で更新される", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    const rdt = "2026-07-06T21:15:00+09:00";
    expect(store.applyEvent(tsunamiDto({ reportDateTime: rdt }), T0 + 15 * MIN)).toBe(true);
    const snap = store.snapshot(1, T0 + 15 * MIN);
    expect(snap.tsunami).toMatchObject({ updatedAtMs: T0 + 15 * MIN, reportDateTime: rdt });
  });

  it("VTSE41 の取消/全解除 DTO (emergency null) で tsunami が消える", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    expect(store.applyEvent(tsunamiDto({ hasEmergency: false }), T0 + 5 * MIN)).toBe(true);
    expect(store.snapshot(1, T0 + 5 * MIN).tsunami).toBeNull();
    // すでに消えている状態への全解除は変化なし
    expect(store.applyEvent(tsunamiDto({ hasEmergency: false }), T0 + 6 * MIN)).toBe(false);
  });

  it("VTSE41 以外の津波電文 (VTSE51 続報など emergency null の DTO) では tsunami 状態が消えない", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    // 発表中に VTSE51 (津波情報) を流しても state 維持
    expect(store.applyEvent(tsunamiDto({ type: "VTSE51", hasEmergency: false }), T0 + 5 * MIN)).toBe(false);
    const snap = store.snapshot(1, T0 + 5 * MIN);
    expect(snap.tsunami).toMatchObject({ level: "warning", updatedAtMs: T0 });
  });

  it("VTSE51 の観測到着で observations だけ更新される (level/coasts/levelLabel は VTSE41 のまま)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({ level: "warning" }), T0)).toBe(true);
    const obs: DisplayTsunamiObservationV1[] = [
      {
        areaName: "千葉県九十九里・外房", areaKind: "津波警報", stationName: "銚子",
        arrivalTime: "2026-07-06T21:10:00+09:00", initial: "押し", maxHeightValue: "1.2m", condition: "観測中",
      },
    ];
    expect(store.applyEvent(tsunamiDto({ type: "VTSE51", hasEmergency: false }), T0 + 5 * MIN, obs)).toBe(true);
    const snap = store.snapshot(1, T0 + 5 * MIN);
    expect(snap.tsunami).toMatchObject({
      level: "warning", levelLabel: "津波警報", updatedAtMs: T0,
    });
    expect(snap.tsunami?.observations).toEqual(obs);
  });

  it("VTSE52 (沖合観測) も同様に observations だけ更新する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({ level: "majorWarning" }), T0)).toBe(true);
    const obs: DisplayTsunamiObservationV1[] = [
      {
        areaName: null, areaKind: null, stationName: "岩手沖90kmA",
        arrivalTime: "2026-07-06T21:05:00+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
      },
    ];
    expect(store.applyEvent(tsunamiDto({ type: "VTSE52", hasEmergency: false }), T0 + 2 * MIN, obs)).toBe(true);
    const snap = store.snapshot(1, T0 + 2 * MIN);
    expect(snap.tsunami?.observations).toEqual(obs);
    expect(snap.tsunami?.level).toBe("majorWarning"); // level は不変
  });

  it("this.tsunami が null のとき VTSE51/52 単独 (観測付き) では state を新規作成しない", () => {
    const store = new DisplayStateStore();
    const obs: DisplayTsunamiObservationV1[] = [
      {
        areaName: null, areaKind: null, stationName: "日向灘沖GPS波浪計",
        arrivalTime: null, initial: null, maxHeightValue: null, condition: "観測中",
      },
    ];
    expect(store.applyEvent(tsunamiDto({ type: "VTSE51", hasEmergency: false }), T0, obs)).toBe(false);
    expect(store.snapshot(1, T0).tsunami).toBeNull();
    expect(store.applyEvent(tsunamiDto({ type: "VTSE52", hasEmergency: false }), T0, obs)).toBe(false);
    expect(store.snapshot(2, T0).tsunami).toBeNull();
  });

  it("VTSE51/52 で observations が空配列/未指定なら merge は no-op (false を返す)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    expect(store.applyEvent(tsunamiDto({ type: "VTSE51", hasEmergency: false }), T0 + 1 * MIN)).toBe(false);
    expect(store.applyEvent(tsunamiDto({ type: "VTSE51", hasEmergency: false }), T0 + 2 * MIN, [])).toBe(false);
  });

  it("VTSE51/52 は観測点コード単位で新 revision を merge し、部分報と遅延旧報で既存観測を失わない", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    const station = (
      stationCode: string,
      stationName: string,
      maxHeightValue: string,
    ): DisplayTsunamiObservationV1 => ({
      areaName: "岩手県",
      areaKind: "津波警報",
      stationCode,
      stationName,
      arrivalTime: null,
      initial: null,
      maxHeightValue,
      condition: "重要",
    });

    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:05:00+09:00",
        serial: "1",
      }),
      T0 + 5 * MIN,
      [station("21001", "宮古", "1.0m"), station("21002", "大船渡", "1.2m")],
    )).toBe(true);

    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:10:00+09:00",
        serial: "2",
      }),
      T0 + 10 * MIN,
      [station("21001", "宮古（更新名）", "2.0m")],
    )).toBe(true);
    expect(store.snapshot(1, T0 + 10 * MIN).tsunami?.observations).toEqual([
      station("21001", "宮古（更新名）", "2.0m"),
      station("21002", "大船渡", "1.2m"),
    ]);

    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:04:00+09:00",
        serial: "0",
      }),
      T0 + 11 * MIN,
      [station("21001", "宮古（旧報）", "0.5m"), station("99999", "旧報だけの点", "9.9m")],
    )).toBe(false);
    expect(store.snapshot(2, T0 + 11 * MIN).tsunami?.observations).toEqual([
      station("21001", "宮古（更新名）", "2.0m"),
      station("21002", "大船渡", "1.2m"),
    ]);
  });

  it("Code なしの観測点へ Code 付き続報が来たら fallback 行を key 昇格して置換する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    const legacy: DisplayTsunamiObservationV1 = {
      areaName: "岩手県",
      areaKind: "津波警報",
      stationCode: null,
      stationName: "宮古",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "１．０ｍ",
      condition: "重要",
    };
    const coded = {
      ...legacy,
      stationCode: "21001",
      maxHeightValue: "１．２ｍ",
    };

    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:05:00+09:00",
        serial: "1",
      }),
      T0 + 5 * MIN,
      [legacy],
    )).toBe(true);
    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:10:00+09:00",
        serial: "2",
      }),
      T0 + 10 * MIN,
      [coded],
    )).toBe(true);

    expect(store.snapshot(1, T0 + 10 * MIN).tsunami?.observations).toEqual([coded]);
  });

  it("旧 snapshot の Code なし観測点も Code 付き続報で二重化しない", () => {
    const store = new DisplayStateStore();
    const legacy: DisplayTsunamiObservationV1 = {
      areaName: "岩手県",
      areaKind: "津波警報",
      stationCode: null,
      stationName: "宮古",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "１．０ｍ",
      condition: "重要",
    };
    const coded = {
      ...legacy,
      stationCode: "21001",
      maxHeightValue: "１．２ｍ",
    };
    store.seedTsunami({
      kind: "tsunami",
      level: "warning",
      levelLabel: "津波警報",
      coasts: [],
      warningComment: null,
      observations: [legacy],
      reportDateTime: "2026-07-06T21:00:00+09:00",
    }, T0);

    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:10:00+09:00",
        serial: "2",
      }),
      T0 + 10 * MIN,
      [coded],
    )).toBe(true);

    expect(store.snapshot(1, T0 + 10 * MIN).tsunami?.observations).toEqual([coded]);
  });

  it("VTSE51 と VTSE52 は独立した revision 系列として、報告時刻が前後しても別観測点を保持する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(tsunamiDto({}), T0)).toBe(true);
    const coastal: DisplayTsunamiObservationV1 = {
      areaName: "岩手県",
      areaKind: "津波警報",
      stationCode: "21003",
      stationName: "釜石",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "３．２ｍ",
      condition: "重要",
    };
    const offshore: DisplayTsunamiObservationV1 = {
      areaName: null,
      areaKind: null,
      stationCode: "21050",
      stationName: "岩手沖９０ｋｍＡ",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "０．５ｍ",
      condition: "重要",
    };
    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE51",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:10:00+09:00",
        serial: "3",
      }),
      T0 + 10 * MIN,
      [coastal],
    )).toBe(true);
    expect(store.applyEvent(
      tsunamiDto({
        type: "VTSE52",
        hasEmergency: false,
        reportDateTime: "2026-07-06T21:05:00+09:00",
        serial: "2",
      }),
      T0 + 11 * MIN,
      [offshore],
    )).toBe(true);
    expect(store.snapshot(1, T0 + 11 * MIN).tsunami?.observations).toEqual([
      coastal,
      offshore,
    ]);
  });

  it("seedTsunami で起動時復元できる", () => {
    const store = new DisplayStateStore();
    store.seedTsunami({
      kind: "tsunami", level: "advisory", levelLabel: "津波注意報",
      coasts: [{ name: "伊豆諸島", kind: "津波注意報", maxHeight: null, firstHeight: null }],
      warningComment: null, observations: [],
      reportDateTime: "2026-07-06T20:30:00+09:00",
    }, T0);
    const snap = store.snapshot(1, T0);
    expect(snap.tsunami).toMatchObject({ level: "advisory", updatedAtMs: T0 });
    expect(store.sweep(T0 + 11 * MIN)).toBe(false);
    expect(store.snapshot(2, T0 + 11 * MIN).tsunami?.level).toBe("advisory");
  });
});

describe("DisplayStateStore: latestQuake", () => {
  it("震度4 の新規地震で latestQuake が載る", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "4", maxIntRank: 4 }), T0)).toBe(true);
    const snap = store.snapshot(1, T0);
    expect(snap.latestQuake?.maxInt).toBe("4");
  });

  it("震度5弱カードの TTL 中でも震度2 の別地震で最新カードを置換する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ eventId: "Q1", maxInt: "5弱", maxIntRank: 5 }), T0)).toBe(true);
    store.applyEvent(
      quakeDto({ eventId: "Q2", maxInt: "2", maxIntRank: 2, reportDateTime: "2026-07-06T21:20:00+09:00" }),
      T0 + 20 * MIN,
    );
    const snap = store.snapshot(1, T0 + 20 * MIN);
    expect(snap.latestQuake?.maxInt).toBe("2");
    expect(snap.latestQuake?.eventId).toBe("Q2");
  });

  it("eventId=null は別イベントとして latestQuake を置換する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(latestQuakeOnlyDto({ eventId: "Q1", maxInt: "5弱", maxIntRank: 5 }), T0)).toBe(true);
    expect(store.applyEvent(latestQuakeOnlyDto({
      eventId: null, maxInt: "2", maxIntRank: 2, reportDateTime: "2026-07-06T21:01:00+09:00",
    }), T0 + MIN)).toBe(true);
    expect(store.snapshot(1, T0 + MIN).latestQuake).toMatchObject({ eventId: null, maxInt: "2" });
  });

  it("震度5弱カードの 31 分後 sweep で latestQuake が消える", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "5弱", maxIntRank: 5 }), T0)).toBe(true);
    expect(store.sweep(T0 + 31 * MIN)).toBe(true);
    expect(store.snapshot(1, T0 + 31 * MIN).latestQuake).toBeNull();
  });

  it("震度3カードの 6 分後 sweep ではまだ生存する (TTL 15分)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "3", maxIntRank: 3 }), T0)).toBe(true);
    expect(store.sweep(T0 + 6 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 6 * MIN).latestQuake?.maxInt).toBe("3");
  });

  it("弱い地震の後に強い別地震が到着すると最新カードを置換する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ eventId: "Q1", maxInt: "2", maxIntRank: 2 }), T0)).toBe(true);
    const changed = store.applyEvent(
      quakeDto({ eventId: "Q2", maxInt: "5弱", maxIntRank: 5, reportDateTime: "2026-07-06T21:10:00+09:00" }),
      T0 + 10 * MIN,
    );
    expect(changed).toBe(true);
    const snap = store.snapshot(1, T0 + 10 * MIN);
    expect(snap.latestQuake?.eventId).toBe("Q2");
    expect(snap.latestQuake?.maxInt).toBe("5弱");
  });

  it("同一 eventId の続報は震度が下方修正されても常に置換する (I-1)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ eventId: "Q1", maxInt: "5弱", maxIntRank: 5 }), T0)).toBe(true);
    store.applyEvent(
      quakeDto({ eventId: "Q1", maxInt: "4", maxIntRank: 4, reportDateTime: "2026-07-06T21:05:00+09:00" }),
      T0 + 5 * MIN,
    );
    const snap = store.snapshot(1, T0 + 5 * MIN);
    expect(snap.latestQuake?.maxInt).toBe("4");
  });

  it("高ランクカード失効後は低ランク新地震で置換される (expired × severity 交差)", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ eventId: "Q1", maxInt: "5弱", maxIntRank: 5 }), T0)).toBe(true);
    store.applyEvent(
      quakeDto({ eventId: "Q2", maxInt: "2", maxIntRank: 2, reportDateTime: "2026-07-06T21:31:00+09:00" }),
      T0 + 31 * MIN,
    );
    const snap = store.snapshot(1, T0 + 31 * MIN);
    expect(snap.latestQuake?.eventId).toBe("Q2");
    expect(snap.latestQuake?.maxInt).toBe("2");
  });

  it("maxIntRank=null の入力は TTL=LOW・最低ランク扱いになる", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ eventId: "Q1", maxInt: "不明", maxIntRank: null }), T0)).toBe(true);
    expect(store.sweep(T0 + 4 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 4 * MIN).latestQuake?.maxInt).toBe("不明");
    expect(store.sweep(T0 + 6 * MIN)).toBe(true);
    expect(store.snapshot(2, T0 + 6 * MIN).latestQuake).toBeNull();
  });

  it("低ランク帯 (震度1-2) は 5 分超の sweep で失効する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "1", maxIntRank: 1 }), T0)).toBe(true);
    expect(store.sweep(T0 + 4 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 4 * MIN).latestQuake?.maxInt).toBe("1");
    expect(store.sweep(T0 + 6 * MIN)).toBe(true);
    expect(store.snapshot(2, T0 + 6 * MIN).latestQuake).toBeNull();
  });

  it("低ランクカードは TTL 境界では残り、境界を越えると sweep で失効する", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(quakeDto({ maxInt: "2", maxIntRank: 2 }), T0)).toBe(true);
    expect(store.sweep(T0 + 5 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 5 * MIN).latestQuake?.eventId).toBe("Q1");
    expect(store.sweep(T0 + 5 * MIN + 1)).toBe(true);
    expect(store.snapshot(2, T0 + 5 * MIN + 1).latestQuake).toBeNull();
  });

  it("取消電文は保持中の latestQuake を置換しない", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(latestQuakeOnlyDto({ eventId: "Q1" }), T0)).toBe(true);
    expect(store.applyEvent(latestQuakeOnlyDto({
      eventId: "Q1", isCancellation: true, reportDateTime: "2026-07-06T21:01:00+09:00",
    }), T0 + MIN)).toBe(false);
    expect(store.snapshot(1, T0 + MIN).latestQuake?.eventId).toBe("Q1");
  });
});

describe("DisplayStateStore: severityTier", () => {
  it("空 state は calm", () => {
    const store = new DisplayStateStore();
    expect(store.snapshot(1, T0).severityTier).toBe("calm");
  });

  it("津波注意報は caution", () => {
    const store = new DisplayStateStore();
    store.applyEvent(tsunamiDto({ level: "advisory" }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("caution");
  });

  it("津波警報は alert", () => {
    const store = new DisplayStateStore();
    store.applyEvent(tsunamiDto({ level: "warning" }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("alert");
  });

  it("大津波警報は critical", () => {
    const store = new DisplayStateStore();
    store.applyEvent(tsunamiDto({ level: "majorWarning" }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("critical");
  });

  it("EEW 警報は alert", () => {
    const store = new DisplayStateStore();
    store.applyEvent(eewDto({}), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("alert");
  });

  it("震度5弱の latestQuake は alert", () => {
    const store = new DisplayStateStore();
    store.applyEvent(latestQuakeOnlyDto({ maxInt: "5弱", maxIntRank: 5 }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("alert");
  });

  it("大津波警報 + 震度5弱 併存は critical (最大採用)", () => {
    const store = new DisplayStateStore();
    store.applyEvent(tsunamiDto({ level: "majorWarning" }), T0);
    store.applyEvent(latestQuakeOnlyDto({ maxInt: "5弱", maxIntRank: 5 }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("critical");
  });

  it("大津波警報は時間が経過しても critical のまま (公式レベルにのみ従う)", () => {
    const store = new DisplayStateStore();
    store.applyEvent(tsunamiDto({ level: "majorWarning" }), T0);
    expect(store.sweep(T0 + 11 * MIN)).toBe(false);
    expect(store.snapshot(1, T0 + 11 * MIN).tsunami?.level).toBe("majorWarning");
    expect(store.snapshot(2, T0 + 11 * MIN).severityTier).toBe("critical");
  });

  it("largeQuakes 由来 (latestQuake 不在) でも震度5弱以上は alert", () => {
    const store = new DisplayStateStore();
    store.applyEvent(largeQuakeOnlyDto({ maxInt: "5弱", maxIntRank: 5 }), T0);
    const snap = store.snapshot(1, T0);
    expect(snap.latestQuake).toBeNull();
    expect(snap.largeQuakes.length).toBe(1);
    expect(snap.severityTier).toBe("alert");
  });

  it("EEW 予報 (isWarning=false) は caution", () => {
    const store = new DisplayStateStore();
    store.applyEvent(eewDto({ isWarning: false }), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("caution");
  });
});

describe("activeAlertKeys (spec §3-2)", () => {
  it("active な EEW / tsunami の groupKey を返す", () => {
    const store = new DisplayStateStore();
    store.applyEvent(eewDto({ eventId: "E1" }), T0);
    store.applyEvent(tsunamiDto({ hasEmergency: true, level: "warning" }), T0);
    const keys = store.activeAlertKeys();
    expect(keys.has("eew:E1")).toBe(true);
    expect(keys.has("tsunami:current")).toBe(true);
  });

  it("active な警報が無ければ空集合", () => {
    expect(new DisplayStateStore().activeAlertKeys().size).toBe(0);
  });
});

describe("DisplayStateStore: connection / weatherAlerts / snapshot", () => {
  it("setConnection が状態を patch し disconnectedSince を管理する", () => {
    const store = new DisplayStateStore();
    expect(store.snapshot(1, T0).connection).toEqual({
      dmdata: "connecting", lastReceivedAt: null, disconnectedSince: null, reason: null,
    });

    store.setConnection({ dmdata: "connected", lastReceivedAt: new Date(T0).toISOString() }, T0);
    expect(store.snapshot(2, T0).connection).toMatchObject({
      dmdata: "connected", disconnectedSince: null, reason: null,
    });

    store.setConnection({ dmdata: "disconnected", reason: "socket closed" }, T0 + MIN);
    let conn = store.snapshot(3, T0 + MIN).connection;
    expect(conn).toMatchObject({
      dmdata: "disconnected", disconnectedSince: new Date(T0 + MIN).toISOString(), reason: "socket closed",
    });
    expect(conn.lastReceivedAt).toBe(new Date(T0).toISOString());

    // 切断中の再 disconnected patch は disconnectedSince を上書きしない
    store.setConnection({ dmdata: "disconnected", reason: "retry failed" }, T0 + 3 * MIN);
    conn = store.snapshot(4, T0 + 3 * MIN).connection;
    expect(conn.disconnectedSince).toBe(new Date(T0 + MIN).toISOString());
    expect(conn.reason).toBe("retry failed");

    // 再接続で disconnectedSince / reason がクリアされる
    store.setConnection({ dmdata: "connected" }, T0 + 5 * MIN);
    expect(store.snapshot(5, T0 + 5 * MIN).connection).toMatchObject({
      dmdata: "connected", disconnectedSince: null, reason: null,
    });
  });

  it("seedWeatherAlerts が snapshot に載る", () => {
    const store = new DisplayStateStore();
    const alerts: DisplayWeatherAlertV1[] = [{
      source: "vpws50", label: "大雨警報", role: "weatherWarning", totalAreas: 3,
      items: [{
        kind: "大雨警報",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["千葉県北西部", "千葉県北東部", "千葉県南部"],
        omittedAreaCount: 0,
      }],
      updatedAt: "2026-07-06T20:00:00+09:00",
    }];
    store.seedWeatherAlerts(alerts);
    expect(store.snapshot(1, T0).weatherAlerts).toEqual(alerts);
    // 再 seed で全置換される (VPWS50 は毎回全量)
    store.seedWeatherAlerts([]);
    expect(store.snapshot(2, T0).weatherAlerts).toEqual([]);
  });

  it("snapshot が version/seq/generatedAt を持ち、activeEews を配列で返す", () => {
    const store = new DisplayStateStore();
    expect(store.applyEvent(eewDto({}), T0)).toBe(true);
    const snap = store.snapshot(42, T0 + 1_000);
    expect(snap.version).toBe(DISPLAY_PROTOCOL_VERSION);
    expect(snap.seq).toBe(42);
    expect(snap.generatedAt).toBe(new Date(T0 + 1_000).toISOString());
    expect(Array.isArray(snap.activeEews)).toBe(true);
    expect(snap.activeEews.length).toBe(1);
    expect(snap.recentTicker).toEqual([]); // hub が埋めるので store は空のまま
  });

  it("setStats が snapshot.stats に反映される", () => {
    const store = new DisplayStateStore();
    expect(store.snapshot(1, T0).stats).toBeNull();
    store.setStats({ sparklineData: [1, 2], totalReceived: 5, todayQuakeCount: 1, todayMaxInt: "3", todayMaxIntRank: 3 });
    expect(store.snapshot(2, T0).stats?.totalReceived).toBe(5);
  });
});
