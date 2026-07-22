import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import HeatAlertCard from "../HeatAlertCard.svelte";
import type { ActiveStandbyCardV1 } from "../../lib/protocol";

function heatItem(over: Partial<Extract<ActiveStandbyCardV1, { kind: "heat" }>> = {}): Extract<ActiveStandbyCardV1, { kind: "heat" }> {
  return {
    kind: "heat", surface: "corner-right", key: "heat:2026-07-21", sourceEventIds: ["heat-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T15:00:00.000Z", restored: false,
    severity: "warning", data: { targetDate: "2026-07-21", areas: [{ areaName: "Tokyo", isSpecial: false }] }, ...over,
  };
}

describe("HeatAlertCard", () => {
  it("renders target date (MM/DD short slash format, in header) and all areas", () => {
    const { container } = render(HeatAlertCard, { item: heatItem({ data: { targetDate: "2026-07-22", areas: [{ areaName: "Tokyo", isSpecial: false }, { areaName: "Osaka", isSpecial: false }] } }) });
    // 日付は MM/DD (07/22) 形式で見出し帯 (header) の中に出る (データ形式 targetDate は変えない)
    expect(container.querySelector("header .date")?.textContent).toBe("07/22");
    expect(container.querySelector(".areas")?.textContent).toContain("Tokyo");
    expect(container.querySelector(".areas")?.textContent).toContain("Osaka");
  });

  it("最長ケース (特別警戒 + 復元チップ + 日付) でも見出しは 1 行を保つ構造 (title/date nowrap・日付短縮)", () => {
    const { container } = render(HeatAlertCard, { item: heatItem({
      restored: true, severity: "critical",
      data: { targetDate: "2026-12-31", areas: [{ areaName: "Tokyo", isSpecial: true }] },
    }) });
    // header は flex 一列で、タイトル span・復元チップ・日付 span が同居する
    const header = container.querySelector("header");
    expect(header?.querySelector(".title")?.textContent).toBe("熱中症特別警戒アラート");
    expect(header?.querySelector(".restored-chip")).toBeTruthy();
    expect(header?.querySelector(".date")?.textContent).toBe("12/31");
    // タイトル・日付は折り返さない (nowrap) 実装で 1 行に収める
    const src = readFileSync(join(__dirname, "..", "HeatAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/\.title\s*\{[^}]*white-space:\s*nowrap/);
    expect(src).toMatch(/\.date\s*\{[^}]*white-space:\s*nowrap/);
  });

  it("marks special and restored cards", () => {
    const { container } = render(HeatAlertCard, { item: heatItem({ restored: true, severity: "critical", data: { targetDate: "2026-07-21", areas: [{ areaName: "Tokyo", isSpecial: true }] } }) });
    expect(container.querySelector(".heat-card")?.classList.contains("critical")).toBe(true);
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
