// A10 WP3b: E03/E05/E06/E15/PublishCost/E12 の集計。入力は host launcher の JSON Lines
// ({"t":"obs"|"clock"|"mem"|"meta",...}) を parse した配列だけ。host は起動しない。
// 判定・分位点・保存 record の結合検証は WP2 の関数を使う（ここで書き直さない）。無いと、測定ごとに別の規則で Pass が揺れる。
import { execFile } from "node:child_process";

import judge from "../../dist/src/measurement/eew-e01/judge.js";

const { quantiles, checkpointJoinProblem } = judge;
const MiB = 1024 * 1024;
const median = (values) => quantiles(values)?.p50 ?? null;

// `--key value` の並びだけを受ける引数解析（CLI 3 本で共通）。
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] == null) throw new Error(`bad argument: ${argv[i]}`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

export const parseJsonl = (text) => text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

const observations = (records, kind) => records.flatMap((r) => (r.t === "obs" && r.o.kind === kind ? [r.o] : []));
const markers = (records, point) => new Map(observations(records, "marker").filter((o) => o.point === point && o.inputId != null).map((o) => [o.inputId, o.monotonicMs]));

// runner 時計(process.hrtime.bigint の文字列)→ host の perfNowMs。最も近い clock 行からの差で写す。clock 行が無ければ null。
export function hostMsOf(records, hrtimeNs) {
  const hr = BigInt(hrtimeNs);
  let best = null;
  for (const r of records) {
    if (r.t !== "clock") continue;
    const gap = hr > BigInt(r.hrtimeNs) ? hr - BigInt(r.hrtimeNs) : BigInt(r.hrtimeNs) - hr;
    if (best == null || gap < best.gap) best = { gap, row: r };
  }
  return best == null ? null : best.row.perfNowMs + Number(hr - BigInt(best.row.hrtimeNs)) / 1e6;
}

// 窓は host 時計 {fromMs,toMs}、または runner 時計 {fromHrtimeNs,toHrtimeNs}（clock 行で写す）。写せなければ null。
function hostWindow(records, window) {
  if (window == null || window.fromMs != null) return window ?? { fromMs: -Infinity, toMs: Infinity };
  const fromMs = hostMsOf(records, window.fromHrtimeNs);
  const toMs = hostMsOf(records, window.toHrtimeNs);
  return fromMs == null || toMs == null ? null : { fromMs, toMs };
}
const memRows = (records, window) => records.filter((r) => r.t === "mem" && r.perfNowMs >= window.fromMs && r.perfNowMs <= window.toMs);

// 最小二乗の傾き（y の単位 / x の単位）。点が 2 未満、または x が一点なら null。
function slope(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  const den = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  return den === 0 ? null : points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / den;
}

// E03（AC08）: 最大 XML の処理開始(T2)→decision/射影(dispatch 完了)。queue 待ち(T1→T2)は別に数える。
// 未処理の標本は分母から外さない。
export function summarizeE03(records, targetInputIds, { minSamples = 1000, limitMs = 1000 } = {}) {
  const processing = new Map(observations(records, "processing").map((o) => [o.measurement.inputId, o.measurement]));
  const t1 = markers(records, "T1");
  const t2 = markers(records, "T2");
  const durations = [];
  const queueWaits = [];
  let unprocessed = 0;
  for (const id of targetInputIds) {
    const p = processing.get(id);
    if (p == null) { unprocessed++; continue; }
    durations.push(p.endedMonotonicMs - p.startedMonotonicMs);
    if (t1.has(id) && t2.has(id)) queueWaits.push(t2.get(id) - t1.get(id));
  }
  const q = quantiles(durations);
  const status = unprocessed > 0 || durations.length < minSamples || q == null ? "未確認" : q.p99 > limitMs ? "Fail" : "Pass";
  return { status, samples: durations.length, unprocessed, processingMs: q, queueWaitMs: quantiles(queueWaits), limitMs,
    notes: ["未処理が 1 件でもあれば Fail でなく未確認（保守側）",
      "終点は dispatch 完了で publish の直列化まで含む（T3 より遅い＝保守側）",
      "targetInputIds は host の data frame の通し番号（ingress 拒否も番号を消費し、overload 中は消費しない）"] };
}

// E05: Node RSS の最大。同じ窓（E02 の窓）の mem 行から。N ≤ 300MiB、P ≤ 400MiB。N/P 以外（C）は未確認。
// 上限超過の観測は Fail。超過が無くても、窓の端（開始→最初の行・最後の行→終了）と行の間の間隔が採取周期（spec §9.9 E05 の毎秒）の 2 倍を
// 超えたところを欠測として数え、端が欠けるか欠測が窓の期待標本数の maxMissingRatio を超えれば未確認。実標本数が期待標本数の
// (1 − maxMissingRatio) 未満でも未確認（2 倍以下の間隔の周期的な欠落は間隔の検査に掛からない）。
// 無いと、長い窓に 1 行しか無い（host の timer が止まった）ときも Pass になる（ヘルツ総合レビュー指摘 7）。
export function summarizeE05(records, load, window, { memEveryMs = 1000, maxMissingRatio = 0.01 } = {}) {
  const w = hostWindow(records, window);
  const limit = { N: 300, P: 400 }[load];
  if (w == null || limit == null) return { status: "未確認", load, samples: 0, maxRssBytes: null, limitBytes: null };
  const rows = memRows(records, w);
  const maxRss = rows.reduce((a, r) => Math.max(a, r.rss), 0);
  const times = [w.fromMs, ...rows.map((r) => r.perfNowMs), w.toMs];
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const missingSamples = gaps.reduce((a, gap) => a + (gap > 2 * memEveryMs ? Math.ceil(gap / memEveryMs) - 1 : 0), 0);
  const expectedSamples = Math.floor((w.toMs - w.fromMs) / memEveryMs);
  const edgesCovered = rows.length > 0 && gaps[0] <= 2 * memEveryMs && gaps.at(-1) <= 2 * memEveryMs;
  const covered = edgesCovered && missingSamples <= expectedSamples * maxMissingRatio && rows.length >= expectedSamples * (1 - maxMissingRatio);
  const status = rows.length > 0 && maxRss > limit * MiB ? "Fail" : covered ? "Pass" : "未確認";
  return { status, load, samples: rows.length, maxRssBytes: rows.length === 0 ? null : maxRss, limitBytes: limit * MiB,
    coverage: { memEveryMs, expectedSamples, missingSamples, maxGapMs: Math.max(...gaps), edgesCovered, maxMissingRatio } };
}

// E06: 保持上限を満たした定常開始点(steadyStartMs, host 時計)から 10 分 × 6 窓。充填段階は入れず、60 分を超えた行は捨てる。
// RSS・heap・FD の傾き（/分）は spec §9.9 E06 どおり 6 個の（窓中央時刻, 窓中央値）の最小二乗。FD は窓ごとの最大も出し、
// spec（reconstruction-p0-contracts.md E06）の式の値を spec に出す: RSS 窓中央値の傾き ≤ 暫定 1MiB/時、最終窓中央値 ≤ 初窓 + 暫定 5MiB、
// FD 最終窓の最大 ≤ 初窓の最大。超過があれば report を「報告（spec 式で超過・原因未分類）」にする（spec は超過原因未分類のまま合格にしない）。
// 合否は付けず報告だけ（status は窓が欠けたときの 未確認 のみ、他は null）。
// fdSeries は startFdSampler の {hrtimeNs,count}。clock 行で host 時計へ写してから窓に振る。
export function summarizeE06(records, fdSeries, { steadyStartMs, windowMs = 600_000, windows = 6 } = {}) {
  const end = steadyStartMs + windows * windowMs;
  const rows = records.filter((r) => r.t === "mem" && r.perfNowMs >= steadyStartMs && r.perfNowMs < end);
  const fd = fdSeries.flatMap((s) => {
    const at = s.count == null ? null : hostMsOf(records, s.hrtimeNs);
    return at != null && at >= steadyStartMs && at < end ? [{ elapsedMs: at - steadyStartMs, count: s.count }] : [];
  });
  const perWindow = Array.from({ length: windows }, (_, w) => {
    const mem = rows.filter((r) => Math.floor((r.perfNowMs - steadyStartMs) / windowMs) === w);
    const inside = fd.filter((s) => Math.floor(s.elapsedMs / windowMs) === w);
    return { window: w, memSamples: mem.length, fdSamples: inside.length,
      rssMedian: median(mem.map((r) => r.rss)), heapUsedMedian: median(mem.map((r) => r.heapUsed)), fdMedian: median(inside.map((s) => s.count)),
      fdMax: inside.length === 0 ? null : Math.max(...inside.map((s) => s.count)) };
  });
  // 窓中央時刻（定常開始からの ms）と窓中央値。中央値の無い窓は点にしない。
  const medianSlopePerMin = (key) => {
    const s = slope(perWindow.flatMap((w) => (w[key] == null ? [] : [[(w.window + 0.5) * windowMs, w[key]]])));
    return s == null ? null : s * 60_000;
  };
  const complete = perWindow.every((w) => w.memSamples > 0 && w.fdSamples > 0);
  const [first, final] = [perWindow[0], perWindow[perWindow.length - 1]];
  const rssSlopeBytesPerMin = medianSlopePerMin("rssMedian");
  const checks = [
    ["rssMedianSlopeBytesPerHour", rssSlopeBytesPerMin == null ? null : rssSlopeBytesPerMin * 60, MiB],
    ["finalMinusFirstRssMedianBytes", first.rssMedian == null || final.rssMedian == null ? null : final.rssMedian - first.rssMedian, 5 * MiB],
    ["fdFinalMaxMinusFirstMax", first.fdMax == null || final.fdMax == null ? null : final.fdMax - first.fdMax, 0],
  ].map(([name, value, limit]) => ({ name, value, limit, exceeded: value == null ? null : value > limit }));
  const report = checks.some((c) => c.exceeded) ? "報告（spec 式で超過・原因未分類）"
    : checks.some((c) => c.exceeded == null) ? "報告（spec 式の値が欠けている）" : "報告（spec 式の範囲内）";
  return {
    status: complete ? null : "未確認", complete, windows: perWindow,
    rssSlopeBytesPerMin,
    heapUsedSlopeBytesPerMin: medianSlopePerMin("heapUsedMedian"),
    fdSlopePerMin: medianSlopePerMin("fdMedian"),
    spec: { checks, report, note: "閾値は spec の暫定値（1MiB/時・5MiB は allocator の揺れを許す経験的暫定値）。合否ではなく報告。超過の原因は分類していない" },
    finalWindow: final,
  };
}

// FD 数は外から数える（製品に口を足さない）。`lsof -p <pid>` の行数 - 見出し 1 行。失敗は count=null で残す。
// 時刻は process.hrtime.bigint（launcher の clock 行と同じ源）で残し、summarizeE06 が host 時計へ写す。
export function startFdSampler(pid, everyMs = 60_000) {
  const samples = [];
  const take = () => {
    const hrtimeNs = process.hrtime.bigint().toString();
    execFile("lsof", ["-n", "-P", "-p", String(pid)], { maxBuffer: 64 * MiB, timeout: everyMs }, (error, stdout) => {
      const lines = stdout.split("\n").filter((line) => line !== "").length;
      samples.push({ hrtimeNs, count: error != null || lines === 0 ? null : lines - 1 });
    });
  };
  take();
  const timer = setInterval(take, everyMs);
  return { samples, stop: () => clearInterval(timer) };
}

// E15（AC09）: CheckpointMeasurement を runId/attemptId で結合し、unit 別に encode 回数・encode/write byte・処理占有時間を数える。
// 結合の検証は WP2 の checkpointJoinProblem（classifyEewCause と同じ規則）。問題があれば集計せず未確認。
// 占有時間: encode と verify は同期区間として下限（occupiedMsLower）にする。measuredStagesMs は計測された全段の壁時間の合計で、
// 非同期の待ちを含み、前段の同期処理（checkpoint.ts:266-300）を含まない。上限ではない。
export const E15_BLOCKED = [
  "executeCheckpoint の前段の同期処理（checkpoint.ts:266-300 の restoreUnit・removeTemporaries・serializedEnvelope・latestValidSlot）は、どの段の計測区間にも入らず、製品に計測点が無いため未測定",
  "checkpoint と診断の write を A3 CheckpointFileSystem/DiagnosticFileSystem で別計数する口が startP2Host の config に無い（製品 src 不変のため未測定）",
];

export function summarizeE15(records) {
  const measurements = observations(records, "checkpoint").map((o) => o.measurement);
  const problem = checkpointJoinProblem(measurements);
  if (problem != null) return { status: "未確認", blocked: [...E15_BLOCKED, `checkpointJoin:${problem}`] };
  const seenInputs = new Set(markers(records, "T0").keys());
  const units = {};
  const retryReasons = {};
  let byteViolations = 0;
  let unknownInputIds = 0;
  const attempts = new Set();
  for (const m of measurements) {
    attempts.add(`${m.runId}\u0000${m.attemptId}`);
    const u = (units[m.unit] ??= { encodeCount: 0, encodeBytes: 0, writeBytes: 0, occupiedMsLower: 0, measuredStagesMs: 0, failedAttempts: 0 });
    const ms = m.endedMonotonicMs - m.startedMonotonicMs;
    u.measuredStagesMs += ms;
    if (m.stage === "encode" || m.stage === "verify") u.occupiedMsLower += ms;
    if (m.stage === "encode") {
      u.encodeCount++;
      u.encodeBytes += m.bytes;
      if (m.outcome === "failed") u.failedAttempts++;
      retryReasons[m.retryReason] = (retryReasons[m.retryReason] ?? 0) + 1;
      unknownInputIds += m.inputIds.filter((id) => !seenInputs.has(id)).length;
    } else if (m.stage === "write") u.writeBytes += m.bytes;
    else if (m.bytes !== 0) byteViolations++;
  }
  return { status: null, attempts: attempts.size, units, retryReasons, byteViolations, unknownInputIds, blocked: E15_BLOCKED,
    occupancyNote: "occupiedMsLower = encode+verify の壁時間（下限）。measuredStagesMs = 計測された段の壁時間の合計で、非同期の待ちを含み、前段の同期処理 checkpoint.ts:266-300 を含まない（上限ではない）" };
}

// PublishCostReport（AC15/R62）: onSerialize 由来の publishSerialization 観測から。窓 = 1 つの JSONL（E01/E02 の 1 run）。上限は置かない。
export function publishCostReport(records, window) {
  const rows = observations(records, "publishSerialization");
  const q = quantiles(rows.map((o) => o.durationMs));
  return { window, publishCount: rows.length, totalJsonBytes: rows.reduce((a, o) => a + o.bytes, 0),
    maxJsonBytes: rows.reduce((a, o) => Math.max(a, o.bytes), 0), serializeP50Ms: q?.p50 ?? null, serializeP99Ms: q?.p99 ?? null, serializeMaxMs: q?.max ?? null };
}

// E12: 旧側は launcher 自身が replay の直前・直後に取った memoryUsage、新側は bracketMem（区間の外側で最も内寄りの mem 行）。GC entry は区間で絞る。
// module の読み込みや host の起動は比較に入れない。RSS/heapDelta を総 allocation と呼ばない。
export const E12_CONFIG_NOTE = "旧側は createMessageHandler({})、display・displaySink・永続化なし。新側は射影・SSE publish・checkpoint を含む。新側 silent は通知 backend の代わりに /usr/bin/true を spawn する費用を含む。旧側は通知を止めていて spawn しない";

export function replayInterval(records) {
  const starts = [...markers(records, "T0").values()];
  const ends = observations(records, "processing").map((o) => o.measurement.endedMonotonicMs);
  return starts.length === 0 || ends.length === 0 ? null : { startMs: starts.reduce((a, b) => Math.min(a, b)), endMs: ends.reduce((a, b) => Math.max(a, b)) };
}

// 区間の開始以前で最後の mem 行と、終了以後で最初の mem 行（区間の外の行を選ばない）。符号付き距離 = 行の時刻 - 区間の端。
export function bracketMem(records, startMs, endMs) {
  const rows = records.filter((r) => r.t === "mem");
  const before = rows.filter((r) => r.perfNowMs <= startMs).at(-1);
  const after = rows.find((r) => r.perfNowMs >= endMs);
  const pick = (row, edge) => (row == null ? null : { heapUsed: row.heapUsed, signedDistanceMs: row.perfNowMs - edge });
  return { before: pick(before, startMs), after: pick(after, endMs) };
}

// 端の行が無い、または距離が replay 区間より長いときは heap を出さず未確認（旧側は端そのもの＝距離 0）。
export function summarizeReplayWindow({ probe, startMs, endMs, before, after }) {
  const replayMs = endMs - startMs;
  if (before == null || after == null || Math.abs(before.signedDistanceMs ?? 0) > replayMs || Math.abs(after.signedDistanceMs ?? 0) > replayMs) {
    return { status: "未確認", reason: "heapBoundaryUnavailable", replayMs, configuration: E12_CONFIG_NOTE };
  }
  const durations = probe.gc.filter((e) => e.startMs >= startMs && e.startMs <= endMs).map((e) => e.durationMs);
  return { status: null, replayMs, gcCount: durations.length, gcTotalMs: durations.reduce((a, b) => a + b, 0), gcMaxMs: durations.reduce((a, b) => Math.max(a, b), 0),
    heapUsedBefore: before.heapUsed, heapUsedAfter: after.heapUsed, heapUsedDelta: after.heapUsed - before.heapUsed,
    heapBoundarySignedDistanceMs: { before: before.signedDistanceMs ?? 0, after: after.signedDistanceMs ?? 0 },
    note: "heapUsedDelta は前後差であり総 allocation ではない。allocation 推定は --heap-prof の出力を見る", configuration: E12_CONFIG_NOTE };
}
