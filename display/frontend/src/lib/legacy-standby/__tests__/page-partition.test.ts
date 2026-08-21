import { describe, expect, it } from "vitest";
import { pageIdentity, planCardPageRuntimeUpdate, sequentialPartitionRanges } from "../page-partition";

describe("legacy standby page partition", () => {
  it("partitions sequentially and preserves the accepted prefix before an unmeasured probe", () => {
    const result = sequentialPartitionRanges(
      "quake",
      "side",
      4,
      20,
      (_, __, range) => range.end - range.start <= 2 ? range.end === 4 ? null : 20 : 30,
      () => [],
    );

    expect(result.ranges).toEqual([{ start: 0, end: 2, tails: [], omittedAreaCount: 0 }, { start: 2, end: 3, tails: [], omittedAreaCount: 0 }]);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.id).toBe("quake:page:2:4");
  });

  it("uses kind and occurrence as stable page identity", () => {
    expect(pageIdentity({ kindKey: "大雨警報", area: "熊本県山鹿市", occurrenceIndex: 1 })).toBe("大雨警報|熊本県山鹿市|1");
  });

  it("non-empty Area.Code を page identity に含め、旧コードなし形式は維持する", () => {
    expect(pageIdentity({ kindKey: "大雨警報", area: "府中市", areaCode: "1320600", occurrenceIndex: 0 }))
      .toBe("大雨警報|府中市|0|code:1320600");
    expect(pageIdentity({ kindKey: "大雨警報", area: "府中市", areaCode: "", occurrenceIndex: 0 }))
      .toBe("大雨警報|府中市|0");
  });

  it("keeps an existing active page and defers only newly added pages", () => {
    const next = planCardPageRuntimeUpdate(
      { activeKey: "b", knownKeys: ["a", "b"], pendingKeys: [], cycleOriginKey: null },
      ["a", "b", "c"],
      false,
    );

    expect(next).toEqual({ activeKey: "b", knownKeys: ["a", "b", "c"], pendingKeys: ["c"], cycleOriginKey: "b" });
  });

  it("keeps identity and pending keys during measurement growth", () => {
    const next = planCardPageRuntimeUpdate(
      { activeKey: "b", knownKeys: ["a", "b"], pendingKeys: ["a"], cycleOriginKey: "b" },
      ["a", "b", "c"],
      false,
      true,
    );
    expect(next).toEqual({ activeKey: "b", knownKeys: ["a", "b", "c"], pendingKeys: ["a"], cycleOriginKey: "b" });
  });

  it("marks tail-only content infeasible and transfers the probe placement", () => {
    const calls: string[] = [];
    const result = sequentialPartitionRanges("weather", "center", 0, 10, (key, placement) => {
      calls.push(`${key}:${placement}`);
      return 20;
    }, () => [{ kindKey: "大雨", omittedAreaCount: 1 }]);
    expect(result.infeasible).toBe(true);
    expect(calls).toEqual(["weather:center"]);
  });

  it("moves after an active deletion and replaces a deleted defer origin", () => {
    const activeDeleted = planCardPageRuntimeUpdate(
      { activeKey: "b", knownKeys: ["a", "b", "c"], pendingKeys: [], cycleOriginKey: null },
      ["a", "c"], false,
    );
    const originDeleted = planCardPageRuntimeUpdate(
      { activeKey: "b", knownKeys: ["a", "b", "c"], pendingKeys: ["c"], cycleOriginKey: "a" },
      ["b", "c"], false,
    );
    expect(activeDeleted.activeKey).toBe("c");
    expect(originDeleted.cycleOriginKey).toBe("b");
  });
});
