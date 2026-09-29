// P2-A10 E01 の入口: node reconstruction/test/eew-e01/run.mjs --manifest <path> | --preliminary [options]
// 製品経路（ローカル WS → startP2Host → SSE → 実 Chrome）で EEW の T0→T6 を測る。runner は入力の送出と証拠収集だけで、
// 製品の入力処理はここに持たない。E01 以外（E02/E03/E05/E06/E12/E15/費用）の呼び出しは統合担当が後で足す。
// --manifest: verifyFrozenManifest を通った凍結 manifest だけを走らせる。--preliminary: 案（draft）で走らせ、結果の status は必ず「未確認」。
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { WebSocketServer } from "ws";

import { assembleTrials, analyzeTrace, buildHostIndex, referenceRecord } from "./analysis.mjs";
import { chromeVersion, hrMs, openPage, probeClock, sleep, startTracing, stopTracing } from "./chrome.mjs";
import { SMOKE_FILE, buildDraft, contractTextsFor } from "./draft.mjs";
import { REPO, dataFrame, eewVariant, eventIdOf, fixtureId, fixtureText, sha256Hex, loadEvents, shiftTimestamps, weatherFrame } from "./frames.mjs";

import { classifyEewCause, quantiles, summarizeEewE01 } from "../../dist/src/measurement/eew-e01/judge.js";
import { forecastWithinAllowance, sealSelfHash, verifyFrozenManifest } from "../../dist/src/measurement/eew-e01/frozen.js";

const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const RUNS_ROOT = join(homedir(), "dev/fleq-a10-runs");
const EVIDENCE_DIR = join(REPO, "reconstruction/test/eew-e01/evidence");
const T6C = "fleq:p2:eew:T6-candidate";
const POP_CODE = { fixedBacklog: 0, maxVpws50DecodeStarted: 1, maxWeatherCheckpointEncodeStarted: 2, maxForecastCheckpointSave: 3, forecastDeadlineOverlap: 4 };
const BLOCK = 100; // trace は 100 試行ごとに区切る
const UF_SMALL_VALID_AFTER_REPORT_MS = 49 * 3_600_000; // 81_01_04 系の validUntil は報告時刻の 49 時間後（Phase 0 で実測）

const SILENT_NOTE = "silent stub による probe（spawn の相手を /usr/bin/true に替えた結果）で、実 backend の結果ではない";

const cleanups = [];
let cleaning = null;
// 2 回目以降の呼び出し（例外の後の SIGINT など）も、同じ後始末の完了を待ってから exit する。
const cleanup = () => (cleaning ??= (async () => {
  for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* 後始末の失敗で他の後始末を止めない */ } }
})());
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void cleanup().finally(() => process.exit(130)); });

// ── 独立投入側: host と別プロセスのローカル WS server ──
async function startInjector() {
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
  cleanups.push(() => injector.close());
  return injector;
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
async function executeRun(spec, ctx) {
  const label = `${spec.population}-run${spec.run}`;
  const dir = join(ctx.outDir, label);
  mkdirSync(dir, { recursive: true });
  const status = { hostExit: null, hostError: null, trialsStarted: 0 };
  try {
    return await measureRun(spec, ctx, label, dir, status);
  } catch (error) {
    writeFileSync(join(dir, "run-aborted.json"), `${JSON.stringify({ label, reason: String(error?.stack ?? error), ...status, abortedWallMs: Date.now() }, null, 2)}\n`);
    throw error;
  }
}

async function measureRun(spec, ctx, label, dir, status) {
  const { population, run } = spec;
  const obsPath = join(dir, "host-obs.jsonl");
  const started = { wallMs: Date.now(), hrMs: hrMs() };
  const injector = await startInjector();
  const configPath = join(dir, "host-config.json");
  writeFileSync(configPath, JSON.stringify({ wsUrl: injector.url, stateDirectory: join(dir, "state"), diagnosticDirectory: join(dir, "diagnostics"),
    obsPath, wallOriginMs: ctx.wallOriginMs, startedWallMs: started.wallMs, notification: ctx.notification }));
  const launcher = spawn(ctx.nodePath, [join(REPO, "reconstruction/test/eew-e01/host-launcher.mjs"), configPath], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  launcher.once("exit", (code, signal) => { status.hostExit = { code, signal }; });
  // 閉じた IPC への send（ERR_IPC_CHANNEL_CLOSED）などを uncaught にしない。
  launcher.on("error", (error) => { status.hostError ??= String(error?.message ?? error); });
  cleanups.push(async () => { if (status.hostExit == null) { launcher.kill("SIGTERM"); await sleep(1500); if (status.hostExit == null) launcher.kill("SIGKILL"); } });
  const ready = await new Promise((resolve, reject) => {
    launcher.once("message", resolve);
    launcher.once("exit", () => reject(new Error("host launcher exited before ready")));
    setTimeout(() => reject(new Error("host launcher not ready within 60s")), 60_000);
  });
  await Promise.race([injector.connected(), sleep(30_000).then(() => { throw new Error("host did not connect within 30s"); })]);
  const page = await openPage(`http://127.0.0.1:${ready.displayPort}/`);
  cleanups.push(() => page.close());
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
  const channels = await (await fetch(`http://127.0.0.1:${ready.displayPort}/snapshot`)).json().then((s) => s.channels, () => null);

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

  for (let k = 0; k < total; k++) {
    if (status.hostExit != null) throw new Error(`host launcher exited mid-run: ${JSON.stringify(status.hostExit)}`);
    if (injector.broken != null) throw new Error(injector.broken);
    status.trialsStarted = k;
    // 区切りの直前に 200ms 待ち、直前の試行の paint（PipelineReporter の終端）を前の trace に入れる。
    if (k > 0 && k % BLOCK === 0) { await sleep(200); await closeBlock(k / BLOCK - 1); await openBlock(); }
    if (hrMs() - lastProbeHr >= 29_000) { await probe(`t${k}`); lastProbeHr = hrMs(); }
    const phase = k < spec.warmup ? "warmup" : "formal";
    const idx = phase === "warmup" ? k : k - spec.warmup;
    const due = loopStart + k * spec.periodMs;
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

  // 終了: host → Chrome → 投入側の順で止める
  if (launcher.connected) launcher.send({ t: "stop" });
  for (let i = 0; i < 100 && status.hostExit == null; i++) await sleep(100);
  if (status.hostExit == null) launcher.kill("SIGKILL");
  // 後始末が失敗しても、記録して trace の解析と run-record の書き出しへ進む。
  const teardownErrors = [];
  for (const [name, fn] of [["chrome", page.close], ["injector", injector.close]]) {
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
  const args = new Map();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]);
  const num = (key, fallback) => (args.has(key) ? Number(args.get(key)) : fallback);
  const preliminary = args.has("preliminary");
  if (preliminary === args.has("manifest")) throw new Error("exactly one of --manifest <path> or --preliminary is required");
  // host は Node 22 でだけ測る（黙って別版へ切り替えない）。版は run の前に実物へ訊く。
  if (!existsSync(NODE22)) throw new Error(`Node 22 not found at ${NODE22}; refusing to measure with another version`);
  const nodePath = NODE22;
  const nodeVersion = await new Promise((resolve) => { const c = spawn(nodePath, ["-p", "process.version"]); let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("close", () => resolve(o.trim())); });
  const caffeinate = spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});
  cleanups.push(() => caffeinate.kill());

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
    if (nodeVersion !== manifest.nodeVersion) throw new Error(`${nodePath} is ${nodeVersion}, manifest.nodeVersion is ${manifest.nodeVersion}`);
  }
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
  const commands = [`node ${["reconstruction/test/eew-e01/run.mjs", ...argv].join(" ")}`, `host: ${nodePath} host-launcher.mjs`, "caffeinate -dims -w <pid>"];
  const startedAt = new Date().toISOString();
  if (draft != null) {
    writeFileSync(join(evidence, "manifest.draft.json"), draft.manifestText);
    writeFileSync(join(evidence, "trial-setup.draft.json"), draft.trialSetupText);
    writeFileSync(join(evidence, "initial-state.draft.json"), draft.initialStateText);
  }

  const results = [];
  const runs = [];
  for (const spec of specs.filter((s) => only == null || only.includes(s.population))) {
    const ctx = { outDir, nodePath, notification, manifest, wallOriginMs: frozen.wallOriginMs, initial: frozen.initial, load: manifest.loads[spec.population === "fixedBacklog" ? manifest.formal.load : manifest.reference[spec.population].load] };
    console.log(`[run] ${spec.population} run${spec.run}: warmup ${spec.warmup} + ${spec.count}, period ${spec.periodMs}ms`);
    const result = await executeRun(spec, ctx);
    results.push(result);
    runs.push({ label: result.label, durationMs: result.record.durationMs });
    console.log(`[run] ${result.label} done in ${Math.round(result.record.durationMs / 1000)}s`);
  }

  let probeNote = null;
  // draft の notificationProbe は直書きでなく、実 run で得た probe の結果を入れて再封印する（予備測定のみ）。
  if (preliminary && results.length > 0) {
    const channels = results[0].record.channels;
    const probe = (v) => (v === "available" ? "idle" : "unavailable");
    if (notification === "silent") probeNote = SILENT_NOTE;
    const text = sealSelfHash(`${JSON.stringify({ ...manifest, manifestSha256: "0".repeat(64), notificationProbe: { desktop: probe(channels?.desktop), sound: probe(channels?.sound) } }, null, 2)}\n`, "manifestSha256");
    manifest = JSON.parse(text);
    writeFileSync(join(evidence, "manifest.draft.json"), text);
  }

  // 判定
  const samples = results.flatMap((r) => r.samples);
  const injections = results.flatMap((r) => r.injections);
  const cause = classifyEewCause(samples, results.flatMap((r) => r.host.processing), results.flatMap((r) => r.host.checkpoints));
  const dirRel = relative(REPO, outDir).startsWith("..") ? outDir : relative(REPO, outDir);
  if (preliminary) {
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
    return;
  }
  // 本番: 判定は WP2 の summarizeEewE01。U-F が許容範囲を外れた run は Pass を主張しない（AC01）。
  const judged = summarizeEewE01(manifest, samples, injections);
  const outOfRange = new Set(results.filter((r) => r.spec.population === "fixedBacklog" && ufNotWithin(r.record)).map((r) => r.spec.run));
  const finalRuns = judged.runs.map((run) => ({ ...run, status: run.scope === "formal" && outOfRange.has(run.run) && run.status === "Pass" ? "未確認" : run.status,
    evidenceRefs: [`${dirRel}/${run.population}-run${run.run}/run-record.json`, ...(outOfRange.has(run.run) && run.scope === "formal" ? ["ufNotWithinAllowance(別条件。試行単位は run-record の ufAllowance)"] : [])] }));
  const formalStatuses = finalRuns.filter((r) => r.scope === "formal").map((r) => r.status);
  const verdict = { ...judged.verdict, status: formalStatuses.includes("Fail") ? "Fail" : formalStatuses.every((s) => s === "Pass") ? "Pass" : "未確認" };
  for (const run of finalRuns) writeSealed(join(evidence, `result-${run.scope}-${run.population}-run${run.run}.json`), run, "resultSha256");
  writeFileSync(join(evidence, "e01-verdict.json"), `${JSON.stringify({ verdict, cause, startedAt, finishedAt: new Date().toISOString(), commands, notification, runs: runs.map((x) => ({ ...x, paintWithoutScreenshot: withoutScreenshot(results.find((y) => y.label === x.label).record, results.find((y) => y.label === x.label).spec.warmup) })) }, null, 2)}\n`);
}

// symlink 経由の起動でも走るよう、実体の path で比べる（ESM の import.meta.filename は実体の path）。
if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(() => cleanup().then(() => process.exit(0)), async (error) => { console.error(error); await cleanup(); process.exit(1); });
}
