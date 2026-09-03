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

describe("volcanorepair command definition", () => {
  it("公開する local operational-v2 管理操作と rest を固定する", () => {
    const command = buildCommandMap(() => ({}) as never).volcanorepair!;

    expect(command.category).toBe("operation");
    expect(Object.keys(command.subcommands ?? {})).toEqual([
      "status",
      "accept",
      "clear",
      "acknowledge-domain",
      "rest",
    ]);
    expect(command.detail).toContain("volcanorepair accept <fingerprint> <reason...>");
    expect(command.detail).toContain("volcanorepair acknowledge-domain <fingerprint> <reason...>");
  });

  // spec §14.1 #1/#7: 構文の真実源を help 側にも固定する
  it("spec §14.1: rest サブコマンドの構文を help に載せる", () => {
    const command = buildCommandMap(() => ({}) as never).volcanorepair!;

    expect(command.subcommands?.rest?.description).toContain("既定 target=vfvo50");
    expect(command.detail)
      .toContain("volcanorepair rest [vfvo50|ashfall|all] [--dry-run] --confirm <理由...>");
  });
});
