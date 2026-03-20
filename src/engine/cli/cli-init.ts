import readline from "readline";
import chalk from "chalk";
import { loadConfig, saveConfig, VALID_CLASSIFICATIONS, getConfigPath } from "../../config";
import { listContracts } from "../../dmdata/rest-client";
import { Classification, ConfigFile } from "../../types";
import * as secretUtils from "../../utils/secrets";
import * as log from "../../logger";

/** 区分選択肢メタデータ */
const CLASSIFICATION_OPTIONS: ReadonlyArray<{
  value: Classification;
  label: string;
  description: string;
}> = [
  {
    value: "telegram.earthquake",
    label: "地震・津波関連",
    description: "地震情報、津波情報、震源・震度情報など",
  },
  {
    value: "eew.forecast",
    label: "緊急地震速報（予報）",
    description: "予報レベルのEEWを受信します",
  },
  {
    value: "eew.warning",
    label: "緊急地震速報（警報）",
    description: "警報レベルのEEWを受信します",
  },
  {
    value: "telegram.volcano",
    label: "火山関連",
    description: "噴火警報、噴火速報、降灰予報、火山の状況に関する解説情報など",
  },
];

/** テストモード選択肢メタデータ */
const TEST_MODE_OPTIONS: ReadonlyArray<{
  value: "no" | "including" | "only";
  label: string;
  description: string;
}> = [
  {
    value: "no",
    label: "受信しない",
    description: "通常運用向け。テスト電文は無視します",
  },
  {
    value: "including",
    label: "通常電文 + テスト電文",
    description: "動作確認したいとき向けです",
  },
  {
    value: "only",
    label: "テスト電文のみ",
    description: "本番電文を混ぜずに検証したいとき向けです",
  },
];

/** readline を使ったテキスト入力ヘルパー */
function askText(
  rl: readline.Interface,
  prompt: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

/** Y/n 確認ヘルパー (デフォルト Yes) */
async function askConfirm(
  rl: readline.Interface,
  prompt: string
): Promise<boolean> {
  const answer = await askText(rl, prompt);
  if (answer === "") return true;
  return answer.toLowerCase().startsWith("y");
}

/** 番号選択ヘルパー (単一選択、1-indexed) */
async function askSingleChoice<T extends string>(
  rl: readline.Interface,
  options: ReadonlyArray<{ value: T; label: string; description: string }>,
  defaultValue: T
): Promise<T> {
  const defaultIdx = options.findIndex((o) => o.value === defaultValue);
  const defaultNum = defaultIdx >= 0 ? defaultIdx + 1 : 1;

  const input = await askText(rl, `  選択 [${chalk.gray(String(defaultNum))}]: `);

  if (input === "") {
    return options[defaultNum - 1].value;
  }

  const num = parseInt(input, 10);
  if (isNaN(num) || num < 1 || num > options.length) {
    console.log(chalk.yellow(`  → 無効な入力です。既定値を使用します。`));
    return options[defaultNum - 1].value;
  }

  return options[num - 1].value;
}

/** 番号選択ヘルパー (複数選択、スペース区切り、1-indexed) */
async function askMultiChoice(
  rl: readline.Interface,
  options: ReadonlyArray<{ value: Classification; label: string; description: string }>,
  defaultValues: Classification[]
): Promise<Classification[]> {
  const defaultNums = defaultValues
    .map((v) => options.findIndex((o) => o.value === v) + 1)
    .filter((n) => n > 0);
  const defaultDisplay = defaultNums.join(" ");

  const input = await askText(rl, `  選択 [${chalk.gray(defaultDisplay)}]: `);

  if (input === "") {
    return defaultValues.length > 0 ? defaultValues : options.map((o) => o.value);
  }

  const nums = input
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= options.length);

  if (nums.length === 0) {
    console.log(chalk.yellow(`  → 無効な入力です。既定値を使用します。`));
    return defaultValues.length > 0 ? defaultValues : options.map((o) => o.value);
  }

  return [...new Set(nums)].sort((a, b) => a - b).map((n) => options[n - 1].value);
}

/** 区分の表示用ラベルを取得 */
function classificationLabel(value: string): string {
  const found = CLASSIFICATION_OPTIONS.find((o) => o.value === value);
  return found ? found.label : value;
}

/** テストモードの表示用ラベルを取得 */
function testModeLabel(value: string): string {
  const found = TEST_MODE_OPTIONS.find((o) => o.value === value);
  return found ? found.label : value;
}

/** インタラクティブに初期設定を行う */
export async function runInit(): Promise<void> {
  const existingConfig = loadConfig();

  console.log();
  console.log(chalk.cyan.bold("  fleq 初期設定"));
  console.log(chalk.gray("  ─────────────────────────────"));
  console.log(chalk.gray("  dmdata.jp のAPIキーと受信設定を行います。"));
  console.log(chalk.gray("  Enter で既定値を採用します。"));
  console.log();

  if (existingConfig.apiKey) {
    console.log(chalk.gray("  既存の設定が見つかりました。空のままEnterで既存の値を維持します。"));
    console.log();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ── [1/4] APIキー ──
    console.log(chalk.white.bold("  [1/4] dmdata.jp APIキー"));
    console.log(chalk.gray("  取得先: https://manager.dmdata.jp/control/apikey"));
    console.log(chalk.gray("  ヒント: マイページの「APIキー」から発行・確認できます"));
    if (existingConfig.apiKey) {
      console.log(chalk.gray(`  現在: ${secretUtils.maskApiKey(existingConfig.apiKey)}`));
    }
    console.log();

    const apiKeyInput = await askText(rl, "  APIキー: ");
    const apiKey = apiKeyInput.length > 0 ? apiKeyInput : existingConfig.apiKey;

    if (!apiKey) {
      log.error("APIキーは必須です。");
      rl.close();
      process.exit(1);
    }

    // ── [2/4] 契約確認 ──
    console.log();
    console.log(chalk.white.bold("  [2/4] 契約確認"));
    console.log(chalk.gray("  契約状況を確認中..."));

    let contractedClassifications: string[] = [];
    try {
      contractedClassifications = await listContracts(apiKey);
      if (contractedClassifications.length > 0) {
        const labels = contractedClassifications.map((c) => classificationLabel(c));
        console.log(chalk.green(`  契約済み: ${labels.join(", ")}`));
      } else {
        console.log(chalk.yellow("  契約済みの区分が見つかりません。"));
      }
    } catch (err) {
      log.warn(`契約確認に失敗しました: ${err instanceof Error ? err.message : err}`);
      console.log(chalk.yellow("  APIキーの確認ができませんでした。既定値を使用します。"));
    }

    // ── [3/4] 受信区分 ──
    console.log();
    console.log(chalk.white.bold("  [3/4] 受信区分"));
    console.log(chalk.gray("  受信したい情報を選んでください。"));
    console.log(chalk.gray("  番号をスペース区切りで入力します。Enter で既定値を採用します。"));
    console.log();

    // デフォルト値: 既存config → 契約済み区分 → 全区分
    const defaultClassifications: Classification[] =
      existingConfig.classifications != null && existingConfig.classifications.length > 0
        ? existingConfig.classifications
        : contractedClassifications.filter((c): c is Classification =>
            VALID_CLASSIFICATIONS.includes(c as Classification)
          ).length > 0
          ? contractedClassifications.filter((c): c is Classification =>
              VALID_CLASSIFICATIONS.includes(c as Classification)
            )
          : [...VALID_CLASSIFICATIONS];

    // 選択肢表示
    for (let i = 0; i < CLASSIFICATION_OPTIONS.length; i++) {
      const opt = CLASSIFICATION_OPTIONS[i];
      const isDefault = defaultClassifications.includes(opt.value);
      const checkbox = isDefault ? chalk.green("[x]") : chalk.gray("[ ]");
      console.log(`  ${checkbox} ${chalk.white(`${i + 1}. ${opt.label}`)}`);
      console.log(chalk.gray(`      ${opt.description}`));
    }
    console.log();

    const selectedClassifications = await askMultiChoice(
      rl,
      CLASSIFICATION_OPTIONS,
      defaultClassifications
    );

    // ── [4/4] テストモード ──
    console.log();
    console.log(chalk.white.bold("  [4/4] テスト電文"));
    console.log(chalk.gray("  テスト配信をどう扱うか選んでください。"));
    console.log();

    const currentTestMode = existingConfig.testMode ?? "no";
    for (let i = 0; i < TEST_MODE_OPTIONS.length; i++) {
      const opt = TEST_MODE_OPTIONS[i];
      const marker = opt.value === currentTestMode ? chalk.green("→") : " ";
      console.log(`  ${marker} ${chalk.white(`${i + 1}. ${opt.label}`)}`);
      console.log(chalk.gray(`     ${opt.description}`));
    }
    console.log();

    const selectedTestMode = await askSingleChoice(rl, TEST_MODE_OPTIONS, currentTestMode);

    // ── 確認 ──
    console.log();
    console.log(chalk.white.bold("  設定内容"));
    console.log(chalk.gray("  ─────────────────────────────"));
    console.log(`  APIキー:   ${chalk.white(secretUtils.maskApiKey(apiKey))}`);
    console.log(
      `  受信区分:  ${chalk.white(selectedClassifications.map((c) => classificationLabel(c)).join(", "))}`
    );
    console.log(`  テスト電文: ${chalk.white(testModeLabel(selectedTestMode))}`);
    console.log();

    const confirmed = await askConfirm(rl, `  この内容で保存しますか? [${chalk.white("Y")}/n]: `);

    if (!confirmed) {
      console.log();
      console.log(chalk.yellow("  設定を保存せずに終了します。"));
      console.log();
      return;
    }

    // ── 保存 ──
    const config: ConfigFile = {
      ...existingConfig,
      apiKey,
      classifications: selectedClassifications,
      testMode: selectedTestMode,
    };

    saveConfig(config);

    console.log();
    console.log(chalk.green("  設定を保存しました。"));
    console.log(chalk.gray(`  ファイル: ${getConfigPath()}`));
    console.log();
    console.log(chalk.white("  fleq を実行してモニタリングを開始できます。"));
    console.log();
  } finally {
    rl.close();
  }
}

