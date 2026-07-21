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
  it("renders target date and all areas", () => {
    const { container } = render(HeatAlertCard, { item: heatItem({ data: { targetDate: "2026-07-22", areas: [{ areaName: "Tokyo", isSpecial: false }, { areaName: "Osaka", isSpecial: false }] } }) });
    expect(container.querySelector(".date")?.textContent).toBe("2026-07-22");
    expect(container.querySelector(".areas")?.textContent).toContain("Tokyo");
    expect(container.querySelector(".areas")?.textContent).toContain("Osaka");
  });

  it("marks special and restored cards", () => {
    const { container } = render(HeatAlertCard, { item: heatItem({ restored: true, severity: "critical", data: { targetDate: "2026-07-21", areas: [{ areaName: "Tokyo", isSpecial: true }] } }) });
    expect(container.querySelector(".heat-card")?.classList.contains("critical")).toBe(true);
    expect(container.querySelector(".restored")).toBeTruthy();
  });
});
