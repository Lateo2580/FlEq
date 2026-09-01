import { describe, expect, it, vi } from "vitest";
import { parseTyphoonProbability } from "../../../src/dmdata/typhoon-probability-parser";
import {
  finalizeTyphoonProbabilityClassification,
  projectTyphoonProbability,
  type CanonicalVptaInfoType,
} from "../../../src/engine/display/project-typhoon-probability";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import {
  createVptaRouterOwnerToken,
  withVptaRouterOwnerToken,
  type VptaDisplayIngestCommand,
} from "../../../src/engine/display/types";
import type { VptaAcceptedCommit } from "../../../src/engine/messages/telegram-revision-gate";
import * as log from "../../../src/logger";
import { processTyphoonAnalysis } from "../../../src/engine/presentation/processors/process-typhoon-analysis";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
  FIXTURE_VPTW60_2020,
  readFixture,
} from "../../helpers/mock-message";

const SEMANTIC = `発表:${"a".repeat(64)}`;

function probabilityCommand(
  fixture = FIXTURE_VPTA50_DAMREY,
  eventId = "TC2001",
  infoType: CanonicalVptaInfoType = "発表",
): VptaDisplayIngestCommand {
  const ownerToken = createVptaRouterOwnerToken();
  const parsed = parseTyphoonProbability(createMockWsDataMessage(fixture));
  if (parsed == null || parsed.baseTime == null) throw new Error("fixture parse failed");
  parsed.eventId = eventId;
  parsed.infoType = infoType;
  const nowMs = Date.parse(parsed.baseTime) + 1;
  const classification = projectTyphoonProbability(parsed, infoType, nowMs);
  const revision = { reportTimeMs: Date.parse(parsed.reportDateTime!), serial: "1" };
  const stateSubjectKey = `typhoonProbability:${eventId}`;
  const commit = {
    stateSubjectKey,
    revisionFamily: "VPTA50",
    decision: {
      kind: infoType === "取消" ? "clearCurrent" : "accept",
      relation: "newer",
      accepted: true,
      isCorrection: false,
      isTerminal: false,
      resolvedTrigger: infoType === "取消" ? "explicitCancellation" : null,
    },
    comparison: {
      revision: {
        ...parsed.meta,
        eventId: { raw: eventId, value: eventId, valid: true },
        type: { raw: "VPTA50", value: "VPTA50", valid: true },
        serial: { raw: "1", numeric: 1, valid: true },
        infoType: { raw: infoType, value: infoType, valid: true },
      },
      stateSubjectKey,
    },
    semanticKeys: [SEMANTIC],
    cancelled: infoType === "取消" || classification.result.kind === "deactivateAllZero",
    acceptedAtMs: nowMs,
    tombstoneRetentionMs: 604_800_000,
    binding: { revision, appliedSemanticKey: SEMANTIC },
  } as VptaAcceptedCommit;
  return {
    domain: "typhoonProbability",
    ownerToken,
    commit,
    finalized: finalizeTyphoonProbabilityClassification(classification, revision, SEMANTIC),
    activeSubjects: classification.result.kind === "active" ? [stateSubjectKey] : [],
  };
}

function applyProbabilityCommand(
  store: StandbyStateStore,
  command: VptaDisplayIngestCommand,
) {
  return withVptaRouterOwnerToken(
    command.ownerToken,
    () => store.applyTyphoonProbabilityCommand(command),
  );
}

function vptwEvent(eventId = "TC2001") {
  const xml = readFixture(FIXTURE_VPTW60_2020)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  const outcome = processTyphoonAnalysis(createMockWsDataMessageFromXml(xml, "VPTW60"));
  if (outcome == null) throw new Error("VPTW fixture parse failed");
  return toPresentationEvent(outcome);
}

function normalizedSnapshot(store: StandbyStateStore) {
  return store.snapshotItems().map((item) => ({ ...item, restored: false }));
}

describe("StandbyStateStore VPTW/VPTA union", () => {
  it("keeps the probability slice and logs only bounded field names on identity mismatch", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const store = new StandbyStateStore();
    applyProbabilityCommand(store, probabilityCommand());
    store.applyEvent(vptwEvent(), Date.parse("2020-09-30T07:00:00Z"));

    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject({
        typhoonKey: "TC2001",
        name: null,
        probability: { maxFiveDayProbability: 100 },
      });
    expect(warn).toHaveBeenCalledWith(
      "[typhoon-card] eventId=TC2001 reason=vptwVptaIdentityMismatch fields=name,nameKana,remark,typhoonNumber",
    );
    warn.mockRestore();
  });

  it("converges to the same combined card for both arrival orders", () => {
    const vptaFirst = new StandbyStateStore();
    applyProbabilityCommand(vptaFirst, probabilityCommand());
    vptaFirst.applyEvent(vptwEvent(), Date.parse("2020-09-30T07:00:00Z"));

    const vptwFirst = new StandbyStateStore();
    vptwFirst.applyEvent(vptwEvent(), Date.parse("2020-09-30T07:00:00Z"));
    applyProbabilityCommand(vptwFirst, probabilityCommand());

    expect(normalizedSnapshot(vptaFirst)).toEqual(normalizedSnapshot(vptwFirst));
    const card = vptaFirst.snapshotItems().find((item) => item.kind === "typhoon");
    expect(card?.data.typhoons).toHaveLength(1);
    expect(card?.data.typhoons[0]).toMatchObject({
      typhoonKey: "TC2001",
      probability: { maxFiveDayProbability: 100, activePrefectureCount: 45 },
    });
  });

  it("keeps analysis when all-zero/cancel removes only probability", () => {
    const store = new StandbyStateStore();
    store.applyEvent(vptwEvent(), Date.parse("2020-09-30T07:00:00Z"));
    applyProbabilityCommand(store, probabilityCommand());
    const zero = probabilityCommand(FIXTURE_VPTA50_JANGMI_GONE, "TC2001");
    expect(zero.finalized.result.kind).toBe("deactivateAllZero");
    applyProbabilityCommand(store, zero);
    let typhoon = store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0];
    expect(typhoon?.typhoonKey).toBe("TC2001");
    expect(typhoon?.probability).toBeUndefined();

    applyProbabilityCommand(store, probabilityCommand());
    applyProbabilityCommand(store, probabilityCommand(
      FIXTURE_VPTA50_DAMREY, "TC2001", "取消",
    ));
    typhoon = store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0];
    expect(typhoon?.typhoonKey).toBe("TC2001");
    expect(typhoon?.probability).toBeUndefined();
  });

  it("keeps a probability-only card when the analysis slice expires", () => {
    const store = new StandbyStateStore();
    store.applyEvent(vptwEvent(), Date.parse("2020-09-30T07:00:00Z"));
    applyProbabilityCommand(store, probabilityCommand());
    store.sweep(Date.parse("2020-10-02T07:00:00Z"));
    const card = store.snapshotItems().find((item) => item.kind === "typhoon");
    expect(card).toMatchObject({ severity: "normal", restored: false });
    expect(card?.data.typhoons[0]).toMatchObject({
      typhoonKey: "TC2001",
      category: null,
      probability: { maxFiveDayProbability: 100 },
    });
  });

  it("rejects a command whose finalized kind and immutable commit binding disagree", () => {
    const store = new StandbyStateStore();
    const valid = probabilityCommand();
    const invalid: VptaDisplayIngestCommand = {
      ...valid,
      commit: { ...valid.commit, cancelled: true },
    };
    expect(() => applyProbabilityCommand(store, invalid)).toThrow("reducer binding mismatch");
    expect(store.activeTyphoonProbabilitySubjects(Date.parse("2020-09-30T00:00:00Z"))).toEqual([]);
  });

  it("rejects an active projection that is already expired at the immutable admission clock", () => {
    const store = new StandbyStateStore();
    const valid = probabilityCommand();
    if (valid.finalized.result.kind !== "active") throw new Error("active fixture required");
    const invalid: VptaDisplayIngestCommand = {
      ...valid,
      finalized: {
        ...valid.finalized,
        result: {
          kind: "active",
          state: {
            ...valid.finalized.result.state,
            expiresAtMs: valid.finalized.nowMs,
          },
        },
      },
    };
    expect(() => applyProbabilityCommand(store, invalid)).toThrow("active reducer invariant");
    expect(store.snapshotItems()).toEqual([]);
  });

  it("reports no durable mutation for an idempotent active command or an absent cancellation", () => {
    const store = new StandbyStateStore();
    const active = probabilityCommand();
    expect(applyProbabilityCommand(store, active)).toEqual({
      viewChanged: true,
      durableChanged: true,
    });
    expect(applyProbabilityCommand(store, active)).toEqual({
      viewChanged: false,
      durableChanged: false,
    });

    const empty = new StandbyStateStore();
    expect(applyProbabilityCommand(empty, probabilityCommand(
      FIXTURE_VPTA50_DAMREY,
      "TC2001",
      "取消",
    ))).toEqual({ viewChanged: false, durableChanged: false });
  });

  it("rejects malformed and duplicate probability projections at the restore reducer boundary", () => {
    const source = new StandbyStateStore();
    applyProbabilityCommand(source, probabilityCommand());
    const malformed = source.exportActiveState();
    const projection = malformed.typhoonProbabilities?.[0];
    if (projection == null) throw new Error("probability export missing");
    projection.maxFiveDayProbability = 101;

    const malformedStore = new StandbyStateStore();
    malformedStore.restoreActiveState(malformed, Date.parse("2020-09-30T00:00:00Z"));
    expect(malformedStore.snapshotItems().find((item) => item.kind === "typhoon")).toBeUndefined();

    const duplicate = source.exportActiveState();
    const duplicateProjection = duplicate.typhoonProbabilities?.[0];
    if (duplicateProjection == null) throw new Error("probability export missing");
    duplicate.typhoonProbabilities = [
      duplicateProjection,
      structuredClone(duplicateProjection),
    ];
    const duplicateStore = new StandbyStateStore();
    duplicateStore.restoreActiveState(duplicate, Date.parse("2020-09-30T00:00:00Z"));
    expect(duplicateStore.snapshotItems().find((item) => item.kind === "typhoon")).toBeUndefined();
  });
});
