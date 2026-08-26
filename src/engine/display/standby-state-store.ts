import type { PresentationEvent } from "../presentation/types";
import type {
  ParsedLegacyCounterpartInfo,
  ParsedLgObservationInfo,
  ParsedNankaiTroughInfo,
  ParsedTornadoAdvisory,
  ParsedWeatherBriefing,
  SpecialValue,
} from "../../types";
import * as log from "../../logger";
import type {
  ActiveStandbyCardV1,
  DisplayBriefingEntryV1,
  DisplayBriefingSeverityEvidenceV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoAlertClassV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type {
  PersistedTelegramFoundationV2,
  PersistedStandbyState,
  PersistedStandbyStateV1,
  PersistedVolcanoStateV1,
  PersistedWeatherAlertStateV1,
} from "./standby-persistence";
import { persistedLongPeriodSafetyRank } from "./standby-persistence";
import { FloodActiveReducer, type PersistedFloodState } from "./flood-active-reducer";
import { projectFloodUpdate } from "./project-flood";
import { resolveQuakeIntensitySafetyRank } from "./project-event";
import { projectHeatUpdate, projectTyphoonUpdate, projectVolcanoUpdates, type VolcanoUpdate } from "./project-standby";
import {
  BRIEFING_CARD_CANCEL_TTL_MS,
  BRIEFING_CARD_KEY,
  BRIEFING_CARD_MAX_ENTRIES,
  BRIEFING_CARD_TTL_MS,
  NO_MUTATION,
  compareRevision,
  revisionOf,
  sortStandbyItems,
  type DisplayMutation,
  type StandbyRevision,
} from "./standby-registry";
import { RevisionGuard } from "./revision-guard";
import { nankaiBadgeAction } from "./nankai-status";
import { quakeCardTtlMs, shouldReplaceQuakeHost } from "./quake-card-selection";
import {
  copyDisplayPlumeHeightSemantic,
  legacyDisplayPlumeHeightSemantics,
} from "./plume-height-semantic";
import { normalizeTornadoPublishingOffice, tornadoTickerGroupKey } from "./tornado-group-key";
import { FLOOD_FORECAST_MAX_SUBJECTS } from "../messages/revision-family-registry";
import {
  briefingFrameLevel,
  formatLgIntensitySpecialValue,
  resolveLgIntensitySafetyRank,
} from "../presentation/level-helpers";
import { typhoonNumericValueFromLegacyScalar } from "../typhoon-numeric-persistence";
import { projectTyphoonNumericSemantic } from "./typhoon-numeric-semantic";
import { attachWeatherExpandedKinds } from "./weather-expanded-kinds";

export { RevisionGuard } from "./revision-guard";
export type { PersistedSeenEntry } from "./revision-guard";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const NANKAI_TTL_MS = 7 * DAY_MS;

function combineMutations(left: DisplayMutation, right: DisplayMutation): DisplayMutation {
  const cardEvictedKey = right.cardEvictedKey ?? left.cardEvictedKey;
  return {
    viewChanged: left.viewChanged || right.viewChanged,
    durableChanged: left.durableChanged || right.durableChanged,
    ...(cardEvictedKey == null ? {} : { cardEvictedKey }),
  };
}

interface HeatState {
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
  restored: boolean;
}

interface TyphoonState {
  sourceEventId: string;
  typhoon: DisplayTyphoonV1;
  pressureHpaValue: SpecialValue<number>;
  maxWindMsValue: SpecialValue<number>;
  maxGustMsValue: SpecialValue<number>;
  moveSpeedKmhValue: SpecialValue<number>;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
  expiresAtMs: number;
  restored: boolean;
}

/** frontend の typhoon-header-tone と同じ階級で、台風カードの選抜 severity を決める。 */
export function typhoonStandbySeverity(
  typhoons: ReadonlyArray<Pick<DisplayTyphoonV1, "intensityClass" | "sizeClass">>,
): ActiveStandbyCardV1["severity"] {
  if (typhoons.some((typhoon) => typhoon.intensityClass === "猛烈な")) return "critical";
  if (typhoons.some((typhoon) =>
    typhoon.intensityClass === "非常に強い" || typhoon.sizeClass === "超大型"
  )) return "warning";
  return "normal";
}

interface VolcanoState {
  code: string;
  name: string;
  alertLevel: number | null;
  alertClass: DisplayVolcanoAlertClassV1 | null;
  warningKind: string | null;
  targetKinds: string[];
  alertExpiresAtMs: number | null;
  latestEvent: DisplayVolcanoEventV1 | null;
  latestEventId: string | null;
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
  appliedSemanticKey?: string;
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
  safetyRank: number | null;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
  hosted: boolean;
  expiresAtMs: number;
  restored: boolean;
}

interface NankaiState {
  sourceEventId: string;
  statusCode: string;
  label: string;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
  expiresAtMs: number;
  restored: boolean;
}

interface BriefingCardEntryState {
  entry: DisplayBriefingEntryV1;
  updatedAtMs: number;
  expiresAtMs: number;
}

type BriefingCardEntryCandidate = BriefingCardEntryState;

export type BriefingCardMutationResult =
  | {
      kind: "applied";
      status: "applied";
      applied: true;
      generation: number;
      evictedKey: string | null;
      action: "upsert" | "expiredCancellationRemoved" | "pruned";
    }
  | {
      kind: "ignored";
      status: "ignored";
      applied: false;
      generation: number;
      evictedKey: null;
      reason: "notBriefing" | "expired" | "unchanged";
    };

export type CardReconcileResult =
  | {
      kind: "applied";
      status: "applied";
      applied: true;
      sourceKey: string;
      canonicalKey: string;
      generation: number;
      expiresAt: string | null;
      canonicalInserted: boolean;
      evictedKey: null;
    }
  | {
      kind: "ignored";
      status: "ignored";
      applied: false;
      sourceKey: string;
      canonicalKey: string | null;
      generation: number;
      evictedKey: null;
      reason: "sourceNotFound" | "sourceNotVpoa50" | "canonicalNotBriefing" | "expired";
    };

export interface VolcanoSeedEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  alertClass?: DisplayVolcanoAlertClassV1 | null;
  warningKind?: string | null;
  targetKinds?: string[];
  reportDateTime: string;
  active?: boolean;
}

export class StandbyStateStore {
  private heatAlerts = new Map<string, HeatState>();
  private typhoons = new Map<string, TyphoonState>();
  private volcanoes = new Map<string, VolcanoState>();
  private readonly managedVolcanoAlerts = new Set<string>();
  private readonly managedVolcanoEruptions = new Set<string>();
  private tornadoByOffice = new Map<string, TornadoState>();
  private longPeriodByEvent = new Map<string, LongPeriodState>();
  private quakeHost: QuakeHostState | null = null;
  private nankaiTrough: NankaiState | null = null;
  private weatherAlerts = new Map<DisplayWeatherSourceV1, PersistedWeatherAlertStateV1>();
  private readonly floods = new FloodActiveReducer();
  /** v1 / pre-flood-v2 由来で、まだ共通 gate の正規報を受けていない表示 EventID。 */
  private readonly legacyFloodEventIds = new Set<string>();
  /** v1 migration survivors are not pruned until each subject receives a foundation-gated report. */
  private readonly managedStandbySubjects = new Map<string, Set<string>>();
  private readonly revisionGuard = new RevisionGuard();
  /** VPBS50／VPOA50 browser card only. This map is intentionally non-persistent. */
  private readonly briefingEntries = new Map<string, BriefingCardEntryState>();
  private briefingGeneration = 0;
  private readonly changeListeners: Array<() => void> = [];
  private readonly durableListeners: Array<() => void> = [];

  applyEvent(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.domain === "earthquake" && event.foundationMutationAccepted === false) {
      return NO_MUTATION;
    }
    if (
      ["briefing", "legacyCounterpart"].includes(event.domain)
      && event.foundationMutationAccepted === false
    ) return NO_MUTATION;
    if (
      ["tornado", "heatAlert", "typhoonAnalysis", "nankaiTrough", "lgObservation"].includes(event.domain)
      && event.standbyStateMutationAccepted === false
    ) return NO_MUTATION;
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
        if (update != null) this.legacyFloodEventIds.delete(update.eventId);
        if (event.floodStateMutationAccepted === true && event.floodActiveEventIds != null) {
          mutation = combineMutations(
            mutation,
            this.floods.retainActiveEventIds([
              ...event.floodActiveEventIds,
              ...this.legacyFloodEventIds,
            ]),
          );
        }
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
      case "briefing":
      case "legacyCounterpart": {
        const result = this.applyBriefingCardEvent(event, nowMs);
        mutation = briefingCardMutationToDisplayMutation(result);
        break;
      }
      default:
        return NO_MUTATION;
    }
    if (event.standbyStateMutationAccepted === true && event.standbyStateSubject != null) {
      const managed = this.managedStandbySubjects.get(event.domain) ?? new Set<string>();
      managed.add(event.standbyStateSubject);
      this.managedStandbySubjects.set(event.domain, managed);
      mutation = combineMutations(
        mutation,
        this.retainManagedStandbySubjects(event.domain, event.standbyActiveSubjects ?? []),
      );
    }
    this.notify(mutation);
    return mutation;
  }

  /**
   * Apply only the browser-card projection for VPBS50 or VPOA50.
   * The normal applyEvent path owns notification; this method is public for
   * card-only tests and for the later typed reconcile sink.
   */
  applyBriefingCardEvent(event: PresentationEvent, nowMs: number): BriefingCardMutationResult {
    const candidate = briefingCardEntryCandidate(event, nowMs);
    if (candidate == null) {
      return {
        kind: "ignored", status: "ignored", applied: false,
        generation: this.briefingGeneration, evictedKey: null, reason: "notBriefing",
      };
    }
    return this.upsertBriefingCardEntry(candidate, nowMs);
  }

  /**
   * Atomically replace one VPOA50 card entry with its canonical VPBS50 entry.
   * No ticker key, receipt, or ticker state is consulted here.
   */
  reconcileBriefingCard(
    sourceKey: string,
    canonicalEvent: PresentationEvent,
    nowMs: number,
  ): CardReconcileResult {
    const pruned = this.pruneBriefingCardEntries(nowMs);
    const source = this.briefingEntries.get(sourceKey);
    const canonicalCandidate = briefingCardEntryCandidate(canonicalEvent, nowMs);
    const canonicalKey = canonicalCandidate?.entry.key ?? null;
    if (source == null) {
      if (pruned) this.notify({ viewChanged: true, durableChanged: false });
      return {
        kind: "ignored", status: "ignored", applied: false, sourceKey, canonicalKey,
        generation: this.briefingGeneration, evictedKey: null, reason: "sourceNotFound",
      };
    }
    if (source.entry.source !== "vpoa50") {
      if (pruned) this.notify({ viewChanged: true, durableChanged: false });
      return {
        kind: "ignored", status: "ignored", applied: false, sourceKey, canonicalKey,
        generation: this.briefingGeneration, evictedKey: null, reason: "sourceNotVpoa50",
      };
    }
    if (canonicalCandidate == null || canonicalCandidate.entry.source !== "vpbs50") {
      if (pruned) this.notify({ viewChanged: true, durableChanged: false });
      return {
        kind: "ignored", status: "ignored", applied: false, sourceKey, canonicalKey,
        generation: this.briefingGeneration, evictedKey: null, reason: "canonicalNotBriefing",
      };
    }
    if (canonicalKey === sourceKey) {
      if (pruned) this.notify({ viewChanged: true, durableChanged: false });
      return {
        kind: "ignored", status: "ignored", applied: false, sourceKey, canonicalKey,
        generation: this.briefingGeneration, evictedKey: null, reason: "canonicalNotBriefing",
      };
    }

    const expiresAtMs = Math.min(source.expiresAtMs, canonicalCandidate.expiresAtMs);
    if (expiresAtMs <= nowMs) {
      const generation = this.briefingGeneration + 1;
      this.briefingEntries.delete(sourceKey);
      this.briefingGeneration = generation;
      this.notify({ viewChanged: true, durableChanged: false });
      return {
        kind: "applied", status: "applied", applied: true, sourceKey,
        canonicalKey: canonicalCandidate.entry.key, generation, expiresAt: null,
        canonicalInserted: false, evictedKey: null,
      };
    }

    const generation = this.briefingGeneration + 1;
    const entry: DisplayBriefingEntryV1 = {
      ...canonicalCandidate.entry,
      expiresAt: new Date(expiresAtMs).toISOString(),
      generation,
    };
    this.briefingEntries.delete(sourceKey);
    const resolvedCanonicalKey = canonicalCandidate.entry.key;
    this.briefingEntries.set(resolvedCanonicalKey, {
      entry,
      updatedAtMs: canonicalCandidate.updatedAtMs,
      expiresAtMs,
    });
    this.briefingGeneration = generation;
    this.notify({ viewChanged: true, durableChanged: false });
    return {
      kind: "applied", status: "applied", applied: true, sourceKey, canonicalKey: resolvedCanonicalKey,
      generation, expiresAt: entry.expiresAt, canonicalInserted: true, evictedKey: null,
    };
  }

  /** Current card-only mutation generation, for targeted reconcile tests. */
  briefingCardGeneration(): number {
    return this.briefingGeneration;
  }

  /** Current number of active card entries before the next sweep. */
  briefingCardEntryCount(): number {
    return this.briefingEntries.size;
  }

  private upsertBriefingCardEntry(
    candidate: BriefingCardEntryCandidate,
    nowMs: number,
  ): BriefingCardMutationResult {
    const pruned = this.pruneBriefingCardEntries(nowMs);
    const previous = this.briefingEntries.get(candidate.entry.key);
    if (candidate.expiresAtMs <= nowMs) {
      if (candidate.entry.source === "vpbs50" && candidate.entry.frameLevel === "cancel" && previous != null) {
        this.briefingEntries.delete(candidate.entry.key);
        this.briefingGeneration += 1;
        return {
          kind: "applied", status: "applied", applied: true,
          generation: this.briefingGeneration, evictedKey: null, action: "expiredCancellationRemoved",
        };
      }
      return pruned
        ? {
            kind: "applied", status: "applied", applied: true,
            generation: this.briefingGeneration, evictedKey: null, action: "pruned",
          }
        : {
            kind: "ignored", status: "ignored", applied: false,
            generation: this.briefingGeneration, evictedKey: null, reason: "expired",
          };
    }
    if (previous != null && sameBriefingCardEntry(previous.entry, candidate.entry)) {
      return pruned
        ? {
            kind: "applied", status: "applied", applied: true,
            generation: this.briefingGeneration, evictedKey: null, action: "pruned",
          }
        : {
            kind: "ignored", status: "ignored", applied: false,
            generation: this.briefingGeneration, evictedKey: null, reason: "unchanged",
          };
    }

    let evictedKey: string | null = null;
    if (previous == null && this.briefingEntries.size >= BRIEFING_CARD_MAX_ENTRIES) {
      const victim = [...this.briefingEntries.values()]
        .sort((left, right) => left.updatedAtMs - right.updatedAtMs || compareBriefingKeys(left.entry.key, right.entry.key))[0];
      if (victim != null) {
        this.briefingEntries.delete(victim.entry.key);
        evictedKey = victim.entry.key;
      }
    }

    const generation = this.briefingGeneration + 1;
    const entry: DisplayBriefingEntryV1 = { ...candidate.entry, generation };
    this.briefingEntries.set(entry.key, {
      entry,
      updatedAtMs: candidate.updatedAtMs,
      expiresAtMs: candidate.expiresAtMs,
    });
    this.briefingGeneration = generation;
    return {
      kind: "applied", status: "applied", applied: true,
      generation, evictedKey, action: "upsert",
    };
  }

  private pruneBriefingCardEntries(nowMs: number): boolean {
    let changed = false;
    for (const [key, state] of this.briefingEntries) {
      if (state.expiresAtMs <= nowMs) {
        this.briefingEntries.delete(key);
        changed = true;
      }
    }
    if (changed) this.briefingGeneration += 1;
    return changed;
  }

  private retainManagedStandbySubjects(
    domain: string,
    activeSubjects: readonly string[],
  ): DisplayMutation {
    const active = new Set(activeSubjects);
    let changed = false;
    const managed = this.managedStandbySubjects.get(domain);
    if (managed == null) return NO_MUTATION;
    for (const subject of [...managed]) {
      if (active.has(subject)) continue;
      managed.delete(subject);
      if (subject.startsWith("tornado:")) {
        changed = this.tornadoByOffice.delete(subject.slice("tornado:".length)) || changed;
      } else if (subject.startsWith("heat:")) {
        changed = this.heatAlerts.delete(subject) || changed;
      } else if (subject.startsWith("typhoon:")) {
        changed = this.typhoons.delete(subject.slice("typhoon:".length)) || changed;
      } else if (subject === "nankai:current") {
        changed ||= this.nankaiTrough != null;
        this.nankaiTrough = null;
      } else if (subject.startsWith("longPeriod:")) {
        changed = this.longPeriodByEvent.delete(subject.slice("longPeriod:".length)) || changed;
      }
    }
    if (managed.size === 0) this.managedStandbySubjects.delete(domain);
    return { viewChanged: changed, durableChanged: changed };
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
    isCorrection = false,
  ): DisplayMutation {
    const key = `weather:${source}`;
    const revision = revisionOf(reportDateTime, serial, nowMs);
    // VPWS50 / VPWW56 は Phase 3B で共通 TelegramRevisionGate へ移行済み。
    // VPWW56 は官署別 stream のため、source 全体の revision で二重判定すると office union を壊す。
    if (
      source !== "vpws50"
      && source !== "vpww56"
      && !this.revisionGuard.accept(key, revision, nowMs, DAY_MS, isCorrection)
    ) return NO_MUTATION;
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
    const alerts = [...this.weatherAlerts.values()].flatMap((state) => state.alerts.map(copyWeatherAlert));
    return attachWeatherExpandedKinds(alerts);
  }

  /** v2 foundation の正規 VPWS50 snapshot から起動時 view を再構築する。通知は発火しない。 */
  restoreCanonicalVpws50Alerts(
    alerts: DisplayWeatherAlertV1[],
    reportDateTime: string | null,
    serial: string | null,
  ): void {
    this.weatherAlerts.delete("vpws50");
    if (alerts.length === 0 || reportDateTime == null) return;
    const reportTimeMs = Date.parse(reportDateTime);
    if (!Number.isFinite(reportTimeMs)) return;
    this.weatherAlerts.set("vpws50", {
      source: "vpws50",
      alerts: alerts.map(copyWeatherAlert),
      revision: { reportTimeMs, serial },
      expiresAtMs: reportTimeMs + DAY_MS,
    });
  }

  restoreCanonicalFloods(
    events: PersistedFloodState["events"],
    nowMs: number,
    legacyEventIds: readonly string[] = [],
  ): void {
    this.floods.restoreState({ events, seen: [] }, nowMs);
    this.legacyFloodEventIds.clear();
    this.managedStandbySubjects.clear();
    const active = new Set(this.floods.activeEventIds());
    for (const eventId of legacyEventIds) {
      if (active.has(eventId)) this.legacyFloodEventIds.add(eventId);
    }
  }

  retainCanonicalFloodEvents(eventIds: readonly string[]): DisplayMutation {
    this.reconcileLegacyFloodEvents();
    const mutation = this.floods.retainActiveEventIds([
      ...eventIds,
      ...this.legacyFloodEventIds,
    ]);
    this.notify(mutation);
    return mutation;
  }

  floodLegacyEventIds(): string[] {
    this.reconcileLegacyFloodEvents();
    return [...this.legacyFloodEventIds];
  }

  private reconcileLegacyFloodEvents(): void {
    const active = new Set(this.floods.activeEventIds());
    for (const eventId of this.legacyFloodEventIds) {
      if (!active.has(eventId)) this.legacyFloodEventIds.delete(eventId);
    }
  }

  /** v2 foundation の正規 VPWW56 union から起動時 view を再構築する。通知は発火しない。 */
  restoreCanonicalVpww56Alerts(
    alerts: DisplayWeatherAlertV1[],
    reportDateTime: string | null,
    serial: string | null,
  ): void {
    this.weatherAlerts.delete("vpww56");
    if (alerts.length === 0 || reportDateTime == null) return;
    const reportTimeMs = Date.parse(reportDateTime);
    if (!Number.isFinite(reportTimeMs)) return;
    this.weatherAlerts.set("vpww56", {
      source: "vpww56",
      alerts: alerts.map(copyWeatherAlert),
      revision: { reportTimeMs, serial },
      expiresAtMs: reportTimeMs + DAY_MS,
    });
  }

  private applyNankai(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedNankaiTroughInfo;
    const status = nankaiBadgeAction(raw.infoSerial?.code ?? null);
    if (status.action === "ignore") return NO_MUTATION;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept("nankai:current", revision, nowMs, 30 * DAY_MS, event.infoType === "訂正")) return NO_MUTATION;
    if (status.action === "deactivate" || event.isCancellation) {
      const changed = this.nankaiTrough != null;
      this.nankaiTrough = null;
      return { viewChanged: changed, durableChanged: true };
    }
    const code = raw.infoSerial?.code;
    if (code == null) return NO_MUTATION;
    this.nankaiTrough = { sourceEventId: event.eventId ?? event.id, statusCode: code, label: status.label, revision, appliedSemanticKey: event.standbyAppliedSemanticKey ?? undefined, expiresAtMs: revision.reportTimeMs + NANKAI_TTL_MS, restored: false };
    return { viewChanged: true, durableChanged: true };
  }

  private applyTornado(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedTornadoAdvisory;
    const publishingOffice = normalizeTornadoPublishingOffice(event.publishingOffice);
    const revision = revisionOf(event.reportDateTime, event.serial ?? raw.serial, nowMs);
    const stateKey = tornadoTickerGroupKey(publishingOffice);
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept(stateKey, revision, nowMs, DAY_MS, event.infoType === "訂正")) return NO_MUTATION;
    if (event.isCancellation || raw.activeAreaCount === 0) {
      return { viewChanged: this.tornadoByOffice.delete(publishingOffice), durableChanged: true };
    }
    const validMs = raw.validDateTime == null ? Number.NaN : Date.parse(raw.validDateTime);
    this.tornadoByOffice.set(publishingOffice, {
      publishingOffice,
      sourceEventId: event.id,
      areas: event.tornadoDisplay?.areaNames ?? event.areaItems.map((area) => area.name),
      isSighted: raw.hasSightingAreas,
      revision,
      appliedSemanticKey: event.standbyAppliedSemanticKey ?? undefined,
      expiresAtMs: Number.isNaN(validMs) ? revision.reportTimeMs + HOUR_MS : validMs,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  private applyLongPeriod(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.eventId == null || event.raw == null || Array.isArray(event.raw)) return NO_MUTATION;
    const raw = event.raw as ParsedLgObservationInfo;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    const key = `longPeriod:${event.eventId}`;
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept(key, revision, nowMs, DAY_MS, event.infoType === "訂正")) return NO_MUTATION;
    if (event.isCancellation) {
      const changed = this.longPeriodByEvent.delete(event.eventId);
      return { viewChanged: changed, durableChanged: true };
    }
    const maxLgIntValue = event.maxLgIntValue ?? raw.maxLgIntValue;
    if (maxLgIntValue?.presence === "missing") return { viewChanged: false, durableChanged: true };
    const maxLgIntScalar = event.maxLgInt ?? raw.maxLgInt;
    const maxLgInt = formatLgIntensitySpecialValue(maxLgIntValue, maxLgIntScalar);
    if (maxLgInt == null) return { viewChanged: false, durableChanged: true };
    const safetyRank = resolveLgIntensitySafetyRank(maxLgIntValue, maxLgIntScalar);
    const existing = this.longPeriodByEvent.get(event.eventId);
    const host = this.quakeHost?.eventId === event.eventId && this.quakeHost.expiresAtMs > nowMs
      ? this.quakeHost
      : null;
    this.longPeriodByEvent.set(event.eventId, {
      eventId: event.eventId,
      maxLgInt,
      safetyRank,
      revision,
      appliedSemanticKey: event.standbyAppliedSemanticKey ?? undefined,
      hosted: host != null,
      expiresAtMs: host?.expiresAtMs ?? (existing?.hosted === true ? existing.expiresAtMs : revision.reportTimeMs + 12 * HOUR_MS),
      restored: false,
    });
    return { viewChanged: host != null || existing?.hosted === true, durableChanged: true };
  }

  private applyEarthquakeHost(event: PresentationEvent, nowMs: number): DisplayMutation {
    if (event.eventId == null) return NO_MUTATION;
    if (event.isCancellation) {
      const hostMatched = this.quakeHost?.eventId === event.eventId;
      if (hostMatched) this.quakeHost = null;
      const rider = this.longPeriodByEvent.get(event.eventId);
      const riderWasHosted = rider?.hosted === true;
      if (riderWasHosted) this.longPeriodByEvent.delete(event.eventId);
      return hostMatched || riderWasHosted
        ? { viewChanged: riderWasHosted, durableChanged: true }
        : NO_MUTATION;
    }
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    const safetyRank = resolveQuakeIntensitySafetyRank(event);
    if (safetyRank == null) return NO_MUTATION;
    const candidate = { eventId: event.eventId, maxIntRank: safetyRank };
    if (!shouldReplaceQuakeHost(this.quakeHost, candidate, nowMs)) return NO_MUTATION;
    const expiresAtMs = nowMs + quakeCardTtlMs(safetyRank);
    this.quakeHost = { ...candidate, maxIntRank: safetyRank, revision, expiresAtMs };
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
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    const key = `typhoon:${update.typhoonKey}`;
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept(key, revision, nowMs, 7 * DAY_MS, update.isCorrection || update.isCancellation)) return NO_MUTATION;
    if (update.isCancellation) {
      return { viewChanged: this.typhoons.delete(update.typhoonKey), durableChanged: true };
    }
    const previousState = this.typhoons.get(update.typhoonKey);
    const pressureDeltaHpa = canonicalNumericDelta(
      update.pressureHpaValue,
      previousState?.pressureHpaValue,
    );
    const maxWindDeltaMs = canonicalNumericDelta(
      update.maxWindMsValue,
      previousState?.maxWindMsValue,
    );
    this.typhoons.set(update.typhoonKey, {
      sourceEventId: update.sourceEventId,
      pressureHpaValue: structuredClone(update.pressureHpaValue),
      maxWindMsValue: structuredClone(update.maxWindMsValue),
      maxGustMsValue: structuredClone(update.maxGustMsValue),
      moveSpeedKmhValue: structuredClone(update.moveSpeedKmhValue),
      typhoon: {
        ...update.typhoon,
        pressureDeltaHpa,
        maxWindDeltaMs,
        intensityTrend: typhoonIntensityTrend(pressureDeltaHpa, maxWindDeltaMs),
      },
      revision,
      appliedSemanticKey: event.standbyAppliedSemanticKey ?? undefined,
      expiresAtMs: revision.reportTimeMs + DAY_MS,
      restored: false,
    });
    return { viewChanged: true, durableChanged: true };
  }

  private applyVolcano(event: PresentationEvent, nowMs: number): DisplayMutation {
    for (const subject of event.volcanoAcceptedSubjects ?? []) {
      if (subject.startsWith("volcano:alert:")) {
        this.managedVolcanoAlerts.add(subject.slice("volcano:alert:".length));
      } else if (subject.startsWith("volcano:eruption:")) {
        this.managedVolcanoEruptions.add(subject.slice("volcano:eruption:".length));
      }
    }
    const updates = projectVolcanoUpdates(event);
    let mutation = NO_MUTATION;
    for (const update of updates) {
      const next = this.applyVolcanoUpdate(update, nowMs);
      mutation = {
        viewChanged: mutation.viewChanged || next.viewChanged,
        durableChanged: mutation.durableChanged || next.durableChanged,
      };
    }
    if (event.volcanoActiveAlertSubjects != null && event.volcanoActiveEruptionSubjects != null) {
      const retained = this.retainVolcanoSubjects(
        event.volcanoActiveAlertSubjects,
        event.volcanoActiveEruptionSubjects,
        nowMs,
      );
      mutation = {
        viewChanged: mutation.viewChanged || retained.viewChanged,
        durableChanged: mutation.durableChanged || retained.durableChanged,
      };
    }
    return mutation;
  }

  private retainVolcanoSubjects(
    alertSubjects: readonly string[],
    eruptionSubjects: readonly string[],
    nowMs: number,
  ): DisplayMutation {
    const alerts = new Set(alertSubjects.map((subject) => subject.replace(/^volcano:alert:/, "")));
    const eruptions = new Set(eruptionSubjects.map((subject) => subject.replace(/^volcano:eruption:/, "")));
    let changed = false;
    for (const code of this.managedVolcanoAlerts) {
      if (alerts.has(code)) continue;
      const state = this.volcanoes.get(code);
      if (state != null && (state.alertLevel != null || state.alertClass != null)) {
        state.alertLevel = null;
        state.alertClass = null;
        state.warningKind = null;
        state.targetKinds = [];
        state.alertExpiresAtMs = nowMs;
        state.alertRevision = null;
        changed = true;
      }
      this.managedVolcanoAlerts.delete(code);
    }
    for (const code of this.managedVolcanoEruptions) {
      if (eruptions.has(code)) continue;
      const state = this.volcanoes.get(code);
      if (state != null && state.latestEvent != null) {
        state.latestEvent = null;
        state.latestEventId = null;
        state.eventExpiresAtMs = null;
        state.eventRevision = null;
        changed = true;
      }
      this.managedVolcanoEruptions.delete(code);
    }
    for (const code of alerts) this.managedVolcanoAlerts.add(code);
    for (const code of eruptions) this.managedVolcanoEruptions.add(code);
    for (const [code, state] of this.volcanoes) {
      const hasActiveAlert = state.alertLevel != null || state.alertClass?.isActive === true;
      if (!hasActiveAlert && state.latestEvent == null) this.volcanoes.delete(code);
    }
    return changed ? { viewChanged: true, durableChanged: true } : NO_MUTATION;
  }

  private applyVolcanoUpdate(update: VolcanoUpdate, nowMs: number): DisplayMutation {
    let volcanoCode = update.volcano.code;
    if (update.kind === "eruption" && update.isCancellation && volcanoCode === "" && update.eventId != null) {
      const exactCandidates = [...this.volcanoes.values()]
        .filter((candidate) => candidate.latestEventId === update.eventId);
      if (exactCandidates.length === 1) {
        volcanoCode = exactCandidates[0].code;
      } else if (exactCandidates.length > 1) {
        log.warn(`[display] VFVO56 取消の EventID が複数火山に一致したため削除を保留しました (eventId=${update.eventId})`);
      } else {
        // latestEventId 導入前の保存状態は sourceEventIds が dmdata message ID のため
        // XML EventID を安全に補完できない。噴火イベントが一意な場合だけ移行 fallback を許す。
        const legacyCandidates = [...this.volcanoes.values()]
          .filter((candidate) => candidate.latestEventId == null && candidate.latestEvent != null);
        if (legacyCandidates.length === 1) {
          volcanoCode = legacyCandidates[0].code;
        } else if (legacyCandidates.length > 1) {
          log.warn(`[display] 旧形式の噴火 state が複数あるため空コード VFVO56 取消を適用しません (eventId=${update.eventId})`);
        }
      }
    }
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (volcanoCode === "") return { viewChanged: false, durableChanged: true };
    const previous = this.volcanoes.get(volcanoCode);
    const state: VolcanoState = previous ?? {
      code: volcanoCode,
      name: update.volcano.name,
      alertLevel: null,
      alertClass: null,
      warningKind: null,
      targetKinds: [],
      alertExpiresAtMs: null,
      latestEvent: null,
      latestEventId: null,
      eventExpiresAtMs: null,
      sourceEventIds: [],
      alertRevision: null,
      eventRevision: null,
      alertRestored: false,
      eventRestored: false,
    };
    if (update.volcano.name !== "") state.name = update.volcano.name;
    if (!state.sourceEventIds.includes(update.sourceEventId)) state.sourceEventIds.push(update.sourceEventId);
    if (update.kind === "alert") {
      state.alertRestored = false;
      state.alertRevision = revision;
      if (update.isCancellation) {
        state.alertLevel = null;
        state.alertClass = null;
        state.warningKind = null;
        state.targetKinds = [];
        state.alertExpiresAtMs = nowMs;
      } else {
        state.alertLevel = update.volcano.alertLevel;
        state.alertClass = update.volcano.alertClass == null ? null : { ...update.volcano.alertClass };
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
      state.latestEventId = update.isCancellation ? null : update.eventId;
      state.eventExpiresAtMs = update.isCancellation ? null : revision.reportTimeMs + DAY_MS;
    }
    const hasActiveAlert = state.alertLevel != null || state.alertClass?.isActive === true;
    if (!hasActiveAlert && (state.eventExpiresAtMs == null || state.eventExpiresAtMs <= nowMs)) {
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
        const alertWasVisible = state.alertLevel != null && state.alertLevel >= 4
          || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs;
        state.alertLevel = null;
        state.alertClass = null;
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
      if (entry.active === false) continue;
      const existing = this.volcanoes.get(entry.volcanoCode);
      const state: VolcanoState = existing ?? {
        code: entry.volcanoCode,
        name: entry.volcanoName,
        alertLevel: null,
        alertClass: null,
        warningKind: null,
        targetKinds: [],
        alertExpiresAtMs: null,
        latestEvent: null,
        latestEventId: null,
        eventExpiresAtMs: null,
        sourceEventIds: [],
        alertRevision: revision,
        eventRevision: null,
        alertRestored: false,
        eventRestored: false,
      };
      state.name = entry.volcanoName;
      state.alertLevel = entry.alertLevel;
      state.alertClass = entry.alertClass == null ? null : { ...entry.alertClass };
      state.warningKind = entry.warningKind ?? null;
      state.targetKinds = [...(entry.targetKinds ?? [])];
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

  /** v2 volcano foundation を正として legacy volcano 表示 state を全置換する。 */
  restoreCanonicalVolcanoes(
    states: readonly PersistedVolcanoStateV1[],
    gateEntries: PersistedTelegramFoundationV2["volcano"]["gateEntries"],
    nowMs: number,
  ): void {
    this.managedVolcanoAlerts.clear();
    this.managedVolcanoEruptions.clear();
    for (const entry of gateEntries) {
      const alertPrefix = "volcano:alert:";
      const eruptionPrefix = "volcano:eruption:";
      const code = entry.stateSubjectKey.startsWith(alertPrefix)
        ? entry.stateSubjectKey.slice(alertPrefix.length)
        : entry.stateSubjectKey.startsWith(eruptionPrefix)
          ? entry.stateSubjectKey.slice(eruptionPrefix.length)
          : "";
      if (!entry.cancelled && entry.revisionFamily === "volcanoAlert") {
        this.managedVolcanoAlerts.add(code);
      } else if (!entry.cancelled && entry.revisionFamily === "volcanoEruption") {
        this.managedVolcanoEruptions.add(code);
      }
      const existing = this.volcanoes.get(code);
      if (existing == null) continue;
      if (entry.revisionFamily === "volcanoAlert") {
        existing.alertLevel = null;
        existing.alertClass = null;
        existing.warningKind = null;
        existing.targetKinds = [];
        existing.alertExpiresAtMs = null;
        existing.alertRevision = null;
      } else if (entry.revisionFamily === "volcanoEruption") {
        existing.latestEvent = null;
        existing.latestEventId = null;
        existing.eventExpiresAtMs = null;
        existing.eventRevision = null;
      }
      if (existing.alertLevel == null && existing.alertClass == null && existing.latestEvent == null) {
        this.volcanoes.delete(code);
      }
    }
    for (const state of states) {
      if (!(state.alertExpiresAtMs == null || state.alertExpiresAtMs > nowMs
        || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs)) continue;
      const previous = this.volcanoes.get(state.code);
      const restored = {
        ...state,
        alertClass: state.alertClass == null ? null : { ...state.alertClass },
        warningKind: state.warningKind ?? null,
        targetKinds: [...(state.targetKinds ?? [])],
        latestEvent: restoreVolcanoEvent(state.latestEvent),
        latestEventId: state.latestEventId ?? null,
        sourceEventIds: [...state.sourceEventIds],
        alertRevision: state.alertRevision == null ? null : { ...state.alertRevision },
        eventRevision: state.eventRevision == null ? null : { ...state.eventRevision },
        alertRestored: state.alertRevision != null,
        eventRestored: state.eventRevision != null,
      };
      if (previous != null) {
        if (restored.alertLevel == null && restored.alertClass == null) {
          restored.alertLevel = previous.alertLevel;
          restored.alertClass = previous.alertClass;
          restored.warningKind = previous.warningKind;
          restored.targetKinds = previous.targetKinds;
          restored.alertExpiresAtMs = previous.alertExpiresAtMs;
          restored.alertRevision = previous.alertRevision;
        }
        if (restored.latestEvent == null) {
          restored.latestEvent = previous.latestEvent;
          restored.latestEventId = previous.latestEventId;
          restored.eventExpiresAtMs = previous.eventExpiresAtMs;
          restored.eventRevision = previous.eventRevision;
        }
      }
      this.volcanoes.set(state.code, restored);
    }
  }

  private applyHeat(event: PresentationEvent, nowMs: number): DisplayMutation {
    const update = projectHeatUpdate(event, nowMs);
    if (update == null) return NO_MUTATION;
    const areaName = update.areas[0]?.areaName;
    if (areaName == null) return NO_MUTATION;
    const key = `heat:${update.targetDate}:${areaName}`;
    const revision = revisionOf(update.reportDateTime, update.serial, nowMs);
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept(key, revision, nowMs, 3 * DAY_MS, update.isCorrection)) return NO_MUTATION;
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
      appliedSemanticKey: event.standbyAppliedSemanticKey ?? undefined,
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
        state.latestEventId = null;
        viewChanged = true;
        durableChanged = true;
      }
      const hasActiveAlert = state.alertLevel != null || state.alertClass?.isActive === true;
      if ((!hasActiveAlert || state.alertExpiresAtMs != null && state.alertExpiresAtMs <= nowMs)
        && state.eventExpiresAtMs == null) {
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
    if (this.pruneBriefingCardEntries(nowMs)) {
      viewChanged = true;
    }
    if (this.revisionGuard.sweep(nowMs)) durableChanged = true;
    const floodMutation = this.floods.sweep(nowMs);
    this.reconcileLegacyFloodEvents();
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
        restored: states.some((state) => state.restored),
        severity: typhoonStandbySeverity(states.map((state) => state.typhoon)),
        data: { typhoons: states.map((state) => ({
          ...state.typhoon,
          pressureHpaSemantic: projectTyphoonNumericSemantic(state.pressureHpaValue, "hPa"),
          maxWindMsSemantic: projectTyphoonNumericSemantic(state.maxWindMsValue, "m/s"),
          maxGustMsSemantic: projectTyphoonNumericSemantic(state.maxGustMsValue, "m/s"),
          moveSpeedKmhSemantic: projectTyphoonNumericSemantic(state.moveSpeedKmhValue, "km/h"),
        })) },
      });
    }
    const volcanoes = [...this.volcanoes.values()].filter((state) =>
      state.alertLevel != null && state.alertLevel >= 4
      || state.alertClass?.isActive === true && state.alertClass.severity === "warning"
      || state.eventExpiresAtMs != null
    );
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
          alertClass: state.alertClass == null ? null : { ...state.alertClass },
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
      severity: (state.safetyRank ?? 0) >= 4 ? "critical" : "warning",
      data: { eventId: state.eventId, maxLgInt: state.maxLgInt },
    });
    if (this.nankaiTrough != null) items.push({
      kind: "nankaiTrough", surface: "clock-below", key: "nankai:current", sourceEventIds: [this.nankaiTrough.sourceEventId],
      updatedAt: new Date(this.nankaiTrough.revision.reportTimeMs).toISOString(), expiresAt: new Date(this.nankaiTrough.expiresAtMs).toISOString(), restored: this.nankaiTrough.restored,
      severity: this.nankaiTrough.label.includes("警戒") ? "critical" : "warning", data: { statusCode: this.nankaiTrough.statusCode, label: this.nankaiTrough.label },
    });
    const briefing = this.snapshotBriefingCard();
    if (briefing != null) items.push(briefing);
    return sortStandbyItems(items);
  }

  snapshotBriefingCard(): Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null {
    if (this.briefingEntries.size === 0) return null;
    const states = [...this.briefingEntries.values()]
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs || compareBriefingKeys(left.entry.key, right.entry.key));
    const entries = states.map((state) => copyBriefingEntry(state.entry));
    const severity = entries.some((entry) => entry.frameLevel === "critical")
      ? "critical"
      : entries.some((entry) => entry.frameLevel === "warning" || entry.frameLevel === "cancel")
        ? "warning"
        : "info";
    return {
      kind: "briefing",
      surface: "corner-right",
      key: BRIEFING_CARD_KEY,
      sourceEventIds: entries.map((entry) => entry.sourceEventId),
      updatedAt: new Date(Math.max(...states.map((state) => state.updatedAtMs))).toISOString(),
      expiresAt: new Date(Math.max(...states.map((state) => state.expiresAtMs))).toISOString(),
      restored: false,
      severity,
      data: { generation: this.briefingGeneration, entries },
    };
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
        appliedSemanticKey: state.appliedSemanticKey,
      })),
      typhoons: [...this.typhoons].map(([key, state]) => ({
        key,
        sourceEventId: state.sourceEventId,
        typhoon: { ...state.typhoon },
        pressureHpaValue: structuredClone(state.pressureHpaValue),
        maxWindMsValue: structuredClone(state.maxWindMsValue),
        maxGustMsValue: structuredClone(state.maxGustMsValue),
        moveSpeedKmhValue: structuredClone(state.moveSpeedKmhValue),
        revision: { ...state.revision },
        expiresAtMs: state.expiresAtMs,
        ...(state.appliedSemanticKey == null
          ? {}
          : { appliedSemanticKey: state.appliedSemanticKey }),
      })),
      volcanoes: [...this.volcanoes.values()].map((state) => ({
        code: state.code,
        name: state.name,
        alertLevel: state.alertLevel,
        alertClass: state.alertClass == null ? null : { ...state.alertClass },
        warningKind: state.warningKind,
        targetKinds: [...state.targetKinds],
        alertExpiresAtMs: state.alertExpiresAtMs,
        latestEvent: copyVolcanoEvent(state.latestEvent),
        latestEventId: state.latestEventId,
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
      tornado: [...this.tornadoByOffice.values()].map((state) => ({ publishingOffice: state.publishingOffice, sourceEventId: state.sourceEventId, areas: [...state.areas], isSighted: state.isSighted, revision: { ...state.revision }, expiresAtMs: state.expiresAtMs, appliedSemanticKey: state.appliedSemanticKey })),
      longPeriod: [...this.longPeriodByEvent.values()].map((state) => ({ eventId: state.eventId, maxLgInt: state.maxLgInt, safetyRank: state.safetyRank, revision: { ...state.revision }, hosted: state.hosted, expiresAtMs: state.expiresAtMs, appliedSemanticKey: state.appliedSemanticKey })),
      quakeHost: this.quakeHost == null ? null : { ...this.quakeHost, revision: { ...this.quakeHost.revision } },
      nankaiTrough: this.nankaiTrough == null ? null : { sourceEventId: this.nankaiTrough.sourceEventId, statusCode: this.nankaiTrough.statusCode, label: this.nankaiTrough.label, revision: { ...this.nankaiTrough.revision }, expiresAtMs: this.nankaiTrough.expiresAtMs, appliedSemanticKey: this.nankaiTrough.appliedSemanticKey },
      seen: this.revisionGuard.export(),
    };
  }

  restoreActiveState(data: PersistedStandbyState, nowMs: number): void {
    this.heatAlerts.clear();
    this.typhoons.clear();
    this.volcanoes.clear();
    this.managedVolcanoAlerts.clear();
    this.managedVolcanoEruptions.clear();
    this.tornadoByOffice.clear();
    this.longPeriodByEvent.clear();
    this.quakeHost = null;
    this.nankaiTrough = null;
    this.weatherAlerts.clear();
    this.legacyFloodEventIds.clear();
    this.briefingEntries.clear();
    this.briefingGeneration = 0;
    for (const state of data.heat) {
      if (state.targetDateEndMs <= nowMs) continue;
      this.heatAlerts.set(state.key, {
        sourceEventIds: [...state.sourceEventIds],
        targetDate: state.targetDate,
        targetDateEndMs: state.targetDateEndMs,
        areas: state.areas.map((area) => ({ ...area })),
        isSpecial: state.isSpecial,
        revision: { ...state.revision },
        appliedSemanticKey: state.appliedSemanticKey,
        restored: true,
      });
    }
    for (const state of data.typhoons ?? []) {
      if (state.expiresAtMs > nowMs) {
        this.typhoons.set(state.typhoon.typhoonKey, {
          sourceEventId: state.sourceEventId,
          pressureHpaValue: structuredClone(state.pressureHpaValue
            ?? typhoonNumericValueFromLegacyScalar(state.typhoon.pressureHpa)),
          maxWindMsValue: structuredClone(state.maxWindMsValue
            ?? typhoonNumericValueFromLegacyScalar(state.typhoon.maxWindMs)),
          maxGustMsValue: structuredClone(state.maxGustMsValue
            ?? typhoonNumericValueFromLegacyScalar(state.typhoon.maxGustMs ?? null)),
          moveSpeedKmhValue: structuredClone(state.moveSpeedKmhValue
            ?? typhoonNumericValueFromLegacyScalar(state.typhoon.moveSpeedKmh)),
          typhoon: {
            ...state.typhoon,
            pressureDeltaHpa: state.typhoon.pressureDeltaHpa ?? null,
            maxGustMs: state.typhoon.maxGustMs ?? null,
            maxWindDeltaMs: state.typhoon.maxWindDeltaMs ?? null,
            intensityTrend: state.typhoon.intensityTrend ?? null,
          },
          revision: { ...state.revision },
          appliedSemanticKey: state.appliedSemanticKey,
          expiresAtMs: state.expiresAtMs,
          restored: true,
        });
      }
    }
    for (const state of data.volcanoes ?? []) {
      if (state.alertExpiresAtMs == null || state.alertExpiresAtMs > nowMs || state.eventExpiresAtMs != null && state.eventExpiresAtMs > nowMs) {
        this.volcanoes.set(state.code, {
          ...state,
          alertClass: state.alertClass == null ? null : { ...state.alertClass },
          warningKind: state.warningKind ?? null,
          targetKinds: [...(state.targetKinds ?? [])],
          latestEvent: restoreVolcanoEvent(state.latestEvent),
          latestEventId: state.latestEventId ?? null,
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
      safetyRank: persistedLongPeriodSafetyRank(state),
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
    const legacyFloods = data.floods ?? { events: [], seen: [] };
    const restorableLegacyFloodEvents = legacyFloods.events
      .filter((event) => event.expiresAtMs > nowMs)
      .sort((left, right) =>
        compareRevision(right.revision, left.revision)
        || right.expiresAtMs - left.expiresAtMs
        || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0))
      .slice(0, FLOOD_FORECAST_MAX_SUBJECTS);
    this.floods.restoreState({
      ...legacyFloods,
      events: restorableLegacyFloodEvents,
    }, nowMs);
    for (const eventId of this.floods.activeEventIds()) this.legacyFloodEventIds.add(eventId);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: string | null | undefined): string | null {
  return value != null && value.trim() !== "" ? value : null;
}

function parsedBriefing(event: PresentationEvent): ParsedWeatherBriefing | null {
  if (event.domain !== "briefing" || event.type !== "VPBS50" || !isRecord(event.raw)) return null;
  return Array.isArray(event.raw.briefingConditions) && Array.isArray(event.raw.targetAreas)
    ? event.raw as unknown as ParsedWeatherBriefing
    : null;
}

function parsedVpoa(event: PresentationEvent): ParsedLegacyCounterpartInfo | null {
  if (event.domain !== "legacyCounterpart" || event.type !== "VPOA50" || !isRecord(event.raw)) return null;
  return Array.isArray(event.raw.areas) && Array.isArray(event.raw.severityEvidence)
    ? event.raw as unknown as ParsedLegacyCounterpartInfo
    : null;
}

function rawMessageId(event: PresentationEvent): string | null {
  if (!isRecord(event.raw) || !isRecord(event.raw.meta)) return null;
  return typeof event.raw.meta.messageId === "string" ? nonBlank(event.raw.meta.messageId) : null;
}

function sourceEventId(event: PresentationEvent): string | null {
  const raw = isRecord(event.raw) && typeof event.raw.eventId === "string"
    ? nonBlank(event.raw.eventId)
    : null;
  return raw ?? rawMessageId(event);
}

/** Card identity deliberately preserves the raw EventID/messageId spelling. */
export function briefingCardIdentity(event: PresentationEvent): string | null {
  const source = parsedBriefing(event) != null
    ? "vpbs"
    : parsedVpoa(event) != null
      ? "vpoa"
      : event.domain === "briefing" && event.type === "VPBS50"
        ? "vpbs"
        : event.domain === "legacyCounterpart" && event.type === "VPOA50"
          ? "vpoa"
          : null;
  const rawIdentity = sourceEventId(event);
  if (source == null || rawIdentity == null) return null;
  return `card:${source}:${rawIdentity}`;
}

function reportTimeMs(reportDateTime: string, nowMs: number): number {
  const parsed = Date.parse(reportDateTime);
  return Number.isFinite(parsed) ? parsed : nowMs;
}

function briefingAreaItems(event: PresentationEvent): Array<{ name: string; code: string }> {
  return event.areaItems
    .map((area) => ({ name: area.name, code: nonBlank(area.code ?? area.areaCode) }))
    .filter((area): area is { name: string; code: string } => area.code != null);
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => nonBlank(value)).filter((value): value is string => value != null))];
}

function briefingEvidenceToWire(info: ParsedWeatherBriefing): DisplayBriefingSeverityEvidenceV1[] {
  return info.briefingSeverityEvidence.map((evidence) => ({
    source: evidence.source,
    condition: evidence.condition,
    tag: evidence.tag,
    displaySeverity: evidence.displaySeverity,
    soundLevel: evidence.soundLevel,
    severity: null,
    phenomenonCode: null,
    kindCode: null,
    levelCode: null,
    status: null,
  }));
}

function vpoaEvidenceToWire(info: ParsedLegacyCounterpartInfo): DisplayBriefingSeverityEvidenceV1[] {
  return info.severityEvidence.map((evidence) => ({
    source: evidence.source,
    condition: evidence.condition ?? null,
    tag: null,
    displaySeverity: evidence.severity === "high" ? "critical" : "warning",
    soundLevel: null,
    severity: evidence.severity,
    phenomenonCode: evidence.phenomenonCode,
    kindCode: evidence.kindCode,
    levelCode: evidence.levelCode,
    status: evidence.status ?? null,
  }));
}

function isConfirmedVpoaCardEvidence(
  evidence: ParsedLegacyCounterpartInfo["severityEvidence"][number],
): boolean {
  if (evidence.severity !== "high" || evidence.kindCode !== "1") return false;
  return evidence.source === "head"
    ? evidence.condition === "発表"
    : evidence.source === "body" && evidence.status === "発表";
}

function isHighVpoaCard(info: ParsedLegacyCounterpartInfo): boolean {
  if (info.infoType !== "発表" && info.infoType !== "訂正") return false;
  return info.severityEvidence.length === 2
    && new Set(info.severityEvidence.map((evidence) => evidence.source)).size === 2
    && info.severityEvidence.every(isConfirmedVpoaCardEvidence);
}

function briefingCardEntryCandidate(
  event: PresentationEvent,
  nowMs: number,
): BriefingCardEntryCandidate | null {
  const info = parsedBriefing(event);
  const vpoa = parsedVpoa(event);
  const source = info != null || event.domain === "briefing" && event.type === "VPBS50"
    ? "vpbs50"
    : vpoa != null || event.domain === "legacyCounterpart" && event.type === "VPOA50"
      ? "vpoa50"
      : null;
  const key = briefingCardIdentity(event);
  const rawIdentity = sourceEventId(event);
  if (source == null || key == null || rawIdentity == null) return null;

  const infoType = nonBlank(info?.infoType ?? vpoa?.infoType ?? event.infoType) ?? event.infoType;
  const reportDateTime = info?.reportDateTime ?? vpoa?.reportDateTime ?? event.reportDateTime;
  const updatedAtMs = reportTimeMs(reportDateTime, nowMs);
  const isVpbsCancellation = source === "vpbs50" && (infoType === "取消" || event.isCancellation);
  const ownTtlMs = isVpbsCancellation ? BRIEFING_CARD_CANCEL_TTL_MS : BRIEFING_CARD_TTL_MS;
  const ownExpiresAtMs = updatedAtMs + ownTtlMs;
  const expiresAtMs = ownExpiresAtMs;

  const targetAreas = info != null
    ? info.targetAreas.map((area) => ({ name: area.name, code: area.code }))
    : vpoa != null
      ? vpoa.areas.map((area) => ({ name: area.name, code: area.code }))
      : briefingAreaItems(event);
  const frameLevel = source === "vpbs50"
    ? normalizeBriefingFrameLevel(info == null ? event.frameLevel : briefingFrameLevel(info))
    : vpoa != null && isHighVpoaCard(vpoa) ? "critical" : "warning";
  const severityEvidence = info != null
    ? briefingEvidenceToWire(info)
    : vpoa != null
      ? vpoaEvidenceToWire(vpoa)
      : [];
  const conditions = info != null
    ? [...info.briefingConditions]
    : vpoa != null
      ? uniqueStrings(vpoa.severityEvidence.map((item) => item.condition))
      : [];

  const entry: DisplayBriefingEntryV1 = {
    key,
    source,
    sourceEventId: rawIdentity,
    title: info?.title ?? vpoa?.title ?? event.title,
    headline: info?.headline ?? vpoa?.headline ?? event.headline,
    conditions,
    targetAreas,
    reportDateTime,
    publishingOffice: info?.publishingOffice ?? vpoa?.publishingOffice ?? event.publishingOffice,
    infoType,
    frameLevel,
    severityEvidence,
    qualifier: source === "vpoa50" ? "対応電文未確認" : null,
    updatedAt: new Date(updatedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    generation: 0,
  };
  return { entry, updatedAtMs, expiresAtMs };
}

function normalizeBriefingFrameLevel(
  level: PresentationEvent["frameLevel"],
): DisplayBriefingEntryV1["frameLevel"] {
  if (level === "critical" || level === "warning" || level === "info" || level === "cancel") return level;
  return "info";
}

function sameBriefingCardEntry(left: DisplayBriefingEntryV1, right: DisplayBriefingEntryV1): boolean {
  const { generation: _leftGeneration, ...leftRest } = left;
  const { generation: _rightGeneration, ...rightRest } = right;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

function compareBriefingKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function briefingCardMutationToDisplayMutation(result: BriefingCardMutationResult): DisplayMutation {
  if (!result.applied) return NO_MUTATION;
  return {
    viewChanged: true,
    durableChanged: false,
    ...(result.evictedKey == null ? {} : { cardEvictedKey: result.evictedKey }),
  };
}

function copyBriefingEntry(entry: DisplayBriefingEntryV1): DisplayBriefingEntryV1 {
  return {
    ...entry,
    conditions: [...entry.conditions],
    targetAreas: entry.targetAreas.map((area) => ({ ...area })),
    severityEvidence: entry.severityEvidence.map((evidence) => ({ ...evidence })),
  };
}

function copyWeatherAlert(alert: DisplayWeatherAlertV1): DisplayWeatherAlertV1 {
  return {
    ...alert,
    items: alert.items.map((item) => ({
      ...item,
      shownAreas: [...item.shownAreas],
      ...(item.shownAreaCodes == null ? {} : { shownAreaCodes: [...item.shownAreaCodes] }),
    })),
  };
}

function copyVolcanoEvent(
  event: DisplayVolcanoEventV1 | null | undefined,
): DisplayVolcanoEventV1 | null {
  return event == null ? null : {
    ...event,
    ...(event.plumeHeightAboveCraterSemantic == null
      ? {}
      : {
          plumeHeightAboveCraterSemantic:
            copyDisplayPlumeHeightSemantic(event.plumeHeightAboveCraterSemantic),
        }),
    ...(event.plumeHeightAboveSeaLevelSemantic == null
      ? {}
      : {
          plumeHeightAboveSeaLevelSemantic:
            copyDisplayPlumeHeightSemantic(event.plumeHeightAboveSeaLevelSemantic),
        }),
  };
}

function restoreVolcanoEvent(
  event: PersistedVolcanoStateV1["latestEvent"],
): DisplayVolcanoEventV1 | null {
  if (event == null) return null;
  const legacyEvent: DisplayVolcanoEventV1 = typeof event === "string" ? {
    label: event,
    craterName: null,
    eventDateTime: null,
    plumeHeightM: null,
    plumeHeightUnknown: false,
    plumeDirection: null,
  } : event;
  const migrated = legacyDisplayPlumeHeightSemantics(
    legacyEvent.plumeHeightM,
    legacyEvent.plumeHeightUnknown,
  );
  return {
    ...legacyEvent,
    plumeHeightAboveCraterSemantic: copyDisplayPlumeHeightSemantic(
      legacyEvent.plumeHeightAboveCraterSemantic
        ?? migrated.plumeHeightAboveCraterSemantic,
    ),
    plumeHeightAboveSeaLevelSemantic: copyDisplayPlumeHeightSemantic(
      legacyEvent.plumeHeightAboveSeaLevelSemantic
        ?? migrated.plumeHeightAboveSeaLevelSemantic,
    ),
  };
}

function canonicalNumericDelta(
  current: SpecialValue<number>,
  previous: SpecialValue<number> | undefined,
): number | null {
  return current.presence !== "value"
    || current.value == null
    || previous?.presence !== "value"
    || previous.value == null
    ? null
    : current.value - previous.value;
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
