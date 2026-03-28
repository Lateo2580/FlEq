import { describe, it, expect, vi } from "vitest";
import { processTsunami } from "../../../../src/engine/presentation/processors/process-tsunami";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { createMockWsDataMessage, FIXTURE_VTSE41_WARN, FIXTURE_VTSE41_CANCEL } from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("processTsunami", () => {
  it("正常な津波電文 → TsunamiOutcome", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processTsunami(msg, tsunamiState);
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("tsunami");
    expect(outcome!.statsCategory).toBe("tsunami");
  });

  it("VTSE41 で state.levelBefore/levelAfter を記録する", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processTsunami(msg, tsunamiState);
    expect(outcome!.state.levelBefore).toBeNull();
    expect(outcome!.state.levelAfter).not.toBeNull();
    expect(outcome!.state.changed).toBe(true);
  });

  it("取消報 → frameLevel cancel + state changed", () => {
    const tsunamiState = new TsunamiStateHolder();
    // First set state
    const warn = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    processTsunami(warn, tsunamiState);
    // Then cancel
    const cancel = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL);
    const outcome = processTsunami(cancel, tsunamiState);
    expect(outcome!.presentation.frameLevel).toBe("cancel");
  });

  it("パース失敗 → null", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = { type: "data" as const, version: "2.0", classification: "telegram.earthquake", id: "bad", passing: [], head: { type: "VTSE41", author: "気象庁", time: new Date().toISOString(), test: false, xml: true }, format: "xml" as const, compression: null, encoding: "utf-8" as const, body: "invalid" };
    expect(processTsunami(msg, tsunamiState)).toBeNull();
  });
});
