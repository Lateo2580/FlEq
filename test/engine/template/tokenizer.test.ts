import { describe, it, expect } from "vitest";
import { tokenizeTemplate } from "../../../src/engine/template/tokenizer";

describe("tokenizeTemplate", () => {
  it("テキストのみ", () => {
    const tokens = tokenizeTemplate("hello world");
    expect(tokens).toEqual([
      { kind: "text", value: "hello world", pos: 0 },
      { kind: "eof", value: "", pos: 11 },
    ]);
  });

  it("単純な interpolation", () => {
    const tokens = tokenizeTemplate("{{domain}}");
    expect(tokens.map(t => t.kind)).toEqual(["open", "text", "close", "eof"]);
    expect(tokens[1].value).toBe("domain");
  });

  it("テキスト + interpolation + テキスト", () => {
    const tokens = tokenizeTemplate("M{{magnitude}} 震度{{maxInt}}");
    expect(tokens.map(t => [t.kind, t.value])).toEqual([
      ["text", "M"],
      ["open", "{{"],
      ["text", "magnitude"],
      ["close", "}}"],
      ["text", " 震度"],
      ["open", "{{"],
      ["text", "maxInt"],
      ["close", "}}"],
      ["eof", ""],
    ]);
  });

  it("フィルタ付き interpolation", () => {
    const tokens = tokenizeTemplate('{{magnitude|default:"-"}}');
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toContain("pipe");
    expect(kinds).toContain("colon");
  });

  it("if ブロック", () => {
    const tokens = tokenizeTemplate("{{#if isWarning}}警報{{else}}予報{{/if}}");
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toContain("if_open");
    expect(kinds).toContain("else");
    expect(kinds).toContain("endif");
  });

  it("複数引数フィルタ", () => {
    const tokens = tokenizeTemplate('{{title|replace:"に関する情報":""}}');
    const kinds = tokens.map(t => t.kind);
    // open, text(title), pipe, text(replace), colon, text("に関する情報"), colon, text(""), close, eof
    expect(kinds.filter(k => k === "colon")).toHaveLength(2);
  });

  it("index access 付きパス", () => {
    const tokens = tokenizeTemplate("{{areaItems[0].name}}");
    expect(tokens.map(t => t.kind)).toEqual(["open", "text", "close", "eof"]);
    expect(tokens[1].value).toBe("areaItems[0].name");
  });

  it("文字列リテラル内のパイプやコロンはそのまま", () => {
    const tokens = tokenizeTemplate('{{title|default:"a|b:c"}}');
    // 文字列 "a|b:c" は1つの text トークンとして読まれる
    const textTokens = tokens.filter(t => t.kind === "text");
    const stringToken = textTokens.find(t => t.value.includes("a|b:c"));
    expect(stringToken).toBeDefined();
  });
});
