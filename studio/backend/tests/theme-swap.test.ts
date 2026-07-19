import { describe, it, expect } from "vitest";
import { withThemeSwap } from "../lib/theme-swap";
import { getRole } from "../../../src/ui/theme";

describe("theme-swap", () => {
  it("override を適用してから fn を呼び、関数終了後にデフォルトに戻る", async () => {
    const originalFrameCritical = getRole("frameCritical");

    const warnings = await withThemeSwap(
      {
        palette: { vermillion: "#FF00FF" }, // ピンク寄りに上書き
      },
      async () => {
        const inside = getRole("frameCritical");
        // frameCritical のデフォルトは "vermillion" 参照なので、新しい palette が効くはず
        expect(inside.fg).toEqual([0xff, 0x00, 0xff]);
      },
    );

    expect(warnings).toEqual([]);
    // 関数終了後はデフォルトに戻っている
    const after = getRole("frameCritical");
    expect(after.fg).toEqual(originalFrameCritical.fg);
  });

  it("関数が throw しても theme は復元される", async () => {
    const original = getRole("frameCritical");
    await expect(
      withThemeSwap({ palette: { vermillion: "#00FF00" } }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = getRole("frameCritical");
    expect(after.fg).toEqual(original.fg);
  });

  it("不正な HEX を含む override は warnings に出るが render 自体は走る", async () => {
    let inside: unknown;
    const warnings = await withThemeSwap(
      { palette: { vermillion: "not-a-color" } },
      async () => {
        inside = getRole("frameCritical");
      },
    );
    expect(warnings.some((w) => w.includes("vermillion"))).toBe(true);
    expect(inside).toBeDefined();
  });
});
