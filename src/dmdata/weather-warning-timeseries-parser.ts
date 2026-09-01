import type {
  WsDataMessage,
  ParsedWeatherWarningTimeseriesInfo,
  WeatherWarningTimeseriesArea,
  WeatherWarningTimeseriesKind,
  WeatherWarningTimeseriesNumber,
  WeatherWarningTimeseriesPartKind,
  WeatherWarningTimeseriesFallback,
  PartValue,
  LocalValue,
  SignificancyValue,
  SignificancyInfo,
  SignificancyPeakTime,
  SignificancyCriteriaPeriod,
  QuantitativeValue,
  QuantitativeMetricMeta,
  WindPairedValue,
  UnknownSignificancyOccurrence,
  TimeWindow,
  SoundLevel,
  SignificancyOccurrence,
  ForecastTimeSlot,
  WeatherWarningAreaIdentity,
  WeatherWarningLocalIdentity,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import {
  listOf,
  nodeText,
  toNumberOrNull,
  buildTimeDefineMap,
  buildStrictTimeDefineMap,
  resolveStrictTimeDefine,
  type TimeDefineEntry,
  type StrictTimeDefineMap,
} from "./timeseries-common";
import {
  classifySignificancyCode,
  pickWorstKnownSignificancy,
} from "./weather-warning-timeseries-significancy";
import {
  resolveVpwp50Significancy,
  DISPLAY_SEVERITY_RANK,
  DISPLAY_SEVERITY_TO_SOUND_LEVEL,
  SOUND_LEVEL_RANK,
} from "./weather-warning-level";
import { createJmxXmlParser } from "./xml-shape";
import { requireTelegramMeta } from "./telegram-ingress";
import * as log from "../logger";

/**
 * VPWP50 (気象警報・注意報時系列情報) 用 XML パーサ。
 *
 * 公式仕様書 `0206-0206.pdf` および別表 4/5 に基づく。
 *
 * 設計のポイント (R3 レビュー指摘反映):
 *   - 未知 Code は `maxKnownSignificancy` に混ぜず `unknownCodes[]` に分離。
 *     `?99` が L5/L4 より前に出ないように parser 段階で隔離する。
 *   - Local (地域内分割) は高潮限定でなく Significancy / 風向 / 風速 / 視程
 *     すべてに出る。`PartValue<T>` で base/locals を一般化保持。
 *   - 数値系の「worst 方向」は metric ごとに異なる。湿度・視程は小さい方が
 *     危険 (lowerIsWorse)。「最大値」総称は禁止。
 *   - 風 (WindDirection + WindSpeed) は paired。WindSpeed 最大時の
 *     WindDirection を採用 (timeRef + localName で join)。
 *   - 段階 fallback: decoded >5MB → null (raw fallback)、>3MB or Area >200 → compactOnly。
 */
const xmlParser = createJmxXmlParser((name) => {
  return ARRAY_TAGS.has(name);
});

const ARRAY_TAGS: ReadonlySet<string> = new Set([
  "MeteorologicalInfos",
  "TimeSeriesInfo",
  "TimeDefine",
  "Item",
  "Kind",
  "Property", // R1 #4: 公式は Property 複数を許容
  "Areas",
  "Area",
  "Significancy",
  "Local",
  "jmx_eb:Precipitation",
  "jmx_eb:SnowfallDepth",
  "jmx_eb:Humidity",
  "jmx_eb:WindDirection",
  "jmx_eb:WindSpeed",
  "jmx_eb:WaveHeight",
  "jmx_eb:TidalLevel",
  "jmx_eb:Visibility",
  "PeakTime",
  "CriteriaPeriod",
]);

/** 段階 fallback 閾値 */
const FALLBACK_RAW_BYTES = 5 * 1024 * 1024;
const FALLBACK_COMPACT_BYTES = 3 * 1024 * 1024;
const FALLBACK_COMPACT_AREAS = 200;
const VPWP50_MAX_TIME_REF_LENGTH = 64;
const VPWP50_MAX_TIME_NAME_LENGTH = 128;

interface ForecastSlotDiagnosticCollector {
  unresolvedCount: number;
  samples: string[];
}

function recordForecastSlotDiagnostic(
  collector: ForecastSlotDiagnosticCollector,
  sample: string,
): void {
  collector.unresolvedCount += 1;
  collector.samples.push(sample);
  collector.samples.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (collector.samples.length > 8) collector.samples.pop();
}

/** 数値系メトリックのメタデータ。worst 方向はここに集約 (推測補完禁止)。 */
const QUANTITATIVE_METRIC_META: Record<string, QuantitativeMetricMeta> = {
  "jmx_eb:Precipitation": { direction: "higherIsWorse", unit: "mm", label: "雨量" },
  "jmx_eb:SnowfallDepth": { direction: "higherIsWorse", unit: "cm", label: "降雪量" },
  "jmx_eb:Humidity":      { direction: "lowerIsWorse",  unit: "%",  label: "湿度" },
  "jmx_eb:WindSpeed":     { direction: "higherIsWorse", unit: "m/s", label: "風速" },
  "jmx_eb:WaveHeight":    { direction: "higherIsWorse", unit: "m",  label: "波高" },
  "jmx_eb:TidalLevel":    { direction: "higherIsWorse", unit: "m",  label: "潮位" },
  "jmx_eb:Visibility":    { direction: "lowerIsWorse",  unit: "m",  label: "視程" },
};

/** Part 名 → Part 種別 (型) */
const PART_KIND_MAP: Record<string, WeatherWarningTimeseriesPartKind> = {
  SignificancyPart: "Significancy",
  PrecipitationPart: "Precipitation",
  SnowfallDepthPart: "SnowfallDepth",
  HumidityPart: "Humidity",
  WindSpeedPart: "WindPaired", // WindDirection と組
  WindDirectionPart: "WindPaired",
  WaveHeightPart: "WaveHeight",
  TidalLevelPart: "TidalLevel",
  VisibilityPart: "Visibility",
};

/** Part 名 → 子要素名 (Significancy 以外の数値系) */
const PART_TO_VALUE_TAG: Record<string, string> = {
  PrecipitationPart: "jmx_eb:Precipitation",
  SnowfallDepthPart: "jmx_eb:SnowfallDepth",
  HumidityPart: "jmx_eb:Humidity",
  WindSpeedPart: "jmx_eb:WindSpeed",
  WindDirectionPart: "jmx_eb:WindDirection",
  WaveHeightPart: "jmx_eb:WaveHeight",
  TidalLevelPart: "jmx_eb:TidalLevel",
  VisibilityPart: "jmx_eb:Visibility",
};

// ── ヘルパー ──

function extractHeadlineText(headline: unknown): string | null {
  if (headline == null) return null;
  const text = dig(headline, "Text");
  if (text == null) return null;
  const s = nodeText(text);
  return s || null;
}

/**
 * worst と同条件の連続/非連続枠から TimeWindow を構築する [R1 #2 対応]。
 *
 * @param refIDs - worst と「同じ」とみなす refID 一覧 (順不同)
 * @param timeMap - TimeDefine map (numeric timeId 想定で sort)
 * @returns 時刻幅 (連続なら範囲化、非連続なら count を表示用に持つ)
 */
function buildTimeWindow(
  refIDs: string[],
  timeMap: Map<string, TimeDefineEntry>,
): TimeWindow | undefined {
  if (refIDs.length === 0) return undefined;
  // numeric timeId として sort
  const sorted = refIDs
    .map((r) => ({ id: r, n: Number(r) }))
    .filter((x) => !Number.isNaN(x.n))
    .sort((a, b) => a.n - b.n);
  if (sorted.length === 0) return undefined;

  // 連続判定 (1, 2, 3 のように差分 1 で続いているか)
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].n - sorted[i - 1].n !== 1) {
      contiguous = false;
      break;
    }
  }

  const startEntry = timeMap.get(sorted[0].id);
  const endEntry = timeMap.get(sorted[sorted.length - 1].id);
  const startName = startEntry?.name ?? sorted[0].id;
  const endName = endEntry?.name ?? sorted[sorted.length - 1].id;

  return {
    startName,
    endName: contiguous ? endName : startName,
    count: sorted.length,
    contiguous,
  };
}

// ── PartValue<T> 抽出 (Base / Local 両対応の汎用ヘルパー) ──

function normalizeIdentityText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function localIdentity(local: unknown): WeatherWarningLocalIdentity | null {
  const areaNameNode = dig(local, "AreaName");
  const name = normalizeIdentityText(nodeText(areaNameNode));
  if (name === "") return null;
  const elementCode = nodeText(dig(local, "Code")).trim();
  const attributeCode = str(dig(areaNameNode, "@_code")).trim();
  if (elementCode !== "" && attributeCode !== "" && elementCode !== attributeCode) return null;
  const code = elementCode || attributeCode || null;
  return { key: code == null ? `name:${name}` : `code:${code}`, name, code };
}

function seriesFor(tsNum: WeatherWarningTimeseriesNumber): ForecastTimeSlot["series"] {
  return tsNum === 1 ? "3h" : tsNum === 2 ? "24h" : "day";
}

function significancyOccurrenceFingerprint(value: SignificancyOccurrence): string {
  return JSON.stringify([
    value.info.code,
    value.info.known,
    value.info.rank,
    value.info.family,
    value.info.label,
    value.info.compact,
    value.info.severity,
    value.tsNum,
    value.timeRef,
    value.slot == null ? null : [
      value.slot.tsNum,
      value.slot.series,
      value.slot.timeRef,
      value.slot.name,
      value.slot.startsAt,
      value.slot.endsAt,
    ],
    value.peak == null ? null : [value.peak.date, value.peak.term],
    value.criteriaPeriod == null ? null : [
      value.criteriaPeriod.sentence,
      value.criteriaPeriod.criteriaClass,
      value.criteriaPeriod.time,
      value.criteriaPeriod.duration,
    ],
  ]);
}

/** Same-identity/name duplicate Local nodes form one occurrence collection. */
function mergeSignificancyOccurrenceLocal(
  locals: LocalValue<SignificancyOccurrence[]>[],
  candidate: LocalValue<SignificancyOccurrence[]>,
): void {
  const existing = locals.find((local) =>
    local.identityKey === candidate.identityKey && local.areaName === candidate.areaName);
  if (existing == null) {
    locals.push(candidate);
    return;
  }
  const seen = new Set(existing.value.map(significancyOccurrenceFingerprint));
  for (const occurrence of candidate.value) {
    const fingerprint = significancyOccurrenceFingerprint(occurrence);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    existing.value.push(occurrence);
  }
}

function mergeSignificancyOccurrenceList(
  target: SignificancyOccurrence[],
  candidates: readonly SignificancyOccurrence[],
): void {
  const seen = new Set(target.map(significancyOccurrenceFingerprint));
  for (const occurrence of candidates) {
    const fingerprint = significancyOccurrenceFingerprint(occurrence);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    target.push(occurrence);
  }
}

/** Duplicate Area Items of the same type share one card-only collection. */
function mergeAreaSignificancyOccurrenceCollections(
  area: WeatherWarningTimeseriesArea,
): void {
  for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
    const firstByType = new Map<string, WeatherWarningTimeseriesKind>();
    for (const kind of area.kinds[tsNum]) {
      if (kind.partKind !== "Significancy" || kind.significancyOccurrences == null) continue;
      const first = firstByType.get(kind.type);
      if (first == null || first.significancyOccurrences == null) {
        firstByType.set(kind.type, kind);
        continue;
      }
      const source = kind.significancyOccurrences;
      const target = first.significancyOccurrences;
      if (source.base != null) {
        const base = target.base ?? (target.base = []);
        mergeSignificancyOccurrenceList(base, source.base);
      }
      for (const local of source.locals ?? []) {
        const locals = target.locals ?? (target.locals = []);
        mergeSignificancyOccurrenceLocal(locals, local);
      }
      delete kind.significancyOccurrences;
    }
  }
}

/** Card 専用: worst 化せず、参照先が解決できない occurrence も残す。 */
function extractSignificancyOccurrences(
  sigList: unknown[],
  peakList: unknown[],
  criteriaList: unknown[],
  propertyType: string,
  strictTimeMap: StrictTimeDefineMap,
  tsNum: WeatherWarningTimeseriesNumber,
  diagnostics: ForecastSlotDiagnosticCollector,
): SignificancyOccurrence[] {
  const result: SignificancyOccurrence[] = [];
  for (const sig of sigList) {
    const code = nodeText(dig(sig, "Code")).trim();
    const timeRef = str(dig(sig, "@_refID")).trim();
    if (code === "") continue;
    const validTimeRef = timeRef !== "" && timeRef.length <= VPWP50_MAX_TIME_REF_LENGTH;
    const entry = validTimeRef && !strictTimeMap.ambiguousIds.has(timeRef)
      ? strictTimeMap.entries.get(timeRef)
      : undefined;
    const resolved = entry == null ? null : resolveStrictTimeDefine(entry);
    const timeName = normalizeIdentityText(entry?.name ?? "");
    const slot = resolved == null || timeName.length > VPWP50_MAX_TIME_NAME_LENGTH ? null : {
      tsNum, series: seriesFor(tsNum), timeRef, name: timeName,
      startsAt: resolved.startsAt, endsAt: resolved.endsAt,
    } satisfies ForecastTimeSlot;
    if (slot == null) {
      const reason = !validTimeRef
        ? "invalidRef"
        : strictTimeMap.ambiguousIds.has(timeRef)
          ? "duplicateTimeId"
          : entry == null
            ? "missingTimeDefine"
            : resolved == null
              ? "invalidTimeDefine"
              : "timeNameTooLong";
      recordForecastSlotDiagnostic(
        diagnostics,
        `${tsNum}:${reason}:${timeRef.slice(0, VPWP50_MAX_TIME_REF_LENGTH)}`,
      );
    }
    const peakNode = peakList.find((node) => str(dig(node, "@_refID")).trim() === timeRef);
    const criteriaNode = criteriaList.find((node) => str(dig(node, "@_refID")).trim() === timeRef);
    result.push({
      info: classifySignificancyCode(propertyType, code), tsNum, timeRef, slot,
      ...(peakNode == null ? {} : { peak: extractPeakTime([peakNode], timeRef) }),
      ...(criteriaNode == null ? {} : { criteriaPeriod: extractCriteriaPeriod([criteriaNode], timeRef) }),
    });
  }
  return result;
}

/**
 * Significancy 集合を Base または Local 直下から取り出す。
 *
 * 公式構造:
 *   <SignificancyPart>
 *     <Base>
 *       <Significancy refID="N" type="..."><Name>..</Name><Code>..</Code></Significancy> [複数]
 *       <Local>
 *         <AreaName>陸上</AreaName>
 *         <Significancy refID="N" type="..."><Name>..</Name><Code>..</Code></Significancy> [複数]
 *       </Local> [複数]
 *     </Base>
 *   </SignificancyPart>
 *
 * Local が存在しなければ Base 直下のみ、存在すれば locals に詰める。
 */
type ExtractedSignificancyPart = PartValue<SignificancyValue> & {
  occurrences: PartValue<SignificancyOccurrence[]>;
};

function extractSignificancyPart(
  partNode: unknown,
  propertyType: string,
  areaName: string,
  timeMap: Map<string, TimeDefineEntry>,
  strictTimeMap: StrictTimeDefineMap,
  tsNum: WeatherWarningTimeseriesNumber,
  diagnostics: ForecastSlotDiagnosticCollector,
  knownCollector: SignificancyInfo[],
  unknownCodes: UnknownSignificancyOccurrence[],
  /** R1 #1: Property 直下に CriteriaPeriod があれば fallback として渡す */
  propertyLevelCriteria: unknown[],
): ExtractedSignificancyPart | undefined {
  const base = dig(partNode, "Base");
  if (base == null) return undefined;

  const partValue: PartValue<SignificancyValue> = {};
  const occurrenceValue: PartValue<SignificancyOccurrence[]> = {};

  // Base 直下の Significancy (Local が無い場合の素値)
  // CriteriaPeriod は Base 直下優先、無ければ Property 直下 (R1 #1)
  const baseCriteria = listOf(dig(base, "CriteriaPeriod"));
  const effectiveCriteria =
    baseCriteria.length > 0 ? baseCriteria : propertyLevelCriteria;
  const baseDirectSigs = pickWorstSignificancyFromCollection(
    listOf(dig(base, "Significancy")),
    listOf(dig(base, "PeakTime")),
    effectiveCriteria,
    propertyType,
    areaName,
    timeMap,
    knownCollector,
    unknownCodes,
  );
  if (baseDirectSigs != null) {
    partValue.base = baseDirectSigs;
  }
  occurrenceValue.base = extractSignificancyOccurrences(
    listOf(dig(base, "Significancy")), listOf(dig(base, "PeakTime")), effectiveCriteria,
    propertyType, strictTimeMap, tsNum, diagnostics,
  );

  // Local
  const localList = listOf(dig(base, "Local"));
  if (localList.length > 0) {
    const locals: LocalValue<SignificancyValue>[] = [];
    for (const local of localList) {
      const identity = localIdentity(local);
      if (identity == null) continue;
      const localAreaName = identity.name;
      const localCriteria = listOf(dig(local, "CriteriaPeriod"));
      // Local の CriteriaPeriod が無ければ Property 直下を fallback
      const localEffectiveCriteria =
        localCriteria.length > 0 ? localCriteria : propertyLevelCriteria;
      const worst = pickWorstSignificancyFromCollection(
        listOf(dig(local, "Significancy")),
        listOf(dig(local, "PeakTime")),
        localEffectiveCriteria,
        propertyType,
        localAreaName ? `${areaName}/${localAreaName}` : areaName,
        timeMap,
        knownCollector,
        unknownCodes,
      );
      if (worst != null) {
        locals.push({ areaName: localAreaName, code: identity.code ?? undefined, identityKey: identity.key, identity, value: worst });
      }
      const occurrences = extractSignificancyOccurrences(
        listOf(dig(local, "Significancy")), listOf(dig(local, "PeakTime")), localEffectiveCriteria,
        propertyType, strictTimeMap, tsNum, diagnostics,
      );
      if (occurrences.length > 0) {
        const target = occurrenceValue.locals ?? (occurrenceValue.locals = []);
        mergeSignificancyOccurrenceLocal(target, {
          areaName: localAreaName,
          code: identity.code ?? undefined,
          identityKey: identity.key,
          identity,
          value: occurrences,
        });
      }
    }
    if (locals.length > 0) partValue.locals = locals;
  }

  if (partValue.base == null && partValue.locals == null) return undefined;
  return { ...partValue, occurrences: occurrenceValue };
}

/**
 * Significancy 群から worst 1 件を選び、PeakTime/CriteriaPeriod を付加する。
 *
 * 既知 Code は knownCollector に蓄積 (parser 上位の max 抽出用)。
 * 未知 Code は unknownCodes に分離 (`maxKnownSignificancy` には混ぜない)。
 */
function pickWorstSignificancyFromCollection(
  sigList: unknown[],
  peakList: unknown[],
  criteriaList: unknown[],
  propertyType: string,
  areaName: string,
  timeMap: Map<string, TimeDefineEntry>,
  knownCollector: SignificancyInfo[],
  unknownCodes: UnknownSignificancyOccurrence[],
): SignificancyValue | null {
  const infosWithTimeRef: { info: SignificancyInfo; timeRef: string }[] = [];
  for (const sig of sigList) {
    const code = nodeText(dig(sig, "Code"));
    const refID = str(dig(sig, "@_refID"));
    if (!code) continue;
    const info = classifySignificancyCode(propertyType, code);
    if (info.known) {
      knownCollector.push(info);
    } else {
      unknownCodes.push({
        code,
        propertyType,
        timeRef: refID,
        areaName,
      });
    }
    infosWithTimeRef.push({ info, timeRef: refID });
  }
  if (infosWithTimeRef.length === 0) return null;

  // 既知 Code から worst を選ぶ (未知は別経路でフレーム警告に効く)
  const known = infosWithTimeRef.filter((x) => x.info.known);
  let chosen = known[0];
  for (const x of known) {
    if (x.info.rank > chosen.info.rank) chosen = x;
  }
  if (chosen == null) {
    // 全部 unknown の場合は先頭を保持 (compact 用)
    chosen = infosWithTimeRef[0];
  }

  // [R1 #2] worst と同 Code/rank の全 refID を集めて TimeWindow を構築
  const worstRefIDs = infosWithTimeRef
    .filter((x) => x.info.code === chosen.info.code)
    .map((x) => x.timeRef)
    .filter((r) => r);
  const timeWindow = buildTimeWindow(worstRefIDs, timeMap);

  // PeakTime: timeRef に紐づくものを探す (refID 一致、なければ最初)
  const peak = extractPeakTime(peakList, chosen.timeRef);
  const criteria = extractCriteriaPeriod(criteriaList, chosen.timeRef);

  return {
    info: chosen.info,
    timeRef: chosen.timeRef,
    timeWindow,
    peak,
    criteriaPeriod: criteria,
  };
}

function extractPeakTime(
  peakList: unknown[],
  preferRefID: string,
): SignificancyPeakTime | undefined {
  if (peakList.length === 0) return undefined;
  const pick =
    peakList.find((p) => str(dig(p, "@_refID")) === preferRefID) ??
    peakList[0];
  const date = str(dig(pick, "Date"));
  const term = str(dig(pick, "Term"));
  if (!date && !term) return undefined;
  return { date, term };
}

function extractCriteriaPeriod(
  criteriaList: unknown[],
  preferRefID: string,
): SignificancyCriteriaPeriod | undefined {
  if (criteriaList.length === 0) return undefined;
  const pick =
    criteriaList.find((c) => str(dig(c, "@_refID")) === preferRefID) ??
    criteriaList[0];
  const sentence = str(dig(pick, "Sentence"));
  // [R1 #3] CriteriaClass は plain text の場合と nested <Name>/<Code> の場合がある
  const criteriaClass = extractCriteriaClass(dig(pick, "CriteriaClass"));
  const time = str(dig(pick, "Time"));
  const duration = str(dig(pick, "Duration"));
  if (!sentence && !criteriaClass && !time && !duration) return undefined;
  return { sentence, criteriaClass, time, duration };
}

/** CriteriaClass: plain text または `<Name>...</Name><Code>...</Code>` nest 両対応 */
function extractCriteriaClass(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "object") {
    // nest: <CriteriaClass><Name>X</Name><Code>Y</Code></CriteriaClass>
    const name = str(dig(node, "Name"));
    const code = nodeText(dig(node, "Code"));
    if (name && code) return `${name} (${code})`;
    if (name) return name;
    // 属性 #text フォールバック
    const text = str(dig(node, "#text"));
    if (text) return text;
    return "";
  }
  return str(node);
}

// ── 数値系 worst (higherIsWorse / lowerIsWorse) ──

/**
 * 数値系 Part から worst を抽出する。
 * 「最大値」総称ではなく metric の direction で方向を変える (推測補完禁止)。
 */
function extractQuantitativePart(
  partNode: unknown,
  partName: string,
  timeMap: Map<string, TimeDefineEntry>,
): { value: PartValue<QuantitativeValue>; meta: QuantitativeMetricMeta } | undefined {
  const valueTag = PART_TO_VALUE_TAG[partName];
  const meta = QUANTITATIVE_METRIC_META[valueTag];
  if (valueTag == null || meta == null) return undefined;

  const base = dig(partNode, "Base");
  if (base == null) return undefined;

  const partValue: PartValue<QuantitativeValue> = {};

  // Base 直下の数値群
  const baseValues = listOf(dig(base, valueTag));
  const baseWorst = pickWorstQuantitative(baseValues, meta, timeMap);
  if (baseWorst != null) partValue.base = baseWorst;

  // Local 配下
  const localList = listOf(dig(base, "Local"));
  if (localList.length > 0) {
    const locals: LocalValue<QuantitativeValue>[] = [];
    for (const local of localList) {
      const localAreaName = str(dig(local, "AreaName"));
      const localValues = listOf(dig(local, valueTag));
      const worst = pickWorstQuantitative(localValues, meta, timeMap);
      if (worst != null) {
        locals.push({ areaName: localAreaName || "", value: worst });
      }
    }
    if (locals.length > 0) partValue.locals = locals;
  }

  if (partValue.base == null && partValue.locals == null) return undefined;
  return { value: partValue, meta };
}

function pickWorstQuantitative(
  values: unknown[],
  meta: QuantitativeMetricMeta,
  timeMap: Map<string, TimeDefineEntry>,
): QuantitativeValue | null {
  const parsed: QuantitativeValue[] = [];
  for (const v of values) {
    const text = nodeText(v);
    const num = toNumberOrNull(text);
    if (num == null) continue;
    parsed.push({
      value: num,
      unit: str(dig(v, "@_unit")) || meta.unit,
      timeRef: str(dig(v, "@_refID")),
    });
  }
  if (parsed.length === 0) return null;
  const chosen = parsed.reduce((best, cur) => {
    if (meta.direction === "lowerIsWorse") {
      return cur.value < best.value ? cur : best;
    }
    return cur.value > best.value ? cur : best;
  });
  // [R1 #2] 同値が連続枠で続く範囲を timeWindow に
  const sameValueRefs = parsed
    .filter((p) => p.value === chosen.value)
    .map((p) => p.timeRef)
    .filter((r) => r);
  chosen.timeWindow = buildTimeWindow(sameValueRefs, timeMap);
  return chosen;
}

// ── 風 (Direction + Speed 組) ──

/**
 * WindDirection + WindSpeed を組として保持。
 * WindSpeed が最大の時刻の WindDirection を採用する (paired)。
 */
function extractWindPaired(
  windSpeedPart: unknown,
  windDirectionPart: unknown,
  timeMap: Map<string, TimeDefineEntry>,
): PartValue<WindPairedValue> | undefined {
  if (windSpeedPart == null) return undefined;
  const speedBase = dig(windSpeedPart, "Base");
  if (speedBase == null) return undefined;
  const dirBase =
    windDirectionPart != null ? dig(windDirectionPart, "Base") : null;

  const partValue: PartValue<WindPairedValue> = {};

  // Base 直下の風組
  const baseSpeed = listOf(dig(speedBase, "jmx_eb:WindSpeed"));
  const baseDir = dirBase != null ? listOf(dig(dirBase, "jmx_eb:WindDirection")) : [];
  const basePaired = pickWorstWindPaired(baseSpeed, baseDir, timeMap);
  if (basePaired != null) partValue.base = basePaired;

  // Local 配下
  const speedLocals = listOf(dig(speedBase, "Local"));
  if (speedLocals.length > 0) {
    const dirLocals = dirBase != null ? listOf(dig(dirBase, "Local")) : [];
    const locals: LocalValue<WindPairedValue>[] = [];
    for (const sLocal of speedLocals) {
      const areaName = str(dig(sLocal, "AreaName"));
      const sValues = listOf(dig(sLocal, "jmx_eb:WindSpeed"));
      const dLocal = dirLocals.find(
        (d) => str(dig(d, "AreaName")) === areaName,
      );
      const dValues = dLocal != null
        ? listOf(dig(dLocal, "jmx_eb:WindDirection"))
        : [];
      const paired = pickWorstWindPaired(sValues, dValues, timeMap);
      if (paired != null) {
        locals.push({ areaName, value: paired });
      }
    }
    if (locals.length > 0) partValue.locals = locals;
  }

  if (partValue.base == null && partValue.locals == null) return undefined;
  return partValue;
}

function pickWorstWindPaired(
  speedList: unknown[],
  directionList: unknown[],
  timeMap: Map<string, TimeDefineEntry>,
): WindPairedValue | null {
  const speeds: { speed: number; refID: string; dir: string | null }[] = [];
  for (const s of speedList) {
    const text = nodeText(s);
    const speed = toNumberOrNull(text);
    if (speed == null) continue;
    const refID = str(dig(s, "@_refID"));
    const dir = directionList.find((d) => str(dig(d, "@_refID")) === refID);
    const dirText = dir != null ? nodeText(dir) : null;
    speeds.push({ speed, refID, dir: dirText || null });
  }
  if (speeds.length === 0) return null;

  // 最大風速の WindDirection を採る (paired)
  const best = speeds.reduce((b, c) => (c.speed > b.speed ? c : b));
  // [R1 #2] 同じ最大速度が連続する範囲を timeWindow に
  const sameSpeedRefs = speeds
    .filter((p) => p.speed === best.speed)
    .map((p) => p.refID)
    .filter((r) => r);
  return {
    speed: best.speed,
    direction: best.dir,
    timeRef: best.refID,
    timeWindow: buildTimeWindow(sameSpeedRefs, timeMap),
  };
}

// ── Property → Kind ──

/**
 * Property ノードから WeatherWarningTimeseriesKind を生成。
 * Property は SignificancyPart / 数値系 Part のいずれか 1 種を含む。
 * 風だけは WindDirectionPart + WindSpeedPart の組を 1 つの Kind にまとめる。
 */
function extractKindFromProperty(
  property: unknown,
  areaName: string,
  timeMap: Map<string, TimeDefineEntry>,
  strictTimeMap: StrictTimeDefineMap,
  tsNum: WeatherWarningTimeseriesNumber,
  diagnostics: ForecastSlotDiagnosticCollector,
  knownCollector: SignificancyInfo[],
  unknownCodes: UnknownSignificancyOccurrence[],
): WeatherWarningTimeseriesKind | null {
  const type = normalizeIdentityText(nodeText(dig(property, "Type")));
  if (!type) return null;

  // [R1 #1] Property 直下に CriteriaPeriod が出る形状 (R06 spec) を取得し、
  // SignificancyPart 配下に無ければ fallback として渡す
  const propertyLevelCriteria = listOf(dig(property, "CriteriaPeriod"));

  // SignificancyPart
  if (dig(property, "SignificancyPart") != null) {
    const sigPart = dig(property, "SignificancyPart");
    const worst = extractSignificancyPart(
      sigPart,
      type,
      areaName,
      timeMap,
      strictTimeMap,
      tsNum,
      diagnostics,
      knownCollector,
      unknownCodes,
      propertyLevelCriteria,
    );
    if (worst == null) return null;
    return {
      type,
      partKind: "Significancy",
      significancyWorst: worst,
      significancyOccurrences: worst.occurrences,
    };
  }

  // 風 (WindSpeed が主、Direction が従): Speed があれば paired として作る
  if (dig(property, "WindSpeedPart") != null) {
    const paired = extractWindPaired(
      dig(property, "WindSpeedPart"),
      dig(property, "WindDirectionPart"),
      timeMap,
    );
    if (paired == null) return null;
    return {
      type,
      partKind: "WindPaired",
      windWorst: paired,
    };
  }

  // WindDirectionPart 単独 (Speed が無いケース、稀)
  if (dig(property, "WindDirectionPart") != null) {
    const paired = extractWindPaired(
      // Speed なしなので空 Base を擬似生成しても工夫が要る
      null,
      dig(property, "WindDirectionPart"),
      timeMap,
    );
    if (paired == null) return null;
    return {
      type,
      partKind: "WindPaired",
      windWorst: paired,
    };
  }

  // その他の数値系 Part
  for (const partName of [
    "PrecipitationPart",
    "SnowfallDepthPart",
    "HumidityPart",
    "WaveHeightPart",
    "TidalLevelPart",
    "VisibilityPart",
  ]) {
    if (dig(property, partName) != null) {
      const extracted = extractQuantitativePart(
        dig(property, partName),
        partName,
        timeMap,
      );
      if (extracted == null) return null;
      return {
        type,
        partKind: PART_KIND_MAP[partName],
        quantitativeWorst: extracted.value,
        metricMeta: extracted.meta,
      };
    }
  }

  return null;
}

// ── Item → Area ──

interface AreaIdentity {
  name: string;
  code: string;
  identity: WeatherWarningAreaIdentity;
}

function extractAreaIdentity(item: unknown): AreaIdentity | null {
  // VPWP50 実物: Item の直下に <Area> がある (Areas で包まれない)
  // 公式 spec §2-8-2-4-1-2 は「Areas で包む」と書くが、実物が真実
  const directAreas = listOf(dig(item, "Area"));
  for (const area of directAreas) {
    const name = normalizeIdentityText(str(dig(area, "Name")));
    const code = nodeText(dig(area, "Code")).trim();
    if (name) return { name, code, identity: { key: code === "" ? `name:${name}` : `code:${code}`, name, code: code || null } };
  }
  // フォールバック: Areas/Area 構造 (公式 spec の表記通り、別電文系列向け)
  const areasList = listOf(dig(item, "Areas"));
  for (const areas of areasList) {
    const areaList = listOf(dig(areas, "Area"));
    for (const area of areaList) {
      const name = normalizeIdentityText(str(dig(area, "Name")));
      const code = nodeText(dig(area, "Code")).trim();
      if (name) return { name, code, identity: { key: code === "" ? `name:${name}` : `code:${code}`, name, code: code || null } };
    }
  }
  return null;
}

function extractTargetArea(
  body: unknown,
): WeatherWarningTimeseriesArea | null {
  if (body == null) return null;
  const ta = dig(body, "TargetArea");
  if (ta == null) return null;
  const name = normalizeIdentityText(nodeText(dig(ta, "Name")));
  const code = nodeText(dig(ta, "Code")).trim();
  if (!name) return null;
  return {
    name,
    code,
    identityKey: code === "" ? `name:${name}` : `code:${code}`,
    identity: { key: code === "" ? `name:${name}` : `code:${code}`, name, code: code || null },
    kinds: { 1: [], 2: [], 3: [] },
  };
}

// ── MeteorologicalInfos 巡回 ──

interface TimeSeriesExtractResult {
  areas: WeatherWarningTimeseriesArea[];
  maxKnownSignificancy: SignificancyInfo | null;
  maxDisplaySeverity: ParsedWeatherWarningTimeseriesInfo["maxDisplaySeverity"];
  maxSoundLevel: ParsedWeatherWarningTimeseriesInfo["maxSoundLevel"];
  maxDisplayRankSignificancy: SignificancyInfo | null;
  unknownCodes: UnknownSignificancyOccurrence[];
}

/**
 * 表示母集団 (per-property worst = significancyWorst の base/locals 値) を走査し、
 * DISPLAY_SEVERITY_RANK 基準で最大の表示重大度を選ぶ (Phase B / Codex C1)。
 *
 * knownCollector (全時刻値) ではなく表示と同じ母集団に揃える理由:
 * 1 Property 内に 50/41 が混在しても、表示 entry に存在しない displaySeverity が代表に
 * ならないようにし、バナー収集・外枠色・セクションを整合させる (Fable 再確認 W1)。
 * resolver が null を返す値 (none/below) は除外。全滅なら両方 null。
 *
 * 同じ走査で通知音の集合ベース最大 (soundLevel) も導出する (2026-06-12 共存エッジ解消)。
 * displaySeverity の rank 1 点代表と違い、Code 41 (officialL4 → 音 warning) と
 * Code 50 (nonLevelSpecial → 音 critical) の共存で critical 音が潰れない。
 */
function deriveMaxDisplaySeverity(
  areas: WeatherWarningTimeseriesArea[],
): {
  displaySeverity: TimeSeriesExtractResult["maxDisplaySeverity"];
  soundLevel: TimeSeriesExtractResult["maxSoundLevel"];
  info: SignificancyInfo | null;
} {
  let bestRank = -1;
  let bestDisplay: TimeSeriesExtractResult["maxDisplaySeverity"] = null;
  let bestInfo: SignificancyInfo | null = null;
  let bestSound: Exclude<SoundLevel, "cancel"> | null = null;

  const consider = (sv: SignificancyValue | undefined): void => {
    if (sv == null) return;
    const resolved = resolveVpwp50Significancy(sv.info);
    if (resolved == null) return;
    const rank = DISPLAY_SEVERITY_RANK[resolved.displaySeverity];
    if (rank > bestRank) {
      bestRank = rank;
      bestDisplay = resolved.displaySeverity;
      bestInfo = sv.info;
    }
    // 音は表示代表 (1 点) と独立の集合ベース最大 (release は resolver が返さないが防御)
    const sound = DISPLAY_SEVERITY_TO_SOUND_LEVEL[resolved.displaySeverity];
    if (sound === "cancel") return;
    if (bestSound == null || SOUND_LEVEL_RANK[sound] > SOUND_LEVEL_RANK[bestSound]) {
      bestSound = sound;
    }
  };

  for (const area of areas) {
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      for (const kind of area.kinds[tsNum]) {
        if (kind.partKind !== "Significancy" || kind.significancyWorst == null) continue;
        consider(kind.significancyWorst.base);
        for (const local of kind.significancyWorst.locals ?? []) {
          consider(local.value);
        }
      }
    }
  }

  return { displaySeverity: bestDisplay, soundLevel: bestSound, info: bestInfo };
}

function retainedSignificancyFacts(
  areas: readonly WeatherWarningTimeseriesArea[],
): {
  known: SignificancyInfo[];
  unknown: UnknownSignificancyOccurrence[];
} {
  const known: SignificancyInfo[] = [];
  const unknown: UnknownSignificancyOccurrence[] = [];
  const collect = (
    occurrences: readonly SignificancyOccurrence[] | undefined,
    propertyType: string,
    areaName: string,
  ): void => {
    for (const occurrence of occurrences ?? []) {
      if (occurrence.info.known) known.push(occurrence.info);
      else unknown.push({
        code: occurrence.info.code,
        propertyType,
        timeRef: occurrence.timeRef,
        areaName,
      });
    }
  };
  for (const area of areas) {
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      for (const kind of area.kinds[tsNum]) {
        if (kind.partKind !== "Significancy") continue;
        collect(kind.significancyOccurrences?.base, kind.type, area.name);
        for (const local of kind.significancyOccurrences?.locals ?? []) {
          collect(local.value, kind.type, `${area.name}/${local.areaName}`);
        }
      }
    }
  }
  return { known, unknown };
}

function extractTimeSeriesData(body: unknown): TimeSeriesExtractResult {
  const areaMap = new Map<string, WeatherWarningTimeseriesArea>();
  const areaNamesByIdentity = new Map<string, Set<string>>();
  const knownCollector: SignificancyInfo[] = [];
  const unknownCodes: UnknownSignificancyOccurrence[] = [];
  const slotDiagnostics: ForecastSlotDiagnosticCollector = { unresolvedCount: 0, samples: [] };

  if (body == null) {
    return {
      areas: [],
      maxKnownSignificancy: null,
      maxDisplaySeverity: null,
      maxSoundLevel: null,
      maxDisplayRankSignificancy: null,
      unknownCodes,
    };
  }

  // 公式: MeteorologicalInfos は 1 個、TimeSeriesInfo は 3 個固定
  // (#1: 3時間系列、#2: 24時間最大、#3: 日単位)
  const infosList = listOf(dig(body, "MeteorologicalInfos"));
  for (const infos of infosList) {
    const tsList = listOf(dig(infos, "TimeSeriesInfo"));
    let tsNumber: WeatherWarningTimeseriesNumber = 1;
    for (const ts of tsList) {
      // [R1 #2] TimeDefines を解決し、worst 値を時刻幅へ畳むために以降の関数に伝播
      const timeMap = buildTimeDefineMap(dig(ts, "TimeDefines"));
      const strictTimeMap = buildStrictTimeDefineMap(dig(ts, "TimeDefines"));

      const itemList = listOf(dig(ts, "Item"));
      for (const item of itemList) {
        const areaIdent = extractAreaIdentity(item);
        if (areaIdent == null) continue;
        const areaNames = areaNamesByIdentity.get(areaIdent.identity.key) ?? new Set<string>();
        areaNames.add(areaIdent.name);
        areaNamesByIdentity.set(areaIdent.identity.key, areaNames);

        let area = areaMap.get(areaIdent.identity.key);
        if (area == null) {
          area = {
            name: areaIdent.name,
            code: areaIdent.code,
            identityKey: areaIdent.identity.key,
            identity: areaIdent.identity,
            kinds: { 1: [], 2: [], 3: [] },
          };
          areaMap.set(areaIdent.identity.key, area);
        }

        const kindList = listOf(dig(item, "Kind"));
        for (const kindNode of kindList) {
          // [R1 #4] Property は仕様上「1 回以上」配列を取りうる。listOf で全部巡回する
          const properties = listOf(dig(kindNode, "Property"));
          for (const property of properties) {
            if (property == null) continue;
            const wwtKind = extractKindFromProperty(
              property,
              areaIdent.name,
              timeMap,
              strictTimeMap,
              tsNumber,
              slotDiagnostics,
              knownCollector,
              unknownCodes,
            );
            if (wwtKind != null) {
              area.kinds[tsNumber].push(wwtKind);
            }
          }
        }
      }

      // 次の TimeSeriesInfo 番号へ
      tsNumber = tsNumber < 3
        ? ((tsNumber + 1) as WeatherWarningTimeseriesNumber)
        : 3;
    }
  }

  const conflictedAreas = new Set([...areaNamesByIdentity]
    .filter(([key, names]) => key.startsWith("code:") && names.size > 1)
    .map(([key]) => key)
    .sort());
  for (const key of conflictedAreas) {
    areaMap.delete(key);
    log.warn(`[VPWP50] vpwp50AreaIdentityConflict identity=${key.slice(0, 96)}`);
  }

  const areas = Array.from(areaMap.values());
  for (const area of areas) mergeAreaSignificancyOccurrenceCollections(area);
  const localNamesByIdentity = new Map<string, Set<string>>();
  for (const area of areas) {
    const parentKey = area.identityKey ?? area.identity?.key ?? `name:${area.name}`;
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      for (const kind of area.kinds[tsNum]) {
        for (const local of kind.significancyOccurrences?.locals ?? []) {
          const localKey = local.identityKey ?? local.identity?.key;
          if (localKey == null) continue;
          const scopedKey = `${parentKey}\u0000${localKey}`;
          const names = localNamesByIdentity.get(scopedKey) ?? new Set<string>();
          names.add(local.areaName);
          localNamesByIdentity.set(scopedKey, names);
        }
      }
    }
  }
  const conflictedLocals = new Set([...localNamesByIdentity]
    .filter(([key, names]) => key.includes("\u0000code:") && names.size > 1)
    .map(([key]) => key)
    .sort());
  for (const area of areas) {
    const parentKey = area.identityKey ?? area.identity?.key ?? `name:${area.name}`;
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      for (const kind of area.kinds[tsNum]) {
        const keep = <T>(local: LocalValue<T>): boolean => {
          const localKey = local.identityKey ?? local.identity?.key;
          return localKey == null || !conflictedLocals.has(`${parentKey}\u0000${localKey}`);
        };
        if (kind.significancyOccurrences?.locals != null) {
          kind.significancyOccurrences.locals = kind.significancyOccurrences.locals.filter(keep);
          if (kind.significancyOccurrences.locals.length === 0) delete kind.significancyOccurrences.locals;
        }
        if (kind.significancyWorst?.locals != null) {
          kind.significancyWorst.locals = kind.significancyWorst.locals.filter(keep);
          if (kind.significancyWorst.locals.length === 0) delete kind.significancyWorst.locals;
        }
      }
    }
  }
  for (const key of conflictedLocals) {
    log.warn(`[VPWP50] vpwp50LocalIdentityConflict identity=${key.slice(0, 96)}`);
  }
  if (slotDiagnostics.unresolvedCount > 0) {
    log.warn(`[VPWP50] vpwp50ForecastSlotUnresolved count=${slotDiagnostics.unresolvedCount} samples=${JSON.stringify(slotDiagnostics.samples)}`);
  }
  const maxDisplay = deriveMaxDisplaySeverity(areas);
  // Identity conflict candidates are excluded as a complete bundle. Rebuild
  // the legacy aggregate facts from the retained occurrence population so a
  // discarded Area/Local cannot still raise the frame or unknown diagnostic.
  const retainedFacts = retainedSignificancyFacts(areas);
  return {
    areas,
    maxKnownSignificancy: pickWorstKnownSignificancy(retainedFacts.known),
    maxDisplaySeverity: maxDisplay.displaySeverity,
    maxSoundLevel: maxDisplay.soundLevel,
    maxDisplayRankSignificancy: maxDisplay.info,
    unknownCodes: retainedFacts.unknown,
  };
}

/** 段階 fallback 判定 (decoded byte 長 と Area 数で) */
function decideFallback(
  decodedBytes: number,
  areaCount: number,
): WeatherWarningTimeseriesFallback {
  if (decodedBytes > FALLBACK_RAW_BYTES) return "raw";
  if (
    decodedBytes > FALLBACK_COMPACT_BYTES ||
    areaCount > FALLBACK_COMPACT_AREAS
  ) {
    return "compactOnly";
  }
  return "none";
}

// ── メイン ──

/**
 * 気象警報・注意報時系列情報電文 (VPWP50) をパースする。
 * パース失敗・Head 欠落・必須メタ完全空の場合は null を返す (raw フォールバック)。
 */
export function parseWeatherWarningTimeseries(
  msg: WsDataMessage,
): ParsedWeatherWarningTimeseriesInfo | null {
  try {
    const meta = requireTelegramMeta(msg);
    const xmlStr = decodeBody(msg);
    const decodedBytes = Buffer.byteLength(xmlStr, "utf8");

    // 5MB 超は parser に乗せず raw fallback
    if (decodedBytes > FALLBACK_RAW_BYTES) {
      log.debug(
        `parseWeatherWarningTimeseries: decoded ${decodedBytes} bytes > 5MB → raw fallback`,
      );
      return null;
    }

    const parsed = xmlParser.parse(xmlStr);
    const report = dig(parsed, "Report") || dig(parsed, "jmx:Report");
    if (report == null) {
      log.debug(
        "parseWeatherWarningTimeseries: Report ノードが見つかりません",
      );
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");

    if (head == null) {
      log.debug(
        "parseWeatherWarningTimeseries: Head ノードが見つかりません",
      );
      return null;
    }
    const infoType = str(dig(head, "InfoType"));
    const title = str(dig(head, "Title"));
    if (!infoType && !title) {
      log.debug(
        "parseWeatherWarningTimeseries: Head の必須メタが空です",
      );
      return null;
    }

    // 取消電文は body をパースせず空状態で返す (frame level = cancel)
    if (infoType === "取消") {
      return {
        type: msg.head.type,
        infoType,
        title,
        controlTitle: str(dig(control, "Title")),
        reportDateTime: str(dig(head, "ReportDateTime")),
        publishingOffice:
          msg.xmlReport?.control?.publishingOffice ||
          str(dig(control, "PublishingOffice")),
        editorialOffice: str(dig(control, "EditorialOffice")),
        eventId: str(dig(head, "EventID")) || null,
        serial: str(dig(head, "Serial")) || null,
        headline: extractHeadlineText(dig(head, "Headline")),
        targetArea: extractTargetArea(body),
        areas: [],
        maxKnownSignificancy: null,
        maxDisplaySeverity: null,
        maxSoundLevel: null,
        maxDisplayRankSignificancy: null,
        unknownCodes: [],
        fallback: "none",
        meta,
        isTest: meta.isTest,
      };
    }

    const {
      areas,
      maxKnownSignificancy,
      maxDisplaySeverity,
      maxSoundLevel,
      maxDisplayRankSignificancy,
      unknownCodes,
    } = extractTimeSeriesData(body);

    const fallback = decideFallback(decodedBytes, areas.length);

    return {
      type: msg.head.type,
      infoType,
      title,
      controlTitle: str(dig(control, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      headline: extractHeadlineText(dig(head, "Headline")),
      targetArea: extractTargetArea(body),
      areas,
      maxKnownSignificancy,
      maxDisplaySeverity,
      maxSoundLevel,
      maxDisplayRankSignificancy,
      unknownCodes,
      fallback,
      meta,
      isTest: meta.isTest,
    };
  } catch (err) {
    log.error(
      `parseWeatherWarningTimeseries: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
