import { describe, it, expect } from "vitest";
import { typeCheck } from "../../../src/engine/filter/type-checker";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";

function check(source: string) {
  const ast = parse(tokenize(source), source);
  return typeCheck(ast, source);
}

describe("typeCheck", () => {
  it("正常: string = string", () => {
    expect(() => check('domain = "eew"')).not.toThrow();
  });

  it("正常: number >= number", () => {
    expect(() => check("magnitude >= 6.5")).not.toThrow();
  });

  it("正常: enum:intensity 順序比較", () => {
    expect(() => check('maxInt >= "5-"')).not.toThrow();
  });

  it("正常: enum:frameLevel 順序比較", () => {
    expect(() => check('frameLevel >= "warning"')).not.toThrow();
  });

  it("正常: boolean truthy", () => {
    expect(() => check("isWarning")).not.toThrow();
  });

  it("正常: string[] contains string", () => {
    expect(() => check('forecastAreaNames contains "石川県"')).not.toThrow();
  });

  it("正常: in リスト", () => {
    expect(() => check('domain in ["eew", "earthquake"]')).not.toThrow();
  });

  it("正常: regex マッチ", () => {
    expect(() => check('hypocenterName ~ "能登|佐渡"')).not.toThrow();
  });

  it("エラー: 未知のフィールド", () => {
    expect(() => check('foo = "bar"')).toThrow(/未知のフィールド/);
  });

  it("エラー: enum:intensity に数値リテラル", () => {
    expect(() => check("maxInt >= 5")).toThrow(/震度文字列/);
  });

  it("エラー: 不正な正規表現", () => {
    expect(() => check('hypocenterName ~ "能登("')).toThrow(/正規表現/);
  });

  it("エラー: in の右辺がリストでない", () => {
    expect(() => check('domain in "eew"')).toThrow(/リスト/);
  });

  it("正常: contains の右辺が number", () => {
    expect(() => check("forecastAreaNames contains 5")).not.toThrow();
  });
});
