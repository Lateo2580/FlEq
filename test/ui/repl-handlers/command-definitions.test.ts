import { describe, expect, it } from "vitest";
import { buildCommandMap } from "../../../src/ui/repl-handlers/command-definitions";

describe("detail command definitions", () => {
  it("detail と detail tornado の help に竜巻再表示を載せる", () => {
    const detail = buildCommandMap(() => ({}) as never).detail!;

    expect(detail.description).toContain("detail tornado");
    expect(detail.detail).toContain("detail tornado: 竜巻注意情報の全対象地域を再表示");
    expect(detail.subcommands?.tornado?.description).toBe("竜巻注意情報の全対象地域を再表示");
  });
});
