import { describe, expect, it } from "vitest";
import { replaceCssSpringBlock, writeGenerated } from "../../../../scripts/generate-springs.mjs";

const START = "/* GENERATED:springs:start (generate-springs.mjs --write) */";
const END = "/* GENERATED:springs:end */";

describe("generate-springs 書込み安全性", () => {
  it("マーカー欠損ではどちらの出力にも書き込まない", () => {
    let cssWrites = 0;
    let motionWrites = 0;
    expect(() => writeGenerated({
      readCss: () => ":root { --x: 1; }",
      writeCss: () => { cssWrites++; },
      writeMotion: () => { motionWrites++; },
    })).toThrow("GENERATED:springs");
    expect(cssWrites).toBe(0);
    expect(motionWrites).toBe(0);
  });

  it("有効なマーカー区間だけを生成値へ置き換える", () => {
    const css = `:root {\n${START}\n  old\n  ${END}\n}`;
    const next = replaceCssSpringBlock(css);
    expect(next).toContain(START);
    expect(next).toContain(END);
    expect(next).not.toContain("old");
  });
});
