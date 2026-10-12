import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { LocalBulletinsUnitState } from "../../contracts/p3-local-bulletins-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, compose, decodeFixture, emptyState, eventId, fixtureXml, headTitle, iso, office, receive, replaceTag, retime, send, serial } from "./local-bulletins-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-M を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "local-bulletins-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "local-bulletins-diagnostics" } as const;

const N50 = "19_03_01_130906_VPHW50", T51 = "19_04_01_140425_VPHW51", HEAT = "57_03_01_240401_VPFT50", FJ = "85_01_01_250630_VPFJ51";
const T0 = Date.parse("2013-07-26T09:20:00+09:00");
const NAGASAKI = "normal/tornado/長崎地方気象台/長崎県竜巻注意情報";
let inputSequence = 0;
function report(h: Harness, xml: string, now: ClockReading, headType = "VPHW50") {
  return submit(h, envelope(h.root.state.runId, headType, `local-bulletins#${++inputSequence}`, Buffer.from(xml), now, inputSequence));
}
const xmlOf = (name: string, ...transforms: readonly ((xml: string) => string)[]) => compose(...transforms)(fixtureXml(name));
const cancelNagasaki = (at: string) => xmlOf("synthetic_VPHW50_tokyo_cancel", office("長崎地方気象台"), headTitle("長崎県竜巻注意情報"), retime(at), serial("2"));
const view = (h: Harness) => {
  const value = h.root.state.mirror["U-M"].view;
  if (value.unit !== "U-M") throw new Error("mirror view of another unit");
  return value;
};

describe("P3-UNIT-M-001 U-M through the composition root", () => {
  // contractBoundary: A7 の群（P3-C13-NOTICE-GROUP=A）。U-M は other（VZSE40 を含む）で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C13-T09 contractBoundary / AC09: U-M intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2026-08-22T17:09:00+09:00", serialRaw: "1", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t09", disposition: "pending" });
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const tsunami = notice("U-T", "tsunami", "critical", 0), eew = notice("U-E", "earthquake-eew", "warning", 5);
    // 実際の U-M の intent（竜巻 warning＝weather、VZSE40＝earthquake-eew の info）。最も古く作る（同じ群なら先に選ばれる位置）。
    const real = [send(emptyState(), N50).intents[0], send(emptyState(), "selected_xml/42_01_01_100514_VZSE40").intents[0]]
      .map((item, index): NotificationIntent => ({ ...item, id: `U-M:${index}`, createdAt: -10 - index, expiresAt: 180_000, nextAttemptAt: -10 - index }));
    expect(real.map((item) => item.payload.domain)).toEqual(["weather", "earthquake-eew"]);
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    for (const intent of real) {
      const trial: NotificationDeliveryState = { intents: [tsunami, intent], channels: { desktop: { kind: "running", attempt: running },
        sound: { kind: "idle" } }, deadlines: deadlines([tsunami, intent]) };
      expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
      let state: NotificationDeliveryState = { intents: [intent, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
        deadlines: deadlines([intent, tsunami, eew]) };
      const order: string[] = [];
      for (let round = 0; round < 3; round++) {
        const selection = selectNotificationAttempt(state, now);
        const [attempt] = selection.attempts;
        order.push(`${attempt.unit}:${attempt.priorityGroup}`);
        state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
          channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
      }
      expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-M:other"]);
    }
  });

  // acceptance: P3-C13-SNAPSHOT=A。domain localBulletins は view に載る記録だけを数え、重大度は竜巻の sighted が specialWarning・ほかの竜巻と熱中症が
  // warning・transient は数えない。U-M だけが変わった入力で出し直す。竜巻 128・熱中症 256 の状態の byte を分野の予算と snapshot 全体で分けて記録する（AC07）。
  it("P3-C13-T11 acceptance / AC07,AC11: the snapshot localBulletins domain and the maximum views", async () => {
    const at = (wallTimeMs: number, monotonicMs: number) => ({ wallTimeMs, monotonicMs });
    const started = await startup(at(T0, 1));
    const first = projected(projectSnapshot(projectionInput(started, T0), null));
    let projection = first.state;
    let state = started.state;
    let input = projectionInput(started, T0);
    let isolated: ReturnType<typeof projectSnapshot> | null = null;
    const sendTo = async (xml: string, headType: string, wallTimeMs: number, monotonicMs: number) => {
      const next = await step(state, received("run", { headType, inputId: `local-bulletins#${++inputSequence}`, body: Buffer.from(xml) }, at(wallTimeMs, monotonicMs)));
      const nextInput = projectionInput(next, wallTimeMs);
      // 保存の状態を前の入力のままにした射影（出し直しの原因を U-M の domain だけに切り分ける）。
      isolated = projectSnapshot({ ...nextInput, persistence: input.persistence }, projection);
      const out = projectSnapshot(nextInput, projection);
      state = next.state;
      projection = out.state;
      input = nextInput;
      return out;
    };
    const record = projected(await sendTo(xmlOf(N50), "VPHW50", T0 + 1, 2)).snapshot;
    expect(record.sequence).toBe(first.snapshot.sequence + 1);
    const alone = projected(isolated!).snapshot;
    expect({ ...alone.current, localBulletins: null }).toEqual({ ...first.snapshot.current, localBulletins: null });
    expect(alone.current.localBulletins).not.toEqual(first.snapshot.current.localBulletins);
    expect(record.current.localBulletins.items[0]).toMatchObject({ informationType: "local-bulletins", activeCount: 1, highestSeverity: "warning", areaCounts: {}, unknownCode: {} });
    expect(projection.snapshot!.recovery["U-M"]).toEqual({ kind: "empty" });
    // 目撃は specialWarning、熱中症は warning、解説（transient）は数えるが重大度は付けない。取消で view から消える。
    const sighted = projected(await sendTo(xmlOf(T51, retime("2013-07-26T09:21:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T10:30:00+09:00")), "VPHW51", T0 + 61_000, 3)).snapshot;
    expect(sighted.current.localBulletins.items[0]).toMatchObject({ activeCount: 2, highestSeverity: "specialWarning" });
    const heatShown = projected(await sendTo(xmlOf(HEAT, retime("2013-07-26T09:22:00+09:00"), replaceTag("TargetDateTime", "2013-07-26T09:22:00+09:00")), "VPFT50", T0 + 121_000, 4)).snapshot;
    expect(heatShown.current.localBulletins.items[0]).toMatchObject({ activeCount: 3 });
    const explanation = projected(await sendTo(xmlOf(FJ, retime("2013-07-26T09:23:00+09:00")), "VPFJ51", T0 + 181_000, 5)).snapshot;
    expect(explanation.current.localBulletins.items[0]).toMatchObject({ activeCount: 4 });
    const cancelled = projected(await sendTo(cancelNagasaki("2013-07-26T09:25:00+09:00"), "VPHW50", T0 + 301_000, 6)).snapshot;
    expect(cancelled.current.localBulletins.delivery === "full" && cancelled.current.localBulletins.view.tornado.map((item) => item.subject).includes(NAGASAKI)).toBe(false);

    // 実配信の最大の状態: 竜巻 128 subject（実配信の形の報、区域 61）と熱中症 256 subject。domain の byte と分野の予算 65,536、snapshot 全体の byte と 1 MiB を分けて記録する。
    type Spec = readonly [name: string, count: number, make: (index: number) => (xml: string) => string];
    const measure = (...specs: readonly Spec[]) => {
      const changes: RuntimeDisplayChange[] = [];
      let value: LocalBulletinsUnitState = emptyState();
      for (const [name, count, make] of specs)
        for (let index = 0; index < count; index++) {
          const material = decodeFixture(name, make(index));
          const result = receive(value, material, clock(Date.parse(material.reportDateTimeRaw)));
          changes.push(...result.displayChanges);
          value = result.state;
        }
      const shown = toLocalBulletinsView(value);
      const big = projected(projectSnapshot(projectionInput(started, T0, { localBulletins: shown, displayChanges: changes }), first.state));
      return { subjects: shown.tornado.length + shown.heat.length + shown.transient.length, recordBytes: [...value.tornado, ...value.heat].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0),
        viewBytes: Buffer.byteLength(JSON.stringify(shown)), domainBytes: big.state.domains.localBulletins.utf8Bytes, domainBudget: 65_536,
        domainOverBudget: big.state.domains.localBulletins.utf8Bytes > 65_536, snapshotBytes: big.utf8Bytes, snapshotLimit: 1_048_576,
        delivery: big.snapshot.current.localBulletins.delivery, activeCount: big.snapshot.current.localBulletins.items[0]?.activeCount ?? 0 };
    };
    const tornadoSpec: Spec = [T51, 128, (index) => compose(headTitle(`第${String(index).padStart(3, "0")}府県竜巻注意情報`), retime(iso(ms("2014-02-12T13:19:00+09:00") + index * 1000)),
      replaceTag("ValidDateTime", "2014-02-12T23:00:00+09:00"))];
    const heatSpec: Spec = [HEAT, 256, (index) => compose(eventId(`JPTC24${String(index).padStart(4, "0")}`), retime(iso(ms("2024-08-11T05:00:00+09:00") + index * 1000)))];
    const tornado128 = measure(tornadoSpec), heat256 = measure(heatSpec);
    // 竜巻 128＋熱中症 256 を同時に持つ最大の状態（二つの時代の報を一つの state に載せる試験用の組み合わせで、時計は報ごと）。
    const combined = measure(tornadoSpec, heatSpec);
    console.info("P3-C13 maximum views", JSON.stringify({ tornado128, heat256, combined, perTornadoDomainBytes: Math.round(tornado128.domainBytes / 128),
      tornadoSubjectsOverDomainBudget: Math.floor(65_536 / (tornado128.domainBytes / 128)) + 1, perHeatDomainBytes: Math.round(heat256.domainBytes / 256),
      heatSubjectsOverDomainBudget: Math.floor(65_536 / (heat256.domainBytes / 256)) + 1 }));
    expect([tornado128.activeCount, heat256.activeCount, combined.activeCount]).toEqual([128, 256, 384]);
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、deferred の U-F・U-L・U-R・U-B・U-M の同時 dirty（AC11）。
  it("P3-C13-T11 acceptance / AC11: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (step: number) => { now = { wallTimeMs: now.wallTimeMs + step, monotonicMs: now.monotonicMs + step }; return now; };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c13-failed", now);
    await report(failed, xmlOf(N50), now);
    expect(failed.unit("U-M").persistence.kind).toBe("failed");
    const issued = failed.unit("U-M").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-M").persistence.currentGeneration;
    await report(failed, cancelNagasaki("2013-07-26T09:25:00+09:00"), tick(1_000));
    const afterCancel = failed.unit("U-M");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).tornado).toEqual([]);
    expect(afterCancel.tornado.map((item) => item.effective)).toEqual(["cancelled"]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(acking, "c13-ack", now, false);
    await report(acking, xmlOf(N50), now);
    const followAt = tick(1_000);
    const second = xmlOf(N50, serial("2"), retime("2013-07-26T09:21:00+09:00"));
    acking.root.mailbox.enqueue(envelope("c13-ack", "VPHW50", `follow#${++inputSequence}`, Buffer.from(second), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    // deferred は自分の保存中の入力を最長 1,000 ms 留保し、満了で送る（P3-UWR-AC04・P3-UWR-HOLD-LIMIT=A）。
    const sentAt = tick(1_000);
    acking.root.tick(sentAt);
    await acking.settle();
    expect(acking.owners.get("deferred")!["state"]!.checkpointAttempts["U-M"]).toMatchObject({ generation: 1, postCaptureDirtySince: sentAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-M").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1, dirtySince: sentAt.monotonicMs });
    expect(view(acking).tornado[0].source.reportDateTimeRaw).toBe("2013-07-26T09:21:00+09:00");

    // 通常終了: 保存して再起動し、復元した記録との差で続報を決める。transient は証拠だけが戻り、同じ報は重複、新しい版は証拠との差で採る。
    const files = new MemoryFiles();
    const firstRun = wired(files);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(firstRun, "c13-run1", now, false);
    await report(firstRun, xmlOf(N50), now);
    await report(firstRun, xmlOf(HEAT, retime("2013-07-26T09:20:00+09:00"), replaceTag("TargetDateTime", "2013-07-26T09:20:00+09:00")), tick(1), "VPFT50");
    await report(firstRun, xmlOf(FJ, retime("2013-07-26T09:20:00+09:00")), tick(1), "VPFJ51");
    expect([firstRun.unit("U-M").tornado.length, firstRun.unit("U-M").heat.length, firstRun.unit("U-M").transient.length]).toEqual([1, 1, 1]);
    const pendingBefore = firstRun.unit("U-M").intents.filter((item) => item.disposition === "pending");
    const summary = await firstRun.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-M"]).toMatchObject({ kind: "saved" });
    const secondRun = wired(files);
    await startHarness(secondRun, "c13-run2", tick(1), false);
    expect(secondRun.root.state.restoration["U-M"]).toEqual({ kind: "restored" });
    expect([view(secondRun).tornado.length, view(secondRun).heat.length, view(secondRun).transient.length]).toEqual([1, 1, 0]);
    expect(secondRun.unit("U-M").transient.map((item) => item.effective)).toEqual(["evidence"]);
    expect(secondRun.unit("U-M").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(secondRun.unit("U-M").intents.map((item) => item.id));
    await report(secondRun, xmlOf(N50), tick(1_000));
    await report(secondRun, xmlOf(FJ, retime("2013-07-26T09:20:00+09:00")), tick(1), "VPFJ51");
    expect(secondRun.unit("U-M").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(secondRun, xmlOf(N50, serial("2"), retime("2013-07-26T09:22:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00")), tick(1), "VPHW50");
    expect(secondRun.unit("U-M").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition])).toEqual([["warning", "updated"], ["warning", "updated"]]);
    await report(secondRun, xmlOf(FJ, serial("8"), retime("2013-07-26T09:23:00+09:00")), tick(1), "VPFJ51");
    expect(secondRun.unit("U-M").transient.map((item) => item.effective)).toEqual(["active"]);
    expect(secondRun.failures).toEqual([]);

    // U-F・U-L・U-R・U-B・U-M の同時 dirty: deferred の 5 unit は別々の書込み権を持つ（P3-C13-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const five = wired(parked);
    now = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    await startHarness(five, "c13-five", now, false);
    const stamp = retime("2026-06-05T17:00:00+09:00");
    await report(five, Buffer.from(unitBodies["U-F"].body).toString("utf8"), now, "VPWP50");
    await report(five, stamp(Buffer.from(unitBodies["U-L"].body).toString("utf8")), tick(1), "VPWW56");
    await report(five, stamp(Buffer.from(unitBodies["U-R"].body).toString("utf8")), tick(1), "VXKO50");
    await report(five, stamp(Buffer.from(unitBodies["U-B"].body).toString("utf8")), tick(1), "VPBS50");
    await report(five, xmlOf(N50, stamp, replaceTag("ValidDateTime", "2026-06-05T18:00:00+09:00")), tick(1));
    // U-L・U-R・U-B・U-M の入力は同じ deferred の保存中は留保され、1,000 ms で送られる（P3-UWR-AC04）。書込みは止めたまま。
    for (let round = 0; round < 5; round++) {
      five.root.tick(tick(1_000));
      await five.settle();
    }
    const units = ["U-F", "U-L", "U-R", "U-B", "U-M"] as const;
    const grants = units.map((unit) => five.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(units.map(() => "save"));
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(5);
    release();
    await five.settle();
    expect(units.map((unit) => five.unit(unit).persistence.kind)).toEqual(units.map(() => "saved"));
    expect(five.failures).toEqual([]);
  });
});
const ms = (value: string) => Date.parse(value);
