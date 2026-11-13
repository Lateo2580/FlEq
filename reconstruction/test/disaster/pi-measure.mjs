// P3-DISASTER-PI-MEASURE-001 の 2 段目（AC04）: 1 段目の山の写し（peak.json と state/）を本物の host（host-launcher.mjs の子 process、worker と disk）で
// 復元し、復元の時間・保存の段ごとの時間・EEW の投入から T0・T2・T4 までの待ち・RSS・snapshot の直列化を測って、結果を 1 file に封じる。
// 無いと、Pi で本物の worker と SD の上の保存・復元・EEW の待ち・RSS を測る口が無い（Q-DPM-PI）。node だけで動き、vitest・Chrome を使わない。
//   node reconstruction/test/disaster/pi-measure.mjs --peak <dir> --work <dir> --out <file> [--launches 5] [--probe-seconds 60] [--node <path>]
// 前提は dist（AGENTS.md の reconstruction ゲートの tsc 3 本）。結果を書けたら rc 0（status が blocked でも）、書けなければ rc 1。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { arch, cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";

import { versionKey } from "../eew-e01/analysis.mjs";
import { hostMsOf, parseFlags, parseJsonl } from "../eew-e01/aux-measures.mjs";
import { REPO, dataFrame, eewVariant, fixtureText, shiftTimestamps, weatherFrame } from "../eew-e01/frames.mjs";
import { startInjector, stations30k } from "../eew-e01/run.mjs";

import { ZERO_HASH, sealSelfHash } from "../../dist/src/measurement/eew-e01/frozen.js";
import { executionPlaces } from "../../dist/src/runtime/unit-coverage.js";
import seismic from "../../dist/src/units/seismic/seismic-unit.js";
import projector from "../../dist/src/view-projector/view-projector.js";

const LAUNCHER = join(REPO, "reconstruction/test/eew-e01/host-launcher.mjs");
const READY_MS = 120_000; // P3-DPM-RES-02
const EEW_EVERY_MS = 200, EEW_EVENTS = 5, DIRTY_EVERY_MS = 5_000, DRAIN_MS = 10_000, STOP_MS = 60_000;
// 大きい unit を dirty にする入力（AC04 (3)）。U-T・U-Q は EventID を報ごとに替え（必ず変わる）、U-W・U-F は官署を替えない（件数を増やさない）。
const DIRTY = [["U-T", "VTSE41", "32-39_11_02_250206_VTSE41"], ["U-Q", "VXSE53", "32-35_04_04_240613_VXSE53"], ["U-W", "VPWW57", "15_16_02_251222_VPWW57"],
  ["U-F", "VPWP50", "81_01_04_251222_VPWP50"]];
const DIRTY_UNITS = DIRTY.map(([unit]) => unit);
const WIDE_FIXTURE = "telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825";

const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const reportMs = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)[1]);
const at = (xml, wallMs) => shiftTimestamps(xml, wallMs - reportMs(xml));
const withEventId = (xml, eventId) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
const pad2 = (n) => String(n).padStart(2, "0");

class Blocked extends Error {
  constructor(reason, detail) { super(`${reason}: ${detail}`); this.reason = reason; this.detail = detail; }
}

// 分布（p = ceil(q × n) 番目）。p99 は 100 件未満なら観測最大（p99IsMax、RES-07 の書き方）。
function stats(values, { p90 = false, p99 = false } = {}) {
  if (values.length === 0) return { count: 0 };
  const s = [...values].sort((a, b) => a - b);
  const rank = (q) => s[Math.ceil(q * s.length) - 1];
  return { count: s.length, p50: rank(0.5), ...(p90 ? { p90: rank(0.9) } : {}), ...(p99 ? { p99: s.length >= 100 ? rank(0.99) : s.at(-1), p99IsMax: s.length < 100 } : {}),
    max: s.at(-1) };
}

const readJsonl = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => /^diagnostics-.*\.jsonl$/.test(name)).sort()
  .flatMap((name) => parseJsonl(readFileSync(join(dir, name), "utf8"))) : []);

// 自分の T2 の後、自分の processing（か次の T2）までの最初の T3 が自分の版で、その版の最初の T4（run.mjs の t4Of と同じ境界）。1 回の走査で引く。
function t4Index(observations) {
  const own = new Map(), t4 = new Map();
  let current = null;
  for (const o of observations) {
    if (o.kind === "marker" && o.point === "T2") current = o.inputId;
    else if (o.kind === "marker" && o.point === "T3") { if (current != null) { own.set(current, versionKey(o.displayVersion)); current = null; } }
    else if (o.kind === "marker" && o.point === "T4") { const key = versionKey(o.displayVersion); if (!t4.has(key)) t4.set(key, o.monotonicMs); }
    else if (o.kind === "processing" && o.measurement.inputId === current) current = null;
  }
  return (inputId) => { const key = own.get(inputId); return key == null ? null : t4.get(key) ?? null; };
}

// 1 起動。返すのは集計の材料（raw）と起動ごとの値。blocked は Blocked を投げる。
async function launch(k, dir, ctx) {
  const cleanups = [];
  const scope = { add: (fn) => cleanups.push(fn) };
  const obsPath = join(dir, "host-obs.jsonl"), configPath = join(dir, "host-config.json");
  let exited = null;
  try {
    const launchedHr = hrMs();
    const injector = await startInjector(scope, { wallNow: () => ctx.wallOriginMs + (hrMs() - launchedHr) });
    writeFileSync(configPath, JSON.stringify({ wsUrl: injector.url, stateDirectory: join(dir, "state"), diagnosticDirectory: join(dir, "diagnostics"), obsPath,
      wallOriginMs: ctx.wallOriginMs, startedWallMs: Date.now(), notification: "silent", memEveryMs: 1_000 }));
    const forkedHr = hrMs();
    const child = spawn(ctx.nodePath, [LAUNCHER, configPath], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.once("exit", (code, signal) => { exited ??= { code, signal }; });
    child.on("error", (error) => { exited ??= { code: null, signal: null, error: String(error?.message ?? error) }; });
    cleanups.push(async () => { if (exited == null) { child.kill("SIGKILL"); for (let i = 0; i < 20 && exited == null; i++) await sleep(100); } });
    let timer;
    const ready = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("exit", (code, signal) => reject(new Blocked("hostFailed", `launch ${k}: exited before ready (code=${code}, signal=${signal})`)));
      timer = setTimeout(() => reject(new Blocked("hostFailed", `launch ${k}: not ready within ${READY_MS} ms`)), READY_MS);
    }).finally(() => clearTimeout(timer));
    const readyMs = hrMs() - forkedHr;
    await Promise.race([injector.connected(), sleep(30_000).then(() => { throw new Blocked("hostFailed", `launch ${k}: did not connect within 30 s`); })]);
    injector.sendStart();
    // T4 は SSE の client に書いた時だけ出るので、/events を 1 本つないで読み捨てる。
    await new Promise((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${ready.displayPort}/events`, (response) => { response.on("data", () => {}); response.on("error", () => {}); resolve(); });
      request.on("error", reject);
      cleanups.push(() => request.destroy());
    });
    const read = () => (existsSync(obsPath) ? parseJsonl(readFileSync(obsPath, "utf8")) : []);
    let clock = null;
    for (let i = 0; i < 100 && clock == null; i++) { clock = read().find((line) => line.t === "clock") ?? null; if (clock == null) await sleep(100); }
    if (clock == null) throw new Blocked("hostFailed", `launch ${k}: no clock line within 10 s`);
    // host の壁時計（wallOriginMs＋host の performance.now）を投入側の hrtime から推す。報の時刻は秒に丸める（run.mjs の wallNow と同じ）。
    const offset = clock.perfNowMs - Number(BigInt(clock.hrtimeNs)) / 1e6;
    const wallSecond = () => Math.floor((ctx.wallOriginMs + hrMs() + offset) / 1_000) * 1_000;
    const probeMs = ctx.probeSeconds * 1_000;
    const wideAt = Math.floor(probeMs / 2) + 100;
    // 観測点 30,000 の VXSE53 は投入の前に組む（数 MB の文字列と gzip で投入の時刻を揺らさない）。時刻は送る予定の秒へ寄せる。
    const wideFrame = dataFrame("VXSE53", Buffer.from(at(ctx.wideXml, wallSecond() + wideAt - (wideAt % 1_000))));
    const schedule = [
      ...Array.from({ length: Math.ceil(probeMs / EEW_EVERY_MS) }, (_, i) => ({ atMs: i * EEW_EVERY_MS, kind: "eew", index: i })),
      ...Array.from({ length: Math.ceil(probeMs / DIRTY_EVERY_MS) }, (_, j) => ({ atMs: j * DIRTY_EVERY_MS, kind: "dirty", index: j })),
      { atMs: wideAt, kind: "wide", index: 0 },
    ].sort((a, b) => a.atMs - b.atMs || (a.kind === "dirty" ? -1 : 1));
    const eews = [], dirties = [];
    let wide = null;
    const serials = Array(EEW_EVENTS).fill(0), lastReport = Array(EEW_EVENTS).fill(0);
    const startHr = hrMs();
    for (const item of schedule) {
      const wait = startHr + item.atMs - hrMs();
      if (wait > 0) await sleep(wait);
      if (exited != null) throw new Blocked("hostFailed", `launch ${k}: the host exited during the probe (${JSON.stringify(exited)})`);
      if (injector.broken != null) throw new Blocked("hostFailed", `launch ${k}: ${injector.broken}`);
      if (item.kind === "eew") {
        // EventID ごとに 1 秒に 1 報、Serial を 1 つずつ上げ、報の時刻は max(前の報＋1 秒, 今の秒)（同じ秒の続報は採られないため、run.mjs:505 の形）。
        const e = item.index % EEW_EVENTS;
        const eventId = `20261113${pad2(k)}100${e}`;
        serials[e] += 1;
        lastReport[e] = Math.max(lastReport[e] + 1_000, wallSecond());
        const xml = eewVariant({ eventId, serial: serials[e], reportAtMs: lastReport[e], variant: serials[e] % 2 === 1 ? "A" : "B" });
        const sent = injector.send(dataFrame("VXSE43", Buffer.from(xml)), "VXSE43");
        eews.push({ inputId: sent.seq == null ? null : `input-${sent.seq}`, injectedHrMs: sent.injectedHrMs });
      } else if (item.kind === "dirty") {
        const [unit, headType, fixture] = DIRTY[item.index % DIRTY.length];
        const frame = unit === "U-T" || unit === "U-Q"
          ? dataFrame(headType, Buffer.from(withEventId(at(fixtureText(fixture).toString("utf8"), wallSecond()), `20261113${pad2(k)}2${String(item.index).padStart(3, "0")}`)))
          : weatherFrame(fixture, headType, wallSecond());
        const sent = injector.send(frame, headType);
        dirties.push({ unit, inputId: sent.seq == null ? null : `input-${sent.seq}` });
      } else {
        const sent = injector.send(wideFrame, "VXSE53");
        wide = { inputId: sent.seq == null ? null : `input-${sent.seq}` };
      }
    }
    // 送った入力の T2 が出るまで待つ（最大 DRAIN_MS）。終わりの数報を「採られなかった」と数えないため。
    const sentIds = [...eews, ...dirties, ...(wide == null ? [] : [wide])].map((item) => item.inputId);
    for (const drainUntil = hrMs() + DRAIN_MS; hrMs() < drainUntil;) {
      const done = new Set(read().flatMap((line) => line.t === "obs" && line.o.kind === "marker" && line.o.point === "T2" ? [line.o.inputId] : []));
      if (sentIds.every((id) => id != null && done.has(id))) break;
      await sleep(500);
    }
    if (exited != null || injector.broken != null) throw new Blocked("hostFailed", `launch ${k}: ${injector.broken ?? `the host exited (${JSON.stringify(exited)})`}`);
    child.send({ t: "stop" });
    for (const stopUntil = hrMs() + STOP_MS; exited == null && hrMs() < stopUntil;) await sleep(100);
    if (exited == null) throw new Blocked("hostFailed", `launch ${k}: did not stop within ${STOP_MS} ms`);
    if (exited.code !== 0) throw new Blocked("hostFailed", `launch ${k}: exit ${JSON.stringify(exited)}`);
    return analyze(k, dir, ctx, { lines: read(), readyMs, eews, dirties, wide });
  } finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* 後始末の失敗で他の後始末を止めない */ } }
  }
}

function analyze(k, dir, ctx, { lines, readyMs, eews, dirties, wide }) {
  const observations = lines.flatMap((line) => (line.t === "obs" ? [line.o] : []));
  const checkpoints = observations.flatMap((o) => (o.kind === "checkpoint" ? [o.measurement] : []));
  const diagnostics = readJsonl(join(dir, "diagnostics"));
  // (f) 復元の確かめ。
  const rejected = diagnostics.filter((d) => d.reason === "checkpointRestoreRejected" || d.reason === "checkpointSchemaDiscarded");
  if (rejected.length !== 0) throw new Blocked("restoreRejected", `launch ${k}: ${rejected.map((d) => `${d.unit ?? "-"} ${d.reason}`).join(", ")}`);
  const firstEncode = new Map();
  for (const m of checkpoints) if (m.stage === "encode" && !firstEncode.has(m.unit)) firstEncode.set(m.unit, m);
  let restore = null;
  if (k > 0) {
    restore = {};
    for (const [unit, { generation }] of Object.entries(ctx.peak.units)) {
      const first = firstEncode.get(unit);
      restore[unit] = first == null ? "unverified" : first.generation > generation ? "restored" : "missing";
    }
    const missing = DIRTY_UNITS.filter((unit) => restore[unit] === "missing");
    if (missing.length !== 0) throw new Blocked("restoreMissing", `launch ${k}: ${missing.join(", ")} saved a generation not above the peak's (started empty)`);
  }
  const t0 = new Map(), t2 = new Map(), raised = new Set();
  for (const o of observations) {
    if (o.kind === "marker" && o.point === "T0") t0.set(o.inputId, o.monotonicMs);
    else if (o.kind === "marker" && o.point === "T2") t2.set(o.inputId, o.monotonicMs);
    else if (o.kind === "generationRaised") raised.add(`${o.inputId}|${o.unit}`);
  }
  const t4Of = t4Index(observations);
  const adopted = eews.filter((e) => e.inputId != null && raised.has(`${e.inputId}|U-E`));
  if (adopted.length < eews.length * 0.9) throw new Blocked("probeNotAdopted", `launch ${k}: ${adopted.length} of ${eews.length} EEW adopted`);
  const intervals = (place) => checkpoints.filter((m) => m.stage === "encode" && executionPlaces[m.unit] === place).map((m) => [m.startedMonotonicMs, m.endedMonotonicMs]);
  const urgent = intervals("urgent"), seismicPlace = intervals("seismic");
  const inside = (list, ms) => list.some(([from, to]) => ms >= from && ms <= to);
  const eewSamples = adopted.map((e) => {
    const injected = hostMsOf(lines, BigInt(Math.round(e.injectedHrMs * 1e6)).toString());
    const a = t0.get(e.inputId) ?? null, b = t2.get(e.inputId) ?? null, d = t4Of(e.inputId);
    const minus = (x, y) => (x == null || y == null ? null : x - y);
    // 投入が urgent の encode と seismic の encode の両方に重なれば urgent に数える。
    return { group: injected == null ? "none" : inside(urgent, injected) ? "urgentEncode" : inside(seismicPlace, injected) ? "seismicEncode" : "none",
      injectToT0: minus(a, injected), t0ToT2: minus(b, a), injectToT2: minus(b, injected), t2ToT4: minus(d, b) };
  });
  const firstAttempts = new Set([...firstEncode.values()].map((m) => m.attemptId));
  const summary = existsSync(join(dir, "diagnostics", "shutdown-summary.json")) ? JSON.parse(readFileSync(join(dir, "diagnostics", "shutdown-summary.json"), "utf8")) : null;
  const mem = lines.filter((line) => line.t === "mem");
  return {
    launch: k, state: k === 0 ? "empty" : "peak", readyMs, restore,
    sent: { eew: eews.length, eewAdopted: adopted.length, eewNotAdopted: eews.length - adopted.length, dirty: dirties.length, wide: wide == null ? 0 : 1 },
    folds: { seismicStationsFolded: diagnostics.filter((d) => d.reason === "seismicStationsFolded").reduce((sum, d) => sum + (d.count ?? 1), 0),
      droppedInfo: summary?.droppedDiagnostics?.INFO ?? null },
    memoryAtReady: mem[0] == null ? null : { rss: mem[0].rss, heapUsed: mem[0].heapUsed },
    hostNode: lines.find((line) => line.t === "meta")?.nodeVersion ?? null,
    raw: {
      saves: checkpoints.map((m) => ({ key: `${m.unit} ${m.stage}`, first: firstAttempts.has(m.attemptId), ms: m.endedMonotonicMs - m.startedMonotonicMs, bytes: m.bytes })),
      eew: eewSamples, mem: mem.map((line) => ({ rss: line.rss, heapUsed: line.heapUsed })),
      publishes: observations.flatMap((o) => (o.kind === "publishSerialization" ? [{ bytes: o.bytes, durationMs: o.durationMs }] : [])),
    },
  };
}

// launch の raw を併せた分布（保存は unit × stage、最初の保存は firstSave に分ける。EEW は投入の重なりの 3 組）。
function distributions(raws) {
  const saves = (first) => {
    const keys = new Map();
    for (const raw of raws) for (const s of raw.saves) if (s.first === first) keys.set(s.key, [...(keys.get(s.key) ?? []), s]);
    return Object.fromEntries([...keys].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, list]) =>
      [key, { ...stats(list.map((s) => s.ms), { p90: true }), maxBytes: Math.max(...list.map((s) => s.bytes)) }]));
  };
  const eew = raws.flatMap((raw) => raw.eew);
  const metric = (list, name) => stats(list.flatMap((s) => (s[name] == null ? [] : [s[name]])), { p99: true });
  const groups = Object.fromEntries(["urgentEncode", "seismicEncode", "none"].map((group) => {
    const list = eew.filter((s) => s.group === group);
    return [group, { count: list.length, injectToT0: metric(list, "injectToT0"), t0ToT2: metric(list, "t0ToT2"), injectToT2: metric(list, "injectToT2"), t2ToT4: metric(list, "t2ToT4") }];
  }));
  const mem = raws.flatMap((raw) => raw.mem), publishes = raws.flatMap((raw) => raw.publishes);
  return { saves: saves(false), firstSave: saves(true), eew: groups,
    memory: { rssMax: mem.length === 0 ? null : Math.max(...mem.map((m) => m.rss)), heapUsedMax: mem.length === 0 ? null : Math.max(...mem.map((m) => m.heapUsed)) },
    publishSerialization: { count: publishes.length, bytesMax: publishes.length === 0 ? null : Math.max(...publishes.map((p) => p.bytes)),
      durationMsMax: publishes.length === 0 ? null : Math.max(...publishes.map((p) => p.durationMs)) } };
}

async function main(argv) {
  const flags = parseFlags(argv);
  for (const name of ["peak", "work", "out"]) if (flags[name] == null) throw new Error(`--${name} is required`);
  const launches = Number(flags.launches ?? 5), probeSeconds = Number(flags["probe-seconds"] ?? 60);
  if (!Number.isInteger(launches) || launches < 1 || !Number.isInteger(probeSeconds) || probeSeconds < 1) throw new Error("--launches and --probe-seconds take positive integers");
  const peakFile = JSON.parse(readFileSync(join(flags.peak, "peak.json"), "utf8"));
  if (peakFile.schema !== "p3-disaster-peak-v1" || peakFile.peak == null) throw new Error("--peak has no p3-disaster-peak-v1 peak.json with a peak");
  const identity = { scenario: peakFile.scenario, digest: peakFile.digest, gitHead: peakFile.gitHead, effectiveLimits: peakFile.effectiveLimits,
    atMs: peakFile.peak.atMs, totalBytes: peakFile.peak.totalBytes };
  const machine = { arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, totalmem: totalmem(), node: process.version };
  const finish = (fields) => {
    const result = { schema: "p3-disaster-pi-measure-result-v1", contractId: "P3-DISASTER-PI-MEASURE-001", peak: identity, machine, options: { launches, probeSeconds }, ...fields };
    writeFileSync(flags.out, sealSelfHash(`${JSON.stringify({ selfSha256: ZERO_HASH, ...result }, null, 1)}\n`, "selfSha256"));
    console.info(`[P3-DPM] status=${result.status}${result.blocked == null ? "" : ` ${result.blocked.reason}: ${result.blocked.detail}`} out=${flags.out}`);
  };
  try {
    // (6) 動かす dist の上限と山の上限の照合。無いと、768 の山の写しを 512 の build で復元して測っても気づけない。
    const limits = peakFile.effectiveLimits;
    const actual = { events: seismic.EVENT_LIMIT, longPeriods: seismic.LONG_PERIOD_LIMIT, seismicBytes: seismic.seismicUnitCodec.maxEnvelopeBytes, snapshotBytes: projector.SNAPSHOT_BYTES };
    const expected = { events: limits?.seismic?.events, longPeriods: limits?.seismic?.longPeriods, seismicBytes: limits?.bytes?.["U-Q"], snapshotBytes: limits?.snapshotBytes };
    if (Object.keys(actual).some((key) => actual[key] !== expected[key])) throw new Blocked("limitMismatch", JSON.stringify({ dist: actual, peak: expected }));
    // 写しの破損（scp の途中など）を起動の前に止める。
    for (const file of peakFile.files) if (sha256(readFileSync(join(flags.peak, "state", file.path))) !== file.sha256) throw new Error(`peak file ${file.path} does not match peak.json`);
    const ctx = { wallOriginMs: peakFile.peak.atMs, nodePath: flags.node ?? process.execPath, probeSeconds, peak: peakFile.peak,
      wideXml: stations30k(fixtureText(WIDE_FIXTURE).toString("utf8")) };
    const runs = [];
    for (let k = 0; k <= launches; k++) {
      const dir = join(flags.work, `launch-${k}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "state"), { recursive: true });
      // launch 0 は空の state、1..L は毎回山の写しを写し直す（Linux で動くので cp -c は使わない）。
      if (k > 0) for (const file of peakFile.files) {
        mkdirSync(dirname(join(dir, "state", file.path)), { recursive: true });
        copyFileSync(join(flags.peak, "state", file.path), join(dir, "state", file.path));
      }
      runs.push(await launch(k, dir, ctx));
    }
    const peakRuns = runs.slice(1);
    finish({ status: "measured", blocked: null,
      readyMs: { empty: runs[0].readyMs, peak: stats(peakRuns.map((run) => run.readyMs)) },
      combined: distributions(peakRuns.map((run) => run.raw)),
      launches: runs.map(({ raw, ...run }) => ({ ...run, ...distributions([raw]) })) });
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    finish({ status: "blocked", blocked: { reason: error.reason, detail: error.detail } });
  }
}

main(process.argv.slice(2)).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
