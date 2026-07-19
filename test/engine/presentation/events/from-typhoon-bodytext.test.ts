import { describe, it, expect } from "vitest";
import { fromTyphoonAnalysisOutcome } from "../../../../src/engine/presentation/events/from-typhoon-analysis";
import { fromTyphoonProbabilityOutcome } from "../../../../src/engine/presentation/events/from-typhoon-probability";
import { processTyphoonAnalysis } from "../../../../src/engine/presentation/processors/process-typhoon-analysis";
import { processTyphoonProbability } from "../../../../src/engine/presentation/processors/process-typhoon-probability";
import {
  createMockWsDataMessage,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPTW60_CANCEL,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../../../helpers/mock-message";

describe("from-typhoon 本文配線 (構造化長文化)", () => {
  it("VPTW60 実況は event.bodyText が非 null (構造化長文)", () => {
    const out = processTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020));
    const event = fromTyphoonAnalysisOutcome(out!);
    expect(event.bodyText).not.toBeNull();
    expect(event.bodyText!.length).toBeGreaterThan(0);
  });

  it("VPTW60 取消は event.bodyText が null", () => {
    const out = processTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_CANCEL));
    const event = fromTyphoonAnalysisOutcome(out!);
    expect(event.bodyText).toBeNull();
  });

  it("VPTA50 (active 府県あり) は event.bodyText が非 null", () => {
    const out = processTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY));
    const event = fromTyphoonProbabilityOutcome(out!);
    expect(event.bodyText).not.toBeNull();
  });

  it("VPTA50 暴風域消滅 (active 0 件) は event.bodyText が null", () => {
    const out = processTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE));
    const event = fromTyphoonProbabilityOutcome(out!);
    expect(event.bodyText).toBeNull();
  });
});
