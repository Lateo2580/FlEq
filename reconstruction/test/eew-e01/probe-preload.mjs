// A10 WP3b/WP3c: 製品 src を変えずに host/旧側の外から測る preload。`node --import <this> ...` で先に読ませる。env ごとに独立。
//   FLEQ_PROBE_OUT（E12）: GC entry を集め、終了時に 1 つの JSON へ書く。heap の前後は replay 区間で取る（旧側 launcher と host の mem 行）。
//   FLEQ_STRINGIFY_OUT（AC15）: JSON.stringify を包み、呼出しごとの記録を JSON Lines へ追記する（下）。
// どちらの env も無ければ何もしない。
import { appendFileSync, writeFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";

const out = process.env.FLEQ_PROBE_OUT;
if (out != null) {
  const probe = { schemaVersion: "p2-probe-v1", nodeVersion: process.version, gc: [] };
  const record = (e) => probe.gc.push({ kind: e.detail?.kind ?? e.kind, startMs: e.startTime, durationMs: e.duration });
  const observer = new PerformanceObserver((list) => list.getEntries().forEach(record));
  observer.observe({ entryTypes: ["gc"] });
  process.on("exit", () => {
    observer.takeRecords().forEach(record);
    writeFileSync(out, JSON.stringify(probe));
  });
}

// P2-A10-AC15: 受信 1 回の上流全量直列化の回数と対象。無いと、観測口（P2HostObservation）に直列化が無いので数えられない。
// 1 行 = [開始 performance.now(), 所要 ms, 出力の文字数, 指紋] と、UTF-8 で 64KiB を超えた呼出しだけ 5 番目に stack の先頭 3 frame。
// 指紋 = 引数の最上位の key を並びのまま "," で繋いだもの（配列は "[" + 先頭要素の key、primitive は "#<型>"）。並べ替え・分類は判定側（ac15.mjs）。
// hot path は最上位の key 数に比例（深く走査しない）。戻り値と例外は元の JSON.stringify のまま。書き出しは 1 秒の timer（unref）と exit。
const stringifyOut = process.env.FLEQ_STRINGIFY_OUT;
if (stringifyOut != null) {
  writeFileSync(stringifyOut, ""); // 同じパスの前の run の行を混ぜない
  const original = JSON.stringify;
  const keysOf = (value) => (value !== null && typeof value === "object" ? Object.keys(value).join(",") : `#${value === null ? "null" : typeof value}`);
  let pending = [];
  JSON.stringify = function stringify(value, replacer, space) {
    const startedMs = performance.now();
    const text = original(value, replacer, space);
    const durationMs = performance.now() - startedMs;
    const length = text === undefined ? 0 : text.length;
    const row = [startedMs, durationMs, length, Array.isArray(value) ? `[${keysOf(value[0])}` : keysOf(value)];
    // 文字数 × 3 が 64KiB 以下なら UTF-8 でも超えない。超えうるものだけ byte を数える。
    if (length * 3 > 65_536 && Buffer.byteLength(text) > 65_536) row.push(new Error().stack.split("\n").slice(2, 5).map((line) => line.trim()));
    pending.push(row);
    return text;
  };
  const flush = () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    appendFileSync(stringifyOut, `${rows.map((row) => original(row)).join("\n")}\n`);
  };
  setInterval(flush, 1_000).unref();
  process.on("exit", flush);
}
