import { describe, it, expect } from "vitest";
import { tokenize } from "../../../src/engine/filter/tokenizer";

describe("tokenize", () => {
  it("単純な比較: domain = \"eew\"", () => {
    const tokens = tokenize('domain = "eew"');
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "domain"],
      ["op", "="],
      ["string", "eew"],
      ["eof", ""],
    ]);
  });

  it("数値リテラル: magnitude >= 6.5", () => {
    const tokens = tokenize("magnitude >= 6.5");
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "magnitude"],
      ["op", ">="],
      ["number", "6.5"],
      ["eof", ""],
    ]);
  });

  it("論理演算子: domain = \"eew\" and isWarning = true", () => {
    const tokens = tokenize('domain = "eew" and isWarning = true');
    expect(tokens[3]).toEqual({ kind: "and", value: "and", pos: 15 });
    expect(tokens[4]).toEqual({ kind: "ident", value: "isWarning", pos: 19 });
  });

  it("not 演算子", () => {
    const tokens = tokenize("not isTest");
    expect(tokens[0]).toEqual({ kind: "not", value: "not", pos: 0 });
  });

  it("リスト: domain in [\"eew\", \"earthquake\"]", () => {
    const tokens = tokenize('domain in ["eew", "earthquake"]');
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toEqual(["ident", "op", "lbracket", "string", "comma", "string", "rbracket", "eof"]);
  });

  it("括弧", () => {
    const tokens = tokenize("(a or b)");
    expect(tokens[0].kind).toBe("lparen");
    expect(tokens[4].kind).toBe("rparen");
  });

  it("boolean と null", () => {
    const tokens = tokenize("true false null");
    expect(tokens[0]).toEqual({ kind: "boolean", value: "true", pos: 0 });
    expect(tokens[1]).toEqual({ kind: "boolean", value: "false", pos: 5 });
    expect(tokens[2]).toEqual({ kind: "null", value: "null", pos: 11 });
  });

  it("正規表現演算子: ~ と !~", () => {
    const tokens = tokenize('name ~ "能登"');
    expect(tokens[1]).toEqual({ kind: "op", value: "~", pos: 5 });
  });

  it("contains 演算子", () => {
    const tokens = tokenize("areaNames contains \"石川\"");
    expect(tokens[1]).toEqual({ kind: "op", value: "contains", pos: 10 });
  });

  it("dot パス: diff.previousMaxInt", () => {
    const tokens = tokenize("diff.previousMaxInt");
    expect(tokens[0]).toEqual({ kind: "ident", value: "diff.previousMaxInt", pos: 0 });
  });

  it("空文字は eof のみ", () => {
    const tokens = tokenize("");
    expect(tokens).toEqual([{ kind: "eof", value: "", pos: 0 }]);
  });

  it("閉じ引用符がない場合エラー", () => {
    expect(() => tokenize('"unclosed')).toThrow();
  });
});
