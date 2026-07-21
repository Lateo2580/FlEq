import type { PresentationEvent } from "../presentation/types";
import type { ActiveStandbyCardV1, DisplayHeatAreaV1 } from "./protocol";
import type { PersistedStandbyStateV1 } from "./standby-persistence";
import { projectHeatUpdate } from "./project-standby";
import {
  compareRevision,
  NO_MUTATION,
  revisionOf,
  sortStandbyItems,
  type DisplayMutation,
  type StandbyRevision,
} from "./standby-registry";

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

interface HeatState {
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
  restored: boolean;
}

export class StandbyStateStore {
  private heatAlerts = new Map<string, HeatState>();
  private readonly revisionGuard = new RevisionGuard();
  private readonly changeListeners: Array<() => void> = [];
  private readonly durableListeners: Array<() => void> = [];

  applyEvent(event: PresentationEvent, nowMs: number): DisplayMutation {
    let mutation = NO_MUTATION;
    switch (event.domain) {
      case "heatAlert":
        mutation = this.applyHeat(event, nowMs);
        break;
      default:
        return NO_MUTATION;
    }
    this.notify(mutation);
    return mutation;
  }

  private applyHeat(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectHeatUpdate(event, nowMs);
    if (update == null) return NO_MUTATION;
    const key = `heat:${update.targetDate}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs)) return NO_MUTATION;
    if (update.isCancellation) {
      return { viewChanged: this.heatAlerts.delete(key), durableChanged: true };
    }
    this.heatAlerts.set(key, {
      sourceEventIds: [update.sourceEventId],
      targetDate: update.targetDate,
      targetDateEndMs: update.targetDateEndMs,
      areas: update.areas,
      isSpecial: update.isSpecial,
      revision,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  sweep(nowMs: number): DisplayMutation {
    let viewChanged = false;
    let durableChanged = false;
    for (const [key, state] of this.heatAlerts) {
      if (state.targetDateEndMs <= nowMs) {
        this.heatAlerts.delete(key);
        viewChanged = true;
        durableChanged = true;
      }
    }
    if (this.revisionGuard.sweep(nowMs)) durableChanged = true;
    const mutation = { viewChanged, durableChanged };
    this.notify(mutation);
    return mutation;
  }

  snapshotItems(): ActiveStandbyCardV1[] {
    const items: ActiveStandbyCardV1[] = [...this.heatAlerts].map(([key, state]) => ({
      kind: "heat",
      surface: "corner-right",
      key,
      sourceEventIds: [...state.sourceEventIds],
      updatedAt: new Date(state.revision.reportTimeMs).toISOString(),
      expiresAt: new Date(state.targetDateEndMs).toISOString(),
      restored: state.restored,
      severity: state.isSpecial ? "critical" : "warning",
      data: { targetDate: state.targetDate, areas: state.areas.map((area) => ({ ...area })) },
    }));
    return sortStandbyItems(items);
  }

  exportActiveState(): PersistedStandbyStateV1 {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      heat: [...this.heatAlerts].map(([key, state]) => ({
        key,
        sourceEventIds: [...state.sourceEventIds],
        targetDate: state.targetDate,
        targetDateEndMs: state.targetDateEndMs,
        areas: state.areas.map((area) => ({ ...area })),
        isSpecial: state.isSpecial,
        revision: { ...state.revision },
      })),
      seen: this.revisionGuard.export(),
    };
  }

  restoreActiveState(data: PersistedStandbyStateV1, nowMs: number): void {
    this.heatAlerts.clear();
    for (const state of data.heat) {
      if (state.targetDateEndMs <= nowMs) continue;
      this.heatAlerts.set(state.key, {
        sourceEventIds: [...state.sourceEventIds],
        targetDate: state.targetDate,
        targetDateEndMs: state.targetDateEndMs,
        areas: state.areas.map((area) => ({ ...area })),
        isSpecial: state.isSpecial,
        revision: { ...state.revision },
        restored: true,
      });
    }
    this.revisionGuard.restore(data.seen, nowMs);
  }

  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  onDurable(cb: () => void): void {
    this.durableListeners.push(cb);
  }

  private notify(mutation: DisplayMutation): void {
    if (mutation.viewChanged) for (const cb of this.changeListeners) cb();
    if (mutation.durableChanged) for (const cb of this.durableListeners) cb();
  }
}
