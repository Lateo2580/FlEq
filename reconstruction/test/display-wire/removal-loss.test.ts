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

// P4-REMOVAL-LOSS-001 発注 1 の試験（P4-RL-T04 (c)(d)・T05 (a)(c)(d)・T06・T07・T10）。保存と診断は手元の memory に置き、作者の設定と disk を読まない。

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
  return { h, wires, send, move, get at() { return at; } };
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
describe("P4-RL-T04 contractBoundary: removals ride the display changes into the new projection (order 1)", () => {
  it("(c) a subject that leaves and comes back in the same publication is not listed", async () => {
    const [step] = eews(1), current = step.state.current[0];
    const first = await wire({ eew: step.state }, [eewChange(null, current)], null);
    const again = await wire({ eew: step.state }, [eewChange(current, null), eewChange(null, current)], first.state);
    expect(again.state.removals).toEqual({});
  });

  it("(d) an unknown removal reaches the list through an owner reply and through the shutdown finalization", async () => {
    // owner の返信: 期限の要求の deadlineDone が消した EEW。
    const live = await boot();
    await live.send(VXSE43);
    const eventKey = lastWire(live.wires).current.eew.wire.cards[0].ref.id;
    live.h.root.tick(live.move(10 * MINUTE));
    await live.h.settle();
    expect(lastWire(live.wires).removals["U-E"]).toEqual({ items: [{ unit: "U-E", operation: "normal", at: live.at.wallTimeMs, ref: { id: eventKey }, reason: "unknown" }],
      omitted: 0 });
    // 停止の確定: finalizeDone の差分は次の公開の新しい射影にだけ渡る。
    const stop = await boot();
    await stop.send(VXSE43);
    const stopAt = stop.move(10 * MINUTE);
    await stop.h.root.shutdownRuntime(0, stopAt);
    await stop.h.settle();
    expect(lastWire(stop.wires).removals["U-E"]?.items.map((item) => [item.ref.id, item.reason])).toEqual([[eventKey, "unknown"]]);
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
