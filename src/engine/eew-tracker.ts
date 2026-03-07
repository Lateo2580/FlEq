import { ParsedEewInfo } from "../types";

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

/** EEW イベントの状態 */
interface EewEvent {
  eventId: string;
  lastSerial: number;
  isWarning: boolean;
  isCancelled: boolean;
  /** 最終報を受信済みか */
  isFinalized: boolean;
  lastUpdate: Date;
  /** 前回のパース済み EEW 情報 (差分計算用) */
  previousInfo?: ParsedEewInfo;
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

/** 震度文字列をソート用数値に変換 */
function intensityToNum(int: string): number {
  const norm = int.replace(/\s+/g, "");
  const map: Record<string, number> = {
    "1": 1, "2": 2, "3": 3, "4": 4,
    "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
    "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
  };
  return map[norm] ?? 0;
}

/** 予測震度リストから最大震度を取得 */
function getMaxForecastIntensity(areas: { name: string; intensity: string }[]): string | null {
  if (areas.length === 0) return null;
  let maxInt = areas[0].intensity;
  let maxNum = intensityToNum(maxInt);
  for (let i = 1; i < areas.length; i++) {
    const num = intensityToNum(areas[i].intensity);
    if (num > maxNum) {
      maxNum = num;
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
        activeCount: this.getActiveCount(),
        colorIndex: 0,
      };
    }

    const serialRaw = parseInt(info.serial || "", 10);
    const serial: number | null = Number.isFinite(serialRaw) ? serialRaw : null;
    const isCancelled = info.infoType === "取消";
    const existing = this.events.get(eventId);

    if (existing) {
      // 既知のイベント — 報数チェック
      if (!isCancelled && serial != null && serial > 0 && serial <= existing.lastSerial) {
        // 同じか古い報数 → 重複
        return {
          isNew: false,
          isDuplicate: true,
          isCancelled: false,
          activeCount: this.getActiveCount(),
          colorIndex: existing.colorIndex,
        };
      }

      // 差分計算
      const diff = existing.previousInfo ? computeDiff(existing.previousInfo, info) : undefined;
      const previousInfo = existing.previousInfo;

      // 状態更新
      if (serial != null) {
        existing.lastSerial = Math.max(existing.lastSerial, serial);
      }
      existing.isWarning = existing.isWarning || info.isWarning;
      existing.isCancelled = isCancelled;
      existing.lastUpdate = new Date();
      existing.previousInfo = info;

      return {
        isNew: false,
        isDuplicate: false,
        isCancelled,
        activeCount: this.getActiveCount(),
        diff,
        previousInfo,
        colorIndex: existing.colorIndex,
      };
    }

    // 新規イベント
    const colorIndex = this.nextColorIndex();
    this.events.set(eventId, {
      eventId,
      lastSerial: serial ?? 0,
      isWarning: info.isWarning,
      isCancelled,
      isFinalized: false,
      lastUpdate: new Date(),
      previousInfo: info,
      colorIndex,
    });

    return {
      isNew: true,
      isDuplicate: false,
      isCancelled,
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
