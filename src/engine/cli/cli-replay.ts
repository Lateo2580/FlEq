import type { Command } from "commander";

interface ReplayCommandOptions {
  stateDir: string;
  interval: string;
  hold?: boolean;
}

interface ReplayRunnerModule {
  runVpBs50Replay(options: {
    fixturePaths: readonly string[];
    stateDir: string;
    displayPort: number;
    intervalMs: number;
    hold: boolean;
  }): Promise<void>;
}

export type ReplayRunnerLoader = () => Promise<ReplayRunnerModule>;

function integerOption(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function replayDisplayPort(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== "string") throw new Error("--display-port must be a non-negative integer");
  const port = integerOption(value, "--display-port");
  if (port > 65535) throw new Error("--display-port must be an integer from 0 to 65535");
  if (port === 7788) throw new Error("--display-port 7788 is reserved for production");
  return port;
}

export function registerReplayCommand(
  program: Command,
  loadReplayRunner: ReplayRunnerLoader = () => import("../replay/vpbs50-runner"),
): void {
  program
    .command("replay <prediction-fixture> <occurrence-fixture>")
    .description("固定 VPBS50 2 通を隔離 runtime で replay します")
    .requiredOption("--state-dir <dir>", "空の replay 専用 state directory")
    .option("--interval <ms>", "電文間の wall-clock 待ち時間", "1000")
    .option("--hold", "外部 SSE client を待ち、終了後も表示を保持します")
    .action(async (
      predictionFixture: string,
      occurrenceFixture: string,
      opts: ReplayCommandOptions,
      command: Command,
    ) => {
      const displayPort = replayDisplayPort(command.optsWithGlobals().displayPort);
      const intervalMs = integerOption(opts.interval, "--interval");
      const { runVpBs50Replay } = await loadReplayRunner();
      await runVpBs50Replay({
        fixturePaths: [predictionFixture, occurrenceFixture],
        stateDir: opts.stateDir,
        displayPort,
        intervalMs,
        hold: opts.hold === true,
      });
    });
}
