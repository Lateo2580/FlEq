import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { runHealthClient } from "./e02-health-client.mjs";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); } });

async function serve(handler: (request: number, res: ServerResponse, req: IncomingMessage) => void) {
  let n = 0;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => handler(n++, res, req));
  server.on("connection", (socket) => sockets.add(socket));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`, sockets };
}
const ok = (res: ServerResponse, worker = "healthy") => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ transport: "ok", worker, latestVersion: null, ready: true })); };

describe("P2-A10-T07 E02 health client (AC11)", () => {
  it("classifies non200, invalid body, incomplete body and timeout as failures; success keeps the worker state", async () => {
    // requests 0-1 are the warm-up pair; then one sample per behaviour.
    const behaviours = [ok, ok, (res: ServerResponse) => ok(res, "stalled"), (res: ServerResponse) => { res.writeHead(500); res.end("{}"); },
      (res: ServerResponse) => { res.writeHead(200); res.end("nope"); },
      (res: ServerResponse) => { res.writeHead(200, { "content-length": "100" }); res.write("{"); setTimeout(() => res.destroy(), 20); },
      () => { /* never answers */ }];
    const { url } = await serve((n, res) => behaviours[n]!(res));
    const samples = await runHealthClient({ url, count: 5, everyMs: 30, timeoutMs: 300, load: "N", run: 1 });
    expect(samples.map((s) => [s.failure, s.worker, s.bodyCompleteMonotonicMs == null])).toEqual([
      [null, "stalled", false], ["non200", null, false], ["invalidBody", null, false], ["bodyIncomplete", null, true], ["timeout", null, true]]);
  });

  it("requests at the scheduled time while the previous response is still pending, on another connection", async () => {
    const { url, sockets } = await serve((n, res) => { if (n < 2) return ok(res); setTimeout(() => ok(res), 250); });
    const samples = await runHealthClient({ url, count: 4, everyMs: 50, timeoutMs: 2000, load: "P", run: 2 });
    // Each request is sent while the previous response (250 ms) is still pending.
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.requestStartMonotonicMs).toBeLessThan(samples[i - 1]!.bodyCompleteMonotonicMs!);
    expect(samples.every((s) => s.failure == null && s.load === "P" && s.run === 2)).toBe(true);
    expect(sockets.size).toBeGreaterThan(2);
  });
});
