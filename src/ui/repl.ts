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

const PROMPT = "fleq> ";

interface CommandEntry {
  description: string;
  handler: (args: string) => void | Promise<void>;
}

interface StatusLineContext {
  hasRepl: () => boolean;
  getInputLength: () => number;
}

class StatusLine {
  private static readonly TICK_MS = 1000;

  private context: StatusLineContext;
  private timer: NodeJS.Timeout | null = null;
  private suspended = false;
  private started = false;
  private hasStatusRow = false;
  private pulseOn = true;
  private connectedAt: number | null = null;
  private lastMessageTime: number | null = null;

  constructor(context: StatusLineContext) {
    this.context = context;
  }

  start(): void {
    this.started = true;
    if (!process.stdout.isTTY || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.pulseOn = !this.pulseOn;
      this.render();
    }, StatusLine.TICK_MS);
    this.render();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }

  setConnected(connected: boolean): void {
    if (connected) {
      this.connectedAt = Date.now();
      this.lastMessageTime = null;
    } else {
      this.connectedAt = null;
      this.lastMessageTime = null;
    }
    this.render();
  }

  markMessageReceived(): void {
    this.lastMessageTime = Date.now();
    this.render();
  }

  suspend(): void {
    this.suspended = true;
    this.clear();
  }

  resume(): void {
    this.suspended = false;
    this.render();
  }

  onPromptRendered(): void {
    this.render();
  }

  private shouldRender(): boolean {
    return (
      this.started &&
      !this.suspended &&
      process.stdout.isTTY &&
      this.context.hasRepl() &&
      this.context.getInputLength() === 0
    );
  }

  private render(): void {
    if (!this.shouldRender()) {
      return;
    }

    const text = this.buildText();
    if (!this.hasStatusRow) {
      process.stdout.write("\x1b[s");
      process.stdout.write("\n");
      process.stdout.write("\x1b[u");
      this.hasStatusRow = true;
    }

    process.stdout.write("\x1b[s");
    process.stdout.write("\x1b[1B\r\x1b[2K");
    process.stdout.write(text);
    process.stdout.write("\x1b[u");
  }

  private clear(): void {
    if (!process.stdout.isTTY || !this.hasStatusRow || !this.context.hasRepl()) {
      this.hasStatusRow = false;
      return;
    }
    process.stdout.write("\x1b[s");
    process.stdout.write("\x1b[1B\r\x1b[2K");
    process.stdout.write("\x1b[u");
    this.hasStatusRow = false;
  }

  private buildText(): string {
    const pulse = this.pulseOn ? chalk.cyan("●") : chalk.gray("○");

    if (this.connectedAt == null) {
      return (
        chalk.gray("  接続待機中 ") +
        pulse +
        chalk.gray("  再接続を待機しています")
      );
    }

    const baseTime = this.lastMessageTime ?? this.connectedAt;
    const label =
      this.lastMessageTime != null ? "最終受信から" : "接続から";
    const elapsed = formatElapsedTime(Date.now() - baseTime);

    return (
      chalk.gray("  待機中 ") +
      pulse +
      chalk.gray(`  ${label} `) +
      chalk.white(elapsed)
    );
  }
}

export class ReplHandler {
  private config: AppConfig;
  private wsManager: WebSocketManager;
  private rl: readline.Interface | null = null;
  private commands: Record<string, CommandEntry>;
  private statusLine: StatusLine;

  constructor(config: AppConfig, wsManager: WebSocketManager) {
    this.config = config;
    this.wsManager = wsManager;
    this.statusLine = new StatusLine({
      hasRepl: () => this.rl != null,
      getInputLength: () => this.rl?.line.length ?? 0,
    });

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
      this.statusLine.suspend();
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        this.prompt();
        this.statusLine.resume();
        return;
      }

      const [cmd, ...rest] = trimmed.split(/\s+/);
      const args = rest.join(" ");
      const entry = this.commands[cmd];

      if (entry == null) {
        console.log(chalk.yellow(`  不明なコマンド: ${cmd} (help で一覧を表示)`));
        this.prompt();
        this.statusLine.resume();
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
            this.prompt();
            this.statusLine.resume();
          });
      } else {
        this.prompt();
        this.statusLine.resume();
      }
    });

    this.rl.on("close", () => {
      this.handleQuit();
    });

    this.prompt();
    this.statusLine.start();
  }

  /** REPL を停止する */
  stop(): void {
    this.statusLine.stop();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /** プロンプトを再表示する (データ出力後に呼ぶ) */
  refreshPrompt(): void {
    if (this.rl) {
      this.prompt();
    }
  }

  /** WebSocket 接続状態を待機表示に反映 */
  setConnected(connected: boolean): void {
    this.statusLine.setConnected(connected);
  }

  /** 電文表示の前処理（待機行を隠す） */
  beforeDisplayMessage(): void {
    this.statusLine.suspend();
  }

  /** 電文表示の後処理（受信時刻更新・待機行再開） */
  afterDisplayMessage(): void {
    this.statusLine.markMessageReceived();
    this.refreshPrompt();
    this.statusLine.resume();
  }

  private prompt(): void {
    if (this.rl) {
      this.rl.prompt();
      this.statusLine.onPromptRendered();
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
    this.statusLine.stop();
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
