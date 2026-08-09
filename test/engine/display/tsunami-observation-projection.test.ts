import { describe, expect, it } from "vitest";
import type { SpecialValue } from "../../../src/types";
import type { PresentationTsunamiObservation } from "../../../src/engine/presentation/types";
import { projectDisplayTsunamiObservation } from "../../../src/engine/display/tsunami-observation-projection";

function height(over: Partial<SpecialValue<number>> = {}): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "unknown",
    ...over,
  };
}

describe("projectDisplayTsunamiObservation", () => {
  it("Presentation の TsunamiHeight semantic を wire へ投影し、内部 SpecialValue は漏らさない", () => {
    const source: PresentationTsunamiObservation = {
      areaName: "岩手県",
      areaKind: "津波警報",
      areaCode: "210",
      stationCode: "21003",
      stationName: "釜石",
      arrivalTime: null,
      initial: "押し",
      maxHeightValue: "巨大",
      maxHeight: height({
        raw: "巨大",
        description: "巨大",
        presence: "qualitative",
      }),
      condition: "重要",
      heightCondition: "上昇中",
    };

    const output = projectDisplayTsunamiObservation(source);
    expect(output).toMatchObject({
      maxHeightValue: "巨大",
      maxHeightSemantic: {
        presence: "qualitative", label: "巨大", value: null,
        badge: "?", color: "unknown", render: true,
      },
    });
    expect(output).not.toHaveProperty("maxHeight");
  });

  it("旧 V1 Display observation は semantic が無ければ scalar を再解釈せず fallback のまま通す", () => {
    const output = projectDisplayTsunamiObservation({
      areaName: "岩手県",
      areaKind: "津波警報",
      stationName: "釜石",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "巨大",
      condition: null,
    });
    expect(output).toEqual({
      areaName: "岩手県",
      areaKind: "津波警報",
      stationName: "釜石",
      arrivalTime: null,
      initial: null,
      maxHeightValue: "巨大",
      condition: null,
    });
  });
});
