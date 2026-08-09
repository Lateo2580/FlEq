import { describe, it, expect, vi } from "vitest";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { makeProcessDeps as makeDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE45_S1,
  FIXTURE_VTSE41_WARN,
} from "../../helpers/mock-message";

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
vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("buildSummaryModel", () => {
  it("earthquake: severity, domain, location, magnitude を正しく変換する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = toPresentationEvent(outcome);
    const model = buildSummaryModel(event);

    expect(model.domain).toBe("earthquake");
    expect(model.severity).toMatch(/\[.+\]/);
    expect(model.title).toBeDefined();
    // 遠地地震なので震源名がある
    expect(model.location).toBeDefined();
    // magnitude が設定されていれば M で始まる
    if (model.magnitude) {
      expect(model.magnitude).toMatch(/^M/);
    }
  });

  it("EEW: severity, serial, forecastAreaNames を正しく変換する", () => {
    const deps = makeDeps();
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const outcome = processMessage(msg, "eew", deps)!;
    const event = toPresentationEvent(outcome);
    const model = buildSummaryModel(event);

    expect(model.domain).toBe("eew");
    // EEW 予報は warning
    expect(model.severity).toBe("[警告]");
    expect(model.serial).toMatch(/^#/);
    // EEW は forecastAreaNames を areaNames にフォールバック
    if (event.areaNames.length === 0 && event.forecastAreaNames.length > 0) {
      expect(model.areaNames).toEqual(event.forecastAreaNames);
    }
  });

  it("tsunami: severity と areaNames を正しく変換する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processMessage(msg, "tsunami", makeDeps())!;
    const event = toPresentationEvent(outcome);
    const model = buildSummaryModel(event);

    expect(model.domain).toBe("tsunami");
    // 津波警報は warning 以上
    expect(["[緊急]", "[警告]"]).toContain(model.severity);
    expect(model.title).toBeDefined();
  });

  it("cancel frameLevel → '[取消]' severity", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = toPresentationEvent(outcome);
    // Manually override to test cancel mapping
    const cancelEvent = { ...event, frameLevel: "cancel" as const };
    const model = buildSummaryModel(cancelEvent);

    expect(model.severity).toBe("[取消]");
  });

  it("magnitude がない場合は undefined", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = toPresentationEvent(outcome);
    const noMagEvent = { ...event, magnitude: null, magnitudeValue: undefined };
    const model = buildSummaryModel(noMagEvent);

    expect(model.magnitude).toBeUndefined();
  });

  it("Magnitude/Depth canonical の特殊値を summary token へ保持する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = {
      ...toPresentationEvent(outcome),
      magnitude: "9.9",
      magnitudeValue: { raw: "NaN", value: null, condition: "不明", description: null, presence: "unknown" as const },
      depth: "600km",
      depthValue: {
        raw: "600", value: null, condition: "以上", description: "深さ600km以上",
        presence: "range" as const, lowerBound: 600, upperBound: null,
      },
    };
    const model = buildSummaryModel(event);
    expect(model.magnitude).toBe("M不明");
    expect(model.depth).toBe("600km以上");
    expect(buildSummaryTokens(event, model).map((item) => item.text)).toEqual(
      expect.arrayContaining(["M不明"]),
    );
  });

  it("serial がない場合は undefined", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = toPresentationEvent(outcome);
    const noSerialEvent = { ...event, serial: null };
    const model = buildSummaryModel(noSerialEvent);

    expect(model.serial).toBeUndefined();
  });

  it("compact/focus 用 model・token は非 exact の震度 qualifier label を省略しない", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps())!;
    const event = {
      ...toPresentationEvent(outcome),
      maxInt: null,
      maxIntLabel: "5弱以上未入電",
      maxLgInt: null,
      maxLgIntLabel: "不明",
    };
    const model = buildSummaryModel(event);
    const texts = buildSummaryTokens(event, model).map((token) => token.text);

    expect(model.maxInt).toBe("震度5弱以上未入電");
    expect(model.maxLgInt).toBe("長周期不明");
    expect(texts).toContain("震度5弱以上未入電");
    expect(texts).toContain("長周期不明");
  });
});
