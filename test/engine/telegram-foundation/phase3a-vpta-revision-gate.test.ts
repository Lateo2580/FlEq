import { describe, expect, it } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { TYPHOON_PROBABILITY_RETENTION_MS } from "../../../src/engine/display/project-typhoon-probability";
import {
  selectVptaCapacityBundles,
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  type VptaCapacityBundle,
} from "../../../src/engine/messages/telegram-revision-gate";
import { TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY } from "../../../src/engine/messages/revision-family-registry";

type CandidateKind = Parameters<TelegramRevisionGate["decideTyphoonProbability"]>[1];

const T0 = Date.parse("2026-08-31T00:00:00Z");
const MAX_SUBJECTS = 256;

function subject(eventId: string): string {
  return `typhoonProbability:${eventId}`;
}

function vptaInput(
  eventId: string,
  kind: CandidateKind,
  sequence: number,
  activeFamilySubjects: readonly string[],
  receivedAtMs = T0 + sequence * 60_000 + 1_000,
) {
  const infoType = kind === "cancel" ? "取消" : "発表";
  return {
    domain: "typhoonProbability",
    revisionFamily: "VPTA50",
    stateSubjectKey: subject(eventId),
    meta: createTelegramMeta({
      messageId: `message-${eventId}-${sequence}`,
      eventId,
      type: "VPTA50",
      reportDateTime: new Date(receivedAtMs - 1_000).toISOString(),
      serial: String(sequence + 1),
      infoType,
      receivedAtMs,
      status: "通常",
      isTest: false,
    }),
    comparator: "reportDateTimeThenSerial" as const,
    cancellationPolicy: "clearCurrent" as const,
    terminal: false,
    deactivation: kind === "cancel" || kind === "deactivateAllZero",
    cancellationTargetMatches: true,
    durable: true,
    tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
    maxSubjects: MAX_SUBJECTS,
    activeFamilySubjects,
    allowMissingSerial: true,
    fragmentMerge: false,
    payloadFingerprint: semanticPayloadFingerprint({ eventId, kind, sequence }),
    legacyRevisionKey: eventId,
    legacyRevisionKeyProvenance: "eventId" as const,
  };
}

function populateProtected(gate: TelegramRevisionGate, count: number): string[] {
  const active: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const eventId = `TC-P-${String(index).padStart(3, "0")}`;
    const result = gate.decideTyphoonProbability(
      vptaInput(eventId, "active", index, active),
      "active",
    );
    if (result.kind !== "accepted") {
      throw new Error(`protected population failed at ${index}: ${JSON.stringify(result)}`);
    }
    active.push(subject(eventId));
  }
  return active;
}

describe("VPTA50 capacity selector", () => {
  it("protects P+G/GT and evicts GA by acceptedAt then code-unit EventID", () => {
    const bundles: VptaCapacityBundle[] = [
      { stateSubjectKey: subject("P"), acceptedAtMs: 100, class: "P+G" },
      { stateSubjectKey: subject("T"), acceptedAtMs: 100, class: "GT" },
      { stateSubjectKey: subject("GA-B"), acceptedAtMs: 50, class: "GA" },
      { stateSubjectKey: subject("GA-A"), acceptedAtMs: 50, class: "GA" },
      { stateSubjectKey: subject("GA-C"), acceptedAtMs: 60, class: "GA" },
    ];
    const selected = selectVptaCapacityBundles(bundles, 3);
    expect(selected).toMatchObject({ kind: "selected" });
    if (selected.kind !== "selected") throw new Error("selection failed");
    expect(selected.retained.map((bundle) => bundle.stateSubjectKey).sort()).toEqual([
      subject("GA-C"), subject("P"), subject("T"),
    ].sort());
    expect(selected.discarded.map((bundle) => bundle.stateSubjectKey)).toEqual([
      subject("GA-B"), subject("GA-A"),
    ]);
  });

  it("is input-order independent and refuses protected overflow", () => {
    const bundles: VptaCapacityBundle[] = [
      { stateSubjectKey: subject("GA-Z"), acceptedAtMs: 1, class: "GA" },
      { stateSubjectKey: subject("GA-A"), acceptedAtMs: 1, class: "GA" },
      { stateSubjectKey: subject("P"), acceptedAtMs: 2, class: "P+G" },
    ];
    const forward = selectVptaCapacityBundles(bundles, 2);
    const reverse = selectVptaCapacityBundles([...bundles].reverse(), 2);
    const retained = (result: typeof forward) => result.kind === "selected"
      ? result.retained.map((bundle) => bundle.stateSubjectKey).sort()
      : [];
    expect(retained(forward)).toEqual(retained(reverse));
    expect(retained(forward)).toEqual([subject("GA-Z"), subject("P")].sort());
    expect(selectVptaCapacityBundles([
      { stateSubjectKey: subject("P1"), acceptedAtMs: 1, class: "P+G" },
      { stateSubjectKey: subject("P2"), acceptedAtMs: 2, class: "GT" },
    ], 1)).toEqual({ kind: "protectedOverflow" });
  });
});

describe("VPTA50 authoritative gate commit", () => {
  it("returns one deeply frozen canonical commit and stores the same meaning", () => {
    const gate = new TelegramRevisionGate();
    const result = gate.decideTyphoonProbability(
      vptaInput("TC2606", "active", 1, []),
      "active",
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("admission failed");
    expect(result.commit).toMatchObject({
      stateSubjectKey: subject("TC2606"),
      revisionFamily: "VPTA50",
      cancelled: false,
      acceptedAtMs: T0 + 60_000 + 1_000,
      tombstoneRetentionMs: TYPHOON_PROBABILITY_RETENTION_MS,
      binding: { revision: { serial: "2" } },
    });
    expect(result.commit.binding.appliedSemanticKey).toBe(result.commit.semanticKeys.at(-1));
    expect(result.commit.binding.revision.reportTimeMs)
      .toBe(result.commit.comparison.revision.reportDateTime.epochMs);
    expect(Object.isFrozen(result.commit)).toBe(true);
    expect(Object.isFrozen(result.commit.comparison.revision)).toBe(true);
    expect(Object.isFrozen(result.commit.semanticKeys)).toBe(true);
    expect(Object.isFrozen(result.commit.binding.revision)).toBe(true);
    expect(gate.exportDurableEntries()[0]).toMatchObject({
      stateSubjectKey: result.commit.stateSubjectKey,
      comparison: result.commit.comparison,
      semanticKeys: [...result.commit.semanticKeys],
      cancelled: result.commit.cancelled,
      acceptedAtMs: result.commit.acceptedAtMs,
    });
  });

  it("keeps entries at the inclusive seven-day boundary and expires them at +1ms", () => {
    const gate = new TelegramRevisionGate();
    expect(gate.decideTyphoonProbability(
      vptaInput("TC2606", "active", 0, [], T0),
      "active",
    ).kind).toBe("accepted");
    expect(gate.expireRevisionFamilyByLifecycle(
      "typhoonProbability", "VPTA50", T0 + TYPHOON_PROBABILITY_RETENTION_MS,
      {
        tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
        activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
      },
    ).changed).toBe(false);
    expect(gate.exportDurableEntries()).toHaveLength(1);
    expect(gate.expireRevisionFamilyByLifecycle(
      "typhoonProbability", "VPTA50", T0 + TYPHOON_PROBABILITY_RETENTION_MS + 1,
      {
        tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
        activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
      },
    ).changed).toBe(true);
    expect(gate.exportDurableEntries()).toEqual([]);
  });

  it("expires active and cancelled VPTA50 subjects together at seven days +1ms", () => {
    const gate = new TelegramRevisionGate();
    expect(gate.decideTyphoonProbability(
      vptaInput("TC-ACTIVE", "active", 0, [], T0),
      "active",
    ).kind).toBe("accepted");
    expect(gate.decideTyphoonProbability(
      vptaInput("TC-CANCELLED", "active", 0, [], T0),
      "active",
    ).kind).toBe("accepted");
    expect(gate.decideTyphoonProbability(
      vptaInput("TC-CANCELLED", "cancel", 1, [], T0),
      "cancel",
    ).kind).toBe("accepted");
    expect(gate.exportDurableEntries().map((entry) => [entry.stateSubjectKey, entry.cancelled]))
      .toEqual([
        [subject("TC-ACTIVE"), false],
        [subject("TC-CANCELLED"), true],
      ]);

    const beforeVersion = gate.version();
    expect(gate.expireRevisionFamilyByLifecycle(
      "typhoonProbability", "VPTA50", T0 + TYPHOON_PROBABILITY_RETENTION_MS,
      {
        tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
        activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
      },
    )).toEqual({ changed: false, expiredStateSubjectKeys: [] });
    expect(gate.version()).toBe(beforeVersion);
    expect(gate.expireRevisionFamilyByLifecycle(
      "typhoonProbability", "VPTA50", T0 + TYPHOON_PROBABILITY_RETENTION_MS + 1,
      {
        tombstoneRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
        activeRetentionMs: TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs,
      },
    )).toEqual({
      changed: true,
      expiredStateSubjectKeys: [subject("TC-ACTIVE"), subject("TC-CANCELLED")],
    });
    expect(gate.version()).toBe(beforeVersion + 1);
    expect(gate.exportDurableEntries()).toEqual([]);
  });

  it.each(["active", "deactivateAllZero", "nonProjectable"] as const)(
    "with 255 protected + 1 GA, incoming %s evicts only the oldest GA",
    (kind) => {
      const gate = new TelegramRevisionGate();
      const active = populateProtected(gate, 255);
      expect(gate.decideTyphoonProbability(
        vptaInput("TC-GA-OLD", "nonProjectable", 255, active),
        "nonProjectable",
      ).kind).toBe("accepted");
      const incoming = gate.decideTyphoonProbability(
        vptaInput("TC-INCOMING", kind, 256, active),
        kind,
      );
      expect(incoming.kind).toBe("accepted");
      const entries = gate.exportDurableEntries();
      expect(entries).toHaveLength(MAX_SUBJECTS);
      expect(entries.some((entry) => entry.stateSubjectKey === subject("TC-GA-OLD"))).toBe(false);
      expect(entries.some((entry) => entry.stateSubjectKey === subject("TC-INCOMING"))).toBe(true);
    },
  );

  it("rejects a 257th protected subject without changing 256 protected entries", () => {
    const gate = new TelegramRevisionGate();
    const active = populateProtected(gate, MAX_SUBJECTS);
    const before = gate.exportDurableEntries();
    const result = gate.decideTyphoonProbability(
      vptaInput("TC-OVERFLOW", "deactivateAllZero", 300, active),
      "deactivateAllZero",
    );
    expect(result).toMatchObject({
      kind: "suppressed",
      decision: { kind: "capacityExceeded", accepted: false },
      durableChanged: false,
    });
    expect(gate.exportDurableEntries()).toEqual(before);
  });

  it("rejects an incoming GA when it is the deterministic victim", () => {
    const gate = new TelegramRevisionGate();
    const active = populateProtected(gate, 255);
    expect(gate.decideTyphoonProbability(
      vptaInput("TC-GA-NEW", "nonProjectable", 255, active, T0 + 1_000),
      "nonProjectable",
    ).kind).toBe("accepted");
    const before = gate.exportDurableEntries();
    const result = gate.decideTyphoonProbability(
      vptaInput("TC-GA-OLD", "nonProjectable", 256, active, T0 - 1),
      "nonProjectable",
    );
    expect(result).toMatchObject({
      kind: "suppressed",
      decision: { kind: "capacityExceeded", accepted: false },
    });
    expect(gate.exportDurableEntries()).toEqual(before);
  });

  it("accepts a newer update for an existing subject while all 256 slots are protected", () => {
    const gate = new TelegramRevisionGate();
    const active = populateProtected(gate, MAX_SUBJECTS);
    const eventId = "TC-P-000";
    const result = gate.decideTyphoonProbability(
      vptaInput(eventId, "active", 500, active),
      "active",
    );
    expect(result.kind).toBe("accepted");
    expect(gate.exportDurableEntries()).toHaveLength(MAX_SUBJECTS);
    expect(gate.exportDurableEntries().find((entry) => entry.stateSubjectKey === subject(eventId))
      ?.comparison.revision.serial.raw).toBe("501");
  });
});
