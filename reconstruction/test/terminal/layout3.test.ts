import { describe, expect, it } from "vitest";

import { reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-003（Q-TO4-MONTHLY）の試験。期待の字は docs/specs/cli-terminal-output.md §5.4 の「全国の月間火山概況」の図。
const MONTHLY = "44_01_01_151008_VFVO51.xml";
const URL_LINE = "https://www.data.jma.go.jp/vois/data/report/monthly_v-act_doc/monthly_vact.php";
const flat = (path: string, columns: number, transform?: (xml: string) => string): string[] =>
  terminal(columns)([reportUnit(reportOf(path, "U-V", transform))]);

describe("P3-TL3-T01 帯と文", () => {
  it("44_01_01 は対象が全国の活火山で段が普通、理由の行が無く、見出し文の 3 文が残る。44_02_01 は草津白根山の注意のまま、表も URL も無い", () => {
    const report = reportOf(MONTHLY, "U-V");
    expect(report.kind === "short" ? [report.target, report.level, report.reason] : report.kind).toEqual(["全国の活火山", "plain", null]);
    const lines = flat(MONTHLY, 100);
    expect(lines[1]).toMatch(/^━ 火山の状況に関する解説情報 全国の活火山 ━+ 16:00:00 発表 ━$/);
    expect(lines.slice(2, 5)).toEqual([
      "本日、全国の活火山の活動状況や警戒事項を取りまとめた月間火山概況（ 平成２７年９月）を発表しました。",
      "その概要は以下のとおりです。",
      "詳しくは 月間火山概況及び火山活動解説資料を参照ください。"]);
    const other = reportOf("44_02_01_200522_VFVO51.xml", "U-V");
    expect(other.kind === "short" ? [other.target, other.level, other.monthly] : other.kind).toEqual(["草津白根山（白根山（湯釜付近））", "caution", null]);
    expect(flat("44_02_01_200522_VFVO51.xml", 100).join("\n")).not.toContain("monthly_vact");
  });
});

describe("P3-TL3-T02 表と行き先", () => {
  it("100 桁は図の 6 行と「ほか 98 火山」で、Item は電文の順。URL の行がその下に 1 行で出る", () => {
    expect(flat(MONTHLY, 100).slice(6, 19)).toEqual([
      "レベル５      口永良部島",
      "レベル３      阿蘇山　桜島",
      "レベル２      雌阿寒岳　吾妻山　草津白根山　浅間山　御嶽山　箱根山　霧島山（新燃岳）　諏訪之瀬島",
      "入山危険      西之島",
      "火口周辺危険  硫黄島",
      "周辺海域警戒  福徳岡ノ場",
      "ほか 98 火山",
      "─".repeat(100),
      "月間火山概況・火山活動解説資料（気象庁ホームページ）",
      URL_LINE,
      "VFVO51 ・ 気象庁"]);
  });
  it("56 桁ではレベル２が折り返し、折り返した行にも「レベル２」が出る。URL は折らない", () => {
    const lines = flat(MONTHLY, 56);
    expect(lines.filter((text) => text.startsWith("レベル２"))).toHaveLength(3);
    expect(lines.indexOf(URL_LINE)).toBe(lines.indexOf("月間火山概況・火山活動解説資料（気象庁ホームページ）") + 1);
  });
});

describe("P3-TL3-T03 取消の境界", () => {
  it("InfoType を取消にした報は段が取消で対象が全国の活火山、表も URL も無い", () => {
    const cancel = (xml: string) => xml.replace("<InfoType>発表", "<InfoType>取消");
    const report = reportOf(MONTHLY, "U-V", cancel);
    expect(report.kind === "short" ? [report.target, report.level, report.monthly] : report.kind).toEqual(["全国の活火山", "cancel", null]);
    const text = flat(MONTHLY, 100, cancel).join("\n");
    expect(text).toContain("取消 全国の活火山");
    expect(text).not.toMatch(/口永良部島|monthly_vact|ほか \d+ 火山/);
  });
});

// P3-TL3-AC03 (4)・読む範囲: Body の全 VolcanoInfo の火山名の Areas だけを電文の順に読み、AREA_LIMIT は読む前に全 Area で数える。
describe("P3-TL3-T04 読む範囲と上限の境界", () => {
  const inBody = (edit: (body: string) => string) => (xml: string): string => {
    const at = xml.indexOf("<Body");
    return xml.slice(0, at) + edit(xml.slice(at));
  };
  const monthlyOf = (transform?: (xml: string) => string) => {
    const report = reportOf(MONTHLY, "U-V", transform);
    if (report.kind !== "short" || report.monthly == null) throw new Error("no monthly");
    return report.monthly;
  };
  const SECTION = '<VolcanoInfo type="火山の状況に関する解説情報（対象火山）">';
  const item = (kind: string, names: readonly string[]) =>
    `<Item><Kind><Name>${kind}</Name><Code>12</Code></Kind><Areas codeType="火山名">${names.map((name, i) => `<Area><Name>${name}</Name><Code>${i}</Code></Area>`).join("")}</Areas></Item>`;

  it("VolcanoInfo を 2 本に分けた報は、分ける前と同じ rows と others になる", () => {
    const split = inBody((body) => {
      const at = body.lastIndexOf("<Item>", body.indexOf("<Name>入山危険</Name>"));
      return `${body.slice(0, at)}</VolcanoInfo>${SECTION}${body.slice(at)}`;
    });
    expect(monthlyOf(split)).toEqual(monthlyOf());
  });
  it("火山名でない codeType の Areas の Area は rows に入らず others にも数えない", () => {
    const extra = inBody((body) => body.replace('<Areas codeType="火山名">', '<Areas codeType="対象市町村等"><Area><Name>草津町</Name><Code>1</Code></Area></Areas><Areas codeType="火山名">'));
    expect(monthlyOf(extra)).toEqual(monthlyOf());
  });
  it("留意の Area が 256 個ある報は、後ろの火山を読まず「ほか 257 火山」になる", () => {
    const crowded = inBody((body) => body.replace(/<VolcanoInfo [^>]*>[\s\S]*<\/VolcanoInfo>/,
      `${SECTION}${item("活火山であることに留意", Array.from({ length: 256 }, (_, i) => `留意山${i}`))}${item("レベル２（火口周辺規制）", ["後ろ山"])}</VolcanoInfo>`));
    expect(monthlyOf(crowded)).toEqual({ rows: [], others: 257 });
    expect(flat(MONTHLY, 100, crowded).join("\n")).toContain("ほか 257 火山");
  });
  it("留意の Item が無い報には「ほか」の行が出ない", () => {
    const none = inBody((body) => body.replace(/<Item>(?:(?!<\/Item>)[\s\S])*<\/Item>/g, (whole) => whole.includes("活火山であることに留意") ? "" : whole));
    expect(monthlyOf(none).others).toBe(0);
    expect(flat(MONTHLY, 100, none).join("\n")).not.toMatch(/ほか \d+ 火山/);
  });
});
