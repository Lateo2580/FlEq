import chalk from "chalk";
import { PromptClock } from "../types";
import { formatElapsedTime } from "../ui/formatter";

/** 現在時刻を HH:mm:ss 形式で返す */
function formatCurrentTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export class StatusLine {
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

  /**
   * プロンプト用プレフィックスを生成する。
   * @param options.noSuffix true のときは末尾の "]> " を付与しない
   */
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

  getLastMessageTime(): number | null {
    return this.lastMessageTime;
  }

  /** プロンプト経過時間の基準時刻を返す (lastMessageTime ?? connectedAt) */
  getElapsedBase(): number | null {
    return this.lastMessageTime ?? this.connectedAt;
  }
}
