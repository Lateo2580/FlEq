import { describe, expect, it } from "vitest";

import { ac15Intervals, checkpointWindows, fingerprintTable, judgeAc15 } from "./ac15.mjs";
import type { ProbeRow } from "./ac15.mjs";
import type { HostRecord } from "./aux-measures.mjs";

type Unit = "U-E" | "U-W" | "U-F";
// 保存 payload の形だけを写した合成 envelope と、full view を持つ合成 snapshot（key 集合が指紋表の材料）。
// intents は U-W と U-F の payload に同名で出る（U-W は空）ので、その要素は ambiguous。
const intent = { id: "i", unit: "U-F", subject: "s", channel: "desktop" };
const envelope = (unit: Unit, payload: Record<string, unknown>) =>
  ({ schemaVersion: "p2-checkpoint-v1", unit, generation: 1, capturedAt: 0, payload, sha256: "0".repeat(64) });
const domain = (unit: Unit, view: Record<string, unknown>) => ({ unit, contentRevision: "1", items: [], delivery: "full", view });
const table = fingerprintTable([
  envelope("U-E", { schemaVersion: "e", intents: [], deliveryRecords: [{ intentId: "i", disposition: "delivered", expiresAt: 0 }] }),
  envelope("U-W", { schemaVersion: "w", national: {}, partials: [{ subject: "s", operation: "normal", scope: "partial", office: "o", source: {}, phenomena: {} }], intents: [] }),
  envelope("U-F", { schemaVersion: "f", subjects: [{ subject: "s", operation: "normal", periods: [], retainUntil: 0 }], gates: [], intents: [intent] }),
], { streamId: "x", sequence: 1, current: { eew: domain("U-E", { current: [{ eventId: "e", serial: 1, prediction: {} }] }),
  weatherCurrent: domain("U-W", { partials: [] }), weatherTimeseries: domain("U-F", { subjects: [] }) } });

const obs = (o: Record<string, unknown>): HostRecord => ({ t: "obs", o });
const t0 = (inputId: string, monotonicMs: number) => obs({ kind: "marker", point: "T0", runId: "r", inputId, monotonicMs });
const publish = obs({ kind: "publishSerialization", displayVersion: {}, bytes: 10, durationMs: 0.1 });
// 1 回の保存 = encode → 未計測の decode（gap）→ write → verify。inputIds はその保存を起こした入力。
const save = (unit: Unit, attemptId: string, inputIds: string[], encodeAt: number, writeAt: number) =>
  ([["encode", encodeAt, encodeAt + 1], ["write", writeAt, writeAt + 0.3], ["verify", writeAt + 0.5, writeAt + 1.5]] as const).map(([stage, from, to]) =>
    obs({ kind: "checkpoint", measurement: { runId: "r", inputIds, unit, generation: 1, attemptId, stage, startedMonotonicMs: from, endedMonotonicMs: to,
      bytes: 0, outcome: "succeeded", retryReason: "notRetry" } }));
// EEW・U-W・U-F を 1 件ずつ。EEW の区間に U-W の持ち越し保存が 2 回: w2 と、encode 後の await の間に次の T0 が入る w4
// （gap は T0=100 で切れる）。U-W・U-F の区間に自 unit の保存（w1・f1）。
const host = [t0("input-1", 0), ...save("U-W", "w2", [], 10, 12), ...save("U-W", "w4", [], 95, 103.9),
  publish, t0("input-2", 100), ...save("U-W", "w1", ["input-2"], 101, 103.5), publish,
  t0("input-3", 200), ...save("U-F", "f1", ["input-3"], 201, 203), publish];
const intervals = ac15Intervals(host, new Map<string, Unit>([["input-1", "U-E"], ["input-2", "U-W"], ["input-3", "U-F"]]));
// 各区間に envelope 1・配送 snapshot 1・checkpoint 区間の外の自 unit の要素 1（入力の subject の before/after にあたる）。
const baseline: ProbeRow[] = [[0, "eventId,serial,prediction"], [100, "subject,operation,scope,office,source,phenomena"],
  [200, "[subject,operation,periods,retainUntil"]].flatMap(([at, own]): ProbeRow[] => [[Number(at) + 1.5, 0.1, 500, "schemaVersion,unit,generation,capturedAt,payload,sha256"],
    [Number(at) + 50, 0.1, 20, "streamId,sequence,current"], [Number(at) + 60, 0.1, 80, String(own)]]);
const judged = (rows: ProbeRow[], records = host) => judgeAc15([...baseline, ...rows].sort((a, b) => a[0] - b[0]), intervals, table,
  { checkpointWindows: checkpointWindows(records), minInputsPerUnit: 1 });
const brief = (rows: ProbeRow[]) => judged(rows).violations.map((v) => [v.inputId, v.category, v.fingerprintUnit, v.count]);

describe("P2-A10-T04 AC15 upstream full serialization per input (key-set fingerprint)", () => {
  it("one UnitState-whole or RuntimeState-whole stringify in any input interval is Fail; the saved payload inside its checkpoint is not", () => {
    // 並びが違っても同じ key 集合（実行中 U-F = payload の key ＋ contentRevision/persistence）。
    const whole: ProbeRow = [210, 3, 90_000, "persistence,subjects,gates,intents,schemaVersion,contentRevision"];
    const runtime: ProbeRow = [60, 3, 90_000, "runId,units,restoration,confirmation,views,admission,shutdown"];
    const payloadInEncode: ProbeRow = [201.5, 3, 90_000, "schemaVersion,subjects,gates,intents"];
    expect(judged([payloadInEncode]).status).toBe("Pass");
    const result = judged([whole, runtime, payloadInEncode]);
    expect(result.status).toBe("Fail");
    expect(result.violations).toEqual([
      { inputId: "input-1", inputUnit: "U-E", category: "runtimeState", fingerprintUnit: null,
        fingerprint: "admission,confirmation,restoration,runId,shutdown,units,views", count: 1, retryAttemptsNearby: [] },
      { inputId: "input-3", inputUnit: "U-F", category: "unitState", fingerprintUnit: "U-F",
        fingerprint: "contentRevision,gates,intents,persistence,schemaVersion,subjects", count: 1, retryAttemptsNearby: [] }]);
  });

  it("scan set: a U-F element in the EEW interval or own elements over the limit in the EEW interval are Fail, over the limit in the U-F interval is 未確認; own elements, those inside its checkpoint and shared-field intents are neither", () => {
    const fElement = (at: number): ProbeRow => [at, 0.2, 300, "[subject,operation,periods,retainUntil"];
    const eewView = (at: number): ProbeRow => [at, 0.1, 80, "eventId,serial,prediction"];
    const sharedIntent: ProbeRow = [3, 0.1, 80, "id,unit,subject,channel"];
    const savedSubjects = Array.from({ length: 9 }, (_, k) => fElement(201 + k / 10)); // U-F の encode 区間の中（codec の全 subject 計量）
    expect(judged([fElement(210), eewView(4), sharedIntent, ...savedSubjects]).status).toBe("Pass");
    expect(brief([fElement(3), eewView(110)])).toEqual([["input-1", "foreignElement", "U-F", 1], ["input-2", "foreignElement", "U-E", 1]]);
    // EEW は入力規則の上で退去 0 なので Fail。U-F は副作用の退去を観測できないので未確認。
    const eewExcess = judged(Array.from({ length: 9 }, (_, k) => eewView(10 + k)));
    expect(eewExcess.status).toBe("Fail");
    expect(eewExcess.violations).toMatchObject([{ inputId: "input-1", category: "ownElementExcess", limit: 4, count: 10, excess: 6,
      byFingerprint: { "eventId,prediction,serial": 10 } }]);
    const fExcess = judged(Array.from({ length: 9 }, (_, k) => fElement(210 + k)));
    expect([fExcess.status, fExcess.violations]).toEqual(["未確認", []]);
    expect(fExcess.unconfirmed).toMatchObject([{ inputId: "input-3", category: "ownElementExcess", count: 10, excess: 6 }]);
  });

  it("a saved payload outside its unit's checkpoint windows, or a save caused by another unit's input even when it slips to the next interval, is Fail; a carried-over save is not", () => {
    const wPayload = (at: number): ProbeRow => [at, 1, 5_000, "schemaVersion,national,partials,intents"];
    // 自 unit の encode・未計測区間（decode）・verify の中と、EEW 区間の持ち越し保存（w2、w4 の T0 より前の gap）の中は checkpoint 経路。
    expect(judged([wPayload(101.5), wPayload(103), wPayload(104.5), wPayload(11), wPayload(97)]).status).toBe("Pass");
    // w4 の gap は T0=100 で切れるので 100.5 は区間外。
    expect(brief([wPayload(3), wPayload(100.5), wPayload(150)])).toEqual([["input-1", "foreignPayload", "U-W", 1],
      ["input-2", "payloadOutsideCheckpoint", "U-W", 2]]);
    // E10: EEW の入力（input-1）が起こした U-W の保存は、EEW の区間の中（w3）でも、次の U-W の区間へずれても（w5）Fail。
    const caused = [...host, ...save("U-W", "w3", ["input-1"], 20, 22), ...save("U-W", "w5", ["input-1"], 150, 152)];
    expect(judged([wPayload(20.5), wPayload(150.5)], caused).violations.map((v) => [v.inputId, v.category, v.fingerprintUnit, v.attemptId]))
      .toEqual([["input-1", "foreignSaveByInput", "U-W", "w3"], ["input-1", "foreignSaveByInput", "U-W", "w5"]]);
  });
});
