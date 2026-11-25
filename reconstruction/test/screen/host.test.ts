import { promises as fileSystem, readFileSync } from "node:fs";
import { ServerResponse, get } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";

// T09 契約境界（P4-DS-AC02・AC01）: host の配線。表示の包みの外（dmdata の REST・通知の backend）は止める。
// 作者の本物の設定と保存を読み書きしないため、XDG_CONFIG_HOME と保存・診断の dir は一時の dir、表示の port は 0。
const owners = vi.hoisted(() => ({ live: new Set<{ terminate(): Promise<number> }>() }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      owners.live.add(this);
      this.once("exit", () => { owners.live.delete(this); });
    }
  }
  return { ...actual, Worker };
});
vi.mock("../../src/host/dmdata-rest", () => ({
  listSockets: () => Promise.resolve({ kind: "failed" }), closeSocket: () => Promise.resolve({ kind: "failed" }), startSocket: () => Promise.resolve({ kind: "failed" }),
}));
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }), probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

// 停止の完了の前に shutdownRuntime が投げる形を作る（finally の closeDisplay が close の前に保留を書くことを見る）
const failing = vi.hoisted(() => ({ shutdown: false }));
// root が host の publishWire を呼んだ記録（保留される通常の版と急ぎの版を、公開の側から見分けるため）
const wireCalls = vi.hoisted(() => ({ list: [] as { sequence: number; urgent: boolean; at: number; weather: string; eew: string }[] }));
vi.mock("../../src/runtime/composition-root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runtime/composition-root")>();
  class RuntimeCompositionRoot extends actual.RuntimeCompositionRoot {
    constructor(...args: ConstructorParameters<typeof actual.RuntimeCompositionRoot>) {
      super(...args);
      type Wire = { sequence: number; current: { weatherCurrent: { contentRevision: string }; eew: { contentRevision: string } } };
      const display = args[2].display as { publishWire?: (snapshot: Wire, urgent: boolean) => void } | undefined;
      const original = display?.publishWire;
      if (display != null && original != null) display.publishWire = (snapshot, urgent) => { wireCalls.list.push({ sequence: snapshot.sequence, urgent, at: performance.now(), weather: snapshot.current.weatherCurrent.contentRevision, eew: snapshot.current.eew.contentRevision }); original(snapshot, urgent); };
    }
    override shutdownRuntime(...args: Parameters<InstanceType<typeof actual.RuntimeCompositionRoot>["shutdownRuntime"]>) {
      if (failing.shutdown) return Promise.reject(new Error("shutdown threw before completion"));
      return super.shutdownRuntime(...args);
    }
  }
  return { ...actual, RuntimeCompositionRoot };
});

// host の時計は VPWS50 の発表の 1 分後から進める。VXSE45 は発表の時刻をその 30 秒後に寄せる（古い報は表に出ず、公開が起きない）
const NOW_AT = Date.parse("2019-10-12T09:10:00+09:00");
const base = performance.now();
const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: NOW_AT + Math.trunc(monotonicMs - base), monotonicMs }; };
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const shifted = (xml: string, deltaMs: number) => xml.replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|\+09:00)/g, (whole) => {
  const at = Date.parse(whole) + deltaMs;
  return whole.endsWith("Z") ? new Date(at).toISOString().replace(".000Z", "Z") : iso(at);
});
const eewXml = () => shifted(text("77_01_01_240613_VXSE45"), Date.parse("2019-10-12T09:09:30+09:00") - Date.parse("2024-04-17T23:14:57+09:00"));
const cleanups: (() => Promise<void> | void)[] = [];
const savedConfig = process.env.XDG_CONFIG_HOME;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(() => owners.live.size === 0);
  failing.shutdown = false;
  wireCalls.list.length = 0;
  if (savedConfig == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
});
async function until(condition: () => boolean, milliseconds = 15_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const frame = (headType: string, classification: string, body: string) => JSON.stringify({ type: "data", version: "2.0", classification, id: "id", format: "xml",
  encoding: "utf-8", compression: null, head: { type: headType, author: "JMA", time: "2024-04-17T14:14:59Z", test: false, xml: true },
  xmlReport: { control: { status: "通常" } }, body });

async function boot() {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-s0-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = join(path, "config");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  const observations: P2HostObservation[] = [];
  const host = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, stateDirectory: join(path, "state"),
    diagnosticDirectory: join(path, "diagnostics"), displayPort: 0, clock, observe: (item) => { observations.push(item); } });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  await until(() => sockets.length === 1);
  return { host, sockets, observations, port: host.displayPort as number };
}

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => done({ status: response.statusCode ?? 0, body }));
    }).on("error", fail);
  });
}

type Received = { at: number; sequence: number; data: Record<string, unknown> };
function listen(port: number): { events: Received[]; closed: () => boolean; destroy: () => void } {
  const events: Received[] = [];
  let closed = false, buffer = "";
  const call = get({ host: "127.0.0.1", port, path: "/api/display/wire/events", agent: false }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data != null && /^event: snapshot$/m.test(block)) { const parsed = JSON.parse(data); events.push({ at: performance.now(), sequence: parsed.sequence, data: parsed }); }
      }
    });
    response.on("close", () => { closed = true; });
  });
  call.on("error", () => { closed = true; });
  cleanups.push(() => { call.destroy(); });
  return { events, closed: () => closed, destroy: () => call.destroy() };
}
// 次の公開を待つ。held は保留される通常の版（最初の 1 つ）、urgent は急ぎの版
// content は、VPWS50 の気象の中身（内容版が 0 から進んだ版）を持つ公開だけを待つ
async function nextCall(kind: "held" | "urgent", after: number, content = false) {
  const match = (call: (typeof wireCalls.list)[number]) => call.urgent === (kind === "urgent") && (!content || Number(call.weather) > 0);
  await until(() => wireCalls.list.slice(after).some(match));
  return wireCalls.list.slice(after).find(match)!;
}
const sendHeld = (sockets: WebSocket[]) => sockets[0].send(frame("VPWS50", "telegram.weather", text("15_18_01_250630_VPWS50")));
const sendUrgent = (sockets: WebSocket[]) => sockets[0].send(frame("VXSE45", "eew.forecast", eewXml()));

describe("P4-DS-T09 host の配線", () => {
  it("(a) /display は screen の html、/display/main.js は dist の main.js、/ は chrome-eew のまま", async () => {
    const { port } = await boot();
    const display = await request(port, "/display");
    expect(display.body).toBe(readFileSync("reconstruction/src/display/screen/index.html", "utf8"));
    expect((await request(port, "/display/main.js")).body).toBe(readFileSync("reconstruction/dist/screen/src/display/screen/main.js", "utf8"));
    expect((await request(port, "/")).body).toBe(readFileSync("reconstruction/src/display/chrome-eew/index.html", "utf8"));
  });

  it("(b) 通常の版が保留される間に急ぎの版が来ると、保留の分を含む急ぎの版が最初の保留の期限より前に 1 回だけ届く", async () => {
    const { sockets, port } = await boot();
    const wire = listen(port);
    const start = wireCalls.list.length;
    sendHeld(sockets);
    const holdStart = await nextCall("held", start);
    const held = await nextCall("held", start, true);
    sendUrgent(sockets);
    const urgent = await nextCall("urgent", start);
    await until(() => wire.events.length >= 1);
    await new Promise((done) => setTimeout(done, 200));
    // 接続の時に届く既公開の版の再送（held より前の版）は試験の対象の外。held の版以降で、最初の保留の期限より前に届いた版を見る
    const inWindow = wire.events.filter((event) => event.sequence >= held.sequence && event.at < holdStart.at + 900);
    expect(inWindow.map((event) => event.sequence)).toEqual([urgent.sequence]);
    expect(urgent.sequence).toBeGreaterThan(held.sequence);
    // VPWS50 固有の気象の中身（内容版が最初の 0 から進んだ分）が、急ぎの版に残っている
    const current = inWindow[0].data.current as { weatherCurrent: { contentRevision: string }; eew: { contentRevision: string } };
    expect(Number(held.weather)).toBeGreaterThan(0);
    expect(current.weatherCurrent.contentRevision).toBe(held.weather);
    expect(current.eew.contentRevision).toBe(urgent.eew);
    expect(Number(urgent.eew)).toBeGreaterThan(0);
  }, 60_000);

  it("(c) 表示を閉じて開き直すと、次の電文を待たずに最後の 1 枚が届く", async () => {
    const { host, sockets, port } = await boot();
    const first = listen(port);
    const start = wireCalls.list.length;
    sendUrgent(sockets);
    const urgent = await nextCall("urgent", start);
    await until(() => first.events.some((event) => event.sequence === urgent.sequence));
    expect(await host.closeDisplay()).toBe("closed");
    const reopened = await host.openDisplay(0);
    expect(reopened.kind).toBe("opened");
    const second = listen((reopened as { port: number }).port);
    const asked = performance.now();
    await until(() => second.events.length >= 1, 2_000);
    expect(second.events[0].sequence).toBeGreaterThanOrEqual(urgent.sequence);
    expect(second.events[0].at - asked).toBeLessThan(500);
  }, 60_000);

  // サーバーが書いた版と、response を壊した時を順に記録する（client に届く前。書いた直後の destroy で届かないことは契約の残存）
  function recordServerWrites() {
    const log: { kind: "write" | "destroy"; sequence: number; weather: string }[] = [];
    const write = ServerResponse.prototype.write, destroy = ServerResponse.prototype.destroy;
    vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (this: ServerResponse, ...args: Parameters<ServerResponse["write"]>) {
      const sequence = typeof args[0] === "string" ? /^event: snapshot\nid: (\d+)\n/.exec(args[0])?.[1] : undefined;
      const body = typeof args[0] === "string" ? /\ndata: (.*)\n\n$/s.exec(args[0])?.[1] : undefined;
      if (sequence != null) log.push({ kind: "write", sequence: Number(sequence), weather: body == null ? "" : JSON.parse(body).current.weatherCurrent.contentRevision });
      return write.apply(this, args);
    });
    vi.spyOn(ServerResponse.prototype, "destroy").mockImplementation(function (this: ServerResponse, ...args: Parameters<ServerResponse["destroy"]>) {
      log.push({ kind: "destroy", sequence: -1, weather: "" });
      return destroy.apply(this, args);
    });
    return log;
  }

  it("(d) closeDisplay・停止・停止の完了の前の例外のどれでも、close の前に保留の分を含む 1 通が書かれる", async () => {
    for (const how of ["closeDisplay", "stop", "stopThrows"] as const) {
      const { host, sockets, port } = await boot();
      const wire = listen(port);
      const log = recordServerWrites();
      const start = wireCalls.list.length;
      sendHeld(sockets);
      const held = await nextCall("held", start, true);
      expect(log.some((item) => item.kind === "write" && item.sequence >= held.sequence), how).toBe(false);
      if (how === "closeDisplay") await host.closeDisplay();
      else if (how === "stop") await host.stop();
      else { failing.shutdown = true; await host.stop().catch(() => {}); failing.shutdown = false; }
      const written = log.findIndex((item) => item.kind === "write" && item.sequence >= held.sequence);
      const destroyed = log.findIndex((item) => item.kind === "destroy");
      expect(written, how).toBeGreaterThanOrEqual(0);
      expect(written, how).toBeLessThan(destroyed);
      // 最後に書かれた版に、保留の中身（VPWS50 の気象の内容版）がある
      const lastWritten = log.slice(0, destroyed).filter((item) => item.kind === "write").at(-1);
      expect(Number(lastWritten?.weather), how).toBeGreaterThanOrEqual(Number(held.weather));
      expect(Number(held.weather), how).toBeGreaterThan(0);
      vi.restoreAllMocks();
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 90_000);
});
