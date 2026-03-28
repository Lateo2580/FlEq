import type { PresentationEvent } from "../presentation/types";

// ── AST Nodes ──

export type TemplateNode =
  | TextNode
  | InterpolationNode
  | IfBlockNode;

export interface TextNode {
  kind: "text";
  value: string;
}

export interface InterpolationNode {
  kind: "interpolation";
  expr: TemplateExpr;
  filters: TemplateFilterCall[];
}

export interface IfBlockNode {
  kind: "if";
  test: TemplatePredicate;
  body: TemplateNode[];
  elseBody?: TemplateNode[];
}

// ── Expressions ──

export type TemplateExpr =
  | { kind: "path"; segments: (string | number)[] }
  | { kind: "literal"; value: string | number | boolean | null };

// ── Predicates ──

export type TemplatePredicate =
  | { kind: "truthy"; expr: TemplateExpr }
  | { kind: "compare"; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; left: TemplateExpr; right: TemplateExpr };

// ── Filter ──

export interface TemplateFilterCall {
  name: string;
  args: TemplateExpr[];
}

// ── Renderer ──

export type TemplateRenderer = (event: PresentationEvent) => string;

// ── Tokens ──

export type TemplateTokenKind =
  | "text" | "open" | "close" | "pipe" | "colon"
  | "if_open" | "else" | "endif" | "eof";

export interface TemplateToken {
  kind: TemplateTokenKind;
  value: string;
  pos: number;
}
