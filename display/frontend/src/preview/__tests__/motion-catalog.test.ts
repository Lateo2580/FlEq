import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import MotionCatalog from "../MotionCatalog.svelte";

describe("MotionCatalog", () => {
  it("マウントでき、グループタブと空気コントロールとステージが存在する", () => {
    const { container } = render(MotionCatalog);
    // ステージ (実コンポーネントを載せる画面枠)
    expect(container.querySelector(".stage")).toBeTruthy();
    expect(container.querySelector(".stage .screen-area")).toBeTruthy();
    // グループタブ (7 グループ)
    expect(container.querySelectorAll(".tab-col .tab-btn").length).toBe(7);
    // 空気コントロール (tier 4 段 + dim)
    expect(screen.getByText("calm")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText("減光 dim")).toBeTruthy();
  });

  it("既定グループ (待機カード) の操作ボタンが揃っている", () => {
    render(MotionCatalog);
    expect(screen.getByText("地震カード 有⇄無 (統計行 FLIP)")).toBeTruthy();
    expect(screen.getByText("津波バナー")).toBeTruthy();
  });

  it("テロップグループへ切り替えると操作ボタンと専用シーンへのリンクが出る", async () => {
    const { getByRole } = render(MotionCatalog);
    await getByRole("button", { name: "テロップ" }).click();
    expect(screen.getByText("high を投入 (tint)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "interrupt" })).toBeTruthy();
  });
});
