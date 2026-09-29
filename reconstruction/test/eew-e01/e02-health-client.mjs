// A10 WP3b E02（AC11・T07）: host とは別プロセスで動く独立 /healthz client。
// 確立済み keep-alive 接続で、予定時刻(開始 + i × everyMs)どおりに要求する。前の応答を待って遅らせず、
// 未完了中は別の接続を使う（http.Agent は空き接続だけ再利用し、無ければ新しく張る）。
// HealthLatencySample を返す。判定は WP2 の summarizeHealthE02 に任せる（ここで p99 を出さない）。
//
// usage: node e02-health-client.mjs --url http://127.0.0.1:PORT/healthz --count 1000 --timeout-ms 1000 --load N --run 1 --out samples.jsonl
import { Agent, get } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseFlags } from "./aux-measures.mjs";

const WORKERS = new Set(["healthy", "stalled", "stopped", "unresponsive"]);

// 本文が /healthz の形か（transport:"ok"・worker 状態・ready:boolean）。worker は不正でも取れれば残す。
function parseBody(text) {
  try {
    const body = JSON.parse(text);
    const worker = WORKERS.has(body?.worker) ? body.worker : null;
    return { worker, valid: body?.transport === "ok" && worker != null && typeof body.ready === "boolean" };
  } catch { return { worker: null, valid: false }; }
}

// onSample は標本が確定するたびに呼ばれる（CLI が 1 行ずつ追記し、長い run が中断されても失われない）。
export async function runHealthClient({ url, count, everyMs = 1000, timeoutMs, load, run, onSample }) {
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const request = (sample) => new Promise((done) => {
    let settled = false;
    const finish = (patch) => { if (settled) return; settled = true; clearTimeout(timer); done({ ...sample, ...patch }); };
    const timer = setTimeout(() => { req.destroy(); finish({ bodyCompleteMonotonicMs: null, failure: "timeout" }); }, timeoutMs);
    sample.requestStartMonotonicMs = performance.now();
    const req = get(url, { agent }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bodyCompleteMonotonicMs = performance.now();
        const { worker, valid } = parseBody(Buffer.concat(chunks).toString("utf8"));
        const httpStatus = response.statusCode ?? null;
        finish({ bodyCompleteMonotonicMs, httpStatus, worker, failure: httpStatus !== 200 ? "non200" : valid ? null : "invalidBody" });
      });
      // 本文が終わる前に接続が切れた。
      response.on("aborted", () => finish({ bodyCompleteMonotonicMs: null, httpStatus: response.statusCode ?? null, failure: "bodyIncomplete" }));
      response.on("error", () => finish({ bodyCompleteMonotonicMs: null, httpStatus: response.statusCode ?? null, failure: "bodyIncomplete" }));
    });
    req.on("error", () => finish({ bodyCompleteMonotonicMs: null, failure: "bodyIncomplete" }));
  });

  // 確立済み接続を 2 本用意してから始める（初回の接続確立を標本に入れない）。標本には数えない。
  const warm = () => new Promise((done) => get(url, { agent }, (r) => { r.resume(); r.on("end", done); r.on("error", done); r.on("aborted", done); }).on("error", done));
  await Promise.all([warm(), warm()]);

  const start = performance.now();
  const pending = [];
  for (let i = 0; i < count; i++) {
    const scheduledMonotonicMs = start + i * everyMs;
    await new Promise((wake) => setTimeout(wake, Math.max(0, scheduledMonotonicMs - performance.now())));
    pending.push(request({ load, run, sampleIndex: i, scheduledMonotonicMs, requestStartMonotonicMs: 0,
      bodyCompleteMonotonicMs: null, httpStatus: null, worker: null, failure: null }).then((sample) => { onSample?.(sample); return sample; }));
  }
  const samples = await Promise.all(pending);
  agent.destroy();
  return samples;
}

if (process.argv[1] != null && import.meta.filename === process.argv[1]) {
  const values = parseFlags(process.argv.slice(2));
  const positive = (name) => { const n = Number(values[name]); if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`); return n; };
  if (values.url == null || values.out == null) throw new Error("--url and --out are required");
  if (values.load !== "N" && values.load !== "P") throw new Error("--load must be N or P");
  const run = positive("run");
  if (run > 3) throw new Error("--run must be 1..3");
  const args = { url: values.url, count: positive("count"), everyMs: values["every-ms"] == null ? 1000 : positive("every-ms"), timeoutMs: positive("timeout-ms"), load: values.load, run };
  // 開始と終了の hrtime を 1 行ずつ残す（E05 を同じ窓で切るために launcher の clock 行へ写す）。標本は確定順に追記する。
  const line = (row) => appendFileSync(values.out, `${JSON.stringify(row)}\n`);
  writeFileSync(values.out, "");
  line({ t: "start", hrtimeNs: process.hrtime.bigint().toString() });
  await runHealthClient({ ...args, onSample: line });
  line({ t: "end", hrtimeNs: process.hrtime.bigint().toString() });
}
