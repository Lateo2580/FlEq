import { describe, it, expect } from "vitest";
import { compactIntensityGroups, QUAKE_REPLAY_AREA_BUDGET } from "../compact-intensity";
import type { DisplayIntensityGroupV1, DisplayIntensitySemanticV1 } from "../protocol";

function grp(over: Partial<DisplayIntensityGroupV1> & { intensity: string; rank: number }): DisplayIntensityGroupV1 {
  return { areas: [], omittedAreaCount: 0, ...over };
}

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4", presence: "value", label: "4", condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "normalRank", render: true, safetyLowerRank: 4,
    safetyUpperRank: 4, safetyRank: 4, colorRank: 4, ...over,
  };
}

describe("compactIntensityGroups", () => {
  it("rank 降順に並べ替える (入力順に依らない)", () => {
    const res = compactIntensityGroups([
      grp({ intensity: "3", rank: 3, areas: ["A市"] }),
      grp({ intensity: "5弱", rank: 5, areas: ["B市"] }),
      grp({ intensity: "4", rank: 4, areas: ["C市"] }),
    ]);
    expect(res.groups.map((g) => g.rank)).toEqual([5, 4, 3]);
  });

  it("空入力は groups=[] を返す (震度セクション非表示の根拠)", () => {
    const res = compactIntensityGroups([]);
    expect(res.groups).toEqual([]);
    expect(res.omittedAreaCount).toBe(0);
  });

  it("地域数が予算内なら全件表示し省略なし", () => {
    const res = compactIntensityGroups([grp({ intensity: "4", rank: 4, areas: ["宮城県仙台市", "宮城県石巻市"] })], 8);
    expect(res.groups[0].areas).toEqual(["宮城県仙台市", "宮城県石巻市"]);
    expect(res.omittedAreaCount).toBe(0);
  });

  it("予算を超える地域は上位グループから詰め、残りを omittedAreaCount へ畳む", () => {
    const res = compactIntensityGroups(
      [
        grp({ intensity: "5弱", rank: 5, areas: ["a", "b", "c"] }),
        grp({ intensity: "4", rank: 4, areas: ["d", "e", "f"] }),
      ],
      4,
    );
    // 予算 4: 震度5弱(3件) + 震度4 の先頭1件、残り 2 件が省略
    expect(res.groups[0].areas).toEqual(["a", "b", "c"]);
    expect(res.groups[1].areas).toEqual(["d"]);
    expect(res.omittedAreaCount).toBe(2);
  });

  it("予算が尽きた以降のグループは丸ごと省略数へ", () => {
    const res = compactIntensityGroups(
      [
        grp({ intensity: "5強", rank: 6, areas: ["a", "b"] }),
        grp({ intensity: "3", rank: 3, areas: ["c", "d", "e"] }),
      ],
      2,
    );
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].areas).toEqual(["a", "b"]);
    expect(res.omittedAreaCount).toBe(3); // 下位グループ全 3 件
  });

  it("サーバ cap の omittedAreaCount も省略数に加算する", () => {
    const res = compactIntensityGroups([grp({ intensity: "4", rank: 4, areas: ["a", "b"], omittedAreaCount: 12 })], 8);
    expect(res.groups[0].areas).toEqual(["a", "b"]);
    expect(res.omittedAreaCount).toBe(12);
  });

  it("既定予算は QUAKE_REPLAY_AREA_BUDGET", () => {
    const many = Array.from({ length: 20 }, (_, i) => `市${i}`);
    const res = compactIntensityGroups([grp({ intensity: "5弱", rank: 5, areas: many })]);
    expect(res.groups[0].areas).toHaveLength(QUAKE_REPLAY_AREA_BUDGET);
    expect(res.omittedAreaCount).toBe(20 - QUAKE_REPLAY_AREA_BUDGET);
  });

  it("semantic を compact 出力へ保持し、render:false は旧 scalar rank に関係なく除外する", () => {
    const unknown = semantic({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電",
      badge: "?", color: "unknown", safetyLowerRank: null, safetyUpperRank: null,
      safetyRank: null, colorRank: null,
    });
    const missing = semantic({
      raw: null, presence: "missing", label: null, badge: null, color: "notRendered",
      render: false, safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const res = compactIntensityGroups([
      grp({ intensity: "不明", rank: -1, intensitySemantic: unknown, areas: ["表示地域"] }),
      grp({ intensity: "7", rank: 9, intensitySemantic: missing, areas: ["欠落地域"] }),
    ]);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].intensitySemantic).toEqual(unknown);
    expect(res.groups[0].areas).toEqual(["表示地域"]);
    expect(res.omittedAreaCount).toBe(0);
  });
});
