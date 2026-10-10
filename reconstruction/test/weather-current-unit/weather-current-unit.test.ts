import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { NotificationIntent } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { WeatherCurrentSnapshot, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import manifest from "../../tools/corpus/manifest.json";
import corpus from "../../tools/corpus/sequences.json";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { reduceWeatherCurrentMeaning } from "../../src/domains/weather-current/weather-current";
import { ingestXmlData } from "../../src/ingress/ingress";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { fixtureDriver, fixtureState, stringCodec , testNotificationChannels, recordingNotificationAdapter} from "../checkpoint-shutdown/runtime-fixture";
import { callsWith } from "../unit-table/linked-calls";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

const NOW = 1_800_000_000_000;

function emptyState(): WeatherCurrentUnitState {
  return { schemaVersion: "p2-weather-current-unit-v1", contentRevision: 0, national: {}, partials: [], histories: [],
    ownership: {}, tombstones: [], freshness: [], unavailable: [], intents: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}

function clock(wallTimeMs = NOW, monotonicMs = 0) { return { wallTimeMs, monotonicMs }; }

function fixtureBody(file: string, transform: (xml: string) => string = (xml) => xml): Buffer {
  return Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8")));
}

function decodeFixture(file: string, headType: string, transform: (xml: string) => string = (xml) => xml,
  inputId = file): DecodedMaterial {
  const body = fixtureBody(file, transform);
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

// Body の中だけを書き換える（Head にも Name・Code・Status がある）。
function inBody(change: (body: string) => string): (xml: string) => string {
  return (xml) => { const at = xml.indexOf("<Body"); return xml.slice(0, at) + change(xml.slice(at)); };
}

// 全国の VPWS50 の続報（P2-A5-AC09 の回帰試験と同じ書き換えで、時刻だけ新しくする）。
function nationalSequel(index: number, prefix: string): DecodedMaterial {
  return decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after", "VPWS50",
    (xml) => atTime(bodyWarning(xml), `2026-09-06T11:${String(index).padStart(2, "0")}:00+09:00`), `${prefix}-${index}`);
}

// JSON.stringify の引数が、targets のどれかを参照で含むか。
function holdsAny(value: unknown, targets: ReadonlySet<unknown>, seen = new Set<unknown>()): boolean {
  if (value == null || typeof value !== "object" || seen.has(value)) return false;
  if (targets.has(value)) return true;
  seen.add(value);
  return Object.values(value).some((item) => holdsAny(item, targets, seen));
}

function stringified(run: () => void): unknown[] {
  const stringify = vi.spyOn(JSON, "stringify");
  try { run(); return stringify.mock.calls.map(([value]) => value); } finally { stringify.mockRestore(); }
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
  seed(state: WeatherCurrentUnitState, generation: number, capturedAt: number) {
    this.files.set(resolve(config().stateDirectory, "U-W-A.json"), serializedEnvelope(hashEnvelope({
      schemaVersion: state.schemaVersion, unit: "U-W", generation, capturedAt,
      payload: weatherCurrentUnitCodec.encode(state),
    })));
  }
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
      expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(step.state)).kind).toBe("restored");
    }
  });

  it("A8-COST regression: unchanged receives add no current lookups beyond the domain reducer", () => {
    const material = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    const adopted = receive(emptyState(), material).state;
    let reads = 0;
    // 127 others + the adopted subject at the end fills the 128-partial capacity.
    const partials = new Proxy([...Array.from({ length: 127 }, (_, index) => snapshot("training", "VPWW55", `office-${index}`,
      "2026-09-06T10:00:00+09:00", `p${index}`)), ...adopted.partials], {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); },
    });
    const state = { ...adopted, partials };
    const request = { kind: "receive", material, clock: clock() } as const;
    reads = 0;
    reduceWeatherCurrentMeaning(state, request);
    const domainReads = reads;
    reads = 0;
    const step = reduceWeatherCurrentUnit(state, request);
    expect(step.decisions[0]).toMatchObject({ reason: "duplicate" });
    expect(step.state).toBe(state);
    expect(reads).toBe(domainReads);
  });

  it("P2-A5-T13 contractBoundary / AC01: danger warning downgrades keep the current Kind level", () => {
    for (const [status, name, code] of [
      ["危険警報から注意報", "レベル２大雨注意報", "10"],
      ["危険警報から警報", "レベル３大雨警報", "03"],
    ] as const) {
      const material = decodeFixture("18_00_01_260830_VPWW55_fukui_downgrade", "VPWW55", (xml) =>
        xml.replace(
          "<Name>レベル４大雨危険警報</Name>\n<Code>43</Code>\n<Status>特別警報から危険警報</Status>\n<LastKind>\n<Name>レベル５大雨特別警報</Name>\n<Code>33</Code>",
          `<Name>${name}</Name>\n<Code>${code}</Code>\n<Status>${status}</Status>\n<LastKind>\n<Name>レベル４大雨危険警報</Name>\n<Code>43</Code>`,
        ), status);
      const step = receive(emptyState(), material);
      const token = JSON.stringify(["VPWW55", "partial", "福井地方気象台", "気象警報・注意報（府県予報区等）", "180000"]);
      expect(step.decisions[0]).toMatchObject({ decision: "changed", reason: null });
      expect(step.state.partials[0].phenomena).toMatchObject({ [token]: [{ status, code, name }] });
      expect(step.state.ownership[`normal\u0000${token}\u0000${code}`]).toBe("normal/VPWW55/福井地方気象台");
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

  it("P2-A5-T03 contractBoundary / AC04: codec enforces combined retention counts", async () => {
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
      decisions: [], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [],
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
    const notificationFiles = new MemoryCheckpointFileSystem();
    notificationFiles.seed(intentState, 1, NOW);
    // TEST-PATH (2): the owner restores the intent; the publisher selects it, the owner adopts the reservation and the
    // recording adapter's delivered result comes back as the owner's intent update.
    let now = clock();
    const notifying = harnessedRoot(config(), { "U-W": weatherCurrentUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: notificationFiles, diagnosticFileSystem: new MemoryDiagnosticFileSystem(), clock: () => now,
      runtimeCalls: callsWith({ ...fixtureDriver().stubs, reduceWeatherCurrentUnit,
        selectNotificationAttempt: (delivery) => delivery.channels.desktop.kind !== "idle"
          || !delivery.intents.some((item) => item.disposition === "pending")
          ? { state: delivery, attempts: [], abortRequests: [], diagnostics: [] } : ({
          state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt } },
            intents: delivery.intents.map((item) => ({ ...item, attempts: 1, nextAttemptAt: NOW + 500 })) },
          attempts: [attempt], abortRequests: [], diagnostics: [],
        }),
        applyNotificationResult: (delivery) => ({
          state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "idle" } },
            intents: delivery.intents.map((item) => ({ ...item, disposition: "delivered" })) },
          diagnostics: [],
        }),
      }),
    });
    await startHarness(notifying, "weather-test", now);
    now = clock(NOW + 1, 1);
    notifying.root.tick(now);
    await notifying.settle();
    const completed = notifying.unit("U-W");
    expect(completed.intents[0]).toMatchObject({ disposition: "delivered", attempts: 1, expiresAt: intent.expiresAt });
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(completed)))
      .toMatchObject({ kind: "restored", state: { intents: completed.intents } });
    now = clock(intent.expiresAt, 3);
    notifying.root.tick(now);
    await notifying.settle();
    expect(notifying.unit("U-W").intents).toEqual([]);
  });

  it("P2-A1-DISPLAY-CHANGES.revision: an older stale report records a non-suspect monitor without advancing the content revision", () => {
    const state = receive(emptyState(), decodeFixture("15_16_02_251222_VPWW57", "VPWW57")).state;
    const older = receive(state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T22:59:00+09:00"), "older"));
    expect(older.state.freshness).toMatchObject([{ revisionOrder: "older", freshnessSuspect: false }]);
    expect(older.state.partials).toBe(state.partials);
    expect([older.displayChanges, older.state.contentRevision]).toEqual([[], state.contentRevision]);
  });

  it("P2-A1-DISPLAY-CHANGES.revision: a monitor-only subject with a non-suspect record adds no display change", () => {
    const monitored = receive(emptyState(), { ...decodeFixture("15_16_02_251222_VPWW57", "VPWW57"), reportDateTimeRaw: "" });
    expect(monitored.state.freshness).toMatchObject([{ revisionOrder: "unknown", freshnessSuspect: false }]);
    expect([monitored.displayChanges, monitored.state.contentRevision]).toEqual([[], 0]);
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
    expect(monitored.displayChanges).toMatchObject([{ unit: "U-W", before: { freshness: [] },
      after: { freshness: [{ freshnessSuspect: true }] } }]);
    expect(monitored.confirmationEvidence).toEqual([]);
    expect(monitored.state.contentRevision).toBe(state.contentRevision + 1);
    // R3: invalid dates still identify a target, but never manufacture newer.
    const invalidTime = decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2030-02-30T23:01:00+09:00"), "invalid-time");
    const unknown = receive(monitored.state, invalidTime);
    expect(unknown.state.freshness[0]).toMatchObject({ revisionOrder: "unknown", freshnessSuspect: true,
      candidateSource: { inputId: "invalid-time" }, suspectedSource: { inputId: "newer-invalid" } });
    expect(receive(state, invalidTime).state.freshness[0]).toMatchObject({ revisionOrder: "unknown", freshnessSuspect: false });
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(unknown.state)).kind).toBe("restored");
    const noHistory = receive(unknown.state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => cancellation(xml, "2020-06-22T23:03:00+09:00"), "no-history"));
    expect(noHistory.state.unavailable[0].reason).toBe("historyUnavailable");
    // The unavailable replacement bypasses `touched`; its display change must still be emitted.
    expect(noHistory.displayChanges).toMatchObject([{ unit: "U-W", after: { current: null,
      unavailable: [{ reason: "historyUnavailable" }] } }]);
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

  // regression（監査 F09、P3-AUTH-AC05）: 修正前は T1 の不正報で疑義の上限が T1 へ後退し、正常な T1 の採用で T2 の疑義が消えた。
  it("P3-AUTH-T04 regression / AC05: the suspect bound stays at T2 through an invalid or valid T1 and a restore", () => {
    const report = (time: string, valid: boolean) => decodeFixture("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => valid ? atTime(xml, time) : replaceBodyStatus(atTime(xml, time), "未知"), `${time}-${valid}`);
    const [t0, t1, t2] = ["2026-01-01T10:00:00+09:00", "2026-01-01T10:01:00+09:00", "2026-01-01T10:02:00+09:00"];
    const suspected = receive(receive(receive(emptyState(), report(t0, true)).state, report(t2, false), 1).state, report(t1, false), 2).state;
    expect(suspected.freshness.map((item) => item.suspectedSource?.reportDateTimeRaw)).toEqual([t2]);
    const decoded = weatherCurrentUnitCodec.decode(JSON.parse(JSON.stringify(weatherCurrentUnitCodec.encode(suspected))));
    if (decoded.kind !== "restored") throw new Error("the suspected state does not decode");
    for (const [label, state] of [["direct", suspected], ["restored", decoded.state]] as const) {
      const older = receive(state, report(t1, true), 3);
      expect([older.decisions[0].decision, older.state.freshness.map((item) => item.suspectedSource?.reportDateTimeRaw)], label)
        .toEqual(["changed", [t2]]);
      expect(receive(older.state, report(t2, true), 4).state.freshness, label).toEqual([]);
    }
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
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(otherOffice.state)).kind).toBe("restored");

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
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(opaqueCancel.state)).kind).toBe("restored");

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

    const driver = fixtureDriver();
    const calls = callsWith({ ...driver.stubs, reduceWeatherCurrentUnit, toWeatherCurrentView });
    // TEST-PATH (2): each runtime is the publisher with its in-process owners on memory file systems.
    const wired = (files: MemoryCheckpointFileSystem, at: ReturnType<typeof clock>, codecs: Parameters<typeof harnessedRoot>[1]) =>
      harnessedRoot(config(), codecs, { notificationAdapter: recordingNotificationAdapter(), checkpointFileSystem: files,
        diagnosticFileSystem: new MemoryDiagnosticFileSystem(), runtimeCalls: calls, clock: () => at });
    let inputSequence = 0;
    const send = (h: Harness, file: string, transform: (xml: string) => string, inputId: string, at: ReturnType<typeof clock>) =>
      submit(h, envelope(h.root.state.runId, "VPWW57", inputId, fixtureBody(file, transform), at, ++inputSequence));
    const adapter = new MemoryCheckpointFileSystem();
    adapter.seed(state, state.persistence.currentGeneration, NOW);
    const running = wired(adapter, clock(NOW, NOW), { "U-W": weatherCurrentUnitCodec });
    await startHarness(running, "weather-test", clock(NOW, NOW));
    adapter.failWrite = true; // the input saves at once (P3-UWR-AC03; AC10(7))
    await send(running, "15_16_02_251222_VPWW57", (xml) => cancellation(xml, "2020-06-22T23:02:00+09:00"), "cancel", clock(NOW, NOW));
    await running.root.driveCheckpoint();
    await running.settle();
    expect(running.root.state.mirror["U-W"].persistence.kind).toBe("failed");

    const shutdownFiles = new MemoryCheckpointFileSystem();
    shutdownFiles.seed(restored.state, restored.state.persistence.currentGeneration, NOW);
    const stopping = wired(shutdownFiles, clock(NOW + 2, NOW + 2), { "U-W": weatherCurrentUnitCodec });
    await startHarness(stopping, "weather-test", clock(NOW + 2, NOW + 2));
    const before = stopping.unit("U-W");
    await send(stopping, "15_16_02_251222_VPWW57", (xml) => xml, first.inputId, clock(NOW + 2, NOW + 2));
    // Wired route: the older redelivery reaches U-W as stale and records freshness only (AC06).
    const routedUnit = stopping.unit("U-W");
    for (const field of ["national", "partials", "histories", "tombstones", "intents"] as const)
      expect(routedUnit[field]).toBe(before[field]);
    expect(routedUnit.freshness.slice(restored.state.freshness.length)).toMatchObject([
      { candidateSource: { inputId: first.inputId }, decision: "unchanged", reason: "stale", revisionOrder: "older" }]);
    const nextGeneration = restored.state.persistence.currentGeneration + 1;
    expect(routedUnit.persistence.currentGeneration).toBe(nextGeneration);
    expect(stopping.root.state.mirror["U-W"].persistence.currentGeneration).toBe(nextGeneration);
    const summary = await stopping.root.shutdownRuntime(1, clock(NOW + 2, NOW + 2));
    expect(summary.code, JSON.stringify(summary)).toBe(0);
    expect(summary.persistence["U-W"]).toMatchObject({ kind: "saved",
      currentGeneration: nextGeneration, savedGeneration: nextGeneration });

    let weatherEncodes = 0;
    const counted = { ...weatherCurrentUnitCodec, encode: (value: WeatherCurrentUnitState) => {
      weatherEncodes++; return weatherCurrentUnitCodec.encode(value);
    } };
    const e10 = wired(new MemoryCheckpointFileSystem(), clock(NOW + 3, NOW + 3), { "U-E": stringCodec("U-E"), "U-W": counted });
    const otherDirty = fixtureState({ "U-E": "e10" }, { "U-E": { kind: "pending", currentGeneration: 2, savedGeneration: 1,
      savedCapturedAt: 0, savedAckAt: 0, dirtySince: 1 } }, "e10");
    await driver.update(e10, otherDirty, clock(NOW + 3, NOW + 3), { "U-E": ["e10"] });
    await e10.root.driveCheckpoint();
    await e10.settle();
    expect(e10.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request.unit] : [])).toEqual(["U-E"]);
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
    expect(accepted.displayChanges).toHaveLength(1);
    expect(accepted.displayChanges[0].before?.unit === "U-W" && accepted.displayChanges[0].before.current).toBe(current);
    expect(accepted.displayChanges[0].after?.unit === "U-W" && accepted.displayChanges[0].after.current)
      .toBe(accepted.state.national.normal);
    expect(accepted.state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId))
      .toEqual(["old-test", "current"]);
    expect(accepted.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(accepted.state.unavailable).toEqual([]);

    // National normal depth rotation is covered by the AC09 regression below.
    const normalOnly = { ...state, histories: [{ subject: current.subject, operation: "normal" as const,
      reports: [0, 1].map((index) => snapshot("normal", "VPWS50", "気象庁", `2026-09-05T1${index}:00:00+09:00`, `normal-h${index}`)) }] };
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(normalOnly)).kind).not.toBe("invalid");
    // Normal protection: training over a normal-only history is adopted without keeping its previous version.
    const trainingCurrent = snapshot("training", "VPWS50", "気象庁", "2026-09-06T10:00:00+09:00", "training-current");
    const trainingOverNormal = receive({ ...normalOnly, national: { ...normalOnly.national, training: trainingCurrent } },
      decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after", "VPWS50",
        (xml) => withOperation(bodyWarning(xml), "training"), "training-new"));
    expect(trainingOverNormal.decisions[0]).toMatchObject({ decision: "changed", operation: "training" });
    expect(trainingOverNormal.state.national.training?.source.inputId).toBe("training-new");
    expect(trainingOverNormal.state.histories).toEqual(normalOnly.histories);
    expect(trainingOverNormal.diagnostics).toEqual([]);
    expect(receive(trainingOverNormal.state, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after",
      "VPWS50", (xml) => cancellation(withOperation(bodyWarning(xml), "training"), "2026-09-06T10:05:00+09:00"),
      "training-cancel")).state.unavailable).toMatchObject([{ operation: "training", reason: "historyUnavailable" }]);

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
    // Partial history depth 8 all normal: the oldest normal report rotates out silently.
    const normalPartialReports = partialReports.map((item) => ({ ...item, operation: "normal" as const,
      subject: partialCurrent.subject, source: { ...item.source, operation: "normal" as const, subject: partialCurrent.subject } }));
    const normalPartialRotation = receive({ ...emptyState(), partials: [partialCurrent],
      histories: [{ subject: partialCurrent.subject, operation: "normal", reports: normalPartialReports }] }, partialMaterial);
    expect(normalPartialRotation.decisions[0].decision).toBe("changed");
    expect(normalPartialRotation.state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId))
      .toEqual([...normalPartialReports.slice(1).map((item) => item.source.inputId), "partial-current"]);
    expect(normalPartialRotation.diagnostics).toEqual([]);
    expect(normalPartialRotation.state.unavailable).toEqual([]);

    const trainingBase = { ...snapshot("training", "VPWS50", "気象庁",
      "2018-01-01T00:00:00+09:00", "byte-training"), phenomena: { padding: "x".repeat(16_700_000) } };
    const byteState: WeatherCurrentUnitState = { ...emptyState(), national: { training: trainingBase } };
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(byteState)).kind).toBe("restored");
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
      expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(refusedMonitor.state)).kind).toBe("restored");
    }

    const fullNormalHistory = { subject: current.subject, operation: current.operation,
      reports: [snapshot("normal", "VPWS50", "気象庁", "2026-09-05T10:00:00+09:00", "history-1"),
        snapshot("normal", "VPWS50", "気象庁", "2026-09-05T11:00:00+09:00", "history-2")] };
    // Third review R1: a count-refused input cannot evict a training base for byte space.
    // History depth never refuses, so the count refusal left is the all-normal partial128 subject limit.
    const refusedBase: WeatherCurrentUnitState = { ...emptyState(), national: {
      training: { ...trainingBase, phenomena: { padding: "" } } }, partials: protectedPartials };
    const refusedFull = { ...refusedBase, national: {
      training: { ...trainingBase, phenomena: { padding: "x".repeat(16 * 1024 * 1024 - envelopeSize(refusedBase) - 100) } } } };
    const refusedStep = receive(refusedFull, partialMaterial);
    expect(refusedStep.state).toBe(refusedFull);
    const established = receive(emptyState(), partialMaterial).decisions[0];
    if (established.decision !== "changed" || established.currentEstablished == null) throw new Error("partial not established");
    expect(refusedStep.decisions).toEqual([{ subject: established.subject, operation: "normal",
      decision: "capacityExceeded", rejection: { family: "VPWW57", reportDateTimeMs: Date.parse(partialMaterial.reportDateTimeRaw),
        affectedScope: established.currentEstablished.affectedScope } }]);
    expect(refusedStep.diagnostics).toEqual([{ level: "WARN", component: "weather-current",
      reason: "checkpointEncodeFailed", unit: "U-W", inputId: partialMaterial.inputId }]);
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(refusedStep.state)).kind).toBe("restored");
    expect(refusedFull.national.training).toBeDefined();
    expect(envelopeSize(refusedFull)).toBe(16 * 1024 * 1024 - 100);

    // Third review R2: an unsavable lastKnown is dropped so the unavailable record still persists.
    const normalBase: WeatherCurrentUnitState = { ...emptyState(),
      national: { normal: { ...current, phenomena: { padding: "" } } }, histories: [fullNormalHistory] };
    const normalFull = { ...normalBase, national: { normal: { ...current,
      phenomena: { padding: "x".repeat(16 * 1024 * 1024 - envelopeSize(normalBase) - 100) } } } };
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(normalFull)).kind).toBe("restored");
    const droppedStep = receive(normalFull, candidate);
    expect(droppedStep.state.unavailable).toEqual([expect.objectContaining({
      reason: "capacityExceeded", lastKnown: null })]);
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(droppedStep.state)).kind).toBe("restored");
    expect(envelopeSize(droppedStep.state)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(envelopeSize(normalFull)).toBe(16 * 1024 * 1024 - 100);

    // Final scoped regression: equal restored subjects remain isolated by operation.
    const sharedNormal = { ...current, subject: "s", source: { ...current.source, subject: "s" } };
    const sharedTraining = { ...trainingBase, subject: "s", source: { ...trainingBase.source, subject: "s" },
      phenomena: { padding: "" } };
    const shared = reduceWeatherCurrentUnit(emptyState(), { kind: "restore", clock: clock(),
      persisted: weatherCurrentUnitCodec.encode({ ...emptyState(),
        national: { normal: sharedNormal, training: sharedTraining } }) }).state;
    expect(shared.national).toMatchObject({ normal: sharedNormal, training: sharedTraining });
    const cancelledShared = receive(shared, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after",
      "VPWS50", (xml) => cancellation(withOperation(bodyWarning(xml), "training"), "2026-09-06T10:02:00+09:00"),
      "shared-training-cancel"));
    expect(cancelledShared.state.national).toEqual({ normal: shared.national.normal });
    expect(cancelledShared.state.national.normal).toBe(shared.national.normal);
    expect(cancelledShared.state.unavailable).toMatchObject([{ subject: "s", operation: "training",
      reason: "historyUnavailable", lastKnown: shared.national.training }]);
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(cancelledShared.state)).kind).toBe("restored");

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

  it("P2-A5-AC09 regression / E13: consecutive VPWS50 normal reports never fall into capacityExceeded", () => {
    let state = emptyState();
    for (let index = 0; index < 10; index++) {
      const step = receive(state, decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-after", "VPWS50",
        (xml) => atTime(bodyWarning(xml), `2026-09-06T11:${String(index).padStart(2, "0")}:00+09:00`), `vpws50-${index}`));
      expect(step.decisions[0].decision).toBe("changed");
      expect(step.state.unavailable).toEqual([]);
      expect(step.diagnostics).toEqual([]);
      state = step.state;
    }
    expect(state.national.normal?.source.inputId).toBe("vpws50-9");
    expect(state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId)).toEqual(["vpws50-7", "vpws50-8"]);
  });

  // A10 Hertz P1-1: pushing out one office's oldest report rebuilt every history entry and re-serialized all offices.
  it("P2-A5-T11 regression / AC13: a full-depth push-out keeps other offices' history entries and their cached bytes", () => {
    const offices = ["京都地方気象台", "office-b", "office-c"];
    const state: WeatherCurrentUnitState = { ...emptyState(),
      partials: offices.map((office) => snapshot("normal", "VPWW57", office, "2020-06-22T22:59:00+09:00", `${office}-current`)),
      histories: offices.map((office) => ({ subject: `normal/VPWW57/${office}`, operation: "normal" as const,
        reports: Array.from({ length: 8 }, (_, index) => snapshot("normal", "VPWW57", office,
          `2020-06-22T22:${String(40 + index).padStart(2, "0")}:00+09:00`, `${office}-h${index}`)) })) };
    const others = state.histories.filter((item) => item.subject !== "normal/VPWW57/京都地方気象台");
    const next = receive(state, decodeFixture("15_16_02_251222_VPWW57", "VPWW57"));
    expect(next.decisions[0].decision).toBe("changed");
    // The byte cache is keyed by entry identity, so the same entry object is a cache hit.
    for (const entry of others) expect(next.state.histories).toContain(entry);
  });

  // A10 AC15: the domain rebuilds ownership on each receive; its bytes were re-serialized entry by entry.
  it("P2-A5-T11 regression / A10 AC15: a receive's stringify count does not grow with retained ownership", () => {
    const first = decodeFixture("15_16_02_251222_VPWW57", "VPWW57");
    const second = decodeFixture("15_18_01_250630_VPWS50", "VPWS50");
    const count = (entries: number) => {
      const state = { ...emptyState(), ownership: Object.fromEntries(Array.from({ length: entries }, (_, index) =>
        [`training\u0000token-${index}\u0000${index}`, "training/VPWW55/office"])) };
      const primed = receive(state, first).state;
      const stringify = vi.spyOn(JSON, "stringify");
      let next: ReturnType<typeof receive>, serialized: number;
      try { next = receive(primed, second); serialized = stringify.mock.calls.length; } finally { stringify.mockRestore(); }
      expect(next.decisions[0].decision).toBe("changed");
      expect(Object.keys(next.state.ownership).length).toBeGreaterThanOrEqual(entries);
      return serialized;
    };
    expect(count(4_000)).toBe(count(2_000));
  });

  it("P2-A5-T11 contractBoundary / AC13: reserved envelope bytes set the receive boundary", () => {
    const candidate = decodeFixture("15_18_01_250630_VPWS50", "VPWS50");
    const partial = snapshot("normal", "VPWW55", "福井地方気象台", "2026-09-06T09:00:00+09:00", "partial");
    const paddingKey = '区域"\\\n';
    const prefix = '日本語"\\\n';
    const base = { ...emptyState(), partials: [{ ...partial, phenomena: { [paddingKey]: prefix } }] };
    const accepted = receive(base, candidate);
    expect(accepted.decisions[0].decision).toBe("changed");
    const actualBytes = (value: WeatherCurrentUnitState) => serializedEnvelope({
      schemaVersion: value.schemaVersion, unit: "U-W", generation: value.persistence.currentGeneration,
      capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64),
    }).byteLength;
    const unused = 62 - (JSON.stringify(accepted.state.persistence.currentGeneration).length - 1)
      - (JSON.stringify(NOW).length - 1);
    const padding = 16 * 1024 * 1024 - actualBytes(accepted.state) - unused;
    const withPadding = (length: number) => ({ ...base,
      partials: [{ ...partial, phenomena: { [paddingKey]: prefix + "x".repeat(length) } }] });
    const exact = receive(withPadding(padding), candidate);
    expect(exact.decisions[0].decision).toBe("changed");
    expect(actualBytes(exact.state) + unused).toBe(16 * 1024 * 1024);
    const over = receive(withPadding(padding + 1), candidate);
    expect(over.state.national.normal).toBeUndefined();

    // The same exact boundary after evicting training history also exercises cached unchanged records.
    const retained = withPadding(padding - 1);
    const training = snapshot("training", "VPWS50", "気象庁", "2020-01-01T00:00:00+09:00", '訓練"\\');
    const occupied = { ...retained, histories: [{ subject: training.subject, operation: training.operation, reports: [training] }] };
    const stringify = vi.spyOn(JSON, "stringify");
    let evicted: ReturnType<typeof receive>;
    try {
      evicted = receive(occupied, candidate);
      expect(stringify.mock.calls.filter(([value]) => value === retained.partials[0])).toHaveLength(1);
      stringify.mockClear();
      receive(occupied, candidate);
      expect(stringify.mock.calls.filter(([value]) => value === retained.partials[0])).toHaveLength(0);
      expect(stringify.mock.calls.filter(([value]) => value != null && typeof value === "object"
        && ("national" in value || "payload" in value))).toHaveLength(0);
    } finally { stringify.mockRestore(); }
    expect(evicted.state.histories).toEqual([]);
    expect(evicted.diagnostics).toContainEqual({ level: "INFO", component: "weather-current",
      reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(actualBytes(evicted.state) + unused).toBe(16 * 1024 * 1024 - 1);
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

  it("P3-WL1-T03 contractBoundary / P3-WL1-AC03: Kind children keep missing, empty, nested and duplicate rulings and rows", () => {
    const file = "15_16_02_251222_VPWW57";
    const state = { ...receive(emptyState(), decodeFixture(file, "VPWW57")).state, intents: [pendingIntent()] };
    const firstKind = (change: (kind: string) => string) => inBody((body) => body.replace(/<Kind>[\s\S]*?<\/Kind>/, change));
    const rejected = [
      ["requiredStructureMissing", firstKind((kind) => kind.replace("<Status>発表</Status>", "<Status/>"))],
      ["requiredStructureMissing", firstKind((kind) => kind.replace("<Status>発表</Status>", ""))],
      ["requiredStructureInvalid", firstKind((kind) => kind.replace("<Status>発表</Status>", "<Status><x/></Status>"))],
      ["requiredStructureInvalid", firstKind((kind) => kind.replace("<Code>48</Code>", "<Code><x/></Code>"))],
      ["requiredStructureInvalid", firstKind((kind) => kind.replace("<Code>48</Code>", "<Code>48</Code><Code>48</Code>"))],
      ["requiredStructureInvalid", inBody((body) => body.replace("<Status>発表警報・注意報はなし</Status>",
        "<Code>00</Code><Status>発表警報・注意報はなし</Status>"))],
      ["requiredStructureMissing", firstKind((kind) => kind.replace("<Code>48</Code>", ""))],
    ] as const;
    for (const [index, [reason, transform]] of rejected.entries()) {
      const step = receive(state, decodeFixture(file, "VPWW57", transform, `t03-${index}`));
      expect(step.decisions[0], `${index}`).toMatchObject({ decision: "rejected", reason });
      for (const field of ["national", "partials", "histories", "intents", "tombstones"] as const)
        expect(step.state[field]).toBe(state[field]);
    }
    const token = JSON.stringify(["VPWW57", "partial", "京都地方気象台", "気象警報・注意報（府県予報区等）", "260000"]);
    const accepted = [
      [firstKind((kind) => kind.replace(/<Name>[^<]*<\/Name>/, "<Name>a</Name><Name>a</Name>")), { status: "発表", code: "48", name: null }],
      [firstKind((kind) => kind.replace(/<Name>[^<]*<\/Name>/, "<Name><x/></Name>")), { status: "発表", code: "48", name: null }],
      [firstKind((kind) => kind.replace("<Code>48</Code>", "<Code>03</Code>")), { status: "発表", code: "03", name: "レベル４高潮危険警報" }],
    ] as const;
    for (const [index, [transform, row]] of accepted.entries()) {
      const step = receive(emptyState(), decodeFixture(file, "VPWW57", transform, `t03-accepted-${index}`));
      expect(step.decisions[0].decision).toBe("changed");
      expect(step.state.partials[0].phenomena[token]).toEqual([row]);
    }
  });

  it("P3-WL1-T04 regression / P3-WL1-AC04: a receive does not re-stringify the previous history or its reports", () => {
    let state = emptyState();
    for (let index = 0; index < 3; index++) state = receive(state, nationalSequel(index, "t04")).state;
    const previous = new Set<unknown>(state.histories.flatMap((item) => item.reports));
    expect(previous.size).toBe(2);
    const material = nationalSequel(3, "t04");
    let step: ReturnType<typeof receive> | null = null;
    const calls = stringified(() => { step = receive(state, material); });
    expect(step!.decisions[0].decision).toBe("changed");
    // 外側の数え方 {...history, reports: []} は reports が空なので許す（AC04）。
    expect(calls.filter((value) => value != null && typeof value === "object" && "reports" in value
      && Array.isArray(value.reports) && value.reports.length > 0)).toHaveLength(0);
    expect(calls.filter((value) => holdsAny(value, previous))).toHaveLength(0);
  });

  it("P3-WL1-T05 contractBoundary / P3-WL1-AC04: the reserved receive boundary is exact with a history entry", () => {
    const largest = "15_18_01_250630_VPWS50";
    const first = receive(emptyState(), decodeFixture(largest, "VPWS50",
      (xml) => atTime(xml, "2019-01-01T00:00:00+09:00"), "t05-first")).state;
    const candidate = decodeFixture(largest, "VPWS50");
    const partial = snapshot("normal", "VPWW55", "福井地方気象台", "2026-09-06T09:00:00+09:00", "partial");
    const paddingKey = '区域"\\\n';
    const prefix = '日本語"\\\n';
    const withPadding = (length: number): WeatherCurrentUnitState => ({ ...first,
      partials: [{ ...partial, phenomena: { [paddingKey]: prefix + "x".repeat(length) } }] });
    const actualBytes = (value: WeatherCurrentUnitState) => serializedEnvelope({
      schemaVersion: value.schemaVersion, unit: "U-W", generation: value.persistence.currentGeneration,
      capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64),
    }).byteLength;
    const accepted = receive(withPadding(0), candidate);
    expect(accepted.state.histories.flatMap((item) => item.reports)).toHaveLength(1);
    const unused = 62 - (JSON.stringify(accepted.state.persistence.currentGeneration).length - 1)
      - (JSON.stringify(NOW).length - 1);
    const padding = 16 * 1024 * 1024 - actualBytes(accepted.state) - unused;
    const exact = receive(withPadding(padding), candidate);
    expect(exact.state.national.normal?.source.inputId).toBe(candidate.inputId);
    expect(actualBytes(exact.state) + unused).toBe(16 * 1024 * 1024);
    const over = receive(withPadding(padding + 1), candidate);
    expect(over.state.national.normal?.source.inputId).not.toBe(candidate.inputId);
  });

  it("P3-WL1-T06 contractBoundary / P3-WL1-AC05: encode keeps the 16MiB payload and pending count and byte guards", () => {
    const message = "U-W checkpoint exceeds or violates its persisted boundary";
    const partial = snapshot("normal", "VPWW55", "福井地方気象台", "2026-09-06T09:00:00+09:00", "partial");
    const padded = (length: number): WeatherCurrentUnitState => ({ ...emptyState(),
      partials: [{ ...partial, phenomena: { '区域"\\\n': '日本語"\\\n' + "x".repeat(length) } }] });
    const payloadBytes = (value: WeatherCurrentUnitState) => Buffer.byteLength(JSON.stringify(weatherCurrentUnitCodec.encode(value)));
    const length = 16 * 1024 * 1024 - payloadBytes(padded(0));
    expect(payloadBytes(padded(length))).toBe(16 * 1024 * 1024);
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(padded(length))).kind).toBe("restored");
    expect(() => weatherCurrentUnitCodec.encode(padded(length + 1))).toThrow(message);

    const intents = (count: number, pad = "") => Array.from({ length: count }, (_, index) =>
      ({ ...pendingIntent(), id: `intent-${index}`, payload: { pad } }));
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode({ ...emptyState(), intents: intents(128) })).kind)
      .toBe("restored");
    expect(() => weatherCurrentUnitCodec.encode({ ...emptyState(), intents: intents(129) })).toThrow(message);
    // 境界は実 byte＋配送の更新の予約＝131,072（P3-IUR-AC05）。
    const pad = 131_072 - Buffer.byteLength(JSON.stringify(intents(1))) - deliveryGrowth(intents(1)[0]);
    expect(Buffer.byteLength(JSON.stringify(intents(1, "x".repeat(pad)))) + deliveryGrowth(intents(1)[0])).toBe(131_072);
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode({ ...emptyState(), intents: intents(1, "x".repeat(pad)) })).kind)
      .toBe("restored");
    expect(() => weatherCurrentUnitCodec.encode({ ...emptyState(), intents: intents(1, "x".repeat(pad + 1)) })).toThrow(message);

    // 実 byte は上限ちょうどで、予約を足すと超える pending と世代は、decode が受けず encode が拒否する（P3-IUR-AC01・AC02）。
    const realLimit = intents(1, "x".repeat(pad + deliveryGrowth(pendingIntent())));
    expect(Buffer.byteLength(JSON.stringify(realLimit))).toBe(131_072);
    expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(emptyState()), intents: realLimit }).kind).toBe("invalid");
    expect(() => weatherCurrentUnitCodec.encode({ ...emptyState(), intents: realLimit })).toThrow(message);
    // 非文字列の disposition・transition は String() で列挙値に化けて pending の計量から外れるので、型ごと拒否する（P3-IUR-AC06）。
    for (const patch of [{ disposition: ["pending"] }, { transition: ["activated"] }])
      expect(weatherCurrentUnitCodec.decode({ ...weatherCurrentUnitCodec.encode(emptyState()), intents: [{ ...pendingIntent(), ...patch }] }).kind,
        JSON.stringify(patch)).toBe("invalid");
    const withIntent = (extra: number) => ({ ...padded(extra), intents: intents(1) });
    const wire = (extra: number) => ({ ...weatherCurrentUnitCodec.encode(padded(extra)), intents: intents(1) });
    const wireLength = 16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(wire(0)));
    expect(Buffer.byteLength(JSON.stringify(wire(wireLength)))).toBe(16 * 1024 * 1024);
    expect(weatherCurrentUnitCodec.decode(wire(wireLength)).kind).toBe("invalid");
    expect(() => weatherCurrentUnitCodec.encode(withIntent(wireLength))).toThrow(message);
    const inside = wireLength - deliveryGrowth(pendingIntent());
    expect(weatherCurrentUnitCodec.decode(wire(inside)).kind).toBe("restored");
    expect(() => weatherCurrentUnitCodec.encode(withIntent(inside))).not.toThrow();
  });

  // 実不具合の再発防止（台帳 73）: 合成の保存物の pending が予約込みの上限でも、配送の更新の後の encode が拒否しない。
  it("P3-IUR-T05 regression / P3-IUR-AC01,AC02,AC03: synthetic pending at its budget survives delivery updates, encode and decode through the owner", () => {
    const make = (pad: number) => Array.from({ length: 64 }, (_, index) =>
      ({ ...pendingIntent(), id: `intent-${index}`, payload: { pad: index === 0 ? "x".repeat(pad) : "" } }));
    const reserved = (items: readonly NotificationIntent[]) => items.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const pending = make(131_072 - Buffer.byteLength(JSON.stringify(make(0))) - reserved(make(0)));
    expect(Buffer.byteLength(JSON.stringify(pending)) + reserved(pending)).toBe(131_072);
    const roundTrip = (state: WeatherCurrentUnitState) =>
      weatherCurrentUnitCodec.decode(JSON.parse(JSON.stringify(weatherCurrentUnitCodec.encode(state))));
    const first = weatherCurrentUnitCodec.decode(JSON.parse(JSON.stringify({ ...weatherCurrentUnitCodec.encode(emptyState()), intents: pending })));
    if (first.kind !== "restored") throw new Error("the synthetic payload does not decode");
    const now = clock();
    const empty = restoreOwner({ runId: "run", place: "weatherCurrent", clock: now, restored: { "U-W": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-W": first.state } };
    const update = (from: Parameters<typeof intentUpdateOwner>[0], split: boolean) => intentUpdateOwner(from, "U-W", from.units["U-W"]!.intents.map((item, index) => ({ id: item.id, attempts: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: -0.0000018927186924017318, disposition: split && index % 3 === 1 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    // 全 pending が最長へ伸びる更新（予約の不変条件、AC03）→ 3 件に 1 件が終端になる更新、のそれぞれの後で保存と復元ができる。
    const widened = update(owner, false);
    expect(widened.adopted).toBe(true);
    expect(roundTrip(widened.state.units["U-W"]!).kind).toBe("restored");
    const grown = update(widened.state, true);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-W"]!).kind).toBe("restored");
  });

  it("P3-WL1-T07 regression / P3-WL1-AC05: encode does not stringify the payload, histories or snapshots measured on receive", () => {
    let state = emptyState();
    for (let index = 0; index < 2; index++) state = receive(state, nationalSequel(index, "t07")).state;
    expect(state.histories.flatMap((item) => item.reports)).toHaveLength(1);
    const measured = new Set<unknown>([...Object.values(state.national), ...state.histories.flatMap((item) => item.reports)]);
    let payload: ReturnType<typeof weatherCurrentUnitCodec.encode> | null = null;
    const calls = stringified(() => { payload = weatherCurrentUnitCodec.encode(state); });
    const objects = calls.filter((value): value is object => value != null && typeof value === "object");
    expect(objects.filter((value) => "national" in value || "reports" in value)).toHaveLength(0);
    expect(calls.filter((value) => holdsAny(value, measured))).toHaveLength(0);
    expect(weatherCurrentUnitCodec.decode(payload!).kind).toBe("restored");
  });

});
