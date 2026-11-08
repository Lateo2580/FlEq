import { describe, expect, it } from "vitest";

import type { RuntimePublishedOutcome, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { painter } from "../../src/terminal/color";
import { width } from "../../src/terminal/format";
import type { TerminalUnit } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { clock, decodeFixture as quakeMaterial, emptyState, receive } from "../seismic-unit/seismic-fixture";
import { band, eewUnits, harness, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-009（Q-TO10-*）の試験。
type Short = Extract<TerminalReport, { kind: "short" }>;
const short = (path: string, unit: RuntimeUnitId, transform?: (xml: string) => string): Short => {
  const report = reportOf(path, unit, transform);
  if (report.kind !== "short") throw new Error(report.kind);
  return report;
};
const bandLine = (report: TerminalReport): string => terminal()([reportUnit(report)])[1];
const changed = (from: RegExp | string, to: string) => (xml: string): string => {
  const next = xml.replace(from, to);
  expect(next).not.toBe(xml);
  return next;
};

// T02: U-Q の reducer に順に通し（facts を手で作らない）、最後の入力の材料と outcome を返信にして harness の sink に渡す。
type QuakeInput = string | Readonly<{ file: string; transform: (xml: string) => string }>;
function cancelLines(inputs: readonly QuakeInput[], at: string, edit: (report: TerminalReport) => TerminalReport = (report) => report): string[] {
  let state = emptyState(), report: TerminalReport | null = null, outcomes: RuntimePublishedOutcome[] = [];
  for (const input of inputs) {
    const material = typeof input === "string" ? quakeMaterial(input) : quakeMaterial(input.file, input.transform);
    const step = receive(state, material, clock(Date.parse(at)));
    state = step.state;
    report = terminalReport(material, "U-Q");
    outcomes = step.outcomes.map((outcome) => ({ unit: "U-Q", outcome }));
    // 前の報が拒否されても取消の行の字が同じになる場面がある（VXSE51 が残る一部の取消、VXSE62 の取消）ので、どの入力も採られたことを確かめる。
    expect(outcomes.some(({ outcome }) => outcome.kind === "accepted"), typeof input === "string" ? input : input.file).toBe(true);
  }
  const { output, lines } = harness();
  output.sink.inputDone(inputDoneOf("cancel", edit(report!), outcomes));
  return lines;
}
const BF35 = "telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825", CANCEL = "synthetic_VXSE53_cancel";
const VXSE62 = "telegram-foundation/phase7_5_VXSE62_20260728162718_f9786edc27df";

describe("P3-TL9 1 報の字の欠け", () => {
  // P3-TL9-T01 / AC01（実不具合: 熱中症警戒アラートの帯に県が出ない）
  it("T01 VPFT50・VPAW51・VPWP50 の帯の題名は Head/Title で対象が付かず、Head/Title の無い報は今の形", () => {
    expect(bandLine(short("57_03_01_240401_VPFT50.xml", "U-M"))).toBe(band("埼玉県熱中症警戒アラート", "05:00:00"));
    expect(bandLine(short("synthetic_VPFT50_cancel.xml", "U-M"))).toBe(band("埼玉県熱中症警戒アラート 取消", "05:30:00"));
    expect(bandLine(short("synthetic_VPFT50_title_escalation.xml", "U-M"))).toBe(band("埼玉県熱中症特別警戒アラート", "05:00:00"));
    expect(bandLine(short("72_03_01_190327_VPAW51.xml", "U-M"))).toBe(band("大雪に関する早期天候情報（東北地方）", "14:30:00"));
    expect(bandLine(short("81_01_01_260129_VPWP50.xml", "U-F"))).toBe(band("宗谷地方警戒・注意事項時系列情報", "05:00:00"));
    expect(bandLine(short("81_09_01_260605_VPWP50.xml", "U-F"))).toBe(band("長野県警戒・注意事項時系列情報", "05:00:00"));
    expect(bandLine(short("57_03_01_240401_VPFT50.xml", "U-M", changed("<Title>埼玉県熱中症警戒アラート</Title>", "")))).toBe(band("熱中症警戒アラート", "05:00:00"));
  });

  // P3-TL9-T02 / AC02（実不具合: 地震の取消でどの地震の取消か読めない）
  it("T02 地震の取消の下に、同じ返信の U-Q の記録から取り消した地震の行が出る", () => {
    expect(cancelLines([BF35, CANCEL], "2026-07-28T16:40:00+09:00")).toEqual(["", band("震源・震度に関する情報 取消", "16:36:00"),
      "震源・震度情報を取り消します。", "取り消したのは 16:27ころ発生の熊本県熊本地方の地震の情報です", "VXSE53 ・ ID 20260728162718"]);
    const phrase = (inputs: readonly QuakeInput[], at = "2026-07-28T16:40:00+09:00", edit?: (report: TerminalReport) => TerminalReport) => cancelLines(inputs, at, edit)[3];
    expect(phrase(["telegram-foundation/phase7_5_VXSE51_20260728162718_059a2b392646", BF35, CANCEL])).toBe("取り消したのは 16:27ころ発生の地震の情報です");
    const longPeriodCancel = (xml: string) => changed(/<Body([^>]*)>[\s\S]*<\/Body>/, "<Body$1><Text>先ほどの、長周期地震動に関する観測情報を取り消します。</Text></Body>")(
      changed("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")(changed("<ReportDateTime>2026-07-28T16:37:00+09:00</ReportDateTime>", "<ReportDateTime>2026-07-28T16:40:00+09:00</ReportDateTime>")(xml)));
    expect(phrase([VXSE62, { file: VXSE62, transform: longPeriodCancel }], "2026-07-28T16:41:00+09:00")).toBe("取り消したのは 16:27ころの地震の情報です");
    expect(phrase([CANCEL])).toBe("取り消したのは 16:27ころの地震の情報です");
    expect(phrase(["32-35_10_01_220510_VXSE51"], "2022-05-10T18:11:00+09:00")).toBe("取り消したのは 9日 15:23ころ発生の地震の情報です");
    const nextDay = (report: TerminalReport): TerminalReport => ({ ...report, head: { ...report.head, reportDateTimeRaw: "2026-07-29T16:36:00+09:00" } });
    expect(phrase([BF35, CANCEL], undefined, nextDay)).toBe("取り消したのは 28日 16:27ころ発生の熊本県熊本地方の地震の情報です");
    expect(terminal()(eewUnits(["37_01_03_240613_VXSE43.xml"])[0])[3]).toBe("取り消したのは 23:14 頃に検知した地震です");
  });

  // P3-TL9-T03 / AC03（実不具合: PLUM法の行が無い）
  it("T03 理由 9 の報は震源の行の直下に薄い字の PLUM法の行があり、再掲・仮定の震源・理由 0・取消には無い", () => {
    const reason9 = { path: "37_01_02_240613_VXSE43.xml", transform: changed("<MaxIntChangeReason>0</MaxIntChangeReason>", "<MaxIntChangeReason>9</MaxIntChangeReason>") };
    const PLUM = "PLUM法による予測震度変化";
    const print = terminal();
    const [first, second] = eewUnits(["37_01_01_240613_VXSE43.xml", reason9]);
    print(first);
    const lines = print(second);
    expect(lines.slice(5, 7)).toEqual(["震源: 豊後水道 ・ M5.8 →  6.6 ・ 深さ30km →  40km ・ 長周期階級 1 →  2", PLUM]);
    expect(lines.filter((text) => text === PLUM)).toHaveLength(1);
    expect(terminal(80, 3)(second).find((text) => plain(text).trim() === PLUM)).toContain(painter(3)("dim", PLUM));
    const busy = terminal();
    busy(eewUnits(["77_02_01_260101_VXSE45_PLUM.xml"])[0]);
    const [again, plum] = eewUnits(["37_01_01_240613_VXSE43.xml", reason9]);
    busy(again);
    const shown = busy(plum);
    expect(shown.slice(shown.indexOf(PLUM), shown.indexOf(PLUM) + 2)).toEqual([PLUM, "ほかに 1 件の緊急地震速報（石川県能登地方）"]);
    const none = [eewUnits(["37_01_01_240613_VXSE43.xml", "37_01_02_240613_VXSE43.xml"])[1], eewUnits(["77_02_01_260101_VXSE45_PLUM.xml"])[0],
      eewUnits(["37_01_01_240613_VXSE43.xml", reason9, "37_01_03_240613_VXSE43.xml"])[2]];
    for (const units of none) expect(terminal()(units).filter((text) => text.includes(PLUM))).toEqual([]);
  });

  // P3-TL9-T04 / AC04（実不具合: 竜巻注意情報の解除が警報の段）
  it("T04 竜巻注意情報は Body の Kind が 1〜255 個で全部なしなら plain、発表が 1 つでもあるか Kind が無いか 256 個なら warning", () => {
    const level = (path: string, transform?: (xml: string) => string) => short(path, "U-M", transform).level;
    expect(["synthetic_VPHW50_tokyo_release.xml", "19_01_01_091210_VPHW50.xml", "19_03_01_130906_VPHW50.xml", "synthetic_VPHW50_tokyo_empty.xml",
      "synthetic_VPHW50_tokyo_cancel.xml"].map((path) => level(path))).toEqual(["plain", "warning", "warning", "warning", "cancel"]);
    // 19_01_01 の Body の発表の Kind を 1 つだけ残す。
    const oneLeft = (xml: string): string => {
      const at = xml.indexOf("<Body");
      let kept = 0;
      const body = xml.slice(at).replace(/<Name>竜巻注意情報<\/Name>\s*<Code>1<\/Code>\s*<Status>発表<\/Status>/g,
        (text) => kept++ === 0 ? text : "<Name>なし</Name><Code>0</Code><Status>なし</Status>");
      expect(kept).toBeGreaterThan(1);
      return xml.slice(0, at) + body;
    };
    expect(level("19_01_01_091210_VPHW50.xml", oneLeft)).toBe("warning");
    const items = (count: number) => (xml: string): string => xml.replace(/(<Item>[\s\S]*?<\/Item>)[\s\S]*<\/Item>/, (_, item: string) => item.repeat(count));
    expect([255, 256].map((count) => level("synthetic_VPHW50_tokyo_release.xml", items(count)))).toEqual(["plain", "warning"]);
  });

  // P3-TL9-T05 / AC05（実不具合: 台風の帯の対象が「宗谷北部」「熱帯低気圧」）
  it("T05 台風の帯の対象は最初の台風呼称の番号と名前、番号が無ければ Remark、どちらも無ければ今の形", () => {
    const target = (path: string, transform?: (xml: string) => string) => short(path, "U-Y", transform).target;
    expect([["76_01_01_200630_VPTA50.xml", "台風第1号（DAMREY）"], ["76_01_02_260531_VPTA50.xml", "台風第6号（JANGMI）"], ["10_04_03_170913_VPTW60.xml", "台風第18号（TALIM）"],
      ["10_05_01_200826_VPTW60.xml", "台風発生予想"], ["10_05_05_200826_VPTW61.xml", "台風発生の可能性が小さくなった"], ["synthetic_VPTA50_cancel.xml", null],
      ["synthetic_VPTW60_cancel.xml", "台風発生予想"]].map(([path]) => [path, target(path!)])).toEqual([["76_01_01_200630_VPTA50.xml", "台風第1号（DAMREY）"],
      ["76_01_02_260531_VPTA50.xml", "台風第6号（JANGMI）"], ["10_04_03_170913_VPTW60.xml", "台風第18号（TALIM）"], ["10_05_01_200826_VPTW60.xml", "台風発生予想"],
      ["10_05_05_200826_VPTW61.xml", "台風発生の可能性が小さくなった"], ["synthetic_VPTA50_cancel.xml", null], ["synthetic_VPTW60_cancel.xml", "台風発生予想"]]);
    expect(bandLine(short("synthetic_VPTW60_cancel.xml", "U-Y"))).toMatch(/^━ 台風解析・予報情報（５日予報）（Ｈ３０） 取消 台風発生予想 ━/);
    expect(target("10_04_03_170913_VPTW60.xml", changed("<Number>1718</Number>", "<Number/>"))).toBe("熱帯低気圧");
  });

  // P3-TL9-T06 / AC06 (1)（契約境界）
  it("T06 T01〜T05 の報を 56・80・100 桁と色 3 で描くと、どの行も桁数を越えない", () => {
    const shorts: [string, RuntimeUnitId][] = [["57_03_01_240401_VPFT50.xml", "U-M"], ["synthetic_VPFT50_cancel.xml", "U-M"], ["synthetic_VPFT50_title_escalation.xml", "U-M"],
      ["72_03_01_190327_VPAW51.xml", "U-M"], ["72_05_01_190327_VPAW51.xml", "U-M"], ["81_01_01_260129_VPWP50.xml", "U-F"], ["81_09_01_260605_VPWP50.xml", "U-F"],
      ["synthetic_VPHW50_tokyo_release.xml", "U-M"], ["19_01_01_091210_VPHW50.xml", "U-M"], ["76_01_01_200630_VPTA50.xml", "U-Y"], ["10_04_03_170913_VPTW60.xml", "U-Y"],
      ["10_05_01_200826_VPTW60.xml", "U-Y"], ["10_05_05_200826_VPTW61.xml", "U-Y"], ["synthetic_VPTW60_cancel.xml", "U-Y"]];
    const quake = reportOf("synthetic_VXSE53_cancel.xml", "U-Q");
    const reason9 = { path: "37_01_02_240613_VXSE43.xml", transform: changed("<MaxIntChangeReason>0</MaxIntChangeReason>", "<MaxIntChangeReason>9</MaxIntChangeReason>") };
    const units: TerminalUnit[] = [...shorts.map(([path, unit]) => reportUnit(short(path, unit))),
      { kind: "report", report: quake, prompt: null, cancelled: { name: "熊本県熊本地方", originTimeRaw: "2026-07-28T16:27:00+09:00" } },
      ...eewUnits(["37_01_01_240613_VXSE43.xml", reason9]).flat()];
    for (const columns of [56, 80, 100]) {
      const lines = terminal(columns, 3)(units).map(plain);
      expect(lines.filter((text) => width(text) > columns)).toEqual([]);
    }
    const narrow = (path: string, unit: RuntimeUnitId) => terminal(56, 3)([reportUnit(short(path, unit))]).map(plain);
    expect(narrow("72_05_01_190327_VPAW51.xml", "U-M")[2]).toBe("14:30:00 発表");
    const folded = narrow("10_05_05_200826_VPTW61.xml", "U-Y");
    expect(`${folded[1]}${folded[2]}`).toBe("台風解析・予報情報（５日予報）（Ｈ３０） 台風発生の可能性が小さくなった");
  });
});
