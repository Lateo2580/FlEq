import { describe, expect, it, vi } from "vitest";

import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import { createRenderer } from "../../src/terminal/format";
import type { TerminalBatch, TerminalUnit } from "../../src/terminal/format";
import { createTerminalOutput, estimate } from "../../src/terminal/output";
import { at, harness, reportOf } from "./terminal-fixture";

const MIB = 1024 * 1024;
// 返事を返さない writer。release で 1 回分ずつ返す（試験の writer は main で動く、AC02 (5)）。
function heldWriter() {
  const batches: TerminalBatch[] = [];
  const waiting: (() => void)[] = [];
  return { batches, write: (batch: TerminalBatch, done: () => void) => { batches.push(batch); waiting.push(done); },
    release: () => { while (waiting.length > 0) waiting.shift()!(); } };
}
const inputDone = (terminal: TerminalReport): Extract<OwnerReply, { kind: "inputDone" }> => ({
  kind: "inputDone", settlement: { kind: "parser", messageId: "m", runId: "r", encodedByteLength: 0, startedMonotonicMs: 0, completedMonotonicMs: 0,
    inputId: "i", inputSequence: 1 }, processingStartedMs: 0, marks: { ingressJsonMs: null, base64DecodeMs: null, decompressionMs: null,
    fullXmlParseMs: null, metadataSpecialValueMs: null, domainExtractionMs: null, workerTransferMs: null }, decode: null, heap: null,
  inputGenerations: null, generationRaisedMs: null, terminal,
  output: { units: [], outcomes: [], displayChanges: [], confirmationEvidence: [], retiredEvents: [], diagnostics: [] },
});

describe("P3-TO-T06 列の上限（O02、AC02 (3)・AC08 (1)）", () => {
  it("電文と REPL の返事を交互に 1 MiB を越えて積むと、古い単位から落とし、書き出しの頭に省いた件数が出る", async () => {
    const writer = heldWriter();
    const terminal = createTerminalOutput({ write: writer.write });
    const quake = reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q");
    const reply = (index: number) => `  返事 ${index} ${"x".repeat(8 * 1024)}`;
    const pushed: TerminalUnit[] = [];
    let queued = 0;
    for (let index = 0; queued <= 2 * MIB; index += 1) {
      // 積む呼び出しは同期で戻る（Promise を返さない）。
      expect(index % 2 === 0 ? terminal.sink.inputDone(inputDone(quake)) : terminal.line(reply(index))).toBeUndefined();
      const unit: TerminalUnit = index % 2 === 0 ? { kind: "report", report: quake, prompt: null } : { kind: "line", text: reply(index) };
      pushed.push(unit);
      queued += estimate(unit);
    }
    // 最初の 1 単位だけが送られて返事待ち。残りは列に積まれたまま。
    expect(writer.batches.map((batch) => batch.units.length)).toEqual([1]);
    const held = terminal.held();
    for (let round = 0; round < 1000 && writer.batches.length > 0; round += 1) {
      const from = writer.batches.length;
      writer.release();
      if (writer.batches.length === from) break;
    }
    const [first, second, ...rest] = writer.batches;
    const written = [first, second, ...rest].flatMap((batch) => batch.units);
    const dropped = second.dropped;
    // 列の中身は 1 MiB を越えない（送った後に積まれた分の見積もりの合計）。
    expect([second, ...rest].flatMap((batch) => batch.units).reduce((total, unit) => total + estimate(unit), 0)).toBeLessThanOrEqual(MIB);
    expect(rest.every((batch) => batch.dropped === 0)).toBe(true);
    expect(dropped).toBeGreaterThan(0);
    expect(dropped + written.length).toBe(pushed.length);
    // 落ちたのは種類によらず古い順（最初の 1 単位は送り済み）。
    expect(written).toEqual([pushed[0], ...pushed.slice(dropped + 1)]);
    // 落とした枠は詰まっている間も参照を残さず（列が持つのは後で書いた単位だけ）、送り終えた後は何も持たない。
    expect([held, terminal.held()]).toEqual([written.length - 1, 0]);
    const text = createRenderer(0).render(second);
    expect(text.split("\n")[0]).toBe(`（表示が間に合わなかったため、${dropped} 件の表示を省きました）`);
    await terminal.close();
  });

  it("1 MiB より大きい 1 つの返事は積まずに数え、前に積んだ単位は落とさない", async () => {
    const writer = heldWriter();
    const terminal = createTerminalOutput({ write: writer.write });
    for (const text of ["a", "b", "c"]) terminal.line(text);
    terminal.line("y".repeat(MIB + 1));
    writer.release();
    expect(writer.batches.slice(1).map((batch) => [batch.dropped, batch.units])).toEqual([
      [1, [{ kind: "line", text: "b" }, { kind: "line", text: "c" }]]]);
    await terminal.close();
  });
});

// P3-TL8-T04 acceptance (AC04 (6)): 落とす場面は共通の harness（write がその場で done）では作れないので、ここの heldWriter で作る。
describe("P3-TL8-T04 列が覚えた全国の集約通報の単位を落とした後", () => {
  it("書き出し中に積んだ VPWS50 の単位が、合わせて 1 MiB を越える数える単位に押し出されると、次の同じ報は出る", async () => {
    const writer = heldWriter();
    const terminal = createTerminalOutput({ write: writer.write });
    const report = reportOf("15_18_01_250630_VPWS50.xml", "U-W");
    terminal.line("a");
    terminal.sink.inputDone(inputDone(report));
    // 見積もりがちょうど 1 MiB の行（kind・text の鍵と入れ物で 20 byte）。積むには前の VPWS50 の単位を落とす。
    terminal.line("y".repeat(MIB - 20));
    writer.release();
    writer.release();
    terminal.sink.inputDone(inputDone(report));
    writer.release();
    expect(writer.batches.map((batch) => [batch.dropped, batch.units.map((unit) => unit.kind)])).toEqual([[0, ["line"]], [1, ["line"]], [0, ["report"]]]);
    await terminal.close();
  });
});

// P3-CLI-T19 contractBoundary (P3-CLI-AC27 (2)(3)・AC23)
describe("P3-CLI-T19 入力の行の書き直しと tips・drained", () => {
  it("入力の行を 1 秒ごとに書き直しても tips の待ちは延びず、drained は worker の書き込みが終わるまで false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(21, 0, 0));
    try {
      const h = harness({ tipInterval: 1 });
      h.attach();
      for (let second = 1; second <= 61; second += 1) {
        h.output.output.write(`\r\x1b[0JFlEq [● 00:00:${String(second % 60).padStart(2, "0")}]> `);
        vi.advanceTimersByTime(1_000);
      }
      expect(h.lines.filter((line) => line.includes("Tip:"))).toHaveLength(1);
      await h.output.close();
    } finally { vi.useRealTimers(); }
    const writer = heldWriter();
    const terminal = createTerminalOutput({ write: writer.write });
    terminal.line("a");
    expect([terminal.held(), terminal.drained()]).toEqual([0, false]);
    writer.release();
    expect(terminal.drained()).toBe(true);
    await terminal.close();
  });
});
