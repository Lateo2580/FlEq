import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import { classifyHeadType } from "../../src/runtime/unit-coverage";
import { width } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { decodeFixture, plain, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-006（Q-TO7-*）の試験。
const BG = { top: "48;2;255;255;255m", purple: "48;2;178;58;178m", warning: "48;2;213;94;0m" } as const;
const render = (path: string, unit: RuntimeUnitId, transform?: (xml: string) => string, columns = 80): string[] => {
  const report = terminalReport(decodeFixture(path, "replay", transform), unit);
  if (report == null) throw new Error(path);
  return terminal(columns, 3)([reportUnit(report)]);
};
const bandOf = (lines: readonly string[]): string => {
  const line = lines[1];
  return (Object.keys(BG) as (keyof typeof BG)[]).find((key) => line.includes(BG[key])) ?? (line.includes("38;2;240;228;66m") ? "caution" : "plain");
};
const code = (to: string) => (xml: string) => xml.replace(/<Code>15<\/Code>/g, `<Code>${to}</Code>`);
const NO_HEAD = "、。，．）」』］】〉》)]！？ーぁぃぅぇぉっゃゅょァィゥェォッャュョ";

describe("P3-TL6 帯の段と禁則", () => {
  // P3-TL6-T01 / AC01
  it("T01 レベルの無い火山の Code は 24・25 が top、23 が warning、22・36 が caution で、13 と月間火山概況は今のまま", () => {
    const at = (to: string) => bandOf(render("45_02_01_200522_VFVO50.xml", "U-V", code(to)));
    expect(["24", "25", "23", "22", "99"].map(at)).toEqual(["top", "top", "warning", "caution", "plain"]);
    // VFSV の fixture 名は型の綴りに当たらない（V[A-Z]{3}\d\d）ので電文の種類を名指しで渡す。
    const marine = terminalReport(decodeFixture("46_01_01_170103_VFSVii.xml", "replay", undefined, "VFSV50"), "U-V");
    expect(bandOf(terminal(80, 3)([reportUnit(marine!)]))).toBe("caution");
    expect(bandOf(render("45_01_01_200522_VFVO50.xml", "U-V"))).toBe("warning");
    expect(bandOf(render("44_01_01_151008_VFVO51.xml", "U-V"))).toBe("plain");
  });

  // P3-TL6-T02 / AC02
  it("T02 VYSE60 は InfoSerial の有無によらず warning で理由の行が無く、取消は取消の段", () => {
    const path = "selected_xml/80_01_01_240821_VYSE60.xml";
    const plainLines = render(path, "U-N");
    expect(bandOf(plainLines)).toBe("warning");
    const serial = (xml: string) => {
      const next = xml.replace(/(<EarthquakeInfo[^>]*>\s*<InfoKind>[^<]*<\/InfoKind>)/, "$1<InfoSerial><Name>巨大地震警戒</Name><Code>120</Code></InfoSerial>");
      expect(next).not.toBe(xml);
      return next;
    };
    const withSerial = render(path, "U-N", serial);
    expect(bandOf(withSerial)).toBe("warning");
    expect(plain(withSerial[2])).toBe(plain(plainLines[2]));
    expect(plain(plainLines[2])).toMatch(/^ *本日/);
    const cancelled = terminalReport(decodeFixture(path, "replay", (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")), "U-N");
    expect(cancelled?.kind === "short" ? cancelled.level : null).toBe("cancel");
  });

  // P3-TL6-T04 / AC04
  it("T04 読めた全 fixture を 56・80・100 桁で描いて、折った行の行頭に NO_HEAD の字が無い（80_01_01 の「（Ｍｗ）７．７」の折り目を含む）", () => {
    const walk = (dir: string): string[] => readdirSync(`test/fixtures/${dir}`, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? walk(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]);
    let read = 0;
    const bad: string[] = [];
    for (const path of walk("")) {
      const type = /V[A-Z]{3}\d\d/.exec(path.split("/").at(-1)!)?.[0];
      const route = type == null ? null : classifyHeadType(type);
      if (route?.status !== "ready") continue;
      // 読めない入力だけを飛ばす。描画の例外は試験を落とす。
      let report: ReturnType<typeof terminalReport>;
      try { report = terminalReport(decodeFixture(path), route.unit); } catch { continue; }
      if (report == null) continue;
      read += 1;
      for (const columns of [56, 80, 100]) {
        for (const text of terminal(columns, 3)([reportUnit(report)]).map(plain)) if (/^ {2,6}\S/.test(text) && NO_HEAD.includes(text.trim()[0])) bad.push(`${columns} ${path}: ${text}`);
      }
    }
    expect(read).toBeGreaterThan(200);
    expect(bad).toEqual([]);
  });

  // P3-TL6-T05 / AC04 (2)(3)(4)
  it("T05 「）。」「っ。」が境に来ても行頭に句読点が来ず、細い幅でも幅を超えず、空白を除いた字の列は元の文と同じ", () => {
    // 文は句点で分けて出すので、「）。」と「っ。」を別の文にして、どの幅でも片方が境に来るようにする。
    // 2 つ目は 3 字の続き、3 つ目は空白で折った直後の送り（AC04 (2)(5)）。
    const sentences = ["　観測値は暫定でＭｗ７．７の地震とされました（暫定値）。そのうえで結果をまとめあげきっ。",
      "　これらの値はすべて（「暫定値」）。ただし（「確定値」）。", "　地震の規模はすでにこれです ）を確認の結果です ）を発表します"];
    const drawn = (sentence: string, columns: number): string[] => render("selected_xml/80_01_01_240821_VYSE60.xml", "U-N",
      (xml) => xml.replace(/(<Headline>\s*<Text>)[^<]*/, `$1${sentence}`), columns).map(plain);
    for (const sentence of sentences) for (const columns of [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 40]) {
      const lines = drawn(sentence, columns);
      for (const text of lines) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
      for (const text of lines.filter((item) => /^ {2,6}\S/.test(item))) expect(NO_HEAD.includes(text.trim()[0])).toBe(false);
      expect(lines.join("").replace(/\s/g, "")).toContain(sentence.replace(/\s/g, ""));
    }
    // 送ると幅を超える文（AC04 (3)）。送らないので行頭の字は問わず、幅だけを見る。
    for (const columns of [14, 15, 16, 17, 18, 19, 20, 21, 22]) for (const text of drawn("abcあ））））））。", columns)) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
  });

  // P3-TL6-T06 / AC05
  it("T06 理由の行がある報の見出し文は 2 桁下がり、折り返した行は 4 桁で、理由の行が無い報は下がらない", () => {
    const shown = (path: string, unit: RuntimeUnitId, columns = 80) => terminal(columns)([reportUnit(terminalReport(decodeFixture(path), unit)!)]).map(plain);
    expect(shown("45_01_01_200522_VFVO50.xml", "U-V").slice(2, 5).map((text) => /^ */.exec(text)![0].length)).toEqual([0, 2, 4]);
    expect(shown("selected_xml/80_01_01_240821_VYSE60.xml", "U-N")[2]).toMatch(/^本日/);
    expect(shown("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W")[2]).toMatch(/^【特別警報/);
    for (const columns of [56, 80, 100]) for (const text of shown("45_01_01_200522_VFVO50.xml", "U-V", columns)) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
  });
});
