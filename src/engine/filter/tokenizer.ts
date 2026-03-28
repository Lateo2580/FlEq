import { FilterToken, TokenKind } from "./types";
import { FilterSyntaxError } from "./errors";

const KEYWORDS: Record<string, TokenKind> = {
  and: "and",
  or: "or",
  not: "not",
  true: "boolean",
  false: "boolean",
  null: "null",
  in: "op",
  contains: "op",
};

const OPERATORS = ["!=", "<=", ">=", "!~", "=", "<", ">", "~"];

export function tokenize(source: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let i = 0;

  while (i < source.length) {
    // 空白スキップ
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }

    // 文字列リテラル
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      const start = i;
      i++; // 開き引用符
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          i++;
          value += source[i];
        } else {
          value += source[i];
        }
        i++;
      }
      if (i >= source.length) {
        throw new FilterSyntaxError(source, start, "で文字列が閉じられていない");
      }
      i++; // 閉じ引用符
      tokens.push({ kind: "string", value, pos: start });
      continue;
    }

    // 数値リテラル
    if (/[0-9]/.test(source[i]) || (source[i] === "-" && i + 1 < source.length && /[0-9]/.test(source[i + 1]))) {
      const start = i;
      if (source[i] === "-") i++;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      if (i < source.length && source[i] === ".") {
        i++;
        while (i < source.length && /[0-9]/.test(source[i])) i++;
      }
      tokens.push({ kind: "number", value: source.slice(start, i), pos: start });
      continue;
    }

    // 括弧・ブラケット・カンマ
    if (source[i] === "(") { tokens.push({ kind: "lparen", value: "(", pos: i }); i++; continue; }
    if (source[i] === ")") { tokens.push({ kind: "rparen", value: ")", pos: i }); i++; continue; }
    if (source[i] === "[") { tokens.push({ kind: "lbracket", value: "[", pos: i }); i++; continue; }
    if (source[i] === "]") { tokens.push({ kind: "rbracket", value: "]", pos: i }); i++; continue; }
    if (source[i] === ",") { tokens.push({ kind: "comma", value: ",", pos: i }); i++; continue; }

    // 演算子
    let matchedOp: string | null = null;
    for (const op of OPERATORS) {
      if (source.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp != null) {
      tokens.push({ kind: "op", value: matchedOp, pos: i });
      i += matchedOp.length;
      continue;
    }

    // 識別子 / キーワード (dot パス含む)
    if (/[a-zA-Z_]/.test(source[i])) {
      const start = i;
      while (i < source.length && /[a-zA-Z0-9_.]/.test(source[i])) i++;
      const word = source.slice(start, i);
      const keyword = KEYWORDS[word];
      if (keyword != null) {
        tokens.push({ kind: keyword, value: word, pos: start });
      } else {
        tokens.push({ kind: "ident", value: word, pos: start });
      }
      continue;
    }

    throw new FilterSyntaxError(source, i, `で予期しない文字 '${source[i]}'`);
  }

  tokens.push({ kind: "eof", value: "", pos: source.length });
  return tokens;
}
