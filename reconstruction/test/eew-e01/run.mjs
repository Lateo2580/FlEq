// P2-A10 E01 の入口: node reconstruction/test/eew-e01/run.mjs --manifest <path> | --preliminary [options]
// 製品経路（ローカル WS → startP2Host → SSE → 実 Chrome）で EEW の T0→T6 を測る。runner は入力の送出と証拠収集だけで、
// 製品の入力処理はここに持たない。E01 以外（E02/E03/E05/E06/E12/E15/費用）の窓は U3 が WINDOWS の並びへ足す。
// --manifest: verifyFrozenManifest と起動時の確認を通った凍結 manifest だけを、窓を順に回す 1 本のループで走らせる。落ちた窓は Blocked と記録して次へ。
//   --windows <id,...>: 前回 Blocked（または未実施）の窓だけを再実行する。結果は上書きせず -attempt<k> を付ける。
// --preliminary: 案（draft）で走らせ、結果の status は必ず「未確認」。
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import { basename, join, relative } from "node:path";
import { WebSocketServer } from "ws";

import { assembleTrials, analyzeTrace, buildHostIndex, referenceRecord } from "./analysis.mjs";
import { chromeVersion, hrMs, openPage, probeClock, sleep, startTracing, stopTracing } from "./chrome.mjs";
import { SMOKE_FILE, buildDraft, contractTextsFor } from "./draft.mjs";
import { REPO, dataFrame, eewVariant, eventIdOf, fixtureId, fixtureText, sha256Hex, loadEvents, shiftTimestamps, weatherFrame } from "./frames.mjs";

import { classifyEewCause, quantiles, summarizeEewE01 } from "../../dist/src/measurement/eew-e01/judge.js";
import { ZERO_HASH, forecastWithinAllowance, sealSelfHash, verifyFrozenManifest } from "../../dist/src/measurement/eew-e01/frozen.js";

const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const RUNS_ROOT = join(homedir(), "dev/fleq-a10-runs");
const EVIDENCE_DIR = join(REPO, "reconstruction/test/eew-e01/evidence");
const T6C = "fleq:p2:eew:T6-candidate";
const POP_CODE = { fixedBacklog: 0, maxVpws50DecodeStarted: 1, maxWeatherCheckpointEncodeStarted: 2, maxForecastCheckpointSave: 3, forecastDeadlineOverlap: 4 };
const BLOCK = 100; // trace は 100 試行ごとに区切る
const UF_SMALL_VALID_AFTER_REPORT_MS = 49 * 3_600_000; // 81_01_04 系の validUntil は報告時刻の 49 時間後（Phase 0 で実測）

const SILENT_NOTE = "silent stub による probe（spawn の相手を /usr/bin/true に替えた結果）で、実 backend の結果ではない";

const LAUNCHER = join(REPO, "reconstruction/test/eew-e01/host-launcher.mjs");
// 起動時に存在を確かめる生成物（WP3c §1.1）。無いと、該当する窓が夜の途中で落ちる（E12 の旧側は 5 時間後）。
const DIST_REQUIRED = ["reconstruction/dist/src/host/host.js", "reconstruction/dist/chrome-eew", "dist/engine/messages/message-router.js"];

// 後始末のリスト。窓ごとに 1 つ作り、窓の終わりに逆順で全部呼ぶ（WP3c §2.1: リストが 1 つだと 2 つ目の窓から子が止まらない）。
// close は Promise を共有し、2 回目以降の呼び出し（例外の後の SIGINT など）も同じ後始末の完了を待つ。
// 閉じた後の add はその場で呼ぶ（期限切れで置き去りにした窓の処理が遅れて起動した子も止める）。
// children は窓の後の孤児確認に使う（{ name, pid, alive(), kill() }。生死は pid ではなく exit の観測で見る。終了済みの pid へ signal を送らない）。
function cleanupScope() {
  const fns = [];
  let closing = null;
  const call = async (fn) => { try { await fn(); } catch { /* 後始末の失敗で他の後始末を止めない */ } };
  return {
    children: [],
    add: (fn) => { if (closing != null) void call(fn); else fns.push(fn); },
    close: () => (closing ??= (async () => { for (const fn of fns.splice(0).reverse()) await call(fn); })()),
  };
}
const root = cleanupScope(); // プロセス全体（caffeinate）
let current = root; // SIGINT/SIGTERM で閉じる今の窓

// ── 独立投入側: host と別プロセスのローカル WS server ──
async function startInjector(scope) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => server.once("listening", done));
  let socket = null;
  let seq = 0;
  let closing = false;
  const waiters = [];
  // 通し番号は host の input-<n> と 1 本の connection の上でだけ一致する。2 本目・切断が起きたら run を中止する（試行ループの先頭で見る）。
  server.on("connection", (ws) => {
    if (socket != null) { injector.broken ??= "結合不能: 投入側に 2 本目の connection が来た（通し番号と host の input-<n> がずれる）"; return; }
    socket = ws;
    ws.on("close", () => { if (!closing) injector.broken ??= "結合不能: 投入側の socket が close した（通し番号と host の input-<n> がずれる）"; });
    ws.on("message", () => { /* pong など。host 側の観測は launcher の JSONL が正 */ });
    ws.on("error", () => {});
    waiters.splice(0).forEach((f) => f());
  });
  const injector = {
    broken: null,
    url: `ws://127.0.0.1:${server.address().port}/`,
    connected: () => socket != null && socket.readyState === 1 ? Promise.resolve() : new Promise((f) => waiters.push(f)),
    sendStart: () => socket?.send(JSON.stringify({ type: "start", socketId: 1, classifications: ["eew.forecast"] })),
    // 実投入時刻は送る直前の hrtime。同一スレッドの timer の予定時刻は使わない。通し番号は host の input-<n> と一致する。
    send: (frame) => {
      if (socket == null || socket.readyState !== 1) return { seq: null, injectedHrMs: null };
      seq += 1;
      const injectedHrMs = hrMs();
      socket.send(frame);
      return { seq, injectedHrMs };
    },
    close: () => new Promise((done) => { closing = true; for (const c of server.clients) c.terminate(); server.close(() => done()); }),
  };
  scope.add(() => injector.close());
  return injector;
}

// ── host launcher の起動（WP3c §1.3）: 投入側・config・spawn（ipc 付き）・ready・接続を待ち、後始末を窓のリストへ登録する ──
// E01 と周辺の窓（U3）が共有する。status に hostExit/hostError を書く（窓が Blocked の childExit に使う）。
async function startHost(dir, ctx, { memEveryMs = 10_000, nodeArgs = [], env = null, status = {} } = {}) {
  status.hostExit = null;
  status.hostError = null;
  const injector = await startInjector(ctx.scope);
  const obsPath = join(dir, "host-obs.jsonl");
  const configPath = join(dir, "host-config.json");
  writeFileSync(configPath, JSON.stringify({ wsUrl: injector.url, stateDirectory: join(dir, "state"), diagnosticDirectory: join(dir, "diagnostics"),
    obsPath, wallOriginMs: ctx.wallOriginMs, startedWallMs: Date.now(), notification: ctx.notification, memEveryMs }));
  const launcher = spawn(ctx.nodePath, [...nodeArgs, LAUNCHER, configPath], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: env == null ? process.env : { ...process.env, ...env } });
  launcher.once("exit", (code, signal) => { status.hostExit = { code, signal }; });
  // 閉じた IPC への send（ERR_IPC_CHANNEL_CLOSED）などを uncaught にしない。
  launcher.on("error", (error) => { status.hostError ??= String(error?.message ?? error); });
  ctx.scope.children.push({ name: "host-launcher", pid: launcher.pid, alive: () => launcher.exitCode == null && launcher.signalCode == null, kill: () => launcher.kill("SIGKILL") });
  ctx.commands?.push(`${[...Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`), ctx.nodePath, ...nodeArgs, LAUNCHER, configPath].join(" ")}`);
  const waitExit = async (ms) => { for (let i = 0; i < ms / 100 && status.hostExit == null; i++) await sleep(100); };
  ctx.scope.add(async () => {
    if (status.hostExit != null) return;
    launcher.kill("SIGTERM");
    await waitExit(1500);
    if (status.hostExit == null) { launcher.kill("SIGKILL"); await waitExit(2000); }
  });
  let readyTimer;
  const ready = await new Promise((resolve, reject) => {
    launcher.once("message", resolve);
    launcher.once("exit", (code, signal) => reject(new Error(`host launcher exited before ready (code=${code}, signal=${signal})`)));
    readyTimer = setTimeout(() => reject(new Error("host launcher not ready within 60s")), 60_000);
  }).finally(() => clearTimeout(readyTimer));
  await Promise.race([injector.connected(), sleep(30_000).then(() => { throw new Error("host did not connect within 30s"); })]);
  // 止める順: host（{t:"stop"} → 10 秒で SIGKILL）→ 投入側。
  const stop = async () => {
    if (launcher.connected) launcher.send({ t: "stop" });
    await waitExit(10_000);
    if (status.hostExit == null) { launcher.kill("SIGKILL"); await waitExit(2000); }
    await injector.close();
  };
  return { injector, launcher, displayPort: ready.displayPort, obsPath, pid: launcher.pid, status, stop };
}

// ── host の JSONL を追いかける（reference の tick 位相予測と初期化の待ちに使う） ──
function tailer(path) {
  let offset = 0;
  let rest = "";
  const lines = [];
  return {
    lines,
    refresh() {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size <= offset) return;
      const fd = openSync(path, "r");
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      offset = size;
      const parts = (rest + buffer.toString("utf8")).split("\n");
      rest = parts.pop();
      for (const part of parts) if (part !== "") lines.push(JSON.parse(part));
    },
  };
}

async function spinUntil(targetHrMs) {
  for (;;) {
    const remaining = targetHrMs - hrMs();
    if (!(remaining > 0)) return; // NaN でも回り続けない
    if (remaining > 3) await sleep(remaining - 2);
  }
}

// 直近の checkpoint encode 開始から host の tick（1 秒周期）の位相を最小二乗で当てて、leadMs 先以降の最初の tick を返す。
function predictTick(host, hr, leadMs) {
  const starts = host.lines.flatMap((l) => l.t === "obs" && l.o.kind === "checkpoint" && l.o.measurement.stage === "encode" ? [l.o.measurement.startedMonotonicMs] : []).slice(-12);
  const first = host.lines.find((l) => l.t === "clock");
  if (starts.length === 0 || first == null) return null;
  const oh = first.perfNowMs - Number(BigInt(first.hrtimeNs)) / 1e6;
  const e0 = starts[starts.length - 1];
  const points = starts.map((s) => [Math.round((s - e0) / 1000), s]);
  const n = points.length;
  const sj = points.reduce((a, [j]) => a + j, 0);
  const ss = points.reduce((a, [, s]) => a + s, 0);
  const sjj = points.reduce((a, [j]) => a + j * j, 0);
  const sjs = points.reduce((a, [j, s]) => a + j * s, 0);
  const det = n * sjj - sj * sj;
  const b = n >= 3 && det !== 0 ? (n * sjs - sj * ss) / det : 1000;
  const a = (ss - b * sj) / n;
  const j = Math.ceil((hr + oh + leadMs - a) / b);
  return { hostMs: a + b * j, hrMs: a + b * j - oh, oh };
}

// 保存済みの U-F checkpoint（A/B の 2 slot のうち世代が新しい方）の payload.subjects の件数。読めなければ null。
function savedForecastSubjects(stateDirectory) {
  let best = null;
  for (const slot of ["A", "B"]) {
    try {
      const saved = JSON.parse(readFileSync(join(stateDirectory, `U-F-${slot}.json`), "utf8"));
      if (Array.isArray(saved.payload?.subjects) && (best == null || saved.generation > best.generation)) best = saved;
    } catch { /* 無い・壊れている slot は飛ばす */ }
  }
  return best == null ? null : best.payload.subjects.length;
}

// ── 1 run ──
const log = (message) => { if (process.env.A10_LOG) console.error(`[${new Date().toISOString().slice(11, 23)}] ${message}`); };

// 途中で落ちた run も、落ちた事実（理由・host の exit・何試行目か）を run の証拠置き場に残してから投げ直す。本番は無人なので stderr だけでは足りない。
// status は呼び出し側（窓）と共有し、60 秒ごとの beat と Blocked の lastProgress に使う。
async function executeRun(spec, ctx, dir, status = {}) {
  const label = `${spec.population}-run${spec.run}`;
  mkdirSync(dir, { recursive: true });
  Object.assign(status, { hostExit: null, hostError: null, trialsStarted: 0, total: spec.warmup + spec.count });
  try {
    return await measureRun(spec, ctx, label, dir, status);
  } catch (error) {
    writeFileSync(join(dir, "run-aborted.json"), `${JSON.stringify({ label, reason: String(error?.stack ?? error), ...status, abortedWallMs: Date.now() }, null, 2)}\n`);
    throw error;
  }
}

async function measureRun(spec, ctx, label, dir, status) {
  const { population, run } = spec;
  const started = { wallMs: Date.now(), hrMs: hrMs() };
  const hostProcess = await startHost(dir, ctx, { status });
  const { injector, obsPath } = hostProcess;
  const page = await openPage(`http://127.0.0.1:${hostProcess.displayPort}/`, ctx.scope);
  ctx.commands?.push(page.command);
  for (let i = 0; i < 200 && !(await page.evaluate("typeof window.fleqRespondClockProbe === 'function'")); i++) await sleep(50);
  const host = tailer(obsPath);
  const probes = [];
  const probe = async (name) => { probes.push(await probeClock(page.evaluate, `${label}-${name}`)); };
  const markCount = () => page.evaluate(`performance.getEntriesByName(${JSON.stringify(T6C)}).length`);
  log("page ready");
  await probe("start");
  log("probed");
  injector.sendStart();

  const clockOffset = () => { const c = host.lines.find((l) => l.t === "clock"); return c.perfNowMs - Number(BigInt(c.hrtimeNs)) / 1e6; };
  for (let i = 0; i < 50 && !host.lines.some((l) => l.t === "clock"); i++) { host.refresh(); await sleep(100); }
  const ohStart = clockOffset();
  const wallNow = () => ctx.wallOriginMs + Math.floor((hrMs() + ohStart) / 1000) * 1000;
  // 初期化入力（製品の WS 入力として流す）。処理と保存が済むまで待つ。
  const others = [];
  const dataSend = (frame, kind, extra = {}) => { const r = injector.send(frame); others.push({ kind, seq: r.seq, inputId: r.seq == null ? null : `input-${r.seq}`, injectedHrMs: r.injectedHrMs, ...extra }); return r; };
  for (const name of ctx.initial[population]) dataSend(weatherFrame(name, name.match(/_(V[A-Z]{3}\d{2})/)[1], wallNow()), "init", { fixture: name });
  const expectedUnits = new Set(ctx.initial[population].map((name) => (/VPWS50|VPWW/.test(name) ? "U-W" : "U-F")));
  const initDeadline = hrMs() + 20_000;
  for (;;) {
    host.refresh();
    const encoded = new Set(host.lines.flatMap((l) => l.t === "obs" && l.o.kind === "checkpoint" && l.o.measurement.stage === "encode" ? [l.o.measurement.unit] : []));
    if ([...expectedUnits].every((u) => encoded.has(u)) || hrMs() > initDeadline) break;
    await sleep(200);
  }
  log("init done");
  await sleep(1500);
  host.refresh();
  const ufSubjectsBefore = savedForecastSubjects(join(dir, "state"));
  const channels = await (await fetch(`http://127.0.0.1:${hostProcess.displayPort}/snapshot`)).json().then((s) => s.channels, () => null);

  // 通常負荷 N（決めた offset で繰り返す）
  const background = loadEvents(ctx.load);
  const loadMs = ctx.load.durationMs;
  let bgNext = 0;
  const loopStart = hrMs();
  const pumpBackground = () => {
    for (;;) {
      const cycle = Math.floor(bgNext / background.length);
      const event = background[bgNext % background.length];
      if (loopStart + cycle * loadMs + event.offsetMs > hrMs()) return;
      dataSend(weatherFrame(event.name, event.headType, wallNow()), "background", { headType: event.headType });
      bgNext += 1;
    }
  };
  const idleUntil = async (targetHrMs) => {
    while (targetHrMs - hrMs() > 4) { pumpBackground(); await sleep(Math.min(20, targetHrMs - hrMs() - 3)); }
    await spinUntil(targetHrMs);
  };

  // 試行
  const trials = [];
  const blocks = [];
  const total = spec.warmup + spec.count;
  let tracing = null;
  let blockStartedHr = null;
  const openBlock = async () => { tracing = await startTracing(page.page); blockStartedHr = hrMs(); };
  const closeBlock = async (index) => {
    const { text, dataLossOccurred } = await stopTracing(page.page, tracing);
    const file = join(dir, `trace-${String(index).padStart(2, "0")}.json`);
    writeFileSync(file, text);
    blocks.push({ file, bytes: text.length, dataLoss: dataLossOccurred, startedHrMs: blockStartedHr, endedHrMs: hrMs() });
    tracing = null;
  };
  log("loop start");
  await openBlock();
  log("tracing on");
  let lastProbeHr = hrMs();
  let anchor = loopStart; // 試行の予定の起点（due の付け替えで動く。N の再生は loopStart のまま）

  for (let k = 0; k < total; k++) {
    if (status.hostExit != null) throw new Error(`host launcher exited mid-run: ${JSON.stringify(status.hostExit)}`);
    if (injector.broken != null) throw new Error(injector.broken);
    status.trialsStarted = k;
    // 区切りの直前に 200ms 待ち、直前の試行の paint（PipelineReporter の終端）を前の trace に入れる。
    if (k > 0 && k % BLOCK === 0) { await sleep(200); await closeBlock(k / BLOCK - 1); await openBlock(); }
    if (hrMs() - lastProbeHr >= 29_000) { await probe(`t${k}`); lastProbeHr = hrMs(); }
    const phase = k < spec.warmup ? "warmup" : "formal";
    const idx = phase === "warmup" ? k : k - spec.warmup;
    // 予定の枠が、試行の準備ができた時点（前の完了・trace の区切り・時計 probe の後）で既に過ぎていたら、予定を「今 + 周期」へ付け替える。
    // 付け替えないと、timeout や trace の区切りの後に過去の予定が続き、数試行が詰めて投入される。予定どおりの間は周期を変えない。
    let due = anchor + k * spec.periodMs;
    const readyHr = hrMs();
    if (due < readyHr) { due = readyHr + spec.periodMs; anchor = due - k * spec.periodMs; }
    const eventId = eventIdOf(POP_CODE[population], phase, run);
    const serial = idx + 1;
    const variant = idx % 2 === 0 ? "A" : "B";
    // 投入の瞬間に frame の組み立てで遅れないよう、待つ前に作る（報告時刻は host 時計の今の秒）。
    const frame = dataFrame("VXSE43", Buffer.from(eewVariant({ eventId, serial, variant, reportAtMs: wallNow() })));
    const vpwsFrame = population === "maxVpws50DecodeStarted" ? weatherFrame("15_18_01_250630_VPWS50", "VPWS50", wallNow()) : null;
    await idleUntil(due);
    host.refresh();
    const before = await markCount();
    const base = { index: k, phase, eventId, serial, variant, subject: `normal/VXSE43/${eventId}`, scheduledHrMs: due, block: Math.floor(k / BLOCK) };
    let trigger = null;
    let sent;
    if (population === "fixedBacklog") {
      sent = injector.send(frame);
    } else if (population === "maxVpws50DecodeStarted") {
      const t = dataSend(vpwsFrame, "trigger", { trial: k });
      trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs };
      await spinUntil(t.injectedHrMs + spec.targetOffsetMs);
      sent = injector.send(frame);
    } else {
      // 次の tick の checkpoint encode 開始を予測し、その 1ms 後に EEW を投入する。tick の 1.5 秒以上先を狙って引き金を先に打つ。
      const tick = predictTick(host, hrMs(), 1500);
      if (tick == null) { sent = injector.send(frame); base.noTickModel = true; }
      else {
        const lead = population === "forecastDeadlineOverlap" ? 1400 : 600;
        await spinUntil(tick.hrMs - lead);
        let frameText;
        if (population === "maxWeatherCheckpointEncodeStarted") frameText = weatherFrame("15_17_01_251222_VPWW55", "VPWW55", wallNow() + (k + 1) * 1000);
        else if (population === "maxForecastCheckpointSave") frameText = weatherFrame("81_09_01_260605_VPWP50", "VPWP50", wallNow() + (k + 1) * 1000);
        else {
          const text = fixtureText("81_01_04_251222_VPWP50").toString("utf8");
          const report = Date.parse(/<ReportDateTime>([^<]+)</.exec(text)[1]);
          // validUntil を、狙う tick の壁時計以下で (前の tick, 狙う tick] にただ 1 つある秒境界に置く（その tick の deadline で期限回収される）。
          const target = Math.floor((ctx.wallOriginMs + tick.hostMs - 5) / 1000) * 1000;
          frameText = dataFrame("VPWP50", Buffer.from(shiftTimestamps(text, target - (report + UF_SMALL_VALID_AFTER_REPORT_MS))));
        }
        const t = dataSend(frameText, "trigger", { trial: k });
        trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs, predictedTickHostMs: tick.hostMs };
        await spinUntil(tick.hrMs + spec.targetOffsetMs);
        sent = injector.send(frame);
      }
    }
    log(`sent ${k}`);
    const trial = { ...base, inputId: sent.seq == null ? `notInjected-${k}` : `input-${sent.seq}`, injectedHrMs: sent.injectedHrMs, trigger };
    trials.push(trial);
    // 後続置換の防止: T6 候補 mark が現れるか、実投入から 10 秒が経つまで次を投入しない。
    if (sent.injectedHrMs != null) {
      const deadline = sent.injectedHrMs + 10_000;
      await sleep(120);
      let done = false;
      while (!done && hrMs() < deadline) { pumpBackground(); done = (await markCount()) > before; if (!done) await sleep(40); }
      trial.completedBy = done ? "mark" : "timeout";
      // timeout の後に遅れて来る mark を次の試行の完了と取り違えないよう、新しい mark が 1 秒来ないのを確かめてから進む。
      if (!done) {
        let last = await markCount();
        let quietSince = hrMs();
        while (hrMs() - quietSince < 1000) {
          pumpBackground();
          await sleep(40);
          const count = await markCount();
          if (count !== last) { last = count; quietSince = hrMs(); }
        }
      }
    }
  }
  await sleep(1500);
  await probe("end");
  await closeBlock(Math.floor((total - 1) / BLOCK));
  const finishedHr = hrMs();

  // 終了: host → 投入側 → Chrome の順で止める。後始末が失敗しても、記録して trace の解析と run-record の書き出しへ進む。
  const teardownErrors = [];
  for (const [name, fn] of [["host", hostProcess.stop], ["chrome", page.close]]) {
    try { await fn(); } catch (error) { teardownErrors.push(`${name}: ${String(error?.message ?? error)}`); }
  }
  host.refresh();

  const hostIndex = buildHostIndex(host.lines);
  const chromeByVersion = new Map();
  for (const block of blocks) {
    const analyzed = analyzeTrace(JSON.parse(readFileSync(block.file, "utf8")).traceEvents);
    for (const [key, entry] of analyzed.byVersion) chromeByVersion.set(key, entry);
    block.marks = analyzed.markCount;
    block.rejectedMarks = analyzed.rejectedMarks;
  }
  const assembled = assembleTrials({ population, run, trials, host: hostIndex, chromeByVersion, probes, blocks, callbackDeadlineMs: 10_000, missingAfterMs: 10_000 });
  const references = population === "fixedBacklog" ? [] : trials.map((trial, i) => referenceRecord({ trial, host: hostIndex, injection: assembled.injections[i],
    target: referenceTarget(population, trial, hostIndex) }));
  // U-F の許容範囲（AC01）: 試行ごとに、T0 以前の最新の U-F encode の byte と、保存済み U-F checkpoint から数えた件数（run 開始時と終了後の多い方）を
  // WP2 の forecastWithinAllowance で見る。件数か byte のどちらかが範囲外、または未観測の試行は別条件として残す。
  const measuredSubjects = [ufSubjectsBefore, savedForecastSubjects(join(dir, "state"))].reduce((m, v) => (v == null ? m : Math.max(m ?? 0, v)), null);
  const ufAllowance = population !== "fixedBacklog" ? null : trials.map((trial) => {
    const t0 = hostIndex.t0.get(trial.inputId);
    const encode = t0 == null ? null : hostIndex.checkpoints.filter((c) => c.unit === "U-F" && c.stage === "encode" && c.startedMonotonicMs <= t0).at(-1) ?? null;
    return { index: trial.index, subjects: measuredSubjects, encodedBytes: encode?.bytes ?? null,
      condition: encode == null || measuredSubjects == null ? "unobserved" : forecastWithinAllowance(ctx.manifest, { subjects: measuredSubjects, encodedBytes: encode.bytes }) ? "withinAllowance" : "outOfAllowance" };
  });
  const record = { label, population, run, spec, notification: ctx.notification, notificationNote: ctx.notification === "silent" ? SILENT_NOTE : null, ufAllowance, channels, nodeVersion: hostIndex.meta?.nodeVersion ?? null, hostExit: status.hostExit,
    hostError: status.hostError, teardownErrors, startedWallMs: started.wallMs, durationMs: finishedHr - started.hrMs, others, trials,
    blocks: blocks.map(({ startedHrMs, endedHrMs, ...b }) => ({ ...b, durationMs: endedHrMs - startedHrMs })), probes: probes.map((p) => ({ probeId: p.probeId, atHrMs: p.atHrMs, attempts: p.attempts })),
    correspondences: assembled.correspondences, details: assembled.details, references,
    hostClockOffsetSpreadMs: hostIndex.ohHi - hostIndex.ohLo, hostMemMax: hostIndex.mem.reduce((m, l) => Math.max(m, l.rss ?? 0), 0),
    publishSerialization: hostIndex.publishes.length,
    checkpoints: hostIndex.checkpoints.map((c) => ({ unit: c.unit, stage: c.stage, attemptId: c.attemptId, startMs: c.startedMonotonicMs, endMs: c.endedMonotonicMs, bytes: c.bytes, outcome: c.outcome })) };
  writeFileSync(join(dir, "run-record.json"), JSON.stringify(record));
  return { spec, label, dir, record, samples: assembled.samples, injections: assembled.injections, host: hostIndex, references };
}

// 参考の対象区間（host の時計）。maxVpws50DecodeStarted は VPWS50 の decode 区間、他は引き金の後の最初の checkpoint encode 開始から（保存は最後の段の終わりまで）。
function referenceTarget(population, trial, host) {
  if (trial.trigger?.inputId == null) return null;
  if (population === "maxVpws50DecodeStarted") {
    const d = host.decode.get(trial.trigger.inputId);
    return d == null ? null : { startMs: d.startMs, endMs: d.endMs };
  }
  const unit = population === "maxWeatherCheckpointEncodeStarted" ? "U-W" : "U-F";
  const triggerHost = trial.trigger.injectedHrMs + host.ohLo;
  // 予測した tick に最も近い encode（無ければ引き金の後の最初の encode）。
  const encodes = host.checkpoints.filter((c) => c.unit === unit && c.stage === "encode" && c.startedMonotonicMs >= triggerHost).sort((a, b) => a.startedMonotonicMs - b.startedMonotonicMs);
  const predicted = trial.trigger.predictedTickHostMs;
  const encode = predicted == null ? encodes[0] : encodes.reduce((best, c) => (best == null || Math.abs(c.startedMonotonicMs - predicted) < Math.abs(best.startedMonotonicMs - predicted) ? c : best), null);
  if (encode == null) return null;
  const stages = host.checkpoints.filter((c) => c.runId === encode.runId && c.attemptId === encode.attemptId).map((c) => ({ stage: c.stage, startMs: c.startedMonotonicMs, endMs: c.endedMonotonicMs }));
  const endMs = population === "maxForecastCheckpointSave" ? Math.max(...stages.map((s) => s.endMs)) : encode.endedMonotonicMs;
  return { startMs: encode.startedMonotonicMs, endMs, stages };
}

// ── 集計 ──
// 正式 run の U-F が許容範囲の外・未観測の試行を含むか（その run の Pass は主張しない）。
const ufNotWithin = (record) => record.ufAllowance != null && record.ufAllowance.some((t) => t.condition !== "withinAllowance");
const withoutScreenshot = (record, warmup) => record.details.filter((d) => d.index >= warmup && d.sample === "linked" && !d.hasScreenshot).length;
const refStats = (list) => ({ n: list.length, insideTargetRate: round(list.filter((x) => x.injectionInsideTarget === "yes").length / Math.max(1, list.length)),
  judgements: Object.fromEntries([...new Set(list.map((x) => x.judgement))].map((j) => [j, list.filter((x) => x.judgement === j).length])),
  t0MinusStartMs: dist(list.map((x) => x.t0MinusStartMs).filter((v) => v != null)) });
const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const dist = (values) => { const q = values.length === 0 ? null : quantiles(values); return q == null ? null : { n: values.length, p50: round(q.p50), p99: round(q.p99), max: round(q.max) }; };

// 予備測定の正式対象: 判定（summarizeEewE01）は 1000×3 を前提にするので使わず、分布だけを WP2 の quantiles で出す。status は必ず「未確認」。
function preliminaryFormal(result) {
  const { spec, samples, injections } = result;
  const formal = samples.filter((s) => s.sampleIndex >= spec.warmup);
  const linked = formal.filter((s) => s.latencyLowerMs != null && s.latencyUpperMs != null);
  const widths = result.record.correspondences.map((c) => c.intervalWidthMs);
  return {
    population: "fixedBacklog", run: spec.run, status: "未確認", statusReason: "予備測定（件数が正式の 1000×3 に満たない）。合否に使わない",
    warmupSamples: spec.warmup, samples: formal.length, missing: formal.filter((s) => s.missing).length,
    traceMissingByReason: Object.fromEntries([...new Set(formal.map((s) => s.missingReason ?? "none"))].map((r) => [r, formal.filter((s) => (s.missingReason ?? "none") === r).length])),
    injectionFailures: injections.filter((i) => i.sampleIndex >= spec.warmup && i.outcome !== "callbackReached").length,
    t6Rate: round(linked.length / Math.max(1, formal.length)),
    latencyLowerMs: dist(linked.map((s) => s.latencyLowerMs)), latencyUpperMs: dist(linked.map((s) => s.latencyUpperMs)),
    paintWithoutScreenshot: withoutScreenshot(result.record, spec.warmup),
    ufAllowance: { withinAllowance: result.record.ufAllowance.filter((t) => t.condition === "withinAllowance").length, notWithin: result.record.ufAllowance.filter((t) => t.condition !== "withinAllowance").length },
    clockIntervalWidthMs: dist(widths), clockProbeCount: widths.length,
    injectedToT0Ms: dist(injections.filter((i) => i.sampleIndex >= spec.warmup && i.injectedInjectorMonotonicMs != null && result.host.t0.has(i.inputId))
      .map((i) => result.host.t0.get(i.inputId) - i.injectedInjectorMonotonicMs - result.host.ohLo)),
  };
}

// ── 保存 ──
function writeSealed(path, object, field) {
  writeFileSync(path, sealSelfHash(`${JSON.stringify(object, null, 2)}\n`, field));
}
const pathRef = (path) => (relative(REPO, path).startsWith("..") ? path : relative(REPO, path));
const UF_NOTE = "ufNotWithinAllowance(別条件。試行単位は run-record の ufAllowance)";

// E01 の判定（WP2 の summarizeEewE01 に渡した run を一度に判定する）。U-F が許容範囲を外れた正式 run は Pass を主張しない（AC01）。
// assembled は e01-assembled.json の中身（rawDir・recordRef 付き）。無い run（Blocked・未実施）は summarizeEewE01 が標本不足として扱う。
function judgeE01(manifest, assembled) {
  const samples = assembled.flatMap((a) => a.samples);
  const judged = summarizeEewE01(manifest, samples, assembled.flatMap((a) => a.injections));
  const runs = judged.runs.map((run) => {
    const a = assembled.find((x) => x.spec.population === run.population && x.spec.run === run.run);
    const out = run.scope === "formal" && a?.ufNotWithin === true;
    return { ...run, status: out && run.status === "Pass" ? "未確認" : run.status,
      evidenceRefs: a == null ? [] : [a.recordRef, `${a.rawDir}/run-record.json`, `${a.rawDir}/e01-assembled.json`, ...(out ? [UF_NOTE] : [])] };
  });
  const formal = runs.filter((r) => r.scope === "formal").map((r) => r.status);
  return { runs, verdict: { ...judged.verdict, status: formal.includes("Fail") ? "Fail" : formal.every((st) => st === "Pass") ? "Pass" : "未確認" },
    cause: classifyEewCause(samples, assembled.flatMap((a) => a.processing), assembled.flatMap((a) => a.checkpoints)) };
}

// E01 の窓（1 run = 1 窓）。組み立て済みの samples・injections と原因帰属の入力を生データ dir に残す（窓単位の再実行後に判定を作り直すため）。
// 結果は窓 dir に書き、evidence へ写すのは runWindow（窓が成功したときだけ）。run の status は他の run に左右されないので、この run だけで判定する。
function e01Window(spec, ctx) {
  return {
    id: `e01-${spec.population}-run${spec.run}`,
    // 見込み = 試行数 × 周期 ＋ 起動・trace 解析 2 分（期限はこの 2 倍）
    expectedMin: Math.ceil(((spec.warmup + spec.count) * spec.periodMs) / 60_000) + 2,
    run: async (w) => {
      const result = await executeRun(spec, { ...ctx, scope: w.scope, commands: w.commands }, w.dir, w.progress);
      const assembled = { spec, rawDir: pathRef(w.dir), recordRef: w.recordRef, samples: result.samples, injections: result.injections, processing: result.host.processing,
        checkpoints: result.host.checkpoints, ufNotWithin: ufNotWithin(result.record), durationMs: result.record.durationMs, paintWithoutScreenshot: withoutScreenshot(result.record, spec.warmup) };
      writeFileSync(join(w.dir, "e01-assembled.json"), JSON.stringify(assembled));
      const run = judgeE01(ctx.manifest, [assembled]).runs.find((r) => r.population === spec.population && r.run === spec.run);
      const file = join(w.dir, `result-${run.scope}-${run.population}-run${run.run}.json`);
      writeSealed(file, run, "resultSha256");
      return { status: run.status, resultFiles: [file] };
    },
  };
}

// E01 の判定を、各 E01 窓の最新 attempt（Blocked 以外）から全 run 一度に作り直す。e01-assembled.json が読めない・窓記録の raw.sha256 と違う run は
// 標本に使わず「未確認」とする（正式 run が 1 本でも欠ければ verdict は Pass にならない）。合算は落とさずに書く。
function e01Verdict(manifest, records) {
  const windows = latestById(records).filter((w) => w.id.startsWith("e01-"));
  const assembled = [];
  const unusable = new Map();
  for (const w of windows.filter((x) => x.status !== "Blocked")) {
    try {
      const bytes = readFileSync(join(w.rawDir, "e01-assembled.json"));
      const expected = w.raw?.find((r) => r.file === "e01-assembled.json")?.sha256;
      if (sha256Hex(bytes) !== expected) throw new Error("e01-assembled.json sha256 differs from the window record");
      assembled.push(JSON.parse(bytes.toString("utf8")));
    } catch (error) { unusable.set(w.id, String(error?.message ?? error)); }
  }
  const { verdict, cause } = judgeE01(manifest, assembled);
  const runs = windows.map((w) => {
    const a = assembled.find((x) => `e01-${x.spec.population}-run${x.spec.run}` === w.id);
    return { id: w.id, attempt: w.attempt, status: unusable.has(w.id) ? "未確認" : w.status, ...(unusable.has(w.id) ? { reason: unusable.get(w.id) } : {}),
      durationMs: a?.durationMs ?? null, paintWithoutScreenshot: a?.paintWithoutScreenshot ?? null };
  });
  return { verdict, cause, runs };
}

// ── 窓ループ（WP3c §2） ──
const windowName = (id, attempt) => (attempt === 1 ? id : `${id}-attempt${attempt}`);
// 窓記録は manifest ごとの dir に置き、manifestSha256 が一致するものだけを読む（別 manifest の記録を合算・再実行判定に混ぜない）。
const readWindowRecords = (dir, manifestSha256) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).filter((r) => r.manifestSha256 === manifestSha256) : []);
const latestById = (records) => [...records.reduce((m, r) => (m.has(r.id) && m.get(r.id).attempt > r.attempt ? m : m.set(r.id, r)), new Map()).values()];
// repo 外の生データ（run-record・trace・JSONL など窓 dir 直下のファイル）を hash で固定する。
const hashRaw = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
  const bytes = readFileSync(join(dir, e.name));
  return { file: e.name, bytes: bytes.length, sha256: sha256Hex(bytes) };
});
let interruptWindow = null; // SIGINT/SIGTERM のとき、今の窓の記録を "interrupted" に書き換える

// 1 窓を回す。例外・子の異常終了・期限（見込み × 2）超過のどれでも、その窓を Blocked と記録して後始末を済ませ、呼び出し側は次の窓へ進む。
// 開始時にも Blocked の記録を書く（runner ごと落ちたときも、その窓を --windows で再実行できる）。
async function runWindow(win, { manifest, outDir, resultsDir, recordsDir, commands, preflight }) {
  let attempt = readWindowRecords(recordsDir, manifest.manifestSha256).filter((r) => r.id === win.id).reduce((m, r) => Math.max(m, r.attempt), 0) + 1;
  while (existsSync(join(outDir, windowName(win.id, attempt))) || existsSync(join(recordsDir, `${windowName(win.id, attempt)}.json`))) attempt += 1;
  const name = windowName(win.id, attempt);
  const suffix = attempt === 1 ? "" : `-attempt${attempt}`;
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const recordPath = join(recordsDir, `${name}.json`);
  const startedAt = new Date().toISOString();
  const w = { dir, recordRef: pathRef(recordPath), scope: cleanupScope(), progress: {}, commands: [...commands] };
  const base = { id: win.id, attempt, manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, rawDir: dir, command: commands[0], commands: w.commands, startedAt, preflight };
  const writeRecord = (record) => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  writeRecord({ ...base, status: "Blocked", reason: "started; the runner ended before this window finished" });
  const progress = (event, extra) => appendFileSync(join(outDir, "progress.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), window: name, event, ...extra })}\n`);
  progress("start", { expectedMin: win.expectedMin });
  current = w.scope;
  interruptWindow = () => writeRecord({ ...base, status: "Blocked", reason: "interrupted", finishedAt: new Date().toISOString(), lastProgress: { ...w.progress }, raw: hashRaw(dir) });
  const beat = setInterval(() => progress("beat", { done: w.progress.trialsStarted ?? null, total: w.progress.total ?? null }), 60_000);
  const work = Promise.resolve().then(() => win.run(w));
  let deadline;
  let outcome;
  try {
    outcome = await Promise.race([work, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`window deadline exceeded (${win.expectedMin * 2} min = expected x 2)`)), win.expectedMin * 2 * 60_000);
    })]);
  } catch (error) {
    outcome = { status: "Blocked", reason: String(error?.message ?? error), error: String(error?.stack ?? error), childExit: w.progress.hostExit ?? null, lastProgress: { ...w.progress }, resultFiles: [] };
  } finally {
    clearTimeout(deadline);
    clearInterval(beat);
    await w.scope.close();
    // 期限切れで置き去りにした処理が、止めた子の終了で抜けるのを待つ（次の窓と重ねない）。
    await Promise.race([work.catch(() => {}), sleep(60_000)]);
    interruptWindow = null;
    current = root;
  }
  const orphans = w.scope.children.filter((c) => c.alive()).map((c) => { try { c.kill(); } catch { /* 既に終了 */ } return { name: c.name, pid: c.pid }; });
  if (orphans.length > 0) progress("orphan", { children: orphans });
  try {
    // 窓が成功したときだけ、窓 dir の結果を evidence へ写す（Blocked になった窓の置き去り処理は evidence を触れない）。
    // 写しと記録は await を挟まない同期の塊にする（SIGINT で evidence と記録が食い違う隙を作らない）。
    const resultFiles = outcome.resultFiles.map((from) => {
      const to = join(resultsDir, basename(from).replace(/\.json$/, `${suffix}.json`));
      copyFileSync(from, to);
      return { path: pathRef(to), sha256: sha256Hex(readFileSync(to)) };
    });
    writeRecord({ ...base, ...outcome, resultFiles, finishedAt: new Date().toISOString(), raw: hashRaw(dir), orphans });
  } catch (error) {
    outcome = { status: "Blocked", reason: `window record could not be written: ${String(error?.message ?? error)}` };
    writeRecord({ ...base, ...outcome, finishedAt: new Date().toISOString(), orphans });
  }
  progress("end", { status: outcome.status, min: round((Date.now() - Date.parse(startedAt)) / 60_000), ...(outcome.reason == null ? {} : { reason: outcome.reason }) });
  return outcome.status;
}

// 合算（WP3c §1.5）: 窓の記録（全 attempt）と E01 の判定から a10-result.json の保存 text を作る純関数。evidence から毎回作り直す。
// 窓の status は記録のまま写す（Blocked を Pass・Fail に変えない、AC10）。封印は WP2 の sealSelfHash（resultSha256 だけを 0 置換した bytes の sha256）。
export function buildA10Result({ manifest, windows, e01 }) {
  const sorted = [...windows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.attempt - b.attempt));
  const latest = new Map(sorted.map((w) => [w.id, w.attempt]));
  const preflights = [...new Set(sorted.map((w) => JSON.stringify(w.preflight ?? null)))];
  const entries = sorted.map(({ preflight, ...w }) => ({ ...w, latest: latest.get(w.id) === w.attempt, preflight: preflights.indexOf(JSON.stringify(preflight ?? null)) }));
  const body = { schemaVersion: "p2-a10-result-v1", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
    e01, preflights: preflights.map((p) => JSON.parse(p)), windows: entries };
  return sealSelfHash(`${JSON.stringify(body, null, 2)}\n`, "resultSha256");
}

// 起動時の確認（WP3c §1.1）: host の Node・Chrome・OS の版を manifest と照合し、生成物の存在を確かめ、repo の状態を記録する。
// 1 つでも外れたら全窓を走らせずに止める（どの窓も同じ理由で落ちるため）。
async function preflightCheck(manifest, nodePath, nodeVersion) {
  const chrome = await chromeVersion();
  const os = `${release()} ${arch()}`;
  const problems = [
    nodeVersion === manifest.nodeVersion ? null : `${nodePath} is ${nodeVersion}, manifest.nodeVersion is ${manifest.nodeVersion}`,
    chrome === manifest.chrome.version ? null : `Chrome is ${chrome}, manifest.chrome.version is ${manifest.chrome.version}`,
    os === manifest.osVersion ? null : `OS is ${os}, manifest.osVersion is ${manifest.osVersion}`,
    ...DIST_REQUIRED.map((p) => (existsSync(join(REPO, p)) ? null : `missing build output: ${p}`)),
  ].filter((p) => p != null);
  if (problems.length > 0) throw new Error(`preflight failed:\n  ${problems.join("\n  ")}`);
  const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
  return { checkedAt: new Date().toISOString(), nodeVersion, chromeVersion: chrome, osVersion: os, dist: DIST_REQUIRED,
    gitHead: git("rev-parse", "HEAD").trim(), gitStatusPorcelain: git("status", "--porcelain") };
}

// 凍結した入力の照合（AC01）: 初期入力・引き金の fixture・壁時計起点は trialSetup と manifest から取り、run の前に hash を確かめる。違えば走らせない。
const TRIGGER_AND_EEW_FIXTURES = ["37_01_01_240613_VXSE43", "15_18_01_250630_VPWS50", "15_17_01_251222_VPWW55", "81_09_01_260605_VPWP50", "81_01_04_251222_VPWP50"];
function frozenInputs(manifest, trialSetup, initialStateText) {
  if (sha256Hex(initialStateText) !== trialSetup.initialStateSha256) throw new Error("initial-state hash does not match trialSetup.initialStateSha256");
  const populations = JSON.parse(initialStateText).populations;
  const names = new Set(TRIGGER_AND_EEW_FIXTURES);
  const initial = {};
  for (const [population, list] of Object.entries(populations)) {
    initial[population] = list.map((entry) => entry.fixture.replace("test__fixtures__", ""));
    for (const entry of list) if (manifest.fixtureSha256[entry.fixture] !== entry.sha256) throw new Error(`initial-state fixture hash is not in manifest: ${entry.fixture}`);
    initial[population].forEach((n) => names.add(n));
  }
  for (const name of names) {
    if (manifest.fixtureSha256[fixtureId(name)] !== sha256Hex(fixtureText(name))) throw new Error(`fixture bytes differ from manifest.fixtureSha256: ${name}`);
  }
  return { wallOriginMs: trialSetup.clock.wallTimeOriginMs, initial };
}

async function main(argv) {
  // 今の窓の記録を "interrupted"（raw の hash 付き）に書き換えてから後始末する。
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    try { interruptWindow?.(); } catch { /* 記録の失敗で後始末を止めない */ }
    void current.close().then(root.close).finally(() => process.exit(130));
  });
  const args = new Map();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]);
  const num = (key, fallback) => (args.has(key) ? Number(args.get(key)) : fallback);
  const preliminary = args.has("preliminary");
  if (preliminary === args.has("manifest")) throw new Error("exactly one of --manifest <path> or --preliminary is required");
  const selected = args.has("windows") ? String(args.get("windows")).split(",") : null;
  if (preliminary && selected != null) throw new Error("--windows is allowed only with --manifest");
  if (selected != null && new Set(selected).size !== selected.length) throw new Error(`--windows has a duplicate id: ${selected.join(",")}`);
  // host は Node 22 でだけ測る（黙って別版へ切り替えない）。版は run の前に実物へ訊く。
  if (!existsSync(NODE22)) throw new Error(`Node 22 not found at ${NODE22}; refusing to measure with another version`);
  const nodePath = NODE22;
  const nodeVersion = await new Promise((resolve, reject) => {
    const c = spawn(nodePath, ["-p", "process.version"]);
    let o = "";
    c.stdout.on("data", (d) => { o += d; });
    c.on("error", reject);
    c.on("close", () => resolve(o.trim()));
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  let manifest;
  let trialSetup;
  let initialStateText;
  let notification = args.get("notification") ?? (preliminary ? "silent" : "real");
  if (!preliminary && notification !== "real") throw new Error("--notification silent is allowed only with --preliminary (formal runs use the real backend)");
  if (notification !== "real" && notification !== "silent") throw new Error("--notification must be real or silent");
  let draft = null;
  const plan = {
    formalWarmup: num("formal-warmup", 20), formalSamples: num("formal-samples", 100), refWarmup: num("ref-warmup", 5), refSamples: num("ref-samples", 20),
    period: num("period", 1370), refPeriod: num("ref-period", 3000),
  };
  const only = args.has("only") ? String(args.get("only")).split(",") : null;
  if (preliminary) {
    draft = buildDraft({ chromeVersion: await chromeVersion(), nodeVersion,
      osVersion: `${release()} ${arch()}`, device: `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)}GiB`, periodMs: plan.period, refPeriodMs: plan.refPeriod, id: `prelim-${stamp}` });
    manifest = draft.manifest;
    trialSetup = JSON.parse(draft.trialSetupText);
    initialStateText = draft.initialStateText;
  } else {
    const path = String(args.get("manifest"));
    const manifestText = readFileSync(path, "utf8");
    const m0 = JSON.parse(manifestText);
    const verified = verifyFrozenManifest({ manifestText, trialSetupText: readFileSync(join(REPO, m0.trialSetupRef), "utf8"),
      smokeConditionsText: readFileSync(join(REPO, SMOKE_FILE), "utf8"), contractTexts: contractTextsFor() });
    manifest = verified.manifest;
    trialSetup = verified.trialSetup;
    initialStateText = readFileSync(join(REPO, trialSetup.initialStateRef), "utf8");
  }
  const preflight = preliminary ? null : await preflightCheck(manifest, nodePath, nodeVersion);
  // 起動時の確認の後に起動する（確認で止まるときに子を残さない）。
  const caffeinate = spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});
  root.add(() => caffeinate.kill());
  const frozen = frozenInputs(manifest, trialSetup, initialStateText);
  const periodOf = (trigger) => Number(/periodMs=(\d+)/.exec(trigger)?.[1]);
  const specs = preliminary
    ? [{ population: "fixedBacklog", run: 1, warmup: plan.formalWarmup, count: plan.formalSamples, periodMs: plan.period, targetOffsetMs: 0 },
      ...Object.keys(manifest.reference).map((population) => ({ population, run: 1, warmup: plan.refWarmup, count: plan.refSamples, periodMs: plan.refPeriod, targetOffsetMs: manifest.reference[population].targetOffsetMs }))]
    : [1, 2, 3].map((run) => ({ population: "fixedBacklog", run, warmup: manifest.warmupPerRun, count: manifest.samplesPerRun, periodMs: periodOf(manifest.formal.trigger), targetOffsetMs: 0 }))
      .concat(Object.entries(manifest.reference).flatMap(([population, r]) => Array.from({ length: r.runCount }, (_, i) => ({ population, run: i + 1, warmup: r.warmupPerRun,
        count: r.samplesPerRun, periodMs: periodOf(r.trigger), targetOffsetMs: r.targetOffsetMs }))));
  // 周期・offset が数でないと待ちが busy loop になる。1 本でも外れていたら走らせない。
  for (const s of specs) {
    if (!(Number.isFinite(s.periodMs) && s.periodMs > 0)) throw new Error(`${s.population} run${s.run}: periodMs must be finite and > 0 (got ${s.periodMs})`);
    if (!(Number.isFinite(s.targetOffsetMs) && s.targetOffsetMs >= 0)) throw new Error(`${s.population} run${s.run}: targetOffsetMs must be finite and >= 0 (got ${s.targetOffsetMs})`);
  }
  const outDir = join(RUNS_ROOT, manifest.manifestId);
  mkdirSync(outDir, { recursive: true });
  // 件数を絞ったスモーク（--only / 件数指定）は repo の evidence に書かない。
  const smoke = only != null || ["formal-warmup", "formal-samples", "ref-warmup", "ref-samples", "period", "ref-period"].some((k) => args.has(k));
  const evidence = smoke ? join(outDir, "evidence-scratch") : preliminary ? join(EVIDENCE_DIR, "preliminary") : EVIDENCE_DIR;
  mkdirSync(evidence, { recursive: true });
  const commands = [`node ${["reconstruction/test/eew-e01/run.mjs", ...argv].join(" ")}`, `caffeinate -dims -w ${process.pid}`];
  const startedAt = new Date().toISOString();
  if (draft != null) {
    writeFileSync(join(evidence, "manifest.draft.json"), draft.manifestText);
    writeFileSync(join(evidence, "trial-setup.draft.json"), draft.trialSetupText);
    writeFileSync(join(evidence, "initial-state.draft.json"), draft.initialStateText);
  }

  const ctxFor = (spec) => ({ outDir, nodePath, notification, manifest, wallOriginMs: frozen.wallOriginMs, initial: frozen.initial,
    load: manifest.loads[spec.population === "fixedBacklog" ? manifest.formal.load : manifest.reference[spec.population].load] });
  const planned = specs.filter((s) => only == null || only.includes(s.population));
  if (!preliminary) {
    // 本番: 窓を順に回す 1 本のループ。窓の並びは配列 1 つ（U3 が周辺の窓をここへ足す）。
    const windows = planned.map((spec) => e01Window(spec, ctxFor(spec)));
    const chosen = selected == null ? windows : selected.map((id) => windows.find((w) => w.id === id) ?? (() => { throw new Error(`unknown window: ${id}`); })());
    // 窓の記録と結果は manifest ごとに分ける（results/ は記録と混ざらないよう下の dir）。
    const recordsDir = join(evidence, "windows", manifest.manifestId);
    const resultsDir = join(recordsDir, "results");
    mkdirSync(resultsDir, { recursive: true });
    // 同じ manifestId で中身の違う manifest（再凍結）の記録があれば走らせない。再凍結には新しい manifestId を要る。
    const foreign = readdirSync(recordsDir).filter((f) => f.endsWith(".json") && JSON.parse(readFileSync(join(recordsDir, f), "utf8")).manifestSha256 !== manifest.manifestSha256);
    if (foreign.length > 0) throw new Error(`${recordsDir} has records of another manifest with the same manifestId (${foreign.join(", ")}); re-freezing needs a new manifestId`);
    // 再実行してよいのは前回 Blocked（または未実施）の窓だけ。Fail・未確認・Pass を選び直して良い run に差し替えることを構造で防ぐ。
    const previous = latestById(readWindowRecords(recordsDir, manifest.manifestSha256));
    for (const w of chosen) {
      const last = previous.find((r) => r.id === w.id);
      if (last != null && last.status !== "Blocked") throw new Error(`window ${w.id} is ${last.status} (attempt ${last.attempt}); only Blocked windows may be re-run`);
    }
    for (const w of chosen) {
      console.log(`[window] ${w.id} (expected ${w.expectedMin} min)`);
      console.log(`[window] ${w.id}: ${await runWindow(w, { manifest, outDir, resultsDir, recordsDir, commands, preflight })}`);
    }
    // 合算は evidence にある全窓の記録から作り直す（窓単位の再実行の後も同じ手順）。
    const records = readWindowRecords(recordsDir, manifest.manifestSha256);
    // E01 の合算が作れなくても、窓の記録の合算（a10-result.json）は必ず書く。
    let e01;
    try { e01 = e01Verdict(manifest, records); } catch (error) { e01 = { verdict: { label: "P2限定E01", status: "未確認" }, error: String(error?.stack ?? error) }; }
    writeFileSync(join(resultsDir, "e01-verdict.json"), `${JSON.stringify({ ...e01, finishedAt: new Date().toISOString(), commands, notification }, null, 2)}\n`);
    writeFileSync(join(resultsDir, "a10-result.json"), buildA10Result({ manifest, windows: records, e01 }));
    return;
  }

  const results = [];
  for (const spec of planned) {
    console.log(`[run] ${spec.population} run${spec.run}: warmup ${spec.warmup} + ${spec.count}, period ${spec.periodMs}ms`);
    const scope = cleanupScope();
    current = scope;
    let result;
    try {
      result = await executeRun(spec, { ...ctxFor(spec), scope }, join(outDir, `${spec.population}-run${spec.run}`));
    } finally {
      await scope.close();
      current = root;
    }
    results.push(result);
    console.log(`[run] ${result.label} done in ${Math.round(result.record.durationMs / 1000)}s`);
  }

  let probeNote = null;
  // draft の notificationProbe は直書きでなく、実 run で得た probe の結果を入れて再封印する（予備測定のみ）。
  if (results.length > 0) {
    const channels = results[0].record.channels;
    const probe = (v) => (v === "available" ? "idle" : "unavailable");
    if (notification === "silent") probeNote = SILENT_NOTE;
    const text = sealSelfHash(`${JSON.stringify({ ...manifest, manifestSha256: "0".repeat(64), notificationProbe: { desktop: probe(channels?.desktop), sound: probe(channels?.sound) } }, null, 2)}\n`, "manifestSha256");
    manifest = JSON.parse(text);
    writeFileSync(join(evidence, "manifest.draft.json"), text);
  }

  // 予備測定の集計
  const samples = results.flatMap((r) => r.samples);
  const injections = results.flatMap((r) => r.injections);
  const cause = classifyEewCause(samples, results.flatMap((r) => r.host.processing), results.flatMap((r) => r.host.checkpoints));
  const dirRel = relative(REPO, outDir).startsWith("..") ? outDir : relative(REPO, outDir);
  const refJudged = summarizeEewE01(manifest, samples, injections).runs.filter((r) => r.scope === "reference" && results.some((x) => x.spec.population === r.population && x.spec.run === r.run));
  const summary = {
    kind: "p2-eew-e01-preliminary-v1", status: "未確認", statusReason: "予備測定。正式 E01 の合否・Q-PERF の凍結値ではない",
    manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, startedAt, finishedAt: new Date().toISOString(), commands, plan, notification,
    notificationProbeNote: probeNote, environment: { node: results[0]?.record.nodeVersion, chrome: manifest.chrome.version, os: manifest.osVersion, device: manifest.device },
    rawEvidenceDir: dirRel, formal: results.filter((r) => r.spec.population === "fixedBacklog").map(preliminaryFormal),
    references: results.filter((r) => r.spec.population !== "fixedBacklog").map((r) => ({ population: r.spec.population, run: r.spec.run, records: r.references,
      warmup: refStats(r.references.filter((x) => x.index < r.spec.warmup)),
      samples: refStats(r.references.filter((x) => x.index >= r.spec.warmup)),
      paintWithoutScreenshot: withoutScreenshot(r.record, r.spec.warmup),
      injectedToT0Ms: dist(r.injections.filter((i) => i.sampleIndex >= r.spec.warmup && i.injectedInjectorMonotonicMs != null && r.host.t0.has(i.inputId)).map((i) => r.host.t0.get(i.inputId) - i.injectedInjectorMonotonicMs - r.host.ohLo)),
      judged: refJudged.filter((j) => j.population === r.spec.population) })),
    cause, runs: results.map((r) => ({ label: r.label, durationMs: r.record.durationMs, trials: r.spec.warmup + r.spec.count, msPerTrial: round(r.record.durationMs / (r.spec.warmup + r.spec.count)),
      traceBytes: r.record.blocks.reduce((a, b) => a + b.bytes, 0), traceBlocks: r.record.blocks.length, dataLoss: r.record.blocks.some((b) => b.dataLoss), channels: r.record.channels, notification: r.record.notification, paintWithoutScreenshot: withoutScreenshot(r.record, r.spec.warmup), hostExit: r.record.hostExit })),
  };
  writeFileSync(join(evidence, "e01-preliminary-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary.formal));
}

// symlink 経由の起動でも走るよう、実体の path で比べる（ESM の import.meta.filename は実体の path）。
if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  const closeAll = () => current.close().then(root.close);
  main(process.argv.slice(2)).then(() => closeAll().then(() => process.exit(0)), async (error) => { console.error(error); await closeAll(); process.exit(1); });
}
