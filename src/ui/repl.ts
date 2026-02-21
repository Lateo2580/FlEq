import readline from "readline";
import chalk from "chalk";
import { AppConfig } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { listEarthquakes, listContracts, listSockets } from "../dmdata/rest-client";
import { printConfig } from "../config";
import {
  formatElapsedTime,
  intensityColor,
  visualPadEnd,
  visualWidth,
} from "../ui/formatter";
import * as log from "../logger";

interface CommandEntry {
  description: string;
  handler: (args: string) => void | Promise<void>;
}

class StatusLine {
  private pulseOn = true;
  private connectedAt: number | null = null;
  private lastMessageTime: number | null = null;

  tick(): void {
    this.pulseOn = !this.pulseOn;
  }

  setConnected(connected: boolean): void {
    if (connected) {
      this.connectedAt = Date.now();
      this.lastMessageTime = null;
    } else {
      this.connectedAt = null;
      this.lastMessageTime = null;
    }
  }

  markMessageReceived(): void {
    this.lastMessageTime = Date.now();
  }

  buildPrefix(): string {
    if (this.connectedAt == null) {
      return (
        chalk.gray("fleq [") + chalk.gray("○ --:--:--") + chalk.gray("]> ")
      );
    }
    const dot = this.pulseOn ? chalk.cyan("●") : chalk.gray("○");
    const baseTime = this.lastMessageTime ?? this.connectedAt;
    const elapsed = formatElapsedTime(Date.now() - baseTime);
    return (
      chalk.gray("fleq [") +
      dot +
      chalk.gray(" ") +
      chalk.white(elapsed) +
      chalk.gray("]> ")
    );
  }
}

export class ReplHandler {
  private config: AppConfig;
  private wsManager: WebSocketManager;
  private rl: readline.Interface | null = null;
  private commands: Record<string, CommandEntry>;
  private stopping = false;
  private statusLine: StatusLine;
  private statusTimer: NodeJS.Timeout | null = null;
  private commandRunning = false;

  constructor(config: AppConfig, wsManager: WebSocketManager) {
    this.config = config;
    this.wsManager = wsManager;
    this.statusLine = new StatusLine();

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
      prompt: this.buildPromptString(),
    });

    if (process.stdout.isTTY) {
      this.statusTimer = setInterval(() => {
        this.statusLine.tick();
        if (!this.commandRunning && this.rl && this.rl.line.length === 0) {
          this.rl.setPrompt(this.buildPromptString());
          this.rl.prompt();
        }
      }, 1000);
    }

    this.rl.on("line", (line) => {
      this.commandRunning = true;
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        this.commandRunning = false;
        this.prompt();
        return;
      }

      const [cmd, ...rest] = trimmed.split(/\s+/);
      const args = rest.join(" ");
      const entry = this.commands[cmd];

      if (entry == null) {
        console.log(chalk.yellow(`  不明なコマンド: ${cmd} (help で一覧を表示)`));
        this.commandRunning = false;
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
          .finally(() => {
            this.commandRunning = false;
            this.prompt();
          });
      } else {
        this.commandRunning = false;
        this.prompt();
      }
    });

    this.rl.on("close", () => {
      if (!this.stopping) {
        this.handleQuit();
      }
    });

    this.prompt();
  }

  /** REPL を停止する */
  stop(): void {
    this.stopping = true;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /** プロンプトを再表示する (データ出力後・接続状態変化時に呼ぶ) */
  refreshPrompt(): void {
    if (this.rl && !this.commandRunning) {
      this.prompt();
    }
  }

  /** WebSocket 接続状態をプロンプトに反映 */
  setConnected(connected: boolean): void {
    this.statusLine.setConnected(connected);
    // 接続状態が変わった瞬間にプロンプト文字列を更新しておく
    // (実際の再描画は呼び出し元の refreshPrompt() で行う)
    if (this.rl) {
      this.rl.setPrompt(this.buildPromptString());
    }
  }

  /** 電文表示の前処理（現在のプロンプト行をクリア） */
  beforeDisplayMessage(): void {
    if (process.stdout.isTTY && this.rl) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
  }

  /** 電文表示の後処理（受信時刻更新・プロンプト再描画） */
  afterDisplayMessage(): void {
    this.statusLine.markMessageReceived();
    this.prompt();
  }

  private buildPromptString(): string {
    if (!process.stdout.isTTY) {
      return chalk.gray("fleq> ");
    }
    return this.statusLine.buildPrefix();
  }

  private prompt(): void {
    if (this.rl) {
      this.rl.setPrompt(this.buildPromptString());
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

    // カラム幅定義
    const COL = { time: 18, hypo: 16, mag: 6, depth: 8, int: 8 };

    const hLine = (l: string, m: string, r: string, h: string) =>
      chalk.gray(
        `  ${l}${h.repeat(COL.time + 2)}${m}${h.repeat(COL.hypo + 2)}${m}${h.repeat(COL.mag + 2)}${m}${h.repeat(COL.depth + 2)}${m}${h.repeat(COL.int + 2)}${r}`
      );

    console.log();
    console.log(hLine("┌", "┬", "┐", "─"));
    console.log(chalk.gray("  │ ") +
      chalk.cyan(visualPadEnd("発生時刻", COL.time)) + chalk.gray(" │ ") +
      chalk.cyan(visualPadEnd("震源地", COL.hypo)) + chalk.gray(" │ ") +
      chalk.cyan(visualPadEnd("規模", COL.mag)) + chalk.gray(" │ ") +
      chalk.cyan(visualPadEnd("深さ", COL.depth)) + chalk.gray(" │ ") +
      chalk.cyan(visualPadEnd("最大震度", COL.int)) + chalk.gray(" │")
    );
    console.log(hLine("├", "┼", "┤", "─"));

    for (const item of res.items) {
      const time = formatShortTime(item.originTime || item.arrivalTime);
      const hypo = truncate(item.hypocenter?.name || "不明", COL.hypo);
      const mag =
        item.magnitude?.value != null ? `M${item.magnitude.value}` : "M---";
      const depth = formatDepth(item);
      const maxInt = item.maxInt != null ? item.maxInt : "---";

      const intColor = item.maxInt != null ? intensityColor(item.maxInt) : chalk.gray;

      console.log(chalk.gray("  │ ") +
        chalk.white(visualPadEnd(time, COL.time)) + chalk.gray(" │ ") +
        chalk.white(visualPadEnd(hypo, COL.hypo)) + chalk.gray(" │ ") +
        chalk.yellow(visualPadEnd(mag, COL.mag)) + chalk.gray(" │ ") +
        chalk.white(visualPadEnd(depth, COL.depth)) + chalk.gray(" │ ") +
        intColor(visualPadEnd(maxInt, COL.int)) + chalk.gray(" │")
      );
    }

    console.log(hLine("└", "┴", "┘", "─"));
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
    this.stop();
    this.wsManager.close();
    process.exit(0);
  }
}

/** ISO 文字列を "MM-DD HH:mm:ss" に整形 (テーブル用短縮形) */
function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 文字列を視覚幅で指定幅に切り詰める */
function truncate(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visualWidth(str) <= maxWidth) return str;

  const ellipsis = "…";
  const ellipsisWidth = visualWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsis;

  const targetWidth = maxWidth - ellipsisWidth;
  let result = "";
  let width = 0;

  for (const ch of str) {
    const chWidth = visualWidth(ch);
    if (width + chWidth > targetWidth) break;
    result += ch;
    width += chWidth;
  }

  return result + ellipsis;
}

/** GdEarthquakeItem から深さ文字列を生成 */
function formatDepth(item: import("../types").GdEarthquakeItem): string {
  if (item.hypocenter?.depth?.value != null) {
    const val = item.hypocenter.depth.value;
    const unit = item.hypocenter.depth.unit || "km";
    return `${val}${unit}`;
  }
  return "---";
}
