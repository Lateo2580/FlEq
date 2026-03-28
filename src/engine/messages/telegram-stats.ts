/** 統計の集約カテゴリ */
export type StatsCategory =
  | "eew"
  | "earthquake"
  | "tsunami"
  | "volcano"
  | "nankaiTrough"
  | "other";

/** Route → StatsCategory 変換 */
export function routeToCategory(route: string): StatsCategory {
  switch (route) {
    case "eew": return "eew";
    case "earthquake":
    case "seismicText":
    case "lgObservation": return "earthquake";
    case "tsunami": return "tsunami";
    case "volcano": return "volcano";
    case "nankaiTrough": return "nankaiTrough";
    default: return "other";
  }
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
}

/** セッション中の電文受信統計を管理する */
export class TelegramStats {
  private readonly startTime: Date;
  private readonly countByType = new Map<string, number>();
  private readonly categoryByType = new Map<string, StatsCategory>();
  private readonly eewEventIds = new Set<string>();
  private readonly earthquakeMaxIntByEvent = new Map<string, { maxInt: string; priority: number }>();

  constructor(startTime?: Date) {
    this.startTime = startTime ?? new Date();
  }

  /** headType カウント加算。EEW の場合は eventId を Set に追加 */
  record(rec: StatsRecord): void {
    this.countByType.set(rec.headType, (this.countByType.get(rec.headType) ?? 0) + 1);
    // headType → category の対応は固定なので初回のみ登録する
    if (!this.categoryByType.has(rec.headType)) {
      this.categoryByType.set(rec.headType, rec.category);
    }
    if (rec.category === "eew" && rec.eventId != null) {
      this.eewEventIds.add(rec.eventId);
    }
  }

  /**
   * 地震イベントの代表最大震度を更新する。
   * 認識する headType: VXSE53 (priority 3), VXSE61 (priority 2), VXSE51 (priority 1)。
   * 未知の headType は priority 0 として扱う。
   */
  updateMaxInt(eventId: string, maxInt: string, headType: string): void {
    const priority = MAX_INT_PRIORITY[headType] ?? 0;
    const existing = this.earthquakeMaxIntByEvent.get(eventId);
    if (existing == null || priority >= existing.priority) {
      this.earthquakeMaxIntByEvent.set(eventId, { maxInt, priority });
    }
  }

  /** 表示用の読み取り専用スナップショットを返す */
  getSnapshot(): StatsSnapshot {
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
    };
  }
}
