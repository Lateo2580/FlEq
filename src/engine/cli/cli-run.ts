import chalk from "chalk";
import * as fs from "fs";
import {
  AppConfig,
  Classification,
} from "../../types";
import { listContracts } from "../../dmdata/rest-client";
import { startMonitor } from "../monitor/monitor";
import { setFrameWidth, setInfoFullText, setDisplayMode, setMaxObservations, setTruncation } from "../../ui/formatter";
import { loadTheme } from "../../ui/theme";
import { resolveConfig } from "../startup/config-resolver";
import * as updateChecker from "../startup/update-checker";
import * as log from "../../logger";
import { compileFilter } from "../filter";
import { compileTemplate } from "../template";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../../../package.json") as {
  version: string;
};

/** runMonitor に渡す CLI オプション */
export interface RunMonitorOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
  filter?: string[];
  template?: string;
  debug: boolean;
}

export async function runMonitor(opts: RunMonitorOptions): Promise<void> {
  // ログレベル設定
  if (opts.debug) {
    log.setLogLevel(log.LogLevel.DEBUG);
  }

  // 設定解決 (CLI引数 → 環境変数 → Configファイル → デフォルト)
  const config: AppConfig = resolveConfig(opts);

  // Banner title (契約チェック前に表示)
  console.log();
  console.log(
    chalk.cyan.bold.inverse(
      `${config.appName} v${VERSION} — Project DM-D.S.S リアルタイム地震・津波情報モニター`
    )
  );
  console.log();

  // ターミナルタイトル設定
  setTerminalTitle(`${config.appName} v${VERSION}`);

  // 契約状況チェック
  try {
    const contractedClassifications = await listContracts(config.apiKey);
    const skipped = config.classifications.filter(
      (c) => !contractedClassifications.includes(c)
    );
    const active = config.classifications.filter((c) =>
      contractedClassifications.includes(c)
    );

    for (const s of skipped) {
      log.warn(`${s} は未契約のためスキップします`);
    }

    if (active.length === 0) {
      log.error(
        "有効な契約区分がありません。dmdata.jp で区分を契約してください。"
      );
      process.exit(1);
    }

    config.classifications = active as Classification[];
  } catch (err) {
    log.warn(
      `契約状況の確認に失敗しました: ${err instanceof Error ? err.message : err}`
    );
    log.warn("指定された区分のまま接続を試みます");
  }

  // テーマ読込
  const themeWarnings = loadTheme();
  for (const w of themeWarnings) {
    log.warn(w);
  }

  // formatter キャッシュ初期化
  if (config.tableWidth != null) {
    setFrameWidth(config.tableWidth);
  }
  setInfoFullText(config.infoFullText ?? false);
  setDisplayMode(config.displayMode);
  setMaxObservations(config.maxObservations);
  setTruncation(config.truncation);

  // Filter / Template コンパイル
  const pipeline: FilterTemplatePipeline = { filter: null, template: null };

  if (opts.filter && opts.filter.length > 0) {
    try {
      const predicates = opts.filter.map((expr) => compileFilter(expr));
      pipeline.filter = (event) => predicates.every((p) => p(event));
      log.info(`フィルタ: ${opts.filter.join(" AND ")}`);
    } catch (err) {
      if (err instanceof Error) {
        log.error(`フィルタのコンパイルに失敗しました:\n${err.message}`);
      }
      process.exit(1);
    }
  }

  if (opts.template) {
    try {
      let tplSource = opts.template;
      if (tplSource.startsWith("@")) {
        const filePath = tplSource.slice(1).replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "");
        tplSource = fs.readFileSync(filePath, "utf-8").trim();
      }
      pipeline.template = compileTemplate(tplSource);
      log.info("テンプレート: カスタム");
    } catch (err) {
      if (err instanceof Error) {
        log.warn(`テンプレートのコンパイルに失敗しました:\n${err.message}`);
      }
      // template エラーは警告のみ — 通常表示にフォールバック
    }
  }

  printBanner(config);
  updateChecker.checkForUpdates("fleq", VERSION);
  await startMonitor(config, pipeline);
}

/** ターミナルタイトルを設定する (ANSI OSC sequence) */
function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]2;${title}\x07`);
  }
}

/** ターミナルタイトルをリセットする */
export function resetTerminalTitle(): void {
  if (process.stdout.isTTY) {
    // 空文字を設定するとターミナルがデフォルトタイトルに戻る
    process.stdout.write(`\x1b]2;\x07`);
  }
}

/** 起動バナー表示 */
function printBanner(config: AppConfig): void {
  log.info(`受信区分: ${config.classifications.join(", ")}`);
  log.info(`テストモード: ${config.testMode}`);
  if (config.displayMode !== "normal") {
    log.info(`表示モード: ${config.displayMode}`);
  }
  log.info("接続を開始します...");
  console.log();
}
