import readline from "readline";
import chalk from "chalk";
import { AppConfig, ConfigFile, PromptStatusProvider, PromptStatusSegment, DetailProvider } from "../types";
import { ConnectionManager } from "../dmdata/connection-manager";
import { loadConfig, saveConfig } from "../config";
import { Notifier } from "../engine/notification/notifier";
import { EewEventLogger } from "../engine/eew/eew-logger";
import * as themeModule from "../ui/theme";
import type { FilterTemplatePipeline } from "../engine/filter-template/pipeline";
import * as log from "../logger";
import { setLogPrefixBuilder, setLogHooks } from "../logger";
import { StatusLine } from "./status-line";
import { TipShuffler } from "./tip-shuffler";
import { TelegramStats } from "../engine/messages/telegram-stats";
import { SummaryWindowTracker } from "../engine/messages/summary-tracker";
import type { SummaryTimerControl } from "../engine/monitor/monitor";
import type { CommandEntry, ReplContext } from "./repl-handlers/types";
import { COMMAND_ALIASES, resolveCommand } from "./repl-handlers/info-handlers";
import { buildCommandMap } from "./repl-handlers/command-definitions";

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
  private wsManager: ConnectionManager;
  private notifier: Notifier;
  private eewLogger: EewEventLogger;
  private onQuit: () => void | Promise<void>;
  private rl: readline.Interface | null = null;
  private commands: Record<string, CommandEntry>;
  private stopping = false;
  private statusLine: StatusLine;
  private statusTimer: NodeJS.Timeout | null = null;
  private commandRunning = false;
  private tipIntervalMs: number;
  private lastTipMilestone = 0;
  private tipShuffler = new TipShuffler();
  private statusProviders: PromptStatusProvider[];
  private detailProviders: DetailProvider[];
  private stats: TelegramStats;
  private pipeline: FilterTemplatePipeline | null;
  private summaryTracker: SummaryWindowTracker | null;
  private summaryTimerControl: SummaryTimerControl | null = null;
  private summaryIntervalMin: number | null = null;
  private filterExpr: string | null = null;
  private filterUpdatedAt: Date | null = null;
  private focusExpr: string | null = null;
  private focusUpdatedAt: Date | null = null;

  constructor(
    config: AppConfig,
    wsManager: ConnectionManager,
    notifier: Notifier,
    eewLogger: EewEventLogger,
    onQuit: () => void | Promise<void>,
    stats: TelegramStats,
    statusProviders: PromptStatusProvider[] = [],
    detailProviders: DetailProvider[] = [],
    pipeline?: FilterTemplatePipeline,
    summaryTracker?: SummaryWindowTracker,
  ) {
    this.config = config;
    this.wsManager = wsManager;
    this.notifier = notifier;
    this.eewLogger = eewLogger;
    this.onQuit = onQuit;
    this.stats = stats;
    this.statusProviders = statusProviders;
    this.detailProviders = detailProviders;
    this.pipeline = pipeline ?? null;
    this.summaryTracker = summaryTracker ?? null;
    this.summaryIntervalMin = config.summaryInterval ?? null;
    this.statusLine = new StatusLine();
    this.statusLine.setClockMode(this.config.promptClock);
    this.tipIntervalMs = this.config.waitTipIntervalMin * 60 * 1000;

    this.commands = buildCommandMap(() => this.buildContext());
  }

  /** 定期要約タイマーの制御オブジェクトを設定する */
  setSummaryTimerControl(control: SummaryTimerControl): void {
    this.summaryTimerControl = control;
  }

  /** REPL を開始する */
  start(): void {
    // ロガーのプレフィックスを StatusLine に連動させる
    setLogPrefixBuilder(() => this.statusLine.buildPrefix());
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
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 0);
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

      const [rawCmd, ...rest] = trimmed.split(/\s+/);
      const args = rest.join(" ");
      const entry = resolveCommand(this.buildContext(), rawCmd);

      if (entry == null) {
        // typo候補を検索
        const suggestion = this.findSuggestion(rawCmd);
        if (suggestion) {
          console.log(chalk.yellow(`  不明なコマンド: ${rawCmd}`) + chalk.gray(` — もしかして: ${chalk.white(suggestion)}`));
        } else {
          console.log(chalk.yellow(`  不明なコマンド: ${rawCmd}`) + chalk.gray(" (help で一覧を表示)"));
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
        this.stop();
        void this.onQuit();
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

  /** 電文表示の前処理（入力中の文字をクリアし、プロンプト行をクリア） */
  beforeDisplayMessage(): void {
    if (process.stdout.isTTY && this.rl) {
      this.clearInput();
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

  /**
   * コマンドハンドラが参照するコンテキストを構築する。
   * getter/setter を使い、ハンドラ側での変更が ReplHandler に反映されるようにする。
   */
  private buildContext(): ReplContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      config: this.config,
      wsManager: this.wsManager,
      notifier: this.notifier,
      eewLogger: this.eewLogger,
      statusLine: this.statusLine,
      stats: this.stats,
      statusProviders: this.statusProviders,
      detailProviders: this.detailProviders,
      pipeline: this.pipeline,
      summaryTracker: this.summaryTracker,
      commands: this.commands,
      onQuit: this.onQuit,

      // ミュータブルフィールドは getter/setter で双方向同期
      get summaryTimerControl() { return self.summaryTimerControl; },
      get summaryIntervalMin() { return self.summaryIntervalMin; },
      set summaryIntervalMin(v) { self.summaryIntervalMin = v; },
      get filterExpr() { return self.filterExpr; },
      set filterExpr(v) { self.filterExpr = v; },
      get filterUpdatedAt() { return self.filterUpdatedAt; },
      set filterUpdatedAt(v) { self.filterUpdatedAt = v; },
      get focusExpr() { return self.focusExpr; },
      set focusExpr(v) { self.focusExpr = v; },
      get focusUpdatedAt() { return self.focusUpdatedAt; },
      set focusUpdatedAt(v) { self.focusUpdatedAt = v; },
      get tipIntervalMs() { return self.tipIntervalMs; },
      set tipIntervalMs(v) { self.tipIntervalMs = v; },
      get rl() { return self.rl; },

      updateConfig: (updater) => this.updateConfig(updater),
      buildPromptString: () => this.buildPromptString(),
      stop: () => this.stop(),
      resetTipSchedule: () => this.resetTipSchedule(),
    };
  }

  /** loadConfig → updater → saveConfig の3行パターンをまとめるヘルパー */
  private updateConfig(updater: (config: ConfigFile) => void): void {
    const config = loadConfig();
    updater(config);
    saveConfig(config);
  }

  private buildPromptString(): string {
    if (!process.stdout.isTTY) {
      return chalk.gray("FlEq> ");
    }
    const base = this.statusLine.buildPrefix({ noSuffix: true });
    const status = this.wsManager.getStatus();

    // ステータスプロバイダーからセグメント収集 → priority 順ソート
    const segments = this.statusProviders
      .map((p) => p.getPromptStatus())
      .filter((s): s is PromptStatusSegment => s != null)
      .sort((a, b) => a.priority - b.priority);

    const parts: string[] = segments.map((s) => s.text);

    // フィルタ状態セグメント
    if (this.pipeline?.filter != null) {
      parts.push(chalk.cyan("F:on"));
    }

    if (status.connected && status.heartbeatDeadlineAt != null) {
      const sec = Math.max(0, Math.ceil((status.heartbeatDeadlineAt - Date.now()) / 1000));
      const palette = themeModule.getPalette();
      const pingColor =
        sec <= 29
          ? chalk.rgb(...palette.vermillion)
          : sec <= 69
            ? chalk.rgb(...palette.yellow)
            : chalk.white;
      parts.push(pingColor(`ping in ${sec}s`));
    }

    if (parts.length === 0) {
      return `${base}${chalk.gray("]> ")}`;
    }
    return `${base}${chalk.gray(" | ")}${parts.join(chalk.gray(" | "))}${chalk.gray("]> ")}`;
  }

  private prompt(): void {
    if (this.rl) {
      this.rl.setPrompt(this.buildPromptString());
      this.rl.prompt();
    }
  }

  /** 入力中の文字をクリアしてプロンプト行を再描画する */
  private clearInput(): void {
    if (!this.rl || !process.stdout.isTTY) return;
    if (this.rl.line.length === 0) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    // readline 内部バッファをリセット (Node.js 実行時は書き込み可能)
    (this.rl as unknown as { line: string; cursor: number }).line = "";
    (this.rl as unknown as { line: string; cursor: number }).cursor = 0;
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

  private maybeShowWaitingTip(): void {
    if (!this.rl || this.commandRunning) return;
    if (this.tipIntervalMs <= 0) return;
    const status = this.wsManager.getStatus();
    if (!status.connected) return;

    const base = this.statusLine.getElapsedBase();
    if (base == null) return;

    const lastMessageAt = this.statusLine.getLastMessageTime();
    if (lastMessageAt != null && Date.now() - lastMessageAt < 10_000) return;

    const elapsed = Date.now() - base;
    const currentMilestone = Math.floor(elapsed / this.tipIntervalMs);
    if (currentMilestone <= this.lastTipMilestone) return;

    this.clearInput();
    const tip = this.tipShuffler.next();
    this.lastTipMilestone = currentMilestone;
    console.log(chalk.gray(`  ${tip}`));
  }

  private resetTipSchedule(): void {
    if (this.tipIntervalMs <= 0) {
      this.lastTipMilestone = 0;
      return;
    }
    const base = this.statusLine.getElapsedBase();
    if (base == null) {
      this.lastTipMilestone = 0;
      return;
    }
    const elapsed = Date.now() - base;
    this.lastTipMilestone = Math.floor(elapsed / this.tipIntervalMs);
  }
}
