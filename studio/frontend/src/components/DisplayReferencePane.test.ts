import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import DisplayReferencePane from "./DisplayReferencePane.svelte";

describe("DisplayReferencePane", () => {
  it("sections の見出しと本文を表示する (details 折りたたみ)", () => {
    const { container } = render(DisplayReferencePane, {
      sections: [{ heading: "気象警報・注意報 (VPWW55-61, VPWS50)", markdown: "## 気象警報・注意報\n\n表示仕様…" }],
    });
    expect(screen.getAllByText(/気象警報・注意報/).length).toBeGreaterThan(0);
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("pre.reference-md")!.textContent).toContain("表示仕様");
  });

  it("sections が空なら何も描画しない", () => {
    const { container } = render(DisplayReferencePane, { sections: [] });
    expect(container.querySelector(".reference-pane")).toBeNull();
  });
});
