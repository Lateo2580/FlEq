export interface TyphoonProbabilityDiff {
  isUnchangedZero: boolean;
  shouldRecap: boolean;
}

export const TYPHOON_PROBABILITY_MAX_EVENTS = 256;

/**
 * 同一 EventID の前回 maxDaily5 を覚えて、連続ゼロ発表を検出する。
 * VPWS50 の Vpws50StateHolder と同思想（in-memory、再起動で履歴喪失=安全側）。
 */
export class TyphoonProbabilityStateHolder {
  private last: Map<string, { maxDaily5: number; receivedAt: string | null }> = new Map();

  diffAndUpdate(
    eventId: string,
    maxDaily5: number,
    receivedAt: string | null,
  ): TyphoonProbabilityDiff {
    if (eventId === "") {
      // EventID 不明の発表は履歴に乗せない（誤った dedup を避ける）
      return { isUnchangedZero: false, shouldRecap: false };
    }
    const prev = this.last.get(eventId);
    this.last.delete(eventId);
    this.last.set(eventId, { maxDaily5, receivedAt });
    while (this.last.size > TYPHOON_PROBABILITY_MAX_EVENTS) {
      const oldest = this.last.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.last.delete(oldest);
    }
    const isUnchangedZero = prev != null && prev.maxDaily5 === 0 && maxDaily5 === 0;
    return { isUnchangedZero, shouldRecap: false };
  }

  rollback(eventId: string): void {
    this.last.delete(eventId);
  }

  retainEventIds(eventIds: readonly string[]): void {
    const retained = new Set(eventIds);
    for (const eventId of this.last.keys()) if (!retained.has(eventId)) this.last.delete(eventId);
  }
}
