import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { TyphoonUnitState } from "../../contracts/p3-typhoon-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toTyphoonView } from "../../src/units/typhoon/typhoon-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { analysisXml, clock, compose, decodeXml, emptyState, fixtureXml, iso, probabilityXml, receive, replaceTag, retime, send, sendXml, serial, six } from "./typhoon-fixture";

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
const config = { appName: "fleq-p3", stateDirectory: "typhoon-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "typhoon-diagnostics" } as const;

const A01 = "10_05_01_200826_VPTW60", P41 = "76_01_02_260531_VPTA50", TALIM = "10_04_03_170913_VPTW60";
const T0 = Date.parse("2026-05-31T09:00:00+09:00");
const TC2606 = "normal/typhoonAnalysis/TC2606";
let inputSequence = 0;
function report(h: Harness, xml: string, now: ClockReading, headType = "VPTW60") {
  return submit(h, envelope(h.root.state.runId, headType, `typhoon#${++inputSequence}`, Buffer.from(xml), now, inputSequence));
}
const xmlOf = (name: string, ...transforms: readonly ((xml: string) => string)[]) => compose(...transforms)(fixtureXml(name));
const analysis = (serialNo: string, report: string, o: Parameters<typeof analysisXml>[0] = {}) => analysisXml({ serial: serialNo, report, target: iso(Date.parse(report) - 45 * 60_000), ...o });
const view = (h: Harness) => {
  const value = h.root.state.mirror["U-Y"].view;
  if (value.unit !== "U-Y") throw new Error("mirror view of another unit");
  return value;
};

describe("P3-UNIT-Y-001 U-Y through the composition root", () => {
  // contractBoundary: A7 の群（P3-C14-NOTICE-GROUP=A）。U-Y は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C14-T09 contractBoundary / AC09: U-Y intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2026-08-22T17:09:00+09:00", serialRaw: "1", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t09", disposition: "pending" });
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const tsunami = notice("U-T", "tsunami", "critical", 0), eew = notice("U-E", "earthquake-eew", "warning", 5);
    // 実際の U-Y の intent（解析・確率とも weather の normal）。最も古く作る（同じ群なら先に選ばれる位置）。
    const real = [send(emptyState(), A01).intents[0], send(emptyState(), P41).intents[0]]
      .map((item, index): NotificationIntent => ({ ...item, id: `U-Y:${index}`, createdAt: -10 - index, expiresAt: 180_000, nextAttemptAt: -10 - index }));
    expect(real.map((item) => item.payload.domain)).toEqual(["weather", "weather"]);
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
      expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-Y:other"]);
    }
  });

  // acceptance: P3-C14-SNAPSHOT=A。domain typhoon は view に載る記録だけを数え、重大度は解析の実況の強さ（猛烈な＝danger、非常に強い・超大型＝warning）、確率は数えない。
  // 解析 64・確率 64 subject の状態の byte を分野の予算と snapshot 全体で分けて記録する（AC07）。
  it("P3-C14-T11 acceptance / AC07,AC11: the snapshot typhoon domain and the maximum views", async () => {
    const at = (wallTimeMs: number, monotonicMs: number) => ({ wallTimeMs, monotonicMs });
    const started = await startup(at(T0, 1));
    const first = projected(projectSnapshot(projectionInput(started, T0), null));
    let projection = first.state;
    let state = started.state;
    let input = projectionInput(started, T0);
    let isolated: ReturnType<typeof projectSnapshot> | null = null;
    const sendTo = async (xml: string, headType: string, wallTimeMs: number, monotonicMs: number) => {
      const next = await step(state, received("run", { headType, inputId: `typhoon#${++inputSequence}`, body: Buffer.from(xml) }, at(wallTimeMs, monotonicMs)));
      const nextInput = projectionInput(next, wallTimeMs);
      // 保存の状態を前の入力のままにした射影（出し直しの原因を U-Y の domain だけに切り分ける）。
      isolated = projectSnapshot({ ...nextInput, persistence: input.persistence }, projection);
      const out = projectSnapshot(nextInput, projection);
      state = next.state;
      projection = out.state;
      input = nextInput;
      return out;
    };
    const record = projected(await sendTo(analysis("1", "2026-05-31T09:45:00+09:00"), "VPTW60", T0 + 2_700_000, 2)).snapshot;
    expect(record.sequence).toBe(first.snapshot.sequence + 1);
    const alone = projected(isolated!).snapshot;
    expect({ ...alone.current, typhoon: null }).toEqual({ ...first.snapshot.current, typhoon: null });
    expect(alone.current.typhoon).not.toEqual(first.snapshot.current.typhoon);
    expect(record.current.typhoon.items[0]).toMatchObject({ informationType: "typhoon", activeCount: 1, highestSeverity: null, areaCounts: {}, unknownCode: {} });
    expect(projection.snapshot!.recovery["U-Y"]).toEqual({ kind: "empty" });
    // 猛烈な＝danger、非常に強い＝warning、超大型＝warning。確率の active は数えるが重さは付けない。取消で view から消える。
    const severe = projected(await sendTo(analysis("2", "2026-05-31T09:50:00+09:00", { intensity: "猛烈な", eventId: "TC2607" }), "VPTW60", T0 + 3_000_000, 3)).snapshot;
    expect(severe.current.typhoon.items[0]).toMatchObject({ activeCount: 2, highestSeverity: "danger" });
    const probability = projected(await sendTo(probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 5], slots: [5] }], report: "2026-05-31T09:55:00+09:00",
      target: "2026-05-31T09:00:00+09:00" }), "VPTA50", T0 + 3_300_000, 4)).snapshot;
    expect(probability.current.typhoon.items[0]).toMatchObject({ activeCount: 3, highestSeverity: "danger" });
    const cancelled = projected(await sendTo(analysis("3", "2026-05-31T10:00:00+09:00", { eventId: "TC2607", info: "取消" }).replace(/<Body[\s\S]*<\/Body>/, ""), "VPTW60", T0 + 3_600_000, 5)).snapshot;
    expect(cancelled.current.typhoon.items[0]).toMatchObject({ activeCount: 2, highestSeverity: null });
    expect(cancelled.current.typhoon.delivery === "full" && cancelled.current.typhoon.view.analysis.map((item) => item.subject)).toEqual([TC2606]);
    // 「非常に強い」と「超大型」は warning（danger の猛烈なは取消で外れた）。取消で外れれば重さも外れる。
    const strong = projected(await sendTo(analysis("1", "2026-05-31T10:05:00+09:00", { intensity: "非常に強い", eventId: "TC2608" }), "VPTW60", T0 + 3_900_000, 6)).snapshot;
    expect(strong.current.typhoon.items[0]).toMatchObject({ activeCount: 3, highestSeverity: "warning" });
    const strongGone = projected(await sendTo(analysis("2", "2026-05-31T10:10:00+09:00", { eventId: "TC2608", info: "取消" }).replace(/<Body[\s\S]*<\/Body>/, ""), "VPTW60", T0 + 4_200_000, 7)).snapshot;
    expect(strongGone.current.typhoon.items[0]).toMatchObject({ activeCount: 2, highestSeverity: null });
    const huge = projected(await sendTo(analysis("1", "2026-05-31T10:15:00+09:00", { size: "超大型", eventId: "TC2609" }), "VPTW60", T0 + 4_500_000, 8)).snapshot;
    expect(huge.current.typhoon.items[0]).toMatchObject({ activeCount: 3, highestSeverity: "warning" });

    // 最大の状態: 解析 64（実配信の形の 14 時刻の報）と確率 64（実配信の形の 273 地域の報）。domain の byte と分野の予算 65,536、snapshot 全体の byte と 1 MiB を分けて記録する。
    const measure = (analysisCount: number, probabilityCount: number) => {
      const changes: RuntimeDisplayChange[] = [];
      let value: TyphoonUnitState = emptyState();
      const feed = (name: string, count: number, make: (index: number) => (xml: string) => string) => {
        for (let index = 0; index < count; index++) {
          const material = decodeXml(make(index)(fixtureXml(name)), name.includes("VPTA") ? "VPTA50" : "VPTW60");
          const result = receive(value, material, clock(Date.parse(material.reportDateTimeRaw)));
          changes.push(...result.displayChanges);
          value = result.state;
        }
      };
      const idOf = (index: number) => `TC${String(index).padStart(4, "0")}`;
      feed(TALIM, analysisCount, (index) => compose((xml) => xml.replace(/<EventID>[^<]*/, `<EventID>${idOf(index)}`), retime(iso(Date.parse("2017-09-13T21:45:00+09:00") + index * 1000))));
      feed(P41, probabilityCount, (index) => compose((xml) => xml.replace(/<EventID>[^<]*/, `<EventID>${idOf(index)}`), retime(iso(Date.parse("2026-05-31T09:55:00+09:00") + index * 1000))));
      const shown = toTyphoonView(value);
      const big = projected(projectSnapshot(projectionInput(started, T0, { typhoon: shown, displayChanges: changes }), first.state));
      return { subjects: shown.analysis.length + shown.probability.length, viewBytes: Buffer.byteLength(JSON.stringify(shown)), domainBytes: big.state.domains.typhoon.utf8Bytes,
        domainBudget: 65_536, domainOverBudget: big.state.domains.typhoon.utf8Bytes > 65_536, snapshotBytes: big.utf8Bytes, snapshotLimit: 1_048_576,
        delivery: big.snapshot.current.typhoon.delivery, activeCount: big.snapshot.current.typhoon.items[0]?.activeCount ?? 0 };
    };
    const analysis64 = measure(64, 0), probability64 = measure(0, 64), both = measure(64, 64);
    console.info("P3-C14 maximum views", JSON.stringify({ analysis64, probability64, both,
      probabilitySubjectsOverDomainBudget: Math.floor(65_536 / (probability64.domainBytes / 64)) + 1, analysisSubjectsOverDomainBudget: Math.floor(65_536 / (analysis64.domainBytes / 64)) + 1 }));
    expect([analysis64.activeCount, probability64.activeCount, both.activeCount]).toEqual([64, 64, 128]);
    // 1.85 MB の確率の報を 128 回 decode する。Mac mini で約 10 秒、CI（Node 24）で 30 秒を超えた（7955db54）。
  }, 120_000);

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、deferred の 6 unit の同時 dirty（AC11）。
  it("P3-C14-T11 acceptance / AC11: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (step: number) => { now = { wallTimeMs: now.wallTimeMs + step, monotonicMs: now.monotonicMs + step }; return now; };
    const first = analysis("1", "2026-05-31T09:45:00+09:00"), cancel = analysis("1", "2026-05-31T09:45:00+09:00", { info: "取消" }).replace(/<Body[\s\S]*<\/Body>/, "");

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c14-failed", now);
    await report(failed, first, now);
    expect(failed.unit("U-Y").persistence.kind).toBe("failed");
    const issued = failed.unit("U-Y").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-Y").persistence.currentGeneration;
    await report(failed, cancel, tick(1_000));
    const afterCancel = failed.unit("U-Y");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).analysis).toEqual([]);
    expect(afterCancel.analysis.map((item) => item.effective)).toEqual(["cancelled"]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 保存失敗中の 1.85 MB の確率の報: 受信・意味判定・current の更新を続け、current を前の世代へ巻き戻さない。
    const bigFailing = new MemoryFiles();
    bigFailing.failWrite = true;
    const bigRun = wired(bigFailing);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(bigRun, "c14-big", now);
    await report(bigRun, fixtureXml(P41), tick(1), "VPTA50");
    expect([bigRun.unit("U-Y").persistence.kind, bigRun.unit("U-Y").probability.map((item) => item.effective)]).toEqual(["failed", ["active"]]);
    await report(bigRun, fixtureXml("synthetic_VPTA50_TC2606_zero"), tick(1_000), "VPTA50");
    expect(bigRun.unit("U-Y").probability.map((item) => item.effective)).toEqual(["zero"]);
    expect(bigRun.unit("U-Y").persistence.currentGeneration).toBeGreaterThan(1);

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(acking, "c14-ack", now, false);
    await report(acking, first, now);
    const followAt = tick(1_000);
    const second = analysis("2", "2026-05-31T09:50:00+09:00", { category: "台風(STS)" });
    acking.root.mailbox.enqueue(envelope("c14-ack", "VPTW60", `follow#${++inputSequence}`, Buffer.from(second), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    // deferred は自分の保存中の入力を最長 1,000 ms 留保し、満了で送る（P3-UWR-AC04・P3-UWR-HOLD-LIMIT=A）。
    const sentAt = tick(1_000);
    acking.root.tick(sentAt);
    await acking.settle();
    expect(acking.owners.get("deferred")!["state"]!.checkpointAttempts["U-Y"]).toMatchObject({ generation: 1, postCaptureDirtySince: sentAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-Y").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1, dirtySince: sentAt.monotonicMs });
    expect(view(acking).analysis[0].source.reportDateTimeRaw).toBe("2026-05-31T09:50:00+09:00");

    // 通常終了: 保存して再起動し、復元した記録との差で続報を決める（同じ報は重複、位置だけの続報は鳴らさない）。
    const files = new MemoryFiles();
    const firstRun = wired(files);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(firstRun, "c14-run1", now, false);
    await report(firstRun, first, now);
    await report(firstRun, fixtureXml(P41), tick(1), "VPTA50");
    expect([firstRun.unit("U-Y").analysis.length, firstRun.unit("U-Y").probability.length]).toEqual([1, 1]);
    const pendingBefore = firstRun.unit("U-Y").intents.filter((item) => item.disposition === "pending");
    const summary = await firstRun.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-Y"]).toMatchObject({ kind: "saved" });
    const secondRun = wired(files);
    await startHarness(secondRun, "c14-run2", tick(1), false);
    expect(secondRun.root.state.restoration["U-Y"]).toEqual({ kind: "restored" });
    expect([view(secondRun).analysis.length, view(secondRun).probability.length]).toEqual([1, 1]);
    expect(secondRun.unit("U-Y").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(secondRun.unit("U-Y").intents.map((item) => item.id));
    await report(secondRun, first, tick(1_000));
    expect(secondRun.unit("U-Y").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(secondRun, analysis("2", "2026-05-31T09:50:00+09:00", { category: "台風(STS)" }), tick(1));
    expect(secondRun.unit("U-Y").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition])).toEqual([["normal", "updated"], ["normal", "updated"]]);
    expect(secondRun.failures).toEqual([]);

    // U-F・U-L・U-R・U-B・U-M・U-Y の同時 dirty: deferred の 6 unit は別々の書込み権を持つ（P3-C14-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const six = wired(parked);
    now = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    await startHarness(six, "c14-six", now, false);
    const stamp = retime("2026-06-05T17:00:00+09:00");
    const body = (unit: "U-F" | "U-L" | "U-R" | "U-B" | "U-M" | "U-Y") => Buffer.from(unitBodies[unit].body).toString("utf8");
    await report(six, body("U-F"), now, "VPWP50");
    await report(six, stamp(body("U-L")), tick(1), "VPWW56");
    await report(six, stamp(body("U-R")), tick(1), "VXKO50");
    await report(six, stamp(body("U-B")), tick(1), "VPBS50");
    await report(six, compose(stamp, replaceTag("ValidDateTime", "2026-06-05T18:00:00+09:00"))(body("U-M")), tick(1), "VPHW50");
    await report(six, analysisXml({ report: "2026-06-05T17:00:00+09:00", target: "2026-06-05T16:00:00+09:00" }), tick(1), "VPTW60");
    // 入力は同じ deferred の保存中は留保され、1,000 ms で送られる（P3-UWR-AC04）。書込みは止めたまま。
    for (let round = 0; round < 6; round++) {
      six.root.tick(tick(1_000));
      await six.settle();
    }
    const units = ["U-F", "U-L", "U-R", "U-B", "U-M", "U-Y"] as const;
    const grants = units.map((unit) => six.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(units.map(() => "save"));
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(6);
    release();
    await six.settle();
    expect(units.map((unit) => six.unit(unit).persistence.kind)).toEqual(units.map(() => "saved"));
    expect(six.failures).toEqual([]);
  });
});
