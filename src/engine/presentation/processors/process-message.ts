import type { WsDataMessage } from "../../../types";
import type { LegacyCounterpartOutcome, ProcessOutcome, ProcessOutcomeBase } from "../types";
import type { EewTracker } from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import type { VolcanoStateHolder } from "../../messages/volcano-state";
import { Vpws50StateHolder } from "../../messages/vpws50-state";
import type { Vpww56StateHolder } from "../../messages/vpww56-state";
import type { Vpwp50DetailCache } from "../../messages/vpwp50-detail-cache";
import type { TornadoDetailProvider } from "../../messages/tornado-detail-provider";
import type { TyphoonProbabilityStateHolder } from "../../messages/typhoon-probability-state";
import type { FloodForecastStateHolder } from "../../messages/flood-forecast-state";
import {
  semanticPayloadFingerprint,
  type TelegramRevisionGate,
  type TelegramRevisionDecision,
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";
import type { StatsCategory } from "../../messages/telegram-stats";
import { routeToCategory } from "../../messages/telegram-stats";
import type { Route, LinearRoute } from "../../messages/route-catalog";
import { processEew } from "./process-eew";
import type { Vxse44SuppressionReason } from "./process-eew";
import type { DeliveryCapabilities } from "../../../dmdata/delivery-capabilities";
import { processEarthquake } from "./process-earthquake";
import { processSeismicText } from "./process-seismic-text";
import { processLgObservation } from "./process-lg-observation";
import { processTsunami } from "./process-tsunami";
import { processNankaiTrough } from "./process-nankai-trough";
import { processWeather } from "./process-weather";
import { processTornado } from "./process-tornado";
import { processBriefing } from "./process-briefing";
import { processEarlyWeather } from "./process-early-weather";
import { processWeatherWarningTimeseries } from "./process-weather-warning-timeseries";
import { processClimateInfo } from "./process-climate-info";
import { processWeatherExplanation } from "./process-weather-explanation";
import { processHeatAlert } from "./process-heat-alert";
import { processTyphoonAnalysis } from "./process-typhoon-analysis";
import {
  createTyphoonProbabilityOutcomeBaseline,
  prepareTyphoonProbability,
} from "./process-typhoon-probability";
import { processFloodForecast } from "./process-flood-forecast";
import { processLegacyCounterpart } from "./process-legacy-counterpart";
import { processRaw } from "./process-raw";
import {
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  NANKAI_INFORMATION_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
  WEATHER_TIMESERIES_REVISION_FAMILY_POLICY,
  EARTHQUAKE_REVISION_FAMILY_POLICY,
  SEISMIC_TEXT_REVISION_FAMILY_POLICY,
  BRIEFING_REVISION_FAMILY_POLICY,
  EARLY_WEATHER_REVISION_FAMILY_POLICY,
  CLIMATE_INFO_REVISION_FAMILY_POLICY,
  WEATHER_EXPLANATION_REVISION_FAMILY_POLICY,
  RAW_REVISION_FAMILY_POLICY,
  LEGACY_COUNTERPART_REVISION_FAMILY_POLICY,
  type RevisionFamilyPolicy,
} from "../../messages/revision-family-registry";
import { processStandbyFoundation, standbyFoundationPresentation } from "./process-standby-foundation";
import { nankaiBadgeAction } from "../../display/nankai-status";
import { gateRawOutcome, gateTransientOutcome } from "./process-transient-foundation";
import { weatherOfficeWatermarkKey } from "../../messages/weather-stream-key";
import {
  canonicalizeVptaInfoType,
  finalizeTyphoonProbabilityClassification,
  normalizeVpta50Serial,
  projectTyphoonProbability,
  TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH,
  TYPHOON_PROBABILITY_RETENTION_MS,
  validateTyphoonProbabilityEventId,
  validateVptaClassificationClock,
} from "../../display/project-typhoon-probability";
import type {
  VptaAdmissionCompletion,
  VptaAdmissionCompletionAdapter,
  VptaDisplayIngestCommand,
  VptaDurableChangeFlags,
  VptaFailureStage,
} from "../../display/types";
import {
  assertVptaAdmissionCompletion,
  requireVptaRouterOwnerToken,
} from "../../display/types";
import * as log from "../../../logger";
import type {
  StandbyCandidateReducer,
  StandbyDurableMutationKey,
  StandbyPersistenceAdmissionCoordinator,
} from "../../display/standby-persistence-admission";
import { sweepStandbyBeforeAdmission } from "../../display/standby-persistence-admission";
import { TelegramRevisionGate as ScratchTelegramRevisionGate } from "../../messages/telegram-revision-gate";
import { StandbyStateStore } from "../../display/standby-state-store";
import { toPresentationEvent } from "../events/to-presentation-event";
import { weatherAlertsFromVpws50 } from "../../display/weather-alert-view";

/** processMessage に必要な依存群 */
export interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  tornadoDetailProvider: TornadoDetailProvider;
  typhoonProbabilityState: TyphoonProbabilityStateHolder;
  /** 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の差分検出 state holder (Task 25b で dispatch を追加) */
  floodForecastState: FloodForecastStateHolder;
  revisionGate: TelegramRevisionGate;
  /** Pair-persisted domains must commit through this all-owner admission boundary. */
  persistenceAdmission?: StandbyPersistenceAdmissionCoordinator;
  onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onVpws50RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onVpws50StateMutationAccepted?: () => void;
  onVpww56RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onTsunamiRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onFloodRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onStandbyRevisionDecision?: (
    decision: TelegramRevisionDecision,
    context?: { domain: string; revisionFamily: string },
  ) => void;
  /** VPTA observer is deliberately persistence-free; completion owns persistence. */
  onVptaStandbyRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** Router-owned sticky poison guard, checked immediately after external callbacks. */
  assertRouterSerializerHealthy?: () => void;
  onVptaAdmissionCompletion?: VptaAdmissionCompletionAdapter;
  activeTyphoonProbabilitySubjects?: (nowMs: number) => readonly string[];
  activeWeatherWarningForecastSubjects?: (nowMs: number) => readonly string[];
  maintainTyphoonProbabilitySubjects?: (
    nowMs: number,
    activeGateSubjects: readonly string[],
  ) => { viewChanged: boolean; durableChanged: boolean };
  maintainWeatherWarningForecastSubjects?: (
    nowMs: number,
    activeGateSubjects: readonly string[],
  ) => { viewChanged: boolean; durableChanged: boolean };
  reconcileTyphoonProbabilitySubject?: (
    eventId: string,
  ) => { viewChanged: boolean; durableChanged: boolean };
  getDeliveryCapabilities?: () => DeliveryCapabilities;
  onVxse44Suppressed?: (reason: Vxse44SuppressionReason) => void;
}

interface VptaAcceptedInternal {
  transient?: never;
  vptaDisplayCommand: VptaDisplayIngestCommand;
  completion: Extract<VptaAdmissionCompletion, { kind: "accepted" }>;
}

interface VptaTransientInternal {
  transient: true;
  vptaDisplayCommand?: never;
  completion?: never;
}

type VptaInternal = VptaAcceptedInternal | VptaTransientInternal;

const vptaInternalCommands = new WeakMap<ProcessOutcome, VptaInternal>();

export interface ProcessMessageInternalResult {
  outcome: ProcessOutcome;
  internal?: VptaInternal;
}

function vptaDurableChanged(changes: VptaDurableChangeFlags): boolean {
  return changes.gateExpiry || changes.projectionCleanup
    || changes.incomingGate || changes.projectionOrRetention;
}

function completeVptaAdmission(
  deps: ProcessDeps,
  completion: VptaAdmissionCompletion,
): void {
  assertVptaAdmissionCompletion(completion);
  deps.onVptaAdmissionCompletion?.(completion);
}

/**
 * 各 route の processXxx を「ProcessOutcome | null に正規化する adapter」に統一した表。
 * - suppressed / duplicate → null (表示・通知・統計なし)
 * - parse-failed / パース null → processRaw フォールバック (fallbackCategory を statsCategory に保持)
 *
 * `satisfies Record<LinearRoute, ProcessorAdapter>` により、新 Route (linear) を catalog に
 * 足して adapter を書き忘れると**コンパイルエラー**になる。volcano / ignore / raw は
 * LinearRoute に含まれない特殊ルートのため、この表には現れない (下記 processMessage 参照)。
 */
type ProcessorAdapter = (
  msg: WsDataMessage,
  deps: ProcessDeps,
  /** パース失敗時の raw フォールバックに使う statsCategory (route 由来) */
  fallbackCategory: StatsCategory,
) => ProcessOutcome | null;

function gateStandbyOutcome<
  TParsed extends { meta: import("../../../types").TelegramMeta },
  TOutcome extends ProcessOutcomeBase & { parsed: TParsed },
>(
  outcome: TOutcome,
  policy: RevisionFamilyPolicy<TParsed>,
  deps: ProcessDeps,
): TOutcome | null {
  const durableKey: StandbyDurableMutationKey | null =
    policy.domain === "tornado" && policy.revisionFamily === "tornado"
      ? "standby:tornado"
      : policy.domain === "heatAlert" && policy.revisionFamily === "VPFT50"
        ? "standby:heatAlert"
        : policy.domain === "typhoonAnalysis" && policy.revisionFamily === "typhoonAnalysis"
          ? "standby:typhoonAnalysis"
          : policy.domain === "weatherWarningTimeseries" && policy.revisionFamily === "VPWP50"
            ? "weatherWarningTimeseries:VPWP50"
          : policy.domain === "nankaiTrough" && policy.revisionFamily === "nankaiTrough"
            ? "standby:nankaiTrough"
            : policy.domain === "lgObservation" && policy.revisionFamily === "VXSE62"
              ? "standby:lgObservation"
              : null;
  if (deps.persistenceAdmission != null && durableKey != null) {
    const completionOwnsFamilySweep = durableKey === "weatherWarningTimeseries:VPWP50";
    const ownsVpwp50Projection = policy.domain === "weatherWarningTimeseries"
      && policy.revisionFamily === "VPWP50";
    if (!completionOwnsFamilySweep && !sweepStandbyBeforeAdmission(
      deps.persistenceAdmission,
      durableKey,
      outcome.parsed.meta.receivedAtMs,
    )) return null;
    const callbacks: Array<() => void> = [];
    const completionCallbacks: Array<() => void> = [];
    const reduce: StandbyCandidateReducer<{
      result: ReturnType<typeof processStandbyFoundation<TParsed>>;
      presentation: ReturnType<typeof standbyFoundationPresentation>;
    }> = (draft) => {
        const gate = ScratchTelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
        const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
        const result = processStandbyFoundation(outcome.msg, outcome.parsed, policy, {
          revisionGate: gate,
          onRevisionDecision: deps.onRevisionDecision == null
            ? undefined
            : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
          onStandbyRevisionDecision: deps.onStandbyRevisionDecision == null
            ? undefined
            : (decision, context) => {
                const callback = () => deps.onStandbyRevisionDecision!(decision, context);
                if (completionOwnsFamilySweep) completionCallbacks.push(callback);
                else callbacks.push(callback);
              },
          activeWeatherWarningForecastSubjects: !ownsVpwp50Projection
            ? undefined
            : (nowMs) => standby.activeWeatherWarningForecastSubjects(nowMs),
          maintainWeatherWarningForecastSubjects: !ownsVpwp50Projection
            ? undefined
            : (nowMs, subjects) => standby.maintainWeatherWarningForecastSubjects(nowMs, subjects),
        });
        draft.telegramRevisionGate = gate.cloneSnapshot();
        const presentation = standbyFoundationPresentation(result);
        let projectionDurableChanged = false;
        if (result.kind !== "suppressed") {
          const candidate = {
            ...outcome,
            presentation: { ...outcome.presentation, ...presentation },
          } as TOutcome;
          projectionDurableChanged = standby.applyEvent(
            toPresentationEvent(candidate as unknown as ProcessOutcome),
            outcome.parsed.meta.receivedAtMs,
          ).durableChanged;
        }
        draft.standbyStateStore = standby.cloneSnapshot();
        return {
          kind: "accepted",
          value: { result, presentation },
          durableChanged: result.preAdmissionDurableChanged
            || result.decision?.accepted === true
            || projectionDurableChanged,
        };
      };
    const transaction = completionOwnsFamilySweep
      && deps.onStandbyRevisionDecision != null
      ? deps.persistenceAdmission.transactDeferred(
          durableKey,
          ["telegramRevisionGate", "standbyStateStore"],
          reduce,
        )
      : deps.persistenceAdmission.transact(
          durableKey,
          ["telegramRevisionGate", "standbyStateStore"],
          reduce,
        );
    if (transaction.kind !== "committed") {
      log.warn(`[standby-admission] key=${durableKey} reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
      return null;
    }
    for (const callback of completionCallbacks) callback();
    for (const callback of callbacks) callback();
    if (transaction.value.result.kind === "suppressed") return null;
    Object.assign(outcome.presentation, transaction.value.presentation, {
      standbyStateProjectionCommitted: true,
    });
    return outcome;
  }
  const ownsVpwp50Projection = policy.domain === "weatherWarningTimeseries"
    && policy.revisionFamily === "VPWP50";
  const result = processStandbyFoundation(outcome.msg, outcome.parsed, policy, {
    ...deps,
    activeWeatherWarningForecastSubjects: ownsVpwp50Projection
      ? deps.activeWeatherWarningForecastSubjects
      : undefined,
    maintainWeatherWarningForecastSubjects: ownsVpwp50Projection
      ? deps.maintainWeatherWarningForecastSubjects
      : undefined,
  });
  if (result.kind === "suppressed") return null;
  Object.assign(outcome.presentation, standbyFoundationPresentation(result));
  return outcome;
}

function gateDurablePresentationOutcome<
  TParsed extends { meta: import("../../../types").TelegramMeta },
  TOutcome extends ProcessOutcomeBase & { parsed: TParsed },
>(
  outcome: TOutcome,
  policy: RevisionFamilyPolicy<TParsed>,
  key: "standby:briefingCritical" | "standby:quakeHost",
  deps: ProcessDeps,
): TOutcome | null {
  if (deps.persistenceAdmission == null) return gateTransientOutcome(outcome, policy, deps);
  if (!sweepStandbyBeforeAdmission(
    deps.persistenceAdmission,
    key,
    outcome.parsed.meta.receivedAtMs,
  )) return null;
  const callbacks: Array<() => void> = [];
  const transaction = deps.persistenceAdmission.transact(
    key,
    ["telegramRevisionGate", "standbyStateStore"],
    (draft) => {
      const gate = ScratchTelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
      const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
      const candidate = {
        ...outcome,
        presentation: { ...outcome.presentation },
      } as TOutcome;
      const gated = gateTransientOutcome(candidate, policy, {
        revisionGate: gate,
        onRevisionDecision: deps.onRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
      });
      draft.telegramRevisionGate = gate.cloneSnapshot();
      let durableChanged = false;
      if (gated != null) {
        const mutation = standby.applyEvent(
          toPresentationEvent(gated as unknown as ProcessOutcome),
          outcome.parsed.meta.receivedAtMs,
        );
        durableChanged = mutation.durableChanged;
      }
      draft.standbyStateStore = standby.cloneSnapshot();
      return { kind: "accepted", value: gated, durableChanged };
    },
  );
  if (transaction.kind !== "committed") {
    log.warn(`[standby-admission] key=${key} reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
    return null;
  }
  for (const callback of callbacks) callback();
  if (transaction.value == null) return null;
  Object.assign(outcome.presentation, transaction.value.presentation, {
    standbyStateProjectionCommitted: true,
  });
  return outcome;
}

function gateVpno50EmergencyClear(
  outcome: LegacyCounterpartOutcome,
  deps: ProcessDeps,
): LegacyCounterpartOutcome | null {
  if (deps.persistenceAdmission == null) {
    const gated = gateTransientOutcome(outcome, LEGACY_COUNTERPART_REVISION_FAMILY_POLICY, deps);
    if (gated == null) return null;
    const update = deps.vpws50State.clearEmergencyPartialAreas(
      weatherOfficeWatermarkKey(gated.parsed.publishingOffice)!,
      gated.parsed.areas.map((area) => area.code),
      {
        reportDateTime: gated.parsed.reportDateTime,
        serial: gated.msg.xmlReport?.head.serial ?? null,
      },
    );
    gated.presentation.weatherDiff = update.diff;
    gated.presentation.weatherChangeDiff = update.displayDiff ?? undefined;
    gated.presentation.weatherStateMutationAccepted = update.diff.confidence === "confirmed";
    deps.onVpws50StateMutationAccepted?.();
    return gated;
  }

  if (!sweepStandbyBeforeAdmission(
    deps.persistenceAdmission,
    "weather:VPWS50",
    outcome.parsed.meta.receivedAtMs,
  )) return null;
  const callbacks: Array<() => void> = [];
  const transaction = deps.persistenceAdmission.transact(
    "weather:VPWS50",
    ["telegramRevisionGate", "standbyStateStore", "vpws50State"],
    (draft) => {
      const gate = ScratchTelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
      const vpws50 = Vpws50StateHolder.fromSnapshot(draft.vpws50State);
      const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
      const candidate = {
        ...outcome,
        presentation: { ...outcome.presentation },
      } as LegacyCounterpartOutcome;
      const gated = gateTransientOutcome(candidate, LEGACY_COUNTERPART_REVISION_FAMILY_POLICY, {
        revisionGate: gate,
        onRevisionDecision: deps.onRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
      });
      let durableChanged = false;
      if (gated != null) {
        const update = vpws50.clearEmergencyPartialAreas(
          weatherOfficeWatermarkKey(gated.parsed.publishingOffice)!,
          gated.parsed.areas.map((area) => area.code),
          {
            reportDateTime: gated.parsed.reportDateTime,
            serial: gated.msg.xmlReport?.head.serial ?? null,
          },
        );
        gated.presentation.weatherDiff = update.diff;
        gated.presentation.weatherChangeDiff = update.displayDiff ?? undefined;
        gated.presentation.weatherStateMutationAccepted = update.diff.confidence === "confirmed";
        durableChanged = gated.presentation.weatherStateMutationAccepted;
        if (deps.onVpws50StateMutationAccepted != null) {
          callbacks.push(() => deps.onVpws50StateMutationAccepted!());
        }
        const identity = vpws50.getCurrentIdentity();
        const reportDateTime = identity?.reportDateTime ?? gated.parsed.reportDateTime;
        standby.applyWeatherAlerts(
          "vpws50",
          weatherAlertsFromVpws50(vpws50.getCurrentAreasForDisplay(), reportDateTime),
          reportDateTime,
          identity?.serial ?? gated.msg.xmlReport?.head.serial ?? null,
          gated.parsed.meta.receivedAtMs,
        );
      }
      draft.telegramRevisionGate = gate.cloneSnapshot();
      draft.vpws50State = vpws50.cloneSnapshot();
      draft.standbyStateStore = standby.cloneSnapshot();
      return { kind: "accepted", value: gated, durableChanged };
    },
  );
  if (transaction.kind !== "committed") {
    log.warn(`[standby-admission] key=weather:VPWS50 reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
    return null;
  }
  for (const callback of callbacks) callback();
  if (transaction.value == null) return null;
  Object.assign(outcome.presentation, transaction.value.presentation, {
    standbyStateProjectionCommitted: true,
  });
  return outcome;
}

const PROCESSOR_TABLE = {
  eew: (msg, deps, cat) => {
    const eewResult = processEew(msg, deps.eewTracker, deps.eewLogger, {
      getDeliveryCapabilities: deps.getDeliveryCapabilities,
      onVxse44Suppressed: deps.onVxse44Suppressed,
    });
    if (eewResult.kind === "ok") return eewResult.outcome;
    if (eewResult.kind === "duplicate" || eewResult.kind === "suppressed") return null; // 重複・抑制 → 表示・統計なし
    // parse-failed → raw 表示するが統計には含めない（旧 router と同じ動作）
    const raw = processRaw(msg, cat);
    raw.stats.shouldRecord = false;
    return raw;
  },
  earthquake: (msg, deps, cat) => {
    const outcome = processEarthquake(msg);
    return outcome == null
      ? processRaw(msg, cat)
      : gateDurablePresentationOutcome(
          outcome,
          EARTHQUAKE_REVISION_FAMILY_POLICY,
          "standby:quakeHost",
          deps,
        );
  },
  seismicText: (msg, deps, cat) => {
    const outcome = processSeismicText(msg);
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, SEISMIC_TEXT_REVISION_FAMILY_POLICY, deps);
  },
  lgObservation: (msg, deps, cat) => {
    const outcome = processLgObservation(msg);
    return outcome == null ? processRaw(msg, cat) : gateStandbyOutcome(outcome, LG_OBSERVATION_REVISION_FAMILY_POLICY, deps);
  },
  tsunami: (msg, deps, cat) => {
    const tsunamiResult = processTsunami(msg, deps);
    if (tsunamiResult.kind === "ok") return tsunamiResult.outcome;
    if (tsunamiResult.kind === "suppressed") return null; // 古い報・重複報 → 表示・通知・統計なし
    return processRaw(msg, cat);
  },
  nankaiTrough: (msg, deps, cat) => {
    const outcome = processNankaiTrough(msg);
    if (outcome == null) return processRaw(msg, cat);
    const action = nankaiBadgeAction(outcome.parsed.infoSerial?.code ?? null).action;
    const ownsProjection = outcome.parsed.infoType === "取消" || action !== "ignore";
    const gated = gateStandbyOutcome(
      outcome,
      ownsProjection ? NANKAI_REVISION_FAMILY_POLICY : NANKAI_INFORMATION_REVISION_FAMILY_POLICY,
      deps,
    );
    if (gated != null && !ownsProjection) {
      // Informational reports are gated for exactly-once notification only; they do not own standby projection state.
      gated.presentation.standbyStateSubject = null;
      gated.presentation.standbyActiveSubjects = undefined;
      gated.presentation.standbyAppliedSemanticKey = null;
    }
    return gated;
  },
  weather: (msg, deps, cat) => {
    const weatherResult = processWeather(msg, deps);
    if (weatherResult.kind === "ok") return weatherResult.outcome;
    if (weatherResult.kind === "suppressed") return null; // 古い報・重複報・対象不一致取消 → 全出力なし
    return processRaw(msg, cat);
  },
  tornado: (msg, deps, cat) => {
    const outcome = processTornado(msg);
    if (outcome == null) return processRaw(msg, cat);
    const gated = gateStandbyOutcome(outcome, TORNADO_REVISION_FAMILY_POLICY, deps);
    if (gated?.presentation.standbyStateMutationAccepted === true) {
      deps.tornadoDetailProvider.rememberLatest(outcome.parsed);
    }
    return gated;
  },
  briefing: (msg, deps, cat) => {
    const outcome = processBriefing(msg);
    return outcome == null
      ? processRaw(msg, cat)
      : gateDurablePresentationOutcome(
          outcome,
          BRIEFING_REVISION_FAMILY_POLICY,
          "standby:briefingCritical",
          deps,
        );
  },
  earlyWeather: (msg, deps, cat) => {
    const outcome = processEarlyWeather(msg);
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, EARLY_WEATHER_REVISION_FAMILY_POLICY, deps);
  },
  weatherWarningTimeseries: (msg, deps, cat) => {
    const outcome = processWeatherWarningTimeseries(msg);
    if (outcome == null) return processRaw(msg, cat);
    const gated = gateStandbyOutcome(outcome, WEATHER_TIMESERIES_REVISION_FAMILY_POLICY, deps);
    if (gated?.presentation.standbyStateMutationAccepted === true) deps.vpwp50Cache.rememberLatest(outcome.parsed);
    return gated;
  },
  climateInfo: (msg, deps, cat) => {
    const outcome = processClimateInfo(msg);
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, CLIMATE_INFO_REVISION_FAMILY_POLICY, deps);
  },
  weatherExplanation: (msg, deps, cat) => {
    const outcome = processWeatherExplanation(msg);
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, WEATHER_EXPLANATION_REVISION_FAMILY_POLICY, deps);
  },
  heatAlert: (msg, deps, cat) => {
    const outcome = processHeatAlert(msg);
    return outcome == null ? processRaw(msg, cat) : gateStandbyOutcome(outcome, HEAT_ALERT_REVISION_FAMILY_POLICY, deps);
  },
  typhoonAnalysis: (msg, deps, cat) => {
    const outcome = processTyphoonAnalysis(msg);
    return outcome == null ? processRaw(msg, cat) : gateStandbyOutcome(outcome, TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY, deps);
  },
  typhoonProbability: (msg, deps, cat) => {
    const parsed = prepareTyphoonProbability(msg);
    if (parsed == null) return processRaw(msg, cat);
    const eventId = validateTyphoonProbabilityEventId(parsed.eventId);
    if (eventId == null) {
      const eventIdLength = parsed.eventId?.trim().length ?? 0;
      if (eventIdLength > TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH) {
        // EventID 本文は adversarial input になり得るため、bounded な triage 情報だけを残す。
        log.warn(
          `[vpta50-admission] headType=VPTA50 length=${eventIdLength} reason=eventIdTooLong`,
        );
      }
      const canonicalInfoType = canonicalizeVptaInfoType(parsed.meta, parsed.infoType);
      if (canonicalInfoType.kind === "invalid") {
        throw new Error(`VPTA50 ${canonicalInfoType.reason}`);
      }
      const transient = createTyphoonProbabilityOutcomeBaseline(msg, parsed, canonicalInfoType.value);
      vptaInternalCommands.set(transient, { transient: true });
      return transient;
    }
    const classificationNowMs = parsed.meta.receivedAtMs;
    const changes: VptaDurableChangeFlags = {
      gateExpiry: false,
      projectionCleanup: false,
      incomingGate: false,
      projectionOrRetention: false,
    };
    let stage: VptaFailureStage = "classificationClock";
    let committed = false;
    let completionEmitted = false;
    try {
      if (!validateVptaClassificationClock(classificationNowMs)) {
        throw new Error("VPTA50 classificationClock");
      }
      stage = "infoTypeCanonicalization";
      const canonicalInfoType = canonicalizeVptaInfoType(parsed.meta, parsed.infoType);
      if (canonicalInfoType.kind === "invalid") {
        throw new Error(`VPTA50 ${canonicalInfoType.reason}`);
      }
      stage = "processorBaseline";
      const outcome = createTyphoonProbabilityOutcomeBaseline(msg, parsed, canonicalInfoType.value);
      stage = "projector";
      const classification = projectTyphoonProbability(parsed, canonicalInfoType.value, classificationNowMs);

      if (deps.persistenceAdmission != null) {
        const durableKey = "typhoonProbability:VPTA50" as const;
        if (deps.onVptaAdmissionCompletion == null) {
          throw new Error("VPTA50 persistence completion is not configured");
        }
        const ownerToken = requireVptaRouterOwnerToken();
        type CoordinatedVptaResult =
          | {
              kind: "suppressed";
              decision: TelegramRevisionDecision;
              changes: VptaDurableChangeFlags;
            }
          | {
              kind: "accepted";
              decision: TelegramRevisionDecision;
              command: VptaDisplayIngestCommand;
              finalized: ReturnType<typeof finalizeTyphoonProbabilityClassification>;
              changes: VptaDurableChangeFlags;
            };
        const transaction = deps.persistenceAdmission.transactDeferred<CoordinatedVptaResult>(
          durableKey,
          ["telegramRevisionGate", "standbyStateStore"],
          (draft) => {
            const gate = ScratchTelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
            const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
            const candidateChanges: VptaDurableChangeFlags = {
              gateExpiry: gate.expireRevisionFamilyByLifecycle(
                TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.domain,
                TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.revisionFamily,
                classificationNowMs,
                {
                  tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
                  activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
                },
              ).changed,
              projectionCleanup: false,
              incomingGate: false,
              projectionOrRetention: false,
            };
            const gateActiveBefore = gate.activeRevisionFamilySubjects(
              "typhoonProbability",
              "VPTA50",
            );
            candidateChanges.projectionCleanup = standby.maintainTyphoonProbabilitySubjects(
              classificationNowMs,
              gateActiveBefore,
            ).durableChanged;
            const activeFamilySubjects = standby.activeTyphoonProbabilitySubjects(
              classificationNowMs,
            );
            const validSubjects = [...new Set(activeFamilySubjects)];
            if (validSubjects.length !== activeFamilySubjects.length
              || validSubjects.some((subject, index) => {
                if (!subject.startsWith("typhoonProbability:")) return true;
                const id = subject.slice("typhoonProbability:".length);
                return validateTyphoonProbabilityEventId(id) !== id
                  || index > 0 && validSubjects[index - 1]! >= subject;
              })) {
              return { kind: "rejected", reason: "vpta50ProtectionSnapshotInvalid" };
            }

            const serial = normalizeVpta50Serial(parsed.meta.serial.raw);
            if (serial.kind === "invalid") {
              return { kind: "rejected", reason: "vpta50SerialCanonicalization" };
            }
            const gateMeta = {
              ...parsed.meta,
              serial: serial.kind === "missing"
                ? { raw: null, numeric: null, valid: false }
                : { raw: serial.canonicalRaw, numeric: serial.numeric, valid: true },
              infoType: {
                raw: canonicalInfoType.value,
                value: canonicalInfoType.value,
                valid: true,
              },
            };
            const { meta: _meta, ...semanticPayload } = parsed;
            const stateSubjectKey = `typhoonProbability:${eventId}`;
            const candidateKind = classification.result.kind;
            const gateInput: TelegramRevisionGateInput = {
              domain: "typhoonProbability",
              revisionFamily: "VPTA50",
              stateSubjectKey,
              meta: gateMeta,
              comparator: "reportDateTimeThenSerial",
              cancellationPolicy: "clearCurrent",
              terminal: false,
              deactivation: candidateKind === "cancel" || candidateKind === "deactivateAllZero",
              cancellationTargetMatches: true,
              durable: true,
              tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
              maxSubjects: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.maxSubjects,
              activeFamilySubjects: validSubjects,
              allowMissingSerial: true,
              fragmentMerge: false,
              payloadFingerprint: semanticPayloadFingerprint({
                ...semanticPayload,
                eventId,
                serial: serial.kind === "numeric" ? serial.canonicalRaw : null,
                infoType: canonicalInfoType.value,
              }),
              legacyRevisionKey: eventId,
              legacyRevisionKeyProvenance: "eventId",
            };
            const capacityPlan = gate.planTyphoonProbabilityCapacity(
              gateInput,
              candidateKind,
            );
            const gateResult = gate.decideTyphoonProbability(
              gateInput,
              candidateKind,
              capacityPlan,
            );
            if (gateResult.kind === "suppressed") {
              draft.telegramRevisionGate = gate.cloneSnapshot();
              draft.standbyStateStore = standby.cloneSnapshot();
              return {
                kind: "accepted",
                value: {
                  kind: "suppressed" as const,
                  decision: gateResult.decision,
                  changes: candidateChanges,
                },
                durableChanged: vptaDurableChanged(candidateChanges),
              };
            }
            const commit = gateResult.commit;
            candidateChanges.incomingGate = true;
            const expectedCancelled = candidateKind === "cancel"
              || candidateKind === "deactivateAllZero";
            if (
              commit.cancelled !== expectedCancelled
              || (canonicalInfoType.value === "取消") !== (candidateKind === "cancel")
              || commit.comparison.revision.infoType.raw !== canonicalInfoType.value
              || commit.comparison.revision.infoType.value !== canonicalInfoType.value
            ) return { kind: "rejected", reason: "vpta50GateCommitInvariant" };
            const finalized = finalizeTyphoonProbabilityClassification(
              classification,
              commit.binding.revision,
              commit.binding.appliedSemanticKey,
            );
            const activeAfter = gate.activeRevisionFamilySubjects(
              "typhoonProbability",
              "VPTA50",
            );
            const command: VptaDisplayIngestCommand = {
              domain: "typhoonProbability",
              ownerToken,
              finalized,
              commit,
              activeSubjects: Object.freeze([...activeAfter]),
            };
            const projected = standby.applyTyphoonProbabilityCommand(command);
            const retained = standby.maintainTyphoonProbabilitySubjects(
              classificationNowMs,
              activeAfter,
            );
            candidateChanges.projectionOrRetention = projected.durableChanged
              || retained.durableChanged;
            draft.telegramRevisionGate = gate.cloneSnapshot();
            draft.standbyStateStore = standby.cloneSnapshot();
            return {
              kind: "accepted",
              value: {
                kind: "accepted" as const,
                decision: commit.decision,
                command,
                finalized,
                changes: candidateChanges,
              },
              durableChanged: vptaDurableChanged(candidateChanges),
            };
          },
        );
        if (transaction.kind !== "committed") {
          log.warn(
            `[standby-admission] key=${durableKey} reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`,
          );
          return null;
        }
        Object.assign(changes, transaction.value.changes);
        if (transaction.durableChanged !== vptaDurableChanged(changes)) {
          throw new Error("VPTA50 deferred durability invariant");
        }
        if (transaction.value.kind === "accepted") {
          committed = true;
          if (classification.result.kind === "expired"
            || classification.result.kind === "nonProjectable") {
            const reason = classification.result.kind === "expired"
              ? "expired"
              : classification.result.reason;
            log.warn(
              `[vpta50-admission] eventId=${eventId} reportTimeMs=${transaction.value.command.commit.binding.revision.reportTimeMs} serial=${transaction.value.command.commit.binding.revision.serial ?? "(missing)"} reason=${reason}`,
            );
          }
        }
        stage = "genericRevisionCallback";
        deps.onRevisionDecision?.(transaction.value.decision);
        deps.assertRouterSerializerHealthy?.();
        stage = "standbyRevisionObserver";
        deps.onVptaStandbyRevisionDecision?.(transaction.value.decision);
        deps.assertRouterSerializerHealthy?.();
        if (transaction.value.kind === "suppressed") {
          const durableChanged = vptaDurableChanged(changes);
          const completion: VptaAdmissionCompletion = durableChanged
            ? {
                kind: "suppressed", nowMs: classificationNowMs, durableChanged: true,
                persistence: "deferred", changes: { ...changes },
              }
            : {
                kind: "suppressed", nowMs: classificationNowMs, durableChanged: false,
                persistence: "none", changes: { ...changes },
              };
          completionEmitted = true;
          completeVptaAdmission(deps, completion);
          return null;
        }
        stage = "notificationHolder";
        const holderDiff = deps.typhoonProbabilityState.applyAcceptedClassification(
          eventId,
          transaction.value.finalized,
        );
        if (holderDiff.isUnchangedZero && !holderDiff.shouldRecap) {
          outcome.presentation.soundLevel = "info";
          outcome.presentation.suppressNotify = true;
        }
        stage = "outcomeBinding";
        outcome.presentation.acceptedCorrection = transaction.value.decision.isCorrection;
        outcome.presentation.standbyStateProjectionCommitted = true;
        vptaInternalCommands.set(outcome, {
          vptaDisplayCommand: transaction.value.command,
          completion: {
            kind: "accepted",
            nowMs: classificationNowMs,
            durableChanged: true,
            persistence: "deferred",
            changes: { ...changes },
          },
        });
        return outcome;
      }

      stage = "admissionGateExpiry";
      changes.gateExpiry = deps.revisionGate.expireRevisionFamilyByLifecycle(
        TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.domain,
        TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.revisionFamily,
        classificationNowMs,
        {
          tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
          activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
        },
      ).changed;
      stage = "activeSubjectSnapshot";
      const gateActiveBefore = deps.revisionGate.activeRevisionFamilySubjects(
        "typhoonProbability", "VPTA50",
      );
      stage = "projectionCleanup";
      const cleanup = deps.maintainTyphoonProbabilitySubjects?.(classificationNowMs, gateActiveBefore);
      changes.projectionCleanup = cleanup?.durableChanged === true;
      stage = "protectionSnapshot";
      const activeFamilySubjects = deps.activeTyphoonProbabilitySubjects == null
        ? []
        : deps.activeTyphoonProbabilitySubjects(classificationNowMs);
      if (!Array.isArray(activeFamilySubjects)) {
        log.warn("[vpta50-admission] reason=vpta50ProtectionSnapshotInvalid");
        throw new Error("VPTA50 protectionSnapshot");
      }
      const validSubjects = [...new Set(activeFamilySubjects)];
      if (validSubjects.length !== activeFamilySubjects.length
        || validSubjects.some((subject, index) => {
          if (typeof subject !== "string" || !subject.startsWith("typhoonProbability:")) return true;
          const id = subject.slice("typhoonProbability:".length);
          return validateTyphoonProbabilityEventId(id) !== id
            || index > 0 && validSubjects[index - 1]! >= subject;
        })) {
        log.warn("[vpta50-admission] reason=vpta50ProtectionSnapshotInvalid");
        throw new Error("VPTA50 protectionSnapshot");
      }

      stage = "serialCanonicalization";
      const serial = normalizeVpta50Serial(parsed.meta.serial.raw);
      if (serial.kind === "invalid") throw new Error("VPTA50 serialCanonicalization");
      const gateMeta = {
        ...parsed.meta,
        serial: serial.kind === "missing"
          ? { raw: null, numeric: null, valid: false }
          : { raw: serial.canonicalRaw, numeric: serial.numeric, valid: true },
        infoType: {
          raw: canonicalInfoType.value,
          value: canonicalInfoType.value,
          valid: true,
        },
      };
      const { meta: _meta, ...semanticPayload } = parsed;
      const stateSubjectKey = `typhoonProbability:${eventId}`;
      const candidateKind = classification.result.kind;
      const gateInput: TelegramRevisionGateInput = {
        domain: "typhoonProbability",
        revisionFamily: "VPTA50",
        stateSubjectKey,
        meta: gateMeta,
        comparator: "reportDateTimeThenSerial",
        cancellationPolicy: "clearCurrent",
        terminal: false,
        deactivation: candidateKind === "cancel" || candidateKind === "deactivateAllZero",
        cancellationTargetMatches: true,
        durable: true,
        tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
        maxSubjects: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.maxSubjects,
        activeFamilySubjects: validSubjects,
        allowMissingSerial: true,
        fragmentMerge: false,
        payloadFingerprint: semanticPayloadFingerprint({
          ...semanticPayload,
          eventId,
          serial: serial.kind === "numeric" ? serial.canonicalRaw : null,
          infoType: canonicalInfoType.value,
        }),
        legacyRevisionKey: eventId,
        legacyRevisionKeyProvenance: "eventId",
      };
      stage = "capacityPlan";
      const capacityPlan = deps.revisionGate.planTyphoonProbabilityCapacity(
        gateInput,
        candidateKind,
      );
      stage = "gateEvaluate";
      const gateResult = deps.revisionGate.decideTyphoonProbability(
        gateInput,
        candidateKind,
        capacityPlan,
      );
      if (gateResult.kind === "suppressed") {
        stage = "genericRevisionCallback";
        deps.onRevisionDecision?.(gateResult.decision);
        deps.assertRouterSerializerHealthy?.();
        stage = "standbyRevisionObserver";
        deps.onVptaStandbyRevisionDecision?.(gateResult.decision);
        deps.assertRouterSerializerHealthy?.();
        const durableChanged = vptaDurableChanged(changes);
        const completion: VptaAdmissionCompletion = durableChanged
          ? { kind: "suppressed", nowMs: classificationNowMs, durableChanged: true, persistence: "deferred", changes: { ...changes } }
          : { kind: "suppressed", nowMs: classificationNowMs, durableChanged: false, persistence: "none", changes: { ...changes } };
        completionEmitted = true;
        completeVptaAdmission(deps, completion);
        return null;
      }
      const commit = gateResult.commit;
      committed = true;
      changes.incomingGate = true;
      stage = "gateCommitInvariant";
      const expectedCancelled = candidateKind === "cancel" || candidateKind === "deactivateAllZero";
      if (
        commit.cancelled !== expectedCancelled
        || (canonicalInfoType.value === "取消") !== (candidateKind === "cancel")
        || commit.comparison.revision.infoType.raw !== canonicalInfoType.value
        || commit.comparison.revision.infoType.value !== canonicalInfoType.value
      ) throw new Error("VPTA50 gateCommitInvariant");
      if (classification.result.kind === "expired" || classification.result.kind === "nonProjectable") {
        const reason = classification.result.kind === "expired"
          ? "expired"
          : classification.result.reason;
        log.warn(
          `[vpta50-admission] eventId=${eventId} reportTimeMs=${commit.binding.revision.reportTimeMs} serial=${commit.binding.revision.serial ?? "(missing)"} reason=${reason}`,
        );
      }
      stage = "genericRevisionCallback";
      deps.onRevisionDecision?.(commit.decision);
      deps.assertRouterSerializerHealthy?.();
      stage = "standbyRevisionObserver";
      deps.onVptaStandbyRevisionDecision?.(commit.decision);
      deps.assertRouterSerializerHealthy?.();
      stage = "finalizer";
      const finalized = finalizeTyphoonProbabilityClassification(
        classification,
        commit.binding.revision,
        commit.binding.appliedSemanticKey,
      );
      stage = "notificationHolder";
      const holderDiff = deps.typhoonProbabilityState.applyAcceptedClassification(eventId, finalized);
      if (holderDiff.isUnchangedZero && !holderDiff.shouldRecap) {
        outcome.presentation.soundLevel = "info";
        outcome.presentation.suppressNotify = true;
      }
      stage = "outcomeBinding";
      const activeAfter = deps.revisionGate.activeRevisionFamilySubjects(
        "typhoonProbability", "VPTA50",
      );
      outcome.presentation.acceptedCorrection = commit.decision.isCorrection;
      vptaInternalCommands.set(outcome, {
        vptaDisplayCommand: {
          domain: "typhoonProbability",
          ownerToken: requireVptaRouterOwnerToken(),
          finalized,
          commit,
          activeSubjects: Object.freeze([...activeAfter]),
        },
        completion: {
          kind: "accepted",
          nowMs: classificationNowMs,
          durableChanged: true,
          persistence: "deferred",
          changes: { ...changes },
        },
      });
      return outcome;
    } catch (cause) {
      const failures: unknown[] = [cause];
      if (committed) {
        try {
          const reconciliation = deps.reconcileTyphoonProbabilitySubject?.(eventId);
          changes.projectionOrRetention ||= reconciliation?.durableChanged === true;
        } catch (reconcileCause) {
          failures.push(reconcileCause);
        }
      }
      if (!completionEmitted) {
        const durableChanged = vptaDurableChanged(changes);
        const completion: VptaAdmissionCompletion = durableChanged
          ? { kind: "failed", nowMs: classificationNowMs, durableChanged: true, persistence: "immediate", changes: { ...changes }, stage }
          : { kind: "failed", nowMs: classificationNowMs, durableChanged: false, persistence: "none", changes: { ...changes }, stage };
        completionEmitted = true;
        try {
          completeVptaAdmission(deps, completion);
        } catch (completionCause) {
          failures.push(completionCause);
        }
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "VPTA50 admission failed");
    }
  },
  floodForecast: (msg, deps, cat) => {
    const result = processFloodForecast(msg, deps);
    if (result.kind === "ok") return result.outcome;
    if (result.kind === "suppressed") return null;
    return processRaw(msg, cat);
  },
  legacyCounterpart: (msg, deps, cat) => {
    const outcome = processLegacyCounterpart(msg);
    if (outcome == null) return processRaw(msg, cat);
    const vpnoEmergencyClear = outcome.parsed.type === "VPNO50"
      && outcome.parsed.publishingOffice.trim() !== ""
      && outcome.parsed.areas.length > 0
      && outcome.parsed.kinds.some((kind) => kind.code === "00" || kind.name === "解除");
    if (vpnoEmergencyClear) return gateVpno50EmergencyClear(outcome, deps);
    const gated = outcome.parsed.type === "VPOA50"
      ? gateDurablePresentationOutcome(
          outcome,
          LEGACY_COUNTERPART_REVISION_FAMILY_POLICY,
          "standby:briefingCritical",
          deps,
        )
      : gateTransientOutcome(outcome, LEGACY_COUNTERPART_REVISION_FAMILY_POLICY, deps);
    // VPNO50 は特別警報の終了通知であって、後続の警報内容を持たない。府県予報区の
    // 「解除」だけを同官署の受理済み VPWW55-61 overlay へ反映し、通常警報の権威は後続 VPWW55-61/VPWS50 に残す。
    return gated;
  },
} satisfies Record<LinearRoute, ProcessorAdapter>;

/** route が PROCESSOR_TABLE の linear route か (volcano / ignore / raw を除く) を型安全に判定する。 */
function lookupAdapter(route: Route): ProcessorAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(PROCESSOR_TABLE, route)
    ? PROCESSOR_TABLE[route as LinearRoute]
    : undefined;
}

/**
 * ルートに応じた processXxx を呼び出し ProcessOutcome を返す。
 * パース失敗の場合は RawOutcome にフォールバックする（元カテゴリを statsCategory に保持）。
 *
 * EEW / tsunami / weather の suppressed は null を返す（表示・通知・統計なし）。
 *
 * volcano: VolcanoRouteHandler が処理する (VFVO53 バッチ集約のため線形フローでは処理不可)
 * ため、この関数には到達しない (router 側で分岐)。ignore も router で早期 return する。
 * raw は adapter を持たず、そのまま processRaw フォールバックに落ちる。
 */
export function processMessage(
  msg: WsDataMessage,
  route: Route,
  deps: ProcessDeps,
): ProcessOutcome | null {
  const category = routeToCategory(route);
  const adapter = lookupAdapter(route);
  if (adapter == null) {
    // raw フォールバック (volcano / ignore は上記のとおり到達しない)
    return gateRawOutcome(processRaw(msg, category), RAW_REVISION_FAMILY_POLICY, deps);
  }
  const outcome = adapter(msg, deps, category);
  return outcome?.domain === "raw"
    ? gateRawOutcome(outcome, RAW_REVISION_FAMILY_POLICY, deps)
    : outcome;
}

export function processMessageInternal(
  msg: WsDataMessage,
  route: Route,
  deps: ProcessDeps,
): ProcessMessageInternalResult | null {
  const outcome = processMessage(msg, route, deps);
  if (outcome == null) return null;
  const internal = vptaInternalCommands.get(outcome);
  if (internal != null) vptaInternalCommands.delete(outcome);
  return {
    outcome,
    ...(internal == null ? {} : { internal }),
  };
}
