import { describe, expect, it } from "vitest";
import type {
  FinalizedTyphoonProbabilityClassification,
  FinalizedTyphoonProbabilityResult,
  TyphoonProbabilityState,
} from "../../../src/engine/display/project-typhoon-probability";
import { TyphoonProbabilityStateHolder } from "../../../src/engine/messages/typhoon-probability-state";

const T0 = Date.parse("2026-06-02T15:55:00+09:00");

function classification(
  eventId: string,
  kind: FinalizedTyphoonProbabilityResult["kind"],
  nowMs: number,
  probability = 50,
): FinalizedTyphoonProbabilityClassification {
  const state: TyphoonProbabilityState = {
    eventId,
    sourceEventId: `source-${eventId}`,
    identity: { name: null, nameKana: null, remark: null, typhoonNumber: null },
    baseTimeMs: T0,
    maxFiveDayProbability: probability,
    activePrefectureCount: 1,
    topPrefectures: [{
      prefectureCode: "01", prefectureName: "北海道", fiveDayProbability: probability,
    }],
    worstArea: {
      areaCode: "0100", areaName: "石狩地方", prefectureCode: "01",
      prefectureName: "北海道", fiveDayProbability: probability, peakAtMs: T0,
    },
    revision: { reportTimeMs: nowMs, serial: "1" },
    appliedSemanticKey: `semantic-${eventId}-${nowMs}`,
    expiresAtMs: T0 + 5 * 24 * 60 * 60_000,
    restored: false,
  };
  const result: FinalizedTyphoonProbabilityResult = kind === "active"
    ? { kind, state }
    : kind === "nonProjectable"
      ? { kind, reason: "compactOnly" }
      : { kind };
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
    classification(eventId, kind, nowMs, probability),
  );
}

describe("TyphoonProbabilityStateHolder 敵対シーケンス", () => {
  it("複数 EventID が交互でも履歴を混線させない", () => {
    const holder = new TyphoonProbabilityStateHolder();
    expect(apply(holder, "TC-A", "deactivateAllZero", T0).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC-B", "deactivateAllZero", T0 + 1).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC-A", "deactivateAllZero", T0 + 2).isUnchangedZero).toBe(true);
    expect(apply(holder, "TC-B", "active", T0 + 3, 50).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC-A", "deactivateAllZero", T0 + 4).isUnchangedZero).toBe(true);
  });

  it("nonProjectable は LRU を更新せず、別 EventID の mutation に影響しない", () => {
    const holder = new TyphoonProbabilityStateHolder();
    apply(holder, "TC-A", "deactivateAllZero", T0);
    apply(holder, "TC-B", "active", T0 + 1, 20);
    apply(holder, "TC-A", "nonProjectable", T0 + 2);
    expect(apply(holder, "TC-B", "deactivateAllZero", T0 + 3).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC-A", "deactivateAllZero", T0 + 4).isUnchangedZero).toBe(true);
  });

  it("expired / nonProjectable の初回適用は entry を新規作成しない", () => {
    const holder = new TyphoonProbabilityStateHolder();
    apply(holder, "TC-A", "expired", T0);
    apply(holder, "TC-B", "nonProjectable", T0 + 1);
    expect(apply(holder, "TC-A", "deactivateAllZero", T0 + 2).isUnchangedZero).toBe(false);
    expect(apply(holder, "TC-B", "deactivateAllZero", T0 + 3).isUnchangedZero).toBe(false);
  });
});
