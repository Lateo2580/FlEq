import type { TemplateRenderer } from "./types";
import { parseTemplate } from "./parser";
import { compileTemplateNodes } from "./compiler";

/**
 * テンプレート文字列をコンパイルし、TemplateRenderer を返す。
 *
 * 使用例:
 * ```ts
 * const render = compileTemplate("{{title}} M{{magnitude|default:\"-\"}}");
 * const text = render(event);
 * ```
 */
export function compileTemplate(template: string): TemplateRenderer {
  const nodes = parseTemplate(template);
  return compileTemplateNodes(nodes);
}
