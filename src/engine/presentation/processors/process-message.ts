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

const PROCESSOR_TABLE = {
  eew: (msg, deps, cat) => {
    const eewResult = processEew(msg, deps.eewTracker, deps.eewLogger);
    if (eewResult.kind === "ok") return eewResult.outcome;
    if (eewResult.kind === "duplicate" || eewResult.kind === "suppressed") return null; // 重複・抑制 → 表示・統計なし
    // parse-failed → raw 表示するが統計には含めない（旧 router と同じ動作）
    const raw = processRaw(msg, cat);
    raw.stats.shouldRecord = false;
    return raw;
  },
  earthquake: (msg, _deps, cat) => processEarthquake(msg) ?? processRaw(msg, cat),
  seismicText: (msg, _deps, cat) => processSeismicText(msg) ?? processRaw(msg, cat),
  lgObservation: (msg, _deps, cat) => processLgObservation(msg) ?? processRaw(msg, cat),
  tsunami: (msg, deps, cat) => {
    const tsunamiResult = processTsunami(msg, deps.tsunamiState);
    if (tsunamiResult.kind === "ok") return tsunamiResult.outcome;
    if (tsunamiResult.kind === "suppressed") return null; // 古い報・重複報 → 表示・通知・統計なし
    return processRaw(msg, cat);
  },
  nankaiTrough: (msg, _deps, cat) => processNankaiTrough(msg) ?? processRaw(msg, cat),
  weather: (msg, deps, cat) => {
    const weatherResult = processWeather(msg, deps);
    if (weatherResult.kind === "ok") return weatherResult.outcome;
    if (weatherResult.kind === "suppressed") return null; // 古い報・重複報・対象不一致取消 → 全出力なし
    return processRaw(msg, cat);
  },
  tornado: (msg, _deps, cat) => processTornado(msg) ?? processRaw(msg, cat),
  briefing: (msg, _deps, cat) => processBriefing(msg) ?? processRaw(msg, cat),
  earlyWeather: (msg, _deps, cat) => processEarlyWeather(msg) ?? processRaw(msg, cat),
  weatherWarningTimeseries: (msg, deps, cat) =>
    processWeatherWarningTimeseries(msg, deps) ?? processRaw(msg, cat),
  climateInfo: (msg, _deps, cat) => processClimateInfo(msg) ?? processRaw(msg, cat),
  weatherExplanation: (msg, _deps, cat) => processWeatherExplanation(msg) ?? processRaw(msg, cat),
  heatAlert: (msg, _deps, cat) => processHeatAlert(msg) ?? processRaw(msg, cat),
  typhoonAnalysis: (msg, _deps, cat) => processTyphoonAnalysis(msg) ?? processRaw(msg, cat),
  typhoonProbability: (msg, deps, cat) => processTyphoonProbability(msg, deps) ?? processRaw(msg, cat),
  floodForecast: (msg, deps, cat) => processFloodForecast(msg, deps) ?? processRaw(msg, cat),
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
    return processRaw(msg, category);
  }
  return adapter(msg, deps, category);
}
