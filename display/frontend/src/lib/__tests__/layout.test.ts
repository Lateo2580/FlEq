import { describe, expect, it } from "vitest";
import { layoutPanels } from "../layout";

describe("layoutPanels", () => {
  it("① 1件 → grid class \"full\"", () => {
    expect(layoutPanels(1).class).toBe("full");
  });

  it("② 2件 → \"main-stack\" (左主役1枚 + 右スタック1枚、split-2 は廃止)", () => {
    expect(layoutPanels(2)).toEqual({ class: "main-stack", main: true, stackCount: 1 });
  });

  it("③ 3件以上 → \"main-stack\" + stack に 2件目以降 (stackCount = count - 1)", () => {
    expect(layoutPanels(3)).toEqual({ class: "main-stack", main: true, stackCount: 2 });
    expect(layoutPanels(5).stackCount).toBe(4);
  });

  it("0件は full 扱い (安全側のフォールバック)", () => {
    expect(layoutPanels(0).class).toBe("full");
  });
});
