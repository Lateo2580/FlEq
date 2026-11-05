import { describe, expect, it } from "vitest";

import { eewUnits, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// 末尾の再掲（P3-TL-AC08）と文の折り返し（P3-TL-AC09）。
describe("P3-TL-T07 末尾の再掲", () => {
  it("地域 44 の EEW は最後の 24 行の中に最大予測震度の行が残る", () => {
    const [big] = eewUnits(["77_01_26_240613_VXSE45.xml"]);
    const tail = terminal()(big).slice(-24);
    // 再掲は最大の行と、行動の文（発表時刻つき、P3-TL2-AC05 (3)）。
    expect(tail).toContain("最大予測震度 6弱  愛媛県南予");
    expect(tail).toContain("強い揺れに警戒してください。（23:15:38 発表）");
  });

  it("帯から末尾の行までが 19 行の報には出ず 20 行の報に出る（空行は数えない）。訓練の報の括弧には印が付く", () => {
    const base = reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q");
    if (base.kind !== "seismic") throw new Error(base.kind);
    // 津波についての文の行数を 1 行ずつ増やす（1 行増えるごとに帯から末尾の行までが 1 行増える）。
    const shown = (rows: number) => terminal()([reportUnit({ ...base, forecastComment: Array.from({ length: rows }, (_, index) => `文${index}`).join("\n") })])
      .filter((line) => line !== "");
    const firstWith = Array.from({ length: 30 }, (_, index) => index + 1).find((rows) => shown(rows).some((line) => line.includes("発表・訓練）")))!;
    expect(shown(firstWith - 1)).toHaveLength(19);
    // 再掲の行（最大震度の行と、津波についての文の firstWith 行）を除くと 20 行。
    expect(shown(firstWith)).toHaveLength(20 + 1 + firstWith);
  });
});

describe("P3-TL-T08 文の折り返し", () => {
  it("VXSE53 の見出し文は 80 桁で 1 行、56 桁で句点で 2 行。VXSE62 の見出し文の行頭に句読点が来ない", () => {
    const vxse53 = [reportUnit(reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q"))];
    const sentence = "１日１３時４５分ころ、地震がありました。各地の震度をお知らせします。";
    expect(terminal(80)(vxse53)).toContain(sentence);
    const narrow = terminal(56)(vxse53);
    expect(narrow).toContain("１日１３時４５分ころ、地震がありました。");
    expect(narrow).toContain("各地の震度をお知らせします。");
    for (const columns of [40, 48, 56, 60, 61, 70, 80, 100]) {
      const lines = terminal(columns)([reportUnit(reportOf("selected_xml/78_01_01_240613_VXSE62.xml", "U-Q"))]);
      expect(lines.filter((line) => /^\s*[、。，．]/.test(line)), `${columns}`).toEqual([]);
    }
    // 電文の「ください 。」のように句読点の前に空白がある文（VFVO50）も、空白で折った後の行頭に句読点が来ない。
    const volcano = reportUnit(reportOf("45_01_01_200522_VFVO50.xml", "U-V"));
    for (const [columns, level] of [[45, 0], [66, 0], [68, 3]] as const) {
      expect(terminal(columns, level)([volcano]).map(plain).filter((line) => /^\s*[、。，．]/.test(line)), `${columns}/${level}`).toEqual([]);
    }
  });
});
