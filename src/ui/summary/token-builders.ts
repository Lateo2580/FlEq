import type { PresentationEvent } from "../../engine/presentation/types";
import { normalizeLegacyCounterpartDisplayText } from "../../engine/presentation/legacy-counterpart-display-text";
import type { SummaryModel, SummaryToken, SummaryPriority } from "./types";
import type { ParsedWeatherWarning } from "../../types";
import { visualWidth } from "../formatter";
import {
  pickStatusLayer, flattenEntries, summarizeTransitions, weatherCoreDisplaySeverity,
} from "../weather-core-entry";
import { getDisplaySeverityTierPrefix, formatLevelLabel } from "../weather-warning-level-theme";

const VPWW_CORE_TYPES = new Set(["VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61"]);

// ── Helper ──

function token(
  id: string,
  text: string,
  priority: SummaryPriority,
  dropMode: "never" | "shorten" | "drop",
  shortText?: string,
): SummaryToken {
  const minW = shortText != null ? visualWidth(shortText) : visualWidth(text);
  const prefW = visualWidth(text);
  return { id, text, shortText, priority, minWidth: minW, preferredWidth: prefW, dropMode };
}

/** 地方・県名の末尾パターンを除去する簡易短縮 */
function shortenHypocenter(name: string): string {
  return name
    .replace(/地方$/, "")
    .replace(/^.+県/, "");
}

function shortenVolcanoType(type: string): string | undefined {
  if (type === "火山の状況に関する解説情報") return "火山解説情報";
  if (type === "噴火に関する火山観測報") return "噴火火山観測報";
  return undefined;
}

function shortenLegacyType(type: string): string | undefined {
  const shortened = type.replace("情報", "");
  return shortened === type || shortened === "" ? undefined : shortened;
}

/**
 * areaNames を先頭 n 件で結合し、残りがあれば「ほかN」の shortText を返す。
 */
function topAreaTokenParts(
  names: string[],
  limit: number,
): { text: string; shortText?: string } | null {
  if (names.length === 0) return null;
  const top = names.slice(0, limit);
  const text = top.join(",");
  if (names.length > limit) {
    const short = `${top[0]}ほか${names.length - 1}`;
    return { text, shortText: short };
  }
  return { text };
}

// ── Domain builders ──

function buildEewTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // kind
  if (event.isCancellation) {
    tokens.push(token("kind", "EEW取消", 0, "never"));
  } else if (event.isWarning) {
    tokens.push(token("kind", "EEW警報", 0, "never"));
  } else {
    tokens.push(token("kind", "EEW予報", 0, "never"));
  }

  // serial
  if (model.serial) {
    tokens.push(token("serial", model.serial, 1, "drop"));
  }

  // hypocenter
  if (event.hypocenterName) {
    const short = shortenHypocenter(event.hypocenterName);
    tokens.push(
      token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined),
    );
  }

  // maxInt
  const eewMaxInt = event.forecastMaxInt ? `震度${event.forecastMaxInt}` : (model.maxInt ?? "震度-");
  tokens.push(token("maxInt", eewMaxInt, 0, "never"));

  // maxLgInt
  if (model.maxLgInt) {
    tokens.push(token("maxLgInt", model.maxLgInt, 2, "drop"));
  }

  // magnitude
  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 2, "shorten", model.magnitude));
  }

  // depth
  if (model.depth) {
    tokens.push(token("depth", `深さ${model.depth}`, 3, "drop"));
  }

  // forecastAreaTop
  if (event.forecastAreaNames.length > 0) {
    const parts = topAreaTokenParts(event.forecastAreaNames, 3);
    if (parts) {
      tokens.push(token("forecastAreaTop", parts.text, 3, "drop"));
    }
  }

  return tokens;
}

function buildEarthquakeTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  const headType = event.type;

  tokens.push(token("severity", model.severity, 0, "never"));

  if (headType === "VXSE51") {
    // 震度速報
    tokens.push(token("type", "震度速報", 0, "never"));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
    const parts = topAreaTokenParts(event.areaNames, 2);
    if (parts) tokens.push(token("topAreas", parts.text, 1, "shorten", parts.shortText));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
  } else if (headType === "VXSE52") {
    // 震源情報
    tokens.push(token("type", "震源情報", 0, "never"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (model.depth) tokens.push(token("depth", `深さ${model.depth}`, 2, "drop"));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
  } else if (headType === "VXSE53") {
    // 震源・震度情報
    tokens.push(token("type", "震源・震度情報", 0, "shorten", "震源震度"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
    if (model.maxLgInt) tokens.push(token("maxLgInt", model.maxLgInt, 2, "drop"));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
    const parts = topAreaTokenParts(event.areaNames, 2);
    if (parts) tokens.push(token("topAreas", parts.text, 2, "drop"));
  } else if (headType === "VXSE61") {
    // 顕著な地震の震源要素更新のお知らせ (typeLabel の正表記の短縮形。
    // 旧「遠地地震情報」は誤表記だった)
    tokens.push(token("type", "震源要素更新", 0, "shorten", "震源更新"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
  } else {
    // その他の地震電文
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
  }

  return tokens;
}

function buildTsunamiTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // bannerKind: headline から抽出、なければ title
  const bannerKind = event.headline ?? event.title;
  tokens.push(token("bannerKind", bannerKind, 0, "never"));

  // topAreas
  const parts = topAreaTokenParts(event.forecastAreaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "shorten", parts.shortText));

  // areaCount
  if (event.forecastAreaCount > 0) {
    tokens.push(token("areaCount", `(${event.forecastAreaCount}地域)`, 1, "drop"));
  }

  // hypocenter
  if (event.hypocenterName) {
    tokens.push(token("hypocenter", event.hypocenterName, 3, "drop"));
  }

  // magnitude
  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 3, "drop"));
  }

  return tokens;
}

function buildVolcanoTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  const headType = event.type;

  tokens.push(token("severity", model.severity, 0, "never"));

  if (headType === "VFVO50" || headType.startsWith("VFSV")) {
    // 火山警報
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.alertLevel != null) {
      tokens.push(token("alertLevel", `Lv${event.alertLevel}`, 0, "shorten"));
    }
    if (event.areaCount > 0) {
      tokens.push(token("areaCount", `対象${event.areaCount}市町村`, 2, "drop"));
    }
  } else if (headType === "VFVO52" || headType === "VFVO56") {
    // 噴火速報 / 噴火情報
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    // phenomenon/plumeHeight: try to extract from raw if available
    // Phase 3 - use available info only
  } else if (headType === "VFVO53" || headType === "VFVO54" || headType === "VFVO55") {
    // 降灰
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.areaCount > 0) {
      tokens.push(token("areaCount", `対象${event.areaCount}地域`, 1, "drop"));
    }
  } else if (headType === "VFVO51" || headType === "VZVO40") {
    // 火山テキスト
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.headline) {
      tokens.push(token("headline", event.headline, 1, "shorten"));
    }
    if (event.alertLevel != null) {
      tokens.push(token("alertLevel", `Lv${event.alertLevel}`, 2, "drop"));
    }
  } else if (headType === "VFVO60") {
    // 噴煙流向
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
  } else {
    // fallback
    tokens.push(token("type", event.title, 0, "shorten", shortenVolcanoType(event.title)));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
  }

  return tokens;
}

function buildSeismicTextTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", event.title, 0, "shorten"));
  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "shorten"));
  }

  return tokens;
}

function buildLgObservationTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", "長周期地震動観測情報", 0, "shorten", "長周期観測"));

  if (event.hypocenterName) {
    const short = shortenHypocenter(event.hypocenterName);
    tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
      short !== event.hypocenterName ? short : undefined));
  }

  if (model.maxLgInt) {
    // "長周期4" → shortText "L4"
    const lgNum = model.maxLgInt.replace("長周期", "");
    tokens.push(token("maxLgInt", model.maxLgInt, 0, "shorten", `L${lgNum}`));
  }

  if (model.maxInt) {
    tokens.push(token("maxInt", model.maxInt, 1, "shorten"));
  }

  const parts = topAreaTokenParts(event.observationNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop"));

  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 2, "drop"));
  }

  if (model.depth) {
    tokens.push(token("depth", `深さ${model.depth}`, 3, "drop"));
  }

  return tokens;
}

function buildNankaiTroughTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", "南海トラフ臨時情報", 0, "shorten", "南海トラフ"));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "shorten"));
  }

  return tokens;
}

function buildWeatherTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // VPWW55-61 は tier prefix + L 表記 + 遷移サマリーを追加 (Phase A T28)。
  // event.raw が ParsedWeatherWarning。VPWS50 や他種別は従来トークンのまま。
  const raw = event.raw as ParsedWeatherWarning | null;
  const isVpwwCore = raw != null && VPWW_CORE_TYPES.has(raw.type) && !event.isCancellation;

  if (event.isCancellation) {
    tokens.push(token("type", "気象警報・注意報取消", 0, "shorten", "気象取消"));
  } else if (isVpwwCore) {
    const sev = weatherCoreDisplaySeverity(raw);
    const layer = pickStatusLayer(raw);
    const entries = layer ? flattenEntries(layer) : [];
    const rep = entries[0];
    const prefixed = rep != null
      ? `${getDisplaySeverityTierPrefix(sev)} ${formatLevelLabel(rep.officialAlertLevel, rep.kindName)}`
      : event.title;
    tokens.push(token("type", prefixed, 0, "shorten", "気象警報"));
  } else {
    tokens.push(token("type", event.title, 0, "shorten", "気象警報"));
  }

  if (event.municipalityCount > 0) {
    tokens.push(token("warningCount", `警報${event.municipalityCount}`, 1, "drop"));
  }
  if (event.forecastAreaCount > 0) {
    tokens.push(token("advisoryCount", `注意報${event.forecastAreaCount}`, 2, "drop"));
  }

  // 代表地域は 警報地域 > 注意報地域 > その他 の順で選ぶ
  // (municipalityNames に警報、forecastAreaNames に注意報を入れている: from-weather.ts)
  const repSource =
    event.municipalityNames.length > 0
      ? event.municipalityNames
      : event.forecastAreaNames.length > 0
      ? event.forecastAreaNames
      : event.areaNames;
  const parts = topAreaTokenParts(repSource, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop", parts.shortText));

  // VPWW55-61 遷移サマリー (新規/昇格/解除)
  if (isVpwwCore) {
    const layer = pickStatusLayer(raw);
    const entries = layer ? flattenEntries(layer) : [];
    const tr = summarizeTransitions(entries);
    const sum = [
      tr.added ? `新規${tr.added}` : null,
      tr.upgraded ? `昇格${tr.upgraded}` : null,
      tr.released ? `解除${tr.released}` : null,
    ].filter((x): x is string => x != null).join("/");
    if (sum) tokens.push(token("transitions", sum, 3, "drop"));
  }

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildTornadoTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  if (event.isCancellation) {
    tokens.push(token("type", "竜巻注意情報取消", 0, "shorten", "竜巻取消"));
  } else {
    tokens.push(token("type", "竜巻注意情報", 0, "shorten", "竜巻"));
  }

  // raw 経由で hasSightingAreas を直接見る (PresentationEvent フィールドの流用は避ける)
  const rawTornado = event.raw as { hasSightingAreas?: boolean; isSightingTelegram?: boolean } | null;
  if (rawTornado?.hasSightingAreas) {
    tokens.push(token("sighting", "目撃情報あり", 0, "never"));
  } else if (rawTornado?.isSightingTelegram) {
    tokens.push(token("sighting", "目撃情報電文", 0, "drop"));
  }

  if (event.areaCount > 0) {
    tokens.push(token("areaCount", `${event.areaCount}地域`, 1, "drop"));
  }

  // 代表地域: raw.sightingAreas (目撃情報地域) を優先、無ければ event.areaNames
  const rawTornadoFull = event.raw as { sightingAreas?: { name: string }[] } | null;
  const sightingNames = rawTornadoFull?.sightingAreas?.map((a) => a.name) ?? [];
  const repSource = sightingNames.length > 0 ? sightingNames : event.areaNames;
  const parts = topAreaTokenParts(repSource, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop", parts.shortText));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildBriefingTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  const rawBriefing = event.raw as
    | { briefingTag?: string; briefingCondition?: string; observations?: { description: string }[] }
    | null;
  const tagLabelMap: Record<string, string> = {
    linearRainObserved: "線状降水帯発生",
    linearRainPredicted: "線状降水帯予想",
    recordRain: "記録的短時間大雨",
    shortSnow: "短時間大雪",
    other: "気象防災速報",
  };

  if (event.isCancellation) {
    tokens.push(token("type", "気象防災速報取消", 0, "shorten", "防災取消"));
  } else {
    const tagLabel = tagLabelMap[rawBriefing?.briefingTag ?? "other"] ?? "気象防災速報";
    tokens.push(token("type", tagLabel, 0, "shorten", "防災速報"));
  }

  if (event.areaCount > 0) {
    tokens.push(token("areaCount", `${event.areaCount}地域`, 1, "drop"));
  }

  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop", parts.shortText));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildEarlyWeatherTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  if (event.isCancellation) {
    tokens.push(token("type", "早期天候情報取消", 0, "shorten", "早期取消"));
  } else {
    tokens.push(token("type", "早期天候情報", 0, "shorten", "早期天候"));
  }

  // タイトルから現象タグを抽出 (例: "高温に関する早期天候情報（東北地方）" → "高温")
  const match = event.title.match(/^(.+?)に関する早期天候情報/);
  if (match) {
    tokens.push(token("phenomenon", match[1], 1, "shorten"));
  }

  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop", parts.shortText));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildWeatherExplanationTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  const label = event.controlTitle || "気象解説情報";
  if (event.isCancellation) {
    tokens.push(token("type", `${label}取消`, 0, "shorten", "解説取消"));
  } else {
    tokens.push(token("type", label, 0, "shorten", "気象解説"));
  }

  // 対象地域
  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "drop", parts.shortText));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 2, "drop"));
  }

  return tokens;
}

function buildClimateInfoTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // controlTitle は空文字になりうるので || でフォールバック (VPZI50=全般/VPCI50=地方)
  const label = event.controlTitle || "天候情報";
  if (event.isCancellation) {
    tokens.push(token("type", `${label}取消`, 0, "shorten", "天候取消"));
  } else {
    tokens.push(token("type", label, 0, "shorten", "天候情報"));
  }

  // 対象地域 (TargetArea が中心。例: 「全国」)
  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "drop", parts.shortText));

  // 観測点件数
  if (event.observationCount > 0) {
    tokens.push(
      token("observationCount", `観測点${event.observationCount}地点`, 2, "drop"),
    );
  }

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildWeatherWarningTimeseriesTokens(
  event: PresentationEvent,
  model: SummaryModel,
): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  if (event.isCancellation) {
    tokens.push(
      token("type", "気象時系列取消", 0, "shorten", "時系列取消"),
    );
  } else {
    tokens.push(token("type", "気象時系列", 0, "shorten", "時系列"));
  }

  // 対象地域
  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "drop", parts.shortText));

  // 市町村件数
  if (event.municipalityCount > 0) {
    tokens.push(
      token(
        "areaCount",
        `${event.municipalityCount}地域`,
        2,
        "drop",
      ),
    );
  }

  if (event.headline) {
    tokens.push(token("headline", event.headline, 3, "drop"));
  }

  return tokens;
}

function buildHeatAlertTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  if (event.isCancellation) {
    tokens.push(token("type", "熱中症警戒アラート取消", 0, "shorten", "熱中症取消"));
  } else {
    tokens.push(token("type", "熱中症警戒アラート", 0, "shorten", "熱中症"));
  }

  // 対象府県 (Title 由来の 1 件)
  const parts = topAreaTokenParts(event.areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "drop", parts.shortText));

  // 表示 headline (from-heat-alert が本文先頭文を合成済み)
  if (event.headline) {
    tokens.push(token("headline", event.headline, 2, "drop"));
  }

  return tokens;
}

function buildTyphoonAnalysisTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  tokens.push(token("severity", model.severity, 0, "never"));
  if (event.isCancellation) {
    tokens.push(token("type", "台風解析取消", 0, "shorten", "台風取消"));
  } else {
    tokens.push(token("type", "台風解析・予報", 0, "shorten", "台風"));
  }
  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "drop"));
  }
  return tokens;
}

function buildTyphoonProbabilityTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  tokens.push(token("severity", model.severity, 0, "never"));
  if (event.isCancellation) {
    tokens.push(token("type", "暴風域確率取消", 0, "shorten", "台風確率取消"));
  } else {
    tokens.push(token("type", "暴風域確率", 0, "shorten", "台風確率"));
  }
  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "drop"));
  }
  return tokens;
}

function buildFloodForecastTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  // Task 4 (compile unit) では tsc green のための最小 token のみ。
  // Task 26 で河川別観測点 / レベル / 氾濫情報の token を本実装。
  const tokens: SummaryToken[] = [];
  tokens.push(token("severity", model.severity, 0, "never"));
  if (event.isCancellation) {
    tokens.push(token("type", "洪水予報取消", 0, "shorten", "洪水取消"));
  } else {
    tokens.push(token("type", "洪水予報", 0, "shorten", "洪水"));
  }
  if (event.title) {
    tokens.push(token("title", event.title, 1, "shorten"));
  }
  return tokens;
}

function buildLegacyCounterpartTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  const type = normalizeLegacyCounterpartDisplayText(event.type);
  const title = normalizeLegacyCounterpartDisplayText(event.title);
  const headline = event.headline == null
    ? null
    : normalizeLegacyCounterpartDisplayText(event.headline);
  const areaNames = event.areaNames.map(normalizeLegacyCounterpartDisplayText);
  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", type, 0, "shorten", shortenLegacyType(type)));
  tokens.push(token("qualifier", "対応電文未確認", 0, "shorten", "対応未確認"));
  if (title) tokens.push(token("title", title, 1, "shorten"));
  if (headline) tokens.push(token("headline", headline, 2, "drop"));
  const parts = topAreaTokenParts(areaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "shorten", parts.shortText));
  return tokens;
}

function buildRawTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("RAW", "RAW", 0, "never"));
  tokens.push(token("type", event.type, 0, "never"));

  if (event.title) {
    tokens.push(token("title", event.title, 1, "shorten"));
  }

  if (event.headline) {
    tokens.push(token("headline", event.headline, 2, "drop"));
  }

  if (event.publishingOffice) {
    tokens.push(token("office", event.publishingOffice, 3, "drop"));
  }

  return tokens;
}

// ── Public API ──

export function buildSummaryTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  switch (model.domain) {
    case "eew":
      return buildEewTokens(event, model);
    case "earthquake":
      return buildEarthquakeTokens(event, model);
    case "tsunami":
      return buildTsunamiTokens(event, model);
    case "volcano":
      return buildVolcanoTokens(event, model);
    case "seismicText":
      return buildSeismicTextTokens(event, model);
    case "lgObservation":
      return buildLgObservationTokens(event, model);
    case "nankaiTrough":
      return buildNankaiTroughTokens(event, model);
    case "weather":
      return buildWeatherTokens(event, model);
    case "tornado":
      return buildTornadoTokens(event, model);
    case "briefing":
      return buildBriefingTokens(event, model);
    case "earlyWeather":
      return buildEarlyWeatherTokens(event, model);
    case "weatherWarningTimeseries":
      return buildWeatherWarningTimeseriesTokens(event, model);
    case "climateInfo":
      return buildClimateInfoTokens(event, model);
    case "weatherExplanation":
      return buildWeatherExplanationTokens(event, model);
    case "heatAlert":
      return buildHeatAlertTokens(event, model);
    case "typhoonAnalysis":
      return buildTyphoonAnalysisTokens(event, model);
    case "typhoonProbability":
      return buildTyphoonProbabilityTokens(event, model);
    case "floodForecast":
      return buildFloodForecastTokens(event, model);
    case "legacyCounterpart":
      return buildLegacyCounterpartTokens(event, model);
    case "raw":
      return buildRawTokens(event, model);
  }
}
