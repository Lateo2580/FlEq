import { describe, it, expect, beforeEach } from "vitest";
import { applyNightOverlay, getExemptRoles } from "../../src/ui/night-overlay";
import {
  resolveTheme,
  DEFAULT_PALETTE,
  DEFAULT_ROLES,
  setNightMode,
  isNightMode,
  getRole,
  type ResolvedTheme,
  type RoleName,
} from "../../src/ui/theme";

/** デフォルトテーマを生成する */
function buildDefault(): ResolvedTheme {
  const { theme } = resolveTheme({}, { palette: DEFAULT_PALETTE, roles: DEFAULT_ROLES });
  return theme;
}

describe("applyNightOverlay", () => {
  it("ResolvedTheme を返すこと", () => {
    const base = buildDefault();
    const result = applyNightOverlay(base);

    expect(result).toBeDefined();
    expect(result.palette).toBeDefined();
    expect(result.roles).toBeDefined();
  });

  it("危険色ロールは変更されないこと", () => {
    const base = buildDefault();
    const result = applyNightOverlay(base);
    const exemptRoles = getExemptRoles();

    for (const roleName of exemptRoles) {
      expect(result.roles[roleName]).toEqual(base.roles[roleName]);
    }
  });

  it("危険色以外のロールは減光されること", () => {
    const base = buildDefault();
    const result = applyNightOverlay(base);
    const exemptRoles = getExemptRoles();

    // frameNormal は危険色ではないので減光される
    const testRole: RoleName = "frameNormal";
    expect(exemptRoles.has(testRole)).toBe(false);

    const baseFg = base.roles[testRole].fg;
    const resultFg = result.roles[testRole].fg;

    // fg が存在する場合、減光されていること
    if (baseFg != null && resultFg != null) {
      expect(resultFg[0]).toBeLessThan(baseFg[0]);
      expect(resultFg[1]).toBeLessThan(baseFg[1]);
      expect(resultFg[2]).toBeLessThan(baseFg[2]);
    }
  });

  it("パレットも減光されること", () => {
    const base = buildDefault();
    const result = applyNightOverlay(base);

    // sky の RGB を比較
    expect(result.palette.sky[0]).toBeLessThan(base.palette.sky[0]);
    expect(result.palette.sky[1]).toBeLessThan(base.palette.sky[1]);
    expect(result.palette.sky[2]).toBeLessThan(base.palette.sky[2]);
  });

  it("元のテーマを変更しないこと (純粋関数)", () => {
    const base = buildDefault();
    const originalSky = [...base.palette.sky];
    applyNightOverlay(base);

    expect(base.palette.sky[0]).toBe(originalSky[0]);
    expect(base.palette.sky[1]).toBe(originalSky[1]);
    expect(base.palette.sky[2]).toBe(originalSky[2]);
  });
});

describe("setNightMode / isNightMode", () => {
  beforeEach(() => {
    setNightMode(false);
  });

  it("デフォルトで false であること", () => {
    expect(isNightMode()).toBe(false);
  });

  it("setNightMode(true) で有効になること", () => {
    setNightMode(true);
    expect(isNightMode()).toBe(true);
  });

  it("setNightMode(true) 後に currentTheme が変わること", () => {
    const before = getRole("frameNormal");
    setNightMode(true);
    const after = getRole("frameNormal");

    // frameNormal は危険色ではないので変わるはず
    if (before.fg != null && after.fg != null) {
      expect(after.fg[0]).toBeLessThan(before.fg[0]);
    }
  });

  it("setNightMode(false) で元に戻ること", () => {
    const original = getRole("frameNormal");
    setNightMode(true);
    setNightMode(false);
    const restored = getRole("frameNormal");

    expect(restored).toEqual(original);
  });
});
