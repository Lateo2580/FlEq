import { expect } from "vitest";

/**
 * 枠・改行・継続行の字下げだけを除き、折返した可変値が欠落していないことを確認する。
 * title/type の 2 行上限による意図的な省略には使わない。
 */
export function expectCompleteWrappedValue(rendered: string, value: string, context: string): void {
  const compact = (text: string): string => text
    .replace(/[┌┐└┘├┤│╔╗╚╝╠╣]/gu, "")
    .replace(/\s/gu, "");
  expect(compact(rendered), `${context} value=${JSON.stringify(value)}`).toContain(compact(value));
}
