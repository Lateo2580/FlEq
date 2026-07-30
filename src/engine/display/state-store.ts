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
  type DisplayWeatherPromotionEntryV1,
  type DisplayWeatherPromotionV1,
  type DisplayWeatherSourceV1,
} from "./types";
import type { Vpws50CurrentAreasForDisplay } from "../../types";
import { intensityToRank } from "../../utils/intensity";
import { jstDayKey } from "../../utils/jst-day-key";
import { quakeCardTtlMs, shouldReplaceLatestQuake } from "./quake-card-selection";
import { WEATHER_PROMOTION_SOURCES, type WeatherPromotionMemberV1 } from "./weather-promotion";
import {
  WeatherPromotionStore,
  type WeatherPromotionPersistedV1,
  type WeatherPromotionRecord,
} from "./weather-promotion-store";
import { QuakeExtremeStore } from "./quake-extreme-store";
import { RevisionGuard } from "./revision-guard";
import type { StandbyRevision } from "./standby-registry";

const MIN_MS = 60_000;
const NON_EMERGENCY_HOST_TTL_MS = 5 * MIN_MS;
const TIER_ORDER: Record<DisplaySeverityTier, number> = { calm: 0, caution: 1, alert: 2, critical: 3 };
const TIER_QUAKE_ALERT_RANK = intensityToRank("5弱");
const QUAKE_MAP_HOST_MIN_RANK = intensityToRank("3");

interface QuakeMapMutationResult {
  accepted: boolean;
  changed: boolean;
}

function sameRevision(a: StandbyRevision | undefined, b: StandbyRevision | undefined): boolean {
  return a != null && b != null && a.reportTimeMs === b.reportTimeMs && a.serial === b.serial;
}

function promotionEntry(record: WeatherPromotionRecord | null): DisplayWeatherPromotionEntryV1 | null {
  if (record == null || record.state !== "active") return null;
  const promotedAt = new Date(record.promotedAtMs).toISOString();
  return {
    level: record.level,
    promotedAt,
    generation: record.generation,
    trigger: record.trigger ?? undefined,
    // 安定キーで求めた追加地域を、wire では表示名 (種別 → 地域名) へ畳んで載せる
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
    if (entry == null) byKind.set(m.kind, { kind: m.kind, areas: [m.areaName] });
    else if (!entry.areas.includes(m.areaName)) entry.areas.push(m.areaName);
  }
  return [...byKind.values()];
}

// 現在の緊急状態 (EEW/津波/大地震/気象警報/接続) を合成する表示用ストア。
// 時刻は全メソッドで nowMs 注入 (クラス内で Date.now() を呼ばない)。
// applyEvent/sweep の boolean = 「state snapshot の再配信が必要な変化があったか」。
export class DisplayStateStore {
  private activeEews = new Map<string, DisplayActiveEewV1>();
  private tsunami: DisplayTsunamiStateV1 | null = null;
  private largeQuakes = new Map<string, DisplayLargeQuakeStateV1>();
  /** EventID 系列 × source type の最新 contribution。wire へは eventKey ごとの有効一件だけを出す。 */
  private quakeMapContributions =
    new Map<string, Map<string, DisplayQuakeIntensityMapEventV1>>();
  private quakeMapHost: { eventKey: string; expiresAtMs: number } | null = null;
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
  ): boolean {
    let changed = this.quakeExtreme.applyDto(dto, nowMs);
    const quakeMapMutation = quakeMapCommand == null
      ? { accepted: true, changed: false }
      : this.applyQuakeMapCommand(quakeMapCommand, nowMs);
    changed = quakeMapMutation.changed || changed;
    if (dto.emergency?.kind === "eew") {
      changed = this.applyEew(dto.emergency, nowMs) || changed;
    }
    if (dto.domain === "tsunami") {
      changed = this.applyTsunami(dto, nowMs, tsunamiObservations ?? undefined) || changed;
    }
    if (dto.emergency?.kind === "largeQuake" && quakeMapMutation.accepted) {
      const key = dto.emergency.eventId ?? dto.id;
      const existing = this.largeQuakes.get(key);
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
    if (dto.recentQuake != null && this.recentQuakesProvider == null) {
      changed = this.applyRecentQuake(dto.recentQuake, nowMs) || changed;
    }
    if (dto.latestQuake != null) {
      changed = this.applyLatestQuake(dto.latestQuake, nowMs) || changed;
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
    if (!this.quakeMapRevisionGuard.accept(guardKey, command.revision, nowMs)) {
      return { accepted: false, changed: false };
    }

    const previousEffective = this.effectiveQuakeMapEvent(eventKey);
    let changed = false;
    if (command.kind === "upsert") {
      const bySource = this.quakeMapContributions.get(eventKey) ?? new Map();
      bySource.set(command.sourceType, {
        ...command.event,
        sourceType: command.sourceType,
        revision: { ...command.revision },
      });
      this.quakeMapContributions.set(eventKey, bySource);
      changed = true;
    } else {
      const bySource = this.quakeMapContributions.get(eventKey);
      if (bySource?.delete(command.sourceType) === true) changed = true;
      if (bySource?.size === 0) this.quakeMapContributions.delete(eventKey);
    }

    const effective = this.effectiveQuakeMapEvent(eventKey);
    const effectiveChanged =
      previousEffective?.sourceType !== effective?.sourceType
      || !sameRevision(previousEffective?.revision, effective?.revision);
    if (
      effectiveChanged
      && effective != null
      && effective.maxIntRank >= QUAKE_MAP_HOST_MIN_RANK
      && effective.maxIntRank < TIER_QUAKE_ALERT_RANK
    ) {
      const nextHost = { eventKey, expiresAtMs: nowMs + NON_EMERGENCY_HOST_TTL_MS };
      if (
        this.quakeMapHost?.eventKey !== nextHost.eventKey
        || this.quakeMapHost.expiresAtMs !== nextHost.expiresAtMs
      ) {
        this.quakeMapHost = nextHost;
        changed = true;
      }
    } else if (this.quakeMapHost?.eventKey === eventKey) {
      if (
        effective == null
        || effective.maxIntRank < QUAKE_MAP_HOST_MIN_RANK
        || effective.maxIntRank >= TIER_QUAKE_ALERT_RANK
      ) {
        this.quakeMapHost = null;
        changed = true;
      }
    }
    return { accepted: true, changed };
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
    if (input.isCancellation) {
      // 遅延到着した古い serial の取消が新しい続報を消さないようガードする (続報の巻き戻し防止と同方針)
      if (existing != null && compareSerial(input.serial, existing.serial) < 0) return false;
      return this.activeEews.delete(eventId);
    }
    if (existing != null) {
      const cmp = compareSerial(input.serial, existing.serial);
      if (cmp < 0) return false; // 古い報は final でも無視 (遅延到着の最終報が新しい続報を巻き戻さない)
      if (cmp === 0 && !input.isFinal) return false; // 同報の再送
    }
    this.activeEews.set(eventId, { ...input, updatedAtMs: nowMs });
    return true;
  }

  private applyTsunami(
    dto: DisplayEventDtoV1,
    nowMs: number,
    observations: DisplayTsunamiObservationV1[] | undefined,
  ): boolean {
    // VTSE51/52 (津波情報・沖合観測): レベル・coasts の真実源にはしない (旧仕様のまま)。
    // 稼働中の津波 state がある場合に限り observations 欄だけを更新する。state が無ければ
    // 観測データ単独で state を新規作成しない。updatedAtMs にも触れない。
    if (dto.type === "VTSE51" || dto.type === "VTSE52") {
      if (this.tsunami == null) return false;
      if (observations == null || observations.length === 0) return false;
      this.tsunami = { ...this.tsunami, observations };
      return true;
    }
    // 津波状態の真実源は VTSE41 (津波警報・注意報・予報) のみ。
    // 本体の TsunamiStateHolder.update() が VTSE41 限定 (process-tsunami.ts) なのと整合させる
    if (dto.type !== "VTSE41") return false;
    if (dto.emergency?.kind === "tsunami") {
      this.tsunami = { ...dto.emergency, updatedAtMs: nowMs };
      return true;
    }
    // VTSE41 で emergency が組めない = 取消 or 全解除
    if (this.tsunami != null) { this.tsunami = null; return true; }
    return false;
  }

  private applyRecentQuake(q: DisplayRecentQuakeV1, nowMs: number): boolean {
    // 「今日」は暦日 JST。時刻が壊れている電文は表示を捏造せず除外する。
    if (quakeDayKey(q) !== jstDayKey(nowMs)) return false;
    if (q.eventId != null) {
      this.recentQuakes = this.recentQuakes.filter((r) => r.eventId !== q.eventId);
    }
    this.recentQuakes.unshift(q);
    if (this.recentQuakes.length > RECENT_QUAKES_MAX) this.recentQuakes.length = RECENT_QUAKES_MAX;
    return true;
  }

  private applyLatestQuake(input: DisplayLatestQuakeInputV1, nowMs: number): boolean {
    const existing = this.latestQuake;
    if (!shouldReplaceLatestQuake(existing, input)) return false;
    this.latestQuake = { ...input, updatedAtMs: nowMs };
    return true;
  }

  sweep(nowMs: number, sweepWeatherPromotions = true): boolean {
    let changed = false;
    for (const [id, eew] of this.activeEews) {
      const ttlHit = nowMs - eew.updatedAtMs > EEW_TTL_MIN * MIN_MS;
      const finalHit = eew.isFinal && nowMs - eew.updatedAtMs > EEW_FINAL_HOLD_SEC * 1000;
      if (ttlHit || finalHit) { this.activeEews.delete(id); changed = true; }
    }
    for (const [id, q] of this.largeQuakes) {
      if (nowMs - q.updatedAtMs > LARGE_QUAKE_HOLD_MIN * MIN_MS) { this.largeQuakes.delete(id); changed = true; }
    }
    if (this.quakeMapHost != null && nowMs >= this.quakeMapHost.expiresAtMs) {
      this.quakeMapHost = null;
      changed = true;
    }
    this.quakeMapRevisionGuard.sweep(nowMs);
    // SSE 無客中は気象点灯の時計だけを止める。他 domain の lifecycle は従来どおり進める
    if (sweepWeatherPromotions) {
      changed = this.promotions.sweepDemote(nowMs) || changed;
    }
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
        nowMs - this.latestQuake.updatedAtMs > quakeCardTtlMs(this.latestQuake.maxIntRank ?? 0)) {
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

  seedTsunami(input: DisplayTsunamiInputV1, nowMs: number): void {
    this.tsunami = { ...input, updatedAtMs: nowMs };
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

  private currentWeatherAlerts(): DisplayWeatherAlertV1[] {
    return this.weatherAlertsProvider?.() ?? this.weatherAlerts;
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
    for (const q of this.largeQuakes.values()) if (q.maxIntRank >= TIER_QUAKE_ALERT_RANK) bump("alert");
    if (this.latestQuake != null && (this.latestQuake.maxIntRank ?? 0) >= TIER_QUAKE_ALERT_RANK) bump("alert");
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
  private weatherPromotionForWire(): DisplayWeatherPromotionV1 {
    return {
      vpws50: this.promotionEntryForWire("vpws50"),
      vpww56: this.promotionEntryForWire("vpww56"),
      // パネル全体の点灯キー。**source の降格・解除では動かない** watermark
      activationKey: `${this.promotions.activationWatermark()}`,
    };
  }

  /**
   * live な weatherAlerts に当該 source があれば、そちらが権威なので控え (restoredItems) は載せない。
   * 控えを載せるのは「昇格しているのにカードが空」の窓 (再起動直後・display on 直後) だけ。
   * 定常運転では snapshot に同じ内容を二重に積まないので、バイト上限にも効かない。
   */
  private promotionEntryForWire(source: DisplayWeatherSourceV1): DisplayWeatherPromotionEntryV1 | null {
    const entry = promotionEntry(this.promotions.get(source));
    if (entry == null) return null;
    if (this.currentWeatherAlerts().some((a) => a.source === source)) return entry;
    const items = this.promotions.get(source)?.items ?? [];
    return items.length === 0 ? entry : { ...entry, restoredItems: items };
  }

  /** night-dim 用。demoted 後も警報解除 (record 削除) まで true */
  private isWeatherL5Active(): boolean {
    return WEATHER_PROMOTION_SOURCES.some((s) => this.promotions.get(s)?.level === 5);
  }

  snapshot(seq: number, nowMs: number): DisplayStateSnapshotV1 {
    return {
      version: DISPLAY_PROTOCOL_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      seq,
      activeEews: [...this.activeEews.values()],
      tsunami: this.tsunami,
      largeQuakes: [...this.largeQuakes.values()],
      weatherAlerts: [...this.currentWeatherAlerts()],
      weatherPromotion: this.weatherPromotionForWire(),
      weatherL5Active: this.isWeatherL5Active(),
      recentQuakes: this.recentQuakesProvider?.() ?? [...this.recentQuakes],
      latestQuake: this.latestQuake,
      stats: this.stats,
      severityTier: this.deriveSeverityTier(nowMs),
      backgroundTone: this.deriveBackgroundTone(nowMs),
      connection: { ...this.connection },
      recentTicker: [],
      standbyItems: this.standbyItemsProvider?.() ?? [],
      mapLayers: {
        quake: {
          events: this.effectiveQuakeMapEvents(),
          nonEmergencyHost: this.quakeMapHost == null ? null : { ...this.quakeMapHost },
        },
      },
    };
  }
}

/** originTime を優先し、欠落時だけ reportDateTime を使う。無効な ISO は null。 */
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
