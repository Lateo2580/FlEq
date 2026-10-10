import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as SenderWorker } from "node:worker_threads";
import { afterEach, describe, it, vi } from "vitest";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";
import { eventId, fixtureXml, observations, rainItem, replaceTag, retime, tags } from "./briefing-fixture";

// P3-C12-AC11（台帳 63、P3-C12-INTERFERENCE）: deferred で U-B が足す最も長い非中断処理と、その最中に投入した EEW の待ち、
// 同居する U-F・U-L・U-R との待ち合い。Mac での報告用で、正式 E01 ではない（U-B 同居後の正式な再測定は C22）。通常の試験からは走らせない。
// 測り方は P3-C11-AC11 の写し（flood-host.test.ts）に、K6 の後の計測入力（P3-C12-INTERFERENCE.measurementInputs）を足す: EEW と各 unit の報の
// 時刻を host の時計へ寄せ、測った各入力の採用（publisher が反映した保存世代の上昇、generationRaised）を結果に含める。
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
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c12-host-"));
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

// 合法の範囲で大きい速報の報（I-U-B.bounds・P3-C12-BOUNDS=A の外まで並べる）: EventID 40 文字・title 64・headline 192・名前 16 の 3 byte の文字、
// 情報タグの item 8×区域 8（受理は item 4・区域の延べ 16 まで）、観測 16（受理は 8 まで）。
const MAX_TAGS = Array.from({ length: 8 }, (_, item) => ({ condition: "謎".repeat(16),
  areas: Array.from({ length: 8 }, (_, at) => ({ code: String(10_000_000 + item * 8 + at), name: "区".repeat(16) })) }));
const MAX_OBSERVATIONS = Array.from({ length: 16 }, (_, index) => rainItem(String(10_000_000 + index), "地".repeat(16), "-123456.789",
  `type="${"量".repeat(16)}" unit="ミリメートル毎時" condition="以上"`));
const maxId = (index: number) => `${"9".repeat(36)}${String(index).padStart(4, "0")}`;
function maxXml(index: number, at: number, serial = 1): string {
  return replaceTag("Serial", String(serial))(retime(iso(at))(eventId(maxId(index))(observations(MAX_OBSERVATIONS)(tags(MAX_TAGS)(
    fixtureXml("phase6b_VPBS50_KJPTK202608221709_202608221709"))))))
    .replace("<Title>東京都気象防災速報（記録的短時間大雨）</Title>", `<Title>${"題".repeat(64)}</Title>`)
    .replace(/<Text>[\s\S]*?<\/Text>/, `<Text>${"見".repeat(192)}</Text>`)
    .replace("<EditorialOffice>気象庁本庁</EditorialOffice>", `<EditorialOffice>${"官".repeat(16)}</EditorialOffice>`);
}
// 一括の期限回収用の小さな active の報（記録雨の系列の形）。
const smallXml = (index: number, at: number) => retime(iso(at))(eventId(`B${String(index).padStart(4, "0")}`)(
  fixtureXml("phase6b_VPBS50_KJPTK202608221709_202608221709")));
// 測った入力の採用の確かめ（K6 の後の計測入力）: その入力で unit の保存世代が上がった（unchanged・stale では上がらない）。
const raised = (observations: readonly P2HostObservation[], inputId: string, unit: string) =>
  observations.some((o) => o.kind === "generationRaised" && o.inputId === inputId && o.unit === unit) ? 1 : 0;

describe.runIf(process.env.FLEQ_C12_AC11 === "1")("P3-C12-AC11 deferred interference report (Mac)", () => {
  const runs = Number(process.env.FLEQ_C12_AC11_RUNS ?? 20);
  const eewBody = text("77_01_01_240613_VXSE45");
  const largeVpwp50 = text("81_09_01_260605_VPWP50"), smallVpwp50 = text("81_02_01_260605_VPWP50_high_severity");
  const landslideBody = text("15_16_01_241031_VPWW56"), floodBody = text("16_02_01_220728_VXKO50");
  // EEW の報時刻は投入の時の host の壁時計に寄せる（K6 の horizon 10 分の外の報は eewHorizonStale で T2 が無い）。
  const eewXml = (serial: number) => retime(iso(Math.floor(clock().wallTimeMs / 1000) * 1000))(withEvent(eewBody, String(20260101000000 + serial)));

  it("measures the longest U-B work on deferred, the EEW waits behind it and the waits with U-F, U-L and U-R", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", eewXml(++eewSerial));
    const sendAll = async (frames: readonly string[]) => {
      for (let from = 0; from < frames.length; from += 32) {
        const chunk = frames.slice(from, from + 32);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
    };
    // 合法最大に近い U-B: 256 subject を上限の長さの報で満たし、pending と終端記録を満たす（配送を遅らせる）。
    const start = Math.ceil(clock().wallTimeMs / 1000) * 1000;
    owners.deliveryDelayMs = 2_000;
    await sendAll(Array.from({ length: 256 }, (_, index) => frame("VPBS50", maxXml(index, start))));

    // (1) 大きい速報の報: 合法最大に近い U-B に work と EEW を続けて送る。
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, eew = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame("VPBS50", maxXml(index % 256, start + 1_000 + index * 1000, 2)), eewFrame()]);
        await until(() => marker(observations, "T2", eew) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        const arrival = owners.arrivals.get(work)!;
        rows.push(m.row(eew, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, decodeMs: arrival.decodeEnded - arrival.decodeStarted,
          reduceMs: arrival.raised == null ? null : arrival.raised - arrival.decodeEnded,
          viewAndPostMs: arrival.raised == null ? null : arrival.at - arrival.raised, publisherMs: done.endedMonotonicMs - arrival.at,
          workChanged: raised(observations, work, "U-B"), eewChanged: raised(observations, eew, "U-E") }));
      }
      m.record("maxBriefing", rows, Math.ceil(runs / 2));
    }

    // (2) 合法最大に近い U-B の保存の encode: 続報で保存させ、work の返信が届いた後に EEW・VPWP50・VPWW56・VXKO50 を投入する。
    const encodes = (unit: string) => observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === unit && o.measurement.stage === "encode"
      ? [{ start: o.measurement.startedMonotonicMs, end: o.measurement.endedMonotonicMs, bytes: o.measurement.bytes }] : []);
    for (const [name, probe, offset, unit] of [["maxBriefingEncode", "eew", 40_000, "U-E"], ["vpwp50BehindBriefingEncode", "vpwp50", 60_000, "U-F"],
      ["vpww56BehindBriefingEncode", "vpww56", 80_000, "U-L"], ["vxko50BehindBriefingEncode", "vxko50", 100_000, "U-R"]] as const) {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < runs; index++) {
        const work = `input-${++sequence}`, input = `input-${++sequence}`;
        const reported = start + offset + index * 1000;
        await h.sender.send([frame("VPBS50", maxXml(index % 256, reported, 3 + Math.floor(offset / 20_000)))]);
        await until(() => owners.arrivals.has(work));
        const arrivedAt = owners.arrivals.get(work)!.at;
        const [injectedAt] = await h.sender.send([probe === "eew" ? eewFrame() : probe === "vpwp50"
          ? frame("VPWP50", shift(smallVpwp50, reported - Date.parse("2026-06-05T17:00:00+09:00")))
          : probe === "vpww56" ? frame("VPWW56", replaceTag("Serial", String(index + 1))(retime(iso(reported))(landslideBody)))
          : frame("VXKO50", replaceTag("Serial", String(index + 4))(retime(iso(reported))(floodBody)))]);
        const grantOf = () => owners.posted.find((item) => item.place === "deferred" && item.kind === "checkpointGrant" && item.at >= arrivedAt);
        const encodeOf = () => { const grant = grantOf(); return grant == null ? undefined : encodes("U-B").find((item) => item.start >= grant.at); };
        await until(() => marker(observations, "T2", input) != null && encodeOf() != null);
        const granted = grantOf()!.at, encode = encodeOf()!;
        rows.push(m.row(input, injectedAt, { start: granted, end: encode.end }, { encodeMs: encode.end - encode.start, encodeBytes: encode.bytes,
          workChanged: raised(observations, work, "U-B"), probeChanged: raised(observations, input, unit) }));
      }
      m.record(name, rows, Math.ceil(runs / 2));
    }

    // (4) U-F の最大の VPWP50（81_09_01、2,268,084 byte）の処理の最中に投入した大きい速報の報の待ち（U-B が U-F の後ろで待つ時間）。
    {
      const rows: Record<string, number | null>[] = [];
      for (let index = 0; index < Math.min(runs, 10); index++) {
        const work = `input-${++sequence}`, briefing = `input-${++sequence}`;
        const reported = start + 200_000 + index * 1000;
        const [workAt, injectedAt] = await h.sender.send([frame("VPWP50", shift(largeVpwp50, reported - Date.parse("2026-06-05T17:00:00+09:00"))),
          frame("VPBS50", maxXml(index % 256, reported, 20))]);
        await until(() => marker(observations, "T2", briefing) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        rows.push(m.row(briefing, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          vpwp50BusyMs: done.endedMonotonicMs - done.startedMonotonicMs, workChanged: raised(observations, work, "U-F"),
          briefingChanged: raised(observations, briefing, "U-B") }));
      }
      m.record("briefingBehindMaxVpwp50", rows, 1);
    }
    await h.stop();
    console.info("P3-C12-AC11-RAW", JSON.stringify(m.raw));
    console.info("P3-C12-AC11", JSON.stringify({ runs, results: m.results }));
  }, 3_600_000);

  // (3) 一括の期限回収（256 subject の active の記録が同じ時刻に期限）: 空の state の host で組み、deferred へ期限の要求を送った瞬間に
  // EEW を投入する。元報の時刻を期限の 2 時間前に置いた報は受理の時点で遅着でないので active になり、回収で黙って除く。
  it("measures the bulk deadline of 256 subjects and the EEW wait behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0, eewSerial = 0;
    const eewFrame = () => frame("VXSE45", eewXml(++eewSerial + 1_000));
    const rows: Record<string, number | null>[] = [];
    const bulkRuns = Number(process.env.FLEQ_C12_AC11_BULK_RUNS ?? 10);
    for (let trial = 0; trial < bulkRuns; trial++) {
      const due = Math.ceil((clock().wallTimeMs + 30_000) / 1000) * 1000;
      const frames = Array.from({ length: 256 }, (_, index) => frame("VPBS50", smallXml(index, due - 7_200_000)));
      for (let from = 0; from < frames.length; from += 32) {
        const chunk = frames.slice(from, from + 32);
        sequence += chunk.length;
        const last = `input-${sequence}`;
        await h.sender.send(chunk);
        await until(() => m.processingOf(last) != null);
      }
      const adopted = Array.from({ length: 256 }, (_, index) => raised(observations, `input-${sequence - 255 + index}`, "U-B")).reduce<number>((sum, item) => sum + item, 0);
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
      await until(() => injected != null, 90_000);
      const [deadlinePosted, injectedAt] = await injected!;
      owners.onDeferredDeadline = null;
      await until(() => marker(observations, "T2", eew) != null
        && owners.deadlineDone.filter((item) => item.place === "deferred").length > doneBefore);
      const deadlineDone = owners.deadlineDone.filter((item) => item.place === "deferred")[doneBefore].at;
      rows.push(m.row(eew, injectedAt, { start: deadlinePosted, end: deadlineDone }, { deadlineMs: deadlineDone - deadlinePosted,
        recordsAdopted: adopted, eewChanged: raised(observations, eew, "U-E") }));
    }
    m.record("bulkDeadline", rows, Math.ceil(bulkRuns / 2));
    await h.stop();
    console.info("P3-C12-AC11-BULK-RAW", JSON.stringify(m.raw));
    console.info("P3-C12-AC11-BULK", JSON.stringify(m.results));
  }, 1_800_000);
});
