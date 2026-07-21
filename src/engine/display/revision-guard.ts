import type { StandbyRevision } from "./standby-registry";
import { compareRevision } from "./standby-registry";

const SEEN_FORGET_MS = 24 * 60 * 60_000;

export interface PersistedSeenEntry {
  key: string;
  revision: StandbyRevision;
  forgetAtMs: number;
}

export class RevisionGuard {
  private seen = new Map<string, { revision: StandbyRevision; forgetAtMs: number }>();

  accept(key: string, revision: StandbyRevision, nowMs: number): boolean {
    const existing = this.seen.get(key);
    if (existing != null && compareRevision(revision, existing.revision) <= 0) return false;
    this.seen.set(key, { revision, forgetAtMs: nowMs + SEEN_FORGET_MS });
    return true;
  }

  sweep(nowMs: number): boolean {
    let changed = false;
    for (const [key, entry] of this.seen) {
      if (entry.forgetAtMs <= nowMs) {
        this.seen.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  export(): PersistedSeenEntry[] {
    return [...this.seen].map(([key, entry]) => ({ key, revision: { ...entry.revision }, forgetAtMs: entry.forgetAtMs }));
  }

  restore(entries: PersistedSeenEntry[], nowMs: number): void {
    this.seen.clear();
    for (const entry of entries) {
      if (entry.forgetAtMs > nowMs) {
        this.seen.set(entry.key, { revision: { ...entry.revision }, forgetAtMs: entry.forgetAtMs });
      }
    }
  }
}
