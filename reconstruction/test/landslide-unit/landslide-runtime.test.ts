import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { LandslideUnitState } from "../../contracts/p3-landslide-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toLandslideView } from "../../src/units/landslide/landslide-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { SOYA, areas, clock, decodeXml, emptyState, office, receive, retime } from "./landslide-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-L を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "landslide-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "landslide-diagnostics" } as const;

const SOYA_FILE = "15_16_01_241031_VPWW56", CANCEL = "synthetic_VPWW56_cancel", KAGAWA = "18_00_01_260603_VPWW56_kagawa_release";
const T0 = Date.parse("2020-06-22T23:00:00+09:00");
// 猿払村の引下げ（09→29）の続報。
const LOWERED = SOYA.map((code, index) => ({ code, kind: index === 0 ? "49" : "29" }));
let inputSequence = 0;
function report(h: Harness, xml: string, now: ClockReading, headType = "VPWW56") {
  return submit(h, envelope(h.root.state.runId, headType, `landslide#${++inputSequence}`, Buffer.from(xml), now, inputSequence));
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");

describe("P3-UNIT-L-001 U-L through the composition root", () => {
  // contractBoundary: A7 の群（P3-C10-NOTICE-GROUP=A）。U-L の critical（レベル5）は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C10-T07 contractBoundary / AC08: U-L intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2020-06-22T23:00:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t07", disposition: "pending" });
    // U-L を最も古く作る（同じ群なら先に選ばれる位置）。
    const landslide = notice("U-L", "weather", "critical", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, landslide], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, landslide]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [landslide, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([landslide, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-L:other"]);
  });

  // acceptance: P3-C10-SNAPSHOT=A。domain landslide は active の記録だけを載せ、重大度は WEATHER_SEVERITY、区域は municipality で数え、
  // U-L だけの変化で出し直す。同時最大状態（64 官署・1,772 区域）の domain landslide の byte と full/summary を記録する（AC06）。
  it("P3-C10-T09 acceptance / AC06: the snapshot landslide domain, a U-L-only change, inactive records and the maximum view", async () => {
    const at = (iso: string, monotonicMs: number) => ({ wallTimeMs: Date.parse(iso), monotonicMs });
    const started = await startup(at("2020-06-22T23:00:00+09:00", 1));
    const first = projected(projectSnapshot(projectionInput(started, T0), null));
    let projection = first.state;
    let state = started.state;
    let input = projectionInput(started, T0);
    let isolated: ReturnType<typeof projectSnapshot> | null = null;
    const send = async (xml: string, iso: string, monotonicMs: number) => {
      const next = await step(state, received("run", { headType: "VPWW56", inputId: `landslide#${++inputSequence}`, body: Buffer.from(xml) },
        at(iso, monotonicMs)));
      const nextInput = projectionInput(next, Date.parse(iso));
      // 保存の状態を前の入力のままにした射影（出し直しの原因を U-L の domain だけに切り分ける）。
      isolated = projectSnapshot({ ...nextInput, persistence: input.persistence }, projection);
      const out = projectSnapshot(nextInput, projection);
      state = next.state;
      projection = out.state;
      input = nextInput;
      return out;
    };
    const soya = projected(await send(text(SOYA_FILE), "2020-06-22T23:00:01+09:00", 2)).snapshot;
    expect(soya.sequence).toBe(first.snapshot.sequence + 1);
    // U-L だけが変わった入力は、保存の状態が同じでも出し直す（view-projector の comparable に domain landslide が入る）。
    const alone = projected(isolated!).snapshot;
    expect(alone.persistence).toEqual(first.snapshot.persistence);
    expect({ ...alone.current, landslide: null }).toEqual({ ...first.snapshot.current, landslide: null });
    expect(alone.current.landslide).not.toEqual(first.snapshot.current.landslide);
    expect(soya.current.landslide.items[0]).toMatchObject({ informationType: "landslide", activeCount: 1, highestSeverity: "danger",
      areaCounts: { municipality: 10 }, unknownCode: {}, updatedAt: T0 });
    // 記録の無い官署への解除（ended）は view・snapshot に載らない（出し直しは保存の状態の変化だけ）。
    expect(projected(await send(retime("2020-06-22T23:05:00+09:00")(text(KAGAWA)), "2020-06-22T23:05:01+09:00", 3)).snapshot.current.landslide)
      .toEqual(soya.current.landslide);
    // 表に無い code は unknownCode の unknown に数える。
    const unknown = projected(await send(retime("2020-06-22T23:10:00+09:00")(areas(SOYA.map((code, index) => ({ code,
      kind: index === 0 ? "49" : index === 1 ? "59" : "29" })))(text(SOYA_FILE))), "2020-06-22T23:10:01+09:00", 4)).snapshot;
    expect(unknown.current.landslide.items[0]).toMatchObject({ activeCount: 1, highestSeverity: "danger", areaCounts: { municipality: 10 },
      unknownCode: { unknown: 1 } });
    // 全区域の解除で active の記録が無くなり、view から消える（ended を「警報なし」と別の記録として載せない）。
    const ended = projected(await send(retime("2020-06-22T23:20:00+09:00")(areas(SOYA.map((code) => ({ code, status: "解除" })))(text(SOYA_FILE))),
      "2020-06-22T23:20:01+09:00", 5)).snapshot;
    expect(ended.current.landslide.delivery === "full" && ended.current.landslide.view.currents).toEqual([]);
    expect(ended.current.landslide.items.every((item) => item.activeCount === 0)).toBe(true);
    expect(projection.snapshot!.recovery["U-L"]).toEqual({ kind: "empty" });

    // 同時最大状態: 全国の市町村等 1,772 区域を 64 官署に 15_16_01 の形（49×1・09×1・29×残り）で配る。
    const changes: RuntimeDisplayChange[] = [];
    let max: LandslideUnitState = emptyState();
    let code = 0;
    for (let index = 0; index < 64; index++) {
      const count = index < 44 ? 28 : 27;
      const items = Array.from({ length: count }, (_, at) => ({ code: String(1_000_000 + code++), kind: at === 0 ? "49" : at === 1 ? "09" : "29",
        area: "市町村名".repeat(3) }));
      const result = receive(max, decodeXml(office(`官署${String(index).padStart(2, "0")}地方気象台`)(areas(items)(text(SOYA_FILE)))), clock(T0));
      changes.push(...result.displayChanges);
      max = result.state;
    }
    const view = toLandslideView(max);
    const viewBytes = Buffer.byteLength(JSON.stringify(view));
    const big = projected(projectSnapshot(projectionInput(started, T0, { landslide: view, displayChanges: changes }), first.state));
    console.info("P3-C10 maximum view", JSON.stringify({ offices: view.currents.length, viewBytes,
      domainBytes: big.state.domains.landslide.utf8Bytes, domainBudget: 65_536, snapshotBytes: big.utf8Bytes,
      delivery: big.snapshot.current.landslide.delivery }));
    expect(big.snapshot.current.landslide.items[0]).toMatchObject({ activeCount: 64, highestSeverity: "danger", areaCounts: { municipality: 1_772 } });
    expect(big.snapshot.current.landslide.delivery).toBe("full");
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、deferred の U-F と U-L の同時 dirty（AC10）。
  it("P3-C10-T09 acceptance / AC10: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-L"].view;
      if (value.unit !== "U-L") throw new Error("mirror view of another unit");
      return value;
    };
    const lowered = retime("2020-06-22T23:00:30+09:00")(areas(LOWERED)(text(SOYA_FILE)));

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c10-failed", now);
    await report(failed, text(SOYA_FILE), now);
    expect(failed.unit("U-L").persistence.kind).toBe("failed");
    const issued = failed.unit("U-L").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-L").persistence.currentGeneration;
    await report(failed, text(CANCEL), tick(1_000));
    const afterCancel = failed.unit("U-L");
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
    await startHarness(acking, "c10-ack", now, false);
    await report(acking, text(SOYA_FILE), now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c10-ack", "VPWW56", `follow#${++inputSequence}`, Buffer.from(lowered), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    // deferred は自分の保存中の入力を最長 1,000 ms 留保し、満了で送る（P3-UWR-AC04・P3-UWR-HOLD-LIMIT=A）。
    const sentAt = tick(1_000);
    acking.root.tick(sentAt);
    await acking.settle();
    expect(acking.owners.get("deferred")!["state"]!.checkpointAttempts["U-L"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: sentAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-L").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: sentAt.monotonicMs });
    expect(view(acking).currents[0].source.reportDateTimeRaw).toBe("2020-06-22T23:00:30+09:00");

    // 通常終了と復元直後の続報: 復元した記録との差で決め、同じ報を再び鳴らさない。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(first, "c10-run1", now, false);
    await report(first, text(SOYA_FILE), now);
    const pendingBefore = first.unit("U-L").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-L"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    const second = wired(files);
    await startHarness(second, "c10-run2", tick(1), false);
    expect(second.root.state.restoration["U-L"]).toEqual({ kind: "restored" });
    expect(view(second).currents.map((item) => [item.subject, item.effective])).toEqual([["normal/VPWW56/稚内地方気象台", "active"]]);
    expect(second.unit("U-L").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-L").intents.map((item) => item.id));
    await report(second, text(SOYA_FILE), tick(1_000));
    expect(second.unit("U-L").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, lowered, tick(1_000));
    expect(second.unit("U-L").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition]))
      .toEqual([["normal", "updated"], ["normal", "updated"]]);
    expect(second.failures).toEqual([]);

    // U-F と U-L の同時 dirty: deferred の 2 unit は別々の書込み権を持つ（P3-C10-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const two = wired(parked);
    now = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    await startHarness(two, "c10-two", now, false);
    await report(two, Buffer.from(unitBodies["U-F"].body).toString("utf8"), now, "VPWP50");
    await report(two, retime("2026-06-05T17:00:00+09:00")(text(SOYA_FILE)), tick(1));
    // U-L の入力は同じ deferred の U-F の保存中は留保され、1,000 ms で送られる（P3-UWR-AC04）。U-F の書込みは止めたまま。
    two.root.tick(tick(1_000));
    await two.settle();
    const grants = (["U-F", "U-L"] as const).map((unit) => two.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(2);
    release();
    await two.settle();
    expect((["U-F", "U-L"] as const).map((unit) => two.unit(unit).persistence.kind)).toEqual(["saved", "saved"]);
    expect(two.failures).toEqual([]);
  });
});
