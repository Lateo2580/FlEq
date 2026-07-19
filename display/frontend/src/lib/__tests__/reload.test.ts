import { describe, expect, it } from "vitest";
import { shouldReload } from "../reload";

describe("shouldReload", () => {
  it("① 4時台 + standby + 未リロードなら true", () => {
    const now = new Date(2026, 6, 7, 4, 30, 0);
    expect(shouldReload(null, now, "standby")).toBe(true);
  });

  it("② emergency なら false (4時台・未リロードでも)", () => {
    const now = new Date(2026, 6, 7, 4, 30, 0);
    expect(shouldReload(null, now, "emergency")).toBe(false);
  });

  it("③ 同日リロード済みなら false", () => {
    const now = new Date(2026, 6, 7, 4, 30, 0);
    const lastReloadIso = new Date(2026, 6, 7, 4, 5, 0).toISOString();
    expect(shouldReload(lastReloadIso, now, "standby")).toBe(false);
  });

  it("④ 5時なら false", () => {
    const now = new Date(2026, 6, 7, 5, 0, 0);
    expect(shouldReload(null, now, "standby")).toBe(false);
  });
});
