import { describe, expect, it } from "vitest";
import { formatHm, formatHms, formatMdHm, recentQuakeId, splitNumberUnit } from "../format";
import type { DisplayRecentQuakeV1 } from "../protocol";

function rq(over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: null,
    reportDateTime: "2026-07-14T21:00:00+09:00",
    originTime: "2026-07-14T20:58:00+09:00",
    hypocenterName: "浦河沖",
    magnitude: "5.2",
    maxInt: "4",
    maxIntRank: 5,
    depth: "30km",
    tsunamiWarning: false,
    ...over,
  };
}

describe("recentQuakeId", () => {
  it("eventId があればそれを使う", () => {
    expect(recentQuakeId(rq({ eventId: "E1" }))).toBe("E1");
  });

  it("eventId null は originTime|震央名 (reportDateTime 非依存で訂正報に安定)", () => {
    const a = rq({ eventId: null, originTime: "2026-07-14T20:58:00+09:00", hypocenterName: "浦河沖", reportDateTime: "2026-07-14T21:00:00+09:00" });
    const b = rq({ eventId: null, originTime: "2026-07-14T20:58:00+09:00", hypocenterName: "浦河沖", reportDateTime: "2026-07-14T21:05:00+09:00" }); // 訂正で reportDateTime 変化
    expect(recentQuakeId(a)).toBe(recentQuakeId(b)); // ID 不変
    expect(recentQuakeId(a)).toBe("2026-07-14T20:58:00+09:00|浦河沖");
  });

  it("originTime も null のときのみ reportDateTime を最終手段に使う", () => {
    expect(recentQuakeId(rq({ eventId: null, originTime: null, reportDateTime: "2026-07-14T21:00:00+09:00", hypocenterName: "沖合" })))
      .toBe("2026-07-14T21:00:00+09:00|沖合");
  });
});

describe("formatHm / formatHms", () => {
  it("正常な ISO 文字列を HH:MM / HH:MM:SS に整形する", () => {
    const iso = "2026-07-07T09:05:03+09:00";
    expect(formatHm(iso)).toBe("09:05");
    expect(formatHms(iso)).toBe("09:05:03");
  });

  it("null は '-' を返す", () => {
    expect(formatHm(null)).toBe("-");
    expect(formatHms(null)).toBe("-");
  });

  it("空文字は '-' を返す (欠損 OriginTime が \"\" で渡るケース)", () => {
    expect(formatHm("")).toBe("-");
    expect(formatHms("")).toBe("-");
  });

  it("パース不能な文字列 (Invalid Date) は 'NaN:NaN' ではなく '-' を返す", () => {
    expect(formatHm("invalid")).toBe("-");
    expect(formatHms("invalid")).toBe("-");
  });
});

describe("formatMdHm", () => {
  it("正常な ISO 文字列を M/D HH:MM (ゼロ埋めなしの月日) に整形する", () => {
    expect(formatMdHm("2011-03-11T14:46:18+09:00")).toBe("3/11 14:46");
  });

  it("月・日とも2桁の日付でもゼロ埋めしない", () => {
    expect(formatMdHm("2026-12-25T09:05:00+09:00")).toBe("12/25 09:05");
  });

  it("null / 空文字 / パース不能は '-' を返す", () => {
    expect(formatMdHm(null)).toBe("-");
    expect(formatMdHm("")).toBe("-");
    expect(formatMdHm("invalid")).toBe("-");
  });
});

describe("splitNumberUnit", () => {
  it("splits a trailing unit from the numeric part", () => {
    expect(splitNumberUnit("20km")).toEqual({ value: "20", unit: "km" });
    expect(splitNumberUnit("920hPa")).toEqual({ value: "920", unit: "hPa" });
  });

  it("keeps a leading '~' prefix on the value side", () => {
    expect(splitNumberUnit("~10km")).toEqual({ value: "~10", unit: "km" });
  });

  it("returns an empty unit when there is no trailing unit", () => {
    expect(splitNumberUnit("-")).toEqual({ value: "-", unit: "" });
  });
});
