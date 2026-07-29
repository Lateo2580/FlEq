import { describe, expect, it } from "vitest";
import { relativeJstDayLabel } from "../jst-day-key";

describe("relativeJstDayLabel", () => {
  it("23:59/00:00 JST をまたいで今日・明日を判定し、それ以外は null にする", () => {
    const justBeforeMidnight = Date.parse("2026-07-21T14:59:59Z");
    expect(relativeJstDayLabel("2026-07-21", justBeforeMidnight)).toBe("きょう");
    expect(relativeJstDayLabel("2026-07-22", justBeforeMidnight)).toBe("あす");
    expect(relativeJstDayLabel("2026-07-23", justBeforeMidnight)).toBeNull();

    const midnight = Date.parse("2026-07-21T15:00:00Z");
    expect(relativeJstDayLabel("2026-07-22", midnight)).toBe("きょう");
    expect(relativeJstDayLabel("2026-07-23", midnight)).toBe("あす");
    expect(relativeJstDayLabel("2026-07-21", midnight)).toBeNull();
  });
});
