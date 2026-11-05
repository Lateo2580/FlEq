import { describe, expect, it } from "vitest";

import { colorLevel } from "../../src/terminal/color";
import { createRenderer, width } from "../../src/terminal/format";
import { allThirteen, eewUnits, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

describe("P3-TO-T05 色の level（AC03）", () => {
  it("NO_COLOR は 0、TTY で 1・2 は 3、TTY でなければ chalk の判定のまま。色 0 の整形に ESC が無い", () => {
    const cases: [string | undefined, boolean, 0 | 1 | 2 | 3, number][] = [["1", true, 3, 0], ["", true, 2, 3], [undefined, true, 1, 3], [undefined, false, 0, 0]];
    for (const [noColor, tty, detected, expected] of cases) expect(colorLevel(noColor, tty, detected), `${noColor}/${tty}/${detected}`).toBe(expected);
    const text = createRenderer(0).render({ columns: 80, dropped: 3, units: allThirteen() });
    expect(text).toContain("（表示が間に合わなかったため、3 件の表示を省きました）");
    expect(text).not.toContain("\x1b");
  });
});

describe("P3-TL-T06 帯と縦線の色（契約境界、AC03）", () => {
  it("色 0 は帯が ━ の形で ESC も縦線も字下げも無く、色 3 でも 60 桁未満は縦線を外して本文が色 0 と同じ", () => {
    for (const unit of allThirteen()) {
      const lines = terminal(80, 0)([unit]);
      expect(lines[0]).toBe("");
      expect(lines[1].startsWith("━ ")).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b");
    }
    const [warning] = eewUnits(["37_01_01_240613_VXSE43.xml"]);
    expect(terminal(80, 0)(warning).filter((line) => line.startsWith(" "))).toEqual([]);
    expect(terminal(59, 3)(warning).map(plain).slice(2)).toEqual(terminal(59, 0)(warning).slice(2));
  });

  it("色 3 の警報の帯は幅いっぱいに朱の地で右端の空白が残り、下の行の縦線は朱の空白。注意の帯は地が無く黄の字と罫線", () => {
    const [warning] = eewUnits(["37_01_01_240613_VXSE43.xml"]);
    const lines = terminal(80, 3)(warning);
    expect(lines[1]).toContain("\x1b[48;2;213;94;0m");
    expect(plain(lines[1]).endsWith(" 発表 ")).toBe(true);
    expect(width(plain(lines[1]))).toBe(80);
    expect(lines[2].startsWith("\x1b[48;2;229;105;16m \x1b[49m ")).toBe(true);
    const caution = terminal(80, 3)([reportUnit(reportOf("32-35_04_04_240613_VXSE53.xml", "U-Q"))]);
    expect(caution[1]).not.toContain("\x1b[48;");
    expect(caution[1]).toContain("\x1b[38;2;240;228;66m");
    expect(plain(caution[1])).toMatch(/^━ .* ━+ \d\d:\d\d:\d\d 発表 ━$/);
    expect(width(plain(caution[1]))).toBe(80);
  });
});
