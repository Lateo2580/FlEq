// A10 WP3b E12（AC08）: 旧側の薄い launcher。旧 message-router の createMessageHandler().handler を、凍結した frames で叩くだけ。
// 製品処理を複製しない。副作用の遮断（通知・通知音・config）は scripts/replay-bench.mjs と同じ手順（資材として読んだ）。
// GC/heap は probe-preload.mjs（`--import`）と `--heap-prof` を外側で付ける。
//
// usage: node [--heap-prof --heap-prof-dir=D --import probe-preload.mjs] e12-legacy-launcher.mjs --frames frames.jsonl --out calls.json
//   frames.jsonl の各行: {"atMs":<開始からの予定 ms>,"frame":"<dmdata 形式の完全 frame 文字列>"}
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { parseFlags } from "./aux-measures.mjs";

const values = parseFlags(process.argv.slice(2));
const repoRoot = resolve(import.meta.dirname, "../../..");
const frames = readFileSync(values.frames, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

// engine の console.log は stderr へ回す（write 自体は行うので描画費用は計測から落ちない）。
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);

// config と eew-logs を隔離（dist は module load 時に cwd/XDG を読むので require より前）。
const workDir = mkdtempSync(join(tmpdir(), "fleq-e12-legacy-"));
process.env.XDG_CONFIG_HOME = workDir;
mkdirSync(join(workDir, "fleq"), { recursive: true });
writeFileSync(join(workDir, "fleq", "config.json"), "{}\n");
process.chdir(workDir);
// 正常終了・例外・process.exit のどれでも workDir を消す。親(e12-run)の stop / disconnect でも止まる。
process.on("exit", () => { try { process.chdir(tmpdir()); rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } });
process.on("message", (m) => { if (m?.t === "stop") process.exit(1); });
process.on("disconnect", () => process.exit(1));

// dist は CommonJS。ESM からは default import で module.exports を受ける。
const dist = async (name) => (await import(join(repoRoot, "dist", name))).default;
(await dist("engine/notification/node-notifier-loader.js")).setNodeNotifierOverride({ notify: () => undefined });
(await dist("engine/notification/sound-player.js")).dispose();
// 旧側は createMessageHandler({})（display・displaySink・永続化なし）。新側は射影・SSE publish・checkpoint を含む。揃えず記録する（E12 は報告のみ）。
const { handler } = (await dist("engine/messages/message-router.js")).createMessageHandler({});

const calls = [];
let memBefore = null;
let memAfter = null;
const startedAt = performance.now();
for (const [index, { atMs, frame }] of frames.entries()) {
  await new Promise((wake) => setTimeout(wake, Math.max(0, startedAt + atMs - performance.now())));
  const message = JSON.parse(frame);
  // replay 区間の heap は、最初の投入の直前と最後の処理の直後で取る（module 読み込みは含めない）。
  if (index === 0) memBefore = process.memoryUsage();
  const started = performance.now();
  handler(message);
  if (index === frames.length - 1) memAfter = process.memoryUsage();
  calls.push({ index, atMs, startedMs: started, durationMs: performance.now() - started, headType: message.head?.type ?? null });
}
await new Promise((wake) => setTimeout(wake, 200));

writeFileSync(values.out, JSON.stringify({ schemaVersion: "p2-e12-legacy-v1", nodeVersion: process.version, frames: frames.length, calls, memBefore, memAfter }));
process.exit(0);
