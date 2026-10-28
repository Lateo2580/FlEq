import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, MailboxEnvelope, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { BodyResult, ListHead, UnitWalk, UnitWalkResult } from "../../contracts/p3-recovery.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { Mailbox } from "../../src/mailbox/mailbox";
import { walkStart } from "../../src/recovery/recovery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { envelope, harnessedRoot, manualAdapter, park, seeded, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { calls } from "../notification-delivery/delivery-fixture";
import { vtse41 } from "../tsunami-unit/tsunami-fixture";
import type { Area } from "../tsunami-unit/tsunami-fixture";

// P3-RECOVERY-001【発注 3】: 製品の publisher と in-process の owner（TEST-PATH (2)）で、取り直しの候補・採用・確認・穴の解決を通す。
// host の口（一覧の辿り・本文の取得・受信の順の列）だけを試験が答える。網へは出ない。

class MemoryFiles implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return { write: async (value) => { bytes = value.slice(); }, sync: async () => {}, close: async () => { this.files.set(path, bytes); } };
  }
  async rename(from: string, to: string): Promise<void> { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
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

const config = { appName: "fleq-p3", stateDirectory: "rec-state", legacyAppName: "fleq", legacyStateDirectory: "legacy-state",
  diagnosticDirectory: "rec-diagnostics" } as const;
const T0 = Date.parse("2026-10-28T03:00:00Z");
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// 一覧の頭（U-T の VTSE41）。id は英数字、eventId は subject の鍵。
function head(id: string, eventId: string, receivedAtMs: number, operation: ListHead["operation"] = "normal"): ListHead {
  return { id, unit: "U-T", headType: "VTSE41", receivedAtMs, operation, title: "津波警報", headline: null, reportDateTime: null, infoType: "発表",
    serial: null, eventId, controlDateTime: null, controlStatus: operation === "normal" ? "通常" : "訓練", test: operation !== "normal" };
}
const xml = (text: string): BodyResult => ({ kind: "ok", bytes: Buffer.from(text), contentType: "application/xml" });
const report = (eventId: string, atMs: number, areas: readonly Area[], operation: ListHead["operation"] = "normal") =>
  vtse41({ eventId, at: iso(atMs), operation, areas });

// 試験の root と host の口。bodies は一覧の id → 本文、listed は run の中のきっかけの一覧の答え。
// files は owner の保存の file system（保存の ack を止める試験が門を置く）、seeds は U-T の state を置く行（seeded()）。
async function setup(files: CheckpointFileSystem = new MemoryFiles(), seeds?: ReturnType<typeof seeded>) {
  let now: ClockReading = { wallTimeMs: T0, monotonicMs: 1_000 };
  const snapshots: DisplaySnapshot[] = [];
  const diagnostics = new MemoryDiagnostics();
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: manualAdapter().adapter,
    checkpointFileSystem: files, diagnosticFileSystem: diagnostics, display: { publish: (snapshot) => { snapshots.push(snapshot); } },
    ...seeds == null ? {} : { runtimeCalls: { ...calls, units: seeds.units } } });
  await startHarness(h, "rec3", now);
  let sequence = 0;
  h.root.attachSequence(() => ++sequence, () => sequence);
  const bodies = new Map<string, BodyResult | (() => Promise<BodyResult>)>();
  const fetched: string[] = [];
  const walks: (readonly UnitWalk[])[] = [];
  let listed: (plan: readonly UnitWalk[]) => readonly UnitWalkResult[] = (plan) => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [] }));
  const io = {
    classifications: ["telegram.earthquake"] as const,
    walk: async (plan: readonly UnitWalk[]) => { walks.push(plan); return listed(plan); },
    fetchBody: async (item: ListHead) => {
      fetched.push(item.id);
      const body = bodies.get(item.id);
      return typeof body === "function" ? body() : body ?? { kind: "failed" as const };
    },
    notBefore: () => -Infinity,
  };
  const t = {
    h, io, bodies, fetched, walks, snapshots, diagnostics,
    get now() { return now; },
    advance(ms: number) { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; },
    set listed(value: (plan: readonly UnitWalk[]) => readonly UnitWalkResult[]) { listed = value; },
    get sequence() { return sequence; },
    next() { return ++sequence; },
    // 起動の辿りがそのまま起動の取り直しになる（AC02 (7)）。
    async startup(heads: readonly ListHead[]) {
      h.root.attachRecovery(io, { "U-T": walkStart(null, "empty", now.wallTimeMs) }, Promise.resolve([{ unit: "U-T", kind: "listed", heads }]));
      await t.drive();
    },
    // 取り直しの非同期の段（本文の取得・owner の返信）が止まるまで回す。
    async drive() {
      for (let turn = 0; turn < 30; turn += 1) { await h.settle(); await new Promise((done) => setTimeout(done, 0)); }
    },
    progress(unit: RuntimeUnitId = "U-T") { return snapshots.at(-1)?.recovery.progress?.find((item) => item.unit === unit); },
    whole(unit: RuntimeUnitId, operation: "normal" | "training" | "test" = "normal") { return h.root.state.confirmation.units[unit][operation].whole; },
    // live の VTSE41 1 件（受信の順の列から番号を取る）。
    live(text: string) {
      const at = ++sequence;
      return submit(h, envelope(h.root.state.runId, "VTSE41", `input-${at}`, Buffer.from(text), now, at));
    },
    recoveryReplies() { return h.delivered.flatMap(({ reply }) => reply.kind === "recoveryDone" ? [reply] : []); },
    async warnings() {
      await h.root.diagnostics.flush();
      return [...diagnostics.lines.values()].join("").split("\n").filter((line) => line.includes('"component":"recovery"'))
        .map((line) => JSON.parse(line)).map(({ reason, unit }: { reason: string; unit?: string }) => [reason, unit]);
    },
  };
  return t;
}

describe("P3-REC-T15 acceptance: the adopt step (AC06 (a)(b), AC07, AC10)", () => {
  it("a recovered advisory→warning raise is one warning intent made at adoption with the recovered payload; the candidate is kept", async () => {
    const t = await setup();
    await t.live(report("20991231000001", T0 - 10 * MINUTE, [{ code: "311", name: "区域311", kind: "62" }]));
    const before = new Set(t.h.root.state.mirror["U-T"].pendingIntents.map((intent) => intent.id));
    t.bodies.set("b1", xml(report("20991231000001", T0 - 5 * MINUTE, [{ code: "311", name: "区域311", kind: "51" }])));
    await t.startup([head("b1", "20991231000001", T0 - 5 * MINUTE)]);
    const fresh = t.h.root.state.mirror["U-T"].pendingIntents.filter((intent) => !before.has(intent.id));
    expect(fresh.map((intent) => [intent.channel, intent.payload.level, intent.payload.recovered, intent.payload.reportDateTime]))
      .toEqual([["desktop", "warning", true, iso(T0 - 5 * MINUTE)], ["sound", "warning", true, iso(T0 - 5 * MINUTE)]]);
    expect(t.progress()).toEqual({ unit: "U-T", state: "recovered" });
    expect(t.whole("U-T")).toBeNull();
    // 保存して読み戻せる（payload の 2 欄を codec が項目ごとに確かめる、AC12）。
    expect(tsunamiUnitCodec.decode(tsunamiUnitCodec.encode(t.h.unit("U-T")))).toMatchObject({ kind: "restored",
      state: { intents: t.h.unit("U-T").intents } });
  });

  it("two unreadable VTSE41 bodies give one info intent per channel with the recoveryId; no coverage, whole unreadableReport", async () => {
    const t = await setup();
    // 同じ区域の code が 2 つある報は unit が断る（requiredStructureInvalid）→ unreadable のカードと負の証拠。
    const broken = (eventId: string) => xml(report(eventId, T0 - MINUTE, [{ code: "311", name: "a", kind: "51" }, { code: "311", name: "b", kind: "51" }]));
    t.bodies.set("u1", broken("20991231000002"));
    t.bodies.set("u2", broken("20991231000003"));
    await t.startup([head("u1", "20991231000002", T0 - 2 * MINUTE), head("u2", "20991231000003", T0 - MINUTE)]);
    const [adopted] = t.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    if (adopted?.result.kind !== "adopted") throw new Error("adopted reply expected");
    expect(adopted.result.inputs.map((item) => item.result)).toEqual(["unreadableReport", "unreadableReport"]);
    const info = t.h.root.state.mirror["U-T"].pendingIntents.filter((intent) => intent.subject === "normal/unreadable");
    expect(info.map((intent) => intent.id)).toEqual([`U-T:normal/unreadable:recovery:${adopted.recoveryId}:desktop`,
      `U-T:normal/unreadable:recovery:${adopted.recoveryId}:sound`]);
    expect(info.map((intent) => [intent.payload.level, intent.payload.title, intent.priorityGroup]))
      .toEqual([["info", "津波の情報（読めない報）を受信", "other"], ["info", "津波の情報（読めない報）を受信", "other"]]);
    expect([t.whole("U-T"), t.progress()]).toEqual(["unreadableReport", { unit: "U-T", state: "unsatisfied", reason: "fetchFailed" }]);
    expect(tsunamiUnitCodec.decode(tsunamiUnitCodec.encode(t.h.unit("U-T")))).toMatchObject({ kind: "restored",
      state: { intents: t.h.unit("U-T").intents } });
    expect(await t.warnings()).toContainEqual(["recoveryFetchFailed", "U-T"]);
  });

  // P3-UNREADABLE-MARK-001 の P3-UM-T12（AC12 (10)）: 候補の step は読めない報の通知の入力を渡さない（渡すと候補の U-T に基点に無い intent ができ、
  // 部分集合の検査で候補ごと捨てられる）。U-T が断る 1 通と parser が断る 1 通で、採用の step の info だけが 1 回。
  it("P3-UM-T12 acceptance / AC12 (10): unreadable VTSE41 bodies in a candidate add no live-style notice; the candidate is adopted with one info", async () => {
    const t = await setup();
    t.bodies.set("u1", xml(report("20991231000004", T0 - 2 * MINUTE, [{ code: "311", name: "a", kind: "51" }, { code: "311", name: "b", kind: "51" }])));
    t.bodies.set("u2", xml(report("20991231000005", T0 - MINUTE, [{ code: "311", name: "a", kind: "51" }]).replace("</Head>", "</Hed>")));
    await t.startup([head("u1", "20991231000004", T0 - 2 * MINUTE), head("u2", "20991231000005", T0 - MINUTE)]);
    const [adopted] = t.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    if (adopted?.result.kind !== "adopted") throw new Error("adopted reply expected");
    expect(adopted.result.inputs.map((item) => item.result)).toEqual(["unreadableReport", "unreadable"]);
    expect(t.h.unit("U-T").intents.filter((intent) => intent.subject === "normal/unreadable").map((intent) => [intent.id, intent.payload.level]))
      .toEqual(["desktop", "sound"].map((channel) => [`U-T:normal/unreadable:recovery:${adopted.recoveryId}:${channel}`, "info"]));
  });

  it("an invalid-UTF-8 body is unreadable in the reply: no negative evidence, no coverage; a sequence missing from the reply blocks it too", async () => {
    const t = await setup();
    t.bodies.set("p1", { kind: "ok", bytes: Buffer.from([0x3c, 0xff, 0xfe, 0x3e]), contentType: "application/xml" });
    await t.startup([head("p1", "20991231000004", T0 - MINUTE)]);
    const [adopted] = t.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    expect(adopted?.result.kind === "adopted" && adopted.result.inputs.map((item) => item.result)).toEqual(["unreadable"]);
    expect([t.whole("U-T"), t.progress()?.state]).toEqual(["startup", "unsatisfied"]);
    // 送った本文が返信に無い（owner が候補の無い時に捨てた等）: 採用の返信から inputs を外して届ける。
    const t2 = await setup();
    t2.h.hold((_, reply) => reply.kind === "recoveryDone" && reply.result.kind === "adopted");
    t2.bodies.set("q1", xml(report("20991231000005", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    await t2.startup([head("q1", "20991231000005", T0 - MINUTE)]);
    const held = t2.h.held.splice(0);
    const reply = held[0].reply as Extract<OwnerReply, { kind: "recoveryDone" }>;
    if (reply.result.kind !== "adopted") throw new Error("adopted reply expected");
    t2.h.redeliver(held[0].place, { ...reply, result: { ...reply.result, inputs: [] } });
    await t2.drive();
    expect([t2.whole("U-T"), t2.progress()?.state]).toEqual(["startup", "unsatisfied"]);
  });

  it("a live VTSE41 during the candidate changes the base: the bodies are re-applied and adopted; a candidate over RES-08 is generationConflict", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("r1", xml(report("20991231000006", T0 - 3 * MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    t.bodies.set("r2", () => new Promise((done) => { release = () => done(xml(report("20991231000007", T0 - 2 * MINUTE, [{ code: "312", name: "b", kind: "62" }]))); }));
    void t.startup([head("r1", "20991231000006", T0 - 3 * MINUTE), head("r2", "20991231000007", T0 - 2 * MINUTE)]);
    await t.drive();
    await t.live(report("20991231000008", T0 - MINUTE, [{ code: "313", name: "c", kind: "51" }]));
    release();
    await t.drive();
    expect(t.progress()?.state).toBe("recovered");
    expect(t.h.unit("U-T").forecasts.map((item) => item.eventId).sort()).toEqual(["20991231000006", "20991231000007", "20991231000008"]);
    // RES-08（16 MiB）を越える候補は基点が変わると作り直さない。
    const big = await setup();
    const padded = (eventId: string, code: string) => report(eventId, T0 - MINUTE, [{ code, name: "a", kind: "62" }])
      .replace("<Body", `<!--${"x".repeat(6 * 1024 * 1024)}--><Body`);
    let late!: () => void;
    big.bodies.set("g1", xml(padded("20991231000011", "311")));
    big.bodies.set("g2", xml(padded("20991231000012", "312")));
    big.bodies.set("g3", () => new Promise((done) => { late = () => done(xml(padded("20991231000013", "313"))); }));
    void big.startup([head("g1", "20991231000011", T0 - 3 * MINUTE), head("g2", "20991231000012", T0 - 2 * MINUTE), head("g3", "20991231000013", T0 - MINUTE)]);
    await big.drive();
    await big.live(report("20991231000014", T0 - MINUTE, [{ code: "314", name: "d", kind: "62" }]));
    late();
    await big.drive();
    expect(big.progress()).toEqual({ unit: "U-T", state: "unsatisfied", reason: "generationConflict" });
    expect(await big.warnings()).toContainEqual(["recoveryGenerationConflict", "U-T"]);
  });
});

describe("P3-REC-T12・T16 (r4): a recovered training report carries head.test from the list (AC05)", () => {
  it("a training VTSE41 (32-39_12_02) is adopted as training, not an unreadable report; training gets no recovery confirmation", async () => {
    const t = await setup();
    t.bodies.set("tr1", { kind: "ok", bytes: readFileSync("test/fixtures/32-39_12_02_250206_VTSE41.xml"), contentType: "application/xml" });
    await t.startup([head("tr1", "20160901071000", T0 - MINUTE, "training")]);
    const [adopted] = t.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    expect(adopted?.result.kind === "adopted" && adopted.result.inputs.map((item) => item.result)).toEqual(["adopted"]);
    expect(t.h.unit("U-T").forecasts.map((item) => item.operation)).toEqual(["training"]);
    // 取り直しの確認は normal だけ（統合担当の決め 2026-10-28）。training の slot は確認されずに残る。
    expect([t.progress()?.state, t.whole("U-T", "training"), t.h.root.state.mirror["U-T"].view.unreadableCards ?? []]).toEqual(["recovered", "startup", []]);
  });
});

describe("P3-REC-T02 acceptance: no interim publication, live cancel and save ack during the candidate (AC06, AC07, AC17)", () => {
  it("while the candidate is built no view, outcome or coverage moves; a live cancel and a save ack only re-base it", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("c1", xml(report("20991231000021", T0 - 3 * MINUTE, [{ code: "311", name: "a", kind: "52" }])));
    t.bodies.set("c2", () => new Promise((done) => { release = () => done(xml(report("20991231000022", T0 - 2 * MINUTE, [{ code: "312", name: "b", kind: "51" }]))); }));
    await t.live(report("20991231000023", T0 - 4 * MINUTE, [{ code: "313", name: "c", kind: "62" }]));
    const view = t.h.root.state.mirror["U-T"].view;
    void t.startup([head("c1", "20991231000021", T0 - 3 * MINUTE), head("c2", "20991231000022", T0 - 2 * MINUTE)]);
    await t.drive();
    // 1 件目の本文は候補に入ったが、mirror の view・未確認・pending は動かない（途中公開 0）。
    expect([t.h.root.state.mirror["U-T"].view, t.whole("U-T")]).toEqual([view, "startup"]);
    expect(t.h.unit("U-T").forecasts.map((item) => item.eventId)).toEqual(["20991231000023"]);
    // live の取消と保存の ack の後でも候補は作り直されて採用される（generationConflict にならない）。
    await t.live(vtse41({ eventId: "20991231000023", at: iso(T0 - MINUTE), infoType: "取消" }));
    await t.h.root.driveCheckpoint();
    await t.drive();
    release();
    await t.drive();
    expect(t.progress()?.state).toBe("recovered");
    const forecasts = t.h.unit("U-T").forecasts;
    expect(forecasts.map((item) => [item.eventId, item.effective]).sort())
      .toEqual([["20991231000021", "active"], ["20991231000022", "active"], ["20991231000023", "cancelled"]]);
    // 候補を作る step では intent を作らない。採用で作るのは引上げの 1 件（段の最も高い大津波警報、critical）だけ。
    const recovered = t.h.root.state.mirror["U-T"].pendingIntents.filter((intent) => intent.payload.recovered === true);
    expect(recovered.map((intent) => [intent.subject, intent.payload.level])).toEqual([["normal/VTSE41/20991231000021", "critical"],
      ["normal/VTSE41/20991231000021", "critical"]]);
  });
});

describe("P3-REC-T03 acceptance: no deadline extension (AC08, AC17)", () => {
  it("a released report 8 days old is retained from its own report time and is collected at adoption", async () => {
    const t = await setup();
    t.bodies.set("e1", xml(report("20991231000031", T0 - 8 * 24 * 60 * MINUTE, [{ code: "311", name: "a", kind: "71" }])));
    await t.startup([head("e1", "20991231000031", T0 - 8 * 24 * 60 * MINUTE)]);
    expect(t.progress()?.state).toBe("recovered");
    expect(t.h.unit("U-T").forecasts).toEqual([]);
  });
});

describe("P3-REC-T04 / T16 acceptance: limits, progress and coverage (AC04, AC09, AC11)", () => {
  it("over 300 bodies U-T is recoveryLimit without fetching; within, coverage for normal only, other units notRecovered", async () => {
    const over = await setup();
    await over.startup(Array.from({ length: 301 }, (_, index) => head(`h${index}`, String(20991231100000 + index), T0 - index)));
    expect([over.fetched.length, over.progress(), over.whole("U-T")]).toEqual([0, { unit: "U-T", state: "unsatisfied", reason: "recoveryLimit" },
      "startup"]);
    expect(await over.warnings()).toContainEqual(["recoveryLimit", "U-T"]);
    const t = await setup();
    t.bodies.set("k1", xml(report("20991231000041", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    await t.startup([head("k1", "20991231000041", T0 - MINUTE)]);
    expect([t.whole("U-T"), t.whole("U-T", "training"), t.whole("U-T", "test")]).toEqual([null, "startup", "startup"]);
    expect(t.snapshots.at(-1)?.recovery.progress).toEqual([{ unit: "U-T", state: "recovered" }]);
  });

  it("a live capacityExceeded after the list start keeps that operation unconfirmed; the 513th recovered forecast is capacityExceeded (T15)", async () => {
    // U-T の normal の active の予報 512 件（P3-C5-CAPACITY）。
    const full = async () => {
      const seeds = seeded();
      const t = await setup(new MemoryFiles(), seeds);
      await t.live(report("20991231000500", T0 - 10 * MINUTE, [{ code: "311", name: "a", kind: "62" }]));
      const [template] = t.h.unit("U-T").forecasts;
      const forecasts = Array.from({ length: 512 }, (_, index) => {
        const eventId = String(20991231000500 + index), subject = `normal/VTSE41/${eventId}`;
        return { ...template, subject, eventId, source: { ...template.source, subject } };
      });
      await seeds.tsunami(t.h, { ...t.h.unit("U-T"), forecasts, intents: [] });
      return t;
    };
    const t = await full();
    let release!: () => void;
    // 手元の系列の新しい版（採用できる）を取り直す間に、live で別の EventID の報（513 件目）が容量で断られる。
    t.bodies.set("n1", () => new Promise((done) => { release = () => done(xml(report("20991231000500", T0 - 5 * MINUTE, [{ code: "311", name: "a", kind: "51" }]))); }));
    void t.startup([head("n1", "20991231000500", T0 - 5 * MINUTE)]);
    await t.drive();
    await t.live(report("20991231009999", T0 - MINUTE, [{ code: "312", name: "b", kind: "62" }]));
    expect(t.whole("U-T")).toBe("capacityExceeded");
    release();
    await t.drive();
    expect([t.progress()?.state, t.whole("U-T"), t.whole("U-T", "training")]).toEqual(["recovered", "capacityExceeded", "startup"]);
    // 取り直しの本文が 513 件目なら、採用の返信に capacityExceeded が載り、確認は出ない。
    const over = await full();
    over.bodies.set("n2", xml(report("20991231009998", T0 - MINUTE, [{ code: "312", name: "b", kind: "62" }])));
    await over.startup([head("n2", "20991231009998", T0 - MINUTE)]);
    const [adopted] = over.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    expect(adopted?.result.kind === "adopted" && adopted.result.inputs.map((item) => item.result)).toEqual(["capacityExceeded"]);
    expect([over.whole("U-T"), over.progress()?.state]).toEqual(["capacityExceeded", "unsatisfied"]);
  });
});

describe("P3-REC-T14 acceptance: the K7 handoff (a) on U-T (AC05 (a), 作者裁定 2026-10-28 午後)", () => {
  // 取り直しの本文は時刻の有無にかかわらず通常の版の比べだけにかける。決まらなければ採らず（held）、印も外さず、その unit は確認されない。
  const unconfirmedHeld = (t: Awaited<ReturnType<typeof setup>>) => {
    const [adopted] = t.recoveryReplies().filter((reply) => reply.result.kind === "adopted");
    return [adopted?.result.kind === "adopted" && adopted.result.inputs.map((item) => item.result), t.progress()?.state, t.whole("U-T")];
  };
  const cancelHead = (id: string, series: string) => ({ ...head(id, series, T0 - MINUTE), infoType: "取消", controlDateTime: "" });

  it("r0 の列: 時刻の無い取消の初報 → 古い警報①②（印あり）→ 一覧の最新の取消でも取消に戻さず、警報と印が残る（作者が受け入れた欠け）", async () => {
    const t = await setup();
    const series = "20991231000203";
    const cancel = vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" });
    await t.live(cancel);
    expect(tsunamiUnitCodec.decode(tsunamiUnitCodec.encode(t.h.unit("U-T"))).kind).toBe("restored");
    await t.live(report(series, T0 - 3 * MINUTE, [{ code: "311", name: "A", kind: "51" }]));
    await t.live(report(series, T0 - 2 * MINUTE, [{ code: "311", name: "A", kind: "52" }]));
    t.bodies.set("cancel", xml(cancel));
    await t.startup([cancelHead("cancel", series)]);
    expect(t.h.unit("U-T").forecasts.map((item) => [item.effective, item.source.reportDateTimeRaw, item.unconfirmed?.infoTypeRaw]))
      .toEqual([["active", iso(T0 - 2 * MINUTE), "取消"]]);
    expect(unconfirmedHeld(t)).toEqual([["held"], "unsatisfied", "startup"]);
  });

  it("r1 の T14 の 2 本目（期待を改めた）: 一覧の最新が手元の版②なら重複として採り、印は外さない（取り直しでは K7 の印を外さない）", async () => {
    const t = await setup();
    const series = "20991231000204";
    await t.live(vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" }));
    await t.live(report(series, T0 - 3 * MINUTE, [{ code: "311", name: "A", kind: "51" }]));
    const second = report(series, T0 - 2 * MINUTE, [{ code: "311", name: "A", kind: "52" }]);
    await t.live(second);
    t.bodies.set("second", xml(second));
    await t.startup([head("second", series, T0 - 2 * MINUTE)]);
    expect(t.h.unit("U-T").forecasts.map((item) => [item.effective, item.unconfirmed?.infoTypeRaw])).toEqual([["active", "取消"]]);
    expect(unconfirmedHeld(t)).toEqual([["adopted"], "recovered", null]);
  });

  it("ヘルツ r1（r1-probe:121）: 待ちの間の live の新しい警報が、一覧の時刻の無い取消で戻らない", async () => {
    const t = await setup();
    const series = "20991231000901";
    await t.live(report(series, T0 - 3 * MINUTE, [{ code: "311", name: "A", kind: "51" }]));
    const cancel = vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" });
    let release!: () => void;
    t.bodies.set("oldcancel", () => new Promise((done) => { release = () => done(xml(cancel)); }));
    await t.startup([cancelHead("oldcancel", series)]);
    await t.live(report(series, T0, [{ code: "311", name: "A", kind: "52" }]));
    release();
    await t.drive();
    expect(t.h.unit("U-T").forecasts[0]).toMatchObject({ effective: "active", source: { reportDateTimeRaw: iso(T0) } });
    expect(unconfirmedHeld(t)).toEqual([["held"], "unsatisfied", "startup"]);
  });

  it("ヘルツ r2（r2-probe:130）: 一覧を引いている間に届いた live の警報が、印と一致した取消で戻らない", async () => {
    const t = await setup();
    const series = "20991231000801";
    const cancel = vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" });
    await t.live(cancel);
    await t.live(report(series, T0 - 3 * MINUTE, [{ code: "311", name: "A", kind: "51" }]));
    let resolveList!: (value: readonly UnitWalkResult[]) => void;
    const listing = new Promise<readonly UnitWalkResult[]>((done) => { resolveList = done; });
    t.bodies.set("cancel", xml(cancel));
    t.h.root.attachRecovery(t.io, { "U-T": walkStart(null, "empty", t.now.wallTimeMs) }, listing);
    await t.drive();
    await t.live(report(series, T0, [{ code: "311", name: "A", kind: "52" }]));
    resolveList([{ unit: "U-T", kind: "listed", heads: [cancelHead("cancel", series)] }]);
    await t.drive();
    expect(t.h.unit("U-T").forecasts[0]).toMatchObject({ effective: "active", source: { reportDateTimeRaw: iso(T0) } });
    expect(unconfirmedHeld(t)).toEqual([["held"], "unsatisfied", "startup"]);
  });

  it("ヘルツ r2（r2-probe:143）: 候補を開いた後に live で付いた印をすり抜けない", async () => {
    const t = await setup();
    const series = "20991231000802";
    await t.live(report(series, T0 - 3 * MINUTE, [{ code: "311", name: "A", kind: "51" }]));
    const cancel = vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" });
    let release!: () => void;
    t.bodies.set("cancel", () => new Promise((done) => { release = () => done(xml(cancel)); }));
    await t.startup([cancelHead("cancel", series)]);
    await t.live(cancel);
    await t.live(report(series, T0, [{ code: "311", name: "A", kind: "52" }]));
    release();
    await t.drive();
    expect(t.h.unit("U-T").forecasts[0]).toMatchObject({ effective: "active", source: { reportDateTimeRaw: iso(T0) } });
    expect(unconfirmedHeld(t)).toEqual([["held"], "unsatisfied", "startup"]);
  });

  it("初回の空の起動で、時刻の無い取消が最初の報なら今どおり採られる（version.ts の初報）", async () => {
    const t = await setup();
    const series = "20991231000902";
    t.bodies.set("first", xml(vtse41({ eventId: series, at: iso(T0 - MINUTE), infoType: "取消", control: "" })));
    await t.startup([cancelHead("first", series)]);
    expect([t.h.unit("U-T").forecasts.map((item) => item.effective), t.progress()?.state]).toEqual([["cancelled"], "recovered"]);
  });
});

describe("P3-REC-T15 acceptance (r1): notices and the save ack", () => {
  it("an already-notified live warning of another series does not hide the recovered raise (H27)", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("newB", () => new Promise((done) => { release = () => done(xml(report("20991231000202", T0 - MINUTE, [{ code: "312", name: "B", kind: "51" }]))); }));
    void t.startup([head("newB", "20991231000202", T0 - MINUTE)]);
    await t.drive();
    await t.live(report("20991231000201", T0, [{ code: "311", name: "A", kind: "52" }]));
    release();
    await t.drive();
    expect(t.h.unit("U-T").intents.filter((item) => item.payload.recovered === true).map((item) => [item.subject, item.payload.level]))
      .toEqual([["normal/VTSE41/20991231000202", "warning"], ["normal/VTSE41/20991231000202", "warning"]]);
  });

  it("a save ack alone does not re-base a candidate over RES-08 (no generationConflict)", async () => {
    let ack!: () => void;
    const gate = new Promise<void>((done) => { ack = done; });
    const files = new MemoryFiles();
    files.syncDirectory = async () => { await park(gate); };
    const t = await setup(files);
    await t.live(report("20991231000300", T0 - MINUTE, [{ code: "311", name: "live", kind: "51" }]));
    let release!: () => void;
    const padded = (eventId: string) => report(eventId, T0 - MINUTE, [{ code: "312", name: "rest", kind: "62" }])
      .replace("<Body", `<!--${"x".repeat(6 * 1024 * 1024)}--><Body`);
    t.bodies.set("big1", () => new Promise((done) => { release = () => done(xml(padded("20991231000301"))); }));
    t.bodies.set("big2", xml(padded("20991231000302")));
    t.bodies.set("big3", xml(padded("20991231000303")));
    void t.startup([head("big1", "20991231000301", T0 - MINUTE), head("big2", "20991231000302", T0 - MINUTE), head("big3", "20991231000303", T0 - MINUTE)]);
    await t.drive();
    const before = t.h.unit("U-T");
    ack();
    await t.drive();
    expect([t.h.unit("U-T").forecasts, t.h.unit("U-T").persistence.currentGeneration]).toEqual([before.forecasts, before.persistence.currentGeneration]);
    release();
    await t.drive();
    expect(t.progress()?.state).toBe("recovered");
    expect(t.h.unit("U-T").persistence.savedGeneration).toBe(before.persistence.currentGeneration);
  });
});

describe("P3-REC-T13・T06 (r1): the first start after the startup list, and a hole left after the resolve", () => {
  it("the first start after a startup recovery that listed before it starts one more recovery from the boundary − 60 s; running from the request", async () => {
    const t = await setup();
    t.bodies.set("s1", xml(report("20991231000401", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    await t.startup([head("s1", "20991231000401", T0 - MINUTE)]);
    expect(t.progress()?.state).toBe("recovered");
    t.h.root.recordConnected(t.now.wallTimeMs);
    t.h.root.tick(t.now);
    expect([t.progress()?.state, t.walks.length]).toEqual(["running", 0]);
    t.advance(60_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect(t.walks.map((plan) => plan[0].fetchFromMs)).toEqual([T0 - 2 * MINUTE]);
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: t.sequence, clock: t.now });
    t.h.root.recordConnected(t.now.wallTimeMs);
    t.advance(60_000);
    t.h.root.tick(t.now);
    await t.drive();
    // 2 回目の start は通常の再接続のきっかけ（最初の接続の分は 1 回だけ）。
    expect(t.walks).toHaveLength(2);
  });

  it("a live input refused while the candidate is built leaves a hole after the resolve: no coverage", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("c1", () => new Promise((done) => { release = () => done(xml(report("20991231000402", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }]))); }));
    void t.startup([head("c1", "20991231000402", T0 - MINUTE)]);
    await t.drive();
    const sequence = t.next();
    t.h.root.checkpoint.boundaries.refused(envelope(t.h.root.state.runId, "VTSE41", `input-${sequence}`,
      Buffer.from(report("20991231000403", T0, [{ code: "311", name: "a", kind: "62" }])), t.now, sequence).payload.item, "verified");
    release();
    await t.drive();
    expect([t.whole("U-T"), t.h.root.checkpoint.boundaries.hasHole("U-T")]).toEqual(["startup", true]);
  });
});

describe("P3-REC-T06 contractBoundary: holes and the boundary (AC02, AC19)", () => {
  it("a refused input starts a recovery that resolves its hole; a hole opened during it is promoted; recovery inputs are not in the list", async () => {
    const t = await setup();
    await t.startup([]);
    const boundaries = t.h.root.checkpoint.boundaries;
    const item = (sequence: number) => envelope(t.h.root.state.runId, "VTSE41", `input-${sequence}`,
      Buffer.from(report("20991231000061", T0, [{ code: "311", name: "a", kind: "62" }])), t.now, sequence).payload.item;
    const queued = item(t.next());
    boundaries.queued(queued, "verified");
    boundaries.completed(queued.inputSequence);
    t.advance(1_000);
    const refused = item(t.next());
    boundaries.refused(refused, "verified");
    t.h.root.recoveryRefused("VTSE41");
    expect(boundaries.boundary("U-T")).toMatchObject({ receivedAt: { wallTimeMs: queued.receivedAt }, oldestHole: "refused" });
    let release!: () => void;
    t.listed = (plan) => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [head("d1", "20991231000062", T0 + MINUTE)] }));
    t.bodies.set("d1", () => new Promise((done) => { release = () => done(xml(report("20991231000062", T0 + MINUTE, [{ code: "311", name: "a", kind: "62" }]))); }));
    // 終わりから 60 秒は起こさない（P3-REC-D-COALESCE=A）。
    t.h.root.tick(t.now);
    await t.drive();
    expect(t.walks).toHaveLength(0);
    t.advance(60_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect(t.walks).toHaveLength(1);
    // 取り直しの間に開いた穴（2 件目の断った入力）は、採用の後に最古の穴へ繰り上がる（最初の穴は解ける）。
    const later = item(t.next());
    boundaries.refused(later, "verified");
    release();
    await t.drive();
    expect(t.progress()?.state).toBe("recovered");
    expect(boundaries.boundary("U-T")).toMatchObject({ receivedAt: { wallTimeMs: refused.receivedAt }, oldestHole: "refused" });
  });

  it("without a disconnect the adopted recovery resolves the hole to the newest list item", async () => {
    const t = await setup();
    await t.startup([]);
    const boundaries = t.h.root.checkpoint.boundaries;
    const item = (sequence: number) => envelope(t.h.root.state.runId, "VTSE41", `input-${sequence}`,
      Buffer.from(report("20991231000063", T0, [{ code: "311", name: "a", kind: "62" }])), t.now, sequence).payload.item;
    boundaries.refused(item(t.next()), "verified");
    t.h.root.recoveryRefused("VTSE41");
    t.listed = (plan) => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [head("x1", "20991231000064", T0 + 2 * MINUTE)] }));
    t.bodies.set("x1", xml(report("20991231000064", T0 + 2 * MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    t.advance(60_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect(boundaries.boundary("U-T")).toEqual({ receivedAt: null, dmdataTime: T0 + 2 * MINUTE, dmdataId: "x1", oldestHole: null });
  });
});

describe("P3-REC-T13 acceptance: one recovery and its redo (AC02, AC03, P3-REC-D-COALESCE)", () => {
  it("a reconnect during a recovery only marks a redo, run once after 60 s; a stopped owner's unit is ownerStopped", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("m1", () => new Promise((done) => { release = () => done(xml(report("20991231000071", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }]))); }));
    void t.startup([head("m1", "20991231000071", T0 - MINUTE)]);
    await t.drive();
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: t.sequence, clock: t.now });
    t.h.root.recordConnected(t.now.wallTimeMs);
    t.h.root.recoveryRefused("VTSE41");
    release();
    await t.drive();
    expect([t.walks.length, t.whole("U-T")]).toEqual([0, "disconnected"]);
    t.advance(59_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect(t.walks).toHaveLength(0);
    t.advance(1_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect([t.walks.length, t.whole("U-T"), t.progress()?.state]).toEqual([1, null, "recovered"]);
    // 停止した owner の unit は範囲から外れて ownerStopped。
    t.h.root.ownerFailed("urgent", new Error("stopped"));
    t.h.root.recoveryRefused("VTSE41");
    t.advance(60_000);
    t.h.root.tick(t.now);
    await t.drive();
    expect([t.walks.length, t.progress()]).toEqual([1, { unit: "U-T", state: "unsatisfied", reason: "ownerStopped" }]);
  });
});

describe("P3-REC-T17 acceptance: freshness starts a recovery (AC13 (4), AC02 (7))", () => {
  it("an empty U-T whose startup recovery failed walks the startup range when a freshness suspicion starts it", async () => {
    const t = await setup();
    await t.startup([head("f0", "20991231000081", T0 - MINUTE)]); // 本文が取れず fetchFailed
    expect(t.progress()?.state).toBe("unsatisfied");
    t.h.root.watchFreshness(["telegram.earthquake"]);
    const ledger = t.h.root["freshness"]!.ledger;
    ledger.compare("telegram.earthquake", [head("A", "20991231000082", T0 + MINUTE)], t.h.root.state.confirmation.epoch, t.now.monotonicMs, t.now.monotonicMs);
    for (let tick = 0; tick < 3; tick += 1) { t.advance(60_000); t.h.root.tick(t.now); }
    await t.drive();
    expect(t.walks).toHaveLength(1);
    // 起点は A の受信時刻 − 60 秒ではなく、まだ覆っていない起動の範囲（7 日）。
    expect(t.walks[0][0].fetchFromMs).toBe(walkStart(null, "empty", T0).fetchFromMs);
  });
});

describe("P3-REC-T18 acceptance: the U-E confirmation (AC09 (4), P3-REC-D-EEW-CONFIRM=B)", () => {
  it("10 minutes after the start frame U-E normal and training are confirmed once; a cut within the 10 minutes gives none", async () => {
    const t = await setup();
    t.h.root.watchEewWindow();
    t.h.root.recordConnected(t.now.wallTimeMs);
    t.advance(10 * MINUTE - 1);
    t.h.root.tick(t.now);
    expect(t.whole("U-E")).toBe("startup");
    t.advance(1);
    t.h.root.tick(t.now);
    expect([t.whole("U-E"), t.whole("U-E", "training"), t.whole("U-E", "test")]).toEqual([null, null, "startup"]);
    const cut = await setup();
    cut.h.root.watchEewWindow();
    cut.h.root.recordConnected(cut.now.wallTimeMs);
    cut.advance(5 * MINUTE);
    cut.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: 0, clock: cut.now });
    cut.advance(5 * MINUTE);
    cut.h.root.tick(cut.now);
    expect(cut.whole("U-E")).toBe("disconnected");
  });
});

describe("P3-REC-T20 contractBoundary: the order of the candidate requests (AC05, AC07)", () => {
  it("open→opened, adopt only after every body is done; a body after discard is dropped with a WARN; stop sends no adopt", async () => {
    const t = await setup();
    t.bodies.set("o1", xml(report("20991231000091", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }])));
    await t.startup([head("o1", "20991231000091", T0 - MINUTE)]);
    const sent = t.h.sent.filter(({ request }) => request.kind === "recovery" || request.kind === "input")
      .map(({ request }) => request.kind === "recovery" ? request.phase : "input");
    expect(sent).toEqual(["open", "input", "adopt"]);
    expect(t.recoveryReplies().map((reply) => reply.result.kind)).toEqual(["opened", "adopted"]);
    // 候補の無い owner への取り直しの本文は適用せずに WARN だけ（discard の後に mailbox に残った本文）。
    const stray = envelope(t.h.root.state.runId, "VTSE41", "input-900", Buffer.from(report("20991231000092", T0, [{ code: "311", name: "a", kind: "62" }])), t.now, 900);
    await submit(t.h, { ...stray, payload: { kind: "parser", item: { ...stray.payload.item, origin: "recovery" } } });
    expect(t.h.unit("U-T").forecasts.map((item) => item.eventId)).toEqual(["20991231000091"]);
    expect(await t.warnings()).toContainEqual(["recoveryBaseMissing", undefined]);
    // 停止の開始の後は adopt を送らない。
    const s = await setup();
    let release!: () => void;
    s.bodies.set("s1", () => new Promise((done) => { release = () => done(xml(report("20991231000093", T0 - MINUTE, [{ code: "311", name: "a", kind: "62" }]))); }));
    void s.startup([head("s1", "20991231000093", T0 - MINUTE)]);
    await s.drive();
    const stopping = s.h.root.shutdownRuntime(0, s.now);
    release();
    await s.drive();
    expect(s.h.sent.some(({ request }) => request.kind === "recovery" && request.phase === "adopt")).toBe(false);
    await s.drive();
    void stopping.catch(() => {});
  });
});

describe("P3-REC-T10 contractBoundary: the REST body lane and its slots (AC03 (2)(8)(11), RES-01)", () => {
  it("two 8 MiB bodies sit outside the live limits: a live EEW is accepted and taken first, a REST VTSE41 never blocks a live VTSE41", () => {
    const mailbox = new Mailbox();
    const at = { wallTimeMs: T0, monotonicMs: 0 };
    const sized = (inputId: string, headType: string, origin: "live" | "recovery", bytes = 16): MailboxEnvelope => {
      // mailbox は encodedByteLength で数える（本文の bytes は小さいままにする）。
      const base = envelope("run", headType, inputId, Buffer.from("<Report/>"), at, Number(inputId.slice(6)));
      return { ...base, priorityReason: headType === "VXSE43" ? "eewCandidate" : headType === "VTSE41" ? "tsunamiCandidate" : "normal",
        payload: { kind: "parser", item: { ...base.payload.item, origin, encodedByteLength: bytes, headTest: { kind: "provided", value: false },
          envelopeStatus: { kind: "provided", value: "normal" } } } };
    };
    for (const id of ["input-1", "input-2"]) expect(mailbox.enqueue(sized(id, "VTSE41", "recovery", 8 * 1024 * 1024)).kind).toBe("accepted");
    expect(mailbox.enqueue(sized("input-3", "VTSE41", "recovery")).kind).toBe("rejected");
    // 本文の枠は live の上限（16 MiB）に入れない。live の 14 MiB と EEW は受け付け、pendingItems にも数えない。
    expect(mailbox.enqueue(sized("input-4", "VPWW54", "live", 13 * 1024 * 1024)).kind).toBe("accepted");
    expect(mailbox.enqueue(sized("input-5", "VXSE43", "live")).kind).toBe("accepted");
    expect(mailbox.enqueue(sized("input-6", "VTSE41", "live")).kind).toBe("accepted");
    expect(mailbox.stats(0).pendingItems).toBe(3);
    // 処理中の REST の本文も数えない（overload の後の再接続が本文を待たない、AC03 (8)）。
    const rest = new Mailbox();
    rest.enqueue(sized("input-7", "VTSE41", "recovery"));
    expect([rest.takeNext(0)?.messageId, rest.stats(0).inFlightItems, rest.stats(0).pendingItems]).toEqual(["input-7", 0, 0]);
    const eew = mailbox.takeNext(0)!;
    expect(eew.messageId).toBe("input-5");
    expect(mailbox.takeNext(0)?.messageId).toBe("input-4");
    // EEW が終わると、先に入った REST の VTSE41 より live の VTSE41 が先に出る。
    const { item } = eew.payload;
    mailbox.complete({ kind: "parser", messageId: eew.messageId, runId: eew.runId, encodedByteLength: item.encodedByteLength, startedMonotonicMs: 0,
      completedMonotonicMs: 1, inputId: item.inputId, inputSequence: item.inputSequence });
    expect(mailbox.takeNext(1)?.messageId).toBe("input-6");
  });

  it("failures before the mailbox return the slot every time; a stop during a fetch returns it; an owner stop after inputDone returns it once", async () => {
    const t = await setup();
    t.bodies.set("w1", { kind: "failed" }); // content-type の違う本文（fetchBody が failed にする）
    await t.startup([head("w1", "20991231000101", T0 - MINUTE)]);
    for (const id of ["w2", "w3"]) {
      t.listed = (plan) => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [head(id, "20991231000102", T0)] }));
      t.bodies.set(id, id === "w2" ? { kind: "lost" } : xml(report("20991231000102", T0, [{ code: "311", name: "a", kind: "62" }])));
      t.h.root.recoveryRefused("VTSE41");
      t.advance(60_000);
      t.h.root.tick(t.now);
      await t.drive();
    }
    expect([t.fetched, t.progress()?.state, t.h.root["slotsHeld"]]).toEqual([["w1", "w2", "w3"], "recovered", 0]);
    // owner の停止は本文の終わりの出来事。枠は 1 回だけ返り、遅れた返信は何も返さない。
    t.listed = (plan) => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [head("w4", "20991231000103", T0)] }));
    t.bodies.set("w4", xml(report("20991231000103", T0, [{ code: "311", name: "a", kind: "62" }])));
    t.h.pause();
    t.h.root.recoveryRefused("VTSE41");
    t.advance(60_000);
    t.h.root.tick(t.now);
    for (let turn = 0; turn < 10; turn += 1) { t.h.flush(); await new Promise((done) => setTimeout(done, 0)); }
    t.h.root.ownerFailed("urgent", new Error("stopped"));
    t.h.flush();
    await t.drive();
    expect([t.h.root["slotsHeld"], t.progress()]).toEqual([0, { unit: "U-T", state: "unsatisfied", reason: "ownerStopped" }]);
    // 本文の取得の最中の停止: host の停止の signal で取得が lost に終わり、枠が返る。
    const s = await setup();
    let abort!: () => void;
    s.bodies.set("z1", () => new Promise((done) => { abort = () => done({ kind: "lost" }); }));
    void s.startup([head("z1", "20991231000104", T0)]);
    await s.drive();
    expect(s.h.root["slotsHeld"]).toBe(1);
    const stopping = s.h.root.shutdownRuntime(0, s.now);
    abort();
    await s.drive();
    expect(s.h.root["slotsHeld"]).toBe(0);
    void stopping.catch(() => {});
  });
});
