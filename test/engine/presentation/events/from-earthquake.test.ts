import { describe, it, expect } from "vitest";
import { fromEarthquakeOutcome, resolveEarthquakeTsunamiWarning } from "../../../../src/engine/presentation/events/from-earthquake";
import { processEarthquake } from "../../../../src/engine/presentation/processors/process-earthquake";
import { createMockWsDataMessage, FIXTURE_VXSE53_ENCHI } from "../../../helpers/mock-message";
import type { EarthquakeOutcome } from "../../../../src/engine/presentation/types";

describe("resolveEarthquakeTsunamiWarning", () => {
  it("text が null なら false", () => {
    expect(resolveEarthquakeTsunamiWarning(null)).toBe(false);
  });

  it("text が空文字なら false", () => {
    expect(resolveEarthquakeTsunamiWarning("")).toBe(false);
  });

  it("text が空白のみ (全角空白含む) なら false", () => {
    expect(resolveEarthquakeTsunamiWarning("　 ")).toBe(false);
  });

  it("「この地震による津波の心配はありません」は false", () => {
    expect(resolveEarthquakeTsunamiWarning("この地震による津波の心配はありません")).toBe(false);
  });

  it("「若干の海面変動があるかもしれませんが被害の心配はありません」は false", () => {
    expect(
      resolveEarthquakeTsunamiWarning("若干の海面変動があるかもしれませんが被害の心配はありません"),
    ).toBe(false);
  });

  it("「津波警報を発表中です」は true", () => {
    expect(resolveEarthquakeTsunamiWarning("津波警報を発表中です")).toBe(true);
  });
});

describe("fromEarthquakeOutcome", () => {
  function outcomeFromFixture(): EarthquakeOutcome {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);
    if (outcome == null) throw new Error("processEarthquake が null を返した");
    return outcome;
  }

  it("tsunami.text が「心配はありません」を含む実 fixture では tsunamiWarning=false になる", () => {
    const event = fromEarthquakeOutcome(outcomeFromFixture());
    expect(event.tsunamiWarning).toBe(false);
  });

  it("tsunami.text が津波警報言及を含む場合は tsunamiWarning=true になる (Phase A #2)", () => {
    const outcome = outcomeFromFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: { ...outcome.parsed, tsunami: { text: "津波警報を発表中です" } },
    });
    expect(event.tsunamiWarning).toBe(true);
  });

  it("intensity.maxLgInt を PresentationEvent.maxLgInt にそのまま渡す", () => {
    const outcome = outcomeFromFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        intensity: { ...(outcome.parsed.intensity ?? { maxInt: "3", areas: [] }), maxLgInt: "3" },
      },
    });
    expect(event.maxLgInt).toBe("3");
  });
});
