import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const TINY = join(__dirname, "tiny-codes.xlsx");

// コード表の読みはプロセスに 1 回なので、資料を向ける前に dynamic import する（T17）。
describe("xlsx reader", () => {
  // P3-RW2-T17 contractBoundary (AC07・AC15)
  it("reads the sheets by name and keeps furigana, split runs, entities and empty cells straight", async () => {
    process.env.FLEQ_JMA_CODES = TINY;
    const { choices } = await import("../../tools/telegram-gen/telegram-gen.mjs");
    expect(choices("VXSE53")).toEqual({
      places: [{ code: "997", name: "試験震央" }, { code: "998", name: "架空沖" }], // <r> の分かれがつながる・架空沖のふりがなが混ざらない
      areas: [{ code: "990", name: "試験区域" }, { code: "980", name: "架空&区域" }], // &amp; が戻る・C 列の無い行で列がずれない・"24" が sheet1.xml
    });
    expect(choices("VXSE45").areas).toEqual([{ code: "990", name: "試験区域" }]); // シート 22 に 9pp0 が在る区域だけ（D-EEW-AREAS）
    expect(choices("VXSE51").places).toEqual([]);
  });

  it("fails when the file is not a zip", () => {
    const run = spawnSync("node", ["-e", "import('./reconstruction/tools/telegram-gen/telegram-gen.mjs').then((m) => m.choices('VXSE53'))"],
      { cwd: REPO, env: { ...process.env, FLEQ_JMA_CODES: join(REPO, "package.json") }, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("not a zip file");
  });
});
