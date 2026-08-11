import type {
  IntensitySafetyRank,
  JmaIntensity,
  ParsedEewInfo,
  SpecialValue,
  TelegramRevision,
  WsDataMessage,
} from "../../types";
import { telegramRevision } from "../../dmdata/telegram-meta";
import * as intensityUtils from "../../utils/intensity";
import { specialValueCanonicalEquals } from "../../utils/magnitude";
import {
  depthValueFromLegacyScalar,
  magnitudeValueFromLegacyScalar,
} from "../magnitude-depth-persistence";
import {
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  type TelegramRevisionDecision,
  type TelegramRevisionDecisionKind,
} from "../messages/telegram-revision-gate";
import { eewRevisionFamilyPolicy } from "../messages/revision-family-registry";

/** EEW 更新時の差分情報 */
export interface EewDiff {
  /** マグニチュード変化 (前の値) */
  previousMagnitude?: string;
  /** マグニチュード変化 (前の canonical 値) */
  previousMagnitudeValue?: SpecialValue<number>;
  /** マグニチュード変化 (今回の canonical 値) */
  currentMagnitudeValue?: SpecialValue<number>;
  /** 深さ変化 (前の値) */
  previousDepth?: string;
  /** 深さ変化 (前の canonical 値) */
  previousDepthValue?: SpecialValue<number>;
  /** 深さ変化 (今回の canonical 値) */
  currentDepthValue?: SpecialValue<number>;
  /** 最大予測震度変化 (前の値) */
  previousMaxInt?: string;
  /** 震源地名が変わったか */
  hypocenterChange?: boolean;
}

/** head.type ごとのシリアル・前回情報 */
interface EewTypeState {
  previousInfo?: ParsedEewInfo;
  retainedForecastSafetyRank?: number;
}

interface EewTerminalOwner {
  revisionFamily: string;
  revision: TelegramRevision;
}

interface EewAuthoritativeDisplay {
  ownerType: string;
  info: ParsedEewInfo;
  message: WsDataMessage | null;
}

/** EEW イベントの状態 */
interface EewEvent {
  eventId: string;
  /** head.type (VXSE43/44/45) ごとのシリアル・前回情報 */
  byType: Map<string, EewTypeState>;
  /** type family をまたいで unknown が来ても降格させない EventID 単位の safety state。 */
  retainedForecastSafetyRank?: number;
  /** VXSE45 を一度でも受信したか */
  hasSeen45: boolean;
  /** 警報を一度でも発出したか (イベント単位) */
  hasWarningIssued: boolean;
  isCancelled: boolean;
  /** 最終報を受信済みか */
  isFinalized: boolean;
  /** cancel/final を成立させた family と revision */
  terminalOwner: EewTerminalOwner | null;
  /** 実際に表示資格を得た最後の非抑止・非終端 snapshot と owner。 */
  authoritativeDisplay: EewAuthoritativeDisplay | null;
  lastUpdate: Date;
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex: number;
}

/** EewTracker.update() の戻り値 */
export interface EewUpdateResult {
  /** 新規イベントか */
  isNew: boolean;
  /** EventID 単位の第1報通知 signal。通知層はこの値だけを消費する。 */
  firstReportSignal: boolean;
  /** 重複報か（既に同じ報数以上を受信済み） */
  isDuplicate: boolean;
  /** 共通 revision gate が訂正として受理したか */
  isCorrection?: boolean;
  /** 共通 revision gate の判定 */
  revisionDecision?: TelegramRevisionDecisionKind;
  /** キャンセル報か */
  isCancelled: boolean;
  /** VXSE45 受信後に到着した VXSE43/44 → 表示抑制 */
  isSuppressed: boolean;
  /** 予報→警報の昇格が発生したか (イベント単位で初回のみ) */
  isUpgradeToWarning: boolean;
  /** 現在アクティブなイベント数 */
  activeCount: number;
  /** 前回との差分情報 (更新時のみ) */
  diff?: EewDiff;
  /** 前回の EEW 情報 */
  previousInfo?: ParsedEewInfo;
  /** 今回報が明示した表示 snapshot。前回値で置換しない。 */
  currentForecastIntensity?: EewForecastIntensityEvaluation;
  /** unknown が連続しても直前の known safety state を降格させない rank。 */
  effectiveForecastSafetyRank?: number;
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex: number;
  /** 抑止 family の終端撤回で authoritative display card を復元する revision。 */
  displayRestoreRevision?: {
    sourceType: string;
    serial: string | null;
    isCorrection: boolean;
  };
}

export interface EewLifecycleReplacement {
  reactivated: boolean;
  authoritativeSnapshot: {
    info: ParsedEewInfo;
    message: WsDataMessage;
  } | null;
  effectiveForecastSafetyRank: number | null;
  colorIndex: number;
}

/** 古いイベントを自動削除するまでの時間 (ミリ秒) */
const CLEANUP_THRESHOLD_MS = 10 * 60 * 1000; // 10分
const FIRST_REPORT_SIGNAL_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_EEW_EVENTS = 512;
let eewSingleEventSequence = 0;

function nextEewSingleSubjectKey(headType: string): string {
  eewSingleEventSequence += 1;
  return `eew:single:${headType}:${eewSingleEventSequence}`;
}

type EewForecastIntensity = NonNullable<ParsedEewInfo["forecastIntensity"]>;
export type EewForecastArea = EewForecastIntensity["areas"][number];

const CANONICAL_INTENSITY: Record<string, JmaIntensity> = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5-": "5-", "5弱": "5-", "5+": "5+", "5強": "5+",
  "6-": "6-", "6弱": "6-", "6+": "6+", "6強": "6+", "7": "7",
};

const INTENSITY_BY_RANK: readonly JmaIntensity[] = [
  "0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7",
];

export interface EewForecastIntensityEvaluation {
  specialValue: SpecialValue<JmaIntensity>;
  safety: IntensitySafetyRank;
  /** range は upper、lower-only は lower。unknown は null のまま保持する。 */
  safetyRank: number | null;
  /** 既存 scalar consumer 向け。通常 range は安全側 upper、定性値は qualifier を保持する。 */
  summaryLabel: string;
  /** 地域行・ログ向けの From/To を含む完全な表記。 */
  detailLabel: string;
  /** safety rank 色へ渡せる canonical 値。unknown は null。 */
  colorIntensity: JmaIntensity | null;
  /** 最大候補の一部に数値化不能な明示状態があり、既知最大だけでは上限を確定できない。 */
  hasUnknownCandidates: boolean;
  /** 選択した候補とは別に、上限を確定できない候補が存在する。 */
  hasAdditionalUncertainCandidates: boolean;
}

export type EewIntensitySafetyGate = "pass" | "below" | "unknown";

function canonicalIntensity(value: string | null | undefined): JmaIntensity | null {
  if (value == null) return null;
  return CANONICAL_INTENSITY[value.normalize("NFKC").replace(/\s+/g, "")] ?? null;
}

function legacyAreaSpecialValue(area: EewForecastArea): SpecialValue<JmaIntensity> {
  const lower = canonicalIntensity(area.intensity);
  const rawTo = area.intensityTo;
  const upper = canonicalIntensity(rawTo);
  if (lower != null && rawTo == null) {
    return {
      raw: area.intensity,
      value: lower,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  if (lower != null && upper != null) {
    if (lower === upper) {
      return {
        raw: area.intensity,
        value: lower,
        condition: null,
        description: null,
        presence: "value",
        rawLowerBound: area.intensity,
        rawUpperBound: rawTo ?? area.intensity,
      };
    }
    return {
      raw: area.intensity,
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: lower,
      upperBound: upper,
      rawLowerBound: area.intensity,
      rawUpperBound: rawTo ?? null,
    };
  }
  if (lower != null && rawTo?.normalize("NFKC").trim().toLowerCase() === "over") {
    return {
      raw: area.intensity,
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: lower,
      upperBound: null,
      rawLowerBound: area.intensity,
      rawUpperBound: rawTo,
    };
  }
  const raw = rawTo == null ? area.intensity : `${area.intensity}〜${rawTo}`;
  return {
    raw,
    value: null,
    condition: null,
    description: null,
    presence: raw.trim() === "" ? "empty" : "unknown",
  };
}

function overallSpecialValue(forecast: EewForecastIntensity): SpecialValue<JmaIntensity> | null {
  if (forecast.maxIntValue != null) return forecast.maxIntValue;
  const value = canonicalIntensity(forecast.maxInt);
  if (value == null) return null;
  return {
    raw: forecast.maxInt ?? value,
    value,
    condition: null,
    description: null,
    presence: "value",
  };
}

export function eewForecastAreaSpecialValue(
  area: EewForecastArea,
): SpecialValue<JmaIntensity> {
  return area.intensityValue ?? legacyAreaSpecialValue(area);
}

function qualifierLabel(value: SpecialValue<JmaIntensity>): string | null {
  for (const candidate of [value.condition, value.description, value.raw]) {
    if (candidate != null && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

function intensityDetailLabel(value: SpecialValue<JmaIntensity>): string | null {
  switch (value.presence) {
    case "value":
      return value.value;
    case "missing":
      return null;
    case "empty":
      return "空欄";
    case "unknown":
      return qualifierLabel(value) ?? "不明";
    case "qualitative":
      return qualifierLabel(value)
        ?? (value.lowerBound == null ? "不明" : `${value.lowerBound}以上`);
    case "range": {
      if (value.lowerBound != null && value.upperBound != null) {
        return value.lowerBound === value.upperBound
          ? value.lowerBound
          : `${value.lowerBound}〜${value.upperBound}`;
      }
      if (value.lowerBound != null) {
        const rawUpper = value.rawUpperBound?.normalize("NFKC").trim().toLowerCase();
        return rawUpper === "over"
          ? `${value.lowerBound}程度以上`
          : `${value.lowerBound}以上`;
      }
      if (value.upperBound != null) return `${value.upperBound}以下`;
      return qualifierLabel(value) ?? "不明";
    }
  }
}

function intensitySummaryLabel(
  value: SpecialValue<JmaIntensity>,
  safety: IntensitySafetyRank,
): string | null {
  if (value.presence === "value") return value.value;
  if (value.presence === "range" && safety.kind === "known" && safety.upper != null) {
    return intensityDetailLabel(value);
  }
  return intensityDetailLabel(value);
}

export function evaluateEewForecastIntensity(
  specialValue: SpecialValue<JmaIntensity>,
): EewForecastIntensityEvaluation | null {
  if (specialValue.presence === "missing") return null;
  const safety = intensityUtils.evaluateIntensitySafetyRank(specialValue);
  const safetyRank = safety.kind === "known" ? safety.upper ?? safety.lower : null;
  const detailLabel = intensityDetailLabel(specialValue);
  const summaryLabel = intensitySummaryLabel(specialValue, safety);
  if (detailLabel == null || summaryLabel == null) return null;
  return {
    specialValue,
    safety,
    safetyRank,
    summaryLabel,
    detailLabel,
    colorIntensity: safetyRank == null ? null : INTENSITY_BY_RANK[safetyRank] ?? null,
    hasUnknownCandidates: safetyRank == null,
    hasAdditionalUncertainCandidates: false,
  };
}

export function evaluateEewForecastArea(
  area: EewForecastArea,
): EewForecastIntensityEvaluation | null {
  return evaluateEewForecastIntensity(eewForecastAreaSpecialValue(area));
}

function qualifierPriority(value: SpecialValue<JmaIntensity>): number {
  if (value.presence === "qualitative") return 3;
  if (value.presence === "range") return 2;
  if (value.presence === "value") return 1;
  if (value.presence === "unknown") return 2;
  if (value.presence === "empty") return 1;
  return 0;
}

function higherEewIntensity(
  current: EewForecastIntensityEvaluation | null,
  candidate: EewForecastIntensityEvaluation | null,
): EewForecastIntensityEvaluation | null {
  if (candidate == null) return current;
  if (current == null) return candidate;
  const hasUnknownCandidates = current.hasUnknownCandidates || candidate.hasUnknownCandidates;
  let selected: EewForecastIntensityEvaluation;
  if (candidate.safetyRank != null && current.safetyRank == null) {
    selected = candidate;
  } else if (candidate.safetyRank == null && current.safetyRank != null) {
    selected = current;
  } else if (candidate.safetyRank != null && current.safetyRank != null) {
    if (candidate.safetyRank > current.safetyRank) {
      selected = candidate;
    } else if (candidate.safetyRank < current.safetyRank) {
      selected = current;
    } else {
      selected = qualifierPriority(candidate.specialValue) > qualifierPriority(current.specialValue)
        ? candidate
        : current;
    }
  } else {
    selected = qualifierPriority(candidate.specialValue) > qualifierPriority(current.specialValue)
      ? candidate
      : current;
  }
  const unselected = selected === candidate ? current : candidate;
  const hasAdditionalUncertainCandidates = selected.hasAdditionalUncertainCandidates
    || unselected.hasAdditionalUncertainCandidates
    || unselected.hasUnknownCandidates;
  return selected.hasUnknownCandidates === hasUnknownCandidates
      && selected.hasAdditionalUncertainCandidates === hasAdditionalUncertainCandidates
    ? selected
    : { ...selected, hasUnknownCandidates, hasAdditionalUncertainCandidates };
}

function reflectAdditionalUncertainty(
  evaluation: EewForecastIntensityEvaluation | null,
): EewForecastIntensityEvaluation | null {
  if (
    evaluation == null
    || evaluation.safetyRank == null
    || !evaluation.hasAdditionalUncertainCandidates
  ) {
    return evaluation;
  }
  let summaryLabel: string;
  switch (evaluation.specialValue.presence) {
    case "value":
      summaryLabel = `${evaluation.summaryLabel}以上の可能性・一部不明`;
      break;
    case "range":
      summaryLabel = evaluation.safety.kind === "known" && evaluation.safety.upper == null
        ? `${evaluation.summaryLabel}・一部不明`
        : `${evaluation.summaryLabel}以上の可能性・一部不明`;
      break;
    case "qualitative":
    case "unknown":
    case "empty":
    case "missing":
      summaryLabel = `${evaluation.summaryLabel}・一部不明`;
      break;
  }
  return { ...evaluation, summaryLabel };
}

/**
 * EEW の全体 ForecastInt と地域別予測震度を同じ safety rank で解決する。
 * 地域なしの場合も全体値は評価する。表示 surface の生成可否は呼び出し側で決める。
 */
export function getMaxForecastIntensityEvaluation(
  forecast: EewForecastIntensity | null | undefined,
): EewForecastIntensityEvaluation | null {
  if (forecast == null) return null;
  let maximum: EewForecastIntensityEvaluation | null = null;
  for (const area of forecast.areas) {
    maximum = higherEewIntensity(maximum, evaluateEewForecastArea(area));
  }
  const overall = overallSpecialValue(forecast);
  maximum = higherEewIntensity(
    maximum,
    overall == null ? null : evaluateEewForecastIntensity(overall),
  );
  return reflectAdditionalUncertainty(maximum);
}

/** legacy caller 向け summary scalar。unknown は rank 0 へ畳まず qualifier を返す。 */
export function getMaxForecastIntensity(
  areas: EewForecastArea[],
): string | null {
  return getMaxForecastIntensityEvaluation({ areas })?.summaryLabel ?? null;
}

export function evaluateEewIntensitySafetyGate(
  evaluation: EewForecastIntensityEvaluation | null,
  minimumRank: number,
): EewIntensitySafetyGate {
  if (evaluation?.safetyRank == null) return "unknown";
  if (evaluation.safetyRank >= minimumRank) return "pass";
  return evaluation.hasUnknownCandidates ? "unknown" : "below";
}

export function retainKnownEewForecastSafetyRank(
  previous: number | null | undefined,
  current: EewForecastIntensityEvaluation | null | undefined,
): number | null {
  // null は ForecastInt 自体の構造的 missing。前回値を表示・安全判定へ流用しない。
  if (current == null) return null;
  if (previous == null) return current.safetyRank;
  if (current.safetyRank == null) return previous;
  const hasKnownUpper = current.safety.kind === "known" && current.safety.upper != null;
  if (!hasKnownUpper && current.safetyRank < previous) return previous;
  return current.safetyRank;
}

function maxKnownEewForecastSafetyRank(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.max(left, right);
}

function normalizedAreaCondition(area: EewForecastArea): string {
  return area.condition?.normalize("NFKC").replace(/\s+/g, "") ?? "";
}

export function eewAreaIsPlum(area: EewForecastArea): boolean {
  return area.isPlum === true || normalizedAreaCondition(area).includes("PLUM法");
}

export function eewAreaHasArrived(area: EewForecastArea): boolean {
  return area.hasArrived === true || normalizedAreaCondition(area).includes("既に主要動到達");
}

/** 2つの EEW 情報から差分を計算 */
function computeDiff(
  prev: ParsedEewInfo,
  curr: ParsedEewInfo,
  previousRetainedForecastSafetyRank?: number,
): EewDiff | undefined {
  const diff: EewDiff = {};
  let hasDiff = false;

  // マグニチュード変化。additive field のない旧 DTO は canonical へ移行して比較する。
  const prevMagnitudeValue = prev.earthquake?.magnitudeValue
    ?? magnitudeValueFromLegacyScalar(prev.earthquake?.magnitude ?? null);
  const currMagnitudeValue = curr.earthquake?.magnitudeValue
    ?? magnitudeValueFromLegacyScalar(curr.earthquake?.magnitude ?? null);
  if (!specialValueCanonicalEquals(prevMagnitudeValue, currMagnitudeValue)) {
    diff.previousMagnitude = prev.earthquake?.magnitude;
    diff.previousMagnitudeValue = prevMagnitudeValue;
    diff.currentMagnitudeValue = currMagnitudeValue;
    hasDiff = true;
  }

  // 深さ変化。小数・範囲・特殊値を scalar の再解析で失わない。
  const prevDepthValue = prev.earthquake?.depthValue
    ?? depthValueFromLegacyScalar(prev.earthquake?.depth ?? null);
  const currDepthValue = curr.earthquake?.depthValue
    ?? depthValueFromLegacyScalar(curr.earthquake?.depth ?? null);
  if (!specialValueCanonicalEquals(prevDepthValue, currDepthValue)) {
    diff.previousDepth = prev.earthquake?.depth;
    diff.previousDepthValue = prevDepthValue;
    diff.currentDepthValue = currDepthValue;
    hasDiff = true;
  }

  // 最大予測震度変化。known→unknown は既存の高い状態を降格させる根拠にしない。
  if (prev.forecastIntensity != null && curr.forecastIntensity != null) {
    const prevMax = getMaxForecastIntensityEvaluation(prev.forecastIntensity);
    const currMax = getMaxForecastIntensityEvaluation(curr.forecastIntensity);
    const previousSafetyRank = previousRetainedForecastSafetyRank ?? prevMax?.safetyRank ?? null;
    const rankChanged = previousSafetyRank !== currMax?.safetyRank;
    const currentHasKnownUpper = currMax?.safety.kind === "known" && currMax.safety.upper != null;
    const currentCanProveChange = currMax?.safetyRank != null && (
      previousSafetyRank == null
      || currMax.safetyRank > previousSafetyRank
      || currentHasKnownUpper && !currMax.hasUnknownCandidates
    );
    if (
      rankChanged
      && currentCanProveChange
      && prevMax != null
    ) {
      diff.previousMaxInt = prevMax.summaryLabel;
      hasDiff = true;
    }
  }

  // 震源地名変化
  if (prev.earthquake?.hypocenterName && curr.earthquake?.hypocenterName) {
    if (prev.earthquake.hypocenterName !== curr.earthquake.hypocenterName) {
      diff.hypocenterChange = true;
      hasDiff = true;
    }
  }

  return hasDiff ? diff : undefined;
}

/**
 * 複数の EEW イベントを EventID ごとに追跡し、
 * 重複報の検出・キャンセル状態の管理を行う。
 */
export class EewTracker {
  private events = new Map<string, EewEvent>();
  private suppressedForecastSafety = new Map<string, { rank: number; lastUpdate: Date }>();
  private firstReportSignalAt = new Map<string, number>();
  private readonly onCleanup?: (eventId: string) => void;
  private readonly onRevisionDecision?: (
    decision: TelegramRevisionDecision,
  ) => void;
  private readonly revisionGate = new TelegramRevisionGate();

  constructor(options?: {
    onCleanup?: (eventId: string) => void;
    onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  }) {
    this.onCleanup = options?.onCleanup;
    this.onRevisionDecision = options?.onRevisionDecision;
  }

  /** EEW 情報を受け取り、状態を更新して結果を返す */
  update(info: ParsedEewInfo, message?: WsDataMessage): EewUpdateResult {
    // 古いイベントをクリーンアップ
    this.cleanup();

    const eventId = this.validEventId(info) ?? "";
    const transientSubjectKey = eventId === ""
      ? nextEewSingleSubjectKey(info.type)
      : null;
    const revisionDecision = this.decideRevision(
      info,
      eventId,
      transientSubjectKey,
    );
    if (!revisionDecision.accepted) {
      const current = eventId === "" ? undefined : this.events.get(eventId);
      return {
        isNew: false,
        firstReportSignal: false,
        isDuplicate: true,
        isCancelled: current?.isCancelled ?? false,
        isSuppressed: false,
        isUpgradeToWarning: false,
        activeCount: this.getActiveCount(),
        colorIndex: current?.colorIndex ?? 0,
        revisionDecision: revisionDecision.kind,
      };
    }

    const isCancelled = info.infoType === "取消";
    const headType = info.type;
    if (revisionDecision.kind === "acceptTransient") {
      const currentForecastIntensity = getMaxForecastIntensityEvaluation(info.forecastIntensity);
      const effectiveForecastSafetyRank = currentForecastIntensity?.safetyRank ?? null;
      return {
        isNew: !revisionDecision.isCorrection,
        firstReportSignal: false,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled,
        isSuppressed: false,
        isUpgradeToWarning: false,
        activeCount: this.getActiveCount(),
        colorIndex: 0,
        ...(currentForecastIntensity != null ? { currentForecastIntensity } : {}),
        ...(effectiveForecastSafetyRank != null ? { effectiveForecastSafetyRank } : {}),
      };
    }

    const existing = this.events.get(eventId);

    if (existing) {
      const typeState = existing.byType.get(headType);
      const isFirst45 = headType === "VXSE45" && !existing.hasSeen45;
      const lifecycleAccepted = this.applyAcceptedLifecycle(existing, info, revisionDecision);

      // 抑制判定: VXSE45 受信済みなら VXSE43/44 は抑制
      const isSuppressed = (
        existing.hasSeen45 && (headType === "VXSE43" || headType === "VXSE44")
      ) || !lifecycleAccepted;

      // type 状態の更新 (抑制されても serial・lastUpdate は更新する)
      const previousInfo = typeState?.previousInfo;
      const previousRetainedForecastSafetyRank = typeState?.retainedForecastSafetyRank;
      const currentForecast = getMaxForecastIntensityEvaluation(info.forecastIntensity);
      const typeEffectiveForecastSafetyRank = retainKnownEewForecastSafetyRank(
        previousRetainedForecastSafetyRank,
        currentForecast,
      );
      const eventSafetyRank = isFirst45
        ? maxKnownEewForecastSafetyRank(
            existing.retainedForecastSafetyRank,
            this.suppressedForecastSafety.get(eventId)?.rank,
          )
        : existing.retainedForecastSafetyRank;
      const effectiveForecastSafetyRank = isSuppressed
        ? existing.retainedForecastSafetyRank ?? null
        : retainKnownEewForecastSafetyRank(
            eventSafetyRank,
            currentForecast,
          );
      if (!typeState) {
        existing.byType.set(headType, {
          previousInfo: info,
          ...(typeEffectiveForecastSafetyRank != null
            ? { retainedForecastSafetyRank: typeEffectiveForecastSafetyRank }
            : {}),
        });
      } else {
        typeState.previousInfo = info;
        typeState.retainedForecastSafetyRank = typeEffectiveForecastSafetyRank == null
          ? undefined
          : typeEffectiveForecastSafetyRank;
      }
      if (!isSuppressed) {
        existing.retainedForecastSafetyRank = effectiveForecastSafetyRank == null
          ? undefined
          : effectiveForecastSafetyRank;
        if (!isCancelled && !revisionDecision.isTerminal) {
          existing.authoritativeDisplay = {
            ownerType: headType,
            info,
            message: message ?? null,
          };
        }
      }

      // hasSeen45 更新
      if (headType === "VXSE45" && lifecycleAccepted) {
        existing.hasSeen45 = true;
        this.suppressedForecastSafety.delete(eventId);
      }

      // 差分計算: 同一 type 内の連続更新でのみ (初めての type では diff なし)
      const diff = previousInfo
        ? computeDiff(previousInfo, info, previousRetainedForecastSafetyRank)
        : undefined;

      // 警報昇格判定 (イベント単位)
      const isUpgradeToWarning = !isSuppressed && !existing.hasWarningIssued && info.isWarning;
      if (!isSuppressed) {
        existing.hasWarningIssued = existing.hasWarningIssued || info.isWarning;
      }
      existing.lastUpdate = new Date();

      const firstReportSignal = this.updateFirstReportSignalLatch({
        eventId,
        info,
        isSuppressed,
        isUpgradeToWarning,
        isCorrection: revisionDecision.isCorrection,
        isTerminal: revisionDecision.isTerminal,
      });

      return {
        isNew: false,
        firstReportSignal,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled,
        isSuppressed,
        isUpgradeToWarning,
        activeCount: this.getActiveCount(),
        diff: isSuppressed ? undefined : diff,
        previousInfo,
        ...(currentForecast != null ? { currentForecastIntensity: currentForecast } : {}),
        ...(effectiveForecastSafetyRank != null ? { effectiveForecastSafetyRank } : {}),
        colorIndex: existing.colorIndex,
      };
    }

    // 新規イベント
    const colorIndex = this.nextColorIndex();
    const byType = new Map<string, EewTypeState>();
    const currentForecastIntensity = getMaxForecastIntensityEvaluation(info.forecastIntensity);
    const suppressedSafetyRank = this.suppressedForecastSafety.get(eventId)?.rank;
    const effectiveForecastSafetyRank = retainKnownEewForecastSafetyRank(
      suppressedSafetyRank,
      currentForecastIntensity,
    );
    this.suppressedForecastSafety.delete(eventId);
    byType.set(headType, {
      previousInfo: info,
      ...(currentForecastIntensity?.safetyRank != null
        ? { retainedForecastSafetyRank: currentForecastIntensity.safetyRank }
        : {}),
    });

    const isFinalized = !isCancelled && revisionDecision.isTerminal;
    this.events.set(eventId, {
      eventId,
      byType,
      ...(effectiveForecastSafetyRank != null
        ? { retainedForecastSafetyRank: effectiveForecastSafetyRank }
        : {}),
      hasSeen45: headType === "VXSE45",
      hasWarningIssued: info.isWarning,
      isCancelled,
      isFinalized,
      terminalOwner: isCancelled || isFinalized
        ? {
            revisionFamily: headType,
            revision: telegramRevision(info.meta),
          }
        : null,
      authoritativeDisplay: !isCancelled && !isFinalized
        ? { ownerType: headType, info, message: message ?? null }
        : null,
      lastUpdate: new Date(),
      colorIndex,
    });
    this.enforceEventLimit();

    const firstReportSignal = this.updateFirstReportSignalLatch({
      eventId,
      info,
      isSuppressed: false,
      isUpgradeToWarning: false,
      isCorrection: revisionDecision.isCorrection,
      isTerminal: revisionDecision.isTerminal,
    });

    return {
      isNew: !revisionDecision.isCorrection,
      firstReportSignal,
      isDuplicate: false,
      isCorrection: revisionDecision.isCorrection,
      revisionDecision: revisionDecision.kind,
      isCancelled,
      isSuppressed: false,
      isUpgradeToWarning: false,
      activeCount: this.getActiveCount(),
      colorIndex,
      ...(currentForecastIntensity != null ? { currentForecastIntensity } : {}),
      ...(effectiveForecastSafetyRank != null ? { effectiveForecastSafetyRank } : {}),
    };
  }

  /** 常時表示抑制する VXSE44 でも共通 revision gate だけは通す。 */
  acceptSuppressed(info: ParsedEewInfo): TelegramRevisionDecision {
    this.cleanup();
    const eventId = this.validEventId(info) ?? "";
    const decision = this.decideRevision(
      info,
      eventId,
      eventId === "" ? nextEewSingleSubjectKey(info.type) : null,
    );
    const existing = eventId === "" ? undefined : this.events.get(eventId);
    const canSeedFirst45 = existing?.hasSeen45 !== true;
    if (
      decision.accepted
      && eventId !== ""
      && canSeedFirst45
      && info.infoType !== "取消"
      && !decision.isTerminal
    ) {
      const current = getMaxForecastIntensityEvaluation(info.forecastIntensity);
      const retainedRank = maxKnownEewForecastSafetyRank(
        this.suppressedForecastSafety.get(eventId)?.rank ?? existing?.retainedForecastSafetyRank,
        current?.safetyRank,
      );
      if (retainedRank == null) {
        this.suppressedForecastSafety.delete(eventId);
      } else {
        this.suppressedForecastSafety.set(eventId, { rank: retainedRank, lastUpdate: new Date() });
        this.enforceSuppressedForecastLimit();
      }
    } else if (decision.accepted && eventId !== "" && canSeedFirst45) {
      this.suppressedForecastSafety.delete(eventId);
    }
    return decision;
  }

  private decideRevision(
    info: ParsedEewInfo,
    eventId: string,
    transientSubjectKey: string | null,
  ): TelegramRevisionDecision {
    const policy = eewRevisionFamilyPolicy(info.type);
    if (policy == null) {
      const decision: TelegramRevisionDecision = {
        kind: "invalidMeta",
        relation: null,
            accepted: false,
            isCorrection: false,
            isTerminal: false,
            resolvedTrigger: null,
      };
      this.onRevisionDecision?.(decision);
      return decision;
    }
    const extractedSubject = policy.extractStateSubjectKey(info.meta, info);
    const stateSubjectKey =
      typeof extractedSubject === "string" ? extractedSubject : null;
    const normalizedSubjectKey =
      stateSubjectKey != null && stateSubjectKey === eventId
        ? stateSubjectKey
        : null;
    if (
      info.meta.infoType.value === "取消"
      && normalizedSubjectKey != null
    ) {
      const targets = policy.extractCancellationTarget(info.meta, info);
      if (
        targets == null
        || targets.length !== 1
        || targets[0] !== stateSubjectKey
      ) {
        const decision: TelegramRevisionDecision = {
          kind: "cancelTargetMismatch",
          relation: null,
              accepted: false,
              isCorrection: false,
              isTerminal: false,
              resolvedTrigger: null,
        };
        this.onRevisionDecision?.(decision);
        return decision;
      }
    }
    const revisionDecision = this.revisionGate.decide({
      domain: policy.domain,
      revisionFamily: policy.revisionFamily,
      stateSubjectKey: normalizedSubjectKey,
      transientSubjectKey,
      meta: info.meta,
      comparator: policy.comparator,
      cancellationPolicy: policy.cancellationPolicy,
      terminal: policy.terminalPredicate(info.meta, info),
      maxSubjects: policy.maxSubjects,
      payloadFingerprint: semanticPayloadFingerprint({
        ...info,
        meta: undefined,
        forecastIntensity: info.forecastIntensity == null
          ? undefined
          : {
              ...info.forecastIntensity,
              areas: [...info.forecastIntensity.areas].sort((a, b) =>
                a.name.localeCompare(b.name)
              ),
            },
      }),
    });
    this.onRevisionDecision?.(revisionDecision);
    return revisionDecision;
  }

  /**
   * イベントを終了扱いにする (最終報受信時)。
   * 遅延到着した重複報の検出のためエントリは保持し、
   * アクティブカウントからは除外する。
   */
  finalizeEvent(eventId: string): void {
    const ev = this.events.get(eventId);
    if (ev) {
      ev.isFinalized = true;
    }
  }

  /**
   * gate 受理済みの抑制 type から event 単位 lifecycle を更新する。
   * terminal の解除は、それを成立させた family 自身の訂正・新しい続報に限る。
   */
  replaceLifecycle(
    info: ParsedEewInfo,
    decision: TelegramRevisionDecision,
  ): EewLifecycleReplacement | null {
    const eventId = this.validEventId(info) ?? "";
    let ev = this.events.get(eventId);
    if (ev == null) {
      const isCancelled = info.infoType === "取消";
      if (!isCancelled && !decision.isTerminal) return null;
      const colorIndex = this.nextColorIndex();
      ev = {
        eventId,
        byType: new Map([[info.type, { previousInfo: info }]]),
        hasSeen45: info.type === "VXSE45",
        hasWarningIssued: info.isWarning,
        isCancelled,
        isFinalized: !isCancelled,
        terminalOwner: {
          revisionFamily: info.type,
          revision: telegramRevision(info.meta),
        },
        authoritativeDisplay: null,
        lastUpdate: new Date(),
        colorIndex,
      };
      this.events.set(eventId, ev);
      this.enforceEventLimit();
      return {
        reactivated: false,
        authoritativeSnapshot: this.authoritativeSnapshot(ev),
        effectiveForecastSafetyRank: ev.retainedForecastSafetyRank ?? null,
        colorIndex,
      };
    }
    const wasTerminal = ev.isCancelled || ev.isFinalized;
    const replaced = this.applyAcceptedLifecycle(ev, info, decision);
    ev.lastUpdate = new Date();
    if (!replaced) return null;
    return {
      reactivated: wasTerminal && !ev.isCancelled && !ev.isFinalized,
      authoritativeSnapshot: this.authoritativeSnapshot(ev),
      effectiveForecastSafetyRank: ev.retainedForecastSafetyRank ?? null,
      colorIndex: ev.colorIndex,
    };
  }

  private authoritativeSnapshot(event: EewEvent): EewLifecycleReplacement["authoritativeSnapshot"] {
    const display = event.authoritativeDisplay;
    if (display?.message == null) return null;
    return { info: display.info, message: display.message };
  }

  private applyAcceptedLifecycle(
    event: EewEvent,
    info: ParsedEewInfo,
    decision: TelegramRevisionDecision,
  ): boolean {
    const isCancelled = info.infoType === "取消";
    const isFinalized = !isCancelled && decision.isTerminal;
    if (isCancelled || isFinalized) {
      event.isCancelled = isCancelled;
      event.isFinalized = isFinalized;
      event.terminalOwner = {
        revisionFamily: info.type,
        revision: telegramRevision(info.meta),
      };
      return true;
    }

    if (event.isCancelled || event.isFinalized) {
      const owner = event.terminalOwner;
      const sameFamilyReplacement =
        owner?.revisionFamily === info.type
        && (decision.isCorrection || decision.relation === "newer");
      if (!sameFamilyReplacement) return false;
    }

    event.isCancelled = false;
    event.isFinalized = false;
    event.terminalOwner = null;
    return true;
  }

  /** valid な EventID だけを type 間相関と第1報 latch の subject にする。 */
  private validEventId(info: ParsedEewInfo): string | null {
    return info.meta.eventId.valid ? info.meta.eventId.value : null;
  }

  /** 同一 EventID で VXSE45 を受信済みか。invalid EventID は相関しない。 */
  hasSeen45(info: ParsedEewInfo): boolean {
    this.cleanup();
    const eventId = this.validEventId(info);
    return eventId != null && this.events.get(eventId)?.hasSeen45 === true;
  }

  /** accepted outcome と同じ同期遷移内で第1報 latch / TTL を更新する。 */
  private updateFirstReportSignalLatch(input: {
    eventId: string;
    info: ParsedEewInfo;
    isSuppressed: boolean;
    isUpgradeToWarning: boolean;
    isCorrection: boolean;
    isTerminal: boolean;
  }): boolean {
    if (input.eventId === "" || input.isSuppressed) return false;

    const now = Date.now();
    const previousSignalAt = this.firstReportSignalAt.get(input.eventId);
    if (
      previousSignalAt != null
      && now - previousSignalAt >= FIRST_REPORT_SIGNAL_TTL_MS
    ) {
      this.firstReportSignalAt.delete(input.eventId);
    }

    if (input.info.infoType === "取消") {
      this.firstReportSignalAt.delete(input.eventId);
      return false;
    }

    const firstReportSignal = input.info.infoType === "発表"
      && !input.isTerminal
      && !this.firstReportSignalAt.has(input.eventId);
    if (
      firstReportSignal
      || input.isUpgradeToWarning
      || input.isCorrection
      || input.isTerminal
    ) {
      this.firstReportSignalAt.set(input.eventId, now);
    }
    return firstReportSignal;
  }

  /** 未使用の最小カラーインデックスを返す */
  private nextColorIndex(): number {
    const used = new Set<number>();
    for (const ev of this.events.values()) {
      if (!ev.isCancelled && !ev.isFinalized) used.add(ev.colorIndex);
    }
    let idx = 0;
    while (used.has(idx)) idx++;
    return idx;
  }

  /** 現在アクティブ（キャンセル・最終報済みでない）イベント数を返す */
  getActiveCount(): number {
    let count = 0;
    for (const ev of this.events.values()) {
      if (!ev.isCancelled && !ev.isFinalized) count++;
    }
    return count;
  }

  /** 最終更新から一定時間経過したイベントを削除 */
  private cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, ev] of this.events) {
      if (now - ev.lastUpdate.getTime() > CLEANUP_THRESHOLD_MS) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      const event = this.events.get(id);
      this.events.delete(id);
      this.firstReportSignalAt.delete(id);
      if (event != null) {
        for (const headType of event.byType.keys()) {
          this.revisionGate.clear("eew", headType, id);
        }
      }
      this.onCleanup?.(id);
    }
    for (const [id, state] of this.suppressedForecastSafety) {
      if (now - state.lastUpdate.getTime() > CLEANUP_THRESHOLD_MS) {
        this.suppressedForecastSafety.delete(id);
      }
    }
    for (const [id, signalAt] of this.firstReportSignalAt) {
      if (now - signalAt >= FIRST_REPORT_SIGNAL_TTL_MS) {
        this.firstReportSignalAt.delete(id);
      }
    }
  }

  private enforceSuppressedForecastLimit(): void {
    while (this.suppressedForecastSafety.size > MAX_TRACKED_EEW_EVENTS) {
      const oldest = [...this.suppressedForecastSafety]
        .sort(([, left], [, right]) =>
          left.lastUpdate.getTime() - right.lastUpdate.getTime())[0];
      if (oldest == null) return;
      this.suppressedForecastSafety.delete(oldest[0]);
    }
  }

  private enforceEventLimit(): void {
    while (this.events.size > MAX_TRACKED_EEW_EVENTS) {
      const oldest = [...this.events]
        .sort(([, left], [, right]) =>
          left.lastUpdate.getTime() - right.lastUpdate.getTime())[0];
      if (oldest == null) return;
      const [id, event] = oldest;
      this.events.delete(id);
      this.firstReportSignalAt.delete(id);
      for (const headType of event.byType.keys()) {
        this.revisionGate.clear("eew", headType, id);
      }
      this.onCleanup?.(id);
    }
  }
}
