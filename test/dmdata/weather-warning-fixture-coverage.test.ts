import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDisplaySeverity, resolvePhenomenonFamily } from "../../src/dmdata/weather-warning-level";

// glob は依存に無いため node:fs で fixtures を列挙する。
const FIXTURE_DIR = "test/fixtures";
const VPWW_RE = /^15_.*_VPWW(55|56|57|58|59|60|61)\.xml$/;

function listVpwwFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => VPWW_RE.test(f))
    .map((f) => join(FIXTURE_DIR, f).replace(/\\/g, "/"));
}

describe("VPWW55-61 fixture Code 網羅性", () => {
  const files = listVpwwFixtures();

  it("fixture が 1 つ以上見つかる", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("全 (kindCode, kindName) が source=map で解決される", () => {
    const out = execSync(`node scripts/extract-kind-codes.mjs ${files.join(" ")}`, {
      encoding: "utf8",
    });
    const entries: { telegram: string; code: string; name: string }[] = JSON.parse(out);
    expect(entries.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const e of entries) {
      const family = resolvePhenomenonFamily(e.code, e.name);
      const r = resolveDisplaySeverity(e.code, e.name, family);
      if (r.source !== "map") {
        failures.push(
          `${e.telegram} Code=${e.code} Name="${e.name}" family=${family} source=${r.source}`,
        );
      }
    }
    expect(failures, `nameFallback/unknown ヒット:\n${failures.join("\n")}`).toEqual([]);
  });
});
