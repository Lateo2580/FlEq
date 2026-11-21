import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 受入条件 P4-DW-AC11（負の検査）: 新しい描画（src/display/ の chrome-eew 以外と、S0 までの試験の client）は旧の full.view を読まず、
// 分野（unit）の名前で分岐しない。wire の型に HTML・SVG path・生 XML の欄を入れない。
const violations = (source: string): readonly string[] => [
  ...(/p2-snapshot-sse\.types/.test(source) ? ["imports the old snapshot types"] : []),
  ...(/\.view\b|delivery\s*===?\s*["']full["']/.test(source) ? ["reads full.view"] : []),
  ...(/["']U-[EWFTQNVLRBMY]["']/.test(source) ? ["branches on a unit name"] : []),
];
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? entry.name === "chrome-eew" ? [] : files(join(dir, entry.name))
    : /\.(ts|js|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

describe("P4-DW-T07 acceptance: the new renderer reads only the new wire", () => {
  it("finds no old view read or unit-name branch in the renderer sources, and catches a planted one", () => {
    const sources = [...files("reconstruction/src/display"), "reconstruction/test/display-wire/wire-client.ts"];
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) expect([path, violations(readFileSync(path, "utf8"))]).toEqual([path, []]);
    expect(violations('import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";\nconst view = snapshot.current.eew.view;'))
      .toEqual(["imports the old snapshot types", "reads full.view"]);
    expect(violations('if (domain.unit === "U-E") draw();')).toEqual(["branches on a unit name"]);
    // wire の型は字を text node で入れる前提で、HTML・SVG path・投影後の座標・生 XML の欄を持たない。
    expect(readFileSync("reconstruction/contracts/p4-display-wire.types.ts", "utf8")).not.toMatch(/\b(html|svg\w*|path|xml|projected\w*)\s*\??:/i);
  });
});
