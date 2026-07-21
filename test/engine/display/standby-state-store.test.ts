import { describe, expect, it, vi } from "vitest";
import { RevisionGuard, StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { ParsedHeatAlertInfo } from "../../../src/types";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");

function heatRaw(over: Partial<ParsedHeatAlertInfo> = {}): ParsedHeatAlertInfo {
  return {
    type: "VPFT50",
    infoType: "発表",
    title: "東京都熱中症警戒アラート",
    controlTitle: "熱中症警戒アラート",
    reportDateTime: "2026-07-21T05:00:00+09:00",
    targetDateTime: "2026-07-21T05:00:00+09:00",
    headline: null,
    publishingOffice: "環境省 気象庁",
    editorialOffice: "環境省 気象庁",
    eventId: null,
    serial: "1",
    targetAreaName: "東京都",
    notice: null,
    bodyText: null,
    isTest: false,
    ...over,
  };
}

function heatEvent(over: Partial<PresentationEvent> = {}, rawOver: Partial<ParsedHeatAlertInfo> = {}): PresentationEvent {
  const raw = heatRaw(rawOver);
  return {
    id: "heat-1",
    classification: "meteorological",
    domain: "heatAlert",
    type: raw.type,
    infoType: raw.infoType,
    title: raw.title,
    controlTitle: raw.controlTitle,
    headline: raw.headline,
    reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice,
    isTest: raw.isTest,
    frameLevel: "warning",
    isCancellation: raw.infoType === "取消",
    eventId: raw.eventId,
    serial: raw.serial,
    areaNames: raw.targetAreaName == null ? [] : [raw.targetAreaName],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: raw.targetAreaName == null ? 0 : 1,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw,
    ...over,
  };
}

describe("RevisionGuard", () => {
  it("新しい revision だけを受理し、tombstone を期限まで保持する", () => {
    const guard = new RevisionGuard();
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0, serial: "1" }, T0)).toBe(true);
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0, serial: "1" }, T0 + 1)).toBe(false);
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0 - 1, serial: "9" }, T0 + 1)).toBe(false);
    expect(guard.sweep(T0 + 24 * 60 * 60_000 - 1)).toBe(false);
    expect(guard.sweep(T0 + 24 * 60 * 60_000)).toBe(true);
  });
});

describe("StandbyStateStore: heat", () => {
  it("VPFT50 受信でカードが立ち、対象日24:00 JSTで失効する", () => {
    const store = new StandbyStateStore();
    const mutation = store.applyEvent(heatEvent(), T0);
    expect(mutation).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "heat",
        key: "heat:2026-07-21",
        expiresAt: "2026-07-21T15:00:00.000Z",
        restored: false,
        severity: "warning",
        data: { targetDate: "2026-07-21", areas: [{ areaName: "東京都", isSpecial: false }] },
      }),
    ]);
    expect(store.sweep(T0 + 60 * 60_000).viewChanged).toBe(false);
    expect(store.sweep(Date.parse("2026-07-22T00:00:00+09:00"))).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([]);
  });

  it("重複・古い報を破棄し TTL を延長しない", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent(), T0);
    expect(store.applyEvent(heatEvent({}, { serial: "1" }), T0 + 1)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.applyEvent(heatEvent({}, { reportDateTime: "2026-07-21T04:00:00+09:00", serial: "9" }), T0 + 1))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0].expiresAt).toBe("2026-07-21T15:00:00.000Z");
  });

  it("取消で消灯し、取消より古い発表を再送しても復活しない", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent(), T0);
    const cancelTime = T0 + 60_000;
    expect(store.applyEvent(heatEvent({ isCancellation: true }, {
      infoType: "取消", reportDateTime: new Date(cancelTime).toISOString(), serial: "2",
    }), cancelTime).viewChanged).toBe(true);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.applyEvent(heatEvent({}, { serial: "1" }), cancelTime + 1).viewChanged).toBe(false);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("特別警戒タイトルは critical になり、targetDateTime 欠落時は報受信日のJST日末を使う", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent({ title: "熱中症特別警戒アラート" }, { targetDateTime: null }), T0);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ severity: "critical", expiresAt: "2026-07-21T15:00:00.000Z" }));
  });

  it("view/durable の listener は対応する変更時だけ呼ばれる", () => {
    const store = new StandbyStateStore();
    const onChange = vi.fn();
    const onDurable = vi.fn();
    store.onChange(onChange);
    store.onDurable(onDurable);
    store.applyEvent(heatEvent(), T0);
    store.applyEvent(heatEvent(), T0 + 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onDurable).toHaveBeenCalledTimes(1);
  });
});
