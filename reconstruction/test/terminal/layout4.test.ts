import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { reduceWeatherCurrentUnit } from "../../src/units/weather-current/weather-current-unit";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { createEewLog } from "../../src/terminal/eew-log";
import { inputTerminal } from "../../src/terminal/material";
import { eewUnits, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-004 の試験。期待の字は docs/specs/cli-terminal-output.md §5.4 の噴火速報の図と §7 の EEW ログ。
const FLASH = "67_01_01_140927_VFVO56.xml", MODAL = "67_01_02_140927_VFVO56.xml";
const flat = (path: string, columns: number, transform?: (xml: string) => string): string[] =>
  terminal(columns)([reportUnit(reportOf(path, "U-V", transform))]);
const TOWNS = /<Areas codeType="気象・地震・火山情報／市町村等">[\s\S]*?<\/Areas>/;
const withTowns = (count: number) => (xml: string): string => xml.replace(TOWNS,
  `<Areas codeType="気象・地震・火山情報／市町村等">${Array.from({ length: count }, (_, i) => `<Area><Name>町${i}</Name><Code>${i}</Code></Area>`).join("")}</Areas>`);

describe("P3-TL4-T03 噴火速報の活動の文と対象の市町村", () => {
  it("67_01_01 は spec の図の行になる", () => {
    expect(flat(FLASH, 100).slice(2)).toEqual([
      "＜御嶽山で噴火が発生＞", "御嶽山で、平成２６年９月２７日１１時５３分頃、噴火が発生しました。", "─".repeat(100),
      "対象の市町村  長野県王滝村　長野県木曽町　岐阜県高山市　岐阜県下呂市", "VFVO56 ・ 気象庁"]);
  });
  it("67_01_02 は「噴火が発生したもよう。」が出て字下げの空白が残らない", () => {
    const text = flat(MODAL, 80).join("\n");
    expect(text).toContain("御嶽山で、平成２６年９月２７日１１時５３分頃、噴火が発生したもよう。");
    expect(text).not.toMatch(/^\s+御嶽山で、/m);
  });
  it("56 桁では市町村が折り返し、折り返した行にも左の列が出る", () => {
    const lines = flat(FLASH, 56, withTowns(12));
    const at = lines.findIndex((row) => row.startsWith("対象の市町村"));
    const table = lines.slice(at, lines.indexOf("VFVO56 ・ 気象庁"));
    expect(table.length).toBeGreaterThan(1);
    expect(table.every((row) => row.startsWith("対象の市町村  "))).toBe(true);
  });
});

describe("P3-TL4-T04 噴火速報の境界", () => {
  const shownTowns = (xml: (value: string) => string) => flat(FLASH, 100, xml).join("\n");
  it("InfoType を取消にした報は電文に活動の文と市町村があっても足さない", () => {
    const report = reportOf(FLASH, "U-V", (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"));
    expect(report.kind === "short" ? [report.level, report.flash] : report.kind).toEqual(["cancel", null]);
    expect(shownTowns((xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"))).not.toMatch(/噴火が発生しました|対象の市町村/);
  });
  it("市町村の Area が 256 件なら「ほか」の行が無く、257 件なら「ほか 1 市町村」が出る", () => {
    expect(shownTowns(withTowns(256))).not.toContain("ほか");
    expect(shownTowns(withTowns(257))).toContain("ほか 1 市町村");
  });
  it("活動の文の無い報に文の行が無く、市町村の無い報に表が無い", () => {
    const text = shownTowns((xml) => xml.replace(/<VolcanoActivity>[\s\S]*?<\/VolcanoActivity>/, "").replace(TOWNS, ""));
    expect(text).toContain("＜御嶽山で噴火が発生＞");
    expect(text).not.toMatch(/噴火が発生しました|対象の市町村/);
  });
});

describe("P3-TL4-T05 EEW ログの仮定の震源", () => {
  // 77_01_01（確定）→ 77_01_03 を仮定の震源にしたもの（Condition を足す）→ 77_01_05（確定。M も深さも 77_01_03 と違う）。
  const assumed = (xml: string): string => xml.replace("</ArrivalTime>", "</ArrivalTime><Condition>仮定震源要素</Condition>");
  async function logged(inputs: Parameters<typeof eewUnits>[0]): Promise<string> {
    let out = "";
    const log = createEewLog({ directory: "unused", enabled: true, fields: {}, clock: () => ({ wallTimeMs: 0, monotonicMs: 0 }), append: async (_path, data) => { out += data; } });
    for (const unit of eewUnits(inputs).flat()) if (unit.kind === "eew") log.record(unit.subject);
    await log.close();
    return out;
  }
  it("確定・仮定・確定の 3 報で、3 報目の変化の行に M と深さの変化が無く、最大予測震度の変化は残る（1 報目の値と比べない）", async () => {
    const text = await logged(["77_01_01_240613_VXSE45.xml", { path: "77_01_03_240613_VXSE45.xml", transform: assumed }, "77_01_05_240613_VXSE45.xml"]);
    const changes = text.split("\n").filter((row) => row.startsWith("変化:"));
    expect(changes).toEqual(["変化:  [震度4→5-]"]);
  });
});

describe("P3-TL4-T06 VPNO50 の報知", () => {
  const decode = (name: string, headType: string): DecodedMaterial => {
    const entered = ingestXmlData({ inputId: name, inputSequence: 1, receivedAt: 1_800_000_000_000, origin: "replay", kind: "replay",
      body: Buffer.from(readFileSync(`test/fixtures/${name}.xml`, "utf8")), headType });
    if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
    const decoded = decodeMaterial(entered.item);
    if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
    return decoded.material;
  };
  // U-W が採った報として通す（owner の publisher の outcome の代わり）。
  const taken = [{ unit: "U-W" as const, outcome: { kind: "accepted" as const, change: "semantic" as const, subjects: [] } }];
  it("発表の報も切替の報も、U-W が採っても端末に出ない。同じ outcome で VPWW の報は出る。切替の報は U-W の state を今までどおり変える", () => {
    expect(inputTerminal({ kind: "decoded", material: decode("18_00_01_260830_VPWW55_fukui_L5", "VPWW55") }, taken)).not.toBeNull();
    for (const name of ["18_00_01_260830_VPNO50_issue", "18_00_01_260830_VPNO50_switch"]) {
      expect(inputTerminal({ kind: "decoded", material: decode(name, "VPNO50") }, taken)).toBeNull();
    }
    const step = reduceWeatherCurrentUnit(initialUnits["U-W"], { kind: "receive", material: decode("18_00_01_260830_VPNO50_switch", "VPNO50"),
      clock: { wallTimeMs: 1_800_000_000_000, monotonicMs: 0 } });
    expect(step.decisions[0].decision).toBe("changed");
  });
});
