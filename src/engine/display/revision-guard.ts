import type { StandbyRevision } from "./standby-registry";
import { compareRevision } from "./standby-registry";

const DEFAULT_SEEN_FORGET_MS = 24 * 60 * 60_000;

export interface PersistedSeenEntry {
  key: string;
  revision: StandbyRevision;
  forgetAtMs: number;
}

export interface RevisionGuardDeps {
  /** 指定時、稼働中の expiry 判定はこの単調時計だけで行う。壁時計期限は永続化・復元用。 */
  monotonicNow?: () => number;
}

export class RevisionGuard {
  private seen = new Map<string, {
    revision: StandbyRevision;
    forgetAtMs: number;
    expiresAtMonotonicMs: number | null;
  }>();
  private readonly monotonicNow: (() => number) | null;

  constructor(deps: RevisionGuardDeps = {}) {
    this.monotonicNow = deps.monotonicNow ?? null;
  }

  accept(key: string, revision: StandbyRevision, nowMs: number, retentionMs = DEFAULT_SEEN_FORGET_MS): boolean {
    const existing = this.seen.get(key);
    if (existing != null && compareRevision(revision, existing.revision) <= 0) return false;
    this.seen.set(key, {
      revision,
      forgetAtMs: nowMs + retentionMs,
      expiresAtMonotonicMs: this.monotonicNow == null ? null : this.monotonicNow() + retentionMs,
    });
    return true;
  }

  replace(key: string, revision: StandbyRevision, nowMs: number, retentionMs = DEFAULT_SEEN_FORGET_MS): void {
    this.seen.set(key, {
      revision: { ...revision },
      forgetAtMs: nowMs + retentionMs,
      expiresAtMonotonicMs: this.monotonicNow == null ? null : this.monotonicNow() + retentionMs,
    });
  }

  sweep(nowMs: number): boolean {
    let changed = false;
    const monotonicMs = this.monotonicNow?.() ?? null;
    for (const [key, entry] of this.seen) {
      const expired = monotonicMs == null || entry.expiresAtMonotonicMs == null
        ? entry.forgetAtMs <= nowMs
        : entry.expiresAtMonotonicMs <= monotonicMs;
      if (expired) {
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
    const monotonicMs = this.monotonicNow?.() ?? null;
    for (const entry of entries) {
      if (entry.forgetAtMs > nowMs) {
        this.seen.set(entry.key, {
          revision: { ...entry.revision },
          forgetAtMs: entry.forgetAtMs,
          expiresAtMonotonicMs: monotonicMs == null ? null : monotonicMs + (entry.forgetAtMs - nowMs),
        });
      }
    }
  }
}
