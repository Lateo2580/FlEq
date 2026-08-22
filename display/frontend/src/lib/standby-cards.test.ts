import { describe, expect, it } from "vitest";
import type { ActiveStandbyCardV1, StandbySeverity } from "./protocol";
import {
  layoutFloodWideRows,
  partitionStandbyItems,
  rightStackBudgetPx,
  selectRightStack,
  selectRightStackWithTyphoonCompact,
  selectRightStackWithSummary,
} from "./standby-cards";

function item(kind: string, surface: string, key = kind, severity: StandbySeverity = "warning"): ActiveStandbyCardV1 {
  return {
    kind, surface, key, sourceEventIds: [], updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null,
    restored: false, severity, data: {},
  } as unknown as ActiveStandbyCardV1;
}

describe("standby-cards", () => {
  it("partitions every supported surface and keeps unknown data without throwing", () => {
    const items = [
      item("heat", "corner-right"), item("flood", "clock-top-wide"), item("tornado", "weather-rider"),
      item("longPeriod", "quake-rider"), item("nankaiTrough", "clock-below"),
      item("future", "corner-right", "future-known-surface"), item("future", "future-surface"),
    ];
    expect(() => partitionStandbyItems(items)).not.toThrow();
    const result = partitionStandbyItems(items);
    expect(result.cornerRight.map((candidate) => candidate.key)).toEqual(["heat"]);
    expect(result.clockTopWide.map((candidate) => candidate.key)).toEqual(["flood"]);
    expect(result.weatherRider.map((candidate) => candidate.key)).toEqual(["tornado"]);
    expect(result.quakeRider.map((candidate) => candidate.key)).toEqual(["longPeriod"]);
    expect(result.clockBelow.map((candidate) => candidate.key)).toEqual(["nankaiTrough"]);
    expect(result.unknown.map((candidate) => candidate.key)).toEqual(["future-known-surface", "future"]);
  });

  it("applies the right-stack budget at card boundaries and sends oversized cards to overflow", () => {
    const cards = [item("heat", "corner-right", "first"), item("typhoon", "corner-right", "second"), item("volcano", "corner-right", "third")];
    const heights = new Map([["first", 300], ["second", 500], ["third", 200]]);
    const result = selectRightStack(cards, 700, (candidate) => heights.get(candidate.key)!);
    expect(result.visible.map((candidate) => candidate.key)).toEqual(["first", "third"]);
    expect(result.overflow.map((candidate) => candidate.key)).toEqual(["second"]);
  });

  it("720p 相当で WeatherAlertCard と overflow 要約を予算に含め、要約領域を常に予約する", () => {
    // 720px viewport - 80px ticker = 640px standby。CSS の上下余白 24px と一致させる。
    const budget = rightStackBudgetPx(640, 280, 0, 12);
    expect(budget).toBe(300);
    const cards = [item("volcano", "corner-right", "volcano"), item("typhoon", "corner-right", "typhoon")];
    const result = selectRightStackWithSummary(cards, budget, () => 180, 32, false, 12);
    expect(result.visible.map((candidate) => candidate.key)).toEqual(["volcano"]);
    expect(result.overflow.map((candidate) => candidate.key)).toEqual(["typhoon"]);
    expect(result.usedPx + result.summaryReservedPx).toBeLessThanOrEqual(budget);
    expect(result.summaryReservedPx).toBe(44);
  });
  describe("selectRightStackWithSummary severity guard", () => {
    const h = (heights: Record<string, number>) => (candidate: ActiveStandbyCardV1) => heights[candidate.key];

    it("selects warning before normal while preserving original render order", () => {
      const cards = [
        item("typhoon", "corner-right", "a", "normal"),
        item("heat", "corner-right", "b", "normal"),
        item("volcano", "corner-right", "c", "warning"),
      ];
      const result = selectRightStackWithSummary(cards, 468, h({ a: 200, b: 200, c: 200 }), 32, false, 12);
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["a", "c"]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["b"]);
    });

    it("skips an oversized warning and best-effort selects a normal card", () => {
      const cards = [
        item("typhoon", "corner-right", "a", "normal"),
        item("volcano", "corner-right", "c", "warning"),
      ];
      const result = selectRightStackWithSummary(cards, 344, h({ a: 200, c: 500 }), 32, false, 12);
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["a"]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["c"]);
    });

    it("uses original array order as the tie-break for equal severity", () => {
      const cards = [
        item("volcano", "corner-right", "a", "normal"),
        item("typhoon", "corner-right", "b", "normal"),
        item("heat", "corner-right", "c", "normal"),
      ];
      const result = selectRightStackWithSummary(cards, 468, h({ a: 200, b: 200, c: 200 }), 32, false, 12);
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["a", "b"]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["c"]);
    });

    it("keeps the reserved summary within the budget after best-effort selection", () => {
      const cards = [
        item("typhoon", "corner-right", "a", "normal"),
        item("volcano", "corner-right", "c", "warning"),
      ];
      const result = selectRightStackWithSummary(cards, 344, h({ a: 200, c: 500 }), 32, false, 12);
      expect(result.usedPx + result.summaryReservedPx).toBeLessThanOrEqual(344);
      expect(result.summaryReservedPx).toBe(44);
    });
  });

  describe("selectRightStackWithTyphoonCompact", () => {
    const heights = (full: Record<string, number>, compact: Record<string, number>) =>
      (candidate: ActiveStandbyCardV1, mode: "full" | "compact") =>
        (mode === "compact" ? compact : full)[candidate.key];

    it("full が入らない台風は overflow の前に compact で採用する", () => {
      const cards = [item("typhoon", "corner-right", "typhoon", "normal")];
      const result = selectRightStackWithTyphoonCompact(
        cards, 180, heights({ typhoon: 240 }, { typhoon: 140 }), 32, false, 12,
      );
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["typhoon"]);
      expect(result.displayModes.get("typhoon")).toBe("compact");
      expect(result.overflow).toEqual([]);
      expect(result.summaryReservedPx).toBe(0);
    });

    it("compact でも入らない台風は従来どおり要約へ送る", () => {
      const cards = [item("typhoon", "corner-right", "typhoon", "normal")];
      const result = selectRightStackWithTyphoonCompact(
        cards, 120, heights({ typhoon: 240 }, { typhoon: 140 }), 32, false, 12,
      );
      expect(result.visible).toEqual([]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["typhoon"]);
      expect(result.summaryReservedPx).toBe(44);
    });

    it("複数 domain では severity を優先し、描画順は元配列順に保つ", () => {
      const cards = [
        item("typhoon", "corner-right", "typhoon", "normal"),
        item("heat", "corner-right", "heat", "normal"),
        item("volcano", "corner-right", "volcano", "warning"),
      ];
      const result = selectRightStackWithTyphoonCompact(
        cards,
        468,
        heights({ typhoon: 200, heat: 200, volcano: 200 }, { typhoon: 150 }),
        32,
        false,
        12,
      );
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["typhoon", "volcano"]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["heat"]);
      expect(result.displayModes.get("typhoon")).toBe("full");
    });

    it("同一 severity は元配列順を tie-break にする", () => {
      const cards = [
        item("volcano", "corner-right", "volcano", "normal"),
        item("typhoon", "corner-right", "typhoon", "normal"),
        item("heat", "corner-right", "heat", "normal"),
      ];
      const result = selectRightStackWithTyphoonCompact(
        cards,
        468,
        heights({ volcano: 200, typhoon: 200, heat: 200 }, { typhoon: 150 }),
        32,
        false,
        12,
      );
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["volcano", "typhoon"]);
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["heat"]);
    });

    it("要約領域の再予約後に full を再判定し、台風 compact で予算内へ収める", () => {
      const cards = [
        item("volcano", "corner-right", "volcano", "warning"),
        item("typhoon", "corner-right", "typhoon", "warning"),
        item("heat", "corner-right", "heat", "normal"),
      ];
      const result = selectRightStackWithTyphoonCompact(
        cards,
        400,
        heights({ volcano: 180, typhoon: 180, heat: 500 }, { typhoon: 130 }),
        32,
        false,
        12,
      );
      expect(result.visible.map((candidate) => candidate.key)).toEqual(["volcano", "typhoon"]);
      expect(result.displayModes.get("typhoon")).toBe("compact");
      expect(result.overflow.map((candidate) => candidate.key)).toEqual(["heat"]);
      expect(result.usedPx + result.summaryReservedPx).toBeLessThanOrEqual(400);
    });
  });
});

function riverFixture(n: number): Extract<ActiveStandbyCardV1, { kind: "flood" }>["data"]["rivers"] {
  return Array.from({ length: n }, (_, i) => ({
    riverKey: `830304000${i + 1}`, riverName: `河川${i + 1}`, level: "L3", levelRank: 30,
    kindName: "氾濫警戒情報", reportDateTime: "2026-07-23T00:00:00+09:00", station: null,
  }));
}

describe("layoutFloodWideRows (部位別予算 + タグ付き union)", () => {
  it("720p・4 河川は 2 セル + 集約行 (ほか 2 河川) になり、行キーは名前空間つき", () => {
    const rows = layoutFloodWideRows(riverFixture(4), 720);
    expect(rows.map((row) => row.kind)).toEqual(["river", "river", "more"]);
    expect(rows[0].key).toBe("river:8303040001");
    expect(rows[2]).toMatchObject({ kind: "more", key: "meta:more", omittedCount: 2 });
  });

  it("1080p は 3〜5 河川とも全セル表示 (3 行 = 6 セル入る。現行挙動維持)", () => {
    expect(layoutFloodWideRows(riverFixture(3), 1080).map((r) => r.kind)).toEqual(["river", "river", "river"]);
    expect(layoutFloodWideRows(riverFixture(4), 1080).map((r) => r.kind)).toEqual(["river", "river", "river", "river"]);
    expect(layoutFloodWideRows(riverFixture(5), 1080).map((r) => r.kind)).toEqual(["river", "river", "river", "river", "river"]);
  });

  it("1080p でも 400px 以下は4段セル高で見積もり、2セル + 集約へ縮める", () => {
    const rows = layoutFloodWideRows(riverFixture(5), 1080, 307);
    expect(rows.map((row) => row.kind)).toEqual(["river", "river", "more"]);
    expect(rows[2]).toMatchObject({ kind: "more", omittedCount: 3 });
  });

  it("720p・3 河川は 2 セル + 集約 1 (最低 2 行の強制を廃止し実予算で決める)", () => {
    const rows = layoutFloodWideRows(riverFixture(3), 720);
    expect(rows.map((row) => row.kind)).toEqual(["river", "river", "more"]);
    expect(rows[2]).toMatchObject({ kind: "more", omittedCount: 1 });
  });

  it("720p・5 河川は 2 セル + 集約 3 (720p/1080p x 3/4/5 の行列を満たす)", () => {
    const rows = layoutFloodWideRows(riverFixture(5), 720);
    expect(rows.map((row) => row.kind)).toEqual(["river", "river", "more"]);
    expect(rows[2]).toMatchObject({ kind: "more", omittedCount: 3 });
  });
});
