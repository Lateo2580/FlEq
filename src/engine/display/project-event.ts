import { intensityToRank } from "../../utils/intensity";
import { normalizeTsunamiKind, resolveTsunamiLevel } from "../../utils/tsunami-kind";
import type { PresentationAreaItem, PresentationEvent } from "../presentation/types";
import { groupIntensityAreas } from "./intensity-groups";
import { buildTickerSentence, tickerCategoryOf, tickerSubjectOf, weatherWarningTimeseriesSentence } from "./ticker-sentence";
import { normalizeTickerBody } from "./ticker-body-normalize";
import { extractTickerEmphasis } from "./ticker-emphasis";
import {
  DISPLAY_PROTOCOL_VERSION,
  type DisplayColorRole,
  type DisplayEmergencyInputV1,
  type DisplayEventDtoV1,
  type DisplayLatestQuakeInputV1,
  type DisplayRecentQuakeV1,
  type DisplayTickerPriority,
  type DisplayTickerSurface,
} from "./types";

/**
 * 地震の深さ表記を表示用に正規化する (Phase A #1)。
 * パーサ (extractEarthquake → parseCoordinate) は既に "30km" / "ごく浅い" 形式で渡すが、
 * 数値のみの文字列 (将来の別経路対策) や空値の防御をここで行う。不明・空は null。
 */
export function normalizeDepth(depth: string | null | undefined): string | null {
  if (depth == null) return null;
  const trimmed = depth.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}km`;
  return trimmed;
}

const LARGE_QUAKE_MIN_RANK = intensityToRank("5弱");
const QUAKE_EXTREME_RANK = intensityToRank("7");

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/** 警報・注意報の対象沿岸のみ抽出 (津波予報 (0.2m 以下) の沿岸を一覧に混ぜない)。全滅時は全件へフォールバック */
function pickAlertCoasts(
  items: PresentationAreaItem[],
  fallbackKind: string,
): Array<{ name: string; kind: string; maxHeight: string | null; firstHeight: string | null }> {
  const alerted = items.filter((i) => i.kind == null || /警報|注意報/.test(i.kind));
  const source = alerted.length > 0 ? alerted : items;
  return source.map((i) => ({
    name: i.name,
    kind: normalizeTsunamiKind(i.kind ?? fallbackKind),
    maxHeight: i.maxHeightDescription ?? null,
    firstHeight: i.firstHeight ?? null,
  }));
}

export { groupIntensityAreas } from "./intensity-groups";

function projectEmergency(event: PresentationEvent): DisplayEmergencyInputV1 | null {
  if (event.domain === "eew") {
    return {
      kind: "eew",
      eventId: event.eventId ?? null,
      serial: event.serial ?? null,
      isWarning: event.isWarning === true,
      isFinal: event.isFinal === true,
      isCancellation: event.isCancellation,
      hypocenterName: event.hypocenterName ?? null,
      forecastMaxInt: event.forecastMaxInt ?? null,
      forecastMaxIntRank: event.forecastMaxIntRank ?? null,
      magnitude: event.magnitude ?? null,
      colorIndex: event.stateSnapshot?.kind === "eew" ? event.stateSnapshot.colorIndex : null,
      reportDateTime: event.reportDateTime,
      originTime: event.originTime ?? null,
      isAssumedHypocenter: event.isAssumedHypocenter === true,
      depth: normalizeDepth(event.depth),
      maxLgInt: event.maxLgInt ?? null,
      regions: event.eewRegions ?? [],
    };
  }
  if (event.domain === "tsunami" && !event.isCancellation) {
    const info = resolveTsunamiLevel(event.tsunamiKinds ?? []);
    if (info == null) return null;
    return {
      kind: "tsunami",
      level: info.level,
      levelLabel: info.label,
      coasts: pickAlertCoasts(event.areaItems, info.label),
      warningComment: event.warningComment ?? null,
      observations: (event.tsunamiObservations ?? []).map((o) => ({
        ...o,
        areaKind: o.areaKind != null ? normalizeTsunamiKind(o.areaKind) : null,
      })),
      reportDateTime: event.reportDateTime,
    };
  }
  if (
    event.domain === "earthquake" &&
    !event.isCancellation &&
    event.maxIntRank != null &&
    event.maxIntRank >= LARGE_QUAKE_MIN_RANK &&
    event.maxInt != null
  ) {
    return {
      kind: "largeQuake",
      eventId: event.eventId ?? null,
      originTime: event.originTime ?? null,
      hypocenterName: event.hypocenterName ?? null,
      magnitude: event.magnitude ?? null,
      maxInt: event.maxInt,
      maxIntRank: event.maxIntRank,
      intensityGroups: groupIntensityAreas(event.areaItems),
      reportDateTime: event.reportDateTime,
      depth: normalizeDepth(event.depth),
      maxLgInt: event.maxLgInt ?? null,
      tsunamiWarning: event.tsunamiWarning === true,
    };
  }
  return null;
}

function projectRecentQuake(event: PresentationEvent): DisplayRecentQuakeV1 | null {
  if (event.domain !== "earthquake" || event.isCancellation) return null;
  if (event.maxInt == null && event.hypocenterName == null) return null;
  return {
    eventId: event.eventId ?? null,
    reportDateTime: event.reportDateTime,
    originTime: event.originTime ?? null,
    hypocenterName: event.hypocenterName ?? null,
    magnitude: event.magnitude ?? null,
    maxInt: event.maxInt ?? null,
    maxIntRank: event.maxIntRank ?? null,
    depth: normalizeDepth(event.depth),
    tsunamiWarning: event.tsunamiWarning === true,
    intensityGroups: groupIntensityAreas(event.areaItems),
  };
}

function projectLatestQuake(event: PresentationEvent): DisplayLatestQuakeInputV1 | null {
  if (event.domain !== "earthquake" || event.isCancellation) return null;
  if (event.maxInt == null && event.hypocenterName == null) return null;
  return {
    eventId: event.eventId ?? null,
    headline: event.headline,
    originTime: event.originTime ?? null,
    hypocenterName: event.hypocenterName ?? null,
    depth: normalizeDepth(event.depth),
    magnitude: event.magnitude ?? null,
    maxInt: event.maxInt ?? null,
    maxIntRank: event.maxIntRank ?? null,
    tsunamiWarning: event.tsunamiWarning === true,
    intensityGroups: groupIntensityAreas(event.areaItems),
    reportDateTime: event.reportDateTime,
  };
}

/** 地域列挙のグループ区切り (「震度4: A、B」のような複数グループを繋ぐ) */
const GROUP_SEPARATOR = "／";
/** 同一グループ内の地域名区切り */
const AREA_SEPARATOR = "、";

/**
 * areaItems を「ラベル: 地域名、地域名」形式で列挙する (テロップ詳細用)。
 * maxInt を持つドメイン (地震系) は震度の大きい順にグルーピング、
 * kind を持つドメイン (気象警報・津波・火山系) は kind ごとにグルーピング、
 * どちらも無ければ地域名だけを列挙する。空配列は null。
 */
function formatAreaGroups(items: PresentationAreaItem[]): string | null {
  if (items.length === 0) return null;
  const groups = groupIntensityAreas(items);
  if (groups.length > 0) {
    return groups.map((g) => `震度${g.intensity}: ${g.areas.join(AREA_SEPARATOR)}`).join(GROUP_SEPARATOR);
  }
  if (items.some((i) => i.kind != null)) {
    const byKind = new Map<string, string[]>();
    for (const item of items) {
      if (item.kind == null) continue;
      const areas = byKind.get(item.kind) ?? [];
      areas.push(item.name);
      byKind.set(item.kind, areas);
    }
    return [...byKind.entries()]
      .map(([kind, areas]) => `${kind}: ${areas.join(AREA_SEPARATOR)}`)
      .join(GROUP_SEPARATOR);
  }
  return items.map((i) => i.name).join(AREA_SEPARATOR);
}

/**
 * テロップ用詳細文 (headline + 地域列挙) を組む。summary より粒度が高い。
 * EEW は緊急パネルが主表示でテロップは補助のため null (Phase A 追加要件)。
 * 文字数上限は設けない (テロップは複数行化するため占有問題がない、2026-07-07 レビュー決定)。
 */
export function buildTickerDetail(event: PresentationEvent): string | null {
  if (event.domain === "eew") return null;
  const parts: string[] = [];
  const headline = event.headline?.trim();
  if (headline) parts.push(headline);
  const areaText = formatAreaGroups(event.areaItems);
  if (areaText) parts.push(areaText);
  if (parts.length === 0) return null;
  return parts.join(" ▪ ");
}

function makeGroupKey(event: PresentationEvent): string | null {
  if (event.domain === "eew") return event.eventId != null ? `eew:${event.eventId}` : null;
  if (event.domain === "tsunami") return "tsunami:current";
  if (event.domain === "earthquake") return event.eventId != null ? `quake:${event.eventId}` : null;
  if (event.domain === "volcano") {
    if (event.eventId == null) return null;
    // 火山コード付きの系列分割は VFVO53 (バッチ per-volcano 展開) に限定する。
    // 他の火山電文 (VFVO56 等) は 1 電文 1 火山で eventId だけで系列が閉じるうえ、
    // 取消電文は Body に VolcanoInfo を持たずコードを取得できない実例がある
    // (test/fixtures/67_01_04 VFVO56 取消)。全電文にコードを付けると
    // 「発表=volcano:id:312 / 取消=volcano:id」に分裂し取消が旧テロップを
    // 置換できなくなる (最終レビュー Sol Important 1)。
    // VFVO53 の取消は対象火山を必ず特定する (aggregator の removeCancelled 前提)
    if (event.type === "VFVO53" && event.volcanoCode != null && event.volcanoCode !== "") {
      return `volcano:${event.eventId}:${event.volcanoCode}`;
    }
    return `volcano:${event.eventId}`;
  }
  if (event.domain === "weather") {
    // VPWS50 は気象庁の全国集約単一ストリーム (集約定時通報)。常に最新 1 件へ畳む。
    if (event.type === "VPWS50") return "weather:vpws50";
    // VPWW55-61 は府県気象台ごとの警報カテゴリ別ストリーム (例: 松江地方気象台の大雨、京都地方
    // 気象台の高潮)。(type, publishingOffice) 単位で系列を 1 本化し、同一府県・同一カテゴリの続報を
    // 最新版へ置換する。異なる府県・異なるカテゴリは別キーとして共存させる。publishingOffice は
    // from-weather で常に非 null。
    return `weather:${event.type}:${event.publishingOffice}`;
  }
  // 解説系・南海トラフ・台風の続報版管理 (spec §4-5)。eventId が無ければ版管理せず null。
  if (event.domain === "nankaiTrough") return event.eventId != null ? `nankai:${event.eventId}` : null;
  if (
    event.domain === "weatherExplanation" ||
    event.domain === "climateInfo" ||
    event.domain === "typhoonAnalysis" ||
    event.domain === "typhoonProbability"
  ) {
    return event.eventId != null ? `${event.domain}:${event.eventId}` : null;
  }
  return null;
}

function summaryRole(event: PresentationEvent): DisplayColorRole {
  if (event.domain === "eew") return event.isWarning === true ? "eewWarning" : "eewForecast";
  if (event.domain === "tsunami") {
    const info = resolveTsunamiLevel(event.tsunamiKinds ?? []);
    if (info?.level === "majorWarning") return "tsunamiMajor";
    if (info?.level === "warning") return "tsunamiWarning";
    if (info?.level === "advisory") return "tsunamiAdvisory";
    return event.frameLevel;
  }
  if (event.domain === "earthquake" && (event.maxIntRank ?? 0) >= LARGE_QUAKE_MIN_RANK) {
    return "quakeMajor";
  }
  // weather (VPWS50/VPWW55-61) の色は「現在の全国集約の最大 severity」で安定させる。
  // frameLevel は静音化 (isUnchanged → info 降格) で灰化しうるため、色にはその巻き添えを受けない
  // displaySeverity を使う。優先度 (tickerPriority) と音 (soundLevel) は従来どおり frameLevel 由来を
  // 保つため、ここでのみ分離する。displaySeverity 未設定の経路では従来の frameLevel 素通しに戻る。
  if (event.domain === "weather") return event.displaySeverity ?? event.frameLevel;
  return event.frameLevel;
}

/**
 * テロップ優先度をサーバの硬い真実 (frameLevel / isWarning / maxIntRank / tsunami level)
 * だけで決める純関数 (spec §2-1、規則 4: フロントで色 role から逆算しない)。
 * 気象・防災系は frameLevel 主判定 (特別警報級・警戒レベル4相当 = critical = high)。
 */
export function tickerPriority(event: PresentationEvent): DisplayTickerPriority {
  if (event.isCancellation) return "low";
  if (event.domain === "eew") return event.isWarning === true ? "high" : "mid";
  if (event.domain === "tsunami") {
    const level = resolveTsunamiLevel(event.tsunamiKinds ?? [])?.level;
    if (level === "majorWarning" || level === "warning") return "high";
    return "mid"; // advisory
  }
  if (event.domain === "earthquake") {
    return (event.maxIntRank ?? 0) >= LARGE_QUAKE_MIN_RANK ? "high" : "mid"; // 5弱+ = high
  }
  if (event.frameLevel === "critical") return "high";
  if (event.frameLevel === "warning") return "mid";
  return "low"; // info/normal/cancel と解説系全般
}

/**
 * テロップ面の判定は engine の保持する一次情報だけで行う。
 * frontend の role / domain 推測を禁止し、取消は必ず面なしへ落とす。
 */
export function tickerSurface(event: PresentationEvent): DisplayTickerSurface {
  if (event.isCancellation) return "none";
  if (event.domain === "tsunami") {
    return resolveTsunamiLevel(event.tsunamiKinds ?? [])?.level === "majorWarning" ? "solid" : "none";
  }
  if (event.domain === "weather") {
    // PresentationEvent の色用 displaySeverity は FrameLevel へ集約済みで L4 と L5 を区別できない。
    // event.raw の ParsedWeatherWarning.maxDisplaySeverity は project 層が持つ engine 側の一次値であり、
    // ここだけで L5 相当を判定できる。
    const severity = weatherDisplaySeverity(event.raw);
    return severity === "officialL5" || severity === "nonLevelSpecial" ? "solid" : "none";
  }
  if (event.domain === "earthquake") return (event.maxIntRank ?? 0) >= QUAKE_EXTREME_RANK ? "solid" : "none";
  return "none";
}

function weatherDisplaySeverity(raw: PresentationEvent["raw"]): unknown {
  if (typeof raw !== "object" || raw == null || !("maxDisplaySeverity" in raw)) return null;
  return raw.maxDisplaySeverity;
}

export function projectDisplayEvent(event: PresentationEvent, summaryText: string): DisplayEventDtoV1 {
  const tickerBody = normalizeTickerBody(event.bodyText);
  const priority = tickerPriority(event);
  // 情報ゼロ電文のテロップ抑制 (spec T5-2)。sentence も body も組めない非取消 VPWP50 は
  // title 単独のノイズテロップになるため流さない (「予測なし」文言は schema 差・parser 縮退でも
  // 起こり得る entries ゼロに偽の安心を与えるため不採用 — 対立的レビュー R2 裁定)
  const tickerSuppressed =
    event.domain === "eew" ||
    (
      event.domain === "weatherWarningTimeseries" &&
      !event.isCancellation &&
      tickerBody == null &&
      weatherWarningTimeseriesSentence(event) == null
    );
  // 重要語句の強調は情報系 (low) と警報級手前 (mid) の本文テロップに載せる。high は割込み意匠と
  // severity 色体系に干渉させないため非適用。ルール側で value(数値)=low 専用、transition/status=low+mid に
  // 絞るため、mid では状態変化・重要状態のみが強調される。本文が縮退等で無いときは空 (強調なし)。
  const emphasis =
    (priority === "low" || priority === "mid") && tickerBody != null
      ? extractTickerEmphasis(tickerBody, priority)
      : [];
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: 0,
    id: event.id,
    eventKey: event.domain === "volcano"
      ? `volcano:${event.eventId ?? event.id}:${event.serial ?? event.reportDateTime}:${event.volcanoCode ?? "-"}:${event.reportDateTime}`
      : `${event.domain}:${event.eventId ?? event.id}:${event.serial ?? event.reportDateTime}`,
    groupKey: makeGroupKey(event),
    domain: event.domain,
    type: event.type,
    infoType: event.infoType,
    reportDateTime: event.reportDateTime,
    serial: event.serial ?? null,
    title: event.title,
    headline: event.headline,
    publishingOffice: event.publishingOffice,
    isTest: event.isTest,
    frameLevel: event.frameLevel,
    isCancellation: event.isCancellation,
    summary: { text: stripAnsi(summaryText), role: summaryRole(event) },
    emergency: projectEmergency(event),
    recentQuake: projectRecentQuake(event),
    tickerDetail: buildTickerDetail(event),
    tickerCategory: tickerCategoryOf(event),
    tickerSubject: tickerSubjectOf(event),
    tickerSuppressed,
    tickerSurface: tickerSurface(event),
    tickerSentence: buildTickerSentence(event),
    tickerPriority: priority,
    tickerBody,
    tickerEmphasis: emphasis.length > 0 ? emphasis : null,
    latestQuake: projectLatestQuake(event),
  };
}
