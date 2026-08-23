import { describe, expect, it } from "vitest";
import { floodPageAreaEntries, floodPartitionProbeSentinel } from "../standby-cards";
import type { DisplayFloodRiverV1 } from "../protocol";

function river(riverKey: string, riverName: string, kindName = "氾濫警戒情報"): DisplayFloodRiverV1 {
  return {
    riverKey, riverName, kindName, level: "L3", levelRank: 30,
    reportDateTime: "2026-08-23T00:00:00.000Z", station: null,
  };
}

describe("flood pagination adapters", () => {
  it("maps rivers to PageAreaEntry with weather-style kind/name occurrences and riverKey identity", () => {
    expect(floodPageAreaEntries([
      river("r-1", "多摩川"), river("r-2", "多摩川"), river("r-3", "荒川", "氾濫危険情報"),
    ])).toEqual([
      { kindKey: "氾濫警戒情報", area: "多摩川", areaCode: "r-1", occurrenceIndex: 0 },
      { kindKey: "氾濫警戒情報", area: "多摩川", areaCode: "r-2", occurrenceIndex: 1 },
      { kindKey: "氾濫危険情報", area: "荒川", areaCode: "r-3", occurrenceIndex: 0 },
    ]);
  });

  it("uses the fixed-height sentinel contract: fit=0 and fail=fixedHeightPx+1", () => {
    expect(floodPartitionProbeSentinel(true, 200)).toBe(0);
    expect(floodPartitionProbeSentinel(false, 200)).toBe(201);
    expect(floodPartitionProbeSentinel(false, 216)).toBe(217);
  });
});
