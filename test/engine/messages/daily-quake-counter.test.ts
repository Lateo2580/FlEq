import { describe, expect, it } from "vitest";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import type { DisplayRecentQuakeV1 } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "id-1",
    classification: "telegram.earthquake",
    domain: "earthquake",
    type: "VXSE51",
    infoType: "発表",
    title: "震源・震度に関する情報",
    headline: null,
    reportDateTime: "2026-07-08T12:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "warning",
    isCancellation: false,
    eventId: "event-1",
    maxInt: "3",
    ...overrides,
  } as PresentationEvent;
}

// 2026-07-08T12:00:00+09:00 (JST) を UTC ミリ秒に変換
const NOON_JST_JUL8 = Date.parse("2026-07-08T12:00:00+09:00");

function recentQuake(over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: "event-1",
    reportDateTime: "2026-07-08T12:00:00+09:00",
    originTime: "2026-07-08T11:59:00+09:00",
    hypocenterName: "初期震源",
    magnitude: "4.8",
    maxInt: "4",
    maxIntRank: 4,
    depth: "10km",
    tsunamiWarning: false,
    intensityGroups: [{
      intensity: "4", rank: 4, areas: ["茨城県北部"], omittedAreaCount: 0,
    }],
    ...over,
  };
}

describe("DailyQuakeCounter", () => {
  it.each(["VXSE52", "VXSE61"])(
    "VXSE51→%s 相当の同一EventID履歴は震度を保持し、震源諸元を更新する",
    () => {
      const counter = new DailyQuakeCounter(NOON_JST_JUL8);
      counter.recordRecentQuake(recentQuake(), NOON_JST_JUL8);
      counter.recordRecentQuake(recentQuake({
        reportDateTime: "2026-07-08T12:01:00+09:00",
        hypocenterName: "更新震源",
        magnitude: "5.2",
        depth: "20km",
        maxInt: null,
        maxIntRank: null,
        intensityGroups: [],
      }), NOON_JST_JUL8 + 60_000);

      expect(counter.getRecentQuakes(NOON_JST_JUL8 + 60_000)).toEqual([
        expect.objectContaining({
          eventId: "event-1",
          reportDateTime: "2026-07-08T12:01:00+09:00",
          hypocenterName: "更新震源",
          magnitude: "5.2",
          depth: "20km",
          maxInt: "4",
          maxIntRank: 4,
          intensityGroups: [expect.objectContaining({
            intensity: "4", areas: ["茨城県北部"],
          })],
        }),
      ]);
    },
  );

  it("VXSE52→VXSE51 相当の逆順では後着した観測震度を採用する", () => {
    const counter = new DailyQuakeCounter(NOON_JST_JUL8);
    counter.recordRecentQuake(recentQuake({
      maxInt: null,
      maxIntRank: null,
      intensityGroups: [],
    }), NOON_JST_JUL8);
    counter.recordRecentQuake(recentQuake({
      reportDateTime: "2026-07-08T12:01:00+09:00",
    }), NOON_JST_JUL8 + 60_000);

    expect(counter.getRecentQuakes(NOON_JST_JUL8 + 60_000)[0]).toMatchObject({
      maxInt: "4",
      maxIntRank: 4,
      intensityGroups: [{ intensity: "4", areas: ["茨城県北部"] }],
    });
  });

  it("VXSE51→VXSE53 相当のフル観測更新では後続の震度・地域別震度で全置換する", () => {
    const counter = new DailyQuakeCounter(NOON_JST_JUL8);
    counter.recordRecentQuake(recentQuake(), NOON_JST_JUL8);
    counter.recordRecentQuake(recentQuake({
      reportDateTime: "2026-07-08T12:01:00+09:00",
      maxInt: "5弱",
      maxIntRank: 5,
      intensityGroups: [{
        intensity: "5弱", rank: 5, areas: ["茨城県南部"], omittedAreaCount: 0,
      }],
    }), NOON_JST_JUL8 + 60_000);

    expect(counter.getRecentQuakes(NOON_JST_JUL8 + 60_000)[0]).toMatchObject({
      maxInt: "5弱",
      maxIntRank: 5,
      intensityGroups: [{ intensity: "5弱", areas: ["茨城県南部"] }],
    });
  });

  it("別 eventId の地震 2 件を数え、maxInt は大きい方を採用する", () => {
    const counter = new DailyQuakeCounter();
    counter.record(makeEvent({ eventId: "event-1", maxInt: "3" }), NOON_JST_JUL8);
    counter.record(makeEvent({ eventId: "event-2", maxInt: "5弱" }), NOON_JST_JUL8);

    const snapshot = counter.getSnapshot(NOON_JST_JUL8);
    expect(snapshot.todayQuakeCount).toBe(2);
    expect(snapshot.todayMaxInt).toBe("5弱");
    expect(snapshot.todayMaxIntRank).toBe(5);
  });

  it("同一 eventId の続報は件数を増やさず maxInt だけ更新する", () => {
    const counter = new DailyQuakeCounter();
    counter.record(makeEvent({ eventId: "event-1", maxInt: "3" }), NOON_JST_JUL8);
    counter.record(makeEvent({ eventId: "event-1", maxInt: "4" }), NOON_JST_JUL8);

    const snapshot = counter.getSnapshot(NOON_JST_JUL8);
    expect(snapshot.todayQuakeCount).toBe(1);
    expect(snapshot.todayMaxInt).toBe("4");
  });

  it("非地震 event は件数に数えない", () => {
    const counter = new DailyQuakeCounter();
    counter.record(makeEvent({ domain: "tsunami", eventId: "event-1", maxInt: "3" }), NOON_JST_JUL8);

    const snapshot = counter.getSnapshot(NOON_JST_JUL8);
    expect(snapshot.todayQuakeCount).toBe(0);
    expect(snapshot.todayMaxInt).toBeNull();
    expect(snapshot.todayMaxIntRank).toBeNull();
  });

  it("取消 event は件数に数えない", () => {
    const counter = new DailyQuakeCounter();
    counter.record(makeEvent({ eventId: "event-1", maxInt: "3", isCancellation: true }), NOON_JST_JUL8);

    const snapshot = counter.getSnapshot(NOON_JST_JUL8);
    expect(snapshot.todayQuakeCount).toBe(0);
  });

  it("eventId が null の地震は 1 件として計上する", () => {
    const counter = new DailyQuakeCounter();
    counter.record(makeEvent({ eventId: null, maxInt: "2" }), NOON_JST_JUL8);
    counter.record(makeEvent({ eventId: null, maxInt: "2" }), NOON_JST_JUL8);

    const snapshot = counter.getSnapshot(NOON_JST_JUL8);
    expect(snapshot.todayQuakeCount).toBe(2);
  });

  it("JST 0 時を跨ぐとカウントがリセットされる (23:59 → 翌 00:01)", () => {
    const counter = new DailyQuakeCounter();
    const before = Date.parse("2026-07-08T23:59:00+09:00");
    const after = Date.parse("2026-07-09T00:01:00+09:00");

    counter.record(makeEvent({ eventId: "event-1", maxInt: "5弱" }), before);
    expect(counter.getSnapshot(before).todayQuakeCount).toBe(1);

    counter.record(makeEvent({ eventId: "event-2", maxInt: "3" }), after);
    const snapshot = counter.getSnapshot(after);
    expect(snapshot.todayQuakeCount).toBe(1);
    expect(snapshot.todayMaxInt).toBe("3");
  });

  it("UTC 15:00 (= JST 翌 0 時) の境界でリセットされる", () => {
    const counter = new DailyQuakeCounter();
    const beforeBoundary = Date.parse("2026-07-08T14:59:59.999Z"); // JST 23:59:59.999
    const atBoundary = Date.parse("2026-07-08T15:00:00.000Z"); // JST 翌 00:00:00.000

    counter.record(makeEvent({ eventId: "event-1", maxInt: "4" }), beforeBoundary);
    expect(counter.getSnapshot(beforeBoundary).todayQuakeCount).toBe(1);

    const snapshot = counter.getSnapshot(atBoundary);
    expect(snapshot.todayQuakeCount).toBe(0);
    expect(snapshot.todayMaxInt).toBeNull();
  });
});
