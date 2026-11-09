import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimePublishedOutcome, SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { painter } from "../../src/terminal/color";
import type { Role } from "../../src/terminal/color";
import { createRenderer, jsonRecord, width } from "../../src/terminal/format";
import type { TerminalUnit } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import type { TerminalOptions } from "../../src/terminal/output";
import { at, band, decodeFixture, eewOutcome, eewUnits, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-011 の試験（気象警報・注意報時系列情報のまとめ・EEW の震源の名前の色）。
type Short = Extract<TerminalReport, { kind: "short" }>;
type Risk = NonNullable<Short["risks"]>[number];
const shortOf = (report: TerminalReport): Short => { if (report.kind !== "short") throw new Error("not short"); return report; };
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
// 偽の時計の端末（monotonic も Date.now()）。書き出しは色 0・columns 桁の行。
function sink(columns = 80, options: TerminalOptions = {}) {
  const renderer = createRenderer(0), lines: string[] = [];
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }), ...options,
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  return { output, lines, attach: () => { output.attach({ status: () => CONNECTED }); } };
}
const heads = (lines: readonly string[]): string[] => lines.filter((text) => text.startsWith("━ "));

// ---- 気象警報・注意報時系列情報 ----
const TS = "81_02_01_260605_VPWP50_high_severity.xml";
const TS_TITLE = "気象警報・注意報時系列情報";
// 81_02_01（宗谷地方、稚内地方気象台）の Head/Title・EditorialOffice・PublishingOffice・発表時刻を替えた報。edit はその後の書き換え。
function tsOf(name: string, office = `${name}地方気象台`, publisher = office, time = "11:00:00", edit: (xml: string) => string = (xml) => xml): Short {
  return shortOf(reportOf(TS, "U-F", (xml) => edit(xml.replace("<Title>宗谷地方警戒・注意事項時系列情報</Title>", `<Title>${name}地方警戒・注意事項時系列情報</Title>`)
    .replace("<EditorialOffice>稚内地方気象台</EditorialOffice>", `<EditorialOffice>${office}</EditorialOffice>`)
    .replace("<PublishingOffice>稚内地方気象台</PublishingOffice>", `<PublishingOffice>${publisher}</PublishingOffice>`)
    .replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>2026-11-09T${time}+09:00`))));
}
// U-F の accepted の自分の記録（端末が読む subject と source.inputId だけを持つ形。subject は U-F の系列の鍵「<運用区分>/VPWP50/<EditorialOffice>」）。
const ufSubject = (subject: string, inputId: string): SubjectOutcome => ({ subject, operation: "normal", informationType: "発表", transition: "active",
  severity: null, facts: {}, changedFields: [], source: { inputId, origin: "live", operation: "normal", family: "VPWP50", subject, reportDateTimeRaw: "",
    controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" } });
const uf = (subject: string, inputId: string): RuntimePublishedOutcome => ({ unit: "U-F", outcome: { kind: "accepted", change: "semantic", subjects: [ufSubject(subject, inputId)] } });
const training = (xml: string): string => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>");
const KINDS_80 = "大雨浸水危険度（特別警報級）　土砂災害危険度（警戒レベル4相当）";

describe("P3-TL11 気象警報・注意報時系列情報のまとめ", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(11, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  // P3-TL11-T01 regression / AC01・AC03（2026-11-09 11:00、58 件が空行・帯・末尾の 3 行ずつ 174 行並んだ）
  it("T01 58 報を 0.1 秒ごとに渡すと最後から 8 秒の前は何も出ず、過ぎた最初の tick に 60 桁で帯・種類の 2 行・官署の数のブロックが 1 つ。定期要約は気象 58 件", async () => {
    const s = sink(60);
    s.attach();
    const names = Array.from({ length: 58 }, (_, index) => `地方${index + 1}`);
    names.forEach((name, index) => {
      if (index > 0) vi.advanceTimersByTime(100);
      s.output.sink.inputDone(inputDoneOf(`p${index}`, tsOf(name), [uf(`normal/VPWP50/${name}地方気象台`, `p${index}`)]));
    });
    vi.advanceTimersByTime(7_300);
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(s.lines).toEqual(["", band(`${TS_TITLE} 58件`, "11:00:00", 60), "大雨浸水危険度（特別警報級）", "土砂災害危険度（警戒レベル4相当）", "VPWP50 ・ 58 官署"]);
    s.output.control.summaryNow();
    expect(s.lines.at(-1)).toContain("気象 58件");
    await s.output.close();
  });

  // 返信 1 つ（報と U-F の自分の記録の subject）を端末に渡す。
  const send = (s: ReturnType<typeof sink>, id: string, report: TerminalReport, subject: string) => { s.output.sink.inputDone(inputDoneOf(id, report, [uf(subject, id)])); };
  const block = (s: ReturnType<typeof sink>) => s.lines.slice(s.lines.lastIndexOf("") + 1);
  const cancel = reportOf("81_04_01_260605_VPWP50_cancel.xml", "U-F");

  // P3-TL11-T02 acceptance / AC01 (4)(5)・D-TS-SINGLE
  it("T02 (a) 1 件だけなら 8 秒後に今の 1 報の形（帯の題名が Head/Title、末尾の行に官署）", async () => {
    const s = sink();
    s.attach();
    const soya = tsOf("宗谷", "稚内地方気象台");
    send(s, "a", soya, "normal/VPWP50/稚内地方気象台");
    vi.advanceTimersByTime(7_000);
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(s.lines).toEqual(terminal()([reportUnit(soya)]));
    expect([s.lines[1], s.lines.at(-1)]).toEqual([band("宗谷地方警戒・注意事項時系列情報", "11:00:00"), "VPWP50 ・ 稚内地方気象台"]);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (4)・D-TS-LIMIT
  it("T02 (b) 64 件目でその場で出て、65 件目は新しいまとまりに入り close で出る", async () => {
    const s = sink();
    for (let index = 0; index < 64; index += 1) {
      expect(s.lines).toEqual([]);
      send(s, `m${index}`, tsOf(`地方${index}`), `normal/VPWP50/地方${index}地方気象台`);
    }
    expect(heads(s.lines)).toEqual([band(`${TS_TITLE} 64件`, "11:00:00")]);
    send(s, "m64", tsOf("地方64"), "normal/VPWP50/地方64地方気象台");
    expect(heads(s.lines)).toHaveLength(1);
    await s.output.close();
    expect(heads(s.lines).at(-1)).toBe(band("地方64地方警戒・注意事項時系列情報", "11:00:00"));
  });

  // P3-TL11-T02 acceptance / AC01 (4)
  it("T02 (c) 5 秒ごとに届き続けると、最初の報から 90 秒を過ぎた最初の tick で出る", async () => {
    const s = sink();
    s.attach();
    for (let index = 0; index < 18; index += 1) {
      if (index > 0) vi.advanceTimersByTime(5_000);
      send(s, `s${index}`, tsOf(`地方${index}`), `normal/VPWP50/地方${index}地方気象台`);
    }
    vi.advanceTimersByTime(4_999);
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heads(s.lines)).toEqual([band(`${TS_TITLE} 18件`, "11:00:00")]);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (4)
  it("T02 (k)(h) 期限を過ぎて tick の前に同じ鍵の報が来ると前のまとまりを先に出し、新しいまとまりは close で出る", async () => {
    const s = sink();
    s.attach();
    vi.advanceTimersByTime(100);
    send(s, "ka", tsOf("上川"), "normal/VPWP50/上川地方気象台");
    vi.advanceTimersByTime(8_400);
    expect(s.lines).toEqual([]);
    send(s, "kb", tsOf("宗谷"), "normal/VPWP50/宗谷地方気象台");
    expect(heads(s.lines)).toEqual([band("上川地方警戒・注意事項時系列情報", "11:00:00")]);
    await s.output.close();
    expect(heads(s.lines).at(-1)).toBe(band("宗谷地方警戒・注意事項時系列情報", "11:00:00"));
  });

  // P3-TL11-T02 acceptance / AC01 (3)
  it("T02 (d) 発表時刻か Control/Status の違う報が来ると、前のまとまりが先に出る", async () => {
    const s = sink();
    s.attach();
    send(s, "d1", tsOf("上川"), "normal/VPWP50/上川地方気象台");
    send(s, "d2", tsOf("宗谷"), "normal/VPWP50/宗谷地方気象台");
    send(s, "d3", tsOf("網走", undefined, undefined, "17:00:00"), "normal/VPWP50/網走地方気象台");
    expect(heads(s.lines)).toEqual([band(`${TS_TITLE} 2件`, "11:00:00")]);
    send(s, "d4", tsOf("網走", undefined, undefined, "17:00:00", training), "training/VPWP50/網走地方気象台");
    expect(heads(s.lines).at(-1)).toBe(band("網走地方警戒・注意事項時系列情報", "17:00:00"));
    vi.advanceTimersByTime(8_000);
    expect(heads(s.lines).at(-1)).toBe(band("網走地方警戒・注意事項時系列情報（訓練）", "17:00:00"));
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (2)(5)
  it("T02 (e) 同じ subject の 2 報目は件数を増やさず、種類の行は 2 報目の risks で作られる", async () => {
    const s = sink();
    s.attach();
    send(s, "e1", { ...tsOf("上川"), risks: [{ type: "風危険度", name: "警報級", code: "30" }] }, "normal/VPWP50/上川地方気象台");
    send(s, "e2", { ...tsOf("宗谷"), risks: [] }, "normal/VPWP50/宗谷地方気象台");
    send(s, "e3", { ...tsOf("上川"), risks: [{ type: "風危険度", name: "注意報級", code: "20" }] }, "normal/VPWP50/上川地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s)).toEqual([band(`${TS_TITLE} 2件`, "11:00:00"), "風危険度（注意報級）", "VPWP50 ・ 2 官署"]);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (2)・D-TS-IDENTITY（r0 の実不具合の芽）
  it("T02 (f) Head/Title が同じで EditorialOffice と PublishingOffice だけ違う 2 報は置き換えずに 2 件", async () => {
    const s = sink();
    s.attach();
    send(s, "f1", tsOf("宗谷", "稚内地方気象台"), "normal/VPWP50/稚内地方気象台");
    send(s, "f2", tsOf("宗谷", "旭川地方気象台"), "normal/VPWP50/旭川地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s)).toEqual([band(`${TS_TITLE} 2件`, "11:00:00"), KINDS_80, "VPWP50 ・ 2 官署"]);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (6)
  it("T02 (g) 81_04_01（取消）はすぐ出て、まとめていた同じ subject の報が束から消える", async () => {
    const s = sink();
    s.attach();
    send(s, "g1", tsOf("宗谷", "稚内地方気象台"), "normal/VPWP50/稚内地方気象台");
    send(s, "g2", tsOf("上川"), "normal/VPWP50/上川地方気象台");
    send(s, "g3", tsOf("網走"), "normal/VPWP50/網走地方気象台");
    send(s, "g4", cancel, "normal/VPWP50/稚内地方気象台");
    expect(heads(s.lines)).toEqual([terminal()([reportUnit(cancel)])[1]]);
    vi.advanceTimersByTime(8_000);
    expect(block(s)).toEqual([band(`${TS_TITLE} 2件`, "11:00:00"), KINDS_80, "VPWP50 ・ 2 官署"]);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (5)・AC03 (4)・D-TS-FOOTER
  it("T02 (l) 官署の数: 同じ PublishingOffice は 1 つ", async () => {
    const s = sink();
    s.attach();
    send(s, "l1", tsOf("上川", "上川地方気象台", "札幌管区気象台"), "normal/VPWP50/上川地方気象台");
    send(s, "l2", tsOf("宗谷", "宗谷地方気象台", "札幌管区気象台"), "normal/VPWP50/宗谷地方気象台");
    send(s, "l3", tsOf("網走", "網走地方気象台", "網走地方気象台"), "normal/VPWP50/網走地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s).at(-1)).toBe("VPWP50 ・ 2 官署");
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (5)・D-TS-FOOTER
  it("T02 (l) 官署の数: 同じ subject の置き換えで外した報の官署は数えない", async () => {
    const s = sink();
    s.attach();
    send(s, "l4", tsOf("上川", "上川地方気象台", "旭川地方気象台"), "normal/VPWP50/上川地方気象台");
    send(s, "l5", tsOf("宗谷", "宗谷地方気象台", "宗谷地方気象台"), "normal/VPWP50/宗谷地方気象台");
    send(s, "l6", tsOf("上川", "上川地方気象台", "宗谷地方気象台"), "normal/VPWP50/上川地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s).at(-1)).toBe("VPWP50 ・ 1 官署");
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (5)(6)・D-TS-FOOTER
  it("T02 (l) 官署の数: 取消で外した報の官署は数えない", async () => {
    const s = sink();
    s.attach();
    send(s, "l7", tsOf("宗谷", "稚内地方気象台", "稚内地方気象台"), "normal/VPWP50/稚内地方気象台");
    send(s, "l8", tsOf("上川", "上川地方気象台", "旭川地方気象台"), "normal/VPWP50/上川地方気象台");
    send(s, "l9", tsOf("網走", "網走地方気象台", "旭川地方気象台"), "normal/VPWP50/網走地方気象台");
    send(s, "l10", cancel, "normal/VPWP50/稚内地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s).at(-1)).toBe("VPWP50 ・ 1 官署");
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC03 (4)・D-TS-FOOTER
  it("T02 (l) 官署の数: どの報も PublishingOffice が空なら種類のコードだけ", async () => {
    const s = sink();
    s.attach();
    send(s, "l11", tsOf("上川", "上川地方気象台", ""), "normal/VPWP50/上川地方気象台");
    send(s, "l12", tsOf("宗谷", "宗谷地方気象台", ""), "normal/VPWP50/宗谷地方気象台");
    vi.advanceTimersByTime(8_000);
    expect(block(s).at(-1)).toBe("VPWP50");
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (8)
  it("T02 (i) --debug は置いた時に「まとめて出す」、入力の行の経過はブロックを積んだ時刻から、tips の待ちは置いた時に動く", async () => {
    vi.setSystemTime(at(10, 59, 0));
    const s = sink(80, { debug: true, tipInterval: 1 });
    s.attach();
    vi.advanceTimersByTime(55_000);
    s.output.sink.inputDone(inputDoneOf("i1", tsOf("宗谷"), [uf("normal/VPWP50/宗谷地方気象台", "i1")]));
    expect(s.lines).toEqual(["debug: VPWP50 i1（U-F、まとめて出す）"]);
    vi.advanceTimersByTime(5_000);
    expect(s.output.control.promptLabel("elapsed")).toContain("00:01:00");
    vi.advanceTimersByTime(3_000);
    expect(s.lines[2]).toBe(band("宗谷地方警戒・注意事項時系列情報", "11:00:00"));
    vi.advanceTimersByTime(10_000);
    expect(s.output.control.promptLabel("elapsed")).toContain("00:00:10");
    vi.advanceTimersByTime(36_000);
    expect(s.lines.some((text) => text.includes("Tip:"))).toBe(false);
    await s.output.close();
  });

  // P3-TL11-T02 acceptance / AC01 (1)(4)
  it("T02 (j) 降灰のまとまりと同時に持ち、どちらも自分の期限で出て、VPWS50 と EEW はどちらも出さずにすぐ出る", async () => {
    const s = sink();
    s.attach();
    const ash = (name: string, code: string) => shortOf(reportOf("66_01_01_210517_VFVO53.xml", "U-V", (xml) => xml.replace(/桜島/g, name)
      .replace(/<Code>506<\/Code>/g, `<Code>${code}</Code>`).replace("<EventID>506</EventID>", `<EventID>${code}</EventID>`)));
    s.output.sink.inputDone(inputDoneOf("v1", ash("阿蘇山", "503")));
    s.output.sink.inputDone(inputDoneOf("v2", ash("桜島", "506")));
    vi.advanceTimersByTime(2_000);
    s.output.sink.inputDone(inputDoneOf("t1", tsOf("上川"), [uf("normal/VPWP50/上川地方気象台", "t1")]));
    s.output.sink.inputDone(inputDoneOf("t2", tsOf("宗谷"), [uf("normal/VPWP50/宗谷地方気象台", "t2")]));
    const [eew] = eewUnits(["37_01_01_240613_VXSE43.xml"]).flat();
    if (eew.kind !== "eew") throw new Error("not eew");
    const weather = terminalReport(decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before.xml", "replay", undefined, "VPWS50"), "U-W");
    if (weather == null) throw new Error("no VPWS50");
    s.output.sink.inputDone(inputDoneOf("x1", null, [eewOutcome(eew.subject)]));
    s.output.sink.inputDone(inputDoneOf("x2", weather));
    expect(heads(s.lines)).toEqual([terminal()([eew])[1], terminal()([reportUnit(weather)])[1]]);
    vi.advanceTimersByTime(6_000);
    expect(heads(s.lines).at(-1)).toBe(band("降灰予報（定時） 2火山", "14:00:00"));
    vi.advanceTimersByTime(1_000);
    expect(heads(s.lines)).toHaveLength(3);
    vi.advanceTimersByTime(1_000);
    expect(heads(s.lines).at(-1)).toBe(band(`${TS_TITLE} 2件`, "11:00:00"));
    await s.output.close();
  });
});

describe("P3-TL11 時系列情報の種類の材料と束の描画", () => {
  // P3-TL11-T03 contractBoundary / AC02（TerminalReport の short の risks の形）
  const expected: readonly Risk[] = [{ type: "土砂災害危険度", name: "警戒レベル4相当", code: "41" }, { type: "大雨浸水危険度", name: "特別警報級", code: "50" }];
  const inBase = (inserted: string) => (xml: string): string => {
    const next = xml.replace("<Base>", `<Base>${inserted}`);
    expect(next).not.toBe(xml);
    return next;
  };
  const WIND = "<Significancy refID=\"1\" type=\"風危険度\"><Name>特別警報級</Name><Code>50</Code></Significancy>";
  it("T03 81_02_01 は type ごとに最も重い 2 組（Name と type は電文の字）", () => {
    expect(shortOf(reportOf(TS, "U-F")).risks).toEqual(expected);
  });
  // 不変条件: 正規の道 Property/SignificancyPart/Base（/Local）の外の Significancy は risks に入らない（作者の裁定 2026-11-09 夕）。
  // 置き場所は 81_02_01 の最初の Base の中、WindSpeedPart は最初の Property の中。
  const inProperty = (inserted: string) => (xml: string): string => {
    const next = xml.replace("<SignificancyPart>", `${inserted}<SignificancyPart>`);
    expect(next).not.toBe(xml);
    return next;
  };
  it("T03 正規の道の外の Significancy は、Addition・未知の要素・ほかの Part の下・道の段に挟んだ未知の要素のどれでも入れない（r0〜r3 ヘルツ P2）", () => {
    const placements = [
      ["Base/Addition/Significancy（r0 の再現）", `<Addition>${WIND}</Addition>`],
      ["Base/Addition/Base/Significancy（r0 ヘルツ P2）", `<Addition><Base>${WIND}</Base></Addition>`],
      ["Base/Addition/Base/Local/Significancy", `<Addition><Base><Local>${WIND}</Local></Base></Addition>`],
      ["Base/Addition/SignificancyPart/Base/Significancy（r1 ヘルツ P2）", `<Addition><SignificancyPart><Base>${WIND}</Base></SignificancyPart></Addition>`],
      ["Base/Local/Addition/Significancy", `<Local><Addition>${WIND}</Addition></Local>`],
      ["Base/Addition/Addition/Base/Significancy", `<Addition><Addition><Base>${WIND}</Base></Addition></Addition>`],
      ["Base/Unknown/SignificancyPart/Base/Significancy（r2 ヘルツ P2）", `<Unknown><SignificancyPart><Base>${WIND}</Base></SignificancyPart></Unknown>`],
    ] as const;
    for (const [where, inserted] of placements) expect(shortOf(reportOf(TS, "U-F", inBase(inserted))).risks, where).toEqual(expected);
    // 道の上の段に未知の要素を挟み、その下に道の残りを置いた形（r3 ヘルツ P2 と同じ族）。
    const rest = `<Property><Type>風</Type><SignificancyPart><Base>${WIND}</Base></SignificancyPart></Property>`;
    const wrapped = [
      ["Kind/Unknown/Property/SignificancyPart/Base/Significancy（r3 ヘルツ P2）", "<Kind>", `<Unknown>${rest}</Unknown>`],
      ["Item/Unknown/Kind/Property/…/Significancy", "<Item>", `<Unknown><Kind>${rest}</Kind></Unknown>`],
      ["TimeSeriesInfo/Unknown/Item/Kind/Property/…/Significancy", "<TimeSeriesInfo>", `<Unknown><Item><Kind>${rest}</Kind></Item></Unknown>`],
    ] as const;
    for (const [where, tag, inserted] of wrapped) {
      const edit = (xml: string): string => { const next = xml.replace(tag, `${tag}${inserted}`); expect(next).not.toBe(xml); return next; };
      expect(shortOf(reportOf(TS, "U-F", edit)).risks, where).toEqual(expected);
    }
    // 契約の制限: SignificancyPart 以外の Part の下は U-F が読んでも採らない。
    expect(shortOf(reportOf(TS, "U-F", inProperty(`<WindSpeedPart><Base>${WIND}</Base></WindSpeedPart>`))).risks, "Property/WindSpeedPart/Base/Significancy").toEqual(expected);
    // 対照: 道の上の Base/Local の直下は入る（全部を外して通っていないことの確かめ）。
    expect(shortOf(reportOf(TS, "U-F", inBase(`<Local>${WIND}</Local>`))).risks).toEqual([{ type: "風危険度", name: "特別警報級", code: "50" }, ...expected]);
  });
  it("T03 81_01_01（Code が 00・01・11 だけ）は空の並び、81_04_01（取消）と VFVO53 は null", () => {
    expect(shortOf(reportOf("81_01_01_260129_VPWP50.xml", "U-F")).risks).toEqual([]);
    expect(shortOf(reportOf("81_04_01_260605_VPWP50_cancel.xml", "U-F")).risks).toBeNull();
    expect(shortOf(reportOf("66_01_01_210517_VFVO53.xml", "U-V")).risks).toBeNull();
  });

  // P3-TL11-T04 acceptance / AC03・AC05
  const base = tsOf("上川");
  const unit = (count: number, offices: number, risks: readonly Risk[], report: Short = base): TerminalUnit => ({ kind: "timeseries", report, count, offices, risks, prompt: null });
  it("T04 (a) 2 報を束ねると type ごとに最も重い 1 つを Code の大きい順に並べる", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(11, 0, 0));
    const s = sink();
    s.output.sink.inputDone(inputDoneOf("a1", { ...tsOf("上川"), risks: [{ type: "風危険度", name: "注意報級", code: "20" }] }, [uf("normal/VPWP50/上川地方気象台", "a1")]));
    s.output.sink.inputDone(inputDoneOf("a2", { ...tsOf("宗谷"), risks: [{ type: "風危険度", name: "警報級", code: "30" }, { type: "波危険度", name: "注意報級", code: "20" }] },
      [uf("normal/VPWP50/宗谷地方気象台", "a2")]));
    await s.output.close();
    vi.useRealTimers();
    expect(s.lines.slice(2, -1)).toEqual(["風危険度（警報級）　波危険度（注意報級）"]);
  });
  it("T04 (b) どの報も risks が空なら帯と末尾の行だけ", () => {
    expect(terminal()([unit(2, 2, [])])).toEqual(["", band(`${TS_TITLE} 2件`, "11:00:00"), "VPWP50 ・ 2 官署"]);
  });
  it("T04 (c) 帯は Control/Title から版の印を除いた題名と「 N件」、訓練は印、段は普通", () => {
    expect(terminal()([unit(2, 2, [], tsOf("上川", undefined, undefined, undefined, training))])[1]).toBe(band(`${TS_TITLE}（訓練） 2件`, "11:00:00"));
    const banded = terminal(80, 3)([unit(2, 2, [])])[1];
    expect(banded.startsWith(painter(3)("rulePlain", "━ ") + painter(3)("bandPlain", `${TS_TITLE} 2件`))).toBe(true);
  });
  it("T04 (d) 32 組の 2 件と 64 件の束を 56・80・100 桁、色 0 と 3 で描くと、桁数を越えず、帯は 1 行、組は折れず、色 0 の帯は ━ の形", () => {
    const risks: Risk[] = Array.from({ length: 32 }, (_, index) => ({ type: `大雨浸水危険度${index}`, name: index % 2 === 0 ? "警戒レベル４相当" : "特別警報級", code: String(20 + index) }));
    const pairs = new Set(risks.map((risk) => `${risk.type}（${risk.name}）`));
    for (const count of [2, 64]) for (const columns of [56, 80, 100]) for (const level of [0, 3] as const) {
      const lines = terminal(columns, level)([unit(count, count, risks)]).map(plain);
      for (const text of lines) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
      expect(lines[1].trim().endsWith("発表 ━")).toBe(true);
      if (level === 0) expect(lines[1]).toBe(band(`${TS_TITLE} ${count}件`, "11:00:00", columns));
      const shown = lines.slice(2, -1).flatMap((text) => text.trim().split("　"));
      expect(new Set(shown)).toEqual(pairs);
    }
  });
  it("T04 (e) 末尾の行は官署の数 58 で「VPWP50 ・ 58 官署」、0 で「VPWP50」", () => {
    expect(terminal()([unit(58, 58, [])]).at(-1)).toBe("VPWP50 ・ 58 官署");
    expect(terminal()([unit(2, 0, [])]).at(-1)).toBe("VPWP50");
  });
});

// ---- 緊急地震速報の震源の名前 ----
type Eew = Extract<TerminalUnit, { kind: "eew" }>;
function eewOf(path: string, transform?: (xml: string) => string): Eew {
  const [unit] = eewUnits([transform == null ? path : { path, transform }]).flat();
  if (unit?.kind !== "eew") throw new Error("not eew");
  return unit;
}
const withFacts = (unit: Eew, facts: SubjectOutcome["facts"]): Eew => ({ ...unit, subject: { ...unit.subject, facts: { ...unit.subject.facts, ...facts } } });

describe("P3-TL11 緊急地震速報の震源の名前", () => {
  // P3-TL11-T05 acceptance / AC04
  it("T05 名前だけがその報の帯の罫線の役目の太字（警報・予報・2 段目・最大予測震度 7・続報・仮定の震源）", () => {
    const paint = painter(3);
    const named = (role: Role, name: string): string => paint("strong", paint(role, name));
    const hypocenterLine = (lines: readonly string[]): string => lines.find((text) => plain(text).includes("震源: "))!;
    const warning = eewOf("37_01_01_240613_VXSE43.xml");
    expect(hypocenterLine(terminal(80, 3)([warning]))).toContain(`震源: ${named("ruleWarning", "豊後水道")} ・ M5.8 ・ 深さ30km`);

    const forecast = eewOf("77_01_01_240613_VXSE45.xml"), draw = terminal(80, 3);
    expect(hypocenterLine(draw([forecast]))).toContain(`震源: ${named("ruleCaution", "豊後水道")} ・ M4.2 ・ 深さ40km`);
    expect(hypocenterLine(draw([withFacts(forecast, { eventId: "B" })]))).toContain(`震源: ${named("ruleCaution2", "豊後水道")} ・ M4.2`);

    const top = eewOf("37_01_01_240613_VXSE43.xml", (xml) => xml.replace("<ForecastInt><From>5-</From><To>5-</To></ForecastInt>", "<ForecastInt><From>7</From><To>7</To></ForecastInt>"));
    expect(hypocenterLine(terminal(80, 3)([top]))).toContain(`震源: ${named("rulePurple", "豊後水道")} ・ M5.8`);

    const follow = terminal(80, 3), report = jsonRecord(forecast.subject.facts.report);
    follow([forecast]);
    expect(hypocenterLine(follow([withFacts(forecast, { report: { ...report, hypocenter: "日向灘" } })])))
      .toContain(`震源: ${paint("dim", "豊後水道 →  ")}${named("ruleCaution", "日向灘")} ・ M4.2`);

    const assumed = eewOf("77_02_01_260101_VXSE45_PLUM.xml");
    const name = String(jsonRecord(assumed.subject.facts.report)?.hypocenter);
    const line = hypocenterLine(terminal(80, 3)([assumed]));
    const role = assumed.subject.facts.warningClass === "warning" ? "ruleWarning" : "ruleCaution";
    expect(line).toContain(`震源: ${named(role, name)}（仮定の震源、PLUM法で推定）`);
    expect(plain(line)).not.toMatch(/M[0-9]|深さ/);
  });
});
