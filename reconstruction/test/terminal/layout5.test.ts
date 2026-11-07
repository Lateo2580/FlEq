import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { inputTerminal } from "../../src/terminal/material";
import { reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-005 の試験。観測の無い VTSE51 を owner の判定（outcome と unreadableReport）に通し、inputTerminal が報を返すかを見る。
const TIDE_A = "32-39_11_03_250206_VTSE51.xml", TIDE_B = "38-39_02_02_250206_VTSE51.xml", CANCEL = "38-39_03_03_210805_VTSE51.xml";
const OBSERVED = "32-39_11_10_250206_VTSE51.xml";
const STATION: Record<string, RegExp> = { [TIDE_A]: /満潮 宮古/, [TIDE_B]: /満潮 種子島西之表/ };
const now = { wallTimeMs: 1_800_000_000_000, monotonicMs: 0 };

function enter(path: string, origin: "live" | "recovery", transform: (xml: string) => string, inputId = `l5-${path.replace(/\W/g, "")}`) {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: now.wallTimeMs, origin, kind: "replay",
    body: Buffer.from(transform(readFileSync(`test/fixtures/${path}`, "utf8"))), headType: "VTSE51" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { item: entered.item, result: decodeMaterial(entered.item) };
}

function through(path: string, origin: "live" | "recovery" = "live", transform: (xml: string) => string = (xml) => xml) {
  const { item, result } = enter(path, origin, transform);
  const owner = restoreOwner({ runId: "run", place: "urgent", clock: now,
    restored: Object.fromEntries(placeUnits("urgent").map((unit) => [unit, { kind: "empty" }])) as never }, linkedUnitTable, linkedUnitCodecs);
  const step = receiveOwner(owner.state, { runId: "run", inputId: item.inputId, result }, now, linkedUnitTable);
  const rejected = step.confirmationEvidence.some(({ source }) => source === "unreadableReport");
  return { owner, step, rejected, report: inputTerminal(result, step.outcomes, rejected) };
}

// U-T を通さず、outcome なし・rejected=false で門だけを見る（Observation・取消の条件は、ここで null になることでしか効きを確かめられない）。
const gate = (path: string, transform: (xml: string) => string = (xml) => xml) => inputTerminal(enter(path, "live", transform).result, [], false);

describe("P3-TL5-T01 観測の無い VTSE51", () => {
  it.each([TIDE_A, TIDE_B])("%s は端末の報が返って「満潮」の行が出る。outcome は増えず U-T の state は変わらない", (path) => {
    const { owner, step, rejected, report } = through(path);
    expect(rejected).toBe(false);
    if (report == null) throw new Error("no report");
    expect(terminal(100)([reportUnit(report)]).join("\n")).toMatch(STATION[path]);
    expect(step.outcomes).toEqual([]);
    expect(step.state.units["U-T"]).toBe(owner.state.units["U-T"]);
  });
});

describe("P3-TL5-T02 満潮の報の境界", () => {
  it("origin が recovery の同じ報は出ない", () => {
    expect(through(TIDE_A, "recovery").report).toBeNull();
  });
  it("U-T が採った取消は今の門で出る", () => {
    const { step, report } = through(CANCEL);
    expect([step.outcomes.length > 0, report != null]).toEqual([true, true]);
  });
  it("取消の VTSE51 は例外の対象でない（outcome が無ければ出ない）", () => {
    expect(gate(TIDE_A, (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"))).toBeNull();
  });
  it("InfoType の読みは U-T と同じ（接頭辞つきの要素に惑わされない）", () => {
    const swap = (first: string, second: string) => (xml: string) =>
      xml.replace("<InfoType>発表</InfoType>", `<x:InfoType xmlns:x="urn:extension">${first}</x:InfoType><InfoType>${second}</InfoType>`);
    const shown = gate(TIDE_A, swap("取消", "発表"));
    if (shown == null) throw new Error("no report");
    const text = terminal(100)([reportUnit(shown)]).join("\n");
    expect([text.includes("取消"), /満潮 宮古/.test(text), gate(TIDE_A, swap("発表", "取消"))]).toEqual([false, true, null]);
  });
  it("U-T が拒否した VTSE51（EventID の欠け）は読めなかった報の側で、端末の報にならない", () => {
    const { rejected, report } = through(TIDE_A, "live", (xml) => xml.replace(/<EventID>.*<\/EventID>/, ""));
    expect([rejected, report]).toEqual([true, null]);
  });
  it("空の Observation の要素がある報は対象でない", () => {
    expect(gate(TIDE_A, (xml) => xml.replace("</Tsunami>", "<Observation></Observation></Tsunami>"))).toBeNull();
  });
  it("Observation のある VTSE51 は U-T が採ったときだけ出る（門は変わらない）", () => {
    const { step, report } = through(OBSERVED);
    expect([step.outcomes.length > 0, report != null]).toEqual([true, true]);
    expect(gate(OBSERVED)).toBeNull();
  });
});

describe("P3-TL5-T03 満潮の字の濃さ", () => {
  it("満潮時刻の表の全部の行の「満潮 」が薄い字になる（100 桁も 56 桁の続きの行も）", () => {
    const { report } = through(TIDE_A);
    if (report == null) throw new Error("no report");
    const dim = /\x1b\[38;2;\d+;\d+;\d+m満潮 /;
    const rows = [100, 56].map((columns) => terminal(columns, 3)([reportUnit(report)]).filter((row) => row.includes("満潮 ")));
    for (const lines of rows) {
      expect(lines.length).toBeGreaterThan(1);
      for (const row of lines) expect(row).toMatch(dim);
    }
    expect(rows[1].length).toBeGreaterThan(rows[0].length);
  });
});

describe("P3-TL5-T04 津波予報の見出しの色", () => {
  it("「津波予報（若干の海面変動）」の前に SKY の符号があり、地域の名前の行には無い", () => {
    const { report } = through(TIDE_A);
    if (report == null) throw new Error("no report");
    const rows = terminal(100, 3)([reportUnit(report)]);
    const at = rows.findIndex((row) => row.includes("津波予報（若干の海面変動）"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows[at]).toContain("\x1b[38;2;86;180;233m津波予報（若干の海面変動）");
    expect(rows[at + 1]).not.toContain("\x1b[38;2;86;180;233m");
  });
});
