import { describe, it, expect } from "vitest";
import { predictionRegionCodeToCluster, __weatherAreaCluster_internals } from "../../src/ui/weather-area-cluster";

describe("predictionRegionCodeToCluster - コード上 2 桁の都道府県 prefix → 11 地方区分", () => {
  const CASES: Array<[string, string, string]> = [
    ["010000", "宗谷地方等(北海道)", "北海道"],
    ["011000", "宗谷地方", "北海道"],
    ["014100", "釧路・根室地方", "北海道"],
    ["020000", "青森県", "東北"],
    ["040000", "宮城県", "東北"],
    ["070000", "福島県", "東北"],
    ["150000", "新潟県", "北陸"],
    ["170000", "石川県", "北陸"],
    ["080000", "茨城県", "関東甲信"],
    ["140000", "神奈川県", "関東甲信"],
    ["190000", "山梨県", "関東甲信"],
    ["200000", "長野県", "関東甲信"],
    ["210000", "岐阜県", "東海"],
    ["230000", "愛知県", "東海"],
    ["260000", "京都府", "近畿"],
    ["270000", "大阪府", "近畿"],
    ["310000", "鳥取県", "中国"],
    ["340000", "広島県", "中国"],
    ["360000", "徳島県", "四国"],
    ["380000", "愛媛県", "四国"],
    ["400000", "福岡県", "九州北部"],
    ["420000", "長崎県", "九州北部"],
    ["450000", "宮崎県", "九州南部・奄美"],
    ["460100", "鹿児島県本土", "九州南部・奄美"],
    ["471000", "沖縄本島地方", "沖縄"],
  ];

  it.each(CASES)("コード %s (%s) → %s", (code, _name, expected) => {
    expect(predictionRegionCodeToCluster(code)).toBe(expected);
  });

  it("未知コード上 2 桁 → 'その他'", () => {
    expect(predictionRegionCodeToCluster("999999")).toBe("その他");
  });

  it("空文字 → 'その他'", () => {
    expect(predictionRegionCodeToCluster("")).toBe("その他");
  });

  it("47 都道府県すべての prefix がマップに存在する", () => {
    const map = __weatherAreaCluster_internals.PREFECTURE_TO_CLUSTER;
    for (let i = 1; i <= 47; i++) {
      const prefix = i.toString().padStart(2, "0");
      expect(map[prefix]).toBeDefined();
    }
  });

  it("公式区分外の細分名 ('東北南部' '関東北部' 等) はマップに存在しない", () => {
    const map = __weatherAreaCluster_internals.PREFECTURE_TO_CLUSTER;
    const values = Object.values(map);
    expect(values).not.toContain("東北南部");
    expect(values).not.toContain("東北北部");
    expect(values).not.toContain("関東北部");
    expect(values).not.toContain("関東南部");
  });

  it("11 区分のみが使われている (公式区分の網羅)", () => {
    const map = __weatherAreaCluster_internals.PREFECTURE_TO_CLUSTER;
    const expectedClusters = new Set([
      "北海道", "東北", "北陸", "関東甲信", "東海", "近畿",
      "中国", "四国", "九州北部", "九州南部・奄美", "沖縄",
    ]);
    for (const v of Object.values(map)) {
      expect(expectedClusters.has(v)).toBe(true);
    }
  });
});
