// A10 WP3c U3（P2-A10-AC08/AC09/AC11/AC15）: E01 以外の窓（E02+E05・E03・AC15・E12・E06）。各窓は run.mjs の runWindow が回す
// { id, expectedMin, run(w) }（w = { dir, scope, progress, commands }）。集計は WP2（judge.ts）・WP3b（aux-measures.mjs）・U4（ac15.mjs）の
// 関数を呼ぶだけで書き直さない。host の起動（startHost）と JSONL の追跡（tailer）は run.mjs のものを ctx で受ける（循環 import を作らない）。
// 受信経路の計算量: 充填の確認・通知の静まり待ち・集計はすべて runner 側（host の外）。host に足すのは E02 の mem 1 秒 timer と AC15 の preload だけ。
import { execFile, spawn } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

import { AC15_OWNERS, ac15Intervals, checkpointWindows, compareRetention, fingerprintTable, judgeAc15, ownerProbeIncomplete, readLatestEnvelopes } from "./ac15.mjs";
import { viewCopyReport } from "./analysis.mjs";
import {
  drainBounds, e14Acks, e14Index, hostMsOf, notificationAdoptionReport, ownerHeapReport, parseJsonl, publishCostReport, startFdSampler, summarizeE03, summarizeE05,
  summarizeE06, summarizeE07, summarizeE14, summarizeE15, classifyE05cRun, E12_THREADS,
} from "./aux-measures.mjs";
import { hrMs, sleep } from "./chrome.mjs";
import { E12_CLASSES, FIX, ac15Frame, cycleCFrames, dataFrame, e03Frame, fixtureText, loadEvents, nearCapacityFrames, replayLoad, sendPaced, sha256Hex, shiftTimestamps, weatherFrame } from "./frames.mjs";
import { tsunamiReport } from "./tsunami.mjs";

import { quantiles, summarizeHealthE02 } from "../../dist/src/measurement/eew-e01/judge.js";
import { ZERO_HASH, sealSelfHash } from "../../dist/src/measurement/eew-e01/frozen.js";

const HERE = import.meta.dirname;
const E02_CLIENT = join(HERE, "e02-health-client.mjs");
const E12_RUN = join(HERE, "e12-run.mjs");
const PROBE_PRELOAD = join(HERE, "probe-preload.mjs");

// 通常負荷の再生（E01 の背景と E02・E03 の負荷が共有する）。ReplayLoad の offset どおりに、窓の長さで繰り返す。報告時刻は投入時点の壁時計。
export function replayPump(load, send, wallNow, startHr = hrMs(), extra = null) {
  const events = extra == null ? loadEvents(load) : mergedEvents(load, extra);
  let next = 0;
  return () => {
    for (;;) {
      const cycle = Math.floor(next / events.length);
      const event = events[next % events.length];
      if (startHr + cycle * load.durationMs + event.offsetMs > hrMs()) return;
      send((event.extra ? overlayFrame : weatherFrame)(event.name, event.headType, wallNow()), event);
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
// probe の行（充填を含むと数百 MB）を 1 行ずつ読み、fromMs があれば判定区間の始まり以後の行だけを残す（全体を 1 つの文字列にしない）。
async function readProbeRows(path, fromMs) {
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (line === "") continue;
    const row = JSON.parse(line);
    if (fromMs == null || row[0] >= fromMs) rows.push(row);
  }
  return rows;
}
// E15 と publish 費用は host を起動した全窓で出す（AC15 は E01・E02 の各窓に PublishCostReport を求める）。byteViolations は窓記録にも出す。
const BYTE_NOTE = "byteViolations は encode・write・verify 以外の段で bytes が 0 でない件数。verify 段の bytes は読んだ bytes として e15.units の verifyBytes に別に数える（P3-C1-E15、A10 の P2-A10-E15-P3 の読み）";
// hostDir は host の dir（host-obs.jsonl と diagnostics/ の親）。E15 の診断 log の帰属に、診断 dir の jsonl の改行の数と byte を渡す（P3-C4-AC05）。
// placeOf は投入側の入力 ID → 実行場所（view の複製の版の窓、P3-C4-T3-BINDING）。
export function hostReports(records, window, hostDir = null, placeOf = () => null) {
  const e15 = summarizeE15(records, { diagnosticLog: hostDir == null ? null : diagnosticLog(hostDir) });
  // ownerHeap（deadlineDone の行）・通知の採用の待ち・view の複製（P3-C4-AC13(4)〜(6)）は全窓で参考量として出す。
  const heapRows = records.flatMap((r) => (r.t === "obs" && r.o.kind === "ownerHeap" && r.o.replyKind === "deadlineDone" ? [r.o] : []));
  return { e15, byteViolations: e15.byteViolations ?? null, byteViolationsNote: BYTE_NOTE, publishCost: publishCostReport(records, window),
    ownerHeap: ownerHeapReport(heapRows), notificationAdoption: notificationAdoptionReport(records), viewCopy: viewCopyReport(records, placeOf) };
}
export const hostReportsOf = (obsPath, window, placeOf = () => null) => hostReports(readJsonl(obsPath), window, dirname(obsPath), placeOf);
const diagnosticFiles = (hostDir) => {
  const dir = join(hostDir, "diagnostics");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
};
const diagnosticLog = (hostDir) => {
  if (!existsSync(join(hostDir, "diagnostics"))) return null;
  const texts = diagnosticFiles(hostDir).map((f) => readFileSync(f));
  return { bytes: texts.reduce((a, b) => a + b.length, 0), lines: texts.reduce((a, b) => a + b.toString("utf8").split("\n").length - 1, 0) };
};
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
  return { ...h, refresh, check, lines: tail.lines, hostMs: (at = hrMs()) => at + oh,
    processed: () => { refresh(); return decodes; },
    sent: () => lastSeq,
    // head.type は frame の先頭近くにある（frames.mjs の dataFrame）。投入側に渡して実行場所を記録させる（P3-C4-T3-BINDING）。
    send: (frame) => {
      check();
      const r = h.injector.send(frame, /"head":\{"type":"([^"]+)"/.exec(frame.slice(0, 400))?.[1] ?? null);
      if (r.seq == null) throw new Error("send failed: injector not connected");
      lastSeq = r.seq;
      return r;
    },
    wallMs: (at = hrMs()) => ctx.wallOriginMs + Math.trunc(at + oh),
    wallSec: () => ctx.wallOriginMs + Math.floor((hrMs() + oh) / 1000) * 1000,
    snapshot: async () => (await fetch(`http://${h.displayHost}:${h.displayPort}/snapshot`, { signal: AbortSignal.timeout(10_000) })).json(),
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
// 充填の EEW の current の寿命（P3-LIFE-SEM-01: 起点＋600,000ms）と、C 窓・E14 の失効の待ちの上限（P3-MH-RES-05）。
const EEW_CURRENT_MS = 600_000;
const EXPIRY_WAIT_LIMIT_MS = 660_000;
const TICK_MS = 1000;
// 診断の JSONL から reason の件数（count 付きの行は count）を数える。確かめの時に 1 回だけ読む（P3-MH-AC07）。
const diagnosticCount = (hostDir, reason) => diagnosticFiles(hostDir).flatMap((f) => readJsonl(f))
  .reduce((n, d) => n + (d.reason === reason ? d.count ?? 1 : 0), 0);
// snapshotsAt は送った frame の列から /snapshot を取る位置の配列を返す関数（充填の件数が mode で変わるため）。
// blockAtExpiry（P 窓、P3-MH-FULL-STATE=D）: 測定の開始の前の確かめを充填の EEW の起点＋600,000ms より前に終えられなければ Blocked。
async function fill(host, w, ctx, mode, { snapshotsAt = () => [], blockAtExpiry = false } = {}) {
  const recipe = ctx.initialState.nearCapacity.modes[mode];
  if (recipe?.expected == null) throw new Error(`stateNotReproducible: initial-state nearCapacity.modes.${mode}.expected is null (room not frozen)`);
  // P3-MH-AC01(1): 充填の U-E の報告時刻は充填の開始の host 壁時計の秒。これが充填の current の起点（失効は起点＋600,000ms）。
  const eewOriginWallMs = host.wallSec();
  const frames = nearCapacityFrames(mode === "leaveRoomForP" ? { mode, room: recipe.room, eewReportAtMs: eewOriginWallMs } : { mode, eewReportAtMs: eewOriginWallMs });
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
  // P3-MH-AC01(5): 充填の間に horizon 外で捨てた EEW が 1 件でもあれば、件数が合っても状態は作れていない。
  const horizonStale = diagnosticCount(w.dir, "eewHorizonStale");
  if (horizonStale > 0) throw new Error(`stateNotReproducible: ${mode} fill has ${horizonStale} eewHorizonStale diagnostics`);
  const record = { mode, frames: frames.length, firstSeq: sentBefore + 1, sentMs: Math.round(sentMs), verifiedMs: Math.round(hrMs() - started), observed,
    eewOriginWallMs, eewHorizonStale: horizonStale };
  w.progress.fill = record;
  w.progress.phase = "quiet";
  record.quiet = await quietWait(host.pid, w);
  const expired = () => blockAtExpiry && host.wallMs() >= eewOriginWallMs + EEW_CURRENT_MS;
  const currentsExpired = () => new Error(`currentsExpiredBeforeMeasure: the fill's EEW currents expire at ${new Date(eewOriginWallMs + EEW_CURRENT_MS).toISOString()} (host wall clock) before the measurement starts (P3-MH-RES-02)`);
  if (expired()) throw currentsExpired();
  // 静まりの間に状態が変わっていないこと（測定開始の直前にもう一度）。
  record.observedBeforeMeasure = await verify(0);
  if (expired()) throw currentsExpired();
  // record は窓の記録へ、snapshots（AC15 の指紋表）と headTypes（AC15 の unitOfInput）は付帯物として分けて返す。
  return { record, snapshots, headTypes: frames.map((f) => f.headType), expected: recipe.expected };
}

// P3-MH-FULL-STATE=D（C 窓・E14）: 充填の current が全部失効するのを待ってから周期・束を始める。host の壁時計が起点＋600,000ms＋2 tick を
// 過ぎ、/snapshot の eew が 0/0/0 で weather の件数が recipe のままになるまで待つ（起点＋660,000ms を過ぎたら stateNotReproducible）。
// 無いと、窓の途中で 1,024 件の current が一度に失効し、定常の区間（傾き・束の値）に失効の山が混ざる。
// observe・pause は試験が host の代わりに渡す口（既定は /snapshot と保存済み checkpoint、1 tick の待ち）。
export async function waitFillExpiry(host, w, filled, { observe = (expected) => observedCounts(host, join(w.dir, "state"), expected), pause = sleep } = {}) {
  const origin = filled.record.eewOriginWallMs;
  const expected = { ...filled.expected, snapshotActive: { ...filled.expected.snapshotActive, eew: "0/0/0" } };
  w.progress.phase = "expiry";
  const started = hrMs();
  for (;;) {
    host.check();
    const ready = host.wallMs() >= origin + EEW_CURRENT_MS + 2 * TICK_MS;
    const observed = ready ? await observe(expected) : null;
    // 上限は観測から戻った後、一致の判定より先に見る（上限の前に要求し、上限の後に一致を返した観測で窓を始めない）。
    if (host.wallMs() > origin + EXPIRY_WAIT_LIMIT_MS) {
      throw new Error(`stateNotReproducible: the fill's EEW currents did not expire by origin + ${EXPIRY_WAIT_LIMIT_MS}ms; expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
    }
    if (observed != null && JSON.stringify(observed) === JSON.stringify(expected)) {
      filled.record.expiry = { waitedMs: Math.round(hrMs() - started), observedAfterExpiry: observed };
      return;
    }
    await pause(TICK_MS);
  }
}

// P3-MH-FULL-STATE=D（P 窓）: 失効の時刻（期限＝起点＋600,000ms の host 単調時計）と、E05 の最大 RSS・E02 の分位点を失効の前・後に分けた値。
// 報告のみ（判定は窓全体）。E02 の標本は client の時計の要求開始を、start 行の hrtime と performance.now の組で host 時計へ写す。
// measureStartHostMs は E02 の最初の標本の要求開始（host 時計）。P 窓はこれが期限より前でなければ失効の前を測っていない（currentsExpiredAtMeasure）。
export function expirySplit(records, rows, client, ctx, fill) {
  const expiryHostMs = fill.eewOriginWallMs + EEW_CURRENT_MS - ctx.wallOriginMs;
  const fromMs = hostMsOf(records, client.start.hrtimeNs);
  const toMs = hostMsOf(records, client.end.hrtimeNs);
  if (fromMs == null || toMs == null) return { expiryHostMs, measureStartHostMs: null, status: "未確認", reason: "clockUnavailable" };
  const rss = (a, b) => { const e = summarizeE05(records, "P", { fromMs: a, toMs: b }); return { samples: e.samples, maxRssBytes: e.maxRssBytes }; };
  const clientToHost = (ms) => (client.start.perfNowMs == null ? null : fromMs + ms - client.start.perfNowMs);
  const latency = (s) => (s.failure != null || s.bodyCompleteMonotonicMs == null || s.httpStatus !== 200 ? Infinity : s.bodyCompleteMonotonicMs - s.requestStartMonotonicMs);
  const part = (keep) => {
    const values = rows.filter((s) => { const at = clientToHost(s.requestStartMonotonicMs); return at != null && keep(at); }).map(latency);
    const q = quantiles(values);
    const finite = (v) => (v == null || !Number.isFinite(v) ? null : v);
    return { samples: values.length, p50Ms: finite(q?.p50), p99Ms: finite(q?.p99), maxMs: finite(q?.max) };
  };
  const firstRequest = rows.reduce((m, r) => Math.min(m, r.requestStartMonotonicMs), Infinity);
  return { expiryHostMs, measureStartHostMs: Number.isFinite(firstRequest) ? clientToHost(firstRequest) : null,
    note: "期限（起点＋600,000ms）の host 単調時計。回収はその後の最初の deadline 要求。報告のみで判定は窓全体",
    e05: { before: rss(fromMs, Math.min(expiryHostMs, toMs)), after: rss(Math.max(expiryHostMs, fromMs), toMs) },
    e02: { before: part((at) => at < expiryHostMs), after: part((at) => at >= expiryHostMs) } };
}

// P3-MH-RES-02: P 窓の測定（E02 の最初の標本）が充填の current の期限より前に始まったか。違えば・確かめられなければ理由の文（窓は Blocked）。
// fill の確かめの後に子を起動するので、fill の中の確かめだけでは子の起動中に期限を越えた窓を通す。
export function currentsExpiredAtMeasure(split) {
  return split.measureStartHostMs != null && split.measureStartHostMs < split.expiryHostMs ? null
    : `currentsExpiredBeforeMeasure: the E02 measurement started at host ${split.measureStartHostMs ?? "unknown"}ms, not before the fill's EEW currents expire at host ${split.expiryHostMs}ms (P3-MH-RES-02)`;
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
function e02Window(ctx, load, run, classify = null) {
  const { requestEveryMs, requestTimeoutMs, minSamplesPerRun } = ctx.manifest.health;
  const count = ctx.counts.e02 ?? minSamplesPerRun;
  const id = classify == null ? `e02-${load}-run${run}` : classify === E05Y.mark ? `e05y-${load}-run${run}` : `e05c-${classify}-run${run}`;
  const label = classify === E05S.y || classify === E05S.p ? `${classify}-run${run}` : id; return {
    id: label, expectedMin: Math.ceil((count * requestEveryMs) / 60_000) + (load === "P" ? 6 : 2),
    run: async (w) => {
      const { host, probe } = await openE02Host(w, ctx, classify);
      const filled = load === "P" ? await fill(host, w, ctx, "leaveRoomForP", { blockAtExpiry: true }) : null;
      const out = join(w.dir, "e02.jsonl");
      await probe?.beforeMeasure();
      const client = startChild(w, ctx, [E02_CLIENT, "--url", `http://${host.displayHost}:${host.displayPort}/healthz`, "--count", String(count), "--every-ms", String(requestEveryMs),
        "--timeout-ms", String(requestTimeoutMs), "--load", load, "--run", String(run), "--out", out], "e02-client");
      const pump = replayPump(ctx.manifest.loads[load], host.send, host.wallSec);
      const typhoon = classify === E05Y.mark || classify === E05S.y ? e05yPump(ctx, host) : classify === E05S.p ? e05yPump(ctx, host, null) : null; w.progress.phase = "measure";
      w.progress.total = count;
      let beat = 0;
      await waitChild(client, count * requestEveryMs + 120_000, () => {
        host.check();
        (typhoon?.pump ?? pump)();
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
      const reports = hostReports(records, label, w.dir, host.injector.placeOf);
      const expiry = filled == null ? null : expirySplit(records, samples, { start, end }, ctx, filled.record);
      const late = expiry == null ? null : currentsExpiredAtMeasure(expiry);
      if (late != null) throw new Error(late);
      if (probe != null || typhoon != null) return (typhoon == null ? e05cOutcome : probe == null ? e05yOutcome : e05sOutcome)(ctx, w, label, probe ?? typhoon, { host, records, start, end, health, e05, reports, expiry, fill: filled?.record ?? null, typhoon });
      // 窓の status は E02（この窓の主の判定）。E05 は statuses に別に持つ（まとめて潰さない）。予備は status と同じく未確認に倒し、判定は judgedStatuses へ。
      const statuses = { E02: health.status, E05: e05.status };
      const o = outcome(ctx, health.status, reports, { fill: filled?.record ?? null, expirySplit: expiry, ...(ctx.preliminary ? { statuses: { E02: "未確認", E05: "未確認" }, judgedStatuses: statuses } : { statuses }) });
      o.resultFiles = [
        seal(join(w.dir, `result-e02-${load}-run${run}.json`), { ...health, ...(ctx.preliminary ? { status: o.status, judgedStatus: health.status } : {}),
          evidenceRefs: [`${w.dir}/e02.jsonl`, `${w.dir}/host-obs.jsonl`] }, "resultSha256"),
        sealAux(w.dir, `aux-e05-${load}-run${run}.json`, ctx.manifest, { window: id, status: ctx.preliminary ? o.status : e05.status, e05, ...reports, fill: o.fill, expirySplit: expiry }),
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
// E03 の系列（N を流しながら最大 VPWS50 を periodMs ごと）を流して host を止め、対象の入力 ID と記録を返す。E03 と補助窓 ownerHeap が共有する。
async function e03Series(w, ctx, { warmup, samples, measureInputHeap = false }) {
  const series = ctx.initialState.e03Series;
  const host = await openHost(w, ctx, { measureInputHeap });
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
  return { host, targets, records: host.records() };
}

function e03Window(ctx, run) {
  const series = ctx.initialState.e03Series;
  const samples = ctx.counts.e03 ?? series.samples;
  const warmup = ctx.counts.e03 == null ? series.warmup : Math.min(series.warmup, Math.ceil(samples / 5));
  return {
    id: `e03-run${run}`, expectedMin: Math.ceil(((warmup + samples) * series.periodMs) / 60_000) + 2,
    run: async (w) => {
      const { host, targets, records } = await e03Series(w, ctx, { warmup, samples });
      const e03 = summarizeE03(records, targets, { minSamples: ctx.manifest.auxiliary.E03.minSamplesPerRun });
      // host の通し番号と投入側の seq が一致すること（全 frame が 1 本の接続で届いた）を T0 の件数で確かめる。ずれたら未確認。
      const t0 = records.filter((r) => r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0").length;
      const aligned = t0 === host.sent();
      const reports = hostReports(records, `e03-run${run}`, w.dir, host.injector.placeOf);
      const o = outcome(ctx, aligned ? e03.status : "未確認", reports, {});
      o.resultFiles = [sealAux(w.dir, `aux-e03-run${run}.json`, ctx.manifest,
        { window: `e03-run${run}`, status: o.status, warmup, samples, e03, seqAlignment: { t0, sent: host.sent(), aligned }, ...reports })];
      return o;
    },
  };
}

// ── 補助窓 ownerHeap（P3-C4-OWNER-HEAP=B'）: E03 と同じ系列で、inputDone の返信ごとの owner の heap（大型処理の直後の値）だけを取る。
// inputDone の heap は返信の前に取るので測りたい区間に入る。そのため E01・E03・衝突の窓では取らず、この窓だけ measureInputHeap を立てる。
// 報告のみ（閾値なし）。
function ownerHeapWindow(ctx, run) {
  const series = ctx.initialState.e03Series;
  const samples = ctx.counts.ownerHeap ?? ctx.manifest.auxiliary.ownerHeap.minSamplesPerRun;
  const warmup = Math.min(series.warmup, Math.ceil(samples / 5));
  return {
    id: `ownerHeap-run${run}`, expectedMin: Math.ceil(((warmup + samples) * series.periodMs) / 60_000) + 2,
    run: async (w) => {
      const { host, targets, records } = await e03Series(w, ctx, { warmup, samples, measureInputHeap: true });
      const wanted = new Set(targets);
      const rows = records.flatMap((r) => (r.t === "obs" && r.o.kind === "ownerHeap" && r.o.replyKind === "inputDone" && wanted.has(r.o.inputId) ? [r.o] : []));
      const heap = ownerHeapReport(rows);
      // 標本 0 の窓は何も確かめていないので未確認。
      const status = targets.length > 0 && rows.length === targets.length ? "N/A" : "未確認";
      const reports = hostReports(records, `ownerHeap-run${run}`, w.dir, host.injector.placeOf);
      const o = outcome(ctx, status, reports, {});
      o.resultFiles = [sealAux(w.dir, `aux-ownerHeap-run${run}.json`, ctx.manifest, { window: `ownerHeap-run${run}`, status: o.status, warmup, samples, inputDoneRows: rows.length,
        inputDoneHeap: heap, ...reports })];
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
  const snapshots = [...filled.snapshots, await host.snapshot()];
  const table = fingerprintTable(envelopes, snapshots);
  // P3-C4-AC03(4): 充填の完了時点の保存物（state/ の写し。窓 dir の state/ は測定中に上書きされ raw から外れる）と /snapshot の本文を raw に残す。
  // 無いと、指紋表と保持件数を封印済み結果から取るしかなく、AC15 を生データだけから再集計できない（A10 closure.md）。
  cpSync(join(dir, "state"), join(dir, "filled-state"), { recursive: true });
  writeFileSync(join(dir, "fill-snapshots.json"), JSON.stringify(snapshots));
  w.progress.phase = `measure:${mode}`;
  // unitOfInput は測定で流した全入力（充填・warm-up を含む）。unitOf は判定する区間（warm-up を除く）。
  const unitOfInput = new Map(filled.headTypes.map((h, i) => [`input-${filled.record.firstSeq + i}`, unitOfHead(h)]));
  const unitOf = new Map();
  const metadata = [];
  let due = hrMs() + 1000;
  for (const name of s.order) {
    for (let i = 0; i < warmup + samples; i++) {
      const item = name === "metadata" ? null : ac15Frame(name, i, host.wallMs(due));
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
  // P3-C4-AC03(4): metadata の区間の起点（runner が接続を切った hrtime）を raw に残す（A10 は予定表の起点から推定した）。
  writeFileSync(join(dir, "metadata-disconnects.json"), JSON.stringify(metadata));
  const records = host.records();
  const events = metadata.map((x) => ({ ...x, hostMs: hostMsOf(records, x.hrtimeNs) }));
  for (const x of events.filter((e) => e.index >= warmup)) unitOf.set(x.id, "metadata");
  const lastT0 = records.reduce((a, r) => (r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0" ? Math.max(a, r.o.monotonicMs) : a), -Infinity);
  // 最後の区間の終わりは最後の T0 + 1500ms（U4 の申し送り）。
  const intervals = ac15Intervals(withSyntheticT0(records, events), unitOf, { endMs: lastT0 + s.intervalMs });
  const publishObserved = [];
  for (const x of intervals.filter((i) => i.unit === "metadata")) { publishObserved.push(x.publishCount); x.publishCount = 2; }
  const judgedRows = judgeAc15(await readProbeRows(probePath, intervals[0]?.startMs ?? 0), intervals, table, { checkpointWindows: checkpointWindows(records), unitOfInput, minInputsPerUnit: samples });
  // owner の probe の最後の書き出しが窓の終わりより前なら、違反が少なく出うるので Pass を未確認にする（Fail は Fail のまま）。
  const writtenAt = Object.fromEntries(AC15_OWNERS.map((place) => {
    const file = `${probePath}.${place}.written`;
    return [place, existsSync(file) ? Number(readFileSync(file, "utf8")) : null];
  }));
  const incomplete = ownerProbeIncomplete(writtenAt, intervals.at(-1)?.endMs ?? Infinity);
  const judged = incomplete.length === 0 ? judgedRows : { ...judgedRows, status: judgedRows.status === "Fail" ? "Fail" : "未確認",
    missing: [...judgedRows.missing, `ownerProbeIncomplete:${incomplete.join(",")}`] };
  const reports = hostReports(records, `ac15-${mode}`, dir, host.injector.placeOf);
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
    id: "e06", expectedMin: Math.ceil((cycles * c.periodMs + EXPIRY_WAIT_LIMIT_MS) / 60_000) + 6,
    run: async (w) => {
      const host = await openHost(w, ctx);
      const filled = await fill(host, w, ctx, "cycleC");
      await waitFillExpiry(host, w, filled);
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
      const reports = hostReports(records, "e06", w.dir, host.injector.placeOf);
      const o = outcome(ctx, e06.complete ? "N/A" : "未確認", reports, { fill: filled.record, eewCapacityEvictedPerCycle: evicted });
      o.resultFiles = [sealAux(w.dir, "aux-e06.json", ctx.manifest, { window: "e06", status: o.status, cycles, steadyCycle, fill: filled.record,
        e06, perCycle: { eewCapacityEvicted: evicted, expected: c.expectedPerCycle }, fdSamples: fd.samples.length, ...reports })];
      return o;
    },
  };
}

// ── E07（P3-C4-AC07(2)、P3-C3B-E07-WINDOW=A）: N または C を 60 分（予備は --e07-minutes）流し、入力を止めて排出を見る ──
// C は E06 と同じ保持上限ちょうど（cycleC）から周期ごとに流し、次の周期の最初の frame の直前（最後の周期は窓の終わり）に boundary の
// ping を送る（同じ WS の受信順で周期末に一致する。tick の行は周期末に使わない）。入力を止めた後は、排出の上界の行（最初の空の行）が
// 出るか下界が 10 秒を超えるまで drain の ping を 250ms ごとに送って幅を狭め、それまで host を止めない（stop で tick が止まる）。
// 30 秒で出なければ止めて未確認に残す。
function e07Window(ctx, load) {
  const minutes = ctx.counts.e07Minutes ?? 60;
  const c = ctx.initialState.cycleC;
  const id = `e07-${load}`;
  return {
    id, expectedMin: minutes + (load === "C" ? 8 + EXPIRY_WAIT_LIMIT_MS / 60_000 : 2),
    run: async (w) => {
      const host = await openHost(w, ctx);
      const filled = load === "C" ? await fill(host, w, ctx, "cycleC") : null;
      if (filled != null) await waitFillExpiry(host, w, filled);
      w.progress.phase = "measure";
      const startHr = hrMs() + 1000;
      const [fromMs, fromWallMs] = [host.hostMs(startHr), host.wallMs(startHr)];
      const windowMs = minutes * 60_000;
      if (load === "C") {
        const cycles = Math.floor(windowMs / c.periodMs);
        w.progress.total = cycles;
        for (let k = 0; k < cycles; k++) {
          const cycleStart = startHr + k * c.periodMs;
          for (const [i, f] of cycleCFrames(k, host.wallMs(cycleStart)).entries()) {
            const frame = dataFrame(f.headType, f.xml);
            await waitUntil(host, cycleStart + f.offsetMs);
            if (i === 0 && k > 0 && !host.injector.ping("boundary")) throw new Error("boundary ping not sent: injector not connected");
            host.send(frame);
          }
          w.progress.trialsStarted = k + 1;
        }
        await waitUntil(host, startHr + cycles * c.periodMs);
        if (!host.injector.ping("boundary")) throw new Error("boundary ping not sent: injector not connected");
      } else {
        const pump = replayPump(ctx.manifest.loads[load], host.send, host.wallSec, startHr);
        await waitUntil(host, startHr + windowMs, pump);
      }
      w.progress.phase = "drain";
      const lastInputId = `input-${host.sent()}`;
      // 排出の幅が決まるまで drain の ping を送り、決まったら ping の送出を止めて、送った全 ping（周期・boundary・drain）の行が出るまで
      // host を止めない（ping の行と送出の列を 1 対 1 で照らすので、1 つでも落ちると①が未確認になる）。待ちは各 30 秒・10 秒まで。
      const pingRows = () => host.lines.filter((l) => l.t === "obs" && l.o.kind === "mailbox" && l.o.trigger === "ping").length;
      const giveUp = hrMs() + 30_000;
      for (;;) {
        host.check();
        host.refresh();
        const t0 = host.lines.find((l) => l.t === "obs" && l.o.kind === "marker" && l.o.point === "T0" && l.o.inputId === lastInputId)?.o.monotonicMs;
        const bounds = t0 == null ? null : drainBounds(host.lines, t0);
        if ((bounds != null && (bounds.upperMs != null || bounds.lowerMs > t0 + 10_000)) || hrMs() > giveUp) break;
        host.injector.ping("drain");
        await sleep(250);
      }
      host.injector.stopPings();
      const pingWait = hrMs() + 10_000;
      while (pingRows() < host.injector.pingKinds.length && hrMs() < pingWait) { host.check(); await sleep(50); host.refresh(); }
      const pingsUnreceived = host.injector.pingKinds.length - pingRows();
      await host.stop();
      const records = host.records();
      const diagnostics = diagnosticFiles(w.dir).flatMap((f) => readJsonl(f));
      const e07 = summarizeE07(records, { pingKinds: host.injector.pingKinds, warmupCycles: load === "C" ? c.warmupCycles : 0, lastInputId,
        diagnostics, fromMs, fromWallMs });
      const reports = hostReports(records, id, w.dir, host.injector.placeOf);
      // 送った ping の行が揃わないまま止めた窓は、ping に依らない Fail 以外を未確認にする。
      const status = pingsUnreceived > 0 && e07.status !== "Fail" ? "未確認" : e07.status;
      const o = outcome(ctx, status, reports, { fill: filled?.record ?? null, pingsUnreceived });
      o.resultFiles = [sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: o.status, minutes, e07, pingsUnreceived, fill: filled?.record ?? null, ...reports })];
      return o;
    },
  };
}

// ── E14（P3-C4-AC13(3)、P3-C4-E14-WINDOW=A）: P の充填の後、背景の負荷なしで 3 unit の更新を 1 束で intervalMs ごとに送る ──
// 束は充填の current の失効を待ってから始める（P3-MH-FULL-STATE=D）。
// 束 k の 3 入力（①）。E14 の窓だけが使う規則なのでここで組む。どれも充填済みの
// subject の更新で、新しい subject を足さない: VXSE45 は充填の通常の EventID（frames.mjs の 20240417000000＋i）の k 番目を Serial＋1・
// 訂正・報告時刻＝束の時刻で（新しい EventID は U-E の 512 件で capacityExceeded になる。U-E の保存対象は通知の記録だけなので、通知済みの
// EventID の Serial だけを進めた続報は世代を上げず、訂正なら通知の機会ができて毎回世代が上がる、工程2c）、VPWS50 は national（通常）を、
// VPWP50 は充填の官署0 の subject を 81_09_01 で、どちらも全時刻を束の時刻へ移して更新する（束ごとに新しくなる）。
const E14_EVENT_BASE = 20240417000000;
const reportAt = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)[1]);
const jstAt = (ms) => `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
export function e14BundleFrames(k, atWallMs) {
  const text = (name) => fixtureText(name).toString("utf8");
  const eew = text(FIX.vxse45).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${E14_EVENT_BASE + k}</EventID>`)
    .replace(/<Serial>(\d+)<\/Serial>/, (_, serial) => `<Serial>${Number(serial) + 1}</Serial>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${jstAt(atWallMs)}</ReportDateTime>`).replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${new Date(atWallMs).toISOString().slice(0, 19)}Z</DateTime>`) // P3-VM-AC03: 送信の時刻（Control/DateTime）も束の時刻へ
    .replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
  const national = text(FIX.vpws50);
  const forecast = text(FIX.vpwp50Large).replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, "<EditorialOffice>官署0</EditorialOffice>");
  return [{ unit: "U-E", headType: "VXSE45", xml: eew }, { unit: "U-W", headType: "VPWS50", xml: shiftTimestamps(national, atWallMs - reportAt(national)) },
    { unit: "U-F", headType: "VPWP50", xml: shiftTimestamps(forecast, atWallMs - reportAt(forecast)) }];
}
// P3-C6-AC08 ④（C5 から引き継いだ U-E と U-T の同時 dirty の確かめ）: 予備の --e14-tsunami で、束ごとに VTSE41（template の版を進めた報。
// 大津波警報と津波警報を交互に、同じ EventID・報告時刻＝束の時刻の秒）を足す。新しい subject は最初の束の 1 つだけ。
export function e14TsunamiFrame(k, atWallMs) {
  return { unit: "U-T", headType: "VTSE41", xml: tsunamiReport(k % 2 === 0 ? "synthetic_VTSE41_e01_311major" : "synthetic_VTSE41_e01_311warning",
    { eventId: "20261009069999", reportAtMs: Math.floor(atWallMs / 1000) * 1000 }) };
}
// ③ 束は予定時刻に送り、前の束の保存を待たない（起点は束の入力の generationRaised なので、前の束の残りは束の起点にならない）。最後の束は
// intervalMs まで成功を待ってから止める。通知の backend は silent に固定する（訂正で束ごとに通知が出るが、この窓は保存の dirty→ack を測り、
// 通知を判定しない、AC13(3)）。
function e14Window(ctx, run) {
  const a = ctx.manifest.auxiliary.E14;
  const count = ctx.counts.e14 ?? a.minSamplesPerRun;
  const id = `e14-run${run}`;
  return {
    id, expectedMin: Math.ceil((count * a.intervalMs + EXPIRY_WAIT_LIMIT_MS) / 60_000) + 6,
    run: async (w) => {
      const host = await openHost(w, { ...ctx, notification: "silent" });
      const filled = await fill(host, w, ctx, "leaveRoomForP");
      await waitFillExpiry(host, w, filled);
      w.progress.phase = "measure";
      w.progress.total = count;
      // 索引は追記の分だけ更新する（待ちの判定ごとに全行を作り直さない）。
      const index = e14Index([]);
      const saved = (bundle) => { host.refresh(); e14Index(host.lines, index); return e14Acks(index, bundle).every((ack) => ack != null); };
      const startHr = hrMs() + 1000;
      const bundles = [];
      for (let k = 0; k < count; k++) {
        const due = startHr + k * a.intervalMs;
        const frames = [...e14BundleFrames(k, host.wallMs(due)), ...(ctx.counts.e14Tsunami === true ? [e14TsunamiFrame(k, host.wallMs(due))] : [])]
          .map((f) => ({ unit: f.unit, frame: dataFrame(f.headType, f.xml) }));
        await waitUntil(host, due);
        const inputIds = {};
        for (const f of frames) inputIds[f.unit] = `input-${host.send(f.frame).seq}`;
        // Q-MH-E14=B: UWR の後は U-E が約 30ms で保存まで終え、大きな U-W・U-F の parse（約 300ms）と重ならないので、重なりは書込み権を
        // 取り合う U-W・U-F で見る（U-E の dirty→ack は summarizeE14 が重なりの条件なしで別に出す）。C6 の --e14-tsunami は U-E と U-T の組。
        bundles.push({ k, inputIds, overlapUnits: ctx.counts.e14Tsunami === true ? ["U-E", "U-T"] : ["U-W", "U-F"] });
        w.progress.trialsStarted = k + 1;
      }
      const until = hrMs() + a.intervalMs;
      while (bundles.length > 0 && !saved(bundles.at(-1)) && hrMs() < until) { host.check(); await sleep(200); }
      await host.stop();
      const records = host.records();
      const e14 = summarizeE14(records, { bundles });
      const reports = hostReports(records, id, w.dir, host.injector.placeOf);
      const o = outcome(ctx, e14.status ?? "N/A", reports, { fill: filled.record });
      o.resultFiles = [sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: o.status, intervalMs: a.intervalMs, notification: "silent", e14, bundles,
        fill: filled.record, ...reports })];
      return o;
    },
  };
}

// 窓の並び（設計メモ §1.2: E02+E05 N → P、E03、AC15、E12、E06、E07）。ctx.runs は run 数の上書き（予備）。E07 は P3 の manifest にだけある。
export function auxWindows(ctx) {
  const runs = (n) => Array.from({ length: ctx.runs ?? n }, (_, i) => i + 1);
  return [
    ...ctx.manifest.health.loads.flatMap((load) => runs(ctx.manifest.health.runCount).map((run) => e02Window(ctx, load, run))),
    ...runs(ctx.manifest.auxiliary.E03.runCount).map((run) => e03Window(ctx, run)),
    ac15Window(ctx),
    ...runs(ctx.manifest.auxiliary.E12.runCount).flatMap((run) => Object.keys(E12_CLASSES).map((cls) => e12Window(ctx, cls, run))),
    e06Window(ctx),
    ...(ctx.manifest.auxiliary.E07?.loads ?? []).map((load) => e07Window(ctx, load)),
    ...(ctx.manifest.auxiliary.E14 == null ? [] : runs(ctx.manifest.auxiliary.E14.runCount).map((run) => e14Window(ctx, run))),
    ...(ctx.manifest.auxiliary.ownerHeap == null ? [] : runs(ctx.manifest.auxiliary.ownerHeap.runCount).map((run) => ownerHeapWindow(ctx, run))),
    // P3-E05C-AC04(2): 分類の窓は、manifest の contractSha256 に本契約の鍵があるか予備のときだけ（今の凍結 manifest の並びは変わらない）。
    // id は e02- で始めない（e02Verdict が E02 の判定に入れない）。
    ...(ctx.preliminary || ctx.manifest.contractSha256?.[E05C_CONTRACT] != null
      ? ["observe", "gc"].flatMap((mode) => runs(E05C.runs).map((run) => e02Window(ctx, "P", run, mode))) : []),
    // P3-E05Y-AC03: 上乗せの窓も、manifest の contractSha256 に P3-E05P-TYPHOON-001 の鍵があるか予備のときだけ。分類の窓の後に並べる。
    ...(ctx.preliminary || ctx.manifest.contractSha256?.[E05Y_CONTRACT] != null ? runs(E05Y.runs).map((run) => e02Window(ctx, "P", run, E05Y.mark)) : []),
    // P3-E05S-AC03: 補助の窓も、manifest の contractSha256 に P3-E05Y-SPLIT-001 の鍵があるか予備のときだけ。上乗せの窓の後に、run ごとに対照を先に並べる。
    ...(ctx.preliminary || ctx.manifest.contractSha256?.[E05S_CONTRACT] != null ? runs(E05S.runs).flatMap((run) => [E05S.p, E05S.y].map((mark) => e02Window(ctx, "P", run, mark))) : []),
  ];
}

// ── P3-E05P-CLASSIFY-001 の分類の窓（e02Window の P の経路に preload と区切りの GC を足す、P3-E05C-AC04） ──
// 値は作者裁定 P3-E05C-THRESHOLD・GC-CAP・RUN-SPLIT（どれも A）で、結果に写す。c4 は C4 の E05-P の測定の窓の tick の値（P3-E05C-MATERIAL(7)(8)、
// repo の外の材料から）で、開始の最小（start）と 300 秒以後の平ら（flat）。sampleEveryMs は preload の固定の間隔。
const E05C_CONTRACT = "P3-E05P-CLASSIFY-001";
const MIB = 1024 * 1024;
const E05C = { gc: { thresholdBytes: 380 * MIB, rearmBelowBytes: 330 * MIB, maxForced: 20, baselineEveryMs: 60_000 }, sampleEveryMs: 200, runs: 2,
  c4: { start: { publisher: 21.8 * MIB, urgent: 8.9 * MIB, weatherCurrent: 14.5 * MIB, deferred: 9.6 * MIB },
    flat: { publisher: 22.5 * MIB, urgent: 9.5 * MIB, weatherCurrent: 16.9 * MIB, deferred: 10.0 * MIB } } };

// e02Window の host の起動。分類の窓は preload（GC の run は --expose-gc と FLEQ_MEM_GC も）を足し、GC の run は充填の前の区切りの GC を済ませる。
// probe.beforeMeasure は静まりの後・E02 の client の起動の前の区切りの GC（観測だけの run には SIGUSR2 を送らない）。
async function openE02Host(w, ctx, classify) {
  if (classify == null || classify === E05Y.mark) return { host: await openHost(w, ctx, { memEveryMs: E05_MEM_EVERY_MS }), probe: null };
  const gc = classify === "gc";
  const memOut = join(w.dir, "mem");
  const host = await openHost(w, ctx, { memEveryMs: E05_MEM_EVERY_MS, nodeArgs: [...(gc ? ["--expose-gc"] : []), "--import", PROBE_PRELOAD],
    env: { FLEQ_MEM_OUT: memOut, ...(gc ? { FLEQ_MEM_GC: JSON.stringify(E05C.gc) } : {}) } });
  const phase = gc ? phaseGc(host, ctx, memOut) : null;
  const probe = { gc, memOut, phaseWaits: phase == null ? null : [await phase(1)], beforeMeasure: async () => { if (phase != null) probe.phaseWaits.push(await phase(2)); } };
  return { host, probe };
}

// 区切りの GC（AC04(3)）。host へ SIGUSR2 を送り、4 thread の phase の行が n 個ずつ出るまで最大 10 秒、preload の file の追記分だけを見て待つ。
// 揃わなくても進める（欠けた thread の AC03(4) の値は集計で null になる）。
function phaseGc(host, ctx, memOut) {
  const tails = E12_THREADS.map((place) => ({ place, tail: ctx.tailer(`${memOut}.${place}.jsonl`), seen: 0, phases: 0 }));
  return async (n) => {
    const started = hrMs();
    process.kill(host.pid, "SIGUSR2");
    for (;;) {
      host.check();
      for (const t of tails) {
        t.tail.refresh();
        for (; t.seen < t.tail.lines.length; t.seen++) if (t.tail.lines[t.seen].k === "forcedGc" && t.tail.lines[t.seen].reason === "phase") t.phases += 1;
      }
      const missing = tails.filter((t) => t.phases < n).map((t) => t.place);
      if (missing.length === 0 || hrMs() - started > 10_000) return { n, waitedMs: Math.round(hrMs() - started), missing };
      await sleep(100);
    }
  };
}

// AC04(4)(5): preload の file を窓の終わりに 1 回だけ 1 行ずつ読み、AC03 の分類を aux-e05c の 1 つに封じる（result-e02・aux-e05 は書かない）。
// E02・E05 は報告だけ。窓の status は、4 thread の行があり、publisher の最後の行が測定の終わり（E02 の client の end の行）−1,000ms 以後、owner の
// written が終わり−500ms 以後で、GC の run では gcAvailable が 4 thread とも真なら N/A、そうでなければ未確認。
async function e05cOutcome(ctx, w, id, probe, { records, start, end, health, e05, reports, expiry, fill }) {
  const { gc, memOut, phaseWaits } = probe;
  const rows = {};
  for (const place of E12_THREADS) rows[place] = existsSync(`${memOut}.${place}.jsonl`) ? await readProbeRows(`${memOut}.${place}.jsonl`) : [];
  const written = Object.fromEntries(E12_THREADS.filter((p) => p !== "publisher")
    .map((p) => [p, existsSync(`${memOut}.${p}.written`) ? Number(readFileSync(`${memOut}.${p}.written`, "utf8")) : null]));
  const fromMs = hostMsOf(records, start.hrtimeNs);
  const toMs = hostMsOf(records, end.hrtimeNs);
  const classification = fromMs == null || toMs == null ? null
    : classifyE05cRun(rows, { ...E05C.gc, gcRun: gc, measureFromMs: fromMs, measureToMs: toMs, c4: E05C.c4, phaseMissing: phaseWaits?.map((x) => x.missing) ?? null });
  const complete = classification != null && E12_THREADS.every((p) => classification.threads[p].rows > 0)
    && (classification.threads.publisher.lastMs ?? -Infinity) >= toMs - 1000 && Object.values(written).every((at) => at != null && at >= toMs - 500)
    && (!gc || E12_THREADS.every((p) => classification.threads[p].gcAvailable === true));
  const o = outcome(ctx, complete ? "N/A" : "未確認", reports, { fill, expirySplit: expiry });
  o.resultFiles = [sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: o.status, contractId: E05C_CONTRACT,
    constants: { ...E05C.gc, forcedGcEnabled: gc, sampleEveryMs: E05C.sampleEveryMs, runs: E05C.runs, c4: E05C.c4 },
    note: "E02・E05 は報告だけで判定しない（P3-E05C-AC04(4)）。GC の run の E02・E05 は山を GC で切った値で、E05-P と比べない（AC02）",
    measureHostMs: { fromMs, toMs }, written, phaseWaits, e05, e02: health, expirySplit: expiry, fill, classification })];
  return o;
}

// ── P3-E05P-TYPHOON-001 の上乗せの窓（e02Window の P の経路に確率の報 VPTA50 を 1 周ごとに 3 通足す、P3-E05Y-AC01〜AC03） ──
// 値は作者裁定 P3-E05Y-FREQ・PLACE・CONTROL（どれも A）。mark は e02Window の第 4 引数の印（分類の窓の mode と区別する）。
// peakOffsetMs は負荷 P の VPWS50 で、上乗せの後の山の区間の終わりの基準（AC05(2)）。
const E05Y_CONTRACT = "P3-E05P-TYPHOON-001";
const E05Y = { mark: "typhoon", runs: 3, peakOffsetMs: 305_612, afterPeakMs: 15_000, maxDelayMs: 1000 };
export const E05Y_LOAD = replayLoad("P-typhoon", { windowMs: 360_000, events: [["76_01_01_200630_VPTA50", 300_121], ["76_01_02_260531_VPTA50", 302_121],
  ["76_01_03_260602_VPTA50", 304_121]].map(([fixture, offsetMs]) => ({ fixture, offsetMs })) }, 1);

// AC01: 上乗せを負荷の列に offset の昇順で混ぜ、1 つの cursor で送る（2 本の pump は呼び出しが遅れると負荷の後の入力が上乗せより先に出る）。
// 同じ offset は負荷が先（安定な sort）。周期は負荷の durationMs なので、違えば上乗せが負荷の別の位置に重なる。
function mergedEvents(load, extra) {
  if (extra.durationMs !== load.durationMs) throw new Error(`load ${extra.id}: durationMs ${extra.durationMs} differs from load ${load.id} (${load.durationMs})`);
  return [...loadEvents(load), ...loadEvents(extra).map((e) => ({ ...e, extra: true }))].sort((a, b) => a.offsetMs - b.offsetMs);
}

// AC02(2)・AC06④: 上乗せの窓の P の pump（測定の間に呼ぶのはこれ 1 本）。send は host.send を包んで返り値をそのまま返し、上乗せの入力と
// 周ごとの VPWS50（区間の終わりの基準）の入力を拾う。列の順に送るので、上乗せの k 番目の送りは周 floor(k / 3) の (k mod 3) 通目。
// extra が null の pump は上乗せの無い P（P3-E05S-AC01(3) の対照 e05s-p。null は replayPump の第 5 引数の既定と同じで、素の P を送る）で、同じ startHr と VPWS50 の拾いを使う。
function e05yPump(ctx, host, extra = E05Y_LOAD) {
  const load = ctx.manifest.loads.P;
  const startHr = hrMs();
  const sent = [];
  const peaks = [];
  const send = (frame, event) => {
    const r = host.send(frame);
    if (event.extra) sent.push({ inputId: `input-${r.seq}`, injectedHrMs: r.injectedHrMs });
    else if (event.offsetMs === E05Y.peakOffsetMs) peaks.push(`input-${r.seq}`);
    return r;
  };
  return { load, extra, startHr, sent, peaks, pump: replayPump(load, send, host.wallSec, startHr, extra) };
}

// AC02(3)(4)(6): 記録を 1 回なめて（P3-E05Y-RES-02）、上乗せの入力ごとの待ち・処理・decode と成立の確かめ、周ごとの VPWS50 の処理の終わり、
// mem 行・deferred の ownerHeap・processing の行を拾う（e05yOutcome と e05sOutcome が共有する）。確かめの期待の集合は予定（startHr＋周×durationMs
// ＋offset）から作るので、送られなかった入力も欠けとして数える。上乗せの無い pump では期待の集合を作らない。
function overlayScan(host, typhoon, records, fromMs, toMs) {
  const { ordering, offsetsMs, durationMs } = E05Y_LOAD;
  const n = offsetsMs.length;
  const scheduledHostMs = (k) => host.hostMs(typhoon.startHr + Math.floor(k / n) * durationMs + offsetsMs[k % n]);
  let total = typhoon.sent.length;
  while (typhoon.extra != null && toMs != null && scheduledHostMs(total) <= toMs) total += 1;
  const inside = (at) => at != null && fromMs != null && toMs != null && at >= fromMs && at <= toMs;
  const rows = Array.from({ length: total }, (_, k) => {
    const s = typhoon.sent[k];
    const due = scheduledHostMs(k);
    const sentHostMs = s == null ? null : host.hostMs(s.injectedHrMs);
    return { inputId: s?.inputId ?? null, fixture: ordering[k % n], cycle: Math.floor(k / n), scheduledHostMs: due, sentHostMs,
      delayMs: sentHostMs == null ? null : sentHostMs - due, scheduledInMeasure: inside(due), sentInMeasure: inside(sentHostMs),
      waitMs: null, processingMs: null, processingEndHostMs: null, decodeMs: null, generationRaisedHostMs: null };
  });
  const byId = new Map(rows.filter((r) => r.inputId != null).map((r) => [r.inputId, { row: r, t1: null, t2: null }]));
  const peakEnds = new Map(typhoon.peaks.map((p) => [p, null]));
  const mem = [];
  const heap = [];
  const processing = [];
  for (const r of records) {
    if (r.t === "mem") { mem.push(r); continue; }
    const o = r.t === "obs" ? r.o : null;
    if (o == null) continue;
    if (o.kind === "ownerHeap") { if (o.replyKind === "deadlineDone" && o.place === "deferred") heap.push(o); continue; }
    const inputId = o.kind === "processing" ? o.measurement.inputId : o.inputId;
    if (o.kind === "processing") processing.push(o.measurement);
    if (o.kind === "processing" && peakEnds.has(inputId)) peakEnds.set(inputId, o.measurement.endedMonotonicMs);
    const hit = byId.get(inputId);
    if (hit == null) continue;
    if (o.kind === "marker" && o.point === "T1") hit.t1 = o.monotonicMs;
    else if (o.kind === "marker" && o.point === "T2") hit.t2 = o.monotonicMs;
    else if (o.kind === "processing") [hit.row.processingMs, hit.row.processingEndHostMs] = [o.measurement.endedMonotonicMs - o.measurement.startedMonotonicMs, o.measurement.endedMonotonicMs];
    else if (o.kind === "decode") hit.row.decodeMs = o.endedMonotonicMs - o.startedMonotonicMs;
    else if (o.kind === "generationRaised" && o.unit === "U-Y") hit.row.generationRaisedHostMs = o.monotonicMs;
  }
  for (const { row, t1, t2 } of byId.values()) row.waitMs = t1 == null || t2 == null ? null : t2 - t1;
  const checked = rows.filter((r) => r.scheduledInMeasure);
  const missing = checked.flatMap((r) => {
    const lacks = [[r.inputId != null, "sent"], [r.sentInMeasure, "sentInMeasure"], [r.delayMs != null && r.delayMs <= E05Y.maxDelayMs, "delay"],
      [r.generationRaisedHostMs != null && r.generationRaisedHostMs <= toMs, "generationRaised"], [r.processingEndHostMs != null && r.processingEndHostMs <= toMs, "processingEnd"]]
      .flatMap(([ok, name]) => (ok ? [] : [name]));
    return lacks.length === 0 ? [] : [{ inputId: r.inputId, cycle: r.cycle, fixture: r.fixture, lacks }];
  });
  const reason = fromMs == null || toMs == null ? "clockUnavailable" : checked.length === 0 ? "noOverlayInMeasure" : missing.length > 0 ? "overlayIncomplete" : null;
  return { rows, peakEnds, mem, heap, processing,
    check: { passed: reason == null, reason, checked: checked.length, excludedOutsideMeasure: rows.length - checked.length, missing } };
}

// AC02(3)(4)(6): 上乗せの入力ごとの待ち・処理・decode、区間ごとの最大、成立の確かめを aux-e05y の 1 つに封じる。
// 窓の status（run の判定）は確かめが通れば生の E05、通らなければ未確認。statuses.E05 は生の E05。
function e05yOutcome(ctx, w, id, typhoon, { host, records, start, end, health, e05, reports, expiry, fill }) {
  const fromMs = hostMsOf(records, start.hrtimeNs);
  const toMs = hostMsOf(records, end.hrtimeNs);
  const { rows, peakEnds, mem, heap, check } = overlayScan(host, typhoon, records, fromMs, toMs);
  const { ordering, offsetsMs, durationMs } = E05Y_LOAD;
  const n = offsetsMs.length;
  const intervals = [];
  for (let c = 0; c * n < rows.length && rows[c * n].sentHostMs != null; c++) {
    const peakEnd = peakEnds.get(typhoon.peaks[c]) ?? null;
    const sides = new Set(rows.slice(c * n, c * n + n).filter((r) => r.sentHostMs != null).map((r) => (r.sentHostMs < expiry.expiryHostMs ? "before" : "after")));
    intervals.push({ cycle: c, fromHostMs: rows[c * n].sentHostMs, toHostMs: peakEnd == null ? null : peakEnd + E05Y.afterPeakMs, peakInputId: typhoon.peaks[c] ?? null,
      fillExpiry: sides.size === 1 ? [...sides][0] : "straddles" });
  }
  const memTop = spanMaxima(mem, (r) => r.perfNowMs, (r) => r.rss, fromMs, toMs, intervals);
  const heapTop = spanMaxima(heap, (o) => o.monotonicMs, (o) => o.heapUsedBytes, fromMs, toMs, intervals);
  const heapOf = (h) => (h == null ? null : { heapUsedBytes: h.heapUsedBytes, externalBytes: h.externalBytes, monotonicMs: h.monotonicMs });
  intervals.forEach((i, k) => Object.assign(i, { maxRssBytes: memTop.spans[k]?.rss ?? null, maxRssAtHostMs: memTop.spans[k]?.perfNowMs ?? null, deferredHeapMax: heapOf(heapTop.spans[k]) }));
  const peak = memTop.measure;
  const maxRss = peak == null ? null : { rssBytes: peak.rss, perfNowMs: peak.perfNowMs, sinceMeasureStartMs: peak.perfNowMs - fromMs,
    intervalCycle: intervals.find((i) => i.toHostMs != null && peak.perfNowMs >= i.fromHostMs && peak.perfNowMs <= i.toHostMs)?.cycle ?? null };
  const runStatus = check.reason == null ? e05.status : "未確認";
  const o = outcome(ctx, runStatus, reports, { fill, expirySplit: expiry,
    ...(ctx.preliminary ? { statuses: { E05: "未確認" }, judgedStatuses: { E05: e05.status } } : { statuses: { E05: e05.status } }) });
  o.resultFiles = [sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: o.status, contractId: E05Y_CONTRACT, rawE05Status: e05.status,
    check,
    note: "E02 は報告だけ（P3-E05Y-AC02(3)）。時刻は host の時計。waitMs は T2−T1、processingMs は processing の始まりから終わり（返信の待ち・射影・publish を含む）、decodeMs は decode の行。maxRss.intervalCycle が null は区間外",
    overlay: { id: E05Y_LOAD.id, ordering, offsetsMs, durationMs, sha256: E05Y_LOAD.sha256 }, measureHostMs: { fromMs, toMs },
    inputs: rows, withoutProcessing: rows.filter((r) => r.inputId != null && r.processingMs == null).length, intervals,
    allBundlesAfterExpiry: intervals.length > 0 && intervals.every((i) => i.fillExpiry === "after"), maxRss,
    deferredHeapInMeasure: heapOf(heapTop.measure), e05, e02: health, expirySplit: expiry, fill, ...reports })];
  return o;
}

// 測定の窓と区間ごとの最大の要素（AC02(4)・AC05(2)、P3-E05Y-RES-02）: list を 1 回なめ、標本ごとに入る区間のすべてに足す（区間は多くて
// 3 つで線形）。区間の終わりは VPWS50 の処理の終わり＋15 秒で、処理が遅れると次の束の始まりを越えて重なりうる。終わりの無い区間は最大を出さない。
function spanMaxima(list, at, value, fromMs, toMs, spans) {
  const keep = (m, x) => (m == null || value(x) > value(m) ? x : m);
  const out = { measure: null, spans: spans.map(() => null) };
  for (const x of list) {
    const t = at(x);
    if (fromMs != null && toMs != null && t >= fromMs && t <= toMs) out.measure = keep(out.measure, x);
    spans.forEach((s, k) => { if (s.toHostMs != null && t >= s.fromHostMs && t <= s.toHostMs) out.spans[k] = keep(out.spans[k], x); });
  }
  return out;
}

// ── P3-E05Y-SPLIT-001 の補助の窓（e02Window の P の経路に分類の窓の probe を足す。上乗せの e05s-y と対照の e05s-p、P3-E05S-AC01〜AC03） ──
// 値は作者裁定 P3-E05S-CONTROL・RUNS（A）と AC02 の定義。y・p は e02Window の第 4 引数の印で、id はそのまま <印>-run<k>（e02-・e05c-・e05y- で
// 始めない。e02Verdict と分類の窓・上乗せの窓の予備の並びの期待に入れないため）。印が null でも E05Y.mark でも "gc" でもないので、openE02Host が
// 観測だけの probe を付ける（P3-E05S-GC=A）。fromOffsetMs は上乗せの 1 通目の予定で、対照にも同じ時刻の区間を置く。
const E05S_CONTRACT = "P3-E05Y-SPLIT-001";
const E05S = { y: "e05s-y", p: "e05s-p", runs: 3, floorMs: 30_000, staleMs: 1000, fromOffsetMs: 300_121 };

// AC02(1)(6)(7): probe の file を窓の終わりに 1 回だけ 1 行ずつ読み、区間ごとの内訳を aux-<id> の 1 つに封じる（result-e02・aux-e05・aux-e05y・
// aux-e05c は書かない）。E02・E05 は報告だけで、status にも statuses にも出さない。区間の status は窓の status を変えない（判定は AC05 の S0）。
async function e05sOutcome(ctx, w, id, probe, { host, records, start, end, health, e05, reports, expiry, fill, typhoon }) {
  const rows = {};
  for (const place of E12_THREADS) rows[place] = existsSync(`${probe.memOut}.${place}.jsonl`) ? await readProbeRows(`${probe.memOut}.${place}.jsonl`) : [];
  const written = Object.fromEntries(AC15_OWNERS.map((p) => [p, existsSync(`${probe.memOut}.${p}.written`) ? Number(readFileSync(`${probe.memOut}.${p}.written`, "utf8")) : null]));
  const fromMs = hostMsOf(records, start.hrtimeNs);
  const toMs = hostMsOf(records, end.hrtimeNs);
  const { rows: inputs, peakEnds, mem, processing, check } = overlayScan(host, typhoon, records, fromMs, toMs);
  const inside = (at) => at >= fromMs && at <= toMs;
  // 区間の始まりは予定時刻（上乗せの無い対照とそろえる）、終わりはその周の VPWS50 の処理の終わり＋15,000ms。始まりが測定の窓の中で、終わりが
  // null か測定の窓の中の区間だけを出す。
  const spans = [];
  for (let c = 0; fromMs != null && toMs != null; c++) {
    const fromHostMs = host.hostMs(typhoon.startHr + c * typhoon.load.durationMs + E05S.fromOffsetMs);
    if (fromHostMs > toMs) break;
    const peakEndHostMs = peakEnds.get(typhoon.peaks[c]) ?? null;
    const toHostMs = peakEndHostMs == null ? null : peakEndHostMs + E05Y.afterPeakMs;
    if (!inside(fromHostMs) || (toHostMs != null && !inside(toHostMs))) continue;
    const sides = new Set([fromHostMs, toHostMs ?? fromHostMs].map((at) => (at < expiry.expiryHostMs ? "before" : "after")));
    spans.push({ cycle: c, fromHostMs, toHostMs, peakInputId: typhoon.peaks[c] ?? null, peakEndHostMs, fillExpiry: sides.size === 1 ? [...sides][0] : "straddles" });
  }
  const starts = processing.map((m) => ({ place: host.injector.placeOf(m.inputId), atMs: m.startedMonotonicMs, inputId: m.inputId }));
  const split = e05sSplit(rows, spans, { starts, mem, fromMs, toMs });
  const top = split.publisherMax;
  const maxRss = top == null ? null : { rssBytes: top.rss, atHostMs: top.atMs,
    spanCycle: split.spans.find((s) => s.toHostMs != null && top.atMs >= s.fromHostMs && top.atMs <= s.toHostMs)?.cycle ?? null };
  const overlaid = typhoon.extra != null;
  const complete = toMs != null && E12_THREADS.every((p) => split.threads[p].rows > 0) && (split.threads.publisher.lastMs ?? -Infinity) >= toMs - 1000
    && Object.values(written).every((at) => at != null && at >= toMs - 500) && split.spans.some((s) => s.cycle === 0)
    && (overlaid ? check.passed : typhoon.sent.length === 0);
  const o = outcome(ctx, complete ? "N/A" : "未確認", reports, { fill, expirySplit: expiry });
  o.resultFiles = [sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: o.status, contractId: E05S_CONTRACT,
    constants: { sampleEveryMs: E05C.sampleEveryMs, floorMs: E05S.floorMs, staleMs: E05S.staleMs, fromOffsetMs: E05S.fromOffsetMs, peakOffsetMs: E05Y.peakOffsetMs,
      afterPeakMs: E05Y.afterPeakMs, runs: E05S.runs, forcedGc: false },
    note: "E02・E05 は報告だけ（P3-E05S-AC02(7)）。時刻は host の時計（probe は publisher の基準）、値は byte。threads の U・V・X・A は heapUsed・heapTotal−heapUsed・external・arrayBuffers、residual は publisher の rss−4 thread のΣ(U＋V＋X)。deferredStatus は deferred の側だけの成否（AC02(5)）。gBytes は同じ区間の mem 行の最大−t_p の rss（0 未満は 0）で、0 より大きい区間は頂点の帰属が未確定。maxRss.spanCycle が null は区間外",
    measureHostMs: { fromMs, toMs }, threads: Object.fromEntries(E12_THREADS.map((p) => [p, { ...split.threads[p], writtenMs: written[p] ?? null }])),
    spans: split.spans.map((s) => ({ ...s, peakSinceMeasureStartMs: s.peak == null ? null : s.peak.atMs - fromMs,
      peakSincePeakEndMs: s.peak == null || s.peakEndHostMs == null ? null : s.peak.atMs - s.peakEndHostMs })),
    maxRss, e05, e02: health, expirySplit: expiry, fill,
    ...(overlaid ? { overlay: { id: E05Y_LOAD.id, ordering: E05Y_LOAD.ordering, offsetsMs: E05Y_LOAD.offsetsMs, durationMs: E05Y_LOAD.durationMs, sha256: E05Y_LOAD.sha256 },
      inputs, check } : { overlaySent: typhoon.sent.length }), ...reports })];
  return o;
}

// AC02(3)〜(5): 区間ごとの山 t_p と床 t_f の thread ごとの内訳。rows は thread ごとの probe の行（file の順で、mem 行は atMs の昇順）、spans は
// { fromHostMs, toHostMs } を含む列（toHostMs が null は VPWS50 の処理の終わりが無い区間。ほかの項目はそのまま返す）、starts は処理の始まり
// { place, atMs, inputId }、mem は host の mem 行（1 秒）。probe の行・starts・mem 行はそれぞれ 1 回なめる（P3-E05S-RES-02）。
export function e05sSplit(rows, spans, { starts = [], mem = [], fromMs = null, toMs = null } = {}) {
  const memRows = {};
  const gcRows = {};
  const threads = {};
  for (const p of E12_THREADS) {
    memRows[p] = [];
    gcRows[p] = [];
    let maxGapMs = null;
    for (const r of rows[p] ?? []) {
      if (r.k === "gc") gcRows[p].push(r);
      if (r.k !== "mem") continue;
      const prev = memRows[p].at(-1);
      if (prev != null) maxGapMs = Math.max(maxGapMs ?? 0, r.atMs - prev.atMs);
      memRows[p].push(r);
    }
    threads[p] = { rows: memRows[p].length, maxGapMs, lastMs: memRows[p].at(-1)?.atMs ?? null };
  }
  // 山は区間の中の rss の最大（同値は早い方）、床は始まりの前 30,000ms の最小（同値は遅い方＝始まりに近い方）。
  const tops = spans.map(() => ({ peak: null, floor: null }));
  let publisherMax = null;
  for (const r of memRows.publisher) {
    if (fromMs != null && toMs != null && r.atMs >= fromMs && r.atMs <= toMs && (publisherMax == null || r.rss > publisherMax.rss)) publisherMax = r;
    spans.forEach((s, k) => {
      const t = tops[k];
      if (s.toHostMs != null && r.atMs >= s.fromHostMs && r.atMs <= s.toHostMs && (t.peak == null || r.rss > t.peak.rss)) t.peak = r;
      if (r.atMs >= s.fromHostMs - E05S.floorMs && r.atMs < s.fromHostMs && (t.floor == null || r.rss <= t.floor.rss)) t.floor = r;
    });
  }
  // 時刻 t の thread の値は t 以前で最新の mem 行（二分探索。publisher はその行自身）。
  const latest = (list, t) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].atMs <= t) lo = mid + 1; else hi = mid; }
    return list[lo - 1] ?? null;
  };
  const valuesAt = (top) => (top == null ? null : Object.fromEntries(E12_THREADS.map((p) => {
    const r = latest(memRows[p], top.atMs);
    return [p, r == null ? null : { atMs: r.atMs, ageMs: top.atMs - r.atMs, U: r.heapUsed, V: r.heapTotal - r.heapUsed, X: r.external, A: r.arrayBuffers }];
  })));
  const points = tops.map(({ peak, floor }) => ({ peak: valuesAt(peak), floor: valuesAt(floor) }));
  // busy（AC02(4)）: owner の thread で、採った行の時刻より後〜t までに処理か GC が始まった。行の前に始まったものは、行がその後の値なので
  // 印を付けない（processing の終わりは publisher が返信を反映した時刻なので、終わりでは照らさない）。始まりごとに隙間（区間×2）と照らす。
  // thread ごとの始まりの列（owner は入力を 1 つずつ処理するので返信の順＝始まりの順）と GC の行（entry の発生の順）を時刻の順に合わせて
  // 1 回なめ、印の原因を時刻の順に残す（P3-E05S-RES-02）。
  const busy = spans.map(() => ({}));
  const mark = (place, atMs, cause) => {
    points.forEach((point, k) => {
      for (const side of ["peak", "floor"]) {
        const row = point[side]?.[place];
        if (row != null && atMs > row.atMs && atMs <= tops[k][side].atMs) (busy[k][place] ??= []).push({ side, atMs, ...cause });
      }
    });
  };
  const startsOf = Object.fromEntries(AC15_OWNERS.map((p) => [p, []]));
  for (const s of starts) startsOf[s.place]?.push(s);
  for (const p of AC15_OWNERS) {
    const [a, b] = [startsOf[p], gcRows[p]];
    for (let i = 0, j = 0; i < a.length || j < b.length;) {
      if (j >= b.length || (i < a.length && a[i].atMs <= b[j].atMs)) { mark(p, a[i].atMs, { inputId: a[i].inputId }); i += 1; }
      else { mark(p, b[j].atMs, { gc: b[j].kind }); j += 1; }
    }
  }
  const memTop = spanMaxima(mem, (r) => r.perfNowMs, (r) => r.rss, null, null, spans);
  const at = (r) => (r == null ? null : { atMs: r.atMs, rss: r.rss });
  // O は publisher の rss から 4 thread の U＋V＋X を引いた未説明の残差（nativeへの帰属は断定しない、P3-E05S-AC05(2)）。
  const residual = (values, top) => (values == null || Object.values(values).includes(null) ? null : top.rss - Object.values(values).reduce((a, v) => a + v.U + v.V + v.X, 0));
  return { threads, publisherMax: at(publisherMax), spans: spans.map((s, k) => {
    const { peak, floor } = tops[k];
    const point = points[k];
    const sides = [point.peak, point.floor].filter((v) => v != null);
    const rowsMissing = floor == null || (s.toHostMs != null && peak == null) || sides.some((v) => Object.values(v).includes(null));
    const stale = sides.some((v) => Object.values(v).some((x) => x != null && x.ageMs > E05S.staleMs));
    const status = rowsMissing ? "rowsMissing" : s.toHostMs == null ? "noPeakEnd" : stale ? "stale" : Object.keys(busy[k]).length > 0 ? "busy" : "ok";
    // deferredStatus（作者裁定 B、Q-E05S-PRELIM1）: S1 は deferred の値だけで決まるので、publisher の山・床の行と deferred の側だけを同じ順で見る。
    const deferred = sides.map((v) => v.deferred);
    const deferredStatus = floor == null || (s.toHostMs != null && peak == null) || deferred.includes(null) ? "rowsMissing" : s.toHostMs == null ? "noPeakEnd"
      : deferred.some((x) => x.ageMs > E05S.staleMs) ? "stale" : busy[k].deferred != null ? "busy" : "ok";
    const O = { peak: residual(point.peak, peak), floor: residual(point.floor, floor) };
    const memMax = memTop.spans[k];
    const gBytes = memMax == null || peak == null ? null : Math.max(0, memMax.rss - peak.rss);
    return { ...s, status, deferredStatus, peak: at(peak), floor: at(floor), eBytes: peak == null || floor == null ? null : peak.rss - floor.rss,
      threads: Object.fromEntries(E12_THREADS.map((p) => {
        const [a, b] = [point.peak?.[p] ?? null, point.floor?.[p] ?? null];
        return [p, { peak: a, floor: b, delta: a == null || b == null ? null : { U: a.U - b.U, V: a.V - b.V, X: a.X - b.X, A: a.A - b.A }, busy: busy[k][p] ?? [] }];
      })),
      residual: { ...O, delta: O.peak == null || O.floor == null ? null : O.peak - O.floor },
      memMax: memMax == null ? null : { rssBytes: memMax.rss, atHostMs: memMax.perfNowMs }, gBytes, peakAttribution: gBytes > 0 ? "未確定（取り逃し）" : null };
  }) };
}

// P3-E05Y-CONTROLDT-001: 上乗せの 3 通は平行移動の後に Control/DateTime も送った時刻の秒へ置く。無いと 02 と 03 が同じ秒になり、VPTA50 の 03 が held（typhoonRevisionConflict）になる。
function overlayFrame(name, headType, atWallMs) {
  const xml = fixtureText(name).toString("utf8");
  const moved = shiftTimestamps(xml, atWallMs - Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)[1]));
  return dataFrame(headType, Buffer.from(moved.replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${new Date(atWallMs).toISOString().slice(0, 19)}Z</DateTime>`)));
}
