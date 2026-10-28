import { EventEmitter } from "node:events";
import { promises as fileSystem, readFileSync } from "node:fs";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InputBoundary } from "../../contracts/p2-shared-runtime.types";
import type { ListHead, PollResult, PoolPosition, UnitWalk, UnitWalkResult } from "../../contracts/p3-recovery.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { BodyRequestLane, ListRequestLane, bodiesFor, buildDigest, fetchBody, pollClassification, walkDiagnostics, walkList, walkStart, windowOf } from "../../src/recovery/recovery";
import { ingestXmlData } from "../../src/ingress/ingress";
import { FreshnessLedger } from "../../src/recovery/watch";
import { envelope, harnessedRoot, startHarness } from "../execution-split/owner-harness";
import { decode, projected, projectionInput, startup } from "../snapshot-sse/projection-fixture";
import { projectSnapshot } from "../../src/view-projector/view-projector";

// node:https は網へ出ない。要求ごとに試験の handler が答え、その時刻（偽の時計）と path を残す（P3-REC-T01）。
// delayMs: その時間の後に答える（null は答えない）。parseMs: 答える間に歩きの時計だけを進める（同期の処理で timer が走る前に時間が過ぎる形）。
// raw は本文（data.api.dmdata.jp/v1）の応答の bytes（【発注 3】）。
type Reply = Readonly<{ status: number; body?: unknown; raw?: Buffer; headers?: Readonly<Record<string, string>>; delayMs?: number | null; parseMs?: number }>;
const https = vi.hoisted(() => ({ handle: null as ((url: URL) => Reply) | null, requests: [] as { url: URL; at: number; auth: unknown; headers: unknown }[],
  skewMs: 0 }));
vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { request: (options: RequestOptions, onResponse: (response: EventEmitter) => void) => {
    const outgoing = Object.assign(new Emitter(), { destroy: () => {}, end: () => {
      const url = new URL(`https://${options.hostname}${options.path}`);
      https.requests.push({ url, at: performance.now(), auth: Object.entries(options.headers ?? {}).find(([name]) => name === "Authorization")?.[1],
        headers: options.headers });
      const reply = https.handle!(url);
      outgoing.emit("finish");
      const respond = () => {
        https.skewMs += reply.parseMs ?? 0;
        const response = Object.assign(new Emitter(), { statusCode: reply.status, headers: reply.headers ?? {} });
        onResponse(response);
        if (reply.raw !== undefined) response.emit("data", reply.raw);
        if (reply.body !== undefined) response.emit("data", Buffer.from(JSON.stringify(reply.body)));
        response.emit("end");
        response.emit("close");
      };
      if (reply.delayMs === undefined) respond(); else if (reply.delayMs !== null) setTimeout(respond, reply.delayMs);
    } });
    return outgoing;
  } };
});

afterEach(() => {
  https.handle = null;
  https.requests.length = 0;
  https.skewMs = 0;
  vi.useRealTimers();
});

const API_KEY = "KEY-SECRET-REC";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const real = JSON.parse(readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8")).items[0];
const volcano = JSON.parse(readFileSync("test/fixtures/rest/telegram-list-vfvo50-real.json", "utf8")).items[0];
let serial = 0;
// 実応答の item の写しで、id・型・test・受信時刻だけを替える。
function item(type: string, receivedAtMs: number, change: Readonly<{ id?: string; test?: boolean }> = {}) {
  const base = type.startsWith("VF") ? volcano : real;
  const id = change.id ?? `${(++serial).toString(16).padStart(96, "0")}`;
  // 実応答と同じく url は id から組んだもの（【発注 3】の境界の検査、P3-REC-AC01）。
  return { ...base, id, url: `https://data.api.dmdata.jp/v1/${id}`, receivedTime: new Date(receivedAtMs).toISOString(),
    head: { ...base.head, type, test: change.test ?? false } };
}
const page = (items: readonly unknown[], nextToken?: string): Reply =>
  ({ status: 200, body: { status: "ok", items, ...(nextToken == null ? {} : { nextToken }), nextPooling: "pool" } });

// 歩きの時計: 偽の timer の時刻に、応答の処理で進めた分を足す。
const now = () => performance.now() + https.skewMs;
async function walk(plan: readonly UnitWalk[]): Promise<readonly UnitWalkResult[]> {
  vi.useFakeTimers({ now: NOW });
  const walking = walkList(new ListRequestLane(), API_KEY, plan, new AbortController().signal, now);
  await vi.runAllTimersAsync();
  return walking;
}
const ids = (heads: readonly ListHead[]) => heads.map((head) => head.id);
const gaps = () => https.requests.slice(1).map((request, index) => request.at - https.requests[index].at);

describe("P3-REC-T01 contractBoundary: the list walk (AC01, AC02, AC03)", () => {
  it("pages, the bundle and test filters, the stop time and a list that ends before it; 500 ms between requests", async () => {
    const newest = item("VFVO50", NOW - 10 * MINUTE), next = item("VFVO50", NOW - 2 * DAY), third = item("VFVO51", NOW - 3 * DAY);
    const ended = item("VFVO54", NOW - 4 * DAY);
    https.handle = (url) => {
      const types = url.searchParams.get("type"), cursor = url.searchParams.get("cursorToken");
      if (types === "VFVO50,VFVO51" && cursor == null)
        // 束に無い型（1 型の束の前方一致の形）と test の item は捨てる。
        return page([newest, item("VFVO52", NOW - DAY), item("VFVO50", NOW - DAY, { test: true })], "n1/+=");
      if (types === "VFVO50,VFVO51") return page([next, third, item("VFVO50", NOW - 6 * DAY), item("VFVO50", NOW - 7 * DAY)], "n2");
      return page([ended]);
    };
    const [result] = await walk([{ unit: "U-V", bundles: [["VFVO50", "VFVO51"], ["VFVO54"]], fetchFromMs: NOW - 5 * DAY, stopAtId: null }]);
    expect(result).toMatchObject({ unit: "U-V", kind: "listed" });
    expect(result.kind === "listed" && ids(result.heads)).toEqual([newest.id, next.id, third.id, ended.id]);
    expect(https.requests.map(({ url }) => url.pathname + url.search)).toEqual([
      "/v2/telegram?type=VFVO50,VFVO51&limit=100&formatMode=raw&xmlReport=true",
      "/v2/telegram?type=VFVO50,VFVO51&limit=100&formatMode=raw&xmlReport=true&cursorToken=n1%2F%2B%3D",
      "/v2/telegram?type=VFVO54&limit=100&formatMode=raw&xmlReport=true"]);
    expect(https.requests[0].auth).toBe(`Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`);
    expect(gaps().every((gap) => gap >= 500)).toBe(true);
  });

  it("a repeated nextToken and failures after three retries leave that unit fetchFailed; the next unit is walked; no key or body in the result", async () => {
    https.handle = (url) => {
      const types = url.searchParams.get("type");
      if (types === "VTSE41") return page([item("VTSE41", NOW - MINUTE)], "same");
      if (types === "VFVO50") return { status: 500, body: { status: "error", error: { message: "BODY-TEXT" } } };
      return page([item("VXSE53", NOW - MINUTE)]);
    };
    const results = await walk([{ unit: "U-T", bundles: [["VTSE41"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-V", bundles: [["VFVO50"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-Q", bundles: [["VXSE53"]], fetchFromMs: NOW - DAY, stopAtId: null }]);
    expect(results.map((result) => [result.unit, result.kind === "listed" ? "listed" : result.reason])).toEqual(
      [["U-T", "fetchFailed"], ["U-V", "fetchFailed"], ["U-Q", "listed"]]);
    // VTSE41 は 2 ページ（token の再来で止まる）、VFVO50 は 1＋再試行 3、VXSE53 は 1。
    expect(https.requests.map(({ url }) => url.searchParams.get("type"))).toEqual(["VTSE41", "VTSE41", "VFVO50", "VFVO50", "VFVO50", "VFVO50", "VXSE53"]);
    const diagnostics = walkDiagnostics(results);
    expect(diagnostics).toEqual([{ level: "WARN", component: "recovery", reason: "recoveryFetchFailed", unit: "U-T" },
      { level: "WARN", component: "recovery", reason: "recoveryFetchFailed", unit: "U-V" }]);
    expect(JSON.stringify([results, diagnostics])).not.toMatch(/SECRET|BODY-TEXT/);
  });

  it("429: Retry-After is waited, without it the wait doubles from 1 s; a Retry-After past the 30 s budget ends the walk at once", async () => {
    const throttles: Readonly<Record<string, string>>[] = [{ "retry-after": "2" }, {}, {}];
    https.handle = (url) => {
      const types = url.searchParams.get("type");
      if (types === "VTSE41") { const headers = throttles.shift(); return headers == null ? page([]) : { status: 429, headers }; }
      return { status: 429, headers: { "retry-after": "40" } };
    };
    const results = await walk([{ unit: "U-T", bundles: [["VTSE41"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-V", bundles: [["VFVO50"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-Q", bundles: [["VXSE53"]], fetchFromMs: NOW - DAY, stopAtId: null }]);
    expect(results).toEqual([{ unit: "U-T", kind: "listed", heads: [] },
      { unit: "U-V", kind: "unsatisfied", reason: "fetchFailed", listedPages: 0 },
      { unit: "U-Q", kind: "unsatisfied", reason: "fetchFailed", listedPages: 0 }]);
    expect(https.requests.map(({ url }) => url.searchParams.get("type"))).toEqual(["VTSE41", "VTSE41", "VTSE41", "VTSE41", "VFVO50"]);
    const waits = gaps();
    expect(waits.slice(0, 3).map((gap, index) => gap >= [2_000, 1_000, 2_000][index])).toEqual([true, true, true]);
    expect(waits[3]).toBeGreaterThanOrEqual(500);
  });

  // 実不具合（レビュー r0 ヘルツ P2）: Retry-After 29 の後の要求が答えないと、exchange の 15 秒で t=44 秒まで延びていた。
  // 境目（レビュー r1 ヘルツ P2）: 約 29.9 秒で届いた応答の処理の間に 30 秒を越えると、timer が走る前でも採らない。
  it("the 30 s budget also cuts the request after a Retry-After; an answer after the deadline is not taken", async () => {
    for (const late of [{ delayMs: 1_500 }, { delayMs: 900, parseMs: 200 }]) {
      https.requests.length = 0;
      https.skewMs = 0;
      https.handle = (url) => https.requests.length === 1 ? { status: 429, headers: { "retry-after": "29" } }
        : url.searchParams.get("type") === "VFVO50" ? { ...page([item("VFVO50", NOW - MINUTE)]), ...late } : page([]);
      vi.useFakeTimers({ now: NOW });
      const began = now();
      let endedAt = Infinity;
      const walking = walkList(new ListRequestLane(), API_KEY, [{ unit: "U-V", bundles: [["VFVO50"]], fetchFromMs: NOW - DAY, stopAtId: null },
        { unit: "U-Q", bundles: [["VXSE53"]], fetchFromMs: NOW - DAY, stopAtId: null }], new AbortController().signal, now)
        .then((results) => { endedAt = now(); return results; });
      await vi.runAllTimersAsync();
      expect(await walking).toEqual([{ unit: "U-V", kind: "unsatisfied", reason: "fetchFailed", listedPages: 0 },
        { unit: "U-Q", kind: "unsatisfied", reason: "fetchFailed", listedPages: 0 }]);
      expect(endedAt - began).toBeLessThanOrEqual(30_000 + (late.parseMs ?? 0));
      expect(https.requests).toHaveLength(2);
      vi.useRealTimers();
    }
  });

  it("the page limit (300 requests) in the middle of a unit makes that unit and every later one recoveryLimit, the earlier one stays listed", async () => {
    let token = 0;
    https.handle = (url) => url.searchParams.get("type") === "VTSE41" ? page([item("VTSE41", NOW - MINUTE)])
      : page([item("VXKO50", NOW - MINUTE)], `t${++token}`);
    const results = await walk([{ unit: "U-T", bundles: [["VTSE41"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-R", bundles: [["VXKO50"]], fetchFromMs: NOW - DAY, stopAtId: null },
      { unit: "U-F", bundles: [["VPWP50"]], fetchFromMs: NOW - DAY, stopAtId: null }]);
    expect(https.requests).toHaveLength(300);
    expect(results.slice(1)).toEqual([{ unit: "U-R", kind: "unsatisfied", reason: "recoveryLimit", listedPages: 299 },
      { unit: "U-F", kind: "unsatisfied", reason: "recoveryLimit", listedPages: 0 }]);
    expect(walkDiagnostics(results).map((item) => [item.reason, item.unit])).toEqual([["recoveryLimit", "U-R"], ["recoveryLimit", "U-F"]]);
    // ダイジェストでは上限より後ろの unit は理由だけで、件数を持たない（件数不明、P3-REC-AC04・AC15 (3)）。
    const start = walkStart(null, "empty", NOW);
    expect(buildDigest(results, { "U-T": start, "U-R": start, "U-F": start }).digest.units.map((unit) => unit.kind === "listed"
      ? [unit.unit, unit.heads.length] : unit)).toEqual([["U-T", 1], { unit: "U-R", beforeWindow: true, kind: "unsatisfied", reason: "recoveryLimit" },
      { unit: "U-F", beforeWindow: true, kind: "unsatisfied", reason: "recoveryLimit" }]);
  });

  it("401/403 stop the walk on the recovery side only: every remaining unit is authRejected, one recoveryAuthRejected", async () => {
    for (const status of [401, 403]) {
      https.requests.length = 0;
      https.handle = () => ({ status });
      const results = await walk([{ unit: "U-T", bundles: [["VTSE41"]], fetchFromMs: NOW - DAY, stopAtId: null },
        { unit: "U-V", bundles: [["VFVO50"]], fetchFromMs: NOW - DAY, stopAtId: null }]);
      expect(https.requests).toHaveLength(1);
      expect(results).toEqual([{ unit: "U-T", kind: "unsatisfied", reason: "authRejected", listedPages: 0 },
        { unit: "U-V", kind: "unsatisfied", reason: "authRejected", listedPages: 0 }]);
      expect(walkDiagnostics(results)).toEqual([{ level: "WARN", component: "recovery", reason: "recoveryAuthRejected" }]);
      vi.useRealTimers();
    }
  });
});

describe("P3-REC-T07 contractBoundary: where the startup walk starts (AC02)", () => {
  const at = (offsetMs: number) => NOW - offsetMs;
  const boundary = (change: Partial<InputBoundary>): InputBoundary =>
    ({ receivedAt: { wallTimeMs: at(DAY), basis: "verified" }, dmdataTime: null, dmdataId: "b".repeat(96), oldestHole: "restarted", ...change });
  const window = at(7 * DAY);

  it("dmdataTime −60 s, a verified receipt −10 min, otherwise 7 days with the mark; a 30-day-old boundary is cut at 7 days", () => {
    const rows = [
      [boundary({ dmdataTime: at(2 * DAY) }), "restored", at(2 * DAY) - MINUTE, at(2 * DAY), false],
      [boundary({}), "restored", at(DAY) - 10 * MINUTE, at(DAY), false],
      [boundary({ receivedAt: { wallTimeMs: at(DAY), basis: "awaiting" } }), "restored", window, window, true],
      [boundary({ receivedAt: { wallTimeMs: at(DAY), basis: "unverified" } }), "restored", window, window, true],
      [boundary({ receivedAt: { wallTimeMs: at(DAY), basis: null } }), "restored", window, window, true],
      [null, "restored", window, window, true],
      [boundary({}), "empty", window, window, true],
      [boundary({}), "unavailable", window, window, true],
      [boundary({ receivedAt: { wallTimeMs: at(30 * DAY), basis: "verified" } }), "restored", window, window, true],
      // 境界は 7 日の内でも、余白を引いた下限を 7 日で切ったら印を付ける（統合担当の決め r1）。
      [boundary({ receivedAt: { wallTimeMs: window + 5 * MINUTE, basis: "verified" } }), "restored", window, window + 5 * MINUTE, true],
    ] as const;
    for (const [from, restoration, fetchFromMs, digestAfterMs, beforeWindow] of rows)
      expect(walkStart(from, restoration, NOW)).toEqual({ fetchFromMs, digestAfterMs, beforeWindow,
        stopAtId: restoration === "restored" && from != null ? "b".repeat(96) : null });
  });

  it("the boundary id found above the lower bound stops the bundle there, the id and older left out", async () => {
    const newer = item("VTSE41", at(MINUTE)), stop = item("VTSE41", at(2 * MINUTE), { id: "b".repeat(96) });
    https.handle = () => page([newer, stop, item("VTSE41", at(3 * MINUTE))], "more");
    const [result] = await walk([{ unit: "U-T", bundles: [["VTSE41"]], fetchFromMs: at(DAY), stopAtId: stop.id }]);
    expect(result.kind === "listed" && ids(result.heads)).toEqual([newer.id]);
    expect(https.requests).toHaveLength(1);
  });

  it("the boundary id found in one bundle bounds the heads of every bundle of the unit (AC15)", async () => {
    const kept = item("VFVO50", at(MINUTE)), older = item("VFVO50", at(3 * MINUTE)), stop = item("VFVO51", at(2 * MINUTE), { id: "b".repeat(96) });
    https.handle = (url) => url.searchParams.get("type") === "VFVO50" ? page([kept, older]) : page([stop]);
    const [result] = await walk([{ unit: "U-V", bundles: [["VFVO50"], ["VFVO51"]], fetchFromMs: at(DAY), stopAtId: stop.id }]);
    expect(result.kind === "listed" && ids(result.heads)).toEqual([kept.id]);
  });

  it("the start comes from the restored replies, not from the current input boundary", async () => {
    const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-rec-"));
    try {
      const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
        legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs);
      await startHarness(h, "run-rec");
      const before = h.root.restoredBoundaries["U-T"];
      const report = decode("32-39_11_09_250206_VTSE41", "VTSE41");
      const { item: queued } = envelope(h.root.state.runId, "VTSE41", report.inputId, report.body, h.clock()).payload;
      h.root.checkpoint.boundaries.queued({ ...queued, origin: "live" }, "verified");
      h.root.checkpoint.boundaries.completed(queued.inputSequence);
      expect(h.root.checkpoint.boundaries.boundary("U-T")).not.toBeNull();
      expect([before, h.root.restoredBoundaries["U-T"]]).toEqual([{ restoration: "empty", boundary: null }, { restoration: "empty", boundary: null }]);
      await h.root.diagnostics.flush();
    } finally { await fileSystem.rm(path, { recursive: true, force: true }); }
  });
});

describe("P3-REC-T08 acceptance (unit side): the digest from walk results (AC15, AC04)", () => {
  it("only heads after the boundary, newest first by unit order; unwalked units keep their reason without a count; within 16,384 bytes", async () => {
    const start = walkStart({ receivedAt: { wallTimeMs: NOW - DAY, basis: "verified" }, dmdataTime: null, dmdataId: null, oldestHole: null }, "restored", NOW + DAY);
    const head = (id: string, headType: string, receivedAtMs: number, headline: string): ListHead => ({ id, unit: headType === "VTSE41" ? "U-T" : "U-V",
      headType, receivedAtMs, operation: "normal", title: "津波予報", headline, reportDateTime: null, infoType: "発表", serial: null, eventId: null,
      controlDateTime: null, controlStatus: "通常", test: false });
    // 境界（NOW − 1 日）の 10 分の余白の中の item は取得するがダイジェストに入れない。
    const margin = head("m", "VTSE41", NOW - DAY - MINUTE, "余白");
    const tsunami = Array.from({ length: 300 }, (_, index) => head(`t${index}`, "VTSE41", NOW - index * MINUTE, "津".repeat(200)));
    const results: UnitWalkResult[] = [{ unit: "U-T", kind: "listed", heads: [margin, ...tsunami].reverse() },
      { unit: "U-V", kind: "listed", heads: [head("v", "VFVO50", NOW, "火山")] },
      { unit: "U-Q", kind: "unsatisfied", reason: "recoveryLimit", listedPages: 300 }];
    const { digest, utf8Bytes } = buildDigest(results, { "U-T": start, "U-V": start, "U-Q": start });
    expect(utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(digest)));
    expect(utf8Bytes).toBeLessThanOrEqual(16_384);
    const [first, second, third] = digest.units;
    if (first.kind !== "listed" || second.kind !== "listed") throw new Error("listed units expected");
    expect(first.heads.length).toBeGreaterThan(0);
    expect(first.heads.map((item) => item.receivedAt)).toEqual(tsunami.slice(0, first.heads.length).map((item) => item.receivedAtMs));
    expect(Buffer.byteLength(JSON.stringify(first.heads[0].headline)) - 2).toBeLessThanOrEqual(256);
    expect(first.heads[0].headline).toMatch(/\[truncated:fieldLimit\]$/);
    // 入らなかった見出しは型ごとの件数で残る。P3-REC-D-DIGEST-BUDGET=D で分野ごとに 3 件までなので、後ろの unit の見出しも載る（T08【発注 2】）。
    expect([first.heads.length, first.omitted]).toEqual([3, { VTSE41: 297 }]);
    expect(second).toMatchObject({ heads: [{ headType: "VFVO50", headline: "火山" }], omitted: {} });
    expect(third).toEqual({ unit: "U-Q", beforeWindow: false, kind: "unsatisfied", reason: "recoveryLimit" });
    // AC16: projector は digest を直列化せず、数えた byte を足すだけで snapshot の byte が合う。
    const started = await startup({ wallTimeMs: NOW, monotonicMs: 1 });
    const shown = projected(projectSnapshot(projectionInput(started, NOW, { recovery: { restoration: started.state.restoration, digest, eewUnverified: null, progress: null },
      recoveryDigestBytes: utf8Bytes }), null));
    expect(shown.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(shown.snapshot)));
    // AC16（レビュー r0 ヘルツ P3）: digest を持つ snapshot へ live の更新を入れても、projector は digest を直列化しない。
    let reads = 0;
    const counted = Object.defineProperty({ ...digest }, "units", { enumerable: true, get: () => { reads += 1; return digest.units; } });
    const input = projectionInput(started, NOW, { recovery: { restoration: started.state.restoration, digest: counted, eewUnverified: null, progress: null }, recoveryDigestBytes: utf8Bytes });
    const published = projected(projectSnapshot(input, null));
    const live = projectSnapshot({ ...input, connection: { state: "connected", disconnectedAt: null, lastInputAt: NOW } }, published.state);
    expect([live.kind, reads]).toEqual(["projected", 0]);
  });
});

describe("P3-REC-T05 acceptance (list side): the H41 classification list (AC13 (1)(2)(6)(7))", () => {
  const position: PoolPosition = { token: "pool0", latestRawReceivedAtMs: NOW - 10 * MINUTE };
  async function poll(lane: ListRequestLane, from: PoolPosition | null): Promise<PollResult> {
    vi.useFakeTimers({ now: NOW });
    const polling = pollClassification(lane, API_KEY, "telegram.earthquake", from, new AbortController().signal, now);
    await vi.runAllTimersAsync();
    return polling;
  }
  const queries = () => https.requests.map(({ url }) => url.searchParams.get("cursorToken"));

  it("without a position a plain query only seeds; the filters ride on every page; raw 100 filtered to 99 still pages back to the unreceived one", async () => {
    https.handle = () => page([item("VXSE53", NOW - MINUTE)]);
    expect(await poll(new ListRequestLane(), null)).toEqual({ kind: "seeded", position: { token: "pool", latestRawReceivedAtMs: NOW - MINUTE } });
    expect(https.requests[0].url.search).toBe("?classification=telegram.earthquake&limit=100&formatMode=raw&xmlReport=true");
    https.requests.length = 0;
    vi.useRealTimers();
    const unreceived = item("VTSE41", NOW - 8 * MINUTE);
    const newest = Array.from({ length: 99 }, (_, index) => item("VXSE53", NOW - index * 1_000));
    https.handle = (url) => url.searchParams.get("cursorToken") === "pool0"
      ? page([...newest, item("VXSE53", NOW - 100_000, { test: true })], "older")
      : page([unreceived, item("VXSE53", NOW - 10 * MINUTE), item("VXSE53", NOW - 11 * MINUTE)]);
    const result = await poll(new ListRequestLane(), position);
    expect(queries()).toEqual(["pool0", "older"]);
    expect(https.requests.every(({ url }) => url.searchParams.get("classification") === "telegram.earthquake")).toBe(true);
    if (result.kind !== "ok") throw new Error("ok expected");
    // 位置の時刻以下の頭（遡りで見えたもの）は比べない。位置は最初の応答の nextPooling と生の最も新しい時刻。
    expect([result.heads.length, result.heads.at(-1)!.id, result.position]).toEqual([100, unreceived.id, { token: "pool", latestRawReceivedAtMs: NOW }]);
  });

  // 実不具合（発注 2 のレビュー ヘルツ P2）: ページの間に重なった受信済みの X の 2 件目が未受信と数えられ、疑いが立った。
  it("the same received id on two valid pages is compared once: no suspicion", async () => {
    const received = item("VXSE53", NOW - 5 * MINUTE, { id: "f".repeat(96) });
    const full = Array.from({ length: 99 }, (_, index) => item("VXSE53", NOW - index * 1_000));
    https.handle = (url) => url.searchParams.get("cursorToken") === "pool0" ? page([...full, received], "older")
      : page([received, item("VXSE53", NOW - 11 * MINUTE)]);
    const result = await poll(new ListRequestLane(), position);
    if (result.kind !== "ok") throw new Error("ok expected");
    const ledger = new FreshnessLedger();
    ledger.received("U-Q", "telegram.earthquake", received.id, 0);
    for (const head of full) ledger.received("U-Q", "telegram.earthquake", head.id, 0);
    ledger.compare("telegram.earthquake", result.heads, 0, 1_000, 1_000);
    expect([result.heads.filter((head) => head.id === received.id).length, ledger.expire(1_000 + 2 * MINUTE)]).toEqual([1, []]);
  });

  it("RES-07 stops at 30 pages and a full page without nextToken cannot be walked: unmatched, position not moved", async () => {
    let token = 0;
    https.handle = () => page(Array.from({ length: 100 }, () => item("VXSE53", NOW - MINUTE)), `t${++token}`);
    expect(await poll(new ListRequestLane(), position)).toEqual({ kind: "unmatched", reason: "pageLimit" });
    expect(https.requests).toHaveLength(30);
    vi.useRealTimers();
    https.handle = () => page(Array.from({ length: 100 }, () => item("VXSE53", NOW - MINUTE)));
    expect(await poll(new ListRequestLane(), position)).toEqual({ kind: "unmatched", reason: "fetchFailed" });
  });

  it("a 429 cycle does not move the position; Retry-After and nextPoolingInterval carry over to the next cycle on the same lane", async () => {
    const lane = new ListRequestLane();
    https.handle = () => ({ status: 429, headers: { "retry-after": "40" } });
    vi.useFakeTimers({ now: NOW });
    const cycles = (async () => {
      const throttled = await pollClassification(lane, API_KEY, "telegram.earthquake", position, new AbortController().signal, now);
      https.handle = () => ({ status: 200, body: { status: "ok", items: [], nextPooling: "pool0", nextPoolingInterval: 1_500 } });
      await new Promise((done) => setTimeout(done, 15_000)); // 次の周期（間の時間は 40 秒より短い）
      const answered = await pollClassification(lane, API_KEY, "telegram.earthquake", position, new AbortController().signal, now);
      return [throttled, answered, await pollClassification(lane, API_KEY, "telegram.earthquake", position, new AbortController().signal, now)];
    })();
    await vi.runAllTimersAsync();
    expect(await cycles).toEqual([{ kind: "unmatched", reason: "throttled" }, { kind: "ok", heads: [], position: { token: "pool0", latestRawReceivedAtMs: position.latestRawReceivedAtMs } },
      { kind: "ok", heads: [], position: { token: "pool0", latestRawReceivedAtMs: position.latestRawReceivedAtMs } }]);
    expect([https.requests.length, gaps()[0] >= 40_000, gaps()[1] >= 1_500]).toEqual([3, true, true]);
  });
});

describe("P3-REC-T08 acceptance (unit side,【発注 2】): P3-REC-D-DIGEST-BUDGET=D", () => {
  const start = walkStart(null, "empty", NOW);
  const long = (unit: ListHead["unit"], headType: string, index: number): ListHead => ({ id: `${unit}-${index}`, unit, headType,
    receivedAtMs: NOW - index * MINUTE, operation: "normal", title: "表".repeat(120), headline: "見".repeat(120), reportDateTime: null, infoType: null,
    serial: null, eventId: null, controlDateTime: null, controlStatus: "通常", test: false });
  const listed = (unit: ListHead["unit"], headType: string, count: number): UnitWalkResult =>
    ({ unit, kind: "listed", heads: Array.from({ length: count }, (_, index) => long(unit, headType, index)) });
  const total = (unit: { kind: string; heads?: readonly unknown[]; omitted?: Readonly<Record<string, number>> }) =>
    (unit.heads?.length ?? 0) + Object.values(unit.omitted ?? {}).reduce((sum, count) => sum + count, 0);

  it("30 long volcano heads keep the newest 3 and count the rest; the later seismic unit still shows its 2 heads", () => {
    const { digest } = buildDigest([listed("U-V", "VFVO50", 30), listed("U-Q", "VXSE53", 2)], { "U-V": start, "U-Q": start });
    const [volcanoUnit, seismicUnit] = digest.units;
    if (volcanoUnit.kind !== "listed" || seismicUnit.kind !== "listed") throw new Error("listed expected");
    expect(Buffer.byteLength(JSON.stringify(volcanoUnit.heads[0]))).toBeGreaterThan(600);
    expect([volcanoUnit.heads.map((head) => head.receivedAt), volcanoUnit.omitted]).toEqual([[NOW, NOW - MINUTE, NOW - 2 * MINUTE], { VFVO50: 27 }]);
    expect([seismicUnit.heads.length, seismicUnit.omitted]).toEqual([2, {}]);
  });

  it("nine units of long heads over 16,384 bytes: the front units 3 each, the back units counts only, totals kept, within the bytes", () => {
    const units = [["U-T", "VTSE41"], ["U-V", "VFVO50"], ["U-Q", "VXSE53"], ["U-N", "VYSE50"], ["U-W", "VPWS50"], ["U-L", "VPWW56"],
      ["U-R", "VXKO50"], ["U-F", "VPWP50"], ["U-B", "VPOA50"]] as const;
    const results = units.map(([unit, type]) => listed(unit, type, 4));
    const { digest, utf8Bytes } = buildDigest(results, Object.fromEntries(units.map(([unit]) => [unit, start])));
    expect(utf8Bytes).toBeLessThanOrEqual(16_384);
    const shown = digest.units.map((unit) => unit.kind === "listed" ? unit.heads.length : -1);
    expect(shown.slice(0, 3)).toEqual([3, 3, 3]);
    expect(shown.at(-1)).toBe(0);
    expect(shown.every((count, index) => index === 0 || count <= shown[index - 1])).toBe(true);
    expect(digest.units.map(total)).toEqual(units.map(() => 4));
  });
});

describe("P3-REC-T12 contractBoundary: the body boundary (AC01, AC05)", () => {
  const listHead = (id: string): ListHead => ({ id, unit: "U-T", headType: "VTSE41", receivedAtMs: NOW, operation: "normal", title: "津波予報",
    headline: null, reportDateTime: null, infoType: null, serial: null, eventId: "20260728162718", controlDateTime: null, controlStatus: "通常", test: false });
  const now = () => performance.now();

  it("a VTSE41 item whose url is not built from its id makes U-T fetchFailed with one WARN; the page is not failed", async () => {
    const bad = { ...item("VTSE41", NOW - MINUTE), url: "https://data.api.dmdata.jp/v1/other" };
    https.handle = () => page([bad, item("VTSE51", NOW - 2 * MINUTE)]);
    const results = await walkList(new ListRequestLane(), API_KEY, [{ unit: "U-T", bundles: [["VTSE41", "VTSE51", "VTSE52"]], fetchFromMs: NOW - DAY,
      stopAtId: null }], new AbortController().signal, now);
    expect(results).toEqual([{ unit: "U-T", kind: "unsatisfied", reason: "fetchFailed", listedPages: 1 }]);
    expect(walkDiagnostics(results)).toEqual([{ level: "WARN", component: "recovery", reason: "recoveryFetchFailed", unit: "U-T" }]);
  });

  it("the body is asked as XML with identity, kept as received bytes; a non-XML content-type or a non-alphanumeric id sends nothing on", async () => {
    const raw = Buffer.concat([readFileSync("test/fixtures/rest/telegram-body-vtse41-real.xml"), Buffer.from([0xff])]);
    https.handle = (url) => url.pathname.endsWith("html") ? { status: 200, raw, headers: { "content-type": "text/html" } }
      : { status: 200, raw, headers: { "content-type": "application/xml; charset=utf-8" } };
    const lane = new BodyRequestLane();
    const got = await fetchBody(lane, API_KEY, listHead("abc123"), new AbortController().signal, now);
    expect(got.kind === "ok" && Buffer.compare(Buffer.from(got.bytes), raw)).toBe(0);
    const [request] = https.requests;
    expect([request.url.host, request.url.pathname, request.headers]).toMatchObject(["data.api.dmdata.jp", "/v1/abc123",
      { Accept: "application/xml", "Accept-Encoding": "identity" }]);
    lane.notBeforeMonotonicMs = -Infinity;
    expect(await fetchBody(lane, API_KEY, listHead("abchtml"), new AbortController().signal, now)).toEqual({ kind: "failed" });
    expect(await fetchBody(lane, API_KEY, listHead("ab/../c"), new AbortController().signal, now)).toEqual({ kind: "failed" });
    expect(https.requests).toHaveLength(2);
    expect(JSON.stringify(https.requests.map((item) => item.url.href))).not.toContain(API_KEY);
  });

  it("the retry budget of 30 s holds across a 429: an answer after it is not taken (r1)", async () => {
    vi.useFakeTimers({ now: NOW });
    let count = 0;
    https.handle = () => ++count === 1 ? { status: 429, delayMs: 14_000 }
      : { status: 200, delayMs: 14_000, raw: Buffer.from("<Report/>"), headers: { "content-type": "application/xml" } };
    const pending = fetchBody(new BodyRequestLane(), API_KEY, listHead("abc"), new AbortController().signal, () => performance.now());
    await vi.advanceTimersByTimeAsync(35_500);
    expect((await pending).kind).toBe("throttled");
  });

  it("a body over 8 MiB is refused without a retry (r1)", async () => {
    https.handle = () => ({ status: 200, raw: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), headers: { "content-type": "application/xml" } });
    expect(await fetchBody(new BodyRequestLane(), API_KEY, listHead("big"), new AbortController().signal, now)).toEqual({ kind: "failed" });
    expect(https.requests).toHaveLength(1);
  });

  it("the REST input carries head.test, control.status and the id: provided evidence and the dmdataId on the mailbox item", () => {
    const entered = ingestXmlData({ kind: "rest", inputId: "input-1", inputSequence: 1, receivedAt: NOW, origin: "recovery", body: Buffer.from("<Report/>"),
      headType: "VTSE41", headTest: false, controlStatus: "訓練", dmdataId: "abc123" });
    expect(entered.kind === "accepted" && [entered.item.headTest, entered.item.envelopeStatus, entered.item.dmdataId])
      .toEqual([{ kind: "provided", value: false }, { kind: "provided", value: "training" }, "abc123"]);
  });
});

// P3-RECOVERY-001 発注 4a: unit の N2（型・最新だけで足りるか・窓。P3-REC-AC12・RES-03、Q-REC-PRECHECK-4 の M1・M4・M5）。
describe("P3-REC-T17 contractBoundary: the N2 bodies of U-V, U-N and U-Q (AC12, RES-03)", () => {
  const head = (id: string, unit: ListHead["unit"], headType: string, eventId: string | null, receivedAtMs: number): ListHead => ({ id, unit, headType,
    receivedAtMs, operation: "normal", title: "t", headline: null, reportDateTime: null, infoType: "発表", serial: null, eventId, controlDateTime: null,
    controlStatus: "通常", test: false });
  const pick = (unit: ListHead["unit"], heads: readonly ListHead[]) => bodiesFor(unit, heads).map((item) => item.id);
  it("U-N keeps every body in receive order; U-V and U-Q keep the latest per type and EventID (VXSE53 and VXSE61 both); 4b units stay out", () => {
    expect(pick("U-N", [head("n2", "U-N", "VYSE50", "E1", 2), head("n1", "U-N", "VYSE50", "E1", 1), head("n3", "U-N", "VYSE60", "E2", 3)])).toEqual(["n1", "n2", "n3"]);
    expect(pick("U-V", [head("v1", "U-V", "VFVO50", "306", 1), head("v2", "U-V", "VFVO50", "306", 2), head("v3", "U-V", "VFVO55", "306", 3),
      head("v4", "U-V", "VFVO52", "306", 4)])).toEqual(["v2", "v3"]);
    expect(pick("U-Q", [head("q1", "U-Q", "VXSE53", "E", 1), head("q2", "U-Q", "VXSE61", "E", 2), head("q3", "U-Q", "VXSE53", "E", 3)])).toEqual(["q2", "q3"]);
    expect(pick("U-W", [head("w", "U-W", "VPWW54", null, 1)])).toEqual([]);
    expect((["U-V", "U-N", "U-Q", "U-T", "U-W"] as const).map((unit) => windowOf(unit) / 3_600_000)).toEqual([720, 720, 42, 168, 168]);
  });
});
