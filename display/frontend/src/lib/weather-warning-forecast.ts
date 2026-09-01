import type {
  ActiveStandbyCardV1,
  DisplayWeatherWarningForecastGroupV1,
  DisplayWeatherWarningForecastPeriodV1,
  DisplayWeatherWarningForecastTargetV1,
} from "./protocol";

export const WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM = 4;

export interface WeatherWarningForecastAtom {
  identity: string;
  fingerprint: string;
  label: string;
  accessibleLabel: string;
  continuation: string;
  group: DisplayWeatherWarningForecastGroupV1;
  target: DisplayWeatherWarningForecastTargetV1;
  periods: DisplayWeatherWarningForecastPeriodV1[];
  pagerAnchorKey: string;
  pagerAnchorOrdinal: number;
}

export function vpwp50ForecastTargetLabel(
  target: DisplayWeatherWarningForecastTargetV1,
): string {
  const parent = target.areaCode == null
    ? target.parentAreaName
    : `${target.parentAreaName}（${target.areaCode}）`;
  if (target.scope === "area") return parent;
  const local = target.localCode == null
    ? target.name
    : `${target.name}（${target.localCode}）`;
  return `${parent} / ${local}`;
}

function periodOrder(
  left: DisplayWeatherWarningForecastPeriodV1,
  right: DisplayWeatherWarningForecastPeriodV1,
): number {
  return left.pagerAnchorOrdinal - right.pagerAnchorOrdinal
    || left.pagerSlot - right.pagerSlot
    || Date.parse(left.startsAt) - Date.parse(right.startsAt)
    || Date.parse(left.endsAt) - Date.parse(right.endsAt)
    || left.tsNum - right.tsNum
    || (left.series < right.series ? -1 : left.series > right.series ? 1 : 0)
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

export function buildWeatherWarningForecastAtoms(
  item: Extract<ActiveStandbyCardV1, { kind: "weatherWarningForecast" }>,
): WeatherWarningForecastAtom[] {
  const pending: Array<Omit<WeatherWarningForecastAtom,
    "fingerprint" | "accessibleLabel" | "continuation">> = [];
  for (const group of item.data.groups) {
    for (const target of group.targets) {
      const byAnchor = new Map<string, DisplayWeatherWarningForecastPeriodV1[]>();
      for (const period of [...target.periods].sort(periodOrder)) {
        const values = byAnchor.get(period.pagerAnchorKey) ?? [];
        values.push(period);
        byAnchor.set(period.pagerAnchorKey, values);
      }
      const anchors = [...byAnchor].sort((left, right) =>
        (left[1][0]?.pagerAnchorOrdinal ?? 0) - (right[1][0]?.pagerAnchorOrdinal ?? 0)
        || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      for (const [pagerAnchorKey, periods] of anchors) {
        if (periods.length === 0 || periods.length > WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM) continue;
        const targetLabel = vpwp50ForecastTargetLabel(target);
        pending.push({
          identity: JSON.stringify([group.key, target.key, pagerAnchorKey]),
          label: `${group.forecastLabel} / ${targetLabel}`,
          group,
          target,
          periods,
          pagerAnchorKey,
          pagerAnchorOrdinal: periods[0]!.pagerAnchorOrdinal,
        });
      }
    }
  }
  return pending.map((atom, index) => {
    const continuation = `続き ${index + 1}/${pending.length}`;
    const accessibleLabel = `${atom.label} / ${atom.periods.map((period) => period.label).join(" / ")}`;
    const fingerprint = JSON.stringify([
      atom.group.key,
      atom.target.key,
      atom.label,
      atom.pagerAnchorKey,
      atom.pagerAnchorOrdinal,
      atom.group.severity,
      ...atom.periods.map((period) => [
        period.key,
        period.label,
        period.startsAt,
        period.endsAt,
        period.tsNum,
        period.series,
        period.pagerSlot,
      ]),
      continuation,
    ]);
    return { ...atom, continuation, accessibleLabel, fingerprint };
  });
}
