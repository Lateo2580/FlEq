import type { FilterPredicate } from "./types";
import { tokenize } from "./tokenizer";
import { parse } from "./parser";
import { typeCheck } from "./type-checker";
import { compile } from "./compiler";

/**
 * フィルタ式文字列を受け取り、tokenize → parse → typeCheck → compile の
 * パイプラインを通して FilterPredicate を返す公開 API。
 *
 * @throws FilterSyntaxError — 構文エラー
 * @throws FilterFieldError  — 未知フィールド
 * @throws FilterTypeError   — 型不整合
 */
export function compileFilter(expr: string): FilterPredicate {
  const tokens = tokenize(expr);
  const ast = parse(tokens, expr);
  typeCheck(ast, expr);
  return compile(ast);
}
