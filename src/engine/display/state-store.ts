import {
  EEW_FINAL_HOLD_SEC,
  EEW_TTL_MIN,
  LARGE_QUAKE_HOLD_MIN,
  QUAKE_CARD_TTL_HIGH_MIN,
  QUAKE_CARD_TTL_LOW_MIN,
  QUAKE_CARD_TTL_MID_MIN,
  RECENT_QUAKES_MAX,
  TSUNAMI_DEMOTE_MIN,
} from "./constants";
import {
  DISPLAY_PROTOCOL_VERSION,
  type DisplayActiveEewV1,
  type ActiveStandbyCardV1,
  type DisplayConnectionStateV1,
  type DisplayEewInputV1,
  type DisplayEventDtoV1,
  type DisplayLargeQuakeStateV1,
  type DisplayLatestQuakeInputV1,
  type DisplayLatestQuakeStateV1,
  type DisplayRecentQuakeV1,
  type DisplaySeverityTier,
  type DisplayStateSnapshotV1,
  type DisplayStatsV1,
  type DisplayTsunamiInputV1,
  type DisplayTsunamiObservationV1,
  type DisplayTsunamiStateV1,
  type DisplayWeatherAlertV1,
} from "./types";
import { intensityToRank } from "../../utils/intensity";

const MIN_MS = 60_000;
const QUAKE_CARD_HIGH_RANK = intensityToRank("5弱");
const QUAKE_CARD_MID_RANK = intensityToRank("3");
const TIER_ORDER: Record<DisplaySeverityTier, number> = { calm: 0, caution: 1, alert: 2, critical: 3 };
const TIER_QUAKE_ALERT_RANK = intensityToRank("5弱");

function quakeCardTtlMs(rank: number): number {
  if (rank >= QUAKE_CARD_HIGH_RANK) return QUAKE_CARD_TTL_HIGH_MIN * MIN_MS;
  if (rank >= QUAKE_CARD_MID_RANK) return QUAKE_CARD_TTL_MID_MIN * MIN_MS;
  return QUAKE_CARD_TTL_LOW_MIN * MIN_MS;
}

// 現在の緊急状態 (EEW/津波/大地震/気象警報/接続) を合成する表示用ストア。
// 時刻は全メソッドで nowMs 注入 (クラス内で Date.now() を呼ばない)。
// applyEvent/sweep の boolean = 「state snapshot の再配信が必要な変化があったか」。
export class DisplayStateStore {
  private activeEews = new Map<string, DisplayActiveEewV1>();
  private tsunami: DisplayTsunamiStateV1 | null = null;
  private largeQuakes = new Map<string, DisplayLargeQuakeStateV1>();
  private recentQuakes: DisplayRecentQuakeV1[] = [];
  private latestQuake: DisplayLatestQuakeStateV1 | null = null;
  private stats: DisplayStatsV1 | null = null;
  private weatherAlerts: DisplayWeatherAlertV1[] = [];
  private connection: DisplayConnectionStateV1 = {
    dmdata: "connecting", lastReceivedAt: null, disconnectedSince: null, reason: null,
  };

  constructor(private readonly standbyItemsProvider?: () => ActiveStandbyCardV1[]) {}

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
  ): boolean {
    let changed = false;
    if (dto.emergency?.kind === "eew") {
      changed = this.applyEew(dto.emergency, nowMs) || changed;
    }
    if (dto.domain === "tsunami") {
      changed = this.applyTsunami(dto, nowMs, tsunamiObservations ?? undefined) || changed;
    }
    if (dto.emergency?.kind === "largeQuake") {
      const key = dto.emergency.eventId ?? dto.id;
      this.largeQuakes.set(key, { ...dto.emergency, updatedAtMs: nowMs });
      changed = true;
    }
    if (dto.recentQuake != null) {
      changed = this.applyRecentQuake(dto.recentQuake) || changed;
    }
    if (dto.latestQuake != null) {
      changed = this.applyLatestQuake(dto.latestQuake, nowMs) || changed;
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
    // VTSE51/52 (津波情報・沖合観測): レベル・coasts・demoted の真実源にはしない (旧仕様のまま)。
    // 稼働中の津波 state がある場合に限り observations 欄だけを更新する。state が無ければ
    // 観測データ単独で state を新規作成しない。updatedAtMs (demote タイマー) にも触れない。
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
      this.tsunami = { ...dto.emergency, demoted: false, updatedAtMs: nowMs };
      return true;
    }
    // VTSE41 で emergency が組めない = 取消 or 全解除
    if (this.tsunami != null) { this.tsunami = null; return true; }
    return false;
  }

  private applyRecentQuake(q: DisplayRecentQuakeV1): boolean {
    if (q.eventId != null) {
      this.recentQuakes = this.recentQuakes.filter((r) => r.eventId !== q.eventId);
    }
    this.recentQuakes.unshift(q);
    if (this.recentQuakes.length > RECENT_QUAKES_MAX) this.recentQuakes.length = RECENT_QUAKES_MAX;
    return true;
  }

  private applyLatestQuake(input: DisplayLatestQuakeInputV1, nowMs: number): boolean {
    const existing = this.latestQuake;
    // 同一 eventId の続報 (震度の下方修正含む) は常に置換する。ガードの意図は
    // 「別の余震で押し出されない」ことであり、同じ地震の訂正報を古いまま残さない。
    const sameEvent = existing?.eventId != null && existing.eventId === input.eventId;
    if (existing != null && !sameEvent) {
      const existingRank = existing.maxIntRank ?? 0;
      const newRank = input.maxIntRank ?? 0;
      const expired = nowMs - existing.updatedAtMs > quakeCardTtlMs(existingRank);
      // 高ランクの生存カードは、より低ランクの新地震では置き換えない (余震で押し出されない)
      if (!expired && newRank < existingRank) return false;
    }
    this.latestQuake = { ...input, updatedAtMs: nowMs };
    return true;
  }

  sweep(nowMs: number): boolean {
    let changed = false;
    for (const [id, eew] of this.activeEews) {
      const ttlHit = nowMs - eew.updatedAtMs > EEW_TTL_MIN * MIN_MS;
      const finalHit = eew.isFinal && nowMs - eew.updatedAtMs > EEW_FINAL_HOLD_SEC * 1000;
      if (ttlHit || finalHit) { this.activeEews.delete(id); changed = true; }
    }
    for (const [id, q] of this.largeQuakes) {
      if (nowMs - q.updatedAtMs > LARGE_QUAKE_HOLD_MIN * MIN_MS) { this.largeQuakes.delete(id); changed = true; }
    }
    if (this.tsunami != null && !this.tsunami.demoted && nowMs - this.tsunami.updatedAtMs > TSUNAMI_DEMOTE_MIN * MIN_MS) {
      this.tsunami = { ...this.tsunami, demoted: true };
      changed = true;
    }
    if (this.latestQuake != null &&
        nowMs - this.latestQuake.updatedAtMs > quakeCardTtlMs(this.latestQuake.maxIntRank ?? 0)) {
      this.latestQuake = null;
      changed = true;
    }
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
    this.tsunami = { ...input, demoted: false, updatedAtMs: nowMs };
  }

  seedWeatherAlerts(alerts: DisplayWeatherAlertV1[]): void {
    this.weatherAlerts = [...alerts];
  }

  /** hub が publishStats 経路で現在値を流し込む。snapshot に載せるだけ (dirty 判定は hub 側) */
  setStats(stats: DisplayStatsV1): void {
    this.stats = stats;
  }

  private deriveSeverityTier(): DisplaySeverityTier {
    let tier: DisplaySeverityTier = "calm";
    const bump = (t: DisplaySeverityTier): void => { if (TIER_ORDER[t] > TIER_ORDER[tier]) tier = t; };
    if (this.tsunami != null) {
      if (this.tsunami.level === "majorWarning") bump("critical");
      else if (this.tsunami.level === "warning") bump("alert");
      else bump("caution");
    }
    for (const eew of this.activeEews.values()) bump(eew.isWarning ? "alert" : "caution");
    for (const q of this.largeQuakes.values()) if (q.maxIntRank >= TIER_QUAKE_ALERT_RANK) bump("alert");
    if (this.latestQuake != null && (this.latestQuake.maxIntRank ?? 0) >= TIER_QUAKE_ALERT_RANK) bump("alert");
    return tier;
  }

  /** 現在 active な警報の groupKey 集合 (spec §3-2、初期スコープ = EEW/津波)。 */
  activeAlertKeys(): Set<string> {
    const keys = new Set<string>();
    for (const id of this.activeEews.keys()) keys.add(`eew:${id}`);
    if (this.tsunami != null) keys.add("tsunami:current");
    return keys;
  }

  snapshot(seq: number, nowMs: number): DisplayStateSnapshotV1 {
    return {
      version: DISPLAY_PROTOCOL_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      seq,
      activeEews: [...this.activeEews.values()],
      tsunami: this.tsunami,
      largeQuakes: [...this.largeQuakes.values()],
      weatherAlerts: [...this.weatherAlerts],
      recentQuakes: [...this.recentQuakes],
      latestQuake: this.latestQuake,
      stats: this.stats,
      severityTier: this.deriveSeverityTier(),
      connection: { ...this.connection },
      recentTicker: [],
      standbyItems: this.standbyItemsProvider?.() ?? [],
    };
  }
}

function compareSerial(a: string | null, b: string | null): number {
  const na = a == null ? Number.NaN : Number(a);
  const nb = b == null ? Number.NaN : Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return (a ?? "").localeCompare(b ?? "");
  return na - nb;
}
