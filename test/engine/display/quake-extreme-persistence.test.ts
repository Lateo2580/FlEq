import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuakeExtremePersistence } from "../../../src/engine/display/quake-extreme-persistence";
import { QuakeExtremeStore, type QuakeExtremePersistedV1 } from "../../../src/engine/display/quake-extreme-store";
import { displayEventDto } from "../../helpers/display-fixtures";

const T0 = Date.parse("2026-07-29T00:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("QuakeExtremePersistence", () => {
  it("即時保存は予約中の旧 active を破棄して取消 tombstone を確定する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-quake-extreme-"));
    dirs.push(dir);
    const file = join(dir, "quake-extreme-v1.json");
    const persistence = new QuakeExtremePersistence(file, 60_000);
    const active: QuakeExtremePersistedV1 = {
      records: [{
        groupKey: "quake:Q1",
        originTime: new Date(T0).toISOString(),
        reportDateTime: new Date(T0).toISOString(),
        hypocenterName: "updated hypocenter",
        magnitude: "5.8",
        depth: "20km",
        sourceTypes: ["VXSE53"],
        observationSourceType: "VXSE53",
      }],
      seen: [],
    };
    const cancelled: QuakeExtremePersistedV1 = {
      records: [],
      seen: [{
        key: "quake:Q1",
        revision: { reportTimeMs: T0 + 1, serial: "2" },
        forgetAtMs: T0 + 12 * 60 * 60_000,
      }],
    };

    persistence.save(active, T0);
    expect(new QuakeExtremePersistence(file).load(T0)).toEqual(active);
    persistence.schedule(active, T0);
    persistence.saveImmediate(cancelled, T0 + 1);

    expect(new QuakeExtremePersistence(file).load(T0 + 2)).toEqual(cancelled);
  });

  it("旧 v1 record の observationSourceType 欠落を sourceTypes のまま後方互換読取する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-quake-extreme-"));
    dirs.push(dir);
    const file = join(dir, "quake-extreme-v1.json");
    const persistence = new QuakeExtremePersistence(file);
    const legacy: QuakeExtremePersistedV1 = {
      records: [{ groupKey: "quake:Q1", originTime: new Date(T0).toISOString(), sourceTypes: ["VXSE51"] }],
      seen: [{
        key: "quake:Q1:VXSE51",
        revision: { reportTimeMs: T0 + 3_000, serial: "3" },
        forgetAtMs: T0 + 12 * 60 * 60_000,
      }],
    };

    persistence.save(legacy, T0);
    const loaded = persistence.load(T0 + 3_500);
    expect(loaded).toEqual(legacy);

    const store = new QuakeExtremeStore();
    store.restore(loaded!, T0 + 3_500);
    expect(store.export().seen).toContainEqual(expect.objectContaining({
      key: "quake:Q1",
      revision: { reportTimeMs: T0 + 3_000, serial: "3" },
    }));
    expect(store.applyDto(displayEventDto({
      domain: "earthquake",
      type: "VXSE52",
      groupKey: "quake:Q1",
      reportDateTime: new Date(T0 + 2_000).toISOString(),
      serial: "2",
      latestQuake: {
        eventId: "Q1",
        headline: null,
        originTime: new Date(T0).toISOString(),
        hypocenterName: "沖合",
        depth: null,
        magnitude: null,
        maxInt: "6強",
        maxIntRank: 8,
        tsunamiWarning: false,
        intensityGroups: [],
        reportDateTime: new Date(T0 + 2_000).toISOString(),
      },
    }), T0 + 4_000)).toBe(false);
    expect(store.hasActive(T0 + 4_000)).toBe(true);
  });
});
