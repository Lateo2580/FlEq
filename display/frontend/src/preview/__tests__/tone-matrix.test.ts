import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "PreviewApp.svelte"), "utf8");

describe("tone-matrix preview gate", () => {
  it("critical film is stacked above both text and backgrounds", () => {
    const overlay = source.match(/\.tone-matrix-cell\.critical-overlay::after\s*\{[^}]*\}/s)?.[0] ?? "";
    const content = source.match(/\.tone-matrix-label,[^{]+\{[^}]*\}/s)?.[0] ?? "";
    expect(overlay).toMatch(/z-index:\s*2/);
    expect(content).toMatch(/z-index:\s*1/);
  });

  it("role foreground sample uses an actual role token", () => {
    expect(source).toMatch(/\.tone-matrix-role\s*\{\s*color:\s*var\(--role-weatherWarning\)/);
  });

  it("each cell uses the production background-tone selector path", () => {
    expect(source).toMatch(/<main[^>]*class="tone-matrix-cell"[^>]*data-background-tone=\{tone\}/s);
    expect(source).toMatch(/\.tone-matrix-cell\s*\{[^}]*background:\s*var\(--bg\)/s);
    expect(source).not.toContain("--matrix-background");
  });
});
