import { describe, it, expect, beforeEach } from "vitest";
import { ThemeStore } from "./theme-store.svelte";
import type { ThemeCatalog } from "./api";

const CATALOG: ThemeCatalog = {
  paletteNames: ["vermillion", "sky"],
  roleNames: ["frameCritical", "frameNormal"],
  categories: [{ label: "枠", roles: ["frameCritical", "frameNormal"] }],
  defaults: {
    palette: { vermillion: "#D55E00", sky: "#56B4E9" },
    roles: { frameCritical: "vermillion", frameNormal: { fg: "sky", bold: true } },
  },
  saved: null,
  warnings: [],
};

describe("ThemeStore", () => {
  let store: ThemeStore;
  beforeEach(() => {
    store = new ThemeStore();
    store.init(structuredClone(CATALOG));
  });

  it("saved: null で init すると edit は空 override", () => {
    expect(store.edit).toEqual({ palette: {}, roles: {} });
    expect(store.dirty).toBe(false);
  });

  it("saved がある場合は edit と baseline の初期値になる", () => {
    const s = new ThemeStore();
    s.init({ ...structuredClone(CATALOG), saved: { palette: { sky: "#111111" } } });
    expect(s.edit.palette!.sky).toBe("#111111");
    expect(s.dirty).toBe(false);
  });

  it("setPaletteColor で override が立ち、dirty になる", () => {
    store.setPaletteColor("vermillion", "#FF00FF");
    expect(store.edit.palette!.vermillion).toBe("#FF00FF");
    expect(store.dirty).toBe(true);
  });

  it("effectivePaletteHex は override 優先、無ければ default", () => {
    expect(store.effectivePaletteHex("vermillion")).toBe("#D55E00");
    store.setPaletteColor("vermillion", "#FF00FF");
    expect(store.effectivePaletteHex("vermillion")).toBe("#FF00FF");
  });

  it("resetPaletteColor で override が消える", () => {
    store.setPaletteColor("vermillion", "#FF00FF");
    store.resetPaletteColor("vermillion");
    expect(store.edit.palette!.vermillion).toBeUndefined();
    expect(store.dirty).toBe(false);
  });

  it("setRole / resetRole / isRoleOverridden", () => {
    expect(store.isRoleOverridden("frameCritical")).toBe(false);
    store.setRole("frameCritical", { fg: "#123456", bold: true });
    expect(store.edit.roles!.frameCritical).toEqual({ fg: "#123456", bold: true });
    expect(store.isRoleOverridden("frameCritical")).toBe(true);
    store.resetRole("frameCritical");
    expect(store.edit.roles!.frameCritical).toBeUndefined();
    expect(store.dirty).toBe(false);
  });

  it("defaultRoleDef はデフォルト定義を返す", () => {
    expect(store.defaultRoleDef("frameCritical")).toBe("vermillion");
    expect(store.defaultRoleDef("frameNormal")).toEqual({ fg: "sky", bold: true });
  });

  it("markSaved で baseline が edit に同期され dirty が消える", () => {
    store.setPaletteColor("vermillion", "#FF00FF");
    expect(store.dirty).toBe(true);
    store.markSaved();
    expect(store.dirty).toBe(false);
    expect(store.edit.palette!.vermillion).toBe("#FF00FF");
  });
});
