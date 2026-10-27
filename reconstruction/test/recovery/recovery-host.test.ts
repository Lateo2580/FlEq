import { EventEmitter } from "node:events";
import { promises as fileSystem, readFileSync } from "node:fs";
import { get } from "node:http";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import { startP2Host } from "../../src/host/host";

// 一覧の要求だけが node:https へ来る（socket の 3 呼出しは下の mock が答える）。網へは出ない。
type Reply = Readonly<{ status: number; body?: unknown }>;
// hold: 応答を held に溜めて試験が後で返す（停止の後に揃う結果の試験）。
const https = vi.hoisted(() => ({ handle: null as ((url: URL) => Reply) | null, paths: [] as string[], hold: false, held: [] as (() => void)[], destroyed: 0 }));
vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { request: (options: RequestOptions, onResponse: (response: EventEmitter) => void) => {
    const outgoing = Object.assign(new Emitter(), { destroy: () => { https.destroyed += 1; }, end: () => {
      const url = new URL(`https://${options.hostname}${options.path}`);
      https.paths.push(url.pathname);
      const reply = https.handle!(url);
      outgoing.emit("finish");
      const respond = () => {
        const response = Object.assign(new Emitter(), { statusCode: reply.status, headers: {} });
        onResponse(response);
        if (reply.body !== undefined) response.emit("data", Buffer.from(JSON.stringify(reply.body)));
        response.emit("end");
        response.emit("close");
      };
      if (https.hold) https.held.push(respond); else respond();
    } });
    return outgoing;
  } };
});
const socket = vi.hoisted(() => ({ url: "", starts: 0, deleteAborted: null as boolean | null }));
vi.mock("../../src/host/dmdata-rest", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/host/dmdata-rest")>(),
  listSockets: async () => ({ kind: "ok", sockets: [], date: null }),
  closeSocket: async (_apiKey: string, _id: number, signal?: AbortSignal) => { socket.deleteAborted = signal?.aborted ?? false; return { kind: "ok" }; },
  startSocket: async () => { socket.starts += 1; return { kind: "ok", id: 7, url: socket.url, protocol: [] }; },
}));
// mailbox の受理の数を読むために root を控える（判定は product のまま）。
const roots = vi.hoisted(() => ({ root: null as import("../../src/runtime/composition-root").RuntimeCompositionRoot | null }));
vi.mock("../../src/runtime/composition-root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runtime/composition-root")>();
  class RuntimeCompositionRoot extends actual.RuntimeCompositionRoot {
    constructor(...args: ConstructorParameters<typeof actual.RuntimeCompositionRoot>) { super(...args); roots.root = this; }
  }
  return { ...actual, RuntimeCompositionRoot };
});
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const API_KEY = "KEY-SECRET-REC-HOST";
const EEW_AT = 1_713_363_299_001; // 37_01_01 VXSE43 ReportDateTime + 1 ms
const base = performance.now();
const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: EEW_AT + Math.trunc(monotonicMs - base), monotonicMs }; };
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const real = JSON.parse(readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8")).items[0];
const vxse43 = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
let serial = 0;
function item(type: string, receivedAtMs: number, headline: string) {
  return { ...real, id: (++serial).toString(16).padStart(96, "0"), receivedTime: new Date(receivedAtMs).toISOString(),
    head: { ...real.head, type }, xmlReport: { ...real.xmlReport, head: { ...real.xmlReport.head, headline } } };
}
const page = (items: readonly unknown[], nextToken?: string): Reply =>
  ({ status: 200, body: { status: "ok", items, ...(nextToken == null ? {} : { nextToken }) } });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  https.handle = null;
  https.paths.length = 0;
  Object.assign(https, { hold: false, held: [], destroyed: 0 });
  Object.assign(socket, { url: "", starts: 0, deleteAborted: null });
});

async function until(condition: () => boolean | Promise<boolean>, milliseconds = 20_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!(await condition())) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function snapshot(port: number): Promise<DisplaySnapshot> {
  return new Promise((resolveBody, reject) => {
    get({ host: "127.0.0.1", port, path: "/snapshot", agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolveBody(JSON.parse(body)));
    }).on("error", reject);
  });
}

async function start(classifications: readonly DmdataClassification[]) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "start", socketId: 7, classifications, time: new Date(clock().wallTimeMs).toISOString() }));
  });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  socket.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-rec-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  const dirs = { stateDirectory: join(path, "state"), diagnosticDirectory: join(path, "diagnostics") };
  const host = await startP2Host({ dmdata: { apiKey: API_KEY, appName: "fleq-rec-test", classifications }, ...dirs,
    displayPort: 0, clock, observe: null });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  await until(() => sockets.length === 1);
  return { host, sockets, dirs };
}

async function diagnostics(dir: string): Promise<string> {
  const names = await fileSystem.readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(names.map((name) => fileSystem.readFile(join(dir, name), "utf8")))).join("");
}
const liveEew = () => JSON.stringify({ type: "data", version: "2.0", classification: "eew.forecast", id: "id", format: "xml",
  encoding: "utf-8", compression: null, head: { type: "VXSE43", author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
  xmlReport: { control: { status: "通常" } }, body: vxse43 });

describe("P3-REC-T08 acceptance: the startup digest reaches the snapshot (AC15, AC04)", () => {
  it("heads after the start, overflow by type within 16,384 bytes, a failed unit without a count; no mailbox input; live goes on", async () => {
    const startedAt = clock().wallTimeMs;
    https.handle = (url) => {
      const types = url.searchParams.get("type"), cursor = Number(url.searchParams.get("cursorToken") ?? "0");
      if (types === "VTSE41,VTSE51,VTSE52") {
        // 600 件（RES-04 を超える）。見出しは 256 byte を超える。最後のページは nextToken が無い。
        const items = Array.from({ length: 100 }, (_, index) => item(index % 2 === 0 ? "VTSE41" : "VTSE51",
          startedAt - (cursor * 100 + index) * MINUTE, "津波".repeat(100)));
        return page(items, cursor < 5 ? String(cursor + 1) : undefined);
      }
      if (types === "VXSE51,VXSE52,VXSE53,VXSE61,VXSE62") return { status: 500 };
      if (types === "VXSE56,VXSE60,VZSE40") return page([item("VXSE56", startedAt - DAY, "長周期"), item("VXSE60", startedAt - 8 * DAY, "古い")], "x");
      return page([]);
    };
    const { host, sockets, dirs } = await start(["telegram.earthquake", "eew.forecast"]);
    await until(async () => (await snapshot(host.displayPort)).recovery.digest != null);
    const first = await snapshot(host.displayPort);
    const digest = first.recovery.digest!;
    expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThanOrEqual(16_384);
    expect(digest.units.map((unit) => [unit.unit, unit.kind, unit.beforeWindow])).toEqual([["U-T", "listed", true],
      ["U-Q", "unsatisfied", true], ["U-N", "listed", true], ["U-M", "listed", true]]);
    const [tsunami, seismic, nankai, local] = digest.units;
    if (tsunami.kind !== "listed" || nankai.kind !== "listed" || local.kind !== "listed") throw new Error("listed units expected");
    expect(tsunami.heads.length).toBeGreaterThan(0);
    expect(tsunami.heads.map((head) => head.receivedAt)).toEqual(tsunami.heads.map((_, index) => startedAt - index * MINUTE));
    expect(tsunami.heads[0].headline).toMatch(/\[truncated:fieldLimit\]$/);
    expect(tsunami.heads.length + Object.values(tsunami.omitted).reduce((sum, count) => sum + count, 0)).toBe(600);
    // U-Q は理由だけで件数を持たない（件数不明）。U-M は 7 日より前の item で止まり、見出しは枠の外なので件数だけ。
    expect(seismic).toEqual({ unit: "U-Q", beforeWindow: true, kind: "unsatisfied", reason: "fetchFailed" });
    expect([nankai.heads, nankai.omitted, local.heads, local.omitted]).toEqual([[], {}, [], { VXSE56: 1 }]);
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes("recoveryFetchFailed"));
    const lines = (await diagnostics(dirs.diagnosticDirectory)).split("\n").filter((line) => line.includes('"component":"recovery"'));
    expect(lines.map((line) => JSON.parse(line)).map(({ level, reason, unit }) => ({ level, reason, unit })))
      .toEqual([{ level: "WARN", reason: "recoveryFetchFailed", unit: "U-Q" }]);
    expect(await diagnostics(dirs.diagnosticDirectory)).not.toContain("SECRET");
    expect(https.paths.every((path) => path === "/v2/telegram")).toBe(true);
    // 一覧の頭は mailbox へ入れない。live の返信の採用で snapshot は公開され続ける。
    expect(roots.root!.mailbox.stats(clock().monotonicMs).accepted).toBe(0);
    sockets[0].send(liveEew());
    await until(async () => (await snapshot(host.displayPort)).current.eew.items[0].activeCount > 0);
    const after = await snapshot(host.displayPort);
    expect(after.sequence).toBeGreaterThan(first.sequence);
    expect(after.recovery.digest).toEqual(digest);
    expect(roots.root!.mailbox.stats(clock().monotonicMs).accepted).toBe(1);
  });
});

describe("P3-REC-T01 contractBoundary (host side): a list 401/403 does not reach the connection (AC03 (3))", () => {
  it("every unit is authRejected, one recoveryAuthRejected, no dmdataAuthRejected; the WebSocket stays and live is received", async () => {
    https.handle = () => ({ status: 403 });
    const { host, sockets, dirs } = await start(["telegram.volcano", "eew.forecast"]);
    await until(async () => (await snapshot(host.displayPort)).recovery.digest != null);
    expect((await snapshot(host.displayPort)).recovery.digest!.units.map((unit) => [unit.unit, unit.kind === "unsatisfied" && unit.reason]))
      .toEqual([["U-V", "authRejected"]]);
    expect(https.paths).toHaveLength(1);
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes("recoveryAuthRejected"));
    const text = await diagnostics(dirs.diagnosticDirectory);
    expect([text.split("recoveryAuthRejected").length - 1, text.includes("dmdataAuthRejected")]).toEqual([1, false]);
    sockets[0].send(liveEew());
    await until(async () => (await snapshot(host.displayPort)).current.eew.items[0].activeCount > 0);
    expect([socket.starts, sockets.length, (await snapshot(host.displayPort)).connection.state]).toEqual([1, 1, "connected"]);
  });
});

describe("P3-REC-T01 contractBoundary (host side): stop ends the walk (AC03 (6))", () => {
  it("a list answered after the stop request publishes no digest; the own socket DELETE is not aborted", async () => {
    https.hold = true;
    https.handle = () => page([]);
    const { host } = await start(["telegram.volcano"]);
    await until(() => https.held.length === 1);
    const shown = vi.spyOn(roots.root!, "showRecoveryDigest");
    await host.stop();
    expect(https.destroyed).toBe(1);
    // 停止の後に揃った応答は、歩き専用の signal で壊した要求に届くだけで、公開に至らない。
    for (const respond of https.held.splice(0)) respond();
    await new Promise((done) => setTimeout(done, 600));
    expect([https.paths.length, shown.mock.calls.length, socket.deleteAborted]).toEqual([1, 0, false]);
  });
});
