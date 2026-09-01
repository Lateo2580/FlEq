import { describe, it, expect } from "vitest";
import { TyphoonProbabilityStateHolder } from "../../src/engine/messages/typhoon-probability-state";
import { processTyphoonProbability } from "../../src/engine/presentation/processors/process-typhoon-probability";
import { processTyphoonAnalysis } from "../../src/engine/presentation/processors/process-typhoon-analysis";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_JANGMI_APPROACH,
  FIXTURE_VPTA50_JANGMI_GONE,
  readFixture,
} from "../helpers/mock-message";

const FIXTURE_VPTW60_TC2606 = "synthetic_VPTW60_TC2606.xml";

describe("VPTA50 統合: 同一 EventID の予報更新", () => {
  it("直接processorの C→B→B' は stateless baseline を維持する", () => {
    const state = new TyphoonProbabilityStateHolder();
    const o1 = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_APPROACH),
      { typhoonProbabilityState: state },
    );
    const o2 = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
      { typhoonProbabilityState: state },
    );
    const o3 = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
      { typhoonProbabilityState: state },
    );
    expect(o1!.presentation.soundLevel).toBe("normal");
    expect(o2!.presentation.soundLevel).toBe("info");
    expect(o2!.presentation.suppressNotify).toBeFalsy();
    expect(o3!.presentation.suppressNotify).toBe(false);
  });

  it("C と B は同一 EventID (TC2606)", () => {
    const c = createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_APPROACH);
    const b = createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE);
    const state = new TyphoonProbabilityStateHolder();
    const o1 = processTyphoonProbability(c, { typhoonProbabilityState: state })!;
    const o2 = processTyphoonProbability(b, { typhoonProbabilityState: state })!;
    expect(o1.parsed.eventId).toBe("TC2606");
    expect(o2.parsed.eventId).toBe("TC2606");
  });

  it("synthetic VPTW60 と実 VPTA50 は共通 EventID TC2606 で結合可能", () => {
    const analysis = processTyphoonAnalysis(createMockWsDataMessageFromXml(
      readFixture(FIXTURE_VPTW60_TC2606),
      "VPTW60",
    ));
    const probability = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_APPROACH),
    );
    expect(analysis?.parsed.eventId).toBe("TC2606");
    expect(analysis?.parsed.lifecycle).toBe("active");
    expect(probability?.parsed.eventId).toBe(analysis?.parsed.eventId);
  });
});
