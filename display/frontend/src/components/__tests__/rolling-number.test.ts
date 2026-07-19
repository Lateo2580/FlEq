import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import RollingNumber from "../RollingNumber.svelte";

describe("RollingNumber", () => {
  it("数字は桁リールで render され、非数字は静止テキストになる", () => {
    const { container } = render(RollingNumber, { value: "7.1" });
    // 数字 2 桁 (7, 1) 分の digit リール
    expect(container.querySelectorAll('[data-testid="roll-digit"]').length).toBe(2);
    // 小数点は静止テキスト
    expect(container.querySelector(".roll-text")?.textContent).toBe(".");
  });

  it("桁リールの translateY が数字に対応する", () => {
    const { container } = render(RollingNumber, { value: "6弱" });
    const reel = container.querySelector(".reel");
    expect(reel?.getAttribute("style")).toContain("translateY(-6em)");
    expect(container.querySelector(".roll-text")?.textContent).toBe("弱");
  });

  it("数字を含まない値はリールを作らずテキストのみ", () => {
    const { container } = render(RollingNumber, { value: "ごく浅い" });
    expect(container.querySelectorAll('[data-testid="roll-digit"]').length).toBe(0);
    expect(container.querySelector(".roll-text")?.textContent).toBe("ごく浅い");
  });

  it("値を data-value/aria-label で 1 つとして公開し、桁リールは aria-hidden (Codex R1)", () => {
    const { container } = render(RollingNumber, { value: "6.1" });
    const root = container.querySelector(".rolling");
    expect(root?.getAttribute("data-value")).toBe("6.1");
    expect(root?.getAttribute("aria-label")).toBe("6.1");
    // 桁リールは AT/getByText から隠れている
    expect(container.querySelector('[data-testid="roll-digit"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("EewPanel の主要数値 (M/深さ/推定最大震度/長周期) が RollingNumber を使う", () => {
    const src = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(src).toContain('import RollingNumber from "./RollingNumber.svelte"');
    expect(src).toContain("<RollingNumber value={input.magnitude");
    expect(src).toContain("<RollingNumber value={input.depth}");
    expect(src).toContain("<RollingNumber value={input.maxLgInt}");
    expect(src).toContain("推定最大震度 <RollingNumber");
  });

  it("着地ウェイト強調: font-weight transition と変化検知・reduced-motion 分岐を持つ (wght #1)", () => {
    const src = readFileSync(join(__dirname, "..", "RollingNumber.svelte"), "utf-8");
    expect(src).toContain("hasValueChanged");
    expect(src).toContain("transition: font-weight");
    expect(src).toContain("class:emphasized");
    // reduced-motion で .rolling の transition を止める分岐がある
    expect(src).toMatch(/prefers-reduced-motion[\s\S]*\.rolling\s*\{\s*transition:\s*none/);
  });

  it("値変化時のみ着地強調が発火し、同値・マウント時は発火しない (Codex R7)", async () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(RollingNumber, { value: "7.0" });
      const root = () => container.querySelector(".rolling");
      // マウント時は強調しない (prev=null)
      vi.advanceTimersByTime(600);
      await tick();
      expect(root()?.classList.contains("emphasized")).toBe(false);

      // 値変化 → roll 時間 (231ms) 経過後に着地強調が乗る
      await rerender({ value: "7.1" });
      vi.advanceTimersByTime(240);
      await tick();
      expect(root()?.classList.contains("emphasized")).toBe(true);
      // decay 後 (settle 231+327ms 超) に外れる
      vi.advanceTimersByTime(600);
      await tick();
      expect(root()?.classList.contains("emphasized")).toBe(false);

      // 同値 rerender では発火しない (常時アニメ化しない)
      await rerender({ value: "7.1" });
      vi.advanceTimersByTime(600);
      await tick();
      expect(root()?.classList.contains("emphasized")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
