import { describe, it, expect, beforeEach } from "vitest";
import { SummaryWindowTracker } from "../../../src/engine/messages/summary-tracker";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

/** テスト用の最小限 PresentationEvent を生成する */
function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-001",
    classification: "telegram.earthquake",
    domain: "earthquake",
    type: "VXSE53",
    infoType: "発表",
    title: "震源・震度に関する情報",
    headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "normal",
    isCancellation: false,
    maxInt: null,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

describe("SummaryWindowTracker", () => {
  let tracker: SummaryWindowTracker;

  beforeEach(() => {
    tracker = new SummaryWindowTracker();
  });

  it("record → getSnapshot で件数が合う", () => {
    const now = Date.now();
    const event = makeEvent({ domain: "earthquake" });

    tracker.record(event, true, now);
    tracker.record(event, true, now);
    tracker.record(event, false, now);

    const snap = tracker.getSnapshot(now);
    expect(snap.totalReceived).toBe(3);
    expect(snap.totalMatched).toBe(2);
    expect(snap.byDomain["earthquake"]).toBe(3);
  });

  it("ドメイン別にカウントされる", () => {
    const now = Date.now();
    tracker.record(makeEvent({ domain: "eew" }), true, now);
    tracker.record(makeEvent({ domain: "eew" }), true, now);
    tracker.record(makeEvent({ domain: "tsunami" }), true, now);

    const snap = tracker.getSnapshot(now);
    expect(snap.byDomain["eew"]).toBe(2);
    expect(snap.byDomain["tsunami"]).toBe(1);
    expect(snap.totalReceived).toBe(3);
  });

  it("30分超のバケットが除去される", () => {
    const MINUTE_MS = 60_000;
    const base = Date.now();

    // 35分前のイベント
    tracker.record(makeEvent(), true, base - 35 * MINUTE_MS);
    // 10分前のイベント
    tracker.record(makeEvent(), true, base - 10 * MINUTE_MS);
    // 現在のイベント
    tracker.record(makeEvent(), true, base);

    const snap = tracker.getSnapshot(base);
    // 35分前のバケットは除去される
    expect(snap.totalReceived).toBe(2);
  });

  it("sparklineData が30スロットの長さを持つ", () => {
    const now = Date.now();
    tracker.record(makeEvent(), true, now);

    const snap = tracker.getSnapshot(now);
    expect(snap.sparklineData).toHaveLength(30);
  });

  it("sparklineData の最新スロットに件数が反映される", () => {
    const now = Date.now();
    tracker.record(makeEvent(), true, now);
    tracker.record(makeEvent(), true, now);

    const snap = tracker.getSnapshot(now);
    // 最新スロット (index 29) に2件
    expect(snap.sparklineData[29]).toBe(2);
  });

  it("maxInt が最大震度を追跡する", () => {
    const now = Date.now();
    tracker.record(makeEvent({ maxInt: "3" }), true, now);
    tracker.record(makeEvent({ maxInt: "5弱" }), true, now);
    tracker.record(makeEvent({ maxInt: "4" }), true, now);

    const snap = tracker.getSnapshot(now);
    expect(snap.maxIntSeen).toBe("5弱");
  });

  it("maxInt が null のイベントでは更新されない", () => {
    const now = Date.now();
    tracker.record(makeEvent({ maxInt: null }), true, now);

    const snap = tracker.getSnapshot(now);
    expect(snap.maxIntSeen).toBeNull();
  });

  it("clear() で全統計がリセットされる", () => {
    const now = Date.now();
    tracker.record(makeEvent({ maxInt: "5弱" }), true, now);

    tracker.clear();

    const snap = tracker.getSnapshot(now);
    expect(snap.totalReceived).toBe(0);
    expect(snap.totalMatched).toBe(0);
    expect(snap.maxIntSeen).toBeNull();
    expect(Object.keys(snap.byDomain)).toHaveLength(0);
  });

  it("異なる分のバケットに分散される", () => {
    const MINUTE_MS = 60_000;
    const base = Date.now();

    tracker.record(makeEvent(), true, base - 5 * MINUTE_MS);
    tracker.record(makeEvent(), true, base - 5 * MINUTE_MS);
    tracker.record(makeEvent(), true, base);

    const snap = tracker.getSnapshot(base);
    expect(snap.totalReceived).toBe(3);
    // sparklineData の該当スロットにそれぞれ反映
    expect(snap.sparklineData[29]).toBe(1);
    expect(snap.sparklineData[24]).toBe(2);
  });
});
