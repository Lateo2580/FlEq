import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const REPO = join(__dirname, "../../..");
const CLI = join(REPO, "reconstruction/cli/fleq.mjs");
const VXSE53 = readFileSync(join(REPO, "test/fixtures/32-35_01_03_240613_VXSE53.xml"));
const posix = process.platform !== "win32"; // D-STOP-TEST: win32 の子への SIGINT は強制終了で、停止の順序を確かめられない
const work = mkdtempSync(join(tmpdir(), "fleq-watch-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Started = { event: string; display: string; inject: string; ws: string; outDirectory: string; notification: string; measured: boolean };
type Child = { child: ChildProcess; started: Started; stdout: () => string; exit: Promise<number | null>; injectPort: number; displayPort: number };

let counter = 0;
async function start(): Promise<Child> {
  const out = join(work, `out-${(counter += 1)}`);
  mkdirSync(out);
  const child = spawn("node", [CLI, "watch", "--display-port", "0", "--inject-port", "0", "--out", out], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  spawned.push(child);
  const exit = new Promise<number | null>((done) => child.once("exit", done));
  const started = await new Promise<Started>((ok, ng) => {
    child.stdout!.on("data", (chunk) => { text += chunk; const line = text.split("\n")[0]; if (text.includes("\n")) ok(JSON.parse(line)); });
    child.once("exit", () => ng(new Error(`exited before started: ${text}`)));
  });
  return { child, started, stdout: () => text, exit, injectPort: Number(new URL(started.inject).port), displayPort: Number(new URL(started.display).port) };
}
const spawned: ChildProcess[] = [];
afterAll(() => { for (const c of spawned) c.kill("SIGKILL"); });
const stop = async (c: Child) => { c.child.kill(posix ? "SIGINT" : undefined); await c.exit; };

function request(port: number, method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => done({ status: res.statusCode!, text }));
    });
    req.on("error", fail);
    req.end(body);
  });
}
const post = async (c: Child, query: string, body: Buffer | string = VXSE53, headers: Record<string, string> = {}) => {
  const r = await request(c.injectPort, "POST", `/inject?${query}`, body, headers);
  return { status: r.status, json: JSON.parse(r.text) };
};
const filesUnder = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]); } catch { return []; }
};
const connectWs = (c: Child) => new Promise<{ ws: WebSocket; frames: string[] }>((ok, ng) => {
  const ws = new WebSocket(c.started.ws);
  const frames: string[] = [];
  ws.on("message", (raw) => { frames.push(String(raw)); if (frames.length === 1) ok({ ws, frames }); });
  ws.on("error", ng);
});
// host がまだ繋いでいないうちに奪うと、後から来る host が current に戻る。1 件通して host の接続を確かめてから奪う。
const steal = async (c: Child) => { expect((await post(c, "type=VXSE53")).json.processed).toBe(true); return connectWs(c); };
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 50)); };

describe("P3-REPLAY-WATCH-001", () => {
  const shared: { c: Child | null } = { c: null };
  const common = async () => shared.c ??= await start();
  afterAll(async () => { if (shared.c != null) await stop(shared.c); });

  // P3-RW-T01 acceptance (AC03・AC04・AC05・AC06)
  it("injects VXSE53 through the product path with the time moved to now", async () => {
    const c = await common();
    expect(c.started).toMatchObject({ event: "started", notification: "muted", measured: true });
    expect(c.started.ws).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = await post(c, "type=VXSE53");
    const after = Math.floor(Date.now() / 1000) * 1000;
    expect(r).toEqual({ status: 200, json: { inputId: "input-1", headType: "VXSE53", processed: true, decoded: true, timedOut: false, stopping: false } });
    const snapshot = JSON.parse((await request(c.displayPort, "GET", "/snapshot")).text);
    const updatedAt = snapshot.current.earthquake.items[1].updatedAt;
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
    const saved = () => filesUnder(join(c.started.outDirectory, "state")).some((f) => readFileSync(f, "utf8").includes('"origin":"replay"'));
    await until(saved); // 保存は非同期（checkpoint）なので少し待つ
    expect(saved()).toBe(true);
  }, 30_000);

  // P3-RW-T02 contractBoundary (AC05)
  it("rejects a POST with a foreign Origin", async () => {
    const r = await post(await common(), "type=VXSE53", "x", { origin: "http://evil.example" });
    expect(r).toEqual({ status: 403, json: { error: "originRejected" } });
  });

  // P3-RW-T03 contractBoundary (AC05)
  it("rejects a foreign Host and accepts localhost", async () => {
    const c = await common();
    const r = await post(c, "type=VXSE53", "x", { host: `evil.example:${c.injectPort}` });
    expect(r).toEqual({ status: 403, json: { error: "hostRejected" } });
    const page = await request(c.injectPort, "GET", "/", undefined, { host: `localhost:${c.injectPort}` });
    expect(page.status).toBe(200);
  });

  // P3-RW-T04 contractBoundary (AC05)
  it("rejects a body over 8 MiB", async () => {
    const r = await post(await common(), "type=VXSE53", Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(r).toEqual({ status: 413, json: { error: "bodyTooLarge" } });
  });

  // P3-RW-T05 contractBoundary (AC05)
  it("rejects an invalid type", async () => {
    const r = await post(await common(), "type=VZZZ1", "x");
    expect(r).toEqual({ status: 400, json: { error: "typeInvalid" } });
  });

  // P3-RW-T06 contractBoundary (AC04)
  it("refuses a WebSocket upgrade that carries an Origin with 401", async () => {
    const c = await common();
    const status = await new Promise<number>((ok, ng) => {
      const ws = new WebSocket(c.started.ws, { origin: "http://evil.example" });
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode!));
      ws.on("error", ng);
      ws.on("open", () => ng(new Error("upgrade accepted")));
    });
    expect(status).toBe(401);
  });

  // P3-RW-T07 contractBoundary (AC02)
  it("refuses a reserved port without opening anything", () => {
    const r = spawnSync("node", [CLI, "watch", "--display-port", "7788"], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ error: "reservedPort" });
  });

  // P3-RW-T08 contractBoundary (AC02)
  it("refuses a non-empty --out and leaves it unchanged", () => {
    const out = join(work, "occupied");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "x");
    const r = spawnSync("node", [CLI, "watch", "--out", out], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ error: "outNotEmpty" });
    expect(readdirSync(out)).toEqual(["keep.txt"]);
  });

  // P3-RW-T13 contractBoundary (AC02)
  it("refuses --out inside the production directory (outIsProduction)", () => {
    const xdg = join(work, "xdg");
    mkdirSync(xdg);
    const r = spawnSync("node", [CLI, "watch", "--out", join(xdg, "fleq-next")], { cwd: REPO, encoding: "utf8", timeout: 30_000, env: { ...process.env, XDG_CONFIG_HOME: xdg } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ error: "outIsProduction" });
    expect(existsSync(join(xdg, "fleq-next"))).toBe(false);
  });

  // P3-RW-T14 regression (AC05)
  it("survives one malformed injection and a malformed request target", async () => {
    const c = await start(); // T01 の inputId を動かさないため別の子
    const bad = VXSE53.toString("utf8").replace(/<DateTime>[^<]*<\/DateTime>/, "<DateTime>2024-13-45T99:99:99Z</DateTime>");
    expect(await post(c, "type=VXSE53", bad)).toEqual({ status: 400, json: { error: "retimeFailed" } });
    const target = await request(c.injectPort, "POST", "//[", "x");
    expect(target).toEqual({ status: 400, text: JSON.stringify({ error: "badRequest" }) });
    try { expect((await post(c, "type=VXSE53")).json.processed).toBe(true); } finally { await stop(c); }
  }, 30_000);

  // P3-RW-T09 acceptance (AC08)
  it.skipIf(!posix)("stops on SIGINT with code 0, a stopped line, and the inject port closed", async () => {
    const c = await start();
    const t0 = Date.now();
    c.child.kill("SIGINT");
    expect(await c.exit).toBe(0);
    expect(Date.now() - t0).toBeLessThanOrEqual(40_000);
    const last = JSON.parse(c.stdout().trim().split("\n").pop()!);
    expect(last).toMatchObject({ event: "stopped", shutdown: { code: 0 } });
    await expect(request(c.injectPort, "GET", "/")).rejects.toThrow();
  }, 60_000);

  // P3-RW-T10 acceptance (AC06・AC08)
  it.skipIf(!posix)("answers an in-flight injection with 503 stopping when SIGINT arrives", async () => {
    const c = await start();
    const { frames } = await steal(c);
    expect(JSON.parse(frames[0])).toMatchObject({ type: "start", socketId: 2 });
    const pending = post(c, "type=VXSE53");
    await until(() => frames.length > 1);
    expect(JSON.parse(frames[1]).type).toBe("data");
    c.child.kill("SIGINT");
    const r = await pending;
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ stopping: true, processed: false, timedOut: false });
    expect(await c.exit).toBe(0);
  }, 60_000);

  // P3-RW-T11 contractBoundary (AC06, host.ts の 5 秒の繋ぎ直し)
  it("times out after 10 s and then processes the next injection", async () => {
    const c = await start();
    try {
      await steal(c);
      const first = await post(c, "type=VXSE53");
      expect(first).toMatchObject({ status: 200, json: { processed: false, timedOut: true, inputId: null } });
      const second = await post(c, "type=VXSE53");
      expect(second.json).toMatchObject({ processed: true, timedOut: false });
    } finally { await stop(c); }
  }, 60_000);

  // P3-RW-T12 contractBoundary (AC04, host.ts の 90 秒の切断)
  it.skipIf(!posix)("keeps the host connection alive past 90 s with pings", async () => {
    const c = await start();
    try {
      await new Promise((r) => setTimeout(r, 95_000));
      const r = await post(c, "type=VXSE53");
      expect(r.json).toMatchObject({ processed: true });
    } finally { await stop(c); }
    const diag = filesUnder(join(c.started.outDirectory, "diag")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(diag).not.toContain("connectionLivenessExpired");
  }, 150_000);
});
