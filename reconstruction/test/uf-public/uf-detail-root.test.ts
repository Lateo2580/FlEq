import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// P3-UFP-AC07: U-F の詳細の口の composition root 側。execution-split の試験経路（同一 process の owner）で確かめる。
const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(harnesses.splice(0).map((h) => h.root.diagnostics.flush()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const body = (name: string, edit: (xml: string) => string = (xml) => xml) => Buffer.from(edit(readFileSync(`test/fixtures/${name}.xml`, "utf8")));
const office = (name: string) => (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
const HIGH = "81_02_01_260605_VPWP50_high_severity";
const BUSY: WeatherTimeseriesDetailResponse = { kind: "error", reason: "busy", revision: null };
const UNAVAILABLE: WeatherTimeseriesDetailResponse = { kind: "error", reason: "unavailable", revision: null };

async function boot() {
  const path = mkdtempSync(join(tmpdir(), "fleq-ufp-"));
  directories.push(path);
  const now = { wallTimeMs: 1_780_650_000_000, monotonicMs: 1 };
  let at = now;
  const published: DisplaySnapshot[] = [];
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "old"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs,
  { clock: () => at, notificationAdapter: manualAdapter().adapter, display: { publish: (snapshot) => { published.push(snapshot); } } });
  harnesses.push(h);
  await startHarness(h, "ufp", at);
  let sequence = 0;
  const input = (headType: string, name: string, xml: Buffer) => envelope("ufp", headType, `${name}-${++sequence}`, xml, at, sequence);
  const detailKinds = () => h.sent.flatMap(({ place, request }) => place === "deferred" && request.kind === "detail" ? [request] : []);
  await submit(h, input("VPWP50", "a", body(HIGH, office("a-office"))));
  const snapshot = published.at(-1)!;
  const index: WeatherTimeseriesDetailRequest = { part: "index", revision: snapshot.current.weatherTimeseries.contentRevision, page: 0 };
  const probe = h.root.requestDetail({ streamId: snapshot.streamId, detail: index });
  await h.settle();
  const listed = await probe.response;
  probe.done();
  if (listed.kind !== "ok" || listed.part !== "index") throw new Error("no index");
  // 最初の subject のページ。ほかの subject が変わってもこの版は変わらない。
  const page: WeatherTimeseriesDetailRequest = { part: "current", id: listed.entries[0].id, revision: listed.entries[0].revision, page: 0 };
  const ask = (detail: WeatherTimeseriesDetailRequest = page, streamId = snapshot.streamId) => h.root.requestDetail({ streamId, detail });
  const base = detailKinds().length;
  return { h, published, input, detailKinds: () => detailKinds().slice(base), ask, index, advance: (ms: number) => { at = { wallTimeMs: at.wallTimeMs + ms, monotonicMs: at.monotonicMs + ms }; return at; },
    now: () => at };
}
const holdDetails = (h: Harness) => h.holdRequests((_place, request) => request.kind === "detail");

describe("P3-UFP-T09 contractBoundary: the publisher's limits and order", () => {
  it("admits 8, answers the 9th busy, and returns a slot only when done is called", async () => {
    const t = await boot();
    holdDetails(t.h);
    const asked = Array.from({ length: 9 }, () => t.ask());
    expect(await asked[8].response).toEqual(BUSY);
    await t.h.settle();
    // 1 件が owner へ行き、残り 7 件は待つ。捨てない。
    expect(t.detailKinds()).toHaveLength(1);
    expect(await Promise.race([asked[1].response, Promise.resolve("pending")])).toBe("pending");
    const refused = t.ask();
    expect(await refused.response).toEqual(BUSY);
    asked[0].done();
    asked[0].done();
    const next = t.ask();
    expect(await Promise.race([next.response, Promise.resolve("pending")])).toBe("pending");
    expect(await t.ask().response).toEqual(BUSY);
  });

  it("times out 2,000 ms after admission, and sends the next only after the late reply of the one still in the owner", async () => {
    const t = await boot();
    const unhold = holdDetails(t.h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = t.ask(), second = t.ask();
    await t.h.settle();
    vi.advanceTimersByTime(1_999);
    expect(await Promise.race([first.response, Promise.resolve("pending")])).toBe("pending");
    vi.advanceTimersByTime(1);
    const timeout: WeatherTimeseriesDetailResponse = { kind: "error", reason: "timeout", revision: null };
    expect(await first.response).toEqual(timeout);
    expect(await second.response).toEqual(timeout);
    // 答えた要求の枠も done まで数えたまま。owner はまだ最初の 1 件を持っている。
    const third = t.ask();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(1);
    unhold();
    t.h.releaseRequests("deferred");
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(2);
    expect(await third.response).toMatchObject({ kind: "ok", part: "current" });
    for (const item of [first, second, third]) item.done();
  });

  it("sends nothing while the deferred owner has an input or an unanswered deadline, and sends after the reply", async () => {
    const t = await boot();
    const release = t.h.hold((place, reply) => place === "deferred" && reply.kind === "inputDone");
    await submit(t.h, t.input("VPWP50", "b", body(HIGH, office("b-office"))));
    const waiting = t.ask();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(0);
    release();
    t.h.release();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(1);
    expect(await waiting.response).toMatchObject({ kind: "ok" });
    waiting.done();
    const unhold = t.h.hold((place, reply) => place === "deferred" && reply.kind === "deadlineDone");
    t.h.root.tick(t.advance(1_000));
    await t.h.settle();
    const blocked = t.ask();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(1);
    unhold();
    t.h.release();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(2);
    expect(await blocked.response).toMatchObject({ kind: "ok" });
    blocked.done();
  });

  it("starts a deferred input still in the mailbox before the detail", async () => {
    const t = await boot();
    expect(t.h.root.mailbox.enqueue(t.input("VPWP50", "c", body(HIGH, office("c-office")))).kind).toBe("accepted");
    const asked = t.ask();
    await t.h.settle();
    const kinds = t.h.sent.flatMap(({ place, request }) => place === "deferred" && (request.kind === "input" || request.kind === "detail") ? [request.kind] : []);
    expect(kinds.slice(-2)).toEqual(["input", "detail"]);
    expect(await asked.response).toMatchObject({ kind: "ok" });
    asked.done();
  });

  it("counts the detail slot in the stall judgement", async () => {
    const t = await boot();
    const control = t.h.root.monitorOwners(t.advance(6_000));
    expect(control.state).toBe("healthy");
    holdDetails(t.h);
    const asked = t.ask();
    await t.h.settle();
    expect(t.h.root.monitorOwners(t.advance(6_000)).state).not.toBe("healthy");
    asked.done();
  });

  it("answers unavailable to the one in the owner and every waiting one when the owner stops, and drops its later reply", async () => {
    const t = await boot();
    const unhold = holdDetails(t.h);
    const inOwner = t.ask(), waiting = t.ask();
    await t.h.settle();
    t.h.root.ownerFailed("deferred", new Error("stopped"));
    expect(await inOwner.response).toEqual(UNAVAILABLE);
    expect(await waiting.response).toEqual(UNAVAILABLE);
    expect(await t.ask().response).toEqual(UNAVAILABLE);
    expect(t.detailKinds()).toHaveLength(1);
    // 止めた後に owner が詳細を処理して返信しても、root は捨てる（例外も次の送出も無い）。
    unhold();
    t.h.releaseRequests("deferred");
    await t.h.settle();
    expect(t.h.failures).toEqual([]);
    expect(t.detailKinds()).toHaveLength(1);
  });

  it("decides the deadline by the clock, not by the timer: a reply after the due time is a timeout, and a waiting one past due is never sent", async () => {
    const t = await boot();
    const unhold = holdDetails(t.h);
    // タイマーは実時間で動かないまま（2 秒は経たない）、注入した時計だけを期限後へ進める。
    const inOwner = t.ask(), waiting = t.ask();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(1);
    t.advance(2_000);
    unhold();
    t.h.releaseRequests("deferred");
    await t.h.settle();
    const timeout: WeatherTimeseriesDetailResponse = { kind: "error", reason: "timeout", revision: null };
    expect(await inOwner.response).toEqual(timeout);
    expect(await waiting.response).toEqual(timeout);
    // 期限後の待ちは owner へ送らない。
    expect(t.detailKinds()).toHaveLength(1);
    // 期限の前なら同じ経路で答えが採られる。
    const fresh = t.ask();
    await t.h.settle();
    expect(await fresh.response).toMatchObject({ kind: "ok" });
    for (const item of [inOwner, waiting, fresh]) item.done();
  });

  it("answers unavailable from the shutdown request on, and a stream id of another run versionChanged without asking the owner", async () => {
    const t = await boot();
    expect(await t.ask(t.index, "another-run").response).toEqual({ kind: "error", reason: "versionChanged", revision: null });
    expect(t.detailKinds()).toHaveLength(0);
    const release = t.h.hold((place, reply) => place === "deferred" && reply.kind === "inputDone");
    await submit(t.h, t.input("VPWP50", "d", body(HIGH, office("d-office"))));
    const waiting = t.ask();
    const stopping = t.h.root.shutdownRuntime(1, t.advance(10));
    expect(await waiting.response).toEqual(UNAVAILABLE);
    expect(await t.ask().response).toEqual(UNAVAILABLE);
    release();
    t.h.release();
    await t.h.settle();
    await stopping;
    expect(t.detailKinds()).toHaveLength(0);
  }, 30_000);

  it("takes a request out of the line when its client leaves", async () => {
    const t = await boot();
    const unhold = holdDetails(t.h);
    const inOwner = t.ask(), leaving = t.ask(), staying = t.ask();
    await t.h.settle();
    leaving.done();
    unhold();
    t.h.releaseRequests("deferred");
    await t.h.settle();
    // owner にいた 1 件と残った 1 件が答えられ、去った 1 件は送られない。
    expect(t.detailKinds()).toHaveLength(2);
    expect(await inOwner.response).toMatchObject({ kind: "ok" });
    expect(await staying.response).toMatchObject({ kind: "ok" });
    for (const item of [inOwner, staying]) item.done();
  });
});

describe("P3-UFP-T11 acceptance: a detail never makes EEW wait", () => {
  it("applies and publishes an EEW while the deferred owner holds a detail", async () => {
    const t = await boot();
    const unhold = holdDetails(t.h);
    const asked = t.ask();
    await t.h.settle();
    expect(t.detailKinds()).toHaveLength(1);
    const before = t.published.length;
    const eew = body("37_01_01_240613_VXSE43", (xml) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2026-06-05T18:00:00+09:00</ReportDateTime>"));
    await submit(t.h, t.input("VXSE43", "eew", eew));
    expect(t.published.length).toBeGreaterThan(before);
    expect(t.published.at(-1)!.current.eew.items.some((item) => item.activeCount > 0)).toBe(true);
    expect(await Promise.race([asked.response, Promise.resolve("pending")])).toBe("pending");
    unhold();
    t.h.releaseRequests("deferred");
    await t.h.settle();
    expect(await asked.response).toMatchObject({ kind: "ok" });
    asked.done();
  });
});
