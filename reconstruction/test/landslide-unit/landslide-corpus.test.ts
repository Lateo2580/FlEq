import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { LandslideUnitState, LandslideUnitStep } from "../../contracts/p3-landslide-unit.types";
import contract from "../../contracts/p3-landslide-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { landslideUnitCodec, reduceLandslideUnit, toLandslideView } from "../../src/units/landslide/landslide-unit";
import { clock, decodeFixture, emptyState, receive } from "./landslide-fixture";

// sequences.json の effective の語彙（解除は released）。
const EFFECTIVE = { ended: "released", cancelled: "cancelled" } as const;

describe("P3-UNIT-L-001 U-L corpus history", () => {
  // corpusHistory: expectedDecisions の 10 step と制御 step、E13（AC09）。
  it("P3-C10-T08 corpusHistory / AC09: the 10 expected steps, O01:80, O03:25, O07:45-53 and the E13 population", () => {
    const o01 = replay("O01", 80, 85);
    // :82 の訂正は :81 の pending（同じ subject・channel）を置き換え、:83 の取消は :82 の pending を両 channel とも置き換える。
    expect(o01[2].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["normal", "[訂正] 宗谷地方土砂災害警報・注意報"],
      ["normal", "[訂正] 宗谷地方土砂災害警報・注意報"]]);
    expect(o01[2].state.intents.slice(0, 2).map((item) => item.disposition)).toEqual(["superseded", "superseded"]);
    expect(o01[3].state.intents.filter((item) => item.disposition === "pending").map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect(o01[1].intents.map((item) => item.payload.level)).toEqual(["warning", "warning"]);
    const o03 = replay("O03", 25, 26);
    expect([toLandslideView(o03[1].state).currents, o03[1].intents.map((item) => item.payload.level)]).toEqual([[], ["normal", "normal"]]);
    const o07 = replay("O07", 45, 53);
    // :48 の復元は intent を作らず、:49 の訂正は復元した :46 の pending を置き換える。:52 の復元の後も取消の記憶が残る。
    expect(o07[3].intents).toEqual([]);
    expect(o07[4].state.intents.filter((item) => item.disposition === "superseded").map((item) => item.channel)).toEqual(["desktop", "sound"]);
    expect(o07[7].state.currents.map((item) => item.effective)).toEqual(["cancelled"]);

    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-L に無い。
    const rejected: string[] = [];
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceLandslideUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toLandslideView(after).admission), id).toEqual([]);
      rejected.push(...step.decisions.filter((item) => item.decision === "rejected").map(() => id));
    }
    expect(rejected).toEqual([]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): LandslideUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state: LandslideUnitState = emptyState();
  let savedPayload: JsonValue | null = null, savedGeneration = 0;
  const steps: LandslideUnitStep[] = [];
  const idleStep = (at: number) => reduceLandslideUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      savedPayload = JSON.parse(JSON.stringify(landslideUnitCodec.encode(state))) as JsonValue;
      savedGeneration = state.persistence.currentGeneration;
      steps.push({ ...idleStep(step.evaluatedAt), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : landslideUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      // restoreOwner と同じく、復元した世代（envelope.generation）から続ける（intent の id の世代が重ならない）。
      const seeded: LandslideUnitState = { ...emptyState(), persistence: { kind: "saved", currentGeneration: savedGeneration,
        savedGeneration, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
      const next = restored?.kind === "restored" ? reduceLandslideUnit(seeded, { kind: "restore",
        persisted: landslideUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt, step.evaluatedAt) }) : null;
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      if (next == null) savedPayload = null;
      steps.push(next ?? idleStep(step.evaluatedAt));
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = reduceLandslideUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
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
        expect({ reportDateTimeRaw: found?.source.reportDateTimeRaw, serialRaw: found?.source.serialRaw === "" ? null : found?.source.serialRaw,
          infoTypeRaw: found?.source.infoTypeRaw }, `${label} ${subject.subject}`).toEqual(subject.revision);
    if (expected.effective != null) expect(found!.effective === "active" ? { kind: "active" }
      : { kind: "inactive", cause: { kind: EFFECTIVE[found!.effective] } }, label).toEqual(expected.effective);
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
