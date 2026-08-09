// テロップ文章化: PresentationEvent → 読める一文。
// spec: 設計メモ 2026-07-08-ticker-sentence-design.md
// 文体規約: EEW・津波は体言止め句点なし、それ以外は文末に句点。
// [警告] 等の CLI 接頭辞は含めない (重要度は role 色と種別ラベルが担う)。

import type { PresentationEvent, PresentationAreaItem } from "../presentation/types";
import type {
  ParsedWeatherWarning,
  ParsedWeatherWarningTimeseriesInfo,
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  ParsedFloodForecastInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoPlumeInfo,
  ParsedEarlyWeatherInfo,
  FloodLevel,
  TyphoonName,
} from "../../types";
import { FLOOD_LEVEL_RANK } from "../../types";
import { analyzeWeatherTickerFacts, buildWeatherTickerSentence } from "./weather-ticker-facts";
import { prefectureOf, formatPrefectureList, LIST_SEPARATOR, MAX_LISTED } from "./prefecture-format";
import { intensityToRank } from "../../utils/intensity";
import {
  formatMagnitudeSpecialValue,
  formatPresentationMagnitude,
  isGiantMagnitudeText,
} from "../../utils/magnitude";
import { resolveTsunamiLevel, normalizeTsunamiKind } from "../../utils/tsunami-kind";
import { flattenEntries, type WeatherSeverityEntry } from "../presentation/weather-severity-pyramid";
import { normalizeKindName, KIND_NAME_MAP } from "../../dmdata/weather-warning-timeseries-significancy";
import { DISPLAY_SEVERITY_RANK } from "../../dmdata/weather-warning-level";
import { groupIntensityAreas } from "./intensity-groups";
import {
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
} from "../presentation/level-helpers";
import {
  formatPlumeHeightSpecialValue,
  plumeHeightUsesLegacyDisplay,
} from "../../utils/plume-height";

const CATEGORY_LABELS: Record<string, string> = {
  eew: "緊急地震速報",
  earthquake: "地震情報",
  seismicText: "地震・津波解説",
  lgObservation: "長周期地震動",
  tsunami: "津波情報",
  volcano: "火山情報",
  nankaiTrough: "南海トラフ",
  weather: "気象警報・注意報",
  tornado: "竜巻注意情報",
  briefing: "気象防災速報",
  earlyWeather: "早期天候情報",
  weatherWarningTimeseries: "気象警報予測",
  climateInfo: "天候情報",
  weatherExplanation: "気象解説",
  heatAlert: "熱中症警戒アラート",
  typhoonAnalysis: "台風情報",
  typhoonProbability: "台風暴風域確率",
  floodForecast: "洪水予報",
  raw: "気象庁情報",
};

export function tickerCategoryOf(event: PresentationEvent): string {
  if (event.diagnosticKind != null) return "診断";
  if (event.domain === "weather" && event.type === "VPWS50") return "気象警報・注意報（全国集約）";
  return CATEGORY_LABELS[event.domain] ?? "気象庁情報";
}

/** 台風名を件名チップ用に短縮する (番号優先「台風15号」→ 呼称 → remark)。 */
function typhoonSubject(name: TyphoonName | null): string | null {
  if (name == null) return null;
  if (name.number != null && name.number.length >= 2) return `台風${name.number.slice(2)}号`;
  if (name.name != null && name.name !== "") return name.name;
  if (name.remark != null && name.remark !== "") return name.remark;
  return null;
}

/**
 * テロップ左端チップの件名を導出する (spec §4-2、2026-07-11 現物照合で供給源確定)。
 * 火山=火山名 / 台風=台風名短縮 / 気象解説=対象地方 / 気候=対象地方 / 熱中症=対象府県。
 * 導出不能・対象外ドメインは null (チップは種別ラベルのみ)。
 */
export function tickerSubjectOf(event: PresentationEvent): string | null {
  if (event.domain === "volcano") {
    return event.volcanoName != null && event.volcanoName !== "" ? event.volcanoName : null;
  }
  if (event.domain === "typhoonAnalysis" || event.domain === "typhoonProbability") {
    const raw = event.raw as ParsedTyphoonAnalysis | ParsedTyphoonProbability | null;
    return raw != null ? typhoonSubject(raw.name) : null;
  }
  if (event.domain === "weatherExplanation") {
    return event.areaNames.length > 0 ? withPrefectureFromTitle(event.title, event.areaNames[0]) : null;
  }
  if (event.domain === "heatAlert") {
    // heatAlert は既に県粒度の地域名なので併記しない
    return event.areaNames.length > 0 ? event.areaNames[0] : null;
  }
  if (event.domain === "climateInfo") {
    return event.areaItems.length > 0 ? withPrefectureFromTitle(event.title, event.areaItems[0].name) : null;
  }
  return null;
}

/**
 * 府県版電文 (タイトルが県名で始まる、例「福井県気象解説情報（大雪・高波・雷）」) では、
 * 地域名 (「村山」等) だけだと所属県が分からないため県名を前置する。
 * タイトルから県名が取れない地方版・全般版はそのまま、地域名が既にその県名で
 * 始まる場合も二重化しないよう無加工で返す。
 */
function withPrefectureFromTitle(title: string, areaName: string): string {
  const pref = prefectureOf(title);
  if (pref == null || areaName.startsWith(pref)) return areaName;
  return `${pref} ${areaName}`;
}

/** 文末が 。!? ！？ で終わらなければ 。 を付ける (体言止めドメインは通さない) */
function ensurePeriod(text: string): string {
  const t = text.trim();
  if (t.length === 0) return t;
  return /[。！？!?]$/.test(t) ? t : `${t}。`;
}

/** headline/title ベースの最小一文。旧ダンプ (summary 連結 + 地域羅列) には戻さない。 */
function fallbackTickerText(event: PresentationEvent): string {
  const base = event.headline?.trim() || event.title;
  return ensurePeriod(base);
}

/** ISO 日時 → 「午後9時37分ごろ」 (JST 12 時間制)。パース不能は null */
function formatJst12h(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // ISO 文字列は +09:00 付き (dmdata 電文)。UTC に直してから JST を再構成する
  const jstMs = d.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const h24 = jst.getUTCHours();
  const min = jst.getUTCMinutes();
  const period = h24 < 12 ? "午前" : "午後";
  const h12 = h24 % 12; // NHK 式: 12:10 → 午後0時10分、00:05 → 午前0時5分
  return `${period}${h12}時${min}分ごろ`;
}

function topIntensityAreas(items: PresentationAreaItem[]): { intensity: string; names: string[] } | null {
  const top = groupIntensityAreas(items)[0];
  return top != null ? { intensity: top.intensity, names: top.areas } : null;
}

const EARTHQUAKE_FALLBACK_MAX_LENGTH = 180;
const EARTHQUAKE_AREA_SUMMARY_MAX_LENGTH = 120;
const EARTHQUAKE_AREA_NAME_MAX_LENGTH = 16;

function tickerIntensityText(event: PresentationEvent): string | null {
  return formatIntensitySpecialValue(event.maxIntValue, event.maxInt, "ticker");
}

function hasExplicitIntensityQualifier(event: PresentationEvent): boolean {
  return event.maxIntValue?.presence === "unknown"
    || event.maxIntValue?.presence === "qualitative"
    || event.maxIntValue?.presence === "range";
}

function ellipsize(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

function earthquakeAreaSummary(items: PresentationAreaItem[]): string | null {
  const groups = groupIntensityAreas(items);
  if (groups.length === 0) return null;
  const parts: string[] = [];
  let consumed = 0;
  for (const group of groups) {
    const listed = group.areas
      .slice(0, 2)
      .map((name) => ellipsize(name.trim(), EARTHQUAKE_AREA_NAME_MAX_LENGTH))
      .join("・");
    const omitted = group.areas.length - 2;
    const part = `震度${group.intensity} ${listed}${omitted > 0 ? ` ほか${omitted}地域` : ""}`;
    const candidate = [...parts, part].join("／");
    const remaining = groups.length - consumed - 1;
    const folded = remaining > 0 ? `${candidate}／ほか${remaining}震度` : candidate;
    if (folded.length > EARTHQUAKE_AREA_SUMMARY_MAX_LENGTH && parts.length > 0) break;
    parts.push(ellipsize(part, EARTHQUAKE_AREA_SUMMARY_MAX_LENGTH));
    consumed += 1;
  }
  const remaining = groups.length - consumed;
  const suffix = remaining > 0 ? `／ほか${remaining}震度` : "";
  return ellipsize(`${parts.join("／")}${suffix}`, EARTHQUAKE_AREA_SUMMARY_MAX_LENGTH);
}

function earthquakeSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return "先ほどの地震情報は取り消されました。";
  const hypocenterName = event.hypocenterName?.trim();
  if (hypocenterName == null || hypocenterName === "") return null;
  const time = event.originTime != null ? formatJst12h(event.originTime) : null;
  const head = time != null ? `${time}、` : "";
  const mag = tickerEarthquakePhrase(event, true);
  let sentence = `${head}${hypocenterName}を震源とする${mag}がありました。`;
  const top = topIntensityAreas(event.areaItems);
  const maxInt = tickerIntensityText(event);
  const hasExplicitQualifier = hasExplicitIntensityQualifier(event);
  if (!hasExplicitQualifier && top != null && top.names.length > 0) {
    const listed = top.names.slice(0, 2).join("・");
    const suffix = top.names.length > 2 ? "など" : "";
    sentence += `${listed}${suffix}で最大震度${top.intensity}を観測しています。`;
  } else if (maxInt != null) {
    sentence += `最大震度${maxInt}を観測しています。`;
  }
  return sentence;
}

function eewSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return "緊急地震速報は取り消されました。";
  if (event.hypocenterName == null) return null;
  const label = event.isWarning === true ? "緊急地震速報" : "緊急地震速報(予報)";
  const serial = event.serial != null ? ` #${event.serial}` : "";
  const mag = tickerEarthquakePhrase(event, false);
  const parts = [`${label}${serial}: ${event.hypocenterName}で${mag}`];
  if (event.forecastMaxInt != null) parts.push(`予想最大震度${event.forecastMaxInt}`);
  if (event.isWarning === true) parts.push("強い揺れに警戒");
  return parts.join("　"); // 体言止め・句点なし
}

function tickerEarthquakePhrase(event: PresentationEvent, verboseExact: boolean): string {
  const semantic = event.magnitudeValue;
  if (semantic != null) {
    if (semantic.presence === "missing" || semantic.presence === "empty") return "地震";
    if (semantic.presence === "value" && semantic.value != null) {
      const value = semantic.value.toFixed(1);
      return verboseExact ? `マグニチュード${value}の地震` : `M${value}の地震`;
    }
    if (semantic.presence === "unknown") return "規模不明の地震";
    if (
      semantic.presence === "qualitative"
      && [semantic.description, semantic.condition, semantic.raw].some(isGiantMagnitudeText)
    ) return formatMagnitudeSpecialValue(semantic) ?? "巨大地震";
    const label = formatMagnitudeSpecialValue(semantic);
    return label == null ? "地震" : `${label}の地震`;
  }
  if (event.magnitude == null) return "地震";
  return Number.isFinite(Number(event.magnitude)) && verboseExact
    ? `マグニチュード${event.magnitude}の地震`
    : `${formatPresentationMagnitude(event.magnitude)}の地震`;
}

const TSUNAMI_LEVEL_LABELS: Record<string, string> = {
  majorWarning: "大津波警報",
  warning: "津波警報",
  advisory: "津波注意報",
};

function tsunamiSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return "津波情報は取り消されました。";
  const level = resolveTsunamiLevel(event.tsunamiKinds ?? [])?.level;
  const kindLabel = level != null ? TSUNAMI_LEVEL_LABELS[level] : undefined;
  if (kindLabel == null) return null;
  const areas = event.areaItems.filter(
    (i) => i.kind != null && normalizeTsunamiKind(i.kind) === kindLabel,
  );
  if (areas.length === 0) return null;
  const listed = areas.slice(0, 2).map((i) => i.name).join("・");
  const suffix = areas.length > 2 ? `など${areas.length}地域` : "";
  let sentence = `${listed}${suffix}に${kindLabel}`; // 体言止め・句点なし
  const comment = event.warningComment?.split("\n")[0]?.trim();
  if (comment != null && comment.length > 0) sentence += `　${ensurePeriod(comment)}`;
  return sentence;
}

function weatherSentence(event: PresentationEvent): string | null {
  const raw = event.raw;
  if (raw == null || !(typeof raw === "object" && "layers" in raw)) return null;
  const facts = analyzeWeatherTickerFacts(raw as ParsedWeatherWarning);
  if (facts == null) return null;
  const sentence = buildWeatherTickerSentence(facts);
  if (sentence == null) return null;
  // 付帯コメント (「土砂災害に警戒してください」等) は単県 VPWW のみ 1 文添える。
  // VPWS50 全国集約は本文が長くなるため付けない (spec §3 の例文どおり)
  const comment = event.warningComment?.split("\n")[0]?.trim();
  if (comment != null && comment.length > 0 && facts.mode === "active" && !facts.isNationwide) {
    return `${sentence}${ensurePeriod(comment)}`;
  }
  return sentence;
}

/**
 * VPWP50 種別の文章用ラベル。alertLevel 系 (officialAlertLevel != null) は base 名 +「警戒レベルN相当」で、
 * grade 系は normalizeKindName の自然語名 (大雨特別警報 等)。
 * alertLevel 系に normalizeKindName を使うと「土砂災害警報」(実在しない誤読名) になるため避ける
 * (formatter の vpwp50KindLabel と同じ回避、spec 逸脱 4)。
 */
function vpwp50SentenceKind(e: WeatherSeverityEntry): string {
  if (e.officialAlertLevel != null) {
    const base = KIND_NAME_MAP[e.propertyType]?.base ?? e.propertyType.replace(/危険度$/, "");
    return `${base}（警戒レベル${e.officialAlertLevel}相当）`;
  }
  return normalizeKindName(e.propertyType, e.severity);
}

/**
 * 気象警報・注意報時系列情報 (VPWP50) の一文。「どこに何の警報・注意報の予測」を文章体で出す。
 * 警報級 (special/warning) を優先し、無ければ注意報級。種別名は dedup、先頭 3 件 + ほか N 件。
 * 表形式の時系列詳細 (window/peak) は固定計器・CLI 表の担当で、テロップは 1 文に留める (案A、裁定)。
 */
export function weatherWarningTimeseriesSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return "気象警報・注意報の予測情報は取り消されました。";
  const raw = event.raw;
  if (raw == null || typeof raw !== "object" || !("areas" in raw)) return null;
  const info = raw as ParsedWeatherWarningTimeseriesInfo;
  const entries = flattenEntries(info);
  if (entries.length === 0) return null;

  // 警報級以上を優先。無ければ全 entry (注意報級)
  const warningTier = entries.filter((e) => e.severity === "special" || e.severity === "warning");
  const pool = warningTier.length > 0 ? warningTier : entries;

  // displaySeverity 降順で種別名を dedup 収集 (自然語名: 「大雨警報」等)
  const sorted = [...pool].sort(
    (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
  );
  const seen = new Set<string>();
  const kinds: string[] = [];
  for (const e of sorted) {
    const label = vpwp50SentenceKind(e);
    if (label.length > 0 && !seen.has(label)) {
      seen.add(label);
      kinds.push(label);
    }
  }
  if (kinds.length === 0) return null;

  const kindStr =
    kinds.length <= MAX_LISTED
      ? kinds.join(LIST_SEPARATOR)
      : `${kinds.slice(0, MAX_LISTED).join(LIST_SEPARATOR)}ほか${kinds.length - MAX_LISTED}件`;
  const area = info.targetArea?.name ?? event.areaNames[0] ?? null;
  return area != null
    ? `${area}で${kindStr}が予測されています。`
    : `${kindStr}が予測されています。`;
}

/**
 * FloodLevel → 洪水予報の情報種別名 + 警戒レベル相当値 (JMA 公式対応)。
 * codebase の内部 FloodLevel L2-L5 が警戒レベル 2-5 相当と一致する:
 *   L2=氾濫注意情報(2) / L3=氾濫警戒情報(3) / L4=氾濫危険情報(4) / L5=氾濫発生情報(5)。
 * L1 (水位上昇のみ)・release (解除)・unknown は種別を確定できないため null (headline フォールバックに落とす)。
 * kindName の生値 (「レベル３氾濫警報」等 fixture により不揃い) ではなく level から正式名を引く。
 */
function floodKindByLevel(level: FloodLevel): { name: string; alertLevel: number } | null {
  switch (level) {
    case "L2": return { name: "氾濫注意情報", alertLevel: 2 };
    case "L3": return { name: "氾濫警戒情報", alertLevel: 3 };
    case "L4": return { name: "氾濫危険情報", alertLevel: 4 };
    case "L5": return { name: "氾濫発生情報", alertLevel: 5 };
    default: return null;
  }
}

/**
 * 洪水予報 (VXKO/VXSU) の一文。「○○川の△△観測所で氾濫警戒情報（警戒レベル3相当）。」形式。
 * 代表 station は headlineLevel の rank 最大 (同 rank は先頭)。河川名 → 観測所名の順で場所を組む。
 * rawStations 空 (Headline-only / VXSU stub) や種別未確定 (解除等) は null を返し headline フォールバックへ。
 */
function floodForecastSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return null; // 取消は共通の取消文に委ねる (観測所データが残る取消電文でも専用文を出さない)
  const raw = event.raw;
  if (raw == null || typeof raw !== "object" || !("rawStations" in raw)) return null;
  const info = raw as ParsedFloodForecastInfo;
  const stations = info.rawStations;
  if (stations.length === 0) return null;
  let rep = stations[0];
  for (const s of stations) {
    if (FLOOD_LEVEL_RANK[s.headlineLevel] > FLOOD_LEVEL_RANK[rep.headlineLevel]) rep = s;
  }
  const kind = floodKindByLevel(rep.headlineLevel);
  if (kind == null) return null;
  const river = rep.primaryRiverName ?? rep.riverNames[0] ?? null;
  const station = rep.stationName !== "" ? rep.stationName : null;
  const where =
    river != null && station != null
      ? `${river}の${station}`
      : station != null
      ? station
      : river;
  if (where == null) return null;
  return `${where}で${kind.name}（警戒レベル${kind.alertLevel}相当）。`;
}

/**
 * 長周期地震動観測 (VXSE62) の一文。「○○を震源とする地震で、東京都23区などで長周期地震動階級3を観測。」形式。
 * 代表地域は最大階級 (event.maxLgInt) と一致する地域から 1 つ。「など」はその最大階級の地域が
 * 複数あるときだけ付ける (下位階級の地域を「など」に含めると最大階級として読めるため)。
 * 震源が取れなければ地域からのみ組む。取消は共通分岐 (default) に委ねるため null を返す。
 */
function lgObservationSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return null;
  const maxLg = formatLgIntensitySpecialValue(event.maxLgIntValue, event.maxLgInt, "ticker");
  if (maxLg == null || maxLg === "") return null;
  // 最大階級と一致する地域だけを母集団にする (from-lg-observation の maxLgInt と同一 parser 由来で書式一致)
  const topAreas = event.maxLgIntValue != null && event.maxLgIntValue.presence !== "value"
    ? event.areaItems.filter((i) => formatLgIntensitySpecialValue(i.maxLgIntValue, i.maxLgInt, "ticker") === maxLg)
    : event.areaItems.filter((i) => i.maxLgInt != null && i.maxLgInt === maxLg);
  const where =
    topAreas.length > 0 ? `${topAreas[0].name}${topAreas.length > 1 ? "など" : ""}で` : "";
  const head = event.hypocenterName != null ? `${event.hypocenterName}を震源とする地震で、` : "";
  if (head === "" && where === "") return null;
  return `${head}${where}長周期地震動階級${maxLg}を観測。`;
}

/** 噴火警戒レベルの公式ラベル (JMA)。frontend standby-cards.ts の VOLCANO_LEVEL_LABELS と同値 */
const VOLCANO_LEVEL_LABELS: Record<number, string> = {
  1: "活火山であることに留意", 2: "火口周辺規制", 3: "入山規制", 4: "高齢者等避難", 5: "避難",
};

/** データ欠落時の非空フォールバック: 正規化 headline を一文整形 (改行→読点、行内空白除去)。
 *  headline も無ければ `${title}が発表されました。` (spec T4: 生 headline を返す経路を残さない) */
function volcanoFallbackSentence(event: PresentationEvent): string {
  const headline = event.headline?.trim();
  if (headline != null && headline !== "") {
    const flattened = headline
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\s　]+/g, ""))
      .filter((line) => line !== "")
      .join("、");
    if (flattened !== "") return ensurePeriod(flattened);
  }
  return ensurePeriod(`${event.title}が発表されました`);
}

/** 火山名 + parser 由来の種別タイトル (「火山名　桜島　」接頭辞は parser 側で除去済み) の announce 文 */
function volcanoAnnounceSentence(name: string, kindTitle: string): string {
  return `${name}の${kindTitle}が発表されました。`;
}

function volcanoTickerPlumeHeight(
  info: ParsedVolcanoEruptionInfo | ParsedVolcanoPlumeInfo,
): string | null {
  if (info.plumeHeightAboveCraterValue == null) {
    return info.plumeHeight == null ? null : `火口上${info.plumeHeight}m`;
  }
  const value = info.plumeHeightAboveCraterValue.value;
  if (plumeHeightUsesLegacyDisplay(info.plumeHeightAboveCraterValue)) {
    return info.plumeHeight == null ? null : `火口上${info.plumeHeight}m`;
  }
  const label = formatPlumeHeightSpecialValue(info.plumeHeightAboveCraterValue, "ticker");
  if (label == null) return null;
  return value.presence === "range" || value.lowerBound != null
    ? `火口上${label}`
    : label;
}

/**
 * 火山ドメインの一文 (spec 2026-07-23 ticker-content-lifetime T4)。
 * bodyText がある電文は tickerBody が優先されるため、ここは本文空電文 (VFVO52/56/60、
 * VolcanoActivity 欠落の実電文で実発生) の headline 生流出を塞ぐのが主務。
 * 契約: 取消以外は必ず非空・非羅列の一文を返す (null は取消時のみ = 共通取消文へ委譲)。
 */
function volcanoSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return null; // 共通の取消文に委ねる
  const name = event.volcanoName != null && event.volcanoName !== "" ? event.volcanoName : null;
  const raw = event.raw;
  const info =
    raw != null && !Array.isArray(raw) && typeof raw === "object" && "kind" in raw
      ? (raw as ParsedVolcanoInfo)
      : null;
  if (info == null || name == null) return volcanoFallbackSentence(event);
  switch (info.kind) {
    case "eruption": {
      const when = info.eventDateTime != null ? formatJst12h(info.eventDateTime) : null;
      const head = info.isFlashReport ? "噴火速報：" : "";
      const plumeHeight = volcanoTickerPlumeHeight(info);
      const plume = plumeHeight == null ? "" : `噴煙は${plumeHeight}。`;
      const phenomenon = info.phenomenonName !== "" ? info.phenomenonName : "噴火";
      return when != null
        ? `${head}${name}で${when}、${phenomenon}が発生しました。${plume}`
        : `${head}${name}で${phenomenon}が発生しました。${plume}`;
    }
    case "alert": {
      if (info.alertLevel != null) {
        const label = VOLCANO_LEVEL_LABELS[info.alertLevel];
        return label != null
          ? `${name}の噴火警戒レベルは${info.alertLevel}（${label}）です。`
          : `${name}の噴火警戒レベルは${info.alertLevel}です。`;
      }
      return info.warningKind !== ""
        ? `${name}に${info.warningKind}が発表されました。`
        : volcanoAnnounceSentence(name, info.title);
    }
    case "ashfall":
      // 降灰予報の詳細は tickerBody (volcanoAshfallToText) の担当。sentence は本文空時の保険
      return volcanoAnnounceSentence(name, info.title);
    case "text":
      return volcanoAnnounceSentence(name, info.title);
    case "plume": {
      const plumeHeight = volcanoTickerPlumeHeight(info);
      if (plumeHeight != null && info.plumeDirection != null) {
        return `${name}の噴煙は${plumeHeight}、${info.plumeDirection}方向へ流れる見込みです。`;
      }
      if (info.plumeDirection != null) {
        return `${name}の噴煙は${info.plumeDirection}方向へ流れる見込みです。`;
      }
      if (plumeHeight != null) {
        return `${name}の噴煙は${plumeHeight}です。`;
      }
      return volcanoAnnounceSentence(name, info.title);
    }
    default: {
      const _exhaustive: never = info;
      return _exhaustive;
    }
  }
}

/**
 * 早期天候情報 (VPAW51) の一文 (spec T5-1)。代表現象 = probabilityPercent 降順 (null は最小扱い)・
 * 同値は配列順 tie-break (現象に公式 severity は無いため蓋然性の高いものを代表とする)。
 * 構造欠落時のみ null → headline フォールバック (VPAW51 の headline は正常な一文)。
 */
function earlyWeatherSentence(event: PresentationEvent): string | null {
  if (event.isCancellation) return null;
  const raw = event.raw;
  if (raw == null || typeof raw !== "object" || !("phenomena" in raw)) return null;
  const info = raw as ParsedEarlyWeatherInfo;
  if (info.phenomena.length === 0) return null;
  const rep = [...info.phenomena].sort(
    (a, b) => (b.probabilityPercent ?? -1) - (a.probabilityPercent ?? -1),
  )[0];
  const area = info.targetArea?.name ?? event.areaNames[0] ?? null;
  const period = rep.periodLabel != null ? `${rep.periodLabel}、` : "";
  const prob = rep.probabilityPercent != null ? `（確率${rep.probabilityPercent}%以上）` : "";
  const rest = info.phenomena.length > 1 ? `ほか${info.phenomena.length - 1}件。` : "";
  const core = `${period}${rep.type}となる可能性があります${prob}。${rest}`;
  return area != null ? `${area}では${core}` : core;
}

/**
 * PresentationEvent → テロップの読める一文。全 19 ドメインで常に非空文字列を返す。
 * nankaiTrough 等の軽症組は headline ベース (default 分岐) に落ちる。
 * floodForecast / lgObservation / earlyWeather は構造化データが取れない場合のみ default 分岐へ、
 * volcano は関数内フォールバック (volcanoFallbackSentence) で必ず一文を返す (spec T4)。
 */
export function buildTickerSentence(event: PresentationEvent): string {
  try {
    let sentence: string | null = null;
    switch (event.domain) {
      case "weather":
        sentence = weatherSentence(event);
        break;
      case "earthquake":
        sentence = earthquakeSentence(event);
        if (sentence == null && !event.isCancellation) {
          const maxInt = tickerIntensityText(event);
          if (hasExplicitIntensityQualifier(event) && maxInt != null) {
            const prefix = event.headline?.trim() || event.title.trim();
            return `${prefix === "" ? "" : `${ensurePeriod(prefix)} `}最大震度${maxInt}を観測しています。`;
          }
          const areas = earthquakeAreaSummary(event.areaItems);
          if (areas != null) {
            const prefix = event.headline?.trim() || event.title.trim();
            if (prefix === "") return areas;
            const prefixBudget = EARTHQUAKE_FALLBACK_MAX_LENGTH - areas.length - 1;
            return `${ellipsize(ensurePeriod(prefix), prefixBudget)} ${areas}`;
          }
          if (maxInt != null) {
            const prefix = event.headline?.trim() || event.title.trim();
            return `${prefix === "" ? "" : `${ensurePeriod(prefix)} `}最大震度${maxInt}を観測しています。`;
          }
        }
        break;
      case "eew":
        sentence = eewSentence(event);
        break;
      case "tsunami":
        sentence = tsunamiSentence(event);
        break;
      case "weatherWarningTimeseries":
        sentence = weatherWarningTimeseriesSentence(event);
        break;
      case "floodForecast":
        sentence = floodForecastSentence(event);
        break;
      case "lgObservation":
        sentence = lgObservationSentence(event);
        break;
      case "volcano":
        sentence = volcanoSentence(event);
        break;
      case "earlyWeather":
        sentence = earlyWeatherSentence(event);
        break;
      default:
        sentence = event.isCancellation
          ? `${event.title}は取り消されました。`
          : null;
        break;
    }
    if (sentence != null && sentence.length > 0) return sentence;
    if (event.isCancellation) return `${event.title}は取り消されました。`;
    return fallbackTickerText(event);
  } catch {
    return fallbackTickerText(event);
  }
}
