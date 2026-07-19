import { describe, it, expect } from "vitest";
import { ansiToHtml } from "./ansi-to-html";

describe("ansi-to-html", () => {
  it("プレーンテキストはそのまま (HTML エスケープ済み) 出る", () => {
    const html = ansiToHtml("hello <world> & co");
    expect(html).toContain("hello");
    expect(html).not.toContain("<world>");   // 生タグが残らない
    expect(html).toContain("&lt;world&gt;");
    expect(html).toContain("&amp;");
  });

  it("TrueColor (38;2;r;g;b) は rgb() スタイルになる", () => {
    const html = ansiToHtml("\x1b[38;2;255;0;0mRED\x1b[0m plain");
    expect(html).toContain("RED");
    expect(html).toMatch(/rgb\(255,\s*0,\s*0\)/);
    expect(html).toContain("plain");
  });

  it("ANSI escape 自体は出力に残らない", () => {
    const html = ansiToHtml("\x1b[38;2;0;128;255mblue\x1b[0m");
    expect(html).not.toContain("\x1b");
  });

  it("空文字は空を返す", () => {
    expect(ansiToHtml("")).toBe("");
  });
});
