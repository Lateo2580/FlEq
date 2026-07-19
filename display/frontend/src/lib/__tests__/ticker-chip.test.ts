import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChipTokens } from "../ticker-chip";
import type { DisplayColorRole } from "../protocol";

const ALL_ROLES: DisplayColorRole[] = [
  "critical", "warning", "normal", "info", "cancel",
  "eewWarning", "eewForecast",
  "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
  "quakeMajor",
  "weatherEmergency", "weatherWarning", "weatherAdvisory",
  "connectionOk", "connectionStale", "muted",
];

describe("resolveChipTokens", () => {
  it("直接 8 role は --header-<role>-* を引く", () => {
    expect(resolveChipTokens("eewWarning")).toEqual({
      container: "var(--header-eewWarning-container)",
      on: "var(--header-eewWarning-on)",
    });
    expect(resolveChipTokens("weatherEmergency").container).toBe("var(--header-weatherEmergency-container)");
    expect(resolveChipTokens("tsunamiAdvisory").on).toBe("var(--header-tsunamiAdvisory-on)");
  });

  it("別名 3 role は既存 token を流用する (新色なし)", () => {
    // critical / quakeMajor → quakeCritical (vermillion)
    expect(resolveChipTokens("critical")).toEqual({
      container: "var(--header-quakeCritical-container)",
      on: "var(--header-quakeCritical-on)",
    });
    expect(resolveChipTokens("quakeMajor").container).toBe("var(--header-quakeCritical-container)");
    // warning → quakeWarning (orange)
    expect(resolveChipTokens("warning").container).toBe("var(--header-quakeWarning-container)");
  });

  it("cancel は機械導出 container (新直値色なし)", () => {
    expect(resolveChipTokens("cancel")).toEqual({
      container: "color-mix(in srgb, var(--role-cancel) 20%, var(--surface-low))",
      on: "var(--role-cancel)",
    });
  });

  it("中立 5 role は --surface-high 面 + role 色", () => {
    for (const role of ["normal", "info", "connectionStale", "muted"] as const) {
      expect(resolveChipTokens(role)).toEqual({
        container: "var(--surface-high)",
        on: `var(--role-${role})`,
      });
    }
  });

  it("connectionOk は --surface-high 面 + --c-gray (--role-connectionOk はチップに暗すぎるため lift)", () => {
    expect(resolveChipTokens("connectionOk")).toEqual({
      container: "var(--surface-high)",
      on: "var(--c-gray)",
    });
  });

  it("全 17 role が例外なく pair を返す (網羅)", () => {
    for (const role of ALL_ROLES) {
      const t = resolveChipTokens(role);
      expect(t.container).toBeTruthy();
      expect(t.on).toBeTruthy();
    }
  });
});

// theme.css の `--name: #hex;` を map 化 (var 連鎖と #hex のみ扱う。color-mix は解決しない)
function loadTokenHexMap(): Map<string, string> {
  const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");
  const raw = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    raw.set(m[1], m[2].trim());
  }
  const resolved = new Map<string, string>();
  const resolve = (val: string, depth = 0): string | null => {
    if (depth > 10) return null;
    const hex = val.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (hex) return val;
    const varMatch = val.match(/^var\((--[\w-]+)\)$/);
    if (varMatch) {
      const next = raw.get(varMatch[1]);
      return next != null ? resolve(next, depth + 1) : null;
    }
    return null;
  };
  for (const [k, v] of raw) {
    const r = resolve(v);
    if (r != null) resolved.set(k, r);
  }
  return resolved;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const la = relLuminance(hexToRgb(a));
  const lb = relLuminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// var(...) 文字列を hex へ (map 解決)。解決不能 (color-mix 等) は null
function toHex(cssVal: string, map: Map<string, string>): string | null {
  const m = cssVal.match(/^var\((--[\w-]+)\)$/);
  if (m) return map.get(m[1]) ?? null;
  if (/^#[0-9a-fA-F]{3,6}$/.test(cssVal)) return cssVal;
  return null;
}

describe("チップコントラスト実測 (Spec C §7/§8)", () => {
  it("literal hex に解決できる 16 role のチップ on⇔container コントラストが AA 大文字 (3.0) 以上", () => {
    const map = loadTokenHexMap();
    const roles: DisplayColorRole[] = ALL_ROLES.filter((r) => r !== "cancel");
    let checked = 0;
    for (const role of roles) {
      const { container, on } = resolveChipTokens(role);
      const cHex = toHex(container, map);
      const oHex = toHex(on, map);
      if (cHex == null || oHex == null) continue; // 解決不能はスキップ (色目視で担保)
      checked += 1;
      expect(contrast(cHex, oHex), `role=${role} container=${cHex} on=${oHex}`).toBeGreaterThanOrEqual(3.0);
    }
    // cancel (color-mix、自動対象外) を除く 16 role が**全て**literal hex に解決でき自動測定されたこと。
    // 未解決が出たら (>= だと素通りする) toBe で確実に検出し、cancel 目視と合わせて 17 role 完全被覆にする
    expect(checked).toBe(16);
  });
});
