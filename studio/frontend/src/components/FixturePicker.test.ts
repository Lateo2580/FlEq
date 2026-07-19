import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import FixturePicker from "./FixturePicker.svelte";
import type { FixtureSummary } from "../lib/api";

const FIXTURES: FixtureSummary[] = [
  { id: "a.xml", type: "VPWW55", label: "VPWW55 — a", supported: true },
  { id: "b.xml", type: "VPWS50", label: "VPWS50 — b", supported: false },
];

describe("FixturePicker", () => {
  it("fixture 一覧をボタンで表示する", () => {
    render(FixturePicker, { fixtures: FIXTURES, selected: null, onselect: () => {} });
    expect(screen.getByRole("button", { name: /VPWW55/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /VPWS50/ })).toBeTruthy();
  });

  it("supported: false のボタンは disabled", () => {
    render(FixturePicker, { fixtures: FIXTURES, selected: null, onselect: () => {} });
    const btn = screen.getByRole("button", { name: /VPWS50/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("クリックで onselect(id) が呼ばれる", async () => {
    const onselect = vi.fn();
    render(FixturePicker, { fixtures: FIXTURES, selected: null, onselect });
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    expect(onselect).toHaveBeenCalledWith("a.xml");
  });

  it("selected の fixture に selected クラスが付く", () => {
    render(FixturePicker, { fixtures: FIXTURES, selected: "a.xml", onselect: () => {} });
    const btn = screen.getByRole("button", { name: /VPWW55/ });
    expect(btn.classList.contains("selected")).toBe(true);
  });
});
