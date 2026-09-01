import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramMeta, telegramRevision } from "../../../src/dmdata/telegram-meta";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type PersistedStandbyStateV1,
  type PersistedTelegramFoundationInputV2,
  type PersistedTyphoonProbabilityStateV1,
  type PersistedTyphoonStateV1,
} from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type { PersistedTelegramRevisionGateEntryV2 } from "../../../src/engine/messages/telegram-revision-gate";
import { TYPHOON_PROBABILITY_RETENTION_MS } from "../../../src/engine/display/project-typhoon-probability";
import * as log from "../../../src/logger";

const NOW = Date.parse("2026-09-01T12:00:00+09:00");
const REPORT = NOW - 60_000;
const EXPIRES = NOW + 5 * 24 * 60 * 60_000;
const SEMANTIC = `発表:${"a".repeat(64)}`;
const roots: string[] = [];

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "fleq-vpta-persistence-"));
  roots.push(root);
  return join(root, "data", "runtime", "display-active-state-v1.json");
}

function probability(eventId = "TC2606"): PersistedTyphoonProbabilityStateV1 {
  return {
    key: eventId,
    sourceEventId: `source-${eventId}`,
    identity: { name: "JANGMI", nameKana: "チャンミー", remark: null, typhoonNumber: "2606" },
    baseTimeMs: NOW,
    maxFiveDayProbability: 50,
    activePrefectureCount: 1,
    topPrefectures: [{ prefectureCode: "45", prefectureName: "宮崎県", fiveDayProbability: 50 }],
    worstArea: {
      areaCode: "4500", areaName: "南部平野部", prefectureCode: "45",
      prefectureName: "宮崎県", fiveDayProbability: 50, peakAtMs: NOW + 6 * 60 * 60_000,
    },
    revision: { reportTimeMs: REPORT, serial: "1" },
    appliedSemanticKey: SEMANTIC,
    expiresAtMs: EXPIRES,
  };
}

function analysis(eventId = "TC2606"): PersistedTyphoonStateV1 {
  return {
    key: eventId,
    sourceEventId: `analysis-${eventId}`,
    typhoon: {
      typhoonKey: eventId,
      name: "JANGMI",
      nameKana: "チャンミー",
      remark: null,
      typhoonNumber: "2606",
      category: "TS",
      location: "日本の南",
      pressureHpa: 990,
      maxWindMs: 25,
      maxGustMs: 35,
      moveDirection: "北",
      moveSpeedKmh: 20,
      reportDateTime: new Date(REPORT).toISOString(),
    },
    revision: { reportTimeMs: REPORT, serial: "1" },
    expiresAtMs: NOW + 24 * 60 * 60_000,
    appliedSemanticKey: `発表:${"b".repeat(64)}`,
  };
}

function gateEntry(
  eventId = "TC2606",
  cancelled = false,
  semanticKeys: string[] = [SEMANTIC],
): PersistedTelegramRevisionGateEntryV2 {
  const infoType = cancelled ? "取消" : "発表";
  const stateSubjectKey = `typhoonProbability:${eventId}`;
  const meta = createTelegramMeta({
    messageId: `gate-${eventId}`,
    eventId,
    type: "VPTA50",
    reportDateTime: new Date(REPORT).toISOString(),
    serial: "1",
    infoType,
    receivedAtMs: NOW,
    status: "通常",
    isTest: false,
  });
  return {
    domain: "typhoonProbability",
    revisionFamily: "VPTA50",
    stateSubjectKey,
    comparison: { revision: telegramRevision(meta), stateSubjectKey },
    semanticKeys,
    cancelled,
    acceptedAtMs: NOW,
    tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
    legacyRevisionKey: eventId,
    legacyRevisionKeyProvenance: "eventId",
  };
}

function analysisGateEntry(eventId = "TC2606"): PersistedTelegramRevisionGateEntryV2 {
  const stateSubjectKey = `typhoon:${eventId}`;
  const semanticKey = `発表:${"b".repeat(64)}`;
  const meta = createTelegramMeta({
    messageId: `analysis-gate-${eventId}`, eventId, type: "VPTW60",
    reportDateTime: new Date(REPORT).toISOString(), serial: "1", infoType: "発表",
    receivedAtMs: NOW, status: "通常", isTest: false,
  });
  return {
    domain: "typhoonAnalysis", revisionFamily: "typhoonAnalysis", stateSubjectKey,
    comparison: {
      revision: {
        ...telegramRevision(meta),
        eventId: { raw: stateSubjectKey, value: stateSubjectKey, valid: true },
        type: { raw: "typhoonAnalysis", value: "typhoonAnalysis", valid: true },
      },
      stateSubjectKey,
    },
    semanticKeys: [semanticKey], cancelled: false, acceptedAtMs: NOW,
    tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
    legacyRevisionKey: eventId, legacyRevisionKeyProvenance: "eventId",
  };
}

function foundation(
  entries: PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramFoundationInputV2 {
  return {
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    standbyDomains: { gateEntries: entries },
  };
}

function state(
  over: Partial<PersistedStandbyStateV1> = {},
): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: new Date(NOW).toISOString(),
    heat: [],
    typhoons: [],
    typhoonProbabilities: [],
    volcanoes: [],
    seen: [],
    weatherAlerts: [],
    tornado: [],
    longPeriod: [],
    quakeHost: null,
    nankaiTrough: null,
    ...over,
  };
}

function saveAndLoad(
  persisted: PersistedStandbyStateV1,
  entries: PersistedTelegramRevisionGateEntryV2[],
) {
  const path = tempPath();
  const writer = new StandbyPersistence(path, 0, () => foundation(entries));
  expect(writer.save(persisted)).toMatchObject({ kind: "written" });
  const loaded = new StandbyPersistence(path).load();
  expect(loaded).not.toBeNull();
  return { path, loaded: loaded! };
}

function writeRawAndLoad(raw: unknown) {
  const path = tempPath();
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(raw), "utf8");
  const loaded = new StandbyPersistence(path).load(NOW);
  expect(loaded).not.toBeNull();
  return loaded!;
}

function legacySeen(eventId = "TC2606") {
  return {
    key: eventId,
    revision: { reportTimeMs: REPORT, serial: "1" },
    forgetAtMs: NOW + TYPHOON_PROBABILITY_RETENTION_MS + 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("StandbyPersistence VPTA50 coupling", () => {
  it("round-trips VPTW-only, probability-only, and combined as independent projections", () => {
    const vptwOnly = saveAndLoad(state({ typhoons: [analysis()] }), [analysisGateEntry()]);
    expect(vptwOnly.loaded.typhoons).toHaveLength(1);
    expect(vptwOnly.loaded.typhoonProbabilities ?? []).toEqual([]);

    const probabilityOnly = saveAndLoad(
      state({ typhoonProbabilities: [probability()] }),
      [gateEntry()],
    );
    expect(probabilityOnly.loaded.typhoons).toEqual([]);
    expect(probabilityOnly.loaded.typhoonProbabilities).toEqual([probability()]);

    const combined = saveAndLoad(
      state({ typhoons: [analysis()], typhoonProbabilities: [probability()] }),
      [analysisGateEntry(), gateEntry()],
    );
    const store = new StandbyStateStore();
    store.restoreActiveState(combined.loaded, NOW);
    const card = store.snapshotItems().find((item) => item.kind === "typhoon");
    expect(card?.data.typhoons).toHaveLength(1);
    expect(card?.data.typhoons[0]).toMatchObject({
      typhoonKey: "TC2606",
      category: "TS",
      probability: { maxFiveDayProbability: 50 },
    });
    expect(card?.restored).toBe(true);
  });

  it("restores a card only for a coupled P+G bundle, never GA, GT, or projection-only", () => {
    const coupled = saveAndLoad(
      state({ typhoonProbabilities: [probability()] }),
      [gateEntry()],
    );
    const coupledStore = new StandbyStateStore();
    coupledStore.restoreActiveState(coupled.loaded, NOW);
    expect(coupledStore.snapshotItems().find((item) => item.kind === "typhoon"))
      .toMatchObject({ restored: true });

    for (const entries of [
      [gateEntry("TC2606", false)],
      [gateEntry("TC2606", true, [`取消:${"c".repeat(64)}`])],
    ]) {
      const gateOnly = saveAndLoad(state(), entries);
      const store = new StandbyStateStore();
      store.restoreActiveState(gateOnly.loaded, NOW);
      expect(store.snapshotItems().find((item) => item.kind === "typhoon")).toBeUndefined();
    }

    const path = tempPath();
    const writer = new StandbyPersistence(path, 0, () => foundation([]));
    expect(writer.save(state({ typhoonProbabilities: [probability()] }))).toMatchObject({
      kind: "failed",
      stage: "validation",
    });
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(standbyPersistenceV2Path(path))).toBe(false);
  });

  it("writer validation failure leaves both previously committed mirrors byte-identical", () => {
    const { path } = saveAndLoad(
      state({ typhoonProbabilities: [probability()] }),
      [gateEntry()],
    );
    const beforeV1 = readFileSync(path);
    const beforeV2 = readFileSync(standbyPersistenceV2Path(path));
    const invalid = probability();
    invalid.maxFiveDayProbability = 101;
    const writer = new StandbyPersistence(path, 0, () => foundation([gateEntry()]));
    expect(writer.save(state({ typhoonProbabilities: [invalid] }))).toMatchObject({
      kind: "failed", stage: "validation",
    });
    expect(readFileSync(path)).toEqual(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path))).toEqual(beforeV2);
  });

  it("fails writer validation for duplicate VPTA gate subjects before creating mirrors", () => {
    const path = tempPath();
    const duplicateGate = gateEntry();
    const writer = new StandbyPersistence(path, 0, () => foundation([
      duplicateGate,
      structuredClone(duplicateGate),
    ]));
    expect(writer.save(state({ typhoonProbabilities: [probability()] }))).toMatchObject({
      kind: "failed",
      stage: "validation",
    });
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(standbyPersistenceV2Path(path))).toBe(false);
  });

  it("fails writer validation instead of compacting 257 canonical VPTA bundles", () => {
    const path = tempPath();
    const entries = Array.from({ length: 257 }, (_, index) =>
      gateEntry(`TC${String(index).padStart(4, "0")}`));
    const writer = new StandbyPersistence(path, 0, () => foundation(entries));
    expect(writer.save(state())).toMatchObject({ kind: "failed", stage: "validation" });
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(standbyPersistenceV2Path(path))).toBe(false);
  });

  it("fails writer validation for duplicate ordered semantic keys", () => {
    const path = tempPath();
    const writer = new StandbyPersistence(path, 0, () => foundation([
      gateEntry("TC2606", false, [SEMANTIC, SEMANTIC]),
    ]));
    expect(writer.save(state())).toMatchObject({ kind: "failed", stage: "validation" });
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(standbyPersistenceV2Path(path))).toBe(false);
  });

  it("drops the whole VPTA persistence domain when corresponding raw seen exceeds 1024", () => {
    const path = tempPath();
    const raw = state({
      typhoons: [analysis()],
      typhoonProbabilities: [probability()],
      seen: Array.from({ length: 1_025 }, (_, index) => ({
        key: `typhoonProbability:TC${String(index).padStart(4, "0")}`,
        revision: { reportTimeMs: REPORT, serial: "1" },
        forgetAtMs: NOW + TYPHOON_PROBABILITY_RETENTION_MS + 1,
      })),
    });
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(raw), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.typhoons).toHaveLength(1);
    expect(loaded?.typhoons[0]).toMatchObject(analysis());
    expect(loaded?.typhoonProbabilities ?? []).toEqual([]);
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries.filter((entry) =>
      entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50")).toEqual([]);
  });

  it("applies the 1024 hard limit to the union of raw VPTA bundle sources", () => {
    const projectionIds = Array.from({ length: 513 }, (_, index) =>
      `P${String(index).padStart(4, "0")}`);
    const metadataIds = Array.from({ length: 512 }, (_, index) =>
      `M${String(index).padStart(4, "0")}`);
    const metadata = metadataIds.map((eventId) => {
      const gate = gateEntry(eventId);
      return {
        stateSubjectKey: gate.stateSubjectKey,
        comparison: gate.comparison,
        semanticKeys: gate.semanticKeys,
        cancelled: gate.cancelled,
      };
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const loaded = writeRawAndLoad(state({
      typhoons: [analysis()],
      typhoonProbabilities: projectionIds.map(probability),
      typhoonProbabilityGateMetadata: metadata,
    }));

    expect(loaded.typhoons).toHaveLength(1);
    expect(loaded.typhoonProbabilities ?? []).toEqual([]);
    expect(loaded.telegramFoundation.standbyDomains.gateEntries.filter((entry) =>
      entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      "domain=foundation.standbyDomains unit=domain reason=limit-exceeded",
    ));
    warn.mockRestore();
  });

  it("migrates strict absent-metadata active and missing-key tombstone shapes without guessing", () => {
    const active = writeRawAndLoad(state({
      typhoonProbabilities: [probability()],
      seen: [legacySeen()],
    }));
    expect(active.typhoonProbabilities).toEqual([probability()]);
    expect(active.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "typhoonProbability:TC2606",
        cancelled: false,
        semanticKeys: [SEMANTIC],
        acceptedAtMs: NOW,
      }),
    ]);

    const missingKeyProjection = probability() as unknown as Record<string, unknown>;
    delete missingKeyProjection.appliedSemanticKey;
    const missing = writeRawAndLoad({
      ...state({ seen: [legacySeen()] }),
      typhoonProbabilities: [missingKeyProjection],
    });
    expect(missing.typhoonProbabilities ?? []).toEqual([]);
    expect(missing.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "typhoonProbability:TC2606",
        cancelled: true,
        semanticKeys: [],
        acceptedAtMs: NOW,
      }),
    ]);
  });

  it("does not turn malformed, duplicate, or metadata-disabled v1 projections into tombstones", () => {
    const malformed = probability() as unknown as Record<string, unknown>;
    malformed.appliedSemanticKey = "x".repeat(1_025);
    const malformedLoaded = writeRawAndLoad({
      ...state({ seen: [legacySeen()] }),
      typhoonProbabilities: [malformed],
    });
    expect(malformedLoaded.typhoonProbabilities ?? []).toEqual([]);
    expect(malformedLoaded.telegramFoundation.standbyDomains.gateEntries).toEqual([]);

    const nonCanonicalKey = probability() as unknown as Record<string, unknown>;
    nonCanonicalKey.appliedSemanticKey = "not-a-semantic-key";
    const nonCanonicalLoaded = writeRawAndLoad({
      ...state({ seen: [legacySeen()] }),
      typhoonProbabilities: [nonCanonicalKey],
    });
    expect(nonCanonicalLoaded.typhoonProbabilities ?? []).toEqual([]);
    expect(nonCanonicalLoaded.telegramFoundation.standbyDomains.gateEntries).toEqual([]);

    const duplicateLoaded = writeRawAndLoad(state({
      typhoonProbabilities: [probability(), { ...probability(), maxFiveDayProbability: 101 }],
      seen: [legacySeen()],
    }));
    expect(duplicateLoaded.typhoonProbabilities ?? []).toEqual([]);
    expect(duplicateLoaded.telegramFoundation.standbyDomains.gateEntries).toEqual([]);

    const duplicateSeenLoaded = writeRawAndLoad(state({
      typhoonProbabilities: [],
      seen: [legacySeen(), { ...legacySeen(), key: "typhoonProbability:TC2606" }],
    }));
    expect(duplicateSeenLoaded.telegramFoundation.standbyDomains.gateEntries).toEqual([]);

    const metadataDisabled = writeRawAndLoad({
      ...state({ typhoonProbabilities: [probability()], seen: [legacySeen()] }),
      typhoonProbabilityGateMetadata: [],
    });
    expect(metadataDisabled.typhoonProbabilities ?? []).toEqual([]);
    expect(metadataDisabled.telegramFoundation.standbyDomains.gateEntries).toEqual([]);
  });
});
