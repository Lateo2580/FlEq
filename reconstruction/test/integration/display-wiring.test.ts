import { promises as fileSystem } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { DisplaySnapshot, HealthResponse } from "../../contracts/p2-snapshot-sse.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import type { CompositionOptions } from "../../src/runtime/composition-root";
import { recordingNotificationAdapter, testNotificationChannels } from "../checkpoint-shutdown/runtime-fixture";
import { atTime, decode, eewReport, received } from "../snapshot-sse/projection-fixture";

// Notification selection is out of scope here; it only adds asynchronous result steps.
const runtimeCalls = { ...linkedRuntimeCalls, selectNotificationAttempt: (delivery: NotificationDeliveryState) =>
  ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }) };
const EEW_AT = 1_713_363_299_001; // 37_01_01 VXSE43 ReportDateTime + 1 ms (sequences.json expected:O07:16)
const temporary: string[] = [];
const servers: Awaited<ReturnType<typeof startDisplayServer>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.close();
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

async function config() {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a3-display-"));
  temporary.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

function harness(settings: Awaited<ReturnType<typeof config>>, wallTimeMs: number, options: CompositionOptions = {}) {
  const published: DisplaySnapshot[] = [];
  const now = { wallTimeMs, monotonicMs: 1 };
  const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls,
    notificationAdapter: recordingNotificationAdapter(), clock: () => ({ ...now }),
    display: { publish: (snapshot) => { published.push(snapshot); } }, ...options });
  return { root, published, now, clock: () => ({ ...now }) };
}

function probe(root: RuntimeCompositionRoot, clock: ClockReading) {
  return root.dispatch(root.state, { kind: "notificationProbeCompleted", channels: testNotificationChannels, clock });
}

function parse(root: RuntimeCompositionRoot, material: DecodedMaterial, clock: ClockReading) {
  return root.dispatch(root.state, received(root.state.runId, material, clock));
}

async function save(root: RuntimeCompositionRoot, unit: RuntimeUnitId, inputIds: readonly string[], clock: () => ClockReading) {
  const retryReason = root.checkpoint.retryReason(unit);
  const scheduled = root.scheduleCheckpoint(root.state, clock(), root.state.runId, { [unit]: { inputIds, retryReason } });
  if (scheduled?.request == null) throw new Error(`${unit} checkpoint was not captured`);
  const executed = await root.executeCheckpoint(scheduled.request, root.state.runId, inputIds, retryReason);
  return root.applyCheckpointResult(root.state, executed.result, clock());
}

function failingFileSystem(message: string) {
  const files = nodeCheckpointFileSystem();
  const control = { fail: false };
  return { control, checkpointFileSystem: { ...files,
    open: (path: string) => control.fail ? Promise.reject(new Error(message)) : files.open(path) } };
}

type Stream = { snapshots: DisplaySnapshot[] };
function events(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/events", agent: false }, (response) => {
      const stream: Stream = { snapshots: [] };
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("event: snapshot")) stream.snapshots.push(JSON.parse(frame.split("\n")[2].slice("data: ".length)));
        }
      });
      response.on("error", () => {});
      resolve(stream);
    }).on("error", reject);
  });
}

function fetchJson<Body>(port: number, path: string): Promise<{ status: number; body: Body }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 5_000) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("P2-A3-A8-LINK composition root display wiring", () => {
  it("A acceptance / AC10: startRuntime publishes one three-domain checking snapshot before probe, a new stream per start", async () => {
    const settings = await config();
    const streams = [];
    for (let start = 0; start < 2; start++) {
      const { root, published, clock } = harness(settings, EEW_AT);
      root.startRuntime(`run-${start}`, clock(), testNotificationChannels);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ sequence: 1, channels: { desktop: "checking", sound: "checking" },
        current: { eew: { delivery: "full" }, weatherCurrent: { delivery: "full" }, weatherTimeseries: { delivery: "full" } } });
      probe(root, clock());
      expect(published.map((snapshot) => [snapshot.sequence, snapshot.channels.desktop])).toEqual([[1, "checking"], [2, "available"]]);
      streams.push(published[0].streamId);
    }
    expect(streams[0]).not.toBe(streams[1]);
  });

  it("B acceptance / P2-A8-NOTICE.ttl: a real VXSE43 notice expires by the reserved tick without input", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, published, now, clock } = harness(await config(), EEW_AT);
    root.startRuntime("run", clock(), testNotificationChannels);
    probe(root, clock());
    parse(root, decode("37_01_01_240613_VXSE43", "VXSE43"), clock());
    expect(published.at(-1)!.notices).toMatchObject([{ kind: "eewNew", expiresAt: EEW_AT + 15_000 }]);
    const count = published.length;
    now.wallTimeMs = EEW_AT + 14_999;
    vi.advanceTimersByTime(14_999);
    expect(published).toHaveLength(count);
    now.wallTimeMs = EEW_AT + 15_000;
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(count + 1);
    expect(published.at(-1)!.notices).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("B acceptance / P2-A8-NOTICE.invalidate: a real 取消 retires the notice before expiry and drops the reservation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, published, clock } = harness(await config(), EEW_AT);
    root.startRuntime("run", clock(), testNotificationChannels);
    probe(root, clock());
    parse(root, decode("37_01_01_240613_VXSE43", "VXSE43"), clock());
    expect(vi.getTimerCount()).toBe(1);
    parse(root, decode("37_01_03_240613_VXSE43", "VXSE43"), clock());
    expect(published.at(-1)!.notices).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("C acceptance / P2-A8-PUBLICATION: an initial rejection keeps nothing published until the first valid step (sequence 1)", async () => {
    const { root, published, clock } = harness(await config(), EEW_AT);
    root.startRuntime("run", { wallTimeMs: 0.5, monotonicMs: 1 }, testNotificationChannels);
    expect(published).toEqual([]);
    probe(root, clock());
    expect(published.map((snapshot) => snapshot.sequence)).toEqual([1]);
  });

  it("C acceptance / P2-A8-PUBLICATION: consecutive rejections hold sequence and their adopted state reaches the next publication", async () => {
    // Via the root only an invalid clock rejects, and it also blocks notice creation (P2-A8-NOTICE.clock).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, published, clock } = harness(await config(), EEW_AT);
    root.startRuntime("run", clock(), testNotificationChannels);
    probe(root, clock());
    parse(root, decode("37_01_01_240613_VXSE43", "VXSE43"), clock());
    const held = published.at(-1)!;
    const invalid = { wallTimeMs: EEW_AT + 500.5, monotonicMs: 1 };
    parse(root, eewReport("20240417231455"), invalid);
    root.tick(root.state, invalid);
    expect(published.at(-1)).toBe(held);
    root.tick(root.state, { wallTimeMs: EEW_AT + 1_000, monotonicMs: 1 });
    const recovered = published.at(-1)!;
    expect(recovered.sequence).toBe(held.sequence + 1);
    // The second event exists only in the rejected step's state; the first notice keeps its expiry.
    expect(recovered.current.eew.items[0].activeCount).toBe(2);
    expect(recovered.notices.map((item) => [item.kind, item.expiresAt])).toEqual([["eewNew", EEW_AT + 15_000]]);
  });

  it("D acceptance / AC04, 13.3: HTTP and SSE follow the root through save failure, normal shutdown and restart follow-up", async () => {
    const settings = await config();
    const files = failingFileSystem("injected write failure");
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0,
      worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } });
    servers.push(server);
    const first = harness(settings, 1_800_000_000_000, { checkpointFileSystem: files.checkpointFileSystem,
      display: { publish: server.publish, setWorker: server.setWorker } });
    first.root.startRuntime("run-1", first.clock(), testNotificationChannels);
    const startup = await fetchJson<DisplaySnapshot>(server.port, "/snapshot");
    expect(startup).toMatchObject({ status: 200, body: { sequence: 1, channels: { desktop: "checking" } } });
    const stream = await events(server.port);
    await until(() => stream.snapshots.length === 1);
    const report = decode("15_16_02_251222_VPWW57", "VPWW57");
    parse(first.root, report, first.clock());
    files.control.fail = true;
    await save(first.root, "U-W", [report.inputId], first.clock);
    files.control.fail = false;
    await until(() => stream.snapshots.at(-1)?.persistence["U-W"]?.kind === "failed");
    expect(stream.snapshots.at(-1)!.streamId).toBe(startup.body.streamId);
    expect(stream.snapshots.at(-1)!.current.weatherCurrent.items[0].activeCount).toBe(1);

    expect((await first.root.shutdownRuntime(first.root.state, 1, first.clock())).code).toBe(0);
    await until(() => stream.snapshots.at(-1)?.worker.state === "stopped");
    expect(stream.snapshots.at(-1)).toMatchObject({ connection: { state: "stopped" },
      persistence: { "U-W": { kind: "saved" } } });
    expect((await fetchJson<DisplaySnapshot>(server.port, "/snapshot")).body.sequence).toBe(stream.snapshots.at(-1)!.sequence);
    expect((await fetchJson<HealthResponse["body"]>(server.port, "/healthz")).body.worker).toBe("stopped");

    const second = harness(settings, 1_800_000_000_001, { checkpointFileSystem: files.checkpointFileSystem,
      display: { publish: server.publish } });
    second.root.startRuntime("run-2", second.clock(), testNotificationChannels);
    await until(() => stream.snapshots.at(-1)!.streamId !== startup.body.streamId);
    const restarted = stream.snapshots.at(-1)!;
    expect(restarted).toMatchObject({ sequence: 1, recovery: { "U-W": { kind: "restored" } } });
    const followUp = decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "follow-up");
    parse(second.root, followUp, second.clock());
    await until(() => stream.snapshots.at(-1)!.sequence === 2);
    expect(stream.snapshots.at(-1)).toMatchObject({ streamId: restarted.streamId,
      connection: { lastInputAt: 1_800_000_000_001 }, persistence: { "U-W": { kind: "pending" } } });
    expect(stream.snapshots.at(-1)!.semanticRevision).not.toBe(restarted.semanticRevision);
  });

  it("E acceptance / E01: one T3 per projected snapshot, before its T4; unchanged steps mark nothing", async () => {
    const markers: string[] = [];
    const mark = (point: string, sequence: number) => { markers.push(`${point}:${sequence}`); };
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0,
      worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      onMarker: (marker, version) => mark(marker.point, version.sequence) });
    servers.push(server);
    const { root, clock } = harness(await config(), EEW_AT, { display: { publish: server.publish,
      onMarker: (marker, version) => mark(marker.point, version.sequence) } });
    root.startRuntime("run", clock(), testNotificationChannels);
    const stream = await events(server.port);
    await until(() => stream.snapshots.length === 1);
    probe(root, clock());
    parse(root, decode("37_01_01_240613_VXSE43", "VXSE43"), clock());
    root.tick(root.state, clock());
    await until(() => stream.snapshots.length === 3);
    // Sequence 1 was published before the client connected; its T4 comes at connection.
    expect(markers).toEqual(["T3:1", "T4:1", "T3:2", "T4:2", "T3:3", "T4:3"]);
    // Shutdown clears the unref'd notice reservation so no tick runs after cleanup.
    await root.shutdownRuntime(root.state, 1, clock());
  });
});
