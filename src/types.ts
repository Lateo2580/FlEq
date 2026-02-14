/** dmdata.jp API の分類区分 */
export type Classification =
  | "telegram.earthquake" // 地震・津波関連
  | "eew.forecast" // 緊急地震速報（予報）
  | "eew.warning"; // 緊急地震速報（警報）

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
  /** 既存接続を維持するか */
  keepExistingConnections: boolean;
}

/** Configファイルの設定 (全フィールド任意) */
export interface ConfigFile {
  apiKey?: string;
  classifications?: Classification[];
  testMode?: "no" | "including" | "only";
  appName?: string;
  maxReconnectDelaySec?: number;
  keepExistingConnections?: boolean;
}

/** デフォルト設定 */
export const DEFAULT_CONFIG: Omit<AppConfig, "apiKey"> = {
  classifications: ["telegram.earthquake"],
  testMode: "no",
  appName: "dmdata-monitor",
  maxReconnectDelaySec: 60,
  keepExistingConnections: false,
};

// ── dmdata.jp API レスポンス型 ──

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
    /** 各地の震度 (地域名 → 震度) */
    areas: { name: string; intensity: string }[];
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
  /** 予測震度 */
  forecastIntensity?: {
    areas: { name: string; intensity: string }[];
  };
  isTest: boolean;
  /** 警報かどうか */
  isWarning: boolean;
}
