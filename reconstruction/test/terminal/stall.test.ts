import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const CLI = join(REPO, "reconstruction/cli/fleq.mjs");
// 最も大きい本物の VXSE53（RES-01 の見積もりの元）。300 本の材料の見積もりの合計が 1 MiB を越える（32-35_01_03 は 1 本約 2 KB で越えない）。
// 市町村と観測点（City）は端末が読まない段なので外し、1 本を約 200 KB から小さくする（そのままだと host の mailbox の上限で WS が切られる）。
const VXSE53 = readFileSync(join(REPO, "test/fixtures/telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825.xml"), "utf8")
  .replace(/<City>[\s\S]*?<\/City>/g, "");
const COUNT = 300;

const freePort = () => new Promise<number>((ok, ng) => {
  const server = net.createServer();
  server.once("error", ng);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => ok(typeof address === "object" && address != null ? address.port : 0)); });
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (let started = Date.now(); Date.now() - started < ms; await sleep(100)) if (await ok()) return true;
  return false;
};
function request(port: number, method: string, path: string, body?: string) {
  return new Promise<{ status: number; text: string }>((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => done({ status: res.statusCode!, text }));
    });
    req.on("error", fail);
    req.end(body);
  });
}
// 本文を 1 つずつ変える: EventID を報ごとに 1 秒ずつずらした別の地震にする（同じ報の duplicate にしない）。
const eventIdOf = (index: number) => {
  const at = new Date(Date.UTC(2026, 6, 28, 16, 0, index));
  return `20260728${String(at.getUTCHours()).padStart(2, "0")}${String(at.getUTCMinutes()).padStart(2, "0")}${String(at.getUTCSeconds()).padStart(2, "0")}`;
};
const bodyOf = (index: number) => VXSE53.replace(/<EventID>\d+<\/EventID>/, `<EventID>${eventIdOf(index)}</EventID>`);

describe("P3-TO-T07 端末が詰まっても受信を止めない（O02 の製品経路、AC02・AC01）", () => {
  it("標準出力を読まない間も 300 本を受けて表示に出し、読み始めると省いた件数の行が出る", async () => {
    const displayPort = await freePort();
    const child = spawn("node", [CLI, "watch"], {
      cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FLEQ_WATCH_PORT: "0", FLEQ_WATCH_DISPLAY_PORT: String(displayPort), FLEQ_JMA_CODES: "" },
    });
    const exit = new Promise<number | null>((done) => child.once("exit", done));
    try {
      // 標準エラーの 1 行（watch の port）だけを読む。標準出力の pipe は読まない（子の fleq の fd 1 が詰まる）。
      const line = await new Promise<string>((ok, ng) => {
        let text = "";
        child.stderr!.on("data", (chunk) => { text += chunk; if (text.includes("\n")) ok(text.split("\n")[0]); });
        child.once("exit", () => ng(new Error(`exited before the start line: ${text}`)));
      });
      const port = Number(/^fleq watch: http:\/\/127\.0\.0\.1:(\d+)\//.exec(line)![1]);
      let first = await request(port, "POST", "/inject?type=VXSE53", bodyOf(0));
      for (let started = Date.now(); first.status === 503 && Date.now() - started < 20_000;) { await sleep(500); first = await request(port, "POST", "/inject?type=VXSE53", bodyOf(0)); }
      const statuses = [first.status];
      // 秒を変えて送った 1 本の updatedAt（発表時刻を今に寄せた秒）が表示に出たら、そこまでの受信は進んでいる（P3-RW2-T01 と同じ読み）。
      const sentAndShown = async (index: number) => {
        await sleep(1_100);
        const before = Math.floor(Date.now() / 1000) * 1000;
        statuses.push((await request(port, "POST", "/inject?type=VXSE53", bodyOf(index))).status);
        const after = Math.floor(Date.now() / 1000) * 1000;
        return until(async () => {
          const snapshot = JSON.parse((await request(displayPort, "GET", "/snapshot")).text);
          return (snapshot.current.earthquake.items as { updatedAt: number | null }[]).some((item) => item.updatedAt != null && item.updatedAt >= before && item.updatedAt <= after);
        }, 60_000);
      };
      for (let index = 1; index < COUNT - 1; index += 1) {
        // 25 本ごとに受信が追いつくのを待つ（一度に送ると host の mailbox の件数の上限で WS が切られる。端末とは関係しない）。
        if (index % 25 === 0) expect(await sentAndShown(index)).toBe(true);
        else statuses.push((await request(port, "POST", "/inject?type=VXSE53", bodyOf(index))).status);
      }
      expect(await sentAndShown(COUNT - 1)).toBe(true);
      expect(statuses.filter((status) => status !== 200)).toEqual([]);
      let out = "";
      child.stdout!.on("data", (chunk) => { out += chunk; });
      expect(await until(() => out.includes("件の表示を省きました"))).toBe(true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) { child.stdout!.resume(); child.stdin!.write("quit\n"); }
      await exit;
    }
  }, 180_000);
});
