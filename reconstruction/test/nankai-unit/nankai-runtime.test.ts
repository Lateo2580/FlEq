import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationIntent, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { NankaiUnitState } from "../../contracts/p3-nankai-unit.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toNankaiView } from "../../src/units/nankai/nankai-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, manualAdapter, park, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { decode, projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime } from "./nankai-fixture";

// TEST-PATH (2): 製品の publisher と in-process の owner（composition root の一経路）で U-N を通す。

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
const config = { appName: "fleq-p3", stateDirectory: "nankai-state", legacyAppName: "fleq",
  legacyStateDirectory: "legacy-state", diagnosticDirectory: "nankai-diagnostics" } as const;

const WARNING = "selected_xml/74_01_04_200512_VYSE50", ADVISORY = "selected_xml/74_01_05_200512_VYSE50";
const ADVISORY2 = "selected_xml/74_01_06_200512_VYSE50", CANCEL = "synthetic_VYSE50_cancel";
let inputSequence = 0;
function report(h: Harness, file: string, now: ClockReading, headType = "VYSE50") {
  return submit(h, envelope(h.root.state.runId, headType, `${file.split("/").at(-1)}#${++inputSequence}`,
    readFileSync(`test/fixtures/${file}.xml`), now, inputSequence));
}

describe("P3-UNIT-N-001 U-N through the composition root", () => {
  // contractBoundary: A7 の群（P3-C8-NOTICE-GROUP=A）。U-N の critical（巨大地震警戒）は other で、津波緊急を中断せず EEW・津波緊急の後に選ばれる。
  it("P3-C8-T07 contractBoundary / AC08: U-N intents are other; they neither abort tsunami emergency nor pass EEW", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit,
        subject: unit, reportDateTimeRaw: "2020-05-12T16:28:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t07", disposition: "pending" });
    // U-N を最も古く作る（同じ群なら先に選ばれる位置）。
    const nankai = notice("U-N", "earthquake-eew", "critical", -10), tsunami = notice("U-T", "tsunami", "critical", 0);
    const eew = notice("U-E", "earthquake-eew", "warning", 5);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, nankai], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, nankai]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [nankai, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([nankai, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-N:other"]);
  });

  // acceptance: P3-C8-SNAPSHOT=A。domain nankai は active の現況で数え、重大度と区域を持たず、U-N だけの変化で出し直す。
  // 情報 64 件と現況 6 件の合法最大の view でも snapshot は 1 MiB の内側（AC06）。
  it("P3-C8-T09 acceptance / AC06: the snapshot nankai domain, a U-N-only change and the legal maximum view", async () => {
    const at = (iso: string, monotonicMs: number) => ({ wallTimeMs: Date.parse(iso), monotonicMs });
    const started = await startup(at("2020-05-12T16:28:00+09:00", 1));
    const first = projected(projectSnapshot(projectionInput(started, Date.parse("2020-05-12T16:28:00+09:00")), null));
    let projection = first.state;
    let state = started.state;
    const send = async (file: string, iso: string, monotonicMs: number) => {
      const next = await step(state, received("run", decode(file, "VYSE50", undefined, `${file}#${++inputSequence}`), at(iso, monotonicMs)));
      const result = projectSnapshot(projectionInput(next, Date.parse(iso)), projection);
      const out = projected(result);
      state = next.state;
      projection = out.state;
      return out.snapshot;
    };
    const warning = await send(ADVISORY, "2020-05-12T16:32:01+09:00", 2);
    expect(warning.sequence).toBe(first.snapshot.sequence + 1);
    expect(warning.current.nankai.items[0]).toMatchObject({ informationType: "nankai", activeCount: 1, highestSeverity: null, areaCounts: {},
      updatedAt: Date.parse("2020-05-12T16:32:00+09:00") });
    expect(warning.current.nankai.delivery === "full" && warning.current.nankai.view.information.map((item) => item.title))
      .toEqual(["南海トラフ地震臨時情報（巨大地震注意）"]);
    // 取消で現況と情報が載らなくなる。復元は U-N の行で別に載る（空・unavailable を「現況なし」に読み替えない材料）。
    const cancelled = await send(CANCEL, "2020-05-12T16:33:01+09:00", 3);
    expect(cancelled.current.nankai.items[0]).toMatchObject({ activeCount: 0 });
    expect(projection.snapshot!.recovery["U-N"]).toEqual({ kind: "empty" });

    // 合法最大: 上限の長さの見出しの情報 64 件と現況 6 件（2 系統 × 3 区分）。
    const changes: RuntimeDisplayChange[] = [];
    let max: NankaiUnitState = emptyState();
    const now = Date.parse("2020-05-12T16:40:00+09:00");
    const wide = (length: number) => "震".repeat(length);
    const bound = (xml: string, status: string, eventId: string, code = "130") => retime("2020-05-12T16:40:00+09:00")(replaceTag("EventID", eventId)(xml))
      .replace("<Status>通常</Status>", `<Status>${status}</Status>`)
      .replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, `$1<Title>${wide(128)}</Title>`)
      .replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, `<Headline><Text>${wide(512)}</Text>`)
      .replace(/(<EarthquakeInfo[^>]*>\s*)<InfoKind>[^<]*<\/InfoKind>/, `$1<InfoKind>${wide(64)}</InfoKind>`)
      .replace(/<InfoSerial([^>]*)>[\s\S]*?<\/InfoSerial>/, `<InfoSerial$1><Name>${wide(32)}</Name><Code>${code}</Code></InfoSerial>`);
    const add = (xml: string, headType: string, inputId: string) => {
      const result = receive(max, decodeXml(xml, headType, inputId), clock(now));
      changes.push(...result.displayChanges);
      max = result.state;
    };
    for (const status of ["通常", "訓練", "試験"]) {
      add(bound(fixtureXml(ADVISORY.split("/")[1]), status, "E".repeat(64)), "VYSE50", `n-${status}`.padEnd(64, "i"));
      add(bound(fixtureXml("80_01_01_240821_VYSE60"), status, "F".repeat(64)).replace(/(<EarthquakeInfo[^>]*>\s*<InfoKind>[^<]*<\/InfoKind>)/,
        `$1<InfoSerial><Name>${wide(32)}</Name><Code>130</Code></InfoSerial>`), "VYSE60", `v-${status}`.padEnd(64, "i"));
    }
    // 解説（210）は現況に効かないので、情報 subject だけが増える。
    for (let index = 0; index < 64 && max.information.length < 64; index++)
      add(bound(fixtureXml("75_01_01_200512_VYSE51"), "通常", `${"I".repeat(60)}${String(index).padStart(4, "0")}`, "210"), "VYSE51", `c-${index}`.padEnd(64, "i"));
    expect([max.currents.length, max.information.length]).toEqual([6, 64]);
    const view = toNankaiView(max);
    const viewBytes = Buffer.byteLength(JSON.stringify(view));
    const big = projectSnapshot(projectionInput(started, now, { nankai: view, displayChanges: changes }), first.state);
    const shown = projected(big);
    console.info("P3-C8 legal maximum view", JSON.stringify({ viewBytes, contractView: 359_380, snapshotBytes: shown.utf8Bytes,
      delivery: shown.snapshot.current.nankai.delivery }));
    expect(shown.utf8Bytes).toBeLessThanOrEqual(1_048_576);
    expect(shown.snapshot.current.nankai.delivery).toBe("full");
    expect(shown.snapshot.current.nankai.items.map((item) => item.activeCount)).toEqual([2, 2, 2]);
  });

  // acceptance: §13.3 の保存失敗中の取消・古い ack・通常終了・復元直後の続報、U-E・U-T・U-Q・U-N の同時 dirty（AC10）。
  it("P3-C8-T09 acceptance / AC10,AC06: cancel during save failure, old ack, normal shutdown, the follow-up after restore and per-unit rights", async () => {
    let now: ClockReading = { wallTimeMs: Date.parse("2020-05-12T16:32:00+09:00") + 1, monotonicMs: 1 };
    const wired = (files: MemoryFiles, notificationAdapter: NonNullable<Parameters<typeof harnessedRoot>[2]>["notificationAdapter"]
      = recordingNotificationAdapter()) => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const view = (h: Harness) => {
      const value = h.root.state.mirror["U-N"].view;
      if (value.unit !== "U-N") throw new Error("mirror view of another unit");
      return value;
    };

    // 保存失敗中の取消: 取消は採用され、最新の dirty 世代を保ち、current を巻き戻さない。試行中の発表の intent は superseded で止まる。
    const failing = new MemoryFiles();
    failing.failWrite = true;
    const runningAdapter = manualAdapter();
    const failed = wired(failing, runningAdapter.adapter);
    await startHarness(failed, "c8-failed", now);
    await report(failed, ADVISORY, now);
    expect(failed.unit("U-N").persistence.kind).toBe("failed");
    const issued = failed.unit("U-N").intents.map((item) => item.id);
    const beforeCancel = failed.unit("U-N").persistence.currentGeneration;
    await report(failed, CANCEL, tick(1_000));
    const afterCancel = failed.unit("U-N");
    expect(afterCancel.persistence).toMatchObject({ kind: "failed", savedGeneration: 0 });
    expect(afterCancel.persistence.currentGeneration).toBeGreaterThan(beforeCancel);
    expect(runningAdapter.aborts).toHaveLength(2);
    expect(view(failed).currents).toEqual([]);
    expect(afterCancel.intents.filter((item) => issued.includes(item.id)).map((item) => item.disposition)).toEqual(issued.map(() => "superseded"));

    // 古い ack: 保存の書込み中に続報を採用すると、ack は古い世代だけを確定し、次の世代の dirty を保つ。
    const gated = new MemoryFiles();
    let open = () => {};
    gated.writeGate = new Promise<void>((resolve) => { open = resolve; });
    const acking = wired(gated);
    now = { wallTimeMs: Date.parse("2020-05-12T16:32:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(acking, "c8-ack", now, false);
    await report(acking, ADVISORY, now);
    const followAt = tick(1_000);
    acking.root.mailbox.enqueue(envelope("c8-ack", "VYSE50", `follow#${++inputSequence}`,
      readFileSync(`test/fixtures/${ADVISORY2}.xml`), followAt, inputSequence));
    acking.root.pump();
    await acking.settle();
    expect(acking.owners.get("urgent")!["state"]!.checkpointAttempts["U-N"]).toMatchObject({ generation: 1,
      postCaptureDirtySince: followAt.monotonicMs });
    acking.holdRequests((_place, request) => request.kind === "checkpointGrant");
    open();
    await acking.settle();
    expect(acking.unit("U-N").persistence).toMatchObject({ kind: "pending", currentGeneration: 2, savedGeneration: 1,
      dirtySince: followAt.monotonicMs });
    expect(view(acking).currents[0].source.reportDateTimeRaw).toBe("2020-05-12T16:34:00+09:00");

    // 通常終了と復元直後の続報: 復元した現況との差で決め、同じ報を再び鳴らさない。情報系列は空から始まる。
    const files = new MemoryFiles();
    const first = wired(files);
    now = { wallTimeMs: Date.parse("2020-05-12T16:28:00+09:00") + 1, monotonicMs: 1 };
    await startHarness(first, "c8-run1", now, false);
    await report(first, WARNING, now);
    const pendingBefore = first.unit("U-N").intents.filter((item) => item.disposition === "pending");
    const summary = await first.root.shutdownRuntime(inputSequence, tick(1));
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-N"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    const second = wired(files);
    await startHarness(second, "c8-run2", tick(1), false);
    expect(second.root.state.restoration["U-N"]).toEqual({ kind: "restored" });
    expect(view(second).currents.map((item) => [item.subject, item.status])).toEqual([["normal/nankai/current", "megaquakeWarning"]]);
    expect(view(second).information).toEqual([]);
    expect(second.unit("U-N").intents.filter((item) => item.disposition === "pending").map((item) => [item.id, item.createdAt, item.expiresAt]))
      .toEqual(pendingBefore.filter((item) => item.expiresAt > now.wallTimeMs).map((item) => [item.id, item.createdAt, item.expiresAt]));
    const known = new Set(second.unit("U-N").intents.map((item) => item.id));
    await report(second, WARNING, tick(1_000));
    expect(second.unit("U-N").intents.filter((item) => !known.has(item.id))).toEqual([]);
    await report(second, ADVISORY, tick(1_000));
    expect(second.unit("U-N").intents.filter((item) => !known.has(item.id)).map((item) => [item.payload.level, item.transition]))
      .toEqual([["warning", "updated"], ["warning", "updated"]]);
    expect(second.failures).toEqual([]);

    // U-E・U-T・U-Q・U-N の同時 dirty: urgent の 4 unit は別々の書込み権を持つ（P3-C8-WRITE-RIGHT、P3-UNIT-WRITE-RIGHT-001）。
    const parked = new MemoryFiles();
    let release = () => {};
    parked.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const four = wired(parked);
    now = { wallTimeMs: Date.parse("2024-04-17T14:15:30+09:00"), monotonicMs: 1 };
    await startHarness(four, "c8-four", now, false);
    await report(four, "37_01_01_240613_VXSE43", now, "VXSE43");
    await report(four, "32-39_11_02_250206_VTSE41", tick(1), "VTSE41");
    await report(four, "32-35_04_04_240613_VXSE53", tick(1), "VXSE53");
    await report(four, "selected_xml/80_01_01_240821_VYSE60", tick(1), "VYSE60");
    const grants = (["U-E", "U-T", "U-Q", "U-N"] as const).map((unit) => four.root.checkpoint.grantOf(unit));
    expect(grants.map((grant) => grant?.mode)).toEqual(["save", "save", "save", "save"]);
    expect(new Set(grants.map((grant) => grant?.grantId)).size).toBe(4);
    release();
    await four.settle();
    expect((["U-E", "U-T", "U-Q", "U-N"] as const).map((unit) => four.unit(unit).persistence.kind)).toEqual(["saved", "saved", "saved", "saved"]);
    expect(four.failures).toEqual([]);
  });

  // regression（監査 F03 の owner 経路、P3-AUTH-AC02）: 取消が先着した run の checkpoint から復元した owner に元報を入れても U-N は変わらない。
  it("P3-AUTH-T02 regression / AC02: an original after its cancel leaves U-N unchanged in an owner restored from the checkpoint", async () => {
    let now: ClockReading = { wallTimeMs: Date.parse("2020-05-12T16:38:00+09:00"), monotonicMs: 1 };
    const files = new MemoryFiles();
    const wired = () => harnessedRoot(config, linkedUnitCodecs, { clock: () => now, checkpointFileSystem: files,
      diagnosticFileSystem: new MemoryDiagnostics(), notificationAdapter: recordingNotificationAdapter() });
    const tick = (ms: number) => { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; return now; };
    const warning = (h: Harness, transform: (xml: string) => string, at: ClockReading) => submit(h, envelope(h.root.state.runId, "VYSE50",
      `f03#${++inputSequence}`, Buffer.from(transform(fixtureXml(WARNING.split("/")[1]))), at, inputSequence));
    const first = wired();
    await startHarness(first, "k2-run1", now, false);
    await warning(first, (xml) => replaceTag("InfoType", "取消")(retime("2020-05-12T16:38:00+09:00")(xml)), now);
    expect((await first.root.shutdownRuntime(inputSequence, tick(1))).persistence["U-N"]).toMatchObject({ kind: "saved", savedGeneration: 1 });
    const second = wired();
    await startHarness(second, "k2-run2", tick(1), false);
    expect(second.root.state.restoration["U-N"]).toEqual({ kind: "restored" });
    const before = second.unit("U-N");
    await warning(second, retime("2020-05-12T16:37:00+09:00"), tick(1_000));
    expect(second.unit("U-N")).toBe(before);
    expect(second.failures).toEqual([]);
  });
});
