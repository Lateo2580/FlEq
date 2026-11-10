import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { createRenderer } from "../../src/terminal/format";
import { inputTerminal } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import { inputDoneOf, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-017 の試験（1 件の気象警報・注意報時系列情報の種類の行）と、P3-TERMINAL-LAYOUT-019 の試験（種類ごとの時間帯と市町村等の 2 行）。
const SOYA = "81_01_01_260129_VPWP50.xml", NAGANO = "81_09_01_260605_VPWP50.xml", HIGH = "81_02_01_260605_VPWP50_high_severity.xml";

// layout16.test.ts の sink と同じ本物の出力の経路（createTerminalOutput）。
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
function sink(columns: number) {
  const renderer = createRenderer(0), lines: string[] = [];
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }),
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  output.attach({ status: () => CONNECTED });
  return { output, lines };
}

// layout16.test.ts の owned と同じ owner の道。close で残りの時系列のまとまりが 1 件で出る。transform は電文を書き換えて別の報にする。
async function owned(path: string, columns: number, transform: (xml: string) => string = (xml) => xml) {
  const xml = transform(readFileSync(`test/fixtures/${path}`, "utf8"));
  const now = { wallTimeMs: Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]) + 60_000, monotonicMs: 0 };
  const inputId = `l17-${path.replace(/\W/g, "")}`;
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: now.wallTimeMs, origin: "live", kind: "replay", body: Buffer.from(xml), headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const result = decodeMaterial(entered.item);
  const owner = restoreOwner({ runId: "run", place: "deferred", clock: now,
    restored: Object.fromEntries(placeUnits("deferred").map((unit) => [unit, { kind: "empty" }])) as never }, linkedUnitTable, linkedUnitCodecs);
  const step = receiveOwner(owner.state, { runId: "run", inputId, result }, now, linkedUnitTable);
  const rejected = step.confirmationEvidence.some(({ source }) => source === "unreadableReport");
  const report = inputTerminal(result, step.outcomes, rejected);
  const s = sink(columns);
  s.output.sink.inputDone(inputDoneOf(inputId, report, step.outcomes));
  await s.output.close();
  return { lines: s.lines, outcome: step.outcomes.find(({ unit }) => unit === "U-F")?.outcome ?? null };
}

describe("P3-TL17 1 件の気象警報・注意報時系列情報の種類の行", () => {
  // P3-TL17-T01 corpusHistory / AC01 (4)
  it("T01 81_01_01（種類 0）は今の 2 行のまま", async () => {
    const wide = await owned(SOYA, 100);
    expect(wide.outcome?.kind).toBe("accepted");
    expect(wide.lines).toEqual(["", "━ 宗谷地方警戒・注意事項時系列情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 05:00:00 発表 ━", "VPWP50 ・ 稚内地方気象台"]);
  });

  // P3-TL19-T01 acceptance / P3-TL19-AC01・AC02（P3-TL17-T02 の期待を改めた）
  it("T02 81_09_01（見出し文が空・種類 1）は帯の直下に種類の 2 行", async () => {
    expect((await owned(NAGANO, 100)).lines).toEqual(["", "━ 長野県警戒・注意事項時系列情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 05:00:00 発表 ━",
      "濃霧危険度（注意報級）  06日朝〜06日昼前", "  小諸市・佐久市・小海町・川上村・南牧村・南相木村・北相木村・佐久穂町・軽井沢町・御代田町・立科町", "VPWP50 ・ 長野地方気象台"]);
    expect((await owned(NAGANO, 56)).lines).toEqual(["", "━ 長野県警戒・注意事項時系列情報 ━━━━━━━ 05:00:00 発表 ━",
      "濃霧危険度（注意報級）  06日朝〜06日昼前", "  小諸市・佐久市・小海町・川上村・南牧村 ほか 6", "VPWP50 ・ 長野地方気象台"]);
  });

  // P3-TL19-T02 contractBoundary / P3-TL19-AC02 (1)(2)（P3-TL17-T03 の期待を改めた）
  it("T03 81_02_01 は見出し文の下に Code の大きい順、時間帯の 1 つと範囲・日付の無い Name、段階の名前も半角", async () => {
    expect((await owned(HIGH, 100)).lines).toEqual(["", "━ 宗谷地方警戒・注意事項時系列情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 17:00:00 発表 ━",
      "大雨警報・土砂災害警戒レベル4相当・特別警報級の予測", "大雨浸水危険度（特別警報級）  夜のはじめ頃", "  稚内市", "土砂災害危険度（警戒レベル4相当）  夜のはじめ頃〜夜遅く", "  稚内市",
      "VPWP50 ・ 稚内地方気象台"]);
    const wide = await owned(HIGH, 100, (xml) => xml.replace(/<Name>警戒レベル4相当<\/Name>/g, "<Name>警戒レベル４相当</Name>"));
    expect(wide.lines).toContain("土砂災害危険度（警戒レベル4相当）  夜のはじめ頃〜夜遅く");
  });
});

// ---- P3-TERMINAL-LAYOUT-019 の電文の書き換え ----
const SERIES = /<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>/g, ITEM = /<Item>[\s\S]*?<\/Item>/g;
// series 番目（1 から）の TimeSeriesInfo だけを edit に通す。
function editSeries(xml: string, series: number, edit: (block: string) => string): string {
  let seen = 0;
  return xml.replace(SERIES, (block) => (seen += 1) === series ? edit(block) : block);
}
// series 番目の TimeSeriesInfo の Item を電文の順（index は 0 から）に edit に通す。
const editItems = (xml: string, series: number, edit: (item: string, index: number) => string): string =>
  editSeries(xml, series, (block) => { let index = 0; return block.replace(ITEM, (item) => edit(item, index++)); });
const areaOf = (item: string): string | null => /<Area>\s*<Name>([^<]*)<\/Name>/.exec(item)?.[1] ?? null;
// Item の中の from 型・refID の Significancy を、type・Name・Code を替えたものにする。
const setSig = (item: string, from: string, ref: string, type: string, name: string, code: string): string =>
  item.replace(new RegExp(`<Significancy refID="${ref}" type="${from}">\\s*<Name>[^<]*</Name>\\s*<Code>[^<]*</Code>\\s*</Significancy>`),
    `<Significancy refID="${ref}" type="${type}"><Name>${name}</Name><Code>${code}</Code></Significancy>`);
// 濃霧危険度の注意報級（20）を全部 01 にする。
const fogOff = (xml: string): string => xml.replace(/(<Significancy refID="\d+" type="濃霧危険度">\s*)<Name>注意報級<\/Name>(\s*)<Code>20<\/Code>/g, "$1<Name>注意報級未満</Name>$2<Code>01</Code>");
const shortOf = (report: TerminalReport): Extract<TerminalReport, { kind: "short" }> => {
  if (report.kind !== "short") throw new Error(`not short: ${report.kind}`);
  return report;
};
const rowsOf = (transform?: (xml: string) => string, path = NAGANO) => shortOf(reportOf(path, "U-F", transform)).riskRows;
const ELEVEN = ["小諸市", "佐久市", "小海町", "川上村", "南牧村", "南相木村", "北相木村", "佐久穂町", "軽井沢町", "御代田町", "立科町"];
const MORNING = { from: "０６日朝", to: "０６日昼前" };

describe("P3-TL19 1 件の気象警報・注意報時系列情報の種類ごとの時間帯と市町村等", () => {
  // P3-TL19-T03 contractBoundary / AC02 (3)
  it("T03 特別警報級は全部の市町村を名前の境で折り、続きの行も 2 桁下げ", async () => {
    const special = (xml: string) => xml.replace(/(<Significancy refID="\d+" type="濃霧危険度">\s*)<Name>注意報級<\/Name>(\s*)<Code>20<\/Code>/g, "$1<Name>特別警報級</Name>$2<Code>50</Code>");
    expect((await owned(NAGANO, 56, special)).lines).toEqual(["", "━ 長野県警戒・注意事項時系列情報 ━━━━━━━ 05:00:00 発表 ━",
      "濃霧危険度（特別警報級）  06日朝〜06日昼前", "  小諸市・佐久市・小海町・川上村・南牧村・南相木村", "  北相木村・佐久穂町・軽井沢町・御代田町・立科町", "VPWP50 ・ 長野地方気象台"]);
  });

  // P3-TL19-T04 contractBoundary / AC01 (2)・AC02（Q-TL19-DAILY・Q-TL19-OVERLAP）
  it("T04 TimeSeriesInfo をまたぐ形: 日ごとの時間帯と、同じ type の市町村を重ねない", async () => {
    const frost = (type: string) => (xml: string) => editItems(xml, 3, (item) => areaOf(item) === "佐久市" || areaOf(item) === "軽井沢町" ? setSig(item, "霜危険度", "2", type, "注意報級", "20") : item);
    const lines = (await owned(NAGANO, 100, frost("霜危険度"))).lines;
    expect(lines.slice(2)).toEqual(["濃霧危険度（注意報級）  06日朝〜06日昼前", "  小諸市・佐久市・小海町・川上村・南牧村・南相木村・北相木村・佐久穂町・軽井沢町・御代田町・立科町",
      "霜危険度（注意報級）  07日", "  佐久市・軽井沢町", "VPWP50 ・ 長野地方気象台"]);
    expect(rowsOf(frost("濃霧危険度"))).toEqual([{ type: "濃霧危険度", name: "注意報級", code: "20", spans: [MORNING], areas: ELEVEN, others: 0 }]);
  });

  // P3-TL19-T05 contractBoundary / AC01 (1)(2)
  it("T05 材料: 生の字の時間帯、Local は Item の名前、取消は null、名前の無い Item、重い Code での積み直し", () => {
    expect(rowsOf()?.[0].spans).toEqual([MORNING]);
    expect(rowsOf(undefined, "81_06_01_260605_VPWP50_criteria_period.xml")?.find((row) => row.type === "高潮危険度")?.areas).toEqual(["稚内市"]);
    expect(rowsOf(undefined, SOYA)).toEqual([]);
    expect(rowsOf(undefined, "81_04_01_260605_VPWP50_cancel.xml")).toBeNull();
    const nameless = (xml: string) => editItems(editItems(xml, 1, (item) => areaOf(item) === "小諸市" ? item.replace(/(<Area>\s*)<Name>小諸市<\/Name>/, "$1") : item), 3,
      (item) => areaOf(item) === "小諸市" ? setSig(item, "霜危険度", "1", "濃霧危険度", "注意報級", "20") : item);
    const fog = rowsOf(nameless)?.find((row) => row.type === "濃霧危険度");
    expect(fog?.areas).toHaveLength(11);
    expect(fog?.areas.at(-1)).toBe("小諸市");
    expect(fog?.others).toBe(1);
    const heavier = (xml: string) => editItems(fogOff(xml), 1, (item, index) => index < 65 ? setSig(item, "濃霧危険度", "1", "濃霧危険度", "注意報級", "20")
      : index === 65 ? setSig(item, "濃霧危険度", "1", "濃霧危険度", "警報級", "30") : item);
    expect(rowsOf(heavier)).toEqual([{ type: "濃霧危険度", name: "警報級", code: "30", spans: [{ from: "０６日朝", to: "０６日朝" }], areas: ["朝日村"], others: 0 }]);
  });

  // P3-TL19-T06 contractBoundary / AC01 (3)・AC04
  it("T06 重い段階は数で切らず、注意報級・警報級の名前は 64 まで", () => {
    // 1 つ目の TimeSeriesInfo の Item を 4 回並べる（2〜4 回目は Area/Name と Area/Code の末尾に回の番号）。
    const fourTimes = (xml: string) => editSeries(xml, 1, (block) => {
      const items = block.match(ITEM)!.join("\n");
      const copies = [2, 3, 4].map((round) => items.replace(/(<Area>\s*<Name>[^<]*)(<\/Name>\s*<Code>[^<]*)(<\/Code>)/g, (_, name, code, end) => `${name}${round}${code}${round}${end}`));
      return block.replace("</TimeSeriesInfo>", `${copies.join("\n")}\n</TimeSeriesInfo>`);
    });
    const special = (xml: string) => editItems(fogOff(fourTimes(xml)), 1, (item, index) => index < 257 ? setSig(item, "濃霧危険度", "1", "濃霧危険度", "特別警報級", "50") : item);
    const report = reportOf(NAGANO, "U-F", special), fog = shortOf(report).riskRows?.find((row) => row.type === "濃霧危険度");
    expect(fog?.areas).toHaveLength(257);
    expect(fog?.others).toBe(0);
    expect(terminal(100)([reportUnit(report)]).filter((text) => text.includes("ほか"))).toEqual([]);
    const advisory = (count: number) => (xml: string) => editItems(fogOff(xml), 1, (item, index) => index < count ? setSig(item, "濃霧危険度", "1", "濃霧危険度", "注意報級", "20") : item);
    const sixtyFour = rowsOf(advisory(64))?.find((row) => row.type === "濃霧危険度");
    expect(sixtyFour?.areas).toHaveLength(64);
    expect(sixtyFour?.areas.at(-1)).toBe("生坂村");
    expect(sixtyFour?.others).toBe(0);
    const sixtyFive = rowsOf(advisory(65))?.find((row) => row.type === "濃霧危険度");
    expect(sixtyFive?.areas).toHaveLength(64);
    expect(sixtyFive?.others).toBe(1);
  });

  // P3-TL19-T07 contractBoundary / AC02 (3)
  it("T07 1 つ目の名前は幅に入らなくても出す", () => {
    const unit = reportUnit(reportOf(NAGANO, "U-F"));
    const narrow = terminal(14)([unit]), at = narrow.indexOf("  小諸市 ほか");
    expect(at).toBeGreaterThan(0);
    expect(narrow.slice(at, at + 2)).toEqual(["  小諸市 ほか", "  10"]);
    expect(terminal(16)([unit])).toContain("  小諸市 ほか 10");
  });

  // P3-TL19-T08 contractBoundary / AC01 (2)(a)・AC02 (2)
  it("T08 飛び飛びの時間帯は帯を「・」でつなぎ、1 行目は帯の境で折る", () => {
    const gap = (xml: string) => editItems(xml, 1, (item) => areaOf(item) === "小諸市" ? setSig(item, "濃霧危険度", "9", "濃霧危険度", "注意報級", "20") : item);
    const report = reportOf(NAGANO, "U-F", gap), unit = reportUnit(report);
    expect(shortOf(report).riskRows?.[0].spans).toEqual([MORNING, { from: "０７日朝", to: "０７日朝" }]);
    expect(terminal(56)([unit])).toContain("濃霧危険度（注意報級）  06日朝〜06日昼前・07日朝");
    const forty = terminal(40)([unit]), first = forty.indexOf("濃霧危険度（注意報級）  06日朝〜06日昼前");
    expect(forty.slice(first, first + 2)).toEqual(["濃霧危険度（注意報級）  06日朝〜06日昼前", "                        07日朝"]);
    const narrow = terminal(24)([unit]), stamp = narrow.indexOf("05:00:00 発表");
    expect(stamp).toBeGreaterThan(0);
    expect(narrow.slice(stamp + 1, stamp + 4)).toEqual(["濃霧危険度（注意報級）", "  06日朝〜06日昼前", "  07日朝"]);
    expect(narrow[stamp + 4]).toMatch(/^  小諸市/);
  });

  // P3-TL19-T09 contractBoundary / AC01 (2)(a)・AC02・AC04
  it("T09 TimeDefine を数で切らない", () => {
    const late = (xml: string) => editItems(editSeries(xml, 1, (block) => block.replace("</TimeDefines>",
      `${Array.from({ length: 51 }, (_, index) => `<TimeDefine timeId="${index + 15}"><Name>枠${index + 15}</Name></TimeDefine>`).join("")}</TimeDefines>`)), 1,
    (item) => areaOf(item) === "小諸市" ? item.replace(/(<Significancy refID="1" type="濃霧危険度">)/, '<Significancy refID="65" type="濃霧危険度"><Name>特別警報級</Name><Code>50</Code></Significancy>$1') : item);
    const report = reportOf(NAGANO, "U-F", late);
    expect(shortOf(report).riskRows?.find((row) => row.type === "濃霧危険度")).toEqual({ type: "濃霧危険度", name: "特別警報級", code: "50", spans: [{ from: "枠65", to: "枠65" }], areas: ["小諸市"], others: 0 });
    const lines = terminal(100)([reportUnit(report)]);
    expect(lines[2]).toBe("濃霧危険度（特別警報級）  枠65");
  });
});
