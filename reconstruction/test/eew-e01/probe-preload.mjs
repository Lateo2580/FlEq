// A10 WP3b/WP3c: 製品 src を変えずに host/旧側の外から測る preload。`node --import <this> ...` で先に読ませる。env ごとに独立。
//   FLEQ_PROBE_OUT（E12）: GC entry を集めて JSON へ書く。heap の前後は replay 区間で取る（旧側 launcher と host の mem 行・ownerHeap の行）。
//   FLEQ_STRINGIFY_OUT（AC15）: JSON.stringify を包み、呼出しごとの記録を JSON Lines へ追記する（下）。
// どちらの env も無ければ何もしない。
// Worker は親の execArgv（--import）と env を引き継ぐので、owner の thread（C3a）でも読まれる。thread ごとに place（main は "publisher"、
// owner は workerData.place）を付け、時刻は publisher の performance.now() の基準へ直す（owner の performance.now() は thread ごとの
// timeOrigin が起点なので、そのままでは publisher の区間と比べられない）。
import { appendFileSync, writeFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { isMainThread, workerData } from "node:worker_threads";

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
  const flush = () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    appendFileSync(stringifyOut, `${rows.map((row) => original(row)).join("\n")}\n`);
  };
  // owner は terminate() で終わり exit で書き出せないので短い間隔で書く（AC15 の窓は最後の区間の終わりから 500ms 後に止める）。
  setInterval(flush, isMainThread ? 1_000 : 250).unref();
  process.on("exit", flush);
}
