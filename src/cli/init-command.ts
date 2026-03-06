import readline from "readline";
import chalk from "chalk";
import { loadConfig, saveConfig, VALID_CLASSIFICATIONS } from "../config";
import { listContracts } from "../dmdata/rest-client";
import { Classification, ConfigFile } from "../types";
import * as log from "../logger";

/** インタラクティブに初期設定を行う */
export async function runInit(): Promise<void> {
  const existingConfig = loadConfig();

  console.log();
  console.log(chalk.cyan.bold("  fleq 初期設定"));
  console.log(chalk.gray("  ─────────────────────────────"));
  console.log();

  if (existingConfig.apiKey) {
    console.log(chalk.gray("  既存の設定が見つかりました。新しい値を入力すると上書きされます。"));
    console.log(chalk.gray("  空のままEnterで既存の値を維持します。"));
    console.log();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });

  try {
    // APIキー
    const currentKeyDisplay = existingConfig.apiKey
      ? chalk.gray(` (現在: ${maskApiKey(existingConfig.apiKey)})`)
      : "";
    const apiKeyInput = await ask(`  dmdata.jp APIキー${currentKeyDisplay}: `);
    const apiKey = apiKeyInput.length > 0 ? apiKeyInput : existingConfig.apiKey;

    if (!apiKey) {
      log.error("APIキーは必須です。");
      rl.close();
      process.exit(1);
    }

    // 契約区分チェック
    console.log();
    console.log(chalk.gray("  契約状況を確認中..."));
    let contractedClassifications: string[] = [];
    try {
      contractedClassifications = await listContracts(apiKey);
      if (contractedClassifications.length > 0) {
        console.log(chalk.green("  契約済み区分:"));
        for (const c of contractedClassifications) {
          console.log(chalk.white(`    - ${c}`));
        }
      } else {
        console.log(chalk.yellow("  契約済みの区分が見つかりません。"));
      }
    } catch (err) {
      log.warn(`契約確認に失敗しました: ${err instanceof Error ? err.message : err}`);
      console.log(chalk.yellow("  APIキーの確認ができませんでした。設定は保存されます。"));
    }

    // 受信区分
    console.log();
    const defaultClassifications = contractedClassifications.length > 0
      ? contractedClassifications.filter((c) =>
          VALID_CLASSIFICATIONS.includes(c as Classification)
        ).join(",")
      : VALID_CLASSIFICATIONS.join(",");
    const classInput = await ask(
      `  受信区分 (カンマ区切り) [${chalk.gray(defaultClassifications)}]: `
    );
    const classTokens = (classInput.length > 0 ? classInput : defaultClassifications)
      .split(",")
      .map((s) => s.trim());
    const validClassifications: Classification[] = [];
    const invalidTokens: string[] = [];
    for (const token of classTokens) {
      if (VALID_CLASSIFICATIONS.includes(token as Classification)) {
        validClassifications.push(token as Classification);
      } else if (token.length > 0) {
        invalidTokens.push(token);
      }
    }
    if (invalidTokens.length > 0) {
      console.log(chalk.yellow(`  無効な区分を無視: ${invalidTokens.join(", ")}`));
    }

    // テストモード
    const currentTestMode = existingConfig.testMode ?? "no";
    const testInput = await ask(
      `  テスト電文モード (no/including/only) [${chalk.gray(currentTestMode)}]: `
    );
    const testMode = testInput.length > 0 ? testInput : currentTestMode;
    if (!["no", "including", "only"].includes(testMode)) {
      log.warn(`無効なテストモード "${testMode}" → "no" に設定します`);
    }

    // 保存
    const config: ConfigFile = {
      ...existingConfig,
      apiKey,
      classifications: validClassifications.length > 0 ? validClassifications : undefined,
      testMode: ["no", "including", "only"].includes(testMode)
        ? (testMode as "no" | "including" | "only")
        : "no",
    };

    saveConfig(config);

    console.log();
    console.log(chalk.green("  設定を保存しました。"));
    console.log(chalk.gray(`  ファイル: ${require("../config").getConfigPath()}`));
    console.log();
    console.log(chalk.white("  fleq を実行してモニタリングを開始できます。"));
    console.log();
  } finally {
    rl.close();
  }
}

/** APIキーをマスクする */
function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.substring(0, 4) + "****" + key.substring(key.length - 4);
}
