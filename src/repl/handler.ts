import readline from "readline";
import chalk from "chalk";
import { AppConfig } from "../types";
import { WebSocketManager } from "../websocket/manager";
import { listEarthquakes, listContracts, listSockets } from "../api/client";
import { printConfig } from "../config/manager";
import { intensityColor } from "../display/formatter";
import * as log from "../utils/logger";

const PROMPT = "fleq> ";

interface CommandEntry {
  description: string;
  handler: (args: string) => void | Promise<void>;
}

export class ReplHandler {
  private config: AppConfig;
  private wsManager: WebSocketManager;
  private rl: readline.Interface | null = null;
  private commands: Record<string, CommandEntry>;

  constructor(config: AppConfig, wsManager: WebSocketManager) {
    this.config = config;
    this.wsManager = wsManager;

    this.commands = {
      help: {
        description: "コマンド一覧を表示",
        handler: () => this.handleHelp(),
      },
      history: {
        description: "地震履歴を取得・表示 (例: history 5)",
        handler: (args) => this.handleHistory(args),
      },
      status: {
        description: "WebSocket 接続状態を表示",
        handler: () => this.handleStatus(),
      },
      config: {
        description: "現在の設定を表示",
        handler: () => this.handleConfig(),
      },
      contract: {
        description: "契約区分一覧を表示",
        handler: () => this.handleContract(),
      },
      socket: {
        description: "接続中のソケット一覧を表示",
        handler: () => this.handleSocket(),
      },
      quit: {
        description: "アプリケーションを終了",
        handler: () => this.handleQuit(),
      },
      exit: {
        description: "アプリケーションを終了",
        handler: () => this.handleQuit(),
      },
    };
  }

  /** REPL を開始する */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.gray(PROMPT),
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        this.prompt();
        return;
      }

      const [cmd, ...rest] = trimmed.split(/\s+/);
      const args = rest.join(" ");
      const entry = this.commands[cmd];

      if (entry == null) {
        console.log(chalk.yellow(`  不明なコマンド: ${cmd} (help で一覧を表示)`));
        this.prompt();
        return;
      }

      const result = entry.handler(args);
      if (result instanceof Promise) {
        result
          .catch((err: unknown) => {
            log.error(
              `コマンド実行エラー: ${err instanceof Error ? err.message : err}`
            );
          })
          .finally(() => this.prompt());
      } else {
        this.prompt();
      }
    });

    this.rl.on("close", () => {
      this.handleQuit();
    });

    this.prompt();
  }

  /** REPL を停止する */
  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /** プロンプトを再表示する (データ出力後に呼ぶ) */
  refreshPrompt(): void {
    if (this.rl) {
      this.rl.prompt();
    }
  }

  private prompt(): void {
    if (this.rl) {
      this.rl.prompt();
    }
  }

  // ── コマンドハンドラ ──

  private handleHelp(): void {
    console.log();
    console.log(chalk.cyan.bold("  利用可能なコマンド:"));
    console.log();

    const displayed = new Set<string>();
    for (const [name, entry] of Object.entries(this.commands)) {
      // exit は quit と同じなので省略
      if (name === "exit") continue;
      if (displayed.has(entry.description)) continue;
      displayed.add(entry.description);
      console.log(
        chalk.white(`  ${name.padEnd(12)}`) + chalk.gray(entry.description)
      );
    }
    console.log(
      chalk.white(`  ${"exit".padEnd(12)}`) +
        chalk.gray("quit のエイリアス")
    );
    console.log();
  }

  private async handleHistory(args: string): Promise<void> {
    const limit = args.length > 0 ? parseInt(args, 10) : 10;
    if (isNaN(limit) || limit <= 0) {
      console.log(chalk.yellow("  件数は正の整数で指定してください"));
      return;
    }

    console.log(chalk.gray("  地震履歴を取得中..."));

    const res = await listEarthquakes(this.config.apiKey, limit);

    if (res.items.length === 0) {
      console.log(chalk.gray("  該当する地震情報はありません"));
      return;
    }

    console.log();
    for (const item of res.items) {
      const time = formatTime(item.originTime || item.arrivalTime);
      const hypo = item.hypocenter?.name || "不明";
      const mag =
        item.magnitude?.value != null ? `M${item.magnitude.value}` : "M---";
      const maxInt = item.maxInt != null ? `最大震度${item.maxInt}` : "";

      const intColor = item.maxInt != null ? intensityColor(item.maxInt) : chalk.gray;
      console.log(
        chalk.gray(`  [${time}] `) +
          chalk.white(hypo.padEnd(12)) +
          chalk.yellow(` ${mag.padEnd(6)}`) +
          intColor(` ${maxInt}`)
      );
    }
    console.log();
  }

  private handleStatus(): void {
    const status = this.wsManager.getStatus();
    console.log();
    console.log(chalk.cyan.bold("  WebSocket 接続状態:"));
    console.log(
      chalk.white("  状態: ") +
        (status.connected
          ? chalk.green.bold("接続中")
          : chalk.red.bold("切断"))
    );
    if (status.socketId != null) {
      console.log(
        chalk.white("  SocketID: ") + chalk.white(String(status.socketId))
      );
    }
    if (status.reconnectAttempt > 0) {
      console.log(
        chalk.white("  再接続試行: ") +
          chalk.yellow(`#${status.reconnectAttempt}`)
      );
    }
    console.log();
  }

  private handleConfig(): void {
    printConfig();
  }

  private async handleContract(): Promise<void> {
    console.log(chalk.gray("  契約情報を取得中..."));
    const classifications = await listContracts(this.config.apiKey);

    console.log();
    console.log(chalk.cyan.bold("  契約済み区分:"));
    if (classifications.length === 0) {
      console.log(chalk.gray("  (なし)"));
    } else {
      for (const c of classifications) {
        console.log(chalk.white(`  - ${c}`));
      }
    }
    console.log();
  }

  private async handleSocket(): Promise<void> {
    console.log(chalk.gray("  ソケット情報を取得中..."));
    const res = await listSockets(this.config.apiKey);

    console.log();
    console.log(chalk.cyan.bold("  接続中のソケット:"));
    if (res.items.length === 0) {
      console.log(chalk.gray("  (なし)"));
    } else {
      for (const s of res.items) {
        console.log(
          chalk.white(`  id=${s.id}`) +
            chalk.gray(` status=${s.status}`) +
            chalk.gray(` app=${s.appName || "---"}`) +
            chalk.gray(` start=${s.start}`)
        );
      }
    }
    console.log();
  }

  private handleQuit(): void {
    log.info("シャットダウン中...");
    this.wsManager.close();
    process.exit(0);
  }
}

/** ISO 文字列を "YYYY-MM-DD HH:mm:ss" に整形 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}


