import type { SummaryToken } from "./types";
import { visualWidth } from "../formatter";

const SEPARATOR = "  ";
const SEPARATOR_WIDTH = 2;

export function fitTokensToWidth(
  tokens: SummaryToken[],
  maxWidth: number,
): string {
  if (tokens.length === 0) return "";

  // Step 1: Check if all tokens fit at preferred width
  const totalPreferred = tokens.reduce((sum, t) => sum + t.preferredWidth, 0);
  const separatorTotal = SEPARATOR_WIDTH * Math.max(0, tokens.length - 1);

  if (totalPreferred + separatorTotal <= maxWidth) {
    return tokens.map((t) => t.text).join(SEPARATOR);
  }

  // Step 2: Drop tokens by priority (4 → 3 → 2)
  let remaining = [...tokens];

  for (const pri of [4, 3, 2] as const) {
    const currentWidth = calcTotalWidth(remaining);
    if (currentWidth <= maxWidth) break;

    remaining = remaining.filter(
      (t) => !(t.priority === pri && t.dropMode === "drop"),
    );
  }

  // Step 3: Shorten tokens if still too wide
  if (calcTotalWidth(remaining) > maxWidth) {
    remaining = remaining.map((t) => {
      if (t.dropMode === "shorten" && t.shortText != null) {
        return { ...t, text: t.shortText };
      }
      return t;
    });
  }

  return remaining.map((t) => t.text).join(SEPARATOR);
}

function calcTotalWidth(tokens: SummaryToken[]): number {
  if (tokens.length === 0) return 0;
  const textWidth = tokens.reduce((sum, t) => sum + visualWidth(t.text), 0);
  const sepWidth = SEPARATOR_WIDTH * (tokens.length - 1);
  return textWidth + sepWidth;
}
