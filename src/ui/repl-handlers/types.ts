import readline from "readline";
import { AppConfig, ConfigFile, NotifyCategory, DetailProvider, PromptStatusProvider } from "../../types";
import { ConnectionManager } from "../../dmdata/connection-manager";
import { Notifier } from "../../engine/notification/notifier";
import { EewEventLogger } from "../../engine/eew/eew-logger";
import type { EventFileWriter } from "../../engine/events/event-file-writer";
import { StatusLine } from "../status-line";
import type { PipelineController } from "../../engine/filter-template/pipeline-controller";
import { TelegramStats } from "../../engine/messages/telegram-stats";
import { SummaryWindowTracker } from "../../engine/messages/summary-tracker";
import type { SummaryTimerControl } from "../../engine/monitor/monitor";

/** コマンドのカテゴリ */
export type CommandCategory = "info" | "status" | "settings" | "operation";

/** カテゴリ表示名 */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  info: "情報",
  status: "ステータス",
  settings: "設定",
  operation: "操作",
};

export interface SubcommandEntry {
  description: string;
  detail?: string;
}

export interface CommandEntry {
  description: string;
  detail?: string;
  category: CommandCategory;
  subcommands?: Record<string, SubcommandEntry>;
  handler: (args: string) => void | Promise<void>;
}

/** コマンドハンドラが参照する ReplHandler のコンテキスト */
export interface ReplContext {
  config: AppConfig;
  wsManager: ConnectionManager;
  notifier: Notifier;
  eewLogger: EewEventLogger;
  eventFileWriter: EventFileWriter;
  statusLine: StatusLine;
  stats: TelegramStats;
  statusProviders: PromptStatusProvider[];
  detailProviders: DetailProvider[];
  pipelineController: PipelineController | null;
  summaryTracker: SummaryWindowTracker | null;
  summaryTimerControl: SummaryTimerControl | null;
  summaryIntervalMin: number | null;
  filterExpr: string | null;
  filterUpdatedAt: Date | null;
  focusExpr: string | null;
  focusUpdatedAt: Date | null;
  tipIntervalMs: number;
  commands: Record<string, CommandEntry>;
  rl: readline.Interface | null;
  onQuit: () => void | Promise<void>;

  /** loadConfig → updater → saveConfig ヘルパー */
  updateConfig(updater: (config: ConfigFile) => void): void;

  /** プロンプト文字列の構築 */
  buildPromptString(): string;

  /** REPL を停止する */
  stop(): void;

  /** ヒント表示スケジュールのリセット */
  resetTipSchedule(): void;
}
