import type { FrameLevel } from "../../types";
import type { SoundLevel } from "../notification/sound-player";
import type { NotifyCategory, WsDataMessage } from "../../types";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedLgObservationInfo,
  ParsedTsunamiInfo,
  TsunamiObservationStation,
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
  ParsedLegacyCounterpartInfo,
  LegacyCounterpartCodeNamePair,
  LegacyCounterpartReason,
  LegacyCounterpartSeverity,
  FloodLevel,
  Vpws50Diff,
  JmaIntensity,
  JmaLgIntensity,
  SpecialValue,
  PlumeHeightSemantic,
} from "../../types";
import type { EewDiff, EewUpdateResult } from "../eew/eew-tracker";
import type { VolcanoPresentation } from "./volcano-presentation";
import type { StatsCategory } from "../messages/telegram-stats";
import type { FloodForecastDiff } from "../messages/flood-forecast-state";
import type {
  CancellationPolicy,
  CancellationTrigger,
} from "../messages/telegram-revision-gate";

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
  | "legacyCounterpart"
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
    /** 共通 revision gate で commit 済みの訂正だけを通知統計へ載せる。 */
    acceptedCorrection?: boolean;
    /** transient family の共通 gate が authoritative に受理した報。 */
    foundationMutationAccepted?: boolean;
    /** 共通 gate が一意に解決した cancellation trigger。raw InfoType の再判定には使わない。 */
    foundationResolvedTrigger?: CancellationTrigger | null;
    /** resolvedTrigger に適用された registry policy。 */
    foundationCancellationPolicy?: CancellationPolicy;
    /** weather の durable holder/gate mutation が authoritative に commit 済みか。 */
    weatherStateMutationAccepted?: boolean;
    /** 複数 subject の union を永続化するときに使う正規 revision。active が空なら null。 */
    weatherStateRevision?: { reportDateTime: string; serial: string | null } | null;
    /** volcano の durable holder/gate mutation が authoritative に commit 済みか。 */
    volcanoStateMutationAccepted?: boolean;
    /** 同一電文内で gate を通過した火山 subject。standby projection の対象限定に使う。 */
    volcanoAcceptedSubjects?: string[];
    volcanoActiveAlertSubjects?: string[];
    volcanoActiveEruptionSubjects?: string[];
    /** flood durable holder/gate mutation was committed authoritatively. */
    floodStateMutationAccepted?: boolean;
    /** Active EventIDs after gate compaction; projection uses this to mirror eviction. */
    floodActiveEventIds?: string[];
    /** Accepted semantic envelope whose flood projection path is about to run. */
    floodAppliedSemanticKey?: string;
    /** Phase 3B standby family gate result. false is display/ticker-only fail-open. */
    standbyStateMutationAccepted?: boolean;
    standbyStateSubject?: string | null;
    standbyActiveSubjects?: string[];
    standbyAppliedSemanticKey?: string | null;
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
  /** 通常 pipeline を通さず display state command としてだけ ingest する。 */
  displayLifecycleOnly?: true;
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
  /** 受信電文の意味。通知・ticker・取消判定は必ずこちらを参照する。 */
  parsed: ParsedTsunamiInfo;
  /** holder 更新後の安全側 aggregate。カード・背景・frame 専用。 */
  displaySnapshot: ParsedTsunamiInfo;
  state: {
    levelBefore: string | null;
    levelAfter: string | null;
    changed: boolean;
    /** VTSE41 表示時に、先着して holder に保留されていた VTSE51/52 観測を合流する。 */
    presentationObservationGroups?: {
      VTSE51: TsunamiObservationStation[];
      VTSE52: TsunamiObservationStation[];
    };
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

/** VPOA50／VPNO50／VXWW50 の header-only fail-open outcome。 */
export interface LegacyCounterpartOutcome extends ProcessOutcomeBase {
  domain: "legacyCounterpart";
  parsed: ParsedLegacyCounterpartInfo;
  reason: LegacyCounterpartReason;
  severity: LegacyCounterpartSeverity;
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
  | LegacyCounterpartOutcome
  | RawOutcome;

// ── PresentationEvent ──

export interface PresentationAreaItem {
  name: string;
  /** 津波予報区の Area.Code。名称から推定しない。 */
  areaCode?: string | null;
  /** 津波予報区の Category/Kind/Code。名称から推定しない。 */
  kindCode?: string | null;
  code?: string;
  kind?: string;
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt?: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt?: string;
  flags?: string[];
  /** 津波予報区の予想波高記述 (tsunami ドメインのみ使用) */
  maxHeightDescription?: string;
  /** 津波予報区の MaxHeight/TsunamiHeight semantic source。display projection 専用。 */
  maxHeight?: SpecialValue<number>;
  /** 津波予報区の第一波到達予想記述 (tsunami ドメインのみ使用) */
  firstHeight?: string;
}

export interface PresentationQuakeIntensityItem {
  name: string;
  code: string;
  /** 新 parser/presentation 経路では設定。旧 scalar adapter の手組み入力では省略可。 */
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt: string;
  maxIntRank: number;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt?: string;
}

export interface PresentationQuakeIntensity {
  localAreas: PresentationQuakeIntensityItem[];
  municipalities: PresentationQuakeIntensityItem[];
}

/** exact 発火閾値とは独立して、Area/City が明示した SpecialValue を保持する。 */
export interface PresentationQuakeIntensityValueItem {
  name: string;
  code: string | null;
  maxIntValue: SpecialValue<JmaIntensity>;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
}

export interface PresentationQuakeIntensityValues {
  localAreas: PresentationQuakeIntensityValueItem[];
  municipalities: PresentationQuakeIntensityValueItem[];
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
  /** 観測点が属する津波予報区の Area.Code。名称から推定しない。 */
  areaCode?: string | null;
  /** 観測点へ対応付けた予報区の Kind.Code。未結合時は省略する。 */
  kindCode?: string | null;
  stationCode?: string | null;
  stationName: string;
  arrivalTime: string | null;
  initial: string | null;
  maxHeightValue: string | null;
  /** 観測点の MaxHeight/TsunamiHeight semantic source。display projection 専用。 */
  maxHeight?: SpecialValue<number>;
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
  | ParsedLegacyCounterpartInfo
  | null;

export interface PresentationEvent {
  // 識別
  id: string;
  classification: string;
  domain: PresentationDomain;
  type: string;
  subType?: string;
  /** 通常 event と状態を共有しない診断テロップの種別 */
  diagnosticKind?: "invalidReportDateTime" | "futureSkewExceeded";

  // 共通メタ
  infoType: string;
  title: string;
  /** Control.Title (電文自身の名乗り。weatherExplanation で全般/地方を出し分け) */
  controlTitle?: string;
  headline: string | null;
  reportDateTime: string;
  publishingOffice: string;
  isTest: boolean;

  /** legacy counterpart の fail-open qualifier／未確定 severity。 */
  legacyReason?: LegacyCounterpartReason;
  legacySeverity?: LegacyCounterpartSeverity;
  legacyAreas?: LegacyCounterpartCodeNamePair[];
  legacyPhenomena?: LegacyCounterpartCodeNamePair[];
  legacyKinds?: LegacyCounterpartCodeNamePair[];

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
  /** fail-open 表示と durable weather mutation を後段で分離する内部フラグ。 */
  weatherStateMutationAccepted?: boolean;
  /** active weather subject 群から導出した union 用正規 revision。 */
  weatherStateRevision?: { reportDateTime: string; serial: string | null } | null;
  /** fail-open 表示と durable volcano mutation を後段で分離する内部フラグ。 */
  volcanoStateMutationAccepted?: boolean;
  /** gate 通過済みの alert/eruption subject。 */
  volcanoAcceptedSubjects?: string[];
  volcanoActiveAlertSubjects?: string[];
  volcanoActiveEruptionSubjects?: string[];
  /** fail-open display and authoritative flood projection are separated here. */
  floodStateMutationAccepted?: boolean;
  floodActiveEventIds?: string[];
  floodAppliedSemanticKey?: string;
  standbyStateMutationAccepted?: boolean;
  standbyStateSubject?: string | null;
  standbyActiveSubjects?: string[];
  standbyAppliedSemanticKey?: string | null;
  foundationMutationAccepted?: boolean;
  foundationResolvedTrigger?: CancellationTrigger | null;
  foundationCancellationPolicy?: CancellationPolicy;

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
  /** Parser canonical。既存 scalar は legacy consumer 用に並存する。 */
  depthValue?: SpecialValue<number>;
  /** Parser canonical。既存 scalar は legacy consumer 用に並存する。 */
  magnitudeValue?: SpecialValue<number>;

  // 強度
  maxIntValue?: SpecialValue<JmaIntensity>;
  /** compact/focus を含む表示出口で SpecialValue qualifier を失わない表示ラベル。 */
  maxIntLabel?: string | null;
  maxInt?: string | null;
  maxIntRank?: number | null;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  /** compact/focus を含む表示出口で長周期階級 qualifier を失わない表示ラベル。 */
  maxLgIntLabel?: string | null;
  maxLgInt?: string | null;
  maxLgIntRank?: number | null;
  forecastMaxInt?: string | null;
  forecastMaxIntRank?: number | null;
  /** 抑止 EEW family の終端撤回に伴う display 復元 command。 */
  eewDisplayRestoreRevision?: {
    sourceType: string;
    serial: string | null;
    isCorrection: boolean;
  };
  alertLevel?: number | null;
  /** Parser canonical。既存 volcano scalar は互換 consumer 用に並存する。 */
  plumeHeightAboveCraterValue?: PlumeHeightSemantic;
  /** 海抜 FT は表示追加せず canonical propagation のみ行う。 */
  plumeHeightAboveSeaLevelValue?: PlumeHeightSemantic;

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
  /** 非 exact を含む震度構造。地図発火は後続単位、missing 判定には本単位から使用する。 */
  quakeIntensityValues?: PresentationQuakeIntensityValues;

  // EEW 予測震度地域の詳細 (Phase A、eew ドメインのみ使用)
  eewRegions?: PresentationEewRegion[];

  // 津波観測点 (Phase A、tsunami ドメインのみ使用)
  tsunamiObservations?: PresentationTsunamiObservation[];
  /** カード・背景用の安全側 aggregate。受信電文由来の filter/ticker field と分離する。 */
  tsunamiDisplay?: {
    kinds: string[];
    areaItems: PresentationAreaItem[];
    warningComment: string | null;
  };
  /** display server 内部で family 別 clear を維持するための非 wire bridge。 */
  tsunamiObservationGroups?: {
    VTSE51: PresentationTsunamiObservation[];
    VTSE52: PresentationTsunamiObservation[];
  };

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
