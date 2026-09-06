import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  registerReplayCommand,
  type ReplayRunnerLoader,
} from "../../../src/engine/cli/cli-replay";
import { VPBS50_REPLAY_FIXTURES } from "../../../src/engine/replay/vpbs50-envelope";

function buildReplayProgram(loader: ReplayRunnerLoader): Command {
  const program = new Command().name("fleq").exitOverride();
  program.option("--display-port <port>");
  registerReplayCommand(program, loader);
  return program;
}

function replayArgs(stateDir: string, port: number, beforeCommand = false): string[] {
  const fixtures = VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path);
  const portArgs = ["--display-port", String(port)];
  return [
    "node",
    "fleq",
    ...(beforeCommand ? portArgs : []),
    "replay",
    ...fixtures,
    "--state-dir",
    stateDir,
    ...(beforeCommand ? [] : portArgs),
    "--interval",
    "0",
  ];
}

describe("Phase 1 replay CLI validation and lazy loading", () => {
  it("7788/範囲外は option 位置によらず runner import・state-dir 作成前に拒否する", async () => {
    for (const port of [7788, 70000]) {
      for (const beforeCommand of [false, true]) {
        const stateDir = resolve(
          `.tmp-replay-cli-invalid-${port}-${beforeCommand}-${process.pid}-${Date.now()}`,
        );
        const loader = vi.fn<ReplayRunnerLoader>();
        await expect(buildReplayProgram(loader).parseAsync(replayArgs(
          stateDir,
          port,
          beforeCommand,
        ))).rejects.toThrow(port === 7788 ? /reserved/ : /0 to 65535/);
        expect(loader).not.toHaveBeenCalled();
        expect(existsSync(stateDir)).toBe(false);
      }
    }
  });

  it("有効な replay action だけが runner graph を lazy load する", async () => {
    const runVpBs50Replay = vi.fn(async () => undefined);
    const loader = vi.fn<ReplayRunnerLoader>(async () => ({ runVpBs50Replay }));
    const stateDir = resolve(`.tmp-replay-cli-lazy-${process.pid}-${Date.now()}`);
    await buildReplayProgram(loader).parseAsync(replayArgs(stateDir, 0));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runVpBs50Replay).toHaveBeenCalledWith({
      fixturePaths: VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path),
      stateDir,
      displayPort: 0,
      intervalMs: 0,
      hold: false,
    });
    expect(existsSync(stateDir)).toBe(false);
  });
});
