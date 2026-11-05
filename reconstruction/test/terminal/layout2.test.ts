import { describe, expect, it } from "vitest";

import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import { painter } from "../../src/terminal/color";
import type { Role } from "../../src/terminal/color";
import type { TerminalUnit } from "../../src/terminal/format";
import { createRenderer, width } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { decodeFixture, eewUnits, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-002（Q-TO3-*）の試験。期待の字は docs/specs/cli-terminal-output.md の §3〜§5 の図と表。
const unitOf = (path: string, unit: RuntimeUnitId, transform?: (xml: string) => string): TerminalUnit => {
  const report = terminalReport(decodeFixture(path, "replay", transform), unit);
  if (report == null) throw new Error(path);
  return reportUnit(report);
};
const seven = (xml: string) => xml.replace(/<MaxInt>[^<]*<\/MaxInt>/g, "<MaxInt>7</MaxInt>");
// 帯の地の色（色 3 の帯の行から読む）。白 255・紫 178,58,178・朱 213,94,0・地なし。
const BG = { top: "48;2;255;255;255m", purple: "48;2;178;58;178m", warning: "48;2;213;94;0m" } as const;
const bandOf = (units: readonly TerminalUnit[]): string => {
  const line = terminal(80, 3)(units)[1];
  return (Object.keys(BG) as (keyof typeof BG)[]).find((key) => line.includes(BG[key])) ?? (line.includes("38;2;240;228;66m") ? "caution" : "plain");
};
const eewWith = (path: string, from: string, to: string) => ({ path, transform: (xml: string) => xml.replace(/<From>5-<\/From><To>5-<\/To>/g, `<From>${from}</From><To>${to}</To>`) });

describe("P3-TL2-T01 段と帯", () => {
  it("最も重い段は大津波警報・震度 7・最大予測震度に 7 を含む EEW・特別警報・噴火警戒レベル 5・巨大地震警戒で、縦線は紫、色 0 は全部 ━", () => {
    const rows: readonly (readonly [string, TerminalUnit, string])[] = [
      ["大津波警報", unitOf("32-39_11_02_250206_VTSE41.xml", "U-T"), "top"],
      ["震度 7", unitOf("32-35_01_03_240613_VXSE53.xml", "U-Q", seven), "top"],
      ["震度 5 弱", unitOf("32-35_01_03_240613_VXSE53.xml", "U-Q"), "warning"],
      ["特別警報", unitOf("15_17_01_251222_VPWW55.xml", "U-W"), "warning"],
      ["特別警報 L5", unitOf("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W"), "top"],
      ["L4 の特別警報の格下げ", unitOf("18_00_01_260830_VPWW55_fukui_downgrade.xml", "U-W"), "purple"],
      ["L3 の警報", unitOf("15_16_04_251222_VPWW58.xml", "U-W"), "warning"],
      ["注意報（レベルなし）", unitOf("15_16_07_250825_VPWW61.xml", "U-W"), "caution"],
      ["洪水 L5", unitOf("16_00_01_260603_VXKO70_kozagawa_l5.xml", "U-R"), "top"],
      ["噴火警戒レベル 5", unitOf("44_01_01_151008_VFVO51.xml", "U-V"), "top"],
      ["噴火警戒レベル 3", unitOf("45_01_01_200522_VFVO50.xml", "U-V"), "warning"],
      ["巨大地震警戒", unitOf("selected_xml/74_01_04_200512_VYSE50.xml", "U-N"), "top"],
      ["記録的短時間大雨", unitOf("phase6b_VPOA50_JPDE202608201757_202608201757.xml", "U-B"), "purple"],
      ["竜巻注意", unitOf("19_01_01_091210_VPHW50.xml", "U-M"), "warning"],
    ];
    for (const [name, unit, expected] of rows) {
      expect(bandOf([unit]), name).toBe(expected);
      expect(terminal(80, 0)([unit])[1].startsWith("━ "), `${name} 色 0`).toBe(true);
    }
    // 最も重い段の縦線は #c46bde。
    for (const index of [0, 1, 4]) expect(terminal(80, 3)([rows[index][1]])[2].startsWith("\x1b[48;2;196;107;222m \x1b[49m "), rows[index][0]).toBe(true);
  });

  it("EEW は最大予測震度に 7 を含む 3 つの形（7、7程度以上、6強〜7）が最も重い段で、6強程度以上は警報の段のまま", () => {
    const band = (from: string, to: string) => bandOf(eewUnits([eewWith("37_01_01_240613_VXSE43.xml", from, to)])[0]);
    expect([band("7", "7"), band("7", "over"), band("6+", "7"), band("6+", "over")]).toEqual(["top", "top", "top", "warning"]);
  });
});

describe("P3-TL2-T02 字と縦線の色", () => {
  // WCAG の相対輝度（暗算でなく実計算、色は painter が実際に出す escape から読む）。
  const rgb = (code: string, text: string): readonly [number, number, number] => {
    const found = new RegExp(`\\x1b\\[${code};2;(\\d+);(\\d+);(\\d+)m`).exec(painter(3)(text as Role, "x"));
    if (found == null) throw new Error(text);
    return [Number(found[1]), Number(found[2]), Number(found[3])];
  };
  const luminance = ([red, green, blue]: readonly number[]) => {
    const [r, g, b] = [red, green, blue].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (one: readonly number[], two: readonly number[]) => {
    const [high, low] = [luminance(one), luminance(two)].sort((left, right) => right - left);
    return (high + 0.05) / (low + 0.05);
  };
  const NIGHTFOX = [0x19, 0x23, 0x30];
  it("字と縦線は Nightfox の地と 4.5 以上、帯の面は 3 以上、面の上の字は 4.5 以上", () => {
    for (const role of ["int3", "int6Lower", "ruleWarning", "arrived", "rulePurple"] as const) expect(contrast(rgb("38", role), NIGHTFOX), role).toBeGreaterThanOrEqual(4.5);
    for (const role of ["barWarning", "barPurple"] as const) expect(contrast(rgb("48", role), NIGHTFOX), role).toBeGreaterThanOrEqual(4.5);
    for (const role of ["bandTop", "bandWarning", "bandPurple"] as const) {
      expect(contrast(rgb("48", role), NIGHTFOX), role).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb("48", role), rgb("38", role)), `${role} の字`).toBeGreaterThanOrEqual(4.5);
    }
    expect(rgb("38", "int3")).toEqual([0x31, 0x93, 0xdb]);
    expect(rgb("38", "int6Lower")).toEqual([0xe5, 0x69, 0x10]);
    expect(rgb("48", "int6Upper")).toEqual([0xd5, 0x5e, 0x00]);
  });

  it("震度 7 の塗りは色 3 で前後に空白を足した 3 桁、色 0 で 1 桁。要点の最大の行と表の両方", () => {
    const unit = unitOf("32-35_01_03_240613_VXSE53.xml", "U-Q", seven);
    const colored = terminal(80, 3)([unit]).map(plain), colorless = terminal(80, 0)([unit]);
    expect(colored.some((line) => line.startsWith("  最大震度  7 ") && !line.includes("最大震度 7"))).toBe(true);
    expect(colored.some((line) => line.startsWith("   7      静岡県伊豆"))).toBe(true);
    expect(colorless.some((line) => line.startsWith("最大震度 7  "))).toBe(true);
    expect(colorless.some((line) => line.startsWith("7       "))).toBe(true);
    expect(colored.every((line) => line.length <= 80)).toBe(true);
  });
});

describe("P3-TL2-T03 確かさ", () => {
  it("「到達済み」を出さず「到達と推測」と書く。震源の無い震度速報に「調査中」が無い", () => {
    const lines = terminal()(eewUnits(["77_01_04_240613_VXSE45.xml"])[0]);
    expect(lines.some((line) => line.includes("到達済み"))).toBe(false);
    expect(lines.some((line) => line.includes("到達と推測"))).toBe(true);
    expect(terminal()([unitOf("32-35_07_01_100915_VXSE51.xml", "U-Q")]).some((line) => line.includes("調査中"))).toBe(false);
  });

  it("56 桁の 32-39_11_11 は見出しが「予想」で、1 地域 1 行のまま（地域の行と値の行に割れない）", () => {
    const lines = terminal(56, 0)([unitOf("32-39_11_11_250206_VTSE41.xml", "U-T")]);
    expect(lines.some((line) => /^区分 +地域 +予想 +到達$/.test(line.trim()))).toBe(true);
    expect(lines.some((line) => /^区分 .*高さ/.test(line))).toBe(false);
    expect(lines.filter((line) => line.trim() === "地域")).toEqual([]);
  });
});

describe("P3-TL2-T04 行動の文", () => {
  it("警報の EEW は要点に太字で出て、文の無い報には出ない。VTSE51 は補足に太字で出る", () => {
    const [warned] = eewUnits(["37_01_01_240613_VXSE43.xml"]);
    const colored = terminal(80, 3)(warned);
    expect(colored.some((line) => line.includes("\x1b[1m強い揺れに警戒してください。"))).toBe(true);
    expect(colored.map(plain).slice(2, 6).some((line) => line.includes("強い揺れに警戒してください。"))).toBe(true);
    expect(terminal()(eewUnits(["77_01_03_240613_VXSE45.xml"])[0]).some((line) => line.includes("警戒してください"))).toBe(false);
    const tide = terminal(80, 3)([unitOf("32-39_11_03_250206_VTSE51.xml", "U-T")]);
    expect(tide.some((line) => line.includes("\x1b[1m津波と満潮が重なると"))).toBe(true);
  });
});

describe("P3-TL2-T05 場所の再掲", () => {
  it("32-39_11_11 の末尾（100 桁で 40 行）に大津波警報の地域名と避難の文があり、56 桁では入らない地域が「ほか n 地域」になる", () => {
    const unit = unitOf("32-39_11_11_250206_VTSE41.xml", "U-T");
    const tail = terminal(100, 0)([unit]).slice(-40);
    expect(tail.some((line) => /^大津波警報 6地域  青森県太平洋沿岸/.test(line))).toBe(true);
    expect(tail.some((line) => /避難.*（\d\d:\d\d:\d\d 発表）/.test(line))).toBe(true);
    expect(terminal(56, 0)([unit]).some((line) => /^大津波警報 6地域  .*ほか \d+ 地域$/.test(line))).toBe(true);
  });
});

describe("P3-TL2-T06 折り返し", () => {
  it("56 桁の 77_01_05 の震源の行は「 ・ 」の境で折り、折り目に「 ・ 」が無く続きが 2 字下がり、「長周期階級」は 1 行の中", () => {
    const print = terminal(56, 0);
    const [fourth, fifth] = eewUnits(["77_01_04_240613_VXSE45.xml", "77_01_05_240613_VXSE45.xml"]);
    print(fourth);
    const lines = print(fifth), at = lines.findIndex((line) => line.startsWith("震源:"));
    expect(lines[at].endsWith(" ・")).toBe(false);
    expect(lines[at + 1].startsWith("  長周期階級 1")).toBe(true);
    expect(lines[at]).toContain("深さ30km");
  });

  it("40〜64 桁の震源の行は幅を越えず、「長周期階級 1」は 1 行の中にある（区切りの幅は ・ を 2 桁で数える）", () => {
    for (let columns = 40; columns <= 64; columns += 1) {
      const print = terminal(columns, 0);
      const [fourth, fifth] = eewUnits(["77_01_04_240613_VXSE45.xml", "77_01_05_240613_VXSE45.xml"]);
      print(fourth);
      const lines = print(fifth);
      expect(lines.filter((line) => width(line) > columns), `${columns}`).toEqual([]);
      expect(lines.some((line) => line.includes("長周期階級 1")), `${columns}`).toBe(true);
      expect(lines.some((line) => line.includes("深さ30km →  40km")), `${columns}`).toBe(true);
    }
  });
  it("56 桁の震度と階級の一覧は折り返した行にも段の字が出る。満潮は折り返した行にも付く", () => {
    const quake = terminal(56, 0)([unitOf("32-35_01_03_240613_VXSE53.xml", "U-Q")]);
    expect(quake.filter((line) => line.startsWith("3 ")).length).toBeGreaterThanOrEqual(2);
    expect(quake.filter((line) => /^ +\S/.test(line) && !line.startsWith("  ")).length).toBe(0);
    const lg = terminal(56, 0)([unitOf("selected_xml/78_01_01_240613_VXSE62.xml", "U-Q")]);
    expect(lg.filter((line) => line.startsWith("階級1 ")).length).toBeGreaterThanOrEqual(2);
    const tide = terminal(80, 0)([unitOf("32-39_11_03_250206_VTSE51.xml", "U-T")]);
    const from = tide.indexOf("満潮時刻"), rows = tide.slice(from + 1, tide.indexOf(tide.slice(from).find((line) => line.startsWith("─"))!, from));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((line) => line.includes("満潮 "))).toBe(true);
  });
});

describe("P3-TL2-T07 発表より前の到達予想時刻", () => {
  it("77_01_26 の発表時刻（23:15:38）より前の到達予想時刻だけが警報の字になる", () => {
    const rows = terminal(80, 3)(eewUnits(["77_01_26_240613_VXSE45.xml"])[0]).filter((line) => /\d\d:\d\d:\d\d {2,}/.test(plain(line)) && !plain(line).includes("発表"));
    const early = rows.filter((line) => { const time = /(\d\d:\d\d:\d\d)/.exec(plain(line))![1]; return time < "23:15:38"; });
    expect(early.length).toBeGreaterThan(0);
    expect(early.every((line) => line.includes("\x1b[38;2;229;105;16m"))).toBe(true);
    expect(rows.filter((line) => !early.includes(line)).some((line) => line.includes("\x1b[38;2;229;105;16m"))).toBe(false);
  });
});

describe("P3-TL2-T08 段の理由", () => {
  const second = (path: string, unit: RuntimeUnitId) => terminal()([unitOf(path, unit)])[2];
  it("警報以上の VFVO51・VFVO50・VXKO70・VYSE50 に Kind か InfoSerial の名前が 1 行出る", () => {
    expect(second("44_01_01_151008_VFVO51.xml", "U-V")).toBe("レベル５（避難）");
    expect(second("45_01_01_200522_VFVO50.xml", "U-V")).toBe("レベル３（入山規制）");
    expect(second("16_00_01_260603_VXKO70_kozagawa_l5.xml", "U-R")).toBe("レベル５氾濫特別警報");
    expect(second("selected_xml/74_01_01_200512_VYSE50.xml", "U-N")).toBe("調査中");
  });
  it("見出し文に同じ字がある報、気象防災速報、注意以下の報には出ない", () => {
    expect(second("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W")).toMatch(/^【特別警報（大雨）】/);
    for (const [path, unit] of [["19_01_01_091210_VPHW50.xml", "U-M"], ["phase6b_VPOA50_JPDE202608201757_202608201757.xml", "U-B"], ["15_16_07_250825_VPWW61.xml", "U-W"]] as const) {
      const report = reportOf(path, unit);
      expect(report.kind === "short" ? report.reason : "?", path).toBeNull();
    }
  });
});

describe("P3-TL2-T09 津波の続報", () => {
  const tsunamiLines = (units: readonly TerminalUnit[][]) => {
    const print = terminal();
    return units.map((one) => print(one));
  };
  const first = unitOf("32-39_11_02_250206_VTSE41.xml", "U-T"), later = unitOf("32-39_11_11_250206_VTSE41.xml", "U-T");
  it("前の VTSE41 より区分が上がった地域が「大津波警報に引き上げ」に出る。VTSE51 と覚えの無い端末には出ない", () => {
    const [, after] = tsunamiLines([[first], [later]]);
    const raised = after.find((line) => line.startsWith("大津波警報に引き上げ  "))!;
    for (const name of ["青森県太平洋沿岸", "茨城県", "千葉県九十九里・外房"]) expect(raised).toContain(name);
    expect(terminal()([later]).some((line) => line.includes("引き上げ"))).toBe(false);
    const [, observed] = tsunamiLines([[first], [unitOf("32-39_11_10_250206_VTSE51.xml", "U-T")]]);
    expect(observed.some((line) => line.includes("引き上げ"))).toBe(false);
  });
  it("VTSE51 の取消では覚えを消さない", () => {
    const cancel = unitOf("32-39_11_10_250206_VTSE51.xml", "U-T", (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"));
    const [, , after] = tsunamiLines([[first], [cancel], [later]]);
    expect(after.some((line) => line.startsWith("大津波警報に引き上げ  "))).toBe(true);
  });
  it("取消で覚えを消す", () => {
    const cancel = unitOf("32-39_11_02_250206_VTSE41.xml", "U-T", (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"));
    const [, , after] = tsunamiLines([[first], [cancel], [later]]);
    expect(after.some((line) => line.includes("引き上げ"))).toBe(false);
  });
});

describe("P3-TL2-T10 同じ地震の報の重なり", () => {
  const asFamily = (unit: TerminalUnit, family: string): TerminalUnit => {
    if (unit.kind !== "eew") throw new Error(unit.kind);
    return { ...unit, subject: { ...unit.subject, facts: { ...unit.subject.facts, family } } };
  };
  it("VXSE45 の後の VXSE43 は出さず、VXSE43 が先なら続く VXSE45 も出る", () => {
    const [fourth, warning] = eewUnits(["77_01_04_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml"]);
    const print = terminal();
    expect(print(fourth).length).toBeGreaterThan(1);
    expect(print(warning)).toEqual([""]);
    const forward = terminal();
    expect(forward(warning).length).toBeGreaterThan(1);
    expect(forward(fourth).length).toBeGreaterThan(1);
  });
  it("取消は種類によらず最初の 1 通だけ出し、畳んだ後の取消の 3 行目に震源名がある", () => {
    const [cancel] = eewUnits(["37_01_03_240613_VXSE43.xml"]);
    const print = terminal();
    expect(print(cancel).length).toBeGreaterThan(1);
    expect(print(cancel.map((unit) => asFamily(unit, "VXSE45")))).toEqual([""]);
    const [fourth, warning, cancelled] = eewUnits(["77_01_04_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"]);
    const folded = terminal();
    folded(fourth);
    folded(warning);
    expect(folded(cancelled).join("\n")).toContain("取り消したのは 23:14:59 発表の豊後水道の地震です");
  });
  const debug = (text: string): TerminalUnit => ({ kind: "notice", notice: { kind: "debug", text }, prompt: null });
  it("畳んだ報の debug の行は、次のバッチでも「出さない・畳んだ」と書く", () => {
    const [fourth, warning] = eewUnits(["77_01_04_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml"]);
    const renderer = createRenderer(0);
    const lines = (units: readonly TerminalUnit[], dropped = 0) => renderer.render({ columns: 80, dropped, units }).split("\n").filter((line) => line !== "");
    lines(fourth);
    expect(lines(warning)).toEqual([]);
    expect(lines([debug("debug: VXSE43 i（U-E、出した）")])).toEqual(["debug: VXSE43 i（U-E、出さない・畳んだ）"]);
  });
  it("落とした単位がある render と、畳んだ報の次の次の debug の行は書き換えない", () => {
    const [fourth, warning] = eewUnits(["77_01_04_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml"]);
    const dropped = createRenderer(0), render = (renderer: ReturnType<typeof createRenderer>, units: readonly TerminalUnit[], count = 0) =>
      renderer.render({ columns: 80, dropped: count, units }).split("\n").filter((line) => line.startsWith("debug:"));
    render(dropped, fourth);
    render(dropped, warning);
    expect(render(dropped, [debug("debug: VXSE43 b（U-E、出した）")], 1)).toEqual(["debug: VXSE43 b（U-E、出した）"]);
    const twice = createRenderer(0);
    render(twice, fourth);
    expect(render(twice, [...warning, debug("debug: a（U-E、出した）"), debug("debug: b（U-E、出した）")])).toEqual(["debug: a（U-E、出さない・畳んだ）", "debug: b（U-E、出した）"]);
  });
});

describe("P3-TL2-T11 同時に進む EEW", () => {
  const MINUTE = 60_000;
  const at = (units: readonly TerminalUnit[], nowMs: number): TerminalUnit[] => units.map((unit) => unit.kind === "eew" ? { ...unit, nowMs } : unit);
  const others = (lines: readonly string[]): string | undefined => lines.find((line) => line.startsWith("ほかに "));
  const [warning] = eewUnits(["37_01_01_240613_VXSE43.xml"]), [plum] = eewUnits(["77_02_01_260101_VXSE45_PLUM.xml"]);
  const [mixed] = eewUnits(["77_02_02_260101_VXSE45_MIXED.xml"]), [final] = eewUnits(["77_01_30_260101_VXSE45_FINAL.xml"]), [cancel] = eewUnits(["37_01_03_240613_VXSE43.xml"]);
  it("2 通目の要点に「ほかに 1 件の緊急地震速報（震源名）」が出て、10 分を過ぎると消える。取消・最終報の地震は数えない", () => {
    const print = terminal();
    print(at(warning, 0));
    expect(others(print(at(plum, MINUTE)))).toBe("ほかに 1 件の緊急地震速報（豊後水道）");
    expect(others(terminal()(at(plum, 0)))).toBeUndefined();
    const late = terminal();
    late(at(warning, 0));
    expect(others(late(at(plum, 10 * MINUTE + 1)))).toBeUndefined();
    const cancelled = terminal();
    cancelled(at(warning, 0));
    cancelled(at(cancel, MINUTE));
    expect(others(cancelled(at(plum, 2 * MINUTE)))).toBeUndefined();
    const ended = terminal();
    ended(at(final, 0));
    expect(others(ended(at(plum, MINUTE)))).toBeUndefined();
  });
  it("最終報の後に別の種類の報が来ても数えに戻らない。訓練の報は通常の報の数に入らない。2 件以上は震源名を付けない", () => {
    const print = terminal();
    print(at(final, 0));
    print(at(final.map((unit) => unit.kind === "eew" ? { ...unit, subject: { ...unit.subject, facts: { ...unit.subject.facts, terminal: false, family: "VXSE43" } } } : unit), MINUTE));
    expect(others(print(at(plum, 2 * MINUTE)))).toBeUndefined();
    const drill = eewUnits([{ path: "37_01_01_240613_VXSE43.xml", transform: (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>") }])[0];
    const mixedKinds = terminal();
    mixedKinds(at(drill, 0));
    expect(others(mixedKinds(at(plum, MINUTE)))).toBeUndefined();
    const two = terminal();
    two(at(warning, 0));
    two(at(mixed, 30_000));
    expect(others(two(at(final, MINUTE)))).toBe("ほかに 2 件の緊急地震速報");
  });
});

describe("P3-TL2-T01b 合成の字の色", () => {
  it("「7程度以上」「6強〜7」の最大の行は 7 の役目（白の地）の色が付く", () => {
    for (const [from, to] of [["7", "over"], ["6+", "7"]]) {
      const line = terminal(80, 3)(eewUnits([eewWith("37_01_01_240613_VXSE43.xml", from, to)])[0]).find((one) => plain(one).includes("最大予測震度"))!;
      expect(line, `${from}/${to}`).toContain("48;2;255;255;255m");
    }
  });
});

describe("P3-TL2-T12 震度 7 の幅", () => {
  it("7 の地震の報と 7 の EEW は 40・56・59・100 桁、色 0 と 3 で、URL を除いて行が幅を越えない", () => {
    const seismic = unitOf("32-35_01_03_240613_VXSE53.xml", "U-Q", seven);
    const [eew] = eewUnits([eewWith("37_01_01_240613_VXSE43.xml", "7", "7")]);
    for (const level of [0, 3] as const) for (const columns of [40, 56, 59, 100]) for (const units of [[seismic], eew]) {
      const over = terminal(columns, level)(units).map(plain).filter((line) => !line.includes("https://") && width(line) > Math.min(columns, 100));
      expect(over, `${columns}/${level}`).toEqual([]);
    }
  });
});
