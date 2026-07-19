import { describe, it, expect } from "vitest";
import { ROLE_CATEGORIES } from "../lib/role-categories";
import { getRoleNames } from "../../../src/ui/theme";

describe("ROLE_CATEGORIES", () => {
  it("全カテゴリのロールを合算すると getRoleNames() と過不足なく一致する", () => {
    const categorized = ROLE_CATEGORIES.flatMap((c) => c.roles);
    const actual = [...getRoleNames()].sort();
    expect([...categorized].sort()).toEqual(actual);
    expect(new Set(categorized).size).toBe(categorized.length); // 重複なし
  });

  it("各カテゴリは label と 1 件以上の roles を持つ", () => {
    for (const c of ROLE_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.roles.length).toBeGreaterThan(0);
    }
  });
});
