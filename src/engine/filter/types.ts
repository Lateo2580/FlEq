import type { PresentationEvent } from "../presentation/types";

// ── Token ──

export type TokenKind =
  | "ident" | "string" | "number" | "boolean" | "null"
  | "op" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma"
  | "and" | "or" | "not"
  | "eof";

export interface FilterToken {
  kind: TokenKind;
  value: string;
  pos: number;
}

// ── AST ──

export type FilterAST =
  | OrNode
  | AndNode
  | NotNode
  | ComparisonNode
  | TruthyNode;

export interface OrNode {
  kind: "or";
  children: FilterAST[];
}

export interface AndNode {
  kind: "and";
  children: FilterAST[];
}

export interface NotNode {
  kind: "not";
  operand: FilterAST;
}

export interface ComparisonNode {
  kind: "comparison";
  left: ValueNode;
  op: CompOp;
  right: ValueNode;
}

export interface TruthyNode {
  kind: "truthy";
  value: ValueNode;
}

export type CompOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~" | "in" | "contains";

export type ValueNode =
  | { kind: "path"; segments: string[]; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "number"; value: number; pos: number }
  | { kind: "boolean"; value: boolean; pos: number }
  | { kind: "null"; pos: number }
  | { kind: "list"; items: ValueNode[]; pos: number };

// ── Field Registry ──

export type FilterKind =
  | "string" | "number" | "boolean"
  | "string[]" | "number[]"
  | "enum:frameLevel" | "enum:intensity" | "enum:lgInt";

export interface FilterField<T = unknown> {
  kind: FilterKind;
  aliases: string[];
  get: (event: PresentationEvent) => T | null | undefined;
  supportsOrder?: boolean;
}

// ── Compiled ──

export type FilterPredicate = (event: PresentationEvent) => boolean;
