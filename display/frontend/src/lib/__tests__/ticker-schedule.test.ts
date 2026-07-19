import { describe, it, expect } from "vitest";
import {
  assignLanes,
  enqueueJob,
  onLineComplete,
  onFadeComplete,
  onBookmarkCapture,
  createSchedulerState,
  resetScheduler,
  maxLaneGeneration,
  foldCatalog,
  toTickerJob,
  INTERRUPTED_RESUME_MS,
  LONG_DEFER_MS,
  mustReplaceImmediately,
  MIN_VISIBLE_MS,
  REVISION_COALESCE_MS,
  MAX_REVISION_WAIT_MS,
  HIGH_SLICE_MS,
  CYCLE_MIN_INTERVAL_MS,
  purgeJobs,
  hasNonTipActivity,
  hasAlertActivity,
  hasActiveReplay,
  type TickerJob,
  type SchedulerState,
  type LaneState,
} from "../ticker-schedule";
import { tickerEvent } from "./fixtures";
import type { DisplayColorRole } from "../protocol";

function job(over: Partial<TickerJob> & { key: string }): TickerJob {
  const segments = over.segments ?? ["seg0", "seg1", "seg2"];
  return {
    key: over.key,
    groupKey: over.groupKey ?? null,
    seq: over.seq ?? 0,
    kind: over.kind ?? "event",
    priority: over.priority ?? "low",
    role: over.role ?? "info",
    category: over.category ?? null,
    subject: over.subject ?? null,
    segments,
    segmentEmphasis: over.segmentEmphasis ?? segments.map(() => []),
    runs: over.runs ?? [{ startSegmentIndex: 0, endSegmentIndexExclusive: segments.length }],
    runIndex: over.runIndex ?? 0,
    segmentIndex: over.segmentIndex ?? 0,
    retryCount: over.retryCount ?? 0,
    deferUntil: over.deferUntil ?? null,
    deferKind: over.deferKind ?? null,
    revisionAt: over.revisionAt ?? null,
    isCancellation: over.isCancellation ?? false,
    ...(over.replayGeneration != null ? { replayGeneration: over.replayGeneration } : {}),
  };
}

function runningLane(j: TickerJob, generation = 1): LaneState {
  return {
    phase: "running", current: j, replacement: null, coalescedRevision: null,
    currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
    generation, completedGeneration: 0,
  };
}

function idleLane(): LaneState {
  return {
    phase: "idle", current: null, replacement: null, coalescedRevision: null,
    currentStartedAt: null, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
    generation: 0, completedGeneration: 0,
  };
}

function stateWith(over: Partial<SchedulerState>): SchedulerState {
  return {
    lanes: over.lanes ?? [idleLane(), idleLane()],
    queue: over.queue ?? [],
    deferred: over.deferred ?? [],
    quietSince: over.quietSince ?? null,
    cyclePos: over.cyclePos ?? 0,
    catalog: over.catalog ?? [],
    lastShownAt: over.lastShownAt ?? {},
  };
}

describe("toTickerJob", () => {
  it("priority 既定 low、segments 生成、dto.seq を採番に使う", () => {
    const dto = tickerEvent({ id: "e1", seq: 42, eventKey: "k1", tickerBody: "解説本文です。", tickerPriority: "mid" });
    const j = toTickerJob(dto, 999);
    expect(j.priority).toBe("mid");
    expect(j.seq).toBe(42);
    expect(j.segments.length).toBeGreaterThan(0);
    expect(j.key).toBe("k1");
  });

  it("dto.seq=0/欠落時のみ親 fallbackSeq を振る", () => {
    const dto = tickerEvent({ id: "e2", seq: 0, tickerBody: "本文。" });
    expect(toTickerJob(dto, 7).seq).toBe(7);
  });

  it("tickerPriority 欠落は low、本文なしは tickerSentence へフォールバック", () => {
    const dto = tickerEvent({ id: "e3", tickerBody: null, tickerSentence: "一言サマリ" });
    const j = toTickerJob(dto, 1);
    expect(j.priority).toBe("low");
    expect(j.segments).toEqual(["一言サマリ"]);
  });

  it("dto.tickerSubject を job.subject へ写す (欠落は null)", () => {
    const dto = tickerEvent({ id: "e4", eventKey: "k4", tickerBody: "本文。", tickerSubject: "桜島" });
    expect(toTickerJob(dto, 1).subject).toBe("桜島");
    const dto2 = tickerEvent({ id: "e5", eventKey: "k5", tickerBody: "本文。" });
    expect(toTickerJob(dto2, 1).subject).toBeNull();
  });
});

describe("assignLanes: 割当と優先度", () => {
  it("high は lane0、low は lane1、mid は lane0 塞がりで待機 (§7 役割)", () => {
    const s = stateWith({ queue: [job({ key: "a", priority: "low", seq: 3 }), job({ key: "b", priority: "high", seq: 5 }), job({ key: "c", priority: "mid", seq: 1 })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[0].current?.key).toBe("b"); // high は上段
    expect(state.lanes[1].current?.key).toBe("a"); // low は下段 (mid に巻き添え飢餓しない)
    expect(state.queue.map((j) => j.key)).toEqual(["c"]); // mid は lane0 が high で塞がり待機
  });

  it("high は low を 150ms フェードで割込む (replacement 原子確保・fading)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "lowA", priority: "low" })), runningLane(job({ key: "lowB", priority: "low" }))],
      queue: [job({ key: "hi", priority: "high" })],
    });
    const { state } = assignLanes(s, 1000);
    const fading = state.lanes.find((l) => l.phase === "fading");
    expect(fading).toBeTruthy();
    expect(fading!.replacement?.key).toBe("hi");
    expect(fading!.current?.priority).toBe("low");
  });

  it("mid は走行中の low を割込まずキューで待つ (high 限定割込み、2026-07-13)", () => {
    // lane0 が low 流用中でも mid は割込まない。low は流し終わるまで走行継続、mid はキュー待ち
    const s = stateWith({
      lanes: [runningLane(job({ key: "lowA", priority: "low" })), runningLane(job({ key: "lowB", priority: "low" }))],
      queue: [job({ key: "mid2", priority: "mid" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.phase === "fading")).toBe(false); // 割込まない
    expect(state.lanes[0].current?.key).toBe("lowA"); // 上段の low は流し終わりまで継続
    expect(state.lanes[1].current?.key).toBe("lowB"); // 下段の low も不変
    expect(state.queue.some((j) => j.key === "mid2")).toBe(true); // mid はキュー待ち

    // lane0 が mid で塞がっていても同様に新 mid は待機 (mid は mid も割込まない)
    const busy = stateWith({
      lanes: [runningLane(job({ key: "midA", priority: "mid" })), runningLane(job({ key: "lowB", priority: "low" }))],
      queue: [job({ key: "mid2", priority: "mid" })],
    });
    const out = assignLanes(busy, 1000).state;
    expect(out.lanes.some((l) => l.phase === "fading")).toBe(false); // 割込まず
    expect(out.queue.some((j) => j.key === "mid2")).toBe(true); // 待機
  });

  it("両レーン high なら新 high は待つ (queue に留まる)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "h1", priority: "high" })), runningLane(job({ key: "h2", priority: "high" }))],
      queue: [job({ key: "h3", priority: "high" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.every((l) => l.phase === "running")).toBe(true);
    expect(state.queue.map((j) => j.key)).toEqual(["h3"]);
  });

  it("high は常に lane0 を割込む (下段の low ではなく上段の mid を割込む、§7 役割)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "mid", priority: "mid" })), runningLane(job({ key: "low", priority: "low" }))],
      queue: [job({ key: "hi", priority: "high" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[0].phase).toBe("fading"); // 上段を割込む
    expect(state.lanes[0].replacement?.key).toBe("hi");
    expect(state.lanes[0].current?.key).toBe("mid"); // lane0 の mid が退場対象
    expect(state.lanes[1].current?.key).toBe("low"); // 下段の low は不変
  });
});

describe("即時割込みは high 限定 (2026-07-13、注意報ラッシュ対策)", () => {
  it("(a) mid は走行中の low を割込めず、low の流し終わり後にキューの mid が入る", () => {
    // low を 1 run 走行中。同時に mid がキュー待機
    const j = job({ key: "lowA", priority: "low", segments: ["a"], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }] });
    const lowRunning = runningLane(j, 1); // lane0 に low
    lowRunning.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lowRunning, idleLane()], queue: [job({ key: "midQ", priority: "mid", seq: 1 })] });

    // tick: mid は割込まず、low が走行継続 / mid はキュー待ち
    const t1 = assignLanes(s, 1000).state;
    expect(t1.lanes.some((l) => l.phase === "fading")).toBe(false); // 即割込みしない
    expect(t1.lanes[0].current?.key).toBe("lowA"); // low 継続
    expect(t1.queue.some((j) => j.key === "midQ")).toBe(true); // mid はキュー待ち

    // low が流し終わる (最終 run 走破) → lane0 idle
    const done = onLineComplete(t1, 0, t1.lanes[0].generation, 2000);
    expect(done.lanes[0].phase).toBe("idle");
    // 次 tick: 待っていた mid が lane0 へ入る
    const t2 = assignLanes(done, 2000).state;
    expect(t2.lanes[0].current?.key).toBe("midQ"); // 流し終わりを待って昇格
  });

  it("(b) high は走行中の low/mid を即割込む (現行維持)", () => {
    // lane0=mid, lane1=low の両方走行中に high 到着 → lane0 (mid) を即割込む
    const s = stateWith({
      lanes: [runningLane(job({ key: "midR", priority: "mid" })), runningLane(job({ key: "lowR", priority: "low" }))],
      queue: [job({ key: "hi", priority: "high" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[0].phase).toBe("fading"); // 上段 mid を割込む
    expect(state.lanes[0].replacement?.key).toBe("hi");
    expect(state.lanes[0].current?.key).toBe("midR"); // 退場対象は mid

    // lane0 が low 単独なら high はその low を即割込む
    const s2 = stateWith({
      lanes: [runningLane(job({ key: "lowA", priority: "low" })), idleLane()],
      queue: [job({ key: "hi2", priority: "high" })],
    });
    const out = assignLanes(s2, 1000).state;
    expect(out.lanes[0].phase).toBe("fading");
    expect(out.lanes[0].replacement?.key).toBe("hi2");
  });

  it("(c) 同 groupKey の優先度上昇は従来どおり即差し替えされる (割込み制限の対象外)", () => {
    // 走行中の low に、同 groupKey で mid へ昇格した続報が来たら即 fade (別テロップの割込みではなく同話の更新)
    const cur = job({ key: "v1", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 2);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = enqueueJob(s, job({ key: "v2", groupKey: "g", priority: "mid" }), 1200);
    expect(out.lanes[0].phase).toBe("fading"); // mid 続報でも即差し替え
    expect(out.lanes[0].replacement?.key).toBe("v2");
    expect(out.lanes[0].coalescedRevision).toBeNull(); // coalescing でなく即 fade
  });
});

// 2 run の high テロップ (segments a|b / c|d)。runIndex 0 が run 前半、1 が run 後半 (= 最終 run)。
function twoRunHigh(key: string, groupKey: string): TickerJob {
  return job({
    key,
    priority: "high",
    groupKey,
    segments: ["a", "b", "c", "d"],
    runs: [
      { startSegmentIndex: 0, endSegmentIndexExclusive: 2 },
      { startSegmentIndex: 2, endSegmentIndexExclusive: 4 },
    ],
  });
}

describe("レーン役割 + high 量子の run 境界交代 (spec §7、B 案)", () => {
  it("high/mid は lane 0 のみ、lane 1 は low 専用", () => {
    const s = stateWith({
      lanes: [idleLane(), idleLane()],
      queue: [job({ key: "h", priority: "high", groupKey: "gh" }), job({ key: "l", priority: "low" })],
      catalog: [],
    });
    const out = assignLanes(s, 1000).state;
    expect(out.lanes[0]!.current!.key).toBe("h"); // high は上段
    expect(out.lanes[1]!.current?.priority ?? "low").not.toBe("high"); // 下段に high は載らない
  });

  it("high 2 件目は lane 1 に載らず queue で待つ", () => {
    const running = runningLane(job({ key: "h1", priority: "high", groupKey: "g1" }), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    const out = assignLanes(s, 1000).state;
    expect(out.lanes[1]!.current?.priority ?? "low").not.toBe("high");
    expect(out.queue.some((j) => j.key === "h2")).toBe(true); // 待機
  });

  it("(a) 量子 8 秒到達だけでは交代しない (壁時計交代を廃止、run 走行は継続)", () => {
    const running = runningLane(twoRunHigh("h1", "g1"), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    // 量子満了時刻に assignLanes を回しても、run 走行中は fade を開始しない (交代は run 境界のみ)
    const out = assignLanes(s, 1000 + HIGH_SLICE_MS).state;
    expect(out.lanes[0]!.phase).toBe("running");
    expect(out.lanes[0]!.current!.key).toBe("h1");
    expect(out.lanes[0]!.replacement).toBeNull();
    expect(out.queue.some((j) => j.key === "h2")).toBe(true); // h2 は待機のまま
  });

  it("(b)(c) 量子経過後の run 境界 (onLineComplete) で h2 へ交代し、h1 は次 run から queue 復帰する", () => {
    const running = runningLane(twoRunHigh("h1", "g1"), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    // run 前半 (runIndex 0) を走破。量子は満了済み + 別 groupKey high 待機 → 次 run へ進まず h2 へ交代
    const out = onLineComplete(s, 0, running.generation, 1000 + HIGH_SLICE_MS);
    expect(out.lanes[0]!.phase).toBe("running");
    expect(out.lanes[0]!.current!.key).toBe("h2"); // (b) h2 が走行へ
    expect(out.lanes[0]!.highSliceStartedAt).toBe(1000 + HIGH_SLICE_MS); // 別 groupKey → 量子を張り直す
    const g1 = out.queue.filter((j) => j.groupKey === "g1");
    expect(g1.length).toBe(1); // (c) h1 は 1 件だけ queue へ
    expect(g1[0]!.runIndex).toBe(1); // 次 run から
    expect(g1[0]!.segmentIndex).toBe(2); // 次 run 先頭セグメント
  });

  it("量子未経過の run 境界では交代せず通常の run 遷移をする (h2 は待機継続)", () => {
    const running = runningLane(twoRunHigh("h1", "g1"), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    // run 前半を走破。量子未経過 (3 秒) → 交代しないで次 run へ
    const out = onLineComplete(s, 0, running.generation, 1000 + 3_000);
    expect(out.lanes[0]!.current!.key).toBe("h1");
    expect(out.lanes[0]!.current!.runIndex).toBe(1); // 通常の run 遷移
    expect(out.queue.some((j) => j.key === "h2")).toBe(true); // h2 まだ待機
  });

  it("(d) 最終 run 完了は量子未経過でも従来どおり idle → 次 tick で h2 割当", () => {
    // 単一 run の h1。量子未経過でも最終 run を走破すれば idle 化 (走行が終わったので交代してよい)
    const running = runningLane(job({ key: "h1", priority: "high", groupKey: "g1", segments: ["a"] }), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    const done = onLineComplete(s, 0, running.generation, 1000 + 3_000); // 量子未経過
    expect(done.lanes[0]!.phase).toBe("idle"); // 最終 run → idle
    const assigned = assignLanes(done, 1000 + 3_000).state;
    expect(assigned.lanes[0]!.current!.key).toBe("h2"); // 次 tick で h2 が上段へ
  });

  it("単独 high なら run 境界でも交代しない (別 groupKey high 不在)", () => {
    const running = runningLane(twoRunHigh("h1", "g1"), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    const s = stateWith({ lanes: [running, idleLane()], queue: [] }); // 別 high なし
    // 量子を十分に過ぎていても、queue に別 groupKey high が無ければ交代せず通常 run 遷移
    const out = onLineComplete(s, 0, running.generation, 1000 + HIGH_SLICE_MS + 5_000);
    expect(out.lanes[0]!.current!.key).toBe("h1");
    expect(out.lanes[0]!.current!.runIndex).toBe(1); // 通常の run 遷移
  });

  it("run 境界交代で未昇格の coalescedRevision を捨てない (最新版を頭から退避、R1 必須2)", () => {
    const running = runningLane(twoRunHigh("h1", "g1"), 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    running.coalescedRevision = { ...job({ key: "h1b", priority: "high", groupKey: "g1", segments: ["A", "B"] }), revisionAt: null };
    running.revisionFirstQueuedAt = 1100;
    running.revisionDebounceUntil = 1000 + HIGH_SLICE_MS + 650; // run 境界時点で debounce 未了 = 未昇格
    const s = stateWith({ lanes: [running, idleLane()], queue: [job({ key: "h2", priority: "high", groupKey: "g2" })] });
    const out = onLineComplete(s, 0, running.generation, 1000 + HIGH_SLICE_MS); // 量子満了の run 境界で交代
    expect(out.lanes[0]!.current!.key).toBe("h2");
    const g1 = out.queue.filter((j) => j.groupKey === "g1");
    expect(g1.length).toBe(1);
    expect(g1[0]!.key).toBe("h1b"); // 最新版が退避される (旧 h1 でなく)
    expect(g1[0]!.segmentIndex).toBe(0); // 新本文は頭から
    expect(out.lanes[0]!.coalescedRevision).toBeNull(); // 続報バッファは消費済み
  });

  it("second high の 8 秒保証が同格 revision 昇格でリセットされない (時計分離、R1 必須2)", () => {
    // h1 走行中に同格続報 h1b が昇格しても highSliceStartedAt は維持される
    const h1 = job({ key: "h1", priority: "high", groupKey: "g1", segments: ["a"] });
    const running = runningLane(h1, 1);
    running.currentStartedAt = 1000;
    running.highSliceStartedAt = 1000;
    running.coalescedRevision = { ...job({ key: "h1b", priority: "high", groupKey: "g1", segments: ["A"] }), revisionAt: null };
    running.revisionDebounceUntil = 1000; // 即昇格可能
    const s = stateWith({ lanes: [running, idleLane()] });
    // 昇格 (fade 開始) → fade 完了。highSliceStartedAt は 1000 のまま (同 groupKey なので張り直さない)
    const promoted = assignLanes(s, 1000 + 2_500).state; // MIN_VISIBLE 経過で昇格
    const done = onFadeComplete(promoted, 0, promoted.lanes[0]!.generation, 1000 + 2_500 + 150);
    expect(done.lanes[0]!.current!.key).toBe("h1b");
    expect(done.lanes[0]!.highSliceStartedAt).toBe(1000); // リセットされない
  });
});

describe("退避・再試行・保留 (退避は fade 完了時に起きる)", () => {
  function fadingLane(cur: TickerJob, rep: TickerJob): LaneState {
    return {
      phase: "fading", current: cur, replacement: rep, coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 5, completedGeneration: 0,
    };
  }

  it("mid が割込まれたら segmentIndex 保存で即時 queue 復帰 (保留なし)", () => {
    const s = stateWith({
      lanes: [fadingLane(job({ key: "mid", priority: "mid", segmentIndex: 2 }), job({ key: "hi", priority: "high" })), idleLane()],
    });
    const state = onFadeComplete(s, 0, 5, 1000);
    const midBack = state.queue.find((j) => j.key === "mid");
    expect(midBack).toBeTruthy();
    expect(midBack!.segmentIndex).toBe(2); // 進捗保存
    expect(midBack!.deferKind).toBeNull(); // 保留なし
  });

  it("low が割込まれたら quiet 保留 (retryCount 1、segmentIndex 保存)", () => {
    const s = stateWith({
      lanes: [fadingLane(job({ key: "low", priority: "low", segmentIndex: 1 }), job({ key: "hi", priority: "high" })), idleLane()],
    });
    const state = onFadeComplete(s, 0, 5, 1000);
    const dl = state.deferred.find((j) => j.key === "low");
    expect(dl?.deferKind).toBe("quiet");
    expect(dl?.retryCount).toBe(1);
    expect(dl?.segmentIndex).toBe(1);
  });

  it("再割込みで long 保留 (retryCount 2 飽和・5分固定期限)", () => {
    const s = stateWith({
      lanes: [fadingLane(job({ key: "low", priority: "low", retryCount: 1 }), job({ key: "hi", priority: "high" })), idleLane()],
    });
    const state = onFadeComplete(s, 0, 5, 1000);
    const dl = state.deferred.find((j) => j.key === "low");
    expect(dl?.deferKind).toBe("long");
    expect(dl?.retryCount).toBe(2);
    expect(dl?.deferUntil).toBe(1000 + LONG_DEFER_MS);
  });
});

describe("assignLanes: quietSince と deferred 起床", () => {
  it("high/mid 走行中は quietSince=null、両レーンから消えたら now", () => {
    const running = assignLanes(stateWith({ lanes: [runningLane(job({ key: "h", priority: "high" })), idleLane()] }), 500);
    expect(running.state.quietSince).toBeNull();
    const quiet = assignLanes(stateWith({ lanes: [idleLane(), idleLane()] }), 800);
    expect(quiet.state.quietSince).toBe(800);
  });

  it("割込み退避 (quiet) は連続 5 秒静穏後に queue へ昇格し同セグメントから再走 (読みかけの続きを早く再開、飢餓防止)", () => {
    const s = stateWith({
      deferred: [job({ key: "low", priority: "low", deferKind: "quiet", segmentIndex: 2, retryCount: 1 })],
      quietSince: 1000,
    });
    // 5 秒未満: まだ deferred
    const early = assignLanes(s, 1000 + INTERRUPTED_RESUME_MS - 1);
    expect(early.state.deferred.some((j) => j.key === "low")).toBe(true);
    // 5 秒到達: queue 経由でレーンへ (segmentIndex 保存)
    const woke = assignLanes(s, 1000 + INTERRUPTED_RESUME_MS);
    const onLane = woke.state.lanes.find((l) => l.current?.key === "low");
    expect(onLane?.current?.segmentIndex).toBe(2);
  });

  it("再割込み (long) は従来どおり 5 分保留のまま (quiet 短縮の巻き添えにしない)", () => {
    // 静穏 5 秒経過でも long は起きない。long は deferUntil (5 分固定) が真実源
    const s = stateWith({
      deferred: [job({ key: "low", priority: "low", deferKind: "long", deferUntil: 1000 + LONG_DEFER_MS, retryCount: 2 })],
      quietSince: 1000,
    });
    const at5s = assignLanes(s, 1000 + INTERRUPTED_RESUME_MS + 100);
    expect(at5s.state.deferred.some((j) => j.key === "low")).toBe(true); // まだ保留
    const at5min = assignLanes(s, 1000 + LONG_DEFER_MS);
    expect(at5min.state.deferred.some((j) => j.key === "low")).toBe(false); // 5 分で起床
    // 起床後は空きレーンへ載る (queue を経由してレーンに配置される)
    expect(at5min.state.lanes.some((l) => l.current?.key === "low")).toBe(true);
  });

  it("wakeAt は deferred の最小起床時刻 (quiet=quietSince+5s)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "a" })), runningLane(job({ key: "b" }))], // 両レーン塞ぐ
      deferred: [job({ key: "low", priority: "low", deferKind: "quiet" })],
      quietSince: 2000,
    });
    const { wakeAt } = assignLanes(s, 2100);
    expect(wakeAt).toBe(2000 + INTERRUPTED_RESUME_MS);
  });

  it("期限到来 deferred は両レーン running でも queue へ昇格し timer ループしない (Medium 1)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "a", priority: "low" })), runningLane(job({ key: "b", priority: "low" }))],
      deferred: [job({ key: "low", priority: "low", deferKind: "long", deferUntil: 500 })],
    });
    const { state, wakeAt } = assignLanes(s, 1000);
    expect(state.deferred.length).toBe(0); // deferred から抜けた
    expect(state.queue.some((j) => j.key === "low")).toBe(true); // queue で空き待ち
    expect(wakeAt).toBeNull(); // 0ms 張り直しループが起きない
  });
});

describe("assignLanes: low 巡回 (Medium 3)", () => {
  it("片レーン running でも idle 側に catalog low が補充される", () => {
    const catalog = [job({ key: "c1", priority: "low" }), job({ key: "c2", priority: "low" })];
    const s = stateWith({ lanes: [runningLane(job({ key: "c1", priority: "low" })), idleLane()], catalog });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[1].phase).toBe("running");
    expect(state.lanes[1].current?.key).toBe("c2"); // active な c1 は除外
  });

  it("全候補が active/queue/deferred なら idle のまま (有限走査・無限ループ防止)", () => {
    const catalog = [job({ key: "c1", priority: "low" })];
    const s = stateWith({ lanes: [runningLane(job({ key: "c1", priority: "low" })), idleLane()], catalog });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[1].phase).toBe("idle");
  });

  it("foldCatalog は新しい順入力で先勝ち = 最新版を残す (旧版が巡回再登場しない、Medium 1)", () => {
    // lines は新しい順なので入力先頭が最新。先勝ちで new を残す
    const folded = foldCatalog([
      job({ key: "new", groupKey: "g1", seq: 2 }),
      job({ key: "old", groupKey: "g1", seq: 1 }),
      job({ key: "solo", groupKey: null }),
    ]);
    expect(folded.some((j) => j.key === "new")).toBe(true);
    expect(folded.some((j) => j.key === "old")).toBe(false);
    expect(folded.some((j) => j.key === "solo")).toBe(true);
  });

  it("巡回候補は low のみ (high/mid は catalog にあっても巡回再生されない、Critical 2)", () => {
    const catalog = [job({ key: "midC", priority: "mid" }), job({ key: "lowC", priority: "low" })];
    const s = stateWith({ lanes: [idleLane(), idleLane()], catalog });
    // queue 空 → 巡回のみ。mid は巡回対象外、low だけが載る
    const { state } = assignLanes(s, 1000);
    const shown = state.lanes.filter((l) => l.phase === "running").map((l) => l.current?.key);
    expect(shown).toContain("lowC");
    expect(shown).not.toContain("midC");
  });
});

describe("onLineComplete (run 遷移、spec §2-1/§2-5)", () => {
  it("単一 run のジョブは走破で idle (次を pull できる状態)", () => {
    const j = job({ key: "k", segments: ["a", "b"], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 2 }], runIndex: 0 });
    const s = stateWith({ lanes: [runningLane(j, 2), idleLane()] });
    const out = onLineComplete(s, 0, 2, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
    expect(out.lanes[0]!.current).toBeNull();
  });

  it("複数 run は runIndex++ で次 run へ (segmentIndex = 次 run 先頭、generation++)", () => {
    const runs = [
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
    ];
    const j = job({ key: "k", segments: ["a", "b"], runs, runIndex: 0, segmentIndex: 0 });
    const s = stateWith({ lanes: [runningLane(j, 2), idleLane()] });
    const out = onLineComplete(s, 0, 2, 1000);
    expect(out.lanes[0]!.phase).toBe("running");
    expect(out.lanes[0]!.current!.runIndex).toBe(1);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(1);
    expect(out.lanes[0]!.generation).toBe(3);
    expect(out.lanes[0]!.currentStartedAt).toBe(1000); // run 遷移で最短表示リセット
  });

  it("最終 run 走破でジョブ完了 → idle", () => {
    const runs = [
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
    ];
    const j = job({ key: "k", segments: ["a", "b"], runs, runIndex: 1, segmentIndex: 1 });
    const s = stateWith({ lanes: [runningLane(j, 2), idleLane()] });
    const out = onLineComplete(s, 0, 2, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
  });

  it("世代不一致・完了済みは無視", () => {
    const j = job({ key: "k", segments: ["a", "b"], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 2 }] });
    const lane = runningLane(j, 2);
    lane.completedGeneration = 2;
    const s = stateWith({ lanes: [lane, idleLane()] });
    expect(onLineComplete(s, 0, 2, 1000).lanes[0]!.phase).toBe("running"); // 完了済みガード
    expect(onLineComplete(s, 0, 99, 1000).lanes[0]!.phase).toBe("running"); // 世代不一致
  });

  it("完走時に未昇格の coalescedRevision を捨てず最新版を頭から昇格する (promotion 遅延の取りこぼし防止、§5-1)", () => {
    // v1 走行中に続報を buffer したが、promotion タイマーが来る前に v1 が完走した状況。
    // idle に落として続報を捨てるのではなく、続報を次 current として頭から走らせる。
    const v1 = job({ key: "v1", groupKey: "g", priority: "low", segments: ["旧"], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }] });
    const lane = runningLane(v1, 2);
    lane.currentStartedAt = 0;
    lane.coalescedRevision = { ...job({ key: "v3", groupKey: "g", priority: "low", segments: ["新"] }), revisionAt: null };
    lane.revisionFirstQueuedAt = 100;
    lane.revisionDebounceUntil = 850;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = onLineComplete(s, 0, 2, 1000);
    const l0 = out.lanes[0]!;
    expect(l0.phase).toBe("running"); // idle に落とさない
    expect(l0.current!.key).toBe("v3"); // 最新続報を昇格
    expect(l0.current!.segmentIndex).toBe(0); // 頭から
    expect(l0.current!.revisionAt).toBe(1000); // 続報の表示昇格時刻 (Spec C バッジ)
    expect(l0.currentStartedAt).toBe(1000); // 最短表示起点を更新
    expect(l0.coalescedRevision).toBeNull(); // buffer は消費済み
    expect(l0.revisionDebounceUntil).toBeNull();
    expect(l0.generation).toBe(3); // 新要素へ世代更新
  });

  it("完走時に coalescedRevision が無ければ従来どおり idle", () => {
    const j = job({ key: "k", segments: ["a"], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }] });
    const s = stateWith({ lanes: [runningLane(j, 2), idleLane()] });
    const out = onLineComplete(s, 0, 2, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
    expect(out.lanes[0]!.current).toBeNull();
  });
});

describe("onFadeComplete", () => {
  it("replacement を current へ昇格し、割込まれた current を退避 (low→quiet)", () => {
    const lane: LaneState = {
      phase: "fading", current: job({ key: "low", priority: "low", segmentIndex: 1 }),
      replacement: job({ key: "hi", priority: "high" }), coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 4, completedGeneration: 0,
    };
    const s = stateWith({ lanes: [lane, runningLane(job({ key: "x", priority: "high" }))] });
    const next = onFadeComplete(s, 0, 4, 1000);
    expect(next.lanes[0].phase).toBe("running");
    expect(next.lanes[0].current?.key).toBe("hi");
    expect(next.lanes[0].currentStartedAt).toBe(1000); // 昇格で最短表示起点を更新
    expect(next.deferred.find((j) => j.key === "low")?.deferKind).toBe("quiet");
  });

  it("世代不一致の scroll/二重 fade completion は弾く", () => {
    const lane: LaneState = {
      phase: "fading", current: job({ key: "low" }), replacement: job({ key: "hi", priority: "high" }),
      coalescedRevision: null, currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 4, completedGeneration: 0,
    };
    const s = stateWith({ lanes: [lane, idleLane()] });
    expect(onFadeComplete(s, 0, 3, 1000).lanes[0].phase).toBe("fading"); // 古い世代 (scroll 遅延)
    const once = onFadeComplete(s, 0, 4, 1000);
    const twice = onFadeComplete(once, 0, 4, 1000); // 既に running、completedGeneration
    expect(twice.lanes[0].current?.key).toBe("hi");
  });

  it("昇格する replacement と同 groupKey の旧 current は superseded で退避しない", () => {
    const lane: LaneState = {
      phase: "fading", current: job({ key: "cur", groupKey: "g", priority: "low" }),
      replacement: job({ key: "rev", groupKey: "g", priority: "low", segments: ["新"] }),
      coalescedRevision: null, currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 4, completedGeneration: 0,
    };
    const s = stateWith({ lanes: [lane, runningLane(job({ key: "x", priority: "high" }))] });
    const next = onFadeComplete(s, 0, 4, 1000);
    expect(next.lanes[0].current?.key).toBe("rev");
    expect(next.deferred.some((j) => j.key === "cur")).toBe(false); // 自身の新版に置換 → 退避しない
    expect(next.queue.some((j) => j.key === "cur")).toBe(false);
  });
});

describe("enqueueJob: groupKey 版管理", () => {
  it("queue 内の旧版を新版で置換 (旧 seq を継ぐ)", () => {
    const s = stateWith({ queue: [job({ key: "v1", groupKey: "g", seq: 5, segments: ["旧"] })] });
    const next = enqueueJob(s, job({ key: "v2", groupKey: "g", seq: 99, segments: ["新"] }), 1000);
    expect(next.queue.length).toBe(1);
    expect(next.queue[0].key).toBe("v2");
    expect(next.queue[0].seq).toBe(5); // 旧 seq 継承 (列の後ろへ回さない)
  });

  it("deferred 内の旧版を置換 (segmentIndex=0、retryCount/deferKind 継承)", () => {
    const s = stateWith({ deferred: [job({ key: "v1", groupKey: "g", segmentIndex: 3, retryCount: 2, deferKind: "long", deferUntil: 5000 })] });
    const next = enqueueJob(s, job({ key: "v2", groupKey: "g", segments: ["新"] }), 1000);
    const d = next.deferred[0];
    expect(d.key).toBe("v2");
    expect(d.segmentIndex).toBe(0);
    expect(d.retryCount).toBe(2);
    expect(d.deferKind).toBe("long");
  });
});

describe("二段制御 coalescing (spec §5)", () => {
  it("mustReplaceImmediately: 取消・優先度上昇は true、同格は false", () => {
    const low = job({ key: "a", groupKey: "g", priority: "low" });
    const lowNext = job({ key: "a2", groupKey: "g", priority: "low" });
    const highNext = job({ key: "a3", groupKey: "g", priority: "high" });
    const cancelNext = job({ key: "a4", groupKey: "g", priority: "low", isCancellation: true });
    expect(mustReplaceImmediately(low, lowNext)).toBe(false);
    expect(mustReplaceImmediately(low, highNext)).toBe(true);
    expect(mustReplaceImmediately(low, cancelNext)).toBe(true);
  });

  it("同格続報は coalescedRevision に畳まれ、buffer 内 revisionAt は null", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const next = job({ key: "a2", groupKey: "g", priority: "low" });
    const out = enqueueJob(s, next, 1200);
    expect(out.lanes[0]!.coalescedRevision).not.toBeNull();
    expect(out.lanes[0]!.coalescedRevision!.revisionAt).toBeNull();
    expect(out.lanes[0]!.current!.key).toBe("a"); // まだ差し替わらない
    expect(out.lanes[0]!.revisionFirstQueuedAt).toBe(1200);
    expect(out.lanes[0]!.revisionDebounceUntil).toBe(1200 + REVISION_COALESCE_MS);
  });

  it("coalescedRevision 保持中の連続続報は最新で上書き (revisionFirstQueuedAt は初回を保持)", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const mid = enqueueJob(s, job({ key: "a2", groupKey: "g", priority: "low" }), 1200);
    const out = enqueueJob(mid, job({ key: "a3", groupKey: "g", priority: "low" }), 1400);
    expect(out.lanes[0]!.coalescedRevision!.key).toBe("a3");
    expect(out.lanes[0]!.coalescedRevision!.revisionAt).toBeNull();
    expect(out.lanes[0]!.revisionFirstQueuedAt).toBe(1200); // 初回起点は不変
    expect(out.lanes[0]!.revisionDebounceUntil).toBe(1400 + REVISION_COALESCE_MS);
  });

  it("取消続報は即 fade (replacement へ、revisionAt=now)", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const next = job({ key: "a2", groupKey: "g", priority: "low", isCancellation: true });
    const out = enqueueJob(s, next, 1200);
    expect(out.lanes[0]!.phase).toBe("fading");
    expect(out.lanes[0]!.replacement!.revisionAt).toBe(1200);
    expect(out.lanes[0]!.coalescedRevision).toBeNull();
  });

  it("優先度上昇続報は即 fade (replacement へ、revisionAt=now)", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const next = job({ key: "a2", groupKey: "g", priority: "high" });
    const out = enqueueJob(s, next, 1200);
    expect(out.lanes[0]!.phase).toBe("fading");
    expect(out.lanes[0]!.replacement!.key).toBe("a2");
    expect(out.lanes[0]!.replacement!.revisionAt).toBe(1200);
    expect(out.queue.some((j) => j.key === "a2")).toBe(false); // queue へは積まない
  });

  it("fading の replacement と同 groupKey の続報は差替え (fade 継続、revisionAt=now)", () => {
    const lane: LaneState = {
      phase: "fading", current: job({ key: "cur", priority: "low" }),
      replacement: job({ key: "rep", groupKey: "g", priority: "high" }), coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 4, completedGeneration: 0,
    };
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = enqueueJob(s, job({ key: "rep2", groupKey: "g", priority: "high" }), 1200);
    expect(out.lanes[0]!.phase).toBe("fading");
    expect(out.lanes[0]!.replacement!.key).toBe("rep2");
    expect(out.lanes[0]!.replacement!.revisionAt).toBe(1200);
  });

  it("MIN_VISIBLE 経過 + debounce 完了で昇格 (assignLanes tick)", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    lane.coalescedRevision = { ...job({ key: "a2", groupKey: "g", priority: "low" }), revisionAt: null };
    lane.revisionDebounceUntil = 1000 + REVISION_COALESCE_MS;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = assignLanes(s, 1000 + MIN_VISIBLE_MS).state;
    expect(out.lanes[0]!.phase).toBe("fading"); // 昇格 = fade 開始
    expect(out.lanes[0]!.replacement!.key).toBe("a2");
    expect(out.lanes[0]!.replacement!.revisionAt).toBe(1000 + MIN_VISIBLE_MS);
  });

  it("MIN_VISIBLE 未満では debounce 完了でも昇格しない", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    lane.coalescedRevision = { ...job({ key: "a2", groupKey: "g", priority: "low" }), revisionAt: null };
    lane.revisionDebounceUntil = 1100; // debounce は完了
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = assignLanes(s, 1200).state; // まだ MIN_VISIBLE 未満
    expect(out.lanes[0]!.phase).toBe("running");
    expect(out.lanes[0]!.coalescedRevision).not.toBeNull();
  });

  it("MAX_REVISION_WAIT 到達で debounce 未完了でも昇格 (assignLanes tick)", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    lane.coalescedRevision = { ...job({ key: "a2", groupKey: "g", priority: "low" }), revisionAt: null };
    lane.revisionDebounceUntil = 1000 + MAX_REVISION_WAIT_MS + 10_000; // debounce まだ先
    const s = stateWith({ lanes: [lane, idleLane()] });
    const out = assignLanes(s, 1000 + MAX_REVISION_WAIT_MS).state;
    expect(out.lanes[0]!.phase).toBe("fading"); // 昇格 = fade 開始
    expect(out.lanes[0]!.replacement!.revisionAt).toBe(1000 + MAX_REVISION_WAIT_MS);
  });

  it("coalescing 期限が wakeAt に合流する", () => {
    const cur = job({ key: "a", groupKey: "g", priority: "low" });
    const lane = runningLane(cur, 1);
    lane.currentStartedAt = 1000;
    lane.coalescedRevision = { ...job({ key: "a2", groupKey: "g", priority: "low" }), revisionAt: null };
    lane.revisionDebounceUntil = 1000 + REVISION_COALESCE_MS;
    // もう片方のレーンも塞いで巡回昇格を防ぐ
    const s = stateWith({ lanes: [lane, runningLane(job({ key: "b", priority: "low" }), 2)] });
    const { wakeAt } = assignLanes(s, 1100);
    expect(wakeAt).toBe(1000 + MIN_VISIBLE_MS); // min(maxWait, max(minVisible, debounce))
  });

  it("priority 昇格続報でも queue へは積まない (直接 fade、Medium 3)", () => {
    const lane = runningLane(job({ key: "v1", groupKey: "g", priority: "low" }), 2);
    lane.currentStartedAt = 1000;
    const s = stateWith({ lanes: [lane, idleLane()] });
    const next = enqueueJob(s, job({ key: "v2", groupKey: "g", priority: "high" }), 1200);
    expect(next.lanes[0].phase).toBe("fading");
    expect(next.lanes[0].replacement?.key).toBe("v2");
    expect(next.lanes[0].coalescedRevision).toBeNull();
    expect(next.queue.some((j) => j.key === "v2")).toBe(false);
  });
});

describe("reset を跨ぐ generation 単調増加 (Critical 1)", () => {
  it("resetScheduler は generationSeed 以上の世代から再構築する", () => {
    const s = resetScheduler([job({ key: "a", priority: "low" })], 5);
    expect(s.lanes.every((l) => l.generation >= 5)).toBe(true);
    const { state } = assignLanes(s, 1000);
    // 割当された要素の世代は seed(5) より大きい
    const assigned = state.lanes.find((l) => l.phase === "running");
    expect(assigned!.generation).toBeGreaterThan(5);
  });

  it("連続 reset で世代が一致しない (旧 DOM 再利用・旧遅延イベント誤通過を防ぐ)", () => {
    // 1 回目: 空 seed から割当
    let s = resetScheduler([job({ key: "a", priority: "low" })], 0);
    ({ state: s } = assignLanes(s, 1000));
    const gen1 = s.lanes.find((l) => l.phase === "running")!.generation;
    // 2 回目 reset: 旧最大世代 + 1 を seed に
    s = resetScheduler([job({ key: "b", priority: "low" })], maxLaneGeneration(s) + 1);
    ({ state: s } = assignLanes(s, 2000));
    const gen2 = s.lanes.find((l) => l.phase === "running")!.generation;
    expect(gen2).toBeGreaterThan(gen1); // 世代が単調増加、一致しない
  });
});

describe("resetScheduler", () => {
  it("catalog から作り直し、初回 queue にも畳み込み済み catalog を積む (Critical 2)", () => {
    // 新しい順入力 → 先勝ちで c1 が残る
    const s = resetScheduler([job({ key: "c1", groupKey: "g", seq: 2 }), job({ key: "c2", groupKey: "g", seq: 1 })]);
    expect(s.deferred).toEqual([]);
    expect(s.lanes.every((l) => l.phase === "idle")).toBe(true);
    expect(s.catalog.length).toBe(1); // groupKey 畳み込み
    expect(s.queue.map((j) => j.key)).toEqual(["c1"]); // queue にも積まれる
  });

  it("reset 直後の assignLanes は queue から役割割当 (巡回直行しない、Critical 2 + §7)", () => {
    const s = resetScheduler([
      job({ key: "lo", priority: "low", seq: 1 }),
      job({ key: "hi", priority: "high", seq: 2 }),
      job({ key: "mi", priority: "mid", seq: 3 }),
    ]);
    const { state } = assignLanes(s, 1000);
    // §7 役割: high は上段、low は下段。mid は lane0 が high で塞がり queue 待機 (巡回でなく queue から割当)
    expect(state.lanes[0].current?.key).toBe("hi"); // 上段 = high
    expect(state.lanes[1].current?.key).toBe("lo"); // 下段 = low
    expect(state.queue.some((j) => j.key === "mi")).toBe(true); // mid は待機
  });
});

describe("createSchedulerState", () => {
  it("LANES 本の idle レーンで初期化する", () => {
    const s = createSchedulerState([]);
    expect(s.lanes.length).toBe(2);
    expect(s.lanes.every((l) => l.phase === "idle")).toBe(true);
  });
});

describe("フロント時間ベース TTL 刈り込みの撤去 (spec §3-2、レビュー R2 Important 対応)", () => {
  it("composition の真実源はサーバ tickerSync に一本化したため、どれだけ古い job でも assignLanes は時間だけで刈らない", () => {
    const oldLow = job({ key: "old", priority: "low" });
    const running = runningLane(job({ key: "run", priority: "low" }), 1);
    running.currentStartedAt = 0;
    const runningOther = runningLane(job({ key: "run2", priority: "low" }), 1);
    runningOther.currentStartedAt = 0;
    const s = stateWith({ lanes: [running, runningOther], queue: [oldLow], catalog: [oldLow] });
    // 旧 low TTL (3h) や旧 backstop (6h) を大幅に超えた時刻でも queue/catalog から消えない
    const out = assignLanes(s, 24 * 60 * 60_000).state;
    expect(out.queue.some((j) => j.key === "old")).toBe(true);
    expect(out.catalog.some((j) => j.key === "old")).toBe(true);
  });
});

describe("onBookmarkCapture (spec §2-2)", () => {
  function fadingLane(j: TickerJob, generation = 1): LaneState {
    return {
      phase: "fading", current: j, replacement: null, coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation, completedGeneration: 0,
    };
  }

  it("nearBoundary=false は測定値をそのまま栞へ (単調非減少で clamp)", () => {
    const j = job({ key: "k", segments: ["a", "b", "c", "d"], segmentIndex: 0 });
    const s = stateWith({ lanes: [fadingLane(j, 3), idleLane()] });
    const out = onBookmarkCapture(s, 0, 3, 2, false);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(2);
  });

  it("nearBoundary=true は一つ前へ丸める", () => {
    const j = job({ key: "k", segments: ["a", "b", "c", "d"], segmentIndex: 0 });
    const s = stateWith({ lanes: [fadingLane(j, 3), idleLane()] });
    const out = onBookmarkCapture(s, 0, 3, 2, true);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(1);
  });

  it("世代不一致は無視 (状態を変えない)", () => {
    const j = job({ key: "k", segments: ["a", "b", "c"], segmentIndex: 1 });
    const s = stateWith({ lanes: [fadingLane(j, 3), idleLane()] });
    const out = onBookmarkCapture(s, 0, 99, 2, false);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(1);
  });

  it("既存栞より前へは戻さない (単調非減少)", () => {
    const j = job({ key: "k", segments: ["a", "b", "c", "d"], segmentIndex: 3 });
    const s = stateWith({ lanes: [fadingLane(j, 3), idleLane()] });
    const out = onBookmarkCapture(s, 0, 3, 1, false);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(3);
  });

  it("範囲外は segments 末尾へ clamp", () => {
    const j = job({ key: "k", segments: ["a", "b"], segmentIndex: 0 });
    const s = stateWith({ lanes: [fadingLane(j, 3), idleLane()] });
    const out = onBookmarkCapture(s, 0, 3, 9, false);
    expect(out.lanes[0]!.current!.segmentIndex).toBe(1);
  });
});

describe("巡回間隔 (spec §4)", () => {
  it("CYCLE_MIN_INTERVAL 未満の候補は巡回補充でスキップ", () => {
    const l1 = job({ key: "l1", priority: "low" });
    const s = stateWith({
      lanes: [idleLane(), idleLane()],
      catalog: [l1],
      lastShownAt: { l1: 1000 }, // 直近に流した
    });
    const out = assignLanes(s, 1000 + CYCLE_MIN_INTERVAL_MS - 1).state; // 間隔未満
    expect(out.lanes[1]!.phase).toBe("idle"); // 補充されず休む
  });

  it("間隔を満たせば巡回補充される", () => {
    const l1 = job({ key: "l1", priority: "low" });
    const s = stateWith({ lanes: [idleLane(), idleLane()], catalog: [l1], lastShownAt: { l1: 1000 } });
    const out = assignLanes(s, 1000 + CYCLE_MIN_INTERVAL_MS + 1).state;
    expect([out.lanes[0]!.current?.key, out.lanes[1]!.current?.key]).toContain("l1");
  });

  it("queue の high/mid には間隔を課さない", () => {
    const h = job({ key: "h", priority: "high", groupKey: "gh" });
    const s = stateWith({ lanes: [idleLane(), idleLane()], queue: [h], lastShownAt: { h: 999999999999 } });
    const out = assignLanes(s, 1000).state;
    expect(out.lanes[0]!.current!.key).toBe("h"); // 即流す
  });

  it("巡回間隔ゲート: 未満は両レーン idle / 経過後に補充 (ゲート弁別)", () => {
    const l1 = job({ key: "l1", priority: "low" });
    const base = { lanes: [idleLane(), idleLane()], catalog: [l1], lastShownAt: { l1: 1000 } };
    const tooSoon = assignLanes(stateWith(base), 1000 + CYCLE_MIN_INTERVAL_MS - 1).state;
    expect(tooSoon.lanes[0]!.phase).toBe("idle"); // ゲート無しなら lane0 に l1 が載って fail する弁別点
    expect(tooSoon.lanes[1]!.phase).toBe("idle");
    const ok = assignLanes(stateWith(base), 1000 + CYCLE_MIN_INTERVAL_MS + 1).state;
    expect(ok.lanes[0]!.current?.key).toBe("l1");
  });
});

describe("fade 中の同 group 続報 (最終レビュー finding 6)", () => {
  it("別 group への fade 中に outgoing current と同 group の続報が来たら最新版だけ退避する (旧版の stale 再表示を防ぐ)", () => {
    const now = 10_000;
    // lane0: gA(v1) を fade で退場させ、別 group gB へ交代中。segmentIndex=1 まで読んだ状態
    const a1 = job({ key: "a1", groupKey: "gA", priority: "low", subject: "v1", segmentIndex: 1 });
    const b1 = job({ key: "b1", groupKey: "gB", priority: "mid", seq: 2 });
    const fadingLane: LaneState = {
      phase: "fading", current: a1, replacement: b1, coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 3, completedGeneration: 0,
    };
    const state = stateWith({ lanes: [fadingLane, idleLane()] });

    // fade 中に outgoing (gA) の続報 v2 が到着 (replacement gB とは別 group)
    const a2 = job({ key: "a2", groupKey: "gA", priority: "low", subject: "v2", segmentIndex: 0 });
    const afterEnqueue = enqueueJob(state, a2, now);
    // fade 完了で replacement(gB) が current へ昇格、outgoing が退避される
    const afterFade = onFadeComplete(afterEnqueue, 0, 3, now + 150);

    const gAjobs = [
      ...afterFade.queue,
      ...afterFade.deferred,
      ...afterFade.lanes.flatMap((l) =>
        [l.current, l.replacement, l.coalescedRevision].filter((x): x is TickerJob => x != null)),
    ].filter((j) => j.groupKey === "gA");
    // 修正前: 旧 v1 が退避され、新 v2 は queue に別途残って gA が二重化 (length 2, v1 が resume される)
    expect(gAjobs).toHaveLength(1);
    expect(gAjobs[0]!.subject).toBe("v2"); // 退避されるのは最新版
    // gB は current へ昇格済み
    expect(afterFade.lanes[0]!.current?.groupKey).toBe("gB");
  });
});

describe("purgeJobs: フィラー (Tips) の即時除去 (緊急遷移で豆知識を残さない)", () => {
  const isTip = (j: TickerJob): boolean => j.kind === "tip";

  it("走行中 (current) の tip をレーンから除去し idle 化する。generation は前進させる", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "tip-1", kind: "tip", priority: "low" }), 3), runningLane(job({ key: "wx", priority: "low" }), 5)],
    });
    const out = purgeJobs(s, isTip, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
    expect(out.lanes[0]!.current).toBeNull();
    expect(out.lanes[0]!.generation).toBe(4); // 3 → +1 で遅延 animationend を無効化
    // 電文 low (非 tip) はそのまま保持される
    expect(out.lanes[1]!.current?.key).toBe("wx");
  });

  it("queue / deferred の tip を除去し、電文 job は残す", () => {
    const s = stateWith({
      queue: [job({ key: "tip-2", kind: "tip", priority: "low", seq: 1 }), job({ key: "vpww", priority: "mid", seq: 2 })],
      deferred: [job({ key: "tip-3", kind: "tip", priority: "low", deferKind: "quiet" }), job({ key: "eew", priority: "high", deferKind: "long", deferUntil: 999 })],
    });
    const out = purgeJobs(s, isTip, 1000);
    expect(out.queue.map((j) => j.key)).toEqual(["vpww"]);
    expect(out.deferred.map((j) => j.key)).toEqual(["eew"]);
  });

  it("fading 中 (tip current + 割込んできた非 tip replacement) は replacement を即時 running へ昇格する (Codex critical: current null 化だと fading が永久停止)", () => {
    const fadingLane: LaneState = {
      phase: "fading",
      current: job({ key: "tip-4", kind: "tip", priority: "low" }), // 退場中の tip
      replacement: job({ key: "eew", priority: "high", groupKey: "g-eew" }), // 割込んできた EEW (非 tip)
      coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: 0, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 2, completedGeneration: 0,
    };
    const out = purgeJobs(stateWith({ lanes: [fadingLane, idleLane()] }), isTip, 5000);
    // replacement(EEW) が current へ即時昇格し running になる。fading のまま止まらない
    expect(out.lanes[0]!.phase).toBe("running");
    expect(out.lanes[0]!.current?.key).toBe("eew");
    expect(out.lanes[0]!.replacement).toBeNull();
    expect(out.lanes[0]!.generation).toBe(3); // 2 → +1 (新要素として {#key} 再生成)
    expect(out.lanes[0]!.currentStartedAt).toBe(5000);
    expect(out.lanes[0]!.highSliceStartedAt).toBe(5000); // high 昇格で量子を張り直す
    expect(out.lastShownAt["eew"]).toBe(5000);
    // 退場した tip はどこにも退避されない (deferred/queue 無し)
    expect(out.deferred).toHaveLength(0);
    expect(out.queue).toHaveLength(0);
  });

  it("fading の replacement 自体が tip なら退場中 current ごとレーンを idle 化する", () => {
    const fadingLane: LaneState = {
      phase: "fading",
      current: job({ key: "wx", priority: "low" }), // 退場中の電文
      replacement: job({ key: "tip-5", kind: "tip", priority: "low" }), // 割込み先が tip (通常は起きないが防御的に)
      coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 4, completedGeneration: 0,
    };
    const out = purgeJobs(stateWith({ lanes: [fadingLane, idleLane()] }), isTip, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
    expect(out.lanes[0]!.current).toBeNull();
    expect(out.lanes[0]!.replacement).toBeNull();
    expect(out.lanes[0]!.generation).toBe(5);
  });

  it("対象 tip が居なければ入力 state をそのまま返す (参照不変)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "wx", priority: "low" })), idleLane()],
      queue: [job({ key: "vpww", priority: "mid" })],
    });
    expect(purgeJobs(s, isTip, 1000)).toBe(s);
  });
});

describe("tip 排他割当 (2026-07-14 フィラー排他化 v2)", () => {
  const tip = (over: Partial<TickerJob> & { key: string }): TickerJob => job({ kind: "tip", priority: "low", ...over });

  it("電文 (非 tip) が current で走行中は tip をレーンへ載せない (queue に居ても待つ)", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "wx", priority: "low" })), idleLane()],
      queue: [tip({ key: "tip-1" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(false);
    expect(state.queue.some((j) => j.key === "tip-1")).toBe(true); // 待機のまま
  });

  it("電文が replacement (fading の割込み先) に居る間も tip を載せない", () => {
    const fading: LaneState = {
      phase: "fading", current: job({ key: "old", priority: "low" }),
      replacement: job({ key: "hi", priority: "high" }), coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: 0, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 3, completedGeneration: 0,
    };
    const s = stateWith({ lanes: [fading, idleLane()], queue: [tip({ key: "tip-1" })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(false);
    expect(state.queue.some((j) => j.key === "tip-1")).toBe(true);
  });

  it("電文が coalescedRevision に居る間も tip を載せない", () => {
    const lane = runningLane(job({ key: "wx", groupKey: "g", priority: "low" }), 2);
    lane.coalescedRevision = { ...job({ key: "wx2", groupKey: "g", priority: "low" }), revisionAt: null };
    const s = stateWith({ lanes: [lane, idleLane()], queue: [tip({ key: "tip-1" })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[1]!.current?.key).not.toBe("tip-1");
    expect(state.queue.some((j) => j.key === "tip-1")).toBe(true);
  });

  it("電文が queue で待機中 (未割当) の間も tip を載せない", () => {
    // 両レーン idle だが queue に電文 low が居る → tip は電文が捌けるまで待つ
    const s = stateWith({
      lanes: [idleLane(), idleLane()],
      queue: [tip({ key: "tip-1", seq: 1 }), job({ key: "wx", priority: "low", seq: 2 })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "wx")).toBe(true); // 電文は載る
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(false); // tip は載らない
    expect(state.queue.some((j) => j.key === "tip-1")).toBe(true);
  });

  it("電文が deferred で保留中の間も tip を載せない", () => {
    const s = stateWith({
      lanes: [idleLane(), idleLane()],
      deferred: [job({ key: "wx", priority: "low", deferKind: "long", deferUntil: 999999 })],
      queue: [tip({ key: "tip-1" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(false);
    expect(state.queue.some((j) => j.key === "tip-1")).toBe(true);
  });

  it("電文が全部掃けたら tip がレーンへ載る (queue の tip)", () => {
    const s = stateWith({ lanes: [idleLane(), idleLane()], queue: [tip({ key: "tip-1" })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(true);
  });

  it("電文が全部掃けたら tip が巡回補充される (catalog の tip)", () => {
    const s = stateWith({ lanes: [idleLane(), idleLane()], catalog: [tip({ key: "tip-1" })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes.some((l) => l.current?.key === "tip-1")).toBe(true);
  });

  it("電文が居る間は巡回補充でも tip を載せない", () => {
    const s = stateWith({
      lanes: [runningLane(job({ key: "wx", priority: "low" })), idleLane()],
      catalog: [tip({ key: "tip-1" })],
    });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[1]!.phase).toBe("idle"); // idle 側に tip を補充しない
  });

  it("走行中の tip は電文到着で中断しない (tip 完走・電文は空きレーンへ)", () => {
    // lane1 に tip 走行中、lane0 idle。電文 low が enqueue されたら lane0 へ、tip は lane1 で継続
    const tipLane = runningLane(tip({ key: "tip-1" }), 4);
    const s = stateWith({ lanes: [idleLane(), tipLane], queue: [job({ key: "wx", priority: "low", seq: 9 })] });
    const { state } = assignLanes(s, 1000);
    expect(state.lanes[1]!.current?.key).toBe("tip-1"); // tip は中断せず走行継続
    expect(state.lanes[1]!.phase).toBe("running");
    expect(state.lanes[0]!.current?.key).toBe("wx"); // 電文は空きレーンへ即入る
  });

  it("hasNonTipActivity: 非 tip が current/replacement/coalescedRevision/queue/deferred のどこかに居れば true", () => {
    expect(hasNonTipActivity(stateWith({ lanes: [runningLane(job({ key: "wx" })), idleLane()] }))).toBe(true);
    expect(hasNonTipActivity(stateWith({ queue: [job({ key: "wx", priority: "mid" })] }))).toBe(true);
    expect(hasNonTipActivity(stateWith({ deferred: [job({ key: "wx", deferKind: "quiet" })] }))).toBe(true);
    // tip のみなら false
    expect(hasNonTipActivity(stateWith({ lanes: [runningLane(tip({ key: "tip-1" })), idleLane()], queue: [tip({ key: "tip-2" })] }))).toBe(false);
    expect(hasNonTipActivity(stateWith({}))).toBe(false); // 空
  });
});

describe("hasAlertActivity (spec D5 サスペンド判定)", () => {
  it("空のスケジューラは false", () => {
    expect(hasAlertActivity(stateWith({}))).toBe(false);
  });

  it("気象通常警報 (role=weatherWarning, priority=mid) が queue にあれば true (mid でも意味は警報級)", () => {
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "w1", role: "weatherWarning", priority: "mid" })] }))).toBe(true);
  });

  it("注意報 (role=weatherAdvisory) だけなら false", () => {
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "a1", role: "weatherAdvisory", priority: "mid" })] }))).toBe(false);
  });

  it("tip ジョブは role に関わらず対象外", () => {
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "t1", kind: "tip", role: "weatherWarning" })] }))).toBe(false);
  });

  it("取消 (isCancellation) は対象外", () => {
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "c1", role: "weatherWarning", isCancellation: true })] }))).toBe(false);
  });

  it("5 つの掲載状態 (current/replacement/coalescedRevision/queue/deferred) それぞれで true", () => {
    // current
    expect(hasAlertActivity(stateWith({ lanes: [runningLane(job({ key: "w1", role: "weatherWarning" })), idleLane()] }))).toBe(true);
    // replacement (fading の割込み先)
    const fading: LaneState = {
      phase: "fading", current: job({ key: "old", priority: "low" }),
      replacement: job({ key: "w2", role: "weatherWarning" }), coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: 0, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 3, completedGeneration: 0,
    };
    expect(hasAlertActivity(stateWith({ lanes: [fading, idleLane()] }))).toBe(true);
    // coalescedRevision
    const lane = runningLane(job({ key: "wx", groupKey: "g", priority: "low" }), 2);
    lane.coalescedRevision = { ...job({ key: "w3", groupKey: "g", role: "weatherWarning" }), revisionAt: null };
    expect(hasAlertActivity(stateWith({ lanes: [lane, idleLane()] }))).toBe(true);
    // queue
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "w4", role: "weatherWarning" })] }))).toBe(true);
    // deferred
    expect(hasAlertActivity(stateWith({ deferred: [job({ key: "w5", role: "weatherWarning", deferKind: "quiet" })] }))).toBe(true);
  });

  it("取消は 5 つの掲載状態すべてで false", () => {
    expect(
      hasAlertActivity(stateWith({ lanes: [runningLane(job({ key: "c1", role: "weatherWarning", isCancellation: true })), idleLane()] })),
    ).toBe(false);
    const fading: LaneState = {
      phase: "fading", current: job({ key: "old", priority: "low" }),
      replacement: job({ key: "c2", role: "weatherWarning", isCancellation: true }), coalescedRevision: null,
      currentStartedAt: 0, highSliceStartedAt: 0, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
      generation: 3, completedGeneration: 0,
    };
    expect(hasAlertActivity(stateWith({ lanes: [fading, idleLane()] }))).toBe(false);
    const lane = runningLane(job({ key: "wx", groupKey: "g", priority: "low" }), 2);
    lane.coalescedRevision = { ...job({ key: "c3", groupKey: "g", role: "weatherWarning", isCancellation: true }), revisionAt: null };
    expect(hasAlertActivity(stateWith({ lanes: [lane, idleLane()] }))).toBe(false);
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "c4", role: "weatherWarning", isCancellation: true })] }))).toBe(false);
    expect(
      hasAlertActivity(stateWith({ deferred: [job({ key: "c5", role: "weatherWarning", isCancellation: true, deferKind: "quiet" })] })),
    ).toBe(false);
  });

  it("未知 role (someFutureRole) は true (fail-bright)", () => {
    const unknownRole = "someFutureRole" as DisplayColorRole;
    expect(hasAlertActivity(stateWith({ queue: [job({ key: "u1", role: unknownRole })] }))).toBe(true);
  });

  it("警報 job が完走して idle 化した後は false に戻る (onLineComplete 経由)", () => {
    const j = job({
      key: "w1", role: "weatherWarning", segments: ["a"],
      runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }],
    });
    const s = stateWith({ lanes: [runningLane(j, 2), idleLane()] });
    expect(hasAlertActivity(s)).toBe(true);
    const out = onLineComplete(s, 0, 2, 1000);
    expect(out.lanes[0]!.phase).toBe("idle");
    expect(out.lanes[0]!.current).toBeNull();
    expect(hasAlertActivity(out)).toBe(false);
  });
});

describe("津波 replay (kind=replay) の純関数サポート", () => {
  const replay = (over: Partial<TickerJob> & { key: string }): TickerJob =>
    job({ kind: "replay", priority: "low", groupKey: "replay:tsunami:warning", replayGeneration: 1, ...over });

  it("toTickerJob: dto.replayGeneration を job に写す (kind!=replay の DTO では未設定)", () => {
    const dto = { ...tickerEvent({ id: "r", tickerSentence: "本文" }), kind: "replay" as const, replayGeneration: 9 };
    expect(toTickerJob(dto, 1).replayGeneration).toBe(9);
    // replayGeneration を持たない通常電文は undefined
    expect(toTickerJob(tickerEvent({ id: "e", tickerSentence: "本文" }), 1).replayGeneration).toBeUndefined();
  });

  it("hasActiveReplay: 同 groupKey の replay が lane/queue/deferred のどこかに居れば true", () => {
    const gk = "replay:tsunami:warning";
    expect(hasActiveReplay(stateWith({ lanes: [runningLane(replay({ key: "r1" })), idleLane()] }), gk)).toBe(true);
    expect(hasActiveReplay(stateWith({ queue: [replay({ key: "r2" })] }), gk)).toBe(true);
    expect(hasActiveReplay(stateWith({ deferred: [replay({ key: "r3", deferKind: "quiet" })] }), gk)).toBe(true);
    // 別 groupKey (別レベル) は連打ガードにかからない
    expect(hasActiveReplay(stateWith({ queue: [replay({ key: "r4", groupKey: "replay:tsunami:advisory" })] }), gk)).toBe(false);
    // tip や電文は replay ではない
    expect(hasActiveReplay(stateWith({ lanes: [runningLane(job({ key: "wx", groupKey: gk })), idleLane()] }), gk)).toBe(false);
    expect(hasActiveReplay(stateWith({}), gk)).toBe(false);
  });

  it("purgeJobs: 世代不一致の replay を除去し、一致する replay と非 replay は残す", () => {
    const s = stateWith({
      lanes: [runningLane(replay({ key: "stale", replayGeneration: 1 }), 3), idleLane()],
      queue: [
        replay({ key: "fresh", replayGeneration: 2, seq: 1 }),
        job({ key: "wx", priority: "mid", seq: 2 }), // 非 replay は無関係
      ],
    });
    const purged = purgeJobs(s, (j) => j.kind === "replay" && j.replayGeneration !== 2, 1000);
    // 走行中の stale replay は idle 化される (即時停止)
    expect(purged.lanes[0]!.phase).toBe("idle");
    expect(purged.lanes[0]!.current).toBeNull();
    // 世代一致の fresh replay と電文は queue に残る
    expect(purged.queue.map((j) => j.key).sort()).toEqual(["fresh", "wx"]);
  });

  it("hasNonTipActivity: replay ジョブは非 tip として活動扱い (走行中は tip を止める根拠になる)", () => {
    expect(hasNonTipActivity(stateWith({ lanes: [runningLane(replay({ key: "r1" })), idleLane()] }))).toBe(true);
    expect(hasNonTipActivity(stateWith({ queue: [replay({ key: "r2" })] }))).toBe(true);
  });
});
