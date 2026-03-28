import { describe, it, expect, vi } from "vitest";
import { processNankaiTrough } from "../../../../src/engine/presentation/processors/process-nankai-trough";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("processNankaiTrough", () => {
  it("パース失敗 → null", () => {
    const msg = { type: "data" as const, version: "2.0", classification: "telegram.earthquake", id: "bad", passing: [], head: { type: "VYSE50", author: "気象庁", time: new Date().toISOString(), test: false, xml: true }, format: "xml" as const, compression: null, encoding: "utf-8" as const, body: "invalid" };
    expect(processNankaiTrough(msg)).toBeNull();
  });
});
