import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { VolcanoUnitState } from "../../contracts/p3-volcano-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toVolcanoView } from "../../src/units/volcano/volcano-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { decode, projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime } from "./volcano-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-V を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "volcano-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "volcano-diagnostics" } as const;

const ALERT = "45_01_01_200522_VFVO50", CONTINUATION = "synthetic_VFVO50_continuation", CANCEL = "synthetic_VFVO50_cancel";
const SCHEDULED = "66_01_01_210517_VFVO53", BULLETIN = "44_02_01_200522_VFVO51";
let inputSequence = 0;
function report(h: Harness, file: string, now: ClockReading, headType = "VFVO50") {
  return submit(h, envelope(h.root.state.runId, headType, `${file.split("/").at(-1)}#${++inputSequence}`,
    readFileSync(`test/fixtures/${file}.xml`), now, inputSequence));
}

describe("P3-UNIT-V-001 U-V through the composition root", () => {
  // contractBoundary: A7 の群（P3-C9-NOTICE-GROUP=A）。U-V の critical（噴火速報）は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C9-T08 contractBoundary / AC10: U-V intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2014-09-27T12:00:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t08", disposition: "pending" });
    // U-V を最も古く作る（同じ群なら先に選ばれる位置）。
    const volcano = notice("U-V", "volcano", "critical", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, volcano], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, volcano]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [volcano, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([volcano, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-V:other"]);
  });

  // acceptance: P3-C9-SNAPSHOT=A。domain volcano は active の警報・噴火・降灰で数え、重大度と区域を持たず、U-V だけの変化で出し直す。
  // 解説は見出しだけ。実例の大きさの三 slice 各 128 件と解説 64 件の view でも snapshot は 1 MiB の内側（上限の文字列の合法最大は
  // 約 3.4 MB で summary に落ちる、P3-C9-SNAPSHOT=A の reason）。
  it("P3-C9-T10 acceptance / AC08: the snapshot volcano domain, a U-V-only change and a full view", async () => {
    const at = (iso: string, monotonicMs: number) => ({ wallTimeMs: Date.parse(iso), monotonicMs });
    const started = await startup(at("2020-05-22T13:03:00+09:00", 1));
    const first = projected(projectSnapshot(projectionInput(started, Date.parse("2020-05-22T13:03:00+09:00")), null));
    let projection = first.state;
    let state = started.state;
    const send = async (file: string, headType: string, iso: string, monotonicMs: number, transform?: (xml: string) => string) => {
      const next = await step(state, received("run", decode(file, headType, transform, `${file}#${++inputSequence}`), at(iso, monotonicMs)));
      const out = projected(projectSnapshot(projectionInput(next, Date.parse(iso)), projection));
      state = next.state;
      projection = out.state;
      return out.snapshot;
    };
    const alert = await send(ALERT, "VFVO50", "2020-05-22T13:03:01+09:00", 2);
    expect(alert.sequence).toBe(first.snapshot.sequence + 1);
    expect(alert.current.volcano.items[0]).toMatchObject({ informationType: "volcano", activeCount: 1, highestSeverity: null, areaCounts: {},
      updatedAt: Date.parse("2020-05-22T13:03:00+09:00") });
    // VFSV の更新は source より新しい marineSource で updatedAt を進める（品質レビュー P2、unit の latestSource と同じ）。
    const marine = await send("46_01_01_170103_VFSVii", "VFSV50", "2020-05-22T13:10:01+09:00", 3, (xml) =>
      retime("2020-05-22T13:10:00+09:00")(xml).replaceAll(">506<", ">306<"));
    expect(marine.current.volcano.items[0]).toMatchObject({ activeCount: 1, updatedAt: Date.parse("2020-05-22T13:10:00+09:00") });
    // 解説は見出しだけで数えない（増えた 1 件は草津白根山の entry の警報）。定時の降灰は載らない。
    const bulletin = await send(BULLETIN, "VFVO51", "2020-05-22T13:56:01+09:00", 4);
    expect(bulletin.current.volcano.items[0]).toMatchObject({ activeCount: 2 });
    expect(bulletin.current.volcano.delivery === "full" && bulletin.current.volcano.view.bulletins.map((item) => [item.title, "text" in item]))
      .toEqual([["火山名  草津白根山（白根山（湯釜付近））  火山の状況に関する解説情報", false]]);
    const scheduled = await send(SCHEDULED, "VFVO53", "2020-05-22T13:57:01+09:00", 5);
    expect(scheduled.current.volcano).toEqual(bulletin.current.volcano);
    // 取消で浅間山の警報が載らなくなる（草津白根山は残る）。復元は U-V の行で別に載る（空・unavailable を「警報なし」に読み替えない材料）。
    const cancelled = await send(CANCEL, "VFVO50", "2020-05-22T14:55:01+09:00", 6);
    expect(cancelled.current.volcano.items[0]).toMatchObject({ activeCount: 1 });
    expect(projection.snapshot!.recovery["U-V"]).toEqual({ kind: "empty" });

    // 三 slice 各 128 件（3 区分）と解説 64 件。
    const changes: RuntimeDisplayChange[] = [];
    let max: VolcanoUnitState = emptyState();
    const now = Date.parse("2020-05-22T15:00:00+09:00");
    const add = (name: string, headType: string, transform: (xml: string) => string) => {
      const result = receive(max, decodeXml(transform(fixtureXml(name)), headType), clock(now));
      changes.push(...result.displayChanges);
      max = result.state;
    };
    const status = (index: number) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${["通常", "訓練", "試験"][index % 3]}</Status>`);
    for (let index = 0; index < 128; index++) {
      const code = `V${index}`;
      add(ALERT, "VFVO50", (xml) => status(index)(retime("2020-05-22T15:00:00+09:00")(replaceTag("EventID", code)(xml)).replaceAll("<Code>306</Code>",
        `<Code>${code}</Code>`)));
      add("43_01_01_200522_VFVO52", "VFVO52", (xml) => status(index)(retime("2020-05-22T15:00:00+09:00")(replaceTag("EventID", `E${index}`)(xml))));
      add("66_01_02_210514_VFVO54", "VFVO54", (xml) => status(index)(xml.replaceAll("<Code>506</Code>", `<Code>${code}</Code>`)));
    }
    for (let index = 0; index < 64; index++) add(BULLETIN, "VFVO51", (xml) => replaceTag("EventID", `B${index}`)(xml)
      .replace(/<Information type="[^"]*対象火山[^"]*">[\s\S]*?<\/Information>/, ""));
    expect([max.alerts.length, max.eruptions.length, max.ashfalls.length, max.bulletins.length]).toEqual([128, 128, 128, 64]);
    const view = toVolcanoView(max);
    const viewBytes = Buffer.byteLength(JSON.stringify(view));
    const big = projected(projectSnapshot(projectionInput(started, now, { volcano: view, displayChanges: changes }), first.state));
    console.info("P3-C9 maximum view", JSON.stringify({ viewBytes, snapshotBytes: big.utf8Bytes, delivery: big.snapshot.current.volcano.delivery }));
    expect(big.utf8Bytes).toBeLessThanOrEqual(1_048_576);
    expect(big.snapshot.current.volcano.delivery).toBe("full");
    expect(big.snapshot.current.volcano.items.map((item) => item.activeCount)).toEqual([129, 129, 126]);
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了（batch の無音 flush）・復元直後の続報、urgent の 5 unit の同時 dirty（AC12）。
  it("P3-C9-T10 acceptance / AC12: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: Date.parse("2020-05-22T13:03:00+09:00") + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-V"].view;
      if (value.unit !== "U-V") throw new Error("mirror view of another unit");
      return value;
    };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c9-failed", now);
    await report(failed, ALERT, now);
    expect(failed.unit("U-V").persistence.kind).toBe("failed");
    const issued = failed.unit("U-V").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-V").persistence.currentGeneration;
    await report(failed, CANCEL, tick(1_000));
    const afterCancel = failed.unit("U-V");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).alerts).toEqual([]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: Date.parse("2020-05-22T13:03:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(acking, "c9-ack", now, false);
    await report(acking, ALERT, now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c9-ack", "VFVO50", `follow#${++inputSequence}`,
      readFileSync(`test/fixtures/${CONTINUATION}.xml`), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    expect(acking.owners.get("urgent")!["state"]!.checkpointAttempts["U-V"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: followAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-V").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: followAt.monotonicMs });
    expect(view(acking).alerts[0].source?.reportDateTimeRaw).toBe("2020-05-22T14:54:00+09:00");

    // 通常終了（待機中の VFVO53 の batch は無音で flush する）と復元直後の続報: 復元した警報との差で決め、同じ報を再び鳴らさない。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: Date.parse("2020-05-22T13:03:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(first, "c9-run1", now, false);
    await report(first, ALERT, now);
    await report(first, SCHEDULED, tick(1), "VFVO53");
    expect(first.unit("U-V").batch?.subjects).toEqual(["normal/VFVO53/506"]);
    const pendingBefore = first.unit("U-V").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-V"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    expect(first.unit("U-V").intents.some((item) => item.subject.endsWith("/VFVO53/batch"))).toBe(false);
    const second = wired(files);
    await startHarness(second, "c9-run2", tick(1), false);
    expect(second.root.state.restoration["U-V"]).toEqual({ kind: "restored" });
    expect(view(second).alerts.map((item) => [item.subject, item.level])).toEqual([["normal/volcano:alert/306", 3]]);
    expect([second.unit("U-V").batch, second.unit("U-V").scheduledAshfalls, view(second).bulletins]).toEqual([null, [], []]);
    expect(second.unit("U-V").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-V").intents.map((item) => item.id));
    await report(second, ALERT, tick(1_000));
    expect(second.unit("U-V").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, CONTINUATION, tick(1_000));
    expect(second.unit("U-V").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition]))
      .toEqual([["info", "updated"], ["info", "updated"]]);
    expect(second.failures).toEqual([]);

    // U-E・U-T・U-Q・U-N・U-V の同時 dirty: urgent の 5 unit は別々の書込み権を持つ（P3-C9-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const five = wired(parked);
    now = { wallTimeMs: Date.parse("2024-04-17T14:15:30+09:00"), monotonicMs: 1 };
    await startHarness(five, "c9-five", now, false);
    await report(five, "37_01_01_240613_VXSE43", now, "VXSE43");
    await report(five, "32-39_11_02_250206_VTSE41", tick(1), "VTSE41");
    await report(five, "32-35_04_04_240613_VXSE53", tick(1), "VXSE53");
    await report(five, "selected_xml/80_01_01_240821_VYSE60", tick(1), "VYSE60");
    await report(five, ALERT, tick(1));
    const grants = (["U-E", "U-T", "U-Q", "U-N", "U-V"] as const).map((unit) => five.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save", "save", "save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(5);
    release();
    await five.settle();
    expect((["U-E", "U-T", "U-Q", "U-N", "U-V"] as const).map((unit) => five.unit(unit).persistence.kind)).toEqual(Array(5).fill("saved"));
    expect(five.failures).toEqual([]);
  });
});
