import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTsunamiRestoreRetryController,
  TSUNAMI_RESTORE_MAX_ATTEMPTS,
} from "../../../src/engine/startup/tsunami-restore-retry";
import type { TsunamiRestoreAttemptResult } from "../../../src/engine/startup/tsunami-initializer";
import { restoreTsunamiState } from "../../../src/engine/startup/tsunami-initializer";
import { runTsunamiRestoreStartupPhase } from "../../../src/engine/monitor/monitor";
import { createShutdownHandler } from "../../../src/engine/monitor/shutdown";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import type { TelegramListResponse } from "../../../src/types";
import type { ConnectionManager } from "../../../src/dmdata/connection-manager";
import type { EewEventLogger } from "../../../src/engine/eew/eew-logger";
import * as log from "../../../src/logger";

const REAL_LIST = JSON.parse(
  fs.readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8"),
) as TelegramListResponse;
const REAL_XML = fs.readFileSync("test/fixtures/rest/telegram-body-vtse41-real.xml", "utf8");
const REAL_ITEM = REAL_LIST.items[0];
const REST_NOW = Date.parse(REAL_ITEM.head.time) + 60_000;
const listResponse = (items = [REAL_ITEM]): TelegramListResponse => ({
  responseId: "retry-test", responseTime: new Date(REST_NOW).toISOString(), status: "ok", items,
});

const retryable = (reason: "listUnavailable" | "staleVersion" = "listUnavailable"): TsunamiRestoreAttemptResult => ({
  kind: "incomplete", changed: false, retryable: true, reason,
});
const success = (): TsunamiRestoreAttemptResult => ({ kind: "noData", changed: false });

describe("tsunami REST restore retry controller", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("§5.20 uses exact 5/10/20/40/80/160/300 second backoff and stops after success", async () => {
    const startedAt: number[] = [];
    const attempt = vi.fn(async () => {
      startedAt.push(Date.now());
      return startedAt.length === 8 ? success() : retryable();
    });
    const controller = createTsunamiRestoreRetryController({ attempt });
    await controller.runInitial();
    controller.enableBackgroundRetries();
    for (const delay of [5, 10, 20, 40, 80, 160, 300]) {
      await vi.advanceTimersByTimeAsync(delay * 1_000);
    }
    expect(startedAt.map((value, index) => index === 0 ? value : value - startedAt[index - 1]))
      .toEqual([0, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    expect(attempt).toHaveBeenCalledTimes(8);
    expect(controller.status().pending).toBe(false);
  });

  it("§5.20 stops immediately on non-retryable failure", async () => {
    const attempt = vi.fn(async (): Promise<TsunamiRestoreAttemptResult> => ({
      kind: "incomplete", changed: false, retryable: false, reason: "parseFailed",
    }));
    const controller = createTsunamiRestoreRetryController({ attempt });
    await controller.runInitial(); controller.enableBackgroundRetries();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("§5.20 emits retryExhausted exactly once after eight attempts", async () => {
    const warn = vi.fn();
    const attempt = vi.fn(async () => retryable("staleVersion"));
    const controller = createTsunamiRestoreRetryController({ attempt, warn });
    await controller.runInitial(); controller.enableBackgroundRetries();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(TSUNAMI_RESTORE_MAX_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[tsunami-restore] retryExhausted attempts=8 reason=staleVersion");
  });

  it.each(["resolve", "reject"] as const)("review #3 / §5.12/5.21 monitor wiring waits for volcano %s, then real initializer retry commits once", async (mode) => {
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const callback = vi.fn();
    let listCalls = 0;
    const loadPage = vi.fn(async () => {
      listCalls += 1;
      if (listCalls <= 8) return listCalls % 2 === 1 ? listResponse() : listResponse([]);
      return listResponse();
    });
    const loadBody = vi.fn(async () => ({ kind: "ok" as const, xml: REAL_XML }));
    const attempt = vi.fn(({ isCurrent }: { isCurrent: () => boolean }) => restoreTsunamiState(
      "key", state, gate, callback, undefined,
      { now: () => REST_NOW, loadPage, loadBody, isCurrent },
    ));
    const controller = createTsunamiRestoreRetryController({ attempt });
    let volcanoStarted!: () => void;
    const started = new Promise<void>((resolve) => { volcanoStarted = resolve; });
    let settleVolcano!: () => void;
    const volcano = new Promise<void>((resolve, reject) => {
      settleVolcano = () => mode === "resolve" ? resolve() : reject(new Error("repair"));
    });
    const phase = runTsunamiRestoreStartupPhase(controller, () => {
      volcanoStarted();
      return volcano;
    });
    await started;
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledTimes(8);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    settleVolcano();
    if (mode === "resolve") await phase;
    else await expect(phase).rejects.toThrow("repair");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(loadPage).toHaveBeenCalledTimes(10);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(state.hasPersistedEvent(REAL_ITEM.xmlReport!.head.eventId!)).toBe(true);
  });

  it("§5.20 ignores duplicate starts while an attempt is in flight", async () => {
    const deferred: { resolve?: (result: TsunamiRestoreAttemptResult) => void } = {};
    const attempt = vi.fn(() => new Promise<TsunamiRestoreAttemptResult>((resolve) => { deferred.resolve = resolve; }));
    const controller = createTsunamiRestoreRetryController({ attempt });
    const first = controller.runInitial();
    controller.enableBackgroundRetries();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    deferred.resolve?.(success());
    await first;
    expect(controller.status().inFlight).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("review #3 / §5.22 shutdown abandons a real initializer after deferred body %s", async (mode) => {
    const state = new TsunamiStateHolder(); const gate = new TelegramRevisionGate(); const callback = vi.fn();
    const before = [state.cloneSnapshot(), gate.cloneSnapshot()];
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let resolveBody!: (value: { kind: "ok"; xml: string }) => void;
    let rejectBody!: (reason: Error) => void;
    const body = new Promise<{ kind: "ok"; xml: string }>((resolve, reject) => {
      resolveBody = resolve; rejectBody = reject;
    });
    const loadBody = vi.fn(() => { bodyStarted(); return body; });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const attempt = vi.fn(({ isCurrent }: { isCurrent: () => boolean }) => restoreTsunamiState(
      "key", state, gate, callback, undefined,
      { now: () => REST_NOW, loadPage: async () => listResponse(), loadBody, isCurrent },
    ));
    const controller = createTsunamiRestoreRetryController({ attempt, warn });
    const pending = controller.runInitial(); controller.enableBackgroundRetries();
    await started;
    const manager = { getStatus: () => ({ socketId: null }), close: vi.fn() } as unknown as ConnectionManager;
    const eewLogger = { closeAll: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) } as unknown as EewEventLogger;
    const finalSave = vi.fn();
    const shutdown = createShutdownHandler({
      apiKey: "key", manager, eewLogger, getReplHandler: () => null,
      resetTerminalTitle: vi.fn(), stopTsunamiRestoreRetry: controller.stop,
      stopStandbySweep: finalSave,
    });
    await shutdown();
    expect(finalSave).toHaveBeenCalledTimes(1);
    if (mode === "resolve") resolveBody({ kind: "ok", xml: REAL_XML });
    else rejectBody(new Error("body failed"));
    expect(await pending).toEqual({ kind: "abandoned", changed: false });
    await vi.runAllTimersAsync();
    expect([state.cloneSnapshot(), gate.cloneSnapshot()]).toEqual(before);
    expect(callback).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(loadBody).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(controller.status()).toEqual(expect.objectContaining({ stopped: true, pending: false, generation: 1 }));
  });
});
