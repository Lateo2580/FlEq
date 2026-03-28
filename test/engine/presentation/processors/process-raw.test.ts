import { describe, it, expect } from "vitest";
import { processRaw } from "../../../../src/engine/presentation/processors/process-raw";
import type { WsDataMessage } from "../../../../src/types";

const mockMsg: WsDataMessage = {
  type: "data",
  version: "2.0",
  classification: "unknown",
  id: "test-raw",
  passing: [],
  head: { type: "ZZZZ99", author: "テスト", time: new Date().toISOString(), test: false, xml: true },
  format: "xml",
  compression: null,
  encoding: "utf-8",
  body: "raw",
};

describe("processRaw", () => {
  it("RawOutcome を返す", () => {
    const outcome = processRaw(mockMsg);
    expect(outcome.domain).toBe("raw");
    expect(outcome.parsed).toBeNull();
    expect(outcome.stats.shouldRecord).toBe(true);
    expect(outcome.presentation.frameLevel).toBe("info");
    expect(outcome.statsCategory).toBe("other");
  });

  it("statsCategory を引き継ぐ", () => {
    const outcome = processRaw(mockMsg, "earthquake");
    expect(outcome.statsCategory).toBe("earthquake");
  });
});
