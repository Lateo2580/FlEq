import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { createRenderer } from "../../src/terminal/format";
import { inputTerminal } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import { inputDoneOf } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-017 の試験（1 件の気象警報・注意報時系列情報の種類の行）。
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

// layout16.test.ts の owned と同じ owner の道。close で残りの時系列のまとまりが 1 件で出る。
async function owned(path: string, columns: number) {
  const xml = readFileSync(`test/fixtures/${path}`, "utf8");
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

  // P3-TL17-T02 acceptance / AC01 (1)(2)(3)
  it("T02 81_09_01（見出し文が空・種類 1）は帯の直下に種類の行", async () => {
    expect((await owned(NAGANO, 100)).lines).toEqual(["", "━ 長野県警戒・注意事項時系列情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 05:00:00 発表 ━",
      "濃霧危険度（注意報級）", "VPWP50 ・ 長野地方気象台"]);
    expect((await owned(NAGANO, 56)).lines).toEqual(["", "━ 長野県警戒・注意事項時系列情報 ━━━━━━━ 05:00:00 発表 ━", "濃霧危険度（注意報級）", "VPWP50 ・ 長野地方気象台"]);
  });

  // P3-TL17-T03 contractBoundary / AC01 (2)(3)
  it("T03 81_02_01 は見出し文の下に Code の大きい順、56 桁で組の境で折り続きの行を下げない", async () => {
    expect((await owned(HIGH, 100)).lines).toEqual(["", "━ 宗谷地方警戒・注意事項時系列情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 17:00:00 発表 ━",
      "大雨警報・土砂災害警戒レベル4相当・特別警報級の予測", "大雨浸水危険度（特別警報級）　土砂災害危険度（警戒レベル4相当）", "VPWP50 ・ 稚内地方気象台"]);
    expect((await owned(HIGH, 56)).lines).toEqual(["", "━ 宗谷地方警戒・注意事項時系列情報 ━━━━━ 17:00:00 発表 ━",
      "大雨警報・土砂災害警戒レベル4相当・特別警報級の予測", "大雨浸水危険度（特別警報級）", "土砂災害危険度（警戒レベル4相当）", "VPWP50 ・ 稚内地方気象台"]);
  });
});
