import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleLayout } from "../../src/ui/repl-handlers/settings-handlers";
import type { ReplContext } from "../../src/ui/repl-handlers/types";
import * as displayLayoutModule from "../../src/ui/display-layout";

// handleLayout は ctx.rl を reset 確認プロンプトでのみ使う。他サブコマンドは ctx 非依存。
const ctx = { rl: null, buildPromptString: () => "> " } as unknown as ReplContext;

describe("REPL layout コマンド", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("layout (引数なし) で概要が表示される", () => {
    handleLayout(ctx, "");
    const out = logs.join("\n");
    expect(out).toContain("display-layout.json");
    expect(out).toContain("table");   // 現在の body 順が出る
  });

  it("layout path でパスが表示される", () => {
    handleLayout(ctx, "path");
    expect(logs.join("\n")).toContain("display-layout.json");
  });

  it("layout validate で検証結果が表示される", () => {
    handleLayout(ctx, "validate");
    const out = logs.join("\n");
    // ファイル無し環境では「見つかりません (デフォルト設定を使用中)」の警告が出る
    expect(out.length).toBeGreaterThan(0);
  });

  it("layout reload で再読込結果が表示される", () => {
    handleLayout(ctx, "reload");
    const out = logs.join("\n");
    expect(out).toMatch(/再読込|デフォルト/);
  });

  it("不明なサブコマンドで使い方が表示される", () => {
    handleLayout(ctx, "nosuch");
    expect(logs.join("\n")).toContain("使い方");
  });

  it("layout reset で y と答えるとデフォルトを書き出す", () => {
    const resetSpy = vi.spyOn(displayLayoutModule, "resetDisplayLayout")
      .mockReturnValue({ errors: [], warnings: [] });
    let questionCb: ((answer: string) => void) | null = null;
    const rl = {
      question: (_q: string, cb: (answer: string) => void) => { questionCb = cb; },
      setPrompt: vi.fn(),
      prompt: vi.fn(),
    };
    const rlCtx = { rl, buildPromptString: () => "> " } as unknown as ReplContext;
    handleLayout(rlCtx, "reset");
    expect(questionCb).not.toBeNull();
    questionCb!("y");
    expect(resetSpy).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("書き出しました");
    expect(rl.prompt).toHaveBeenCalled();
  });

  it("layout reset で N と答えるとキャンセルされる", () => {
    const resetSpy = vi.spyOn(displayLayoutModule, "resetDisplayLayout")
      .mockReturnValue({ errors: [], warnings: [] });
    let questionCb: ((answer: string) => void) | null = null;
    const rl = {
      question: (_q: string, cb: (answer: string) => void) => { questionCb = cb; },
      setPrompt: vi.fn(),
      prompt: vi.fn(),
    };
    const rlCtx = { rl, buildPromptString: () => "> " } as unknown as ReplContext;
    handleLayout(rlCtx, "reset");
    questionCb!("n");
    expect(resetSpy).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("キャンセル");
    expect(rl.prompt).toHaveBeenCalled();
  });
});
