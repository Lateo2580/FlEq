import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { NotificationIntent } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { WeatherCurrentSnapshot, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import manifest from "../../tools/corpus/manifest.json";
import corpus from "../../tools/corpus/sequences.json";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { fixtureDriver, fixtureState, stringCodec } from "../checkpoint-shutdown/runtime-fixture";

const NOW = 1_800_000_000_000;

function emptyState(): WeatherCurrentUnitState {
  return { schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [], histories: [],
    ownership: {}, tombstones: [], freshness: [], unavailable: [], intents: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}

function clock(wallTimeMs = NOW, monotonicMs = 0) { return { wallTimeMs, monotonicMs }; }

function decodeFixture(file: string, headType: string, transform: (xml: string) => string = (xml) => xml,
  inputId = file): DecodedMaterial {
  const body = Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8")));
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: NOW, origin: "replay",
    kind: "replay", body, headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

function receive(state: WeatherCurrentUnitState, material: DecodedMaterial, monotonicMs = 0) {
  return reduceWeatherCurrentUnit(state, { kind: "receive", material, clock: clock(NOW, monotonicMs) });
}

function withOperation(xml: string, operation: Operation): string {
  return xml.replace("<Status>通常</Status>", `<Status>${{ normal: "通常", training: "訓練", test: "試験" }[operation]}</Status>`);
}

function bodyWarning(xml: string): string {
  const information = xml.match(/<Information type="気象警報・注意報（市町村等）">([\s\S]*?)<\/Information>/)?.[1];
  if (information == null) throw new Error("fixture has no warning information");
  const items = information.replace(/<\/Kind>/g, "<Status>発表</Status></Kind>")
    .replace(/<Areas[^>]*>([\s\S]*?)<\/Areas>/g, "$1");
  return xml.replace(/<Body[^>]*\/>/, `<Body><Warning type="気象警報・注意報（市町村等）">${items}</Warning></Body>`);
}

function atTime(xml: string, time: string, serial = ""): string {
  return xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`)
    .replace(/<Serial(?:\/)?>[^<]*<\/Serial>|<Serial\/>/, `<Serial>${serial}</Serial>`);
}

function cancellation(xml: string, time: string): string {
  return atTime(xml, time).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
    .replace(/<Body[\s\S]*<\/Body>/, "<Body/>");
}

function replaceBodyStatus(xml: string, status: string): string {
  return xml.replace(/(<Body[\s\S]*?<Status>)[^<]*(<\/Status>)/, `$1${status}$2`);
}

function source(operation: Operation, family: string, subject: string, time: string, inputId: string) {
  return { inputId, origin: "replay" as const, operation, family, subject,
    reportDateTimeRaw: time, serialRaw: "", infoTypeRaw: "発表" };
}

function snapshot(operation: Operation, family: string, office: string, time: string, inputId: string,
  scope: "national" | "partial" = family === "VPWS50" ? "national" : "partial"): WeatherCurrentSnapshot {
  const subject = `${operation}/${family}/${office}`;
  return { subject, operation, scope, office, source: source(operation, family, subject, time, inputId),
    phenomena: { [JSON.stringify([family, scope, office, "all", ""])]: { inputId } } };
}

function pendingIntent(): NotificationIntent {
  const subject = "normal/VPWS50/気象庁";
  return { id: "weather-intent", unit: "U-W", subject, operation: "normal",
    source: source("normal", "VPWS50", subject, "2026-09-06T10:00:00+09:00", "intent"),
    transition: "activated", channel: "desktop", payload: {}, createdAt: NOW,
    expiresAt: NOW + 10_000, nextAttemptAt: NOW, attempts: 0,
    configRevision: "test", disposition: "pending" };
}

class MemoryCheckpointFileSystem implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  failWrite = false;
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return { write: async (value) => { if (this.failWrite) throw new Error("injected write failure"); bytes = value.slice(); },
      sync: async () => {}, close: async () => { this.files.set(path, bytes); } };
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes == null) throw new Error("missing temporary");
    this.files.set(to, bytes); this.files.delete(from);
  }
  async syncDirectory(): Promise<void> {}
}

class MemoryDiagnosticFileSystem implements DiagnosticFileSystem {
  readonly filesByPath = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async appendFile(path: string, data: string): Promise<void> { this.filesByPath.set(path, (this.filesByPath.get(path) ?? "") + data); }
  async readLastByte(path: string): Promise<number | null> { return Buffer.from(this.filesByPath.get(path) ?? "").at(-1) ?? null; }
  async writeFile(path: string, data: string): Promise<void> { this.filesByPath.set(path, data); }
  async rename(from: string, to: string): Promise<void> { this.filesByPath.set(to, this.filesByPath.get(from) ?? ""); this.filesByPath.delete(from); }
  async readFile(path: string): Promise<string> { return this.filesByPath.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.filesByPath.delete(path); }
}

function runtime(unit: WeatherCurrentUnitState) {
  const state = fixtureState({}, { "U-W": unit.persistence }, "weather-test");
  return { ...state, units: { ...state.units, "U-W": unit } };
}

function config() {
  return { appName: "fleq-p2", stateDirectory: "weather-state", legacyAppName: "fleq",
    legacyStateDirectory: "legacy-state", diagnosticDirectory: "weather-diagnostics" } as const;
}

describe("P2 weather-current unit", () => {
  it("P2-A5-T01 contractBoundary / AC01: family validation order, legal omissions and atomic rejection", () => {
    const partial = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    expect(receive(emptyState(), partial).decisions[0].decision).toBe("changed");
    const cancelled = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:01:00+09:00"));
    expect(receive(receive(emptyState(), partial).state, cancelled).decisions[0].decision).toBe("changed");
    const emptyCancelled = decodeFixture("15_16_02_251222_VPWW57", "VPWW57", (xml) =>
      cancellation(xml, "2020-06-22T23:01:00+09:00").replace(/<Body[\s\S]*<\/Body>/, "<Body/>"), "empty-cancel");
    expect(receive(receive(emptyState(), partial).state, emptyCancelled).decisions[0].decision).toBe("changed");
    expect(receive(emptyState(), decodeFixture("18_00_01_260830_VPNO50_switch", "VPNO50")).decisions[0].decision).toBe("changed");
    expect(receive(emptyState(), decodeFixture("18_00_01_260830_VPNO50_issue", "VPNO50")).decisions[0])
      .toMatchObject({ decision: "unchanged", reason: "noChange" });

    const state = { ...receive(emptyState(), partial).state, intents: [pendingIntent()] };
    const cases = [
      ["identityMissing", (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, "<EditorialOffice/>")],
      ["identityInvalid", (xml: string) => xml.replace(/(<Body[\s\S]*?<Area>[\s\S]*?<Code>)[^<]*(<\/Code>)/, "$1bad$2")],
      ["identityInvalid", (xml: string) => xml.replace(/(<EditorialOffice>[^<]*<\/EditorialOffice>)/, "$1$1")],
      ["requiredStructureMissing", (xml: string) => xml.replace(/<Body[\s\S]*<\/Body>/, "<Body/>")],
      ["requiredStructureMissing", (xml: string) => xml.replace(/<Warning type="[^"]+">/, "<Warning>")],
      ["requiredStructureInvalid", (xml: string) => replaceBodyStatus(xml, "未知")],
      ["requiredStructureInvalid", (xml: string) => xml.replace(/(<Status>発表<\/Status>)/, "$1$1")],
    ] as const;
    for (const [reason, transform] of cases) {
      const rejected = receive(state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57", transform, reason));
      expect(rejected.decisions[0]).toMatchObject({ decision: "rejected", reason });
      expect(rejected.state.national).toBe(state.national);
      expect(rejected.state.partials).toBe(state.partials);
      expect(rejected.state.histories).toBe(state.histories);
      expect(rejected.state.intents).toBe(state.intents);
      expect(rejected.intents).toEqual([]);
      expect(rejected.outcomes).toEqual([]);
    }
    // R1: simultaneous defects must use the identity stage before structure.
    const malformedBody = '<Body><Warning type="気象警報・注意報（府県予報区等）"><Item><Area/></Item></Warning></Body>';
    for (const duplicateOffice of [false, true]) {
      const broken = decodeFixture("15_16_02_251222_VPWW57", "VPWW57", (xml) => {
        const body = xml.replace(/<Body[\s\S]*<\/Body>/, malformedBody);
        return duplicateOffice ? body.replace(/(<EditorialOffice>[^<]*<\/EditorialOffice>)/, "$1$1") : body;
      });
      expect(receive(state, broken).decisions[0]).toMatchObject({ decision: "rejected", reason: "identityMissing" });
    }
    const duplicatedControl = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => xml.replace(/(<Control>[\s\S]*?<\/Control>)/, "$1$1"));
    expect(receive(state, duplicatedControl).decisions[0]).toMatchObject({ reason: "identityInvalid" });
    const emptyCode = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => xml.replace(/(<Body[\s\S]*?<Code>)[^<]*(<\/Code>)/, "$1$2"));
    expect(receive(state, emptyCode).decisions[0]).toMatchObject({ reason: "requiredStructureMissing" });
    // Third review R4: skip children of a duplicate Area, but check independent Items.
    const duplicateAreaBody = '<Body><Warning type="気象警報・注意報（府県予報区等）"><Item><Kind><Code>48</Code><Status>発表</Status></Kind><Area><Code>260000</Code></Area><Area/></Item></Warning></Body>';
    const duplicateArea = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => xml.replace(/<Body[\s\S]*<\/Body>/, duplicateAreaBody));
    expect(receive(state, duplicateArea).decisions[0]).toMatchObject({ reason: "identityInvalid" });
    const independentMissing = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => xml.replace(/<Body[\s\S]*<\/Body>/,
        duplicateAreaBody.replace("</Warning>", "<Item><Area/></Item></Warning>")));
    expect(receive(state, independentMissing).decisions[0]).toMatchObject({ reason: "identityMissing" });

    // R2: cancel omissions and VPNO50 structure are checked before semantic branching.
    const cancelWithBody = (body: string) => decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:01:00+09:00").replace("<Body/>", body));
    expect(receive(state, cancelWithBody("<Body><Warning/></Body>")).decisions[0].decision).toBe("changed");
    expect(receive(state, cancelWithBody('<Body><Warning type="気象警報・注意報（府県予報区等）"><Item><Area><Code>260000</Code></Area></Item></Warning></Body>'))
      .decisions[0]).toMatchObject({ decision: "rejected", reason: "requiredStructureMissing" });
    const vpnCases = [
      ["requiredStructureInvalid", (xml: string) => xml.replace("<Code>00</Code>", "<Code>00</Code><Code>00</Code>")],
      ["requiredStructureMissing", (xml: string) => xml.replace("<Code>00</Code>", "")],
      ["requiredStructureMissing", (xml: string) => xml.replace(/<Areas[^>]*>[\s\S]*?<\/Areas>/, "<Areas/>")],
    ] as const;
    for (const [reason, change] of vpnCases) {
      const step = receive(state, decodeFixture("18_00_01_260830_VPNO50_switch", "VPNO50", change));
      expect(step.decisions[0]).toMatchObject({ decision: "rejected", reason });
      expect(step.state.tombstones).toBe(state.tombstones);
      expect(() => weatherCurrentUnitCodec.encode(step.state)).not.toThrow();
    }
  });

  it("P2-A5-T02 acceptance / AC02-03: national, partial, ownership and VPNO50 ending share one generation", () => {
    const national = decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before", "VPWS50", bodyWarning);
    let state = receive(emptyState(), national).state;
    expect(state.national.normal?.subject).toBe("normal/VPWS50/気象庁");
    const partial = decodeFixture("18_00_01_260830_VPWW55_fukui_L5", "VPWW55");
    state = receive(state, partial).state;
    expect(state.partials[0].office).toBe("福井地方気象台");
    expect(Object.keys(state.ownership).length).toBeGreaterThan(0);
    const ended = receive(state, decodeFixture("18_00_01_260830_VPNO50_switch", "VPNO50"));
    expect(ended.state.tombstones.some((item) => item.source.family === "VPNO50")).toBe(true);
    expect(JSON.stringify(ended.state.partials).includes('"code":"33"')).toBe(false);
    expect(ended.state.persistence.currentGeneration).toBe(state.persistence.currentGeneration + 1);
    // R7: an older partial accepted after ending cannot reappear in public facts.
    const reapplied = receive({ ...ended.state, partials: [], histories: [], ownership: {} }, partial);
    expect(JSON.stringify(reapplied.state.partials)).not.toContain('"code":"33"');
    expect(JSON.stringify(reapplied.outcomes)).not.toContain('"code":"33"');
  });

  it("P2-A5-T03 contractBoundary / AC04: codec enforces combined retention counts", () => {
    const nationals = Object.fromEntries((['normal', 'training', 'test'] as const).map((operation, index) =>
      [operation, snapshot(operation, "VPWS50", "気象庁", `2026-09-06T10:0${index}:00+09:00`, `n${index}`)]));
    const nationalHistory = [0, 1].map((index) => snapshot(index === 0 ? "training" : "test", "VPWS50", "気象庁",
      `2026-09-05T10:0${index}:00+09:00`, `h${index}`));
    const partials = Array.from({ length: 128 }, (_, index) => snapshot("normal", "VPWW55", `office-${index}`,
      "2026-09-06T10:00:00+09:00", `p${index}`));
    const partialHistory = Array.from({ length: 8 }, (_, index) => snapshot(index % 2 ? "test" : "training", "VPWW57", "京都地方気象台",
      `2020-06-22T23:0${index}:00+09:00`, `ph${index}`));
    const state: WeatherCurrentUnitState = { ...emptyState(), national: nationals, partials,
      histories: [
        { subject: nationalHistory[0].subject, operation: nationalHistory[0].operation, reports: [nationalHistory[0]] },
        { subject: nationalHistory[1].subject, operation: nationalHistory[1].operation, reports: [nationalHistory[1]] },
        ...(["training", "test"] as const).map((operation) => ({
          subject: `${operation}/VPWW57/京都地方気象台`, operation,
          reports: partialHistory.filter((item) => item.operation === operation),
        })),
      ] };
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(state)).kind).toBe("restored");
    expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(state), partials: [...partials,
      snapshot("normal", "VPWW55", "overflow", "2026-09-06T10:00:00+09:00", "overflow")] }).kind).toBe("invalid");

    const intent = pendingIntent();
    const intentState = { ...emptyState(), intents: [intent] };
    expect(reduceWeatherCurrentUnit(intentState, { kind: "deadline", clock: clock(NOW + 9_999) })).toEqual({
      state: intentState, nextDeadline: { wallTimeMs: NOW + 10_000, monotonicMs: null },
      decisions: [], intents: [], outcomes: [], diagnostics: [],
    });
    const selected = reduceWeatherCurrentUnit(intentState, { kind: "intentUpdate",
      intentUpdate: { id: intent.id, attempts: 1, nextAttemptAt: NOW + 500, disposition: "pending" },
      clock: clock(NOW, 7) });
    expect(selected.decisions[0]).toMatchObject({ change: "deliveryOnly" });
    expect(selected.state.persistence).toMatchObject({ currentGeneration: 1, dirtySince: 7 });
    expect(reduceWeatherCurrentUnit(selected.state, { kind: "intentUpdate",
      intentUpdate: { id: "unknown", attempts: 1, nextAttemptAt: NOW, disposition: "pending" }, clock: clock() }).state)
      .toBe(selected.state);
    expect(reduceWeatherCurrentUnit(intentState, { kind: "deadline", clock: clock(NOW + 10_000) }).state.intents).toEqual([]);
    // R8: A1 must find the adopted completed intent; expiry later reclaims it.
    const attempt: NotificationAttempt = {
      attemptId: "weather-attempt", intentId: intent.id, unit: "U-W", subject: intent.subject,
      operation: intent.operation, channel: intent.channel, priorityGroup: "other", payload: {},
      soundAsset: null, selectedAtMonotonicMs: 1, timeoutAtMonotonicMs: 5001, expiresAt: intent.expiresAt,
    };
    const notificationRoot = new RuntimeCompositionRoot(config(), { "U-W": weatherCurrentUnitCodec }, {
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      runtimeCalls: { ...fixtureDriver().calls, reduceWeatherCurrentUnit,
        selectNotificationAttempt: (delivery) => ({
          state: { channels: { ...delivery.channels, desktop: { kind: "running", attempt } },
            intents: delivery.intents.map((item) => ({ ...item, attempts: 1, nextAttemptAt: NOW + 500 })) },
          attempts: [attempt], abortAttemptIds: [], dirtyUnits: ["U-W"], diagnostics: [],
        }),
        applyNotificationResult: (delivery) => ({
          state: { channels: { ...delivery.channels, desktop: { kind: "idle" } },
            intents: delivery.intents.map((item) => ({ ...item, disposition: "delivered" })) },
          dirtyUnits: ["U-W"], diagnostics: [],
        }),
      },
    });
    const selectedRuntime = notificationRoot.tick(runtime(intentState), clock(NOW + 1, 1));
    const completedRuntime = notificationRoot.dispatch(selectedRuntime.state, { kind: "notificationResult",
      result: { kind: "delivered", attemptId: attempt.attemptId, intentId: intent.id,
        channel: "desktop", completedAt: clock(NOW + 2, 2) } });
    const completed = completedRuntime.state.units["U-W"];
    expect(completed.intents[0]).toMatchObject({ disposition: "delivered", attempts: 1, expiresAt: intent.expiresAt });
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(completed)))
      .toMatchObject({ kind: "restored", state: { intents: completed.intents } });
    expect(notificationRoot.tick(completedRuntime.state, clock(intent.expiresAt, 3)).state.units["U-W"].intents).toEqual([]);
  });

  it("P2-A5-T04 regression / AC05-06: rejected newer marks only the exact freshness target", () => {
    const first = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    const state = receive(emptyState(), first).state;
    const rejected = decodeFixture("15_16_02_251222_VPWW57", "VPWW57", (xml) =>
      replaceBodyStatus(atTime(xml, "2020-06-22T23:01:00+09:00"), "未知"), "newer-invalid");
    const monitored = receive(state, rejected, 1);
    expect(monitored.decisions[0].decision).toBe("rejected");
    expect(monitored.state.freshness[0]).toMatchObject({ revisionOrder: "newer", freshnessSuspect: true });
    expect(monitored.state.partials).toBe(state.partials);
    // R3: invalid dates still identify a target, but never manufacture newer.
    const invalidTime = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2030-02-30T23:01:00+09:00"), "invalid-time");
    const unknown = receive(monitored.state, invalidTime);
    expect(unknown.state.freshness[0]).toMatchObject({ revisionOrder: "unknown", freshnessSuspect: true,
      candidateSource: { inputId: "invalid-time" }, suspectedSource: { inputId: "newer-invalid" } });
    expect(receive(state, invalidTime).state.freshness[0]).toMatchObject({ revisionOrder: "unknown", freshnessSuspect: false });
    expect(() => weatherCurrentUnitCodec.encode(unknown.state)).not.toThrow();
    const noHistory = receive(unknown.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:03:00+09:00"), "no-history"));
    expect(noHistory.state.unavailable[0].reason).toBe("historyUnavailable");
    expect(noHistory.state.freshness).toBe(unknown.state.freshness);
    const badArea = decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before", "VPWS50",
      (xml) => bodyWarning(xml).replace(/(<Body[\s\S]*?<Area>[\s\S]*?<Code>)[^<]*(<\/Code>)/, "$1bad$2")
        .replace(/(<Body[\s\S]*?)<Kind>[\s\S]*?<\/Kind>/, "$1"));
    expect(receive(emptyState(), badArea).state.freshness).toEqual([]);
    const training = receive(monitored.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => withOperation(xml, "training"))).state;
    expect(training.freshness[0].freshnessSuspect).toBe(true);
    const record = training.freshness[0];
    const cleared = reduceWeatherCurrentUnit(training, { kind: "coverageConfirmed", operation: "normal",
      family: "VPWW57", subject: record.target.subject, affectedScope: record.target.affectedScope, clock: clock(NOW, 2) });
    expect(cleared.state.freshness).toEqual([]);
  });

  it("P2-A5-T05 corpusHistory / AC07-09: history plus A3 save failure, shutdown and E10", async () => {
    const first = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    const second = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T23:01:00+09:00").replace(/<Code>48<\/Code>/g, "<Code>45</Code>"), "second");
    let state = receive(emptyState(), first).state;
    const originalOwnership = state.ownership;
    state = receive(state, second).state;
    const secondSnapshot = state.partials[0];
    state = { ...state, intents: [{ ...pendingIntent(), subject: secondSnapshot.subject, source: secondSnapshot.source }] };
    expect(state.histories.flatMap((item) => item.reports)).toHaveLength(1);
    const cancel = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:02:00+09:00"), "cancel");
    const restored = receive(state, cancel);
    expect(restored.state.partials[0].source.inputId).toBe(first.inputId);
    expect(restored.state.tombstones[0].source.inputId).toBe("cancel");
    // R7: restored meaning, ownership, old delivery and public facts agree.
    expect(restored.state.ownership).toEqual(originalOwnership);
    expect(restored.state.intents).toEqual([]);
    expect(JSON.stringify(restored.outcomes)).toContain('"code":"48"');
    expect(JSON.stringify(restored.outcomes)).not.toContain('"code":"45"');
    expect(receive(restored.state, second).decisions[0]).toMatchObject({ decision: "unchanged", reason: "stale" });
    const again = receive(restored.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:03:00+09:00"), "cancel-again"));
    expect(again.state.unavailable[0]?.reason).toBe("historyUnavailable");
    expect(again.state.ownership).toEqual({});
    expect(again.state.intents).toEqual([]);

    // R6: cancellation identity does not alias the operation's national slot.
    const national = receive(emptyState(), decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before",
      "VPWS50", bodyWarning)).state;
    const otherOffice = receive(national, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before",
      "VPWS50", (xml) => cancellation(bodyWarning(xml), "2026-09-06T10:05:00+09:00")
        .replace("<EditorialOffice>気象庁</EditorialOffice>", "<EditorialOffice>別官署</EditorialOffice>"), "other-office"));
    expect(otherOffice.state.national.normal).toBe(national.national.normal);
    expect(otherOffice.state.unavailable[0]).toMatchObject({ lastKnown: null, subject: "normal/VPWS50/別官署" });
    expect(() => weatherCurrentUnitCodec.encode(otherOffice.state)).not.toThrow();

    // Restore-input continuation is a unit path, not a runtime receive integration claim.
    const recovered = reduceWeatherCurrentUnit(emptyState(), {
      kind: "restore", persisted: weatherCurrentUnitCodec.encode(restored.state), clock: clock(),
    });
    const resumed = receive(recovered.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T23:04:00+09:00"), "resumed"));
    const corrected = receive(resumed.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T23:05:00+09:00").replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"),
      "corrected"));
    const recancelled = receive(corrected.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:06:00+09:00"), "recancelled"));
    expect(recancelled.state.partials[0].source.inputId).toBe("resumed");
    expect(recancelled.state.tombstones[0].source.inputId).toBe("recancelled");

    // Third review R3: restore an opaque subject, update that stream, then cancel it.
    const original = receive(emptyState(), first).state.partials[0];
    const opaque = { ...original, subject: "s", source: { ...original.source, subject: "s" } };
    const opaqueRestore = reduceWeatherCurrentUnit(emptyState(), { kind: "restore",
      persisted: weatherCurrentUnitCodec.encode({ ...emptyState(), partials: [opaque] }), clock: clock() });
    const opaqueUpdate = receive(opaqueRestore.state, second);
    expect(opaqueUpdate.state.partials).toHaveLength(1);
    expect(opaqueUpdate.state.partials[0]).toMatchObject({ subject: "s", source: { subject: "s", inputId: "second" } });
    expect(opaqueUpdate.state.histories).toMatchObject([{ subject: "s", reports: [{ subject: "s" }] }]);
    const opaqueCancel = receive(opaqueUpdate.state, cancel);
    expect(opaqueCancel.state.partials).toHaveLength(1);
    expect(opaqueCancel.state.partials[0]).toMatchObject({ subject: "s", source: { subject: "s", inputId: first.inputId } });
    expect(opaqueCancel.state.unavailable).toEqual([]);
    expect(opaqueCancel.state.tombstones[0].subject).toBe("s");
    expect(() => weatherCurrentUnitCodec.encode(opaqueCancel.state)).not.toThrow();

    expect(corpus.meta.p2Subsets.find((item) => item.subsetId === "P2-O06-U-W-v1")?.stepRefs)
      .toContain("expected:O06:31");
    const targetFamilies = new Set(["VPWS50", "VPWW55", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50"]);
    const covered: string[] = [];
    for (const fixture of manifest.fixtures) {
      const headType = fixture.transport.headType;
      if (headType == null || !targetFamilies.has(headType)) continue;
      const file = fixture.path.replace(/^test\/fixtures\//, "").replace(/\.xml$/, "");
      const step = receive(emptyState(), decodeFixture(file, headType));
      expect(step.state.unavailable, fixture.path).toEqual([]);
      if (file.includes("synthetic-vpws50-change-density"))
        expect(step.decisions[0], fixture.path).toMatchObject({ decision: "rejected", reason: "requiredStructureMissing" });
      covered.push(fixture.path);
    }
    expect(covered, covered.join(",")).toHaveLength(14);

    const calls = { ...fixtureDriver().calls, reduceWeatherCurrentUnit, toWeatherCurrentView };
    const adapter = new MemoryCheckpointFileSystem();
    const root = new RuntimeCompositionRoot(config(), { "U-W": weatherCurrentUnitCodec }, {
      checkpointFileSystem: adapter, diagnosticFileSystem: new MemoryDiagnosticFileSystem(), runtimeCalls: calls,
      clock: () => clock(NOW, NOW),
    });
    let running = runtime(restored.state);
    const request = root.scheduleCheckpoint(running, clock(NOW, NOW), "weather-save",
      { "U-W": { inputIds: [cancel.inputId], retryReason: "notRetry" } });
    if (request?.request == null) throw new Error("U-W checkpoint was not captured");
    adapter.failWrite = true;
    const failure = await root.executeCheckpoint(request.request, "weather-save", [cancel.inputId], "notRetry");
    running = root.applyCheckpointResult(running, failure.result, clock(NOW + 1, NOW + 1)).state;
    expect(running.units["U-W"].persistence.kind).toBe("failed");

    const shutdownRoot = new RuntimeCompositionRoot(config(), { "U-W": weatherCurrentUnitCodec }, {
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      runtimeCalls: calls, clock: () => clock(NOW + 2, NOW + 2),
    });
    const shutdownState = runtime(restored.state);
    const routed = shutdownRoot.dispatch(shutdownState, { kind: "mailboxCompleted", clock: clock(NOW + 2, NOW + 2), completion: {
      kind: "parser", messageId: first.inputId, inputId: first.inputId, runId: shutdownState.runId,
      encodedByteLength: 0, startedMonotonicMs: NOW + 2, completedMonotonicMs: NOW + 2,
      inputSequence: 1, result: { kind: "decoded", material: first },
    } }, { "U-W": { inputIds: [first.inputId], retryReason: "notRetry" } });
    // Wired route: the older redelivery reaches U-W as stale and records freshness only (AC06).
    const routedUnit = routed.state.units["U-W"];
    expect(routed.changedUnits).toEqual(["U-W"]);
    for (const field of ["national", "partials", "histories", "tombstones", "intents"] as const)
      expect(routedUnit[field]).toBe(restored.state[field]);
    expect(routedUnit.freshness.slice(restored.state.freshness.length)).toMatchObject([
      { candidateSource: { inputId: first.inputId }, decision: "unchanged", reason: "stale", revisionOrder: "older" }]);
    const generation = restored.state.persistence.currentGeneration + 1;
    expect(routedUnit.persistence.currentGeneration).toBe(generation);
    const summary = await shutdownRoot.shutdownRuntime(shutdownRoot.state, 1, clock(NOW + 2, NOW + 2));
    expect(summary.code, JSON.stringify(summary)).toBe(0);
    expect(summary.persistence["U-W"]).toMatchObject({ kind: "saved",
      currentGeneration: generation, savedGeneration: generation });

    let weatherEncodes = 0;
    const counted = { ...weatherCurrentUnitCodec, encode: (value: WeatherCurrentUnitState) => {
      weatherEncodes++; return weatherCurrentUnitCodec.encode(value);
    } };
    const e10Root = new RuntimeCompositionRoot(config(), { "U-E": stringCodec("U-E"), "U-W": counted }, {
      diagnosticFileSystem: new MemoryDiagnosticFileSystem(), runtimeCalls: calls,
      clock: () => clock(NOW + 3, NOW + 3),
    });
    const otherDirty = fixtureState({}, { "U-E": { kind: "pending", currentGeneration: 2, savedGeneration: 1,
      savedCapturedAt: 0, savedAckAt: 0, dirtySince: 1 } }, "e10");
    expect(e10Root.scheduleCheckpoint(otherDirty, clock(NOW + 3, NOW + 3), "e10",
      { "U-E": { inputIds: ["e10"], retryReason: "notRetry" } })?.request?.unit).toBe("U-E");
    expect(weatherEncodes).toBe(0);
  });

  it("P2-A5-T06 contractBoundary / AC10: all operation orders preserve separate national bases and view keys", () => {
    const operationOrders = [["normal", "training", "test"], ["test", "training", "normal"]] as const;
    for (const order of operationOrders) {
      let state = emptyState();
      for (const operation of order) state = receive(state, decodeFixture(
        "weather-alert-kind-area/synthetic-vpws50-change-density-before", "VPWS50",
        (xml) => withOperation(bodyWarning(xml), operation), `national-${operation}`)).state;
      expect(Object.keys(state.national).sort()).toEqual(["normal", "test", "training"]);
      for (const operation of ["normal", "training", "test"] as const)
        expect(state.national[operation]?.operation).toBe(operation);
      expect(toWeatherCurrentView(state).national).toEqual(state.national);
    }
  });

  it("P2-A5-T07 contractBoundary / AC10: non-normal update and cancellation leave normal base unchanged", () => {
    const material = (operation: Operation, transform: (xml: string) => string = (xml) => xml, id: string = operation) =>
      decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before", "VPWS50",
        (xml) => transform(withOperation(bodyWarning(xml), operation)), id);
    let state = receive(emptyState(), material("normal")).state;
    const normal = state.national.normal;
    state = receive(state, material("training")).state;
    state = receive(state, material("training", (xml) => atTime(xml, "2026-09-06T10:01:00+09:00"), "training-2")).state;
    const cancelled = receive(state, material("training", (xml) => cancellation(xml, "2026-09-06T10:02:00+09:00"), "training-cancel"));
    expect(cancelled.state.national.normal).toBe(normal);
  });

  it("P2-A5-T08 contractBoundary / AC04,10: operation map roundtrips and rejects ambiguous old shapes", () => {
    let state = emptyState();
    for (const operation of ["normal", "training", "test"] as const) {
      const item = snapshot(operation, "VPWS50", "気象庁", `2026-09-06T10:0${state.persistence.currentGeneration}:00+09:00`, operation);
      state = { ...state, national: { ...state.national, [operation]: item } };
    }
    const value = weatherCurrentUnitCodec.encode(state);
    expect(weatherCurrentUnitCodec.decode(value)).toMatchObject({ kind: "restored", state: { national: value.national } });
    const { normal, training } = value.national;
    if (normal == null || training == null) throw new Error("fixture must populate every operation");
    expect(weatherCurrentUnitCodec.decode({ ...value, national: { normal: training } }).kind).toBe("invalid");
    expect(weatherCurrentUnitCodec.decode({ ...value, national: { exercise: training } }).kind).toBe("invalid");
    expect(weatherCurrentUnitCodec.decode({ ...value, national: normal }).kind).toBe("invalid");
    expect(weatherCurrentUnitCodec.decode({ ...value, national: null }).kind).toBe("invalid");
  });

  it("P2-A5-T09 contractBoundary / AC11: normal evicts oldest non-normal count entries atomically", () => {
    const current = snapshot("normal", "VPWS50", "気象庁", "2026-09-06T10:00:00+09:00", "current");
    const oldTraining = snapshot("training", "VPWS50", "気象庁", "2026-09-05T10:00:00+09:00", "old-training");
    const oldTest = snapshot("test", "VPWS50", "気象庁", "2026-09-05T11:00:00+09:00", "old-test");
    const state: WeatherCurrentUnitState = { ...emptyState(), national: { normal: current }, histories: [
      { subject: oldTraining.subject, operation: "training", reports: [oldTraining] },
      { subject: oldTest.subject, operation: "test", reports: [oldTest] },
    ] };
    const candidate = decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after", "VPWS50",
      (xml) => bodyWarning(xml), "normal-new");
    const accepted = receive(state, candidate);
    expect(accepted.decisions[0].decision).toBe("changed");
    expect(accepted.state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId))
      .toEqual(["old-test", "current"]);
    expect(accepted.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(accepted.state.unavailable).toEqual([]);

    const normalOnly = { ...state, histories: [0, 1].map((index) => {
      const item = snapshot("normal", "VPWS50", "気象庁", `2026-09-05T1${index}:00:00+09:00`, `normal-h${index}`);
      return { subject: item.subject, operation: item.operation, reports: [item] };
    }) };
    const refused = receive(normalOnly, candidate);
    expect(refused.state.unavailable[0]?.reason).toBe("capacityExceeded");
    expect(refused.diagnostics).toEqual([]);

    const partialMaterial = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    const fullPartials = Array.from({ length: 128 }, (_, index) => snapshot(index === 0 ? "training" : "normal",
      "VPWW55", `office-${index}`, `2020-06-21T${String(index % 24).padStart(2, "0")}:00:00+09:00`, `partial-${index}`));
    const partialAdmission = receive({ ...emptyState(), partials: fullPartials }, partialMaterial);
    expect(partialAdmission.state.partials).toHaveLength(128);
    expect(partialAdmission.state.partials.some((item) => item.source.inputId === "partial-0")).toBe(false);
    expect(partialAdmission.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    const protectedPartials = fullPartials.map((item) => ({ ...item, operation: "normal" as const,
      subject: item.subject.replace(/^training\//, "normal/"), source: { ...item.source, operation: "normal" as const,
        subject: item.source.subject.replace(/^training\//, "normal/") } }));
    expect(receive({ ...emptyState(), partials: protectedPartials }, partialMaterial).state.unavailable[0]?.reason)
      .toBe("capacityExceeded");

    const partialCurrent = snapshot("normal", "VPWW57", "京都地方気象台", "2020-06-22T22:59:00+09:00", "partial-current");
    const partialReports = Array.from({ length: 8 }, (_, index) => snapshot(index % 2 ? "test" : "training",
      "VPWW57", "京都地方気象台", `2020-06-22T22:${String(40 + index).padStart(2, "0")}:00+09:00`, `partial-history-${index}`));
    const partialHistoryState: WeatherCurrentUnitState = { ...emptyState(), partials: [partialCurrent], histories:
      (["training", "test"] as const).map((operation) => ({ subject: `${operation}/VPWW57/京都地方気象台`, operation,
        reports: partialReports.filter((item) => item.operation === operation) })) };
    const partialHistoryAdmission = receive(partialHistoryState, partialMaterial);
    expect(partialHistoryAdmission.state.histories.flatMap((item) => item.reports)).toHaveLength(8);
    expect(partialHistoryAdmission.state.histories.flatMap((item) => item.reports)
      .some((item) => item.source.inputId === "partial-history-0")).toBe(false);
    expect(partialHistoryAdmission.state.unavailable).toEqual([]);

    const trainingBase = { ...snapshot("training", "VPWS50", "気象庁",
      "2018-01-01T00:00:00+09:00", "byte-training"), phenomena: { padding: "x".repeat(16_700_000) } };
    const byteState: WeatherCurrentUnitState = { ...emptyState(), national: { training: trainingBase } };
    expect(() => weatherCurrentUnitCodec.encode(byteState)).not.toThrow();
    const largest = decodeFixture("15_18_01_250630_VPWS50", "VPWS50");
    const byteAdmission = receive(byteState, largest);
    expect(byteAdmission.state.national.normal?.source.inputId).toBe(largest.inputId);
    expect(byteAdmission.state.national.training).toBeUndefined();
    expect(byteAdmission.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });

    // R5 diagnostic state: non-adoption must never evict business state to store monitoring.
    const normal = snapshot("normal", "VPWS50", "気象庁", "2030-01-01T00:00:00+09:00", "newer-base");
    const near = { ...emptyState(), national: { normal, training: { ...trainingBase, phenomena: { padding: "" } } } };
    const envelopeSize = (value: WeatherCurrentUnitState) => serializedEnvelope({
      schemaVersion: value.schemaVersion, unit: "U-W", generation: value.persistence.currentGeneration,
      capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64),
    }).byteLength;
    const padding = 16 * 1024 * 1024 - envelopeSize(near) - 100;
    const nearLimit = { ...near, national: { ...near.national,
      training: { ...near.national.training, phenomena: { padding: "x".repeat(padding) } } } };
    expect(envelopeSize(nearLimit)).toBe(16 * 1024 * 1024 - 100);
    for (const material of [candidate, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after",
      "VPWS50", (xml) => replaceBodyStatus(atTime(bodyWarning(xml), "2031-01-01T00:00:00+09:00"), "未知"), "near-invalid")]) {
      const refusedMonitor = receive(nearLimit, material);
      expect(refusedMonitor.decisions[0].decision).not.toBe("changed");
      expect(refusedMonitor.state).toBe(nearLimit);
      expect(refusedMonitor.diagnostics.some((item) => item.reason === "weatherCurrentCapacityEvicted")).toBe(false);
      expect(() => weatherCurrentUnitCodec.encode(refusedMonitor.state)).not.toThrow();
    }

    const fullNormalHistory = { subject: current.subject, operation: current.operation,
      reports: [snapshot("normal", "VPWS50", "気象庁", "2026-09-05T10:00:00+09:00", "history-1"),
        snapshot("normal", "VPWS50", "気象庁", "2026-09-05T11:00:00+09:00", "history-2")] };
    // Third review R1: a count-refused input cannot evict a training base for byte space.
    const refusedBase: WeatherCurrentUnitState = { ...emptyState(), national: {
      normal: current, training: { ...trainingBase, phenomena: { padding: "" } },
    }, histories: [fullNormalHistory] };
    const refusedFull = { ...refusedBase, national: { ...refusedBase.national,
      training: { ...trainingBase, phenomena: { padding: "x".repeat(16 * 1024 * 1024 - envelopeSize(refusedBase) - 100) } } } };
    const refusedStep = receive(refusedFull, candidate);
    expect(refusedStep.state).toBe(refusedFull);
    expect(refusedStep.decisions).toEqual([{ subject: current.subject, operation: "normal",
      decision: "capacityExceeded" }]);
    expect(refusedStep.diagnostics).toEqual([{ level: "WARN", component: "weather-current",
      reason: "checkpointEncodeFailed", unit: "U-W", inputId: "normal-new" }]);
    expect(() => weatherCurrentUnitCodec.encode(refusedStep.state)).not.toThrow();
    expect(refusedFull.national.training).toBeDefined();
    expect(envelopeSize(refusedFull)).toBe(16 * 1024 * 1024 - 100);

    // Third review R2: an unsavable lastKnown is dropped so the unavailable record still persists.
    const normalBase: WeatherCurrentUnitState = { ...emptyState(),
      national: { normal: { ...current, phenomena: { padding: "" } } }, histories: [fullNormalHistory] };
    const normalFull = { ...normalBase, national: { normal: { ...current,
      phenomena: { padding: "x".repeat(16 * 1024 * 1024 - envelopeSize(normalBase) - 100) } } } };
    expect(() => weatherCurrentUnitCodec.encode(normalFull)).not.toThrow();
    const droppedStep = receive(normalFull, candidate);
    expect(droppedStep.state.unavailable).toEqual([expect.objectContaining({
      reason: "capacityExceeded", lastKnown: null })]);
    expect(() => weatherCurrentUnitCodec.encode(droppedStep.state)).not.toThrow();
    expect(envelopeSize(droppedStep.state)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(envelopeSize(normalFull)).toBe(16 * 1024 * 1024 - 100);

    // Final scoped regression: equal restored subjects remain isolated by operation.
    const sharedNormal = { ...current, subject: "s", source: { ...current.source, subject: "s" } };
    const sharedTraining = { ...trainingBase, subject: "s", source: { ...trainingBase.source, subject: "s" },
      phenomena: { padding: "" } };
    const shared = reduceWeatherCurrentUnit(emptyState(), { kind: "restore", clock: clock(),
      persisted: weatherCurrentUnitCodec.encode({ ...emptyState(),
        national: { normal: sharedNormal, training: sharedTraining } }) }).state;
    expect(shared.national).toEqual({ normal: sharedNormal, training: sharedTraining });
    const cancelledShared = receive(shared, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after",
      "VPWS50", (xml) => cancellation(withOperation(bodyWarning(xml), "training"), "2026-09-06T10:02:00+09:00"),
      "shared-training-cancel"));
    expect(cancelledShared.state.national).toEqual({ normal: shared.national.normal });
    expect(cancelledShared.state.national.normal).toBe(shared.national.normal);
    expect(cancelledShared.state.unavailable).toMatchObject([{ subject: "s", operation: "training",
      reason: "historyUnavailable", lastKnown: shared.national.training }]);
    expect(() => weatherCurrentUnitCodec.encode(cancelledShared.state)).not.toThrow();

    const sharedFull = { ...shared, national: { ...shared.national, training: { ...sharedTraining,
      phenomena: { padding: "x".repeat(16 * 1024 * 1024 - envelopeSize(shared) - 100) } } } };
    expect(envelopeSize(sharedFull)).toBe(16_777_116);
    const admittedShared = receive(sharedFull, candidate);
    expect(admittedShared.decisions[0]).toMatchObject({ decision: "changed", operation: "normal", subject: "s" });
    expect(Object.keys(admittedShared.state.national)).toEqual(["normal"]);
    expect(admittedShared.state.national.normal?.source.inputId).toBe(candidate.inputId);
    expect(admittedShared.state.histories).toMatchObject([{ subject: "s", operation: "normal", reports: [sharedNormal] }]);
    expect(admittedShared.state.unavailable).toEqual([]);
    expect(admittedShared.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(envelopeSize(admittedShared.state)).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("P2-A5-T10 contractBoundary / AC12: canonical unavailable scope roundtrips and office containment is exact", () => {
    const token = JSON.stringify(["VPWW55", "partial", "福井地方気象台", "all", ""]);
    const record = { subject: "s", operation: "normal" as const,
      reason: "coverageIncomplete" as const, source: null, lastKnown: null, affectedScope: [token] };
    const state: WeatherCurrentUnitState = { ...emptyState(), unavailable: [record] };
    const decoded = weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(state));
    expect(decoded).toMatchObject({ kind: "restored", state: { unavailable: [record] } });
    const other = JSON.stringify(["VPWW55", "partial", "松江地方気象台", "all", ""]);
    expect(reduceWeatherCurrentUnit(state, { kind: "coverageConfirmed", operation: "normal", family: "VPWW55",
      subject: record.subject, affectedScope: [other], clock: clock() }).state).toBe(state);
    expect(reduceWeatherCurrentUnit(state, { kind: "coverageConfirmed", operation: "normal", family: "VPWW55",
      subject: record.subject, affectedScope: [token], clock: clock() }).state.unavailable).toEqual([]);
    expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(state), unavailable: [
      { ...record, affectedScope: ['["VPWW55", "partial", "福井地方気象台", "all", ""]'] },
    ] }).kind).toBe("invalid");
    // R4: reason-specific source requirements do not infer subject from tuple text.
    for (const reason of ["capacityExceeded", "historyUnavailable"] as const) {
      expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(state),
        unavailable: [{ ...record, reason }] }).kind).toBe("invalid");
      const bound = { ...record, reason, source: source("normal", "VPWW55", "s", "2026-09-06T10:00:00+09:00", reason),
        lastKnown: { ...snapshot("normal", "VPWW55", "福井地方気象台", "2026-09-06T09:00:00+09:00", "previous"),
          subject: "s", source: source("normal", "VPWW55", "s", "2026-09-06T09:00:00+09:00", "previous") } };
      expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode({ ...state, unavailable: [bound] })))
        .toMatchObject({ kind: "restored", state: { unavailable: [bound] } });
    }
    const part = JSON.stringify(["VPWW55", "partial", "福井地方気象台", "気象警報・注意報（府県予報区等）", "180000"]);
    expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(state),
      unavailable: [{ ...record, affectedScope: [token, part].sort() }] }))
      .toMatchObject({ kind: "restored", state: { unavailable: [{ affectedScope: [token] }] } });
  });

});
