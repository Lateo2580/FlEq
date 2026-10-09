import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { decode, projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-Q を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "seismic-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "seismic-diagnostics" } as const;

const P75 = (name: string) => `telegram-foundation/phase7_5_${name}`;
const S53A = P75("VXSE53_20260728162718_99e82c812e72"), S53B = P75("VXSE53_20260728162718_bf35e8ea1825");
let inputSequence = 0;
function report(h: Harness, file: string, now: ClockReading, headType = "VXSE53") {
  return submit(h, envelope(h.root.state.runId, headType, `${file}#${++inputSequence}`, readFileSync(`test/fixtures/${file}.xml`), now, inputSequence));
}

describe("P3-UNIT-Q-001 U-Q through the composition root", () => {
  // contractBoundary: A7 の群（P3-C7-NOTICE-GROUP=A）。U-Q の critical は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  // 実不具合の再発防止: 変更前の group() は domain=earthquake-eew の U-Q の intent を normalEew にし、試行中の津波緊急を止めていた。
  it("P3-C7-T08 contractBoundary / AC09: U-Q intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2026-07-28T16:31:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t08", disposition: "pending" });
    // U-Q を最も古く作る（同じ群なら先に選ばれる位置）。
    const quake = notice("U-Q", "earthquake-eew", "critical", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, quake], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, quake]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    // 同時に pending: EEW → 津波緊急 → U-Q の順。U-E は normalEew のまま。
    let state: NotificationDeliveryState = { intents: [quake, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([quake, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-Q:other"]);
  });

  // acceptance: P3-C7-SNAPSHOT=A。snapshot の domain earthquake は event で数え、重大度を持たず、取消で載らなくなる（AC07）。
  it("P3-C7-T02 acceptance / AC07: the snapshot earthquake domain counts events and areas, no severity, cancel leaves it", async () => {
    const at = (iso: string, monotonicMs: number) => ({ wallTimeMs: Date.parse(iso), monotonicMs });
    const started = await startup(at("2026-07-28T16:31:00+09:00", 1));
    let projection = projected(projectSnapshot(projectionInput(started, Date.parse("2026-07-28T16:31:00+09:00")), null)).state;
    let state = started.state;
    const send = async (file: string, headType: string, iso: string, monotonicMs: number) => {
      const next = await step(state, received("run", decode(file, headType, undefined, `${file}#${++inputSequence}`), at(iso, monotonicMs)));
      const result = projected(projectSnapshot(projectionInput(next, Date.parse(iso)), projection));
      state = next.state;
      projection = result.state;
      return result.snapshot.current.earthquake;
    };
    const quake = await send(S53A, "VXSE53", "2026-07-28T16:31:00+09:00", 2);
    expect(quake.items[0]).toMatchObject({ informationType: "earthquake", activeCount: 1, highestSeverity: null,
      updatedAt: Date.parse("2026-07-28T16:31:00+09:00") });
    // view は観測点を載せないので、数えるのは都道府県・細分区域・市町村（P3-C7-AC12）。
    expect(Object.keys(quake.items[0].areaCounts).sort()).toEqual(["municipality", "prefecture", "seismicArea"]);
    expect(quake.items[0].areaCounts.municipality).toBeGreaterThan(0);
    // 長周期は同じ地震の区域を足すだけで件数を増やさない。
    const longPeriod = await send(P75("VXSE62_20260728162718_f9786edc27df"), "VXSE62", "2026-07-28T16:37:00+09:00", 3);
    expect(longPeriod.items[0]).toMatchObject({ activeCount: 1, highestSeverity: null });
    const cancelled = await send("synthetic_VXSE53_cancel", "VXSE53", "2026-07-28T16:38:00+09:00", 4);
    expect(cancelled.items[0]).toMatchObject({ activeCount: 0 });
    // 復元・確認は U-Q の行で別に載る（空・unavailable を「地震なし」に読み替えない材料）。
    expect(projection.snapshot!.recovery["U-Q"]).toEqual({ kind: "empty" });
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、U-E・U-T・U-Q の同時 dirty（AC11）。
  it("P3-C7-T10 acceptance / AC11: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: Date.parse("2026-07-28T16:31:00+09:00") + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-Q"].view;
      if (value.unit !== "U-Q") throw new Error("mirror view of another unit");
      return value;
    };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c7-failed", now);
    await report(failed, S53A, now);
    expect(failed.unit("U-Q").persistence.kind).toBe("failed");
    const issued = failed.unit("U-Q").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-Q").persistence.currentGeneration;
    await report(failed, "synthetic_VXSE53_cancel", tick(1_000));
    const afterCancel = failed.unit("U-Q");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    // 試行中の発表の intent は superseded になり、A7 がその試行を止める。
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).earthquakes).toEqual([]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: Date.parse("2026-07-28T16:31:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(acking, "c7-ack", now, false);
    await report(acking, S53A, now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c7-ack", "VXSE53", `follow#${++inputSequence}`,
      readFileSync(`test/fixtures/${S53B}.xml`), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    expect(acking.owners.get("urgent")!["state"]!.checkpointAttempts["U-Q"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: followAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-Q").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: followAt.monotonicMs });
    expect(view(acking).earthquakes[0].sources[0].reportDateTimeRaw).toBe("2026-07-28T16:35:00+09:00");

    // 通常終了と復元直後の続報: 復元した state との差で決め、同じ地震を再び鳴らさない。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: Date.parse("2026-07-28T16:35:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(first, "c7-run1", now, false);
    await report(first, S53B, now);
    const pendingBefore = first.unit("U-Q").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-Q"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    const second = wired(files);
    await startHarness(second, "c7-run2", tick(1), false);
    expect(second.root.state.restoration["U-Q"]).toEqual({ kind: "restored" });
    expect(view(second).earthquakes.map((item) => item.subject)).toEqual(["normal/earthquake/20260728162718"]);
    expect(view(second).earthquakes[0].strongHold).toMatchObject({ until: Date.parse("2026-07-28T16:27:00+09:00") + 12 * 3_600_000 });
    expect(second.unit("U-Q").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-Q").intents.map((item) => item.id));
    await report(second, S53B, tick(1_000));
    expect(second.unit("U-Q").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, "synthetic_VXSE53_correction", tick(1_000));
    expect(second.unit("U-Q").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.payload.title]))
      .toEqual([["warning", "[訂正] 震源・震度情報"], ["warning", "[訂正] 震源・震度情報"]]);
    expect(second.failures).toEqual([]);

    // U-E・U-T・U-Q の同時 dirty: urgent の 3 unit は別々の書込み権を持つ（P3-C7-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const three = wired(parked);
    now = { wallTimeMs: Date.parse("2024-04-17T14:15:30+09:00"), monotonicMs: 1 };
    await startHarness(three, "c7-three", now, false);
    await report(three, "37_01_01_240613_VXSE43", now, "VXSE43");
    await report(three, "32-39_11_02_250206_VTSE41", tick(1), "VTSE41");
    await report(three, "32-35_04_04_240613_VXSE53", tick(1));
    const grants = (["U-E", "U-T", "U-Q"] as const).map((unit) => three.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(3);
    release();
    await three.settle();
    expect((["U-E", "U-T", "U-Q"] as const).map((unit) => three.unit(unit).persistence.kind)).toEqual(["saved", "saved", "saved"]);
    expect(three.failures).toEqual([]);
  });
});
