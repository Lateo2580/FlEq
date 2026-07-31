import type {
  ParsedWeatherWarning,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
} from "../../types";
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

export interface PersistedVpww56StreamV2 {
  subjectKey: string;
  view: Vpws50CurrentAreasForDisplay;
}

export interface PersistedVpww56StateV2 {
  streams: PersistedVpww56StreamV2[];
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
  private unionCache: Vpws50CurrentAreasForDisplay | undefined;
  private unionCacheValid = false;

  applyAccepted(info: ParsedWeatherWarning, subjectKey: string): void {
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

  retainActiveSubjects(subjectKeys: readonly string[]): void {
    const retained = new Set(subjectKeys);
    let changed = false;
    for (const subjectKey of this.streams.keys()) {
      if (!retained.has(subjectKey)) {
        this.streams.delete(subjectKey);
        changed = true;
      }
    }
    if (changed) this.unionCacheValid = false;
  }

  exportPersistedState(): PersistedVpww56StateV2 {
    return {
      streams: [...this.streams].map(([subjectKey, view]) => ({
        subjectKey,
        view: structuredClone(view),
      })),
    };
  }

  restorePersistedState(state: PersistedVpww56StateV2): void {
    this.streams.clear();
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

/** 「府県予報区等」layer から発表中 Kind (release 除外) を集約する。 */
function buildView(info: ParsedWeatherWarning): Vpws50CurrentAreasForDisplay | undefined {
  const layer = info.layers.find((item) => item.type.includes("府県予報区等"));
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
