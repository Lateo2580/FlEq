import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type {
  DisplayFloodHydrographV1,
  DisplayFloodRiverV1,
  DisplayFloodStationV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type { PersistedFloodState } from "./flood-active-reducer";
import type { PersistedSeenEntry } from "./revision-guard";
import type { StandbyRevision } from "./standby-registry";

const PERSIST_SCHEMA_VERSION = 1;

export interface PersistedHeatStateV1 {
  key: string;
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
}

export interface PersistedStandbyStateV1 {
  version: 1;
  savedAt: string;
  heat: PersistedHeatStateV1[];
  typhoons: PersistedTyphoonStateV1[];
  volcanoes: PersistedVolcanoStateV1[];
  floods?: PersistedFloodState;
  weatherAlerts?: PersistedWeatherAlertStateV1[];
  tornado?: PersistedTornadoStateV1[];
  longPeriod?: PersistedLongPeriodStateV1[];
  quakeHost?: PersistedQuakeHostStateV1 | null;
  nankaiTrough?: PersistedNankaiStateV1 | null;
  seen: PersistedSeenEntry[];
}

export interface PersistedTyphoonStateV1 { key: string; sourceEventId: string; typhoon: DisplayTyphoonV1; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedVolcanoStateV1 {
  code: string;
  name: string;
  alertLevel: number | null;
  warningKind?: string | null;
  targetKinds?: string[];
  alertExpiresAtMs: number | null;
  /** string は構造化前の v1 保存状態との互換専用。新規保存は DisplayVolcanoEventV1。 */
  latestEvent?: DisplayVolcanoEventV1 | string | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  alertRevision: StandbyRevision | null;
  eventRevision: StandbyRevision | null;
}
export interface PersistedTornadoStateV1 { publishingOffice: string; sourceEventId: string; areas: string[]; isSighted: boolean; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedLongPeriodStateV1 { eventId: string; maxLgInt: string; revision: StandbyRevision; hosted: boolean; expiresAtMs: number; }
export interface PersistedQuakeHostStateV1 { eventId: string; maxIntRank: number; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedNankaiStateV1 { sourceEventId: string; statusCode: string; label: string; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedWeatherAlertStateV1 { source: DisplayWeatherSourceV1; alerts: DisplayWeatherAlertV1[]; revision: StandbyRevision; expiresAtMs: number; }

/**
 * schedule() が実際に書き込むまでの遅延。
 * 電文が連続する場面で同期 I/O を毎報走らせず、最新状態だけを 1 回書くための窓。
 * 失うのは強制電源断の直前この秒数ぶんで、正常終了時は flush() が書き切る。
 */
const SAVE_DEBOUNCE_MS = 3000;

export class StandbyPersistence {
  private pending: { state: PersistedStandbyStateV1; seq: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** 内容を確定した順の通し番号。書き込み完了の順序が入れ替わっても最新が勝つようにする */
  private seq = 0;
  /** 実際に rename まで到達した最大 seq。これより古い書き込みは rename せずに捨てる */
  private renamedSeq = 0;

  constructor(
    private readonly persistPath: string,
    private readonly debounceMs: number = SAVE_DEBOUNCE_MS,
  ) {}

  load(): PersistedStandbyStateV1 | null {
    this.cleanStaleTmpFiles();
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      const version = parsed != null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : undefined;
      if (version !== PERSIST_SCHEMA_VERSION) {
        log.debug(`[standby-persistence] schema 世代交代 (v${String(version)} → v${PERSIST_SCHEMA_VERSION}) — 旧データ破棄`);
        return null;
      }
      const sanitized = sanitizePersistedStandbyState(parsed);
      if (sanitized == null) {
        log.warn("[standby-persistence] top-level structure validation 失敗 — 破棄");
        return null;
      }
      return sanitized;
    } catch (err) {
      log.warn(`[standby-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  save(state: PersistedStandbyStateV1): void {
    this.writeSync(state, ++this.seq);
  }

  /**
   * 最新状態の保存を予約する。debounceMs 後に 1 回だけ非同期で書く。
   * 予約中に再度呼ばれた場合は最新状態で上書きし、書き込み回数は増やさない。
   */
  schedule(state: PersistedStandbyStateV1): void {
    // seq は「内容を確定した時点」で採る。書き込み開始時に採ると、予約 → 同期保存の順で
    // 呼ばれたとき古い内容の方が大きい seq を持ってしまい、順序保証が逆転する
    this.pending = { state, seq: ++this.seq };
    this.armTimer();
  }

  /**
   * 予約済みの状態を同期で書き切る。シャットダウン経路から呼ぶ。
   * 予約がなければ何もしない (既存ファイルを空書きしない)。
   */
  flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending == null) return;
    this.writeSync(pending.state, pending.seq);
  }

  /** 予約を捨てる (テスト・再初期化用。ディスク上の内容は触らない) */
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  /**
   * rename 前に強制終了すると seq 固有名の tmp が残る (Pi は電源断が起こりうる)。
   * 起動時の load で同ディレクトリの残骸を掃除する。掃除の失敗は起動を妨げない。
   */
  private cleanStaleTmpFiles(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) return;
      const base = path.basename(this.persistPath);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch (err) {
      log.debug(`[standby-persistence] 残留 tmp の掃除に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** tmp 名は書き込みごとに一意にする (同期・非同期が同じ tmp を奪い合わないため) */
  private tmpPathFor(seq: number): string {
    return `${this.persistPath}.${seq}.tmp`;
  }

  private writeSync(state: PersistedStandbyStateV1, seq: number): void {
    const tmpPath = this.tmpPathFor(seq);
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
      if (seq < this.renamedSeq) {
        // 既により新しい内容が置かれている。追い越された書き込みは反映しない
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = seq;
    } catch (err) {
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    }
  }

  /** テスト用: 予約済みの書き込みをタイマーを待たずに実行する (実時間依存を避けるため) */
  __test_writePending(): Promise<void> {
    this.clearTimer();
    return this.writePending();
  }

  private armTimer(): void {
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writePending();
    }, this.debounceMs);
    // 保存予約だけでプロセスを生かし続けない (書き切りは flush の責務)
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async writePending(): Promise<void> {
    if (this.writing) return;
    const pending = this.pending;
    if (pending == null) return;
    this.pending = null;
    this.writing = true;
    const tmpPath = this.tmpPathFor(pending.seq);
    try {
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(pending.state), "utf8");
      // ここから rename までは await を挟まない。await で中断すると、guard 通過後・rename 完了前に
      // 同期保存が割り込み、そのあと古い rename が完了して旧内容で上書き + renamedSeq 逆行が起きる
      if (pending.seq < this.renamedSeq) {
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = pending.seq;
    } catch (err) {
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    } finally {
      this.writing = false;
      // 書き込み中に届いた更新は、終わってからもう一度だけ書く
      if (this.pending != null) this.armTimer();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is StandbyRevision {
  if (!isRecord(value)) return false;
  return typeof value.reportTimeMs === "number" && Number.isFinite(value.reportTimeMs)
    && (value.serial == null || typeof value.serial === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHeatAreaArray(value: unknown): value is DisplayHeatAreaV1[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.areaName === "string" && typeof item.isSpecial === "boolean",
  );
}

function isHeatState(value: unknown): value is PersistedHeatStateV1 {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isStringArray(value.sourceEventIds)
    && typeof value.targetDate === "string"
    && typeof value.targetDateEndMs === "number"
    && Number.isFinite(value.targetDateEndMs)
    && isHeatAreaArray(value.areas)
    && typeof value.isSpecial === "boolean"
    && isRevision(value.revision);
}

function isSeenEntry(value: unknown): value is PersistedSeenEntry {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isRevision(value.revision)
    && typeof value.forgetAtMs === "number"
    && Number.isFinite(value.forgetAtMs);
}

function isFloodTrend(value: unknown): value is DisplayFloodStationV1["trend"] {
  return value == null || value === "rising" || value === "falling" || value === "steady";
}

function isFloodHydrograph(value: unknown): value is DisplayFloodHydrographV1 {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.points) || value.points.length === 0) return false;
  const pointsWellFormed = value.points.every((point, i) => isRecord(point)
    && typeof point.dateTime === "string"
    && isNullableFiniteNumber(point.valueM)
    // phase 不変条件: 先頭 (i===0) は現況 observed、以降はすべて予測 forecast。
    // 描画側は phase を読まず先頭=現況/残り=予測として扱うため、逆順の壊れた永続データは破棄する
    && point.phase === (i === 0 ? "observed" : "forecast"));
  if (!pointsWellFormed) return false;
  // 有効値が 1 点も無い hydrograph は描画不能なので破棄 (project-flood.ts の生成条件と同じ)
  if (!value.points.some((point) => isRecord(point) && point.valueM != null)) return false;
  return isNullableFiniteNumber(value.dangerLevelM);
}

function isFloodStation(value: unknown): value is DisplayFloodStationV1 {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && isNullableFiniteNumber(value.levelM)
    && isFloodTrend(value.trend)
    && isNullableString(value.thresholdLabel)
    && (!Object.hasOwn(value, "hydrograph") || value.hydrograph == null || isFloodHydrograph(value.hydrograph));
}

function isFloodRiver(value: unknown): value is DisplayFloodRiverV1 {
  if (!isRecord(value)) return false;
  return typeof value.riverKey === "string"
    && typeof value.riverName === "string"
    && typeof value.level === "string"
    && typeof value.levelRank === "number"
    && Number.isFinite(value.levelRank)
    && typeof value.kindName === "string"
    && typeof value.reportDateTime === "string"
    && (!Object.hasOwn(value, "station") || value.station == null || isFloodStation(value.station));
}

function isFloodEvent(value: unknown): value is PersistedFloodState["events"][number] {
  return isRecord(value)
    && typeof value.eventId === "string"
    && isRevision(value.revision)
    && Array.isArray(value.rivers)
    && value.rivers.every(isFloodRiver)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeFloodState(value: unknown): PersistedFloodState | undefined {
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.seen)) return undefined;
  const events = value.events.filter(isFloodEvent);
  const validEventIds = new Set(events.map((event) => event.eventId));
  const discardedEventIds = new Set<string>();
  for (const event of value.events) {
    if (isRecord(event) && typeof event.eventId === "string" && !validEventIds.has(event.eventId)) {
      discardedEventIds.add(event.eventId);
    }
  }
  const seen = value.seen.filter(
    (entry): entry is PersistedSeenEntry => isSeenEntry(entry) && !discardedEventIds.has(entry.key),
  );
  if (value.events.length > 0 && events.length === 0 && seen.length === 0) return undefined;
  if (events.length !== value.events.length || seen.length !== value.seen.length) {
    log.warn("[standby-persistence] floods の壊れた EventID/seen entry だけを破棄");
  }
  return { events, seen };
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isFinite(value);
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableString(value[key]);
}

function hasNullableFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableFiniteNumber(value[key]);
}

function isTyphoon(value: unknown): value is DisplayTyphoonV1 {
  if (!isRecord(value)) return false;
  return typeof value.typhoonKey === "string"
    && hasNullableString(value, "name")
    && hasNullableString(value, "nameKana")
    && hasNullableString(value, "remark")
    && hasNullableString(value, "typhoonNumber")
    && hasNullableString(value, "category")
    && hasNullableString(value, "location")
    && hasNullableFiniteNumber(value, "pressureHpa")
    && (!Object.hasOwn(value, "pressureDeltaHpa") || isNullableFiniteNumber(value.pressureDeltaHpa))
    && hasNullableFiniteNumber(value, "maxWindMs")
    && (!Object.hasOwn(value, "maxGustMs") || isNullableFiniteNumber(value.maxGustMs))
    && (!Object.hasOwn(value, "maxWindDeltaMs") || isNullableFiniteNumber(value.maxWindDeltaMs))
    && (!Object.hasOwn(value, "intensityTrend")
      || value.intensityTrend == null
      || value.intensityTrend === "developing"
      || value.intensityTrend === "weakening"
      || value.intensityTrend === "steady")
    && hasNullableString(value, "moveDirection")
    && hasNullableFiniteNumber(value, "moveSpeedKmh")
    && typeof value.reportDateTime === "string";
}

function isTyphoonState(value: unknown): value is PersistedTyphoonStateV1 {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.sourceEventId === "string"
    && isTyphoon(value.typhoon)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isVolcanoState(value: unknown): value is PersistedVolcanoStateV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && hasNullableFiniteNumber(value, "alertLevel")
    && (!Object.hasOwn(value, "warningKind") || hasNullableString(value, "warningKind"))
    && (!Object.hasOwn(value, "targetKinds") || isStringArray(value.targetKinds))
    && hasNullableFiniteNumber(value, "alertExpiresAtMs")
    && (!Object.hasOwn(value, "latestEvent")
      || value.latestEvent == null
      || typeof value.latestEvent === "string"
      || isVolcanoEvent(value.latestEvent))
    && hasNullableFiniteNumber(value, "eventExpiresAtMs")
    && isStringArray(value.sourceEventIds)
    && Object.hasOwn(value, "alertRevision") && (value.alertRevision == null || isRevision(value.alertRevision))
    && Object.hasOwn(value, "eventRevision") && (value.eventRevision == null || isRevision(value.eventRevision));
}

function isVolcanoEvent(value: unknown): value is DisplayVolcanoEventV1 {
  return isRecord(value)
    && typeof value.label === "string"
    && hasNullableString(value, "craterName")
    && hasNullableString(value, "eventDateTime")
    && hasNullableFiniteNumber(value, "plumeHeightM")
    && typeof value.plumeHeightUnknown === "boolean"
    && hasNullableString(value, "plumeDirection");
}

function isTornadoState(value: unknown): value is PersistedTornadoStateV1 {
  return isRecord(value)
    && typeof value.publishingOffice === "string"
    && typeof value.sourceEventId === "string"
    && isStringArray(value.areas)
    && typeof value.isSighted === "boolean"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isLongPeriodState(value: unknown): value is PersistedLongPeriodStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxLgInt === "string"
    && isRevision(value.revision)
    && typeof value.hosted === "boolean"
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isQuakeHostState(value: unknown): value is PersistedQuakeHostStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxIntRank === "number" && Number.isFinite(value.maxIntRank)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isNankaiState(value: unknown): value is PersistedNankaiStateV1 {
  return isRecord(value)
    && typeof value.sourceEventId === "string"
    && typeof value.statusCode === "string"
    && typeof value.label === "string"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isWeatherAlertItem(value: unknown): value is DisplayWeatherAlertItemV1 {
  return isRecord(value)
    && typeof value.kind === "string"
    && (!Object.hasOwn(value, "phenomenonKey") || typeof value.phenomenonKey === "string")
    && typeof value.displaySeverity === "string"
    && (value.rank === "emergency" || value.rank === "warning" || value.rank === "advisory")
    && isStringArray(value.shownAreas)
    && typeof value.omittedAreaCount === "number"
    && Number.isSafeInteger(value.omittedAreaCount)
    && value.omittedAreaCount >= 0;
}

function isWeatherAlert(value: unknown): value is DisplayWeatherAlertV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && typeof value.label === "string"
    && (value.role === "weatherEmergency" || value.role === "weatherWarning" || value.role === "weatherAdvisory")
    && typeof value.totalAreas === "number"
    && Number.isSafeInteger(value.totalAreas)
    && value.totalAreas >= 0
    && Array.isArray(value.items)
    && value.items.every(isWeatherAlertItem)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt));
}

function isWeatherAlertState(value: unknown): value is PersistedWeatherAlertStateV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && Array.isArray(value.alerts)
    && value.alerts.length > 0
    && value.alerts.every((alert) => isWeatherAlert(alert) && alert.source === value.source)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeWeatherAlertStates(value: unknown): PersistedWeatherAlertStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    log.warn("[standby-persistence] weatherAlerts structure validation 失敗 — domain 破棄");
    return [];
  }
  const states = value.filter(isWeatherAlertState);
  if (states.length !== value.length) {
    log.warn("[standby-persistence] weatherAlerts の壊れた source だけを破棄");
  }
  return states;
}

function validDomainArray<T>(value: unknown, predicate: (entry: unknown) => entry is T, domain: string): T[] {
  if (value == null) return [];
  if (Array.isArray(value) && value.every(predicate)) return value;
  log.warn(`[standby-persistence] ${domain} structure validation 失敗 — domain 破棄`);
  return [];
}

function sanitizePersistedStandbyState(value: unknown): PersistedStandbyStateV1 | null {
  if (!isRecord(value) || value.version !== PERSIST_SCHEMA_VERSION || typeof value.savedAt !== "string") return null;
  const floods = value.floods == null ? undefined : sanitizeFloodState(value.floods);
  if (value.floods != null && floods == null) log.warn("[standby-persistence] floods structure validation 失敗 — domain 破棄");
  const nankaiTrough = value.nankaiTrough == null || isNankaiState(value.nankaiTrough) ? value.nankaiTrough : null;
  if (value.nankaiTrough != null && nankaiTrough == null) log.warn("[standby-persistence] nankaiTrough structure validation 失敗 — domain 破棄");
  const quakeHost = value.quakeHost == null || isQuakeHostState(value.quakeHost) ? value.quakeHost : null;
  if (value.quakeHost != null && quakeHost == null) log.warn("[standby-persistence] quakeHost structure validation 失敗 — domain 破棄");
  return {
    version: 1,
    savedAt: value.savedAt,
    heat: validDomainArray(value.heat, isHeatState, "heat"),
    typhoons: validDomainArray(value.typhoons, isTyphoonState, "typhoons"),
    volcanoes: validDomainArray(value.volcanoes, isVolcanoState, "volcanoes"),
    floods,
    weatherAlerts: sanitizeWeatherAlertStates(value.weatherAlerts),
    tornado: validDomainArray(value.tornado, isTornadoState, "tornado"),
    longPeriod: validDomainArray(value.longPeriod, isLongPeriodState, "longPeriod"),
    quakeHost,
    nankaiTrough,
    seen: validDomainArray(value.seen, isSeenEntry, "seen"),
  };
}
