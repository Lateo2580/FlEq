/** フレームの優先度レベル */
export type FrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

/**
 * 通知音レベル。値集合は FrameLevel と同一だが意味は独立 (音 vs 枠色)。
 * 型定義はここ (import ゼロの leaf) に置き、engine/notification/sound-player.ts から
 * 再 export する (DISPLAY_SEVERITY_TO_SOUND_LEVEL を dmdata 層に置けるようにするため。
 * FrameLevel / DisplaySeverity と同じ Phase B の移設パターン)。
 * 実行時の有効値リストは sound-player.ts の SOUND_LEVELS (satisfies で本型と同期)。
 */
export type SoundLevel = "critical" | "warning" | "normal" | "info" | "cancel";

// ── 電文基盤共通型 ──

export type SpecialValuePresence =
  | "value"
  | "missing"
  | "empty"
  | "unknown"
  | "qualitative"
  | "range";

export type SpecialValueDiagnostic =
  | "unmappedSpecialValue"
  | "specialValueConflict"
  /** 旧 schema の null が missing/unknown のどちらか判別不能だったことを示す。 */
  | "legacyNullUnknown";

export interface SpecialValue<T> {
  raw: string | null;
  value: T | null;
  condition: string | null;
  description: string | null;
  presence: SpecialValuePresence;
  lowerBound?: T | null;
  upperBound?: T | null;
  /** From 要素の未加工本文。canonical 変換に失敗した qualifier も保持する。 */
  rawLowerBound?: string | null;
  /** To 要素の未加工本文。`over` 等の非 canonical qualifier も保持する。 */
  rawUpperBound?: string | null;
  /** 未知語・本文競合を後段の統計へ渡す診断。 */
  diagnostics?: SpecialValueDiagnostic[];
}

/** JMAXML が使用する震度階級の canonical value。 */
export type JmaIntensity = "0" | "1" | "2" | "3" | "4" | "5-" | "5+" | "6-" | "6+" | "7";

/** JMAXML が使用する長周期地震動階級の canonical value。 */
export type JmaLgIntensity = "0" | "1" | "2" | "3" | "4";

/**
 * 震度の安全側評価。unknown を数値 rank に混ぜない。
 * lower は確実に満たす rank、upper=null は上限を確定できないことを表す。
 */
export type IntensitySafetyRank =
  | {
      kind: "known";
      lower: number;
      upper: number | null;
    }
  | {
      kind: "unknown";
    };

/** 長周期地震動階級 0〜4 専用の安全側評価。 */
export type LgIntensityRank = 0 | 1 | 2 | 3 | 4;

export type LgIntensitySafetyRank =
  | {
      kind: "known";
      lower: LgIntensityRank;
      upper: LgIntensityRank | null;
    }
  | {
      kind: "unknown";
    };

export type SpecialValueBadge = null | "≥" | "↔" | "?" | "∅";

/** map／card が raw を再解析せず利用する特殊値の表示 semantic。 */
export type SpecialValueDisplaySemantic =
  | { kind: "exact"; color: "normalRank"; badge: null; render: true }
  | { kind: "lowerBound"; color: "safetyRank"; badge: "≥"; render: true }
  | { kind: "range"; color: "safetyUpperRank"; badge: "↔"; render: true }
  | { kind: "unknown"; color: "unknown"; badge: "?"; render: true }
  | { kind: "empty"; color: "neutral"; badge: "∅"; render: true }
  | { kind: "missing"; color: "notRendered"; badge: null; render: false };

export interface StrictTextMeta {
  raw: string | null;
  value: string | null;
  valid: boolean;
}

export interface StrictDateTimeMeta {
  raw: string | null;
  epochMs: number | null;
  valid: boolean;
}

export interface TelegramSerial {
  raw: string | null;
  numeric: number | null;
  valid: boolean;
}

export type TelegramInfoTypeValue =
  | "発表"
  | "訂正"
  | "取消";

export interface StrictInfoTypeMeta {
  raw: string | null;
  value: TelegramInfoTypeValue | null;
  valid: boolean;
}

export interface TelegramMeta {
  messageId: string;
  eventId: StrictTextMeta;
  type: StrictTextMeta;
  reportDateTime: StrictDateTimeMeta;
  serial: TelegramSerial;
  infoType: StrictInfoTypeMeta;
  receivedAtMs: number;
  status: string | null;
  isTest: boolean;
}

export interface TelegramRevision {
  eventId: StrictTextMeta;
  type: StrictTextMeta;
  reportDateTime: StrictDateTimeMeta;
  serial: TelegramSerial;
  infoType: StrictInfoTypeMeta;
}

export interface TelegramRevisionComparisonInput {
  revision: TelegramRevision;
  stateSubjectKey: string | null;
}

export type RevisionRelation =
  | "newer"
  | "equal"
  | "older"
  | "unordered";

// ── 気象警報・注意報の 2 系統表示重大度 (VPWW55-61 / VPWP50 共通) ──
// 型定義はここ (import ゼロの leaf) に置き、weather-warning-level.ts から再 export する。
// (DISPLAY_SEVERITY_TO_FRAME_LEVEL が FrameLevel と DisplaySeverity を同一モジュールで
//  扱えるよう、両者を types.ts に集約する。詳細は weather-warning-level.ts 冒頭コメント)

/** 公式警戒レベル相当 (対応災害のみ、1-5) */
export type OfficialAlertLevel = 1 | 2 | 3 | 4 | 5;

/** FlEq 内部の表示・通知強度 (全災害共通) */
export type DisplaySeverity =
  | "officialL5"
  | "officialL4"
  | "officialL3"
  | "officialL2"
  | "officialL1"
  | "nonLevelSpecial"
  | "nonLevelWarning"
  | "nonLevelAdvisory"
  | "release"
  | "unknown";

/** resolutionSource は fallback ヒットを test で検出可能にするための監査フィールド */
export type ResolutionSource = "map" | "nameFallback" | "unknown";

/** Kind/Significancy を 2 系統設計に解決した結果 */
export interface ResolvedKind {
  displaySeverity: DisplaySeverity;
  officialAlertLevel: OfficialAlertLevel | null;
  source: ResolutionSource;
}

/** 表示モード */
export type DisplayMode = "normal" | "compact";

/** プロンプト時計モード */
export type PromptClock = "elapsed" | "clock" | "uptime";

/** EEW ログ記録項目 */
export type EewLogField =
  | "hypocenter"
  | "originTime"
  | "coordinates"
  | "magnitude"
  | "forecastIntensity"
  | "maxLgInt"
  | "forecastAreas"
  | "lgIntensity"
  | "isPlum"
  | "hasArrived"
  | "diff"
  | "maxIntChangeReason";

/** 通知カテゴリ */
export type NotifyCategory =
  | "eew"
  | "earthquake"
  | "tsunami"
  | "seismicText"
  | "nankaiTrough"
  | "lgObservation"
  | "volcano"
  | "weather"
  | "tornado"
  | "briefing"
  | "earlyWeather"
  | "weatherWarningTimeseries"
  | "climateInfo"
  | "weatherExplanation"
  | "heatAlert"
  | "typhoonAnalysis"
  | "typhoonProbability"
  | "floodForecast";

/** 通知設定 (カテゴリごとの ON/OFF) */
export type NotifySettings = Record<NotifyCategory, boolean>;

/** 省略表示の上限設定 */
export interface TruncationLimits {
  // ── 本文行数 ──
  seismicTextLines: number;
  nankaiTroughLines: number;
  volcanoAlertLines: number;
  volcanoEruptionLines: number;
  volcanoTextLines: number;
  volcanoAshfallQuickLines: number;
  volcanoAshfallDetailLines: number;
  volcanoAshfallRegularLines: number;
  volcanoPreventionLines: number;
  // ── 件数 ──
  plumeWindSampleRows: number;
  floodAssumptionLines: number;
}

/** dmdata.jp API の分類区分 */
export type Classification =
  | "telegram.earthquake" // 地震・津波関連
  | "eew.forecast" // 緊急地震速報（予報）
  | "eew.warning" // 緊急地震速報（警報）
  | "telegram.volcano" // 火山関連
  | "telegram.weather"; // 気象警報・注意報関連

/** アプリケーション設定 */
export interface AppConfig {
  /** dmdata.jp APIキー */
  apiKey: string;
  /** 受信する分類区分 */
  classifications: Classification[];
  /** テスト電文の扱い: "no" | "including" | "only" */
  testMode: "no" | "including" | "only";
  /** アプリケーション名 (Socket Start時に送信) */
  appName: string;
  /** 再接続の最大待機秒数 */
  maxReconnectDelaySec: number;
  /** 同一APIキーの既存 open socket を維持するか */
  keepExistingConnections: boolean;
  /** テーブル表示幅 (null = ターミナル幅に自動追従) */
  tableWidth: number | null;
  /** お知らせ電文の全文表示 */
  infoFullText: boolean;
  /** 表示モード */
  displayMode: DisplayMode;
  /** プロンプト時計モード */
  promptClock: PromptClock;
  /** 待機中ヒント表示間隔 (分) */
  waitTipIntervalMin: number;
  /** 通知設定 */
  notify: NotifySettings;
  /** 通知音の有効/無効 */
  sound: boolean;
  /** EEW ログ記録の有効/無効 */
  eewLog: boolean;
  /** EEW ログ記録項目 */
  eewLogFields: Record<EewLogField, boolean>;
  /** 観測点の最大表示件数 (null = 全件表示) */
  maxObservations: number | null;
  /** EEW副回線の有効/無効 */
  backup: boolean;
  /** 省略表示の上限設定 */
  truncation: TruncationLimits;
  /** ナイトモード */
  nightMode: boolean;
  /** 情報ディスプレイ (ブラウザ表示サーバ) の有効/無効 */
  display: boolean;
  /** 情報ディスプレイのポート */
  displayPort: number;
  /** 情報ディスプレイのバインド先ホスト */
  displayHost: string;
  /** 情報ディスプレイの非 loopback 接続に要求するアクセストークン (非 loopback バインド時、未設定なら起動ごとに自動生成) */
  displayToken?: string;
  /** 定期要約の間隔(分)。null = 無効 */
  summaryInterval: number | null;
  /** VPWP50 表示の standard モード閾値 (この幅未満で ultra-narrow) */
  weatherWarningStandardThreshold: number;
  /** VPWP50 表示の wide モード閾値 (この幅以上で wide) */
  weatherWarningWideThreshold: number;
  /** VPWP50 [詳細] ブロックの entry あたり最大行数 */
  weatherWarningDetailMaxPerEntry: number;
  /** VPWP50 [詳細] ブロックの全体最大行数 */
  weatherWarningDetailMaxTotal: number;
}

/** Configファイルの設定 (全フィールド任意) */
export interface ConfigFile {
  apiKey?: string;
  classifications?: Classification[];
  testMode?: "no" | "including" | "only";
  appName?: string;
  maxReconnectDelaySec?: number;
  keepExistingConnections?: boolean;
  tableWidth?: number;
  infoFullText?: boolean;
  displayMode?: DisplayMode;
  promptClock?: PromptClock;
  waitTipIntervalMin?: number;
  notify?: Partial<NotifySettings>;
  sound?: boolean;
  eewLog?: boolean;
  eewLogFields?: Partial<Record<EewLogField, boolean>>;
  maxObservations?: number;
  backup?: boolean;
  truncation?: Partial<TruncationLimits>;
  nightMode?: boolean;
  display?: boolean;
  displayPort?: number;
  displayHost?: string;
  displayToken?: string;
  summaryInterval?: number;
  weatherWarningStandardThreshold?: number;
  weatherWarningWideThreshold?: number;
  weatherWarningDetailMaxPerEntry?: number;
  weatherWarningDetailMaxTotal?: number;
}

/** デフォルト設定 */
export const DEFAULT_CONFIG: Omit<AppConfig, "apiKey"> = {
  classifications: ["telegram.earthquake", "eew.forecast", "eew.warning", "telegram.volcano", "telegram.weather"],
  testMode: "no",
  appName: "fleq",
  maxReconnectDelaySec: 60,
  keepExistingConnections: true,
  tableWidth: null,
  infoFullText: false,
  displayMode: "normal",
  promptClock: "elapsed",
  waitTipIntervalMin: 30,
  notify: {
    eew: true,
    earthquake: true,
    tsunami: true,
    seismicText: true,
    nankaiTrough: true,
    lgObservation: true,
    volcano: true,
    weather: false,
    tornado: false,
    briefing: false,
    earlyWeather: false,
    weatherWarningTimeseries: false,
    climateInfo: false,
    weatherExplanation: false,
    heatAlert: false,
    typhoonAnalysis: false,
    typhoonProbability: false,
    floodForecast: false,
  },
  sound: true,
  eewLog: false,
  eewLogFields: {
    hypocenter: true,
    originTime: true,
    coordinates: true,
    magnitude: true,
    forecastIntensity: true,
    maxLgInt: true,
    forecastAreas: true,
    lgIntensity: true,
    isPlum: true,
    hasArrived: true,
    diff: true,
    maxIntChangeReason: true,
  },
  maxObservations: null,
  nightMode: false,
  display: false,
  displayPort: 7788,
  displayHost: "127.0.0.1",
  summaryInterval: null,
  backup: false,
  truncation: {
    seismicTextLines: 15,
    nankaiTroughLines: 20,
    volcanoAlertLines: 10,
    volcanoEruptionLines: 8,
    volcanoTextLines: 8,
    volcanoAshfallQuickLines: 8,
    volcanoAshfallDetailLines: 16,
    volcanoAshfallRegularLines: 10,
    volcanoPreventionLines: 8,
    plumeWindSampleRows: 5,
    floodAssumptionLines: 8,
  },
  weatherWarningStandardThreshold: 120,
  weatherWarningWideThreshold: 160,
  weatherWarningDetailMaxPerEntry: 8,
  weatherWarningDetailMaxTotal: 60,
};

// ── プロンプトステータス ──

/** PromptStatus が使用するテーマ role の専用 union */
export type PromptStatusRole =
  | "tsunamiMajor"
  | "tsunamiWarning"
  | "tsunamiAdvisory"
  | "frameCritical"
  | "frameWarning"
  | "frameNormal";

/** 火山警報 detail 表示に必要な射影 */
export interface VolcanoAlertEntrySnapshot {
  volcanoName: string;
  alertLevel: number | null;
  alertLevelCode: string | null;
  warningKind: string;
}

/** VPWP50 detail の 1 時系列窓 */
export interface Vpwp50DetailSeriesWindow {
  series: "3h" | "24h" | "day";
  timeRef: string;
  window?: TimeWindow;
  peak?: SignificancyPeakTime;
  criteriaPeriod?: SignificancyCriteriaPeriod;
}

/** VPWP50 detail の表示対象 1 エントリ */
export interface Vpwp50DetailEntrySnapshot {
  severity: "special" | "warning" | "advisory" | "unknown";
  kindLabel: string;
  areaName: string;
  windows: Vpwp50DetailSeriesWindow[];
}

/** VPWP50 detail 表示用スナップショット */
export interface Vpwp50DetailSnapshot {
  savedAt: string;
  targetArea: string | null;
  entries: Vpwp50DetailEntrySnapshot[];
  unknownCodes: ParsedWeatherWarningTimeseriesInfo["unknownCodes"];
  infoType: string;
  frameLevel: FrameLevel;
}

/** 詳細表示用スナップショット。ドメイン別 discriminated union */
export type DetailSnapshot =
  | { kind: "tsunami"; info: ParsedTsunamiInfo }
  | { kind: "volcano"; entries: VolcanoAlertEntrySnapshot[] }
  | { kind: "vpws50"; display: Vpws50CurrentAreasForDisplay }
  | { kind: "vpwp50"; detail: Vpwp50DetailSnapshot };

export type DetailKind = DetailSnapshot["kind"];
export type DetailSnapshotOf<K extends DetailKind> = Extract<
  DetailSnapshot,
  { kind: K }
>;

/** プロンプトに表示するステータスセグメント */
export interface PromptStatusSegment {
  text: string;       // 色付け前の表示テキスト
  role: PromptStatusRole;
  priority: number;   // 小さいほど左側に表示
}

/** プロンプトにステータスを提供する */
export interface PromptStatusProvider {
  getPromptStatus(): PromptStatusSegment | null;
}

/** detail コマンドへ表示用データを提供する */
export interface DetailProvider<K extends DetailKind = DetailKind> {
  readonly category: K;
  readonly emptyMessage: string;
  getDetail(): DetailSnapshotOf<K> | null;
}

// ── dmdata.jp API レスポンス型 ──

/** Contract List レスポンス */
export interface ContractListResponse {
  responseId: string;
  responseTime: string;
  status: "ok" | "error";
  items: ContractItem[];
  error?: {
    message: string;
    code: number;
  };
}

export interface ContractItem {
  id: number;
  planId: number;
  planName: string;
  classification: string;
  price: number;
  start: string;
  end: string | null;
  isValid: boolean;
}

/** Socket Start レスポンス */
export interface SocketStartResponse {
  responseId: string;
  responseTime: string;
  status: "ok" | "error";
  ticket?: string;
  websocket?: {
    id: number;
    url: string;
    protocol: string[];
    expiration: number;
  };
  classifications?: string[];
  test?: string;
  types?: string[];
  formats?: string[];
  appName?: string | null;
  error?: {
    message: string;
    code: number;
  };
}

/** Socket List レスポンス */
export interface SocketListResponse {
  responseId: string;
  responseTime: string;
  status: "ok" | "error";
  items: SocketListItem[];
  error?: {
    message: string;
    code: number;
  };
}

export interface SocketListItem {
  id: number;
  ticket: string | null;
  types: string[];
  test: string;
  classifications: string[];
  ipAddress: string;
  status: "open" | "closed" | "waiting";
  server: string;
  start: string;
  end: string | null;
  ping: string | null;
  appName: string | null;
}

// ── WebSocket メッセージ型 ──

export interface WsStartMessage {
  type: "start";
  socketId: number;
  classifications: string[];
  types: string[];
  test: string;
  formats: string[];
  appName: string | null;
  time: string;
}

export interface WsPingMessage {
  type: "ping";
  pingId: string;
}

export interface WsPongMessage {
  type: "pong";
  pingId?: string;
}

export interface WsDataMessage {
  type: "data";
  version: string;
  classification: string;
  id: string;
  passing: { name: string; time: string }[];
  head: {
    type: string;
    author: string;
    target?: string;
    time: string;
    designation?: string | null;
    test: boolean;
    xml?: boolean;
  };
  xmlReport?: {
    control: {
      title: string;
      dateTime: string;
      status: string;
      editorialOffice: string;
      publishingOffice: string;
    };
    head: {
      title: string;
      reportDateTime: string;
      targetDateTime: string;
      eventId: string | null;
      serial: string | null;
      infoType: string;
      infoKind: string;
      infoKindVersion: string;
      headline: string | null;
    };
  };
  format: "xml" | "a/n" | "binary" | "json" | null;
  compression: "gzip" | "zip" | null;
  encoding: "base64" | "utf-8" | null;
  body: string;
  /** ingress normalizer が生成する共通 metadata。transport raw では未生成。 */
  meta?: TelegramMeta;
}

export interface WsErrorMessage {
  type: "error";
  error: {
    message: string;
    code: number;
  };
  id?: string;
}

export type WsMessage =
  | WsStartMessage
  | WsPingMessage
  | WsPongMessage
  | WsDataMessage
  | WsErrorMessage;

// ── dmdata.jp 地震履歴 API レスポンス型 ──

/** 地震履歴の各アイテム */
export interface GdEarthquakeItem {
  id: number;
  type: string;
  eventId: string;
  originTime: string | null;
  arrivalTime: string;
  hypocenter: {
    code: string;
    name: string;
    coordinate: {
      latitude: { text: string; value: string } | null;
      longitude: { text: string; value: string } | null;
      height: { type: string; unit: string; value: string } | null;
      geodeticSystem: string | null;
    } | null;
    depth: { type: string; unit: string; value: string } | null;
    detailed: { code: string; name: string } | null;
  } | null;
  magnitude: {
    type: string;
    unit: string;
    value: string | null;
  } | null;
  maxInt: string | null;
}

/** 地震履歴 API レスポンス */
export interface GdEarthquakeListResponse {
  responseId: string;
  responseTime: string;
  status: "ok" | "error";
  items: GdEarthquakeItem[];
  error?: {
    message: string;
    code: number;
  };
}

// ── dmdata.jp 電文取得 API レスポンス型 ──

/** 電文リスト API の個別アイテム (GET /v2/telegram) */
export interface TelegramListItem {
  serial: number;
  id: string;
  classification: string;
  head: {
    type: string;
    author: string;
    target?: string;
    time: string;
    designation?: string | null;
    test: boolean;
    xml?: boolean;
  };
  xmlReport?: {
    control: {
      title: string;
      dateTime: string;
      status: string;
      editorialOffice: string;
      publishingOffice: string;
    };
    head: {
      title: string;
      reportDateTime: string;
      targetDateTime: string;
      eventId: string | null;
      serial: string | null;
      infoType: string;
      infoKind: string;
      infoKindVersion: string;
      headline: string | null;
    };
  };
  format: "xml" | "a/n" | "binary" | "json" | null;
  compression: "gzip" | "zip" | null;
  encoding: "base64" | "utf-8" | null;
  body?: string;
}

/** 電文リスト API レスポンス */
export interface TelegramListResponse {
  responseId: string;
  responseTime: string;
  status: "ok" | "error";
  items: TelegramListItem[];
  nextToken?: string;
  error?: {
    message: string;
    code: number;
  };
}

// ── パース済み地震情報型 ──

export interface ParsedEarthquakeIntensityArea {
  name: string;
  code: string | null;
  intensityValue?: SpecialValue<JmaIntensity>;
  intensity: string;
  lgIntensityValue?: SpecialValue<JmaLgIntensity>;
  lgIntensity?: string;
}

export interface ParsedEarthquakeIntensityMunicipality {
  name: string;
  code: string | null;
  intensityValue?: SpecialValue<JmaIntensity>;
  intensity: string;
  lgIntensityValue?: SpecialValue<JmaLgIntensity>;
  lgIntensity?: string;
}

export interface ParsedEarthquakeIntensityStation {
  name: string;
  code: string | null;
  intensityValue?: SpecialValue<JmaIntensity>;
  /** 既存表示向け scalar adapter。特殊状態では空文字を維持する */
  intensity: string;
}

export interface ParsedEarthquakeIntensityPref {
  name: string;
  code: string | null;
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt?: string;
}

export interface ParsedEarthquakeIntensity {
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt?: string;
  /** Pref 階層の最大震度・最大長周期地震動階級。 */
  prefs?: ParsedEarthquakeIntensityPref[];
  /** 一次細分区域。文字表示用に code 欠落 item も保持する */
  areas: ParsedEarthquakeIntensityArea[];
  /** Area 直下の City。IntensityStation は含めない */
  municipalities: ParsedEarthquakeIntensityMunicipality[];
  /** City 直下の IntensityStation。地域・市町村とは別 provenance で保持する */
  stations?: ParsedEarthquakeIntensityStation[];
}

export interface ParsedMagnitudeInfo {
  value: string;
  condition: string | null;
  description: string | null;
}

export interface ParsedEarthquakeHypocenter {
  /** 発生日時 */
  originTime: string;
  /** 震源地名称 */
  hypocenterName: string;
  /** 緯度 */
  latitude: string;
  /** 経度 */
  longitude: string;
  /** 深さ */
  depth: string;
  /** 深さの canonical 値。旧 depth はこの値から作る互換 scalar。 */
  depthValue?: SpecialValue<number>;
  /** 数値マグニチュード。数値でない場合は空文字 */
  magnitude: string;
  /** マグニチュードの canonical 値。旧 magnitude はこの値から作る互換 scalar。 */
  magnitudeValue?: SpecialValue<number>;
  /** Magnitude 要素の値・condition・description */
  magnitudeInfo?: ParsedMagnitudeInfo;
}

export interface ParsedEarthquakeInfo {
  /** 電文タイプ */
  type: string;
  /** 情報の種類 */
  infoType: string;
  /** タイトル */
  title: string;
  /** 発表日時 */
  reportDateTime: string;
  /** ヘッドライン */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** イベントID (同一地震の電文を紐付ける識別子) */
  eventId: string | null;
  /** 震源情報 */
  earthquake?: ParsedEarthquakeHypocenter;
  /** 震度情報 */
  intensity?: ParsedEarthquakeIntensity;
  /** 津波情報 */
  tsunami?: {
    /** 津波予報コメント */
    text: string;
  };
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

/** EEW 震源精度 (Earthquake/Hypocenter/Accuracy)。rank 属性の欠落・非数値は null。0 は有効値 */
export interface EewAccuracy {
  /** 震央精度 (Accuracy/Epicenter@rank) */
  epicenterRank: number | null;
  /** 震央精度その2 (Accuracy/Epicenter@rank2) */
  epicenterRank2: number | null;
  /** 深さ精度 (Accuracy/Depth@rank) */
  depthRank: number | null;
  /** M 精度 (Accuracy/MagnitudeCalculation@rank) */
  magnitudeRank: number | null;
  /** M 計算使用観測点数 (Accuracy/NumberOfMagnitudeCalculation。0 は有効値) */
  magnitudeCalcCount: number | null;
}

/** 緊急地震速報パース済み */
export interface ParsedEewInfo {
  type: string;
  infoType: string;
  title: string;
  reportDateTime: string;
  headline: string | null;
  publishingOffice: string;
  /** EEW 報数 */
  serial: string | null;
  eventId: string | null;
  earthquake?: ParsedEarthquakeHypocenter;
  /** 仮定震源要素かどうか (PLUM法のみで通常震源推定不可) */
  isAssumedHypocenter: boolean;
  /** Appendix: 最大予測震度変化理由コード */
  maxIntChangeReason?: number;
  /** 検知時刻 (Earthquake/ArrivalTime。要素欠落時は undefined) */
  arrivalTime?: string;
  /** 内陸/海域 (Earthquake/Hypocenter/Area/LandOrSea。文字列そのまま) */
  landOrSea?: string;
  /** 震源精度 (Accuracy 要素自体が無い電文では undefined) */
  accuracy?: EewAccuracy;
  /** 取消報本文 (取消報の Body/Text。無ければ undefined → 表示側で固定文 fallback) */
  cancelText?: string;
  /** 予測震度 */
  forecastIntensity?: {
    /** 最大予測震度 */
    maxInt?: string;
    maxIntValue?: SpecialValue<JmaIntensity>;
    /** 最大予測長周期地震動階級 */
    maxLgInt?: string;
    maxLgIntValue?: SpecialValue<JmaLgIntensity>;
    areas: {
      name: string;
      /** ForecastInt の正規 SpecialValue。親 Area/Condition は混ぜない */
      intensityValue?: SpecialValue<JmaIntensity>;
      intensity: string;
      lgIntensityValue?: SpecialValue<JmaLgIntensity>;
      lgIntensity?: string;
      /** 親 Area/Condition。ForecastInt.condition とは独立に保持する */
      condition?: string;
      /** PLUM法による予測か */
      isPlum?: boolean;
      /** 既に主要動到達と推測 */
      hasArrived?: boolean;
      /** 予測震度上限 (ForecastInt/To)。From≠To の範囲予測時のみ格納 ("over" 等の特殊値もそのまま) */
      intensityTo?: string;
      /** 地域別主要動到達予測時刻 (Pref/Area/ArrivalTime) */
      arrivalTime?: string;
    }[];
  };
  meta: TelegramMeta;
  isTest: boolean;
  /** 警報かどうか */
  isWarning: boolean;
  /** 次回情報予告 (最終報の場合にテキストが入る) */
  nextAdvisory?: string;
}

/** 津波予報区の潮位観測点 (満潮時刻・津波到達予想時刻) */
export interface TsunamiStationItem {
  name: string;
  highTideDateTime: string;
  arrivalTime: string;
}

/** 津波 parser が構造上の不確実性を検出したときの診断種別 */
export type TsunamiParserDiagnostic =
  | "unknownTsunamiAreaCode"
  | "unknownTsunamiKindCode";

/** 津波予報区域ごとの警報情報 */
export interface TsunamiForecastItem {
  /** Area/Code。欠落時は null とし、名称から推定しない。 */
  areaCode: string | null;
  areaName: string;
  /** Category/Kind/Code。欠落時は null とし、名称から推定しない。 */
  kindCode: string | null;
  /** §10.1 の canonical 表示名。 */
  kindName: string;
  /** MaxHeight/TsunamiHeight の semantic source。 */
  maxHeight: SpecialValue<number>;
  /** kindName から投影する既存 scalar 互換 field。 */
  kind: string;
  /** maxHeight.description から投影する既存 scalar 互換 field。 */
  maxHeightDescription: string;
  firstHeight: string;
  /** parser が検出した code 診断。raw code は areaCode/kindCode に保持する。 */
  diagnostics?: TsunamiParserDiagnostic[];
  /** 潮位観測点 (VTSE51 の Item/Station。持たない Item では undefined) */
  stations?: TsunamiStationItem[];
}

/** 沖合津波観測局情報 */
export interface TsunamiObservationStation {
  /** 属する津波予報区名 (Observation/Item/Area/Name。取れない・空要素の場合 null) */
  areaName: string | null;
  /** 属する津波予報区コード (Observation/Item/Area/Code。旧経路・欠落電文では省略または null) */
  areaCode?: string | null;
  /** 観測点コード。旧経路・欠落電文では null/undefined */
  stationCode?: string | null;
  name: string;
  sensor: string;
  arrivalTime: string;
  initial: string;
  maxHeightCondition: string;
  /** 最大波の高さ記述 (MaxHeight/jmx_eb:TsunamiHeight@_description。無ければ null) */
  maxHeightValue: string | null;
  /** MaxHeight/TsunamiHeight の semantic source。 */
  maxHeight: SpecialValue<number>;
  /** TsunamiHeight@condition (例: 上昇中)。要素/属性が無ければ空文字列 */
  maxHeightValueCondition?: string;
}

/** 沖合津波推定情報 */
export interface TsunamiEstimationItem {
  areaName: string;
  maxHeightDescription: string;
  firstHeight: string;
}

/** パース済み津波情報 (VTSE41/51/52) */
export interface ParsedTsunamiInfo {
  type: string;
  infoType: string;
  title: string;
  reportDateTime: string;
  headline: string | null;
  publishingOffice: string;
  forecast?: TsunamiForecastItem[];
  observations?: TsunamiObservationStation[];
  estimations?: TsunamiEstimationItem[];
  earthquake?: ParsedEarthquakeHypocenter;
  warningComment: string;
  /** code 欠落・未知 code の parser 診断。 */
  diagnostics?: TsunamiParserDiagnostic[];
  meta: TelegramMeta;
  isTest: boolean;
}

/** パース済み地震活動テキスト情報 (VXSE56, VXSE60, VZSE40) */
export interface ParsedSeismicTextInfo {
  type: string;
  infoType: string;
  title: string;
  reportDateTime: string;
  headline: string | null;
  publishingOffice: string;
  bodyText: string;
  meta: TelegramMeta;
  isTest: boolean;
}

/** パース済み南海トラフ関連情報 (VYSE50/51/52, VYSE60) */
export interface ParsedNankaiTroughInfo {
  type: string;
  infoType: string;
  title: string;
  reportDateTime: string;
  headline: string | null;
  publishingOffice: string;
  /** InfoSerial (VYSE60 にはない) */
  infoSerial?: {
    name: string;
    code: string;
  };
  /** 本文テキスト */
  bodyText: string;
  /** 次回情報予告 */
  nextAdvisory?: string;
  meta: TelegramMeta;
  isTest: boolean;
}

/** 長周期地震動観測地域 */
export interface LgObservationArea {
  name: string;
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt: string;
}

/** 長周期地震動観測情報の Pref 階層 */
export interface LgObservationPref {
  name: string;
  code: string | null;
  maxIntValue?: SpecialValue<JmaIntensity>;
  maxInt: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  maxLgInt: string;
}

/** パース済み長周期地震動観測情報 (VXSE62) */
export interface ParsedLgObservationInfo {
  type: string;
  infoType: string;
  title: string;
  reportDateTime: string;
  headline: string | null;
  publishingOffice: string;
  earthquake?: ParsedEarthquakeHypocenter;
  /** 最大震度 */
  maxInt?: string;
  maxIntValue?: SpecialValue<JmaIntensity>;
  /** 最大長周期地震動階級 */
  maxLgInt?: string;
  maxLgIntValue?: SpecialValue<JmaLgIntensity>;
  /** 長周期地震動カテゴリ */
  lgCategory?: string;
  /** Pref 階層の観測値 */
  prefs?: LgObservationPref[];
  /** 地域別観測データ */
  areas: LgObservationArea[];
  /** コメント */
  comment?: string;
  /** 詳細情報URI */
  detailUri?: string;
  meta: TelegramMeta;
  isTest: boolean;
}

// ── パース済み気象警報・注意報型 (VPWW55-61, VPWS50) ──

/** 警報・注意報の重大度 (Code から導出) */
export type WeatherSeverity =
  | "specialWarning" // 特別警報 (Code 30-39)
  | "warning"        // 警報・危険警報 (Code 01-09 / 40-49)
  | "advisory"       // 注意報 (Code 10-29)
  | "release"        // 解除 (Code 00)
  | "unknown";

/** 警報・注意報の Kind (種別) */
export interface WeatherKind {
  /** 種別名 (例: "大雨警報", "暴風警報", "レベル４土砂災害危険警報") */
  name: string;
  /** 種別コード (00-99) */
  code: string;
  /** 重大度 (Code から導出) */
  severity: WeatherSeverity;
}

/** 警報・注意報の Item (1 つの Area に対する複数 Kind) */
export interface WeatherItem {
  /** 地域名 */
  areaName: string;
  /** 地域コード */
  areaCode: string;
  /** 種別 (複数) */
  kinds: WeatherKind[];
  /** 各 Kind の状態 (Body.Warning の Status: 発表/継続/解除/取消) */
  statuses: { kindCode: string; status: string; lastKindName?: string; lastKindCode?: string }[];
  /** 変化ステータス (例: "警報・注意報種別に変化有"/"変化無") */
  changeStatus?: string;
  /** 全域/一部の別 */
  fullStatus?: string;
}

/** 階層別の警報・注意報情報 */
export interface WeatherAreaLayer {
  /** Information の type 属性 (例: "気象警報・注意報（市町村等）") */
  type: string;
  /** Item のリスト */
  items: WeatherItem[];
}

/** パース済み気象警報・注意報情報 (VPWW55-61, VPWS50) */
export interface ParsedWeatherWarning {
  /** 電文タイプ (例: "VPWW55") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "島根県大雨警報・注意報") */
  title: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** ヘッドラインテキスト (空文字の場合は null) */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 (Control.EditorialOffice) */
  editorialOffice: string;
  /** Control.Title (例: "気象警報・注意報（Ｒ０６）（大雨）") */
  controlTitle: string;
  /** Headline.Information の階層 (府県予報区/一次細分/市町村まとめ/市町村等) */
  layers: WeatherAreaLayer[];
  /** 補足コメント */
  comments: { type: string; text: string }[];
  /** 最大重大度 (FrameLevel 判定用) */
  maxSeverity: WeatherSeverity;
  /** Phase C: DISPLAY_SEVERITY_RANK 基準の最大表示重大度 (release 以外の Kind が無ければ null) */
  maxDisplaySeverity: DisplaySeverity | null;
  /** 通知音の集合ベース最大 (release 除外、対象 Kind が無ければ null)。
   *  maxDisplaySeverity (RANK 1 点代表) と独立 — L4 と特別警報級の共存で
   *  特別警報の critical 音が潰れない (2026-06-12 共存エッジ解消) */
  maxSoundLevel: SoundLevel | null;
  /** 警報以上を持つ地域数 (集計用) */
  warningAreaCount: number;
  /** 注意報を持つ地域数 (集計用) */
  advisoryAreaCount: number;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ── VPWS50 差分表示型 ──

/** Kind code を phenomenon family にまとめた canonical key (例: "大雨", "土砂災害", "unknown_99") */
export type PhenomenonKey = string;

/** State holder の集合キー (areaCode + phenomenonKey + severity)。R3 で AreaKindKey から改名 */
export type AreaPhenomenonSeverityKey = `${string}_${PhenomenonKey}_${WeatherSeverity}`;

/** 1 Kind の遷移 (新規/解除/昇降格)。Phase C: 2 系統 (旧 WeatherSeverity は集計互換用に併存) */
export interface Vpws50KindTransition {
  phenomenonKey: PhenomenonKey;
  kindShortName: string;        // 表示用ラベル (例: "大雨")
  prevKindCode: string | null;  // null = 新規発令
  newKindCode: string | null;   // null = 解除
  prevSeverity: WeatherSeverity | null;
  newSeverity: WeatherSeverity | null;
  prevDisplaySeverity: DisplaySeverity | null;
  newDisplaySeverity: DisplaySeverity | null;
  prevOfficialAlertLevel: OfficialAlertLevel | null;
  newOfficialAlertLevel: OfficialAlertLevel | null;
}

/** 1 予報区の変化内容 */
export interface Vpws50AreaChange {
  areaName: string;
  areaCode: string;
  changes: Vpws50KindTransition[];
}

/** 現況表示用の 1 種別グループ (Phase C: displaySeverity ベース) */
export interface Vpws50DisplayKindGroup {
  kindCode: string;
  kindShortName: string;
  /** 電文由来の生 Kind.Name (レベル接頭辞込み)。display 射影が formatLevelLabel で
   *  「L3 大雨警報」形式のカード表記を組むのに使う (CLI formatter は kindShortName を使う) */
  kindName: string;
  displaySeverity: DisplaySeverity;
  officialAlertLevel: OfficialAlertLevel | null;
  areas: Array<{ areaName: string; areaCode: string }>;
}

/** 取消ロールバック等で formatter に「rollback 後 state の現況」を渡す描画用データ */
export interface Vpws50CurrentAreasForDisplay {
  totalAreas: number;
  specialAreas: number;   // 3 段階互換カウント (サマリ行用)
  warningAreas: number;
  advisoryAreas: number;
  /** displaySeverity rank 降順 → 電文出現順 (Phase C: 旧 bySeverity 3 バケツを置換) */
  kinds: Vpws50DisplayKindGroup[];
}

/** VPWS50 電文 1 通の差分結果 */
export interface Vpws50Diff {
  /** state が空だった (初回起動) */
  isFirstReport: boolean;
  /** 前回と完全一致 (キー集合) */
  isUnchanged: boolean;
  /** 取消ロールバック直後 */
  isCancelRollback: boolean;
  /** 定期再掲タイミング (60 分経過 + 警報以上現存) */
  shouldRecap: boolean;
  /** 信頼度。unsafe では state 更新せず、表示は §4.7 (Plan-R1 で二段) */
  confidence: "confirmed" | "unsafe";
  /** unsafe の理由 (表示用) */
  unsafeReason?: "layer_missing" | "abnormal_release_rate";
  added: Vpws50AreaChange[];
  upgraded: Vpws50AreaChange[];
  downgraded: Vpws50AreaChange[];
  released: Vpws50AreaChange[];
  /** 取消ロールバック時のみセット。formatter は info ではなくこれを使う */
  currentAreasForDisplay?: Vpws50CurrentAreasForDisplay;
}

// ── パース済み竜巻注意情報型 (VPHW50, VPHW51) ──

/** 竜巻注意情報の発表ステータス */
export type TornadoStatus = "active" | "none";

/** 竜巻注意情報の地域エントリ */
export interface TornadoArea {
  /** 地域名 (例: "東京地方", "千代田区") */
  name: string;
  /** 地域コード */
  code: string;
  /** ステータス (発表 / なし) */
  status: TornadoStatus;
}

/** 竜巻注意情報の階層別データ */
export interface TornadoAreaLayer {
  /** Information の type 属性 (例: "竜巻注意情報（市町村等）") */
  type: string;
  /** 地域リスト (Code 0 「なし」は除外) */
  areas: TornadoArea[];
}

/** パース済み竜巻注意情報 (VPHW50, VPHW51) */
export interface ParsedTornadoAdvisory {
  /** 電文タイプ */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "東京都竜巻注意情報") */
  title: string;
  /** Control.Title (例: "竜巻注意情報（目撃情報付き）") */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 有効期限 (Head.ValidDateTime / ISO 8601) */
  validDateTime: string | null;
  /** ヘッドラインテキスト */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** 発表報数 (Head.Serial) */
  serial: string | null;
  /** 階層別地域情報 (発表細分/一次細分/市町村まとめ/市町村等) */
  layers: TornadoAreaLayer[];
  /** 「目撃情報あり」地域 (VPHW51 のみ抽出。VPHW50 では空) */
  sightingAreas: TornadoArea[];
  /** 「目撃情報あり」電文か (head.type === "VPHW51") */
  isSightingTelegram: boolean;
  /** 実際に sightingAreas が抽出できたか (空でない) */
  hasSightingAreas: boolean;
  /** 発表中の地域数 (集計用) */
  activeAreaCount: number;
  /** Phase D: 表示重大度 (目撃=nonLevelSpecial、発表=nonLevelWarning、地域0=null) */
  displaySeverity: DisplaySeverity | null;
  /** Phase D: 通知音 (表示と独立。目撃でも warning — 2026-06-12 レビュー決定) */
  soundLevel: SoundLevel | null;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ── パース済み気象防災速報型 (VPBS50) ──

/** 気象防災速報の情報タグ (Condition から導出) */
export type WeatherBriefingTag =
  | "linearRainObserved"   // 線状降水帯発生 (現在発生中の観測)
  | "linearRainPredicted"  // 線状降水帯予想 (30分前予測)
  | "recordRain"           // 記録的短時間大雨
  | "shortSnow"            // 短時間大雪
  | "other";

/** Phase D: 電文固有語彙の severity 解決元 (監査用) */
export type TelegramSeverityResolutionSource = "map" | "unknown" | "none";

/** Phase D: VPBS50 の Condition 1 件ぶんの severity 解決結果 (監査・後追い用) */
export interface BriefingSeverityEvidence {
  /** Condition 原文 */
  condition: string;
  /** deriveBriefingTag の結果 */
  tag: WeatherBriefingTag;
  displaySeverity: DisplaySeverity | null;
  soundLevel: Exclude<SoundLevel, "cancel"> | null;
  source: TelegramSeverityResolutionSource;
}

/** 観測実況・予測の1エントリ (generic 表現) */
export interface WeatherObservation {
  /** 観測種別 (Property.Type、例: "雨の実況", "雪の実況") */
  observationType: string;
  /** イベント名や値の文字列表記 (例: "線状降水帯発生", "約100ミリ", "37センチ") */
  description: string;
  /** 数値が抽出できる場合 */
  value: number | null;
  /** 単位 (例: "mm", "cm") */
  unit: string | null;
  /** 観測 / イベント発生時刻 (ISO 8601) */
  time: string | null;
  /** 地域名 (Area.Name または Station.Name) */
  locationName: string | null;
  /** 地域コード (Area.Code 等)。属性 type は捨て、Code の文字列値のみ */
  locationCode: string | null;
  /** MeteorologicalInfos.@_type (例: "観測実況", "量的予測時系列") */
  sourceType: string | null;
  /** MeteorologicalInfo.DateTime (Part.Time が無いときの fallback) */
  contextTime: string | null;
}

/** 対象地域 (Headline.Information.Item.Areas) */
export interface BriefingTargetArea {
  name: string;
  code: string;
}

/** パース済み気象防災速報 (VPBS50) */
export interface ParsedWeatherBriefing {
  /** 電文タイプ */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "千葉県気象防災速報（線状降水帯発生）") */
  title: string;
  /** Control.Title */
  controlTitle: string;
  /** 発表日時 */
  reportDateTime: string;
  /** ヘッドラインテキスト */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID */
  eventId: string | null;
  /** 報数 */
  serial: string | null;
  /** 情報タグ (代表値: 最大 displaySeverity を与えた evidence の tag。全 other なら先頭) */
  briefingTag: WeatherBriefingTag;
  /** Condition 原文 (代表値。Phase D 以前は先頭 Condition だった) */
  briefingCondition: string;
  /** 全 Condition (情報タグ優先順・重複なし。Phase D 集合ベース化) */
  briefingConditions: string[];
  /** Condition ごとの severity 解決結果 (監査用) */
  briefingSeverityEvidence: BriefingSeverityEvidence[];
  /** DISPLAY_SEVERITY_RANK 最大の表示重大度 (対象なしは null) */
  maxDisplaySeverity: DisplaySeverity | null;
  /** SOUND_LEVEL_RANK 最大の通知音 (集合ベース、表示と独立) */
  maxSoundLevel: SoundLevel | null;
  /** 情報タグ由来なのに分類できなかった Condition (level-helper で warning 昇格) */
  unknownConditions: string[];
  /** 対象地域 (Headline.Information.Item.Areas) */
  targetAreas: BriefingTargetArea[];
  /** 観測実況 / 予測の中身 (Body.MeteorologicalInfos > MeteorologicalInfo > Item) */
  observations: WeatherObservation[];
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ── パース済み早期天候情報型 (VPAW51) ──

/** 早期天候情報の偏差方向 (平年比) */
export type EarlyWeatherTrend =
  | "above"   // 平年よりかなり高い / 多い (高温, 大雪, 多雨 等)
  | "below"   // 平年よりかなり低い / 少ない (低温, 少雨 等)
  | "unknown";

/** 早期天候情報の地域エントリ */
export interface EarlyWeatherArea {
  name: string;
  code: string;
}

/** 早期天候情報の現象エントリ (例: かなりの高温) */
export interface EarlyWeatherPhenomenon {
  /** Property.Type (例: "かなりの高温", "大雪") */
  type: string;
  /** ClimateElement の kind 属性 (例: "気温", "降雪量") */
  climateKind: string | null;
  /** ClimateElement の Text (例: "５日平均地域気温平年差＋２．４℃以上となる確率が３０％以上です") */
  climateText: string | null;
  /** above / below (平年比方向) */
  trend: EarlyWeatherTrend;
  /** 確率 (%) */
  probabilityPercent: number | null;
  /** 閾値の値 */
  thresholdValue: number | null;
  /** 閾値の単位 */
  thresholdUnit: string | null;
  /** 対象地域 */
  areas: EarlyWeatherArea[];
  /** 期間ラベル (例: "１２月１０日頃からの約５日間") */
  periodLabel: string | null;
  /** 期間 ISO Duration (例: "P5D") */
  periodDuration: string | null;
  /** 期間開始日時 (ISO 8601) */
  periodStartTime: string | null;
}

/** 早期天候情報の補足本文 */
export interface EarlyWeatherBodyText {
  text: string;
  areas: EarlyWeatherArea[];
}

/** パース済み早期天候情報 (VPAW51) */
export interface ParsedEarlyWeatherInfo {
  /** 電文タイプ ("VPAW51") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "高温に関する早期天候情報（東北地方）") */
  title: string;
  /** Control.Title (例: "早期天候情報") */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 対象開始日時 (Head.TargetDateTime) */
  targetDateTime: string | null;
  /** 対象期間 (例: "P5D") */
  targetDuration: string | null;
  /** 有効期限 (Head.ValidDateTime) */
  validDateTime: string | null;
  /** ヘッドラインテキスト */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID */
  eventId: string | null;
  /** Serial */
  serial: string | null;
  /** Headline.Information.Item.Kind.Condition の集約 (例: "...かなりの高温の確率30％以上") */
  headlineConditions: string[];
  /** Body.TargetArea (Headline と一致することが多い) */
  targetArea: EarlyWeatherArea | null;
  /** 現象群 (Body.MeteorologicalInfo.Item) */
  phenomena: EarlyWeatherPhenomenon[];
  /** 補足本文 (Property.Type=本文 の Text) */
  bodyTexts: EarlyWeatherBodyText[];
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ── パース済み気象警報・注意報時系列情報型 (VPWP50) ──

/**
 * Significancy Code の家族区分。
 *   - none       : 値なし (Code 00)
 *   - grade      : 注意報級/警報級/特別警報級 (Code 01/20/30/50 等)
 *   - alertLevel : 警戒レベル 2-5 相当 (Code 11/21/22/31/41/51 等)
 *   - unknown    : 公式表外 (推測補完せず別扱い)
 */
export type SignificancyFamily = "none" | "grade" | "alertLevel" | "unknown";

/** Significancy Code の深刻度 (rank 比較用) */
export type SignificancySeverity =
  | "none"
  | "below"
  | "advisory"
  | "warning"
  | "special"
  | "unknown";

/** Significancy Code の lookup 結果 */
export interface SignificancyInfo {
  /** 元の Code (例: "30", "41", "99") */
  code: string;
  /** 公式 Code 表に存在するか */
  known: boolean;
  /** ランク (比較用、unknown は 999) */
  rank: number;
  /** 家族区分 */
  family: SignificancyFamily;
  /** 日本語ラベル (例: "警報級", "警戒レベル4相当", "未知Code 99") */
  label: string;
  /** compact 表示用 (例: "警", "L4相", "?99") */
  compact: string;
  /** 深刻度 */
  severity: SignificancySeverity;
}

/** 数値系メトリックの worst 方向 */
export type QuantitativeDirection = "higherIsWorse" | "lowerIsWorse" | "paired";

/**
 * 数値系メトリックのメタ情報 (worst 方向 + 単位 + ラベル)。
 * 「最大値」総称は危険 — 湿度・視程は小さい方が危険。
 */
export interface QuantitativeMetricMeta {
  direction: QuantitativeDirection;
  unit: string;
  label: string;
}

/** Local (地域内分割) 単位の値 (例: "○○海岸", "海上") */
export interface LocalValue<T> {
  areaName: string;
  code?: string;
  value: T;
}

/**
 * Local 階層を持つ Part 値 (高潮以外でも汎用)。
 * Significancy / 風向 / 風速 / 視程 すべてに使える。
 */
export interface PartValue<T> {
  /** Area 全体の値 (Local なしの場合) */
  base?: T;
  /** Local 分割があるとき */
  locals?: LocalValue<T>[];
}

/**
 * Worst 値が及ぶ時刻範囲 (parser が TimeDefine から解決済み)。
 *   - 同 Code/rank が連続する refID ブロックなら startName-endName で範囲化
 *   - 非連続なら contiguous=false、startName のみが意味を持つ (`18時ほか2枠` 表記用)
 *   - 単独枠なら startName=endName, count=1
 */
export interface TimeWindow {
  /** 代表時刻ラベル (最初の枠の Name、例: "２２日朝") */
  startName: string;
  /** 終了時刻ラベル (連続枠の最後の Name)、単独や非連続なら startName と同じ */
  endName: string;
  /** 同 worst にあたる枠数 */
  count: number;
  /** 連続枠か (false なら『非連続、代表 1 枠 + その他』表示) */
  contiguous: boolean;
}

/** Significancy 単位の値 (Code + 時刻 + Peak/CriteriaPeriod ペア) */
export interface SignificancyValue {
  info: SignificancyInfo;
  /** 時刻参照 ID (TimeDefine.timeId)、代表 1 枠 */
  timeRef: string;
  /** 解決済み時刻幅 (TimeDefine から parser が組み立て) */
  timeWindow?: TimeWindow;
  /** PeakTime (警戒レベル3+で出る) */
  peak?: SignificancyPeakTime;
  /** CriteriaPeriod (警戒レベル4+土砂/高潮で出る) */
  criteriaPeriod?: SignificancyCriteriaPeriod;
}

/** PeakTime (ピーク時刻) */
export interface SignificancyPeakTime {
  /** Date (例: "21日") */
  date: string;
  /** Term (例: "未明", "明け方", "朝", "昼前", "昼過ぎ", "夕方", "夜のはじめ頃", "夜遅く") */
  term: string;
}

/** CriteriaPeriod (基準到達期間) */
export interface SignificancyCriteriaPeriod {
  /** Sentence (例: "21日未明から早朝にかけて警戒レベル4相当の予測") */
  sentence: string;
  /** CriteriaClass (例: "土砂災害警戒レベル4相当") */
  criteriaClass: string;
  /** Time (ISO 8601 開始時刻) */
  time: string;
  /** Duration (ISO 8601、例: "PT4H") */
  duration: string;
}

/** 数値系の値 (Precipitation/SnowfallDepth/Humidity/WaveHeight/TidalLevel/Visibility) */
export interface QuantitativeValue {
  value: number;
  /** 単位 (確認用、metric meta と一致) */
  unit: string;
  /** 時刻参照 ID */
  timeRef: string;
  /** 解決済み時刻幅 (parser が TimeDefine から組み立て) */
  timeWindow?: TimeWindow;
}

/** 風 (向き+速度) の組 (paired metric) */
export interface WindPairedValue {
  /** 最大風速 (m/s) */
  speed: number;
  /** 最大風速時の風向 (16方位日本語、欠落時 null) */
  direction: string | null;
  /** 時刻参照 ID (最大風速の時刻) */
  timeRef: string;
  /** 解決済み時刻幅 (parser が TimeDefine から組み立て) */
  timeWindow?: TimeWindow;
}

/** VPWP50 の Part 種別 */
export type WeatherWarningTimeseriesPartKind =
  | "Significancy"
  | "Precipitation"
  | "SnowfallDepth"
  | "Humidity"
  | "WindPaired"
  | "WaveHeight"
  | "TidalLevel"
  | "Visibility";

/** TimeSeriesInfo の番号 (公式仕様: 3 個固定) */
export type WeatherWarningTimeseriesNumber = 1 | 2 | 3;

/** Kind 行 (Property.Type + Local 汎用 PartValue + worst) */
export interface WeatherWarningTimeseriesKind {
  /** Property.Type (例: "土砂災害", "大雨", "風") */
  type: string;
  /** Part 種別 */
  partKind: WeatherWarningTimeseriesPartKind;
  /** Significancy の worst (Code 系、Local 階層保持) */
  significancyWorst?: PartValue<SignificancyValue>;
  /** 数値系の worst (Precipitation/Snowfall/Humidity/WaveHeight/TidalLevel/Visibility) */
  quantitativeWorst?: PartValue<QuantitativeValue>;
  /** 風 (Direction + Speed) の組 (paired) */
  windWorst?: PartValue<WindPairedValue>;
  /** 数値系メトリックのメタ (該当時のみ) */
  metricMeta?: QuantitativeMetricMeta;
}

/** Area (市町村) */
export interface WeatherWarningTimeseriesArea {
  name: string;
  code: string;
  /** TimeSeries 番号別の Kind 一覧 (1: 3時間系列、2: 24時間最大、3: 日単位) */
  kinds: {
    1: WeatherWarningTimeseriesKind[];
    2: WeatherWarningTimeseriesKind[];
    3: WeatherWarningTimeseriesKind[];
  };
}

/** 未知 Code 出現箇所 (本体最大とは別保持、frame 警告昇格用) */
export interface UnknownSignificancyOccurrence {
  /** 元の Code (例: "99") */
  code: string;
  /** Property.Type (例: "大雨浸水") */
  propertyType: string;
  /** 時刻参照 ID */
  timeRef: string;
  /** 該当 Area の名前 */
  areaName: string;
}

/** 段階 fallback 判定 */
export type WeatherWarningTimeseriesFallback = "none" | "compactOnly" | "raw";

/** パース済み気象警報・注意報時系列情報 (VPWP50) */
export interface ParsedWeatherWarningTimeseriesInfo {
  /** 電文タイプ ("VPWP50") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル */
  title: string;
  /** Control.Title */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID */
  eventId: string | null;
  /** Serial */
  serial: string | null;
  /** ヘッドラインテキスト */
  headline: string | null;
  /** 対象地域 (Body.TargetArea) */
  targetArea: WeatherWarningTimeseriesArea | null;
  /** 市町村別 Area 一覧 */
  areas: WeatherWarningTimeseriesArea[];
  /**
   * 既知 Code の worst (frame level 判定 + compact 表示の本体最大用)。
   * 未知 Code は混ぜない (`unknownCodes` 側へ)。
   */
  maxKnownSignificancy: SignificancyInfo | null;
  /** Phase B: DISPLAY_SEVERITY_RANK 基準の最大表示重大度 (既知 Significancy が無ければ null)。
   *  maxKnownSignificancy (rank 基準) とは選び方が違う — Code 50/41 混在時に逆転する */
  maxDisplaySeverity: DisplaySeverity | null;
  /** 通知音の集合ベース最大 (既知 Significancy が無ければ null)。
   *  maxDisplaySeverity (RANK 1 点代表) と独立 — Code 41 (officialL4) と 50 (nonLevelSpecial)
   *  の共存で特別警報の critical 音が潰れない (2026-06-12 共存エッジ解消) */
  maxSoundLevel: SoundLevel | null;
  /** Phase B: maxDisplaySeverity を与えた SignificancyInfo (バナー本文の代表ラベル用) */
  maxDisplayRankSignificancy: SignificancyInfo | null;
  /**
   * 未知 Code 一覧 (frame 警告昇格 + 表示用、本体最大とは分離)。
   * `?99` が L5/L4 より前に出ないように、parser 段階で分離する。
   */
  unknownCodes: UnknownSignificancyOccurrence[];
  /** 段階 fallback 判定 (none: 通常、compactOnly: section truncation、raw: 全 parse 諦め) */
  fallback: WeatherWarningTimeseriesFallback;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ── パース済み火山情報型 ──

/** 火山電文の head.type リテラル */
export type VolcanoHeadType =
  | "VZVO40" | "VFVO50" | "VFVO51" | "VFVO52" | "VFSVii"
  | "VFVO53" | "VFVO54" | "VFVO55" | "VFVO56" | "VFVO60";

/** 正規化されたアクション（パーサが XML の Condition 等から変換） */
export type VolcanoAction = "issue" | "continue" | "raise" | "lower" | "release" | "cancel";

export type VolcanoAlertClassSeverity = "warning" | "info";

/** 数値の噴火警戒レベルを持たない警報・予報区分。 */
export interface VolcanoAlertClass {
  code: string;
  name: string;
  severity: VolcanoAlertClassSeverity;
  isActive: boolean;
}

/** VFVO51 の一覧電文から火山単位に展開した非数値警報区分。 */
export interface VolcanoAlertClassEntry {
  volcanoCode: string;
  volcanoName: string;
  alertClass: VolcanoAlertClass;
}

/** 対象市町村 */
export interface VolcanoMunicipality {
  name: string;
  code: string;
  kind: string;
}

/** 降灰予報の時間帯 */
export interface AshForecastPeriod {
  startTime: string;
  endTime: string;
  areas: AshArea[];
}

/** 降灰予報の地域 */
export interface AshArea {
  name: string;
  code: string;
  ashCode: string;
  ashName: string;
  thickness: number | null;
  plumeDirection: string | null;  // 降灰/噴石の方向 (description 属性の詳細語。例「東（鹿屋市輝北方向）」)
  distanceKm: number | null;      // 到達距離 km (例 100, 5)
}

/** 風向データ */
export interface WindProfileEntry {
  altitude: string;
  degree: number | null;
  speed: number | null;
}

/** 共通ベース */
interface ParsedVolcanoBase {
  domain: "volcano";
  kind: "alert" | "eruption" | "ashfall" | "text" | "plume";
  type: VolcanoHeadType;
  infoType: string;           // 発表, 訂正, 取消
  title: string;
  reportDateTime: string;
  eventDateTime: string | null;
  headline: string | null;
  publishingOffice: string;
  volcanoName: string;
  volcanoCode: string;
  coordinate: string | null;
  meta: TelegramMeta;
  isTest: boolean;
}

/** 噴火警報・予報 (VFVO50, VFSVii) */
export interface ParsedVolcanoAlertInfo extends ParsedVolcanoBase {
  kind: "alert";
  type: "VFVO50" | "VFSVii";
  alertLevel: 1 | 2 | 3 | 4 | 5 | null;
  alertLevelCode: string | null;
  action: VolcanoAction;
  previousLevelCode: string | null;
  warningKind: string;
  municipalities: VolcanoMunicipality[];
  marineAreas: VolcanoMunicipality[];
  marineWarningKind: string | null;
  marineAlertLevelCode: string | null;
  alertClass: VolcanoAlertClass | null;
  bodyText: string;
  preventionText: string;
  isMarine: boolean;
}

/** 噴火に関する火山観測報 (VFVO52, VFVO56) */
export interface ParsedVolcanoEruptionInfo extends ParsedVolcanoBase {
  kind: "eruption";
  type: "VFVO52" | "VFVO56";
  phenomenonCode: string;
  phenomenonName: string;
  craterName: string | null;
  plumeHeight: number | null;
  plumeHeightUnknown: boolean;
  plumeDirection: string | null;
  isFlashReport: boolean;
  bodyText: string;
}

/** 降灰予報 (VFVO53, VFVO54, VFVO55) */
export interface ParsedVolcanoAshfallInfo extends ParsedVolcanoBase {
  kind: "ashfall";
  type: "VFVO53" | "VFVO54" | "VFVO55";
  subKind: "scheduled" | "rapid" | "detailed";
  craterName: string | null;
  ashForecasts: AshForecastPeriod[];
  plumeHeight: number | null;
  plumeDirection: string | null;
  bodyText: string;
}

/** 火山の状況に関する解説情報 / 火山に関するお知らせ (VZVO40, VFVO51) */
export interface ParsedVolcanoTextInfo extends ParsedVolcanoBase {
  kind: "text";
  type: "VZVO40" | "VFVO51";
  alertLevel: 1 | 2 | 3 | 4 | 5 | null;
  alertLevelCode: string | null;
  alertClasses: VolcanoAlertClassEntry[];
  /** VFVO51 の state 更新候補。数値レベルと非数値区分を火山単位で保持する。 */
  alertStateEntries?: VolcanoAlertStateEntry[];
  isExtraordinary: boolean;
  bodyText: string;
  nextAdvisory: string | null;
}

export interface VolcanoAlertStateEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: 1 | 2 | 3 | 4 | 5 | null;
  alertLevelCode: string | null;
  action: VolcanoAction;
  warningKind: string;
  alertClass: VolcanoAlertClass | null;
}

/** 推定噴煙流向報 (VFVO60) */
export interface ParsedVolcanoPlumeInfo extends ParsedVolcanoBase {
  kind: "plume";
  type: "VFVO60";
  phenomenonCode: string;
  craterName: string | null;
  plumeHeight: number | null;
  plumeDirection: string | null;
  windProfile: WindProfileEntry[];
  bodyText: string;
}

/** パース済み火山情報 (discriminated union) */
export type ParsedVolcanoInfo =
  | ParsedVolcanoAlertInfo
  | ParsedVolcanoEruptionInfo
  | ParsedVolcanoAshfallInfo
  | ParsedVolcanoTextInfo
  | ParsedVolcanoPlumeInfo;

// ── パース済み全般天候情報型 (VPZI50) ──

/** 気候情報の地域エントリ */
export interface ClimateArea {
  name: string;
  code: string;
}

/**
 * 気候情報の本文ブロック (Property.Type="本文" 由来)。
 * Text の type 属性で「概況」「今後の見通し」「防災事項」などに分かれる。
 */
export interface ClimateBodyText {
  /** Text の type 属性 (例: "概況" / "今後の見通し" / "防災事項")。属性なしは null */
  textType: string | null;
  /** 本文 */
  text: string;
  /** 対象地域 (MeteorologicalInfo > Item > Areas) */
  areas: ClimateArea[];
  /** 期間ラベル (MeteorologicalInfo > Name)。なければ null */
  periodLabel: string | null;
}

/**
 * 観測点ごとの気候値 (Property.Type="天候の状況（速報値）" 由来)。
 * 平均気温と平年差、総降水量と平年比のペア。
 */
export interface ClimateStationValue {
  /** 観測点名 (例: "東京") */
  stationName: string;
  /** 観測点コード (国際地点番号) */
  stationCode: string;
  /** 平均気温 (度)。取得失敗時は null */
  temperatureCelsius: number | null;
  /** 平均気温の平年差 (度)。プラスマイナス値、取得失敗時は null */
  temperatureAnomalyCelsius: number | null;
  /**
   * 平均気温の平年値 (度)。Temperature の type 違い兄弟要素
   * (type に「平年値」を含む) 由来。なければ null
   */
  temperatureNormalCelsius: number | null;
  /** 総降水量 (ミリ)。取得失敗時は null */
  precipitationMm: number | null;
  /** 総降水量の平年比 (%)。取得失敗時は null */
  precipitationAnomalyPercent: number | null;
  /**
   * 総降水量の平年値 (ミリ)。Precipitation の type 違い兄弟要素
   * (例: type="降水量日別平滑平年値合計") 由来。なければ null
   */
  precipitationNormalMm: number | null;
  /** 期間ラベル (MeteorologicalInfo > Name)。なければ null */
  periodLabel: string | null;
}

/** 季節イベント日付 (VPCI50 の EventDatePart。梅雨入り/梅雨明け等) */
export interface ClimateSeasonEvent {
  /** Property.Type (例: "梅雨明け") */
  eventType: string;
  /** Date の description (例: "７月１９日ごろ")。無ければ null */
  dateDescription: string | null;
  /** Date の dubious 属性 (例: "頃")。無ければ null */
  dateDubious: string | null;
  /** Normal (平年) の description。無ければ null */
  normalDescription: string | null;
  normalDubious: string | null;
  /** LastYear (昨年) の description。無ければ null */
  lastYearDescription: string | null;
  lastYearDubious: string | null;
  /** 対象地域 */
  areas: ClimateArea[];
}

// ── パース済み気象解説情報型 (VPCJ51/VPZJ51 共有) ──

/** 気象解説情報の地域エントリ */
export interface WeatherExplanationArea {
  name: string;
  code: string;
}

/**
 * Headline.Information.Item.Kind の「情報タグ」エントリ。
 * Condition は半角スペース区切りで複数キーワードが入りうる (例: "強い冬型 大雪")。
 */
export interface WeatherExplanationInformationTag {
  /** Condition の生文字列 */
  condition: string;
  /** Condition をスペース区切りで分解した keyword 群 */
  keywords: string[];
  /** Information のもう一方の Areas (TargetArea 兄弟と別系統で来ることがある) */
  areas: WeatherExplanationArea[];
}

/**
 * Body.MeteorologicalInfos の各セクション。
 * sectionType (MeteorologicalInfos の @_type、例: "概況"/"防災事項"/"付加情報") と
 * propertyType (内部 Property.Type、例: "気象概況"/"防災事項"/"補足事項") を別に保持。
 */
export interface WeatherExplanationSection {
  /** MeteorologicalInfos の @_type (例: "概況" / "防災事項" / "付加情報") */
  sectionType: string;
  /** Property.Type (例: "気象概況" / "防災事項" / "補足事項") */
  propertyType: string;
  /** Property.Text の type 属性 (例: "本文")。属性なしは null */
  textType: string | null;
  /** Property.Text の本文 (改行込み) */
  text: string;
}

// ── 予想 (TimeSeriesInfo) 型: VPZJ51 全般気象解説情報 ──

/** TimeDefine 1 件 (系列ローカル) */
export interface ForecastTimeDefine {
  timeId: string;
  dateTime: string;
  /** ISO 8601 期間 (例 "P1D"/"PT27H")。XML に Duration 要素が無いときは空文字 */
  duration: string;
  name: string;
}

/** EventPart 1 件 (県 × 線状降水帯イベント) */
export interface ForecastEvent {
  areaName: string;
  regionLabel: string | null;
  code: string;
  eventType: string;
  eventName: string;
  sentence: string;
  timeRef: string;
  timeName: string | null;
  time: string | null;
  duration: string | null;
}

/** 定量メトリック値 1 件 */
export interface ForecastMetricValue {
  timeRef: string;
  timeName: string | null;
  subType: string;
  unit: string;
  value: number | null;
  condition: string | null;
  description: string | null;
  /** jmx_eb 要素の #text 原文 (WindDirection の "南東" 等、value=null でも raw で復元可能) */
  raw: string;
}

/** 1 地域 × 1 メトリック種別の全時系列値 */
export interface ForecastMetricArea {
  areaName: string;
  /** CodeList が複数コードの場合も全部保持 (例: "130011 130012 130013 130014 130015") */
  codes: string[];
  /** クラスタキー等で 1 つ選ぶ用 (codes[0] と同じ)。空配列なら "" */
  primaryCode: string;
  metricType: string;
  /** 必ず length >= 1。Local 無し電文は [{ areaName: null, phases: [...] }] のシングルトン */
  locals: ForecastLocalGroup[];
}

export interface ForecastLocalGroup {
  /** <Local><AreaName>平地</AreaName></Local> の AreaName。Local 無しなら null */
  areaName: string | null;
  /** 必ず length >= 1。Base/Becoming 順 */
  phases: ForecastPhase[];
}

export interface ForecastPhase {
  kind: "base" | "becoming";
  /** <TimeModifier> ("のち" / "ときどき" / "一時" / "から" 等)。Base は null */
  modifier: string | null;
  values: ForecastMetricValue[];
}

/** TimeSeriesInfo 1 本 */
export interface ForecastTimeSeries {
  /**
   * MeteorologicalInfos@type="予想" 配下での TimeSeriesInfo 文書順インデックス
   * (空 series スキップ前に採番)。WeatherExplanationTidalEntry.seriesIndex との突き合わせ用
   */
  sourceIndex: number;
  /** Text[@type=気象要素] の文言 ("予想される最大風速（最大瞬間風速）" / "線状降水帯発生予測"。無ければ null) */
  element: string | null;
  timeDefines: ForecastTimeDefine[];
  intro: string[];
  supplement: string[];
  events: ForecastEvent[];
  metrics: ForecastMetricArea[];
}

/** 予想 (MeteorologicalInfos type="予想") 全体 */
export interface WeatherExplanationForecast {
  series: ForecastTimeSeries[];
  /** 表示量ガード。VPWP50 の fallback とは別閾値 (予想行数 ≤80=none / ≤200=compactOnly / >200=raw) */
  fallback: "none" | "compactOnly" | "raw";
}

// ── 観測実況 (VPFJ51) ──

/** 観測実況セクション全体 */
export interface WeatherExplanationObservation {
  series: ObservationSeries[];
  /** 描画量 fallback。閾値は forecast と同じ 80 行 / 200 行 */
  fallback: "none" | "compactOnly" | "raw";
}

/** 観測実況の系列 (集約キー: propertyType + element + partType + observedAt) */
export interface ObservationSeries {
  propertyType: string;   // "雨の実況" / "風の実況" / "雪の実況" / "波の実況"
  element: string | null; // Text[@type=気象要素]
  partType: string;       // PrecipitationPart / WindPart / SnowDepthPart / SnowfallDepthPart / WaveHeightPart
  observedAt: string | null; // ISO 8601 (MeteorologicalInfo.DateTime or TimeDefine.DateTime)
  intro: string[];        // Text[@type=解説/時系列解説]
  supplement: string[];   // Text[@type=補足/時系列補足]
  stations: StationObservation[];
  timeDefines: ForecastTimeDefine[]; // パターン (i) のみ非空
}

/** 観測地点単位の観測値 */
export interface StationObservation {
  stationName: string;
  stationCode: string;
  stationLocation: string;
  measurements: StationMeasurement[];
}

/** 1 Part の観測値 */
export interface StationMeasurement {
  partType: string;
  sentence: string;
  time: string | null;
  remark: string | null;
  values: ForecastMetricValue[];
}

// ── 潮位 (TidalLevelPart): VMCJ53-55 気象解説情報（潮位） ──

/** TidalLevelPart 1 件分 (実況または予想)。Sentence が表示用、数値系は保全用 */
export interface WeatherExplanationTidalEntry {
  /** 表示可能文字列 (例: "１９日１２時２０分ごろ　約８０センチ　約６０分") */
  sentence: string;
  /** Item 直下 Station の名前。無ければ null */
  stationName: string | null;
  /** Time 要素の生文字列 (ISO)。無ければ null */
  time: string | null;
  /** jmx_eb:TidalLevel の description (例: "約８０センチ")。無ければ null */
  levelDescription: string | null;
  /** jmx_eb:TidalLevel の @type (例: "満潮潮位"/"干潮潮位"/"副振動の山から谷の高さ")。無ければ null */
  levelType: string | null;
  /** jmx_eb:TidalPeriod の description (例: "約６０分")。無ければ null */
  periodDescription: string | null;
  /** jmx_eb:TidalLevel の #text 生値 (例: "80")。値なし時 null */
  rawLevel: string | null;
  /** jmx_eb:TidalPeriod の #text 生値。無ければ null */
  rawPeriod: string | null;
  /** Sequence の refID (予想のみ)。無ければ null */
  refId: string | null;
  /** TimeDefines から refID で解決した期間名 (例: "９月１９日")。実況や解決不能時は null */
  timeName: string | null;
  /**
   * 予想系 (MeteorologicalInfos@type="予想") TimeSeriesInfo の文書順インデックス。
   * ForecastTimeSeries.sourceIndex と突き合わせて「▸ 予想: …」見出し直下に統合表示する。
   * 実況エントリや予想系以外の TimeSeriesInfo 由来は null
   */
  seriesIndex: number | null;
}

/** 気象解説情報（潮位）の TidalLevelPart 集約 (VMCJ53-55) */
export interface WeatherExplanationTidal {
  /** 観測実況 (副振動の高さ・周期等) */
  observations: WeatherExplanationTidalEntry[];
  /** 予想 (満潮・干潮時刻等) */
  forecasts: WeatherExplanationTidalEntry[];
}

/** パース済み気象解説情報 (VPCJ51/VPZJ51/VPFJ51/VMCJ53-55 共有) */
export interface ParsedWeatherExplanation {
  /** 電文タイプ ("VPCJ51" | "VPZJ51" | "VPFJ51" | "VMCJ53" | "VMCJ54" | "VMCJ55") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "関東甲信地方気象解説情報（強い冬型・大雪）") */
  title: string;
  /** Control.Title (例: "地方気象解説情報") */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 対象日時 (Head.TargetDateTime) */
  targetDateTime: string | null;
  /** 有効期限 (Head.ValidDateTime)。VPCJ51 では通常 null */
  validDateTime: string | null;
  /** Headline.Text */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID (例: "JPTK230150") */
  eventId: string | null;
  /** Serial */
  serial: string | null;
  /** Headline.Information.Item の情報タグ群 (条件と対象地域) */
  informationTags: WeatherExplanationInformationTag[];
  /** 対象地域 (情報タグの Areas を平坦化) */
  targetAreas: WeatherExplanationArea[];
  /** 本文セクション群 (概況/防災事項/付加情報) */
  sections: WeatherExplanationSection[];
  /** 予想 (TimeSeriesInfo)。VPCJ51 は null、VPZJ51 で設定 */
  forecast: WeatherExplanationForecast | null;
  /** 観測実況 (VPFJ51 のみ非 null)。VPCJ51/VPZJ51 は null */
  observation: WeatherExplanationObservation | null;
  /** 潮位 TidalLevelPart (VMCJ53-55 のみ非 null)。VPCJ51/VPZJ51/VPFJ51 は null */
  tidal: WeatherExplanationTidal | null;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

/** パース済み天候情報 (VPZI50 全般 / VPCI50 地方) */
export interface ParsedClimateInfo {
  /** 電文タイプ ("VPZI50" / "VPCI50") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "東日本と西日本の長期間の高温と少雨に関する全般気象情報") */
  title: string;
  /** Control.Title (例: "全般天候情報") */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 対象日時 (Head.TargetDateTime) */
  targetDateTime: string | null;
  /** 有効期限 (Head.ValidDateTime) */
  validDateTime: string | null;
  /** Headline.Text */
  headline: string | null;
  /** 発表官署 */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID */
  eventId: string | null;
  /** Serial */
  serial: string | null;
  /** Body.TargetArea (例: 「全国」) */
  targetArea: ClimateArea | null;
  /** 本文ブロック群 (概況・今後の見通し・防災事項) */
  bodyTexts: ClimateBodyText[];
  /** 観測点別気候値群 */
  stations: ClimateStationValue[];
  /** 季節イベント日付群 (VPCI50 の EventDatePart 由来。VPZI50 では常に空) */
  seasonEvents: ClimateSeasonEvent[];
  /** Body.Comment の末文 */
  comment: string | null;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

/** 熱中症警戒アラート (VPFT50) のパース結果 */
export interface ParsedHeatAlertInfo {
  /** 電文タイプ ("VPFT50") */
  type: string;
  /** 情報の種類 (発表/訂正/取消) */
  infoType: string;
  /** タイトル (例: "埼玉県熱中症警戒アラート") */
  title: string;
  /** Control.Title (例: "熱中症警戒アラート") */
  controlTitle: string;
  /** 発表日時 (ISO 8601) */
  reportDateTime: string;
  /** 対象日時 (Head.TargetDateTime) */
  targetDateTime: string | null;
  /** Headline.Text。実電文では空のため通常 null */
  headline: string | null;
  /** 発表官署 (例: "環境省 気象庁") */
  publishingOffice: string;
  /** 編集官署 */
  editorialOffice: string;
  /** EventID */
  eventId: string | null;
  /** Serial */
  serial: string | null;
  /** Title から抽出した対象府県名 (例: "埼玉県")。抽出不能時 null */
  targetAreaName: string | null;
  /** Body.Notice */
  notice: string | null;
  /** Body.Comment.Text (本文平文) */
  bodyText: string | null;
  /** テスト電文かどうか */
  meta: TelegramMeta;
  isTest: boolean;
}

// ─── 台風解析・予報情報 (VPTW60 / VPTW61 / VPTW62) ───────────────────────────

export interface ParsedTyphoonAnalysis {
  type: string;              // head.type ("VPTW60"/"VPTW61"/"VPTW62")
  infoType: string;          // 発表 / 訂正 / 取消
  title: string;             // Head.Title
  controlTitle: string;      // Control.Title
  infoKind: string;          // "台風解析・予報情報（５日予報）"
  infoKindVersion: string;   // "1.0_2" / "1.0_1"
  reportDateTime: string;    // Head.ReportDateTime
  publishingOffice: string;
  eventId: string | null;    // "TC2001"
  serial: string | null;
  headline: string | null;
  name: TyphoonName | null;  // 呼称（実況の TyphoonNamePart。Area.Name は generic 固定で不使用）
  frames: TyphoonFrame[];    // 実況 + 推定 + 予報（文書順）
  lifecycle: TyphoonLifecycle;
  meta: TelegramMeta;
  isTest: boolean;
}

export type TyphoonLifecycle =
  | "active"
  | "forming"
  | "transitionedToLow"
  | "formationCancelled";

export interface TyphoonName {
  name: string | null;       // 英名 "TALIM"
  nameKana: string | null;   // "タリム"
  number: string | null;     // 台風番号 "1718"
  remark: string | null;     // "台風発生予想" 等（未命名時）
}

export interface TyphoonFrame {
  kind: "実況" | "推定" | "予報";
  label: string;             // DateTime @_type 全体 "予報　１２時間後"
  validTime: string;         // DateTime #text (ISO)
  typhoonClass: TyphoonClass;
  center: TyphoonCenter;
  wind: TyphoonWind | null;
}

export interface TyphoonClass {
  category: string | null;   // 熱帯擾乱種類 "台風(TS)"/"熱帯低気圧(TD)"
  intensity: string | null;  // 強さ階級 "非常に強い"（多くは空）
  size: string | null;       // 大きさ階級 "大型"（多くは空）
}

export interface TyphoonCenter {
  location: string | null;               // "マリアナ諸島"
  coordinate: string | null;             // 実況/推定: 確定座標 @_description "北緯..."
  forecastCircleRadiusKm: number | null; // 予報: 70%確率半径 km
  moveDirection: string | null;          // 移動方向 "西北西"
  moveSpeedKmh: number | null;           // 移動速度 km/h
  pressureHpa: number | null;            // 中心気圧 hPa
  /** Phase 5B canonical 値。旧 scalar は互換 adapter として維持する。 */
  moveSpeedKmhValue?: SpecialValue<number>;
  /** Phase 5B canonical 値。旧 scalar は互換 adapter として維持する。 */
  pressureHpaValue?: SpecialValue<number>;
}

export interface TyphoonWind {
  maxWindMs: number | null;
  maxGustMs: number | null;
  /** Phase 5B canonical 値。旧 scalar は互換 adapter として維持する。 */
  maxWindMsValue?: SpecialValue<number>;
  /** Phase 5B canonical 値。旧 scalar は互換 adapter として維持する。 */
  maxGustMsValue?: SpecialValue<number>;
  stormArea: TyphoonWindArea | null;        // 暴風域（実況/推定）
  galeArea: TyphoonWindArea | null;         // 強風域（実況/推定）
  stormWarningArea: TyphoonWindArea | null; // 暴風警戒域（予報）
}

export interface TyphoonWindArea {
  thresholdMs: number | null;  // 50 / 30 m/s 以上
  axes: TyphoonWindAxis[];     // 方向別（非対称）半径。全域は 1 要素
}

export interface TyphoonWindAxis {
  direction: string | null;    // "南東" / "全域"
  radiusKm: number | null;     // condition="なし" → null
}

// ─── VPTA50: 台風の暴風域に入る確率 ─────────────────────

export interface TyphoonProbTimeDefine {
  timeId: number;
  dateTime: string;
  duration: string;
}

export type TyphoonProbPeak =
  | { kind: "value"; step: number; time: string; value: number; ties: number[] }
  | { kind: "allZero" }
  | { kind: "noData"; reason: "missingTimeDefines" | "missingSeries" };

export interface TyphoonProbRegion {
  areaName: string;
  areaCode: string;
  prefName: string;
  prefCode: string;
  daily: (number | null)[];
  series40: (number | null)[];
  peak: TyphoonProbPeak;
}

export interface TyphoonProbParserDiagnostics {
  duplicateCodes: string[];
  missingCodesPerSection: { sectionType: string; codes: string[] }[];
  sectionCodeCountMismatch: boolean;
  dailyAnomalies: { areaCode: string; daily: (number | null)[]; reason: string }[];
  unknownAttributes: string[];
}

export type TyphoonProbabilityFallback = "none" | "compactOnly" | "raw";

export interface ParsedTyphoonProbability {
  type: string;
  infoType: string;
  title: string;
  controlTitle: string;
  name: TyphoonName | null;
  baseTime: string | null;
  reportDateTime: string | null;
  publishingOffice: string | null;
  timeDefines: TyphoonProbTimeDefine[];
  regions: TyphoonProbRegion[];
  eventId: string | null;
  serial: string | null;
  meta: TelegramMeta;
  isTest: boolean;
  fallback: TyphoonProbabilityFallback;
  parserDiagnostics: TyphoonProbParserDiagnostics;
}

// ─────────────────────────────────────────────────────────────
// 洪水・水位系電文 — VXKO50-89 / VXSU50-59
// (spec: 設計メモ 2026-06-14-flood-water-level-design.md §3)
// ─────────────────────────────────────────────────────────────

export type FloodReportSchema = "vxko50" | "vxsu50";

export type FloodKindCode =
  | "10" | "20" | "21" | "30" | "31"
  | "40" | "41" | "51" | "53" | "unknown";

export type FloodLevel = "L1" | "L2" | "L3" | "L4" | "L5" | "release" | "unknown";

export type FloodInfoScope = "予報区域" | "河川" | "府県予報区等" | "発表区間" | "unknown";

export type FloodMeasurement = "water_level" | "discharge";
export type FloodMeasurementUnit = "m" | "立方メートル毎秒";

export interface ParsedFloodForecastInfo {
  schema: FloodReportSchema;
  typeCode: string;
  infoKind: string;
  infoType: "発表" | "訂正" | "取消";
  serial: number;
  eventId: string;
  controlTitle: string;
  headTitle: string;
  reportDateTime: string;
  targetDateTime: string | null;
  meta: TelegramMeta;
  isTest: boolean;
  notice: string | null;
  headlines: FloodHeadline[];
  rawStations: FloodStation[];          // aggregateByRiver は formatter (src/ui/flood-forecast-formatter.ts、Task 18-20) で呼ぶ
  inundationAreas: InundationArea[];
  rainfallSummaries: RainfallSummary[];
  floodAssumptions: FloodAssumptionPart[];
  publishingOffice: string;
  editorialOffice: string;
}

export interface FloodHeadline {
  scope: FloodInfoScope;                // Information.type の括弧内ラベル抽出
  rawScopeLabel: string;                // 抽出失敗時の fallback (生文字列)
  kindName: string;
  kindCode: FloodKindCode;
  headlineText: string;                 // Headline 直下の Text
  condition: string;
  areas: { name: string; code: string }[];
}

export interface FloodStation {
  stationName: string;
  stationCode: string;                  // 透過保持 (桁数 invariant なし)
  riverNames: string[];                 // ChargeSection 由来
  primaryRiverCode: string | null;      // <Stations>/<Station>/<Code> 由来
  primaryRiverName: string | null;
  prefName: string | null;
  cityName: string | null;
  cityCode: string | null;
  location: string | null;
  measurement: FloodMeasurement;
  measurementUnit: FloodMeasurementUnit;
  rawUnit: string;
  series: FloodSeriesWindow[];          // VXSU stub では []
  criteria: FloodCriteria;
  stationObservedLevel: FloodLevel;     // 欠測 → "unknown"
  /** parser 段で §3.1 ルールで解決. */
  headlineKindCode: FloodKindCode;
  headlineLevel: FloodLevel;
  /** Warning.Item.Kind.Code (1 / 2 / それ以外 / 不在 → null) */
  mainItemCode: "1" | "2" | null;
  /** SHA1 fullhex (40). Warning.Item 不在は "" 固定. */
  mainTextHash: string;
}

export interface FloodSeriesWindow {
  refId: string;
  dateTime: string;
  name: string;
  value: number | null;
  unit: FloodMeasurementUnit;
  rawUnit: string;
  condition: "正常" | "上昇" | "下降" | "未計算" | "欠測" | "一定" | "無効" | "unknown";
  level: 0 | 1 | 2 | 3 | 4 | 5 | null;
}

export interface FloodCriteria {
  L1: number | null; L2: number | null; L3: number | null;
  L4: number | null;
  /** L4 計画到達水位 (vs. L4 = 実測ベース). */
  L4Plan: number | null;
  unit: FloodMeasurementUnit;
  rawUnit: string;
}

export interface InundationArea {
  variant: "通常" | "氾濫発生情報";
  rawCodeType: string | null;
  axis: "station" | "municipality" | "unknown";
  stationCode: string | null;
  cityCode: string | null;
  areaName: string;
  prefName: string;
  prefCode: string | null;
  cityName: string | null;
  subCityList: string[];
}

export interface RainfallSummary {
  basinName: string | null;
  /**
   * 累積実況 (TimeSeriesInfo.PrecipitationPart の refID=1 相当、
   * Duration が実況窓を示す。実 fixture は PT6H〜PT96H 等の任意長)
   *
   * - windowMinutes: TimeDefine.Duration から導出。fallback で Name regex (e.g. "X時間"→X*60)
   *   両方失敗時は null を許容 (定数フォールバックは入れない、保険として null を取る)
   */
  cumulativeActual: {
    value: number | null;
    unit: "ミリ";
    windowMinutes: number | null;
  } | null;
  /**
   * 短期予測 (refID=2 相当)
   *
   * - windowMinutes: 実 fixture 全件で PT3H 固定。cumulative と対称に nullable とし、
   *   Duration / Name 両方失敗時は parser が raw の null をそのまま入れる
   *   (180 default invent はしない — 「異常時は正直に null を返す」)
   */
  forecastShort: {
    value: number | null;
    unit: "ミリ";
    windowMinutes: number | null;
  } | null;
  /** VXSU 必須抽出 (rainfall index trend). VXKO は null 許容. */
  trend: "上昇" | "下降" | "横ばい" | null;
  /** VXSU 必須抽出 (現流域雨量指数). VXKO は null 許容. */
  currentBasinIndex: number | null;
  rawUnit: string;
}

export interface FloodAssumptionPart {
  riverName: string | null;
  assumptionAreaName: string | null;
  assumptionAreaCode: string | null;
  attainmentTime: string | null;
  attainmentDescription: string | null;
  attainmentDubious: string | null;
  depthMinM: number | null;
  depthMaxM: number | null;
  attainmentDeepestTime: string | null;
}

export const FLOOD_LEVEL_RANK: Record<FloodLevel, number> = {
  release: 5, L1: 10, L2: 20, L3: 30, L4: 40, L5: 51, unknown: -1,
};

export const FLOOD_KIND_CODE_TO_LEVEL: Record<FloodKindCode, FloodLevel> = {
  "10": "release", "20": "L2", "21": "L2", "30": "L3", "31": "L3",
  "40": "L4", "41": "L4", "51": "L5", "53": "L5", "unknown": "unknown",
};
