import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type {
  DisplayBroadcastResult,
  DisplayServerMessageWithReconcile,
  DisplayTransport,
} from "../../../src/engine/display/types";
import { ReplayClock, ReplayScheduler } from "../../../src/engine/replay/replay-clock";
import {
  buildReplayFinalRecord,
  isFinalReplayStateFrame,
  isInitialReplaySnapshotFrame,
  runVpBs50Replay,
  startGuardedReplayDisplay,
  type ReplayProbeMessage,
  waitForExternalReplayClient,
} from "../../../src/engine/replay/vpbs50-runner";
import { VPBS50_REPLAY_FIXTURES } from "../../../src/engine/replay/vpbs50-envelope";

class CapturingTransport implements DisplayTransport {
  readonly messages: DisplayServerMessageWithReconcile[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  broadcast(message: DisplayServerMessageWithReconcile): DisplayBroadcastResult {
    this.messages.push(message);
    return { total: 1, blockedSkipped: 0 };
  }
  clientCount(): number { return 1; }
}

describe("Phase 1 replay display quiescence", () => {
  it("explicit flush は replay metadata 付き level 0 state を一度だけ送り、二度目は不変", () => {
    const clock = new ReplayClock(Date.parse("2026-08-27T02:58:00+09:00"));
    const scheduler = new ReplayScheduler(clock);
    const step = { value: 2 };
    const hub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => clock.nowMs(),
      timeoutScheduler: scheduler,
      replayMetadata: () => ({
        clock: { mode: "replay", now: clock.nowIso() },
        replay: { step: step.value, total: 2, inputDigest: "a".repeat(64) },
      }),
    });
    const transport = new CapturingTransport();
    hub.attachTransport(transport);
    hub.markExternalStateDirty();

    const first = hub.flushReplayState();
    const second = hub.flushReplayState();
    expect(first).toMatchObject({ emitted: true, degradationLevel: 0 });
    expect(first.snapshot).toMatchObject({
      clock: { mode: "replay", now: "2026-08-26T17:58:00.000Z" },
      replay: { step: 2, total: 2, inputDigest: "a".repeat(64) },
    });
    expect(second).toMatchObject({ emitted: false, seq: first.seq });
    expect(second.snapshot).toEqual(first.snapshot);
    expect(transport.messages.filter((message) => message.type === "state")).toHaveLength(1);
    expect(hub.getReplayQuiescence()).toEqual({
      stateDirty: false,
      stateTimer: false,
      tickerSyncRetry: false,
    });
  });

  it("7788 explicit/actual guard は注入前 close/retry し、3回なら失敗する", async () => {
    const starts: number[] = [];
    const stopped: number[] = [];
    const ports = [7788, 42001];
    const runtime = await startGuardedReplayDisplay(0, async (requested) => {
      starts.push(requested);
      const port = ports.shift()!;
      return {
        transport: { port: () => port, clientCount: () => 0 },
        stop: async () => { stopped.push(port); },
      };
    });
    expect(runtime.transport.port()).toBe(42001);
    expect(starts).toEqual([0, 0]);
    expect(stopped).toEqual([7788]);

    const neverStart = vi.fn();
    await expect(startGuardedReplayDisplay(7788, neverStart)).rejects.toThrow(/reserved/);
    expect(neverStart).not.toHaveBeenCalled();
    let closes = 0;
    await expect(startGuardedReplayDisplay(0, async () => ({
      transport: { port: () => 7788, clientCount: () => 0 },
      stop: async () => { closes += 1; },
    }))).rejects.toThrow(/three times/);
    expect(closes).toBe(3);
  });

  it("予約 port と範囲外 port は state-dir 作成前に runner が拒否する", async () => {
    for (const [port, message] of [[7788, /reserved/], [70000, /0 to 65535/]] as const) {
      const stateDir = resolve(`.tmp-replay-invalid-port-${port}-${process.pid}-${Date.now()}`);
      await expect(runVpBs50Replay({
        fixturePaths: VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path),
        stateDir,
        displayPort: port,
        intervalMs: 0,
      })).rejects.toThrow(message);
      expect(existsSync(stateDir)).toBe(false);
    }
  });

  it("--hold barrier は internal probe だけでは戻らず external client 後にだけ解除する", async () => {
    let clients = 1;
    const trace: string[] = [];
    const sleep = vi.fn(async (delayMs: number) => {
      expect(delayMs).toBe(50);
      trace.push("blocked");
      clients = 2;
    });
    await waitForExternalReplayClient({
      transport: { port: () => 42001, clientCount: () => clients },
      stop: async () => undefined,
    }, sleep);
    trace.push("inject");
    expect(trace).toEqual(["blocked", "inject"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("SSE barrier は最初の snapshot と final step/digest/seq の全一致を要求する", () => {
    const digest = "d".repeat(64);
    const initial = {
      event: "snapshot",
      message: { type: "snapshot", snapshot: { seq: 0, replay: { step: 0, total: 2, inputDigest: digest } } },
    } as unknown as ReplayProbeMessage;
    expect(isInitialReplaySnapshotFrame(initial)).toBe(true);
    expect(isInitialReplaySnapshotFrame({ ...initial, event: "state" })).toBe(false);

    const final = {
      event: "state",
      message: { type: "state", snapshot: { seq: 9, replay: { step: 2, total: 2, inputDigest: digest } } },
    } as unknown as ReplayProbeMessage;
    expect(isFinalReplayStateFrame(final, { step: 2, total: 2, inputDigest: digest, seq: 9 }))
      .toBe(true);
    expect(isFinalReplayStateFrame(final, { step: 2, total: 2, inputDigest: digest, seq: 8 }))
      .toBe(false);
    expect(isFinalReplayStateFrame(final, { step: 2, total: 3, inputDigest: digest, seq: 9 }))
      .toBe(false);
  });

  it("events transcript schema は injected 2 + final 1 の固定順になる", () => {
    const records = [
      { type: "replay.injected", ordinal: 1 },
      { type: "replay.injected", ordinal: 2 },
      buildReplayFinalRecord({
        step: 2,
        total: 2,
        inputDigest: "b".repeat(64),
        finalSnapshotSha256: "c".repeat(64),
        cacheTouchedPaths: [],
        eewLogger: { attempts: 0, suppressed: 0 },
        notifier: { attempts: 2, suppressed: 2 },
      }),
    ];
    expect(records.map((record) => (record as { type: string }).type)).toEqual([
      "replay.injected",
      "replay.injected",
      "replay.final",
    ]);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      cacheTouchedPaths: [],
      sideEffects: {
        eewLogger: { attempts: 0, suppressed: 0 },
        notifier: { attempts: 2, suppressed: 2 },
      },
    });
  });
});
