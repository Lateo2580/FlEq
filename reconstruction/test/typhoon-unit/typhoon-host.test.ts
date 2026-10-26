import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as SenderWorker } from "node:worker_threads";
import { afterEach, describe, it, vi } from "vitest";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";
import { hashEnvelope } from "../../src/checkpoint/checkpoint";
import { generationBytes, reduceTyphoonUnit, toTyphoonView, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { clock as unitClock, compose, decodeXml, emptyState, eventId, maximumPayload, replaceTag, retime } from "./typhoon-fixture";

// P3-C14-AC12（台帳 63、P3-C14-INTERFERENCE）: deferred で U-Y が足す最も長い非中断処理と、その最中に投入した EEW の待ち、
// 同居する U-F・U-L・U-R・U-B・U-M との待ち合い。Mac での報告用で、正式 E01 ではない（U-Y 同居後の正式な再測定は C22）。通常の試験からは走らせない。
// 測り方は P3-C12-AC11 の写し（briefing-host.test.ts）に、P3-C13-INTERFERENCE.measurementInputs を足す: EEW と各 unit の報の時刻を host の時計へ寄せ
// （竜巻は ValidDateTime も寄せる）、測った各入力の採用（publisher が反映した保存世代の上昇、generationRaised）を結果に含める。
const owners = vi.hoisted(() => ({ live: new Set<{ terminate(): Promise<number> }>(),
  posted: [] as { place: string; kind: string; inputId: string | null; at: number }[],
  // owner の返信が publisher の thread に届いた時刻（複製の復元の後）。inputDone は入力 ID で、deadlineDone は届いた順。
  arrivals: new Map<string, { place: string; at: number; decodeStarted: number; decodeEnded: number; raised: number | null }>(),
  deadlineDone: [] as { place: string; at: number }[],
  // deferred へ期限の要求を送った瞬間に呼ぶ（一括回収の最中に EEW を投入するため）。
  onDeferredDeadline: null as (() => void) | null,
  // 配送の完了を遅らせて pending を満たす（合法最大に近い U-B の encode を測る）。
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
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c14-host-"));
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

const BIG = "76_01_02_260531_VPTA50";
const text_BIG = () => text(BIG);
const REF = Date.parse("2026-05-31T09:55:00+09:00");
// 確率の報を投入の時刻へ寄せ、EventID を変える（試行ごとに新しい報・新しい subject にする）。
const probabilityAt = (index: number, at: number, version = 1) => compose(eventId(`TC${String(index).padStart(4, "0")}`), (xml) => shift(xml, at - REF), replaceTag("Serial", String(version)))(text(BIG));
const analysisAt = (index: number, at: number, version = 1) => compose(eventId(`TC${String(index).padStart(4, "0")}`), (xml) => shift(xml, at - Date.parse("2017-09-13T21:45:00+09:00")),
  replaceTag("Serial", String(version)))(text("10_04_03_170913_VPTW60"));
const raised = (observations: readonly P2HostObservation[], inputId: string, unit: string) =>
  observations.some((o) => o.kind === "generationRaised" && o.inputId === inputId && o.unit === unit) ? 1 : 0;

describe.runIf(process.env.FLEQ_C14_AC12 === "1")("P3-C14-AC12 deferred interference report (Mac)", () => {
  const runs = Number(process.env.FLEQ_C14_AC12_RUNS ?? 20);
  const eewBody = text("77_01_01_240613_VXSE45");
  const largeVpwp50 = text("81_09_01_260605_VPWP50");
  const tornadoBody = text("19_04_01_140425_VPHW51");
  const eewXml = (serialNumber: number) => retime(iso(Math.floor(clock().wallTimeMs / 1000) * 1000))(withEvent(eewBody, String(20260101000000 + serialNumber)));

  it("measures the longest U-Y work on deferred, the EEW waits behind it and the waits with U-F and U-M", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", eewXml(++eewSerial));
    // 1.85 MB の確率の報は mailbox の byte の上限があるので 1 通ずつ送る（解析は 8 通ずつ）。
    const sendAll = async (frames: readonly string[], size = 8) => {
      for (let from = 0; from < frames.length; from += size) {
        const chunk = frames.slice(from, from + size);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
    };
    // 合法最大に近い U-Y: 解析 64（14 時刻）と確率 64（273 地域）。配送を遅らせて pending を満たす。
    const start = Math.ceil(clock().wallTimeMs / 1000) * 1000;
    owners.deliveryDelayMs = 2_000;
    await sendAll(Array.from({ length: 64 }, (_, index) => frame("VPTW60", analysisAt(index, start))));
    await sendAll(Array.from({ length: 64 }, (_, index) => frame("VPTA50", probabilityAt(index, start))), 1);

    // (1) 最大の確率の報（1.85 MB）の処理（解凍・parse・reduce）の最中に EEW を投入する。
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, eew = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame("VPTA50", probabilityAt(index % 64, start + 1_000 + index * 1000, 2)), eewFrame()]);
        await until(() => marker(observations, "T2", eew) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        const arrival = owners.arrivals.get(work)!;
        rows.push(m.row(eew, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, decodeMs: arrival.decodeEnded - arrival.decodeStarted,
          reduceMs: arrival.raised == null ? null : arrival.raised - arrival.decodeEnded, workChanged: raised(observations, work, "U-Y"), eewChanged: raised(observations, eew, "U-E") }));
      }
      m.record("maxProbability", rows, Math.ceil(runs / 2));
    }

    // (2) 合法最大に近い U-Y の保存の encode: 続報で保存させ、work の返信が届いた後に EEW と各 unit の報を投入する。
    const encodes = (unit: string) => observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === unit && o.measurement.stage === "encode"
      ? [{ start: o.measurement.startedMonotonicMs, end: o.measurement.endedMonotonicMs, bytes: o.measurement.bytes }] : []);
    for (const [name, probe, offset, unit] of [["maxTyphoonEncode", "eew", 40_000, "U-E"], ["vpwp50BehindTyphoonEncode", "vpwp50", 60_000, "U-F"],
      ["vphw51BehindTyphoonEncode", "vphw51", 80_000, "U-M"]] as const) {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, input = `input-${++sequence}`;
        const reported = start + offset + index * 1000;
        await h.sender.send([frame("VPTA50", probabilityAt(index % 64, reported, 3 + Math.floor(offset / 20_000)))]);
        await until(() => owners.arrivals.has(work));
        const arrivedAt = owners.arrivals.get(work)!.at;
        const [injectedAt] = await h.sender.send([probe === "eew" ? eewFrame() : probe === "vpwp50"
          ? frame("VPWP50", shift(largeVpwp50, reported - Date.parse("2026-06-05T17:00:00+09:00")))
          : frame("VPHW51", compose(retime(iso(reported)), replaceTag("ValidDateTime", iso(reported + 3_000_000)), replaceTag("Serial", String(index + 40)))(tornadoBody))]);
        const grantOf = () => owners.posted.find((item) => item.place === "deferred" && item.kind === "checkpointGrant" && item.at >= arrivedAt);
        const encodeOf = () => { const grant = grantOf(); return grant == null ? undefined : encodes("U-Y").find((item) => item.start >= grant.at); };
        await until(() => marker(observations, "T2", input) != null && encodeOf() != null);
        const granted = grantOf()!.at, encode = encodeOf()!;
        rows.push(m.row(input, injectedAt, { start: granted, end: encode.end }, { encodeMs: encode.end - encode.start, encodeBytes: encode.bytes,
          workChanged: raised(observations, work, "U-Y"), probeChanged: raised(observations, input, unit) }));
      }
      m.record(name, rows, Math.ceil(runs / 2));
    }

    // (3) U-F の最大の VPWP50 の最中に投入した確率の報の待ち（U-Y が U-F の後ろで待つ）と、確率の報の最中に投入した竜巻注意情報の待ち（U-M が U-Y の後ろで待つ）。
    for (const [name, first, second, unit] of [["probabilityBehindMaxVpwp50", "vpwp50", "vpta50", "U-Y"], ["tornadoBehindMaxProbability", "vpta50", "vphw51", "U-M"]] as const) {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < Math.min(runs, 10); index++) {
        const work = `input-${++sequence}`, probe = `input-${++sequence}`;
        const reported = start + 200_000 + (first === "vpwp50" ? 0 : 20_000) + index * 1000;
        const workFrame = first === "vpwp50" ? frame("VPWP50", shift(largeVpwp50, reported - Date.parse("2026-06-05T17:00:00+09:00"))) : frame("VPTA50", probabilityAt(index % 64, reported, 9));
        const probeFrame = second === "vpta50" ? frame("VPTA50", probabilityAt(100 + index, reported)) : frame("VPHW51", compose(retime(iso(reported)), replaceTag("ValidDateTime", iso(reported + 3_000_000)),
          replaceTag("Serial", String(index + 80)))(tornadoBody));
        const [workAt, injectedAt] = await h.sender.send([workFrame, probeFrame]);
        await until(() => marker(observations, "T2", probe) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        rows.push(m.row(probe, injectedAt, { start: workAt, end: done.endedMonotonicMs }, { workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs,
          probeChanged: raised(observations, probe, unit) }));
      }
      m.record(name, rows, 1);
    }
    await h.stop();
    console.info("P3-C14-AC12-RAW", JSON.stringify(m.raw));
    console.info("P3-C14-AC12", JSON.stringify({ runs, results: m.results }));
  }, 3_600_000);

  // (5) 合法最大（静的上界 7.2 MB 相当、解析 64・確率 64・最長の文字列・pending 131,072 byte・終端記録 98,304 byte）の保存物の encode・toView・decode・
  // 確率の報 1 通の reduce の所要。deferred の worker が 1 回で塞がる時間（その間の EEW・同居 unit の待ちの上限になる）。host の外で純粋な関数を回す。
  it("measures the encode, toView, decode and one 1.85 MB report reduce on the legal maximum state", () => {
    const decoded = typhoonUnitCodec.decode(JSON.parse(JSON.stringify(maximumPayload().payload)));
    if (decoded.kind !== "restored") throw new Error("the legal maximum payload did not decode");
    const state = decoded.state;
    const bytes = generationBytes(typhoonUnitCodec.encode(state));
    const time = (work: () => unknown, count = Math.max(runs, 20)) => {
      const values: number[] = [];
      for (let index = 0; index < count; index++) { const t0 = performance.now(); work(); values.push(performance.now() - t0); }
      values.sort((left, right) => left - right);
      return { max: Math.round(values.at(-1)! * 100) / 100, median: Math.round(values[Math.floor(values.length / 2)] * 100) / 100 };
    };
    let generation = 0;
    const encode = time(() => hashEnvelope({ schemaVersion: "p3-typhoon-unit-v7", unit: "U-Y", generation: ++generation, capturedAt: generation, payload: typhoonUnitCodec.encode(state) }));
    const view = time(() => toTyphoonView(state));
    const text = JSON.stringify(typhoonUnitCodec.encode(state));
    const decode = time(() => typhoonUnitCodec.decode(JSON.parse(text)));
    const material = decodeXml(shift(text_BIG(), Date.parse("9000-06-01T00:00:00+09:00") - REF), "VPTA50", "probe");
    const reduce = time(() => reduceTyphoonUnit(state, { kind: "receive", material, clock: unitClock(Date.parse(material.reportDateTimeRaw)) }), 10);
    console.info("P3-C14-AC12-MAX", JSON.stringify({ generationBytes: bytes, encode, toView: view, decodeFromText: decode, probabilityReduceOnMax: reduce }));
  });

  // (4) 一括の期限回収（解析 64・確率 64＝128 記録の retainUntil が同じ時刻 due に来る）: 見える期限の過ぎた記憶として採り、deferred へ期限の要求を送った瞬間に EEW を投入する。
  it("measures the bulk deadline of 128 records and the EEW wait behind it", async () => {
    let eewSerial = 0;
    const eewFrame = () => frame("VXSE45", eewXml(++eewSerial + 1_000));
    const rows: Record<string, number | null>[] = [];
    const aggregate = measurer([]);
    let skipped = 0;
    const bulkRuns = Number(process.env.FLEQ_C14_AC12_BULK_RUNS ?? 10);
    for (let trial = 0; trial < bulkRuns; trial++) {
      // 試行ごとに host を起動し直す（前の試行の記録・期限・pending と交差させない）。
      const observations: P2HostObservation[] = [];
      const h = await host(observations);
      const m = measurer(observations);
      let sequence = 0;
      const due = Math.ceil((clock().wallTimeMs + 60_000) / 1000) * 1000;
      const reported = due - 7 * 86_400_000;
      const frames = [...Array.from({ length: 64 }, (_, index) => frame("VPTW60", analysisAt(index, reported))),
        ...Array.from({ length: 64 }, (_, index) => frame("VPTA50", probabilityAt(index, reported + 1_000)))];
      for (let from = 0; from < frames.length; from += from < 64 ? 8 : 1) {
        const chunk = frames.slice(from, from + (from < 64 ? 8 : 1));
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
      const adopted = Array.from({ length: frames.length }, (_, index) => raised(observations, `input-${sequence - frames.length + 1 + index}`, "U-Y")).reduce<number>((sum, item) => sum + item, 0);
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
      // host が期限の要求を期限の直前に送って EEW を投入できなかった試行は数えずに捨てる（skipped に出す）。
      try { await until(() => injected != null, 90_000); } catch { owners.onDeferredDeadline = null; skipped++; await h.stop(); continue; }
      const [deadlinePosted, injectedAt] = await injected!;
      owners.onDeferredDeadline = null;
      await until(() => marker(observations, "T2", eew) != null && owners.deadlineDone.filter((item) => item.place === "deferred").length > doneBefore);
      const deadlineDone = owners.deadlineDone.filter((item) => item.place === "deferred")[doneBefore].at;
      rows.push(m.row(eew, injectedAt, { start: deadlinePosted, end: deadlineDone }, { deadlineMs: deadlineDone - deadlinePosted, recordsAdopted: adopted,
        eewChanged: raised(observations, eew, "U-E") }));
      await h.stop();
    }
    console.info("P3-C14-AC12-BULK-SKIPPED", skipped, "of", bulkRuns);
    aggregate.record("bulkDeadline", rows, Math.ceil(bulkRuns / 2));
    console.info("P3-C14-AC12-BULK-RAW", JSON.stringify(aggregate.raw));
    console.info("P3-C14-AC12-BULK", JSON.stringify(aggregate.results));
  }, 1_800_000);
});
