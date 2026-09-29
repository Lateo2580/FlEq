// P2-A10-AC03/AC04/AC05: 生の証拠（host の JSONL・投入側の記録・Chrome の trace・時計 probe）から EewTraceSample と EewInjectionRecord を組む。
// 判定・分位点・自己 hash はここで書かない（WP2 の judge.ts が持つ）。I/O も時計も持たない純粋関数。
// 無いと、候補 mark の時刻や DOM 更新を T6 に転記してしまい、実 paint 証拠のない遅延が Pass の根拠になる。

import { parseChromeMarkerDetail } from "../../dist/src/measurement/eew-e01/frozen.js";

const T5 = "fleq:p2:eew:T5";
const T6C = "fleq:p2:eew:T6-candidate";
const MARK_ROUNDING_MS = 0.1; // Chrome の performance.now は 0.1ms 単位に丸められる
const HOST_OFFSET_SLACK_MS = 0.01; // launcher が hrtime と performance.now を続けて読む間の差
const PROBE_MAX_AGE_MS = 35_000; // 30 秒ごとの refresh に 5 秒の余裕
export const versionKey = (v) => `${v.streamId}\u0000${v.sequence}`;

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const push = (map, key, value) => { const list = map.get(key); if (list == null) map.set(key, [value]); else list.push(value); };

// ── Chrome の trace ──
// 候補 mark → 直後の renderer Commit → その Commit を子段に含む PipelineReporter（STATE_PRESENTED_ALL）の終端 = T6。
// DOM 更新・rAF・候補 mark の時刻は使わない。対応が取れない mark は paint=null（T6 なし）。
export function analyzeTrace(events) {
  const marks = [];
  let rejectedMarks = 0;
  const open = new Map();
  const reporters = new Map(); // pid → PipelineReporter の span（子段つき）
  const spansById = new Map(); // `${pid}|${id}` → 子段
  const commits = new Map(); // pid → Commit の ts（昇順）
  const shots = new Map(); // frame_sequence → true
  for (const e of events) {
    if (e.name === T5 || e.name === T6C) {
      const data = e.args?.data;
      const detail = data == null ? null : parseChromeMarkerDetail(typeof data.detail === "string" ? parseJson(data.detail) : data.detail);
      if (detail == null || detail.name !== e.name || typeof data.startTime !== "number") { rejectedMarks++; continue; }
      marks.push({ name: e.name, pid: e.pid, ts: e.ts, startMs: data.startTime, detail });
    } else if (e.name === "Screenshot") {
      if (e.args?.frame_sequence != null) shots.set(e.args.frame_sequence, true);
    } else if ((e.ph === "b" || e.ph === "e") && typeof e.cat === "string" && e.cat.includes("timeline.frame")) {
      if (e.name === "Commit" && e.ph === "b") push(commits, e.pid, e.ts); // 非同期 span の開始が Commit の時刻
      const id = `${e.pid}|${e.id2?.local ?? e.id2?.global ?? e.id}`;
      const key = `${e.name}|${id}`;
      if (e.ph === "b") { open.set(key, e); continue; }
      const begin = open.get(key);
      if (begin == null) continue;
      open.delete(key);
      const span = { name: e.name, begin: begin.ts, end: e.ts, args: begin.args };
      push(spansById, id, span);
      if (e.name === "PipelineReporter") push(reporters, e.pid, { ...span, id });
    }
  }
  for (const list of commits.values()) list.sort((a, b) => a - b);

  const paintOf = (mark) => {
    const commit = (commits.get(mark.pid) ?? []).find((ts) => ts >= mark.ts);
    if (commit == null) return null;
    const hit = (reporters.get(mark.pid) ?? []).filter((r) => {
      const reporter = r.args?.frame_reporter ?? r.args?.chrome_frame_reporter;
      return reporter?.state === "STATE_PRESENTED_ALL" && r.end >= commit &&
        (spansById.get(r.id) ?? []).some((c) => (c.name === "Commit" || c.name === "SendBeginMainFrameToCommit") && c.begin <= commit + 1 && c.end >= commit && c.begin >= r.begin && c.end <= r.end);
    }).sort((a, b) => a.end - b.end)[0];
    if (hit == null) return null;
    const frameSequence = (hit.args.frame_reporter ?? hit.args.chrome_frame_reporter).frame_sequence;
    const origin = mark.ts - mark.startMs * 1000; // mark 自身の ts と startTime から trace 時計 → Chrome の performance.now への対応
    return { chromeMs: (hit.end - origin) / 1000, paintEvidenceId: `frame:${frameSequence}${shots.has(frameSequence) ? "/screenshot" : ""}`, hasScreenshot: shots.has(frameSequence) };
  };

  const byVersion = new Map();
  for (const mark of marks) {
    const key = versionKey(mark.detail.displayVersion);
    const entry = byVersion.get(key) ?? { t5Ms: null, candidate: null, paint: null };
    if (mark.name === T5) entry.t5Ms = mark.startMs;
    else { entry.candidate = mark.detail; entry.paint = paintOf(mark); }
    byVersion.set(key, entry);
  }
  return { byVersion, rejectedMarks, markCount: marks.length };
}

// ── host の JSONL ──
export function buildHostIndex(lines) {
  const index = { meta: null, t0: new Map(), t1: new Map(), t2: new Map(), decode: new Map(), processing: [], checkpoints: [], t3: [], t4: [],
    publishes: [], clock: [], mem: [] };
  for (const line of lines) {
    if (line.t === "meta") index.meta = line;
    else if (line.t === "clock") index.clock.push({ hrMs: Number(BigInt(line.hrtimeNs)) / 1e6, perfMs: line.perfNowMs });
    else if (line.t === "mem") index.mem.push(line);
    else if (line.t === "obs") {
      const o = line.o;
      if (o.kind === "marker" && "inputId" in o) index[o.point === "T0" ? "t0" : o.point === "T1" ? "t1" : "t2"].set(o.inputId, o.monotonicMs);
      else if (o.kind === "marker") index[o.point === "T3" ? "t3" : "t4"].push({ ms: o.monotonicMs, version: o.displayVersion, key: versionKey(o.displayVersion) });
      else if (o.kind === "decode") index.decode.set(o.inputId, { startMs: o.startedMonotonicMs, endMs: o.endedMonotonicMs });
      else if (o.kind === "processing") index.processing.push(o.measurement);
      else if (o.kind === "checkpoint") index.checkpoints.push(o.measurement);
      else if (o.kind === "publishSerialization") index.publishes.push(o);
    }
  }
  const offsets = index.clock.map((c) => c.perfMs - c.hrMs);
  // host 時計 = 投入側の hrtime(ms) + offset。行ごとの差（時計の進み方の差を含む）を区間に入れる。
  index.ohLo = offsets.length === 0 ? null : Math.min(...offsets) - HOST_OFFSET_SLACK_MS;
  index.ohHi = offsets.length === 0 ? null : Math.max(...offsets) + HOST_OFFSET_SLACK_MS;
  return index;
}

// ── 時計対応（host の時計領域で表す） ──
// chrome = host + δ。Chrome の受信・返信が Node の送信〜受信の間に起きたことから δ ∈ [cs − nr, cr − ns]。
export function correspondences(probes, host) {
  if (host.ohLo == null) return [];
  return probes.map(({ probeId, chosen, attempts }) => {
    const nodeSent = chosen.nodeSentHrMs + host.ohLo;
    const nodeReceived = chosen.nodeReceivedHrMs + host.ohHi;
    const lower = chosen.chromeSentMonotonicMs - nodeReceived;
    const upper = chosen.chromeReceivedMonotonicMs - nodeSent;
    return { probeId, nodeSentMonotonicMs: nodeSent, chromeReceivedMonotonicMs: chosen.chromeReceivedMonotonicMs,
      chromeSentMonotonicMs: chosen.chromeSentMonotonicMs, nodeReceivedMonotonicMs: nodeReceived,
      offsetLowerMs: lower, offsetUpperMs: upper, intervalWidthMs: upper - lower, attemptCount: attempts.length };
  });
}

const nearestProbe = (list, hostMs) => {
  let best = null;
  for (const c of list) {
    const gap = Math.abs((c.nodeSentMonotonicMs + c.nodeReceivedMonotonicMs) / 2 - hostMs);
    if (gap <= PROBE_MAX_AGE_MS && (best == null || gap < best.gap)) best = { c, gap };
  }
  return best?.c ?? null;
};

// ── 標本の組み立て ──
// trials: 投入側の EEW 試行 { index, inputId, subject, scheduledHrMs, injectedHrMs|null, block }
// blocks: trace の塊 { dataLoss }（trial.block が指す）
export function assembleTrials({ population, run, trials, host, chromeByVersion, probes, blocks, callbackDeadlineMs, missingAfterMs }) {
  const runId = host.meta?.runId ?? "unknown";
  const corr = correspondences(probes, host);
  const t0s = [...host.t0.values()].sort((a, b) => a - b);
  const samples = [];
  const injections = [];
  const details = [];
  for (const tr of trials) {
    const [t0, t1, t2] = [host.t0.get(tr.inputId), host.t1.get(tr.inputId), host.t2.get(tr.inputId)];
    const waitUpper = t0 == null || tr.injectedHrMs == null ? null : t0 - tr.injectedHrMs - host.ohLo;
    const outcome = tr.injectedHrMs == null ? "notInjected" : t0 == null || waitUpper > callbackDeadlineMs ? "callbackTimeout" : t1 == null ? "rejected" : "callbackReached";
    injections.push({ runId, inputId: tr.inputId, population, run, sampleIndex: tr.index, scheduledInjectorMonotonicMs: tr.scheduledHrMs,
      injectedInjectorMonotonicMs: tr.injectedHrMs, outcome, hostOffsetLowerMs: host.ohLo, hostOffsetUpperMs: host.ohHi });
    const node = (point, monotonicMs) => monotonicMs == null ? [] : [{ point, clock: "node", monotonicMs }];
    const base = { schemaVersion: "p2-eew-trace-v2", population, run, sampleIndex: tr.index };
    const nullCorrelation = { runId, inputId: tr.inputId, operation: "normal", subject: tr.subject, semanticRevision: null, displayVersion: null };
    const fail = (missingReason, markers) => ({ ...base, correlation: nullCorrelation, markers, clockProbeId: null, latencyLowerMs: null, latencyUpperMs: null, missing: true, missingReason });
    if (outcome !== "callbackReached") {
      samples.push(fail("callbackNotReached", node("T0", t0)));
      details.push({ index: tr.index, outcome, sample: "callbackNotReached" });
      continue;
    }
    const head = [...node("T0", t0), ...node("T1", t1), ...node("T2", t2)];
    const from = t2 ?? t0;
    const until = t0s.find((t) => t > t0) ?? Infinity;
    // 版の結合: この入力の処理開始から次の入力の受信までの T3 のうち、Chrome が候補 mark を出した版だけ（後着結合）。
    const cands = host.t3.filter((x) => x.ms >= from && x.ms < until && chromeByVersion.get(x.key)?.candidate?.subject === tr.subject);
    if (cands.length === 0) {
      const lost = blocks[tr.block]?.dataLoss === true;
      samples.push(fail(lost ? "traceIncomplete" : "paintNotObservedWithin10s", head));
      details.push({ index: tr.index, outcome, sample: lost ? "traceIncomplete(dataLoss)" : "noChromeCandidateInWindow" });
      continue;
    }
    if (cands.length > 1) {
      samples.push(fail("traceIncomplete", head));
      details.push({ index: tr.index, outcome, sample: "ambiguousVersions", count: cands.length });
      continue;
    }
    const cand = cands[0];
    const chrome = chromeByVersion.get(cand.key);
    const t4 = host.t4.find((x) => x.key === cand.key && x.ms >= cand.ms)?.ms ?? null;
    const markers = [...head, ...node("T3", cand.ms), ...node("T4", t4)];
    if (chrome.t5Ms != null) markers.push({ point: "T5", clock: "chrome", monotonicMs: chrome.t5Ms });
    const correlation = { runId, inputId: tr.inputId, operation: chrome.candidate.operation, subject: tr.subject,
      semanticRevision: cand.version.semanticRevision, displayVersion: cand.version };
    if (chrome.paint == null) {
      samples.push({ ...base, correlation, markers, clockProbeId: null, latencyLowerMs: null, latencyUpperMs: null, missing: true, missingReason: "traceIncomplete" });
      details.push({ index: tr.index, outcome, sample: "candidateWithoutPaintLink" });
      continue;
    }
    markers.push({ point: "T6", clock: "chrome", monotonicMs: chrome.paint.chromeMs, paintEvidenceId: chrome.paint.paintEvidenceId,
      cardMarkerId: chrome.candidate.cardMarkerId, mapMarkerId: chrome.candidate.mapMarkerId });
    const probe = nearestProbe(corr, t0);
    const lower = probe == null ? null : chrome.paint.chromeMs - t0 - probe.offsetUpperMs - MARK_ROUNDING_MS;
    const upper = probe == null ? null : chrome.paint.chromeMs - t0 - probe.offsetLowerMs + MARK_ROUNDING_MS;
    // 10 秒を超えて描かれた標本は欠落（DLV-02）。
    const late = lower != null && lower > missingAfterMs;
    samples.push({ ...base, correlation, markers, clockProbeId: probe?.probeId ?? null, latencyLowerMs: lower, latencyUpperMs: upper,
      missing: late, missingReason: late ? "paintNotObservedWithin10s" : null });
    details.push({ index: tr.index, outcome, sample: "linked", t0ToT3Ms: cand.ms - t0, t3ToT4Ms: t4 == null ? null : t4 - cand.ms,
      hasScreenshot: chrome.paint.hasScreenshot, latencyLowerMs: lower, latencyUpperMs: upper });
  }
  return { samples, injections, details, correspondences: corr };
}

// ── 参考測定: 投入が対象区間に入ったか（決定 2 の記録項目） ──
// target: { startMs, endMs, stages? }（host 時計）。trial: 投入側の EEW 試行。
export function referenceRecord({ trial, target, host, injection }) {
  const t0 = host.t0.get(trial.inputId) ?? null;
  const t1 = host.t1.get(trial.inputId) ?? null;
  const t2 = host.t2.get(trial.inputId) ?? null;
  const base = { index: trial.index, inputId: trial.inputId, outcome: injection.outcome, t0Ms: t0, t1Ms: t1, t2Ms: t2 };
  if (target == null || trial.injectedHrMs == null) return { ...base, judgement: "noTarget" };
  const lo = trial.injectedHrMs + host.ohLo;
  const hi = trial.injectedHrMs + host.ohHi;
  const inside = target.startMs <= lo && hi <= target.endMs ? "yes" : hi < target.startMs || lo > target.endMs ? "no" : "ambiguous";
  const t0MinusStart = t0 == null ? null : t0 - target.startMs;
  const t0AtOrAfterEnd = t0 == null ? null : t0 >= target.endMs;
  const judgement = t0 == null ? "callbackNotReached" : inside !== "yes" ? "injectionOutsideTarget" : !t0AtOrAfterEnd ? "callbackDuringTarget"
    : t0MinusStart > 5 ? "insideTargetCallbackAfterEnd" : "insideTargetCallbackAtStart";
  const stages = (target.stages ?? []).map((s) => ({ stage: s.stage, startMs: s.startMs, endMs: s.endMs,
    waitOverlapMs: t0 == null ? null : Math.max(0, Math.min(t0, s.endMs) - Math.max(hi, s.startMs)) }));
  return { ...base, target: { startMs: target.startMs, endMs: target.endMs }, injectionInsideTarget: inside,
    injectionOffsetFromStartMs: [lo - target.startMs, hi - target.startMs], t0MinusStartMs: t0MinusStart, t0AtOrAfterEnd, judgement, stages };
}
