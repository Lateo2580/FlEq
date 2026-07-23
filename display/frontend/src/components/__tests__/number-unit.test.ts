import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import NumberUnit from "../NumberUnit.svelte";

describe("NumberUnit", () => {
  it("splits value and unit into separate spans (value large, unit small)", () => {
    const { container } = render(NumberUnit, { value: "3.31", unit: "m" });
    expect(container.querySelector(".nu-value")?.textContent).toBe("3.31");
    expect(container.querySelector(".nu-unit")?.textContent).toBe("m");
    // 連結した textContent は元の「数値+単位」表記に一致する
    expect(container.textContent).toBe("3.31m");
  });

  it("omits empty prefix/unit spans (後方互換: 既存の value+unit 呼び出しは不変)", () => {
    const { container } = render(NumberUnit, { value: "-", unit: "" });
    expect(container.querySelector(".nu-value")?.textContent).toBe("-");
    expect(container.querySelector(".nu-prefix")).toBeNull();
    expect(container.querySelector(".nu-unit")).toBeNull();
    expect(container.textContent).toBe("-");
  });

  it("renders a prefix span before the value (規模 M7.1 / 火山 レベル3)", () => {
    const { container } = render(NumberUnit, { value: "7.1", prefix: "M" });
    expect(container.querySelector(".nu-prefix")?.textContent).toBe("M");
    expect(container.querySelector(".nu-value")?.textContent).toBe("7.1");
    // prefix → value の順で連結され、unit 省略時は unit span を出さない
    expect(container.textContent).toBe("M7.1");
    expect(container.querySelector(".nu-unit")).toBeNull();
  });

  it("renders prefix and unit together in prefix → value → unit order", () => {
    const { container } = render(NumberUnit, { value: "3.31", prefix: "水位", unit: "m" });
    expect(container.textContent).toBe("水位3.31m");
  });

  it("keeps composite units (m/s, km/h) in a single unit span", () => {
    const { container } = render(NumberUnit, { value: "20", unit: "km/h" });
    expect(container.querySelector(".nu-unit")?.textContent).toBe("km/h");
  });

  it("floors the unit font at 12px (A11y 層2) so small values don't sink below the legibility floor", () => {
    // jsdom は computed font-size を CSS 変数/em で解決しないため、source で床の宣言を固定する
    const source = readFileSync(join(__dirname, "..", "NumberUnit.svelte"), "utf8");
    expect(source).toContain("font-size: max(12px, var(--number-unit-affix-size, 0.6em))");
    expect(source).not.toContain("font-size: 0.6em;");
  });
});
