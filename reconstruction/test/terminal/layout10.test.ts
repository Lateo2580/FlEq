import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistenceStatus, RuntimePublishedOutcome, SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import type { BriefingUnitState } from "../../contracts/p3-briefing-unit.types";
import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { painter } from "../../src/terminal/color";
import type { Role } from "../../src/terminal/color";
import { createRenderer, width } from "../../src/terminal/format";
import type { TerminalUnit } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import type { TerminalOptions } from "../../src/terminal/output";
import { reduceBriefingUnit } from "../../src/units/briefing/briefing-unit";
import { at, band, decodeFixture, eewOutcome, eewUnits, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-010 の試験（降灰予報〔定時〕のまとめ・同時に進む EEW の帯の濃さ・記録的短時間大雨の VPOA50 と VPBS50）。
type Short = Extract<TerminalReport, { kind: "short" }>;
const shortOf = (report: TerminalReport): Short => { if (report.kind !== "short") throw new Error("not short"); return report; };
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
// 偽の時計の端末。monotonic は Date.now()、壁時計は shift でずらせる（T04 (h)）。書き出しは色 0・columns 桁の行。
function sink(columns = 80, options: TerminalOptions = {}) {
  const renderer = createRenderer(0), lines: string[] = [];
  let offset = 0;
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now() + offset, monotonicMs: Date.now() }), ...options,
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  return { output, lines, attach: () => { output.attach({ status: () => CONNECTED }); }, shift: (ms: number) => { offset += ms; } };
}
const bands = (lines: readonly string[], line: string): number => lines.filter((text) => text === line).length;

// ---- 降灰予報（定時） ----
const ASH = "66_01_01_210517_VFVO53.xml";
// 66_01_01（桜島、EventID と Area/Code 506）の火山名・番号・発表時刻を替えた報。edit はその後の書き換え（Status・InfoType）。
function ashOf(name: string, code: string, edit: (xml: string) => string = (xml) => xml, time = "17:00:00"): Short {
  return shortOf(reportOf(ASH, "U-V", (xml) => edit(xml.replace(/桜島/g, name).replace(/<Code>506<\/Code>/g, `<Code>${code}</Code>`)
    .replace("<EventID>506</EventID>", `<EventID>${code}</EventID>`).replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>2026-11-08T${time}+09:00`))));
}
const FIVE = [["阿蘇山", "503"], ["桜島", "506"], ["薩摩硫黄島", "509"], ["諏訪之瀬島", "511"], ["霧島山（新燃岳）", "551"]] as const;
const ASH_TITLE = "降灰予報（定時）";
const training = (xml: string): string => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>");
const cancelled = (xml: string): string => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>");

describe("P3-TL10 降灰予報（定時）のまとめ", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(17, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  // P3-TL10-T01 regression / AC01・AC04（2026-11-08 17:00、5 火山が 4 行のブロック 5 つで並んだ）
  it("T01 5 火山を 17:00:01〜03 に渡すと 17:00:10 までは何も出ず、17:00:11 の tick に 60 桁で 7 行のブロックが 1 つ。定期要約は火山 5 件", async () => {
    const s = sink(60);
    s.attach();
    const reports = FIVE.map(([name, code]) => ashOf(name, code));
    [1_000, 1_000, 0, 1_000, 0].forEach((step, index) => { vi.advanceTimersByTime(step); s.output.sink.inputDone(inputDoneOf(`v${index}`, reports[index])); });
    vi.advanceTimersByTime(7_000);
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(s.lines).toEqual(["", band(`${ASH_TITLE} 5火山`, "17:00:00", 60), ...FIVE.map(([name]) => name), "VFVO53 ・ 気象庁"]);
    s.output.control.summaryNow();
    expect(s.lines.at(-1)).toBe("── 17:00〜17:00 の受信 ── 火山 5件");
    await s.output.close();
  });

  // P3-TL10-T02 acceptance / AC01・AC04
  it("T02 (a) 1 報は 8 秒後に今の 1 報の形 (b) 20 報目でその場 (c) 5 秒ごとなら最初から 90 秒 (k) tick の前の入力の初めに期限を見る", async () => {
    const one = sink();
    one.attach();
    const sakura = ashOf("桜島", "506");
    one.output.sink.inputDone(inputDoneOf("a", sakura));
    vi.advanceTimersByTime(7_000);
    expect(one.lines).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(one.lines).toEqual(terminal()([reportUnit(sakura)]));
    expect(one.lines[1]).toBe(band(`${ASH_TITLE} 桜島`, "17:00:00"));

    const many = sink();
    const twenty = Array.from({ length: 20 }, (_, index) => ashOf(`火山${index + 1}`, String(600 + index)));
    twenty.slice(0, 19).forEach((report, index) => many.output.sink.inputDone(inputDoneOf(`m${index}`, report)));
    expect(many.lines).toEqual([]);
    many.output.sink.inputDone(inputDoneOf("m19", twenty[19]));
    expect(many.lines[1]).toBe(band(`${ASH_TITLE} 20火山`, "17:00:00"));
    expect(many.lines.slice(2, -1)).toEqual(twenty.map((_, index) => `火山${index + 1}`));

    const slow = sink();
    slow.attach();
    twenty.slice(0, 18).forEach((report, index) => { if (index > 0) vi.advanceTimersByTime(5_000); slow.output.sink.inputDone(inputDoneOf(`s${index}`, report)); });
    vi.advanceTimersByTime(4_999);
    expect(slow.lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(slow.lines[1]).toBe(band(`${ASH_TITLE} 18火山`, "17:00:00"));

    const edge = sink();
    edge.attach();
    vi.advanceTimersByTime(100);
    edge.output.sink.inputDone(inputDoneOf("ka", ashOf("阿蘇山", "503")));
    vi.advanceTimersByTime(8_400);
    expect(edge.lines).toEqual([]);
    edge.output.sink.inputDone(inputDoneOf("kb", sakura));
    expect(edge.lines[1]).toBe(band(`${ASH_TITLE} 阿蘇山`, "17:00:00"));
    expect(edge.lines.some((text) => text.includes("桜島"))).toBe(false);
    vi.advanceTimersByTime(8_500);
    expect(edge.lines.filter((text) => text.startsWith("━ "))).toEqual([band(`${ASH_TITLE} 阿蘇山`, "17:00:00"), band(`${ASH_TITLE} 桜島`, "17:00:00")]);
    for (const s of [one, many, slow, edge]) await s.output.close();
  });

  // P3-TL10-T02 acceptance / AC01 (3)(4)(6)(2)
  it("T02 (d) 鍵の違う報で先に出る (e) 同じ火山は 1 行で最後 (f) 同じ Control/Status の VFVO55 の前に出て、VPWS50 と EEW は待たない (g) 取消はすぐ出て束から外す (h) close で出る", async () => {
    const s = sink();
    s.attach();
    const send = (id: string, report: TerminalReport | null, outcomes: readonly RuntimePublishedOutcome[] = []) => { s.output.sink.inputDone(inputDoneOf(id, report, outcomes)); };
    const heads = () => s.lines.filter((text) => text.startsWith("━ "));
    send("d1", ashOf("阿蘇山", "503"));
    send("d2", ashOf("桜島", "506"));
    send("d3", ashOf("霧島山（新燃岳）", "551", undefined, "18:00:00"));
    expect(heads()).toEqual([band(`${ASH_TITLE} 2火山`, "17:00:00")]);
    send("d4", ashOf("霧島山（新燃岳）", "551", training, "18:00:00"));
    expect(heads().at(-1)).toBe(band(`${ASH_TITLE} 霧島山（新燃岳）`, "18:00:00"));
    vi.advanceTimersByTime(8_000);
    expect(heads().at(-1)).toBe(band(`${ASH_TITLE}（訓練） 霧島山（新燃岳）`, "18:00:00"));

    s.lines.length = 0;
    send("e1", ashOf("桜島", "506"));
    send("e2", ashOf("阿蘇山", "503"));
    send("e3", ashOf("桜島", "506"));
    const vfvo55 = reportOf("66_01_03_210514_VFVO55.xml", "U-V");
    send("f0", reportOf("66_01_03_210514_VFVO55.xml", "U-V", training));
    expect(heads()).toHaveLength(1);
    send("f1", vfvo55);
    const sent = terminal()([reportUnit(vfvo55)])[1];
    expect(heads()).toEqual([heads()[0], band(`${ASH_TITLE} 2火山`, "17:00:00"), sent]);
    expect(s.lines.slice(s.lines.indexOf(band(`${ASH_TITLE} 2火山`, "17:00:00")) + 1).slice(0, 2)).toEqual(["阿蘇山", "桜島"]);

    s.lines.length = 0;
    send("g1", ashOf("桜島", "506"));
    send("g2", ashOf("阿蘇山", "503"));
    send("g3", ashOf("霧島山（新燃岳）", "551"));
    const [eew] = eewUnits(["37_01_01_240613_VXSE43.xml"]).flat();
    if (eew.kind !== "eew") throw new Error("not eew");
    // 小さい VPWS50（府県予報区等の層の無い合成の報。15_18_01 は 4.5 MB）。全国の集約通報の判定は通るが、層が無いので「前と同じ」の比べには入らない。
    const weather = terminalReport(decodeFixture("weather-alert-kind-area/synthetic-vpws50-change-density-before.xml", "replay", undefined, "VPWS50"), "U-W");
    if (weather?.kind !== "short" || weather.head.headType !== "VPWS50") throw new Error("not VPWS50");
    const cancel = ashOf("桜島", "506", cancelled);
    send("x1", null, [eewOutcome(eew.subject)]);
    send("x2", weather);
    send("g4", cancel);
    expect(heads()).toEqual([terminal()([eew])[1], terminal()([reportUnit(weather)])[1], terminal()([reportUnit(cancel)])[1]]);
    vi.advanceTimersByTime(8_000);
    expect(heads().at(-1)).toBe(band(`${ASH_TITLE} 2火山`, "17:00:00"));
    expect(s.lines.slice(-3)).toEqual(["阿蘇山", "霧島山（新燃岳）", "VFVO53 ・ 気象庁"]);

    send("h1", ashOf("桜島", "506"));
    send("h2", ashOf("阿蘇山", "503"));
    await s.output.close();
    expect(heads().at(-1)).toBe(band(`${ASH_TITLE} 2火山`, "17:00:00"));
  });

  // P3-TL10-T02 acceptance / AC01 (8)
  it("T02 (i) --debug は置いた時に「まとめて出す」、入力の行の経過はブロックを積んだ時刻から、tips の待ちは置いた時に動く", async () => {
    vi.setSystemTime(at(16, 59, 0));
    const s = sink(80, { debug: true, tipInterval: 1 });
    s.attach();
    vi.advanceTimersByTime(55_000);
    s.output.sink.inputDone(inputDoneOf("i1", ashOf("桜島", "506")));
    expect(s.lines).toEqual(["debug: VFVO53 i1（U-V、まとめて出す）"]);
    vi.advanceTimersByTime(5_000);
    expect(s.output.control.promptLabel("elapsed")).toContain("00:01:00");
    vi.advanceTimersByTime(3_000);
    expect(s.lines[2]).toBe(band(`${ASH_TITLE} 桜島`, "17:00:00"));
    vi.advanceTimersByTime(10_000);
    expect(s.output.control.promptLabel("elapsed")).toContain("00:00:10");
    vi.advanceTimersByTime(36_000);
    expect(s.lines.some((text) => text.includes("Tip:"))).toBe(false);
    await s.output.close();
  });

  // P3-TL10-T02 acceptance / AC04 (5)
  it("T02 (j) 2 火山と 20 火山の束は 56・80・100 桁、色 0 と 3 で桁数を越えず、帯は 1 行、名前は折れず、色 0 の帯は ━ の形", () => {
    const names = Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? `霧島山（新燃岳）${index}` : `薩摩硫黄島${index}`);
    const reports = names.map((name, index) => ashOf(name, String(700 + index)));
    for (const count of [2, 20]) for (const columns of [56, 80, 100]) for (const level of [0, 3] as const) {
      const unit: TerminalUnit = { kind: "ashfall", reports: reports.slice(0, count), prompt: null };
      const lines = terminal(columns, level)([unit]).map(plain);
      for (const text of lines) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
      expect(lines.slice(2, -1).map((text) => text.trim())).toEqual(names.slice(0, count));
      expect(lines[1].trim().endsWith("発表 ━")).toBe(true);
      if (level === 0) expect(lines[1]).toBe(band(`${ASH_TITLE} ${count}火山`, "17:00:00", columns));
    }
  });
});

// ---- 同時に進む EEW の帯の濃さ ----
type Eew = Extract<TerminalUnit, { kind: "eew" }>;
function eewOf(path: string, transform?: (xml: string) => string): Eew {
  const [unit] = eewUnits([transform == null ? path : { path, transform }]).flat();
  if (unit?.kind !== "eew") throw new Error("not eew");
  return unit;
}
// 同じ報の EventID と受信の時刻を替えた単位（renderer は facts.eventId と nowMs だけで地震を分ける）。
const retarget = (unit: Eew, eventId: string, nowMs = unit.nowMs, extra: Readonly<Record<string, boolean>> = {}): Eew =>
  ({ ...unit, nowMs, subject: { ...unit.subject, facts: { ...unit.subject.facts, eventId, ...extra } } });

describe("P3-TL10 同時に進む EEW の帯の濃さ", () => {
  // P3-TL10-T03 regression / AC02・AC04（旧築の地震ごとの帯の色分けが新築に無い）
  it("T03 2 つ目の地震は 2 段目、終わった・10 分過ぎた地震の段は次に使え、4 つ目は 1 段目に戻り、続報は段を保つ。最も重い段・取消・色 0・256 色は変えない", () => {
    const paint = painter(3);
    const fillOf = (lines: readonly string[]): string => lines[1];
    const filledBy = (role: Role) => (lines: readonly string[]) => fillOf(lines) === paint(role, plain(fillOf(lines)));
    const warning = eewOf("37_01_01_240613_VXSE43.xml"), A = String(warning.subject.facts.eventId);
    const draw = terminal(80, 3);
    expect(filledBy("bandWarning")(draw([warning]))).toBe(true);
    expect(filledBy("bandWarning2")(draw([retarget(warning, "B")]))).toBe(true);
    expect(filledBy("bandWarning")(draw([warning]))).toBe(true);
    draw([retarget(eewOf("77_01_30_260101_VXSE45_FINAL.xml"), A)]);
    expect(filledBy("bandWarning2")(draw([retarget(warning, "B")]))).toBe(true);
    expect(filledBy("bandWarning")(draw([retarget(warning, "C")]))).toBe(true);
    expect(filledBy("bandWarning3")(draw([retarget(warning, "D")]))).toBe(true);
    expect(filledBy("bandWarning")(draw([retarget(warning, "E")]))).toBe(true);
    // 最も重い段（最大予測震度 7）と取消は段によらず同じ。
    // 縦線は帯の下の行の頭（地の色の空白 1 桁）。2 段目の警報も 1 段目と同じ縦線。
    const barred = (role: Role, lines: readonly string[]) => lines.slice(2).every((text) => text.startsWith(`${paint(role, " ")} `));
    expect(barred("barWarning", draw([retarget(warning, "B")]))).toBe(true);
    const top = eewOf("37_01_01_240613_VXSE43.xml", (xml) => xml.replace("<ForecastInt><From>5-</From><To>5-</To></ForecastInt>", "<ForecastInt><From>7</From><To>7</To></ForecastInt>"));
    const topLines = draw([retarget(top, "F")]);
    expect([filledBy("bandTop")(topLines), barred("barPurple", topLines)]).toEqual([true, true]);
    const cancel = eewOf("37_01_03_240613_VXSE43.xml"), cancelLines = draw([retarget(cancel, "D")]);
    expect([filledBy("bandCancel")(cancelLines), barred("barCancel", cancelLines)]).toEqual([true, true]);

    const ended = terminal(80, 3);
    ended([warning]);
    expect(filledBy("bandCancel")(ended([cancel]))).toBe(true);
    expect(filledBy("bandWarning")(ended([retarget(warning, "C")]))).toBe(true);
    const lapsed = terminal(80, 3);
    lapsed([warning]);
    expect(filledBy("bandWarning")(lapsed([retarget(warning, "C", warning.nowMs + 10 * 60_000 + 1)]))).toBe(true);

    const forecast = eewOf("77_01_01_240613_VXSE45.xml"), caution = terminal(80, 3);
    caution([forecast]);
    const second = caution([retarget(forecast, "B")])[1];
    expect(second.startsWith(paint("ruleCaution2", "━ "))).toBe(true);
    expect(second).toContain(paint("bandCaution2", "緊急地震速報（予報） 第1報"));

    const none = terminal(80, 0);
    none([warning]);
    expect(none([retarget(warning, "B")])[1]).toBe(band("緊急地震速報（警報） 第1報", "23:14:59"));
    const lower = createRenderer(2);
    lower.render({ columns: 80, dropped: 0, units: [warning] });
    const lowered = lower.render({ columns: 80, dropped: 0, units: [retarget(warning, "B")] }).split("\n")[1];
    expect(lowered).toBe(painter(2)("bandWarning", plain(lowered)));
  });
});

// ---- 記録的短時間大雨の VPOA50 と VPBS50 ----
const OA = "phase6b_VPOA50_JPTC202608211633_202608211633.xml", BS = "phase6b_VPBS50_KJPTC202608211633_202608211633.xml";
const P = "vpoa50-subject";
// U-B の accepted の subject（T05 で U-B から取った形のうち、端末が読む subject・transition・source.inputId）。
const ubSubject = (subject: string, inputId: string, transition: string): SubjectOutcome => ({ subject, operation: "normal", informationType: "発表", transition,
  severity: null, facts: {}, changedFields: [], source: { inputId, origin: "live", operation: "normal", family: "VPOA50", subject, reportDateTimeRaw: "",
    controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" } });
const ub = (...subjects: SubjectOutcome[]): RuntimePublishedOutcome => ({ unit: "U-B", outcome: { kind: "accepted", change: "revisionOnly", subjects } });

describe("P3-TL10 記録的短時間大雨の VPOA50 と VPBS50", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(16, 33, 5)); });
  afterEach(() => { vi.useRealTimers(); });
  const oa = shortOf(reportOf(OA, "U-B")), bs = shortOf(reportOf(BS, "U-B"));
  const oaCancel = shortOf(reportOf(OA, "U-B", cancelled));
  const OA_BAND = terminal()([reportUnit(oa)])[1], BS_BAND = terminal()([reportUnit(bs)])[1];

  // P3-TL10-T04 regression / AC03（2026-11-08 16:33、7 ms 差で紫のブロックが 2 つ）
  it("T04 (a) aliased は出ない (b) held の後の VPBS50 で 1 ブロック (c) 60 秒で出て訂正は期限を延ばさない (d) 取消で何も出ない (e) close で出る (f) --debug と定期要約", async () => {
    const a = sink(80, { debug: true });
    a.attach();
    a.output.sink.inputDone(inputDoneOf("b1", bs, [ub(ubSubject("bs", "b1", "active"))]));
    vi.advanceTimersByTime(7);
    a.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "aliased"))]));
    expect([bands(a.lines, BS_BAND), bands(a.lines, OA_BAND)]).toEqual([1, 0]);
    expect(a.lines.at(-1)).toBe("debug: VPOA50 a1（U-B、出さない・対応報あり）");
    a.output.control.summaryNow();
    expect(a.lines.at(-1)).toContain("気象 2件");
    await a.output.close();

    const b = sink(80, { debug: true });
    b.attach();
    b.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    expect(b.lines).toEqual(["debug: VPOA50 a1（U-B、対応報を待つ）"]);
    vi.advanceTimersByTime(7);
    b.output.sink.inputDone(inputDoneOf("b1", bs, [ub(ubSubject("bs", "b1", "active"), ubSubject(P, "a1", "aliased"))]));
    vi.advanceTimersByTime(61_000);
    expect([bands(b.lines, BS_BAND), bands(b.lines, OA_BAND)]).toEqual([1, 0]);
    await b.output.close();
    expect(bands(b.lines, OA_BAND)).toBe(0);

    const c = sink();
    c.attach();
    c.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    vi.advanceTimersByTime(30_000);
    c.output.sink.inputDone(inputDoneOf("a2", oa, [ub(ubSubject(P, "a2", "held"))]));
    vi.advanceTimersByTime(29_999);
    expect(c.lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bands(c.lines, OA_BAND)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(bands(c.lines, OA_BAND)).toBe(1);

    const d = sink(80, { debug: true });
    d.attach();
    d.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    d.output.sink.inputDone(inputDoneOf("c1", oaCancel, [ub(ubSubject(P, "c1", "cancelled"))]));
    expect(d.lines.at(-1)).toBe("debug: VPOA50 c1（U-B、出さない・待っていた報の取消）");
    vi.advanceTimersByTime(61_000);
    await d.output.close();
    expect(d.lines.filter((text) => !text.startsWith("debug: "))).toEqual([]);

    const e = sink();
    e.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    expect(e.lines).toEqual([]);
    await e.output.close();
    expect(bands(e.lines, OA_BAND)).toBe(1);
    await c.output.close();
  });

  // P3-TL10-T04 regression / AC03 (3)(4)・残存 (11)(12)
  it("T04 (g) 257 件目で最も古い待ちが出て表は 256 のまま (h) 壁時計を戻しても単調時計で 60 秒、期限を過ぎた待ちは次の入力より先に出る", async () => {
    const g = sink();
    g.attach();
    for (let index = 0; index <= 256; index += 1) g.output.sink.inputDone(inputDoneOf(`i${index}`, oa, [ub(ubSubject(`s${index}`, `i${index}`, "held"))]));
    expect(bands(g.lines, OA_BAND)).toBe(1);
    g.output.sink.inputDone(inputDoneOf("b0", bs, [ub(ubSubject("bs", "b0", "active"), ubSubject("s0", "i0", "aliased"))]));
    expect([bands(g.lines, OA_BAND), bands(g.lines, BS_BAND)]).toEqual([1, 1]);
    vi.advanceTimersByTime(60_000);
    expect(bands(g.lines, OA_BAND)).toBe(257);
    await g.output.close();

    const h = sink();
    h.attach();
    h.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    vi.advanceTimersByTime(10_000);
    h.shift(-3_600_000);
    vi.advanceTimersByTime(50_000);
    expect(bands(h.lines, OA_BAND)).toBe(1);
    vi.advanceTimersByTime(10_000);
    h.output.sink.inputDone(inputDoneOf("b1", bs, [ub(ubSubject("bs", "b1", "active"), ubSubject(P, "a1", "aliased"))]));
    expect([bands(h.lines, OA_BAND), bands(h.lines, BS_BAND)]).toEqual([1, 1]);
    await h.output.close();

    const early = sink();
    early.attach();
    vi.advanceTimersByTime(500);
    early.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    vi.advanceTimersByTime(60_100);
    expect(early.lines).toEqual([]);
    early.output.sink.inputDone(inputDoneOf("b1", bs, [ub(ubSubject("bs", "b1", "active"))]));
    expect(early.lines.indexOf(OA_BAND)).toBe(1);
    expect(early.lines.indexOf(BS_BAND)).toBeGreaterThan(1);
    await early.output.close();
  });

  // P3-TL10-T05 contractBoundary / AC03（端末が頼る U-B の outcome の形と 60 秒）
  it("T05 U-B は VPOA50 を自分の記録の held で返し、受けて 60,000 ms で released、VPBS50 は held の VPOA50 を aliased で載せ、逆の順は自分の記録が aliased", () => {
    const SAVED: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null };
    const empty: BriefingUnitState = { schemaVersion: "p3-briefing-unit-v7", contentRevision: 0, currents: [], intents: [], persistence: SAVED };
    const rain = decodeFixture(OA), record = decodeFixture(BS), received = Date.parse(rain.reportDateTimeRaw);
    const receive = (state: BriefingUnitState, material: typeof rain, wallTimeMs: number) =>
      reduceBriefingUnit(state, { kind: "receive", material, clock: { wallTimeMs, monotonicMs: 0 } });
    const subjects = (step: ReturnType<typeof receive>) => step.outcomes.flatMap((outcome) => outcome.kind === "accepted" ? outcome.subjects : []);
    const held = receive(empty, rain, received);
    const own = subjects(held).find((subject) => subject.source?.inputId === rain.inputId);
    expect(own?.transition).toBe("held");
    const effective = (wallTimeMs: number) => reduceBriefingUnit(held.state, { kind: "deadline", clock: { wallTimeMs, monotonicMs: 0 } })
      .state.currents.find((item) => item.subject === own?.subject)?.effective;
    expect([effective(received + 59_999), effective(received + 60_000)]).toEqual(["held", "released"]);
    const aliased = receive(held.state, record, received + 7);
    expect(subjects(aliased).find((subject) => subject.subject === own?.subject)?.transition).toBe("aliased");
    const reversed = receive(receive(empty, record, received).state, rain, received + 7);
    expect(subjects(reversed).find((subject) => subject.source?.inputId === rain.inputId)?.transition).toBe("aliased");
  });
});

// ---- 容量で退去した訓練の VPOA50（P3-TERMINAL-RAIN-EVICT-001） ----
// U-B が受けた取消・訂正の記録自身を容量で退去した返信（accepted・revisionOnly・subjects=[]、briefing-unit.ts の自身の退去）。
describe("P3-TRE 容量で退去した速報の取消・訂正", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(16, 33, 5)); });
  afterEach(() => { vi.useRealTimers(); });
  // 訂正の版は見出しの雨量も替える（版の違いをブロックの字で見分けるため）。
  const corrected = (xml: string): string => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>").replace("約１１０ミリ", "約１２０ミリ");
  const drill = shortOf(reportOf(OA, "U-B", training)), drillCancel = shortOf(reportOf(OA, "U-B", (xml) => cancelled(training(xml))));
  const drillFix = shortOf(reportOf(OA, "U-B", (xml) => corrected(training(xml))));
  const oa = shortOf(reportOf(OA, "U-B"));
  const blockOf = (report: Short): string[] => terminal()([reportUnit(report)]);
  const shown = (lines: readonly string[]): string[] => lines.filter((text) => !text.startsWith("debug: "));

  // P3-TRE-T01 regression / P3-TRE-AC01（2026-11-08 夜の総合レビューの P3、容量で退去した訓練の速報が取消の後に出る）
  it("T01 自分の記録の無い訓練の取消は、同じ運用区分と EventID の待ちを外し、取消も 60 秒の後の速報も出さない", () => {
    const t = sink(80, { debug: true });
    t.attach();
    t.output.sink.inputDone(inputDoneOf("a1", drill, [ub(ubSubject(P, "a1", "held"))]));
    vi.advanceTimersByTime(10_000);
    t.output.sink.inputDone(inputDoneOf("c1", drillCancel, [ub()]));
    expect(t.lines).toEqual(["debug: VPOA50 a1（U-B、対応報を待つ）", "debug: VPOA50 c1（U-B、出さない・待っていた報の取消）"]);
    vi.advanceTimersByTime(61_000);
    expect(shown(t.lines)).toEqual([]);
  });

  // P3-TRE-T02 regression / P3-TRE-AC01（同じ経路の訂正で新しい版の後に古い版が出る、Q-TRE-NEIGHBOR）
  it("T02 自分の記録の無い訓練の訂正は待ちの報を替え、最初の報から 60,000 ms の tick に訂正の版だけが 1 つ出る", () => {
    expect(blockOf(drillFix)).not.toEqual(blockOf(drill));
    const t = sink(80, { debug: true });
    t.attach();
    t.output.sink.inputDone(inputDoneOf("a1", drill, [ub(ubSubject(P, "a1", "held"))]));
    vi.advanceTimersByTime(30_000);
    t.output.sink.inputDone(inputDoneOf("f1", drillFix, [ub()]));
    expect(t.lines).toEqual(["debug: VPOA50 a1（U-B、対応報を待つ）", "debug: VPOA50 f1（U-B、対応報を待つ）"]);
    vi.advanceTimersByTime(29_999);
    expect(shown(t.lines)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown(t.lines)).toEqual(blockOf(drillFix));
    vi.advanceTimersByTime(60_000);
    expect(shown(t.lines)).toEqual(blockOf(drillFix));
  });

  // P3-TRE-T03 contractBoundary / P3-TRE-AC01（突き合わせの鍵は decode の運用区分と EventID）
  it("T03 通常の待ちは同じ EventID の訓練の取消で外れず、取消が出て 60 秒で速報も出る。head の operation は Control/Status の字でなく運用区分", () => {
    expect([oa.head.operation, drill.head.operation, shortOf(reportOf(OA, "U-B", (xml) => xml.replace("<Status>通常</Status>", "<Status>training</Status>"))).head.operation])
      .toEqual(["normal", "training", "training"]);
    const t = sink();
    t.attach();
    t.output.sink.inputDone(inputDoneOf("a1", oa, [ub(ubSubject(P, "a1", "held"))]));
    t.output.sink.inputDone(inputDoneOf("c1", drillCancel, [ub()]));
    expect(shown(t.lines)).toEqual(blockOf(drillCancel));
    vi.advanceTimersByTime(60_000);
    expect(shown(t.lines)).toEqual([...blockOf(drillCancel), ...blockOf(oa)]);
  });

  // P3-TRE-T04 acceptance / P3-TRE-AC01（期限の前の close）
  it("T04 期限の前の close で、取消で外した待ちは出ず、訂正で替えた待ちは訂正の版が 1 つ出る", async () => {
    const c = sink();
    c.attach();
    c.output.sink.inputDone(inputDoneOf("a1", drill, [ub(ubSubject(P, "a1", "held"))]));
    c.output.sink.inputDone(inputDoneOf("c1", drillCancel, [ub()]));
    vi.advanceTimersByTime(10_000);
    await c.output.close();
    expect(shown(c.lines)).toEqual([]);

    const f = sink();
    f.attach();
    f.output.sink.inputDone(inputDoneOf("a1", drill, [ub(ubSubject(P, "a1", "held"))]));
    f.output.sink.inputDone(inputDoneOf("f1", drillFix, [ub()]));
    vi.advanceTimersByTime(10_000);
    await f.output.close();
    expect(shown(f.lines)).toEqual(blockOf(drillFix));
  });
});
