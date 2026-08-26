import type { SummaryToken } from "./types";
import { visualWidth } from "../formatter";

const SEPARATOR = "  ";
const SEPARATOR_WIDTH = 2;

export function fitTokensToWidth(
  tokens: SummaryToken[],
  maxWidth: number,
): string {
  if (maxWidth <= 0 || tokens.length === 0) return "";
  let remaining = tokens.map((token) => ({
    ...token,
    text: normalizeSummaryTokenText(token.text),
    shortText: token.shortText == null ? undefined : normalizeSummaryTokenText(token.shortText),
  })).filter((token) => token.text !== "");

  // priority 4 → 1、同 priority は後方から一つずつ drop する。
  for (const priority of [4, 3, 2, 1] as const) {
    for (let index = remaining.length - 1; index >= 0; index--) {
      if (calcTotalWidth(remaining) <= maxWidth) return joinTokens(remaining);
      if (remaining[index].priority !== priority || remaining[index].dropMode !== "drop") continue;
      remaining = remaining.filter((_, candidateIndex) => candidateIndex !== index);
    }
  }

  // shorten も低優先から一つずつ適用し、実文字列の幅で都度再検査する。
  for (const priority of [4, 3, 2, 1, 0] as const) {
    for (let index = remaining.length - 1; index >= 0; index--) {
      if (calcTotalWidth(remaining) <= maxWidth) return joinTokens(remaining);
      const token = remaining[index];
      const shortText = token.shortText;
      if (token.priority !== priority || token.dropMode !== "shorten" || shortText == null
        || shortText === "" || visualWidth(shortText) >= visualWidth(token.text)) continue;
      remaining[index] = { ...token, text: shortText };
    }
  }

  // priority 0 を含む必須 token 群も、最後は ANSI-safe な末尾省略で必ず契約へ収める。
  return truncateToWidth(joinTokens(remaining), maxWidth);
}

function calcTotalWidth(tokens: SummaryToken[]): number {
  if (tokens.length === 0) return 0;
  const textWidth = tokens.reduce((sum, t) => sum + visualWidth(t.text), 0);
  const sepWidth = SEPARATOR_WIDTH * (tokens.length - 1);
  return textWidth + sepWidth;
}

function joinTokens(tokens: SummaryToken[]): string {
  return tokens.map((token) => token.text).join(SEPARATOR);
}

/** compact summary は必ず物理 1 行に正規化する。 */
function normalizeSummaryTokenText(text: string): string {
  return text.replace(/\r\n?|\n/g, " ");
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (visualWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return "";
  if (maxWidth === 1) return "…";

  let result = "";
  let width = 0;
  let hasSgr = false;
  let hasOpenOsc8Hyperlink = false;
  const ansiPattern = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  let offset = 0;
  const terminateSequences = (): string => {
    const hyperlinkClose = hasOpenOsc8Hyperlink ? "\x1b]8;;\x1b\\" : "";
    return hyperlinkClose + (hasSgr ? "\x1b[0m" : "");
  };
  for (const match of text.matchAll(ansiPattern)) {
    const plain = text.slice(offset, match.index);
    for (const char of plain) {
      const charWidth = visualWidth(char);
      if (width + charWidth > maxWidth - 1) return result + terminateSequences() + "…";
      result += char;
      width += charWidth;
    }
    result += match[0];
    hasSgr ||= match[0].endsWith("m");
    if (match[0].startsWith("\x1b]8;")) {
      hasOpenOsc8Hyperlink = /^\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]+(?:\x07|\x1b\\)$/.test(match[0]);
    }
    offset = (match.index ?? 0) + match[0].length;
  }
  for (const char of text.slice(offset)) {
    const charWidth = visualWidth(char);
    if (width + charWidth > maxWidth - 1) return result + terminateSequences() + "…";
    result += char;
    width += charWidth;
  }
  return result;
}
