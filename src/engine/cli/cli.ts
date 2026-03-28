import { Command } from "commander";
import {
  setConfigValue,
  unsetConfigValue,
  printConfig,
  printConfigKeys,
  getConfigPath,
  ConfigError,
} from "../../config";
import * as log from "../../logger";
import type { RunMonitorOptions } from "./cli-run";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../../../package.json") as {
  version: string;
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("fleq")
    .description(
      "Project DM-D.S.S (dmdata.jp) の地震・津波・EEW情報をリアルタイムで受信・表示するCLIツールです"
    )
    .version(VERSION)
    .option(
      "-k, --api-key <key>",
      "dmdata.jp APIキーを指定します（環境変数 DMDATA_API_KEY でも指定できます）"
    )
    .option(
      "-c, --classifications <items>",
      "受信区分を指定します（カンマ区切り: telegram.earthquake,eew.forecast,eew.warning,telegram.volcano）"
    )
    .option(
      "--test <mode>",
      'テスト電文の扱いを指定します: "no" | "including" | "only"'
    )
    .option(
      "--keep-existing",
      "既存のWebSocket接続を維持します（互換オプション。現在はこちらがデフォルトです）"
    )
    .option(
      "--close-others",
      "同一APIキーの既存 open socket を閉じてから接続します"
    )
    .option(
      "--mode <mode>",
      '表示モードを指定します: "normal" | "compact"'
    )
    .option(
      "--filter <expr>",
      "条件式で電文を絞り込みます (複数指定で AND 結合)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      "--template <template>",
      "電文の1行要約テンプレートを指定します (@ でファイル読込)",
    )
    .option(
      "--focus <expr>",
      "条件に一致しない電文を dim 表示に落とします",
    )
    .option("--summary-interval [minutes]", "N分ごとに受信要約を表示 (デフォルト10分)", (val: string | undefined) => {
      if (val === undefined || val === "true") return 10;
      const n = parseInt(val, 10);
      return Number.isFinite(n) && n > 0 ? n : 10;
    })
    .option("--night", "ナイトモードを有効にします")
    .option("--debug", "デバッグログを表示します", false)
    .action(async (opts: RunMonitorOptions) => {
      const { runMonitor } = await import("./cli-run");
      return runMonitor(opts);
    });

  // init コマンド
  program
    .command("init")
    .description("インタラクティブに初期設定を行います")
    .action(async () => {
      const { runInit } = await import("./cli-init");
      return runInit();
    });

  const configCmd = program
    .command("config")
    .description("Configファイルの設定を管理します");

  configCmd
    .command("show")
    .description("現在の設定を表示します")
    .action(() => {
      printConfig();
    });

  configCmd
    .command("set <key> <value>")
    .description("設定値を保存します")
    .action((key: string, value: string) => {
      try {
        setConfigValue(key, value);
        log.info(`設定しました: ${key}`);
      } catch (err) {
        if (err instanceof ConfigError) {
          log.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  configCmd
    .command("unset <key>")
    .description("設定値を削除します")
    .action((key: string) => {
      try {
        unsetConfigValue(key);
        log.info(`削除しました: ${key}`);
      } catch (err) {
        if (err instanceof ConfigError) {
          log.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  configCmd
    .command("path")
    .description("Configファイルのパスを表示します")
    .action(() => {
      console.log(getConfigPath());
    });

  configCmd
    .command("keys")
    .description("設定可能なキー一覧を表示します")
    .action(() => {
      printConfigKeys();
    });

  return program;
}
