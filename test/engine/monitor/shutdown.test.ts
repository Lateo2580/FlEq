import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManager } from "../../../src/dmdata/connection-manager";
import type { EewEventLogger } from "../../../src/engine/eew/eew-logger";
import { createShutdownHandler } from "../../../src/engine/monitor/shutdown";

vi.mock("../../../src/dmdata/rest-client", () => ({
  closeSocket: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/logger", () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

describe("shutdown legacy counterpart disposal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const shutdown = createShutdownHandler({
      apiKey: "test-key",
      manager,
      eewLogger,
      getReplHandler: () => null,
      resetTerminalTitle: vi.fn(),
      disposeLegacyCounterpartCorrelator,
    });

    await shutdown();
    await shutdown();

    expect(disposeLegacyCounterpartCorrelator).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
