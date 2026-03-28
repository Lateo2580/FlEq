import { intensityToRank } from "../../utils/intensity";
import type { PresentationDomain, PresentationEvent } from "../presentation/types";

/** 1分バケット */
export interface MinuteBucket {
  minuteStartMs: number;
  received: number;
  matched: number;
  byDomain: Partial<Record<PresentationDomain, number>>;
  maxIntRank: number;
  maxIntStr: string | null;
}

/** getSnapshot() の戻り値 */
export interface SummaryWindowSnapshot {
  totalReceived: number;
  totalMatched: number;
  byDomain: Record<string, number>;
  maxIntSeen: string | null;
  sparklineData: number[];
}

const WINDOW_MINUTES = 30;
const MINUTE_MS = 60_000;

/** 直近30分のリングバッファで受信統計を追跡する */
export class SummaryWindowTracker {
  private buckets: MinuteBucket[] = [];

  /** イベントを記録する */
  record(event: PresentationEvent, matched: boolean, now?: number): void {
    const ts = now ?? Date.now();
    this.pruneOld(ts);

    const bucket = this.getOrCreateBucket(ts);
    bucket.received++;
    if (matched) {
      bucket.matched++;
    }
    bucket.byDomain[event.domain] = (bucket.byDomain[event.domain] ?? 0) + 1;

    // maxInt 追跡 (バケット単位で記録)
    if (event.maxInt != null) {
      const rank = intensityToRank(event.maxInt);
      if (rank > bucket.maxIntRank) {
        bucket.maxIntRank = rank;
        bucket.maxIntStr = event.maxInt;
      }
    }
  }

  /** 現在のスナップショットを取得する */
  getSnapshot(now?: number): SummaryWindowSnapshot {
    const ts = now ?? Date.now();
    this.pruneOld(ts);

    let totalReceived = 0;
    let totalMatched = 0;
    const byDomain: Record<string, number> = {};

    for (const bucket of this.buckets) {
      totalReceived += bucket.received;
      totalMatched += bucket.matched;
      for (const [domain, count] of Object.entries(bucket.byDomain)) {
        byDomain[domain] = (byDomain[domain] ?? 0) + (count ?? 0);
      }
    }

    // maxInt を残存バケットから再計算 (30分窓で減衰)
    let maxIntRank = 0;
    let maxIntStr: string | null = null;
    for (const bucket of this.buckets) {
      if (bucket.maxIntRank > maxIntRank) {
        maxIntRank = bucket.maxIntRank;
        maxIntStr = bucket.maxIntStr;
      }
    }

    // sparklineData: 30スロット (古い順 → 新しい順)
    const sparklineData = this.buildSparklineData(ts);

    return {
      totalReceived,
      totalMatched,
      byDomain,
      maxIntSeen: maxIntStr,
      sparklineData,
    };
  }

  /** 統計をクリアする */
  clear(): void {
    this.buckets = [];
  }

  /** 30分超の古いバケットを除去する */
  private pruneOld(now: number): void {
    const cutoff = this.minuteStart(now) - (WINDOW_MINUTES - 1) * MINUTE_MS;
    this.buckets = this.buckets.filter((b) => b.minuteStartMs >= cutoff);
  }

  /** 指定時刻のバケットを取得、なければ作成 */
  private getOrCreateBucket(now: number): MinuteBucket {
    const ms = this.minuteStart(now);
    const existing = this.buckets.find((b) => b.minuteStartMs === ms);
    if (existing) return existing;

    const bucket: MinuteBucket = {
      minuteStartMs: ms,
      received: 0,
      matched: 0,
      byDomain: {},
      maxIntRank: 0,
      maxIntStr: null,
    };
    this.buckets.push(bucket);
    return bucket;
  }

  /** 30スロットの sparkline データを生成する (古い順) */
  private buildSparklineData(now: number): number[] {
    const currentMinuteStart = this.minuteStart(now);
    const data: number[] = new Array(WINDOW_MINUTES).fill(0);

    for (const bucket of this.buckets) {
      const slotIndex = Math.round((bucket.minuteStartMs - (currentMinuteStart - (WINDOW_MINUTES - 1) * MINUTE_MS)) / MINUTE_MS);
      if (slotIndex >= 0 && slotIndex < WINDOW_MINUTES) {
        data[slotIndex] = bucket.received;
      }
    }

    return data;
  }

  /** タイムスタンプを分の開始に丸める */
  private minuteStart(ts: number): number {
    return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
  }
}
