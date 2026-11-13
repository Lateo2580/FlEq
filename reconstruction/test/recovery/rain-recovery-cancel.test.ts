import { EventEmitter } from "node:events";
import { promises as fileSystem, readFileSync } from "node:fs";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { startP2Host } from "../../src/host/host";
import { createRenderer } from "../../src/terminal/format";
import { createTerminalOutput } from "../../src/terminal/output";

// P3-RAIN-RECOVERY-CANCEL-001 の試験。本物の host（取り直しを含む）と本物の端末をつなぎ、偽物は dmdata（WS と REST）だけにする。mock は recovery-host.test.ts と同じ形。
type Reply = Readonly<{ status: number; body?: unknown; raw?: Buffer; headers?: Readonly<Record<string, string>> }>;
const https = vi.hoisted(() => ({ handle: null as ((url: URL) => Reply) | null, paths: [] as string[], held: [] as (() => void)[] }));
vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { request: (options: RequestOptions, onResponse: (response: EventEmitter) => void) => {
    const outgoing = Object.assign(new Emitter(), { destroy: () => {}, end: () => {
      const url = new URL(`https://${options.hostname}${options.path}`);
      https.paths.push(url.pathname);
      const reply = https.handle!(url);
      outgoing.emit("finish");
      const respond = () => {
        const response = Object.assign(new Emitter(), { statusCode: reply.status, headers: reply.headers ?? {} });
        onResponse(response);
        if (reply.raw !== undefined) response.emit("data", reply.raw);
        if (reply.body !== undefined) response.emit("data", Buffer.from(JSON.stringify(reply.body)));
        response.emit("end");
        response.emit("close");
      };
      // T03 は本文の応答だけを止める（一覧は返し、候補を開かせる）。
      if (holdBody && url.hostname === "data.api.dmdata.jp") https.held.push(respond); else respond();
    } });
    return outgoing;
  } };
});
const socket = vi.hoisted(() => ({ url: "" }));
vi.mock("../../src/host/dmdata-rest", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/host/dmdata-rest")>(),
  listSockets: async () => ({ kind: "ok", sockets: [], date: null }),
  closeSocket: async () => ({ kind: "ok" }),
  startSocket: async () => ({ kind: "ok", id: 7, url: socket.url, protocol: [] }),
}));
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

const oaXml = readFileSync("test/fixtures/phase6b_VPOA50_JPTC202608211633_202608211633.xml", "utf8");
const EVENT_ID = "JPTC202608211633_202608211633";
const cancelOf = (reportTime: string, controlTime: string): string => oaXml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
  .replace("<ReportDateTime>2026-08-21T16:33:00+09:00</ReportDateTime>", `<ReportDateTime>2026-08-21T${reportTime}+09:00</ReportDateTime>`)
  .replace("<DateTime>2026-08-21T07:33:19Z</DateTime>", `<DateTime>2026-08-21T${controlTime}Z</DateTime>`);
const jst = (ms: number): string => new Date(ms + 32_400_000).toISOString().slice(11, 19);
// 壁時計は始めの wallStart から実時間で進む。端末の clock は skew だけ先へ進める（host の clock は進めない、Q-RRC-TEST）。
let wallStart = 0, base = 0, skew = 0, holdBody = false;
const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: wallStart + Math.trunc(monotonicMs - base), monotonicMs }; };
const terminalClock = () => { const now = clock(); return { wallTimeMs: now.wallTimeMs + skew, monotonicMs: now.monotonicMs + skew }; };
// 一覧の行: telegram-list-vtse41-real.json の 1 行目の種類・EventID・id・url・receivedTime を替える（receivedTime が古いと取得の下限で外れる）。
const real = JSON.parse(readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8")).items[0];
const listItem = (receivedAtMs: number) => {
  const id = "c".repeat(96);
  return { ...real, id, url: `https://data.api.dmdata.jp/v1/${id}`, receivedTime: new Date(receivedAtMs).toISOString(), head: { ...real.head, type: "VPOA50" },
    xmlReport: { ...real.xmlReport, head: { ...real.xmlReport.head, headline: "取消", eventId: EVENT_ID } } };
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  Object.assign(https, { handle: null, paths: [], held: [] });
  holdBody = false;
  skew = 0;
});
async function until(condition: () => boolean, milliseconds = 30_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 20));
  }
}
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, Math.max(0, milliseconds)));

// reconnect（T01）: 起動の取り直しの後に live の速報を受け、切断して、繋ぎ直しの取り直しの一覧に取消（発表は切断の次の秒）を載せる。
// stale（T03）: 起動の取り直しの一覧に live の報より古い取消（16:32:50）を載せ、本文の応答を止めた間に live の速報を受ける。
async function scenario(mode: "reconnect" | "stale") {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [], connectedAt: number[] = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    connectedAt.push(clock().wallTimeMs);
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "start", socketId: 7, classifications: ["telegram.weather"], time: new Date(clock().wallTimeMs).toISOString() }));
  });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  socket.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-rrc-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));

  // reconnect は速報を起動から約 47 秒（16:33:06 ごろ）に受けるよう始めを前に置く。
  base = performance.now();
  wallStart = Date.parse(mode === "reconnect" ? "2026-08-21T16:32:19+09:00" : "2026-08-21T16:33:05+09:00");
  const startedAt = clock().wallTimeMs;
  // 取消の発表は観測した切断の次の秒（ReportDateTime は秒まで）。繋ぎ直しは切断から 5 秒（host の RECONNECT_MS）なので、その前に入る。
  let cutAt: number | null = null, cancelAt: number | null = null;
  https.handle = (url) => {
    if (url.hostname === "data.api.dmdata.jp") {
      const cancelXml = mode === "reconnect" ? cancelOf(jst(cancelAt!), "07:33:20") : cancelOf("16:32:50", "07:33:10");
      return { status: 200, raw: Buffer.from(cancelXml), headers: { "content-type": "application/xml" } };
    }
    const rain = url.searchParams.get("type")?.split(",").includes("VPOA50") === true;
    const items = !rain ? [] : mode === "stale" ? [listItem(startedAt + 2_000)] : cancelAt != null ? [listItem(cancelAt + 1_000)] : [];
    return { status: 200, body: { status: "ok", items } };
  };
  holdBody = mode === "stale";
  const renderer = createRenderer(0), lines: string[] = [];
  const terminal = createTerminalOutput({ clock: terminalClock, debug: true, tipInterval: 0, notify: async () => {},
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns: 80 }).replace(/\n$/, "").split("\n")); done(); } });
  cleanups.push(() => terminal.close());
  const host = await startP2Host({ dmdata: { apiKey: "KEY-RRC", appName: "fleq-rrc", classifications: ["telegram.weather"] },
    stateDirectory: join(path, "state"), diagnosticDirectory: join(path, "diagnostics"), displayPort: null, clock, observe: null, terminal: terminal.sink });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  // tick は時計を読んでから host.status() を同期で呼び、続けて expire と writer まで進む。skew を変えた後の呼び出しを待てば次の tick は終わっている。
  let statusCalls = 0;
  terminal.attach({ status: () => { statusCalls += 1; return host.status(); } });
  // 取り直しの採用の返信を控える（判定は product のまま）。
  const adopted: { unit: unknown; reply: { result: { kind: string } } }[] = [];
  const root = roots.root! as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = root.recoveryAdopted.bind(root);
  root.recoveryAdopted = (run: unknown, unit: unknown, reply: unknown, outcome: unknown) => {
    adopted.push({ unit, reply: reply as { result: { kind: string } } }); return original(run, unit, reply, outcome); };
  const ubAdopted = () => adopted.filter((item) => item.unit === "U-B");
  if (mode === "stale") await until(() => sockets.length === 1 && https.held.length === 1); // 本文の要求が来た = U-B の候補が開いた後
  else {
    await until(() => sockets.length === 1 && roots.root!["recoveryNotBefore"] > -Infinity);
    // 次の取り直しの許しの 15 秒前に受け、採用が端末の 60 秒の内に終わる位置に置く。
    await sleep((roots.root!["recoveryNotBefore"] as number) - 15_000 - performance.now());
  }
  const ubBefore = ubAdopted().length;

  const receivedAtWall = clock().wallTimeMs;
  sockets[0].send(JSON.stringify({ type: "data", version: "2.0", classification: "telegram.weather", id: "a".repeat(96), format: "xml", encoding: "utf-8", compression: null,
    head: { type: "VPOA50", author: "JMA", time: new Date(clock().wallTimeMs).toISOString(), test: false, xml: true }, xmlReport: { control: { status: "通常" } }, body: oaXml }));
  await until(() => lines.some((line) => line.startsWith("debug: VPOA50") && line.includes("対応報を待つ")));
  const heldAtMono = performance.now();
  if (mode === "stale") {
    holdBody = false;
    for (const respond of https.held.splice(0)) respond();
    await until(() => ubAdopted().length > ubBefore);
  } else {
    cutAt = clock().wallTimeMs;
    cancelAt = Math.floor(cutAt / 1_000) * 1_000 + 1_000;
    sockets[0].terminate();
    await until(() => sockets.length === 2);
    await until(() => ubAdopted().length > ubBefore, 50_000);
  }
  const adoptedAtMono = performance.now(), adoptedAtWall = clock().wallTimeMs;
  // 端末の clock だけを 61 秒進め、次の tick（1 秒ごと）を待つ。
  const calls = statusCalls;
  skew = 61_000;
  await until(() => statusCalls > calls);
  const shown = lines.filter((line) => !line.startsWith("debug: ") && line.includes("記録的短時間大雨"));
  // 停止の保存で書かれた U-B の state（世代の最も新しい file）から、この subject の記録を読む（owner は worker の中）。
  await host.stop().catch(() => {});
  const stateDir = join(path, "state");
  type Saved = { generation: number; payload: { currents: { subject: string; effective: string; source: { origin: string; infoTypeRaw: string } }[] } };
  const saved: Saved[] = [];
  for (const name of (await fileSystem.readdir(stateDir)).filter((item) => item.startsWith("U-B-"))) saved.push(JSON.parse(await fileSystem.readFile(join(stateDir, name), "utf8")) as Saved);
  const record = saved.sort((a, b) => b.generation - a.generation)[0]?.payload.currents.find((item) => item.subject === `normal/VPOA50/${EVENT_ID}`);
  return { order: [receivedAtWall, cutAt, cancelAt, connectedAt[1], adoptedAtWall], fetched: https.paths.filter((item) => item.startsWith("/v1/")),
    adoptedKinds: ubAdopted().slice(ubBefore).map((item) => item.reply.result.kind), adoptedBeforeDue: adoptedAtMono - heldAtMono < 60_000,
    savedRecord: record == null ? null : [record.effective, record.source.origin, record.source.infoTypeRaw], shown };
}

// P3-RRC-T01 acceptance / P3-RRC-AC01
it("T01 切断の間の取消を繋ぎ直しの取り直しで採ったら、端末の 60 秒の後も取り消された速報は出ない", async () => {
  const result = await scenario("reconnect");
  const [received, cut, cancel, reconnected, adopted] = result.order as number[];
  expect([received < cut, cut < cancel, cancel < reconnected, reconnected < adopted]).toEqual([true, true, true, true]); // 受信 < 切断 < 取消の発表 < 繋ぎ直し < 採用
  expect([result.fetched, result.adoptedKinds, result.adoptedBeforeDue, result.savedRecord])
    .toEqual([[`/v1/${"c".repeat(96)}`], ["adopted"], true, ["cancelled", "recovery", "取消"]]);
  expect(result.shown).toEqual([]);
}, 150_000);

// P3-RRC-T03 contractBoundary / P3-RRC-AC03 (3)
it("T03 開いた後に live の速報が入り、当て直しで古い取消が stale になったら、待ちは外れず 60 秒の後に速報が出る", async () => {
  const result = await scenario("stale");
  expect([result.fetched, result.adoptedKinds, result.adoptedBeforeDue]).toEqual([[`/v1/${"c".repeat(96)}`], ["adopted"], true]);
  expect(["held", "released"]).toContain(result.savedRecord?.[0]);
  expect(result.savedRecord?.slice(1)).toEqual(["live", "発表"]);
  expect([result.shown.filter((line) => line.startsWith("━")).length, result.shown.length]).toEqual([1, 2]); // 帯 1 つと本文 1 行
}, 150_000);
