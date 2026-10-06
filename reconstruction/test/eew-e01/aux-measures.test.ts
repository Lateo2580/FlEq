import { describe, expect, it } from "vitest";

import * as aux from "./aux-measures.mjs";
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

  // P3-C4-AC05: write の帰属。writeCount の行が無い記録（A10）は従来の報告のまま。
  it("P3-C4-AC05 E15: owner tmp writes match the write stages, the log bytes match the diagnostic files; an unconfirmed thread is 未確認, an unmatched write Fail", () => {
    const cp = (unit: string, stage: string, bytes: number, at: number) => obs({ kind: "checkpoint", measurement: { runId: "r", inputIds: ["input-1"], unit,
      generation: 1, attemptId: `${unit}-a`, stage, startedMonotonicMs: at, endedMonotonicMs: at + 1, bytes, outcome: "succeeded", retryReason: "notRetry" } });
    const zero = { count: 0, bytes: 0 };
    const counts = (tmp = zero, diagnosticLog = zero) => ({ checkpoint: zero, tmp, diagnosticLog, other: zero });
    const row = (thread: string, c: ReturnType<typeof counts>, confirmed = true) => obs({ kind: "writeCount", runId: "r", thread, confirmed, counts: c });
    const base = [marker("T0", "input-1", 0), cp("U-W", "encode", 900, 0), cp("U-W", "write", 900, 2), row("urgent", counts()),
      row("deferred", counts()), row("publisher", counts({ count: 1, bytes: 300 }, { count: 2, bytes: 120 }))];
    const matched = aux.summarizeE15([...base, row("weatherCurrent", counts({ count: 1, bytes: 900 }))], { diagnosticLogBytes: 120 });
    expect([matched.status, matched.writes?.unattributed, matched.blocked]).toEqual([null, [], [aux.E15_BLOCKED[0]]]);
    expect(aux.summarizeE15([...base, row("weatherCurrent", counts({ count: 1, bytes: 900 }), false)], { diagnosticLogBytes: 120 }).status).toBe("未確認");
    expect(aux.summarizeE15([...base, row("weatherCurrent", counts({ count: 2, bytes: 1800 }))], { diagnosticLogBytes: 120 }).writes)
      .toMatchObject({ status: "Fail", unattributed: [{ thread: "weatherCurrent", category: "tmp" }] });
    expect(aux.summarizeE15(base.slice(0, 3)).status).toBeNull();
  });

  // P3-C4-AC07(2): 周期末は boundary の ping の行、排出と待機年齢は上界・下界で判定し、境界をまたぐ証拠は未確認。
  it("P3-C4-AC07 E07: cycle ends from boundary ping rows only, drain and waiting age by upper and lower bounds, owner trouble or a limit violation Fail", () => {
    const row = (monotonicMs: number, trigger: string, items: number, age: number | null = null, limitViolations = 0) => obs({ kind: "mailbox", runId: "r",
      monotonicMs, trigger, pendingItems: items, pendingBytes: items * 10, inFlightItems: 0, inFlightBytes: 0, oldestPendingAgeMs: age,
      oldestIncompleteAgeMs: age, highWaterItems: items, highWaterBytes: items * 10, limitViolations, accepted: 0 });
    const input = (id: string, t0: number, t2: number) => [marker("T0", id, t0), marker("T1", id, t0), marker("T2", id, t2)];
    const records = [...input("input-1", 0, 100), row(50, "ping", 1, 50), row(500, "tick", 9), row(1000, "ping", 1), ...input("input-2", 2000, 2100),
      row(3000, "ping", 2), row(4000, "tick", 1, 100), row(5000, "tick", 0)];
    const options = { pingKinds: ["periodic", "boundary", "boundary"], lastInputId: "input-2" };
    const e07 = aux.summarizeE07(records, options);
    // The tick row with 9 items is not a cycle end; the boundary rows go 1 → 2: the backlog grew.
    expect([e07.cycleEnd.status, e07.cycleEnd.ends.map((e) => e.items)]).toEqual(["Fail", [1, 2]]);
    expect(e07.drain).toMatchObject({ status: "Pass", lowerMs: 4000, upperMs: 5000 });
    expect(e07.wait).toMatchObject({ status: "Pass", upperMs: 100, lowerMs: 100 });
    expect(aux.summarizeE07(records, { ...options, pingKinds: ["boundary", "boundary"] }).cycleEnd.status).toBe("未確認");
    expect(aux.summarizeE07(records, { ...options, drainLimitMs: 2500 }).drain.status).toBe("未確認");
    expect(aux.summarizeE07(records, { ...options, drainLimitMs: 1500 }).drain.status).toBe("Fail");
    expect(aux.summarizeE07(records, { ...options, waitLimitMs: 99 }).wait.status).toBe("Fail");
    expect(aux.summarizeE07([...records, ...input("input-3", 6000, 6000 + 7000)], { ...options, lastInputId: "input-2" }).wait.status).toBe("未確認");
    const trouble = [{ level: "WARN", reason: "mailboxStalled", component: "owner.urgent.response", timestamp: 0 }];
    expect(aux.summarizeE07(records, { pingKinds: ["periodic", "periodic", "periodic"], lastInputId: "input-2", diagnostics: trouble }).status).toBe("Fail");
    expect(aux.summarizeE07([...records, row(5500, "tick", 0, null, 1)], { pingKinds: ["periodic", "periodic", "periodic"], lastInputId: "input-2" }).status).toBe("Fail");
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
