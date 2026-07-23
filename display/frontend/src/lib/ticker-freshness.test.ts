import { describe, expect, it } from "vitest";
import { filterStaleEews } from "./ticker-freshness";
import type { DisplayEventDtoV1, DisplayStateSnapshotV1 } from "./protocol";

function ticker(over: Partial<DisplayEventDtoV1>): DisplayEventDtoV1 {
  return { version: 1, seq: 0, id: "e1", eventKey: "eew:X:1", groupKey: "eew:X", domain: "eew", type: "VXSE45", infoType: "発表", reportDateTime: "2026-07-23T20:00:00+09:00", title: "EEW", headline: null, publishingOffice: "気象庁", isTest: false, frameLevel: "warning", isCancellation: false, summary: { text: "t", role: "warning" }, emergency: null, recentQuake: null, latestQuake: null, tickerDetail: null, ...over };
}
function snapshot(generatedAt: string, ids: string[]): Pick<DisplayStateSnapshotV1, "generatedAt" | "activeEews"> {
  return { generatedAt, activeEews: ids.map((eventId) => ({ eventId }) as never) };
}
describe("filterStaleEews", () => {
  const now = "2026-07-23T20:00:00+09:00";
  it("11 分超の inactive EEW を除外し、境界内の EEW は残す", () => {
    const stale = ticker({ id: "stale", reportDateTime: "2026-07-23T19:48:00+09:00" });
    const boundary = ticker({ id: "boundary", reportDateTime: "2026-07-23T19:49:00+09:00" });
    expect(filterStaleEews([stale, boundary], snapshot(now, [])).map((dto) => dto.id)).toEqual(["boundary"]);
  });
  it("古くても activeEews に groupKey 一致なら残す", () => {
    expect(filterStaleEews([ticker({ reportDateTime: "2026-07-23T19:00:00+09:00" })], snapshot(now, ["X"]))).toHaveLength(1);
  });
  it("不正日時の inactive EEW は除外し、非 EEW は残す", () => {
    const invalid = ticker({ id: "invalid", reportDateTime: "invalid" });
    const volcano = ticker({ id: "volcano", domain: "volcano", reportDateTime: "2026-07-23T10:00:00+09:00" });
    expect(filterStaleEews([invalid, volcano], snapshot(now, [])).map((dto) => dto.id)).toEqual(["volcano"]);
  });
});
