import type {
  TemplateNode,
  TemplateExpr,
  TemplatePredicate,
  TemplateFilterCall,
  TemplateRenderer,
} from "./types";
import type { PresentationEvent } from "../presentation/types";
import { getFieldValue } from "./field-accessor";
import { applyFilter } from "./filters";

/**
 * TemplateNode[] を TemplateRenderer にコンパイルする。
 */
export function compileTemplateNodes(nodes: TemplateNode[]): TemplateRenderer {
  return (event: PresentationEvent): string => {
    return renderNodes(nodes, event);
  };
}

function renderNodes(nodes: TemplateNode[], event: PresentationEvent): string {
  let result = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        result += node.value;
        break;
      case "interpolation":
        result += renderInterpolation(node.expr, node.filters, event);
        break;
      case "if":
        result += renderIfBlock(node, event);
        break;
    }
  }
  return result;
}

function renderInterpolation(
  expr: TemplateExpr,
  filters: TemplateFilterCall[],
  event: PresentationEvent,
): string {
  let value = resolveExpr(expr, event);

  for (const filter of filters) {
    const args = filter.args.map((a) => resolveExprLiteral(a, event));
    value = applyFilter(filter.name, value, args);
  }

  return stringify(value);
}

function renderIfBlock(
  node: Extract<TemplateNode, { kind: "if" }>,
  event: PresentationEvent,
): string {
  const result = evaluatePredicate(node.test, event);
  if (result) {
    return renderNodes(node.body, event);
  }
  if (node.elseBody) {
    return renderNodes(node.elseBody, event);
  }
  return "";
}

function resolveExpr(expr: TemplateExpr, event: PresentationEvent): unknown {
  if (expr.kind === "literal") return expr.value;
  return getFieldValue(event, expr.segments);
}

function resolveExprLiteral(
  expr: TemplateExpr,
  event: PresentationEvent,
): string | number | boolean | null {
  const val = resolveExpr(expr, event);
  if (val == null) return null;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  return String(val);
}

function evaluatePredicate(
  pred: TemplatePredicate,
  event: PresentationEvent,
): boolean {
  if (pred.kind === "truthy") {
    const val = resolveExpr(pred.expr, event);
    return isTruthy(val);
  }

  const left = resolveExpr(pred.left, event);
  const right = resolveExpr(pred.right, event);

  switch (pred.op) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "ge":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "le":
      return Number(left) <= Number(right);
  }
}

function isTruthy(val: unknown): boolean {
  if (val == null) return false;
  if (val === false) return false;
  if (val === "") return false;
  if (val === 0) return false;
  return true;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
