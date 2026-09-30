import { describe, expect, it } from "vitest";

import { ac15Intervals, checkpointWindows, compareRetention, fingerprintTable, judgeAc15 } from "./ac15.mjs";
import type { ProbeRow } from "./ac15.mjs";
import type { HostRecord } from "./aux-measures.mjs";

type Unit = "U-E" | "U-W" | "U-F";
// 保存 payload の形だけを写した合成 envelope と、full view を持つ合成 snapshot（key 集合が指紋表の材料）。
// intents は U-W と U-F の payload に同名で出る（U-W は空）ので、その要素は ambiguous。
const intent = { id: "i", unit: "U-F", subject: "s", channel: "desktop" };
const envelope = (unit: Unit, payload: Record<string, unknown>) =>
  ({ schemaVersion: "p2-checkpoint-v1", unit, generation: 1, capturedAt: 0, payload, sha256: "0".repeat(64) });
const domain = (unit: Unit, view: Record<string, unknown>) => ({ unit, contentRevision: "1", items: [], delivery: "full", view });
const wPartial = { subject: "s", operation: "normal", scope: "partial", office: "o", source: {}, phenomena: {} };
const tableWith = (histories: unknown[]) => fingerprintTable([
  envelope("U-E", { schemaVersion: "e", intents: [], deliveryRecords: [{ intentId: "i", disposition: "delivered", expiresAt: 0 }] }),
  envelope("U-W", { schemaVersion: "w", national: {}, partials: [wPartial], histories, intents: [] }),
  envelope("U-F", { schemaVersion: "f", subjects: [{ subject: "s", operation: "normal", periods: [], retainUntil: 0 }], gates: [], intents: [intent] }),
], { streamId: "x", sequence: 1, current: { eew: domain("U-E", { current: [{ eventId: "e", serial: 1, prediction: {} }] }),
  weatherCurrent: domain("U-W", { partials: [] }), weatherTimeseries: domain("U-F", { subjects: [] }) } });
const table = tableWith([{ subject: "s", operation: "normal", reports: [wPartial] }]);

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
  [200, "[1]subject,operation,periods,retainUntil"]].flatMap(([at, own]): ProbeRow[] => [[Number(at) + 1.5, 0.1, 500, "schemaVersion,unit,generation,capturedAt,payload,sha256"],
    [Number(at) + 50, 0.1, 20, "streamId,sequence,current"], [Number(at) + 60, 0.1, 80, String(own)]]);
const judged = (rows: ProbeRow[], records = host, t = table) => judgeAc15([...baseline, ...rows].sort((a, b) => a[0] - b[0]), intervals, t,
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
    const fElement = (at: number): ProbeRow => [at, 0.2, 300, "[1]subject,operation,periods,retainUntil"];
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

  // ヘルツ総合レビュー指摘 4: EEW の区間の state.current 相当の配列全体の直列化 1 回が、要素 1 回と数えられて Pass になった。
  it("an own-element array longer than the before/after pair is a whole-collection Fail even for the input's own unit; a pair counts as two elements; an array without its length is 未確認", () => {
    const eewArray = (prefix: string): ProbeRow => [20, 5, 1_000_000, prefix + "eventId,serial,prediction"];
    const whole = judged([eewArray("[512]")]);
    expect(whole.status).toBe("Fail");
    expect(whole.violations).toMatchObject([{ inputId: "input-1", category: "ownElementCollection", fingerprintUnit: "U-E", count: 1, maxLength: 512 }]);
    expect(judged([eewArray("[2]")]).scenarios["U-E"]?.ownElementMaxPerInput).toBe(3);
    const unknown = judged([eewArray("[")]);
    expect([unknown.status, unknown.missing]).toEqual(["未確認", ["ownElementLengthUnknown"]]);
    // 統合担当の再レビュー: unit を決められない ambiguous の形（view.subjects・intents）の配列全体も Pass にしない（未確認）。2 件までは報告だけ。
    const shared = (prefix: string, at = 20): ProbeRow => [at, 5, 1_000_000, prefix + "id,unit,subject,channel"];
    const ambiguousWhole = judged([shared("[512]")]);
    expect([ambiguousWhole.status, ambiguousWhole.missing, ambiguousWhole.unconfirmed.map((u) => u.category)]).toEqual(["未確認", ["ambiguousCollection"], ["ambiguousCollection"]]);
    expect(judged([shared("[2]"), shared("[512]", 10.5)]).status).toBe("Pass"); // 10.5 は U-W の保存 w2 の encode の中
  });

  // 統合担当の再レビュー: 指紋表を作る時点の U-W に履歴が無いと、履歴 entry の直列化が「その他」に落ちて判定されない。
  it("a fingerprint table built while U-W has no history entry is 未確認", () => {
    expect(judged([], host, tableWith([])).missing).toEqual(["fingerprintTableLacksElements:U-W.histories"]);
  });

  // 統合担当の再レビュー: 要素ごとの byte 計量が出す原始値（#string）は最上位の指紋では判定されない。予備の U-W は half 40,111・full 41,811（比 1.04）で、
  // 差 1,700 は ΔN 64 に対して保持 1 件あたり約 27 回の線形成分だった。
  it("retention control: a per-input count outside checkpoint windows that grows by more than 0.5 per retained item from half to full is Fail even under a large constant; rows inside a checkpoint window are not counted", () => {
    const retained = { full: { "U-E": 512, "U-W": 128, "U-F": 512 }, half: { "U-E": 256, "U-W": 64, "U-F": 256 } };
    const compare = (full: ProbeRow[], half: ProbeRow[]) => compareRetention(judged(full), judged(half), { maxSlope: 0.5, retained });
    const primitives = (at: number, n: number): ProbeRow[] => Array.from({ length: n }, (_, k) => [at + k / 1000, 0.01, 10, "#string"]);
    const linear = compare(primitives(110, 41_700), primitives(110, 40_000));
    expect(linear.status).toBe("Fail");
    expect(linear.rows.filter((r) => r.exceeded)).toMatchObject([{ scenario: "U-W", measure: "outsidePrimitivePerInput", fullMedian: 41_700, halfMedian: 40_000, deltaRetained: 64 }]);
    // 自 unit の要素の回数も同じ規則。
    const own = (n: number): ProbeRow[] => Array.from({ length: n }, (_, k) => [170 + k / 100, 0.01, 80, "subject,operation,scope,office,source,phenomena"]);
    expect(compare(own(64), []).rows.filter((r) => r.exceeded).map((r) => [r.scenario, r.measure])).toEqual([["U-W", "outsideOwnElementPerInput"]]);
    // U-E の差 4（ΔN は 3 unit の最小の 64 で、保持 1 件あたり 0.0625）と、U-W の保存 w1 の encode の中の 40 件は Fail にしない。
    expect(compare([...primitives(30, 8), ...primitives(101.2, 40)], primitives(30, 4)).status).toBe("Pass");
    // ヘルツ再レビュー指摘 1: 原始値の配列全体（JSON.stringify(Object.keys(state.ownership)) 相当）は要素数で数える。1 回と数えると full・half・対照が Pass だった。
    const keys = compare([[20, 0.1, 5_000, "[512]#string"]], [[20, 0.1, 2_500, "[256]#string"]]);
    expect(keys.rows.filter((r) => r.exceeded)).toMatchObject([{ scenario: "U-E", measure: "outsidePrimitivePerInput", fullMedian: 512, halfMedian: 256 }]);
    // ヘルツ再レビュー指摘 2: 傾きが閾値を超えて差が雑音の床以下なら Pass でなく未確認（full 128・256、half 64・64、ΔN 64 → 傾き 1、床 128）。
    const two = (counts: number[]) => judgeAc15(counts.flatMap((n, i) => primitives(i * 100 + 10, n)),
      counts.map((_, i) => ({ inputId: `e${i}`, unit: "U-E" as const, startMs: i * 100, endMs: i * 100 + 100, processingMs: null, publishCount: 0 })), table, { minInputsPerUnit: 1 });
    const noisy = compareRetention(two([128, 256]), two([64, 64]), { maxSlope: 0.5, retained });
    expect([noisy.status, noisy.rows.find((r) => r.measure === "outsidePrimitivePerInput")]).toMatchObject(["未確認", { slope: 1, noiseFloor: 128, exceeded: false, unresolved: true }]);
  });

  it("a saved payload outside its unit's checkpoint windows, or a save caused by another unit's input even when it slips to the next interval, is Fail; a carried-over save is not", () => {
    const wPayload = (at: number): ProbeRow => [at, 1, 5_000, "schemaVersion,national,partials,histories,intents"];
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
