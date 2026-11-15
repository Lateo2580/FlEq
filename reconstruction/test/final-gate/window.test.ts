import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { JsonValue, ShutdownSummary } from "../../contracts/p2-shared-runtime.types";
import { startP2Host } from "../../src/host/host";
import { RuntimeCompositionRoot, linkedUnitCodecs } from "../../src/runtime/composition-root";
import { runtimeUnits } from "../../src/runtime/unit-coverage";
import { EVENT_LIMIT, LONG_PERIOD_LIMIT } from "../../src/units/seismic/seismic-unit";
import { SNAPSHOT_BYTES } from "../../src/view-projector/view-projector";
import { dirtyReports } from "../disaster/dirty-reports.mjs";
import { runStage1 } from "../disaster/runner";
import type { Scenario } from "../disaster/scenario";
import type { Frame } from "../disaster/synth";
import { shiftTimestamps } from "../eew-e01/frames.mjs";

// P3-FINAL-GATE-001 発注 3a の門つきの T06〜T08（Pi の窓の道具と試験）。既定の実行・reconstruction ゲート・CI では 3 本とも skip（skip は Pass に数えない）。

// 本物の host（T06）は EEW と津波警報の報で通知と音を出すので、owners.test.ts と同じく adapter を止める。
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => ({ kind: "delivered" }),
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));

const env = process.env;
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "fleq-c22-window-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const isRecord = (value: JsonValue | undefined): value is Readonly<{ [key: string]: JsonValue }> =>
  typeof value === "object" && value != null && !Array.isArray(value);
const recordOf = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> => {
  if (!isRecord(value)) throw new Error(`not a record: ${JSON.stringify(value)}`);
  return value;
};
const listOf = (value: JsonValue | undefined): readonly JsonValue[] => {
  if (!Array.isArray(value)) throw new Error(`not a list: ${JSON.stringify(value)}`);
  return value;
};
const readJson = (path: string): Readonly<Record<string, JsonValue>> => recordOf(JSON.parse(readFileSync(path, "utf8")));
async function until(condition: () => boolean, milliseconds: number): Promise<boolean> {
  for (const end = performance.now() + milliseconds; !condition();) {
    if (performance.now() > end) return false;
    await new Promise((done) => setTimeout(done, 10));
  }
  return true;
}

// P3-FG-D-UQ-PEAK=A: 公開 fixture の VXSE53 の観測点を間引き、EventID と時刻を替えた報を count 通、10 秒おきに並べた筋書き（器を膨らませない）。
// 終わりの区切り（checkpoints）は U-Q.events の最後の current を結果に出すため（limits は max だけを持つ）。
// 間引き（統合担当の決め、2026-11-15）: 元の 136 点では 688 通目から畳みが始まる（T07 の初回）。City ごとに観測点を一様に残し、Area・City と Code は
// そのまま。各 City に 1 点を残すと 1024 通で器の 102.6% に届くので、点の無い City を許す。49% は 1024 通で器より 5% 以上低い最大の割合（44 点）。
const STATION_PERCENT = 49;
function uqScenario(count: number): Extract<Scenario, { kind: "ready" }> {
  const template = readFileSync("test/fixtures/32-35_04_04_240613_VXSE53.xml", "utf8").replace(/<City>[\s\S]*?<\/City>/g, (city) => {
    const station = /\s*<IntensityStation>[\s\S]*?<\/IntensityStation>/g;
    const total = city.match(station)?.length ?? 0, keep = Math.round(total * STATION_PERCENT / 100);
    let index = 0;
    return city.replace(station, (item) => (Math.floor(++index * keep / total) > Math.floor((index - 1) * keep / total) ? item : ""));
  });
  const reported = Date.parse(/<ReportDateTime>([^<]+)</.exec(template)![1]);
  const startMs = Date.parse("2026-07-01T00:00:00+09:00");
  const digest = createHash("sha256");
  const frames: Frame[] = Array.from({ length: count }, (_, index) => {
    const atMs = startMs + index * 10_000;
    const body = Buffer.from(shiftTimestamps(template, atMs - reported).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>2026070100${String(index).padStart(4, "0")}</EventID>`));
    digest.update(body);
    return { atMs, headType: "VXSE53", body, origin: "synthetic", source: "P3-FG-D-UQ-PEAK" };
  });
  const lastMs = frames[frames.length - 1].atMs;
  return { kind: "ready", id: `P3-FG-UQ-PEAK-${count}`, frames, digest: digest.digest("hex"), startMs, endMs: lastMs + 60_000,
    checkpoints: [{ atMs: lastMs + 1_000, label: "end" }], expectations: [], synth: null, t0: null };
}

// P3-DPM-T02a と同じ確かめ: file ごとの sha256 と、写した slot のうち世代の新しい方が山の世代。
function checkPeakFiles(dir: string, peak: Readonly<Record<string, JsonValue>>): Map<string, number> {
  const newest = new Map<string, number>();
  for (const file of listOf(peak["files"]).map(recordOf)) {
    const data = readFileSync(join(dir, "state", String(file["path"])));
    expect(sha256(data), String(file["path"])).toBe(file["sha256"]);
    const saved = recordOf(JSON.parse(data.toString("utf8")));
    newest.set(String(saved["unit"]), Math.max(newest.get(String(saved["unit"])) ?? 0, Number(saved["generation"])));
  }
  return newest;
}

// owners.test.ts の dataFrame と同じ形（本文は平文）。
function dataFrame(headType: string, body: string): string {
  return JSON.stringify({ type: "data", version: "2.0", classification: "telegram.weather", id: "id", format: "xml",
    encoding: "utf-8", compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
    xmlReport: { control: { status: "通常" } }, body });
}

// E20-STAGE-LIMITS（spec:889）の表はこの 1 つだけ。段ごとに自分の開始から測り、前段の超過を後段へ足さない。
const STAGE_LIMITS = { overall: 30_000, mailboxDrain: 10_000, sideEffectFinalization: 5_000, finalCheckpoint: 10_000, workerClose: 5_000 } as const;
const STAGES = ["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"] as const;

describe("P3-FINAL-GATE-001 order 3a window tools (gated)", () => {
  it.runIf(env["FLEQ_C22_STAGES"] != null)("P3-FG-T06 acceptance / AC05 (2)・AC08 (3): stage durations of a normal stop from the peak copy on the real host", async () => {
    const peakDir = env["FLEQ_C22_STAGES"]!, out = env["FLEQ_C22_STAGES_OUT"];
    if (out == null) throw new Error("FLEQ_C22_STAGES_OUT is required");
    const peakFile = readJson(join(peakDir, "peak.json"));
    const atMs = Number(recordOf(peakFile["peak"])["atMs"]);
    const record: Record<string, JsonValue> = { schema: "p3-final-gate-t06-v1", contractId: "P3-FINAL-GATE-001", peak: { dir: peakDir, scenario: peakFile["scenario"] ?? null,
      digest: peakFile["digest"] ?? null, gitHead: peakFile["gitHead"] ?? null, atMs },
      machine: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? null, cpus: cpus().length, node: process.version },
      note: "起点の N3 の山は 11 unit（U-V 無し）で U-Q は 696〜787 件止まり（Q-DPM-REMEASURE-20261114 の (4)(a)）。U-Q が満杯の state は AC08 (1) で取る。"
        + "要約の completedAt は closeWorker の前の値で、owner thread の終了の所要は stageResults の workerClose で読む。"
        + "Pi の窓（AC08 (3)）では status の Pass を『この予備条件では再現せず』と読み替える（AC08 は Pass と呼ばない）" };
    const write = () => writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
    const blocked = (reason: string, detail: string) => {
      record["status"] = "blocked";
      record["blocked"] = { reason, detail };
      write();
      return new Error(`blocked: ${reason}: ${detail}`);
    };
    // 山の上限と今の build の上限（runner.ts の EFFECTIVE_LIMITS と同じ形）。違う build で復元して測っても気づけないため。
    const limits = { bytes: Object.fromEntries(runtimeUnits.map((unit) => [unit, linkedUnitCodecs[unit]?.maxEnvelopeBytes ?? null])),
      seismic: { events: EVENT_LIMIT, longPeriods: LONG_PERIOD_LIMIT }, snapshotBytes: SNAPSHOT_BYTES };
    if (!isDeepStrictEqual(limits, peakFile["effectiveLimits"])) throw blocked("limitMismatch", JSON.stringify({ build: limits, peak: peakFile["effectiveLimits"] }));
    checkPeakFiles(peakDir, peakFile);
    const work = scratch();
    for (const file of listOf(peakFile["files"]).map(recordOf)) {
      mkdirSync(dirname(join(work, "state", String(file["path"]))), { recursive: true });
      copyFileSync(join(peakDir, "state", String(file["path"])), join(work, "state", String(file["path"])));
    }

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((done) => wss.once("listening", done));
    const sockets: WebSocket[] = [];
    wss.on("connection", (ws) => { sockets.push(ws); ws.on("error", () => {}); });
    cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
    // 段の時刻は root の state にだけあるので root を捕まえる（P3-FG-D-STAGE-CLOCK=A、owners.test.ts の P3-C3B-T03 の形）。
    const roots: RuntimeCompositionRoot[] = [];
    const shutdownRuntime = RuntimeCompositionRoot.prototype.shutdownRuntime;
    const spy = vi.spyOn(RuntimeCompositionRoot.prototype, "shutdownRuntime").mockImplementation(
      function (this: RuntimeCompositionRoot, ...args) { roots.push(this); return shutdownRuntime.apply(this, args); });
    cleanups.push(() => spy.mockRestore());
    // 12 本の受理まで owner への受け渡しを留め、停止の drain で放す。受信のターンが分かれると先に着いた報が running の段で保存され
    // （P3-UWR-AC03）、最終保存の段の unit が 12 に満たなくなるため。
    const gate = { open: true };
    const pump = RuntimeCompositionRoot.prototype.pump;
    const held = vi.spyOn(RuntimeCompositionRoot.prototype, "pump").mockImplementation(function (this: RuntimeCompositionRoot) { if (gate.open) pump.apply(this); });
    cleanups.push(() => held.mockRestore());
    const base = performance.now();
    const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: atMs + Math.trunc(monotonicMs - base), monotonicMs }; };
    const observations: P2HostObservation[] = [];
    let accepted = 0;
    const stopped: { summary: Promise<ShutdownSummary> | null } = { summary: null };
    const host = await startP2Host({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, stateDirectory: join(work, "state"),
      diagnosticDirectory: join(work, "diagnostics"), displayPort: 0, clock, observe: (o) => {
        observations.push(o);
        // 12 本目を mailbox が受けたら止める。drain の段で採られ、最終保存の段で保存される（T03 の場面 (4) と同じ流れ）。
        if (o.kind === "marker" && o.point === "T1" && ++accepted === 12) queueMicrotask(() => { gate.open = true; stopped.summary = host.stop(); });
      } });
    cleanups.push(() => host.stop().then(() => {}, () => {}));
    if (!await until(() => sockets.length === 1, 10_000)) throw blocked("hostFailed", "the host did not connect within 10 s");
    const wall = Math.floor(clock().wallTimeMs / 1_000) * 1_000;
    const reports = dirtyReports(wall, "202611150600");
    gate.open = false;
    for (const report of reports) sockets[0].send(dataFrame(report.headType, report.xml));
    if (!await until(() => stopped.summary != null, 30_000)) throw blocked("inputNotAccepted", `${accepted} of 12 accepted by the mailbox within 30 s`);
    const summary = await stopped.summary!;
    const [root] = roots;

    // この接続で送ったのは 12 本だけなので、host の通し番号 input-<n> は送った順（pi-measure と同じく inputId|unit で結ぶ）。
    const adopted = new Set(observations.flatMap((o) => (o.kind === "generationRaised" ? [`${o.inputId}|${o.unit}`] : [])));
    const missed = reports.flatMap((report, index) => (adopted.has(`input-${index + 1}|${report.unit}`) ? [] : [report.unit]));
    if (missed.length !== 0) throw blocked("dirtyNotAdopted", missed.join(", "));
    const { startedAt, stageResults } = root.state.shutdown;
    const ends = STAGES.map((stage) => stageResults[stage]?.clock.monotonicMs ?? null);
    if (startedAt == null || ends.some((end) => end == null)) throw blocked("stagesMissing", JSON.stringify(Object.keys(stageResults)));
    const starts = [startedAt.monotonicMs, ...ends.slice(0, -1).map(Number)];
    const stages = STAGES.map((stage, index) => ({ stage, startMs: starts[index] - startedAt.monotonicMs, durationMs: Number(ends[index]) - starts[index],
      result: stageResults[stage]?.result.kind ?? null }));
    // 最終保存の段の権（その段の開始から終わりまでに送った権）と、その試行の段ごとの所要。
    const checkpoints = observations.flatMap((o) => (o.kind === "checkpoint" ? [o.measurement] : []));
    const finalGrants = observations.flatMap((o) => (o.kind === "checkpointGrant" && o.grantSentMonotonicMs >= starts[2] && o.grantSentMonotonicMs <= Number(ends[2]) ? [o] : []));
    const finalSave: Record<string, JsonValue> = {};
    for (const grant of finalGrants) {
      const measured = checkpoints.filter((m) => grant.attemptIds.includes(m.attemptId));
      const ms = (stage: string) => measured.filter((m) => m.stage === stage).reduce((sum, m) => sum + m.endedMonotonicMs - m.startedMonotonicMs, 0);
      finalSave[grant.unit] = { encodeMs: ms("encode"), writeMs: ms("write"), fileSyncMs: ms("fileSync"),
        totalMs: measured.reduce((sum, m) => sum + m.endedMonotonicMs - m.startedMonotonicMs, 0), bytes: measured.find((m) => m.stage === "encode")?.bytes ?? null };
    }
    const summaryPath = join(work, "diagnostics", "shutdown-summary.json");
    const onDisk = existsSync(summaryPath) ? readJson(summaryPath) : null;
    Object.assign(record, { startedAt: { wallTimeMs: startedAt.wallTimeMs, monotonicMs: startedAt.monotonicMs }, stages,
      overallMs: Number(ends[3]) - startedAt.monotonicMs,
      finalSave: { units: finalSave, unitCount: Object.keys(finalSave).length,
        totalMs: Object.values(finalSave).reduce((sum: number, value) => sum + Number(recordOf(value)["totalMs"]), 0) },
      summary: onDisk == null ? null : { code: onDisk["code"] ?? null, reasons: onDisk["reasons"] ?? null, requestedAt: onDisk["requestedAt"] ?? null,
        completedAt: onDisk["completedAt"] ?? null } });
    if (Object.keys(finalSave).length < 12) throw blocked("finalUnits", `${Object.keys(finalSave).length} of 12 units saved in the final checkpoint stage`);

    const verdict = { stages: stages.map((item) => item.startMs <= STAGE_LIMITS.overall && item.durationMs <= STAGE_LIMITS[item.stage]),
      overall: Number(ends[3]) - startedAt.monotonicMs <= STAGE_LIMITS.overall, code: summary.code === 0 };
    record["status"] = verdict.stages.every(Boolean) && verdict.overall && verdict.code ? "Pass" : "Fail";
    record["verdict"] = verdict;
    write();
    console.info(`[P3-FG-T06] ${JSON.stringify({ status: record["status"], stages, overallMs: record["overallMs"], finalSave: record["finalSave"] })}`);
    expect(verdict).toEqual({ stages: [true, true, true, true], overall: true, code: true });
  }, 5 * 60_000);

  it.runIf(env["FLEQ_C22_UQ_PEAK"] != null)("P3-FG-T07 acceptance / AC08 (1): the U-Q peak filled to EVENT_LIMIT events before any eviction or fold", async () => {
    const dir = env["FLEQ_C22_UQ_PEAK"]!;
    const { result } = await runStage1(uqScenario(EVENT_LIMIT), { peakOut: dir });
    const current = recordOf(recordOf(listOf(result["checkpoints"]).at(-1))["usage"])["U-Q.events"];
    const evicted = recordOf(recordOf(result["evictions"])["total"])["U-Q"] ?? 0;
    const pass = recordOf(result["pass"]);
    const peak = readJson(join(dir, "peak.json"));
    const uq = peak["peak"] == null ? null : recordOf(recordOf(recordOf(peak["peak"])["units"])["U-Q"]);
    const limit = linkedUnitCodecs["U-Q"]?.maxEnvelopeBytes ?? null;
    // 判定の前に山の dir の t07.json と console に書く（器に先に届いたら、その時点の件数と bytes が残る、P3-FG-D-UQ-PEAK の A）。
    // 間引きの決め（1024 通で畳みの始まる閾値 GENERATION_LIMIT より 5% 以上低い）は記録だけで、合否は (1)〜(4)。
    const record = { status: result["status"], digest: result["digest"], events: current, stationPercent: STATION_PERCENT,
      stations: uqScenario(1).frames[0].body.toString().match(/<IntensityStation>/g)?.length ?? 0, foldLimit: limit, uqBytes: uq?.["bytes"] ?? null,
      uqRatio: limit == null || uq == null ? null : Number(uq["bytes"]) / limit, uqGeneration: uq?.["generation"] ?? null, evicted, folds: result["folds"],
      timing: result["timing"] };
    writeFileSync(join(dir, "t07.json"), `${JSON.stringify(record, null, 1)}\n`);
    console.info(`[P3-FG-T07] ${JSON.stringify(record)}`);
    expect(current).toBe(EVENT_LIMIT);
    expect([evicted, listOf(result["folds"]).length, pass["capacityLosses"], pass["inputRejections"]]).toEqual([0, 0, 0, 0]);
    expect(checkPeakFiles(dir, peak).get("U-Q")).toBe(uq?.["generation"]);
  }, 10 * 60_000);

  it.runIf(env["FLEQ_C22_WINDOW_TOOLS"] === "1")("P3-FG-T08 acceptance / AC08 (1)(2): pi-measure --dirty all writes the five save intervals, evictions and the EEW groups", async () => {
    const work = scratch(), peakDir = join(work, "peak"), out = join(work, "result.json");
    await runStage1(uqScenario(8), { peakOut: peakDir });
    const code = await new Promise<number | null>((done) => {
      spawn(process.execPath, ["reconstruction/test/disaster/pi-measure.mjs", "--peak", peakDir, "--work", join(work, "measure"), "--out", out,
        "--launches", "1", "--probe-seconds", "25", "--dirty", "all"], { stdio: "inherit" }).on("exit", done);
    });
    expect(code).toBe(0);
    const result = readJson(out);
    expect(result["blocked"]).toBeNull();
    const peakLaunch = recordOf(listOf(result["launches"])[1]);
    const saves = recordOf(peakLaunch["dirtySaves"]);
    console.info(`[P3-FG-T08] ${JSON.stringify({ dirtySaves: saves, evicted: peakLaunch["seismicCapacityEvicted"],
      eew: Object.fromEntries(Object.entries(recordOf(peakLaunch["eew"])).map(([group, value]) => [group, recordOf(value)["count"]])) })}`);
    expect(Object.keys(saves).sort()).toEqual([...runtimeUnits].sort());
    for (const unit of runtimeUnits) {
      const intervals = recordOf(saves[unit]);
      expect(Object.keys(intervals), unit).toEqual(["rightWaitMs", "startWaitMs", "captureEncodeMs", "writeThroughDirectorySyncMs", "ackApplyMs"]);
      expect(Object.values(intervals).every((value) => typeof value === "number"), unit).toBe(true);
    }
    expect([peakLaunch["seismicCapacityEvicted"], recordOf(result["seismicCapacityEvicted"])["total"]]).toEqual([0, 0]);
    expect(Object.keys(recordOf(peakLaunch["eew"]))).toEqual(expect.arrayContaining(["seismicProcessing", "urgentSave", "seismicSave", "otherSave"]));
  }, 180_000);
});
