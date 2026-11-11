import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { createRenderer } from "../../src/terminal/format";
import type { TerminalBatch } from "../../src/terminal/format";
import { inputTerminal } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import { inputDoneOf } from "./terminal-fixture";

// P3-TERMINAL-OVERSIZE-001 の試験（列の 1 単位の上限 1 MiB を越える単位と、その近くの大きさの報）。
const NAGANO = "81_09_01_260605_VPWP50.xml", MIB = 1024 * 1024;
const DROPPED = "（表示が間に合わなかったため、1 件の表示を省きました）";

// layout17.test.ts の sink と同じ本物の出力の経路。書き出しの単位も写す。
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
function sink(columns = 100) {
  const renderer = createRenderer(0), lines: string[] = [], batches: TerminalBatch[] = [];
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }),
    write: (batch, done) => { batches.push(batch); lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  output.attach({ status: () => CONNECTED });
  return { output, lines, batches };
}

// layout17.test.ts の owned と同じ owner の道（呼ぶたびに新しい owner）。報と outcomes を返し、sink には渡さない。
function owned(inputId: string, transform: (xml: string) => string = (xml) => xml) {
  const xml = transform(readFileSync(`test/fixtures/${NAGANO}`, "utf8"));
  const now = { wallTimeMs: Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]) + 60_000, monotonicMs: 0 };
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: now.wallTimeMs, origin: "live", kind: "replay", body: Buffer.from(xml), headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const result = decodeMaterial(entered.item);
  const owner = restoreOwner({ runId: "run", place: "deferred", clock: now,
    restored: Object.fromEntries(placeUnits("deferred").map((unit) => [unit, { kind: "empty" }])) as never }, linkedUnitTable, linkedUnitCodecs);
  const step = receiveOwner(owner.state, { runId: "run", inputId, result }, now, linkedUnitTable);
  const rejected = step.confirmationEvidence.some(({ source }) => source === "unreadableReport");
  const report = inputTerminal(result, step.outcomes, rejected);
  if (report?.kind !== "short") throw new Error("not short");
  return { report, outcomes: step.outcomes };
}

// risks を濃霧危険度・特別警報級・50 の 1 組にし、riskRows を同じ組で spans は元のまま・areas を「あ」24 字の名前 count 個・others 0 にする（P3-TL19-AC01 (1) の組の形）。
function oversized(inputId: string, count: number) {
  const { report, outcomes } = owned(inputId);
  const risk = { type: "濃霧危険度", name: "特別警報級", code: "50" };
  const big: TerminalReport = { ...report, risks: [risk], riskRows: [{ ...risk, spans: report.riskRows![0].spans, areas: Array.from({ length: count }, () => "あ".repeat(24)), others: 0 }] };
  return inputDoneOf(inputId, big, outcomes);
}
const normal = (inputId: string, transform?: (xml: string) => string) => { const { report, outcomes } = owned(inputId, transform); return inputDoneOf(inputId, report, outcomes); };
const matsumoto = (xml: string): string => xml.replace(/<EditorialOffice>[^<]*</, "<EditorialOffice>松本地方気象台<").replace(/<PublishingOffice>[^<]*</, "<PublishingOffice>松本地方気象台<");

const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => { if (stdoutTty == null) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", stdoutTty); });

describe("P3-TOV 列の 1 単位の上限を越える単位", () => {
  // P3-TOV-T01 contractBoundary / AC01 (1)(2)(5)
  it("T01 列が空なら省いた件数をその場で出し、入力の行は 1 MiB に入るときだけ載せる", async () => {
    for (const [typed, expected, units] of [["abc", [DROPPED, "FlEq> abc"], 1], ["a".repeat(MIB + 1), [DROPPED], 0]] as const) {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
      const { output, lines, batches } = sink();
      const readline = createInterface({ input: new PassThrough(), output: new PassThrough(), terminal: true, prompt: "FlEq> " });
      output.bind(readline);
      readline.write(typed);
      output.line("y".repeat(MIB + 1));
      expect(lines).toEqual(expected);
      expect(batches.map((batch) => batch.units.length)).toEqual([units]);
      readline.close();
      await output.close();
    }
  });

  // P3-TOV-T02 regression / AC02・AC03 (3)（Q-TOV-SEQ (2)）
  it("T02 1 MiB に近い報と正常な報の束は、束の単位が riskRows を持たずに出る", async () => {
    const band = "━ 気象警報・注意報時系列情報 2件 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 05:00:00 発表 ━";
    const near = sink();
    near.output.sink.inputDone(oversized("tov-x", 13_753));
    near.output.sink.inputDone(normal("tov-y", matsumoto));
    await near.output.close();
    expect(near.lines).toEqual(["", band, "濃霧危険度（特別警報級）", "VPWP50 ・ 2 官署"]);
    const unit = near.batches.flatMap((batch) => batch.units).find((item) => item.kind === "timeseries");
    expect(unit?.kind === "timeseries" ? unit.report.riskRows : undefined).toBeNull();
    // (b) まとまりに riskRows を除いた写しで置いた報も、束の件数・種類の行・官署に数える。
    const over = sink();
    over.output.sink.inputDone(oversized("tov-x", 20_000));
    over.output.sink.inputDone(normal("tov-y", matsumoto));
    await over.output.close();
    expect(over.lines[1]).toContain("気象警報・注意報時系列情報 2件");
    expect(over.lines.slice(2)).toEqual(["濃霧危険度（特別警報級）", "VPWP50 ・ 2 官署"]);
    expect(over.lines.filter((text) => text.includes("表示を省きました"))).toEqual([]);
  });

  // P3-TOV-T03 regression / AC01・AC03（Q-TOV-SEQ (1)(4)）
  it("T03 1 MiB を越える報だけは、まとまりに材料を持たず、close で省いた件数が出る", async () => {
    const { output, lines } = sink();
    output.sink.inputDone(oversized("tov-x", 20_000));
    expect(output.seriesBytes()).toBeLessThanOrEqual(MIB);
    await output.close();
    expect(lines).toEqual([DROPPED]);
  });

  // P3-TOV-T04 contractBoundary / AC03 (4)
  it("T04 同じ subject の正常な報の後に 1 MiB を越える報が来ると、前の報は出ない", async () => {
    const { output, lines } = sink();
    output.sink.inputDone(normal("a"));
    output.sink.inputDone(oversized("a2", 20_000));
    await output.close();
    expect(lines).toEqual([DROPPED]);
  });

  // P3-TOV-T05 contractBoundary / AC01・AC02 (2)
  it("T05 置く時は 1 MiB に入るが 1 件の単位は越える報は、材料を除かず置き、push が省いて件数が出る", async () => {
    const { output, lines } = sink();
    output.sink.inputDone(oversized("tov-x", 13_753));
    expect(output.seriesBytes()).toBe(1_048_566);
    await output.close();
    expect(lines).toEqual([DROPPED]);
  });
});
