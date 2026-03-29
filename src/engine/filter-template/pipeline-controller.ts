import { compileFilter } from "../filter/compile-filter";
import { compileTemplate } from "../template/compile-template";
import type { FilterPredicate } from "../filter/types";
import type { TemplateRenderer } from "../template/types";
import type { FilterTemplatePipeline } from "./pipeline";

/**
 * FilterTemplatePipeline の状態を管理する controller。
 * REPL はこの API 経由でのみ pipeline を変更する。
 * getPipeline() は同一オブジェクト参照を返すため、
 * message-router 側に渡した pipeline と常に同期する。
 */
export class PipelineController {
  private readonly _pipeline: FilterTemplatePipeline;
  private _filterExpr: string | null = null;
  private _templateExpr: string | null = null;
  private _focusExpr: string | null = null;

  constructor() {
    this._pipeline = { filter: null, template: null, focus: null };
  }

  /** 同一オブジェクト参照を返す。router 側と共有される。 */
  getPipeline(): FilterTemplatePipeline {
    return this._pipeline;
  }

  // --- Filter ---

  getFilterExpr(): string | null { return this._filterExpr; }

  /** フィルタ式をコンパイルして設定する。無効な式の場合は例外を投げる。 */
  setFilter(expr: string): void {
    const predicate = compileFilter(expr);
    this._pipeline.filter = predicate;
    this._filterExpr = expr;
  }

  clearFilter(): void {
    this._pipeline.filter = null;
    this._filterExpr = null;
  }

  // --- Template ---

  getTemplateExpr(): string | null { return this._templateExpr; }

  /** テンプレート式をコンパイルして設定する。 */
  setTemplate(expr: string): void {
    const renderer = compileTemplate(expr);
    this._pipeline.template = renderer;
    this._templateExpr = expr;
  }

  clearTemplate(): void {
    this._pipeline.template = null;
    this._templateExpr = null;
  }

  // --- Focus ---

  getFocusExpr(): string | null { return this._focusExpr; }

  /** フォーカス式をコンパイルして設定する。無効な式の場合は例外を投げる。 */
  setFocus(expr: string): void {
    const predicate = compileFilter(expr);
    this._pipeline.focus = predicate;
    this._focusExpr = expr;
  }

  clearFocus(): void {
    this._pipeline.focus = null;
    this._focusExpr = null;
  }

  // --- Factory ---

  /** 式文字列から PipelineController を構築する。null/undefined はスキップ。 */
  static fromExpressions(opts: {
    filter?: string | null;
    template?: string | null;
    focus?: string | null;
  }): PipelineController {
    const ctrl = new PipelineController();
    if (opts.filter != null) ctrl.setFilter(opts.filter);
    if (opts.template != null) ctrl.setTemplate(opts.template);
    if (opts.focus != null) ctrl.setFocus(opts.focus);
    return ctrl;
  }
}
