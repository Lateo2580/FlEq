import { Command } from "commander";
import {
  setConfigValue,
  unsetConfigValue,
  printConfig,
  printConfigKeys,
  getConfigPath,
  ConfigError,
} from "../config";
import * as log from "../logger";
import { runMonitor } from "./run-command";
import { runInit } from "./init-command";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../../package.json") as {
  version: string;
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("fleq")
    .description(
      "Project DM-D.S.S (dmdata.jp) の地震・津波・EEW情報をリアルタイム受信・表示するCLIツール"
    )
    .version(VERSION)
    .option(
      "-k, --api-key <key>",
      "dmdata.jp APIキー (環境変数 DMDATA_API_KEY でも指定可)"
    )
    .option(
      "-c, --classifications <items>",
      "受信区分 (カンマ区切り: telegram.earthquake,eew.forecast,eew.warning)"
    )
    .option(
      "--test <mode>",
      'テスト電文: "no" | "including" | "only"'
    )
    .option("--keep-existing", "既存のWebSocket接続を維持する")
    .option(
      "--mode <mode>",
      '表示モード: "normal" | "compact"'
    )
    .option("--debug", "デバッグログを表示", false)
    .action(runMonitor);

  // init コマンド
  program
    .command("init")
    .description("インタラクティブに初期設定を行う")
    .action(runInit);

  const configCmd = program
    .command("config")
    .description("Configファイルの設定を管理する");

  configCmd
    .command("show")
    .description("現在の設定を表示する")
    .action(() => {
      printConfig();
    });

  configCmd
    .command("set <key> <value>")
    .description("設定値をセットする")
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
    .description("設定値を削除する")
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
    .description("Configファイルのパスを表示する")
    .action(() => {
      console.log(getConfigPath());
    });

  configCmd
    .command("keys")
    .description("設定可能なキー一覧を表示する")
    .action(() => {
      printConfigKeys();
    });

  return program;
}
