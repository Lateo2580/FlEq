/** フレームの優先度レベル */
export type FrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

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
  | "volcano";

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
  ashfallAreasQuick: number;
  ashfallAreasOther: number;
  ashfallPeriodsQuick: number;
  ashfallPeriodsOther: number;
  plumeWindSampleRows: number;
  tsunamiCompactForecastAreas: number;
}

/** dmdata.jp API の分類区分 */
export type Classification =
  | "telegram.earthquake" // 地震・津波関連
  | "eew.forecast" // 緊急地震速報（予報）
  | "eew.warning" // 緊急地震速報（警報）
  | "telegram.volcano"; // 火山関連

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
  /** 定期要約の間隔(分)。null = 無効 */
  summaryInterval: number | null;
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
  summaryInterval?: number;
}

/** デフォルト設定 */
export const DEFAULT_CONFIG: Omit<AppConfig, "apiKey"> = {
  classifications: ["telegram.earthquake", "eew.forecast", "eew.warning", "telegram.volcano"],
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
    ashfallAreasQuick: 5,
    ashfallAreasOther: 3,
    ashfallPeriodsQuick: 1,
    ashfallPeriodsOther: 3,
    plumeWindSampleRows: 5,
    tsunamiCompactForecastAreas: 3,
  },
};

// ── プロンプトステータス ──

/** プロンプトに表示するステータスセグメント */
export interface PromptStatusSegment {
  text: string;       // chalk 適用済みテキスト
  priority: number;   // 小さいほど左側に表示
}

/** プロンプトにステータスを提供する */
export interface PromptStatusProvider {
  getPromptStatus(): PromptStatusSegment | null;
}

/** detail コマンドの表示を提供する */
export interface DetailProvider {
  readonly category: string;       // "tsunami", "eew" 等
  readonly emptyMessage: string;   // 情報なし時のメッセージ
  hasDetail(): boolean;
  showDetail(): void;
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
  earthquake?: {
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
    /** マグニチュード */
    magnitude: string;
  };
  /** 震度情報 */
  intensity?: {
    /** 最大震度 */
    maxInt: string;
    /** 最大長周期地震動階級 */
    maxLgInt?: string;
    /** 各地の震度 (地域名 → 震度) */
    areas: { name: string; intensity: string; lgIntensity?: string }[];
  };
  /** 津波情報 */
  tsunami?: {
    /** 津波予報コメント */
    text: string;
  };
  /** テスト電文かどうか */
  isTest: boolean;
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
  earthquake?: {
    originTime: string;
    hypocenterName: string;
    latitude: string;
    longitude: string;
    depth: string;
    magnitude: string;
  };
  /** 仮定震源要素かどうか (PLUM法のみで通常震源推定不可) */
  isAssumedHypocenter: boolean;
  /** Appendix: 最大予測震度変化理由コード */
  maxIntChangeReason?: number;
  /** 予測震度 */
  forecastIntensity?: {
    /** 最大予測長周期地震動階級 */
    maxLgInt?: string;
    areas: {
      name: string;
      intensity: string;
      lgIntensity?: string;
      /** PLUM法による予測か */
      isPlum?: boolean;
      /** 既に主要動到達と推測 */
      hasArrived?: boolean;
    }[];
  };
  isTest: boolean;
  /** 警報かどうか */
  isWarning: boolean;
  /** 次回情報予告 (最終報の場合にテキストが入る) */
  nextAdvisory?: string;
}

/** 津波予報区域ごとの警報情報 */
export interface TsunamiForecastItem {
  areaName: string;
  kind: string;
  maxHeightDescription: string;
  firstHeight: string;
}

/** 沖合津波観測局情報 */
export interface TsunamiObservationStation {
  name: string;
  sensor: string;
  arrivalTime: string;
  initial: string;
  maxHeightCondition: string;
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
  earthquake?: {
    originTime: string;
    hypocenterName: string;
    latitude: string;
    longitude: string;
    depth: string;
    magnitude: string;
  };
  warningComment: string;
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
  isTest: boolean;
}

/** 長周期地震動観測地域 */
export interface LgObservationArea {
  name: string;
  maxInt: string;
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
  earthquake?: {
    originTime: string;
    hypocenterName: string;
    latitude: string;
    longitude: string;
    depth: string;
    magnitude: string;
  };
  /** 最大震度 */
  maxInt?: string;
  /** 最大長周期地震動階級 */
  maxLgInt?: string;
  /** 長周期地震動カテゴリ */
  lgCategory?: string;
  /** 地域別観測データ */
  areas: LgObservationArea[];
  /** コメント */
  comment?: string;
  /** 詳細情報URI */
  detailUri?: string;
  isTest: boolean;
}

// ── パース済み火山情報型 ──

/** 火山電文の head.type リテラル */
export type VolcanoHeadType =
  | "VZVO40" | "VFVO50" | "VFVO51" | "VFVO52" | "VFSVii"
  | "VFVO53" | "VFVO54" | "VFVO55" | "VFVO56" | "VFVO60";

/** 正規化されたアクション（パーサが XML の Condition 等から変換） */
export type VolcanoAction = "issue" | "continue" | "raise" | "lower" | "release" | "cancel";

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
  isExtraordinary: boolean;
  bodyText: string;
  nextAdvisory: string | null;
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
