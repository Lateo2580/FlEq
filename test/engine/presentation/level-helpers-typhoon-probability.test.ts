import { describe, it, expect } from "vitest";
import { resolveTyphoonProbabilityLevels } from "../../../src/engine/presentation/level-helpers";

describe("resolveTyphoonProbabilityLevels", () => {
  function info(infoType: string, daily5Max: number) {
    return {
      infoType,
      regions: daily5Max === 0
        ? [{ daily: [0, 0, 0, 0, 0] }]
        : [{ daily: [0, 0, 0, 0, daily5Max] }],
    } as any;
  }

  it("取消は cancel/cancel", () => {
    expect(resolveTyphoonProbabilityLevels(info("取消", 0))).toEqual({
      frameLevel: "cancel", soundLevel: "cancel", maxDaily5: 0,
    });
  });

  it("発表 maxDaily5>0 は normal/normal", () => {
    expect(resolveTyphoonProbabilityLevels(info("発表", 50))).toEqual({
      frameLevel: "normal", soundLevel: "normal", maxDaily5: 50,
    });
  });

  it("発表 maxDaily5===0 は normal/info（静音化）", () => {
    expect(resolveTyphoonProbabilityLevels(info("発表", 0))).toEqual({
      frameLevel: "normal", soundLevel: "info", maxDaily5: 0,
    });
  });

  it("regions=[] のとき maxDaily5=0 扱い", () => {
    expect(resolveTyphoonProbabilityLevels({ infoType: "発表", regions: [] } as any)).toEqual({
      frameLevel: "normal", soundLevel: "info", maxDaily5: 0,
    });
  });
});
