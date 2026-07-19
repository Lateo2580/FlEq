import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import InstrumentRow from "../InstrumentRow.svelte";
import type { DisplayStatsV1 } from "../../lib/protocol";

function stats(over: Partial<DisplayStatsV1> = {}): DisplayStatsV1 {
  return {
    sparklineData: [0, 1, 2],
    totalReceived: 42,
    todayQuakeCount: 3,
    todayMaxInt: "3",
    todayMaxIntRank: 30,
    ...over,
  };
}

describe("InstrumentRow", () => {
  it("totalReceived の値を表示する", () => {
    const { container } = render(InstrumentRow, { stats: stats({ totalReceived: 42 }) });
    expect(container.textContent).toContain("42");
  });

  it("最大震度の統計は表示しない (計器列から削除済み)", () => {
    const { container } = render(InstrumentRow, { stats: stats({ todayMaxInt: "6強", todayMaxIntRank: 80 }) });
    expect(container.textContent).not.toContain("最大");
    expect(container.textContent).not.toContain("震度");
  });

  it("stats が null なら .instrument-row を render しない", () => {
    const { container } = render(InstrumentRow, { stats: null });
    expect(container.querySelector(".instrument-row")).toBeFalsy();
  });

  it("sparklineData があればスロット数分の棒グラフ (rect) を描画する", () => {
    const { container } = render(InstrumentRow, { stats: stats({ sparklineData: [0, 1, 2] }) });
    expect(container.querySelectorAll("rect").length).toBe(3);
    expect(container.querySelectorAll("polyline").length).toBe(0);
  });

  it("sparklineData が空配列でも例外を投げず rect を描画しない", () => {
    const { container } = render(InstrumentRow, { stats: stats({ sparklineData: [] }) });
    expect(() => render(InstrumentRow, { stats: stats({ sparklineData: [] }) })).not.toThrow();
    expect(container.querySelectorAll("rect").length).toBe(0);
  });
});
