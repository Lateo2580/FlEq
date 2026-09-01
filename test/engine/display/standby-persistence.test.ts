import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BriefingCriticalPersistenceInvariantError,
  StandbyPersistence,
  standbyPersistenceV2Path,
  validateBriefingCriticalForWrite,
  type PersistedBriefingCriticalEntryV1,
  type PersistedBriefingCriticalStateV1,
  type PersistedStandbyStateV1,
} from "../../../src/engine/display/standby-persistence";
import type { DisplayBriefingEntryV1 } from "../../../src/engine/display/protocol";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { FloodActiveReducer } from "../../../src/engine/display/flood-active-reducer";
import { VPWW56_SNAPSHOT_GENERATION } from "../../../src/engine/messages/vpww56-state";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { fromFloodForecastOutcome } from "../../../src/engine/presentation/events/from-flood-forecast";
import * as log from "../../../src/logger";
import type { FloodForecastOutcome, PresentationEvent } from "../../../src/engine/presentation/types";
import type { SpecialValue } from "../../../src/types";
import {
  legacyDisplayPlumeHeightSemantics,
  projectPlumeHeightSemantic,
} from "../../../src/engine/display/plume-height-semantic";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO56_FLASH_4,
} from "../../helpers/mock-message";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const roots: string[] = [];

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "fleq-standby-"));
  roots.push(root);
  return join(root, "data", "runtime", "display-active-state-v1.json");
}

function jsonPointer(value: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((current, token) => {
    if (current == null || typeof current !== "object") return undefined;
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return (current as Record<string, unknown>)[key];
  }, value);
}

function operationalArray(value: unknown[], pointer: string): unknown[] {
  const copied = [...value];
  if (pointer === "/briefingCritical/rawAliases") {
    copied.sort((left, right) => {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      return `${String(leftRecord.source)}\0${String(leftRecord.sourceEventId)}`
        .localeCompare(`${String(rightRecord.source)}\0${String(rightRecord.sourceEventId)}`);
    });
  }
  return copied;
}

function operationalArrayIdentity(value: unknown, pointer: string): string | null {
  if (pointer !== "/briefingCritical/rawAliases" || value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" && typeof record.sourceEventId === "string"
    ? `${record.source}\0${record.sourceEventId}`
    : null;
}

function explicitPrimitiveReplacements(source: unknown, target: unknown, pointer = ""): string[] {
  if (source == null || target == null || typeof source !== "object" || typeof target !== "object") {
    return pointer !== "/version" && JSON.stringify(source) !== JSON.stringify(target) ? [pointer] : [];
  }
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target)) return [pointer];
    const left = operationalArray(source, pointer);
    const right = operationalArray(target, pointer);
    const leftIdentities = left.map((item) => operationalArrayIdentity(item, pointer));
    const rightIdentities = right.map((item) => operationalArrayIdentity(item, pointer));
    if (leftIdentities.every((identity) => identity != null)
      && rightIdentities.every((identity) => identity != null)) {
      const rightByIdentity = new Map(rightIdentities.map((identity, index) => [identity!, right[index]]));
      const identitySetChanged = JSON.stringify(leftIdentities) !== JSON.stringify(rightIdentities);
      return [
        ...(identitySetChanged ? [pointer] : []),
        ...left.flatMap((item, index) => {
          const matching = rightByIdentity.get(leftIdentities[index]!);
          return matching === undefined
            ? []
            : explicitPrimitiveReplacements(item, matching, `${pointer}/${index}`);
        }),
      ];
    }
    return [
      ...(left.length === right.length ? [] : [pointer]),
      ...left.slice(0, Math.min(left.length, right.length)).flatMap((item, index) =>
        explicitPrimitiveReplacements(item, right[index], `${pointer}/${index}`)),
    ];
  }
  const left = source as Record<string, unknown>;
  const right = target as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => {
    const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (childPointer === "/version") return [];
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return [childPointer];
    return explicitPrimitiveReplacements(left[key], right[key], childPointer);
  });
}

function expiredEpochPointers(value: unknown, nowMs: number, pointer = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => expiredEpochPointers(item, nowMs, `${pointer}/${index}`));
  }
  if (value == null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (/^(?:expiresAtMs|forgetAtMs|targetDateEndMs)$/.test(key)
      && typeof item === "number" && item <= nowMs) return [childPointer];
    return expiredEpochPointers(item, nowMs, childPointer);
  });
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
    typhoons: [],
    volcanoes: [],
    floods: undefined,
    weatherAlerts: [],
    tornado: [],
    longPeriod: [],
    quakeHost: null,
    nankaiTrough: null,
    ...over,
  };
}

function rawBriefingDisplayKey(source: "vpbs50" | "vpoa50", sourceEventId: string): string {
  return `card:briefing:${JSON.stringify(["raw", source, sourceEventId])}`;
}

function briefingUnit(options: {
  source?: "vpbs50" | "vpoa50";
  sourceEventId?: string;
  semanticKey?: string | null;
  phenomenonKind?: "linearRainObserved" | "linearRainPredicted" | "recordRain" | "shortSnow" | null;
  editorialOffice?: string;
  frameLevel?: "critical" | "cancel";
  revision?: { reportTimeMs: number; serial: string } | null;
  generation?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
} = {}): PersistedBriefingCriticalEntryV1 {
  const source = options.source ?? "vpbs50";
  const sourceEventId = options.sourceEventId ?? "briefing-event-1";
  const editorialOffice = options.editorialOffice ?? "試験地方気象台";
  const phenomenonKind = options.phenomenonKind === undefined ? "recordRain" : options.phenomenonKind;
  const semanticKey = options.semanticKey === undefined
    ? `card:vpbs:semantic:${phenomenonKind}:${editorialOffice}`
    : options.semanticKey;
  const revision = options.revision === undefined ? { reportTimeMs: T0, serial: "3" } : options.revision;
  const updatedAtMs = options.updatedAtMs ?? T0;
  const expiresAtMs = options.expiresAtMs ?? T0 + 60 * 60_000;
  const entry: DisplayBriefingEntryV1 = {
    key: semanticKey ?? rawBriefingDisplayKey(source, sourceEventId),
    source,
    sourceEventId,
    editorialOffice,
    phenomenonKind,
    semanticKey,
    serial: revision?.serial ?? null,
    title: "記録的短時間大雨情報",
    headline: "試験地方で記録的な大雨",
    conditions: ["警戒"],
    targetAreas: [{ name: "試験地方", code: "999999" }],
    reportDateTime: revision == null ? "" : new Date(revision.reportTimeMs).toISOString(),
    publishingOffice: editorialOffice,
    infoType: options.frameLevel === "cancel" ? "取消" : "発表",
    frameLevel: options.frameLevel ?? "critical",
    severityEvidence: [{
      source: "test", condition: null, tag: "recordRain", displaySeverity: "officialL5",
      soundLevel: null, severity: null, phenomenonCode: null, kindCode: null, levelCode: null, status: null,
    }],
    summary: {
      mode: options.frameLevel === "cancel" ? "cancellation" : "structured",
      hasUnknownKind: false,
      items: [{
        kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0,
        facts: [{
          kind: "precipitation", locationName: "試験市", locationCode: "999999",
          description: "1時間雨量", value: 100, unit: "mm", at: new Date(T0).toISOString(),
          duration: "1時間", approximation: "exact",
        }],
      }],
    },
    qualifier: null,
    updatedAt: new Date(updatedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    generation: options.generation ?? 1,
  };
  return { entry, updatedAtMs, expiresAtMs };
}

function rawBriefingUnit(sourceEventId: string, source: "vpbs50" | "vpoa50" = "vpoa50"):
PersistedBriefingCriticalEntryV1 {
  return briefingUnit({
    source, sourceEventId, semanticKey: null, phenomenonKind: null, editorialOffice: "",
    revision: { reportTimeMs: T0, serial: "3" },
  });
}

function semanticBriefingSlice(): PersistedBriefingCriticalStateV1 {
  const unit = briefingUnit();
  return {
    generation: 1,
    entries: [unit],
    cancellations: [],
    watermarks: [{
      semanticKey: unit.entry.semanticKey!,
      revision: { reportTimeMs: T0, serial: "3" },
      expiresAtMs: T0 + 60 * 60_000,
    }],
  };
}

function rootHeat(key: string, targetDate: string): PersistedStandbyStateV1["heat"][number] {
  return {
    key,
    sourceEventIds: [`${key}-source`],
    targetDate,
    targetDateEndMs: Date.parse(`${targetDate}T23:59:59+09:00`),
    areas: [{ areaName: "東京都", isSpecial: false }],
    isSpecial: false,
    revision: { reportTimeMs: T0, serial: "1" },
  };
}

function rootTyphoon(key: string): PersistedStandbyStateV1["typhoons"][number] {
  return {
    key: `typhoon:${key}`,
    sourceEventId: `${key}-source`,
    typhoon: {
      typhoonKey: key,
      name: "Alpha",
      nameKana: null,
      remark: null,
      typhoonNumber: "2601",
      category: "TS",
      location: "ocean",
      pressureHpa: 990,
      maxWindMs: 25,
      maxGustMs: null,
      moveDirection: "N",
      moveSpeedKmh: 20,
      reportDateTime: new Date(T0).toISOString(),
    },
    revision: { reportTimeMs: T0, serial: "1" },
    expiresAtMs: T0 + 24 * 60 * 60_000,
  };
}

function rootVolcano(code: string): PersistedStandbyStateV1["volcanoes"][number] {
  return {
    code,
    name: `Volcano ${code}`,
    alertLevel: null,
    alertClass: null,
    warningKind: null,
    targetKinds: [],
    alertExpiresAtMs: null,
    latestEvent: null,
    latestEventId: null,
    eventExpiresAtMs: null,
    sourceEventIds: [`volcano-${code}`],
    alertRevision: null,
    eventRevision: null,
  };
}

function rootTornado(office: string): NonNullable<PersistedStandbyStateV1["tornado"]>[number] {
  return {
    publishingOffice: office,
    sourceEventId: `tornado-${office}`,
    areas: ["東京都"],
    isSighted: false,
    revision: { reportTimeMs: T0, serial: "1" },
    expiresAtMs: T0 + 60 * 60_000,
  };
}

function rootLongPeriod(eventId: string, hosted = false): NonNullable<PersistedStandbyStateV1["longPeriod"]>[number] {
  return {
    eventId,
    maxLgInt: "3",
    safetyRank: 3,
    revision: { reportTimeMs: T0, serial: "1" },
    hosted,
    expiresAtMs: T0 + 60 * 60_000,
  };
}

function rootSeen(key: string): PersistedStandbyStateV1["seen"][number] {
  return {
    key,
    revision: { reportTimeMs: T0, serial: "1" },
    forgetAtMs: T0 + 24 * 60 * 60_000,
  };
}

type TyphoonDeltaField = "pressure" | "maxWind";

function numericValue(value: number): SpecialValue<number> {
  return {
    raw: String(value),
    value,
    condition: null,
    description: null,
    presence: "value",
  };
}

function transitionSpecialValue(
  presence: "missing" | "empty" | "qualitative" | "range",
): SpecialValue<number> {
  switch (presence) {
    case "missing":
      return { raw: null, value: null, condition: null, description: null, presence };
    case "empty":
      return { raw: "", value: null, condition: null, description: null, presence };
    case "qualitative":
      return {
        raw: "ほとんど停滞",
        value: null,
        condition: "ほとんど停滞",
        description: null,
        presence,
      };
    case "range":
      return {
        raw: "25",
        value: null,
        condition: "以上",
        description: null,
        presence,
        lowerBound: 25,
        rawLowerBound: "25",
      };
  }
}

function typhoonTransitionEvent(
  serial: string,
  field: TyphoonDeltaField,
  target: SpecialValue<number>,
): PresentationEvent {
  const missing = transitionSpecialValue("missing");
  const pressureHpaValue = field === "pressure" ? target : missing;
  const maxWindMsValue = field === "maxWind" ? target : missing;
  const reportDateTime = new Date(T0 + (Number(serial) - 1) * 60_000).toISOString();
  return {
    id: `typhoon-${field}-${serial}`,
    domain: "typhoonAnalysis",
    eventId: "TC-transition",
    serial,
    reportDateTime,
    isCancellation: false,
    raw: {
      type: "VPTW60",
      infoType: "発表",
      eventId: "TC-transition",
      serial,
      name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
      frames: [{
        kind: "analysis",
        typhoonClass: { category: "TS" },
        center: {
          location: "ocean",
          pressureHpa: pressureHpaValue.presence === "value" ? pressureHpaValue.value : null,
          pressureHpaValue,
          moveDirection: "N",
          moveSpeedKmh: 20,
          moveSpeedKmhValue: numericValue(20),
        },
        wind: {
          maxWindMs: maxWindMsValue.presence === "value" ? maxWindMsValue.value : null,
          maxWindMsValue,
          maxGustMs: null,
          maxGustMsValue: missing,
        },
      }],
      lifecycle: "active",
    },
  } as unknown as PresentationEvent;
}

function expectNoTyphoonNumericTrend(store: StandbyStateStore): void {
  const typhoon = store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0];
  expect(typhoon).toMatchObject({
    pressureDeltaHpa: null,
    maxWindDeltaMs: null,
    intensityTrend: null,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operational fixture explicit replacement guard", () => {
  it.each([
    ["field removal", { nested: { keep: 1, removed: 2 } }, { nested: { keep: 1 } }, ["/nested/removed"]],
    ["field addition", { nested: { keep: 1 } }, { nested: { keep: 1, added: 2 } }, ["/nested/added"]],
    ["array shortening", { items: [1, 2] }, { items: [1] }, ["/items"]],
    ["array extension", { items: [1] }, { items: [1, 2] }, ["/items"]],
  ] as const)("%s は allowlist 外変更として検出する", (_name, source, target, expected) => {
    expect(explicitPrimitiveReplacements(source, target)).toEqual(expected);
  });
});

describe("StandbyPersistence", () => {
  it("atomic save と load が往復する", () => {
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(state());
    expect(persistence.load()).toEqual(expect.objectContaining({
      ...state(),
      version: 2,
      telegramFoundation: {
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: false,
          state: null,
          gateEntries: [],
        },
        tsunami: {
          active: null, keyedActive: [], legacyActive: null,
          observations: { VTSE51: [], VTSE52: [] }, gateEntries: [],
        },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: { gateEntries: [] },
      },
    }));
  });

  it("standalone v1 fallbackのtokenized standby domainを初回v2保存でも維持する", () => {
    const path = tempPath();
    const acceptedAtMs = T0 - 5 * 60_000;
    const dayMs = 24 * 60 * 60_000;
    const heat = {
      ...rootHeat("heat:2026-07-21:東京都", "2026-07-21"),
      appliedSemanticKey: `発表:${"a".repeat(64)}`,
    };
    const typhoon = {
      ...rootTyphoon("TC-A"),
      key: "TC-A",
      appliedSemanticKey: `訂正:${"b".repeat(64)}`,
    };
    const tornado = {
      ...rootTornado("試験地方気象台"),
      appliedSemanticKey: `発表:${"c".repeat(64)}`,
    };
    const longPeriod = {
      ...rootLongPeriod("lg-event"),
      appliedSemanticKey: `発表:${"d".repeat(64)}`,
    };
    const subjects = [
      [heat.key, heat.revision, 3 * dayMs],
      [`typhoon:${typhoon.key}`, typhoon.revision, 7 * dayMs],
      [`tornado:${tornado.publishingOffice}`, tornado.revision, 36 * 60 * 60_000],
      [`longPeriod:${longPeriod.eventId}`, longPeriod.revision, 36 * 60 * 60_000],
    ] as const;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      heat: [heat], typhoons: [typhoon], tornado: [tornado], longPeriod: [longPeriod],
      seen: subjects.map(([key, revision, retentionMs]) => ({
        key, revision, forgetAtMs: acceptedAtMs + retentionMs + 1,
      })),
    })), "utf8");

    const fallbackReader = new StandbyPersistence(path);
    const loaded = fallbackReader.load();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries.map((entry) =>
      entry.stateSubjectKey)).toEqual(subjects.map(([key]) => key));
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries[0]).toMatchObject({
      stateSubjectKey: heat.key,
      comparison: { revision: {
        reportDateTime: { epochMs: heat.revision.reportTimeMs },
        serial: { raw: heat.revision.serial },
      } },
      semanticKeys: [heat.appliedSemanticKey],
    });
    expect(fallbackReader.takeMigrationConflictCount()).toBe(0);

    const { telegramFoundation, version: _version, ...exported } = loaded!;
    new StandbyPersistence(path, undefined, () => telegramFoundation).save({
      ...exported,
      version: 1,
      briefingCritical: semanticBriefingSlice(),
    });
    const savedV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));
    expect(savedV2.telegramFoundation.standbyDomains.gateEntries.map(
      (entry: { stateSubjectKey: string }) => entry.stateSubjectKey,
    )).toEqual(subjects.map(([key]) => key));
    expect(savedV2.heat).toEqual(loaded?.heat);
    const reloaded = new StandbyPersistence(path).load();
    expect(reloaded?.heat).toEqual(loaded?.heat);
    expect(reloaded?.typhoons).toEqual(loaded?.typhoons);
    expect(reloaded?.tornado).toEqual(loaded?.tornado);
    expect(reloaded?.longPeriod).toEqual(loaded?.longPeriod);
    expect(reloaded?.briefingCritical).toEqual(validateBriefingCriticalForWrite(semanticBriefingSlice()));
  });

  it("version 不一致は全体を破棄し、構造不正な domain だけを空にする", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), version: 2 }), "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state(), heat: "invalid" }), "utf8");
    expect(new StandbyPersistence(path).load()).toEqual(expect.objectContaining({ heat: [], seen: state().seen }));
  });

  it("root 6 collection は不正 entry だけを除外し、valid の値と順序を保つ", () => {
    const path = tempPath();
    const heat = [rootHeat("heat-a", "2026-07-21"), { key: "broken" }, rootHeat("heat-b", "2026-07-22")];
    const typhoons = [rootTyphoon("TC-A"), { key: "broken" }, rootTyphoon("TC-B")];
    const volcanoes = [rootVolcano("V-A"), { code: "broken", alertLevel: "bad" }, rootVolcano("V-B")];
    const tornado = [rootTornado("office-a"), { publishingOffice: "broken", areas: "bad" }, rootTornado("office-b")];
    const longPeriod = [rootLongPeriod("lg-a"), { eventId: "broken", maxLgInt: "bad" }, rootLongPeriod("lg-b")];
    const seen = [rootSeen("heat:a"), { key: "broken", revision: "bad" }, rootSeen("tornado:b")];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(), heat, typhoons, volcanoes, tornado, longPeriod, seen,
    }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect(loaded?.heat.map((entry) => entry.key)).toEqual(["heat-a", "heat-b"]);
    expect(loaded?.typhoons.map((entry) => entry.typhoon.typhoonKey)).toEqual(["TC-A", "TC-B"]);
    expect(loaded?.volcanoes.map((entry) => entry.code)).toEqual(["V-A", "V-B"]);
    expect(loaded?.tornado?.map((entry) => entry.publishingOffice)).toEqual(["office-a", "office-b"]);
    expect(loaded?.longPeriod?.map((entry) => entry.eventId)).toEqual(["lg-a", "lg-b"]);
    expect(loaded?.seen.map((entry) => entry.key)).toEqual(["heat:a", "tornado:b"]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.typhoons unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.volcanoes unit=code discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.tornado unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.longPeriod unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.seen unit=entry discarded=1 retained=2 reason=invalid-entry",
    ]);
    warn.mockRestore();
  });

  it.each([
    ["heat", "root.heat", "entry"],
    ["typhoons", "root.typhoons", "entry"],
    ["volcanoes", "root.volcanoes", "code"],
    ["tornado", "root.tornado", "entry"],
    ["longPeriod", "root.longPeriod", "entry"],
    ["seen", "root.seen", "entry"],
  ] as const)("root %s の all-invalid は空の present domain を返す", (field, domain, unit) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), [field]: [{ broken: true }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>)[field]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `[standby-persistence] salvage source=display-active-state-v1.json domain=${domain} unit=${unit} discarded=1 retained=0 reason=invalid-entry`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([
    ["heat", "root.heat"],
    ["typhoons", "root.typhoons"],
    ["volcanoes", "root.volcanoes"],
    ["tornado", "root.tornado"],
    ["longPeriod", "root.longPeriod"],
    ["seen", "root.seen"],
  ] as const)("root %s の invalid-container はその domain だけを空にする", (field, domain) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), [field]: "invalid-container" }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>)[field]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `[standby-persistence] discard source=display-active-state-v1.json domain=${domain} unit=domain reason=invalid-container`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("malformed root seen は他 domain の tombstone を巻き込まず、quakeHost 不正時は longPeriod hosted を false にする", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state({
        seen: [rootSeen("tornado:kept"), { key: "broken-seen", revision: "bad", forgetAtMs: T0 } as never],
        longPeriod: [rootLongPeriod("lg-kept", true)],
        quakeHost: { eventId: 42, maxIntRank: 4, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60_000 } as never,
        floods: {
          events: [],
          seen: [rootSeen("flood:cancelled")],
        },
      }),
    }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.seen).toEqual([rootSeen("tornado:kept")]);
    expect(loaded?.floods?.seen).toEqual([rootSeen("flood:cancelled")]);
    expect(loaded?.longPeriod).toEqual([rootLongPeriod("lg-kept", true)]);
    expect(loaded?.quakeHost).toBeNull();
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 1);
    expect(restored.exportActiveState().longPeriod).toEqual([
      expect.objectContaining({ eventId: "lg-kept", hosted: false }),
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[standby-persistence] discard source=display-active-state-v1.json domain=root.quakeHost unit=domain reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.seen unit=entry discarded=1 retained=1 reason=invalid-entry",
    ]);
    warn.mockRestore();
  });

  it("壊れた JSON を破棄する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken", "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
  });

  it("salvage した raw bytes を canonical write より先に同一directoryへ退避する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = Buffer.from(`${JSON.stringify({ ...state(), heat: [{ key: "broken" }] }, null, 2)}\n`, "utf8");
    writeFileSync(path, raw);
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();

    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]!))).toEqual(raw);
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 0,
      persistenceSalvageBackupRecovered: 0,
      pendingSources: 0,
    });
  });

  it("salvage warn は source/domain ごとに固定 token と bundle 数を一回だけ出す", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(new StandbyPersistence(path).load()?.heat).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("backup 失敗中は rename せず、次回 write で退避成功後に最新 pending だけを保存する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const originalOpenSync = fs.openSync;
    const openSync = vi.spyOn(fs, "openSync");
    openSync.mockImplementation((file, flags, ...args) => {
      if (typeof file === "string" && file.endsWith(".salvage-backup") && flags === "wx") {
        const error = new Error("backup blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync(file, flags, ...args);
    });
    persistence.schedule(state({ savedAt: "old" }));
    await persistence.__test_writePending();
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1, persistenceSalvageBackupRecovered: 0, pendingSources: 1,
    });
    openSync.mockRestore();
    persistence.schedule(state({ savedAt: "latest" }));
    await persistence.__test_writePending();
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1, persistenceSalvageBackupRecovered: 1, pendingSources: 0,
    });
    expect(new StandbyPersistence(path).load()?.savedAt).toBe("latest");
  });

  it("salvage backup の同一 timestamp 衝突は wx suffix で回避する", async () => {
    vi.useFakeTimers({ now: T0 });
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = Buffer.from(`${JSON.stringify({ ...state(), heat: [{ key: "broken" }] })}\n`, "utf8");
    writeFileSync(path, raw);
    const timestamp = new Date(T0).toISOString().replace(/[:.]/g, "-");
    const collided = join(dirname(path), `${path.split("/").at(-1)}.${timestamp}.0.salvage-backup`);
    writeFileSync(collided, "collision", "utf8");

    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();

    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toEqual([
      `${path.split("/").at(-1)}.${timestamp}.0.salvage-backup`,
      `${path.split("/").at(-1)}.${timestamp}.1.salvage-backup`,
    ]);
    expect(readFileSync(join(dirname(path), `${path.split("/").at(-1)}.${timestamp}.1.salvage-backup`)))
      .toEqual(raw);
  });

  it.each([0, -1] as const)("salvage backup write の戻り値 %s 以下は block として扱う", async (written) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const writeSync = vi.spyOn(fs, "writeSync").mockReturnValue(written);

    persistence.schedule(state({ savedAt: "blocked" }));
    await persistence.__test_writePending();

    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1,
      persistenceSalvageBackupRecovered: 0,
      pendingSources: 1,
    });
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
    expect(new StandbyPersistence(path).load()?.savedAt).toBe(state().savedAt);
    writeSync.mockRestore();
  });

  it("salvage backup の file fsync 失敗はこの試行で作成した backup を残さない", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const fsyncSync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("fsync blocked");
    });

    persistence.schedule(state({ savedAt: "blocked" }));
    await persistence.__test_writePending();

    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
    fsyncSync.mockRestore();
  });

  it("salvage backup は file fsync → directory fsync の順に呼ぶ", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const openSync = vi.spyOn(fs, "openSync");
    const fsyncSync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);

    persistence.schedule(state());
    await persistence.__test_writePending();

    expect(openSync.mock.calls.map(([target]) => target)).toEqual([
      expect.stringMatching(/\.salvage-backup$/),
      dirname(path),
    ]);
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(fsyncSync.mock.calls[0]?.[0]).toBe(openSync.mock.results[0]?.value);
    expect(fsyncSync.mock.calls[1]?.[0]).toBe(openSync.mock.results[1]?.value);
    fsyncSync.mockRestore();
    openSync.mockRestore();
  });

  it("v2 採用側と v1 fallback 側の両方に異常があれば、両 source を個別に退避する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const seedPersistence = new StandbyPersistence(path, 0);
    seedPersistence.save(state());
    const v2Path = standbyPersistenceV2Path(path);
    const v2Raw = {
      ...JSON.parse(readFileSync(v2Path, "utf8")) as Record<string, unknown>,
      heat: [{ key: "broken-v2" }],
    };
    const v1Raw = {
      ...JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
      typhoons: [{ key: "broken-v1" }],
    };
    const v2Bytes = Buffer.from(`${JSON.stringify(v2Raw)}\n`, "utf8");
    const v1Bytes = Buffer.from(`${JSON.stringify(v1Raw)}\n`, "utf8");
    writeFileSync(v2Path, v2Bytes);
    writeFileSync(path, v1Bytes);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const persistence = new StandbyPersistence(path, 0);

    expect(persistence.load()?.heat).toEqual([]);
    expect(persistence.salvageBackupDiagnostics().pendingSources).toBe(2);
    persistence.schedule(state());
    await persistence.__test_writePending();

    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^display-active-state-v2\.json\..+\.salvage-backup$/),
      expect.stringMatching(/^display-active-state-v1\.json\..+\.salvage-backup$/),
    ]));
    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(readFileSync(join(dirname(path), backups.find((name) => name.startsWith("display-active-state-v2.json."))!)))
      .toEqual(v2Bytes);
    expect(readFileSync(join(dirname(path), backups.find((name) => name.startsWith("display-active-state-v1.json."))!)))
      .toEqual(v1Bytes);
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "[standby-persistence] salvage source=display-active-state-v2.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.typhoons unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
  });

  it("通常 load では salvage backup を作らない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 0);
    persistence.save(state());
    expect(persistence.load()).not.toBeNull();
    persistence.schedule(state());
    await persistence.__test_writePending();
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
  });

  it("canonical rewrite 後の再起動では salvage warn と backup を重複させない", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const first = new StandbyPersistence(path, 0);
    expect(first.load()?.heat).toEqual([]);
    first.schedule(state());
    await first.__test_writePending();
    const backupCount = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup")).length;
    expect(backupCount).toBe(1);

    const second = new StandbyPersistence(path, 0);
    expect(second.load()).not.toBeNull();
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toHaveLength(backupCount);
    expect(warn.mock.calls.filter(([message]) =>
      message === "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    )).toHaveLength(1);
  });

  it("洪水 EventID state と seen revision を検証して永続化する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{ riverKey: "river-1", riverName: "多摩川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString() }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({
      ...persistence.load(), floods: { events: "invalid", seen: [] },
    }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it("一部の洪水 EventID が壊れていても、有効な EventID とカードを復元する", () => {
    const path = tempPath();
    const validEvent = {
      eventId: "flood-valid",
      revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 12 * 60 * 60_000,
      rivers: [{
        riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [validEvent, { eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "flood-valid", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods?.events).toEqual([validEvent]);
    expect(loaded?.floods?.seen.map((entry) => entry.key)).toEqual(["flood-valid", "cancelled-only"]);
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "broken",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-2", riverName: "利根川", level: "L3", levelRank: 30,
        kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()?.sourceEventIds).toContain("broken");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "flood"))
      .toEqual(expect.objectContaining({ restored: true }));
  });

  it("active event が全て壊れても、無関係な cancellation tombstone を保全して古い再送を拒否する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [{ eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "2" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods).toEqual({
      events: [],
      seen: [{
        key: "cancelled-only",
        revision: { reportTimeMs: T0, serial: "2" },
        forgetAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "cancelled-only",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-old", riverName: "古い川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()).not.toBeNull();
  });

  it("代表観測所 station 込みで round-trip し、壊れた station は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // station.name が数値 (不正) → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: 42, levelM: 3.42, trend: "rising", thresholdLabel: null },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({ ...persistence.load(), ...broken, version: 2 }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it("hydrograph 込みで round-trip し、壊れた hydrograph は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過",
              hydrograph: {
                points: [
                  { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
                  { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
                  { dateTime: new Date(T0 + 7_200_000).toISOString(), valueM: 3.55, phase: "forecast" },
                ],
                dangerLevelM: 3.2,
              },
            },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // hydrograph.points[].phase が不正 → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points: [{ dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "bogus" }], dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({ ...persistence.load(), ...broken, version: 2 }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it.each([
    // 先頭が forecast / 途中に observed が来る逆順 (描画側は先頭=現況固定のため実測と予測を逆表示する)
    ["phase 逆順 ([forecast, observed])", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.55, phase: "forecast" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.42, phase: "observed" },
    ]],
    // 2 点目以降に observed が混ざる
    ["2 点目 observed", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.55, phase: "observed" },
    ]],
    // points 空
    ["空 points", []],
    // 有効値ゼロ (全 null)
    ["全 null 値", [
      { dateTime: new Date(T0).toISOString(), valueM: null, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
    ]],
  ] as const)("壊れた hydrograph (%s) は洪水 domain を破棄する", (_label, points) => {
    const path = tempPath();
    const persisted = state({});
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points, dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(path, JSON.stringify(broken), "utf8");
    const persistence = new StandbyPersistence(path);
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it("typhoon/volcano/tornado/longPeriod/nankai を深く検証し、壊れた domain だけを破棄して起動を続ける", () => {
    const path = tempPath();
    const malformed = {
      ...state(),
      typhoons: [{}],
      volcanoes: [{ code: "V-1" }],
      tornado: [{ sourceEventId: "t", publishingOffice: 42 }],
      longPeriod: [{ eventId: "q", hosted: "yes" }],
      nankaiTrough: { sourceEventId: "n", expiresAtMs: "later" },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(malformed), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).toEqual(expect.objectContaining({
      heat: state().heat,
      typhoons: [],
      volcanoes: [],
      tornado: [],
      longPeriod: [],
      nankaiTrough: null,
    }));
    expect(() => new StandbyStateStore().restoreActiveState(loaded!, T0 + 1)).not.toThrow();
  });

  it("longPeriod safetyRank は明示 null と旧 field 欠落を区別し、label 矛盾を fail-closed にする", () => {
    const revision = { reportTimeMs: T0, serial: "1" };
    const expiresAtMs = T0 + 60_000;
    const invalidPath = tempPath();
    mkdirSync(dirname(invalidPath), { recursive: true });
    writeFileSync(invalidPath, JSON.stringify(state({
      longPeriod: [{ eventId: "Q1", maxLgInt: "4", safetyRank: null, revision, hosted: true, expiresAtMs }],
    })), "utf8");
    expect(new StandbyPersistence(invalidPath).load()?.longPeriod).toEqual([]);

    const legacyPath = tempPath();
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(state({
      quakeHost: { eventId: "Q1", maxIntRank: 5, revision, expiresAtMs },
      longPeriod: [{ eventId: "Q1", maxLgInt: "4", revision, hosted: true, expiresAtMs }],
    })), "utf8");
    const loaded = new StandbyPersistence(legacyPath).load()!;
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);
    expect(restored.snapshotItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "longPeriod", severity: "critical" }),
    ]));
  });
});

describe("StandbyStateStore persistence", () => {
  function weatherAlert(source: "vpws50" | "vpww56", updatedAt = new Date(T0).toISOString()) {
    return {
      source,
      label: source === "vpws50" ? "気象警報" : "土砂災害警戒情報",
      role: "weatherWarning" as const,
      totalAreas: 1,
      items: [{
        kind: source === "vpws50" ? "L3 大雨警報" : "L4 土砂災害警戒情報",
        phenomenonKey: source === "vpws50" ? "rain" : "landslide",
        displaySeverity: source === "vpws50" ? "officialL3" : "officialL4",
        rank: "warning" as const,
        shownAreas: ["東京都"],
        shownAreaCodes: ["130000"],
        omittedAreaCount: 0,
      }],
      updatedAt,
    };
  }

  it("live の WindPart 欠落を診断なし missing として save→load→restore する", () => {
    const live = new StandbyStateStore();
    live.applyEvent({
      id: "typhoon-wind-missing",
      domain: "typhoonAnalysis",
      eventId: "TC-wind-missing",
      serial: "1",
      reportDateTime: new Date(T0).toISOString(),
      isCancellation: false,
      raw: {
        type: "VPTW60",
        infoType: "発表",
        eventId: "TC-wind-missing",
        serial: "1",
        name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS" },
          center: {
            location: "ocean",
            pressureHpa: 990,
            pressureHpaValue: numericValue(990),
            moveDirection: "N",
            moveSpeedKmh: 20,
            moveSpeedKmhValue: numericValue(20),
          },
          wind: null,
        }],
        lifecycle: "active",
      },
    } as unknown as PresentationEvent, T0);

    const liveState = live.exportActiveState();
    expect(liveState.typhoons[0]).toMatchObject({
      maxWindMsValue: { raw: null, value: null, presence: "missing" },
      maxGustMsValue: { raw: null, value: null, presence: "missing" },
    });
    expect(liveState.typhoons[0]!.maxWindMsValue).not.toHaveProperty("diagnostics");
    expect(liveState.typhoons[0]!.maxGustMsValue).not.toHaveProperty("diagnostics");
    expect(live.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject({
        maxWindMsSemantic: { presence: "missing", label: null, badge: null, render: false },
        maxGustMsSemantic: { presence: "missing", label: null, badge: null, render: false },
      });

    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(liveState);
    const loaded = persistence.load()!;
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);

    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      maxWindMsValue: { raw: null, value: null, presence: "missing" },
      maxGustMsValue: { raw: null, value: null, presence: "missing" },
    });
    expect(restored.exportActiveState().typhoons[0]!.maxWindMsValue).not.toHaveProperty("diagnostics");
    expect(restored.exportActiveState().typhoons[0]!.maxGustMsValue).not.toHaveProperty("diagnostics");
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject({
        maxWindMsSemantic: { presence: "missing", label: null, badge: null, render: false },
        maxGustMsSemantic: { presence: "missing", label: null, badge: null, render: false },
      });
  });

  it.each([
    ["pressure", "missing"],
    ["pressure", "empty"],
    ["pressure", "qualitative"],
    ["pressure", "range"],
    ["maxWind", "missing"],
    ["maxWind", "empty"],
    ["maxWind", "qualitative"],
    ["maxWind", "range"],
  ] as const)("%s の value→%s→value は live／restart とも差分・trend を出さない", (
    field,
    presence,
  ) => {
    const exact = numericValue(field === "pressure" ? 990 : 25);
    const special = transitionSpecialValue(presence);

    const live = new StandbyStateStore();
    live.applyEvent(typhoonTransitionEvent("1", field, exact), T0);
    live.applyEvent(typhoonTransitionEvent("2", field, special), T0 + 60_000);
    expectNoTyphoonNumericTrend(live);
    live.applyEvent(typhoonTransitionEvent("3", field, exact), T0 + 120_000);
    expectNoTyphoonNumericTrend(live);

    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent(typhoonTransitionEvent("1", field, exact), T0);
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(beforeRestart.exportActiveState());
    const restored = new StandbyStateStore();
    restored.restoreActiveState(persistence.load()!, T0 + 1);
    restored.applyEvent(typhoonTransitionEvent("2", field, special), T0 + 60_000);
    expectNoTyphoonNumericTrend(restored);
    restored.applyEvent(typhoonTransitionEvent("3", field, exact), T0 + 120_000);
    expectNoTyphoonNumericTrend(restored);
  });

  it("気象警報を実ファイルへ書き、新しい store でカード現況を復元する", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    expect(restarted.snapshotWeatherAlerts()).toEqual([alert]);
    const display = new DisplayStateStore(
      () => restarted.snapshotItems(),
      undefined,
      undefined,
      undefined,
      () => restarted.snapshotWeatherAlerts(),
    );
    expect(display.snapshot(1, T0 + 60_000).weatherAlerts).toEqual([alert]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([
      expect.objectContaining({ source: "vpws50", alerts: [alert] }),
    ]);
  });

  it("weatherAlerts の壊れた source だけを破棄し、正常な別 source を復元する", () => {
    const path = tempPath();
    const vpws50 = weatherAlert("vpws50");
    const persisted = state({
      weatherAlerts: [{
        source: "vpws50",
        alerts: [vpws50],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...persisted,
      weatherAlerts: [
        { source: "vpww56", alerts: "broken", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 1 },
        ...persisted.weatherAlerts!,
      ],
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual(persisted.weatherAlerts);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([vpws50]);
  });

  it("weatherAlerts フィールドのない旧ファイルを空の現況として復元する", () => {
    const path = tempPath();
    const legacy = state();
    delete legacy.weatherAlerts;
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual([]);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
  });

  it("期限切れの weatherAlerts は新しい store へ復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    new StandbyPersistence(path).save(state({
      weatherAlerts: [{
        source: "vpws50",
        alerts: [alert],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 60_000,
      }],
    }));

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("解除で alerts が空になった現況は、再起動後もカードを復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    live.applyWeatherAlerts("vpws50", [], new Date(T0 + 60_000).toISOString(), "2", T0 + 60_000);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 120_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("実 VXKO50 を store に適用して実ファイルへ書き、新しい store で河川カードを復元する", () => {
    const msg = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const parsed = parseFloodForecast(msg);
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    const outcome: FloodForecastOutcome = {
      domain: "floodForecast",
      msg,
      headType: msg.head.type,
      statsCategory: "floodForecast",
      parsed,
      diff: null,
      maxLevel: "unknown",
      maxRank: -1,
      stats: { shouldRecord: true, eventId: parsed.eventId },
      presentation: {
        frameLevel: "info",
        floodStateMutationAccepted: true,
        floodActiveEventIds: [parsed.eventId],
      },
    };
    const event = {
      ...fromFloodForecastOutcome(outcome),
      reportDateTime: new Date(T0).toISOString(),
    };
    const live = new StandbyStateStore();
    live.applyEvent(event, T0);
    expect(live.snapshotItems().find((item) => item.kind === "flood")).toBeDefined();

    const path = tempPath();
    new StandbyPersistence(path).save(live.exportActiveState());
    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    const flood = restarted.snapshotItems().find((item) => item.kind === "flood");
    expect(flood).toEqual(expect.objectContaining({
      restored: true,
      data: { rivers: expect.arrayContaining([
        expect.objectContaining({ riverName: "緑川", level: "L4" }),
      ]) },
    }));
  });

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

  it("typhoon と level 3 + 噴火イベントの volcano state が実ファイル round-trip する", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, pressureDeltaHpa: -5,
          maxWindMs: 25, maxGustMs: 35, maxWindDeltaMs: 3, intensityTrend: "developing",
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: 3,
        alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制", "避難準備"],
        alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0 - 60_000).toISOString(),
          plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        },
        latestEventId: "eruption-event-1",
        eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: { reportTimeMs: T0, serial: "1" },
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(persisted);
    const loaded = persistence.load();
    const migratedPlumeHeight = legacyDisplayPlumeHeightSemantics(2500, false);
    expect(loaded).toEqual(expect.objectContaining({
      ...persisted,
      typhoons: [expect.objectContaining({
        ...persisted.typhoons[0],
        pressureHpaValue: { raw: "990", value: 990, condition: null, description: null, presence: "value" },
        maxWindMsValue: { raw: "25", value: 25, condition: null, description: null, presence: "value" },
        maxGustMsValue: { raw: "35", value: 35, condition: null, description: null, presence: "value" },
        moveSpeedKmhValue: { raw: "20", value: 20, condition: null, description: null, presence: "value" },
      })],
      volcanoes: [expect.objectContaining({
        ...persisted.volcanoes[0],
        latestEvent: expect.objectContaining({
          plumeHeightM: 2500,
          plumeHeightUnknown: false,
          ...migratedPlumeHeight,
        }),
      })],
      version: 2,
      telegramFoundation: {
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: false,
          state: null,
          gateEntries: [],
        },
        tsunami: {
          active: null, keyedActive: [], legacyActive: null,
          observations: { VTSE51: [], VTSE52: [] }, gateEntries: [],
        },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: { gateEntries: [] },
      },
    }));

    const store = new StandbyStateStore();
    store.restoreActiveState(loaded!, T0 + 60_000);
    expect(store.snapshotItems().map((item) => item.kind).sort()).toEqual(["heat", "typhoon", "volcano"]);
    expect(store.snapshotItems().every((item) => item.restored)).toBe(true);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindMs: 25, maxGustMs: 35,
      maxWindDeltaMs: 3, intensityTrend: "developing",
    });
    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: 3,
      alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制", "避難準備"],
      latestEvent: {
        label: "噴火", craterName: "山頂火口",
        eventDateTime: new Date(T0 - 60_000).toISOString(),
        plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        ...migratedPlumeHeight,
      },
    });

    store.applyEvent({
      id: "typhoon-2",
      domain: "typhoonAnalysis",
      eventId: "TC-1",
      serial: "2",
      reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false,
      raw: {
        type: "VPTW60",
        infoType: "issue",
        eventId: "TC-1",
        serial: "2",
        name: { name: "Alpha", nameKana: null, number: "2601", remark: null },
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS" },
          center: { location: "ocean", pressureHpa: 985, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 30 },
        }],
      },
    } as never, T0 + 120_000);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindDeltaMs: 5, intensityTrend: "developing",
    });
  });

  it("typhoon canonical 全 field と diagnostics を保存し、restore 後も semantic を再生成できる", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1",
        sourceEventId: "typhoon-special",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: null, maxWindMs: 25, maxGustMs: null,
          moveDirection: "N", moveSpeedKmh: null,
          reportDateTime: new Date(T0).toISOString(),
        },
        pressureHpaValue: {
          raw: "解析不能", value: null, condition: "解析不能", description: null,
          presence: "unknown", diagnostics: ["unmappedSpecialValue"],
        },
        maxWindMsValue: {
          raw: "25", value: null, condition: "以上", description: null,
          presence: "range", lowerBound: 25,
          rawLowerBound: "25",
        },
        maxGustMsValue: {
          raw: "不明", value: null, condition: null, description: "観測不能",
          presence: "unknown", diagnostics: ["specialValueConflict"],
        },
        moveSpeedKmhValue: {
          raw: "", value: null, condition: "停滞気味", description: null,
          presence: "qualitative", diagnostics: ["unmappedSpecialValue"],
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const path = tempPath();
    new StandbyPersistence(path).save(persisted);
    const loaded = new StandbyPersistence(path).load()!;

    expect(loaded.typhoons[0]).toMatchObject({
      pressureHpaValue: persisted.typhoons[0]!.pressureHpaValue,
      maxWindMsValue: persisted.typhoons[0]!.maxWindMsValue,
      maxGustMsValue: persisted.typhoons[0]!.maxGustMsValue,
      moveSpeedKmhValue: persisted.typhoons[0]!.moveSpeedKmhValue,
    });
    expect(Object.hasOwn(loaded.typhoons[0]!.maxWindMsValue!, "rawUpperBound")).toBe(false);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      pressureHpaValue: persisted.typhoons[0]!.pressureHpaValue,
      maxWindMsValue: persisted.typhoons[0]!.maxWindMsValue,
      maxGustMsValue: persisted.typhoons[0]!.maxGustMsValue,
      moveSpeedKmhValue: persisted.typhoons[0]!.moveSpeedKmhValue,
    });
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureHpaSemantic: { presence: "unknown", label: "不明", rank: { kind: "unranked" } },
      maxWindMsSemantic: {
        presence: "range", label: "25m/s以上", badge: "≥",
        rank: { kind: "range", lowerBound: 25, upperBound: null },
      },
      maxGustMsSemantic: { presence: "unknown", label: "不明" },
      moveSpeedKmhSemantic: { presence: "qualitative", label: "停滞気味" },
    });
  });

  it.each(
    (["Pressure", "WindSpeed", "MovementSpeed"] as const).flatMap((domain) =>
      (["", " ", "　"] as const).map((raw) => [domain, raw] as const),
    ),
  )("typhoon %s の empty raw %j は save→load→restore 後も byte-for-byte で一致する", (
    domain,
    raw,
  ) => {
    const emptyValue: SpecialValue<number> = {
      raw,
      value: null,
      condition: null,
      description: null,
      presence: "empty",
    };
    const pressureHpaValue = domain === "Pressure" ? emptyValue : numericValue(990);
    const maxWindMsValue = domain === "WindSpeed" ? emptyValue : numericValue(25);
    const moveSpeedKmhValue = domain === "MovementSpeed" ? emptyValue : numericValue(20);
    const persisted = state({
      typhoons: [{
        key: `typhoon:empty-raw:${domain}`,
        sourceEventId: `typhoon-empty-raw-${domain}`,
        typhoon: {
          typhoonKey: `empty-raw:${domain}`,
          name: "Alpha",
          nameKana: null,
          remark: null,
          typhoonNumber: "2601",
          category: "TS",
          location: "ocean",
          pressureHpa: pressureHpaValue.presence === "value" ? pressureHpaValue.value : null,
          maxWindMs: maxWindMsValue.presence === "value" ? maxWindMsValue.value : null,
          maxGustMs: 35,
          moveDirection: "N",
          moveSpeedKmh: moveSpeedKmhValue.presence === "value" ? moveSpeedKmhValue.value : null,
          reportDateTime: new Date(T0).toISOString(),
        },
        pressureHpaValue,
        maxWindMsValue,
        maxGustMsValue: numericValue(35),
        moveSpeedKmhValue,
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    const loaded = persistence.load();
    if (loaded == null) throw new Error("typhoon empty raw persistence load が null");
    const field = domain === "Pressure"
      ? "pressureHpaValue"
      : domain === "WindSpeed"
        ? "maxWindMsValue"
        : "moveSpeedKmhValue";
    expect(loaded.typhoons[0]?.[field]?.raw).toBe(raw);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]?.[field]?.raw).toBe(raw);
  });

  it("scalar-only typhoon snapshot を読込時だけ canonical 化し、null の曖昧さを診断へ残す", () => {
    const path = tempPath();
    const legacy = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "legacy-typhoon",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: 990, maxWindMs: null,
          moveDirection: "N", moveSpeedKmh: 20,
          reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.typhoons[0]).toMatchObject({
      pressureHpaValue: { raw: "990", value: 990, presence: "value" },
      maxWindMsValue: {
        raw: null, value: null, presence: "unknown", diagnostics: ["legacyNullUnknown"],
      },
      maxGustMsValue: {
        raw: null, value: null, presence: "unknown", diagnostics: ["legacyNullUnknown"],
      },
      moveSpeedKmhValue: { raw: "20", value: 20, presence: "value" },
    });
  });

  it.each([
    [
      "lower-only",
      {
        raw: "25", value: null, condition: "以上", description: null,
        presence: "range", lowerBound: 25, rawLowerBound: "25",
      },
      {
        lowerBound: 25, upperBound: undefined,
        rawLowerBound: "25", rawUpperBound: undefined,
      },
    ],
    [
      "upper-only",
      {
        raw: "30", value: null, condition: "以下", description: null,
        presence: "range", upperBound: 30, rawUpperBound: "30",
      },
      {
        lowerBound: undefined, upperBound: 30,
        rawLowerBound: undefined, rawUpperBound: "30",
      },
    ],
  ] as const)("typhoon canonical の %s raw bound が save→load→restore で独立に往復する", (
    _label,
    maxWindMsValue,
    expected,
  ) => {
    const path = tempPath();
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "bounded-typhoon",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: 990, maxWindMs: 25,
          moveDirection: "N", moveSpeedKmh: 20,
          reportDateTime: new Date(T0).toISOString(),
        },
        maxWindMsValue,
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    new StandbyPersistence(path).save(persisted);

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.typhoons).toHaveLength(1);
    expect(loaded.typhoons[0]!.maxWindMsValue).toMatchObject(maxWindMsValue);
    for (const [key, bound] of Object.entries(expected)) {
      expect(loaded.typhoons[0]!.maxWindMsValue?.[key as keyof typeof expected]).toBe(bound);
    }

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]!.maxWindMsValue).toEqual(
      loaded.typhoons[0]!.maxWindMsValue,
    );
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]
      ?.maxWindMsSemantic).toMatchObject({
        lowerBound: expected.lowerBound ?? null,
        upperBound: expected.upperBound ?? null,
        rawLowerBound: expected.rawLowerBound ?? null,
        rawUpperBound: expected.rawUpperBound ?? null,
      });
  });

  it("volcano canonical 全 field・diagnostics・rank を実ファイル round-trip する", () => {
    const crater = projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "",
        value: null,
        condition: "雲中",
        description: "火口上2000mから4000m",
        presence: "qualitative",
        lowerBound: 2000,
        rawLowerBound: "2000",
        rawUpperBound: "4000",
        diagnostics: ["specialValueConflict"],
      },
    })!;
    const seaLevel = projectPlumeHeightSemantic({
      reference: "aboveSeaLevel",
      unit: "FT",
      value: {
        raw: "観測できず",
        value: null,
        condition: null,
        description: null,
        presence: "unknown",
      },
    })!;
    const persisted = state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null,
        alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0).toISOString(),
          plumeHeightM: 2000, plumeHeightUnknown: false,
          plumeHeightAboveCraterSemantic: crater,
          plumeHeightAboveSeaLevelSemantic: seaLevel,
          plumeDirection: "南東",
        },
        latestEventId: "event-1",
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"],
        alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    const path = tempPath();
    new StandbyPersistence(path).save(persisted);

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0].latestEvent).toEqual(persisted.volcanoes[0].latestEvent);
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightAboveCraterSemantic: expect.objectContaining({
        presence: "qualitative",
        lowerBound: 2000,
        upperBound: null,
        badge: "≥",
      }),
    }));
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);
    expect(restored.exportActiveState().volcanoes[0].latestEvent)
      .toEqual(persisted.volcanoes[0].latestEvent);
  });

  it.each([
    [
      "unknown",
      null,
      true,
      { presence: "unknown", condition: "不明", diagnostics: [] },
    ],
    [
      "legacy null",
      null,
      false,
      { presence: "missing", condition: null, diagnostics: ["legacyNullUnknown"] },
    ],
  ] as const)("旧 volcano scalar snapshot を %s へ読込 migration する", (
    _label,
    plumeHeightM,
    plumeHeightUnknown,
    expected,
  ) => {
    const path = tempPath();
    new StandbyPersistence(path).save(state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: null, eventDateTime: null,
          plumeHeightM, plumeHeightUnknown, plumeDirection: null,
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"],
        alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    }));
    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightAboveCraterSemantic: expect.objectContaining(expected),
      plumeHeightAboveSeaLevelSemantic: expect.objectContaining({
        reference: "aboveSeaLevel", unit: "FT", presence: "missing",
      }),
    }));
  });

  it("片側 raw bound field の省略を受理し null へ正規化する", () => {
    const path = tempPath();
    const semantic = projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "", value: null, condition: "雲中", description: null,
        presence: "qualitative", rawLowerBound: "2000",
        diagnostics: ["specialValueConflict"],
      },
    })!;
    const oneSided = structuredClone(semantic) as unknown as Record<string, unknown>;
    delete oneSided.rawUpperBound;
    const persisted = {
      ...state(),
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: null, eventDateTime: null,
          plumeHeightM: 3000, plumeHeightUnknown: false,
          plumeHeightAboveCraterSemantic: oneSided,
          plumeHeightAboveSeaLevelSemantic: legacyDisplayPlumeHeightSemantics(3000, false)
            .plumeHeightAboveSeaLevelSemantic,
          plumeDirection: null,
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"], alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(persisted), "utf8");
    expect(new StandbyPersistence(path).load()?.volcanoes[0].latestEvent)
      .toEqual(expect.objectContaining({
        plumeHeightAboveCraterSemantic: expect.objectContaining({
          presence: "qualitative",
          rawLowerBound: "2000",
          rawUpperBound: null,
        }),
      }));
  });

  it("壊れた plume semantic だけを scalar へ縮退し別火山と tombstone を保全する", () => {
    const path = tempPath();
    const invalidSemantic = structuredClone(projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "2500", value: 2500, condition: null, description: null, presence: "value",
      },
    })!) as unknown as Record<string, unknown>;
    invalidSemantic.rank = { kind: "invalid" };
    const volcano = (
      code: string,
      plumeHeightM: number,
      craterSemantic?: unknown,
    ) => ({
      code,
      name: `Mount ${code}`,
      alertLevel: null,
      alertExpiresAtMs: null,
      latestEvent: {
        label: "噴火",
        craterName: null,
        eventDateTime: new Date(T0).toISOString(),
        plumeHeightM,
        plumeHeightUnknown: false,
        ...(craterSemantic === undefined
          ? {}
          : {
              plumeHeightAboveCraterSemantic: craterSemantic,
              plumeHeightAboveSeaLevelSemantic:
                legacyDisplayPlumeHeightSemantics(plumeHeightM, false)
                  .plumeHeightAboveSeaLevelSemantic,
            }),
        plumeDirection: null,
      },
      latestEventId: `event-${code}`,
      eventExpiresAtMs: T0 + 24 * 60 * 60_000,
      sourceEventIds: [`volcano-${code}`],
      alertRevision: null,
      eventRevision: { reportTimeMs: T0, serial: "1" },
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      volcanoes: [volcano("V-1", 2500, invalidSemantic), volcano("V-2", 3000)] as never,
      seen: [{
        key: "volcano:event:tombstone",
        revision: { reportTimeMs: T0, serial: "2" },
        forgetAtMs: T0 + 2 * 24 * 60 * 60_000,
      }],
    })), "utf8");

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes.map((entry) => entry.code)).toEqual(["V-1", "V-2"]);
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightM: 2500,
      plumeHeightAboveCraterSemantic: expect.objectContaining({
        presence: "value",
        value: 2500,
        raw: "2500",
      }),
    }));
    expect(loaded.seen).toContainEqual(expect.objectContaining({
      key: "volcano:event:tombstone",
      revision: { reportTimeMs: T0, serial: "2" },
    }));
  });

  it("latestEventId のない旧形式 VFVO56 state を実ファイル復元し、単一候補なら空コード取消を適用する", () => {
    const issueMsg = createMockWsDataMessage(FIXTURE_VFVO56_FLASH_1);
    const cancelMsg = createMockWsDataMessage(FIXTURE_VFVO56_FLASH_4);
    const issueRaw = parseVolcanoTelegram(issueMsg)!;
    const cancelRaw = parseVolcanoTelegram(cancelMsg)!;
    const issueAt = Date.parse(issueRaw.reportDateTime);
    const cancelAt = Date.parse(cancelRaw.reportDateTime);
    const eventId = "20140927120000_312";
    const event = (id: string, raw: typeof issueRaw, msg: typeof issueMsg) => ({
      id,
      domain: "volcano",
      eventId,
      serial: msg.xmlReport?.head.serial ?? null,
      reportDateTime: raw.reportDateTime,
      infoType: raw.infoType,
      isCancellation: raw.infoType === "取消",
      raw,
    }) as never;

    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent(event("issue", issueRaw, issueMsg), issueAt);
    const path = tempPath();
    const active = beforeRestart.exportActiveState();
    const { latestEventId: _legacyMissing, ...legacyVolcano } = active.volcanoes[0];
    new StandbyPersistence(path).save({ ...active, volcanoes: [legacyVolcano] });
    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0]).not.toHaveProperty("latestEventId");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, cancelAt);
    expect(restored.exportActiveState().volcanoes[0]?.latestEventId).toBeNull();

    restored.applyEvent(event("cancel", cancelRaw, cancelMsg), cancelAt);
    new StandbyPersistence(path).save(restored.exportActiveState());
    const afterRestart = new StandbyStateStore();
    afterRestart.restoreActiveState(new StandbyPersistence(path).load()!, cancelAt + 1);
    expect(afterRestart.snapshotItems()).toEqual([]);
    expect(afterRestart.exportActiveState().volcanoes).toEqual([]);
  });

  it("非表示の level 3 警報を実ファイル復元し、後着した噴火イベントへ併記する", () => {
    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent({
      id: "volcano-alert-1",
      domain: "volcano",
      serial: "1",
      reportDateTime: new Date(T0).toISOString(),
      isCancellation: false,
      raw: {
        kind: "alert", type: "VFVO50", infoType: "発表", action: "issue",
        volcanoCode: "V-1", volcanoName: "Mount Test",
        alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
        warningKind: "噴火警報（火口周辺）",
        municipalities: [{ name: "テスト市", code: "0000000", kind: "入山規制" }],
      },
    } as never, T0);
    expect(beforeRestart.snapshotItems()).toEqual([]);

    const persistence = new StandbyPersistence(tempPath());
    persistence.save(beforeRestart.exportActiveState());
    const afterRestart = new StandbyStateStore();
    afterRestart.restoreActiveState(persistence.load()!, T0 + 30_000);
    expect(afterRestart.snapshotItems()).toEqual([]);

    afterRestart.applyEvent({
      id: "volcano-eruption-1",
      domain: "volcano",
      serial: "1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
      isCancellation: false,
      raw: {
        kind: "eruption", type: "VFVO56", infoType: "発表",
        volcanoCode: "V-1", volcanoName: "Mount Test",
        phenomenonName: "噴火", isFlashReport: false,
      },
    } as never, T0 + 60_000);
    expect(afterRestart.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: 3,
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制"],
      latestEvent: expect.objectContaining({ label: "噴火" }),
    });
  });

  it("壊れた構造化噴火イベントは volcano domain ごと破棄する", () => {
    const path = tempPath();
    const malformed = {
      ...state(),
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: T0,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0).toISOString(),
          plumeHeightM: 2500, plumeHeightUnknown: "yes", plumeDirection: "南東",
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: null, eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(malformed), "utf8");

    expect(new StandbyPersistence(path).load()).toEqual(expect.objectContaining({ volcanoes: [] }));
  });

  it("構造化イベント・警報意味 field のない旧 volcano 保存状態を互換復元する", () => {
    const path = tempPath();
    const legacy = state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null,
        latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: { reportTimeMs: T0, serial: "1" },
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.volcanoes[0]).not.toHaveProperty("warningKind");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("targetKinds");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("alertClass");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("latestEventId");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      warningKind: null,
      targetKinds: [],
      latestEvent: {
        label: "flash", craterName: null, eventDateTime: null,
        plumeHeightM: null, plumeHeightUnknown: false, plumeDirection: null,
      },
    });
  });

  it("差分 field のない旧 typhoon 永続化ファイルを読み、null 差分として復元する", () => {
    const path = tempPath();
    const legacy = state({
      typhoons: [{
        key: "typhoon:TC-1",
        sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25,
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.typhoons[0]?.typhoon).not.toHaveProperty("pressureDeltaHpa");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: null, maxGustMs: null, maxWindDeltaMs: null, intensityTrend: null,
    });
  });

  it("failed seed retains restored volcano state; empty success clears its alert but keeps the eruption and emits a change", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
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
    expect(volcano).toEqual(expect.objectContaining({
      restored: true,
      data: { volcanoes: [expect.objectContaining({
        alertLevel: null,
        latestEvent: expect.objectContaining({ label: "flash" }),
      })] },
    }));
  });

  it("keeps an aggregated heat card restored while any area still comes from persistence", () => {
    const persisted = state({
      heat: [
        ...state().heat,
        { ...state().heat[0], key: "heat:2026-07-21:長崎県", sourceEventIds: ["heat-2"], areas: [{ areaName: "長崎県", isSpecial: false }] },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "heat-live", domain: "heatAlert", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "熱中症警戒アラート", publishingOffice: "環境省 気象庁", areaItems: [],
      raw: { type: "VPFT50", infoType: "発表", targetDateTime: new Date(T0).toISOString(), serial: "2", targetAreaName: "東京都" },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "heat")?.restored).toBe(true);
  });

  it("keeps an aggregated tornado card restored while any office still comes from persistence", () => {
    const persisted = state({
      tornado: [
        { publishingOffice: "東京管区気象台", sourceEventId: "tornado-1", areas: ["東京都"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
        { publishingOffice: "長崎地方気象台", sourceEventId: "tornado-2", areas: ["長崎県"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "tornado-live", domain: "tornado", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "竜巻注意情報", publishingOffice: "東京管区気象台", areaItems: [{ name: "東京都" }],
      raw: { serial: "2", publishingOffice: "東京管区気象台", activeAreaCount: 1, hasSightingAreas: false, validDateTime: new Date(T0 + 60 * 60_000).toISOString() },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.restored).toBe(true);
  });

  it("keeps an aggregated typhoon card restored while any typhoon still comes from persistence", () => {
    const base = {
      key: "typhoon:TC-1", sourceEventId: "typhoon-1",
      typhoon: { typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString() },
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
    };
    const persisted = state({
      typhoons: [
        base,
        { ...base, key: "typhoon:TC-2", sourceEventId: "typhoon-2", typhoon: { ...base.typhoon, typhoonKey: "TC-2", typhoonNumber: "2602" } },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "typhoon-live", domain: "typhoonAnalysis", eventId: "TC-1", serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "台風解析・予報情報", publishingOffice: "気象庁", areaItems: [],
      raw: { type: "VPTW60", infoType: "発表", eventId: "TC-1", serial: "2", name: { name: "Alpha", nameKana: null, number: "2601", remark: null }, frames: [{ kind: "実況", label: "実況", validTime: new Date(T0 + 120_000).toISOString(), typhoonClass: { category: "TS", intensity: null, size: null }, center: { location: "ocean", coordinate: null, forecastCircleRadiusKm: null, moveDirection: "N", moveSpeedKmh: 20, pressureHpa: 985 }, wind: null }] },
    } as never, T0 + 120_000);

    const item = store.snapshotItems().find((i) => i.kind === "typhoon");
    expect(item?.restored).toBe(true);
  });

  it("keeps a restored volcano event marked when an authoritative alert seed arrives", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.seedVolcanoAlerts([{ volcanoCode: "V-1", volcanoName: "Mount Test", alertLevel: 4, reportDateTime: new Date(T0 + 120_000).toISOString() }], "success", T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.restored).toBe(true);
  });
});

describe("briefing critical persistence", () => {
  function loadExternalBriefing(
    briefingCritical: unknown,
  ): ReturnType<StandbyPersistence["load"]> {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      briefingCritical: briefingCritical as PersistedBriefingCriticalStateV1,
    })), "utf8");
    return new StandbyPersistence(path).load();
  }

  it("semantic/raw のtyped文字列衝突を共存させ、identity順にcanonicalizeする", () => {
    const semantic = briefingUnit();
    const raw = rawBriefingUnit(semantic.entry.semanticKey!, "vpbs50");
    const validated = validateBriefingCriticalForWrite({
      generation: 1,
      entries: [semantic, raw],
      cancellations: [],
      watermarks: [{
        semanticKey: semantic.entry.semanticKey!, revision: { reportTimeMs: T0, serial: "003" },
        expiresAtMs: T0 + 60 * 60_000,
      }],
    });

    expect(validated.entries.map((unit) => unit.entry.key)).toEqual([
      rawBriefingDisplayKey("vpbs50", semantic.entry.semanticKey!),
      semantic.entry.semanticKey,
    ]);
    expect(validated.watermarks[0]?.revision.serial).toBe("3");
  });

  it("rawAliases 欠落を空として受理し、明示emptyはwriterで省略する", () => {
    const missing = validateBriefingCriticalForWrite(semanticBriefingSlice());
    const explicit = validateBriefingCriticalForWrite({ ...semanticBriefingSlice(), rawAliases: [] });

    expect(missing.rawAliases).toBeUndefined();
    expect(explicit.rawAliases).toBeUndefined();
  });

  it("外部配列orderingと明示empty rawAliasesはcanonical rewriteを要求し、保存後に解消する", () => {
    const path = tempPath();
    const external = state({
      briefingCritical: {
        generation: 1,
        entries: [rawBriefingUnit("z-last"), rawBriefingUnit("a-first")],
        cancellations: [], watermarks: [], rawAliases: [],
      },
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(external), "utf8");
    const persistence = new StandbyPersistence(path);
    const loaded = persistence.load();

    expect(persistence.hasPendingSalvageRepair()).toBe(true);
    expect(loaded?.briefingCritical?.entries.map((unit) => unit.entry.sourceEventId))
      .toEqual(["a-first", "z-last"]);
    persistence.save(loaded!);
    expect(persistence.hasPendingSalvageRepair()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).briefingCritical.rawAliases).toBeUndefined();
  });

  it("generation単独のempty sliceはv1/v2 writerが省略する", () => {
    const path = tempPath();
    new StandbyPersistence(path).save(state({
      briefingCritical: { generation: 99, entries: [], cancellations: [], watermarks: [], rawAliases: [] },
    }));

    expect(JSON.parse(readFileSync(path, "utf8")).briefingCritical).toBeUndefined();
    expect(JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")).briefingCritical).toBeUndefined();
  });

  it("alias-only sliceをv1/v2へ意味的同一にdual-writeし、v1 fallbackでも保持する", () => {
    const path = tempPath();
    const aliasOnly: PersistedBriefingCriticalStateV1 = {
      generation: 11,
      entries: [], cancellations: [], watermarks: [],
      rawAliases: [{
        source: "vpoa50", sourceEventId: "raw-alias-1", semanticKey: "card:vpbs:semantic:recordRain:試験地方気象台",
        revision: { reportTimeMs: T0, serial: "007" }, expiresAtMs: T0 + 60 * 60_000,
      }],
    };
    const persistence = new StandbyPersistence(path);
    persistence.save(state({ briefingCritical: aliasOnly }));
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    const v2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));

    expect(v1.briefingCritical).toEqual(v2.briefingCritical);
    expect(v2.briefingCritical).toEqual({
      ...aliasOnly,
      rawAliases: [{ ...aliasOnly.rawAliases![0], revision: { reportTimeMs: T0, serial: "7" } }],
    });
    rmSync(standbyPersistenceV2Path(path));
    expect(new StandbyPersistence(path).load()?.briefingCritical).toEqual(v1.briefingCritical);
  });

  it("required/nullable/enum/nested payloadとauthoritative field矛盾をfail-loudにする", () => {
    const mutations: Array<(entry: Record<string, unknown>, unit: PersistedBriefingCriticalEntryV1) => void> = [
      (entry) => { delete entry.headline; },
      (entry) => { entry.source = "unknown"; },
      (entry) => { entry.summary = null; },
      (entry) => {
        const evidence = (entry.severityEvidence as Array<Record<string, unknown>>)[0]!;
        delete evidence.status;
      },
      (entry) => {
        const summary = entry.summary as { items: Array<{ facts: Array<Record<string, unknown>> }> };
        delete summary.items[0]!.facts[0]!.locationName;
      },
      (entry) => {
        const summary = entry.summary as { items: Array<{ facts: Array<Record<string, unknown>> }> };
        summary.items[0]!.facts[0]!.value = Number.POSITIVE_INFINITY;
      },
      (entry) => { entry.conditions = Array.from({ length: 2_049 }, () => "x"); },
      (entry) => {
        const summary = entry.summary as { items: unknown[] };
        summary.items = Array.from({ length: 5 }, () => summary.items[0]);
      },
      (entry) => { entry.generation = 2; },
      (entry) => { entry.updatedAt = new Date(T0 + 1).toISOString(); },
      (_entry, unit) => { unit.updatedAtMs = unit.expiresAtMs + 1; },
      (entry) => { entry.frameLevel = "warning"; },
    ];

    for (const mutate of mutations) {
      const slice = semanticBriefingSlice();
      const unit = slice.entries[0]!;
      const entry = unit.entry as unknown as Record<string, unknown>;
      mutate(entry, unit);
      expect(() => validateBriefingCriticalForWrite(slice)).toThrow(BriefingCriticalPersistenceInvariantError);
    }
  });

  it("malformed aliasは同identityのalias bundleだけを除外しsemantic/raw bundleを維持する", () => {
    const slice = semanticBriefingSlice();
    const raw = rawBriefingUnit("raw-survivor");
    const malformedSemantic = structuredClone(slice.entries[0]!) as PersistedBriefingCriticalEntryV1;
    malformedSemantic.entry.source = "vpoa50";
    const malformedRawAlias = {
      source: "vpoa50" as const,
      sourceEventId: "raw-survivor",
      semanticKey: "",
      revision: { reportTimeMs: T0, serial: "3" },
      expiresAtMs: T0 + 60 * 60_000,
    };
    const validAlias = {
      source: "vpoa50" as const, sourceEventId: "alias-A", semanticKey: slice.entries[0]!.entry.semanticKey!,
      revision: { reportTimeMs: T0, serial: "3" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const validRawIdentityAlias = { ...validAlias, sourceEventId: "raw-survivor" };
    const loaded = loadExternalBriefing({
      ...slice,
      entries: [...slice.entries, malformedSemantic, raw],
      watermarks: [
        ...slice.watermarks,
        { ...slice.watermarks[0], revision: { reportTimeMs: "invalid", serial: "3" } },
      ],
      rawAliases: [
        validAlias,
        { ...validAlias, revision: { reportTimeMs: "invalid", serial: "3" } },
        { ...validAlias, sourceEventId: "alias-B" },
        validRawIdentityAlias,
        malformedRawAlias,
      ],
    });

    expect(loaded?.briefingCritical?.entries.map((unit) => unit.entry.sourceEventId))
      .toEqual(["raw-survivor", slice.entries[0]!.entry.sourceEventId]);
    expect(loaded?.briefingCritical?.watermarks).toHaveLength(1);
    expect(loaded?.briefingCritical?.rawAliases?.map((alias) => alias.sourceEventId))
      .toEqual(["alias-B"]);
  });

  it("duplicate aliasとraw entry+alias矛盾をtyped raw identity単位で入力順非依存にsalvageする", () => {
    const alias = {
      source: "vpoa50" as const, sourceEventId: "duplicate", semanticKey: "canonical",
      revision: { reportTimeMs: T0, serial: "3" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const raw = rawBriefingUnit("entry-alias-conflict");
    const conflictingAlias = { ...alias, sourceEventId: "entry-alias-conflict" };
    const first = {
      generation: 1, entries: [raw], cancellations: [], watermarks: [],
      rawAliases: [alias, { ...alias }, conflictingAlias],
    };
    const second = { ...first, rawAliases: [...first.rawAliases].reverse() };

    const left = loadExternalBriefing(first)?.briefingCritical;
    const right = loadExternalBriefing(second)?.briefingCritical;
    expect(left).toEqual(right);
    expect(left).toEqual({ generation: 1, entries: [], cancellations: [], watermarks: [] });
  });

  it("entry 128/129、watermark 511/512/513、alias 511/512/513 を境界検証する", () => {
    const rawEntries = Array.from({ length: 129 }, (_, index) => rawBriefingUnit(`raw-${index}`));
    expect(validateBriefingCriticalForWrite({
      generation: 1, entries: rawEntries.slice(0, 128), cancellations: [], watermarks: [],
    }).entries).toHaveLength(128);
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: rawEntries, cancellations: [], watermarks: [],
    })).toThrow("limit-exceeded");

    const watermarks = Array.from({ length: 513 }, (_, index) => ({
      semanticKey: `semantic-${index}`, revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 60 * 60_000,
    }));
    for (const count of [511, 512]) {
      expect(validateBriefingCriticalForWrite({
        generation: 1, entries: [], cancellations: [], watermarks: watermarks.slice(0, count),
      }).watermarks).toHaveLength(count);
    }
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: [], cancellations: [], watermarks,
    })).toThrow("limit-exceeded");

    const aliases = Array.from({ length: 513 }, (_, index) => ({
      source: "vpoa50" as const, sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    for (const count of [511, 512]) {
      expect(validateBriefingCriticalForWrite({
        generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases.slice(0, count),
      }).rawAliases).toHaveLength(count);
    }
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases,
    })).toThrow("limit-exceeded");
  });

  it("raw provenance+alias union 512を許し513を拒否する", () => {
    const entries = Array.from({ length: 128 }, (_, index) => rawBriefingUnit(`entry-${index}`));
    const aliases = Array.from({ length: 385 }, (_, index) => ({
      source: "vpoa50" as const, sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    expect(validateBriefingCriticalForWrite({
      generation: 1, entries, cancellations: [], watermarks: [], rawAliases: aliases.slice(0, 384),
    }).rawAliases).toHaveLength(384);
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries, cancellations: [], watermarks: [], rawAliases: aliases,
    })).toThrow("limit-exceeded");
  });

  it("外部top-level容量超過はbriefing domainだけを除外し他domainを維持する", () => {
    const aliases = Array.from({ length: 513 }, (_, index) => ({
      source: "vpoa50", sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    const loaded = loadExternalBriefing({
      generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases,
    });

    expect(loaded?.briefingCritical).toBeUndefined();
    expect(loaded?.heat).toHaveLength(1);
  });

  it("writer invariant違反は既存の正常v1/v2 fileを置換しない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(state({ savedAt: "valid", briefingCritical: semanticBriefingSlice() }));
    const beforeV1 = readFileSync(path, "utf8");
    const beforeV2 = readFileSync(standbyPersistenceV2Path(path), "utf8");
    const invalid = semanticBriefingSlice();
    invalid.entries[0]!.entry.key = "not-canonical";

    const result = persistence.save(state({ savedAt: "invalid", briefingCritical: invalid }));
    expect(result).toMatchObject({ kind: "failed", stage: "validation", pendingRetained: true });
    if (result.kind === "failed") {
      expect(result.cause).toBeInstanceOf(BriefingCriticalPersistenceInvariantError);
    }
    expect(readFileSync(path, "utf8")).toBe(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path), "utf8")).toBe(beforeV2);
  });
});

describe("briefing operational persistence fixtures", () => {
  const fixtureRoot = join(process.cwd(), "test", "fixtures", "standby-persistence");
  const expectations = JSON.parse(readFileSync(join(fixtureRoot, "operational-expectations.json"), "utf8")) as {
    fixtures: Array<{
      path: string;
      fixedNowMs: string;
      retainedPointers: Array<{ source: string; migration: string; v2: string; v1: string; value: unknown }>;
      expiredPointers: string[];
      expiredReason?: string;
      explicitReplacementAllowlist: string[];
      optionalCompletionPointers: string[];
      savedV2ChangeAllowlist: string[];
      savedV1ChangeAllowlist: string[];
      reloadedV2ChangeAllowlist: string[];
      reloadedV1ChangeAllowlist: string[];
    }>;
  };

  it.each(expectations.fixtures)("$path は固定時計で load→restore→dual-write→reload して意味を保つ", (expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(expected.fixedNowMs);
    try {
      const source = JSON.parse(readFileSync(join(fixtureRoot, expected.path), "utf8")) as Record<string, unknown>;
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(source.version === 1 ? path : standbyPersistenceV2Path(path), JSON.stringify(source), "utf8");
      for (const retained of expected.retainedPointers) {
        expect(jsonPointer(source, retained.source)).toEqual(retained.value);
      }
      if (expected.expiredPointers.length === 0) {
        expect(expected.expiredReason).toBeTruthy();
        expect(expiredEpochPointers(source, Date.now())).toEqual([]);
      }

      const nowMs = Date.now();
      const persistence = new StandbyPersistence(path);
      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      const structuralChanges = explicitPrimitiveReplacements(source, loaded);
      expect(structuralChanges.filter((pointer) => !expected.optionalCompletionPointers.includes(pointer)))
        .toEqual(expected.explicitReplacementAllowlist);
      expect(structuralChanges.filter((pointer) => expected.optionalCompletionPointers.includes(pointer)))
        .toEqual(expected.optionalCompletionPointers);
      const store = new StandbyStateStore();
      const restore = store.restoreActiveState(loaded!, nowMs);
      store.sweep(nowMs);
      const exported = store.exportActiveState();
      persistence.save(exported);

      const writtenV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));
      const writtenV1 = JSON.parse(readFileSync(path, "utf8"));
      expect(explicitPrimitiveReplacements(source, writtenV2)).toEqual(expected.savedV2ChangeAllowlist);
      expect(explicitPrimitiveReplacements(source, writtenV1)).toEqual(expected.savedV1ChangeAllowlist);
      const reloaded = persistence.load();
      expect(reloaded).not.toBeNull();
      expect(explicitPrimitiveReplacements(writtenV2, reloaded))
        .toEqual(expected.reloadedV2ChangeAllowlist);
      const reloadedStore = new StandbyStateStore();
      reloadedStore.restoreActiveState(reloaded!, nowMs);

      const fallbackPath = tempPath();
      mkdirSync(dirname(fallbackPath), { recursive: true });
      writeFileSync(fallbackPath, JSON.stringify(writtenV1), "utf8");
      const fallbackReloaded = new StandbyPersistence(fallbackPath).load();
      expect(fallbackReloaded).not.toBeNull();
      expect(explicitPrimitiveReplacements(writtenV1, fallbackReloaded))
        .toEqual(expected.reloadedV1ChangeAllowlist);
      const fallbackStore = new StandbyStateStore();
      fallbackStore.restoreActiveState(fallbackReloaded!, nowMs);
      for (const retained of expected.retainedPointers) {
        expect(jsonPointer(loaded, retained.migration)).toEqual(retained.value);
        expect(jsonPointer(writtenV2, retained.v2)).toEqual(retained.value);
        expect(jsonPointer(writtenV1, retained.v1)).toEqual(retained.value);
        expect(jsonPointer(reloadedStore.exportActiveState(), retained.v2)).toEqual(retained.value);
        expect(jsonPointer(fallbackStore.exportActiveState(), retained.v1)).toEqual(retained.value);
      }
      for (const pointer of expected.expiredPointers) {
        expect(jsonPointer(store.exportActiveState(), pointer)).toBeUndefined();
        expect(jsonPointer(writtenV2, pointer)).toBeUndefined();
        expect(jsonPointer(writtenV1, pointer)).toBeUndefined();
        expect(jsonPointer(reloadedStore.exportActiveState(), pointer)).toBeUndefined();
        expect(jsonPointer(fallbackStore.exportActiveState(), pointer)).toBeUndefined();
      }
      if (expected.path.includes("v1")) {
        expect(source.briefingCritical).toBeDefined();
        expect((source.briefingCritical as Record<string, unknown>).rawAliases).toBeUndefined();
        expect(writtenV2.briefingCritical.rawAliases).toBeUndefined();
        expect(writtenV1.briefingCritical.rawAliases).toBeUndefined();
      } else {
        expect(restore.briefingCriticalRewriteRequired).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("StandbyPersistence の遅延保存", () => {
  it("schedule しただけでは書かない (同期 I/O を受信経路から外す)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state());

    expect(existsSync(path)).toBe(false);
  });

  it("debounce 経過後に書かれ、内容は最後に schedule した状態になる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state({ savedAt: "first" }));
    persistence.schedule(state({ savedAt: "second" }));
    persistence.schedule(state({ savedAt: "latest" }));

    await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 3000 });
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("latest");
  });

  it("flush は予約済みの状態を即座に書き切る (終了時の取りこぼし防止)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state({ savedAt: "pending" }));
    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("pending");
  });

  it("stopTimer は debounce だけを止め、shutdown 用の pending を保持する", async () => {
    vi.useFakeTimers();
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state({ savedAt: "shutdown-pending" }));
    persistence.stopTimer();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(existsSync(path)).toBe(false);

    persistence.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("shutdown-pending");
  });

  it("flush 後は予約が消え、残ったタイマーが発火しても書き直さない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state());
    persistence.flush();
    rmSync(path);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(existsSync(path)).toBe(false);
  });

  it("予約がないときの flush は既存ファイルを壊さない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "kept" }));
    persistence.flush();

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("kept");
  });
});

// 同期保存 (シャットダウン経路) と debounce の非同期書き込みが同じ tmp を奪い合い、
// 古い非同期書き込みが後から rename して最終状態を巻き戻す不具合の回帰テスト。
// 実時間には頼らず、__test_writePending() で予約分を任意のタイミングで走らせる
describe("StandbyPersistence の書き込み順序", () => {
  const tmpFiles = (path: string): string[] =>
    readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));

  it("async debounce failure は typed lastFailure と pending を保持し、自動成功扱いにしない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const write = vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("disk-full"));
    persistence.schedule(state({ savedAt: "pending-after-failure" }));
    await persistence.__test_writePending();

    expect(persistence.isUnhealthy()).toBe(true);
    expect(persistence.lastFailure()).toMatchObject({
      kind: "failed",
      requestedSeq: 1,
      failedSeq: 1,
      stage: "writeV2Temp",
      pendingRetained: true,
      partialCommit: "none",
      cause: expect.objectContaining({ message: "disk-full" }),
    });
    expect(existsSync(path)).toBe(false);

    write.mockRestore();
    await persistence.__test_writePending();
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("pending-after-failure");
    expect(persistence.lastFailure()).toBeNull();
    expect(persistence.isUnhealthy()).toBe(false);
  });

  it("追い越された書き込みは rename しない (同期保存が後勝ちされない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("非同期書き込みの進行中に同期保存が割り込んでも旧内容で上書きしない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));

    // 書き込みを開始させ、完了を待たずに同期保存を割り込ませる
    const inFlight = persistence.__test_writePending();
    persistence.save(state({ savedAt: "new" }));
    await inFlight;

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("追い越された書き込みの後も次の保存が反映される (rename 済み seq が逆行しない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    await persistence.__test_writePending();

    persistence.save(state({ savedAt: "newest" }));

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("newest");
  });

  it("予約が同期保存より新しい場合は通常どおり書かれる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.save(state({ savedAt: "old" }));
    persistence.schedule(state({ savedAt: "new" }));

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
  });

  it("同期保存と非同期書き込みは別々の tmp を使う (奪い合いを構造的に消す)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const syncWrite = vi.spyOn(fs, "writeFileSync");
    const asyncWrite = vi.spyOn(fs.promises, "writeFile");
    try {
      persistence.schedule(state({ savedAt: "old" }));
      const inFlight = persistence.__test_writePending();
      persistence.save(state({ savedAt: "new" }));
      await inFlight;

      const syncTmp = syncWrite.mock.calls.map((call) => String(call[0]));
      const asyncTmp = asyncWrite.mock.calls.map((call) => String(call[0]));
      expect(syncTmp).toHaveLength(2);
      expect(asyncTmp).toHaveLength(2);
      expect(new Set([...syncTmp, ...asyncTmp]).size).toBe(4);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(tmpFiles(path)).toEqual([]);
    } finally {
      syncWrite.mockRestore();
      asyncWrite.mockRestore();
    }
  });

  it("同期保存より古い予約は flush で書き戻されない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  // seq の判定と rename の間に await があると、guard 通過後・rename 完了前に同期保存が
  // 割り込み、古い rename が後から旧内容で上書きする。非同期 rename を使わないことで担保する
  it("rename は同期で行う (seq 判定との間に await を挟まない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const rename = vi.spyOn(fs.promises, "rename");
    try {
      persistence.schedule(state({ savedAt: "written" }));
      await persistence.__test_writePending();

      expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("written");
      expect(rename).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  it("load 時に自分の残留 tmp だけを掃除する (無関係な .tmp は消さない)", () => {
    const path = tempPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.3.tmp`, "{}", "utf8");
    writeFileSync(`${path}.8.tmp`, "{}", "utf8");
    writeFileSync(join(dir, "other.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "weather-promotion-v1.json.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "keep", "utf8");

    new StandbyPersistence(path).load();

    expect(existsSync(`${path}.3.tmp`)).toBe(false);
    expect(existsSync(`${path}.8.tmp`)).toBe(false);
    expect(existsSync(join(dir, "other.tmp"))).toBe(true);
    expect(existsSync(join(dir, "weather-promotion-v1.json.tmp"))).toBe(true);
    expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
  });
});
