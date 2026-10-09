// P3 E01（P3-E01-REACCEPT-001、P2-A10 の runner を拡張）の入口: node reconstruction/test/eew-e01/run.mjs --manifest <path> | --preliminary [options]
// 製品経路（ローカル WS → startP2Host → SSE → 実 Chrome）で EEW の T0→T6 を 6 母集団（manifest.populations）で測る。runner は入力の送出と証拠収集だけで、
// 製品の入力処理はここに持たない。E01 以外（E02/E03/E05/E06/E12/E15/費用・AC15）の窓は windows.mjs（auxWindows）が作り、E01 の後に並べる。
// 投入側は manifest.liveness.pingEveryMs ごとに ping を送り、frame 間隔の最大が maxFrameGapMs 以上の窓は Blocked（P3-C4-RUNNER-LIVENESS）。
// --manifest: verifyFrozenP3Manifest と起動時の確認を通った凍結 manifest だけを、窓を順に回す 1 本のループで走らせる。落ちた窓は Blocked と記録して次へ。
//   各 E01 窓は stopCondition（maxAttempts・maxDurationMs）に達したら Blocked。
//   --windows <id,...>: 前回 Blocked（または未実施）の窓だけを再実行する。結果は上書きせず -attempt<k> を付ける。
// --preliminary: A10 の凍結物を継承した案（draft.mjs の buildP3Manifest）で各母集団 1 run を走らせ、結果の status は必ず「未確認」。
//   --warmup <n>（20）・--samples <n>（100）・--max-attempts <n>・--max-minutes <n>・--only <母集団,...>・--collision-verdict A|B・--runs-root <dir>
//   --deadline-alternative: 母集団 5 の対象を Q-C4-ALT-CONDITION の候補（期限回収で起きた U-F 保存の encode 開始〜write 完了）にして成立率を見る
//   --save-lead-ms <n>（600）・--deadline-lead-ms <n>（2400）: 保存・期限回収の母集団で引き金を予測 tick より何 ms 前に送るか（AC09。Pi で成立する値を
//     予備で求めて渡す。負荷と periodMs は変えない）。この 3 つは予備の案の manifest（triggerLeadMs・span）に入り、runner はいつも manifest から
//     読む。正式（--manifest）では凍結した値だけを使う（P3-C4-AC13(1)）
//   --aux <id,...|all>: E01 の代わりに周辺の窓を件数を絞って回す（--e02-count/--e03-count/--ac15-count/--e12-count/--e06-cycles/--e07-minutes/
//     --e14-count/--owner-heap-count、各 1 run。E14 と ownerHeap は指定が無ければ manifest の件数）。
//   記録と結果は evidence-scratch（repo の外）に書く。
//   --backend-only（Pi 第 1 段、AC03(6)・AC09）: Chrome を起動せず、SSE の client 1 本で、試行の完了を自分の版の T4 の観測（10 秒で欠落）にする。
//     記録は T0〜T4 と保存・資源（run-record の backendTrials）。予定時刻どおりの投入は既存の replayPump。Pi では --node <Node 22 の path> を渡す。
//     Pi の /proc/pressure と vcgencmd は統合担当の shell の loop で同じ窓に取る（runner は持たない）。手順の例（Pi の作業複製で）:
//       npm ci --ignore-scripts && ./node_modules/.bin/tsc --project reconstruction/tsconfig.json
//       node reconstruction/test/eew-e01/run.mjs --preliminary --backend-only --node "$(command -v node)" --runs-root ~/p3-bench/runs \
//         --only maxVpws50ParseStarted,maxWeatherCheckpointEncodeStarted,maxForecastCheckpointSave,maxVpws50ReceivedThenEew --warmup 10 --samples 30
//     （30 件程度 × 3 回は --runs-root を変えずに 3 回。100 件未満の p99 は観測最大と書く、RES-07）
// 津波（P3-TSUNAMI-E01-001、C6）: --manifest に津波の凍結 manifest（schemaVersion p3-tsunami-e01-manifest-v1）を渡すと、同じ窓のループで 8 母集団 × 3 run の
//   E01 の窓だけを回す（周辺の窓は C4 の manifest の側）。予備は --preliminary --tsunami [--prime-lead-ms <n>]（tsunami.mjs の草案、各母集団 1 run）。
//   U-E と U-T の同時 dirty（AC08 ④）は C4 の草案の --preliminary --aux e14-run1 --e14-tsunami（E14 の束に VTSE41 を足し、U-E と U-T の組の重なりで見る）。
//   試行は prime → target の 2 報（P3-C6-TRIAL-RESET=A）、成立は establishTsunamiTrial、標本の組み立ては analysis.mjs の assembleTsunamiTrials。
// 注意: 正式の再開は、最初の窓の記録と commit（gitHead）・dist・runner の hash・機械を照合する。測定用の checkout で途中に commit すると
// gitHead が変わって再開が拒否される（evidence の下の記録は commit せずに置いておく）。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import { basename, join, relative } from "node:path";
import { WebSocketServer } from "ws";

import { analyzeTrace, assembleP3Trials, assembleTsunamiTrials, buildHostIndex, correspondences, rejectionReasons, versionKey } from "./analysis.mjs";
import { chromeVersion, hrMs, openPage, probeClock, sleep, startTracing, stopTracing } from "./chrome.mjs";
import { A10_MANIFEST, DEFAULT_LEAD_MS, SEQUENCES_FILE, SMOKE_FILE, buildP3Manifest, contractTextsFor } from "./draft.mjs";
import { REPO, dataFrame, eewVariant, eventIdOf, fixtureId, fixtureText, sha256Hex, shiftTimestamps, weatherFrame } from "./frames.mjs";
import { RELEASE_FIXTURE, T6_TSUNAMI, C4_MANIFEST, buildP3TsunamiManifest, templateFixtureTexts, tsunamiReport, vxse45Variant } from "./tsunami.mjs";
import { auxWindows, e02Verdict, hostReportsOf, replayPump, seal, sealAux } from "./windows.mjs";

import { canonicalCoastJson } from "../../dist/chrome-eew/src/display/chrome-eew/coast.js";
import { classifyEewCause, establishTrial, establishTsunamiTrial, quantiles, summarizeP3E01, summarizeP3TsunamiE01, transitionQuotas } from "../../dist/src/measurement/eew-e01/judge.js";
import { ZERO_HASH, forecastWithinAllowance, sealSelfHash, verifyFrozenP3Manifest, verifyFrozenP3TsunamiManifest } from "../../dist/src/measurement/eew-e01/frozen.js";
import { placeOfHeadType } from "../../dist/src/runtime/unit-coverage.js";

const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const RUNS_ROOT = join(homedir(), "dev/fleq-a10-runs");
const EVIDENCE_DIR = join(REPO, "reconstruction/test/eew-e01/evidence");
const T6C = "fleq:p2:eew:T6-candidate";
const TSUNAMI_SCHEMA = "p3-tsunami-e01-manifest-v1";
const POP_CODE = { fixedBacklog: 0, maxVpws50ParseStarted: 1, maxWeatherCheckpointEncodeStarted: 2, maxForecastCheckpointSave: 3, forecastDeadlineOverlap: 4, maxVpws50ReceivedThenEew: 5 };
const BLOCK = 100; // trace は 100 試行ごとに区切る
const UF_SMALL_VALID_AFTER_REPORT_MS = 49 * 3_600_000; // 81_01_04 系の validUntil は報告時刻の 49 時間後（Phase 0 で実測）
// 母集団 5 の引き金は 81_01_04 の EditorialOffice だけを替え、負荷 N・P の VPWP50（81_01_04、稚内）と U-F の subject を分ける。同じ subject だと、
// 報告時刻を壁時計へ動かした背景が gate を進め、以後の引き金が stale で捨てられる（2026-10-07 の正式で母集団 5 が Blocked。Q-C4-DEADLINE-SUBJECT）。
// 稚内以外の VPWP50 の fixture は 81_09_01（長野、母集団 4 の引き金で XML が約 8 倍）しか無いので、fixture は替えず官署名だけを替える。
const DEADLINE_TRIGGER_OFFICE = "期限回収官署";
const editorialOffice = (xml) => /<EditorialOffice>([^<]*)<\/EditorialOffice>/.exec(xml)?.[1];
export function deadlineTriggerOverlap(manifest, office = DEADLINE_TRIGGER_OFFICE) {
  const load = manifest.populations.forecastDeadlineOverlap.load;
  const hit = (manifest.loads[load]?.fixtureRefs ?? []).find((ref) => ref.includes("_VPWP50")
    && editorialOffice(fixtureText(ref.replace("test__fixtures__", "")).toString("utf8")) === office);
  return hit == null ? null : `forecastDeadlineOverlap trigger office ${office} is also in load fixture ${hit}; the background would make every later trigger stale`;
}

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

// P3-C4-RUNNER-LIVENESS: 投入側が送った frame（data・ping・start）の間隔の最大と ping の件数。close で最後の frame から閉じるまでも数える。
// 無いと、負荷 N だけの窓（再生の中の空き 597,969ms）で host の生存期限 90 秒により再接続しても記録に残らない。
export function frameGapMeter(now = hrMs) {
  let last = null;
  const meter = {
    pings: 0, frames: 0, maxFrameGapMs: 0,
    sent(kind) {
      const at = now();
      if (last != null) meter.maxFrameGapMs = Math.max(meter.maxFrameGapMs, at - last);
      last = at;
      meter.frames += 1;
      if (kind === "ping") meter.pings += 1;
    },
    close() { if (last != null) meter.maxFrameGapMs = Math.max(meter.maxFrameGapMs, now() - last); last = null; },
  };
  return meter;
}
// 窓の frame 間隔が上限以上なら、その窓は Blocked（RES-06）。meters は窓の中で起動した host ごとの投入側。
export function livenessBlocked(meters, maxFrameGapMs) {
  const worst = (meters ?? []).reduce((m, x) => Math.max(m, x.maxFrameGapMs), 0);
  return worst >= maxFrameGapMs ? `frame gap ${Math.round(worst)}ms >= ${maxFrameGapMs}ms (P3-C4-RES-06)` : null;
}

// ── 独立投入側: host と別プロセスのローカル WS server ──
// pingEveryMs ごとに dmdata 形式の ping frame を送る（host は既存の pong 返送のまま。ping は host の input-<n> を消費しない、host.ts の onFrame）。
// send(frame, headType) の headType は版の窓の実行場所（placeOfHeadType）を引くために投入記録へ残す。
// now は frame 間隔の時計（既定は hrtime。試験は偽の時計を渡して実時間に頼らずに間隔を確かめる）。
export async function startInjector(scope, { pingEveryMs = 20_000, now = hrMs } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => server.once("listening", done));
  let socket = null;
  let seq = 0;
  let closing = false;
  let pingSeq = 0;
  const waiters = [];
  const meter = frameGapMeter(now);
  const places = new Map(); // input-<n> → 実行場所（headType を渡された投入だけ）
  // 送った ping の種類の列（P3-C4-AC07(2)①: host の mailbox の ping の行と受信順で 1 対 1 に対応させ、boundary の行を周期末にする）。
  const pingKinds = [];
  const sendPing = (kind) => {
    if (socket == null || socket.readyState !== 1) return false;
    pingSeq += 1;
    socket.send(JSON.stringify({ type: "ping", pingId: `runner-${pingSeq}` }));
    meter.sent("ping");
    pingKinds.push(kind);
    return true;
  };
  const ping = setInterval(() => sendPing("periodic"), pingEveryMs);
  // 通し番号は host の input-<n> と 1 本の connection の上でだけ一致する。2 本目・切断が起きたら run を中止する（試行ループの先頭で見る）。
  server.on("connection", (ws) => {
    if (socket != null) { injector.broken ??= "結合不能: 投入側に 2 本目の connection が来た（通し番号と host の input-<n> がずれる）"; return; }
    socket = ws;
    ws.on("close", () => { if (!closing && socket === ws) injector.broken ??= "結合不能: 投入側の socket が close した（通し番号と host の input-<n> がずれる）"; });
    ws.on("message", () => { /* pong など。host 側の観測は launcher の JSONL が正 */ });
    ws.on("error", () => {});
    waiters.splice(0).forEach((f) => f());
  });
  const injector = {
    broken: null,
    // AC15 の metadata シナリオ: 投入側から切断し（server 側で terminate）、host の再接続を期限付きで待つ。戻り値は再接続までの ms。
    // 意図した切断は socket を先に外すので broken にならない。通し番号は host 側も接続をまたいで続く（host.ts の lastSequence）。
    reconnect: async (timeoutMs) => {
      const old = socket;
      socket = null;
      const started = hrMs();
      old?.terminate();
      await Promise.race([injector.connected(), sleep(timeoutMs).then(() => { throw new Error(`host did not reconnect within ${timeoutMs}ms`); })]);
      return hrMs() - started;
    },
    url: `ws://127.0.0.1:${server.address().port}/`,
    meter,
    pingKinds,
    // 周期の境界（"boundary"）や入力停止後の排出の幅を狭める（"drain"）ための ping。送れなければ false。
    ping: sendPing,
    // 周期の ping を止める（E07 の停止の前に、送った全 ping の行を待つため）。
    stopPings: () => clearInterval(ping),
    placeOf: (inputId) => places.get(inputId) ?? null,
    connected: () => socket != null && socket.readyState === 1 ? Promise.resolve() : new Promise((f) => waiters.push(f)),
    sendStart: () => { if (socket == null) return; socket.send(JSON.stringify({ type: "start", socketId: 1, classifications: ["eew.forecast"] })); meter.sent("start"); },
    // 実投入時刻は送る直前の hrtime。同一スレッドの timer の予定時刻は使わない。通し番号は host の input-<n> と一致する。
    send: (frame, headType = null) => {
      if (socket == null || socket.readyState !== 1) return { seq: null, injectedHrMs: null };
      seq += 1;
      const injectedHrMs = hrMs();
      socket.send(frame);
      meter.sent("data");
      if (headType != null) places.set(`input-${seq}`, placeOfHeadType(headType));
      return { seq, injectedHrMs };
    },
    close: () => new Promise((done) => {
      if (!closing) { clearInterval(ping); meter.close(); }
      closing = true;
      for (const c of server.clients) c.terminate();
      server.close(() => done());
    }),
  };
  scope.add(() => injector.close());
  return injector;
}

// ── host launcher の起動（WP3c §1.3）: 投入側・config・spawn（ipc 付き）・ready・接続を待ち、後始末を窓のリストへ登録する ──
// E01 と周辺の窓（U3）が共有する。status に hostExit/hostError を書く（窓が Blocked の childExit に使う）。
// measureInputHeap は補助窓 ownerHeap だけが立てる（P3-C4-OWNER-HEAP=B'）。
async function startHost(dir, ctx, { memEveryMs = 10_000, nodeArgs = [], env = null, status = {}, measureInputHeap = false } = {}) {
  status.hostExit = null;
  status.hostError = null;
  const injector = await startInjector(ctx.scope, { pingEveryMs: ctx.manifest.liveness?.pingEveryMs });
  status.liveness = [...(status.liveness ?? []), injector.meter];
  const obsPath = join(dir, "host-obs.jsonl");
  const configPath = join(dir, "host-config.json");
  writeFileSync(configPath, JSON.stringify({ wsUrl: injector.url, stateDirectory: join(dir, "state"), diagnosticDirectory: join(dir, "diagnostics"),
    obsPath, wallOriginMs: ctx.wallOriginMs, startedWallMs: Date.now(), notification: ctx.notification, memEveryMs, measureInputHeap }));
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

// P3-C4-T3-BINDING: inputId の版の窓（観測の行順で、その T2 の行から同じ実行場所の次の入力の T2 の行まで。無ければ今ある行の終わり）に
// 公開された版。別の場所・tick 由来の T3 も窓に入りうるが、Chrome 側で候補 mark（subject つき）の出た版だけを対象にする（複数なら解析で ambiguous）。
// from は投入前の行数（その後の行だけ見る）。T2 がまだ書き出されていなければ空。placeOf の既定（全入力で同じ場所）は A10 の「次の入力の T2」。
export function publishedBy(lines, from, inputId, placeOf = () => null) {
  const versions = [];
  let place;
  for (let i = from; i < lines.length; i++) {
    const o = lines[i].t === "obs" ? lines[i].o : null;
    if (o?.kind !== "marker") continue;
    if (o.point === "T2") {
      if (place !== undefined) { if (placeOf(o.inputId) === place) break; }
      else if (o.inputId === inputId) place = placeOf(inputId);
    } else if (place !== undefined && o.point === "T3") versions.push(o.displayVersion);
  }
  return versions;
}

// backend 単独（Chrome が無く subject で絞れない）: 自分の返信の射影で公開した版。host は owner の返信 1 件を同期に、T2・decode・T3・processing の
// 順で出す（host.ts の worker message → root.receive → onInputDone）ので、T2 の行から自分の processing の行（または次の T2）までの T3 だけを見る。
// その版の T4 が出ていればその版を返す。まだなら null。
export function t4Of(lines, from, inputId) {
  let started = false;
  let own = null;
  for (let i = from; i < lines.length; i++) {
    const o = lines[i].t === "obs" ? lines[i].o : null;
    if (o == null) continue;
    if (own != null) { if (o.kind === "marker" && o.point === "T4" && versionKey(o.displayVersion) === versionKey(own)) return own; continue; }
    if (!started) { started = o.kind === "marker" && o.point === "T2" && o.inputId === inputId; continue; }
    if (o.kind === "marker" && o.point === "T3") own = o.displayVersion;
    else if ((o.kind === "processing" && o.measurement.inputId === inputId) || (o.kind === "marker" && o.point === "T2")) return null;
  }
  return null;
}

// backend 単独の SSE client 1 本（T4 は client への書出しで出る、http-sse.ts）。受けた本文は捨てる。
function openSse(url, scope) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => { response.on("data", () => {}); response.on("error", () => {}); resolve(); });
    request.on("error", reject);
    scope.add(() => request.destroy());
  });
}

const readDiagnostics = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => { try { return JSON.parse(l); } catch { return null; } })) : []);

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
  const backend = ctx.backendOnly === true;
  const started = { wallMs: Date.now(), hrMs: hrMs() };
  const hostProcess = await startHost(dir, ctx, { status });
  const { injector, obsPath } = hostProcess;
  const host = tailer(obsPath);
  const probes = [];
  // Chrome は E01 の実 paint（T6）用。backend 単独（Pi 第 1 段、AC03(6)）は Chrome を起動せず、SSE の client 1 本で T4 を起こす。
  let page = null;
  let chromeActivation = null; // 起動時に Chrome を OS の前面にした結果（chrome.mjs の activate）
  if (backend) await openSse(`http://127.0.0.1:${hostProcess.displayPort}/events`, ctx.scope);
  else {
    page = await openPage(`http://127.0.0.1:${hostProcess.displayPort}/`, ctx.scope, { motion: ctx.manifest.chrome.motion });
    ctx.commands?.push(page.command);
    chromeActivation = page.activation;
    for (let i = 0; i < 200 && !(await page.evaluate("typeof window.fleqRespondClockProbe === 'function'")); i++) await sleep(50);
    await page.evaluate(INSTALL_TRIAL_WATCH);
  }
  const probe = async (name) => { if (page != null) probes.push(await probeClock(page.evaluate, `${label}-${name}`)); };
  const markCount = () => page.evaluate(`performance.getEntriesByName(${JSON.stringify(T6C)}).length`);
  // 対象版（versions のどれか）の T6 候補 mark が before 件目以降にあり、それを含む frame の Commit を過ぎた（rAF 2 回目が来た）ら、その版を返す。
  // 以後に来る候補は後の Commit に入るので、対象版を置換できない（analysis の replacedBeforePaint と同じ境界）。まだなら null。
  const paintedTarget = (before, versions) => page.evaluate(`(async () => {
    const targets = ${JSON.stringify(versions.map((v) => [v.streamId, v.sequence]))};
    const mark = performance.getEntriesByName(${JSON.stringify(T6C)}).slice(${before})
      .find((e) => targets.some(([streamId, sequence]) => e.detail?.displayVersion?.streamId === streamId && e.detail?.displayVersion?.sequence === sequence));
    if (mark == null) return null;
    const framed = await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), new Promise((r) => setTimeout(() => r(false), 1000))]);
    return framed ? mark.detail.displayVersion : null;
  })()`);
  log("page ready");
  await probe("start");
  log("probed");
  injector.sendStart();

  const clockOffset = () => { const c = host.lines.find((l) => l.t === "clock"); return c.perfNowMs - Number(BigInt(c.hrtimeNs)) / 1e6; };
  for (let i = 0; i < 50 && !host.lines.some((l) => l.t === "clock"); i++) { host.refresh(); await sleep(100); }
  const ohStart = clockOffset();
  const wallNow = () => ctx.wallOriginMs + Math.floor((hrMs() + ohStart) / 1000) * 1000;
  // 投入側時計 → host 時計の対応（clock 行の差の範囲、analysis の buildHostIndex と同じ余裕）。成立の判定に使うので run の間に追いかける。
  const oh = { lo: null, hi: null };
  let clockScan = 0;
  const updateOh = () => {
    for (; clockScan < host.lines.length; clockScan++) {
      const l = host.lines[clockScan];
      if (l.t !== "clock") continue;
      const v = l.perfNowMs - Number(BigInt(l.hrtimeNs)) / 1e6;
      oh.lo = Math.min(oh.lo ?? Infinity, v - 0.01);
      oh.hi = Math.max(oh.hi ?? -Infinity, v + 0.01);
    }
  };
  // AC13(7): 入力 ID → parse 開始（host の時計）。行は追記の分だけ走査する（試行ごとに全行を索引し直さない）。
  const parseStarts = new Map();
  // Q-C6-IMPL-AMEND (10): 入力 ID → その入力を含む U-W の保存の encode 開始（host の時計）。津波の encode 直後の較正に使う。
  const encodeStarts = new Map();
  let parseScan = 0;
  const scanParseStarts = () => {
    host.refresh();
    for (; parseScan < host.lines.length; parseScan++) {
      const o = host.lines[parseScan].t === "obs" ? host.lines[parseScan].o : null;
      if (o?.kind === "decode" && o.xmlParseStartedMonotonicMs != null) parseStarts.set(o.inputId, o.xmlParseStartedMonotonicMs);
      else if (o?.kind === "checkpoint" && o.measurement.unit === "U-W" && o.measurement.stage === "encode") {
        for (const inputId of o.measurement.inputIds) if (!encodeStarts.has(inputId)) encodeStarts.set(inputId, o.measurement.startedMonotonicMs);
      }
    }
  };
  // 初期化入力（製品の WS 入力として流す）。処理と保存が済むまで待つ。
  const others = [];
  const dataSend = (frame, headType, kind, extra = {}) => { const r = injector.send(frame, headType); others.push({ kind, seq: r.seq, inputId: r.seq == null ? null : `input-${r.seq}`, injectedHrMs: r.injectedHrMs, headType, ...extra }); return r; };
  for (const name of ctx.initial) { const headType = name.match(/_(V[A-Z]{3}\d{2})/)[1]; dataSend(weatherFrame(name, headType, wallNow()), headType, "init", { fixture: name }); }
  const expectedUnits = new Set(ctx.initial.map((name) => (/VPWS50|VPWW/.test(name) ? "U-W" : "U-F")));
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
  const firstSnapshot = await fetch(`http://127.0.0.1:${hostProcess.displayPort}/snapshot`).then((r) => r.json(), () => null);
  const channels = firstSnapshot?.channels ?? null;

  // 通常負荷 N（決めた offset で繰り返す）
  const loopStart = hrMs();
  const pumpBackground = replayPump(ctx.load, (frame, event) => dataSend(frame, event.headType, "background"), wallNow, loopStart);
  const idleUntil = async (targetHrMs) => {
    while (targetHrMs - hrMs() > 4) { pumpBackground(); await sleep(Math.min(20, targetHrMs - hrMs() - 3)); }
    await spinUntil(targetHrMs);
  };

  // ── P3-C6-AC06: 津波の試行（prime → target）。周期・trace の区切り・probe・stopCondition は EEW と同じループで回す ──
  const tsu = spec.tsunami;
  if (tsu != null && page == null) throw new Error("the tsunami windows need Chrome (the T6 of the prime and the target); --backend-only is not supported");
  const tsunamiMarkCount = () => page.evaluate(`performance.getEntriesByName(${JSON.stringify(T6_TSUNAMI)}).length`);
  // before 件目以降の津波の候補で、subject・present・areas が expected と一致し、versions（無ければ任意の版）の版のものを waitMs まで待つ。
  // 見つけたら、それを含む frame の Commit を過ぎた（rAF 2 回目）時点の Chrome の時刻を返す（試行の直後の判定に使う paint の代わり。正式の T6 は
  // trace の実 paint で解析が取り直し、prime が target の T0 より後に描かれていれば標本を traceIncomplete にする）。
  const tsunamiPainted = (before, subject, expected, versions, waitMs) => page.evaluate(`(async () => {
    const versions = ${JSON.stringify(versions == null ? null : versions.map((v) => [v.streamId, v.sequence]))};
    const areas = ${JSON.stringify(JSON.stringify(expected.areas))};
    const deadline = performance.now() + ${waitMs};
    for (;;) {
      const mark = performance.getEntriesByName(${JSON.stringify(T6_TSUNAMI)}).slice(${before}).find((e) => e.detail?.subject === ${JSON.stringify(subject)}
        && e.detail.present === ${expected.present} && JSON.stringify(e.detail.areas) === areas
        && (versions == null || versions.some(([s, q]) => e.detail.displayVersion.streamId === s && e.detail.displayVersion.sequence === q)));
      if (mark != null) {
        const framed = await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), new Promise((r) => setTimeout(() => r(false), 1000))]);
        return framed ? { version: mark.detail.displayVersion, paintedMs: performance.now() } : null;
      }
      if (performance.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  })()`);
  // VTSE41 の ReportDateTime は報ごとに 1 秒以上単調に進める（同じ秒・同じ InfoType の別内容は tsunamiRevisionConflict で stale になる）。
  let lastReportMs = 0;
  const nextReportAt = () => (lastReportMs = Math.max(lastReportMs + 1000, wallNow()));
  // 窓の subject（warm-up と正式で別の EventID）が今 view にあるか。prime の T6 を求めるかは、これと prime の期待で決まる（AC06(3)）。
  let shownEventId = null;
  let shown = false;
  let eewSerial = 0;
  const latestCorrespondence = () => (oh.lo == null ? null : correspondences(probes, { ohLo: oh.lo, ohHi: oh.hi }).at(-1) ?? null);
  // AC06(2): warm-up の後に warm-up の EventID の解除の報を送り、片付けを確かめてから正式に入る。表示中なら present false の候補、既に表示外なら
  // その報の世代の U-T の ack で確かめる。どちらも 10 秒で観測できなければ窓は Blocked（例外）。
  let warmupRelease = null;
  const releaseWarmup = async () => {
    const subject = `normal/VTSE41/${tsu.eventIds.warmup}`;
    host.refresh();
    const linesBefore = host.lines.length;
    const before = await tsunamiMarkCount();
    const r = dataSend(dataFrame("VTSE41", Buffer.from(tsunamiReport(RELEASE_FIXTURE, { eventId: tsu.eventIds.warmup, reportAtMs: nextReportAt() }))), "VTSE41", "warmupRelease");
    const inputId = `input-${r.seq}`;
    const deadline = hrMs() + 10_000;
    for (;;) {
      host.refresh();
      if (shown) {
        const versions = publishedBy(host.lines, linesBefore, inputId, injector.placeOf);
        if (versions.length > 0 && await tsunamiPainted(before, subject, { present: false, areas: [] }, versions, 0) != null) return { inputId, confirmedBy: "presentFalse" };
      } else {
        const recent = buildHostIndex(host.lines.slice(linesBefore));
        const generation = recent.raised.get(`${inputId}|U-T`);
        if (generation != null && recent.grants.some((g) => g.unit === "U-T" && g.result?.kind === "acknowledged" && g.result.generation >= generation)) return { inputId, confirmedBy: "ack" };
      }
      if (hrMs() > deadline) throw new Error(`warm-up release of ${subject} was not observed within 10 s (P3-C6-AC06(2))`);
      pumpBackground();
      await sleep(40);
    }
  };
  const tsunamiTrial = async (k, warm, due) => {
    const phase = warm ? "warmup" : "formal";
    const eventId = warm ? tsu.eventIds.warmup : tsu.eventIds.formalByRun[run - 1];
    if (shownEventId !== eventId) { shownEventId = eventId; shown = false; eewSerial = 0; }
    // warm-up は試行番号で回し、正式は成立した件数がいちばん少ない遷移を選ぶ（不成立なら同じ遷移を次も試す）。遷移ごとの件数を
    // P3-C6-POP-SHAPE=A の凍結した割り当て（発令系 333/333/334、解除系 500/500）にそろえる（Q-C6-IMPL-AMEND (12)）。
    const transition = warm ? tsu.transitions[k % tsu.transitions.length] : nextTransition(tsu.transitions, quotas, establishedByTransition);
    const template = ctx.templates.get(transition);
    const subject = `normal/VTSE41/${eventId}`;
    // 投入の瞬間に組み立てで遅れないよう、待つ前に作る。
    const primeFrame = dataFrame("VTSE41", Buffer.from(tsunamiReport(template.primeFixture, { eventId, reportAtMs: nextReportAt() })));
    const targetFrame = dataFrame("VTSE41", Buffer.from(tsunamiReport(template.targetFixture, { eventId, reportAtMs: nextReportAt() })));
    const eewEventId = tsu.eewEventIds == null ? null : warm ? tsu.eewEventIds.warmup : tsu.eewEventIds.formalByRun[run - 1];
    const eewFrame = eewEventId == null ? null : dataFrame("VXSE45", Buffer.from(vxse45Variant({ eventId: eewEventId, serial: ++eewSerial,
      variant: eewSerial % 2 === 1 ? "A" : "B", reportAtMs: wallNow() })));
    const vpwsFrame = tsu.inherits === "maxVpws50ParseStarted" ? weatherFrame("15_18_01_250630_VPWS50", "VPWS50", wallNow()) : null;
    await idleUntil(due);
    host.refresh();
    const marksBefore = await tsunamiMarkCount();
    const linesBefore = host.lines.length;
    const paintRequired = shown || template.expectedPrimePaint.present;
    const base = { attemptIndex: k, index: warm ? k : null, phase, eventId, subject, transition, scheduledHrMs: due, block: Math.floor(k / BLOCK),
      expectedPaint: template.expectedPaint, eew: null };
    let prime = null;
    let primePainted = null;
    let trigger = null;
    let sent;
    let stateAtSend = null;
    let sentWallMs = null;
    let sentSkewMs = null;
    const sendPrime = () => {
      const r = dataSend(primeFrame, "VTSE41", "prime", { trial: k });
      prime = { inputId: r.seq == null ? null : `input-${r.seq}`, injectedHrMs: r.injectedHrMs, paintRequired, expectedPaint: template.expectedPrimePaint };
      // prime の描画は target の送出まで待つ（それより後なら成立しない）。待つ間も runner は target の時刻へ進む。
      primePainted = paintRequired ? tsunamiPainted(marksBefore, subject, template.expectedPrimePaint, null, tsu.primeLeadMs).catch(() => null) : null;
    };
    const sendTarget = () => {
      if (eewFrame != null) {
        const e = dataSend(eewFrame, "VXSE45", "eew", { trial: k });
        base.eew = { inputId: e.seq == null ? null : `input-${e.seq}`, injectedHrMs: e.injectedHrMs, subject: `normal/VXSE45/${eewEventId}` };
      }
      sentWallMs = Date.now();
      sentSkewMs = sentWallMs - performance.now();
      const result = injector.send(targetFrame, "VTSE41");
      stateAtSend = page.evaluate(STATE_AT_SEND).catch(() => null);
      return result;
    };
    if (tsu.inherits === "maxWeatherCheckpointEncodeStarted") {
      // Q-C6-IMPL-AMEND (10): UWR（P3-UNIT-WRITE-RIGHT-001）の後の版では、U-W の保存は 1 秒の tick に乗らず、引き金の返信の反映の後にすぐ始まる
      // （予備で引き金の送信から約 19〜45ms）。parse 直後と同じく、引き金の送信から直近 10 試行の「その引き金を含む U-W の encode 開始 − 実送信」
      // の中央値＋targetOffsetMs に target を送る。予測が無い間（最初の 10 試行）は triggerLeadMs を予測の代わりにする。prime は引き金の
      // primeLeadMs 前。tick の予測（predictTick）は C4 の EEW の母集団だけが使う（UWR の前の版の前提）。
      sendPrime();
      await idleUntil(prime.injectedHrMs + tsu.primeLeadMs);
      scanParseStarts();
      updateOh();
      const predicted = predictParseDelay(trials, encodeStarts, oh.lo);
      const t = dataSend(weatherFrame("15_17_01_251222_VPWW55", "VPWW55", wallNow() + (k + 1) * 1000), "VPWW55", "trigger", { trial: k });
      trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs, calibrated: true };
      const delay = predicted ?? spec.leadMs;
      trigger.predictedEncodeDelayMs = predicted;
      trigger.predictedTickHostMs = t.injectedHrMs == null || oh.lo == null ? null : t.injectedHrMs + oh.lo + delay;
      await spinUntil(t.injectedHrMs + delay + spec.targetOffsetMs);
      sent = sendTarget();
    } else {
      sendPrime();
      await idleUntil(prime.injectedHrMs + tsu.primeLeadMs);
      if (vpwsFrame != null) {
        // 母集団 2 と同じ自己較正（P3-C4-AC13(7)）: 引き金の実送信から直近 10 試行の「parse 開始 − 実送信」の中央値＋targetOffsetMs に送る。
        scanParseStarts();
        updateOh();
        const predicted = predictParseDelay(trials, parseStarts, oh.lo);
        const t = dataSend(vpwsFrame, "VPWS50", "trigger", { trial: k });
        trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs };
        await spinUntil(calibratedSendAt(trigger, predicted, spec.targetOffsetMs));
      }
      sent = sendTarget();
    }
    const trial = { ...base, inputId: sent.seq == null ? `notInjected-${k}` : `input-${sent.seq}`, injectedHrMs: sent.injectedHrMs, prime, trigger };
    trials.push(trial);
    // 後続置換の防止（C4 と同じ）: target の版の窓に公開された版で、期待と一致する津波の候補が描かれた frame の Commit を過ぎるか、10 秒まで待つ。
    if (sent.injectedHrMs != null) {
      const deadline = sent.injectedHrMs + 10_000;
      await sleep(120);
      let done = null;
      while (done == null && hrMs() < deadline) {
        pumpBackground();
        host.refresh();
        const versions = publishedBy(host.lines, linesBefore, trial.inputId, injector.placeOf);
        if (versions.length > 0) done = await tsunamiPainted(marksBefore, subject, template.expectedPaint, versions, 0);
        if (done == null) await sleep(40);
      }
      trial.completedBy = done != null ? "paint" : "timeout";
      trial.paintedVersion = done?.version ?? null;
      if (done == null) {
        let last = await tsunamiMarkCount();
        let quietSince = hrMs();
        while (hrMs() - quietSince < 1000) {
          pumpBackground();
          await sleep(40);
          const count = await tsunamiMarkCount();
          if (count !== last) { last = count; quietSince = hrMs(); }
        }
      }
    }
    shown = template.expectedPaint.present;
    const atSend = await stateAtSend;
    trial.focusAtSend = atSend?.focus ?? null;
    const end = await trialWatchAtEnd(page.evaluate, sentSkewMs);
    trial.conditionDeviation = trialConditionDeviation(atSend, ctx.manifest.chrome.motion, end.events, sentWallMs, end.clockStepMs);
    const painted = await primePainted;
    trial.primePaintedChromeMs = painted?.paintedMs ?? null;
    if (warm) return;
    if (trial.conditionDeviation != null) { trial.establishment = { established: false, reason: "conditionDeviation" }; return; }
    // 成立の判定（AC06(3)）。prime の ack・返信・target の対象区間・VXSE45 の inputDone の観測を、実投入から 11 秒まで待つ。
    const settleBy = (sent.injectedHrMs ?? hrMs()) + 11_000;
    for (;;) {
      host.refresh();
      updateOh();
      const recent = buildHostIndex(host.lines.slice(linesBefore));
      const t0Ms = recent.t0.get(trial.inputId) ?? null;
      const generation = prime?.inputId == null ? undefined : recent.raised.get(`${prime.inputId}|U-T`);
      const acks = generation == null ? [] : recent.grants.filter((g) => g.unit === "U-T" && g.result?.kind === "acknowledged" && g.result.generation >= generation);
      const ackMs = acks.length === 0 ? null : Math.min(...acks.map((g) => g.doneReceivedMonotonicMs));
      const replyMs = recent.processing.find((p) => p.inputId === prime?.inputId)?.endedMonotonicMs ?? null;
      const corr = latestCorrespondence();
      const paintHostMs = painted == null || corr == null ? null : { lowerMs: painted.paintedMs - corr.offsetUpperMs, upperMs: painted.paintedMs - corr.offsetLowerMs };
      const offset = tsu.establishment.kind === "primeSettledStartOffset";
      trial.target = offset ? trialTarget(tsu.inherits, trial, recent, oh.lo, "population") : null;
      const eewInputDoneMs = trial.eew == null ? null : recent.processing.find((p) => p.inputId === trial.eew.inputId)?.endedMonotonicMs ?? null;
      trial.establishment = establishTsunamiTrial({ establishment: tsu.establishment, t0Ms, prime: { paintRequired, paintHostMs, replyMs, ackMs }, target: trial.target, eewInputDoneMs });
      trial.primeObserved = { generation: generation ?? null, ackMs, replyMs, paintHostMs };
      const complete = t0Ms != null && ackMs != null && (paintRequired ? true : replyMs != null) && (!offset || trial.target != null)
        && (trial.eew == null || eewInputDoneMs != null);
      // 予測が外れて対象の区間が来ない試行は 11 秒を待ち切らず、TARGET_WAIT_MS で不成立（startOffset）として次へ進む
      // （待ち切ると frame の間隔が延び、正式では liveness に掛かる。2 回目の予備で 1 試行 15.5 秒）。
      if (settleDone({ established: trial.establishment.established, complete, offset, target: trial.target, sentHrMs: sent.injectedHrMs, nowHrMs: hrMs(), settleBy })) break;
      pumpBackground();
      await sleep(50);
    }
    if (trial.establishment.established) {
      trial.index = spec.warmup + established++;
      establishedByTransition.set(transition, (establishedByTransition.get(transition) ?? 0) + 1);
    }
  };
  const quotas = tsu == null ? null : transitionQuotas(tsu.transitions, spec.count);
  const establishedByTransition = new Map();

  // 試行
  const trials = [];
  const blocks = [];
  let tracing = null;
  let blockStartedHr = null;
  const openBlock = async () => { if (page == null) return; tracing = await startTracing(page.page); blockStartedHr = hrMs(); };
  const closeBlock = async (index) => {
    if (page == null) return;
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
  let established = 0;
  let stopped = null; // stopCondition に達した（窓は Blocked）

  // P3-C4-AC03(1): k は warm-up を含む通し番号（attemptIndex）。warm-up は成立を判定せず 0〜warmup-1 を順に振り、正式は成立した試行にだけ
  // warmup〜warmup+count-1 を振る。maxAttempts（warm-up を含む）か maxDurationMs に達したら打ち切る。
  for (let k = 0; ; k++) {
    const warm = k < spec.warmup;
    if (!warm && established >= spec.count) break;
    if (k >= spec.stop.maxAttempts || hrMs() - started.hrMs >= spec.stop.maxDurationMs) {
      stopped = { reason: k >= spec.stop.maxAttempts ? "maxAttempts" : "maxDurationMs", attempts: k, established, ...spec.stop };
      break;
    }
    if (status.hostExit != null) throw new Error(`host launcher exited mid-run: ${JSON.stringify(status.hostExit)}`);
    if (injector.broken != null) throw new Error(injector.broken);
    status.trialsStarted = k;
    status.established = established;
    // 区切りの直前に 200ms 待ち、直前の試行の paint（PipelineReporter の終端）を前の trace に入れる。
    if (k > 0 && k % BLOCK === 0) { await sleep(200); await closeBlock(k / BLOCK - 1); await openBlock(); }
    if (hrMs() - lastProbeHr >= 29_000) { await probe(`t${k}`); lastProbeHr = hrMs(); }
    const phase = warm ? "warmup" : "formal";
    const serial = (warm ? k : k - spec.warmup) + 1;
    // 予定の枠が、試行の準備ができた時点（前の完了・trace の区切り・時計 probe の後）で既に過ぎていたら、予定を「今 + 周期」へ付け替える。
    // 付け替えないと、timeout や trace の区切りの後に過去の予定が続き、数試行が詰めて投入される。予定どおりの間は周期を変えない。
    let due = anchor + k * spec.periodMs;
    const readyHr = hrMs();
    if (due < readyHr) { due = readyHr + spec.periodMs; anchor = due - k * spec.periodMs; }
    if (tsu != null) {
      if (k === spec.warmup && spec.warmup > 0) warmupRelease = await releaseWarmup();
      await tsunamiTrial(k, warm, due);
      continue;
    }
    const eventId = eventIdOf(POP_CODE[population], phase, run);
    const variant = serial % 2 === 1 ? "A" : "B";
    // 投入の瞬間に frame の組み立てで遅れないよう、待つ前に作る（報告時刻は host 時計の今の秒）。
    const frame = dataFrame("VXSE43", Buffer.from(eewVariant({ eventId, serial, variant, reportAtMs: wallNow() })));
    const vpwsFrame = VPWS50_TRIGGERED.has(population) ? weatherFrame("15_18_01_250630_VPWS50", "VPWS50", wallNow()) : null;
    await idleUntil(due);
    host.refresh();
    const before = page == null ? 0 : await markCount();
    const linesBefore = host.lines.length;
    const base = { attemptIndex: k, index: warm ? k : null, phase, eventId, serial, variant, subject: `normal/VXSE43/${eventId}`, scheduledHrMs: due, block: Math.floor(k / BLOCK) };
    let trigger = null;
    let sent;
    // AC08: 投入の壁時計の時刻を残し（blur・visibilitychange の切り出しの起点）、送った直後に前景の状態を取る（待たずに投げるので、投入の時刻を動かさない）。
    let stateAtSend = null;
    let sentWallMs = null;
    let sentSkewMs = null;
    const sendEew = () => {
      sentWallMs = Date.now();
      sentSkewMs = sentWallMs - performance.now();
      const result = injector.send(frame, "VXSE43");
      stateAtSend = page?.evaluate(STATE_AT_SEND).catch(() => null) ?? null;
      return result;
    };
    if (population === "fixedBacklog") {
      sent = sendEew();
    } else if (vpwsFrame != null) {
      // 衝突は同じ WS で間を空けずに続ける。母集団 2 の予測値は引き金を送る前に作る（送った後に作ると spin の精度を食う）。
      let predicted = null;
      if (population === "maxVpws50ParseStarted") { scanParseStarts(); updateOh(); predicted = predictParseDelay(trials, parseStarts, oh.lo); }
      const t = dataSend(vpwsFrame, "VPWS50", "trigger", { trial: k });
      trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs };
      // 母集団 2 の「開始」は parse 開始（P3-C4-PARSE-MARK）で、worker の展開（TextDecoder まで）の後なので、引き金の実送信から直近 10 試行の
      // 「parse 開始 − 引き金の実送信」の中央値＋targetOffsetMs の時刻に送る（AC13(7)）。予測値が無い間（最初の 10 試行）は実送信＋targetOffsetMs。
      if (population === "maxVpws50ParseStarted") await spinUntil(calibratedSendAt(trigger, predicted, spec.targetOffsetMs));
      sent = sendEew();
    } else {
      // 次の tick の checkpoint encode 開始を予測し、その 1ms 後に EEW を投入する。引き金は狙う tick の lead（manifest の triggerLeadMs）前に送る。
      // 期限回収は狙う tick の 1 つ前の tick で起きる（下の validUntil）。狙う tick は lead より保存で 900ms・期限回収で 100ms 以上先
      // （既定で 1.5 秒・2.5 秒先）にし、引き金を過去に送らない。
      const deadlineTrigger = population === "forecastDeadlineOverlap";
      const lead = spec.leadMs;
      const tick = predictTick(host, hrMs(), lead + (deadlineTrigger ? 100 : 900));
      if (tick == null) { sent = sendEew(); base.noTickModel = true; }
      else {
        await spinUntil(tick.hrMs - lead);
        let frameText;
        let headType;
        if (population === "maxWeatherCheckpointEncodeStarted") { headType = "VPWW55"; frameText = weatherFrame("15_17_01_251222_VPWW55", headType, wallNow() + (k + 1) * 1000); }
        else if (population === "maxForecastCheckpointSave") { headType = "VPWP50"; frameText = weatherFrame("81_09_01_260605_VPWP50", headType, wallNow() + (k + 1) * 1000); }
        else {
          headType = "VPWP50";
          const text = fixtureText("81_01_04_251222_VPWP50").toString("utf8")
            .replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${DEADLINE_TRIGGER_OFFICE}</EditorialOffice>`);
          const report = Date.parse(/<ReportDateTime>([^<]+)</.exec(text)[1]);
          // validUntil を、狙う tick の 1 つ前の tick の壁時計以下で、その前の tick との間にただ 1 つある秒境界に置く。C3a 後の host では
          // owner がその tick の deadline 要求で期限回収し、保存（encode）は次の tick（狙う tick）で起きる（品質レビュー Q1: A10 の置き方では
          // 回収の encode が狙う tick の 1 つ後に出て、成立 0/38 だった）。
          const target = Math.floor((ctx.wallOriginMs + tick.hostMs - 1000 - 5) / 1000) * 1000;
          frameText = dataFrame("VPWP50", Buffer.from(shiftTimestamps(text, target - (report + UF_SMALL_VALID_AFTER_REPORT_MS))));
        }
        const t = dataSend(frameText, headType, "trigger", { trial: k });
        trigger = { inputId: t.seq == null ? null : `input-${t.seq}`, injectedHrMs: t.injectedHrMs, predictedTickHostMs: tick.hostMs };
        await spinUntil(tick.hrMs + spec.targetOffsetMs);
        sent = sendEew();
      }
    }
    log(`sent ${k}`);
    const trial = { ...base, inputId: sent.seq == null ? `notInjected-${k}` : `input-${sent.seq}`, injectedHrMs: sent.injectedHrMs, trigger };
    trials.push(trial);
    // 後続置換の防止: この入力の版の窓（P3-C4-T3-BINDING）に host が公開した版が Chrome で描かれた frame の Commit を過ぎるか、実投入から 10 秒が
    // 経つまで次を投入しない。候補 mark の件数の増加だけでは進めない（別の版の mark や、Commit 前の置換を見分けられない）。
    // backend 単独は、自分の返信の射影で公開した版（ownPublished）の T4 の観測で完了とする。
    if (sent.injectedHrMs != null) {
      const deadline = sent.injectedHrMs + 10_000;
      await sleep(backend ? 20 : 120);
      let done = null;
      while (done == null && hrMs() < deadline) {
        pumpBackground();
        host.refresh();
        if (backend) done = t4Of(host.lines, linesBefore, trial.inputId);
        else {
          const versions = publishedBy(host.lines, linesBefore, trial.inputId, injector.placeOf);
          if (versions.length > 0) done = await paintedTarget(before, versions);
        }
        if (done == null) await sleep(backend ? 20 : 40);
      }
      trial.completedBy = done != null ? (backend ? "t4" : "paint") : "timeout";
      trial.paintedVersion = done; // 診断用（run-record で完了判定の対象版を後から確かめる）。判定・集計は読まない
      // timeout の後に遅れて来る mark を次の試行の完了と取り違えないよう、新しい mark が 1 秒来ないのを確かめてから進む。
      if (done == null && page != null) {
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
    // 背景・ロックでは描画と timer が間引かれ、製品の遅延と区別できないので、逸脱した試行は成立させない（記録は warm-up も残す）。
    const atSend = await stateAtSend;
    trial.focusAtSend = atSend?.focus ?? null;
    if (page != null) {
      const end = await trialWatchAtEnd(page.evaluate, sentSkewMs);
      trial.conditionDeviation = trialConditionDeviation(atSend, ctx.manifest.chrome.motion, end.events, sentWallMs, end.clockStepMs);
    } else trial.conditionDeviation = null;
    if (!warm && trial.conditionDeviation != null) trial.establishment = { established: false, reason: "conditionDeviation" };
    else if (!warm) {
      // 成立の判定（establishTrial）。対象の観測（parse・encode・保存の記録は対象の処理が終わってから出る）を、実投入から 11 秒まで待つ。
      const settleBy = (sent.injectedHrMs ?? hrMs()) + 11_000;
      for (;;) {
        host.refresh();
        updateOh();
        const recent = buildHostIndex(host.lines.slice(linesBefore));
        trial.target = trialTarget(population, trial, recent, oh.lo, spec.span);
        trial.establishment = establishTrial({ establishment: spec.establishment, target: trial.target, t0Ms: recent.t0.get(trial.inputId) ?? null,
          injectorSendHostMs: sent.injectedHrMs == null || oh.lo == null ? null : { lowerMs: sent.injectedHrMs + oh.lo, upperMs: sent.injectedHrMs + oh.hi } });
        if (trial.establishment.established || trial.establishment.reason !== "targetNotObserved" || hrMs() > settleBy) break;
        pumpBackground();
        await sleep(50);
      }
    }
    if (!warm && trial.establishment.established) trial.index = spec.warmup + established++;
  }
  await sleep(1500);
  await probe("end");
  if (trials.length > 0) await closeBlock(Math.floor((trials.length - 1) / BLOCK));
  const finishedHr = hrMs();

  // 終了: host → 投入側 → Chrome の順で止める。後始末が失敗しても、記録して trace の解析と run-record の書き出しへ進む。
  const teardownErrors = [];
  for (const [name, fn] of [["host", hostProcess.stop], ["chrome", page?.close ?? (async () => {})]]) {
    try { await fn(); } catch (error) { teardownErrors.push(`${name}: ${String(error?.message ?? error)}`); }
  }
  host.refresh();

  const hostIndex = buildHostIndex(host.lines);
  const rejections = rejectionReasons(readDiagnostics(join(dir, "diagnostics")));
  let assembled = { samples: [], injections: [], details: [], correspondences: [] };
  if (page != null) {
    const chromeByVersion = new Map();
    const chromeByCandidate = new Map();
    for (const block of blocks) {
      const analyzed = analyzeTrace(JSON.parse(readFileSync(block.file, "utf8")).traceEvents);
      for (const [key, entry] of analyzed.byVersion) chromeByVersion.set(key, entry);
      for (const [key, entry] of analyzed.byCandidate) chromeByCandidate.set(key, entry);
      block.marks = analyzed.markCount;
      block.rejectedMarks = analyzed.rejectedMarks;
    }
    const input = { population, run, trials, host: hostIndex, chromeByVersion, chromeByCandidate, probes, blocks, callbackDeadlineMs: 10_000, missingAfterMs: 10_000,
      placeOf: injector.placeOf, rejections };
    assembled = tsu == null ? assembleP3Trials(input) : assembleTsunamiTrials(input);
  }
  // U-F の許容範囲（AC01）: 試行ごとに、T0 以前の最新の U-F encode の byte と、保存済み U-F checkpoint から数えた件数（run 開始時と終了後の多い方）を
  // manifest の forecast.allowed で見る。件数か byte のどちらかが範囲外、または未観測の試行は別条件として残す。
  const measuredSubjects = [ufSubjectsBefore, savedForecastSubjects(join(dir, "state"))].reduce((m, v) => (v == null ? m : Math.max(m ?? 0, v)), null);
  const ufEncodes = hostIndex.checkpoints.filter((c) => c.unit === "U-F" && c.stage === "encode");
  const ufAllowance = spec.forecast == null ? null : trials.map((trial) => {
    const t0 = hostIndex.t0.get(trial.inputId);
    const encode = t0 == null ? null : ufEncodes.filter((c) => c.startedMonotonicMs <= t0).at(-1) ?? null;
    const within = encode != null && measuredSubjects != null && forecastWithinAllowance({ formal: { forecast: spec.forecast } }, { subjects: measuredSubjects, encodedBytes: encode.bytes });
    return { index: trial.index, attemptIndex: trial.attemptIndex, subjects: measuredSubjects, encodedBytes: encode?.bytes ?? null,
      condition: encode == null || measuredSubjects == null ? "unobserved" : within ? "withinAllowance" : "outOfAllowance" };
  });
  const liveness = { pings: injector.meter.pings, frames: injector.meter.frames, maxFrameGapMs: injector.meter.maxFrameGapMs };
  const record = { label, population, run, spec, backendOnly: backend, notification: ctx.notification, notificationNote: ctx.notification === "silent" ? SILENT_NOTE : null, ufAllowance, channels,
    chromeActivation, focusLostAtSend: trials.filter((t) => t.focusAtSend === false).length,
    nodeVersion: hostIndex.meta?.nodeVersion ?? null, hostExit: status.hostExit, hostError: status.hostError, teardownErrors, startedWallMs: started.wallMs,
    // durationMs は試行ループの終わりまで、totalMs は終了処理と trace 解析・組み立てを含む run 全体（予備から stopCondition を積むときはこちら）。
    durationMs: finishedHr - started.hrMs, totalMs: hrMs() - started.hrMs, stopped, attempts: trials.length, established, liveness, others, trials,
    // AC13(7): warm-up の後で予測値が無かった（parse 開始の分かった試行が 10 に満たなかった）母集団 2 の試行の数。送り方は実送信＋targetOffsetMs。
    parsePredictionMissing: population === "maxVpws50ParseStarted" ? trials.filter((t) => t.phase === "formal" && t.trigger?.predictedParseDelayMs == null).length : null,
    blocks: blocks.map(({ startedHrMs, endedHrMs, ...b }) => ({ ...b, durationMs: endedHrMs - startedHrMs })), probes: probes.map((p) => ({ probeId: p.probeId, atHrMs: p.atHrMs, attempts: p.attempts })),
    correspondences: assembled.correspondences, details: assembled.details,
    backendTrials: backend ? backendIntervals(trials, hostIndex) : null,
    ...(tsu == null ? {} : { ...tsunamiStateBreaks({ diagnostics: readDiagnosticsStrict(join(dir, "diagnostics")), trials, warmupRelease, host: hostIndex,
      eewReference: assembled.eewReference ?? [], blocks }),
      warmupRelease, eewReference: assembled.eewReference ?? [],
      // AC08 ③: C4 の初期状態（U-T の保存が無い）から起動したとき、最初の snapshot の U-T の回復状態。
      recoveryUT: firstSnapshot?.recovery?.["U-T"] ?? null }),
    hostClockOffsetSpreadMs: hostIndex.ohHi - hostIndex.ohLo, hostMemMax: hostIndex.mem.reduce((m, l) => Math.max(m, l.rss ?? 0), 0),
    publishSerialization: hostIndex.publishes.length,
    checkpoints: hostIndex.checkpoints.map((c) => ({ unit: c.unit, stage: c.stage, attemptId: c.attemptId, startMs: c.startedMonotonicMs, endMs: c.endedMonotonicMs, bytes: c.bytes, outcome: c.outcome })) };
  writeFileSync(join(dir, "run-record.json"), JSON.stringify(record));
  return { spec, label, dir, record, samples: assembled.samples, injections: assembled.injections, host: hostIndex, stopped, placeOf: injector.placeOf };
}

// P3-C6-AC06(7)・Q-C6-IMPL-AMEND: 窓の stateBreaks を host 側の記録だけから数える（ページで snapshot を見る数え方は、SSE の backpressure で
// 待機中の snapshot が最新 1 件に置き換わる（http-sse.ts）ので、超過の版が Chrome に届かず取りこぼしうる）。
// - 退去（tsunamiCapacityEvicted）・同じ秒の別内容（tsunamiRevisionConflict）: 診断の記録（persistent-diagnostic-sink の JSONL）の行。
// - U-T の容量超過・stale: 容量超過の判定は診断に行を出さず観測にも無いので、採用されなかった VTSE41（返信の processing の行はあるが、その入力の
//   U-T の generationRaised が無い）で数える。U-T の採用は必ず dirty になり世代が上がる（tsunami-unit.ts の adopt）。正式の target は staleTarget、
//   それ以外（prime・warm-up・片付け）は tsunamiCapacityExceeded（どちらも既知の初期状態が崩れた印）。
// - U-E の容量超過: U-E は Serial を進めた続報で世代を上げない（E14 の注記）ので、採用の印は同じ試行の VXSE45 の版の窓の EEW の T6 候補
//   （予想 A/B 交互なので採用されれば必ず表示が変わる）。候補が無ければ数える。runner が EEW を送らない窓は U-E の入力が無いので 0（負荷は EEW を
//   含まない凍結済みの負荷 N を継ぎ、verifyFrozenP3TsunamiManifest が同一性を照らす）。
// 完全性（どれかが欠ければ stateBreaks は null で窓は未確認。「読めて 0 件」と「読めない」を分ける）: 診断の行が parse できない・オブジェクトで
// level と reason を持たない、終了要約（shutdown-summary.json）が無い・読めない・droppedDiagnostics が 4 段階すべて非負の安全な整数でないか 0 でない
// （sink の失敗と溢れは drop の件数に入る）、送った VTSE41 か VXSE45 の返信の行が無い、EEW の候補を探す trace のブロックに dataLoss がある。
const DROPPED_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
export function readDiagnosticsStrict(dir) {
  if (!existsSync(dir)) return { records: [], problems: ["diagnostics directory missing"] };
  const problems = [];
  const records = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.trim() !== "")) {
      let row;
      try { row = JSON.parse(line); } catch { problems.push(`${file}: a line does not parse`); continue; }
      // 数える判定に使う項目だけを確かめ、その値で行を組み立てる（形の合わない行を 0 件に化けさせない）。
      if (row === null || typeof row !== "object" || Array.isArray(row) || typeof row.level !== "string" || typeof row.reason !== "string") {
        problems.push(`${file}: a line is not a diagnostic record`);
        continue;
      }
      records.push({ level: row.level, reason: row.reason });
    }
  }
  let summary;
  try { summary = { value: JSON.parse(readFileSync(join(dir, "shutdown-summary.json"), "utf8")) }; } catch { problems.push("shutdown-summary.json missing or unreadable"); }
  if (summary != null) {
    const dropped = summary.value?.droppedDiagnostics;
    const counted = dropped !== null && typeof dropped === "object" && !Array.isArray(dropped)
      && DROPPED_LEVELS.every((level) => Number.isSafeInteger(dropped[level]) && dropped[level] >= 0);
    if (!counted) problems.push("shutdown summary droppedDiagnostics is not four non-negative integers");
    else if (DROPPED_LEVELS.some((level) => dropped[level] > 0)) problems.push(`shutdown summary dropped diagnostics ${JSON.stringify(dropped)}`);
  }
  return { records, problems };
}
export function tsunamiStateBreaks({ diagnostics, trials, warmupRelease = null, host, eewReference = [], blocks = [] }) {
  const problems = [...diagnostics.problems];
  const processed = new Set(host.processing.map((p) => p.inputId));
  const notAdopted = (inputId) => !host.raised.has(`${inputId}|U-T`);
  const vtse41 = [...trials.flatMap((t) => [...(t.prime?.inputId == null ? [] : [{ inputId: t.prime.inputId, target: false }]),
    { inputId: t.inputId, target: t.phase === "formal" }]), ...(warmupRelease?.inputId == null ? [] : [{ inputId: warmupRelease.inputId, target: false }])];
  const unprocessed = vtse41.filter((r) => !processed.has(r.inputId)).length;
  if (unprocessed > 0) problems.push(`${unprocessed} VTSE41 without a processing row`);
  const eew = trials.filter((t) => t.eew != null);
  const eewRows = new Map(eewReference.map((e) => [e.inputId, e]));
  const lostEew = eew.filter((t) => eewRows.get(t.eew.inputId)?.missingReason === "callbackNotReached" || !processed.has(t.eew.inputId) || blocks[t.block]?.dataLoss === true).length;
  if (lostEew > 0) problems.push(`${lostEew} VXSE45 whose adoption cannot be observed`);
  const reasons = (reason) => diagnostics.records.filter((d) => d.reason === reason).length;
  const stateBreaks = problems.length > 0 ? null : {
    tsunamiCapacityEvicted: reasons("tsunamiCapacityEvicted"), tsunamiRevisionConflict: reasons("tsunamiRevisionConflict"),
    tsunamiCapacityExceeded: vtse41.filter((r) => !r.target && notAdopted(r.inputId)).length,
    staleTarget: vtse41.filter((r) => r.target && notAdopted(r.inputId)).length,
    eewCapacityExceeded: eew.filter((t) => eewRows.get(t.eew.inputId)?.missingReason === "paintNotObserved").length,
  };
  return { stateBreaks, stateBreaksIncomplete: problems };
}

// P3-C6-POP-SHAPE=A・Q-C6-IMPL-AMEND (12): 正式の試行の遷移。割り当てに届いていない遷移のうち、成立した件数がいちばん少ないもの（同数なら系列の順）。
export function nextTransition(transitions, quotas, established) {
  const open = transitions.filter((t) => (established.get(t) ?? 0) < quotas[t]);
  return (open.length === 0 ? transitions : open).reduce((best, t) => ((established.get(t) ?? 0) < (established.get(best) ?? 0) ? t : best));
}

// 津波の parse 直後・encode 直後で、対象の区間（parse・引き金の保存の encode）の行を待つ上限。encode の行は保存の全体と launcher の 250ms の
// flush の後に出る（予備で引き金から 1 秒以内）ので、3 秒で来なければ予測が外れたとみなす。
export const TARGET_WAIT_MS = 3000;
export function settleDone({ established, complete, offset, target, sentHrMs, nowHrMs, settleBy }) {
  const targetMissed = offset && target == null && sentHrMs != null && nowHrMs > sentHrMs + TARGET_WAIT_MS;
  return established || complete || targetMissed || nowHrMs > settleBy;
}

// AC13(7): 末尾の 2×count 試行（既定 20）のうち、parse 開始の分かった新しい方から count 試行（既定 10）の「parse 開始 − 引き金の実送信
// （host の時計へ直した値）」の中央値。直前の試行の parse 開始は観測の書出しを待つ間まだ分からないことがあり、その分を 1 つ前の試行で補う。
// 分かった試行が count に満たなければ null（その間は引き金の実送信＋targetOffsetMs で送り、warm-up の後の件数は parsePredictionMissing に残す）。
// AC13(7): 母集団 2 の EEW を送る時刻（投入側の時計）。予測値は試行の記録（trigger.predictedParseDelayMs）に残す。
export function calibratedSendAt(trigger, predicted, targetOffsetMs) {
  trigger.predictedParseDelayMs = predicted;
  return trigger.injectedHrMs + (predicted ?? 0) + targetOffsetMs;
}

export function predictParseDelay(trials, parseStarts, ohLo, count = 10) {
  if (ohLo == null) return null;
  const delays = [];
  for (let i = trials.length - 1; i >= Math.max(0, trials.length - 2 * count) && delays.length < count; i--) {
    const trigger = trials[i].trigger;
    const start = trigger?.inputId == null ? undefined : parseStarts.get(trigger.inputId);
    if (start != null && trigger.injectedHrMs != null) delays.push(start - (trigger.injectedHrMs + ohLo));
  }
  if (delays.length < count) return null;
  delays.sort((a, b) => a - b);
  return (delays[Math.floor((count - 1) / 2)] + delays[Math.ceil((count - 1) / 2)]) / 2;
}

const VPWS50_TRIGGERED = new Set(["maxVpws50ParseStarted", "maxVpws50ReceivedThenEew"]);

// AC08 の前景の条件（P3-C4 工程2d）。blur と visibilitychange はページを開いたときから壁時計の時刻付きで貯め続ける（投入の後に記録を
// 始めると、投入から開始の evaluate が届くまでの blur を落とす。工程2d の再確認 T2）。投入の直後に visibility・focus・motion を取り、
// 試行の終わり（paint か期限）に終わりの時刻までの記録を取り出して捨て、投入の時刻（runner の Date.now()。Chrome と同じ機械の壁時計）
// 以降の分で判定する。条件逸脱（成立させない）は、投入の時点で visible でないか、motion が manifest と違う（openPage の固定が効いていない）か、
// 投入から終わりまでに blur か visibilitychange があったか、記録が無い（ページが作り直された）とき。document.hasFocus() は OS の key window
// にも左右され、描画と timer の間引きの条件より厳しいので、false でも記録だけにする（trial.focusAtSend）。
// 壁時計が試行の間に跳ぶと、時刻での切り出しが投入の後の記録を落とす（工程2d の再確認 U1）。runner の Date.now() と単調時計の差の変化が
// CLOCK_STEP_MS を超えた試行は逸脱にする（ページと runner は同じ機械の壁時計なので、跳びは runner の側でも同じ量だけ見える）。
// 閾値より小さい跳び（NTP の slew を含む）で投入の直後の記録を落とさないよう、切り出しは投入の CLOCK_STEP_MS 前から数える（多めに逸脱に寄せる）。
const CLOCK_STEP_MS = 20;
const INSTALL_TRIAL_WATCH = `(() => {
  window.fleqTrialWatch = [];
  window.addEventListener("blur", () => window.fleqTrialWatch.push([Date.now(), "blur"]));
  document.addEventListener("visibilitychange", () => window.fleqTrialWatch.push([Date.now(), "visibilitychange:" + document.visibilityState]));
})()`;
const STATE_AT_SEND = `({ visibility: document.visibilityState, focus: document.hasFocus(), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches })`;
const takeTrialWatch = (endWallMs) => `(() => {
  const all = window.fleqTrialWatch;
  if (all == null) return null;
  window.fleqTrialWatch = all.filter(([t]) => t > ${endWallMs});
  return all.filter(([t]) => t <= ${endWallMs});
})()`;
// 試行の終わりの壁時計と単調時計は、ページへの問い合わせを待つ前に続けて取る（投入の側と同じ形。待った後に取ると、CDP の応答の遅れを
// 時計の跳びと取り違え、負荷のかかった試行だけを逸脱にする。工程2d の再確認 U1）。
export async function trialWatchAtEnd(evaluate, sentSkewMs) {
  const endWallMs = Date.now();
  const clockStepMs = Math.abs(endWallMs - performance.now() - sentSkewMs);
  return { events: await evaluate(takeTrialWatch(endWallMs)), clockStepMs };
}
export function trialConditionDeviation(state, motion, events = [], sentWallMs = -Infinity, clockStepMs = 0) {
  const during = events?.filter(([t]) => t >= sentWallMs - CLOCK_STEP_MS).map(([, type]) => type);
  const problems = [state?.visibility === "visible" ? null : `visibility ${state?.visibility}`,
    state?.reducedMotion === (motion === "reduced") ? null : `prefers-reduced-motion ${state?.reducedMotion} (manifest motion ${motion})`,
    during == null ? "the trial watch is missing (the page was reloaded)" : during.length === 0 ? null : `during the trial: ${during.join(",")}`,
    clockStepMs > CLOCK_STEP_MS ? `the wall clock stepped by ${Math.round(clockStepMs)}ms during the trial` : null].filter((p) => p != null);
  return problems.length === 0 ? null : problems.join("; ");
}

// 窓 1 本の条件。lead と対象の区間は manifest の母集団の条件から読む（P3-C4-AC13(1)。正式も予備も同じで、予備の --save-lead-ms などは
// 予備の案の manifest に入る）。
export function populationSpec(manifest, population, run, warmup, count, stop) {
  const c = manifest.populations[population];
  // 津波の parse 直後・encode 直後は C4 の startOffset を入れ子に持つ（P3TsunamiEstablishment）。
  const offset = c.establishment.kind === "startOffset" ? c.establishment : c.establishment.kind === "primeSettledStartOffset" ? c.establishment.startOffset : null;
  return { population, run, warmup, count, periodMs: c.periodMs, targetOffsetMs: offset?.targetOffsetMs ?? 0,
    establishment: c.establishment, forecast: c.forecast ?? null, stop, load: c.load, stateKey: /#populations\.(.+)$/.exec(c.stateRef)[1],
    leadMs: c.triggerLeadMs, span: offset?.span ?? "population",
    tsunami: c.series == null ? null : { series: c.series, inherits: c.inheritsC4Population, transitions: c.transitions, establishment: c.establishment,
      primeLeadMs: c.primeLeadMs, eventIds: c.tsunamiEventIds, eewEventIds: c.eewEventIds } };
}

// 対象の区間（host の時計）。成立の判定（establishTrial）に渡す。host は試行の投入以後の行だけの索引でよい。
// parse は decode の観測の parse 区間（P3-C4-PARSE-MARK、工程 2 で入る。無ければ null で不成立 targetNotObserved）。衝突は VPWS50 の T1（受理の完了）。
// encode・保存・期限: 予測した tick の ±500ms（tick 周期の半分）にある checkpoint encode の開始から（保存は最後の段の終わりまで）。
// その範囲に無ければ null（targetNotObserved で待つ）。checkpoint の観測は保存全体の後と launcher の 250ms flush の後に出るので、
// 判定の時点で狙った tick の行がまだ無いことがあり、前後の tick の encode を代わりに選ばない。
// span が "encodeThroughWrite"（P3-C4-ALT-SHAPE=A、母集団 5 だけ）なら対象を保存の試行全体（encode 開始〜write 完了）にする。
export function trialTarget(population, trial, host, ohLo, span = "population") {
  const id = trial.trigger?.inputId;
  if (id == null) return null;
  if (population === "maxVpws50ParseStarted") {
    const d = host.decode.get(id);
    return d?.parseStartMs == null || d.parseEndMs == null ? null : { startMs: d.parseStartMs, endMs: d.parseEndMs };
  }
  if (population === "maxVpws50ReceivedThenEew") {
    const t1 = host.t1.get(id);
    return t1 == null ? null : { startMs: t1, endMs: t1 };
  }
  if (ohLo == null) return null;
  const unit = population === "maxWeatherCheckpointEncodeStarted" ? "U-W" : "U-F";
  const triggerHost = trial.trigger.injectedHrMs + ohLo;
  // 母集団 5 は、引き金の期限回収を含む保存だけを対象にする（P3-C4-AC03(1)）。U-F の 1 step は世代を 1 だけ上げ（dirty）、入力の採用の step は
  // その世代の generationRaised を 1 行出す。期限回収の step は generationInputIds が空なので行を出さない（owner-runtime.ts の reduceUnit）。
  // そこで「引き金の採用の世代より後で、どの入力の行も無い世代」を含む保存を、期限回収を含む保存とする。採用の保存だけ、背景の入力の保存だけ
  // （ヘルツの品質レビュー: 採用 7・背景 8 の保存）は選ばない。採用と回収がまとまった 1 回の保存は選ぶ。前提: この窓で入力によらず U-F の
  // 世代が上がるのは引き金の subject の validUntil だけ（初期状態は空で U-F に通知予約が無く、背景の subject は報告時刻を今へ動かすので
  // validUntil は 49 時間後、retainUntil は 7 日後）。採用の行が無い引き金（stale など）は対象なし。行は試行の投入以後の索引から引く。
  // 背景の受信の中で引き金を回収した世代（weather-timeseries の collect が受信の 1 回の dirty にまとめる）は入力の行を持つので選ばない
  // （安全側の取りこぼし）。行の不在を回収と読めるのは、返信がすべて反映されたときだけ: generationRaised は mailbox が完了を受けた
  // inputDone にしか出ず、そのとき processing の行も出る（host.ts の onInputDone）。T2 の行があって processing の行が無い入力が 1 つでも
  // あれば対象なし（安全側）。遅れ・停止で反映されない owner の保存は checkpoint の行自体が出ない（composition-root.ts の checkpointDone）。
  // parser が拒否した入力も T2 だけで processing が無いので対象なしになる（安全側。負荷 N の parser の拒否が 0 件であることは予備測定で確かめる）。
  let reclaimed = () => true;
  if (population === "forecastDeadlineOverlap") {
    const adopted = host.raised.get(`${id}|U-F`);
    if (adopted == null) return null;
    const processed = new Set(host.processing.map((p) => p.inputId));
    if ([...host.t2.keys()].some((inputId) => !processed.has(inputId))) return null;
    const byInput = new Set([...host.raised].flatMap(([key, generation]) => (key.endsWith("|U-F") ? [generation] : [])));
    reclaimed = (c) => { for (let g = adopted + 1; g <= c.generation; g++) if (!byInput.has(g)) return true; return false; };
  }
  // 較正した津波の encode 直後（Q-C6-IMPL-AMEND (10)）は、引き金を含む U-W の保存の encode を対象にする（近い時刻の背景の保存と取り違えない）。
  if (trial.trigger.calibrated === true) {
    const own = host.checkpoints.find((c) => c.unit === unit && c.stage === "encode" && (c.inputIds ?? []).includes(id));
    return own == null ? null : { startMs: own.startedMonotonicMs, endMs: own.endedMonotonicMs };
  }
  const encodes = host.checkpoints.filter((c) => c.unit === unit && c.stage === "encode" && c.startedMonotonicMs >= triggerHost && reclaimed(c));
  const predicted = trial.trigger.predictedTickHostMs;
  const near = predicted == null ? encodes : encodes.filter((c) => Math.abs(c.startedMonotonicMs - predicted) < 500);
  const encode = near.reduce((best, c) => (best == null || (predicted == null ? c.startedMonotonicMs < best.startedMonotonicMs
    : Math.abs(c.startedMonotonicMs - predicted) < Math.abs(best.startedMonotonicMs - predicted)) ? c : best), null);
  if (encode == null) return null;
  const stages = host.checkpoints.filter((c) => c.attemptId === encode.attemptId);
  if (population === "maxForecastCheckpointSave") return { startMs: encode.startedMonotonicMs, endMs: Math.max(...stages.map((c) => c.endedMonotonicMs)) };
  if (span === "encodeThroughWrite") {
    const write = stages.find((c) => c.stage === "write");
    return write == null ? null : { startMs: encode.startedMonotonicMs, endMs: write.endedMonotonicMs };
  }
  return { startMs: encode.startedMonotonicMs, endMs: encode.endedMonotonicMs };
}

// backend 単独の試行の区間（AC09 の記録: 実送信→T0・T0→T2・T2→T3〔採用・射影〕・T3→T4〔公開〕）。T6 は無い。
function backendIntervals(trials, host) {
  return trials.map((tr) => {
    const [t0, t1, t2] = [host.t0.get(tr.inputId), host.t1.get(tr.inputId), host.t2.get(tr.inputId)].map((v) => v ?? null);
    const key = tr.paintedVersion == null ? null : versionKey(tr.paintedVersion);
    const t3 = key == null ? null : host.t3.find((x) => x.key === key)?.ms ?? null;
    const t4 = key == null ? null : host.t4.find((x) => x.key === key)?.ms ?? null;
    const d = (a, b) => (a == null || b == null ? null : b - a);
    return { attemptIndex: tr.attemptIndex, index: tr.index, inputId: tr.inputId, completedBy: tr.completedBy ?? null, establishment: tr.establishment ?? null,
      injectedToT0UpperMs: t0 == null || tr.injectedHrMs == null || host.ohLo == null ? null : t0 - tr.injectedHrMs - host.ohLo,
      t0ToT1Ms: d(t0, t1), t0ToT2Ms: d(t0, t2), t2ToT3Ms: d(t2, t3), t3ToT4Ms: d(t3, t4), t0ToT4Ms: d(t0, t4) };
  });
}

// ── 集計 ──
// 正式 run の U-F が許容範囲の外・未観測の試行を含むか（その run の Pass は主張しない）。
const ufNotWithin = (record) => record.ufAllowance != null && record.ufAllowance.some((t) => t.condition !== "withinAllowance");
const withoutScreenshot = (record, warmup) => record.details.filter((d) => d.index >= warmup && d.sample === "linked" && !d.hasScreenshot).length;
const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const dist = (values) => { const q = values.length === 0 ? null : quantiles(values); return q == null ? null : { n: values.length, p50: round(q.p50), p99: round(q.p99), max: round(q.max) }; };
const countBy = (list, key) => list.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});

// 予備測定の 1 run（AC08 の証拠の成立・成立率・所要）。判定は summarizeP3E01 を予備の件数（warm-up・標本数）に置き換えた manifest で通すが、
// status は必ず「未確認」（judgedStatus に判定を残す）。backend 単独は T6 が無いので区間の分布だけ。
function preliminaryRun(result, manifest) {
  const { spec, record } = result;
  const formal = record.trials.filter((t) => t.phase === "formal");
  const rate = formal.length === 0 ? null : round(record.established / formal.length);
  const base = { population: spec.population, run: spec.run, status: "未確認", statusReason: "予備測定。合否・凍結値ではない", backendOnly: record.backendOnly,
    warmup: spec.warmup, count: spec.count, attempts: record.attempts, established: record.established, establishmentRate: rate,
    notEstablished: countBy(formal.filter((t) => t.establishment?.established === false), (t) => t.establishment.reason), stopped: record.stopped,
    liveness: record.liveness, durationMs: record.durationMs, totalMs: record.totalMs, msPerAttempt: round(record.durationMs / Math.max(1, record.attempts)),
    completedBy: countBy(record.trials, (t) => t.completedBy ?? "none"), hostExit: record.hostExit, parsePredictionMissing: record.parsePredictionMissing };
  if (record.backendOnly) {
    const rows = record.backendTrials.filter((t) => t.index != null && t.index >= spec.warmup);
    const of = (k) => dist(rows.map((t) => t[k]).filter((v) => v != null));
    return { ...base, intervalsMs: { injectedToT0Upper: of("injectedToT0UpperMs"), t0ToT2: of("t0ToT2Ms"), t2ToT3: of("t2ToT3Ms"), t3ToT4: of("t3ToT4Ms"), t0ToT4: of("t0ToT4Ms") },
      note: "backend 単独（Chrome なし）: T6・実送信→T6 は無い。100 件未満の p99 は観測最大として読む（RES-07）" };
  }
  const scaled = { ...manifest, warmupPerRun: spec.warmup, samplesPerRun: spec.count };
  const judged = (spec.tsunami == null ? summarizeP3E01(scaled, result.samples, result.injections)
    : summarizeP3TsunamiE01({ ...scaled, runCount: 1 }, result.samples, result.injections,
      record.stateBreaks == null ? [] : [{ population: spec.population, run: spec.run, stateBreaks: record.stateBreaks }])).runs
    .find((r) => r.population === spec.population && r.run === spec.run);
  const widths = record.correspondences.map((c) => c.intervalWidthMs);
  const tsunami = spec.tsunami == null ? {} : { stateBreaks: record.stateBreaks, warmupRelease: record.warmupRelease,
    eewReference: eewReferenceSummary(record.eewReference), stateBreaksIncomplete: record.stateBreaksIncomplete, recoveryUT: record.recoveryUT,
    primeSettledNotConfirmed: record.details.filter((d) => d.sample === "primeSettledNotConfirmedByTrace").length };
  return { ...base, ...tsunami, judgedStatus: judged?.status ?? null, judged, paintWithoutScreenshot: withoutScreenshot(record, spec.warmup),
    ufAllowance: record.ufAllowance == null ? null : countBy(record.ufAllowance, (t) => t.condition),
    clockIntervalWidthMs: dist(widths), clockProbeCount: widths.length,
    rejected: record.details.filter((d) => d.rejectedReason != null).map((d) => ({ index: d.index, reason: d.rejectedReason })) };
}

// ── 保存 ──
function writeSealed(path, object, field) {
  writeFileSync(path, sealSelfHash(`${JSON.stringify(object, null, 2)}\n`, field));
}
const pathRef = (path) => (relative(REPO, path).startsWith("..") ? path : relative(REPO, path));
const UF_NOTE = "ufNotWithinAllowance(別条件。試行単位は run-record の ufAllowance)";

// E01 の判定（summarizeP3E01 に渡した run を一度に判定する）。U-F が許容範囲を外れた正式 run は Pass を主張しない（AC01）。
// assembled は e01-assembled.json の中身（rawDir・recordRef 付き）。無い run（Blocked・未実施）は summarizeP3E01 が Blocked（投入記録なし）として扱う。
// EEW 同時の EEW の参考値（P3-C6-EEW-ORDER=A）: 正式の試行の全体（warm-up を外す）の分布と欠落の理由。試行別の値は run-record の eewReference。
function eewReferenceSummary(list) {
  const formal = list.filter((e) => e.phase === "formal");
  return { formalTrials: formal.length, upperMs: dist(formal.flatMap((e) => (e.latencyUpperMs == null ? [] : [e.latencyUpperMs]))),
    missing: countBy(formal.filter((e) => e.missingReason != null), (e) => e.missingReason) };
}

function judgeE01(manifest, assembled) {
  const samples = assembled.flatMap((a) => a.samples);
  if (manifest.schemaVersion === TSUNAMI_SCHEMA) {
    // P3-C6-AC02。原因の帰属（spec§7.6）は未達の窓の生データから統合担当が分類する（P3-C6-FAIL-PATH=A）。EEW 同時の EEW の値は参考で判定に入れない。
    const judged = summarizeP3TsunamiE01(manifest, samples, assembled.flatMap((a) => a.injections),
      assembled.flatMap((a) => (a.stateBreaks == null ? [] : [{ population: a.spec.population, run: a.spec.run, stateBreaks: a.stateBreaks }])));
    const runs = judged.runs.map((run) => {
      const a = assembled.find((x) => x.spec.population === run.population && x.spec.run === run.run);
      // 判定器の evidenceRefs（transitionQuotaUnmet など）を残し、raw の参照を足す。
      return { ...run, evidenceRefs: [...run.evidenceRefs, ...(a == null ? [] : [a.recordRef, `${a.rawDir}/run-record.json`, `${a.rawDir}/e01-assembled.json`])] };
    });
    const eewReference = assembled.filter((a) => a.eewReference?.length > 0).map((a) => ({ population: a.spec.population, run: a.spec.run, scope: "reference（判定に使わない）",
      ...eewReferenceSummary(a.eewReference) }));
    return { runs, verdict: judged.verdict, cause: null, eewReference,
      unmeasured: ["容量縮退の母集団: 未検収（期待値だけを固定、測定は P4 の容量契約、D-P3-6）", "burst・詳細射影中: 未検収（引受先 P4、P3-C6-O09-REST=A、計画§5.2）"] };
  }
  const judged = summarizeP3E01(manifest, samples, assembled.flatMap((a) => a.injections));
  const runs = judged.runs.map((run) => {
    const a = assembled.find((x) => x.spec.population === run.population && x.spec.run === run.run);
    const out = run.scope === "formal" && a?.ufNotWithin === true;
    return { ...run, status: out && run.status === "Pass" ? "未確認" : run.status,
      evidenceRefs: a == null ? [] : [a.recordRef, `${a.rawDir}/run-record.json`, `${a.rawDir}/e01-assembled.json`, ...(out ? [UF_NOTE] : [])] };
  });
  const aggregate = (list) => (list.includes("Fail") ? "Fail" : list.every((st) => st === "Pass") ? "Pass" : "未確認");
  const populations = Object.fromEntries(Object.entries(judged.verdict.populations).map(([p, st]) =>
    [p, st === "reference" ? st : aggregate(runs.filter((r) => r.population === p).map((r) => r.status))]));
  return { runs, verdict: { ...judged.verdict, populations, status: aggregate(runs.filter((r) => r.scope === "formal").map((r) => r.status)) },
    // 原因の帰属（classifyEewCause）は P2 のまま fixedBacklog の正式標本だけを見る。6 母集団の帰属は P3-C4-FAIL-PATH（工程 2）。
    cause: classifyEewCause(samples, assembled.flatMap((a) => a.processing), assembled.flatMap((a) => a.checkpoints)) };
}

// E01 の窓の期限 = stopCondition.maxDurationMs（試行ループが打ち切る）＋固定の余裕（RES-08 の読み、統合担当了承 2026-10-06）。余裕の内訳:
// 打切りの判定を通った最後の試行 ≤ 約 26 秒（周期 3 秒＋paint 待ち 10 秒＋静まり 1 秒＋成立の待ち 11 秒）、終了処理 ≤ 約 16 秒（1.5 秒＋probe＋
// host 停止 12 秒＋Chrome）、trace 解析と記録は A10b の E01 窓で 1 秒（窓の所要 − durationMs）。計約 45 秒を、trace の量と機械差
// （Pi・Mac mini）に 4 倍見て 3 分。無いと、期限が試行ループの打切りより先に発火し、stopped と生データの組み立てが残らない（品質レビュー Q2）。
const WINDOW_MARGIN_MS = 180_000;

// E01 の窓（1 run = 1 窓）。組み立て済みの samples・injections と原因帰属の入力を生データ dir に残す（窓単位の再実行後に判定を作り直すため）。
// 結果は窓 dir に書き、evidence へ写すのは runWindow（窓が成功したときだけ）。run の status は他の run に左右されないので、この run だけで判定する。
// 窓の上限時間は manifest の stopCondition.maxDurationMs（RES-08。A10 の「見込み × 2」を置き換える）。stopCondition に達した窓は Blocked。
function e01Window(spec, ctx) {
  const id = `e01-${spec.population}-run${spec.run}`;
  return {
    id,
    expectedMin: Math.ceil((spec.stop.maxDurationMs + WINDOW_MARGIN_MS) / 60_000),
    deadlineMs: spec.stop.maxDurationMs + WINDOW_MARGIN_MS,
    run: async (w) => {
      w.progress.phase = "measure";
      const result = await executeRun(spec, { ...ctx, scope: w.scope, commands: w.commands }, w.dir, w.progress);
      const assembled = { spec, rawDir: pathRef(w.dir), recordRef: w.recordRef, samples: result.samples, injections: result.injections, processing: result.host.processing,
        checkpoints: result.host.checkpoints, ufNotWithin: ufNotWithin(result.record), durationMs: result.record.durationMs, paintWithoutScreenshot: withoutScreenshot(result.record, spec.warmup),
        attempts: result.record.attempts, established: result.record.established, stopped: result.stopped,
        ...(spec.tsunami == null ? {} : { stateBreaks: result.record.stateBreaks, eewReference: result.record.eewReference }) };
      writeFileSync(join(w.dir, "e01-assembled.json"), JSON.stringify(assembled));
      if (result.stopped != null) {
        return { status: "Blocked", reason: `stopCondition reached: ${result.stopped.reason} (attempts ${result.stopped.attempts}, established ${result.stopped.established})`, resultFiles: [] };
      }
      const run = judgeE01(ctx.manifest, [assembled]).runs.find((r) => r.population === spec.population && r.run === spec.run);
      const file = join(w.dir, `result-${run.scope}-${run.population}-run${run.run}.json`);
      writeSealed(file, run, "resultSha256");
      // AC15: publish の回数・配送 JSON byte・直列化時間を E01 の各窓でも PublishCostReport として報告する（E15 も同梱）。
      if (spec.tsunami != null) return { status: run.status, resultFiles: [file] };
      const reports = hostReportsOf(join(w.dir, "host-obs.jsonl"), id, result.placeOf);
      return { status: run.status, byteViolations: reports.byteViolations, byteViolationsNote: reports.byteViolationsNote,
        resultFiles: [file, sealAux(w.dir, `aux-${id}.json`, ctx.manifest, { window: id, status: run.status, ...reports })] };
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
    try { assembled.push(readRawJson(w, "e01-assembled.json")); } catch (error) { unusable.set(w.id, String(error?.message ?? error)); }
  }
  // 判定器の runs は窓の一覧（下の runs）と別の field に置く（同じ名前で上書きすると、raw の hash の不一致で付けた未確認と窓の id・attempt が消える）。
  const { verdict, cause, runs: judgedRuns, ...extra } = judgeE01(manifest, assembled);
  const runs = windows.map((w) => {
    const a = assembled.find((x) => `e01-${x.spec.population}-run${x.spec.run}` === w.id);
    return { id: w.id, attempt: w.attempt, status: unusable.has(w.id) ? "未確認" : w.status, ...(unusable.has(w.id) ? { reason: unusable.get(w.id) } : {}),
      durationMs: a?.durationMs ?? null, paintWithoutScreenshot: a?.paintWithoutScreenshot ?? null };
  });
  return { verdict, cause, runs, ...(manifest.schemaVersion === TSUNAMI_SCHEMA ? { judgedRuns, ...extra } : {}) };
}

// 窓 dir の生データ 1 file を、窓記録の raw の sha256 と照らしてから読む（違えば throw）。
export function readRawJson(w, file) {
  const bytes = readFileSync(join(w.rawDir, file));
  if (sha256Hex(bytes) !== w.raw?.find((r) => r.file === file)?.sha256) throw new Error(`${file} sha256 differs from the window record`);
  return JSON.parse(bytes.toString("utf8"));
}

// ── 窓ループ（WP3c §2） ──
const windowName = (id, attempt) => (attempt === 1 ? id : `${id}-attempt${attempt}`);
// 窓記録は manifest ごとの dir に置き、manifestSha256 が一致するものだけを読む（別 manifest の記録を合算・再実行判定に混ぜない）。
const readWindowRecords = (dir, manifestSha256) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).filter((r) => r.manifestSha256 === manifestSha256) : []);
export const latestById = (records) => [...records.reduce((m, r) => (m.has(r.id) && m.get(r.id).attempt > r.attempt ? m : m.set(r.id, r)), new Map()).values()];
// repo 外の生データを hash で固定する: 窓 dir の下の全ファイル（下位 dir を含む。AC15 の full/・half/ の host-obs・stringify、
// E12 の old/・new/ の calls・probe・host.jsonl・heapprofile など、集計の入力になったもの）。file は窓 dir からの相対 path。
// 除くのは state/（どの深さでも）だけ: checkpoint の slot で、測定中に上書きされ続ける作業領域（集計が読むのは充填時点の中身で、
// その結果は指紋表として結果ファイルに封印済み）。一時 profile（Chrome の user-data-dir・E12 旧側の作業 dir）は os.tmpdir() に作って
// 消すので窓 dir に現れない（chrome.mjs・e12-legacy-launcher.mjs）。
export const hashRaw = (dir) => readdirSync(dir, { recursive: true }).map(String).sort()
  .filter((f) => !f.split("/").includes("state") && statSync(join(dir, f)).isFile()).map((f) => {
    const bytes = readFileSync(join(dir, f));
    return { file: f, bytes: bytes.length, sha256: sha256Hex(bytes) };
  });
let interruptWindow = null;
// 窓記録の lastProgress（投入側の meter は数値だけを写す）。
const progressOf = ({ liveness, ...rest }) => ({ ...rest, liveness: (liveness ?? []).map((m) => ({ pings: m.pings, maxFrameGapMs: m.maxFrameGapMs })) }); // SIGINT/SIGTERM のとき、今の窓の記録を "interrupted" に書き換える

// --aux の窓の選択。知らない id があれば測らずに止める（黙って 0 窓で終わると、測っていないのに成功に見える）。
export function selectAuxWindows(auxList, aux) {
  if (aux === "all") return auxList;
  const ids = aux.split(",");
  const unknown = ids.filter((id) => !auxList.some((w) => w.id === id));
  if (unknown.length > 0) throw new Error(`unknown --aux window id: ${unknown.join(",")} (known: ${auxList.map((w) => w.id).join(",")})`);
  return auxList.filter((w) => ids.includes(w.id));
}

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
  interruptWindow = () => writeRecord({ ...base, status: "Blocked", reason: "interrupted", finishedAt: new Date().toISOString(), lastProgress: progressOf(w.progress), raw: hashRaw(dir) });
  const beat = setInterval(() => progress("beat", { phase: w.progress.phase ?? null, done: w.progress.trialsStarted ?? null, total: w.progress.total ?? null }), 60_000);
  const work = Promise.resolve().then(() => win.run(w));
  let deadline;
  let outcome;
  try {
    outcome = await Promise.race([work, new Promise((_, reject) => {
      const ms = win.deadlineMs ?? win.expectedMin * 2 * 60_000;
      deadline = setTimeout(() => reject(new Error(`window deadline exceeded (${Math.round(ms / 60_000)} min${win.deadlineMs == null ? " = expected x 2" : " = stopCondition.maxDurationMs"})`)), ms);
    })]);
  } catch (error) {
    outcome = { status: "Blocked", reason: String(error?.message ?? error), error: String(error?.stack ?? error), childExit: w.progress.hostExit ?? null, lastProgress: progressOf(w.progress), resultFiles: [] };
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
  // P3-C4-RES-06: frame 間隔の最大（ping を含む）が上限以上の窓は、結果にかかわらず Blocked（生存期限の再接続が起きうる）。
  const meters = w.progress.liveness ?? [];
  const liveness = { pings: meters.reduce((a, m) => a + m.pings, 0), maxFrameGapMs: meters.reduce((a, m) => Math.max(a, m.maxFrameGapMs), 0) };
  const gapProblem = livenessBlocked(meters, manifest.liveness?.maxFrameGapMs ?? Infinity);
  if (gapProblem != null && outcome.status !== "Blocked") outcome = { ...outcome, status: "Blocked", reason: gapProblem, judgedStatus: outcome.status, resultFiles: [] };
  if (orphans.length > 0) progress("orphan", { children: orphans });
  try {
    // 窓が成功したときだけ、窓 dir の結果を evidence へ写す（Blocked になった窓の置き去り処理は evidence を触れない）。
    // 写しと記録は await を挟まない同期の塊にする（SIGINT で evidence と記録が食い違う隙を作らない）。
    const resultFiles = outcome.resultFiles.map((from) => {
      const to = join(resultsDir, basename(from).replace(/\.json$/, `${suffix}.json`));
      copyFileSync(from, to);
      return { path: pathRef(to), sha256: sha256Hex(readFileSync(to)) };
    });
    writeRecord({ ...base, ...outcome, resultFiles, liveness, finishedAt: new Date().toISOString(), raw: hashRaw(dir), orphans });
  } catch (error) {
    outcome = { status: "Blocked", reason: `window record could not be written: ${String(error?.message ?? error)}` };
    writeRecord({ ...base, ...outcome, finishedAt: new Date().toISOString(), orphans });
  }
  progress("end", { status: outcome.status, min: round((Date.now() - Date.parse(startedAt)) / 60_000), ...(outcome.reason == null ? {} : { reason: outcome.reason }) });
  return outcome.status;
}

// 合算（WP3c §1.5）: 窓の記録（全 attempt）と E01 の判定から a10-result.json の保存 text を作る純関数。evidence から毎回作り直す。
// 窓の status は記録のまま写す（Blocked を Pass・Fail に変えない、AC10）。封印は WP2 の sealSelfHash（resultSha256 だけを 0 置換した bytes の sha256）。
export function buildA10Result({ manifest, windows, e01, e02Verdict = null, schemaVersion = "p2-a10-result-v1" }) {
  const sorted = [...windows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.attempt - b.attempt));
  const latest = new Map(sorted.map((w) => [w.id, w.attempt]));
  const preflights = [...new Set(sorted.map((w) => JSON.stringify(w.preflight ?? null)))];
  const entries = sorted.map(({ preflight, ...w }) => ({ ...w, latest: latest.get(w.id) === w.attempt, preflight: preflights.indexOf(JSON.stringify(preflight ?? null)) }));
  const body = { schemaVersion, manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
    e01, e02Verdict, preflights: preflights.map((p) => JSON.parse(p)), windows: entries };
  return sealSelfHash(`${JSON.stringify(body, null, 2)}\n`, "resultSha256");
}

// 起動時の確認（WP3c §1.1）: host の Node・Chrome・OS の版を manifest と照合し、生成物の存在を確かめ、repo の状態を記録する。
// 1 つでも外れたら全窓を走らせずに止める（どの窓も同じ理由で落ちるため）。
async function preflightCheck(manifest, nodePath, nodeVersion, initialState) {
  const chrome = await chromeVersion();
  const os = `${release()} ${arch()}`;
  const distSha256 = treeSha256(DIST_TREES);
  const problems = [
    distRebuildProblem(process.env[REBUILT_DIST_ENV], distSha256),
    ...machineProblems(manifest, { nodeVersion, chromeVersion: chrome, osVersion: os, device: deviceOf() }).map((p) => `${p} (node ${nodePath})`),
    ...DIST_REQUIRED.map((p) => (existsSync(join(REPO, p)) ? null : `missing build output: ${p}`)),
    // 充填・C・E03・AC15・E12 の入力規則（frames.mjs）が凍結時と同じ bytes か（ReplayLoad は書き換え規則を持てないので recipe の hash で固定する）。
    sha256Hex(readFileSync(join(REPO, initialState.rulesSource.file))) === initialState.rulesSource.sha256 ? null
      : `${initialState.rulesSource.file} sha256 differs from initial-state rulesSource (${initialState.rulesSource.sha256})`,
    manifest.populations.forecastDeadlineOverlap == null ? null : deadlineTriggerOverlap(manifest),
  ].filter((p) => p != null);
  if (problems.length > 0) throw new Error(`preflight failed:\n  ${problems.join("\n  ")}`);
  const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
  const gitStatusPorcelain = git("status", "--porcelain");
  // 測定版は commit した状態だけ（P3-C4 工程2d）。runner 自身が書く evidence の下は除く。
  const dirty = gitStatusPorcelain.split("\n").filter((line) => line.trim() !== "" && !line.slice(3).startsWith(EVIDENCE_REL));
  if (dirty.length > 0) throw new Error(`preflight failed: the checkout is dirty outside ${EVIDENCE_REL}:\n  ${dirty.join("\n  ")}`);
  return { checkedAt: new Date().toISOString(), nodeVersion, chromeVersion: chrome, osVersion: os, dist: DIST_REQUIRED,
    gitHead: git("rev-parse", "HEAD").trim(), gitStatusPorcelain, distSha256, runnerSha256: treeSha256([RUNNER_DIR], (f) => f.endsWith(".mjs")),
    machine: { cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryBytes: totalmem() } };
}

// 機械を凍結 manifest と照合する（P3-C4 工程2d）。device は凍結の時に draft.mjs が同じ式で書いた値（CPU の model・コア数・メモリ GiB）。
// 正式の最初の窓もこれで止まるので、別の機械の最初の窓が再開の基準になることは無い。
export const deviceOf = () => `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)}GiB`;
export function machineProblems(manifest, actual) {
  return [["nodeVersion", manifest.nodeVersion], ["chromeVersion", manifest.chrome.version], ["osVersion", manifest.osVersion], ["device", manifest.device]]
    .filter(([key, frozen]) => actual[key] !== frozen).map(([key, frozen]) => `${key} is ${actual[key]}, the frozen manifest has ${frozen}`);
}

// 測定するプロセスの dist が、起動の直前に作り直したものか（工程2d の再確認 T1）。作り直しの印が無いか、作り直しの後に dist が変わっていれば止める。
const REBUILT_DIST_ENV = "FLEQ_E01_REBUILT_DIST_SHA256";
export function distRebuildProblem(rebuiltSha256, currentSha256) {
  if (rebuiltSha256 == null) return `dist was not rebuilt before this process started (${REBUILT_DIST_ENV} is unset)`;
  return rebuiltSha256 === currentSha256 ? null : `dist changed after the rebuild (${rebuiltSha256} -> ${currentSha256})`;
}

// 正式の窓の前に、この checkout の source から dist を作り直す（P3-C4 工程2d。古い dist や別の build を使わない）。作り直した dist の hash
// （preflight の distSha256）が再開の基準になる。tsc の出力は同じ source・同じ compiler なら同じなので、再開でも hash は一致する。
function rebuildDist() {
  for (const dir of DIST_TREES) rmSync(join(REPO, dir), { recursive: true, force: true });
  const tsc = join(REPO, "node_modules/.bin/tsc");
  for (const project of [[], ["--project", "reconstruction/tsconfig.json"], ["--project", "reconstruction/src/display/chrome-eew/tsconfig.json"]])
    execFileSync(tsc, project, { cwd: REPO, stdio: "inherit" });
}

// 日をまたぐ再開の照合（P3-C4 工程2d）: 同じ manifest の最初の窓の記録の preflight を基準に、測定版の commit・実行物（dist と runner）の hash・
// 機械（CPU・コア数・メモリ・OS・Node・Chrome）が同じであること。基準は manifest に置かず、最初に走った窓の記録に置く（凍結の後に決まる値）。
// 基準の無い（最初の）実行と、hash を持たない旧い記録の項目は照合しない。
const RESUME_FIELDS = ["gitHead", "distSha256", "runnerSha256", "machine", "nodeVersion", "chromeVersion", "osVersion"];
export function resumeProblems(current, records) {
  const baseline = [...records].filter((r) => r.preflight != null).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))[0]?.preflight;
  if (baseline == null) return [];
  return RESUME_FIELDS.filter((key) => baseline[key] !== undefined && JSON.stringify(current[key]) !== JSON.stringify(baseline[key]))
    .map((key) => `${key}: ${JSON.stringify(current[key])} differs from the first window's ${JSON.stringify(baseline[key])}`);
}
const EVIDENCE_REL = "reconstruction/test/eew-e01/evidence/";
const RUNNER_DIR = "reconstruction/test/eew-e01";
const DIST_TREES = ["reconstruction/dist", "dist"];
// 木の下の file（相対 path の昇順）の path と bytes の sha256。filter は file 名で選ぶ。evidence の下は含めない。
function treeSha256(roots, filter = () => true) {
  const hash = createHash("sha256");
  for (const root of roots) {
    const files = readdirSync(join(REPO, root), { recursive: true }).map(String).filter((f) => !f.startsWith("evidence") && filter(f)
      && statSync(join(REPO, root, f)).isFile()).sort();
    for (const f of files) hash.update(`${root}/${f}\0`).update(readFileSync(join(REPO, root, f)));
  }
  return hash.digest("hex");
}

// 凍結した入力の照合（AC01）: 初期入力・引き金の fixture・壁時計起点は trialSetup と manifest から取り、run の前に hash を確かめる。違えば走らせない。
const TRIGGER_AND_EEW_FIXTURES = ["37_01_01_240613_VXSE43", "15_18_01_250630_VPWS50", "15_17_01_251222_VPWW55", "81_09_01_260605_VPWP50", "81_01_04_251222_VPWP50"];
function frozenInputs(manifest, trialSetup, initialStateText) {
  if (sha256Hex(initialStateText) !== trialSetup.initialStateSha256) throw new Error("initial-state hash does not match trialSetup.initialStateSha256");
  const populations = JSON.parse(initialStateText).populations;
  // 充填・C・E03・AC15・E12・N の fixture も含め、manifest に固定した全 fixture の bytes を照合する。
  const names = new Set([...TRIGGER_AND_EEW_FIXTURES, ...Object.keys(manifest.fixtureSha256).map((id) => id.replace("test__fixtures__", ""))]);
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

// 予備測定だけのオプション。--manifest と併用すると記録先（evidence-scratch）や条件が変わり、正式窓の再実行制限を迂回できるので拒否する。
const PRELIMINARY_ONLY = /^(period|only|aux|formal-.+|ref-.+|room-.+|.+-count|e06-cycles|e07-minutes|warmup|samples|max-attempts|max-minutes|backend-only|node|runs-root|collision-verdict|establishment-rate|deadline-alternative|save-lead-ms|deadline-lead-ms|tsunami|prime-lead-ms|e14-tsunami)$/;

// 引数を読み、組み合わせの誤りをここで拒否する（子を起動する前）。
export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]);
  const preliminary = args.has("preliminary");
  if (preliminary === args.has("manifest")) throw new Error("exactly one of --manifest <path> or --preliminary is required");
  if (!preliminary) {
    const extra = [...args.keys()].filter((k) => PRELIMINARY_ONLY.test(k));
    if (extra.length > 0) throw new Error(`--${extra.join(", --")} is allowed only with --preliminary (the manifest fixes every condition)`);
  }
  const selected = args.has("windows") ? String(args.get("windows")).split(",") : null;
  if (preliminary && selected != null) throw new Error("--windows is allowed only with --manifest");
  if (selected != null && new Set(selected).size !== selected.length) throw new Error(`--windows has a duplicate id: ${selected.join(",")}`);
  const notification = args.get("notification") ?? (preliminary ? "silent" : "real");
  if (!preliminary && notification !== "real") throw new Error("--notification silent is allowed only with --preliminary (formal runs use the real backend)");
  if (notification !== "real" && notification !== "silent") throw new Error("--notification must be real or silent");
  if (args.has("room-partials") !== args.has("room-forecast")) throw new Error("--room-partials and --room-forecast go together");
  return { args, preliminary, selected, notification };
}

// signal の後始末を 1 回だけにする（端末の Ctrl-C と親からの転送で同じ signal が 2 回届く。工程2d の再確認 U2）。
export function signalStopper(stop) {
  let stopping = false;
  return () => { if (!stopping) { stopping = true; stop(); } };
}

async function main(argv) {
  const { args, preliminary, selected, notification } = parseArgs(argv);
  // 正式は dist を作り直してから、新しいプロセスで検証と測定を始める（工程2d の再確認 T1。judge.js・frozen.js などは起動時に静的 import
  // されるので、作り直した同じプロセスでは manifest の検証と集計が古い dist で動く）。子は作り直した直後の dist の hash を受け取り、preflight で照合する。
  if (!preliminary && process.env[REBUILT_DIST_ENV] == null) {
    rebuildDist();
    const child = spawn(process.execPath, [import.meta.filename, ...argv], { stdio: "inherit", env: { ...process.env, [REBUILT_DIST_ENV]: treeSha256(DIST_TREES) } });
    // 親に来た signal は子へ渡し、子の後始末を待つ（工程2d の再確認 U2。kill -INT や監督プロセスは親の pid だけに送る）。端末の Ctrl-C では
    // 子に 2 回届くが、子の後始末は 1 回だけ走る（signalStopper）。
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    process.exit(await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 130))));
  }
  // 今の窓の子を止めてから、窓の記録を "interrupted"（raw の hash 付き）に書き換える（子が書いている間に数百 MB を読まない）。
  const stop = signalStopper(() => {
    const record = () => { try { interruptWindow?.(); } catch { /* 記録の失敗で後始末を止めない */ } };
    void current.close().then(record, record).then(root.close).finally(() => process.exit(130));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  const num = (key, fallback) => (args.has(key) ? Number(args.get(key)) : fallback);
  // host は Node 22 でだけ測る（黙って別版へ切り替えない）。版は run の前に実物へ訊く。Pi 第 1 段（予備）は --node で Pi の Node 22 を渡す。
  const nodePath = args.has("node") ? String(args.get("node")) : NODE22;
  if (!existsSync(nodePath)) throw new Error(`Node 22 not found at ${nodePath}; refusing to measure with another version`);
  const nodeVersion = await new Promise((resolve, reject) => {
    const c = spawn(nodePath, ["-p", "process.version"]);
    let o = "";
    c.stdout.on("data", (d) => { o += d; });
    c.on("error", reject);
    c.on("close", () => resolve(o.trim()));
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backendOnly = args.has("backend-only");
  let manifest;
  let trialSetup;
  let initialStateText;
  let draft = null;
  const only = args.has("only") ? String(args.get("only")).split(",") : null;
  if (preliminary && args.has("tsunami")) {
    // 津波の予備（AC08）: C4 の凍結 manifest を継ぐ草案（tsunami.mjs）。primeLeadMs だけを引数で変えられる（予備で固定する値）。
    const lead = args.has("prime-lead-ms") ? Number(args.get("prime-lead-ms")) : null;
    const keys = ["escalation", "deescalation"].flatMap((s) => ["fixedBacklog", "maxVpws50ParseStarted", "maxWeatherCheckpointEncodeStarted", "eewTogether"].map((c) => `${s}:${c}`));
    draft = buildP3TsunamiManifest({ id: `p3-c6-prelim-${stamp}`, chromeVersion: await chromeVersion(), nodeVersion, osVersion: `${release()} ${arch()}`, device: deviceOf(),
      primeLeadMs: lead == null ? {} : Object.fromEntries(keys.map((k) => [k, lead])) });
    manifest = draft.manifest;
    const c4 = JSON.parse(draft.c4Text);
    const trialSetupText = readFileSync(join(REPO, c4.trialSetupRef), "utf8");
    if (sha256Hex(trialSetupText) !== manifest.trialSetupSha256) throw new Error("trialSetup bytes differ from the inherited C4 manifest");
    trialSetup = JSON.parse(trialSetupText);
    initialStateText = readFileSync(join(REPO, trialSetup.initialStateRef), "utf8");
  } else if (preliminary) {
    // 予備の案は A10 の凍結物（負荷・初期状態・fixture）を継承して組む（draft.mjs の buildP3Manifest）。backend 単独は Chrome を測らない。
    draft = buildP3Manifest({ id: `p3-prelim-${stamp}`, chromeVersion: backendOnly ? "none (backend-only)" : await chromeVersion(), nodeVersion,
      osVersion: `${release()} ${arch()}`, device: deviceOf(),
      collisionVerdict: String(args.get("collision-verdict") ?? "A"), establishmentRate: num("establishment-rate", 0.5),
      lead: { maxWeatherCheckpointEncodeStarted: num("save-lead-ms", DEFAULT_LEAD_MS.maxWeatherCheckpointEncodeStarted),
        maxForecastCheckpointSave: num("save-lead-ms", DEFAULT_LEAD_MS.maxForecastCheckpointSave), forecastDeadlineOverlap: num("deadline-lead-ms", DEFAULT_LEAD_MS.forecastDeadlineOverlap) },
      deadlineSpan: args.has("deadline-alternative") ? "encodeThroughWrite" : "population" });
    manifest = draft.manifest;
    trialSetup = JSON.parse(draft.trialSetupText);
    initialStateText = draft.initialStateText;
  } else {
    const path = String(args.get("manifest"));
    const manifestText = readFileSync(path, "utf8");
    const m0 = JSON.parse(manifestText);
    const a10Text = readFileSync(join(REPO, A10_MANIFEST), "utf8");
    const trialSetupText = readFileSync(join(REPO, m0.trialSetupRef), "utf8");
    if (m0.schemaVersion === TSUNAMI_SCHEMA) {
      // P3-C6-AC10: 津波の凍結 manifest。trialSetup は継承した C4 の凍結 manifest と同じ（verifyFrozenP3TsunamiManifest が ref と hash を照合する）。
      const verified = verifyFrozenP3TsunamiManifest({ manifestText, smokeConditionsText: readFileSync(join(REPO, m0.smokeConditionsRef), "utf8"),
        sequencesText: readFileSync(join(REPO, SEQUENCES_FILE), "utf8"), coastJsonText: canonicalCoastJson(), fixtureTexts: templateFixtureTexts(),
        contractTexts: contractTextsFor("P3-TSUNAMI-E01-001"), inherited: { manifestText: readFileSync(join(REPO, C4_MANIFEST), "utf8") } });
      if (sha256Hex(trialSetupText) !== verified.manifest.trialSetupSha256) throw new Error("trialSetup bytes differ from trialSetupSha256");
      manifest = verified.manifest;
      trialSetup = JSON.parse(trialSetupText);
    } else {
      const verified = verifyFrozenP3Manifest({ manifestText, trialSetupText, smokeConditionsText: readFileSync(join(REPO, SMOKE_FILE), "utf8"),
        sequencesText: readFileSync(join(REPO, SEQUENCES_FILE), "utf8"),
        contractTexts: contractTextsFor("P3-E01-REACCEPT-001"),
        inherited: { manifestText: a10Text, initialStateText: readFileSync(join(REPO, JSON.parse(trialSetupText).initialStateRef), "utf8") } });
      manifest = verified.manifest;
      trialSetup = verified.trialSetup;
    }
    initialStateText = readFileSync(join(REPO, trialSetup.initialStateRef), "utf8");
  }
  const initialState = JSON.parse(initialStateText);
  const preflight = preliminary ? null : await preflightCheck(manifest, nodePath, nodeVersion, initialState);
  // 起動時の確認の後に起動する（確認で止まるときに子を残さない）。macOS 以外（Pi）では起動に失敗して何もしない。
  const caffeinate = spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});
  root.add(() => caffeinate.kill());
  const frozen = frozenInputs(manifest, trialSetup, initialStateText);
  // 窓 = 母集団 × run。正式は manifest の 3 run、参考は 1 run。予備は各 1 run で、件数（--warmup・--samples）と打切り（--max-attempts・
  // --max-minutes）だけを絞る。periodMs と負荷の再生時刻は変えない（AC08）。
  const specOf = (population, run, warmup, count, stop) => populationSpec(manifest, population, run, warmup, count, stop);
  const plan = { warmup: num("warmup", 20), samples: num("samples", 100) };
  const specs = Object.keys(manifest.populations).flatMap((population) => {
    const c = manifest.populations[population];
    if (preliminary) {
      const maxAttempts = num("max-attempts", plan.warmup + plan.samples * (c.establishment.kind === "none" ? 1 : 4));
      return [specOf(population, 1, plan.warmup, plan.samples, { maxAttempts, maxDurationMs: num("max-minutes", Math.ceil((maxAttempts * c.periodMs * 2) / 60_000) + 5) * 60_000 })];
    }
    return Array.from({ length: c.scope === "formal" ? manifest.runCount : 1 }, (_, i) => specOf(population, i + 1, manifest.warmupPerRun, manifest.samplesPerRun, c.stopCondition));
  });
  // 周期・offset が数でないと待ちが busy loop になる。1 本でも外れていたら走らせない。
  for (const s of specs) {
    if (!(Number.isFinite(s.periodMs) && s.periodMs > 0)) throw new Error(`${s.population} run${s.run}: periodMs must be finite and > 0 (got ${s.periodMs})`);
    if (!(Number.isFinite(s.targetOffsetMs) && s.targetOffsetMs >= 0)) throw new Error(`${s.population} run${s.run}: targetOffsetMs must be finite and >= 0 (got ${s.targetOffsetMs})`);
    if (!(Number.isInteger(s.stop.maxAttempts) && s.stop.maxAttempts > 0 && s.stop.maxDurationMs > 0)) throw new Error(`${s.population} run${s.run}: stopCondition must be positive`);
    if (s.leadMs != null && !(Number.isFinite(s.leadMs) && s.leadMs > 0)) throw new Error(`${s.population} run${s.run}: lead must be finite and > 0 (got ${s.leadMs})`);
  }
  const outDir = join(args.has("runs-root") ? String(args.get("runs-root")) : RUNS_ROOT, manifest.manifestId);
  mkdirSync(outDir, { recursive: true });
  // 件数を絞ったスモーク（--only / 件数指定）と backend 単独は repo の evidence に書かない。
  const aux = args.has("aux") ? String(args.get("aux")) : null;
  // --manifest の記録先は常に repo の evidence（予備専用オプションは parseArgs が拒否する）。正式窓の再実行判定は保存先に左右されない。
  const smoke = only != null || aux != null || backendOnly || ["warmup", "samples", "max-attempts", "max-minutes"].some((k) => args.has(k));
  const evidence = !preliminary ? EVIDENCE_DIR : smoke ? join(outDir, "evidence-scratch")
    : join(EVIDENCE_DIR, manifest.schemaVersion === TSUNAMI_SCHEMA ? "p3-tsunami" : "p3", "preliminary");
  mkdirSync(evidence, { recursive: true });
  const commands = [`node ${["reconstruction/test/eew-e01/run.mjs", ...argv].join(" ")}`, `caffeinate -dims -w ${process.pid}`];
  const startedAt = new Date().toISOString();
  if (draft != null) writeFileSync(join(evidence, "manifest.draft.json"), draft.manifestText);

  // 津波の template の body は manifest の fixtureSha256 から fixture 名を引く（P3-C6-SERIES-SOURCE=A。runner は区域を推測しない）。
  const fixtureByHash = new Map(Object.entries(manifest.fixtureSha256).map(([id, h]) => [h, id.replace("test__fixtures__", "")]));
  const templates = new Map((manifest.templates ?? []).map((t) => [t.transition, { ...t, primeFixture: fixtureByHash.get(t.bodySha256.prime),
    targetFixture: fixtureByHash.get(t.bodySha256.target) }]));
  const ctxFor = (spec) => ({ outDir, nodePath, notification, manifest, backendOnly, wallOriginMs: frozen.wallOriginMs, initial: frozen.initial[spec.stateKey],
    load: manifest.loads[spec.load], templates });
  const planned = specs.filter((s) => only == null || only.includes(s.population));
  // 周辺の窓（windows.mjs）。予備の --aux は件数を絞り、各 1 run。
  const counts = aux == null ? {} : { e02: num("e02-count", 60), e03: num("e03-count", 20), ac15: num("ac15-count", 5), e12: num("e12-count", 5), e06Cycles: num("e06-cycles", 2),
    e07Minutes: num("e07-minutes", 3), e14: args.has("e14-count") ? num("e14-count", 0) : undefined,
    ownerHeap: args.has("owner-heap-count") ? num("owner-heap-count", 0) : undefined, e14Tsunami: args.has("e14-tsunami") };
  // 津波の manifest は E01 の窓だけ（周辺の窓は C4 の manifest の側）。
  const auxList = manifest.schemaVersion === TSUNAMI_SCHEMA ? []
    : auxWindows({ manifest, initialState, nodePath, notification, preliminary, wallOriginMs: frozen.wallOriginMs, startHost, tailer, counts, runs: aux == null ? null : 1 });
  if (!preliminary || aux != null) {
    // 本番: 窓を順に回す 1 本のループ。窓の並びは配列 1 つ（E01 の後に周辺の窓）。予備の --aux は周辺の窓だけ。
    const windows = aux != null ? selectAuxWindows(auxList, aux)
      : [...planned.map((spec) => e01Window(spec, ctxFor(spec))), ...(only == null ? auxList : [])];
    const chosen = selected == null ? windows : selected.map((id) => windows.find((w) => w.id === id) ?? (() => { throw new Error(`unknown window: ${id}`); })());
    // 窓の記録と結果は manifest ごとに分ける（results/ は記録と混ざらないよう下の dir）。
    const recordsDir = join(evidence, "windows", manifest.manifestId);
    const resultsDir = join(recordsDir, "results");
    mkdirSync(resultsDir, { recursive: true });
    // 同じ manifestId で中身の違う manifest（再凍結）の記録があれば走らせない。再凍結には新しい manifestId を要る。
    const foreign = readdirSync(recordsDir).filter((f) => f.endsWith(".json") && JSON.parse(readFileSync(join(recordsDir, f), "utf8")).manifestSha256 !== manifest.manifestSha256);
    if (foreign.length > 0) throw new Error(`${recordsDir} has records of another manifest with the same manifestId (${foreign.join(", ")}); re-freezing needs a new manifestId`);
    // 再実行してよいのは前回 Blocked（または未実施）の窓だけ。Fail・未確認・Pass を選び直して良い run に差し替えることを構造で防ぐ。
    const problems = preflight == null ? [] : resumeProblems(preflight, readWindowRecords(recordsDir, manifest.manifestSha256));
    if (problems.length > 0) throw new Error(`resume refused (the measured version, the build or the machine changed; a commit in the measuring checkout changes gitHead):\n  ${problems.join("\n  ")}`);
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
    // E01 の合算が作れなくても、窓の記録の合算（p3-result.json）は必ず書く。
    let e01;
    try { e01 = e01Verdict(manifest, records); } catch (error) { e01 = { verdict: { label: "P3 E01", status: "未確認" }, error: String(error?.stack ?? error) }; }
    writeFileSync(join(resultsDir, "e01-verdict.json"), `${JSON.stringify({ ...e01, finishedAt: new Date().toISOString(), commands, notification }, null, 2)}\n`);
    if (manifest.schemaVersion === TSUNAMI_SCHEMA) {
      writeFileSync(join(resultsDir, "p3-tsunami-result.json"), buildA10Result({ manifest, windows: records, e01, schemaVersion: "p3-c6-result-v1" }));
      return;
    }
    // E02 は 6 run をまとめて WP2 の summarizeHealthE02 に 1 回渡す（run ごとに呼ぶと他の run が標本不足の未確認で返る）。
    const e02File = seal(join(resultsDir, "e02-verdict.json"), { ...e02Verdict(manifest, latestById(records)), finishedAt: new Date().toISOString() }, "resultSha256");
    writeFileSync(join(resultsDir, "p3-result.json"), buildA10Result({ manifest, windows: records, e01, e02Verdict: { path: pathRef(e02File), sha256: sha256Hex(readFileSync(e02File)) },
      schemaVersion: "p3-c4-result-v1" }));
    return;
  }

  const results = [];
  for (const spec of planned) {
    console.log(`[run] ${spec.population} run${spec.run}: warmup ${spec.warmup} + ${spec.count} (max ${spec.stop.maxAttempts} attempts), period ${spec.periodMs}ms${backendOnly ? ", backend only" : ""}`);
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
    console.log(`[run] ${result.label} done in ${Math.round(result.record.durationMs / 1000)}s (attempts ${result.record.attempts}, established ${result.record.established})`);
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

  // 予備測定の集計（AC08: 成立率・所要・証拠の成立）。所要の積算は「初期化＋試行の所要×(warm-up＋ceil(標本数÷成立率))＋後処理」の材料。
  const dirRel = relative(REPO, outDir).startsWith("..") ? outDir : relative(REPO, outDir);
  const summary = {
    kind: "p3-eew-e01-preliminary-v1", status: "未確認", statusReason: "予備測定。正式 E01 の合否・manifest の凍結値ではない",
    manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, startedAt, finishedAt: new Date().toISOString(), commands, plan, notification, backendOnly,
    deadlineAlternative: args.has("deadline-alternative"),
    notificationProbeNote: probeNote, environment: { node: results[0]?.record.nodeVersion, chrome: manifest.chrome.version, os: manifest.osVersion, device: manifest.device },
    rawEvidenceDir: dirRel, runs: results.map((r) => ({ ...preliminaryRun(r, manifest), host: hostReportsOf(join(r.dir, "host-obs.jsonl"), r.label, r.placeOf),
      traceBytes: r.record.blocks.reduce((a, b) => a + b.bytes, 0), traceBlocks: r.record.blocks.length, dataLoss: r.record.blocks.some((b) => b.dataLoss), channels: r.record.channels })),
  };
  writeFileSync(join(evidence, "e01-preliminary-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary.runs.map(({ host: _host, judged: _judged, ...r }) => r)));
}

// symlink 経由の起動でも走るよう、実体の path で比べる（ESM の import.meta.filename は実体の path）。
if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  const closeAll = () => current.close().then(root.close);
  main(process.argv.slice(2)).then(() => closeAll().then(() => process.exit(0)), async (error) => { console.error(error); await closeAll(); process.exit(1); });
}
