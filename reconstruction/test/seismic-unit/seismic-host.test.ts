import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as SenderWorker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";
import { vxse53 } from "./seismic-fixture";

// P3-C7-AC12（台帳 63、P3-C7-INTERFERENCE）: urgent で U-Q が足す最も長い非中断処理と、その最中に投入した EEW の待ち。Mac での報告用で、
// 正式 E01 ではない（U-Q 同居後の EEW の正式な再測定は spec:1129 の後半の P5 の最終構成と C22）。通常の試験からは走らせない。
// 投入側（dmdata の代わりの WS server）は別 thread に置き、publisher の thread が塞がっても投入の時刻がずれないようにする。
const owners = vi.hoisted(() => ({ live: new Set<{ terminate(): Promise<number> }>(),
  posted: [] as { place: string; kind: string; inputId: string | null; at: number }[],
  // urgent の返信が publisher の thread に届いた時刻（複製の復元の後）。inputDone は入力 ID で、deadlineDone は届いた順。
  arrivals: new Map<string, { at: number; decodeStarted: number; decodeEnded: number; raised: number | null }>(),
  deadlineDone: [] as number[],
  // urgent へ期限の要求を送った瞬間に呼ぶ（一括回収の最中に EEW を投入するため）。
  onUrgentDeadline: null as (() => void) | null }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    readonly place: string;
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      const data: unknown = args[1]?.workerData;
      this.place = data != null && typeof data === "object" && "place" in data && typeof data.place === "string" ? data.place : "unknown";
      owners.live.add(this);
      this.once("exit", () => { owners.live.delete(this); });
    }
    override postMessage(value: unknown, transfer?: Parameters<typeof actual.Worker.prototype.postMessage>[1]): void {
      const request = value != null && typeof value === "object" ? value : null;
      const kind = request != null && "kind" in request && typeof request.kind === "string" ? request.kind : "unknown";
      const envelope = request != null && "envelope" in request && request.envelope != null && typeof request.envelope === "object"
        && "messageId" in request.envelope && typeof request.envelope.messageId === "string" ? request.envelope.messageId : null;
      owners.posted.push({ place: this.place, kind, inputId: envelope, at: performance.now() });
      super.postMessage(value, transfer);
      if (this.place === "urgent" && kind === "deadline") owners.onUrgentDeadline?.();
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      const reply = args[0];
      if (event === "message" && this.place === "urgent" && reply != null && typeof reply === "object" && "kind" in reply) {
        if (reply.kind === "deadlineDone") owners.deadlineDone.push(performance.now());
        if (reply.kind === "inputDone" && "settlement" in reply && "decode" in reply && "generationRaisedMs" in reply) {
          const settlement = reply.settlement as { inputId: string };
          const decode = reply.decode as { startedMonotonicMs: number; endedMonotonicMs: number };
          owners.arrivals.set(settlement.inputId, { at: performance.now(), decodeStarted: decode.startedMonotonicMs,
            decodeEnded: decode.endedMonotonicMs, raised: reply.generationRaisedMs as number | null });
        }
      }
      return super.emit(event, ...args);
    }
  }
  return { ...actual, Worker };
});
vi.mock("../../src/host/dmdata-rest", () => ({
  listSockets: () => Promise.resolve({ kind: "failed" }), closeSocket: () => Promise.resolve({ kind: "failed" }),
  startSocket: () => Promise.resolve({ kind: "failed" }),
}));
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const BASE_AT = Date.parse("2026-07-28T16:40:00+09:00");
const base = performance.now();
const clock = () => ({ wallTimeMs: BASE_AT + Math.trunc(performance.now() - base), monotonicMs: performance.now() });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  owners.posted.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(() => owners.live.size === 0);
});
async function until(condition: () => boolean, milliseconds = 60_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setImmediate(done));
  }
}

// 別 thread の投入側: frame の列を続けて送り、送った瞬間の絶対時刻（timeOrigin＋now）を返す。
const SENDER = `
const { parentPort } = require("node:worker_threads");
const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
let socket = null;
wss.on("listening", () => parentPort.postMessage({ kind: "port", port: wss.address().port }));
wss.on("connection", (ws) => { socket = ws; ws.on("error", () => {}); parentPort.postMessage({ kind: "connected" }); });
parentPort.on("message", (message) => {
  if (message.kind === "send") {
    const at = [];
    for (const frame of message.frames) { at.push(performance.timeOrigin + performance.now()); socket.send(frame); }
    parentPort.postMessage({ kind: "sent", id: message.id, at });
  } else if (message.kind === "close") {
    for (const client of wss.clients) client.terminate();
    wss.close(() => process.exit(0));
  }
});`;
async function injector() {
  const worker = new SenderWorker(SENDER, { eval: true });
  const replies = new Map<number, (at: number[]) => void>();
  let port = 0, connected = false, id = 0;
  worker.on("message", (message: { kind: string; port?: number; id?: number; at?: number[] }) => {
    if (message.kind === "port") port = message.port ?? 0;
    if (message.kind === "connected") connected = true;
    if (message.kind === "sent" && message.id != null) replies.get(message.id)?.(message.at ?? []);
  });
  await until(() => port !== 0);
  cleanups.push(() => new Promise<void>((done) => { worker.once("exit", () => done()); worker.postMessage({ kind: "close" }); }));
  return {
    port, connected: () => connected,
    // 各 frame の投入時刻を publisher の performance.now() の基準で返す。
    send(frames: readonly string[]): Promise<number[]> {
      const key = ++id;
      return new Promise((done) => {
        replies.set(key, (at) => done(at.map((value) => value - performance.timeOrigin)));
        worker.postMessage({ kind: "send", id: key, frames });
      });
    },
  };
}
async function host(observations: P2HostObservation[]) {
  const sender = await injector();
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c7-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  const started = await startP2Host({ wsUrl: `ws://127.0.0.1:${sender.port}/`, stateDirectory: join(path, "state"),
    diagnosticDirectory: join(path, "diagnostics"), displayPort: 0, clock, observe: (item) => { observations.push(item); } });
  cleanups.push(() => started.stop().then(() => {}, () => {}));
  await until(() => sender.connected());
  return { sender, stop: started.stop };
}
function frame(headType: string, body: string): string {
  return JSON.stringify({ type: "data", version: "2.0", classification: "telegram.earthquake", id: "id", format: "xml", encoding: "utf-8",
    compression: null, head: { type: headType, author: "JMA", time: "2026-07-28T07:40:00Z", test: false, xml: true },
    xmlReport: { control: { status: "通常" } }, body });
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const withEvent = (xml: string, eventId: string) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
const marker = (observations: readonly P2HostObservation[], point: "T0" | "T1" | "T2", inputId: string) =>
  observations.flatMap((o) => o.kind === "marker" && o.point === point && "inputId" in o && o.inputId === inputId ? [o.monotonicMs] : [])[0];
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");

function summary(rows: readonly Record<string, number | null>[]): Record<string, { max: number; median: number } | null> {
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((key) => {
    const values = rows.map((row) => row[key]).filter((value): value is number => value != null).sort((left, right) => left - right);
    return [key, values.length === 0 ? null : { max: Math.round(values.at(-1)! * 100) / 100,
      median: Math.round(values[Math.floor(values.length / 2)] * 100) / 100 }];
  }));
}

// 一つの host の観測から EEW の 1 試行の行を作る（全試行を raw と全体の集計に残し、重なりは投入時刻と対象処理の区間で分ける）。
function measurer(observations: P2HostObservation[]) {
  const processingOf = (inputId: string) => {
    const found = observations.find((o) => o.kind === "processing" && o.measurement.inputId === inputId);
    return found?.kind === "processing" ? found.measurement : null;
  };
  const postedAt = (inputId: string) => owners.posted.find((item) => item.inputId === inputId)?.at ?? null;
  // 投入→T0・T0→T2・合計（投入→T2）、busyMs（対象処理の区間＝urgent が塞がり書込み権の出ない時間）、受信前回収で EEW の送出が遅れた量。
  // overlapped は EEW の投入時刻が対象処理の区間 [start, end) に入ったこと（遅れた T0 では判定しない）。
  const row = (eew: string, injectedAt: number, target: Readonly<{ start: number; end: number }>, extra: Record<string, number | null> = {}) => {
    const t0 = marker(observations, "T0", eew)!, t1 = marker(observations, "T1", eew)!, t2 = marker(observations, "T2", eew)!;
    const free = Math.max(target.end, t1);
    return { overlapped: target.start <= injectedAt && injectedAt < target.end ? 1 : 0, injectToT0: t0 - injectedAt, t0ToT2: t2 - t0,
      injectToT2: t2 - injectedAt, busyMs: target.end - target.start, sendDelayAfterFreeMs: Math.max(0, (postedAt(eew) ?? free) - free), ...extra };
  };
  const results: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  // 重なった試行が required 件に届かなければ測定不成立（数字を出さずに止める）。
  const record = (name: string, rows: readonly Record<string, number | null>[], required: number) => {
    const overlapped = rows.filter((item) => item.overlapped === 1);
    if (overlapped.length < required) throw new Error(`${name}: measurement not established (${overlapped.length}/${rows.length} overlapped)`);
    results[name] = { all: summary(rows), overlapped: summary(overlapped), overlappedCount: overlapped.length, tried: rows.length,
      delayedEewSends: rows.filter((item) => (item.sendDelayAfterFreeMs ?? 0) > 1).length };
    raw[name] = rows;
  };
  return { processingOf, row, record, results, raw };
}

describe.runIf(process.env.FLEQ_C7_AC12 === "1")("P3-C7-AC12 urgent interference report (Mac)", () => {
  const runs = Number(process.env.FLEQ_C7_AC12_RUNS ?? 20);
  const eewBody = text("77_01_01_240613_VXSE45");

  it("measures the longest U-Q work on urgent and the EEW waits behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", withEvent(eewBody, String(20240101000000 + ++eewSerial)));

    // (1)(2) 最大の VXSE53（200,380 byte）と最大の VXSE62（78,810 byte）: work と EEW を投入側から続けて送る。対象処理の区間は work の
    // 投入から work の処理の終わりまで。
    const behindWork = async (name: string, make: (index: number) => [string, string]) => {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, eew = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame(...make(index)), eewFrame()]);
        await until(() => marker(observations, "T2", eew) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        const arrival = owners.arrivals.get(work)!;
        rows.push(m.row(eew, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, decodeMs: arrival.decodeEnded - arrival.decodeStarted,
          reduceMs: arrival.raised == null ? null : arrival.raised - arrival.decodeEnded,
          viewAndPostMs: arrival.raised == null ? null : arrival.at - arrival.raised, publisherMs: done.endedMonotonicMs - arrival.at }));
      }
      m.record(name, rows, Math.ceil(runs / 2));
    };
    const s53 = text("telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825");
    const s62 = text("telegram-foundation/phase7_5_VXSE62_20260728162718_f9786edc27df");
    await behindWork("maxVxse53", (index) => ["VXSE53", withEvent(s53, `M53${String(index).padStart(11, "0")}`)]);
    await behindWork("maxVxse62", (index) => ["VXSE62", withEvent(s62, `M62${String(index).padStart(11, "0")}`)]);

    // (3) 最大の U-Q の保存の encode: 最大の VXSE53 の event を 4 MiB 近くまで積み、続報で保存させる。work の返信が届いた後に EEW を
    // 投入する。対象処理の区間は urgent へ書込み権（checkpointGrant）を送ってから U-Q の encode が終わるまで（owner はその間 EEW を
    // 処理できない）。
    for (let index = 0; index < 12; index++) {
      const sent = `input-${++sequence}`;
      await h.sender.send([frame("VXSE53", withEvent(s53, `F53${String(index).padStart(11, "0")}`))]);
      await until(() => m.processingOf(sent) != null);
    }
    const later = (minute: number) => s53.replace(/2026-07-28T16:35:00\+09:00/g, `2026-07-28T17:${String(minute).padStart(2, "0")}:00+09:00`)
      .replace("<Serial>2</Serial>", `<Serial>${minute + 3}</Serial>`);
    const encodes = () => observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === "U-Q" && o.measurement.stage === "encode"
      ? [{ start: o.measurement.startedMonotonicMs, end: o.measurement.endedMonotonicMs, bytes: o.measurement.bytes }] : []);
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, eew = `input-${++sequence}`;
        await h.sender.send([frame("VXSE53", withEvent(later(index), "F5300000000000"))]);
        await until(() => owners.arrivals.has(work));
        const arrivedAt = owners.arrivals.get(work)!.at;
        const [injectedAt] = await h.sender.send([eewFrame()]);
        // この work の保存: work の返信の後に urgent へ送った最初の書込み権と、その後に始まった最初の U-Q の encode。
        const grantOf = () => owners.posted.find((item) => item.place === "urgent" && item.kind === "checkpointGrant" && item.at >= arrivedAt);
        const encodeOf = () => { const grant = grantOf(); return grant == null ? undefined : encodes().find((item) => item.start >= grant.at); };
        await until(() => marker(observations, "T2", eew) != null && encodeOf() != null);
        const granted = grantOf()!.at, encode = encodeOf()!;
        rows.push(m.row(eew, injectedAt, { start: granted, end: encode.end }, { encodeMs: encode.end - encode.start,
          encodeBytes: encode.bytes }));
      }
      m.record("maxCheckpointEncode", rows, Math.ceil(runs / 2));
    }
    await h.stop();
    console.info("P3-C7-AC12-RAW", JSON.stringify(m.raw));
    console.info("P3-C7-AC12", JSON.stringify({ runs, results: m.results }));
  }, 900_000);

  // (4) 一括の期限回収（event 512・長周期 256 が同じ時刻に期限）: 空の state の host で組み、urgent へ期限の要求を送った瞬間に EEW を
  // 投入する。対象処理の区間は期限の要求の送出から期限の処理の返信（deadlineDone）まで。
  it("measures the bulk deadline of 512 events and 256 long-period subjects and the EEW wait behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", withEvent(eewBody, String(20240201000000 + ++eewSerial)));
    const rows: Record<string, number | null>[] = [];
    const bulkRuns = Number(process.env.FLEQ_C7_AC12_BULK_RUNS ?? 10);
    const lp = text("synthetic_phase4a_VXSE62_special");
    for (let trial = 0; trial < bulkRuns; trial++) {
      const due = Math.ceil((clock().wallTimeMs + 20_000) / 1000) * 1000;
      const frames = [
        ...Array.from({ length: 512 }, (_, index) => frame("VXSE53", vxse53({ eventId: `B${trial}E${index}`, at: iso(due - 86_400_000),
          origin: iso(due - 86_460_000), maxInt: "3" }))),
        ...Array.from({ length: 256 }, (_, index) => frame("VXSE62", withEvent(lp, `B${trial}L${index}`)
          .replace(/2026-08-01T21:02:00\+09:00/g, iso(due - 129_600_000)))),
      ];
      for (let from = 0; from < frames.length; from += 100) {
        const chunk = frames.slice(from, from + 100);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
      if (clock().wallTimeMs >= due) throw new Error("bulk records were not built before their deadline");
      const eew = `input-${++sequence}`;
      // urgent は毎 tick ほかの unit の期限でも要求を受けるので、対になる返信はこの要求を送った時点の次の deadlineDone。
      let doneBefore = 0;
      let injected: Promise<readonly number[]> | null = null;
      owners.onUrgentDeadline = () => {
        if (injected != null || clock().wallTimeMs < due) return;
        doneBefore = owners.deadlineDone.length;
        const deadlinePosted = performance.now();
        injected = h.sender.send([eewFrame()]).then((at) => [deadlinePosted, ...at]);
      };
      await until(() => injected != null, 30_000);
      const [deadlinePosted, injectedAt] = await injected!;
      owners.onUrgentDeadline = null;
      await until(() => marker(observations, "T2", eew) != null && owners.deadlineDone.length > doneBefore);
      const deadlineDone = owners.deadlineDone[doneBefore];
      rows.push(m.row(eew, injectedAt, { start: deadlinePosted, end: deadlineDone }, { deadlineMs: deadlineDone - deadlinePosted }));
    }
    m.record("bulkDeadline512And256", rows, Math.ceil(bulkRuns / 2));
    await h.stop();
    console.info("P3-C7-AC12-BULK-RAW", JSON.stringify(m.raw));
    console.info("P3-C7-AC12-BULK", JSON.stringify(m.results));
  }, 900_000);
});
