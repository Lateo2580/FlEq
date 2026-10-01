import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeSocket, listSockets, startSocket } from "../../src/host/dmdata-rest";

type Outgoing = EventEmitter & { destroyed: boolean; destroy(): void; end(payload?: string): void };
type Exchange = { options: RequestOptions; payload: string | undefined; outgoing: Outgoing; onResponse: (response: EventEmitter) => void };
// P3-C2-AC09: node:https never reaches the network here; each request is answered by the test's handler.
const https = vi.hoisted(() => ({ exchanges: [] as unknown[], handle: null as ((exchange: never) => void) | null }));
vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { request: (options: unknown, onResponse: unknown) => {
    const outgoing = Object.assign(new Emitter(), {
      destroyed: false,
      destroy: () => { outgoing.destroyed = true; },
      end: (payload?: string) => {
        const exchange = { options, payload, outgoing, onResponse };
        https.exchanges.push(exchange);
        https.handle?.(exchange as never);
      },
    });
    return outgoing;
  } };
});

const API_KEY = "KEY-SECRET-8";
const TICKET = "TICKET-SECRET-8";
const subscription = { apiKey: API_KEY, appName: "fleq-p3-test", classifications: ["eew.forecast", "eew.warning"] } as const;
const exchanges = () => https.exchanges as Exchange[];
afterEach(() => {
  https.exchanges.length = 0;
  https.handle = null;
  vi.useRealTimers();
});

function answer(status: number, body: string, end: "end" | "truncated" = "end") {
  https.handle = (exchange: Exchange) => {
    exchange.outgoing.emit("finish");
    const response = Object.assign(new EventEmitter(), { statusCode: status, headers: {} });
    exchange.onResponse(response);
    if (body !== "") response.emit("data", Buffer.from(body));
    if (end === "end") response.emit("end");
    response.emit("close");
  };
}
const json = (value: unknown) => JSON.stringify(value);
const listed = { id: 5, ticket: TICKET, types: ["VXSE43"], test: "no", classifications: ["eew.forecast"], ipAddress: "203.0.113.8",
  status: "open", server: "ws001", start: "2026-10-01T00:00:00Z", end: null, ping: null, appName: "fleq" };
const started = { status: "ok", ticket: TICKET, websocket: { id: 12, url: `wss://ws.api.dmdata.jp/v2/websocket?ticket=${TICKET}`,
  protocol: ["dmdata.v2"], expiration: 300 }, classifications: ["eew.forecast"], test: "no", appName: "fleq-p3-test" };
const oversized = (value: object) => json({ ...value, padding: "x".repeat(1024 * 1024) });
// Failure results carry fixed kinds only (AC08).
const clean = (results: unknown[]) => { for (const text of results.map((result) => json(result))) expect(text).not.toMatch(/SECRET|203\.0\.113/); };

describe("P3-C2-T08 dmdata REST boundary (AC01, AC08)", () => {
  it("list: Basic auth, projection without ticket or ipAddress; next page, oversize, status=error and non-2xx fail; 401/403 are auth", async () => {
    answer(200, json({ status: "ok", items: [listed] }));
    expect(await listSockets(API_KEY, "waiting")).toEqual({ kind: "ok",
      sockets: [{ id: 5, appName: "fleq", status: "open", classifications: ["eew.forecast"] }] });
    const [{ options }] = exchanges();
    expect(options).toMatchObject({ hostname: "api.dmdata.jp", port: 443, method: "GET", path: "/v2/socket?status=waiting" });
    expect(options.headers).toMatchObject({ Authorization: `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}` });
    const results: unknown[] = [];
    for (const [status, body, expected] of [
      [200, json({ status: "ok", items: [listed], nextToken: "next" }), "failed"],
      [200, oversized({ status: "ok", items: [listed] }), "failed"],
      [200, json({ status: "error", error: { message: TICKET, code: 400 } }), "failed"],
      [200, json({ status: "ok", items: [{ ...listed, id: 1.5 }] }), "failed"],
      [500, json({ status: "error" }), "failed"],
      [401, json({ status: "error" }), "authRejected"],
      [403, "", "authRejected"],
    ] as const) {
      answer(status, body);
      const result = await listSockets(API_KEY, "open");
      expect(result.kind).toBe(expected);
      results.push(result);
    }
    clean(results);
  });

  it("delete: 204 without body, 200 status=ok and 404 succeed; 200 status=error and 500 fail; 401 is auth", async () => {
    const results: unknown[] = [];
    for (const [status, body, expected] of [
      [204, "", "ok"], [200, json({ status: "ok" }), "ok"], [404, json({ status: "error" }), "ok"],
      [200, json({ status: "error", error: { message: "not yours", code: 404 } }), "failed"], [500, "", "failed"],
      [200, oversized({ status: "ok" }), "failed"], [401, "", "authRejected"],
    ] as const) {
      answer(status, body);
      const result = await closeSocket(API_KEY, 12);
      expect(result.kind).toBe(expected);
      results.push(result);
    }
    expect(exchanges()[0].options).toMatchObject({ method: "DELETE", path: "/v2/socket/12" });
    clean(results);
  });

  it("start: body and success; a fully read non-2xx fails; a failure before sending fails; anything unclear after sending is uncertain", async () => {
    answer(200, json(started));
    expect(await startSocket(subscription)).toEqual({ kind: "ok", id: 12, url: started.websocket.url, protocol: ["dmdata.v2"] });
    expect(exchanges()[0].options).toMatchObject({ method: "POST", path: "/v2/socket" });
    expect(JSON.parse(exchanges()[0].payload!)).toEqual({ classifications: ["eew.forecast", "eew.warning"], test: "no",
      appName: "fleq-p3-test", formatMode: "raw" });
    const results: unknown[] = [];
    const run = async (expected: string) => { const result = await startSocket(subscription); expect(result.kind).toBe(expected); results.push(result); };
    answer(400, json({ status: "error", error: { message: "bad", code: 400 } }));
    await run("failed");
    answer(401, json({ status: "error" }));
    await run("authRejected");
    answer(200, json({ ...started, websocket: { ...started.websocket, url: "ws://plain" } }));
    await run("uncertain");
    answer(200, json({ status: "error" }));
    await run("uncertain");
    answer(200, oversized(started));
    await run("uncertain");
    answer(200, json(started).slice(0, 40), "truncated");
    await run("uncertain");
    // Connection refused: the request never reached the socket.
    https.handle = (exchange: Exchange) => { exchange.outgoing.emit("error", new Error(`connect ECONNREFUSED ${API_KEY}`)); };
    await run("failed");
    // The caller's stop limit (P3-C2-RES-07): an aborted signal sends nothing; an abort while waiting destroys the request at once.
    const sentBefore = exchanges().length;
    const stopped = new AbortController();
    stopped.abort();
    expect(await closeSocket(API_KEY, 12, stopped.signal)).toEqual({ kind: "failed" });
    expect(exchanges()).toHaveLength(sentBefore);
    https.handle = (exchange: Exchange) => { exchange.outgoing.emit("finish"); };
    const halt = new AbortController();
    let aborted: unknown = null;
    void startSocket(subscription, halt.signal).then((result) => { aborted = result; });
    expect(exchanges().at(-1)!.outgoing.destroyed).toBe(false);
    halt.abort();
    await new Promise((done) => setImmediate(done));
    expect(aborted).toEqual({ kind: "uncertain" });
    expect(exchanges().at(-1)!.outgoing.destroyed).toBe(true);
    // Sent, then no answer: the 15 s limit makes it uncertain.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    https.handle = (exchange: Exchange) => { exchange.outgoing.emit("finish"); };
    let settled: unknown = null;
    const pending = startSocket(subscription).then((result) => { settled = result; });
    vi.advanceTimersByTime(14_999);
    await Promise.resolve();
    expect(settled).toBeNull();
    vi.advanceTimersByTime(1);
    await pending;
    expect(settled).toEqual({ kind: "uncertain" });
    clean([...results, settled]);
  });
});
