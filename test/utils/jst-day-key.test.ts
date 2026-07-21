import { describe, it, expect } from "vitest";
import { jstDayKey } from "../../src/utils/jst-day-key";

describe("jstDayKey", () => {
  it("UTC ミリ秒を JST 暦日キー (YYYY-MM-DD) に変換する", () => {
    // 2026-07-21T00:00:00Z → JST 2026-07-21T09:00:00
    expect(jstDayKey(Date.parse("2026-07-21T00:00:00Z"))).toBe("2026-07-21");
  });

  it("UTC で日付が変わっていなくても JST で日付をまたぐ時刻は繰り上がる", () => {
    // 2026-07-20T16:00:00Z → JST 2026-07-21T01:00:00
    expect(jstDayKey(Date.parse("2026-07-20T16:00:00Z"))).toBe("2026-07-21");
  });

  it("JST でまだ日付が変わらない時刻は前日のキーを返す", () => {
    // 2026-07-20T14:59:59Z → JST 2026-07-20T23:59:59
    expect(jstDayKey(Date.parse("2026-07-20T14:59:59Z"))).toBe("2026-07-20");
  });
});
