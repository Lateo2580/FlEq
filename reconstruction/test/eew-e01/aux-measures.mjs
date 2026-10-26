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

// E07 の入力停止後の排出（P3-C4-AC07(2)②）: 最後の入力の T0 の後の mailbox の行で、非空だった最後の行（下界）と、それより後で最初の
// 空の行（上界）で完了時刻を挟む。上界の行がまだ無ければ upperMs は null（runner はそれが出るまで host を止めない）。
const backlogOf = (row) => ({ items: row.pendingItems + row.inFlightItems, bytes: row.pendingBytes + row.inFlightBytes });
export function drainBounds(records, lastT0Ms) {
  let lowerMs = lastT0Ms;
  for (const row of observations(records, "mailbox")) {
    if (row.monotonicMs <= lastT0Ms) continue;
    if (backlogOf(row).items !== 0) lowerMs = row.monotonicMs;
    else return { lowerMs, upperMs: row.monotonicMs };
  }
  return { lowerMs, upperMs: null };
}

// E07（P3-C4-AC07(2)、P3-C3B-E07-WINDOW=A）: N または C の 1 窓。判定は境界をまたがない証拠だけで行い、どれかが Fail なら Fail、
// どれかが未確認なら未確認。
// ① 周期末 backlog（C だけ）: pingKinds は投入側が送った ping の種類の列（"periodic" | "boundary" | "drain"）で、host の ping の行と
//    受信順で 1 対 1 に対応する（数が違えば対応が取れず未確認）。boundary の行 j を周期 j の末とし、warm-up の後の各周期末の件数・byte が
//    前の周期末以下。tick の行は使わない。
// ② 入力停止後の排出: drainBounds の上界 ≤ T0＋10 秒で Pass、下界 > T0＋10 秒で Fail。
// ③ 最大待機年齢: 入力ごとの T1→T2（owner の処理開始なので待機年齢以上）の最大が上界、行の oldestPendingAgeMs の最大が下界。
// 宣言上限の違反（limitViolations）が窓の中で増えたか、窓の中で owner が停止・unresponsive になった（診断の ownerStopped・
// owner.<place>.response の mailboxStalled）なら Fail。fromMs（host 時計）は窓の始まりで、充填の段階を②以外から外す。
// diagnostics の timestamp は壁時計なので、fromWallMs で同じく絞る。
export function summarizeE07(records, { pingKinds = [], warmupCycles = 0, lastInputId, diagnostics = [], fromMs = -Infinity, fromWallMs = -Infinity,
  waitLimitMs = 5000, drainLimitMs = 10_000 }) {
  const all = observations(records, "mailbox");
  const pings = all.filter((r) => r.trigger === "ping");
  const rows = all.filter((r) => r.monotonicMs >= fromMs);
  let cycleEnd = { status: "N/A", ends: [] };
  if (pingKinds.includes("boundary")) {
    if (pings.length !== pingKinds.length) cycleEnd = { status: "未確認", reason: `ping rows ${pings.length} != pings sent ${pingKinds.length}`, ends: [] };
    else {
      const ends = pings.filter((_, i) => pingKinds[i] === "boundary").map(backlogOf);
      const grew = ends.flatMap((end, j) => (j >= Math.max(1, warmupCycles) && (end.items > ends[j - 1].items || end.bytes > ends[j - 1].bytes) ? [j] : []));
      cycleEnd = { status: grew.length > 0 ? "Fail" : "Pass", ends, grewAtCycles: grew };
    }
  }
  const t0 = markers(records, "T0").get(lastInputId);
  const drain = t0 == null ? { status: "未確認", reason: "last input T0 not observed" } : (() => {
    const { lowerMs, upperMs } = drainBounds(records, t0);
    const status = upperMs != null && upperMs <= t0 + drainLimitMs ? "Pass" : lowerMs > t0 + drainLimitMs ? "Fail" : "未確認";
    return { status, lastT0Ms: t0, lowerMs, upperMs };
  })();
  // 対象は窓の直前の行から最後の行までに受理された入力。その数（行の accepted の差）と T1 の数が違えば、T1 の欠けた入力の
  // 待機年齢が上界に入っていないので未確認（T1 は受理と同じ callback で 1 回出る）。
  const t1 = markers(records, "T1");
  const t2 = markers(records, "T2");
  const base = all.filter((r) => r.monotonicMs < fromMs).at(-1);
  const end = all.at(-1);
  const accepted = end == null ? 0 : end.accepted - (base?.accepted ?? 0);
  let upper = 0;
  let unprocessed = 0;
  let observedT1 = 0;
  for (const [id, at] of t1) {
    if (at <= (base?.monotonicMs ?? -Infinity) || end == null || at > end.monotonicMs) continue;
    observedT1++;
    if (t2.has(id)) upper = Math.max(upper, t2.get(id) - at); else unprocessed++;
  }
  const lower = rows.reduce((m, r) => Math.max(m, r.oldestPendingAgeMs ?? 0), 0);
  const wait = { status: lower > waitLimitMs ? "Fail" : unprocessed === 0 && observedT1 === accepted && upper <= waitLimitMs ? "Pass" : "未確認",
    upperMs: upper, lowerMs: lower, unprocessed, accepted, observedT1 };
  const before = base?.limitViolations ?? 0;
  const limitViolations = rows.reduce((m, r) => Math.max(m, r.limitViolations), before) - before;
  const ownerTrouble = diagnostics.filter((d) => d.timestamp >= fromWallMs).filter((d) => (d.reason === "ownerStopped" && d.level === "ERROR")
    || (d.reason === "mailboxStalled" && /^owner\.[^.]+\.response$/.test(d.component ?? "")));
  const parts = [cycleEnd.status, drain.status, wait.status, limitViolations > 0 || ownerTrouble.length > 0 ? "Fail" : "Pass"];
  const status = rows.length === 0 ? "未確認" : parts.includes("Fail") ? "Fail" : parts.includes("未確認") ? "未確認" : "Pass";
  return { status, rows: rows.length, pingRows: pings.length, cycleEnd, drain, wait, limitViolations,
    ownerTrouble: ownerTrouble.map((d) => ({ reason: d.reason, component: d.component, timestamp: d.timestamp })),
    note: "待機年齢は通常入力に絞らず全入力の T1→T2（EEW は予約枠で先に出るので上界を大きくしない）" };
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
// 占有時間: encode を同期区間の下限（occupiedMsLower）にする。measuredStagesMs は計測された全段の壁時間の合計で、
// 非同期の待ちを含み、前段の同期処理（checkpoint.ts:266-300）を含まない。上限ではない。
// verify 段（P3-C1-E15）: C1 後の定常保存には無く、記憶なしの試行・照合の経路でだけ出る。読んだ bytes と時間を verify* に別に数え、
// encode・write・占有へ足さない（無いと、照合の読み込みが保存の占有と byteViolations に混ざる）。
export const E15_BLOCKED = [
  "executeCheckpoint の前段の同期処理（checkpoint.ts:266-300 の restoreUnit・removeTemporaries・serializedEnvelope・latestValidSlot）は、どの段の計測区間にも入らず、製品に計測点が無いため未測定",
  "checkpoint と診断の write を A3 CheckpointFileSystem/DiagnosticFileSystem で別計数する口が startP2Host の config に無い（製品 src 不変のため未測定）",
];

const OWNER_UNITS = { urgent: ["U-E"], weatherCurrent: ["U-W"], deferred: ["U-F"], seismic: ["U-Q"] };
const ZERO = { count: 0, bytes: 0 };
// E15 の write の帰属（P3-C4-AC05・P3-C4-WRITE-COUNT）: host が停止時に出す thread ごとの writeCount を、包みと独立した記録に照らす。
// owner の tmp は自分の unit の write 段の CheckpointMeasurement の回数と byte、publisher の diagnosticLog は診断 dir の jsonl の
// 改行の数と byte（diagnosticLog、呼び出し側が読む）、publisher の tmp は終了要約の書き手が試行ごとに出す shutdownSummaryWrite の
// 行数と byte の和。owner の checkpoint・diagnosticLog・other と publisher の checkpoint・other は 0 が帰属できる値。
// status: 行が揃わないか confirmed が false の thread があれば未確認（counter が信用できない）、照合が合わなければ Fail、
// 照合できない区分（unverified・診断 dir が読めない）があれば未確認、それ以外は null（報告）。
export function writeAttribution(rows, measurements, diagnosticLog, summaryWrites) {
  const threads = ["urgent", "weatherCurrent", "deferred", "seismic", "publisher"];
  const complete = threads.every((t) => rows.filter((r) => r.thread === t).length === 1);
  const unattributed = [];
  const unverified = [];
  for (const row of rows) {
    const expected = row.thread === "publisher"
      ? { checkpoint: ZERO, other: ZERO, diagnosticLog: diagnosticLog == null ? null : { count: diagnosticLog.lines, bytes: diagnosticLog.bytes },
        tmp: { count: summaryWrites.length, bytes: summaryWrites.reduce((a, w) => a + w.bytes, 0) } }
      : { checkpoint: ZERO, diagnosticLog: ZERO, other: ZERO, tmp: measurements.filter((m) => m.stage === "write" && OWNER_UNITS[row.thread].includes(m.unit))
        .reduce((a, m) => ({ count: a.count + 1, bytes: a.bytes + m.bytes }), ZERO) };
    for (const [category, want] of Object.entries(expected)) {
      const got = row.counts[category];
      if (want == null) unverified.push({ thread: row.thread, category, counted: got, reason: "diagnostic directory unreadable" });
      else if (got.bytes !== want.bytes || got.count !== want.count) unattributed.push({ thread: row.thread, category, counted: got, attributed: want });
    }
  }
  const unconfirmed = rows.filter((r) => !r.confirmed).map((r) => r.thread);
  const status = !complete || unconfirmed.length > 0 ? "未確認" : unattributed.length > 0 ? "Fail" : unverified.length > 0 ? "未確認" : null;
  return { status, complete, unconfirmed, unattributed, unverified,
    threads: Object.fromEntries(rows.map((r) => [r.thread, { confirmed: r.confirmed, counts: r.counts }])) };
}

// E15 の保存前段の同期区間（P3-C4-AC05、owner の thread）: 権ごとに、同じ返信の attemptIds の CheckpointMeasurement のうち、その権の
// 送出から返信の受信までに収まる段だけを結ぶ（rename の失敗の後の再照合は同じ attemptId を持つので、時刻で権に分ける）。
// encode を含まない権は照合（reconcile）で、保存前段に入れず reconcileGrants に数える。下界は encode の壁時間、上界は owner の着手から
// encode 以外の最初の段（write など）の開始まで（無ければ encode の終わりまで）。上界が負か下界を下回る権は invalid に数え、
// 区間に足さない（invalid が 1 つでもあれば E15 は未確認）。測定記録の無い権（保存するものが無かった）は数えない。
function preSaveSync(grants, measurements) {
  const byAttempt = new Map();
  for (const m of measurements) byAttempt.set(m.attemptId, [...(byAttempt.get(m.attemptId) ?? []), m]);
  const units = {};
  for (const grant of grants) {
    const stages = grant.attemptIds.flatMap((id) => byAttempt.get(id) ?? [])
      .filter((m) => m.startedMonotonicMs >= grant.grantSentMonotonicMs && m.endedMonotonicMs <= grant.doneReceivedMonotonicMs);
    if (stages.length === 0) continue;
    const u = (units[grant.unit] ??= { grants: 0, reconcileGrants: 0, invalid: 0, lowerMs: 0, upperMs: 0, maxUpperMs: 0 });
    const encodes = stages.filter((m) => m.stage === "encode");
    if (encodes.length === 0) { u.reconcileGrants++; continue; }
    const after = stages.filter((m) => m.stage !== "encode").map((m) => m.startedMonotonicMs);
    const end = after.length > 0 ? Math.min(...after) : Math.max(...encodes.map((m) => m.endedMonotonicMs));
    const upper = end - grant.ownerStartedMonotonicMs;
    const lower = encodes.reduce((a, m) => a + m.endedMonotonicMs - m.startedMonotonicMs, 0);
    if (upper < 0 || upper < lower) { u.invalid++; continue; }
    u.grants++;
    u.lowerMs += lower;
    u.upperMs += upper;
    u.maxUpperMs = Math.max(u.maxUpperMs, upper);
  }
  return units;
}

// writeCount の観測が無い記録（A10 の窓）は従来どおりの報告。ある記録は write の帰属（writeAttribution）を status に反映する。
export function summarizeE15(records, { diagnosticLog = null } = {}) {
  const measurements = observations(records, "checkpoint").map((o) => o.measurement);
  const problem = checkpointJoinProblem(measurements);
  if (problem != null) return { status: "未確認", blocked: [...E15_BLOCKED, `checkpointJoin:${problem}`] };
  const counted = observations(records, "writeCount");
  const writes = counted.length === 0 ? null : writeAttribution(counted, measurements, diagnosticLog, observations(records, "shutdownSummaryWrite"));
  const grants = observations(records, "checkpointGrant");
  const seenInputs = new Set(markers(records, "T0").keys());
  const units = {};
  const retryReasons = {};
  let byteViolations = 0;
  let unknownInputIds = 0;
  const attempts = new Set();
  for (const m of measurements) {
    attempts.add(`${m.runId}\u0000${m.attemptId}`);
    const u = (units[m.unit] ??= { encodeCount: 0, encodeBytes: 0, writeBytes: 0, occupiedMsLower: 0, measuredStagesMs: 0, failedAttempts: 0, verifyCount: 0, verifyBytes: 0, verifyMs: 0 });
    const ms = m.endedMonotonicMs - m.startedMonotonicMs;
    u.measuredStagesMs += ms;
    if (m.stage === "verify") {
      u.verifyCount++;
      u.verifyBytes += m.bytes;
      u.verifyMs += ms;
    } else if (m.stage === "encode") {
      u.occupiedMsLower += ms;
      u.encodeCount++;
      u.encodeBytes += m.bytes;
      if (m.outcome === "failed") u.failedAttempts++;
      retryReasons[m.retryReason] = (retryReasons[m.retryReason] ?? 0) + 1;
      unknownInputIds += m.inputIds.filter((id) => !seenInputs.has(id)).length;
    } else if (m.stage === "write") u.writeBytes += m.bytes;
    else if (m.bytes !== 0) byteViolations++;
  }
  const preSave = grants.length === 0 ? null : preSaveSync(grants, measurements);
  const preSaveInvalid = Object.values(preSave ?? {}).some((u) => u.invalid > 0);
  return { status: writes?.status === "Fail" ? "Fail" : preSaveInvalid ? "未確認" : writes?.status ?? null, attempts: attempts.size, units, retryReasons,
    byteViolations, unknownInputIds, blocked: E15_BLOCKED.filter((_, i) => (i === 0 ? grants.length === 0 : writes == null)), writes,
    preSaveSyncMs: preSave,
    occupancyNote: "occupiedMsLower = encode の壁時間（下限）。verify 段（記憶なし・照合の経路だけ）は verifyCount・verifyBytes（読んだ bytes）・verifyMs に別に数え、占有・write へ足さない。measuredStagesMs = 計測された段の壁時間の合計で、非同期の待ちを含み、前段の同期処理 checkpoint.ts:266-300 を含まない（上限ではない）" };
}

// P3-C4-OWNER-HEAP=B': owner の thread ごとの heap（ownerHeap の行）の最大と件数。RSS は process 全体なので足し合わせない（mem 行のまま）。
export function ownerHeapReport(rows) {
  const places = {};
  for (const r of rows) {
    const p = (places[r.place] ??= { rows: 0, maxHeapUsedBytes: 0, maxExternalBytes: 0 });
    p.rows++;
    p.maxHeapUsedBytes = Math.max(p.maxHeapUsedBytes, r.heapUsedBytes);
    p.maxExternalBytes = Math.max(p.maxExternalBytes, r.externalBytes);
  }
  return places;
}

// 通知の初回試行が owner の採用の返信を待つ時間（P3-C4-AC13(5)、Q-C3A-C4-MEASURES）: 予約の送出→返信の受信（採用の待ち）と、返信→adapter
// 呼出しの開始、intent 生成→予約の送出（壁時計）。初回（attempts 1）と再試行（attempts 2 以上、backoff の待ちを含む）を分けて数える。
// 採用されなかった予約は数だけ。報告で、E01 の合否に使わない。
export function notificationAdoptionReport(records) {
  const rows = observations(records, "notificationAdoption");
  const part = (list) => {
    const started = list.filter((r) => r.attemptStartedMonotonicMs != null);
    return { reservations: list.length, started: started.length, notStarted: list.length - started.length,
      reservationToReplyMs: quantiles(list.map((r) => r.replyReceivedMonotonicMs - r.reservationSentMonotonicMs)),
      replyToAttemptMs: quantiles(started.map((r) => r.attemptStartedMonotonicMs - r.replyReceivedMonotonicMs)),
      createdToReservationWallMs: quantiles(list.map((r) => r.reservationSentWallMs - r.createdAtWallMs)) };
  };
  return { first: part(rows.filter((r) => r.attempts === 1)), retries: part(rows.filter((r) => r.attempts > 1)) };
}

// E14 の束（P3-C4-AC13(3)、P3-C4-E14-WINDOW=A）。bundles は送った束（k と unit ごとの入力 ID）。束は予定時刻に全部送る（③）。
// ② 起点: 束の入力 ID と unit の generationRaised の行（publisher がその入力の採用で上がった世代を反映した時刻と世代）。行が無い unit がある
//    束は inputNotAdopted。dirtyObserved は使わない（前の束の期限回収の反映が次の束の T0 より後に遅れても、その返信は束の入力の行を作らない）。
// ⑤ ack: 束の世代以上を保存して result が acknowledged の最初の返信（いつ送られた権でもよく、起点より前に送られて in-flight だった権も含む。
//    再照合は元の attemptId を使い回すので、試行の attemptId でなく返信〔grantId〕の単位で結ぶ）。結べない unit がある束は未確認。
// ④ 成立: unit ごとの区間［起点、ack の doneReceived］が 3 unit で重なる（max(起点) < min(doneReceived)）。重ならなければ notSimultaneous。
// ⑥ 成立して成功に結べた束で unit ごとの dirty→ack（起点→ack の doneReceived）の p50・p99・max と 3 秒超えの数。各保存の p99 の和を全体の
//    p99 と呼ばない。束が 0 なら未確認。
export const E14_UNITS = ["U-E", "U-W", "U-F"];
// 束の unit は束の inputIds の key（C4 は E14_UNITS の 3 つ。C6 の予備は U-T を足す、P3-C6-AC08 ④）。
const unitsOf = (bundle) => Object.keys(bundle.inputIds);
// 索引は追記の分だけ更新する（窓は待ちの判定ごとに同じ index を渡す）。acknowledged の保存は unit ごとに世代の昇順に確定するので、束の世代
// 以上の最初の ack は二分探索で引く。前提: unit ごとの acknowledged の世代は受信順で単調（崩れても後の ack を拾い、dirty→ack は長めに出る）。
export function e14Index(records, index = { raised: new Map(), acked: Object.fromEntries(E14_UNITS.map((u) => [u, []])), scanned: 0 }) {
  for (; index.scanned < records.length; index.scanned++) {
    const o = records[index.scanned].t === "obs" ? records[index.scanned].o : null;
    if (o?.kind === "generationRaised") index.raised.set(`${o.inputId}|${o.unit}`, o);
    else if (o?.kind === "checkpointGrant" && o.result?.kind === "acknowledged") (index.acked[o.unit] ??= []).push(o);
  }
  return index;
}
const firstAckedFrom = (list, generation) => {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].result.generation < generation) lo = mid + 1; else hi = mid; }
  return list[lo] ?? null;
};
const e14Starts = (index, bundle) => unitsOf(bundle).map((u) => index.raised.get(`${bundle.inputIds[u]}|${u}`) ?? null);
// ⑤ unit ごとの ack の行（起点の行か ack が無ければ null）。窓の最後の束の保存の待ちもこれで確かめる。
export function e14Acks(index, bundle) {
  const units = unitsOf(bundle);
  return e14Starts(index, bundle).map((start, i) => (start == null ? null : firstAckedFrom(index.acked[units[i]] ?? [], start.generation)));
}
// 起点は owner が射影の前に読んだ時刻（ownerMonotonicMs、P3-UWR-AC08）。欠けているか null の行（C4 の凍結記録の形）は publisher の
// 反映の時刻（monotonicMs）で、今と同じ値になる。新しい起点は旧より早いので、新旧を同じ指標として並べない。
const e14Origin = (start) => start.ownerMonotonicMs ?? start.monotonicMs;
export function e14Bundle(index, bundle) {
  const units = unitsOf(bundle);
  const starts = e14Starts(index, bundle);
  const notAdopted = units.filter((_, i) => starts[i] == null);
  if (notAdopted.length > 0) return { k: bundle.k, status: "未確認", reason: "inputNotAdopted" };
  const acks = e14Acks(index, bundle);
  const missing = units.filter((_, i) => acks[i] == null);
  if (missing.length > 0) return { k: bundle.k, status: "未確認", reason: `notAcknowledged:${missing.join(",")}` };
  // 重なりを見る unit は束の overlapUnits（C6 の --e14-tsunami は U-E と U-T の組、AC08④・Q-C6-IMPL-AMEND (9)）。無ければ束の全 unit（C4 の規則）。
  const overlap = units.flatMap((u, i) => ((bundle.overlapUnits ?? units).includes(u) ? [i] : []));
  if (!(Math.max(...overlap.map((i) => e14Origin(starts[i]))) < Math.min(...overlap.map((i) => acks[i].doneReceivedMonotonicMs)))) return { k: bundle.k, status: "未確認", reason: "notSimultaneous" };
  // P3-MH-AC04: owner 側の区間（起点の行の monotonicMs − ownerMonotonicMs、P3-UWR-AC08）。ownerMonotonicMs の無い行は null（0 と数えない）。
  return { k: bundle.k, status: "linked", dirtyToAckMs: Object.fromEntries(units.map((u, i) => [u, acks[i].doneReceivedMonotonicMs - e14Origin(starts[i])])),
    ownerSideMs: Object.fromEntries(units.map((u, i) => [u, starts[i].ownerMonotonicMs == null ? null : starts[i].monotonicMs - starts[i].ownerMonotonicMs])) };
}
export function summarizeE14(records, { bundles, limitMs = 3000 }) {
  const index = e14Index(records);
  const results = bundles.map((b) => e14Bundle(index, b));
  const linked = results.filter((r) => r.status === "linked");
  const reasons = {};
  for (const r of results.filter((x) => x.status !== "linked")) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const unitList = bundles.length === 0 ? E14_UNITS : unitsOf(bundles[0]);
  const units = Object.fromEntries(unitList.map((u) => {
    const values = linked.map((r) => r.dirtyToAckMs[u]);
    return [u, { ...(quantiles(values) ?? {}), overLimit: values.filter((v) => v > limitMs).length }];
  }));
  // 成立した束の unit ごとの owner 側の区間の分位点と、ownerMonotonicMs の無い行の数（C4 の凍結記録は全部この形）。
  const ownerSide = Object.fromEntries(unitList.map((u) => {
    const values = linked.flatMap((r) => (r.ownerSideMs[u] == null ? [] : [r.ownerSideMs[u]]));
    return [u, { ...(quantiles(values) ?? {}), rows: values.length, ownerMonotonicMsMissing: linked.length - values.length }];
  }));
  // Q-MH-E14=B: 重なりを見ない unit（束の overlapUnits の外）の dirty→ack は、束の成立に依らず、その unit の起点と ack が引けた束の全部から出す。
  const outsideOverlap = Object.fromEntries(unitList.filter((u) => bundles.length > 0 && bundles[0].overlapUnits != null && !bundles[0].overlapUnits.includes(u)).map((u) => {
    const values = bundles.flatMap((b) => {
      const start = index.raised.get(`${b.inputIds[u]}|${u}`);
      const ack = start == null ? null : e14Acks(index, { k: b.k, inputIds: { [u]: b.inputIds[u] } })[0];
      return ack == null ? [] : [ack.doneReceivedMonotonicMs - e14Origin(start)];
    });
    return [u, { ...(quantiles(values) ?? {}), rows: values.length, overLimit: values.filter((v) => v > limitMs).length }];
  }));
  return { status: linked.length === 0 ? "未確認" : null, bundles: bundles.length, linked: linked.length, unconfirmed: reasons, units, ownerSide, outsideOverlap, limitMs,
    note: "unit ごとの dirty→ack。各保存の p99 の和を全体の p99 と呼ばない（P3-C4-AC13(3)⑥）。outsideOverlap は束の overlapUnits の外の unit（既定では U-E〔Q-MH-E14=B〕、--e14-tsunami では U-W・U-F）の dirty→ack を束の成立に依らず出す。ownerSide は起点を owner の時刻へ早めた分（monotonicMs − ownerMonotonicMs、P3-UWR-AC08）を別に報告する。Mac の値は報告で、判定場所は Pi（P5）" };
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

// E12 の新側（P3-C4 工程2d）: XML の処理の大半は owner の thread にあるので、publisher だけでなく owner の全部も thread ごとに GC と heap の
// 前後を出す。heap は publisher が mem 行、owner が ownerHeap の行（deadlineDone ごと、P3-C4-OWNER-HEAP=B'）。GC は thread ごとの probe
// （probe-preload.mjs）で、owner の probe が無いか、replay の終わりより前に書かれたもの（以後の GC が欠けうる）なら、その thread は未確認。
// どれかの thread が未確認なら新側は未確認。RSS は process 全体なので thread ごとに足し合わせない。
// seismic は c4 の表に行が無いので、E05C の基線の差（D_start・D_late）は null（未確認）になる（Q-SP-PRECHECK (7)(b)）。
export const E12_THREADS = ["publisher", "urgent", "weatherCurrent", "deferred", "seismic"];
export function summarizeE12New(records, probes, { startMs, endMs }) {
  const ownerRows = (place) => records.flatMap((r) => (r.t === "obs" && r.o.kind === "ownerHeap" && r.o.place === place
    ? [{ t: "mem", perfNowMs: r.o.monotonicMs, heapUsed: r.o.heapUsedBytes }] : []));
  const threads = Object.fromEntries(E12_THREADS.map((thread) => {
    const probe = probes[thread];
    if (probe == null) return [thread, { status: "未確認", reason: "probeMissing" }];
    if (thread !== "publisher" && !(probe.writtenAtMs >= endMs)) return [thread, { status: "未確認", reason: "probeWrittenBeforeReplayEnd" }];
    const bracket = bracketMem(thread === "publisher" ? records : ownerRows(thread), startMs, endMs);
    return [thread, summarizeReplayWindow({ probe, startMs, endMs, ...bracket })];
  }));
  return { status: Object.values(threads).some((t) => t.status != null) ? "未確認" : null, threads };
}

// read() の host の記録が ready を満たすまで待つ。timeoutMs までに満たさなければ false（呼び出し側が未確認にする）。
async function waitRecords(read, ready, { timeoutMs, pollMs = 200 }) {
  const until = performance.now() + timeoutMs;
  for (;;) {
    if (ready(read())) return true;
    if (performance.now() >= until) return false;
    await new Promise((wake) => setTimeout(wake, pollMs));
  }
}
// E12 の新側の後値は、対象の入力の処理が全部終わってから取る（P3-C4 工程2d）。count は送った入力の数で、processing の行（入力ごとに処理の
// 完了で 1 行）が count 件になれば true。
export const waitInputsDone = (read, count, { timeoutMs = 60_000, pollMs = 200 } = {}) =>
  waitRecords(read, (records) => records.filter((r) => r.t === "obs" && r.o.kind === "processing").length >= count, { timeoutMs, pollMs });
// E12 の新側の前値: owner の heap は deadlineDone（1 秒の tick）の返信からしか出ないので、owner の全部の ownerHeap の行が出てから再生を始める
// （P3-C4 工程2d。接続の直後に始めると、小型の窓で owner の開始前の行が無い）。
export const waitOwnerHeaps = (read, { timeoutMs = 10_000, pollMs = 100 } = {}) => waitRecords(read, (records) => {
  const places = new Set(records.flatMap((r) => (r.t === "obs" && r.o.kind === "ownerHeap" ? [r.o.place] : [])));
  return E12_THREADS.every((thread) => thread === "publisher" || places.has(thread));
}, { timeoutMs, pollMs });

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

// P3-E05C-AC03: E05-P の山の分類（判定表は窓の前に固定、境界は作者承認 Q-E05C-AUTHOR）。rowsByThread は thread ごとの preload の行
// （probe-preload.mjs の FLEQ_MEM_OUT、file の順）。publisher の mem 行を時刻順に 1 回なめて山を切り、各山の値は thread ごとの行を二分探索で
// 引く（山ごとに全行を走査し直さない、P3-E05C-RES-04）。RSS は publisher の行の rss（process 全体）で、thread の値を足し合わせない。
// rows（atMs の昇順）で atMs が t 以下（strict なら t 未満）の行の数。
const countUpTo = (rows, t, strict = false) => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (strict ? rows[mid].atMs < t : rows[mid].atMs <= t) lo = mid + 1; else hi = mid; }
  return lo;
};
// 時刻 t の成分（E12_THREADS のそれぞれの t 以前の最新の行から）。行の無い thread があれば null。
function partsAt(mem, t, rss) {
  const latest = E12_THREADS.map((p) => mem[p][countUpTo(mem[p], t) - 1] ?? null);
  if (latest.includes(null)) return null;
  const sum = (f) => latest.reduce((a, r) => a + f(r), 0);
  const U = sum((r) => r.heapUsed);
  const V = sum((r) => r.heapTotal - r.heapUsed);
  const X = sum((r) => r.external);
  return { U, V, X, A: sum((r) => r.arrayBuffers), O: rss - U - V - X, oldestAgeMs: latest.reduce((a, r) => Math.max(a, t - r.atMs), 0) };
}
const tally = (peaks) => {
  const counts = {};
  for (const p of peaks) counts[p.judgement] = (counts[p.judgement] ?? 0) + 1;
  return counts;
};

// AC03(2) の 1 つの山。GC の run は始まりの後の最初の閾値の GC（E12_THREADS の forcedGc の行）で g と r を出す。
function e05cPeak(peak, { pub, mem, forced, gcRun }) {
  const { start, top, end } = peak;
  let floor = null;
  for (let j = peak.startIndex - 1; j >= 0 && pub[j].atMs >= start.atMs - 30_000; j--) if (floor == null || pub[j].rss < floor.rss) floor = pub[j];
  const row = { startMs: start.atMs, endMs: end?.atMs ?? null, peakMs: top.atMs, peakRssBytes: top.rss, floorMs: floor?.atMs ?? null, floorRssBytes: floor?.rss ?? null };
  const atTop = partsAt(mem, top.atMs, top.rss);
  const atFloor = floor == null ? null : partsAt(mem, floor.atMs, floor.rss);
  const unconfirmed = (reason, extra = {}) => ({ ...row, ...extra, judgement: "J0", reason });
  if (atTop == null || atFloor == null) return unconfirmed("rowsMissing");
  const E = top.rss - floor.rss;
  const delta = { U: atTop.U - atFloor.U, V: atTop.V - atFloor.V, X: atTop.X - atFloor.X, O: atTop.O - atFloor.O, arrayBuffers: atTop.A - atFloor.A };
  const fu = delta.U / E;
  const fv = delta.V / E;
  const fxo = (delta.X + delta.O) / E;
  const base = { eBytes: E, deltaBytes: delta, oldestRowAgeMs: atTop.oldestAgeMs,
    distances: { u: fu - 0.5, v: fv - 0.5, xo: fxo - 0.5, staleMs: atTop.oldestAgeMs - 1000 } };
  if (atTop.oldestAgeMs > 1000) return unconfirmed("staleThread", base);
  let g = null;
  let r = null;
  if (gcRun) {
    const request = [...forced.publisher.values()].find((f) => f.reason === "threshold" && f.requestedAtMs >= start.atMs && (end == null || f.requestedAtMs <= end.atMs));
    if (request == null) return unconfirmed("noThresholdGc", base);
    const rows = E12_THREADS.map((p) => forced[p].get(request.id)).filter((f) => f != null && f.error == null);
    if (rows.length < E12_THREADS.length) return unconfirmed("forcedGcRowsMissing", base);
    const before = rows.reduce((a, f) => a + f.before.heapUsed, 0);
    const afterRegular = rows.reduce((a, f) => a + f.afterRegular.heapUsed, 0);
    g = (before - afterRegular) / Math.max(before - atFloor.U, MiB);
    // r は最後の thread の last-resort の終わりから 2,000ms 以内の最小の rss で見る（通常の GC の後の rss は rRegular として報告だけ、AC02）。
    const den = request.before.rss - floor.rss;
    const lastEndMs = rows.reduce((a, f) => Math.max(a, f.endMs), -Infinity);
    let minRss = null;
    for (let i = countUpTo(pub, lastEndMs, true); i < pub.length && pub[i].atMs <= lastEndMs + 2000; i++) minRss = Math.min(minRss ?? Infinity, pub[i].rss);
    const gc = { id: request.id, g, r: null, rRegular: den === 0 ? null : (request.before.rss - request.afterRegular.rss) / den, rssMinWithin2sBytes: minRss,
      rssAt5sBytes: pub[countUpTo(pub, lastEndMs + 5000, true)]?.rss ?? null,
      receiveDelayMs: Object.fromEntries(rows.map((f) => [f.place, f.startMs - f.requestedAtMs])) };
    Object.assign(base.distances, { g06: g - 0.6, g03: g - 0.3 });
    if (den < MiB) return unconfirmed("rDenominatorBelow1MiB", { ...base, gc });
    if (minRss == null) return unconfirmed("rowsMissing", { ...base, gc });
    r = (request.before.rss - minRss) / den;
    gc.r = r;
    Object.assign(base.distances, { r06: r - 0.6, r03: r - 0.3 });
    base.gc = gc;
  }
  // 上から最初に当たる行。観測だけの run では J1 と J4 を分けられないので「J1/J4」と読む（GC の run で分ける）。
  const judgement = fu >= 0.5 && (!gcRun || (g >= 0.6 && r >= 0.6)) ? (gcRun ? "J1" : "J1/J4")
    : fv >= 0.5 && (!gcRun || r >= 0.6) ? "J2"
    : fxo >= 0.5 || (gcRun && g >= 0.6 && r <= 0.3) ? "J3"
    : gcRun && fu >= 0.5 && g <= 0.3 ? "J4" : "J5";
  return { ...row, ...base, judgement };
}

// AC03(3): run の分類は J0 を除いた山で決める。J0 が山の 1/3 を超えたか、山が無い run は未確認。比は整数で比べる（2/3・1/4 の丸めを避ける）。
function e05cRunClass(peaks) {
  const counts = tally(peaks);
  const j0 = counts.J0 ?? 0;
  const over400 = tally(peaks.filter((p) => p.peakRssBytes > 400 * MiB));
  const top = peaks.reduce((a, p) => (a == null || p.peakRssBytes > a.peakRssBytes ? p : a), null);
  const largestPeak = top == null ? null : { peakMs: top.peakMs, peakRssBytes: top.peakRssBytes, judgement: top.judgement,
    mainComponent: top.deltaBytes == null ? null : [["U", top.deltaBytes.U], ["V", top.deltaBytes.V], ["XO", top.deltaBytes.X + top.deltaBytes.O]].reduce((a, b) => (b[1] > a[1] ? b : a))[0] };
  const report = { counts, over400, largestPeak };
  if (peaks.length === 0 || 3 * j0 > peaks.length) return { status: "未確認", reason: peaks.length === 0 ? "noPeak" : "j0OverOneThird", ...report };
  const n = peaks.length - j0;
  // 山の数が同じ判定は番号の小さい方を先（"J1/J4" は 1 の位置）。
  const judged = Object.entries(counts).filter(([j]) => j !== "J0").sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const [[jx, nx], [jy, ny] = [null, 0]] = judged;
  const kind = 4 * ny >= n ? { kind: "mixed", primary: jx, secondary: jy } : 3 * nx >= 2 * n ? { kind: "single", primary: jx }
    : { kind: "mixedRatios", ratios: Object.fromEntries(judged.map(([j, c]) => [j, c / n])) };
  return { status: null, ...kind, ...report };
}

// AC03(4): GC の run のふだんの Σheap の差。区切りの GC（充填の前 L_pre・静まりの後 L_post）と、測定の開始から 300 秒以後の基準の GC の後の
// heapUsed（通常の GC の後）の中央値 G_late を thread ごとに出す。c4 は C4 の開始の最小（start）と平ら（flat）。phaseMissing は runner の区切りの
// 待ち（AC04(3)）の結果で、区切りごとに待ちの終わりに行が揃わなかった thread。その thread の L は、後から届いた行があっても null（待ちの結果を
// 真実源にする。受けた遅れの時刻は publisher のシグナル処理の遅れを含まないので判定に使わない）。待ちの結果が無い区切りも null。
// 出せる値は出し、判定に要る値（S・D_start・D_late・Grow）が 1 つでも欠けた thread の judgement は null（未確認）。
function e05cBaseline(forced, { measureFromMs, measureToMs, c4, phaseMissing }) {
  const ids = (reason, keep = () => true) => [...forced.publisher.values()].filter((f) => f.reason === reason && keep(f)).map((f) => f.id).sort((a, b) => a - b);
  const [preId, postId] = ids("phase");
  const late = ids("baseline", (f) => f.requestedAtMs >= measureFromMs + 300_000 && f.requestedAtMs <= measureToMs);
  const heapAfter = (p, id) => forced[p].get(id)?.afterRegular?.heapUsed ?? null;
  const phaseAfter = (p, k, id) => (phaseMissing?.[k] == null || phaseMissing[k].includes(p) ? null : heapAfter(p, id));
  const diff = (a, b) => (a == null || b == null ? null : a - b);
  const threads = Object.fromEntries(E12_THREADS.map((p) => {
    const lPre = phaseAfter(p, 0, preId);
    const lPost = phaseAfter(p, 1, postId);
    const gLate = median(late.map((id) => heapAfter(p, id)).filter((v) => v != null));
    const [S, dStart, dLate, grow] = [diff(lPost, lPre), diff(lPost, c4.start[p]), diff(gLate, c4.flat[p]), diff(gLate, lPost)];
    // 区切りと基準の GC の後の heapUsed を時刻つきで並べる（AC03(4)）。
    const gcs = [...forced[p].values()].filter((f) => f.reason === "phase" || f.reason === "baseline")
      .map((f) => ({ id: f.id, reason: f.reason, requestedAtMs: f.requestedAtMs, startMs: f.startMs, heapUsed: f.afterRegular?.heapUsed ?? null }));
    const values = { lPre, lPost, gLate, baselineGcs: late.length, S, dStart, dLate, grow, gcs };
    if ([S, dStart, dLate, grow].includes(null)) return [p, { ...values, judgement: null }];
    // ①〜③はどれか 1 つ（D_start＜20MiB で D_late≥20MiB なら当てない）、④は並べて出す。どれにも当たらなければ混合。
    const marks = [...(dStart < 20 * MiB && dLate < 20 * MiB ? ["①"] : []), ...(dStart >= 20 * MiB ? [S >= dStart - 10 * MiB ? "②" : "③"] : []),
      ...(grow >= 10 * MiB ? ["④"] : [])];
    return [p, { ...values, judgement: marks.length === 0 ? ["混合"] : marks }];
  }));
  const sum = (key) => (Object.values(threads).some((t) => t[key] == null) ? null : Object.values(threads).reduce((a, t) => a + t[key], 0));
  return { threads, sumDStartBytes: sum("dStart"), sumDLateBytes: sum("dLate"), note: "+55MiB は平らの差（Σ D_late）、測定の開始の時点の差は Σ D_start" };
}

export function classifyE05cRun(rowsByThread, { thresholdBytes, rearmBelowBytes, gcRun, measureFromMs, measureToMs, c4, phaseMissing = null }) {
  const mem = {};
  const forced = {};
  const threads = {};
  for (const p of E12_THREADS) {
    const rows = rowsByThread[p] ?? [];
    mem[p] = rows.filter((r) => r.k === "mem");
    forced[p] = new Map(rows.filter((r) => r.k === "forcedGc").map((r) => [r.id, r]));
    const start = rows.find((r) => r.k === "start");
    threads[p] = { rows: mem[p].length, maxGapMs: mem[p].reduce((a, r, i) => (i === 0 ? a : Math.max(a ?? 0, r.atMs - mem[p][i - 1].atMs)), null),
      lastMs: mem[p].at(-1)?.atMs ?? null, gcAvailable: start?.gcAvailable ?? null, nodeVersion: start?.nodeVersion ?? null,
      gcEntries: rows.filter((r) => r.k === "gc").length, forcedGcErrors: rows.filter((r) => r.k === "forcedGc" && r.error != null).map((r) => r.error) };
  }
  // 山＝rss が閾値以上の連続区間（始まり＝最初に閾値以上の行、終わり＝rearm〔閾値−50MiB〕未満の最初の行）。測定の窓に始まる山だけを数える。
  const pub = mem.publisher;
  const found = [];
  let open = null;
  for (let i = 0; i < pub.length; i++) {
    const r = pub[i];
    if (open == null) { if (r.rss >= thresholdBytes) open = { startIndex: i, start: r, top: r }; } else if (r.rss < rearmBelowBytes) { found.push({ ...open, end: r }); open = null; } else if (r.rss > open.top.rss) open.top = r;
  }
  if (open != null) found.push({ ...open, end: null });
  const peaks = found.filter((p) => p.start.atMs >= measureFromMs && p.start.atMs <= measureToMs).map((p) => e05cPeak(p, { pub, mem, forced, gcRun }));
  const reasons = (reason, keep = () => true) => [...forced.publisher.values()].filter((f) => f.reason === reason && keep(f)).length;
  // 閾値の GC は publisher が局面を知らずに撃つので、上限（maxForced）を測定の前（充填など）でどれだけ使ったかを分けて出す。
  return { threads, peaks, run: e05cRunClass(peaks),
    forcedGc: { threshold: reasons("threshold"), thresholdBeforeMeasure: reasons("threshold", (f) => f.requestedAtMs < measureFromMs),
      thresholdInMeasure: reasons("threshold", (f) => f.requestedAtMs >= measureFromMs && f.requestedAtMs <= measureToMs),
      capped: (rowsByThread.publisher ?? []).filter((r) => r.k === "capped").length, baseline: reasons("baseline"), phase: reasons("phase") },
    baseline: gcRun ? e05cBaseline(forced, { measureFromMs, measureToMs, c4, phaseMissing }) : null };
}
