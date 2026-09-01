import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as log from "../../logger";
import type {
  DisplayFloodHydrographV1,
  DisplayBriefingEntryV1,
  DisplayFloodRiverV1,
  DisplayFloodStationV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoAlertClassV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type { PersistedFloodEventState, PersistedFloodState } from "./flood-active-reducer";
import type { PersistedSeenEntry } from "./revision-guard";
import { compareRevision, type StandbyRevision } from "./standby-registry";
import type {
  ParsedTsunamiInfo,
  SpecialValue,
  SpecialValueDiagnostic,
  StrictTextMeta,
  TelegramMeta,
  TelegramRevisionComparisonInput,
  TsunamiObservationStation,
  TsunamiParserDiagnostic,
  Vpws50CurrentAreasForDisplay,
} from "../../types";
import {
  createTelegramMeta,
  FUTURE_REPORT_DATETIME_SKEW_MS,
  parseStrictReportDateTime,
  parseTelegramSerial,
} from "../../dmdata/telegram-meta";
import {
  copyDisplayPlumeHeightSemantic,
  isDisplayPlumeHeightSemantic,
  legacyDisplayPlumeHeightSemantics,
} from "./plume-height-semantic";
import {
  canonicalizeLegacyTsunamiInfo,
  canonicalizeLegacyTsunamiObservation,
  type LegacyParsedTsunamiInfoInput,
  type LegacyTsunamiForecastItemInput,
  type LegacyTsunamiObservationInput,
} from "../../dmdata/tsunami-legacy-adapter";
import {
  VPWS50_SNAPSHOT_GENERATION,
  Vpws50StateHolder,
  migratePersistedVpws50EmergencyClears,
  type PersistedVpws50StateV2,
  type WeatherReportIdentity,
} from "../messages/vpws50-state";
import {
  normalizeWeatherOfficeWatermarkKey,
  weatherOfficeFromStreamKey,
  weatherOfficeWatermarkKey,
} from "../messages/weather-stream-key";
import {
  TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY,
} from "../messages/tsunami-state";
import {
  compactPersistedSemanticKeys,
  normalizeVptaPersistedSemanticKeys,
  selectVptaCapacityBundles,
  TELEGRAM_REVISION_MAX_ENTRIES,
  TELEGRAM_REVISION_MAX_SEMANTIC_KEYS,
  type PersistedTelegramRevisionGateEntryV2,
} from "../messages/telegram-revision-gate";
import {
  TSUNAMI_REVISION_FAMILY_POLICIES,
  tsunamiStateSubjectKey,
  VPWW56_REVISION_FAMILY_POLICY,
  VPWS50_REVISION_FAMILY_POLICY,
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
} from "../messages/revision-family-registry";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "./weather-alert-view";
import { resolveTsunamiLevel } from "../../utils/tsunami-kind";
import {
  depthValueFromLegacyScalar,
  magnitudeValueFromLegacyScalar,
  normalizeNumericSpecialValueForPersistence,
  parsePersistedDepthSpecialValue,
  parsePersistedNumericSpecialValue,
} from "../magnitude-depth-persistence";
import {
  VPWW56_SNAPSHOT_GENERATION,
  Vpww56StateHolder,
  type PersistedVpww56StateV2,
} from "../messages/vpww56-state";
import type { PersistedVolcanoStateV2 } from "../messages/volcano-state";
import {
  VOLCANO_ALERT_REVISION_FAMILY_POLICY,
  VOLCANO_ERUPTION_REVISION_FAMILY_POLICY,
} from "../messages/revision-family-registry";
import {
  normalizeTyphoonNumericValueForPersistence,
  parsePersistedTyphoonNumericValue,
  typhoonNumericValueFromLegacyScalar,
} from "../typhoon-numeric-persistence";
import {
  TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES,
  TYPHOON_PROBABILITY_MAX_CODE_LENGTH,
  TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH,
  TYPHOON_PROBABILITY_MAX_NAME_LENGTH,
  TYPHOON_PROBABILITY_MAX_REMARK_LENGTH,
  TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH,
  TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH,
  TYPHOON_PROBABILITY_MAX_SUBJECTS,
  TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES,
  TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS,
  TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES,
  TYPHOON_PROBABILITY_ACCEPTED_AT_FUTURE_SKEW_MS,
  TYPHOON_PROBABILITY_REPORT_FUTURE_SKEW_MS,
  TYPHOON_PROBABILITY_RETENTION_MS,
  normalizeVpta50Serial,
  validateTyphoonProbabilityEventId,
} from "./project-typhoon-probability";

const PERSIST_SCHEMA_VERSION = 2;

export interface PersistedHeatStateV1 {
  key: string;
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
}

export interface PersistedStandbyStateV1 {
  version: 1;
  savedAt: string;
  heat: PersistedHeatStateV1[];
  typhoons: PersistedTyphoonStateV1[];
  typhoonProbabilities?: PersistedTyphoonProbabilityStateV1[];
  typhoonProbabilityGateMetadata?: PersistedTyphoonProbabilityGateMetadataV1[];
  volcanoes: PersistedVolcanoStateV1[];
  floods?: PersistedFloodState;
  weatherAlerts?: PersistedWeatherAlertStateV1[];
  tornado?: PersistedTornadoStateV1[];
  longPeriod?: PersistedLongPeriodStateV1[];
  quakeHost?: PersistedQuakeHostStateV1 | null;
  nankaiTrough?: PersistedNankaiStateV1 | null;
  seen: PersistedSeenEntry[];
  /** Critical briefing lifecycle only.  Warning/info projections stay ephemeral. */
  briefingCritical?: PersistedBriefingCriticalStateV1;
}

export interface PersistedBriefingCriticalEntryV1 {
  entry: DisplayBriefingEntryV1;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface PersistedBriefingCriticalWatermarkV1 {
  semanticKey: string;
  revision: StandbyRevision;
  expiresAtMs: number;
}

export interface PersistedBriefingCriticalRawAliasV1 {
  source: "vpbs50" | "vpoa50";
  sourceEventId: string;
  semanticKey: string;
  revision: StandbyRevision;
  expiresAtMs: number;
}

export interface PersistedBriefingCriticalStateV1 {
  generation: number;
  entries: PersistedBriefingCriticalEntryV1[];
  cancellations: PersistedBriefingCriticalEntryV1[];
  watermarks: PersistedBriefingCriticalWatermarkV1[];
  rawAliases?: PersistedBriefingCriticalRawAliasV1[];
}

export class BriefingCriticalPersistenceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefingCriticalPersistenceInvariantError";
  }
}

/** Phase 4B 単位 4 の v2 observation schema。旧 JSON の areaCode 欠落も許容する。 */
export type PersistedTsunamiObservationV2 = TsunamiObservationStation;

export interface PersistedTsunamiObservationGroupsV2 {
  VTSE51: PersistedTsunamiObservationV2[];
  VTSE52: PersistedTsunamiObservationV2[];
}

export type PersistedTsunamiActiveV2 = Omit<ParsedTsunamiInfo, "observations"> & {
  observations?: PersistedTsunamiObservationV2[];
};

export interface PersistedTelegramFoundationV2 {
  vpws50: {
    /** false は v1 adapter 由来で、表示 snapshot は旧 field を正とする。 */
    authoritative: boolean;
    state: PersistedVpws50StateV2 | null;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  vpww56: {
    /** writer は常に付与する。欠落は市町村等粒度へ切替える前の旧 foundation。 */
    generation?: typeof VPWW56_SNAPSHOT_GENERATION;
    /** false は v1 の union 表示だけを復元した状態で、subject watermark には採用しない。 */
    authoritative: boolean;
    state: PersistedVpww56StateV2 | null;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  tsunami: {
    /**
     * v2 scalar schema の migration input。writer は出力しない。読み込み時は
     * keyedActive または legacyActive へ一方向に移す。
     */
    active?: PersistedTsunamiActiveV2 | null;
    /** EventID ごとの keyed snapshot。各 forecast は EventID + Area.Code + Kind.Code で復元する。 */
    keyedActive?: PersistedTsunamiActiveV2[];
    /** 名称-only の旧 snapshot。表示専用で gate / 取消照合には使わない。 */
    legacyActive?: PersistedTsunamiActiveV2 | null;
    observations: PersistedTsunamiObservationGroupsV2;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  volcano: {
    /** false は legacy 表示だけを復元し、watermark には採用しない。 */
    authoritative: boolean;
    state: PersistedVolcanoStateV2 | null;
    active: PersistedVolcanoStateV1[];
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  floodForecast: {
    /** false means only the legacy display snapshot was recovered. */
    authoritative: boolean;
    active: PersistedFloodEventState[];
    /** gate 未移行の v1 / pre-flood-v2 projection。各 EventID の正規受理か期限切れまで保全する。 */
    legacyEventIds?: string[];
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  standbyDomains: {
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
}

export type PersistedTelegramFoundationInputV2 = Omit<
  PersistedTelegramFoundationV2,
  "tsunami" | "vpww56" | "volcano" | "floodForecast" | "standbyDomains"
> & {
  tsunami?: PersistedTelegramFoundationV2["tsunami"];
  vpww56?: PersistedTelegramFoundationV2["vpww56"];
  volcano?: PersistedTelegramFoundationV2["volcano"];
  floodForecast?: PersistedTelegramFoundationV2["floodForecast"];
  standbyDomains?: PersistedTelegramFoundationV2["standbyDomains"];
};

/**
 * v2 は新しい foundation state を正とし、v1 fields を rollback 互換として同じ
 * envelope に dual-write する。
 */
export interface PersistedStandbyStateV2 extends Omit<PersistedStandbyStateV1, "version"> {
  version: 2;
  telegramFoundation: PersistedTelegramFoundationV2;
}

export type PersistedStandbyState = PersistedStandbyStateV1 | PersistedStandbyStateV2;

export function standbyPersistenceV2Path(legacyPath: string): string {
  return legacyPath.endsWith("-v1.json")
    ? `${legacyPath.slice(0, -"-v1.json".length)}-v2.json`
    : `${legacyPath}.v2`;
}

function volcanoLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
  state: PersistedVolcanoStateV2 | null,
): PersistedSeenEntry[] {
  const activeEventIds = new Map<string, string | null>();
  for (const eruption of state?.eruptions ?? []) {
    const code = eruption.volcanoCode.trim();
    const eventId = eruption.eventId?.trim() || null;
    if (code === "" || eventId == null) continue;
    activeEventIds.set(code, activeEventIds.has(code) ? null : eventId);
  }
  return entries.flatMap((entry) => {
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    if (reportTimeMs == null) return [];
    const code = entry.stateSubjectKey.replace(/^volcano:(?:alert|eruption):/, "");
    const key = entry.legacyRevisionKey?.trim()
      || (entry.revisionFamily === "volcanoAlert"
        ? `volcano:alert:${code}`
        : `volcano:event:${activeEventIds.get(code) ?? code}`);
    const fallbackRetentionMs = entry.revisionFamily === "volcanoAlert"
      ? VOLCANO_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.tombstoneRetentionMs;
    const retentionMs = entry.tombstoneRetentionMs ?? fallbackRetentionMs;
    if (retentionMs == null) return [];
    return [{
      key,
      revision: {
        reportTimeMs,
        serial: entry.comparison.revision.serial.raw,
      },
      // gate は age > retention で落とす。旧 guard の forgetAt <= now と境界を揃える。
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

function floodLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedSeenEntry[] {
  return entries.flatMap((entry) => {
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    const eventId = entry.legacyRevisionKey?.trim();
    const retentionMs = entry.tombstoneRetentionMs
      ?? FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs;
    if (reportTimeMs == null || eventId == null || eventId === "" || retentionMs == null) return [];
    return [{
      key: eventId,
      revision: {
        reportTimeMs,
        serial: entry.comparison.revision.serial.raw,
      },
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

const STANDBY_FOUNDATION_POLICIES = [
  TORNADO_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
] as const;

function standbyFoundationPolicy(entry: PersistedTelegramRevisionGateEntryV2) {
  return STANDBY_FOUNDATION_POLICIES.find((policy) =>
    policy.domain === entry.domain && policy.revisionFamily === entry.revisionFamily);
}

function standbyLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedSeenEntry[] {
  return entries.flatMap((entry) => {
    const policy = standbyFoundationPolicy(entry);
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    const retentionMs = entry.tombstoneRetentionMs ?? policy?.tombstoneRetentionMs;
    if (policy == null || reportTimeMs == null || retentionMs == null) return [];
    return [{
      key: entry.legacyRevisionKey?.trim() || entry.stateSubjectKey,
      revision: { reportTimeMs, serial: entry.comparison.revision.serial.raw },
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

function vptaGateMetadata(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTyphoonProbabilityGateMetadataV1[] {
  return entries
    .filter((entry) => entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50")
    .sort((left, right) => left.stateSubjectKey < right.stateSubjectKey ? -1 : left.stateSubjectKey > right.stateSubjectKey ? 1 : 0)
    .map((entry) => ({
      stateSubjectKey: entry.stateSubjectKey,
      comparison: structuredClone(entry.comparison),
      semanticKeys: [...entry.semanticKeys],
      cancelled: entry.cancelled,
    }));
}

function mergeLegacySeenEntries(
  existing: readonly PersistedSeenEntry[],
  added: readonly PersistedSeenEntry[],
): PersistedSeenEntry[] {
  const merged = new Map(existing.map((entry) => [entry.key, structuredClone(entry)]));
  for (const entry of added) {
    // foundation gate は厳密 metadata 検証済み。旧 guard が invalid/future
    // ReportDateTime を受信時刻へ昇格した untrusted seen より必ず優先する。
    merged.set(entry.key, structuredClone(entry));
  }
  return [...merged.values()];
}

export interface PersistedTyphoonStateV1 {
  key: string;
  sourceEventId: string;
  typhoon: DisplayTyphoonV1;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  pressureHpaValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  maxWindMsValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  maxGustMsValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  moveSpeedKmhValue?: SpecialValue<number>;
  revision: StandbyRevision;
  expiresAtMs: number;
  appliedSemanticKey?: string;
}

export interface PersistedTyphoonProbabilityPrefectureV1 {
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
}

export interface PersistedTyphoonProbabilityWorstAreaV1 {
  areaCode: string;
  areaName: string;
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
  peakAtMs: number | null;
}

export interface PersistedTyphoonProbabilityStateV1 {
  key: string;
  sourceEventId: string;
  identity: {
    name: string | null;
    nameKana: string | null;
    remark: string | null;
    typhoonNumber: string | null;
  };
  baseTimeMs: number;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: PersistedTyphoonProbabilityPrefectureV1[];
  worstArea: PersistedTyphoonProbabilityWorstAreaV1;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
}

export interface PersistedTyphoonProbabilityGateMetadataV1 {
  stateSubjectKey: string;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
}
export interface PersistedVolcanoStateV1 {
  code: string;
  name: string;
  alertLevel: number | null;
  alertClass?: DisplayVolcanoAlertClassV1 | null;
  warningKind?: string | null;
  targetKinds?: string[];
  alertExpiresAtMs: number | null;
  /** string は構造化前の v1 保存状態との互換専用。新規保存は DisplayVolcanoEventV1。 */
  latestEvent?: DisplayVolcanoEventV1 | string | null;
  /** 空コードの取消を EventID で直近噴火へ結び直すための逆引き。 */
  latestEventId?: string | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  alertRevision: StandbyRevision | null;
  eventRevision: StandbyRevision | null;
}
export interface PersistedTornadoStateV1 { publishingOffice: string; sourceEventId: string; areas: string[]; isSighted: boolean; revision: StandbyRevision; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedLongPeriodStateV1 { eventId: string; maxLgInt: string; safetyRank?: number | null; revision: StandbyRevision; hosted: boolean; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedQuakeHostStateV1 { eventId: string; maxIntRank: number; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedNankaiStateV1 { sourceEventId: string; statusCode: string; label: string; revision: StandbyRevision; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedWeatherAlertStateV1 { source: DisplayWeatherSourceV1; alerts: DisplayWeatherAlertV1[]; revision: StandbyRevision; expiresAtMs: number; }

/**
 * schedule() が実際に書き込むまでの遅延。
 * 電文が連続する場面で同期 I/O を毎報走らせず、最新状態だけを 1 回書くための窓。
 * 失うのは強制電源断の直前この秒数ぶんで、正常終了時は flush() が書き切る。
 */
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedReadResult {
  state: PersistedStandbyStateV2 | null;
  migrationConflict: boolean;
}

export type StandbyPersistenceWriteFailureStage =
  | "validation"
  | "salvageBackup"
  | "mkdir"
  | "writeV2Temp"
  | "writeV1Temp"
  | "renameV2"
  | "renameV1"
  | "pendingUnavailable"
  | "pendingBehindRequiredSeq";

export interface StandbyPersistenceScheduleReceipt {
  kind: "scheduled";
  seq: number;
}

export type StandbyPersistenceFlushThroughResult =
  | {
      kind: "written";
      requiredSeq: number;
      targetSeq: number;
      writtenSeq: number;
      v2Committed: true;
      v1Committed: true;
    }
  | { kind: "alreadyWritten"; requiredSeq: number; writtenSeq: number }
  | {
      kind: "failed";
      requiredSeq: number;
      targetSeq: number | null;
      failedSeq: number | null;
      stage: StandbyPersistenceWriteFailureStage;
      pendingRetained: true;
      partialCommit: "none" | "v2Only" | "unknown";
      cause: unknown;
    };

export type StandbyPersistenceSaveResult =
  | {
      kind: "written";
      requestedSeq: number;
      writtenSeq: number;
      v2Committed: true;
      v1Committed: true;
    }
  | {
      kind: "failed";
      requestedSeq: number | null;
      failedSeq: number | null;
      stage: StandbyPersistenceWriteFailureStage;
      pendingRetained: true;
      partialCommit: "none" | "v2Only" | "unknown";
      cause: unknown;
    };

export type StandbyPersistenceLastFailure = Extract<
  StandbyPersistenceSaveResult,
  { kind: "failed" }
>;

type SalvageDomain =
  | "root.heat" | "root.typhoons" | "root.volcanoes" | "root.tornado" | "root.longPeriod"
  | "root.typhoonProbabilities" | "root.typhoonProbabilityGateMetadata"
  | "root.seen" | "root.floods" | "root.weatherAlerts" | "root.quakeHost" | "root.nankaiTrough"
  | "root.briefingCritical"
  | "foundation.vpws50" | "foundation.vpww56" | "foundation.tsunami" | "foundation.volcano"
  | "foundation.floodForecast" | "foundation.standbyDomains";
type SalvageUnit = "entry" | "source" | "eventId" | "code" | "subject" | "identity" | "stationCode" | "family" | "singleton" | "domain";
type SalvageReason = "invalid-entry" | "invalid-container" | "coupling-mismatch" | "duplicate-subject" | "limit-exceeded";

interface RepairMetric {
  units: Set<SalvageUnit>;
  discarded: number;
  retained: number;
  reasons: Set<SalvageReason>;
  /** backup 成功まで source ごとの domain/unit/reason 件数を原文と一緒に保持する。 */
  distribution: Map<SalvageUnit, Map<SalvageReason, number>>;
  discard: boolean;
}

interface RepairCollector {
  source: string;
  metrics: Map<SalvageDomain, RepairMetric>;
  /** 値の破損を伴わない ordering / optional-field canonicalization。 */
  canonicalRewriteRequired: boolean;
}

/** 原文と同じ寿命で保持する。backup が成功するまで repair の内訳を失わない。 */
interface RepairSource {
  bytes: Buffer;
  metrics: Map<SalvageDomain, RepairMetric>;
}

const REPAIR_REASON_PRIORITY: readonly SalvageReason[] = [
  "invalid-container", "invalid-entry", "duplicate-subject", "coupling-mismatch", "limit-exceeded",
];

let activeRepairCollector: RepairCollector | null = null;

type VptaPersistenceDiagnostic =
  | "vpta50V1GateMetadataPresentInvalid"
  | "vpta50V1GateMetadataMissing"
  | "vpta50V1MissingAppliedSemanticKey"
  | "vpta50V1RevisionReconstructionFailed"
  | "vpta50GateRetentionDefaulted"
  | "vpta50GateRetentionInvalid"
  | "vpta50PersistenceCouplingMismatch";

interface VptaPersistenceReadContext {
  nowMs: number;
  diagnostics: Set<VptaPersistenceDiagnostic>;
}

let activeVptaPersistenceReadContext: VptaPersistenceReadContext | null = null;

function persistenceValidationNowMs(): number {
  return activeVptaPersistenceReadContext?.nowMs ?? Date.now();
}

function warnVptaPersistenceDiagnostic(diagnostic: VptaPersistenceDiagnostic): void {
  const context = activeVptaPersistenceReadContext;
  if (context?.diagnostics.has(diagnostic)) return;
  context?.diagnostics.add(diagnostic);
  if (activeRepairCollector != null) activeRepairCollector.canonicalRewriteRequired = true;
  log.warn(`[standby-persistence] ${diagnostic}`);
}

function recordRepair(
  domain: SalvageDomain,
  unit: SalvageUnit,
  discarded: number,
  retained: number,
  reason: SalvageReason,
  discard = false,
): void {
  if (discarded === 0 || activeRepairCollector == null) return;
  const existing = activeRepairCollector.metrics.get(domain);
  if (existing == null) {
    const distribution = new Map<SalvageUnit, Map<SalvageReason, number>>();
    distribution.set(unit, new Map([[reason, discarded]]));
    activeRepairCollector.metrics.set(domain, {
      units: new Set([unit]), discarded, retained, reasons: new Set([reason]), distribution, discard,
    });
    return;
  }
  existing.discarded += discarded;
  existing.retained = Math.max(existing.retained, retained);
  existing.units.add(unit);
  existing.reasons.add(reason);
  const unitDistribution = existing.distribution.get(unit) ?? new Map<SalvageReason, number>();
  unitDistribution.set(reason, (unitDistribution.get(reason) ?? 0) + discarded);
  existing.distribution.set(unit, unitDistribution);
  existing.discard ||= discard;
}

function emitRepairWarnings(collector: RepairCollector): void {
  for (const [domain, metric] of collector.metrics) {
    const reason = REPAIR_REASON_PRIORITY.find((item) => metric.reasons.has(item))!;
    if (metric.discard) {
      log.warn(`[standby-persistence] discard source=${collector.source} domain=${domain} unit=domain reason=${reason}`);
      continue;
    }
    const unit = domain === "foundation.tsunami"
      ? metric.units.has("family") ? "family"
        : metric.units.has("stationCode") ? "stationCode"
          : "eventId"
      : [...metric.units][0]!;
    log.warn(
      `[standby-persistence] salvage source=${collector.source} domain=${domain} unit=${unit} discarded=${metric.discarded} retained=${metric.retained} reason=${reason}`,
    );
  }
}

export class StandbyPersistence {
  private pending: { state: PersistedStandbyStateV2; seq: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** 内容を確定した順の通し番号。書き込み完了の順序が入れ替わっても最新が勝つようにする */
  private seq = 0;
  /** 実際に rename まで到達した最大 seq。これより古い書き込みは rename せずに捨てる */
  private renamedSeq = 0;
  private migrationConflictCount = 0;
  /** salvage した source の原文。canonical write の前に必ず退避する。 */
  private readonly repairSources = new Map<string, RepairSource>();
  private readonly repairBackupAttempts = new Map<string, number>();
  private readonly repairBackupBlockedSince = new Map<string, number>();
  private readonly repairBackupLastWarn = new Map<string, number>();
  private directoryFsyncSupported: boolean | null = null;
  private persistenceSalvageBackupBlocked = 0;
  private persistenceSalvageBackupRecovered = 0;
  private salvageBackupWriteBlocked = false;
  private canonicalRewriteRequired = false;
  /** debounce writer の failure latch。pending と共に保持して monitor から観測できる。 */
  private asyncLastFailure: StandbyPersistenceLastFailure | null = null;

  constructor(
    private readonly persistPath: string,
    private readonly debounceMs: number = SAVE_DEBOUNCE_MS,
    private readonly foundationProvider: (() => PersistedTelegramFoundationInputV2) | null = null,
  ) {}

  load(nowMs = Date.now()): PersistedStandbyStateV2 | null {
    if (!validPersistenceEpoch(nowMs)) throw new Error("invalid standby persistence startup clock");
    const previousReadContext = activeVptaPersistenceReadContext;
    activeVptaPersistenceReadContext = { nowMs, diagnostics: new Set() };
    try {
      this.cleanStaleTmpFiles();
      const v2Path = standbyPersistenceV2Path(this.persistPath);
      const v2 = this.readPath(v2Path, false);
      if (v2.state != null) {
        // rollback 用 standalone v1 も必ず検査する。v2 を正として採用する方針は変えず、
        // rename 間の停止・旧 binary 運用・v1 欠損を telemetry へ出す。
        const standaloneV1 = this.readPath(this.persistPath, true);
        const standaloneConflict = standaloneV1.state == null
          || !rollbackMirrorsSemanticallyEqual(
            this.toV1(v2.state),
            this.toV1(standaloneV1.state),
          );
        if (v2.migrationConflict || standaloneV1.migrationConflict || standaloneConflict) {
          this.recordMigrationConflict("telegram foundation persistence sources conflict; canonical v2 is authoritative");
        }
        return v2.state;
      }
      // Phase 3B 導入途中に同じ path へ書かれた v2 も読み取れるようにしつつ、
      // 現行 writer は旧 reader 用の version:1 と新 schema を別ファイルへ dual-write する。
      const fallback = this.readPath(this.persistPath, true);
      if (fallback.migrationConflict) {
        this.recordMigrationConflict("telegram foundation envelope fields differ; new schema is authoritative");
      }
      if (fallback.state == null || fallback.state.telegramFoundation.vpww56.authoritative) {
        return fallback.state;
      }
      return {
        ...fallback.state,
        weatherAlerts: fallback.state.weatherAlerts?.filter((entry) => entry.source !== "vpww56"),
      };
    } finally {
      activeVptaPersistenceReadContext = previousReadContext;
    }
  }

  save(state: PersistedStandbyState): StandbyPersistenceSaveResult {
    let normalized: PersistedStandbyStateV2;
    try {
      normalized = this.toV2(state);
    } catch (cause) {
      return {
        kind: "failed", requestedSeq: null, failedSeq: null, stage: "validation",
        pendingRetained: true, partialCommit: "none", cause,
      };
    }
    // Validation failure must leave an existing timer untouched. Once validation
    // succeeds, however, this synchronous write owns the retry policy and must not
    // leave a debounce callback armed after a failure.
    this.clearTimer();
    const requestedSeq = ++this.seq;
    const result = this.writeSyncResult(normalized, requestedSeq);
    if (result.kind === "failed" && (this.pending == null || this.pending.seq < requestedSeq)) {
      this.pending = { state: normalized, seq: requestedSeq };
    } else if (result.kind === "written") {
      if (this.pending != null && this.pending.seq <= result.writtenSeq) this.pending = null;
      this.asyncLastFailure = null;
    }
    return result;
  }

  /**
   * 最新状態の保存を予約する。debounceMs 後に 1 回だけ非同期で書く。
   * 予約中に再度呼ばれた場合は最新状態で上書きし、書き込み回数は増やさない。
   */
  schedule(state: PersistedStandbyState): StandbyPersistenceScheduleReceipt {
    // seq は「内容を確定した時点」で採る。書き込み開始時に採ると、予約 → 同期保存の順で
    // 呼ばれたとき古い内容の方が大きい seq を持ってしまい、順序保証が逆転する
    const normalized = this.toV2(state);
    const seq = ++this.seq;
    this.pending = { state: normalized, seq };
    this.armTimer();
    return { kind: "scheduled", seq };
  }

  /**
   * 予約済みの状態を同期で書き切る。シャットダウン経路から呼ぶ。
   * 予約がなければ何もしない (既存ファイルを空書きしない)。
   */
  flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending == null) return;
    this.writeSync(pending.state, pending.seq);
  }

  flushThrough(requiredSeq: number): StandbyPersistenceFlushThroughResult {
    this.clearTimer();
    if (!Number.isSafeInteger(requiredSeq) || requiredSeq < 1) {
      return {
        kind: "failed", requiredSeq, targetSeq: null, failedSeq: null,
        stage: "pendingBehindRequiredSeq", pendingRetained: true,
        partialCommit: "none", cause: new Error("invalid required persistence seq"),
      };
    }
    const pending = this.pending;
    if (pending == null) {
      return this.renamedSeq >= requiredSeq
        ? { kind: "alreadyWritten", requiredSeq, writtenSeq: this.renamedSeq }
        : {
            kind: "failed", requiredSeq, targetSeq: null, failedSeq: null,
            stage: "pendingUnavailable", pendingRetained: true,
            partialCommit: "none", cause: new Error("standby persistence pending unavailable"),
          };
    }
    if (pending.seq < requiredSeq) {
      return {
        kind: "failed", requiredSeq, targetSeq: pending.seq, failedSeq: pending.seq,
        stage: "pendingBehindRequiredSeq", pendingRetained: true,
        partialCommit: "none", cause: new Error("standby persistence pending behind required seq"),
      };
    }
    const targetSeq = pending.seq;
    const result = this.writeSyncResult(pending.state, targetSeq);
    if (result.kind === "failed") return {
      kind: "failed", requiredSeq, targetSeq, failedSeq: result.failedSeq,
      stage: result.stage, pendingRetained: true,
      partialCommit: result.partialCommit, cause: result.cause,
    };
    if (this.pending?.seq === targetSeq) this.pending = null;
    return {
      kind: "written", requiredSeq, targetSeq, writtenSeq: result.writtenSeq,
      v2Committed: true, v1Committed: true,
    };
  }

  /** debounce callback だけを停止し、最新 pending は shutdown の同期保存用に保持する。 */
  stopTimer(): void {
    this.clearTimer();
  }

  /** 予約を捨てる (テスト・再初期化用。ディスク上の内容は触らない) */
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  takeMigrationConflictCount(): number {
    const count = this.migrationConflictCount;
    this.migrationConflictCount = 0;
    return count;
  }

  lastFailure(): StandbyPersistenceLastFailure | null {
    return this.asyncLastFailure;
  }

  isUnhealthy(): boolean {
    return this.asyncLastFailure != null;
  }

  /** monitor diagnostics 用。counter は process lifetime で単調増加する。 */
  salvageBackupDiagnostics(): {
    persistenceSalvageBackupBlocked: number;
    persistenceSalvageBackupRecovered: number;
    pendingSources: number;
  } {
    return {
      persistenceSalvageBackupBlocked: this.persistenceSalvageBackupBlocked,
      persistenceSalvageBackupRecovered: this.persistenceSalvageBackupRecovered,
      pendingSources: this.repairSources.size,
    };
  }

  /** restore と startup sweep の後に一度だけ canonical rewrite を予約するための問い合せ。 */
  hasPendingSalvageRepair(): boolean {
    return this.repairSources.size > 0 || this.canonicalRewriteRequired;
  }

  private recordMigrationConflict(detail: string): void {
    this.migrationConflictCount++;
    this.canonicalRewriteRequired = true;
    log.warn(`[standby-persistence] persistenceMigrationConflict: ${detail}`);
  }

  private toV2(state: PersistedStandbyState): PersistedStandbyStateV2 {
    const validatedBriefingCritical = state.briefingCritical == null
      ? undefined
      : validateBriefingCriticalState(state.briefingCritical, true);
    const briefingCritical = validatedBriefingCritical == null
      || validatedBriefingCritical.entries.length === 0
        && validatedBriefingCritical.cancellations.length === 0
        && validatedBriefingCritical.watermarks.length === 0
        && (validatedBriefingCritical.rawAliases?.length ?? 0) === 0
      ? undefined
      : validatedBriefingCritical;
    const foundation = this.foundationProvider?.()
      ?? (state.version === 2 ? state.telegramFoundation : emptyTelegramFoundation());
    const tsunami = normalizeTsunamiFoundationForWrite(
      foundation.tsunami ?? emptyTsunamiFoundation(),
    );
    const vpww56 = normalizeVpww56FoundationForWrite(
      foundation.vpww56 ?? emptyVpww56Foundation(),
    );
    const volcano = normalizeVolcanoFoundationForWrite(
      foundation.volcano ?? emptyVolcanoFoundation(),
    );
    const floodForecast = normalizeFloodFoundationForWrite(
      foundation.floodForecast ?? emptyFloodFoundation(),
    );
    const typhoonProbabilities = normalizeTyphoonProbabilityStatesForWrite(
      state.typhoonProbabilities,
    );
    const standbyDomains = normalizeStandbyDomainsFoundationForWrite(
      foundation.standbyDomains ?? emptyStandbyDomainsFoundation(),
      new Set(typhoonProbabilities.map((projection) =>
        `typhoonProbability:${projection.key}`)),
    );
    const typhoons = normalizeTyphoonStatesForWrite(state.typhoons);
    const vptaGates = new Map(standbyDomains.gateEntries
      .filter((entry) => entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50")
      .map((entry) => [entry.stateSubjectKey, entry]));
    for (const projection of typhoonProbabilities) {
      const gate = vptaGates.get(`typhoonProbability:${projection.key}`);
      if (gate == null || gate.cancelled || !standbyProjectionMatchesGate(
        projection.revision, projection.appliedSemanticKey, gate,
      )) throw new Error("invalid VPTA persistence coupling");
    }
    const {
      briefingCritical: _briefingCritical,
      typhoonProbabilities: _typhoonProbabilities,
      typhoonProbabilityGateMetadata: _typhoonProbabilityGateMetadata,
      ...stateWithoutBriefingCritical
    } = state;
    const rawProjectionState = salvageStandbyDomainProjections(
      {
        ...stateWithoutBriefingCritical,
        version: 1,
        typhoons,
        ...(typhoonProbabilities.length === 0 ? {} : { typhoonProbabilities }),
        ...(briefingCritical == null ? {} : { briefingCritical }),
      },
      standbyDomains,
    );
    const vptaEventIds = new Set(typhoonProbabilities.map((projection) => projection.key));
    for (const entry of foundation.standbyDomains?.gateEntries ?? []) {
      if (entry.domain !== "typhoonProbability" || entry.revisionFamily !== "VPTA50") continue;
      const eventId = vptaEventIdFromSubject(entry.stateSubjectKey);
      if (eventId != null) vptaEventIds.add(eventId);
    }
    const projectionState = stripVptaRollbackSeen(rawProjectionState, vptaEventIds);
    const seen = mergeLegacySeenEntries(
      projectionState.seen,
      volcanoLegacySeenEntries(volcano.gateEntries, volcano.state),
    );
    const rollbackSeen = mergeLegacySeenEntries(seen, standbyLegacySeenEntries(standbyDomains.gateEntries));
    const probabilityGateMetadata = vptaGateMetadata(standbyDomains.gateEntries);
    return {
      ...projectionState,
      version: 2,
      seen: rollbackSeen,
      ...(probabilityGateMetadata.length === 0
        ? {}
        : { typhoonProbabilityGateMetadata: probabilityGateMetadata }),
      floods: floodForecast.authoritative
        ? {
            events: structuredClone(floodForecast.active),
            seen: floodLegacySeenEntries(floodForecast.gateEntries),
          }
        : state.floods,
      telegramFoundation: structuredClone({
        ...foundation,
        vpww56,
        tsunami,
        volcano,
        floodForecast,
        standbyDomains,
      }),
    };
  }

  private toV1(state: PersistedStandbyStateV2): PersistedStandbyStateV1 {
    const {
      telegramFoundation: _foundation,
      version: _version,
      typhoonProbabilities,
      typhoonProbabilityGateMetadata: _legacyProbabilityMetadata,
      ...legacy
    } = state;
    return {
      ...legacy,
      version: 1,
      ...(typhoonProbabilities == null || typhoonProbabilities.length === 0
        ? {}
        : { typhoonProbabilities }),
      ...(vptaGateMetadata(state.telegramFoundation.standbyDomains.gateEntries).length === 0
        ? {}
        : {
            typhoonProbabilityGateMetadata: vptaGateMetadata(
              state.telegramFoundation.standbyDomains.gateEntries,
            ),
          }),
      seen: mergeLegacySeenEntries(
        mergeLegacySeenEntries(
          legacy.seen,
          volcanoLegacySeenEntries(
            state.telegramFoundation.volcano.gateEntries,
            state.telegramFoundation.volcano.state,
          ),
        ),
        standbyLegacySeenEntries(state.telegramFoundation.standbyDomains.gateEntries),
      ),
      floods: state.telegramFoundation.floodForecast.authoritative
        ? {
            events: structuredClone(state.telegramFoundation.floodForecast.active),
            seen: floodLegacySeenEntries(state.telegramFoundation.floodForecast.gateEntries),
          }
        : legacy.floods,
    };
  }

  private readPath(filePath: string, allowV1: boolean): PersistedReadResult {
    if (!fs.existsSync(filePath)) return { state: null, migrationConflict: false };
    let raw: Buffer | null = null;
    const collector: RepairCollector = {
      source: path.basename(filePath), metrics: new Map(), canonicalRewriteRequired: false,
    };
    try {
      raw = fs.readFileSync(filePath);
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      const version = isRecord(parsed) ? parsed.version : undefined;
      activeRepairCollector = collector;
      let sanitized: PersistedStandbyStateV2 | null;
      try {
        sanitized = version === PERSIST_SCHEMA_VERSION
          ? sanitizePersistedStandbyStateV2(parsed)
          : allowV1 && version === 1
            ? migratePersistedStandbyStateV1(parsed)
            : null;
      } finally {
        activeRepairCollector = null;
      }
      this.canonicalRewriteRequired ||= collector.canonicalRewriteRequired;
      if (sanitized == null) {
        log.warn(`[standby-persistence] top-level structure validation 失敗 — 破棄 (${path.basename(filePath)})`);
        // Top-level failures have no closed domain token, but still require original-byte backup
        // if another source supplies a canonical state.
        this.repairSources.set(filePath, { bytes: raw, metrics: collector.metrics });
      } else if (collector.metrics.size > 0) {
        emitRepairWarnings(collector);
        this.repairSources.set(filePath, { bytes: raw, metrics: collector.metrics });
      }
      return {
        state: sanitized,
        migrationConflict: sanitized != null
          && version === PERSIST_SCHEMA_VERSION
          && hasFoundationMigrationConflict(parsed, sanitized),
      };
    } catch (err) {
      log.warn(`[standby-persistence] load 失敗 (${path.basename(filePath)}): ${err instanceof Error ? err.message : String(err)}`);
      if (raw != null) this.repairSources.set(filePath, { bytes: raw, metrics: collector.metrics });
      return { state: null, migrationConflict: false };
    }
  }

  /**
   * rename 前に強制終了すると seq 固有名の tmp が残る (Pi は電源断が起こりうる)。
   * 起動時の load で同ディレクトリの残骸を掃除する。掃除の失敗は起動を妨げない。
   */
  private cleanStaleTmpFiles(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) return;
      const bases = [this.persistPath, standbyPersistenceV2Path(this.persistPath)].map((item) => path.basename(item));
      for (const name of fs.readdirSync(dir)) {
        if (bases.some((base) => name.startsWith(`${base}.`) && name.endsWith(".tmp"))) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch (err) {
      log.debug(`[standby-persistence] 残留 tmp の掃除に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** tmp 名は書き込みごとに一意にする (同期・非同期が同じ tmp を奪い合わないため) */
  private tmpPathFor(filePath: string, seq: number): string {
    return `${filePath}.${seq}.tmp`;
  }

  private writeSync(state: PersistedStandbyStateV2, seq: number): void {
    const result = this.writeSyncResult(state, seq);
    if (result.kind === "failed") {
      if (this.pending == null || this.pending.seq < seq) this.pending = { state, seq };
      log.warn(`[standby-persistence] save 失敗: ${result.cause instanceof Error ? result.cause.message : String(result.cause)}`);
    }
  }

  private writeSyncResult(
    state: PersistedStandbyStateV2,
    seq: number,
  ): StandbyPersistenceSaveResult {
    if (!this.backupRepairSources()) return {
      kind: "failed", requestedSeq: seq, failedSeq: seq, stage: "salvageBackup",
      pendingRetained: true, partialCommit: "none", cause: new Error("salvage backup blocked"),
    };
    const v2Path = standbyPersistenceV2Path(this.persistPath);
    const v2TmpPath = this.tmpPathFor(v2Path, seq);
    const v1TmpPath = this.tmpPathFor(this.persistPath, seq);
    const failure = (
      stage: StandbyPersistenceWriteFailureStage,
      cause: unknown,
      partialCommit: "none" | "v2Only" | "unknown" = "none",
    ): StandbyPersistenceSaveResult => {
      for (const tmpPath of [v2TmpPath, v1TmpPath]) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* primary failure wins */ }
      }
      return {
        kind: "failed", requestedSeq: seq, failedSeq: seq, stage,
        pendingRetained: true, partialCommit, cause,
      };
    };
    try { fs.mkdirSync(path.dirname(this.persistPath), { recursive: true }); }
    catch (cause) { return failure("mkdir", cause); }
    try { fs.writeFileSync(v2TmpPath, JSON.stringify(state), "utf8"); }
    catch (cause) { return failure("writeV2Temp", cause); }
    let legacy: PersistedStandbyStateV1;
    try {
      legacy = this.toV1(state);
      fs.writeFileSync(v1TmpPath, JSON.stringify(legacy), "utf8");
    } catch (cause) { return failure("writeV1Temp", cause); }
    if (seq < this.renamedSeq) {
      for (const tmpPath of [v2TmpPath, v1TmpPath]) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* stale temp cleanup */ }
      }
      return {
        kind: "written", requestedSeq: seq, writtenSeq: this.renamedSeq,
        v2Committed: true, v1Committed: true,
      };
    }
    try { fs.renameSync(v2TmpPath, v2Path); }
    catch (cause) { return failure("renameV2", cause); }
    try { fs.renameSync(v1TmpPath, this.persistPath); }
    catch (cause) { return failure("renameV1", cause, "v2Only"); }
    this.renamedSeq = seq;
    this.canonicalRewriteRequired = false;
    return {
      kind: "written", requestedSeq: seq, writtenSeq: seq,
      v2Committed: true, v1Committed: true,
    };
  }

  /** テスト用: 予約済みの書き込みをタイマーを待たずに実行する (実時間依存を避けるため) */
  __test_writePending(): Promise<void> {
    this.clearTimer();
    return this.writePending();
  }

  private armTimer(): void {
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writePending();
    }, this.debounceMs);
    // 保存予約だけでプロセスを生かし続けない (書き切りは flush の責務)
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async writePending(): Promise<void> {
    if (this.writing) return;
    const pending = this.pending;
    if (pending == null) return;
    if (!this.backupRepairSources()) {
      if (this.pending == null || this.pending.seq < pending.seq) this.pending = pending;
      this.asyncLastFailure = {
        kind: "failed", requestedSeq: pending.seq, failedSeq: pending.seq,
        stage: "salvageBackup", pendingRetained: true, partialCommit: "none",
        cause: new Error("salvage backup blocked"),
      };
      return;
    }
    this.pending = null;
    this.writing = true;
    const v2Path = standbyPersistenceV2Path(this.persistPath);
    const v2TmpPath = this.tmpPathFor(v2Path, pending.seq);
    const v1TmpPath = this.tmpPathFor(this.persistPath, pending.seq);
    let failed = false;
    let stage: StandbyPersistenceWriteFailureStage = "mkdir";
    let partialCommit: StandbyPersistenceLastFailure["partialCommit"] = "none";
    try {
      stage = "mkdir";
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      stage = "writeV2Temp";
      await fs.promises.writeFile(v2TmpPath, JSON.stringify(pending.state), "utf8");
      stage = "writeV1Temp";
      await fs.promises.writeFile(v1TmpPath, JSON.stringify(this.toV1(pending.state)), "utf8");
      // ここから rename までは await を挟まない。await で中断すると、guard 通過後・rename 完了前に
      // 同期保存が割り込み、そのあと古い rename が完了して旧内容で上書き + renamedSeq 逆行が起きる
      if (pending.seq < this.renamedSeq) {
        fs.rmSync(v2TmpPath, { force: true });
        fs.rmSync(v1TmpPath, { force: true });
        return;
      }
      stage = "renameV2";
      fs.renameSync(v2TmpPath, v2Path);
      partialCommit = "v2Only";
      stage = "renameV1";
      fs.renameSync(v1TmpPath, this.persistPath);
      this.renamedSeq = pending.seq;
      this.canonicalRewriteRequired = false;
      this.asyncLastFailure = null;
    } catch (err) {
      failed = true;
      this.restorePending(pending);
      this.asyncLastFailure = {
        kind: "failed", requestedSeq: pending.seq, failedSeq: pending.seq,
        stage, pendingRetained: true, partialCommit, cause: err,
      };
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      for (const tmpPath of [v2TmpPath, v1TmpPath]) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
      }
    } finally {
      this.writing = false;
      // 書き込み中に届いた更新は、終わってからもう一度だけ書く
      if (!failed && this.pending != null) this.armTimer();
    }
  }

  private restorePending(pending: { state: PersistedStandbyStateV2; seq: number }): void {
    if (this.pending == null || this.pending.seq < pending.seq) this.pending = pending;
  }

  private backupRepairSources(): boolean {
    if (this.repairSources.size === 0) return true;
    let allSucceeded = true;
    for (const [sourcePath, source] of [...this.repairSources]) {
      const attempts = (this.repairBackupAttempts.get(sourcePath) ?? 0) + 1;
      this.repairBackupAttempts.set(sourcePath, attempts);
      try {
        this.writeSalvageBackup(sourcePath, source.bytes);
        this.repairSources.delete(sourcePath);
        this.repairBackupAttempts.delete(sourcePath);
        this.repairBackupBlockedSince.delete(sourcePath);
        this.repairBackupLastWarn.delete(sourcePath);
      } catch (err) {
        allSucceeded = false;
        if (!this.salvageBackupWriteBlocked) {
          this.salvageBackupWriteBlocked = true;
          this.persistenceSalvageBackupBlocked++;
        }
        const nowMs = Date.now();
        const blockedSince = this.repairBackupBlockedSince.get(sourcePath) ?? nowMs;
        this.repairBackupBlockedSince.set(sourcePath, blockedSince);
        const lastWarn = this.repairBackupLastWarn.get(sourcePath) ?? -Infinity;
        if (nowMs - lastWarn >= 60_000) {
          this.repairBackupLastWarn.set(sourcePath, nowMs);
          log.warn(
            `[standby-persistence] salvage backup blocked source=${path.basename(sourcePath)} attempts=${attempts} blockedMs=${nowMs - blockedSince}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (allSucceeded) {
      if (this.salvageBackupWriteBlocked) {
        this.salvageBackupWriteBlocked = false;
        this.persistenceSalvageBackupRecovered++;
      }
      return true;
    }
    return false;
  }

  private writeSalvageBackup(sourcePath: string, bytes: Buffer): void {
    const directory = path.dirname(sourcePath);
    const base = path.basename(sourcePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let fd: number | null = null;
    let backupPath = "";
    let created = false;
    try {
      for (let suffix = 0; ; suffix++) {
        backupPath = path.join(directory, `${base}.${timestamp}.${suffix}.salvage-backup`);
        try {
          fd = fs.openSync(backupPath, "wx");
          created = true;
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("salvage backup write made no progress");
        offset += written;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      this.fsyncBackupDirectory(directory);
    } catch (err) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch { /* original backup error takes precedence */ }
      }
      // この試行で wx 作成した未完了 backup だけを残さない。既存 collision file は触れない。
      if (created && backupPath !== "") {
        try { fs.unlinkSync(backupPath); } catch { /* original backup error takes precedence */ }
      }
      throw err;
    }
  }

  private fsyncBackupDirectory(directory: string): void {
    if (this.directoryFsyncSupported === false) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(directory, "r");
      fs.fsyncSync(fd);
      this.directoryFsyncSupported = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
        if (this.directoryFsyncSupported == null) {
          log.debug("[standby-persistence] directory fsync is not supported on this platform");
        }
        this.directoryFsyncSupported = false;
        return;
      }
      throw err;
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is StandbyRevision {
  if (!isRecord(value)) return false;
  return typeof value.reportTimeMs === "number" && Number.isFinite(value.reportTimeMs)
    && (value.serial == null || typeof value.serial === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHeatAreaArray(value: unknown): value is DisplayHeatAreaV1[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.areaName === "string" && typeof item.isSpecial === "boolean",
  );
}

function isHeatState(value: unknown): value is PersistedHeatStateV1 {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isStringArray(value.sourceEventIds)
    && typeof value.targetDate === "string"
    && typeof value.targetDateEndMs === "number"
    && Number.isFinite(value.targetDateEndMs)
    && isHeatAreaArray(value.areas)
    && typeof value.isSpecial === "boolean"
    && isRevision(value.revision);
}

function isSeenEntry(value: unknown): value is PersistedSeenEntry {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isRevision(value.revision)
    && typeof value.forgetAtMs === "number"
    && Number.isFinite(value.forgetAtMs);
}

function isFloodTrend(value: unknown): value is DisplayFloodStationV1["trend"] {
  return value == null || value === "rising" || value === "falling" || value === "steady";
}

function isFloodHydrograph(value: unknown): value is DisplayFloodHydrographV1 {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.points) || value.points.length === 0) return false;
  const pointsWellFormed = value.points.every((point, i) => isRecord(point)
    && typeof point.dateTime === "string"
    && isNullableFiniteNumber(point.valueM)
    // phase 不変条件: 先頭 (i===0) は現況 observed、以降はすべて予測 forecast。
    // 描画側は phase を読まず先頭=現況/残り=予測として扱うため、逆順の壊れた永続データは破棄する
    && point.phase === (i === 0 ? "observed" : "forecast"));
  if (!pointsWellFormed) return false;
  // 有効値が 1 点も無い hydrograph は描画不能なので破棄 (project-flood.ts の生成条件と同じ)
  if (!value.points.some((point) => isRecord(point) && point.valueM != null)) return false;
  return isNullableFiniteNumber(value.dangerLevelM);
}

function isFloodStation(value: unknown): value is DisplayFloodStationV1 {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && isNullableFiniteNumber(value.levelM)
    && isFloodTrend(value.trend)
    && isNullableString(value.thresholdLabel)
    && (!Object.hasOwn(value, "hydrograph") || value.hydrograph == null || isFloodHydrograph(value.hydrograph));
}

function isFloodRiver(value: unknown): value is DisplayFloodRiverV1 {
  if (!isRecord(value)) return false;
  return typeof value.riverKey === "string"
    && typeof value.riverName === "string"
    && typeof value.level === "string"
    && typeof value.levelRank === "number"
    && Number.isFinite(value.levelRank)
    && typeof value.kindName === "string"
    && typeof value.reportDateTime === "string"
    && (!Object.hasOwn(value, "station") || value.station == null || isFloodStation(value.station));
}

function isFloodEvent(value: unknown): value is PersistedFloodState["events"][number] {
  return isRecord(value)
    && typeof value.eventId === "string"
    && isRevision(value.revision)
    && (!Object.hasOwn(value, "appliedRevision") || isRevision(value.appliedRevision))
    && (!Object.hasOwn(value, "appliedSemanticKey") || typeof value.appliedSemanticKey === "string")
    && Array.isArray(value.rivers)
    && value.rivers.every(isFloodRiver)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeFloodState(value: unknown): PersistedFloodState | undefined {
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.seen)) {
    recordRepair("root.floods", "eventId", 1, 0, "invalid-container", true);
    return undefined;
  }
  const events = value.events.filter(isFloodEvent);
  const validEventIds = new Set(events.map((event) => event.eventId));
  const discardedEventIds = new Set<string>();
  for (const event of value.events) {
    if (isRecord(event) && typeof event.eventId === "string" && !validEventIds.has(event.eventId)) {
      discardedEventIds.add(event.eventId);
    }
  }
  const seen = value.seen.filter(
    (entry): entry is PersistedSeenEntry => isSeenEntry(entry) && !discardedEventIds.has(entry.key),
  );
  if (events.length !== value.events.length || seen.length !== value.seen.length) {
    const discardedBundles = new Set(discardedEventIds);
    for (const entry of value.seen) {
      if (isRecord(entry) && typeof entry.key === "string" && !isSeenEntry(entry)) discardedBundles.add(entry.key);
    }
    const retainedBundles = new Set([...events.map((event) => event.eventId), ...seen.map((entry) => entry.key)]);
    recordRepair(
      "root.floods",
      "eventId",
      discardedBundles.size || 1,
      retainedBundles.size,
      "invalid-entry",
    );
  }
  return { events, seen };
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isFinite(value);
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableString(value[key]);
}

function hasNullableFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableFiniteNumber(value[key]);
}

function isTyphoon(value: unknown): value is DisplayTyphoonV1 {
  if (!isRecord(value)) return false;
  return typeof value.typhoonKey === "string"
    && hasNullableString(value, "name")
    && hasNullableString(value, "nameKana")
    && hasNullableString(value, "remark")
    && hasNullableString(value, "typhoonNumber")
    && hasNullableString(value, "category")
    && hasNullableString(value, "location")
    && hasNullableFiniteNumber(value, "pressureHpa")
    && (!Object.hasOwn(value, "pressureDeltaHpa") || isNullableFiniteNumber(value.pressureDeltaHpa))
    && hasNullableFiniteNumber(value, "maxWindMs")
    && (!Object.hasOwn(value, "maxGustMs") || isNullableFiniteNumber(value.maxGustMs))
    && (!Object.hasOwn(value, "maxWindDeltaMs") || isNullableFiniteNumber(value.maxWindDeltaMs))
    && (!Object.hasOwn(value, "intensityTrend")
      || value.intensityTrend == null
      || value.intensityTrend === "developing"
      || value.intensityTrend === "weakening"
      || value.intensityTrend === "steady")
    && hasNullableString(value, "moveDirection")
    && hasNullableFiniteNumber(value, "moveSpeedKmh")
    && typeof value.reportDateTime === "string";
}

function sanitizeTyphoonState(value: unknown): PersistedTyphoonStateV1 | null {
  if (
    !isRecord(value)
    || typeof value.key !== "string"
    || typeof value.sourceEventId !== "string"
    || !isTyphoon(value.typhoon)
    || !isRevision(value.revision)
    || typeof value.expiresAtMs !== "number"
    || !Number.isFinite(value.expiresAtMs)
    || Object.hasOwn(value, "appliedSemanticKey")
      && typeof value.appliedSemanticKey !== "string"
  ) return null;
  const parseOrMigrate = (
    key: "pressureHpaValue" | "maxWindMsValue" | "maxGustMsValue" | "moveSpeedKmhValue",
    scalar: number | null,
  ): SpecialValue<number> | null => Object.hasOwn(value, key)
    ? parsePersistedTyphoonNumericValue(value[key])
    : typhoonNumericValueFromLegacyScalar(scalar);
  const pressureHpaValue = parseOrMigrate("pressureHpaValue", value.typhoon.pressureHpa);
  const maxWindMsValue = parseOrMigrate("maxWindMsValue", value.typhoon.maxWindMs);
  const maxGustMsValue = parseOrMigrate("maxGustMsValue", value.typhoon.maxGustMs ?? null);
  const moveSpeedKmhValue = parseOrMigrate("moveSpeedKmhValue", value.typhoon.moveSpeedKmh);
  if (
    pressureHpaValue == null
    || maxWindMsValue == null
    || maxGustMsValue == null
    || moveSpeedKmhValue == null
  ) return null;
  return {
    key: value.key,
    sourceEventId: value.sourceEventId,
    typhoon: structuredClone(value.typhoon),
    pressureHpaValue,
    maxWindMsValue,
    maxGustMsValue,
    moveSpeedKmhValue,
    revision: { ...value.revision },
    expiresAtMs: value.expiresAtMs,
    ...(typeof value.appliedSemanticKey === "string"
      ? { appliedSemanticKey: value.appliedSemanticKey }
      : {}),
  };
}

function sanitizeTyphoonStates(value: unknown): PersistedTyphoonStateV1[] {
  if (!Array.isArray(value)) {
    recordRepair("root.typhoons", "entry", 1, 0, "invalid-container", true);
    return [];
  }
  const states = value.flatMap((entry) => {
    const state = sanitizeTyphoonState(entry);
    return state == null ? [] : [state];
  });
  if (states.length !== value.length) {
    recordRepair("root.typhoons", "entry", value.length - states.length, states.length, "invalid-entry");
  }
  return states;
}

function normalizeTyphoonStatesForWrite(
  states: readonly PersistedTyphoonStateV1[],
): PersistedTyphoonStateV1[] {
  return states.map((state) => {
    const normalized = sanitizeTyphoonState(state);
    if (normalized == null) throw new Error("invalid persisted typhoon state");
    return {
      ...normalized,
      pressureHpaValue: normalizeTyphoonNumericValueForPersistence(normalized.pressureHpaValue!),
      maxWindMsValue: normalizeTyphoonNumericValueForPersistence(normalized.maxWindMsValue!),
      maxGustMsValue: normalizeTyphoonNumericValueForPersistence(normalized.maxGustMsValue!),
      moveSpeedKmhValue: normalizeTyphoonNumericValueForPersistence(normalized.moveSpeedKmhValue!),
    };
  });
}

function exactBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= maxLength;
}

function validProbabilityInteger(value: unknown, active = false): value is number {
  return Number.isSafeInteger(value) && (value as number) >= (active ? 1 : 0) && (value as number) <= 100;
}

function validPersistenceEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value as number).getTime());
}

type OptionalArrayMode = "absent" | "present-array" | "present-invalid";

function optionalArrayMode(value: Record<string, unknown>, key: string): OptionalArrayMode {
  if (!Object.hasOwn(value, key)) return "absent";
  return Array.isArray(value[key]) ? "present-array" : "present-invalid";
}

function rawHasVptaEvidence(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, "typhoonProbabilities")
    || Object.hasOwn(value, "typhoonProbabilityGateMetadata")) return true;
  if (Array.isArray(value.seen) && value.seen.slice(0, TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1)
    .some((entry) => isRecord(entry)
      && typeof entry.key === "string"
      && entry.key.startsWith("typhoonProbability:"))) return true;
  if (!isRecord(value.telegramFoundation)
    || !isRecord(value.telegramFoundation.standbyDomains)
    || !Array.isArray(value.telegramFoundation.standbyDomains.gateEntries)) return false;
  return value.telegramFoundation.standbyDomains.gateEntries
    .slice(0, TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1)
    .some((entry) => isRecord(entry)
      && entry.domain === "typhoonProbability"
      && entry.revisionFamily === "VPTA50");
}

function vptaEventIdFromSubject(subject: unknown): string | null {
  if (typeof subject !== "string" || !subject.startsWith("typhoonProbability:")) return null;
  const eventId = subject.slice("typhoonProbability:".length);
  return validateTyphoonProbabilityEventId(eventId) === eventId ? eventId : null;
}

function collectRawVptaEventIds(value: Record<string, unknown>): Set<string> {
  const eventIds = new Set<string>();
  if (Array.isArray(value.typhoonProbabilities)) {
    for (const item of value.typhoonProbabilities.slice(
      0,
      TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1,
    )) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      if (validateTyphoonProbabilityEventId(item.key) === item.key) eventIds.add(item.key);
    }
  }
  if (Array.isArray(value.typhoonProbabilityGateMetadata)) {
    for (const item of value.typhoonProbabilityGateMetadata.slice(
      0,
      TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1,
    )) {
      if (!isRecord(item)) continue;
      const eventId = vptaEventIdFromSubject(item.stateSubjectKey);
      if (eventId != null) eventIds.add(eventId);
    }
  }
  if (isRecord(value.telegramFoundation)
    && isRecord(value.telegramFoundation.standbyDomains)
    && Array.isArray(value.telegramFoundation.standbyDomains.gateEntries)) {
    for (const item of value.telegramFoundation.standbyDomains.gateEntries.slice(
      0,
      TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1,
    )) {
      if (!isRecord(item)
        || item.domain !== "typhoonProbability"
        || item.revisionFamily !== "VPTA50") continue;
      const eventId = vptaEventIdFromSubject(item.stateSubjectKey);
      if (eventId != null) eventIds.add(eventId);
    }
  }
  if (Array.isArray(value.seen)) {
    const claimedLegacyKeys = new Set<string>([
      ...(Array.isArray(value.heat) ? value.heat.flatMap((item) =>
        isRecord(item) && typeof item.key === "string" ? [item.key] : []) : []),
      ...(Array.isArray(value.typhoons) ? value.typhoons.flatMap((item) =>
        isRecord(item) && typeof item.key === "string" ? [`typhoon:${item.key}`] : []) : []),
      ...(Array.isArray(value.tornado) ? value.tornado.flatMap((item) =>
        isRecord(item) && typeof item.publishingOffice === "string"
          ? [`tornado:${item.publishingOffice}`] : []) : []),
      ...(Array.isArray(value.longPeriod) ? value.longPeriod.flatMap((item) =>
        isRecord(item) && typeof item.eventId === "string"
          ? [`longPeriod:${item.eventId}`] : []) : []),
      ...(value.nankaiTrough == null ? [] : ["nankai:current"]),
    ]);
    const allowUnprefixedSeen = Array.isArray(value.typhoonProbabilities);
    for (const item of value.seen.slice(0, TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS + 1)) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      const eventId = item.key.startsWith("typhoonProbability:")
        ? item.key.slice("typhoonProbability:".length)
        : allowUnprefixedSeen && !claimedLegacyKeys.has(item.key) ? item.key : "";
      if (validateTyphoonProbabilityEventId(eventId) === eventId) eventIds.add(eventId);
    }
  }
  return eventIds;
}

function vptaRawDomainExceedsHardLimit(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.typhoonProbabilities)
    && value.typhoonProbabilities.length > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) return true;
  if (Array.isArray(value.typhoonProbabilityGateMetadata)
    && value.typhoonProbabilityGateMetadata.length > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) return true;
  if (isRecord(value.telegramFoundation)
    && isRecord(value.telegramFoundation.standbyDomains)
    && Array.isArray(value.telegramFoundation.standbyDomains.gateEntries)) {
    let vptaItems = 0;
    for (const item of value.telegramFoundation.standbyDomains.gateEntries) {
      if (isRecord(item)
        && item.domain === "typhoonProbability"
        && item.revisionFamily === "VPTA50"
        && ++vptaItems > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) return true;
    }
  }
  const eventIds = collectRawVptaEventIds(value);
  if (eventIds.size > TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES) return true;
  if (Array.isArray(value.seen)) {
    let vptaItems = 0;
    for (const item of value.seen) {
      if (isRecord(item)
        && typeof item.key === "string"
        && (item.key.startsWith("typhoonProbability:") || eventIds.has(item.key))
        && ++vptaItems > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) return true;
    }
  }
  return false;
}

function stripVptaRollbackSeen(
  base: PersistedStandbyStateV1,
  eventIds: ReadonlySet<string>,
): PersistedStandbyStateV1 {
  const seen = base.seen.filter((entry) =>
    !entry.key.startsWith("typhoonProbability:") && !eventIds.has(entry.key));
  return seen.length === base.seen.length ? base : { ...base, seen };
}

function removeVptaRootDomain(
  base: PersistedStandbyStateV1,
  eventIds: ReadonlySet<string>,
): PersistedStandbyStateV1 {
  const {
    typhoonProbabilities: _typhoonProbabilities,
    typhoonProbabilityGateMetadata: _typhoonProbabilityGateMetadata,
    ...withoutVpta
  } = stripVptaRollbackSeen(base, eventIds);
  return withoutVpta;
}

function sanitizeTyphoonProbabilityState(
  value: unknown,
): PersistedTyphoonProbabilityStateV1 | null {
  if (!isRecord(value)) return null;
  const activePrefectureCount = value.activePrefectureCount;
  const revisionSerial = isRecord(value.revision) && Object.hasOwn(value.revision, "serial")
    && (value.revision.serial === null || typeof value.revision.serial === "string")
    ? normalizeVpta50Serial(value.revision.serial)
    : { kind: "invalid" as const };
  if (!isRecord(value)
    || !exactBoundedString(value.key, TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH)
    || validateTyphoonProbabilityEventId(value.key) !== value.key
    || !exactBoundedString(value.sourceEventId, TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH)
    || !isRecord(value.identity)
    || !validPersistenceEpoch(value.baseTimeMs)
    || !validProbabilityInteger(value.maxFiveDayProbability, true)
    || typeof activePrefectureCount !== "number"
    || !Number.isSafeInteger(activePrefectureCount)
    || activePrefectureCount < 1
    || activePrefectureCount > TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES
    || !Array.isArray(value.topPrefectures)
    || !isRecord(value.worstArea)
    || !isRevision(value.revision)
    || !validPersistenceEpoch(value.revision.reportTimeMs)
    || revisionSerial.kind === "invalid"
    || !exactBoundedString(value.appliedSemanticKey, TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH)
    || !validPersistenceEpoch(value.expiresAtMs)
    || value.expiresAtMs <= value.baseTimeMs
    || value.expiresAtMs - value.baseTimeMs > 120 * 60 * 60_000) return null;
  const identityValue = value.identity;
  const nullableIdentity = (
    key: "name" | "nameKana" | "remark" | "typhoonNumber",
    maxLength: number,
  ): string | null | undefined => {
    if (!Object.hasOwn(identityValue, key)) return undefined;
    const item = identityValue[key];
    return item === null ? null : exactBoundedString(item, maxLength) ? item : undefined;
  };
  const identity = {
    name: nullableIdentity("name", TYPHOON_PROBABILITY_MAX_NAME_LENGTH),
    nameKana: nullableIdentity("nameKana", TYPHOON_PROBABILITY_MAX_NAME_LENGTH),
    remark: nullableIdentity("remark", TYPHOON_PROBABILITY_MAX_REMARK_LENGTH),
    typhoonNumber: nullableIdentity("typhoonNumber", TYPHOON_PROBABILITY_MAX_CODE_LENGTH),
  };
  if (Object.values(identity).some((item) => item === undefined)) return null;
  if (value.topPrefectures.length !== Math.min(
    TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES,
    activePrefectureCount,
  )) return null;
  const topPrefectures: PersistedTyphoonProbabilityPrefectureV1[] = [];
  const codes = new Set<string>();
  for (const item of value.topPrefectures) {
    if (!isRecord(item)
      || !exactBoundedString(item.prefectureCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
      || !exactBoundedString(item.prefectureName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
      || !validProbabilityInteger(item.fiveDayProbability, true)
      || codes.has(item.prefectureCode)) return null;
    codes.add(item.prefectureCode);
    topPrefectures.push({
      prefectureCode: item.prefectureCode,
      prefectureName: item.prefectureName,
      fiveDayProbability: item.fiveDayProbability,
    });
  }
  for (let index = 1; index < topPrefectures.length; index += 1) {
    const previous = topPrefectures[index - 1]!, current = topPrefectures[index]!;
    if (previous.fiveDayProbability < current.fiveDayProbability
      || previous.fiveDayProbability === current.fiveDayProbability
        && previous.prefectureCode >= current.prefectureCode) return null;
  }
  const worst = value.worstArea;
  if (!exactBoundedString(worst.areaCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
    || !exactBoundedString(worst.areaName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !exactBoundedString(worst.prefectureCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
    || !exactBoundedString(worst.prefectureName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !validProbabilityInteger(worst.fiveDayProbability, true)
    || !Object.hasOwn(worst, "peakAtMs")
    || !(worst.peakAtMs == null || validPersistenceEpoch(worst.peakAtMs)
      && worst.peakAtMs >= value.baseTimeMs && worst.peakAtMs < value.expiresAtMs)) return null;
  const matchingWorst = topPrefectures.filter((item) =>
    item.prefectureCode === worst.prefectureCode
    && item.prefectureName === worst.prefectureName
    && item.fiveDayProbability === worst.fiveDayProbability);
  if (matchingWorst.length !== 1
    || topPrefectures[0]?.fiveDayProbability !== value.maxFiveDayProbability
    || worst.fiveDayProbability !== value.maxFiveDayProbability) return null;
  return {
    key: value.key,
    sourceEventId: value.sourceEventId,
    identity: identity as PersistedTyphoonProbabilityStateV1["identity"],
    baseTimeMs: value.baseTimeMs,
    maxFiveDayProbability: value.maxFiveDayProbability,
    activePrefectureCount,
    topPrefectures,
    worstArea: {
      areaCode: worst.areaCode,
      areaName: worst.areaName,
      prefectureCode: worst.prefectureCode,
      prefectureName: worst.prefectureName,
      fiveDayProbability: worst.fiveDayProbability,
      peakAtMs: worst.peakAtMs as number | null,
    },
    revision: { ...value.revision },
    appliedSemanticKey: value.appliedSemanticKey,
    expiresAtMs: value.expiresAtMs,
  };
}

function sanitizeTyphoonProbabilityStates(value: unknown): PersistedTyphoonProbabilityStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    recordRepair("root.typhoonProbabilities", "subject", 1, 0, "invalid-container", true);
    return [];
  }
  if (value.length > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) {
    recordRepair("root.typhoonProbabilities", "subject", value.length, 0, "limit-exceeded", true);
    return [];
  }
  const rawSubjectCounts = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string"
      || validateTyphoonProbabilityEventId(item.key) !== item.key) continue;
    rawSubjectCounts.set(item.key, (rawSubjectCounts.get(item.key) ?? 0) + 1);
  }
  const states: PersistedTyphoonProbabilityStateV1[] = [];
  let invalid = 0;
  for (const item of value) {
    const parsed = sanitizeTyphoonProbabilityState(item);
    if (parsed == null) { invalid += 1; continue; }
    if (rawSubjectCounts.get(parsed.key) === 1) states.push(parsed);
  }
  states.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const duplicateCount = [...rawSubjectCounts.values()].filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  if (invalid > 0) recordRepair("root.typhoonProbabilities", "subject", invalid, states.length, "invalid-entry");
  if (duplicateCount > 0) recordRepair("root.typhoonProbabilities", "subject", duplicateCount, states.length, "duplicate-subject");
  if (states.length > TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES) {
    recordRepair("root.typhoonProbabilities", "subject", states.length, 0, "limit-exceeded", true);
    return [];
  }
  return states;
}

function normalizeTyphoonProbabilityStatesForWrite(
  states: readonly PersistedTyphoonProbabilityStateV1[] | undefined,
): PersistedTyphoonProbabilityStateV1[] {
  if (states == null) return [];
  const normalized = states.map(sanitizeTyphoonProbabilityState);
  if (normalized.some((state) => state == null)) throw new Error("invalid persisted typhoon probability state");
  const result = normalized as PersistedTyphoonProbabilityStateV1[];
  if (result.length > TYPHOON_PROBABILITY_MAX_SUBJECTS
    || new Set(result.map((state) => state.key)).size !== result.length) {
    throw new Error("invalid persisted typhoon probability collection");
  }
  return result.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function sanitizeVptaGateMetadata(
  value: unknown,
): PersistedTyphoonProbabilityGateMetadataV1[] {
  if (!Array.isArray(value)) {
    recordRepair("root.typhoonProbabilityGateMetadata", "subject", 1, 0, "invalid-container", true);
    return [];
  }
  if (value.length > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) {
    recordRepair(
      "root.typhoonProbabilityGateMetadata", "subject", value.length, 0,
      "limit-exceeded", true,
    );
    return [];
  }
  const rawSubjectCounts = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.stateSubjectKey !== "string"
      || vptaEventIdFromSubject(item.stateSubjectKey) == null) continue;
    rawSubjectCounts.set(
      item.stateSubjectKey,
      (rawSubjectCounts.get(item.stateSubjectKey) ?? 0) + 1,
    );
  }
  const result: PersistedTyphoonProbabilityGateMetadataV1[] = [];
  let invalid = 0;
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.stateSubjectKey !== "string"
      || !item.stateSubjectKey.startsWith("typhoonProbability:")
      || validateTyphoonProbabilityEventId(item.stateSubjectKey.slice("typhoonProbability:".length))
        !== item.stateSubjectKey.slice("typhoonProbability:".length)
      || !isRecord(item.comparison)
      || item.comparison.stateSubjectKey !== item.stateSubjectKey
      || !isRecord(item.comparison.revision)
      || !isRecord(item.comparison.revision.serial)
      || !Object.hasOwn(item.comparison.revision.serial, "raw")
      || !(item.comparison.revision.serial.raw === null
        || typeof item.comparison.revision.serial.raw === "string")
      || !isRecord(item.comparison.revision.reportDateTime)
      || !Array.isArray(item.semanticKeys)
      || item.semanticKeys.length > TELEGRAM_REVISION_MAX_SEMANTIC_KEYS
      || !item.semanticKeys.every((key) => exactBoundedString(key, TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH))
      || typeof item.cancelled !== "boolean") {
      invalid += 1; continue;
    }
    const semanticKeys = normalizeVptaPersistedSemanticKeys(item.semanticKeys);
    if (semanticKeys.length !== item.semanticKeys.length && activeRepairCollector != null) {
      activeRepairCollector.canonicalRewriteRequired = true;
    }
    const metadata: PersistedTyphoonProbabilityGateMetadataV1 = {
      stateSubjectKey: item.stateSubjectKey,
      comparison: structuredClone(item.comparison) as unknown as TelegramRevisionComparisonInput,
      semanticKeys,
      cancelled: item.cancelled,
    };
    if (rawSubjectCounts.get(metadata.stateSubjectKey) === 1) result.push(metadata);
  }
  result.sort((left, right) => left.stateSubjectKey < right.stateSubjectKey ? -1 : left.stateSubjectKey > right.stateSubjectKey ? 1 : 0);
  const duplicates = [...rawSubjectCounts.values()].filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  if (invalid > 0) recordRepair("root.typhoonProbabilityGateMetadata", "subject", invalid, result.length, "invalid-entry");
  if (duplicates > 0) recordRepair("root.typhoonProbabilityGateMetadata", "subject", duplicates, result.length, "duplicate-subject");
  return result;
}

function isVolcanoState(value: unknown): value is PersistedVolcanoStateV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && hasNullableFiniteNumber(value, "alertLevel")
    && (!Object.hasOwn(value, "alertClass")
      || value.alertClass == null
      || isVolcanoAlertClass(value.alertClass))
    && (!Object.hasOwn(value, "warningKind") || hasNullableString(value, "warningKind"))
    && (!Object.hasOwn(value, "targetKinds") || isStringArray(value.targetKinds))
    && hasNullableFiniteNumber(value, "alertExpiresAtMs")
    && (!Object.hasOwn(value, "latestEvent")
      || value.latestEvent == null
      || typeof value.latestEvent === "string"
      || isVolcanoEvent(value.latestEvent))
    && (!Object.hasOwn(value, "latestEventId") || hasNullableString(value, "latestEventId"))
    && hasNullableFiniteNumber(value, "eventExpiresAtMs")
    && isStringArray(value.sourceEventIds)
    && Object.hasOwn(value, "alertRevision") && (value.alertRevision == null || isRevision(value.alertRevision))
    && Object.hasOwn(value, "eventRevision") && (value.eventRevision == null || isRevision(value.eventRevision));
}

function isVolcanoAlertClass(value: unknown): value is DisplayVolcanoAlertClassV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && (value.severity === "warning" || value.severity === "info")
    && typeof value.isActive === "boolean";
}

function isVolcanoEvent(value: unknown): value is DisplayVolcanoEventV1 {
  return isRecord(value)
    && typeof value.label === "string"
    && hasNullableString(value, "craterName")
    && hasNullableString(value, "eventDateTime")
    && hasNullableFiniteNumber(value, "plumeHeightM")
    && typeof value.plumeHeightUnknown === "boolean"
    && hasNullableString(value, "plumeDirection");
}

function migrateVolcanoEventForRead(
  event: DisplayVolcanoEventV1 | string | null | undefined,
): DisplayVolcanoEventV1 | string | null | undefined {
  if (event == null || typeof event === "string") return event;
  const migrated = legacyDisplayPlumeHeightSemantics(
    event.plumeHeightM,
    event.plumeHeightUnknown,
  );
  const rawEvent = event as unknown as Record<string, unknown>;
  const craterSemantic = isDisplayPlumeHeightSemantic(
    rawEvent.plumeHeightAboveCraterSemantic,
    "aboveCrater",
    "m",
  )
    ? rawEvent.plumeHeightAboveCraterSemantic
    : migrated.plumeHeightAboveCraterSemantic;
  const seaLevelSemantic = isDisplayPlumeHeightSemantic(
    rawEvent.plumeHeightAboveSeaLevelSemantic,
    "aboveSeaLevel",
    "FT",
  )
    ? rawEvent.plumeHeightAboveSeaLevelSemantic
    : migrated.plumeHeightAboveSeaLevelSemantic;
  return {
    ...event,
    plumeHeightAboveCraterSemantic: copyDisplayPlumeHeightSemantic(
      craterSemantic,
    ),
    plumeHeightAboveSeaLevelSemantic: copyDisplayPlumeHeightSemantic(
      seaLevelSemantic,
    ),
  };
}

function migrateVolcanoStateForRead(
  state: PersistedVolcanoStateV1,
): PersistedVolcanoStateV1 {
  return {
    ...structuredClone(state),
    latestEvent: migrateVolcanoEventForRead(state.latestEvent),
  };
}

function sanitizeVolcanoStates(value: unknown): PersistedVolcanoStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    recordRepair("root.volcanoes", "code", 1, 0, "invalid-container", true);
    return [];
  }
  const states = value.filter(isVolcanoState).map(migrateVolcanoStateForRead);
  if (states.length !== value.length) {
    recordRepair("root.volcanoes", "code", value.length - states.length, states.length, "invalid-entry");
  }
  return states;
}

function isTornadoState(value: unknown): value is PersistedTornadoStateV1 {
  return isRecord(value)
    && typeof value.publishingOffice === "string"
    && typeof value.sourceEventId === "string"
    && isStringArray(value.areas)
    && typeof value.isSighted === "boolean"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isLongPeriodState(value: unknown): value is PersistedLongPeriodStateV1 {
  const hasSafetyRank = isRecord(value) && Object.hasOwn(value, "safetyRank");
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxLgInt === "string"
    && (!hasSafetyRank
      || value.safetyRank == null
      || typeof value.safetyRank === "number" && Number.isInteger(value.safetyRank)
        && value.safetyRank >= 0 && value.safetyRank <= 4)
    && (!hasSafetyRank || isLongPeriodSafetyRankConsistent(value.maxLgInt, value.safetyRank))
    && isRevision(value.revision)
    && typeof value.hosted === "boolean"
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function inferredLongPeriodSafetyRank(label: string): number | null | undefined {
  const normalized = label.normalize("NFKC").trim();
  const exact = /^([0-4])$/.exec(normalized);
  if (exact != null) return Number(exact[1]);
  const range = /^([0-4])\u301c([0-4])$/.exec(normalized);
  if (range != null) return Number(range[2]);
  const lower = /^([0-4])(?:程度)?以上$/.exec(normalized);
  if (lower != null) return Number(lower[1]);
  if (normalized === "不明" || normalized === "（空欄）" || normalized === "—") return null;
  return undefined;
}

function isLongPeriodSafetyRankConsistent(label: string, rank: unknown): boolean {
  const inferred = inferredLongPeriodSafetyRank(label);
  return inferred === undefined || Object.is(inferred, rank);
}

export function persistedLongPeriodSafetyRank(
  state: PersistedLongPeriodStateV1,
): number | null {
  if (Object.hasOwn(state, "safetyRank")) return state.safetyRank ?? null;
  return inferredLongPeriodSafetyRank(state.maxLgInt) ?? null;
}

function isQuakeHostState(value: unknown): value is PersistedQuakeHostStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxIntRank === "number" && Number.isFinite(value.maxIntRank)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isNankaiState(value: unknown): value is PersistedNankaiStateV1 {
  return isRecord(value)
    && typeof value.sourceEventId === "string"
    && typeof value.statusCode === "string"
    && typeof value.label === "string"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isWeatherAlertItem(value: unknown): value is DisplayWeatherAlertItemV1 {
  return isRecord(value)
    && typeof value.kind === "string"
    && (!Object.hasOwn(value, "phenomenonKey") || typeof value.phenomenonKey === "string")
    && typeof value.displaySeverity === "string"
    && (value.rank === "emergency" || value.rank === "warning" || value.rank === "advisory")
    && isStringArray(value.shownAreas)
    && (
      !Object.hasOwn(value, "shownAreaCodes")
      || (isStringArray(value.shownAreaCodes) && value.shownAreaCodes.length === value.shownAreas.length)
    )
    && typeof value.omittedAreaCount === "number"
    && Number.isSafeInteger(value.omittedAreaCount)
    && value.omittedAreaCount >= 0;
}

function isWeatherAlert(value: unknown): value is DisplayWeatherAlertV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && typeof value.label === "string"
    && (value.role === "weatherEmergency" || value.role === "weatherWarning" || value.role === "weatherAdvisory")
    && typeof value.totalAreas === "number"
    && Number.isSafeInteger(value.totalAreas)
    && value.totalAreas >= 0
    && Array.isArray(value.items)
    && value.items.every(isWeatherAlertItem)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt));
}

function isWeatherAlertState(value: unknown): value is PersistedWeatherAlertStateV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && Array.isArray(value.alerts)
    && value.alerts.length > 0
    && value.alerts.every((alert) => isWeatherAlert(alert) && alert.source === value.source)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeWeatherAlertStates(value: unknown): PersistedWeatherAlertStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    recordRepair("root.weatherAlerts", "source", 1, 0, "invalid-container", true);
    return [];
  }
  const states = value.filter(isWeatherAlertState);
  if (states.length !== value.length) {
    recordRepair("root.weatherAlerts", "source", value.length - states.length, states.length, "invalid-entry");
  }
  return states;
}

function validDomainArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
  domain: SalvageDomain,
): T[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    recordRepair(domain, "entry", 1, 0, "invalid-container", true);
    return [];
  }
  const entries = value.filter(predicate);
  if (entries.length !== value.length) {
    recordRepair(domain, "entry", value.length - entries.length, entries.length, "invalid-entry");
  }
  return entries;
}

function sanitizePersistedStandbyStateV1(value: unknown): PersistedStandbyStateV1 | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "string") return null;
  const metadataMode = optionalArrayMode(value, "typhoonProbabilityGateMetadata");
  if (metadataMode === "present-invalid") {
    warnVptaPersistenceDiagnostic("vpta50V1GateMetadataPresentInvalid");
  } else if (metadataMode === "absent" && rawHasVptaEvidence(value)) {
    warnVptaPersistenceDiagnostic("vpta50V1GateMetadataMissing");
  }
  if (Array.isArray(value.typhoonProbabilities)
    && value.typhoonProbabilities.length <= TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS
    && value.typhoonProbabilities.some((item) => isRecord(item)
      && typeof item.key === "string"
      && validateTyphoonProbabilityEventId(item.key) === item.key
      && !Object.hasOwn(item, "appliedSemanticKey"))) {
    warnVptaPersistenceDiagnostic("vpta50V1MissingAppliedSemanticKey");
  }
  const floods = value.floods == null ? undefined : sanitizeFloodState(value.floods);
  // floods の container 不正は sanitizeFloodState で source 別 repair report に集約する。
  const nankaiTrough = value.nankaiTrough == null || isNankaiState(value.nankaiTrough) ? value.nankaiTrough : null;
  if (value.nankaiTrough != null && nankaiTrough == null) {
    recordRepair("root.nankaiTrough", "singleton", 1, 0, "invalid-entry", true);
  }
  const quakeHost = value.quakeHost == null || isQuakeHostState(value.quakeHost) ? value.quakeHost : null;
  if (value.quakeHost != null && quakeHost == null) {
    recordRepair("root.quakeHost", "singleton", 1, 0, "invalid-entry", true);
  }
  const briefingCritical = sanitizeBriefingCritical(value.briefingCritical);
  return {
    version: 1,
    savedAt: value.savedAt,
    heat: validDomainArray(value.heat, isHeatState, "root.heat"),
    typhoons: sanitizeTyphoonStates(value.typhoons),
    ...(Object.hasOwn(value, "typhoonProbabilities") ? {
      typhoonProbabilities: sanitizeTyphoonProbabilityStates(value.typhoonProbabilities),
    } : {}),
    ...(Object.hasOwn(value, "typhoonProbabilityGateMetadata") ? {
      typhoonProbabilityGateMetadata: sanitizeVptaGateMetadata(value.typhoonProbabilityGateMetadata),
    } : {}),
    volcanoes: sanitizeVolcanoStates(value.volcanoes),
    floods,
    weatherAlerts: sanitizeWeatherAlertStates(value.weatherAlerts),
    tornado: validDomainArray(value.tornado, isTornadoState, "root.tornado"),
    longPeriod: validDomainArray(value.longPeriod, isLongPeriodState, "root.longPeriod"),
    quakeHost,
    nankaiTrough,
    seen: validDomainArray(value.seen, isSeenEntry, "root.seen"),
    ...(briefingCritical == null ? {} : { briefingCritical }),
  };
}

const BRIEFING_NESTED_MAX = 2_048;
const BRIEFING_ENTRY_MAX = 128;
const BRIEFING_PROTECTION_MAX = 512;
const BRIEFING_KINDS = new Set(["linearRainObserved", "linearRainPredicted", "recordRain", "shortSnow"]);
const BRIEFING_FRAMES = new Set(["critical", "warning", "info", "cancel"]);

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value as number).getTime());
}

function canonicalStrictRevision(value: unknown): StandbyRevision | null {
  if (!isRecord(value) || !validEpochMs(value.reportTimeMs) || !nonBlankString(value.serial)
    || !/^\d+$/.test(value.serial)) return null;
  const serial = Number(value.serial);
  if (!Number.isSafeInteger(serial) || serial < 0) return null;
  return { reportTimeMs: value.reportTimeMs, serial: String(serial) };
}

function nullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function requiredNullableString(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && (value[key] === null || typeof value[key] === "string");
}

function allFiniteNumbers(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value == null || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => allFiniteNumbers(item, seen))
    : Object.values(value).every((item) => allFiniteNumbers(item, seen));
  seen.delete(value);
  return valid;
}

function validBriefingFact(value: unknown): boolean {
  if (!isRecord(value) || !nonBlankString(value.kind)) return false;
  if (value.kind === "event") return (value.label === "発生" || value.label === "予想")
    && requiredNullableString(value, "areaName") && requiredNullableString(value, "areaCode")
    && requiredNullableString(value, "at");
  if (value.kind !== "precipitation" && value.kind !== "snowfall") return false;
  return requiredNullableString(value, "locationName") && requiredNullableString(value, "locationCode")
    && typeof value.description === "string"
    && Object.hasOwn(value, "value")
    && (value.value === null || typeof value.value === "number" && Number.isFinite(value.value))
    && requiredNullableString(value, "unit") && requiredNullableString(value, "at")
    && (value.kind !== "precipitation"
      || ((!Object.hasOwn(value, "duration") || nullableString(value.duration))
        && (!Object.hasOwn(value, "approximation")
          || ["approx", "atLeast", "exact", "unknown"].includes(String(value.approximation)))));
}

function validBriefingEntry(value: unknown): value is DisplayBriefingEntryV1 {
  if (!isRecord(value) || !allFiniteNumbers(value)
    || !nonBlankString(value.key) || (value.source !== "vpbs50" && value.source !== "vpoa50")
    || !nonBlankString(value.sourceEventId)
    || (Object.hasOwn(value, "editorialOffice") && typeof value.editorialOffice !== "string")
    || (Object.hasOwn(value, "phenomenonKind") && value.phenomenonKind != null && !BRIEFING_KINDS.has(String(value.phenomenonKind)))
    || (Object.hasOwn(value, "semanticKey") && !nullableString(value.semanticKey))
    || (Object.hasOwn(value, "serial") && !nullableString(value.serial))
    || typeof value.title !== "string" || !requiredNullableString(value, "headline")
    || !Array.isArray(value.conditions) || value.conditions.length > BRIEFING_NESTED_MAX
    || !value.conditions.every((item) => typeof item === "string")
    || !Array.isArray(value.targetAreas) || value.targetAreas.length > BRIEFING_NESTED_MAX
    || !value.targetAreas.every((item) => isRecord(item) && typeof item.name === "string" && typeof item.code === "string")
    || typeof value.reportDateTime !== "string" || typeof value.publishingOffice !== "string"
    || typeof value.infoType !== "string" || !BRIEFING_FRAMES.has(String(value.frameLevel))
    || !Array.isArray(value.severityEvidence) || value.severityEvidence.length > BRIEFING_NESTED_MAX
    || !value.severityEvidence.every((item) => isRecord(item) && typeof item.source === "string"
      && ["condition", "tag", "displaySeverity", "soundLevel", "severity", "phenomenonCode", "kindCode", "levelCode", "status"]
        .every((key) => requiredNullableString(item, key)))
    || !requiredNullableString(value, "qualifier") || typeof value.updatedAt !== "string" || typeof value.expiresAt !== "string"
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) return false;
  if (Object.hasOwn(value, "summary")) {
    if (!isRecord(value.summary)
      || !["structured", "mixed", "rawHeadlineFallback", "cancellation"].includes(String(value.summary.mode))
      || typeof value.summary.hasUnknownKind !== "boolean" || !Array.isArray(value.summary.items)
      || value.summary.items.length > 4
      || !value.summary.items.every((item) => isRecord(item) && BRIEFING_KINDS.has(String(item.kind))
        && typeof item.lead === "string" && Number.isSafeInteger(item.sourceOrdinal) && (item.sourceOrdinal as number) >= 0
        && Array.isArray(item.facts) && item.facts.length <= BRIEFING_NESTED_MAX && item.facts.every(validBriefingFact))) return false;
  }
  return true;
}

function rawBriefingToken(source: string, sourceEventId: string): string {
  return JSON.stringify(["raw", source, sourceEventId]);
}

function identifiableBriefingAliasToken(value: unknown): string | null {
  return isRecord(value) && (value.source === "vpbs50" || value.source === "vpoa50")
    && nonBlankString(value.sourceEventId)
    ? rawBriefingToken(value.source, value.sourceEventId)
    : null;
}

function semanticBriefingToken(semanticKey: string): string {
  return JSON.stringify(["semantic", semanticKey]);
}

function canonicalRawBriefingKey(source: string, sourceEventId: string): string {
  return `card:briefing:${rawBriefingToken(source, sourceEventId)}`;
}

function canonicalBriefingSemanticKey(entry: DisplayBriefingEntryV1): string | null {
  return entry.source === "vpbs50" && nonBlankString(entry.editorialOffice)
    && entry.phenomenonKind != null && BRIEFING_KINDS.has(entry.phenomenonKind)
    && nonBlankString(entry.semanticKey)
    ? `card:vpbs:semantic:${entry.phenomenonKind}:${entry.editorialOffice}`
    : null;
}

function parsedBriefingUnit(value: unknown, frame: "critical" | "cancel", generation: number): PersistedBriefingCriticalEntryV1 | null {
  if (!isRecord(value) || !validBriefingEntry(value.entry)
    || value.entry.frameLevel !== frame || !validEpochMs(value.updatedAtMs) || !validEpochMs(value.expiresAtMs)
    || value.updatedAtMs > value.expiresAtMs || value.entry.updatedAt !== new Date(value.updatedAtMs).toISOString()
    || value.entry.expiresAt !== new Date(value.expiresAtMs).toISOString()
    || value.entry.generation > generation) return null;
  const canonicalSemantic = canonicalBriefingSemanticKey(value.entry);
  if (canonicalSemantic != null) {
    if (value.entry.key !== canonicalSemantic || value.entry.semanticKey !== canonicalSemantic
      || canonicalStrictRevision({ reportTimeMs: Date.parse(value.entry.reportDateTime), serial: value.entry.serial }) == null) return null;
  } else if (frame !== "critical" || value.entry.semanticKey != null || value.entry.phenomenonKind != null
    || value.entry.key !== canonicalRawBriefingKey(value.entry.source, value.entry.sourceEventId)) return null;
  return { entry: structuredClone(value.entry), updatedAtMs: value.updatedAtMs, expiresAtMs: value.expiresAtMs };
}

function validateBriefingCriticalState(value: unknown, failLoud: boolean): PersistedBriefingCriticalStateV1 | null {
  const invalidDomain = (reason: string): null => {
    if (failLoud) throw new BriefingCriticalPersistenceInvariantError(reason);
    recordRepair("root.briefingCritical", "identity", 1, 0, reason === "limit-exceeded" ? "limit-exceeded" : "invalid-container", true);
    return null;
  };
  if (!isRecord(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
    || !Array.isArray(value.entries) || !Array.isArray(value.cancellations) || !Array.isArray(value.watermarks)
    || value.rawAliases != null && !Array.isArray(value.rawAliases)) return invalidDomain("invalid-container");
  if (value.entries.length > BRIEFING_ENTRY_MAX || value.cancellations.length > BRIEFING_ENTRY_MAX
    || value.entries.length + value.cancellations.length > BRIEFING_ENTRY_MAX
    || value.watermarks.length > BRIEFING_PROTECTION_MAX
    || (value.rawAliases?.length ?? 0) > BRIEFING_PROTECTION_MAX) return invalidDomain("limit-exceeded");
  const generation = value.generation as number;
  const entries = value.entries.map((item) => parsedBriefingUnit(item, "critical", generation));
  const cancellations = value.cancellations.map((item) => parsedBriefingUnit(item, "cancel", generation));
  const watermarks = value.watermarks.map((item): PersistedBriefingCriticalWatermarkV1 | null => {
    if (!isRecord(item) || !nonBlankString(item.semanticKey) || !validEpochMs(item.expiresAtMs)) return null;
    const revision = canonicalStrictRevision(item.revision);
    return revision == null ? null : { semanticKey: item.semanticKey, revision, expiresAtMs: item.expiresAtMs };
  });
  const aliases = (value.rawAliases ?? []).map((item): PersistedBriefingCriticalRawAliasV1 | null => {
    if (!isRecord(item) || (item.source !== "vpbs50" && item.source !== "vpoa50")
      || !nonBlankString(item.sourceEventId) || !nonBlankString(item.semanticKey) || !validEpochMs(item.expiresAtMs)) return null;
    const revision = canonicalStrictRevision(item.revision);
    return revision == null ? null : { source: item.source, sourceEventId: item.sourceEventId,
      semanticKey: item.semanticKey, revision, expiresAtMs: item.expiresAtMs };
  });
  const malformed = entries.filter((item) => item == null).length + cancellations.filter((item) => item == null).length
    + watermarks.filter((item) => item == null).length + aliases.filter((item) => item == null).length;
  if (failLoud && malformed > 0) throw new BriefingCriticalPersistenceInvariantError("malformed briefing unit");

  const goodEntries = entries.filter((item): item is PersistedBriefingCriticalEntryV1 => item != null);
  const goodCancellations = cancellations.filter((item): item is PersistedBriefingCriticalEntryV1 => item != null);
  const goodWatermarks = watermarks.filter((item): item is PersistedBriefingCriticalWatermarkV1 => item != null);
  const goodAliases = aliases.filter((item): item is PersistedBriefingCriticalRawAliasV1 => item != null);
  const malformedAliasTokens = new Set<string>();
  for (const [index, valueAlias] of (value.rawAliases ?? []).entries()) {
    if (aliases[index] != null) continue;
    const token = identifiableBriefingAliasToken(valueAlias);
    if (token != null) malformedAliasTokens.add(token);
  }
  const semanticMultiplicity = new Map<string, number>();
  const watermarkMultiplicity = new Map<string, number>();
  const rawMultiplicity = new Map<string, number>();
  const aliasMultiplicity = new Map<string, number>();
  for (const unit of [...goodEntries, ...goodCancellations]) {
    const key = unit.entry.semanticKey == null
      ? rawBriefingToken(unit.entry.source, unit.entry.sourceEventId)
      : semanticBriefingToken(unit.entry.semanticKey);
    const target = unit.entry.semanticKey == null ? rawMultiplicity : semanticMultiplicity;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  for (const unit of goodWatermarks) {
    const key = semanticBriefingToken(unit.semanticKey);
    watermarkMultiplicity.set(key, (watermarkMultiplicity.get(key) ?? 0) + 1);
  }
  for (const unit of goodAliases) {
    const key = rawBriefingToken(unit.source, unit.sourceEventId);
    if (malformedAliasTokens.has(key)) continue;
    aliasMultiplicity.set(key, (aliasMultiplicity.get(key) ?? 0) + 1);
  }
  const invalidSemantic = new Set([...semanticMultiplicity, ...watermarkMultiplicity]
    .filter(([key]) => (semanticMultiplicity.get(key) ?? 0) > 1 || (watermarkMultiplicity.get(key) ?? 0) !== 1)
    .map(([key]) => key));
  const invalidRaw = new Set([...rawMultiplicity, ...aliasMultiplicity]
    .filter(([key]) => (rawMultiplicity.get(key) ?? 0) > 1 || (aliasMultiplicity.get(key) ?? 0) > 1
      || (rawMultiplicity.get(key) ?? 0) > 0 && (aliasMultiplicity.get(key) ?? 0) > 0)
    .map(([key]) => key));
  const coupledEntries = goodEntries.filter((unit) => unit.entry.semanticKey == null
    ? !invalidRaw.has(rawBriefingToken(unit.entry.source, unit.entry.sourceEventId))
    : !invalidSemantic.has(semanticBriefingToken(unit.entry.semanticKey))
      && goodWatermarks.some((wm) => wm.semanticKey === unit.entry.semanticKey
        && compareRevision(wm.revision, strictBriefingRevisionForPersistence(unit.entry)!) === 0));
  const coupledCancellations = goodCancellations.filter((unit) => unit.entry.semanticKey != null
    && !invalidSemantic.has(semanticBriefingToken(unit.entry.semanticKey))
    && goodWatermarks.some((wm) => wm.semanticKey === unit.entry.semanticKey
      && compareRevision(wm.revision, strictBriefingRevisionForPersistence(unit.entry)!) === 0));
  const coupledWatermarks = goodWatermarks.filter((wm) => !invalidSemantic.has(semanticBriefingToken(wm.semanticKey)));
  const invalidAlias = new Set([...invalidRaw, ...malformedAliasTokens]);
  const coupledAliases = goodAliases.filter((alias) => !invalidAlias.has(rawBriefingToken(alias.source, alias.sourceEventId)));
  if (failLoud && (coupledEntries.length !== goodEntries.length || coupledCancellations.length !== goodCancellations.length
    || coupledWatermarks.length !== goodWatermarks.length || coupledAliases.length !== goodAliases.length)) {
    throw new BriefingCriticalPersistenceInvariantError(
      `briefing identity or coupling invariant entries=${coupledEntries.length}/${goodEntries.length}`
      + ` cancellations=${coupledCancellations.length}/${goodCancellations.length}`
      + ` watermarks=${coupledWatermarks.length}/${goodWatermarks.length}`
      + ` aliases=${coupledAliases.length}/${goodAliases.length}`,
    );
  }
  const discarded = malformed + goodEntries.length - coupledEntries.length + goodCancellations.length - coupledCancellations.length
    + goodWatermarks.length - coupledWatermarks.length + goodAliases.length - coupledAliases.length;
  if (!failLoud && discarded > 0) recordRepair("root.briefingCritical", "identity", discarded,
    coupledEntries.length + coupledCancellations.length + coupledWatermarks.length + coupledAliases.length, "coupling-mismatch");
  const rawUnion = new Set([
    ...coupledEntries.filter((unit) => unit.entry.semanticKey == null)
      .map((unit) => rawBriefingToken(unit.entry.source, unit.entry.sourceEventId)),
    ...coupledAliases.map((unit) => rawBriefingToken(unit.source, unit.sourceEventId)),
  ]);
  if (rawUnion.size > BRIEFING_PROTECTION_MAX) return invalidDomain("limit-exceeded");
  const entryOrder = coupledEntries.map(briefingPersistedUnitToken).join("\n");
  const cancellationOrder = coupledCancellations.map(briefingPersistedUnitToken).join("\n");
  const watermarkOrder = coupledWatermarks.map((item) => semanticBriefingToken(item.semanticKey)).join("\n");
  const aliasOrder = coupledAliases.map((item) => rawBriefingToken(item.source, item.sourceEventId)).join("\n");
  coupledEntries.sort((a, b) => briefingPersistedUnitToken(a).localeCompare(briefingPersistedUnitToken(b)));
  coupledCancellations.sort((a, b) => briefingPersistedUnitToken(a).localeCompare(briefingPersistedUnitToken(b)));
  coupledWatermarks.sort((a, b) => semanticBriefingToken(a.semanticKey).localeCompare(semanticBriefingToken(b.semanticKey)));
  coupledAliases.sort((a, b) => rawBriefingToken(a.source, a.sourceEventId).localeCompare(rawBriefingToken(b.source, b.sourceEventId)));
  if (!failLoud && activeRepairCollector != null
    && (entryOrder !== coupledEntries.map(briefingPersistedUnitToken).join("\n")
      || cancellationOrder !== coupledCancellations.map(briefingPersistedUnitToken).join("\n")
      || watermarkOrder !== coupledWatermarks.map((item) => semanticBriefingToken(item.semanticKey)).join("\n")
      || aliasOrder !== coupledAliases.map((item) => rawBriefingToken(item.source, item.sourceEventId)).join("\n")
      || Object.hasOwn(value, "rawAliases") && coupledAliases.length === 0)) {
    activeRepairCollector.canonicalRewriteRequired = true;
  }
  return { generation, entries: coupledEntries, cancellations: coupledCancellations, watermarks: coupledWatermarks,
    ...(coupledAliases.length === 0 ? {} : { rawAliases: coupledAliases }) };
}

export function validateBriefingCriticalForWrite(
  value: PersistedBriefingCriticalStateV1,
): PersistedBriefingCriticalStateV1 {
  const validated = validateBriefingCriticalState(value, true);
  if (validated == null) throw new BriefingCriticalPersistenceInvariantError("briefing slice is invalid");
  return validated;
}

function strictBriefingRevisionForPersistence(entry: DisplayBriefingEntryV1): StandbyRevision | null {
  return canonicalStrictRevision({ reportTimeMs: Date.parse(entry.reportDateTime), serial: entry.serial });
}

function briefingPersistedUnitToken(unit: PersistedBriefingCriticalEntryV1): string {
  return unit.entry.semanticKey == null
    ? rawBriefingToken(unit.entry.source, unit.entry.sourceEventId)
    : semanticBriefingToken(unit.entry.semanticKey);
}

/** The briefing payload is a protocol DTO; malformed units are repaired within this domain. */
function sanitizeBriefingCritical(value: unknown): PersistedBriefingCriticalStateV1 | null {
  if (value == null) return null;
  return validateBriefingCriticalState(value, false);
}

function emptyTsunamiFoundation(): PersistedTelegramFoundationV2["tsunami"] {
  return {
    active: null,
    keyedActive: [],
    legacyActive: null,
    observations: { VTSE51: [], VTSE52: [] },
    gateEntries: [],
  };
}

function emptyVpws50Foundation(): PersistedTelegramFoundationV2["vpws50"] {
  return { authoritative: true, state: null, gateEntries: [] };
}

function emptyVpww56Foundation(): PersistedTelegramFoundationV2["vpww56"] {
  // field 欠落・v1 adapter・domain salvage は官署別 subject を再構成できないため非 authoritative。
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: false,
    state: null,
    gateEntries: [],
  };
}

function emptyTelegramFoundation(): PersistedTelegramFoundationV2 {
  return {
    vpws50: emptyVpws50Foundation(),
    vpww56: emptyVpww56Foundation(),
    tsunami: emptyTsunamiFoundation(),
    volcano: emptyVolcanoFoundation(),
    floodForecast: emptyFloodFoundation(),
    standbyDomains: emptyStandbyDomainsFoundation(),
  };
}

function emptyStandbyDomainsFoundation(): PersistedTelegramFoundationV2["standbyDomains"] {
  return { gateEntries: [] };
}

function standbySubjectMatchesPolicy(
  entry: PersistedTelegramRevisionGateEntryV2,
): boolean {
  if (entry.domain === "tornado" && entry.revisionFamily === "tornado") {
    return entry.stateSubjectKey.startsWith("tornado:");
  }
  if (entry.domain === "heatAlert" && entry.revisionFamily === "VPFT50") {
    return entry.stateSubjectKey.startsWith("heat:");
  }
  if (entry.domain === "typhoonAnalysis" && entry.revisionFamily === "typhoonAnalysis") {
    return entry.stateSubjectKey.startsWith("typhoon:");
  }
  if (entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50") {
    const eventId = entry.stateSubjectKey.startsWith("typhoonProbability:")
      ? entry.stateSubjectKey.slice("typhoonProbability:".length)
      : "";
    return validateTyphoonProbabilityEventId(eventId) === eventId;
  }
  if (entry.domain === "nankaiTrough" && entry.revisionFamily === "nankaiTrough") {
    return entry.stateSubjectKey === "nankai:current";
  }
  if (entry.domain === "lgObservation" && entry.revisionFamily === "VXSE62") {
    return entry.stateSubjectKey.startsWith("longPeriod:");
  }
  return false;
}

function normalizeStandbyDomainsFoundationForWrite(
  value: PersistedTelegramFoundationV2["standbyDomains"],
  vptaProjectionSubjects: ReadonlySet<string> | null = new Set<string>(),
): PersistedTelegramFoundationV2["standbyDomains"] {
  const perFamily = new Map<string, PersistedTelegramRevisionGateEntryV2[]>();
  const vptaSubjects = new Set<string>();
  for (const entry of value.gateEntries) {
    const policy = standbyFoundationPolicy(entry);
    if (entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50"
      && vptaProjectionSubjects !== null
      && (!isGateEntry(entry)
        || entry.tombstoneRetentionMs !== TYPHOON_PROBABILITY_RETENTION_MS
        || policy == null
        || !standbySubjectMatchesPolicy(entry))) {
      throw new Error("invalid persisted VPTA gate entry");
    }
    if (policy == null || !standbySubjectMatchesPolicy(entry)) continue;
    if (entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50") {
      if (vptaSubjects.has(entry.stateSubjectKey)) {
        throw new Error("invalid persisted VPTA gate collection");
      }
      vptaSubjects.add(entry.stateSubjectKey);
    }
    const normalizedSemanticKeys = entry.domain === "typhoonProbability"
      && entry.revisionFamily === "VPTA50"
      ? normalizeVptaPersistedSemanticKeys(entry.semanticKeys)
      : compactPersistedSemanticKeys(entry.semanticKeys);
    if (entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50"
      && vptaProjectionSubjects !== null
      && normalizedSemanticKeys.length !== entry.semanticKeys.length) {
      throw new Error("invalid persisted VPTA semantic key collection");
    }
    const key = `${entry.domain}:${entry.revisionFamily}`;
    const entries = perFamily.get(key) ?? [];
    entries.push({
      ...structuredClone(entry),
      tombstoneRetentionMs: entry.tombstoneRetentionMs ?? policy.tombstoneRetentionMs,
      semanticKeys: normalizedSemanticKeys,
    });
    perFamily.set(key, entries);
  }
  return {
    gateEntries: [...perFamily.values()].flatMap((entries) => {
      const policy = standbyFoundationPolicy(entries[0]);
      if (entries[0]?.domain === "typhoonProbability" && entries[0].revisionFamily === "VPTA50") {
        if (vptaProjectionSubjects === null) {
          return entries.sort((left, right) => left.stateSubjectKey < right.stateSubjectKey
            ? -1 : left.stateSubjectKey > right.stateSubjectKey ? 1 : 0);
        }
        if (entries.length > (policy?.maxSubjects ?? TYPHOON_PROBABILITY_MAX_SUBJECTS)) {
          throw new Error("VPTA persistence subject capacity exceeded");
        }
        const selection = selectVptaCapacityBundles(entries.map((entry) => ({
          stateSubjectKey: entry.stateSubjectKey,
          acceptedAtMs: entry.acceptedAtMs,
          class: entry.cancelled
            ? "GT" as const
            : vptaProjectionSubjects.has(entry.stateSubjectKey) ? "P+G" as const : "GA" as const,
        })), policy?.maxSubjects ?? TYPHOON_PROBABILITY_MAX_SUBJECTS);
        if (selection.kind === "protectedOverflow") {
          throw new Error("VPTA protected persistence capacity exceeded");
        }
        const retained = new Set(selection.retained.map((bundle) => bundle.stateSubjectKey));
        return entries.filter((entry) => retained.has(entry.stateSubjectKey))
          .sort((left, right) => left.stateSubjectKey < right.stateSubjectKey ? -1 : left.stateSubjectKey > right.stateSubjectKey ? 1 : 0);
      }
      return entries.slice(-(policy?.maxSubjects ?? TELEGRAM_REVISION_MAX_ENTRIES));
    }),
  };
}

function sanitizeStandbyDomainsFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["standbyDomains"] | null {
  if (!isRecord(value) || !Array.isArray(value.gateEntries)) return null;
  const rawVptaSubjectCounts = new Map<string, number>();
  for (const candidate of value.gateEntries) {
    if (!isRecord(candidate)
      || candidate.domain !== "typhoonProbability"
      || candidate.revisionFamily !== "VPTA50"
      || typeof candidate.stateSubjectKey !== "string") continue;
    rawVptaSubjectCounts.set(
      candidate.stateSubjectKey,
      (rawVptaSubjectCounts.get(candidate.stateSubjectKey) ?? 0) + 1,
    );
  }
  const rawVptaCount = value.gateEntries.filter((candidate) => isRecord(candidate)
    && candidate.domain === "typhoonProbability"
    && candidate.revisionFamily === "VPTA50").length;
  const rejectVptaDomain = rawVptaCount > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS;
  if (rejectVptaDomain) {
    recordRepair("foundation.standbyDomains", "subject", rawVptaCount, 0, "limit-exceeded", true);
  }
  const gateEntries = value.gateEntries.flatMap((candidate) => {
    if (rejectVptaDomain && isRecord(candidate)
      && candidate.domain === "typhoonProbability"
      && candidate.revisionFamily === "VPTA50") return [];
    const rawVpta = isRecord(candidate)
      && candidate.domain === "typhoonProbability"
      && candidate.revisionFamily === "VPTA50";
    if (rawVpta && typeof candidate.stateSubjectKey === "string"
      && (rawVptaSubjectCounts.get(candidate.stateSubjectKey) ?? 0) > 1) return [];
    if (rawVpta && Object.hasOwn(candidate, "tombstoneRetentionMs")
      && candidate.tombstoneRetentionMs !== TYPHOON_PROBABILITY_RETENTION_MS) {
      warnVptaPersistenceDiagnostic("vpta50GateRetentionInvalid");
      return [];
    }
    if (!isGateEntry(candidate)) return [];
    const entry = candidate as PersistedTelegramRevisionGateEntryV2;
    const policy = standbyFoundationPolicy(entry);
    if (policy == null || !standbySubjectMatchesPolicy(entry)) return [];
    if (entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50"
      && !Object.hasOwn(entry, "tombstoneRetentionMs")) {
      if (activeRepairCollector != null) activeRepairCollector.canonicalRewriteRequired = true;
      warnVptaPersistenceDiagnostic("vpta50GateRetentionDefaulted");
    }
    return [{
      ...structuredClone(entry),
      tombstoneRetentionMs: entry.tombstoneRetentionMs ?? policy.tombstoneRetentionMs,
      semanticKeys: entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50"
        ? normalizeVptaPersistedSemanticKeys(entry.semanticKeys)
        : compactPersistedSemanticKeys(entry.semanticKeys),
    }];
  });
  const duplicateSubjects = new Set(
    [...rawVptaSubjectCounts].filter(([, count]) => count > 1).map(([subject]) => subject),
  );
  const counts = new Map<string, number>();
  for (const entry of gateEntries) counts.set(entry.stateSubjectKey, (counts.get(entry.stateSubjectKey) ?? 0) + 1);
  for (const [subject, count] of counts) if (count > 1) duplicateSubjects.add(subject);
  const retained = gateEntries.filter((entry) => !duplicateSubjects.has(entry.stateSubjectKey));
  const discarded = value.gateEntries.length - retained.length;
  if (discarded > 0) recordRepair(
    "foundation.standbyDomains", "subject", discarded, retained.length,
    duplicateSubjects.size > 0 ? "duplicate-subject" : "invalid-entry",
  );
  const normalized = normalizeStandbyDomainsFoundationForWrite({ gateEntries: retained }, null);
  if (normalized.gateEntries.length !== retained.length) {
    recordRepair(
      "foundation.standbyDomains", "subject", 1, normalized.gateEntries.length, "limit-exceeded",
    );
  }
  return normalized;
}

function emptyVolcanoFoundation(): PersistedTelegramFoundationV2["volcano"] {
  return { authoritative: false, state: null, active: [], gateEntries: [] };
}

function emptyFloodFoundation(): PersistedTelegramFoundationV2["floodForecast"] {
  return { authoritative: false, active: [], gateEntries: [] };
}

function isWeatherIdentity(value: unknown, receivedAtMs = Number.MAX_SAFE_INTEGER): boolean {
  if (!isRecord(value) || typeof value.reportDateTime !== "string") return false;
  if (!parseStrictReportDateTime(value.reportDateTime, receivedAtMs).valid) return false;
  if (value.serial == null || value.serial === "") return true;
  return typeof value.serial === "string" && parseTelegramSerial(value.serial).valid;
}

function isVpws50Kind(value: unknown): boolean {
  return isRecord(value)
    && typeof value.phenomenonKey === "string"
    && typeof value.kindCode === "string"
    && typeof value.kindName === "string"
    && (value.severity === "specialWarning" || value.severity === "warning" || value.severity === "advisory" || value.severity === "release" || value.severity === "unknown")
    && (value.displaySeverity === "release" || value.displaySeverity === "officialL1"
      || value.displaySeverity === "officialL2"
      || value.displaySeverity === "officialL3" || value.displaySeverity === "officialL4"
      || value.displaySeverity === "officialL5" || value.displaySeverity === "nonLevelWarning"
      || value.displaySeverity === "nonLevelAdvisory"
      || value.displaySeverity === "nonLevelSpecial" || value.displaySeverity === "unknown")
    && (value.officialAlertLevel == null || value.officialAlertLevel === 1 || value.officialAlertLevel === 2
      || value.officialAlertLevel === 3 || value.officialAlertLevel === 4 || value.officialAlertLevel === 5)
    && (value.resolutionSource === "map" || value.resolutionSource === "nameFallback" || value.resolutionSource === "unknown");
}

function isVpws50Snapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const areasValid = value.generation === VPWS50_SNAPSHOT_GENERATION
    && Array.isArray(value.areas) && value.areas.every((area) =>
    isRecord(area)
    && typeof area.areaCode === "string"
    && typeof area.areaName === "string"
    && Array.isArray(area.kinds)
    && area.kinds.every(isVpws50Kind),
  );
  const clearsValid = value.clearedPhenomena == null
    || Array.isArray(value.clearedPhenomena)
    && value.clearedPhenomena.every((entry) => isRecord(entry)
      && typeof entry.areaCode === "string"
      && Array.isArray(entry.phenomenonKeys)
      && entry.phenomenonKeys.every((key) => typeof key === "string"));
  return areasValid && clearsValid;
}

function isVpws50State(value: unknown): value is PersistedVpws50StateV2 {
  if (!isRecord(value) || !Array.isArray(value.history)) return false;
  const isEntry = (entry: unknown, identityRequired: boolean): boolean =>
    isRecord(entry)
    && typeof entry.messageId === "string"
    && (identityRequired ? isWeatherIdentity(entry.identity) : entry.identity == null || isWeatherIdentity(entry.identity))
    && isVpws50Snapshot(entry.snapshot);
  const partialStreamsValid = value.partialStreams == null || Array.isArray(value.partialStreams)
    && value.partialStreams.length <= 128
    && value.partialStreams.every((entry) => isRecord(entry)
      && typeof entry.subjectKey === "string"
      && weatherOfficeFromStreamKey(entry.subjectKey) != null
      && isEntry(entry, true));
  const partialHistoryValid = value.partialHistory == null || Array.isArray(value.partialHistory)
    && value.partialHistory.length <= 128
    && value.partialHistory.every((group) => isRecord(group)
      && typeof group.subjectKey === "string"
      && weatherOfficeFromStreamKey(group.subjectKey) != null
      && Array.isArray(group.entries)
      && group.entries.length <= 8
      && group.entries.every((entry) => isEntry(entry, true)));
  const restoredSubjectsValid = value.restoredPartialSubjects == null
    || Array.isArray(value.restoredPartialSubjects)
    && value.restoredPartialSubjects.length <= 128
    && value.restoredPartialSubjects.every((subject) => typeof subject === "string"
      && weatherOfficeFromStreamKey(subject) != null);
  const tombstonesValid = value.emergencyClearTombstones == null
    || Array.isArray(value.emergencyClearTombstones)
    && value.emergencyClearTombstones.length <= 128
    && value.emergencyClearTombstones.every((entry) => isRecord(entry)
      && typeof entry.officeKey === "string"
      && normalizeWeatherOfficeWatermarkKey(entry.officeKey) != null
      && Array.isArray(entry.areaCodes)
      && entry.areaCodes.length > 0
      && entry.areaCodes.every((areaCode) => typeof areaCode === "string" && areaCode.trim() !== "")
      && isWeatherIdentity(entry.identity));
  const legacyWatermarksValid = value.emergencyClearWatermarks == null
    || Array.isArray(value.emergencyClearWatermarks)
    && value.emergencyClearWatermarks.length <= 128
    && value.emergencyClearWatermarks.every((entry) => isRecord(entry)
      && typeof entry.subjectKey === "string"
      && normalizeWeatherOfficeWatermarkKey(entry.subjectKey) != null
      && isWeatherIdentity(entry.identity));
  return partialStreamsValid
    && partialHistoryValid
    && restoredSubjectsValid
    && tombstonesValid
    && legacyWatermarksValid
    && (value.current == null || isEntry(value.current, true))
    && value.history.every((entry) => isEntry(entry, false))
    && (value.lastSuccessfulFullDisplayAt == null
      || typeof value.lastSuccessfulFullDisplayAt === "string" && Number.isFinite(Date.parse(value.lastSuccessfulFullDisplayAt)));
}

function isEmptyVpws50State(value: PersistedVpws50StateV2): boolean {
  return value.current == null
    && value.history.length === 0
    && (value.partialStreams?.length ?? 0) === 0
    && (value.partialHistory?.length ?? 0) === 0
    && (value.restoredPartialSubjects?.length ?? 0) === 0
    && (value.emergencyClearTombstones?.length ?? 0) === 0
    && value.lastSuccessfulFullDisplayAt == null;
}

function isStrictText(value: unknown): value is StrictTextMeta {
  return isRecord(value)
    && (value.raw == null || typeof value.raw === "string")
    && (value.value == null || typeof value.value === "string")
    && typeof value.valid === "boolean";
}

function isGateEntry(value: unknown): value is PersistedTelegramRevisionGateEntryV2 {
  if (!isRecord(value) || !isRecord(value.comparison) || !isRecord(value.comparison.revision)) return false;
  const revision = value.comparison.revision;
  const acceptedAtMs = value.acceptedAtMs;
  if (typeof acceptedAtMs !== "number" || !Number.isSafeInteger(acceptedAtMs)
    || !validPersistenceEpoch(acceptedAtMs)) return false;
  if (!isRecord(revision.reportDateTime) || typeof revision.reportDateTime.raw !== "string") return false;
  const strictDate = parseStrictReportDateTime(revision.reportDateTime.raw, acceptedAtMs);
  if (!strictDate.valid || strictDate.epochMs == null) return false;
  if (revision.reportDateTime.epochMs !== strictDate.epochMs || revision.reportDateTime.valid !== true) return false;
  if (!isRecord(revision.serial) || !(revision.serial.raw == null || typeof revision.serial.raw === "string")) return false;
  const serialRaw = revision.serial.raw ?? null;
  const parsedSerial = parseTelegramSerial(serialRaw);
  const serialMissing = serialRaw == null || serialRaw === "";
  if (serialMissing) {
    if (revision.serial.numeric != null || revision.serial.valid !== false) return false;
  } else if (
    !parsedSerial.valid
    || revision.serial.valid !== true
    || revision.serial.numeric !== parsedSerial.numeric
  ) return false;
  const eventId = revision.eventId;
  const type = revision.type;
  if (
    !isStrictText(eventId)
    || !isStrictText(type)
    || eventId.valid !== true
    || type.valid !== true
  ) return false;
  if (!isRecord(revision.infoType)) return false;
  const isVpta = value.domain === "typhoonProbability" && value.revisionFamily === "VPTA50";
  const vptaEventId = isVpta && typeof value.stateSubjectKey === "string"
    && value.stateSubjectKey.startsWith("typhoonProbability:")
    ? value.stateSubjectKey.slice("typhoonProbability:".length)
    : null;
  if (isVpta && (
    vptaEventId == null
    || validateTyphoonProbabilityEventId(vptaEventId) !== vptaEventId
    || eventId.raw !== vptaEventId
    || eventId.value !== vptaEventId
    || type.raw !== "VPTA50"
    || type.value !== "VPTA50"
    || (revision.infoType.raw !== "発表"
      && revision.infoType.raw !== "訂正"
      && revision.infoType.raw !== "取消")
    || revision.infoType.raw !== revision.infoType.value
    || acceptedAtMs > persistenceValidationNowMs()
      + TYPHOON_PROBABILITY_ACCEPTED_AT_FUTURE_SKEW_MS
    || revision.reportDateTime.epochMs > acceptedAtMs
      + TYPHOON_PROBABILITY_REPORT_FUTURE_SKEW_MS
    || !serialMissing && serialRaw !== String(revision.serial.numeric)
    || serialMissing && serialRaw !== null
    || !Array.isArray(value.semanticKeys)
    || value.semanticKeys.length < 1 && value.cancelled !== true
    || value.semanticKeys.length > TELEGRAM_REVISION_MAX_SEMANTIC_KEYS
    || value.semanticKeys.some((key) => !exactBoundedString(key, TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH))
    || revision.infoType.value === "取消" && value.cancelled !== true
    || Object.hasOwn(value, "tombstoneRetentionMs")
      && value.tombstoneRetentionMs !== 7 * 24 * 60 * 60_000
  )) return false;
  return typeof value.domain === "string"
    && typeof value.revisionFamily === "string"
    && typeof value.stateSubjectKey === "string"
    && value.comparison.stateSubjectKey === value.stateSubjectKey
    && (revision.infoType.raw == null || typeof revision.infoType.raw === "string")
    && (revision.infoType.value === "発表" || revision.infoType.value === "訂正" || revision.infoType.value === "取消")
    && revision.infoType.valid === true
    && isStringArray(value.semanticKeys)
    && value.semanticKeys.length <= (isVpta
      ? TELEGRAM_REVISION_MAX_SEMANTIC_KEYS
      : TELEGRAM_REVISION_MAX_ENTRIES)
    && value.semanticKeys.every((key) => key.length <= 1_048_576)
    && typeof value.cancelled === "boolean"
    && (value.legacyRevisionKey == null
      || typeof value.legacyRevisionKey === "string" && value.legacyRevisionKey.length <= 1_024)
    && (value.legacyRevisionKeyProvenance == null
      || value.legacyRevisionKey != null
      && (value.legacyRevisionKeyProvenance === "eventId"
        || value.legacyRevisionKeyProvenance === "codeFallback"))
    && (value.tombstoneRetentionMs == null
      || typeof value.tombstoneRetentionMs === "number"
      && Number.isFinite(value.tombstoneRetentionMs)
      && value.tombstoneRetentionMs > 0)
    && (isVpta || eventId.value === value.stateSubjectKey)
    && type.value === value.revisionFamily;
}

function isTsunamiObservation(value: unknown): boolean {
  return isRecord(value)
    && (value.areaName == null || typeof value.areaName === "string")
    && (value.areaCode == null || typeof value.areaCode === "string")
    && typeof value.stationCode === "string"
    && value.stationCode.trim() !== ""
    && typeof value.name === "string"
    && typeof value.sensor === "string"
    && typeof value.arrivalTime === "string"
    && typeof value.initial === "string"
    && typeof value.maxHeightCondition === "string"
    && (value.maxHeightValue == null || typeof value.maxHeightValue === "string")
    && (value.maxHeightValueCondition == null || typeof value.maxHeightValueCondition === "string");
}

function parseTsunamiHeightDiagnostics(value: unknown): SpecialValueDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is SpecialValueDiagnostic =>
    item === "unmappedSpecialValue"
    || item === "specialValueConflict"
    || item === "legacyNullUnknown")) return null;
  return [...value];
}

function parseTsunamiParserDiagnostics(value: unknown): TsunamiParserDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is TsunamiParserDiagnostic =>
    item === "unknownTsunamiAreaCode"
    || item === "unknownTsunamiKindCode")) return null;
  return [...value];
}

function sanitizeTsunamiParserDiagnostics(value: Record<string, unknown>): void {
  if (!Object.hasOwn(value, "diagnostics")) return;
  const diagnostics = parseTsunamiParserDiagnostics(value.diagnostics);
  if (diagnostics == null) delete value.diagnostics;
  else value.diagnostics = diagnostics;
}

function isStrictNullableString(value: unknown): value is string | null {
  return value == null ? value !== undefined : typeof value === "string";
}

function isStrictNullableFiniteNumber(value: unknown): value is number | null {
  return value == null
    ? value !== undefined
    : typeof value === "number" && Number.isFinite(value);
}

function parsePersistedTsunamiHeight(value: unknown): SpecialValue<number> | null {
  if (
    !isRecord(value)
    || !Object.hasOwn(value, "raw")
    || !Object.hasOwn(value, "value")
    || !Object.hasOwn(value, "condition")
    || !Object.hasOwn(value, "description")
    || !Object.hasOwn(value, "presence")
    || !isStrictNullableString(value.raw)
    || !isStrictNullableFiniteNumber(value.value)
    || !isStrictNullableString(value.condition)
    || !isStrictNullableString(value.description)
    || !["value", "missing", "empty", "unknown", "qualitative", "range"].includes(
      typeof value.presence === "string" ? value.presence : "",
    )
  ) return null;
  if (Object.hasOwn(value, "lowerBound") && !isStrictNullableFiniteNumber(value.lowerBound)) return null;
  if (Object.hasOwn(value, "upperBound") && !isStrictNullableFiniteNumber(value.upperBound)) return null;
  if (Object.hasOwn(value, "rawLowerBound") && !isStrictNullableString(value.rawLowerBound)) return null;
  if (Object.hasOwn(value, "rawUpperBound") && !isStrictNullableString(value.rawUpperBound)) return null;
  const hasDiagnostics = Object.hasOwn(value, "diagnostics");
  const diagnostics = hasDiagnostics ? parseTsunamiHeightDiagnostics(value.diagnostics) : undefined;
  if (hasDiagnostics && diagnostics == null) return null;

  const parsed: SpecialValue<number> = {
    raw: value.raw as string | null,
    value: value.value as number | null,
    condition: value.condition as string | null,
    description: value.description as string | null,
    presence: value.presence as SpecialValue<number>["presence"],
    ...(Object.hasOwn(value, "lowerBound")
      ? { lowerBound: value.lowerBound as number | null }
      : {}),
    ...(Object.hasOwn(value, "upperBound")
      ? { upperBound: value.upperBound as number | null }
      : {}),
    ...(Object.hasOwn(value, "rawLowerBound")
      ? { rawLowerBound: value.rawLowerBound as string | null }
      : {}),
    ...(Object.hasOwn(value, "rawUpperBound")
      ? { rawUpperBound: value.rawUpperBound as string | null }
      : {}),
    ...(diagnostics == null ? {} : { diagnostics }),
  };
  const hasLower = Object.hasOwn(parsed, "lowerBound");
  const hasUpper = Object.hasOwn(parsed, "upperBound");
  const hasCanonicalBounds = hasLower || hasUpper;
  const hasRawLower = Object.hasOwn(parsed, "rawLowerBound");
  const hasRawUpper = Object.hasOwn(parsed, "rawUpperBound");
  if (hasRawLower !== hasRawUpper) return null;
  if (parsed.presence === "value" ? parsed.value == null : parsed.value != null) return null;
  if (parsed.presence === "missing") {
    return parsed.raw == null
      && parsed.condition == null
      && parsed.description == null
      && !hasCanonicalBounds
      && !hasRawLower
      ? parsed
      : null;
  }
  if (parsed.presence === "value") {
    return parsed.raw != null && !hasCanonicalBounds ? parsed : null;
  }
  if (parsed.presence === "empty") {
    return parsed.raw != null
      && parsed.raw.trim() === ""
      && !hasCanonicalBounds
      && !hasRawLower
      ? parsed
      : null;
  }
  if (parsed.presence === "range") {
    return parsed.raw != null
      && (hasLower && parsed.lowerBound != null || hasUpper && parsed.upperBound != null)
      ? parsed
      : null;
  }
  if (parsed.presence === "qualitative") return parsed.raw != null ? parsed : null;
  const legacyNull = parsed.diagnostics?.includes("legacyNullUnknown") === true;
  return (parsed.raw != null || legacyNull) && !hasCanonicalBounds ? parsed : null;
}

function sanitizePersistedTsunamiForecast(
  value: unknown,
): LegacyTsunamiForecastItemInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  sanitizeTsunamiParserDiagnostics(sanitized);
  if (Object.hasOwn(sanitized, "areaCode") && !isStrictNullableString(sanitized.areaCode)) {
    delete sanitized.areaCode;
  }
  if (Object.hasOwn(sanitized, "kindCode") && !isStrictNullableString(sanitized.kindCode)) {
    delete sanitized.kindCode;
  }
  if (typeof sanitized.kindName !== "string") delete sanitized.kindName;
  const maxHeight = parsePersistedTsunamiHeight(sanitized.maxHeight);
  if (maxHeight == null) delete sanitized.maxHeight;
  else sanitized.maxHeight = maxHeight;
  return sanitized as unknown as LegacyTsunamiForecastItemInput;
}

function sanitizePersistedTsunamiObservation(
  value: unknown,
): LegacyTsunamiObservationInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  if (Object.hasOwn(sanitized, "areaCode") && !isStrictNullableString(sanitized.areaCode)) {
    delete sanitized.areaCode;
  }
  const maxHeight = parsePersistedTsunamiHeight(sanitized.maxHeight);
  if (maxHeight == null) delete sanitized.maxHeight;
  else sanitized.maxHeight = maxHeight;
  return sanitized as unknown as LegacyTsunamiObservationInput;
}

function sanitizePersistedTsunamiActive(value: unknown): LegacyParsedTsunamiInfoInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  sanitizeTsunamiParserDiagnostics(sanitized);
  sanitized.forecast = (sanitized.forecast as unknown[]).map(sanitizePersistedTsunamiForecast);
  if (Array.isArray(sanitized.observations)) {
    sanitized.observations = sanitized.observations.map(sanitizePersistedTsunamiObservation);
  }
  if (isRecord(sanitized.earthquake)) {
    const earthquake = sanitized.earthquake;
    const magnitudeScalar = typeof earthquake.magnitude === "string" ? earthquake.magnitude : "";
    const depthScalar = typeof earthquake.depth === "string" ? earthquake.depth : "";
    earthquake.magnitudeValue = Object.hasOwn(earthquake, "magnitudeValue")
      ? parsePersistedNumericSpecialValue(earthquake.magnitudeValue)!
      : magnitudeValueFromLegacyScalar(earthquake.magnitude as string | null);
    earthquake.depthValue = Object.hasOwn(earthquake, "depthValue")
      ? parsePersistedDepthSpecialValue(earthquake.depthValue)!
      : depthValueFromLegacyScalar(earthquake.depth as string | null);
    earthquake.magnitude = magnitudeScalar;
    earthquake.depth = depthScalar;
  }
  return sanitized as unknown as LegacyParsedTsunamiInfoInput;
}

function isPersistedTelegramMeta(value: unknown): value is TelegramMeta {
  if (
    !isRecord(value)
    || typeof value.messageId !== "string"
    || !(value.status == null || typeof value.status === "string")
    || typeof value.isTest !== "boolean"
    || typeof value.receivedAtMs !== "number"
    || !Number.isFinite(value.receivedAtMs)
    || !isRecord(value.eventId)
    || !isRecord(value.type)
    || !isRecord(value.reportDateTime)
    || !isRecord(value.serial)
    || !isRecord(value.infoType)
  ) return false;
  const rebuilt = createTelegramMeta({
    messageId: value.messageId,
    eventId: typeof value.eventId.raw === "string" ? value.eventId.raw : null,
    type: typeof value.type.raw === "string" ? value.type.raw : null,
    reportDateTime: typeof value.reportDateTime.raw === "string"
      ? value.reportDateTime.raw
      : null,
    serial: typeof value.serial.raw === "string" ? value.serial.raw : null,
    infoType: typeof value.infoType.raw === "string" ? value.infoType.raw : null,
    receivedAtMs: value.receivedAtMs,
    status: value.status ?? null,
    isTest: value.isTest,
  });
  return JSON.stringify(rebuilt.eventId) === JSON.stringify(value.eventId)
    && JSON.stringify(rebuilt.type) === JSON.stringify(value.type)
    && JSON.stringify(rebuilt.reportDateTime) === JSON.stringify(value.reportDateTime)
    && JSON.stringify(rebuilt.serial) === JSON.stringify(value.serial)
    && JSON.stringify(rebuilt.infoType) === JSON.stringify(value.infoType);
}

function isPersistedTsunamiEarthquake(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.originTime !== "string"
    || typeof value.hypocenterName !== "string"
    || typeof value.latitude !== "string"
    || typeof value.longitude !== "string"
    || !Object.hasOwn(value, "depth")
    || value.depth !== null && typeof value.depth !== "string"
    || !Object.hasOwn(value, "magnitude")
    || value.magnitude !== null && typeof value.magnitude !== "string"
  ) return false;
  if (
    (Object.hasOwn(value, "magnitudeValue")
      && parsePersistedNumericSpecialValue(value.magnitudeValue) == null)
    || (Object.hasOwn(value, "depthValue")
      && parsePersistedNumericSpecialValue(value.depthValue) == null)
  ) return false;
  return value.magnitudeInfo == null || (
    isRecord(value.magnitudeInfo)
    && typeof value.magnitudeInfo.value === "string"
    && (value.magnitudeInfo.condition == null || typeof value.magnitudeInfo.condition === "string")
    && (value.magnitudeInfo.description == null || typeof value.magnitudeInfo.description === "string")
  );
}

function isPersistedTsunamiActive(value: unknown): boolean {
  if (
    !isRecord(value)
    || value.type !== "VTSE41"
    || typeof value.infoType !== "string"
    || typeof value.title !== "string"
    || typeof value.reportDateTime !== "string"
    || !(value.headline == null || typeof value.headline === "string")
    || typeof value.publishingOffice !== "string"
    || typeof value.warningComment !== "string"
    || typeof value.isTest !== "boolean"
    || !isPersistedTelegramMeta(value.meta)
  ) return false;
  if (
    value.meta.type.value !== "VTSE41"
    || value.meta.reportDateTime.raw !== value.reportDateTime
    || value.meta.infoType.value !== value.infoType
    || value.meta.isTest !== value.isTest
  ) return false;
  if (!Array.isArray(value.forecast) || !value.forecast.every((item) =>
    isRecord(item)
    && typeof item.areaName === "string"
    && typeof item.kind === "string"
    && typeof item.maxHeightDescription === "string"
    && typeof item.firstHeight === "string"
    && (item.stations == null || Array.isArray(item.stations) && item.stations.every((station) =>
      isRecord(station)
      && typeof station.name === "string"
      && typeof station.highTideDateTime === "string"
      && typeof station.arrivalTime === "string"))
  )) return false;
  if (value.observations != null && (!Array.isArray(value.observations) || !value.observations.every((item) =>
    isRecord(item)
    && (item.areaName == null || typeof item.areaName === "string")
    && (item.areaCode == null || typeof item.areaCode === "string")
    && (item.stationCode == null || typeof item.stationCode === "string")
    && typeof item.name === "string"
    && typeof item.sensor === "string"
    && typeof item.arrivalTime === "string"
    && typeof item.initial === "string"
    && typeof item.maxHeightCondition === "string"
    && (item.maxHeightValue == null || typeof item.maxHeightValue === "string")
    && (item.maxHeightValueCondition == null || typeof item.maxHeightValueCondition === "string")
  ))) return false;
  if (value.estimations != null && (!Array.isArray(value.estimations) || !value.estimations.every((item) =>
    isRecord(item)
    && typeof item.areaName === "string"
    && typeof item.maxHeightDescription === "string"
    && typeof item.firstHeight === "string"
  ))) return false;
  return value.earthquake == null || isPersistedTsunamiEarthquake(value.earthquake);
}

function persistedTsunamiSubjectFromUnknown(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.meta.eventId)) return null;
  const eventId = value.meta.eventId;
  return eventId.valid === true
    && typeof eventId.value === "string"
    && eventId.value.trim() !== ""
    ? `tsunami:${eventId.value}`
    : null;
}

function isPersistedTsunamiCancellationUnknown(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.meta)
    && isRecord(value.meta.infoType)
    && value.meta.infoType.value === "取消";
}

function tsunamiActiveMatchesGate(
  active: ParsedTsunamiInfo,
  gateEntry: PersistedTelegramRevisionGateEntryV2,
): boolean {
  // 取消 payload は表示 state ではない。revision が一致しても active projection
  // として復元せず、gate / tombstone だけを残す。
  if (active.meta.infoType.value === "取消") return false;
  const revision = gateEntry.comparison.revision;
  const exactSubject = gateEntry.stateSubjectKey === tsunamiStateSubjectKey(active.meta);
  const subjectMatches = exactSubject
    // v2 の固定 subject は migration 前 snapshot を読めるように残す。
    || gateEntry.stateSubjectKey === "tsunami:current";
  const sameRevision = revision.reportDateTime.raw === active.meta.reportDateTime.raw
    && revision.serial.raw === active.meta.serial.raw
    && revision.infoType.value === active.meta.infoType.value;
  const gateReportMs = revision.reportDateTime.epochMs;
  const activeReportMs = active.meta.reportDateTime.epochMs;
  const gateSerialMissing = revision.serial.raw == null || revision.serial.raw === "";
  const activeSerialMissing = active.meta.serial.raw == null || active.meta.serial.raw === "";
  const watermarkDoesNotPrecedeActive = gateReportMs != null
    && activeReportMs != null
    && (
      gateReportMs > activeReportMs
      || gateReportMs === activeReportMs
      && (
        gateSerialMissing && activeSerialMissing
        || !gateSerialMissing
        && !activeSerialMissing
        && revision.serial.valid
        && active.meta.serial.valid
        && revision.serial.numeric != null
        && active.meta.serial.numeric != null
        && revision.serial.numeric >= active.meta.serial.numeric
      )
    );
  // 部分取消・照合不能取消・unkeyed 通常続報は、holder を変えずに
  // revision だけを non-cancel watermark として進める。正式 comparator と同じく
  // 同一日時は Serial 順を要求し、片側だけ欠落する unordered な組は拒否する。
  const retainedActivePrecedesWatermark = exactSubject
    && !gateEntry.cancelled
    && watermarkDoesNotPrecedeActive;
  return gateEntry.domain === "tsunami"
    && gateEntry.revisionFamily === "VTSE41"
    && subjectMatches
    && (sameRevision || retainedActivePrecedesWatermark);
}

function isTsunamiVtse41Subject(subject: string): boolean {
  return subject === "tsunami:current" || /^tsunami:\S+$/.test(subject);
}

function matchingTsunamiActiveGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2 | null {
  const subject = tsunamiStateSubjectKey(active.meta);
  const exactEntries = subject == null
    ? []
    : entries.filter((entry) => entry.stateSubjectKey === subject);
  // EventID gate が存在する snapshot では旧 fixed gate へ fallback しない。
  const candidates = exactEntries.length > 0
    ? exactEntries
    : entries.filter((entry) => entry.stateSubjectKey === "tsunami:current");
  return candidates.find((entry) =>
    !entry.cancelled && tsunamiActiveMatchesGate(active, entry)) ?? null;
}

function matchingKeyedTsunamiActiveGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2 | null {
  const subject = tsunamiStateSubjectKey(active.meta);
  if (subject == null) return null;
  return entries.find((entry) =>
    entry.stateSubjectKey === subject
    && !entry.cancelled
    && tsunamiActiveMatchesGate(active, entry)) ?? null;
}

function fixedTsunamiGateDoesNotPrecedeActive(
  gate: PersistedTelegramRevisionGateEntryV2,
  active: ParsedTsunamiInfo,
): boolean {
  const revision = gate.comparison.revision;
  const gateMs = revision.reportDateTime.epochMs;
  const activeMs = active.meta.reportDateTime.epochMs;
  if (gateMs == null || activeMs == null) return false;
  if (gateMs !== activeMs) return gateMs > activeMs;
  const gateMissing = revision.serial.raw == null || revision.serial.raw === "";
  const activeMissing = active.meta.serial.raw == null || active.meta.serial.raw === "";
  if (gateMissing || activeMissing) return gateMissing && activeMissing;
  return revision.serial.valid
    && active.meta.serial.valid
    && revision.serial.numeric != null
    && active.meta.serial.numeric != null
    && revision.serial.numeric >= active.meta.serial.numeric;
}

function migrateLegacyFixedTsunamiGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
  cancelledOnly = false,
): PersistedTelegramRevisionGateEntryV2[] {
  const subject = tsunamiStateSubjectKey(active.meta);
  if (subject == null) return [...entries];
  const fixedGate = entries.find((entry) =>
    entry.domain === "tsunami"
    && entry.revisionFamily === "VTSE41"
    && entry.stateSubjectKey === "tsunami:current"
    && (!cancelledOnly || entry.cancelled)
    && fixedTsunamiGateDoesNotPrecedeActive(entry, active));
  if (fixedGate == null) return [...entries];
  const migrated = entries.map((entry) => entry !== fixedGate ? entry : {
    ...structuredClone(entry),
    stateSubjectKey: subject,
    comparison: {
      ...structuredClone(entry.comparison),
      stateSubjectKey: subject,
      revision: {
        ...structuredClone(entry.comparison.revision),
        eventId: { raw: subject, value: subject, valid: true },
      },
    },
  });
  // canonical subject が既にある部分 migration 形も revision 規則で一件へ畳む。
  return collapseTsunamiGateEntries(migrated).entries;
}

function limitTsunamiVtse41Entries(
  active: readonly ParsedTsunamiInfo[],
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2[] {
  const maxSubjects = TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects;
  if (entries.length <= maxSubjects) return [...entries];
  const activeGates = new Set(active.map((item) => matchingTsunamiActiveGate(item, entries)));
  const ranked = entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const leftPriority = activeGates.has(left.entry) ? 0 : left.entry.cancelled ? 1 : 2;
    const rightPriority = activeGates.has(right.entry) ? 0 : right.entry.cancelled ? 1 : 2;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const timeOrder = right.entry.acceptedAtMs - left.entry.acceptedAtMs;
    return timeOrder !== 0 ? timeOrder : right.index - left.index;
  });
  const retainedIndexes = new Set(
    ranked.slice(0, maxSubjects).map(({ index }) => index),
  );
  return entries.filter((_, index) => retainedIndexes.has(index));
}

function isKeyedTsunamiActive(active: ParsedTsunamiInfo): boolean {
  const eventId = active.meta.eventId;
  return active.meta.infoType.value !== "取消"
    && eventId.valid
    && eventId.value != null
    && eventId.value.trim() !== ""
    && (active.forecast ?? []).length > 0
    && (active.forecast ?? []).every((item) =>
      item.areaCode != null
      && item.areaCode.trim() !== ""
      && item.kindCode != null
      && item.kindCode.trim() !== "");
}

function isDisplayableLegacyTsunamiActive(active: ParsedTsunamiInfo): boolean {
  const forecast = active.forecast ?? [];
  return active.meta.infoType.value !== "取消"
    && !isKeyedTsunamiActive(active)
    && forecast.some((item) =>
      item.areaCode == null
      || item.areaCode.trim() === ""
      || item.kindCode == null
      || item.kindCode.trim() === "")
    && resolveTsunamiLevel(forecast.map((item) => item.kind)) != null;
}

function comparePersistedTsunamiRevision(
  incoming: ParsedTsunamiInfo,
  current: ParsedTsunamiInfo,
): "newer" | "equal" | "older" | "unordered" {
  const incomingMs = incoming.meta.reportDateTime.epochMs;
  const currentMs = current.meta.reportDateTime.epochMs;
  if (incomingMs == null || currentMs == null) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incoming.meta.serial.raw == null || incoming.meta.serial.raw === "";
  const currentMissing = current.meta.serial.raw == null || current.meta.serial.raw === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = incoming.meta.serial.numeric;
  const currentSerial = current.meta.serial.numeric;
  if (
    !incoming.meta.serial.valid
    || !current.meta.serial.valid
    || incomingSerial == null
    || currentSerial == null
  ) return "unordered";
  if (incomingSerial === currentSerial) return "equal";
  return incomingSerial > currentSerial ? "newer" : "older";
}

function comparePersistedTsunamiGateRevision(
  incoming: PersistedTelegramRevisionGateEntryV2,
  current: PersistedTelegramRevisionGateEntryV2,
): "newer" | "equal" | "older" | "unordered" {
  const incomingRevision = incoming.comparison.revision;
  const currentRevision = current.comparison.revision;
  const incomingMs = incomingRevision.reportDateTime.epochMs;
  const currentMs = currentRevision.reportDateTime.epochMs;
  if (incomingMs == null || currentMs == null) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incomingRevision.serial.raw == null || incomingRevision.serial.raw === "";
  const currentMissing = currentRevision.serial.raw == null || currentRevision.serial.raw === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = incomingRevision.serial.numeric;
  const currentSerial = currentRevision.serial.numeric;
  if (
    !incomingRevision.serial.valid
    || !currentRevision.serial.valid
    || incomingSerial == null
    || currentSerial == null
  ) return "unordered";
  if (incomingSerial === currentSerial) return "equal";
  return incomingSerial > currentSerial ? "newer" : "older";
}

function tsunamiInfoTypePrecedence(entry: PersistedTelegramRevisionGateEntryV2): number {
  switch (entry.comparison.revision.infoType.value) {
    case "取消": return 2;
    case "訂正": return 1;
    default: return 0;
  }
}

function mergeEqualTsunamiGateEntries(
  current: PersistedTelegramRevisionGateEntryV2,
  incoming: PersistedTelegramRevisionGateEntryV2,
): PersistedTelegramRevisionGateEntryV2 {
  const incomingWins = incoming.cancelled !== current.cancelled
    ? incoming.cancelled
    : tsunamiInfoTypePrecedence(incoming) > tsunamiInfoTypePrecedence(current);
  const winner = incomingWins ? incoming : current;
  return {
    ...structuredClone(winner),
    acceptedAtMs: Math.max(current.acceptedAtMs, incoming.acceptedAtMs),
    semanticKeys: compactPersistedSemanticKeys([
      ...current.semanticKeys,
      ...incoming.semanticKeys,
    ]),
  };
}

function collapseTsunamiGateEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): { entries: PersistedTelegramRevisionGateEntryV2[]; rejectedKeys: Set<string> } {
  const grouped = new Map<string, PersistedTelegramRevisionGateEntryV2[]>();
  for (const entry of entries) {
    const key = `${entry.domain}:${entry.revisionFamily}:${entry.stateSubjectKey}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  const collapsed: PersistedTelegramRevisionGateEntryV2[] = [];
  const rejectedKeys = new Set<string>();
  for (const [key, group] of grouped) {
    let unordered = false;
    for (let left = 0; left < group.length && !unordered; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (comparePersistedTsunamiGateRevision(group[left], group[right]) === "unordered") {
          unordered = true;
          break;
        }
      }
    }
    if (unordered) {
      rejectedKeys.add(key);
      continue;
    }
    let retained = group[0];
    for (const incoming of group.slice(1)) {
      const order = comparePersistedTsunamiGateRevision(incoming, retained);
      if (order === "newer") retained = incoming;
      else if (order === "equal") retained = mergeEqualTsunamiGateEntries(retained, incoming);
    }
    collapsed.push(retained);
  }
  return { entries: collapsed, rejectedKeys };
}

interface KeyedTsunamiActiveSelection {
  active: ParsedTsunamiInfo[];
  rejectedSubjects: Set<string>;
}

/** EventID 重複は reportDateTimeThenSerial で選び、unordered subject は全件拒否する。 */
function retainNewestKeyedTsunamiActive(
  candidates: readonly ParsedTsunamiInfo[],
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): KeyedTsunamiActiveSelection {
  const grouped = new Map<string, ParsedTsunamiInfo[]>();
  for (const active of candidates) {
    if (!isKeyedTsunamiActive(active)) continue;
    const subject = tsunamiStateSubjectKey(active.meta);
    if (subject == null) continue;
    const group = grouped.get(subject) ?? [];
    group.push(active);
    grouped.set(subject, group);
  }
  const active: ParsedTsunamiInfo[] = [];
  const rejectedSubjects = new Set<string>();
  for (const [subject, group] of grouped) {
    let unordered = false;
    for (let left = 0; left < group.length && !unordered; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (comparePersistedTsunamiRevision(group[left], group[right]) === "unordered") {
          unordered = true;
          break;
        }
      }
    }
    if (unordered) {
      rejectedSubjects.add(subject);
      continue;
    }
    // gate と結合可能な古い candidate へ巻き戻さない。まず全 active から最新を
    // 決め、その一件が gate と結合できなければ subject 全体を拒否する。
    let retained = group[0];
    for (const incoming of group.slice(1)) {
      const order = comparePersistedTsunamiRevision(incoming, retained);
      const incomingCorrection = incoming.meta.infoType.value === "訂正";
      const currentCorrection = retained.meta.infoType.value === "訂正";
      if (
        order === "newer"
        || order === "equal" && incomingCorrection && !currentCorrection
      ) retained = incoming;
    }
    if (matchingKeyedTsunamiActiveGate(retained, entries) == null) {
      rejectedSubjects.add(subject);
      continue;
    }
    active.push(retained);
  }
  return { active, rejectedSubjects };
}

function normalizeTsunamiActiveInputs(
  value: PersistedTelegramFoundationV2["tsunami"],
): { keyedActive: ParsedTsunamiInfo[]; legacyActive: ParsedTsunamiInfo | null } {
  if (value.keyedActive != null) {
    return {
      keyedActive: value.keyedActive.map((item) => structuredClone(item)),
      legacyActive: value.legacyActive == null ? null : structuredClone(value.legacyActive),
    };
  }
  if (value.active == null) {
    return {
      keyedActive: [],
      legacyActive: value.legacyActive == null ? null : structuredClone(value.legacyActive),
    };
  }
  const scalar = structuredClone(value.active);
  return isKeyedTsunamiActive(scalar)
    ? { keyedActive: [scalar], legacyActive: null }
    : { keyedActive: [], legacyActive: scalar };
}

/**
 * gate の global compaction と holder 更新の境界でも自己整合した envelope だけを書く。
 * whole watermark が失われた family は state と item watermark をまとめて落とし、
 * orphan 観測が v2 全体を壊さないようにする。
 */
function normalizeTsunamiFoundationForWrite(
  value: PersistedTelegramFoundationV2["tsunami"],
): PersistedTelegramFoundationV2["tsunami"] {
  const observations: PersistedTsunamiObservationGroupsV2 = { VTSE51: [], VTSE52: [] };
  const gateEntries: PersistedTelegramRevisionGateEntryV2[] = [];
  const inputs = normalizeTsunamiActiveInputs(value);
  const rawVtse41Candidates = value.gateEntries.filter(
    (entry) => entry.domain === "tsunami"
      && entry.revisionFamily === "VTSE41"
      && isTsunamiVtse41Subject(entry.stateSubjectKey),
  );
  let vtse41Candidates = collapseTsunamiGateEntries(rawVtse41Candidates).entries;
  const scalarMigrationActive = value.keyedActive == null
    && value.active != null
    && tsunamiStateSubjectKey(value.active.meta) != null
    ? value.active
    : null;
  if (scalarMigrationActive != null) {
    vtse41Candidates = migrateLegacyFixedTsunamiGate(scalarMigrationActive, vtse41Candidates);
  }
  if (
    inputs.legacyActive != null
    && tsunamiStateSubjectKey(inputs.legacyActive.meta) != null
  ) {
    vtse41Candidates = migrateLegacyFixedTsunamiGate(
      inputs.legacyActive,
      vtse41Candidates,
      !isKeyedTsunamiActive(inputs.legacyActive),
    );
  }
  const keyedInputCandidates = [
    ...inputs.keyedActive,
    ...(inputs.legacyActive != null && isKeyedTsunamiActive(inputs.legacyActive)
      ? [inputs.legacyActive]
      : []),
  ];
  const candidateSelection = retainNewestKeyedTsunamiActive(
    keyedInputCandidates,
    vtse41Candidates,
  );
  const candidateKeyedActive = candidateSelection.active;
  const keyedSubjects = new Set(candidateKeyedActive.flatMap((active) => {
    const subject = tsunamiStateSubjectKey(active.meta);
    return subject == null ? [] : [subject];
  }));
  const candidateLegacyActive = inputs.legacyActive != null
    && isDisplayableLegacyTsunamiActive(inputs.legacyActive)
    && !keyedSubjects.has(tsunamiStateSubjectKey(inputs.legacyActive.meta) ?? "")
    ? inputs.legacyActive
    : null;
  const legacySubject = candidateLegacyActive == null
    ? null
    : tsunamiStateSubjectKey(candidateLegacyActive.meta);
  const eligibleVtse41Entries = vtse41Candidates.filter((entry) =>
    (entry.cancelled || !candidateSelection.rejectedSubjects.has(entry.stateSubjectKey))
    // legacy display は revision gate / 取消照合に参加させない。
    && (entry.cancelled
      || legacySubject == null
      || entry.stateSubjectKey !== legacySubject && entry.stateSubjectKey !== "tsunami:current"));
  const vtse41Entries = limitTsunamiVtse41Entries(
    candidateKeyedActive,
    eligibleVtse41Entries,
  );
  gateEntries.push(...vtse41Entries.map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
  })));
  const keyedActive = retainNewestKeyedTsunamiActive(candidateKeyedActive, vtse41Entries).active
    .map(projectPersistedTsunamiActive);
  const legacyActive = candidateLegacyActive == null
    ? null
    : projectPersistedTsunamiActive(candidateLegacyActive);
  for (const family of ["VTSE51", "VTSE52"] as const) {
    const familyEntries = value.gateEntries.filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === family,
    );
    const wholeSubject = `tsunami:observations:${family}`;
    const wholeEntries = familyEntries.filter((entry) => entry.stateSubjectKey === wholeSubject);
    if (wholeEntries.length !== 1) continue;
    gateEntries.push(...familyEntries.map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    })));
    if (wholeEntries[0].cancelled) continue;
    const activeCodes = new Set(familyEntries.flatMap((entry) =>
      entry.stateSubjectKey !== wholeSubject && !entry.cancelled
        ? [entry.stateSubjectKey]
        : []));
    observations[family] = value.observations[family]
      .filter((item) => {
        const code = item.stationCode?.trim();
        return code != null && code !== "" && activeCodes.has(code);
      })
      .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)
      .map(projectPersistedTsunamiObservation);
  }
  // null の旧 field だけは rollback projection の空状態として維持する。実 payload
  // は keyedActive / legacyActive にのみ書き、scalar snapshot を書き戻さない。
  return {
    ...(value.active === null ? { active: null } : {}),
    keyedActive,
    legacyActive,
    observations,
    gateEntries,
  };
}

/**
 * 構造的型付けと structuredClone だけでは将来の余剰 property が残るため、
 * schema に存在する field だけを列挙して投影する。areaCode は単位4で正式な field。
 */
function projectPersistedTsunamiObservation(
  item: TsunamiObservationStation,
): PersistedTsunamiObservationV2 {
  return {
    areaName: item.areaName,
    ...(Object.hasOwn(item, "areaCode") ? { areaCode: item.areaCode ?? null } : {}),
    ...(item.stationCode != null ? { stationCode: item.stationCode } : {}),
    name: item.name,
    sensor: item.sensor,
    arrivalTime: item.arrivalTime,
    initial: item.initial,
    maxHeightCondition: item.maxHeightCondition,
    maxHeightValue: item.maxHeightValue,
    maxHeight: structuredClone(item.maxHeight),
    ...(Object.hasOwn(item, "maxHeightValueCondition")
      ? { maxHeightValueCondition: item.maxHeightValueCondition }
      : {}),
  };
}

function projectPersistedTsunamiActive(
  active: ParsedTsunamiInfo,
): PersistedTsunamiActiveV2 {
  const projected = structuredClone(active) as PersistedTsunamiActiveV2;
  if (active.earthquake != null) {
    projected.earthquake = {
      ...structuredClone(active.earthquake),
      magnitudeValue: normalizeNumericSpecialValueForPersistence(
        active.earthquake.magnitudeValue
          ?? magnitudeValueFromLegacyScalar(active.earthquake.magnitude),
      ),
      depthValue: normalizeNumericSpecialValueForPersistence(
        active.earthquake.depthValue
          ?? depthValueFromLegacyScalar(active.earthquake.depth),
      ),
    };
  }
  if (active.observations == null) {
    delete projected.observations;
  } else {
    projected.observations = active.observations.map(projectPersistedTsunamiObservation);
  }
  return projected;
}

function sanitizeTsunamiFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["tsunami"] | null {
  if (!isRecord(value) || !isRecord(value.observations) || !Array.isArray(value.gateEntries)) {
    return null;
  }
  const parseActive = (raw: unknown): ParsedTsunamiInfo | undefined =>
    isPersistedTsunamiActive(raw)
      ? canonicalizeLegacyTsunamiInfo(
          structuredClone(sanitizePersistedTsunamiActive(raw)),
        )
      : undefined;
  const rejectedActiveSubjects = new Set<string>();
  const rememberRejectedActiveSubject = (raw: unknown): void => {
    const subject = persistedTsunamiSubjectFromUnknown(raw);
    if (subject != null && !isPersistedTsunamiCancellationUnknown(raw)) {
      rejectedActiveSubjects.add(subject);
    }
  };
  const hasKeyedSchema = Object.hasOwn(value, "keyedActive");
  let scalarActive: ParsedTsunamiInfo | null = null;
  if (!hasKeyedSchema && value.active != null) {
    scalarActive = parseActive(value.active) ?? null;
    if (scalarActive == null) {
      rememberRejectedActiveSubject(value.active);
      recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-entry");
    }
  } else if (hasKeyedSchema && value.active != null && parseActive(value.active) == null) {
    // keyed schema が権威入力なので、rollback projection の破損は domain を巻き込まない。
    rememberRejectedActiveSubject(value.active);
    recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-entry");
  }

  const rawKeyedCandidates = hasKeyedSchema && Array.isArray(value.keyedActive)
    ? value.keyedActive
    : [];
  if (hasKeyedSchema && !Array.isArray(value.keyedActive)) {
    recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-container", true);
  }
  const parsedKeyedCandidates = rawKeyedCandidates.flatMap((raw) => {
    const active = parseActive(raw);
    if (active == null || !isKeyedTsunamiActive(active)) {
      recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-entry");
      const subject = persistedTsunamiSubjectFromUnknown(raw);
      if (subject != null && !isPersistedTsunamiCancellationUnknown(raw)) {
        rejectedActiveSubjects.add(subject);
      }
      return [];
    }
    return [active];
  });
  if (!hasKeyedSchema && scalarActive != null && isKeyedTsunamiActive(scalarActive)) {
    parsedKeyedCandidates.push(scalarActive);
  }

  const schemaLegacy = value.legacyActive == null ? null : parseActive(value.legacyActive) ?? null;
  if (value.legacyActive != null && schemaLegacy == null) {
    rememberRejectedActiveSubject(value.legacyActive);
    recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-entry");
  }
  const candidateLegacy = schemaLegacy
    ?? (!hasKeyedSchema && scalarActive != null && !isKeyedTsunamiActive(scalarActive)
      ? scalarActive
      : null);
  if (schemaLegacy != null && isKeyedTsunamiActive(schemaLegacy)) {
    parsedKeyedCandidates.push(schemaLegacy);
  }
  const displayableLegacy = candidateLegacy != null
    && isDisplayableLegacyTsunamiActive(candidateLegacy)
    ? candidateLegacy
    : null;
  const rawGroups = value.observations;
  if (!Array.isArray(rawGroups.VTSE51) || !Array.isArray(rawGroups.VTSE52)) {
    recordRepair("foundation.tsunami", "family", 1, 0, "invalid-container", true);
    return null;
  }
  const validEntries = value.gateEntries.flatMap((entry) => {
    if (!isGateEntry(entry)) return [];
    if (entry.domain === "tsunami") {
      return entry.revisionFamily === "VTSE41" && isTsunamiVtse41Subject(entry.stateSubjectKey)
        ? [entry]
        : [];
    }
    if (entry.domain !== "tsunamiObservation") return [];
    if (entry.revisionFamily !== "VTSE51" && entry.revisionFamily !== "VTSE52") return [];
    const wholeSubject = `tsunami:observations:${entry.revisionFamily}`;
    return entry.stateSubjectKey === wholeSubject || /^\d+$/.test(entry.stateSubjectKey)
      ? [entry]
      : [];
  }) as PersistedTelegramRevisionGateEntryV2[];
  if (validEntries.length !== value.gateEntries.length) {
    recordRepair("foundation.tsunami", "eventId", value.gateEntries.length - validEntries.length, validEntries.length, "invalid-entry");
  }
  const collapsedEntries = collapseTsunamiGateEntries(validEntries);
  if (collapsedEntries.rejectedKeys.size > 0) {
    recordRepair("foundation.tsunami", "eventId", collapsedEntries.rejectedKeys.size, collapsedEntries.entries.length, "duplicate-subject");
  } else if (collapsedEntries.entries.length !== validEntries.length) {
    recordRepair("foundation.tsunami", "eventId", validEntries.length - collapsedEntries.entries.length, collapsedEntries.entries.length, "duplicate-subject");
  }
  let entries = collapsedEntries.entries;
  if (
    !hasKeyedSchema
    && scalarActive != null
    && tsunamiStateSubjectKey(scalarActive.meta) != null
  ) {
    entries = migrateLegacyFixedTsunamiGate(scalarActive, entries);
  }
  if (schemaLegacy != null && tsunamiStateSubjectKey(schemaLegacy.meta) != null) {
    entries = migrateLegacyFixedTsunamiGate(
      schemaLegacy,
      entries,
      !isKeyedTsunamiActive(schemaLegacy),
    );
  }

  const vtse41Candidates = entries.filter(
    (entry) => entry.domain === "tsunami",
  ) as PersistedTelegramRevisionGateEntryV2[];
  const matchedSelection = retainNewestKeyedTsunamiActive(
    parsedKeyedCandidates,
    vtse41Candidates,
  );
  const matchedKeyedActive = matchedSelection.active;
  for (const subject of matchedSelection.rejectedSubjects) rejectedActiveSubjects.add(subject);
  if (matchedKeyedActive.length !== parsedKeyedCandidates.length) {
    recordRepair("foundation.tsunami", "eventId", parsedKeyedCandidates.length - matchedKeyedActive.length, matchedKeyedActive.length, "coupling-mismatch");
  }
  const keyedSubjectsBeforeCompaction = new Set(matchedKeyedActive.flatMap((active) => {
    const subject = tsunamiStateSubjectKey(active.meta);
    return subject == null ? [] : [subject];
  }));
  const salvageableVtse41Candidates = vtse41Candidates.filter((entry) =>
    entry.cancelled
    || !rejectedActiveSubjects.has(entry.stateSubjectKey)
    || keyedSubjectsBeforeCompaction.has(entry.stateSubjectKey));
  // 正規 keyed state が同じ EventID を持つ場合、legacy 表示を先に退場させる。
  const legacyActive = displayableLegacy != null
    && !keyedSubjectsBeforeCompaction.has(tsunamiStateSubjectKey(displayableLegacy.meta) ?? "")
    ? displayableLegacy
    : null;
  const legacySubject = legacyActive == null ? null : tsunamiStateSubjectKey(legacyActive.meta);
  const vtse41Entries = limitTsunamiVtse41Entries(matchedKeyedActive, salvageableVtse41Candidates.filter(
    (entry) => entry.cancelled
      || legacySubject == null
      || entry.stateSubjectKey !== legacySubject && entry.stateSubjectKey !== "tsunami:current",
  ));
  const retainedVtse41Subjects = new Set(vtse41Entries.map((entry) => entry.stateSubjectKey));
  const limitedVtse41Subjects = new Set(salvageableVtse41Candidates
    .filter((entry) => !retainedVtse41Subjects.has(entry.stateSubjectKey))
    .map((entry) => entry.stateSubjectKey));
  if (limitedVtse41Subjects.size > 0) {
    recordRepair("foundation.tsunami", "eventId", limitedVtse41Subjects.size,
      retainedVtse41Subjects.size, "limit-exceeded");
  }
  const keyedActive = retainNewestKeyedTsunamiActive(matchedKeyedActive, vtse41Entries).active;
  let boundedEntries = (entries as PersistedTelegramRevisionGateEntryV2[]).filter(
    (entry) => entry.domain !== "tsunami"
      || retainedVtse41Subjects.has(entry.stateSubjectKey),
  );

  const groups = {
    VTSE51: rawGroups.VTSE51.flatMap((item) => isTsunamiObservation(item)
      ? [canonicalizeLegacyTsunamiObservation(sanitizePersistedTsunamiObservation(item))] : []),
    VTSE52: rawGroups.VTSE52.flatMap((item) => isTsunamiObservation(item)
      ? [canonicalizeLegacyTsunamiObservation(sanitizePersistedTsunamiObservation(item))] : []),
  };
  let discardedObservationFamily = false;
  for (const family of ["VTSE51", "VTSE52"] as const) {
    const rawFamily = rawGroups[family] as unknown[];
    const invalidStations = new Set(rawFamily.flatMap((item) =>
      isRecord(item) && typeof item.stationCode === "string" && !isTsunamiObservation(item)
        ? [item.stationCode.trim()] : []));
    if (groups[family].length !== rawFamily.length) {
      recordRepair("foundation.tsunami", "stationCode", rawFamily.length - groups[family].length, groups[family].length, "invalid-entry");
    }
    let familyEntries = boundedEntries.filter((entry) => entry.revisionFamily === family);
    const wholeSubject = `tsunami:observations:${family}`;
    const wholeEntries = familyEntries.filter((entry) => entry.stateSubjectKey === wholeSubject);
    const codes = groups[family].map((item) => item.stationCode!.trim());
    const duplicateCodes = new Set(codes.filter((code, index) => codes.indexOf(code) !== index));
    const validWhole = wholeEntries.length === 1 && wholeEntries[0]?.cancelled !== true;
    if ((familyEntries.length > 0 || groups[family].length > 0) && !validWhole) {
      // whole-family watermark が壊れても、別 family / VTSE41 を巻き込まない。
      const discarded = groups[family].length + familyEntries.filter((entry) => !entry.cancelled).length;
      groups[family] = [];
      discardedObservationFamily = true;
      familyEntries = familyEntries.filter((entry) => entry.cancelled);
      boundedEntries = boundedEntries.filter((entry) => entry.revisionFamily !== family || entry.cancelled);
      if (discarded > 0) recordRepair("foundation.tsunami", "family", 1, 0, "coupling-mismatch");
      continue;
    }
    const rejectedStations = new Set([...invalidStations, ...duplicateCodes]);
    groups[family] = groups[family].filter((item) => !rejectedStations.has(item.stationCode!.trim()));
    for (const code of groups[family].map((item) => item.stationCode!.trim())) {
      if (!familyEntries.some((entry) => entry.stateSubjectKey === code && !entry.cancelled)) {
        rejectedStations.add(code);
      }
    }
    if (rejectedStations.size > 0) {
      groups[family] = groups[family].filter((item) => !rejectedStations.has(item.stationCode!.trim()));
      boundedEntries = boundedEntries.filter((entry) => entry.revisionFamily !== family
        || entry.cancelled || !rejectedStations.has(entry.stateSubjectKey));
      recordRepair("foundation.tsunami", "stationCode", rejectedStations.size, groups[family].length, duplicateCodes.size > 0 ? "duplicate-subject" : "coupling-mismatch");
    }
  }

  // active は caller 互換の read-only projection。writer は keyedActive /
  // legacyActive だけを出力し、旧 scalar form へ書き戻さない。
  const compatibilityActive = keyedActive.length === 1
    ? keyedActive[0]
    : keyedActive.length === 0 ? legacyActive : null;
  return {
    ...(compatibilityActive != null || Object.hasOwn(value, "active") || discardedObservationFamily
      ? { active: compatibilityActive == null ? null : structuredClone(compatibilityActive) }
      : {}),
    keyedActive: keyedActive.map((active) => structuredClone(active)),
    legacyActive: legacyActive == null ? null : structuredClone(legacyActive),
    observations: groups,
    gateEntries: boundedEntries.map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
      // VTSE41 の旧 policy が保存した明示 null も有限 TTL へ一方向移行する。
      // 観測 family は現在も null policy のため、欠落値だけ各 policy で補完する。
      tombstoneRetentionMs: entry.domain === "tsunami"
        ? entry.tombstoneRetentionMs
          ?? TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.tombstoneRetentionMs
        : entry.tombstoneRetentionMs === undefined
          ? TSUNAMI_REVISION_FAMILY_POLICIES[entry.revisionFamily as "VTSE51" | "VTSE52"].tombstoneRetentionMs
          : entry.tombstoneRetentionMs,
    })),
  };
}

function compareWeatherIdentity(
  incoming: WeatherReportIdentity,
  current: WeatherReportIdentity,
): "newer" | "equal" | "older" | "unordered" {
  const incomingMs = Date.parse(incoming.reportDateTime);
  const currentMs = Date.parse(current.reportDateTime);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(currentMs)) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incoming.serial == null || incoming.serial === "";
  const currentMissing = current.serial == null || current.serial === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = parseTelegramSerial(incoming.serial);
  const currentSerial = parseTelegramSerial(current.serial);
  if (
    !incomingSerial.valid
    || !currentSerial.valid
    || incomingSerial.numeric == null
    || currentSerial.numeric == null
  ) return "unordered";
  if (incomingSerial.numeric === currentSerial.numeric) return "equal";
  return incomingSerial.numeric > currentSerial.numeric ? "newer" : "older";
}

function gateWeatherIdentity(entry: PersistedTelegramRevisionGateEntryV2): WeatherReportIdentity {
  return {
    reportDateTime: entry.comparison.revision.reportDateTime.raw ?? "",
    serial: entry.comparison.revision.serial.raw ?? null,
  };
}

function vpws50FoundationIsConsistent(
  authoritative: boolean,
  state: PersistedVpws50StateV2 | null,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): boolean {
  // v1 adapter は表示 snapshot と trusted legacy watermark のみを運び、holder は正にしない。
  if (!authoritative) return state == null;
  if (state == null) return entries.length === 0;
  if (isEmptyVpws50State(state)) return entries.every((entry) => entry.cancelled);

  const canonicalEntries = entries.filter((entry) => entry.stateSubjectKey === "weather:vpws50");
  if (canonicalEntries.length > 1) return false;
  const partialStreams = state.partialStreams ?? [];
  const partialBySubject = new Map(partialStreams.map((entry) => [entry.subjectKey, entry]));
  const restoredSubjects = new Set(state.restoredPartialSubjects ?? []);
  const tombstoneOffices = new Set((state.emergencyClearTombstones ?? [])
    .flatMap((entry) => {
      const key = normalizeWeatherOfficeWatermarkKey(entry.officeKey);
      return key == null ? [] : [key];
    }));
  if ([...restoredSubjects].some((subject) => !partialBySubject.has(subject))) return false;
  for (const stream of partialStreams) {
    const gateEntry = entries.find((entry) => entry.stateSubjectKey === stream.subjectKey);
    if (gateEntry == null) return false;
    const relation = compareWeatherIdentity(stream.identity, gateWeatherIdentity(gateEntry));
    // VPWW55-61 の取消は stream 内の直前 snapshot を復元する。gate は取消 revision の
    // tombstone を保持するため、復元済み partial はそれより古い identity で整合する。
    if (gateEntry.cancelled
      ? relation !== "older" || !restoredSubjects.has(stream.subjectKey)
      : relation !== "equal" || restoredSubjects.has(stream.subjectKey)) return false;
  }
  if (entries.some((entry) => entry.stateSubjectKey !== "weather:vpws50"
    && !entry.cancelled
    && !partialBySubject.has(entry.stateSubjectKey)
    && !tombstoneOffices.has(weatherOfficeWatermarkKey(
      weatherOfficeFromStreamKey(entry.stateSubjectKey),
    ) ?? ""))) return false;

  const gateEntry = canonicalEntries[0];
  if (state.current == null) {
    // 初回全国報の取消では holder の current/history は空になる一方、canonical gate は
    // 無期限 tombstone として残る。VPWW55-61 overlay だけが active な場合も同じ形になる。
    return (gateEntry == null || gateEntry.cancelled) && state.history.length === 0;
  }
  if (gateEntry == null) return false;

  const historyIdentities = state.history.map((item) => item.identity);
  if (historyIdentities.some((identity) => identity == null)) return false;
  const ordered = [
    ...(historyIdentities as WeatherReportIdentity[]),
    state.current.identity,
  ];
  for (let index = 1; index < ordered.length; index++) {
    if (compareWeatherIdentity(ordered[index - 1], ordered[index]) !== "older") return false;
  }

  const currentToGate = compareWeatherIdentity(state.current.identity, gateWeatherIdentity(gateEntry));
  return gateEntry.cancelled ? currentToGate === "older" : currentToGate === "equal";
}

function sanitizeVpws50Foundation(
  value: unknown,
): PersistedTelegramFoundationV2["vpws50"] | null {
  if (!isRecord(value) || typeof value.authoritative !== "boolean") return null;
  const state = value.state;
  const entries = value.gateEntries;
  if ((state != null && !isVpws50State(state)) || !Array.isArray(entries) || !entries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWS50"
    && (entry.stateSubjectKey === "weather:vpws50"
      || weatherOfficeFromStreamKey(entry.stateSubjectKey) != null),
  )) return null;
  const validatedState = state == null
    ? null
    : migratePersistedVpws50EmergencyClears(state as PersistedVpws50StateV2);
  const validatedEntries = entries as PersistedTelegramRevisionGateEntryV2[];
  if (!vpws50FoundationIsConsistent(value.authoritative, validatedState, validatedEntries)) return null;
  const compactedEntries = validatedEntries.map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    // 旧 VPWS50 policy が保存した明示 null も有限 TTL へ一方向移行する。
    tombstoneRetentionMs: entry.tombstoneRetentionMs
      ?? VPWS50_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  }));
  if (validatedState != null) {
    const hasProjectionState = validatedState.current != null
      || validatedState.history.length > 0
      || (validatedState.partialStreams?.length ?? 0) > 0
      || (validatedState.partialHistory?.length ?? 0) > 0
      || (validatedState.restoredPartialSubjects?.length ?? 0) > 0;
    if (entries.length === 0 && hasProjectionState) return null;
    const receivedAtMs = entries.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.max(...entries.map((entry) => entry.acceptedAtMs));
    const identities = [
      validatedState.current?.identity,
      ...validatedState.history.map((entry) => entry.identity),
      ...(validatedState.partialStreams ?? []).map((entry) => entry.identity),
      ...(validatedState.partialHistory ?? []).flatMap((group) => group.entries.map((entry) => entry.identity)),
      ...(validatedState.emergencyClearTombstones ?? []).map((entry) => entry.identity),
    ].filter((identity) => identity != null);
    if (!identities.every((identity) => isWeatherIdentity(identity, receivedAtMs))) return null;
  }
  return {
    authoritative: value.authoritative,
    state: validatedState == null ? null : structuredClone(validatedState),
    gateEntries: compactedEntries,
  };
}

function isVpww56SubjectKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("weather:VPWW56:")
    && value.length > "weather:VPWW56:".length;
}

function isVpww56View(value: unknown): value is Vpws50CurrentAreasForDisplay {
  if (!isRecord(value)) return false;
  if (
    !Number.isSafeInteger(value.totalAreas) || (value.totalAreas as number) < 0
    || !Number.isSafeInteger(value.specialAreas) || (value.specialAreas as number) < 0
    || !Number.isSafeInteger(value.warningAreas) || (value.warningAreas as number) < 0
    || !Number.isSafeInteger(value.advisoryAreas) || (value.advisoryAreas as number) < 0
    || !Array.isArray(value.kinds)
  ) return false;
  return value.kinds.every((group) =>
    isRecord(group)
    && typeof group.kindCode === "string"
    && typeof group.kindShortName === "string"
    && typeof group.kindName === "string"
    && typeof group.displaySeverity === "string"
    && [
      "officialL5", "officialL4", "officialL3", "officialL2", "officialL1",
      "nonLevelSpecial", "nonLevelWarning", "nonLevelAdvisory", "release", "unknown",
    ].includes(group.displaySeverity)
    && (group.officialAlertLevel == null
      || group.officialAlertLevel === 1 || group.officialAlertLevel === 2
      || group.officialAlertLevel === 3 || group.officialAlertLevel === 4
      || group.officialAlertLevel === 5)
    && Array.isArray(group.areas)
    && group.areas.every((area) =>
      isRecord(area) && typeof area.areaName === "string" && typeof area.areaCode === "string"),
  );
}

function normalizeVpww56FoundationForWrite(
  value: PersistedTelegramFoundationV2["vpww56"],
): PersistedTelegramFoundationV2["vpww56"] {
  if (!value.authoritative) return emptyVpww56Foundation();
  const gateEntries = value.gateEntries
    .filter((entry) => entry.domain === "weather"
      && entry.revisionFamily === "VPWW56"
      && isVpww56SubjectKey(entry.stateSubjectKey))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const activeSubjects = new Set(
    gateEntries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const pendingSubjects = (value.state?.pendingSubjects ?? [])
    .filter((subject) => activeSubjects.has(subject))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!);
  const streams = (value.state?.streams ?? [])
    .filter((stream) => stream.generation === VPWW56_SNAPSHOT_GENERATION
      && activeSubjects.has(stream.subjectKey)
      && !pendingSubjects.includes(stream.subjectKey))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((stream) => ({
      ...structuredClone(stream),
      generation: VPWW56_SNAPSHOT_GENERATION,
    }));
  const retainedSubjects = new Set(streams.map((stream) => stream.subjectKey));
  for (const subject of pendingSubjects) retainedSubjects.add(subject);
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: retainedSubjects.size === 0 ? null : {
      generation: VPWW56_SNAPSHOT_GENERATION,
      streams,
      pendingSubjects,
    },
    gateEntries: gateEntries.filter((entry) => entry.cancelled || retainedSubjects.has(entry.stateSubjectKey)),
  };
}

/**
 * 市町村等粒度 marker 導入前の active stream は、官署 identity と revision watermark だけを
 * 救済する。旧 view は表示せず、各官署の次の受理報まで pending とする。取消済み subject は
 * active 官署ではないため旧 tombstone ごと捨てる。
 */
function migrateLegacyVpww56Foundation(
  value: Record<string, unknown>,
): PersistedTelegramFoundationV2["vpww56"] | null {
  if (value.authoritative !== true || !Array.isArray(value.gateEntries)) return null;
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWW56"
    && isVpww56SubjectKey(entry.stateSubjectKey),
  )) return null;
  if (value.state == null) return emptyVpww56Foundation();
  if (!isRecord(value.state) || !Array.isArray(value.state.streams)) return null;
  if (value.state.streams.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (!value.state.streams.every((stream) =>
    isRecord(stream) && isVpww56SubjectKey(stream.subjectKey) && isVpww56View(stream.view),
  )) return null;

  const rawStreams = value.state.streams as Array<{
    generation?: typeof VPWW56_SNAPSHOT_GENERATION;
    subjectKey: string;
    view: Vpws50CurrentAreasForDisplay;
  }>;
  const streamSubjects = rawStreams.map((stream) => stream.subjectKey);
  if (new Set(streamSubjects).size !== streamSubjects.length) return null;
  const streams = rawStreams
    .filter((stream) => stream.generation === VPWW56_SNAPSHOT_GENERATION)
    .map((stream) => ({
      generation: VPWW56_SNAPSHOT_GENERATION,
      subjectKey: stream.subjectKey,
      view: structuredClone(stream.view),
    }));
  const pendingSubjects = rawStreams
    .filter((stream) => stream.generation !== VPWW56_SNAPSHOT_GENERATION)
    .map((stream) => stream.subjectKey);
  const representedSet = new Set(streamSubjects);
  const activeEntries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[])
    .filter((entry) => !entry.cancelled && representedSet.has(entry.stateSubjectKey))
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
      tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
        ? VPWW56_REVISION_FAMILY_POLICY.tombstoneRetentionMs
        : entry.tombstoneRetentionMs,
    }));
  if (activeEntries.length !== streamSubjects.length) return null;
  const activeSubjects = new Set(activeEntries.map((entry) => entry.stateSubjectKey));
  if (activeSubjects.size !== streamSubjects.length
    || streamSubjects.some((subject) => !activeSubjects.has(subject))) return null;
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: {
      generation: VPWW56_SNAPSHOT_GENERATION,
      streams,
      pendingSubjects,
    },
    gateEntries: activeEntries,
  };
}

function sanitizeVpww56Foundation(
  value: unknown,
  salvage = true,
): PersistedTelegramFoundationV2["vpww56"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.gateEntries)
  ) {
    return null;
  }
  if (value.generation !== VPWW56_SNAPSHOT_GENERATION) {
    return migrateLegacyVpww56Foundation(value);
  }
  const salvageState = value.state == null
    ? { generation: VPWW56_SNAPSHOT_GENERATION, streams: [], pendingSubjects: [] }
    : value.state;
  if (salvage && value.authoritative
    && isRecord(salvageState) && salvageState.generation === VPWW56_SNAPSHOT_GENERATION
    && Array.isArray(salvageState.streams) && salvageState.streams.every((stream) =>
      !isRecord(stream) || typeof stream.subjectKey !== "string"
        || stream.generation === VPWW56_SNAPSHOT_GENERATION)) {
    if (!Array.isArray(salvageState.streams)
      || !Array.isArray(salvageState.pendingSubjects)) return null;
    const invalidSubjects = new Set<string>();
    const couplingSubjects = new Set<string>();
    const duplicateSubjects = new Set<string>();
    const gates = value.gateEntries.flatMap((raw) => {
      if (isGateEntry(raw) && raw.domain === "weather" && raw.revisionFamily === "VPWW56"
        && isVpww56SubjectKey(raw.stateSubjectKey)) return [raw];
      if (isRecord(raw) && typeof raw.stateSubjectKey === "string" && isVpww56SubjectKey(raw.stateSubjectKey)) {
        invalidSubjects.add(raw.stateSubjectKey);
      }
      return [];
    }) as PersistedTelegramRevisionGateEntryV2[];
    const streams = salvageState.streams.flatMap((raw) => {
      if (isRecord(raw) && raw.generation === VPWW56_SNAPSHOT_GENERATION
        && isVpww56SubjectKey(raw.subjectKey) && isVpww56View(raw.view)) return [raw];
      if (isRecord(raw) && typeof raw.subjectKey === "string" && isVpww56SubjectKey(raw.subjectKey)) invalidSubjects.add(raw.subjectKey);
      return [];
    });
    const pending = salvageState.pendingSubjects.flatMap((raw) => {
      if (isVpww56SubjectKey(raw)) return [raw];
      return [];
    });
    const markDuplicates = (subjects: readonly string[]): void => {
      const counts = new Map<string, number>();
      for (const subject of subjects) counts.set(subject, (counts.get(subject) ?? 0) + 1);
      for (const [subject, count] of counts) if (count > 1) duplicateSubjects.add(subject);
    };
    markDuplicates(gates.map((entry) => entry.stateSubjectKey));
    markDuplicates(streams.map((stream) => stream.subjectKey as string));
    markDuplicates(pending);
    const represented = new Set([...streams.map((stream) => stream.subjectKey as string), ...pending]);
    for (const gate of gates) {
      if (!gate.cancelled && !represented.has(gate.stateSubjectKey) && !invalidSubjects.has(gate.stateSubjectKey)) couplingSubjects.add(gate.stateSubjectKey);
    }
    const activeGates = new Set(gates.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey));
    for (const subject of represented) if (!activeGates.has(subject) && !invalidSubjects.has(subject)) couplingSubjects.add(subject);
    const rejected = new Set([...invalidSubjects, ...duplicateSubjects, ...couplingSubjects]);
    let filteredGates = gates.filter((entry) =>
      !duplicateSubjects.has(entry.stateSubjectKey)
      && !couplingSubjects.has(entry.stateSubjectKey)
      && (entry.cancelled || !invalidSubjects.has(entry.stateSubjectKey)));
    let filteredStreams = streams.filter((stream) => !rejected.has(stream.subjectKey as string));
    let filteredPending = pending.filter((subject) => !rejected.has(subject));
    const retainedByLimit = filteredGates.slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!);
    const limitedSubjects = new Set(filteredGates
      .filter((entry) => !retainedByLimit.includes(entry))
      .map((entry) => entry.stateSubjectKey));
    if (limitedSubjects.size > 0) {
      filteredGates = retainedByLimit;
      filteredStreams = filteredStreams.filter((stream) => !limitedSubjects.has(stream.subjectKey as string));
      filteredPending = filteredPending.filter((subject) => !limitedSubjects.has(subject));
    }
    const discardedSubjects = new Set([...rejected, ...limitedSubjects]);
    if (filteredGates.length !== value.gateEntries.length
      || filteredStreams.length !== salvageState.streams.length
      || filteredPending.length !== salvageState.pendingSubjects.length) {
      const retainedSubjects = new Set([
        ...filteredStreams.map((stream) => stream.subjectKey as string), ...filteredPending,
        ...filteredGates.map((entry) => entry.stateSubjectKey),
      ]);
      recordRepair("foundation.vpww56", "subject", discardedSubjects.size || 1, retainedSubjects.size,
        invalidSubjects.size > 0 ? "invalid-entry"
          : duplicateSubjects.size > 0 ? "duplicate-subject"
            : couplingSubjects.size > 0 ? "coupling-mismatch" : "limit-exceeded");
    }
    return sanitizeVpww56Foundation({
      ...value,
      gateEntries: filteredGates,
      state: value.state == null && filteredStreams.length === 0 && filteredPending.length === 0
        ? null
        : { ...salvageState, streams: filteredStreams, pendingSubjects: filteredPending },
    }, false);
  }
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWW56"
    && isVpww56SubjectKey(entry.stateSubjectKey),
  )) return null;
  const entries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    // 導入前 v2 に field が無い場合は VPWW56 の 6 時間 policy へ補完する。
    tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
      ? VPWW56_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : entry.tombstoneRetentionMs,
  }));
  if (entries.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const gateSubjects = new Set(entries.map((entry) => entry.stateSubjectKey));
  if (gateSubjects.size !== entries.length) return null;
  if (!value.authoritative) {
    return value.state == null && entries.length === 0
      ? emptyVpww56Foundation()
      : null;
  }
  if (value.state == null) {
    return entries.some((entry) => !entry.cancelled)
      ? null
      : {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: true,
          state: null,
          gateEntries: entries,
        };
  }
  if (
    !isRecord(value.state)
    || !Array.isArray(value.state.streams)
  ) return null;
  if (value.state.generation !== VPWW56_SNAPSHOT_GENERATION) {
    return migrateLegacyVpww56Foundation(value);
  }
  if (value.state.streams.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (!Array.isArray(value.state.pendingSubjects)
    || value.state.streams.some((stream) =>
      !isRecord(stream) || stream.generation !== VPWW56_SNAPSHOT_GENERATION)) {
    return migrateLegacyVpww56Foundation(value);
  }
  if (!value.state.streams.every((stream) =>
    isRecord(stream)
    && stream.generation === VPWW56_SNAPSHOT_GENERATION
    && isVpww56SubjectKey(stream.subjectKey)
    && isVpww56View(stream.view),
  )) return null;
  if (value.state.pendingSubjects.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!
    || !value.state.pendingSubjects.every(isVpww56SubjectKey)) return null;
  const streams = (value.state.streams as PersistedVpww56StateV2["streams"]).map((stream) =>
    structuredClone(stream));
  const pendingSubjects = value.state.pendingSubjects as string[];
  const streamSubjects = new Set(streams.map((stream) => stream.subjectKey));
  if (streamSubjects.size !== streams.length) return null;
  const pendingSet = new Set(pendingSubjects);
  if (pendingSet.size !== pendingSubjects.length
    || pendingSubjects.some((subject) => streamSubjects.has(subject))) return null;
  const activeGateSubjects = new Set(
    entries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const representedSubjects = new Set([...streamSubjects, ...pendingSet]);
  if (
    representedSubjects.size !== activeGateSubjects.size
    || [...representedSubjects].some((subject) => !activeGateSubjects.has(subject))
  ) return null;
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: { generation: VPWW56_SNAPSHOT_GENERATION, streams, pendingSubjects },
    gateEntries: entries,
  };
}

function isVolcanoFoundationSubject(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  return entry.domain === "volcano"
    && (
      entry.revisionFamily === "volcanoAlert"
        && /^volcano:alert:[^:]+$/.test(entry.stateSubjectKey)
        && (entry.legacyRevisionKey == null || entry.legacyRevisionKey === entry.stateSubjectKey)
      || entry.revisionFamily === "volcanoEruption"
        && /^volcano:eruption:[^:]+$/.test(entry.stateSubjectKey)
        && (entry.legacyRevisionKey == null || /^volcano:event:.+$/.test(entry.legacyRevisionKey))
    );
}

function isPersistedVolcanoHolderState(value: unknown): value is PersistedVolcanoStateV2 {
  if (!isRecord(value) || !Array.isArray(value.alerts) || !Array.isArray(value.eruptions)) return false;
  const alertCodes = value.alerts.flatMap((entry) =>
    isRecord(entry) && typeof entry.volcanoCode === "string" ? [entry.volcanoCode] : []);
  const eruptionCodes = value.eruptions.flatMap((entry) =>
    isRecord(entry) && typeof entry.volcanoCode === "string" ? [entry.volcanoCode] : []);
  return new Set(alertCodes).size === value.alerts.length
    && new Set(eruptionCodes).size === value.eruptions.length
    && value.alerts.length <= VOLCANO_ALERT_REVISION_FAMILY_POLICY.maxSubjects!
    && value.eruptions.length <= VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.maxSubjects!
    && value.alerts.every((entry) =>
      isRecord(entry)
      && typeof entry.volcanoCode === "string" && entry.volcanoCode.trim() !== ""
      && typeof entry.volcanoName === "string"
      && (entry.alertLevel == null || Number.isFinite(entry.alertLevel))
      && (entry.alertLevelCode == null || typeof entry.alertLevelCode === "string")
      && ["issue", "continue", "raise", "lower", "release", "cancel"].includes(String(entry.action))
      && typeof entry.reportDateTime === "string"
      && parseStrictReportDateTime(entry.reportDateTime, Number.MAX_SAFE_INTEGER).valid
      && (entry.alertClass == null || isVolcanoAlertClass(entry.alertClass))
      && typeof entry.warningKind === "string"
      && isStringArray(entry.targetKinds))
    && value.eruptions.every((entry) =>
      isRecord(entry)
      && typeof entry.volcanoCode === "string" && entry.volcanoCode.trim() !== ""
      && (entry.eventId == null || typeof entry.eventId === "string")
      && (entry.legacyV1Fallback == null || typeof entry.legacyV1Fallback === "boolean"));
}

function normalizeVolcanoFoundationForWrite(
  value: PersistedTelegramFoundationV2["volcano"],
): PersistedTelegramFoundationV2["volcano"] {
  if (!value.authoritative) return emptyVolcanoFoundation();
  const gateEntries = value.gateEntries
    .filter(isVolcanoFoundationSubject)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const activeSubjects = new Set(
    gateEntries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const active = value.active.flatMap((entry) => {
    const keepAlert = activeSubjects.has(`volcano:alert:${entry.code}`);
    const keepEruption = activeSubjects.has(`volcano:eruption:${entry.code}`);
    if (!keepAlert && !keepEruption) return [];
    const copy = structuredClone(entry);
    if (!keepAlert) {
      copy.alertLevel = null;
      copy.alertClass = null;
      copy.warningKind = null;
      copy.targetKinds = [];
      copy.alertExpiresAtMs = null;
      copy.alertRevision = null;
    }
    if (!keepEruption) {
      copy.latestEvent = null;
      copy.latestEventId = null;
      copy.eventExpiresAtMs = null;
      copy.eventRevision = null;
    }
    return [copy];
  });
  const state = value.state == null ? null : {
    alerts: value.state.alerts
      .filter((entry) => activeSubjects.has(`volcano:alert:${entry.volcanoCode}`))
      .map((entry) => structuredClone(entry)),
    eruptions: value.state.eruptions
      .filter((entry) => activeSubjects.has(`volcano:eruption:${entry.volcanoCode}`))
      .map((entry) => structuredClone(entry)),
  };
  return {
    authoritative: true,
    state: state != null && (state.alerts.length > 0 || state.eruptions.length > 0) ? state : null,
    active,
    gateEntries,
  };
}

function sanitizeVolcanoFoundation(
  value: unknown,
  salvage = true,
): PersistedTelegramFoundationV2["volcano"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.active)
    || !Array.isArray(value.gateEntries)
  ) return null;
  if (!value.authoritative) {
    return value.state == null && value.active.length === 0 && value.gateEntries.length === 0
      ? emptyVolcanoFoundation()
      : null;
  }
  if (salvage) {
    if (value.state != null && (!isRecord(value.state) || !Array.isArray(value.state.alerts)
      || !Array.isArray(value.state.eruptions))) return null;
    const rawState = value.state as Record<string, unknown> | null;
    const rawAlerts = rawState == null ? [] : rawState.alerts as unknown[];
    const rawEruptions = rawState == null ? [] : rawState.eruptions as unknown[];
    const rejected = new Set<string>();
    const codeOf = (raw: unknown): string | null => isRecord(raw) && typeof raw.volcanoCode === "string"
      ? raw.volcanoCode : isRecord(raw) && typeof raw.code === "string" ? raw.code : null;
    const active = value.active.filter(isVolcanoState) as PersistedVolcanoStateV1[];
    for (const raw of value.active) if (!isVolcanoState(raw)) {
      const code = codeOf(raw); if (code != null) rejected.add(code);
    }
    const alerts = rawAlerts.flatMap((raw) =>
      isPersistedVolcanoHolderState({ alerts: [raw], eruptions: [] })
        ? [raw as PersistedVolcanoStateV2["alerts"][number]] : []);
    const eruptions = rawEruptions.flatMap((raw) =>
      isPersistedVolcanoHolderState({ alerts: [], eruptions: [raw] })
        ? [raw as PersistedVolcanoStateV2["eruptions"][number]] : []);
    for (const raw of [...rawAlerts, ...rawEruptions]) {
      const valid = isPersistedVolcanoHolderState({ alerts: [raw], eruptions: [] })
        || isPersistedVolcanoHolderState({ alerts: [], eruptions: [raw] });
      if (!valid) { const code = codeOf(raw); if (code != null) rejected.add(code); }
    }
    const gates = value.gateEntries.filter((raw) =>
      isGateEntry(raw) && isVolcanoFoundationSubject(raw)) as PersistedTelegramRevisionGateEntryV2[];
    for (const raw of value.gateEntries) if (!(isGateEntry(raw) && isVolcanoFoundationSubject(raw))) {
      if (isRecord(raw) && typeof raw.stateSubjectKey === "string") {
        const code = raw.stateSubjectKey.split(":").at(-1); if (code != null) rejected.add(code);
      }
    }
    const codes = new Set<string>([
      ...active.map((item) => item.code), ...alerts.map((item) => item.volcanoCode),
      ...eruptions.map((item) => item.volcanoCode),
      ...gates.map((item) => item.stateSubjectKey.split(":").at(-1)!),
    ]);
    const kept: PersistedTelegramFoundationV2["volcano"][] = [];
    for (const code of codes) {
      if (rejected.has(code)) continue;
      const bundle = sanitizeVolcanoFoundation({
        authoritative: true,
        active: active.filter((item) => item.code === code),
        state: rawState == null ? null : {
          alerts: alerts.filter((item) => item.volcanoCode === code),
          eruptions: eruptions.filter((item) => item.volcanoCode === code),
        },
        gateEntries: gates.filter((item) => item.stateSubjectKey.endsWith(`:${code}`)),
      }, false);
      if (bundle == null) rejected.add(code); else kept.push(bundle);
    }
    const boundedKept = kept.slice(-Math.min(
      VOLCANO_ALERT_REVISION_FAMILY_POLICY.maxSubjects!,
      VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.maxSubjects!,
    ));
    const limitedCodes = new Set(kept.filter((bundle) => !boundedKept.includes(bundle)).flatMap((bundle) => [
      ...bundle.active.map((item) => item.code),
      ...(bundle.state?.alerts.map((item) => item.volcanoCode) ?? []),
      ...(bundle.state?.eruptions.map((item) => item.volcanoCode) ?? []),
      ...bundle.gateEntries.map((item) => item.stateSubjectKey.split(":").at(-1)!),
    ]));
    if (rejected.size > 0 || limitedCodes.size > 0
      || active.length !== value.active.length || gates.length !== value.gateEntries.length) {
      recordRepair("foundation.volcano", "code", rejected.size + limitedCodes.size || 1, boundedKept.length,
        rejected.size > 0 ? "coupling-mismatch" : "limit-exceeded");
    }
    return {
      authoritative: true,
      state: boundedKept.flatMap((item) => item.state == null ? [] : [item.state]).length === 0 ? null : {
        alerts: boundedKept.flatMap((item) => item.state?.alerts ?? []),
        eruptions: boundedKept.flatMap((item) => item.state?.eruptions ?? []),
      },
      active: boundedKept.flatMap((item) => item.active),
      gateEntries: boundedKept.flatMap((item) => item.gateEntries),
    };
  }
  if (!value.active.every(isVolcanoState)) return null;
  if (value.state != null && !isPersistedVolcanoHolderState(value.state)) return null;
  if (!value.gateEntries.every((entry) => isGateEntry(entry) && isVolcanoFoundationSubject(entry))) {
    return null;
  }
  const entries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
      ? entry.revisionFamily === "volcanoAlert"
        ? VOLCANO_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs
        : VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : entry.tombstoneRetentionMs,
  }));
  const keys = new Set(entries.map((entry) => `${entry.revisionFamily}:${entry.stateSubjectKey}`));
  if (keys.size !== entries.length) return null;
  if (entries.filter((entry) => entry.revisionFamily === "volcanoAlert").length
    > VOLCANO_ALERT_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (entries.filter((entry) => entry.revisionFamily === "volcanoEruption").length
    > VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const activeSubjects = new Set(entries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey));
  const active = (value.active as PersistedVolcanoStateV1[]).map(migrateVolcanoStateForRead);
  const gateBySubject = new Map(entries.map((entry) => [entry.stateSubjectKey, entry]));
  for (const volcano of active) {
    if (volcano.alertLevel != null || volcano.alertClass?.isActive === true) {
      const gate = gateBySubject.get(`volcano:alert:${volcano.code}`);
      if (
        gate == null || gate.cancelled || volcano.alertRevision == null
        || volcano.alertRevision.reportTimeMs !== gate.comparison.revision.reportDateTime.epochMs
        || volcano.alertRevision.serial !== gate.comparison.revision.serial.raw
      ) return null;
    }
    if (volcano.latestEvent != null) {
      const gate = gateBySubject.get(`volcano:eruption:${volcano.code}`);
      if (
        gate == null || gate.cancelled || volcano.eventRevision == null
        || volcano.eventRevision.reportTimeMs !== gate.comparison.revision.reportDateTime.epochMs
        || volcano.eventRevision.serial !== gate.comparison.revision.serial.raw
      ) return null;
    }
  }
  const state = value.state == null ? null : structuredClone(value.state as PersistedVolcanoStateV2);
  if (state == null && activeSubjects.size > 0) return null;
  if (state != null) {
    if (state.alerts.some((entry) => {
      const gate = gateBySubject.get(`volcano:alert:${entry.volcanoCode}`);
      return gate == null || gate.cancelled
        || gate.comparison.revision.reportDateTime.raw !== entry.reportDateTime;
    })) return null;
    if (state.eruptions.some((entry) => {
      if (!activeSubjects.has(`volcano:eruption:${entry.volcanoCode}`)) return true;
      const projection = active.find((candidate) => candidate.code === entry.volcanoCode);
      return projection?.latestEvent != null && projection.latestEventId !== entry.eventId;
    })) return null;
    for (const subject of activeSubjects) {
      if (subject.startsWith("volcano:alert:")
        && !state.alerts.some((entry) => subject === `volcano:alert:${entry.volcanoCode}`)) return null;
      if (subject.startsWith("volcano:eruption:")
        && !state.eruptions.some((entry) => subject === `volcano:eruption:${entry.volcanoCode}`)) return null;
    }
  }
  return { authoritative: true, state, active: structuredClone(active), gateEntries: entries };
}

function isFloodFoundationSubject(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  return entry.domain === "floodForecast"
    && entry.revisionFamily === "floodForecast"
    && entry.stateSubjectKey.startsWith("flood:event:")
    && entry.stateSubjectKey.length > "flood:event:".length;
}

function numericFloodSerial(serial: string | null): number | null {
  if (serial == null || !/^\d+$/u.test(serial)) return null;
  const numeric = Number(serial);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function floodGateHasValidSerial(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  const serial = entry.comparison.revision.serial;
  return serial.valid
    && serial.raw != null
    && serial.numeric != null
    && numericFloodSerial(serial.raw) === serial.numeric;
}

function floodProjectionWasAppliedThroughGate(
  event: PersistedFloodEventState,
  gate: PersistedTelegramRevisionGateEntryV2,
): boolean {
  const gateTimeMs = gate.comparison.revision.reportDateTime.epochMs;
  const gateSerial = gate.comparison.revision.serial;
  const applied = event.appliedRevision ?? event.revision;
  if (
    gateTimeMs == null
    || !gateSerial.valid
    || gateSerial.raw == null
    || gateSerial.numeric == null
    || applied.serial == null
    || event.revision.serial == null
  ) return false;
  const appliedSerial = numericFloodSerial(applied.serial);
  const contentSerial = numericFloodSerial(event.revision.serial);
  if (appliedSerial == null || contentSerial == null) return false;
  if (applied.reportTimeMs !== gateTimeMs || appliedSerial !== gateSerial.numeric) return false;
  const gateSemanticKey = gate.semanticKeys.at(-1);
  if (gateSemanticKey == null) return false;
  if (event.appliedSemanticKey != null) {
    if (event.appliedSemanticKey !== gateSemanticKey) return false;
  } else if (
    // pre-semantic-watermark v2: only a sole normal publication can be proven safe.
    // A correction history without an applied token is deliberately not trusted.
    gate.semanticKeys.length !== 1
    || !gateSemanticKey.startsWith("発表:")
  ) {
    return false;
  }
  return event.revision.reportTimeMs < applied.reportTimeMs
    || event.revision.reportTimeMs === applied.reportTimeMs && contentSerial <= appliedSerial;
}

function normalizeFloodFoundationForWrite(
  value: PersistedTelegramFoundationV2["floodForecast"],
): PersistedTelegramFoundationV2["floodForecast"] {
  if (!value.authoritative) return emptyFloodFoundation();
  const gateEntries = value.gateEntries
    .filter(isFloodFoundationSubject)
    .slice(-FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const gateByEventId = new Map(gateEntries.map((entry) => [
    entry.stateSubjectKey.slice("flood:event:".length),
    entry,
  ]));
  const activeGateByEventId = new Map(gateEntries.flatMap((entry) => {
    if (entry.cancelled) return [];
    return [[entry.stateSubjectKey.slice("flood:event:".length), entry] as const];
  }));
  const activeEventIds = new Set(value.active.map((event) => event.eventId));
  const legacyEventIds = [...new Set(value.legacyEventIds ?? [])]
    .filter((eventId) => activeEventIds.has(eventId) && !gateByEventId.has(eventId))
    .slice(-FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!);
  const legacyEvents = new Set(legacyEventIds);
  const active = value.active.flatMap((event) => {
    if (legacyEvents.has(event.eventId)) return [structuredClone(event)];
    const gate = activeGateByEventId.get(event.eventId);
    if (gate == null || !floodProjectionWasAppliedThroughGate(event, gate)) return [];
    return [structuredClone(event)];
  });
  return { authoritative: true, active, legacyEventIds, gateEntries };
}

function sanitizeFloodFoundation(
  value: unknown,
  salvage = true,
): PersistedTelegramFoundationV2["floodForecast"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.active)
    || !Array.isArray(value.gateEntries)
  ) return null;
  if (!value.authoritative) {
    return value.active.length === 0 && value.gateEntries.length === 0
      && (value.legacyEventIds == null
        || Array.isArray(value.legacyEventIds) && value.legacyEventIds.length === 0)
      ? emptyFloodFoundation()
      : null;
  }
  if (salvage) {
    const rawActive = value.active;
    const rawEntries = value.gateEntries;
    const rawLegacy = value.legacyEventIds;
    const active = rawActive.filter(isFloodEvent);
    const entries = rawEntries.filter((entry) =>
      isGateEntry(entry)
      && isFloodFoundationSubject(entry)
      && floodGateHasValidSerial(entry),
    ) as PersistedTelegramRevisionGateEntryV2[];
    const invalidEventIds = new Set<string>();
    const invalidEntryEventIds = new Set<string>();
    let unidentifiedEntryIndex = 0;
    for (const item of rawActive) {
      if (isRecord(item) && typeof item.eventId === "string" && !isFloodEvent(item)) {
        invalidEventIds.add(item.eventId);
        invalidEntryEventIds.add(item.eventId);
      } else if (!isFloodEvent(item)) {
        const synthetic = `unidentified:active:${unidentifiedEntryIndex++}`;
        invalidEventIds.add(synthetic);
        invalidEntryEventIds.add(synthetic);
      }
    }
    for (const item of rawEntries) {
      if (isRecord(item) && typeof item.stateSubjectKey === "string"
        && item.stateSubjectKey.startsWith("flood:event:")
        && (!isGateEntry(item) || !isFloodFoundationSubject(item) || !floodGateHasValidSerial(item))) {
        invalidEventIds.add(item.stateSubjectKey.slice("flood:event:".length));
        invalidEntryEventIds.add(item.stateSubjectKey.slice("flood:event:".length));
      } else if (!(isGateEntry(item) && isFloodFoundationSubject(item) && floodGateHasValidSerial(item))) {
        const synthetic = `unidentified:gate:${unidentifiedEntryIndex++}`;
        invalidEventIds.add(synthetic);
        invalidEntryEventIds.add(synthetic);
      }
    }
    const duplicateEventIds = new Set<string>();
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const eventId = entry.stateSubjectKey.slice("flood:event:".length);
      counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
    }
    for (const [eventId, count] of counts) if (count > 1) duplicateEventIds.add(eventId);
    const activeCounts = new Map<string, number>();
    for (const event of active) activeCounts.set(event.eventId, (activeCounts.get(event.eventId) ?? 0) + 1);
    for (const [eventId, count] of activeCounts) if (count > 1) duplicateEventIds.add(eventId);
    const legacyEventIds = Array.isArray(rawLegacy)
      ? rawLegacy.filter((eventId): eventId is string => typeof eventId === "string" && eventId !== "")
      : [];
    const legacyCounts = new Map<string, number>();
    for (const eventId of legacyEventIds) legacyCounts.set(eventId, (legacyCounts.get(eventId) ?? 0) + 1);
    for (const [eventId, count] of legacyCounts) if (count > 1) duplicateEventIds.add(eventId);
    if (rawLegacy != null && !Array.isArray(rawLegacy)) {
      recordRepair("foundation.floodForecast", "eventId", 1, active.length + entries.length, "invalid-container", true);
      return null;
    }
    for (const eventId of duplicateEventIds) invalidEventIds.add(eventId);
    const filteredActive = active.filter((event) => !invalidEventIds.has(event.eventId));
    const filteredEntries = entries.filter((entry) => {
      const eventId = entry.stateSubjectKey.slice("flood:event:".length);
      return !duplicateEventIds.has(eventId) && (entry.cancelled || !invalidEventIds.has(eventId));
    });
    const filteredLegacy = legacyEventIds.filter((eventId) =>
      !invalidEventIds.has(eventId) && filteredActive.some((event) => event.eventId === eventId)
        && !filteredEntries.some((entry) => entry.stateSubjectKey === `flood:event:${eventId}`));
    const maxSubjects = FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!;
    const boundedEntries = filteredEntries.slice(-maxSubjects);
    const boundedEntryIds = new Set(boundedEntries.map((entry) =>
      entry.stateSubjectKey.slice("flood:event:".length)));
    const boundedActive = filteredActive
      .filter((event) => boundedEntryIds.has(event.eventId) || filteredLegacy.includes(event.eventId))
      .slice(-maxSubjects * 2);
    const boundedLegacy = filteredLegacy.filter((eventId) =>
      boundedActive.some((event) => event.eventId === eventId)).slice(-maxSubjects);
    if (boundedEntries.length !== filteredEntries.length
      || boundedActive.length !== filteredActive.length
      || boundedLegacy.length !== filteredLegacy.length) {
      const retainedBundles = new Set([
        ...boundedEntries.map((entry) => entry.stateSubjectKey),
        ...boundedActive.map((event) => `flood:event:${event.eventId}`),
      ]);
      recordRepair("foundation.floodForecast", "eventId", 1, retainedBundles.size, "limit-exceeded");
    }
    const discardedBundles = new Set([...invalidEventIds, ...duplicateEventIds]);
    const retainedBundles = new Set([
      ...filteredActive.map((event) => event.eventId),
      ...filteredEntries.map((entry) => entry.stateSubjectKey.slice("flood:event:".length)),
      ...filteredLegacy,
    ]);
    const discarded = discardedBundles.size;
    if (discarded > 0) {
      recordRepair(
        "foundation.floodForecast",
        "eventId",
        discarded,
        retainedBundles.size,
        invalidEntryEventIds.size > 0 ? "invalid-entry" : "duplicate-subject",
      );
    }
    return sanitizeFloodFoundation({
      ...value,
      active: boundedActive,
      gateEntries: boundedEntries,
      legacyEventIds: boundedLegacy,
    }, false);
  }
  if (!value.active.every(isFloodEvent)) return null;
  if (value.legacyEventIds != null && (
    !Array.isArray(value.legacyEventIds)
    || !value.legacyEventIds.every((eventId) => typeof eventId === "string" && eventId !== "")
  )) return null;
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && isFloodFoundationSubject(entry)
    && floodGateHasValidSerial(entry))) {
    return null;
  }
  const gateEntries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    tombstoneRetentionMs: entry.tombstoneRetentionMs
      ?? FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  }));
  if (gateEntries.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (new Set(gateEntries.map((entry) => entry.stateSubjectKey)).size !== gateEntries.length) return null;
  const gateByEventId = new Map(gateEntries.map((entry) => [
    entry.stateSubjectKey.slice("flood:event:".length),
    entry,
  ]));
  const active = value.active as PersistedFloodEventState[];
  if (active.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects! * 2) return null;
  if (new Set(active.map((event) => event.eventId)).size !== active.length) return null;
  const legacyEventIds = [...new Set((value.legacyEventIds ?? []) as string[])];
  if (legacyEventIds.length !== (value.legacyEventIds ?? []).length) return null;
  if (legacyEventIds.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const activeEventIds = new Set(active.map((event) => event.eventId));
  if (legacyEventIds.some((eventId) => !activeEventIds.has(eventId) || gateByEventId.has(eventId))) {
    return null;
  }
  const legacyEvents = new Set(legacyEventIds);
  const salvagedActive = active.filter((event) => {
    if (legacyEvents.has(event.eventId)) return true;
    const gate = gateByEventId.get(event.eventId);
    return gate != null
      && !gate.cancelled
      && floodProjectionWasAppliedThroughGate(event, gate);
  });
  if (salvagedActive.length !== active.length) {
    recordRepair("foundation.floodForecast", "eventId", active.length - salvagedActive.length, salvagedActive.length, "coupling-mismatch");
  }
  return {
    authoritative: true,
    active: structuredClone(salvagedActive),
    legacyEventIds,
    gateEntries,
  };
}

function sanitizeFoundation(value: unknown): PersistedTelegramFoundationV2 | null {
  if (!isRecord(value)) return null;
  const validatedVpws50 = sanitizeVpws50Foundation(value.vpws50);
  const vpws50 = validatedVpws50 ?? emptyVpws50Foundation();
  if (validatedVpws50 == null) {
    recordRepair("foundation.vpws50", "singleton", 1, 0, "invalid-entry", true);
  }
  const validatedVpww56 = value.vpww56 == null
    ? emptyVpww56Foundation()
    : sanitizeVpww56Foundation(value.vpww56);
  const vpww56 = validatedVpww56 ?? emptyVpww56Foundation();
  if (validatedVpww56 == null) {
    recordRepair("foundation.vpww56", "subject", 1, 0, "invalid-entry", true);
  }
  const validatedTsunami = value.tsunami == null
    ? emptyTsunamiFoundation()
    : sanitizeTsunamiFoundation(value.tsunami);
  const tsunami = validatedTsunami ?? emptyTsunamiFoundation();
  if (validatedTsunami == null) {
    recordRepair("foundation.tsunami", "eventId", 1, 0, "invalid-entry", true);
  }
  const validatedVolcano = value.volcano == null
    ? emptyVolcanoFoundation()
    : sanitizeVolcanoFoundation(value.volcano);
  const volcano = validatedVolcano ?? emptyVolcanoFoundation();
  if (validatedVolcano == null) {
    recordRepair("foundation.volcano", "code", 1, 0, "invalid-entry", true);
  }
  const validatedFlood = value.floodForecast == null
    ? emptyFloodFoundation()
    : sanitizeFloodFoundation(value.floodForecast);
  const floodForecast = validatedFlood ?? emptyFloodFoundation();
  if (validatedFlood == null) {
    recordRepair("foundation.floodForecast", "eventId", 1, 0, "invalid-entry", true);
  }
  const validatedStandbyDomains = value.standbyDomains == null
    ? emptyStandbyDomainsFoundation()
    : sanitizeStandbyDomainsFoundation(value.standbyDomains);
  const standbyDomains = validatedStandbyDomains ?? emptyStandbyDomainsFoundation();
  if (validatedStandbyDomains == null) {
    recordRepair("foundation.standbyDomains", "subject", 1, 0, "invalid-entry", true);
  }
  return { vpws50, vpww56, tsunami, volcano, floodForecast, standbyDomains };
}

function baseV1FromRecord(value: Record<string, unknown>): PersistedStandbyStateV1 | null {
  return sanitizePersistedStandbyStateV1({ ...value, version: 1 });
}

function standbyProjectionMatchesGate(
  revision: StandbyRevision,
  appliedSemanticKey: string | undefined,
  gate: PersistedTelegramRevisionGateEntryV2 | undefined,
): boolean {
  if (gate == null || gate.cancelled) return false;
  // tokenless projection is legacy only when no authoritative gate exists.
  // Once a gate exists, an application token is required to prove that the
  // projection was produced after that exact accepted payload.
  if (appliedSemanticKey == null) return false;
  return gate.comparison.revision.reportDateTime.epochMs === revision.reportTimeMs
    && gate.comparison.revision.serial.raw === revision.serial
    && gate.semanticKeys.at(-1) === appliedSemanticKey;
}

/** VPTA projection + gate を EventID bundle として coupling 後にだけ 256 件へ絞る。 */
function normalizeVptaPersistenceBundles(
  base: PersistedStandbyStateV1,
  foundation: PersistedTelegramFoundationV2["standbyDomains"],
): {
  base: PersistedStandbyStateV1;
  foundation: PersistedTelegramFoundationV2["standbyDomains"];
} {
  const vptaGates = foundation.gateEntries.filter((entry) =>
    entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50");
  const otherGates = foundation.gateEntries.filter((entry) =>
    entry.domain !== "typhoonProbability" || entry.revisionFamily !== "VPTA50");
  const vptaEventIds = new Set<string>();
  for (const gate of vptaGates) {
    const eventId = vptaEventIdFromSubject(gate.stateSubjectKey);
    if (eventId != null) vptaEventIds.add(eventId);
  }
  for (const projection of base.typhoonProbabilities ?? []) vptaEventIds.add(projection.key);
  const cleanBase = stripVptaRollbackSeen(base, vptaEventIds);
  const projections = cleanBase.typhoonProbabilities ?? [];
  const bundleSubjects = new Set([
    ...vptaGates.map((entry) => entry.stateSubjectKey),
    ...projections.map((projection) => `typhoonProbability:${projection.key}`),
  ]);
  if (bundleSubjects.size > TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES) {
    recordRepair(
      "foundation.standbyDomains", "subject", bundleSubjects.size, 0, "limit-exceeded", true,
    );
    const { typhoonProbabilities: _probabilities, ...withoutProbabilities } = cleanBase;
    return { base: withoutProbabilities, foundation: { gateEntries: otherGates } };
  }

  const projectionBySubject = new Map(projections.map((projection) =>
    [`typhoonProbability:${projection.key}`, projection]));
  const bundles = vptaGates.map((gate) => {
    const projection = projectionBySubject.get(gate.stateSubjectKey);
    const coupled = projection != null && !gate.cancelled
      && standbyProjectionMatchesGate(
        projection.revision,
        projection.appliedSemanticKey,
        gate,
      );
    return {
      stateSubjectKey: gate.stateSubjectKey,
      acceptedAtMs: gate.acceptedAtMs,
      class: gate.cancelled ? "GT" as const : coupled ? "P+G" as const : "GA" as const,
      coupled,
    };
  });
  const selection = selectVptaCapacityBundles(bundles, TYPHOON_PROBABILITY_MAX_SUBJECTS);
  if (selection.kind === "protectedOverflow") {
    recordRepair(
      "foundation.standbyDomains", "subject", bundles.length, 0, "limit-exceeded", true,
    );
    const { typhoonProbabilities: _probabilities, ...withoutProbabilities } = cleanBase;
    return { base: withoutProbabilities, foundation: { gateEntries: otherGates } };
  }
  const retainedSubjects = new Set(selection.retained.map((bundle) => bundle.stateSubjectKey));
  const coupledSubjects = new Set(bundles
    .filter((bundle) => bundle.coupled && retainedSubjects.has(bundle.stateSubjectKey))
    .map((bundle) => bundle.stateSubjectKey));
  const retainedGates = vptaGates.filter((gate) => retainedSubjects.has(gate.stateSubjectKey));
  const retainedProjections = projections.filter((projection) =>
    coupledSubjects.has(`typhoonProbability:${projection.key}`));
  const discarded = vptaGates.length - retainedGates.length
    + projections.length - retainedProjections.length;
  if (discarded > 0) {
    if (projections.length > bundles.filter((bundle) => bundle.coupled).length) {
      warnVptaPersistenceDiagnostic("vpta50PersistenceCouplingMismatch");
    }
    recordRepair(
      "foundation.standbyDomains", "subject", discarded,
      retainedGates.length + retainedProjections.length,
      selection.discarded.length > 0 ? "limit-exceeded" : "coupling-mismatch",
    );
  }
  const { typhoonProbabilities: _probabilities, ...withoutProbabilities } = cleanBase;
  return {
    base: {
      ...withoutProbabilities,
      ...(retainedProjections.length === 0 ? {} : { typhoonProbabilities: retainedProjections }),
    },
    foundation: {
      gateEntries: [...otherGates, ...retainedGates.sort((left, right) =>
        left.stateSubjectKey < right.stateSubjectKey ? -1
          : left.stateSubjectKey > right.stateSubjectKey ? 1 : 0)],
    },
  };
}

function salvageStandbyDomainProjections(
  base: PersistedStandbyStateV1,
  foundation: PersistedTelegramFoundationV2["standbyDomains"],
): PersistedStandbyStateV1 {
  const gates = new Map(foundation.gateEntries.map((entry) => [entry.stateSubjectKey, entry]));
  const keep = (subject: string, revision: StandbyRevision, semanticKey?: string) => {
    const gate = gates.get(subject);
    return gate == null
      ? semanticKey == null
      : standbyProjectionMatchesGate(revision, semanticKey, gate);
  };
  const { typhoonProbabilities, ...baseWithoutProbabilities } = base;
  const salvaged: PersistedStandbyStateV1 = {
    ...baseWithoutProbabilities,
    heat: base.heat.filter((state) => keep(state.key, state.revision, state.appliedSemanticKey)),
    typhoons: base.typhoons.filter((state) => keep(`typhoon:${state.key}`, state.revision, state.appliedSemanticKey)),
    ...(() => {
      const retained = typhoonProbabilities?.filter((state) => keep(
        `typhoonProbability:${state.key}`,
        state.revision,
        state.appliedSemanticKey,
      ));
      return retained == null || retained.length === 0 ? {} : { typhoonProbabilities: retained };
    })(),
    tornado: base.tornado?.filter((state) => keep(
      `tornado:${state.publishingOffice}`,
      state.revision,
      state.appliedSemanticKey,
    )),
    longPeriod: base.longPeriod?.filter((state) => keep(
      `longPeriod:${state.eventId}`,
      state.revision,
      state.appliedSemanticKey,
    )),
    nankaiTrough: base.nankaiTrough != null && keep(
      "nankai:current",
      base.nankaiTrough.revision,
      base.nankaiTrough.appliedSemanticKey,
    ) ? base.nankaiTrough : null,
  };
  const discarded = base.heat.length - salvaged.heat.length
    + base.typhoons.length - salvaged.typhoons.length
    + (base.typhoonProbabilities?.length ?? 0) - (salvaged.typhoonProbabilities?.length ?? 0)
    + (base.tornado?.length ?? 0) - (salvaged.tornado?.length ?? 0)
    + (base.longPeriod?.length ?? 0) - (salvaged.longPeriod?.length ?? 0)
    + Number(base.nankaiTrough != null && salvaged.nankaiTrough == null);
  if (discarded > 0) recordRepair("foundation.standbyDomains", "subject", discarded, 0, "coupling-mismatch");
  return salvaged;
}

function nankaiMigrationSemanticKey(state: PersistedNankaiStateV1): string {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    sourceEventId: state.sourceEventId,
    statusCode: state.statusCode,
    revision: state.revision,
  })).digest("hex");
  return `発表:${fingerprint}`;
}

function migratedNankaiStandbyState(
  base: PersistedStandbyStateV1,
  foundation: PersistedTelegramFoundationV2["standbyDomains"],
): {
  base: PersistedStandbyStateV1;
  foundation: PersistedTelegramFoundationV2["standbyDomains"];
} {
  const projection = base.nankaiTrough;
  if (projection == null || projection.sourceEventId.trim() === "") return { base, foundation };
  const gateEntries = foundation.gateEntries.map((entry) => structuredClone(entry));
  const gateIndex = gateEntries.findIndex((entry) =>
    entry.domain === "nankaiTrough"
    && entry.revisionFamily === "nankaiTrough"
    && entry.stateSubjectKey === "nankai:current");
  const existing = gateIndex < 0 ? null : gateEntries[gateIndex];
  if (existing?.cancelled === true) return { base, foundation };
  const revisionMatches = existing != null
    && existing.comparison.revision.reportDateTime.epochMs === projection.revision.reportTimeMs
    && existing.comparison.revision.serial.raw === projection.revision.serial;
  if (existing != null && !revisionMatches) return { base, foundation };

  const existingSemanticKey = existing?.semanticKeys.at(-1);
  if (
    projection.appliedSemanticKey != null
    && existing != null
    && existingSemanticKey !== projection.appliedSemanticKey
  ) return { base, foundation };
  const semanticKey = projection.appliedSemanticKey
    ?? existingSemanticKey
    ?? nankaiMigrationSemanticKey(projection);
  const migratedProjection = projection.appliedSemanticKey === semanticKey
    ? projection
    : { ...projection, appliedSemanticKey: semanticKey };

  if (existing != null) {
    gateEntries[gateIndex] = {
      ...existing,
      semanticKeys: existing.semanticKeys.length === 0 ? [semanticKey] : existing.semanticKeys,
      legacyRevisionKey: projection.sourceEventId,
      legacyRevisionKeyProvenance: "eventId",
    };
  } else {
    const reportDateTime = new Date(projection.revision.reportTimeMs).toISOString();
    const serialRaw = projection.revision.serial;
    const serialNumeric = serialRaw != null && /^\d+$/.test(serialRaw) ? Number(serialRaw) : null;
    const savedAtMs = Date.parse(base.savedAt);
    gateEntries.push({
      domain: "nankaiTrough",
      revisionFamily: "nankaiTrough",
      stateSubjectKey: "nankai:current",
      comparison: {
        stateSubjectKey: "nankai:current",
        revision: {
          eventId: { raw: "nankai:current", value: "nankai:current", valid: true },
          type: { raw: "nankaiTrough", value: "nankaiTrough", valid: true },
          reportDateTime: {
            raw: reportDateTime,
            epochMs: projection.revision.reportTimeMs,
            valid: true,
          },
          serial: {
            raw: serialRaw,
            numeric: serialNumeric,
            valid: serialNumeric != null,
          },
          infoType: { raw: "発表", value: "発表", valid: true },
        },
      },
      semanticKeys: [semanticKey],
      cancelled: false,
      acceptedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : projection.revision.reportTimeMs,
      tombstoneRetentionMs: NANKAI_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
      legacyRevisionKey: projection.sourceEventId,
      legacyRevisionKeyProvenance: "eventId",
    });
  }
  return {
    base: { ...base, nankaiTrough: migratedProjection },
    foundation: { gateEntries },
  };
}

interface LegacyStandbyGateProjection {
  domain: "tornado" | "heatAlert" | "typhoonAnalysis" | "lgObservation";
  revisionFamily: "tornado" | "VPFT50" | "typhoonAnalysis" | "VXSE62";
  stateSubjectKey: string;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
}

function legacyStandbyGateInfoType(
  semanticKey: string,
): "発表" | "訂正" | "取消" | null {
  const separator = semanticKey.indexOf(":");
  const value = separator < 0 ? "" : semanticKey.slice(0, separator);
  return value === "発表" || value === "訂正" || value === "取消" ? value : null;
}

/**
 * standalone v1 は gate 本体を持たないが、active projection の application token と
 * rollback 用 seen から、同一 revision の受理済み gate だけは損失なく復元できる。
 * identity/revision が重複・不一致なら推測せず、従来どおり legacy projection に留める。
 */
function migratedLegacyStandbyGateEntries(
  base: PersistedStandbyStateV1,
): PersistedTelegramRevisionGateEntryV2[] {
  const projections: LegacyStandbyGateProjection[] = [
    ...base.heat.map((state) => ({
      domain: "heatAlert" as const,
      revisionFamily: "VPFT50" as const,
      stateSubjectKey: state.key,
      revision: state.revision,
      appliedSemanticKey: state.appliedSemanticKey,
    })),
    ...base.typhoons.map((state) => ({
      domain: "typhoonAnalysis" as const,
      revisionFamily: "typhoonAnalysis" as const,
      stateSubjectKey: `typhoon:${state.key}`,
      revision: state.revision,
      appliedSemanticKey: state.appliedSemanticKey,
    })),
    ...(base.tornado ?? []).map((state) => ({
      domain: "tornado" as const,
      revisionFamily: "tornado" as const,
      stateSubjectKey: `tornado:${state.publishingOffice}`,
      revision: state.revision,
      appliedSemanticKey: state.appliedSemanticKey,
    })),
    ...(base.longPeriod ?? []).map((state) => ({
      domain: "lgObservation" as const,
      revisionFamily: "VXSE62" as const,
      stateSubjectKey: `longPeriod:${state.eventId}`,
      revision: state.revision,
      appliedSemanticKey: state.appliedSemanticKey,
    })),
  ];
  const projectionCounts = new Map<string, number>();
  for (const projection of projections) {
    projectionCounts.set(
      projection.stateSubjectKey,
      (projectionCounts.get(projection.stateSubjectKey) ?? 0) + 1,
    );
  }
  const seenByKey = new Map<string, PersistedSeenEntry | null>();
  for (const seen of base.seen) {
    seenByKey.set(seen.key, seenByKey.has(seen.key) ? null : seen);
  }
  return projections.flatMap((projection) => {
    const semanticKey = projection.appliedSemanticKey;
    const infoType = semanticKey == null ? null : legacyStandbyGateInfoType(semanticKey);
    const seen = seenByKey.get(projection.stateSubjectKey);
    const policy = STANDBY_FOUNDATION_POLICIES.find((candidate) =>
      candidate.domain === projection.domain
      && candidate.revisionFamily === projection.revisionFamily);
    const retentionMs = policy?.tombstoneRetentionMs;
    if (
      projectionCounts.get(projection.stateSubjectKey) !== 1
      || semanticKey == null
      || infoType == null
      || seen == null
      || seen.revision.reportTimeMs !== projection.revision.reportTimeMs
      || seen.revision.serial !== projection.revision.serial
      || retentionMs == null
    ) return [];
    const reportDate = new Date(projection.revision.reportTimeMs);
    if (!Number.isFinite(reportDate.getTime())) return [];
    const reportDateTime = reportDate.toISOString();
    const serial = parseTelegramSerial(projection.revision.serial);
    const gate: PersistedTelegramRevisionGateEntryV2 = {
      domain: projection.domain,
      revisionFamily: projection.revisionFamily,
      stateSubjectKey: projection.stateSubjectKey,
      comparison: {
        stateSubjectKey: projection.stateSubjectKey,
        revision: {
          eventId: {
            raw: projection.stateSubjectKey,
            value: projection.stateSubjectKey,
            valid: true,
          },
          type: {
            raw: projection.revisionFamily,
            value: projection.revisionFamily,
            valid: true,
          },
          reportDateTime: {
            raw: reportDateTime,
            epochMs: projection.revision.reportTimeMs,
            valid: true,
          },
          serial,
          infoType: { raw: infoType, value: infoType, valid: true },
        },
      },
      semanticKeys: [semanticKey],
      cancelled: false,
      acceptedAtMs: seen.forgetAtMs - retentionMs - 1,
      tombstoneRetentionMs: retentionMs,
      legacyRevisionKey: projection.stateSubjectKey,
    };
    return isGateEntry(gate) ? [gate] : [];
  });
}

function sanitizePersistedStandbyStateV2(value: unknown): PersistedStandbyStateV2 | null {
  if (!isRecord(value) || value.version !== 2) return null;
  const base = baseV1FromRecord(value);
  const sanitizedFoundation = sanitizeFoundation(value.telegramFoundation);
  if (base == null || sanitizedFoundation == null) return null;
  const rawVptaHardLimit = vptaRawDomainExceedsHardLimit(value);
  if (rawVptaHardLimit) {
    recordRepair(
      "foundation.standbyDomains", "subject",
      TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES + 1, 0,
      "limit-exceeded", true,
    );
  }
  const hardLimitEventIds = collectRawVptaEventIds(value);
  for (const entry of sanitizedFoundation.standbyDomains.gateEntries) {
    if (entry.domain !== "typhoonProbability" || entry.revisionFamily !== "VPTA50") continue;
    const eventId = vptaEventIdFromSubject(entry.stateSubjectKey);
    if (eventId != null) hardLimitEventIds.add(eventId);
  }
  const telegramFoundation = rawVptaHardLimit
    ? {
        ...sanitizedFoundation,
        standbyDomains: {
          gateEntries: sanitizedFoundation.standbyDomains.gateEntries.filter((entry) =>
            entry.domain !== "typhoonProbability" || entry.revisionFamily !== "VPTA50"),
        },
      }
    : sanitizedFoundation;
  const boundedBase = rawVptaHardLimit ? removeVptaRootDomain(base, hardLimitEventIds) : base;
  // 官署 provenance のない旧 VPWW56 union は subject 単位の復元待ちへ変換できない。
  // 非 authoritative foundation と併存する名称-only 表示は、旧粒度を固着させず破棄する。
  const withoutLegacyVpww56 = telegramFoundation.vpww56.authoritative
    ? boundedBase
    : {
        ...boundedBase,
        weatherAlerts: boundedBase.weatherAlerts?.filter((entry) => entry.source !== "vpww56"),
      };
  // volcano foundation は code bundle が真実源である。foundation 側で code を落としたら、
  // rollback 用 root projection だけを残して次回保存で復活させてはならない。
  const acceptedVolcanoCodes = new Set([
    ...telegramFoundation.volcano.active.map((entry) => entry.code),
    ...(telegramFoundation.volcano.state?.alerts.map((entry) => entry.volcanoCode) ?? []),
    ...(telegramFoundation.volcano.state?.eruptions.map((entry) => entry.volcanoCode) ?? []),
  ]);
  const foundationSynchronized = telegramFoundation.volcano.authoritative
    ? {
        ...withoutLegacyVpww56,
        volcanoes: withoutLegacyVpww56.volcanoes.filter((entry) => acceptedVolcanoCodes.has(entry.code)),
      }
    : withoutLegacyVpww56;
  const vptaNormalized = normalizeVptaPersistenceBundles(
    foundationSynchronized,
    telegramFoundation.standbyDomains,
  );
  const migratedNankai = migratedNankaiStandbyState(
    vptaNormalized.base,
    vptaNormalized.foundation,
  );
  const salvaged = salvageStandbyDomainProjections(migratedNankai.base, migratedNankai.foundation);
  return {
    ...salvaged,
    version: 2,
    telegramFoundation: { ...telegramFoundation, standbyDomains: migratedNankai.foundation },
  };
}

function migratedVpws50GateEntries(base: PersistedStandbyStateV1): PersistedTelegramRevisionGateEntryV2[] {
  const state = base.weatherAlerts?.find((entry) => entry.source === "vpws50");
  if (state == null || state.alerts.length === 0) return [];
  const reportDateTimes = new Set(state.alerts.map((alert) => alert.updatedAt));
  if (reportDateTimes.size !== 1) return [];
  const reportDateTime = [...reportDateTimes][0];
  const epochMs = Date.parse(reportDateTime);
  const savedAtMs = Date.parse(base.savedAt);
  if (!Number.isFinite(epochMs) || !Number.isFinite(savedAtMs) || epochMs !== state.revision.reportTimeMs) return [];
  if (epochMs > savedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS) return [];
  const serialRaw = state.revision.serial;
  const serialMissing = serialRaw == null || serialRaw === "";
  const serialNumeric = !serialMissing && serialRaw != null && /^\d+$/.test(serialRaw)
    ? Number(serialRaw)
    : null;
  if (!serialMissing && (!Number.isSafeInteger(serialNumeric) || serialNumeric == null)) return [];
  return [{
    domain: "weather",
    revisionFamily: "VPWS50",
    stateSubjectKey: "weather:vpws50",
    comparison: {
      stateSubjectKey: "weather:vpws50",
      revision: {
        eventId: { raw: "weather:vpws50", value: "weather:vpws50", valid: true },
        type: { raw: "VPWS50", value: "VPWS50", valid: true },
        reportDateTime: { raw: reportDateTime, epochMs, valid: true },
        serial: {
          raw: serialRaw,
          numeric: serialMissing ? null : serialNumeric,
          valid: !serialMissing && serialNumeric != null,
        },
        infoType: { raw: "発表", value: "発表", valid: true },
      },
    },
    semanticKeys: [],
    cancelled: false,
    acceptedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : epochMs,
  }];
}

function migratedVptaGateEntries(
  base: PersistedStandbyStateV1,
  allowUnprefixedSeen: boolean,
  blockedSeenOnlySubjects: ReadonlySet<string>,
): PersistedTelegramRevisionGateEntryV2[] {
  const retentionMs = 7 * 24 * 60 * 60_000;
  const seenGroups = new Map<string, PersistedSeenEntry[]>();
  for (const seen of base.seen) {
    const items = seenGroups.get(seen.key) ?? [];
    items.push(seen); seenGroups.set(seen.key, items);
  }
  const uniqueSeen = (subject: string): PersistedSeenEntry | null => {
    const eventId = subject.slice("typhoonProbability:".length);
    const candidates = [
      ...(seenGroups.get(eventId) ?? []),
      ...(seenGroups.get(subject) ?? []),
    ];
    return candidates.length === 1 ? candidates[0]! : null;
  };
  if (base.typhoonProbabilityGateMetadata != null) {
    const migrated = base.typhoonProbabilityGateMetadata.flatMap((metadata) => {
      const seen = uniqueSeen(metadata.stateSubjectKey);
      if (seen == null) return [];
      const metadataSerial = normalizeVpta50Serial(metadata.comparison.revision.serial.raw);
      const seenSerial = normalizeVpta50Serial(seen.revision.serial);
      if (metadataSerial.kind === "invalid" || seenSerial.kind === "invalid") return [];
      const rawMetadataSerial = metadata.comparison.revision.serial;
      if (metadataSerial.kind === "missing"
        ? rawMetadataSerial.raw !== null
          || rawMetadataSerial.numeric !== null
          || rawMetadataSerial.valid !== false
        : rawMetadataSerial.numeric !== metadataSerial.numeric
          || rawMetadataSerial.valid !== true) return [];
      const canonicalMetadataSerial = metadataSerial.kind === "missing" ? null : metadataSerial.canonicalRaw;
      const canonicalSeenSerial = seenSerial.kind === "missing" ? null : seenSerial.canonicalRaw;
      const reportTimeMs = metadata.comparison.revision.reportDateTime.epochMs;
      if (reportTimeMs == null
        || seen.revision.reportTimeMs !== reportTimeMs
        || canonicalSeenSerial !== canonicalMetadataSerial) return [];
      const eventId = metadata.stateSubjectKey.slice("typhoonProbability:".length);
      const comparison = structuredClone(metadata.comparison);
      comparison.revision.serial = metadataSerial.kind === "missing"
        ? { raw: null, numeric: null, valid: false }
        : { raw: metadataSerial.canonicalRaw, numeric: metadataSerial.numeric, valid: true };
      const gate: PersistedTelegramRevisionGateEntryV2 = {
        domain: "typhoonProbability",
        revisionFamily: "VPTA50",
        stateSubjectKey: metadata.stateSubjectKey,
        comparison,
        semanticKeys: [...metadata.semanticKeys],
        cancelled: metadata.cancelled,
        acceptedAtMs: seen.forgetAtMs - retentionMs - 1,
        tombstoneRetentionMs: retentionMs,
        legacyRevisionKey: eventId,
        legacyRevisionKeyProvenance: "eventId",
      };
      return isGateEntry(gate) ? [gate] : [];
    });
    if (migrated.length !== base.typhoonProbabilityGateMetadata.length) {
      warnVptaPersistenceDiagnostic("vpta50V1RevisionReconstructionFailed");
    }
    return migrated;
  }
  const activeGates = (base.typhoonProbabilities ?? []).flatMap((projection) => {
    const subject = `typhoonProbability:${projection.key}`;
    const seen = uniqueSeen(subject);
    const projectionSerial = normalizeVpta50Serial(projection.revision.serial);
    const seenSerial = seen == null ? null : normalizeVpta50Serial(seen.revision.serial);
    if (seen == null
      || projectionSerial.kind === "invalid"
      || seenSerial == null || seenSerial.kind === "invalid"
      || seen.revision.reportTimeMs !== projection.revision.reportTimeMs
      || (seenSerial.kind === "missing" ? null : seenSerial.canonicalRaw)
        !== (projectionSerial.kind === "missing" ? null : projectionSerial.canonicalRaw)) return [];
    const semanticKey = projection.appliedSemanticKey;
    const infoType = /^(発表|訂正):[0-9a-f]{64}$/u.test(semanticKey)
      ? semanticKey.slice(0, semanticKey.indexOf(":")) as "発表" | "訂正"
      : null;
    // Reserved empty-key GT is available only to a genuinely missing legacy
    // application key. A present but non-canonical key cannot prove InfoType and
    // must not be reinterpreted as a cancellation watermark.
    if (infoType == null) return [];
    const serial = projectionSerial.kind === "missing"
      ? { raw: null, numeric: null, valid: false }
      : { raw: projectionSerial.canonicalRaw, numeric: projectionSerial.numeric, valid: true };
    const reportDateTime = new Date(projection.revision.reportTimeMs).toISOString();
    const gate: PersistedTelegramRevisionGateEntryV2 = {
      domain: "typhoonProbability",
      revisionFamily: "VPTA50",
      stateSubjectKey: subject,
      comparison: {
        stateSubjectKey: subject,
        revision: {
          eventId: { raw: projection.key, value: projection.key, valid: true },
          type: { raw: "VPTA50", value: "VPTA50", valid: true },
          reportDateTime: {
            raw: reportDateTime,
            epochMs: projection.revision.reportTimeMs,
            valid: true,
          },
          serial,
          infoType: { raw: infoType, value: infoType, valid: true },
        },
      },
      semanticKeys: [semanticKey],
      cancelled: false,
      acceptedAtMs: seen.forgetAtMs - retentionMs - 1,
      tombstoneRetentionMs: retentionMs,
      legacyRevisionKey: projection.key,
      legacyRevisionKeyProvenance: "eventId",
    };
    return isGateEntry(gate) ? [gate] : [];
  });
  const activeSubjects = new Set(activeGates.map((gate) => gate.stateSubjectKey));
  const claimedLegacyKeys = new Set<string>([
    ...base.heat.map((state) => state.key),
    ...base.typhoons.map((state) => `typhoon:${state.key}`),
    ...(base.tornado ?? []).map((state) => `tornado:${state.publishingOffice}`),
    ...(base.longPeriod ?? []).map((state) => `longPeriod:${state.eventId}`),
    ...(base.nankaiTrough == null ? [] : ["nankai:current"]),
  ]);
  const normalizedSeenOnlyGroups = new Map<string, PersistedSeenEntry[]>();
  for (const [key, entries] of seenGroups) {
    if (claimedLegacyKeys.has(key)) continue;
    const eventId = key.startsWith("typhoonProbability:")
      ? key.slice("typhoonProbability:".length)
      : allowUnprefixedSeen ? key : "";
    if (validateTyphoonProbabilityEventId(eventId) !== eventId) continue;
    const subject = `typhoonProbability:${eventId}`;
    const candidates = normalizedSeenOnlyGroups.get(subject) ?? [];
    candidates.push(...entries);
    normalizedSeenOnlyGroups.set(subject, candidates);
  }
  const seenOnlyGates = [...normalizedSeenOnlyGroups].flatMap(([subject, entries]) => {
    if (entries.length !== 1
      || activeSubjects.has(subject)
      || blockedSeenOnlySubjects.has(subject)) return [];
    const eventId = subject.slice("typhoonProbability:".length);
    const seen = entries[0]!;
    const serial = normalizeVpta50Serial(seen.revision.serial);
    if (serial.kind === "invalid" || !validPersistenceEpoch(seen.revision.reportTimeMs)) return [];
    const reportDateTime = new Date(seen.revision.reportTimeMs).toISOString();
    const gate: PersistedTelegramRevisionGateEntryV2 = {
      domain: "typhoonProbability",
      revisionFamily: "VPTA50",
      stateSubjectKey: subject,
      comparison: {
        stateSubjectKey: subject,
        revision: {
          eventId: { raw: eventId, value: eventId, valid: true },
          type: { raw: "VPTA50", value: "VPTA50", valid: true },
          reportDateTime: { raw: reportDateTime, epochMs: seen.revision.reportTimeMs, valid: true },
          serial: serial.kind === "missing"
            ? { raw: null, numeric: null, valid: false }
            : { raw: serial.canonicalRaw, numeric: serial.numeric, valid: true },
          infoType: { raw: "取消", value: "取消", valid: true },
        },
      },
      semanticKeys: [],
      cancelled: true,
      acceptedAtMs: seen.forgetAtMs - retentionMs - 1,
      tombstoneRetentionMs: retentionMs,
      legacyRevisionKey: eventId,
      legacyRevisionKeyProvenance: "eventId",
    };
    return isGateEntry(gate) ? [gate] : [];
  });
  const migrated = [...activeGates, ...seenOnlyGates];
  const rawVptaSeenCount = normalizedSeenOnlyGroups.size;
  if (activeGates.length < (base.typhoonProbabilities?.length ?? 0)
    || migrated.length < rawVptaSeenCount) {
    warnVptaPersistenceDiagnostic("vpta50V1RevisionReconstructionFailed");
  }
  return migrated;
}

function invalidLegacyVptaProjectionSubjects(value: Record<string, unknown>): Set<string> {
  const blocked = new Set<string>();
  if (!Array.isArray(value.typhoonProbabilities)
    || value.typhoonProbabilities.length > TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS) return blocked;
  const counts = new Map<string, number>();
  for (const item of value.typhoonProbabilities) {
    if (!isRecord(item) || typeof item.key !== "string"
      || validateTyphoonProbabilityEventId(item.key) !== item.key) continue;
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  }
  const placeholderSemanticKey = `発表:${"0".repeat(64)}`;
  for (const item of value.typhoonProbabilities) {
    if (!isRecord(item) || typeof item.key !== "string"
      || validateTyphoonProbabilityEventId(item.key) !== item.key) continue;
    const subject = `typhoonProbability:${item.key}`;
    if ((counts.get(item.key) ?? 0) > 1) {
      blocked.add(subject);
      continue;
    }
    if (Object.hasOwn(item, "appliedSemanticKey")) {
      if (sanitizeTyphoonProbabilityState(item) == null
        || typeof item.appliedSemanticKey !== "string"
        || !/^(発表|訂正):[0-9a-f]{64}$/u.test(item.appliedSemanticKey)) {
        blocked.add(subject);
      }
      continue;
    }
    if (sanitizeTyphoonProbabilityState({
      ...item,
      appliedSemanticKey: placeholderSemanticKey,
    }) == null) blocked.add(subject);
  }
  return blocked;
}

function stripVptaSeenOnlySubjects(
  base: PersistedStandbyStateV1,
  subjects: ReadonlySet<string>,
): PersistedStandbyStateV1 {
  if (subjects.size === 0) return base;
  const seen = base.seen.filter((entry) => {
    const subject = entry.key.startsWith("typhoonProbability:")
      ? entry.key
      : `typhoonProbability:${entry.key}`;
    return !subjects.has(subject);
  });
  return seen.length === base.seen.length ? base : { ...base, seen };
}

function migratePersistedStandbyStateV1(value: unknown): PersistedStandbyStateV2 | null {
  if (!isRecord(value)) return null;
  const metadataMode = optionalArrayMode(value, "typhoonProbabilityGateMetadata");
  const hardLimit = vptaRawDomainExceedsHardLimit(value);
  if (hardLimit) {
    recordRepair(
      "foundation.standbyDomains", "subject",
      TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES + 1, 0,
      "limit-exceeded", true,
    );
  }
  const rawEventIds = collectRawVptaEventIds(value);
  const blockedSeenOnlySubjects = metadataMode === "absent"
    ? invalidLegacyVptaProjectionSubjects(value)
    : new Set<string>();
  const allowUnprefixedSeen = Array.isArray(value.typhoonProbabilities);
  const base = sanitizePersistedStandbyStateV1(value);
  if (base == null) return null;
  const boundedMigrationBase = hardLimit || metadataMode === "present-invalid"
    ? removeVptaRootDomain(base, rawEventIds)
    : base;
  const migrationBase = stripVptaSeenOnlySubjects(
    boundedMigrationBase,
    blockedSeenOnlySubjects,
  );
  const canonicalBase: PersistedStandbyStateV1 = {
    ...migrationBase,
    ...(migrationBase.typhoonProbabilities == null ? {} : {
      typhoonProbabilities: migrationBase.typhoonProbabilities.map((projection) => {
        const serial = normalizeVpta50Serial(projection.revision.serial);
        return serial.kind === "invalid" ? projection : {
          ...projection,
          revision: {
            ...projection.revision,
            serial: serial.kind === "missing" ? null : serial.canonicalRaw,
          },
        };
      }),
    }),
  };
  const migratedNankai = migratedNankaiStandbyState(canonicalBase, {
    gateEntries: [
      ...migratedLegacyStandbyGateEntries(canonicalBase),
      ...(hardLimit || metadataMode === "present-invalid"
        ? []
        : migratedVptaGateEntries(
            canonicalBase,
            allowUnprefixedSeen,
            blockedSeenOnlySubjects,
          )),
    ],
  });
  const vptaNormalized = normalizeVptaPersistenceBundles(
    migratedNankai.base,
    migratedNankai.foundation,
  );
  return {
    ...vptaNormalized.base,
    version: 2,
    telegramFoundation: {
      vpws50: { authoritative: false, state: null, gateEntries: migratedVpws50GateEntries(canonicalBase) },
      vpww56: emptyVpww56Foundation(),
      tsunami: emptyTsunamiFoundation(),
      volcano: emptyVolcanoFoundation(),
      floodForecast: emptyFloodFoundation(),
      standbyDomains: vptaNormalized.foundation,
    },
  };
}

function hasVpws50MigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.vpws50;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  const rawHasLegacyField = Object.hasOwn(raw, "weatherAlerts");
  const legacy = state.weatherAlerts?.find((entry) => entry.source === "vpws50");
  const current = foundation.state?.current ?? null;
  const legacyHasPayload = legacy != null && legacy.alerts.length > 0;
  if (current == null) return legacyHasPayload;
  if (!rawHasLegacyField || legacy == null) return true;

  if (
    legacy.revision.reportTimeMs !== Date.parse(current.identity.reportDateTime)
    || legacy.revision.serial !== current.identity.serial
  ) return true;

  const holder = new Vpws50StateHolder();
  holder.restorePersistedState(foundation.state!);
  const projected = weatherAlertsFromVpws50(
    holder.getCurrentAreasForDisplay(),
    current.identity.reportDateTime,
  );
  return JSON.stringify(projected) !== JSON.stringify(legacy.alerts);
}

function hasVpww56MigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.vpww56;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  const rawHasLegacyField = Object.hasOwn(raw, "weatherAlerts");
  const legacy = state.weatherAlerts?.find((entry) => entry.source === "vpww56");
  const legacyHasPayload = legacy != null && legacy.alerts.length > 0;
  const current = foundation.state;
  // 旧粒度 stream を官署別に復元待ちへ移した直後は canonical が意図的に部分集合になる。
  // legacy union との差は migration conflict ではなく世代移行そのものなので数えない。
  if ((current?.pendingSubjects?.length ?? 0) > 0) return false;
  if (current == null || current.streams.length === 0) return legacyHasPayload;
  if (!rawHasLegacyField || legacy == null) return true;

  const holder = new Vpww56StateHolder();
  holder.restorePersistedState(current);
  const canonical = weatherAlertsFromVpww56(holder.getCurrentAreasForDisplay(), "");
  const stripUpdatedAt = (alerts: DisplayWeatherAlertV1[]) =>
    alerts.map(({ updatedAt: _updatedAt, ...alert }) => alert);
  if (JSON.stringify(stripUpdatedAt(canonical)) !== JSON.stringify(stripUpdatedAt(legacy.alerts))) {
    return true;
  }

  const latestActive = [...foundation.gateEntries]
    .filter((entry) =>
      !entry.cancelled
      && entry.comparison.revision.reportDateTime.valid
      && entry.comparison.revision.reportDateTime.epochMs != null)
    .sort((left, right) => {
      const timeOrder = right.comparison.revision.reportDateTime.epochMs!
        - left.comparison.revision.reportDateTime.epochMs!;
      return timeOrder !== 0 ? timeOrder : right.acceptedAtMs - left.acceptedAtMs;
    })[0];
  if (latestActive == null) return true;
  return legacy.revision.reportTimeMs !== latestActive.comparison.revision.reportDateTime.epochMs
    || legacy.revision.serial !== latestActive.comparison.revision.serial.raw;
}

function hasVolcanoMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.volcano;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  if (!Object.hasOwn(raw, "volcanoes") || !Array.isArray(raw.volcanoes)) return true;
  for (const gate of foundation.gateEntries) {
    const prefix = gate.revisionFamily === "volcanoAlert"
      ? "volcano:alert:"
      : "volcano:eruption:";
    const code = gate.stateSubjectKey.slice(prefix.length);
    const legacy = state.volcanoes.find((entry) => entry.code === code);
    const canonical = foundation.active.find((entry) => entry.code === code);
    if (gate.revisionFamily === "volcanoAlert") {
      const legacySlice = legacy == null ? null : {
        alertLevel: legacy.alertLevel,
        alertClass: legacy.alertClass ?? null,
        warningKind: legacy.warningKind ?? null,
        targetKinds: legacy.targetKinds ?? [],
        alertRevision: legacy.alertRevision,
      };
      const canonicalSlice = gate.cancelled || canonical == null ? null : {
        alertLevel: canonical.alertLevel,
        alertClass: canonical.alertClass ?? null,
        warningKind: canonical.warningKind ?? null,
        targetKinds: canonical.targetKinds ?? [],
        alertRevision: canonical.alertRevision,
      };
      if (JSON.stringify(legacySlice) !== JSON.stringify(canonicalSlice)) return true;
    } else {
      const legacySlice = legacy?.latestEvent == null ? null : {
        latestEvent: legacy.latestEvent,
        latestEventId: legacy.latestEventId ?? null,
        eventExpiresAtMs: legacy.eventExpiresAtMs,
        eventRevision: legacy.eventRevision,
      };
      const canonicalSlice = gate.cancelled || canonical?.latestEvent == null ? null : {
        latestEvent: canonical.latestEvent,
        latestEventId: canonical.latestEventId ?? null,
        eventExpiresAtMs: canonical.eventExpiresAtMs,
        eventRevision: canonical.eventRevision,
      };
      if (JSON.stringify(legacySlice) !== JSON.stringify(canonicalSlice)) return true;
    }
  }
  return false;
}

function hasFloodMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.floodForecast;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  if (!Object.hasOwn(raw, "floods") || state.floods == null) {
    return foundation.active.length > 0 || foundation.gateEntries.length > 0;
  }
  const canonicalEvents = [...foundation.active].sort((a, b) => a.eventId.localeCompare(b.eventId));
  const legacyEvents = [...state.floods.events].sort((a, b) => a.eventId.localeCompare(b.eventId));
  if (JSON.stringify(canonicalEvents) !== JSON.stringify(legacyEvents)) return true;
  const canonicalSeen = floodLegacySeenEntries(foundation.gateEntries)
    .sort((a, b) => a.key.localeCompare(b.key));
  const legacySeen = [...state.floods.seen].sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(canonicalSeen) !== JSON.stringify(legacySeen);
}

function stablePersistenceJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!isRecord(item)) return item;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) result[key] = canonicalize(item[key]);
    return result;
  };
  return JSON.stringify(canonicalize(value));
}

function rollbackMirrorsSemanticallyEqual(
  left: PersistedStandbyStateV1,
  right: PersistedStandbyStateV1,
): boolean {
  const comparable = (state: PersistedStandbyStateV1): unknown => {
    const { savedAt: _savedAt, ...withoutSavedAt } = state;
    return {
      ...withoutSavedAt,
      ...(state.typhoonProbabilities == null ? {} : {
        typhoonProbabilities: [...state.typhoonProbabilities].sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      }),
      ...(state.typhoonProbabilityGateMetadata == null ? {} : {
        typhoonProbabilityGateMetadata: [...state.typhoonProbabilityGateMetadata]
          .sort((a, b) => a.stateSubjectKey < b.stateSubjectKey
            ? -1 : a.stateSubjectKey > b.stateSubjectKey ? 1 : 0),
      }),
      seen: [...state.seen].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1
          : stablePersistenceJson(a).localeCompare(stablePersistenceJson(b))),
    };
  };
  return stablePersistenceJson(comparable(left)) === stablePersistenceJson(comparable(right));
}

function rawMirrorArrayMatches(
  raw: Record<string, unknown>,
  key: string,
  expected: readonly unknown[],
  identity: (item: unknown) => string,
): boolean {
  if (expected.length === 0) return !Object.hasOwn(raw, key);
  const actual = raw[key];
  if (!Array.isArray(actual)) return false;
  const sorted = (items: readonly unknown[]) => [...items].sort((left, right) => {
    const leftKey = identity(left), rightKey = identity(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1
      : stablePersistenceJson(left).localeCompare(stablePersistenceJson(right));
  });
  return stablePersistenceJson(sorted(actual)) === stablePersistenceJson(sorted(expected));
}

function hasVptaRollbackMirrorConflict(
  raw: unknown,
  state: PersistedStandbyStateV2,
): boolean {
  if (!isRecord(raw)) return false;
  const vptaGates = state.telegramFoundation.standbyDomains.gateEntries.filter((entry) =>
    entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50");
  const projections = state.typhoonProbabilities ?? [];
  const metadata = vptaGateMetadata(vptaGates);
  if (!rawMirrorArrayMatches(
    raw,
    "typhoonProbabilities",
    projections,
    (item) => isRecord(item) && typeof item.key === "string" ? item.key : "",
  )) return true;
  if (!rawMirrorArrayMatches(
    raw,
    "typhoonProbabilityGateMetadata",
    metadata,
    (item) => isRecord(item) && typeof item.stateSubjectKey === "string"
      ? item.stateSubjectKey : "",
  )) return true;

  const eventIds = collectRawVptaEventIds(raw);
  for (const gate of vptaGates) {
    const eventId = vptaEventIdFromSubject(gate.stateSubjectKey);
    if (eventId != null) eventIds.add(eventId);
  }
  const expectedSeen = standbyLegacySeenEntries(vptaGates);
  if (!Array.isArray(raw.seen)) return expectedSeen.length > 0;
  const nonVptaSeenKeys = new Set(state.seen.map((entry) => entry.key));
  const hasVptaMirrorShape = expectedSeen.length > 0
    || Object.hasOwn(raw, "typhoonProbabilities")
    || Object.hasOwn(raw, "typhoonProbabilityGateMetadata");
  const actualSeen = raw.seen.filter((entry) => isRecord(entry)
    && typeof entry.key === "string"
    && (entry.key.startsWith("typhoonProbability:")
      || eventIds.has(entry.key)
      || hasVptaMirrorShape
        && !nonVptaSeenKeys.has(entry.key)
        && validateTyphoonProbabilityEventId(entry.key) === entry.key));
  const bySeenKey = (item: unknown) => isRecord(item) && typeof item.key === "string" ? item.key : "";
  const sorted = (items: readonly unknown[]) => [...items].sort((left, right) => {
    const leftKey = bySeenKey(left), rightKey = bySeenKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1
      : stablePersistenceJson(left).localeCompare(stablePersistenceJson(right));
  });
  return stablePersistenceJson(sorted(actualSeen)) !== stablePersistenceJson(sorted(expectedSeen));
}

function hasStandbyDomainsMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  if (!isRecord(raw)) return false;
  const projected = standbyLegacySeenEntries(state.telegramFoundation.standbyDomains.gateEntries);
  if (projected.length === 0) return false;
  if (!Array.isArray(raw.seen)) return true;
  const legacyByKey = new Map<string, unknown | null>();
  for (const entry of raw.seen) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    legacyByKey.set(entry.key, legacyByKey.has(entry.key) ? null : entry);
  }
  return projected.some((entry) =>
    stablePersistenceJson(legacyByKey.get(entry.key)) !== stablePersistenceJson(entry));
}

function hasFoundationMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  return hasVpws50MigrationConflict(raw, state)
    || hasVpww56MigrationConflict(raw, state)
    || hasVolcanoMigrationConflict(raw, state)
    || hasFloodMigrationConflict(raw, state)
    || hasVptaRollbackMirrorConflict(raw, state)
    || hasStandbyDomainsMigrationConflict(raw, state);
}
