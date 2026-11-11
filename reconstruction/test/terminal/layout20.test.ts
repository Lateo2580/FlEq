import { describe, expect, it } from "vitest";

import { painter } from "../../src/terminal/color";
import type { TerminalUnit } from "../../src/terminal/format";
import { reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-020 の試験（種類の行の色・束の色と半角・起動の帯の折り）。
const HIGH = "81_02_01_260605_VPWP50_high_severity.xml", LEVEL3 = "81_03_01_260605_VPWP50_unknown_code.xml", NAGANO = "81_09_01_260605_VPWP50.xml";
const p = painter(3), bar = `${p("barPlain", " ")} `;

describe("P3-TL20 種類の行の色", () => {
  // P3-TL20-T01 acceptance / P3-TL20-AC01 (1)(2)(6)
  it("T01 (a)(b)(c) 種類（段階）の字だけに Code の十の位の役目、時間帯と市町村等は色なし", () => {
    const lines = terminal(80, 3)([reportUnit(reportOf(HIGH, "U-F"))]);
    expect(lines.slice(3, 7)).toEqual([bar + p("bandTop", "大雨浸水危険度（特別警報級）") + "  夜のはじめ頃", bar + "  稚内市",
      bar + p("bandPurple", "土砂災害危険度（警戒レベル4相当）") + "  夜のはじめ頃〜夜遅く", bar + "  稚内市"]);
    expect(terminal(80, 3)([reportUnit(reportOf(LEVEL3, "U-F"))])[2]).toBe(bar + p("strong", p("ruleWarning", "大雨浸水危険度（警戒レベル3相当）")) + "  夜のはじめ頃");
    expect(terminal(80, 3)([reportUnit(reportOf(NAGANO, "U-F"))])[2]).toBe(bar + p("ruleCaution", "濃霧危険度（注意報級）") + "  06日朝〜06日昼前");
  });
  // P3-TL20-T01 (d) / AC01 (4)
  it("T01 (d) 種類の字そのものが折れたとき、続きの行の種類の字も同じ役目で、頭の空白と時間帯は色なし", () => {
    const lines = terminal(28, 3)([reportUnit(reportOf(HIGH, "U-F"))]);
    const at = lines.indexOf(p("bandPurple", "土砂災害危険度（警戒レベル4"));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 2)).toEqual([p("bandPurple", "土砂災害危険度（警戒レベル4"), "  " + p("bandPurple", "相当）") + "  夜のはじめ頃〜夜遅"]);
  });
});

describe("P3-TL20 帯の境で折った続きの行", () => {
  // P3-TL20-T01 (e) / AC01 (2): 時間帯が帯の境で折れた続きの行は役目なし。60 桁未満は縦線が無い（種類の字の役目を引き継がない）。
  it("T01 (e) 40 桁で時間帯が 2 行になる 1 件の形は、続きの行に色が付かない", () => {
    const report = reportOf(NAGANO, "U-F");
    if (report.kind !== "short" || report.riskRows == null) throw new Error("no riskRows");
    const [row, ...others] = report.riskRows;
    const folded = { ...report, riskRows: [{ ...row, spans: [...row.spans, { from: "０７日朝", to: "０７日朝" }] }, ...others] };
    const lines = terminal(40, 3)([reportUnit(folded)]);
    expect(lines.slice(3, 5)).toEqual([p("ruleCaution", "濃霧危険度（注意報級）") + "  06日朝〜06日昼前", " ".repeat(24) + "07日朝"]);
  });
});

describe("P3-TL20 束の種類の並び", () => {
  // P3-TL20-T02 acceptance / P3-TL20-AC02 (1)(2)(4)
  it("T02 全角の数字の Name は半角、色ありは組ごとの役目で区切りの全角の空白は色なし", () => {
    const report = reportOf(HIGH, "U-F");
    if (report.kind !== "short") throw new Error("not short");
    const risks = [["大雨浸水危険度", "特別警報級", "50"], ["土砂災害危険度", "警戒レベル４相当", "41"], ["風危険度", "警報級", "30"], ["濃霧危険度", "注意報級", "20"]]
      .map(([type, name, code]) => ({ type, name, code }));
    const unit: TerminalUnit = { kind: "timeseries", report, count: 2, offices: 2, risks, prompt: null };
    const rows = (columns: number, level: 0 | 3): string[] => terminal(columns, level)([unit]).slice(2, -1);
    expect(rows(100, 0)).toEqual(["大雨浸水危険度（特別警報級）　土砂災害危険度（警戒レベル4相当）　風危険度（警報級）", "濃霧危険度（注意報級）"]);
    expect(rows(100, 3)).toEqual([bar + p("bandTop", "大雨浸水危険度（特別警報級）") + "　" + p("bandPurple", "土砂災害危険度（警戒レベル4相当）") + "　" + p("strong", p("ruleWarning", "風危険度（警報級）")),
      bar + p("ruleCaution", "濃霧危険度（注意報級）")]);
  });
});

describe("P3-TL20 起動の帯の折り", () => {
  const banner = (appName: string, columns: number, level: 0 | 3): string[] =>
    terminal(columns, level)([{ kind: "notice", notice: { kind: "banner", appName, version: "4.1.0" }, prompt: null }]);
  // P3-TL20-T03 acceptance / P3-TL20-AC03 (1)(2)(5)
  it("T03 1 行が端末の幅にちょうど入れば 1 行、1 桁足りなければ名前と版の行と下げた副題の 2 行", () => {
    expect(banner("fleq-next", 70, 3)).toEqual(["", p("banner", "fleq-next v4.1.0 — Project DM-D.S.S リアルタイム地震・津波情報モニター"), ""]);
    expect(banner("fleq-watch", 70, 3)).toEqual(["", p("banner", "fleq-watch v4.1.0"), "  Project DM-D.S.S リアルタイム地震・津波情報モニター", ""]);
    expect(banner("fleq-watch", 70, 0)).toEqual(["", "fleq-watch v4.1.0", "  Project DM-D.S.S リアルタイム地震・津波情報モニター", ""]);
  });
});
