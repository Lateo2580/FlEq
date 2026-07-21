import type { PresentationEvent } from "../presentation/types";
import type { ActiveStandbyCardV1, DisplayHeatAreaV1, DisplayTyphoonV1, DisplayVolcanoEntryV1 } from "./protocol";
import type { PersistedStandbyStateV1 } from "./standby-persistence";
import { projectHeatUpdate, projectTyphoonUpdate, projectVolcanoUpdate } from "./project-standby";
import {
  compareRevision,
  NO_MUTATION,
  revisionOf,
  sortStandbyItems,
  type DisplayMutation,
  type StandbyRevision,
} from "./standby-registry";

const SEEN_FORGET_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

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

interface TyphoonState {
  sourceEventId: string;
  typhoon: DisplayTyphoonV1;
  revision: StandbyRevision;
  expiresAtMs: number;
  restored: boolean;
}

interface VolcanoState {
  code: string;
  name: string;
  alertLevel: number | null;
  alertExpiresAtMs: number | null;
  latestEvent: string | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  revision: StandbyRevision;
  restored: boolean;
}

export interface VolcanoSeedEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  reportDateTime: string;
}

export class StandbyStateStore {
  private heatAlerts = new Map<string, HeatState>();
  private typhoons = new Map<string, TyphoonState>();
  private volcanoes = new Map<string, VolcanoState>();
  private readonly revisionGuard = new RevisionGuard();
  private readonly changeListeners: Array<() => void> = [];
  private readonly durableListeners: Array<() => void> = [];

  applyEvent(event: PresentationEvent, nowMs: number): DisplayMutation {
    let mutation = NO_MUTATION;
    switch (event.domain) {
      case "heatAlert":
        mutation = this.applyHeat(event, nowMs);
        break;
      case "typhoonAnalysis":
        mutation = this.applyTyphoon(event, nowMs);
        break;
      case "volcano":
        mutation = this.applyVolcano(event, nowMs);
        break;
      default:
        return NO_MUTATION;
    }
    this.notify(mutation);
    return mutation;
  }

  private applyTyphoon(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectTyphoonUpdate(event);
    if (update == null) return NO_MUTATION;
    const key = `typhoon:${update.typhoonKey}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs)) return NO_MUTATION;
    if (update.isCancellation) {
      return { viewChanged: this.typhoons.delete(update.typhoonKey), durableChanged: true };
    }
    this.typhoons.set(update.typhoonKey, {
      sourceEventId: update.sourceEventId,
      typhoon: update.typhoon,
      revision,
      expiresAtMs: revision.reportTimeMs + DAY_MS,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  private applyVolcano(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectVolcanoUpdate(event);
    if (update == null) return NO_MUTATION;
    const key = `volcano:${update.volcano.code}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs)) return NO_MUTATION;
    const previous = this.volcanoes.get(update.volcano.code);
    if (update.isCancellation) {
      return { viewChanged: this.volcanoes.delete(update.volcano.code), durableChanged: true };
    }
    const state: VolcanoState = previous ?? {
      code: update.volcano.code,
      name: update.volcano.name,
      alertLevel: null,
      alertExpiresAtMs: null,
      latestEvent: null,
      eventExpiresAtMs: null,
      sourceEventIds: [],
      revision,
      restored: false,
    };
    state.name = update.volcano.name;
    state.revision = revision;
    state.restored = false;
    if (!state.sourceEventIds.includes(update.sourceEventId)) state.sourceEventIds.push(update.sourceEventId);
    if (update.kind === "alert") {
      state.alertLevel = update.volcano.alertLevel;
      state.alertExpiresAtMs = update.volcano.alertLevel != null && update.volcano.alertLevel >= 4 ? null : nowMs;
      if (update.isLevelIncrease) {
        state.latestEvent = null;
        state.eventExpiresAtMs = update.volcano.alertLevel != null && update.volcano.alertLevel >= 4
          ? null
          : revision.reportTimeMs + DAY_MS;
      }
    } else {
      state.latestEvent = update.volcano.latestEvent;
      state.eventExpiresAtMs = revision.reportTimeMs + DAY_MS;
    }
    if (state.alertExpiresAtMs != null && (state.eventExpiresAtMs == null || state.eventExpiresAtMs <= nowMs)) {
      this.volcanoes.delete(state.code);
    } else {
      this.volcanoes.set(state.code, state);
    }
    return { viewChanged: true, durableChanged: true };
  }

  seedVolcanoAlerts(entries: VolcanoSeedEntry[], result: "success" | "failed", nowMs: number): DisplayMutation {
    if (result === "failed") return NO_MUTATION;
    const keys = new Set(entries.map((entry) => entry.volcanoCode));
    let viewChanged = false;
    for (const [key, state] of this.volcanoes) {
      if (!keys.has(key)) {
        const alertWasVisible = state.alertLevel != null && state.alertLevel >= 4;
        state.alertLevel = null;
        state.alertExpiresAtMs = nowMs;
        if (state.eventExpiresAtMs == null || state.eventExpiresAtMs <= nowMs) {
          this.volcanoes.delete(key);
          viewChanged = true;
        } else if (alertWasVisible) {
          viewChanged = true;
        }
      }
    }
    for (const entry of entries) {
      const reportTimeMs = revisionOf(entry.reportDateTime, null, nowMs).reportTimeMs;
      const existing = this.volcanoes.get(entry.volcanoCode);
      const state: VolcanoState = existing ?? {
        code: entry.volcanoCode,
        name: entry.volcanoName,
        alertLevel: null,
        alertExpiresAtMs: null,
        latestEvent: null,
        eventExpiresAtMs: null,
        sourceEventIds: [],
        revision: { reportTimeMs, serial: null },
        restored: false,
      };
      state.name = entry.volcanoName;
      state.alertLevel = entry.alertLevel;
      state.alertExpiresAtMs = entry.alertLevel != null && entry.alertLevel >= 4 ? null : nowMs;
      state.revision = { reportTimeMs, serial: null };
      state.restored = false;
      if (state.alertExpiresAtMs != null && (state.eventExpiresAtMs == null || state.eventExpiresAtMs <= nowMs)) {
        this.volcanoes.delete(entry.volcanoCode);
      } else {
        this.volcanoes.set(entry.volcanoCode, state);
      }
      viewChanged = true;
    }
    const mutation = { viewChanged, durableChanged: true };
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
    for (const [key, state] of this.typhoons) {
      if (state.expiresAtMs <= nowMs) {
        this.typhoons.delete(key);
        viewChanged = true;
        durableChanged = true;
      }
    }
    for (const [key, state] of this.volcanoes) {
      if (state.eventExpiresAtMs != null && state.eventExpiresAtMs <= nowMs) {
        state.eventExpiresAtMs = null;
        state.latestEvent = null;
        viewChanged = true;
        durableChanged = true;
      }
      if (state.alertExpiresAtMs != null && state.alertExpiresAtMs <= nowMs && state.eventExpiresAtMs == null) {
        this.volcanoes.delete(key);
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
    if (this.typhoons.size > 0) {
      const states = [...this.typhoons.values()].sort((a, b) => (a.typhoon.typhoonNumber ?? "").localeCompare(b.typhoon.typhoonNumber ?? ""));
      items.push({
        kind: "typhoon", surface: "corner-right", key: "typhoon:active",
        sourceEventIds: states.map((state) => state.sourceEventId),
        updatedAt: new Date(Math.max(...states.map((state) => state.revision.reportTimeMs))).toISOString(),
        expiresAt: new Date(Math.max(...states.map((state) => state.expiresAtMs))).toISOString(),
        restored: states.every((state) => state.restored), severity: "normal",
        data: { typhoons: states.map((state) => ({ ...state.typhoon })) },
      });
    }
    const volcanoes = [...this.volcanoes.values()].filter((state) => state.alertLevel != null && state.alertLevel >= 4 || state.eventExpiresAtMs != null);
    if (volcanoes.length > 0) {
      const critical = volcanoes.some((state) => (state.alertLevel ?? 0) >= 4 || state.latestEvent === "噴火速報");
      const latest = Math.max(...volcanoes.map((state) => state.revision.reportTimeMs));
      const expires = volcanoes.map((state) => state.eventExpiresAtMs).filter((value): value is number => value != null);
      items.push({
        kind: "volcano", surface: "corner-right", key: "volcano:active",
        sourceEventIds: volcanoes.flatMap((state) => state.sourceEventIds), updatedAt: new Date(latest).toISOString(),
        expiresAt: expires.length === 0 ? null : new Date(Math.max(...expires)).toISOString(),
        restored: volcanoes.every((state) => state.restored), severity: critical ? "critical" : "warning",
        data: { volcanoes: volcanoes.map((state) => ({ code: state.code, name: state.name, alertLevel: state.alertLevel, latestEvent: state.latestEvent })) },
      });
    }
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
      typhoons: [...this.typhoons].map(([key, state]) => ({ key, sourceEventId: state.sourceEventId, typhoon: { ...state.typhoon }, revision: { ...state.revision }, expiresAtMs: state.expiresAtMs })),
      volcanoes: [...this.volcanoes.values()].map((state) => ({ code: state.code, name: state.name, alertLevel: state.alertLevel, alertExpiresAtMs: state.alertExpiresAtMs, latestEvent: state.latestEvent, eventExpiresAtMs: state.eventExpiresAtMs, sourceEventIds: [...state.sourceEventIds], revision: { ...state.revision } })),
      seen: this.revisionGuard.export(),
    };
  }

  restoreActiveState(data: PersistedStandbyStateV1, nowMs: number): void {
    this.heatAlerts.clear();
    this.typhoons.clear();
    this.volcanoes.clear();
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
    for (const state of data.typhoons ?? []) {
      if (state.expiresAtMs > nowMs) this.typhoons.set(state.typhoon.typhoonKey, { sourceEventId: state.sourceEventId, typhoon: { ...state.typhoon }, revision: { ...state.revision }, expiresAtMs: state.expiresAtMs, restored: true });
    }
    for (const state of data.volcanoes ?? []) {
      if (state.alertExpiresAtMs == null || state.alertExpiresAtMs > nowMs || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs) this.volcanoes.set(state.code, { ...state, sourceEventIds: [...state.sourceEventIds], revision: { ...state.revision }, restored: true });
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
