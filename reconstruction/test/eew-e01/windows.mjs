// A10 WP3c U3（P2-A10-AC08/AC09/AC11/AC15）: E01 以外の窓（E02+E05・E03・AC15・E12・E06）。各窓は run.mjs の runWindow が回す
// { id, expectedMin, run(w) }（w = { dir, scope, progress, commands }）。集計は WP2（judge.ts）・WP3b（aux-measures.mjs）・U4（ac15.mjs）の
// 関数を呼ぶだけで書き直さない。host の起動（startHost）と JSONL の追跡（tailer）は run.mjs のものを ctx で受ける（循環 import を作らない）。
// 受信経路の計算量: 充填の確認・通知の静まり待ち・集計はすべて runner 側（host の外）。host に足すのは E02 の mem 1 秒 timer と AC15 の preload だけ。
import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { ac15Intervals, checkpointWindows, compareRetention, fingerprintTable, judgeAc15, readLatestEnvelopes } from "./ac15.mjs";
import { hostMsOf, parseJsonl, publishCostReport, startFdSampler, summarizeE03, summarizeE05, summarizeE06, summarizeE15 } from "./aux-measures.mjs";
import { hrMs, sleep } from "./chrome.mjs";
import { E12_CLASSES, ac15Frame, cycleCFrames, dataFrame, e03Frame, loadEvents, nearCapacityFrames, sendPaced, sha256Hex, weatherFrame } from "./frames.mjs";

import { summarizeHealthE02 } from "../../dist/src/measurement/eew-e01/judge.js";
import { ZERO_HASH, sealSelfHash } from "../../dist/src/measurement/eew-e01/frozen.js";

const HERE = import.meta.dirname;
const E02_CLIENT = join(HERE, "e02-health-client.mjs");
const E12_RUN = join(HERE, "e12-run.mjs");
const PROBE_PRELOAD = join(HERE, "probe-preload.mjs");

// 通常負荷の再生（E01 の背景と E02・E03 の負荷が共有する）。ReplayLoad の offset どおりに、窓の長さで繰り返す。報告時刻は投入時点の壁時計。
export function replayPump(load, send, wallNow, startHr = hrMs()) {
  const events = loadEvents(load);
  let next = 0;
  return () => {
    for (;;) {
      const cycle = Math.floor(next / events.length);
      const event = events[next % events.length];
      if (startHr + cycle * load.durationMs + event.offsetMs > hrMs()) return;
      send(weatherFrame(event.name, event.headType, wallNow()), event);
      next += 1;
    }
  };
}

const unitOfHead = (headType) => (/^VXSE/.test(headType) ? "U-E" : headType === "VPWP50" ? "U-F" : "U-W");
const readJsonl = (path) => (existsSync(path) ? parseJsonl(readFileSync(path, "utf8")) : []);
export const seal = (path, body, field) => { writeFileSync(path, sealSelfHash(`${JSON.stringify(body, null, 2)}\n`, field)); return path; };
// aux の結果は契約に型が無い。共通の頭 4 つを付けて WP2 と同じ自己 hash 規約で封印する（設計メモ §1.5）。
export const sealAux = (dir, name, manifest, body) => seal(join(dir, name), { schemaVersion: "p2-a10-aux-result-v1", manifestId: manifest.manifestId,
  manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH, ...body }, "resultSha256");
// probe の行（充填を含むと数百 MB）を 1 行ずつ読み、判定区間の始まり以後の行だけを残す（全体を 1 つの文字列にしない）。
async function readProbeRows(path, fromMs) {
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (line === "") continue;
    const row = JSON.parse(line);
    if (row[0] >= fromMs) rows.push(row);
  }
  return rows;
}
// E15 と publish 費用は host を起動した全窓で出す（AC15 は E01・E02 の各窓に PublishCostReport を求める）。byteViolations は窓記録にも出す。
const BYTE_NOTE = "byteViolations は verify 段の bytes が encode と同値（A3 契約どおりの製品）の件数。AC09「他 stage=0」と A3 の食い違いは総合レビュー送りの既知の契約の穴で、判定は変えない";
export function hostReports(records, window) {
  const e15 = summarizeE15(records);
  return { e15, byteViolations: e15.byteViolations ?? null, byteViolationsNote: BYTE_NOTE, publishCost: publishCostReport(records, window) };
}
export const hostReportsOf = (obsPath, window) => hostReports(readJsonl(obsPath), window);
// 窓の結果（runWindow が記録に写す）。予備（--aux・件数指定）は判定にかかわらず status を未確認にし、判定は judgedStatus に残す（run.mjs の約束・AC10）。
function outcome(ctx, judgedStatus, reports, rest) {
  const status = ctx.preliminary ? "未確認" : judgedStatus;
  return { ...rest, status, ...(ctx.preliminary ? { judgedStatus, statusReason: "予備（件数を絞った実走）。合否に使わない" } : {}),
    byteViolations: reports?.byteViolations ?? null, ...(reports == null ? {} : { byteViolationsNote: BYTE_NOTE }) };
}

// ── host の起動と投入（窓の scope に登録）。check() は host の終了と投入側の切断を例外にする ──
async function openHost(w, ctx, options = {}) {
  const h = await ctx.startHost(w.dir, { ...ctx, scope: w.scope, commands: w.commands }, { ...options, status: w.progress });
  h.injector.sendStart();
  const tail = ctx.tailer(h.obsPath);
  let seen = 0;
  let decodes = 0;
  const refresh = () => {
    tail.refresh();
    for (; seen < tail.lines.length; seen++) if (tail.lines[seen].t === "obs" && tail.lines[seen].o.kind === "decode") decodes++;
  };
  for (let i = 0; i < 50 && !tail.lines.some((l) => l.t === "clock"); i++) { refresh(); await sleep(100); }
  const clock = tail.lines.find((l) => l.t === "clock");
  if (clock == null) throw new Error("host clock line not seen within 5s");
  const oh = clock.perfNowMs - Number(BigInt(clock.hrtimeNs)) / 1e6;
  let lastSeq = 0;
  const check = () => {
    if (w.progress.hostExit != null) throw new Error(`host launcher exited mid-window: ${JSON.stringify(w.progress.hostExit)}`);
    if (h.injector.broken != null) throw new Error(h.injector.broken);
  };
  return { ...h, refresh, check, lines: tail.lines,
    processed: () => { refresh(); return decodes; },
    sent: () => lastSeq,
    send: (frame) => { check(); const r = h.injector.send(frame); if (r.seq == null) throw new Error("send failed: injector not connected"); lastSeq = r.seq; return r; },
    wallMs: (at = hrMs()) => ctx.wallOriginMs + Math.trunc(at + oh),
    wallSec: () => ctx.wallOriginMs + Math.floor((hrMs() + oh) / 1000) * 1000,
    snapshot: async () => (await fetch(`http://127.0.0.1:${h.displayPort}/snapshot`, { signal: AbortSignal.timeout(10_000) })).json(),
    records: () => readJsonl(h.obsPath) };
}

// 予定時刻まで待つ（待ちの間も host の終了を見て、負荷を流す）。
async function waitUntil(host, dueHr, pump = null) {
  while (dueHr - hrMs() > 3) { host.check(); pump?.(); await sleep(Math.min(20, dueHr - hrMs() - 2)); }
  while (hrMs() < dueHr) { /* 最後の数 ms は spin */ }
}

// 子プロセス（ipc 付き）を窓の scope に登録して起動する。state.exit は終了の観測（pid の生死を signal で見ない）。
function startChild(w, ctx, args, name) {
  const proc = spawn(ctx.nodePath, args, { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const state = { exit: null };
  proc.once("exit", (code, signal) => { state.exit = { code, signal }; });
  proc.on("error", (error) => { state.exit ??= { code: null, signal: null, error: String(error?.message ?? error) }; });
  w.scope.children.push({ name, pid: proc.pid, alive: () => state.exit == null, kill: () => proc.kill("SIGKILL") });
  w.scope.add(async () => {
    if (state.exit != null) return;
    proc.kill("SIGTERM");
    for (let i = 0; i < 30 && state.exit == null; i++) await sleep(100);
    if (state.exit == null) proc.kill("SIGKILL");
  });
  w.commands.push([ctx.nodePath, ...args].join(" "));
  return state;
}
async function waitChild(state, deadlineMs, onTick = () => {}) {
  const deadline = hrMs() + deadlineMs;
  while (state.exit == null) {
    onTick();
    if (hrMs() > deadline) throw new Error(`child did not exit within ${Math.round(deadlineMs / 1000)}s`);
    await sleep(50);
  }
  if (state.exit.code !== 0) throw new Error(`child exited ${JSON.stringify(state.exit)}`);
}

// ── 充填（initial-state の nearCapacity recipe）: sendPaced で送り、recipe の expected（/snapshot の activeCount と保存済み checkpoint の件数）が
// 揃うまで待つ。期限（2 分）までに揃わなければ stateNotReproducible。snapshotsAt の位置（送った frame 数）で /snapshot を取る（AC15 の指紋表用）。
async function observedCounts(host, stateDir, expected) {
  const snapshot = await host.snapshot();
  let payload = {};
  try { payload = Object.fromEntries(readLatestEnvelopes(stateDir).map((e) => [e.unit, e.payload])); } catch { /* 保存前・書き換え中は次の周回で読む */ }
  const checkpoint = { "U-W.national": Object.values(payload["U-W"]?.national ?? {}).filter((v) => v != null).length,
    "U-W.partials": payload["U-W"]?.partials?.length ?? null, "U-F.subjects": payload["U-F"]?.subjects?.length ?? null };
  const domain = (k) => {
    if (!Array.isArray(snapshot.current?.[k]?.items)) throw new Error(`stateNotReproducible: /snapshot has no current.${k}.items`);
    return snapshot.current[k].items.map((i) => i.activeCount).join("/");
  };
  return { snapshotActive: Object.fromEntries(Object.keys(expected.snapshotActive).map((k) => [k, domain(k)])),
    checkpoint: Object.fromEntries(Object.keys(expected.checkpoint).map((k) => [k, checkpoint[k]])) };
}
// snapshotsAt は送った frame の列から /snapshot を取る位置の配列を返す関数（充填の件数が mode で変わるため）。
async function fill(host, w, ctx, mode, { snapshotsAt = () => [] } = {}) {
  const recipe = ctx.initialState.nearCapacity.modes[mode];
  if (recipe?.expected == null) throw new Error(`stateNotReproducible: initial-state nearCapacity.modes.${mode}.expected is null (room not frozen)`);
  const frames = nearCapacityFrames(mode === "leaveRoomForP" ? { mode, room: recipe.room } : { mode });
  const started = hrMs();
  const sentBefore = host.sent();
  const snapshots = [];
  let from = 0;
  w.progress.phase = "fill";
  for (const to of [...snapshotsAt(frames).filter((i) => i > 0 && i < frames.length), frames.length]) {
    await sendPaced(frames.slice(from, to), { send: host.send, processed: host.processed, sentBefore: host.sent() });
    if (to < frames.length) snapshots.push(await host.snapshot());
    from = to;
  }
  const sentMs = hrMs() - started;
  const verify = async (deadlineMs) => {
    const deadline = hrMs() + deadlineMs;
    for (;;) {
      host.check();
      const observed = await observedCounts(host, join(w.dir, "state"), recipe.expected);
      if (JSON.stringify(observed) === JSON.stringify(recipe.expected)) return observed;
      if (hrMs() > deadline) throw new Error(`stateNotReproducible: ${mode} expected ${JSON.stringify(recipe.expected)}, observed ${JSON.stringify(observed)}`);
      await sleep(1000);
    }
  };
  const observed = await verify(120_000);
  const record = { mode, frames: frames.length, firstSeq: sentBefore + 1, sentMs: Math.round(sentMs), verifiedMs: Math.round(hrMs() - started), observed };
  w.progress.fill = record;
  w.progress.phase = "quiet";
  record.quiet = await quietWait(host.pid, w);
  // 静まりの間に状態が変わっていないこと（測定開始の直前にもう一度）。
  record.observedBeforeMeasure = await verify(0);
  // record は窓の記録へ、snapshots（AC15 の指紋表）と headTypes（AC15 の unitOfInput）は付帯物として分けて返す。
  return { record, snapshots, headTypes: frames.map((f) => f.headType) };
}

// 通知の静まり待ち（統合担当の決定 2026-09-30）: 充填の通知 backend（osascript・afplay など host launcher の子）が 15 秒続けて 0 になるまで待つ
// （notification-delivery の retry backoff 最大 10 秒＋tick 1 秒より長く）。無いと、充填で起きた数百件の通知の処理が測定区間に漏れる。
// 期限 10 分で notificationBacklog。外から pgrep で数える（製品・host に手を入れない）。pgrep の失敗（exit 1 = 子なし 以外）は子 0 と数えず、
// 静まりの起点を戻して数え直す。5 回続けて失敗したら Blocked。
const childrenOf = (pid) => new Promise((done) => execFile("pgrep", ["-l", "-P", String(pid)], (error, stdout) => {
  if (error != null && error.code !== 1) { done(null); return; }
  done(String(stdout ?? "").split("\n").filter((l) => l.trim() !== "").map((l) => { const [p, ...name] = l.trim().split(/\s+/); return [p, name.join(" ")]; }));
}));
async function quietWait(pid, w, { quietMs = 15_000, deadlineMs = 600_000, pollMs = 100 } = {}) {
  const started = hrMs();
  const seen = new Map();
  let quietSince = null;
  let failures = 0;
  let pgrepFailures = 0;
  const summary = () => ({ waitedMs: Math.round(hrMs() - started), untilLastBackendMs: Math.round((quietSince ?? hrMs()) - started),
    backendLaunchesSeen: [...seen.values()].reduce((m, name) => ({ ...m, [name]: (m[name] ?? 0) + 1 }), {}), quietMs, pgrepFailures,
    note: `${pollMs}ms ごとの pgrep -P で見えた子の数（短命な起動は取りこぼしうる下限）` });
  for (;;) {
    const kids = await childrenOf(pid);
    const now = hrMs();
    if (kids == null) {
      pgrepFailures += 1;
      quietSince = null;
      if (++failures >= 5) { w.progress.quiet = summary(); throw new Error("notificationBacklog: pgrep failed 5 times in a row; the backend count is unknown"); }
      await sleep(pollMs);
      continue;
    }
    failures = 0;
    for (const [p, name] of kids) seen.set(p, name);
    if (kids.length > 0) quietSince = null;
    else if ((quietSince ??= now) <= now - quietMs) break;
    if (now - started > deadlineMs) { w.progress.quiet = summary(); throw new Error(`notificationBacklog: notification backends still running after ${deadlineMs / 60_000} min`); }
    await sleep(pollMs);
  }
  w.progress.quiet = summary();
  return w.progress.quiet;
}

// ── E02+E05（AC11・AC08）: 別プロセスの /healthz client を走らせ、その間 N または P（充填の後）を流す ──
// spec §9.9 は E05 を「RSS を毎秒」と定める。10 秒では VPWS50 処理中の山を取り逃す。host の採取周期と E05 の欠測判定が同じ値を使う。
const E05_MEM_EVERY_MS = 1000;
function e02Window(ctx, load, run) {
  const { requestEveryMs, requestTimeoutMs, minSamplesPerRun } = ctx.manifest.health;
  const count = ctx.counts.e02 ?? minSamplesPerRun;
  const id = `e02-${load}-run${run}`;
  return {
    id, expectedMin: Math.ceil((count * requestEveryMs) / 60_000) + (load === "P" ? 6 : 2),
    run: async (w) => {
      const host = await openHost(w, ctx, { memEveryMs: E05_MEM_EVERY_MS });
      const filled = load === "P" ? await fill(host, w, ctx, "leaveRoomForP") : null;
      const out = join(w.dir, "e02.jsonl");
      const client = startChild(w, ctx, [E02_CLIENT, "--url", `http://127.0.0.1:${host.displayPort}/healthz`, "--count", String(count), "--every-ms", String(requestEveryMs),
        "--timeout-ms", String(requestTimeoutMs), "--load", load, "--run", String(run), "--out", out], "e02-client");
      const pump = replayPump(ctx.manifest.loads[load], host.send, host.wallSec);
      w.progress.phase = "measure";
      w.progress.total = count;
      let beat = 0;
      await waitChild(client, count * requestEveryMs + 120_000, () => {
        host.check();
        pump();
        if (hrMs() - beat > 10_000) { beat = hrMs(); w.progress.trialsStarted = readJsonl(out).filter((r) => r.sampleIndex != null).length; }
      });
      await host.stop();
      const records = host.records();
      const rows = readJsonl(out);
      const samples = rows.filter((r) => r.sampleIndex != null);
      const [start, end] = ["start", "end"].map((t) => rows.find((r) => r.t === t));
      // 判定は WP2 の summarizeHealthE02。1 run 分の標本だけを渡しても、この run の行は run ごとに絞った同じ規則で決まる（他の run の行は捨てる）。
      // 6 run をまとめた判定は窓ループの後に e02Verdict が 1 回だけ作る。
      const health = summarizeHealthE02(ctx.manifest, samples).find((r) => r.load === load && r.run === run);
      const e05 = summarizeE05(records, load, { fromHrtimeNs: start.hrtimeNs, toHrtimeNs: end.hrtimeNs }, { memEveryMs: E05_MEM_EVERY_MS });
      const reports = hostReports(records, id);
      // 窓の status は E02（この窓の主の判定）。E05 は statuses に別に持つ（まとめて潰さない）。予備は status と同じく未確認に倒し、判定は judgedStatuses へ。
      const statuses = { E02: health.status, E05: e05.status };
      const o = outcome(ctx, health.status, reports, { fill: filled?.record ?? null,
        ...(ctx.preliminary ? { statuses: { E02: "未確認", E05: "未確認" }, judgedStatuses: statuses } : { statuses }) });
      o.resultFiles = [
        seal(join(w.dir, `result-e02-${load}-run${run}.json`), { ...health, ...(ctx.preliminary ? { status: o.status, judgedStatus: health.status } : {}),
          evidenceRefs: [`${w.dir}/e02.jsonl`, `${w.dir}/host-obs.jsonl`] }, "resultSha256"),
        sealAux(w.dir, `aux-e05-${load}-run${run}.json`, ctx.manifest, { window: id, status: ctx.preliminary ? o.status : e05.status, e05, ...reports, fill: o.fill }),
      ];
      return o;
    },
  };
}

// E02 の判定（6 run をまとめて WP2 の summarizeHealthE02 に 1 回渡す）。windows は窓ごとの最新 attempt。Blocked・生データの hash 違いの run は標本に入れない。
export function e02Verdict(manifest, windows) {
  const samples = [];
  const unusable = {};
  for (const w of windows.filter((x) => x.id.startsWith("e02-") && x.status !== "Blocked")) {
    try {
      const bytes = readFileSync(join(w.rawDir, "e02.jsonl"));
      if (sha256Hex(bytes) !== w.raw?.find((r) => r.file === "e02.jsonl")?.sha256) throw new Error("e02.jsonl sha256 differs from the window record");
      samples.push(...parseJsonl(bytes.toString("utf8")).filter((r) => r.sampleIndex != null));
    } catch (error) { unusable[w.id] = String(error?.message ?? error); }
  }
  return { schemaVersion: "p2-a10-e02-verdict-v1", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
    runs: summarizeHealthE02(manifest, samples), unusable };
}

// ── E03（AC08）: N を流しながら VPWS50 の系列（initial-state の e03Series）。targetInputIds は投入側の seq（host の input-<n> と 1 本の接続で一致） ──
function e03Window(ctx, run) {
  const series = ctx.initialState.e03Series;
  const samples = ctx.counts.e03 ?? series.samples;
  const warmup = ctx.counts.e03 == null ? series.warmup : Math.min(series.warmup, Math.ceil(samples / 5));
  return {
    id: `e03-run${run}`, expectedMin: Math.ceil(((warmup + samples) * series.periodMs) / 60_000) + 2,
    run: async (w) => {
      const host = await openHost(w, ctx);
      const pump = replayPump(ctx.manifest.loads.N, host.send, host.wallSec);
      const startHr = hrMs() + 1000;
      const startWall = host.wallMs(startHr);
      const targets = [];
      w.progress.phase = "measure";
      w.progress.total = warmup + samples;
      for (let k = 0; k < warmup + samples; k++) {
        const item = e03Frame(k, startWall);
        const frame = dataFrame(item.headType, item.xml); // gzip は数十 ms かかるので待つ前に作る
        await waitUntil(host, startHr + k * series.periodMs, pump);
        const { seq } = host.send(frame);
        if (k >= warmup) targets.push(`input-${seq}`);
        w.progress.trialsStarted = k + 1;
      }
      const last = targets.at(-1);
      const deadline = hrMs() + 30_000;
      let scanned = 0;
      let done = false;
      while (!done && hrMs() < deadline) {
        host.check();
        host.refresh();
        for (; scanned < host.lines.length; scanned++) if (host.lines[scanned].t === "obs" && host.lines[scanned].o.kind === "processing" && host.lines[scanned].o.measurement.inputId === last) done = true;
        if (!done) await sleep(500);
      }
      await sleep(1500);
      await host.stop();
      const records = host.records();
      const e03 = summarizeE03(records, targets, { minSamples: ctx.manifest.auxiliary.E03.minSamplesPerRun });
      // host の通し番号と投入側の seq が一致すること（全 frame が 1 本の接続で届いた）を T0 の件数で確かめる。ずれたら未確認。
      const t0 = records.filter((r) => r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0").length;
      const aligned = t0 === host.sent();
      const reports = hostReports(records, `e03-run${run}`);
      const o = outcome(ctx, aligned ? e03.status : "未確認", reports, {});
      o.resultFiles = [sealAux(w.dir, `aux-e03-run${run}.json`, ctx.manifest,
        { window: `e03-run${run}`, status: o.status, warmup, samples, e03, seqAlignment: { t0, sent: host.sent(), aligned }, ...reports })];
      return o;
    },
  };
}

// ── AC15（P2-A10-AC15）: 保持上限ちょうど（full）から 4 シナリオ。stringify probe は preload（probe-preload.mjs の FLEQ_STRINGIFY_OUT）。 ──
// metadata は frame ではなく投入側の WS 切断（server 側で terminate）。区間の起点は切断時刻（投入側 hrtime を host 時計へ写した値）で、
// host の記録の「その時刻以前で最後の時刻付きの行」の直後に T0 を差し込み、U4 の ac15Intervals で他の区間と同じ規則（次の起点まで）で切る。
// publishSerialization は時刻を持たず、切断と再接続の間は時刻付きの行がほとんど無いので区間への振り分けが定まらない。
// metadata の区間は切断と再接続の 2 回の状態変化で publish 2 回と想定して判定へ渡し、記録順で振った実数は別に報告する。
const syntheticT0 = (event) => ({ t: "obs", o: { kind: "marker", point: "T0", runId: "runner", inputId: event.id, monotonicMs: event.hostMs } });
function withSyntheticT0(records, events) {
  const time = (r) => (r.t === "clock" || r.t === "mem" ? r.perfNowMs : r.t !== "obs" ? null : r.o.kind === "marker" ? r.o.monotonicMs
    : r.o.kind === "decode" ? r.o.endedMonotonicMs : r.o.kind === "processing" || r.o.kind === "checkpoint" ? r.o.measurement.endedMonotonicMs : null);
  const sorted = [...events].sort((a, b) => a.hostMs - b.hostMs);
  const out = [];
  let untimed = [];
  let e = 0;
  for (const r of records) {
    const t = time(r);
    if (t == null) { untimed.push(r); continue; }
    while (e < sorted.length && sorted[e].hostMs < t) out.push(syntheticT0(sorted[e++]));
    out.push(...untimed, r);
    untimed = [];
  }
  while (e < sorted.length) out.push(syntheticT0(sorted[e++]));
  out.push(...untimed);
  return out;
}
// 1 回分の測定: mode（full・half）の充填から 4 シナリオ。host の dir は窓の dir の下の mode ごと（state・probe・obs を分ける）。
async function ac15Measure(w, ctx, mode, { s, warmup, samples }) {
  const dir = join(w.dir, mode);
  mkdirSync(dir, { recursive: true });
  const m = { ...w, dir };
  const probePath = join(dir, "stringify.jsonl");
  const host = await openHost(m, ctx, { nodeArgs: ["--import", PROBE_PRELOAD], env: { FLEQ_STRINGIFY_OUT: probePath } });
  // 保持上限では view が summary に落ちるので、各 unit の要素が full で見える充填途中の /snapshot を取る（EEW 2 件・national 1 件・partial 2 件・forecast 2 件の後）。
  const first = (frames, headType) => frames.findIndex((f) => f.headType === headType);
  const filled = await fill(host, m, ctx, mode, { snapshotsAt: (frames) => [2, first(frames, "VPWS50") + 1, first(frames, "VPWW57") + 2, first(frames, "VPWP50") + 2] });
  const envelopes = readLatestEnvelopes(join(dir, "state"));
  const table = fingerprintTable(envelopes, [...filled.snapshots, await host.snapshot()]);
  w.progress.phase = `measure:${mode}`;
  // unitOfInput は測定で流した全入力（充填・warm-up を含む）。unitOf は判定する区間（warm-up を除く）。
  const unitOfInput = new Map(filled.headTypes.map((h, i) => [`input-${filled.record.firstSeq + i}`, unitOfHead(h)]));
  const unitOf = new Map();
  const metadata = [];
  let due = hrMs() + 1000;
  for (const name of s.order) {
    for (let i = 0; i < warmup + samples; i++) {
      const item = name === "metadata" ? null : ac15Frame(name, i);
      const frame = item == null ? null : dataFrame(item.headType, item.xml);
      await waitUntil(host, due);
      if (frame == null) {
        const hrtimeNs = process.hrtime.bigint().toString();
        const reconnectMs = await host.injector.reconnect(15_000);
        host.injector.sendStart();
        metadata.push({ id: `metadata-${i}`, index: i, hrtimeNs, reconnectMs });
      } else {
        const { seq } = host.send(frame);
        unitOfInput.set(`input-${seq}`, name);
        if (i >= warmup) unitOf.set(`input-${seq}`, name);
      }
      due += name === "metadata" ? s.metadataIntervalMs : s.intervalMs;
      w.progress.trialsStarted += 1;
    }
  }
  await sleep(s.intervalMs + 500);
  await host.stop();
  const records = host.records();
  const events = metadata.map((x) => ({ ...x, hostMs: hostMsOf(records, x.hrtimeNs) }));
  for (const x of events.filter((e) => e.index >= warmup)) unitOf.set(x.id, "metadata");
  const lastT0 = records.reduce((a, r) => (r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0" ? Math.max(a, r.o.monotonicMs) : a), -Infinity);
  // 最後の区間の終わりは最後の T0 + 1500ms（U4 の申し送り）。
  const intervals = ac15Intervals(withSyntheticT0(records, events), unitOf, { endMs: lastT0 + s.intervalMs });
  const publishObserved = [];
  for (const x of intervals.filter((i) => i.unit === "metadata")) { publishObserved.push(x.publishCount); x.publishCount = 2; }
  const judged = judgeAc15(await readProbeRows(probePath, intervals[0]?.startMs ?? 0), intervals, table, { checkpointWindows: checkpointWindows(records), unitOfInput, minInputsPerUnit: samples });
  const reports = hostReports(records, `ac15-${mode}`);
  const assumedMinus = judged.scenarios.metadata?.snapshotCallsMinusPublish ?? null;
  const observedTotal = publishObserved.reduce((a, b) => a + b, 0);
  return { judged, reports, body: { mode, status: judged.status, fill: filled.record, fingerprintTable: table, judged,
    metadata: { reconnectMs: events.map((x) => Math.round(x.reconnectMs)),
      assumed: { publishPerInterval: 2, snapshotCallsMinusPublish: assumedMinus },
      observed: { publishPerIntervalByRecordOrder: publishObserved, publishTotal: observedTotal,
        snapshotCallsMinusPublish: assumedMinus == null ? null : assumedMinus + 2 * publishObserved.length - observedTotal },
      note: "判定へは切断と再接続の 2 回の状態変化で publish 2 回と想定して渡す。observed は時刻の無い publish を記録順で区間に振った実数とそれで数え直した値" },
    ...reports } };
}
// 窓の判定: full・half それぞれの judgeAc15 と、保持量の対照（compareRetention）。どれかが Fail なら Fail、どれかが未確認なら未確認。
function ac15Window(ctx) {
  const s = ctx.initialState.ac15Scenarios;
  const samples = ctx.counts.ac15 ?? s.samples;
  const warmup = ctx.counts.ac15 == null ? s.warmup : Math.min(s.warmup, Math.ceil(samples / 5));
  const perScenarioMs = (name) => (warmup + samples) * (name === "metadata" ? s.metadataIntervalMs : s.intervalMs);
  const modes = s.retention?.modes ?? [];
  return {
    id: "ac15", expectedMin: Math.max(modes.length, 1) * (Math.ceil(s.order.reduce((a, name) => a + perScenarioMs(name), 0) / 60_000) + 6),
    run: async (w) => {
      if (s.retention?.maxSlopePerRetained == null || modes.join() !== "full,half") {
        throw new Error("stateNotReproducible: initial-state ac15Scenarios.retention { modes: [full, half], maxSlopePerRetained } is missing (re-freeze the manifest)");
      }
      w.progress.total = modes.length * s.order.length * (warmup + samples);
      w.progress.trialsStarted = 0;
      const runs = {};
      for (const mode of modes) runs[mode] = await ac15Measure(w, ctx, mode, { s, warmup, samples });
      // 保持件数は充填の observed（recipe の expected と一致を確かめた値）: U-E は EventID 数、U-W は partial 数、U-F は subject 数。
      const retainedOf = (observed) => ({ "U-E": Number(observed.snapshotActive.eew.split("/")[0]), "U-W": observed.checkpoint["U-W.partials"], "U-F": observed.checkpoint["U-F.subjects"] });
      const retained = { full: retainedOf(runs.full.body.fill.observed), half: retainedOf(runs.half.body.fill.observed) };
      const retention = compareRetention(runs.full.judged, runs.half.judged, { maxSlope: s.retention.maxSlopePerRetained, retained });
      const statuses = [runs.full.judged.status, runs.half.judged.status, retention.status];
      const status = statuses.includes("Fail") ? "Fail" : statuses.includes("未確認") ? "未確認" : "Pass";
      const o = outcome(ctx, status, runs.full.reports, { fill: runs.full.body.fill, ac15Parts: { full: statuses[0], half: statuses[1], retention: statuses[2] } });
      o.resultFiles = [sealAux(w.dir, "aux-ac15.json", ctx.manifest, { window: "ac15", status: o.status, warmup, samples, retention,
        full: runs.full.body, half: runs.half.body, ...runs.full.reports })];
      return o;
    },
  };
}

// ── E12（AC08）: e12-run.mjs を子プロセスで起動する（import すると最上位の SIGINT handler が runner の handler を奪う） ──
function e12Window(ctx, cls, run) {
  return {
    id: `e12-${cls}-run${run}`, expectedMin: 4,
    run: async (w) => {
      w.progress.phase = "measure";
      const child = startChild(w, ctx, [E12_RUN, "--out", w.dir, "--class", cls, "--node", ctx.nodePath, ...(ctx.counts.e12 == null ? [] : ["--count", String(ctx.counts.e12)])], "e12-run");
      await waitChild(child, 6 * 60_000);
      const report = JSON.parse(readFileSync(join(w.dir, "report.json"), "utf8"));
      // E12 は報告のみ（閾値なし）。旧新とも集計できたら N/A、どちらかが未確認なら未確認。
      const status = [report.old, report.new].every((side) => side != null && side.status == null) ? "N/A" : "未確認";
      const o = outcome(ctx, status, null, { allocation: report.allocation ?? null });
      o.resultFiles = [sealAux(w.dir, `aux-e12-${cls}-run${run}.json`, ctx.manifest, { window: `e12-${cls}-run${run}`, status: o.status, report })];
      return o;
    },
  };
}

// ── E06（AC08）: 保持上限ちょうど（cycleC）から C を周期ごとに流す。FD は lsof を 60 秒ごと（runner 側）。閾値なし（報告のみ） ──
function e06Window(ctx) {
  const c = ctx.initialState.cycleC;
  const cycles = ctx.counts.e06Cycles ?? c.cycles;
  return {
    id: "e06", expectedMin: Math.ceil((cycles * c.periodMs) / 60_000) + 6,
    run: async (w) => {
      const host = await openHost(w, ctx);
      const filled = await fill(host, w, ctx, "cycleC");
      w.progress.phase = "measure";
      const fd = startFdSampler(host.pid, 60_000);
      w.scope.add(() => fd.stop());
      const start0 = hrMs() + 1000;
      const firstInputs = [];
      w.progress.total = cycles;
      for (let k = 0; k < cycles; k++) {
        const cycleStart = start0 + k * c.periodMs;
        const frames = cycleCFrames(k, host.wallMs(cycleStart));
        for (const [i, f] of frames.entries()) {
          const frame = dataFrame(f.headType, f.xml);
          await waitUntil(host, cycleStart + f.offsetMs);
          const { seq } = host.send(frame);
          if (i === 0) firstInputs.push(`input-${seq}`);
        }
        w.progress.trialsStarted = k + 1;
      }
      await waitUntil(host, start0 + cycles * c.periodMs);
      fd.stop();
      await host.stop();
      const records = host.records();
      const t0 = new Map(records.flatMap((r) => (r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0" ? [[r.o.inputId, r.o.monotonicMs]] : [])));
      // 定常開始 = warm-up の後の最初の周期の最初の入力の T0（周期が足りない予備は最後の周期）。
      const steadyCycle = Math.min(c.warmupCycles, cycles - 1);
      const e06 = summarizeE06(records, fd.samples, { steadyStartMs: t0.get(firstInputs[steadyCycle]) });
      // 周期ごとの期待（initial-state の cycleC.expectedPerCycle）: 診断 eewCapacityEvicted が 1 件。診断の timestamp（host 壁時計）で周期に振る。
      const wall0 = host.wallMs(start0);
      const evicted = Array(cycles).fill(0);
      const diagDir = join(w.dir, "diagnostics");
      for (const name of existsSync(diagDir) ? readdirSync(diagDir).filter((f) => f.endsWith(".jsonl")) : []) {
        for (const d of readJsonl(join(diagDir, name))) {
          const k = Math.floor((d.timestamp - wall0) / c.periodMs);
          if (d.reason === "eewCapacityEvicted" && k >= 0 && k < cycles) evicted[k] += d.count ?? 1;
        }
      }
      const reports = hostReports(records, "e06");
      const o = outcome(ctx, e06.complete ? "N/A" : "未確認", reports, { fill: filled.record, eewCapacityEvictedPerCycle: evicted });
      o.resultFiles = [sealAux(w.dir, "aux-e06.json", ctx.manifest, { window: "e06", status: o.status, cycles, steadyCycle, fill: filled.record,
        e06, perCycle: { eewCapacityEvicted: evicted, expected: c.expectedPerCycle }, fdSamples: fd.samples.length, ...reports })];
      return o;
    },
  };
}

// 窓の並び（設計メモ §1.2: E02+E05 N → P、E03、AC15、E12、E06）。ctx.runs は run 数の上書き（予備）。
export function auxWindows(ctx) {
  const runs = (n) => Array.from({ length: ctx.runs ?? n }, (_, i) => i + 1);
  return [
    ...ctx.manifest.health.loads.flatMap((load) => runs(ctx.manifest.health.runCount).map((run) => e02Window(ctx, load, run))),
    ...runs(ctx.manifest.auxiliary.E03.runCount).map((run) => e03Window(ctx, run)),
    ac15Window(ctx),
    ...runs(ctx.manifest.auxiliary.E12.runCount).flatMap((run) => Object.keys(E12_CLASSES).map((cls) => e12Window(ctx, cls, run))),
    e06Window(ctx),
  ];
}
