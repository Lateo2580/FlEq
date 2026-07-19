import { describe, it, expect } from "vitest";
import { fromClimateInfoOutcome } from "../../../../src/engine/presentation/events/from-climate-info";
import { processClimateInfo } from "../../../../src/engine/presentation/processors/process-climate-info";
import {
  createMockWsDataMessage,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VPCI50_KANTO_TSUYU,
} from "../../../helpers/mock-message";

describe("fromClimateInfoOutcome", () => {
  it("controlTitle が PresentationEvent に載る (VPCI50 で「地方天候情報」)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU);
    const outcome = processClimateInfo(msg)!;
    const event = fromClimateInfoOutcome(outcome);
    expect(event.controlTitle).toBe("地方天候情報");
  });

  it("VPZI50 では controlTitle が「全般天候情報」(退行ガード)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const outcome = processClimateInfo(msg)!;
    const event = fromClimateInfoOutcome(outcome);
    expect(event.controlTitle).toBe("全般天候情報");
  });

  it("bodyTexts が event.bodyText に見出し付きで連結される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const outcome = processClimateInfo(msg)!;
    const event = fromClimateInfoOutcome(outcome);
    expect(event.bodyText).not.toBeNull();
    expect(event.bodyText).toContain("【");
  });
});
