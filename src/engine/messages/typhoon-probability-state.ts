import {
  validateTyphoonProbabilityEventId,
  type FinalizedTyphoonProbabilityClassification,
} from "../display/project-typhoon-probability";

export interface TyphoonProbabilityDiff {
  isUnchangedZero: boolean;
  shouldRecap: boolean;
}

export const TYPHOON_PROBABILITY_MAX_EVENTS = 256;
export const TYPHOON_PROBABILITY_HISTORY_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * 同一 EventID の前回 maxDaily5 を覚えて、連続ゼロ発表を検出する。
 * VPWS50 の Vpws50StateHolder と同思想（in-memory、再起動で履歴喪失=安全側）。
 */
export class TyphoonProbabilityStateHolder {
  private last = new Map<string, { maxDaily5: number; acceptedAtMs: number }>();

  applyAcceptedClassification(
    eventId: string,
    finalized: FinalizedTyphoonProbabilityClassification,
  ): TyphoonProbabilityDiff {
    if (validateTyphoonProbabilityEventId(eventId) !== eventId) {
      throw new Error("VPTA notification holder requires a canonical EventID");
    }
    if (finalized.result.kind === "active" && finalized.result.state.eventId !== eventId) {
      throw new Error("VPTA notification holder binding mismatch");
    }
    this.sweep(finalized.nowMs);
    switch (finalized.result.kind) {
      case "active":
        return this.applyAccepted(eventId, finalized.result.state.maxFiveDayProbability, finalized.nowMs);
      case "deactivateAllZero":
        return this.applyAccepted(eventId, 0, finalized.nowMs);
      case "cancel":
        this.last.delete(eventId);
        return { isUnchangedZero: false, shouldRecap: false };
      case "expired":
      case "nonProjectable":
        return { isUnchangedZero: false, shouldRecap: false };
    }
  }

  private applyAccepted(eventId: string, maxDaily5: number, acceptedAtMs: number): TyphoonProbabilityDiff {
    this.sweep(acceptedAtMs);
    const previous = this.last.get(eventId);
    this.last.delete(eventId);
    this.last.set(eventId, { maxDaily5, acceptedAtMs });
    while (this.last.size > TYPHOON_PROBABILITY_MAX_EVENTS) {
      const oldest = this.last.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.last.delete(oldest);
    }
    return {
      isUnchangedZero: previous != null && previous.maxDaily5 === 0 && maxDaily5 === 0,
      shouldRecap: false,
    };
  }

  sweep(nowMs: number): void {
    for (const [eventId, state] of this.last) {
      if (nowMs - state.acceptedAtMs > TYPHOON_PROBABILITY_HISTORY_TTL_MS) {
        this.last.delete(eventId);
      }
    }
  }
}
