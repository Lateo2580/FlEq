// opacity の実挙動 (crossfade / calm での完全静止) は jsdom では解決できないため、
// ここでは data-tier 属性と対応する .tier-layer 要素の構造のみを検証する。
// 実際の見え方 (色・opacity・transition) の確認は実ブラウザの visual gate に委ねる。
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import TierOverlay from "../TierOverlay.svelte";

describe("TierOverlay", () => {
  it("calm では root に data-tier=calm が付き、3層すべてが描画される", () => {
    const { container } = render(TierOverlay, { tier: "calm" });
    const root = container.querySelector(".tier-overlays");
    expect(root?.getAttribute("data-tier")).toBe("calm");
    expect(container.querySelectorAll(".tier-layer").length).toBe(3);
  });

  it("caution では data-tier=caution が付き caution 層が存在する", () => {
    const { container } = render(TierOverlay, { tier: "caution" });
    const root = container.querySelector(".tier-overlays");
    expect(root?.getAttribute("data-tier")).toBe("caution");
    expect(container.querySelector(".tier-layer.caution")).toBeTruthy();
  });

  it("alert では data-tier=alert が付き alert 層が存在する", () => {
    const { container } = render(TierOverlay, { tier: "alert" });
    const root = container.querySelector(".tier-overlays");
    expect(root?.getAttribute("data-tier")).toBe("alert");
    expect(container.querySelector(".tier-layer.alert")).toBeTruthy();
  });

  it("critical では data-tier=critical が付き critical 層が存在する", () => {
    const { container } = render(TierOverlay, { tier: "critical" });
    const root = container.querySelector(".tier-overlays");
    expect(root?.getAttribute("data-tier")).toBe("critical");
    expect(container.querySelector(".tier-layer.critical")).toBeTruthy();
  });

  it("root は aria-hidden で読み上げから除外される", () => {
    const { container } = render(TierOverlay, { tier: "calm" });
    expect(container.querySelector(".tier-overlays")?.getAttribute("aria-hidden")).toBe("true");
  });
});
