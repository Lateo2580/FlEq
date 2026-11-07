import { promises as fileSystem, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { startP2Host } from "../../src/host/host";
import { createTerminalOutput } from "../../src/terminal/output";

// 本物の通知を出さない（tsunami-host.test.ts と同じ）。
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const BASE_AT = Date.parse("2011-03-11T14:49:01+09:00");
const base = performance.now();
const clock = () => ({ wallTimeMs: BASE_AT + Math.trunc(performance.now() - base), monotonicMs: performance.now() });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(condition: () => boolean, milliseconds = 15_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}
const frame = (headType: string, body: string): string => JSON.stringify({ type: "data", version: "2.0", classification: "telegram.earthquake", id: "id", format: "xml", encoding: "utf-8",
  compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true }, xmlReport: { control: { status: "通常" } }, body });

describe("P3-TP-T09 受入条件 本物の経路", () => {
  it("root の project から host の sink を通って promptLabel の字に載り、取消で消える", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((done) => wss.once("listening", done));
    const sockets: WebSocket[] = [];
    wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
    cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
    const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-tp-host-"));
    cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
    const output = createTerminalOutput({ tipInterval: 0, clock, write: (_batch, done) => { done(); } });
    cleanups.push(() => output.close());
    const host = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, stateDirectory: join(path, "state"),
      diagnosticDirectory: join(path, "diagnostics"), displayPort: null, clock, observe: null, terminal: output.sink });
    cleanups.push(() => host.stop().then(() => {}, () => {}));
    output.attach(host);
    await until(() => sockets.length === 1);
    const label = () => output.control.promptLabel("clock");
    expect(label()).not.toContain("大津波警報");
    sockets[0].send(frame("VTSE41", readFileSync("test/fixtures/32-39_11_02_250206_VTSE41.xml", "utf8")));
    await until(() => label().includes("大津波警報"));
    sockets[0].send(frame("VTSE41", readFileSync("test/fixtures/synthetic_VTSE41_cancel.xml", "utf8")));
    await until(() => !label().includes("大津波警報"));
    expect(label()).toMatch(/^FlEq \[[●○] \d\d:\d\d:\d\d\]> $/);
  }, 30_000);
});
