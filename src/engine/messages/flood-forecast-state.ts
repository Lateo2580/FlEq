import type { ParsedFloodForecastInfo, FloodLevel, FloodKindCode } from "../../types";

/**
 * 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の station-level 差分結果。
 * spec §8 / plan Task 23 (本実装) 参照。
 *   - hasChange: 変化 (新規 / フィールド差分 / 削除) があった場合のみ true
 *   - changedStations: stationCode と変化理由 (複数可) のリスト
 *   - removedStations: 前回あって今回ない station code のリスト
 */
export interface FloodForecastDiff {
  hasChange: boolean;
  changedStations: Array<{
    stationCode: string;
    reasons: Array<
      | "new"
      | "kindCode"
      | "headlineLevel"
      | "stationObservedLevel"
      | "condition"
      | "mainItemCode"
      | "mainText"
    >;
  }>;
  removedStations: string[];
}

/**
 * 観測点ごとの差分検出用ダイジェスト。
 * buildStationDigests が ParsedFloodForecastInfo.rawStations から組み立てる。
 *   - kindCode: 観測点の headlineKindCode (parser が §3.1 ルールで解決)
 *   - condition: series[0]?.condition (最新観測の変化方向)。欠測時は "欠測"
 *   - mainItemCode / mainTextHash: Warning.Item の本文差分検出 (16_11 系の主文更新で発火)
 */
export interface StationDigest {
  stationCode: string;
  kindCode: FloodKindCode;
  headlineLevel: FloodLevel;
  stationObservedLevel: FloodLevel;
  condition: string;
  mainItemCode: "1" | "2" | null;
  mainTextHash: string;
}

/** store 内の前回値 (digest + 観測時刻) */
interface DedupValue extends StationDigest {
  receivedAt: string | null;
}

/**
 * ParsedFloodForecastInfo から StationDigest[] を組み立てる。
 * rawStations が空 (Headline-only 電文) のときは [] を返す。
 */
export function buildStationDigests(info: ParsedFloodForecastInfo): StationDigest[] {
  return info.rawStations.map((s) => ({
    stationCode: s.stationCode,
    kindCode: s.headlineKindCode,
    headlineLevel: s.headlineLevel,
    stationObservedLevel: s.stationObservedLevel,
    condition: s.series[0]?.condition ?? "欠測",
    mainItemCode: s.mainItemCode,
    mainTextHash: s.mainTextHash,
  }));
}

/** EventID ごとの履歴。lastSeenMs は最終更新時刻 (TTL 判定に使う) */
interface EventHistory {
  lastSeenMs: number;
  stations: Map<string, DedupValue>;
}

export interface FloodForecastStateSnapshot {
  version: number;
  events: Array<{
    eventId: string;
    lastSeenMs: number;
    stations: Array<[string, StationDigest & { receivedAt: string | null }]>;
  }>;
}

/**
 * EventID 履歴の保持期間。最終更新からこれを過ぎた EventID は次の受信時に掃除する。
 * display 側の洪水 tombstoneTtlMs (DAY + 12h) と揃えた。
 */
export const FLOOD_FORECAST_HISTORY_TTL_MS = 36 * 60 * 60_000;
export const FLOOD_FORECAST_MAX_EVENTS = 512;

/**
 * 同一 EventID で前回の観測点状態を覚えて station 単位 dedup する state holder。
 * Vpws50StateHolder / TyphoonProbabilityStateHolder と同思想 (in-memory, restart=全 reset)。
 *
 * 構造: EventID → { lastSeenMs, stations } の二段。異なる EventID は完全独立で、
 * removed 判定も該当 EventID の観測点だけを走査する。
 * 取消 (rollback) は同一 eventId のエントリごと削除する。
 *
 * 保持期間: 洪水は出水ごとに EventID が変わり、取消電文が来ないまま収束することがある。
 * TTL がないと履歴が単調増加し、各報の removed 判定も履歴総数に比例して重くなるため、
 * 電文を受けるたびに期限切れ EventID を掃除する。
 *
 * TTL の延長は diffAndUpdate だけでなく touch でも行う。dedup を通さない続報
 * (訂正 / Headline-only) が続く間も EventID は活動中であり、これを数えないと
 * 長い出水の途中で履歴を落として全観測点を "new" に戻してしまう。
 *
 * 空 eventId ("") は履歴に乗せない (誤った dedup を避ける)。hasChange=true を返すが
 * changedStations は空のため、呼び出し側は通知だけ行って station 個別 diff は使わない。
 */
export class FloodForecastStateHolder {
  private events: Map<string, EventHistory> = new Map();
  private ownerVersion = 0;
  private ownerFingerprint: string | null = null;

  private refreshVersion(): void {
    const next = JSON.stringify([...this.events].map(([eventId, history]) => [
      eventId, history.lastSeenMs, [...history.stations],
    ]));
    if (this.ownerFingerprint != null && this.ownerFingerprint !== next) this.ownerVersion += 1;
    this.ownerFingerprint = next;
  }

  version(): number { this.refreshVersion(); return this.ownerVersion; }

  cloneSnapshot(): FloodForecastStateSnapshot {
    this.refreshVersion();
    return structuredClone({
      version: this.ownerVersion,
      events: [...this.events].map(([eventId, history]) => ({
        eventId,
        lastSeenMs: history.lastSeenMs,
        stations: [...history.stations],
      })),
    });
  }

  static fromSnapshot(snapshot: FloodForecastStateSnapshot): FloodForecastStateHolder {
    const holder = new FloodForecastStateHolder();
    holder.loadSnapshot(snapshot, false);
    return holder;
  }

  replacePrevalidated(snapshot: FloodForecastStateSnapshot): void { this.loadSnapshot(snapshot, true); }

  private loadSnapshot(snapshot: FloodForecastStateSnapshot, commit: boolean): void {
    this.events = new Map(snapshot.events.map((event) => [event.eventId, {
      lastSeenMs: event.lastSeenMs,
      stations: new Map(structuredClone(event.stations)),
    }]));
    this.ownerVersion = commit ? this.ownerVersion + 1 : snapshot.version;
    this.ownerFingerprint = null;
    this.refreshVersion();
  }

  diffAndUpdate(
    eventId: string,
    digests: StationDigest[],
    receivedAt: string | null,
    nowMs: number = Date.now(),
  ): FloodForecastDiff {
    // 空 eventId でも保持量の保証は効かせたいので、早期 return より先に掃除する
    this.sweepExpired(nowMs);

    if (eventId === "") {
      // EventID 不明の発表は履歴に乗せない (TyphoonProbabilityStateHolder と同じ方針)
      return { hasChange: true, changedStations: [], removedStations: [] };
    }

    const changed: FloodForecastDiff["changedStations"] = [];
    const incomingCodes = new Set(digests.map((d) => d.stationCode));

    let history = this.events.get(eventId);
    if (history == null) {
      history = { lastSeenMs: nowMs, stations: new Map() };
    }
    history.lastSeenMs = nowMs;
    this.events.delete(eventId);
    this.events.set(eventId, history);

    for (const d of digests) {
      const prev = history.stations.get(d.stationCode);
      const reasons: FloodForecastDiff["changedStations"][number]["reasons"] = [];
      if (prev == null) {
        reasons.push("new");
      } else {
        if (prev.kindCode !== d.kindCode) reasons.push("kindCode");
        if (prev.headlineLevel !== d.headlineLevel) reasons.push("headlineLevel");
        if (prev.stationObservedLevel !== d.stationObservedLevel) {
          reasons.push("stationObservedLevel");
        }
        if (prev.condition !== d.condition) reasons.push("condition");
        if (prev.mainItemCode !== d.mainItemCode) reasons.push("mainItemCode");
        if (prev.mainTextHash !== d.mainTextHash) reasons.push("mainText");
      }
      if (reasons.length > 0) {
        changed.push({ stationCode: d.stationCode, reasons });
      }
      history.stations.set(d.stationCode, { ...d, receivedAt });
    }

    // 前回あって今回 incoming に含まれない station code を removedStations に
    const removed: string[] = [];
    for (const stationCode of Array.from(history.stations.keys())) {
      if (!incomingCodes.has(stationCode)) {
        removed.push(stationCode);
        history.stations.delete(stationCode);
      }
    }

    while (this.events.size > FLOOD_FORECAST_MAX_EVENTS) {
      const oldest = this.events.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.events.delete(oldest);
    }

    return {
      hasChange: changed.length > 0 || removed.length > 0,
      changedStations: changed,
      removedStations: removed,
    };
  }

  /**
   * dedup を通さない続報 (訂正 / Headline-only / VXSU) を受けたときに呼ぶ。
   * 既知 EventID の最終更新時刻だけを延ばし、履歴のない EventID は新規作成しない
   * (station 情報を持たない電文から dedup 履歴は組み立てられないため)。
   */
  touch(eventId: string, nowMs: number = Date.now()): void {
    this.sweepExpired(nowMs);
    if (eventId === "") return;
    const history = this.events.get(eventId);
    if (history != null) {
      history.lastSeenMs = nowMs;
      this.events.delete(eventId);
      this.events.set(eventId, history);
    }
  }

  /** 取消 (info.infoType==="取消") 時に呼ぶ。同一 eventId の履歴ごと削除する */
  rollback(eventId: string): void {
    if (eventId === "") return;
    this.events.delete(eventId);
  }

  retainActiveEventIds(eventIds: readonly string[]): void {
    const retained = new Set(eventIds);
    for (const eventId of this.events.keys()) {
      if (!retained.has(eventId)) this.events.delete(eventId);
    }
  }

  activeEventIds(): string[] {
    return [...this.events.keys()];
  }

  sweep(nowMs: number): boolean {
    const before = this.events.size;
    this.sweepExpired(nowMs);
    return this.events.size !== before;
  }

  /** 最終更新から HISTORY_TTL_MS を過ぎた EventID を捨てる */
  private sweepExpired(nowMs: number): void {
    for (const [eventId, history] of Array.from(this.events)) {
      if (nowMs - history.lastSeenMs > FLOOD_FORECAST_HISTORY_TTL_MS) {
        this.events.delete(eventId);
      }
    }
  }
}
