import { ParsedEewInfo } from "../types";

/** EEW イベントの状態 */
interface EewEvent {
  eventId: string;
  lastSerial: number;
  isWarning: boolean;
  isCancelled: boolean;
  lastUpdate: Date;
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
}

/** 古いイベントを自動削除するまでの時間 (ミリ秒) */
const CLEANUP_THRESHOLD_MS = 10 * 60 * 1000; // 10分

/**
 * 複数の EEW イベントを EventID ごとに追跡し、
 * 重複報の検出・キャンセル状態の管理を行う。
 */
export class EewTracker {
  private events = new Map<string, EewEvent>();

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
      };
    }

    const serial = parseInt(info.serial || "0", 10);
    const isCancelled = info.infoType === "取消";
    const existing = this.events.get(eventId);

    if (existing) {
      // 既知のイベント — 報数チェック
      if (!isCancelled && serial > 0 && serial <= existing.lastSerial) {
        // 同じか古い報数 → 重複
        return {
          isNew: false,
          isDuplicate: true,
          isCancelled: false,
          activeCount: this.getActiveCount(),
        };
      }

      // 状態更新
      existing.lastSerial = Math.max(existing.lastSerial, serial);
      existing.isWarning = existing.isWarning || info.isWarning;
      existing.isCancelled = isCancelled;
      existing.lastUpdate = new Date();

      return {
        isNew: false,
        isDuplicate: false,
        isCancelled,
        activeCount: this.getActiveCount(),
      };
    }

    // 新規イベント
    this.events.set(eventId, {
      eventId,
      lastSerial: serial,
      isWarning: info.isWarning,
      isCancelled,
      lastUpdate: new Date(),
    });

    return {
      isNew: true,
      isDuplicate: false,
      isCancelled,
      activeCount: this.getActiveCount(),
    };
  }

  /** 現在アクティブ（キャンセルされていない）イベント数を返す */
  getActiveCount(): number {
    let count = 0;
    for (const ev of this.events.values()) {
      if (!ev.isCancelled) count++;
    }
    return count;
  }

  /** 最終更新から一定時間経過したイベントを削除 */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, ev] of this.events) {
      if (now - ev.lastUpdate.getTime() > CLEANUP_THRESHOLD_MS) {
        this.events.delete(id);
      }
    }
  }
}
