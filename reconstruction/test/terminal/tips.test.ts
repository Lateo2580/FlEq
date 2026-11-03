import { describe, expect, it } from "vitest";

import { TIP_CATEGORIES } from "../../src/terminal/tips-data";

// 旧築の件数は旧築の TIP_CATEGORIES を esbuild で束ねて数えた値（試験から src/tips を import すると rootDir の外になる）。
// 知識の tips（コマンドの 2 分野と、写さない tool-internals を除く 24 分野）は 2,202 件。
const REMOVED = ["history", "mode", "tablewidth", "infotext", "filter", "focus", "night", "theme", "layout", "fold", "limit", "test", "detail",
  "colors", "stats", "contract", "socket", "backup"];

describe("P3-TO-T13 tips（spec §6.4、AC12）", () => {
  it("廃止した入口を案内する文が無く、知識の tips の件数が旧築と同じ", () => {
    const entry = new RegExp(`(?<![-\\w])(${REMOVED.join("|")})(?![\\w])`);
    expect(TIP_CATEGORIES.flatMap((category) => category.tips).filter((tip) => entry.test(tip))).toEqual([]);
    expect(TIP_CATEGORIES.some((category) => category.id === "tool-internals")).toBe(false);
    const knowledge = TIP_CATEGORIES.filter((category) => !["commands-basic", "commands-advanced"].includes(category.id));
    expect([knowledge.length, knowledge.reduce((total, category) => total + category.tips.length, 0)]).toEqual([24, 2202]);
  });
});
