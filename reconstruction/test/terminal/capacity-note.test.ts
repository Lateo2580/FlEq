import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimePublishedOutcome, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { painter } from "../../src/terminal/color";
import { at, harness, inputDoneOf, reportOf, terminal } from "./terminal-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(21, 20, 0)); });
afterEach(() => { vi.useRealTimers(); });

const NOTE = "容量の上限のため、この報は記録に入っていません";

// U-Q・U-T の refuse が返す outcome の形（seismic-unit.ts の refuse）。transition だけ替えて普通の採用にもする。
const mark = (unit: RuntimeUnitId, report: TerminalReport, inputId: string, transition = "unavailable"): RuntimePublishedOutcome => ({
  unit, outcome: { kind: "accepted", change: "semantic", subjects: [{ subject: "s", operation: report.head.operation, informationType: "発表",
    transition, severity: null, source: { inputId, origin: "replay", operation: report.head.operation, family: report.head.headType, subject: "s",
      reportDateTimeRaw: "", controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" }, facts: {}, changedFields: ["unavailable"] }] } });

// harness の端末に 1 報を返信 1 つで入れ、書き出した行を trim して返す。
async function shown(path: string, unit: RuntimeUnitId, transition?: string): Promise<string[]> {
  const h = harness();
  const report = reportOf(path, unit);
  h.output.sink.inputDone(inputDoneOf("in", report, [mark(unit, report, "in", transition)]));
  await h.output.close();
  return h.lines.map((line) => line.trim());
}

describe("P3-TCN-T01 記録に入らなかった続報の 1 行（AC01・AC02）", () => {
  it("印の outcome の地震・津波の報は末尾の行の直後に 1 行が付き、普通の採用には付かない", async () => {
    const marked = await shown("32-35_01_03_240613_VXSE53.xml", "U-Q");
    expect(marked[marked.indexOf("VXSE53 ・ ID 20091001134500") + 1]).toBe(NOTE);
    const adopted = await shown("32-35_01_03_240613_VXSE53.xml", "U-Q", "active");
    expect(adopted).not.toContain(NOTE);
    expect(adopted).toEqual(marked.filter((line) => line !== NOTE));
    const tsunami = await shown("32-39_11_02_250206_VTSE41.xml", "U-T");
    expect(tsunami[tsunami.indexOf("VTSE41 ・ ID 20110311144640") + 1]).toBe(NOTE);
  });
});

describe("P3-TCN-T02 1 行の色（AC02 (2)）", () => {
  it("色ありでは警報の段の縦線の後に warn の字で、末尾の行の後に出る", () => {
    const p = painter(3);
    const lines = terminal(80, 3)([{ kind: "report", report: reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q"), prompt: null, unrecorded: true }]);
    expect(lines.slice(-2)).toEqual([p("barWarning", " ") + " " + p("dim", "VXSE53 ・ ID 20091001134500"),
      p("barWarning", " ") + " " + p("warn", NOTE)]);
  });
});
