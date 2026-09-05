import { describe, expect, it } from "vitest";
import type { DisplayWeatherWarningForecastTargetV1 } from "../protocol";
import { vpwp50ForecastTargetDisplayLabel } from "../weather-warning-forecast";

function target(fields: Partial<DisplayWeatherWarningForecastTargetV1>): DisplayWeatherWarningForecastTargetV1 {
  return { key: "target", scope: "area", name: "北部", parentAreaName: "北部", areaCode: null, localCode: null, periods: [], ...fields };
}

describe("vpwp50ForecastTargetDisplayLabel", () => {
  it.each([
    [target({ areaCode: "200010" }), "長野県 北部"],
    [target({ areaCode: "0121400", parentAreaName: "稚内市" }), "北海道 稚内市"],
    [target({ scope: "local", areaCode: "0121400", parentAreaName: "稚内市", name: "稚内海岸", localCode: "L001" }), "北海道 稚内市 稚内海岸"],
    [target({ scope: "local", areaCode: "200010", parentAreaName: "長野県 北部", name: "菅平周辺" }), "長野県 北部 菅平周辺"],
    [target({ areaCode: "200010", parentAreaName: "北部（長野県）" }), "長野県 北部（長野県）"],
    [target({ scope: "local", parentAreaName: "宗谷地方", name: "沿岸" }), "宗谷地方 沿岸"],
  ])("returns %s", (input, expected) => {
    expect(vpwp50ForecastTargetDisplayLabel(input)).toBe(expected);
  });
});
