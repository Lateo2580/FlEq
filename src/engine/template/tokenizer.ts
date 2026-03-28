import type { TemplateToken } from "./types";

export function tokenizeTemplate(source: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let i = 0;

  while (i < source.length) {
    // {{#if ...}}
    if (source.startsWith("{{#if", i)) {
      tokens.push({ kind: "if_open", value: "{{#if", pos: i });
      i += 5;
      // 空白スキップ
      while (i < source.length && source[i] === " ") i++;
      // 条件式を "}}" まで読む
      const start = i;
      while (i < source.length && !source.startsWith("}}", i)) i++;
      tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
      if (source.startsWith("}}", i)) {
        tokens.push({ kind: "close", value: "}}", pos: i });
        i += 2;
      }
      continue;
    }

    // {{else}}
    if (source.startsWith("{{else}}", i)) {
      tokens.push({ kind: "else", value: "{{else}}", pos: i });
      i += 8;
      continue;
    }

    // {{/if}}
    if (source.startsWith("{{/if}}", i)) {
      tokens.push({ kind: "endif", value: "{{/if}}", pos: i });
      i += 7;
      continue;
    }

    // {{ interpolation }}
    if (source.startsWith("{{", i)) {
      tokens.push({ kind: "open", value: "{{", pos: i });
      i += 2;
      // interpolation 内容を解析
      while (i < source.length && !source.startsWith("}}", i)) {
        if (source[i] === "|") {
          tokens.push({ kind: "pipe", value: "|", pos: i });
          i++;
        } else if (source[i] === ":") {
          tokens.push({ kind: "colon", value: ":", pos: i });
          i++;
        } else if (source[i] === " ") {
          i++;
        } else if (source[i] === '"' || source[i] === "'") {
          // 文字列リテラル
          const quote = source[i];
          const start = i;
          i++;
          while (i < source.length && source[i] !== quote) {
            if (source[i] === "\\" && i + 1 < source.length) i++;
            i++;
          }
          if (i < source.length) i++; // 閉じ引用符
          tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
        } else {
          // 識別子/数値
          const start = i;
          while (
            i < source.length &&
            !source.startsWith("}}", i) &&
            source[i] !== "|" &&
            source[i] !== ":" &&
            source[i] !== " "
          ) {
            i++;
          }
          tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
        }
      }
      if (source.startsWith("}}", i)) {
        tokens.push({ kind: "close", value: "}}", pos: i });
        i += 2;
      }
      continue;
    }

    // テキスト
    const start = i;
    while (i < source.length && !source.startsWith("{{", i)) i++;
    tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
  }

  tokens.push({ kind: "eof", value: "", pos: source.length });
  return tokens;
}
