import { describe, it, expect } from "vitest";
import { processTyphoonProbability } from "../../../src/engine/presentation/processors/process-typhoon-probability";
import { TyphoonProbabilityStateHolder } from "../../../src/engine/messages/typhoon-probability-state";
import {
  createMockWsDataMessage,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../../helpers/mock-message";

describe("processTyphoonProbability", () => {
  it("DAMREY: frameLevel=normal / soundLevel=normal / suppressNotify=false", () => {
    const state = new TyphoonProbabilityStateHolder();
    const out = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_DAMREY),
      { typhoonProbabilityState: state },
    );
    expect(out!.presentation.frameLevel).toBe("normal");
    expect(out!.presentation.soundLevel).toBe("normal");
    expect(out!.presentation.suppressNotify).toBeFalsy();
    expect(out!.presentation.typhoonProbabilityMaxDaily5).toBe(100);
  });

  it("JANGMI_GONE 初回: soundLevel=info / suppressNotify=false", () => {
    const state = new TyphoonProbabilityStateHolder();
    const out = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
      { typhoonProbabilityState: state },
    );
    expect(out!.presentation.soundLevel).toBe("info");
    expect(out!.presentation.suppressNotify).toBeFalsy();
  });

  it("JANGMI_GONE 連続2回目: suppressNotify=true", () => {
    const state = new TyphoonProbabilityStateHolder();
    processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
      { typhoonProbabilityState: state },
    );
    const out2 = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
      { typhoonProbabilityState: state },
    );
    expect(out2!.presentation.suppressNotify).toBe(true);
    expect(out2!.presentation.soundLevel).toBe("info");
  });

  it("deps なしでもクラッシュしない（state dedup 無効化）", () => {
    const out = processTyphoonProbability(
      createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE),
    );
    expect(out!.presentation.soundLevel).toBe("info");
    expect(out!.presentation.suppressNotify).toBeFalsy();
  });
});
