import { describe, it, expect } from "vitest";
import { emergencyEnter, revealScaleIn, heightReveal } from "../transitions";

// spec §3 検証 1: emergencyEnter は opacity を下げない (画面レベル frame-1 可視の主保証)。
describe("emergencyEnter (spec §3 検証 1)", () => {
  it("全 t で opacity を出力しない (transform のみ)", () => {
    const cfg = emergencyEnter(document.createElement("div"), { duration: 142 });
    for (let i = 0; i <= 100; i++) {
      const s = cfg.css!(i / 100, 1 - i / 100);
      expect(s).not.toMatch(/opacity/);
      expect(s).toMatch(/transform:/);
    }
  });

  it("既存 transform を保持して scale を前置合成する", () => {
    const node = document.createElement("div");
    node.style.transform = "translateY(4px)";
    const cfg = emergencyEnter(node, { duration: 142 });
    expect(cfg.css!(0.5, 0.5)).toMatch(/transform:\s*translateY\(4px\)\s+scale\(/);
  });
});

// spec §3 検証 1b: revealScaleIn の reveal 分岐 (Critical 1 の要)。
describe("revealScaleIn (spec §3 検証 1b)", () => {
  it("初期 (reveal:false) で opacity:1・duration 0 = 演出なし", () => {
    const cfg = revealScaleIn(document.createElement("div"), { reveal: false, duration: 435 });
    expect(cfg.duration).toBe(0);
    expect(cfg.css!(0, 1)).toMatch(/opacity:\s*1/);
  });

  it("後発 (reveal:true) で opacity を 0→1 に上げる", () => {
    const cfg = revealScaleIn(document.createElement("div"), { reveal: true, duration: 435 });
    expect(Number(cfg.css!(0, 1).match(/opacity:\s*([\d.]+)/)![1])).toBeLessThan(0.05);
    expect(Number(cfg.css!(1, 0).match(/opacity:\s*([\d.]+)/)![1])).toBe(1);
  });

  it("後発 (reveal:true) の opacity は全域で [0,1] を超えない (effects=overshoot 禁止)", () => {
    const cfg = revealScaleIn(document.createElement("div"), { reveal: true, duration: 435 });
    for (let i = 0; i <= 100; i++) {
      const op = Number(cfg.css!(i / 100, 1 - i / 100).match(/opacity:\s*([\d.]+)/)![1]);
      expect(op).toBeGreaterThanOrEqual(0);
      expect(op).toBeLessThanOrEqual(1);
    }
  });
});

// spec §3 検証 1c: heightReveal は height を 0→自然高へ単調増加 (§0-e で成立)。
describe("heightReveal (spec §3 検証 1c)", () => {
  function nodeWithScrollHeight(h: number): Element {
    const node = document.createElement("div");
    Object.defineProperty(node, "scrollHeight", { value: h, configurable: true });
    return node;
  }

  it("初期 (reveal:false) は空 css (演出なし・height:auto のまま)", () => {
    const cfg = heightReveal(nodeWithScrollHeight(120), { reveal: false, duration: 231 });
    expect(cfg.duration).toBe(0);
    expect(cfg.css!(0, 1)).toBe("");
    expect(cfg.css!(1, 0)).toBe("");
  });

  it("後発 (reveal:true) は height を 0→自然高へ単調増加させる", () => {
    const h = 120;
    const cfg = heightReveal(nodeWithScrollHeight(h), { reveal: true, duration: 231 });
    expect(cfg.css!(0, 1)).toMatch(/height:\s*0px/);
    const end = Number(cfg.css!(1, 0).match(/height:\s*([\d.]+)px/)![1]);
    expect(end).toBeCloseTo(h, 5);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = Number(cfg.css!(i / 100, 1 - i / 100).match(/height:\s*([\d.]+)px/)![1]);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(h + 0.0001); // effects easing は overshoot しない
      prev = v;
    }
  });

  it("後発 (reveal:true) は overflow:hidden を出す", () => {
    const cfg = heightReveal(nodeWithScrollHeight(80), { reveal: true, duration: 231 });
    expect(cfg.css!(0.5, 0.5)).toMatch(/overflow:\s*hidden/);
  });
});
