import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { FloodUnitState } from "../../contracts/p3-flood-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toFloodView } from "../../src/units/flood/flood-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, decodeXml, emptyState, eventId, receive, retime, rivers, stationsXml } from "./flood-fixture";
import type { StationSpec } from "./flood-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-R を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "flood-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "flood-diagnostics" } as const;

const SAMPLE = "16_02_01_220728_VXKO50", CANCEL = "synthetic_VXKO50_cancel", KOZAGAWA = "16_00_01_260603_VXKO70_kozagawa_l5";
const T0 = Date.parse("2019-05-27T09:00:00+09:00");
const SAMPLE_RIVERS = [{ code: "1234567890", name: "○○川" }, { code: "9876543210", name: "△△川" }];
// 河川の段階の引下げ（30→21）の続報。
const lower = (xml: string) => rivers([{ code: "21", rivers: SAMPLE_RIVERS }])(xml);
let inputSequence = 0;
function report(h: Harness, xml: string, now: ClockReading, headType = "VXKO50") {
  return submit(h, envelope(h.root.state.runId, headType, `flood#${++inputSequence}`, Buffer.from(xml), now, inputSequence));
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");

describe("P3-UNIT-R-001 U-R through the composition root", () => {
  // contractBoundary: A7 の群（P3-C11-NOTICE-GROUP=A）。U-R の critical（レベル5）は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C11-T07 contractBoundary / AC08: U-R intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2019-05-27T09:00:00+09:00", serialRaw: "1", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t07", disposition: "pending" });
    // U-R を最も古く作る（同じ群なら先に選ばれる位置）。
    const flood = notice("U-R", "weather", "critical", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, flood], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, flood]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [flood, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([flood, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-R:other"]);
  });

  // acceptance: P3-C11-SNAPSHOT=A。domain flood は active の記録だけを載せ、重大度は河川の level（null と kinds 空は unknown）、
  // U-R だけの変化で出し直す。実配信の最大の日に近い状態と 512 subject の状態の domain flood の byte と full/summary を記録する（AC06）。
  it("P3-C11-T09 acceptance / AC06: the snapshot flood domain, a U-R-only change, inactive records and the maximum views", async () => {
    const at = (iso: string, monotonicMs: number) => ({ wallTimeMs: Date.parse(iso), monotonicMs });
    const started = await startup(at("2019-05-27T09:00:00+09:00", 1));
    const first = projected(projectSnapshot(projectionInput(started, T0), null));
    let projection = first.state;
    let state = started.state;
    let input = projectionInput(started, T0);
    let isolated: ReturnType<typeof projectSnapshot> | null = null;
    const send = async (xml: string, iso: string, monotonicMs: number) => {
      const next = await step(state, received("run", { headType: "VXKO50", inputId: `flood#${++inputSequence}`, body: Buffer.from(xml) },
        at(iso, monotonicMs)));
      const nextInput = projectionInput(next, Date.parse(iso));
      // 保存の状態を前の入力のままにした射影（出し直しの原因を U-R の domain だけに切り分ける）。
      isolated = projectSnapshot({ ...nextInput, persistence: input.persistence }, projection);
      const out = projectSnapshot(nextInput, projection);
      state = next.state;
      projection = out.state;
      input = nextInput;
      return out;
    };
    const sample = projected(await send(text(SAMPLE), "2019-05-27T09:00:01+09:00", 2)).snapshot;
    expect(sample.sequence).toBe(first.snapshot.sequence + 1);
    // U-R だけが変わった入力は、保存の状態が同じでも出し直す（view-projector の comparable に domain flood が入る）。
    const alone = projected(isolated!).snapshot;
    expect(alone.persistence).toEqual(first.snapshot.persistence);
    expect({ ...alone.current, flood: null }).toEqual({ ...first.snapshot.current, flood: null });
    expect(alone.current.flood).not.toEqual(first.snapshot.current.flood);
    expect(sample.current.flood.items[0]).toMatchObject({ informationType: "flood", activeCount: 1, highestSeverity: "warning", areaCounts: {},
      unknownCode: {}, updatedAt: T0 });
    // 記録の無い subject への解除（ended）は view・snapshot に載らない。
    expect(projected(await send(eventId("123456789099")(retime("2019-05-27T09:05:00+09:00")(rivers([{ code: "10", rivers: SAMPLE_RIVERS }])(text(SAMPLE)))),
      "2019-05-27T09:05:01+09:00", 3)).snapshot.current.flood).toEqual(sample.current.flood);
    // 表に無い code は unknownCode の unknown に数え、highestSeverity は河川の level から引く。
    const unknown = projected(await send(retime("2019-05-27T09:10:00+09:00")(rivers([{ code: "40", rivers: [SAMPLE_RIVERS[0]] },
      { code: "59", rivers: [SAMPLE_RIVERS[1]] }])(text(SAMPLE))), "2019-05-27T09:10:01+09:00", 4)).snapshot;
    expect(unknown.current.flood.items[0]).toMatchObject({ activeCount: 1, highestSeverity: "danger", unknownCode: { unknown: 1 } });
    // 全河川の解除で active の記録が無くなり、view から消える（ended を「洪水予報なし」と別の記録として載せない）。
    const ended = projected(await send(retime("2019-05-27T09:20:00+09:00")(rivers([{ code: "10", rivers: SAMPLE_RIVERS }])(text(SAMPLE))),
      "2019-05-27T09:20:01+09:00", 5)).snapshot;
    expect(ended.current.flood.delivery === "full" && ended.current.flood.view.currents).toEqual([]);
    expect(ended.current.flood.items.every((item) => item.activeCount === 0)).toBe(true);
    expect(projection.snapshot!.recovery["U-R"]).toEqual({ kind: "empty" });

    // 実配信の最大の日に近い状態（10 EventID、実配信の古座川の記録の形）と、512 subject を実配信の最大の記録の形（観測所 10・点 22・
    // 河川 7）で満たした状態。domain flood の byte を分野の予算 65,536 と、snapshot 全体の byte を 1 MiB と比べて記録する。
    const measure = (count: number, xml: (index: number) => string, headType: string) => {
      const changes: RuntimeDisplayChange[] = [];
      let value: FloodUnitState = emptyState();
      for (let index = 0; index < count; index++) {
        const result = receive(value, decodeXml(xml(index), headType), clock(Date.parse("2026-06-03T06:00:00+09:00")));
        changes.push(...result.displayChanges);
        value = result.state;
      }
      const view = toFloodView(value);
      const big = projected(projectSnapshot(projectionInput(started, T0, { flood: view, displayChanges: changes }), first.state));
      return { subjects: view.currents.length, recordBytes: value.currents.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0),
        viewBytes: Buffer.byteLength(JSON.stringify(view)), domainBytes: big.state.domains.flood.utf8Bytes, domainBudget: 65_536,
        domainOverBudget: big.state.domains.flood.utf8Bytes > 65_536, snapshotBytes: big.utf8Bytes, snapshotLimit: 1_048_576,
        delivery: big.snapshot.current.flood.delivery, activeCount: big.snapshot.current.flood.items[0]?.activeCount ?? 0 };
    };
    const day = measure(10, (index) => eventId(`3000130001${String(index).padStart(2, "0")}`)(text(KOZAGAWA)), "VXKO70");
    const realRivers = Array.from({ length: 7 }, (_, index) => ({ code: String(2_700_000_000 + index), name: `河川${index}` }));
    const realStations = Array.from({ length: 10 }, (_, index): StationSpec => ({ code: `27${String(index).padStart(15, "0")}`,
      name: `観測所名${index}`, values: Array.from({ length: 22 }, (_, point) => (10 + point / 100).toFixed(2)),
      levels: Array.from({ length: 22 }, () => "3"), sections: [realRivers[index % 7].name] }));
    const largest = (index: number) => eventId(`27000000${String(index).padStart(4, "0")}`)(retime("2026-06-03T05:50:00+09:00")(
      stationsXml(22, realStations)(rivers([{ code: "40", rivers: realRivers }])(text(SAMPLE)))));
    const full = measure(512, largest, "VXKO73");
    // summary に落ちる閾値（分野の予算 65,536 を超える EventID の数）は実配信の日の記録 1 件あたりの domain の byte で割った数。
    console.info("P3-C11 maximum views", JSON.stringify({ day, full, perSubjectDomainBytes: Math.round(day.domainBytes / day.subjects),
      subjectsOverDomainBudget: Math.floor(65_536 / (day.domainBytes / day.subjects)) + 1 }));
    expect([day.activeCount, full.activeCount]).toEqual([10, 512]);
    expect(day.delivery).toBe("full");
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、deferred の U-F・U-L・U-R の同時 dirty（AC10）。
  it("P3-C11-T09 acceptance / AC10: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-R"].view;
      if (value.unit !== "U-R") throw new Error("mirror view of another unit");
      return value;
    };
    const lowered = retime("2019-05-27T09:00:30+09:00")(lower(text(SAMPLE)));

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c11-failed", now);
    await report(failed, text(SAMPLE), now);
    expect(failed.unit("U-R").persistence.kind).toBe("failed");
    const issued = failed.unit("U-R").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-R").persistence.currentGeneration;
    await report(failed, retime("2019-05-27T09:00:10+09:00")(text(CANCEL)), tick(1_000));
    const afterCancel = failed.unit("U-R");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).currents).toEqual([]);
    expect(afterCancel.currents.map((item) => item.effective)).toEqual(["cancelled"]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(acking, "c11-ack", now, false);
    await report(acking, text(SAMPLE), now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c11-ack", "VXKO50", `follow#${++inputSequence}`, Buffer.from(lowered), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    // deferred は自分の保存中の入力を最長 1,000 ms 留保し、満了で送る（P3-UWR-AC04・P3-UWR-HOLD-LIMIT=A）。
    const sentAt = tick(1_000);
    acking.root.tick(sentAt);
    await acking.settle();
    expect(acking.owners.get("deferred")!["state"]!.checkpointAttempts["U-R"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: sentAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-R").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: sentAt.monotonicMs });
    expect(view(acking).currents[0].source.reportDateTimeRaw).toBe("2019-05-27T09:00:30+09:00");

    // 通常終了と復元直後の続報: 復元した記録との差で決め、同じ報を再び鳴らさない。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(first, "c11-run1", now, false);
    await report(first, text(SAMPLE), now);
    const pendingBefore = first.unit("U-R").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-R"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    const second = wired(files);
    await startHarness(second, "c11-run2", tick(1), false);
    expect(second.root.state.restoration["U-R"]).toEqual({ kind: "restored" });
    expect(view(second).currents.map((item) => [item.subject, item.effective])).toEqual([["normal/VXKO50/123456789012", "active"]]);
    expect(second.unit("U-R").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-R").intents.map((item) => item.id));
    await report(second, text(SAMPLE), tick(1_000));
    expect(second.unit("U-R").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, lowered, tick(1_000));
    expect(second.unit("U-R").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition]))
      .toEqual([["normal", "updated"], ["normal", "updated"]]);
    expect(second.failures).toEqual([]);

    // U-F・U-L・U-R の同時 dirty: deferred の 3 unit は別々の書込み権を持つ（P3-C11-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const three = wired(parked);
    now = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    await startHarness(three, "c11-three", now, false);
    await report(three, Buffer.from(unitBodies["U-F"].body).toString("utf8"), now, "VPWP50");
    await report(three, retime("2026-06-05T17:00:00+09:00")(Buffer.from(unitBodies["U-L"].body).toString("utf8")), tick(1), "VPWW56");
    await report(three, retime("2026-06-05T17:00:00+09:00")(text(SAMPLE)), tick(1));
    // U-L・U-R の入力は同じ deferred の保存中は留保され、1,000 ms で送られる（P3-UWR-AC04）。書込みは止めたまま。
    for (let round = 0; round < 3; round++) {
      three.root.tick(tick(1_000));
      await three.settle();
    }
    const grants = (["U-F", "U-L", "U-R"] as const).map((unit) => three.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(3);
    release();
    await three.settle();
    expect((["U-F", "U-L", "U-R"] as const).map((unit) => three.unit(unit).persistence.kind)).toEqual(["saved", "saved", "saved"]);
    expect(three.failures).toEqual([]);
  });
});
