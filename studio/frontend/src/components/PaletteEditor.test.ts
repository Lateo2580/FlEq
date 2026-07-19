import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PaletteEditor from "./PaletteEditor.svelte";
import { ThemeStore } from "../lib/theme-store.svelte";
import type { ThemeCatalog } from "../lib/api";

const CATALOG: ThemeCatalog = {
  paletteNames: ["vermillion", "sky"],
  roleNames: [],
  categories: [],
  defaults: { palette: { vermillion: "#D55E00", sky: "#56B4E9" }, roles: {} },
  saved: null,
  warnings: [],
};

describe("PaletteEditor", () => {
  let store: ThemeStore;
  beforeEach(() => {
    store = new ThemeStore();
    store.init(structuredClone(CATALOG));
  });

  it("パレット全色の color input が出る (デフォルト値入り)", () => {
    render(PaletteEditor, { store });
    const inputs = screen.getAllByLabelText(/palette-/) as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value.toUpperCase()).toBe("#D55E00");
  });

  it("色を変えると store に override が入る", async () => {
    render(PaletteEditor, { store });
    const input = screen.getByLabelText("palette-vermillion") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "#ff00ff" } });
    expect(store.edit.palette!.vermillion!.toUpperCase()).toBe("#FF00FF");
  });

  it("override がある色に reset ボタンが出て、押すと default に戻る", async () => {
    store.setPaletteColor("vermillion", "#FF00FF");
    render(PaletteEditor, { store });
    const reset = screen.getByRole("button", { name: /vermillion をリセット/ });
    await fireEvent.click(reset);
    expect(store.edit.palette!.vermillion).toBeUndefined();
  });
});
