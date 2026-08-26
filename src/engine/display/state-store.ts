import {
  EEW_FINAL_HOLD_SEC,
  EEW_TTL_MIN,
  LARGE_QUAKE_HOLD_MIN,
  RECENT_QUAKES_MAX,
} from "./constants";
import {
  DISPLAY_PROTOCOL_VERSION,
  type DisplayActiveEewV1,
  type ActiveStandbyCardV1,
  type DisplayConnectionStateV1,
  type DisplayBackgroundTone,
  type DisplayEewInputV1,
  type DisplayEventDtoV1,
  type DisplayIntensityGroupV1,
  type DisplayLargeQuakeStateV1,
  type DisplayQuakeIntensityMapEventV1,
  type DisplayQuakeMapCommandV1,
  type DisplayLatestQuakeInputV1,
  type DisplayLatestQuakeStateV1,
  type DisplayRecentQuakeV1,
  type DisplaySeverityTier,
  type DisplayStateSnapshotV1,
  type DisplayStatsV1,
  type DisplayTsunamiInputV1,
  type DisplayTsunamiObservationV1,
  type DisplayTsunamiStateV1,
  type DisplayWeatherAddedAreasV1,
  type DisplayWeatherAlertV1,
  type DisplayWeatherExpandedKindV1,
  type DisplayWeatherPromotionEntryV1,
  type DisplayWeatherPromotionV1,
  type DisplayWeatherSourceV1,
} from "./types";
import type { Vpws50CurrentAreasForDisplay } from "../../types";
import { intensityToRank } from "../../utils/intensity";
import { jstDayKey } from "../../utils/jst-day-key";
import {
  quakeCardRank,
  quakeCardTtlMs,
  shouldReplaceLatestQuake,
} from "./quake-card-selection";
import { projectEarthquakeIntensitySemantic } from "./intensity-groups";
import {
  mergeLatestQuakeObservation,
  mergeRecentQuakeObservation,
  hasResolvedQuakeCancellation,
  quakeObservationBridgeOf,
  quakeObservationMetaOf,
  shouldPreserveVxse51Observation,
  shouldRetainKnownQuakeSafety,
  withQuakeObservationMeta,
} from "./quake-observation-merge";
import { WEATHER_PROMOTION_SOURCES, type WeatherPromotionMemberV1 } from "./weather-promotion";
import {
  WeatherPromotionStore,
  type WeatherPromotionPersistedV1,
  type WeatherPromotionRecord,
} from "./weather-promotion-store";
import { QuakeExtremeStore } from "./quake-extreme-store";
import { RevisionGuard } from "./revision-guard";
import type { StandbyRevision } from "./standby-registry";
import { TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY } from "../messages/tsunami-state";
import { projectDisplayTsunamiObservations } from "./tsunami-observation-projection";
import type { PresentationEvent } from "../presentation/types";
import { WeatherChangeDisplayStore } from "./weather-change-store";
import {
  collectWeatherExpandedKinds,
  WEATHER_EXPANDED_KINDS,
  weatherAreaIdentity,
  type WeatherAlertsSnapshotV1,
} from "./weather-expanded-kinds";

const MIN_MS = 60_000;
const NON_EMERGENCY_HOST_TTL_MS = 5 * MIN_MS;
const TIER_ORDER: Record<DisplaySeverityTier, number> = { calm: 0, caution: 1, alert: 2, critical: 3 };
const TIER_QUAKE_ALERT_RANK = intensityToRank("5弱");
const QUAKE_MAP_HOST_MIN_RANK = intensityToRank("3");

interface QuakeMapMutationResult {
  accepted: boolean;
  changed: boolean;
  preservation: "none" | "structuralMissing" | "knownEmergencyUnknown";
}

function quakeMapSafetyLowerRank(event: DisplayQuakeIntensityMapEventV1): number {
  return event.maxIntSemantic?.safetyLowerRank ?? event.maxIntRank;
}

function isUnknownQuakeMapEvent(event: DisplayQuakeIntensityMapEventV1): boolean {
  return event.maxIntRank === -1 && event.maxIntSemantic?.presence === "unknown";
}

export interface DisplayTsunamiObservationGroups {
  VTSE51: DisplayTsunamiObservationV1[];
  VTSE52: DisplayTsunamiObservationV1[];
}

function sameRevision(a: StandbyRevision | undefined, b: StandbyRevision | undefined): boolean {
  return a != null && b != null && a.reportTimeMs === b.reportTimeMs && a.serial === b.serial;
}

function tsunamiObservationNameKey(observation: DisplayTsunamiObservationV1): string {
  return `name:${JSON.stringify([
    observation.areaName ?? "",
    observation.stationName,
  ])}`;
}

function tsunamiObservationStationKey(observation: DisplayTsunamiObservationV1): string {
  const stationCode = observation.stationCode?.trim();
  if (stationCode) return `code:${stationCode}`;
  return tsunamiObservationNameKey(observation);
}

function mergeTsunamiObservationGroup(
  current: readonly DisplayTsunamiObservationV1[],
  incoming: readonly DisplayTsunamiObservationV1[],
): DisplayTsunamiObservationV1[] {
  const merged = [...current];
  for (const observation of incoming) {
    const stationKey = tsunamiObservationStationKey(observation);
    const legacyStationKey = observation.stationCode?.trim()
      ? tsunamiObservationNameKey(observation)
      : null;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const candidate = merged[index];
      const sameStation = tsunamiObservationStationKey(candidate) === stationKey;
      const sameLegacyStation = legacyStationKey != null
        && !candidate.stationCode?.trim()
        && tsunamiObservationNameKey(candidate) === legacyStationKey;
      if (sameStation || sameLegacyStation) merged.splice(index, 1);
    }
    // holder と同じく、更新された観測点を末尾（最終更新が新しい側）へ移す。
    merged.push(observation);
  }
  return merged.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY);
}

function promotionEntry(record: WeatherPromotionRecord | null): DisplayWeatherPromotionEntryV1 | null {
  if (record == null || record.state !== "active") return null;
  const promotedAt = new Date(record.promotedAtMs).toISOString();
  return {
    level: record.level,
    promotedAt,
    generation: record.generation,
    trigger: record.trigger ?? undefined,
    // 安定キーで求めた追加地域を、wire では表示名と対応コードの対で畳んで載せる
    addedAreas: addedAreasForWire(record.addedAreas),
    // 点灯の同一性キー。**点灯イベントの通し番号だけ**を使う (Codex レビュー 2026-07-27) —
    // promotedAt を混ぜると display on の測り直しで再点灯し、generation だけだと
    // 「解除 → 同内容で再発表」を取り逃す
    activationKey: `${record.activationSeq}`,
  };
}

/** 追加地域 (安定キー付き member) を wire 形へ。同一種別の地域はまとめ、出現順を保つ */
function addedAreasForWire(added: readonly WeatherPromotionMemberV1[]): DisplayWeatherAddedAreasV1[] {
  const byKind = new Map<string, DisplayWeatherAddedAreasV1>();
  for (const m of added) {
    const entry = byKind.get(m.kind);
    if (entry == null) {
      byKind.set(m.kind, { kind: m.kind, areas: [m.areaName], areaCodes: [m.areaCode] });
      continue;
    }
    const identity = weatherAreaIdentity(m.areaName, m.areaCode);
    const exists = entry.areas.some((area, index) =>
      weatherAreaIdentity(area, entry.areaCodes?.[index]) === identity);
    if (!exists) {
      entry.areas.push(m.areaName);
      entry.areaCodes?.push(m.areaCode);
    }
  }
  return [...byKind.values()];
}

// 現在の緊急状態 (EEW/津波/大地震/気象警報/接続) を合成する表示用ストア。
// 時刻は全メソッドで nowMs 注入 (クラス内で Date.now() を呼ばない)。
// applyEvent/sweep の boolean = 「state snapshot の再配信が必要な変化があったか」。
export class DisplayStateStore {
  private activeEews = new Map<string, DisplayActiveEewV1>();
  private eewSourceRevisions = new Map<
    string,
    { eventId: string; serial: string | null; updatedAtMs: number }
  >();
  private tsunami: DisplayTsunamiStateV1 | null = null;
  private tsunamiObservationGroups: DisplayTsunamiObservationGroups = {
    VTSE51: [],
    VTSE52: [],
  };
  private largeQuakes = new Map<string, DisplayLargeQuakeStateV1>();
  /** EventID 系列 × source type の最新 contribution。wire へは eventKey ごとの有効一件だけを出す。 */
  private quakeMapContributions =
    new Map<string, Map<string, DisplayQuakeIntensityMapEventV1>>();
  private quakeMapHost: { eventKey: string; expiresAtMs: number } | null = null;
  private unknownQuakeMapHost: { eventKey: string; expiresAtMs: number } | null = null;
  private readonly quakeMapRevisionGuard = new RevisionGuard();
  private recentQuakes: DisplayRecentQuakeV1[] = [];
  private latestQuake: DisplayLatestQuakeStateV1 | null = null;
  private stats: DisplayStatsV1 | null = null;
  private weatherAlerts: DisplayWeatherAlertV1[] = [];
  private connection: DisplayConnectionStateV1 = {
    dmdata: "connecting", lastReceivedAt: null, disconnectedSince: null, reason: null,
  };
  /** 気象警報の昇格 lifecycle。monitor 所有のストアを注入して display off/on をまたいで
   *  時計を維持する (未注入時はこのストア専用のインスタンスを持つ = 旧テスト互換) */
  private readonly promotions: WeatherPromotionStore;
  /** 震度 7 の 12 時間保持。monitor 注入時は display on/off・再起動の外で生きる。 */
  private readonly quakeExtreme: QuakeExtremeStore;
  private readonly weatherChanges = new WeatherChangeDisplayStore();

  constructor(
    private readonly standbyItemsProvider?: () => ActiveStandbyCardV1[],
    promotions?: WeatherPromotionStore,
    quakeExtreme?: QuakeExtremeStore,
    private readonly recentQuakesProvider?: () => DisplayRecentQuakeV1[],
    private readonly weatherAlertsProvider?: () => DisplayWeatherAlertV1[],
  ) {
    this.promotions = promotions ?? new WeatherPromotionStore();
    this.quakeExtreme = quakeExtreme ?? new QuakeExtremeStore();
  }

  /**
   * tsunamiObservations: hub が PresentationEvent.tsunamiObservations をそのまま渡す (Phase 2)。
   * VTSE51/52 (津波情報・沖合観測) は Forecast を持たない (or 持っていても本体の真実源にしない)
   * ため projectEmergency が emergency を組めず DTO からは失われる。protocol 型を変えずに
   * 観測データだけを橋渡しするための server-internal な経路 (wire プロトコルには載らない)。
   */
  applyEvent(
    dto: DisplayEventDtoV1,
    nowMs: number,
    tsunamiObservations?: DisplayTsunamiObservationV1[] | null,
    quakeMapCommand?: DisplayQuakeMapCommandV1 | null,
    tsunamiObservationGroups?: DisplayTsunamiObservationGroups | null,
    presentationEvent?: PresentationEvent,
  ): boolean {
    let changed = presentationEvent == null
      ? false
      : this.weatherChanges.apply(presentationEvent, nowMs);
    changed = this.quakeExtreme.applyDto(dto, nowMs) || changed;
    const quakeObservationBridge = quakeObservationBridgeOf(dto);
    const quakeMapMutation = quakeMapCommand == null
      ? { accepted: true, changed: false, preservation: "none" as const }
      : this.applyQuakeMapCommand(quakeMapCommand, nowMs);
    changed = quakeMapMutation.changed || changed;
    const quakeProjection = quakeObservationBridge?.latest ?? null;
    const quakeMeta = quakeProjection == null ? null : quakeObservationMetaOf(quakeProjection);
    const retainsKnownSafety = quakeMeta != null
      && !hasResolvedQuakeCancellation(quakeMeta)
      && shouldRetainKnownQuakeSafety(quakeMeta.maxIntValue);
    if (
      quakeMapMutation.accepted
      && quakeProjection?.eventId != null
      && quakeProjection.eventId.trim() !== ""
      && quakeMeta != null
      && !retainsKnownSafety
      && (
        hasResolvedQuakeCancellation(quakeMeta)
        || !quakeMeta.intensityStructureMissing
        || quakeMapMutation.preservation !== "structuralMissing"
      )
    ) {
      changed = this.largeQuakes.delete(quakeProjection.eventId) || changed;
    }
    if (
      quakeMapMutation.accepted
      && quakeMapMutation.preservation === "structuralMissing"
      && quakeProjection?.eventId != null
      && quakeProjection.eventId.trim() !== ""
    ) {
      const existing = this.largeQuakes.get(quakeProjection.eventId);
      const eventKey = quakeMapCommand?.kind === "remove" ? quakeMapCommand.eventKey : null;
      const effectiveMap = eventKey == null ? null : this.effectiveQuakeMapEvent(eventKey);
      if (existing != null) {
        this.largeQuakes.set(quakeProjection.eventId, {
          ...existing,
          originTime: quakeProjection.originTime,
          hypocenterName: quakeProjection.hypocenterName,
          magnitude: quakeProjection.magnitude,
          magnitudeSemantic: quakeProjection.magnitudeSemantic,
          depth: quakeProjection.depth,
          depthSemantic: quakeProjection.depthSemantic,
          reportDateTime: quakeProjection.reportDateTime,
          tsunamiWarning: quakeProjection.tsunamiWarning,
          updatedAtMs: nowMs,
          ...(effectiveMap == null
            ? {}
            : {
                mapEventKey: effectiveMap.eventKey,
                mapSourceType: effectiveMap.sourceType,
                mapRevision: effectiveMap.revision,
              }),
        });
        changed = true;
      }
    }
    if (
      quakeMapMutation.accepted
      && quakeMapMutation.preservation === "knownEmergencyUnknown"
      && quakeMapCommand?.kind === "upsert"
    ) {
      const eventId = quakeProjection?.eventId ?? quakeMapCommand.event.eventId;
      const effectiveMap = this.effectiveQuakeMapEvent(quakeMapCommand.event.eventKey);
      if (eventId != null && eventId.trim() !== "") {
        const existing = this.largeQuakes.get(eventId);
        if (existing != null && effectiveMap != null) {
          const details = quakeProjection ?? quakeMapCommand.event;
          this.largeQuakes.set(eventId, {
            ...existing,
            originTime: details.originTime,
            hypocenterName: details.hypocenterName,
            magnitude: details.magnitude,
            magnitudeSemantic: details.magnitudeSemantic,
            depth: details.depth,
            depthSemantic: details.depthSemantic,
            reportDateTime: details.reportDateTime,
            tsunamiWarning: details.tsunamiWarning,
            mapEventKey: effectiveMap.eventKey,
            mapSourceType: effectiveMap.sourceType,
            mapRevision: effectiveMap.revision,
          });
          changed = true;
        }
      }
    }
    if (dto.emergency?.kind === "eew") {
      changed = this.applyEew(dto.emergency, nowMs) || changed;
    }
    if (dto.domain === "tsunami") {
      const wireObservations = tsunamiObservations == null
        ? undefined
        : projectDisplayTsunamiObservations(tsunamiObservations);
      const wireObservationGroups = tsunamiObservationGroups == null
        ? undefined
        : {
            VTSE51: projectDisplayTsunamiObservations(tsunamiObservationGroups.VTSE51),
            VTSE52: projectDisplayTsunamiObservations(tsunamiObservationGroups.VTSE52),
          };
      changed = this.applyTsunami(
        dto,
        nowMs,
        wireObservations,
        wireObservationGroups,
      ) || changed;
    }
    if (dto.emergency?.kind === "largeQuake" && quakeMapMutation.accepted) {
      const key = dto.emergency.eventId ?? dto.id;
      const existing = this.largeQuakes.get(key);
      const preservesStrongerEmergency =
        retainsKnownSafety
        && existing != null
        && quakeCardRank(existing) > quakeCardRank(dto.emergency);
      if (!preservesStrongerEmergency) {
        const preservedMapReference =
          quakeMapCommand == null && existing?.mapEventKey != null
            ? {
                mapEventKey: existing.mapEventKey,
                mapSourceType: existing.mapSourceType,
                mapRevision: existing.mapRevision,
              }
            : {};
        this.largeQuakes.set(key, {
          ...dto.emergency,
          ...preservedMapReference,
          updatedAtMs: nowMs,
        });
        changed = true;
      }
      changed = this.clearUnknownQuakeMapHost() || changed;
    }
    const recentQuake = quakeObservationBridge == null
      ? dto.recentQuake
      : quakeObservationBridge.recent;
    if (recentQuake != null && this.recentQuakesProvider == null) {
      changed = this.applyRecentQuake(recentQuake, nowMs) || changed;
    }
    const latestQuake = quakeObservationBridge == null
      ? dto.latestQuake
      : quakeObservationBridge.latest;
    if (latestQuake != null) {
      changed = this.applyLatestQuake(latestQuake, nowMs) || changed;
      changed = this.restoreLargeQuakeFromLatest(latestQuake, nowMs) || changed;
    }
    changed = this.pruneUnreferencedQuakeMapEvents() || changed;
    return changed;
  }

  private applyQuakeMapCommand(
    command: DisplayQuakeMapCommandV1,
    nowMs: number,
  ): QuakeMapMutationResult {
    const eventKey = command.kind === "upsert" ? command.event.eventKey : command.eventKey;
    const guardKey = `${eventKey}:${command.sourceType}`;
    if (!this.quakeMapRevisionGuard.accept(
      guardKey,
      command.revision,
      nowMs,
      undefined,
      command.isCorrection === true,
    )) {
      return { accepted: false, changed: false, preservation: "none" };
    }

    const previousEffective = this.effectiveQuakeMapEvent(eventKey);
    const preservedStructuralObservation = command.kind === "remove"
      && command.reason === "structuralMissing"
      && previousEffective != null
      && shouldPreserveVxse51Observation({
        previousObservationSourceType: previousEffective.sourceType,
        previousMaxIntPresence: "value",
        previousCancellationResolved: false,
        nextSourceType: command.sourceType,
        nextMaxIntPresence: "missing",
        nextIntensityStructureMissing: true,
        nextCancellationResolved: false,
      });
    const preservedKnownEmergency = command.kind === "upsert"
      && isUnknownQuakeMapEvent({ ...command.event, sourceType: command.sourceType, revision: command.revision })
      && previousEffective != null
      && quakeMapSafetyLowerRank(previousEffective) >= TIER_QUAKE_ALERT_RANK
      && this.largeQuakeReferencesMapEvent(previousEffective);
    const preservation = preservedStructuralObservation
      ? "structuralMissing"
      : preservedKnownEmergency
        ? "knownEmergencyUnknown"
        : "none";
    let changed = false;
    if (command.kind === "upsert" && !preservedKnownEmergency) {
      const bySource = this.quakeMapContributions.get(eventKey) ?? new Map();
      bySource.set(command.sourceType, {
        ...command.event,
        sourceType: command.sourceType,
        revision: { ...command.revision },
      });
      this.quakeMapContributions.set(eventKey, bySource);
      changed = true;
    } else if (preservedKnownEmergency && previousEffective != null && command.kind === "upsert") {
      const bySource = this.quakeMapContributions.get(eventKey) ?? new Map();
      bySource.set(previousEffective.sourceType, {
        ...previousEffective,
        eventId: command.event.eventId,
        reportDateTime: command.event.reportDateTime,
        originTime: command.event.originTime,
        hypocenterName: command.event.hypocenterName,
        depth: command.event.depth,
        depthSemantic: command.event.depthSemantic,
        magnitude: command.event.magnitude,
        magnitudeSemantic: command.event.magnitudeSemantic,
        tsunamiWarning: command.event.tsunamiWarning,
        revision: { ...command.revision },
      });
      this.quakeMapContributions.set(eventKey, bySource);
      changed = true;
    } else if (
      command.kind === "remove"
      && preservedStructuralObservation
      && command.eventUpdate != null
      && previousEffective != null
    ) {
      const bySource = this.quakeMapContributions.get(eventKey) ?? new Map();
      bySource.set(command.sourceType, {
        ...previousEffective,
        ...command.eventUpdate,
        sourceType: previousEffective.sourceType,
        revision: { ...command.revision },
      });
      this.quakeMapContributions.set(eventKey, bySource);
      changed = true;
    } else if (preservation === "none") {
      // EventID 単位の後続状態は旧 type contribution 全体を置換する。
      // 取消・非 exact・閾値未満のいずれも sourceType 一件だけを残してはならない。
      changed = this.quakeMapContributions.delete(eventKey) || changed;
    }

    const effective = this.effectiveQuakeMapEvent(eventKey);
    const effectiveChanged =
      previousEffective?.sourceType !== effective?.sourceType
      || !sameRevision(previousEffective?.revision, effective?.revision);
    if (
      effectiveChanged
      && effective != null
      && quakeMapSafetyLowerRank(effective) >= QUAKE_MAP_HOST_MIN_RANK
      && quakeMapSafetyLowerRank(effective) < TIER_QUAKE_ALERT_RANK
    ) {
      const nextHost = { eventKey, expiresAtMs: nowMs + NON_EMERGENCY_HOST_TTL_MS };
      if (
        this.quakeMapHost?.eventKey !== nextHost.eventKey
        || this.quakeMapHost.expiresAtMs !== nextHost.expiresAtMs
      ) {
        this.quakeMapHost = nextHost;
        changed = true;
      }
      changed = this.clearUnknownQuakeMapHost() || changed;
    } else if (this.quakeMapHost?.eventKey === eventKey) {
      if (
        effective == null
        || quakeMapSafetyLowerRank(effective) < QUAKE_MAP_HOST_MIN_RANK
        || quakeMapSafetyLowerRank(effective) >= TIER_QUAKE_ALERT_RANK
      ) {
        this.quakeMapHost = null;
        changed = true;
      }
    }
    if (effectiveChanged && effective != null && isUnknownQuakeMapEvent(effective)) {
      if (!this.hasActiveKnownQuakeMapHost(nowMs) && !this.hasLargeQuakeMapReference()) {
        const nextHost = { eventKey, expiresAtMs: nowMs + NON_EMERGENCY_HOST_TTL_MS };
        if (
          this.unknownQuakeMapHost?.eventKey !== nextHost.eventKey
          || this.unknownQuakeMapHost.expiresAtMs !== nextHost.expiresAtMs
        ) {
          this.unknownQuakeMapHost = nextHost;
          changed = true;
        }
      }
    } else if (
      this.unknownQuakeMapHost?.eventKey === eventKey
      && (effective == null || !isUnknownQuakeMapEvent(effective))
    ) {
      changed = this.clearUnknownQuakeMapHost() || changed;
    }
    return { accepted: true, changed, preservation };
  }

  private hasActiveKnownQuakeMapHost(nowMs: number): boolean {
    return this.quakeMapHost != null
      && nowMs < this.quakeMapHost.expiresAtMs
      && this.effectiveQuakeMapEvent(this.quakeMapHost.eventKey) != null;
  }

  private hasLargeQuakeMapReference(): boolean {
    return [...this.largeQuakes.values()].some((quake) => quake.mapEventKey != null);
  }

  private clearUnknownQuakeMapHost(): boolean {
    if (this.unknownQuakeMapHost == null) return false;
    this.unknownQuakeMapHost = null;
    return true;
  }

  private effectiveQuakeMapEvent(eventKey: string): DisplayQuakeIntensityMapEventV1 | null {
    const contributions = [...(this.quakeMapContributions.get(eventKey)?.values() ?? [])];
    contributions.sort((a, b) => {
      if (a.revision.reportTimeMs !== b.revision.reportTimeMs) {
        return b.revision.reportTimeMs - a.revision.reportTimeMs;
      }
      return a.sourceType.localeCompare(b.sourceType);
    });
    return contributions[0] ?? null;
  }

  private effectiveQuakeMapEvents(): DisplayQuakeIntensityMapEventV1[] {
    const events: DisplayQuakeIntensityMapEventV1[] = [];
    for (const eventKey of this.quakeMapContributions.keys()) {
      const effective = this.effectiveQuakeMapEvent(eventKey);
      if (effective != null) events.push(effective);
    }
    return events.sort((a, b) =>
      b.updatedAtMs - a.updatedAtMs || a.eventKey.localeCompare(b.eventKey));
  }

  private largeQuakeReferencesMapEvent(event: DisplayQuakeIntensityMapEventV1): boolean {
    return [...this.largeQuakes.values()].some((quake) =>
      quake.mapEventKey === event.eventKey
      && quake.mapSourceType === event.sourceType
      && sameRevision(quake.mapRevision, event.revision));
  }

  private pruneUnreferencedQuakeMapEvents(): boolean {
    let changed = false;
    for (const eventKey of [...this.quakeMapContributions.keys()]) {
      if (this.quakeMapHost?.eventKey === eventKey) continue;
      if (this.unknownQuakeMapHost?.eventKey === eventKey) continue;
      const effective = this.effectiveQuakeMapEvent(eventKey);
      if (effective != null && this.largeQuakeReferencesMapEvent(effective)) continue;
      this.quakeMapContributions.delete(eventKey);
      changed = true;
    }
    return changed;
  }

  private applyEew(input: DisplayEewInputV1, nowMs: number): boolean {
    const eventId = input.eventId;
    if (eventId == null) return false;
    const existing = this.activeEews.get(eventId);
    const sourceType = input.sourceType?.trim() || null;
    const restoreRevision = input.restoreRevision;
    if (restoreRevision != null) {
      const restoreSourceType = restoreRevision.sourceType.trim();
      if (
        sourceType == null
        || restoreSourceType !== "VXSE44"
        || restoreRevision.serial == null
        || restoreRevision.serial.trim() === ""
        || input.isCancellation
        || input.isFinal
      ) return false;
      const restoreKey = JSON.stringify([eventId, restoreSourceType]);
      const previousRestore = this.eewSourceRevisions.get(restoreKey);
      if (previousRestore != null) {
        const cmp = compareSerial(restoreRevision.serial, previousRestore.serial);
        if (cmp < 0) return false;
        if (cmp === 0 && !restoreRevision.isCorrection) return false;
      }
      // Card 本体の authoritative snapshot とは分け、終端を撤回した family の
      // revision を watermark として前進させる。fail-open VXSE44 owner の同 family
      // 復元でも、これにより後着した旧終端を拒否できる。
      this.eewSourceRevisions.set(restoreKey, {
        eventId,
        serial: restoreRevision.serial,
        updatedAtMs: nowMs,
      });
      this.activeEews.set(eventId, { ...input, sourceType, updatedAtMs: nowMs });
      return true;
    }
    if (sourceType != null) {
      const revisionKey = JSON.stringify([eventId, sourceType]);
      const sourceRevision = this.eewSourceRevisions.get(revisionKey);
      const comparableExisting = sourceRevision == null
        && (existing?.sourceType == null || existing.sourceType === sourceType)
        ? existing
        : null;
      const previousSerial = sourceRevision?.serial ?? comparableExisting?.serial;
      if (previousSerial !== undefined) {
        const cmp = compareSerial(input.serial, previousSerial);
        if (cmp < 0) return false;
        if (
          cmp === 0
          && !input.isFinal
          && !input.isCancellation
          && input.isCorrection !== true
        ) return false;
      }
      this.eewSourceRevisions.set(revisionKey, {
        eventId,
        serial: input.serial,
        updatedAtMs: nowMs,
      });
      if (input.isCancellation || input.isFinal && sourceType === "VXSE44") {
        this.activeEews.delete(eventId);
        // 抑止された VXSE44 終端 outcome は card を作らず解除 command として扱う。
        // active がなくても accepted tombstone の生成を mutation として扱う。
        return true;
      }
      this.activeEews.set(eventId, { ...input, sourceType, updatedAtMs: nowMs });
      return true;
    }

    // sourceType 欠落の旧 V1 DTO は従来の EventID 全体 serial gate へ fallback する。
    if (input.isCancellation) {
      // 遅延到着した古い serial の取消が新しい続報を消さないようガードする (続報の巻き戻し防止と同方針)
      if (existing != null && compareSerial(input.serial, existing.serial) < 0) return false;
      return this.activeEews.delete(eventId);
    }
    if (existing != null) {
      const cmp = compareSerial(input.serial, existing.serial);
      if (cmp < 0) return false; // 古い報は final でも無視 (遅延到着の最終報が新しい続報を巻き戻さない)
      if (cmp === 0 && !input.isFinal && input.isCorrection !== true) return false; // 同報の再送
    }
    this.activeEews.set(eventId, { ...input, updatedAtMs: nowMs });
    return true;
  }

  private applyTsunami(
    dto: DisplayEventDtoV1,
    nowMs: number,
    observations: DisplayTsunamiObservationV1[] | undefined,
    observationGroups: DisplayTsunamiObservationGroups | undefined,
  ): boolean {
    // VTSE51/52 (津波情報・沖合観測): レベル・coasts の真実源にはしない (旧仕様のまま)。
    // 観測 family は警報より先に来ても保持するが、観測単独では表示 state を新規作成せず
    // updatedAtMs にも触れない。VTSE41 受理時に保持済み観測を合流する。
    if (dto.type === "VTSE51" || dto.type === "VTSE52") {
      if (dto.infoType === "取消") {
        const changed = this.tsunamiObservationGroups[dto.type].length > 0;
        this.tsunamiObservationGroups[dto.type] = [];
        if (this.tsunami != null && changed) {
          this.tsunami = {
            ...this.tsunami,
            observations: this.allTsunamiObservations(),
          };
          return true;
        }
        return false;
      }
      if (observations == null || observations.length === 0) return false;
      const merged = mergeTsunamiObservationGroup(
        this.tsunamiObservationGroups[dto.type],
        observations,
      );
      this.tsunamiObservationGroups[dto.type] = merged;
      if (this.tsunami == null) return false;
      this.tsunami = { ...this.tsunami, observations: this.allTsunamiObservations() };
      return true;
    }
    // 津波状態の真実源は VTSE41 (津波警報・注意報・予報) のみ。
    // 本体の TsunamiStateHolder mutation が VTSE41 限定 (process-tsunami.ts) なのと整合させる
    if (dto.type !== "VTSE41") return false;
    if (dto.emergency?.kind === "tsunami") {
      if (observationGroups != null) {
        const pendingWithoutCode = {
          VTSE51: this.tsunamiObservationGroups.VTSE51.filter(
            (observation) => !observation.stationCode?.trim(),
          ),
          VTSE52: this.tsunamiObservationGroups.VTSE52.filter(
            (observation) => !observation.stationCode?.trim(),
          ),
        };
        this.tsunamiObservationGroups = {
          VTSE51: mergeTsunamiObservationGroup(
            pendingWithoutCode.VTSE51,
            structuredClone(observationGroups.VTSE51),
          ),
          VTSE52: mergeTsunamiObservationGroup(
            pendingWithoutCode.VTSE52,
            structuredClone(observationGroups.VTSE52),
          ),
        };
      }
      this.tsunami = {
        ...dto.emergency,
        observations: this.allTsunamiObservations(),
        updatedAtMs: nowMs,
      };
      return true;
    }
    // VTSE41 で emergency が組めない = 取消 or 全解除
    if (this.tsunami != null) {
      this.tsunami = null;
      this.clearTsunamiObservations();
      return true;
    }
    this.clearTsunamiObservations();
    return false;
  }

  private allTsunamiObservations(): DisplayTsunamiObservationV1[] {
    return [
      ...this.tsunamiObservationGroups.VTSE51,
      ...this.tsunamiObservationGroups.VTSE52,
    ];
  }

  private clearTsunamiObservations(): void {
    this.tsunamiObservationGroups = { VTSE51: [], VTSE52: [] };
  }

  private applyRecentQuake(q: DisplayRecentQuakeV1, nowMs: number): boolean {
    const existing = q.eventId == null
      ? null
      : this.recentQuakes.find((candidate) => candidate.eventId === q.eventId);
    const meta = quakeObservationMetaOf(q);
    // markCancelled は履歴 record を消さず、active projection だけを解除する (§5.5)。
    if (meta != null && hasResolvedQuakeCancellation(meta) && existing == null) return false;
    // 「今日」は暦日 JST。時刻が壊れている電文は表示を捏造せず除外する。
    if (quakeDayKey(q) !== jstDayKey(nowMs)) return false;
    const merged = mergeRecentQuakeObservation(existing, q);
    if (q.eventId != null) {
      this.recentQuakes = this.recentQuakes.filter((r) => r.eventId !== q.eventId);
    }
    this.recentQuakes.unshift(merged);
    if (this.recentQuakes.length > RECENT_QUAKES_MAX) this.recentQuakes.length = RECENT_QUAKES_MAX;
    return true;
  }

  private applyLatestQuake(input: DisplayLatestQuakeInputV1, nowMs: number): boolean {
    const existing = this.latestQuake ?? this.restoredLatestBaseline(input);
    const meta = quakeObservationMetaOf(input);
    if (meta != null && hasResolvedQuakeCancellation(meta)) {
      if (
        existing == null
        || input.eventId == null
        || input.eventId.trim() === ""
        || existing.eventId !== input.eventId
      ) return false;
      this.latestQuake = null;
      return true;
    }
    if (!shouldReplaceLatestQuake(existing, input)) return false;
    this.latestQuake = { ...mergeLatestQuakeObservation(existing, input), updatedAtMs: nowMs };
    return true;
  }

  /**
   * display off／再起動中の daily 履歴は snapshot の recent だけを所有する。起動直後に
   * latest を見せ直すことはせず、§7.4 の structural-missing 続報を受けた時だけ、同じ
   * EventID の復元済み recent を merge の基準として借りる。
   */
  private restoredLatestBaseline(input: DisplayLatestQuakeInputV1): DisplayLatestQuakeStateV1 | null {
    if (this.recentQuakesProvider == null || input.eventId == null || input.eventId.trim() === "") {
      return null;
    }
    const inputMeta = quakeObservationMetaOf(input);
    const recent = this.recentQuakesProvider().find((quake) => quake.eventId === input.eventId);
    const recentMeta = recent == null ? null : quakeObservationMetaOf(recent);
    if (
      inputMeta == null
      || recent == null
      || recentMeta == null
      || !shouldPreserveVxse51Observation({
        previousObservationSourceType: recentMeta.observationSourceType,
        previousMaxIntPresence: recentMeta.maxIntValue.presence,
        previousCancellationResolved: hasResolvedQuakeCancellation(recentMeta),
        nextSourceType: inputMeta.sourceType,
        nextMaxIntPresence: inputMeta.maxIntValue.presence,
        nextIntensityStructureMissing: inputMeta.intensityStructureMissing,
        nextCancellationResolved: hasResolvedQuakeCancellation(inputMeta),
      })
    ) return null;
    return withQuakeObservationMeta({
      eventId: recent.eventId,
      headline: null,
      originTime: recent.originTime,
      hypocenterName: recent.hypocenterName,
      depth: recent.depth,
      depthSemantic: recent.depthSemantic,
      magnitude: recent.magnitude,
      magnitudeSemantic: recent.magnitudeSemantic,
      maxInt: recent.maxInt,
      maxIntRank: recent.maxIntRank,
      maxIntSemantic: recent.maxIntSemantic,
      tsunamiWarning: recent.tsunamiWarning,
      intensityGroups: recent.intensityGroups ?? [],
      reportDateTime: recent.reportDateTime,
      updatedAtMs: 0,
    }, recentMeta);
  }

  /** restoredLatestBaseline で初めて復元された latest と同じ震度を emergency にも揃える。 */
  private restoreLargeQuakeFromLatest(input: DisplayLatestQuakeInputV1, nowMs: number): boolean {
    if (
      this.recentQuakesProvider == null
      || input.eventId == null
      || input.eventId.trim() === ""
      || this.largeQuakes.has(input.eventId)
      || this.latestQuake == null
      || this.latestQuake.eventId !== input.eventId
      || quakeCardRank(this.latestQuake) < TIER_QUAKE_ALERT_RANK
      || this.restoredLatestBaseline(input) == null
    ) return false;
    const latest = this.latestQuake;
    if (latest.maxInt == null || latest.maxIntRank == null) return false;
    this.largeQuakes.set(input.eventId, {
      kind: "largeQuake",
      eventId: latest.eventId,
      originTime: latest.originTime,
      hypocenterName: latest.hypocenterName,
      magnitude: latest.magnitude,
      magnitudeSemantic: latest.magnitudeSemantic,
      maxInt: latest.maxInt,
      maxIntRank: latest.maxIntRank,
      maxIntSemantic: latest.maxIntSemantic,
      intensityGroups: latest.intensityGroups,
      reportDateTime: latest.reportDateTime,
      depth: latest.depth,
      depthSemantic: latest.depthSemantic,
      maxLgInt: null,
      tsunamiWarning: latest.tsunamiWarning,
      updatedAtMs: nowMs,
    });
    return true;
  }

  sweep(nowMs: number, sweepWeatherPromotions = true): boolean {
    let changed = false;
    for (const [id, eew] of this.activeEews) {
      const ttlHit = nowMs - eew.updatedAtMs > EEW_TTL_MIN * MIN_MS;
      const finalHit = eew.isFinal && nowMs - eew.updatedAtMs > EEW_FINAL_HOLD_SEC * 1000;
      if (ttlHit || finalHit) { this.activeEews.delete(id); changed = true; }
    }
    for (const [key, revision] of this.eewSourceRevisions) {
      if (
        !this.activeEews.has(revision.eventId)
        && nowMs - revision.updatedAtMs >= EEW_TTL_MIN * MIN_MS
      ) {
        this.eewSourceRevisions.delete(key);
      }
    }
    for (const [id, q] of this.largeQuakes) {
      if (nowMs - q.updatedAtMs > LARGE_QUAKE_HOLD_MIN * MIN_MS) { this.largeQuakes.delete(id); changed = true; }
    }
    if (this.quakeMapHost != null && nowMs >= this.quakeMapHost.expiresAtMs) {
      this.quakeMapHost = null;
      changed = true;
    }
    if (this.unknownQuakeMapHost != null && nowMs >= this.unknownQuakeMapHost.expiresAtMs) {
      this.unknownQuakeMapHost = null;
      changed = true;
    }
    this.quakeMapRevisionGuard.sweep(nowMs);
    // SSE 無客中は気象点灯の時計だけを止める。他 domain の lifecycle は従来どおり進める
    if (sweepWeatherPromotions) {
      changed = this.promotions.sweepDemote(nowMs) || changed;
    }
    changed = this.weatherChanges.sweep(nowMs) || changed;
    if (this.recentQuakesProvider == null) {
      const today = jstDayKey(nowMs);
      const currentRecent = this.recentQuakes.filter((q) => quakeDayKey(q) === today);
      if (currentRecent.length !== this.recentQuakes.length) {
        this.recentQuakes = currentRecent;
        changed = true;
      }
    }
    changed = this.quakeExtreme.sweep(nowMs) || changed;
    if (this.latestQuake != null &&
        nowMs - this.latestQuake.updatedAtMs > quakeCardTtlMs(quakeCardRank(this.latestQuake))) {
      this.latestQuake = null;
      changed = true;
    }
    changed = this.pruneUnreferencedQuakeMapEvents() || changed;
    return changed;
  }

  setConnection(patch: Partial<DisplayConnectionStateV1>, nowMs: number): void {
    const next = { ...this.connection, ...patch };
    if (patch.dmdata === "disconnected" && this.connection.dmdata !== "disconnected") {
      next.disconnectedSince = new Date(nowMs).toISOString();
    }
    if (patch.dmdata === "connected") {
      next.disconnectedSince = null;
      next.reason = null;
    }
    this.connection = next;
  }

  seedTsunami(
    input: DisplayTsunamiInputV1,
    nowMs: number,
    observationGroups?: DisplayTsunamiObservationGroups,
  ): void {
    const wireInputObservations = projectDisplayTsunamiObservations(input.observations);
    const wireObservationGroups = observationGroups == null
      ? null
      : {
          VTSE51: projectDisplayTsunamiObservations(observationGroups.VTSE51),
          VTSE52: projectDisplayTsunamiObservations(observationGroups.VTSE52),
        };
    this.tsunamiObservationGroups = wireObservationGroups == null
      ? {
          VTSE51: wireInputObservations.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY),
          VTSE52: [],
        }
      : {
          VTSE51: wireObservationGroups.VTSE51
            .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY),
          VTSE52: wireObservationGroups.VTSE52
            .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY),
        };
    this.tsunami = {
      ...input,
      observations: this.allTsunamiObservations(),
      updatedAtMs: nowMs,
    };
  }

  seedWeatherAlerts(alerts: DisplayWeatherAlertV1[]): void {
    this.weatherAlerts = [...alerts];
  }

  /**
   * 1 source 分の気象カード view から昇格状態を更新する。source は完全に独立で、
   * 呼ばれなかった source の record には一切触れない。
   * nowMs は engine 受理時刻 — 電文の updatedAt / reportDateTime は判定に使わない。
   *
   * **production の受理経路はここではない**。実際の更新は monitor の displaySink
   * (`weather-promotion-ingest.ts`) が行う。現在の呼び出し元はテストのみで、lifecycle を
   * 直接回す窓口として意図的に残している。
   * **hub からは呼ばないこと** — hub 経由にすると `display off` の間だけ新規昇格・続報・
   * 解除がすべて失われる (受理の事実は display の on/off と無関係)。
   */
  applyWeatherSource(
    source: DisplayWeatherSourceV1,
    view: Vpws50CurrentAreasForDisplay | undefined,
    nowMs: number,
  ): boolean {
    return this.promotions.apply(source, view, nowMs);
  }

  /** 永続化用の lifecycle 一式 (promotedAtMs / state / generation / watermark)。 */
  exportWeatherPromotions(): WeatherPromotionPersistedV1 {
    return this.promotions.export();
  }

  /** 起動時復元の入口。経過済み・未来時刻の判定は WeatherPromotionStore が行う */
  restoreWeatherPromotions(state: WeatherPromotionPersistedV1, nowMs: number): void {
    this.promotions.restore(state, nowMs);
  }

  /** display runtime 起動時の経過判定 (`display off` 中に降格 sweep が止まっていた分を反映) */
  resumeWeatherPromotions(nowMs: number): boolean {
    return this.promotions.resume(nowMs);
  }

  private currentWeatherSnapshot(): {
    alerts: DisplayWeatherAlertV1[];
    expandedKinds: DisplayWeatherExpandedKindV1[];
  } {
    const provided = this.weatherAlertsProvider?.();
    const alerts = provided ?? this.weatherAlerts;
    const suppliedExpandedKinds = provided == null
      ? undefined
      : (provided as WeatherAlertsSnapshotV1)[WEATHER_EXPANDED_KINDS];
    return {
      alerts,
      expandedKinds: copyWeatherExpandedKinds(
        suppliedExpandedKinds ?? collectWeatherExpandedKinds(alerts),
      ),
    };
  }

  private currentWeatherAlerts(): DisplayWeatherAlertV1[] {
    return this.currentWeatherSnapshot().alerts;
  }

  sweepWeatherPromotions(nowMs: number): boolean {
    return this.promotions.sweepDemote(nowMs);
  }

  beginWeatherPromotionUnseenPeriod(nowMs: number): boolean {
    return this.promotions.beginUnseenPeriod(nowMs);
  }

  clearWeatherPromotionUnseenPeriod(): boolean {
    return this.promotions.clearUnseenPeriod();
  }

  endWeatherPromotionUnseenPeriod(unseenDurationMs: number, nowMs: number): boolean {
    return this.promotions.endUnseenPeriod(unseenDurationMs, nowMs);
  }

  /** hub が publishStats 経路で現在値を流し込む。snapshot に載せるだけ (dirty 判定は hub 側) */
  setStats(stats: DisplayStatsV1): void {
    this.stats = stats;
  }

  private deriveSeverityTier(nowMs: number): DisplaySeverityTier {
    let tier: DisplaySeverityTier = "calm";
    const bump = (t: DisplaySeverityTier): void => { if (TIER_ORDER[t] > TIER_ORDER[tier]) tier = t; };
    if (this.tsunami != null) {
      if (this.tsunami.level === "majorWarning") bump("critical");
      else if (this.tsunami.level === "warning") bump("alert");
      else bump("caution");
    }
    // 昇格中の気象警報は L5 相当 = critical / L4 相当 = alert。画面上の降格後も、
    // パネル降格 (demoted) 後も警報解除 (record 削除) まで tier を維持する
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const rec = this.promotions.get(source);
      if (rec != null) bump(rec.level === 5 ? "critical" : "alert");
    }
    for (const eew of this.activeEews.values()) bump(eew.isWarning ? "alert" : "caution");
    for (const q of this.largeQuakes.values()) if (quakeCardRank(q) >= TIER_QUAKE_ALERT_RANK) bump("alert");
    if (this.latestQuake != null && quakeCardRank(this.latestQuake) >= TIER_QUAKE_ALERT_RANK) bump("alert");
    if (this.quakeMapHost != null && nowMs < this.quakeMapHost.expiresAtMs) bump("caution");
    for (const item of this.standbyItemsProvider?.() ?? []) {
      if (item.kind === "nankaiTrough" && item.severity === "critical") bump("caution");
      else if (item.severity === "critical") bump("alert");
    }
    return tier;
  }

  private deriveBackgroundTone(nowMs: number): DisplayBackgroundTone {
    if (this.quakeExtreme.hasActive(nowMs)) return "quakeExtreme";
    switch (this.deriveSeverityTier(nowMs)) {
      case "critical": return "critical";
      case "alert": return "alert";
      case "caution": return "caution";
      case "calm": return "calm";
    }
  }

  /** 現在 active な警報の groupKey 集合 (spec §3-2、初期スコープ = EEW/津波)。 */
  activeAlertKeys(): Set<string> {
    const keys = new Set<string>();
    for (const id of this.activeEews.keys()) keys.add(`eew:${id}`);
    if (this.tsunami != null) keys.add("tsunami:current");
    // 主役パネルに出ている間だけ気象テロップを保護する。demoted を含めると降格後も
    // 気象テロップが TTL を無視して残り続けるため active のみ。
    // VPWS50 のテロップ groupKey は "weather:vpws50" (project-event.ts) と完全一致する。
    // VPWW56 は官署別 groupKey のためここでは列挙できず、activeAlertKeyPrefixes 側で扱う
    if (this.promotions.get("vpws50")?.state === "active") keys.add("weather:vpws50");
    return keys;
  }

  /**
   * 完全一致では表せない active な groupKey の接頭辞集合。
   * VPWW56 のテロップ groupKey は `weather:VPWW56:${publishingOffice}` と官署別に分かれる
   * (project-event.ts) 一方、昇格状態は Vpww56StateHolder が全官署を union した view に対して
   * 1 つだけ持つため、保護すべきキーを列挙できない。昇格中は VPWW56 のテロップをまとめて
   * 保護する (union が L4/L5 相当を含む間だけ。既に解除された官署のテロップも巻き込むが、
   * recentTicker は受信済み電文の履歴であって現況表示ではないため保護側に倒す)。
   */
  activeAlertKeyPrefixes(): Set<string> {
    const prefixes = new Set<string>();
    if (this.promotions.get("vpww56")?.state === "active") prefixes.add("weather:VPWW56:");
    return prefixes;
  }

  /** demoted は null へ投影する (フロントに期限計算をさせない) */
  private weatherPromotionForWire(
    currentAlerts: readonly DisplayWeatherAlertV1[] = this.currentWeatherAlerts(),
  ): DisplayWeatherPromotionV1 {
    return {
      vpws50: this.promotionEntryForWire("vpws50", currentAlerts),
      vpww56: this.promotionEntryForWire("vpww56", currentAlerts),
      // パネル全体の点灯キー。**source の降格・解除では動かない** watermark
      activationKey: `${this.promotions.activationWatermark()}`,
    };
  }

  /**
   * live な weatherAlerts に当該 source があれば、そちらが権威なので控え (restoredItems) は載せない。
   * 控えを載せるのは「昇格しているのにカードが空」の窓 (再起動直後・display on 直後) だけ。
   * 定常運転では snapshot に同じ内容を二重に積まないので、バイト上限にも効かない。
   */
  private promotionEntryForWire(
    source: DisplayWeatherSourceV1,
    currentAlerts: readonly DisplayWeatherAlertV1[] = this.currentWeatherAlerts(),
  ): DisplayWeatherPromotionEntryV1 | null {
    const entry = promotionEntry(this.promotions.get(source));
    if (entry == null) return null;
    if (currentAlerts.some((a) => a.source === source)) return entry;
    const items = this.promotions.get(source)?.items ?? [];
    return items.length === 0 ? entry : { ...entry, restoredItems: items };
  }

  /** night-dim 用。demoted 後も警報解除 (record 削除) まで true */
  private isWeatherL5Active(): boolean {
    return WEATHER_PROMOTION_SOURCES.some((s) => this.promotions.get(s)?.level === 5);
  }

  snapshot(seq: number, nowMs: number): DisplayStateSnapshotV1 {
    const weatherSnapshot = this.currentWeatherSnapshot();
    return {
      version: DISPLAY_PROTOCOL_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      seq,
      activeEews: [...this.activeEews.values()],
      tsunami: this.tsunami,
      largeQuakes: [...this.largeQuakes.values()]
        .map(withWireIntensityCandidates)
        .map(withWireIntensitySemantic),
      weatherAlerts: [...weatherSnapshot.alerts],
      weatherChange: this.weatherChanges.snapshot(nowMs),
      weatherPromotion: this.weatherPromotionForWire(weatherSnapshot.alerts),
      weatherL5Active: this.isWeatherL5Active(),
      weatherExpandedKinds: weatherSnapshot.expandedKinds,
      recentQuakes: (this.recentQuakesProvider?.() ?? [...this.recentQuakes])
        .map(withWireIntensityCandidates)
        .map(withWireIntensitySemantic),
      latestQuake: this.latestQuake == null
        ? null
        : withWireIntensitySemantic(withWireIntensityCandidates(this.latestQuake)),
      stats: this.stats,
      severityTier: this.deriveSeverityTier(nowMs),
      backgroundTone: this.deriveBackgroundTone(nowMs),
      connection: { ...this.connection },
      recentTicker: [],
      standbyItems: this.standbyItemsProvider?.() ?? [],
      mapLayers: {
        quake: {
          events: this.effectiveQuakeMapEvents().map(withWireIntensityCandidates),
          nonEmergencyHost: this.quakeMapHost == null ? null : { ...this.quakeMapHost },
          ...(this.unknownQuakeMapHost == null ? {} : { unknownHost: { ...this.unknownQuakeMapHost } }),
        },
      },
    };
  }
}

function copyWeatherExpandedKinds(
  kinds: readonly DisplayWeatherExpandedKindV1[],
): DisplayWeatherExpandedKindV1[] {
  return kinds.map((kind) => ({
    ...kind,
    areas: [...kind.areas],
    areaCodes: kind.areaCodes == null ? undefined : [...kind.areaCodes],
  }));
}

interface WireIntensityGroups {
  intensityGroups?: DisplayIntensityGroupV1[];
}

/** 旧・永続化由来の quake DTO にも、新 wire の候補 prefix を snapshot 境界で補う。 */
function withWireIntensityCandidates<T extends WireIntensityGroups>(quake: T): T {
  if (quake.intensityGroups == null) return quake;
  const candidates = quake.intensityGroups.map((group) => {
    const allCurrentAreas = [...new Set(group.areas)];
    const currentAreaSet = new Set(allCurrentAreas);
    const candidateAreas = group.expandedAreas ?? allCurrentAreas;
    const uniqueCandidateAreas = [...new Set(candidateAreas)];
    const additionalAreas = uniqueCandidateAreas.filter((area) => !currentAreaSet.has(area));
    return {
      group,
      currentAreas: allCurrentAreas,
      additionalAreas,
      totalAreaCount: Math.max(
        allCurrentAreas.length + group.omittedAreaCount,
        uniqueCandidateAreas.length,
      ),
    };
  });
  const currentAreaTotal = candidates.reduce((total, candidate) =>
    total + candidate.currentAreas.length, 0);
  // 二段配分: 通常は全 group の現行表示分を予約してから追加候補へ残余を回す。
  // 現行表示だけで上限を超える旧 provider 入力は、発表順の現行表示を優先して安全弁を適用する。
  let remainingCurrent = 128;
  const reservedCurrentAreas = candidates.map(({ currentAreas }) => {
    if (currentAreaTotal <= 128) return currentAreas;
    const areas = currentAreas.slice(0, remainingCurrent);
    remainingCurrent -= areas.length;
    return areas;
  });
  let remaining = Math.max(
    0,
    128 - reservedCurrentAreas.reduce((total, areas) => total + areas.length, 0),
  );
  const intensityGroups = candidates.map(({ group, additionalAreas, totalAreaCount }, index) => {
    const currentAreas = reservedCurrentAreas[index]!;
    const additions = additionalAreas.slice(0, remaining);
    remaining -= additions.length;
    const expandedAreas = [...currentAreas, ...additions];
    return {
      ...group,
      expandedAreas,
      candidateTruncated: group.candidateTruncated === true
        || expandedAreas.length < totalAreaCount,
    };
  });
  return { ...quake, intensityGroups };
}

/** originTime を優先し、欠落時だけ reportDateTime を使う。無効な ISO は null。 */
type WireQuakeCard =
  | DisplayRecentQuakeV1
  | DisplayLatestQuakeInputV1
  | DisplayLatestQuakeStateV1
  | DisplayLargeQuakeStateV1;

function withWireIntensitySemantic<T extends WireQuakeCard>(quake: T): T {
  const meta = quakeObservationMetaOf(quake);
  if (meta == null) return quake;
  const semantic = projectEarthquakeIntensitySemantic(meta?.maxIntValue, quake.maxInt);
  const { maxIntSemantic: _staleSemantic, ...withoutSemantic } = quake;
  return semantic == null || semantic.presence === "value"
    ? withoutSemantic as T
    : { ...withoutSemantic, maxIntSemantic: semantic } as T;
}

export function quakeDayKey(q: DisplayRecentQuakeV1): string | null {
  const value = q.originTime ?? q.reportDateTime;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : jstDayKey(ms);
}

function compareSerial(a: string | null, b: string | null): number {
  const na = a == null ? Number.NaN : Number(a);
  const nb = b == null ? Number.NaN : Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return (a ?? "").localeCompare(b ?? "");
  return na - nb;
}
