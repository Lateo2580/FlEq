import chalk from "chalk";
import {
  AppConfig,
  Classification,
  ConfigFile,
  DEFAULT_CONFIG,
} from "../../types";
import {
  loadConfig,
  getConfigPath,
  VALID_CLASSIFICATIONS,
} from "../../config";
import * as log from "../../logger";

/** CLI オプションのうち設定解決に必要なフィールド */
export interface ResolverOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
}

/**
 * CLI引数 → 環境変数 → .env → Configファイル → デフォルト値 の優先順位で設定を解決する。
 * 致命的なバリデーションエラー時は process.exit(1) する。
 */
export function resolveConfig(opts: ResolverOptions): AppConfig {
  // Configファイル読み込み
  const fileConfig: ConfigFile = loadConfig();
  log.debug(`Config: ${getConfigPath()}`);

  // APIキー (CLI > 環境変数 > Configファイル)
  const apiKey = opts.apiKey || process.env.DMDATA_API_KEY || fileConfig.apiKey;
  if (!apiKey) {
    log.error("APIキーが指定されていません。");
    console.log();
    console.log(chalk.white("  以下のいずれかの方法で設定してください:"));
    console.log(chalk.gray("    1. ") + chalk.white("fleq init") + chalk.gray("           — インタラクティブセットアップ"));
    console.log(chalk.gray("    2. ") + chalk.white("fleq config set apiKey <key>") + chalk.gray(" — 直接設定"));
    console.log(chalk.gray("    3. ") + chalk.white("fleq --api-key <key>") + chalk.gray("         — CLI引数で指定"));
    console.log(chalk.gray("    4. ") + chalk.white("DMDATA_API_KEY=<key>") + chalk.gray("         — 環境変数で指定"));
    console.log();
    process.exit(1);
  }

  // 分類区分の解析 (CLI > Configファイル > デフォルト)
  let classifications: Classification[];
  if (opts.classifications != null) {
    const allTokens = opts.classifications.split(",").map((s) => s.trim());
    const valid: Classification[] = [];
    const invalid: string[] = [];
    for (const token of allTokens) {
      if (VALID_CLASSIFICATIONS.includes(token as Classification)) {
        valid.push(token as Classification);
      } else if (token.length > 0) {
        invalid.push(token);
      }
    }
    if (invalid.length > 0) {
      log.warn(`無効な区分を無視しました: ${invalid.join(", ")}`);
      log.warn(`有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`);
    }
    classifications = valid;
  } else if (fileConfig.classifications != null) {
    classifications = fileConfig.classifications;
    // v1.48 で追加された telegram.volcano が含まれていない場合、案内を表示
    if (!classifications.includes("telegram.volcano")) {
      log.info(
        "火山情報の受信には telegram.volcano の追加が必要です: " +
        chalk.white("fleq config set classifications " + [...classifications, "telegram.volcano"].join(","))
      );
    }
  } else {
    classifications = DEFAULT_CONFIG.classifications;
  }

  if (classifications.length === 0) {
    log.error(`有効な区分が指定されていません。`);
    log.error(`有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`);
    process.exit(1);
  }

  // テストモード (CLI > Configファイル > デフォルト)
  const testMode: "no" | "including" | "only" =
    opts.test != null
      ? (opts.test as "no" | "including" | "only")
      : fileConfig.testMode ?? DEFAULT_CONFIG.testMode;

  if (!["no", "including", "only"].includes(testMode)) {
    log.error(`無効なテストモード: ${testMode} (有効な値: no, including, only)`);
    process.exit(1);
  }

  // 表示モード (CLI > Configファイル > デフォルト)
  const displayModeRaw = opts.mode ?? fileConfig.displayMode ?? DEFAULT_CONFIG.displayMode;
  if (displayModeRaw !== "normal" && displayModeRaw !== "compact") {
    log.error(`無効な表示モード: ${displayModeRaw} (有効な値: normal, compact)`);
    process.exit(1);
  }

  return {
    apiKey,
    classifications,
    testMode,
    appName: fileConfig.appName ?? DEFAULT_CONFIG.appName,
    maxReconnectDelaySec:
      fileConfig.maxReconnectDelaySec ?? DEFAULT_CONFIG.maxReconnectDelaySec,
    keepExistingConnections:
      opts.closeOthers === true
        ? false
        : (
            opts.keepExisting ??
            fileConfig.keepExistingConnections ??
            DEFAULT_CONFIG.keepExistingConnections
          ),
    tableWidth: fileConfig.tableWidth ?? null,
    infoFullText: fileConfig.infoFullText ?? DEFAULT_CONFIG.infoFullText,
    displayMode: displayModeRaw,
    promptClock: fileConfig.promptClock ?? DEFAULT_CONFIG.promptClock,
    waitTipIntervalMin: fileConfig.waitTipIntervalMin ?? DEFAULT_CONFIG.waitTipIntervalMin,
    notify: { ...DEFAULT_CONFIG.notify, ...fileConfig.notify },
    sound: fileConfig.sound ?? DEFAULT_CONFIG.sound,
    eewLog: fileConfig.eewLog ?? DEFAULT_CONFIG.eewLog,
    eewLogFields: { ...DEFAULT_CONFIG.eewLogFields, ...fileConfig.eewLogFields },
    maxObservations: fileConfig.maxObservations ?? DEFAULT_CONFIG.maxObservations,
    nightMode: fileConfig.nightMode ?? DEFAULT_CONFIG.nightMode,
    backup: fileConfig.backup ?? DEFAULT_CONFIG.backup,
    truncation: { ...DEFAULT_CONFIG.truncation, ...fileConfig.truncation },
  };
}
