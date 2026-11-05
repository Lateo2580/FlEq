import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { ClockReading, RuntimePublishedOutcome, RuntimeUnitId, SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { terminalReport } from "../../src/terminal/material";
import { createRenderer, width } from "../../src/terminal/format";
import type { TerminalUnit } from "../../src/terminal/format";
import { createTerminalOutput } from "../../src/terminal/output";
import type { TerminalOptions } from "../../src/terminal/output";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";

// 端末の試験の共通: fixture を ingress→decode に通し、色 0 の renderer で行にする。
const RECEIVED = 1_713_363_299_001;

// transform は本文を書き換えて別の報にする（訓練の報など）。
function decodeFixture(path: string, origin: "live" | "replay" | "recovery" = "replay", transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
  const headType = /(V[A-Z]{3}\d\d)/.exec(path)![1];
  const entered = ingestXmlData({ inputId: `terminal-${path.replace(/\W/g, "")}`, inputSequence: 1, receivedAt: RECEIVED, origin,
    kind: "replay", body: Buffer.from(transform(readFileSync(`test/fixtures/${path}`, "utf8"))), headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

function reportOf(path: string, unit: RuntimeUnitId): TerminalReport {
  const report = terminalReport(decodeFixture(path), unit);
  if (report == null) throw new Error(`no terminal report for ${path}`);
  return report;
}

function emptyEew(): EewUnitState {
  return { schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [], unreadableNotices: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}

// 同じ EEW の unit に順に通し、受信の outcome（facts.report を持つ subject）を端末の単位にする。
type EewInput = string | Readonly<{ path: string; transform: (xml: string) => string }>;
function eewUnits(inputs: readonly EewInput[]): TerminalUnit[][] {
  let state = emptyEew();
  return inputs.map((input) => {
    const material = typeof input === "string" ? decodeFixture(input) : decodeFixture(input.path, "replay", input.transform);
    const step = reduceEewUnit(state, { kind: "receive", material, clock: { wallTimeMs: RECEIVED, monotonicMs: 0 } });
    state = step.state;
    return step.outcomes.flatMap((outcome) => outcome.kind === "accepted" ? outcome.subjects.map((subject): TerminalUnit => ({ kind: "eew", subject, prompt: null, nowMs: RECEIVED })) : []);
  });
}

// 1 つの端末（覚えを持つ renderer）で、単位の並びを桁数 columns で行にする。
// 電文のブロックの先頭は空行 1 行（P3-TL-AC01）。level が 0 より大きければ ESC を含む生の文字、plain で ESC を除く。
function terminal(columns = 80, level: 0 | 3 = 0): (units: readonly TerminalUnit[]) => string[] {
  const renderer = createRenderer(level);
  return (units) => renderer.render({ columns, dropped: 0, units }).replace(/\n$/, "").split("\n");
}
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const reportUnit = (report: TerminalReport): TerminalUnit => ({ kind: "report", report, prompt: null });

// T01〜T03 の 13 報（EEW 5・地震 5・津波 3）を端末の単位にする（T04・T05）。EEW は T01 と同じ順で同じ unit に通す。
function allThirteen(): TerminalUnit[] {
  const eew = [["77_01_01_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"],
    ["77_01_30_260101_VXSE45_FINAL.xml"], ["77_02_01_260101_VXSE45_PLUM.xml"]].flatMap((paths) => eewUnits(paths).flat());
  const seismic = ["32-35_01_03_240613_VXSE53.xml", "32-35_07_01_100915_VXSE51.xml", "32-35_01_02_240613_VXSE52.xml",
    "selected_xml/78_01_01_240613_VXSE62.xml", "32-35_03_02_240613_VXSE61.xml"].map((path) => reportUnit(reportOf(path, "U-Q")));
  const tsunami = ["32-39_11_02_250206_VTSE41.xml", "32-39_11_10_250206_VTSE51.xml", "32-39_12_05_250206_VTSE52.xml"]
    .map((path) => reportUnit(reportOf(path, "U-T")));
  return [...eew, ...seismic, ...tsunami];
}

// 期待の行の罫線（spec の図は 60 桁で描いてあり、帯の罫線の長さは図ごとに揃っていない）。
// 色なしの帯は「━ 題名 ━…━ HH:MM:SS 発表 ━」、区切りは桁数まで。どちらも min(桁数, 100) に伸ばした行にする（P3-TL-AC02 (2)）。
const rule = (columns = 80): string => "─".repeat(Math.min(columns, 100));
const band = (title: string, time: string, columns = 80): string =>
  `━ ${title} ${"━".repeat(Math.min(columns, 100) - width(title) - width(time) - 11)} ${time} 発表 ━`;
// 色ありの警報以上の帯（ESC を除いた形）: 幅いっぱいに塗り、題名の後ろから時刻まで空白、右端の空白も残る。
const filled = (title: string, time: string, columns = 80): string =>
  ` ${title}${" ".repeat(Math.min(columns, 100) - width(title) - width(time) - 7)}${time} 発表 `;

// 返信 1 つ（【発注 2】の試験）。outcomes は U-E の受信の outcome など、units は view の変わった unit。
type InputDone = Extract<OwnerReply, { kind: "inputDone" }>;
function inputDoneOf(inputId: string, terminal: TerminalReport | null, outcomes: readonly RuntimePublishedOutcome[] = [],
  units: InputDone["output"]["units"] = [], decoded = true): InputDone {
  return { kind: "inputDone", settlement: { kind: "parser", messageId: inputId, runId: "r", encodedByteLength: 0, startedMonotonicMs: 0,
    completedMonotonicMs: 0, inputId, inputSequence: 1 }, processingStartedMs: 0, marks: { ingressJsonMs: null, base64DecodeMs: null,
    decompressionMs: null, fullXmlParseMs: null, metadataSpecialValueMs: null, domainExtractionMs: null, workerTransferMs: null },
  decode: decoded ? { startedMonotonicMs: 0, endedMonotonicMs: 0, xmlParseStartedMonotonicMs: null, xmlParseEndedMonotonicMs: null } : null,
  heap: null, inputGenerations: null, generationRaisedMs: null, terminal,
  output: { units, outcomes, displayChanges: [], confirmationEvidence: [], retiredEvents: [], diagnostics: [] } };
}
const eewOutcome = (subject: SubjectOutcome): RuntimePublishedOutcome => ({ unit: "U-E", outcome: { kind: "accepted", change: "semantic", subjects: [subject] } });

// 偽の時計（vi.useFakeTimers の Date）で動く端末と、偽の host・通知の口。書き出しは色 0 の行にして lines に積む。
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null };
function harness(options: TerminalOptions = {}, initial: Partial<HostStatus> = {}) {
  const renderer = createRenderer(0), lines: string[] = [], notices: string[] = [];
  let status: HostStatus = { ...CONNECTED, ...initial };
  const clock = (): ClockReading => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() });
  const output = createTerminalOutput({ tipInterval: 0, clock, notify: async (_title, body) => { notices.push(body); }, ...options,
    write: (batch, done) => { lines.push(...renderer.render(batch).replace(/\n$/, "").split("\n")); done(); } });
  return { output, lines, notices, attach: () => { output.attach({ status: () => status }); },
    set: (next: Partial<HostStatus>) => { status = { ...status, ...next }; } };
}
// 地方時の 2026-11-03 の時刻（spec の図の場面の時刻）。
const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 10, 3, hours, minutes, seconds).getTime();

export { allThirteen, at, band, decodeFixture, eewOutcome, eewUnits, filled, harness, inputDoneOf, plain, reportOf, reportUnit, rule, terminal };
