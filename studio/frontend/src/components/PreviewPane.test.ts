import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import PreviewPane from "./PreviewPane.svelte";

describe("PreviewPane", () => {
  it("ANSI を HTML 化して .terminal 内に描画する", () => {
    const { container } = render(PreviewPane, {
      ansi: "\x1b[38;2;255;0;0m警報\x1b[0m 本文",
      error: null,
    });
    const pre = container.querySelector("pre.terminal");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("警報");
    expect(pre!.textContent).toContain("本文");
    expect(pre!.innerHTML).not.toContain("\x1b");
  });

  it("error 時は [render error] を表示し ANSI は出さない", () => {
    const { container } = render(PreviewPane, {
      ansi: "should not appear",
      error: "未対応の電文タイプ: x.xml",
    });
    const pre = container.querySelector("pre.terminal");
    expect(pre!.textContent).toContain("[render error]");
    expect(pre!.textContent).toContain("未対応の電文タイプ");
    expect(pre!.textContent).not.toContain("should not appear");
  });

  it("ansi 空 + error なしは空の terminal を出す (初期状態)", () => {
    const { container } = render(PreviewPane, { ansi: "", error: null });
    expect(container.querySelector("pre.terminal")).not.toBeNull();
  });
});
