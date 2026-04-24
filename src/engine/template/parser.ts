import type {
  TemplateNode,
  TemplateExpr,
  TemplatePredicate,
  TemplateFilterCall,
  TemplateToken,
} from "./types";
import { tokenizeTemplate } from "./tokenizer";

const MAX_DEPTH = 32;

export function parseTemplate(source: string): TemplateNode[] {
  const tokens = tokenizeTemplate(source);
  return new TemplateParser(tokens).parse();
}

class TemplateParser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: TemplateToken[]) {}

  parse(): TemplateNode[] {
    return this.parseNodes();
  }

  private parseNodes(): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.kind === "eof" || token.kind === "else" || token.kind === "endif") break;

      if (token.kind === "text" && this.peek(-1)?.kind !== "open" && this.peek(-1)?.kind !== "if_open") {
        // 外側テキスト
        nodes.push({ kind: "text", value: token.value });
        this.pos++;
        continue;
      }

      if (token.kind === "if_open") {
        nodes.push(this.parseIfBlock());
        continue;
      }

      if (token.kind === "open") {
        nodes.push(this.parseInterpolation());
        continue;
      }

      // 未消費トークンはテキストとして扱う
      nodes.push({ kind: "text", value: token.value });
      this.pos++;
    }
    return nodes;
  }

  private parseInterpolation(): TemplateNode {
    this.expect("open"); // {{
    const exprToken = this.tokens[this.pos];
    this.pos++;
    const expr = this.parseExpr(exprToken.value);
    const filters: TemplateFilterCall[] = [];

    while (this.pos < this.tokens.length && this.tokens[this.pos].kind === "pipe") {
      this.pos++; // |
      const nameToken = this.tokens[this.pos];
      this.pos++;
      const args: TemplateExpr[] = [];
      // 複数引数対応: colon が続く限り引数を読む
      while (this.pos < this.tokens.length && this.tokens[this.pos].kind === "colon") {
        this.pos++; // :
        const argToken = this.tokens[this.pos];
        this.pos++;
        args.push(this.parseExpr(argToken.value));
      }
      filters.push({ name: nameToken.value, args });
    }

    this.expect("close"); // }}
    return { kind: "interpolation", expr, filters };
  }

  private parseIfBlock(): TemplateNode {
    this.expect("if_open"); // {{#if
    const condToken = this.tokens[this.pos];
    this.pos++;
    const test = this.parsePredicate(condToken.value);
    this.expect("close"); // }}

    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new Error(`テンプレート構文エラー: #if のネストが深すぎる (最大 ${MAX_DEPTH} 段)`);
    }
    const body = this.parseNodes();
    let elseBody: TemplateNode[] | undefined;

    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === "else") {
      this.pos++; // {{else}}
      elseBody = this.parseNodes();
    }

    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === "endif") {
      this.pos++; // {{/if}}
    } else {
      this.depth--;
      throw new Error('テンプレート構文エラー: "endif" が必要ですが見つかりません。{{/if}} で閉じてください');
    }

    this.depth--;
    return { kind: "if", test, body, elseBody };
  }

  private parseExpr(raw: string): TemplateExpr {
    const trimmed = raw.trim();

    // 文字列リテラル
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return { kind: "literal", value: unescapeString(trimmed.slice(1, -1)) };
    }
    // 数値
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: "literal", value: Number(trimmed) };
    }
    // boolean / null
    if (trimmed === "true") return { kind: "literal", value: true };
    if (trimmed === "false") return { kind: "literal", value: false };
    if (trimmed === "null") return { kind: "literal", value: null };

    // パス: dot + bracket 記法を (string | number)[] に分割
    return { kind: "path", segments: parsePathSegments(trimmed) };
  }

  private parsePredicate(raw: string): TemplatePredicate {
    const trimmed = raw.trim();
    // 簡易比較: "field op value" 形式
    const cmpMatch = trimmed.match(/^(\S+)\s+(=|!=|>|>=|<|<=)\s+(.+)$/);
    if (cmpMatch) {
      const opMap: Record<string, "eq" | "ne" | "gt" | "ge" | "lt" | "le"> = {
        "=": "eq", "!=": "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le",
      };
      return {
        kind: "compare",
        op: opMap[cmpMatch[2]],
        left: this.parseExpr(cmpMatch[1]),
        right: this.parseExpr(cmpMatch[3]),
      };
    }
    // truthy
    return { kind: "truthy", expr: this.parseExpr(trimmed) };
  }

  private expect(kind: string): void {
    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === kind) {
      this.pos++;
      return;
    }
    const actual = this.pos < this.tokens.length ? this.tokens[this.pos].kind : "eof";
    throw new Error(`テンプレート構文エラー: "${kind}" が必要ですが "${actual}" が見つかりました`);
  }

  private peek(offset: number): TemplateToken | undefined {
    return this.tokens[this.pos + offset];
  }
}

/**
 * ドットパスを segments 配列に分割する。
 * 例: "foo.bar.baz" → ["foo", "bar", "baz"]
 *
 * 表示専用ポリシー (dmdata.jp 再配信ポリシー対応) のため、以下を禁止する:
 * - ブラケット記法 `[N]` (配列インデックス参照)
 * - 先頭セグメントが `raw` のパス (生 XML データへの直接参照)
 */
function parsePathSegments(path: string): string[] {
  const segments: string[] = [];
  let i = 0;

  while (i < path.length) {
    if (path[i] === ".") {
      i++; // ドット区切りをスキップ
      continue;
    }

    if (path[i] === "[") {
      throw new Error(
        `テンプレート構文エラー: 配列インデックス参照 [N] は無効です (path: "${path}")。表示専用制限により、要素を1行に並べる機械可読出力を防いでいます。`,
      );
    }

    // 識別子: 次の . または [ まで
    const start = i;
    while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
    segments.push(path.slice(start, i));
  }

  if (segments[0] === "raw") {
    throw new Error(
      `テンプレート構文エラー: raw フィールド参照は無効です (path: "${path}")。表示専用制限により、生 XML データへの直接アクセスを禁止しています。`,
    );
  }

  return segments;
}

/** 文字列リテラル内のエスケープシーケンスを復元する */
function unescapeString(s: string): string {
  return s.replace(/\\(["'\\nt])/g, (_, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      default: return ch; // \\, \", \'
    }
  });
}
