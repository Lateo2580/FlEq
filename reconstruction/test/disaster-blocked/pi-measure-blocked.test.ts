import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { runStage1 } from "../disaster/runner";
import { readScenario } from "../disaster/scenario";

// P3-PI-MEASURE-BLOCKED-TEST-001 の T01（P3-DPM-AC04 (7) の blocked の後始末と 4 欄）。
// disaster/ の外に置くのは、P3-FINAL-GATE-001 の T09 が reconstruction/test/disaster の差分を見ていて、そこを変えると blocked になるため。

// 手の確かめ（2026-11-14）と同じ長さ。EEW は 200 ms ごとに送られ、止めている間に 20 報が積もって、再開の時に予約の枠（mailbox.ts の RESERVED_ITEM_LIMIT 8）を溢れる。
const STOP_MS = 4_000;
const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));
const temporary: string[] = [];
afterAll(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "fleq-pmb-"));
  temporary.push(path);
  return path;
}
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* もう居ない */ } };

// host の PID は道具の唯一の子として引く（pgrep -P。win32 には無いので skip）。
it.skipIf(process.platform === "win32")("P3-PMB-T01 contractBoundary / P3-DPM-AC04 (7): a host stopped mid-probe ends blocked hostFailed, terminated by SIGTERM, with the four fields", async () => {
  const peak = scratch(), work = scratch(), out = join(work, "result.json");
  expect((await runStage1(readScenario({ id: "R2S", dataDir: null, expectedDigest: null }), { peakOut: peak })).result["status"]).toBe("Pass");
  const tool = spawn(process.execPath, ["reconstruction/test/disaster/pi-measure.mjs", "--peak", peak, "--work", work, "--out", out, "--launches", "1", "--probe-seconds", "15"],
    { stdio: "inherit" });
  const exited = new Promise<number | null>((done) => tool.on("exit", done));
  let host: number | null = null;
  try {
    // launch 0 の host が最初の T2 を書いた後（投入が始まった後、道具の drain が見るのと同じ行）に止める。clock の行は投入の前の準備より先に出るので、
    // それを合図にすると止めている間に溜まる報が減り、遅い機械で予約の枠に届かず measured になりうる。
    const obs = join(work, "launch-0", "host-obs.jsonl");
    for (const until = Date.now() + 60_000; !(existsSync(obs) && readFileSync(obs, "utf8").includes('"point":"T2"'));) {
      if (Date.now() > until) throw new Error("no T2 line from the launch 0 host within 60 s");
      await sleep(100);
    }
    const children = execFileSync("pgrep", ["-P", String(tool.pid)], { encoding: "utf8" }).trim().split("\n");
    expect(children).toHaveLength(1);
    host = Number(children[0]);
    signal(host, "SIGSTOP");
    await sleep(STOP_MS);
    signal(host, "SIGCONT");
    expect(await exited).toBe(0);
  } finally {
    // 試験が途中で落ちても host と道具を残さない（道具が終わっていれば host は道具の後始末か disconnect で終わっている。終わった PID は撃たない）。
    if (tool.exitCode == null && tool.signalCode == null) {
      if (host != null) { signal(host, "SIGCONT"); signal(host, "SIGKILL"); }
      tool.kill("SIGKILL");
    }
  }
  const result: unknown = JSON.parse(readFileSync(out, "utf8"));
  // hostExit の code 0 は、host が SIGTERM を受けて自分の stop で終えた印（診断の日別 file を書いたので hostReasons が読める）。
  // hostReasons は出た reason だけを数えるので、欄があれば 1 以上。
  expect(result).toMatchObject({ status: "blocked", blocked: { reason: "hostFailed", launch: 0, hostExit: { code: 0, signal: null }, terminatedBy: "SIGTERM",
    hostReasons: { mailboxRejectedItemLimit: expect.any(Number) } } });
}, 180_000); // T2 の待ち 60 秒＋投入 15 秒＋drain 10 秒＋stop の待ち 60 秒＋SIGTERM 20 秒＋SIGKILL 2 秒＝167 秒に runStage1 を足す
