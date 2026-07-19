import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTokens, buildTokenMap, resolveValue } from "../../../../scripts/generate-design-docs.mjs";

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");

describe("parseTokens", () => {
  const entries = parseTokens(css);
  const byName = (n: string) => entries.find((e) => e.name === n);

  it("最初のセクション前のトークンは (未分類) group で raw を持つ", () => {
    expect(byName("--fg")).toMatchObject({ name: "--fg", group: "(未分類)", raw: "#f2f4f6" });
  });
  it("セクションコメントを group に取り込む", () => {
    expect(byName("--c-vermillion")).toMatchObject({ group: "CUD 9 色", raw: "#d55e00" });
  });
  it("行末コメントを comment に取り込む", () => {
    expect(byName("--fg-faint")!.comment).toContain("沈んでいてよい");
  });
  it("1 行複数宣言 (header 行) を全て取り込む", () => {
    expect(byName("--header-eewWarning-container")!.raw).toBe("#3a1206");
    expect(byName("--header-eewWarning-on")!.raw).toBe("#ffb392");
    expect(byName("--header-band-eewWarning")!.raw).toBe("var(--c-vermillion)");
  });
  it("tier 上書きブロックの宣言を tier 上書き group で拾う", () => {
    expect(entries.some((e) => e.group === "tier 上書き" && e.name === "--num-weight")).toBe(true);
    expect(entries.some((e) => e.group === "tier 上書き" && e.name === "--surface-panel")).toBe(true);
  });
});

describe("resolveValue", () => {
  const map = buildTokenMap(parseTokens(css));

  it("多段 var を実値まで解決する", () => {
    expect(resolveValue("var(--role-critical)", map)).toBe("#d55e00");
    expect(resolveValue("var(--surface-panel)", map)).toBe("#0b0f12");
    expect(resolveValue("var(--int-8-bg)", map)).toBe("#d55e00");
  });
  it("buildTokenMap は base 先勝ち (tier 上書きに勝つ)", () => {
    expect(resolveValue("var(--num-weight)", map)).toBe("700");
  });
  it("fallback 付き var は参照不在なら fallback を使う", () => {
    expect(resolveValue("calc(4px * var(--panel-scale, 1))", map)).toBe("calc(4px * 1)");
  });
  it("未解決 var は throw する", () => {
    expect(() => resolveValue("var(--does-not-exist)", map)).toThrow();
  });
});

describe("resolveValue の循環と fallback (合成 fixture)", () => {
  const synthetic = new Map<string, string>([
    ["--self", "var(--self)"],
    ["--a", "var(--b)"],
    ["--b", "var(--a)"],
    ["--fallback-user", "var(--missing, #123456)"],
    ["--nested-fallback", "var(--missing, var(--ok))"],
    ["--ok", "#abcdef"],
  ]);
  it("自己循環は throw", () => {
    expect(() => resolveValue("var(--self)", synthetic)).toThrow();
  });
  it("相互循環は throw", () => {
    expect(() => resolveValue("var(--a)", synthetic)).toThrow();
  });
  it("fallback は参照不在時に使われる", () => {
    expect(resolveValue("var(--fallback-user)", synthetic)).toBe("#123456");
  });
  it("fallback 内の var も解決される", () => {
    expect(resolveValue("var(--nested-fallback)", synthetic)).toBe("#abcdef");
  });
});
