import type { ParsedEewInfo, TelegramRevision } from "../../types";
import { telegramRevision } from "../../dmdata/telegram-meta";
import * as intensityUtils from "../../utils/intensity";
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
  /** 深さ変化 (前の値) */
  previousDepth?: string;
  /** 最大予測震度変化 (前の値) */
  previousMaxInt?: string;
  /** 震源地名が変わったか */
  hypocenterChange?: boolean;
}

/** head.type ごとのシリアル・前回情報 */
interface EewTypeState {
  previousInfo?: ParsedEewInfo;
}

interface EewTerminalOwner {
  revisionFamily: string;
  revision: TelegramRevision;
}

/** EEW イベントの状態 */
interface EewEvent {
  eventId: string;
  /** head.type (VXSE43/44/45) ごとのシリアル・前回情報 */
  byType: Map<string, EewTypeState>;
  /** VXSE45 を一度でも受信したか */
  hasSeen45: boolean;
  /** 警報を一度でも発出したか (イベント単位) */
  hasWarningIssued: boolean;
  isCancelled: boolean;
  /** 最終報を受信済みか */
  isFinalized: boolean;
  /** cancel/final を成立させた family と revision */
  terminalOwner: EewTerminalOwner | null;
  lastUpdate: Date;
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex: number;
}

/** EewTracker.update() の戻り値 */
export interface EewUpdateResult {
  /** 新規イベントか */
  isNew: boolean;
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
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex: number;
}

/** 古いイベントを自動削除するまでの時間 (ミリ秒) */
const CLEANUP_THRESHOLD_MS = 10 * 60 * 1000; // 10分
let eewSingleEventSequence = 0;

function nextEewSingleSubjectKey(headType: string): string {
  eewSingleEventSequence += 1;
  return `eew:single:${headType}:${eewSingleEventSequence}`;
}

/** 深さ文字列から数値(km)を抽出 */
function parseDepthKm(depth: string): number | null {
  const m = depth.match(/(\d+)\s*km/);
  return m ? parseInt(m[1], 10) : null;
}

/** 予測震度リストから最大震度を取得 (To 基準・悲観側。spec 4.5)。logger 等の他モジュールとも共有 */
export function getMaxForecastIntensity(
  areas: { name: string; intensity: string; intensityTo?: string }[]
): string | null {
  if (areas.length === 0) return null;
  let maxInt = intensityUtils.eewPessimisticIntensity(areas[0].intensity, areas[0].intensityTo);
  let maxRank = intensityUtils.intensityToRank(maxInt);
  for (let i = 1; i < areas.length; i++) {
    const candidate = intensityUtils.eewPessimisticIntensity(areas[i].intensity, areas[i].intensityTo);
    const rank = intensityUtils.intensityToRank(candidate);
    if (rank > maxRank) {
      maxRank = rank;
      maxInt = candidate;
    }
  }
  return maxInt;
}

/** 2つの EEW 情報から差分を計算 */
function computeDiff(prev: ParsedEewInfo, curr: ParsedEewInfo): EewDiff | undefined {
  const diff: EewDiff = {};
  let hasDiff = false;

  // マグニチュード変化
  if (prev.earthquake?.magnitude && curr.earthquake?.magnitude) {
    const prevMag = parseFloat(prev.earthquake.magnitude);
    const currMag = parseFloat(curr.earthquake.magnitude);
    if (!isNaN(prevMag) && !isNaN(currMag) && prevMag !== currMag) {
      diff.previousMagnitude = prev.earthquake.magnitude;
      hasDiff = true;
    }
  }

  // 深さ変化
  if (prev.earthquake?.depth && curr.earthquake?.depth) {
    const prevD = parseDepthKm(prev.earthquake.depth);
    const currD = parseDepthKm(curr.earthquake.depth);
    if (prevD != null && currD != null && prevD !== currD) {
      diff.previousDepth = prev.earthquake.depth;
      hasDiff = true;
    }
  }

  // 最大予測震度変化 (配列順に依存せず最大値を正規化して比較)
  if (prev.forecastIntensity?.areas.length && curr.forecastIntensity?.areas.length) {
    const prevMax = getMaxForecastIntensity(prev.forecastIntensity.areas);
    const currMax = getMaxForecastIntensity(curr.forecastIntensity.areas);
    if (prevMax && currMax && prevMax !== currMax) {
      diff.previousMaxInt = prevMax;
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
  update(info: ParsedEewInfo): EewUpdateResult {
    // 古いイベントをクリーンアップ
    this.cleanup();

    const eventId = info.eventId || "";
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
      return {
        isNew: !revisionDecision.isCorrection,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled,
        isSuppressed: false,
        isUpgradeToWarning: false,
        activeCount: this.getActiveCount(),
        colorIndex: 0,
      };
    }

    const existing = this.events.get(eventId);

    if (existing) {
      const typeState = existing.byType.get(headType);

      // 抑制判定: VXSE45 受信済みなら VXSE43/44 は抑制
      const isSuppressed = existing.hasSeen45 && (headType === "VXSE43" || headType === "VXSE44");

      // type 状態の更新 (抑制されても serial・lastUpdate は更新する)
      const previousInfo = typeState?.previousInfo;
      if (!typeState) {
        existing.byType.set(headType, { previousInfo: info });
      } else {
        typeState.previousInfo = info;
      }

      // hasSeen45 更新
      if (headType === "VXSE45") {
        existing.hasSeen45 = true;
      }

      // 差分計算: 同一 type 内の連続更新でのみ (初めての type では diff なし)
      const diff = previousInfo ? computeDiff(previousInfo, info) : undefined;

      // 警報昇格判定 (イベント単位)
      const isUpgradeToWarning = !isSuppressed && !existing.hasWarningIssued && info.isWarning;
      if (!isSuppressed) {
        existing.hasWarningIssued = existing.hasWarningIssued || info.isWarning;
      }
      this.applyAcceptedLifecycle(existing, info, revisionDecision);
      existing.lastUpdate = new Date();

      return {
        isNew: false,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled,
        isSuppressed,
        isUpgradeToWarning,
        activeCount: this.getActiveCount(),
        diff: isSuppressed ? undefined : diff,
        previousInfo,
        colorIndex: existing.colorIndex,
      };
    }

    // 新規イベント
    const colorIndex = this.nextColorIndex();
    const byType = new Map<string, EewTypeState>();
    byType.set(headType, { previousInfo: info });

    const isFinalized = !isCancelled && revisionDecision.isTerminal;
    this.events.set(eventId, {
      eventId,
      byType,
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
      lastUpdate: new Date(),
      colorIndex,
    });

    return {
      isNew: !revisionDecision.isCorrection,
      isDuplicate: false,
      isCorrection: revisionDecision.isCorrection,
      revisionDecision: revisionDecision.kind,
      isCancelled,
      isSuppressed: false,
      isUpgradeToWarning: false,
      activeCount: this.getActiveCount(),
      colorIndex,
    };
  }

  /** 常時表示抑制する VXSE44 でも共通 revision gate だけは通す。 */
  acceptSuppressed(info: ParsedEewInfo): TelegramRevisionDecision {
    this.cleanup();
    const eventId = info.eventId || "";
    return this.decideRevision(
      info,
      eventId,
      eventId === "" ? nextEewSingleSubjectKey(info.type) : null,
    );
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
  ): boolean {
    const eventId = info.eventId || "";
    const ev = this.events.get(eventId);
    if (ev == null) return false;
    const replaced = this.applyAcceptedLifecycle(ev, info, decision);
    ev.lastUpdate = new Date();
    return replaced;
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
      if (event != null) {
        for (const headType of event.byType.keys()) {
          this.revisionGate.clear("eew", headType, id);
        }
      }
      this.onCleanup?.(id);
    }
  }
}
