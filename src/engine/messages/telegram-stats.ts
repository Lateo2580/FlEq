import { jstDayKey } from "../../utils/jst-day-key";
import type { Route } from "./route-catalog";
import { ROUTE_TO_STATS_CATEGORY } from "./route-catalog";

/** 統計の集約カテゴリ */
export type StatsCategory =
  | "eew"
  | "earthquake"
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
  | "other";

/**
 * Route → StatsCategory 変換。
 * 対応表 (`ROUTE_TO_STATS_CATEGORY`) は route-catalog から導出されており、Route を
 * 網羅していることがコンパイル時に保証される (新 Route を足すと catalog エントリの
 * statsCategory 指定が必須になる)。
 */
export function routeToCategory(route: Route): StatsCategory {
  // 型上は Route で網羅済みだが、実行時に未知の文字列が紛れた場合は
  // 旧実装 (string 受け) と同じく "other" へ落とす
  return ROUTE_TO_STATS_CATEGORY[route] ?? "other";
}

/** record() の入力 */
export interface StatsRecord {
  headType: string;
  category: StatsCategory;
  eventId?: string | null;
}

/** 最大震度 headType → priority マッピング */
const MAX_INT_PRIORITY: Record<string, number> = {
  VXSE53: 3,
  VXSE61: 2,
  VXSE51: 1,
};

/** getSnapshot() の戻り値 */
export interface StatsSnapshot {
  startTime: Date;
  countByType: Map<string, number>;
  categoryByType: Map<string, StatsCategory>;
  eewEventCount: number;
  /** eventId → 代表最大震度 */
  earthquakeMaxIntByEvent: Map<string, string>;
  totalCount: number;
  /** envelope / raw XML の試験 metadata 不一致件数 */
  testMetadataMismatch: number;
  /** 共通電文基盤の受信・採用判定カウンタ */
  foundation: Readonly<Record<TelegramFoundationMetric, number>>;
}

export type TelegramFoundationMetric =
  | "received"
  | "transportDuplicate"
  | "semanticDuplicate"
  | "correctionReplaced"
  | "correctionNotified"
  | "stale"
  | "invalidMeta"
  | "invalidRevision"
  | "invalidDateDiagnosed"
  | "futureDateDiagnosed"
  | "cancelApplied"
  | "cancelTargetMismatch"
  | "persistenceMigrationConflict"
  | "presented"
  | "notified";

const FOUNDATION_METRICS: readonly TelegramFoundationMetric[] = [
  "received",
  "transportDuplicate",
  "semanticDuplicate",
  "correctionReplaced",
  "correctionNotified",
  "stale",
  "invalidMeta",
  "invalidRevision",
  "invalidDateDiagnosed",
  "futureDateDiagnosed",
  "cancelApplied",
  "cancelTargetMismatch",
  "persistenceMigrationConflict",
  "presented",
  "notified",
];

function emptyFoundationStats(): Record<TelegramFoundationMetric, number> {
  return Object.fromEntries(
    FOUNDATION_METRICS.map((metric) => [metric, 0]),
  ) as Record<TelegramFoundationMetric, number>;
}

/** Set/Map のサイズ上限 */
const MAX_EVENT_ENTRIES = 1000;

/** 上限超過時に削除するエントリ数 (バッチ削除で頻繁な削除を回避) */
const EVICT_BATCH_SIZE = 100;

/** Set のサイズ上限を適用する。超過時は挿入順で古い方から削除する。 */
function evictOldestFromSet(set: Set<string>, maxSize: number): void {
  if (set.size <= maxSize) return;
  let toRemove = set.size - maxSize + EVICT_BATCH_SIZE;
  for (const item of set) {
    if (toRemove <= 0) break;
    set.delete(item);
    toRemove--;
  }
}

/** Map のサイズ上限を適用する。超過時は挿入順で古い方から削除する。 */
function evictOldestFromMap<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  let toRemove = map.size - maxSize + EVICT_BATCH_SIZE;
  for (const key of map.keys()) {
    if (toRemove <= 0) break;
    map.delete(key);
    toRemove--;
  }
}

/** 本日 (JST) の電文受信統計を管理する。0 時 JST で自動リセットする (受動ロールオーバー) */
export class TelegramStats {
  private startTime: Date;
  private dayKey: string | null = null;
  private readonly countByType = new Map<string, number>();
  private readonly categoryByType = new Map<string, StatsCategory>();
  private readonly eewEventIds = new Set<string>();
  private readonly earthquakeMaxIntByEvent = new Map<string, { maxInt: string; priority: number }>();
  private testMetadataMismatch = 0;
  private foundation = emptyFoundationStats();

  constructor(startTime?: Date) {
    this.startTime = startTime ?? new Date();
    this.dayKey = jstDayKey(this.startTime.getTime());
  }

  /** headType カウント加算。EEW の場合は eventId を Set に追加 */
  record(rec: StatsRecord, now?: number): void {
    this.rolloverIfNeeded(now ?? Date.now());
    this.countByType.set(rec.headType, (this.countByType.get(rec.headType) ?? 0) + 1);
    // headType → category の対応は固定なので初回のみ登録する
    if (!this.categoryByType.has(rec.headType)) {
      this.categoryByType.set(rec.headType, rec.category);
    }
    if (rec.category === "eew" && rec.eventId != null) {
      this.eewEventIds.add(rec.eventId);
      evictOldestFromSet(this.eewEventIds, MAX_EVENT_ENTRIES);
    }
  }

  recordTestMetadataMismatch(now?: number): void {
    this.rolloverIfNeeded(now ?? Date.now());
    this.testMetadataMismatch++;
  }

  recordFoundation(
    metric: TelegramFoundationMetric,
    now?: number,
  ): void {
    this.rolloverIfNeeded(now ?? Date.now());
    this.foundation[metric]++;
  }

  /**
   * 地震イベントの代表最大震度を更新する。
   * 認識する headType: VXSE53 (priority 3), VXSE61 (priority 2), VXSE51 (priority 1)。
   * 未知の headType は priority 0 として扱う。
   */
  updateMaxInt(eventId: string, maxInt: string, headType: string, now?: number): void {
    this.rolloverIfNeeded(now ?? Date.now());
    const priority = MAX_INT_PRIORITY[headType] ?? 0;
    const existing = this.earthquakeMaxIntByEvent.get(eventId);
    if (existing == null || priority >= existing.priority) {
      this.earthquakeMaxIntByEvent.set(eventId, { maxInt, priority });
      evictOldestFromMap(this.earthquakeMaxIntByEvent, MAX_EVENT_ENTRIES);
    }
  }

  /** headType 別カウントの合計。getSnapshot() の Map コピーを避けた軽量アクセサ */
  totalCount(now?: number): number {
    this.rolloverIfNeeded(now ?? Date.now());
    let total = 0;
    for (const count of this.countByType.values()) total += count;
    return total;
  }

  /** 表示用の読み取り専用スナップショットを返す */
  getSnapshot(now?: number): StatsSnapshot {
    this.rolloverIfNeeded(now ?? Date.now());
    let totalCount = 0;
    for (const count of this.countByType.values()) {
      totalCount += count;
    }
    return {
      startTime: new Date(this.startTime),
      countByType: new Map(this.countByType),
      categoryByType: new Map(this.categoryByType),
      eewEventCount: this.eewEventIds.size,
      earthquakeMaxIntByEvent: new Map(
        [...this.earthquakeMaxIntByEvent.entries()].map(([k, v]) => [k, v.maxInt]),
      ),
      totalCount,
      testMetadataMismatch: this.testMetadataMismatch,
      foundation: { ...this.foundation },
    };
  }

  /**
   * JST 暦日が変わっていれば当日分のカウンタを初期化する。
   * `categoryByType` (headType → category の固定マッピング) はリセットしない。
   */
  private rolloverIfNeeded(ts: number): void {
    const key = jstDayKey(ts);
    if (this.dayKey !== key) {
      this.dayKey = key;
      this.startTime = new Date(ts);
      this.countByType.clear();
      this.eewEventIds.clear();
      this.earthquakeMaxIntByEvent.clear();
      this.testMetadataMismatch = 0;
      this.foundation = emptyFoundationStats();
    }
  }
}
