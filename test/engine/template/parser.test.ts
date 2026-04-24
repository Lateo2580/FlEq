import { describe, it, expect } from "vitest";
import { parseTemplate } from "../../../src/engine/template/parser";

describe("parseTemplate", () => {
  it("テキストのみ", () => {
    const nodes = parseTemplate("hello");
    expect(nodes).toEqual([{ kind: "text", value: "hello" }]);
  });

  it("単純な interpolation", () => {
    const nodes = parseTemplate("{{domain}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("interpolation");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "path", segments: ["domain"] });
      expect(nodes[0].filters).toEqual([]);
    }
  });

  it("フィルタ付き interpolation", () => {
    const nodes = parseTemplate('{{magnitude|default:"-"}}');
    expect(nodes).toHaveLength(1);
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].filters).toHaveLength(1);
      expect(nodes[0].filters[0].name).toBe("default");
      expect(nodes[0].filters[0].args).toHaveLength(1);
      expect(nodes[0].filters[0].args[0]).toEqual({ kind: "literal", value: "-" });
    }
  });

  it("複数フィルタ", () => {
    const nodes = parseTemplate('{{hypocenterName|truncate:10|default:"-"}}');
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].filters).toHaveLength(2);
      expect(nodes[0].filters[0].name).toBe("truncate");
      expect(nodes[0].filters[0].args[0]).toEqual({ kind: "literal", value: 10 });
      expect(nodes[0].filters[1].name).toBe("default");
    }
  });

  it("if ブロック", () => {
    const nodes = parseTemplate("{{#if isWarning}}警報{{/if}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("if");
    if (nodes[0].kind === "if") {
      expect(nodes[0].test.kind).toBe("truthy");
      expect(nodes[0].body).toHaveLength(1);
      expect(nodes[0].elseBody).toBeUndefined();
    }
  });

  it("if/else ブロック", () => {
    const nodes = parseTemplate("{{#if isWarning}}警報{{else}}予報{{/if}}");
    if (nodes[0].kind === "if") {
      expect(nodes[0].body[0]).toEqual({ kind: "text", value: "警報" });
      expect(nodes[0].elseBody).toHaveLength(1);
      expect(nodes[0].elseBody![0]).toEqual({ kind: "text", value: "予報" });
    }
  });

  it("混合: テキスト + interpolation + if", () => {
    const nodes = parseTemplate("M{{magnitude}} {{#if isWarning}}!{{/if}}");
    expect(nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("配列インデックス参照は禁止 (areaItems[0].name)", () => {
    expect(() => parseTemplate("{{areaItems[0].name}}")).toThrow(/配列インデックス参照/);
  });

  it("配列インデックス参照は禁止 (条件式内)", () => {
    expect(() => parseTemplate("{{#if areaItems[0].name}}x{{/if}}")).toThrow(/配列インデックス参照/);
  });

  it("raw フィールド参照は禁止", () => {
    expect(() => parseTemplate("{{raw.body}}")).toThrow(/raw フィールド参照は無効/);
  });

  it("raw 単独参照も禁止", () => {
    expect(() => parseTemplate("{{raw}}")).toThrow(/raw フィールド参照は無効/);
  });

  it("replace フィルタに2引数", () => {
    const nodes = parseTemplate('{{title|replace:"に関する情報":""}}');
    expect(nodes).toHaveLength(1);
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].filters).toHaveLength(1);
      expect(nodes[0].filters[0].name).toBe("replace");
      expect(nodes[0].filters[0].args).toHaveLength(2);
      expect(nodes[0].filters[0].args[0]).toEqual({ kind: "literal", value: "に関する情報" });
      expect(nodes[0].filters[0].args[1]).toEqual({ kind: "literal", value: "" });
    }
  });

  it("if ブロック: 比較演算", () => {
    const nodes = parseTemplate('{{#if maxIntRank >= 4}}強{{/if}}');
    expect(nodes).toHaveLength(1);
    if (nodes[0].kind === "if") {
      expect(nodes[0].test).toEqual({
        kind: "compare",
        op: "ge",
        left: { kind: "path", segments: ["maxIntRank"] },
        right: { kind: "literal", value: 4 },
      });
    }
  });

  it("リテラル: 数値", () => {
    const nodes = parseTemplate("{{42}}");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "literal", value: 42 });
    }
  });

  it("リテラル: boolean", () => {
    const nodes = parseTemplate("{{true}}");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "literal", value: true });
    }
  });

  it("リテラル: null", () => {
    const nodes = parseTemplate("{{null}}");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "literal", value: null });
    }
  });

  it("ドットパス", () => {
    const nodes = parseTemplate("{{foo.bar.baz}}");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({
        kind: "path",
        segments: ["foo", "bar", "baz"],
      });
    }
  });

  it("エラー: 未閉じ interpolation (}} がない)", () => {
    expect(() => parseTemplate("{{title")).toThrow();
  });

  it("エラー: 未閉じ if ブロック ({{/if}} がない)", () => {
    expect(() => parseTemplate("{{#if isWarning}}text")).toThrow();
  });

  it("エスケープ文字列: \\\" と \\\\ と \\n と \\t", () => {
    const nodes = parseTemplate('{{"\\"hello\\\\ world\\n\\t"}}');
    expect(nodes).toHaveLength(1);
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "literal", value: '"hello\\ world\n\t' });
    }
  });
});
