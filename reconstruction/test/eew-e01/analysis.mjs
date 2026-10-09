// P2-A10-AC03/AC04/AC05: 生の証拠（host の JSONL・投入側の記録・Chrome の trace・時計 probe）から EewTraceSample と EewInjectionRecord を組む。
// 判定・分位点・自己 hash はここで書かない（WP2 の judge.ts が持つ）。I/O も時計も持たない純粋関数。
// 無いと、候補 mark の時刻や DOM 更新を T6 に転記してしまい、実 paint 証拠のない遅延が Pass の根拠になる。

import { parseChromeMarkerDetail } from "../../dist/src/measurement/eew-e01/frozen.js";
import { quantiles } from "../../dist/src/measurement/eew-e01/judge.js";

const T5 = "fleq:p2:eew:T5";
const T6C = "fleq:p2:eew:T6-candidate";
const T6T = "fleq:p3:tsunami:T6-candidate";
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
    if (e.name === T5 || e.name === T6C || e.name === T6T) {
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

  const commitOf = (mark) => (commits.get(mark.pid) ?? []).find((ts) => ts >= mark.ts) ?? null;
  const paintOf = (mark) => {
    const commit = commitOf(mark);
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

  // 描画前の置換: 同じ subject の次の候補がこの候補の Commit 以前に出たら、その Commit が描くのは後の版で、この版は提示されていない（T6 なし）。
  // 同じ版の mark は Chrome が 2 件出すことがある（置換ではない）。置換は renderer（pid）と版の単位で記録する。
  // 見るのは同じ subject の後の候補だけ。subject を消す版（候補を出さない）は対象外で、E01 は同じ subject の variant A/B の続報だけなので到達しない。
  // P3-C6-AC06(5): 置換は同じ (renderer, mark 名, subject) の次の候補が Commit 以前に出たか。候補は (版, subject, mark 名) の組で引く（byCandidate）。
  // EEW の候補は A10・C4 の形の集合（renderer と版の単位、byVersion が読む）にも入れる。
  const replaced = new Set(); // EEW: `${pid}|${versionKey}`
  const replacedKeyed = new Set(); // `${pid}|${name}|${subject}|${versionKey}`
  const previous = new Map(); // `${pid}|${name}|${subject}` → 直前の候補 mark
  for (const mark of marks.filter((m) => m.name !== T5).sort((a, b) => a.ts - b.ts)) {
    const key = `${mark.pid}|${mark.name}|${mark.detail.subject}`;
    const prev = previous.get(key);
    previous.set(key, mark);
    if (prev == null || versionKey(prev.detail.displayVersion) === versionKey(mark.detail.displayVersion)) continue;
    const commit = commitOf(prev);
    if (commit == null || mark.ts > commit) continue;
    replacedKeyed.add(`${key}|${versionKey(prev.detail.displayVersion)}`);
    if (mark.name === T6C) replaced.add(`${prev.pid}|${versionKey(prev.detail.displayVersion)}`);
  }
  const byCandidate = new Map();
  for (const mark of marks.filter((m) => m.name !== T5)) {
    const key = candidateKey(mark.detail.displayVersion, mark.detail.subject, mark.name);
    if (byCandidate.has(key)) continue; // 同じ版の mark を Chrome が 2 件出すことがある（置換ではない）
    const replacedBeforePaint = replacedKeyed.has(`${mark.pid}|${mark.name}|${mark.detail.subject}|${versionKey(mark.detail.displayVersion)}`);
    byCandidate.set(key, { candidate: mark.detail, replacedBeforePaint, paint: replacedBeforePaint ? null : paintOf(mark) });
  }

  const byVersion = new Map();
  for (const mark of marks.filter((m) => m.name !== T6T)) {
    const key = versionKey(mark.detail.displayVersion);
    const entry = byVersion.get(key) ?? { t5Ms: null, candidate: null, paint: null, replacedBeforePaint: false };
    if (mark.name === T5) entry.t5Ms = mark.startMs;
    else { entry.candidate = mark.detail; entry.replacedBeforePaint = replaced.has(`${mark.pid}|${key}`); entry.paint = entry.replacedBeforePaint ? null : paintOf(mark); }
    byVersion.set(key, entry);
  }
  return { byVersion, byCandidate, rejectedMarks, markCount: marks.length };
}
export const candidateKey = (version, subject, name) => `${versionKey(version)}\u0000${subject}\u0000${name}`;

// ── host の JSONL ──
export function buildHostIndex(lines) {
  // t2Order・t3 の row は観測の行番号（P3-C4-T3-BINDING の窓は行順で切る。owner 3 本の並行では単調時刻の順と一致しない）。
  const index = { meta: null, t0: new Map(), t1: new Map(), t2: new Map(), t2Order: [], decode: new Map(), processing: [], checkpoints: [], t3: [], t4: [],
    publishes: [], clock: [], mem: [], raised: new Map(), grants: [] };
  for (const [row, line] of lines.entries()) {
    if (line.t === "meta") index.meta = line;
    else if (line.t === "clock") index.clock.push({ hrMs: Number(BigInt(line.hrtimeNs)) / 1e6, perfMs: line.perfNowMs });
    else if (line.t === "mem") index.mem.push(line);
    else if (line.t === "obs") {
      const o = line.o;
      if (o.kind === "marker" && "inputId" in o) {
        index[o.point === "T0" ? "t0" : o.point === "T1" ? "t1" : "t2"].set(o.inputId, o.monotonicMs);
        if (o.point === "T2") index.t2Order.push({ inputId: o.inputId, row });
      } else if (o.kind === "marker") index[o.point === "T3" ? "t3" : "t4"].push({ ms: o.monotonicMs, version: o.displayVersion, key: versionKey(o.displayVersion), row });
      // parse 区間（P3-C4-PARSE-MARK）は工程 2 で decode の観測に載る。無い記録では null。
      else if (o.kind === "decode") index.decode.set(o.inputId, { startMs: o.startedMonotonicMs, endMs: o.endedMonotonicMs,
        parseStartMs: o.xmlParseStartedMonotonicMs ?? null, parseEndMs: o.xmlParseEndedMonotonicMs ?? null });
      else if (o.kind === "processing") index.processing.push(o.measurement);
      else if (o.kind === "checkpoint") index.checkpoints.push(o.measurement);
      else if (o.kind === "publishSerialization") index.publishes.push(o);
      else if (o.kind === "generationRaised") index.raised.set(`${o.inputId}|${o.unit}`, o.generation);
      else if (o.kind === "checkpointGrant") index.grants.push(o);
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

// P3-C4-T3-BINDING: 入力ごとの版の窓の終わり（同じ実行場所の次の入力の T2 の行。無ければ記録の終わり = Infinity）。
// placeOf(inputId) は投入した headType からの実行場所。全入力で同じ値（既定 null）なら、単一スレッドの A10 と同じ「次の入力の T2」になる。
export function windowEnds(host, placeOf = () => null) {
  const ends = new Map();
  const next = new Map();
  for (let i = host.t2Order.length - 1; i >= 0; i--) {
    const { inputId, row } = host.t2Order[i];
    const place = placeOf(inputId);
    ends.set(inputId, { from: row, to: next.get(place) ?? Infinity });
    next.set(place, row);
  }
  return ends;
}
// 行順で (from, to) にある T3。host.t3 は行の昇順なので二分探索で始点を引く。
function t3Between(host, from, to) {
  let lo = 0;
  let hi = host.t3.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (host.t3[mid].row <= from) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < host.t3.length && host.t3[i].row < to; i++) out.push(host.t3[i]);
  return out;
}

// 受信 1 回あたりの view の複製（P3-C4-VIEW-COPY=B、台帳 49）: 観測は足さず構造で数える。入力ごとの公開は P3-C4-T3-BINDING の版の窓
// （windowEnds・t3Between）の T3 の数で、byte と直列化の時間はその版の publishSerialization。thread を越える複製は返信 1 件につき 1 回
// （view を持つかは観測に無いので上界）。T2 の無い入力（T0 の後の拒否など）は結び付かない入力として数える（落とさない）。公開の byte は
// 容量超過では summary になり full view より小さいことがあり、直列化の時間も複製の時間の上界でない。複製の帰属は判定しない。
export function viewCopyReport(records, placeOf = () => null) {
  const host = buildHostIndex(records);
  const byVersion = new Map(host.publishes.map((p) => [versionKey(p.displayVersion), p]));
  const perInput = [];
  for (const [inputId, { from, to }] of windowEnds(host, placeOf)) {
    const t3s = t3Between(host, from, to);
    const published = t3s.map((t) => byVersion.get(t.key)).filter((p) => p != null);
    perInput.push({ inputId, publishes: t3s.length, unserialized: t3s.length - published.length, bytes: published.reduce((a, p) => a + p.bytes, 0),
      serializeMs: published.reduce((a, p) => a + p.durationMs, 0) });
  }
  const q = (values) => quantiles(values);
  return { inputs: perInput.length, unbound: [...host.t0.keys()].filter((id) => !host.t2.has(id)).length, threadCopiesPerInputUpper: 1,
    publishesPerInput: q(perInput.map((i) => i.publishes)), publishBytesPerInput: q(perInput.map((i) => i.bytes)),
    serializeMsPerInput: q(perInput.map((i) => i.serializeMs)), publishesWithoutSerialization: perInput.reduce((a, i) => a + i.unserialized, 0),
    attribution: "帰属不能（参考量）", referenceCopyBytes: "C3a の計量: VPWS50 で view 620,797 byte・返信 622,802 byte" };
}

// 診断の jsonl（diagnostics-*.jsonl の行）から inputId → 理由の文字列。拒否は WARN・ERROR の診断（parser・ingress の拒否は WARN、
// persistent-diagnostic-sink.ts の projectParserDiagnostic）だけを拾い、INFO（期限切れ等の通常の出来事）は拾わない。
// 理由の種類は列挙しない（C3b の裁定で増えうる）。
export function rejectionReasons(diagnosticRecords) {
  const reasons = new Map();
  for (const d of diagnosticRecords) {
    if (typeof d?.inputId !== "string" || typeof d.reason !== "string" || (d.level !== "WARN" && d.level !== "ERROR")) continue;
    const list = reasons.get(d.inputId) ?? [];
    if (!list.includes(d.reason)) list.push(d.reason);
    reasons.set(d.inputId, list);
  }
  return new Map([...reasons].map(([id, list]) => [id, list.join(",")]));
}

// ── 標本の組み立て ──
// trials: 投入側の EEW 試行 { index, inputId, subject, scheduledHrMs, injectedHrMs|null, block }
// blocks: trace の塊 { dataLoss }（trial.block が指す）
// placeOf: 版の窓の実行場所（windowEnds）。rejections: T0 の後に拒否された入力の理由（rejectionReasons）。公開されずに欠落した試行の details に残す。
export function assembleTrials({ population, run, trials, host, chromeByVersion, probes, blocks, callbackDeadlineMs, missingAfterMs, placeOf, rejections = new Map() }) {
  const runId = host.meta?.runId ?? "unknown";
  const corr = correspondences(probes, host);
  const ends = windowEnds(host, placeOf);
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
      details.push({ index: tr.index, outcome, sample: "callbackNotReached", ...(rejections.has(tr.inputId) ? { rejectedReason: rejections.get(tr.inputId) } : {}) });
      continue;
    }
    const head = [...node("T0", t0), ...node("T1", t1), ...node("T2", t2)];
    // 処理が始まらなかった入力は描かれていない（結合の失敗ではない）。
    if (t2 == null) {
      samples.push(fail("paintNotObservedWithin10s", head));
      details.push({ index: tr.index, outcome, sample: "notProcessed" });
      continue;
    }
    // 版の結合: この入力の T2 の行から同じ実行場所の次の入力の T2 の行までの T3 のうち、Chrome が同じ subject の候補 mark を出した版だけ
    // （publisher は返信を 1 件ずつ処理し、その射影の T3 は自分の T2 の後・同じ場所の次の T2 の前の行に出る）。別の場所・tick 由来の T3 も
    // 窓に入りうるが subject で絞り、複数なら ambiguous（traceIncomplete）とする。
    const end = ends.get(tr.inputId);
    const published = end == null ? [] : t3Between(host, end.from, end.to);
    const cands = published.filter((x) => chromeByVersion.get(x.key)?.candidate?.subject === tr.subject);
    if (cands.length === 0) {
      const lost = blocks[tr.block]?.dataLoss === true;
      const reason = lost ? "traceIncomplete" : "paintNotObservedWithin10s";
      // 公開版が 1 つだけなら、その版と T3/T4 を記録に残す（判定は変えない）。
      const only = published.length === 1 ? published[0] : null;
      if (only == null) samples.push(fail(reason, head));
      else {
        const t4 = host.t4.find((x) => x.key === only.key && x.ms >= only.ms)?.ms ?? null;
        samples.push({ ...fail(reason, [...head, ...node("T3", only.ms), ...node("T4", t4)]),
          correlation: { ...nullCorrelation, semanticRevision: only.version.semanticRevision, displayVersion: only.version } });
      }
      details.push({ index: tr.index, outcome, sample: lost ? "traceIncomplete(dataLoss)" : rejections.has(tr.inputId) ? "rejected" : published.length === 0 ? "notPublished" : "noChromeCandidate",
        ...(rejections.has(tr.inputId) ? { rejectedReason: rejections.get(tr.inputId) } : {}) });
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
      details.push({ index: tr.index, outcome, sample: chrome.replacedBeforePaint ? "replacedBeforePaint" : "candidateWithoutPaintLink" });
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

// P3-C4-AC03(1): 成立した試行（index を持つ）だけを標本に組み、不成立の試行は attemptIndex だけを持つ overlapNotEstablished の投入記録にする
// （index 空間に入れない）。標本と投入記録は P3 の形（p3-eew-trace-v1、attemptIndex 付き）。
export function assembleP3Trials(input) {
  const assembled = assembleTrials({ ...input, trials: input.trials.filter((t) => t.index != null) });
  const byInput = new Map(assembled.injections.map((r) => [r.inputId, r]));
  const runId = input.host.meta?.runId ?? "unknown";
  const injections = input.trials.map((t) => (t.index != null ? { ...byInput.get(t.inputId), attemptIndex: t.attemptIndex }
    : { runId, inputId: t.inputId, population: input.population, run: input.run, attemptIndex: t.attemptIndex, sampleIndex: null,
      scheduledInjectorMonotonicMs: t.scheduledHrMs, injectedInjectorMonotonicMs: t.injectedHrMs, outcome: "overlapNotEstablished",
      hostOffsetLowerMs: input.host.ohLo, hostOffsetUpperMs: input.host.ohHi }));
  return { ...assembled, samples: assembled.samples.map((s) => ({ ...s, schemaVersion: "p3-eew-trace-v1" })), injections };
}

// ── P3-C6-AC02・AC06: 津波の試行の組み立て ──
// 標本は target の T0→T6。T6 は target の版の窓（P3-C4-T3-BINDING）で公開された版のうち、fleq:p3:tsunami:T6-candidate でその subject の
// present・areas が template の expectedPaint と一致する最初の候補の実 paint。窓に一致する候補が無ければ欠落（窓の外の後の版は拾わない）。
// 成立は runner が試行の直後に決めた値（trial.establishment）を使い、不成立の試行は index を持たない overlapNotEstablished の投入記録にする。
// prime の T6 を求める正式の試行は、trace の実 paint で prime が target の T0 より前に描かれたことを確かめ直し、確かめられなければ
// その標本を traceIncomplete にする（runner の判定は paint の代わりに rAF を使うので、実 paint で覆す方向にだけ直す）。
// EEW 同時の試行は、同じ試行の VXSE45 の T0→T6 を urgent × U-E の subject で結んで参考として返す（判定に使わない）。
const samePaint = (candidate, expected) => candidate != null && candidate.present === expected.present
  && JSON.stringify(candidate.areas) === JSON.stringify(expected.areas);
export function assembleTsunamiTrials({ population, run, trials, host, chromeByVersion, chromeByCandidate, probes, blocks, callbackDeadlineMs, missingAfterMs,
  placeOf, rejections = new Map() }) {
  const runId = host.meta?.runId ?? "unknown";
  const corr = correspondences(probes, host);
  const ends = windowEnds(host, placeOf);
  const samples = [];
  const injections = [];
  const details = [];
  const eewReference = [];
  // inputId の版の窓で、name の候補が subject と accept を満たす最初の版（行順）。
  const bind = (inputId, subject, name, accept) => {
    const end = ends.get(inputId);
    for (const t3 of end == null ? [] : t3Between(host, end.from, end.to)) {
      const entry = chromeByCandidate.get(candidateKey(t3.version, subject, name));
      if (entry != null && accept(entry.candidate)) return { t3, entry, published: true };
    }
    return { t3: null, entry: null, published: end != null && t3Between(host, end.from, end.to).length > 0 };
  };
  const interval = (chromeMs, t0) => {
    const probe = nearestProbe(corr, t0);
    return probe == null ? null : { probeId: probe.probeId, lower: chromeMs - t0 - probe.offsetUpperMs - MARK_ROUNDING_MS, upper: chromeMs - t0 - probe.offsetLowerMs + MARK_ROUNDING_MS };
  };
  // EEW 同時の参考値（P3-C6-EEW-ORDER=A）: 同じ試行の VXSE45 の T0→T6 を、津波の側の成否（成立・欠落）と独立に組む。分布は呼び出し側が
  // 正式（phase formal）だけから作る。
  const eewOf = (tr) => {
    const t0 = host.t0.get(tr.eew.inputId);
    const bound = t0 == null ? null : bind(tr.eew.inputId, tr.eew.subject, T6C, () => true);
    const latency = bound?.entry?.paint == null ? null : interval(bound.entry.paint.chromeMs, t0);
    const missingReason = t0 == null ? "callbackNotReached" : bound.entry == null ? "paintNotObserved" : bound.entry.paint == null ? "traceIncomplete"
      : latency == null ? "clockCorrespondenceUnavailable" : null;
    return { attemptIndex: tr.attemptIndex, index: tr.index, phase: tr.phase, established: tr.phase === "warmup" ? null : tr.index != null, inputId: tr.eew.inputId,
      latencyLowerMs: latency?.lower ?? null, latencyUpperMs: latency?.upper ?? null, missingReason };
  };
  for (const tr of trials) {
    if (tr.eew != null) eewReference.push(eewOf(tr));
    const record = { runId, inputId: tr.inputId, population, run, attemptIndex: tr.attemptIndex, sampleIndex: tr.index, transition: tr.transition,
      scheduledInjectorMonotonicMs: tr.scheduledHrMs, injectedInjectorMonotonicMs: tr.injectedHrMs, hostOffsetLowerMs: host.ohLo, hostOffsetUpperMs: host.ohHi };
    if (tr.index == null) {
      // 理由は establishTsunamiTrial の 3 つと、前景の条件逸脱（C4 と同じ conditionDeviation、Q-C6-IMPL-AMEND）。理由ごとの数の和が不成立の数になる。
      const reason = tr.establishment?.reason;
      if (!["primeNotSettled", "startOffset", "eewOrder", "conditionDeviation"].includes(reason)) throw new Error(`trial ${tr.attemptIndex}: not-established reason ${reason}`);
      injections.push({ ...record, outcome: "overlapNotEstablished", notEstablishedReason: reason });
      continue;
    }
    const [t0, t1, t2] = [host.t0.get(tr.inputId), host.t1.get(tr.inputId), host.t2.get(tr.inputId)];
    const waitUpper = t0 == null || tr.injectedHrMs == null ? null : t0 - tr.injectedHrMs - host.ohLo;
    const outcome = tr.injectedHrMs == null ? "notInjected" : t0 == null || waitUpper > callbackDeadlineMs ? "callbackTimeout" : t1 == null ? "rejected" : "callbackReached";
    injections.push({ ...record, outcome, notEstablishedReason: null });
    const node = (point, monotonicMs) => (monotonicMs == null ? [] : [{ point, clock: "node", monotonicMs }]);
    const base = { schemaVersion: "p3-tsunami-trace-v1", population, run, sampleIndex: tr.index, transition: tr.transition };
    const nullCorrelation = { runId, inputId: tr.inputId, operation: "normal", subject: tr.subject, semanticRevision: null, displayVersion: null };
    const fail = (missingReason, markers, correlation = nullCorrelation) => ({ ...base, correlation, markers, clockProbeId: null, latencyLowerMs: null, latencyUpperMs: null,
      missing: true, missingReason });
    const reason = rejections.has(tr.inputId) ? { rejectedReason: rejections.get(tr.inputId) } : {};
    if (outcome !== "callbackReached") {
      samples.push(fail("callbackNotReached", node("T0", t0)));
      details.push({ index: tr.index, outcome, sample: "callbackNotReached", ...reason });
      continue;
    }
    const head = [...node("T0", t0), ...node("T1", t1), ...node("T2", t2)];
    const bound = t2 == null ? null : bind(tr.inputId, tr.subject, T6T, (c) => samePaint(c, tr.expectedPaint));
    if (bound?.entry == null) {
      const lost = blocks[tr.block]?.dataLoss === true;
      samples.push(fail(lost ? "traceIncomplete" : "paintNotObservedWithin10s", head));
      details.push({ index: tr.index, outcome, sample: t2 == null ? "notProcessed" : lost ? "traceIncomplete(dataLoss)" : bound.published ? "noMatchingCandidate" : "notPublished", ...reason });
      continue;
    }
    const { t3, entry } = bound;
    const t4 = host.t4.find((x) => x.key === t3.key && x.ms >= t3.ms)?.ms ?? null;
    const markers = [...head, ...node("T3", t3.ms), ...node("T4", t4)];
    const t5 = chromeByVersion.get(t3.key)?.t5Ms ?? null;
    if (t5 != null) markers.push({ point: "T5", clock: "chrome", monotonicMs: t5 });
    const correlation = { runId, inputId: tr.inputId, operation: entry.candidate.operation, subject: tr.subject, semanticRevision: t3.version.semanticRevision,
      displayVersion: t3.version };
    if (entry.paint == null) {
      samples.push(fail("traceIncomplete", markers, correlation));
      details.push({ index: tr.index, outcome, sample: entry.replacedBeforePaint ? "replacedBeforePaint" : "candidateWithoutPaintLink" });
      continue;
    }
    // prime の実 paint による確かめ直し（正式で prime の T6 を求めた試行だけ）。
    if (tr.phase === "formal" && tr.prime?.paintRequired) {
      const primeBound = bind(tr.prime.inputId, tr.subject, T6T, (c) => samePaint(c, tr.prime.expectedPaint));
      // host = chrome − δ（δ ∈ [offsetLower, offsetUpper]）なので、prime の paint の host 時計の上界は chrome − offsetLower。
      const probe = nearestProbe(corr, t0);
      const primeUpper = probe == null || primeBound.entry?.paint == null ? null : primeBound.entry.paint.chromeMs - probe.offsetLowerMs + MARK_ROUNDING_MS;
      if (primeUpper == null || !(primeUpper < t0)) {
        samples.push(fail("traceIncomplete", markers, correlation));
        details.push({ index: tr.index, outcome, sample: "primeSettledNotConfirmedByTrace", primePaintUpperHostMs: primeUpper, t0 });
        continue;
      }
    }
    markers.push({ point: "T6", clock: "chrome", monotonicMs: entry.paint.chromeMs, paintEvidenceId: entry.paint.paintEvidenceId,
      cardMarkerId: entry.candidate.cardMarkerId, mapMarkerId: entry.candidate.coastMarkerId });
    const latency = interval(entry.paint.chromeMs, t0);
    const late = latency != null && latency.lower > missingAfterMs;
    samples.push({ ...base, correlation, markers, clockProbeId: latency?.probeId ?? null, latencyLowerMs: latency?.lower ?? null, latencyUpperMs: latency?.upper ?? null,
      missing: late, missingReason: late ? "paintNotObservedWithin10s" : null });
    details.push({ index: tr.index, outcome, sample: "linked", t0ToT3Ms: t3.ms - t0, t3ToT4Ms: t4 == null ? null : t4 - t3.ms, hasScreenshot: entry.paint.hasScreenshot,
      latencyLowerMs: latency?.lower ?? null, latencyUpperMs: latency?.upper ?? null });
  }
  return { samples, injections, details, correspondences: corr, eewReference };
}
