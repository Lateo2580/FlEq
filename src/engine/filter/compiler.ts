import type { FilterAST, ValueNode, CompOp, FilterPredicate } from "./types";
import type { PresentationEvent } from "../presentation/types";
import { resolveField } from "./field-registry";
import { toFrameLevelRank, toIntensityRank, toLgIntRank } from "./rank-maps";

export function compile(ast: FilterAST): FilterPredicate {
  switch (ast.kind) {
    case "or":
      return compileOr(ast.children.map(compile));
    case "and":
      return compileAnd(ast.children.map(compile));
    case "not":
      return compileNot(compile(ast.operand));
    case "truthy":
      return compileTruthy(ast.value);
    case "comparison":
      return compileComparison(ast.left, ast.op, ast.right);
  }
}

function compileOr(predicates: FilterPredicate[]): FilterPredicate {
  return (event) => predicates.some((p) => p(event));
}

function compileAnd(predicates: FilterPredicate[]): FilterPredicate {
  return (event) => predicates.every((p) => p(event));
}

function compileNot(predicate: FilterPredicate): FilterPredicate {
  return (event) => !predicate(event);
}

function compileTruthy(node: ValueNode): FilterPredicate {
  const getter = makeGetter(node);
  return (event) => {
    const val = getter(event);
    return val != null && val !== false && val !== "" && val !== 0;
  };
}

function compileComparison(left: ValueNode, op: CompOp, right: ValueNode): FilterPredicate {
  const getLeft = makeGetter(left);
  const getRight = makeGetter(right);

  // フィールドの型情報を取得 (enum ランク変換用)
  const leftField = left.kind === "path" ? resolveField(left.segments.join(".")) : null;
  const rankFn = leftField ? getRankFn(leftField.kind) : null;

  switch (op) {
    case "=":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return l === r;
      };
    case "!=":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return l !== r;
      };
    case "<": case "<=": case ">": case ">=":
      return (event) => {
        let l = getLeft(event);
        let r = getRight(event);
        if (l == null || r == null) return false;
        if (rankFn != null) {
          l = rankFn(String(l));
          r = rankFn(String(r));
          if (l == null || r == null) return false;
        }
        return compareOrdered(l as number, op, r as number);
      };
    case "~":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return new RegExp(String(r)).test(String(l));
      };
    case "!~":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return !new RegExp(String(r)).test(String(l));
      };
    case "in":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        if (Array.isArray(r)) return r.includes(l);
        return false;
      };
    case "contains":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        if (Array.isArray(l)) return l.includes(r);
        if (typeof l === "string" && typeof r === "string") return l.includes(r);
        return false;
      };
  }
}

function makeGetter(node: ValueNode): (event: PresentationEvent) => unknown {
  switch (node.kind) {
    case "path": {
      const field = resolveField(node.segments.join("."));
      if (field == null) return () => null;
      return (event) => field.get(event);
    }
    case "string":
      return () => node.value;
    case "number":
      return () => node.value;
    case "boolean":
      return () => node.value;
    case "null":
      return () => null;
    case "list":
      return () => node.items.map((item) => {
        switch (item.kind) {
          case "string": return item.value;
          case "number": return item.value;
          case "boolean": return item.value;
          default: return null;
        }
      });
  }
}

function compareOrdered(l: number, op: string, r: number): boolean {
  switch (op) {
    case "<": return l < r;
    case "<=": return l <= r;
    case ">": return l > r;
    case ">=": return l >= r;
    default: return false;
  }
}

function getRankFn(kind: string): ((s: string) => number | null) | null {
  switch (kind) {
    case "enum:frameLevel": return toFrameLevelRank;
    case "enum:intensity": return toIntensityRank;
    case "enum:lgInt": return toLgIntRank;
    default: return null;
  }
}
