import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { BriefingUnitState, BriefingUnitStep } from "../../contracts/p3-briefing-unit.types";
import contract from "../../contracts/p3-briefing-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { briefingUnitCodec, reduceBriefingUnit, toBriefingView } from "../../src/units/briefing/briefing-unit";
import { clock, decodeFixture, emptyState, receive } from "./briefing-fixture";

const recordOf = (state: BriefingUnitState, subject: string) => state.currents.find((item) => item.subject === subject);
const pendingOf = (state: BriefingUnitState, subject: string) => state.intents.filter((item) => item.subject === subject && item.disposition === "pending");

describe("P3-UNIT-B-001 U-B corpus history", () => {
  // corpusHistory: expectedDecisions の 22 step と制御 step、E13（AC09）。
  it("P3-C12-T09 corpusHistory / AC09: the 22 expected steps, the restart/save/advanceClock steps and the E13 population", () => {
    const KJPTK = "normal/VPBS50/KJPTK202608221709", JPTK = "normal/VPOA50/JPTK202608221709", JPTC = "normal/VPOA50/JPTC202608221709";
    const o01 = replay("O01", 89, 96);
    // :94 の訂正は事実が同じでも鳴り（[訂正]・「訂正: 」）、:95 の取消は cancel で鳴り、その subject の pending を全部置き換える。
    expect(o01[5].intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")])).toEqual([
      ["updated", "warning", "[訂正] 東京都気象防災速報（記録的短時間大雨）", true], ["updated", "warning", "[訂正] 東京都気象防災速報（記録的短時間大雨）", true]]);
    expect(o01[6].intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body])).toEqual([
      ["cancelled", "cancel", "[取消] 東京都気象防災速報（記録的短時間大雨）", "この情報は取り消されました"],
      ["cancelled", "cancel", "[取消] 東京都気象防災速報（記録的短時間大雨）", "この情報は取り消されました"]]);
    expect(pendingOf(o01[6].state, KJPTK).map((item) => item.transition)).toEqual(["cancelled", "cancelled"]);
    expect(recordOf(o01[6].state, KJPTK)?.retainUntil).toBe(Date.parse("2026-08-22T20:27:00+09:00"));

    replay("O02", 44, 44);

    const o03 = replay("O03", 15, 24);
    // :16 の held は相関の窓（受理の時刻＋60 秒）を持ち、view に載らない。
    expect(recordOf(o03[1].state, JPTK)).toMatchObject({ effective: "held", holdUntil: 1787386200001 });
    expect(toBriefingView(o03[1].state).currents).toEqual([]);
    // :17 の取消の記憶は :18〜:21 の後も同じ値で残る（cancelled の VPOA50 は alias にしない、P3-C12-ALIAS=A）。
    const memory = recordOf(o03[2].state, JPTK);
    expect(memory).toMatchObject({ effective: "cancelled", source: { serialRaw: "2", infoTypeRaw: "取消" },
      retainUntil: Date.parse("2026-08-22T20:09:00+09:00") });
    for (const index of [3, 4, 5, 6]) expect(recordOf(o03[index].state, JPTK), String(index)).toEqual(memory);
    // :18 の accepted は KJPTK だけ。:21 の VPOA50 の取消は KJPTK を変えない。
    expect(o03[3].outcomes).toMatchObject([{ kind: "accepted", subjects: [{ subject: KJPTK }] }]);
    expect(o03[3].outcomes[0].subjects).toHaveLength(1);
    expect(recordOf(o03[6].state, KJPTK)).toBe(recordOf(o03[5].state, KJPTK));
    // :24 の発生で予測の能登が除かれて YJPNB は replaced、その pending は superseded。accepted は 2 subject。
    const YJPNB = "normal/VPBS50/YJPNB202608270448";
    expect(recordOf(o03[9].state, YJPNB)).toMatchObject({ effective: "replaced", retainUntil: Date.parse("2026-08-27T07:48:00+09:00") });
    expect(pendingOf(o03[9].state, YJPNB)).toEqual([]);
    expect(o03[9].outcomes[0].kind === "accepted" && o03[9].outcomes[0].subjects.map((item) => [item.subject, item.transition])).toEqual([
      ["normal/VPBS50/HJPNB202608270308", "active"], [YJPNB, "replaced"]]);

    const o07 = replay("O07", 64, 70);
    expect(recordOf(o07[2].state, JPTC)).toMatchObject({ effective: "held", holdUntil: 1787386200002 });
    // :68 の復元で held の JPTC を無音で released にし、:65 の pending は元の時刻で戻る。保存世代を進める。
    expect(recordOf(o07[4].state, JPTC)?.effective).toBe("released");
    expect(o07[4].displayChanges.map((item) => item.subject).sort()).toEqual([KJPTK, JPTC].sort());
    expect(pendingOf(o07[4].state, KJPTK).map((item) => [item.createdAt, item.expiresAt])).toEqual(
      pendingOf(o07[1].state, KJPTK).map((item) => [item.createdAt, item.expiresAt]));
    expect(o07[4].state.persistence.currentGeneration).toBe(o07[3].state.persistence.currentGeneration + 1);
    // :69 は復元した記録との差で updated、JPTC は変わらない。:70 の取消は KJPTK・JPTC を変えない。
    expect(o07[5].intents.map((item) => item.transition)).toEqual(["updated", "updated"]);
    expect(recordOf(o07[6].state, KJPTK)).toBe(recordOf(o07[5].state, KJPTK));
    expect(recordOf(o07[6].state, JPTC)).toBe(recordOf(o07[5].state, JPTC));

    const o08 = replay("O08", 14, 21);
    expect(recordOf(o08[1].state, JPTK)).toMatchObject({ effective: "held", holdUntil: 1787386200001 });
    expect(recordOf(o08[5].state, JPTC)).toMatchObject({ effective: "held", holdUntil: 1787386200002 });
    // :16・:18 の逆行は同じ参照、:17 の到来で release（「対応電文未確認」）、:20 は窓から 60 秒以後なので無音、:21 で 2 件とも回収。
    expect(o08[2].state).toBe(o08[1].state);
    expect(o08[3].intents.map((item) => [item.channel, item.transition, item.payload.level, item.payload.title])).toEqual([
      ["desktop", "activated", "warning", "東京都記録的短時間大雨情報（対応電文未確認）"], ["sound", "activated", "warning", "東京都記録的短時間大雨情報（対応電文未確認）"]]);
    expect(toBriefingView(o08[3].state).currents.map((item) => item.subject)).toEqual([JPTK]);
    expect(o08[4].state).toBe(o08[3].state);
    expect([recordOf(o08[6].state, JPTC)?.effective, o08[6].intents]).toEqual(["released", []]);
    expect([o08[7].state.currents, o08[7].state.intents, o08[7].intents, o08[7].nextDeadline]).toEqual([[], [], [], null]);

    // E13: fixtureIds の全 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-B に無い。
    const rejected: string[] = [];
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceBriefingUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toBriefingView(after).admission), id).toEqual([]);
      rejected.push(...step.decisions.filter((item) => item.decision === "rejected").map(() => id));
    }
    expect(rejected).toEqual([]);
  });
});

// sequences.json の effective の語彙（VPBS50・VPOA50 の取消は cancelled、期限で除かれた記録は expired。held・released・aliased・
// replaced は expectations の checks で照らし、effective は null）。
const EFFECTIVE = { active: { kind: "active" }, cancelled: { kind: "inactive", cause: { kind: "cancelled" } } } as const;

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): BriefingUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state: BriefingUnitState = emptyState();
  let savedPayload: JsonValue | null = null, savedGeneration = 0;
  const steps: BriefingUnitStep[] = [];
  const idleStep = (at: number) => reduceBriefingUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      savedPayload = JSON.parse(JSON.stringify(briefingUnitCodec.encode(state))) as JsonValue;
      savedGeneration = state.persistence.currentGeneration;
      steps.push({ ...idleStep(step.evaluatedAt), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : briefingUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      // restoreOwner と同じく、復元した世代（envelope.generation）から続ける（intent の id の世代が重ならない）。
      const seeded: BriefingUnitState = { ...emptyState(), persistence: { kind: "saved", currentGeneration: savedGeneration,
        savedGeneration, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
      const next = restored?.kind === "restored" ? reduceBriefingUnit(seeded, { kind: "restore",
        persisted: briefingUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt, step.evaluatedAt) }) : null;
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      if (next == null) savedPayload = null;
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
    state = reduceBriefingUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!, step.receivedAt!));
    steps.push(result);
    const made = result.decisions[0];
    if (expected.decision != null) expect({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
      ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) }, label).toEqual(expected.decision);
    expect(result.decisions.map((item) => item.subject), label).toEqual(expected.subjects.map((item) => item.subject));
    const found = result.state.currents.find((item) => item.subject === expected.subjects[0]?.subject);
    // stale の報の revision は報自身のもので、保存した記録には入らない。
    if (!(made.decision === "unchanged" && made.reason === "stale"))
      for (const subject of expected.subjects)
        expect({ reportDateTimeRaw: found?.source.reportDateTimeRaw, serialRaw: found?.source.serialRaw, infoTypeRaw: found?.source.infoTypeRaw },
          `${label} ${subject.subject}`).toEqual(subject.revision);
    if (expected.effective != null) expect(found == null ? { kind: "inactive", cause: { kind: "expired" } }
      : found.effective === "active" || found.effective === "cancelled" ? EFFECTIVE[found.effective] : found.effective, label).toEqual(expected.effective);
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
