import type { PresentationEvent } from "../../engine/presentation/types";
import { buildSummaryModel } from "./summary-model";
import { buildSummaryTokens } from "./token-builders";
import { fitTokensToWidth } from "./width-fit";

/**
 * PresentationEvent → 幅適応1行文字列を生成する。
 * @param event PresentationEvent
 * @param maxWidth 最大幅（デフォルト: ターミナル幅）
 * @returns 着色済み1行文字列
 */
export function renderSummaryLine(event: PresentationEvent, maxWidth?: number): string {
  const width = maxWidth ?? (process.stdout.columns || 80);
  const model = buildSummaryModel(event);
  const tokens = buildSummaryTokens(event, model);
  return fitTokensToWidth(tokens, width);
}
