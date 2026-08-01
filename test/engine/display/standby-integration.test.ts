import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, expect, it } from "vitest";
import { partitionStandbyItems, selectRightStack } from "../../../display/frontend/src/lib/standby-cards";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { ParsedVolcanoAlertInfo } from "../../../src/types";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const iso = (timeMs = T0): string => new Date(timeMs).toISOString();
const event = (over: Record<string, unknown>): PresentationEvent => ({
  id: "event", domain: "heatAlert", eventId: null, serial: "1", reportDateTime: iso(), isCancellation: false,
  title: "情報", areaItems: [], raw: null, ...over,
} as unknown as PresentationEvent);

function heat(serial = "1", timeMs = T0, areaName = "東京都", cancellation = false): PresentationEvent {
  return event({ id: `heat-${serial}`, domain: "heatAlert", serial, reportDateTime: iso(timeMs), title: "熱中症警戒アラート", raw: {
    type: "VPFT50", infoType: cancellation ? "取消" : "発表", targetDateTime: iso(T0), serial, targetAreaName: areaName,
  }, isCancellation: cancellation, publishingOffice: "環境省 気象庁" });
}

function typhoon(key = "TC-1", serial = "1", timeMs = T0): PresentationEvent {
  return event({ id: `${key}-${serial}`, domain: "typhoonAnalysis", eventId: key, serial, reportDateTime: iso(timeMs), raw: {
    eventId: key, serial, infoType: "発表", name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
    frames: [{ kind: "実況", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 25 } }],
    lifecycle: "active",
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
    measurement: "water_level", measurementUnit: "m", rawUnit: "m", series: [],
    criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
  }));
  return event({ id: "flood-1", domain: "floodForecast", eventId: "flood-1", serial: "1", reportDateTime: iso(timeMs), raw: {
    schema: "vxko50", infoType: "発表", serial: 1, eventId: "flood-1", publishingOffice: "気象庁", rawStations: rivers,
    headlines: rivers.map((river: { primaryRiverCode: string; primaryRiverName: string }) => ({ scope: "河川", kindCode: "30", kindName: "氾濫警戒情報", areas: [{ name: river.primaryRiverName, code: river.primaryRiverCode }] })),
  } });
}

function tornado(timeMs = T0, office = "東京管区気象台", areaName = "東京都", cancellation = false): PresentationEvent {
  return event({ id: `tornado-${office}-${timeMs}`, domain: "tornado", serial: "1", reportDateTime: iso(timeMs),
    publishingOffice: office, areaItems: cancellation ? [] : [{ name: areaName }], isCancellation: cancellation, raw: {
      serial: "1", publishingOffice: office, activeAreaCount: cancellation ? 0 : 1,
      hasSightingAreas: false, validDateTime: iso(timeMs + 60 * 60_000),
    } });
}

function nankai(timeMs = T0): PresentationEvent {
  return event({ id: "nankai-1", domain: "nankaiTrough", serial: "1", reportDateTime: iso(timeMs), raw: { infoSerial: { code: "120" } } });
}

function longPeriod(timeMs = T0, eventId = "quake-1", maxLgInt: string | null = "3", cancellation = false): PresentationEvent {
  return event({ id: `lg-${eventId}-${timeMs}`, domain: "lgObservation", eventId, serial: "1", reportDateTime: iso(timeMs),
    isCancellation: cancellation, raw: { maxLgInt } });
}

function host(timeMs = T0, eventId = "quake-1", maxIntRank = 4): PresentationEvent {
  return event({ id: eventId, domain: "earthquake", eventId, maxIntRank, reportDateTime: iso(timeMs) });
}

function volcanoAlertInfo(
  timeMs: number,
  action: ParsedVolcanoAlertInfo["action"],
  alertLevel: ParsedVolcanoAlertInfo["alertLevel"],
): ParsedVolcanoAlertInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano", kind: "alert", type: "VFVO50", infoType: "発表", title: "噴火警報・予報",
    reportDateTime: iso(timeMs), eventDateTime: null, headline: null, publishingOffice: "気象庁",
    volcanoName: "テスト山", volcanoCode: "V-1", coordinate: null, isTest: false,
    alertLevel, alertLevelCode: String(alertLevel), action, previousLevelCode: null,
    alertClass: null,
    warningKind: "", municipalities: [], marineAreas: [], marineWarningKind: null,
    marineAlertLevelCode: null, bodyText: "", preventionText: "", isMarine: false,
  };
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

  it("6: hosts VXSE62 in the normal earthquake-then-VXSE62 order", () => {
    const store = new StandbyStateStore();
    store.applyEvent(host(), T0);
    store.applyEvent(longPeriod(T0 + 1), T0 + 1);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "longPeriod", data: { eventId: "quake-1", maxLgInt: "3" } })]);
  });

  it("6b: removes a hosted rider on a bodyless cancellation and ignores an older host", () => {
    const store = new StandbyStateStore();
    store.applyEvent(host(T0 + 60_000, "quake-new", 7), T0 + 60_000);
    store.applyEvent(longPeriod(T0 + 60_001, "quake-new"), T0 + 60_001);
    expect(store.snapshotItems()).toHaveLength(1);

    expect(store.applyEvent(host(T0, "quake-old", 2), T0 + 60_002)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ data: { eventId: "quake-new", maxLgInt: "3" } }));

    store.applyEvent(longPeriod(T0 + 60_003, "quake-new", null, true), T0 + 60_003);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("6c: persists the current earthquake host pair with the rider", () => {
    const source = new StandbyStateStore();
    source.applyEvent(host(T0, "quake-1", 6), T0);
    source.applyEvent(longPeriod(T0 + 1), T0 + 1);
    const persisted = source.exportActiveState();
    expect(persisted.quakeHost).toEqual(expect.objectContaining({ eventId: "quake-1", maxIntRank: 6 }));

    const restored = new StandbyStateStore();
    restored.restoreActiveState(persisted, T0 + 2);
    expect(restored.snapshotItems()).toEqual([expect.objectContaining({ kind: "longPeriod", restored: true })]);
  });

  it("6d: keeps a live intensity-5-lower host and its rider when a newer intensity-2 quake arrives", () => {
    const store = new StandbyStateStore();
    store.applyEvent(host(T0, "quake-1", 5), T0);
    store.applyEvent(longPeriod(T0 + 1, "quake-1"), T0 + 1);

    expect(store.applyEvent(host(T0 + 60_000, "quake-2", 2), T0 + 60_000))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.exportActiveState().quakeHost).toEqual(expect.objectContaining({ eventId: "quake-1", maxIntRank: 5 }));
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({ kind: "longPeriod", data: { eventId: "quake-1", maxLgInt: "3" } }),
    ]);
  });

  it("7: aggregates heat by target date and area, cancelling only the addressed area", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heat("1", T0, "東京都"), T0);
    store.applyEvent(heat("1", T0, "長崎県"), T0);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({
      kind: "heat",
      data: { targetDate: "2026-07-21", areas: [
        { areaName: "東京都", isSpecial: false },
        { areaName: "長崎県", isSpecial: false },
      ] },
    }));

    store.applyEvent(heat("2", T0 + 60_000, "東京都", true), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({
      data: { targetDate: "2026-07-21", areas: [{ areaName: "長崎県", isSpecial: false }] },
    }));
  });

  it("8: aggregates tornado advisories by publishing office and cancels only one office", () => {
    const store = new StandbyStateStore();
    store.applyEvent(tornado(T0, "東京管区気象台", "東京都"), T0);
    store.applyEvent(tornado(T0, "長崎地方気象台", "長崎県"), T0);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({
      kind: "tornado", data: { areas: ["東京都", "長崎県"], isSighted: false },
    }));

    store.applyEvent(tornado(T0 + 60_000, "東京管区気象台", "東京都", true), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({
      kind: "tornado", data: { areas: ["長崎県"], isSighted: false },
    }));
  });

  it("9: keeps volcano alert/event cancellation independent after an authoritative seed", () => {
    const store = new StandbyStateStore();
    store.seedVolcanoAlerts([{ volcanoCode: "V-1", volcanoName: "テスト山", alertLevel: 4, reportDateTime: iso(T0 + 60_000) }], "success", T0 + 60_000);

    store.applyEvent(expiringVolcano(T0 + 120_000), T0 + 120_000);
    store.applyEvent(event({ id: "cancel-event", domain: "volcano", serial: "2", reportDateTime: iso(T0 + 180_000), isCancellation: true, raw: {
      kind: "eruption", type: "VFVO52", infoType: "取消", volcanoCode: "V-1", volcanoName: "テスト山",
      isFlashReport: true, phenomenonName: "噴火速報",
    } }), T0 + 180_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({
      kind: "volcano", data: { volcanoes: [expect.objectContaining({ alertLevel: 4, latestEvent: null })] },
    }));

    const eventOnly = new StandbyStateStore();
    eventOnly.applyEvent(expiringVolcano(T0), T0);
    eventOnly.applyEvent(event({ id: "cancel-alert", domain: "volcano", serial: "2", reportDateTime: iso(T0 + 60_000), isCancellation: true, raw: {
      kind: "alert", type: "VFVO50", infoType: "取消", volcanoCode: "V-1", volcanoName: "テスト山",
      alertLevel: null, alertLevelCode: null, previousLevelCode: "4",
    } }), T0 + 60_000);
    expect(eventOnly.snapshotItems()[0]).toEqual(expect.objectContaining({
      kind: "volcano", data: {
        volcanoes: [expect.objectContaining({
          alertLevel: null,
          latestEvent: expect.objectContaining({ label: "噴火速報" }),
        })],
      },
    }));
  });

  it("9c: carries a non-numeric warning class through the authoritative startup seed", () => {
    const volcanoState = new VolcanoStateHolder();
    const info = volcanoAlertInfo(T0, "issue", null);
    info.alertClass = { code: "23", name: "入山危険", severity: "warning", isActive: true };
    info.warningKind = "噴火警報（火口周辺）";
    info.municipalities = [{ name: "テスト市", code: "001", kind: "入山規制" }];
    volcanoState.update(info);

    const store = new StandbyStateStore();
    store.seedVolcanoAlerts(volcanoState.getSeedEntries(), "success", T0);

    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "volcano",
        data: {
          volcanoes: [expect.objectContaining({
            alertLevel: null,
            alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
            warningKind: "噴火警報（火口周辺）",
            targetKinds: ["入山規制"],
          })],
        },
      }),
    ]);
  });

  it("10: keeps long-lived cancellation tombstones beyond 24 hours", () => {
    const store = new StandbyStateStore();
    store.applyEvent(nankai(T0), T0);
    store.applyEvent(event({ id: "nankai-end", domain: "nankaiTrough", serial: "2", reportDateTime: iso(T0 + 60_000), raw: { infoSerial: { code: "190" } } }), T0 + 60_000);
    store.sweep(T0 + 2 * 24 * 60 * 60_000);
    expect(store.applyEvent(nankai(T0), T0 + 2 * 24 * 60 * 60_000 + 1)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()).toEqual([]);
  });
});
