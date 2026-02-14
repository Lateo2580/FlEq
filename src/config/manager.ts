import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConfigFile, Classification } from "../types";
import * as log from "../utils/logger";

/** Configファイルのディレクトリ */
const CONFIG_DIR = path.join(os.homedir(), ".config", "dmdata-monitor");

/** Configファイルのパス */
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/** 有効な分類区分 */
const VALID_CLASSIFICATIONS: Classification[] = [
  "telegram.earthquake",
  "eew.forecast",
  "eew.warning",
];

/** 有効なテストモード */
const VALID_TEST_MODES = ["no", "including", "only"] as const;

/** 設定可能なキーと説明 */
const CONFIG_KEYS: Record<string, string> = {
  apiKey: "dmdata.jp APIキー",
  classifications: "受信区分 (カンマ区切り: telegram.earthquake,eew.forecast,eew.warning)",
  testMode: 'テスト電文モード: "no" | "including" | "only"',
  appName: "アプリケーション名",
  maxReconnectDelaySec: "再接続の最大待機秒数",
  keepExistingConnections: "既存のWebSocket接続を維持するか (true/false)",
};

/** Configファイルのパスを返す */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Configファイルを読み込む */
export function loadConfig(): ConfigFile {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
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

/** Configファイルに書き込む */
export function saveConfig(config: ConfigFile): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

/** 設定値を1件セットする */
export function setConfigValue(key: string, value: string): void {
  if (!(key in CONFIG_KEYS)) {
    log.error(`不明な設定キー: ${key}`);
    log.error(`有効なキー: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    process.exit(1);
  }

  const config = loadConfig();

  switch (key) {
    case "apiKey":
      config.apiKey = value;
      break;
    case "classifications": {
      const parsed = parseClassifications(value);
      if (parsed.length === 0) {
        log.error(`無効な区分: ${value}`);
        log.error(`有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`);
        process.exit(1);
      }
      config.classifications = parsed;
      break;
    }
    case "testMode":
      if (!(VALID_TEST_MODES as readonly string[]).includes(value)) {
        log.error(`無効なテストモード: ${value}`);
        log.error(`有効な値: ${VALID_TEST_MODES.join(", ")}`);
        process.exit(1);
      }
      config.testMode = value as ConfigFile["testMode"];
      break;
    case "appName":
      config.appName = value;
      break;
    case "maxReconnectDelaySec": {
      const num = Number(value);
      if (isNaN(num) || num <= 0) {
        log.error("maxReconnectDelaySec は正の数値を指定してください。");
        process.exit(1);
      }
      config.maxReconnectDelaySec = num;
      break;
    }
    case "keepExistingConnections":
      if (value !== "true" && value !== "false") {
        log.error("keepExistingConnections は true または false を指定してください。");
        process.exit(1);
      }
      config.keepExistingConnections = value === "true";
      break;
  }

  saveConfig(config);
}

/** 設定値を1件削除する */
export function unsetConfigValue(key: string): void {
  if (!(key in CONFIG_KEYS)) {
    log.error(`不明な設定キー: ${key}`);
    log.error(`有効なキー: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    process.exit(1);
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
