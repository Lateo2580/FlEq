import { promises as fileSystem, readFileSync } from "node:fs";
import { type ClientRequest, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as SenderWorker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { DisplayVersion } from "../../contracts/p2-snapshot-sse.types";
import { startP2Host } from "../../src/host/host";
import { executionPlaces } from "../../src/runtime/unit-coverage";
import { shiftTimestamps } from "../eew-e01/frames.mjs";
import { stations30k } from "../eew-e01/run.mjs";
import { clock as fixtureClock, decodeXml, emptyState, receive, sentLater, vxse53 } from "./seismic-fixture";

// P3-C7-AC12（台帳 63、P3-C7-INTERFERENCE）: U-Q の最も長い非中断処理と、その最中に投入した EEW・津波の待ち。Mac での報告用で、
// 正式 E01 ではない（U-Q 同居後の EEW の正式な再測定は spec:1129 の後半の P5 の最終構成と C22）。通常の試験からは走らせない。
// P3-SP-AC01・AC07: U-Q の場所（executionPlaces）で読むので、U-Q を seismic へ移す前（AC01）と後（AC07）で同じ試験を走らせる。
// 投入側（dmdata の代わりの WS server）は別 thread に置き、publisher の thread が塞がっても投入の時刻がずれないようにする。
const owners = vi.hoisted(() => ({ live: new Set<{ terminate(): Promise<number> }>(),
  posted: [] as { place: string; kind: string; inputId: string | null; at: number }[],
  // 返信が publisher の thread に届いた時刻（複製の復元の後）と owner の区分の印。inputDone は入力 ID で、deadlineDone は届いた順。
  arrivals: new Map<string, { at: number; decodeStarted: number; xmlParseStarted: number | null; xmlParseEnded: number | null;
    decodeEnded: number; raised: number | null }>(),
  deadlineDone: [] as { place: string; at: number }[],
  // 期限の要求を送った瞬間に呼ぶ（一括回収の最中に EEW を投入するため）。
  onDeadline: null as ((place: string) => void) | null,
  // 書込み権を送った瞬間に呼ぶ（encode の最中に EEW を投入するため。権は返信の直後とは限らないので、返信を見てからでは遅れうる）。
  onGrant: null as ((place: string, unit: string) => void) | null }));
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
      if (kind === "deadline") owners.onDeadline?.(this.place);
      if (kind === "checkpointGrant" && request != null && "unit" in request && typeof request.unit === "string") owners.onGrant?.(this.place, request.unit);
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      const reply = args[0];
      if (event === "message" && reply != null && typeof reply === "object" && "kind" in reply) {
        if (reply.kind === "deadlineDone") owners.deadlineDone.push({ place: this.place, at: performance.now() });
        if (reply.kind === "inputDone" && "settlement" in reply && "decode" in reply && "generationRaisedMs" in reply) {
          const settlement = reply.settlement as { inputId: string };
          const decode = reply.decode as { startedMonotonicMs: number; endedMonotonicMs: number; xmlParseStartedMonotonicMs: number | null;
            xmlParseEndedMonotonicMs: number | null };
          owners.arrivals.set(settlement.inputId, { at: performance.now(), decodeStarted: decode.startedMonotonicMs,
            xmlParseStarted: decode.xmlParseStartedMonotonicMs, xmlParseEnded: decode.xmlParseEndedMonotonicMs,
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
const seismicPlace = executionPlaces["U-Q"];
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
  // P3-SP-AC07: T4 は SSE に書いた時だけ出るので、/events を 1 本購読して読み捨てる。
  const events = await new Promise<ClientRequest>((done) => {
    const request = get({ host: "127.0.0.1", port: started.displayPort, path: "/events", agent: false }, (response) => {
      response.resume();
      done(request);
    });
  });
  cleanups.push(() => { events.destroy(); });
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
const sameVersion = (left: DisplayVersion, right: DisplayVersion) =>
  left.streamId === right.streamId && left.semanticRevision === right.semanticRevision && left.sequence === right.sequence;
// 投入する EEW（VXSE45）と津波警報の発令（VTSE41）。event を毎回替えて、どれも新しい報として採用させる。
const eewBody = text("77_01_01_240613_VXSE45"), tsunamiBody = text("32-39_11_02_250206_VTSE41");
let probeSerial = 0;
const probes = {
  // EEW は投入の時刻へ全時刻を動かす（古い報は表示されず T3・T4 が出ない）。
  eew: () => frame("VXSE45", shiftTimestamps(withEvent(eewBody, String(20240101000000 + ++probeSerial)),
    Math.floor(clock().wallTimeMs / 1000) * 1000 - Date.parse("2024-04-17T23:14:57+09:00"))),
  tsunami: () => frame("VTSE41", withEvent(tsunamiBody, String(20110311000000 + ++probeSerial))),
} as const;

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
  // P3-SP-AC07: 入力を載せた T3 は、返信が publisher に届いてから processing の終わりまでの最後の T3（射影は返信の反映と同じ同期の流れ）。
  // 見つからなければ null（欠測）。
  const t3Of = (inputId: string) => {
    const arrival = owners.arrivals.get(inputId), done = processingOf(inputId);
    if (arrival == null || done == null) return null;
    return observations.flatMap((o) => o.kind === "marker" && o.point === "T3" && o.monotonicMs >= arrival.at
      && o.monotonicMs <= done.endedMonotonicMs ? [o] : []).at(-1) ?? null;
  };
  const t4Of = (inputId: string) => {
    const t3 = t3Of(inputId);
    return t3 == null ? null : observations.flatMap((o) => o.kind === "marker" && o.point === "T4"
      && sameVersion(o.displayVersion, t3.displayVersion) ? [o.monotonicMs] : [])[0] ?? null;
  };
  // P3-SP-AC01: 対象処理の区分。(a1) 解凍・展開 (a2) XML parse (a3) 取り出し (b) reduce (c) view の生成と返信の複製（T3 までの上界）。
  const sections = (inputId: string) => {
    const arrival = owners.arrivals.get(inputId)!;
    const between = (from: number | null, to: number | null) => from == null || to == null ? null : to - from;
    return { a1: between(arrival.decodeStarted, arrival.xmlParseStarted), a2: between(arrival.xmlParseStarted, arrival.xmlParseEnded),
      a3: between(arrival.xmlParseEnded, arrival.decodeEnded), b: between(arrival.decodeEnded, arrival.raised),
      c: between(arrival.raised, t3Of(inputId)?.monotonicMs ?? null) };
  };
  // 投入→T0・T0→T2・合計（投入→T2）・T2→T4、busyMs（対象処理の区間＝U-Q の場所が塞がり書込み権の出ない時間）、受信前回収で送出が遅れた量。
  // overlapped は投入時刻が対象処理の区間 [start, end) に入ったこと（遅れた T0 では判定しない）。
  const row = (eew: string, injectedAt: number, target: Readonly<{ start: number; end: number }>, extra: Record<string, number | null> = {}) => {
    const t0 = marker(observations, "T0", eew)!, t1 = marker(observations, "T1", eew)!, t2 = marker(observations, "T2", eew)!;
    const free = Math.max(target.end, t1), t4 = t4Of(eew);
    return { overlapped: target.start <= injectedAt && injectedAt < target.end ? 1 : 0, injectToT0: t0 - injectedAt, t0ToT2: t2 - t0,
      injectToT2: t2 - injectedAt, t2ToT4: t4 == null ? null : t4 - t2, busyMs: target.end - target.start,
      sendDelayAfterFreeMs: Math.max(0, (postedAt(eew) ?? free) - free), ...extra };
  };
  const results: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  // 重なった試行が required 件に届かなければ測定不成立（数字を出さずに止める）。
  const record = (name: string, rows: readonly Record<string, number | null>[], required: number) => {
    const overlapped = rows.filter((item) => item.overlapped === 1);
    if (overlapped.length < required)
      throw new Error(`${name}: measurement not established (${overlapped.length}/${rows.length} overlapped) ${JSON.stringify(rows)}`);
    results[name] = { all: summary(rows), overlapped: summary(overlapped), overlappedCount: overlapped.length, tried: rows.length,
      delayedEewSends: rows.filter((item) => (item.sendDelayAfterFreeMs ?? 0) > 1).length,
      missingT4: rows.filter((item) => item.t2ToT4 == null).length };
    raw[name] = rows;
  };
  return { processingOf, sections, row, record, results, raw };
}

describe.runIf(process.env.FLEQ_C7_AC12 === "1")("P3-C7-AC12 U-Q interference report (Mac)", () => {
  const runs = Number(process.env.FLEQ_C7_AC12_RUNS ?? 20);
  const s53 = text("telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825");

  it("measures the longest U-Q work and the EEW and tsunami waits behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0;

    // (1)(2) 最大の VXSE53（200,380 byte）と最大の VXSE62（78,810 byte）: work と EEW（または津波）を投入側から続けて送る。対象処理の
    // 区間は work の投入から work の処理の終わりまで。
    const behindWork = async (name: string, make: (index: number) => [string, string]) => {
      const rows: Record<keyof typeof probes, Record<string, number | null>[]> = { eew: [], tsunami: [] };
      for (let index = 0; index < runs; index++) for (const probe of ["eew", "tsunami"] as const) {
        const work = `input-${++sequence}`, target = `input-${++sequence}`;
        const [workAt, injectedAt] = await h.sender.send([frame(...make(index)), probes[probe]()]);
        await until(() => m.processingOf(target) != null && m.processingOf(work) != null);
        const done = m.processingOf(work)!;
        rows[probe].push(m.row(target, injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
          workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, ...m.sections(work) }));
      }
      m.record(name, rows.eew, Math.ceil(runs / 2));
      m.record(`${name}Tsunami`, rows.tsunami, Math.ceil(runs / 2));
    };
    const s62 = text("telegram-foundation/phase7_5_VXSE62_20260728162718_f9786edc27df");
    let sent = 0;
    await behindWork("maxVxse53", () => ["VXSE53", withEvent(s53, `M53${String(++sent).padStart(11, "0")}`)]);
    await behindWork("maxVxse62", () => ["VXSE62", withEvent(s62, `M62${String(++sent).padStart(11, "0")}`)]);

    // (3) 最大の U-Q の保存の encode: 最大の VXSE53 の event を 4 MiB 近くまで積み、続報で保存させる。work の返信の後に U-Q の場所へ
    // U-Q の書込み権（checkpointGrant）を送った瞬間に EEW（または津波）を投入する。対象処理の区間はその権を送ってから U-Q の encode が
    // 終わるまで（owner はその間ほかの入力を処理できない）。
    const pile = async (index: number) => {
      const input = `input-${++sequence}`;
      await h.sender.send([frame("VXSE53", withEvent(s53, `F53${String(index).padStart(11, "0")}`))]);
      await until(() => m.processingOf(input) != null);
      return input;
    };
    for (let index = 0; index < 12; index++) await pile(index);
    // 続報は報時刻・Serial と一緒に Control/DateTime も同じだけ進める（VXSE53 の新旧は Control/DateTime で決まる、P3-VM-AC03。進めないと
    // 版の衝突で held になり、採用の経路を測らない）。送った続報は最後に reducer で採用（changed）を確かめる。
    let minute = 0;
    const followUps: string[] = [];
    const later = () => {
      const at = `2026-07-28T${String(17 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+09:00`;
      const xml = s53.replace(/2026-07-28T16:35:00\+09:00/g, at).replace("<Serial>2</Serial>", `<Serial>${++minute + 2}</Serial>`);
      followUps.push(sentLater(xml, (Date.parse(at) - Date.parse("2026-07-28T16:35:00+09:00")) / 1000));
      return followUps.at(-1)!;
    };
    const encodes = () => observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === "U-Q" && o.measurement.stage === "encode"
      ? [{ start: o.measurement.startedMonotonicMs, end: o.measurement.endedMonotonicMs, bytes: o.measurement.bytes }] : []);
    const behindEncode = async (name: string) => {
      const rows: Record<keyof typeof probes, Record<string, number | null>[]> = { eew: [], tsunami: [] };
      for (let index = 0; index < runs; index++) for (const probe of ["eew", "tsunami"] as const) {
        const work = `input-${++sequence}`, target = `input-${++sequence}`;
        // この work の保存: work の返信の後に U-Q の場所へ送った最初の U-Q の書込み権と、その後に始まった最初の U-Q の encode。
        let injected: Promise<Readonly<{ granted: number; injectedAt: number }>> | null = null;
        owners.onGrant = (place, unit) => {
          if (injected != null || place !== seismicPlace || unit !== "U-Q" || !owners.arrivals.has(work)) return;
          const granted = performance.now();
          injected = h.sender.send([probes[probe]()]).then(([injectedAt]) => ({ granted, injectedAt }));
        };
        await h.sender.send([frame("VXSE53", withEvent(later(), "F5300000000000"))]);
        await until(() => injected != null);
        const { granted, injectedAt } = await injected!;
        owners.onGrant = null;
        const encodeOf = () => encodes().find((item) => item.start >= granted);
        await until(() => m.processingOf(target) != null && encodeOf() != null);
        const encode = encodeOf()!;
        rows[probe].push(m.row(target, injectedAt, { start: granted, end: encode.end }, { encodeMs: encode.end - encode.start,
          encodeBytes: encode.bytes }));
      }
      m.record(name, rows.eew, Math.ceil(runs / 2));
      m.record(`${name}Tsunami`, rows.tsunami, Math.ceil(runs / 2));
    };
    await behindEncode("maxCheckpointEncode");
    // P3-SP-AC01 (d) の参考（Q-SP-PRECHECK (7)(a)）: 最大の VXSE53 を器（U-Q 15,498,754 byte）に届くまで積み（encode の byte が 3 回続けて
    // 増えなければ届いたとみなす）、器いっぱいの U-Q の encode を同じ形で測る。
    let largest = 0, flat = 0;
    for (let index = 12; index < 200 && flat < 3; index++) {
      const input = await pile(index), arrivedAt = owners.arrivals.get(input)!.at;
      await until(() => encodes().some((item) => item.start >= arrivedAt));
      const bytes = encodes().at(-1)!.bytes;
      flat = bytes > largest ? 0 : flat + 1;
      largest = Math.max(largest, bytes);
    }
    await behindEncode("fullCheckpointEncode");
    await h.stop();
    // 続報の採用: 同じ event の最初の報から、送った続報の順に reducer へ通す（owner の中の判定は見えないので、同じ XML と同じ壁時計で確かめる）。
    let quake = receive(emptyState(), decodeXml(withEvent(s53, "F5300000000000"), "VXSE53"), fixtureClock(clock().wallTimeMs)).state;
    const followDecisions = followUps.map((xml) => {
      const step = receive(quake, decodeXml(withEvent(xml, "F5300000000000"), "VXSE53"), fixtureClock(clock().wallTimeMs));
      quake = step.state;
      return step.decisions.find((d) => d.subject === "normal/VXSE53/F5300000000000")?.decision ?? "none";
    });
    const adopted = followDecisions.filter((d) => d === "changed").length;
    console.info("P3-C7-AC12-FOLLOW", JSON.stringify({ followUps: followUps.length, adopted, decisions: [...new Set(followDecisions)] }));
    if (adopted !== followUps.length) throw new Error(`follow-ups not adopted: ${adopted}/${followUps.length}`);
    console.info("P3-C7-AC12-RAW", JSON.stringify(m.raw));
    console.info("P3-C7-AC12", JSON.stringify({ runs, seismicPlace, largestEncodeBytes: largest, results: m.results }));
  }, 900_000);

  // P3-SP-AC01・AC07: 観測点 30,000 の VXSE53 を空の state の host で受ける区分と、その最中に投入した EEW・津波の待ち。試行ごとに空の host で
  // 組む（観測点 30,000 の記録は 3 件で器に届くので、同じ host に積まない）。対象処理の区間は work の投入から work の処理の終わりまで。
  it("measures the sections of a 30,000-station VXSE53 and the EEW and tsunami waits behind it", async () => {
    const wideRuns = Number(process.env.FLEQ_SP_WIDE_RUNS ?? 5);
    const wide = stations30k(s53);
    const rows: Record<keyof typeof probes, Record<string, number | null>[]> = { eew: [], tsunami: [] };
    for (let trial = 0; trial < wideRuns; trial++) for (const probe of ["eew", "tsunami"] as const) {
      const observations: P2HostObservation[] = [];
      const h = await host(observations);
      const m = measurer(observations);
      const [workAt, injectedAt] = await h.sender.send([frame("VXSE53", wide), probes[probe]()]);
      await until(() => m.processingOf("input-1") != null && m.processingOf("input-2") != null, 120_000);
      const done = m.processingOf("input-1")!;
      rows[probe].push(m.row("input-2", injectedAt, { start: workAt, end: done.endedMonotonicMs }, {
        workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs, ...m.sections("input-1") }));
      await h.stop();
    }
    const report = measurer([]);
    report.record("wideVxse53", rows.eew, Math.ceil(wideRuns / 2));
    report.record("wideVxse53Tsunami", rows.tsunami, Math.ceil(wideRuns / 2));
    console.info("P3-SP-AC01-WIDE-RAW", JSON.stringify(report.raw));
    console.info("P3-SP-AC01-WIDE", JSON.stringify({ runs: wideRuns, seismicPlace, xmlBytes: Buffer.byteLength(wide), frameBytes: Buffer.byteLength(frame("VXSE53", wide)),
      stations: wide.match(/<IntensityStation>/g)?.length, results: report.results }));
  }, 900_000);

  // P3-QC-AC11 (3)（P3-UNIT-Q-CAPACITY-001）: 器いっぱいに畳める観測点を持つ守らない記録（最大の実例の VXSE53 を震度 4 にした 17 件）の
  // state に、観測点で器の大きさに近い守らない VXSE53（観測点 30,000）を受け、両方の側の観測点を畳む受信と、その最中に投入した EEW の待ち。
  // 試行ごとに空の host で組む（畳んだ記録は観測点が戻るまで畳まれないため）。対象処理の区間は work の投入から work の処理の終わりまで。
  it("measures the widest fold of U-Q stations on urgent and the EEW waits behind it", async () => {
    const foldRuns = Number(process.env.FLEQ_C7_AC12_FOLD_RUNS ?? 4);
    const s53w = s53.replace(/(<\/CodeDefine>\s*<MaxInt>)7(<\/MaxInt>)/, "$14$2");
    const stations = Array.from({ length: 30_000 }, (_, index) => {
      const code = String(9_000_000 + index);
      return `<IntensityStation><Name>観測点${code}</Name><Code>${code}</Code><Int>4</Int></IntensityStation>`;
    }).join("");
    const wide = (eventId: string) => vxse53({ eventId, at: "2026-07-28T16:39:00+09:00", origin: "2026-07-28T16:38:00+09:00", maxInt: "4",
      city: `<City><Name>合成市</Name><Code>9900100</Code><MaxInt>4</MaxInt>${stations}</City>` });
    const rows: Record<string, number | null>[] = [];
    let results: Record<string, unknown> = {};
    for (let trial = 0; trial < foldRuns; trial++) {
      const observations: P2HostObservation[] = [];
      const h = await host(observations);
      const m = measurer(observations);
      let sequence = 0;
      for (let index = 0; index < 17; index++) {
        const sent = `input-${++sequence}`;
        await h.sender.send([frame("VXSE53", withEvent(s53w, `W53${trial}${String(index).padStart(10, "0")}`))]);
        await until(() => m.processingOf(sent) != null);
      }
      const work = `input-${++sequence}`, eew = `input-${++sequence}`;
      const [workAt, injectedAt] = await h.sender.send([frame("VXSE53", wide(`WIDE${trial}`)), probes.eew()]);
      await until(() => m.processingOf(eew) != null && m.processingOf(work) != null, 120_000);
      const done = m.processingOf(work)!, arrival = owners.arrivals.get(work)!;
      rows.push(m.row(eew, injectedAt, { start: workAt, end: done.endedMonotonicMs }, { workBusyMs: done.endedMonotonicMs - done.startedMonotonicMs,
        decodeMs: arrival.decodeEnded - arrival.decodeStarted, reduceMs: arrival.raised == null ? null : arrival.raised - arrival.decodeEnded }));
      if (trial === foldRuns - 1) { m.record("widestFold", rows, Math.ceil(foldRuns / 2)); results = m.results; }
      await h.stop();
    }
    console.info("P3-QC-AC11-FOLD", JSON.stringify({ runs: foldRuns, rows, results }));
  }, 900_000);

  // (4) 一括の期限回収（event 512・長周期 256 が同じ時刻に期限）: 空の state の host で組み、U-Q の場所へ期限の要求を送った瞬間に EEW
  // （試行の半分は津波）を投入する。対象処理の区間は期限の要求の送出から期限の処理の返信（deadlineDone）まで。P3-QC-AC11 (3): K11 からは期限切れの記憶への
  // 一括の変換（P3-QC-AC08）を測る。
  it("measures the bulk deadline of 512 events and 256 long-period subjects and the EEW wait behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const m = measurer(observations);
    let sequence = 0;
    const rows: Record<keyof typeof probes, Record<string, number | null>[]> = { eew: [], tsunami: [] };
    const bulkRuns = Number(process.env.FLEQ_C7_AC12_BULK_RUNS ?? 10);
    const lp = text("synthetic_phase4a_VXSE62_special");
    for (let trial = 0; trial < bulkRuns; trial++) {
      const probe = trial % 2 === 0 ? "eew" : "tsunami";
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
      // U-Q の場所は毎 tick ほかの unit の期限でも要求を受けるので、対になる返信はこの要求を送った時点の次の deadlineDone。
      const doneOf = () => owners.deadlineDone.filter((item) => item.place === seismicPlace);
      let doneBefore = 0;
      let injected: Promise<readonly number[]> | null = null;
      owners.onDeadline = (place) => {
        if (place !== seismicPlace || injected != null || clock().wallTimeMs < due) return;
        doneBefore = doneOf().length;
        const deadlinePosted = performance.now();
        injected = h.sender.send([probes[probe]()]).then((at) => [deadlinePosted, ...at]);
      };
      await until(() => injected != null, 30_000);
      const [deadlinePosted, injectedAt] = await injected!;
      owners.onDeadline = null;
      await until(() => m.processingOf(eew) != null && doneOf().length > doneBefore);
      const deadlineDone = doneOf()[doneBefore].at;
      rows[probe].push(m.row(eew, injectedAt, { start: deadlinePosted, end: deadlineDone }, { deadlineMs: deadlineDone - deadlinePosted }));
    }
    m.record("bulkDeadline512And256", rows.eew, Math.ceil(bulkRuns / 4));
    m.record("bulkDeadline512And256Tsunami", rows.tsunami, Math.ceil(bulkRuns / 4));
    await h.stop();
    console.info("P3-C7-AC12-BULK-RAW", JSON.stringify(m.raw));
    console.info("P3-C7-AC12-BULK", JSON.stringify(m.results));
  }, 900_000);
});
