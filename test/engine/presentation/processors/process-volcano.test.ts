import { describe, it, expect, vi } from "vitest";
import { buildVolcanoOutcome } from "../../../../src/engine/presentation/processors/process-volcano";
import { parseVolcanoTelegram } from "../../../../src/dmdata/volcano-parser";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import { createMockWsDataMessage, FIXTURE_VFVO54_ASH_RAPID } from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("buildVolcanoOutcome", () => {
  it("VFVO54 を処理して VolcanoOutcome を返す", () => {
    const volcanoState = new VolcanoStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const volcanoInfo = parseVolcanoTelegram(msg);
    expect(volcanoInfo).not.toBeNull();

    const outcome = buildVolcanoOutcome(msg, volcanoInfo!, volcanoState);

    expect(outcome.domain).toBe("volcano");
    expect(outcome.statsCategory).toBe("volcano");
    expect(outcome.volcanoPresentation).toBeDefined();
    expect(outcome.volcanoPresentation.frameLevel).toBeDefined();
    expect(outcome.presentation.frameLevel).toBe(outcome.volcanoPresentation.frameLevel);
  });

  it("state.isRenotification が設定される", () => {
    const volcanoState = new VolcanoStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const volcanoInfo = parseVolcanoTelegram(msg);
    expect(volcanoInfo).not.toBeNull();

    const outcome = buildVolcanoOutcome(msg, volcanoInfo!, volcanoState);
    // VFVO54 is ashfall, not alert → isRenotification is always false
    expect(outcome.state.isRenotification).toBe(false);
  });

  it("parseVolcanoTelegram がパース失敗 → null", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.volcano",
      id: "bad",
      passing: [],
      head: { type: "VFVO50", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    expect(parseVolcanoTelegram(msg)).toBeNull();
  });
});
