import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as SenderWorker } from "node:worker_threads";
import { afterEach, describe, it, vi } from "vitest";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";
import { areas, fixtureXml, office, replaceTag, retime } from "./landslide-fixture";

// P3-C10-AC11（台帳 63、P3-C10-INTERFERENCE）: deferred で U-L が足す最も長い非中断処理と、その最中に投入した EEW の待ち、
// 同居する U-F との待ち合い。Mac での報告用で、正式 E01 ではない（U-L 同居後の正式な再測定は C22）。通常の試験からは走らせない。
// 測り方は P3-C9-AC13 と同じ: 投入側は別 thread、全試行を raw と全体の集計に残し、重なりは投入時刻と対象処理の区間で分ける。
const owners = vi.hoisted(() => ({ live: new Set<{ terminate(): Promise<number> }>(),
  posted: [] as { place: string; kind: string; inputId: string | null; at: number }[],
  // owner の返信が publisher の thread に届いた時刻（複製の復元の後）。inputDone は入力 ID で、deadlineDone は届いた順。
  arrivals: new Map<string, { place: string; at: number; decodeStarted: number; decodeEnded: number; raised: number | null }>(),
  deadlineDone: [] as { place: string; at: number }[],
  // deferred へ期限の要求を送った瞬間に呼ぶ（一括回収の最中に EEW を投入するため）。
  onDeferredDeadline: null as (() => void) | null,
  // 配送の完了を遅らせて pending を満たす（合法最大に近い U-L の encode を測る）。
  deliveryDelayMs: 0 }));
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
      if (this.place === "deferred" && kind === "deadline") owners.onDeferredDeadline?.();
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      const reply = args[0];
      if (event === "message" && reply != null && typeof reply === "object" && "kind" in reply) {
        if (reply.kind === "deadlineDone") owners.deadlineDone.push({ place: this.place, at: performance.now() });
        if (reply.kind === "inputDone" && "settlement" in reply && "decode" in reply && "generationRaisedMs" in reply) {
          const settlement = reply.settlement as { inputId: string };
          const decode = reply.decode as { startedMonotonicMs: number; endedMonotonicMs: number };
          owners.arrivals.set(settlement.inputId, { place: this.place, at: performance.now(), decodeStarted: decode.startedMonotonicMs,
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
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) => {
    if (owners.deliveryDelayMs > 0) await new Promise((done) => setTimeout(done, owners.deliveryDelayMs));
    return { kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() };
  },
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const BASE_AT = Date.parse("2026-07-28T16:40:00+09:00");
const base = performance.now();
const clock = () => ({ wallTimeMs: BASE_AT + Math.trunc(performance.now() - base), monotonicMs: performance.now() });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(() => owners.live.size === 0);
  owners.posted.length = 0;
  owners.arrivals.clear();
  owners.deadlineDone.length = 0;
  owners.onDeferredDeadline = null;
  owners.deliveryDelayMs = 0;
});
async function until(condition: () => boolean, milliseconds = 120_000): Promise<void> {
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
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c10-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  const started = await startP2Host({ wsUrl: `ws://127.0.0.1:${sender.port}/`, stateDirectory: join(path, "state"),
    diagnosticDirectory: join(path, "diagnostics"), displayPort: 0, clock, observe: (item) => { observations.push(item); } });
  cleanups.push(() => started.stop().then(() => {}, () => {}));
  await until(() => sender.connected());
  return { sender, stop: started.stop };
}
function frame(headType: string, body: string): string {
  const status = /<Status>([^<]*)<\/Status>/.exec(body)?.[1] ?? "通常";
  const classification = /^VXSE/.test(headType) ? "telegram.earthquake" : "telegram.weather";
  return JSON.stringify({ type: "data", version: "2.0", classification, id: "id", format: "xml", encoding: "utf-8",
    compression: null, head: { type: headType, author: "JMA", time: "2026-07-28T07:40:00Z", test: status === "試験", xml: true },
    xmlReport: { control: { status } }, body });
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const withEvent = (xml: string, eventId: string) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
const marker = (observations: readonly P2HostObservation[], point: "T0" | "T1" | "T2", inputId: string) =>
  observations.flatMap((o) => o.kind === "marker" && o.point === point && "inputId" in o && o.inputId === inputId ? [o.monotonicMs] : [])[0];
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
// 全時刻を delta だけ動かす（VPWP50 を試行ごとに新しい報にする。eew-e01 の shiftTimestamps と同じ規則を秒単位で）。
const shift = (xml: string, deltaMs: number) => xml.replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|\+09:00)/g,
  (whole, ..._parts: string[]) => {
    const zone = whole.endsWith("Z") ? "Z" : "+09:00";
    const at = Date.parse(whole) + deltaMs;
    return zone === "Z" ? new Date(at).toISOString().replace(".000Z", "Z") : iso(at);
  });

function summary(rows: readonly Record<string, number | null>[]): Record<string, { max: number; median: number } | null> {
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((key) => {
    const values = rows.map((row) => row[key]).filter((value): value is number => value != null).sort((left, right) => left - right);
    return [key, values.length === 0 ? null : { max: Math.round(values.at(-1)! * 100) / 100,
      median: Math.round(values[Math.floor(values.length / 2)] * 100) / 100 }];
  }));
}

function measurer(observations: P2HostObservation[]) {
  const processingOf = (inputId: string) => {
    const found = observations.find((o) => o.kind === "processing" && o.measurement.inputId === inputId);
    return found?.kind === "processing" ? found.measurement : null;
  };
  const postedAt = (inputId: string) => owners.posted.find((item) => item.inputId === inputId)?.at ?? null;
  // 投入→T0・T0→T2・合計（投入→T2）、busyMs（対象処理の区間）、送出の遅れ。overlapped は投入時刻が対象処理の区間に入ったこと。
  const row = (input: string, injectedAt: number, target: Readonly<{ start: number; end: number }>, extra: Record<string, number | null> = {}) => {
    const t0 = marker(observations, "T0", input)!, t1 = marker(observations, "T1", input)!, t2 = marker(observations, "T2", input)!;
    const free = Math.max(target.end, t1);
    return { overlapped: target.start <= injectedAt && injectedAt < target.end ? 1 : 0, injectToT0: t0 - injectedAt, t0ToT2: t2 - t0,
      injectToT2: t2 - injectedAt, busyMs: target.end - target.start, sendDelayAfterFreeMs: Math.max(0, (postedAt(input) ?? free) - free), ...extra };
  };
  const results: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  const record = (name: string, rows: readonly Record<string, number | null>[], required: number) => {
    const overlapped = rows.filter((item) => item.overlapped === 1);
    if (overlapped.length < required) throw new Error(`${name}: measurement not established (${overlapped.length}/${rows.length} overlapped)`);
    results[name] = { all: summary(rows), overlapped: summary(overlapped), overlappedCount: overlapped.length, tried: rows.length };
    raw[name] = rows;
  };
  return { processingOf, row, record, results, raw };
}

// 合法最大に近い土砂の報（I-U-L.bounds）: 官署 64 単位・title 128・Kind の名前 32 の 3 byte の文字、市町村等 256 区域を 8 種類の表に無い code に。
const digits = (index: number) => String(index).padStart(4, "0").replace(/\d/g, (digit) => "〇一二三四五六七八九"[Number(digit)]);
const officeOf = (index: number) => `${"局".repeat(60)}${digits(index)}`;
const MAX_ITEMS = Array.from({ length: 256 }, (_, index) => ({ code: String(10 ** 15 + index), kind: String(50 + index % 8),
  name: "名".repeat(32), area: "市".repeat(32) }));
function maxXml(index: number, at: number, serial = 1): string {
  return replaceTag("Serial", String(serial))(retime(iso(at))(office(officeOf(index))(areas(MAX_ITEMS)(fixtureXml("15_16_01_241031_VPWW56")))))
    .replace("<Title>宗谷地方土砂災害警報・注意報</Title>", `<Title>${"題".repeat(128)}</Title>`);
}
// 全区域の解除（ended の記録を作る）。
const RELEASE = Array.from({ length: 10 }, (_, index) => ({ code: String(1_000_000 + index), status: "解除" }));
const releaseXml = (index: number, at: number) => retime(iso(at))(office(officeOf(index))(areas(RELEASE)(fixtureXml("15_16_01_241031_VPWW56"))));

describe.runIf(process.env.FLEQ_C10_AC11 === "1")("P3-C10-AC11 deferred interference report (Mac)", () => {
  const runs = Number(process.env.FLEQ_C10_AC11_RUNS ?? 20);
  const eewBody = text("77_01_01_240613_VXSE45");
  const largeVpwp50 = text("81_09_01_260605_VPWP50"), smallVpwp50 = text("81_02_01_260605_VPWP50_high_severity");

  it("measures the longest U-L work on deferred, the EEW waits behind it and the waits with U-F", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", withEvent(eewBody, String(20240101000000 + ++eewSerial)));
    const sendAll = async (frames: readonly string[]) => {
      for (let from = 0; from < frames.length; from += 32) {
        const chunk = frames.slice(from, from + 32);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
    };
    // 合法最大に近い U-L: 128 官署を上限の長さの報で満たし、pending と終端記録を満たす（配送を遅らせる）。
    const start = Math.ceil(clock().wallTimeMs / 1000) * 1000;
    owners.deliveryDelayMs = 2_000;
    await sendAll(Array.from({ length: 128 }, (_, index) => frame("VPWW56", maxXml(index, start))));

    // (1) 合法最大の土砂の報（Item 256・8 種類）: 合法最大に近い U-L に work と EEW を続けて送る。
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, eew = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame("VPWW56", maxXml(index % 128, start + 200_000 + index * 1000)), eewFrame()]);
        await until(() => marker(observations, "T2", eew) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        const arrival = owners.arrivals.get(work)!;
        rows.push(m.row(eew, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, decodeMs: arrival.decodeEnded - arrival.decodeStarted,
          reduceMs: arrival.raised == null ? null : arrival.raised - arrival.decodeEnded,
          viewAndPostMs: arrival.raised == null ? null : arrival.at - arrival.raised, publisherMs: done.endedMonotonicMs - arrival.at }));
      }
      m.record("maxLandslide", rows, Math.ceil(runs / 2));
    }

    // (2) 合法最大に近い U-L の保存の encode: 続報で保存させ、work の返信が届いた後に EEW を、(4b) では VPWP50 を投入する。
    const encodes = (unit: string) => observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === unit && o.measurement.stage === "encode"
      ? [{ start: o.measurement.startedMonotonicMs, end: o.measurement.endedMonotonicMs, bytes: o.measurement.bytes }] : []);
    for (const [name, probe] of [["maxLandslideEncode", "eew"], ["vpwp50BehindLandslideEncode", "vpwp50"]] as const) {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, input = `input-${++sequence}`;
        const offset = name === "maxLandslideEncode" ? 400_000 : 600_000;
        await h.sender.send([frame("VPWW56", maxXml(index % 128, start + offset + index * 1000))]);
        await until(() => owners.arrivals.has(work));
        const arrivedAt = owners.arrivals.get(work)!.at;
        const [injectedAt] = await h.sender.send([probe === "eew" ? eewFrame()
          : frame("VPWP50", shift(smallVpwp50, start + offset + index * 1000 - Date.parse("2026-06-05T17:00:00+09:00")))]);
        const grantOf = () => owners.posted.find((item) => item.place === "deferred" && item.kind === "checkpointGrant" && item.at >= arrivedAt);
        const encodeOf = () => { const grant = grantOf(); return grant == null ? undefined : encodes("U-L").find((item) => item.start >= grant.at); };
        await until(() => marker(observations, "T2", input) != null && encodeOf() != null);
        const granted = grantOf()!.at, encode = encodeOf()!;
        rows.push(m.row(input, injectedAt, { start: granted, end: encode.end }, { encodeMs: encode.end - encode.start, encodeBytes: encode.bytes }));
      }
      m.record(name, rows, Math.ceil(runs / 2));
    }

    // (4a) U-F の最大の VPWP50（81_09_01、2,268,084 byte）の処理の最中に投入した VPWW56 の待ち（U-L が U-F の後ろで待つ時間）。
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < Math.min(runs, 10); index++) {
        const work = `input-${++sequence}`, landslide = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame("VPWP50", shift(largeVpwp50, start + 800_000 + index * 1000
          - Date.parse("2026-06-05T17:00:00+09:00"))), frame("VPWW56", maxXml(index % 128, start + 800_000 + index * 1000))]);
        await until(() => marker(observations, "T2", landslide) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        rows.push(m.row(landslide, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          vpwp50BusyMs: done.endedMonotonicMs - done.startedMonotonicMs }));
      }
      m.record("landslideBehindMaxVpwp50", rows, 1);
    }
    await h.stop();
    console.info("P3-C10-AC11-RAW", JSON.stringify(m.raw));
    console.info("P3-C10-AC11", JSON.stringify({ runs, results: m.results }));
  }, 1_800_000);

  // (3) 一括の期限回収（128 官署の記録が同じ時刻に期限）: 空の state の host で組み、deferred へ期限の要求を送った瞬間に EEW を投入する。
  // 受信で作れる同時の期限は ended の記録（元報 +6 時間）。active の +48 時間は記録の無い官署へ遅れて届くと active にならないので組めない。
  it("measures the bulk deadline of 128 offices and the EEW wait behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", withEvent(eewBody, String(20240201000000 + ++eewSerial)));
    const rows: Record<string, number | null>[] = [];
    const bulkRuns = Number(process.env.FLEQ_C10_AC11_BULK_RUNS ?? 10);
    for (let trial = 0; trial < bulkRuns; trial++) {
      const due = Math.ceil((clock().wallTimeMs + 20_000) / 1000) * 1000;
      const frames = Array.from({ length: 128 }, (_, index) => frame("VPWW56", releaseXml(index, due - 6 * 3_600_000)));
      for (let from = 0; from < frames.length; from += 32) {
        const chunk = frames.slice(from, from + 32);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
      if (clock().wallTimeMs >= due) throw new Error("bulk records were not built before their deadline");
      const eew = `input-${++sequence}`;
      let doneBefore = 0;
      let injected: Promise<readonly number[]> | null = null;
      owners.onDeferredDeadline = () => {
        if (injected != null || clock().wallTimeMs < due) return;
        doneBefore = owners.deadlineDone.filter((item) => item.place === "deferred").length;
        const deadlinePosted = performance.now();
        injected = h.sender.send([eewFrame()]).then((at) => [deadlinePosted, ...at]);
      };
      await until(() => injected != null, 60_000);
      const [deadlinePosted, injectedAt] = await injected!;
      owners.onDeferredDeadline = null;
      await until(() => marker(observations, "T2", eew) != null
        && owners.deadlineDone.filter((item) => item.place === "deferred").length > doneBefore);
      const deadlineDone = owners.deadlineDone.filter((item) => item.place === "deferred")[doneBefore].at;
      rows.push(m.row(eew, injectedAt, { start: deadlinePosted, end: deadlineDone }, { deadlineMs: deadlineDone - deadlinePosted }));
    }
    m.record("bulkDeadline", rows, Math.ceil(bulkRuns / 2));
    await h.stop();
    console.info("P3-C10-AC11-BULK-RAW", JSON.stringify(m.raw));
    console.info("P3-C10-AC11-BULK", JSON.stringify(m.results));
  }, 900_000);
});
