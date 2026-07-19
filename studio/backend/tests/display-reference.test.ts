import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { DISPLAY_REFERENCE_MAP, resolveHeadings } from "../lib/display-reference-map";
import { displayReferenceRoute } from "../routes/display-reference";

const MD_PATH = path.resolve(__dirname, "../../../docs/display-reference.md");

function makeApp() {
  const app = new Hono();
  app.route("/api/display-reference", displayReferenceRoute());
  return app;
}

describe("display-reference-map", () => {
  it("map の全見出しが実際の display-reference.md に存在する (同期ガード)", () => {
    const md = fs.readFileSync(MD_PATH, "utf-8");
    const lines = new Set(md.split("\n").map((l) => l.trim()));
    for (const entry of DISPLAY_REFERENCE_MAP) {
      for (const h of entry.headings) {
        expect(lines.has(h), `見出しが md に無い: ${h}`).toBe(true);
      }
    }
  });

  it("VPWW55 は気象警報セクション + サマリーライン共通セクションに解決される", () => {
    const headings = resolveHeadings("VPWW55");
    expect(headings.some((h) => h.includes("気象警報・注意報"))).toBe(true);
    expect(headings.some((h) => h.includes("サマリーライン"))).toBe(true);
  });

  it("未知タイプは空配列", () => {
    expect(resolveHeadings("XXXX99")).toEqual([]);
  });

  it.each([
    ["VPWS50", "## 気象警報・注意報 (VPWW55-61, VPWS50)"],
    ["VPWP50", "## 気象警報・注意報時系列情報 (VPWP50)"],
    ["VPCJ51", "## 気象解説情報 (VPCJ51, VPZJ51, VPFJ51, VMCJ53-55)"],
    ["VPZJ51", "## 気象解説情報 (VPCJ51, VPZJ51, VPFJ51, VMCJ53-55)"],
    ["VPFJ51", "## 気象解説情報 (VPCJ51, VPZJ51, VPFJ51, VMCJ53-55)"],
  ] as const)("%s の参照見出しに %s が含まれる", (type, heading) => {
    expect(resolveHeadings(type)).toContain(heading);
  });

  it("map 未登録の型は空配列 (best-effort)", () => {
    expect(resolveHeadings("VPHW50")).toEqual([]);
    expect(resolveHeadings("VPBS50")).toEqual([]);
    expect(resolveHeadings("VPAW51")).toEqual([]);
    expect(resolveHeadings("VPZI50")).toEqual([]);
  });
});

describe("GET /api/display-reference", () => {
  it("type=VPWW55 で該当セクションの markdown が返る", async () => {
    const res = await makeApp().request("/api/display-reference?type=VPWW55");
    expect(res.status).toBe(200);
    const body = await res.json() as { sections: Array<{ heading: string; markdown: string }> };
    expect(body.sections.length).toBeGreaterThanOrEqual(1);
    const weather = body.sections[0];
    expect(weather.heading).toContain("気象警報・注意報");
    expect(weather.markdown).toContain("VPWW55-61");
    expect(weather.markdown).toContain("警戒レベル相当デザイン");  // 見出し行だけでなく本文が取れている (L1052 の ### 小見出し)
    expect(weather.markdown.length).toBeGreaterThan(200);
    // 次の ## セクションは含まれない
    expect(weather.markdown).not.toContain("## 気象警報・注意報時系列情報");
  });

  it("未知タイプは sections: [] (200)", async () => {
    const res = await makeApp().request("/api/display-reference?type=XXXX99");
    expect(res.status).toBe(200);
    const body = await res.json() as { sections: unknown[] };
    expect(body.sections).toEqual([]);
  });

  it("type 欠落は 400", async () => {
    const res = await makeApp().request("/api/display-reference");
    expect(res.status).toBe(400);
  });
});
