import type { PresentationEvent } from "../presentation/types";
import type { ParsedLgObservationInfo, ParsedNankaiTroughInfo, ParsedTornadoAdvisory } from "../../types";
import type {
  ActiveStandbyCardV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type {
  PersistedStandbyStateV1,
  PersistedVolcanoStateV1,
  PersistedWeatherAlertStateV1,
} from "./standby-persistence";
import { FloodActiveReducer } from "./flood-active-reducer";
import { projectFloodUpdate } from "./project-flood";
import { projectHeatUpdate, projectTyphoonUpdate, projectVolcanoUpdate } from "./project-standby";
import {
  NO_MUTATION,
  revisionOf,
  sortStandbyItems,
  tombstoneTtlForKey,
  type DisplayMutation,
  type StandbyRevision,
} from "./standby-registry";
import { RevisionGuard } from "./revision-guard";
import { nankaiBadgeAction } from "./nankai-status";
import { quakeCardTtlMs, shouldReplaceQuakeHost } from "./quake-card-selection";
import { normalizeTornadoPublishingOffice, tornadoTickerGroupKey } from "./tornado-group-key";

export { RevisionGuard } from "./revision-guard";
export type { PersistedSeenEntry } from "./revision-guard";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const NANKAI_TTL_MS = 7 * DAY_MS;

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
  warningKind: string | null;
  targetKinds: string[];
  alertExpiresAtMs: number | null;
  latestEvent: DisplayVolcanoEventV1 | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  alertRevision: StandbyRevision | null;
  eventRevision: StandbyRevision | null;
  alertRestored: boolean;
  eventRestored: boolean;
}

interface TornadoState {
  publishingOffice: string;
  sourceEventId: string;
  areas: string[];
  isSighted: boolean;
  revision: StandbyRevision;
  expiresAtMs: number;
  restored: boolean;
}

interface QuakeHostState {
  eventId: string;
  maxIntRank: number;
  revision: StandbyRevision;
  expiresAtMs: number;
}

interface LongPeriodState {
  eventId: string;
  maxLgInt: string;
  revision: StandbyRevision;
  hosted: boolean;
  expiresAtMs: number;
  restored: boolean;
}

interface NankaiState {
  sourceEventId: string;
  statusCode: string;
  label: string;
  revision: StandbyRevision;
  expiresAtMs: number;
  restored: boolean;
}

export interface VolcanoSeedEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  reportDateTime: string;
  active?: boolean;
}

export class StandbyStateStore {
  private heatAlerts = new Map<string, HeatState>();
  private typhoons = new Map<string, TyphoonState>();
  private volcanoes = new Map<string, VolcanoState>();
  private tornadoByOffice = new Map<string, TornadoState>();
  private longPeriodByEvent = new Map<string, LongPeriodState>();
  private quakeHost: QuakeHostState | null = null;
  private nankaiTrough: NankaiState | null = null;
  private weatherAlerts = new Map<DisplayWeatherSourceV1, PersistedWeatherAlertStateV1>();
  private readonly floods = new FloodActiveReducer();
  private readonly revisionGuard = new RevisionGuard();
  private readonly changeListeners: Array<() => void> = [];
  private readonly durableListeners: Array<() => void> = [];

  applyEvent(event: PresentationEvent, nowMs: number): DisplayMutation {
    let mutation = NO_MUTATION;
    switch (event.domain) {
      case "earthquake":
        mutation = this.applyEarthquakeHost(event, nowMs);
        break;
      case "heatAlert":
        mutation = this.applyHeat(event, nowMs);
        break;
      case "typhoonAnalysis":
        mutation = this.applyTyphoon(event, nowMs);
        break;
      case "volcano":
        mutation = this.applyVolcano(event, nowMs);
        break;
      case "floodForecast": {
        const update = projectFloodUpdate(event);
        mutation = update == null ? NO_MUTATION : this.floods.apply(update, nowMs);
        break;
      }
      case "tornado":
        mutation = this.applyTornado(event, nowMs);
        break;
      case "lgObservation":
        mutation = this.applyLongPeriod(event, nowMs);
        break;
      case "nankaiTrough":
        mutation = this.applyNankai(event, nowMs);
        break;
      default:
        return NO_MUTATION;
    }
    this.notify(mutation);
    return mutation;
  }

  /** standby state と寿命を共有する ticker の active groupKey。 */
  activeTickerGroupKeys(): Set<string> {
    return new Set([...this.tornadoByOffice.keys()].map(tornadoTickerGroupKey));
  }

  applyWeatherAlerts(
    source: DisplayWeatherSourceV1,
    alerts: DisplayWeatherAlertV1[],
    reportDateTime: string,
    serial: string | null,
    nowMs: number,
  ): DisplayMutation {
    const key = `weather:${source}`;
    const revision = revisionOf(reportDateTime, serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs, DAY_MS)) return NO_MUTATION;
    const before = JSON.stringify(this.weatherAlerts.get(source)?.alerts ?? []);
    if (alerts.length === 0) {
      this.weatherAlerts.delete(source);
    } else {
      this.weatherAlerts.set(source, {
        source,
        alerts: alerts.map(copyWeatherAlert),
        revision,
        expiresAtMs: revision.reportTimeMs + DAY_MS,
      });
    }
    const mutation = {
      viewChanged: before !== JSON.stringify(alerts),
      durableChanged: true,
    };
    this.notify(mutation);
    return mutation;
  }

  snapshotWeatherAlerts(): DisplayWeatherAlertV1[] {
    return [...this.weatherAlerts.values()].flatMap((state) => state.alerts.map(copyWeatherAlert));
  }

  private applyNankai(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedNankaiTroughInfo;
    const status = nankaiBadgeAction(raw.infoSerial?.code ?? null);
    if (status.action === "ignore") return NO_MUTATION;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    if (!this.revisionGuard.accept("nankai:current", revision, nowMs, tombstoneTtlForKey("nankai:current"))) return NO_MUTATION;
    if (status.action === "deactivate" || event.isCancellation) {
      const changed = this.nankaiTrough != null;
      this.nankaiTrough = null;
      return { viewChanged: changed, durableChanged: true };
    }
    const code = raw.infoSerial?.code;
    if (code == null) return NO_MUTATION;
    this.nankaiTrough = { sourceEventId: event.eventId ?? event.id, statusCode: code, label: status.label, revision, expiresAtMs: revision.reportTimeMs + NANKAI_TTL_MS, restored: false };
    return { viewChanged: true, durableChanged: true };
  }

  private applyTornado(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedTornadoAdvisory;
    const publishingOffice = normalizeTornadoPublishingOffice(event.publishingOffice);
    const stateKey = tornadoTickerGroupKey(publishingOffice);
    const revision = revisionOf(event.reportDateTime, event.serial ?? raw.serial, nowMs);
    if (!this.revisionGuard.accept(stateKey, revision, nowMs, tombstoneTtlForKey(stateKey))) return NO_MUTATION;
    if (event.isCancellation || raw.activeAreaCount === 0) {
      return { viewChanged: this.tornadoByOffice.delete(publishingOffice), durableChanged: true };
    }
    const validMs = raw.validDateTime == null ? Number.NaN : Date.parse(raw.validDateTime);
    this.tornadoByOffice.set(publishingOffice, {
      publishingOffice,
      sourceEventId: event.id,
      areas: event.areaItems.map((area) => area.name),
      isSighted: raw.hasSightingAreas,
      revision,
      expiresAtMs: Number.isNaN(validMs) ? revision.reportTimeMs + HOUR_MS : validMs,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  private applyLongPeriod(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.eventId == null || event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedLgObservationInfo;
    const key = `longPeriod:${event.eventId}`;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs, tombstoneTtlForKey(key))) return NO_MUTATION;
    if (event.isCancellation) {
      const changed = this.longPeriodByEvent.delete(event.eventId);
      return { viewChanged: changed, durableChanged: true };
    }
    if (raw.maxLgInt == null) return { viewChanged: false, durableChanged: true };
    const existing = this.longPeriodByEvent.get(event.eventId);
    const host = this.quakeHost?.eventId === event.eventId && this.quakeHost.expiresAtMs > nowMs
      ? this.quakeHost
      : null;
    this.longPeriodByEvent.set(event.eventId, {
      eventId: event.eventId,
      maxLgInt: raw.maxLgInt,
      revision,
      hosted: host != null,
      expiresAtMs: host?.expiresAtMs ?? (existing?.hosted === true ? existing.expiresAtMs : revision.reportTimeMs + 12 * HOUR_MS),
      restored: false,
    });
    return { viewChanged: host != null || existing?.hosted === true, durableChanged: true };
  }

  private applyEarthquakeHost(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.isCancellation || event.eventId == null) return NO_MUTATION;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    const candidate = { eventId: event.eventId, maxIntRank: event.maxIntRank };
    if (!shouldReplaceQuakeHost(this.quakeHost, candidate, nowMs)) return NO_MUTATION;
    const expiresAtMs = nowMs + quakeCardTtlMs(event.maxIntRank ?? 0);
    this.quakeHost = { ...candidate, maxIntRank: candidate.maxIntRank ?? 0, revision, expiresAtMs };
    let changed = false;
    for (const [eventId, state] of this.longPeriodByEvent) {
      if (eventId !== event.eventId) {
        this.longPeriodByEvent.delete(eventId);
        changed ||= state.hosted;
      }
    }
    const rider = this.longPeriodByEvent.get(event.eventId);
    if (rider == null) return { viewChanged: changed, durableChanged: true };
    rider.hosted = true;
    rider.restored = false;
    rider.expiresAtMs = expiresAtMs;
    return { viewChanged: true, durableChanged: true };
  }

  private applyTyphoon(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectTyphoonUpdate(event);
    if (update == null) return NO_MUTATION;
    const key = `typhoon:${update.typhoonKey}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs, tombstoneTtlForKey(key))) return NO_MUTATION;
    if (update.isCancellation) {
      return { viewChanged: this.typhoons.delete(update.typhoonKey), durableChanged: true };
    }
    const previous = this.typhoons.get(update.typhoonKey)?.typhoon;
    const pressureDeltaHpa = numericDelta(update.typhoon.pressureHpa, previous?.pressureHpa);
    const maxWindDeltaMs = numericDelta(update.typhoon.maxWindMs, previous?.maxWindMs);
    this.typhoons.set(update.typhoonKey, {
      sourceEventId: update.sourceEventId,
      typhoon: {
        ...update.typhoon,
        pressureDeltaHpa,
        maxWindDeltaMs,
        intensityTrend: typhoonIntensityTrend(pressureDeltaHpa, maxWindDeltaMs),
      },
      revision,
      expiresAtMs: revision.reportTimeMs + DAY_MS,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  private applyVolcano(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectVolcanoUpdate(event);
    if (update == null) return NO_MUTATION;
    const key = `volcano:${update.kind === "alert" ? "alert" : "event"}:${update.volcano.code}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs, tombstoneTtlForKey(key))) return NO_MUTATION;
    const previous = this.volcanoes.get(update.volcano.code);
    const state: VolcanoState = previous ?? {
      code: update.volcano.code,
      name: update.volcano.name,
      alertLevel: null,
      warningKind: null,
      targetKinds: [],
      alertExpiresAtMs: null,
      latestEvent: null,
      eventExpiresAtMs: null,
      sourceEventIds: [],
      alertRevision: null,
      eventRevision: null,
      alertRestored: false,
      eventRestored: false,
    };
    state.name = update.volcano.name;
    if (!state.sourceEventIds.includes(update.sourceEventId)) state.sourceEventIds.push(update.sourceEventId);
    if (update.kind === "alert") {
      state.alertRestored = false;
      state.alertRevision = revision;
      if (update.isCancellation) {
        state.alertLevel = null;
        state.warningKind = null;
        state.targetKinds = [];
        state.alertExpiresAtMs = nowMs;
      } else {
        state.alertLevel = update.volcano.alertLevel;
        state.warningKind = update.volcano.warningKind ?? null;
        state.targetKinds = [...(update.volcano.targetKinds ?? [])];
        // レベル3以下も次の解除まで現況として保持する。カード化は snapshot 側で
        // レベル4以上または噴火イベントありに限定する。
        state.alertExpiresAtMs = null;
      }
    } else {
      state.eventRestored = false;
      state.eventRevision = revision;
      state.latestEvent = update.isCancellation ? null : copyVolcanoEvent(update.volcano.latestEvent);
      state.eventExpiresAtMs = update.isCancellation ? null : revision.reportTimeMs + DAY_MS;
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
    const keys = new Set(entries.filter((entry) => entry.active !== false).map((entry) => entry.volcanoCode));
    let viewChanged = false;
    for (const [key, state] of this.volcanoes) {
      if (!keys.has(key)) {
        const alertKey = `volcano:alert:${key}`;
        this.revisionGuard.replace(alertKey, { reportTimeMs: nowMs, serial: null }, nowMs, tombstoneTtlForKey(alertKey));
        const alertWasVisible = state.alertLevel != null && state.alertLevel >= 4
          || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs;
        state.alertLevel = null;
        state.warningKind = null;
        state.targetKinds = [];
        state.alertExpiresAtMs = nowMs;
        state.alertRevision = { reportTimeMs: nowMs, serial: null };
        state.alertRestored = false;
        if (state.eventExpiresAtMs == null || state.eventExpiresAtMs <= nowMs) {
          this.volcanoes.delete(key);
          viewChanged = true;
        } else if (alertWasVisible) {
          viewChanged = true;
        }
      }
    }
    for (const entry of entries) {
      const revision = revisionOf(entry.reportDateTime, null, nowMs);
      const alertKey = `volcano:alert:${entry.volcanoCode}`;
      this.revisionGuard.replace(alertKey, revision, nowMs, tombstoneTtlForKey(alertKey));
      if (entry.active === false) continue;
      const existing = this.volcanoes.get(entry.volcanoCode);
      const state: VolcanoState = existing ?? {
        code: entry.volcanoCode,
        name: entry.volcanoName,
        alertLevel: null,
        warningKind: null,
        targetKinds: [],
        alertExpiresAtMs: null,
        latestEvent: null,
        eventExpiresAtMs: null,
        sourceEventIds: [],
        alertRevision: revision,
        eventRevision: null,
        alertRestored: false,
        eventRestored: false,
      };
      state.name = entry.volcanoName;
      state.alertLevel = entry.alertLevel;
      state.alertExpiresAtMs = null;
      state.alertRevision = revision;
      state.alertRestored = false;
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
    const areaName = update.areas[0]?.areaName;
    if (areaName == null) return NO_MUTATION;
    const key = `heat:${update.targetDate}:${areaName}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (!this.revisionGuard.accept(key, revision, nowMs, tombstoneTtlForKey(key))) return NO_MUTATION;
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
    for (const [office, state] of this.tornadoByOffice) {
      if (state.expiresAtMs <= nowMs) {
        this.tornadoByOffice.delete(office);
        viewChanged = true;
        durableChanged = true;
      }
    }
    for (const [eventId, state] of this.longPeriodByEvent) {
      if (state.expiresAtMs <= nowMs) {
        this.longPeriodByEvent.delete(eventId);
        viewChanged ||= state.hosted;
        durableChanged = true;
      }
    }
    if (this.quakeHost != null && this.quakeHost.expiresAtMs <= nowMs) {
      this.quakeHost = null;
      durableChanged = true;
    }
    if (this.nankaiTrough != null && this.nankaiTrough.expiresAtMs <= nowMs) {
      this.nankaiTrough = null;
      viewChanged = true;
      durableChanged = true;
    }
    for (const [source, state] of this.weatherAlerts) {
      if (state.expiresAtMs <= nowMs) {
        this.weatherAlerts.delete(source);
        viewChanged = true;
        durableChanged = true;
      }
    }
    if (this.revisionGuard.sweep(nowMs)) durableChanged = true;
    const floodMutation = this.floods.sweep(nowMs);
    viewChanged ||= floodMutation.viewChanged;
    durableChanged ||= floodMutation.durableChanged;
    const mutation = { viewChanged, durableChanged };
    this.notify(mutation);
    return mutation;
  }

  snapshotItems(): ActiveStandbyCardV1[] {
    const items: ActiveStandbyCardV1[] = [];
    const heatByDate = new Map<string, HeatState[]>();
    for (const state of this.heatAlerts.values()) {
      const states = heatByDate.get(state.targetDate) ?? [];
      states.push(state);
      heatByDate.set(state.targetDate, states);
    }
    for (const [targetDate, states] of heatByDate) items.push({
      kind: "heat", surface: "corner-right", key: `heat:${targetDate}`,
      sourceEventIds: states.flatMap((state) => state.sourceEventIds),
      updatedAt: new Date(Math.max(...states.map((state) => state.revision.reportTimeMs))).toISOString(),
      expiresAt: new Date(Math.max(...states.map((state) => state.targetDateEndMs))).toISOString(),
      restored: states.some((state) => state.restored),
      severity: states.some((state) => state.isSpecial) ? "critical" : "warning",
      data: { targetDate, areas: states.flatMap((state) => state.areas.map((area) => ({ ...area }))) },
    });
    if (this.typhoons.size > 0) {
      const states = [...this.typhoons.values()].sort((a, b) => (a.typhoon.typhoonNumber ?? "").localeCompare(b.typhoon.typhoonNumber ?? ""));
      items.push({
        kind: "typhoon", surface: "corner-right", key: "typhoon:active",
        sourceEventIds: states.map((state) => state.sourceEventId),
        updatedAt: new Date(Math.max(...states.map((state) => state.revision.reportTimeMs))).toISOString(),
        expiresAt: new Date(Math.max(...states.map((state) => state.expiresAtMs))).toISOString(),
        restored: states.some((state) => state.restored), severity: "normal",
        data: { typhoons: states.map((state) => ({ ...state.typhoon })) },
      });
    }
    const volcanoes = [...this.volcanoes.values()].filter((state) => state.alertLevel != null && state.alertLevel >= 4 || state.eventExpiresAtMs != null);
    if (volcanoes.length > 0) {
      const critical = volcanoes.some((state) =>
        (state.alertLevel ?? 0) >= 4 || state.latestEvent?.label === "噴火速報"
      );
      const latest = Math.max(...volcanoes.flatMap((state) => [state.alertRevision?.reportTimeMs, state.eventRevision?.reportTimeMs].filter((value): value is number => value != null)));
      const expires = volcanoes.map((state) => state.eventExpiresAtMs).filter((value): value is number => value != null);
      items.push({
        kind: "volcano", surface: "corner-right", key: "volcano:active",
        sourceEventIds: volcanoes.flatMap((state) => state.sourceEventIds), updatedAt: new Date(latest).toISOString(),
        expiresAt: expires.length === 0 ? null : new Date(Math.max(...expires)).toISOString(),
        restored: volcanoes.some((state) =>
          state.alertLevel != null && state.alertLevel >= 4 && state.alertRestored
          || state.eventExpiresAtMs != null && state.eventRestored
        ), severity: critical ? "critical" : "warning",
        data: { volcanoes: volcanoes.map((state) => ({
          code: state.code,
          name: state.name,
          alertLevel: state.alertLevel,
          warningKind: state.warningKind,
          targetKinds: [...state.targetKinds],
          latestEvent: copyVolcanoEvent(state.latestEvent),
        })) },
      });
    }
    const flood = this.floods.snapshotCard();
    if (flood != null) items.push(flood);
    if (this.tornadoByOffice.size > 0) {
      const states = [...this.tornadoByOffice.values()];
      const areas = [...new Set(states.flatMap((state) => state.areas))];
      items.push({
        kind: "tornado", surface: "weather-rider", key: "tornado:active",
        sourceEventIds: states.map((state) => state.sourceEventId),
        updatedAt: new Date(Math.max(...states.map((state) => state.revision.reportTimeMs))).toISOString(),
        expiresAt: new Date(Math.max(...states.map((state) => state.expiresAtMs))).toISOString(),
        restored: states.some((state) => state.restored),
        severity: states.some((state) => state.isSighted) ? "critical" : "warning",
        data: { areas, isSighted: states.some((state) => state.isSighted) },
      });
    }
    for (const state of this.longPeriodByEvent.values()) if (state.hosted) items.push({
      kind: "longPeriod", surface: "quake-rider", key: `longPeriod:${state.eventId}`, sourceEventIds: [state.eventId],
      updatedAt: new Date(state.revision.reportTimeMs).toISOString(), expiresAt: new Date(state.expiresAtMs).toISOString(), restored: state.restored,
      severity: state.maxLgInt === "4" ? "critical" : "warning", data: { eventId: state.eventId, maxLgInt: state.maxLgInt },
    });
    if (this.nankaiTrough != null) items.push({
      kind: "nankaiTrough", surface: "clock-below", key: "nankai:current", sourceEventIds: [this.nankaiTrough.sourceEventId],
      updatedAt: new Date(this.nankaiTrough.revision.reportTimeMs).toISOString(), expiresAt: new Date(this.nankaiTrough.expiresAtMs).toISOString(), restored: this.nankaiTrough.restored,
      severity: this.nankaiTrough.label.includes("警戒") ? "critical" : "warning", data: { statusCode: this.nankaiTrough.statusCode, label: this.nankaiTrough.label },
    });
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
      volcanoes: [...this.volcanoes.values()].map((state) => ({
        code: state.code,
        name: state.name,
        alertLevel: state.alertLevel,
        warningKind: state.warningKind,
        targetKinds: [...state.targetKinds],
        alertExpiresAtMs: state.alertExpiresAtMs,
        latestEvent: copyVolcanoEvent(state.latestEvent),
        eventExpiresAtMs: state.eventExpiresAtMs,
        sourceEventIds: [...state.sourceEventIds],
        alertRevision: state.alertRevision == null ? null : { ...state.alertRevision },
        eventRevision: state.eventRevision == null ? null : { ...state.eventRevision },
      })),
      floods: this.floods.exportState(),
      weatherAlerts: [...this.weatherAlerts.values()].map((state) => ({
        source: state.source,
        alerts: state.alerts.map(copyWeatherAlert),
        revision: { ...state.revision },
        expiresAtMs: state.expiresAtMs,
      })),
      tornado: [...this.tornadoByOffice.values()].map((state) => ({ publishingOffice: state.publishingOffice, sourceEventId: state.sourceEventId, areas: [...state.areas], isSighted: state.isSighted, revision: { ...state.revision }, expiresAtMs: state.expiresAtMs })),
      longPeriod: [...this.longPeriodByEvent.values()].map((state) => ({ eventId: state.eventId, maxLgInt: state.maxLgInt, revision: { ...state.revision }, hosted: state.hosted, expiresAtMs: state.expiresAtMs })),
      quakeHost: this.quakeHost == null ? null : { ...this.quakeHost, revision: { ...this.quakeHost.revision } },
      nankaiTrough: this.nankaiTrough == null ? null : { sourceEventId: this.nankaiTrough.sourceEventId, statusCode: this.nankaiTrough.statusCode, label: this.nankaiTrough.label, revision: { ...this.nankaiTrough.revision }, expiresAtMs: this.nankaiTrough.expiresAtMs },
      seen: this.revisionGuard.export(),
    };
  }

  restoreActiveState(data: PersistedStandbyStateV1, nowMs: number): void {
    this.heatAlerts.clear();
    this.typhoons.clear();
    this.volcanoes.clear();
    this.tornadoByOffice.clear();
    this.longPeriodByEvent.clear();
    this.quakeHost = null;
    this.nankaiTrough = null;
    this.weatherAlerts.clear();
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
      if (state.expiresAtMs > nowMs) {
        this.typhoons.set(state.typhoon.typhoonKey, {
          sourceEventId: state.sourceEventId,
          typhoon: {
            ...state.typhoon,
            pressureDeltaHpa: state.typhoon.pressureDeltaHpa ?? null,
            maxGustMs: state.typhoon.maxGustMs ?? null,
            maxWindDeltaMs: state.typhoon.maxWindDeltaMs ?? null,
            intensityTrend: state.typhoon.intensityTrend ?? null,
          },
          revision: { ...state.revision },
          expiresAtMs: state.expiresAtMs,
          restored: true,
        });
      }
    }
    for (const state of data.volcanoes ?? []) {
      if (state.alertExpiresAtMs == null || state.alertExpiresAtMs > nowMs || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs) {
        this.volcanoes.set(state.code, {
          ...state,
          warningKind: state.warningKind ?? null,
          targetKinds: [...(state.targetKinds ?? [])],
          latestEvent: restoreVolcanoEvent(state.latestEvent),
          sourceEventIds: [...state.sourceEventIds],
          alertRevision: state.alertRevision == null ? null : { ...state.alertRevision },
          eventRevision: state.eventRevision == null ? null : { ...state.eventRevision },
          alertRestored: state.alertRevision != null,
          eventRestored: state.eventRevision != null,
        });
      }
    }
    for (const state of data.tornado ?? []) if (state.expiresAtMs > nowMs) this.tornadoByOffice.set(state.publishingOffice, { ...state, areas: [...state.areas], revision: { ...state.revision }, restored: true });
    if (data.quakeHost != null && data.quakeHost.expiresAtMs > nowMs) this.quakeHost = { ...data.quakeHost, revision: { ...data.quakeHost.revision } };
    for (const state of data.longPeriod ?? []) if (state.expiresAtMs > nowMs) this.longPeriodByEvent.set(state.eventId, {
      ...state,
      hosted: state.hosted && this.quakeHost?.eventId === state.eventId,
      revision: { ...state.revision },
      restored: true,
    });
    if (data.nankaiTrough != null && data.nankaiTrough.expiresAtMs > nowMs) this.nankaiTrough = { ...data.nankaiTrough, revision: { ...data.nankaiTrough.revision }, restored: true };
    for (const state of data.weatherAlerts ?? []) {
      if (state.expiresAtMs <= nowMs) continue;
      this.weatherAlerts.set(state.source, {
        source: state.source,
        alerts: state.alerts.map(copyWeatherAlert),
        revision: { ...state.revision },
        expiresAtMs: state.expiresAtMs,
      });
    }
    this.floods.restoreState(data.floods ?? { events: [], seen: [] }, nowMs);
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

function copyWeatherAlert(alert: DisplayWeatherAlertV1): DisplayWeatherAlertV1 {
  return {
    ...alert,
    items: alert.items.map((item) => ({ ...item, shownAreas: [...item.shownAreas] })),
  };
}

function copyVolcanoEvent(
  event: DisplayVolcanoEventV1 | null | undefined,
): DisplayVolcanoEventV1 | null {
  return event == null ? null : { ...event };
}

function restoreVolcanoEvent(
  event: PersistedVolcanoStateV1["latestEvent"],
): DisplayVolcanoEventV1 | null {
  if (event == null) return null;
  if (typeof event !== "string") return { ...event };
  return {
    label: event,
    craterName: null,
    eventDateTime: null,
    plumeHeightM: null,
    plumeHeightUnknown: false,
    plumeDirection: null,
  };
}

function numericDelta(current: number | null, previous: number | null | undefined): number | null {
  return current == null || previous == null ? null : current - previous;
}

function typhoonIntensityTrend(
  pressureDeltaHpa: number | null,
  maxWindDeltaMs: number | null,
): DisplayTyphoonV1["intensityTrend"] {
  if (pressureDeltaHpa == null || maxWindDeltaMs == null) return null;
  if (pressureDeltaHpa < 0 || maxWindDeltaMs > 0) return "developing";
  if (pressureDeltaHpa > 0 || maxWindDeltaMs < 0) return "weakening";
  return "steady";
}
