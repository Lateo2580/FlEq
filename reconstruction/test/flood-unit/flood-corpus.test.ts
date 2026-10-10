import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { FloodUnitState, FloodUnitStep } from "../../contracts/p3-flood-unit.types";
import contract from "../../contracts/p3-flood-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { floodUnitCodec, reduceFloodUnit, toFloodView } from "../../src/units/flood/flood-unit";
import { clock, decodeFixture, emptyState, receive } from "./flood-fixture";

// sequences.json の effective の語彙（解除は released、期限で除かれた記録は expired）。
const EFFECTIVE = { ended: "released", cancelled: "cancelled" } as const;

describe("P3-UNIT-R-001 U-R corpus history", () => {
  // corpusHistory: expectedDecisions の 18 step と制御 step、E13（AC09）。
  it("P3-C11-T08 corpusHistory / AC09: the 18 expected steps, O01:41/86, O02:23/47, O07:54/57/58/62 and the E13 population", () => {
    const o01 = replay("O01", 41, 48);
    expect(o01[1].intents.map((item) => [item.channel, item.payload.level, item.transition])).toEqual([["desktop", "warning", "activated"],
      ["sound", "warning", "activated"]]);
    // :43 の訂正は ReportDateTime が新しいので採用し、△△川と観測所 2 つが外れる。:45 の同じ版の訂正は :44 の pending を置き換える。
    expect(o01[2].intents.map((item) => [item.payload.level, item.payload.body.startsWith("訂正: ")])).toEqual([["normal", true], ["normal", true]]);
    expect(o01[2].state.currents[0]).toMatchObject({ kinds: [{ rivers: [{ name: "○○川" }] }], stations: [{ name: "○○○水位観測所" }] });
    expect(o01[4].state.intents.filter((item) => item.subject === "normal/VXKO50/123456789013").map((item) => item.disposition))
      .toEqual(["superseded", "superseded", "pending", "pending"]);
    expect(o01[5].intents.map((item) => [item.payload.title, item.payload.body])).toEqual([
      ["[取消] ○○川上流氾濫警戒情報の取消", "この情報は取り消されました"], ["[取消] ○○川上流氾濫警戒情報の取消", "この情報は取り消されました"]]);
    // 取消は 123456789012 だけで、123456789013 の active は残る。
    expect(toFloodView(o01[5].state).currents.map((item) => item.subject)).toEqual(["normal/VXKO50/123456789013"]);
    const kozagawa = replay("O01", 86, 88);
    expect(kozagawa[1].intents.map((item) => item.payload.level)).toEqual(["critical", "critical"]);
    // 欠測の点は null のまま（0 や正常に読み替えない、spec:1468）。riverCodes は ChargeSection の 1 行目「古座川」。
    expect(kozagawa[1].state.currents[0]).toMatchObject({ stations: [{ name: "相瀬", levels: [3, 2, 1, 1, null, null, null],
      riverCodes: ["3000130001"] }, { name: "月野瀬", riverCodes: ["3000130001"] }] });
    // 河川はレベル 5 のまま、月野瀬の現況の観測レベルが 4→5（P3-C11-NOTICE-LEVELS=E の critical）。
    expect(kozagawa[2].intents.map((item) => [item.payload.level, item.transition])).toEqual([["critical", "updated"], ["critical", "updated"]]);
    const unknown = replay("O02", 23, 25);
    expect(unknown[2].state.currents[0]).toMatchObject({ effective: "active", basisReportDateTimeRaw: "2019-05-27T09:00:00+09:00",
      kinds: [{ code: "30" }], source: { serialRaw: "4" } });
    replay("O02", 47, 48);
    const o07 = replay("O07", 54, 63);
    // :58 の復元は intent を作らない。:62 の期限は 123456789013 の active の期限切れの desktop を 1 件だけ作り、取消の記憶は黙って除く。
    expect(o07[4].intents).toEqual([]);
    expect(o07[8].intents.map((item) => [item.channel, item.transition, item.payload.level, item.payload.title, item.payload.body])).toEqual([
      ["desktop", "expired", "info", "[期限切れ] ○○川上流レベル３氾濫警報（継続）", "○○川上流の洪水予報は36時間続報がなく、現況を確認できません"]]);
    expect(o07[8].state.currents).toEqual([]);
    expect(o07[9].state).toBe(o07[8].state);

    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-R に無い。
    const rejected: string[] = [];
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceFloodUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toFloodView(after).admission), id).toEqual([]);
      rejected.push(...step.decisions.filter((item) => item.decision === "rejected").map(() => id));
    }
    expect(rejected).toEqual([]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): FloodUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state: FloodUnitState = emptyState();
  let savedPayload: JsonValue | null = null, savedGeneration = 0;
  const steps: FloodUnitStep[] = [];
  const idleStep = (at: number) => reduceFloodUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      savedPayload = JSON.parse(JSON.stringify(floodUnitCodec.encode(state))) as JsonValue;
      savedGeneration = state.persistence.currentGeneration;
      steps.push({ ...idleStep(step.evaluatedAt), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : floodUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      // restoreOwner と同じく、復元した世代（envelope.generation）から続ける（intent の id の世代が重ならない）。
      const seeded: FloodUnitState = { ...emptyState(), persistence: { kind: "saved", currentGeneration: savedGeneration,
        savedGeneration, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
      const next = restored?.kind === "restored" ? reduceFloodUnit(seeded, { kind: "restore",
        persisted: floodUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt, step.evaluatedAt) }) : null;
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
    state = reduceFloodUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
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
    if (expected.effective != null) expect(found == null ? { kind: "inactive", cause: { kind: "expired" } } : found.effective === "active"
      ? { kind: "active" } : { kind: "inactive", cause: { kind: EFFECTIVE[found.effective] } }, label).toEqual(expected.effective);
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
