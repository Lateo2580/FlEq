import { ParsedEewInfo } from "../../types";
import * as intensityUtils from "../../utils/intensity";

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
  lastSerial: number;
  previousInfo?: ParsedEewInfo;
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

/** 深さ文字列から数値(km)を抽出 */
function parseDepthKm(depth: string): number | null {
  const m = depth.match(/(\d+)\s*km/);
  return m ? parseInt(m[1], 10) : null;
}

/** 予測震度リストから最大震度を取得 */
function getMaxForecastIntensity(areas: { name: string; intensity: string }[]): string | null {
  if (areas.length === 0) return null;
  let maxInt = areas[0].intensity;
  let maxRank = intensityUtils.intensityToRank(maxInt);
  for (let i = 1; i < areas.length; i++) {
    const rank = intensityUtils.intensityToRank(areas[i].intensity);
    if (rank > maxRank) {
      maxRank = rank;
      maxInt = areas[i].intensity;
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

  constructor(options?: { onCleanup?: (eventId: string) => void }) {
    this.onCleanup = options?.onCleanup;
  }

  /** EEW 情報を受け取り、状態を更新して結果を返す */
  update(info: ParsedEewInfo): EewUpdateResult {
    // 古いイベントをクリーンアップ
    this.cleanup();

    const eventId = info.eventId || "";
    if (!eventId) {
      // EventID がない場合は常に新規扱い
      return {
        isNew: true,
        isDuplicate: false,
        isCancelled: info.infoType === "取消",
        isSuppressed: false,
        isUpgradeToWarning: false,
        activeCount: this.getActiveCount(),
        colorIndex: 0,
      };
    }

    const serialRaw = parseInt(info.serial || "", 10);
    const serial: number | null = Number.isFinite(serialRaw) ? serialRaw : null;
    const isCancelled = info.infoType === "取消";
    const headType = info.type;
    const existing = this.events.get(eventId);

    if (existing) {
      const typeState = existing.byType.get(headType);

      // 同一 type 内の重複判定
      if (!isCancelled && serial != null && serial > 0 && typeState && serial <= typeState.lastSerial) {
        return {
          isNew: false,
          isDuplicate: true,
          isCancelled: false,
          isSuppressed: false,
          isUpgradeToWarning: false,
          activeCount: this.getActiveCount(),
          colorIndex: existing.colorIndex,
        };
      }

      // 抑制判定: VXSE45 受信済みなら VXSE43/44 は抑制
      const isSuppressed = existing.hasSeen45 && (headType === "VXSE43" || headType === "VXSE44");

      // type 状態の更新 (抑制されても serial・lastUpdate は更新する)
      const previousInfo = typeState?.previousInfo;
      if (!typeState) {
        existing.byType.set(headType, { lastSerial: serial ?? 0, previousInfo: info });
      } else {
        if (serial != null) {
          typeState.lastSerial = Math.max(typeState.lastSerial, serial);
        }
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
      existing.isCancelled = isCancelled;
      existing.lastUpdate = new Date();

      return {
        isNew: false,
        isDuplicate: false,
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
    byType.set(headType, { lastSerial: serial ?? 0, previousInfo: info });

    this.events.set(eventId, {
      eventId,
      byType,
      hasSeen45: headType === "VXSE45",
      hasWarningIssued: info.isWarning,
      isCancelled,
      isFinalized: false,
      lastUpdate: new Date(),
      colorIndex,
    });

    return {
      isNew: true,
      isDuplicate: false,
      isCancelled,
      isSuppressed: false,
      isUpgradeToWarning: false,
      activeCount: this.getActiveCount(),
      colorIndex,
    };
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
      this.events.delete(id);
      this.onCleanup?.(id);
    }
  }
}
