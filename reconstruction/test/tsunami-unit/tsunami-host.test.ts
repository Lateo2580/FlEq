import { promises as fileSystem, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import { startP2Host } from "../../src/host/host";

// TEST-PATH (3): startP2Host の入口（WS frame）から dist の owner thread 3 本まで（P3-C5-AC09・AC13）。owner への要求は
// postMessage の順に記録し、owner からの返信は試験が止めて 1 件ずつ通す（mailbox の選択順を owner に届いた順で見る）。
const owners = vi.hoisted(() => ({ hold: false, held: [] as (() => void)[], live: new Set<{ terminate(): Promise<number> }>(),
  posted: [] as { place: string; kind: string; inputId: string | null; at: number }[] }));
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
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event !== "message" || !owners.hold) return super.emit(event, ...args);
      owners.held.push(() => { super.emit(event, ...args); });
      return true;
    }
  }
  return { ...actual, Worker };
});
// No test reaches dmdata; the WS URL comes from the test's local server.
vi.mock("../../src/host/dmdata-rest", () => ({
  listSockets: () => Promise.resolve({ kind: "failed" }), closeSocket: () => Promise.resolve({ kind: "failed" }),
  startSocket: () => Promise.resolve({ kind: "failed" }),
}));
// The product backends would pop notifications and play sounds; attempts end at once as delivered.
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const BASE_AT = 1_713_363_299_001;
const base = performance.now();
const clock = () => ({ wallTimeMs: BASE_AT + Math.trunc(performance.now() - base), monotonicMs: performance.now() });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  owners.hold = false;
  for (const release of owners.held.splice(0)) release();
  owners.posted.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(() => owners.live.size === 0);
});

async function until(condition: () => boolean, milliseconds = 15_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setImmediate(done));
  }
}
async function host(observations: P2HostObservation[]) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-c5-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  const started = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, stateDirectory: join(path, "state"),
    diagnosticDirectory: join(path, "diagnostics"), displayPort: 0, clock, observe: (item) => { observations.push(item); } });
  cleanups.push(() => started.stop().then(() => {}, () => {}));
  await until(() => sockets.length === 1);
  return { send: (frame: string) => sockets[0].send(frame), socket: () => sockets[0], directory: path, stop: started.stop };
}
function frame(headType: string, body: string, operation: "通常" | "訓練" = "通常"): string {
  return JSON.stringify({ type: "data", version: "2.0", classification: "telegram.earthquake", id: "id", format: "xml", encoding: "utf-8",
    compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: operation !== "通常", xml: true },
    xmlReport: { control: { status: operation } }, body });
}
const text = (file: string) => readFileSync(file.includes("/") ? file : `test/fixtures/${file}.xml`, "utf8");
const withEvent = (xml: string, eventId: string) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
const marker = (observations: readonly P2HostObservation[], point: "T0" | "T1" | "T2", inputId: string) =>
  observations.flatMap((o) => o.kind === "marker" && o.point === point && "inputId" in o && o.inputId === inputId ? [o.monotonicMs] : [])[0];
const urgentInputs = () => owners.posted.filter((item) => item.place === "urgent" && item.kind === "input").map((item) => item.inputId);
// Lets every held reply through, one round at a time, until the condition holds.
async function drain(condition: () => boolean): Promise<void> {
  const end = performance.now() + 20_000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("drain did not reach the condition");
    for (const release of owners.held.splice(0)) release();
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("P3-TSUNAMI-UNIT-001 input priority on the product path", () => {
  // acceptance: P3-C5-AC09 の入力側の優先（予約枠・固定優先・同じ headType の順）を startP2Host の入口から。
  it("P3-C5-T08 acceptance / AC09: VTSE41 takes the reserved lane past a full normal lane and is selected after EEW, before VTSE51", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    owners.hold = true;
    const vtse51 = text("32-39_11_10_250206_VTSE51");
    // input-1: urgent の in-flight（返信は止めてある）。input-2・4: urgent に並ぶ VTSE51、input-3: 確認済み training の VTSE41。
    h.send(frame("VTSE51", vtse51));
    h.send(frame("VTSE51", withEvent(vtse51, "20110311144641")));
    h.send(frame("VTSE41", text("32-39_12_02_250206_VTSE41"), "訓練"));
    h.send(frame("VTSE51", withEvent(vtse51, "20110311144642")));
    // 通常枠（120 件）を weatherCurrent の VPWW57 で埋める（in-flight 1 件と pending 115 件）。
    const weather = text("15_16_02_251222_VPWW57");
    for (let index = 0; index < 116; index++) h.send(frame("VPWW57", weather));
    await until(() => marker(observations, "T1", "input-120") != null);
    // (a) 通常枠が埋まっていても normal の VTSE41（発令・REST 本文の注意報解除・合成の降格）は予約枠で受理される。
    const downgrade = text("32-39_11_09_250206_VTSE41").replace(/<Code>52<\/Code>/g, "<Code>51</Code>");
    h.send(frame("VTSE41", text("32-39_11_02_250206_VTSE41")));
    h.send(frame("VTSE41", text("test/fixtures/rest/telegram-body-vtse41-real.xml")));
    h.send(frame("VTSE41", downgrade));
    // (c) EEW 候補は VTSE41 より先。
    h.send(frame("VXSE43", text("37_01_01_240613_VXSE43")));
    await until(() => ["input-121", "input-122", "input-123", "input-124"].every((id) => marker(observations, "T1", id) != null));
    expect(h.socket().readyState).toBe(1);
    // urgent の in-flight の完了後: EEW → VTSE41 ×3（同じ headType の normal を飛ばさない）→ VTSE51 → training の VTSE41 → VTSE51。
    await drain(() => urgentInputs().length === 8);
    expect(urgentInputs()).toEqual(["input-1", "input-124", "input-121", "input-122", "input-123", "input-2", "input-3", "input-4"]);
    // T0〜T1 は受信の順に並ぶ（observe の記録）。
    const t0 = ["input-120", "input-121", "input-122", "input-123", "input-124"].map((id) => marker(observations, "T0", id)!);
    expect(t0).toEqual([...t0].sort((left, right) => left - right));
    for (const id of ["input-121", "input-122", "input-123", "input-124"])
      expect(marker(observations, "T1", id)!).toBeGreaterThanOrEqual(marker(observations, "T0", id)!);
    owners.hold = false;
    await drain(() => true);
    await h.stop();
  }, 60_000);

  it("P3-C5-T08 acceptance / AC09(d): a confirmed training VTSE41 does not use the reserved lane", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    owners.hold = true;
    const weather = text("15_16_02_251222_VPWW57");
    for (let index = 0; index < 120; index++) h.send(frame("VPWW57", weather));
    await until(() => marker(observations, "T1", "input-120") != null);
    h.send(frame("VTSE41", text("32-39_11_02_250206_VTSE41")));
    await until(() => marker(observations, "T1", "input-121") != null);
    // 通常枠が満杯なので training の VTSE41 は itemLimit で拒否され、host は過負荷として接続を切る（予約枠を使わない）。
    h.send(frame("VTSE41", text("32-39_12_02_250206_VTSE41"), "訓練"));
    await until(() => marker(observations, "T0", "input-122") != null);
    expect(marker(observations, "T1", "input-122")).toBeUndefined();
    await until(() => h.socket().readyState !== 1);
    owners.hold = false;
    await drain(() => true);
    await h.stop();
  }, 60_000);
});

// P3-C5-AC13: urgent で最も長い非中断処理と、その間に投入した EEW の待ち。Mac での報告用で、正式 E01 ではない。
// 通常の試験からは走らせない（FLEQ_C5_AC13=1 の指定のときだけ）。
describe.runIf(process.env.FLEQ_C5_AC13 === "1")("P3-C5-AC13 urgent interference report (Mac)", () => {
  it("measures the longest urgent work and the EEW waits behind it", async () => {
    const observations: P2HostObservation[] = [];
    const h = await host(observations);
    const eewBody = text("37_01_01_240613_VXSE43");
    let sequence = 0;
    const processingOf = (inputId: string) => {
      const found = observations.find((o) => o.kind === "processing" && o.measurement.inputId === inputId);
      return found?.kind === "processing" ? found.measurement : null;
    };
    const postedAt = (inputId: string) => owners.posted.find((item) => item.inputId === inputId)?.at ?? null;
    // afterWork: EEW を work の inputDone の後に送る（work の採用で出た U-T の保存の encode の最中に入れる）。
    const trial = async (headType: string, body: string, afterWork = false) => {
      const work = `input-${++sequence}`;
      h.send(frame(headType, body));
      if (afterWork) await until(() => processingOf(work) != null, 60_000);
      const eew = `input-${++sequence}`;
      h.send(frame("VXSE43", withEvent(eewBody, String(20240417000000 + sequence))));
      await until(() => marker(observations, "T2", eew) != null && processingOf(work) != null, 60_000);
      const decode = observations.find((o) => o.kind === "decode" && o.inputId === work);
      const done = processingOf(work)!;
      // WRITE-RIGHT(6) は代わりの観測で測った: urgent が空いた後（work の inputDone の受信と EEW の T1 の遅い方）から EEW の送出までの遅れ。
      // この測定は U-T の intent が期限切れになる条件を作っていないので、受信前回収が EEW の送出を遅らせた回数は 0（AC13 の報告）。
      const free = Math.max(done.endedMonotonicMs, marker(observations, "T1", eew)!);
      return { decodeMs: decode?.kind === "decode" ? decode.endedMonotonicMs - decode.startedMonotonicMs : null,
        // WRITE-RIGHT(2): urgent が入力を処理している間（T2 から inputDone の受信まで）は U-E・U-T の権が出ない。
        busyMs: done.endedMonotonicMs - done.startedMonotonicMs,
        eewT0ToT1: marker(observations, "T1", eew)! - marker(observations, "T0", eew)!,
        eewT0ToT2: marker(observations, "T2", eew)! - marker(observations, "T0", eew)!,
        sendDelayAfterFreeMs: Math.max(0, (postedAt(eew) ?? free) - free) };
    };
    const vtse41 = text("32-39_12_02_250206_VTSE41").replace("<Status>訓練</Status>", "<Status>通常</Status>");
    const vtse51 = text("32-39_11_10_250206_VTSE51");
    const results: Record<string, ReturnType<typeof summary>> = {};
    const delayed: Record<string, number> = {};
    const runs = Number(process.env.FLEQ_C5_AC13_RUNS ?? 20);
    const collect = async (name: string, make: (index: number) => [string, string], afterWork = false) => {
      const rows = [];
      for (let index = 0; index < runs; index++) rows.push(await trial(...make(index), afterWork));
      results[name] = summary(rows);
      delayed[name] = rows.filter((row) => row.sendDelayAfterFreeMs > 1).length;
    };
    await collect("maxVtse41", (index) => ["VTSE41", withEvent(vtse41, String(20160901071000 + index + 1))]);
    await collect("maxVtse51", (index) => ["VTSE51", withEvent(vtse51, String(20110311144640 + index + 1))]);
    // 最大 U-T の encode: 1000 区域の VTSE41 で state を 4 MiB 近くまで積み、続報（同じ区域・新しい時刻）で保存させる。
    const area = (code: number) => `<Item><Area><Name>${"区".repeat(40)}${code}</Name><Code>${String(code).padStart(3, "0")}</Code></Area>`
      + "<Category><Kind><Name>津波注意報</Name><Code>62</Code></Kind></Category></Item>";
    const giant = (eventId: string, minute: number) => vtse41.replace(/<Body[\s\S]*<\/Body>/, `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">`
      + `<Tsunami><Forecast>${Array.from({ length: 1000 }, (_, code) => area(code)).join("")}</Forecast></Tsunami></Body>`)
      .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>2099-01-01T09:${String(minute).padStart(2, "0")}:00+09:00</ReportDateTime>`);
    // VTSE41 は予約枠（8 件）を使うので、1 件ずつ処理を待って送る。
    for (let index = 0; index < 14; index++) {
      h.send(frame("VTSE41", giant(String(20990101000100 + index), 0)));
      const sent = `input-${++sequence}`;
      await until(() => processingOf(sent) != null, 60_000);
    }
    await collect("maxCheckpointEncode", (index) => ["VTSE41", giant("20990101000100", index + 1)], true);
    const encodes = observations.flatMap((o) => o.kind === "checkpoint" && o.measurement.unit === "U-T" && o.measurement.stage === "encode"
      ? [{ ms: o.measurement.endedMonotonicMs - o.measurement.startedMonotonicMs, bytes: o.measurement.bytes }] : []);
    const largest = encodes.sort((left, right) => right.bytes - left.bytes).slice(0, runs);
    console.info("P3-C5-AC13", JSON.stringify({ runs, results, delayedEewSends: delayed,
      encode: summary(largest.map((item) => ({ ms: item.ms, bytes: item.bytes }))) }));
    await h.stop();
  }, 300_000);
});

function summary<Row extends Record<string, number | null>>(rows: readonly Row[]): Record<string, { max: number; median: number } | null> {
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((key) => {
    const values = rows.map((row) => row[key]).filter((value): value is number => value != null).sort((left, right) => left - right);
    return [key, values.length === 0 ? null : { max: Math.round(values.at(-1)! * 100) / 100,
      median: Math.round(values[Math.floor(values.length / 2)] * 100) / 100 }];
  }));
}
