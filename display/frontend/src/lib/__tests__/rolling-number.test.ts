import { describe, it, expect } from "vitest";
import { toRollCells, rollDurationMs, hasValueChanged } from "../rolling-number";
import { SPRING_EFFECTS_DEFAULT_MS } from "../motion";

describe("toRollCells", () => {
  it("小数を数字/小数点セルに分ける", () => {
    expect(toRollCells("7.1")).toEqual([
      { kind: "digit", digit: 7 },
      { kind: "text", text: "." },
      { kind: "digit", digit: 1 },
    ]);
  });
  it("単位付き整数は末尾を text セルに畳む", () => {
    expect(toRollCells("20km")).toEqual([
      { kind: "digit", digit: 2 },
      { kind: "digit", digit: 0 },
      { kind: "text", text: "km" },
    ]);
  });
  it("震度ラベルは数字 + 漢字テキスト", () => {
    expect(toRollCells("6弱")).toEqual([
      { kind: "digit", digit: 6 },
      { kind: "text", text: "弱" },
    ]);
  });
  it("数字を含まない値は text 1 セルのみ (ロールしない)", () => {
    expect(toRollCells("ごく浅い")).toEqual([{ kind: "text", text: "ごく浅い" }]);
    expect(toRollCells("不明")).toEqual([{ kind: "text", text: "不明" }]);
  });
  it("空文字は空配列", () => {
    expect(toRollCells("")).toEqual([]);
  });
});

describe("rollDurationMs", () => {
  it("reduced-motion では 0ms (瞬時差し替え)", () => {
    expect(rollDurationMs(true)).toBe(0);
  });
  it("通常は spring effects の短い duration", () => {
    expect(rollDurationMs(false)).toBe(SPRING_EFFECTS_DEFAULT_MS);
  });
});

describe("hasValueChanged", () => {
  it("初回 (prev=null) は false でマウント時に強調しない", () => {
    expect(hasValueChanged(null, "7.1")).toBe(false);
  });
  it("同値は false で常時アニメ化しない", () => {
    expect(hasValueChanged("7.1", "7.1")).toBe(false);
  });
  it("値が変われば true", () => {
    expect(hasValueChanged("7.0", "7.1")).toBe(true);
  });
});
