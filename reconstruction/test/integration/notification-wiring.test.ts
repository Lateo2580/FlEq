import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { ClockReading, JsonValue, NotificationResult, RuntimeInput } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import { serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { buildCapacityExceededLine, buildTsunamiPaint } from "../../src/display/chrome-eew/pure";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { observation, vtse41 } from "../tsunami-unit/tsunami-fixture";
import type { NotificationAbortRequest, NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { applyNotificationResult } from "../../src/notification-delivery/notification-delivery";
import { at, eewEnvelope } from "../notification-delivery/delivery-fixture";
import { envelope, harnessedRoot, park, seeded, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// TEST-PATH (2): the publisher with its in-process owners; the probe result is dispatched after startup.
async function startProbed(h: Harness, clock: ClockReading,
  channels: Extract<RuntimeInput, { kind: "notificationProbeCompleted" }>["channels"]) {
  await startHarness(h, "t11", clock, false);
  h.root.dispatch({ kind: "notificationProbeCompleted", channels, clock });
  await h.settle();
}
const eew = (h: Harness, clock: ClockReading) => submit(h, eewEnvelope("t11", clock));

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

async function settings() {
  const path = await fs.mkdtemp(join(tmpdir(), "fleq-a3-t11-"));
  paths.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

function adapter() {
  const attempts: NotificationAttempt[] = [];
  const aborts: { request: NotificationAbortRequest; stopBy: number }[] = [];
  const complete = new Map<string, (result: NotificationResult) => void>();
  return { attempts, aborts, complete,
    run: (attempt: NotificationAttempt) => {
      attempts.push(attempt);
      return new Promise<NotificationResult>((resolve) => { complete.set(attempt.attemptId, resolve); });
    },
    abort: async (request: NotificationAbortRequest, stopBy: number, clock: () => ClockReading) => {
      aborts.push({ request, stopBy });
      const attempt = attempts.find((item) => item.attemptId === request.attemptId)!;
      complete.get(request.attemptId)!({ kind: request.cause === "timeout" ? "timeout" : "aborted",
        ...(request.cause === "timeout" ? {} : { reason: request.cause }), stopped: true,
        attemptId: request.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() } as NotificationResult);
      return { attemptId: request.attemptId, stopped: true, completedAt: clock() };
    } };
}

it("P2-A3-T11 acceptance / AC11: a dirty owner reservation dispatches before checkpoint acknowledgement and adopts one run result", async () => {
  const fake = adapter();
  let now = at(0);
  // The save's write never completes here: the reservation and its result proceed while the save is in flight.
  const files = nodeCheckpointFileSystem();
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake,
    checkpointFileSystem: { ...files, open: () => park(new Promise(() => {})) } });
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  expect(fake.attempts).toHaveLength(1);
  expect(h.root.state.mirror["U-E"].persistence).toMatchObject({ kind: "pending", savedGeneration: 0 });
  void h.root.driveCheckpoint();
  await h.settle();
  expect(h.root.checkpoint.grantOf("U-E")).not.toBeNull();
  expect(h.root.state.mirror["U-E"].persistence.savedGeneration).toBe(0);
  const attempt = fake.attempts[0];
  now = at(1);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await h.settle();
  expect(h.unit("U-E").deliveryRecords.filter((item) => item.intentId === attempt.intentId))
    .toMatchObject([{ disposition: "delivered" }]);
  expect(h.root.state.mirror["U-E"].persistence.savedGeneration).toBe(0);
  await h.root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / AC11: timeout and shutdown forward A1 causes and stop deadlines; only run settles terminal", async () => {
  const fake = adapter();
  const abort = fake.abort;
  fake.abort = async (...args) => { await abort(...args); throw new Error("abort observation rejected"); };
  let now = at(0);
  const apply = vi.fn((state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) =>
    applyNotificationResult(state, result, clock));
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake,
    runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: apply } });
  await startProbed(h, now, { desktop: { kind: "idle" }, sound: { kind: "idle" } });
  await eew(h, now);
  expect(fake.attempts).toHaveLength(2);
  now = at(5_000);
  h.root.tick(now);
  const desktop = h.root.state.notificationChannels.desktop;
  expect(fake.aborts.map((item) => item.request)).toEqual([{
    attemptId: fake.attempts.find((item) => item.channel === "desktop")!.attemptId, cause: "timeout" }]);
  expect(fake.aborts[0].stopBy).toBe(desktop.kind === "stopping" ? desktop.stopByMonotonicMs : NaN);
  await h.settle();
  const before = h.root.state.mirror["U-E"].persistence.currentGeneration;
  const summary = await h.root.shutdownRuntime(0, now);
  expect(fake.aborts[1]?.request.cause).toBe("shutdown");
  expect(fake.aborts[1]?.stopBy).toBeLessThanOrEqual(6_000);
  expect(h.root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
  expect(summary.reasons).not.toContain("sideEffectFinalization:unconfirmedNotifications");
  expect(h.root.state.mirror["U-E"].persistence.currentGeneration).toBeGreaterThanOrEqual(before);
  // Only the run settles a terminal: each attempt's result reaches A7 once.
  for (const attempt of fake.attempts)
    expect(apply.mock.calls.filter(([, result]) => result.attemptId === attempt.attemptId)).toHaveLength(1);
});

it("P2-A3-T11 contractBoundary / AC11: a failed batch hook still waits for notification until the stage deadline", async () => {
  let now = at(0);
  let finish!: (result: NotificationResult) => void;
  const fake = { run: () => new Promise<NotificationResult>((resolve) => { finish = resolve; }),
    abort: async () => ({ stopped: false }) };
  const finalize = vi.fn(async (_deadline: number, active: () => boolean) => {
    expect(active()).toBe(true);
    throw new Error("batch failed");
  });
  const attempts: NotificationAttempt[] = [];
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: { ...fake, run: (value: NotificationAttempt) => { attempts.push(value); return fake.run(); } }, reportFailure: () => {},
    shutdownHooks: { finalizeBatchesAndSideEffects: finalize } });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const attempt = attempts[0];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const stopping = root.shutdownRuntime(0, now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(root.state.shutdown.stage).toBe("sideEffectFinalization");
    expect(root.state.shutdown.stageResults.sideEffectFinalization).toBeUndefined();
    now = at(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(root.state.shutdown.stageResults.sideEffectFinalization).toMatchObject({
      result: { kind: "failed", reason: "operationFailed" }, pending: { notificationAttempts: 1, batches: 1 },
    });
    now = at(5_001);
    finish({ kind: "aborted", reason: "shutdown", stopped: true, attemptId: attempt.attemptId,
      intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).toHaveBeenCalledTimes(1);
    await root.diagnostics.flush();
  } finally { vi.useRealTimers(); }
});

it("P2-A3-T11 regression / AC11: a notification result invariant rejects shutdown instead of completing a failed stage", async () => {
  const fake = adapter();
  fake.abort = async (request, _stopBy, clock) => ({ attemptId: request.attemptId, stopped: true, completedAt: clock() });
  const invariant = new Error("A1 result invariant");
  const now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: fake, runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: () => { throw invariant; } },
    shutdownHooks: { finalizeBatchesAndSideEffects: async () => {
      const attempt = fake.attempts[0];
      fake.complete.get(attempt.attemptId)!({ kind: "aborted", reason: "shutdown", stopped: true,
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
      return { batches: 0, notificationAttempts: 0 };
    } } });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  await expect(root.shutdownRuntime(0, now)).rejects.toBe(invariant);
  expect(root.state.shutdown.stage).toBe("sideEffectFinalization");
  expect(root.state.shutdown.stageResults.sideEffectFinalization).toBeUndefined();
  expect(root.state.notificationChannels.sound.kind).toBe("stopping");
  await root.diagnostics.flush();
});

it("P2-A3-T11 regression / AC11: a resolved but unconfirmed stop remains an isolated shutdown attempt", async () => {
  const fake = adapter();
  fake.abort = async (request, _stopBy, clock) => {
    const attempt = fake.attempts[0];
    fake.complete.get(request.attemptId)!({ kind: "aborted", reason: "shutdown", stopped: false,
      attemptId: request.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() });
    return { attemptId: request.attemptId, stopped: false, completedAt: clock() };
  };
  const now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const summary = await root.shutdownRuntime(0, now);
  expect(root.state.notificationChannels.sound.kind).toBe("isolated");
  expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(1);
  expect(summary.code).toBe(4);
  expect(summary.reasons).toContain("sideEffectFinalization:unconfirmedNotifications");
});

it("P2-A3-T11 regression / AC11: a rejected run returns one adapterError terminal without unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const now = at(0);
    const attempts: NotificationAttempt[] = [];
    const apply = vi.fn((state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) =>
      applyNotificationResult(state, result, clock));
    const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
      runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: apply },
      notificationAdapter: { run: async (value: NotificationAttempt) => { attempts.push(value); throw new Error("run rejected"); },
        abort: async () => {} } });
    const root = h.root;
    await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
    await eew(h, now);
    await h.settle();
    const attempt = attempts[0];
    expect(apply.mock.calls.map(([, result]) => result))
      .toEqual([{ kind: "failed", reason: "adapterError", attemptId: attempt.attemptId,
        intentId: attempt.intentId, channel: "sound", completedAt: now }]);
    expect(root.state.notificationChannels.sound.kind).toBe("idle");
    expect(h.unit("U-E").intents.find((item) => item.id === attempt.intentId))
      .toMatchObject({ attempts: 1, nextAttemptAt: now.wallTimeMs + 1_000, disposition: "pending" });
    await root.shutdownRuntime(0, now);
    expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
    expect(unhandled).toEqual([]);
    await root.diagnostics.flush();
  } finally { process.off("unhandledRejection", onUnhandled); }
});

it("P2-A3-T11 regression / AC11: a terminal result at TTL does not re-abort its settled run", async () => {
  const fake = adapter();
  let now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const attempt = fake.attempts[0];
  now = at(attempt.expiresAt - at(0).wallTimeMs);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await h.settle();
  expect(fake.aborts).toEqual([]);
  expect(h.unit("U-E").intents).toEqual([]);
  await h.root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / R34: unavailable desktop is skipped from first selection, expires at original TTL, and four reasons survive restart", async () => {
  const config = await settings();
  const fake = adapter();
  let now = at(0);
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" },
    sound: { kind: "unavailable", reason: "backendMissing" } });
  await root.diagnostics.flush();
  expect((await root.readDiagnostics({ limit: 100 })).records.filter((item) => item.reason === "notificationAttemptFailed"))
    .toMatchObject([{ level: "WARN", component: "notification-delivery", count: 2 }]);
  await eew(h, now);
  expect(fake.attempts).toEqual([]);
  const expiresAt = h.unit("U-E").intents[0].expiresAt;
  now = at(expiresAt - at(0).wallTimeMs);
  // As the host does on each tick: the tick is the liveness answer (P2-A10-AC13), so the mailbox reports no stall.
  root.mailbox.recordWorkerResponse(now.monotonicMs);
  root.tick(now);
  await h.settle();
  expect(fake.attempts).toEqual([]);
  expect(h.unit("U-E").intents.every((item) => item.disposition === "expired")).toBe(true);
  expect(root.state.notificationDeadlines.desktop).toEqual({});
  for (const reason of ["notificationCapacityEvicted", "notificationAdapterIsolated"] as const)
    root.enqueueDiagnostic({ timestamp: now.wallTimeMs, runId: "t11", level: "WARN", component: "notification-delivery", reason });
  await root.diagnostics.flush();
  const restarted = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter() });
  const read = await restarted.root.readDiagnostics({ limit: 100 });
  expect(new Set(read.records.map((item) => item.reason))).toEqual(new Set([
    "notificationAttemptFailed", "notificationExpired", "notificationCapacityEvicted", "notificationAdapterIsolated",
  ]));
  expect(read.records.filter((item) => item.reason === "notificationAttemptFailed")).toHaveLength(1);
});

// ---- P3-CURRENCY-COVERAGE-001（C1）AC08: owner の受信から確認状態・snapshot・chrome-eew の pure 関数・A7 の候補まで（TEST-PATH (2)） ----

const CC_RUN = "cc";
let ccSequence = 0;
const ccRaw = (minute: number) => `2099-01-01T09:${String(minute).padStart(2, "0")}:00+09:00`;
const ccStart: ClockReading = { wallTimeMs: Date.parse(ccRaw(0)), monotonicMs: 0 };
type Channels = Extract<RuntimeInput, { kind: "notificationProbeCompleted" }>["channels"];
const unavailable = { kind: "unavailable", reason: "backendMissing" } as const;

// 試験の中で組む VTSE41（tsunami-fixture の合成、区域コード 100 から count 区域）。
function forecastEnvelope(clock: ClockReading, eventId: string, minute: number, kind: string, count = 1) {
  const areas = Array.from({ length: count }, (_, index) => ({ code: String(100 + index), name: `区域${index}`, kind }));
  return envelope(CC_RUN, "VTSE41", `cc-${++ccSequence}`, Buffer.from(vtse41({ eventId, at: ccRaw(minute), areas })), clock, 1_000 + ccSequence);
}
function ccEnvelope(clock: ClockReading, headType: string, xml: string) {
  return envelope(CC_RUN, headType, `cc-${++ccSequence}`, Buffer.from(xml), clock, 1_000 + ccSequence);
}
// 世代を 4 MiB − slack にする終端記録を足す（記録の見え方は変えないので A8 の差分と食い違わない）。
function crowdTsunami(state: TsunamiUnitState, slack: number): TsunamiUnitState {
  const size = (value: TsunamiUnitState) => serializedEnvelope({ schemaVersion: "p3-tsunami-unit-v2", unit: "U-T", generation: 0, capturedAt: 0,
    payload: tsunamiUnitCodec.encode(value) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62
    + value.intents.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);
  const template = state.intents[0];
  const pad = (body: string): TsunamiUnitState => ({ ...state, intents: [...state.intents, { ...template, id: "U-T:pad",
    disposition: "delivered", expiresAt: template.createdAt + 86_400_000, payload: { ...template.payload, body } }] });
  const crowded = pad("x".repeat(4_194_304 - slack - size(pad(""))));
  expect(size(crowded)).toBe(4_194_304 - slack);
  return crowded;
}
async function ccRuntime(channels: Channels, start: ClockReading, config?: Awaited<ReturnType<typeof settings>>) {
  const fake = adapter();
  const seeds = seeded();
  const published: DisplaySnapshot[] = [];
  const directory = config ?? await settings();
  let now = start;
  const h = harnessedRoot(directory, linkedUnitCodecs, { clock: () => now, notificationAdapter: fake,
    runtimeCalls: { ...linkedRuntimeCalls, units: seeds.units }, display: { publish: (snapshot) => { published.push(snapshot); } } });
  await startHarness(h, CC_RUN, now, false);
  h.root.dispatch({ kind: "notificationProbeCompleted", channels, clock: now });
  await h.settle();
  return { h, fake, seeds, published, config: directory, get now() { return now; }, set(time: ClockReading) { now = time; },
    crowd: (slack = 5_000) => seeds.tsunami(h, crowdTsunami(h.unit("U-T"), slack), null, now) };
}
const pendingOf = (state: TsunamiUnitState, subject: string, channel: "desktop" | "sound") =>
  state.intents.find((item) => item.subject === subject && item.channel === channel && item.disposition === "pending")!;
const lastTsunami = (published: readonly DisplaySnapshot[]) => published.at(-1)!.current.tsunami;

it("P3-CC-T01 regression / AC01・AC08(1): an observation refused by the station limit leaves its event's VTSE41 shown and sounding", async () => {
  const quake = "20110311144640";
  const r = await ccRuntime({ desktop: unavailable, sound: { kind: "idle" } }, { wallTimeMs: Date.parse("2011-03-11T15:00:00+09:00"), monotonicMs: 0 });
  // 別の event の観測 4 本（各 255 点、XML の要素数の上限の内）で VTSE51 の station を 1,020 点にし、この event の先の観測（1 点）を採る。
  // 続報（32-39_11_10、観測点 5）で 1,024 点を越える。normal の active は退去の候補にならない。
  for (let filler = 0; filler < 4; filler++)
    await submit(r.h, ccEnvelope(r.now, "VTSE51", observation({ eventId: `2011031100000${filler + 1}`, at: "2011-03-11T14:50:00+09:00",
      serial: 1, stations: Array.from({ length: 255 }, (_, index) => ({ code: String(30_000 + filler * 255 + index) })) })));
  expect(r.h.unit("U-T").observations.reduce((sum, item) => sum + item.stations.length, 0)).toBe(1_020);
  await submit(r.h, ccEnvelope(r.now, "VTSE51", observation({ eventId: quake, at: "2011-03-11T14:55:00+09:00", serial: 2, stations: [{ code: "21001" }] })));
  const observed = `normal/tsunamiObservation:VTSE51/${quake}`;
  const before = r.h.unit("U-T").observations.find((item) => item.subject === observed)!;
  await submit(r.h, ccEnvelope(r.now, "VTSE51", readFileSync("test/fixtures/32-39_11_10_250206_VTSE51.xml", "utf8")));
  expect(r.h.unit("U-T").observations.find((item) => item.subject === observed)).toBe(before);
  expect(before).not.toHaveProperty("unavailable");
  expect(r.h.root.state.confirmation.units["U-T"].normal.whole).toBe("capacityExceeded");
  expect([pendingOf(r.h.unit("U-T"), observed, "desktop").payload.title, pendingOf(r.h.unit("U-T"), observed, "sound").payload.title])
    .toEqual(["【14:55 発表】津波観測に関する情報", "津波観測に関する情報"]);
  // 同じ event の大津波警報は view・A8・chrome-eew に出て、その critical の音は A7 の緊急群で選ばれる。
  await submit(r.h, ccEnvelope(r.now, "VTSE41", readFileSync("test/fixtures/32-39_11_11_250206_VTSE41.xml", "utf8")));
  const tsunami = lastTsunami(r.published);
  if (tsunami.delivery !== "full") throw new Error("tsunami is not delivered in full");
  expect(tsunami.view.forecasts.map((item) => item.subject)).toEqual([`normal/VTSE41/${quake}`]);
  expect(tsunami.items[0]).toMatchObject({ activeCount: 1, highestSeverity: "specialWarning", unconfirmed: { capacityExceeded: 1 } });
  const paint = buildTsunamiPaint(tsunami.view.forecasts);
  expect([paint.cards[0]?.className, paint.segments.length > 0]).toEqual(["tsu-major", true]);
  expect(buildCapacityExceededLine(tsunami.items[0])).toBe("[通常] 津波: 処理できていない報がある（容量超過）");
  const critical = pendingOf(r.h.unit("U-T"), `normal/VTSE41/${quake}`, "sound");
  expect(critical.payload.level).toBe("critical");
  expect(r.fake.attempts.filter((item) => item.intentId === critical.id).map((item) => item.priorityGroup)).toEqual(["normalTsunamiEmergency"]);
  await r.h.root.diagnostics.flush();
});

it("P3-CC-T02 acceptance / AC02・AC06・AC08(2): a new EEW for a full family leaves every card and pending and shows the EEW line", async () => {
  const report = Date.parse("2024-04-17T23:14:59+09:00");
  const r = await ccRuntime({ desktop: unavailable, sound: unavailable }, { wallTimeMs: report, monotonicMs: 0 });
  const xml = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
  const eew = (eventId: string) => ccEnvelope(r.now, "VXSE43", xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`));
  // EEW は mailbox の予約の枠（8 件）を使うので 8 件ずつ入れる。
  for (let from = 0; from < 512; from += 8)
    await submit(r.h, ...Array.from({ length: 8 }, (_, index) => eew(String(from + index + 1).padStart(14, "0"))));
  const before = r.h.unit("U-E");
  expect(before.current).toHaveLength(512);
  await submit(r.h, eew("00000000009999"));
  expect([r.h.unit("U-E").current, r.h.unit("U-E").intents]).toEqual([before.current, before.intents]);
  expect(r.h.root.state.confirmation.units["U-E"].normal.whole).toBe("capacityExceeded");
  const item = r.published.at(-1)!.current.eew.items[0];
  expect(item).toMatchObject({ activeCount: 512, unconfirmed: { capacityExceeded: 1 } });
  expect(buildCapacityExceededLine(item)).toBe("[通常] 緊急地震速報: 処理できていない報がある（容量超過）");
  await r.h.root.diagnostics.flush();
}, 120_000);

// owner へ送った入力の後に、main が今の mirror から予約を選ぶ（入力も予約もまだ owner へ渡していない）。
async function reserveBehind(r: Awaited<ReturnType<typeof ccRuntime>>, input: ReturnType<typeof forecastEnvelope>, running: NotificationAttempt,
  intentId: string) {
  r.h.pause();
  expect(r.h.root.mailbox.enqueue(input).kind).toBe("accepted");
  r.h.root.pump();
  r.fake.complete.get(running.attemptId)!({ kind: "delivered", attemptId: running.attemptId, intentId: running.intentId,
    channel: running.channel, completedAt: r.now });
  await new Promise((done) => setImmediate(done));
  const sentInput = r.h.sent.findIndex((item) => item.request.kind === "input" && item.request.envelope.messageId === input.messageId);
  const reservation = r.h.sent.findIndex((item) => item.request.kind === "intentUpdate"
    && item.request.updates.some((update) => update.id === intentId));
  expect([sentInput >= 0, reservation > sentInput]).toEqual([true, true]);
  await r.h.settle();
}

it("P3-CC-T06 acceptance / AC04(4)・AC08(3): a reservation chosen before the rewrite starts with the chosen text, one chosen after carries the time", async () => {
  const r = await ccRuntime({ desktop: { kind: "idle" }, sound: unavailable }, ccStart);
  const [b, c] = ["normal/VTSE41/20990101000002", "normal/VTSE41/20990101000003"];
  // A（大津波警報）の desktop の試行が走る間、B と C（津波注意報）の desktop は待つ。
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "52"));
  await submit(r.h, forecastEnvelope(r.now, "20990101000002", 1, "62"));
  await submit(r.h, forecastEnvelope(r.now, "20990101000003", 2, "62"));
  const running = r.fake.attempts.find((item) => item.channel === "desktop")!;
  const before = { b: pendingOf(r.h.unit("U-T"), b, "desktop"), c: pendingOf(r.h.unit("U-T"), c, "desktop") };
  await r.crowd();
  // C の続報（300 区域、段階は normal）は先に容量で入らず、C の desktop は時刻付きになる。
  await submit(r.h, forecastEnvelope(r.now, "20990101000003", 4, "62", 300));
  expect(pendingOf(r.h.unit("U-T"), c, "desktop").payload.title).toBe(`【09:02 発表】${before.c.payload.title}`);
  // B の続報が owner へ向かった後に A の試行が終わり、main は B を元の文面で選ぶ。owner は書き換えの後に予約を採り、試行は選んだ時の
  // 文面・同じ id・元の期限で始まる。
  await reserveBehind(r, forecastEnvelope(r.now, "20990101000002", 3, "62", 300), running, before.b.id);
  const chosen = r.fake.attempts.at(-1)!;
  expect([chosen.intentId, chosen.expiresAt, chosen.payload.title]).toEqual([before.b.id, before.b.expiresAt, before.b.payload.title]);
  expect(pendingOf(r.h.unit("U-T"), b, "desktop")).toMatchObject({ id: before.b.id, attempts: 1, expiresAt: before.b.expiresAt,
    payload: { title: `【09:01 発表】${before.b.payload.title}` } });
  // 書き換えの後に選ばれる C は時刻付きの文面で始まる。
  r.fake.complete.get(chosen.attemptId)!({ kind: "delivered", attemptId: chosen.attemptId, intentId: chosen.intentId,
    channel: "desktop", completedAt: r.now });
  await r.h.settle();
  const next = r.fake.attempts.at(-1)!;
  expect([next.intentId, next.expiresAt, next.payload.title]).toEqual([before.c.id, before.c.expiresAt, `【09:02 発表】${before.c.payload.title}`]);
  await r.h.root.diagnostics.flush();
});

it("P3-CC-T18 acceptance / AC10(6)・AC08(12)(a): a reservation of the light failure notice reaching the owner after its promotion starts no attempt", async () => {
  const r = await ccRuntime({ desktop: unavailable, sound: { kind: "idle" } }, ccStart);
  // A（津波警報）の音が走る間に、新しい subject の津波警報が容量で入らず warning の失敗警報が待つ。
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "51"));
  const running = r.fake.attempts.find((item) => item.channel === "sound")!;
  await r.crowd();
  await submit(r.h, forecastEnvelope(r.now, "20990101000002", 1, "51", 300));
  const failSound = () => r.h.unit("U-T").intents.filter((item) => item.subject === "normal/capacityRejected" && item.channel === "sound");
  const [light] = failSound();
  expect(light.payload.level).toBe("warning");
  // 大津波警報の拒否（昇格）が owner へ向かった後に、main が軽い失敗警報を選ぶ。owner は昇格の後なので予約を採らず、旧い試行は始まらない。
  await reserveBehind(r, forecastEnvelope(r.now, "20990101000003", 2, "52", 300), running, light.id);
  const [old, heavy] = failSound();
  expect([old.id, old.disposition, heavy.payload.level]).toEqual([light.id, "superseded", "critical"]);
  expect(r.fake.attempts.some((item) => item.intentId === light.id)).toBe(false);
  expect(r.fake.attempts.at(-1)).toMatchObject({ intentId: heavy.id, priorityGroup: "normalTsunamiEmergency" });
  await r.h.root.diagnostics.flush();
});

// AC08(4)(5): 印と書き換えを含む世代を保存してから（saveAfter）か、拒否の前の世代だけを保存してから再起動する。
async function restarted(saveAfter: boolean) {
  const r = await ccRuntime({ desktop: unavailable, sound: unavailable }, ccStart);
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "51"));
  const save = async () => { await r.h.root.driveCheckpoint(); await r.h.settle(); };
  await save();
  // 拒否の前の世代 G だけを保存した窓: G+1 の保存（書込み権の付与）を止めたまま再起動する。
  if (!saveAfter) r.h.holdRequests((_place, request) => request.kind === "checkpointGrant");
  await r.crowd();
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 2, "62", 300));
  if (saveAfter) await save();
  expect(r.h.root.state.mirror["U-T"].persistence.kind).toBe(saveAfter ? "saved" : "pending");
  const original = r.h.unit("U-T");
  await r.h.root.diagnostics.flush();
  return { original, next: await ccRuntime({ desktop: unavailable, sound: unavailable }, { wallTimeMs: ccStart.wallTimeMs + 60_000, monotonicMs: 0 },
    r.config) };
}
const CC_SUBJECT = "normal/VTSE41/20990101000001";

it("P3-CC-T07 acceptance / AC05・AC08(4): after the saved rejection the mark and the stamped desktop return, confirmation starts over", async () => {
  const { original, next } = await restarted(true);
  const unit = next.h.unit("U-T");
  expect(unit.forecasts.find((item) => item.subject === CC_SUBJECT)?.unavailable).toMatchObject({ reason: "capacityExceeded",
    source: { reportDateTimeRaw: ccRaw(2) } });
  const desktop = pendingOf(original, CC_SUBJECT, "desktop");
  expect(pendingOf(unit, CC_SUBJECT, "desktop")).toMatchObject({ id: desktop.id, expiresAt: desktop.expiresAt, payload: { title: desktop.payload.title } });
  expect(desktop.payload.title.startsWith("【09:00 発表】")).toBe(true);
  expect(next.h.root.state.confirmation.units["U-T"].normal.whole).toBe("startup");
  const tsunami = lastTsunami(next.published);
  expect(tsunami.items[0].unavailable).toEqual({ capacityExceeded: 1 });
  expect(tsunami.delivery === "full" && tsunami.view.forecasts[0].unavailable).toMatchObject({ reason: "capacityExceeded" });
  // 拒否の前の世代だけを保存していたなら、印も書き換えも戻らない。
  const earlier = (await restarted(false)).next.h.unit("U-T");
  expect(earlier.forecasts.find((item) => item.subject === CC_SUBJECT)).not.toHaveProperty("unavailable");
  expect(pendingOf(earlier, CC_SUBJECT, "desktop").payload.title.startsWith("【")).toBe(false);
});

it("P3-CC-T08 acceptance / AC03・AC08(5): right after the restart a newer report of the subject clears the mark and notifies", async () => {
  const { next } = await restarted(true);
  await submit(next.h, forecastEnvelope(next.now, "20990101000001", 4, "51"));
  const unit = next.h.unit("U-T");
  expect(unit.forecasts.find((item) => item.subject === CC_SUBJECT)).not.toHaveProperty("unavailable");
  expect(unit.intents.filter((item) => item.subject === CC_SUBJECT && item.source.reportDateTimeRaw === ccRaw(4)).map((item) => item.channel))
    .toEqual(["desktop", "sound"]);
  expect(lastTsunami(next.published).items[0].unavailable).toEqual({});
  await next.h.root.diagnostics.flush();
});

it("P3-CC-T12 acceptance / AC04・AC08(6): an undelivered warning keeps its stamped desktop and its sound while the forecast shows last-confirmed", async () => {
  const r = await ccRuntime({ desktop: unavailable, sound: unavailable }, ccStart);
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "51"));
  const issued = { desktop: pendingOf(r.h.unit("U-T"), CC_SUBJECT, "desktop"), sound: pendingOf(r.h.unit("U-T"), CC_SUBJECT, "sound") };
  await r.crowd();
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 3, "51", 300));
  expect(pendingOf(r.h.unit("U-T"), CC_SUBJECT, "desktop")).toMatchObject({ id: issued.desktop.id, expiresAt: issued.desktop.expiresAt,
    payload: { level: "warning", title: `【09:00 発表】${issued.desktop.payload.title}` } });
  expect(pendingOf(r.h.unit("U-T"), CC_SUBJECT, "sound")).toBe(issued.sound);
  const tsunami = lastTsunami(r.published);
  if (tsunami.delivery !== "full") throw new Error("tsunami is not delivered in full");
  expect(buildTsunamiPaint(tsunami.view.forecasts).cards[0]).toMatchObject({ head: expect.stringMatching(/^最終確認：/),
    unavailableLine: "09:03 の情報を処理できていません" });
  await r.h.root.diagnostics.flush();
});

it("P3-CC-T15 contractBoundary / AC04(2)・AC08(10): a stamped desktop keeps its id and monotonic deadline when the wall clock steps back", async () => {
  const r = await ccRuntime({ desktop: { kind: "idle" }, sound: unavailable }, ccStart);
  const b = "normal/VTSE41/20990101000002";
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "52"));
  await submit(r.h, forecastEnvelope(r.now, "20990101000002", 1, "62"));
  const waiting = { desktop: pendingOf(r.h.unit("U-T"), b, "desktop"), sound: pendingOf(r.h.unit("U-T"), b, "sound") };
  const key = JSON.stringify(["U-T", waiting.desktop.id]);
  const deadline = r.h.root.state.notificationDeadlines.desktop[key]!;
  await r.crowd();
  await submit(r.h, forecastEnvelope(r.now, "20990101000002", 3, "62", 300));
  expect(pendingOf(r.h.unit("U-T"), b, "desktop")).toMatchObject({ id: waiting.desktop.id, expiresAt: waiting.desktop.expiresAt,
    payload: { title: `【09:01 発表】${waiting.desktop.payload.title}` } });
  expect(pendingOf(r.h.unit("U-T"), b, "sound")).toBe(waiting.sound);
  expect(r.h.root.state.notificationDeadlines.desktop[key]).toEqual(deadline);
  r.set({ wallTimeMs: r.now.wallTimeMs - 30_000, monotonicMs: deadline.expiresAtMonotonicMs });
  r.h.root.mailbox.recordWorkerResponse(r.now.monotonicMs);
  r.h.root.tick(r.now);
  await r.h.settle();
  expect(r.h.unit("U-T").intents.find((item) => item.id === waiting.desktop.id)?.disposition).toBe("expired");
  expect(r.h.root.state.notificationDeadlines.desktop[key]).toBeUndefined();
  await r.h.root.diagnostics.flush();
});

it("P3-CC-T16 acceptance / AC10・AC08(11): a refused upgrade to a major warning sounds a critical failure notice without superseding the subject", async () => {
  const r = await ccRuntime({ desktop: unavailable, sound: { kind: "idle" } }, ccStart);
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 0, "51"));
  const issued = pendingOf(r.h.unit("U-T"), CC_SUBJECT, "desktop");
  const running = r.fake.attempts.find((item) => item.channel === "sound")!;
  await r.crowd();
  await submit(r.h, forecastEnvelope(r.now, "20990101000001", 3, "52", 300));
  const notices = r.h.unit("U-T").intents.filter((item) => item.subject === "normal/capacityRejected");
  expect(notices.map((item) => [item.channel, item.payload.level, item.payload.title])).toEqual([
    ["desktop", "critical", "【処理できていません】大津波警報（09:03 発表）"], ["sound", "critical", "【処理できていません】大津波警報（09:03 発表）"]]);
  expect(pendingOf(r.h.unit("U-T"), CC_SUBJECT, "desktop")).toMatchObject({ id: issued.id, disposition: "pending" });
  // 走っている同じ群の音が終わると、次は失敗警報の音が緊急群で選ばれる。
  r.fake.complete.get(running.attemptId)!({ kind: "delivered", attemptId: running.attemptId, intentId: running.intentId,
    channel: "sound", completedAt: r.now });
  await r.h.settle();
  expect(r.fake.attempts.at(-1)).toMatchObject({ intentId: notices[1].id, priorityGroup: "normalTsunamiEmergency" });
  // 津波注意報以下の拒否は失敗警報を足さない。
  await submit(r.h, forecastEnvelope(r.now, "20990101000009", 4, "62", 300));
  expect(r.h.unit("U-T").intents.filter((item) => item.subject === "normal/capacityRejected").map((item) => [item.id, item.payload.level]))
    .toEqual(notices.map((item) => [item.id, item.payload.level]));
  await r.h.root.diagnostics.flush();
});
