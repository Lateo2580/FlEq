import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { BriefingUnitState } from "../../contracts/p3-briefing-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { reduceBriefingUnit, toBriefingView } from "../../src/units/briefing/briefing-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, decodeXml, emptyState, eventId, receive, replaceTag, retime, serial, tags } from "./briefing-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-B を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "briefing-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "briefing-diagnostics" } as const;

const K1 = "phase6b_VPBS50_KJPTK202608221709_202608221709", K2 = "phase6b_VPBS50_KJPTK202608221709_202608221717";
const OA1 = "phase6b_VPOA50_JPTK202608221709_202608221709", SAMPLE = "82_01_01_260324_VPBS50";
const T0 = Date.parse("2026-08-22T17:09:00+09:00");
const K = "normal/VPBS50/KJPTK202608221709", P = "normal/VPOA50/JPTK202608221709";
let inputSequence = 0;
function report(h: Harness, xml: string, now: ClockReading, headType = "VPBS50") {
  return submit(h, envelope(h.root.state.runId, headType, `briefing#${++inputSequence}`, Buffer.from(xml), now, inputSequence));
}
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const cancel = (xml: string) => serial("2")(replaceTag("InfoType", "取消")(xml));

describe("P3-UNIT-B-001 U-B through the composition root", () => {
  // contractBoundary: A7 の群（P3-C12-NOTICE-GROUP=A）。U-B は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C12-T08 contractBoundary / AC08: U-B intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2026-08-22T17:09:00+09:00", serialRaw: "1", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t08", disposition: "pending" });
    // U-B を最も古く作る（同じ群なら先に選ばれる位置）。
    const briefing = notice("U-B", "weather", "warning", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, briefing], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, briefing]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [briefing, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([briefing, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-B:other"]);
  });

  // contractBoundary: P3-C12-SNAPSHOT=A。domain briefing は view に載る記録だけを数え、重大度は item の種別（VPOA50 の released は
  // specialWarning）、unknown と items 空は unknownCode。U-B だけの変化で出し直す。実配信の大きさの日と 256 subject の byte を記録する（AC06）。
  it("P3-C12-T06 contractBoundary / AC06: the snapshot briefing domain, a U-B-only change, hidden records and the maximum views", async () => {
    const at = (wallTimeMs: number, monotonicMs: number) => ({ wallTimeMs, monotonicMs });
    const started = await startup(at(T0, 1));
    const first = projected(projectSnapshot(projectionInput(started, T0), null));
    let projection = first.state;
    let state = started.state;
    let input = projectionInput(started, T0);
    let isolated: ReturnType<typeof projectSnapshot> | null = null;
    const send = async (xml: string, headType: string, wallTimeMs: number, monotonicMs: number) => {
      const next = await step(state, received("run", { headType, inputId: `briefing#${++inputSequence}`, body: Buffer.from(xml) },
        at(wallTimeMs, monotonicMs)));
      const nextInput = projectionInput(next, wallTimeMs);
      // 保存の状態を前の入力のままにした射影（出し直しの原因を U-B の domain だけに切り分ける）。
      isolated = projectSnapshot({ ...nextInput, persistence: input.persistence }, projection);
      const out = projectSnapshot(nextInput, projection);
      state = next.state;
      projection = out.state;
      input = nextInput;
      return out;
    };
    const record = projected(await send(text(K1), "VPBS50", T0 + 1, 2)).snapshot;
    expect(record.sequence).toBe(first.snapshot.sequence + 1);
    // U-B だけが変わった入力は、保存の状態が同じでも出し直す（view-projector の comparable に domain briefing が入る）。
    const alone = projected(isolated!).snapshot;
    expect({ ...alone.current, briefing: null }).toEqual({ ...first.snapshot.current, briefing: null });
    expect(alone.current.briefing).not.toEqual(first.snapshot.current.briefing);
    expect(record.current.briefing.items[0]).toMatchObject({ informationType: "briefing", activeCount: 1, highestSeverity: "specialWarning",
      areaCounts: {}, unknownCode: {}, updatedAt: T0 });
    // held の VPOA50 は載らず、予測だけ・unknown・items 空の記録は warning と unknownCode に数える。
    const held = projected(await send(text(OA1).replace("JPTK202608221709_202608221709", "JPTC202608221709_202608221709"), "VPOA50", T0 + 2, 3)).snapshot;
    expect(held.current.briefing.items[0]).toMatchObject({ activeCount: 1 });
    const kinds = projected(await send(tags([{ condition: "線状降水帯直前", areas: [{ code: "170020" }] }, { condition: "謎の現象", areas: [] }])(eventId(
      "YJPXX202608221710_202608221710")(text(K1))), "VPBS50", T0 + 3, 4)).snapshot;
    expect(kinds.current.briefing.items[0]).toMatchObject({ activeCount: 2, highestSeverity: "specialWarning", unknownCode: { unknown: 1 } });
    const empty = projected(await send(text(K1).replace(/<Information type="情報タグ">[\s\S]*?<\/Information>/, "").replace(
      "KJPTK202608221709_202608221709", "KJPXX202608221711_202608221711"), "VPBS50", T0 + 4, 5)).snapshot;
    expect(empty.current.briefing.items[0]).toMatchObject({ activeCount: 3, unknownCode: { unknown: 1, empty: 1 } });
    // 取消で記録が view から消える（cancelled を載せない）。
    const cancelled = projected(await send(cancel(text(K1)), "VPBS50", T0 + 5, 6)).snapshot;
    expect(cancelled.current.briefing.delivery === "full" && cancelled.current.briefing.view.currents.map((item) => item.subject).includes(K)).toBe(false);
    expect(projection.snapshot!.recovery["U-B"]).toEqual({ kind: "empty" });
    // highestSeverity と unknownCode を P3-C12-SNAPSHOT=A の表の全部の行で照らす（1 行に 1 記録の state を射影する）。
    const tag = (condition: string) => tags([{ condition, areas: [{ code: "130010" }] }]);
    const severityRows: readonly (readonly [string, string, string, number | null, string | null, Readonly<Record<string, number>>])[] = [
      ["linearRainObserved", tag("線状降水帯発生")(text(K1)), "VPBS50", null, "specialWarning", {}],
      ["recordRain", text(K1), "VPBS50", null, "specialWarning", {}],
      ["linearRainPredicted", tag("線状降水帯直前")(text(K1)), "VPBS50", null, "warning", {}],
      ["shortSnow", tag("短時間大雪")(text(K1)), "VPBS50", null, "warning", {}],
      ["unknown", tag("謎の現象")(text(K1)), "VPBS50", null, null, { unknown: 1 }],
      ["empty items", text(K1).replace(/<Information type="情報タグ">[\s\S]*?<\/Information>/, ""), "VPBS50", null, null, { empty: 1 }],
      ["VPOA50 released", text(OA1), "VPOA50", T0 + 60_000, "specialWarning", {}],
    ];
    for (const [name, xml, headType, releaseAt, severity, unknownCode] of severityRows) {
      const adopted = receive(emptyState(), decodeXml(xml, headType), clock(T0));
      const settled = releaseAt == null ? adopted : reduceBriefingUnit(adopted.state, { kind: "deadline", clock: clock(releaseAt) });
      const row = projected(projectSnapshot(projectionInput(started, T0, { briefing: toBriefingView(settled.state),
        displayChanges: [...adopted.displayChanges, ...releaseAt == null ? [] : settled.displayChanges] }), first.state));
      expect(row.snapshot.current.briefing.items[0], name).toMatchObject({ activeCount: 1, highestSeverity: severity, unknownCode });
    }

    // 実配信の大きさの日（実配信由来の 4 系列: 記録雨・発生 2・予測、旧築の採取 2025-08-10 の同時 4 subject の代用）と、256 subject を実配信の
    // 最大の記録の形（82_01_01、区域 3・観測 3）で満たした状態。domain briefing の byte を分野の予算 65,536 と、snapshot 全体の byte を
    // 1 MiB と比べて記録する。
    const measure = (xmls: readonly (readonly [string, string])[]) => {
      const changes: RuntimeDisplayChange[] = [];
      let value: BriefingUnitState = emptyState();
      for (const [xml, headType] of xmls) {
        const material = decodeXml(xml, headType);
        const result = receive(value, material, clock(Date.parse(material.reportDateTimeRaw)));
        changes.push(...result.displayChanges);
        value = result.state;
      }
      const view = toBriefingView(value);
      const big = projected(projectSnapshot(projectionInput(started, T0, { briefing: view, displayChanges: changes }), first.state));
      return { subjects: view.currents.length, recordBytes: value.currents.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0),
        viewBytes: Buffer.byteLength(JSON.stringify(view)), domainBytes: big.state.domains.briefing.utf8Bytes, domainBudget: 65_536,
        domainOverBudget: big.state.domains.briefing.utf8Bytes > 65_536, snapshotBytes: big.utf8Bytes, snapshotLimit: 1_048_576,
        delivery: big.snapshot.current.briefing.delivery, activeCount: big.snapshot.current.briefing.items[0]?.activeCount ?? 0 };
    };
    const day = measure([[text(K1), "VPBS50"], [text("VPBS50_HJPNA202608270258"), "VPBS50"], [text("VPBS50_HJPNB202608270308"), "VPBS50"],
      [text("VPBS50_YJPNA202608270448"), "VPBS50"]]);
    const full = measure(Array.from({ length: 256 }, (_, index) => [retime("2023-09-08T10:19:00+09:00")(eventId(`JPTE${String(index).padStart(12, "0")}`)(
      text(SAMPLE))), "VPBS50"] as const));
    // summary に落ちる必要条件（分野の予算 65,536 を超える subject の数）は 256 subject の状態の 1 subject あたりの domain の byte で割った数。
    console.info("P3-C12 maximum views", JSON.stringify({ day, full, perSubjectDomainBytes: Math.round(full.domainBytes / full.subjects),
      subjectsOverDomainBudget: Math.floor(65_536 / (full.domainBytes / full.subjects)) + 1 }));
    expect([day.activeCount, full.activeCount, day.delivery]).toEqual([4, 256, "full"]);
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、deferred の U-F・U-L・U-R・U-B の同時 dirty（AC10）。
  it("P3-C12-T10 acceptance / AC10: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-B"].view;
      if (value.unit !== "U-B") throw new Error("mirror view of another unit");
      return value;
    };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c12-failed", now);
    await report(failed, text(K1), now);
    expect(failed.unit("U-B").persistence.kind).toBe("failed");
    const issued = failed.unit("U-B").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-B").persistence.currentGeneration;
    await report(failed, cancel(text(K1)), tick(1_000));
    const afterCancel = failed.unit("U-B");
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
    await startHarness(acking, "c12-ack", now, false);
    await report(acking, text(K1), now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c12-ack", "VPBS50", `follow#${++inputSequence}`, Buffer.from(text(K2)), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    // deferred は自分の保存中の入力を最長 1,000 ms 留保し、満了で送る（P3-UWR-AC04・P3-UWR-HOLD-LIMIT=A）。
    const sentAt = tick(1_000);
    acking.root.tick(sentAt);
    await acking.settle();
    expect(acking.owners.get("deferred")!["state"]!.checkpointAttempts["U-B"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: sentAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-B").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: sentAt.monotonicMs });
    expect(view(acking).currents[0].source.reportDateTimeRaw).toBe("2026-08-22T17:17:00+09:00");

    // 通常終了: held の VPOA50 を無音で released にして保存し、相関を確定（aliased）と書かない。復元直後の続報は復元した記録との差で決める。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: T0 + 1, monotonicMs: 1 };
    await startHarness(first, "c12-run1", now, false);
    await report(first, text(K1), now);
    await report(first, text(OA1).replace("JPTK202608221709_202608221709", "JPTC202608221709_202608221709"), tick(1), "VPOA50");
    expect(first.unit("U-B").currents.map((item) => item.effective)).toEqual(["active", "held"]);
    const pendingBefore = first.unit("U-B").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-B"]).toMatchObject({ kind: "saved" });
    expect(first.unit("U-B").currents.map((item) => item.effective)).toEqual(["active", "released"]);
    const second = wired(files);
    await startHarness(second, "c12-run2", tick(1), false);
    expect(second.root.state.restoration["U-B"]).toEqual({ kind: "restored" });
    expect(view(second).currents.map((item) => [item.subject, item.effective])).toEqual([[K, "active"],
      ["normal/VPOA50/JPTC202608221709", "released"]]);
    expect(second.unit("U-B").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-B").intents.map((item) => item.id));
    await report(second, text(K1), tick(1_000));
    expect(second.unit("U-B").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, text(K2), tick(1_000));
    expect(second.unit("U-B").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition]))
      .toEqual([["warning", "updated"], ["warning", "updated"]]);
    // 復元の後の VPOA50 の取消は対応報へ波及しない。
    await report(second, cancel(text(OA1)), tick(1_000), "VPOA50");
    expect(second.unit("U-B").currents.find((item) => item.subject === K)?.effective).toBe("active");
    expect(second.unit("U-B").currents.find((item) => item.subject === P)?.effective).toBe("cancelled");
    expect(second.failures).toEqual([]);

    // U-F・U-L・U-R・U-B の同時 dirty: deferred の 4 unit は別々の書込み権を持つ（P3-C12-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const four = wired(parked);
    now = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    await startHarness(four, "c12-four", now, false);
    await report(four, Buffer.from(unitBodies["U-F"].body).toString("utf8"), now, "VPWP50");
    await report(four, retime("2026-06-05T17:00:00+09:00")(Buffer.from(unitBodies["U-L"].body).toString("utf8")), tick(1), "VPWW56");
    await report(four, retime("2026-06-05T17:00:00+09:00")(Buffer.from(unitBodies["U-R"].body).toString("utf8")), tick(1), "VXKO50");
    await report(four, retime("2026-06-05T17:00:00+09:00")(text(K1)), tick(1));
    // U-L・U-R・U-B の入力は同じ deferred の保存中は留保され、1,000 ms で送られる（P3-UWR-AC04）。書込みは止めたまま。
    for (let round = 0; round < 4; round++) {
      four.root.tick(tick(1_000));
      await four.settle();
    }
    const grants = (["U-F", "U-L", "U-R", "U-B"] as const).map((unit) => four.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save", "save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(4);
    release();
    await four.settle();
    expect((["U-F", "U-L", "U-R", "U-B"] as const).map((unit) => four.unit(unit).persistence.kind)).toEqual(["saved", "saved", "saved", "saved"]);
    expect(four.failures).toEqual([]);
  });
});
