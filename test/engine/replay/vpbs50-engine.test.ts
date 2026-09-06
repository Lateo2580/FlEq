import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type {
  DisplayBroadcastResult,
  DisplayServerMessageWithReconcile,
  DisplayTransport,
} from "../../../src/engine/display/types";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { LegacyCounterpartCorrelator } from "../../../src/engine/messages/legacy-counterpart-correlator";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { SummaryWindowTracker } from "../../../src/engine/messages/summary-tracker";
import { Vpwp50DetailCache } from "../../../src/engine/messages/vpwp50-detail-cache";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { createDisplayAdapter } from "../../../src/ui/display-adapter";
import { ReplayClock, ReplayScheduler } from "../../../src/engine/replay/replay-clock";
import { canonicalJson, createReplaySideEffects, prepareReplayStateDir } from "../../../src/engine/replay/replay-side-effects";
import { loadVpBs50ReplayInputs, VPBS50_REPLAY_FIXTURES, vpbs50ReplayInputDigest } from "../../../src/engine/replay/vpbs50-envelope";
import { buildReplayFinalRecord, buildReplayInjectedRecord } from "../../../src/engine/replay/vpbs50-runner";

class CapturingTransport implements DisplayTransport {
  readonly messages: DisplayServerMessageWithReconcile[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  broadcast(message: DisplayServerMessageWithReconcile): DisplayBroadcastResult {
    this.messages.push(structuredClone(message));
    return { total: 1, blockedSkipped: 0 };
  }
  clientCount(): number { return 1; }
}

const CREATED: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of CREATED.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Phase 1 fixed VPBS50 through production router/CLI/display", () => {
  it("clock 未注入の通常 router は tracker の optional 時刻引数を従来どおり省略する", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const [input] = loadVpBs50ReplayInputs(VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path));
    const stateDir = resolve(`.tmp-replay-default-clock-${process.pid}-${Date.now()}`);
    CREATED.push(stateDir);
    prepareReplayStateDir(stateDir);
    const sideEffects = createReplaySideEffects();
    const summary = new SummaryWindowTracker();
    const daily = new DailyQuakeCounter();
    const summaryRecord = vi.spyOn(summary, "record");
    const dailyRecord = vi.spyOn(daily, "record");
    const handler = createMessageHandler({
      display: createDisplayAdapter(),
      eewLogger: sideEffects.eewLogger,
      notifier: sideEffects.notifier,
      vpwp50Cache: new Vpwp50DetailCache({ persistRoot: stateDir }),
      summaryTracker: summary,
      dailyQuakeCounter: daily,
    });
    try {
      handler.handler(input.message);
      expect(summaryRecord).toHaveBeenCalledTimes(1);
      expect(summaryRecord.mock.calls[0]).toHaveLength(2);
      expect(dailyRecord).toHaveBeenCalledTimes(1);
      expect(dailyRecord.mock.calls[0]).toHaveLength(1);
    } finally {
      handler.flushAndDisposeVolcanoBuffer();
      handler.disposeLegacyCounterpartCorrelator();
    }
  });

  it("各 message は public handler/tap を一度通り、final は発生 entry のみになる", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const canonicalStates: string[] = [];
    try {
      for (const wallTime of ["1999-01-01T00:00:00.000Z", "2040-01-01T00:00:00.000Z"]) {
        vi.setSystemTime(new Date(wallTime));
        const inputs = loadVpBs50ReplayInputs(VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path));
        const digest = vpbs50ReplayInputDigest(inputs);
        const clock = new ReplayClock(inputs[0].reportDateTimeMs);
        const scheduler = new ReplayScheduler(clock);
        const replay = { step: 0, total: 2, inputDigest: digest };
        const standby = new StandbyStateStore();
        const promotions = new WeatherPromotionStore();
        const state = new DisplayStateStore(() => standby.snapshotItems(), promotions);
        const hub = new InfoDisplayHub(state, {
          summarize: (event) => event.title,
          weatherAlerts: () => [],
          now: () => clock.nowMs(),
          timeoutScheduler: scheduler,
          replayMetadata: () => ({
            clock: { mode: "replay", now: clock.nowIso() },
            replay: { ...replay },
          }),
        });
        const transport = new CapturingTransport();
        hub.attachTransport(transport);
        const sink = createDisplaySink({
          standby: {
            applyEvent: (event, nowMs) => standby.applyEvent(event, nowMs),
            briefingCardGeneration: () => standby.briefingCardGeneration(),
            reconcileBriefingCard: (sourceKey, event, nowMs) =>
              standby.reconcileBriefingCard(sourceKey, event, nowMs),
            snapshotBriefingCard: () => standby.snapshotBriefingCard(),
          },
          promotions,
          weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
          getHub: () => hub,
          now: () => clock.nowMs(),
        });
        const stateDir = resolve(`.tmp-replay-engine-${process.pid}-${Date.now()}`);
        CREATED.push(stateDir);
        prepareReplayStateDir(stateDir);
        const sideEffects = createReplaySideEffects();
        const summary = new SummaryWindowTracker();
        const daily = new DailyQuakeCounter(clock.nowMs());
        const summaryRecord = vi.spyOn(summary, "record");
        const summarySnapshot = vi.spyOn(summary, "getSnapshot");
        const dailyRecord = vi.spyOn(daily, "record");
        const dailySnapshot = vi.spyOn(daily, "getSnapshot");
        const routes: string[] = [];
        let correlator: LegacyCounterpartCorrelator | null = null;
        const handler = createMessageHandler({
          display: createDisplayAdapter(),
          displaySink: sink,
          clock,
          displayReceiptClock: clock,
          displayReceiptTimerScheduler: scheduler,
          eewLogger: sideEffects.eewLogger,
          notifier: sideEffects.notifier,
          vpwp50Cache: new Vpwp50DetailCache({ persistRoot: stateDir }),
          summaryTracker: summary,
          dailyQuakeCounter: daily,
          routeTaps: [({ route }) => routes.push(route)],
          legacyCounterpartCorrelatorFactory: (context) => {
            correlator = new LegacyCounterpartCorrelator({
              clock,
              timerScheduler: scheduler,
              onAction: context.actionSink,
              onLifecycleEvent: context.lifecycleEventSink,
            });
            return correlator;
          },
        });

        const records: object[] = [];
        for (const input of inputs) {
          clock.advanceTo(input.reportDateTimeMs);
          replay.step = input.ordinal;
          handler.handler(input.message);
          hub.markExternalStateDirty();
          records.push(buildReplayInjectedRecord(input, routes.at(-1)!));
        }
        handler.buildDisplayStats(clock.nowMs());
        handler.flushAndDisposeVolcanoBuffer();
        scheduler.drainDue();
        (correlator as LegacyCounterpartCorrelator | null)?.flushDue();
        handler.disposeLegacyCounterpartCorrelator();
        const final = hub.flushReplayState();
        const finalJson = canonicalJson(final.snapshot);
        canonicalStates.push(finalJson);
        records.push(buildReplayFinalRecord({
          step: 2,
          total: 2,
          inputDigest: digest,
          finalSnapshotSha256: createHash("sha256").update(finalJson).digest("hex"),
          cacheTouchedPaths: [],
          eewLogger: sideEffects.eew,
          notifier: sideEffects.notifications,
        }));

        expect(routes).toEqual(["briefing", "briefing"]);
        expect(records.map((record) => (record as { type: string }).type)).toEqual([
          "replay.injected", "replay.injected", "replay.final",
        ]);
        const entries = (final.snapshot.standbyItems ?? [])
          .filter((item) => item.kind === "briefing")
          .flatMap((item) => item.data.entries);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.phenomenonKind).toBe("linearRainObserved");
        expect(entries[0]?.targetAreas.map((area) => area.code)).toEqual(["170010", "170020"]);
        expect(entries.some((entry) => entry.phenomenonKind === "linearRainPredicted")).toBe(false);
        expect(final).toMatchObject({ emitted: true, degradationLevel: 0 });
        expect(final.snapshot).toMatchObject({
          replay: { step: 2, total: 2, inputDigest: digest },
          clock: { mode: "replay", now: new Date(inputs[1].reportDateTimeMs).toISOString() },
        });
        expect(transport.messages.at(-1)).toEqual({ type: "state", snapshot: final.snapshot });
        expect(sideEffects.notifications).toEqual({ attempts: 2, suppressed: 2 });
        expect(sideEffects.eew).toEqual({ attempts: 0, suppressed: 0 });
        expect(summaryRecord.mock.calls.map((call) => call[2]))
          .toEqual(inputs.map((input) => input.reportDateTimeMs));
        expect(dailyRecord.mock.calls.map((call) => call[1]))
          .toEqual(inputs.map((input) => input.reportDateTimeMs));
        expect(summarySnapshot).toHaveBeenLastCalledWith(inputs[1].reportDateTimeMs);
        expect(dailySnapshot).toHaveBeenLastCalledWith(inputs[1].reportDateTimeMs);
        expect(handler.getReplayQuiescence()).toEqual({
          pendingEnvelopes: 0,
          serializerOwnerActive: false,
        });
        expect(scheduler.pendingCount()).toBe(0);
        expect(hub.getReplayQuiescence()).toEqual({
          stateDirty: false,
          stateTimer: false,
          tickerSyncRetry: false,
        });
        expect(hub.flushReplayState()).toMatchObject({ emitted: false, seq: final.seq });
        scheduler.dispose();
      }
      expect(canonicalStates[0]).toBe(canonicalStates[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
