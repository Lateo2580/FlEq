import { describe, expect, it } from "vitest";
import { normalizeBackgroundTone, normalizeTickerSurface } from "../display-contract";
import { toTickerJob } from "../ticker-schedule";
import { tickerEvent } from "./fixtures";

describe("display contract の縮退", () => {
  it.each([undefined, null, "unknown", 7, {}, []])("backgroundTone %j は calm に縮退する", (value) => {
    expect(normalizeBackgroundTone(value)).toBe("calm");
  });

  it.each([undefined, null, "unknown", 7, {}, []])("tickerSurface %j は none に縮退する", (value) => {
    expect(normalizeTickerSurface(value)).toBe("none");
  });

  it("許可された値だけをそのまま通す", () => {
    expect(normalizeBackgroundTone("quakeExtreme")).toBe("quakeExtreme");
    expect(normalizeTickerSurface("solid")).toBe("solid");
  });

  it("toTickerJob は solid を保持し、欠落・未知値を none にする", () => {
    expect(toTickerJob(tickerEvent({ id: "solid", tickerSurface: "solid" }), 1).surface).toBe("solid");
    expect(toTickerJob(tickerEvent({ id: "missing", tickerSurface: undefined }), 1).surface).toBe("none");
    expect(toTickerJob(tickerEvent({ id: "unknown", tickerSurface: "unexpected" as never }), 1).surface).toBe("none");
  });
});
