import type {
  DisplayWeatherAlertV1,
  DisplayWeatherExpandedKindV1,
} from "./protocol";

// KINDS-SYNC-BEGIN
// このマーカー間は display/frontend/src/lib/weather-expanded-kinds.ts と手動複製する。
// 同一入力 fixture の出力一致を test/engine/display/weather-expanded-kinds-sync.test.ts で検証する。

export interface WeatherKindKeyInput {
  displaySeverity: string;
  kind: string;
  phenomenonKey?: string | null;
}

/**
 * 気象警報の表示単位キーを一括で正規化する。
 * phenomenonKey が無い旧 item は、同じ表示 alias に安定キー候補が 1 つだけある場合だけ
 * その候補へ寄せる。候補が複数ある曖昧 alias は統合せず、従来の severity|kind を保つ。
 */
export function resolveWeatherKindKeys(items: readonly WeatherKindKeyInput[]): string[] {
  const phenomenonKeysByAlias = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.phenomenonKey == null) continue;
    const alias = `${item.displaySeverity}|${item.kind}`;
    const candidates = phenomenonKeysByAlias.get(alias) ?? new Set<string>();
    candidates.add(`${item.displaySeverity}|${item.phenomenonKey}`);
    phenomenonKeysByAlias.set(alias, candidates);
  }

  return items.map((item) => {
    if (item.phenomenonKey != null) return `${item.displaySeverity}|${item.phenomenonKey}`;
    const alias = `${item.displaySeverity}|${item.kind}`;
    const candidates = phenomenonKeysByAlias.get(alias);
    return candidates?.size === 1 ? [...candidates][0]! : alias;
  });
}

const WEATHER_EXPANDED_AREA_LIMIT = 128;

const WEATHER_ROLE_RANK: Record<DisplayWeatherAlertV1["role"], number> = {
  weatherEmergency: 3,
  weatherWarning: 2,
  weatherAdvisory: 1,
};

interface WeatherExpandedKindAccumulator {
  kindKey: string;
  areas: WeatherExpandedArea[];
  areaSet: Set<string>;
  omittedAreaCount: number;
}

interface WeatherExpandedArea {
  area: string;
  areaCode: string | null;
}

/** XML Area.Code があれば地域 identity に使い、旧形式だけ名称へ fallback する。 */
export function weatherAreaIdentity(area: string, areaCode?: string | null): string {
  return areaCode == null || areaCode === "" ? `name:${area}` : `code:${areaCode}`;
}

/** weatherAlerts の source 横断 union を、表示単位ごとの canonical prefix へ集約する。 */
export function collectWeatherExpandedKinds(
  alerts: readonly DisplayWeatherAlertV1[],
): DisplayWeatherExpandedKindV1[] {
  const highestRoleRank = Math.max(
    0,
    ...alerts.map((alert) => WEATHER_ROLE_RANK[alert.role]),
  );
  const items = alerts
    .filter((alert) => WEATHER_ROLE_RANK[alert.role] === highestRoleRank)
    .flatMap((alert) => alert.items);
  const kindKeys = resolveWeatherKindKeys(items);
  const byKind = new Map<string, WeatherExpandedKindAccumulator>();

  items.forEach((item, index) => {
    const kindKey = kindKeys[index]!;
    const existing = byKind.get(kindKey);
    const accumulator = existing ?? {
      kindKey,
      areas: [],
      areaSet: new Set<string>(),
      omittedAreaCount: 0,
    };
    for (const [areaIndex, area] of item.shownAreas.entries()) {
      const areaCode = item.shownAreaCodes?.[areaIndex] ?? null;
      const identity = weatherAreaIdentity(area, areaCode);
      if (accumulator.areaSet.has(identity)) continue;
      accumulator.areaSet.add(identity);
      accumulator.areas.push({ area, areaCode });
    }
    accumulator.omittedAreaCount += item.omittedAreaCount;
    if (existing == null) byKind.set(kindKey, accumulator);
  });

  const candidates = [...byKind.values()].map((candidate) => ({
    candidate,
    currentAreas: [...candidate.areas],
    totalAreaCount: candidate.areas.length + candidate.omittedAreaCount,
  }));
  const currentAreaTotal = candidates.reduce((total, candidate) =>
    total + candidate.currentAreas.length, 0);
  // 二段配分。通常は全 kind の現行表示分を予約し、残余だけを追加候補へ配る。
  // 現行表示だけで上限を超える不変条件外入力は、発表順で現行表示を優先して安全弁を適用する。
  let remainingCurrent = WEATHER_EXPANDED_AREA_LIMIT;
  const reservedCurrentAreas = candidates.map(({ currentAreas }) => {
    if (currentAreaTotal <= WEATHER_EXPANDED_AREA_LIMIT) return currentAreas;
    const areas = currentAreas.slice(0, remainingCurrent);
    remainingCurrent -= areas.length;
    return areas;
  });
  let remaining = Math.max(
    0,
    WEATHER_EXPANDED_AREA_LIMIT - reservedCurrentAreas.reduce((total, areas) => total + areas.length, 0),
  );
  return candidates.map(({ candidate, totalAreaCount }, index) => {
    const currentAreas = reservedCurrentAreas[index]!;
    const additionalAreas: WeatherExpandedArea[] = [];
    const additions = additionalAreas.slice(0, remaining);
    remaining -= additions.length;
    const areas = [...currentAreas, ...additions];
    return {
      kindKey: candidate.kindKey,
      areas: areas.map(({ area }) => area),
      ...(areas.some(({ areaCode }) => areaCode != null)
        ? { areaCodes: areas.map(({ areaCode }) => areaCode ?? "") }
        : {}),
      totalAreaCount,
      candidateTruncated: areas.length < totalAreaCount,
    };
  });
}

export const WEATHER_EXPANDED_KINDS: unique symbol = Symbol("weatherExpandedKinds");

export interface WeatherAlertsSnapshotV1 extends Array<DisplayWeatherAlertV1> {
  [WEATHER_EXPANDED_KINDS]?: DisplayWeatherExpandedKindV1[];
}

/** 候補を配列の非列挙 metadata として供給側から snapshot owner へ渡す。 */
export function attachWeatherExpandedKinds(
  alerts: DisplayWeatherAlertV1[],
): WeatherAlertsSnapshotV1 {
  Object.defineProperty(alerts, WEATHER_EXPANDED_KINDS, {
    value: collectWeatherExpandedKinds(alerts),
    enumerable: false,
  });
  return alerts as WeatherAlertsSnapshotV1;
}

// KINDS-SYNC-END
