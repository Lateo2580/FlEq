import { describe, expect, it } from "vitest";

import * as aux from "./aux-measures.mjs";
import { nearCapacityFrames } from "./frames.mjs";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import { e14BundleFrames } from "./windows.mjs";
import type { E05cRow, HostRecord } from "./aux-measures.mjs";

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
    const base = [marker("T0", "input-1", 0), cp("U-W", "encode", 900, 0), cp("U-W", "write", 900, 2), row("urgent", counts()), row("deferred", counts()),
      row("seismic", counts())];
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

  // P3-UWR-T07: 起点は owner の時刻（ownerMonotonicMs）。欠けているか null の行（C4 の凍結記録の形）は今と同じ結果になる。
  it("P3-UWR-T07 E14: ownerMonotonicMs is the origin of both the overlap and dirty→ack; rows without it keep the C4 result", () => {
    const grants = [grant("g1", "U-E", 50, 300, { kind: "acknowledged", generation: 5 }), grant("g2", "U-W", 310, 320, { kind: "acknowledged", generation: 5 }),
      grant("g3", "U-F", 330, 350, { kind: "acknowledged", generation: 5 })];
    const frozen = [...adopted(0, 5, [100, 100, 100]), ...grants];
    const withOwner = (ownerMonotonicMs: number | null) => [...(["U-E", "U-W", "U-F"] as const).map((unit) => obs({ kind: "generationRaised",
      runId: "r", inputId: e14Bundle(0).inputIds[unit], unit, generation: 5, monotonicMs: 100, ownerMonotonicMs })), ...grants];
    const units = (records: typeof frozen) => aux.summarizeE14(records, { bundles: [e14Bundle(0)] }).units;
    expect(units(frozen)).toMatchObject({ "U-E": { max: 200 }, "U-W": { max: 220 }, "U-F": { max: 250 } });
    expect(units(withOwner(null))).toEqual(units(frozen));
    expect(units(withOwner(60))).toMatchObject({ "U-E": { max: 240 }, "U-W": { max: 260 }, "U-F": { max: 290 } });
    // An owner origin after the earliest ack would not overlap it.
    expect(aux.summarizeE14(withOwner(400), { bundles: [e14Bundle(0)] })).toMatchObject({ linked: 0, unconfirmed: { notSimultaneous: 1 } });
  });

  // P3-MH-T04: owner 側の区間（monotonicMs − ownerMonotonicMs）を成立した束だけから unit ごとに別報告。ownerMonotonicMs の無い行は数えない。
  it("P3-MH-T04 E14: the owner side (monotonicMs − ownerMonotonicMs) of linked bundles is reported per unit; rows without ownerMonotonicMs are counted apart, not as 0", () => {
    const grants = (k: number, at: number) => (["U-E", "U-W", "U-F"] as const).map((unit, i) => grant(`g${k}${unit}`, unit, at + 10, at + 300 + i, { kind: "acknowledged", generation: k + 1 }));
    const start = (k: number, at: number, owner: (unit: string) => number | null | undefined) => (["U-E", "U-W", "U-F"] as const).map((unit) => obs({ kind: "generationRaised",
      runId: "r", inputId: e14Bundle(k).inputIds[unit], unit, generation: k + 1, monotonicMs: at, ...(owner(unit) === undefined ? {} : { ownerMonotonicMs: owner(unit) }) }));
    const records = [...start(0, 100, (u) => (u === "U-W" ? null : 100 - (u === "U-E" ? 4 : 6))), ...grants(0, 100),
      ...start(1, 1000, (u) => (u === "U-F" ? undefined : 1000 - 2)), ...grants(1, 1000),
      // 束 2 は U-F の ack が無い（成立しない束は数えない）。
      ...start(2, 2000, () => 1990), ...grants(2, 2000).slice(0, 2)];
    const e14 = aux.summarizeE14(records, { bundles: [0, 1, 2].map(e14Bundle) });
    expect([e14.linked, e14.ownerSide["U-E"], e14.ownerSide["U-W"], e14.ownerSide["U-F"]]).toMatchObject([2,
      { rows: 2, ownerMonotonicMsMissing: 0, p50: 2, p99: 4, max: 4 }, { rows: 1, ownerMonotonicMsMissing: 1, max: 2 }, { rows: 1, ownerMonotonicMsMissing: 1, max: 6 }]);
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
    // P3-MH-AC01(1): 充填の U-E の報時刻を充填の開始の時計へ寄せる（K6 の horizon で stale にしない）。
    const at = Date.parse("2026-06-05T18:00:00+09:00");
    let monotonicMs = 0;
    let state = initialUnits["U-E"];
    const receive = (xml: string, headType: string, wallTimeMs: number) => {
      const step = reduceEewUnit(state, { kind: "receive", material: material(xml, headType, wallTimeMs), clock: { wallTimeMs, monotonicMs: ++monotonicMs } });
      state = step.state;
      return step;
    };
    for (const f of nearCapacityFrames({ mode: "leaveRoomForP", room: { partials: 0, forecastSubjects: 0 }, eewReportAtMs: at })) if (f.headType.startsWith("VXSE")) receive(f.xml, f.headType, at);
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
    const filled = new Set(nearCapacityFrames({ mode: "leaveRoomForP", room: { partials: 0, forecastSubjects: 0 }, eewReportAtMs: Date.parse("2026-06-05T18:00:00+09:00") })
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
    const records = [mem(90, 10), mem(210, 20), ...["urgent", "weatherCurrent", "deferred", "seismic"].flatMap((p) => [heap(p, 95, 100), heap(p, 205, 150)])];
    const probe = (writtenAtMs: number) => ({ gc: [{ startMs: 150, durationMs: 2 }], writtenAtMs });
    const all = { publisher: probe(300), urgent: probe(300), weatherCurrent: probe(300), deferred: probe(300), seismic: probe(300) };
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
    setTimeout(() => rows.push(heap("deferred"), heap("seismic")), 20);
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

  // Q-MH-E14=B（AC08 の予備 e14-run1 の形）: U-E は約 30ms で ack まで終わり、U-W・U-F の起点（約 300ms）と重ならない。重なりは U-W・U-F で見て、
  // U-E の dirty→ack は束の成立に依らず別に出す。
  it("Q-MH-E14 B: bundles whose U-E finished before U-W・U-F started are linked on U-W・U-F, and U-E's dirty→ack is reported apart for every bundle", () => {
    const at = (k: number, unit: "U-E" | "U-W" | "U-F", start: number, done: number) => [raised(e14Bundle(k).inputIds[unit], unit, k + 1, k * 1000 + start),
      grant(`g${k}${unit}`, unit, k * 1000 + start + 5, k * 1000 + done, { kind: "acknowledged", generation: k + 1 })];
    const records = [...at(0, "U-E", 9, 28), ...at(0, "U-F", 287, 352), ...at(0, "U-W", 325, 403),
      ...at(1, "U-E", 9, 31), ...at(1, "U-F", 310, 376), ...at(1, "U-W", 343, 428),
      // 束 2 は U-F の ack が U-W の起点より前で、U-W・U-F でも重ならない。
      ...at(2, "U-E", 7, 30), ...at(2, "U-F", 280, 330), ...at(2, "U-W", 340, 420)];
    const bundles = [0, 1, 2].map((k) => ({ ...e14Bundle(k), overlapUnits: ["U-W", "U-F"] }));
    const e14 = aux.summarizeE14(records, { bundles });
    expect([e14.linked, e14.unconfirmed, e14.outsideOverlap]).toMatchObject([2, { notSimultaneous: 1 }, { "U-E": { rows: 3, max: 23, overLimit: 0 } }]);
    expect(Object.keys(e14.outsideOverlap)).toEqual(["U-E"]);
    // C4 の規則（3 unit の重なり）では全部 notSimultaneous。
    expect(aux.summarizeE14(records, { bundles: [0, 1, 2].map(e14Bundle) })).toMatchObject({ linked: 0, unconfirmed: { notSimultaneous: 3 }, outsideOverlap: {} });
  });
});

// P3-E05C-T01: 判定表（AC03）。合成の行は 4 thread・200ms。ふだんは thread ごとに heapUsed 20・heapTotal 30・external 5MiB、rss 300MiB。
// 山 k は 30 秒ごとに 4 秒（閾値 380・rearm 330MiB）。weatherCurrent の heapUsed を u、heapTotal を u+v 増やし、rss を u+v+xo 上げる。
// GC の run は始まりの行の直後に閾値の GC を受け、通常の GC で freed の heapUsed が戻り（rss は戻らない）、last-resort の後に rss が returned 戻る。
describe("P3-E05C-T01 the classification table of the E05-P peaks (AC03)", () => {
  const THREADS = ["publisher", "urgent", "weatherCurrent", "deferred", "seismic"] as const;
  type Shape = { u?: number; v?: number; xo?: number; freed?: number; returned?: number; stale?: boolean };
  const options = { thresholdBytes: 380 * MiB, rearmBelowBytes: 330 * MiB, measureFromMs: 0, measureToMs: Infinity,
    c4: { start: { publisher: 21.8 * MiB, urgent: 8.9 * MiB, weatherCurrent: 14.5 * MiB, deferred: 9.6 * MiB },
      flat: { publisher: 22.5 * MiB, urgent: 9.5 * MiB, weatherCurrent: 16.9 * MiB, deferred: 10.0 * MiB } } };
  const usage = (rss: number, heapUsed = 20, heapTotal = 30) => ({ rss: rss * MiB, heapUsed: heapUsed * MiB, heapTotal: heapTotal * MiB, external: 5 * MiB, arrayBuffers: MiB });
  const build = (shapes: Shape[], gcRun: boolean) => {
    const rows: Record<string, E05cRow[]> = Object.fromEntries(THREADS.map((place) => [place, [{ k: "start", place, atMs: 0, nodeVersion: "v22", gcAvailable: true }]]));
    const shapeAt = (t: number) => { const k = Math.floor(t / 30_000) - 1; return k >= 0 && k < shapes.length && t % 30_000 < 4000 ? { k, s: shapes[k], since: t % 30_000 } : null; };
    for (let t = 0; t < (shapes.length + 1) * 30_000; t += 200) {
      const at = shapeAt(t);
      const s = at?.s ?? {};
      const [u, v, xo] = [s.u ?? 0, s.v ?? 0, s.xo ?? 0];
      const peakRss = 300 + u + v + xo;
      const rss = at == null ? 300 : at.since === 0 || !gcRun ? peakRss : peakRss - (s.returned ?? 0);
      for (const place of THREADS) {
        // stale: 山の 2 秒前から weatherCurrent の行が無い（処理中で timer が回らない形）。
        if (place === "weatherCurrent" && shapeAt(t + 2000)?.s.stale === true && (at == null || at.since < 2000)) continue;
        rows[place].push({ k: "mem", place, atMs: t, ...(place === "weatherCurrent" && at != null ? usage(rss, 20 + u, 30 + u + v) : usage(rss)) });
      }
      if (gcRun && at?.since === 0) {
        for (const place of THREADS) {
          const wc = place === "weatherCurrent";
          rows[place].push({ k: "forcedGc", place, id: at.k + 1, reason: "threshold", requestedAtMs: t, startMs: t + 1, endMs: t + 50,
            before: wc ? usage(peakRss, 20 + u, 30 + u + v) : usage(peakRss), afterRegular: wc ? usage(peakRss, 20 + u - (s.freed ?? 0), 30 + u + v) : usage(peakRss),
            afterLastResort: wc ? usage(peakRss - (s.returned ?? 0), 20 + u - (s.freed ?? 0), 30 + u + v) : usage(peakRss - (s.returned ?? 0)) });
        }
      }
    }
    return rows;
  };
  const J1: Shape = { u: 120, freed: 120, returned: 120 };
  const J3: Shape = { u: 120, freed: 120, returned: 0 };
  const J0: Shape = { u: 120, freed: 120, returned: 120, stale: true };

  it("each peak falls in the first row it meets: J1〜J5 and J0; a value exactly at a boundary is on the clause's side; r is read after last-resort, not after the regular GC", () => {
    const shapes: Shape[] = [J1, { v: 120, returned: 120 }, J3, { u: 120 }, { u: 50, v: 50, xo: 50, freed: 50, returned: 150 }, J0,
      // ΔU＝0.5E かつ g＝0.6 は J1、r＝0.3 は J3。
      { u: 75, xo: 75, freed: 45, returned: 150 }, { u: 120, freed: 120, returned: 36 }];
    const result = aux.classifyE05cRun(build(shapes, true), { ...options, gcRun: true });
    expect(result.peaks.map((p) => p.judgement)).toEqual(["J1", "J2", "J3", "J4", "J5", "J0", "J1", "J3"]);
    // J1 の山は通常の GC の後の rss が戻らない（rRegular 0）が、last-resort の後に戻る（r 1）。
    expect(result.peaks[0].gc).toMatchObject({ g: 1, r: 1, rRegular: 0 });
    expect(result.peaks[5]).toMatchObject({ reason: "staleThread", oldestRowAgeMs: 2200 });
    expect(result.peaks[6].distances).toMatchObject({ u: 0, g06: 0 });
    expect(result.peaks[7].distances).toMatchObject({ r03: 0 });
    // 観測だけの run には g・r が無いので、heap 使用が主の山は J1/J4 の 1 つ。
    expect(aux.classifyE05cRun(build([J1], false), { ...options, gcRun: false }).peaks.map((p) => p.judgement)).toEqual(["J1/J4"]);
  });

  it("a run is mixed (primary + secondary) when the second judgement reaches 1/4, single when the first reaches 2/3, and 未確認 when J0 exceeds 1/3; the judgement counts and the over-400MiB breakdown are returned", () => {
    const run = (shapes: Shape[]) => aux.classifyE05cRun(build(shapes, true), { ...options, gcRun: true }).run;
    expect(run([J1, J1, J1, J3])).toMatchObject({ status: null, kind: "mixed", primary: "J1", secondary: "J3", counts: { J1: 3, J3: 1 }, over400: { J1: 3, J3: 1 } });
    expect(run([J1, J1, J1, J1, J3])).toMatchObject({ status: null, kind: "single", primary: "J1" });
    expect(run([J0, J1, J1])).toMatchObject({ status: null, kind: "single", primary: "J1", counts: { J0: 1, J1: 2 } });
    expect(run([J0, J0, J1, J1, J1])).toMatchObject({ status: "未確認", reason: "j0OverOneThird" });
    expect(run([])).toMatchObject({ status: "未確認", reason: "noPeak" });
  });

  it("the phase and baseline GCs give S, D_start, D_late and Grow per thread and the judgements ①〜④ (AC03(4))", () => {
    // thread ごとの [L_pre, L_post, 300 秒以後の基準の GC の後の値の中央値]（MiB）。300 秒より前の基準の GC（100MiB）は入れない。
    const values = { publisher: [21, 22, 22.5], urgent: [25, 30, 30], weatherCurrent: [15, 55, 60], deferred: [10, 12, 25], seismic: [10, 10, 10] };
    const gcRow = (place: string, id: number, reason: "phase" | "baseline", at: number, heapUsed: number, delayMs = 0): E05cRow => ({ k: "forcedGc", place, id, reason,
      requestedAtMs: at, startMs: at + delayMs, endMs: at + delayMs + 10, before: usage(300, heapUsed), afterRegular: usage(300, heapUsed), afterLastResort: usage(300, heapUsed) });
    const build = (postDelayMs: Record<string, number> = {}) => Object.fromEntries(Object.entries(values).map(([place, [pre, post, late]]) => [place, [
      gcRow(place, 1, "phase", -60_000, pre), gcRow(place, 2, "phase", -1000, post, postDelayMs[place]), gcRow(place, 3, "baseline", 299_999, 100),
      gcRow(place, 4, "baseline", 300_000, late - 0.5), gcRow(place, 5, "baseline", 360_000, late), gcRow(place, 6, "baseline", 420_000, late + 0.5)]]));
    const { baseline } = aux.classifyE05cRun(build(), { ...options, measureToMs: 1_000_000, gcRun: true, phaseMissing: [[], []] });
    expect(Object.fromEntries(Object.entries(baseline?.threads ?? {}).map(([p, t]) => [p, t.judgement])))
      .toEqual({ publisher: ["①"], urgent: ["③"], weatherCurrent: ["②"], deferred: ["①", "④"], seismic: null });
    // c4 の表に行の無い seismic は D_start・D_late が出ず未確認（Q-SP-PRECHECK (7)(b)）。
    expect(baseline?.threads.seismic).toMatchObject({ S: 0, dStart: null, dLate: null });
    expect(baseline?.threads.weatherCurrent).toMatchObject({ S: 40 * MiB, gLate: 60 * MiB, grow: 5 * MiB });
    expect(baseline?.threads.deferred.dLate).toBeCloseTo(15 * MiB);
    expect(baseline?.threads.urgent.gcs.map((g) => [g.id, g.reason, g.requestedAtMs, g.heapUsed])).toEqual([[1, "phase", -60_000, 25 * MiB], [2, "phase", -1000, 30 * MiB],
      [3, "baseline", 299_999, 100 * MiB], [4, "baseline", 300_000, 29.5 * MiB], [5, "baseline", 360_000, 30 * MiB], [6, "baseline", 420_000, 30.5 * MiB]]);
    // GC の開始は 10 秒以内（受けた遅れ 9,900ms）でも、runner の待ちの終わりに行が欠けた thread（phaseMissing）は L_post を null にし、出せる値だけを
    // 出して判定を null にする。欠けていない thread は採る。
    const late = aux.classifyE05cRun(build({ deferred: 9_900 }), { ...options, measureToMs: 1_000_000, gcRun: true, phaseMissing: [[], ["deferred"]] }).baseline;
    expect(late?.threads.urgent).toMatchObject({ lPost: 30 * MiB, judgement: ["③"] });
    expect(late?.threads.deferred).toMatchObject({ lPre: 10 * MiB, lPost: null, gLate: 25 * MiB, S: null, dStart: null, grow: null, judgement: null });
    expect(late?.threads.deferred.dLate).toBeCloseTo(15 * MiB);
  });
});
