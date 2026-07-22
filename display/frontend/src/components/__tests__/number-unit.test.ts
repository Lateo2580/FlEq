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

  it("renders an empty unit span when no unit is given (e.g. missing depth)", () => {
    const { container } = render(NumberUnit, { value: "-", unit: "" });
    expect(container.querySelector(".nu-value")?.textContent).toBe("-");
    expect(container.querySelector(".nu-unit")?.textContent).toBe("");
    expect(container.textContent).toBe("-");
  });

  it("keeps composite units (m/s, km/h) in a single unit span", () => {
    const { container } = render(NumberUnit, { value: "20", unit: "km/h" });
    expect(container.querySelector(".nu-unit")?.textContent).toBe("km/h");
  });
});
