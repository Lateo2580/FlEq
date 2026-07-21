import type { DisplayFloodUpdate } from "./project-flood";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1 } from "./protocol";
import { RevisionGuard, type PersistedSeenEntry } from "./revision-guard";
import { compareRevision, NO_MUTATION, revisionOf, STANDBY_CARD_REGISTRY, type DisplayMutation, type StandbyRevision } from "./standby-registry";

type FloodCard = Extract<ActiveStandbyCardV1, { kind: "flood" }>;

interface FloodEventState {
  revision: StandbyRevision;
  rivers: DisplayFloodRiverV1[];
  expiresAtMs: number;
  restored: boolean;
}

export interface PersistedFloodEventState {
  eventId: string;
  revision: StandbyRevision;
  rivers: DisplayFloodRiverV1[];
  expiresAtMs: number;
}

export interface PersistedFloodState {
  events: PersistedFloodEventState[];
  seen: PersistedSeenEntry[];
}

const FLOOD_TTL_MS = STANDBY_CARD_REGISTRY.flood.fallbackTtlMs!;

function copyRiver(river: DisplayFloodRiverV1): DisplayFloodRiverV1 {
  return { ...river };
}

function cardFingerprint(card: FloodCard | null): string {
  return JSON.stringify(card);
}

export class FloodActiveReducer {
  private events = new Map<string, FloodEventState>();
  private readonly revisionGuard = new RevisionGuard();

  apply(update: DisplayFloodUpdate, nowMs: number): DisplayMutation {
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(update.eventId, revision, nowMs)) return NO_MUTATION;
    if (update.mode === "observeOnly") return { viewChanged: false, durableChanged: true };

    const before = cardFingerprint(this.snapshotCard());
    if (update.mode === "cancel" || update.rivers.length === 0) {
      this.events.delete(update.eventId);
    } else {
      this.events.set(update.eventId, {
        revision,
        rivers: update.rivers.map(copyRiver),
        expiresAtMs: revision.reportTimeMs + FLOOD_TTL_MS,
        restored: false,
      });
    }
    return { viewChanged: before !== cardFingerprint(this.snapshotCard()), durableChanged: true };
  }

  sweep(nowMs: number): DisplayMutation {
    const before = cardFingerprint(this.snapshotCard());
    let durableChanged = false;
    for (const [eventId, state] of this.events) {
      if (state.expiresAtMs <= nowMs) {
        this.events.delete(eventId);
        durableChanged = true;
      }
    }
    if (this.revisionGuard.sweep(nowMs)) durableChanged = true;
    if (!durableChanged) return NO_MUTATION;
    return { viewChanged: before !== cardFingerprint(this.snapshotCard()), durableChanged: true };
  }

  snapshotCard(): FloodCard | null {
    if (this.events.size === 0) return null;
    const selected = new Map<string, { river: DisplayFloodRiverV1; revision: StandbyRevision }>();
    for (const state of this.events.values()) {
      for (const river of state.rivers) {
        const existing = selected.get(river.riverKey);
        if (existing == null
          || river.levelRank > existing.river.levelRank
          || river.levelRank === existing.river.levelRank && compareRevision(state.revision, existing.revision) > 0) {
          selected.set(river.riverKey, { river, revision: state.revision });
        }
      }
    }
    const rivers = [...selected.values()]
      .sort((a, b) => b.river.levelRank - a.river.levelRank
        || b.revision.reportTimeMs - a.revision.reportTimeMs
        || a.river.riverName.localeCompare(b.river.riverName, "ja"))
      .map(({ river }) => copyRiver(river));
    if (rivers.length === 0) return null;
    const states = [...this.events.entries()];
    const updatedAtMs = Math.max(...states.map(([, state]) => state.revision.reportTimeMs));
    const expiresAtMs = Math.max(...states.map(([, state]) => state.expiresAtMs));
    return {
      kind: "flood",
      surface: rivers.length >= 4 ? "clock-top-wide" : "corner-right",
      key: "flood:active",
      sourceEventIds: states.map(([eventId]) => eventId),
      updatedAt: new Date(updatedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      restored: states.every(([, state]) => state.restored),
      severity: rivers.some((river) => river.levelRank >= 40) ? "critical" : "warning",
      data: { rivers },
    };
  }

  exportState(): PersistedFloodState {
    return {
      events: [...this.events].map(([eventId, state]) => ({
        eventId,
        revision: { ...state.revision },
        rivers: state.rivers.map(copyRiver),
        expiresAtMs: state.expiresAtMs,
      })),
      seen: this.revisionGuard.export(),
    };
  }

  restoreState(data: PersistedFloodState, nowMs: number): void {
    this.events.clear();
    for (const state of data.events) {
      if (state.expiresAtMs <= nowMs) continue;
      this.events.set(state.eventId, {
        revision: { ...state.revision },
        rivers: state.rivers.map(copyRiver),
        expiresAtMs: state.expiresAtMs,
        restored: true,
      });
    }
    this.revisionGuard.restore(data.seen, nowMs);
  }
}
