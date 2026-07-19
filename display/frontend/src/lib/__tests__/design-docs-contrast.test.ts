import { describe, it, expect } from "vitest";
import {
  parseColor, relativeLuminance, contrastRatio, srgbMix, compositeOver,
} from "../../../../scripts/generate-design-docs.mjs";

describe("色計算", () => {
  it("#fff × #000 のコントラスト比はちょうど 21:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000000"))).toBeCloseTo(21, 5);
  });
  it("コントラスト比は順序非依存", () => {
    const a = parseColor("#f2f4f6");
    const b = parseColor("#000000");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
  it("3 桁 hex を展開する", () => {
    expect(parseColor("#fff")).toMatchObject({ r: 255, g: 255, b: 255 });
  });
  it("rgb() の CSS Color 4 space 記法と / alpha を解釈する", () => {
    expect(parseColor("rgb(12 34 56)")).toMatchObject({ r: 12, g: 34, b: 56, a: 1 });
    expect(parseColor("rgb(12 34 56 / 25%)")).toMatchObject({ r: 12, g: 34, b: 56, a: 0.25 });
  });
  it("srgbMix は gamma 空間で線形補間する", () => {
    const m = srgbMix(parseColor("#ff0000"), parseColor("#0000ff"), 0.5);
    expect(m.r).toBeCloseTo(127.5, 5);
    expect(m.b).toBeCloseTo(127.5, 5);
    expect(m.g).toBeCloseTo(0, 5);
  });
  it("color-mix(in srgb, ...) を再現する", () => {
    const c = parseColor("color-mix(in srgb, #ffffff 50%, #000000)");
    expect(c.r).toBeCloseTo(127.5, 5);
  });
  it("片側 % のみは他方を 100-p にする", () => {
    const c = parseColor("color-mix(in srgb, #ffffff 35%, #000000)");
    expect(c.r).toBeCloseTo(255 * 0.35, 5);
  });
  it("既知の面ペア: int-8-on(#000) × int-8-bg(#d55e00) ≈ 5.43:1", () => {
    expect(contrastRatio(parseColor("#000000"), parseColor("#d55e00"))).toBeCloseTo(5.43, 1);
  });
  it("合成: dim×大津波チップ ≈ 2.14:1 (spec §6 の既知値)", () => {
    const black = parseColor("#000000");
    const fg = srgbMix(parseColor("#eabdf0"), black, 0.35); // --header-tsunamiMajor-on 35%
    const bg = srgbMix(parseColor("#301238"), black, 0.35); // --header-tsunamiMajor-container 35%
    expect(contrastRatio(fg, bg)).toBeCloseTo(2.14, 1);
  });
  it("compositeOver: opacity 0.85 の on を container に重ねる", () => {
    const out = compositeOver(parseColor("#ffb392"), 0.85, parseColor("#3a1206"));
    expect(out.a).toBe(1);
    expect(out.r).toBeCloseTo(0xff * 0.85 + 0x3a * 0.15, 5);
  });
  it("不正な色入力は throw する (部分解釈しない)", () => {
    expect(() => parseColor("#000000zz")).toThrow();
    expect(() => parseColor("#12")).toThrow();
    expect(() => parseColor("rgb(1,2)")).toThrow();
    expect(() => parseColor("rgb(1 2 3 4)")).toThrow();
    expect(() => parseColor("rgb(1, 2, 3 / .5)")).toThrow();
    expect(() => parseColor("rgb(a,b,c)")).toThrow();
    expect(() => parseColor("rgb(300,0,0)")).toThrow();
    expect(() => parseColor("rgba(0,0,0,2)")).toThrow();
  });
});
