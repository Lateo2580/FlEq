import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateBlocks, MARKERS, assertMarkers, replaceBlock, extractBlock, checkDoc, runWrite,
} from "../../../../scripts/generate-design-docs.mjs";

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");

function docWith(tokens: string, contrast: string): string {
  return [
    "# doc", "",
    MARKERS.tokens.start, tokens, MARKERS.tokens.end, "",
    MARKERS.contrast.start, contrast, MARKERS.contrast.end, "",
  ].join("\n");
}

describe("generateBlocks", () => {
  it("同じ文書に生成ブロックを 2 回適用しても不変 (冪等)", () => {
    const b = generateBlocks(css);
    const once = replaceBlock(replaceBlock(docWith("", ""), "tokens", b.tokens), "contrast", b.contrast);
    const twice = replaceBlock(replaceBlock(once, "tokens", b.tokens), "contrast", b.contrast);
    expect(twice).toBe(once);
  });
  it("css の 1 トークンを差し替えると tokens ブロックが変わる (生成が入力に依存)", () => {
    const b = generateBlocks(css);
    const mutated = css.replace("--fg: #f2f4f6;", "--fg: #f2f4f7;");
    expect(mutated).not.toBe(css); // 置換が効いた前提
    expect(generateBlocks(mutated).tokens).not.toBe(b.tokens);
  });
  it("tokens 表に --fg 行、contrast 表に許容判定が含まれる (Task 7 で全 FAIL を許容リスト仕分け済み)", () => {
    const b = generateBlocks(css);
    expect(b.tokens).toContain("`--fg`");
    expect(b.contrast).toContain("許容 (");
  });
});

describe("マーカー安全契約", () => {
  it("ちょうど 1 組なら assertMarkers は通る", () => {
    expect(() => assertMarkers(docWith("x", "y"))).not.toThrow();
  });
  it("マーカー欠損は throw", () => {
    expect(() => assertMarkers("# doc\n(no markers)")).toThrow();
  });
  it("マーカー重複は throw", () => {
    const dup = docWith("x", "y") + "\n" + MARKERS.tokens.start + "\n" + MARKERS.tokens.end;
    expect(() => assertMarkers(dup)).toThrow();
  });
  it("replaceBlock→extractBlock で往復一致", () => {
    const md = replaceBlock(docWith("old", "y"), "tokens", "NEW");
    expect(extractBlock(md, "tokens")).toBe("NEW");
    expect(extractBlock(md, "contrast")).toBe("y");
  });
});

describe("checkDoc", () => {
  it("生成内容と一致する文書は ok=true", () => {
    const b = generateBlocks(css);
    const md = docWith(b.tokens, b.contrast);
    expect(checkDoc(md, css)).toEqual({ ok: true, diffs: [] });
  });
  it("片方を改変すると diffs に出る", () => {
    const b = generateBlocks(css);
    const md = docWith("STALE-TOKENS", b.contrast);
    const r = checkDoc(md, css);
    expect(r.ok).toBe(false);
    expect(r.diffs).toContain("tokens");
  });
});

describe("runWrite 原子性 (注入 writeDoc で書き込み回数を観測)", () => {
  function attempt(md: string) {
    let writes = 0;
    const run = () => runWrite({ readDoc: () => md, writeDoc: () => { writes++; }, css });
    return { run, writes: () => writes };
  }
  it("正常な文書では writeDoc がちょうど 1 回", () => {
    const a = attempt(docWith("old-t", "old-c"));
    a.run();
    expect(a.writes()).toBe(1);
  });
  it("マーカー欠損では writeDoc が呼ばれず throw", () => {
    const a = attempt("# doc (no markers)");
    expect(() => a.run()).toThrow();
    expect(a.writes()).toBe(0);
  });
  it("マーカー重複では writeDoc が呼ばれず throw", () => {
    const a = attempt(docWith("t", "c") + "\n" + MARKERS.tokens.start + "\n" + MARKERS.tokens.end);
    expect(() => a.run()).toThrow();
    expect(a.writes()).toBe(0);
  });
  it("マーカー逆順では writeDoc が呼ばれず throw", () => {
    const reversed = [
      "# doc", MARKERS.tokens.end, MARKERS.tokens.start,
      MARKERS.contrast.start, MARKERS.contrast.end,
    ].join("\n");
    const a = attempt(reversed);
    expect(() => a.run()).toThrow();
    expect(a.writes()).toBe(0);
  });
});
