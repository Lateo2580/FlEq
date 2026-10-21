import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { TyphoonUnitState, TyphoonUnitStep } from "../../contracts/p3-typhoon-unit.types";
import contract from "../../contracts/p3-typhoon-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { reduceTyphoonUnit, toTyphoonView, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { clock, decodeFixture, emptyState, receive } from "./typhoon-fixture";

const recordOf = (state: TyphoonUnitState, subject: string) => [...state.analysis, ...state.probability].find((item) => item.subject === subject);
const pendingOf = (state: TyphoonUnitState, subject: string) => state.intents.filter((item) => item.subject === subject && item.disposition === "pending");
// decision の形（sequences.json の decision 欄と同じ）。
const shape = (made: TyphoonUnitStep["decisions"][number]) => ({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
  ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) });
// sequences.json の effective の語彙（active・inactive の原因）。
function effectiveOf(record: ReturnType<typeof recordOf>) {
  if (record == null) return { kind: "inactive", cause: { kind: "expired" } };
  if (record.effective === "active") return { kind: "active" };
  const cause = record.effective === "cancelled" ? "cancelled" : record.effective === "zero" ? "noActiveItems" : record.endCause === "terminal" ? "released" : "expired";
  return { kind: "inactive", cause: { kind: cause } };
}
// 解析の終わりが確率も終わらせる step の subject ごとの decision（解析=revisionOnly、確率=semantic）。
const PER_SUBJECT: Readonly<Record<string, readonly { kind: string; change: string }[]>> = { "expected:O02:59": [{ kind: "changed", change: "revisionOnly" }, { kind: "changed", change: "semantic" }] };
const ANALYSIS = "normal/typhoonAnalysis/TC2001", PROBABILITY = "normal/typhoonProbability/TC2606";

describe("P3-UNIT-Y-001 U-Y corpus history", () => {
  // corpusHistory: expectedDecisions の 22 step と制御 step（O01:112・120、O02:18・57、O07:71・73・74・76〜79・81・82、O10:91・93・94・96〜98）、
  // 取消の採用の O01:123〜127（Control/DateTime を発表より後にした合成の取消、P3-VM-AC03）、E13（AC10）。
  it("P3-C14-T10 corpusHistory / AC10: the 22 expected steps, the control steps and the E13 population", () => {
    const o01 = replay("O01", 112, 127);
    // :113 の発表は analysisAppear（Number が空なので「熱帯低気圧（TC2001）」）。:114 の訂正は correction。
    expect(o01[1].intents.map((item) => [item.channel, item.transition, item.payload.level, item.payload.title, item.payload.body.startsWith("熱帯低気圧（TC2001） ")]))
      .toEqual([["desktop", "activated", "normal", "台風解析・予報情報", true], ["sound", "activated", "normal", "台風解析・予報情報", true]]);
    expect(o01[2].intents.map((item) => [item.transition, item.payload.title, item.payload.body.startsWith("訂正: ")])).toEqual([
      ["updated", "[訂正] 台風解析・予報情報", true], ["updated", "[訂正] 台風解析・予報情報", true]]);
    expect(recordOf(o01[7].state, ANALYSIS)).toMatchObject({ effective: "active", source: { serialRaw: "4" } });
    // :125 の取消は cancel で鳴り、:124 の pending を全部置き換える。:126 の古い報は stale で復活させず、:127 の続報で active に戻る。
    expect(o01[13].intents.map((item) => [item.transition, item.payload.level, item.payload.body])).toEqual([
      ["cancelled", "cancel", "この情報は取り消されました"], ["cancelled", "cancel", "この情報は取り消されました"]]);
    expect(pendingOf(o01[13].state, ANALYSIS).map((item) => item.transition)).toEqual(["cancelled", "cancelled"]);
    expect(recordOf(o01[14].state, ANALYSIS)?.effective).toBe("cancelled");
    expect(o01[14].state.analysis).toBe(o01[13].state.analysis);
    expect(recordOf(o01[15].state, ANALYSIS)).toMatchObject({ effective: "active", source: { serialRaw: "4" } });

    const o02 = replay("O02", 18, 22);
    expect(recordOf(o02[1].state, PROBABILITY)).toMatchObject({ effective: "active", maxFiveDay: 100, slotCount: 40 });
    expect(o02[1].state.probability[0].effective === "active" ? o02[1].state.probability[0].areas : []).toHaveLength(273);
    expect(o02[1].intents.map((item) => item.payload.body)).toEqual(["台風第6号（JANGMI） 最大 100%（奄美地方/北部）", "台風第6号（JANGMI） 最大 100%（奄美地方/北部）"]);
    // :20 は見える記録からの zero（info 1 回）、:21 の連続ゼロは通知 0、:22 は地域の無い報の拒否で state は同じ参照。
    expect(o02[2].intents.map((item) => [item.payload.level, item.transition])).toEqual([["info", "released"], ["info", "released"]]);
    expect(recordOf(o02[3].state, PROBABILITY)?.effective).toBe("zero");
    expect(o02[3].intents).toEqual([]);
    expect(o02[4].state.probability).toBe(o02[3].state.probability);

    const lowering = replay("O02", 57, 60);
    // :59 の低気圧化: 解析は terminal の記憶、確率は terminal で ended（無音・一回の参照交換）。decisions は解析と確率の 2 subject。
    expect(lowering[2].decisions.map((item) => [item.subject, item.decision === "changed" ? item.change : null, item.decision === "changed" ? item.currentEstablished != null : null])).toEqual([
      ["normal/typhoonAnalysis/TC2606", "revisionOnly", true], [PROBABILITY, "semantic", false]]);
    expect(recordOf(lowering[2].state, PROBABILITY)).toMatchObject({ effective: "ended", endCause: "terminal" });
    expect(recordOf(lowering[2].state, "normal/typhoonAnalysis/TC2606")).toMatchObject({ effective: "ended", endCause: "terminal" });
    expect(lowering[2].intents).toEqual([]);
    expect(lowering[2].outcomes).toMatchObject([{ kind: "accepted", subjects: [{ subject: "normal/typhoonAnalysis/TC2606" }, { subject: PROBABILITY }] }]);
    expect(pendingOf(lowering[2].state, PROBABILITY)).toEqual([]);
    // :60 の確率の報は記憶だけ（ended terminal、source をこの報へ進める）。
    expect(recordOf(lowering[3].state, PROBABILITY)).toMatchObject({ effective: "ended", endCause: "terminal", source: { serialRaw: "47" } });
    expect(toTyphoonView(lowering[3].state).probability).toEqual([]);

    const o07 = replay("O07", 71, 83);
    // :75 は復元した記録との差で決まる訂正。:78 の到来で ended（無音）、期限は復元で延びない。
    expect(o07[4].intents.map((item) => item.transition)).toEqual(["updated", "updated"]);
    expect(pendingOf(o07[4].state, ANALYSIS).map((item) => item.id)).not.toEqual(pendingOf(o07[1].state, ANALYSIS).map((item) => item.id));
    expect(recordOf(o07[5].state, ANALYSIS)).toMatchObject({ effective: "active", activeUntil: Date.parse("2020-09-29T03:50:00+09:00") });
    expect(recordOf(o07[6].state, ANALYSIS)).toMatchObject({ effective: "active" });
    expect(recordOf(o07[7].state, ANALYSIS)).toMatchObject({ effective: "ended", endCause: "expired" });
    expect(o07[7].decisions).toMatchObject([{ decision: "changed", change: "semantic" }]);
    expect(o07[7].intents).toEqual([]);
    // :83 は復元直後の確率の取消で、:80 の pending を両 channel とも置き換える。
    expect(o07[12].intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);

    const o10 = replay("O10", 91, 98);
    // 保存故障中も :95 の全ゼロの報を採り、current を g1 へ巻き戻さない。回復後の保存に zero の記録と info の intent が入る。
    expect(recordOf(o10[4].state, PROBABILITY)?.effective).toBe("zero");
    expect(o10[4].intents.map((item) => item.payload.level)).toEqual(["info", "info"]);
    expect(recordOf(o10[7].state, PROBABILITY)).toMatchObject({ effective: "zero", retainUntil: Date.parse("2026-06-07T15:55:00+09:00") });

    // E13: fixtureIds の全 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-Y に無い。取消 2 本は記憶だけの取消、
    // 拒否は地域の重複する synthetic_VPTA50_duplicate_area と地域の無い synthetic_VPTA50_TC2606_noarea の 2 本。
    const rejected: string[] = [];
    let cancelled = 0;
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceTyphoonUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      if (step.decisions.some((item) => item.decision === "rejected")) rejected.push(id);
      else if ([...step.state.analysis, ...step.state.probability].some((item) => item.effective === "cancelled")) cancelled++;
    }
    expect(rejected.sort()).toEqual(["test__fixtures__synthetic_VPTA50_TC2606_noarea", "test__fixtures__typhoon-probability-card__synthetic_VPTA50_duplicate_area"]);
    expect([contract.contract.fixtureIds.length, cancelled]).toEqual([17, 2]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
// injectFailure の後の save は書けなかったものとして、直前に保存できた世代（g1）を残す。
function replay(sequenceId: string, from: number, to: number): TyphoonUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state: TyphoonUnitState = emptyState();
  let savedPayload: JsonValue | null = null, savedGeneration = 0, failing = false;
  const steps: TyphoonUnitStep[] = [];
  const idleStep = (at: number) => reduceTyphoonUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save" || step.action === "injectFailure" || step.action === "recover") {
      if (step.action !== "save") failing = step.action === "injectFailure";
      if (step.action === "save" && !failing) {
        savedPayload = JSON.parse(JSON.stringify(typhoonUnitCodec.encode(state))) as JsonValue;
        savedGeneration = state.persistence.currentGeneration;
      }
      steps.push({ ...idleStep(step.evaluatedAt), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : typhoonUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      // restoreOwner と同じく、復元した世代から続ける（intent の id の世代が重ならない）。
      const seeded: TyphoonUnitState = { ...emptyState(), persistence: { kind: "saved", currentGeneration: savedGeneration,
        savedGeneration, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
      const next = restored?.kind === "restored" ? reduceTyphoonUnit(seeded, { kind: "restore",
        persisted: typhoonUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt, step.evaluatedAt) }) : null;
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      if (next == null) { savedPayload = null; failing = false; }
      steps.push(next ?? idleStep(step.evaluatedAt));
      continue;
    }
    if (step.action === "advanceClock") {
      const result = idleStep(step.evaluatedAt);
      steps.push(result);
      if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
      state = result.state;
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = reduceTyphoonUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!, step.receivedAt!));
    steps.push(result);
    // 1 入力が複数 subject を変える step（P3-C14-TERMINAL）は subject ごとの decision を持つ（sequences.json の decision 欄はその射影＝最後の subject）。
    const wanted = PER_SUBJECT[step.expectedRef] ?? expected.subjects.map(() => expected.decision);
    expect(result.decisions.map((item) => item.subject), label).toEqual(expected.subjects.map((item) => item.subject));
    expect(result.decisions.length, label).toBe(wanted.length);
    expect(shape(result.decisions.at(-1)!), label).toEqual(expected.decision);
    result.decisions.forEach((made, index) => { if (expected.decision != null) expect(shape(made), `${label} ${made.subject}`).toEqual(wanted[index]); });
    for (const [index, subject] of expected.subjects.entries()) {
      const made = result.decisions[index];
      const found = recordOf(result.state, subject.subject);
      // stale の報の revision は報自身のもので、保存した記録には入らない。終わらせた確率の記録は自分の版を持つ。
      if (!(made.decision === "unchanged" && made.reason === "stale") && made.decision !== "rejected")
        expect({ reportDateTimeRaw: found?.source.reportDateTimeRaw, serialRaw: found?.source.serialRaw, infoTypeRaw: found?.source.infoTypeRaw }, `${label} ${subject.subject}`).toEqual(subject.revision);
      if (expected.effective != null) expect(effectiveOf(found), `${label} ${subject.subject}`).toEqual(expected.effective);
    }
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
