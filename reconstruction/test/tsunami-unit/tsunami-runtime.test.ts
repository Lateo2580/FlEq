import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, seeded, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { at, background, calls, eewEnvelope, notice } from "../notification-delivery/delivery-fixture";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import type { Area } from "./tsunami-fixture";
import { observation, vtse41 } from "./tsunami-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-T を通す。

class MemoryFiles implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  failWrite = false;
  writeGate: Promise<void> | null = null;
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return {
      write: async (value) => {
        await park(this.writeGate);
        if (this.failWrite) throw new Error("injected write failure");
        bytes = value.slice();
      },
      sync: async () => {},
      close: async () => { this.files.set(path, bytes); },
    };
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
const config = { appName: "fleq-p3", stateDirectory: "tsunami-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "tsunami-diagnostics" } as const;

let inputSequence = 0;
function report(h: Harness, file: string, now: ClockReading, headType = "VTSE41") {
  return submit(h, envelope(h.root.state.runId, headType, `${file}#${++inputSequence}`, readFileSync(`test/fixtures/${file}.xml`), now, inputSequence));
}

// P3-C5-E21-LOAD-T-v1 の T1 の津波緊急（EventID 20990101000011、311 の大津波警報の発令 → critical）。
function tsunamiEnvelope(runId: string, now: ClockReading): ReturnType<typeof envelope> {
  const xml = vtse41({ eventId: "20990101000011", at: new Date(now.wallTimeMs).toISOString(),
    areas: [{ code: "311", name: "千葉県内房", kind: "52" }] });
  return envelope(runId, "VTSE41", `tsunami#${++inputSequence}`, Buffer.from(xml), now, inputSequence);
}

async function delivery(start: ClockReading) {
  let now = start;
  const seeds = seeded(calls.units);
  const notices = manualAdapter();
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: notices.adapter,
    checkpointFileSystem: new MemoryFiles(), diagnosticFileSystem: new MemoryDiagnostics(), runtimeCalls: { ...calls, units: seeds.units } });
  await startHarness(h, "c5-e21", start);
  return { h, seeds, notices,
    at(time: ClockReading) { now = time; },
    async finish(result: NotificationResult) { now = result.completedAt; notices.finish(result); await h.settle(); },
    started(from: number): NotificationAttempt[] { return notices.runs.slice(from).map((run) => run.attempt); } };
}

// 合成の VTSE41・VTSE51 を host が受ける形（本文の bytes）で publisher に通す（TEST-PATH (2)）。
const EVENT = "20990101000011";
const minute = (value: number) => Date.parse("2099-01-01T09:00:00+09:00") + value * 60_000;
const forecastReport = (value: number, areas: readonly Area[], infoType: "発表" | "取消" = "発表") => ({ headType: "VTSE41",
  inputId: `vtse41-${value}`, body: Buffer.from(vtse41({ at: new Date(minute(value)).toISOString(), infoType, areas })) });

describe("P3-TSUNAMI-UNIT-001 U-T through the composition root", () => {
  // acceptance: P3-C5-SNAPSHOT=A の重大度の対応。released と none は載せず、名前だけの区域も重大度に数える（AC06）。
  it("P3-C5-T02 acceptance / AC06: the snapshot tsunami domain maps area classes and leaves released and none out", async () => {
    const clockAt = (value: number) => ({ wallTimeMs: minute(value), monotonicMs: 1 + value });
    const started = await startup(clockAt(0));
    let projection = projected(projectSnapshot(projectionInput(started, minute(0)), null)).state;
    let state = started.state;
    const send = async (value: number, areas: readonly Area[]) => {
      const next = await step(state, received("run", forecastReport(value, areas), clockAt(value)));
      const result = projected(projectSnapshot(projectionInput(next, minute(value)), projection));
      state = next.state;
      projection = result.state;
      return result.snapshot.current.tsunami.items[0];
    };
    expect(await send(1, [{ code: "311", name: "a", kind: "52" }, { code: "312", name: "b", kind: "71" },
      { code: "313", name: "c", kind: "60" }, { code: "314", name: "d", kind: "00" }]))
      .toMatchObject({ informationType: "tsunami", activeCount: 1, highestSeverity: "specialWarning",
        areaCounts: { tsunamiForecastArea: 2, tsunamiStation: 0 } });
    expect(await send(2, [{ code: "311", name: "a", kind: "99" }])).toMatchObject({ highestSeverity: "warning" });
    expect(await send(3, [{ code: "311", name: "a", kind: "62" }, { code: "312", name: "b", kind: "71" }]))
      .toMatchObject({ highestSeverity: "advisory", areaCounts: { tsunamiForecastArea: 2 } });
    // 名前だけの区域（unkeyedAreas）の active も重大度を持つ（区域の数には入れない）。
    expect(await send(4, [{ name: "名前だけの区域", kind: "51" }]))
      .toMatchObject({ activeCount: 1, highestSeverity: "warning", areaCounts: { tsunamiForecastArea: 0 } });
    expect(await send(5, [{ code: "311", name: "a", kind: "60" }])).toMatchObject({ activeCount: 0, highestSeverity: null,
      areaCounts: { tsunamiForecastArea: 0 } });
  });

  // acceptance: I-U-T.confirmationScope。U-T の scope は VTSE41 の event の行だけで、view から外れると退く（AC06）。
  it("P3-C5-T02 acceptance / AC06: a VTSE41 adoption carries the U-T event scope, observations none, and it retires on leaving", async () => {
    const clockAt = (value: number) => ({ wallTimeMs: minute(value), monotonicMs: 1 + value });
    const scopes = (value: Awaited<ReturnType<typeof startup>>) =>
      value.state.confirmation.units["U-T"].normal.scopes.map((item) => item.scope);
    const started = await startup(clockAt(0));
    const issued = await step(started.state, received("run", forecastReport(1, [{ code: "311", name: "a", kind: "52" }]), clockAt(1)));
    expect(scopes(issued)).toEqual([{ unit: "U-T", operation: "normal", kind: "event", eventId: EVENT }]);
    const observed = await step(issued.state, received("run", { headType: "VTSE51", inputId: "vtse51-2",
      body: Buffer.from(observation({ at: new Date(minute(2)).toISOString(), serial: 1, stations: [{ code: "21001" }] })) }, clockAt(2)));
    expect(observed.state.units["U-T"].observations).toHaveLength(1);
    expect(scopes(observed)).toEqual(scopes(issued));
    const released = await step(observed.state, received("run", forecastReport(3, [{ code: "311", name: "a", kind: "50" }]), clockAt(3)));
    expect(scopes(released)).toEqual([]);
  });


  // acceptance: P3-C5-E21-LOAD-T-v1 の T1（制御 adapter、P2-A7 の C1 と同じ背景）と T3（公開 fixture の replay）（AC08）。
  it("P3-C5-T07 acceptance / AC08: T1 order EEW → tsunami emergency → other within 1 s, and T3 replay waits", async () => {
    for (const withEew of [false, true]) {
      const d = await delivery(at(-100));
      await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: background(at(0)) });
      const lower = d.started(0);
      expect(lower.map((item) => item.intentId)).toEqual(["lower-desktop", "lower-sound"]);
      d.at(at(0));
      await submit(d.h, tsunamiEnvelope("c5-e21", at(0)));
      const emergency = d.h.unit("U-T").intents.filter((item) => item.disposition === "pending");
      expect(emergency.map((item) => [item.channel, item.payload.level])).toEqual([["desktop", "critical"], ["sound", "critical"]]);
      // 緊急の到着で下位の試行を止める（遅い成功で書き換えない）。
      expect(d.notices.aborts).toEqual(lower.map((item) => item.attemptId));
      if (withEew) { d.at(at(10)); await submit(d.h, eewEnvelope("c5-e21", at(10), "A")); }
      let active: NotificationAttempt[] = [];
      for (const attempt of lower) {
        const before = d.notices.runs.length;
        await d.finish({ kind: "aborted", reason: "higherPriority", stopped: true, attemptId: attempt.attemptId,
          intentId: attempt.intentId, channel: attempt.channel, completedAt: at(50) });
        active.push(...d.started(before));
      }
      const order: string[] = [];
      const waits: number[] = [];
      for (let round = 0; active.length !== 0 && round < 4; round++) {
        const following: NotificationAttempt[] = [];
        for (const selected of active) {
          order.push(`${selected.channel}:${selected.priorityGroup}`);
          const generated = selected.unit === "U-T" ? 0 : selected.unit === "U-E" ? 10 : null;
          if (generated != null) waits.push(selected.selectedAtMonotonicMs - generated);
          const before = d.notices.runs.length;
          await d.finish({ kind: "delivered", attemptId: selected.attemptId, intentId: selected.intentId, channel: selected.channel,
            completedAt: at(100 + 50 * order.length) });
          following.push(...d.started(before));
        }
        active = following;
      }
      const groups = withEew ? ["normalEew", "normalTsunamiEmergency", "other"] : ["normalTsunamiEmergency", "other"];
      for (const channel of ["desktop", "sound"]) expect(order.filter((item) => item.startsWith(channel)).map((item) => item.split(":")[1]))
        .toEqual(groups);
      expect(Math.max(...waits)).toBeLessThanOrEqual(1_000);
      console.info(`P3-C5 E21 T1 (${withEew ? "with EEW A" : "tsunami only"}) generation-to-call ms`, waits);
    }

    // T3: 32-39_11_02 → 32-39_11_09 → 32-39_11_11 を 1000 ms 間隔で投入し、通知機会で生成された intent だけを計測する。
    const calls: { attempt: NotificationAttempt; monotonicMs: number }[] = [];
    let now: ClockReading = { wallTimeMs: Date.parse("2011-03-11T14:49:00+09:00"), monotonicMs: 0 };
    const adapter = recordingNotificationAdapter();
    const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: new MemoryFiles(),
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter: { ...adapter,
        run: (attempt, clock) => { calls.push({ attempt, monotonicMs: clock().monotonicMs }); return adapter.run(attempt, clock); } } });
    await startHarness(h, "c5-t3", now);
    const generated: Record<string, number> = {};
    for (const [index, file] of ["32-39_11_02_250206_VTSE41", "32-39_11_09_250206_VTSE41", "32-39_11_11_250206_VTSE41"].entries()) {
      now = { wallTimeMs: now.wallTimeMs + (index === 0 ? 0 : 1_000), monotonicMs: index * 1_000 };
      const known = new Set(h.unit("U-T").intents.map((item) => item.id));
      await report(h, file, now);
      for (const item of h.unit("U-T").intents) if (!known.has(item.id)) generated[item.id] = now.monotonicMs;
    }
    const waits = calls.filter((item) => item.attempt.intentId in generated)
      .map((item) => item.monotonicMs - generated[item.attempt.intentId]);
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1_000);
    console.info("P3-C5 E21 T3 replay generation-to-call ms", waits);
  });

  // contractBoundary: 通知期限の表は runtimeUnits の数×128（U-T を足して 512）まで止まらない（AC14）。
  it("P3-C5-T10 contractBoundary / AC14: four units with pending intents exceed 384 deadlines without a RangeError", async () => {
    const d = await delivery(at(0));
    const pending = (unit: NotificationIntent["unit"], count: number) => Array.from({ length: count }, (_, index) => ({
      ...notice(`${unit}-${index}`), unit, id: `${unit}-${index}`, channel: index % 2 === 0 ? "desktop" as const : "sound" as const }));
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: pending("U-W", 128) });
    await d.seeds.series(d.h, { ...d.h.unit("U-F"), intents: pending("U-F", 128) });
    await d.seeds.eew(d.h, { ...d.h.unit("U-E"), intents: pending("U-E", 128).map((item) => ({ ...item,
      payload: { domain: "earthquake-eew" as const, level: "warning" as const, title: "試験", body: "試験" } })) });
    const tsunami = pending("U-T", 128).map((item) => ({ ...item, subject: "normal/VTSE41/20990101000011",
      source: { ...item.source, subject: "normal/VTSE41/20990101000011", family: "VTSE41" },
      payload: { domain: "tsunami" as const, level: "info" as const, title: "試験", body: "試験" } }));
    await d.seeds.tsunami(d.h, { ...d.h.unit("U-T"), intents: tsunami });
    const size = Object.values(d.h.root.state.notificationDeadlines).reduce((sum, map) => sum + Object.keys(map).length, 0);
    expect(size).toBe(512);
    expect(d.h.failures).toEqual([]);
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報を composition root の一経路で（AC11）。
  it("P3-C5-T11 acceptance / AC11: cancel during save failure, old ack, normal shutdown and the follow-up after restore", async () => {
    let now: ClockReading = { wallTimeMs: Date.parse("2011-03-11T14:49:00+09:00") + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-T"].view;
      if (value.unit !== "U-T") throw new Error("mirror view of another unit");
      return value;
    };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    // 試行を終わらせない adapter で、発令の intent を pending（試行中）のまま取消に会わせる。
    const running = manualAdapter();
    const failed = wired(failing, running.adapter);
    await startHarness(failed, "c5-failed", now);
    await report(failed, "32-39_11_02_250206_VTSE41", now);
    expect(failed.unit("U-T").persistence.kind).toBe("failed");
    const issuedIntents = failed.unit("U-T").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-T").persistence.currentGeneration;
    await report(failed, "synthetic_VTSE41_cancel", tick(1_000));
    const afterCancel = failed.unit("U-T");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    // 試行中の発令の intent は superseded になり、A7 がその試行を止める。
    expect(running.aborts).toHaveLength(2);
    expect(afterCancel.forecasts).toMatchObject([{ effective: "cancelled", areas: [] }]);
    expect(view(failed).forecasts).toEqual([]);
    expect(afterCancel.intents.filter((item) => issuedIntents.includes(item.id)).map((item) => item.disposition))
      .toEqual(issuedIntents.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: Date.parse("2011-03-11T14:49:00+09:00") + 1, monotonicMs: 1 };
    // 通知の probe を終えない（試行の結果で世代が進まない）ので、世代は採用の数だけ進む。
    await startHarness(acking, "c5-ack", now, false);
    await report(acking, "32-39_11_02_250206_VTSE41", now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c5-ack", "VTSE41", `follow#${++inputSequence}`,
      readFileSync("test/fixtures/32-39_11_09_250206_VTSE41.xml"), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    expect(acking.owners.get("urgent")!["state"]!.checkpointAttempts["U-T"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: followAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-T").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: followAt.monotonicMs });
    expect(view(acking).forecasts[0].source.reportDateTimeRaw).toBe("2011-03-11T15:00:00+09:00");

    // 通常終了と復元直後の続報: 復元した state との差で決め、同じ発令を再び緊急群にしない。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: Date.parse("2011-03-11T15:00:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(first, "c5-run1", now, false);
    await report(first, "32-39_11_09_250206_VTSE41", now);
    const pendingBefore = first.unit("U-T").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-T"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    const second = wired(files);
    await startHarness(second, "c5-run2", tick(1), false);
    expect(second.root.state.restoration["U-T"]).toEqual({ kind: "restored" });
    expect(view(second).forecasts.map((item) => item.subject)).toEqual(["normal/VTSE41/20110311144640"]);
    expect(second.unit("U-T").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-T").intents.map((item) => item.id));
    await report(second, "synthetic_VTSE41_correction", tick(1_000));
    expect(second.unit("U-T").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.payload.title]))
      .toEqual([["normal", "[訂正] 大津波警報"], ["normal", "[訂正] 大津波警報"]]);
    expect(second.failures).toEqual([]);
  });
});
