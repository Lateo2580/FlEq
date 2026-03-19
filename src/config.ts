import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConfigFile, Classification, DisplayMode, PromptClock, NotifyCategory, EewLogField } from "./types";
import * as secretUtils from "./utils/secrets";
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

/** レガシーConfigディレクトリ (macOS/Windows でのマイグレーション用) */
const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".config", "fleq");

/**
 * OS・環境変数・ホームディレクトリからConfigディレクトリを解決する純粋関数。
 * テスト時に platform / env / homedir を差し替えられる。
 *
 * 優先順位:
 * 1. 環境変数 XDG_CONFIG_HOME (設定されている場合)
 * 2. OS 別のデフォルトパス:
 *    - macOS:   ~/Library/Application Support/fleq
 *    - Windows: %APPDATA%/fleq
 *    - Linux 等: ~/.config/fleq (XDG 標準)
 */
export function resolveConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string {
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "fleq");
  }

  switch (platform) {
    case "darwin":
      return path.join(homedir, "Library", "Application Support", "fleq");
    case "win32":
      return path.join(
        env.APPDATA || path.join(homedir, "AppData", "Roaming"),
        "fleq"
      );
    default:
      return path.join(homedir, ".config", "fleq");
  }
}

/** 現在のプロセス環境で設定ディレクトリを返す (resolveConfigDir のショートハンド) */
export function getConfigDir(): string {
  return resolveConfigDir();
}

/** Configファイルのディレクトリ */
const CONFIG_DIR = getConfigDir();

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

/**
 * 旧パスから新パスへ設定ファイルをマイグレーションする。
 *
 * 移行元の優先順位 (先にヒットした方を移行):
 * 1. ~/.config/fleq/config.json (macOS/Windows でレガシーパスに保存されていた場合)
 * 2. ~/.config/dmdata-monitor/config.json (旧アプリ名)
 */
function migrateConfigIfNeeded(): void {
  if (fs.existsSync(CONFIG_PATH)) return;

  // パス比較は正規化して行う (symlink・末尾スラッシュ・大文字小文字の差異を吸収)
  const isSamePath = (a: string, b: string): boolean =>
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  // 移行元候補 (優先順)
  const migrationSources = [
    // レガシーパス (macOS/Windows で ~/.config/fleq/ に保存されていた場合)
    ...(!isSamePath(LEGACY_CONFIG_DIR, CONFIG_DIR)
      ? [path.join(LEGACY_CONFIG_DIR, "config.json")]
      : []),
    // 旧アプリ名
    path.join(OLD_CONFIG_DIR, "config.json"),
  ];

  for (const sourcePath of migrationSources) {
    if (fs.existsSync(sourcePath)) {
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        // COPYFILE_EXCL: 既にファイルが存在する場合はエラーにして上書きを防ぐ
        fs.copyFileSync(sourcePath, CONFIG_PATH, fs.constants.COPYFILE_EXCL);
        hardenConfigPermissions(CONFIG_PATH);
        log.info(
          `設定ファイルを移行しました: ${sourcePath} → ${CONFIG_PATH}`
        );
      } catch (err) {
        // 別プロセスが先に作成した場合は成功扱い
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") return;
        if (err instanceof Error) {
          log.warn(`設定ファイルの移行に失敗しました: ${err.message}`);
        }
      }
      return;
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

/** 有効なプロンプト時計モード */
const VALID_PROMPT_CLOCKS: PromptClock[] = ["elapsed", "clock"];

/** 有効な EEW ログ記録項目 */
export const VALID_EEW_LOG_FIELDS: EewLogField[] = [
  "hypocenter",
  "originTime",
  "coordinates",
  "magnitude",
  "forecastIntensity",
  "maxLgInt",
  "forecastAreas",
  "lgIntensity",
  "isPlum",
  "hasArrived",
  "diff",
  "maxIntChangeReason",
];

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
  tableWidth: 'テーブル表示幅 (40〜200 / "auto" でターミナル幅に自動追従)',
  infoFullText: "お知らせ電文の全文表示 (true/false)",
  displayMode: '表示モード: "normal" | "compact"',
  promptClock: 'プロンプト時計: "elapsed" (経過時間) | "clock" (現在時刻)',
  waitTipIntervalMin: "待機中ヒント表示間隔 (分, 0で無効)",
  sound: "通知音の有効/無効 (true/false)",
  eewLog: "EEWログ記録の有効/無効 (true/false)",
  maxObservations: '観測点の最大表示件数 (1〜999 / "off" で全件表示)',
  backup: "EEW副回線の有効/無効 (true/false)",
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

  applyApiKey(config, raw.apiKey);
  applyClassifications(config, raw.classifications);
  applyTestMode(config, raw.testMode);
  applyAppName(config, raw.appName);
  applyReconnectDelay(config, raw.maxReconnectDelaySec);
  applyBooleanField(config, "keepExistingConnections", raw.keepExistingConnections);
  applyTableWidth(config, raw.tableWidth);
  applyBooleanField(config, "infoFullText", raw.infoFullText);
  applyDisplayMode(config, raw.displayMode);
  applyPromptClock(config, raw.promptClock);
  applyWaitTipInterval(config, raw.waitTipIntervalMin);
  applyBooleanField(config, "sound", raw.sound);
  applyBooleanField(config, "eewLog", raw.eewLog);
  applyEewLogFields(config, raw.eewLogFields);
  applyNotifySettings(config, raw.notify);
  applyMaxObservations(config, raw.maxObservations);
  applyBooleanField(config, "backup", raw.backup);

  return config;
}

function applyApiKey(config: ConfigFile, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    config.apiKey = value;
  }
}

function applyClassifications(config: ConfigFile, value: unknown): void {
  if (typeof value === "string") {
    const parsed = parseClassifications(value);
    if (parsed.length > 0) {
      config.classifications = parsed;
    }
  } else if (Array.isArray(value)) {
    const validClassifications = value.filter(
      (c): c is Classification =>
        typeof c === "string" &&
        VALID_CLASSIFICATIONS.includes(c as Classification)
    );
    if (validClassifications.length > 0) {
      config.classifications = validClassifications;
    }
  }
}

function applyTestMode(config: ConfigFile, value: unknown): void {
  if (
    typeof value === "string" &&
    (VALID_TEST_MODES as readonly string[]).includes(value)
  ) {
    config.testMode = value as ConfigFile["testMode"];
  }
}

function applyAppName(config: ConfigFile, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    config.appName = value;
  }
}

function applyReconnectDelay(config: ConfigFile, value: unknown): void {
  if (typeof value === "number" && value > 0) {
    config.maxReconnectDelaySec = value;
  }
}

function applyBooleanField(
  config: ConfigFile,
  field: "keepExistingConnections" | "infoFullText" | "sound" | "eewLog" | "backup",
  value: unknown
): void {
  if (typeof value === "boolean") {
    config[field] = value;
  }
}

function applyTableWidth(config: ConfigFile, value: unknown): void {
  if (typeof value === "number" && value >= 40 && value <= 200) {
    config.tableWidth = value;
  }
}

function applyDisplayMode(config: ConfigFile, value: unknown): void {
  if (
    typeof value === "string" &&
    (VALID_DISPLAY_MODES as readonly string[]).includes(value)
  ) {
    config.displayMode = value as DisplayMode;
  }
}

function applyPromptClock(config: ConfigFile, value: unknown): void {
  if (
    typeof value === "string" &&
    (VALID_PROMPT_CLOCKS as readonly string[]).includes(value)
  ) {
    config.promptClock = value as PromptClock;
  }
}

function applyWaitTipInterval(config: ConfigFile, value: unknown): void {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1440
  ) {
    config.waitTipIntervalMin = value;
  }
}

function applyNotifySettings(config: ConfigFile, value: unknown): void {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return;
  }
  const notifyRaw = value as Record<string, unknown>;
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

function applyMaxObservations(config: ConfigFile, value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 999) {
    config.maxObservations = value;
  }
}

function applyEewLogFields(config: ConfigFile, value: unknown): void {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return;
  }
  const raw = value as Record<string, unknown>;
  const fields: Partial<Record<EewLogField, boolean>> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (
      VALID_EEW_LOG_FIELDS.includes(key as EewLogField) &&
      typeof val === "boolean"
    ) {
      fields[key as EewLogField] = val;
    }
  }
  if (Object.keys(fields).length > 0) {
    config.eewLogFields = fields;
  }
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
      if (value === "auto") {
        delete config.tableWidth;
        break;
      }
      const tw = Number(value);
      if (isNaN(tw) || !Number.isInteger(tw) || tw < 40 || tw > 200) {
        throw new ConfigError(
          "tableWidth は 40〜200 の整数、または auto を指定してください。"
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
    case "promptClock":
      if (!(VALID_PROMPT_CLOCKS as readonly string[]).includes(value)) {
        throw new ConfigError(
          `無効なプロンプト時計: ${value}\n有効な値: ${VALID_PROMPT_CLOCKS.join(", ")}`
        );
      }
      config.promptClock = value as PromptClock;
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
    case "sound":
      if (value !== "true" && value !== "false") {
        throw new ConfigError(
          "sound は true または false を指定してください。"
        );
      }
      config.sound = value === "true";
      break;
    case "eewLog":
      if (value !== "true" && value !== "false") {
        throw new ConfigError(
          "eewLog は true または false を指定してください。"
        );
      }
      config.eewLog = value === "true";
      break;
    case "backup":
      if (value !== "true" && value !== "false") {
        throw new ConfigError(
          "backup は true または false を指定してください。"
        );
      }
      config.backup = value === "true";
      break;
    case "maxObservations": {
      if (value === "off") {
        delete config.maxObservations;
        break;
      }
      const mo = Number(value);
      if (isNaN(mo) || !Number.isInteger(mo) || mo < 1 || mo > 999) {
        throw new ConfigError(
          'maxObservations は 1〜999 の整数、または "off" を指定してください。'
        );
      }
      config.maxObservations = mo;
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
        key === "apiKey" ? secretUtils.maskApiKey(String(val)) : formatValue(val);
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

/** 値を表示用にフォーマットする */
function formatValue(val: unknown): string {
  if (Array.isArray(val)) {
    return val.join(", ");
  }
  return String(val);
}
