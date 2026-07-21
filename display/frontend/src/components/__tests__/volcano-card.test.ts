import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import VolcanoCard from "../VolcanoCard.svelte";
import type { ActiveStandbyCardV1 } from "../../lib/protocol";
import { VOLCANO_LEVEL_LABELS } from "../../lib/standby-cards";

function volcanoItem(over: Partial<Extract<ActiveStandbyCardV1, { kind: "volcano" }>> = {}): Extract<ActiveStandbyCardV1, { kind: "volcano" }> {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:active", sourceEventIds: ["volcano-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null, restored: false, severity: "critical",
    data: { volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: "flash" }] }, ...over,
  };
}

describe("VolcanoCard", () => {
  it("renders volcano level label and eruption event", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem() });
    expect(container.querySelector(".volcano")?.textContent).toContain("Mount Test");
    expect(container.querySelector(".volcano")?.textContent).toContain(VOLCANO_LEVEL_LABELS[4]);
    expect(container.querySelector("strong")?.textContent).toBe("flash");
  });

  it("marks critical cards and supports multiple volcanoes", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [
        { code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: null },
        { code: "V-2", name: "Mount Second", alertLevel: null, latestEvent: "eruption" },
      ] },
    }) });
    expect(container.querySelector(".volcano-card")?.classList.contains("critical")).toBe(true);
    expect(container.querySelectorAll(".volcano")).toHaveLength(2);
    expect(container.textContent).toContain("eruption");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({ restored: true }) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
