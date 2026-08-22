import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Clock", () => {
  it("large clock uses one fixed size cluster at every standby resolution", () => {
    const source = readFileSync(join(__dirname, "..", "Clock.svelte"), "utf8");
    expect(source).toMatch(/\.time\s*\{[^}]*font-size:\s*92px;/s);
    expect(source).toMatch(/\.date\s*\{[^}]*font-size:\s*21px;[^}]*margin-top:\s*16px;/s);
    expect(source).not.toMatch(/font-size:\s*clamp\([^;]*cqw/);
  });
});
