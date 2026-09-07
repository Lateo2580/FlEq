/**
 * 待機時 sweep ホットパス spec §4.3「事前判定の差分テスト」用の fixture。
 *
 * 期限を意図的にばらけさせた domains を組み立てる。事前判定つき sweepAll と、
 * 事前判定を無効化した参照実装の 2 本を同じ時刻列で走らせ、結果が一致することを
 * 確認するための入力になる。
 *
 * ここに載せる期限のクラスは spec §3.3 の表と対応させる。fixture に無い期限クラスは
 * 述語の書き漏れを差分テストで検出できないので、増やすときは表と一緒に更新する。
 */
import type {
  DisplayWeatherWarningForecastGroupV1,
  DisplayTyphoonV1,
} from "../../src/engine/display/protocol";
import type { StandbyPersistenceDomainSnapshots } from "../../src/engine/display/standby-persistence-admission";
import type { TelegramRevisionGateSnapshot } from "../../src/engine/messages/telegram-revision-gate";
import type { StandbyStateStoreSnapshot } from "../../src/engine/display/standby-state-store";

/** 期限がばらける時刻の基準。すべての期限はここからの相対で置く。 */
export const DEADLINE_BASE_MS = Date.parse("2026-09-07T00:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function revision(offsetMs: number, serial: string | null = "1") {
  return { reportTimeMs: DEADLINE_BASE_MS + offsetMs, serial };
}

function iso(offsetMs: number): string {
  return new Date(DEADLINE_BASE_MS + offsetMs).toISOString();
}

function typhoon(key: string): DisplayTyphoonV1 {
  return {
    typhoonKey: key,
    name: null,
    nameKana: null,
    remark: null,
    typhoonNumber: key,
    category: null,
    location: null,
    pressureHpa: null,
    maxWindMs: null,
    moveDirection: null,
    moveSpeedKmh: null,
    reportDateTime: iso(0),
  };
}

function specialValue() {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing" as const,
  };
}

function forecastGroup(key: string, endsAtOffsetMs: number): DisplayWeatherWarningForecastGroupV1 {
  return {
    key,
    phenomenonName: "大雨",
    significancyCode: "10",
    forecastLabel: "警報級",
    displaySeverity: "nonLevelWarning",
    severity: "warning",
    targets: [{
      key: `${key}:target`,
      scope: "area",
      name: "対象区域",
      parentAreaName: "対象府県",
      areaCode: "130000",
      localCode: null,
      periods: [{
        key: `${key}:period`,
        tsNum: 1,
        series: "3h",
        startsAt: iso(0),
        endsAt: iso(endsAtOffsetMs),
        label: "期間",
        pagerAnchorKey: `${key}:anchor`,
        pagerAnchorOrdinal: 0,
        pagerSlot: 0,
      }],
    }],
  };
}

/**
 * 期限をばらけさせた gate snapshot。
 *
 * - `tornado` / `heatAlert` は active retention を持つ family で、時間経過だけで消える
 * - cancelled entry は tombstone retention で消える
 * - transientStates は entry 固有の retentionMs で消える
 */
function deadlineGateSnapshot(): TelegramRevisionGateSnapshot {
  const comparison = (subject: string, family: string, infoType: "発表" | "取消") => ({
    stateSubjectKey: subject,
    revision: {
      eventId: { raw: subject, value: subject, valid: true },
      type: { raw: family, value: family, valid: true },
      reportDateTime: { raw: iso(0), epochMs: DEADLINE_BASE_MS, valid: true },
      serial: { raw: "1", numeric: 1, valid: true },
      infoType: { raw: infoType, value: infoType, valid: true as const },
    },
  });
  return {
    version: 1,
    states: [
      {
        // 取消済み。tombstone retention の経過で消える。
        key: "tornado:tornado:office-a",
        comparison: comparison("office-a", "tornado", "取消"),
        semanticKeys: ["取消:office-a"],
        cancelled: true,
        acceptedAtMs: DEADLINE_BASE_MS - 30 * MINUTE,
        durable: true,
        tombstoneRetentionMs: 90 * MINUTE,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "office-a",
        legacyRevisionKeyProvenance: "codeFallback",
      },
      {
        // active。family policy の activeRetentionMs 経過で消える。
        key: "heatAlert:VPFT50:heat-a",
        comparison: comparison("heat-a", "VPFT50", "発表"),
        semanticKeys: ["発表:heat-a"],
        cancelled: false,
        acceptedAtMs: DEADLINE_BASE_MS - 20 * HOUR,
        durable: true,
        tombstoneRetentionMs: 2 * DAY,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "heat-a",
        legacyRevisionKeyProvenance: "codeFallback",
      },
      {
        // 期限が十分先で、時刻列の間ずっと残るもの (無関係 owner が動かないことの確認用)。
        key: "weather:VPWS50:weather:vpws50",
        comparison: comparison("weather:vpws50", "VPWS50", "発表"),
        semanticKeys: ["発表:weather:vpws50"],
        cancelled: false,
        acceptedAtMs: DEADLINE_BASE_MS,
        durable: true,
        tombstoneRetentionMs: 7 * DAY,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "weather:vpws50",
        legacyRevisionKeyProvenance: "codeFallback",
      },
      {
        key: "floodForecast:floodForecast:flood:event:flood-a",
        comparison: comparison("flood:event:flood-a", "floodForecast", "発表"),
        semanticKeys: ["発表:flood-a"],
        cancelled: false,
        acceptedAtMs: DEADLINE_BASE_MS,
        durable: true,
        tombstoneRetentionMs: 2 * DAY,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "flood:event:flood-a",
        legacyRevisionKeyProvenance: "eventId",
      },
      {
        key: "typhoonProbability:VPTA50:typhoonProbability:T2601",
        comparison: comparison("typhoonProbability:T2601", "VPTA50", "発表"),
        semanticKeys: ["発表:T2601"],
        cancelled: false,
        acceptedAtMs: DEADLINE_BASE_MS,
        durable: true,
        tombstoneRetentionMs: 7 * DAY,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "typhoonProbability:T2601",
        legacyRevisionKeyProvenance: "eventId",
      },
      {
        key: "weatherWarningTimeseries:VPWP50:vpwp-a",
        comparison: comparison("vpwp-a", "VPWP50", "発表"),
        semanticKeys: ["発表:vpwp-a"],
        cancelled: false,
        acceptedAtMs: DEADLINE_BASE_MS,
        durable: true,
        tombstoneRetentionMs: 7 * DAY,
        retainForFamilyCapacity: false,
        legacyRevisionKey: "vpwp-a",
        legacyRevisionKeyProvenance: "codeFallback",
      },
    ],
    transientStates: [{
      key: "volcano:volcanoTransient:transient-a",
      semanticKey: "発表:transient-a",
      acceptedAtMs: DEADLINE_BASE_MS - 10 * MINUTE,
      domain: "volcano",
      revisionFamily: "volcanoTransient",
      retentionMs: 45 * MINUTE,
    }],
    transientSemanticKeys: [],
    warnedFamilyCapacity: [],
  };
}

function deadlineStandbyData(): StandbyStateStoreSnapshot["data"] {
  return {
    heatAlerts: new Map([["heat-a", {
      sourceEventIds: ["heat-a"],
      targetDate: "2026-09-07",
      targetDateEndMs: DEADLINE_BASE_MS + 25 * MINUTE,
      areas: [{ areaName: "区域", isSpecial: false }],
      isSpecial: false,
      revision: revision(0),
      restored: false,
    }]]),
    typhoons: new Map([["T2601", {
      sourceEventId: "T2601",
      typhoon: typhoon("T2601"),
      pressureHpaValue: specialValue(),
      maxWindMsValue: specialValue(),
      maxGustMsValue: specialValue(),
      moveSpeedKmhValue: specialValue(),
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 35 * MINUTE,
      restored: false,
    }]]),
    typhoonProbabilities: new Map([["T2601", {
      eventId: "T2601",
      sourceEventId: "T2601",
      identity: { name: null, nameKana: null, remark: null, typhoonNumber: "T2601" },
      baseTimeMs: DEADLINE_BASE_MS,
      maxFiveDayProbability: 40,
      activePrefectureCount: 1,
      topPrefectures: [{ prefectureCode: "13", prefectureName: "東京都", fiveDayProbability: 40 }],
      worstArea: {
        areaCode: "1310000",
        areaName: "東京地方",
        prefectureCode: "13",
        prefectureName: "東京都",
        fiveDayProbability: 40,
        peakAtMs: null,
      },
      revision: revision(0),
      appliedSemanticKey: "発表:T2601",
      expiresAtMs: DEADLINE_BASE_MS + 55 * MINUTE,
      restored: false,
    }]]),
    volcanoes: new Map([
      ["v-a", {
        code: "v-a",
        name: "火山A",
        alertLevel: 3,
        alertClass: null,
        warningKind: null,
        targetKinds: [],
        // alert は活性のまま。eruption / ashfall の期限だけが順に来る。
        alertExpiresAtMs: DEADLINE_BASE_MS + 6 * HOUR,
        latestEvent: {
          label: "噴火",
          craterName: null,
          eventDateTime: null,
          plumeHeightM: null,
          plumeHeightUnknown: false,
          plumeDirection: null,
        },
        latestEventId: "ev-a",
        eventExpiresAtMs: DEADLINE_BASE_MS + 15 * MINUTE,
        sourceEventIds: ["ev-a"],
        alertRevision: revision(0),
        eventRevision: revision(0),
        alertRestored: false,
        eventRestored: false,
        ashfall: null,
        ashfallExpiresAtMs: null,
        ashfallRevision: null,
        ashfallRestored: false,
      }],
    ]),
    managedVolcanoAlerts: new Set<string>(),
    managedVolcanoEruptions: new Set<string>(),
    tornadoByOffice: new Map([["office-a", {
      publishingOffice: "office-a",
      sourceEventId: "tornado-a",
      areas: ["区域"],
      isSighted: false,
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 10 * MINUTE,
      restored: false,
    }]]),
    longPeriodByEvent: new Map([["lg-a", {
      eventId: "lg-a",
      maxLgInt: "3",
      safetyRank: null,
      revision: revision(0),
      hosted: true,
      expiresAtMs: DEADLINE_BASE_MS + 20 * MINUTE,
      restored: false,
    }]]),
    quakeHost: {
      eventId: "q-a",
      maxIntRank: 40,
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 40 * MINUTE,
    },
    nankaiTrough: {
      sourceEventId: "n-a",
      statusCode: "1",
      label: "調査中",
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 50 * MINUTE,
      restored: false,
    },
    weatherAlerts: new Map([["vpws50", {
      source: "vpws50" as const,
      alerts: [{
        source: "vpws50" as const,
        label: "気象警報",
        role: "weatherWarning" as const,
        totalAreas: 1,
        items: [{
          kind: "大雨警報",
          displaySeverity: "nonLevelWarning",
          rank: "warning" as const,
          shownAreas: ["区域"],
          omittedAreaCount: 0,
        }],
        updatedAt: iso(0),
      }],
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 45 * MINUTE,
    }]]),
    weatherWarningForecasts: new Map([["vpwp-a", {
      subjectKey: "vpwp-a",
      sourceEventId: "vpwp-a",
      publishingOffice: "官署",
      targetAreaName: null,
      targetAreaCode: null,
      groups: [forecastGroup("g1", 30 * MINUTE)],
      revision: revision(0),
      appliedSemanticKey: "発表:vpwp-a",
      expiresAtMs: DEADLINE_BASE_MS + 30 * MINUTE,
      restored: false,
    }]]),
    floods: {
      events: [["flood-a", {
        revision: revision(0),
        appliedRevision: revision(0),
        appliedSemanticKey: null,
        rivers: [{
          riverKey: "river-a",
          riverName: "河川A",
          level: "L4",
          levelRank: 40,
          kindName: "氾濫危険情報",
          reportDateTime: iso(0),
        }],
        expiresAtMs: DEADLINE_BASE_MS + 5 * MINUTE,
        restored: false,
      }]],
    },
    legacyFloodEventIds: new Set<string>(),
    managedStandbySubjects: new Map<string, Set<string>>(),
    revisionGuard: {
      seen: [
        ["guard-a", {
          revision: revision(0),
          forgetAtMs: DEADLINE_BASE_MS + 12 * MINUTE,
          expiresAtMonotonicMs: null,
        }],
        ["guard-b", {
          revision: revision(0),
          forgetAtMs: DEADLINE_BASE_MS + 3 * DAY,
          expiresAtMonotonicMs: null,
        }],
      ],
    },
    briefingEntries: new Map(),
    briefingRevisionWatermarks: new Map([["brief-a", {
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 18 * MINUTE,
    }]]),
    linearRainForecastReplacementWatermarks: new Map([["linear-a", {
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 22 * MINUTE,
    }]]),
    rawCriticalProvenance: new Map([["raw-a", {
      identity: { kind: "raw" as const, source: "vpbs50" as const, sourceEventId: "raw-a" },
      phase: "active" as const,
      lastStrictRevision: revision(0),
      lastAcceptedFrameLevel: "critical" as const,
      lastPayloadFingerprint: "fp",
      lastCriticalExpiresAtMs: DEADLINE_BASE_MS + 8 * MINUTE,
      expiresAtMs: DEADLINE_BASE_MS + 8 * MINUTE,
    }]]),
    rawBriefingAliases: new Map([["alias-a", {
      identity: { kind: "raw" as const, source: "vpoa50" as const, sourceEventId: "alias-a" },
      semanticKey: "brief-a",
      revision: revision(0),
      expiresAtMs: DEADLINE_BASE_MS + 28 * MINUTE,
    }]]),
    briefingGeneration: 0,
    briefingDurableGeneration: 0,
  };
}

/**
 * 期限がばらけた domains 一式。`restorePrevalidated` に渡して owner を seed する。
 *
 * `base` には空の capture 結果を渡す (owner の既定 snapshot 形状をそのまま使うため)。
 */
export function buildDeadlineScatteredDomains(
  base: StandbyPersistenceDomainSnapshots,
): StandbyPersistenceDomainSnapshots {
  const next = structuredClone(base);
  next.telegramRevisionGate = deadlineGateSnapshot();
  next.standbyStateStore = { version: 1, data: deadlineStandbyData() };
  next.volcanoHolderAndRepair = {
    runtimeVersion: next.volcanoHolderAndRepair.runtimeVersion,
    holder: {
      version: 1,
      composites: [{
        volcanoCode: "v-a",
        volcanoName: "火山A",
        sourceEventIds: ["ev-a"],
        alert: {
          volcanoCode: "v-a",
          volcanoName: "火山A",
          alertLevel: 3,
          alertLevelCode: "3",
          action: "issue",
          reportDateTime: iso(0),
          alertClass: null,
          warningKind: "噴火警報",
          targetKinds: [],
          sourceFamily: "VFVO50",
          revision: revision(0),
          appliedSemanticKey: "発表:v-a",
        },
        eruption: {
          volcanoName: "火山A",
          latestEvent: {
            label: "噴火",
            craterName: null,
            eventDateTime: null,
            plumeHeightM: null,
            plumeHeightUnknown: false,
            plumeDirection: null,
          },
          latestEventId: "ev-a",
          eventExpiresAtMs: DEADLINE_BASE_MS + 15 * MINUTE,
          revision: revision(0),
          appliedSemanticKey: "発表:v-a",
        },
        ashfall: {
          stateSubjectKey: "volcano:ashfall:v-a",
          volcanoCode: "v-a",
          volcanoName: "火山A",
          eventId: "ev-a",
          sourceType: "VFVO54",
          sourceEventId: "ash-a",
          forecastStartsAtMs: DEADLINE_BASE_MS,
          forecastEndsAtMs: DEADLINE_BASE_MS + 33 * MINUTE,
          groups: [{
            hazardClass: "unknown",
            ashCode: "x",
            ashName: "y",
            areaCount: 1,
            topAreas: [{
              identityKey: "area:name:a",
              code: null,
              name: "a",
              firstForecastEndAtMs: DEADLINE_BASE_MS + 33 * MINUTE,
            }],
            omittedAreaCount: 0,
          }],
          omittedGroupCount: 0,
          revision: revision(0),
          appliedSemanticKey: "発表:v-a",
          generation: 1,
        },
      }],
      restored: [{ volcanoCode: "v-a", alert: false, eruption: false, ashfall: false }],
      legacyEruptionIdentities: [],
    },
    repair: next.volcanoHolderAndRepair.repair,
  };
  next.floodForecastState = {
    version: 1,
    events: [{
      eventId: "flood-a",
      lastSeenMs: DEADLINE_BASE_MS,
      stations: [],
    }],
  };
  return next;
}

/**
 * 差分テストで使う時刻列。各期限の直前 / ちょうど / 直後と、期限を飛び越す大ジャンプ。
 */
export function deadlineProbeTimes(): number[] {
  const deadlineOffsets = [
    5 * MINUTE, 8 * MINUTE, 10 * MINUTE, 12 * MINUTE, 15 * MINUTE, 18 * MINUTE,
    20 * MINUTE, 22 * MINUTE, 25 * MINUTE, 28 * MINUTE, 30 * MINUTE, 33 * MINUTE,
    35 * MINUTE, 40 * MINUTE, 45 * MINUTE, 50 * MINUTE, 55 * MINUTE,
    60 * MINUTE, 90 * MINUTE, 4 * HOUR, 6 * HOUR,
  ];
  const times = new Set<number>([DEADLINE_BASE_MS - MINUTE, DEADLINE_BASE_MS]);
  for (const offset of deadlineOffsets) {
    times.add(DEADLINE_BASE_MS + offset - 1);
    times.add(DEADLINE_BASE_MS + offset);
    times.add(DEADLINE_BASE_MS + offset + 1);
  }
  // 期限を飛び越す大ジャンプ。
  times.add(DEADLINE_BASE_MS + 3 * DAY);
  times.add(DEADLINE_BASE_MS + 10 * DAY);
  return [...times].sort((left, right) => left - right);
}
