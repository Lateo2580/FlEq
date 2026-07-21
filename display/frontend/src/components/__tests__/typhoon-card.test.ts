import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import TyphoonCard from "../TyphoonCard.svelte";
import type { ActiveStandbyCardV1, DisplayTyphoonV1 } from "../../lib/protocol";

function typhoon(over: Partial<DisplayTyphoonV1> = {}): DisplayTyphoonV1 {
  return { typhoonKey: "TC-1", name: "Alpha", nameKana: "ALPHA", remark: null, typhoonNumber: "2605", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: "2026-07-21T00:00:00.000Z", ...over };
}

function typhoonItem(typhoons = [typhoon()]): Extract<ActiveStandbyCardV1, { kind: "typhoon" }> {
  return { kind: "typhoon", surface: "corner-right", key: "typhoon:active", sourceEventIds: ["typhoon-1"], updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-22T00:00:00.000Z", restored: false, severity: "normal", data: { typhoons } };
}

describe("TyphoonCard", () => {
  it("renders number, name, and available facts", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem() });
    expect(container.querySelector(".typhoon")?.textContent).toContain("5");
    expect(container.querySelector(".typhoon")?.textContent).toContain("ALPHA");
    expect(container.querySelector(".facts")?.textContent).toContain("990hPa");
    expect(container.querySelector(".facts")?.textContent).toContain("25m/s");
  });

  it("uses remark when a named typhoon is unavailable and renders each aggregated typhoon", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({ name: null, nameKana: null, remark: "remark" }), typhoon({ typhoonKey: "TC-2", typhoonNumber: "2606", nameKana: "BETA" })]) });
    expect(container.querySelectorAll(".typhoon")).toHaveLength(2);
    expect(container.textContent).toContain("remark");
    expect(container.textContent).toContain("BETA");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(TyphoonCard, { item: { ...typhoonItem(), restored: true } });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
