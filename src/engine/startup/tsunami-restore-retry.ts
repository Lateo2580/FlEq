import * as log from "../../logger";
import type { TsunamiRestoreAttemptResult } from "./tsunami-initializer";

export const TSUNAMI_RESTORE_MAX_ATTEMPTS = 8;
export const TSUNAMI_RESTORE_RETRY_BASE_MS = 5_000;
export const TSUNAMI_RESTORE_RETRY_MAX_MS = 300_000;

export interface TsunamiRestoreAttemptLifecycle {
  isCurrent: () => boolean;
}

export type TsunamiRestoreAttemptRunner = (
  lifecycle: TsunamiRestoreAttemptLifecycle,
) => Promise<TsunamiRestoreAttemptResult>;

interface RetryTimerHandle {
  unref?: () => unknown;
}

export interface TsunamiRestoreRetryControllerOptions {
  attempt: TsunamiRestoreAttemptRunner;
  setTimer?: (callback: () => void, delayMs: number) => RetryTimerHandle;
  clearTimer?: (handle: RetryTimerHandle) => void;
  warn?: (message: string) => void;
}

export interface TsunamiRestoreRetryController {
  runInitial(): Promise<TsunamiRestoreAttemptResult>;
  enableBackgroundRetries(): void;
  stop(): void;
  status(): { attempts: number; inFlight: boolean; pending: boolean; stopped: boolean; generation: number };
}

function retryDelayMs(backgroundOrdinal: number): number {
  return Math.min(
    TSUNAMI_RESTORE_RETRY_BASE_MS * 2 ** (backgroundOrdinal - 1),
    TSUNAMI_RESTORE_RETRY_MAX_MS,
  );
}

export function createTsunamiRestoreRetryController(
  options: TsunamiRestoreRetryControllerOptions,
): TsunamiRestoreRetryController {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const warn = options.warn ?? log.warn;
  let inFlight = false;
  let timer: RetryTimerHandle | null = null;
  let stopped = false;
  let retriesEnabled = false;
  let pendingRetry = false;
  let attempts = 0;
  let generation = 0;
  let exhaustionWarned = false;
  let initialPromise: Promise<TsunamiRestoreAttemptResult> | null = null;

  const arm = (): void => {
    if (stopped || !retriesEnabled || !pendingRetry || inFlight || timer != null) return;
    if (attempts >= TSUNAMI_RESTORE_MAX_ATTEMPTS) return;
    const ordinal = attempts;
    timer = setTimer(() => {
      timer = null;
      void runAttempt();
    }, retryDelayMs(ordinal));
    timer.unref?.();
  };

  const finish = (result: TsunamiRestoreAttemptResult): void => {
    if (stopped || result.kind === "abandoned") {
      pendingRetry = false;
      return;
    }
    if (result.kind === "incomplete" && result.retryable) {
      pendingRetry = true;
      if (attempts >= TSUNAMI_RESTORE_MAX_ATTEMPTS) {
        pendingRetry = false;
        if (!exhaustionWarned) {
          exhaustionWarned = true;
          warn(`[tsunami-restore] retryExhausted attempts=${attempts} reason=${result.reason}`);
        }
        return;
      }
      arm();
      return;
    }
    pendingRetry = false;
  };

  const runAttempt = async (): Promise<TsunamiRestoreAttemptResult> => {
    if (stopped) return { kind: "abandoned", changed: false };
    if (inFlight) return { kind: "abandoned", changed: false };
    inFlight = true;
    pendingRetry = false;
    attempts += 1;
    const capturedGeneration = generation;
    let result: TsunamiRestoreAttemptResult;
    try {
      result = await options.attempt({
        isCurrent: () => !stopped && capturedGeneration === generation,
      });
    } catch {
      result = {
        kind: "incomplete",
        changed: false,
        retryable: true,
        reason: "listUnavailable",
      };
    } finally {
      inFlight = false;
    }
    if (stopped || capturedGeneration !== generation) {
      return { kind: "abandoned", changed: false };
    }
    finish(result);
    return result;
  };

  return {
    runInitial() {
      initialPromise ??= runAttempt();
      return initialPromise;
    },
    enableBackgroundRetries() {
      if (stopped || retriesEnabled) return;
      retriesEnabled = true;
      arm();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      pendingRetry = false;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
    },
    status: () => ({ attempts, inFlight, pending: pendingRetry || timer != null, stopped, generation }),
  };
}
