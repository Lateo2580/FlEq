import { describe, expect, it } from "vitest";
import type {
  FinalizedTyphoonProbabilityClassification,
  FinalizedTyphoonProbabilityResult,
  TyphoonProbabilityState,
} from "../../../src/engine/display/project-typhoon-probability";
import {
  TYPHOON_PROBABILITY_HISTORY_TTL_MS,
  TYPHOON_PROBABILITY_MAX_EVENTS,
  TyphoonProbabilityStateHolder,
} from "../../../src/engine/messages/typhoon-probability-state";

const T0 = Date.parse("2026-06-02T15:55:00+09:00");

function activeState(eventId: string, probability: number): TyphoonProbabilityState {
  return {
    eventId,
    sourceEventId: `source-${eventId}`,
    identity: { name: null, nameKana: null, remark: null, typhoonNumber: null },
    baseTimeMs: T0,
    maxFiveDayProbability: probability,
    activePrefectureCount: 1,
    topPrefectures: [{
      prefectureCode: "13",
      prefectureName: "東京都",
      fiveDayProbability: probability,
    }],
    worstArea: {
      areaCode: "1300",
      areaName: "東京地方",
      prefectureCode: "13",
      prefectureName: "東京都",
      fiveDayProbability: probability,
      peakAtMs: T0,
    },
    revision: { reportTimeMs: T0, serial: "1" },
    appliedSemanticKey: `semantic-${eventId}`,
    expiresAtMs: T0 + 5 * 24 * 60 * 60_000,
    restored: false,
  };
}

function finalized(
  eventId: string,
  kind: FinalizedTyphoonProbabilityResult["kind"],
  nowMs: number,
  probability = 50,
): FinalizedTyphoonProbabilityClassification {
  let result: FinalizedTyphoonProbabilityResult;
  switch (kind) {
    case "active":
      result = { kind, state: activeState(eventId, probability) };
      break;
    case "nonProjectable":
      result = { kind, reason: "compactOnly" };
      break;
    case "deactivateAllZero":
    case "cancel":
    case "expired":
      result = { kind };
      break;
  }
  return {
    nowMs,
    canonicalInfoType: kind === "cancel" ? "取消" : "発表",
    result,
    acceptedRevision: { reportTimeMs: nowMs, serial: "1" },
    appliedSemanticKey: `semantic-${eventId}-${nowMs}`,
  };
}

function apply(
  holder: TyphoonProbabilityStateHolder,
  eventId: string,
  kind: FinalizedTyphoonProbabilityResult["kind"],
  nowMs: number,
  probability = 50,
) {
  return holder.applyAcceptedClassification(
    eventId,
    finalized(eventId, kind, nowMs, probability),
  );
}

describe("TyphoonProbabilityStateHolder", () => {
  it("accepted zero → zero だけを suppress する", () => {
    const holder = new TyphoonProbabilityStateHolder();
    expect(apply(holder, "TC2606", "deactivateAllZero", T0).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC2606", "deactivateAllZero", T0 + 1).isUnchangedZero).toBe(true);
  });

  it.each(["nonProjectable", "expired"] as const)(
    "zero → %s → zero は履歴と TTL を変更せず suppress する",
    (kind) => {
      const holder = new TyphoonProbabilityStateHolder();
      apply(holder, "TC2606", "deactivateAllZero", T0);
      apply(holder, "TC2606", kind, T0 + TYPHOON_PROBABILITY_HISTORY_TTL_MS - 1);
      expect(apply(
        holder,
        "TC2606",
        "deactivateAllZero",
        T0 + TYPHOON_PROBABILITY_HISTORY_TTL_MS,
      ).isUnchangedZero).toBe(true);
    },
  );

  it.each(["nonProjectable", "expired"] as const)(
    "nonzero → %s → zero は変更として通知する",
    (kind) => {
      const holder = new TyphoonProbabilityStateHolder();
      apply(holder, "TC2606", "active", T0, 50);
      apply(holder, "TC2606", kind, T0 + 1);
      expect(apply(holder, "TC2606", "deactivateAllZero", T0 + 2).isUnchangedZero).toBe(false);
    },
  );

  it("zero → cancel → zero は新しい zero として通知する", () => {
    const holder = new TyphoonProbabilityStateHolder();
    apply(holder, "TC2606", "deactivateAllZero", T0);
    apply(holder, "TC2606", "cancel", T0 + 1);
    expect(apply(holder, "TC2606", "deactivateAllZero", T0 + 2).isUnchangedZero).toBe(false);
  });

  it("TTL は acceptedAt 起点で境界を含み、1ms 超過で失効する", () => {
    const holderAtBoundary = new TyphoonProbabilityStateHolder();
    apply(holderAtBoundary, "TC2606", "deactivateAllZero", T0);
    expect(apply(
      holderAtBoundary,
      "TC2606",
      "deactivateAllZero",
      T0 + TYPHOON_PROBABILITY_HISTORY_TTL_MS,
    ).isUnchangedZero).toBe(true);

    const holderPastBoundary = new TyphoonProbabilityStateHolder();
    apply(holderPastBoundary, "TC2606", "deactivateAllZero", T0);
    expect(apply(
      holderPastBoundary,
      "TC2606",
      "deactivateAllZero",
      T0 + TYPHOON_PROBABILITY_HISTORY_TTL_MS + 1,
    ).isUnchangedZero).toBe(false);
  });

  it("deterministic LRU は 256 件を保持して 257 件目で最古を除外する", () => {
    const holder = new TyphoonProbabilityStateHolder();
    for (let index = 0; index < TYPHOON_PROBABILITY_MAX_EVENTS; index += 1) {
      apply(holder, `event-${index}`, "deactivateAllZero", T0 + index);
    }
    expect(apply(holder, "event-0", "deactivateAllZero", T0 + 256).isUnchangedZero).toBe(true);
    apply(holder, "event-new", "deactivateAllZero", T0 + 257);
    expect(apply(holder, "event-1", "deactivateAllZero", T0 + 258).isUnchangedZero).toBe(false);
    expect(apply(holder, "event-0", "deactivateAllZero", T0 + 259).isUnchangedZero).toBe(true);
  });

  it("active state と admission EventID の不一致を mutation 前に拒否する", () => {
    const holder = new TyphoonProbabilityStateHolder();
    expect(() => holder.applyAcceptedClassification(
      "TC-A",
      finalized("TC-B", "active", T0),
    )).toThrow("binding mismatch");
    expect(apply(holder, "TC-A", "deactivateAllZero", T0 + 1).isUnchangedZero).toBe(false);
  });

  it.each(["", " TC2606", "x".repeat(129)])(
    "non-canonical EventID %j を mutation 前に拒否する",
    (eventId) => {
    const holder = new TyphoonProbabilityStateHolder();
      expect(() => apply(holder, eventId, "deactivateAllZero", T0)).toThrow("canonical EventID");
    },
  );
});
