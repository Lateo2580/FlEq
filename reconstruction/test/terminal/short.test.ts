import { describe, expect, it } from "vitest";

import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { TerminalBandLevel } from "../../contracts/p3-terminal-output.types";
import { band, filled, levelFive, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

const short = (path: string, unit: RuntimeUnitId, transform?: (xml: string) => string) => {
  const report = reportOf(path, unit, transform);
  if (report.kind !== "short") throw new Error(report.kind);
  return report;
};
const print = (path: string, unit: RuntimeUnitId) => terminal()([reportUnit(short(path, unit))]);

// 期待の行の作り方: spec §5.4 の図の行に、電文の文を 80 桁で折り返した行（1 行に入る文はそのまま、入らなければ句点で分け、それでも入らなければ字の境目で折って 2 字下げ、P3-TL-AC09）。図の帯の罫線は 80 桁に伸ばした。
describe("P3-TL-T10 短い形（spec §5.4 の図、AC09）", () => {
  it("図の 4 つの報が図の行になり、帯の段は VPWW55・VXKO70 が top、VFVO50・VYSE50 が warning", () => {
    expect(print("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W")).toEqual([
      "",
      band("気象警報・注意報（大雨） 福井県", "06:51:00"),
      "【特別警報（大雨）】嶺北北部、奥越にレベル５大雨特別警報を発表しています。",
      "低い土地の浸水や河川の増水に最大級の警戒をしてください。",
      "VPWW55 ・ 福井地方気象台",
    ]);
    expect(print("16_00_01_260603_VXKO70_kozagawa_l5.xml", "U-R")).toEqual([
      "",
      band("指定河川洪水予報 古座川", "05:35:00"),
      "レベル５氾濫特別警報",
      "【警戒レベル５相当情報［洪水］】〔警戒レベル４相当から５相当に切替〕和歌山県古座",
      "  川水系古座川では、氾濫しているおそれ",
      "VXKO70 ・ 和歌山県東牟婁振興局串本建設部 和歌山地方気象台",
    ]);
    expect(print("45_01_01_200522_VFVO50.xml", "U-V")).toEqual([
      "",
      band("噴火警報・予報 浅間山", "13:03:00"),
      "レベル３（入山規制）",
      "＜浅間山に火口周辺警報（噴火警戒レベル３、入山規制）を発表＞ 　山頂火口から概ね",
      "  ４ｋｍの範囲で大きな噴石や火砕流に警戒してください 。",
      "＜噴火警戒レベルを１（活火山であることに留意）から３（入山規制）に引上げ＞",
      "VFVO50 ・ 気象庁",
    ]);
    expect(print("selected_xml/74_01_01_200512_VYSE50.xml", "U-N")).toEqual([
      "",
      band("南海トラフ地震臨時情報", "16:20:00"),
      "調査中",
      "●月●日●●時●●分頃に発生した地震と南海トラフ地震との関連性についての調査を開始しま",
      "  した。",
      "南海トラフ地震で被害が想定される地域の方は、個々の状況に応じて、身の安全を守る行",
      "  動を取ってください。",
      "VYSE50 ・ 気象庁",
    ]);
    const figures: readonly (readonly [string, RuntimeUnitId])[] = [["18_00_01_260830_VPWW55_fukui_L5.xml", "U-W"],
      ["16_00_01_260603_VXKO70_kozagawa_l5.xml", "U-R"], ["45_01_01_200522_VFVO50.xml", "U-V"], ["selected_xml/74_01_01_200512_VYSE50.xml", "U-N"]];
    expect(figures.map(([path, unit]) => short(path, unit).level)).toEqual(["top", "top", "warning", "warning"]);
  });

  it("最も重い段の帯は白の地に黒で幅いっぱいに塗り、縦線は紫。警報の段は朱の地（色 3）", () => {
    const purple = terminal(80, 3)([reportUnit(short("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W"))]);
    expect(purple[1]).toContain("\x1b[48;2;255;255;255m");
    expect(plain(purple[1])).toBe(filled("気象警報・注意報（大雨） 福井県", "06:51:00"));
    expect(purple[2].startsWith("\x1b[48;2;196;107;222m \x1b[49m ")).toBe(true);
    const warning = terminal(80, 3)([reportUnit(short("45_01_01_200522_VFVO50.xml", "U-V"))]);
    expect(warning[1]).toContain("\x1b[48;2;213;94;0m");
  });

  // Q-TO3-LEVEL の表の各行の例（警戒レベル 5・4・3・2 が top・purple・warning・caution）。段の無い行（U-L の purple・caution など）は corpus に例が無い。
  const examples: readonly (readonly [RuntimeUnitId, string, TerminalBandLevel, ((xml: string) => string)?])[] = [
    ["U-W", "18_00_01_260830_VPWW55_fukui_L5.xml", "top"], ["U-W", "15_16_02_251222_VPWW57.xml", "purple"],
    ["U-W", "15_16_04_251222_VPWW58.xml", "warning"], ["U-W", "15_16_07_250825_VPWW61.xml", "caution"],
    ["U-L", "15_16_01_241031_VPWW56.xml", "purple"], ["U-L", "18_00_01_260603_VPWW56_kagawa_release.xml", "plain"], ["U-L", "synthetic_VPWW56_cancel.xml", "cancel"],
    ["U-R", "16_00_01_260603_VXKO70_kozagawa_l5.xml", "top"], ["U-R", "16_06_01_220728_VXKO50.xml", "purple"],
    ["U-R", "16_02_01_220728_VXKO50.xml", "warning"], ["U-R", "16_01_01_220728_VXKO50.xml", "caution"],
    ["U-V", "45_01_01_200522_VFVO50.xml", "top", levelFive], ["U-V", "67_01_01_140927_VFVO56.xml", "top"], ["U-V", "45_01_01_200522_VFVO50.xml", "warning"],
    ["U-V", "44_02_01_200522_VFVO51.xml", "caution"], ["U-V", "42_02_01_071130_VZVO40.xml", "plain"], ["U-V", "43_03_01_200522_VFVO52.xml", "cancel"],
    ["U-N", "selected_xml/74_01_04_200512_VYSE50.xml", "top"], ["U-N", "selected_xml/74_01_01_200512_VYSE50.xml", "warning"],
    ["U-N", "selected_xml/74_01_07_200512_VYSE50.xml", "plain"],
    ["U-M", "19_01_01_091210_VPHW50.xml", "warning"], ["U-M", "29_01_01_140129_VPZI50.xml", "plain"], ["U-M", "32-35_09_02_220316_VXSE56.xml", "cancel"],
    ["U-B", "phase6b_VPOA50_JPDE202608201757_202608201757.xml", "purple"], ["U-B", "phase6b_VPBS50_KJPDE202608201757_202608201757.xml", "purple"],
    ["U-B", "82_01_01_260324_VPBS50.xml", "plain"],
    ["U-F", "81_01_01_260129_VPWP50.xml", "plain"], ["U-Y", "10_04_03_170913_VPTW60.xml", "plain"],
  ];
  it("AC09 (2) の表の各行の例の fixture の帯の段が表のとおり", () => {
    expect(examples.map(([unit, path, , transform]) => [unit, path, short(path, unit, transform).level])).toEqual(examples.map(([unit, path, level]) => [unit, path, level]));
  });

  it("処理できなかった報は帯と 1 行で出す（P3-TO-D-UNREADABLE、作者裁定 A）。発表時刻が無ければ受信の時刻と「受信」", () => {
    const card = { kind: "unreadable", inputId: "i", headType: "VXSE53", operation: "normal", receivedAt: new Date(2026, 10, 3, 2, 10, 30).getTime(),
      reason: "requiredStructureInvalid", title: "震源・震度に関する情報", headline: null, reportDateTimeRaw: "2026-11-03T02:10:00+09:00", rawCut: false,
      count: 1, hasRaw: true } as const;
    expect(terminal()([{ kind: "unreadable", card, prompt: null }])).toEqual(["", band("処理できなかった電文 VXSE53", "02:10:00"), "震源・震度に関する情報 を処理できませんでした。"]);
    expect(terminal()([{ kind: "unreadable", card: { ...card, title: null, reportDateTimeRaw: null }, prompt: null }])).toEqual([
      "", `━ 処理できなかった電文 VXSE53 ${"━".repeat(80 - 27 - 6 - 13)} 02:10:30 受信 ━`, "VXSE53 を処理できませんでした。"]);
  });
});
