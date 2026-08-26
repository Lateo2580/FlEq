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

  it("priority 0 + never も最終省略で幅契約を守る", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[緊急]", { priority: 0, dropMode: "never" }),
      tok("b", "大地震", { priority: 4, dropMode: "drop" }),
    ];
    // priority 0 は drop しないが、幅 1 では最終省略が優先される
    const result = fitTokensToWidth(tokens, 1);
    expect(result).toBe("…");
    expect(visualWidth(result)).toBeLessThanOrEqual(1);
    expect(result).not.toContain("大地震");
  });

  it("最終省略は OSC 8 hyperlink を閉じる", () => {
    const open = "\x1b]8;;https://example.test\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const result = fitTokensToWidth([
      tok("required", `${open}${"リンク先の長い説明".repeat(10)}${close}`, { priority: 0, dropMode: "never" }),
    ], 12);
    expect(result).toContain(close);
    expect(result.lastIndexOf(close)).toBeLessThan(result.lastIndexOf("…"));
    expect(visualWidth(result)).toBeLessThanOrEqual(12);
  });

  it("OSC 8 の params 付き開始形式も最終省略で閉じる", () => {
    const open = "\x1b]8;id=summary;https://example.test\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const result = fitTokensToWidth([
      tok("required", `${open}${"リンク先の長い説明".repeat(10)}`, { priority: 0, dropMode: "never" }),
    ], 12);
    expect(result).toContain(close);
    expect(result.lastIndexOf(close)).toBeLessThan(result.lastIndexOf("…"));
  });

  it.each([0, 1, 4, 10, 36, 40, 60, 80, 200])("任意の入力で M=%i を超えない", (maxWidth) => {
    const result = fitTokensToWidth([
      tok("required", "非常に長い必須電文名", { priority: 0, dropMode: "never" }),
      tok("invalid-short", "さらに長い補足", { priority: 1, dropMode: "shorten", shortText: "これは元より長い短縮候補" }),
      tok("drop-last", "後方の省略対象", { priority: 4, dropMode: "drop" }),
    ], maxWidth);
    expect(result).not.toMatch(/[\r\n]/);
    expect(visualWidth(result)).toBeLessThanOrEqual(maxWidth);
  });

  it("同 priority の drop は後方 token から一つずつ行う", () => {
    const result = fitTokensToWidth([
      tok("first", "先頭", { priority: 4, dropMode: "drop" }),
      tok("last", "後方", { priority: 4, dropMode: "drop" }),
    ], 4);
    expect(result).toBe("先頭");
  });

  it("実幅に余裕がある場合も token 内の CR/LF を物理 1 行へ正規化する", () => {
    const result = fitTokensToWidth([
      tok("first", "先頭\r\n次行", { priority: 0, dropMode: "never" }),
      tok("second", "後半\r末尾", { priority: 1, dropMode: "never" }),
    ], 200);
    expect(result).toBe("先頭 次行  後半 末尾");
    expect(result).not.toMatch(/[\r\n]/);
  });

  it("空トークン配列は空文字列を返す", () => {
    expect(fitTokensToWidth([], 100)).toBe("");
  });

  it("shorten で shortText が未指定でも最終幅契約を破らない", () => {
    const tokens: SummaryToken[] = [
      tok("a", "[情報]", { priority: 0, dropMode: "never" }),
      tok("b", "地震情報", { priority: 1, dropMode: "shorten" }),
    ];
    // shorten 候補が無い場合も、最終省略で契約を守る
    const result = fitTokensToWidth(tokens, 5);
    expect(visualWidth(result)).toBeLessThanOrEqual(5);
    expect(result).toBe("[情…");
  });
});
