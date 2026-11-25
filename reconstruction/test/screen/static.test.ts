import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIRECTORY = join(__dirname, "../../src/display/screen");
const names = readdirSync(DIRECTORY);
const text = (name: string) => readFileSync(join(DIRECTORY, name), "utf8");
const sources = names.filter((name) => name.endsWith(".ts") || name.endsWith(".html"));

// T08 契約境界・静的検査（P4-DS-AC01・AC09・AC11）: screen/** の字を読む。
describe("P4-DS-T08 screen/** の静的検査", () => {
  it("file の名前は [a-z0-9-]+ と拡張子だけ（http-sse の 1 階層の名前で配れる）", () => {
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+\.(ts|html|json)$/);
  });

  it("HTML を解釈させる API・layout を読む API・observer・canvas・旧の経路が 0 件", () => {
    const joined = sources.map(text).join("\n");
    expect(joined).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTMLUnsafe|\son[a-z]+\s*=/);
    expect(joined).not.toMatch(/getBoundingClientRect|getClientRects|offset(Top|Left|Width|Height|Parent)|client(Top|Left|Width|Height)|scroll(Top|Left|Width|Height)|getComputedStyle/);
    expect(joined).not.toMatch(/Observer\b|canvas/i);
    expect(joined).not.toMatch(/\bDisplaySnapshot\b|chrome-eew|["'`]\/events["'`]/);
  });

  it("innerWidth・innerHeight は main.ts の 1 つの関数の中だけ、DOM の参照は main.ts だけ", () => {
    const main = text("main.ts");
    const viewport = /function readViewport\(\)[^{]*\{([^}]*)\}/.exec(main)?.[1] ?? "";
    expect(viewport).toContain("innerWidth");
    expect(main.replace(viewport, "")).not.toMatch(/innerWidth|innerHeight/);
    for (const name of sources.filter((item) => item.endsWith(".ts") && item !== "main.ts"))
      expect(text(name), name).not.toMatch(/\b(document|window|HTMLElement|EventSource|performance|setTimeout|setInterval|requestAnimationFrame)\b/);
  });

  it("CSS に px と色の字を直に書かない（値は tokens.ts から CSS の変数へ）", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(text("index.html"))?.[1] ?? "";
    expect(style.length).toBeGreaterThan(0);
    const code = style.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\d(\.\d+)?px|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
