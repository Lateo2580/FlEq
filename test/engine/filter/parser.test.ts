import { describe, it, expect } from "vitest";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";

function parseExpr(source: string) {
  return parse(tokenize(source), source);
}

describe("parse", () => {
  it("単一比較: domain = \"eew\"", () => {
    const ast = parseExpr('domain = "eew"');
    expect(ast).toEqual({
      kind: "comparison",
      left: { kind: "path", segments: ["domain"], pos: 0 },
      op: "=",
      right: { kind: "string", value: "eew", pos: 9 },
    });
  });

  it("and 結合", () => {
    const ast = parseExpr('domain = "eew" and isWarning = true');
    expect(ast.kind).toBe("and");
    if (ast.kind === "and") {
      expect(ast.children).toHaveLength(2);
      expect(ast.children[0].kind).toBe("comparison");
      expect(ast.children[1].kind).toBe("comparison");
    }
  });

  it("or 結合", () => {
    const ast = parseExpr('a = 1 or b = 2');
    expect(ast.kind).toBe("or");
  });

  it("and は or より優先", () => {
    const ast = parseExpr('a = 1 or b = 2 and c = 3');
    expect(ast.kind).toBe("or");
    if (ast.kind === "or") {
      expect(ast.children[1].kind).toBe("and");
    }
  });

  it("not 演算子", () => {
    const ast = parseExpr("not isTest");
    expect(ast.kind).toBe("not");
    if (ast.kind === "not") {
      expect(ast.operand.kind).toBe("truthy");
    }
  });

  it("括弧でグループ化", () => {
    const ast = parseExpr("(a = 1 or b = 2) and c = 3");
    expect(ast.kind).toBe("and");
  });

  it("in リスト", () => {
    const ast = parseExpr('domain in ["eew", "earthquake"]');
    expect(ast.kind).toBe("comparison");
    if (ast.kind === "comparison") {
      expect(ast.op).toBe("in");
      expect(ast.right.kind).toBe("list");
    }
  });

  it("truthy (単一パス)", () => {
    const ast = parseExpr("isWarning");
    expect(ast.kind).toBe("truthy");
  });

  it("パース失敗: 演算子の後に値がない", () => {
    expect(() => parseExpr('domain =')).toThrow();
  });

  it("パース失敗: 閉じ括弧がない", () => {
    expect(() => parseExpr("(a = 1")).toThrow();
  });
});
