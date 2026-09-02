import {
  ParsedTsunamiInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
  TsunamiForecastItem,
  TsunamiObservationStation,
} from "../../types";
import {
  resolveTsunamiLevel,
  type TsunamiLevelLabel,
} from "../../utils/tsunami-kind";

/** レベルに対応するテーマロール */
const LEVEL_ROLE: Record<TsunamiLevelLabel, PromptStatusRole> = {
  "大津波警報": "tsunamiMajor",
  "津波警報": "tsunamiWarning",
  "津波注意報": "tsunamiAdvisory",
};

/** 既存の display runtime 向け互換 API。判定本体は resolveTsunamiLevel に集約する。 */
export function detectTsunamiAlertLevel(
  kinds: string[],
): TsunamiLevelLabel | null {
  return resolveTsunamiLevel(kinds)?.label ?? null;
}

export type TsunamiObservationFamily = "VTSE51" | "VTSE52";

/**
 * 気象庁の観測点集合を十分に収めつつ、durable item watermark と表示配列を
 * 無制限に増やさないための family 単位上限。
 */
export const TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY = 1024;

export interface TsunamiObservationGroups {
  VTSE51: TsunamiObservationStation[];
  VTSE52: TsunamiObservationStation[];
}

export interface TsunamiStateSnapshot {
  version: number;
  currentLevel: TsunamiLevelLabel | null;
  lastInfo: ParsedTsunamiInfo | null;
  keyedForecasts: Array<[string, { eventId: string; item: TsunamiForecastItem }]>;
  eventInfos: Array<[string, ParsedTsunamiInfo]>;
  legacyRestoredInfo: ParsedTsunamiInfo | null;
  observationGroups: TsunamiObservationGroups;
}

function emptyObservationGroups(): TsunamiObservationGroups {
  return { VTSE51: [], VTSE52: [] };
}

interface KeyedTsunamiForecastItem {
  eventId: string;
  item: TsunamiForecastItem;
}

function nonBlankCode(code: string | null): string | null {
  return code == null || code.trim() === "" ? null : code;
}

function tsunamiForecastStateKey(
  eventId: string,
  item: TsunamiForecastItem,
): string | null {
  const areaCode = nonBlankCode(item.areaCode);
  const kindCode = nonBlankCode(item.kindCode);
  return areaCode == null || kindCode == null
    ? null
    : JSON.stringify([eventId, areaCode, kindCode]);
}

function tsunamiEventId(info: ParsedTsunamiInfo): string | null {
  const eventId = info.meta.eventId;
  return eventId.valid && eventId.value != null && eventId.value.trim() !== ""
    ? eventId.value
    : null;
}

/**
 * 津波情報の状態を保持し、プロンプト表示と detail コマンドを提供する。
 */
export class TsunamiStateHolder
  implements PromptStatusProvider, DetailProvider<"tsunami">
{
  readonly category = "tsunami";
  readonly emptyMessage = "現在、継続中の津波情報はありません。";

  private currentLevel: TsunamiLevelLabel | null = null;
  private lastInfo: ParsedTsunamiInfo | null = null;
  private keyedForecasts = new Map<string, KeyedTsunamiForecastItem>();
  private eventInfos = new Map<string, ParsedTsunamiInfo>();
  private legacyRestoredInfo: ParsedTsunamiInfo | null = null;
  private observationGroups = emptyObservationGroups();
  private ownerVersion = 0;
  private ownerFingerprint: string | null = null;

  private refreshVersion(): void {
    const next = JSON.stringify({
      currentLevel: this.currentLevel,
      lastInfo: this.lastInfo,
      keyedForecasts: [...this.keyedForecasts],
      eventInfos: [...this.eventInfos],
      legacyRestoredInfo: this.legacyRestoredInfo,
      observationGroups: this.observationGroups,
    });
    if (this.ownerFingerprint != null && this.ownerFingerprint !== next) this.ownerVersion += 1;
    this.ownerFingerprint = next;
  }

  version(): number {
    this.refreshVersion();
    return this.ownerVersion;
  }

  cloneSnapshot(): TsunamiStateSnapshot {
    this.refreshVersion();
    return structuredClone({
      version: this.ownerVersion,
      currentLevel: this.currentLevel,
      lastInfo: this.lastInfo,
      keyedForecasts: [...this.keyedForecasts],
      eventInfos: [...this.eventInfos],
      legacyRestoredInfo: this.legacyRestoredInfo,
      observationGroups: this.observationGroups,
    });
  }

  static fromSnapshot(snapshot: TsunamiStateSnapshot): TsunamiStateHolder {
    const holder = new TsunamiStateHolder();
    holder.loadSnapshot(snapshot, false);
    return holder;
  }

  replacePrevalidated(snapshot: TsunamiStateSnapshot): void {
    this.loadSnapshot(snapshot, true);
  }

  private loadSnapshot(snapshot: TsunamiStateSnapshot, commit: boolean): void {
    this.currentLevel = snapshot.currentLevel;
    this.lastInfo = structuredClone(snapshot.lastInfo);
    this.keyedForecasts = new Map(structuredClone(snapshot.keyedForecasts));
    this.eventInfos = new Map(structuredClone(snapshot.eventInfos));
    this.legacyRestoredInfo = structuredClone(snapshot.legacyRestoredInfo);
    this.observationGroups = structuredClone(snapshot.observationGroups);
    this.ownerVersion = commit ? this.ownerVersion + 1 : snapshot.version;
    this.ownerFingerprint = null;
    this.refreshVersion();
  }

  /** 現在の警報レベルを返す (テスト用) */
  getLevel(): TsunamiLevelLabel | null {
    return this.currentLevel;
  }

  /** 表示ディスプレイ用: 最後に受信した津波情報 (発表中でなければ null) */
  getLastInfo(): ParsedTsunamiInfo | null {
    return this.lastInfo;
  }

  getObservationGroups(): TsunamiObservationGroups {
    return structuredClone(this.observationGroups);
  }

  getPersistedActive(): ParsedTsunamiInfo | null {
    if (this.keyedForecasts.size === 0) return null;
    // legacy scalar も live aggregate の一員。keyed Event と併存中は
    // scalar schema で単一 EventID を証明できないため保存しない。
    if (this.legacyRestoredInfo != null) return null;
    const eventIds = new Set(
      [...this.keyedForecasts.values()].map((entry) => entry.eventId),
    );
    // v2 の scalar active に複数 EventID を詰めると、復元時に全 item が
    // 一つの EventID へ誤帰属する。keyed schema 導入までは保存しない。
    if (eventIds.size !== 1) return null;
    const eventId = eventIds.values().next().value as string;
    const envelope = this.eventInfos.get(eventId);
    if (envelope == null) return null;
    const forecast = [...this.keyedForecasts.values()]
      .filter((entry) => entry.eventId === eventId)
      .map((entry) => entry.item);
    const level = resolveTsunamiLevel(forecast.map((item) => item.kind))?.label ?? null;
    return level == null
      ? null
      : structuredClone({ ...envelope, forecast });
  }

  /** 複数 EventID を縮退させない keyed persistence 用 snapshot。 */
  getPersistedKeyedActive(): ParsedTsunamiInfo[] {
    return [...this.eventInfos.values()].map((info) => structuredClone(info));
  }

  /** 名称-only の旧 snapshot は表示専用の legacy payload として分離する。 */
  getPersistedLegacyActive(): ParsedTsunamiInfo | null {
    return this.legacyRestoredInfo == null
      ? null
      : structuredClone(this.legacyRestoredInfo);
  }

  /**
   * live presentation 用 snapshot。unkeyed item はこの返り値にだけ合成し、
   * holder state と永続化には入れない。
   */
  getPresentationInfo(incoming: ParsedTsunamiInfo): ParsedTsunamiInfo | null {
    if (this.lastInfo == null) return null;
    if (incoming.meta.infoType.value === "取消") return this.lastInfo;
    const incomingEventId = tsunamiEventId(incoming);
    const unkeyed = (incoming.forecast ?? []).filter((item) =>
      incomingEventId == null || tsunamiForecastStateKey(incomingEventId, item) == null);
    return unkeyed.length === 0
      ? this.lastInfo
      : { ...this.lastInfo, forecast: [...(this.lastInfo.forecast ?? []), ...unkeyed] };
  }

  /**
   * コード付き部分取消後も同じ EventID の active state が残るかを、mutation 前に判定する。
   * gate は残存時に non-cancel watermark として commit する。
   */
  retainsEventAfterCancellation(info: ParsedTsunamiInfo): boolean {
    const eventId = tsunamiEventId(info);
    const forecast = info.forecast ?? [];
    if (eventId == null || forecast.length === 0) return false;
    const targetKeys = new Set(
      forecast.flatMap((item) => {
        const key = tsunamiForecastStateKey(eventId, item);
        return key == null ? [] : [key];
      }),
    );
    if (targetKeys.size === 0) return false;
    return [...this.keyedForecasts].some(([key, entry]) =>
      entry.eventId === eventId && !targetKeys.has(key));
  }

  applyAcceptedObservations(
    family: TsunamiObservationFamily,
    observations: readonly TsunamiObservationStation[],
  ): string[] {
    const merged = new Map(
      this.observationGroups[family].flatMap((item) => {
        const code = item.stationCode?.trim();
        return code ? [[code, item] as const] : [];
      }),
    );
    for (const item of observations) {
      const code = item.stationCode?.trim();
      // code 欠落 item は live presentation のみ。runtime seed state へは保持しない。
      if (code) {
        // 更新された観測点を末尾へ移し、上限到達時は最終更新が古い点から落とす。
        merged.delete(code);
        merged.set(code, item);
      }
    }
    const evictedCodes: string[] = [];
    while (merged.size > TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY) {
      const oldest = merged.keys().next().value as string | undefined;
      if (oldest == null) break;
      merged.delete(oldest);
      evictedCodes.push(oldest);
    }
    this.observationGroups[family] = structuredClone([...merged.values()]);
    return evictedCodes;
  }

  clearObservationFamily(family: TsunamiObservationFamily): void {
    this.observationGroups[family] = [];
  }

  restoreObservationGroups(groups: TsunamiObservationGroups): void {
    this.observationGroups = {
      VTSE51: structuredClone(groups.VTSE51.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)),
      VTSE52: structuredClone(groups.VTSE52.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)),
    };
  }

  restorePersistedState(
    active: ParsedTsunamiInfo | null,
    groups: TsunamiObservationGroups,
    keyedActive: readonly ParsedTsunamiInfo[] = [],
    legacyActive: ParsedTsunamiInfo | null = null,
  ): void {
    this.restoreObservationGroups(groups);
    this.clearActiveState();
    const restoredKeyedEventIds = new Set<string>();
    for (const persisted of keyedActive) {
      if (persisted.meta.infoType.value === "取消") continue;
      const eventId = tsunamiEventId(persisted);
      const forecast = persisted.forecast ?? [];
      if (
        eventId == null
        || forecast.length === 0
        || !forecast.every((item) => tsunamiForecastStateKey(eventId, item) != null)
      ) continue;
      this.applyAccepted(structuredClone(persisted));
      restoredKeyedEventIds.add(eventId);
    }
    // active は旧 scalar schema の adapter 入力だけとして残す。keyed schema
    // がある場合に同じ event を二重に復元しない。
    const restoredLegacy = legacyActive ?? (keyedActive.length === 0 ? active : null);
    if (restoredLegacy == null) return;
    const restored = structuredClone(restoredLegacy);
    if (restored.meta.infoType.value === "取消") return;
    const eventId = tsunamiEventId(restored);
    if (eventId != null && restoredKeyedEventIds.has(eventId)) return;
    const forecast = restored.forecast ?? [];
    const isFullyKeyed = eventId != null
      && forecast.length > 0
      && forecast.every((item) => tsunamiForecastStateKey(eventId, item) != null);
    // 完全 keyed payload は legacy 表示へ迂回させない。persistence reader が
    // gate 結合を証明した入力として canonical holder state へ昇格する。
    if (isFullyKeyed) {
      this.applyAccepted(restored);
      return;
    }
    const hasIncompleteCode = forecast.some((item) =>
      nonBlankCode(item.areaCode) == null || nonBlankCode(item.kindCode) == null);
    // legacy snapshot は表示だけに合成する。取消・revision gate・通知の判定には
    // 参加させず、同 EventID の正規通常報でのみ置換される。
    const level = resolveTsunamiLevel(
      (restored.forecast ?? []).map((item) => item.kind),
    )?.label ?? null;
    if (level != null && hasIncompleteCode) {
      this.legacyRestoredInfo = restored;
      this.rebuildActiveState();
    }
  }

  /** 共通 revision gate が受理した VTSE41 を active state へ反映する。 */
  applyAccepted(info: ParsedTsunamiInfo): void {
    const eventId = tsunamiEventId(info);
    const keyed = new Map<string, KeyedTsunamiForecastItem>();
    for (const item of info.forecast ?? []) {
      const key = eventId == null ? null : tsunamiForecastStateKey(eventId, item);
      if (key != null) keyed.set(key, { eventId: eventId!, item });
    }

    const forecast = info.forecast ?? [];
    const hasUnkeyedItem = keyed.size !== forecast.length;
    if (eventId != null && (forecast.length === 0 || keyed.size > 0)) {
      if (
        this.legacyRestoredInfo != null
        && tsunamiEventId(this.legacyRestoredInfo) === eventId
      ) {
        this.legacyRestoredInfo = null;
      }
      // 全 item が keyed の完全 snapshot だけ event 集合を置換する。
      // 混在報は unkeyed item に対応し得る旧 state を消さず、keyed 分だけ upsert する。
      if (!hasUnkeyedItem) {
        for (const [key, entry] of this.keyedForecasts) {
          if (entry.eventId === eventId) this.keyedForecasts.delete(key);
        }
      }
      for (const [key, entry] of keyed) this.keyedForecasts.set(key, entry);
      this.eventInfos.delete(eventId);
      if (keyed.size > 0) {
        const eventForecast = [...this.keyedForecasts.values()]
          .filter((entry) => entry.eventId === eventId)
          .map((entry) => entry.item);
        this.eventInfos.set(eventId, {
          ...info,
          forecast: eventForecast,
        });
      }
    }
    // item があるのに照合可能 key がゼロなら fail-open 表示だけに留める。
    this.rebuildActiveState();
  }

  /**
   * InfoType=取消 を、EventID で絞った keyed item state へだけ反映する。
   * item 名称は照合しない。コードを持たない item は解除対象にできない。
   */
  clearAccepted(info: ParsedTsunamiInfo): void {
    const eventId = tsunamiEventId(info);
    if (eventId == null) return;
    const forecast = info.forecast ?? [];
    const clearsWholeEvent = forecast.length === 0;
    const targetKeys = new Set(
      forecast.flatMap((item) => {
        const key = tsunamiForecastStateKey(eventId, item);
        return key == null ? [] : [key];
      }),
    );
    // コード欠落 item 付き取消は全体取消ではない。照合不能なら mutation しない。
    if (!clearsWholeEvent && targetKeys.size === 0) return;
    for (const [key, entry] of this.keyedForecasts) {
      if (entry.eventId === eventId && (clearsWholeEvent || targetKeys.has(key))) {
        this.keyedForecasts.delete(key);
      }
    }
    if (clearsWholeEvent) {
      this.eventInfos.delete(eventId);
    } else {
      const envelope = this.eventInfos.get(eventId);
      if (envelope != null) {
        const remaining = [...this.keyedForecasts.values()]
          .filter((entry) => entry.eventId === eventId)
          .map((entry) => entry.item);
        this.eventInfos.delete(eventId);
        if (remaining.length > 0) {
          this.eventInfos.set(eventId, { ...envelope, forecast: remaining });
        }
      }
    }
    this.rebuildActiveState();
    if (this.currentLevel == null) this.observationGroups = emptyObservationGroups();
  }

  /** 共通 clearCurrent decision を active state へ反映する。watermark は registry が保持する。 */
  clearActive(): void {
    this.clearActiveState();
    this.observationGroups = emptyObservationGroups();
  }

  /** 容量判断に使う、holder に現存する VTSE41 EventID。 */
  activeEventIds(): string[] {
    return [...this.eventInfos]
      .filter(([, info]) => resolveTsunamiLevel(
        (info.forecast ?? []).map((item) => item.kind),
      ) != null)
      .map(([eventId]) => eventId);
  }

  /** Remove VTSE41 holder content whose durable family subject has expired. */
  retainActiveEventIds(eventIds: readonly string[]): boolean {
    const retained = new Set(eventIds);
    const before = JSON.stringify({
      keyedForecasts: [...this.keyedForecasts],
      eventInfos: [...this.eventInfos],
      legacyRestoredInfo: this.legacyRestoredInfo,
    });
    for (const [key, entry] of [...this.keyedForecasts]) {
      if (!retained.has(entry.eventId)) this.keyedForecasts.delete(key);
    }
    for (const eventId of [...this.eventInfos.keys()]) {
      if (!retained.has(eventId)) this.eventInfos.delete(eventId);
    }
    const legacyId = this.legacyRestoredInfo == null
      ? null
      : tsunamiEventId(this.legacyRestoredInfo);
    if (legacyId != null && !retained.has(legacyId)) this.legacyRestoredInfo = null;
    this.rebuildActiveState();
    return before !== JSON.stringify({
      keyedForecasts: [...this.keyedForecasts],
      eventInfos: [...this.eventInfos],
      legacyRestoredInfo: this.legacyRestoredInfo,
    });
  }

  /** holder 全体を明示的にリセットする。 */
  clear(): void {
    this.clearActiveState();
    this.observationGroups = emptyObservationGroups();
  }

  private clearActiveState(): void {
    this.currentLevel = null;
    this.lastInfo = null;
    this.keyedForecasts.clear();
    this.eventInfos.clear();
    this.legacyRestoredInfo = null;
  }

  private rebuildActiveState(): void {
    const keyedForecast = [...this.keyedForecasts.values()].map((entry) => entry.item);
    const forecast = [
      ...(this.legacyRestoredInfo?.forecast ?? []),
      ...keyedForecast,
    ];
    const level = resolveTsunamiLevel(forecast.map((item) => item.kind))?.label ?? null;
    if (level == null) {
      this.currentLevel = null;
      this.lastInfo = null;
      return;
    }
    this.currentLevel = level;
    const envelope = [...this.eventInfos.values()].at(-1);
    const base = envelope ?? this.legacyRestoredInfo;
    this.lastInfo = base == null ? null : { ...base, forecast };
  }

  // ── PromptStatusProvider ──

  getPromptStatus(): PromptStatusSegment | null {
    if (this.currentLevel == null) return null;

    const role = LEVEL_ROLE[this.currentLevel];
    return {
      text: this.currentLevel,
      role,
      priority: 10,
    };
  }

  // ── DetailProvider ──

  getDetail(): DetailSnapshotOf<"tsunami"> | null {
    if (this.lastInfo == null) return null;
    return { kind: "tsunami", info: this.lastInfo };
  }

}
