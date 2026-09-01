import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManager } from "../../../src/dmdata/connection-manager";
import type { EewEventLogger } from "../../../src/engine/eew/eew-logger";
import {
  createShutdownHandler,
  registerShutdownSignals,
  runShutdownAndRecordExitCode,
  type ShutdownContext,
  type ShutdownResult,
} from "../../../src/engine/monitor/shutdown";
import type { StandbyPersistenceWriteFailureStage } from "../../../src/engine/display/standby-persistence";

vi.mock("../../../src/dmdata/rest-client", () => ({
  closeSocket: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/logger", () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

describe("shutdown legacy counterpart disposal", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function context(over: Partial<ShutdownContext> = {}): {
    context: ShutdownContext;
    cleanup: ReturnType<typeof vi.fn>[];
  } {
    const cleanup = Array.from({ length: 13 }, () => vi.fn());
    const manager = {
      getStatus: () => ({ socketId: null }),
      close: cleanup[9],
    } as unknown as ConnectionManager;
    const eewLogger = {
      closeAll: cleanup[3],
      flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as EewEventLogger;
    return {
      cleanup,
      context: {
        apiKey: "test-key", manager, eewLogger, getReplHandler: () => ({ stop: cleanup[8] }) as never,
        resetTerminalTitle: cleanup[10], stopSummaryTimer: cleanup[0],
        flushAndDisposeVolcanoBuffer: cleanup[1], disposeLegacyCounterpartCorrelator: cleanup[2],
        stopDisplayRuntime: vi.fn().mockResolvedValue(undefined), stopStandbySweep: cleanup[4],
        flushDetailCaches: cleanup[5], flushWeatherPromotion: cleanup[6],
        flushQuakeExtreme: cleanup[7], flushQuakeDisplay: cleanup[11], flushDailyQuake: cleanup[12],
        ...over,
      },
    };
  }

  it("shutdownはlegacy correlator disposeを一回だけ呼び二重実行しない", async () => {
    const close = vi.fn();
    const manager = {
      getStatus: () => ({ socketId: null }),
      close,
    } as unknown as ConnectionManager;
    const closeAll = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const eewLogger = { closeAll, flush } as unknown as EewEventLogger;
    const disposeLegacyCounterpartCorrelator = vi.fn();
    const shutdown = createShutdownHandler({
      apiKey: "test-key",
      manager,
      eewLogger,
      getReplHandler: () => null,
      resetTerminalTitle: vi.fn(),
      disposeLegacyCounterpartCorrelator,
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    expect(await first).toEqual({ kind: "completed", exitCode: 0 });

    expect(disposeLegacyCounterpartCorrelator).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("typed save success returns exitCode 0", async () => {
    const fixture = context({
      stopStandbySweep: vi.fn(() => ({
        kind: "written" as const, requestedSeq: 1, writtenSeq: 1,
        v2Committed: true as const, v1Committed: true as const,
      })),
    });
    await expect(createShutdownHandler(fixture.context)()).resolves.toEqual({
      kind: "completed", exitCode: 0,
    });
  });

  it.each([
    "validation", "salvageBackup", "mkdir", "writeV2Temp", "writeV1Temp", "renameV2", "renameV1",
  ] as const)("standby %s failure returns exitCode 1 and still runs every cleanup", async (stage) => {
    const fixture = context({
      stopStandbySweep: vi.fn(() => ({
        kind: "failed" as const, requestedSeq: 1, failedSeq: 1, stage,
        pendingRetained: true as const, partialCommit: stage === "renameV1" ? "v2Only" as const : "none" as const,
        cause: new Error(stage),
      })),
    });
    const result = await createShutdownHandler(fixture.context)();
    expect(result).toEqual({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "standbyPersistence", stage }],
    });
    expect(fixture.cleanup.filter((_, index) => index !== 4)
      .every((operation) => operation.mock.calls.length === 1)).toBe(true);
  });

  it("exportActiveState throw is typed and remaining cleanup continues", async () => {
    const fixture = context({ stopStandbySweep: () => { throw new Error("export failed"); } });
    const result = await createShutdownHandler(fixture.context)();
    expect(result).toEqual({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "standbyPersistence", stage: "exportActiveState" }],
    });
    expect(fixture.cleanup.filter((_, index) => index !== 4)
      .every((operation) => operation.mock.calls.length === 1)).toBe(true);
  });

  it("unexpected cleanup failure is recorded without aborting later cleanup", async () => {
    const fixture = context({ stopSummaryTimer: () => { throw new Error("unexpected"); } });
    const result = await createShutdownHandler(fixture.context)();
    expect(result).toMatchObject({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    });
    expect(fixture.cleanup.slice(1).every((operation) => operation.mock.calls.length === 1)).toBe(true);
  });

  it.each(["loggerFlush", "displayStop"] as const)(
    "async %s failure is unexpected and later cleanup still runs",
    async (operation) => {
      const fixture = operation === "loggerFlush"
        ? context({
            eewLogger: {
              closeAll: vi.fn(),
              flush: vi.fn().mockRejectedValue(new Error("flush failed")),
            } as unknown as EewEventLogger,
          })
        : context({ stopDisplayRuntime: vi.fn().mockRejectedValue(new Error("display failed")) });
      const result = await createShutdownHandler(fixture.context)();
      expect(result).toMatchObject({
        kind: "failed",
        exitCode: 1,
        failures: [{ operation: "shutdown", stage: "unexpected" }],
      });
      expect(fixture.cleanup[9]).toHaveBeenCalledTimes(1);
      expect(fixture.cleanup[10]).toHaveBeenCalledTimes(1);
    },
  );

  it("REPL lookup failure is recorded without aborting socket and terminal cleanup", async () => {
    const fixture = context({ getReplHandler: () => { throw new Error("lookup failed"); } });
    const result = await createShutdownHandler(fixture.context)();
    expect(result).toEqual({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    });
    expect(fixture.cleanup[9]).toHaveBeenCalledTimes(1);
    expect(fixture.cleanup[10]).toHaveBeenCalledTimes(1);
  });

  it("socket discovery failure is recorded without aborting terminal cleanup", async () => {
    const fixture = context({
      manager: {
        getStatus: () => { throw new Error("status failed"); },
        close: vi.fn(),
      } as unknown as ConnectionManager,
    });
    const result = await createShutdownHandler(fixture.context)();
    expect(result).toEqual({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    });
    expect(fixture.context.manager.close).toHaveBeenCalledTimes(1);
    expect(fixture.cleanup[10]).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "completed", exitCode: 0 } as ShutdownResult, 0],
    [{ kind: "failed", exitCode: 1, failures: [{ operation: "standbyPersistence", stage: "validation" as StandbyPersistenceWriteFailureStage }] } as ShutdownResult, 1],
  ] as const)("result adapter records its exitCode", async (result, exitCode) => {
    await expect(runShutdownAndRecordExitCode(async () => result)).resolves.toBe(result);
    expect(process.exitCode).toBe(exitCode);
  });

  it("result adapter turns an unexpected rejection into exitCode 1", async () => {
    const result = await runShutdownAndRecordExitCode(async () => { throw new Error("unexpected"); });
    expect(result).toEqual({
      kind: "failed", exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["success", { kind: "completed", exitCode: 0 } as ShutdownResult],
    ["failure", { kind: "failed", exitCode: 1, failures: [{ operation: "standbyPersistence", stage: "renameV1" }] } as ShutdownResult],
  ] as const)("signal wrapper exits once with the %s result code", async (_label, result) => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const shutdown = vi.fn().mockResolvedValue(result);
    registerShutdownSignals(shutdown);
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(result.exitCode));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(result.exitCode);
  });

  it("coalesces repeated signals before shutdown resolves", async () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    let resolveShutdown: ((result: ShutdownResult) => void) | undefined;
    const shutdown = vi.fn(() => new Promise<ShutdownResult>((resolve) => { resolveShutdown = resolve; }));
    registerShutdownSignals(shutdown);
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    expect(shutdown).toHaveBeenCalledTimes(1);
    resolveShutdown?.({ kind: "completed", exitCode: 0 });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
