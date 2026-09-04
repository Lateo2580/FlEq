import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedTsunamiInfo, TelegramListItem, TelegramListResponse } from "../../src/types";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";
import { canonicalizeLegacyTsunamiInfo, type LegacyParsedTsunamiInfoInput } from "../../src/dmdata/tsunami-legacy-adapter";
import * as restClient from "../../src/dmdata/rest-client";
import * as log from "../../src/logger";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { StandbyPersistenceAdmissionCoordinator } from "../../src/engine/display/standby-persistence-admission";
import {
  StandbyPersistence,
  type PersistedStandbyStateV1,
} from "../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../src/engine/messages/vpww56-state";
import { FloodForecastStateHolder } from "../../src/engine/messages/flood-forecast-state";
import { emptyVolcanoRepairState, VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { processTsunami } from "../../src/engine/presentation/processors/process-tsunami";
import { tsunamiActiveMatchesGate } from "../../src/engine/messages/tsunami-persistence-identity";
import { toWsDataMessageFromRestBody } from "../../src/engine/startup/telegram-adapter";
import {
  restoreTsunamiState,
  tsunamiRestoreFailureIsRetryable,
  TSUNAMI_RESTORE_MAX_ITEMS_PER_SCAN,
  TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN,
  TSUNAMI_RESTORE_PAGE_LIMIT,
  type TsunamiRestoreFailure,
  type TsunamiRestoreAttemptResult,
} from "../../src/engine/startup/tsunami-initializer";

vi.mock("../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));
vi.mock("../../src/dmdata/rest-client");
vi.mock("../../src/dmdata/telegram-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/dmdata/telegram-parser")>();
  return { ...actual, parseTsunamiTelegram: vi.fn(actual.parseTsunamiTelegram) };
});
import { parseTsunamiTelegram } from "../../src/dmdata/telegram-parser";

const NOW = Date.parse("2026-07-29T00:00:00.000Z");
const XML = '<?xml version="1.0"?><Report><Head/></Report>';
const mockList = vi.mocked(restClient.listTelegrams);
const mockBody = vi.mocked(restClient.fetchTelegramBody);
const mockParse = vi.mocked(parseTsunamiTelegram);
let actualParser: typeof import("../../src/dmdata/telegram-parser");
let parsedById: Map<string, ParsedTsunamiInfo>;
const tempDirs: string[] = [];

beforeAll(async () => {
  actualParser = await vi.importActual<typeof import("../../src/dmdata/telegram-parser")>("../../src/dmdata/telegram-parser");
});

function info(input: LegacyParsedTsunamiInfoInput): ParsedTsunamiInfo {
  return canonicalizeLegacyTsunamiInfo({
    ...input,
    forecast: input.forecast?.map((item, index) => ({
      ...item,
      areaCode: item.areaCode === undefined ? `area-${index}` : item.areaCode,
      kindCode: item.kindCode === undefined ? `kind-${index}` : item.kindCode,
    })),
  });
}

function active(
  id: string,
  eventId: string,
  report: string,
  receivedAtMs: number,
  kind = "津波警報",
  infoType: "発表" | "訂正" | "取消" = "発表",
  serial: string | null = null,
): ParsedTsunamiInfo {
  return info({
    meta: createTelegramMeta({ messageId: id, eventId, type: "VTSE41", reportDateTime: report, serial, infoType, receivedAtMs, status: "通常", isTest: false }),
    type: "VTSE41", infoType, title: "津波警報・注意報・予報", reportDateTime: report,
    headline: null, publishingOffice: "気象庁",
    forecast: infoType === "取消" ? [] : [{ areaCode: "100", areaName: `${eventId}-area`, kindCode: kind === "津波予報" ? "60" : "52", kind, maxHeightDescription: kind === "津波予報" ? "解除" : "3m", firstHeight: "" }],
    warningComment: "", isTest: false,
  });
}

function itemFor(parsed: ParsedTsunamiInfo, id = parsed.meta.messageId): TelegramListItem {
  const received = new Date(parsed.meta.receivedAtMs).toISOString();
  return {
    serial: 1, id, classification: "telegram.earthquake",
    head: { type: "VTSE41", author: "JPOS", time: received, designation: null, test: false },
    receivedTime: received,
    xmlReport: {
      head: { title: parsed.title, serial: parsed.meta.serial.raw, eventId: parsed.meta.eventId.raw, headline: parsed.headline, infoKind: parsed.title, infoType: parsed.meta.infoType.raw!, reportDateTime: parsed.meta.reportDateTime.raw!, targetDateTime: parsed.meta.reportDateTime.raw!, infoKindVersion: "1.0_1" },
      control: { title: parsed.title, status: "通常", dateTime: received, editorialOffice: "気象庁", publishingOffice: "気象庁" },
    },
    format: "xml", url: `https://data.api.dmdata.jp/v1/${id}`,
  };
}

function response(items: TelegramListItem[], nextToken?: string): TelegramListResponse {
  return { responseId: "r", responseTime: new Date(NOW).toISOString(), status: "ok", items, ...(nextToken == null ? {} : { nextToken }) };
}

function install(items: readonly ParsedTsunamiInfo[]): TelegramListItem[] {
  const listItems = items.map((parsed) => {
    parsedById.set(parsed.meta.messageId, parsed);
    return itemFor(parsed);
  }).sort((a, b) => Date.parse(b.head.time) - Date.parse(a.head.time));
  mockList.mockResolvedValue(response(listItems));
  mockBody.mockResolvedValue({ kind: "ok", xml: XML });
  return listItems;
}

async function restore(state: TsunamiStateHolder, gate: TelegramRevisionGate): Promise<TsunamiRestoreAttemptResult> {
  return restoreTsunamiState("key", state, gate, undefined, undefined, { now: () => NOW });
}

function seed(parsed: ParsedTsunamiInfo, state: TsunamiStateHolder, gate: TelegramRevisionGate): void {
  parsedById.set(parsed.meta.messageId, parsed);
  const result = processTsunami(toWsDataMessageFromRestBody(itemFor(parsed), XML, parsed.meta.receivedAtMs), { tsunamiState: state, revisionGate: gate });
  expect(result.kind).toBe("ok");
}

function admission(state: TsunamiStateHolder, gate: TelegramRevisionGate): StandbyPersistenceAdmissionCoordinator {
  return new StandbyPersistenceAdmissionCoordinator({
    owners: {
      telegramRevisionGate: gate,
      standbyStateStore: new StandbyStateStore(),
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState: state,
      volcanoState: new VolcanoStateHolder(),
      floodForecastState: new FloodForecastStateHolder(),
    },
    repairState: emptyVolcanoRepairState(),
  });
}

function persistencePath(): string {
  const dir = fs.mkdtempSync(".vitest-appdata-tsunami-");
  tempDirs.push(dir);
  return `${dir}/display-active-state-v1.json`;
}

function emptyStandbyState(): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: "2026-07-29T00:00:00Z",
    heat: [], typhoons: [], volcanoes: [], floods: { events: [], seen: [] },
    weatherAlerts: [], tornado: [], longPeriod: [], quakeHost: null,
    nankaiTrough: null, seen: [],
  };
}

function roundTrip(
  state: TsunamiStateHolder,
  gate: TelegramRevisionGate,
): { state: TsunamiStateHolder; gate: TelegramRevisionGate } {
  const persistence = new StandbyPersistence(persistencePath(), 0, () => ({
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    tsunami: {
      keyedActive: state.getPersistedKeyedActive(),
      legacyActive: state.getPersistedLegacyActive(),
      observations: state.getObservationGroups(),
      gateEntries: gate.exportDurableEntries().filter((entry) =>
        entry.domain === "tsunami" || entry.domain === "tsunamiObservation"),
    },
  }));
  expect(persistence.save(emptyStandbyState()).kind).toBe("written");
  const loaded = persistence.load()!.telegramFoundation.tsunami;
  const restoredState = new TsunamiStateHolder();
  restoredState.restorePersistedState(
    null,
    loaded.observations,
    loaded.keyedActive ?? [],
    loaded.legacyActive ?? null,
  );
  const restoredGate = new TelegramRevisionGate();
  restoredGate.restoreDurableEntries(loaded.gateEntries);
  return { state: restoredState, gate: restoredGate };
}

beforeEach(() => {
  vi.clearAllMocks();
  parsedById = new Map();
  mockList.mockReset();
  mockList.mockResolvedValue(response([]));
  mockBody.mockReset();
  mockBody.mockResolvedValue({ kind: "ok", xml: XML });
  mockParse.mockReset();
  mockParse.mockImplementation((message) => parsedById.get(message.id) ?? null);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restoreTsunamiState bounded multi-event batch", () => {
  it("§5.1 empty baseline restores A/B in transport order and keeps B as lastInfo", async () => {
    const a = active("za", "Z-event", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("ab", "A-event", "2026-07-28T21:00:00Z", NOW - 10_000, "津波注意報");
    install([a, b]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const callback = vi.fn(); const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.getPersistedKeyedActive().map((x) => x.meta.eventId.value).sort()).toEqual(["A-event", "Z-event"]);
    expect(state.getLastInfo()?.meta.eventId.value).toBe("A-event");
    expect(state.getLastInfo()?.reportDateTime).toBe("2026-07-28T21:00:00Z");
    expect(mockBody.mock.calls.map((call) => call[1])).toEqual(["ab", "za"]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("§5.2-5.5 persisted A replays whole cancellation, stale late report, and genuine restart without touching B", async () => {
    const t0 = NOW - 50_000;
    const a0 = active("a0", "A", "2026-07-28T20:00:00Z", t0);
    const b0 = active("b0", "B", "2026-07-28T20:01:00Z", t0 + 1_000, "津波注意報");
    const cancel = active("a1", "A", "2026-07-28T20:02:00Z", t0 + 2_000, "津波警報", "取消");
    const late = active("a2", "A", "2026-07-28T19:59:00Z", t0 + 3_000);
    install([a0, b0, cancel, late]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); seed(a0, state, gate); seed(b0, state, gate);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.hasPersistedEvent("A")).toBe(false);
    expect(state.hasPersistedEvent("B")).toBe(true);
    const tombstone = gate.exportDurableEntries().find((x) => x.stateSubjectKey === "tsunami:A");
    expect(tombstone?.cancelled).toBe(true);

    const restart = active("a3", "A", "2026-07-28T20:03:00Z", t0 + 4_000);
    install([a0, b0, cancel, late, restart]);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.hasPersistedEvent("A")).toBe(true);
  });

  it("§5.2 full release clears only its EventID", async () => {
    const a0 = active("a0", "A", "2026-07-28T20:00:00Z", NOW - 40_000);
    const b0 = active("b0", "B", "2026-07-28T20:01:00Z", NOW - 39_000);
    const release = active("a1", "A", "2026-07-28T20:02:00Z", NOW - 38_000, "津波予報");
    install([a0, b0, release]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); seed(a0, state, gate); seed(b0, state, gate);
    expect((await restore(state, gate)).kind).toBe("complete");
    expect(state.getPersistedKeyedActive().find((x) => x.meta.eventId.value === "A")?.forecast?.every((x) => x.kind === "津波予報")).toBe(true);
    expect(state.hasPersistedEvent("B")).toBe(true);
  });

  it("§5.7 paginates both full scans with an opaque cursor and fetches bodies between scans", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    parsedById.set("a", a);
    const oldInfo = active("sentinel", "OLD", "2026-07-20T20:00:00Z", NOW - 8 * 24 * 60 * 60_000);
    const old = itemFor(oldInfo);
    const calls: string[] = [];
    mockList.mockImplementation(async (_key, query) => {
      const cursorToken = typeof query === "string" ? undefined : query.cursorToken;
      calls.push(`list:${cursorToken ?? "head"}`);
      return cursorToken == null ? response([itemFor(a)], " opaque ") : response([old]);
    });
    mockBody.mockImplementation(async () => { calls.push("body:a"); return { kind: "ok", xml: XML }; });
    const result = await restore(new TsunamiStateHolder(), new TelegramRevisionGate());
    expect(result.kind).toBe("complete");
    expect(calls).toEqual(["list:head", "list: opaque ", "body:a", "list:head", "list: opaque "]);
    expect(mockList).toHaveBeenNthCalledWith(1, "key", { type: "VTSE41", limit: TSUNAMI_RESTORE_PAGE_LIMIT, formatMode: "raw", xmlReport: true });
    expect(mockList).toHaveBeenNthCalledWith(2, "key", { type: "VTSE41", limit: TSUNAMI_RESTORE_PAGE_LIMIT, formatMode: "raw", xmlReport: true, cursorToken: " opaque " });
  });

  it("review #3 / §6 fetches every body by the list item exact id and url", async () => {
    const a = active("exact-body-id", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    install([a]);
    expect((await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).kind).toBe("complete");
    expect(mockBody).toHaveBeenCalledTimes(1);
    expect(mockBody).toHaveBeenCalledWith(
      "key",
      "exact-body-id",
      "https://data.api.dmdata.jp/v1/exact-body-id",
    );
  });

  it("§5.9 real missing-Serial release passes list, body identity, and replay", async () => {
    const realList = JSON.parse(fs.readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8")) as TelegramListResponse;
    const xml = fs.readFileSync("test/fixtures/rest/telegram-body-vtse41-real.xml", "utf8");
    const realItem = realList.items[0];
    mockList.mockResolvedValue(response([realItem]));
    mockBody.mockResolvedValue({ kind: "ok", xml });
    mockParse.mockImplementation(actualParser.parseTsunamiTelegram);
    const result = await restoreTsunamiState("key", new TsunamiStateHolder(), new TelegramRevisionGate(), undefined, undefined, {
      now: () => Date.parse(realItem.head.time) + 60_000,
    });
    expect(result).toEqual(expect.objectContaining({ kind: "complete" }));
    expect(realItem.xmlReport?.head.serial).toBeNull();
  });

  it("§5.9 empty Serial is missing but non-empty invalid Serial is listItemInvalid", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    const empty = itemFor(a); empty.xmlReport!.head.serial = "";
    parsedById.set("a", { ...a, meta: createTelegramMeta({ messageId: "a", eventId: "A", type: "VTSE41", reportDateTime: "2026-07-28T20:00:00Z", serial: "", infoType: "発表", receivedAtMs: NOW - 10_000, status: "通常", isTest: false }) });
    mockList.mockResolvedValue(response([empty]));
    expect((await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).kind).toBe("complete");
    const invalid = itemFor(a); invalid.xmlReport!.head.serial = "x"; mockList.mockResolvedValue(response([invalid]));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ kind: "incomplete", reason: "listItemInvalid", retryable: false }));
  });

  it("§5.10 empty REST is noData only without active coverage targets", async () => {
    mockList.mockResolvedValue(response([]));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual({ kind: "noData", changed: false });
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); seed(a, state, gate);
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingPersistedEvent", retryable: true }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
  });

  it("review #3 / §5.10 empty REST with a gate-only active target is incomplete and unchanged", async () => {
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); seed(a, sourceState, sourceGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(sourceGate.exportDurableEntries()); mockList.mockResolvedValue(response([]));
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingPersistedEvent", retryable: true }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.10 rejects a baseline outside the seven-day coverage window without mutation", async () => {
    const old = active(
      "old", "A", new Date(NOW - 8 * 24 * 60 * 60_000).toISOString(),
      NOW - 8 * 24 * 60 * 60_000,
    );
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); seed(old, state, gate);
    mockList.mockResolvedValue(response([]));
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "baselineOutsideRestoreWindow", retryable: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["throw", "status"] as const)("§5.11 listUnavailable (%s) is retryable and no-commit", async (mode) => {
    if (mode === "throw") mockList.mockRejectedValue(new Error("down"));
    else mockList.mockResolvedValue({ ...response([]), status: "error" });
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "listUnavailable", retryable: true }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
  });

  it("§5.12 discards an unstable round and commits the next stable full scan once", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000);
    parsedById.set("a", a); parsedById.set("b", b);
    mockList.mockResolvedValueOnce(response([itemFor(a)]))
      .mockResolvedValueOnce(response([itemFor(b), itemFor(a)]))
      .mockResolvedValueOnce(response([itemFor(b), itemFor(a)]))
      .mockResolvedValueOnce(response([itemFor(b), itemFor(a)]));
    const persist = vi.fn();
    const result = await restoreTsunamiState("key", new TsunamiStateHolder(), new TelegramRevisionGate(), persist, undefined, { now: () => NOW });
    expect(result).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(mockList).toHaveBeenCalledTimes(4);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("§5.13 gate-only A/B duplicate anchors reconstruct each EventID and callback once", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000);
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate(); seed(a, seedState, seedGate); seed(b, seedState, seedGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); gate.restoreDurableEntries(seedGate.exportDurableEntries());
    install([a, b]); const persist = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, persist, undefined, { now: () => NOW })).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.hasPersistedEvent("A")).toBe(true); expect(state.hasPersistedEvent("B")).toBe(true); expect(persist).toHaveBeenCalledTimes(1);
  });

  it("review #3 / §5.13 gate-only full release reconstructs canonical EventID state although lastInfo is null", async () => {
    const release = active("release", "A", "2026-07-28T20:00:00Z", NOW - 10_000, "津波予報");
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate(); seed(release, seedState, seedGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(seedGate.exportDurableEntries()); install([release]);
    const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "complete", changed: true, active: null }));
    expect(state.hasPersistedEvent("A")).toBe(true);
    expect(state.getLastInfo()).toBeNull();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it.each(["partial-cancel", "unkeyed-normal"] as const)("§5.14 gate-only %s reconstructs only from an isolated base trace", async (mode) => {
    const baseInfo = active("base", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    baseInfo.forecast = [
      baseInfo.forecast![0],
      { ...baseInfo.forecast![0], areaCode: "200", areaName: "A-area-2" },
    ];
    const anchor = active(
      "anchor", "A", "2026-07-28T20:01:00Z", NOW - 10_000,
      "津波警報", mode === "partial-cancel" ? "取消" : "発表",
    );
    anchor.forecast = mode === "partial-cancel"
      ? [{ ...baseInfo.forecast[0] }]
      : [{ ...baseInfo.forecast[0], areaCode: null }];
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate();
    seed(baseInfo, seedState, seedGate); seed(anchor, seedState, seedGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(seedGate.exportDurableEntries());
    install([baseInfo, anchor]);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.hasPersistedEvent("A")).toBe(true);

    const missingState = new TsunamiStateHolder(); const missingGate = new TelegramRevisionGate();
    missingGate.restoreDurableEntries(seedGate.exportDurableEntries());
    install([anchor]);
    expect(await restore(missingState, missingGate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingGateOnlyBase" }));
  });

  it.each(["発表", "訂正"] as const)("review #1 / §5.14 gate-only direct %s requires the baseline current semantic payload", async (infoType) => {
    const accepted = active("accepted", "A", "2026-07-28T20:00:00Z", NOW - 10_000, "津波警報", infoType);
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate();
    seed(accepted, seedState, seedGate);
    const mismatch = active("rest", "A", accepted.reportDateTime, accepted.meta.receivedAtMs, "津波注意報", infoType);
    install([mismatch]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(seedGate.exportDurableEntries());
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "baselineGateMismatch", retryable: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #1 / §5.14 isolated cancellation target mismatch is fail-closed before commit", async () => {
    const baseInfo = active("base", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    baseInfo.forecast = [
      { ...baseInfo.forecast![0], areaCode: "100" },
      { ...baseInfo.forecast![0], areaCode: "200" },
    ];
    const acceptedAnchor = active("accepted-anchor", "A", "2026-07-28T20:01:00Z", NOW - 10_000, "津波警報", "取消");
    acceptedAnchor.forecast = [{ ...baseInfo.forecast[0], areaCode: "100" }];
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate();
    seed(baseInfo, seedState, seedGate); seed(acceptedAnchor, seedState, seedGate);

    const mismatchedAnchor = {
      ...acceptedAnchor,
      meta: { ...acceptedAnchor.meta, messageId: "rest-anchor" },
      forecast: [{ ...baseInfo.forecast[1], areaCode: "200" }],
    };
    install([baseInfo, mismatchedAnchor]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(seedGate.exportDurableEntries());
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "baselineGateMismatch" }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #1 / §5.14 gate-only direct base also requires the canonical holder postcondition", async () => {
    const emptyEnvelope = active("empty", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    emptyEnvelope.forecast = [];
    const seedState = new TsunamiStateHolder(); const seedGate = new TelegramRevisionGate();
    seed(emptyEnvelope, seedState, seedGate);
    expect(seedState.hasPersistedEvent("A")).toBe(false);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(seedGate.exportDurableEntries()); install([emptyEnvelope]);
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingGateOnlyBase" }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #2 / §5.8 holder-backed mixed anchors replay aggregate envelope in global transport order", async () => {
    const b = active("b-base", "B", "2026-07-28T20:00:00Z", NOW - 30_000, "津波注意報");
    const a = active("a-base", "A", "2026-07-28T20:01:00Z", NOW - 20_000);
    a.forecast = [
      { ...a.forecast![0], areaCode: "100" },
      { ...a.forecast![0], areaCode: "200" },
    ];
    const partial = active("a-partial", "A", "2026-07-28T20:02:00Z", NOW - 10_000, "津波警報", "取消");
    partial.forecast = [{ ...a.forecast[0] }];
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    seed(b, state, gate); seed(a, state, gate); seed(partial, state, gate);
    expect(state.cloneSnapshot().eventInfos.map(([eventId]) => eventId)).toEqual(["B", "A"]);
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    install([partial, a, b]);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete", changed: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(state.cloneSnapshot().eventInfos.map(([eventId]) => eventId)).toEqual(["B", "A"]);
    expect(state.getLastInfo()?.meta.eventId.value).toBe("A");
  });

  it("§5.15 body failure and identity/parse failure are closed reasons with unchanged owners", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); install([a]);
    mockBody.mockResolvedValue({ kind: "failed", reason: "notFound" });
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ kind: "incomplete", reason: "bodyUnavailable", bodyReason: "notFound", retryable: true }));
    install([a]); mockParse.mockReturnValue(null);
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ kind: "incomplete", reason: "parseFailed", retryable: false }));
    install([a]); mockParse.mockImplementation((message) => parsedById.get(message.id) ?? null); parsedById.set("a", { ...a, meta: { ...a.meta, eventId: { raw: "other", value: "other", valid: true } } });
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ kind: "incomplete", reason: "bodyIdentityMismatch", retryable: false }));
  });

  it("§5.15 duplicate id, token loop, order violation, and equal payload conflict are distinct", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000); parsedById.set("a", a);
    mockList.mockResolvedValue(response([itemFor(a), itemFor(a)]));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ reason: "duplicateItemId" }));
    mockList.mockImplementation(async (_key, query) => (typeof query === "string" || query.cursorToken == null) ? response([itemFor(a)], "same") : response([], "same"));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ reason: "cursorTokenLoop" }));
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000); parsedById.set("b", b);
    mockList.mockResolvedValue(response([itemFor(a), itemFor(b)]));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ reason: "listOrderInvalid" }));
    const conflict = active("c", "A", "2026-07-28T20:00:00Z", NOW - 19_000, "津波注意報"); parsedById.set("c", conflict);
    mockList.mockResolvedValue(response([itemFor(conflict), itemFor(a)]));
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ reason: "equalRevisionPayloadConflict" }));
  });

  it.each([
    ["network", true], ["notFound", true], ["contentType", true],
    ["forbidden", false], ["tooLarge", false],
  ] as const)("review #3 / §5.15 bodyUnavailable %s keeps both owners unchanged and retryable=%s", async (bodyReason, retryable) => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); install([a]);
    mockBody.mockResolvedValue({ kind: "failed", reason: bodyReason });
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW })).toEqual({
      kind: "incomplete", changed: false, reason: "bodyUnavailable", bodyReason, retryable,
    });
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.15 a second-body failure discards the already staged first body", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000); install([a, b]);
    mockBody.mockImplementation(async (_key, id) => id === "a"
      ? { kind: "failed", reason: "network" }
      : { kind: "ok", xml: XML });
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "bodyUnavailable", bodyReason: "network" }));
    expect(mockBody.mock.calls.map((call) => call[1])).toEqual(["b", "a"]);
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["mid-page", "after-scan"] as const)("review #3 / §5.11 %s list failure is retryable and atomic", async (point) => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); parsedById.set("a", a);
    if (point === "mid-page") {
      mockList.mockResolvedValueOnce(response([itemFor(a)], "next"))
        .mockRejectedValueOnce(new Error("mid-page"));
    } else {
      mockList.mockResolvedValueOnce(response([itemFor(a)]))
        .mockRejectedValueOnce(new Error("after"));
    }
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()]; const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "listUnavailable", retryable: true }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.15 fixes response, page-size, and cursor-shape failure reasons", async () => {
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    mockList.mockResolvedValue({ ...response([]), items: null } as unknown as TelegramListResponse);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ reason: "listResponseInvalid" }));

    const oversized = Array.from({ length: TSUNAMI_RESTORE_PAGE_LIMIT + 1 }, (_, index) =>
      itemFor(active(`p-${index}`, `P-${index}`, "2026-07-28T20:00:00Z", NOW - index)));
    mockList.mockResolvedValue(response(oversized));
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ reason: "pageSizeExceeded" }));

    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    mockList.mockResolvedValue(response([itemFor(a)], ""));
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ reason: "invalidCursorToken" }));
  });

  it("review #3 / §5.15 enforces the full-scan page limit before another request", async () => {
    let page = 0;
    mockList.mockImplementation(async () => {
      page += 1;
      const parsed = active(`page-${page}`, `PAGE-${page}`, "2026-07-28T20:00:00Z", NOW - page);
      return response([itemFor(parsed)], `cursor-${page}`);
    });
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate()))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "pageLimitExceeded", retryable: false }));
    expect(mockList).toHaveBeenCalledTimes(TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN);
  });

  it("review #3 / §5.15 enforces the full-window item limit atomically", async () => {
    const all = Array.from({ length: TSUNAMI_RESTORE_MAX_ITEMS_PER_SCAN + 1 }, (_, index) =>
      itemFor(active(`item-${index}`, `ITEM-${index}`, "2026-07-28T20:00:00Z", NOW - index)));
    mockList.mockImplementation(async (_key, query) => {
      const cursor = typeof query === "string" ? undefined : query.cursorToken;
      if (cursor == null) return response(all.slice(0, 100), "p2");
      if (cursor === "p2") return response(all.slice(100, 200), "p3");
      return response(all.slice(200));
    });
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate()))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "itemLimitExceeded", retryable: false }));
    expect(mockList).toHaveBeenCalledTimes(3);
  });

  it("review #3 / §5.15 enforces the body request ceiling without issuing the excess request", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000); install([a, b]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, undefined, undefined, {
      now: () => NOW,
      testMaxBodyFetchesPerRound: 1,
    })).toEqual(expect.objectContaining({ kind: "incomplete", reason: "bodyFetchLimitExceeded", retryable: false }));
    expect(mockBody).toHaveBeenCalledTimes(1);
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
  });

  it("review #3 / §5.12 stops after four unstable full-window rounds", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const b = active("b", "B", "2026-07-28T20:01:00Z", NOW - 10_000);
    parsedById.set("a", a); parsedById.set("b", b);
    let scan = 0;
    mockList.mockImplementation(async () => (++scan % 2 === 1
      ? response([itemFor(a)])
      : response([itemFor(b), itemFor(a)])));
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "headStabilityLimitExceeded", retryable: true }));
    expect(mockList).toHaveBeenCalledTimes(8);
    expect(mockBody).toHaveBeenCalledTimes(4);
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.15 rejects unordered revisions before replay", async () => {
    const missing = active("missing", "A", "2026-07-28T20:00:00Z", NOW - 20_000, "津波警報", "発表", null);
    const numeric = active("numeric", "A", "2026-07-28T20:00:00Z", NOW - 10_000, "津波警報", "訂正", "1");
    install([missing, numeric]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "unorderedReplayRevision" }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
  });

  it("review #3 / §5.15 derives retryable only from the closed reason/detail table", () => {
    const yes: TsunamiRestoreFailure[] = [
      { reason: "listUnavailable" }, { reason: "headStabilityLimitExceeded" },
      { reason: "coverageMissingPersistedEvent" }, { reason: "staleVersion" },
      { reason: "bodyUnavailable", bodyReason: "network" },
      { reason: "bodyUnavailable", bodyReason: "notFound" },
      { reason: "bodyUnavailable", bodyReason: "contentType" },
    ];
    const no: TsunamiRestoreFailure[] = [
      { reason: "bodyUnavailable", bodyReason: "forbidden" },
      { reason: "bodyUnavailable", bodyReason: "tooLarge" },
      ...([
        "invalidRestoreClock", "listResponseInvalid", "pageSizeExceeded", "pageLimitExceeded",
        "itemLimitExceeded", "duplicateItemId", "invalidCursorToken", "cursorTokenLoop",
        "listOrderInvalid", "listItemInvalid", "bodyFetchLimitExceeded", "bodyIdentityMismatch",
        "parseFailed", "replayTimeInvalid", "unorderedReplayRevision", "equalRevisionPayloadConflict",
        "baselineGateMismatch", "baselineOutsideRestoreWindow", "coverageMissingGateOnlyBase",
        "coverageMissingNewEventBase", "tsunamiReplayRejected",
      ] as const).map((reason) => ({ reason })),
      { reason: "admissionRejected", admissionReason: "any" },
    ];
    expect(yes.map(tsunamiRestoreFailureIsRetryable)).toEqual(yes.map(() => true));
    expect(no.map(tsunamiRestoreFailureIsRetryable)).toEqual(no.map(() => false));
  });

  it("review #3 / §5.16 production gate/process rejects capacityExceeded atomically", async () => {
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    const baseInfo = active("source", "SOURCE", "2026-07-28T19:00:00Z", NOW - 20_000);
    const cancellation = active("source-cancel", "SOURCE", "2026-07-28T19:01:00Z", NOW - 10_000, "津波警報", "取消");
    seed(baseInfo, sourceState, sourceGate); seed(cancellation, sourceState, sourceGate);
    const tombstone = sourceGate.exportDurableEntries().find((entry) => entry.stateSubjectKey === "tsunami:SOURCE")!;
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(Array.from({ length: 512 }, (_, index) => ({
      ...structuredClone(tombstone),
      stateSubjectKey: `tsunami:protected-${index}`,
    })));
    const candidate = active("candidate", "NEW", "2026-07-28T20:00:00Z", NOW - 5_000); install([candidate]);
    const state = new TsunamiStateHolder(); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "tsunamiReplayRejected", retryable: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.16 production gate/process rejects invalidRevision atomically", async () => {
    const valid = active("invalid-revision", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    const invalid: ParsedTsunamiInfo = {
      ...valid,
      meta: { ...valid.meta, type: { ...valid.meta.type, valid: false } },
    };
    install([invalid]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "tsunamiReplayRejected", retryable: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §5.16 production gate/process rejects cancelTargetMismatch atomically", async () => {
    const cancellation = active("cancel-target", "A", "2026-07-28T20:00:00Z", NOW - 10_000, "津波警報", "取消");
    let valueReads = 0;
    const volatileEventId = { ...cancellation.meta.eventId };
    Object.defineProperty(volatileEventId, "value", {
      configurable: true,
      enumerable: true,
      get: () => {
        valueReads += 1;
        return valueReads <= 2 ? "A" : "B";
      },
    });
    const volatile: ParsedTsunamiInfo = {
      ...cancellation,
      meta: { ...cancellation.meta, eventId: volatileEventId },
    };
    install([volatile]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "tsunamiReplayRejected", retryable: false }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
  });

  it("§5.17 invalid fixed clock and future-skew body fail before replay", async () => {
    for (const invalidNow of [Number.NaN, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await restoreTsunamiState("key", new TsunamiStateHolder(), new TelegramRevisionGate(), undefined, undefined, { now: () => invalidNow }))
        .toEqual(expect.objectContaining({ reason: "invalidRestoreClock" }));
    }
    const future = active("future", "A", new Date(NOW).toISOString(), NOW + FUTURE_SKEW_PLUS_ONE);
    install([future]);
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ reason: "replayTimeInvalid" }));
  });

  it("review #3 / §5.17 reads the attempt clock once and rejects report skew +1 before replay", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    mockList.mockResolvedValue(response([]));
    expect(await restoreTsunamiState("key", new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual({ kind: "noData", changed: false });
    expect(now).toHaveBeenCalledTimes(1);

    const received = NOW - 20_000;
    const invalidReport = active(
      "report-future", "A", new Date(received + FUTURE_SKEW_PLUS_ONE).toISOString(), received,
    );
    install([invalidReport]);
    const gate = new TelegramRevisionGate(); const before = gate.cloneSnapshot();
    expect(await restore(new TsunamiStateHolder(), gate))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "replayTimeInvalid" }));
    expect(gate.cloneSnapshot()).toEqual(before);
  });

  it("review #3 / §5.17 accepts both skew boundaries without sweeping an unrelated live family entry", async () => {
    const received = NOW + 15 * 60_000;
    const boundary = active("boundary", "A", new Date(received + 15 * 60_000).toISOString(), received);
    install([boundary]);
    const otherSourceState = new TsunamiStateHolder(); const otherSourceGate = new TelegramRevisionGate();
    const other = active("other", "OTHER", "2026-07-28T19:00:00Z", NOW - 60_000);
    seed(other, otherSourceState, otherSourceGate);
    const unrelated = {
      ...structuredClone(otherSourceGate.exportDurableEntries()[0]),
      domain: "weather",
      revisionFamily: "OTHER",
      stateSubjectKey: "weather:other",
    };
    const gate = new TelegramRevisionGate(); gate.restoreDurableEntries([unrelated]);
    expect((await restore(new TsunamiStateHolder(), gate)).kind).toBe("complete");
    expect(gate.exportDurableEntries()).toContainEqual(expect.objectContaining({
      domain: "weather", revisionFamily: "OTHER", stateSubjectKey: "weather:other",
    }));
  });

  it.each(["partial-cancel", "unkeyed-normal"] as const)("review #3 / §5.18 holder/gate skew from %s remains a valid coverage binding", async (mode) => {
    const baseInfo = active("base", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    baseInfo.forecast = [
      { ...baseInfo.forecast![0], areaCode: "100" },
      { ...baseInfo.forecast![0], areaCode: "200" },
    ];
    const anchor = active(
      "anchor", "A", "2026-07-28T20:01:00Z", NOW - 10_000,
      "津波警報", mode === "partial-cancel" ? "取消" : "発表",
    );
    anchor.forecast = mode === "partial-cancel"
      ? [{ ...baseInfo.forecast[0] }]
      : [{ ...baseInfo.forecast[0], areaCode: null }];
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    seed(baseInfo, state, gate); seed(anchor, state, gate);
    const persisted = state.getPersistedKeyedActive().find((entry) => entry.meta.eventId.value === "A")!;
    const gateEntry = gate.exportDurableEntries().find((entry) => entry.stateSubjectKey === "tsunami:A")!;
    expect(tsunamiActiveMatchesGate(persisted, gateEntry)).toBe(true);
    install([anchor]);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete" }));
    expect(state.hasPersistedEvent("A")).toBe(true);
  });

  it("§5.19 rejects a new EventID whose first transport item is not reconstructible", async () => {
    const partial = active("p", "NEW", "2026-07-28T20:00:00Z", NOW - 20_000);
    partial.forecast![0].areaCode = null;
    const full = active("f", "NEW", "2026-07-28T20:01:00Z", NOW - 10_000);
    install([partial, full]);
    expect(await restore(new TsunamiStateHolder(), new TelegramRevisionGate())).toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingNewEventBase" }));
  });

  it.each(["normal", "correction", "whole-cancel", "full-release"] as const)("review #3 / §5.19 accepts a new EventID reconstructible %s base", async (mode) => {
    const parsed = active(
      `new-${mode}`,
      `NEW-${mode}`,
      "2026-07-28T20:00:00Z",
      NOW - 10_000,
      mode === "full-release" ? "津波予報" : "津波警報",
      mode === "correction" ? "訂正" : mode === "whole-cancel" ? "取消" : "発表",
    );
    install([parsed]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    if (mode === "whole-cancel") {
      expect(state.hasPersistedEvent(`NEW-${mode}`)).toBe(false);
      expect(gate.exportDurableEntries()[0]?.cancelled).toBe(true);
    } else {
      expect(state.hasPersistedEvent(`NEW-${mode}`)).toBe(true);
    }
  });

  it.each(["partial-cancel", "unkeyed-normal"] as const)("review #3 / §5.19 rejects a new EventID with leading %s even before a later full base", async (mode) => {
    const full = active("full", "NEW", "2026-07-28T20:01:00Z", NOW - 10_000);
    const leading = active(
      "leading", "NEW", "2026-07-28T20:00:00Z", NOW - 20_000,
      "津波警報", mode === "partial-cancel" ? "取消" : "発表",
    );
    leading.forecast = [{
      ...full.forecast![0],
      ...(mode === "unkeyed-normal" ? { areaCode: null } : {}),
    }];
    install([leading, full]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "coverageMissingNewEventBase" }));
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
  });

  it("§5.6 commit epoch rejects a live mutation during body await without admission", async () => {
    const rest = active("rest", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const live = active("live", "B", "2026-07-28T20:01:00Z", NOW - 10_000);
    install([rest]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    mockBody.mockImplementation(async () => { seed(live, state, gate); return { kind: "ok", xml: XML }; });
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "staleVersion", retryable: true }));
    expect(state.hasPersistedEvent("B")).toBe(true); expect(state.hasPersistedEvent("A")).toBe(false);
  });

  it("review #3 / §5.6 gate-only isolated restore rebases to a same-EventID live advance", async () => {
    const baseInfo = active("base", "A", "2026-07-28T20:00:00Z", NOW - 30_000);
    baseInfo.forecast = [
      { ...baseInfo.forecast![0], areaCode: "100" },
      { ...baseInfo.forecast![0], areaCode: "200" },
    ];
    const anchor = active("anchor", "A", "2026-07-28T20:01:00Z", NOW - 20_000, "津波警報", "取消");
    anchor.forecast = [{ ...baseInfo.forecast[0] }];
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    seed(baseInfo, sourceState, sourceGate); seed(anchor, sourceState, sourceGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(sourceGate.exportDurableEntries());
    const live = active("live", "A", "2026-07-28T20:02:00Z", NOW - 10_000, "津波注意報");
    install([baseInfo, anchor]);
    let advanced = false;
    mockBody.mockImplementation(async () => {
      if (!advanced) { advanced = true; seed(live, state, gate); }
      return { kind: "ok", xml: XML };
    });
    const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "staleVersion", retryable: true }));
    expect(callback).not.toHaveBeenCalled();
    expect(state.getLastInfo()?.meta.messageId).toBe("live");

    install([baseInfo, anchor, live]);
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "complete" }));
    expect(state.getLastInfo()?.meta.messageId).toBe("live");
    expect(gate.exportDurableEntries().find((entry) => entry.stateSubjectKey === "tsunami:A")
      ?.comparison.revision.reportDateTime.raw).toBe(live.meta.reportDateTime.raw);
  });

  it("§5.6 admission commit epoch rejects live B, then rebases without rolling lastInfo back to older A", async () => {
    const rest = active("rest", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const live = active("live", "B", "2026-07-28T20:01:00Z", NOW - 10_000);
    install([rest]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const coordinator = admission(state, gate);
    const callback = vi.fn();
    mockBody.mockImplementation(async () => {
      seed(live, state, gate);
      return { kind: "ok", xml: XML };
    });
    const first = await restoreTsunamiState("key", state, gate, callback, coordinator, { now: () => NOW });
    expect(first).toEqual(expect.objectContaining({ kind: "incomplete", reason: "staleVersion", retryable: true }));
    expect(callback).not.toHaveBeenCalled();
    install([rest, live]);
    const second = await restoreTsunamiState("key", state, gate, undefined, coordinator, { now: () => NOW });
    expect(second).toEqual(expect.objectContaining({ kind: "complete", changed: true }));
    expect(state.hasPersistedEvent("A")).toBe(true); expect(state.hasPersistedEvent("B")).toBe(true);
    expect(state.getLastInfo()?.meta.eventId.value).toBe("B");
  });

  it("review #3 / §5.8 reverse input orders converge by infoType within EventID and item id across EventIDs", async () => {
    const received = NOW - 10_000;
    const normal = active("z-normal", "A", "2026-07-28T20:00:00Z", received);
    const correction = active("y-correction", "A", "2026-07-28T20:00:00Z", received, "津波注意報", "訂正");
    const cancel = active("x-cancel", "A", "2026-07-28T20:00:00Z", received, "津波警報", "取消");
    const run = async (items: readonly ParsedTsunamiInfo[]) => {
      install(items);
      const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
      expect((await restore(state, gate)).kind).toBe("complete");
      return { state: state.cloneSnapshot(), gate: gate.cloneSnapshot() };
    };
    const sameForward = await run([normal, correction, cancel]);
    const sameReverse = await run([cancel, correction, normal]);
    expect(sameForward.state).toEqual(sameReverse.state);
    expect(sameForward.gate.states.find((entry) => entry.key === "tsunami:VTSE41:tsunami:A")?.cancelled).toBe(true);

    const eventIdFirst = active("z-item", "A-event", "2026-07-28T20:00:00Z", received, "津波注意報");
    const idFirst = active("a-item", "Z-event", "2026-07-28T20:00:00Z", received);
    const crossForward = await run([eventIdFirst, idFirst]);
    const crossReverse = await run([idFirst, eventIdFirst]);
    expect({ keyed: crossForward.state.keyedForecasts, events: crossForward.state.eventInfos, last: crossForward.state.lastInfo })
      .toEqual({ keyed: crossReverse.state.keyedForecasts, events: crossReverse.state.eventInfos, last: crossReverse.state.lastInfo });
    expect(crossForward.state.lastInfo?.meta.eventId.value).toBe("A-event");
  });

  it("review #3 / §6 corrected active survives a real persistence round-trip and REST outage", async () => {
    const normal = active("normal", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const correction = active("correction", "A", normal.reportDateTime, NOW - 10_000, "大津波警報", "訂正");
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    seed(normal, sourceState, sourceGate); seed(correction, sourceState, sourceGate);
    const restarted = roundTrip(sourceState, sourceGate);
    mockList.mockRejectedValue(new Error("REST unavailable"));
    expect(await restore(restarted.state, restarted.gate))
      .toEqual(expect.objectContaining({ kind: "incomplete", reason: "listUnavailable", retryable: true }));
    expect(restarted.state.getLevel()).toBe("大津波警報");
    expect(restarted.state.getLastInfo()).toEqual(correction);
  });

  it("review #3 / §6 same-revision normal REST cannot resurrect a persisted cancellation tombstone", async () => {
    const normal = active("normal", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const cancellation = active("cancel", "A", normal.reportDateTime, NOW - 10_000, "津波警報", "取消");
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    seed(normal, sourceState, sourceGate); seed(cancellation, sourceState, sourceGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(sourceGate.exportDurableEntries()); install([normal]);
    const beforeGate = gate.cloneSnapshot(); const callback = vi.fn();
    expect(await restoreTsunamiState("key", state, gate, callback, undefined, { now: () => NOW }))
      .toEqual(expect.objectContaining({ kind: "complete", changed: false }));
    expect(state.hasPersistedEvent("A")).toBe(false);
    expect(gate.cloneSnapshot()).toEqual(beforeGate);
    expect(callback).not.toHaveBeenCalled();
  });

  it("review #3 / §6 same-revision normal REST cannot roll a persisted correction back", async () => {
    const normal = active("normal", "A", "2026-07-28T20:00:00Z", NOW - 30_000);
    const correction = active("correction", "A", normal.reportDateTime, NOW - 20_000, "大津波警報", "訂正");
    const lateNormal = { ...normal, meta: { ...normal.meta, messageId: "late-normal", receivedAtMs: NOW - 10_000 } };
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    seed(normal, state, gate); seed(correction, state, gate); install([correction, lateNormal]);
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "complete" }));
    expect(state.getLastInfo()).toEqual(correction);
    expect(gate.exportDurableEntries().find((entry) => entry.stateSubjectKey === "tsunami:A")
      ?.comparison.revision.infoType.value).toBe("訂正");
  });

  it("review #3 / §6 REST outage preserves a persisted tombstone that still rejects a delayed report", async () => {
    const normal = active("normal", "A", "2026-07-28T20:00:00Z", NOW - 20_000);
    const cancellation = active("cancel", "A", "2026-07-28T20:01:00Z", NOW - 10_000, "津波警報", "取消");
    const sourceState = new TsunamiStateHolder(); const sourceGate = new TelegramRevisionGate();
    seed(normal, sourceState, sourceGate); seed(cancellation, sourceState, sourceGate);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(sourceGate.exportDurableEntries());
    mockList.mockRejectedValue(new Error("REST unavailable"));
    const before = gate.cloneSnapshot();
    expect(await restore(state, gate)).toEqual(expect.objectContaining({ kind: "incomplete", reason: "listUnavailable" }));
    expect(gate.cloneSnapshot()).toEqual(before);
    parsedById.set("delayed", { ...normal, meta: { ...normal.meta, messageId: "delayed", receivedAtMs: NOW } });
    expect(processTsunami(toWsDataMessageFromRestBody(itemFor(normal, "delayed"), XML, NOW), {
      tsunamiState: state, revisionGate: gate,
    })).toEqual({ kind: "suppressed" });
    expect(state.getLastInfo()).toBeNull();
  });

  it("§5.23 warns exactly once with the closed top-level reason", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockList.mockRejectedValue(new Error("down"));
    await restore(new TsunamiStateHolder(), new TelegramRevisionGate());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=listUnavailable"));
  });

  it("§5.23 preserves coordinator rejection as non-retryable admissionRejected", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000);
    install([a]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate();
    const coordinator = admission(state, gate);
    vi.spyOn(coordinator, "transact").mockReturnValue({ kind: "rejected", reason: "candidateSerializationFailed" });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, coordinator, { now: () => NOW })).toEqual({
      kind: "incomplete", changed: false, retryable: false,
      reason: "admissionRejected", admissionReason: "candidateSerializationFailed",
    });
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=admissionRejected admissionReason=candidateSerializationFailed"));
  });

  it("review #3 / §5.23 maps the reserved coordinator rejection to retryable staleVersion", async () => {
    const a = active("a", "A", "2026-07-28T20:00:00Z", NOW - 10_000); install([a]);
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const coordinator = admission(state, gate);
    vi.spyOn(coordinator, "transact").mockReturnValue({ kind: "rejected", reason: "tsunamiRestoreStaleEpoch" });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    expect(await restoreTsunamiState("key", state, gate, callback, coordinator, { now: () => NOW })).toEqual({
      kind: "incomplete", changed: false, retryable: true, reason: "staleVersion",
    });
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=staleVersion"));
  });
});

const FUTURE_SKEW_PLUS_ONE = 15 * 60_000 + 1;
