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
  DisplayBriefingFactV1,
  DisplayBriefingKindV1,
  DisplayBriefingSeverityEvidenceV1,
  DisplayBriefingSummaryItemV1,
  DisplayBriefingSummaryV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoAlertClassV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type {
  PersistedTelegramFoundationV2,
  PersistedBriefingCriticalStateV1,
  PersistedBriefingCriticalRawAliasV1,
  PersistedStandbyState,
  PersistedStandbyStateV1,
  PersistedVolcanoStateV1,
  PersistedWeatherAlertStateV1,
} from "./standby-persistence";
import { persistedLongPeriodSafetyRank, validateBriefingCriticalForWrite } from "./standby-persistence";
import { FloodActiveReducer, type PersistedFloodState } from "./flood-active-reducer";
import { projectFloodUpdate } from "./project-flood";
import { resolveQuakeIntensitySafetyRank } from "./project-event";
import { projectHeatUpdate, projectTyphoonUpdate, projectVolcanoUpdates, type VolcanoUpdate } from "./project-standby";
import {
  BRIEFING_CARD_CANCEL_TTL_MS,
  BRIEFING_CARD_KEY,
  BRIEFING_CARD_MAX_ENTRIES,
  BRIEFING_CARD_TTL_MS,
  BRIEFING_CRITICAL_WATERMARK_MAX_SUBJECTS,
  BRIEFING_RAW_ALIAS_MAX_LINEAGES,
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
import { DISPLAY_SEVERITY_RANK } from "../../dmdata/weather-warning-level";

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
  restored: boolean;
}

interface BriefingRevisionWatermark {
  revision: StandbyRevision;
  expiresAtMs: number;
}

export type BriefingCriticalIdentity =
  | { kind: "semantic"; semanticKey: string }
  | { kind: "raw"; source: "vpbs50" | "vpoa50"; sourceEventId: string };

interface RawBriefingCriticalProvenance {
  identity: Extract<BriefingCriticalIdentity, { kind: "raw" }>;
  phase: "active" | "downgraded" | "cancelled";
  lastStrictRevision: StandbyRevision | null;
  lastAcceptedFrameLevel: "critical" | "warning" | "info" | "cancel";
  lastPayloadFingerprint: string;
  lastCriticalExpiresAtMs: number;
  expiresAtMs: number;
}

interface RawBriefingAliasTombstone {
  identity: Extract<BriefingCriticalIdentity, { kind: "raw" }>;
  semanticKey: string;
  revision: StandbyRevision;
  expiresAtMs: number;
}

interface BriefingCardEntryCandidate extends BriefingCardEntryState {
  phenomenonKinds: DisplayBriefingKindV1[];
  hasRawEventId: boolean;
  isCancellation: boolean;
  rawIdentity: Extract<BriefingCriticalIdentity, { kind: "raw" }>;
  rawToken: string;
  semanticKeyCandidate: string | null;
  revision: StandbyRevision | null;
  fingerprint: string;
}

export type BriefingCardMutationResult =
  | {
      kind: "applied";
      status: "applied";
      applied: true;
      generation: number;
      evictedKey: string | null;
      action: "upsert" | "expiredCancellationRemoved" | "pruned";
      durableChanged?: boolean;
      viewChanged?: boolean;
    }
  | {
      kind: "ignored";
      status: "ignored";
      applied: false;
      generation: number;
      evictedKey: null;
      reason: "notBriefing" | "expired" | "unchanged" | "older" | "cancelTargetAmbiguous" | "cancelTargetMissing";
      durableChanged?: boolean;
      viewChanged?: boolean;
    };

interface BriefingCandidateOutcome {
  changed: boolean;
  viewChanged: boolean;
  evictedKey: string | null;
  action?: "upsert" | "expiredCancellationRemoved" | "pruned";
  reason?: "expired" | "unchanged" | "older" | "cancelTargetAmbiguous" | "cancelTargetMissing" | "notBriefing";
}

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
      reason: "sourceNotFound" | "sourceNotVpoa50" | "sourceAlreadyReconciled"
        | "canonicalNotBriefing" | "expired" | "canonicalNotNewer";
    };

export interface RestoreActiveStateResult {
  briefingCriticalRewriteRequired: boolean;
}

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
  /** VPBS50／VPOA50 browser card state.  Only critical lifecycle is durable. */
  private readonly briefingEntries = new Map<string, BriefingCardEntryState>();
  /**
   * Semantic revision memory survives a cancel frame's shorter TTL so a late,
   * older VPBS50 report cannot resurrect the cancelled subject.
   */
  private readonly briefingRevisionWatermarks = new Map<string, BriefingRevisionWatermark>();
  private readonly rawCriticalProvenance = new Map<string, RawBriefingCriticalProvenance>();
  private readonly rawBriefingAliases = new Map<string, RawBriefingAliasTombstone>();
  private briefingGeneration = 0;
  private briefingDurableGeneration = 0;
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
    const durableBefore = this.briefingDurableFingerprint();
    const pruned = this.pruneBriefingLifecycle(nowMs);
    const generation = this.briefingGeneration + 1;
    const outcome = this.applyBriefingLifecycleCandidate(candidate, nowMs, generation);
    const changed = pruned.changed || outcome.changed;
    if (changed) this.briefingGeneration = generation;
    const durableChanged = durableBefore !== this.briefingDurableFingerprint();
    if (durableChanged) this.briefingDurableGeneration = this.briefingGeneration;
    const viewChanged = pruned.viewChanged || outcome.viewChanged;
    if (!changed) {
      return {
        kind: "ignored", status: "ignored", applied: false,
        generation: this.briefingGeneration, evictedKey: null,
        reason: outcome.reason ?? "unchanged", durableChanged: false, viewChanged: false,
      };
    }
    return {
      kind: "applied", status: "applied", applied: true,
      generation: this.briefingGeneration, evictedKey: outcome.evictedKey,
      action: outcome.action ?? (pruned.changed ? "pruned" : "upsert"), durableChanged, viewChanged,
    };
  }

  private ignoredBriefingOutcome(
    reason: BriefingCandidateOutcome["reason"],
  ): BriefingCandidateOutcome {
    return { changed: false, viewChanged: false, evictedKey: null, reason };
  }

  private applyBriefingLifecycleCandidate(
    candidate: BriefingCardEntryCandidate,
    nowMs: number,
    generation: number,
  ): BriefingCandidateOutcome {
    if (candidate.entry.frameLevel !== "cancel" && candidate.expiresAtMs <= nowMs) {
      return this.ignoredBriefingOutcome("expired");
    }
    if (!briefingCandidateWithinLimits(candidate.entry)) {
      log.warn("[briefing-card] nested payload capacity rejected");
      return this.ignoredBriefingOutcome("unchanged");
    }
    if (candidate.isCancellation) {
      return this.applyBriefingCancellation(candidate, nowMs, generation);
    }

    const rawEntry = this.briefingEntries.get(rawBriefingDisplayKey(candidate.rawIdentity)) ?? null;
    const provenance = this.rawCriticalProvenance.get(candidate.rawToken) ?? null;
    const alias = this.rawBriefingAliases.get(candidate.rawToken) ?? null;
    if (provenance != null || alias != null || rawEntry?.entry.frameLevel === "critical") {
      return this.applyRawBriefingLifecycle(candidate, nowMs, generation, provenance, alias);
    }
    if (candidate.semanticKeyCandidate != null) {
      return this.applySemanticBriefingLifecycle(
        candidate,
        candidate.semanticKeyCandidate,
        nowMs,
        generation,
      );
    }
    return this.applyRawBriefingLifecycle(candidate, nowMs, generation, null, null);
  }

  private applySemanticBriefingLifecycle(
    candidate: BriefingCardEntryCandidate,
    semanticKey: string,
    nowMs: number,
    generation: number,
  ): BriefingCandidateOutcome {
    const watermark = this.briefingRevisionWatermarks.get(semanticKey) ?? null;
    const existing = this.briefingEntries.get(semanticKey) ?? null;
    const frame = candidate.entry.frameLevel;
    if (watermark == null) {
      if (frame !== "critical") {
        return this.applyTransientBriefingEntry(candidate, semanticKey, generation, true);
      }
      if (candidate.revision == null) return this.ignoredBriefingOutcome("older");
      if (this.briefingRevisionWatermarks.size >= BRIEFING_CRITICAL_WATERMARK_MAX_SUBJECTS) {
        log.warn("[briefing-card] briefingCriticalProtectionCapacityRejected semantic");
        return this.ignoredBriefingOutcome("unchanged");
      }
    } else {
      if (candidate.revision == null) return this.ignoredBriefingOutcome("older");
      const comparison = compareRevision(candidate.revision, watermark.revision);
      if (comparison < 0) return this.ignoredBriefingOutcome("older");
      if (comparison === 0) {
        if (existing != null && existing.entry.frameLevel === frame
          && briefingPayloadFingerprint(existing.entry) === candidate.fingerprint) {
          return this.ignoredBriefingOutcome("unchanged");
        }
        log.warn(`[briefing-card] same revision payload conflict key=${semanticKey}`);
        return this.ignoredBriefingOutcome("older");
      }
    }

    const revision = candidate.revision;
    if (revision == null) return this.ignoredBriefingOutcome("older");
    const rawKey = rawBriefingDisplayKey(candidate.rawIdentity);
    const transientRaw = this.briefingEntries.get(rawKey);
    const removedTransientRaw = transientRaw != null
      && transientRaw.entry.frameLevel !== "critical"
      && !this.rawCriticalProvenance.has(candidate.rawToken);
    if (removedTransientRaw) this.briefingEntries.delete(rawKey);
    this.briefingRevisionWatermarks.set(semanticKey, {
      revision: { ...revision },
      expiresAtMs: nowMs + BRIEFING_CARD_TTL_MS,
    });
    this.briefingEntries.delete(semanticKey);
    const entry = this.semanticBriefingEntry(candidate, semanticKey, generation, existing?.entry ?? null);
    const evictedKey = this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
    return {
      changed: true,
      viewChanged: true,
      evictedKey,
      action: "upsert",
    };
  }

  private applyRawBriefingLifecycle(
    candidate: BriefingCardEntryCandidate,
    nowMs: number,
    generation: number,
    provenance: RawBriefingCriticalProvenance | null,
    alias: RawBriefingAliasTombstone | null,
  ): BriefingCandidateOutcome {
    const frame = candidate.entry.frameLevel;
    const rawKey = rawBriefingDisplayKey(candidate.rawIdentity);

    if (provenance == null && alias == null) {
      if (frame !== "critical") {
        return this.applyTransientBriefingEntry(candidate, rawKey, generation, false);
      }
      if (!this.canReserveRawProtection(candidate.rawToken)) {
        log.warn("[briefing-card] briefingCriticalProtectionCapacityRejected raw");
        return this.ignoredBriefingOutcome("unchanged");
      }
      const entry = this.liveBriefingEntry(candidate, generation, null);
      const evictedKey = this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
      this.rawCriticalProvenance.set(candidate.rawToken, {
        identity: { ...candidate.rawIdentity },
        phase: "active",
        lastStrictRevision: candidate.revision == null ? null : { ...candidate.revision },
        lastAcceptedFrameLevel: "critical",
        lastPayloadFingerprint: candidate.fingerprint,
        lastCriticalExpiresAtMs: candidate.expiresAtMs,
        expiresAtMs: Math.max(candidate.expiresAtMs, nowMs + BRIEFING_CARD_TTL_MS),
      });
      return { changed: true, viewChanged: true, evictedKey, action: "upsert" };
    }

    let promotionEligible = false;
    if (alias != null) {
      if (candidate.revision == null || compareRevision(candidate.revision, alias.revision) <= 0) {
        return this.ignoredBriefingOutcome("older");
      }
      promotionEligible = candidate.semanticKeyCandidate != null;
    } else if (provenance != null) {
      const floor = provenance.lastStrictRevision;
      if (floor == null) {
        if (candidate.revision == null) {
          return frame === "critical" && candidate.fingerprint === provenance.lastPayloadFingerprint
            ? this.ignoredBriefingOutcome("unchanged")
            : this.ignoredBriefingOutcome("older");
        }
        if (frame !== "critical" || candidate.fingerprint !== provenance.lastPayloadFingerprint) {
          return this.ignoredBriefingOutcome("older");
        }
        promotionEligible = candidate.semanticKeyCandidate != null;
      } else {
        if (candidate.revision == null) return this.ignoredBriefingOutcome("older");
        const comparison = compareRevision(candidate.revision, floor);
        if (comparison < 0) return this.ignoredBriefingOutcome("older");
        if (comparison === 0) {
          if (candidate.semanticKeyCandidate != null
            && provenance.phase === "active"
            && frame === "critical"
            && candidate.fingerprint === provenance.lastPayloadFingerprint) {
            promotionEligible = true;
          } else if (frame === provenance.lastAcceptedFrameLevel
            && candidate.fingerprint === provenance.lastPayloadFingerprint) {
            return this.ignoredBriefingOutcome("unchanged");
          } else {
            return this.ignoredBriefingOutcome("older");
          }
        } else {
          promotionEligible = candidate.semanticKeyCandidate != null;
        }
      }
    }

    if (promotionEligible) {
      return this.promoteRawBriefingLifecycle(candidate, nowMs, generation, provenance, alias);
    }
    if (candidate.semanticKeyCandidate != null) return this.ignoredBriefingOutcome("older");

    if (alias != null) this.rawBriefingAliases.delete(candidate.rawToken);
    const previousEntry = this.briefingEntries.get(rawKey) ?? null;
    const previousCriticalExpiry = provenance?.lastCriticalExpiresAtMs ?? 0;
    const protectionExpiry = Math.max(
      provenance?.expiresAtMs ?? alias?.expiresAtMs ?? 0,
      candidate.expiresAtMs,
      nowMs + BRIEFING_CARD_TTL_MS,
    );
    const phase = frame === "critical" ? "active" : "downgraded";
    this.rawCriticalProvenance.set(candidate.rawToken, {
      identity: { ...candidate.rawIdentity },
      phase,
      lastStrictRevision: candidate.revision == null ? null : { ...candidate.revision },
      lastAcceptedFrameLevel: frame,
      lastPayloadFingerprint: candidate.fingerprint,
      lastCriticalExpiresAtMs: frame === "critical" ? candidate.expiresAtMs : previousCriticalExpiry,
      expiresAtMs: protectionExpiry,
    });
    this.briefingEntries.delete(rawKey);
    const entry = this.liveBriefingEntry(candidate, generation, null);
    const evictedKey = this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
    return {
      changed: true,
      viewChanged: previousEntry == null || !sameBriefingCardEntry(previousEntry.entry, entry),
      evictedKey,
      action: "upsert",
    };
  }

  private promoteRawBriefingLifecycle(
    candidate: BriefingCardEntryCandidate,
    nowMs: number,
    generation: number,
    provenance: RawBriefingCriticalProvenance | null,
    alias: RawBriefingAliasTombstone | null,
  ): BriefingCandidateOutcome {
    const semanticKey = candidate.semanticKeyCandidate;
    const revision = candidate.revision;
    if (semanticKey == null || revision == null) return this.ignoredBriefingOutcome("older");
    const watermark = this.briefingRevisionWatermarks.get(semanticKey) ?? null;
    if (watermark != null && compareRevision(revision, watermark.revision) <= 0) {
      return this.ignoredBriefingOutcome("older");
    }
    if (watermark == null
      && this.briefingRevisionWatermarks.size >= BRIEFING_CRITICAL_WATERMARK_MAX_SUBJECTS) {
      log.warn("[briefing-card] briefingCriticalProtectionCapacityRejected promotion");
      return this.ignoredBriefingOutcome("unchanged");
    }

    const sourceKey = rawBriefingDisplayKey(candidate.rawIdentity);
    const sourceEntry = this.briefingEntries.get(sourceKey) ?? null;
    const canonicalEntry = this.briefingEntries.get(semanticKey) ?? null;
    const watermarkExpiry = nowMs + BRIEFING_CARD_TTL_MS;
    const aliasExpiry = Math.max(
      alias?.expiresAtMs ?? 0,
      provenance?.expiresAtMs ?? 0,
      watermarkExpiry,
    );
    this.briefingEntries.delete(sourceKey);
    this.rawCriticalProvenance.delete(candidate.rawToken);
    this.briefingRevisionWatermarks.set(semanticKey, {
      revision: { ...revision }, expiresAtMs: watermarkExpiry,
    });
    this.rawBriefingAliases.set(candidate.rawToken, {
      identity: { ...candidate.rawIdentity },
      semanticKey,
      revision: { ...revision },
      expiresAtMs: aliasExpiry,
    });
    this.briefingEntries.delete(semanticKey);
    const entry = this.semanticBriefingEntry(candidate, semanticKey, generation, canonicalEntry?.entry ?? null);
    const evictedKey = this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
    return {
      changed: true,
      viewChanged: sourceEntry != null || canonicalEntry == null || !sameBriefingCardEntry(canonicalEntry.entry, entry),
      evictedKey,
      action: "upsert",
    };
  }

  private applyTransientBriefingEntry(
    candidate: BriefingCardEntryCandidate,
    key: string,
    generation: number,
    semantic: boolean,
  ): BriefingCandidateOutcome {
    const previous = this.briefingEntries.get(key) ?? null;
    const entry = semantic
      ? this.semanticBriefingEntry(candidate, key, generation, previous?.entry ?? null)
      : this.liveBriefingEntry(candidate, generation, null);
    if (previous != null) {
      const comparison = compareBriefingEntryRevision(previous.entry, entry);
      if (comparison != null && comparison < 0) return this.ignoredBriefingOutcome("older");
      if (comparison === 0) {
        return briefingPayloadFingerprint(previous.entry) === briefingPayloadFingerprint(entry)
          && previous.entry.frameLevel === entry.frameLevel
          ? this.ignoredBriefingOutcome("unchanged")
          : this.ignoredBriefingOutcome("older");
      }
      if (comparison == null && sameBriefingCardEntry(previous.entry, entry)) {
        return this.ignoredBriefingOutcome("unchanged");
      }
    }
    const evictedKey = this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
    return { changed: true, viewChanged: true, evictedKey, action: "upsert" };
  }

  private semanticCancellationTargets(
    candidate: BriefingCardEntryCandidate,
  ): { keys: string[]; ambiguous: boolean } {
    const exact = [...this.briefingEntries.values()]
      .filter((state) => state.entry.source === "vpbs50"
        && state.entry.sourceEventId === candidate.entry.sourceEventId
        && isSemanticBriefingSubject(state.entry))
      .flatMap((state) => typeof state.entry.semanticKey === "string" ? [state.entry.semanticKey] : []);
    const exactKeys = [...new Set(exact)];
    if (exactKeys.length > 0) return { keys: exactKeys, ambiguous: false };

    if (candidate.semanticKeyCandidate != null
      && (this.briefingRevisionWatermarks.has(candidate.semanticKeyCandidate)
        || this.briefingEntries.has(candidate.semanticKeyCandidate))) {
      return { keys: [candidate.semanticKeyCandidate], ambiguous: false };
    }
    const editorialOffice = nonBlank(candidate.entry.editorialOffice);
    if (candidate.hasRawEventId || candidate.phenomenonKinds.length === 0
      || editorialOffice == null) {
      return { keys: [], ambiguous: false };
    }
    const possible = candidate.phenomenonKinds
      .map((kind) => briefingSemanticKey(editorialOffice, kind))
      .filter((key) => this.briefingRevisionWatermarks.has(key) || this.briefingEntries.has(key));
    const keys = [...new Set(possible)];
    return { keys: keys.length === 1 ? keys : [], ambiguous: keys.length > 1 };
  }

  private applyBriefingCancellation(
    candidate: BriefingCardEntryCandidate,
    nowMs: number,
    generation: number,
  ): BriefingCandidateOutcome {
    const rawKey = rawBriefingDisplayKey(candidate.rawIdentity);
    const rawEntry = this.briefingEntries.get(rawKey) ?? null;
    const provenance = this.rawCriticalProvenance.get(candidate.rawToken) ?? null;
    const alias = this.rawBriefingAliases.get(candidate.rawToken) ?? null;
    const semanticTargets = this.semanticCancellationTargets(candidate);
    if (semanticTargets.ambiguous) {
      log.warn("[briefing-card] cancellation semantic target is ambiguous");
      return this.ignoredBriefingOutcome("cancelTargetAmbiguous");
    }

    const semanticPlans = semanticTargets.keys.map((semanticKey) => ({
      semanticKey,
      watermark: this.briefingRevisionWatermarks.get(semanticKey) ?? null,
      existing: this.briefingEntries.get(semanticKey) ?? null,
    }));
    const lifecycleTarget = provenance != null || alias != null
      || rawEntry?.entry.frameLevel === "critical"
      || semanticPlans.some((plan) => plan.watermark != null);
    const transientRawTarget = rawEntry != null && rawEntry.entry.frameLevel !== "critical";
    const transientSemanticTargets = semanticPlans.filter((plan) => plan.watermark == null && plan.existing != null);
    if (!lifecycleTarget && !transientRawTarget && transientSemanticTargets.length === 0) {
      if (candidate.hasRawEventId) log.warn("[briefing-card] cancellation sourceEventId target is missing");
      return this.ignoredBriefingOutcome(
        candidate.hasRawEventId ? "cancelTargetMissing" : "cancelTargetAmbiguous",
      );
    }
    if (candidate.revision == null && lifecycleTarget) {
      log.warn("[briefing-card] unordered critical lifecycle cancellation rejected");
      return this.ignoredBriefingOutcome("older");
    }

    let rawLifecycleIdempotent = false;
    if (alias != null) {
      if (candidate.revision == null || compareRevision(candidate.revision, alias.revision) <= 0) {
        return this.ignoredBriefingOutcome("older");
      }
    } else if (provenance != null) {
      if (candidate.revision == null || provenance.lastStrictRevision == null) {
        return this.ignoredBriefingOutcome("older");
      }
      const comparison = compareRevision(candidate.revision, provenance.lastStrictRevision);
      if (comparison < 0) return this.ignoredBriefingOutcome("older");
      if (comparison === 0) {
        if (provenance.phase === "cancelled"
          && provenance.lastAcceptedFrameLevel === "cancel"
          && provenance.lastPayloadFingerprint === candidate.fingerprint) {
          rawLifecycleIdempotent = true;
        } else {
          return this.ignoredBriefingOutcome("older");
        }
      }
    } else if (rawEntry?.entry.frameLevel === "critical") {
      return this.ignoredBriefingOutcome("older");
    }

    const semanticUpdates: typeof semanticPlans = [];
    for (const plan of semanticPlans) {
      if (plan.watermark == null) continue;
      if (candidate.revision == null) return this.ignoredBriefingOutcome("older");
      const comparison = compareRevision(candidate.revision, plan.watermark.revision);
      if (comparison < 0) return this.ignoredBriefingOutcome("older");
      if (comparison === 0) {
        if (plan.existing?.entry.frameLevel === "cancel"
          && briefingPayloadFingerprint(plan.existing.entry) === candidate.fingerprint) continue;
        return this.ignoredBriefingOutcome("older");
      }
      semanticUpdates.push(plan);
    }

    const transientPlans = [
      ...(transientRawTarget ? [{ key: rawKey, existing: rawEntry!, semanticKey: null as string | null }] : []),
      ...transientSemanticTargets.map((plan) => ({
        key: plan.semanticKey, existing: plan.existing!, semanticKey: plan.semanticKey as string | null,
      })),
    ];
    for (const plan of transientPlans) {
      const comparison = compareBriefingEntryRevision(plan.existing.entry, candidate.entry);
      if (comparison != null && comparison < 0) return this.ignoredBriefingOutcome("older");
      if (plan.existing.entry.frameLevel === "cancel") {
        if (briefingPayloadFingerprint(plan.existing.entry) === candidate.fingerprint) continue;
        return this.ignoredBriefingOutcome("older");
      }
    }

    const rawLifecycleUpdate = (alias != null || provenance != null) && !rawLifecycleIdempotent;
    const transientUpdates = transientPlans.filter((plan) =>
      plan.existing.entry.frameLevel !== "cancel");
    if (!rawLifecycleUpdate && semanticUpdates.length === 0 && transientUpdates.length === 0) {
      return this.ignoredBriefingOutcome("unchanged");
    }

    let viewChanged = false;
    let evictedKey: string | null = null;
    for (const plan of semanticUpdates) {
      this.briefingRevisionWatermarks.set(plan.semanticKey, {
        revision: { ...candidate.revision! },
        expiresAtMs: nowMs + BRIEFING_CARD_TTL_MS,
      });
      viewChanged = this.briefingEntries.delete(plan.semanticKey) || viewChanged;
      if (candidate.expiresAtMs > nowMs) {
        const entry = this.semanticBriefingEntry(
          candidate,
          plan.semanticKey,
          generation,
          plan.existing?.entry ?? null,
        );
        evictedKey ??= this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
        viewChanged = true;
      }
    }

    if (rawLifecycleUpdate) {
      if (alias != null) this.rawBriefingAliases.delete(candidate.rawToken);
      viewChanged = this.briefingEntries.delete(rawKey) || viewChanged;
      const protectionExpiry = Math.max(
        provenance?.expiresAtMs ?? alias?.expiresAtMs ?? 0,
        candidate.expiresAtMs,
        nowMs + BRIEFING_CARD_TTL_MS,
      );
      this.rawCriticalProvenance.set(candidate.rawToken, {
        identity: { ...candidate.rawIdentity },
        phase: "cancelled",
        lastStrictRevision: { ...candidate.revision! },
        lastAcceptedFrameLevel: "cancel",
        lastPayloadFingerprint: candidate.fingerprint,
        lastCriticalExpiresAtMs: provenance?.lastCriticalExpiresAtMs ?? 0,
        expiresAtMs: protectionExpiry,
      });
      if (candidate.expiresAtMs > nowMs) {
        const entry = this.liveBriefingEntry(candidate, generation, null);
        evictedKey ??= this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
        viewChanged = true;
      }
    }

    for (const plan of transientUpdates) {
      viewChanged = this.briefingEntries.delete(plan.key) || viewChanged;
      if (candidate.expiresAtMs > nowMs) {
        const entry = plan.semanticKey == null
          ? this.liveBriefingEntry(candidate, generation, null)
          : this.semanticBriefingEntry(candidate, plan.semanticKey, generation, plan.existing.entry);
        evictedKey ??= this.putBriefingEntry(entry, candidate.updatedAtMs, candidate.expiresAtMs, false);
        viewChanged = true;
      }
    }
    return {
      changed: true,
      viewChanged,
      evictedKey,
      action: candidate.expiresAtMs <= nowMs ? "expiredCancellationRemoved" : "upsert",
    };
  }

  private semanticBriefingEntry(
    candidate: BriefingCardEntryCandidate,
    semanticKey: string,
    generation: number,
    existing: DisplayBriefingEntryV1 | null,
  ): DisplayBriefingEntryV1 {
    const phenomenonKind = candidate.semanticKeyCandidate === semanticKey
      ? candidate.entry.phenomenonKind
      : existing?.phenomenonKind ?? candidate.entry.phenomenonKind;
    return {
      ...copyBriefingEntry(candidate.entry),
      key: semanticKey,
      editorialOffice: candidate.semanticKeyCandidate === semanticKey
        ? candidate.entry.editorialOffice
        : existing?.editorialOffice ?? candidate.entry.editorialOffice,
      phenomenonKind,
      semanticKey,
      generation,
    };
  }


  private liveBriefingEntry(
    candidate: BriefingCardEntryCandidate,
    generation: number,
    semanticKey: string | null,
  ): DisplayBriefingEntryV1 {
    const existingSubject = semanticKey == null ? null : this.briefingEntries.get(semanticKey)?.entry ?? null;
    const phenomenonKind = semanticKey == null ? null
      : candidate.phenomenonKinds[0] ?? candidate.entry.phenomenonKind ?? existingSubject?.phenomenonKind ?? null;
    return {
      ...copyBriefingEntry(candidate.entry),
      key: semanticKey ?? rawBriefingDisplayKey(candidate.rawIdentity),
      editorialOffice: nonBlank(candidate.entry.editorialOffice) ?? existingSubject?.editorialOffice ?? "",
      phenomenonKind,
      semanticKey,
      generation,
    };
  }

  private putBriefingEntry(
    entry: DisplayBriefingEntryV1,
    updatedAtMs: number,
    expiresAtMs: number,
    restored: boolean,
  ): string | null {
    let evictedKey: string | null = null;
    if (!this.briefingEntries.has(entry.key) && this.briefingEntries.size >= BRIEFING_CARD_MAX_ENTRIES) {
      const victim = [...this.briefingEntries.values()].sort((left, right) =>
        left.updatedAtMs - right.updatedAtMs
        || briefingEntryIdentityToken(left.entry).localeCompare(briefingEntryIdentityToken(right.entry)))[0];
      if (victim != null) {
        this.briefingEntries.delete(victim.entry.key);
        evictedKey = victim.entry.key;
      }
    }
    this.briefingEntries.set(entry.key, { entry, updatedAtMs, expiresAtMs, restored });
    return evictedKey;
  }

  private canReserveRawProtection(token: string): boolean {
    const identities = new Set([...this.rawCriticalProvenance.keys(), ...this.rawBriefingAliases.keys()]);
    return identities.has(token) || identities.size < BRIEFING_RAW_ALIAS_MAX_LINEAGES;
  }

  private pruneBriefingLifecycle(nowMs: number): { changed: boolean; viewChanged: boolean; durableChanged: boolean } {
    let changed = false;
    let viewChanged = false;
    let durableChanged = false;
    for (const [key, state] of [...this.briefingEntries]) {
      if (state.expiresAtMs > nowMs) continue;
      this.briefingEntries.delete(key);
      changed = true;
      viewChanged = true;
      durableChanged ||= isDurableBriefingEntry(state.entry);
    }
    for (const [key, provenance] of [...this.rawCriticalProvenance]) {
      if (provenance.expiresAtMs <= nowMs) {
        this.rawCriticalProvenance.delete(key);
        changed = true;
      }
    }
    for (const [key, alias] of [...this.rawBriefingAliases]) {
      if (alias.expiresAtMs <= nowMs) {
        this.rawBriefingAliases.delete(key);
        changed = true;
        durableChanged = true;
      }
    }
    for (const [semanticKey, watermark] of [...this.briefingRevisionWatermarks]) {
      if (watermark.expiresAtMs > nowMs) continue;
      this.briefingRevisionWatermarks.delete(semanticKey);
      const dependent = this.briefingEntries.get(semanticKey);
      if (dependent != null && isDurableBriefingEntry(dependent.entry)) {
        this.briefingEntries.delete(semanticKey);
        viewChanged = true;
      }
      changed = true;
      durableChanged = true;
    }
    return { changed, viewChanged, durableChanged };
  }

  private briefingDurableFingerprint(): string {
    const entries = [...this.briefingEntries.values()].filter((state) => isDurableBriefingEntry(state.entry))
      .map((state) => ({
        entry: { ...state.entry, generation: 0 },
        updatedAtMs: state.updatedAtMs,
        expiresAtMs: state.expiresAtMs,
      }))
      .sort((left, right) => briefingEntryIdentityToken(left.entry).localeCompare(briefingEntryIdentityToken(right.entry)));
    const watermarks = [...this.briefingRevisionWatermarks.entries()].sort(([left], [right]) => left.localeCompare(right));
    const aliases = [...this.rawBriefingAliases.entries()].sort(([left], [right]) => left.localeCompare(right));
    return stableCanonicalJson({ entries, watermarks, aliases });
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
    return this.reconcileBriefingCriticalLifecycle(sourceKey, canonicalEvent, nowMs);
  }

  private reconcileBriefingCriticalLifecycle(
    sourceKey: string,
    canonicalEvent: PresentationEvent,
    nowMs: number,
  ): CardReconcileResult {
    const durableBefore = this.briefingDurableFingerprint();
    const pruned = this.pruneBriefingLifecycle(nowMs);
    const candidate = briefingCardEntryCandidate(canonicalEvent, nowMs);
    const canonicalKey = candidate?.semanticKeyCandidate ?? null;
    const ignored = (
      reason: Extract<CardReconcileResult, { kind: "ignored" }>["reason"],
    ): CardReconcileResult => {
      if (pruned.changed) {
        this.briefingGeneration += 1;
        const durableChanged = durableBefore !== this.briefingDurableFingerprint();
        if (durableChanged) this.briefingDurableGeneration = this.briefingGeneration;
        this.notify({ viewChanged: pruned.viewChanged, durableChanged });
      }
      return {
        kind: "ignored",
        status: "ignored",
        applied: false,
        sourceKey,
        canonicalKey,
        generation: this.briefingGeneration,
        evictedKey: null,
        reason,
      };
    };

    const sourceEntry = this.briefingEntries.get(sourceKey) ?? null;
    if (sourceEntry != null && sourceEntry.entry.source !== "vpoa50") {
      return ignored("sourceNotVpoa50");
    }
    const sourceProvenanceByKey = [...this.rawCriticalProvenance.values()]
      .find((item) => rawBriefingDisplayKey(item.identity) === sourceKey) ?? null;
    const sourceAlias = [...this.rawBriefingAliases.values()]
      .find((item) => rawBriefingDisplayKey(item.identity) === sourceKey) ?? null;
    const sourceIdentity = sourceEntry?.entry.source === "vpoa50"
      ? { kind: "raw" as const, source: "vpoa50" as const, sourceEventId: sourceEntry.entry.sourceEventId }
      : sourceProvenanceByKey?.identity ?? sourceAlias?.identity ?? null;
    if (sourceIdentity == null) return ignored("sourceNotFound");
    const sourceToken = briefingCriticalIdentityToken(sourceIdentity);
    const sourceProvenance = this.rawCriticalProvenance.get(sourceToken) ?? null;

    if (sourceEntry == null && sourceProvenance == null && sourceAlias != null) {
      return ignored("sourceAlreadyReconciled");
    }

    if (sourceProvenance == null) {
      if (sourceEntry == null || sourceEntry.entry.frameLevel === "critical") {
        return ignored("sourceNotFound");
      }
      return this.reconcileTransientBriefing(
        sourceKey,
        sourceEntry,
        candidate,
        canonicalEvent,
        nowMs,
        durableBefore,
        pruned,
      );
    }
    if (sourceProvenance.phase !== "active"
      || sourceProvenance.expiresAtMs <= nowMs
      || sourceProvenance.lastCriticalExpiresAtMs <= nowMs) {
      return ignored("sourceNotFound");
    }
    if (candidate == null || candidate.entry.source !== "vpbs50"
      || candidate.semanticKeyCandidate == null || candidate.revision == null
      || candidate.entry.frameLevel === "cancel") {
      return ignored("canonicalNotBriefing");
    }

    const semanticKey = candidate.semanticKeyCandidate;
    const watermark = this.briefingRevisionWatermarks.get(semanticKey) ?? null;
    const canonicalLive = this.briefingEntries.get(semanticKey) ?? null;
    const expiredCanonical = candidate.expiresAtMs <= nowMs;
    if (!expiredCanonical && !briefingCandidateWithinLimits(candidate.entry)) {
      return ignored("canonicalNotBriefing");
    }
    if (watermark != null) {
      const comparison = compareRevision(candidate.revision, watermark.revision);
      if (comparison < 0) {
        log.warn("[briefing-card] late reconcile canonical is not newer");
        return ignored("canonicalNotNewer");
      }
      if (comparison === 0) {
        if (canonicalLive != null
          && briefingPayloadFingerprint(canonicalLive.entry) !== candidate.fingerprint) {
          return ignored("canonicalNotNewer");
        }
        // 通常reconcileのwatermark-only equalは由来を証明できない。一方、期限切れ
        // canonicalは表示を生成せずsource retirementだけを行うため、同順位を許可する。
        if (!expiredCanonical && canonicalLive == null) return ignored("canonicalNotNewer");
      }
    }

    if (!expiredCanonical) {
      if (sourceProvenance.lastStrictRevision == null) {
        log.warn("[briefing-card] late reconcile canonical is unordered");
        return ignored("canonicalNotNewer");
      }
      if (compareRevision(candidate.revision, sourceProvenance.lastStrictRevision) < 0) {
        log.warn("[briefing-card] late reconcile canonical is not newer");
        return ignored("canonicalNotNewer");
      }
      if (watermark == null
        && this.briefingRevisionWatermarks.size >= BRIEFING_CRITICAL_WATERMARK_MAX_SUBJECTS) {
        log.warn("[briefing-card] briefingCriticalProtectionCapacityRejected reconcile");
        return ignored("canonicalNotNewer");
      }
    }

    const generation = this.briefingGeneration + 1;
    const previousAlias = this.rawBriefingAliases.get(sourceToken) ?? null;
    const acceptedRevision = expiredCanonical && sourceProvenance.lastStrictRevision != null
      && compareRevision(sourceProvenance.lastStrictRevision, candidate.revision) > 0
      ? sourceProvenance.lastStrictRevision
      : candidate.revision;
    const canonicalMaintained = !expiredCanonical && watermark != null
      && compareRevision(candidate.revision, watermark.revision) === 0;
    const resultingWatermarkExpiry = expiredCanonical
      ? watermark?.expiresAtMs ?? 0
      : canonicalMaintained
        ? watermark!.expiresAtMs
        : nowMs + BRIEFING_CARD_TTL_MS;
    const aliasExpiry = Math.max(
      previousAlias?.expiresAtMs ?? 0,
      sourceProvenance.expiresAtMs,
      resultingWatermarkExpiry,
    );

    const sourceWasVisible = this.briefingEntries.delete(sourceKey);
    this.rawCriticalProvenance.delete(sourceToken);
    this.rawBriefingAliases.set(sourceToken, {
      identity: { ...sourceIdentity },
      semanticKey,
      revision: { ...acceptedRevision },
      expiresAtMs: aliasExpiry,
    });

    let expiresAt: string | null = null;
    let canonicalInserted = false;
    let viewChanged = sourceWasVisible;
    if (!expiredCanonical && !canonicalMaintained) {
      this.briefingRevisionWatermarks.set(semanticKey, {
        revision: { ...candidate.revision },
        expiresAtMs: resultingWatermarkExpiry,
      });
      viewChanged = this.briefingEntries.delete(semanticKey) || viewChanged;
      const displayExpiry = Math.min(
        sourceProvenance.lastCriticalExpiresAtMs,
        candidate.expiresAtMs,
      );
      const entry = this.semanticBriefingEntry(candidate, semanticKey, generation, canonicalLive?.entry ?? null);
      entry.expiresAt = new Date(displayExpiry).toISOString();
      this.putBriefingEntry(entry, candidate.updatedAtMs, displayExpiry, false);
      expiresAt = entry.expiresAt;
      canonicalInserted = true;
      viewChanged = true;
    } else if (canonicalMaintained && canonicalLive != null) {
      const displayExpiry = Math.min(
        canonicalLive.expiresAtMs,
        sourceProvenance.lastCriticalExpiresAtMs,
        candidate.expiresAtMs,
      );
      if (displayExpiry !== canonicalLive.expiresAtMs) {
        canonicalLive.expiresAtMs = displayExpiry;
        canonicalLive.entry.expiresAt = new Date(displayExpiry).toISOString();
        viewChanged = true;
      }
      expiresAt = canonicalLive.entry.expiresAt;
    }

    this.briefingGeneration = generation;
    const durableChanged = durableBefore !== this.briefingDurableFingerprint();
    if (durableChanged) this.briefingDurableGeneration = generation;
    this.notify({ viewChanged: pruned.viewChanged || viewChanged, durableChanged });
    return {
      kind: "applied",
      status: "applied",
      applied: true,
      sourceKey,
      canonicalKey: semanticKey,
      generation,
      expiresAt,
      canonicalInserted,
      evictedKey: null,
    };
  }

  private reconcileTransientBriefing(
    sourceKey: string,
    sourceEntry: BriefingCardEntryState,
    candidate: BriefingCardEntryCandidate | null,
    canonicalEvent: PresentationEvent,
    nowMs: number,
    durableBefore: string,
    pruned: { changed: boolean; viewChanged: boolean; durableChanged: boolean },
  ): CardReconcileResult {
    const canonicalKey = candidate?.semanticKeyCandidate ?? candidate?.entry.key ?? null;
    const ignored = (
      reason: Extract<CardReconcileResult, { kind: "ignored" }>["reason"],
    ): CardReconcileResult => {
      if (pruned.changed) {
        this.briefingGeneration += 1;
        const durableChanged = durableBefore !== this.briefingDurableFingerprint();
        if (durableChanged) this.briefingDurableGeneration = this.briefingGeneration;
        this.notify({ viewChanged: pruned.viewChanged, durableChanged });
      }
      return { kind: "ignored", status: "ignored", applied: false, sourceKey, canonicalKey,
        generation: this.briefingGeneration, evictedKey: null, reason };
    };
    if (candidate == null || candidate.entry.source !== "vpbs50"
      || candidate.entry.frameLevel === "cancel" || !briefingCandidateWithinLimits(candidate.entry)) {
      return ignored("canonicalNotBriefing");
    }
    if (candidate.expiresAtMs > nowMs) {
      const comparison = compareBriefingEntryRevision(sourceEntry.entry, candidate.entry);
      if (comparison != null && comparison < 0) return ignored("canonicalNotNewer");
      if (comparison == null && strictBriefingRevision(sourceEntry.entry) != null) {
        return ignored("canonicalNotNewer");
      }
    }
    const generation = this.briefingGeneration + 1;
    this.briefingEntries.delete(sourceKey);
    let expiresAt: string | null = null;
    let inserted = false;
    if (candidate.expiresAtMs > nowMs) {
      const displayExpiry = Math.min(sourceEntry.expiresAtMs, candidate.expiresAtMs);
      if (displayExpiry > nowMs) {
        const entry = candidate.semanticKeyCandidate == null
          ? this.liveBriefingEntry(candidate, generation, null)
          : this.semanticBriefingEntry(candidate, candidate.semanticKeyCandidate, generation, null);
        entry.expiresAt = new Date(displayExpiry).toISOString();
        this.putBriefingEntry(entry, candidate.updatedAtMs, displayExpiry, false);
        expiresAt = entry.expiresAt;
        inserted = true;
      }
    }
    this.briefingGeneration = generation;
    const durableChanged = durableBefore !== this.briefingDurableFingerprint();
    if (durableChanged) this.briefingDurableGeneration = generation;
    this.notify({ viewChanged: true, durableChanged });
    return { kind: "applied", status: "applied", applied: true, sourceKey,
      canonicalKey: canonicalKey ?? briefingCardIdentity(canonicalEvent) ?? "", generation,
      expiresAt, canonicalInserted: inserted, evictedKey: null };
  }


  /** Current card-only mutation generation, for targeted reconcile tests. */
  briefingCardGeneration(): number {
    return this.briefingGeneration;
  }

  /** Current number of active card entries before the next sweep. */
  briefingCardEntryCount(): number {
    return this.briefingEntries.size;
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
    if (event.isCancellation) {
      const cancellationTargetId = event.eventId;
      if (cancellationTargetId == null || this.nankaiTrough?.sourceEventId !== cancellationTargetId) {
        return NO_MUTATION;
      }
      this.nankaiTrough = null;
      return { viewChanged: true, durableChanged: true };
    }
    const status = nankaiBadgeAction(raw.infoSerial?.code ?? null);
    if (status.action === "ignore") return NO_MUTATION;
    const revision = revisionOf(event.reportDateTime, event.serial ?? null, nowMs);
    if (event.standbyStateMutationAccepted == null && !this.revisionGuard.accept("nankai:current", revision, nowMs, 30 * DAY_MS, event.infoType === "訂正")) return NO_MUTATION;
    if (status.action === "deactivate") {
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
      if (eventId !== event.eventId && state.hosted) {
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
    const briefingDurableBefore = this.briefingDurableFingerprint();
    const briefingPrune = this.pruneBriefingLifecycle(nowMs);
    if (briefingPrune.changed) {
      this.briefingGeneration += 1;
      const briefingDurableChanged = briefingDurableBefore !== this.briefingDurableFingerprint();
      if (briefingDurableChanged) this.briefingDurableGeneration = this.briefingGeneration;
      viewChanged ||= briefingPrune.viewChanged;
      durableChanged ||= briefingDurableChanged;
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
      restored: states.some((state) => state.restored),
      severity,
      data: { generation: this.briefingGeneration, entries },
    };
  }

  exportActiveState(): PersistedStandbyStateV1 {
    const briefingCritical = this.exportBriefingCritical();
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
      ...(briefingCritical == null ? {} : { briefingCritical }),
    };
  }

  private exportBriefingCritical(): PersistedBriefingCriticalStateV1 | null {
    const entries = [...this.briefingEntries.values()]
      .filter((state) => state.entry.frameLevel === "critical")
      .map((state) => ({
        entry: copyBriefingEntry(state.entry), updatedAtMs: state.updatedAtMs, expiresAtMs: state.expiresAtMs,
      }));
    const cancellations = [...this.briefingEntries.values()]
      .filter((state) => state.entry.frameLevel === "cancel" && isSemanticBriefingSubject(state.entry))
      .map((state) => ({
        entry: copyBriefingEntry(state.entry), updatedAtMs: state.updatedAtMs, expiresAtMs: state.expiresAtMs,
      }));
    const watermarks = [...this.briefingRevisionWatermarks.entries()].map(([semanticKey, watermark]) => ({
      semanticKey, revision: { ...watermark.revision }, expiresAtMs: watermark.expiresAtMs,
    }));
    const rawAliases: PersistedBriefingCriticalRawAliasV1[] = [...this.rawBriefingAliases.values()].map((alias) => ({
      source: alias.identity.source, sourceEventId: alias.identity.sourceEventId,
      semanticKey: alias.semanticKey, revision: { ...alias.revision }, expiresAtMs: alias.expiresAtMs,
    }));
    if (entries.length === 0 && cancellations.length === 0 && watermarks.length === 0 && rawAliases.length === 0) return null;
    return validateBriefingCriticalForWrite({
      generation: this.briefingDurableGeneration,
      entries,
      cancellations,
      watermarks,
      ...(rawAliases.length === 0 ? {} : { rawAliases }),
    });
  }

  restoreActiveState(data: PersistedStandbyState, nowMs: number): RestoreActiveStateResult {
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
    this.briefingRevisionWatermarks.clear();
    this.rawCriticalProvenance.clear();
    this.rawBriefingAliases.clear();
    this.briefingGeneration = 0;
    this.briefingDurableGeneration = 0;
    const briefingCriticalRewriteRequired = this.restoreBriefingCritical(data.briefingCritical, nowMs);
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
    return { briefingCriticalRewriteRequired };
  }

  private restoreBriefingCritical(state: PersistedBriefingCriticalStateV1 | undefined, nowMs: number): boolean {
    if (state == null) return false;
    this.briefingGeneration = state.generation;
    this.briefingDurableGeneration = state.generation;
    let rewriteRequired = state.rawAliases != null && state.rawAliases.length === 0;
    for (const watermark of state.watermarks) {
      if (watermark.expiresAtMs <= nowMs) {
        rewriteRequired = true;
        continue;
      }
      this.briefingRevisionWatermarks.set(watermark.semanticKey, {
        revision: { ...watermark.revision }, expiresAtMs: watermark.expiresAtMs,
      });
    }
    for (const alias of state.rawAliases ?? []) {
      if (alias.expiresAtMs <= nowMs) {
        rewriteRequired = true;
        continue;
      }
      const identity = { kind: "raw" as const, source: alias.source, sourceEventId: alias.sourceEventId };
      this.rawBriefingAliases.set(briefingCriticalIdentityToken(identity), {
        identity, semanticKey: alias.semanticKey, revision: { ...alias.revision }, expiresAtMs: alias.expiresAtMs,
      });
    }
    for (const persisted of [...state.entries, ...state.cancellations]) {
      if (persisted.expiresAtMs <= nowMs) {
        rewriteRequired = true;
        continue;
      }
      if (persisted.entry.semanticKey != null && !this.briefingRevisionWatermarks.has(persisted.entry.semanticKey)) {
        rewriteRequired = true;
        continue;
      }
      const entry = copyBriefingEntry(persisted.entry);
      this.briefingEntries.set(entry.key, {
        entry, updatedAtMs: persisted.updatedAtMs, expiresAtMs: persisted.expiresAtMs, restored: true,
      });
      if (entry.semanticKey == null && entry.frameLevel === "critical") {
        const identity = { kind: "raw" as const, source: entry.source, sourceEventId: entry.sourceEventId };
        const token = briefingCriticalIdentityToken(identity);
        const revision = strictBriefingRevision(entry);
        this.rawCriticalProvenance.set(token, {
          identity, phase: "active", lastStrictRevision: revision == null ? null : { ...revision },
          lastAcceptedFrameLevel: "critical", lastPayloadFingerprint: briefingPayloadFingerprint(entry),
          lastCriticalExpiresAtMs: persisted.expiresAtMs, expiresAtMs: persisted.expiresAtMs,
        });
      }
    }
    const canonical = this.exportBriefingCritical();
    if (canonical == null) return true;
    return rewriteRequired || stableCanonicalJson(canonical) !== stableCanonicalJson(state);
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

function rawEventId(event: PresentationEvent): string | null {
  return isRecord(event.raw) && typeof event.raw.eventId === "string"
    ? nonBlank(event.raw.eventId)
    : null;
}

const BRIEFING_KIND_ORDER: readonly DisplayBriefingKindV1[] = [
  "linearRainObserved", "linearRainPredicted", "recordRain", "shortSnow",
];

function briefingPhenomenonKinds(info: ParsedWeatherBriefing | null): DisplayBriefingKindV1[] {
  if (info == null) return [];
  const known = new Set(info.briefingSeverityEvidence
    .map((evidence) => evidence.tag)
    .filter((tag): tag is DisplayBriefingKindV1 => BRIEFING_KIND_ORDER.includes(tag as DisplayBriefingKindV1)));
  return BRIEFING_KIND_ORDER.filter((kind) => known.has(kind));
}

function briefingSemanticKey(editorialOffice: string, phenomenonKind: DisplayBriefingKindV1): string {
  return `card:vpbs:semantic:${phenomenonKind}:${editorialOffice}`;
}

export function briefingCriticalIdentityToken(identity: BriefingCriticalIdentity): string {
  return identity.kind === "semantic"
    ? JSON.stringify(["semantic", identity.semanticKey])
    : JSON.stringify(["raw", identity.source, identity.sourceEventId]);
}

function rawBriefingDisplayKey(identity: Extract<BriefingCriticalIdentity, { kind: "raw" }>): string {
  return `card:briefing:${briefingCriticalIdentityToken(identity)}`;
}

function stableCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalJson).sort().join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCanonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function briefingPayloadFingerprint(entry: DisplayBriefingEntryV1): string {
  const {
    key: _key, sourceEventId: _sourceEventId, editorialOffice: _editorialOffice,
    phenomenonKind: _phenomenonKind, semanticKey: _semanticKey, serial: _serial,
    reportDateTime: _reportDateTime, updatedAt: _updatedAt, expiresAt: _expiresAt,
    generation: _generation, ...payload
  } = entry;
  return stableCanonicalJson(payload);
}

function briefingEntryIdentityToken(entry: DisplayBriefingEntryV1): string {
  return entry.semanticKey != null
    ? briefingCriticalIdentityToken({ kind: "semantic", semanticKey: entry.semanticKey })
    : briefingCriticalIdentityToken({ kind: "raw", source: entry.source, sourceEventId: entry.sourceEventId });
}

function isDurableBriefingEntry(entry: DisplayBriefingEntryV1): boolean {
  return entry.frameLevel === "critical"
    || entry.frameLevel === "cancel" && isSemanticBriefingSubject(entry);
}

function briefingCandidateWithinLimits(entry: DisplayBriefingEntryV1): boolean {
  return entry.conditions.length <= 2_048 && entry.targetAreas.length <= 2_048
    && entry.severityEvidence.length <= 2_048
    && (entry.summary == null || entry.summary.items.length <= 4
      && entry.summary.items.every((item) => item.facts.length <= 2_048));
}


function isSemanticBriefingSubject(entry: DisplayBriefingEntryV1): entry is DisplayBriefingEntryV1 & {
  phenomenonKind: DisplayBriefingKindV1;
  semanticKey: string;
} {
  return entry.source === "vpbs50" && entry.phenomenonKind != null && entry.semanticKey != null;
}


function strictBriefingRevision(entry: DisplayBriefingEntryV1): StandbyRevision | null {
  const reportTimeMs = Date.parse(entry.reportDateTime);
  if (!Number.isFinite(reportTimeMs) || entry.serial == null || entry.serial.trim() === "") return null;
  const serial = Number(entry.serial);
  return Number.isFinite(serial) ? { reportTimeMs, serial: entry.serial } : null;
}

/** null means unordered: only raw exact identity may fail open. */
function compareBriefingEntryRevision(
  previous: DisplayBriefingEntryV1,
  candidate: DisplayBriefingEntryV1,
): number | null {
  const previousRevision = strictBriefingRevision(previous);
  const candidateRevision = strictBriefingRevision(candidate);
  return previousRevision == null || candidateRevision == null
    ? null
    : compareRevision(candidateRevision, previousRevision);
}

/** Card identity deliberately preserves the raw EventID/messageId spelling. */
export function briefingCardIdentity(event: PresentationEvent): string | null {
  const source = parsedBriefing(event) != null
    ? "vpbs50"
    : parsedVpoa(event) != null
      ? "vpoa50"
      : event.domain === "briefing" && event.type === "VPBS50"
        ? "vpbs50"
        : event.domain === "legacyCounterpart" && event.type === "VPOA50"
          ? "vpoa50"
          : null;
  const rawIdentity = sourceEventId(event);
  if (source == null || rawIdentity == null) return null;
  return rawBriefingDisplayKey({ kind: "raw", source, sourceEventId: rawIdentity });
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

const BRIEFING_KIND: Readonly<Record<string, { kind: DisplayBriefingKindV1; lead: string }>> = {
  "線状降水帯発生": { kind: "linearRainObserved", lead: "線状降水帯が発生" },
  "線状降水帯直前": { kind: "linearRainPredicted", lead: "３時間以内に線状降水帯発生のおそれ" },
  "記録雨": { kind: "recordRain", lead: "記録的短時間大雨" },
  "記録的短時間大雨": { kind: "recordRain", lead: "記録的短時間大雨" },
  "短時間大雪": { kind: "shortSnow", lead: "短時間大雪" },
};

const BRIEFING_TITLE_KIND: Readonly<Record<string, { kind: DisplayBriefingKindV1; lead: string }>> = {
  "線状降水帯発生": BRIEFING_KIND["線状降水帯発生"],
  "線状降水帯直前予測": BRIEFING_KIND["線状降水帯直前"],
  "記録的短時間大雨": BRIEFING_KIND["記録的短時間大雨"],
  "短時間大雪": BRIEFING_KIND["短時間大雪"],
};

function exactBriefingTitleKind(title: string): { kind: DisplayBriefingKindV1; lead: string } | null {
  const matched = /\(([^()]+)\)/.exec(title.normalize("NFKC"));
  return matched == null ? null : BRIEFING_TITLE_KIND[matched[1]!] ?? null;
}

function observationFacts(
  info: ParsedWeatherBriefing,
  kind: DisplayBriefingKindV1,
): DisplayBriefingFactV1[] {
  if (kind === "linearRainObserved" || kind === "linearRainPredicted") {
    const expected = kind === "linearRainObserved" ? "線状降水帯発生" : "線状降水帯予想";
    return info.observations
      .filter((observation) => observation.partKind === "event" && observation.description.normalize("NFKC") === expected)
      .map((observation) => ({
        kind: "event" as const,
        label: kind === "linearRainObserved" ? "発生" as const : "予想" as const,
        areaName: observation.locationName,
        areaCode: observation.locationCode,
        at: observation.time,
      }));
  }
  const partKind = kind === "recordRain" ? "precipitation" : "snowfall";
  return info.observations
    .filter((observation) => observation.partKind === partKind)
    .map((observation) => ({
      kind: partKind,
      locationName: observation.locationName,
      locationCode: observation.locationCode,
      description: observation.description,
      value: observation.value,
      unit: observation.unit,
      at: observation.time,
      ...(partKind === "precipitation" ? {
        duration: observation.duration,
        approximation: observation.approximation,
      } : {}),
    }));
}

function briefingSummary(info: ParsedWeatherBriefing | null, vpoa: ParsedLegacyCounterpartInfo | null, infoType: string): DisplayBriefingSummaryV1 {
  if (info != null && infoType === "取消") {
    return { mode: "cancellation", items: [], hasUnknownKind: false };
  }
  if (vpoa != null) {
    if (infoType === "取消") return { mode: "rawHeadlineFallback", items: [], hasUnknownKind: false };
    if (!isHighVpoaCard(vpoa)) return { mode: "rawHeadlineFallback", items: [], hasUnknownKind: false };
    return {
      mode: "structured",
      items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }],
      hasUnknownKind: false,
    };
  }
  if (info == null) return { mode: "rawHeadlineFallback", items: [], hasUnknownKind: false };

  const tagged = info.briefingSeverityEvidence
    .map((evidence, sourceOrdinal) => ({ evidence, sourceOrdinal }))
    .filter(({ evidence }) => evidence.source !== "none");
  if (tagged.length === 0) {
    const fallback = info.briefingConditions.length === 0 ? exactBriefingTitleKind(info.title) : null;
    return fallback == null
      ? { mode: "rawHeadlineFallback", items: [], hasUnknownKind: false }
      : {
          mode: "structured",
          items: [{ ...fallback, sourceOrdinal: 0, facts: observationFacts(info, fallback.kind) }],
          hasUnknownKind: false,
        };
  }

  const hasUnknownKind = tagged.some(({ evidence }) => BRIEFING_KIND[evidence.condition.normalize("NFKC")] == null);
  const seen = new Set<DisplayBriefingKindV1>();
  const items: Array<DisplayBriefingSummaryItemV1 & { severityRank: number }> = [];
  for (const { evidence, sourceOrdinal } of tagged) {
    const known = BRIEFING_KIND[evidence.condition.normalize("NFKC")];
    if (known == null || seen.has(known.kind)) continue;
    seen.add(known.kind);
    items.push({
      ...known,
      sourceOrdinal,
      facts: observationFacts(info, known.kind),
      severityRank: evidence.displaySeverity == null ? -1 : DISPLAY_SEVERITY_RANK[evidence.displaySeverity],
    });
  }
  items.sort((left, right) => right.severityRank - left.severityRank || left.sourceOrdinal - right.sourceOrdinal);
  if (items.length === 0) return { mode: "rawHeadlineFallback", items: [], hasUnknownKind };
  return {
    mode: hasUnknownKind ? "mixed" : "structured",
    items: items.map(({ severityRank: _severityRank, ...item }) => item),
    hasUnknownKind,
  };
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
  const rawIdentity = sourceEventId(event);
  if (source == null || rawIdentity == null) return null;
  const typedRawIdentity: Extract<BriefingCriticalIdentity, { kind: "raw" }> = {
    kind: "raw", source, sourceEventId: rawIdentity,
  };

  const infoType = nonBlank(info?.infoType ?? vpoa?.infoType ?? event.infoType) ?? event.infoType;
  const reportDateTime = info?.reportDateTime ?? vpoa?.reportDateTime ?? event.reportDateTime;
  const updatedAtMs = reportTimeMs(reportDateTime, nowMs);
  const isCancellation = infoType === "取消" || event.isCancellation;
  const ownTtlMs = isCancellation ? BRIEFING_CARD_CANCEL_TTL_MS : BRIEFING_CARD_TTL_MS;
  const ownExpiresAtMs = updatedAtMs + ownTtlMs;
  const expiresAtMs = ownExpiresAtMs;

  const targetAreas = info != null
    ? info.targetAreas.map((area) => ({ name: area.name, code: area.code }))
    : vpoa != null
      ? vpoa.areas.map((area) => ({ name: area.name, code: area.code }))
      : briefingAreaItems(event);
  const frameLevel = isCancellation
    ? "cancel"
    : source === "vpbs50"
    ? normalizeBriefingFrameLevel(info == null ? event.frameLevel : briefingFrameLevel(info))
    : vpoa == null
      ? normalizeBriefingFrameLevel(event.frameLevel)
      : isHighVpoaCard(vpoa) ? "critical" : "warning";
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
  const phenomenonKinds = briefingPhenomenonKinds(info);
  const editorialOffice = nonBlank(info?.editorialOffice ?? vpoa?.editorialOffice ?? event.editorialOffice) ?? "";
  const revision = strictRevisionFromParts(reportDateTime, info?.serial ?? vpoa?.serial ?? event.serial ?? null);
  const semanticKeyCandidate = source === "vpbs50" && editorialOffice !== ""
    && phenomenonKinds.length === 1 && revision != null
    ? briefingSemanticKey(editorialOffice, phenomenonKinds[0]!)
    : null;
  const key = semanticKeyCandidate ?? rawBriefingDisplayKey(typedRawIdentity);

  const entry: DisplayBriefingEntryV1 = {
    key,
    source,
    sourceEventId: rawIdentity,
    editorialOffice,
    // A fail-open raw entry must not look like a semantic subject. The kind is
    // written only by subject creation or inheritance after guarded matching.
    phenomenonKind: semanticKeyCandidate == null ? null : phenomenonKinds[0]!,
    semanticKey: semanticKeyCandidate,
    serial: info?.serial ?? vpoa?.serial ?? event.serial ?? null,
    title: info?.title ?? vpoa?.title ?? event.title,
    headline: info?.headline ?? vpoa?.headline ?? event.headline,
    conditions,
    targetAreas,
    reportDateTime,
    publishingOffice: info?.publishingOffice ?? vpoa?.publishingOffice ?? event.publishingOffice,
    infoType,
    frameLevel,
    severityEvidence,
    summary: briefingSummary(info, vpoa, infoType),
    qualifier: source === "vpoa50" ? "対応電文未確認" : null,
    updatedAt: new Date(updatedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    generation: 0,
  };
  return {
    entry,
    updatedAtMs,
    expiresAtMs,
    restored: false,
    phenomenonKinds,
    hasRawEventId: rawEventId(event) != null,
    isCancellation,
    rawIdentity: typedRawIdentity,
    rawToken: briefingCriticalIdentityToken(typedRawIdentity),
    semanticKeyCandidate,
    revision,
    fingerprint: briefingPayloadFingerprint(entry),
  };
}

function strictRevisionFromParts(reportDateTime: string, serial: string | null | undefined): StandbyRevision | null {
  const reportTimeMs = Date.parse(reportDateTime);
  if (!Number.isFinite(reportTimeMs) || serial == null || !/^\d+$/.test(serial.trim())) return null;
  const numeric = Number(serial);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? { reportTimeMs, serial: String(numeric) }
    : null;
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

/** Revision equality is about the semantic payload, not the raw EventID lineage. */
function compareBriefingKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function briefingCardMutationToDisplayMutation(result: BriefingCardMutationResult): DisplayMutation {
  if (!result.applied) return NO_MUTATION;
  return {
    viewChanged: result.viewChanged === true,
    durableChanged: result.durableChanged === true,
    ...(result.evictedKey == null ? {} : { cardEvictedKey: result.evictedKey }),
  };
}

function copyBriefingEntry(entry: DisplayBriefingEntryV1): DisplayBriefingEntryV1 {
  return {
    ...entry,
    conditions: [...entry.conditions],
    targetAreas: entry.targetAreas.map((area) => ({ ...area })),
    severityEvidence: entry.severityEvidence.map((evidence) => ({ ...evidence })),
    ...(entry.summary == null ? {} : {
      summary: {
        ...entry.summary,
        items: entry.summary.items.map((item) => ({
          ...item,
          facts: item.facts.map((fact) => ({ ...fact })),
        })),
      },
    }),
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
