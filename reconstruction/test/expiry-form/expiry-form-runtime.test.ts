import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { OwnerReply, OwnerRequest } from "../../contracts/p3-execution-split.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { OwnerHost } from "../../src/runtime/owner-host";
import { shiftTimestamps } from "../eew-e01/frames.mjs";
import { envelope, harnessedRoot, idleChannels, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// P3-EF-T01（P3-EF-AC01・AC02・AC04・AC05）: 実 owner を通した保存→復元で、contentBasis の根拠ごとに期限の当て方が分かれる。
// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）。

class MemoryFiles implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return { write: async (value) => { bytes = value.slice(); }, sync: async () => {}, close: async () => { this.files.set(path, bytes); } };
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes == null) throw new Error("missing temporary");
    this.files.set(to, bytes);
    this.files.delete(from);
  }
  async syncDirectory(): Promise<void> {}
}
class MemoryDiagnostics implements DiagnosticFileSystem {
  readonly lines = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async appendFile(path: string, data: string): Promise<void> { this.lines.set(path, (this.lines.get(path) ?? "") + data); }
  async readLastByte(path: string): Promise<number | null> { return Buffer.from(this.lines.get(path) ?? "").at(-1) ?? null; }
  async writeFile(path: string, data: string): Promise<void> { this.lines.set(path, data); }
  async rename(from: string, to: string): Promise<void> { this.lines.set(to, this.lines.get(from) ?? ""); this.lines.delete(from); }
  async readFile(path: string): Promise<string> { return this.lines.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.lines.delete(path); }
}
const config = { appName: "fleq-p3", stateDirectory: "expiry-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "expiry-diagnostics" } as const;

const HOUR = 3_600_000;
// 元報 R は U-L の 15_16_01 の ReportDateTime。津波の 2 報は時刻を R へ平行移動する（試験の中で inline に作る、AC12 (2)）。
const R = Date.parse("2020-06-22T23:00:00+09:00");
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const moved = (file: string, reportRaw: string) => Buffer.from(shiftTimestamps(text(file), R - Date.parse(reportRaw)));
const landslide = Buffer.from(text("15_16_01_241031_VPWW56"));
const at = (offsetMs: number, monotonicMs = offsetMs): ClockReading => ({ wallTimeMs: R + offsetMs, monotonicMs });
const unavailable = { kind: "unavailable", reason: "backendMissing" } as const;

function adapter() {
  const attempts: unknown[] = [];
  return { attempts, run: (attempt: unknown) => { attempts.push(attempt); return new Promise<never>(() => {}); },
    abort: async () => { throw new Error("no abort expected"); } };
}
function wired(files: MemoryFiles, now: { value: ClockReading }, basis: { value: WallBasis } | null) {
  const fake = adapter();
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now.value, checkpointFileSystem: files,
    diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter: fake as never,
    ...basis == null ? {} : { wallBasis: () => basis.value, contentBasis: () => basis.value } });
  return { h, fake };
}
const tick = async (h: Harness, now: { value: ClockReading }, clock: ClockReading) => {
  now.value = clock; h.root.mailbox.recordWorkerResponse(clock.monotonicMs); h.root.tick(clock); await h.settle();
};
const landslideCurrent = (h: Harness) => h.unit("U-L").currents[0];
const observation = (h: Harness) => h.unit("U-T").observations[0];
const views = (h: Harness) => {
  const l = h.root.state.mirror["U-L"].view, t = h.root.state.mirror["U-T"].view;
  if (l.unit !== "U-L" || t.unit !== "U-T") throw new Error("mirror view of another unit");
  return [l.currents.length, t.observations.length];
};
const save = async (h: Harness) => { await h.root.driveCheckpoint(); await h.settle(); };

// 前回の起動: 両 channel が使えないまま U-L の active・U-T の観測・VTSE41 の pending の通知を受けて保存する。
async function savedRun() {
  const files = new MemoryFiles();
  const now = { value: at(1_000) };
  const { h } = wired(files, now, null);
  await startHarness(h, "k10-saved", now.value, false);
  h.root.dispatch({ kind: "notificationProbeCompleted", channels: { desktop: unavailable, sound: unavailable }, clock: now.value });
  await h.settle();
  await submit(h, envelope("k10-saved", "VPWW56", "k10-l", landslide, now.value, 1),
    envelope("k10-saved", "VTSE51", "k10-t51", moved("synthetic_VTSE51_fragmentA", "2011-03-11T15:02:00+09:00"), now.value, 2),
    envelope("k10-saved", "VTSE41", "k10-t41", moved("synthetic_VTSE41_e01_311warning", "2026-01-01T11:59:20+09:00"), now.value, 3));
  await save(h);
  const saved = { landslide: landslideCurrent(h), observation: observation(h),
    intents: h.unit("U-T").intents.filter((item) => item.subject.includes("VTSE41")).map((item) => item.id) };
  expect([saved.landslide.effective, saved.observation.effective, saved.intents.length > 0]).toEqual(["active", "active", true]);
  await h.root.diagnostics.flush();
  return { files, saved };
}
const facts = (item: ReturnType<typeof landslideCurrent>) => item.effective === "active" ? [item.title, item.kinds] : null;

describe("P3-EF-T01 acceptance / AC01,AC02,AC04,AC05: the content basis decides what a restored run expires", () => {
  it("(a)(b)(c) awaiting holds everything; unverified marks and keeps facts across a save; verified moves to the memories", async () => {
    const { files, saved } = await savedRun();
    const basis = { value: "awaiting" as WallBasis };
    const now = { value: at(49 * HOUR, 0) };
    const { h, fake } = wired(files, now, basis);
    await startHarness(h, "k10-a", now.value, false);
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock: now.value });
    await h.settle();
    // (a) awaiting: 見えたまま、pending の intent は unit で失効せず、publisher も保留する。
    await tick(h, now, at(49 * HOUR, 1_000));
    expect([landslideCurrent(h), observation(h), views(h), h.unit("U-T").intents.map((item) => item.id).filter((id) => saved.intents.includes(id)),
      fake.attempts.length]).toEqual([saved.landslide, saved.observation, [1, 1], saved.intents, 0]);
    // (b) unverified: 保留の印で view から外れ、事実・観測点・通知の印は残る。retainUntil（元報＋48 時間）を過ぎても消えない。
    basis.value = "unverified";
    await tick(h, now, at(49 * HOUR, 2_000));
    const marked = landslideCurrent(h);
    expect([marked.effective === "active" && marked.expiryPending, facts(marked), marked.notice != null, observation(h).expiryPending,
      observation(h).stations, views(h)]).toEqual([true, facts(saved.landslide), saved.landslide.notice != null, true,
      saved.observation.stations, [0, 0]]);
    // 復元由来の通知は K9 どおり publisher が notificationExpiredClockUnverified で失効させる（試行はしない）。
    const updates = h.sent.flatMap((item) => item.request.kind === "intentUpdate" ? item.request.updates : []);
    expect([fake.attempts.length, saved.intents.every((id) => updates.some((update) => update.id === id
      && update.lossReason === "notificationExpiredClockUnverified"))]).toEqual([0, true]);
    await save(h);
    await h.root.diagnostics.flush();
    // 保存して unverified のまま復元しても、印と事実が残る。
    const again = wired(files, now, basis);
    await startHarness(again.h, "k10-b", at(50 * HOUR, 0), false);
    expect([landslideCurrent(again.h), observation(again.h).expiryPending, observation(again.h).stations])
      .toEqual([marked, true, saved.observation.stations]);
    // (c) verified: 最初の期限要求で U-L は事実の無い expired の記憶（retainUntil は元報＋54 時間）に、U-T の観測は観測点の無い expired に移る。
    basis.value = "verified";
    await tick(again.h, now, at(50 * HOUR, 1_000));
    expect([landslideCurrent(again.h), observation(again.h).effective, observation(again.h).stations]).toEqual([{ subject: saved.landslide.subject,
      operation: "normal", office: saved.landslide.office, source: saved.landslide.source, ...saved.landslide.notice == null ? {}
        : { notice: landslideCurrent(again.h).notice }, effective: "expired", retainUntil: R + 54 * HOUR }, "expired", []]);
    // retainUntil を過ぎた記録は消える。
    await tick(again.h, now, at(54 * HOUR + 1, 2_000));
    expect(again.h.unit("U-L").currents).toEqual([]);
    await again.h.root.diagnostics.flush();
  });

  it("(d) without contentBasis the restore moves the records to the memories at the same time as today", async () => {
    const { files, saved } = await savedRun();
    const now = { value: at(49 * HOUR, 0) };
    const { h } = wired(files, now, null);
    await startHarness(h, "k10-d", now.value, false);
    expect([landslideCurrent(h).effective, landslideCurrent(h).retainUntil, observation(h).effective, observation(h).stations])
      .toEqual(["expired", R + 54 * HOUR, "expired", []]);
    expect(saved.landslide.retainUntil).toBe(R + 48 * HOUR);
    await h.root.diagnostics.flush();
  });

  it("(e) a clock set back: verified after unverified moves the pending record at once, running and through a restore", async () => {
    const files = new MemoryFiles();
    const basis = { value: "unverified" as WallBasis };
    const now = { value: at(1_000) };
    const { h } = wired(files, now, basis);
    await startHarness(h, "k10-e", now.value);
    await submit(h, envelope("k10-e", "VPWW56", "k10-e-l", landslide, now.value, 1));
    await tick(h, now, at(49 * HOUR, 1_000));
    expect(landslideCurrent(h)).toMatchObject({ effective: "active", expiryPending: true });
    await save(h);
    await h.root.diagnostics.flush();
    // 保留の状態を R＋1 時間の時計の verified で復元しても、復元の要求で記憶に移る（元の表示の期限 R＋48 時間を待たない）。
    const restored = wired(files, now, { value: "verified" });
    await startHarness(restored.h, "k10-e2", at(HOUR, 0));
    expect(landslideCurrent(restored.h)).toMatchObject({ effective: "expired", retainUntil: R + 54 * HOUR });
    await restored.h.root.diagnostics.flush();
    // 走行中に時計を R＋1 時間へ戻して verified にすると、最初の要求で記憶に移る。
    basis.value = "verified";
    await tick(h, now, at(HOUR, 2_000));
    expect(landslideCurrent(h)).toMatchObject({ effective: "expired", retainUntil: R + 54 * HOUR });
    await h.root.diagnostics.flush();
  });

  it("(f) when the first verified request is a detail, the next deadline evaluates once and its output carries the change", () => {
    const replies: OwnerReply[] = [];
    const owner = new OwnerHost({ start: { place: "deferred", stateDirectory: config.stateDirectory, publisherTimeOriginMs: 0, measured: false,
      inputHeap: false }, units: linkedUnitTable, codecs: linkedUnitCodecs, fileSystem: new MemoryFiles(), sharedNow: () => 0,
    reply: (reply) => { replies.push(reply); }, fail: (error) => { throw error; } });
    const send = (request: OwnerRequest) => { owner.handle(request); return replies.at(-1)!; };
    const clock = at(HOUR, 0);
    send({ kind: "restore", runId: "k10-f", clock, sharedMs: 0, basis: "unverified" });
    send({ kind: "input", clock, sharedMs: 0, basis: "unverified", envelope: envelope("k10-f", "VPWW56", "k10-f-l", landslide, clock) });
    send({ kind: "deadline", clock: at(49 * HOUR, 0), sharedMs: 0, basis: "unverified" });
    const pending = owner["state"]!.units["U-L"]!;
    expect(pending.currents[0].effective === "active" && pending.currents[0].expiryPending).toBe(true);
    const detail = send({ kind: "detail", clock, sharedMs: 0, basis: "verified", detail: { part: "index", revision: "0", page: 0 } });
    expect([detail.kind, owner["state"]!.units["U-L"]]).toEqual(["detailDone", pending]);
    const first = send({ kind: "deadline", clock, sharedMs: 0, basis: "verified" });
    if (first.kind !== "deadlineDone") throw new Error("deadlineDone expected");
    const moved = owner["state"]!.units["U-L"]!;
    // 保留の記録は印を付けた時点で view から外れているので、記憶への移行は保存の世代として output に出る（表示の変化は印の時点で出た）。
    expect([moved.currents[0].effective, first.output.units.find((item) => item.unit === "U-L")?.persistence.currentGeneration])
      .toEqual(["expired", pending.persistence.currentGeneration + 1]);
    const second = send({ kind: "deadline", clock: at(HOUR, 1_000), sharedMs: 0, basis: "verified" });
    if (second.kind !== "deadlineDone") throw new Error("deadlineDone expected");
    expect([owner["state"]!.units["U-L"], second.output.displayChanges]).toEqual([moved, []]);
    expect(owner["state"]!.units["U-L"]).toBe(moved);
  });
});
