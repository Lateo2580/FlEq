import type {
  ParsedWeatherWarning,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
} from "../../types";
import * as log from "../../logger";
import { selectPreferredWeatherLayer } from "../../dmdata/weather-parser";
import { resolvePhenomenonFamily, resolveDisplaySeverity, DISPLAY_SEVERITY_RANK } from "../../dmdata/weather-warning-level";
import { shortKindName } from "./vpws50-state";
import { weatherOfficeStreamKey } from "./weather-stream-key";

/**
 * 官署×type stream の上限。旧 holder が dormant watermark に課していた 128 件を、
 * common gate と active holder の双方へ適用する。実運用の発表官署数を十分上回りつつ、
 * 可変 subject が永続領域を無制限に占有しないための機械的な境界でもある。
 */
export const VPWW56_MAX_SUBJECTS = 128;

/** 旧 holder の dormant watermark と同じ取消 tombstone 保持期間。 */
export const VPWW56_TOMBSTONE_RETENTION_MS = 6 * 60 * 60 * 1000;

/** 市町村等を基準にした snapshot 世代。marker 欠落の旧府県粒度 state は復元しない。 */
export const VPWW56_SNAPSHOT_GENERATION = 1 as const;

export interface PersistedVpww56StreamV2 {
  /** 官署 stream 単位の粒度世代。欠落・不一致の stream は view を復元しない。 */
  generation?: typeof VPWW56_SNAPSHOT_GENERATION;
  subjectKey: string;
  view: Vpws50CurrentAreasForDisplay;
}

export interface PersistedVpww56StateV2 {
  generation: typeof VPWW56_SNAPSHOT_GENERATION;
  streams: PersistedVpww56StreamV2[];
  /** 旧粒度 view を破棄し、その官署の次報を待っている active subject。 */
  pendingSubjects?: string[];
}

export interface Vpww56StateSnapshot {
  version: number;
  state: PersistedVpww56StateV2;
}

/** project-event の ticker group と同じ `(type, publishingOffice)` 粒度。 */
export function vpww56StateSubjectKey(
  type: string,
  publishingOffice: string,
): string | null {
  return weatherOfficeStreamKey(type, publishingOffice);
}

/** release 以外の発表中 Kind が一つでもあるか。registry の deactivation 判定と共有する。 */
export function vpww56HasActiveAreas(info: ParsedWeatherWarning): boolean {
  return buildView(info) != null;
}

/**
 * VPWW56 の受理済み active view を `(head.type, publishingOffice)` 単位で保持する。
 * revision watermark／取消 tombstone は TelegramRevisionGate が唯一の所有者であり、
 * この holder は gate 通過後の mutation と表示 union だけを担う。
 */
export class Vpww56StateHolder {
  private readonly streams = new Map<string, Vpws50CurrentAreasForDisplay>();
  private readonly pendingSubjects = new Set<string>();
  private unionCache: Vpws50CurrentAreasForDisplay | undefined;
  private unionCacheValid = false;
  private ownerVersion = 0;
  private ownerFingerprint: string | null = null;

  private refreshVersion(): void {
    const next = JSON.stringify(this.exportPersistedState());
    if (this.ownerFingerprint != null && this.ownerFingerprint !== next) this.ownerVersion += 1;
    this.ownerFingerprint = next;
  }

  version(): number { this.refreshVersion(); return this.ownerVersion; }

  cloneSnapshot(): Vpww56StateSnapshot {
    this.refreshVersion();
    return { version: this.ownerVersion, state: structuredClone(this.exportPersistedState()) };
  }

  static fromSnapshot(snapshot: Vpww56StateSnapshot): Vpww56StateHolder {
    const holder = new Vpww56StateHolder();
    holder.loadSnapshot(snapshot, false);
    return holder;
  }

  replacePrevalidated(snapshot: Vpww56StateSnapshot): void { this.loadSnapshot(snapshot, true); }

  private loadSnapshot(snapshot: Vpww56StateSnapshot, commit: boolean): void {
    this.restorePersistedState(structuredClone(snapshot.state));
    this.ownerVersion = commit ? this.ownerVersion + 1 : snapshot.version;
    this.ownerFingerprint = null;
    this.refreshVersion();
  }

  applyAccepted(info: ParsedWeatherWarning, subjectKey: string): void {
    this.pendingSubjects.delete(subjectKey);
    const view = buildView(info);
    if (view == null) {
      this.clearSubject(subjectKey);
      return;
    }
    // common gate と同じ最終受理順にする。上限超過時の退場対象も一致する。
    this.streams.delete(subjectKey);
    this.streams.set(subjectKey, view);
    while (this.streams.size > VPWW56_MAX_SUBJECTS) {
      const oldest = this.streams.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.streams.delete(oldest);
    }
    this.unionCacheValid = false;
  }

  clearSubject(subjectKey: string): void {
    this.pendingSubjects.delete(subjectKey);
    if (this.streams.delete(subjectKey)) this.unionCacheValid = false;
  }

  /** holder 単体利用の互換入口。revision 判定は行わず、受理済み mutation として適用する。 */
  update(info: ParsedWeatherWarning, _legacyIdentity?: unknown): { kind: "updated" } {
    const subjectKey = vpww56StateSubjectKey(info.type, info.publishingOffice);
    if (subjectKey != null) {
      if (info.infoType === "取消") this.clearSubject(subjectKey);
      else this.applyAccepted(info, subjectKey);
    }
    return { kind: "updated" };
  }

  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    if (!this.unionCacheValid) {
      this.unionCache = this.buildUnion();
      this.unionCacheValid = true;
    }
    return this.unionCache;
  }

  trackedStreamCount(): number {
    return this.streams.size;
  }

  activeSubjectKeys(): string[] {
    return [...this.streams.keys()];
  }

  pendingSubjectKeys(): string[] {
    return [...this.pendingSubjects];
  }

  retainActiveSubjects(subjectKeys: readonly string[]): boolean {
    const retained = new Set(subjectKeys);
    let changed = false;
    for (const subjectKey of this.streams.keys()) {
      if (!retained.has(subjectKey)) {
        this.streams.delete(subjectKey);
        changed = true;
      }
    }
    for (const subjectKey of this.pendingSubjects) {
      if (!retained.has(subjectKey)) {
        this.pendingSubjects.delete(subjectKey);
        changed = true;
      }
    }
    if (changed) this.unionCacheValid = false;
    return changed;
  }

  exportPersistedState(): PersistedVpww56StateV2 {
    return {
      generation: VPWW56_SNAPSHOT_GENERATION,
      streams: [...this.streams].map(([subjectKey, view]) => ({
        generation: VPWW56_SNAPSHOT_GENERATION,
        subjectKey,
        view: structuredClone(view),
      })),
      pendingSubjects: [...this.pendingSubjects],
    };
  }

  restorePersistedState(state: PersistedVpww56StateV2): void {
    if (!isPersistedState(state)) {
      log.warn("[vpww56-state] persisted snapshot is incompatible; discarding it");
      this.streams.clear();
      this.pendingSubjects.clear();
      this.unionCache = undefined;
      this.unionCacheValid = false;
      return;
    }
    this.streams.clear();
    this.pendingSubjects.clear();
    for (const subjectKey of state.pendingSubjects ?? []) this.pendingSubjects.add(subjectKey);
    for (const stream of state.streams.slice(-VPWW56_MAX_SUBJECTS)) {
      this.streams.set(stream.subjectKey, structuredClone(stream.view));
    }
    this.unionCache = undefined;
    this.unionCacheValid = false;
  }

  private buildUnion(): Vpws50CurrentAreasForDisplay | undefined {
    const allAreas = new Set<string>();
    const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
    const seenAreas = new Map<string, Set<string>>();
    for (const view of this.streams.values()) {
      for (const group of view.kinds) {
        let merged = byKindCode.get(group.kindCode);
        let seen = seenAreas.get(group.kindCode);
        if (merged == null || seen == null) {
          merged = { ...group, areas: [] };
          seen = new Set<string>();
          byKindCode.set(group.kindCode, merged);
          seenAreas.set(group.kindCode, seen);
        }
        for (const area of group.areas) {
          allAreas.add(area.areaCode);
          if (seen.has(area.areaCode)) continue;
          seen.add(area.areaCode);
          merged.areas.push(area);
        }
      }
    }
    if (allAreas.size === 0) return undefined;
    const kinds = [...byKindCode.values()].sort(compareKindGroup);
    return { totalAreas: allAreas.size, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds };
  }
}

/** displaySeverity 降順、同 rank は kindCode 昇順。官署をまたいでも並びを決定的にする */
function compareKindGroup(a: Vpws50DisplayKindGroup, b: Vpws50DisplayKindGroup): number {
  const rankDiff = DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity];
  if (rankDiff !== 0) return rankDiff;
  if (a.kindCode === b.kindCode) return 0;
  return a.kindCode < b.kindCode ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPersistedView(value: unknown): value is Vpws50CurrentAreasForDisplay {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.totalAreas) || (value.totalAreas as number) < 0
    || !Number.isSafeInteger(value.specialAreas) || (value.specialAreas as number) < 0
    || !Number.isSafeInteger(value.warningAreas) || (value.warningAreas as number) < 0
    || !Number.isSafeInteger(value.advisoryAreas) || (value.advisoryAreas as number) < 0
    || !Array.isArray(value.kinds)
  ) return false;
  return value.kinds.every((group) =>
    isRecord(group)
    && typeof group.kindCode === "string"
    && typeof group.kindShortName === "string"
    && typeof group.kindName === "string"
    && typeof group.displaySeverity === "string"
    && (group.officialAlertLevel == null || (
      group.officialAlertLevel === 1 || group.officialAlertLevel === 2
      || group.officialAlertLevel === 3 || group.officialAlertLevel === 4
      || group.officialAlertLevel === 5
    ))
    && Array.isArray(group.areas)
    && group.areas.every((area) =>
      isRecord(area) && typeof area.areaName === "string" && typeof area.areaCode === "string"),
  );
}

function isPersistedState(value: unknown): value is PersistedVpww56StateV2 {
  if (!(isRecord(value)
    && value.generation === VPWW56_SNAPSHOT_GENERATION
    && Array.isArray(value.streams)
    && value.streams.length <= VPWW56_MAX_SUBJECTS
    && (value.pendingSubjects === undefined || (
      Array.isArray(value.pendingSubjects)
      && value.pendingSubjects.length <= VPWW56_MAX_SUBJECTS
      && value.pendingSubjects.every((subject) =>
        typeof subject === "string"
        && subject.startsWith("weather:VPWW56:")
        && subject.length > "weather:VPWW56:".length)
      && new Set(value.pendingSubjects).size === value.pendingSubjects.length
    ))
    && value.streams.every((stream) =>
      isRecord(stream)
      && stream.generation === VPWW56_SNAPSHOT_GENERATION
      && typeof stream.subjectKey === "string"
      && stream.subjectKey.startsWith("weather:VPWW56:")
      && stream.subjectKey.length > "weather:VPWW56:".length
      && isPersistedView(stream.view),
    ))) return false;
  const streamSubjects = value.streams.map((stream) => stream.subjectKey as string);
  const pendingSubjects = (value.pendingSubjects ?? []) as string[];
  return new Set(streamSubjects).size === streamSubjects.length
    && streamSubjects.length + pendingSubjects.length <= VPWW56_MAX_SUBJECTS
    && pendingSubjects.every((subject) => !streamSubjects.includes(subject));
}

/** 「市町村等」優先の layer から発表中 Kind (release 除外) を集約する。 */
function buildView(info: ParsedWeatherWarning): Vpws50CurrentAreasForDisplay | undefined {
  const layer = selectPreferredWeatherLayer(info.layers);
  if (layer == null) return undefined;
  const allAreas = new Set<string>();
  const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
  for (const item of layer.items) {
    for (const kind of item.kinds) {
      const family = resolvePhenomenonFamily(kind.code, kind.name);
      const resolved = resolveDisplaySeverity(kind.code, kind.name, family);
      if (resolved.displaySeverity === "release" || kind.severity === "release") continue;
      allAreas.add(item.areaCode);
      let group = byKindCode.get(kind.code);
      if (group == null) {
        group = {
          kindCode: kind.code,
          kindShortName: shortKindName(kind.name),
          kindName: kind.name,
          displaySeverity: resolved.displaySeverity,
          officialAlertLevel: resolved.officialAlertLevel,
          areas: [],
        };
        byKindCode.set(kind.code, group);
      }
      group.areas.push({ areaName: item.areaName, areaCode: item.areaCode });
    }
  }
  if (allAreas.size === 0) return undefined;
  return {
    totalAreas: allAreas.size,
    specialAreas: 0,
    warningAreas: 0,
    advisoryAreas: 0,
    kinds: [...byKindCode.values()].sort(compareKindGroup),
  };
}
