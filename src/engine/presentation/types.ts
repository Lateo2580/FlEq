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
} from "../../types";
import type { EewDiff, EewUpdateResult } from "../eew/eew-tracker";
import type { VolcanoPresentation } from "../notification/volcano-presentation";
import type { StatsCategory } from "../messages/telegram-stats";

// ── PresentationDomain ──

export type PresentationDomain =
  | "eew"
  | "earthquake"
  | "seismicText"
  | "lgObservation"
  | "tsunami"
  | "volcano"
  | "nankaiTrough"
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
  };
}

export interface EewOutcome extends ProcessOutcomeBase {
  domain: "eew";
  parsed: ParsedEewInfo;
  state: {
    activeCount: number;
    colorIndex: number;
    isDuplicate: boolean;
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
  isBatch: true;
  volcanoPresentation: VolcanoPresentation;
  batchReportDateTime: string;
  batchIsTest: boolean;
}

export interface NankaiTroughOutcome extends ProcessOutcomeBase {
  domain: "nankaiTrough";
  parsed: ParsedNankaiTroughInfo;
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
  | RawOutcome;

// ── PresentationEvent ──

export interface PresentationAreaItem {
  name: string;
  code?: string;
  kind?: string;
  maxInt?: string;
  maxLgInt?: string;
  flags?: string[];
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
  headline: string | null;
  reportDateTime: string;
  publishingOffice: string;
  isTest: boolean;

  // レベル
  frameLevel: FrameLevel;
  soundLevel?: SoundLevel;
  notifyCategory?: NotifyCategory;

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

  // filter 用
  tsunamiKinds?: string[];
  infoSerialCode?: string | null;

  // 原本
  raw: ParsedTelegramUnion;

  // 状態スナップショット
  stateSnapshot?: EventStateSnapshot;
}
