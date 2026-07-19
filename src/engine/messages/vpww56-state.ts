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

/**
 * VPWW56 (土砂災害警戒情報) の発表中エリアを単純保持する state holder。
 * Vpws50StateHolder と異なり rich diff / history は持たない (present/absent のみ)。
 */
export class Vpww56StateHolder {
  private view: Vpws50CurrentAreasForDisplay | undefined;
  private currentIdentity: WeatherReportIdentity | null = null;
  private identityWatermark: WeatherReportIdentity | null = null;

  update(
    info: ParsedWeatherWarning,
    identity: WeatherReportIdentity = { reportDateTime: info.reportDateTime, serial: null },
  ): Vpww56StateUpdateResult {
    if (info.infoType === "取消") {
      if (!this.matchesCurrentReport(identity)) {
        log.warn(
          `[vpww56-state] cancellation target does not match current report - ignored ` +
          `(reportDateTime=${identity.reportDateTime}, serial=${identity.serial ?? ""})`,
        );
        return { kind: "suppressed" };
      }
      this.view = undefined;
      this.currentIdentity = null;
      return { kind: "updated" };
    }

    if (!this.canAdvanceTo(identity)) {
      log.debug(
        `[vpww56-state] stale or duplicate report suppressed ` +
        `(reportDateTime=${identity.reportDateTime}, serial=${identity.serial ?? ""})`,
      );
      return { kind: "suppressed" };
    }

    this.view = buildView(info);
    this.currentIdentity = identity;
    this.identityWatermark = identity;
    return { kind: "updated" };
  }

  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    return this.view;
  }

  private canAdvanceTo(identity: WeatherReportIdentity): boolean {
    if (this.identityWatermark == null) {
      return Number.isFinite(Date.parse(identity.reportDateTime));
    }
    const comparison = compareWeatherReportIdentity(identity, this.identityWatermark);
    return comparison != null && comparison > 0;
  }

  private matchesCurrentReport(identity: WeatherReportIdentity): boolean {
    if (this.currentIdentity == null || this.identityWatermark == null) return false;
    return weatherReportIdentityEquals(identity, this.currentIdentity) &&
      weatherReportIdentityEquals(identity, this.identityWatermark);
  }
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
  const kinds = [...byKindCode.values()].sort(
    (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
  );
  // specialAreas/warningAreas/advisoryAreas は気象カードでは未使用 (rank は displaySeverity 由来)。
  // 型を満たすため 0 を置く (VPWW56 は土砂災害単一種別で 3 段カウントの意味が薄い)
  return { totalAreas: allAreas.size, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds };
}
