import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectDisplayEvent, projectQuakeMapCommand } from "../../../src/engine/display/project-event";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";
import { createMockWsDataMessageFromXml, readFixture } from "../../helpers/mock-message";
import { notifyMock } from "../../setup";

const FIXTURES = {
  eewSpecial: { fixture: "synthetic_phase4a_VXSE45_special.xml", type: "VXSE45" },
  eewRegionless: { fixture: "synthetic_phase4a_VXSE45_regionless.xml", type: "VXSE45" },
  quakeQualitative: { fixture: "synthetic_phase4a_VXSE51_special.xml", type: "VXSE51" },
  quakeDetailed: { fixture: "synthetic_phase4a_VXSE53_special.xml", type: "VXSE53" },
  quakeMissing: { fixture: "synthetic_phase4a_VXSE61_special.xml", type: "VXSE61" },
  lgUnknown: { fixture: "synthetic_phase4a_VXSE62_special.xml", type: "VXSE62" },
} as const;

type Phase4AFixture = typeof FIXTURES[keyof typeof FIXTURES];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function linearOutcome(outcome: ProcessOutcome | { domain: "volcano"; sources: unknown[] }): ProcessOutcome {
  if (outcome.domain === "volcano" && "sources" in outcome) {
    throw new Error("Phase 4A fixture unexpectedly entered volcano batch output");
  }
  return outcome;
}

function notificationMessage(): string {
  const first = notifyMock.mock.calls[0]?.[0] as { message?: unknown } | undefined;
  return typeof first?.message === "string" ? first.message : "";
}

function runFixture(spec: Phase4AFixture) {
  notifyMock.mockClear();
  const message = createMockWsDataMessageFromXml(readFixture(spec.fixture), spec.type);
  const outcomes: ProcessOutcome[] = [];
  const events: import("../../../src/engine/presentation/types").PresentationEvent[] = [];
  const revisionGate = new TelegramRevisionGate();
  const runtime = createMessageHandler({
    revisionGate,
    outcomeTaps: [(candidate) => outcomes.push(linearOutcome(candidate))],
    displaySink: { ingest: (event) => events.push(event) },
  });
  runtime.eewLogger.setEnabled(false);
  runtime.handler(message);

  expect(outcomes).toHaveLength(1);
  expect(events).toHaveLength(1);
  const outcome = outcomes[0];
  const event = events[0];
  if (outcome == null || event == null) throw new Error(`${spec.fixture} did not reach display`);

  const nowMs = Date.parse(event.reportDateTime);
  if (!Number.isFinite(nowMs)) throw new Error(`${spec.fixture} has an invalid report time`);
  const quakeMapCommand = projectQuakeMapCommand(event, nowMs);
  const dto = projectDisplayEvent(event, `${spec.type} Phase 4A contract`, quakeMapCommand);
  const displayStore = new DisplayStateStore();
  displayStore.applyEvent(dto, nowMs, null, quakeMapCommand);
  const displaySnapshot = displayStore.snapshot(1, nowMs);

  const standbyStore = new StandbyStateStore();
  standbyStore.applyEvent(event, nowMs);
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), `.phase4a-contract-${process.pid}-`));
  tempDirs.push(tempDir);
  const standbyPath = path.join(tempDir, "standby-v1.json");
  const standbyPersistence = new StandbyPersistence(standbyPath, 0, () => ({
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    vpww56: { authoritative: false, state: null, gateEntries: [] },
    tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
    volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
    floodForecast: { authoritative: false, active: [], gateEntries: [] },
    standbyDomains: {
      gateEntries: revisionGate.exportDurableEntries()
        .filter((entry) => entry.domain === "lgObservation"),
    },
  }));
  standbyPersistence.save(standbyStore.exportActiveState());
  const standbyLoaded = new StandbyPersistence(standbyPath).load();

  let dailyLoaded: ReturnType<DailyQuakePersistence["load"]> = null;
  if (event.domain === "earthquake" && dto.recentQuake != null) {
    const daily = new DailyQuakeCounter(nowMs);
    daily.record(event, nowMs);
    daily.recordRecentQuake(dto.recentQuake, nowMs);
    const dailyPath = path.join(tempDir, "daily-quake.json");
    const dailyPersistence = new DailyQuakePersistence(dailyPath, 0);
    dailyPersistence.save(daily.export(), nowMs);
    dailyLoaded = dailyPersistence.load(nowMs);
  }

  return { outcome, event, dto, quakeMapCommand, displaySnapshot, standbyLoaded, dailyLoaded };
}

function requireEew(result: ReturnType<typeof runFixture>) {
  if (result.outcome.domain !== "eew") throw new Error("expected EEW outcome");
  return result.outcome.parsed;
}

function requireEarthquake(result: ReturnType<typeof runFixture>) {
  if (result.outcome.domain !== "earthquake") throw new Error("expected earthquake outcome");
  return result.outcome.parsed;
}

function requireLgObservation(result: ReturnType<typeof runFixture>) {
  if (result.outcome.domain !== "lgObservation") throw new Error("expected lgObservation outcome");
  return result.outcome.parsed;
}

function expectNotification(message: string): void {
  expect(notifyMock).toHaveBeenCalledTimes(1);
  expect(notificationMessage()).toBe(message);
}

/**
 * §13 の11完了条件と検証先:
 *  1 SpecialValue の presence/raw/bounds: [§13-1] の各 fixture assertion
 *  2 shadow parse と対象階層: [§13-2] VXSE45/VXSE53
 *  3 EEW 親 Condition の独立保持: [§13-3]
 *  4 regionless overall と地域非生成: [§13-4]
 *  5 震度/LgInt safety 分離と 5弱 gate: [§13-5]
 *  6 unknown/empty/missing の分離: [§13-6]
 *  7 qualifier の全下流・永続化貫通: [§13-7]
 *  8 payload と safety latch の分離: from-eew.test.ts の unknown 続報契約と eew-tracker.test.ts の降格抑止
 *  9 restoreRevision: process-eew.test.ts の terminal 後復元契約
 * 10 V1 scalar と optional semantic の共存: [§13-10]
 * 11 frontend 境界: [§13-11] の required rank=-1 wire と display:test の map badge/scanline 契約
 */
describe("Phase 4A synthetic contract: parser to persistence", () => {
  it("[§13-1/2/3/7] VXSE45 range・親 Condition・qualifier を具体 wire と display state まで運ぶ", () => {
    const result = runFixture(FIXTURES.eewSpecial);
    const parsed = requireEew(result);
    expect(parsed.forecastIntensity?.maxIntValue).toEqual({
      raw: "", condition: "予測幅", description: "最大予測震度幅", value: null,
      presence: "range", lowerBound: "4", upperBound: "5-",
      rawLowerBound: "４", rawUpperBound: "５－",
    });
    expect(parsed.forecastIntensity?.maxLgIntValue).toMatchObject({
      presence: "range", lowerBound: "2", upperBound: "3",
      rawLowerBound: "２", rawUpperBound: "３",
    });
    expect(parsed.forecastIntensity?.areas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "PLUM地域", condition: "PLUM法による予測", isPlum: true,
        intensityValue: expect.objectContaining({ presence: "range", lowerBound: "5-", upperBound: null }),
      }),
      expect.objectContaining({
        name: "定性地域", condition: "既に主要動到達と推測", hasArrived: true,
        intensityValue: expect.objectContaining({ presence: "qualitative", condition: "5弱以上未入電" }),
      }),
      expect.objectContaining({
        name: "空欄地域", intensityValue: expect.objectContaining({ presence: "empty" }),
      }),
    ]));
    expect(result.event.maxIntValue).toMatchObject({ presence: "range", lowerBound: "4", upperBound: "5-" });
    expect(result.event.maxLgIntValue).toMatchObject({ presence: "range", lowerBound: "2", upperBound: "3" });
    expect(result.event.maxLgIntLabel).toBe("2〜3");
    expect(result.dto.version).toBe(1);
    expect(result.dto.tickerSentence).toBe("Phase 4A synthetic。");
    expectNotification("緊急地震速報（予報）");
    expect(result.dto.emergency).toMatchObject({
      kind: "eew",
      forecastMaxInt: "5弱以上未入電・一部不明",
      forecastMaxIntRank: 5,
      forecastMaxIntSemantic: {
        presence: "range", label: "4〜5弱", badge: "↔", color: "safetyUpperRank",
        safetyLowerRank: 4, safetyUpperRank: 5, safetyRank: 5, colorRank: 5,
      },
      maxLgInt: "2",
      maxLgIntSemantic: {
        presence: "range", label: "2〜3", badge: "↔", color: "safetyUpperRank",
        safetyLowerRank: 2, safetyUpperRank: 3, safetyRank: 3, colorRank: 3,
      },
      regions: expect.arrayContaining([
        expect.objectContaining({
          name: "PLUM地域", lgIntensity: "1〜2",
          lgIntensitySemantic: expect.objectContaining({
            presence: "range", label: "1〜2", badge: "↔", colorRank: 2,
          }),
        }),
        expect.objectContaining({
          name: "定性地域",
          intensitySemantic: expect.objectContaining({
            presence: "qualitative", badge: "≥", color: "safetyRank", safetyLowerRank: 5,
          }),
          lgIntensity: "不明（未入電）",
          lgIntensitySemantic: expect.objectContaining({
            presence: "unknown", label: "不明（未入電）", badge: "?", color: "unknown",
          }),
        }),
        expect.objectContaining({
          name: "空欄地域",
          intensitySemantic: expect.objectContaining({
            presence: "empty", badge: "∅", color: "neutral", safetyLowerRank: null,
          }),
        }),
      ]),
    });
    expect(result.displaySnapshot.activeEews).toEqual([
      expect.objectContaining({
        eventId: "synthetic-phase4a-eew",
        forecastMaxInt: "5弱以上未入電・一部不明",
        forecastMaxIntRank: 5,
        forecastMaxIntSemantic: expect.objectContaining({ presence: "range", badge: "↔", colorRank: 5 }),
        maxLgIntSemantic: expect.objectContaining({
          presence: "range", label: "2〜3", badge: "↔", colorRank: 3,
        }),
        regions: expect.arrayContaining([
          expect.objectContaining({ name: "PLUM地域", lgIntensity: "1〜2" }),
          expect.objectContaining({ name: "定性地域", lgIntensity: "不明（未入電）" }),
        ]),
      }),
    ]);
    expect(result.standbyLoaded).toMatchObject({ version: 2, quakeHost: null, longPeriod: [] });
  });

  it("[§13-4/5/10] regionless EEW は overall semantic を評価し regions と areaItems を生成しない", () => {
    const result = runFixture(FIXTURES.eewRegionless);
    const parsed = requireEew(result);
    expect(parsed.forecastIntensity).toMatchObject({
      maxIntValue: {
        presence: "qualitative", condition: "5弱以上未入電",
        description: "地域なし最大予測震度は5弱以上", lowerBound: "5-",
      },
      maxLgIntValue: { presence: "unknown", condition: "未入電" },
      areas: [],
    });
    expect(result.event.areaItems).toEqual([]);
    expect(result.dto.tickerSentence).toBe("Phase 4A regionless synthetic。");
    expectNotification("緊急地震速報（予報）");
    expect(result.dto.emergency).toMatchObject({
      kind: "eew",
      forecastMaxInt: "5弱以上未入電",
      forecastMaxIntRank: 5,
      forecastMaxIntSemantic: {
        presence: "qualitative", label: "5弱以上未入電", badge: "≥", color: "safetyRank",
        safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
      },
      maxLgInt: null,
      maxLgIntSemantic: {
        presence: "unknown", label: "不明（未入電）", badge: "?", color: "unknown",
        safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
      },
      regions: [],
    });
    expect(result.quakeMapCommand).toBeNull();
    expect(result.displaySnapshot.activeEews).toEqual([
      expect.objectContaining({
        eventId: "synthetic-phase4a-eew-regionless",
        forecastMaxInt: "5弱以上未入電",
        forecastMaxIntRank: 5,
        maxLgIntSemantic: expect.objectContaining({
          presence: "unknown", label: "不明（未入電）", badge: "?", color: "unknown",
        }),
        regions: [],
      }),
    ]);
    expect(result.standbyLoaded).toMatchObject({ version: 2, quakeHost: null, longPeriod: [] });
  });

  it("[§13-1/5/6/7/10/11] VXSE51 qualifier・unknown・rank=-1 を通知、map、daily persistence に固定する", () => {
    const result = runFixture(FIXTURES.quakeQualitative);
    const parsed = requireEarthquake(result);
    expect(parsed.intensity?.maxIntValue).toMatchObject({
      raw: "", presence: "qualitative", condition: "5弱以上未入電",
      description: "最大震度は5弱以上だが未入電", lowerBound: "5-",
    });
    expect(parsed.intensity?.areas).toEqual([
      expect.objectContaining({
        name: "未入電地域", code: "990",
        intensityValue: expect.objectContaining({ presence: "unknown", condition: "未入電" }),
      }),
      expect.objectContaining({
        name: "本文定性地域", code: "991",
        intensityValue: expect.objectContaining({ raw: "5弱以上未入電", presence: "qualitative", lowerBound: "5-" }),
      }),
    ]);
    expect(result.event.maxIntLabel).toBe("5弱以上未入電");
    expect(result.dto.tickerSentence).toBe("Phase 4A synthetic。 最大震度5弱以上（未入電）を観測しています。");
    expectNotification("最大震度は5弱以上とみられます（未入電）");
    expect(result.dto.emergency).toMatchObject({
      kind: "largeQuake",
      maxInt: "5弱以上（未入電）",
      maxIntRank: 5,
      maxIntSemantic: {
        presence: "qualitative", label: "5弱以上（未入電）", badge: "≥", color: "safetyRank",
        safetyLowerRank: 5, safetyRank: 5, colorRank: 5,
      },
      intensityGroups: expect.arrayContaining([
        expect.objectContaining({
          intensity: "不明（未入電）", rank: -1, areas: ["未入電地域"],
          intensitySemantic: expect.objectContaining({ presence: "unknown", badge: "?", color: "unknown" }),
        }),
      ]),
    });
    expect(result.quakeMapCommand).toMatchObject({
      kind: "upsert",
      event: {
        maxInt: "5弱以上（未入電）",
        maxIntRank: 5,
        maxIntSemantic: expect.objectContaining({ presence: "qualitative", badge: "≥", colorRank: 5 }),
        localAreas: expect.arrayContaining([
          {
            code: "990", rank: -1,
            intensitySemantic: expect.objectContaining({
              presence: "unknown", label: "不明（未入電）", badge: "?", color: "unknown",
              safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
            }),
          },
          {
            code: "991", rank: 5,
            intensitySemantic: expect.objectContaining({
              presence: "qualitative", label: "5弱以上（未入電）", badge: "≥", color: "safetyRank",
              safetyLowerRank: 5, safetyRank: 5, colorRank: 5,
            }),
          },
        ]),
      },
    });
    expect(result.displaySnapshot.largeQuakes[0]).toMatchObject({
      eventId: "synthetic-phase4a-vxse51", maxInt: "5弱以上（未入電）", maxIntRank: 5,
      maxIntSemantic: expect.objectContaining({ presence: "qualitative", badge: "≥" }),
    });
    expect(result.standbyLoaded?.quakeHost).toMatchObject({
      eventId: "synthetic-phase4a-vxse51", maxIntRank: 5,
    });
    expect(result.dailyLoaded).toMatchObject({
      count: 0,
      maxInt: null,
      maxIntRank: 0,
      recentQuakes: [expect.objectContaining({
        eventId: "synthetic-phase4a-vxse51",
        maxInt: null,
        maxIntRank: null,
        maxIntSemantic: expect.objectContaining({
          presence: "qualitative", label: "5弱以上（未入電）", badge: "≥", safetyLowerRank: 5,
        }),
        intensityGroups: expect.arrayContaining([
          expect.objectContaining({
            intensity: "不明（未入電）", rank: -1,
            intensitySemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
          }),
        ]),
      })],
    });
  });

  it("[§13-2/5] VXSE53 City/IntensityStation qualifier を parse し、通常震度4を回帰させない", () => {
    const result = runFixture(FIXTURES.quakeDetailed);
    const parsed = requireEarthquake(result);
    expect(parsed.intensity?.municipalities).toEqual([
      expect.objectContaining({
        name: "全角市", code: "9900100",
        intensityValue: expect.objectContaining({ presence: "value", value: "4" }),
        lgIntensityValue: expect.objectContaining({ presence: "range", lowerBound: "1", upperBound: "3" }),
      }),
      expect.objectContaining({
        name: "空白市", code: "9900200",
        intensityValue: expect.objectContaining({ raw: " 　", presence: "empty" }),
      }),
    ]);
    expect(parsed.intensity?.stations).toEqual([
      expect.objectContaining({
        name: "下限観測点", code: "9900001",
        intensityValue: expect.objectContaining({
          presence: "qualitative", condition: "5弱以上未入電",
          description: "観測点は5弱以上", lowerBound: "5-",
        }),
      }),
    ]);
    expect(result.event.maxIntValue).toMatchObject({ presence: "value", value: "4" });
    expect(result.event.maxIntLabel).toBe("4");
    expect(result.dto.tickerSentence).toBe("Phase 4A synthetic。 震度4 詳細地域");
    expectNotification("最大震度4");
    expect(result.dto.emergency).toBeNull();
    expect(result.quakeMapCommand).toMatchObject({
      kind: "upsert",
      event: { maxInt: "4", maxIntRank: 4, localAreas: [{ code: "990", rank: 4 }] },
    });
    expect(result.displaySnapshot.largeQuakes).toEqual([]);
    expect(result.displaySnapshot.mapLayers?.quake?.events[0]).toMatchObject({ maxInt: "4", maxIntRank: 4 });
    expect(result.standbyLoaded?.quakeHost).toMatchObject({
      eventId: "synthetic-phase4a-vxse53", maxIntRank: 4,
    });
    expect(result.dailyLoaded).toMatchObject({
      count: 1,
      maxInt: "4",
      maxIntRank: 4,
      countedEventIds: ["synthetic-phase4a-vxse53"],
      recentQuakes: [expect.objectContaining({
        eventId: "synthetic-phase4a-vxse53", maxInt: "4", maxIntRank: 4,
        intensityGroups: [{
          intensity: "4",
          rank: 4,
          areas: ["詳細地域"],
          omittedAreaCount: 0,
          expandedAreas: ["詳細地域"],
          candidateTruncated: false,
        }],
      })],
    });
  });

  it("[§13-6/7] VXSE61 の構造 missing を表示値や低 rank にせず round-trip する", () => {
    const result = runFixture(FIXTURES.quakeMissing);
    const parsed = requireEarthquake(result);
    expect(parsed.intensity).toBeUndefined();
    expect(result.event.maxIntValue).toEqual({
      raw: null, value: null, condition: null, description: null, presence: "missing",
    });
    expect(result.event.maxIntLabel).toBeNull();
    // Phase 5A §3.7: semantic missing は ticker では M 表示を省略する。
    expect(result.dto.tickerSentence).toBe("午後8時59分ごろ、合成震源を震源とする地震がありました。");
    expectNotification("合成震源 / M不明");
    expect(result.quakeMapCommand).toMatchObject({ kind: "remove", reason: "structuralMissing" });
    expect(result.displaySnapshot.largeQuakes).toEqual([]);
    expect(result.displaySnapshot.mapLayers?.quake?.events).toEqual([]);
    expect(result.standbyLoaded).toMatchObject({ version: 2, quakeHost: null, longPeriod: [] });
    expect(result.dailyLoaded).toMatchObject({
      count: 0,
      maxInt: null,
      maxIntRank: 0,
      recentQuakes: [expect.objectContaining({
        eventId: "synthetic-phase4a-vxse61",
        maxInt: null,
        maxIntRank: null,
        intensityGroups: [],
        maxIntSemantic: expect.objectContaining({
          presence: "missing", label: "—", render: false, color: "notRendered",
          safetyLowerRank: null, safetyRank: null, colorRank: null,
        }),
      })],
    });
  });

  it("[§13-1/5/6/7] VXSE62 は LgInt unknown を震度 safety と分離して standby persistence へ保存する", () => {
    const result = runFixture(FIXTURES.lgUnknown);
    const parsed = requireLgObservation(result);
    expect(parsed.maxIntValue).toMatchObject({ raw: "４", presence: "value", value: "4" });
    expect(parsed.maxLgIntValue).toMatchObject({
      raw: "", presence: "unknown", condition: "未入電", description: "最大長周期階級未入電",
    });
    expect(parsed.areas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "幅地域",
        maxLgIntValue: expect.objectContaining({ presence: "range", lowerBound: "2", upperBound: "4" }),
      }),
      expect.objectContaining({
        name: "全角地域",
        maxIntValue: expect.objectContaining({ presence: "empty" }),
        maxLgIntValue: expect.objectContaining({ presence: "value", value: "3" }),
      }),
      expect.objectContaining({
        name: "震度のみ地域",
        maxLgIntValue: expect.objectContaining({ presence: "missing" }),
      }),
    ]));
    expect(result.event.maxIntValue).toMatchObject({ presence: "value", value: "4" });
    expect(result.event.maxLgIntValue).toMatchObject({ presence: "unknown", condition: "未入電" });
    expect(result.event.maxLgIntLabel).toBe("不明");
    expect(result.event.frameLevel).toBe("info");
    expect(result.dto.tickerSentence).toBe("Phase 4A synthetic。");
    expectNotification("長周期階級不明（未入電） / 最大震度4");
    expect(result.dto.emergency).toBeNull();
    expect(result.standbyLoaded?.longPeriod).toEqual([
      expect.objectContaining({
        eventId: "synthetic-phase4a-lg", maxLgInt: "不明（未入電）", safetyRank: null,
        revision: { reportTimeMs: 1785585720000, serial: "1" }, hosted: false,
      }),
    ]);
    expect(result.standbyLoaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({
        domain: "lgObservation", revisionFamily: "VXSE62",
        stateSubjectKey: "longPeriod:synthetic-phase4a-lg", cancelled: false,
      }),
    ]);
  });
});
