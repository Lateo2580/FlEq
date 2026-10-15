import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types";
import { serveDetail, startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

const healthy = { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } as const;
const PATH = "/api/display/domains/U-F/detail";
const ID = "a".repeat(64);
const STREAM = "00000000-0000-4000-8000-000000000000";
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fetchText(port: number, path: string): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    }).on("error", reject);
  });
}

// 答えを試験が選ぶ口。受けた要求と done の回数を記録する。
function port(answer: WeatherTimeseriesDetailResponse | Promise<WeatherTimeseriesDetailResponse>) {
  const seen: unknown[] = [];
  const done = vi.fn();
  return { seen, done, detail: (request: unknown) => { seen.push(request); return { response: Promise.resolve(answer), done }; } };
}
async function server(detail?: Parameters<typeof startDisplayServer>[0]["detail"]) {
  const started = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy, detail });
  closers.push(() => started.close());
  return started;
}

describe("P3-UFP-T10 acceptance: the detail path over HTTP", () => {
  const ok: WeatherTimeseriesDetailResponse = { kind: "ok", part: "current", id: ID, revision: "3", page: 0, pageCount: 1, periodCount: 0, periods: [], omitted: [] };
  const current = `${PATH}?streamId=${STREAM}&part=current&id=${ID}&revision=3&page=0`;

  it("maps the root's answers to 200 / 409 / 429 / 503 / 504, with the stream id added and no-store", async () => {
    const expected: [WeatherTimeseriesDetailResponse, number][] = [[ok, 200],
      [{ kind: "error", reason: "versionChanged", revision: "4" }, 409], [{ kind: "error", reason: "busy", revision: null }, 429],
      [{ kind: "error", reason: "unavailable", revision: null }, 503], [{ kind: "error", reason: "timeout", revision: null }, 504]];
    for (const [answer, status] of expected) {
      const fake = port(answer);
      const started = await server(fake.detail);
      const result = await fetchText(started.port, current);
      expect(result.status).toBe(status);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(result.body)).toEqual({ streamId: STREAM, ...answer });
      expect(fake.seen).toEqual([{ streamId: STREAM, detail: { part: "current", id: ID, revision: "3", page: 0 } }]);
      await vi.waitFor(() => expect(fake.done).toHaveBeenCalledTimes(1));
    }
  });

  it("refuses a bad request with 400 before the root sees it, and serves nothing for other paths", async () => {
    const fake = port(ok);
    const started = await server(fake.detail);
    // 先頭は欄を全部正しく保ったまま、長さだけが 1,024 byte を越える URL。
    const bad = [`${current}&pad=${"9".repeat(1_100)}`,
      `${current.replace("page=0", "page=1.5")}`, `${current.replace("page=0", "page=-1")}`, current.replace(ID, "A".repeat(64)),
      current.replace(ID, "a".repeat(63)), current.replace("revision=3", "revision=x"), current.replace("part=current", "part=other"),
      `${PATH}?streamId=${STREAM}&part=current&revision=3&page=0`, `${PATH}?streamId=${STREAM}&part=index&revision=3&page=0`,
      `${PATH}?streamId=${STREAM}&part=index&id=${ID}&revision=3:0&page=0`, `${PATH}?streamId=${STREAM}&part=index&id=&revision=3:0&page=0`, `${current}&page=1`, current.replace(`streamId=${STREAM}`, "streamId="),
      current.replace(`streamId=${STREAM}`, `streamId=${"s".repeat(65)}`)];
    for (const path of bad) {
      const result = await fetchText(started.port, path);
      expect(result.status, path.slice(0, 120)).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
      expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(256);
    }
    expect(fake.seen).toEqual([]);
    expect(Buffer.byteLength(bad[0])).toBeGreaterThan(1_024);
    // 索引の要求の revision は 10 進でなく索引の内容版の形。
    const index = await fetchText(started.port, `${PATH}?streamId=${STREAM}&part=index&revision=12:5&page=2`);
    expect(index.status).toBe(200);
    expect(fake.seen).toEqual([{ streamId: STREAM, detail: { part: "index", revision: "12:5", page: 2 } }]);
    expect((await fetchText(started.port, "/api/display/domains/U-W/detail?x=1")).status).toBe(404);
    expect((await fetchText((await server()).port, current)).status).toBe(404);
  });

  describe("a response nobody drains is cut 2,000 ms after admission", () => {
    class FakeResponse extends EventEmitter {
      status = 0; text = ""; destroyed = false; writableFinished = false;
      constructor(private readonly drains: boolean) { super(); }
      writeHead(status: number) { this.status = status; return this; }
      end(text: string) { this.text = text; if (this.drains) { this.writableFinished = true; this.emit("finish"); } return this; }
      destroy() { this.destroyed = true; this.emit("close"); return this; }
    }
    const serve = (fake: ReturnType<typeof port>, response: FakeResponse, url = current) =>
      serveDetail(fake.detail, { url }, response as unknown as ServerResponse);

    it("closes a connection that stops draining an ok answer, once, and returns the slot once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fake = port(ok), response = new FakeResponse(false);
      serve(fake, response);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(response.status).toBe(200);
      expect(response.destroyed).toBe(false);
      expect(fake.done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(response.destroyed).toBe(true);
      expect(fake.done).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.done).toHaveBeenCalledTimes(1);
    });

    it("writes the root's timeout as 504 at the deadline, and closes at once when that is not drained either", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // root の timer を先に作る（requestDetail と同じ）。HTTP の期限より先に root の答えが決まる。
      const answer = new Promise<WeatherTimeseriesDetailResponse>((resolve) => {
        setTimeout(() => resolve({ kind: "error", reason: "timeout", revision: null }), 2_000);
      });
      const fake = port(answer), response = new FakeResponse(false);
      serve(fake, response);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(response.status).toBe(504);
      expect(JSON.parse(response.text)).toEqual({ streamId: STREAM, kind: "error", reason: "timeout", revision: null });
      expect(response.destroyed).toBe(true);
      expect(fake.done).toHaveBeenCalledTimes(1);
    });

    it("writes 504 itself when its deadline comes before the root's answer (the root admits later), then closes if not drained", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const done = vi.fn();
      // root の受付は HTTP の関数入口より後: root の期限は 2,010 ms。
      const detail = () => ({ response: new Promise<WeatherTimeseriesDetailResponse>((resolve) => {
        setTimeout(() => resolve({ kind: "error", reason: "timeout", revision: null }), 2_010);
      }), done });
      const response = new FakeResponse(false);
      serveDetail(detail, { url: current }, response as unknown as ServerResponse);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(response.status).toBe(504);
      expect(JSON.parse(response.text)).toEqual({ streamId: STREAM, kind: "error", reason: "timeout", revision: null });
      expect(response.destroyed).toBe(true);
      expect(done).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(response.text).toContain("timeout");
    });

    it("writes timeout when the deadline has passed by the clock before the answer is written", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let now = 0;
      const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
      try {
        const fake = port(ok), response = new FakeResponse(true);
        serve(fake, response);
        now = 2_000;
        await vi.advanceTimersByTimeAsync(0);
        expect(response.status).toBe(504);
        expect(JSON.parse(response.text)).toMatchObject({ reason: "timeout" });
      } finally { spy.mockRestore(); }
    });

    it("keeps a drained answer, and returns the slot when the client leaves before any answer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fine = port(ok), drained = new FakeResponse(true);
      serve(fine, drained);
      await vi.advanceTimersByTimeAsync(0);
      expect(drained.destroyed).toBe(false);
      expect(fine.done).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fine.done).toHaveBeenCalledTimes(1);
      const never = port(new Promise<WeatherTimeseriesDetailResponse>(() => {})), gone = new FakeResponse(false);
      serve(never, gone);
      gone.emit("close");
      gone.emit("close");
      expect(never.done).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gone.text).toBe("");
      expect(never.done).toHaveBeenCalledTimes(1);
    });
  });

  it("takes the index version from the snapshot, reads a page with it, and never makes snapshot delivery wait for a detail", async () => {
    const path = mkdtempSync(join(tmpdir(), "fleq-ufp-http-"));
    directories.push(path);
    const origin = performance.now();
    const clock = () => ({ wallTimeMs: 1_780_650_000_000 + Math.floor(performance.now() - origin), monotonicMs: performance.now() });
    let h: Harness | null = null;
    const started = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy, detail: (request) => h!.root.requestDetail(request) });
    closers.push(() => started.close());
    h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"), legacyStateDirectory: join(path, "old"),
      diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs, { clock, notificationAdapter: manualAdapter().adapter,
      display: { publish: started.publish } });
    const harness = h;
    closers.push(() => harness.root.diagnostics.flush());
    await startHarness(harness, "ufp-http", clock());
    await submit(harness, envelope("ufp-http", "VPWP50", "a", readFileSync("test/fixtures/81_02_01_260605_VPWP50_high_severity.xml"), clock(), 1));
    const fetched = await fetchText(started.port, "/snapshot");
    const snapshot = JSON.parse(fetched.body) as DisplaySnapshot;
    const revision = snapshot.current.weatherTimeseries.contentRevision;
    const indexUrl = `${PATH}?streamId=${snapshot.streamId}&part=index&revision=${revision}&page=0`;
    const pending = fetchText(started.port, indexUrl);
    await harness.settle();
    const index = JSON.parse((await pending).body) as Extract<WeatherTimeseriesDetailResponse, { part: "index" }> & { streamId: string };
    expect(index).toMatchObject({ kind: "ok", part: "index", streamId: snapshot.streamId, revision, subjectCount: 1 });
    const entry = index.entries[0];
    const unhold = harness.holdRequests((_place, request) => request.kind === "detail");
    const pageUrl = `${PATH}?streamId=${snapshot.streamId}&part=current&id=${entry.id}&revision=${entry.revision}&page=0`;
    const page = fetchText(started.port, pageUrl);
    await vi.waitFor(() => expect(harness.sent.filter(({ request }) => request.kind === "detail")).toHaveLength(2));
    // 詳細が owner で待っていても、snapshot と healthz はすぐ答える。
    expect((await fetchText(started.port, "/snapshot")).status).toBe(200);
    expect((await fetchText(started.port, "/healthz")).status).toBe(200);
    unhold();
    harness.releaseRequests("deferred");
    await harness.settle();
    const read = await page;
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ kind: "ok", part: "current", id: entry.id, revision: entry.revision, periodCount: entry.periodCount });
    // 古い版は 409 で、今の版を返す。
    const stale = await fetchText(started.port, pageUrl.replace(`revision=${entry.revision}`, "revision=99999"));
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ reason: "versionChanged", revision: entry.revision });
    expect(Buffer.byteLength(stale.body)).toBeLessThanOrEqual(256);
  }, 30_000);
});
