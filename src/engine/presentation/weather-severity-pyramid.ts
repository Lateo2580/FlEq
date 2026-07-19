import type {
  ParsedWeatherWarningTimeseriesInfo,
  TimeWindow,
  SignificancyCriteriaPeriod,
  SignificancyPeakTime,
  WeatherWarningTimeseriesNumber,
  DisplaySeverity,
  OfficialAlertLevel,
  ResolutionSource,
} from "../../types";
import {
  classifySignificancyCode,
} from "../../dmdata/weather-warning-timeseries-significancy";
import {
  resolveVpwp50Significancy,
} from "../../dmdata/weather-warning-level";

export type WeatherSeverity = "special" | "warning" | "advisory" | "unknown";

/**
 * Pyramid 表示の対象となる既知 severity 集合。
 * SignificancySeverity ({none|below|advisory|warning|special|unknown}) のうち
 * `none`/`below` (＝注意報未満 / 発表なし) は pyramid 表示から除外する。
 */
const KNOWN_VISIBLE: ReadonlySet<WeatherSeverity> = new Set([
  "special",
  "warning",
  "advisory",
]);

export type Vpwp50Series = "3h" | "24h" | "day";

export interface SeriesWindow {
  series: Vpwp50Series;
  timeRef: string;
  window?: TimeWindow;
  peak?: SignificancyPeakTime;
  criteriaPeriod?: SignificancyCriteriaPeriod;
  /** v3 新規: 系列番号 (1: 3h, 2: 24h, 3: day) — formatTimeWindowWithHours で使う */
  tsNum: 1 | 2 | 3;
}

export interface WeatherSeverityEntry {
  /** v3.2 新規: stable entry id (ClipReport キー用) */
  id: string;
  phenomenon: string;
  kindLabel: string;
  severity: WeatherSeverity;
  areaName: string;
  code: string;
  windows: SeriesWindow[];
  unknownCode?: string;
  /** v3 新規: 自然語化前の Property.Type (= phenomenon のエイリアス、明示用) */
  propertyType: string;
  /** v3 新規: Local 細分の名前リスト (Base entry のみ非空、Local entry は []) */
  localAreaNames: string[];
  /** v3 新規: この entry に紐づく未知 Code リスト (普通は単数、複数可) */
  unknownCodes: string[];
  /** v3.2 新規: code のエイリアス (明示用、entry id 組み立てに使う) */
  worstCode: string;
  /** v3.2 新規: Local 由来なら Local.AreaName、Base 由来なら "" */
  localKey: string;
  /** Phase B: 2 系統表示重大度 (resolveVpwp50Significancy 由来、unknown entry は "unknown") */
  displaySeverity: DisplaySeverity;
  /** Phase B: 公式警戒レベル相当 (alertLevel 系のみ、grade 系は null) */
  officialAlertLevel: OfficialAlertLevel | null;
  /** Phase B: 解決ソース (map / unknown) */
  resolutionSource: ResolutionSource;
}

function buildEntryId(
  propertyType: string,
  areaName: string,
  displaySeverity: DisplaySeverity,
  worstCode: string,
  localKey: string,
): string {
  return `${propertyType}|${areaName}|${displaySeverity}|${worstCode}|${localKey}`;
}

export function flattenEntries(info: ParsedWeatherWarningTimeseriesInfo): WeatherSeverityEntry[] {
  const map = new Map<string, WeatherSeverityEntry>();

  for (const area of info.areas) {
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      const series = seriesOf(tsNum);
      for (const kind of area.kinds[tsNum]) {
        if (kind.partKind !== "Significancy" || kind.significancyWorst == null) continue;
        const collect = (
          value: typeof kind.significancyWorst.base,
          areaLabel: string,
          localKey: string,
        ): void => {
          if (value == null) return;
          let sev: WeatherSeverity;
          if (!value.info.known) {
            sev = "unknown";
          } else if (KNOWN_VISIBLE.has(value.info.severity as WeatherSeverity)) {
            sev = value.info.severity as WeatherSeverity;
          } else {
            // below / none — pyramid 表示の対象外、skip
            return;
          }
          const key = `${kind.type}::${areaLabel}::${value.info.code}`;
          const slice: SeriesWindow = {
            series,
            timeRef: value.timeRef,
            window: value.timeWindow,
            peak: value.peak,
            criteriaPeriod: value.criteriaPeriod,
            tsNum,
          };
          const existing = map.get(key);
          if (existing == null) {
            const propertyType = kind.type;
            const worstCode = value.info.code;
            // Phase B: resolve 2-track display severity fields
            const sigInfo = classifySignificancyCode(propertyType, value.info.code);
            const resolved = resolveVpwp50Significancy(sigInfo);
            const displaySeverity: DisplaySeverity = resolved?.displaySeverity ?? "unknown";
            const officialAlertLevel: OfficialAlertLevel | null = resolved?.officialAlertLevel ?? null;
            const resolutionSource: ResolutionSource = resolved?.source ?? "unknown";
            const id = buildEntryId(propertyType, areaLabel, displaySeverity, worstCode, localKey);
            map.set(key, {
              id,
              phenomenon: kind.type,
              kindLabel: value.info.known ? value.info.compact : `?${value.info.code}`,
              severity: sev,
              areaName: areaLabel,
              code: value.info.code,
              windows: [slice],
              unknownCode: value.info.known ? undefined : value.info.code,
              propertyType,
              localAreaNames: [],
              unknownCodes: value.info.known ? [] : [value.info.code],
              worstCode,
              localKey,
              displaySeverity,
              officialAlertLevel,
              resolutionSource,
            });
            return;
          }
          const dup = existing.windows.some(
            (w) => w.series === slice.series && w.timeRef === slice.timeRef,
          );
          if (!dup) existing.windows.push(slice);
        };
        collect(kind.significancyWorst.base ?? undefined, area.name, "");
        for (const local of kind.significancyWorst.locals ?? []) {
          const localName = local.areaName ?? "";
          const localLabel = local.areaName
            ? `${area.name}/${local.areaName}`
            : area.name;
          collect(local.value, localLabel, localName);
        }
      }
    }
  }

  for (const entry of map.values()) {
    entry.windows.sort((a, b) => SERIES_ORDER[a.series] - SERIES_ORDER[b.series]);
  }

  const entries = Array.from(map.values());

  // 後付け: Base entry (localKey === "") に対し、同じ propertyType を共有し
  // areaName が "<base.areaName>/..." で始まる Local entries の Local 名を集める。
  // entry 数は最大数十なので O(N^2) で十分。
  const baseEntries = entries.filter((e) => e.localKey === "");
  for (const base of baseEntries) {
    const sameKindLocals = entries.filter(
      (e) =>
        e.localKey !== "" &&
        e.propertyType === base.propertyType &&
        e.areaName.startsWith(`${base.areaName}/`),
    );
    base.localAreaNames = sameKindLocals.map((e) => e.localKey);
  }

  return entries;
}

function seriesOf(n: WeatherWarningTimeseriesNumber): Vpwp50Series {
  return n === 1 ? "3h" : n === 2 ? "24h" : "day";
}

const SERIES_ORDER: Record<Vpwp50Series, number> = { "3h": 1, "24h": 2, day: 3 };
const SERIES_LABEL: Record<Vpwp50Series, string> = { "3h": "3h", "24h": "24h", day: "日" };

type SeriesWindowForFormatting = Pick<
  SeriesWindow,
  "series" | "timeRef" | "window" | "peak" | "criteriaPeriod"
>;

function formatOneWindow(w: SeriesWindowForFormatting): string {
  if (!w.window) return `枠${w.timeRef}`;
  const tw = w.window;
  if (tw.count <= 1) return tw.startName;
  if (tw.contiguous) return `${tw.startName}-${tw.endName}(${tw.count}枠)`;
  return `${tw.startName}ほか${tw.count - 1}枠`;
}

export function formatSeriesWindows(windows: SeriesWindowForFormatting[]): string | null {
  if (windows.length === 0) return null;
  if (windows.length === 1) return formatOneWindow(windows[0]);
  return windows
    .map((w) => `${SERIES_LABEL[w.series]}:${formatOneWindow(w)}`)
    .join(" / ");
}

export function formatPeakBySeries(
  windows: SeriesWindowForFormatting[],
  alwaysPrefix = false,
): string | null {
  const peaks = windows.filter((w) => w.peak != null);
  if (peaks.length === 0) return null;
  const prefix = alwaysPrefix || peaks.length > 1;
  if (!prefix) {
    const p = peaks[0].peak;
    if (p == null) return null;
    return `${p.date}${p.term}`;
  }
  return peaks
    .map((w) => {
      const p = w.peak;
      const text = p == null ? "" : `${p.date}${p.term}`;
      return `${SERIES_LABEL[w.series]}:${text}`;
    })
    .join(" / ");
}

export function formatCriteriaTimeBySeries(
  windows: SeriesWindowForFormatting[],
  alwaysPrefix = false,
): string | null {
  const items = windows.filter((w) => w.criteriaPeriod != null);
  if (items.length === 0) return null;
  const fmt = (iso: string): string => {
    const m = iso.match(/^\d{4}-\d{2}-(\d{2})T(\d{2}):(\d{2})/);
    return m ? `${m[1]} ${m[2]}:${m[3]}` : iso.slice(0, 8);
  };
  const prefix = alwaysPrefix || items.length > 1;
  if (!prefix) {
    const cp = items[0].criteriaPeriod;
    if (cp == null) return null;
    return fmt(cp.time);
  }
  return items
    .map((w) => {
      const cp = w.criteriaPeriod;
      const text = cp == null ? "" : fmt(cp.time);
      return `${SERIES_LABEL[w.series]}:${text}`;
    })
    .join(" / ");
}

export interface SeverityPartition<T extends { severity: WeatherSeverity }> {
  special: T[];
  warning: T[];
  advisory: T[];
  unknown: T[];
}

export function partitionBySeverity<T extends { severity: WeatherSeverity }>(
  entries: T[],
): SeverityPartition<T> {
  const part: SeverityPartition<T> = { special: [], warning: [], advisory: [], unknown: [] };
  for (const e of entries) {
    part[e.severity].push(e);
  }
  return part;
}

export interface AdvisorySummary {
  phenomenon: string;
  count: number;
}

export function summarizeAdvisoryByPhenomenon(advisory: WeatherSeverityEntry[]): AdvisorySummary[] {
  const byPhenom = new Map<string, Set<string>>();
  for (const e of advisory) {
    const set = byPhenom.get(e.phenomenon) ?? new Set<string>();
    set.add(e.areaName);
    byPhenom.set(e.phenomenon, set);
  }
  return Array.from(byPhenom.entries())
    .map(([phenomenon, set]) => ({ phenomenon, count: set.size }))
    .sort((a, b) => b.count - a.count || a.phenomenon.localeCompare(b.phenomenon));
}
