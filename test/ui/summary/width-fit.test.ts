import { describe, it, expect } from "vitest";
import { fitTokensToWidth } from "../../../src/ui/summary/width-fit";
import { visualWidth } from "../../../src/ui/formatter";
import type { SummaryToken } from "../../../src/ui/summary/types";

function tok(
  id: string,
  text: string,
  opts: Partial<SummaryToken> = {},
): SummaryToken {
  return {
    id,
    text,
    priority: 2,
    minWidth: visualWidth(opts.shortText ?? text),
    preferredWidth: visualWidth(text),
    dropMode: "drop",
    ...opts,
  };
}

describe("fitTokensToWidth", () => {
  it("幅に余裕がある場合: 全トークン表示", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[警告]", { priority: 0, dropMode: "never" }),
      tok("b", "EEW", { priority: 1, dropMode: "never" }),
      tok("c", "震度5弱", { priority: 2, dropMode: "drop" }),
      tok("d", "#3", { priority: 3, dropMode: "drop" }),
    ];
    // Total: 6+3+6+2 = 17 text + 6 sep = 23
    const result = fitTokensToWidth(tokens, 100);
    expect(result).toBe("[警告]  EEW  震度5弱  #3");
  });

  it("幅が狭い場合: drop トークンが優先度順に除去される", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[警告]", { priority: 0, dropMode: "never" }),
      tok("b", "EEW", { priority: 1, dropMode: "never" }),
      tok("c", "震度5弱", { priority: 2, dropMode: "drop" }),
      tok("d", "#3", { priority: 4, dropMode: "drop" }),
    ];
    // priority 4 の #3 が先に除去される
    // [警告](6) + EEW(3) + 震度5弱(7) + sep(4) = 20
    const result = fitTokensToWidth(tokens, 20);
    expect(result).toBe("[警告]  EEW  震度5弱");
    expect(result).not.toContain("#3");
  });

  it("さらに狭い場合: shorten が適用される", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[警告]", { priority: 0, dropMode: "never" }),
      tok("b", "緊急地震速報", { priority: 1, dropMode: "shorten", shortText: "EEW" }),
      tok("c", "震度5弱", { priority: 2, dropMode: "drop" }),
      tok("d", "東京都23区", {
        priority: 3,
        dropMode: "drop",
        shortText: "東京",
      }),
    ];
    // 全部表示: [警告](6) + 緊急地震速報(12) + 震度5弱(6) + 東京都23区(10) + sep(6) = 40
    // priority 3 drop → [警告](6) + 緊急地震速報(12) + 震度5弱(6) + sep(4) = 28
    // priority 2 drop → [警告](6) + 緊急地震速報(12) + sep(2) = 20
    // shorten → [警告](6) + EEW(3) + sep(2) = 11
    const result = fitTokensToWidth(tokens, 12);
    expect(result).toBe("[警告]  EEW");
  });

  it("priority 0 + never は常に表示される", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[緊急]", { priority: 0, dropMode: "never" }),
      tok("b", "大地震", { priority: 4, dropMode: "drop" }),
    ];
    // 幅 1 でも priority 0 は残る
    const result = fitTokensToWidth(tokens, 1);
    expect(result).toContain("[緊急]");
    expect(result).not.toContain("大地震");
  });

  it("空トークン配列は空文字列を返す", () => {
    expect(fitTokensToWidth([], 100)).toBe("");
  });

  it("shorten で shortText が未指定の場合は text を維持", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[情報]", { priority: 0, dropMode: "never" }),
      tok("b", "地震情報", { priority: 1, dropMode: "shorten" }),
    ];
    // shorten だが shortText なし → text そのまま
    const result = fitTokensToWidth(tokens, 5);
    expect(result).toContain("地震情報");
  });
});
