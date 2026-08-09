import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuakeExtremePersistence } from "../../../src/engine/display/quake-extreme-persistence";
import { QuakeExtremeStore, type QuakeExtremePersistedV1 } from "../../../src/engine/display/quake-extreme-store";
import { displayEventDto } from "../../helpers/display-fixtures";
import {
  projectDepthSemantic,
  projectMagnitudeSemantic,
} from "../../../src/engine/display/magnitude-depth-semantic";
import type { SpecialValue } from "../../../src/types";

const T0 = Date.parse("2026-07-29T00:00:00Z");
const dirs: string[] = [];

function numericValue(raw: string, value: number): SpecialValue<number> {
  return { raw, value, condition: null, description: null, presence: "value" };
}

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
        magnitudeSemantic: projectMagnitudeSemantic(numericValue("5.8", 5.8)),
        magnitudeValue: {
          ...numericValue("5.8", 5.8),
          diagnostics: ["specialValueConflict"],
        },
        depth: "20km",
        depthSemantic: projectDepthSemantic({
          raw: "-20000",
          value: null,
          condition: "20km以上",
          description: "深さ20km以上",
          presence: "range",
          lowerBound: 20,
          rawLowerBound: "２０",
          rawUpperBound: null,
        }),
        depthValue: {
          raw: "-20000",
          value: null,
          condition: "20km以上",
          description: "深さ20km以上",
          presence: "range",
          lowerBound: 20,
          rawLowerBound: "２０",
          diagnostics: ["specialValueConflict"],
        },
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
    const serialized = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    expect(serialized.records[0]).toMatchObject({
      magnitudeSemantic: {
        lowerBound: null,
        upperBound: null,
        rank: { kind: "value", value: 5.8 },
      },
      depthSemantic: {
        lowerBound: 20,
        upperBound: null,
        rawLowerBound: "２０",
        rawUpperBound: null,
      },
      magnitudeValue: { diagnostics: ["specialValueConflict"] },
      depthValue: {
        lowerBound: 20,
        rawLowerBound: "２０",
        diagnostics: ["specialValueConflict"],
      },
    });
    persistence.schedule(active, T0);
    persistence.saveImmediate(cancelled, T0 + 1);

    expect(new QuakeExtremePersistence(file).load(T0 + 2)).toEqual(cancelled);
  });

  it("upper-only numeric bounds を QuakeExtreme owner で canonical/semantic とも round-trip する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-quake-extreme-"));
    dirs.push(dir);
    const file = join(dir, "quake-extreme-v1.json");
    const magnitudeValue: SpecialValue<number> = {
      raw: "7.0", value: null, condition: "7.0以下", description: "M7.0以下",
      presence: "range", upperBound: 7, rawUpperBound: "７．０",
      diagnostics: ["unmappedSpecialValue"],
    };
    const depthValue: SpecialValue<number> = {
      raw: "-999000", value: null, condition: "999km以下", description: "深さ999km以下",
      presence: "range", upperBound: 999, rawUpperBound: "９９９",
      diagnostics: ["specialValueConflict"],
    };
    const state: QuakeExtremePersistedV1 = {
      records: [{
        groupKey: "quake:upper-only",
        originTime: new Date(T0).toISOString(),
        magnitude: "7.0",
        magnitudeSemantic: projectMagnitudeSemantic(magnitudeValue),
        magnitudeValue,
        depth: "999km",
        depthSemantic: projectDepthSemantic(depthValue),
        depthValue,
        sourceTypes: ["VXSE53"],
        observationSourceType: "VXSE53",
      }],
      seen: [],
    };

    const persistence = new QuakeExtremePersistence(file);
    persistence.save(state, T0);
    expect(persistence.load(T0 + 1)).toEqual(state);
    expect(JSON.parse(readFileSync(file, "utf8")).records[0]).toMatchObject({
      magnitudeValue: { upperBound: 7, rawUpperBound: "７．０" },
      depthValue: { upperBound: 999, rawUpperBound: "９９９" },
      magnitudeSemantic: { lowerBound: null, upperBound: 7 },
      depthSemantic: { lowerBound: null, upperBound: 999 },
    });
  });

  it("scalar-only v1 record を読込時だけ semantic へ移行する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-quake-extreme-"));
    dirs.push(dir);
    const file = join(dir, "quake-extreme-v1.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0).toISOString(),
      records: [{
        groupKey: "quake:legacy",
        originTime: new Date(T0).toISOString(),
        magnitude: "6.0",
        depth: "30km",
        sourceTypes: ["VXSE51"],
      }, {
        groupKey: "quake:broken-semantic",
        originTime: new Date(T0).toISOString(),
        magnitude: "6.0",
        magnitudeSemantic: { rank: null },
        sourceTypes: ["VXSE51"],
      }],
      seen: [],
    }), "utf8");

    const loaded = new QuakeExtremePersistence(file).load(T0);
    expect(loaded?.records).toHaveLength(1);
    expect(loaded?.records[0]).toMatchObject({
      magnitude: "6.0",
      magnitudeSemantic: {
        presence: "value", value: 6, rank: { kind: "value", value: 6 },
      },
      depth: "30km",
      depthSemantic: { presence: "value", value: 30 },
    });
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
