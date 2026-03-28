import { describe, it, expect, vi } from "vitest";
import { fromEewOutcome } from "../../../../src/engine/presentation/events/from-eew";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { createMockWsDataMessage, FIXTURE_VXSE43_WARNING_S1 } from "../../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe("fromEewOutcome", () => {
  it("EewOutcome → PresentationEvent", () => {
    const tracker = new EewTracker();
    const logger = new EewEventLogger();
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, tracker, logger);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const outcome = result.outcome;
    const event = fromEewOutcome(outcome);

    expect(event.domain).toBe("eew");
    expect(event.id).toBe(msg.id);
    expect(event.isWarning).toBe(true);
    expect(event.frameLevel).toBe("critical");
    expect(event.raw).toBe(outcome.parsed);
    expect(event.stateSnapshot?.kind).toBe("eew");
    expect(event.isCancellation).toBe(false);
  });
});
