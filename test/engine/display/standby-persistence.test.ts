import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandbyPersistence, type PersistedStandbyStateV1 } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const roots: string[] = [];

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "fleq-standby-"));
  roots.push(root);
  return join(root, "data", "runtime", "display-active-state-v1.json");
}

function state(over: Partial<PersistedStandbyStateV1> = {}): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: new Date(T0).toISOString(),
    heat: [{
      key: "heat:2026-07-21",
      sourceEventIds: ["heat-1"],
      targetDate: "2026-07-21",
      targetDateEndMs: Date.parse("2026-07-22T00:00:00+09:00"),
      areas: [{ areaName: "東京都", isSpecial: false }],
      isSpecial: false,
      revision: { reportTimeMs: T0, serial: "1" },
    }],
    seen: [{
      key: "heat:2026-07-21",
      revision: { reportTimeMs: T0, serial: "1" },
      forgetAtMs: T0 + 24 * 60 * 60_000,
    }],
    ...over,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("StandbyPersistence", () => {
  it("atomic save と load が往復する", () => {
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(state());
    expect(persistence.load()).toEqual(state());
  });

  it("version 不一致と構造不正を破棄する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), version: 2 }), "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state(), heat: "invalid" }), "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
  });

  it("壊れた JSON を破棄する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken", "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
  });
});

describe("StandbyStateStore persistence", () => {
  it("未失効 state を restored=true で復元し export できる", () => {
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "heat", restored: true }));
    expect(store.exportActiveState()).toEqual(expect.objectContaining({
      version: 1,
      heat: [expect.objectContaining({ key: "heat:2026-07-21", revision: { reportTimeMs: T0, serial: "1" } })],
      seen: [expect.objectContaining({ key: "heat:2026-07-21" })],
    }));
  });

  it("絶対期限切れ state と tombstone を復元しない", () => {
    const expiredAt = T0 + 24 * 60 * 60_000;
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), expiredAt);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().seen).toEqual([]);
  });

  it("typhoon and volcano states survive an atomic persistence round trip", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "typhoon-1",
        typhoon: { typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString() },
        revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], revision: { reportTimeMs: T0, serial: "1" } }],
    });
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(persisted);
    const loaded = persistence.load();
    expect(loaded).toEqual(persisted);

    const store = new StandbyStateStore();
    store.restoreActiveState(loaded!, T0 + 60_000);
    expect(store.snapshotItems().map((item) => item.kind).sort()).toEqual(["heat", "typhoon", "volcano"]);
    expect(store.snapshotItems().every((item) => item.restored)).toBe(true);
  });

  it("failed seed retains restored volcano state; empty success clears its alert but keeps the eruption and emits a change", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], revision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    const changed = vi.fn();
    store.restoreActiveState(persisted, T0 + 60_000);
    store.onChange(changed);

    expect(store.seedVolcanoAlerts([], "failed", T0 + 60_000)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "volcano", restored: true }));
    expect(store.seedVolcanoAlerts([], "success", T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(changed).toHaveBeenCalledTimes(1);
    const volcano = store.snapshotItems().find((item) => item.kind === "volcano");
    expect(volcano).toEqual(expect.objectContaining({ restored: true, data: { volcanoes: [expect.objectContaining({ alertLevel: null, latestEvent: "flash" })] } }));
  });
});
