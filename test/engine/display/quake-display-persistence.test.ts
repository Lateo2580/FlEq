import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuakeDisplayPersistence } from "../../../src/engine/display/quake-display-persistence";
import { DisplayStateStore, type DisplayQuakeLifecyclePersistedV1 } from "../../../src/engine/display/state-store";
import type { DisplayQuakeIntensityMapEventV1 } from "../../../src/engine/display/types";
import type { DisplayLargeQuakeStateV1 } from "../../../src/engine/display/types";

const T0 = Date.parse("2026-08-26T12:00:00+09:00");
const HOST_TTL_MS = 5 * 60_000;
const tempDirs: string[] = [];

function mapEvent(eventKey: string, rank: number): DisplayQuakeIntensityMapEventV1 {
  return {
    eventKey,
    eventId: eventKey.slice("earthquake:".length),
    sourceType: "VXSE53",
    revision: { reportTimeMs: T0, serial: "1" },
    reportDateTime: new Date(T0).toISOString(),
    originTime: new Date(T0 - 60_000).toISOString(),
    hypocenterName: "テスト震源",
    depth: "10km",
    magnitude: "5.0",
    maxInt: String(rank),
    maxIntRank: rank,
    tsunamiWarning: false,
    intensityGroups: [{ intensity: String(rank), rank, areas: ["A"], omittedAreaCount: 0 }],
    localAreas: [{ code: "440", rank }],
    updatedAtMs: T0,
  };
}

function persistedState(): DisplayQuakeLifecyclePersistedV1 {
  return {
    contributions: [mapEvent("earthquake:known", 4), mapEvent("earthquake:salvage", 3)],
    largeQuakes: [{ key: "salvage", value: largeQuake("earthquake:salvage") }],
    nonEmergencyHost: { eventKey: "earthquake:known", expiresAtMs: T0 + HOST_TTL_MS },
    revisions: [{
      key: "earthquake:known:VXSE53",
      revision: { reportTimeMs: T0, serial: "1" },
      forgetAtMs: T0 + 24 * 60 * 60_000,
    }, {
      key: "earthquake:salvage:VXSE53",
      revision: { reportTimeMs: T0, serial: "1" },
      forgetAtMs: T0 + 24 * 60 * 60_000,
    }],
  };
}

function largeQuake(eventKey: string): DisplayLargeQuakeStateV1 {
  return {
    kind: "largeQuake",
    eventId: eventKey.slice("earthquake:".length),
    originTime: new Date(T0 - 60_000).toISOString(),
    hypocenterName: "テスト震源",
    magnitude: "5.0",
    maxInt: "5-",
    maxIntRank: 5,
    intensityGroups: [{ intensity: "5-", rank: 5, areas: ["A"], omittedAreaCount: 0 }],
    reportDateTime: new Date(T0).toISOString(),
    depth: "10km",
    maxLgInt: null,
    tsunamiWarning: false,
    mapEventKey: eventKey,
    mapSourceType: "VXSE53",
    mapRevision: { reportTimeMs: T0, serial: "1" },
    updatedAtMs: T0,
  };
}

function persistence(): { path: string; value: QuakeDisplayPersistence } {
  const dir = fs.mkdtempSync(path.join(process.cwd(), `.quake-display-persistence-${process.pid}-`));
  tempDirs.push(dir);
  const file = path.join(dir, "quake-display.json");
  return { path: file, value: new QuakeDisplayPersistence(file, 0) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("QuakeDisplayPersistence", () => {
  it("host の絶対期限を round-trip し、期限内だけ runtime seed に採用する", () => {
    const target = persistence();
    target.value.save(persistedState(), T0);
    const loaded = target.value.load(T0 + HOST_TTL_MS - 1);
    expect(loaded?.nonEmergencyHost?.expiresAtMs).toBe(T0 + HOST_TTL_MS);

    const store = new DisplayStateStore();
    store.restoreQuakeLifecycle(loaded!, T0 + HOST_TTL_MS - 1);
    expect(store.snapshot(1, T0 + HOST_TTL_MS - 1).mapLayers?.quake?.nonEmergencyHost)
      .toEqual({ eventKey: "earthquake:known", expiresAtMs: T0 + HOST_TTL_MS });

    const expired = target.value.load(T0 + HOST_TTL_MS);
    expect(expired?.nonEmergencyHost).toBeNull();
  });

  it("nested semantic が壊れた eventKey と dangling revision／largeQuake をまとめて除外する", () => {
    const target = persistence();
    target.value.save(persistedState(), T0);
    const envelope = JSON.parse(fs.readFileSync(target.path, "utf8")) as {
      state: { contributions: Array<{ localAreas?: unknown[] }>; revisions: unknown[]; largeQuakes: unknown[] };
    };
    const corrupt = envelope.state.contributions[1];
    if (corrupt == null || corrupt.localAreas == null || corrupt.localAreas[0] == null) {
      throw new Error("test fixture missing salvage local area");
    }
    corrupt.localAreas[0] = {
      code: "440",
      rank: -1,
      intensitySemantic: { presence: "unknown", badge: "?" },
    };
    fs.writeFileSync(target.path, `${JSON.stringify(envelope)}\n`, "utf8");

    const loaded = target.value.load(T0 + 1);
    expect(loaded?.contributions.map((event) => event.eventKey)).toEqual(["earthquake:known"]);
    expect(loaded?.nonEmergencyHost).toEqual({
      eventKey: "earthquake:known",
      expiresAtMs: T0 + HOST_TTL_MS,
    });
    expect(loaded?.revisions).toHaveLength(1);
    expect(loaded?.largeQuakes).toEqual([]);
  });
});
