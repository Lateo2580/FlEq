import type { FilterToken, FilterAST, ValueNode, CompOp } from "./types";
import { FilterSyntaxError } from "./errors";

const MAX_DEPTH = 32;

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly tokens: FilterToken[],
    private readonly source: string,
  ) {}

  parse(): FilterAST {
    const ast = this.parseOr();
    if (this.current().kind !== "eof") {
      throw new FilterSyntaxError(this.source, this.current().pos, "で予期しないトークン");
    }
    return ast;
  }

  private parseOr(): FilterAST {
    const children: FilterAST[] = [this.parseAnd()];
    while (this.current().kind === "or") {
      this.advance();
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  private parseAnd(): FilterAST {
    const children: FilterAST[] = [this.parseUnary()];
    while (this.current().kind === "and") {
      this.advance();
      children.push(this.parseUnary());
    }
    return children.length === 1 ? children[0] : { kind: "and", children };
  }

  private parseUnary(): FilterAST {
    if (this.current().kind === "not") {
      this.advance();
      this.enterDepth();
      const operand = this.parseUnary();
      this.leaveDepth();
      return { kind: "not", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterAST {
    if (this.current().kind === "lparen") {
      this.advance();
      this.enterDepth();
      const expr = this.parseOr();
      this.leaveDepth();
      this.expect("rparen", "で閉じ括弧 ')' が必要");
      return expr;
    }

    const left = this.parseValue();
    const op = this.tryCompOp();
    if (op == null) {
      return { kind: "truthy", value: left };
    }
    const right = this.parseValue();
    return { kind: "comparison", left, op, right };
  }

  private parseValue(): ValueNode {
    const token = this.current();
    switch (token.kind) {
      case "ident":
        this.advance();
        return { kind: "path", segments: token.value.split("."), pos: token.pos };
      case "string":
        this.advance();
        return { kind: "string", value: token.value, pos: token.pos };
      case "number":
        this.advance();
        return { kind: "number", value: Number(token.value), pos: token.pos };
      case "boolean":
        this.advance();
        return { kind: "boolean", value: token.value === "true", pos: token.pos };
      case "null":
        this.advance();
        return { kind: "null", pos: token.pos };
      case "lbracket":
        return this.parseList();
      default:
        throw new FilterSyntaxError(this.source, token.pos, "で値が必要");
    }
  }

  private parseList(): ValueNode {
    const start = this.current().pos;
    this.expect("lbracket", "で '[' が必要");
    const items: ValueNode[] = [];
    while (this.current().kind !== "rbracket") {
      if (items.length > 0) {
        this.expect("comma", "で ',' が必要");
      }
      items.push(this.parseValue());
    }
    this.expect("rbracket", "で ']' が必要");
    return { kind: "list", items, pos: start };
  }

  private tryCompOp(): CompOp | null {
    const token = this.current();
    if (token.kind === "op") {
      this.advance();
      return token.value as CompOp;
    }
    return null;
  }

  private current(): FilterToken {
    return this.tokens[this.pos];
  }

  private advance(): FilterToken {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  private expect(kind: string, errorMsg: string): void {
    if (this.current().kind !== kind) {
      throw new FilterSyntaxError(this.source, this.current().pos, errorMsg);
    }
    this.advance();
  }

  private enterDepth(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new FilterSyntaxError(
        this.source,
        this.current().pos,
        `でネストが深すぎる (最大 ${MAX_DEPTH} 段)`,
      );
    }
  }

  private leaveDepth(): void {
    this.depth--;
  }
}

export function parse(tokens: FilterToken[], source: string): FilterAST {
  return new Parser(tokens, source).parse();
}
