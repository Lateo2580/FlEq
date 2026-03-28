import type { PresentationEvent } from "../presentation/types";
import type { FilterPredicate } from "../filter/types";
import type { TemplateRenderer } from "../template/types";

export interface FilterTemplatePipeline {
  filter: FilterPredicate | null;
  template: TemplateRenderer | null;
}

/** PresentationEvent にフィルタを適用する。true = 表示、false = 非表示 */
export function shouldDisplay(event: PresentationEvent, pipeline: FilterTemplatePipeline): boolean {
  if (pipeline.filter == null) return true;
  return pipeline.filter(event);
}

/** テンプレートが設定されていれば1行に変換する。null = テンプレートなし */
export function renderTemplate(event: PresentationEvent, pipeline: FilterTemplatePipeline): string | null {
  if (pipeline.template == null) return null;
  return pipeline.template(event);
}
