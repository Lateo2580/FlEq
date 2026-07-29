import { intensityToRank } from "../../utils/intensity";
import { jstDayKey } from "../../utils/jst-day-key";
import { RECENT_QUAKES_MAX } from "../display/constants";
import type { DisplayRecentQuakeV1 } from "../display/types";
import type { PresentationEvent } from "../presentation/types";

/** getSnapshot() の戻り値 */
export interface DailyQuakeSnapshot {
  todayQuakeCount: number;
  todayMaxInt: string | null;
  todayMaxIntRank: number | null;
}

/** 永続化層へ渡す、当日分だけの実行時状態。wire protocol には載せない。 */
export interface DailyQuakePersistedV1 {
  dayKey: string;
  count: number;
  maxInt: string | null;
  maxIntRank: number;
  countedEventIds: string[];
  recentQuakes: DisplayRecentQuakeV1[];
}

export type DailyQuakeChange = "update" | "rollover";

/**
 * 本日 (JST) の地震件数・最大震度を追跡する。0 時 JST で自動リセット。
 * eventId 単位で件数を数える (続報で二重計上しない)。eventId null は 1 件として計上。
 */
export class DailyQuakeCounter {
  private dayKey: string;
  private count = 0;
  private maxInt: string | null = null;
  private maxIntRank = 0;
  private readonly countedEventIds = new Set<string>();
  private recentQuakes: DisplayRecentQuakeV1[] = [];
  private onChangeListener: ((change: DailyQuakeChange) => void) | null = null;

  constructor(nowMs = Date.now()) {
    this.dayKey = jstDayKey(nowMs);
  }

  /** 永続化予約の通知先。日替わりは caller が同期 flush できるよう区別する。 */
  onChange(listener: ((change: DailyQuakeChange) => void) | null): void {
    this.onChangeListener = listener;
  }

  /** 地震イベントを記録する。地震以外・取消・maxInt 欠落は無視する */
  record(event: PresentationEvent, now?: number): void {
    const ts = now ?? Date.now();
    const rolledOver = this.rolloverIfNeeded(ts);
    if (event.domain !== "earthquake" || event.isCancellation || event.maxInt == null) {
      if (rolledOver) this.notify("rollover");
      return;
    }

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
    this.notify(rolledOver ? "rollover" : "update");
  }

  /** 表示 DTO の地震履歴を保持する。display off 中も monitor 側で呼ばれる。 */
  recordRecentQuake(quake: DisplayRecentQuakeV1 | null, now?: number): boolean {
    const ts = now ?? Date.now();
    const rolledOver = this.rolloverIfNeeded(ts);
    if (quake == null || recentQuakeDayKey(quake) !== this.dayKey) {
      if (rolledOver) this.notify("rollover");
      return rolledOver;
    }
    if (quake.eventId != null) {
      this.recentQuakes = this.recentQuakes.filter((existing) => existing.eventId !== quake.eventId);
    }
    this.recentQuakes.unshift(quake);
    if (this.recentQuakes.length > RECENT_QUAKES_MAX) this.recentQuakes.length = RECENT_QUAKES_MAX;
    this.notify(rolledOver ? "rollover" : "update");
    return true;
  }

  /** 表示用スナップショットを返す */
  getSnapshot(now?: number): DailyQuakeSnapshot {
    if (this.rolloverIfNeeded(now ?? Date.now())) this.notify("rollover");
    return {
      todayQuakeCount: this.count,
      todayMaxInt: this.maxInt,
      todayMaxIntRank: this.maxIntRank > 0 ? this.maxIntRank : null,
    };
  }

  /** 表示 runtime の seed に使う。当日外の履歴はこの入口でも落とす。 */
  getRecentQuakes(now?: number): DisplayRecentQuakeV1[] {
    if (this.rolloverIfNeeded(now ?? Date.now())) this.notify("rollover");
    return [...this.recentQuakes];
  }

  /** 日替わり sweep。true のとき caller は空状態を同期保存する。 */
  sweep(nowMs: number): boolean {
    const changed = this.rolloverIfNeeded(nowMs);
    if (changed) this.notify("rollover");
    return changed;
  }

  export(): DailyQuakePersistedV1 {
    return {
      dayKey: this.dayKey,
      count: this.count,
      maxInt: this.maxInt,
      maxIntRank: this.maxIntRank,
      countedEventIds: [...this.countedEventIds],
      recentQuakes: [...this.recentQuakes],
    };
  }

  /** 同日データだけを復元する。不一致なら空の当日状態へ戻す。 */
  restore(state: DailyQuakePersistedV1, nowMs: number): boolean {
    const today = jstDayKey(nowMs);
    if (state.dayKey !== today) {
      this.reset(today);
      return false;
    }
    this.dayKey = state.dayKey;
    this.count = state.count;
    this.maxInt = state.maxInt;
    this.maxIntRank = state.maxIntRank;
    this.countedEventIds.clear();
    for (const id of state.countedEventIds) this.countedEventIds.add(id);
    this.recentQuakes = state.recentQuakes.filter((quake) => recentQuakeDayKey(quake) === today);
    return true;
  }

  /** JST 暦日が変わっていればカウンタを初期化する */
  private rolloverIfNeeded(ts: number): boolean {
    const key = jstDayKey(ts);
    if (this.dayKey !== key) {
      this.reset(key);
      return true;
    }
    return false;
  }

  private reset(dayKey: string): void {
    this.dayKey = dayKey;
    this.count = 0;
    this.maxInt = null;
    this.maxIntRank = 0;
    this.countedEventIds.clear();
    this.recentQuakes = [];
  }

  private notify(change: DailyQuakeChange): void {
    this.onChangeListener?.(change);
  }
}

function recentQuakeDayKey(quake: DisplayRecentQuakeV1): string | null {
  const ms = Date.parse(quake.originTime ?? quake.reportDateTime);
  return Number.isFinite(ms) ? jstDayKey(ms) : null;
}
