#!/usr/bin/env node
// usage: node scripts/replay-bench.mjs [--eew N] [--interval MS] [--no-big] [--with-display] [--json]
//
// WebSocket 受信ハンドラ (createMessageHandler().handler) を実時間で叩き、
// 「decode → gunzip → XML parse → 状態更新 → 描画」を同一イベントループで
// 同期完走する現状のイベントループ占有を数値化する。
//
// dist/ を直接 require するため、事前に `npm run build` が必要。
// 副作用 (デスクトップ通知・通知音・repo へのファイル書き込み) は下記 §副作用の遮断 で塞ぐ。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { monitorEventLoopDelay } from "node:perf_hooks";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const FIXTURES_DIR = path.join(REPO_ROOT, "test", "fixtures");

/** EEW 続報 (VXSE45, EventID=20240417231454, Serial=26) */
const EEW_FIXTURE = "77_01_26_240613_VXSE45.xml";
/** 全国警報・注意報 (VPWS50, 約 4.5 MB) */
const BIG_FIXTURE = "15_18_01_250630_VPWS50.xml";

/** heartbeat プローブの間隔 (ms) */
const HEARTBEAT_INTERVAL_MS = 50;
/** warmup で流す EEW 報数 */
const WARMUP_REPORTS = 5;
/** warmup の注入間隔 (ms) */
const WARMUP_INTERVAL_MS = 20;
/** warmup 用の EventID (本計測と衝突させない) */
const WARMUP_EVENT_ID = "29990101000000";

// ── CLI ──

function usage() {
  process.stderr.write(
    [
      "usage: node scripts/replay-bench.mjs [options]",
      "",
      "  --eew N          EEW 続報数 (default 100)",
      "  --interval MS    注入間隔 (default 200)",
      "  --no-big         VPWS50 (4.5MB) の注入を省略",
      "  --with-display   端末描画 (display callbacks) も含めて計測",
      "  --json           機械可読 JSON を stdout に 1 行出力",
      "  --keep-artifacts 一時作業ディレクトリを削除せず残す (デバッグ用)",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const opts = {
    eew: 100,
    interval: 200,
    big: true,
    withDisplay: false,
    json: false,
    keepArtifacts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--eew") {
      opts.eew = Number(argv[++i]);
    } else if (arg === "--interval") {
      opts.interval = Number(argv[++i]);
    } else if (arg === "--no-big") {
      opts.big = false;
    } else if (arg === "--with-display") {
      opts.withDisplay = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--keep-artifacts") {
      opts.keepArtifacts = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      process.stderr.write(`不明な引数: ${arg}\n`);
      usage();
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.eew) || opts.eew < 1) {
    process.stderr.write("--eew は 1 以上の整数で指定してください\n");
    process.exit(1);
  }
  if (!Number.isFinite(opts.interval) || opts.interval < 1) {
    process.stderr.write("--interval は 1 以上で指定してください\n");
    process.exit(1);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── stdout の隔離 ──
// engine 側の console.log (logger / display formatter) はすべて stderr へ回し、
// stdout は --json の 1 行だけが載る状態に保つ。write 自体は行うので
// 「端末へ書き出すコスト」は計測から落ちない。
const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);

/** 人間可読サマリは常に stderr */
function say(line = "") {
  process.stderr.write(`${line}\n`);
}

// ── 作業ディレクトリの退避と設定の隔離 ──
// dist/engine/eew/eew-logger.js は module load 時に `process.cwd()/eew-logs` を、
// dist/engine/messages/vpwp50-detail-cache.js は constructor で `process.cwd()` 配下を
// 書き込み先に取る。require より前に cwd を OS の tmp 配下へ移し、repo と home を汚さない。
// (fixture / dist は上で絶対パス化済みなので cwd 非依存)
const ORIGINAL_CWD = process.cwd();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-replay-bench-"));

/** 一時作業ディレクトリを片付ける (cwd を戻してから消す。Windows は cwd 配下を消せない) */
function removeWorkDir() {
  try {
    if (process.cwd() !== ORIGINAL_CWD) process.chdir(ORIGINAL_CWD);
  } catch {
    // cwd が既に消えている等。rmSync は試みる
  }
  if (opts.keepArtifacts) return;
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    say(`一時ディレクトリの削除に失敗しました (手動で消してください): ${workDir}`);
    say(`  理由: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ユーザー設定の隔離。src/config.ts:38 の resolveConfigDir() は全 OS で
// XDG_CONFIG_HOME を最優先に見る (Windows の %APPDATA%/fleq より先)。CONFIG_DIR は
// module load 時に確定するので、dist を require する前に設定しないと効かない。
// これで実 config の読み込み・chmod・レガシー移行の書き込みが一切起きなくなり、
// 計測条件がご主人の通知設定に左右されなくなる。
process.env.XDG_CONFIG_HOME = workDir;

// さらに空の config.json を先置きする。loadConfig() は先頭で migrateConfigIfNeeded() を
// 呼び (config.ts:243)、CONFIG_PATH 不在なら ~/.config/fleq と ~/.config/dmdata-monitor から
// 設定を「コピーしてくる」。この環境には両方とも実在するため、XDG を移すだけでは
// 旧設定が移行されてしまい隔離が破れる。CONFIG_PATH を実在させると
// migrateConfigIfNeeded() が冒頭で早期 return する (config.ts:85) ので移行を止められる。
// 中身が {} なら validateConfig が空を返し、Notifier は DEFAULT_CONFIG のみで走る。
const ISOLATED_CONFIG_DIR = path.join(workDir, "fleq");
const ISOLATED_CONFIG_PATH = path.join(ISOLATED_CONFIG_DIR, "config.json");
fs.mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true });
fs.writeFileSync(ISOLATED_CONFIG_PATH, "{}\n", "utf-8");

process.chdir(workDir);

// ── dist のロード ──
// dist は CommonJS (tsconfig module=commonjs)。createRequire で読み、
// message-router が内部で require するのと同一のモジュールインスタンスを掴む。
const require = createRequire(import.meta.url);

function requireDist(relPath) {
  const full = path.join(DIST_DIR, relPath);
  if (!fs.existsSync(full)) {
    say(`dist が見つかりません: ${full}`);
    say("先に `npm run build` を実行してください。");
    // 計測前の setup 失敗。stdout には何も書いていないので即時終了で安全
    removeWorkDir();
    process.exit(1);
  }
  return require(full);
}

const notifierLoader = requireDist("engine/notification/node-notifier-loader.js");
const soundPlayer = requireDist("engine/notification/sound-player.js");
const messageRouter = requireDist("engine/messages/message-router.js");

// ── 副作用の遮断 ──
// 1. デスクトップ通知: Notifier.send() は loadNodeNotifier() の戻り値に notify() する。
//    override に no-op を差すと通知は飛ばないが send() の経路 (icon 解決含む) は残る。
//    null ではなく関数オブジェクトを渡すのは、null だと Notifier 側が毎回
//    再ロードを試みて log.debug を出すため。
notifierLoader.setNodeNotifierOverride({ notify: () => undefined });
// 2. 通知音: Notifier.send() の末尾は playSound(level) を直に呼ぶ。sound-player の
//    dispose() は module 内 disposed フラグを立て、以降の playSound を即 return させる。
//    Notifier.setSoundEnabled(false) は persist() でユーザーの config.json を
//    書き換えてしまうので使わない。
soundPlayer.dispose();

// ── fixture / エンベロープ ──

function readFixture(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
}

/** XML を gzip + base64 する (test/helpers/mock-message.ts の encodeXml と同じ) */
function encodeXml(xml) {
  return zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
}

/**
 * WsDataMessage エンベロープを組む。
 * 必須フィールドは src/types.ts の WsDataMessage と
 * test/helpers/mock-message.ts の createMockWsDataMessage に合わせる。
 */
function buildWsDataMessage(xml, type, classification, head) {
  const now = new Date().toISOString();
  return {
    type: "data",
    version: "2.0",
    classification,
    id: `replay-bench-${type}-${head.serial ?? "0"}`,
    passing: [{ name: "replay-bench", time: now }],
    head: {
      type,
      author: "気象庁",
      time: now,
      test: false,
      xml: true,
    },
    xmlReport: {
      control: {
        title: head.title,
        dateTime: now,
        status: "通常",
        editorialOffice: "気象庁本庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: head.title,
        reportDateTime: now,
        targetDateTime: now,
        eventId: head.eventId,
        serial: head.serial,
        infoType: "発表",
        infoKind: head.infoKind,
        infoKindVersion: "1.0_0",
        headline: null,
      },
    },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body: encodeXml(xml),
  };
}

const eewXmlBase = readFixture(EEW_FIXTURE);
if (!eewXmlBase.includes("<Serial>26</Serial>")) {
  say(`fixture ${EEW_FIXTURE} に <Serial>26</Serial> が見つかりません (置換方式が前提と違う)`);
  // 計測前の setup 失敗。stdout には何も書いていないので即時終了で安全
  removeWorkDir();
  process.exit(1);
}

/**
 * EEW 続報を組み立てる。
 * EewTracker は「XML 本文の <Serial>」で重複判定する (エンベロープ側は見ない)
 * ため、本文を書き換える。eventId も本文の <EventID> を書き換える。
 */
function buildEewMessage(serial, eventId) {
  let xml = eewXmlBase.replace("<Serial>26</Serial>", `<Serial>${serial}</Serial>`);
  if (eventId !== "20240417231454") {
    xml = xml.replace(
      "<EventID>20240417231454</EventID>",
      `<EventID>${eventId}</EventID>`,
    );
  }
  return buildWsDataMessage(xml, "VXSE45", "eew.forecast", {
    title: "緊急地震速報（地震動予報）",
    eventId,
    serial: String(serial),
    infoKind: "緊急地震速報",
  });
}

function buildBigMessage() {
  const xml = readFixture(BIG_FIXTURE);
  return {
    msg: buildWsDataMessage(xml, "VPWS50", "telegram.weather", {
      title: "全国気象警報・注意報",
      eventId: null,
      serial: null,
      infoKind: "気象警報・注意報",
    }),
    bytes: Buffer.byteLength(xml, "utf-8"),
  };
}

// ── ハンドラの構築 ──

let processedCount = 0;
const outcomeTaps = [
  () => {
    processedCount++;
  },
];

let display;
if (opts.withDisplay) {
  // ui/display-adapter の DisplayCallbacks を渡すと displayOutcome / renderSummaryLine /
  // displayRawHeader が有効になり、端末描画コストが handler の同期区間に入る
  // (monitor.ts:83 の createMessageHandler({ display, ... }) と同じ配線)。
  const displayAdapter = requireDist("ui/display-adapter.js");
  display = displayAdapter.createDisplayAdapter();
}

const handlerResult = messageRouter.createMessageHandler(
  display == null ? { outcomeTaps } : { display, outcomeTaps },
);
const handler = handlerResult.handler;

// ── 計測 ──

const histogram = monitorEventLoopDelay({ resolution: 10 });

/** handler 所要時間 (ms) */
let eewDurations = [];
let bigDuration = null;
/** heartbeat の遅れ (ms): 前回発火からの実間隔 - 公称間隔 */
let heartbeatLags = [];

let heartbeatTimer = null;
let heartbeatPrev = 0n;

function startHeartbeat() {
  heartbeatPrev = process.hrtime.bigint();
  heartbeatTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - heartbeatPrev) / 1e6;
    heartbeatPrev = now;
    heartbeatLags.push(elapsedMs - HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── 後始末 ──
// timer/histogram を止め、cwd を戻し、一時ディレクトリを消す。
// 正常終了 (finally) からも異常終了・シグナルからも同じ経路を通す。
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  stopHeartbeat();
  try {
    histogram.disable();
  } catch {
    // 未 enable / 二重 disable は無視
  }
  removeWorkDir();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    say(`\n${signal} を受信しました。後始末して終了します。`);
    cleanup();
    // 計測途中なので stdout に書きかけの JSON は無い。即時終了で安全
    process.exit(130);
  });
}

/** handler を 1 回叩き、所要時間 (ms) を返す */
function inject(msg) {
  const started = process.hrtime.bigint();
  handler(msg);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 昇順ソート済み配列からパーセンタイル値を取る */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function fmt(value) {
  if (value == null) return "-";
  return value.toFixed(2);
}

/**
 * 注入スケジュールを組んで実時間で流す。
 * 同期 for ループで流すと monitorEventLoopDelay が 1 個の巨大ブロックしか
 * 記録しないため、必ず setTimeout で実時間に散らす。
 */
function runSchedule(entries) {
  return new Promise((resolve) => {
    let remaining = entries.length;
    if (remaining === 0) {
      resolve();
      return;
    }
    for (const entry of entries) {
      setTimeout(() => {
        entry.onFire(inject(entry.msg));
        remaining--;
        if (remaining === 0) resolve();
      }, entry.atMs);
    }
  });
}

async function main() {
  const warnings = [];

  say("=== FlEq replay bench ===");
  say(`node ${process.version} / ${process.platform} / cwd(退避先)=${workDir}`);
  say(
    `設定: eew=${opts.eew} 報 / interval=${opts.interval}ms / big=${opts.big ? "on" : "off"} / display=${opts.withDisplay ? "on" : "off"}`,
  );

  // 設定隔離の実証: dist 側が解決した config ディレクトリと、実際に効いている通知設定を出す。
  // configDir が workDir 配下なら %APPDATA%/fleq (ご主人の実 config) は読まれていない。
  const distConfig = requireDist("config.js");
  const resolvedConfigDir = distConfig.getConfigDir();
  const isolated = resolvedConfigDir.startsWith(workDir);
  const effectiveNotify = handlerResult.notifier.getSettings();
  say(`config 隔離: ${isolated ? "OK" : "NG"} (configDir=${resolvedConfigDir})`);
  say(
    `  実効設定 (DEFAULT_CONFIG 相当のはず): sound=${handlerResult.notifier.getSoundEnabled()} / notify.eew=${effectiveNotify.eew} / notify.weather=${effectiveNotify.weather}`,
  );
  if (!isolated) {
    warnings.push(
      `config が隔離されていません (configDir=${resolvedConfigDir})。ユーザー設定が計測条件に混入します`,
    );
  }

  // ── warmup (JIT を温める。本計測と別 EventID なので serial は衝突しない) ──
  histogram.enable();
  startHeartbeat();

  const warmupEntries = [];
  for (let i = 1; i <= WARMUP_REPORTS; i++) {
    warmupEntries.push({
      atMs: i * WARMUP_INTERVAL_MS,
      msg: buildEewMessage(i, WARMUP_EVENT_ID),
      onFire: () => undefined,
    });
  }
  await runSchedule(warmupEntries);
  await sleep(100);

  const warmupProcessed = processedCount;
  say(`warmup: ${WARMUP_REPORTS} 報注入 / ${warmupProcessed} 件 outcome 到達`);

  // 本計測用に計測器と配列をリセット
  histogram.reset();
  processedCount = 0;
  eewDurations = [];
  heartbeatLags = [];
  heartbeatPrev = process.hrtime.bigint();

  // ── 本計測 ──
  const bigAt = opts.big ? Math.max(1, Math.floor(opts.eew / 2)) : null;
  const entries = [];
  for (let serial = 1; serial <= opts.eew; serial++) {
    entries.push({
      atMs: serial * opts.interval,
      msg: buildEewMessage(serial, "20240417231454"),
      onFire: (ms) => eewDurations.push(ms),
    });
  }

  let bigBytes = 0;
  let bigInjected = 0;
  if (bigAt != null) {
    const big = buildBigMessage();
    bigBytes = big.bytes;
    bigInjected = 1;
    entries.push({
      // N/2 報目の直後 (同一 tick に載せず独立したブロックとして観測する)
      atMs: bigAt * opts.interval + Math.max(5, Math.floor(opts.interval / 4)),
      msg: big.msg,
      onFire: (ms) => {
        bigDuration = ms;
      },
    });
  }

  const injected = opts.eew + bigInjected;
  say(`注入開始: ${injected} 件 (想定所要 ${((opts.eew + 1) * opts.interval) / 1000} 秒前後)`);

  const runStarted = process.hrtime.bigint();
  await runSchedule(entries);
  // 残りの同期処理・tap を拾うための settle
  await sleep(Math.max(500, opts.interval));
  const wallMs = Number(process.hrtime.bigint() - runStarted) / 1e6;

  stopHeartbeat();
  histogram.disable();

  // ── 集計 ──
  const loop = {
    p50: histogram.percentile(50) / 1e6,
    p90: histogram.percentile(90) / 1e6,
    p99: histogram.percentile(99) / 1e6,
    max: histogram.max / 1e6,
    mean: histogram.mean / 1e6,
  };
  const heartbeat = summarize(heartbeatLags);
  const eewStats = summarize(eewDurations);

  if (processedCount !== injected) {
    warnings.push(
      `処理件数不一致: 注入 ${injected} 件 / outcome 到達 ${processedCount} 件 (EEW dedup・parse 失敗・suppressed 等を疑う)`,
    );
  }
  if (eewDurations.length !== opts.eew) {
    warnings.push(`EEW 注入回数不一致: 期待 ${opts.eew} / 実測 ${eewDurations.length}`);
  }

  say("");
  say("--- 処理件数照合 ---");
  say(`  注入: ${injected} 件 (EEW ${opts.eew} + VPWS50 ${bigInjected})`);
  say(`  outcome 到達: ${processedCount} 件`);
  say(`  照合: ${processedCount === injected ? "OK" : "NG"}`);
  say("");
  say(`--- イベントループ遅延 (monitorEventLoopDelay, resolution 10ms) ---`);
  say(`  p50 ${fmt(loop.p50)} ms / p90 ${fmt(loop.p90)} ms / p99 ${fmt(loop.p99)} ms`);
  say(`  max ${fmt(loop.max)} ms / mean ${fmt(loop.mean)} ms`);
  say("");
  say(`--- heartbeat プローブ (${HEARTBEAT_INTERVAL_MS}ms interval の遅れ) ---`);
  if (heartbeat == null) {
    say("  サンプルなし");
  } else {
    say(
      `  p50 ${fmt(heartbeat.p50)} ms / p90 ${fmt(heartbeat.p90)} ms / p99 ${fmt(heartbeat.p99)} ms / max ${fmt(heartbeat.max)} ms (${heartbeat.count} 発火)`,
    );
  }
  say("");
  say("--- handler 所要時間 ---");
  if (eewStats == null) {
    say("  EEW: サンプルなし");
  } else {
    say(
      `  EEW (${eewStats.count} 報): p50 ${fmt(eewStats.p50)} ms / p90 ${fmt(eewStats.p90)} ms / p99 ${fmt(eewStats.p99)} ms / max ${fmt(eewStats.max)} ms`,
    );
  }
  if (bigDuration == null) {
    say("  VPWS50: 未注入");
  } else {
    say(`  VPWS50 (${bigBytes.toLocaleString("en-US")} bytes): ${fmt(bigDuration)} ms`);
  }
  say("");
  say(`実測所要: ${(wallMs / 1000).toFixed(2)} 秒`);
  if (warnings.length > 0) {
    say("");
    for (const w of warnings) {
      say(`WARNING: ${w}`);
    }
  }

  // ── engine 側リソースの解放 ──
  // process.exit() で強制終了せず自然終了させるため、保持されている timer と
  // 書き込みチェーンをすべて畳む (JSON が pipe 先で切れるのを防ぐ)。
  handlerResult.flushAndDisposeVolcanoBuffer();
  handlerResult.vpwp50Cache.flush();
  await handlerResult.eewLogger.flush();

  if (opts.json) {
    const payload = {
      config: {
        eew: opts.eew,
        intervalMs: opts.interval,
        big: opts.big,
        withDisplay: opts.withDisplay,
        configDir: resolvedConfigDir,
        configIsolated: isolated,
        node: process.version,
        platform: process.platform,
      },
      counts: {
        injected,
        processed: processedCount,
        match: processedCount === injected,
      },
      eventLoopDelayMs: loop,
      heartbeatLagMs: heartbeat,
      handlerMs: {
        eew: eewStats,
        big: bigDuration == null ? null : { ms: bigDuration, bytes: bigBytes },
      },
      wallMs,
      warnings,
    };
    realStdoutWrite(`${JSON.stringify(payload)}\n`);
  }

  if (opts.keepArtifacts) {
    say(`--keep-artifacts: 作業ディレクトリを残しました (eew-logs / data / fleq): ${workDir}`);
  }

  // process.exit() は使わない。pipe/ファイルに繋がっているとき stdout の
  // 書き出しが途中で切れうるため、exitCode だけ立てて自然終了に任せる。
  process.exitCode = warnings.length > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    say(`replay-bench が異常終了しました: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
