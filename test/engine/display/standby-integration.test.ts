import { describe, expect, it } from "vitest";
import { partitionStandbyItems, selectRightStack } from "../../../display/frontend/src/lib/standby-cards";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const iso = (timeMs = T0): string => new Date(timeMs).toISOString();
const event = (over: Record<string, unknown>): PresentationEvent => ({
  id: "event", domain: "heatAlert", eventId: null, serial: "1", reportDateTime: iso(), isCancellation: false,
  title: "情報", areaItems: [], raw: null, ...over,
} as unknown as PresentationEvent);

function heat(serial = "1", timeMs = T0): PresentationEvent {
  return event({ id: `heat-${serial}`, domain: "heatAlert", serial, reportDateTime: iso(timeMs), title: "熱中症警戒アラート", raw: {
    type: "VPFT50", infoType: "発表", targetDateTime: iso(T0), serial, targetAreaName: "東京都",
  } });
}

function typhoon(key = "TC-1", serial = "1", timeMs = T0): PresentationEvent {
  return event({ id: `${key}-${serial}`, domain: "typhoonAnalysis", eventId: key, serial, reportDateTime: iso(timeMs), raw: {
    eventId: key, serial, infoType: "発表", name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
    frames: [{ kind: "実況", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 25 } }],
  } });
}

function volcano(timeMs = T0): PresentationEvent {
  return event({ id: "volcano-1", domain: "volcano", serial: "1", reportDateTime: iso(timeMs), raw: {
    kind: "alert", type: "VFVO50", infoType: "発表", volcanoCode: "V-1", volcanoName: "テスト山", alertLevel: 4, alertLevelCode: "4", previousLevelCode: "3",
  } });
}

function expiringVolcano(timeMs = T0): PresentationEvent {
  return event({ id: "volcano-flash", domain: "volcano", serial: "1", reportDateTime: iso(timeMs), raw: {
    kind: "eruption", type: "VFVO52", infoType: "発表", volcanoCode: "V-1", volcanoName: "テスト山", isFlashReport: true, phenomenonName: "噴火速報",
  } });
}

function flood(timeMs = T0): PresentationEvent {
  const rivers = Array.from({ length: 5 }, (_, index) => ({
    stationName: `河川${index + 1}`, stationCode: `station-${index + 1}`, riverNames: [`河川${index + 1}`], primaryRiverCode: `river-${index + 1}`, primaryRiverName: `河川${index + 1}`,
    stationObservedLevel: "L3", headlineLevel: "L3", headlineKindCode: "30",
  }));
  return event({ id: "flood-1", domain: "floodForecast", eventId: "flood-1", serial: "1", reportDateTime: iso(timeMs), raw: {
    schema: "vxko50", infoType: "発表", serial: 1, eventId: "flood-1", publishingOffice: "気象庁", rawStations: rivers,
    headlines: rivers.map((river: { primaryRiverCode: string; primaryRiverName: string }) => ({ scope: "河川", kindCode: "30", kindName: "氾濫警戒情報", areas: [{ name: river.primaryRiverName, code: river.primaryRiverCode }] })),
  } });
}

function tornado(timeMs = T0): PresentationEvent {
  return event({ id: "tornado-1", domain: "tornado", serial: "1", reportDateTime: iso(timeMs), areaItems: [{ name: "東京都" }], raw: {
    serial: "1", activeAreaCount: 1, hasSightingAreas: false, validDateTime: iso(timeMs + 60 * 60_000),
  } });
}

function nankai(timeMs = T0): PresentationEvent {
  return event({ id: "nankai-1", domain: "nankaiTrough", serial: "1", reportDateTime: iso(timeMs), raw: { infoSerial: { code: "120" } } });
}

function longPeriod(timeMs = T0): PresentationEvent {
  return event({ id: "lg-1", domain: "lgObservation", eventId: "quake-1", serial: "1", reportDateTime: iso(timeMs), raw: { maxLgInt: "3" } });
}

function host(timeMs = T0): PresentationEvent {
  return event({ id: "quake-1", domain: "earthquake", eventId: "quake-1", maxIntRank: 4, reportDateTime: iso(timeMs) });
}

describe("standby integration", () => {
  it("0: keeps an empty standby snapshot when no target telegram has arrived", () => {
    const standby = new StandbyStateStore();
    const display = new DisplayStateStore(() => standby.snapshotItems());
    expect(standby.snapshotItems()).toEqual([]);
    expect(display.snapshot(1, T0).standbyItems).toEqual([]);
  });

  it("1: exposes every simultaneous active kind at its assigned surface", () => {
    const store = new StandbyStateStore();
    [heat(), typhoon("TC-1"), typhoon("TC-2"), volcano(), flood(), tornado(), nankai(), longPeriod(), host()].forEach((item) => store.applyEvent(item, T0));
    const items = store.snapshotItems();
    expect(items.map((item) => item.kind)).toEqual(["tornado", "flood", "volcano", "typhoon", "heat", "longPeriod", "nankaiTrough"]);
    expect(items.find((item) => item.kind === "flood")?.surface).toBe("clock-top-wide");
    const partitions = partitionStandbyItems(items);
    const right = selectRightStack(partitions.cornerRight, 90, () => 80);
    expect([...right.visible, ...right.overflow]).toHaveLength(partitions.cornerRight.length);
    expect(partitions.weatherRider).toHaveLength(1);
    expect(partitions.quakeRider).toHaveLength(1);
    expect(partitions.clockBelow).toHaveLength(1);
    expect(partitions.clockTopWide).toHaveLength(1);
  });

  it("2: rejects a reverse-order stale report", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heat("2", T0 + 60_000), T0 + 60_000);
    expect(store.applyEvent(heat("1", T0), T0 + 60_001)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0].updatedAt).toBe(iso(T0 + 60_000));
  });

  it("3: treats duplicate retransmission as a durable no-op", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoon(), T0);
    expect(store.applyEvent(typhoon(), T0 + 1)).toEqual({ viewChanged: false, durableChanged: false });
  });

  it("4: expires every fallback-TTL kind without a cancellation", () => {
    const store = new StandbyStateStore();
    [typhoon(), expiringVolcano(), flood(), tornado(), nankai(), longPeriod(), host()].forEach((item) => store.applyEvent(item, T0));
    store.sweep(T0 + 8 * 24 * 60 * 60_000);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("5: restores only unexpired state and marks it until a live update", () => {
    const source = new StandbyStateStore();
    source.applyEvent(heat(), T0);
    source.applyEvent(typhoon(), T0);
    const restored = new StandbyStateStore();
    restored.restoreActiveState(source.exportActiveState(), T0 + 60_000);
    expect(restored.snapshotItems().every((item) => item.restored)).toBe(true);
    restored.applyEvent(heat("2", T0 + 120_000), T0 + 120_000);
    expect(restored.snapshotItems().find((item) => item.kind === "heat")?.restored).toBe(false);
    const expired = new StandbyStateStore();
    expired.restoreActiveState(source.exportActiveState(), T0 + 25 * 60 * 60_000);
    expect(expired.snapshotItems()).toEqual([]);
  });

  it("6: attaches VXSE62 after its host earthquake arrives", () => {
    const store = new StandbyStateStore();
    store.applyEvent(longPeriod(), T0);
    expect(store.snapshotItems()).toEqual([]);
    store.applyEvent(host(), T0 + 1);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "longPeriod", data: { eventId: "quake-1", maxLgInt: "3" } })]);
  });
});
