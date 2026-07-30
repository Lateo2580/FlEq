import { describe, expect, it } from "vitest";
import { deriveEmergencyPanels, deriveMode, deriveTickerLines } from "../derive";
import type {
  DisplayActiveEewV1,
  DisplayLargeQuakeStateV1,
  DisplayQuakeMapEventV1,
  DisplayStateSnapshotV1,
  DisplayTsunamiStateV1,
  DisplayWeatherAlertV1,
} from "../protocol";
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
      revisionAt: null, isCancellation: false, tipPolicy: null, tipHazards: [], surface: "none",
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
    lastShownAt: over.lastShownAt ?? {}, emergencyCompanion: { sessionId: "none", enabled: false, hazards: [] },
    companionShown: 0, companionLastShownAt: null,
  };
}

function eewFixture(over: Partial<DisplayActiveEewV1> = {}): DisplayActiveEewV1 {
  return {
    kind: "eew", eventId: "E1", serial: "1", isWarning: true, isFinal: false, isCancellation: false,
    hypocenterName: null, forecastMaxInt: null, forecastMaxIntRank: null, magnitude: null,
    colorIndex: null, reportDateTime: "t", originTime: null, updatedAtMs: 0,
    isAssumedHypocenter: false, depth: null, maxLgInt: null, regions: [],
    ...over,
  };
}

function tsunamiFixture(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami", level: "warning", levelLabel: "津波警報", coasts: [], reportDateTime: "t",
    warningComment: null, observations: [], updatedAtMs: 0,
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

function quakeMapFixture(over: Partial<DisplayQuakeMapEventV1> = {}): DisplayQuakeMapEventV1 {
  return {
    eventKey: "earthquake:Q1",
    eventId: "Q1",
    sourceType: "VXSE53",
    revision: { reportTimeMs: 100, serial: "2" },
    reportDateTime: "t",
    originTime: null,
    hypocenterName: null,
    depth: null,
    magnitude: null,
    maxInt: "5強",
    maxIntRank: 6,
    tsunamiWarning: false,
    intensityGroups: [],
    localAreas: [{ code: "440", rank: 6 }],
    updatedAtMs: 100,
    ...over,
  };
}

function weatherAlertFixture(
  source: "vpws50" | "vpww56",
  kind: string,
  displaySeverity: string,
): DisplayWeatherAlertV1 {
  return {
    source,
    label: "気象警報",
    role: displaySeverity === "officialL5" ? "weatherEmergency" : "weatherWarning",
    totalAreas: 1,
    items: [{ kind, displaySeverity, rank: "emergency", shownAreas: ["東京都"], omittedAreaCount: 0 }],
    updatedAt: "2026-07-25T10:00:00+09:00",
  };
}

/** vpws50 だけを level 相当で昇格させた snapshot 断片 */
function weatherPromotion(level: 4 | 5): Partial<DisplayStateSnapshotV1> {
  return {
    weatherPromotion: { vpws50: { level, promotedAt: "2026-07-25T10:00:00+09:00", generation: 1 }, vpww56: null },
    weatherAlerts: [
      weatherAlertFixture("vpws50", level === 5 ? "L5 大雨特別警報" : "L4 洪水警報", level === 5 ? "officialL5" : "officialL4"),
    ],
  };
}

describe("deriveMode", () => {
  it("⑤ activeEews が 1 件あれば emergency", () => {
    const state = baseState({ activeEews: [eewFixture()] });
    expect(deriveMode(state)).toBe("emergency");
  });

  it("⑥ 継続中の tsunami のみなら emergency", () => {
    expect(deriveMode(baseState({ tsunami: tsunamiFixture() }))).toBe("emergency");
  });

  it("snapshot が null なら standby", () => {
    expect(deriveMode({
      snapshot: null, ticker: [], sseConnected: false, lastSeq: 0, lastEventSeq: 0, seqGapDetected: false, tickerGeneration: 0,
    })).toBe("standby");
  });
});

describe("deriveEmergencyPanels", () => {
  it("largeQuake と map event を eventKey/sourceType/revision 完全一致で結合する", () => {
    const revision = { reportTimeMs: 100, serial: "2" };
    const quake = largeQuakeFixture({
      eventId: "Q1",
      mapEventKey: "earthquake:Q1",
      mapSourceType: "VXSE53",
      mapRevision: revision,
    });
    const map = quakeMapFixture({ revision });
    const [panel] = deriveEmergencyPanels(baseState({
      largeQuakes: [quake],
      mapLayers: { quake: { events: [map], nonEmergencyHost: null } },
    }));
    expect(panel?.quakeMap).toBe(map);
    expect(panel?.quakeMap?.localAreas).toEqual([{ code: "440", rank: 6 }]);
  });

  it.each([
    ["eventKey", quakeMapFixture({ eventKey: "earthquake:other" })],
    ["sourceType", quakeMapFixture({ sourceType: "VXSE51" })],
    ["reportTimeMs", quakeMapFixture({ revision: { reportTimeMs: 101, serial: "2" } })],
    ["serial", quakeMapFixture({ revision: { reportTimeMs: 100, serial: "3" } })],
  ])("%s 不一致では地図を結合しない", (_label, map) => {
    const quake = largeQuakeFixture({
      mapEventKey: "earthquake:Q1",
      mapSourceType: "VXSE53",
      mapRevision: { reportTimeMs: 100, serial: "2" },
    });
    const [panel] = deriveEmergencyPanels(baseState({
      largeQuakes: [quake],
      mapLayers: { quake: { events: [map], nonEmergencyHost: null } },
    }));
    expect(panel?.quakeMap).toBeUndefined();
    expect(panel?.input).toBe(quake);
  });

  it("mapLayers 欠落でも既存 largeQuake パネルを維持する", () => {
    const quake = largeQuakeFixture({
      mapEventKey: "earthquake:Q1",
      mapSourceType: "VXSE53",
      mapRevision: { reportTimeMs: 100, serial: "2" },
    });
    const [panel] = deriveEmergencyPanels(baseState({ largeQuakes: [quake] }));
    expect(panel?.input).toBe(quake);
    expect(panel?.quakeMap).toBeUndefined();
  });

  it("legacy server の demoted tsunami は主役パネルから除外する", () => {
    const legacyTsunami = {
      ...tsunamiFixture(),
      demoted: true,
    } as DisplayTsunamiStateV1 & { demoted: true };
    expect(deriveEmergencyPanels(baseState({ tsunami: legacyTsunami }))).toEqual([]);
  });

  it("demoted が欠落した tsunami は主役パネルに表示する", () => {
    expect(deriveEmergencyPanels(baseState({ tsunami: tsunamiFixture() })).map((p) => p.key))
      .toEqual(["tsunami:current"]);
  });

  it("⑦ 優先順位: 津波 (大津波>津波警報>注意報) > EEW (警報>予報) > largeQuake の順に並ぶ (津波は常に主役)", () => {
    const state = baseState({
      tsunami: tsunamiFixture(),
      activeEews: [
        eewFixture({ eventId: "E1", serial: "1", isWarning: true }),
        eewFixture({ eventId: "E2", serial: "1", isWarning: false }),
      ],
      largeQuakes: [largeQuakeFixture({ eventId: "Q1" })],
    });
    // 大津波警報は snapshot.tsunami を上書きして別ケースで検証する (同時に 1 つしか持てないため)
    const majorState = baseState({
      tsunami: tsunamiFixture({ level: "majorWarning", levelLabel: "大津波警報" }),
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
      tsunami: tsunamiFixture({ level: "advisory", levelLabel: "津波注意報" }),
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

  it("同種の複数 EEW は予測最大震度、M、発生時刻、eventId の順で安定整列する", () => {
    const state = baseState({
      activeEews: [
        eewFixture({ eventId: "E-late", forecastMaxIntRank: 6, magnitude: "6.0", originTime: "2026-07-29T10:01:00+09:00" }),
        eewFixture({ eventId: "E-strong", forecastMaxIntRank: 7, magnitude: "5.0", originTime: "2026-07-29T10:02:00+09:00" }),
        eewFixture({ eventId: "E-magnitude", forecastMaxIntRank: 6, magnitude: "7.0", originTime: "2026-07-29T10:03:00+09:00" }),
      ],
    });
    expect(deriveEmergencyPanels(state).map((panel) => panel.key)).toEqual(["eew:E-strong", "eew:E-magnitude", "eew:E-late"]);
  });

  it("非数値 magnitude は最劣後とし、同値なら後続 tie-break へ進む", () => {
    const state = baseState({
      activeEews: [
        eewFixture({ eventId: "E-invalid-late", forecastMaxIntRank: 6, magnitude: "不明", originTime: "2026-07-29T10:02:00+09:00" }),
        eewFixture({ eventId: "E-valid", forecastMaxIntRank: 6, magnitude: "6.0", originTime: "2026-07-29T10:03:00+09:00" }),
        eewFixture({ eventId: "E-invalid-early", forecastMaxIntRank: 6, magnitude: "-", originTime: "2026-07-29T10:01:00+09:00" }),
      ],
    });

    expect(deriveEmergencyPanels(state).map((panel) => panel.key)).toEqual([
      "eew:E-valid",
      "eew:E-invalid-early",
      "eew:E-invalid-late",
    ]);
  });

  it("空・空白だけの magnitude は M0 ではなく最劣後として扱う", () => {
    const state = baseState({
      activeEews: [
        eewFixture({ eventId: "E-whitespace", forecastMaxIntRank: 6, magnitude: "   ", originTime: "2026-07-29T10:02:00+09:00" }),
        eewFixture({ eventId: "E-zero", forecastMaxIntRank: 6, magnitude: "0", originTime: "2026-07-29T10:03:00+09:00" }),
        eewFixture({ eventId: "E-empty", forecastMaxIntRank: 6, magnitude: "", originTime: "2026-07-29T10:01:00+09:00" }),
      ],
    });

    expect(deriveEmergencyPanels(state).map((panel) => panel.key)).toEqual([
      "eew:E-zero",
      "eew:E-empty",
      "eew:E-whitespace",
    ]);
  });

  // ── Spec C Phase 2: 気象警報の主役化 ──

  it("気象 L5/L4 は 1 枚に畳まれ、他の緊急カードの末尾に置かれる", () => {
    const state = baseState({
      tsunami: tsunamiFixture({ level: "advisory", levelLabel: "津波注意報" }),
      activeEews: [
        eewFixture({ eventId: "E1", isWarning: true }),
        eewFixture({ eventId: "E2", isWarning: false }),
      ],
      largeQuakes: [largeQuakeFixture({ eventId: "Q1" })],
      ...weatherPromotion(5),
    });
    const keys = deriveEmergencyPanels(state).map((p) => p.key);
    expect(keys).toEqual(["tsunami:current", "eew:E1", "eew:E2", "quake:Q1", "weather:current"]);
  });

  it("気象 L4 も EEW 予報より後に置く", () => {
    const state = baseState({
      activeEews: [eewFixture({ eventId: "E2", isWarning: false })],
      ...weatherPromotion(4),
    });
    expect(deriveEmergencyPanels(state).map((p) => p.key)).toEqual(["eew:E2", "weather:current"]);
  });

  it("津波・EEW・気象・震度カードが同時でも気象を末尾に置く", () => {
    const state = baseState({
      tsunami: tsunamiFixture(),
      activeEews: [eewFixture({ eventId: "E1" })],
      largeQuakes: [largeQuakeFixture({ eventId: "Q1" })],
      ...weatherPromotion(5),
    });
    expect(deriveEmergencyPanels(state).map((p) => p.key))
      .toEqual(["tsunami:current", "eew:E1", "quake:Q1", "weather:current"]);
  });

  it("気象パネルは source が増減しても key 固定 (weather:current) で 1 枚のまま", () => {
    const one = baseState(weatherPromotion(5));
    const both = baseState({
      weatherPromotion: {
        vpws50: { level: 5, promotedAt: "t", generation: 1 },
        vpww56: { level: 4, promotedAt: "t", generation: 1 },
      },
      weatherAlerts: [
        weatherAlertFixture("vpws50", "L5 大雨特別警報", "officialL5"),
        weatherAlertFixture("vpww56", "L4 洪水警報", "officialL4"),
      ],
    });
    expect(deriveEmergencyPanels(one).map((p) => p.key)).toEqual(["weather:current"]);
    expect(deriveEmergencyPanels(both).map((p) => p.key)).toEqual(["weather:current"]);
  });

  it("複数 EEW・複数震度カードと L5/L4 併存時も weather:current が末尾", () => {
    const state = baseState({
      activeEews: [eewFixture({ eventId: "E1" }), eewFixture({ eventId: "E2", isWarning: false })],
      largeQuakes: [largeQuakeFixture({ eventId: "Q1" }), largeQuakeFixture({ eventId: "Q2" })],
      weatherPromotion: {
        vpws50: { level: 5, promotedAt: "t", generation: 1 },
        vpww56: { level: 4, promotedAt: "t", generation: 1 },
      },
      weatherAlerts: [
        weatherAlertFixture("vpws50", "L5 大雨特別警報", "officialL5"),
        weatherAlertFixture("vpww56", "L4 洪水警報", "officialL4"),
      ],
    });

    expect(deriveEmergencyPanels(state).map((p) => p.key))
      .toEqual(["eew:E1", "eew:E2", "quake:Q1", "quake:Q2", "weather:current"]);
  });

  it("weatherPromotion が両 source null (demoted 含む) なら気象パネルは出ない = standby", () => {
    const state = baseState({
      weatherPromotion: { vpws50: null, vpww56: null },
      weatherAlerts: [weatherAlertFixture("vpws50", "L5 大雨特別警報", "officialL5")],
    });
    expect(deriveEmergencyPanels(state)).toEqual([]);
    expect(deriveMode(state)).toBe("standby");
  });

  it("weatherPromotion 欠落 (旧サーバ) は null 扱いで従来どおり standby", () => {
    const state = baseState({
      weatherAlerts: [weatherAlertFixture("vpws50", "L5 大雨特別警報", "officialL5")],
    });
    expect(deriveMode(state)).toBe("standby");
  });

  it("気象昇格だけでも emergency になる", () => {
    expect(deriveMode(baseState(weatherPromotion(5)))).toBe("emergency");
  });
});

describe("deriveTickerLines", () => {
  it("届いた high が実際に low レーンを fading で割込む (derive→scheduler 統合)", () => {
    const state: DisplayClientState = baseState({
      ticker: [tickerEvent({ id: "hi", eventKey: "quake:Q1:1", groupKey: "quake:Q1", tickerPriority: "high", tickerSentence: "地震情報" })],
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
