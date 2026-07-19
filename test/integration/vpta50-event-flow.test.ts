import { describe, it, expect } from "vitest";
import { TyphoonProbabilityStateHolder } from "../../src/engine/messages/typhoon-probability-state";
import { processTyphoonProbability } from "../../src/engine/presentation/processors/process-typhoon-probability";
import {
  createMockWsDataMessage,
  FIXTURE_VPTA50_JANGMI_APPROACH,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../helpers/mock-message";

describe("VPTA50 統合: 同一 EventID の予報更新", () => {
  it("C(接近)→B(消滅)→B'(消滅) で 3 回目だけ suppressNotify=true", () => {
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
    expect(o3!.presentation.suppressNotify).toBe(true);
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
});
