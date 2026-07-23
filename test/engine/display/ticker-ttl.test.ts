import { describe, expect, it } from "vitest";
import { tickerTtlMs } from "../../../src/engine/display/ticker-ttl";

describe("tickerTtlMs", () => {
  it("EEW は priority に関わらず 10 分", () => {
    expect(tickerTtlMs("high", "eew")).toBe(10 * 60_000);
    expect(tickerTtlMs("mid", "eew")).toBe(10 * 60_000);
  });

  it("非 EEW は従来どおり", () => {
    expect(tickerTtlMs("high", "tsunami")).toBe(30 * 60_000);
    expect(tickerTtlMs("mid", "volcano")).toBe(120 * 60_000);
    expect(tickerTtlMs("low", null)).toBe(180 * 60_000);
    expect(tickerTtlMs("mid")).toBe(120 * 60_000);
  });
});
