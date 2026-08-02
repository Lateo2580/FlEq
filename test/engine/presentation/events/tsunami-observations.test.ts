import { testTelegramMeta } from "../../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import { buildTsunamiObservations } from "../../../../src/engine/presentation/events/tsunami-observations";
import type { ParsedTsunamiInfo } from "../../../../src/types";
import {
  canonicalizeLegacyTsunamiInfo,
  type LegacyParsedTsunamiInfoInput,
} from "../../../../src/dmdata/tsunami-legacy-adapter";

function baseInfo(over: Partial<LegacyParsedTsunamiInfoInput> = {}): ParsedTsunamiInfo {
  return canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE51",
    infoType: "発表",
    title: "津波情報",
    reportDateTime: "2026-07-07T14:32:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    warningComment: "",
    isTest: false,
    ...over,
  });
}

describe("buildTsunamiObservations", () => {
  it("areaKind を forecast[].kind から補完する (対応する予報区がある場合)", () => {
    const info = baseInfo({
      forecast: [
        { areaName: "岩手県", kind: "大津波警報", maxHeightDescription: "巨大", firstHeight: "" },
      ],
      observations: [
        {
          areaName: "岩手県", name: "釜石", sensor: "検潮所",
          stationCode: "21003", arrivalTime: "", initial: "押し",
          maxHeightCondition: "重要", maxHeightValue: "３．２ｍ",
          maxHeightValueCondition: "上昇中",
        },
      ],
    });
    const observations = buildTsunamiObservations(info);
    expect(observations).toEqual([
      {
        areaName: "岩手県", areaKind: "大津波警報", stationName: "釜石",
        stationCode: "21003", arrivalTime: null, initial: "押し",
        maxHeightValue: "３．２ｍ", condition: "重要", heightCondition: "上昇中",
      },
    ]);
  });

  it("接尾辞つき表記 (「大津波警報：発表」等) の areaKind を canonical ラベルへ正規化する (観測フィルタの exact match 対策)", () => {
    const info = baseInfo({
      forecast: [
        { areaName: "岩手県", kind: "大津波警報：発表", maxHeightDescription: "巨大", firstHeight: "" },
      ],
      observations: [
        {
          areaName: "岩手県", name: "釜石", sensor: "検潮所",
          arrivalTime: "", initial: "押し", maxHeightCondition: "重要", maxHeightValue: "３．２ｍ",
        },
      ],
    });
    const observations = buildTsunamiObservations(info);
    expect(observations[0]).toMatchObject({ areaKind: "大津波警報" });
  });

  it("対応する予報区が無ければ areaKind は null のまま", () => {
    const info = baseInfo({
      forecast: [],
      observations: [
        {
          areaName: "岩手県", name: "釜石", sensor: "検潮所",
          arrivalTime: "", initial: "押し", maxHeightCondition: "重要", maxHeightValue: null,
        },
      ],
    });
    const observations = buildTsunamiObservations(info);
    expect(observations[0].areaKind).toBeNull();
  });

  it("observations が無ければ空配列を返す", () => {
    expect(buildTsunamiObservations(baseInfo())).toEqual([]);
  });
});
