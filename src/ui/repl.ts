import readline from "readline";
import chalk from "chalk";
import { AppConfig, DisplayMode, PromptClock, NotifyCategory } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { listEarthquakes, listContracts, listSockets } from "../dmdata/rest-client";
import { loadConfig, saveConfig, printConfig } from "../config";
import { Notifier, NOTIFY_CATEGORY_LABELS } from "../engine/notifier";
import {
  formatElapsedTime,
  intensityColor,
  lgIntensityColor,
  visualPadEnd,
  visualWidth,
  setFrameWidth,
  clearFrameWidth,
  setInfoFullText,
  setDisplayMode,
  getDisplayMode,
} from "../ui/formatter";
import * as log from "../logger";
import { setLogPrefixBuilder, setLogHooks } from "../logger";
import { WAITING_TIPS } from "./waiting-tips";

interface CommandEntry {
  description: string;
  detail?: string;
  handler: (args: string) => void | Promise<void>;
}

class StatusLine {
  private pulseOn = true;
  private connectedAt: number | null = null;
  private lastMessageTime: number | null = null;
  private clockMode: PromptClock = "elapsed";

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

  setClockMode(mode: PromptClock): void {
    this.clockMode = mode;
  }

  getClockMode(): PromptClock {
    return this.clockMode;
  }

  buildPrefix(): string {
    if (this.connectedAt == null) {
      return (
        chalk.gray("FlEq [") + chalk.gray("○ --:--:--") + chalk.gray("]> ")
      );
    }
    const dot = this.pulseOn ? chalk.cyan("●") : chalk.gray("○");
    const timeStr = this.clockMode === "clock"
      ? formatCurrentTime()
      : formatElapsedTime(Date.now() - (this.lastMessageTime ?? this.connectedAt));
    return (
      chalk.gray("FlEq [") +
      dot +
      chalk.gray(" ") +
      chalk.white(timeStr) +
      chalk.gray("]> ")
    );
  }

  /** ログ出力用プレフィックス */
  buildLogPrefix(): string {
    if (this.connectedAt == null) {
      return (
        chalk.gray("FlEq [") + chalk.gray("○ --:--:--") + chalk.gray("]> ")
      );
    }
    const dot = this.pulseOn ? chalk.cyan("●") : chalk.gray("○");
    const timeStr = this.clockMode === "clock"
      ? formatCurrentTime()
      : formatElapsedTime(Date.now() - (this.lastMessageTime ?? this.connectedAt));
    return (
      chalk.gray("FlEq [") +
      dot +
      chalk.gray(" ") +
      chalk.white(timeStr) +
      chalk.gray("]> ")
    );
  }

  getLastMessageTime(): number | null {
    return this.lastMessageTime;
  }
}

/** 現在時刻を HH:mm:ss 形式で返す */
function formatCurrentTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** レーベンシュタイン距離 (typo候補用) */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

export class ReplHandler {
  private config: AppConfig;
  private wsManager: WebSocketManager;
  private notifier: Notifier;
  private onQuit: () => void | Promise<void>;
  private rl: readline.Interface | null = null;
  private commands: Record<string, CommandEntry>;
  private stopping = false;
  private statusLine: StatusLine;
  private statusTimer: NodeJS.Timeout | null = null;
  private commandRunning = false;
  private tipIntervalMs: number;
  private nextTipAt: number | null = null;
  private tipIndex = 0;

  constructor(
    config: AppConfig,
    wsManager: WebSocketManager,
    notifier: Notifier,
    onQuit: () => void | Promise<void>
  ) {
    this.config = config;
    this.wsManager = wsManager;
    this.notifier = notifier;
    this.onQuit = onQuit;
    this.statusLine = new StatusLine();
    this.statusLine.setClockMode(this.config.promptClock);
    this.tipIntervalMs = this.config.waitTipIntervalMin * 60 * 1000;
    this.tipIndex = Math.floor(Math.random() * WAITING_TIPS.length);

    this.commands = {
      help: {
        description: "コマンド一覧を表示 (例: help status)",
        detail: "引数なしで一覧表示。help <command> でコマンドの詳細を表示。",
        handler: (args) => this.handleHelp(args),
      },
      "?": {
        description: "help のエイリアス",
        handler: (args) => this.handleHelp(args),
      },
      history: {
        description: "地震履歴を取得・表示 (例: history 5)",
        detail: "dmdata.jp API から直近の地震履歴を取得します。\n  引数: 件数 (1〜100, デフォルト10)\n  例: history 20",
        handler: (args) => this.handleHistory(args),
      },
      status: {
        description: "WebSocket 接続状態を表示",
        detail: "現在の WebSocket 接続状態、SocketID、再接続試行回数を表示します。",
        handler: () => this.handleStatus(),
      },
      colors: {
        description: "カラーパレット・震度色の一覧を表示",
        detail: "CUD (カラーユニバーサルデザイン) パレットと、\n  震度・長周期地震動階級・フレームレベルに対応する色を確認できます。",
        handler: () => this.handleColors(),
      },
      config: {
        description: "現在の設定を表示",
        detail: "Configファイルに保存された設定を一覧表示します。",
        handler: () => this.handleConfig(),
      },
      contract: {
        description: "契約区分一覧を表示",
        detail: "dmdata.jp で契約している区分を API から取得して表示します。",
        handler: () => this.handleContract(),
      },
      socket: {
        description: "接続中のソケット一覧を表示",
        detail: "dmdata.jp で現在開いているソケット一覧を表示します。",
        handler: () => this.handleSocket(),
      },
      notify: {
        description: "通知設定の表示・切替 (例: notify eew on)",
        detail: "引数なし: 現在の通知設定を一覧表示\n  notify <category>: トグル切替\n  notify <category> on: 有効にする\n  notify <category> off: 無効にする\n  notify all:on / all:off: 一括操作\n  カテゴリ: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation",
        handler: (args) => this.handleNotify(args),
      },
      tablewidth: {
        description: "テーブル幅の表示・変更 (例: tablewidth 80 / tablewidth auto)",
        detail: "引数なし: 現在のテーブル幅を表示\n  tablewidth <40〜200>: テーブル幅を固定値に変更\n  tablewidth auto: ターミナル幅に自動追従 (デフォルト)\n  変更は即座に反映され、Configファイルに保存されます。",
        handler: (args) => this.handleTableWidth(args),
      },
      infotext: {
        description: "お知らせ電文の全文/省略切替 (例: infotext full)",
        detail: "infotext full: 全文表示\n  infotext short: 省略表示 (デフォルト)",
        handler: (args) => this.handleInfoText(args),
      },
      tipinterval: {
        description: "待機中ヒント表示間隔の表示・変更 (例: tipinterval 15)",
        detail: "tipinterval: 現在のヒント間隔(分)を表示\n  tipinterval <0〜1440>: ヒント間隔を分で変更 (0で無効)",
        handler: (args) => this.handleTipInterval(args),
      },
      mode: {
        description: "表示モード切替 (例: mode compact)",
        detail: "mode: 現在のモードを表示\n  mode normal: フルフレーム表示 (デフォルト)\n  mode compact: 1行サマリー表示\n  長時間モニタリング時は compact がおすすめです。",
        handler: (args) => this.handleMode(args),
      },
      clock: {
        description: "プロンプト時計の切替 (例: clock / clock elapsed)",
        detail: "clock: 経過時間/現在時刻をトグル切替\n  clock elapsed: 経過時間表示 (デフォルト)\n  clock now: 現在時刻表示",
        handler: (args) => this.handleClock(args),
      },
      sound: {
        description: "通知音の ON/OFF 切替",
        detail: "sound: 現在の状態を表示\n  sound on: 通知音を有効にする\n  sound off: 通知音を無効にする",
        handler: (args) => this.handleSound(args),
      },
      mute: {
        description: "通知を一時ミュート (例: mute 30m)",
        detail: "mute: 現在のミュート状態を表示\n  mute <duration>: 指定時間ミュート (例: 30m, 1h, 90s)\n  mute off: ミュート解除",
        handler: (args) => this.handleMute(args),
      },
      retry: {
        description: "WebSocket 再接続を試行",
        detail: "切断中の場合に手動で再接続を試みます。",
        handler: () => this.handleRetry(),
      },
      quit: {
        description: "アプリケーションを終了",
        handler: () => this.handleQuit(),
      },
      exit: {
        description: "quit のエイリアス",
        handler: () => this.handleQuit(),
      },
    };
  }

  /** REPL を開始する */
  start(): void {
    // ロガーのプレフィックスを StatusLine に連動させる
    setLogPrefixBuilder(() => this.statusLine.buildLogPrefix());
    // ログ出力前にプロンプト行をクリアし、出力後に再描画する
    setLogHooks({
      beforeLog: () => {
        if (process.stdout.isTTY && this.rl) {
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 0);
        }
      },
      afterLog: () => {
        if (this.rl && !this.stopping) {
          this.rl.setPrompt(this.buildPromptString());
          this.rl.prompt();
        }
      },
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.buildPromptString(),
    });

    if (process.stdout.isTTY) {
      this.resetTipSchedule();
      this.statusTimer = setInterval(() => {
        this.statusLine.tick();
        this.maybeShowWaitingTip();
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
        // typo候補を検索
        const suggestion = this.findSuggestion(cmd);
        if (suggestion) {
          console.log(chalk.yellow(`  不明なコマンド: ${cmd}`) + chalk.gray(` — もしかして: ${chalk.white(suggestion)}`));
        } else {
          console.log(chalk.yellow(`  不明なコマンド: ${cmd}`) + chalk.gray(" (help で一覧を表示)"));
        }
        this.commandRunning = false;
        this.prompt();
        return;
      }

      try {
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
              if (!this.stopping) this.prompt();
            });
        } else {
          this.commandRunning = false;
          if (!this.stopping) this.prompt();
        }
      } catch (err) {
        log.error(
          `コマンド実行エラー: ${err instanceof Error ? err.message : err}`
        );
        this.commandRunning = false;
        if (!this.stopping) this.prompt();
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
    setLogPrefixBuilder(null);
    setLogHooks(null);
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
    this.resetTipSchedule();
    this.prompt();
  }

  private buildPromptString(): string {
    if (!process.stdout.isTTY) {
      return chalk.gray("FlEq> ");
    }
    const base = this.statusLine.buildPrefix().replace(/> $/, "");
    const status = this.wsManager.getStatus();
    if (!status.connected || status.heartbeatDeadlineAt == null) {
      return `${base}> `;
    }
    const sec = Math.max(0, Math.ceil((status.heartbeatDeadlineAt - Date.now()) / 1000));
    return `${base}${chalk.gray(" | ")}${chalk.white(`ping in ${sec}s`)}${chalk.gray("]> ")}`;
  }

  private prompt(): void {
    if (this.rl) {
      this.rl.setPrompt(this.buildPromptString());
      this.rl.prompt();
    }
  }

  /** typo候補を検索 (距離2以内で最も近いコマンドを返す) */
  private findSuggestion(input: string): string | null {
    let bestCmd: string | null = null;
    let bestDist = 3; // 距離2以内を候補にする
    const displayed = new Set<string>();
    for (const name of Object.keys(this.commands)) {
      if (name === "?" || name === "exit") continue;
      if (displayed.has(name)) continue;
      displayed.add(name);
      const dist = levenshtein(input.toLowerCase(), name.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestCmd = name;
      }
    }
    return bestCmd;
  }

  /** 設定変更可能なコマンドの現在値と設定可能な値を返す */
  private getCurrentSettingValues(): Record<string, { current: string; options?: string }> {
    const notifySettings = this.notifier.getSettings();
    const onCount = Object.values(notifySettings).filter(Boolean).length;
    const totalCount = Object.keys(notifySettings).length;
    const muteInfo = this.notifier.isMuted()
      ? `, ミュート中`
      : "";

    return {
      sound: {
        current: this.notifier.getSoundEnabled() ? "ON" : "OFF",
        options: "on / off",
      },
      tablewidth: {
        current: this.config.tableWidth == null
          ? `auto (${process.stdout.columns ?? 60})`
          : `${this.config.tableWidth} (固定)`,
        options: "40〜200 / auto",
      },
      infotext: {
        current: this.config.infoFullText ? "full" : "short",
        options: "full / short",
      },
      tipinterval: {
        current: this.config.waitTipIntervalMin === 0
          ? "無効"
          : `${this.config.waitTipIntervalMin}分`,
        options: "0〜1440 (0で無効)",
      },
      mode: {
        current: getDisplayMode(),
        options: "normal / compact",
      },
      clock: {
        current: this.statusLine.getClockMode() === "clock" ? "現在時刻" : "経過時間",
        options: "elapsed / now",
      },
      notify: {
        current: `${onCount}/${totalCount} ON${muteInfo}`,
        options: "eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation",
      },
      mute: {
        current: this.notifier.isMuted()
          ? `残り ${formatDuration(this.notifier.muteRemaining())}`
          : "OFF",
        options: "<duration> (例: 30m, 1h, 90s) / off",
      },
    };
  }

  // ── コマンドハンドラ ──

  private handleHelp(args: string): void {
    const trimmed = args.trim();

    // help <command> — 詳細表示
    if (trimmed.length > 0) {
      const entry = this.commands[trimmed];
      if (entry == null) {
        console.log(chalk.yellow(`  不明なコマンド: ${trimmed}`));
        return;
      }
      console.log();
      console.log(chalk.cyan.bold(`  ${trimmed}`) + chalk.gray(` — ${entry.description}`));
      if (entry.detail) {
        console.log();
        for (const line of entry.detail.split("\n")) {
          console.log(chalk.white(`  ${line}`));
        }
      }
      console.log();
      return;
    }

    // help — 一覧
    console.log();
    console.log(chalk.cyan.bold("  利用可能なコマンド:"));
    console.log();

    const currentValues = this.getCurrentSettingValues();
    const displayed = new Set<string>();
    const commandNames = Object.keys(this.commands)
      .filter((name) => name !== "exit" && name !== "?")
      .sort();
    for (const name of commandNames) {
      const entry = this.commands[name];
      if (displayed.has(entry.description)) continue;
      displayed.add(entry.description);
      const setting = currentValues[name];
      const valueSuffix = setting != null
        ? chalk.gray(" [") + chalk.yellow(setting.current) + chalk.gray("]") +
          (setting.options ? chalk.gray(` (${setting.options})`) : "")
        : "";
      console.log(
        chalk.white(`  ${name.padEnd(12)}`) + chalk.gray(entry.description) + valueSuffix
      );
    }
    console.log(
      chalk.white(`  ${"?".padEnd(12)}`) + chalk.gray("help のエイリアス")
    );
    console.log(
      chalk.white(`  ${"exit".padEnd(12)}`) +
        chalk.gray("quit のエイリアス")
    );
    console.log();
  }

  private async handleHistory(args: string): Promise<void> {
    const MAX_HISTORY = 100;
    const raw = args.length > 0 ? parseInt(args, 10) : 10;
    if (isNaN(raw) || raw <= 0) {
      console.log(chalk.yellow("  件数は正の整数で指定してください"));
      return;
    }
    const limit = Math.min(raw, MAX_HISTORY);

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

  private handleColors(): void {
    console.log();
    console.log(chalk.cyan.bold("  CUD カラーパレット:"));
    console.log();
    const palette: Array<{ name: string; rgb: [number, number, number]; usage: string }> = [
      { name: "gray",       rgb: [132, 145, 158], usage: "低優先度・補助テキスト" },
      { name: "sky",        rgb: [86, 180, 233],  usage: "通常・長周期階級1" },
      { name: "blue",       rgb: [0, 114, 178],   usage: "震度3" },
      { name: "blueGreen",  rgb: [0, 158, 115],   usage: "震度4・津波なし" },
      { name: "yellow",     rgb: [240, 228, 66],  usage: "震度5弱・M3+" },
      { name: "orange",     rgb: [230, 159, 0],   usage: "警告レベル" },
      { name: "vermillion", rgb: [213, 94, 0],    usage: "危険レベル" },
      { name: "raspberry",  rgb: [204, 121, 167], usage: "取消・キャンセル" },
      { name: "darkRed",    rgb: [122, 30, 0],    usage: "最高警戒 (背景用)" },
    ];
    for (const p of palette) {
      const swatch = chalk.rgb(p.rgb[0], p.rgb[1], p.rgb[2])("██");
      const rgbStr = `(${p.rgb.join(", ")})`;
      console.log(
        `  ${swatch} ` +
        chalk.white(p.name.padEnd(12)) +
        chalk.gray(rgbStr.padEnd(16)) +
        chalk.gray(p.usage)
      );
    }

    console.log();
    console.log(chalk.cyan.bold("  震度カラー:"));
    console.log();
    const intensities = ["1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
    for (const int of intensities) {
      const color = intensityColor(int);
      console.log(`  ${color("██")} ${color(`震度${int}`)}`);
    }

    console.log();
    console.log(chalk.cyan.bold("  長周期地震動階級カラー:"));
    console.log();
    const lgInts = ["0", "1", "2", "3", "4"];
    for (const lg of lgInts) {
      const color = lgIntensityColor(lg);
      console.log(`  ${color("██")} ${color(`階級${lg}`)}`);
    }

    console.log();
    console.log(chalk.cyan.bold("  フレームレベル:"));
    console.log();
    const levels: Array<{ name: string; rgb: [number, number, number]; label: string }> = [
      { name: "critical", rgb: [213, 94, 0],    label: "[緊急] 二重線フレーム" },
      { name: "warning",  rgb: [230, 159, 0],   label: "[警告] 二重線フレーム" },
      { name: "normal",   rgb: [86, 180, 233],  label: "[情報] 通常フレーム" },
      { name: "info",     rgb: [132, 145, 158], label: "[通知] 通常フレーム" },
      { name: "cancel",   rgb: [204, 121, 167], label: "[取消] 通常フレーム" },
    ];
    for (const lv of levels) {
      const color = chalk.rgb(lv.rgb[0], lv.rgb[1], lv.rgb[2]);
      console.log(`  ${color("██")} ${color(lv.name.padEnd(10))} ${chalk.gray(lv.label)}`);
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

  private handleNotify(args: string): void {
    const trimmed = args.trim();

    // 引数なし → 一覧表示
    if (trimmed.length === 0) {
      const settings = this.notifier.getSettings();
      console.log();
      console.log(chalk.cyan.bold("  通知設定:"));
      if (this.notifier.isMuted()) {
        const remaining = this.notifier.muteRemaining();
        console.log(chalk.yellow(`  (ミュート中: 残り ${formatDuration(remaining)})`));
      }
      console.log();
      for (const [cat, label] of Object.entries(NOTIFY_CATEGORY_LABELS)) {
        const enabled = settings[cat as NotifyCategory];
        const status = enabled
          ? chalk.green("ON")
          : chalk.red("OFF");
        console.log(
          chalk.white(`  ${cat.padEnd(14)}`) +
            chalk.gray(`${label}  `) +
            status
        );
      }
      console.log();
      console.log(
        chalk.gray("  使い方: notify <category> [on|off] / notify all:on / notify all:off")
      );
      console.log();
      return;
    }

    // all:on / all:off
    if (trimmed === "all:on") {
      this.notifier.setAll(true);
      console.log(chalk.green("  全通知を有効にしました"));
      return;
    }
    if (trimmed === "all:off") {
      this.notifier.setAll(false);
      console.log(chalk.yellow("  全通知を無効にしました"));
      return;
    }

    // カテゴリ指定 (+ 任意の on/off)
    const parts = trimmed.split(/\s+/);
    const cat = parts[0] as NotifyCategory;
    const action = parts[1]?.toLowerCase();

    if (!(cat in NOTIFY_CATEGORY_LABELS)) {
      console.log(
        chalk.yellow(`  不明なカテゴリ: ${parts[0]}`) +
          chalk.gray(` (有効: ${Object.keys(NOTIFY_CATEGORY_LABELS).join(", ")})`)
      );
      return;
    }

    let newState: boolean;
    if (action === "on") {
      const settings = this.notifier.getSettings();
      if (settings[cat]) {
        console.log(`  ${NOTIFY_CATEGORY_LABELS[cat]} (${cat}): 既に ${chalk.green("ON")} です`);
        return;
      }
      newState = this.notifier.toggleCategory(cat);
    } else if (action === "off") {
      const settings = this.notifier.getSettings();
      if (!settings[cat]) {
        console.log(`  ${NOTIFY_CATEGORY_LABELS[cat]} (${cat}): 既に ${chalk.red("OFF")} です`);
        return;
      }
      newState = this.notifier.toggleCategory(cat);
    } else {
      newState = this.notifier.toggleCategory(cat);
    }

    const label = NOTIFY_CATEGORY_LABELS[cat];
    const status = newState ? chalk.green("ON") : chalk.red("OFF");
    console.log(`  ${label} (${cat}): ${status}`);
  }

  private handleTableWidth(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      if (this.config.tableWidth == null) {
        const cols = process.stdout.columns ?? 60;
        console.log(`  現在のテーブル幅: auto (ターミナル幅: ${cols})`);
      } else {
        console.log(`  現在のテーブル幅: ${this.config.tableWidth} (固定)`);
      }
      console.log(chalk.gray("  使い方: tablewidth <40〜200> / tablewidth auto"));
      return;
    }

    if (trimmed === "auto") {
      this.config.tableWidth = null;
      clearFrameWidth();
      const config = loadConfig();
      delete config.tableWidth;
      saveConfig(config);
      const cols = process.stdout.columns ?? 60;
      console.log(`  テーブル幅を auto に変更しました。(現在のターミナル幅: ${cols})`);
      return;
    }

    const width = Number(trimmed);
    if (isNaN(width) || !Number.isInteger(width) || width < 40 || width > 200) {
      console.log(chalk.yellow("  tableWidth は 40〜200 の整数、または auto を指定してください。"));
      return;
    }

    this.config.tableWidth = width;
    setFrameWidth(width);
    const config = loadConfig();
    config.tableWidth = width;
    saveConfig(config);
    console.log(`  テーブル幅を ${width} に変更しました。`);
  }

  private handleInfoText(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      const current = this.config.infoFullText ? "full (全文表示)" : "short (省略表示)";
      console.log(`  お知らせ電文表示: ${current}`);
      console.log(chalk.gray("  使い方: infotext full / infotext short"));
      return;
    }

    if (trimmed === "full") {
      this.config.infoFullText = true;
      setInfoFullText(true);
      const config = loadConfig();
      config.infoFullText = true;
      saveConfig(config);
      console.log("  お知らせ電文を全文表示に変更しました。");
    } else if (trimmed === "short") {
      this.config.infoFullText = false;
      setInfoFullText(false);
      const config = loadConfig();
      config.infoFullText = false;
      saveConfig(config);
      console.log("  お知らせ電文を省略表示に変更しました。");
    } else {
      console.log(chalk.yellow("  full または short を指定してください。"));
    }
  }

  private handleMode(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      const current = getDisplayMode();
      console.log(`  表示モード: ${current}`);
      console.log(chalk.gray("  使い方: mode normal / mode compact"));
      return;
    }

    if (trimmed !== "normal" && trimmed !== "compact") {
      console.log(chalk.yellow(`  無効なモード: ${trimmed}`) + chalk.gray(" (normal / compact)"));
      return;
    }

    const mode = trimmed as DisplayMode;
    this.config.displayMode = mode;
    setDisplayMode(mode);
    const config = loadConfig();
    config.displayMode = mode;
    saveConfig(config);
    console.log(`  表示モードを ${mode} に変更しました。`);
  }

  private handleClock(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      // トグル
      const current = this.statusLine.getClockMode();
      const next: PromptClock = current === "elapsed" ? "clock" : "elapsed";
      this.statusLine.setClockMode(next);
      this.config.promptClock = next;
      const config = loadConfig();
      config.promptClock = next;
      saveConfig(config);
      const label = next === "clock" ? "現在時刻" : "経過時間";
      console.log(`  プロンプト時計を ${label} に切り替えました。`);
      return;
    }

    if (trimmed === "elapsed") {
      this.statusLine.setClockMode("elapsed");
      this.config.promptClock = "elapsed";
      const config = loadConfig();
      config.promptClock = "elapsed";
      saveConfig(config);
      console.log("  プロンプト時計を 経過時間 に変更しました。");
    } else if (trimmed === "now") {
      this.statusLine.setClockMode("clock");
      this.config.promptClock = "clock";
      const config = loadConfig();
      config.promptClock = "clock";
      saveConfig(config);
      console.log("  プロンプト時計を 現在時刻 に変更しました。");
    } else {
      console.log(chalk.yellow("  elapsed または now を指定してください。"));
    }
  }

  private handleTipInterval(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      console.log(`  待機中ヒント間隔: ${this.config.waitTipIntervalMin}分`);
      console.log(chalk.gray("  使い方: tipinterval <0〜1440> (0で無効)"));
      return;
    }

    const min = Number(trimmed);
    if (isNaN(min) || !Number.isInteger(min) || min < 0 || min > 1440) {
      console.log(chalk.yellow("  tipinterval は 0〜1440 の整数を指定してください。"));
      return;
    }

    this.config.waitTipIntervalMin = min;
    this.tipIntervalMs = min * 60 * 1000;
    this.resetTipSchedule();
    const config = loadConfig();
    config.waitTipIntervalMin = min;
    saveConfig(config);
    if (min === 0) {
      console.log("  待機中ヒントを無効化しました。");
      return;
    }
    console.log(`  待機中ヒント間隔を ${min}分 に変更しました。`);
  }

  private handleSound(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      const current = this.notifier.getSoundEnabled();
      const status = current ? chalk.green("ON") : chalk.red("OFF");
      console.log(`  通知音: ${status}`);
      console.log(chalk.gray("  使い方: sound on / sound off"));
      return;
    }

    if (trimmed === "on") {
      this.notifier.setSoundEnabled(true);
      console.log(`  通知音を ${chalk.green("ON")} にしました。`);
    } else if (trimmed === "off") {
      this.notifier.setSoundEnabled(false);
      console.log(`  通知音を ${chalk.red("OFF")} にしました。`);
    } else {
      console.log(chalk.yellow("  on または off を指定してください。"));
    }
  }

  private handleMute(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      if (this.notifier.isMuted()) {
        const remaining = this.notifier.muteRemaining();
        console.log(`  ミュート中: 残り ${formatDuration(remaining)}`);
      } else {
        console.log("  ミュートなし");
      }
      console.log(chalk.gray("  使い方: mute <duration> (例: 30m, 1h, 90s) / mute off"));
      return;
    }

    if (trimmed === "off") {
      this.notifier.unmute();
      console.log("  ミュートを解除しました。");
      return;
    }

    const ms = parseDuration(trimmed);
    if (ms == null || ms <= 0) {
      console.log(chalk.yellow("  無効な時間指定です。例: 30m, 1h, 90s"));
      return;
    }

    this.notifier.mute(ms);
    console.log(`  通知を ${formatDuration(ms)} ミュートしました。`);
  }

  private async handleRetry(): Promise<void> {
    const status = this.wsManager.getStatus();
    if (status.connected) {
      console.log(chalk.gray("  既に接続中です。"));
      return;
    }

    console.log(chalk.gray("  再接続を試行中..."));
    try {
      await this.wsManager.connect();
    } catch (err) {
      log.error(`再接続に失敗しました: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async handleQuit(): Promise<void> {
    this.stop();
    await this.onQuit();
  }

  private maybeShowWaitingTip(): void {
    if (!this.rl || this.commandRunning || this.rl.line.length > 0) return;
    if (this.tipIntervalMs <= 0 || this.nextTipAt == null) return;
    const status = this.wsManager.getStatus();
    if (!status.connected) return;

    const lastMessageAt = this.statusLine.getLastMessageTime();
    if (lastMessageAt != null && Date.now() - lastMessageAt < 10_000) return;
    if (Date.now() < this.nextTipAt) return;

    const tip = WAITING_TIPS[this.tipIndex % WAITING_TIPS.length];
    this.tipIndex++;
    this.nextTipAt = Date.now() + this.tipIntervalMs;
    console.log(chalk.gray(`  ${tip}`));
  }

  private resetTipSchedule(): void {
    if (this.tipIntervalMs <= 0) {
      this.nextTipAt = null;
      return;
    }
    this.nextTipAt = Date.now() + this.tipIntervalMs;
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

/** 時間文字列をミリ秒に変換 (例: "30m" → 1800000, "1h" → 3600000, "90s" → 90000) */
function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: return null;
  }
}

/** ミリ秒を人間可読な時間文字列に変換 */
function formatDuration(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}分${sec}秒` : `${min}分`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hour}時間${remMin}分` : `${hour}時間`;
}
