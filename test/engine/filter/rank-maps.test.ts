import { describe, it, expect } from "vitest";
import { toFrameLevelRank, toIntensityRank, toLgIntRank } from "../../../src/engine/filter/rank-maps";

describe("toFrameLevelRank", () => {
  it.each([
    ["cancel", 0], ["info", 1], ["normal", 2], ["warning", 3], ["critical", 4],
  ])("%s → %d", (input, expected) => {
    expect(toFrameLevelRank(input)).toBe(expected);
  });

  it("未知の値は null", () => {
    expect(toFrameLevelRank("unknown")).toBeNull();
  });
});

describe("toIntensityRank", () => {
  it.each([
    ["1", 1], ["4", 4], ["5-", 5], ["5弱", 5], ["5+", 6], ["5強", 6],
    ["6-", 7], ["6弱", 7], ["6+", 8], ["6強", 8], ["7", 9],
  ])("%s → %d", (input, expected) => {
    expect(toIntensityRank(input)).toBe(expected);
  });

  it("未知の値は null", () => {
    expect(toIntensityRank("unknown")).toBeNull();
  });
});

describe("toLgIntRank", () => {
  it.each([
    ["0", 0], ["1", 1], ["2", 2], ["3", 3], ["4", 4],
  ])("%s → %d", (input, expected) => {
    expect(toLgIntRank(input)).toBe(expected);
  });
});
