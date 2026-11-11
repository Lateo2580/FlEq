import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const REPO = join(__dirname, "../../..");
const CLI = join(REPO, "reconstruction/cli/fleq.mjs");
const VXSE53 = readFileSync(join(REPO, "test/fixtures/32-35_01_03_240613_VXSE53.xml"));
const posix = process.platform !== "win32"; // T20: win32 の子への SIGTERM は強制終了で、転送を確かめられない
const work = mkdtempSync(join(tmpdir(), "fleq-watch-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Child = { child: ChildProcess; exit: Promise<number | null>; stdout: () => string; port: number; displayPort: number; directory: string };

const freePort = () => new Promise<number>((ok, ng) => {
  const s = net.createServer();
  s.once("error", ng);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => ok(port)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (let t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await ok()) return true;
  return false;
};

// 標準入力は閉じない（閉じると子の fleq の REPL が閉じて止まる）。
// freePort() が返した表示の port は、子の fleq が listen するまでに他（watch 自身の port 0 の listen を含む）に取られうる。取られると fleq が断り watch ごと終わり、
// 次の POST が ECONNREFUSED になる（P3-RW2-T20 の CI の揺れ）。表示の port には 0 を渡せない（watch.mjs の portOf の下限 1）ので、断られたときだけ選び直す。
async function start(): Promise<Child> {
  for (let attempt = 1; ; attempt += 1) {
    const displayPort = await freePort();
    const child = spawn("node", [CLI, "watch"], {
      cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FLEQ_WATCH_PORT: "0", FLEQ_WATCH_DISPLAY_PORT: String(displayPort), FLEQ_JMA_CODES: "" }, // 資料なし（公開サンプルの範囲）で動かす（T14・T18）
    });
    spawned.push(child);
    let out = "";
    let err = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    const exit = new Promise<number | null>((done) => child.once("exit", done));
    const line = await new Promise<string>((ok, ng) => {
      child.stderr!.on("data", (chunk) => { err += chunk; if (err.includes("\n")) ok(err.split("\n")[0]); });
      child.once("exit", () => ng(new Error(`exited before the start line: ${err}`)));
    });
    const m = /^fleq watch: http:\/\/127\.0\.0\.1:(\d+)\/（設定と保存: (.+)）$/.exec(line);
    if (m == null) throw new Error(`unexpected start line: ${line}`);
    // 表示の port に GET して確かめない（port を取った別の server が答えうる）。fleq 自身の行で確かめる。
    const shown = () => out.includes(`情報ディスプレイ: http://127.0.0.1:${displayPort}/`);
    // 上限は既定の testTimeout（30 s）より短くし、壊れたときに timeout より先に下の診断文を出す。
    await until(() => shown() || child.exitCode != null || child.signalCode != null, 15_000);
    if (shown()) return { child, exit, stdout: () => out, port: Number(m[1]), displayPort, directory: m[2] };
    if (attempt < 3 && err.includes(`ポート ${displayPort} は使われています`)) { await exit; continue; }
    throw new Error(`fleq did not open the display on ${displayPort}: ${err}`);
  }
}
const spawned: ChildProcess[] = [];
// watch だけを SIGKILL しない（子の fleq が孤児になり表示の port を握ったまま繋ぎ直し続ける）。後始末は quit か SIGTERM。
const stop = async (c: Child) => { if (c.child.exitCode == null && c.child.signalCode == null) { c.child.stdin!.write("quit\n"); await c.exit; } };
afterAll(async () => { for (const child of spawned) if (child.exitCode == null && child.signalCode == null) { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); } });

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
  const r = await request(c.port, "POST", `/inject?${query}`, body, headers);
  return { status: r.status, json: JSON.parse(r.text) };
};
// fleq（host）が繋ぐまでは 503 notConnected。200 になるまで 0.5 秒おきに最長 20 秒やり直す。
const injectWhenConnected = async (c: Child) => {
  let r = await post(c, "type=VXSE53");
  for (let t = Date.now(); r.status === 503 && Date.now() - t < 20_000;) { await sleep(500); r = await post(c, "type=VXSE53"); }
  return r;
};
const filesUnder = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]); } catch { return []; }
};
const updatedAts = async (c: Child): Promise<number[]> => {
  const snapshot = JSON.parse((await request(c.displayPort, "GET", "/snapshot")).text);
  return (snapshot.current.earthquake.items as { updatedAt: number }[]).map((item) => item.updatedAt);
};

describe("P3-REPLAY-WATCH-002", () => {
  const shared: { c: Child | null } = { c: null };
  const common = async () => shared.c ??= await start();
  afterAll(async () => { if (shared.c != null) await stop(shared.c); });

  // P3-RW2-T01 acceptance (AC02・AC03・AC04)
  it("injects VXSE53 through the product path with the time moved to now", async () => {
    const c = await common();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = await injectWhenConnected(c);
    const after = Math.floor(Date.now() / 1000) * 1000;
    expect(r).toEqual({ status: 200, json: { sent: true, headType: "VXSE53" } });
    expect(await until(async () => (await updatedAts(c)).some((at) => at >= before && at <= after))).toBe(true);
    const saved = () => filesUnder(join(c.directory, "fleq-next", "state")).some((f) => readFileSync(f, "utf8").includes('"origin":"replay"'));
    expect(await until(saved)).toBe(true); // 保存は非同期（checkpoint）
    expect(await until(() => c.stdout().includes("ミュート中です（mute off まで）。"))).toBe(true); // spec:650 の外部配送の無効化の明示
  }, 60_000);

  // P3-RW2-T02 contractBoundary (AC04)
  it("rejects a POST with a foreign Origin", async () => {
    const r = await post(await common(), "type=VXSE53", "x", { origin: "http://evil.example" });
    expect(r).toEqual({ status: 403, json: { error: "originRejected" } });
  });

  // P3-RW2-T03 contractBoundary (AC04)
  it("rejects a foreign Host and accepts localhost", async () => {
    const c = await common();
    const r = await post(c, "type=VXSE53", "x", { host: `evil.example:${c.port}` });
    expect(r).toEqual({ status: 403, json: { error: "hostRejected" } });
    expect((await request(c.port, "GET", "/", undefined, { host: `localhost:${c.port}` })).status).toBe(200);
  });

  // P3-RW2-T04 contractBoundary (AC04)
  it("rejects a body over 8 MiB", async () => {
    const r = await post(await common(), "type=VXSE53", Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(r).toEqual({ status: 413, json: { error: "bodyTooLarge" } });
  });

  // P3-RW2-T05 contractBoundary (AC04)
  it("rejects an invalid type", async () => {
    const r = await post(await common(), "type=VZZZ1", "x");
    expect(r).toEqual({ status: 400, json: { error: "typeInvalid" } });
  });

  // P3-RW2-T10 regression (AC04, 001 の T14: 不正な入力 1 件で常駐が落ちた)
  it("survives one malformed injection and a malformed request target", async () => {
    const c = await common();
    const bad = VXSE53.toString("utf8").replace(/<DateTime>[^<]*<\/DateTime>/, "<DateTime>2024-13-45T99:99:99Z</DateTime>");
    expect(await post(c, "type=VXSE53&retime=1", bad)).toEqual({ status: 400, json: { error: "retimeFailed" } });
    expect(await request(c.port, "POST", "//[", "x")).toEqual({ status: 400, text: JSON.stringify({ error: "badRequest" }) });
    expect((await injectWhenConnected(c)).status).toBe(200);
  });

  // P3-RW2-T06 contractBoundary (AC03・host.ts の 5 秒の繋ぎ直し)
  it("refuses an Origin upgrade, lets an Origin-less client take over, and host takes it back", async () => {
    const c = await common();
    const status = await new Promise<number>((ok, ng) => {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/`, { origin: "http://evil.example" });
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode!));
      ws.on("error", ng);
      ws.on("open", () => ng(new Error("upgrade accepted")));
    });
    expect(status).toBe(401);
    // host の接続を確かめてから奪う（起動直後の最初の接続を繋ぎ直しと取り違えないため）。T01 と秒が違う固有の報を 1 本注入する。
    await sleep(1100);
    const since = Math.floor(Date.now() / 1000) * 1000;
    expect((await injectWhenConnected(c)).status).toBe(200);
    expect(await until(async () => (await updatedAts(c)).some((at) => at >= since))).toBe(true);
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${c.port}/`);
    ws.on("message", (raw) => frames.push(String(raw)));
    const closed = new Promise<void>((ok) => ws.once("close", () => ok()));
    expect(await until(() => frames.length > 0)).toBe(true);
    expect(JSON.parse(frames[0])).toMatchObject({ type: "start" });
    await Promise.race([closed, sleep(15_000).then(() => { throw new Error("not closed by watch within 15 s"); })]);
    expect((await post(c, "type=VXSE53")).json).toEqual({ sent: true, headType: "VXSE53" });
  }, 60_000);

  // P3-RW2-T07 acceptance (AC03: 子の終了で watch も終わり port を閉じる)
  it("ends with code 0 when fleq quits, and closes the watch port", async () => {
    const c = await start();
    expect((await injectWhenConnected(c)).status).toBe(200);
    const t0 = Date.now();
    c.child.stdin!.write("quit\n");
    expect(await c.exit).toBe(0);
    expect(Date.now() - t0).toBeLessThanOrEqual(40_000);
    await expect(request(c.port, "GET", "/")).rejects.toThrow();
  }, 90_000);

  // P3-RW2-T08 contractBoundary (AC03: 30 秒の ping、host.ts の 90 秒の切断)
  it("keeps the host connection alive past 90 s with pings", async () => {
    const c = await start();
    try {
      expect((await injectWhenConnected(c)).status).toBe(200);
      await sleep(95_000);
      expect((await post(c, "type=VXSE53")).status).toBe(200);
    } finally { await stop(c); }
    const diag = filesUnder(join(c.directory, "fleq-next", "diag")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(diag).not.toContain("connectionLivenessExpired");
  }, 150_000);

  // P3-RW2-T09 contractBoundary (AC01: 本番の設定への偽電文の保存を防ぐ守り)
  it("refuses FLEQ_WS_URL when the settings directory is outside the temp directory", async () => {
    const base = join(work, "guard");
    const tmp = join(base, "tmp");
    const xdg = join(base, "xdg");
    mkdirSync(tmp, { recursive: true }); // 無いと realpath が投げる
    mkdirSync(join(xdg, "fleq-next"), { recursive: true });
    writeFileSync(join(xdg, "fleq-next", "config.json"), JSON.stringify({
      apiKey: "watch", appName: "fleq-watch", display: true, displayPort: 7791, sound: false, mute: { until: null, rules: [] },
    }));
    const child = spawn("node", [CLI], {
      cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CONFIG_HOME: xdg, FLEQ_WS_URL: "ws://127.0.0.1:1/" },
    });
    spawned.push(child);
    let err = "";
    child.stderr!.on("data", (chunk) => { err += chunk; });
    expect(await new Promise((done) => child.once("exit", done))).toBe(1);
    expect(err).toContain("FLEQ_WS_URL");
    expect(existsSync(join(xdg, "fleq-next", "state"))).toBe(false);
  }, 60_000);

  // P3-RW2-T14 acceptance (AC12: /generate の HTTP の境界)
  it("generates telegrams over POST /generate and the result can be injected", async () => {
    const c = await common();
    const generate = async (body: object, headers: Record<string, string> = {}) => {
      const r = await request(c.port, "POST", "/generate", JSON.stringify(body), headers);
      return { status: r.status, json: JSON.parse(r.text) };
    };
    const eew = { family: "VXSE45", placeCode: "681", lat: 33.2, lon: 132.4, depthKm: 10, magnitude: 5.5, maxInt: "5-", areaCode: "622" };
    const first = await generate(eew);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ headType: "VXSE45", originTime: expect.any(String), eventId: expect.any(String) });
    const again = await generate({ ...eew, originTime: first.json.originTime, serial: 2 });
    expect(again.json.eventId).toBe(first.json.eventId);
    expect(await generate({ ...eew, magnitude: 10 })).toEqual({ status: 400, json: { error: "magnitudeOutOfRange", field: "magnitude" } });
    expect((await generate(eew, { origin: "http://evil.example" })).status).toBe(403);
    const quake = await generate({ family: "VXSE53", placeCode: "485", lat: 34.8, lon: 138.5, depthKm: 10, magnitude: 5.5, maxInt: "5-", areaCode: "442" });
    expect(quake.status).toBe(200);
    // host が繋ぐまでは 503 notConnected（順序を変えても T01 に頼らない）
    let sent = await post(c, "type=VXSE53&retime=0", quake.json.reports[0].xml);
    for (let t = Date.now(); sent.status === 503 && Date.now() - t < 20_000;) { await sleep(500); sent = await post(c, "type=VXSE53&retime=0", quake.json.reports[0].xml); }
    expect(sent).toEqual({ status: 200, json: { sent: true, headType: "VXSE53" } });
  });

  // P3-RW2-T18 acceptance (AC12: ページ)
  it("serves the make form, five scenes and the choices from choices()", async () => {
    const html = (await request((await common()).port, "GET", "/")).text;
    expect(html).toContain('<form id="make"');
    expect(html.match(/data-scene="/g)).toHaveLength(5);
    expect(html).toContain("try { localStorage.setItem(");
    expect(html).toContain("JSON.parse(localStorage.getItem(");
    const options = (id: string) => (new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`).exec(html)![1].match(/<option/g) ?? []).length;
    expect([options("area-VXSE45"), options("area-VXSE53")]).toEqual([44, 17]);
    expect(html).toContain('<option value="VXSE45">VXSE45（EEW 地震動予報）</option>'); // AC-POLISH: 値はコードのまま、表示だけ注釈つき
    expect(html).not.toContain("地震火山関連コード表"); // 資料を読んだときだけ出る出典の 1 行
  });

  // P3-RW2-T19 contractBoundary (AC12: 起動の失敗)
  it("stops with codesUnreadable before starting fleq when FLEQ_JMA_CODES cannot be read", async () => {
    const child = spawn("node", [CLI, "watch"], {
      cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FLEQ_WATCH_PORT: "0", FLEQ_WATCH_DISPLAY_PORT: String(await freePort()), FLEQ_JMA_CODES: join(work, "missing.xlsx") },
    });
    spawned.push(child);
    let err = "";
    child.stderr!.on("data", (chunk) => { err += chunk; });
    expect(await new Promise((done) => child.once("exit", done))).toBe(1);
    expect(err).toContain("codesUnreadable");
  }, 60_000);

  // P3-RW2-T20 contractBoundary (AC03: SIGTERM を子へ渡す。渡さないと watch だけが死んで子の fleq が残る)
  it.skipIf(!posix)("forwards SIGTERM to fleq and both end", async () => {
    const c = await start();
    expect((await injectWhenConnected(c)).status).toBe(200);
    c.child.kill("SIGTERM");
    await Promise.race([c.exit, sleep(40_000).then(() => { throw new Error("watch did not end within 40 s"); })]);
    await expect(request(c.port, "GET", "/")).rejects.toThrow();
    await expect(request(c.displayPort, "GET", "/snapshot")).rejects.toThrow();
  }, 90_000);
});
