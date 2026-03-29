import type { FilterAST, ValueNode, CompOp } from "./types";
import { resolveField, fieldNames } from "./field-registry";
import { FilterTypeError, FilterFieldError } from "./errors";

/** AST を走査し、フィールド参照と演算子の型整合を検証する */
export function typeCheck(ast: FilterAST, source: string): void {
  switch (ast.kind) {
    case "or":
    case "and":
      for (const child of ast.children) typeCheck(child, source);
      break;
    case "not":
      typeCheck(ast.operand, source);
      break;
    case "truthy":
      validateFieldExists(ast.value);
      break;
    case "comparison":
      validateComparison(ast.left, ast.op, ast.right, source);
      break;
  }
}

function validateFieldExists(node: ValueNode): void {
  if (node.kind === "path") {
    const name = node.segments.join(".");
    const field = resolveField(name);
    if (field == null) {
      throw new FilterFieldError(name, fieldNames());
    }
  }
}

function validateComparison(left: ValueNode, op: CompOp, right: ValueNode, source: string): void {
  // パスが左辺にある場合のフィールド検証
  if (left.kind === "path") {
    const name = left.segments.join(".");
    const field = resolveField(name);
    if (field == null) {
      throw new FilterFieldError(name, fieldNames());
    }

    // enum 型に対する数値リテラルチェック
    if (field.kind === "enum:intensity" && right.kind === "number") {
      throw new FilterTypeError(
        `型が不一致: ${name} ${op} ${right.value}\n` +
        `\`${name}\` は震度文字列("1", "5-", "6+"等)で比較する。数値リテラルは使えない`
      );
    }

    if (field.kind === "enum:lgInt" && right.kind === "number") {
      throw new FilterTypeError(
        `型が不一致: ${name} ${op} ${right.value}\n` +
        `\`${name}\` は長周期階級文字列("0"〜"4")で比較する。数値リテラルは使えない`
      );
    }

    // 順序比較の型検証
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (!field.supportsOrder) {
        throw new FilterTypeError(
          `\`${name}\` (${field.kind}) は順序比較に対応していない`
        );
      }
    }

    // regex 演算子の検証
    if (op === "~" || op === "!~") {
      if (field.kind !== "string" && field.kind !== "enum:frameLevel" && field.kind !== "enum:intensity" && field.kind !== "enum:lgInt") {
        throw new FilterTypeError(`\`${name}\` (${field.kind}) は正規表現マッチに対応していない`);
      }
      if (right.kind === "string") {
        try {
          new RegExp(right.value);
        } catch {
          throw new FilterTypeError(`正規表現が不正だ: "~" の右辺 "${right.value}" を解釈できない`);
        }
        if (isRedosRisk(right.value)) {
          throw new FilterTypeError(
            `正規表現が危険だ: "${right.value}" は入れ子の量指定子を含んでおり、ReDoS の恐れがある`
          );
        }
      }
    }

    // in の検証: 右辺はリストでなければならない
    if (op === "in") {
      if (right.kind !== "list") {
        throw new FilterTypeError(`\`in\` の右辺にはリスト [...] が必要`);
      }
    }

    // contains の検証
    if (op === "contains") {
      if (field.kind !== "string[]" && field.kind !== "number[]" && field.kind !== "string") {
        throw new FilterTypeError(`\`${name}\` (${field.kind}) は contains に対応していない`);
      }
      // 右辺はリテラル (string/number) でなければならない
      if (right.kind !== "string" && right.kind !== "number") {
        throw new FilterTypeError(`\`contains\` の右辺にはリテラル (文字列または数値) が必要`);
      }
    }
  }

  // 右辺のパスも検証
  if (right.kind === "path") {
    validateFieldExists(right);
  }
}

/**
 * 入れ子の量指定子パターンを簡易検出して ReDoS リスクを判定する。
 * `(a+)+`, `(a*)*`, `(a+)*` のように、量指定子を含むグループに
 * さらに量指定子が付くケースを検出する。
 */
function isRedosRisk(pattern: string): boolean {
  // 量指定子(+, *, ?, {n,m})で終わるグループの直後に量指定子が来るパターン
  return /(\+|\*|\?|\})\)(\+|\*|\?|\{)/.test(pattern);
}
