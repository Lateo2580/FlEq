import { readFileSync, promises as fileSystem } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import { startP2Host } from "../../src/host/host";

// The product notification backends would pop a real notification and play a sound for every EEW.
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

type Step = { position: number; action: string; fixtureId: string | null; receivedAt: number | null; expectedRef: string };
type Sequence = { sequenceId: string; steps: Step[] };
type Fixture = { fixtureId: string; path: string; transport: { classification: string; headType: string } };
const corpus = (name: string) => JSON.parse(readFileSync(`reconstruction/tools/corpus/${name}.json`, "utf8"));
const sequences: Sequence[] = corpus("sequences").sequences;
const fixtures = new Map<string, Fixture>((corpus("manifest").fixtures as Fixture[]).map((f) => [f.fixtureId, f]));
const expectations: { expectedId: string; subjects: { subject: string; revision: { reportDateTimeRaw: string } }[] }[] = corpus("sequences").expectations;
const step = (sequenceId: string, position: number): Step =>
  sequences.find((s) => s.sequenceId === sequenceId)!.steps.find((s) => s.position === position)!;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fetchSnapshot = (port: number): Promise<DisplaySnapshot> => new Promise((done, fail) => {
  get({ host: "127.0.0.1", port, path: "/snapshot", agent: false }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { body += chunk; });
    response.on("end", () => done(JSON.parse(body)));
  }).on("error", fail);
});

// Replay the receive steps of one sequence, from the last restart up to the target, through the product path
// (local WS -> startP2Host -> snapshot), each with the step's own wall clock. Other actions (injectFailure, advanceClock, save) are not expressible on the host.
async function replayUpTo(sequenceId: string, position: number): Promise<DisplaySnapshot["current"]> {
  const steps = sequences.find((s) => s.sequenceId === sequenceId)!.steps.filter((s) => s.position <= position);
  const chain = steps.slice(steps.map((s) => s.action).lastIndexOf("restart") + 1).filter((s) => s.action === "receive");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  const dir = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a10-t05-"));
  cleanups.push(() => fileSystem.rm(dir, { recursive: true, force: true }));
  const started = performance.now();
  let wallOrigin = chain[0]!.receivedAt!;
  const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: wallOrigin + Math.trunc(monotonicMs - started), monotonicMs }; };
  const host = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, stateDirectory: join(dir, "state"),
    diagnosticDirectory: join(dir, "diagnostics"), displayPort: 0, clock, observe: null });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  let current: DisplaySnapshot["current"] = (await fetchSnapshot(host.displayPort)).current;
  for (const item of chain) {
    wallOrigin = item.receivedAt! - Math.trunc(performance.now() - started);
    const fixture = fixtures.get(item.fixtureId!)!;
    const { classification, headType } = fixture.transport;
    const before = JSON.stringify(current);
    sockets[0]!.send(JSON.stringify({ type: "data", version: "2.0", classification, id: fixture.fixtureId, format: "xml", encoding: "utf-8",
      compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
      xmlReport: { control: { status: "通常" } }, body: readFileSync(fixture.path, "utf8") }));
    const end = performance.now() + 20_000;
    for (;;) {
      const next = (await fetchSnapshot(host.displayPort)).current;
      if (JSON.stringify(next) !== before) { current = next; break; }
      if (performance.now() > end) throw new Error("replayed step never reached the snapshot");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return current;
}

describe("P2-A10-T05 O09/O10 P2 references through the product replay (AC10)", () => {
  // O10:82 is replayed after O10:77/79 only. Steps 78 (injectFailure) and 80/81 (advanceClock) are not expressible on the host and are skipped,
  // so expected:O10:82's "U-F retry wait is not inherited" (which depends on 78) is not checked here.
  it.each([["O09", 2, "weatherCurrent", "summary"], ["O09", 12, "eew", "full"], ["O10", 82, "weatherCurrent", "summary"]] as const)(
    "%s:%i reaches the snapshot through local WS -> host, after only the preceding receive steps of its sequence", async (sequenceId, position, key, delivery) => {
      const item = step(sequenceId, position);
      expect(item).toMatchObject({ action: "receive", expectedRef: `expected:${sequenceId}:${position}` });
      const domain = (await replayUpTo(sequenceId, position))[key];
      // O10:82 does not require display-active (sequences.json), so the adopted revision's report time is the common fixed row.
      const expected = expectations.find((e) => e.expectedId === item.expectedRef)!.subjects[0]!;
      expect(domain.items[0]).toMatchObject({ operation: "normal", updatedAt: Date.parse(expected.revision.reportDateTimeRaw) });
      // VPWS50 (1.3 MB) exceeds the snapshot budget, so the weather domain carries the summary row only and its subject is not visible.
      expect(domain.delivery).toBe(delivery);
      if (domain.delivery === "full") expect(JSON.stringify(domain.view)).toContain(`"subject":"${expected.subject}"`);
    }, 40_000);
});
