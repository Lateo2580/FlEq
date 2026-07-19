import { describe, it, expect } from "vitest";
import {
  aggregateByPrefecture,
  pickThreshold,
  TARGET_ROWS,
  CANDIDATE_THRESHOLDS,
} from "../../../src/engine/presentation/typhoon-probability-aggregate";
import { createMockWsDataMessage, FIXTURE_VPTA50_DAMREY } from "../../helpers/mock-message";
import { parseTyphoonProbability } from "../../../src/dmdata/typhoon-probability-parser";

describe("aggregateByPrefecture", () => {
  it("DAMREY: 非ゼロ府県=45", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    const aggs = aggregateByPrefecture(info.regions);
    const active = aggs.filter(a => a.maxDaily5 > 0);
    expect(active.length).toBe(45);
  });

  it("DAMREY: 大東島地方の maxDaily5=100, worstRegion.areaName='大東島地方'", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    const aggs = aggregateByPrefecture(info.regions);
    const daito = aggs.find(a => a.prefName === "大東島地方")!;
    expect(daito.maxDaily5).toBe(100);
    expect(daito.worstRegion.areaName).toBe("大東島地方");
  });

  it("島根県の二次細分が daily[4] 降順", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    const aggs = aggregateByPrefecture(info.regions);
    const shimane = aggs.find(a => a.prefName === "島根県")!;
    expect(shimane.regions[0].areaName).toBe("益田地区");
    expect(shimane.regions[0].daily[4]).toBe(92);
    // 降順
    for (let i = 1; i < shimane.regions.length; i++) {
      expect(shimane.regions[i - 1].daily[4]!).toBeGreaterThanOrEqual(shimane.regions[i].daily[4]!);
    }
  });
});

describe("pickThreshold (振動なし保証)", () => {
  function mockActive(maxValues: number[]) {
    return maxValues.map((v, i) => ({
      prefName: `P${i}`, prefCode: `${i}`, maxDaily5: v,
      worstRegion: null as any, worstPeak: null as any, regions: [],
    }));
  }

  it("DAMREY 45府県: visible ≤ 24 となる最小閾値を選ぶ", () => {
    const dist = [100,100,100,99,99,99,98,98,97,95,95,92,91,86,79,77,75,65,60,55,50,
                  46,40,35,32,28,22,18,15,12,10,8,7,6,5,4,3,3,2,2,2,1,1,1,1];
    const t = pickThreshold(mockActive(dist), TARGET_ROWS);
    const visible = dist.filter(v => v >= t).length;
    expect(visible).toBeLessThanOrEqual(TARGET_ROWS);
    expect(t).toBeGreaterThanOrEqual(1);
  });

  it("活発府県 11府県 (>=20%): threshold=1 で visible=11", () => {
    const dist = [100,80,70,60,50,40,30,25,22,21,20];
    const t = pickThreshold(mockActive(dist), TARGET_ROWS);
    expect(t).toBe(1);
  });

  it("活発府県 1府県増えただけで閾値が跳ばないこと（11→12でも同じ閾値）", () => {
    const dist11 = [100,80,70,60,50,40,30,25,22,21,20];
    const dist12 = [...dist11, 19];
    const t11 = pickThreshold(mockActive(dist11), TARGET_ROWS);
    const t12 = pickThreshold(mockActive(dist12), TARGET_ROWS);
    expect(t11).toBe(t12);
  });

  it("活発府県 25府県: 24以下に収まる最小閾値が選ばれる", () => {
    const dist = Array.from({length: 25}, (_, i) => 100 - i * 3);
    const t = pickThreshold(mockActive(dist), TARGET_ROWS);
    const visible = dist.filter(v => v >= t).length;
    expect(visible).toBeLessThanOrEqual(TARGET_ROWS);
  });

  it("CANDIDATE_THRESHOLDS は [1,3,5,10,20,30,50]", () => {
    expect(CANDIDATE_THRESHOLDS).toEqual([1, 3, 5, 10, 20, 30, 50]);
  });
});
