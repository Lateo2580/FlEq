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

export interface RevisionGuardSnapshot {
  seen: Array<[string, {
    revision: StandbyRevision;
    forgetAtMs: number;
    expiresAtMonotonicMs: number | null;
  }]>;
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

  accept(
    key: string,
    revision: StandbyRevision,
    nowMs: number,
    retentionMs = DEFAULT_SEEN_FORGET_MS,
    allowEqual = false,
  ): boolean {
    if (!this.allows(key, revision, allowEqual)) return false;
    this.seen.set(key, {
      revision,
      forgetAtMs: nowMs + retentionMs,
      expiresAtMonotonicMs: this.monotonicNow == null ? null : this.monotonicNow() + retentionMs,
    });
    return true;
  }

  /** watermark を更新せず、指定 revision が受理可能かだけを判定する。 */
  allows(key: string, revision: StandbyRevision, allowEqual = false): boolean {
    const existing = this.seen.get(key);
    if (existing != null) {
      const compared = compareRevision(revision, existing.revision);
      if (compared < 0 || compared === 0 && !allowEqual) return false;
    }
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

  cloneSnapshot(): RevisionGuardSnapshot {
    return { seen: structuredClone([...this.seen]) };
  }

  replacePrevalidated(snapshot: RevisionGuardSnapshot): void {
    this.seen = new Map(structuredClone(snapshot.seen));
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
