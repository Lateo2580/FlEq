import { describe, expect, it } from "vitest";

import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { width } from "../../src/terminal/format";
import { band, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-012（Q-TO13-VPWW-TITLE・Q-TO13-RELEASED）の試験。
type Short = Extract<TerminalReport, { kind: "short" }>;
const short = (path: string, unit: RuntimeUnitId, transform?: (xml: string) => string): Short => {
  const report = reportOf(path, unit, transform);
  if (report.kind !== "short") throw new Error(report.kind);
  return report;
};
const render = (report: Short, columns = 80, level: 0 | 3 = 0): string[] => terminal(columns, level)([reportUnit(report)]);
const replaced = (from: RegExp, to: string) => (xml: string): string => {
  const next = xml.replace(from, to);
  expect(next).not.toBe(xml);
  return next;
};
const both = (...transforms: ((xml: string) => string)[]) => (xml: string): string => transforms.reduce((text, transform) => transform(text), xml);
const kind = (name: string, code: string, status: string): string => `<Kind><Name>${name}</Name><Code>${code}</Code><Status>${status}</Status></Kind>`;
const NONE = "<Kind><Status>発表警報・注意報はなし</Status></Kind>";
const item = (area: string, ...kinds: string[]): string => `<Item>${kinds.join("")}<Area><Name>${area}</Name><Code>0</Code></Area></Item>`;
const warning = (layer: string, ...items: string[]): string => `<Warning type="気象警報・注意報（${layer}）">${items.join("")}</Warning>`;
const body = (...warnings: string[]) => replaced(/(<Body[^>]*>)[\s\S]*<\/Body>/, `$1${warnings.join("")}</Body>`);
const AREAS = /<Warning type="気象警報・注意報（市町村等をまとめた地域等）">[\s\S]*?<\/Warning>/;
const areasLayer = (...items: string[]) => replaced(AREAS, warning("市町村等をまとめた地域等", ...items));

const RELEASE = "18_00_01_260830_VPWW55_fukui_release.xml", L5 = "18_00_01_260830_VPWW55_fukui_L5.xml", VPWW61 = "15_16_07_250825_VPWW61.xml";
const HIGH_WAVE = "15_16_05_241226_VPWW59.xml", SHIMANE = "15_17_01_251222_VPWW55.xml";
// 2026-11-08 21:49 の室蘭の VPWW59 の写し（実の XML は repo に無い、Q-TL12-MURORAN-XML）。
const muroran = both(replaced(/<Title>宗谷地方波浪警報・注意報<\/Title>/, "<Title>胆振・日高地方波浪警報・注意報</Title>"),
  replaced(/<PublishingOffice>[^<]*<\/PublishingOffice>/, "<PublishingOffice>室蘭地方気象台</PublishingOffice>"),
  replaced(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2026-11-08T21:49:00+09:00</ReportDateTime>"),
  replaced(/(<Headline>\s*<Text>)[^<]*/, "$1注意報を解除します。"),
  body(warning("府県予報区等", item("胆振地方", NONE), item("日高地方", kind("波浪注意報", "16", "解除"))),
    warning("一次細分区域等", item("胆振地方", NONE), item("日高地方", kind("波浪注意報", "16", "解除"))),
    warning("市町村等をまとめた地域等", item("日高西部", NONE), item("日高東部", kind("波浪注意報", "16", "解除"))),
    warning("市町村等", item("日高町", NONE), item("浦河町", kind("波浪注意報", "16", "解除")))));
// 福井の解除の区域の層を n 個の Item に増やした報（どれも同じ解除の Kind）。
const many = (count: number) => areasLayer(...Array.from({ length: count }, (_, index) => item(`区域${index + 1}`, kind("レベル２大雨注意報", "10", "解除"))));
const released = (report: Short) => report.released;

describe("P3-TL12 気象警報・注意報の帯の題名と解除の行", () => {
  // P3-TL12-T01 regression / AC01・AC03（2026-11-08 21:49 Mac mini の新築の端末）
  it("T01 室蘭の解除の報は帯が Head/Title で、見出し文の下に解除の行、どの行にも「胆振地方」が無い", () => {
    const lines = render(short(HIGH_WAVE, "U-W", muroran));
    expect(lines).toEqual(["", band("胆振・日高地方波浪警報・注意報", "21:49:00"), "注意報を解除します。", "波浪注意報 解除  日高東部", "VPWW59 ・ 室蘭地方気象台"]);
    expect(lines.some((text) => text.includes("胆振地方"))).toBe(false);
  });

  // P3-TL12-T02 contractBoundary / AC02
  it("T02 released は市町村等をまとめた地域等の層の解除の Kind を Code ごとの行にし、取消と他の報は null", () => {
    const cases: readonly (readonly [string, RuntimeUnitId])[] = [[RELEASE, "U-W"], [SHIMANE, "U-W"], ["18_00_01_260603_VPWW56_kagawa_release.xml", "U-L"], [VPWW61, "U-W"],
      [L5, "U-W"], ["15_18_01_250630_VPWS50.xml", "U-W"], ["synthetic_VPWW56_cancel.xml", "U-L"]];
    expect(cases.map(([path, unit]) => released(short(path, unit)))).toEqual([
      { rows: [{ label: "レベル２大雨注意報", areas: ["嶺北北部", "嶺北南部", "奥越"] }], others: 0 },
      { rows: [{ label: "レベル２大雨注意報", areas: ["隠岐"] }], others: 0 },
      { rows: [{ label: "レベル２土砂災害注意報", areas: ["高松地域"] }], others: 0 },
      { rows: [], others: 0 }, { rows: [], others: 0 }, null, null]);
    const over = released(short(RELEASE, "U-W", many(257)));
    expect([over?.rows.length, over?.rows[0].areas.length, over?.rows[0].areas.at(-1), over?.others]).toEqual([1, 256, "区域256", 1]);
    // 複数種類の同時解除: 3 Item に Code の違う Kind が 9 個（行の数が区域の数を越える）。
    const allReleased = (xml: string): string => {
      const next = xml.replace(AREAS, (layer) => layer.replace(/<Status>[^<]*<\/Status>/g, "<Status>解除</Status>"));
      expect(next).not.toBe(xml);
      return next;
    };
    const nine = released(short(VPWW61, "U-W", allReleased));
    expect(nine).toEqual({ rows: [["雷注意報", "宗谷北部"], ["融雪注意報", "宗谷北部"], ["低温注意報", "宗谷北部"], ["濃霧注意報", "宗谷南部"], ["乾燥注意報", "宗谷南部"],
      ["なだれ注意報", "宗谷南部"], ["霜注意報", "利尻・礼文"], ["着氷注意報", "利尻・礼文"], ["着雪注意報", "利尻・礼文"]].map(([label, area]) => ({ label, areas: [area] })), others: 0 });
    // 延べの境界: 171 Item × Code の違う解除の Kind 3 つ = 513。512 を載せ、171 個目の Item の 3 つ目だけ載らない。
    const total = released(short(RELEASE, "U-W", areasLayer(...Array.from({ length: 171 }, (_, index) => item(`区域${index + 1}`,
      kind("レベル２大雨注意報", "10", "解除"), kind("強風注意報", "15", "解除"), kind("波浪注意報", "16", "解除"))))));
    expect([total?.rows.map((row) => [row.label, row.areas.length]), total?.rows[2].areas.at(-1), total?.others])
      .toEqual([[["レベル２大雨注意報", 171], ["強風注意報", 171], ["波浪注意報", 170]], "区域170", 1]);
  });

  // P3-TL12-T03 acceptance / AC01・AC03・AC04
  it("T03 理由の行は見出し文とだけ突き合わせ、解除の行は理由の行の下で 2 桁下がり、取消と題名の欠けた報は対象を付けない", () => {
    // (a) D-REASON-MATCH=A: 題名「宗谷地方波浪警報・注意報」に「波浪警報」の字があっても理由の行を出す。
    expect(render(short(HIGH_WAVE, "U-W"))).toEqual(["", band("宗谷地方波浪警報・注意報", "23:00:00"), "波浪警報", "  宗谷地方では、高波に警戒してください。",
      "VPWW59 ・ 稚内地方気象台"]);
    // (b) 警報が続く島根県: 見出し文と解除の行がどちらも 2 桁下がる。
    const shimane = render(short(SHIMANE, "U-W"));
    expect([shimane[2], shimane.at(-2)]).toEqual(["レベル３大雨警報", "  レベル２大雨注意報 解除  隠岐"]);
    expect(shimane.slice(3, -1).every((text) => text.startsWith("  "))).toBe(true);
    // (c) 取消の報は帯が Head/Title と「 取消」で、解除の行は無い。
    const cancel = render(short("synthetic_VPWW56_cancel.xml", "U-L"));
    expect(cancel[1].startsWith("━ 宗谷地方土砂災害警報・注意報 取消 ━")).toBe(true);
    expect(cancel.some((text) => text.includes(" 解除  "))).toBe(false);
    // (d) Head/Title を空にした福井の L5 は Control/Title の種類の名前だけで「福井県」を付けない。
    const untitled = render(short(L5, "U-W", replaced(/<Title>福井県大雨警報・注意報<\/Title>/, "<Title></Title>")));
    expect(untitled[1]).toBe(band("気象警報・注意報（大雨）", "06:51:00"));
    // (e) 257 区域の報は解除の行の最後に薄い字の「ほか 1 区域は読んでいません」。
    const over = short(RELEASE, "U-W", many(257));
    expect(render(over).at(-2)).toBe("ほか 1 区域は読んでいません");
    // (f) 56・80・100 桁、色 0 と 3 で、どの行も桁数を越えず、区域の名前が途中で折れない。
    for (const report of [short(VPWW61, "U-W"), short(RELEASE, "U-W"), over]) for (const columns of [56, 80, 100]) for (const level of [0, 3] as const) {
      const lines = render(report, columns, level).map(plain);
      for (const text of lines) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
      const shown = new Set(lines.flatMap((text) => text.trim().split(/[　 ]+/)));
      for (const area of report.released?.rows.flatMap((row) => row.areas) ?? []) expect(shown.has(area)).toBe(true);
    }
  });
});
