import { describe, expect, it, vi } from "vitest";
import type { WsDataMessage } from "../../../src/types";
import {
  createMessageHandler,
  RouterSerializerPoisonedError,
} from "../../../src/engine/messages/message-router";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TyphoonProbabilityStateHolder } from "../../../src/engine/messages/typhoon-probability-state";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type {
  DisplayIngestOutcome,
  DisplayIngestSink,
  VptaAdmissionCompletion,
  VptaDisplayIngestCommand,
} from "../../../src/engine/display/types";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_DAMREY,
  readFixture,
} from "../../helpers/mock-message";
import {
  createVptaSentinelCommit,
  findVptaInternalSentinelLeaks,
  injectVptaFinalizedSentinels,
  markVptaDisplayCommandSentinel,
  VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS,
} from "../../helpers/vpta50-internal-sentinel";
import * as log from "../../../src/logger";

const vptaInternalResultHook = vi.hoisted(() => ({
  apply: undefined as undefined | ((result: unknown) => void),
}));

vi.mock("../../../src/engine/presentation/processors/process-message", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/engine/presentation/processors/process-message")
  >();
  return {
    ...actual,
    processMessageInternal(
      ...args: Parameters<typeof actual.processMessageInternal>
    ): ReturnType<typeof actual.processMessageInternal> {
      const result = actual.processMessageInternal(...args);
      vptaInternalResultHook.apply?.(result);
      return result;
    },
  };
});

const CLASSIFICATION_NOW = Date.parse("2020-09-30T07:00:00.000Z");

function vptaMessage(
  id = "vpta-router",
  eventId?: string,
  transform?: (xml: string) => string,
): WsDataMessage {
  let xml = readFixture(FIXTURE_VPTA50_DAMREY).replace(
    /<ReportDateTime>[^<]*<\/ReportDateTime>/,
    "<ReportDateTime>2020-09-30T15:30:00+09:00</ReportDateTime>",
  );
  if (eventId != null) {
    xml = xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  }
  if (transform != null) xml = transform(xml);
  const message = createMockWsDataMessageFromXml(xml, "VPTA50");
  if (message.meta == null) throw new Error("fixture meta missing");
  return {
    ...message,
    id,
    meta: { ...message.meta, messageId: id, receivedAtMs: CLASSIFICATION_NOW },
  };
}

function createStoreSink(
  store: StandbyStateStore,
  hooks: {
    afterStandbyFailure?: Error;
    publishStats?: () => void;
    activeSubjects?: (nowMs: number) => readonly string[];
  } = {},
): DisplayIngestSink {
  return {
    ingest(event, command): DisplayIngestOutcome {
      if (command == null) return {};
      const reducer = store.applyTyphoonProbabilityCommand(command);
      const retention = store.maintainTyphoonProbabilitySubjects(
        command.finalized.nowMs,
        command.activeSubjects,
      );
      const vptaMutation = {
        viewChanged: reducer.viewChanged || retention.viewChanged,
        durableChanged: reducer.durableChanged || retention.durableChanged,
      };
      return hooks.afterStandbyFailure == null
        ? { vptaMutation }
        : {
            vptaMutation,
            vptaFailure: { stage: "displaySinkPostStandby", cause: hooks.afterStandbyFailure },
          };
    },
    publishStats: hooks.publishStats,
    activeTyphoonProbabilitySubjects: hooks.activeSubjects
      ?? ((nowMs) => store.activeTyphoonProbabilitySubjects(nowMs)),
    maintainTyphoonProbabilitySubjects: (nowMs, subjects) =>
      store.maintainTyphoonProbabilitySubjects(nowMs, subjects),
    reconcileTyphoonProbabilityCommand: (command) =>
      store.reconcileTyphoonProbabilityCommand(command),
    reconcileTyphoonProbabilitySubject: (eventId) =>
      store.reconcileTyphoonProbabilitySubject(eventId),
  };
}

function completionHarness() {
  const completions: VptaAdmissionCompletion[] = [];
  let seq = 0;
  let immediateFlushes = 0;
  return {
    completions,
    get immediateFlushes() { return immediateFlushes; },
    adapter(completion: VptaAdmissionCompletion) {
      completions.push(structuredClone(completion));
      if (!completion.durableChanged) return { kind: "notRequired" as const };
      const receipt = { kind: "scheduled" as const, seq: ++seq };
      if (completion.persistence === "deferred") return { kind: "scheduled" as const, receipt };
      immediateFlushes += 1;
      return {
        kind: "flushed" as const,
        receipt,
        result: {
          kind: "written" as const,
          requiredSeq: receipt.seq,
          targetSeq: receipt.seq,
          writtenSeq: receipt.seq,
          v2Committed: true as const,
          v1Committed: true as const,
        },
      };
    },
  };
}

function collectPropertyNames(
  value: unknown,
  names = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> {
  if (typeof value !== "object" || value == null || seen.has(value)) return names;
  seen.add(value);
  for (const [name, child] of Object.entries(value)) {
    names.add(name);
    collectPropertyNames(child, names, seen);
  }
  return names;
}

const VPTA_INTERNAL_PUBLIC_FIELD_SENTINELS = [
  "finalized",
  "commit",
  "comparison",
  "semanticKeys",
  "tombstoneRetentionMs",
  "ownerToken",
  "activeSubjects",
  "completion",
  "appliedSemanticKey",
  "standbyStateMutationAccepted",
  "standbyStateTransient",
  "standbyStateSubject",
  "standbyActiveSubjects",
  "standbyAppliedSemanticKey",
] as const;

describe("message router VPTA admission", () => {
  it("keeps an overlength EventID transient and logs only bounded triage fields", () => {
    const overlengthEventId = "x".repeat(129);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const completion = completionHarness();
    const outcomes: unknown[] = [];
    const store = new StandbyStateStore();
    const router = createMessageHandler({
      displaySink: createStoreSink(store),
      outcomeTaps: [(outcome) => { outcomes.push(outcome); }],
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    router.handler(vptaMessage("overlength", overlengthEventId));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      domain: "typhoonProbability",
      presentation: { suppressNotify: false },
    });
    for (const field of VPTA_INTERNAL_PUBLIC_FIELD_SENTINELS) {
      expect(collectPropertyNames(outcomes[0])).not.toContain(field);
    }
    expect(completion.completions).toEqual([]);
    expect(store.snapshotItems()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[vpta50-admission] headType=VPTA50 length=129 reason=eventIdTooLong",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(overlengthEventId);
    warn.mockRestore();
  });

  it("logs an accepted non-projectable report with bounded canonical revision fields", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const completion = completionHarness();
    const store = new StandbyStateStore();
    const router = createMessageHandler({
      displaySink: createStoreSink(store),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    router.handler(vptaMessage(
      "non-projectable",
      undefined,
      (xml) => xml.replace("<Duration>PT3H</Duration>", "<Duration>P1M</Duration>"),
    ));

    expect(completion.completions).toEqual([
      expect.objectContaining({ kind: "accepted", durableChanged: true }),
    ]);
    expect(store.snapshotItems()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `[vpta50-admission] eventId=TC2001 reportTimeMs=${Date.parse("2020-09-30T15:30:00+09:00")} serial=13 reason=invalidDuration`,
    );
    warn.mockRestore();
  });

  it("keeps the finalized command private and completes after standby evidence", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const outcomes: unknown[] = [];
    const events: unknown[] = [];
    let commandSeen: VptaDisplayIngestCommand | undefined;
    const baseSink = createStoreSink(store);
    const sink: DisplayIngestSink = {
      ...baseSink,
      ingest(event, command) {
        events.push(event);
        commandSeen = command;
        return baseSink.ingest(event, command);
      },
    };
    const suppressionCalls = vi.fn();
    const withSuppression = <T>(callback: () => T): T => {
      suppressionCalls();
      return callback();
    };
    const router = createMessageHandler({
      displaySink: sink,
      outcomeTaps: [(outcome) => { outcomes.push(outcome); }],
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: withSuppression,
    });

    router.handler(vptaMessage());

    expect(commandSeen?.finalized.result.kind).toBe("active");
    expect(commandSeen?.activeSubjects).toEqual(["typhoonProbability:TC2001"]);
    expect(completion.completions).toHaveLength(1);
    expect(completion.completions[0]).toMatchObject({
      kind: "accepted", durableChanged: true, persistence: "deferred",
      changes: { incomingGate: true, projectionOrRetention: true },
    });
    expect(suppressionCalls).toHaveBeenCalledTimes(1);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon"))
      .toMatchObject({ severity: "normal", data: { typhoons: [{ typhoonKey: "TC2001" }] } });
    for (const publicValue of outcomes) {
      const serialized = JSON.stringify(publicValue);
      expect(serialized).not.toContain("FinalizedTyphoonProbabilityClassification");
      for (const field of VPTA_INTERNAL_PUBLIC_FIELD_SENTINELS) {
        expect(collectPropertyNames(publicValue)).not.toContain(field);
      }
    }
    // PresentationEvent is checked recursively by property name so a value-less
    // assignment (for example `standbyAppliedSemanticKey: undefined`) cannot pass.
    for (const publicEvent of events) {
      for (const field of VPTA_INTERNAL_PUBLIC_FIELD_SENTINELS) {
        expect(collectPropertyNames(publicEvent)).not.toContain(field);
      }
    }
  });

  it("keeps distinct actual-field sentinel values out of public outcome and event payloads", () => {
    const revisionGate = new TelegramRevisionGate();
    const decide = revisionGate.decideTyphoonProbability.bind(revisionGate);
    vi.spyOn(revisionGate, "decideTyphoonProbability").mockImplementation(
      (input, candidateKind, capacityPlan) => {
        const result = decide(input, candidateKind, capacityPlan);
        return result.kind === "accepted"
          ? { kind: "accepted", commit: createVptaSentinelCommit(result.commit) }
          : result;
      },
    );
    const notificationState = new TyphoonProbabilityStateHolder();
    vi.spyOn(notificationState, "applyAcceptedClassification").mockImplementation(
      (_eventId, finalized) => {
        injectVptaFinalizedSentinels(finalized);
        return { isUnchangedZero: false, shouldRecap: false };
      },
    );
    const outcomes: unknown[] = [];
    const events: unknown[] = [];
    let commandSeen: VptaDisplayIngestCommand | undefined;
    vptaInternalResultHook.apply = (processed) => {
      const command = (processed as {
        internal?: { vptaDisplayCommand?: VptaDisplayIngestCommand };
      } | null)?.internal?.vptaDisplayCommand;
      if (command == null) throw new Error("sentinel VPTA internal command missing");
      markVptaDisplayCommandSentinel(command);
    };
    const router = createMessageHandler({
      revisionGate,
      typhoonProbabilityState: notificationState,
      outcomeTaps: [(outcome) => { outcomes.push(outcome); }],
      displaySink: {
        ingest(event, command): DisplayIngestOutcome {
          events.push(event);
          if (command == null) throw new Error("sentinel VPTA command missing");
          commandSeen = command;
          return { vptaMutation: { viewChanged: false, durableChanged: false } };
        },
      },
      onVptaAdmissionCompletion: (completion) => completion.durableChanged
        ? { kind: "scheduled", receipt: { kind: "scheduled", seq: 1 } }
        : { kind: "notRequired" },
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    try {
      router.handler(vptaMessage("actual-field-sentinel"));
    } finally {
      vptaInternalResultHook.apply = undefined;
    }

    expect(commandSeen).toBeDefined();
    expect(String(commandSeen)).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS["internal.vptaDisplayCommand"],
    );
    expect(commandSeen?.domain).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS["internal.vptaDisplayCommand"],
    );
    expect(commandSeen?.finalized.canonicalInfoType).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.finalized.canonicalInfoType"
      ],
    );
    expect(String(commandSeen?.finalized.acceptedRevision)).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.finalized.acceptedRevision"
      ],
    );
    expect(commandSeen?.finalized.appliedSemanticKey).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.finalized.appliedSemanticKey"
      ],
    );
    expect(commandSeen?.commit.stateSubjectKey).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.commit.stateSubjectKey"
      ],
    );
    expect(String(commandSeen?.commit.comparison)).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.commit.comparison"
      ],
    );
    expect(commandSeen?.commit.semanticKeys).toEqual([
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.commit.semanticKeys"
      ],
    ]);
    expect(String(commandSeen?.commit.binding)).toBe(
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.commit.binding"
      ],
    );
    const sentinelEntries = Object.entries(VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS);
    expect(new Set(sentinelEntries.map(([, sentinel]) => sentinel)).size)
      .toBe(sentinelEntries.length);
    const privateFixtureEvidence = findVptaInternalSentinelLeaks(commandSeen);
    for (const [field] of sentinelEntries) {
      expect(
        privateFixtureEvidence.some((leak) => leak.field === field),
        `${field} was not injected into the private fixture`,
      ).toBe(true);
    }
    expect(outcomes).toHaveLength(1);
    expect(events).toHaveLength(1);
    for (const [surface, payload] of [
      ["ProcessOutcome", outcomes[0]],
      ["PresentationEvent", events[0]],
    ] as const) {
      expect(findVptaInternalSentinelLeaks(payload), surface).toEqual([]);
      const serialized = JSON.stringify(payload);
      for (const sentinel of Object.values(VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS)) {
        expect(serialized, `${surface} JSON`).not.toContain(sentinel);
      }
    }
  });

  it("poisons and fails loud when a durable completion has no persistence adapter", () => {
    const store = new StandbyStateStore();
    const revisionGate = new TelegramRevisionGate();
    const router = createMessageHandler({
      revisionGate,
      displaySink: createStoreSink(store),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    expect(() => router.handler(vptaMessage("missing-persistence-adapter")))
      .toThrow("VPTA durable completion persistence adapter is not configured");
    // The accepted gate is never rolled back, but the poisoned router cannot
    // silently continue with only in-memory durable state.
    expect(revisionGate.exportDurableEntries()).toHaveLength(1);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")).toBeDefined();
    expect(() => router.handler(vptaMessage("after-missing-persistence-adapter")))
      .toThrow(RouterSerializerPoisonedError);
  });

  it("retains a proven reducer mutation, emits one failed completion, and flushes before throw", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const failure = new Error("post-standby failure");
    const router = createMessageHandler({
      displaySink: createStoreSink(store, { afterStandbyFailure: failure }),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    expect(() => router.handler(vptaMessage())).toThrow(failure);
    expect(completion.completions).toHaveLength(1);
    expect(completion.completions[0]).toMatchObject({
      kind: "failed", stage: "displaySinkPostStandby",
      durableChanged: true, persistence: "immediate",
    });
    expect(completion.immediateFlushes).toBe(1);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")).toBeDefined();
  });

  it.each([
    ["undefined", undefined],
    ["non-array", { subject: "typhoonProbability:TC2001" }],
    ["invalid prefix", ["wrong-prefix:TC2001"]],
    ["blank EventID", ["typhoonProbability:"]],
    ["overlength EventID", [`typhoonProbability:${"x".repeat(129)}`]],
    ["non-string", [42]],
    ["duplicate", ["typhoonProbability:A", "typhoonProbability:A"]],
    ["unsorted", ["typhoonProbability:B", "typhoonProbability:A"]],
  ])("fails closed before the gate when the protection provider is malformed: %s", (_label, snapshot) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const router = createMessageHandler({
      displaySink: createStoreSink(store, {
        activeSubjects: () => snapshot as unknown as readonly string[],
      }),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    expect(() => router.handler(vptaMessage())).toThrow("VPTA50 protectionSnapshot");
    expect(completion.completions).toEqual([
      expect.objectContaining({
        kind: "failed", stage: "protectionSnapshot",
        durableChanged: false, persistence: "none",
      }),
    ]);
    expect(store.snapshotItems()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[vpta50-admission] reason=vpta50ProtectionSnapshotInvalid",
    );
    warn.mockRestore();
  });

  it("reports a pure capacity-plan failure before gate evaluation", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const revisionGate = new TelegramRevisionGate();
    const failure = new Error("capacity-plan failed");
    vi.spyOn(revisionGate, "planTyphoonProbabilityCapacity").mockImplementation(() => {
      throw failure;
    });
    const router = createMessageHandler({
      revisionGate,
      displaySink: createStoreSink(store),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
    });

    expect(() => router.handler(vptaMessage())).toThrow(failure);
    expect(completion.completions).toEqual([
      expect.objectContaining({
        kind: "failed", stage: "capacityPlan",
        durableChanged: false, persistence: "none",
      }),
    ]);
    expect(revisionGate.exportDurableEntries()).toEqual([]);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("stops before finalization when the revision observer synchronously poisons the serializer", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const revisionGate = new TelegramRevisionGate();
    const outcomeTap = vi.fn();
    let router!: ReturnType<typeof createMessageHandler>;
    let injected = false;
    router = createMessageHandler({
      revisionGate,
      displaySink: createStoreSink(store),
      outcomeTaps: [outcomeTap],
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
      onVptaStandbyRevisionDecision: () => {
        if (injected) return;
        injected = true;
        for (let index = 0; index < 257; index += 1) {
          try {
            router.handler(vptaMessage(`observer-nested-${index}`));
          } catch {
            // Observer deliberately catches overflow; the sticky latch must be checked on return.
          }
        }
      },
    });

    expect(() => router.handler(vptaMessage("observer-outer")))
      .toThrow(RouterSerializerPoisonedError);
    expect(completion.completions).toEqual([
      expect.objectContaining({
        kind: "failed",
        stage: "standbyRevisionObserver",
        durableChanged: true,
        persistence: "immediate",
      }),
    ]);
    expect(completion.immediateFlushes).toBe(1);
    expect(outcomeTap).not.toHaveBeenCalled();
    expect(store.snapshotItems()).toEqual([]);
    expect(revisionGate.exportDurableEntries()).toHaveLength(1);
    expect(() => router.handler(vptaMessage("observer-after-poison")))
      .toThrow(RouterSerializerPoisonedError);
  });

  it("turns outcome-tap reentrant overload into one failed completion and sticky poison", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    let router!: ReturnType<typeof createMessageHandler>;
    let injected = false;
    router = createMessageHandler({
      displaySink: createStoreSink(store),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
      outcomeTaps: [() => {
        if (injected) return;
        injected = true;
        for (let index = 0; index < 257; index += 1) {
          try {
            router.handler(vptaMessage(`nested-${index}`));
          } catch {
            // The tap deliberately catches the enqueue failure; the sticky latch must survive.
          }
        }
      }],
    });

    expect(() => router.handler(vptaMessage("outer"))).toThrow(RouterSerializerPoisonedError);
    expect(completion.completions).toHaveLength(1);
    expect(completion.completions[0]).toMatchObject({
      kind: "failed", stage: "outcomeTapPoison", persistence: "immediate",
    });
    expect(completion.immediateFlushes).toBe(1);
    expect(store.snapshotItems()).toEqual([]);
    expect(() => router.handler(vptaMessage("after-poison"))).toThrow(RouterSerializerPoisonedError);
  });

  it("flushes the latest required receipt when post-completion presentation poisons", () => {
    const store = new StandbyStateStore();
    const completion = completionHarness();
    const flushStandbyThrough = vi.fn((requiredSeq: number) => ({
      kind: "alreadyWritten" as const,
      requiredSeq,
      writtenSeq: requiredSeq,
    }));
    let router!: ReturnType<typeof createMessageHandler>;
    let injected = false;
    router = createMessageHandler({
      displaySink: createStoreSink(store, {
        publishStats: () => {
          if (injected) return;
          injected = true;
          for (let index = 0; index < 257; index += 1) {
            try { router.handler(vptaMessage(`post-${index}`)); } catch { /* sticky latch */ }
          }
        },
      }),
      onVptaAdmissionCompletion: (item) => completion.adapter(item),
      withStandbyDurableNotificationsSuppressed: (callback) => callback(),
      flushStandbyThrough,
    });

    expect(() => router.handler(vptaMessage("outer-post"))).toThrow(RouterSerializerPoisonedError);
    expect(completion.completions).toHaveLength(1);
    expect(completion.completions[0]?.kind).toBe("accepted");
    expect(flushStandbyThrough).toHaveBeenCalledTimes(1);
    expect(flushStandbyThrough).toHaveBeenCalledWith(1);
  });
});
