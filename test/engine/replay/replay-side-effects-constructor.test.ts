import { describe, expect, it, vi } from "vitest";

const constructorCalls = vi.hoisted(() => ({
  eew: 0,
  notifier: 0,
}));

vi.mock("../../../src/engine/eew/eew-logger", () => ({
  EewEventLogger: class {
    constructor() { constructorCalls.eew += 1; }
    logReport(): void {}
  },
}));

vi.mock("../../../src/engine/notification/notifier", () => ({
  Notifier: class {
    constructor() { constructorCalls.notifier += 1; }
    notifyWeatherBriefing(): void {}
  },
}));

import { createReplaySideEffects } from "../../../src/engine/replay/replay-side-effects";

describe("Phase 1 replay side-effect constructor isolation", () => {
  it("production EewEventLogger/Notifier constructor を呼ばず no-op attempt だけを数える", () => {
    const effects = createReplaySideEffects();
    expect({ eew: constructorCalls.eew, notifier: constructorCalls.notifier })
      .toEqual({ eew: 0, notifier: 0 });
    effects.eewLogger.logReport({} as never, {} as never);
    effects.notifier.notifyWeatherBriefing({} as never);
    expect(effects.eew).toEqual({ attempts: 1, suppressed: 1 });
    expect(effects.notifications).toEqual({ attempts: 1, suppressed: 1 });
    expect({ eew: constructorCalls.eew, notifier: constructorCalls.notifier })
      .toEqual({ eew: 0, notifier: 0 });
  });
});
