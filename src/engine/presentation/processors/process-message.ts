import type { WsDataMessage } from "../../../types";
import type { ProcessOutcome } from "../types";
import type { EewTracker } from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import type { VolcanoStateHolder } from "../../messages/volcano-state";
import type { Vpws50StateHolder } from "../../messages/vpws50-state";
import type { Vpww56StateHolder } from "../../messages/vpww56-state";
import type { Vpwp50DetailCache } from "../../messages/vpwp50-detail-cache";
import type { TyphoonProbabilityStateHolder } from "../../messages/typhoon-probability-state";
import type { FloodForecastStateHolder } from "../../messages/flood-forecast-state";
import type { TelegramRevisionGate, TelegramRevisionDecision } from "../../messages/telegram-revision-gate";
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
import { processTyphoonProbability } from "./process-typhoon-probability";
import { processFloodForecast } from "./process-flood-forecast";
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
  TRANSIENT_WEATHER_REVISION_FAMILY_POLICY,
  RAW_REVISION_FAMILY_POLICY,
  type RevisionFamilyPolicy,
} from "../../messages/revision-family-registry";
import { processStandbyFoundation, standbyFoundationPresentation } from "./process-standby-foundation";
import type { ProcessOutcomeBase } from "../types";
import { nankaiBadgeAction } from "../../display/nankai-status";
import { gateRawOutcome, gateTransientOutcome } from "./process-transient-foundation";

/** processMessage に必要な依存群 */
export interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  typhoonProbabilityState: TyphoonProbabilityStateHolder;
  /** 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の差分検出 state holder (Task 25b で dispatch を追加) */
  floodForecastState: FloodForecastStateHolder;
  revisionGate: TelegramRevisionGate;
  onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onVpws50RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onVpww56RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onTsunamiRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onFloodRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onStandbyRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  getDeliveryCapabilities?: () => DeliveryCapabilities;
  onVxse44Suppressed?: (reason: Vxse44SuppressionReason) => void;
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
  const result = processStandbyFoundation(outcome.msg, outcome.parsed, policy, deps);
  if (result.kind === "suppressed") return null;
  Object.assign(outcome.presentation, standbyFoundationPresentation(result));
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
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, EARTHQUAKE_REVISION_FAMILY_POLICY, deps);
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
    const gated = gateStandbyOutcome(
      outcome,
      action === "ignore" ? NANKAI_INFORMATION_REVISION_FAMILY_POLICY : NANKAI_REVISION_FAMILY_POLICY,
      deps,
    );
    if (gated != null && action === "ignore") {
      // Informational reports are gated for exactly-once notification only; they do not own standby projection state.
      gated.presentation.standbyStateSubject = null;
      gated.presentation.standbyActiveSubjects = undefined;
      gated.presentation.standbyAppliedSemanticKey = null;
    }
    return gated;
  },
  weather: (msg, deps, cat) => {
    const weatherResult = processWeather(msg, deps);
    if (weatherResult.kind === "ok") {
      return TRANSIENT_WEATHER_REVISION_FAMILY_POLICY.headTypes.includes(msg.head.type)
        ? gateTransientOutcome(weatherResult.outcome, TRANSIENT_WEATHER_REVISION_FAMILY_POLICY, deps)
        : weatherResult.outcome;
    }
    if (weatherResult.kind === "suppressed") return null; // 古い報・重複報・対象不一致取消 → 全出力なし
    return processRaw(msg, cat);
  },
  tornado: (msg, deps, cat) => {
    const outcome = processTornado(msg);
    return outcome == null ? processRaw(msg, cat) : gateStandbyOutcome(outcome, TORNADO_REVISION_FAMILY_POLICY, deps);
  },
  briefing: (msg, deps, cat) => {
    const outcome = processBriefing(msg);
    return outcome == null ? processRaw(msg, cat) : gateTransientOutcome(outcome, BRIEFING_REVISION_FAMILY_POLICY, deps);
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
    const outcome = processTyphoonProbability(msg);
    if (outcome == null) return processRaw(msg, cat);
    const gated = gateStandbyOutcome(outcome, TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY, deps);
    if (gated?.presentation.standbyStateMutationAccepted === true) {
      if (outcome.parsed.infoType === "取消") deps.typhoonProbabilityState.rollback(outcome.parsed.eventId ?? "");
      else {
        const diff = deps.typhoonProbabilityState.diffAndUpdate(
          outcome.parsed.eventId ?? "",
          outcome.presentation.typhoonProbabilityMaxDaily5 ?? 0,
          outcome.parsed.reportDateTime,
        );
        if (diff.isUnchangedZero && !diff.shouldRecap) {
          outcome.presentation.soundLevel = "info";
          outcome.presentation.suppressNotify = true;
        }
      }
      deps.typhoonProbabilityState.retainEventIds(
        gated.presentation.standbyActiveSubjects?.map((subject) =>
          subject.slice("typhoonProbability:".length)) ?? [],
      );
    }
    return gated;
  },
  floodForecast: (msg, deps, cat) => {
    const result = processFloodForecast(msg, deps);
    if (result.kind === "ok") return result.outcome;
    if (result.kind === "suppressed") return null;
    return processRaw(msg, cat);
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
