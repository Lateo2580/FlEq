import readline from "readline";
import chalk from "chalk";
import { AppConfig, DisplayMode, PromptClock, NotifyCategory, EewLogField, PromptStatusProvider, PromptStatusSegment, DetailProvider } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { listEarthquakes, listContracts, listSockets } from "../dmdata/rest-client";
import { loadConfig, saveConfig, printConfig, VALID_EEW_LOG_FIELDS } from "../config";
import { Notifier, NOTIFY_CATEGORY_LABELS } from "../engine/notification/notifier";
import { EewEventLogger } from "../engine/eew/eew-logger";
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
  setMaxObservations,
  getMaxObservations,
} from "../ui/formatter";
import * as themeModule from "../ui/theme";
import { playSound, isSoundLevel, SOUND_LEVELS } from "../engine/notification/sound-player";
import * as log from "../logger";
import { setLogPrefixBuilder, setLogHooks } from "../logger";
import { WAITING_TIPS } from "./waiting-tips";
import { TEST_TABLES } from "./test-samples";

/** コマンドのカテゴリ */
type CommandCategory = "info" | "status" | "settings" | "operation";

/** カテゴリ表示名 */
const CATEGORY_LABELS: Record<CommandCategory, string> = {
  info: "情報",
  status: "ステータス",
  settings: "設定",
  operation: "操作",
};

/** EEW ログ記録項目の表示ラベル */
const EEW_LOG_FIELD_LABELS: Record<EewLogField, string> = {
  hypocenter: "震源情報",
  originTime: "発生時刻",
  coordinates: "緯度・経度",
  magnitude: "M値・深さ",
  forecastIntensity: "最大予測震度",
  maxLgInt: "最大予測長周期階級",
  forecastAreas: "予測震度地域リスト",
  lgIntensity: "地域別長周期階級",
  isPlum: "PLUM法フラグ",
  hasArrived: "主要動到達フラグ",
  diff: "差分情報",
  maxIntChangeReason: "震度変化理由",
};

/** EEW ログ記録項目のグループ定義 */
const EEW_LOG_FIELD_GROUPS: { label: string; fields: EewLogField[] }[] = [
  { label: "震源", fields: ["hypocenter", "originTime", "coordinates"] },
  { label: "規模", fields: ["magnitude"] },
  { label: "変化", fields: ["diff", "maxIntChangeReason"] },
  { label: "予測概要", fields: ["forecastIntensity", "maxLgInt"] },
  { label: "予測地域", fields: ["forecastAreas", "lgIntensity", "isPlum", "hasArrived"] },
];

interface SubcommandEntry {
  description: string;
  detail?: string;
}

interface CommandEntry {
  description: string;
  detail?: string;
  category: CommandCategory;
  subcommands?: Record<string, SubcommandEntry>;
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

  buildPrefix(options?: { noSuffix?: boolean }): string {
    const suffix = options?.noSuffix ? "" : chalk.gray("]> ");
    if (this.connectedAt == null) {
      return (
        chalk.gray("FlEq [") + chalk.gray("○ --:--:--") + suffix
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
      suffix
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

/** 震度キーから対応するロール名を返す */
function getIntensityRole(key: string): themeModule.RoleName | null {
  const map: Record<string, themeModule.RoleName> = {
    "1": "intensity1", "2": "intensity2", "3": "intensity3", "4": "intensity4",
    "5弱": "intensity5Lower", "5強": "intensity5Upper",
    "6弱": "intensity6Lower", "6強": "intensity6Upper", "7": "intensity7",
  };
  return map[key] ?? null;
}

/** 長周期階級キーから対応するロール名を返す */
function getLgIntRole(key: string): themeModule.RoleName | null {
  const map: Record<string, themeModule.RoleName> = {
    "0": "lgInt0", "1": "lgInt1", "2": "lgInt2", "3": "lgInt3", "4": "lgInt4",
  };
  return map[key] ?? null;
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
  private eewLogger: EewEventLogger;
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
  private statusProviders: PromptStatusProvider[];
  private detailProviders: DetailProvider[];

  constructor(
    config: AppConfig,
    wsManager: WebSocketManager,
    notifier: Notifier,
    eewLogger: EewEventLogger,
    onQuit: () => void | Promise<void>,
    statusProviders: PromptStatusProvider[] = [],
    detailProviders: DetailProvider[] = [],
  ) {
    this.config = config;
    this.wsManager = wsManager;
    this.notifier = notifier;
    this.eewLogger = eewLogger;
    this.onQuit = onQuit;
    this.statusProviders = statusProviders;
    this.detailProviders = detailProviders;
    this.statusLine = new StatusLine();
    this.statusLine.setClockMode(this.config.promptClock);
    this.tipIntervalMs = this.config.waitTipIntervalMin * 60 * 1000;
    this.tipIndex = Math.floor(Math.random() * WAITING_TIPS.length);

    this.commands = {
      help: {
        description: "コマンド一覧を表示 (例: help status)",
        detail: "引数なしで一覧表示。help <command> でコマンドの詳細を表示。",
        category: "info",
        handler: (args) => this.handleHelp(args),
      },
      "?": {
        description: "help のエイリアス",
        category: "info",
        handler: (args) => this.handleHelp(args),
      },
      history: {
        description: "地震履歴を取得・表示 (例: history 5)",
        detail: "dmdata.jp API から直近の地震履歴を取得します。\n  引数: 件数 (1〜100, デフォルト10)\n  例: history 20",
        category: "info",
        handler: (args) => this.handleHistory(args),
      },
      colors: {
        description: "カラーパレット・震度色の一覧を表示",
        detail: "CUD (カラーユニバーサルデザイン) パレットと、\n  震度・長周期地震動階級・フレームレベルに対応する色を確認できます。",
        category: "info",
        handler: () => this.handleColors(),
      },
      detail: {
        description: "直近の津波情報を再表示 (例: detail tsunami)",
        detail: "引数なし: 津波情報を再表示 (デフォルト)\n  detail tsunami: 津波情報を再表示",
        category: "info",
        subcommands: {
          tsunami: { description: "津波情報を再表示" },
        },
        handler: (args) => this.handleDetail(args),
      },
      status: {
        description: "WebSocket 接続状態を表示",
        detail: "現在の WebSocket 接続状態、SocketID、再接続試行回数を表示します。",
        category: "status",
        handler: () => this.handleStatus(),
      },
      config: {
        description: "現在の設定を表示",
        detail: "Configファイルに保存された設定を一覧表示します。",
        category: "status",
        handler: () => this.handleConfig(),
      },
      contract: {
        description: "契約区分一覧を表示",
        detail: "dmdata.jp で契約している区分を API から取得して表示します。",
        category: "status",
        handler: () => this.handleContract(),
      },
      socket: {
        description: "接続中のソケット一覧を表示",
        detail: "dmdata.jp で現在開いているソケット一覧を表示します。",
        category: "status",
        handler: () => this.handleSocket(),
      },
      notify: {
        description: "通知設定の表示・切替 (例: notify eew on)",
        detail: "引数なし: 現在の通知設定を一覧表示\n  notify <category>: トグル切替\n  notify <category> on: 有効にする\n  notify <category> off: 無効にする\n  notify all:on / all:off: 一括操作\n  カテゴリ: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation",
        category: "settings",
        subcommands: {
          "<category>": { description: "トグル切替 / on / off" },
          "all:on": { description: "全カテゴリを有効にする" },
          "all:off": { description: "全カテゴリを無効にする" },
        },
        handler: (args) => this.handleNotify(args),
      },
      eewlog: {
        description: "EEWログ記録の設定 (例: eewlog on / eewlog fields)",
        detail: "eewlog: 現在のログ記録設定を表示\n  eewlog on: ログ記録を有効にする\n  eewlog off: ログ記録を無効にする\n  eewlog fields: 記録項目の一覧表示 (グループ別)\n  eewlog fields <field>: 項目のトグル切替\n  eewlog fields <field> on/off: 項目の有効/無効\n  [震源] hypocenter, originTime, coordinates\n  [規模] magnitude\n  [変化] diff, maxIntChangeReason\n  [予測概要] forecastIntensity, maxLgInt\n  [予測地域] forecastAreas, lgIntensity, isPlum, hasArrived",
        category: "settings",
        subcommands: {
          on: { description: "ログ記録を有効にする" },
          off: { description: "ログ記録を無効にする" },
          fields: { description: "記録項目の一覧・切替" },
        },
        handler: (args) => this.handleEewLog(args),
      },
      tablewidth: {
        description: "テーブル幅の表示・変更 (例: tablewidth 80 / tablewidth auto)",
        detail: "引数なし: 現在のテーブル幅を表示\n  tablewidth <40〜200>: テーブル幅を固定値に変更\n  tablewidth auto: ターミナル幅に自動追従 (デフォルト)\n  変更は即座に反映され、Configファイルに保存されます。",
        category: "settings",
        subcommands: {
          "<40-200>": { description: "テーブル幅を固定値に変更" },
          auto: { description: "ターミナル幅に自動追従" },
        },
        handler: (args) => this.handleTableWidth(args),
      },
      infotext: {
        description: "お知らせ電文の全文/省略切替 (例: infotext full)",
        detail: "infotext full: 全文表示\n  infotext short: 省略表示 (デフォルト)",
        category: "settings",
        subcommands: {
          full: { description: "全文表示" },
          short: { description: "省略表示 (デフォルト)" },
        },
        handler: (args) => this.handleInfoText(args),
      },
      tipinterval: {
        description: "待機中ヒント表示間隔の表示・変更 (例: tipinterval 15)",
        detail: "tipinterval: 現在のヒント間隔(分)を表示\n  tipinterval <0〜1440>: ヒント間隔を分で変更 (0で無効)",
        category: "settings",
        subcommands: {
          "<0-1440>": { description: "ヒント間隔を分で変更 (0で無効)" },
        },
        handler: (args) => this.handleTipInterval(args),
      },
      mode: {
        description: "表示モード切替 (例: mode compact)",
        detail: "mode: 現在のモードを表示\n  mode normal: フルフレーム表示 (デフォルト)\n  mode compact: 1行サマリー表示\n  長時間モニタリング時は compact がおすすめです。",
        category: "settings",
        subcommands: {
          normal: { description: "フルフレーム表示 (デフォルト)" },
          compact: { description: "1行サマリー表示" },
        },
        handler: (args) => this.handleMode(args),
      },
      clock: {
        description: "プロンプト時計の切替 (例: clock / clock elapsed)",
        detail: "clock: 経過時間/現在時刻をトグル切替\n  clock elapsed: 経過時間表示 (デフォルト)\n  clock now: 現在時刻表示",
        category: "settings",
        subcommands: {
          elapsed: { description: "経過時間表示 (デフォルト)" },
          now: { description: "現在時刻表示" },
        },
        handler: (args) => this.handleClock(args),
      },
      sound: {
        description: "通知音の ON/OFF 切替",
        detail: "sound: 現在の状態を表示\n  sound on: 通知音を有効にする\n  sound off: 通知音を無効にする",
        category: "settings",
        subcommands: {
          on: { description: "通知音を有効にする" },
          off: { description: "通知音を無効にする" },
        },
        handler: (args) => this.handleSound(args),
      },
      theme: {
        description: "カラーテーマの表示・管理 (例: theme path / theme reload)",
        detail: "theme: テーマ概要を表示\n  theme path: theme.json のパスを表示\n  theme show: 全パレット色・全ロールスタイルを一覧表示\n  theme reset: デフォルト theme.json を書き出し\n  theme reload: theme.json を再読込\n  theme validate: theme.json を検証",
        category: "settings",
        subcommands: {
          path: { description: "theme.json のパスを表示" },
          show: { description: "全パレット色・ロールスタイル一覧" },
          reset: { description: "デフォルト theme.json を書き出し" },
          reload: { description: "theme.json を再読込" },
          validate: { description: "theme.json を検証" },
        },
        handler: (args) => this.handleTheme(args),
      },
      mute: {
        description: "通知を一時ミュート (例: mute 30m)",
        detail: "mute: 現在のミュート状態を表示\n  mute <duration>: 指定時間ミュート (例: 30m, 1h, 90s)\n  mute off: ミュート解除",
        category: "settings",
        subcommands: {
          "<duration>": { description: "指定時間ミュート (例: 30m, 1h)" },
          off: { description: "ミュート解除" },
        },
        handler: (args) => this.handleMute(args),
      },
      fold: {
        description: "観測点の表示件数制限 (例: fold 10 / fold off)",
        detail: "fold: 現在の設定を表示\n  fold <N>: 上位N件に制限\n  fold off: 全件表示に戻す",
        category: "settings",
        subcommands: {
          "<N>": { description: "観測点を上位N件に制限 (1〜999)" },
          off: { description: "全件表示に戻す" },
        },
        handler: (args) => this.handleFold(args),
      },
      test: {
        description: "テスト機能",
        detail: "test sound [level]: サウンドテスト\n  test table [type] [番号]: 表示形式テスト",
        category: "operation",
        subcommands: {
          sound: {
            description: "サウンドテスト",
            detail: "引数なし: 利用可能なサウンドレベル一覧を表示\n  test sound <level>: 指定レベルのサウンドを再生\n  レベル: critical, warning, normal, info, cancel",
          },
          table: {
            description: "表示形式テスト",
            detail: "引数なし: 利用可能な電文タイプ一覧を表示\n  test table <type>: バリエーション一覧を表示\n  test table <type> <番号>: 指定バリエーションを表示\n  タイプ: earthquake, eew, tsunami, seismicText, nankaiTrough, lgObservation",
          },
        },
        handler: (args) => this.handleTest(args),
      },
      clear: {
        description: "ターミナル画面をクリア",
        category: "operation",
        handler: () => this.handleClear(),
      },
      retry: {
        description: "WebSocket 再接続を試行",
        detail: "切断中の場合に手動で再接続を試みます。",
        category: "operation",
        handler: () => this.handleRetry(),
      },
      quit: {
        description: "アプリケーションを終了",
        category: "operation",
        handler: () => this.handleQuit(),
      },
      exit: {
        description: "quit のエイリアス",
        category: "operation",
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

    if (status.connected && status.heartbeatDeadlineAt != null) {
      const sec = Math.max(0, Math.ceil((status.heartbeatDeadlineAt - Date.now()) / 1000));
      parts.push(chalk.white(`ping in ${sec}s`));
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
      eewlog: {
        current: this.eewLogger.isEnabled()
          ? (() => {
            const fields = this.eewLogger.getFields();
            const onCount = Object.values(fields).filter(Boolean).length;
            return `ON (${onCount}/${Object.keys(fields).length}項目)`;
          })()
          : "OFF",
        options: "on / off / fields",
      },
    };
  }

  // ── コマンドハンドラ ──

  private handleDetail(args: string): void {
    const sub = args.trim().toLowerCase();

    // 引数なし or "tsunami" → 津波情報を再表示
    if (sub === "" || sub === "tsunami") {
      const provider = this.detailProviders.find((p) => p.category === "tsunami");
      if (provider == null || !provider.hasDetail()) {
        console.log(chalk.gray("  現在、継続中の津波情報はありません。"));
      } else {
        provider.showDetail();
      }
      return;
    }

    // 未知のサブコマンド
    console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`) + chalk.gray(" (利用可能: tsunami)"));
  }

  private handleHelp(args: string): void {
    const trimmed = args.trim();

    // help <command> [subcommand] — 詳細表示
    if (trimmed.length > 0) {
      const parts = trimmed.split(/\s+/);
      const entry = this.commands[parts[0]];
      if (entry == null) {
        console.log(chalk.yellow(`  不明なコマンド: ${parts[0]}`));
        return;
      }

      // サブコマンド解決
      if (parts.length > 1 && entry.subcommands) {
        const sub = entry.subcommands[parts[1]];
        if (sub == null) {
          console.log(chalk.yellow(`  不明なサブコマンド: ${parts[0]} ${parts[1]}`));
          return;
        }
        console.log();
        console.log(chalk.cyan.bold(`  ${parts[0]} ${parts[1]}`) + chalk.gray(` — ${sub.description}`));
        if (sub.detail) {
          console.log();
          for (const line of sub.detail.split("\n")) {
            console.log(chalk.white(`  ${line}`));
          }
        }
        console.log();
        return;
      }

      console.log();
      console.log(chalk.cyan.bold(`  ${parts[0]}`) + chalk.gray(` — ${entry.description}`));
      if (entry.detail) {
        console.log();
        for (const line of entry.detail.split("\n")) {
          console.log(chalk.white(`  ${line}`));
        }
      }
      // サブコマンド一覧
      if (entry.subcommands) {
        console.log();
        const subNames = Object.keys(entry.subcommands).sort();
        for (let i = 0; i < subNames.length; i++) {
          const subName = subNames[i];
          const sub = entry.subcommands[subName];
          const prefix = i < subNames.length - 1 ? "├─" : "└─";
          console.log(
            chalk.gray(`      ${prefix} `) + chalk.white(subName.padEnd(10)) + chalk.gray(sub.description)
          );
        }
      }
      console.log();
      return;
    }

    // help — カテゴリ別一覧
    console.log();
    console.log(chalk.cyan.bold("  利用可能なコマンド:"));

    const currentValues = this.getCurrentSettingValues();
    const displayed = new Set<string>();
    const categoryOrder: CommandCategory[] = ["info", "status", "settings", "operation"];

    for (const category of categoryOrder) {
      console.log();
      console.log(chalk.cyan(`  [${CATEGORY_LABELS[category]}]`));

      const commandNames = Object.keys(this.commands)
        .filter((name) => name !== "exit" && name !== "?" && this.commands[name].category === category)
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
          chalk.white(`    ${name.padEnd(14)}`) + chalk.gray(entry.description) + valueSuffix
        );
        // サブコマンドツリー表示
        if (entry.subcommands) {
          const subNames = Object.keys(entry.subcommands).sort();
          for (let i = 0; i < subNames.length; i++) {
            const subName = subNames[i];
            const sub = entry.subcommands[subName];
            const prefix = i < subNames.length - 1 ? "├─" : "└─";
            console.log(
              chalk.gray(`      ${prefix} `) + chalk.white(subName.padEnd(10)) + chalk.gray(sub.description)
            );
          }
        }
      }
    }

    console.log();
    console.log(chalk.gray("  エイリアス: ") + chalk.white("?") + chalk.gray(" → help, ") + chalk.white("exit") + chalk.gray(" → quit"));
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

    // 最新が一番下に来るように逆順で表示
    const items = [...res.items].reverse();
    for (const item of items) {
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
    const termWidth = process.stdout.columns || 80;
    const palette = themeModule.getPalette();

    const PALETTE_USAGE: Record<string, string> = {
      gray: "低優先度・補助テキスト",
      sky: "通常・長周期階級1",
      blue: "震度3",
      blueGreen: "震度4・津波なし",
      yellow: "震度5弱・M3+",
      orange: "警告レベル",
      vermillion: "危険レベル",
      raspberry: "取消・キャンセル",
      darkRed: "最高警戒 (背景用)",
    };

    // ── CUD カラーパレット ──
    console.log();
    console.log(chalk.cyan.bold("  CUD カラーパレット:"));
    if (themeModule.isCustomized()) {
      console.log(chalk.gray("  (カスタムテーマ適用中)"));
    }
    console.log();
    for (const name of themeModule.getPaletteNames()) {
      const rgb = palette[name];
      const swatch = chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
      const rgbStr = `(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      console.log(
        `  ${swatch} ` +
        chalk.white(name.padEnd(12)) +
        chalk.gray(rgbStr.padEnd(16)) +
        chalk.gray(PALETTE_USAGE[name] ?? "")
      );
    }

    // ── 震度カラー (マルチカラム) ──
    console.log();
    console.log(chalk.cyan.bold("  震度カラー:"));
    console.log();
    const intensityKeys = ["1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
    const intensities = intensityKeys.map((key) => {
      const label = `震度${key}`;
      const style = intensityColor(key);
      const role = getIntensityRole(key);
      const resolved = role ? themeModule.getRole(role) : null;
      return { label, key, style, resolved };
    });
    this.printColorGrid(termWidth, intensities, (item) => {
      if (item.resolved?.bg && item.resolved?.fg) {
        return this.renderFgBgItem(
          item.label,
          item.resolved.fg,
          item.resolved.bg,
          item.style,
        );
      }
      return { cell: `${item.style("██")} ${item.style(item.label)}`, visualLen: visualWidth(item.label) + 3 };
    });

    // ── 長周期地震動階級カラー (マルチカラム) ──
    console.log();
    console.log(chalk.cyan.bold("  長周期地震動階級カラー:"));
    console.log();
    const lgIntKeys = ["0", "1", "2", "3", "4"];
    const lgInts = lgIntKeys.map((key) => {
      const label = `階級${key}`;
      const style = lgIntensityColor(key);
      const role = getLgIntRole(key);
      const resolved = role ? themeModule.getRole(role) : null;
      return { label, key, style, resolved };
    });
    this.printColorGrid(termWidth, lgInts, (item) => {
      if (item.resolved?.bg && item.resolved?.fg) {
        return this.renderFgBgItem(
          item.label,
          item.resolved.fg,
          item.resolved.bg,
          item.style,
        );
      }
      return { cell: `${item.style("██")} ${item.style(item.label)}`, visualLen: visualWidth(item.label) + 3 };
    });

    // ── フレームレベル (マルチカラム) ──
    console.log();
    console.log(chalk.cyan.bold("  フレームレベル:"));
    console.log();
    const frameRoles: Array<{ name: string; role: themeModule.RoleName; label: string }> = [
      { name: "critical", role: "frameCritical", label: "[緊急] 二重線" },
      { name: "warning",  role: "frameWarning",  label: "[警告] 二重線" },
      { name: "normal",   role: "frameNormal",   label: "[情報] 通常" },
      { name: "info",     role: "frameInfo",      label: "[通知] 通常" },
      { name: "cancel",   role: "frameCancel",    label: "[取消] 通常" },
    ];
    this.printColorGrid(termWidth, frameRoles, (lv) => {
      const style = themeModule.getRoleChalk(lv.role);
      const text = `${lv.name} ${lv.label}`;
      return { cell: `${style("██")} ${style(text)}`, visualLen: visualWidth(text) + 3 };
    });
    console.log();
  }

  private handleTheme(args: string): void {
    const sub = args.trim().toLowerCase();

    if (sub === "" || sub === "info") {
      // テーマ概要
      const palette = themeModule.getPalette();
      console.log();
      console.log(chalk.cyan.bold("  カラーテーマ:"));
      console.log();
      // パレットスウォッチ (1行に全色)
      const swatches = themeModule.getPaletteNames().map((name) => {
        const rgb = palette[name];
        return chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
      });
      console.log(`  ${swatches.join(" ")}`);
      console.log();
      console.log(chalk.white(`  theme.json: `) + chalk.gray(themeModule.getThemePath()));
      console.log(chalk.white(`  カスタマイズ: `) + (themeModule.isCustomized() ? chalk.green("あり") : chalk.gray("なし (デフォルト)")));
      console.log();
      console.log(chalk.gray("  サブコマンド: theme path / show / reset / reload / validate"));
      console.log();
      return;
    }

    if (sub === "path") {
      console.log(`  ${themeModule.getThemePath()}`);
      return;
    }

    if (sub === "show") {
      this.handleThemeShow();
      return;
    }

    if (sub === "reset") {
      this.handleThemeReset();
      return;
    }

    if (sub === "reload") {
      const warnings = themeModule.reloadTheme();
      if (warnings.length === 0) {
        console.log(chalk.green("  テーマを再読込しました"));
      } else {
        console.log(chalk.yellow("  テーマを再読込しました (警告あり):"));
        for (const w of warnings) {
          console.log(chalk.yellow(`    ${w}`));
        }
      }
      return;
    }

    if (sub === "validate") {
      const { valid, warnings } = themeModule.validateThemeFile();
      if (valid && warnings.length === 0) {
        console.log(chalk.green("  theme.json に問題はありません"));
      } else if (valid) {
        console.log(chalk.yellow("  theme.json の検証結果:"));
        for (const w of warnings) {
          console.log(chalk.yellow(`    ${w}`));
        }
      } else {
        console.log(chalk.red("  theme.json に問題があります:"));
        for (const w of warnings) {
          console.log(chalk.red(`    ${w}`));
        }
      }
      return;
    }

    console.log(chalk.yellow(`  不明なサブコマンド: ${args.trim()}`));
    console.log(chalk.gray("  使い方: theme / theme path / theme show / theme reset / theme reload / theme validate"));
  }

  private handleThemeShow(): void {
    const termWidth = process.stdout.columns || 80;
    const palette = themeModule.getPalette();

    console.log();
    console.log(chalk.cyan.bold("  パレット:"));
    console.log();
    for (const name of themeModule.getPaletteNames()) {
      const rgb = palette[name];
      const swatch = chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
      const hex = themeModule.rgbToHex(rgb);
      console.log(`  ${swatch} ${chalk.white(name.padEnd(12))} ${chalk.gray(hex)}`);
    }

    console.log();
    console.log(chalk.cyan.bold("  ロール:"));
    console.log();
    const roleNames = themeModule.getRoleNames();
    const maxNameLen = Math.max(...roleNames.map((n) => n.length));
    for (const name of roleNames) {
      const style = themeModule.getRoleChalk(name);
      const resolved = themeModule.getRole(name);
      const parts: string[] = [];
      if (resolved.fg) parts.push(`fg: ${themeModule.rgbToHex(resolved.fg)}`);
      if (resolved.bg) parts.push(`bg: ${themeModule.rgbToHex(resolved.bg)}`);
      if (resolved.bold) parts.push("bold");
      const preview = style("Sample");
      console.log(
        `  ${chalk.white(name.padEnd(maxNameLen + 1))} ${preview}  ${chalk.gray(parts.join(", "))}`
      );
    }
    console.log();
  }

  private handleThemeReset(): void {
    if (!this.rl) return;
    const rl = this.rl;
    rl.question(
      chalk.yellow("  デフォルトの theme.json を書き出しますか？ (y/N) "),
      (answer: string) => {
        if (answer.trim().toLowerCase() === "y") {
          try {
            const warnings = themeModule.resetTheme();
            console.log(chalk.green(`  theme.json を書き出しました: ${themeModule.getThemePath()}`));
            if (warnings.length > 0) {
              for (const w of warnings) {
                console.log(chalk.yellow(`    ${w}`));
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "不明なエラー";
            console.log(chalk.red(`  theme.json の書き出しに失敗しました: ${msg}`));
          }
        } else {
          console.log(chalk.gray("  キャンセルしました"));
        }
        rl.setPrompt(this.buildPromptString());
        rl.prompt();
      }
    );
  }

  /**
   * fg/bg 分離表示用のセルを生成する。
   * 文字色 ██ と背景色 ██ を横に並べ、ラベルは実際の表示スタイル(fg+bg)で表示する。
   */
  private renderFgBgItem(
    label: string,
    fg: readonly [number, number, number],
    bg: readonly [number, number, number],
    style: chalk.Chalk,
  ): { cell: string; visualLen: number } {
    const fgBlock = chalk.rgb(fg[0], fg[1], fg[2])("██");
    const bgBlock = chalk.bgRgb(bg[0], bg[1], bg[2])("  ");
    // "██ ██ label" → swatch(2) + space(1) + swatch(2) + space(1) + label
    return { cell: `${fgBlock} ${bgBlock} ${style(label)}`, visualLen: visualWidth(label) + 6 };
  }

  /**
   * 色付きアイテムをターミナル幅に応じたマルチカラムで出力する。
   * renderFn は各アイテムから { cell, visualLen } を返す。
   */
  private printColorGrid<T>(
    termWidth: number,
    items: T[],
    renderFn: (item: T) => { cell: string; visualLen: number },
  ): void {
    const rendered = items.map(renderFn);
    // 最大表示幅 + マージンでカラム幅を決定
    const maxVisual = Math.max(...rendered.map((r) => r.visualLen));
    const colWidth = maxVisual + 3; // 右余白
    const indent = 2;
    const cols = Math.max(1, Math.floor((termWidth - indent) / colWidth));

    let line = "";
    let col = 0;
    for (const r of rendered) {
      const pad = colWidth - r.visualLen;
      line += r.cell + " ".repeat(Math.max(0, pad));
      col++;
      if (col >= cols) {
        console.log(`${" ".repeat(indent)}${line}`);
        line = "";
        col = 0;
      }
    }
    if (line.length > 0) {
      console.log(`${" ".repeat(indent)}${line}`);
    }
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

  private handleFold(args: string): void {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      const current = getMaxObservations();
      if (current == null) {
        console.log("  観測点表示: 全件表示");
      } else {
        console.log(`  観測点表示: 上位 ${current} 件に制限`);
      }
      console.log(chalk.gray("  使い方: fold <N> / fold off"));
      return;
    }

    if (trimmed === "off") {
      setMaxObservations(null);
      this.config.maxObservations = null;
      const config = loadConfig();
      delete config.maxObservations;
      saveConfig(config);
      console.log("  観測点表示を全件表示に戻しました。");
      return;
    }

    const n = Number(trimmed);
    if (isNaN(n) || !Number.isInteger(n) || n < 1 || n > 999) {
      console.log(chalk.yellow("  1〜999 の整数、または off を指定してください。"));
      return;
    }

    setMaxObservations(n);
    this.config.maxObservations = n;
    const config = loadConfig();
    config.maxObservations = n;
    saveConfig(config);
    console.log(`  観測点表示を上位 ${n} 件に制限しました。`);
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

  private handleEewLog(args: string): void {
    const trimmed = args.trim();

    // 引数なし → 現在の設定を表示
    if (trimmed.length === 0) {
      const enabled = this.eewLogger.isEnabled();
      const status = enabled ? chalk.green("ON") : chalk.red("OFF");
      console.log();
      console.log(chalk.cyan.bold("  EEW ログ記録:") + ` ${status}`);
      if (enabled) {
        console.log();
        const fields = this.eewLogger.getFields();
        for (const group of EEW_LOG_FIELD_GROUPS) {
          console.log(chalk.cyan(`  [${group.label}]`));
          for (const field of group.fields) {
            const fieldEnabled = fields[field];
            const fieldStatus = fieldEnabled ? chalk.green("ON") : chalk.red("OFF");
            console.log(
              chalk.white(`    ${field.padEnd(22)}`) +
                chalk.gray(`${EEW_LOG_FIELD_LABELS[field]}  `) +
                fieldStatus
            );
          }
        }
      }
      console.log();
      console.log(
        chalk.gray("  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]")
      );
      console.log();
      return;
    }

    // on / off
    if (trimmed === "on") {
      this.eewLogger.setEnabled(true);
      this.config.eewLog = true;
      const config = loadConfig();
      config.eewLog = true;
      saveConfig(config);
      console.log(`  EEW ログ記録を ${chalk.green("ON")} にしました。`);
      return;
    }
    if (trimmed === "off") {
      this.eewLogger.setEnabled(false);
      this.config.eewLog = false;
      const config = loadConfig();
      config.eewLog = false;
      saveConfig(config);
      console.log(`  EEW ログ記録を ${chalk.red("OFF")} にしました。`);
      return;
    }

    // fields サブコマンド
    if (trimmed === "fields") {
      const fields = this.eewLogger.getFields();
      console.log();
      console.log(chalk.cyan.bold("  EEW ログ記録項目:"));
      console.log();
      for (const group of EEW_LOG_FIELD_GROUPS) {
        console.log(chalk.cyan(`  [${group.label}]`));
        for (const field of group.fields) {
          const fieldEnabled = fields[field];
          const fieldStatus = fieldEnabled ? chalk.green("ON") : chalk.red("OFF");
          console.log(
            chalk.white(`    ${field.padEnd(22)}`) +
              chalk.gray(`${EEW_LOG_FIELD_LABELS[field]}  `) +
              fieldStatus
          );
        }
      }
      console.log();
      return;
    }

    // fields <field> [on|off]
    if (trimmed.startsWith("fields ")) {
      const parts = trimmed.slice(7).trim().split(/\s+/);
      const fieldName = parts[0] as EewLogField;
      const action = parts[1]?.toLowerCase();

      if (!VALID_EEW_LOG_FIELDS.includes(fieldName)) {
        console.log(
          chalk.yellow(`  不明な項目: ${parts[0]}`) +
            chalk.gray(` (有効: ${VALID_EEW_LOG_FIELDS.join(", ")})`)
        );
        return;
      }

      let newState: boolean;
      const fields = this.eewLogger.getFields();
      if (action === "on") {
        if (fields[fieldName]) {
          console.log(`  ${EEW_LOG_FIELD_LABELS[fieldName]} (${fieldName}): 既に ${chalk.green("ON")} です`);
          return;
        }
        newState = this.eewLogger.toggleField(fieldName);
      } else if (action === "off") {
        if (!fields[fieldName]) {
          console.log(`  ${EEW_LOG_FIELD_LABELS[fieldName]} (${fieldName}): 既に ${chalk.red("OFF")} です`);
          return;
        }
        newState = this.eewLogger.toggleField(fieldName);
      } else {
        newState = this.eewLogger.toggleField(fieldName);
      }

      const label = EEW_LOG_FIELD_LABELS[fieldName];
      const status = newState ? chalk.green("ON") : chalk.red("OFF");
      console.log(`  ${label} (${fieldName}): ${status}`);

      // 設定を永続化
      const config = loadConfig();
      config.eewLogFields = this.eewLogger.getFields();
      saveConfig(config);
      return;
    }

    console.log(chalk.yellow("  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]"));
  }

  private handleTest(args: string): void {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? "";

    if (sub === "") {
      const testEntry = this.commands["test"];
      console.log();
      console.log(chalk.cyan.bold("  test サブコマンド:"));
      if (testEntry.subcommands) {
        for (const [name, sc] of Object.entries(testEntry.subcommands)) {
          console.log(chalk.white(`    ${name.padEnd(14)}`) + chalk.gray(sc.description));
        }
      }
      console.log();
      console.log(chalk.gray("  詳細: help test <subcommand>"));
      console.log();
      return;
    }

    if (sub === "sound") {
      this.handleTestSound(parts.slice(1).join(" "));
      return;
    }

    if (sub === "table") {
      this.handleTestTable(parts.slice(1).join(" "));
      return;
    }

    console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`) + chalk.gray(" (sound / table)"));
  }

  private handleTestSound(args: string): void {
    const level = args.trim();

    if (level === "") {
      console.log();
      console.log(chalk.cyan.bold("  利用可能なサウンドレベル:"));
      for (const l of SOUND_LEVELS) {
        console.log(chalk.white(`    ${l}`));
      }
      console.log();
      console.log(chalk.gray("  使い方: test sound <level>"));
      console.log();
      return;
    }

    if (!isSoundLevel(level)) {
      console.log(chalk.yellow(`  不明なサウンドレベル: ${level}`));
      console.log(chalk.gray(`  有効な値: ${SOUND_LEVELS.join(", ")}`));
      return;
    }

    console.log(chalk.gray(`  サウンドテスト: ${level} を再生中...`));
    playSound(level);
  }

  private handleTestTable(args: string): void {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const type = parts[0] ?? "";
    const variantArg = parts[1];

    if (type === "") {
      console.log();
      console.log(chalk.cyan.bold("  利用可能な電文タイプ:"));
      for (const [key, entry] of Object.entries(TEST_TABLES)) {
        const count = entry.variants.length;
        console.log(
          chalk.white(`    ${key.padEnd(16)}`) +
            chalk.gray(`${entry.label}`) +
            chalk.gray(` (${count}件)`),
        );
      }
      console.log();
      console.log(chalk.gray("  使い方: test table <type> [番号]"));
      console.log();
      return;
    }

    const entry = TEST_TABLES[type];
    if (entry == null) {
      console.log(chalk.yellow(`  不明な電文タイプ: ${type}`));
      console.log(
        chalk.gray(`  有効な値: ${Object.keys(TEST_TABLES).join(", ")}`),
      );
      return;
    }

    // 番号指定なし → バリエーション一覧を表示
    if (variantArg == null) {
      console.log();
      console.log(chalk.cyan.bold(`  ${entry.label} バリエーション:`));
      for (const [i, v] of entry.variants.entries()) {
        console.log(chalk.white(`    ${String(i + 1).padEnd(4)}`) + chalk.gray(v.label));
      }
      console.log();
      console.log(chalk.gray(`  使い方: test table ${type} <番号>`));
      console.log();
      return;
    }

    const variantNum = parseInt(variantArg, 10);
    if (isNaN(variantNum) || variantNum < 1 || variantNum > entry.variants.length) {
      console.log(
        chalk.yellow(`  不明な番号: ${variantArg} (1〜${entry.variants.length})`),
      );
      return;
    }

    const variant = entry.variants[variantNum - 1];
    console.log(
      chalk.gray(`  表示テスト: ${entry.label} #${variantNum} ${variant.label}`),
    );
    variant.run();
  }

  private handleClear(): void {
    console.clear();
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
    if (!this.rl || this.commandRunning) return;
    if (this.tipIntervalMs <= 0 || this.nextTipAt == null) return;
    const status = this.wsManager.getStatus();
    if (!status.connected) return;

    const lastMessageAt = this.statusLine.getLastMessageTime();
    if (lastMessageAt != null && Date.now() - lastMessageAt < 10_000) return;
    if (Date.now() < this.nextTipAt) return;

    this.clearInput();
    const tip = WAITING_TIPS[this.tipIndex % WAITING_TIPS.length];
    this.tipIndex++;
    do {
      this.nextTipAt += this.tipIntervalMs;
    } while (this.nextTipAt <= Date.now());
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
