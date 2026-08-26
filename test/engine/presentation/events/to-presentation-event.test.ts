import { describe, it, expect, vi } from "vitest";
import { toPresentationEvent } from "../../../../src/engine/presentation/events/to-presentation-event";
import { processMessage, ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import { Vpws50StateHolder } from "../../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../../src/engine/messages/vpww56-state";
import { Vpwp50DetailCache } from "../../../../src/engine/messages/vpwp50-detail-cache";
import { TornadoDetailProvider } from "../../../../src/engine/messages/tornado-detail-provider";
import { FloodForecastStateHolder } from "../../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../../src/engine/messages/telegram-revision-gate";
import { TyphoonProbabilityStateHolder } from "../../../../src/engine/messages/typhoon-probability-state";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VTSE41_WARN,
} from "../../../helpers/mock-message";

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
vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    vpwp50Cache: new Vpwp50DetailCache(),
    tornadoDetailProvider: new TornadoDetailProvider(),
    typhoonProbabilityState: new TyphoonProbabilityStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
    revisionGate: new TelegramRevisionGate(),
  };
}

describe("toPresentationEvent", () => {
  it("EarthquakeOutcome → PresentationEvent", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = toPresentationEvent(outcome);
    expect(event.domain).toBe("earthquake");
    expect(event.type).toBe("VXSE53");
    expect(event.id).toBe(msg.id);
  });

  it("TsunamiOutcome → PresentationEvent", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processMessage(msg, "tsunami", makeDeps())!;
    const event = toPresentationEvent(outcome);
    expect(event.domain).toBe("tsunami");
    expect(event.tsunamiKinds).toBeDefined();
    expect(event.stateSnapshot?.kind).toBe("tsunami");
  });
});
