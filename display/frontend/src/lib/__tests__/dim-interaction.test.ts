import { describe, expect, it } from "vitest";
import { computeEffectiveDim, shouldToggleDimOnClick, shouldToggleDimOnKey } from "../dim-interaction";

function el(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root.firstElementChild as Element;
}

describe("shouldToggleDimOnClick", () => {
  it("非対話要素 (div) 発のクリックはトグルする", () => {
    expect(shouldToggleDimOnClick(el("<div>x</div>"))).toBe(true);
  });
  it("button 発は無視する", () => {
    expect(shouldToggleDimOnClick(el("<button>x</button>"))).toBe(false);
  });
  it("button の子要素 (span) 発も無視する (closest 判定)", () => {
    const btn = el("<button><span>x</span></button>");
    expect(shouldToggleDimOnClick(btn.querySelector("span"))).toBe(false);
  });
  it.each(["a", "input", "select", "textarea"])("%s 発は無視する", (tag) => {
    expect(shouldToggleDimOnClick(el(`<${tag}>x</${tag}>`))).toBe(false);
  });
  it("contenteditable と role=button/link 発は無視する", () => {
    expect(shouldToggleDimOnClick(el('<div contenteditable="true">x</div>'))).toBe(false);
    expect(shouldToggleDimOnClick(el('<div role="button">x</div>'))).toBe(false);
    expect(shouldToggleDimOnClick(el('<div role="link">x</div>'))).toBe(false);
  });
  it("target が Element でない (null) 場合はトグルする (window 背景クリック)", () => {
    expect(shouldToggleDimOnClick(null)).toBe(true);
  });
});

describe("shouldToggleDimOnKey", () => {
  const base = { key: "d", repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null };
  it("D 単押しはトグルする (大文字小文字不問)", () => {
    expect(shouldToggleDimOnKey({ ...base })).toBe(true);
    expect(shouldToggleDimOnKey({ ...base, key: "D" })).toBe(true);
  });
  it("D 以外のキーは無視する", () => {
    expect(shouldToggleDimOnKey({ ...base, key: "e" })).toBe(false);
  });
  it("repeat (長押し反復) は無視する", () => {
    expect(shouldToggleDimOnKey({ ...base, repeat: true })).toBe(false);
  });
  it("修飾キー併押は無視する (shift 含む一律除外)", () => {
    expect(shouldToggleDimOnKey({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldToggleDimOnKey({ ...base, metaKey: true })).toBe(false);
    expect(shouldToggleDimOnKey({ ...base, altKey: true })).toBe(false);
    expect(shouldToggleDimOnKey({ ...base, shiftKey: true })).toBe(false);
  });
  it("editable 要素フォーカス中は無視する", () => {
    expect(shouldToggleDimOnKey({ ...base, target: el("<input>") })).toBe(false);
    expect(shouldToggleDimOnKey({ ...base, target: el('<div contenteditable="true">x</div>') })).toBe(false);
  });
});

describe("computeEffectiveDim (spec D5 合成則の真理値表)", () => {
  it.each([
    [true, true, false],   // 減光要求中に警報 → 明転 (サスペンド)
    [true, false, true],   // 減光要求中・警報なし → 減光
    [false, true, false],  // 要求なし → 常に明
    [false, false, false],
  ])("requested=%s alertActive=%s → %s", (requested, alertActive, expected) => {
    expect(computeEffectiveDim(requested, alertActive)).toBe(expected);
  });
});
