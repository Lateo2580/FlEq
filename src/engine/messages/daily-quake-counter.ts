import { intensityToRank } from "../../utils/intensity";
import { jstDayKey } from "../../utils/jst-day-key";
import type { PresentationEvent } from "../presentation/types";

/** getSnapshot() の戻り値 */
export interface DailyQuakeSnapshot {
  todayQuakeCount: number;
  todayMaxInt: string | null;
  todayMaxIntRank: number | null;
}

/**
 * 本日 (JST) の地震件数・最大震度を追跡する。0 時 JST で自動リセット。
 * eventId 単位で件数を数える (続報で二重計上しない)。eventId null は 1 件として計上。
 */
export class DailyQuakeCounter {
  private dayKey: string | null = null;
  private count = 0;
  private maxInt: string | null = null;
  private maxIntRank = 0;
  private readonly countedEventIds = new Set<string>();

  /** 地震イベントを記録する。地震以外・取消・maxInt 欠落は無視する */
  record(event: PresentationEvent, now?: number): void {
    const ts = now ?? Date.now();
    this.rolloverIfNeeded(ts);
    if (event.domain !== "earthquake" || event.isCancellation) return;
    if (event.maxInt == null) return;

    const id = event.eventId;
    if (id == null) {
      this.count += 1;
    } else if (!this.countedEventIds.has(id)) {
      this.countedEventIds.add(id);
      this.count += 1;
    }

    const rank = intensityToRank(event.maxInt);
    if (rank > this.maxIntRank) {
      this.maxIntRank = rank;
      this.maxInt = event.maxInt;
    }
  }

  /** 表示用スナップショットを返す */
  getSnapshot(now?: number): DailyQuakeSnapshot {
    this.rolloverIfNeeded(now ?? Date.now());
    return {
      todayQuakeCount: this.count,
      todayMaxInt: this.maxInt,
      todayMaxIntRank: this.maxIntRank > 0 ? this.maxIntRank : null,
    };
  }

  /** JST 暦日が変わっていればカウンタを初期化する */
  private rolloverIfNeeded(ts: number): void {
    const key = jstDayKey(ts);
    if (this.dayKey !== key) {
      this.dayKey = key;
      this.count = 0;
      this.maxInt = null;
      this.maxIntRank = 0;
      this.countedEventIds.clear();
    }
  }
}
