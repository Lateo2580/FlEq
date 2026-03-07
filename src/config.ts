import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConfigFile, Classification, DisplayMode, NotifyCategory } from "./types";
import * as log from "./logger";

/** 設定エラー */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 旧Configファイルのディレクトリ (マイグレーション用) */
const OLD_CONFIG_DIR = path.join(os.homedir(), ".config", "dmdata-monitor");

/** Configファイルのディレクトリ */
const CONFIG_DIR = path.join(os.homedir(), ".config", "fleq");

/** Configファイルのパス */
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/** Configファイルの権限を可能な範囲で 0600 に寄せる */
function hardenConfigPermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    if (err instanceof Error) {
      log.warn(`Configファイル権限の調整に失敗しました: ${err.message}`);
    }
  }
}

/** 旧パスから新パスへ設定ファイルをマイグレーションする */
function migrateConfigIfNeeded(): void {
  const oldConfigPath = path.join(OLD_CONFIG_DIR, "config.json");
  if (fs.existsSync(oldConfigPath) && !fs.existsSync(CONFIG_PATH)) {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }
      fs.copyFileSync(oldConfigPath, CONFIG_PATH);
      hardenConfigPermissions(CONFIG_PATH);
      log.info(
        `設定ファイルを移行しました: ${oldConfigPath} → ${CONFIG_PATH}`
      );
    } catch (err) {
      if (err instanceof Error) {
        log.warn(`設定ファイルの移行に失敗しました: ${err.message}`);
      }
    }
  }
}

/** 有効な分類区分 */
export const VALID_CLASSIFICATIONS: Classification[] = [
  "telegram.earthquake",
  "eew.forecast",
  "eew.warning",
];

/** 有効なテストモード */
const VALID_TEST_MODES = ["no", "including", "only"] as const;

/** 有効な表示モード */
const VALID_DISPLAY_MODES: DisplayMode[] = ["normal", "compact"];

/** 有効な通知カテゴリ */
const VALID_NOTIFY_CATEGORIES: NotifyCategory[] = [
  "eew",
  "earthquake",
  "tsunami",
  "seismicText",
  "nankaiTrough",
  "lgObservation",
];

/** 設定可能なキーと説明 */
const CONFIG_KEYS: Record<string, string> = {
  apiKey: "dmdata.jp APIキー",
  classifications: "受信区分 (カンマ区切り: telegram.earthquake,eew.forecast,eew.warning)",
  testMode: 'テスト電文モード: "no" | "including" | "only"',
  appName: "アプリケーション名",
  maxReconnectDelaySec: "再接続の最大待機秒数",
  keepExistingConnections: "既存のWebSocket接続を維持するか (true/false)",
  tableWidth: "テーブル表示幅 (40〜200)",
  infoFullText: "お知らせ電文の全文表示 (true/false)",
  displayMode: '表示モード: "normal" | "compact"',
  waitTipIntervalMin: "待機中ヒント表示間隔 (分, 0で無効)",
};

/** Configファイルのパスを返す */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Configファイルを読み込む */
export function loadConfig(): ConfigFile {
  migrateConfigIfNeeded();
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    hardenConfigPermissions(CONFIG_PATH);
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      log.warn("Configファイルの形式が不正です。無視します。");
      return {};
    }
    return validateConfig(parsed as Record<string, unknown>);
  } catch (err) {
    if (err instanceof SyntaxError) {
      log.warn("ConfigファイルのJSONパースに失敗しました。無視します。");
    } else if (err instanceof Error) {
      log.warn(`Configファイルの読み込みに失敗しました: ${err.message}`);
    }
    return {};
  }
}

/** Configファイルに書き込む (APIキーを含むため 0600 で保存) */
export function saveConfig(config: ConfigFile): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  hardenConfigPermissions(CONFIG_PATH);
}

/** パースした値をバリデーションして ConfigFile にする */
function validateConfig(raw: Record<string, unknown>): ConfigFile {
  const config: ConfigFile = {};

  if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
    config.apiKey = raw.apiKey;
  }

  if (typeof raw.classifications === "string") {
    const parsed = parseClassifications(raw.classifications);
    if (parsed.length > 0) {
      config.classifications = parsed;
    }
  } else if (Array.isArray(raw.classifications)) {
    const valid = raw.classifications.filter(
      (c): c is Classification =>
        typeof c === "string" &&
        VALID_CLASSIFICATIONS.includes(c as Classification)
    );
    if (valid.length > 0) {
      config.classifications = valid;
    }
  }

  if (
    typeof raw.testMode === "string" &&
    (VALID_TEST_MODES as readonly string[]).includes(raw.testMode)
  ) {
    config.testMode = raw.testMode as ConfigFile["testMode"];
  }

  if (typeof raw.appName === "string" && raw.appName.length > 0) {
    config.appName = raw.appName;
  }

  if (typeof raw.maxReconnectDelaySec === "number" && raw.maxReconnectDelaySec > 0) {
    config.maxReconnectDelaySec = raw.maxReconnectDelaySec;
  }

  if (typeof raw.keepExistingConnections === "boolean") {
    config.keepExistingConnections = raw.keepExistingConnections;
  }

  if (typeof raw.tableWidth === "number" && raw.tableWidth >= 40 && raw.tableWidth <= 200) {
    config.tableWidth = raw.tableWidth;
  }

  if (typeof raw.infoFullText === "boolean") {
    config.infoFullText = raw.infoFullText;
  }

  if (
    typeof raw.displayMode === "string" &&
    (VALID_DISPLAY_MODES as readonly string[]).includes(raw.displayMode)
  ) {
    config.displayMode = raw.displayMode as DisplayMode;
  }

  if (
    typeof raw.waitTipIntervalMin === "number" &&
    Number.isInteger(raw.waitTipIntervalMin) &&
    raw.waitTipIntervalMin >= 0 &&
    raw.waitTipIntervalMin <= 1440
  ) {
    config.waitTipIntervalMin = raw.waitTipIntervalMin;
  }

  if (typeof raw.notify === "object" && raw.notify != null && !Array.isArray(raw.notify)) {
    const notifyRaw = raw.notify as Record<string, unknown>;
    const notify: Partial<Record<NotifyCategory, boolean>> = {};
    for (const [key, val] of Object.entries(notifyRaw)) {
      if (
        VALID_NOTIFY_CATEGORIES.includes(key as NotifyCategory) &&
        typeof val === "boolean"
      ) {
        notify[key as NotifyCategory] = val;
      }
    }
    if (Object.keys(notify).length > 0) {
      config.notify = notify;
    }
  }

  return config;
}

/** カンマ区切りの分類区分文字列をパースする */
function parseClassifications(input: string): Classification[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Classification =>
      VALID_CLASSIFICATIONS.includes(s as Classification)
    );
}

/** 設定値を1件セットする。無効な入力の場合は ConfigError をスローする。 */
export function setConfigValue(key: string, value: string): void {
  if (!(key in CONFIG_KEYS)) {
    throw new ConfigError(
      `不明な設定キー: ${key}\n有効なキー: ${Object.keys(CONFIG_KEYS).join(", ")}`
    );
  }

  const config = loadConfig();

  switch (key) {
    case "apiKey":
      config.apiKey = value;
      break;
    case "classifications": {
      const parsed = parseClassifications(value);
      if (parsed.length === 0) {
        throw new ConfigError(
          `無効な区分: ${value}\n有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`
        );
      }
      config.classifications = parsed;
      break;
    }
    case "testMode":
      if (!(VALID_TEST_MODES as readonly string[]).includes(value)) {
        throw new ConfigError(
          `無効なテストモード: ${value}\n有効な値: ${VALID_TEST_MODES.join(", ")}`
        );
      }
      config.testMode = value as ConfigFile["testMode"];
      break;
    case "appName":
      config.appName = value;
      break;
    case "maxReconnectDelaySec": {
      const num = Number(value);
      if (isNaN(num) || num <= 0) {
        throw new ConfigError(
          "maxReconnectDelaySec は正の数値を指定してください。"
        );
      }
      config.maxReconnectDelaySec = num;
      break;
    }
    case "keepExistingConnections":
      if (value !== "true" && value !== "false") {
        throw new ConfigError(
          "keepExistingConnections は true または false を指定してください。"
        );
      }
      config.keepExistingConnections = value === "true";
      break;
    case "tableWidth": {
      const tw = Number(value);
      if (isNaN(tw) || !Number.isInteger(tw) || tw < 40 || tw > 200) {
        throw new ConfigError(
          "tableWidth は 40〜200 の整数を指定してください。"
        );
      }
      config.tableWidth = tw;
      break;
    }
    case "infoFullText":
      if (value !== "true" && value !== "false") {
        throw new ConfigError(
          "infoFullText は true または false を指定してください。"
        );
      }
      config.infoFullText = value === "true";
      break;
    case "displayMode":
      if (!(VALID_DISPLAY_MODES as readonly string[]).includes(value)) {
        throw new ConfigError(
          `無効な表示モード: ${value}\n有効な値: ${VALID_DISPLAY_MODES.join(", ")}`
        );
      }
      config.displayMode = value as DisplayMode;
      break;
    case "waitTipIntervalMin": {
      const min = Number(value);
      if (isNaN(min) || !Number.isInteger(min) || min < 0 || min > 1440) {
        throw new ConfigError(
          "waitTipIntervalMin は 0〜1440 の整数を指定してください。"
        );
      }
      config.waitTipIntervalMin = min;
      break;
    }
  }

  saveConfig(config);
}

/** 設定値を1件削除する。無効なキーの場合は ConfigError をスローする。 */
export function unsetConfigValue(key: string): void {
  if (!(key in CONFIG_KEYS)) {
    throw new ConfigError(
      `不明な設定キー: ${key}\n有効なキー: ${Object.keys(CONFIG_KEYS).join(", ")}`
    );
  }

  const config = loadConfig();
  delete config[key as keyof ConfigFile];
  saveConfig(config);
}

/** 現在の設定を整形して表示する */
export function printConfig(): void {
  const config = loadConfig();
  const configPath = getConfigPath();

  console.log();
  console.log(`  Config: ${configPath}`);
  console.log();

  if (Object.keys(config).length === 0) {
    console.log("  (設定なし)");
    console.log();
    return;
  }

  for (const [key, description] of Object.entries(CONFIG_KEYS)) {
    const val = config[key as keyof ConfigFile];
    if (val !== undefined) {
      const displayValue =
        key === "apiKey" ? maskApiKey(String(val)) : formatValue(val);
      console.log(`  ${key} = ${displayValue}`);
      console.log(`    # ${description}`);
    }
  }
  console.log();
}

/** 設定可能なキー一覧を表示する */
export function printConfigKeys(): void {
  console.log();
  console.log("  設定可能なキー:");
  console.log();
  for (const [key, description] of Object.entries(CONFIG_KEYS)) {
    console.log(`  ${key}`);
    console.log(`    ${description}`);
  }
  console.log();
}

/** APIキーをマスクする */
function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "****";
  }
  return key.substring(0, 4) + "****" + key.substring(key.length - 4);
}

/** 値を表示用にフォーマットする */
function formatValue(val: unknown): string {
  if (Array.isArray(val)) {
    return val.join(", ");
  }
  return String(val);
}
