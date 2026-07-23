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

  it("警戒レベルは「レベル 小 + 数値 大」の NumberUnit prefix 形式で描画する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{ code: "506", name: "桜島", alertLevel: 3, latestEvent: null }] },
    }) });
    expect(container.querySelector(".nu-prefix")?.textContent).toBe("レベル");
    expect(container.querySelector(".nu-value")?.textContent).toBe("3");
    // 括弧内ラベルは通常テキストのまま連結される
    expect(container.textContent).toContain("レベル3（入山規制）");
  });

  it("段階カラー: カード内最高段階で帯 class を決める (2=黄 advisory / 3=橙 warning / 4=赤 red / 5=紫 emergency)", () => {
    const bandFor = (alertLevel: number | null, latestEvent: string | null = null): string => {
      const { container, unmount } = render(VolcanoCard, { item: volcanoItem({
        data: { volcanoes: [{ code: "V-1", name: "M", alertLevel, latestEvent }] },
      }) });
      const card = container.querySelector(".volcano-card")!;
      const band = ["band-advisory", "band-warning", "band-red", "band-emergency"].find((c) => card.classList.contains(c));
      unmount();
      return band ?? "none";
    };
    expect(bandFor(2)).toBe("band-advisory");
    expect(bandFor(3)).toBe("band-warning");
    expect(bandFor(4)).toBe("band-red");
    expect(bandFor(5)).toBe("band-emergency");
    // 噴火速報はレベル 4 未満でも赤へ引き上げる
    expect(bandFor(2, "噴火速報")).toBe("band-red");
  });

  it("最高段階でカード帯を決め、複数火山を並べる (V-1 レベル4 + V-2 噴火速報 → band-red)", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [
        { code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: null },
        { code: "V-2", name: "Mount Second", alertLevel: null, latestEvent: "eruption" },
      ] },
    }) });
    expect(container.querySelector(".volcano-card")?.classList.contains("band-red")).toBe(true);
    expect(container.querySelectorAll(".volcano")).toHaveLength(2);
    expect(container.textContent).toContain("eruption");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({ restored: true }) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
