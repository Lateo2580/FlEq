import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import RoleEditor from "./RoleEditor.svelte";
import { ThemeStore } from "../lib/theme-store.svelte";
import type { ThemeCatalog } from "../lib/api";

const CATALOG: ThemeCatalog = {
  paletteNames: ["vermillion", "sky"],
  roleNames: ["frameCritical", "intensity7"],
  categories: [
    { label: "枠", roles: ["frameCritical"] },
    { label: "地震", roles: ["intensity7"] },
  ],
  defaults: {
    palette: { vermillion: "#D55E00", sky: "#56B4E9" },
    roles: {
      frameCritical: "vermillion",
      intensity7: { bg: "darkRed", fg: "#FFFFFF", bold: true },
    },
  },
  saved: null,
  warnings: [],
};

describe("RoleEditor", () => {
  let store: ThemeStore;
  beforeEach(() => {
    store = new ThemeStore();
    store.init(structuredClone(CATALOG));
  });

  it("カテゴリタブが出て、最初のタブのロールが表示される", () => {
    render(RoleEditor, { store });
    expect(screen.getByRole("tab", { name: "枠" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "地震" })).toBeTruthy();
    expect(screen.getByText("frameCritical")).toBeTruthy();
  });

  it("タブ切替で別カテゴリのロールが出る", async () => {
    render(RoleEditor, { store });
    await fireEvent.click(screen.getByRole("tab", { name: "地震" }));
    expect(screen.getByText("intensity7")).toBeTruthy();
  });

  it("fg を入力すると store に override (object 形) が入る", async () => {
    render(RoleEditor, { store });
    const fg = screen.getByLabelText("frameCritical-fg") as HTMLInputElement;
    await fireEvent.input(fg, { target: { value: "#123456" } });
    expect(store.edit.roles!.frameCritical).toEqual({ fg: "#123456" });
  });

  it("bold だけチェックしてもデフォルトの fg は維持される (部分編集でデフォルトを落とさない)", async () => {
    // resolveTheme は override を「全置換」で扱うため、部分編集は
    // デフォルト定義から seed した object に patch する (plan レビュー反映)
    render(RoleEditor, { store });
    const bold = screen.getByLabelText("frameCritical-bold") as HTMLInputElement;
    await fireEvent.click(bold);
    expect(store.edit.roles!.frameCritical).toEqual({ fg: "vermillion", bold: true });
  });

  it("object 形デフォルト (intensity7) の bold を外すと bg/fg は維持される", async () => {
    render(RoleEditor, { store });
    await fireEvent.click(screen.getByRole("tab", { name: "地震" }));
    const bold = screen.getByLabelText("intensity7-bold") as HTMLInputElement;
    expect(bold.checked).toBe(true); // デフォルトの bold: true が表示に反映されている
    await fireEvent.click(bold);
    expect(store.edit.roles!.intensity7).toEqual({ bg: "darkRed", fg: "#FFFFFF" });
  });

  it("fg/bg/bold をすべて空に戻すと override が消える", async () => {
    store.setRole("frameCritical", { fg: "#123456" });
    render(RoleEditor, { store });
    const fg = screen.getByLabelText("frameCritical-fg") as HTMLInputElement;
    await fireEvent.input(fg, { target: { value: "" } });
    expect(store.isRoleOverridden("frameCritical")).toBe(false);
  });

  it("reset ボタンで override が消える", async () => {
    store.setRole("frameCritical", { fg: "#123456" });
    render(RoleEditor, { store });
    await fireEvent.click(screen.getByRole("button", { name: /frameCritical をリセット/ }));
    expect(store.isRoleOverridden("frameCritical")).toBe(false);
  });
});
