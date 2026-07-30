import type { FrameLevel } from "../../types";
import type { SoundLevel } from "../notification/sound-player";
import type { NotifyCategory, WsDataMessage } from "../../types";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedLgObservationInfo,
  ParsedTsunamiInfo,
  ParsedNankaiTroughInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoAshfallInfo,
  ParsedWeatherWarning,
  ParsedTornadoAdvisory,
  ParsedWeatherBriefing,
  ParsedEarlyWeatherInfo,
  ParsedWeatherWarningTimeseriesInfo,
  ParsedClimateInfo,
  ParsedWeatherExplanation,
  ParsedHeatAlertInfo,
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  ParsedFloodForecastInfo,
  FloodLevel,
  Vpws50Diff,
} from "../../types";
import type { EewDiff, EewUpdateResult } from "../eew/eew-tracker";
import type { VolcanoPresentation } from "./volcano-presentation";
import type { StatsCategory } from "../messages/telegram-stats";
import type { FloodForecastDiff } from "../messages/flood-forecast-state";

// ── PresentationDomain ──

export type PresentationDomain =
  | "eew"
  | "earthquake"
  | "seismicText"
  | "lgObservation"
  | "tsunami"
  | "volcano"
  | "nankaiTrough"
  | "weather"
  | "tornado"
  | "briefing"
  | "earlyWeather"
  | "weatherWarningTimeseries"
  | "climateInfo"
  | "weatherExplanation"
  | "heatAlert"
  | "typhoonAnalysis"
  | "typhoonProbability"
  | "floodForecast"
  | "raw";

// ── ProcessOutcome ──

export interface ProcessOutcomeBase {
  domain: PresentationDomain;
  msg: WsDataMessage;
  headType: string;
  /** 統計記録用カテゴリ（ルート由来。パース失敗→raw フォールバック時も元カテゴリを保持） */
  statsCategory: StatsCategory;
  stats: {
    shouldRecord: boolean;
    eventId?: string | null;
    maxIntUpdate?: { eventId: string; maxInt: string; headType: string };
  };
  presentation: {
    frameLevel: FrameLevel;
    soundLevel?: SoundLevel;
    notifyCategory?: NotifyCategory;
    /** 色専用の集約 severity (weather 系 processor のみ設定)。frameLevel が静音化で info 降格しても
     *  テロップ色は全国集約の最大 severity を保つため、frameLevel とは別に運ぶ (summaryRole が参照)。 */
    displaySeverity?: FrameLevel;
    weatherDiff?: Vpws50Diff;
    typhoonProbabilityMaxDaily5?: number | null;
    /** true のとき dispatchNotify が通知をスキップする。
     *  VPTA50 の連続ゼロ状態抑止に使用 (TyphoonProbabilityStateHolder 経由)。
     *  setter: processors (Task 16-18)、reader: dispatchNotify (Task 20)。 */
    suppressNotify?: boolean;
  };
}

/** 表示・通知・統計をまとめて抑制できる processor の共通戻り値。 */
export type SuppressibleProcessResult<TOutcome extends ProcessOutcomeBase> =
  | { kind: "ok"; outcome: TOutcome }
  | { kind: "suppressed" }
  | { kind: "parse-failed" };

export interface EewOutcome extends ProcessOutcomeBase {
  domain: "eew";
  parsed: ParsedEewInfo;
  state: {
    activeCount: number;
    colorIndex: number;
    isCancelled: boolean;
    diff?: EewDiff;
  };
  /** 通知用に EewUpdateResult 原本も保持 */
  eewResult: EewUpdateResult;
}

export interface EarthquakeOutcome extends ProcessOutcomeBase {
  domain: "earthquake";
  parsed: ParsedEarthquakeInfo;
  state?: {
    eventId?: string | null;
    representativeMaxInt?: string;
  };
}

export interface SeismicTextOutcome extends ProcessOutcomeBase {
  domain: "seismicText";
  parsed: ParsedSeismicTextInfo;
}

export interface LgObservationOutcome extends ProcessOutcomeBase {
  domain: "lgObservation";
  parsed: ParsedLgObservationInfo;
}

export interface TsunamiOutcome extends ProcessOutcomeBase {
  domain: "tsunami";
  parsed: ParsedTsunamiInfo;
  state: {
    levelBefore: string | null;
    levelAfter: string | null;
    changed: boolean;
  };
}

export interface VolcanoOutcome extends ProcessOutcomeBase {
  domain: "volcano";
  parsed: ParsedVolcanoInfo;
  volcanoPresentation: VolcanoPresentation;
  state: {
    isRenotification: boolean;
    trackedBefore?: string | null;
    trackedAfter?: string | null;
  };
}

export interface VolcanoBatchOutcome extends ProcessOutcomeBase {
  domain: "volcano";
  parsed: ParsedVolcanoAshfallInfo[];
  sources: Array<{ info: ParsedVolcanoAshfallInfo; msg: WsDataMessage }>;
  isBatch: true;
  volcanoPresentation: VolcanoPresentation;
  batchReportDateTime: string;
  batchIsTest: boolean;
}

export interface NankaiTroughOutcome extends ProcessOutcomeBase {
  domain: "nankaiTrough";
  parsed: ParsedNankaiTroughInfo;
}

export interface WeatherOutcome extends ProcessOutcomeBase {
  domain: "weather";
  parsed: ParsedWeatherWarning;
}

export interface TornadoOutcome extends ProcessOutcomeBase {
  domain: "tornado";
  parsed: ParsedTornadoAdvisory;
}

export interface BriefingOutcome extends ProcessOutcomeBase {
  domain: "briefing";
  parsed: ParsedWeatherBriefing;
}

export interface EarlyWeatherOutcome extends ProcessOutcomeBase {
  domain: "earlyWeather";
  parsed: ParsedEarlyWeatherInfo;
}

export interface WeatherWarningTimeseriesOutcome extends ProcessOutcomeBase {
  domain: "weatherWarningTimeseries";
  parsed: ParsedWeatherWarningTimeseriesInfo;
}

export interface ClimateInfoOutcome extends ProcessOutcomeBase {
  domain: "climateInfo";
  parsed: ParsedClimateInfo;
}

export interface WeatherExplanationOutcome extends ProcessOutcomeBase {
  domain: "weatherExplanation";
  parsed: ParsedWeatherExplanation;
}

export interface HeatAlertOutcome extends ProcessOutcomeBase {
  domain: "heatAlert";
  parsed: ParsedHeatAlertInfo;
}

export interface TyphoonAnalysisOutcome extends ProcessOutcomeBase {
  domain: "typhoonAnalysis";
  parsed: ParsedTyphoonAnalysis;
}

export interface TyphoonProbabilityOutcome extends ProcessOutcomeBase {
  domain: "typhoonProbability";
  parsed: ParsedTyphoonProbability;
}

/**
 * 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の Outcome。
 * Task 4 (compile unit) では interface 宣言のみ。dispatch / state holder は
 * Task 25b 以降で本実装。`diff` は FloodForecastStateHolder.diffAndUpdate の
 * 結果を保持する（後段 dispatchNotify が station-level diff を通知本文化する
 * ための情報源。shape は `FloodForecastDiff` を source of truth とする）。
 */
export interface FloodForecastOutcome extends ProcessOutcomeBase {
  domain: "floodForecast";
  parsed: ParsedFloodForecastInfo;
  /** FloodForecastStateHolder.diffAndUpdate の結果。Task 23 で本実装に差し替え。未確定時は null */
  diff: FloodForecastDiff | null;
  /**
   * resolveFloodForecastLevels で導出した最大 FloodLevel
   * (formatter / summary tokens が rank 表示等で使う source of truth)。
   */
  maxLevel: FloodLevel;
  /** FLOOD_LEVEL_RANK[maxLevel]。並び替え・しきい値比較用 */
  maxRank: number;
}

export interface RawOutcome extends ProcessOutcomeBase {
  domain: "raw";
  parsed: null;
}

export type ProcessOutcome =
  | EewOutcome
  | EarthquakeOutcome
  | SeismicTextOutcome
  | LgObservationOutcome
  | TsunamiOutcome
  | VolcanoOutcome
  | VolcanoBatchOutcome
  | NankaiTroughOutcome
  | WeatherOutcome
  | TornadoOutcome
  | BriefingOutcome
  | EarlyWeatherOutcome
  | WeatherWarningTimeseriesOutcome
  | ClimateInfoOutcome
  | WeatherExplanationOutcome
  | HeatAlertOutcome
  | TyphoonAnalysisOutcome
  | TyphoonProbabilityOutcome
  | FloodForecastOutcome
  | RawOutcome;

// ── PresentationEvent ──

export interface PresentationAreaItem {
  name: string;
  code?: string;
  kind?: string;
  maxInt?: string;
  maxLgInt?: string;
  flags?: string[];
  /** 津波予報区の予想波高記述 (tsunami ドメインのみ使用) */
  maxHeightDescription?: string;
  /** 津波予報区の第一波到達予想記述 (tsunami ドメインのみ使用) */
  firstHeight?: string;
}

export interface PresentationQuakeIntensityItem {
  name: string;
  code: string;
  maxInt: string;
  maxIntRank: number;
  maxLgInt?: string;
}

export interface PresentationQuakeIntensity {
  localAreas: PresentationQuakeIntensityItem[];
  municipalities: PresentationQuakeIntensityItem[];
}

/** EEW 予測震度地域の詳細 (地域別表示用、Phase A) */
export interface PresentationEewRegion {
  name: string;
  intensity: string;
  intensityTo: string | null;
  isPlum: boolean;
  hasArrived: boolean;
  arrivalTime: string | null;
}

/** 津波観測点 (沖合/沿岸観測) を予報区の警報種別と対応付けたもの (Phase A) */
export interface PresentationTsunamiObservation {
  areaName: string | null;
  areaKind: string | null;
  stationCode?: string | null;
  stationName: string;
  arrivalTime: string | null;
  initial: string | null;
  maxHeightValue: string | null;
  condition: string | null;
  heightCondition?: string | null;
}

export type EventStateSnapshot =
  | { kind: "eew"; activeCount: number; colorIndex: number; isCancelled: boolean; diff?: EewDiff }
  | { kind: "tsunami"; levelBefore: string | null; levelAfter: string | null; changed: boolean }
  | { kind: "volcano"; isRenotification: boolean };

export type ParsedTelegramUnion =
  | ParsedEewInfo
  | ParsedEarthquakeInfo
  | ParsedSeismicTextInfo
  | ParsedLgObservationInfo
  | ParsedTsunamiInfo
  | ParsedNankaiTroughInfo
  | ParsedVolcanoInfo
  | ParsedVolcanoAshfallInfo[]
  | ParsedWeatherWarning
  | ParsedTornadoAdvisory
  | ParsedWeatherBriefing
  | ParsedEarlyWeatherInfo
  | ParsedWeatherWarningTimeseriesInfo
  | ParsedClimateInfo
  | ParsedWeatherExplanation
  | ParsedHeatAlertInfo
  | ParsedTyphoonAnalysis
  | ParsedTyphoonProbability
  | ParsedFloodForecastInfo
  | null;

export interface PresentationEvent {
  // 識別
  id: string;
  classification: string;
  domain: PresentationDomain;
  type: string;
  subType?: string;

  // 共通メタ
  infoType: string;
  title: string;
  /** Control.Title (電文自身の名乗り。weatherExplanation で全般/地方を出し分け) */
  controlTitle?: string;
  headline: string | null;
  reportDateTime: string;
  publishingOffice: string;
  isTest: boolean;

  // レベル
  frameLevel: FrameLevel;
  soundLevel?: SoundLevel;
  notifyCategory?: NotifyCategory;
  /** 色専用の集約 severity (weather 系のみ。summaryRole が frameLevel 素通しの代わりに使う)。
   *  静音化で frameLevel が info 降格しても色は集約 severity を保つための分離フィールド。 */
  displaySeverity?: FrameLevel | null;
  /** VPWS50 state 更新の確度 (weather 系のみ)。unsafe = state を更新しないまま outcome が
   *  通った報。display の昇格判定はこの報を再昇格契機にしない。欠落は confirmed 扱い。 */
  weatherConfidence?: Vpws50Diff["confidence"];

  // 状態フラグ
  isCancellation: boolean;
  isWarning?: boolean;
  isFinal?: boolean;
  isAssumedHypocenter?: boolean;
  isRenotification?: boolean;

  // イベント追跡
  eventId?: string | null;
  serial?: string | null;
  volcanoCode?: string | null;
  volcanoName?: string | null;

  // 震源情報
  originTime?: string | null;
  hypocenterName?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  depth?: string | null;
  magnitude?: string | null;

  // 強度
  maxInt?: string | null;
  maxIntRank?: number | null;
  maxLgInt?: string | null;
  maxLgIntRank?: number | null;
  forecastMaxInt?: string | null;
  forecastMaxIntRank?: number | null;
  alertLevel?: number | null;

  // 付帯情報
  nextAdvisory?: string | null;
  warningComment?: string | null;
  bodyText?: string | null;

  // 地域集約
  areaNames: string[];
  forecastAreaNames: string[];
  municipalityNames: string[];
  observationNames: string[];
  areaCount: number;
  forecastAreaCount: number;
  municipalityCount: number;
  observationCount: number;

  areaItems: PresentationAreaItem[];

  // code欠落除外・重複集約済みの地震中間表現。Phase 3でmap stateへ射影する
  quakeIntensity?: PresentationQuakeIntensity;

  // EEW 予測震度地域の詳細 (Phase A、eew ドメインのみ使用)
  eewRegions?: PresentationEewRegion[];

  // 津波観測点 (Phase A、tsunami ドメインのみ使用)
  tsunamiObservations?: PresentationTsunamiObservation[];

  // 地震の津波コメントから導出した「津波」表示フラグ (Phase A、earthquake ドメインのみ使用)
  tsunamiWarning?: boolean;

  // filter 用
  tsunamiKinds?: string[];
  infoSerialCode?: string | null;

  // 台風の暴風域に入る確率
  typhoonProbabilityMaxDaily5?: number | null;

  // 原本
  raw: ParsedTelegramUnion;

  // 状態スナップショット
  stateSnapshot?: EventStateSnapshot;
}
