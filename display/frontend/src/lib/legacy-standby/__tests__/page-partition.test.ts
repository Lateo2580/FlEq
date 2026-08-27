import { describe, expect, it } from "vitest";
import { pageIdentity, planCardPageRuntimeUpdate, sequentialPartitionRanges, SplitOnlyPartitionStateMachine } from "../page-partition";
import type { CardKey, PagePartitionKey } from "../types";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type CardKeyExcludesTornado = Assert<Equal<Extract<CardKey, "tornado">, never>>;
type PagePartitionKeyIncludesTornado = Assert<Equal<Extract<PagePartitionKey, "tornado">, "tornado">>;

void (null as unknown as CardKeyExcludesTornado);
void (null as unknown as PagePartitionKeyIncludesTornado);

describe("legacy standby page partition", () => {
  it("keeps a pending briefing block probe distinct from an infeasible outer entry", () => {
    const result = sequentialPartitionRanges("briefing", "side", 3, 260, (_key, _placement, range) => range.end === 2 ? null : 260, () => []);
    expect(result.infeasible).toBe(false);
    expect(result.ranges).toEqual([{ start: 0, end: 1, tails: [], omittedAreaCount: 0 }]);
    expect(result.pending[0]?.key).toBe("briefing");
  });

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

  it("keeps a dependent tornado rider on the partition/probe key path", () => {
    const result = sequentialPartitionRanges("tornado", "side", 1, 20, () => null, () => []);

    expect(result.pending).toEqual([{
      id: "tornado:page:0:1", key: "tornado", start: 0, end: 1, tails: [], omittedAreaCount: 0,
    }]);
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

  it("pageCount 増加時は確定済み range を全件 pending へ戻す", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    const sections = [{ id: "coast", itemCount: 2 }];
    const base = { epoch: "e", sections, probeBox: { width: 320, height: 100 } };
    let snapshot = machine.advance({ ...base, chromeSignature: "pages:1" });
    for (const end of [1, 2]) {
      expect(snapshot.pendingProbes[0]?.range.end).toBe(end);
      machine.recordProbeOpportunity(snapshot.pendingProbes[0]!.id, true);
      snapshot = machine.advance({ ...base, chromeSignature: "pages:1" });
    }
    snapshot = machine.advance({ ...base, chromeSignature: "pages:1" });
    expect(snapshot.stable).toBe(true);
    expect(snapshot.sections[0]?.ranges.map((range) => range.status)).toEqual(["ready"]);

    snapshot = machine.advance({ ...base, chromeSignature: "pages:2" });
    expect(snapshot.diagnostic).toBeNull();
    expect(snapshot.sections[0]?.ranges.map((range) => range.status)).toEqual(["pending"]);
    expect(snapshot.pendingProbes).toHaveLength(1);
  });

  it("同一 parent の候補 delivery は境界確定まで logical pass を増やさない", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    const input = {
      epoch: "e", sections: [{ id: "coast", itemCount: 3 }], chromeSignature: "c",
      probeBox: { width: 320, height: 100 },
    };
    let snapshot = machine.advance(input);
    expect(snapshot.pendingProbes[0]?.range).toMatchObject({ start: 0, end: 1 });
    machine.recordProbeOpportunity(snapshot.pendingProbes[0]!.id, true);
    snapshot = machine.advance(input);
    expect(snapshot.logicalPasses).toBe(0);
    expect(snapshot.pendingProbes[0]?.range).toMatchObject({ start: 0, end: 2 });
    machine.recordProbeOpportunity(snapshot.pendingProbes[0]!.id, true);
    snapshot = machine.advance(input);
    expect(snapshot.logicalPasses).toBe(0);
    expect(snapshot.pendingProbes[0]?.range).toMatchObject({ start: 0, end: 3 });
    machine.recordProbeOpportunity(snapshot.pendingProbes[0]!.id, false);
    snapshot = machine.advance(input);
    expect(snapshot.logicalPasses).toBe(0);
    expect(snapshot.pendingProbes[0]?.range).toMatchObject({ start: 2, end: 3 });
    machine.recordProbeOpportunity(snapshot.pendingProbes[0]!.id, true);
    snapshot = machine.advance(input);
    expect(snapshot.logicalPasses).toBe(1);
    expect(snapshot.diagnostic).toBeNull();
    expect(snapshot.sections[0]?.ranges.map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 3]]);
  });

  it("exact probe id は無効な3測定機会で partition-probe-unresolved になる", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    const input = {
      epoch: "e", sections: [{ id: "s", itemCount: 1 }], chromeSignature: "c",
      probeBox: { width: 320, height: 100 },
    };
    const pending = machine.advance(input);
    const id = pending.pendingProbes[0]!.id;
    expect(machine.recordProbeOpportunity(id, null)).toBe(true);
    expect(machine.recordProbeOpportunity(id, null)).toBe(true);
    expect(machine.advance(input).diagnostic).toBeNull();
    expect(machine.recordProbeOpportunity(id, null)).toBe(true);
    const failed = machine.advance(input);
    expect(failed.diagnostic).toBe("partition-probe-unresolved");
    expect(failed.diagnosticProbeId).toBe(id);
    expect(failed.logicalPasses).toBe(0);
  });

  it("split-only machine は境界を削除せず N=72/S=4 を70 logical pass以内に収束させる", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    const sections = Array.from({ length: 4 }, (_, index) => ({ id: `s${index}`, itemCount: 18 }));
    const input = {
      epoch: "e", sections, chromeSignature: "c", probeBox: { width: 320, height: 100 },
      fallbackProbe: (_sectionId: string, range: { start: number; end: number }) => range.end - range.start <= 1,
    };
    const initialBoundaries = new Set([0, 18]);
    let snapshot = machine.advance(input);
    const splitBoundaries = new Set(snapshot.sections[0]?.ranges.flatMap(({ start, end }) => [start, end]));
    expect([...initialBoundaries].every((boundary) => splitBoundaries.has(boundary))).toBe(true);
    while (!snapshot.stable && snapshot.diagnostic == null) snapshot = machine.advance(input);
    expect(snapshot.logicalPasses).toBeLessThanOrEqual(70);
    expect(snapshot.stable).toBe(true);
    expect(snapshot.pageCount).toBe(72);
  });

  it("A → B → A の非連続 logical candidate 再訪だけを partition-cycle にする", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    const base = {
      epoch: "e", sections: [{ id: "s", itemCount: 4 }], probeBox: { width: 320, height: 100 },
      fallbackProbe: () => true,
    };
    machine.advance({ ...base, chromeSignature: "A" });
    machine.advance({ ...base, chromeSignature: "A" });
    const changed = machine.advance({ ...base, chromeSignature: "B" });
    expect(changed.diagnostic).toBeNull();
    machine.advance({ ...base, chromeSignature: "B" });
    const revisited = machine.advance({ ...base, chromeSignature: "A" });
    expect(revisited.diagnostic).toBe("partition-cycle");
  });

  it("単一 item 不適合だけを terminal にし、境界と後続 range を残して再 probe しない", () => {
    const machine = new SplitOnlyPartitionStateMachine();
    let firstItemProbeCount = 0;
    const input = {
      epoch: "e", sections: [{ id: "s", itemCount: 2 }], chromeSignature: "c",
      probeBox: { width: 320, height: 100 },
      fallbackProbe: (_sectionId: string, range: { start: number; end: number }) => {
        if (range.start === 0) firstItemProbeCount += 1;
        return range.start > 0;
      },
    };
    let snapshot = machine.advance(input);
    expect(snapshot.sections[0]?.ranges.map(({ start, end, status }) => [start, end, status]))
      .toEqual([[0, 1, "infeasible"], [1, 2, "pending"]]);
    snapshot = machine.advance(input);
    snapshot = machine.advance(input);
    expect(snapshot.stable).toBe(true);
    expect(snapshot.sections[0]?.ranges.map(({ start, end, status }) => [start, end, status]))
      .toEqual([[0, 1, "infeasible"], [1, 2, "ready"]]);
    machine.advance(input);
    expect(firstItemProbeCount).toBe(1);
  });
});
