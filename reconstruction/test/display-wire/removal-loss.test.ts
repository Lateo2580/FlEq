import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";

import type { EewCurrent } from "../../contracts/p2-eew-unit.types";
import type { ClockReading, InputBoundary, RuntimeDisplayChange, UnitId } from "../../contracts/p2-shared-runtime.types";
import type { DisplayLossWire, DisplayRemovalWire, DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { InputBoundaries, LOSS_TALLY_MAX_BYTES } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { ingestXmlData } from "../../src/ingress/ingress";
import { RECOVERABLE_UNITS } from "../../src/recovery/recovery";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { currentSubject } from "../../src/units/eew/eew-unit";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import { clock as tsunamiClock, decodeXml, receive as receiveTsunami, vtse41 } from "../tsunami-unit/tsunami-fixture";
import { baseInput, eewStep, eewXml, emptyEew, emptyTsunami, projected, quietLosses, wire } from "./display-wire-fixture";

// P4-REMOVAL-LOSS-001 の試験（発注 1: P4-RL-T04 (c)(d)・T05 (a)(c)(d)・T06・T07・T10、発注 2: T04 (a)(b)・T08）。保存と診断は手元の memory に置き、作者の設定と disk を読まない。

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

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const VXSE43 = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
const REPORT_MS = Date.parse("2024-04-17T14:14:59Z");
const MINUTE = 60_000;

// publisher と in-process の owner。start は報時刻からの ms（EEW の currentUntil は報時刻＋10 分）。
async function boot(start = 1_000) {
  let at: ClockReading = { wallTimeMs: REPORT_MS + start, monotonicMs: 1 };
  const wires: DisplayWireSnapshot[] = [];
  const h = harnessedRoot({ appName: "fleq-p4", legacyAppName: "fleq", stateDirectory: "rl-state", legacyStateDirectory: "rl-old", diagnosticDirectory: "rl-diagnostics" },
    linkedUnitCodecs, { clock: () => at, checkpointFileSystem: new MemoryFiles(), diagnosticFileSystem: new MemoryDiagnostics(),
      display: { publish: () => {}, publishWire: (snapshot) => { wires.push(snapshot); } } });
  await startHarness(h, "rl", at);
  let sequence = 0;
  const send = (xml: string) => submit(h, envelope("rl", "VXSE43", `input-${++sequence}`, Buffer.from(xml), at, sequence));
  const move = (ms: number) => { at = { wallTimeMs: at.wallTimeMs + ms, monotonicMs: at.monotonicMs + ms }; return at; };
  // wall だけを動かす（実運用の wall は Date.now() で戻りうる）。
  const shift = (ms: number) => { at = { wallTimeMs: at.wallTimeMs + ms, monotonicMs: at.monotonicMs + 1 }; return at; };
  return { h, wires, send, move, shift, get at() { return at; } };
}
const lastWire = (wires: readonly DisplayWireSnapshot[]) => wires.at(-1)!;
// 読めない VXSE43（Head の無い報は U-E が断り、H43 のカードになる）。
const unreadable = (index: number) => VXSE43.replace("<Head", "<Hd").replace("</Head>", "</Hd>").replace("20240417231454", `2024041723${String(1000 + index)}`);

function eewChange(before: EewCurrent | null, after: EewCurrent | null): RuntimeDisplayChange {
  const one = (item: EewCurrent) => ({ unit: "U-E" as const, operation: item.operation, subject: item.subject, office: null, current: item, subjects: [currentSubject(item)] });
  const value = (after ?? before)!;
  return { unit: "U-E", operation: value.operation, subject: value.subject, before: before == null ? null : one(before),
    ...(after == null ? { after: null, removal: "unknown" as const } : { after: one(after) }) };
}
const AT = "2099-01-01T09:00:00+09:00";
const eewAt = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString().replace("Z", "+00:00");
const eews = (count: number) => Array.from({ length: count }, (_, index) =>
  eewStep(emptyEew(), eewXml({ eventId: `2099010100${String(index).padStart(4, "0")}`, at: eewAt(index), areas: [["622", "5-", "5-"]] })));

// 契約境界 P4-RL-AC01（運び）。
describe("P4-RL-T04 contractBoundary: removals ride the display changes into the new projection", () => {
  it("(c) a subject that leaves and comes back in the same publication is not listed", async () => {
    const [step] = eews(1), current = step.state.current[0];
    const first = await wire({ eew: step.state }, [eewChange(null, current)], null);
    const again = await wire({ eew: step.state }, [eewChange(current, null), eewChange(null, current)], first.state);
    expect(again.state.removals).toEqual({});
  });

  // 発注 2 で U-E の期限の回収が expired を付けるので、発注 1 の (d) の unknown の期待を expired に替え、(b) を兼ねる（統合担当の許し 2026-11-22）。
  it("T04 (b) the deadline removal reaches the list as expired through an owner reply and, after the shutdown finalization, in the next publication", async () => {
    // owner の返信: 期限の要求の deadlineDone が消した EEW。
    const live = await boot();
    await live.send(VXSE43);
    const eventKey = lastWire(live.wires).current.eew.wire.cards[0].ref.id;
    live.h.root.tick(live.move(10 * MINUTE));
    await live.h.settle();
    expect(lastWire(live.wires).removals["U-E"]).toEqual({ items: [{ unit: "U-E", operation: "normal", at: live.at.wallTimeMs, ref: { id: eventKey }, reason: "expired",
      updatedAt: Date.parse("2024-04-17T14:14:59Z") }], omitted: 0 });
    // 停止の確定: finalizeDone の差分（停止の入力の期限の回収）は次の公開の新しい射影にだけ渡る。
    const stop = await boot();
    await stop.send(VXSE43);
    const stopAt = stop.move(10 * MINUTE);
    await stop.h.root.shutdownRuntime(0, stopAt);
    await stop.h.settle();
    expect(lastWire(stop.wires).removals["U-E"]?.items.map((item) => [item.ref.id, item.reason])).toEqual([[eventKey, "expired"]]);
  });

  // 前置きの期限（U-E の reclaimDeadlineBeforeReceive）で消えた EventID と、同じ入力の取消で消えた別の EventID が 1 つの inputDone の output に並ぶ。
  it("T04 (a) a reclaimed subject and a cancelled subject of one inputDone are listed as expired and cancelled", async () => {
    const t = await boot();
    const other = "20240417231700";
    const later = (xml: string, minutes: number) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${new Date(REPORT_MS + minutes * MINUTE + 9 * 3_600_000).toISOString().replace(".000Z", "+09:00")}</ReportDateTime>`)
      .replace(/(<Control>[\s\S]*?<DateTime>)[^<]*/, `$1${new Date(REPORT_MS + minutes * MINUTE).toISOString()}`).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${other}</EventID>`);
    await t.send(VXSE43);
    const first = lastWire(t.wires).current.eew.wire.cards[0].ref.id;
    t.move(2 * MINUTE);
    await t.send(later(VXSE43, 2));
    const second = lastWire(t.wires).current.eew.wire.cards.find((card) => card.ref.id !== first)!.ref.id;
    t.move(8 * MINUTE);
    const mark = t.h.delivered.length;
    await t.send(later(readFileSync("test/fixtures/37_01_03_240613_VXSE43.xml", "utf8"), 3));
    expect(t.h.delivered.slice(mark).filter(({ reply }) => reply.kind === "inputDone").map(({ reply }) => "output" in reply ? reply.output.displayChanges
      .map((change) => change.after == null ? change.removal : "shown") : [])).toEqual([["expired", "cancelled"]]);
    expect(lastWire(t.wires).removals["U-E"]?.items.map((item) => [item.ref.id, item.reason]).sort()).toEqual([[first, "expired"], [second, "cancelled"]].sort());
  });

  // 発注 2 の後、12 unit の消える所は全部が理由を付け、owner の返信・停止の確定・取り直しの採用の 3 経路では unknown を作れない（成果物に理由）。
  // unit が unknown を付けた差分が新しい射影の一覧に unknown で載ることは、射影の口で見る。
  it("(d) an unknown removal in the display changes is listed as unknown", async () => {
    const [step] = eews(1), current = step.state.current[0];
    const first = await wire({ eew: step.state }, [eewChange(null, current)], null);
    const gone = await wire({ eew: emptyEew() }, [eewChange(current, null)], first.state);
    expect(projected(gone).snapshot.removals["U-E"]?.items.map((item) => item.reason)).toEqual(["unknown"]);
  });
});

// 受入条件 P4-RL-AC05・AC07。
describe("P4-RL-T05 acceptance: H39 counts reach the new projection", () => {
  it("(a) a reply whose counts grew carries losses to the mirror and the H39 field; a reply with the same counts carries null", async () => {
    const t = await boot();
    for (let index = 0; index < 8; index++) await t.send(unreadable(index));
    // 9 枚目でカードの上限 8 を越え、最も古いカードを容量で外す（原文の予算でも外す。unreadableDropped は H39 の押し出したもの）。
    const ninth = t.h.delivered.length;
    await t.send(unreadable(8));
    const rows = t.h.root.state.mirror["U-E"].losses, dropped = rows.find((row) => row.reason === "unreadableDropped")?.count ?? 0;
    expect([rows.find((row) => row.reason === "unreadableReport")?.count, dropped > 0]).toEqual([9, true]);
    expect(t.h.delivered.slice(ninth).flatMap(({ reply }) => "output" in reply ? reply.output.units : []).find((delta) => delta.unit === "U-E" && delta.losses != null)?.losses).toEqual(rows);
    expect(lastWire(t.wires).losses["U-E"]).toMatchObject({ unreadable: 9, evicted: dropped, dropped: 0, missed: 0, outcomeUnknown: 0, rev: sha256(rows) });
    const mark = t.h.delivered.length;
    await t.send(VXSE43);
    const deltas = t.h.delivered.slice(mark).flatMap(({ reply }) => "output" in reply ? reply.output.units : []).filter((delta) => delta.unit === "U-E");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((delta) => delta.losses)).toEqual(deltas.map(() => null));
    expect(t.h.root.state.mirror["U-E"].losses).toBe(rows);
  });

  it("(c) ten minutes after an EEW cut the H39 field of U-E holds one window with the card's from and to", async () => {
    const t = await boot();
    t.h.root.watchEewWindow();
    const lastFrame = t.at.wallTimeMs;
    t.h.root.recordFrame(lastFrame);
    t.move(5 * MINUTE);
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: t.at });
    t.h.root.recordFrame(t.at.wallTimeMs);
    t.h.root.recordConnected(t.at.wallTimeMs);
    t.h.root.tick(t.at);
    await t.h.settle();
    const card = lastWire(t.wires).recovery.eewUnverified;
    expect(card).toEqual({ fromWallMs: lastFrame, toWallMs: t.at.wallTimeMs });
    expect(lastWire(t.wires).losses["U-E"].eewWindow).toEqual({ count: 0, from: null, to: null });
    t.h.root.tick(t.move(10 * MINUTE));
    await t.h.settle();
    expect(lastWire(t.wires).recovery.eewUnverified).toBeNull();
    expect(lastWire(t.wires).losses["U-E"].eewWindow).toEqual({ count: 1, from: card?.fromWallMs, to: card?.toWallMs });
  });

  // 契約境界 P4-RL-AC07 (3)（RL-RET-02）: 最後の追加＋24 時間で値を捨て、その後に wall が戻っても同じ区間を出し直さない（ヘルツの品質レビューの P2）。
  it("(c) the window value leaves at the last addition plus 24 hours and stays at zero when the wall goes back", async () => {
    const t = await boot();
    t.h.root.watchEewWindow();
    t.h.root.recordFrame(t.at.wallTimeMs);
    t.move(5 * MINUTE);
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: t.at });
    t.h.root.recordFrame(t.at.wallTimeMs);
    t.h.root.recordConnected(t.at.wallTimeMs);
    t.h.root.tick(t.at);
    await t.h.settle();
    t.h.root.tick(t.move(10 * MINUTE));
    await t.h.settle();
    const addedAt = t.at.wallTimeMs, window = (count: number) => lastWire(t.wires).losses["U-E"].eewWindow?.count === count;
    expect(window(1)).toBe(true);
    t.h.root.tick(t.shift(86_400_000 - 1));
    await t.h.settle();
    expect(window(1)).toBe(true);
    t.h.root.tick(t.shift(1));
    await t.h.settle();
    expect([t.at.wallTimeMs - addedAt, window(0)]).toEqual([86_400_000, true]);
    t.h.root.tick(t.shift(-1_000));
    await t.h.settle();
    expect(window(0)).toBe(true);
    expect(lastWire(t.wires).losses["U-E"].eewWindow).toEqual({ count: 0, from: null, to: null });
  });

  it("(d) LOSS_TALLY_MAX_BYTES keeps the value it had before the U-F word", () => {
    expect(LOSS_TALLY_MAX_BYTES).toBe(913);
  });
});

// 契約境界 P4-RL-AC06（ヘルツの返事の 1 (g) のイベント列、台帳 146）。
describe("P4-RL-T06 contractBoundary: the H39 hole reads past the confirmable mark", () => {
  it("a refusal after the mark leaves hasHole false and the H39 hole true until the next connected adoption; U-E and U-F are null", () => {
    const boundaries = new InputBoundaries(RECOVERABLE_UNITS);
    const item = (inputSequence: number) => {
      const frame = Buffer.from(JSON.stringify({ type: "data", id: `id-${inputSequence}`, format: "xml", encoding: "utf-8", compression: null,
        head: { type: "VTSE41", test: false }, body: "<Report/>" }));
      const entered = ingestXmlData({ kind: "ws", inputId: `in-${inputSequence}`, inputSequence, receivedAt: 1_000 + inputSequence, origin: "live", frame });
      if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
      return entered.item;
    };
    const position = (sequence: number): Omit<InputBoundary, "oldestHole"> => ({ receivedAt: { wallTimeMs: 1_000 + sequence, basis: "verified" }, dmdataTime: null, dmdataId: `id-${sequence}` });
    boundaries.disconnected(0);
    boundaries.recoveryStarted("U-T", 1);
    boundaries.advanceHole("U-T", position(1));
    expect([boundaries.hasHole("U-T"), boundaries.lossHole("U-T")]).toEqual([false, false]);
    boundaries.refused(item(2), "verified");
    expect([boundaries.hasHole("U-T"), boundaries.lossHole("U-T")]).toEqual([false, true]);
    boundaries.recoveryStarted("U-T", 3);
    boundaries.resolve("U-T", 3, position(3));
    expect([boundaries.hasHole("U-T"), boundaries.lossHole("U-T")]).toEqual([false, false]);
    expect([boundaries.lossHole("U-E"), boundaries.lossHole("U-F")]).toEqual([null, null]);
  });
});

// 契約境界 P4-RL-AC08。
describe("P4-RL-T07 contractBoundary: the removal list and the H39 field on the wire", () => {
  it("(a) the script's common margin stays non-negative and its byte counts match the widest typed fields", () => {
    const script: unknown = JSON.parse(execFileSync(process.execPath, ["reconstruction/contracts/p4-display-wire-max.mjs"], { encoding: "utf8" }));
    const counted = typeof script === "object" && script != null && "removalLoss" in script ? script.removalLoss : null;
    const MS = Number.MAX_SAFE_INTEGER, units: readonly UnitId[] = ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"];
    const removals: DisplayRemovalWire = Object.fromEntries(units.map((unit) => [unit, { items: Array.from({ length: 4 }, () =>
      ({ unit: "U-E" as const, operation: "training" as const, at: MS, ref: { id: "x".repeat(64) }, reason: "retentionEnded" as const, updatedAt: MS })), omitted: MS }]));
    const row = { dropped: MS, evicted: MS, missed: MS, outcomeUnknown: MS, unreadable: MS, hole: false, rev: "x".repeat(64) };
    const losses: Partial<DisplayLossWire> = Object.fromEntries(units.map((unit) => [unit, unit === "U-E" ? { ...row, eewWindow: { count: MS, from: MS, to: MS } } : row]));
    expect(counted).toMatchObject({ removals: Buffer.byteLength(JSON.stringify(removals)), losses: Buffer.byteLength(JSON.stringify(losses)) });
    expect(counted != null && typeof counted === "object" && "margin" in counted && typeof counted.margin === "number" && counted.margin >= 0).toBe(true);
  });

  it("(b)(c)(d) keeps the newest four per unit, counts the dropped one, starts empty on a new stream and keeps the objects of an unchanged step", async () => {
    const steps = eews(6), currents = steps.map((step) => step.state.current[0]);
    const forecast = receiveTsunami(emptyTsunami(), decodeXml(vtse41({ at: AT, areas: [{ code: "100", name: "区", kind: "51" }] }), "VTSE41"), tsunamiClock(Date.parse(AT) + 1000));
    const record = forecast.displayChanges[0].after;
    if (record?.unit !== "U-T" || record.current == null) throw new Error("no forecast");
    const tsunamis = Array.from({ length: 4 }, (_, index): RuntimeDisplayChange => ({ unit: "U-T", operation: "normal", subject: `normal/VTSE41/T${index}`,
      before: null, after: { ...record, subject: `normal/VTSE41/T${index}`, current: { ...record.current!, subject: `normal/VTSE41/T${index}` } } }));
    const gone = (change: RuntimeDisplayChange): RuntimeDisplayChange => ({ unit: change.unit, operation: change.operation, subject: change.subject, before: change.after,
      after: null, removal: "evicted" });
    const filled = await wire({ eew: steps[0].state, tsunami: forecast.state }, [...currents.map((item) => eewChange(null, item)), ...tsunamis], null);
    const four = await wire({ eew: steps[0].state, tsunami: forecast.state }, [...currents.slice(0, 4).map((item) => eewChange(item, null)), ...tsunamis.map(gone)], filled.state);
    const tsunamiList = projected(four).snapshot.removals["U-T"];
    expect([projected(four).snapshot.removals["U-E"]?.items.length, tsunamiList?.items.length, tsunamiList?.omitted]).toEqual([4, 4, 0]);
    const fifth = await wire({ eew: steps[0].state, tsunami: forecast.state }, [eewChange(currents[4], null)], four.state);
    const eewList = projected(fifth).snapshot.removals["U-E"]!;
    const eventIds = (list: typeof eewList) => list.items.map((item) => item.ref.id);
    const id = (item: EewCurrent) => sha256(["U-E", item.operation, item.subject]);
    expect([eventIds(eewList), eewList.omitted]).toEqual([[id(currents[4]), id(currents[3]), id(currents[2]), id(currents[1])], 1]);
    expect(projected(fifth).snapshot.removals["U-T"]).toBe(tsunamiList);
    // (d) 一覧と H39 の欄の変わらない step（EEW の追加だけ）は前の snapshot の object を使う。
    const quiet = await wire({ eew: steps[0].state, tsunami: forecast.state }, [eewChange(currents[5], null), eewChange(null, currents[5])], fifth.state);
    const added = await wire({ eew: steps[0].state, tsunami: forecast.state }, [eewChange(null, currents[0])], quiet.state);
    const before = quiet.state.snapshot!, after = projected(added).snapshot;
    expect([after.removals === before.removals, after.losses === before.losses, after.sequence > before.sequence]).toEqual([true, true, true]);
    // (c) 新しい streamId の射影は一覧を空から始める。
    const { input, old } = await baseInput();
    const other = projectDisplayWire({ projection: { ...input, streamId: "another-stream", displayChanges: [] }, views: { eew: input.eew, tsunami: input.tsunami,
      earthquake: input.earthquake, weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries, nankai: input.nankai, volcano: input.volcano,
      landslide: input.landslide, flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins, typhoon: input.typhoon },
    confirmation: input.confirmation, notices: old.notices, removalLoss: quietLosses }, added.state);
    expect(projected(other).snapshot.removals).toEqual({});
  });

  it("(e) the five classes add up the unit's rows, and part=losses opens the same rows by rev; an old rev gets versionChanged with the current rev", async () => {
    const t = await boot();
    await t.send(unreadable(0));
    const old = lastWire(t.wires);
    await t.send(unreadable(1));
    const now = lastWire(t.wires), rows = t.h.root.state.mirror["U-E"].losses;
    expect(now.losses["U-E"]).toMatchObject({ unreadable: 2, evicted: 0, rev: sha256(rows) });
    // 5 区分の分け方: 区分ごとに別の 0 でない値を置き、同じ区分の 2 つの理由（dropped と evicted）は足し合わせる。
    const mixed = [{ reason: "notificationExpired" as const, count: 1, lastAt: 0 }, { reason: "notificationCapacityEvicted" as const, count: 2, lastAt: 0 },
      { reason: "eewCapacityEvicted" as const, count: 4, lastAt: 0 }, { reason: "noticeMarkEvicted" as const, count: 8, lastAt: 0 },
      { reason: "capacityRejected" as const, count: 16, lastAt: 0 }, { reason: "notificationOutcomeUnknown" as const, count: 32, lastAt: 0 },
      { reason: "unreadableReport" as const, count: 64, lastAt: 0 }];
    const classes = await wire({}, [], null, undefined, { ...quietLosses, mirror: { ...quietLosses.mirror, "U-E": { losses: mixed } } });
    expect(projected(classes).snapshot.losses["U-E"]).toEqual({ dropped: 3, evicted: 12, missed: 16, outcomeUnknown: 32, unreadable: 64, hole: null, rev: sha256(mixed),
      eewWindow: { count: 0, from: null, to: null } });
    const opened = t.h.root.requestDetail({ streamId: now.streamId, detail: { unit: "U-E", part: "losses", revision: now.losses["U-E"].rev } });
    const stale = t.h.root.requestDetail({ streamId: now.streamId, detail: { unit: "U-E", part: "losses", revision: old.losses["U-E"].rev } });
    await t.h.settle();
    expect(await opened.response).toEqual({ kind: "ok", part: "losses", unit: "U-E", revision: now.losses["U-E"].rev, rows });
    expect(await stale.response).toEqual({ kind: "error", reason: "versionChanged", revision: now.losses["U-E"].rev });
    opened.done(); stale.done();
    // HTTP の経路は id と page の無い part=losses だけを受ける。
    const seen: unknown[] = [];
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      detail: (input) => { seen.push(input); return { response: Promise.resolve({ kind: "error", reason: "unavailable", revision: null }), done: () => {} }; } });
    const get = (path: string) => new Promise<number>((resolve, reject) => {
      const sent = httpRequest({ host: "127.0.0.1", port: server.port, path, agent: false }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on("error", reject);
      sent.end();
    });
    const rev = "a".repeat(64);
    try {
      expect(await get(`/api/display/wire/detail?streamId=s&unit=U-F&part=losses&revision=${rev}`)).toBe(503);
      expect(seen).toEqual([{ streamId: "s", detail: { unit: "U-F", part: "losses", revision: rev } }]);
      expect(await get(`/api/display/wire/detail?streamId=s&unit=U-F&part=losses&id=${rev}&revision=${rev}`)).toBe(400);
      expect(await get(`/api/display/wire/detail?streamId=s&unit=U-F&part=losses&revision=${rev}&page=0`)).toBe(400);
    } finally {
      await server.close();
    }
  });
});

// 受入条件 P4-RL-AC08 (8)。
describe("P4-RL-T10 acceptance: a notice of a record the shutdown finalization removed leaves the new path", () => {
  it("drops the eewNew notice from the new path while the old projection keeps it, and does not bring it back on the next publication", async () => {
    // 報時刻の 595 秒後に受け、currentUntil（報時刻＋10 分）が 5 秒後に来る。お知らせの寿命は 15 秒。
    const t = await boot(595_000);
    await t.send(VXSE43);
    expect(lastWire(t.wires).notices.map((notice) => notice.kind)).toEqual(["eewNew"]);
    const stopAt = t.move(6_000);
    await t.h.root.shutdownRuntime(0, stopAt);
    await t.h.settle();
    const old = t.h.root["projection"]!.notices;
    expect([old.map((notice) => notice.kind), lastWire(t.wires).notices]).toEqual([["eewNew"], []]);
    const published = t.wires.length;
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: t.move(1_000) });
    await t.h.settle();
    expect(t.h.root["projection"]!.notices.map((notice) => notice.kind)).toEqual(["eewNew"]);
    expect(t.wires.slice(published).every((snapshot) => snapshot.notices.length === 0)).toBe(true);
  });
});

// 受入条件 P4-RL-T08（P4-RL-AC04 (4)、P4-RL-D-RESTART=A）: 時計の確認待ち（awaiting）で起動した U-R の保存に、停止中に期限が来ていた見える記録 E1・起動の後に期限が来る E2・
// 起動の後に更新する E3 を入れる。時計が verified になった後の最初の回収で、E1 は expiredWhileStopped で一覧に載らず、E2 と更新した後に期限が来た E3 は expired で載る。
describe("P4-RL-T08 acceptance: a run restored while the clock is awaiting keeps records expired while stopped off the removal list", () => {
  it("lists E2 and the updated E3 as expired and leaves E1 out", async () => {
    const R0 = Date.parse("2026-01-10T00:00:00Z");
    const at = (offset: number, monotonic = offset): ClockReading => ({ wallTimeMs: R0 + offset, monotonicMs: monotonic });
    const jst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().replace(".000Z", "+09:00");
    const flood = (eventId: string, reported: number) => Buffer.from(readFileSync("test/fixtures/16_02_01_220728_VXKO50.xml", "utf8")
      .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`).replace(/(<Control>[\s\S]*?<DateTime>)[^<]*/, `$1${new Date(reported).toISOString()}`)
      .replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>${jst(reported)}`).replace(/<TargetDateTime>[^<]*/, `<TargetDateTime>${jst(reported)}`));
    const files = new MemoryFiles(), HOUR = 3_600_000, basis = { value: "verified" as const satisfies string as "verified" | "awaiting" };
    const now = { value: at(10 * HOUR + 1_000) }, wires: DisplayWireSnapshot[] = [];
    const root = () => harnessedRoot({ appName: "fleq-p4", legacyAppName: "fleq", stateDirectory: "rl-t08", legacyStateDirectory: "rl-t08-old", diagnosticDirectory: "rl-t08-d" },
      linkedUnitCodecs, { clock: () => now.value, checkpointFileSystem: files, diagnosticFileSystem: new MemoryDiagnostics(), wallBasis: () => basis.value, contentBasis: () => basis.value,
        display: { publish: () => {}, publishWire: (snapshot) => { wires.push(snapshot); } } });
    const before = root();
    await startHarness(before, "rl-t08-a", now.value);
    await submit(before, envelope("rl-t08-a", "VXKO50", "e1", flood("100000000001", R0), now.value, 1),
      envelope("rl-t08-a", "VXKO50", "e2", flood("100000000002", R0 + 10 * HOUR), now.value, 2),
      envelope("rl-t08-a", "VXKO50", "e3", flood("100000000003", R0), now.value, 3));
    await before.root.driveCheckpoint();
    await before.settle();
    await before.root.diagnostics.flush();
    // 40 時間目に awaiting で起動（E1・E3 の表示の期限 36 時間は停止中に過ぎ、E2 の 46 時間は起動の後）。
    (basis as { value: string }).value = "awaiting";
    now.value = at(40 * HOUR, 0);
    const after = root();
    await startHarness(after, "rl-t08-b", now.value);
    now.value = at(40 * HOUR + 1_000, 1_000);
    await submit(after, envelope("rl-t08-b", "VXKO50", "e3b", flood("100000000003", R0 + 5 * HOUR), now.value, 4));
    (basis as { value: string }).value = "verified";
    now.value = at(47 * HOUR, 7 * HOUR);
    after.root.mailbox.recordWorkerResponse(now.value.monotonicMs);
    after.root.tick(now.value);
    await after.settle();
    const id = (eventId: string) => sha256(["U-R", "normal", `normal/VXKO50/${eventId}`]);
    // E1・E3 は記憶の期限（表示の期限＋6 時間）も過ぎて同じ回収で消え、E2 は記憶に移る。
    expect(after.unit("U-R").currents.map((item) => [item.eventId, item.effective])).toEqual([["100000000002", "expired"]]);
    expect(lastWire(wires).removals["U-R"]?.items.map((item) => [item.ref.id, item.reason]).sort())
      .toEqual([[id("100000000002"), "expired"], [id("100000000003"), "expired"]].sort());
    await after.root.diagnostics.flush();
  });
});
