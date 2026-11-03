import { describe, expect, it } from "vitest";

import { colorLevel } from "../../src/terminal/color";
import { createRenderer } from "../../src/terminal/format";
import { allThirteen } from "./terminal-fixture";

describe("P3-TO-T05 色の level（AC03）", () => {
  it("NO_COLOR は 0、TTY で 1・2 は 3、TTY でなければ chalk の判定のまま。色 0 の整形に ESC が無い", () => {
    const cases: [string | undefined, boolean, 0 | 1 | 2 | 3, number][] = [["1", true, 3, 0], ["", true, 2, 3], [undefined, true, 1, 3], [undefined, false, 0, 0]];
    for (const [noColor, tty, detected, expected] of cases) expect(colorLevel(noColor, tty, detected), `${noColor}/${tty}/${detected}`).toBe(expected);
    const text = createRenderer(0).render({ columns: 80, dropped: 3, units: allThirteen() });
    expect(text).toContain("（表示が間に合わなかったため、3 件の表示を省きました）");
    expect(text).not.toContain("\x1b");
  });
});
