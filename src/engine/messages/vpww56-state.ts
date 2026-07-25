import type {
  ParsedWeatherWarning,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
} from "../../types";
import { resolvePhenomenonFamily, resolveDisplaySeverity, DISPLAY_SEVERITY_RANK } from "../../dmdata/weather-warning-level";
import * as log from "../../logger";
import {
  compareWeatherReportIdentity,
  shortKindName,
  weatherReportIdentityEquals,
  type WeatherReportIdentity,
} from "./vpws50-state";

export type Vpww56StateUpdateResult =
  | { kind: "updated" }
  | { kind: "suppressed" };

/** view を失った官署エントリを保持し続ける猶予。基準は壁時計ではなく受理済み報の最新 reportDateTime */
export const VPWW56_DORMANT_RETENTION_MS = 6 * 60 * 60 * 1000;

/** view を持たない官署エントリの上限。超過分は watermark の古い順に捨てる */
export const VPWW56_MAX_DORMANT_OFFICES = 128;

/** 1 発表官署ぶんの現況。view が undefined の間も watermark は残し、遅着した古い報を弾き続ける */
interface OfficeEntry {
  view: Vpws50CurrentAreasForDisplay | undefined;
  currentIdentity: WeatherReportIdentity | null;
  identityWatermark: WeatherReportIdentity;
}

/**
 * VPWW56 (土砂災害警戒情報) の発表中エリアを保持する state holder。
 * Vpws50StateHolder と異なり rich diff / history は持たない (present/absent のみ)。
 *
 * VPWW56 は府県予報区ごとに別の地方気象台が発表するため、view は発表官署単位で持ち、
 * 参照時に union して返す。単調性ガード (identity watermark) も官署ごとに独立させる。
 */
export class Vpww56StateHolder {
  private readonly offices = new Map<string, OfficeEntry>();
  private unionCache: Vpws50CurrentAreasForDisplay | undefined;
  private unionCacheValid = false;
  /** 受理した報の最新 reportDateTime (dormant 掃除の基準時刻) */
  private streamNowMs = Number.NEGATIVE_INFINITY;

  update(
    info: ParsedWeatherWarning,
    identity: WeatherReportIdentity = { reportDateTime: info.reportDateTime, serial: null },
  ): Vpww56StateUpdateResult {
    const office = info.publishingOffice;
    const entry = this.offices.get(office);

    if (info.infoType === "取消") {
      if (entry == null || !matchesCurrentReport(entry, identity)) {
        log.warn(
          `[vpww56-state] cancellation target does not match current report - ignored ` +
          `(office=${office}, reportDateTime=${identity.reportDateTime}, serial=${identity.serial ?? ""})`,
        );
        return { kind: "suppressed" };
      }
      entry.view = undefined;
      entry.currentIdentity = null;
      this.unionCacheValid = false;
      this.sweepDormant();
      return { kind: "updated" };
    }

    if (!canAdvanceTo(entry, identity)) {
      log.debug(
        `[vpww56-state] stale or duplicate report suppressed ` +
        `(office=${office}, reportDateTime=${identity.reportDateTime}, serial=${identity.serial ?? ""})`,
      );
      return { kind: "suppressed" };
    }

    const view = buildView(info);
    if (entry == null) {
      this.offices.set(office, { view, currentIdentity: identity, identityWatermark: identity });
    } else {
      entry.view = view;
      entry.currentIdentity = identity;
      entry.identityWatermark = identity;
    }
    this.unionCacheValid = false;
    this.advanceStreamClock(identity);
    this.sweepDormant();
    return { kind: "updated" };
  }

  /** 全発表官署の現況を union した 1 view。発表中の地域が 1 つも無ければ undefined */
  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    if (!this.unionCacheValid) {
      this.unionCache = this.buildUnion();
      this.unionCacheValid = true;
    }
    return this.unionCache;
  }

  /** 保持中の官署エントリ数 (view を失った猶予中のものを含む)。掃除の検証・診断用 */
  trackedOfficeCount(): number {
    return this.offices.size;
  }

  private buildUnion(): Vpws50CurrentAreasForDisplay | undefined {
    const allAreas = new Set<string>();
    const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
    const seenAreas = new Map<string, Set<string>>();
    for (const entry of this.offices.values()) {
      if (entry.view == null) continue;
      for (const group of entry.view.kinds) {
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
          // 府県予報区は官署ごとに排他だが、越境発表が来ても地域を二重に並べない
          if (seen.has(area.areaCode)) continue;
          seen.add(area.areaCode);
          merged.areas.push(area);
        }
      }
    }
    if (allAreas.size === 0) return undefined;
    const kinds = [...byKindCode.values()].sort(compareKindGroup);
    // specialAreas/warningAreas/advisoryAreas は気象カードでは未使用 (rank は displaySeverity 由来)。
    // 型を満たすため 0 を置く (VPWW56 は土砂災害単一種別で 3 段カウントの意味が薄い)
    return { totalAreas: allAreas.size, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds };
  }

  private advanceStreamClock(identity: WeatherReportIdentity): void {
    const ms = Date.parse(identity.reportDateTime);
    if (Number.isFinite(ms) && ms > this.streamNowMs) this.streamNowMs = ms;
  }

  private sweepDormant(): void {
    const dormant: { office: string; atMs: number }[] = [];
    for (const [office, entry] of this.offices) {
      if (entry.view != null) continue;
      dormant.push({ office, atMs: Date.parse(entry.identityWatermark.reportDateTime) });
    }
    if (dormant.length === 0) return;

    const retained: { office: string; atMs: number }[] = [];
    for (const candidate of dormant) {
      if (Number.isFinite(this.streamNowMs) && this.streamNowMs - candidate.atMs > VPWW56_DORMANT_RETENTION_MS) {
        this.offices.delete(candidate.office);
      } else {
        retained.push(candidate);
      }
    }
    if (retained.length <= VPWW56_MAX_DORMANT_OFFICES) return;

    retained.sort((a, b) => a.atMs - b.atMs);
    for (const stale of retained.slice(0, retained.length - VPWW56_MAX_DORMANT_OFFICES)) {
      this.offices.delete(stale.office);
    }
  }
}

function canAdvanceTo(entry: OfficeEntry | undefined, identity: WeatherReportIdentity): boolean {
  if (entry == null) return Number.isFinite(Date.parse(identity.reportDateTime));
  const comparison = compareWeatherReportIdentity(identity, entry.identityWatermark);
  return comparison != null && comparison > 0;
}

function matchesCurrentReport(entry: OfficeEntry, identity: WeatherReportIdentity): boolean {
  if (entry.currentIdentity == null) return false;
  return weatherReportIdentityEquals(identity, entry.currentIdentity) &&
    weatherReportIdentityEquals(identity, entry.identityWatermark);
}

/** displaySeverity 降順、同 rank は kindCode 昇順。官署をまたいでも並びを決定的にする */
function compareKindGroup(a: Vpws50DisplayKindGroup, b: Vpws50DisplayKindGroup): number {
  const rankDiff = DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity];
  if (rankDiff !== 0) return rankDiff;
  if (a.kindCode === b.kindCode) return 0;
  return a.kindCode < b.kindCode ? -1 : 1;
}

/** 「府県予報区等」layer から発表中 Kind (release 除外) を集約する。出力形は Vpws50StateHolder.buildCurrentAreasForDisplay と同じ */
function buildView(info: ParsedWeatherWarning): Vpws50CurrentAreasForDisplay | undefined {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (layer == null) return undefined;
  const allAreas = new Set<string>();
  const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
  for (const item of layer.items) {
    for (const k of item.kinds) {
      const family = resolvePhenomenonFamily(k.code, k.name);
      const resolved = resolveDisplaySeverity(k.code, k.name, family);
      if (resolved.displaySeverity === "release") continue;
      if (k.severity === "release") continue;
      allAreas.add(item.areaCode);
      let group = byKindCode.get(k.code);
      if (group == null) {
        group = {
          kindCode: k.code,
          kindShortName: shortKindName(k.name),
          kindName: k.name,
          displaySeverity: resolved.displaySeverity,
          officialAlertLevel: resolved.officialAlertLevel,
          areas: [],
        };
        byKindCode.set(k.code, group);
      }
      group.areas.push({ areaName: item.areaName, areaCode: item.areaCode });
    }
  }
  if (allAreas.size === 0) return undefined;
  const kinds = [...byKindCode.values()].sort(compareKindGroup);
  // specialAreas/warningAreas/advisoryAreas は気象カードでは未使用 (rank は displaySeverity 由来)。
  // 型を満たすため 0 を置く (VPWW56 は土砂災害単一種別で 3 段カウントの意味が薄い)
  return { totalAreas: allAreas.size, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds };
}
