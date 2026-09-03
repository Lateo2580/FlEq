import { testTelegramMeta } from "../../helpers/telegram-meta";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDisplayController } from "../../../src/engine/display/controller";
import {
  STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE,
  STANDBY_READER_MAX_RAW_FILE_BYTES_PER_SOURCE,
  SWEEP_INTERVAL_MS,
  VOLCANO_ASHFALL_MAX_WIRE_SLICES,
  VOLCANO_CARD_MAX_WIRE_BYTES,
  VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE,
} from "../../../src/engine/display/constants";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import {
  StandbyPersistence,
  STANDBY_WRITER_ROOT_DURABLE_KEYS,
  standbyPersistenceV2Path,
  type PersistedBriefingCriticalStateV1,
} from "../../../src/engine/display/standby-persistence";
import {
  STANDBY_EXPECTED_TOUCHED_OWNERS,
  STANDBY_PERSISTED_FAMILY_DURABLE_KEYS,
  measureStandbyAdmissionPair,
  serializeStandbyAdmissionPair,
  StandbyPersistenceAdmissionCoordinator,
  sweepStandbyBeforeAdmission,
  type StandbyPersistenceDomainSnapshots,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type { DisplayRuntime } from "../../../src/engine/display/runtime";
import type { DisplayBriefingEntryV1 } from "../../../src/engine/display/protocol";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { createShutdownHandler } from "../../../src/engine/monitor/shutdown";
import * as shutdownModule from "../../../src/engine/monitor/shutdown";
import {
  ALL_REVISION_FAMILY_POLICIES,
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  TSUNAMI_REVISION_FAMILY_POLICIES,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
  VOLCANO_ALERT_REVISION_FAMILY_POLICY,
  VPWS50_REVISION_FAMILY_POLICY,
  VPWW56_REVISION_FAMILY_POLICY,
  WEATHER_TIMESERIES_RETENTION_MS,
} from "../../../src/engine/messages/revision-family-registry";
import {
  TelegramRevisionGate,
  type TelegramRevisionGateSnapshot,
} from "../../../src/engine/messages/telegram-revision-gate";
import {
  Vpws50StateHolder,
  VPWS50_SNAPSHOT_GENERATION,
  type PersistedVpws50KindV2,
  type PersistedVpws50SnapshotV2,
  type PersistedVpws50StateV2,
} from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import {
  VolcanoStateHolder,
  emptyVolcanoRepairState,
  type VolcanoCompositeV2,
} from "../../../src/engine/messages/volcano-state";
import { VolcanoTransactionCoordinator } from "../../../src/engine/messages/volcano-transaction-coordinator";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import {
  createVptaRouterOwnerToken,
  withVptaRouterOwnerToken,
} from "../../../src/engine/display/types";
import {
  processMessage,
  processMessageInternal,
} from "../../../src/engine/presentation/processors/process-message";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPWP50_LOCAL_IDENTITY,
  FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
  readFixture,
} from "../../helpers/mock-message";
import {
  DEFAULT_CONFIG,
  type ParsedHeatAlertInfo,
  type ParsedTornadoAdvisory,
  type TelegramRevisionComparisonInput,
  type WsDataMessage,
} from "../../../src/types";

const mockStartDisplayRuntime = vi.fn();
const mockSetActiveDisplayRuntime = vi.fn();

vi.mock("../../../src/engine/display/runtime", () => ({
  startDisplayRuntime: (...args: unknown[]) => mockStartDisplayRuntime(...args),
  setActiveDisplayRuntime: (...args: unknown[]) => mockSetActiveDisplayRuntime(...args),
}));

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const tempRoots: string[] = [];

function heatEvent(): PresentationEvent {
  const raw: ParsedHeatAlertInfo = {
    meta: testTelegramMeta(false),
    type: "VPFT50", infoType: "発表", title: "東京都熱中症警戒アラート", controlTitle: "熱中症警戒アラート",
    reportDateTime: "2026-07-21T05:00:00+09:00", targetDateTime: "2026-07-21T05:00:00+09:00",
    headline: null, publishingOffice: "環境省 気象庁", editorialOffice: "環境省 気象庁", eventId: null,
    serial: "1", targetAreaName: "東京都", notice: null, bodyText: null, isTest: false,
  };
  return {
    id: "heat-1", classification: "meteorological", domain: "heatAlert", type: "VPFT50", infoType: "発表",
    title: raw.title, controlTitle: raw.controlTitle, headline: null, reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice, isTest: false, frameLevel: "warning", isCancellation: false, serial: "1",
    areaNames: ["東京都"], forecastAreaNames: [], municipalityNames: [], observationNames: [], areaCount: 1,
    forecastAreaCount: 0, municipalityCount: 0, observationCount: 0, areaItems: [], raw,
  };
}

function tornadoEvent(
  validDateTime: string,
  publishingOffice: string = "東京管区気象台",
  reportTimeMs: number = T0,
  serial: string = "1",
  areas: string[] = ["千代田区", "港区"],
): PresentationEvent {
  const raw: ParsedTornadoAdvisory = {
    meta: testTelegramMeta(false),
    type: "VPHW50", infoType: "発表", title: "東京都竜巻注意情報", controlTitle: "竜巻注意情報",
    reportDateTime: new Date(reportTimeMs).toISOString(), validDateTime, headline: "東京都に竜巻注意情報",
    publishingOffice, editorialOffice: "気象庁", serial,
    layers: [], sightingAreas: [], isSightingTelegram: false, hasSightingAreas: false,
    activeAreaCount: areas.length, displaySeverity: "nonLevelWarning", soundLevel: "warning", isTest: false,
  };
  return {
    id: `tornado-${serial}`, classification: "meteorological", domain: "tornado", type: "VPHW50",
    infoType: "発表", title: raw.title, controlTitle: raw.controlTitle, headline: raw.headline,
    reportDateTime: raw.reportDateTime, publishingOffice, isTest: false,
    frameLevel: "warning", isCancellation: false, serial: raw.serial,
    areaNames: areas, forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: areas.length, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: areas.map((name, index) => ({ name, code: `1310${index}`, kind: "竜巻注意情報" })),
    raw,
  };
}

function admissionHarness(options: {
  canReserve?: () => boolean;
  serializePair?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
  ) => { v2: Uint8Array; v1: Uint8Array };
} = {}) {
  const owners = {
    telegramRevisionGate: new TelegramRevisionGate(),
    standbyStateStore: new StandbyStateStore(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
  };
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners,
    canReserveLogicalGeneration: options.canReserve,
    ...(options.serializePair == null ? {} : {
      serializePair: (domains) => options.serializePair!(domains),
    }),
  });
  return { owners, coordinator };
}

function persistedStandbyOnlyPair(domains: Readonly<StandbyPersistenceDomainSnapshots>) {
  const encoded = new TextEncoder().encode(JSON.stringify({
    briefingGeneration: domains.standbyStateStore.data.briefingGeneration,
  }));
  return { v2: encoded, v1: encoded };
}

function maximumVolcanoCapacityDomains(
  profile: "active-all-slices" | "admissible-maximum" = "active-all-slices",
  subjectCount = 128,
): {
  domains: StandbyPersistenceDomainSnapshots;
  standby: StandbyStateStore;
} {
  const { coordinator } = admissionHarness();
  const domains = structuredClone(coordinator.capture().domains) as StandbyPersistenceDomainSnapshots;
  const reportTimeMs = Date.parse("2026-08-31T00:00:00.000Z");
  const reportDateTime = new Date(reportTimeMs).toISOString();
  const semanticKey = `発表:${"0".repeat(64)}`;
  const activeAllSlices = profile === "active-all-slices";
  const comparison = (
    subject: string,
    family: "volcanoAlert" | "volcanoEruption" | "volcanoAshfall",
    infoType: "発表" | "取消",
    variantRank?: 0 | 1,
  ): TelegramRevisionComparisonInput => ({
    stateSubjectKey: subject,
    ...(variantRank == null ? {} : { variantRank }),
    revision: {
      eventId: { raw: subject, value: subject, valid: true },
      type: { raw: family, value: family, valid: true },
      reportDateTime: { raw: reportDateTime, epochMs: reportTimeMs, valid: true },
      serial: { raw: null, numeric: null, valid: false },
      infoType: { raw: infoType, value: infoType, valid: true },
    },
  });
  const composites: VolcanoCompositeV2[] = [];
  const gateStates: TelegramRevisionGateSnapshot["states"] = [];
  const restored: StandbyPersistenceDomainSnapshots["volcanoHolderAndRepair"]["holder"]["restored"] = [];
  for (let index = 0; index < subjectCount; index++) {
    const code = index.toString(36);
    const sourceEventId = `s${code}`;
    const eventId = `e${code}`;
    const alertSubject = `volcano:alert:${code}`;
    const eruptionSubject = `volcano:eruption:${code}`;
    const ashfallSubject = `volcano:ashfall:${code}`;
    const alert = {
      volcanoCode: code,
      volcanoName: "v",
      alertLevel: 4,
      alertLevelCode: "4",
      action: "issue" as const,
      reportDateTime,
      alertClass: null,
      warningKind: "w",
      targetKinds: [],
      sourceFamily: "VFVO50" as const,
      revision: { reportTimeMs, serial: null },
      appliedSemanticKey: semanticKey,
    };
    const eruption = {
      volcanoName: "v",
      latestEvent: {
        label: "e",
        craterName: null,
        eventDateTime: null,
        plumeHeightM: null,
        plumeHeightUnknown: false,
        plumeDirection: null,
      },
      latestEventId: eventId,
      eventExpiresAtMs: reportTimeMs + 24 * 60 * 60_000,
      revision: { reportTimeMs, serial: null },
      appliedSemanticKey: semanticKey,
    };
    const ashfall = {
      stateSubjectKey: ashfallSubject,
      volcanoCode: code,
      volcanoName: "v",
      eventId,
      sourceType: "VFVO54" as const,
      sourceEventId,
      forecastStartsAtMs: reportTimeMs,
      forecastEndsAtMs: reportTimeMs + 1,
      groups: [{
        hazardClass: "unknown" as const,
        ashCode: "x",
        ashName: "y",
        areaCount: 1,
        topAreas: [{
          identityKey: "area:name:a",
          code: null,
          name: "a",
          firstForecastEndAtMs: reportTimeMs + 1,
        }],
        omittedAreaCount: 0,
      }],
      omittedGroupCount: 0,
      revision: { reportTimeMs, serial: null },
      appliedSemanticKey: semanticKey,
      generation: 1,
    };
    composites.push({
      volcanoCode: code,
      volcanoName: "v",
      sourceEventIds: [sourceEventId],
      alert: activeAllSlices ? alert : null,
      eruption: activeAllSlices ? eruption : null,
      ashfall,
    });
    restored.push({ volcanoCode: code, alert: false, eruption: false, ashfall: false });
    gateStates.push(
      {
        key: `volcano:volcanoAlert:${alertSubject}`,
        comparison: comparison(alertSubject, "volcanoAlert", activeAllSlices ? "発表" : "取消"),
        semanticKeys: [semanticKey],
        cancelled: !activeAllSlices,
        acceptedAtMs: reportTimeMs,
        durable: true,
        tombstoneRetentionMs: 30 * 24 * 60 * 60_000,
        retainForFamilyCapacity: false,
        legacyRevisionKey: alertSubject,
        legacyRevisionKeyProvenance: "codeFallback",
        volcanoProvenance: { kind: "alert", sourceFamily: "VFVO50" },
      },
      {
        key: `volcano:volcanoEruption:${eruptionSubject}`,
        comparison: comparison(eruptionSubject, "volcanoEruption", activeAllSlices ? "発表" : "取消"),
        semanticKeys: [semanticKey],
        cancelled: !activeAllSlices,
        acceptedAtMs: reportTimeMs,
        durable: true,
        tombstoneRetentionMs: 2 * 24 * 60 * 60_000,
        retainForFamilyCapacity: false,
        legacyRevisionKey: `volcano:event:${eventId}`,
        legacyRevisionKeyProvenance: "eventId",
      },
      {
        key: `volcano:volcanoAshfall:${ashfallSubject}`,
        comparison: comparison(ashfallSubject, "volcanoAshfall", "発表", 0),
        semanticKeys: [semanticKey],
        cancelled: false,
        acceptedAtMs: reportTimeMs,
        durable: true,
        tombstoneRetentionMs: 7 * 24 * 60 * 60_000,
        retainForFamilyCapacity: false,
        legacyRevisionKey: ashfallSubject,
        legacyRevisionKeyProvenance: "codeFallback",
        volcanoProvenance: { kind: "ashfall", actualEventId: eventId, sourceType: "VFVO54" },
      },
    );
  }
  domains.telegramRevisionGate = {
    version: 1,
    states: gateStates,
    transientStates: [],
    transientSemanticKeys: [],
    warnedFamilyCapacity: [],
  };
  domains.volcanoHolderAndRepair.holder = {
    version: 1,
    composites,
    restored,
    legacyEruptionIdentities: [],
  };
  const standby = StandbyStateStore.fromSnapshot(domains.standbyStateStore);
  standby.replaceVolcanoDerived(domains.volcanoHolderAndRepair.holder);
  domains.standbyStateStore = standby.cloneSnapshot();
  return { domains, standby };
}

function cancelledCapacityGate(
  domain: string,
  revisionFamily: string,
  stateSubjectKey: string,
  tombstoneRetentionMs: number | null,
  acceptedAtMs: number,
  cancelled = true,
  legacyRevisionKey: string | null = null,
): TelegramRevisionGateSnapshot["states"][number] {
  const reportDateTime = new Date(acceptedAtMs).toISOString();
  const infoType = cancelled ? "取消" as const : "発表" as const;
  return {
    key: `${domain}:${revisionFamily}:${stateSubjectKey}`,
    comparison: {
      stateSubjectKey,
      revision: {
        eventId: { raw: stateSubjectKey, value: stateSubjectKey, valid: true },
        type: { raw: revisionFamily, value: revisionFamily, valid: true },
        reportDateTime: { raw: reportDateTime, epochMs: acceptedAtMs, valid: true },
        serial: { raw: "1", numeric: 1, valid: true },
        infoType: { raw: infoType, value: infoType, valid: true },
      },
    },
    semanticKeys: [`${infoType}:${"f".repeat(64)}`],
    cancelled,
    acceptedAtMs,
    durable: true,
    tombstoneRetentionMs,
    retainForFamilyCapacity: false,
    legacyRevisionKey,
    legacyRevisionKeyProvenance: legacyRevisionKey == null ? null : "eventId",
  };
}

function completionOwnedCancelledCapacityGate(
  family: "VPTA50" | "VPWP50",
  subject: string,
  eventId: string,
  acceptedAtMs: number,
): TelegramRevisionGateSnapshot["states"][number] {
  const domain = family === "VPTA50"
    ? "typhoonProbability"
    : "weatherWarningTimeseries";
  const retentionMs = family === "VPTA50"
    ? TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs
    : WEATHER_TIMESERIES_RETENTION_MS;
  const gate = cancelledCapacityGate(
    domain,
    family,
    subject,
    retentionMs,
    acceptedAtMs,
    true,
    family === "VPTA50" ? eventId : null,
  );
  gate.comparison.revision.eventId = { raw: eventId, value: eventId, valid: true };
  gate.comparison.revision.type = { raw: family, value: family, valid: true };
  gate.semanticKeys = [`取消:${"f".repeat(64)}`];
  if (family === "VPWP50") {
    gate.legacyRevisionKey = subject;
    gate.legacyRevisionKeyProvenance = null;
  }
  return gate;
}

function allDomainCapacityDomains(
  volcanoProfile: "active-all-slices" | "admissible-maximum",
): StandbyPersistenceDomainSnapshots {
  const { domains } = maximumVolcanoCapacityDomains(volcanoProfile);
  const acceptedAtMs = Date.parse("2026-08-31T00:00:00.000Z");
  const addFamily = (
    domain: string,
    revisionFamily: string,
    subjects: readonly string[],
    tombstoneRetentionMs: number | null,
    cancelled = true,
  ): void => {
    domains.telegramRevisionGate.states.push(...subjects.map((subject) =>
      cancelledCapacityGate(
        domain,
        revisionFamily,
        subject,
        tombstoneRetentionMs,
        acceptedAtMs,
        cancelled,
      )));
  };
  addFamily(
    "weather",
    "VPWS50",
    [
      "weather:vpws50",
      ...Array.from({ length: 128 }, (_, index) => `weather:VPWW55:o${index}`),
    ],
    VPWS50_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  );
  addFamily(
    "weather",
    "VPWW56",
    Array.from({ length: 128 }, (_, index) => `weather:VPWW56:o${index}`),
    VPWW56_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  );
  addFamily(
    "tsunami",
    "VTSE41",
    Array.from({ length: 512 }, (_, index) => `tsunami:e${index}`),
    TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.tombstoneRetentionMs,
  );
  for (const family of ["VTSE51", "VTSE52"] as const) {
    addFamily(
      "tsunamiObservation",
      family,
      [
        `tsunami:observations:${family}`,
        ...Array.from({ length: 1_024 }, (_, index) => String(index + 1)),
      ],
      TSUNAMI_REVISION_FAMILY_POLICIES[family].tombstoneRetentionMs,
      volcanoProfile === "admissible-maximum",
    );
  }
  addFamily(
    "floodForecast",
    "floodForecast",
    Array.from({ length: 512 }, (_, index) => `flood:event:e${index}`),
    FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  );
  addFamily(
    "tornado",
    "tornado",
    Array.from({ length: 128 }, (_, index) => `tornado:o${index}`),
    TORNADO_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
    false,
  );
  addFamily(
    "heatAlert",
    "VPFT50",
    Array.from({ length: 256 }, (_, index) => `heat:d${index}`),
    HEAT_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
    false,
  );
  addFamily(
    "typhoonAnalysis",
    "typhoonAnalysis",
    Array.from({ length: 64 }, (_, index) => `typhoon:t${index}`),
    TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
    false,
  );
  addFamily(
    "nankaiTrough",
    "nankaiTrough",
    ["nankai:current"],
    NANKAI_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
    false,
  );
  const nankaiGate = domains.telegramRevisionGate.states.find((entry) =>
    entry.key === "nankaiTrough:nankaiTrough:nankai:current");
  if (nankaiGate == null) throw new Error("nankai capacity gate missing");
  nankaiGate.legacyRevisionKey = "n";
  nankaiGate.legacyRevisionKeyProvenance = "eventId";
  addFamily(
    "lgObservation",
    "VXSE62",
    Array.from({ length: 256 }, (_, index) => `longPeriod:e${index}`),
    LG_OBSERVATION_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
    false,
  );
  const completionOwnedFamilyCount = volcanoProfile === "active-all-slices"
    ? { vpta50: 256, vpwp50: 512 }
    : { vpta50: 1, vpwp50: 1 };
  domains.telegramRevisionGate.states.push(
    ...Array.from({ length: completionOwnedFamilyCount.vpta50 }, (_, index) => {
      const eventId = `TC${String(index).padStart(4, "0")}`;
      return completionOwnedCancelledCapacityGate(
        "VPTA50",
        `typhoonProbability:${eventId}`,
        eventId,
        acceptedAtMs,
      );
    }),
    ...Array.from({ length: completionOwnedFamilyCount.vpwp50 }, (_, index) => {
      const subject = `weatherTimeseries:o${index}:code:${index}`;
      return completionOwnedCancelledCapacityGate(
        "VPWP50",
        subject,
        subject,
        acceptedAtMs,
      );
    }),
  );
  const tsunamiObservation = (index: number) => ({
    areaName: null,
    areaCode: null,
    stationCode: String(index + 1),
    name: "n",
    sensor: "s",
    arrivalTime: "",
    initial: "",
    maxHeightCondition: "",
    maxHeightValue: null,
    maxHeight: {
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing" as const,
    },
    maxHeightValueCondition: "",
  });
  domains.tsunamiState.observationGroups = {
    VTSE51: volcanoProfile === "active-all-slices"
      ? Array.from({ length: 1_024 }, (_, index) => tsunamiObservation(index))
      : [],
    VTSE52: volcanoProfile === "active-all-slices"
      ? Array.from({ length: 1_024 }, (_, index) => tsunamiObservation(index))
      : [],
  };

  const reportDateTime = new Date(acceptedAtMs).toISOString();
  const expiresAtMs = acceptedAtMs + 24 * 60 * 60_000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const briefingEntries = Array.from({ length: 128 }, (_, index) => {
    const editorialOffice = `o${index}`;
    const semanticKey = `card:vpbs:semantic:linearRainObserved:${editorialOffice}`;
    const frameLevel = index < 64 ? "critical" as const : "cancel" as const;
    const entry: DisplayBriefingEntryV1 = {
      key: semanticKey,
      source: "vpbs50",
      sourceEventId: `s${index}`,
      editorialOffice,
      phenomenonKind: "linearRainObserved",
      semanticKey,
      serial: "1",
      title: "",
      headline: null,
      conditions: [],
      targetAreas: [],
      reportDateTime,
      publishingOffice: "",
      infoType: frameLevel === "cancel" ? "取消" : "発表",
      frameLevel,
      severityEvidence: [],
      qualifier: null,
      updatedAt: reportDateTime,
      expiresAt,
      generation: 1,
    };
    return { entry, updatedAtMs: acceptedAtMs, expiresAtMs };
  });
  const briefingCritical: PersistedBriefingCriticalStateV1 = {
    generation: 1,
    entries: briefingEntries.slice(0, 64),
    cancellations: briefingEntries.slice(64),
    watermarks: [
      ...briefingEntries.map(({ entry }) => ({
        semanticKey: entry.semanticKey!,
        revision: { reportTimeMs: acceptedAtMs, serial: "1" },
        expiresAtMs,
      })),
      ...Array.from({ length: 384 }, (_, index) => ({
        semanticKey: `unused:${index}`,
        revision: { reportTimeMs: acceptedAtMs, serial: "1" },
        expiresAtMs,
      })),
    ],
    rawAliases: Array.from({ length: 512 }, (_, index) => ({
      source: index % 2 === 0 ? "vpbs50" as const : "vpoa50" as const,
      sourceEventId: `a${index}`,
      semanticKey: `alias:${index}`,
      revision: { reportTimeMs: acceptedAtMs, serial: "1" },
      expiresAtMs,
    })),
  };
  const standby = StandbyStateStore.fromSnapshot(domains.standbyStateStore);
  const projection = standby.exportActiveState();
  const appliedSemanticKey = `発表:${"f".repeat(64)}`;
  projection.heat = Array.from({ length: 256 }, (_, index) => ({
    key: `heat:d${index}`,
    sourceEventIds: [`h${index}`],
    targetDate: "d",
    targetDateEndMs: expiresAtMs,
    areas: [{ areaName: "a", isSpecial: false }],
    isSpecial: false,
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    appliedSemanticKey,
  }));
  projection.typhoons = Array.from({ length: 64 }, (_, index) => ({
    key: `t${index}`,
    sourceEventId: `t${index}`,
    typhoon: {
      typhoonKey: `t${index}`,
      name: null,
      nameKana: null,
      remark: null,
      typhoonNumber: null,
      category: null,
      location: null,
      pressureHpa: null,
      maxWindMs: null,
      moveDirection: null,
      moveSpeedKmh: null,
      reportDateTime,
    },
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    expiresAtMs,
    appliedSemanticKey,
  }));
  projection.tornado = Array.from({ length: 128 }, (_, index) => ({
    publishingOffice: `o${index}`,
    sourceEventId: `r${index}`,
    areas: ["a"],
    isSighted: false,
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    expiresAtMs,
    appliedSemanticKey,
  }));
  projection.longPeriod = Array.from({ length: 256 }, (_, index) => ({
    eventId: `e${index}`,
    maxLgInt: "1",
    safetyRank: 1,
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    hosted: false,
    expiresAtMs,
    appliedSemanticKey,
  }));
  projection.nankaiTrough = {
    sourceEventId: "n",
    statusCode: "x",
    label: "l",
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    expiresAtMs,
    appliedSemanticKey,
  };
  projection.briefingCritical = briefingCritical;
  projection.quakeHost = {
    eventId: "q",
    maxIntRank: 7,
    revision: { reportTimeMs: acceptedAtMs, serial: "1" },
    expiresAtMs,
  };
  standby.restoreActiveState(projection, acceptedAtMs - 1);
  standby.replaceVolcanoDerived(domains.volcanoHolderAndRepair.holder);
  domains.standbyStateStore = standby.cloneSnapshot();
  return domains;
}

function allDomainCountMaximumDomains(): StandbyPersistenceDomainSnapshots {
  return allDomainCapacityDomains("active-all-slices");
}

function allDomainMaxAdmissibleDomains(): StandbyPersistenceDomainSnapshots {
  return allDomainCapacityDomains("admissible-maximum");
}

function denseTsunamiCapacityDomains(): StandbyPersistenceDomainSnapshots {
  const { domains } = maximumVolcanoCapacityDomains("admissible-maximum", 1);
  const acceptedAtMs = Date.parse("2026-08-31T00:00:00.000Z");
  const longStationName = "x".repeat(3_850);
  const wholeSubject = "tsunami:observations:VTSE51";
  domains.telegramRevisionGate.states.push(
    cancelledCapacityGate(
      "tsunamiObservation",
      "VTSE51",
      wholeSubject,
      TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.tombstoneRetentionMs,
      acceptedAtMs,
      false,
    ),
    ...Array.from({ length: 1_024 }, (_, index) => cancelledCapacityGate(
      "tsunamiObservation",
      "VTSE51",
      String(index + 1),
      TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.tombstoneRetentionMs,
      acceptedAtMs,
      false,
    )),
  );
  domains.tsunamiState.observationGroups.VTSE51 = Array.from({ length: 1_024 }, (_, index) => ({
    areaName: null,
    areaCode: null,
    stationCode: String(index + 1),
    name: longStationName,
    sensor: "s",
    arrivalTime: "",
    initial: "",
    maxHeightCondition: "",
    maxHeightValue: null,
    maxHeight: {
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing" as const,
    },
    maxHeightValueCondition: "",
  }));
  return domains;
}

function operationalVolcanoHarness(options: {
  active?: boolean;
  cancelled?: boolean;
  scope?: "volcano" | "domain";
  serializePair?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
  ) => { v2: Uint8Array; v1: Uint8Array };
} = {}) {
  const active = options.active !== false;
  const scope = options.scope ?? "volcano";
  const { owners, coordinator } = admissionHarness({
    ...(options.serializePair == null ? {} : { serializePair: options.serializePair }),
  });
  const reportDateTime = "2026-08-31T00:00:00.000Z";
  const reportTimeMs = Date.parse(reportDateTime);
  const subject = "volcano:alert:506";
  if (scope === "volcano") {
    const meta = createTelegramMeta({
      messageId: "operational-source-506",
      eventId: "operational-event-506",
      type: "VFVO50",
      reportDateTime,
      serial: "1",
      infoType: "発表",
      receivedAtMs: reportTimeMs,
      status: "通常",
      isTest: false,
    });
    const policy = VOLCANO_ALERT_REVISION_FAMILY_POLICY;
    const decision = owners.telegramRevisionGate.decide({
      domain: policy.domain,
      revisionFamily: policy.revisionFamily,
      stateSubjectKey: subject,
      meta,
      comparator: policy.comparator,
      cancellationPolicy: policy.cancellationPolicy,
      terminal: false,
      durable: true,
      tombstoneRetentionMs: policy.tombstoneRetentionMs,
      maxSubjects: policy.maxSubjects,
      familyCapacityMode: policy.familyCapacityMode,
      allowMissingSerial: policy.allowMissingSerial,
      payloadFingerprint: "operational-seed",
      legacyRevisionKey: subject,
      legacyRevisionKeyProvenance: "codeFallback",
      volcanoProvenance: { kind: "alert", sourceFamily: "VFVO50" },
    });
    if (!decision.accepted) throw new Error("operational seed was rejected");
  }
  const domains = structuredClone(coordinator.capture().domains) as StandbyPersistenceDomainSnapshots;
  const gate = domains.telegramRevisionGate.states.find((entry) =>
    entry.key === `volcano:volcanoAlert:${subject}`);
  if (scope === "volcano" && gate == null) throw new Error("operational seed gate missing");
  if (gate != null) {
    gate.cancelled = options.cancelled === true;
    gate.volcanoProvenance = { kind: "alert", sourceFamily: "operationalV2Unknown" };
  }
  if (scope === "volcano" && active) {
    const semanticKey = gate?.semanticKeys.at(-1);
    if (semanticKey == null) throw new Error("operational seed semantic key missing");
    domains.volcanoHolderAndRepair.holder = {
      version: 0,
      composites: [{
        volcanoCode: "506",
        volcanoName: "桜島",
        sourceEventIds: ["operational-source-506"],
        alert: {
          volcanoCode: "506",
          volcanoName: "桜島",
          alertLevel: 3,
          alertLevelCode: "13",
          action: "issue",
          reportDateTime,
          alertClass: null,
          warningKind: "噴火警報（火口周辺）",
          targetKinds: ["火口周辺警報"],
          sourceFamily: "operationalV2Unknown",
          revision: { reportTimeMs, serial: "1" },
          appliedSemanticKey: semanticKey,
        },
        eruption: null,
        ashfall: null,
      }],
      restored: [{ volcanoCode: "506", alert: false, eruption: false, ashfall: false }],
      legacyEruptionIdentities: [],
    };
    const standby = StandbyStateStore.fromSnapshot(domains.standbyStateStore);
    standby.replaceVolcanoDerived(domains.volcanoHolderAndRepair.holder);
    domains.standbyStateStore = standby.cloneSnapshot();
  }
  const repair = emptyVolcanoRepairState();
  repair.vfvo50Repairable = true;
  repair.unrecoverableAlertOmissions = scope === "domain"
    ? [{
        scope: "domain",
        volcanoCode: null,
        sourceFamily: "unknown",
        lastKnownComparison: null,
        reason: "operationalV2ProvenanceLost",
      }]
    : [{
        scope: "volcano",
        volcanoCode: "506",
        sourceFamily: "unknown",
        lastKnownComparison: structuredClone(gate!.comparison),
        reason: "operationalV2ProvenanceLost",
      }];
  domains.volcanoHolderAndRepair.repair = repair;
  coordinator.restorePrevalidated(domains);
  return {
    owners,
    admission: coordinator,
    volcano: new VolcanoTransactionCoordinator(
      coordinator,
      () => Date.parse("2026-09-01T00:00:00.000Z"),
    ),
  };
}

beforeEach(() => {
  mockStartDisplayRuntime.mockReset();
  mockSetActiveDisplayRuntime.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standby monitor wiring", () => {
  it("same 128 codeの三family最大fixtureをactual pair serializerとwire projectionで固定する", () => {
    const fixturePath = join(
      process.cwd(),
      "test", "fixtures", "standby-persistence", "volcano-capacity-expectations.json",
    );
    const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      limits: Record<string, number>;
      fixture: {
        logicalGeneration: string;
        savedAt: string;
        counts: Record<string, number>;
        bytes: Record<string, number>;
      };
    };
    expect(expected.limits).toEqual({
      alertSubjects: 128,
      eruptionSubjects: 128,
      ashfallSubjects: 128,
      activeComposites: 128,
      rollbackRecords: 128,
      sourceEventIdsPerComposite: 4096,
      volcanoSubtreeBytesPerFile: VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE,
      standbyFileBytesPerFile: STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE,
      wireAshfallSlices: VOLCANO_ASHFALL_MAX_WIRE_SLICES,
      volcanoCardBytes: VOLCANO_CARD_MAX_WIRE_BYTES,
    });

    const { domains, standby } = maximumVolcanoCapacityDomains();
    const persistence = new StandbyPersistence(join(tmpdir(), "fleq-capacity-not-written.json"));
    const envelope = {
      logicalGeneration: expected.fixture.logicalGeneration,
      savedAt: expected.fixture.savedAt,
    };
    const measurement = measureStandbyAdmissionPair(persistence, domains, envelope);
    const card = standby.snapshotItems().find((item) => item.kind === "volcano");
    if (card?.kind !== "volcano") throw new Error("maximum volcano card missing");
    const visibleAshfall = card.data.volcanoes.filter((volcano) => volcano.ashfall != null).length;
    const actual = {
      counts: {
        alertSubjects: domains.telegramRevisionGate.states.filter(
          (entry) => entry.key.startsWith("volcano:volcanoAlert:"),
        ).length,
        eruptionSubjects: domains.telegramRevisionGate.states.filter(
          (entry) => entry.key.startsWith("volcano:volcanoEruption:"),
        ).length,
        ashfallSubjects: domains.telegramRevisionGate.states.filter(
          (entry) => entry.key.startsWith("volcano:volcanoAshfall:"),
        ).length,
        activeComposites: domains.volcanoHolderAndRepair.holder.composites.length,
        v2RollbackRecords: domains.volcanoHolderAndRepair.holder.composites.length,
        v1RollbackRecords: domains.volcanoHolderAndRepair.holder.composites.length,
        wireAshfallSlices: visibleAshfall,
        wireOmittedAshfallSlices: card.data.ashfallOmittedCount ?? 0,
      },
      bytes: {
        v2VolcanoSubtree: measurement.v2VolcanoSubtreeBytes,
        v1VolcanoSubtree: measurement.v1VolcanoSubtreeBytes,
        v2File: measurement.v2FileBytes,
        v1File: measurement.v1FileBytes,
        completedVolcanoCard: Buffer.byteLength(JSON.stringify(card), "utf8"),
      },
    };
    expect(actual).toEqual({ counts: expected.fixture.counts, bytes: expected.fixture.bytes });
    expect(actual.bytes.v2VolcanoSubtree).toBeGreaterThan(
      VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE,
    );
    expect(actual.bytes.v1VolcanoSubtree).toBeLessThanOrEqual(
      VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE,
    );
    expect(actual.bytes.v2File).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(actual.bytes.v1File).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(actual.bytes.completedVolcanoCard).toBeLessThanOrEqual(VOLCANO_CARD_MAX_WIRE_BYTES);
    expect(() => serializeStandbyAdmissionPair(persistence, domains, envelope))
      .toThrow("standby persistence volcano subtree byte limit exceeded");
  });

  it("canonical holderとstandby volcano mirrorの不一致をwriter前に拒否する", () => {
    const { domains } = maximumVolcanoCapacityDomains();
    const first = domains.standbyStateStore.data.volcanoes.values().next().value;
    if (first == null) throw new Error("volcano mirror fixture missing");
    first.name = "mismatched mirror";
    const persistence = new StandbyPersistence(join(tmpdir(), "fleq-mismatch-not-written.json"));

    expect(() => serializeStandbyAdmissionPair(persistence, domains, {
      logicalGeneration: "1",
      savedAt: "2026-08-31T00:00:00.000Z",
    })).toThrow("standby volcano mirror coupling mismatch");
  });

  it("all-domain count maximum manifestがdurable admission matrixを欠落なく固定する", () => {
    const fixturePath = join(
      process.cwd(),
      "test", "fixtures", "standby-persistence", "standby-all-domain-capacity-expectations.json",
    );
    const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      fullFileByteLimit: number;
      countMaximum: Record<string, number>;
      fixtures: Record<string, {
        expectedAdmission: string;
        truncationAllowed?: boolean;
        logicalGeneration?: string;
        savedAt?: string;
        bytes?: {
          v2File: number;
          v1File: number;
          v2VolcanoSubtree: number;
          v1VolcanoSubtree: number;
        };
      }>;
    };
    expect(expected.fullFileByteLimit).toBe(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(expected.countMaximum).toEqual({
      "weather:VPWS50": 129,
      "weather:VPWW56": 128,
      "tsunami:VTSE41": 512,
      "tsunamiObservation:VTSE51": 1025,
      "tsunamiObservation:VTSE52": 1025,
      "volcano:volcanoAlert": 128,
      "volcano:volcanoEruption": 128,
      "volcano:volcanoAshfall": 128,
      "floodForecast:floodForecast": 512,
      "standby:tornado": 128,
      "standby:heatAlert": 256,
      "standby:typhoonAnalysis": 64,
      "typhoonProbability:VPTA50": 256,
      "weatherWarningTimeseries:VPWP50": 512,
      "standby:nankaiTrough": 1,
      "standby:lgObservation": 256,
      "standby:briefingCritical.activeAndCancellation": 128,
      "standby:briefingCritical.watermark": 512,
      "standby:briefingCritical.rawAlias": 512,
      "standby:quakeHost": 1,
    });
    const manifestDomains = allDomainMaxAdmissibleDomains();
    const manifestPersistence = new StandbyPersistence(
      join(tmpdir(), "fleq-all-domain-manifest-not-written.json"),
    );
    const manifestPair = serializeStandbyAdmissionPair(
      manifestPersistence,
      manifestDomains,
      {
        logicalGeneration: "18446744073709551615",
        savedAt: "+275760-09-13T00:00:00.000Z",
      },
    );
    const persisted = JSON.parse(Buffer.from(manifestPair.v2).toString("utf8")) as {
      briefingCritical?: unknown;
      quakeHost?: unknown;
      telegramFoundation: Record<string, { gateEntries?: Array<{
        domain: string;
        revisionFamily: string;
      }> }>;
    };
    const durablePolicyFamilyKeys = [...new Set(
      ALL_REVISION_FAMILY_POLICIES
        .filter((policy) => policy.durable)
        .map((policy) => `${policy.domain}:${policy.revisionFamily}`),
    )].sort();
    const coordinatorFamilyKeys = Object.keys(
      STANDBY_PERSISTED_FAMILY_DURABLE_KEYS,
    ).sort();
    const persistedFamilyKeys = [...new Set(
      Object.values(persisted.telegramFoundation).flatMap((foundation) =>
        (foundation.gateEntries ?? []).map((entry) =>
          `${entry.domain}:${entry.revisionFamily}`)),
    )].sort();
    expect(coordinatorFamilyKeys).toEqual(durablePolicyFamilyKeys);
    expect(persistedFamilyKeys).toEqual(durablePolicyFamilyKeys);
    const pairDurableKeys = new Set(persistedFamilyKeys.map((family) =>
      STANDBY_PERSISTED_FAMILY_DURABLE_KEYS[family]!));
    const writerRootDurableKeys = Object.entries(STANDBY_WRITER_ROOT_DURABLE_KEYS)
      .flatMap(([root, durableKey]) => persisted[root as keyof typeof persisted] == null
        ? []
        : [durableKey])
      .sort();
    expect(writerRootDurableKeys).toEqual(
      Object.values(STANDBY_WRITER_ROOT_DURABLE_KEYS).sort(),
    );
    for (const durableKey of writerRootDurableKeys) pairDurableKeys.add(durableKey);
    expect([...pairDurableKeys].sort()).toEqual(
      Object.keys(STANDBY_EXPECTED_TOUCHED_OWNERS).sort(),
    );
    expect([...new Set(Object.keys(expected.countMaximum).map((key) =>
      key.startsWith("standby:briefingCritical.")
        ? "standby:briefingCritical"
        : key))].sort()).toEqual([...pairDurableKeys].sort());
    const matrixKeys = Object.keys(STANDBY_EXPECTED_TOUCHED_OWNERS);
    expect(matrixKeys.every((key) =>
      Object.hasOwn(expected.countMaximum, key)
      || key === "standby:briefingCritical" && [
        "standby:briefingCritical.activeAndCancellation",
        "standby:briefingCritical.watermark",
        "standby:briefingCritical.rawAlias",
      ].every((subkey) => Object.hasOwn(expected.countMaximum, subkey))))
      .toBe(true);
    const countMaximum = expected.fixtures["all-domains-count-maximum"]!;
    expect(countMaximum.expectedAdmission).toBe("atomic-rejection-if-over-byte-limit");
    expect(countMaximum.truncationAllowed).toBe(false);
    expect(expected.fixtures["all-domains-max-admissible"]?.expectedAdmission)
      .toBe("commit-and-lossless-reload");

    const domains = allDomainCountMaximumDomains();
    const durableEntries = TelegramRevisionGate
      .fromSnapshot(domains.telegramRevisionGate)
      .exportDurableEntries();
    const familyCount = (domain: string, revisionFamily: string): number =>
      durableEntries.filter((entry) =>
        entry.domain === domain && entry.revisionFamily === revisionFamily).length;
    const active = StandbyStateStore.fromSnapshot(domains.standbyStateStore).exportActiveState();
    expect({
      "weather:VPWS50": familyCount("weather", "VPWS50"),
      "weather:VPWW56": familyCount("weather", "VPWW56"),
      "tsunami:VTSE41": familyCount("tsunami", "VTSE41"),
      "tsunamiObservation:VTSE51": familyCount("tsunamiObservation", "VTSE51"),
      "tsunamiObservation:VTSE52": familyCount("tsunamiObservation", "VTSE52"),
      "volcano:volcanoAlert": familyCount("volcano", "volcanoAlert"),
      "volcano:volcanoEruption": familyCount("volcano", "volcanoEruption"),
      "volcano:volcanoAshfall": familyCount("volcano", "volcanoAshfall"),
      "floodForecast:floodForecast": familyCount("floodForecast", "floodForecast"),
      "standby:tornado": active.tornado?.length ?? 0,
      "standby:heatAlert": active.heat.length,
      "standby:typhoonAnalysis": active.typhoons?.length ?? 0,
      "typhoonProbability:VPTA50": familyCount("typhoonProbability", "VPTA50"),
      "weatherWarningTimeseries:VPWP50": familyCount(
        "weatherWarningTimeseries",
        "VPWP50",
      ),
      "standby:nankaiTrough": active.nankaiTrough == null ? 0 : 1,
      "standby:lgObservation": active.longPeriod?.length ?? 0,
      "standby:briefingCritical.activeAndCancellation":
        (active.briefingCritical?.entries.length ?? 0)
        + (active.briefingCritical?.cancellations.length ?? 0),
      "standby:briefingCritical.watermark": active.briefingCritical?.watermarks.length ?? 0,
      "standby:briefingCritical.rawAlias": active.briefingCritical?.rawAliases?.length ?? 0,
      "standby:quakeHost": active.quakeHost == null ? 0 : 1,
    }).toEqual(expected.countMaximum);
    const persistence = new StandbyPersistence(join(tmpdir(), "fleq-all-domain-not-written.json"));
    const measurement = measureStandbyAdmissionPair(persistence, domains, {
      logicalGeneration: countMaximum.logicalGeneration!,
      savedAt: countMaximum.savedAt!,
    });
    expect(measurement).toEqual({
      v2FileBytes: countMaximum.bytes!.v2File,
      v1FileBytes: countMaximum.bytes!.v1File,
      v2VolcanoSubtreeBytes: countMaximum.bytes!.v2VolcanoSubtree,
      v1VolcanoSubtreeBytes: countMaximum.bytes!.v1VolcanoSubtree,
    });
    // full-file 上限 16MiB 引き上げ後、全 domain count 最大でも full-file は収まる。
    // 原子的 rejection を担うのは据え置きの火山 subtree 1MiB 上限。
    expect(measurement.v2FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v2VolcanoSubtreeBytes)
      .toBeGreaterThan(VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE);
    expect(() => serializeStandbyAdmissionPair(persistence, domains, {
      logicalGeneration: countMaximum.logicalGeneration!,
      savedAt: countMaximum.savedAt!,
    })).toThrow("standby persistence volcano subtree byte limit exceeded");
  });

  it("all-domain max-admissible fixtureはactual pairを両上限内でlossless save/reloadする", () => {
    const fixturePath = join(
      process.cwd(),
      "test", "fixtures", "standby-persistence", "standby-all-domain-capacity-expectations.json",
    );
    const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      fixtures: Record<string, {
        logicalGeneration?: string;
        savedAt?: string;
        bytes?: {
          v2File: number;
          v1File: number;
          v2VolcanoSubtree: number;
          v1VolcanoSubtree: number;
        };
      }>;
    };
    const fixture = expected.fixtures["all-domains-max-admissible"]!;
    const domains = allDomainMaxAdmissibleDomains();
    const persistence = new StandbyPersistence(join(tmpdir(), "fleq-all-domain-admissible.json"));
    const measurement = measureStandbyAdmissionPair(persistence, domains, {
      logicalGeneration: fixture.logicalGeneration!,
      savedAt: fixture.savedAt!,
    });
    expect(measurement).toEqual({
      v2FileBytes: fixture.bytes!.v2File,
      v1FileBytes: fixture.bytes!.v1File,
      v2VolcanoSubtreeBytes: fixture.bytes!.v2VolcanoSubtree,
      v1VolcanoSubtreeBytes: fixture.bytes!.v1VolcanoSubtree,
    });
    expect(measurement.v2FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v1FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v2VolcanoSubtreeBytes)
      .toBeLessThanOrEqual(VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE);
    expect(measurement.v1VolcanoSubtreeBytes)
      .toBeLessThanOrEqual(VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE);

    const root = mkdtempSync(join(tmpdir(), "fleq-all-domain-admissible-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const writer = new StandbyPersistence(path);
    const envelope = writer.reserveSerializationEnvelope("2026-08-31T00:00:00.000Z");
    const pair = serializeStandbyAdmissionPair(writer, domains, envelope);
    expect(writer.saveSerializedPair(pair).kind).toBe("written");
    expect(readFileSync(path)).toEqual(Buffer.from(pair.v1));
    expect(readFileSync(standbyPersistenceV2Path(path))).toEqual(Buffer.from(pair.v2));

    const expectedV2 = JSON.parse(Buffer.from(pair.v2).toString("utf8"));
    // The deprecated scalar tsunami migration input is normalized to explicit
    // null by the reader; keyedActive/legacyActive remain the semantic owners.
    expectedV2.telegramFoundation.tsunami.active = null;
    // Canonical VPTA gates own their revision after v2 load.  The root `seen`
    // entry exists only as the standalone-v1 rollback mirror and is discarded
    // from the normalized v2 runtime envelope.
    const vptaLegacySeenKeys = new Set<string>(
      expectedV2.telegramFoundation.standbyDomains.gateEntries
        .filter((entry: { domain: string; revisionFamily: string }) =>
          entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50")
        .flatMap((entry: { legacyRevisionKey?: string | null }) =>
          entry.legacyRevisionKey == null ? [] : [entry.legacyRevisionKey]),
    );
    expectedV2.seen = expectedV2.seen.filter(
      (entry: { key: string }) => !vptaLegacySeenKeys.has(entry.key),
    );
    const reader = new StandbyPersistence(path);
    const reloaded = reader.load(Date.parse("2026-08-31T00:00:00.000Z"));
    expect(reloaded).toEqual(expectedV2);
    expect(reader.takeMigrationConflictCount()).toBe(0);
    expect(reloaded?.telegramFoundation.tsunami.gateEntries).toHaveLength(2_562);
    expect(reloaded?.telegramFoundation.volcano.gateEntries).toHaveLength(384);
    expect(reloaded?.briefingCritical?.entries).toHaveLength(64);
    expect(reloaded?.briefingCritical?.cancellations).toHaveLength(64);
    expect(reloaded?.briefingCritical?.watermarks).toHaveLength(512);
    expect(reloaded?.briefingCritical?.rawAliases).toHaveLength(512);
  }, 15_000);

  it("dense VTSE51約4.85MB＋small volcanoは16MiB上限内でactual pairを組める", () => {
    const root = mkdtempSync(join(tmpdir(), "fleq-dense-tsunami-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(path);
    const envelope = {
      logicalGeneration: "18446744073709551615",
      savedAt: "+275760-09-13T00:00:00.000Z",
    };
    const dense = denseTsunamiCapacityDomains();
    const measurement = measureStandbyAdmissionPair(persistence, dense, envelope);
    expect(dense.volcanoHolderAndRepair.holder.composites).toHaveLength(1);
    expect(dense.tsunamiState.observationGroups.VTSE51).toHaveLength(1_024);
    expect(measurement.v2FileBytes).toBeGreaterThan(4_800_000);
    expect(measurement.v2FileBytes).toBeLessThan(4_900_000);
    // 旧 4MiB 上限では reject されていた密な観測点構成が、16MiB では受理される。
    expect(measurement.v2FileBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(measurement.v2FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v1FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v2VolcanoSubtreeBytes)
      .toBeLessThanOrEqual(VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE);
    const densePair = serializeStandbyAdmissionPair(persistence, dense, envelope);
    expect(densePair.v2.byteLength).toBe(measurement.v2FileBytes);
    expect(densePair.v1.byteLength).toBe(measurement.v1FileBytes);
  }, 15_000);

  const VPWS50_HEAVY_KINDS: PersistedVpws50KindV2[] = [
    {
      phenomenonKey: "大雨", kindCode: "33", kindName: "大雨特別警報",
      severity: "specialWarning", displaySeverity: "officialL5",
      officialAlertLevel: 5, resolutionSource: "map",
    },
    {
      phenomenonKey: "洪水", kindCode: "18", kindName: "洪水警報",
      severity: "warning", displaySeverity: "officialL3",
      officialAlertLevel: 3, resolutionSource: "map",
    },
    {
      phenomenonKey: "暴風雪", kindCode: "12", kindName: "暴風雪注意報",
      severity: "advisory", displaySeverity: "officialL2",
      officialAlertLevel: 2, resolutionSource: "map",
    },
  ];

  function vpws50HeavySnapshot(areaCount: number, tag: string): PersistedVpws50SnapshotV2 {
    return {
      generation: VPWS50_SNAPSHOT_GENERATION,
      areas: Array.from({ length: areaCount }, (_, index) => ({
        areaCode: `${tag}-${1_000_000 + index}`,
        areaName: `${tag}第${index}市町村`,
        kinds: VPWS50_HEAVY_KINDS.map((kind) => ({ ...kind })),
      })),
    };
  }

  /**
   * Pi 実機 (旧版が書いた v2, 5,202,939 bytes) と同型の「正当な最大構成」。
   * 全国 VPWS50 の current + history 8 件に加えて、VPWW55-61 の官署別
   * partialStreams 108 件 / partialHistory 84 群を持つ。
   */
  function vpws50NationalCapacityDomains(
    nationalAreas: number,
    partialAreas: number,
  ): StandbyPersistenceDomainSnapshots {
    const { coordinator } = admissionHarness();
    const domains = structuredClone(
      coordinator.capture().domains,
    ) as StandbyPersistenceDomainSnapshots;
    const currentAtMs = Date.parse("2026-08-31T09:00:00.000Z");
    const identityOf = (atMs: number) => ({
      reportDateTime: new Date(atMs).toISOString(),
      serial: "1",
    });
    const partialSubjects = Array.from(
      { length: 108 },
      (_, index) => `weather:VPWW55:o${index}`,
    );
    const activeGate = (subject: string) => cancelledCapacityGate(
      "weather",
      "VPWS50",
      subject,
      VPWS50_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
      currentAtMs,
      false,
    );
    domains.telegramRevisionGate.states.push(
      activeGate("weather:vpws50"),
      ...partialSubjects.map((subject) => activeGate(subject)),
    );
    const state: PersistedVpws50StateV2 = {
      current: {
        messageId: "vpws50-current",
        identity: identityOf(currentAtMs),
        snapshot: vpws50HeavySnapshot(nationalAreas, "全国"),
      },
      history: Array.from({ length: 8 }, (_, index) => ({
        messageId: `vpws50-history-${index}`,
        identity: identityOf(currentAtMs - (8 - index) * 60 * 60_000),
        snapshot: vpws50HeavySnapshot(nationalAreas, `履歴${index}`),
      })),
      partialStreams: partialSubjects.map((subjectKey, index) => ({
        subjectKey,
        messageId: `vpww55-${index}`,
        identity: identityOf(currentAtMs),
        snapshot: vpws50HeavySnapshot(partialAreas, `官署${index}`),
      })),
      partialHistory: partialSubjects.slice(0, 84).map((subjectKey, index) => ({
        subjectKey,
        entries: [{
          messageId: `vpww55-prev-${index}`,
          identity: identityOf(currentAtMs - 60 * 60_000),
          snapshot: vpws50HeavySnapshot(partialAreas, `官署履歴${index}`),
        }],
      })),
      lastSuccessfulFullDisplayAt: new Date(currentAtMs).toISOString(),
    };
    domains.vpws50State = { version: 2, state };
    return domains;
  }

  it("Pi実機相当の正当なVPWS50最大構成 (約5.2MB) がfull-file上限内でsave/reloadできる", () => {
    const domains = vpws50NationalCapacityDomains(690, 12);
    const envelope = {
      logicalGeneration: "18446744073709551615",
      savedAt: "+275760-09-13T00:00:00.000Z",
    };
    const measurePersistence = new StandbyPersistence(
      join(tmpdir(), "fleq-vpws50-national-not-written.json"),
    );
    const measurement = measureStandbyAdmissionPair(measurePersistence, domains, envelope);
    // 旧 4MiB 上限では reject されていた実サイズ帯であることを固定する。
    expect(measurement.v2FileBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(measurement.v2FileBytes).toBeGreaterThan(4_800_000);
    expect(measurement.v2FileBytes).toBeLessThan(6_000_000);
    expect(measurement.v2FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);
    expect(measurement.v1FileBytes).toBeLessThanOrEqual(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE);

    const root = mkdtempSync(join(tmpdir(), "fleq-vpws50-national-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const writer = new StandbyPersistence(path);
    const writeEnvelope = writer.reserveSerializationEnvelope("2026-08-31T09:00:00.000Z");
    const pair = serializeStandbyAdmissionPair(writer, domains, writeEnvelope);
    expect(writer.saveSerializedPair(pair).kind).toBe("written");

    const reader = new StandbyPersistence(path);
    const reloaded = reader.load(Date.parse("2026-08-31T09:00:00.000Z"));
    const loadResult = reader.lastLoadResult();
    expect(loadResult?.startup).toEqual({ kind: "restored", selectedSource: "v2" });
    expect(loadResult?.sourceStates.v2).toBe("valid");
    expect(reloaded?.telegramFoundation.vpws50.state?.history).toHaveLength(8);
    expect(reloaded?.telegramFoundation.vpws50.state?.current?.snapshot.areas)
      .toHaveLength(690);
    expect(reloaded?.telegramFoundation.vpws50.state?.partialStreams).toHaveLength(108);
    expect(reloaded?.telegramFoundation.vpws50.state?.partialHistory).toHaveLength(84);
  }, 30_000);

  it("readerのraw source上限はちょうど16MiBを受理し、+1でoversized降格する", () => {
    const root = mkdtempSync(join(tmpdir(), "fleq-raw-source-boundary-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const writer = new StandbyPersistence(path);
    const domains = vpws50NationalCapacityDomains(690, 12);
    const envelope = writer.reserveSerializationEnvelope("2026-08-31T00:00:00.000Z");
    const pair = serializeStandbyAdmissionPair(writer, domains, envelope);
    expect(writer.saveSerializedPair(pair).kind).toBe("written");

    const v2Path = standbyPersistenceV2Path(path);
    const padTo = (totalBytes: number): void => {
      const parsed = JSON.parse(readFileSync(v2Path, "utf8")) as {
        telegramFoundation: { vpws50: { state: PersistedVpws50StateV2 } };
      };
      // areaName は自由文字列なので、foundation 整合を壊さずに 1 byte 単位で
      // ファイル長を狙える唯一のパディング点。
      const area = parsed.telegramFoundation.vpws50.state.current!.snapshot.areas[0]!;
      area.areaName = "";
      const base = Buffer.byteLength(JSON.stringify(parsed), "utf8");
      area.areaName = "x".repeat(totalBytes - base);
      const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
      expect(bytes.byteLength).toBe(totalBytes);
      writeFileSync(v2Path, bytes);
    };

    padTo(STANDBY_READER_MAX_RAW_FILE_BYTES_PER_SOURCE);
    const exact = new StandbyPersistence(path);
    exact.load(Date.parse("2026-08-31T00:00:00.000Z"));
    expect(exact.lastLoadResult()?.sourceStates.v2).toBe("valid");
    expect(exact.lastLoadResult()?.startup)
      .toEqual({ kind: "restored", selectedSource: "v2" });

    padTo(STANDBY_READER_MAX_RAW_FILE_BYTES_PER_SOURCE + 1);
    const overflow = new StandbyPersistence(path);
    overflow.load(Date.parse("2026-08-31T00:00:00.000Z"));
    expect(overflow.lastLoadResult()?.sourceStates.v2).toBe("oversized");
    expect(overflow.lastLoadResult()?.startup)
      .toEqual({ kind: "restored", selectedSource: "v1" });
  }, 30_000);

  it.each([
    ["VTSE51", "tsunami", "tsunamiObservation:VTSE51", FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT],
    ["VPTA50", "typhoonProbability", "typhoonProbability:VPTA50", FIXTURE_VPTA50_DAMREY],
    ["VPWP50", "weatherWarningTimeseries", "weatherWarningTimeseries:VPWP50", FIXTURE_VPWP50_LOCAL_IDENTITY],
  ] as const)(
    "%s real processor入口はactual prospective pair full-file上限+1をstate-neutrally拒否する",
    (headType, route, targetFamily, fixture) => {
      const { owners, coordinator } = admissionHarness({
        serializePair: (domains) => {
          const candidatePresent = domains.telegramRevisionGate.states.some((entry) =>
            entry.key.startsWith(`${targetFamily}:`));
          return {
            v2: new Uint8Array(
              STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE + (candidatePresent ? 1 : 0),
            ),
            v1: new Uint8Array(1),
          };
        },
      });
      const durable = vi.fn();
      const completion = vi.fn(() => ({ kind: "notRequired" as const }));
      const revisionDecision = vi.fn();
      const standbyDecision = vi.fn();
      coordinator.onDurable(durable);
      const deps = makeProcessDeps({
        revisionGate: owners.telegramRevisionGate,
        vpws50State: owners.vpws50State,
        vpww56State: owners.vpww56State,
        tsunamiState: owners.tsunamiState,
        volcanoState: owners.volcanoState,
        floodForecastState: owners.floodForecastState,
        persistenceAdmission: coordinator,
        onRevisionDecision: revisionDecision,
        onStandbyRevisionDecision: standbyDecision,
        onVptaStandbyRevisionDecision: standbyDecision,
        onVptaAdmissionCompletion: completion,
      });
      const before = coordinator.capture();
      const message = createMockWsDataMessageFromXml(readFixture(fixture), headType);
      const process = () => processMessage(message, route, deps);
      const outcome = headType === "VPTA50"
        ? withVptaRouterOwnerToken(createVptaRouterOwnerToken(), process)
        : process();

      expect(outcome).toBeNull();
      expect(coordinator.capture()).toEqual(before);
      expect(durable).not.toHaveBeenCalled();
      expect(completion).not.toHaveBeenCalled();
      expect(revisionDecision).not.toHaveBeenCalled();
      expect(standbyDecision).not.toHaveBeenCalled();
    },
  );

  it("VPTA50 completionとVPWP50保存合流はpreflight済みcommit後だけ発火する", () => {
    const envelope = {
      logicalGeneration: "18446744073709551615",
      savedAt: "+275760-09-13T00:00:00.000Z",
    };
    const vptaPersistence = new StandbyPersistence(
      join(tmpdir(), "fleq-vpta-admission-not-written.json"),
    );
    const vptaHarness = admissionHarness({
      serializePair: (domains) =>
        serializeStandbyAdmissionPair(vptaPersistence, domains, envelope),
    });
    const vptaDurable = vi.fn();
    const vptaRevision = vi.fn();
    const vptaObserver = vi.fn();
    const vptaCompletion = vi.fn(() => ({ kind: "notRequired" as const }));
    vptaHarness.coordinator.onDurable(vptaDurable);
    const vptaDeps = makeProcessDeps({
      revisionGate: vptaHarness.owners.telegramRevisionGate,
      vpws50State: vptaHarness.owners.vpws50State,
      vpww56State: vptaHarness.owners.vpww56State,
      tsunamiState: vptaHarness.owners.tsunamiState,
      volcanoState: vptaHarness.owners.volcanoState,
      floodForecastState: vptaHarness.owners.floodForecastState,
      persistenceAdmission: vptaHarness.coordinator,
      onRevisionDecision: vptaRevision,
      onVptaStandbyRevisionDecision: vptaObserver,
      onVptaAdmissionCompletion: vptaCompletion,
    });
    const vptaMessage = createMockWsDataMessageFromXml(
      readFixture(FIXTURE_VPTA50_DAMREY).replace(
        /<ReportDateTime>[^<]*<\/ReportDateTime>/,
        "<ReportDateTime>2020-09-30T15:30:00+09:00</ReportDateTime>",
      ),
      "VPTA50",
    );
    if (vptaMessage.meta == null) throw new Error("VPTA50 fixture meta missing");
    vptaMessage.meta.receivedAtMs = Date.parse("2020-09-30T07:00:00.000Z");
    const vptaResult = withVptaRouterOwnerToken(
      createVptaRouterOwnerToken(),
      () => processMessageInternal(vptaMessage, "typhoonProbability", vptaDeps),
    );
    expect(vptaResult?.outcome.presentation.standbyStateProjectionCommitted).toBe(true);
    expect(vptaResult?.internal?.completion).toMatchObject({
      kind: "accepted",
      durableChanged: true,
      persistence: "deferred",
    });
    expect(vptaHarness.owners.telegramRevisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({ domain: "typhoonProbability", revisionFamily: "VPTA50" }),
    ]);
    expect(StandbyStateStore.fromSnapshot(
      vptaHarness.coordinator.capture().domains.standbyStateStore,
    ).snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "typhoon",
        data: expect.objectContaining({
          typhoons: [expect.objectContaining({ probability: expect.any(Object) })],
        }),
      }),
    ]);
    expect(vptaRevision).toHaveBeenCalledTimes(1);
    expect(vptaObserver).toHaveBeenCalledTimes(1);
    expect(vptaCompletion).not.toHaveBeenCalled();
    expect(vptaDurable).not.toHaveBeenCalled();

    const vpwpPersistence = new StandbyPersistence(
      join(tmpdir(), "fleq-vpwp-admission-not-written.json"),
    );
    const vpwpHarness = admissionHarness({
      serializePair: (domains) =>
        serializeStandbyAdmissionPair(vpwpPersistence, domains, envelope),
    });
    const vpwpDurable = vi.fn();
    const vpwpRevision = vi.fn();
    const vpwpCompletion = vi.fn();
    vpwpHarness.coordinator.onDurable(vpwpDurable);
    const vpwpDeps = makeProcessDeps({
      revisionGate: vpwpHarness.owners.telegramRevisionGate,
      vpws50State: vpwpHarness.owners.vpws50State,
      vpww56State: vpwpHarness.owners.vpww56State,
      tsunamiState: vpwpHarness.owners.tsunamiState,
      volcanoState: vpwpHarness.owners.volcanoState,
      floodForecastState: vpwpHarness.owners.floodForecastState,
      persistenceAdmission: vpwpHarness.coordinator,
      onRevisionDecision: vpwpRevision,
      onStandbyRevisionDecision: vpwpCompletion,
    });
    const vpwpMessage = createMockWsDataMessageFromXml(
      readFixture(FIXTURE_VPWP50_LOCAL_IDENTITY),
      "VPWP50",
    );
    if (vpwpMessage.meta == null) throw new Error("VPWP50 fixture meta missing");
    vpwpMessage.meta.receivedAtMs = Date.parse("2026-06-06T00:30:00.000Z");
    const vpwpResult = processMessage(
      vpwpMessage,
      "weatherWarningTimeseries",
      vpwpDeps,
    );
    expect(vpwpResult?.presentation.standbyStateProjectionCommitted).toBe(true);
    expect(vpwpHarness.owners.telegramRevisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({
        domain: "weatherWarningTimeseries",
        revisionFamily: "VPWP50",
      }),
    ]);
    expect(StandbyStateStore.fromSnapshot(
      vpwpHarness.coordinator.capture().domains.standbyStateStore,
    ).snapshotItems()).toEqual([
      expect.objectContaining({ kind: "weatherWarningForecast" }),
    ]);
    expect(vpwpRevision).toHaveBeenCalledTimes(1);
    expect(vpwpCompletion).toHaveBeenCalledTimes(1);
    expect(vpwpDurable).not.toHaveBeenCalled();
  });

  it("all-owner admission rejects invalid owner declarations and out-of-scope drafts state-neutrally", () => {
    const { coordinator } = admissionHarness();
    const before = coordinator.capture();
    const skippedReducer = vi.fn();
    expect(coordinator.transact(
      "standby:heatAlert",
      ["standbyStateStore", "telegramRevisionGate"],
      skippedReducer,
    )).toEqual({ kind: "rejected", reason: "invalidTouchedOwners" });
    expect(skippedReducer).not.toHaveBeenCalled();

    const escaped = coordinator.transact(
      "standby:heatAlert",
      ["telegramRevisionGate", "standbyStateStore"],
      (draft) => {
        draft.tsunamiState.version += 1;
        return { kind: "accepted" as const, value: null, durableChanged: false };
      },
    );
    expect(escaped).toEqual({ kind: "rejected", reason: "unexpectedOwnerMutation" });
    expect(coordinator.capture()).toEqual(before);
  });

  it("exact pair authority permits transient-only replacement at generation exhaustion and rejects persisted change", () => {
    const { coordinator } = admissionHarness({
      canReserve: () => false,
      serializePair: persistedStandbyOnlyPair,
    });
    const durable = vi.fn();
    coordinator.onDurable(durable);
    const transientOnly = coordinator.transact(
      "standby:quakeHost",
      ["telegramRevisionGate", "standbyStateStore"],
      (draft) => {
        draft.telegramRevisionGate.version += 1;
        return { kind: "accepted" as const, value: "transient", durableChanged: true };
      },
    );
    expect(transientOnly.kind).toBe("committed");
    expect(durable).not.toHaveBeenCalled();
    const afterTransient = coordinator.capture();

    const persisted = coordinator.transact(
      "standby:quakeHost",
      ["telegramRevisionGate", "standbyStateStore"],
      (draft) => {
        draft.standbyStateStore.data.briefingGeneration += 1;
        return { kind: "accepted" as const, value: "persisted", durableChanged: false };
      },
    );
    expect(persisted).toEqual({ kind: "rejected", reason: "logicalGenerationExhausted" });
    expect(coordinator.capture()).toEqual(afterTransient);
    expect(durable).not.toHaveBeenCalled();
  });

  it("durable callbacks run once after commit and one throwing observer cannot suppress the next", () => {
    const { coordinator } = admissionHarness({ serializePair: persistedStandbyOnlyPair });
    const first = vi.fn(() => { throw new Error("observer failed"); });
    const second = vi.fn();
    coordinator.onDurable(first);
    coordinator.onDurable(second);
    const result = coordinator.transact(
      "standby:briefingCritical",
      ["telegramRevisionGate", "standbyStateStore"],
      (draft) => {
        draft.standbyStateStore.data.briefingGeneration += 1;
        return { kind: "accepted" as const, value: 1, durableChanged: false };
      },
    );
    expect(result.kind).toBe("committed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(coordinator.capture().domains.standbyStateStore.data.briefingGeneration).toBe(1);
  });

  it("incoming candidate rejection does not roll back expiry committed before admission", () => {
    const encoder = new TextEncoder();
    const { coordinator } = admissionHarness({
      serializePair: (domains) => {
        if (domains.standbyStateStore.data.briefingGeneration === 99) {
          throw new Error("synthetic candidate failure");
        }
        const bytes = encoder.encode(JSON.stringify(domains));
        return { v2: bytes, v1: bytes };
      },
    });
    const seeded = structuredClone(coordinator.capture().domains) as StandbyPersistenceDomainSnapshots;
    const subject = "heat:expired";
    seeded.telegramRevisionGate.states = [{
      key: `heatAlert:VPFT50:${subject}`,
      comparison: {
        stateSubjectKey: subject,
        revision: {
          eventId: { raw: subject, value: subject, valid: true },
          type: { raw: "VPFT50", value: "VPFT50", valid: true },
          reportDateTime: { raw: new Date(T0).toISOString(), epochMs: T0, valid: true },
          serial: { raw: "1", numeric: 1, valid: true },
          infoType: { raw: "発表", value: "発表", valid: true },
        },
      },
      semanticKeys: ["発表:seed"],
      cancelled: false,
      acceptedAtMs: T0,
      durable: true,
      tombstoneRetentionMs: HEAT_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
      retainForFamilyCapacity: false,
      legacyRevisionKey: subject,
      legacyRevisionKeyProvenance: "codeFallback",
    }];
    coordinator.restorePrevalidated(seeded);
    const durable = vi.fn();
    coordinator.onDurable(durable);
    const expiryNowMs = T0 + HEAT_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs! + 1;

    expect(sweepStandbyBeforeAdmission(
      coordinator,
      "standby:heatAlert",
      expiryNowMs,
    )).toBe(true);
    expect(coordinator.capture().domains.telegramRevisionGate.states).toEqual([]);
    expect(durable).toHaveBeenCalledTimes(1);

    const afterExpiry = coordinator.capture();
    expect(coordinator.transact(
      "standby:heatAlert",
      ["telegramRevisionGate", "standbyStateStore"],
      (draft) => {
        draft.standbyStateStore.data.briefingGeneration = 99;
        return { kind: "accepted" as const, value: null, durableChanged: true };
      },
    )).toEqual({ kind: "rejected", reason: "candidateSerializationFailed" });
    expect(coordinator.capture()).toEqual(afterExpiry);
    expect(durable).toHaveBeenCalledTimes(1);
  });

  it("operational-v2 accept keeps the active slice and couples one durable audit to slice and gate", () => {
    const h = operationalVolcanoHarness();
    const durable = vi.fn();
    h.admission.onDurable(durable);
    const [status] = h.volcano.status();
    expect(status).toMatchObject({
      scope: "volcano",
      volcanoCode: "506",
      actions: ["acceptCurrent", "clearCurrent"],
    });
    const result = h.volcano.resolveOperationalV2AlertOmission({
      omissionFingerprint: status!.omissionFingerprint,
      action: "acceptCurrent",
      reason: "運用中の表示内容を確認済み",
      expectedRuntimeVersion: status!.expectedRuntimeVersion,
    });
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;

    const snapshot = h.volcano.snapshot();
    expect(snapshot.repair.vfvo50Repairable).toBe(true);
    expect(snapshot.repair.unrecoverableAlertOmissions).toEqual([]);
    expect(snapshot.repair.operationalV2AlertResolutions).toEqual([
      expect.objectContaining({
        resolutionId: result.resolutionId,
        omissionFingerprint: status!.omissionFingerprint,
        scope: "volcano",
        volcanoCode: "506",
        action: "acceptCurrent",
        actor: "local-repl",
        reason: "運用中の表示内容を確認済み",
      }),
    ]);
    expect(snapshot.holder.composites[0]?.alert).toMatchObject({
      sourceFamily: "operationalV2Unknown",
      operationalV2ResolutionId: result.resolutionId,
    });
    expect(snapshot.gates.states.find((entry) =>
      entry.key === "volcano:volcanoAlert:volcano:alert:506")?.volcanoProvenance)
      .toEqual({
        kind: "alert",
        sourceFamily: "operationalV2Unknown",
        operationalV2ResolutionId: result.resolutionId,
      });
    expect(h.owners.standbyStateStore.exportActiveState().volcanoes.map((item) => item.code))
      .toEqual(["506"]);
    expect(durable).toHaveBeenCalledTimes(1);
    expect(h.volcano.status()).toEqual([]);
  });

  it("operational-v2 clear preserves the exact gate-only watermark and supports a migrated tombstone", () => {
    for (const seed of [
      { active: true, cancelled: false },
      { active: false, cancelled: true },
    ]) {
      const h = operationalVolcanoHarness(seed);
      const [status] = h.volcano.status();
      const beforeGate = structuredClone(h.volcano.snapshot().gates.states[0]!);
      const result = h.volcano.resolveOperationalV2AlertOmission({
        omissionFingerprint: status!.omissionFingerprint,
        action: "clearCurrent",
        reason: seed.active ? "現況を明示解除" : "旧 tombstone を確認",
        expectedRuntimeVersion: status!.expectedRuntimeVersion,
      });
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") continue;
      const snapshot = h.volcano.snapshot();
      expect(snapshot.holder.composites.flatMap((item) => item.alert == null ? [] : [item.alert]))
        .toEqual([]);
      const afterGate = snapshot.gates.states[0]!;
      expect({ ...afterGate, volcanoProvenance: undefined }).toEqual({
        ...beforeGate,
        volcanoProvenance: undefined,
      });
      expect(afterGate.volcanoProvenance).toEqual({
        kind: "alert",
        sourceFamily: "operationalV2Unknown",
        operationalV2ResolutionId: result.resolutionId,
      });
      expect(snapshot.repair.operationalV2AlertResolutions[0]).toMatchObject({
        action: "clearCurrent",
        resolutionId: result.resolutionId,
      });
    }
  });

  it("operational-v2 domain acknowledgement synthesizes no content and all rejects are state-neutral", () => {
    const domain = operationalVolcanoHarness({ scope: "domain" });
    const [domainStatus] = domain.volcano.status();
    const acknowledged = domain.volcano.resolveOperationalV2AlertOmission({
      omissionFingerprint: domainStatus!.omissionFingerprint,
      action: "acknowledgeDomainLoss",
      reason: "履歴欠損を監査記録へ移行",
      expectedRuntimeVersion: domainStatus!.expectedRuntimeVersion,
    });
    expect(acknowledged.kind).toBe("committed");
    expect(domain.volcano.snapshot()).toMatchObject({
      holder: { composites: [] },
      gates: { states: [] },
      repair: {
        unrecoverableAlertOmissions: [],
        operationalV2AlertResolutions: [expect.objectContaining({
          scope: "domain",
          action: "acknowledgeDomainLoss",
        })],
      },
    });

    const stale = operationalVolcanoHarness();
    const [staleStatus] = stale.volcano.status();
    const staleBefore = stale.volcano.snapshot();
    expect(stale.volcano.resolveOperationalV2AlertOmission({
      omissionFingerprint: staleStatus!.omissionFingerprint,
      action: "acceptCurrent",
      reason: "stale",
      expectedRuntimeVersion: staleStatus!.expectedRuntimeVersion + 1,
    })).toEqual({ kind: "staleVersion" });
    expect(stale.volcano.snapshot()).toEqual(staleBefore);
    expect(stale.volcano.resolveOperationalV2AlertOmission({
      omissionFingerprint: staleStatus!.omissionFingerprint,
      action: "acknowledgeDomainLoss",
      reason: "scope mismatch",
      expectedRuntimeVersion: staleStatus!.expectedRuntimeVersion,
    })).toEqual({ kind: "invalidAction" });
    expect(stale.volcano.snapshot()).toEqual(staleBefore);

    const oversized = new Uint8Array(STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE + 1);
    const rejected = operationalVolcanoHarness({
      serializePair: () => ({ v2: oversized, v1: oversized }),
    });
    const [rejectedStatus] = rejected.volcano.status();
    const rejectedBefore = rejected.volcano.snapshot();
    expect(rejected.volcano.resolveOperationalV2AlertOmission({
      omissionFingerprint: rejectedStatus!.omissionFingerprint,
      action: "clearCurrent",
      reason: "容量境界確認",
      expectedRuntimeVersion: rejectedStatus!.expectedRuntimeVersion,
    })).toEqual({ kind: "admissionRejected" });
    expect(rejected.volcano.snapshot()).toEqual(rejectedBefore);
  });

  it("display off 中の ingest が、後で構築した snapshot の standbyItems に現れる", () => {
    const standby = new StandbyStateStore();
    standby.applyEvent(heatEvent(), T0);
    const display = new DisplayStateStore(() => standby.snapshotItems());
    expect(display.snapshot(0, T0).standbyItems).toEqual([expect.objectContaining({ kind: "heat" })]);
  });

  it("durableChanged は永続化 save に一本化できる", () => {
    const root = mkdtempSync(join(tmpdir(), "fleq-standby-wiring-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(path);
    const standby = new StandbyStateStore();
    standby.onDurable(() => persistence.save(standby.exportActiveState()));
    standby.applyEvent(heatEvent(), T0);
    expect(persistence.load()?.heat).toHaveLength(1);
  });

  it("hub 稼働中は既存 sweep タイマーが standbySweep を駆動する", () => {
    vi.useFakeTimers();
    const standbySweep = vi.fn(() => ({ viewChanged: false, durableChanged: false }));
    const hub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: () => "summary", weatherAlerts: () => [], now: () => T0, standbySweep,
    });
    hub.startTimers();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(standbySweep).toHaveBeenCalledWith(T0);
    hub.stop();
  });

  it("空官署の竜巻 ticker は既定官署キーで保持・続報置換され、期限切れで消える", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const expiresAt = T0 + 3 * SWEEP_INTERVAL_MS;
    const standby = new StandbyStateStore();
    const event = tornadoEvent(new Date(expiresAt).toISOString(), "");
    standby.applyEvent(event, nowMs);
    const hub = new InfoDisplayHub(new DisplayStateStore(() => standby.snapshotItems()), {
      summarize: () => "竜巻注意情報",
      weatherAlerts: () => [],
      now: () => nowMs,
      standbySweep: (sweepAt) => standby.sweep(sweepAt),
      standbyTickerGroupKeys: () => standby.activeTickerGroupKeys(),
    });
    hub.ingest(event);
    expect(hub.buildSnapshot().recentTicker.map((dto) => dto.groupKey)).toEqual([
      "tornado:不明官署",
    ]);
    expect(standby.activeTickerGroupKeys()).toEqual(new Set(["tornado:不明官署"]));

    hub.startTimers();
    nowMs = T0 + SWEEP_INTERVAL_MS;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(hub.buildSnapshot().recentTicker).toHaveLength(1);

    const followup = tornadoEvent(
      new Date(expiresAt).toISOString(),
      "",
      nowMs,
      "2",
      ["千代田区", "港区", "新宿区"],
    );
    standby.applyEvent(followup, nowMs);
    hub.ingest(followup);
    const revisions = hub.buildSnapshot().recentTicker;
    expect(revisions.map((dto) => dto.groupKey)).toEqual([
      "tornado:不明官署",
      "tornado:不明官署",
    ]);
    // tickerSentence が非空なので tickerDetail はワイヤに載らない (フロント未参照の死荷重)。
    expect(revisions[0]?.tickerDetail).toBeNull();
    expect((revisions[0]?.tickerSentence ?? "").length).toBeGreaterThan(0);

    nowMs = expiresAt;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(standby.snapshotItems().some((item) => item.kind === "tornado")).toBe(false);
    expect(hub.buildSnapshot().recentTicker).toEqual([]);
    hub.stop();
  });

  it("controller は start 中に off sweep を止め、stop/失敗/kill switch で再開する", async () => {
    let runtime: DisplayRuntime | null = null;
    const setStandbyDirty = vi.fn();
    const rt = {
      hub: { markExternalStateDirty: vi.fn(), publishConnection: vi.fn() },
      transport: { port: () => 7788, clientCount: () => 0 },
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as DisplayRuntime;
    mockStartDisplayRuntime.mockResolvedValue(rt);
    const controller = createDisplayController({
      config: { ...DEFAULT_CONFIG, apiKey: "test", displayPort: 0 },
      display: {
        displayOutcome: vi.fn(), displayRawHeader: vi.fn(), displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn(),
        getDisplayMode: () => "normal", renderSummaryLine: () => "summary",
      },
      seeds: { tsunami: () => null, weather: () => undefined, landslide: () => undefined },
      getRuntime: () => runtime,
      setRuntime: (value) => { runtime = value; },
      setHubRef: vi.fn(),
      setStandbyDirty,
    });

    await controller.start();
    expect(setStandbyDirty).toHaveBeenCalledWith(expect.any(Function));
    const onStopped = mockStartDisplayRuntime.mock.calls[0][3] as () => void;
    onStopped();
    expect(setStandbyDirty).toHaveBeenLastCalledWith(null);

    runtime = rt;
    await controller.stop();
    expect(setStandbyDirty).toHaveBeenLastCalledWith(null);
  });

  it("shutdown は standby sweep を止めて最終 flush する", async () => {
    const order: string[] = [];
    const stopStandbySweep = vi.fn(() => { order.push("standby"); });
    const shutdown = createShutdownHandler({
      apiKey: "test",
      manager: { getStatus: () => ({ socketId: null }), close: vi.fn() } as never,
      eewLogger: { closeAll: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) } as never,
      getReplHandler: () => null,
      resetTerminalTitle: vi.fn(),
      stopDisplayRuntime: vi.fn(async () => { order.push("display"); }),
      stopStandbySweep,
    });
    const result = await shutdown();
    expect(stopStandbySweep).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["display", "standby"]);
    expect(result).toEqual({ kind: "completed", exitCode: 0 });
  });

  it("startMonitor の実 restore→post-expiry coupling→sweep は両fileを一度だけrewriteし、変更なしは0回", async () => {
    vi.useFakeTimers();
    const monitorNowMs = Date.parse("2026-06-06T00:30:00.000Z");
    vi.setSystemTime(monitorNowMs);
    const root = mkdtempSync(join(tmpdir(), "fleq-standby-monitor-rewrite-"));
    tempRoots.push(root);
    const runtimeDir = join(root, "data", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const persisted = new StandbyStateStore().exportActiveState();
    persisted.heat = [{ key: "broken-heat" }] as never;
    persisted.briefingCritical = {
      generation: 11,
      entries: [], cancellations: [], watermarks: [],
      rawAliases: [{
        source: "vpoa50", sourceEventId: "expired-alias", semanticKey: "canonical",
        revision: { reportTimeMs: monitorNowMs - 1, serial: "1" }, expiresAtMs: monitorNowMs,
      }],
    };
    const persistPath = join(runtimeDir, "display-active-state-v1.json");
    writeFileSync(
      persistPath,
      `${JSON.stringify(persisted)}\n`,
      "utf8",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const originalSchedule = StandbyPersistence.prototype.scheduleSerializedPair;
    let scheduledPersistence: StandbyPersistence | null = null;
    const schedule = vi.spyOn(StandbyPersistence.prototype, "scheduleSerializedPair")
      .mockImplementation(function (this: StandbyPersistence, value) {
        scheduledPersistence = this;
        return originalSchedule.call(this, value);
      });
    const monitorShutdowns: Array<() => Promise<unknown>> = [];
    const registerShutdownSignals = vi.spyOn(shutdownModule, "registerShutdownSignals")
      .mockImplementation((shutdown) => { monitorShutdowns.push(shutdown); });
    const connect = vi.fn().mockResolvedValue(undefined);
    let managerOnData: ((message: WsDataMessage) => void) | null = null;

    vi.doMock("../../../src/dmdata/multi-connection-manager", () => {
      class FakeMultiConnectionManager {
        constructor(_config: unknown, events: { onData: (message: WsDataMessage) => void }) {
          managerOnData = events.onData;
        }
        connect = connect;
        close = vi.fn();
        startBackup = vi.fn().mockResolvedValue("started");
        getStatus = vi.fn(() => ({ connected: false, socketId: null }));
        getDeliveryCapabilities = vi.fn(() => ({
          connected: false,
          effectiveClassifications: [],
          guaranteedHeadTypes: new Set<string>(),
          source: "unknown" as const,
        }));
      }
      return { MultiConnectionManager: FakeMultiConnectionManager };
    });
    vi.doMock("../../../src/engine/startup/tsunami-initializer", () => ({
      restoreTsunamiState: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("../../../src/engine/startup/volcano-initializer", () => ({
      volcanoRepairTargets: vi.fn(() => []),
      repairVolcanoState: vi.fn().mockResolvedValue({ targets: [] }),
      VolcanoRepairJournal: class FakeVolcanoRepairJournal {},
    }));
    vi.doMock("../../../src/engine/notification/notifier", () => ({
      Notifier: class FakeNotifier {
        notifyWeatherWarningTimeseries = vi.fn();
      },
    }));
    // This integration owns the standby writer clock. The unrelated detail-cache
    // debounce uses the same fake timer and otherwise starts an async filesystem
    // write while this test is advancing the 60-second standby sweep.
    vi.doMock("../../../src/engine/messages/vpwp50-detail-cache", () => ({
      Vpwp50DetailCache: class FakeVpwp50DetailCache {
        readonly category = "vpwp50";
        readonly emptyMessage = "empty";
        rememberLatest = vi.fn();
        getDetail = vi.fn(() => null);
        flush = vi.fn();
      },
    }));
    vi.doMock("../../../src/ui/display-adapter", () => ({
      createDisplayAdapter: () => ({
        displayOutcome: vi.fn(),
        displayRawHeader: vi.fn(),
        displayTelegramDiagnostic: vi.fn(),
        displayVolcano: vi.fn(),
        displayVolcanoBatch: vi.fn(),
        getDisplayMode: () => "normal",
        renderSummaryLine: () => "summary",
      }),
    }));
    vi.doMock("../../../src/ui/repl", () => ({
      ReplHandler: class FakeReplHandler {
        setSummaryTimerControl = vi.fn();
        start = vi.fn();
        stop = vi.fn();
        beforeDisplayMessage = vi.fn();
        afterDisplayMessage = vi.fn();
      },
    }));

    const { startMonitor } = await import("../../../src/engine/monitor/monitor");
    await startMonitor({ ...DEFAULT_CONFIG, apiKey: "test" });

    expect(cwd).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registerShutdownSignals).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(scheduledPersistence).not.toBeNull();
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    const rewrittenV1 = JSON.parse(readFileSync(persistPath, "utf8"));
    const rewrittenV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(persistPath), "utf8"));
    expect(rewrittenV1.briefingCritical).toBeUndefined();
    expect(rewrittenV2.briefingCritical).toBeUndefined();

    const longForecastXml = readFixture(FIXTURE_VPWP50_LOCAL_IDENTITY)
      .replaceAll("<Duration>PT3H</Duration>", "<Duration>P8D</Duration>");
    schedule.mockClear();
    (managerOnData as ((message: WsDataMessage) => void) | null)?.(
      createMockWsDataMessageFromXml(longForecastXml, "VPWP50"),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    const accepted = JSON.parse(readFileSync(standbyPersistenceV2Path(persistPath), "utf8")) as {
      weatherWarningForecasts?: unknown[];
      telegramFoundation: { standbyDomains: { gateEntries: Array<{ revisionFamily: string }> } };
    };
    expect(accepted.weatherWarningForecasts).toHaveLength(1);
    expect(accepted.telegramFoundation.standbyDomains.gateEntries
      .filter((entry) => entry.revisionFamily === "VPWP50")).toHaveLength(1);

    schedule.mockClear();
    vi.setSystemTime(monitorNowMs + WEATHER_TIMESERIES_RETENTION_MS + 1);
    const invalidSerialXml = longForecastXml.replace("<Serial>01</Serial>", "<Serial>invalid</Serial>");
    (managerOnData as ((message: WsDataMessage) => void) | null)?.(
      createMockWsDataMessageFromXml(invalidSerialXml, "VPWP50"),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    const rejectedAfterExpiry = JSON.parse(readFileSync(standbyPersistenceV2Path(persistPath), "utf8")) as {
      weatherWarningForecasts?: unknown[];
      telegramFoundation: { standbyDomains: { gateEntries: Array<{ revisionFamily: string }> } };
    };
    expect(rejectedAfterExpiry.weatherWarningForecasts).toBeUndefined();
    expect(rejectedAfterExpiry.telegramFoundation.standbyDomains.gateEntries
      .filter((entry) => entry.revisionFamily === "VPWP50")).toEqual([]);

    schedule.mockClear();
    (managerOnData as ((message: WsDataMessage) => void) | null)?.(
      createMockWsDataMessageFromXml(`${longForecastXml}\n`, "VPWP50"),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
    // Commit the admission reservation before advancing the shared timer. This
    // leaves only the sweep-created reservation for the assertion below.
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    schedule.mockClear();
    vi.setSystemTime(monitorNowMs + 2 * WEATHER_TIMESERIES_RETENTION_MS - 59_999);
    vi.advanceTimersByTime(60_000);
    expect(schedule).toHaveBeenCalledTimes(1);
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    await monitorShutdowns[0]?.();

    const unchangedRoot = mkdtempSync(join(tmpdir(), "fleq-standby-monitor-unchanged-"));
    tempRoots.push(unchangedRoot);
    const unchangedRuntimeDir = join(unchangedRoot, "data", "runtime");
    mkdirSync(unchangedRuntimeDir, { recursive: true });
    writeFileSync(
      join(unchangedRuntimeDir, "display-active-state-v1.json"),
      JSON.stringify(new StandbyStateStore().exportActiveState()),
      "utf8",
    );
    cwd.mockReturnValue(unchangedRoot);
    schedule.mockClear();
    scheduledPersistence = null;
    await startMonitor({ ...DEFAULT_CONFIG, apiKey: "test" });

    // 旧 v1 単独 snapshot は counterpart と logical generation を補うため、
    // state mutation がなくても canonical pair rewrite を一度予約する。
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(scheduledPersistence).not.toBeNull();
    (scheduledPersistence as StandbyPersistence | null)?.flush();
    await monitorShutdowns[1]?.();
  });
});
