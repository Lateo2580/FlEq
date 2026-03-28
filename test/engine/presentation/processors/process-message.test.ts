import { describe, it, expect, vi } from "vitest";
import { processMessage, ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE43_WARNING_S1,
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
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
  };
}

describe("processMessage", () => {
  it("earthquake ルート → EarthquakeOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("earthquake");
  });

  it("eew ルート → EewOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const outcome = processMessage(msg, "eew", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("eew");
  });

  it("eew 重複 → null", () => {
    const deps = makeDeps();
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processMessage(msg1, "eew", deps);
    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const outcome = processMessage(msg2, "eew", deps);
    expect(outcome).toBeNull();
  });

  it("unknown ルート → RawOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      classification: "unknown",
      head: { type: "ZZZZ99", author: "テスト", time: new Date().toISOString(), test: false, xml: true },
    });
    const outcome = processMessage(msg, "unknown", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("other");
  });

  it("EEW パース失敗 → RawOutcome (表示するが統計には含めない)", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "eew.forecast",
      id: "bad-eew",
      passing: [],
      head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processMessage(msg, "eew", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("eew");
    expect(outcome!.stats.shouldRecord).toBe(false);
  });

  it("非 EEW パース失敗 → RawOutcome (元カテゴリ保持)", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "bad-eq",
      passing: [],
      head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    const outcome = processMessage(msg, "earthquake", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("earthquake");
  });
});
