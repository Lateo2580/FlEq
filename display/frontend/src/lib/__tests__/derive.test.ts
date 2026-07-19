import { describe, expect, it } from "vitest";
import { deriveEmergencyPanels, deriveMode, deriveTickerLines } from "../derive";
import type { DisplayActiveEewV1, DisplayLargeQuakeStateV1, DisplayTsunamiStateV1 } from "../protocol";
import type { DisplayClientState } from "../store";
import { baseState, tickerEvent } from "./fixtures";
import { assignLanes, enqueueJob, toTickerJob, type LaneState, type SchedulerState } from "../ticker-schedule";

function runningLowLane(key: string): LaneState {
  return {
    phase: "running",
    current: {
      key, groupKey: null, seq: 1, kind: "event", priority: "low", role: "info", category: null, subject: null,
      segments: ["低優先本文"], segmentEmphasis: [[]], runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }], runIndex: 0,
      segmentIndex: 0, retryCount: 0, deferUntil: null, deferKind: null,
      revisionAt: null, isCancellation: false,
    },
    replacement: null, coalescedRevision: null,
    currentStartedAt: 0, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
    generation: 1, completedGeneration: 0,
  };
}

function stateWith(over: Partial<SchedulerState>): SchedulerState {
  return {
    lanes: over.lanes ?? [], queue: over.queue ?? [], deferred: over.deferred ?? [],
    quietSince: over.quietSince ?? null, cyclePos: over.cyclePos ?? 0, catalog: over.catalog ?? [],
    lastShownAt: over.lastShownAt ?? {},
  };
}

function eewFixture(over: Partial<DisplayActiveEewV1> = {}): DisplayActiveEewV1 {
  return {
    kind: "eew", eventId: "E1", serial: "1", isWarning: true, isFinal: false, isCancellation: false,
    hypocenterName: null, forecastMaxInt: null, forecastMaxIntRank: null, magnitude: null,
    colorIndex: null, reportDateTime: "t", updatedAtMs: 0,
    isAssumedHypocenter: false, depth: null, maxLgInt: null, regions: [],
    ...over,
  };
}

function tsunamiFixture(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami", level: "warning", levelLabel: "津波警報", coasts: [], reportDateTime: "t",
    warningComment: null, observations: [], demoted: false, updatedAtMs: 0,
    ...over,
  };
}

function largeQuakeFixture(over: Partial<DisplayLargeQuakeStateV1> = {}): DisplayLargeQuakeStateV1 {
  return {
    kind: "largeQuake", eventId: "Q1", originTime: null, hypocenterName: null, magnitude: null,
    maxInt: "5強", maxIntRank: 6, intensityGroups: [], reportDateTime: "t", updatedAtMs: 0,
    depth: null, maxLgInt: null, tsunamiWarning: false,
    ...over,
  };
}

describe("deriveMode", () => {
  it("⑤ activeEews が 1 件あれば emergency", () => {
    const state = baseState({ activeEews: [eewFixture()] });
    expect(deriveMode(state)).toBe("emergency");
  });

  it("⑥ tsunami が demoted のみなら standby", () => {
    const state = baseState({
      tsunami: tsunamiFixture({ demoted: true }),
    });
    expect(deriveMode(state)).toBe("standby");
  });

  it("snapshot が null なら standby", () => {
    expect(deriveMode({
      snapshot: null, ticker: [], sseConnected: false, lastSeq: 0, lastEventSeq: 0, seqGapDetected: false, tickerGeneration: 0,
    })).toBe("standby");
  });
});

describe("deriveEmergencyPanels", () => {
  it("⑦ 優先順位: 津波 (大津波>津波警報>注意報) > EEW (警報>予報) > largeQuake の順に並ぶ (津波は常に主役)", () => {
    const state = baseState({
      tsunami: tsunamiFixture({ demoted: false }),
      activeEews: [
        eewFixture({ eventId: "E1", serial: "1", isWarning: true }),
        eewFixture({ eventId: "E2", serial: "1", isWarning: false }),
      ],
      largeQuakes: [largeQuakeFixture({ eventId: "Q1" })],
    });
    // 大津波警報は snapshot.tsunami を上書きして別ケースで検証する (同時に 1 つしか持てないため)
    const majorState = baseState({
      tsunami: tsunamiFixture({ level: "majorWarning", levelLabel: "大津波警報", demoted: false }),
      activeEews: state.snapshot!.activeEews,
      largeQuakes: state.snapshot!.largeQuakes,
    });
    const panels = deriveEmergencyPanels(majorState);
    expect(panels.map((p) => p.key)).toEqual(["tsunami:current", "eew:E1", "eew:E2", "quake:Q1"]);

    // 津波警報でも EEW 警報より先頭 (津波常時主役への変更、2026-07-13)。EEW 警報 > EEW 予報 は維持
    const panels2 = deriveEmergencyPanels(state);
    expect(panels2.map((p) => p.key)).toEqual(["tsunami:current", "eew:E1", "eew:E2", "quake:Q1"]);
  });

  // 津波常時主役化のエッジ (ユーザー決定 2026-07-13): 津波注意報 (最も弱い津波) と EEW 警報 (最も強い
  // EEW) が共存しても、津波が主役 (左列)・EEW 警報が右 compact になる。旧序列では EEW 警報が先頭だった。
  it("津波注意報 + EEW警報 の共存でも津波が先頭 (主役) になる", () => {
    const state = baseState({
      tsunami: tsunamiFixture({ level: "advisory", levelLabel: "津波注意報", demoted: false }),
      activeEews: [eewFixture({ eventId: "E1", serial: "1", isWarning: true })],
    });
    const keys = deriveEmergencyPanels(state).map((p) => p.key);
    expect(keys).toEqual(["tsunami:current", "eew:E1"]);
  });

  it("eventId が null のパネルが複数あっても key が重複しない", () => {
    const state = baseState({
      activeEews: [
        eewFixture({ eventId: null, serial: "1", isWarning: false }),
        eewFixture({ eventId: null, serial: "2", isWarning: false }),
      ],
      largeQuakes: [
        largeQuakeFixture({ eventId: null, maxInt: "5強" }),
        largeQuakeFixture({ eventId: null, maxInt: "6弱" }),
      ],
    });
    const keys = deriveEmergencyPanels(state).map((p) => p.key);
    expect(keys.length).toBe(4);
    expect(new Set(keys).size).toBe(keys.length); // Svelte keyed each の重複 key クラッシュ予防
  });

  it("demoted な津波はパネルに含まれない", () => {
    const state = baseState({
      tsunami: tsunamiFixture({ demoted: true }),
    });
    expect(deriveEmergencyPanels(state)).toEqual([]);
  });
});

describe("deriveTickerLines", () => {
  it("⑧ 緊急パネル表示中の groupKey の行を除外し、demoted 津波の行は除外しない", () => {
    const state: DisplayClientState = baseState({
      activeEews: [eewFixture({ eventId: "E1", serial: "1", isWarning: true })],
      tsunami: tsunamiFixture({ demoted: true }),
      ticker: [
        tickerEvent({ id: "a", groupKey: "eew:E1" }),
        tickerEvent({ id: "b", groupKey: "tsunami" }),
        tickerEvent({ id: "c", groupKey: null }),
      ],
    });
    const lines = deriveTickerLines(state);
    expect(lines.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("代表 high (active EEW と同 groupKey) は除外せずテロップへ届ける (Critical 1)", () => {
    const state: DisplayClientState = baseState({
      activeEews: [eewFixture({ eventId: "E1", serial: "1", isWarning: true })],
      ticker: [
        tickerEvent({ id: "hi", groupKey: "eew:E1", tickerPriority: "high" }),
        tickerEvent({ id: "lo", groupKey: "weatherExplanation:W1", tickerPriority: "low" }),
      ],
    });
    const lines = deriveTickerLines(state);
    expect(lines.map((e) => e.id)).toContain("hi"); // high は active groupKey でも残る
  });

  it("届いた high が実際に low レーンを fading で割込む (derive→scheduler 統合)", () => {
    const state: DisplayClientState = baseState({
      activeEews: [eewFixture({ eventId: "E1", isWarning: true })],
      ticker: [tickerEvent({ id: "hi", eventKey: "eew:E1:1", groupKey: "eew:E1", tickerPriority: "high", tickerSentence: "緊急地震速報" })],
    });
    const hiLine = deriveTickerLines(state).find((e) => e.id === "hi")!;
    // 両レーン low 走行中に high を投入 → assignLanes で片方が fading
    let sched = stateWith({
      lanes: [runningLowLane("lowA"), runningLowLane("lowB")],
    });
    sched = enqueueJob(sched, toTickerJob(hiLine, 1), 1000);
    const { state: next } = assignLanes(sched, 1000);
    const fading = next.lanes.find((l) => l.phase === "fading");
    expect(fading).toBeTruthy();
    expect(fading!.replacement?.priority).toBe("high");
  });
});
