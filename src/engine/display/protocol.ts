// src/engine/display/protocol.ts
// PROTOCOL-SYNC-BEGIN
// このマーカー間は display/frontend/src/lib/protocol.ts と全文一致させる (手動同期)。
// 同期は test/engine/display/protocol-sync.test.ts が検証する (Task 11 で作成)。

export const DISPLAY_PROTOCOL_VERSION = 1 as const;

export type DisplayFrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

export type DisplayColorRole =
  | DisplayFrameLevel
  | "eewWarning" | "eewForecast"
  | "tsunamiMajor" | "tsunamiWarning" | "tsunamiAdvisory"
  | "quakeMajor"
  | "weatherEmergency" | "weatherWarning" | "weatherAdvisory"   // weatherEmergency を追加
  | "connectionOk" | "connectionStale"
  | "muted";

export interface DisplaySummaryLineV1 {
  text: string;
  role: DisplayColorRole;
}

export type DisplaySpecialValuePresenceV1 =
  | "value"
  | "missing"
  | "empty"
  | "unknown"
  | "qualitative"
  | "range";

export type DisplayIntensityBadgeV1 = null | "≥" | "↔" | "?" | "∅";

export type DisplayIntensityColorV1 =
  | "normalRank"
  | "safetyRank"
  | "safetyUpperRank"
  | "unknown"
  | "neutral"
  | "notRendered";

/** V1 additive semantic. Legacy clients keep using the sibling scalar/rank fields. */
export interface DisplayIntensitySemanticV1 {
  raw: string | null;
  presence: DisplaySpecialValuePresenceV1;
  label: string | null;
  condition: string | null;
  description: string | null;
  lowerBound: string | null;
  upperBound: string | null;
  rawLowerBound: string | null;
  rawUpperBound: string | null;
  badge: DisplayIntensityBadgeV1;
  color: DisplayIntensityColorV1;
  render: boolean;
  safetyLowerRank: number | null;
  safetyUpperRank: number | null;
  /** range=upper??lower, qualitative=lower. Card/severity ordering uses this value. */
  safetyRank: number | null;
  /** The rank whose color is used. unknown/empty/missing are null. */
  colorRank: number | null;
}

export type DisplayTsunamiHeightBadgeV1 = null | "≥" | "↔" | "?" | "∅";

export type DisplayTsunamiHeightColorV1 =
  | "normalRank"
  | "safetyRank"
  | "safetyUpperRank"
  | "unknown"
  | "neutral"
  | "notRendered";

/** V1 additive semantic for numeric-domain tsunami heights (meters). */
export interface DisplayTsunamiHeightSemanticV1 {
  raw: string | null;
  presence: DisplaySpecialValuePresenceV1;
  label: string | null;
  condition: string | null;
  description: string | null;
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  rawLowerBound: string | null;
  rawUpperBound: string | null;
  badge: DisplayTsunamiHeightBadgeV1;
  color: DisplayTsunamiHeightColorV1;
  render: boolean;
}

export type DisplayNumericSpecialValueBadgeV1 = null | "≥" | "↔" | "?" | "∅";

export type DisplayNumericSpecialValueColorV1 =
  | "normalRank"
  | "safetyRank"
  | "safetyUpperRank"
  | "unknown"
  | "neutral"
  | "notRendered";

/** Magnitude／Depth 共通の additive wire semantic。bounds は常に明示 null に固定する。 */
export interface DisplayNumericSpecialValueSemanticV1 {
  raw: string | null;
  presence: DisplaySpecialValuePresenceV1;
  label: string | null;
  condition: string | null;
  description: string | null;
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  rawLowerBound: string | null;
  rawUpperBound: string | null;
  badge: DisplayNumericSpecialValueBadgeV1;
  color: DisplayNumericSpecialValueColorV1;
  render: boolean;
}

/** Infinity を使わず JSON round-trip できる Magnitude 順序 semantic。 */
export type DisplayMagnitudeRankV1 =
  | { kind: "giant" }
  | { kind: "value"; value: number }
  | { kind: "range"; lowerBound: number | null; upperBound: number | null }
  | { kind: "unranked" };

export interface DisplayMagnitudeSemanticV1 extends DisplayNumericSpecialValueSemanticV1 {
  rank: DisplayMagnitudeRankV1;
}

export type DisplayDepthSemanticV1 = DisplayNumericSpecialValueSemanticV1;

/** Infinity を使わず JSON round-trip できる台風数値の比較順位。 */
export type DisplayTyphoonNumericRankV1 =
  | { kind: "value"; value: number }
  | { kind: "range"; lowerBound: number | null; upperBound: number | null }
  | { kind: "unranked" };

/** 中心気圧・風速・移動速度に共通する additive wire semantic。 */
export interface DisplayTyphoonNumericSemanticV1 extends DisplayNumericSpecialValueSemanticV1 {
  rank: DisplayTyphoonNumericRankV1;
}

export type DisplaySpecialValueDiagnosticV1 =
  | "unmappedSpecialValue"
  | "specialValueConflict"
  | "legacyNullUnknown";

export type DisplayPlumeHeightReferenceV1 = "aboveCrater" | "aboveSeaLevel";
export type DisplayPlumeHeightUnitV1 = "m" | "FT";

/** Infinity を含まず JSON round-trip できる噴煙高度 rank。 */
export type DisplayPlumeHeightRankV1 =
  | {
      kind: "value";
      reference: DisplayPlumeHeightReferenceV1;
      unit: DisplayPlumeHeightUnitV1;
      value: number;
    }
  | {
      kind: "range";
      reference: DisplayPlumeHeightReferenceV1;
      unit: DisplayPlumeHeightUnitV1;
      lowerBound: number | null;
      upperBound: number | null;
    }
  | {
      kind: "unranked";
      reference: DisplayPlumeHeightReferenceV1;
      unit: DisplayPlumeHeightUnitV1;
    };

/** PlumeHeight canonical の additive wire semantic。bounds は明示 null。 */
export interface DisplayPlumeHeightSemanticV1 extends DisplayNumericSpecialValueSemanticV1 {
  reference: DisplayPlumeHeightReferenceV1;
  unit: DisplayPlumeHeightUnitV1;
  diagnostics: DisplaySpecialValueDiagnosticV1[];
  rank: DisplayPlumeHeightRankV1;
}

export type DisplayLgIntensityRankV1 = 0 | 1 | 2 | 3 | 4;

/** V1 additive semantic for JMA long-period ground motion class (rank 0..4). */
export interface DisplayLgIntensitySemanticV1 extends Omit<
  DisplayIntensitySemanticV1,
  "safetyLowerRank" | "safetyUpperRank" | "safetyRank" | "colorRank"
> {
  safetyLowerRank: DisplayLgIntensityRankV1 | null;
  safetyUpperRank: DisplayLgIntensityRankV1 | null;
  safetyRank: DisplayLgIntensityRankV1 | null;
  colorRank: DisplayLgIntensityRankV1 | null;
}

export interface DisplayEewRegionV1 {
  name: string;
  intensitySemantic?: DisplayIntensitySemanticV1;
  intensity: string;            // 予測震度 (下限)
  intensityTo: string | null;   // 範囲予測の上限 (なければ null)
  /** 旧 V1 では欠落。semantic 非対応 frontend 向けの表示 scalar。 */
  lgIntensity?: string | null;
  /** ForecastLgInt の qualifier を保持する V1 additive semantic。 */
  lgIntensitySemantic?: DisplayLgIntensitySemanticV1;
  isPlum: boolean;
  hasArrived: boolean;
  arrivalTime: string | null;   // 主要動到達予測時刻
}

export interface DisplayEewRestoreRevisionV1 {
  sourceType: string;
  serial: string | null;
  isCorrection: boolean;
}

export interface DisplayEewInputV1 {
  kind: "eew";
  eventId: string | null;
  /** EEW revision family。旧 V1 DTO では欠落するため optional。 */
  sourceType?: string;
  serial: string | null;
  isWarning: boolean;
  isFinal: boolean;
  isCancellation: boolean;
  isCorrection?: boolean;
  /** 終端を撤回した抑止 family の revision。旧 V1 DTO では欠落する。 */
  restoreRevision?: DisplayEewRestoreRevisionV1;
  hypocenterName: string | null;
  forecastMaxInt: string | null;
  forecastMaxIntRank: number | null;
  forecastMaxIntSemantic?: DisplayIntensitySemanticV1;
  magnitude: string | null;
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  colorIndex: number | null;
  reportDateTime: string;
  originTime: string | null;
  isAssumedHypocenter: boolean;
  depth: string | null;
  depthSemantic?: DisplayDepthSemanticV1;
  maxLgInt: string | null;
  maxLgIntSemantic?: DisplayLgIntensitySemanticV1;
  regions: DisplayEewRegionV1[];
}

export type DisplayTsunamiLevel = "majorWarning" | "warning" | "advisory";

export interface DisplayTsunamiObservationV1 {
  areaName: string | null;   // 属する予報区名 (対応が取れない場合 null)
  /** 属する予報区の Area.Code。旧 snapshot は欠落するため optional。 */
  areaCode?: string | null;
  areaKind: string | null;   // その予報区の現在の警報種別 (フロントのレベル別フィルタ用)
  stationCode?: string | null;    // 観測点コード (旧 snapshot は欠落)
  stationName: string;
  arrivalTime: string | null;
  initial: string | null;         // 第一波の状況
  maxHeightValue: string | null;  // 最大波の高さ (パーサにあれば)
  /** TsunamiHeight の qualifier と numeric bounds。旧 V1 snapshot は欠落するため optional。 */
  maxHeightSemantic?: DisplayTsunamiHeightSemanticV1;
  condition: string | null;       // 最大波の状況 (maxHeightCondition)
  heightCondition?: string | null; // TsunamiHeight@condition (例: 上昇中)
}

export interface DisplayTsunamiInputV1 {
  kind: "tsunami";
  level: DisplayTsunamiLevel;
  levelLabel: string; // "大津波警報" | "津波警報" | "津波注意報"
  coasts: Array<{
    name: string;
    kind: string;
    /** 予報区の Area.Code。名称から推定しない。旧 snapshot は欠落するため optional。 */
    areaCode?: string | null;
    /** 予報区の Kind.Code。名称から推定しない。旧 snapshot は欠落するため optional。 */
    kindCode?: string | null;
    maxHeight: string | null;    // 予想波高の記述 (例 "10m超", "3m") = maxHeightDescription
    /** TsunamiHeight の qualifier と numeric bounds。旧 V1 snapshot は欠落するため optional。 */
    maxHeightSemantic?: DisplayTsunamiHeightSemanticV1;
    firstHeight: string | null;  // 第一波到達予想 (例 "ただちに津波来襲と予測", "07日15時30分頃")
  }>;
  warningComment: string | null;  // 警報付帯コメント
  observations: DisplayTsunamiObservationV1[];
  reportDateTime: string;
  /** 津波電文に含まれる地震要素。旧 V1 DTO では欠落するため optional。 */
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  /** 津波電文に含まれる地震要素。旧 V1 DTO では欠落するため optional。 */
  depthSemantic?: DisplayDepthSemanticV1;
}

/** 既存 DisplayIntensityGroupV1 に omittedAreaCount を追加 (縮退後も「ほか N 地域」を出せる構造。
 * spec snapshot 縮退予算 §2)。groupIntensityAreas は 0、縮退 (Task 14) が切った分を加算する。 */
export interface DisplayIntensityGroupV1 {
  intensity: string;
  rank: number;
  intensitySemantic?: DisplayIntensitySemanticV1;
  areas: string[];
  omittedAreaCount: number;   // 追加 (必須)
  /** 展開候補。欠落は旧 snapshot 互換=展開しない。現行表示分を先頭に含む canonical prefix */
  expandedAreas?: string[];
  /** 候補が安全弁または snapshot 縮退で切られた。欠落は旧 snapshot 互換=未提供 */
  candidateTruncated?: boolean;
}

/** 震度地図の区域値。Phase 1〜4 は一次細分区域だけを wire に載せる。 */
export interface DisplayIntensityMapValueV1 {
  code: string;
  rank: number;
  intensitySemantic?: DisplayIntensitySemanticV1;
}

/** standby-registry の StandbyRevision と同じ wire 表現。 */
export interface DisplayStandbyRevisionV1 {
  reportTimeMs: number;
  serial: string | null;
}

export interface DisplayQuakeIntensityMapEventV1 {
  eventKey: string;
  eventId: string | null;
  sourceType: string;
  revision: DisplayStandbyRevisionV1;
  reportDateTime: string;
  originTime: string | null;
  hypocenterName: string | null;
  depth: string | null;
  depthSemantic?: DisplayDepthSemanticV1;
  magnitude: string | null;
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  maxInt: string;
  maxIntRank: number;
  maxIntSemantic?: DisplayIntensitySemanticV1;
  /** 全体 MaxInt と地域から選んだ表示値が異なる場合の、電文全体値 provenance。 */
  reportedMaxIntSemantic?: DisplayIntensitySemanticV1;
  tsunamiWarning: boolean;
  intensityGroups: DisplayIntensityGroupV1[];
  localAreas: DisplayIntensityMapValueV1[];
  updatedAtMs: number;
}

export interface DisplayQuakeIntensityMapV1 {
  events: DisplayQuakeIntensityMapEventV1[];
  nonEmergencyHost: {
    eventKey: string;
    expiresAtMs: number;
  } | null;
  /** all-unknown 専用の additive host。既知 host と同時に画面選択しない。 */
  unknownHost?: {
    eventKey: string;
    expiresAtMs: number;
  } | null;
}

/** spec §5.2 の名称との互換 alias。 */
export type DisplayQuakeMapEventV1 = DisplayQuakeIntensityMapEventV1;
export type DisplayQuakeMapStateV1 = DisplayQuakeIntensityMapV1;

export interface DisplayMapLayersV1 {
  quake?: DisplayQuakeIntensityMapV1;
}

/** 地震情報カードの射影入力 (project-event が生成、store が updatedAtMs を付す) */
export interface DisplayLatestQuakeInputV1 {
  eventId: string | null;
  headline: string | null;
  originTime: string | null;
  hypocenterName: string | null;
  depth: string | null;
  depthSemantic?: DisplayDepthSemanticV1;
  magnitude: string | null;
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  maxInt: string | null;
  maxIntRank: number | null;
  maxIntSemantic?: DisplayIntensitySemanticV1;
  tsunamiWarning: boolean;
  intensityGroups: DisplayIntensityGroupV1[];
  reportDateTime: string;
}

export interface DisplayLatestQuakeStateV1 extends DisplayLatestQuakeInputV1 {
  updatedAtMs: number;
}

/** 受信アクティビティ + 統計 (計器列) */
export interface DisplayStatsV1 {
  sparklineData: number[];   // 直近 30 分, 1 分 × 30 スロット (古い順)
  totalReceived: number;     // 当日 (JST) 累積受信数。0 時 JST でリセット
  todayQuakeCount: number;   // 本日 (JST) の地震件数
  todayMaxInt: string | null;
  todayMaxIntRank: number | null;
  /** standby salvage backup が memory-only のままかを運用側へ示す。 */
  persistenceSalvageBackupBlocked?: number;
  persistenceSalvageBackupRecovered?: number;
  persistenceSalvageBackupPendingSources?: number;
}

/** 画面全体の緊張度 tier (server 導出)。描画は §4 別プラン */
export type DisplaySeverityTier = "calm" | "caution" | "alert" | "critical";

/** 背景の緊張度。判定と保持は engine が一元的に所有する。 */
export type DisplayBackgroundTone =
  | "calm"
  | "caution"
  | "alert"
  | "critical"
  | "quakeExtreme";

/** テロップ本文に不透明な色面を敷くか。 */
export type DisplayTickerSurface = "none" | "solid";

export interface DisplayLargeQuakeInputV1 {
  kind: "largeQuake";
  eventId: string | null;
  originTime: string | null;
  hypocenterName: string | null;
  magnitude: string | null;
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  maxInt: string;
  maxIntRank: number;
  maxIntSemantic?: DisplayIntensitySemanticV1;
  intensityGroups: DisplayIntensityGroupV1[];
  reportDateTime: string;
  depth: string | null;
  depthSemantic?: DisplayDepthSemanticV1;
  maxLgInt: string | null;
  tsunamiWarning: boolean;
  /** 対応地図を参照する三点組。三つ揃わない場合は文字表示だけに縮退する。 */
  mapEventKey?: string;
  mapSourceType?: string;
  mapRevision?: DisplayStandbyRevisionV1;
}

export type DisplayEmergencyInputV1 =
  | DisplayEewInputV1
  | DisplayTsunamiInputV1
  | DisplayLargeQuakeInputV1;

export interface DisplayRecentQuakeV1 {
  eventId: string | null;
  reportDateTime: string;
  originTime: string | null;
  hypocenterName: string | null;
  magnitude: string | null;
  magnitudeSemantic?: DisplayMagnitudeSemanticV1;
  maxInt: string | null;
  maxIntRank: number | null;
  maxIntSemantic?: DisplayIntensitySemanticV1;
  depth: string | null;
  depthSemantic?: DisplayDepthSemanticV1;
  tsunamiWarning: boolean;
  /** 各地の震度 (履歴カードのクリック再表示用)。groupIntensityAreas 由来で latestQuake と同構造。
   *  古い snapshot には無いためフロントは欠落を空配列として扱う */
  intensityGroups?: DisplayIntensityGroupV1[];
}

/** テロップ優先度。フロントのスケジューラが割込み判定に使う (spec §2-1) */
export type DisplayTickerPriority = "high" | "mid" | "low";

export interface DisplayEventDtoV1 {
  version: typeof DISPLAY_PROTOCOL_VERSION;
  seq: number; // hub が採番。projectDisplayEvent 時点では 0
  id: string;
  eventKey: string;
  groupKey: string | null;
  domain: string; // PresentationDomain と同値。import-free のため string
  type: string;
  infoType: string;
  reportDateTime: string;
  /** 系列内の続報順序。欠落時は reportDateTime のみで比較する。 */
  serial?: string | null;
  title: string;
  headline: string | null;
  publishingOffice: string;
  isTest: boolean;
  frameLevel: DisplayFrameLevel;
  isCancellation: boolean;
  summary: DisplaySummaryLineV1;
  emergency: DisplayEmergencyInputV1 | null;
  recentQuake: DisplayRecentQuakeV1 | null;
  latestQuake: DisplayLatestQuakeInputV1 | null;
  tickerDetail: string | null;  // テロップ用詳細文 (headline + 地域列挙)。summary より粒度が高い
  /** テロップ左端の種別ラベル (「気象警報・注意報（全国集約）」等)。optional は protocol 移行の安全化 */
  tickerCategory?: string | null;
  /** テロップ本文の文章体。null/欠落時はフロントが従来連結にフォールバックする */
  tickerSentence?: string | null;
  /** テロップ優先度。フロントのスケジューラが割込み判定に使う。
   *  null/欠落時はフロントが "low" として扱う (protocol 移行の安全化) */
  tickerPriority?: DisplayTickerPriority | null;
  /** テロップ本文全文 (解説系の全文配線)。null のとき従来の 1 行 (tickerSentence) にフォールバック */
  tickerBody?: string | null;
  /** テロップ本文の重要語句 (数値+単位) の強調区間。正規化後 tickerBody への UTF-16 index span [start,end)。
   *  情報系 (low 優先) 電文のみ付与。フロントが該当区間を font-weight 増で描画する。
   *  null/欠落/空配列は「強調なし」。tickerBody が縮退等で null 化されるときは必ず一緒に落とす */
  tickerEmphasis?: Array<{ start: number; end: number }> | null;
  /** テロップ左端チップの件名 (台風名・火山名・対象地方等)。導出不能は null でチップは種別のみ */
  tickerSubject?: string | null;
  /** テロップ抑制フラグ (汎用機構、spec 2026-07-23 ticker-content-lifetime T5-2)。
   *  true のイベントはサーバが recentTicker に積まず、フロントも ticker 配列に積まない
   *  (event broadcast 自体は seq 整合のため通常どおり流れる)。
   *  現用途: 情報ゼロの非取消 VPWP50、および本文・headline とも空の気象解説。
   *  projectDisplayEvent が常に明示値をセットする。欠落 (旧 snapshot) は false 扱い
   *  (optional は protocol 移行の安全化——本ファイルの他 ticker フィールドと同じ規約) */
  tickerSuppressed?: boolean;
  /** テロップ面の engine 権威値。欠落・未知値は frontend で none に縮退する。 */
  tickerSurface?: DisplayTickerSurface;
}

export interface DisplayConnectionStateV1 {
  dmdata: "connecting" | "connected" | "disconnected";
  lastReceivedAt: string | null;
  disconnectedSince: string | null;
  reason: string | null;
}

/** 気象警報カードの 1 種別行。displaySeverity と rank を二重保持する */
export type DisplayWeatherRank = "emergency" | "warning" | "advisory";

export interface DisplayWeatherAlertItemV1 {
  kind: string;             // formatLevelLabel 形式のカード表記 (例 "L3 大雨警報" / "暴風警報")
  /** 表示ラベルや警戒レベルが変わっても同じ現象を指す安定キー。欠落は旧サーバ互換 */
  phenomenonKey?: string;
  displaySeverity: string;  // DisplaySeverity 値 (import-free のため string)
  rank: DisplayWeatherRank;
  shownAreas: string[];     // 縮退で切り詰められる。ほか N 地域は omittedAreaCount で表現
  /** shownAreas と同じ添字の XML Area.Code。旧 snapshot / 旧 server は欠落するため optional。 */
  shownAreaCodes?: string[];
  omittedAreaCount: number;
}

export interface DisplayWeatherAlertV1 {
  source: "vpws50" | "vpww56";
  label: string;
  role: "weatherEmergency" | "weatherWarning" | "weatherAdvisory";
  totalAreas: number;
  items: DisplayWeatherAlertItemV1[];
  updatedAt: string;
}

export interface DisplayWeatherExpandedKindV1 {
  kindKey: string;
  areas: string[];
  /** areas と同じ添字の XML Area.Code。旧 snapshot は欠落するため optional。 */
  areaCodes?: string[];
  totalAreaCount: number;
  candidateTruncated: boolean;
}

/** 気象警報の source。時計・世代・昇格判定はこの単位で完全に独立する */
export type DisplayWeatherSourceV1 = DisplayWeatherAlertV1["source"];

/** 昇格判定に使う displaySeverity の閉じた語彙 (src/types.ts の DisplaySeverity と同値)。
 *  DisplayWeatherAlertItemV1.displaySeverity は前方互換のため wire 上 string のまま持ち、
 *  昇格判定に使う直前だけこの union へ絞り込む (未知値は昇格に使わない)。 */
export type DisplayWeatherSeverityV1 =
  | "officialL5"
  | "officialL4"
  | "officialL3"
  | "officialL2"
  | "officialL1"
  | "nonLevelSpecial"
  | "nonLevelWarning"
  | "nonLevelAdvisory"
  | "unknown"
  | "release";

/** 主役パネルへ昇格する警戒レベル相当。L5 相当 = officialL5 ∪ nonLevelSpecial、L4 相当 = officialL4 */
export type DisplayWeatherPromotionLevelV1 = 4 | 5;

/** 網羅 Record にすることで DisplayWeatherSeverityV1 の追加が compile error になる */
const WEATHER_PROMOTION_LEVEL: Record<DisplayWeatherSeverityV1, DisplayWeatherPromotionLevelV1 | null> = {
  officialL5: 5,
  nonLevelSpecial: 5,
  officialL4: 4,
  officialL3: null,
  nonLevelWarning: null,
  officialL2: null,
  nonLevelAdvisory: null,
  officialL1: null,
  unknown: null,
  release: null,
};

export function isDisplayWeatherSeverity(value: string): value is DisplayWeatherSeverityV1 {
  return Object.prototype.hasOwnProperty.call(WEATHER_PROMOTION_LEVEL, value);
}

/** null = 昇格対象外。engine / frontend で同一の判定を使う */
export function displayWeatherPromotionLevel(
  severity: DisplayWeatherSeverityV1,
): DisplayWeatherPromotionLevelV1 | null {
  return WEATHER_PROMOTION_LEVEL[severity];
}

export interface DisplayWeatherPromotionEntryV1 {
  level: DisplayWeatherPromotionLevelV1;
  promotedAt: string;
  generation: number;
  /**
   * 昇格の根拠になった item の控え。**live な weatherAlerts に当該 source が無いときだけ載る**
   * (再起動直後・`display on` 直後の、まだ電文を受けていない窓)。
   * 気象カードの view は起動時に復元されないため、この控えが無いと「昇格しているのに
   * 主役パネルに出す中身が無い」状態になる。現況そのものではなく空表示を防ぐための控えで、
   * 当該 source の電文を 1 通でも受理すれば weatherAlerts が権威になり、この欄は消える。
   */
  restoredItems?: DisplayWeatherAlertItemV1[];
  /**
   * この点灯が新規発表 (`new`) か更新発表 (`update`) か。フロントはバッジに使う。
   * 欠落 (旧サーバ・装飾を失った復元) はバッジを出さない — 判定材料が無いときに
   * 嘘の「新規」を出すより無表示を採る (spec 追補 C5)。
   */
  trigger?: DisplayWeatherPromotionTriggerV1;
  /**
   * この点灯で**追加された**地域 (種別ごと)。フロントは「どこ」の該当地域を下線で強調する。
   * 新規発表では載らない (全部が新規なので全面ハイライトは意味を失う)。
   * 判定は engine 側の安定キー (現象コード × 地域コード) で行い、ここへは表示名と対応コードを載せる —
   * 表示ラベルで判定すると L4→L5 の悪化で同じ地域が「追加」に化ける (spec 追補 C2)。
   */
  addedAreas?: DisplayWeatherAddedAreasV1[];
  /**
   * 点灯の同一性キー。**値が変わったらフロントは再点灯演出を発火する** (spec 追補 C1)。
   * パネルの key は `weather:current` 固定・wire も更新中ずっと非 null なので、これが無いと
   * 内容更新でパネルがマウントされたままになり「切り替えが視線を引く」効果が出ない。
   * 外側の key に generation を混ぜるとレイアウト補間と実測状態が壊れるため、内部演出用に分ける。
   */
  activationKey?: string;
}

/** 点灯の契機。新規発表と更新発表を区別してバッジに出す (spec 追補 3) */
export type DisplayWeatherPromotionTriggerV1 = "new" | "update";

/** 追加された地域 (種別単位)。`kind` は表示ラベル、`areas` は地域名。 */
export interface DisplayWeatherAddedAreasV1 {
  kind: string;
  areas: string[];
  /** areas と同じ添字の XML Area.Code。旧 wire は欠落しうる。 */
  areaCodes?: string[];
}

/** source 別の昇格状態。demoted (画面都合の降格) は null に投影されるため、
 *  フロントは期限計算を一切せず「null でなければ主役パネル」とだけ解釈する */
export interface DisplayWeatherPromotionV1 {
  vpws50: DisplayWeatherPromotionEntryV1 | null;
  vpww56: DisplayWeatherPromotionEntryV1 | null;
  /**
   * **パネル全体の点灯キー**。new / update のときだけ変わり、source の降格・解除では動かない。
   * フロントはこれだけを再点灯演出の契機にする — source 別キーの最大値を採ると、
   * 最後に点いた source が降格しただけで値が巻き戻り、再点灯してしまう
   * (Codex レビュー 2026-07-27)。欠落 (旧サーバ) は演出なし
   */
  activationKey?: string;
}

export type DisplayWeatherChangeKindV1 =
  | "added"
  | "released"
  | "upgraded"
  | "downgraded"
  | "kindChanged";

export interface DisplayWeatherChangeValueV1 {
  kindShortName: string;
  kindCode: string;
  displaySeverity: string;
  officialAlertLevel: number | null;
}

export interface DisplayWeatherChangeItemV1 {
  areaCode: string;
  areaName: string;
  phenomenonKey: string;
  kind: DisplayWeatherChangeKindV1;
  before: DisplayWeatherChangeValueV1 | null;
  after: DisplayWeatherChangeValueV1 | null;
}

export interface DisplayWeatherChangeOmittedV1 {
  added?: number;
  released?: number;
  upgraded?: number;
  downgraded?: number;
  kindChanged?: number;
}

export interface DisplayWeatherChangeV1 {
  source: "vpws50";
  changeKey: string;
  reportDateTime: string;
  issuedAt: string;
  expiresAt: string;
  changes: DisplayWeatherChangeItemV1[];
  omitted: DisplayWeatherChangeOmittedV1;
}

export interface DisplayActiveEewV1 extends DisplayEewInputV1 {
  updatedAtMs: number;
}

export interface DisplayTsunamiStateV1 extends DisplayTsunamiInputV1 {
  updatedAtMs: number;
}

export interface DisplayLargeQuakeStateV1 extends DisplayLargeQuakeInputV1 {
  updatedAtMs: number;
}

// ---- standby cards (spec: 2026-07-21-standby-cards-expansion-design.md) ----

export type StandbySeverity = "info" | "normal" | "warning" | "critical";

export interface ActiveStandbyBaseV1 {
  /** 種別内で安定な識別キー */
  key: string;
  sourceEventIds: string[];
  /** 電文の発表時刻ベース (ISO) */
  updatedAt: string;
  /** 絶対時刻 (ISO)。null = 電文解除のみで消灯 */
  expiresAt: string | null;
  /** 永続化からの復元状態 (live 更新前)。フロントは「前回状態/同期中」を表示する */
  restored: boolean;
  /** tier/減光連動用 (spec §6) */
  severity: StandbySeverity;
}

export type DisplayBriefingSourceV1 = "vpoa50" | "vpbs50";

export type DisplayBriefingFrameLevelV1 = Extract<
  DisplayFrameLevel,
  "critical" | "warning" | "info" | "cancel"
>;

export interface DisplayBriefingTargetAreaV1 {
  name: string;
  /** Headline.Information の Area.Code。名称から推定しない。 */
  code: string;
}

/**
 * VPBS50／VPOA50 の severity evidence を raw XML なしで監査可能にする wire model。
 * VPBS50 は tag/displaySeverity/source、VPOA50 は code/status evidence を使う。
 */
export interface DisplayBriefingSeverityEvidenceV1 {
  source: string;
  condition: string | null;
  tag: string | null;
  displaySeverity: string | null;
  soundLevel: string | null;
  severity: string | null;
  phenomenonCode: string | null;
  kindCode: string | null;
  levelCode: string | null;
  status: string | null;
}

/** 一 outer card に集約される VPBS50／VPOA50 の card entry。 */
export interface DisplayBriefingEntryV1 {
  /** card 専用 exact identity。ticker eventKey／groupKey ではない。 */
  key: string;
  source: DisplayBriefingSourceV1;
  /** raw EventID、または EventID 欠落時の raw messageId。 */
  sourceEventId: string;
  title: string;
  headline: string | null;
  /** Headline.Information の Condition 集合。 */
  conditions: string[];
  targetAreas: DisplayBriefingTargetAreaV1[];
  reportDateTime: string;
  publishingOffice: string;
  infoType: string;
  /** engine が解決した frame level。frontend で文字列再判定しない。 */
  frameLevel: DisplayBriefingFrameLevelV1;
  severityEvidence: DisplayBriefingSeverityEvidenceV1[];
  /** VPOA50 の fail-open qualifier 等。 */
  qualifier: string | null;
  updatedAt: string;
  expiresAt: string;
  /** card 専用 mutation generation。 */
  generation: number;
}

export interface DisplayBriefingCardDataV1 {
  /** card 専用 state の generation。 */
  generation: number;
  entries: DisplayBriefingEntryV1[];
}

export interface DisplayVolcanoEntryV1 {
  code: string;
  name: string;
  alertLevel: number | null;
  /** 噴火警報種別。旧永続化データとの互換のため省略可。 */
  warningKind?: string | null;
  /** 対象市町村に付随する警戒区分。電文順のユニーク列。旧永続化データとの互換のため省略可。 */
  targetKinds?: string[];
  /** 数値レベル運用外の警報区分。旧 snapshot との互換のため省略可。 */
  alertClass?: DisplayVolcanoAlertClassV1 | null;
  /** 直近の噴火観測。旧 protocol snapshot との互換のため省略可。 */
  latestEvent?: DisplayVolcanoEventV1 | null;
}

export interface DisplayVolcanoAlertClassV1 {
  code: string;
  name: string;
  severity: "warning" | "info";
  isActive: boolean;
}

export interface DisplayVolcanoEventV1 {
  /** 表示名 ("噴火速報"、"噴火" 等) */
  label: string;
  craterName: string | null;
  eventDateTime: string | null;
  /** 火口上の噴煙高度。単位 m */
  plumeHeightM: number | null;
  /** 高度不明が明示された場合 true。単なる欠損と区別する */
  plumeHeightUnknown: boolean;
  /** 火口上 m の additive canonical。旧 protocol snapshot では欠落する。 */
  plumeHeightAboveCraterSemantic?: DisplayPlumeHeightSemanticV1;
  /** 海抜 FT の additive canonical。旧 protocol snapshot では欠落する。 */
  plumeHeightAboveSeaLevelSemantic?: DisplayPlumeHeightSemanticV1;
  plumeDirection: string | null;
}

export interface DisplayTyphoonV1 {
  /** TC 番号 (VPTW/VPTA 共通キー、spec §5.2) */
  typhoonKey: string;
  name: string | null;
  nameKana: string | null;
  /** 未命名時の補足 (例: 台風発生予想) */
  remark: string | null;
  typhoonNumber: string | null;
  category: string | null;
  /** 強さ階級。旧い保存状態との互換のため省略可。 */
  intensityClass?: string | null;
  /** 大きさ階級。旧い保存状態との互換のため省略可。 */
  sizeClass?: string | null;
  location: string | null;
  pressureHpa: number | null;
  /** 中心気圧 canonical の additive wire semantic。 */
  pressureHpaSemantic?: DisplayTyphoonNumericSemanticV1;
  /** 直前の同一台風との差。負数は気圧低下。旧永続化データでは省略される。 */
  pressureDeltaHpa?: number | null;
  maxWindMs: number | null;
  /** 最大風速 canonical の additive wire semantic。 */
  maxWindMsSemantic?: DisplayTyphoonNumericSemanticV1;
  /** 最大瞬間風速。旧永続化データとの互換のため省略可。 */
  maxGustMs?: number | null;
  /** 最大瞬間風速 canonical の additive wire semantic。 */
  maxGustMsSemantic?: DisplayTyphoonNumericSemanticV1;
  /** 直前の同一台風との差。正数は風速増加。旧永続化データでは省略される。 */
  maxWindDeltaMs?: number | null;
  /** 気圧・最大風速の両差分が算出できる場合だけ設定する。 */
  intensityTrend?: "developing" | "weakening" | "steady" | null;
  moveDirection: string | null;
  moveSpeedKmh: number | null;
  /** 移動速度 canonical の additive wire semantic。 */
  moveSpeedKmhSemantic?: DisplayTyphoonNumericSemanticV1;
  reportDateTime: string;
}

export interface DisplayHeatAreaV1 {
  areaName: string;
  /** true = 特別警戒 */
  isSpecial: boolean;
}

/** 水位ハイドログラフの 1 点。i===0 が現況 (observed)、以降が予測 (forecast)。
 *  valueM が null は欠測点 (座標は保持され、前後を結ぶ線は切れる)。 */
export interface DisplayFloodHydrographPointV1 {
  dateTime: string;
  valueM: number | null;
  phase: "observed" | "forecast";
}

/** 代表観測所の水位時系列 (現況＋予測)。単位が m でない/空系列/有効値ゼロは hydrograph 自体を持たない。 */
export interface DisplayFloodHydrographV1 {
  points: DisplayFloodHydrographPointV1[];
  /** criteria.L4 (氾濫危険水位)。m で得られない場合は null。thresholdLabel の基準値とは独立に持つ */
  dangerLevelM: number | null;
}

export interface DisplayFloodStationV1 {
  /** 代表観測所名 (河川内で最高レベルの観測所) */
  name: string;
  /** 現在水位 (m)。欠測は null */
  levelM: number | null;
  /** 直近時系列からの傾向。判定不能は null */
  trend: "rising" | "falling" | "steady" | null;
  /** 超過中の基準水位の説明 (例: "氾濫危険水位 3.20m 超過")。基準不明は null */
  thresholdLabel: string | null;
  /** 水位ミニグラフ用の時系列。描画不能 (単位不一致・空系列・有効値なし) は null/欠落 */
  hydrograph?: DisplayFloodHydrographV1 | null;
}

export interface DisplayFloodRiverV1 {
  riverKey: string;
  riverName: string;
  /** "L3" | "L4" | "L5" (active は L3 以上のみ) */
  level: string;
  levelRank: number;
  kindName: string;
  reportDateTime: string;
  /** 代表観測所の水位情報。観測情報を持たない電文 (headline のみ等) は null */
  station?: DisplayFloodStationV1 | null;
}

export type ActiveStandbyCardV1 =
  | (ActiveStandbyBaseV1 & {
      kind: "volcano";
      surface: "corner-right";
      data: { volcanoes: DisplayVolcanoEntryV1[] };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "typhoon";
      surface: "corner-right";
      data: { typhoons: DisplayTyphoonV1[] };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "heat";
      surface: "corner-right";
      data: { targetDate: string; areas: DisplayHeatAreaV1[] };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "flood";
      surface: "corner-right" | "clock-top-wide";
      data: { rivers: DisplayFloodRiverV1[] };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "tornado";
      surface: "weather-rider";
      data: { areas: string[]; isSighted: boolean };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "longPeriod";
      surface: "quake-rider";
      data: { eventId: string; maxLgInt: string };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "nankaiTrough";
      surface: "clock-below";
      data: { statusCode: string; label: string };
    })
  | (ActiveStandbyBaseV1 & {
      kind: "briefing";
      surface: "corner-right";
      data: DisplayBriefingCardDataV1;
    });

export type StandbyKind = ActiveStandbyCardV1["kind"];

export interface DisplayStateSnapshotV1 {
  version: typeof DISPLAY_PROTOCOL_VERSION;
  generatedAt: string;
  seq: number;
  activeEews: DisplayActiveEewV1[];
  tsunami: DisplayTsunamiStateV1 | null;
  largeQuakes: DisplayLargeQuakeStateV1[];
  weatherAlerts: DisplayWeatherAlertV1[];
  /** VPWS50 の短命な続報差分。欠落は旧 server、null は新 server の空状態。 */
  weatherChange?: DisplayWeatherChangeV1 | null;
  /** 主役パネルへの昇格状態 (権威は engine)。欠落 (旧サーバ) は両 source null 扱い。
   *  各 alert 内ではなくトップレベルに置く — VPWS50 は rank 別に同 source の alert が複数あるため */
  weatherPromotion?: DisplayWeatherPromotionV1;
  /** L5 相当 (officialL5 ∪ nonLevelSpecial) の気象警報が発表中か (night-dim 用)。
   *  パネル降格 (demoted) 後も警報解除まで true。欠落は false 扱い */
  weatherL5Active?: boolean;
  /** 気象警報の表示単位別展開候補。欠落は旧 snapshot 互換=展開しない。 */
  weatherExpandedKinds?: DisplayWeatherExpandedKindV1[];
  recentQuakes: DisplayRecentQuakeV1[];
  latestQuake: DisplayLatestQuakeStateV1 | null;   // 追加
  stats: DisplayStatsV1 | null;                    // 追加
  severityTier: DisplaySeverityTier;               // 追加
  /** 背景トーンの engine 権威値。旧 server の欠落は frontend で calm に縮退する。 */
  backgroundTone?: DisplayBackgroundTone;
  connection: DisplayConnectionStateV1;
  recentTicker: DisplayEventDtoV1[];
  /** 待機画面の発生中カード一覧 (priority 降順)。旧 snapshot には無い — 欠落は空配列扱い (前方互換) */
  standbyItems?: ActiveStandbyCardV1[];
  /** runtime 限定の地図状態。旧 server の欠落は空レイヤーとして扱う。 */
  mapLayers?: DisplayMapLayersV1;
  /** true のときだけ recentTicker がこの state 配信の権威値 (composition 変化の一発同期、spec §3-2)。
   *  省略/false は「recentTicker は空だが変化なし、フロントは既存 ticker を据え置く」の意味 (定期 state の従来動作) */
  tickerSynced?: boolean;
  /** フロント資産のビルド識別子 (display/dist/index.html の内容ハッシュ)。クライアントはロード時に
   *  最初に観測した値を基準に保持し、以後この値が変化した snapshot/state を受信したら location.reload()
   *  してフロントを新版に載せ替える (プロセス再起動でも display:build 単体でも反映)。null/欠落は
   *  旧サーバ・dist 未解決を意味し、クライアントは何もしない。ping には載せない (捨て値契約を維持) */
  frontendBuildId?: string | null;
}

export type DisplayServerMessage =
  | { type: "snapshot"; snapshot: DisplayStateSnapshotV1 }
  | { type: "event"; event: DisplayEventDtoV1 }
  | { type: "state"; snapshot: DisplayStateSnapshotV1 };

// PROTOCOL-SYNC-END

/**
 * Server-only additive wire command for a targeted ticker reconcile.
 *
 * The common protocol region above remains byte-for-byte synchronized with the
 * frontend until the frontend targeted-reduce slice is implemented.  The
 * server can nevertheless emit this command now; its event DTO carries the
 * authoritative sequence used as the SSE id, while sourceEventKeys identifies
 * the exact ticker entries to purge in one frame.
 */
export interface DisplayReconcileMessageV1 {
  type: "reconcile";
  event: DisplayEventDtoV1;
  sourceEventKeys: readonly string[];
}

/** DisplayServerMessage plus the server-side reconcile command. */
export type DisplayServerMessageWithReconcile = DisplayServerMessage | DisplayReconcileMessageV1;

/**
 * Unit 2 の server-only additive payload。
 *
 * `DisplayReconcileMessageV1` の共通定義は frontend protocol と byte sync するため、
 * frontend slice が targeted reduce を実装するまで declaration merge で server wire
 * にだけ card payload を加える。SSE の実体型 (DisplayServerMessageWithReconcile) は
 * この追加 field を含む。
 */
export interface DisplayReconcileMessageV1 {
  /** card mutation 後の authoritative browser card。null は card の消滅を表す。 */
  card?: Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null;
}
