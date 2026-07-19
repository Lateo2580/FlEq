import { dig, str } from "./telegram-parser";
import {
  listOf,
  nodeText,
  buildTimeDefineMap,
  parseJmxEbElement,
  type TimeDefineEntry,
} from "./timeseries-common";
import type {
  WeatherExplanationForecast,
  ForecastTimeSeries,
  ForecastTimeDefine,
  ForecastEvent,
  ForecastMetricArea,
  ForecastMetricValue,
  ForecastLocalGroup,
  ForecastPhase,
} from "../types";

/** forecast 用: Part タグ → メトリック値タグ名 (1 対 1)。
 *  WindDirection は value=null になるが raw に値が入る。 */
const FORECAST_PART_TO_TAG: Record<string, string> = {
  WindSpeedPart: "jmx_eb:WindSpeed",
  PrecipitationPart: "jmx_eb:Precipitation",
  WaveHeightPart: "jmx_eb:WaveHeight",
  WindDirectionPart: "jmx_eb:WindDirection",
  SnowfallDepthPart: "jmx_eb:SnowfallDepth",
};

/** Area.Name "（四国地方）高知県" → { regionLabel:"四国地方", areaName:"高知県" } */
function splitRegionLabel(fullName: string): { regionLabel: string | null; areaName: string } {
  // JMA 電文の Area.Name は全角括弧（）のみ。半角括弧/括弧なしは regionLabel=null に縮退
  const m = fullName.match(/^（(.+?)）(.+)$/);
  if (m) return { regionLabel: m[1], areaName: m[2] };
  return { regionLabel: null, areaName: fullName };
}

/** Item 直下の Area から name/codes/primaryCode を取り出す */
function areaOf(item: unknown): { name: string; codes: string[]; primaryCode: string } {
  const areas = listOf(dig(item, "Area"));
  const a = areas[0];
  const name = str(dig(a, "Name"));
  const codeText = nodeText(dig(a, "Code"));
  const codeListText = nodeText(dig(a, "CodeList"));
  let codes: string[];
  if (codeText) {
    codes = [codeText];
  } else if (codeListText) {
    codes = codeListText.split(/\s+/).filter((c) => c.length > 0);
  } else {
    codes = [];
  }
  return { name, codes, primaryCode: codes[0] ?? "" };
}

function resolveTimeName(refID: string, map: Map<string, TimeDefineEntry>): string | null {
  return map.get(refID)?.name ?? null;
}

/** EventPart の Item を ForecastEvent[] に */
function extractEvents(item: unknown, map: Map<string, TimeDefineEntry>): ForecastEvent[] {
  const out: ForecastEvent[] = [];
  const { name: areaFull, primaryCode: code } = areaOf(item);
  const { regionLabel, areaName: regionArea } = splitRegionLabel(areaFull);
  for (const kind of listOf(dig(item, "Kind"))) {
    for (const prop of listOf(dig(kind, "Property"))) {
      const eventPart = dig(prop, "EventPart");
      if (eventPart == null) continue;
      const base = dig(eventPart, "Base");
      const locals = listOf(dig(base, "Local"));
      // Local があれば各 Local の AreaName、無ければ Base 直下 Event を地方名で (Codex plan R2 fallback)
      const sources: { areaName: string; events: unknown[] }[] =
        locals.length > 0
          ? locals.map((l) => ({
              areaName: str(dig(l, "AreaName")) || regionArea,
              events: listOf(dig(l, "Event")),
            }))
          : [{ areaName: regionArea, events: listOf(dig(base, "Event")) }];
      for (const src of sources) {
        for (const ev of src.events) {
          const refID = str(dig(ev, "@_refID"));
          out.push({
            areaName: src.areaName,
            regionLabel,
            code,
            eventType: str(dig(ev, "@_type")),
            eventName: str(dig(ev, "EventName")),
            sentence: str(dig(ev, "Sentence")),
            timeRef: refID,
            timeName: resolveTimeName(refID, map),
            time: str(dig(ev, "Time")) || null,
            duration: str(dig(ev, "Duration")) || null,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 定量 Part の Item を ForecastMetricArea | null に。
 *
 * locals[].phases[].values[] の 4 階層に対応:
 *  - Base / Becoming それぞれ独立に Local 正規化
 *  - Local 無しは areaName=null の単一 LocalGroup
 *  - 同一 LocalGroup 内では Base (ordinal=0) → Becoming1 (1) → Becoming2 (2) ... の順
 *  - 同 Property に複数 Part 同居 (例: WindDirectionPart + WindSpeedPart) する場合、
 *    (areaName, kind, ordinal) が一致する phase の values に append (merge)
 *  - 同じ modifier の Becoming 複数連は ordinal で別 phase として保持 (Codex R2 Strong 1)
 *
 * 同一 Kind 内の Property 複数 (listOf) は同一 metric type 前提で values に集約する。
 */
function extractMetricArea(item: unknown, map: Map<string, TimeDefineEntry>): ForecastMetricArea | null {
  const { name, codes, primaryCode } = areaOf(item);
  let metricType = "";
  // localAreaName → InternalPhase[] (ordinal を内部保持)
  type InternalPhase = { kind: "base" | "becoming"; modifier: string | null; values: ForecastMetricValue[]; ordinal: number };
  const localGroupsByName = new Map<string | null, InternalPhase[]>();

  const mergeOrAddPhase = (
    areaName: string | null,
    kind: "base" | "becoming",
    ordinal: number,
    modifier: string | null,
    values: ForecastMetricValue[],
  ) => {
    if (values.length === 0) return;
    const phases = localGroupsByName.get(areaName) ?? [];
    const existing = phases.find((p) => p.kind === kind && p.ordinal === ordinal);
    if (existing != null) {
      existing.values.push(...values);
    } else {
      phases.push({ kind, modifier, values, ordinal });
    }
    localGroupsByName.set(areaName, phases);
  };

  for (const kind of listOf(dig(item, "Kind"))) {
    for (const prop of listOf(dig(kind, "Property"))) {
      metricType = str(dig(prop, "Type")) || metricType;
      for (const [partTag, valueTag] of Object.entries(FORECAST_PART_TO_TAG)) {
        const part = dig(prop, partTag);
        if (part == null) continue;
        const base = dig(part, "Base");
        if (base != null) {
          const baseLocals = listOf(dig(base, "Local"));
          if (baseLocals.length > 0) {
            for (const loc of baseLocals) {
              const localAreaName = str(dig(loc, "AreaName")) || null;
              const vals = collectValues(loc, valueTag, map);
              mergeOrAddPhase(localAreaName, "base", 0, null, vals);
            }
          } else {
            const vals = collectValues(base, valueTag, map);
            mergeOrAddPhase(null, "base", 0, null, vals);
          }
        }
        const becomingList = listOf(dig(part, "Becoming"));
        becomingList.forEach((becoming, becomingIdx) => {
          const ordinal = becomingIdx + 1;
          const modifier = str(dig(becoming, "TimeModifier")) || null;
          const bLocals = listOf(dig(becoming, "Local"));
          if (bLocals.length > 0) {
            for (const loc of bLocals) {
              const localAreaName = str(dig(loc, "AreaName")) || null;
              const vals = collectValues(loc, valueTag, map);
              mergeOrAddPhase(localAreaName, "becoming", ordinal, modifier, vals);
            }
          } else {
            const vals = collectValues(becoming, valueTag, map);
            mergeOrAddPhase(null, "becoming", ordinal, modifier, vals);
          }
        });
      }
    }
  }
  if (localGroupsByName.size === 0) return null;
  // ordinal フィールドを除いて公開型 (ForecastPhase) に
  const locals: ForecastLocalGroup[] = [...localGroupsByName.entries()]
    .map(([areaName, phases]) => ({
      areaName,
      phases: phases.map(({ kind, modifier, values }): ForecastPhase => ({ kind, modifier, values })),
    }));
  return { areaName: name, codes, primaryCode, metricType, locals };
}

function collectValues(parent: unknown, valueTag: string, map: Map<string, TimeDefineEntry>): ForecastMetricValue[] {
  const out: ForecastMetricValue[] = [];
  for (const raw of listOf(dig(parent, valueTag))) {
    const el = parseJmxEbElement(raw);
    out.push({
      timeRef: el.refID,
      timeName: resolveTimeName(el.refID, map),
      subType: el.type,
      unit: el.unit,
      value: el.value,
      condition: el.condition,
      description: el.description,
      raw: el.raw,
    });
  }
  return out;
}

/**
 * Text を @type で intro/supplement/element に振り分け
 *
 * 時系列解説の扱い:
 * - 同一 Property 内に複数ある場合 = TimeDefine 別キャプション
 *   (例: VMCJ55 89_02 の「４日に予想される満潮時刻…」×7、VPZJ51 の「２９日に予想される最大風速…」×2)。
 *   日付情報は潮位予想の [timeName] 表示・metrics テーブルの列見出し (timeName) と
 *   完全重複するため intro に積まない (繰返し行だけのセクションになるのを防ぐ)
 * - 単一の場合 = セクション導入文 (例: VMCJ55 89_01 の「次の満潮・干潮時刻は、以下のとおりです。」)
 *   として意味があるため従来どおり intro に残す
 */
function classifyTexts(prop: unknown): { intro: string[]; supplement: string[]; element: string | null } {
  const intro: string[] = [];
  const supplement: string[] = [];
  const timeSeriesCaptions: string[] = [];
  let element: string | null = null;
  for (const t of listOf(dig(prop, "Text"))) {
    const type = str(dig(t, "@_type"));
    const text = str(dig(t, "#text"));
    if (!text) continue;
    if (type === "解説") intro.push(text);
    else if (type === "時系列解説") timeSeriesCaptions.push(text);
    else if (type === "補足" || type === "時系列補足") supplement.push(text);
    else if (type === "気象要素") element = text;
  }
  if (timeSeriesCaptions.length === 1) {
    intro.push(timeSeriesCaptions[0]);
  }
  return { intro, supplement, element };
}

/** TimeSeriesInfo 1 本を ForecastTimeSeries に。sourceIndex は文書順 (空 series スキップ前) の採番 */
function extractSeries(tsi: unknown, sourceIndex: number): ForecastTimeSeries {
  const map = buildTimeDefineMap(dig(tsi, "TimeDefines"));
  const timeDefines: ForecastTimeDefine[] = [...map.values()].map((e) => ({
    timeId: e.timeId, dateTime: e.dateTime, duration: e.duration, name: e.name,
  }));
  const intro: string[] = [];
  const supplement: string[] = [];
  let element: string | null = null;
  const events: ForecastEvent[] = [];
  const metrics: ForecastMetricArea[] = [];
  for (const item of listOf(dig(tsi, "Item"))) {
    // Text 集約と Event/Metric 抽出で Kind を二度走査する。実 XML は 1 Item の Kind が少数のため許容
    for (const kind of listOf(dig(item, "Kind"))) {
      for (const prop of listOf(dig(kind, "Property"))) {
        const t = classifyTexts(prop);
        intro.push(...t.intro);
        supplement.push(...t.supplement);
        if (t.element) element = t.element;
      }
    }
    events.push(...extractEvents(item, map));
    const ma = extractMetricArea(item, map);
    if (ma != null) metrics.push(ma);
  }
  return { sourceIndex, element, timeDefines, intro, supplement, events, metrics };
}

/** 表示量 fallback を算出 (テスト用に export) */
export function computeFallback(series: ForecastTimeSeries[]): "none" | "compactOnly" | "raw" {
  let rows = 0;
  for (const s of series) {
    rows += s.events.length;
    for (const m of s.metrics) {
      for (const loc of m.locals) {
        for (const p of loc.phases) {
          rows += p.values.length;
        }
      }
    }
  }
  if (rows > 200) return "raw";
  if (rows > 80) return "compactOnly";
  return "none";
}

/** Body から 予想 (MeteorologicalInfos type="予想") を抽出。無ければ null */
export function extractForecast(body: unknown): WeatherExplanationForecast | null {
  if (body == null) return null;
  const infosList = listOf(dig(body, "MeteorologicalInfos")).filter(
    (n) => str(dig(n, "@_type")) === "予想",
  );
  if (infosList.length === 0) return null;
  const series: ForecastTimeSeries[] = [];
  // sourceIndex は「予想系 TimeSeriesInfo の文書順」。空 series をスキップしても採番は進める
  // (extractTidal 側の seriesIndex 採番と一致させるため)
  let tsiIndex = 0;
  for (const infos of infosList) {
    for (const tsi of listOf(dig(infos, "TimeSeriesInfo"))) {
      const s = extractSeries(tsi, tsiIndex);
      tsiIndex++;
      // 完全に空の series (events/metrics/intro/supplement/element すべて無) は捨てる [Codex plan R2]
      if (
        s.events.length === 0 &&
        s.metrics.length === 0 &&
        s.intro.length === 0 &&
        s.supplement.length === 0 &&
        s.element == null
      ) {
        continue;
      }
      series.push(s);
    }
  }
  if (series.length === 0) return null;
  return { series, fallback: computeFallback(series) };
}
