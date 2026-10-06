import { promises as fileSystem, readFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import { startP2Host } from "../../src/host/host";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";

// TEST-PATH (3) for P3-EXECUTION-LIFECYCLE-001: startP2Host with the three dist owner threads. The mock only watches
// replies, can hold one owner's inputDone, and starts the deferred owner through the test-only blocking entry.
const control = vi.hoisted(() => ({
  live: new Set<{ terminate(): Promise<number> }>(),
  byPlace: new Map<string, { terminate(): Promise<number> }>(),
  replies: [] as { place: string; kind: string }[],
  holdInputOf: null as string | null,
  held: [] as (() => void)[],
  blockPlace: null as string | null,
  block: null as Int32Array | null,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    private readonly place: string;
    constructor(filename: string | URL, options?: WorkerOptions) {
      const start = options?.workerData as { place: string };
      const shared = control.blockPlace === start.place ? new SharedArrayBuffer(4) : null;
      super(shared == null ? filename : resolve("reconstruction/test/execution-lifecycle/blocking-owner.cjs"),
        shared == null ? options : { ...options, workerData: { ...start, c3bBlock: shared, c3bEntry: String(filename) } });
      if (shared != null) control.block = new Int32Array(shared);
      this.place = start.place;
      control.live.add(this);
      control.byPlace.set(start.place, this);
      this.once("exit", () => { control.live.delete(this); });
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event !== "message") return super.emit(event, ...args);
      const { kind } = args[0] as { kind: string };
      control.replies.push({ place: this.place, kind });
      if (kind === "inputDone" && control.holdInputOf === this.place) {
        control.held.push(() => { super.emit(event, ...args); });
        return true;
      }
      return super.emit(event, ...args);
    }
  }
  return { ...actual, Worker };
});
// The product backends would pop a notification and play a sound for every EEW.
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

// The injected clock moves only with skew, so the 5-tick boundaries do not depend on real time (setTimeout stays real).
const EEW_AT = 1_713_363_299_001;
const base = performance.now();
const skew = { ms: 0 };
const clock = () => ({ wallTimeMs: EEW_AT + skew.ms, monotonicMs: base + skew.ms });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  if (control.block != null) { Atomics.store(control.block, 0, 0); Atomics.notify(control.block, 0); }
  Object.assign(control, { holdInputOf: null, blockPlace: null, block: null });
  control.held.length = 0;
  control.replies.length = 0;
  skew.ms = 0;
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(() => control.live.size === 0);
});

async function until(condition: () => boolean | Promise<boolean>, milliseconds = 8_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!(await condition())) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setImmediate(done));
  }
}
async function setup() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c3b-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  const dirs = { stateDirectory: join(path, "state"), diagnosticDirectory: join(path, "diagnostics") };
  const host = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, ...dirs, displayPort: 0,
    clock, observe: null });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  await until(() => sockets.length === 1);
  const heartbeats: string[] = [];
  await new Promise<void>((done, reject) => {
    get({ host: "127.0.0.1", port: host.displayPort, path: "/events", agent: false }, (response) => {
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith("event: snapshot")) heartbeats.push(JSON.parse(frame.split("\n").at(-1)!.slice("data: ".length)).worker.state);
        }
      });
      response.on("error", () => {});
      done();
    }).on("error", reject);
  });
  const fetchJson = <Body>(route: string) => new Promise<Body>((resolveBody, reject) => {
    get({ host: "127.0.0.1", port: host.displayPort, path: route, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolveBody(JSON.parse(body)));
    }).on("error", reject);
  });
  const lines = async () => {
    const names = await fileSystem.readdir(dirs.diagnosticDirectory).catch(() => [] as string[]);
    const text = (await Promise.all(names.filter((name) => name.endsWith(".jsonl"))
      .map((name) => fileSystem.readFile(join(dirs.diagnosticDirectory, name), "utf8")))).join("");
    return text.split("\n").filter((line) => line !== "")
      .map((line): { level: string; component: string; reason: string; inputId?: string; count?: number } => JSON.parse(line));
  };
  return { host, ws: sockets[0], heartbeats, dirs, lines, snapshot: () => fetchJson<DisplaySnapshot>("/snapshot"),
    healthz: async () => (await fetchJson<{ worker: string }>("/healthz")).worker };
}
const fixtureText = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
function dataFrame(headType: string, body: string): string {
  return JSON.stringify({ type: "data", version: "2.0", classification: "telegram.weather", id: "id", format: "xml",
    encoding: "utf-8", compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
    xmlReport: { control: { status: "通常" } }, body });
}
const answered = (place: string) => control.replies.filter((reply) => reply.place === place && reply.kind === "deadlineDone").length;
// One host tick at +1 s of the injected clock; the next tick waits until the unblocked owners answered this one.
async function step(places: readonly string[]): Promise<void> {
  const before = places.map(answered);
  skew.ms += 1_000;
  vi.advanceTimersByTime(1_000);
  await until(() => places.every((place, index) => answered(place) > before[index]));
}

describe("P3-C3B owners as real threads (TEST-PATH (3))", () => {
  it("P3-C3B-T02 acceptance / AC01: a deferred owner thread really blocked is unresponsive after 5 ticks while the EEW is shown", async () => {
    control.blockPlace = "deferred";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const t = await setup();
    const others = ["urgent", "weatherCurrent"] as const;
    await step([...others, "deferred"]);
    Atomics.store(control.block!, 0, 1);
    // The tick whose deadline request blocks the thread, then four more: still healthy.
    for (let tick = 0; tick < 5; tick += 1) await step(others);
    expect(t.heartbeats).toEqual([]);
    await step(others);
    await until(() => t.heartbeats.length === 1);
    expect(t.heartbeats).toEqual(["unresponsive"]);
    expect(await t.healthz()).toBe("unresponsive");
    await until(async () => (await t.lines()).some((line) => line.component === "owner.deferred.response"));
    expect((await t.lines()).filter((line) => line.reason === "mailboxStalled" && line.component.startsWith("owner."))
      .map((line) => line.component).sort()).toEqual(["owner.deferred", "owner.deferred.response"]);
    // The publisher's tick runs while the deferred thread is blocked, and the EEW goes through urgent.
    t.ws.send(dataFrame("VXSE43", fixtureText("37_01_01_240613_VXSE43")));
    await until(async () => (await t.snapshot()).current.eew.items.length > 0);
    const blocked = answered("deferred");
    Atomics.store(control.block!, 0, 0);
    Atomics.notify(control.block!, 0);
    await until(() => answered("deferred") > blocked);
    await step(others);
    await until(() => t.heartbeats.length === 2);
    expect(t.heartbeats).toEqual(["unresponsive", "healthy"]);
    await t.host.stop();
    await until(() => control.live.size === 0);
  });

  it("P3-C3B-T03 acceptance / AC02,AC03: a terminated deferred owner with an input in flight: stopped is shown, EEW goes on, its input is refused, stop() is code 3", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const t = await setup();
    // The host's root, to read its stage results after stop().
    const roots: RuntimeCompositionRoot[] = [];
    const shutdownRuntime = RuntimeCompositionRoot.prototype.shutdownRuntime;
    const shutdown = vi.spyOn(RuntimeCompositionRoot.prototype, "shutdownRuntime").mockImplementation(
      function (this: RuntimeCompositionRoot, ...args) { roots.push(this); return shutdownRuntime.apply(this, args); });
    cleanups.push(() => shutdown.mockRestore());
    const series = () => (async () => JSON.stringify((await t.snapshot()).current.weatherTimeseries))();
    const before = await series();
    control.holdInputOf = "deferred";
    t.ws.send(dataFrame("VPWP50", fixtureText("81_02_01_260605_VPWP50_high_severity")));
    await until(() => control.held.length === 1);
    await control.byPlace.get("deferred")!.terminate();
    const errors = () => t.lines().then((lines) => lines.filter((line) => line.reason === "ownerStopped" && line.level === "ERROR"));
    await until(async () => (await errors()).length === 1);
    expect(await errors()).toEqual([expect.objectContaining({ component: "owner.deferred", count: 1 })]);
    await step(["urgent", "weatherCurrent"]);
    await until(() => t.heartbeats.length === 1);
    expect(t.heartbeats).toEqual(["stopped"]);
    expect(await t.healthz()).toBe("stopped");
    await step(["urgent", "weatherCurrent"]);
    await until(async () => (await t.snapshot()).worker.state === "stopped");
    t.ws.send(dataFrame("VXSE43", fixtureText("37_01_01_240613_VXSE43")));
    await until(async () => (await t.snapshot()).current.eew.items.length > 0);
    t.ws.send(dataFrame("VPWP50", fixtureText("81_02_01_260605_VPWP50_high_severity")));
    const refusals = () => t.lines().then((lines) => lines.filter((line) => line.reason === "ownerStopped" && line.level === "WARN"));
    await until(async () => (await refusals()).length === 1);
    expect(await refusals()).toEqual([expect.objectContaining({ component: "owner.deferred", inputId: "input-3" })]);
    expect(await series()).toBe(before);
    const summary = await t.host.stop();
    expect(summary).toMatchObject({ code: 3, inFlightInputs: 1, pendingInputs: 0,
      reasons: ["mailboxDrain:failed:ownerStopped", "mailboxDrain:remainingInputs", "finalCheckpoint:unsavedUnits"] });
    const [stopped] = roots;
    expect(Object.entries(stopped.state.shutdown.stageResults).map(([stage, observation]) => [stage, observation?.result]))
      .toEqual([["mailboxDrain", { kind: "failed", reason: "ownerStopped" }], ["sideEffectFinalization", { kind: "completed" }],
        ["finalCheckpoint", { kind: "completed" }], ["workerClose", { kind: "completed" }]]);
    const onDisk = JSON.parse(await fileSystem.readFile(join(t.dirs.diagnosticDirectory, "shutdown-summary.json"), "utf8"));
    expect(onDisk.reasons).toEqual(summary.reasons);
    // No count line: nothing was refused after the first.
    expect((await refusals()).filter((line) => line.count != null)).toEqual([]);
    await until(() => control.live.size === 0);
  });
});
