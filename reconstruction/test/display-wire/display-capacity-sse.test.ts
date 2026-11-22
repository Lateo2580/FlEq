import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { ServerResponse, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { baseInput, projected, quietLosses } from "./display-wire-fixture";

// P4-DISPLAY-CAPACITY-001 の T04（公開の保留）・T05（遅い客の切断）。新しい経路の SSE を startDisplayServer の実物で開き、
// 書いた字は ServerResponse の write で数える（client に届く前の、サーバーが書いた版）。

const WORKER = { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } as const;
const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.allSettled(harnesses.splice(0).map((h) => h.root.diagnostics.flush()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

// 書いた字の記録と、試験が決める write の結果（controlled の response は書かずに false を返す。drain は試験が emit する）。
function recordWrites() {
  const written = new Map<ServerResponse, string[]>(), controlled = new Set<ServerResponse>(), opened: ServerResponse[] = [];
  const write = ServerResponse.prototype.write, flushHeaders = ServerResponse.prototype.flushHeaders;
  vi.spyOn(ServerResponse.prototype, "flushHeaders").mockImplementation(function (this: ServerResponse) { opened.push(this); flushHeaders.call(this); });
  vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (this: ServerResponse, ...args: Parameters<ServerResponse["write"]>) {
    const [chunk] = args;
    if (typeof chunk === "string") written.set(this, [...written.get(this) ?? [], chunk]);
    return controlled.has(this) ? false : write.apply(this, args);
  });
  // 書いた snapshot の id（heartbeat は数えない）。
  const ids = (response: ServerResponse) => (written.get(response) ?? []).flatMap((text) => /^event: snapshot\nid: (\d+)\n/.exec(text)?.[1] ?? []).map(Number);
  return { opened, controlled, ids };
}
function connect(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/api/display/wire/events", agent: false }, (response) => { response.resume(); response.on("error", () => {}); resolve(response); });
    request.on("error", reject);
  });
}
// 入出力を待つ（setTimeout は試験が偽の時計にしているので使わない）。
const turns = async (check: () => boolean) => { for (let index = 0; index < 2_000 && !check(); index++) await new Promise((resolve) => setImmediate(resolve)); };
async function snapshots() {
  const { input, old } = await baseInput();
  const views = { eew: input.eew, tsunami: input.tsunami, earthquake: input.earthquake, weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries,
    nankai: input.nankai, volcano: input.volcano, landslide: input.landslide, flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins,
    typhoon: input.typhoon };
  const base = projected(projectDisplayWire({ projection: input, views, confirmation: input.confirmation, notices: old.notices, removalLoss: quietLosses }, null)).snapshot;
  return (sequence: number): DisplayWireSnapshot => ({ ...base, sequence });
}

// 受入条件 P4-DC-AC04（表 §4.3・§4.4）。
describe("P4-DC-T04 acceptance: the publication hold", () => {
  it("(c)〜(e) hands a client joining in a hold the last published snapshot, publishes one window 1,000 ms after its first hold, and an urgent one at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { opened, ids } = recordWrites();
    const snapshot = await snapshots();
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: WORKER });
    try {
      const a = await connect(server.port);
      await turns(() => opened.length === 1);
      const [first] = opened;
      server.publishWire(snapshot(1), true);
      server.publishWire(snapshot(2), false);
      expect(ids(first)).toEqual([1]);
      // (c) 保留中につないだ客には最後に公開した 1 通（1）を書き、保留（2）は先に公開しない。
      const b = await connect(server.port);
      await turns(() => opened.length === 2);
      const second = opened[1];
      expect([ids(first), ids(second)]).toEqual([[1], [1]]);
      // (e) 続く通常の更新は保留を置き換えるだけで期限を延ばさない。最初の保留から 1,000ms で最新（3）を全客に書く。
      vi.advanceTimersByTime(500);
      server.publishWire(snapshot(3), false);
      vi.advanceTimersByTime(499);
      expect(ids(first)).toEqual([1]);
      vi.advanceTimersByTime(1);
      expect([ids(first), ids(second)]).toEqual([[1, 3], [1, 3]]);
      // 発火の後の次の通常の更新は新しい窓（もう 1 回 1,000ms 以内）で公開する。
      vi.advanceTimersByTime(200);
      server.publishWire(snapshot(4), false);
      vi.advanceTimersByTime(600);
      server.publishWire(snapshot(5), false);
      vi.advanceTimersByTime(399);
      expect(ids(first)).toEqual([1, 3]);
      vi.advanceTimersByTime(1);
      expect(ids(first)).toEqual([1, 3, 5]);
      // (d) 保留中の緊急の更新は待たずに公開し、保留と timer を捨てる。6 の古い期限（1,000ms 後）に、後の保留（8）が前倒しで出ないこと
      // （取り消した timer が発火しない、AC04 (3)）を見る。8 は自分の窓の 1,000ms で出る。
      server.publishWire(snapshot(6), false);
      server.publishWire(snapshot(7), true);
      expect(ids(first)).toEqual([1, 3, 5, 7]);
      vi.advanceTimersByTime(500);
      server.publishWire(snapshot(8), false);
      vi.advanceTimersByTime(500);
      expect(ids(first)).toEqual([1, 3, 5, 7]);
      vi.advanceTimersByTime(500);
      expect([ids(first), ids(second)]).toEqual([[1, 3, 5, 7, 8], [1, 3, 5, 7, 8]]);
      // flushWire は保留が無ければ何もしない。
      server.flushWire();
      expect(ids(first)).toEqual([1, 3, 5, 7, 8]);
      for (const response of [a, b]) response.destroy();
    } finally {
      await server.close();
    }
  });

  // composition root の harness（host の配線は E0 発注 2）。表示の口を新しい経路の実物の server につなぐ。
  async function boot(server: Awaited<ReturnType<typeof startDisplayServer>>, startMs: number) {
    const path = mkdtempSync(join(tmpdir(), "fleq-dc-"));
    directories.push(path);
    let at = { wallTimeMs: startMs, monotonicMs: 1 };
    const calls: string[] = [], wires: DisplayWireSnapshot[] = [], flushed: (() => void)[] = [];
    const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"), legacyStateDirectory: join(path, "old"),
      diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs, { clock: () => at, notificationAdapter: manualAdapter().adapter,
      display: { publish: () => {}, publishWire: (snapshot, urgent) => { calls.push(urgent ? "urgent" : "held"); wires.push(snapshot); server.publishWire(snapshot, urgent); },
        flushWire: () => { calls.push("flush"); server.flushWire(); for (const look of flushed) look(); } } });
    harnesses.push(h);
    await startHarness(h, "dc", at);
    let sequence = 0;
    const send = (headType: string, xml: string) => submit(h, envelope("dc", headType, `dc-${++sequence}`, Buffer.from(xml), at, sequence));
    return { h, calls, wires, flushed, send, move: (ms: number) => { at = { wallTimeMs: at.wallTimeMs + ms, monotonicMs: at.monotonicMs + ms }; return at; } };
  }
  const VPBS50 = readFileSync("test/fixtures/82_01_01_260324_VPBS50.xml", "utf8");
  // 同じ系列の続報（Serial を進め、送信と報の時刻を 10 分後へ、見出しの字を替える）。
  const followUp = VPBS50.replace("<Serial>2</Serial>", "<Serial>3</Serial>").replace("2023-09-08T01:19:55Z", "2023-09-08T01:29:55Z")
    .replace(/2023-09-08T10:19:00\+09:00/g, "2023-09-08T10:29:00+09:00").replace("命に危険が及ぶ", "命の危険が及ぶ");
  const START = Date.parse("2023-09-08T10:20:00+09:00");

  it("(a) answers 409 for a held item's old revision and 200 for the revision of the next publication", async () => {
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: WORKER });
    try {
      const t = await boot(server, START);
      const { opened, ids } = recordWrites();
      const stream = await connect(server.port);
      await turns(() => opened.length === 1);
      await t.send("VPBS50", VPBS50);
      server.flushWire();
      const shown = t.wires.at(-1)!, item = shown.current.briefing.delivery === "full" ? shown.current.briefing.wire.items[0] : null;
      expect(ids(opened[0]).at(-1)).toBe(shown.sequence);
      if (item == null) throw new Error("U-B item");
      t.move(600_000);
      await t.send("VPBS50", followUp);
      expect(t.calls.at(-1)).toBe("held");
      const ask = async (revision: string) => {
        const asked = t.h.root.requestDetail({ streamId: shown.streamId, detail: { unit: "U-B", part: "item", id: item.id, revision } });
        await t.h.settle();
        const response = await asked.response;
        asked.done();
        return response;
      };
      // 画面は保留の前の版（item.rev）のまま。owner の版は先に進んでいる。
      expect(await ask(item.rev)).toMatchObject({ kind: "error", reason: "versionChanged" });
      server.flushWire();
      const next = t.wires.at(-1)!, nextItem = next.current.briefing.delivery === "full" ? next.current.briefing.wire.items[0] : null;
      expect(ids(opened[0]).at(-1)).toBe(next.sequence);
      expect([nextItem?.id, nextItem?.rev === item.rev]).toEqual([item.id, false]);
      expect(await ask(nextItem!.rev)).toMatchObject({ kind: "ok", part: "item", id: item.id });
      stream.destroy();
    } finally {
      await server.close();
    }
  });

  it("(b) publishes the held update at the shutdown completion after an owner stopped first, and no publication follows the close", async () => {
    // 停止の段の期限（timer）は偽の時計を進めて越える。harness の settle は setImmediate と実の時計で待つ。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: WORKER });
    let closed = false;
    try {
      const t = await boot(server, START);
      const { opened, ids } = recordWrites();
      const stream = await connect(server.port);
      await turns(() => opened.length === 1);
      // owner が 1 つ先に止まり、監視が worker を stopped にする（U-B の owner は動いたまま）。
      t.h.root.ownerFailed("urgent", new Error("stopped"));
      t.h.root.setWorker(t.h.root.monitorOwners(t.move(1_000)));
      await t.h.settle();
      await t.send("VPBS50", VPBS50);
      server.flushWire();
      const before = t.calls.length;
      // root が flushWire を呼んだ時点で、最後に書いた 1 通が最後に射影した snapshot（保留の分）になっている。
      const atFlush: [number | undefined, number | undefined][] = [];
      t.flushed.push(() => atFlush.push([ids(opened[0]).at(-1), t.wires.at(-1)?.sequence]));
      // 停止の要求。U-B の記録は停止の確定で期限を過ぎ、その差分（expired、待つ側）が保留に入る。停止の完了は表示が同じで unchanged。
      let stopped = false;
      void t.h.root.shutdownRuntime(0, t.move(3 * 86_400_000)).then(() => { stopped = true; });
      while (!stopped) await vi.advanceTimersByTimeAsync(500);
      await t.h.settle();
      expect(t.h.root.state.shutdown.stage).toBe("completed");
      const calls = t.calls.slice(before);
      expect(calls.indexOf("held")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("flush")).toBeGreaterThan(calls.indexOf("held"));
      expect(atFlush.length).toBeGreaterThan(0);
      expect(atFlush.every(([written, last]) => written === last)).toBe(true);
      // close の前に最後に書いた 1 通は最後に射影した snapshot（保留の分を含む）。
      expect(ids(opened[0]).at(-1)).toBe(t.wires.at(-1)!.sequence);
      const written = ids(opened[0]).length;
      stream.destroy();
      await server.close();
      closed = true;
      // 最初の保留から 1,000ms の古い期限の後まで進めても、取り消した timer は発火しない。
      vi.advanceTimersByTime(5_000);
      expect(ids(opened[0])).toHaveLength(written);
    } finally {
      if (!closed) await server.close();
    }
  });
});

// 契約境界 P4-DC-AC05（O11:6 の SSE の側、表 §5）。write は書かずに false を返し、drain は試験が出す。
describe("P4-DC-T05 contractBoundary: slow clients", () => {
  async function open(clients: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const record = recordWrites();
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: WORKER });
    const streams: IncomingMessage[] = [];
    for (let index = 0; index < clients; index++) streams.push(await connect(server.port));
    await turns(() => record.opened.length === clients);
    const snapshot = await snapshots();
    let sequence = 0, now = 0;
    const publish = () => server.publishWire(snapshot(++sequence), true);
    const to = (ms: number) => { vi.advanceTimersByTime(ms - now); now = ms; };
    return { server, streams, ...record, publish, to, close: async () => { for (const stream of streams) stream.destroy(); await server.close(); } };
  }

  it("keeps a client that drains before every next publication even though every write returns false", async () => {
    const t = await open(1);
    const [slow] = t.opened;
    t.controlled.add(slow);
    try {
      for (let at = 0; at <= 6_000; at += 500) { t.to(at); t.publish(); t.to(at + 400); slow.emit("drain"); }
      t.to(12_000);
      expect([slow.destroyed, t.ids(slow)]).toEqual([false, Array.from({ length: 13 }, (_, index) => index + 1)]);
    } finally { await t.close(); }
  });

  it("cuts a client whose waiting snapshot keeps being overwritten 5 s after the first overwrite", async () => {
    const t = await open(1);
    const [slow] = t.opened;
    t.controlled.add(slow);
    try {
      t.publish();
      t.to(300); t.publish();
      t.to(600); t.publish();
      for (let at = 800; at < 5_600; at += 200) { t.to(at); slow.emit("drain"); t.to(at + 50); t.publish(); t.to(at + 100); t.publish(); }
      t.to(5_599);
      expect(slow.destroyed).toBe(false);
      t.to(5_600);
      expect(slow.destroyed).toBe(true);
    } finally { await t.close(); }
  });

  it("keeps a client that skipped a version once and then drains without overwrites (the skip clears on the next drain)", async () => {
    const t = await open(1);
    const [slow] = t.opened;
    t.controlled.add(slow);
    try {
      // t=0 に A を書いて false、B を待ちに置き、C で上書き（版の飛びの始まり 10ms）。以後 20ms ごとの drain の直前に 1 通ずつ来て毎回書けて false。
      t.publish();
      t.to(5); t.publish();
      t.to(10); t.publish();
      for (let at = 20; at <= 6_000; at += 20) { t.to(at); slow.emit("drain"); t.to(at + 19); t.publish(); }
      t.to(6_100);
      expect(slow.destroyed).toBe(false);
      expect(t.ids(slow).at(-1)).toBe(t.ids(slow).length + 1);
    } finally { await t.close(); }
  });

  it("cuts a client whose one write never drains 5 s later, keeps a healthy client of a big snapshot, and the slow one does not hold the others", async () => {
    const t = await open(3);
    const [stuck, healthy, other] = t.opened;
    t.controlled.add(stuck); t.controlled.add(healthy);
    try {
      t.publish();
      t.to(20); healthy.emit("drain");
      t.controlled.delete(healthy); // 排出した後の健康な客は書ける
      t.to(4_999);
      expect([stuck.destroyed, healthy.destroyed]).toEqual([false, false]);
      t.to(5_000);
      expect([stuck.destroyed, healthy.destroyed]).toEqual([true, false]);
      // 遅い客がいる間も、ほかの client は公開ごとに書き続ける（spec:1405）。
      t.publish(); t.publish();
      expect(t.ids(other)).toEqual([1, 2, 3]);
      t.to(12_000);
      expect(healthy.destroyed).toBe(false);
    } finally { await t.close(); }
  });
});
