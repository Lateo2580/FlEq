// A10 本番 a10-p2-20260930b の AC15・E12 を、補足封印（raw-supplement.json）した生データから作り直し、repo に封印済みの
// aux-ac15.json・aux-e12-*.json と判定・数値を突き合わせる（ヘルツ最終確認 指摘 2）。読む生ファイルはすべて補足封印の sha256 と
// 照合してから使う。集計は repo の関数（ac15.mjs・aux-measures.mjs・windows.mjs の hostReports・frames.mjs）をそのまま呼ぶ。
//
// 生データに無く、封印済み結果から取る入力（窓の外で作られ、結果にそのまま書かれたもの）:
// - AC15 の指紋表（fingerprintTable）: 充填時点の state/ の envelope と HTTP /snapshot から作る。state/ は測定中に上書きされ、
//   snapshot は保存していないので、結果に封印された表を使う。
// - AC15 の保持件数（fill.observed）と firstSeq: 充填の確認で /snapshot と checkpoint から読んだ値。
// - AC15 の metadata（WS 切断）の時刻: 投入側 hrtime は保存していない。切断は予定時刻（due）の spin 直後に起きるので、
//   同じ予定表で送った data frame の host T0 から「予定表の起点の host 時刻」D = min(T0 − 予定 offset) を求め、D + 切断の予定 offset で置く。
//   誤差は投入→host の最小遅延（1ms 未満）。±5ms ずらしたときの判定（status）と数値の差も shifts に出す（感度の記録）。
// - E12 の exit（子の終了 code）: runner の戻り値で、生ファイルに無い。
//
// usage: node recompute-ac15-e12.mjs [--repo <FlEq checkout>]   （既定 /Users/sayue/dev/FlEq。repo は読むだけ。dist の build が要る）
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const RUN_ID = "a10-p2-20260930b";
const HERE = import.meta.dirname;
const RAW_ROOT = join(HERE, "..", RUN_ID);
const argi = process.argv.indexOf("--repo");
const REPO = argi > 0 ? process.argv[argi + 1] : "/Users/sayue/dev/FlEq";
const T = join(REPO, "reconstruction/test/eew-e01");
const { ac15Intervals, checkpointWindows, compareRetention, judgeAc15 } = await import(join(T, "ac15.mjs"));
const { bracketMem, parseJsonl, replayInterval, summarizeReplayWindow } = await import(join(T, "aux-measures.mjs"));
const { hostReports } = await import(join(T, "windows.mjs"));
const { nearCapacityFrames } = await import(join(T, "frames.mjs"));
const { readSelfHashed } = await import(join(REPO, "reconstruction/dist/src/measurement/eew-e01/frozen.js"));
const RESULTS = join(T, "evidence/windows", RUN_ID, "results");
const SHIFTS_MS = [-5, 5];

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const supplement = readSelfHashed(readFileSync(join(HERE, "raw-supplement.json"), "utf8"), "resultSha256");
const sealedOf = (id, rel) => {
  const e = supplement.windows[id]?.find((f) => f.path === rel);
  if (e == null) throw new Error(`${id}/${rel} is not in raw-supplement.json`);
  return e;
};
// 生ファイルを補足封印と照合して読む（小さいもの）。
const readRaw = (id, rel) => {
  const b = readFileSync(join(RAW_ROOT, id, rel));
  if (sha256Hex(b) !== sealedOf(id, rel).sha256) throw new Error(`${id}/${rel} sha256 differs from raw-supplement.json`);
  return b;
};
const readJson = (id, rel) => JSON.parse(readRaw(id, rel).toString("utf8"));
const readResult = (name) => readSelfHashed(readFileSync(join(RESULTS, name), "utf8"), "resultSha256");
// 封印済み結果は JSON を経ているので、作り直した値も JSON に通してから比べる。違う path を最大 20 件返す。
const plain = (v) => JSON.parse(JSON.stringify(v));
function diff(a, b, path = "$", out = []) {
  if (out.length >= 20) return out;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) out.push({ path, recomputed: a, sealed: b });
  return out;
}

// ── AC15 ──
// windows.mjs:338-355 の withSyntheticT0 の写し（export されていない）。
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
const unitOfHead = (headType) => (/^VXSE/.test(headType) ? "U-E" : headType === "VPWP50" ? "U-F" : "U-W");
// stringify.jsonl（数百 MB）を 1 行ずつ読み、sha256 を同時に取って補足封印と照合する。
async function readProbe(id, rel) {
  const hash = createHash("sha256");
  const rows = [];
  const stream = createReadStream(join(RAW_ROOT, id, rel));
  stream.on("data", (chunk) => hash.update(chunk));
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line !== "") rows.push(JSON.parse(line));
  if (hash.digest("hex") !== sealedOf(id, rel).sha256) throw new Error(`${id}/${rel} sha256 differs from raw-supplement.json`);
  return rows;
}

async function ac15Mode(sealedMode, s, warmup, samples) {
  const mode = sealedMode.mode;
  const records = parseJsonl(readRaw("ac15", `${mode}/host-obs.jsonl`).toString("utf8"));
  const frames = nearCapacityFrames({ mode });
  if (frames.length !== sealedMode.fill.frames) throw new Error(`ac15 ${mode}: fill frames ${frames.length} != sealed ${sealedMode.fill.frames}`);
  const first = sealedMode.fill.firstSeq;
  const unitOfInput = new Map(frames.map((f, i) => [`input-${first + i}`, unitOfHead(f.headType)]));
  const unitOf = new Map();
  const sched = []; // { id, offsetMs, data }
  let seq = first + frames.length;
  let offset = 0;
  for (const name of s.order) {
    for (let i = 0; i < warmup + samples; i++) {
      if (name === "metadata") sched.push({ id: `metadata-${i}`, index: i, offsetMs: offset, data: false });
      else {
        const id = `input-${seq++}`;
        unitOfInput.set(id, name);
        if (i >= warmup) unitOf.set(id, name);
        sched.push({ id, offsetMs: offset, data: true });
      }
      offset += name === "metadata" ? s.metadataIntervalMs : s.intervalMs;
    }
  }
  const t0 = new Map(records.filter((r) => r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0").map((r) => [r.o.inputId, r.o.monotonicMs]));
  if (t0.size !== seq - first) throw new Error(`ac15 ${mode}: host T0 count ${t0.size} != fill + measured inputs ${seq - first}`);
  const lags = sched.filter((x) => x.data).map((x) => t0.get(x.id) - x.offsetMs);
  const D = Math.min(...lags);
  const lagSpreadMs = Math.max(...lags) - D;
  const lastT0 = records.reduce((a, r) => (r.t === "obs" && r.o.kind === "marker" && r.o.point === "T0" ? Math.max(a, r.o.monotonicMs) : a), -Infinity);
  const probe = await readProbe("ac15", `${mode}/stringify.jsonl`);
  const judgeAt = (shiftMs) => {
    const events = sched.filter((x) => !x.data).map((x) => ({ id: x.id, index: x.index, hostMs: D + x.offsetMs + shiftMs }));
    const mapped = new Map(unitOf);
    for (const x of events.filter((e) => e.index >= warmup)) mapped.set(x.id, "metadata");
    const intervals = ac15Intervals(withSyntheticT0(records, events), mapped, { endMs: lastT0 + s.intervalMs });
    const publishObserved = [];
    for (const x of intervals.filter((iv) => iv.unit === "metadata")) { publishObserved.push(x.publishCount); x.publishCount = 2; }
    const from = intervals[0]?.startMs ?? 0;
    const judged = judgeAc15(probe.filter((row) => row[0] >= from), intervals, sealedMode.fingerprintTable,
      { checkpointWindows: checkpointWindows(records), unitOfInput, minInputsPerUnit: samples });
    const assumedMinus = judged.scenarios.metadata?.snapshotCallsMinusPublish ?? null;
    const observedTotal = publishObserved.reduce((a, b) => a + b, 0);
    const observed = { publishPerIntervalByRecordOrder: publishObserved, publishTotal: observedTotal,
      snapshotCallsMinusPublish: assumedMinus == null ? null : assumedMinus + 2 * publishObserved.length - observedTotal };
    return { judged: plain(judged), observed };
  };
  const base = judgeAt(0);
  const reports = plain(hostReports(records, `ac15-${mode}`));
  const diffs = [
    ...diff(base.judged, sealedMode.judged, `${mode}.judged`),
    ...diff(base.observed, sealedMode.metadata.observed, `${mode}.metadata.observed`),
    ...diff(reports.e15, sealedMode.e15, `${mode}.e15`),
    ...diff(reports.publishCost, sealedMode.publishCost, `${mode}.publishCost`),
  ];
  const shifts = SHIFTS_MS.map((shiftMs) => {
    const j = judgeAt(shiftMs).judged;
    const d = diff(j, base.judged);
    return { shiftMs, status: j.status, judgedDiffers: d.length, paths: d.slice(0, 5).map((x) => x.path) };
  });
  return { mode, status: base.judged.status, sealedStatus: sealedMode.status, metadataClock: { D, lagSpreadMs }, shifts, diffs, judged: base.judged };
}

async function ac15() {
  const sealed = readResult("aux-ac15.json");
  if (sha256Hex(readFileSync(join(RESULTS, "aux-ac15.json"))) !== sealedOf("ac15", "aux-ac15.json").sha256) throw new Error("aux-ac15.json in repo differs from the raw dir copy");
  const s = JSON.parse(readFileSync(join(T, "evidence/initial-state.json"), "utf8")).ac15Scenarios;
  const full = await ac15Mode(sealed.full, s, sealed.warmup, sealed.samples);
  const half = await ac15Mode(sealed.half, s, sealed.warmup, sealed.samples);
  const retainedOf = (observed) => ({ "U-E": Number(observed.snapshotActive.eew.split("/")[0]), "U-W": observed.checkpoint["U-W.partials"], "U-F": observed.checkpoint["U-F.subjects"] });
  const retention = plain(compareRetention(full.judged, half.judged, { maxSlope: s.retention.maxSlopePerRetained,
    retained: { full: retainedOf(sealed.full.fill.observed), half: retainedOf(sealed.half.fill.observed) } }));
  const statuses = [full.status, half.status, retention.status];
  const status = statuses.includes("Fail") ? "Fail" : statuses.includes("未確認") ? "未確認" : "Pass";
  const diffs = [...full.diffs, ...half.diffs, ...diff(retention, sealed.retention, "retention"), ...diff(status, sealed.status, "status")];
  const strip = ({ judged, ...rest }) => rest;
  return { window: "ac15", status, sealedStatus: sealed.status, parts: { full: full.status, half: half.status, retention: retention.status },
    full: strip(full), half: strip(half), match: diffs.length === 0, diffs };
}

// ── E12（e12-run.mjs の本体と同じ組み立て。exit は生データに無いので封印済みの値を写す） ──
const tree = (node) => node.selfSize + node.children.reduce((a, child) => a + tree(child), 0);
const allocationOf = (id, side) => supplement.windows[id].filter((f) => f.path.startsWith(`${side}/`) && f.path.endsWith(".heapprofile")).map((f) => {
  const bytes = readRaw(id, f.path);
  const profile = JSON.parse(bytes.toString("utf8"));
  return { file: f.path.slice(side.length + 1), bytes: bytes.length, sha256: f.sha256, selfSizeSum: tree(profile.head),
    sampleSizeSum: profile.samples.reduce((a, x) => a + x.size, 0), samples: profile.samples.length };
});
function e12(id) {
  const sealed = readResult(`aux-${id}.json`);
  const r = sealed.report;
  const framesBytes = readRaw(id, "frames.jsonl");
  const calls = readJson(id, "old/calls.json");
  const last = calls.calls.at(-1);
  const oldSide = { exit: r.old.exit, ...summarizeReplayWindow({ probe: readJson(id, "old/probe.json"), startMs: calls.calls[0].startedMs,
    endMs: last.startedMs + last.durationMs, before: calls.memBefore, after: calls.memAfter }) };
  const records = parseJsonl(readRaw(id, "new/host.jsonl").toString("utf8"));
  const interval = replayInterval(records);
  const newSide = { exit: r.new.exit, ...summarizeReplayWindow({ probe: readJson(id, "new/probe.json"), ...interval, ...bracketMem(records, interval.startMs, interval.endMs) }) };
  const report = plain({ ...r, framesSha256: sha256Hex(framesBytes), frames: framesBytes.toString("utf8").split("\n").filter((l) => l !== "").length,
    nodeVersion: calls.nodeVersion, old: oldSide, new: newSide,
    allocation: { method: r.allocation.method, old: allocationOf(id, "old"), new: allocationOf(id, "new") } });
  const status = [report.old, report.new].every((side) => side != null && side.status == null) ? "N/A" : "未確認";
  const diffs = [...diff(report, r, "report"), ...diff(status, sealed.status, "status"),
    ...diff(plain(readJson(id, "report.json")), r, "rawReportJson")];
  return { window: id, status, sealedStatus: sealed.status, match: diffs.length === 0, diffs };
}

const out = { runId: RUN_ID, repo: REPO, ac15: await ac15(), e12: readdirSync(RAW_ROOT).filter((d) => d.startsWith("e12-")).sort().map(e12) };
const all = [out.ac15, ...out.e12];
out.allMatch = all.every((x) => x.match);
writeFileSync(join(HERE, "recompute-ac15-e12.json"), `${JSON.stringify(out, null, 2)}\n`);
for (const x of all) console.log(`${x.window}: recomputed=${x.status} sealed=${x.sealedStatus} match=${x.match}${x.match ? "" : ` diffs=${JSON.stringify(x.diffs).slice(0, 600)}`}`);
console.log(`ac15 metadata clock: full=${JSON.stringify(out.ac15.full.metadataClock)} shifts=${JSON.stringify(out.ac15.full.shifts)} half=${JSON.stringify(out.ac15.half.metadataClock)} shifts=${JSON.stringify(out.ac15.half.shifts)}`);
console.log(`allMatch=${out.allMatch}`);
process.exit(out.allMatch ? 0 : 1);
