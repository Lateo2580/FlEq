import { describe, expect, it } from "vitest";

import * as aux from "./aux-measures.mjs";
import { nearCapacityFrames } from "./frames.mjs";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import { e14BundleFrames } from "./windows.mjs";
import type { HostRecord } from "./aux-measures.mjs";

const obs = (o: Record<string, unknown>): HostRecord => ({ t: "obs", o });
const marker = (point: string, inputId: string, monotonicMs: number) => obs({ kind: "marker", point, runId: "r", inputId, monotonicMs });
const processing = (inputId: string, startedMonotonicMs: number, endedMonotonicMs: number) =>
  obs({ kind: "processing", measurement: { runId: "r", inputId, startedMonotonicMs, endedMonotonicMs, marks: {} } });
const MiB = 1024 * 1024;

describe("P2-A10-T04 auxiliary aggregation (AC08/AC09/AC15)", () => {
  it("E03: p99 over 1 s is Fail only with enough samples; unprocessed inputs stay in the denominator; queue wait is separate", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `input-${i + 1}`);
    const records = ids.flatMap((id, i) => [marker("T1", id, i * 10), marker("T2", id, i * 10 + 7),
      processing(id, i * 10 + 7, i * 10 + 7 + (i < 989 ? 100 : 1500))]);
    const failed = aux.summarizeE03(records, ids);
    expect(failed).toMatchObject({ status: "Fail", samples: 1000, unprocessed: 0 });
    expect(failed.queueWaitMs?.p99).toBe(7);
    // The 1000th input never finished: not dropped, and the run is 未確認 rather than Pass.
    expect(aux.summarizeE03(records.slice(0, -3), ids))
      .toMatchObject({ status: "未確認", samples: 999, unprocessed: 1 });
    expect(aux.summarizeE03(records.slice(0, 30), ids.slice(0, 10)).status).toBe("未確認");
  });

  it("E05: limit is 300 MiB for N and 400 MiB for P inside the window only, a runner-clock window is mapped by the clock row, C is 未確認", () => {
    const records = [{ t: "clock", hrtimeNs: "1000000000", perfNowMs: 0 }, { t: "mem", perfNowMs: 1, rss: 500 * MiB },
      { t: "mem", perfNowMs: 10, rss: 300 * MiB }, { t: "mem", perfNowMs: 20, rss: 301 * MiB }];
    expect(aux.summarizeE05(records, "N", { fromMs: 5, toMs: 15 }).status).toBe("Pass");
    expect(aux.summarizeE05(records, "N", { fromMs: 5, toMs: 25 }).status).toBe("Fail");
    expect(aux.summarizeE05(records, "P", { fromMs: 5, toMs: 25 }).status).toBe("Pass");
    expect(aux.summarizeE05(records, "P", { fromMs: 100, toMs: 200 }).status).toBe("未確認");
    // 1 ms = 1e6 ns: runner window [5 ms, 25 ms] after the clock row is host [5, 25].
    expect(aux.summarizeE05(records, "N", { fromHrtimeNs: "1005000000", toHrtimeNs: "1025000000" }).status).toBe("Fail");
    expect(aux.summarizeE05(records.slice(1), "N", { fromHrtimeNs: "1005000000", toHrtimeNs: "1025000000" }).status).toBe("未確認");
    expect(aux.summarizeE05(records, "C", { fromMs: 5, toMs: 25 }).status).toBe("未確認");
  });

  // ヘルツ総合レビュー指摘 7: 1,000 秒の窓に 100 MiB の行が 1 件だけでも Pass だった。
  it("E05: a window whose per-second mem rows are missing at an edge or beyond 1% is 未確認 with the missing count and the largest gap; an observed exceedance stays Fail", () => {
    const one = [{ t: "mem", perfNowMs: 500_000, rss: 100 * MiB }];
    expect(aux.summarizeE05(one, "N", { fromMs: 0, toMs: 1_000_000 })).toMatchObject({ status: "未確認",
      coverage: { expectedSamples: 1000, missingSamples: 998, maxGapMs: 500_000, edgesCovered: false } });
    // 毎秒の行に穴 1 つ。20 秒の穴は欠測 19 > 1000 × 1% で未確認、5 秒の穴は欠測 4 で Pass。端は揃っている。
    const holed = (holeMs: number) => Array.from({ length: 1001 }, (_, s) => ({ t: "mem", perfNowMs: s * 1000, rss: 100 * MiB }))
      .filter((r) => r.perfNowMs <= 400_000 || r.perfNowMs >= 400_000 + holeMs);
    expect(aux.summarizeE05(holed(20_000), "N", { fromMs: 0, toMs: 1_000_000 })).toMatchObject({ status: "未確認", coverage: { missingSamples: 19, edgesCovered: true } });
    expect(aux.summarizeE05(holed(5_000), "N", { fromMs: 0, toMs: 1_000_000 })).toMatchObject({ status: "Pass", coverage: { missingSamples: 4, maxGapMs: 5000 } });
    expect(aux.summarizeE05([...one, { t: "mem", perfNowMs: 600_000, rss: 301 * MiB }], "N", { fromMs: 0, toMs: 1_000_000 }).status).toBe("Fail");
    // ヘルツ再レビュー指摘 3: 2 秒ごとの 501 行（期待 1000）は間隔の検査に掛からないが、行数が期待の 99% 未満なので未確認。
    const everyTwo = Array.from({ length: 501 }, (_, s) => ({ t: "mem", perfNowMs: s * 2000, rss: 100 * MiB }));
    expect(aux.summarizeE05(everyTwo, "N", { fromMs: 0, toMs: 1_000_000 })).toMatchObject({ status: "未確認", samples: 501, coverage: { missingSamples: 0, expectedSamples: 1000 } });
  });

  it("E06: six 10-minute windows from the steady start, slope per minute, fill phase and rows past 60 min dropped, FD mapped by the clock row", () => {
    const minute = 60_000;
    const steady = 5 * minute;
    // 5 fill minutes at 900 MiB (must not enter), 60 steady minutes, 5 minutes past the end.
    const rows = Array.from({ length: 70 }, (_, m) => ({ t: "mem", perfNowMs: m * minute, rss: (m < 5 ? 900 : 100 + m - 5) * MiB, heapUsed: 50 * MiB, external: 0 }));
    const clock = { t: "clock", hrtimeNs: "5000000000000", perfNowMs: 0 };
    // runner clock is 5 s ahead of host 0: hrtime = 5e12 + ms * 1e6.
    const fd = Array.from({ length: 70 }, (_, m) => ({ hrtimeNs: String(5_000_000_000_000 + m * minute * 1e6), count: 30 }));
    const result = aux.summarizeE06([clock, ...rows], fd, { steadyStartMs: steady });
    expect(result.complete).toBe(true);
    expect(result.windows.map((w) => w.memSamples)).toEqual([10, 10, 10, 10, 10, 10]);
    expect(result.rssSlopeBytesPerMin).toBeCloseTo(MiB, 0);
    expect(result.finalWindow).toMatchObject({ window: 5, rssMedian: 100 * MiB + 54 * MiB, fdMedian: 30 });
    expect(aux.summarizeE06([clock, ...rows.slice(0, 50)], fd, { steadyStartMs: steady }).complete).toBe(false);
  });

  // ヘルツ総合レビュー指摘 8: 6 窓の中央値がすべて同じでも、生標本の回帰で傾きが正になった。FD は窓の最大が無かった。
  it("E06: slopes come from the six (window centre, window median) points; the spec-formula values (slope/hour, final−first median, FD final max vs first max) flag an excess as an unclassified report, not a pass", () => {
    const minute = 60_000;
    // 各窓の最後の 1 分だけ窓番号ぶん高い山、他は 100 MiB: 中央値はどの窓も 100 MiB、生標本の回帰は正。
    const rows = Array.from({ length: 60 }, (_, m) => ({ t: "mem", perfNowMs: m * minute, rss: (m % 10 === 9 ? 100 + 50 * Math.floor(m / 10) : 100) * MiB, heapUsed: 50 * MiB }));
    const clock = { t: "clock", hrtimeNs: "0", perfNowMs: 0 };
    const fd = Array.from({ length: 60 }, (_, m) => ({ hrtimeNs: String(m * minute * 1e6), count: m === 0 ? 45 : m === 59 ? 46 : 30 }));
    const result = aux.summarizeE06([clock, ...rows], fd, { steadyStartMs: 0 });
    expect(result.rssSlopeBytesPerMin).toBe(0);
    expect(result.windows.map((w) => w.fdMax)).toEqual([45, 30, 30, 30, 30, 46]);
    expect(result.spec.checks.map((c) => [c.name, c.value, c.exceeded])).toEqual([["rssMedianSlopeBytesPerHour", 0, false],
      ["finalMinusFirstRssMedianBytes", 0, false], ["fdFinalMaxMinusFirstMax", 1, true]]);
    expect(result.spec.report).toBe("報告（spec 式で超過・原因未分類）");
  });

  // AC12(a)（P3-C1-E15）: verify 段は保存の占有に数えず、読んだ bytes として別に数える（旧期待 occupiedMsLower 7・byteViolations 1）。
  it("E15: attempts join through WP2 checkpointJoinProblem; a broken join is 未確認 with the reason; occupancy is the encode lower bound with verify counted apart, and the measured-stage sum (not an upper bound)", () => {
    const cp = (attemptId: string, stage: string, bytes: number, startedMonotonicMs: number, endedMonotonicMs: number, inputIds = ["input-1"], outcome = "succeeded") =>
      obs({ kind: "checkpoint", measurement: { runId: "r", inputIds, unit: "U-W", generation: 1, attemptId, stage, startedMonotonicMs, endedMonotonicMs,
        bytes, outcome, retryReason: "notRetry" } });
    const good = [marker("T0", "input-1", 0), cp("a1", "encode", 900, 0, 4), cp("a1", "write", 900, 5, 9), cp("a1", "verify", 900, 10, 11),
      cp("a3", "encode", 700, 30, 32, ["input-9"], "failed")];
    const result = aux.summarizeE15(good);
    expect(result.units?.["U-W"]).toMatchObject({ encodeCount: 2, encodeBytes: 1600, writeBytes: 900, occupiedMsLower: 6, measuredStagesMs: 11, failedAttempts: 1,
      verifyCount: 1, verifyBytes: 900, verifyMs: 1 });
    expect(result).toMatchObject({ status: null, byteViolations: 0, unknownInputIds: 1 });
    // A write whose encode was never captured cannot be attributed: the whole report is 未確認.
    const broken = aux.summarizeE15([...good, cp("a2", "write", 900, 20, 21)]);
    expect(broken.status).toBe("未確認");
    expect(broken.blocked.some((b: string) => b.startsWith("checkpointJoin:captureMissing"))).toBe(true);
    // Same attempt, but the write names other inputs: unit/generation match, inputIds do not.
    const mismatch = aux.summarizeE15([cp("a1", "encode", 900, 0, 4), cp("a1", "write", 900, 5, 9, ["input-2"])]);
    expect(mismatch.status).toBe("未確認");
    expect(mismatch.blocked.some((b: string) => b.startsWith("checkpointJoin:mismatch"))).toBe(true);
  });

  // P3-C4-AC05: write の帰属と保存前段の同期区間。writeCount・checkpointGrant の行が無い記録（A10）は従来の報告のまま。
  it("P3-C4-AC05 E15: owner tmp writes match the write stages, the log lines and bytes match the diagnostic files; unconfirmed or unverifiable is 未確認, an unmatched write Fail; the pre-save span is bounded by encode and owner start to write", () => {
    const cp = (unit: string, stage: string, bytes: number, at: number) => obs({ kind: "checkpoint", measurement: { runId: "r", inputIds: ["input-1"], unit,
      generation: 1, attemptId: `${unit}-a`, stage, startedMonotonicMs: at, endedMonotonicMs: at + 1, bytes, outcome: "succeeded", retryReason: "notRetry" } });
    const zero = { count: 0, bytes: 0 };
    const counts = (tmp = zero, diagnosticLog = zero) => ({ checkpoint: zero, tmp, diagnosticLog, other: zero });
    const row = (thread: string, c: ReturnType<typeof counts>, confirmed = true) => obs({ kind: "writeCount", runId: "r", thread, confirmed, counts: c });
    const grant = obs({ kind: "checkpointGrant", runId: "r", grantId: "g1", unit: "U-W", attemptIds: ["U-W-a"], dirtyObservedMonotonicMs: -5,
      grantSentMonotonicMs: -3, ownerStartedMonotonicMs: -1, doneReceivedMonotonicMs: 4 });
    const log = { bytes: 120, lines: 2 };
    const base = [marker("T0", "input-1", 0), cp("U-W", "encode", 900, 0), cp("U-W", "write", 900, 2), row("urgent", counts()), row("deferred", counts())];
    const owners = (weather = counts({ count: 1, bytes: 900 }), confirmed = true) => [...base, row("weatherCurrent", weather, confirmed)];
    const publisher = (tmp = zero) => row("publisher", counts(tmp, { count: 2, bytes: 120 }));
    const matched = aux.summarizeE15([...owners(), publisher(), grant], { diagnosticLog: log });
    expect([matched.status, matched.writes?.unattributed, matched.writes?.unverified, matched.blocked]).toEqual([null, [], [], []]);
    expect(matched.preSaveSyncMs).toEqual({ "U-W": { grants: 1, reconcileGrants: 0, invalid: 0, lowerMs: 1, upperMs: 3, maxUpperMs: 3 } });
    // 終了要約の tmp は書き手の試行の記録（shutdownSummaryWrite）に照らす。
    const summary = (bytes: number) => obs({ kind: "shutdownSummaryWrite", runId: "r", bytes });
    expect(aux.summarizeE15([...owners(), publisher({ count: 2, bytes: 600 }), summary(250), summary(350)], { diagnosticLog: log }).writes)
      .toMatchObject({ status: null, unattributed: [], unverified: [] });
    expect(aux.summarizeE15([...owners(), publisher({ count: 2, bytes: 600 }), summary(250)], { diagnosticLog: log }).writes)
      .toMatchObject({ status: "Fail", unattributed: [{ thread: "publisher", category: "tmp" }] });
    expect(aux.summarizeE15([...owners(), publisher()], { diagnosticLog: null }).writes)
      .toMatchObject({ status: "未確認", unverified: [{ thread: "publisher", category: "diagnosticLog" }] });
    expect(aux.summarizeE15([...owners(undefined, false), publisher()], { diagnosticLog: log }).status).toBe("未確認");
    expect(aux.summarizeE15([...owners(counts({ count: 2, bytes: 1800 })), publisher()], { diagnosticLog: log }).writes)
      .toMatchObject({ status: "Fail", unattributed: [{ thread: "weatherCurrent", category: "tmp" }] });
    expect(aux.summarizeE15([...owners(), publisher()], { diagnosticLog: { bytes: 120, lines: 3 } }).writes)
      .toMatchObject({ status: "Fail", unattributed: [{ thread: "publisher", category: "diagnosticLog" }] });
    expect(aux.summarizeE15(base.slice(0, 3))).toMatchObject({ status: null, blocked: aux.E15_BLOCKED, preSaveSyncMs: null });
  });

  // ヘルツの再確認（S1）: rename の失敗の後の再照合も同じ attemptId を持つので、各権に全段を結ぶと encode を二重に足し、再照合の着手から
  // 過去の write 開始を引いて上界が負になった（下界 2ms・上界 −14ms で blocked が空）。
  it("P3-C4-AC05 E15 regression: a reconciliation sharing the failed save's attemptId is kept apart from the pre-save span; an inconsistent span is 未確認", () => {
    const stage = (stageName: string, at: number, end: number, outcome = "succeeded") => obs({ kind: "checkpoint", measurement: { runId: "r", inputIds: ["input-1"],
      unit: "U-F", generation: 1, attemptId: "U-F-a", stage: stageName, startedMonotonicMs: at, endedMonotonicMs: end, bytes: stageName === "encode" || stageName === "write" ? 50 : 0,
      outcome, retryReason: "notRetry" } });
    const grant = (grantId: string, sent: number, started: number, done: number) => obs({ kind: "checkpointGrant", runId: "r", grantId, unit: "U-F",
      attemptIds: ["U-F-a"], dirtyObservedMonotonicMs: null, grantSentMonotonicMs: sent, ownerStartedMonotonicMs: started, doneReceivedMonotonicMs: done });
    const save = [stage("encode", 2, 4), stage("write", 5, 6), stage("fileSync", 6, 7), stage("close", 7, 7), stage("rename", 7, 8, "failed")];
    const records = [marker("T0", "input-1", 0), grant("g1", 0, 1, 20), ...save, grant("g2", 30, 31, 40), stage("directorySync", 32, 33)];
    expect(aux.summarizeE15(records)).toMatchObject({ status: null, preSaveSyncMs: { "U-F": { grants: 1, reconcileGrants: 1, invalid: 0, lowerMs: 2, upperMs: 4 } } });
    // 着手が encode の途中に記録された（時計の食い違い）権は区間に足さず、E15 を未確認にする。
    expect(aux.summarizeE15([marker("T0", "input-1", 0), grant("g1", 0, 4.5, 20), ...save])).toMatchObject({ status: "未確認",
      preSaveSyncMs: { "U-F": { grants: 0, invalid: 1 } } });
  });

  // P3-C4-AC07(2): 周期末は boundary の ping の行、排出と待機年齢は上界・下界で判定し、境界をまたぐ証拠は未確認。
  const mailboxRow = (monotonicMs: number, trigger: string, items: number, accepted: number, age: number | null = null, limitViolations = 0) => obs({
    kind: "mailbox", runId: "r", monotonicMs, trigger, pendingItems: items, pendingBytes: items * 10, inFlightItems: 0, inFlightBytes: 0,
    oldestPendingAgeMs: age, oldestIncompleteAgeMs: age, highWaterItems: items, highWaterBytes: items * 10, limitViolations, accepted });
  const accepted = (id: string, t1: number, t2: number) => [marker("T0", id, t1), marker("T1", id, t1), marker("T2", id, t2)];

  it("P3-C4-AC07 E07: cycle ends from boundary ping rows only, drain and waiting age by upper and lower bounds, owner trouble or a limit violation Fail", () => {
    const records = [...accepted("input-1", 0, 100), mailboxRow(50, "ping", 1, 1, 50), mailboxRow(500, "tick", 9, 1), mailboxRow(1000, "ping", 1, 1),
      ...accepted("input-2", 2000, 2100), mailboxRow(3000, "ping", 2, 2), mailboxRow(4000, "tick", 1, 2, 100), mailboxRow(5000, "tick", 0, 2)];
    const options = { pingKinds: ["periodic", "boundary", "boundary"], lastInputId: "input-2" };
    const e07 = aux.summarizeE07(records, options);
    // tick の行（9 件）は周期末にしない。boundary の行は 1 → 2 で backlog が増えた。
    expect([e07.cycleEnd.status, e07.cycleEnd.ends.map((e) => e.items)]).toEqual(["Fail", [1, 2]]);
    expect(e07.drain).toMatchObject({ status: "Pass", lowerMs: 4000, upperMs: 5000 });
    expect(e07.wait).toMatchObject({ status: "Pass", upperMs: 100, lowerMs: 100 });
    expect(aux.summarizeE07(records, { ...options, pingKinds: ["boundary", "boundary"] }).cycleEnd.status).toBe("未確認");
    expect(aux.summarizeE07(records, { ...options, drainLimitMs: 2500 }).drain.status).toBe("未確認");
    expect(aux.summarizeE07(records, { ...options, drainLimitMs: 1500 }).drain.status).toBe("Fail");
    expect(aux.summarizeE07(records, { ...options, waitLimitMs: 99 }).wait.status).toBe("Fail");
    const t2Lost = records.filter((r) => !(r.t === "obs" && JSON.stringify(r.o).includes('"T2","runId":"r","inputId":"input-2"')));
    expect(aux.summarizeE07(t2Lost, options).wait).toMatchObject({ status: "未確認", unprocessed: 1 });
    const trouble = [{ level: "WARN", reason: "mailboxStalled", component: "owner.urgent.response", timestamp: 0 }];
    expect(aux.summarizeE07(records, { pingKinds: ["periodic", "periodic", "periodic"], lastInputId: "input-2", diagnostics: trouble }).status).toBe("Fail");
    expect(aux.summarizeE07([...records, mailboxRow(5500, "tick", 0, 2, null, 1)], { pingKinds: ["periodic", "periodic", "periodic"], lastInputId: "input-2" }).status)
      .toBe("Fail");
  });

  // ヘルツの品質レビュー（R2）: 待機年齢の母集団を存在する T1 だけから作っていたので、6 秒待った入力の T1 が欠けると未確認が Pass になった。
  it("P3-C4-AC07 E07 regression: an accepted input whose T1 row is missing keeps the waiting age 未確認 instead of Pass", () => {
    const records = [mailboxRow(0, "tick", 0, 0), ...accepted("input-1", 500, 600), ...accepted("input-2", 700, 6700), mailboxRow(1000, "tick", 1, 2),
      mailboxRow(9000, "tick", 0, 2)];
    const options = { lastInputId: "input-2" };
    expect(aux.summarizeE07(records, options).wait).toMatchObject({ status: "未確認", upperMs: 6000 });
    const t1Lost = records.filter((r) => !(r.t === "obs" && JSON.stringify(r.o).includes('"T1","runId":"r","inputId":"input-2"')));
    expect(aux.summarizeE07(t1Lost, options).wait).toMatchObject({ status: "未確認", upperMs: 100, accepted: 2, observedT1: 1 });
  });

  // P3-C4-T10: E14 の束（AC13(3)②④⑤⑥、工程2c）。起点は束の入力の generationRaised、成立は区間の重なり。
  const raised = (inputId: string, unit: string, generation: number, monotonicMs: number) =>
    obs({ kind: "generationRaised", runId: "r", inputId, unit, generation, monotonicMs });
  const grant = (grantId: string, unit: string, sent: number, done: number, result: { kind: string; generation: number } | null) => obs({ kind: "checkpointGrant",
    runId: "r", grantId, unit, attemptIds: [`${unit}-a`], dirtyObservedMonotonicMs: null, grantSentMonotonicMs: sent, ownerStartedMonotonicMs: sent,
    doneReceivedMonotonicMs: done, result });
  const e14Bundle = (k: number) => ({ k, inputIds: { "U-E": `e${k}`, "U-W": `w${k}`, "U-F": `f${k}` } });
  const adopted = (k: number, generation: number, at: readonly [number, number, number]) =>
    (["U-E", "U-W", "U-F"] as const).map((u, i) => raised(e14Bundle(k).inputIds[u], u, generation, at[i]));

  it("P3-C4-T10 E14: overlapping [start, ack] intervals are established; the ack is the first acknowledged reply at or above the bundle's generation (a reconciliation after a failed save included); notSimultaneous, unacknowledged and not-adopted bundles are counted 未確認", () => {
    const records = [
      // 束 0: U-W の保存は失敗し、再照合で成功する。区間は 3 unit で重なる。
      ...adopted(0, 2, [100, 101, 102]), grant("g1", "U-E", 110, 300, { kind: "acknowledged", generation: 2 }),
      grant("g2", "U-W", 310, 400, { kind: "failed", generation: 2 }), grant("g3", "U-F", 410, 600, { kind: "acknowledged", generation: 2 }),
      grant("g4", "U-W", 1400, 1500, { kind: "acknowledged", generation: 2 }),
      // 束 1: U-E の ack（2100）が U-F の起点（2150）より前で、区間が重ならない。
      ...adopted(1, 3, [2000, 2001, 2150]), grant("g5", "U-E", 2010, 2100, { kind: "acknowledged", generation: 3 }),
      grant("g6", "U-W", 2110, 2200, { kind: "acknowledged", generation: 3 }), grant("g7", "U-F", 2210, 2400, { kind: "acknowledged", generation: 3 }),
      // 束 2: U-F の保存が成功に結べない。束 3: U-W の入力の採用で世代が上がらなかった（行が無い）。
      ...adopted(2, 4, [4000, 4001, 4002]), grant("g8", "U-E", 4010, 4200, { kind: "acknowledged", generation: 4 }),
      grant("g9", "U-W", 4210, 4300, { kind: "acknowledged", generation: 4 }), grant("g10", "U-F", 4310, 4400, { kind: "uncertain", generation: 4 }),
      ...adopted(3, 5, [6000, 6001, 6002]).filter((_, i) => i !== 1)];
    const e14 = aux.summarizeE14(records, { bundles: [0, 1, 2, 3].map(e14Bundle) });
    expect(e14).toMatchObject({ status: null, bundles: 4, linked: 1, unconfirmed: { notSimultaneous: 1, "notAcknowledged:U-F": 1, inputNotAdopted: 1 } });
    expect([e14.units["U-E"].max, e14.units["U-W"].max, e14.units["U-F"].max]).toEqual([200, 1399, 498]);
    expect(aux.summarizeE14(records, { bundles: [1, 2, 3].map(e14Bundle) }).status).toBe("未確認");
  });

  it("P3-C4-T10 E14: a grant in flight before the start that saved this generation is the ack; a reused attemptId links by grantId; the index grows by appended rows only (R6)", () => {
    const bundle = e14Bundle(0);
    // U-E の権は起点（100）より前に送られて in-flight だったが、今回の世代 5 を保存した。U-W は同じ attemptId の再照合（別の grantId）で成功。
    const grants = [grant("g1", "U-E", 50, 300, { kind: "acknowledged", generation: 5 }), grant("g2", "U-W", 310, 320, { kind: "failed", generation: 5 }),
      grant("g3", "U-F", 330, 350, { kind: "acknowledged", generation: 5 }), grant("g4", "U-W", 360, 400, { kind: "acknowledged", generation: 5 })];
    const records = [...adopted(0, 5, [100, 100, 100]), ...grants];
    expect(aux.summarizeE14(records, { bundles: [bundle] })).toMatchObject({ linked: 1, units: { "U-E": { max: 200 }, "U-W": { max: 300 }, "U-F": { max: 250 } } });
    const saved = (index: unknown) => aux.e14Acks(index, bundle).every((ack) => ack != null);
    const partial = aux.e14Index(records.slice(0, -1));
    expect(saved(partial)).toBe(false);
    const grown = aux.e14Index(records, partial);
    expect([grown === partial, saved(grown)]).toEqual([true, true]);
  });

  // R4: 初回の採用の待ちに再試行（backoff を含む）を混ぜない。
  it("P3-C4-AC13(5) adoption: first attempts and retries are reported apart", () => {
    const row = (attempts: number, waitMs: number) => obs({ kind: "notificationAdoption", runId: "r", channel: "desktop", intentId: `i${attempts}`, unit: "U-E", attempts,
      createdAtWallMs: 0, reservationSentWallMs: 0, reservationSentMonotonicMs: 0, replyReceivedMonotonicMs: waitMs, adopted: true, attemptStartedMonotonicMs: waitMs });
    const report = aux.notificationAdoptionReport([row(1, 10), row(2, 10_000)]);
    expect([report.first.reservations, report.first.reservationToReplyMs?.p99, report.retries.reservations, report.retries.reservationToReplyMs?.p99]).toEqual([1, 10, 1, 10_000]);
  });

  // 工程2c: 束の VXSE45（充填済みの EventID・Serial＋1・訂正）を充填後の U-E に通すと、capacityExceeded にならず世代が上がる（Serial だけを
  // 進めた続報は通知済みの EventID では revisionOnly で世代が上がらず、予備で E14 の束が 0 しか成立しなかった）。
  it("P3-C4-T10 E14: after the fill, bundle k's VXSE45 correction is not capacityExceeded and raises the U-E generation", () => {
    let sequence = 0;
    const material = (xml: string, headType: string, at: number) => {
      const entered = ingestXmlData({ inputId: `fill-${++sequence}`, inputSequence: sequence, receivedAt: at, origin: "replay", kind: "replay", body: Buffer.from(xml), headType });
      if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
      const decoded = decodeMaterial(entered.item);
      if (decoded.kind !== "decoded") throw new Error("decode failed");
      return decoded.material;
    };
    const at = Date.parse("2024-06-13T12:00:00Z");
    let monotonicMs = 0;
    let state = initialUnits["U-E"];
    const receive = (xml: string, headType: string, wallTimeMs: number) => {
      const step = reduceEewUnit(state, { kind: "receive", material: material(xml, headType, wallTimeMs), clock: { wallTimeMs, monotonicMs: ++monotonicMs } });
      state = step.state;
      return step;
    };
    for (const f of nearCapacityFrames({ mode: "leaveRoomForP", room: { partials: 0, forecastSubjects: 0 } })) if (f.headType.startsWith("VXSE")) receive(f.xml, f.headType, at);
    // 充填の通知の記録を期限で回収した後（窓の時点の U-E）。
    state = reduceEewUnit(state, { kind: "deadline", clock: { wallTimeMs: at + 60_000, monotonicMs: ++monotonicMs } }).state;
    const filledCurrent = state.current.length;
    for (const k of [0, 1, 511]) {
      const before = state.persistence.currentGeneration;
      const bundleAt = at + 61_000 + k * 20_000;
      const eew = e14BundleFrames(k, bundleAt).find((f) => f.unit === "U-E")!;
      const step = receive(eew.xml, "VXSE45", bundleAt);
      expect(step.decisions.map((d) => d.decision), `k=${k}`).not.toContain("rejected");
      // 世代は 1 上がり、current の件数（充填した subject）は増えない。
      expect([state.persistence.currentGeneration - before, state.current.length], `k=${k}`).toEqual([1, filledCurrent]);
    }
  });

  it("P3-C4-T10 E14: bundle k updates a filled EEW EventID with the next Serial (no new EventID, so no capacityExceeded)", () => {
    const filled = new Set(nearCapacityFrames({ mode: "leaveRoomForP", room: { partials: 0, forecastSubjects: 0 } })
      .filter((f) => f.headType === "VXSE45").map((f) => /<EventID>([^<]+)</.exec(f.xml)?.[1]));
    for (const k of [0, 511]) {
      const eew = e14BundleFrames(k, Date.parse("2026-06-05T18:00:00+09:00")).find((f) => f.unit === "U-E")!;
      expect([filled.has(/<EventID>([^<]+)</.exec(eew.xml)?.[1]), /<Serial>(\d+)</.exec(eew.xml)?.[1]]).toEqual([true, "2"]);
    }
  });

  // P3-C4 工程2d（ヘルツ節目 P2）: E12 の新側は thread ごと。owner の GC の probe が欠けるか replay の終わりより前に書かれていれば未確認。
  it("P3-C4 regression E12: GC and heap per thread (publisher and the three owners); a missing or early owner probe is 未確認", () => {
    const mem = (perfNowMs: number, heapUsed: number) => ({ t: "mem", perfNowMs, rss: 0, heapUsed, external: 0 });
    const heap = (place: string, monotonicMs: number, heapUsedBytes: number) => obs({ kind: "ownerHeap", runId: "r", place, replyKind: "deadlineDone", inputId: null,
      monotonicMs, heapUsedBytes, externalBytes: 0 });
    const records = [mem(90, 10), mem(210, 20), ...["urgent", "weatherCurrent", "deferred"].flatMap((p) => [heap(p, 95, 100), heap(p, 205, 150)])];
    const probe = (writtenAtMs: number) => ({ gc: [{ startMs: 150, durationMs: 2 }], writtenAtMs });
    const all = { publisher: probe(300), urgent: probe(300), weatherCurrent: probe(300), deferred: probe(300) };
    const done = aux.summarizeE12New(records, all, { startMs: 100, endMs: 200 });
    expect([done.status, done.threads.weatherCurrent.heapUsedDelta, done.threads.publisher.heapUsedDelta]).toEqual([null, 50, 10]);
    expect(aux.summarizeE12New(records, { ...all, deferred: null }, { startMs: 100, endMs: 200 }).threads.deferred).toMatchObject({ status: "未確認", reason: "probeMissing" });
    expect(aux.summarizeE12New(records, { ...all, urgent: probe(150) }, { startMs: 100, endMs: 200 })).toMatchObject({ status: "未確認" });
  });

  // P3-C4 工程2d（ヘルツ節目 P2、予備 e12-max-run1）: 後値は入力の処理が全部終わるのを待つ。期限までに揃わなければ false。
  it("P3-C4 regression E12: the after value waits for every input's completion, and gives up at the limit", async () => {
    const processing = (inputId: string) => obs({ kind: "processing", measurement: { runId: "r", inputId, startedMonotonicMs: 0, endedMonotonicMs: 1, marks: {} } });
    const rows: HostRecord[] = [processing("input-1")];
    setTimeout(() => rows.push(processing("input-2")), 30);
    expect(await aux.waitInputsDone(() => rows, 2, { timeoutMs: 2_000, pollMs: 5 })).toBe(true);
    expect(await aux.waitInputsDone(() => rows, 3, { timeoutMs: 40, pollMs: 5 })).toBe(false);
  });

  // 工程2d の再確認 S2: owner の heap は 1 秒の tick からしか出ないので、owner 3 本の行が出てから E12 の再生を始める。
  it("P3-C4 regression E12: the replay starts only after every owner has a heap row, and gives up at the limit", async () => {
    const heap = (place: string) => obs({ kind: "ownerHeap", runId: "r", place, replyKind: "deadlineDone", inputId: null, monotonicMs: 1, heapUsedBytes: 1, externalBytes: 0 });
    const rows: HostRecord[] = [heap("urgent"), heap("weatherCurrent")];
    expect(await aux.waitOwnerHeaps(() => rows, { timeoutMs: 40, pollMs: 5 })).toBe(false);
    setTimeout(() => rows.push(heap("deferred")), 20);
    expect(await aux.waitOwnerHeaps(() => rows, { timeoutMs: 2_000, pollMs: 5 })).toBe(true);
  });

  it("publish cost: counted per window", () => {
    const records = [obs({ kind: "publishSerialization", bytes: 100, durationMs: 1 }), obs({ kind: "publishSerialization", bytes: 300, durationMs: 3 }),
      marker("T0", "input-1", 10), processing("input-1", 12, 20)];
    expect(aux.publishCostReport(records, "E01/N/run1")).toEqual({ window: "E01/N/run1", publishCount: 2, totalJsonBytes: 400, maxJsonBytes: 300,
      serializeP50Ms: 1, serializeP99Ms: 3, serializeMaxMs: 3 });
    expect(aux.publishCostReport([], "w").serializeP99Ms).toBeNull();
  });

  it("E12: heap is read from the last mem row at or before the start and the first at or after the end; a missing or too-distant row is 未確認", () => {
    const mem = (perfNowMs: number, heapUsed: number) => ({ t: "mem", perfNowMs, rss: 0, heapUsed, external: 0 });
    const probe = { gc: [{ startMs: 5, durationMs: 9 }, { startMs: 120, durationMs: 1 }, { startMs: 130, durationMs: 2 }, { startMs: 400, durationMs: 9 }] };
    const rows = [mem(0, 1), mem(90, 10), mem(110, 99), mem(140, 20), mem(200, 30)];
    const run = (startMs: number, endMs: number) => aux.summarizeReplayWindow({ probe, startMs, endMs, ...aux.bracketMem(rows, startMs, endMs) });
    // Rows inside the interval (110) are never chosen; GC entries outside [100, 135] are not counted.
    expect(run(100, 135)).toMatchObject({ status: null, gcCount: 2, gcTotalMs: 3, heapUsedBefore: 10, heapUsedAfter: 20,
      heapBoundarySignedDistanceMs: { before: -10, after: 5 } });
    expect(run(100, 250).status).toBe("未確認");
    expect(run(-5, 135).status).toBe("未確認");
    expect(run(100, 105).status).toBe("未確認");
    // The replay interval runs from the first T0 to the last processing end, not from 0 or the first mem row.
    const obs = (o: object) => ({ t: "obs", o });
    expect(aux.replayInterval([mem(0, 1),
      obs({ kind: "marker", point: "T0", runId: "r", inputId: "input-1", monotonicMs: 100 }),
      obs({ kind: "marker", point: "T0", runId: "r", inputId: "input-2", monotonicMs: 120 }),
      obs({ kind: "processing", measurement: { runId: "r", inputId: "input-1", startedMonotonicMs: 101, endedMonotonicMs: 118, marks: {} } }),
      obs({ kind: "processing", measurement: { runId: "r", inputId: "input-2", startedMonotonicMs: 121, endedMonotonicMs: 135, marks: {} } }),
    ])).toEqual({ startMs: 100, endMs: 135 });
  });
});
