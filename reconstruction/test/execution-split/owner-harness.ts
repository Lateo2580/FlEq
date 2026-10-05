import { readFileSync } from "node:fs";
import type {
  ClockReading, MailboxEnvelope, NotificationResult, RuntimeUnitDeadline, RuntimeUnitId, RuntimeUnitStates,
} from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import type { ExecutionPlace, OwnerReply, OwnerRequest, ParserEnvelope } from "../../contracts/p3-execution-split.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointFileSystem, CodecMap } from "../../src/checkpoint/checkpoint";
import type { AppConfig } from "../../src/app-config/app-config";
import {
  RuntimeCompositionRoot, linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem,
} from "../../src/runtime/composition-root";
import type { CompositionOptions, NotificationCalls } from "../../src/runtime/composition-root";
import { OwnerHost } from "../../src/runtime/owner-host";
import { executionPlaces } from "../../src/runtime/unit-coverage";

// TEST-PATH (2), the one test-side helper (P3-C3A-TEST-PATH): the product OwnerHost of each place runs in-process,
// every request and reply crosses structuredClone, and replies can be held and delivered explicitly. It makes no
// product decision. Without it the publisher/owner wiring tests could not run on fake clocks and file systems.
type Owners = Readonly<{
  // The shared real clock; by default the injected monotonic clock, so measured and business time agree.
  sharedNow?: () => number;
}>;
type Held = (place: ExecutionPlace, reply: OwnerReply) => boolean;

const places = ["urgent", "weatherCurrent", "deferred"] as const satisfies readonly ExecutionPlace[];

// runtimeCalls: the unit rows go to the owners (and give the publisher its confirmation limits); the notification
// calls go to the publisher. codecs: as the composition root takes them; the owners get the same.
function harnessedRoot(config: AppConfig, codecs: CodecMap<RuntimeUnitStates> = linkedUnitCodecs,
  options: Omit<CompositionOptions, "send" | "units" | "notificationCalls"> & Readonly<{
    runtimeCalls?: Readonly<{ units?: UnitTable } & NotificationCalls>; checkpointFileSystem?: CheckpointFileSystem;
    owners?: Owners }> = {}) {
  const clock = options.clock ?? (() => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() }));
  const sharedNow = options.owners?.sharedNow ?? (() => clock().monotonicMs);
  const requests: { place: ExecutionPlace; request: OwnerRequest }[] = [];
  const replies: { place: ExecutionPlace; reply: OwnerReply }[] = [];
  const holds: Held[] = [];
  const held: { place: ExecutionPlace; reply: OwnerReply }[] = [];
  // Requests kept from their owner (in port order, so every later request to that owner waits too).
  const requestHolds: ((place: ExecutionPlace, request: OwnerRequest) => boolean)[] = [];
  const heldRequests: { place: ExecutionPlace; request: OwnerRequest }[] = [];
  // Every reply the publisher received, in order (tests read the owners' outputs from here).
  const delivered: { place: ExecutionPlace; reply: OwnerReply }[] = [];
  const failures: unknown[] = [];
  const sent: { place: ExecutionPlace; request: OwnerRequest }[] = [];
  let scheduled = false;
  let manual = false;
  const owners = new Map(places.map((place) => [place, new OwnerHost({
    start: { place, stateDirectory: config.stateDirectory, publisherTimeOriginMs: 0 },
    units: options.runtimeCalls?.units ?? linkedUnitTable, codecs,
    fileSystem: options.checkpointFileSystem ?? nodeCheckpointFileSystem(), sharedNow,
    reply: (reply) => { replies.push({ place, reply: structuredClone(reply) }); schedule(); },
    fail: (error) => { failures.push(error); },
  })] as const));
  const { runtimeCalls, owners: _owners, checkpointFileSystem: _fileSystem, ...rest } = options;
  const root: RuntimeCompositionRoot = new RuntimeCompositionRoot(config, codecs, {
    ...rest, clock, sharedNow, units: runtimeCalls?.units,
    notificationCalls: runtimeCalls == null ? undefined : { selectNotificationAttempt: runtimeCalls.selectNotificationAttempt,
      applyNotificationResult: runtimeCalls.applyNotificationResult },
    send: (place, request) => {
      const copy = structuredClone(request);
      sent.push({ place, request: copy });
      requests.push({ place, request: copy });
      schedule();
    },
  });
  // Delivers queued requests to owners and unheld replies to the publisher until nothing moves.
  function flush(): void {
    for (;;) {
      const request = requests.shift();
      if (request != null) {
        if (heldRequests.some((item) => item.place === request.place)
          || requestHolds.some((hold) => hold(request.place, request.request))) { heldRequests.push(request); continue; }
        try { owners.get(request.place)!.handle(request.request); } catch (error) { failures.push(error); }
        continue;
      }
      const next = replies.shift();
      if (next == null) return;
      if (holds.some((hold) => hold(next.place, next.reply))) { held.push(next); continue; }
      delivered.push(next);
      root.receive(next.place, next.reply);
    }
  }
  function schedule(): void {
    if (scheduled || manual) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      try { flush(); } catch (error) { failures.push(error); }
    });
  }
  return {
    root, owners, sent,
    // Waits until no request or reply is queued for `turns` consecutive event-loop turns. Owner file operations are not
    // counted: a test that needs a write to end awaits root.driveCheckpoint() (or a held reply) instead.
    async settle(turns = 3): Promise<void> {
      for (let quiet = 0; quiet < turns;) {
        const before = requests.length + replies.length;
        try { flush(); } catch (error) { failures.push(error); }
        await new Promise((done) => setImmediate(done));
        if (failures.length !== 0) throw failures.shift();
        quiet = before === 0 && requests.length + replies.length === 0 ? quiet + 1 : 0;
      }
    },
    flush,
    // Stops automatic delivery: requests and replies wait for flush() or settle().
    pause(): void { manual = true; },
    // Keeps matching replies away from the publisher until release().
    hold(match: Held): () => void {
      holds.push(match);
      return () => { holds.splice(holds.indexOf(match), 1); };
    },
    release(match?: Held): void {
      const ready = held.filter((item) => match == null || match(item.place, item.reply));
      for (const item of ready) held.splice(held.indexOf(item), 1);
      for (const item of ready) { delivered.push(item); root.receive(item.place, item.reply); }
    },
    // Keeps matching requests (and every later one to the same owner) from the owner until releaseRequests().
    holdRequests(match: (place: ExecutionPlace, request: OwnerRequest) => boolean): () => void {
      requestHolds.push(match);
      return () => { requestHolds.splice(requestHolds.indexOf(match), 1); };
    },
    releaseRequests(place?: ExecutionPlace): void {
      const ready = heldRequests.filter((item) => place == null || item.place === place);
      for (const item of ready) heldRequests.splice(heldRequests.indexOf(item), 1);
      requests.unshift(...ready);
      schedule();
    },
    heldRequests,
    // Delivers one held reply a second time (duplicate delivery).
    redeliver(place: ExecutionPlace, reply: OwnerReply): void { root.receive(place, structuredClone(reply)); },
    held,
    replies,
    delivered,
    // A unit's current state inside its owner (read only; the owner keeps it private to the product).
    unit<K extends RuntimeUnitId>(unit: K): RuntimeUnitStates[K] {
      const state = owners.get(executionPlaces[unit])!["state"];
      const value: RuntimeUnitStates[K] | undefined = state?.units[unit];
      if (value == null) throw new Error(`unit ${unit} has no state yet`);
      return value;
    },
    failures,
    clock,
  };
}

type Harness = ReturnType<typeof harnessedRoot>;

const idleChannels = { desktop: { kind: "idle" }, sound: { kind: "idle" } } as const;

// Starts the runtime (every owner restores) and completes the notification probe with idle channels.
async function startHarness(h: Harness, runId: string, clock: ClockReading = h.clock(), probe = true): Promise<void> {
  const started = h.root.startRuntime(runId, clock, idleChannels);
  await h.settle();
  await started;
  if (probe) h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock });
  await h.settle();
}

// One parser input as the host would enqueue it (ingress of the given bytes).
function envelope(runId: string, headType: string, inputId: string, body: Uint8Array, clock: ClockReading,
  inputSequence = 1): ParserEnvelope {
  const entered = ingestXmlData({ kind: "replay", inputId, inputSequence, receivedAt: clock.wallTimeMs, origin: "replay",
    headType, body });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { messageId: inputId, runId, t0MonotonicMs: clock.monotonicMs, enqueuedMonotonicMs: clock.monotonicMs,
    priorityReason: headType === "VXSE43" || headType === "VXSE45" ? "eewCandidate" : "normal",
    payload: { kind: "parser", item: entered.item } };
}

// Enqueues inputs, hands them to their owners and waits until every reply was applied.
async function submit(h: Harness, ...inputs: readonly MailboxEnvelope[]): Promise<void> {
  for (const input of inputs) {
    const result = h.root.mailbox.enqueue(input);
    if (result.kind !== "accepted") throw new Error(`mailbox rejected ${input.messageId}: ${result.reason}`);
  }
  h.root.pump();
  await h.settle();
}

// One decodable report per unit for inputs whose content a stub reducer ignores.
const unitBodies: Readonly<Record<RuntimeUnitId, Readonly<{ headType: string; body: Uint8Array }>>> = {
  "U-E": { headType: "VXSE43", body: readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml") },
  "U-W": { headType: "VPWW57", body: readFileSync("test/fixtures/15_16_02_251222_VPWW57.xml") },
  "U-F": { headType: "VPWP50", body: readFileSync("test/fixtures/81_02_01_260605_VPWP50_high_severity.xml") },
};

type Seed<K extends RuntimeUnitId> = Readonly<{ state: RuntimeUnitStates[K]; deadline: RuntimeUnitDeadline | null }>;

// Sets an owner's unit to a given state through one input its reducer recognises (inputId "seed:<n>"), so a wiring
// test can start from any unit state. Every other input reaches the given unit rows unchanged.
function seeded(base: UnitTable = linkedUnitTable) {
  let eew: Seed<"U-E"> | null = null, weather: Seed<"U-W"> | null = null, series: Seed<"U-F"> | null = null;
  const empty = { decisions: [], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] } as const;
  const seeding = (input: { kind: string; material?: { inputId: string } }) =>
    input.kind === "receive" && input.material?.inputId.startsWith("seed:") === true;
  const units: UnitTable = {
    "U-E": { ...base["U-E"], reduce: (state, input) => {
      if (seeding(input) && eew != null) { const seed = eew; eew = null; return { ...empty, state: seed.state, nextDeadline: seed.deadline }; }
      return base["U-E"].reduce(state, input);
    } },
    "U-W": { ...base["U-W"], reduce: (state, input) => {
      if (seeding(input) && weather != null) { const seed = weather; weather = null; return { ...empty, state: seed.state, nextDeadline: seed.deadline }; }
      return base["U-W"].reduce(state, input);
    } },
    "U-F": { ...base["U-F"], reduce: (state, input) => {
      if (seeding(input) && series != null) { const seed = series; series = null; return { ...empty, state: seed.state, nextDeadline: seed.deadline }; }
      return base["U-F"].reduce(state, input);
    } },
  };
  let sequence = 0;
  const send = (h: Harness, unit: RuntimeUnitId, clock: ClockReading) => submit(h, envelope(h.root.state.runId,
    unitBodies[unit].headType, `seed:${++sequence}`, unitBodies[unit].body, clock, 100_000 + sequence));
  return {
    units,
    async eew(h: Harness, state: RuntimeUnitStates["U-E"], deadline: RuntimeUnitDeadline | null = null, clock = h.clock()) {
      eew = { state, deadline }; await send(h, "U-E", clock);
    },
    async weather(h: Harness, state: RuntimeUnitStates["U-W"], deadline: RuntimeUnitDeadline | null = null, clock = h.clock()) {
      weather = { state, deadline }; await send(h, "U-W", clock);
    },
    async series(h: Harness, state: RuntimeUnitStates["U-F"], deadline: RuntimeUnitDeadline | null = null, clock = h.clock()) {
      series = { state, deadline }; await send(h, "U-F", clock);
    },
  };
}

// A notification adapter whose attempts end only when the test finishes them.
function manualAdapter() {
  const runs: { attempt: NotificationAttempt; finish: (result: NotificationResult) => void }[] = [];
  const aborts: string[] = [];
  return {
    runs, aborts,
    adapter: {
      run: (attempt: NotificationAttempt) => new Promise<NotificationResult>((finish) => { runs.push({ attempt, finish }); }),
      abort: async (request: Readonly<{ attemptId: string }>) => { aborts.push(request.attemptId); return { stopped: true }; },
    },
    // Ends a started attempt with the result (the adapter's terminal); the caller settles afterwards.
    finish(result: NotificationResult): void {
      const run = runs.find((item) => item.attempt.attemptId === result.attemptId);
      if (run == null) throw new Error(`attempt ${result.attemptId} never started`);
      run.finish(result);
    },
  };
}

export { envelope, harnessedRoot, idleChannels, manualAdapter, places, seeded, startHarness, submit, unitBodies };
export type { Harness, Owners };
