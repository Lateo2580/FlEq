import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import DisplayOptions from "./DisplayOptions.svelte";
import type { RenderOptions } from "../lib/api";

const OPTS: RenderOptions = { compact: false, width: 100, noColor: false, nightMode: false };

describe("DisplayOptions", () => {
  it("幅プリセットの変更で onchange が新 options で呼ばれる", async () => {
    const onchange = vi.fn();
    render(DisplayOptions, { options: OPTS, onchange });
    await fireEvent.change(screen.getByLabelText("幅"), { target: { value: "80" } });
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, width: 80 });
  });

  it("compact / NO_COLOR / Night の各トグルが onchange に反映される", async () => {
    const onchange = vi.fn();
    render(DisplayOptions, { options: OPTS, onchange });
    await fireEvent.click(screen.getByLabelText("compact"));
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, compact: true });
    await fireEvent.click(screen.getByLabelText("NO_COLOR"));
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, noColor: true });
    await fireEvent.click(screen.getByLabelText("Night"));
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, nightMode: true });
  });

  it("カスタム幅入力は 40-300 に clamp される", async () => {
    const onchange = vi.fn();
    render(DisplayOptions, { options: OPTS, onchange });
    const custom = screen.getByLabelText("カスタム幅");
    await fireEvent.change(custom, { target: { value: "20" } });
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, width: 40 });
    await fireEvent.change(custom, { target: { value: "999" } });
    expect(onchange).toHaveBeenCalledWith({ ...OPTS, width: 300 });
  });
});
