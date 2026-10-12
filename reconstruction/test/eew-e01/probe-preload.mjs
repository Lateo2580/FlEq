// A10 WP3b/WP3c: 製品 src を変えずに host/旧側の外から測る preload。`node --import <this> ...` で先に読ませる。env ごとに独立。
//   FLEQ_PROBE_OUT（E12）: GC entry を集めて JSON へ書く。heap の前後は replay 区間で取る（旧側 launcher と host の mem 行・ownerHeap の行）。
//   FLEQ_STRINGIFY_OUT（AC15）: JSON.stringify を包み、呼出しごとの記録を JSON Lines へ追記する（下）。
// どの env も無ければ何もしない。FLEQ_MEM_OUT・FLEQ_MEM_GC（P3-E05C の 200ms 観測と強制 GC）は末尾。
// Worker は親の execArgv（--import）と env を引き継ぐので、owner の thread（C3a）でも読まれる。thread ごとに place（main は "publisher"、
// owner は workerData.place）を付け、時刻は publisher の performance.now() の基準へ直す（owner の performance.now() は thread ごとの
// timeOrigin が起点なので、そのままでは publisher の区間と比べられない）。
import { appendFileSync, writeFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { BroadcastChannel, isMainThread, workerData } from "node:worker_threads";

const place = isMainThread ? "publisher" : String(workerData?.place ?? "worker");
const toPublisherMs = (ms) => (isMainThread || typeof workerData?.publisherTimeOriginMs !== "number" ? ms : ms + performance.timeOrigin - workerData.publisherTimeOriginMs);

const out = process.env.FLEQ_PROBE_OUT;
if (out != null) {
  // E12（P3-C4 工程2d）: owner は terminate() で終わり exit の handler が走らないので、owner は 500ms ごとに自分の file
  // （<out の .json の前>-<place>.json）を書き直し、書いた時刻（writtenAtMs、publisher の基準）を載せる。集計は replay の終わり以後に
  // 書かれた file だけを完全とみなす。publisher は従来どおり終了時に out へ書く。
  const file = isMainThread ? out : out.replace(/\.json$/, `-${place}.json`);
  const probe = { schemaVersion: "p2-probe-v1", nodeVersion: process.version, place, gc: [], writtenAtMs: null };
  const record = (e) => probe.gc.push({ kind: e.detail?.kind ?? e.kind, startMs: toPublisherMs(e.startTime), durationMs: e.duration });
  const observer = new PerformanceObserver((list) => list.getEntries().forEach(record));
  observer.observe({ entryTypes: ["gc"] });
  const write = () => {
    observer.takeRecords().forEach(record);
    probe.writtenAtMs = toPublisherMs(performance.now());
    writeFileSync(file, JSON.stringify(probe));
  };
  if (!isMainThread) setInterval(write, 500).unref();
  process.on("exit", write);
}

// P2-A10-AC15: 受信 1 回の上流全量直列化の回数と対象。無いと、観測口（P2HostObservation）に直列化が無いので数えられない。
// 1 行 = [開始（publisher の performance.now() の基準）, 所要 ms, 出力の文字数, 指紋, stack（UTF-8 で 64KiB を超えた呼出しだけ先頭 3 frame、
// ほかは null）, 実行場所（"publisher" か owner の place）]。実行場所は、保存の区間による除外を同じ thread の保存に限るため（ac15.mjs）。
// 指紋 = 引数の最上位の key を並びのまま "," で繋いだもの（配列は "[<要素数>]" + 先頭要素の key、primitive は "#<型>"）。並べ替え・分類は判定側（ac15.mjs）。
// hot path は最上位の key 数に比例（深く走査しない）。戻り値と例外は元の JSON.stringify のまま。書き出しは 1 秒の timer（unref）と exit。
const stringifyOut = process.env.FLEQ_STRINGIFY_OUT;
if (stringifyOut != null) {
  if (isMainThread) writeFileSync(stringifyOut, ""); // 同じパスの前の run の行を混ぜない（owner は後から起動するので消さない）
  const original = JSON.stringify;
  const keysOf = (value) => (value !== null && typeof value === "object" ? Object.keys(value).join(",") : `#${value === null ? "null" : typeof value}`);
  let pending = [];
  JSON.stringify = function stringify(value, replacer, space) {
    const startedMs = performance.now();
    const text = original(value, replacer, space);
    const durationMs = performance.now() - startedMs;
    const length = text === undefined ? 0 : text.length;
    // 文字数 × 3 が 64KiB 以下なら UTF-8 でも超えない。超えうるものだけ byte を数える。
    const stack = length * 3 > 65_536 && Buffer.byteLength(text) > 65_536 ? new Error().stack.split("\n").slice(2, 5).map((line) => line.trim()) : null;
    pending.push([toPublisherMs(startedMs), durationMs, length, Array.isArray(value) ? `[${value.length}]${keysOf(value[0])}` : keysOf(value), stack, place]);
    return text;
  };
  // owner は書き出すたびに（行が無くても）<FLEQ_STRINGIFY_OUT>.<place>.written へ書いた時刻（publisher の基準）を書く。terminate() で止まると
  // 最後の書き出しの分が失われうるので、集計はこの時刻が窓の終わりより前の owner を未確認にする（P3-C4 工程2d、E12 の writtenAtMs と同じ形）。
  const flush = () => {
    if (pending.length > 0) {
      const rows = pending;
      pending = [];
      appendFileSync(stringifyOut, `${rows.map((row) => original(row)).join("\n")}\n`);
    }
    if (!isMainThread) writeFileSync(`${stringifyOut}.${place}.written`, String(toPublisherMs(performance.now())));
  };
  // owner は terminate() で終わり exit で書き出せないので短い間隔で書く（AC15 の窓は最後の区間の終わりから 500ms 後に止める）。
  setInterval(flush, isMainThread ? 1_000 : 250).unref();
  process.on("exit", flush);
}

// P3-E05C-AC01: FLEQ_MEM_OUT（出力の前置き）があるときだけ、thread ごとに 200ms の memoryUsage と GC の entry を <FLEQ_MEM_OUT>.<place>.jsonl へ
// 追記する。1 行 = memoryUsage() 1 回と配列への追加（P3-E05C-RES-01）。処理中の thread は timer が遅れるので間を埋めない。書き出しと .written は
// FLEQ_STRINGIFY_OUT と同じ形（owner は terminate() で止まり exit で書けない）。
// P3-E05C-AC02: FLEQ_MEM_GC（JSON {thresholdBytes, rearmBelowBytes, maxForced, baselineEveryMs}）があるときだけ強制 GC をかける。決めるのは
// publisher だけで、BroadcastChannel で owner 3 本へ送り、自分も同じ手順を踏む。SIGUSR2 は区切りの GC（handler の無い process に送ると既定の
// 動作で終わるので、FLEQ_MEM_GC のときだけ受ける）。
const memOut = process.env.FLEQ_MEM_OUT;
if (memOut != null) {
  const now = () => toPublisherMs(performance.now());
  const usage = () => {
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
  };
  let pending = [{ k: "start", place, atMs: now(), nodeVersion: process.version, gcAvailable: typeof globalThis.gc === "function" }];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) pending.push({ k: "gc", place, atMs: toPublisherMs(e.startTime), kind: e.detail?.kind ?? e.kind, durationMs: e.duration });
  }).observe({ entryTypes: ["gc"] });
  // 1 回の要求で 3 点（前→通常の major→中→last-resort→後）。RSS の戻りは last-resort の後で見る（通常の gc() は page を OS へ返さないことが
  // 多い、P3-E05C-GC-PROBE）。受けた遅れは startMs − requestedAtMs のまま残す。flavor を受けない版の例外は error に残す（AC07(d)）。
  const forceGc = ({ id, reason, requestedAtMs }) => {
    const row = { k: "forcedGc", place, id, reason, requestedAtMs, startMs: now() };
    try {
      row.before = usage();
      let t = performance.now();
      globalThis.gc();
      row.regularMs = performance.now() - t;
      row.afterRegular = usage();
      t = performance.now();
      globalThis.gc({ type: "major", execution: "sync", flavor: "last-resort" });
      row.lastResortMs = performance.now() - t;
      row.afterLastResort = usage();
    } catch (error) { row.error = String(error?.message ?? error); }
    row.endMs = now();
    pending.push(row);
  };
  const gcConfig = process.env.FLEQ_MEM_GC == null ? null : JSON.parse(process.env.FLEQ_MEM_GC);
  const channel = gcConfig == null ? null : new BroadcastChannel("fleq-mem-gc");
  channel?.unref();
  let decide = () => {};
  if (channel != null && !isMainThread) channel.onmessage = (event) => forceGc(event.data);
  if (channel != null && isMainThread) {
    let nextId = 1;
    let armed = true;
    // 閾値の GC は区切りの GC を 2 回受けた後（測定の開始の前）からだけ撃つ。充填の間に撃つと測定の前に床が下がり、測定の中の山が
    // 閾値に届かない（Q-E05C-GC-ARM）。
    let phases = 0;
    let forced = 0;
    let lastForcedMs = -Infinity;
    let baselineDueMs = now() + gcConfig.baselineEveryMs;
    // BroadcastChannel は送った側の自分には届かないので、publisher は送った後に自分で同じ手順を踏む。
    const request = (reason) => {
      const message = { id: nextId++, reason, requestedAtMs: now() };
      lastForcedMs = message.requestedAtMs;
      channel.postMessage(message);
      forceGc(message);
    };
    // 閾値は 1 つの山に 1 回（rearm 未満に下がるまで撃たない）、上限を超えた山は capped の行だけ。基準は周期が来たら、rss＜rearm で直前の
    // 強制 GC から 10 秒以上のときに撃ち、満たさなければ次の行で判定し直す（自然の GC は「直前の強制 GC」に含めない）。
    decide = (atMs, rss) => {
      if (rss < gcConfig.rearmBelowBytes) armed = true;
      if (phases >= 2 && armed && rss >= gcConfig.thresholdBytes) {
        armed = false;
        if (forced < gcConfig.maxForced) { forced += 1; request("threshold"); } else pending.push({ k: "capped", place, atMs });
      } else if (atMs >= baselineDueMs && rss < gcConfig.rearmBelowBytes && atMs - lastForcedMs >= 10_000) {
        baselineDueMs = atMs + gcConfig.baselineEveryMs;
        request("baseline");
      }
    };
    process.on("SIGUSR2", () => {
      phases += 1;
      request("phase");
    });
  }
  setInterval(() => {
    const atMs = now();
    const m = usage();
    pending.push({ k: "mem", place, atMs, ...m });
    decide(atMs, m.rss);
  }, 200).unref();
  const flushMem = () => {
    if (pending.length > 0) {
      const rows = pending;
      pending = [];
      appendFileSync(`${memOut}.${place}.jsonl`, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    }
    if (!isMainThread) writeFileSync(`${memOut}.${place}.written`, String(now()));
  };
  setInterval(flushMem, isMainThread ? 1_000 : 250).unref();
  process.on("exit", flushMem);
}
