import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { VolcanoUnitState, VolcanoUnitStep } from "../../contracts/p3-volcano-unit.types";
import contract from "../../contracts/p3-volcano-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { reduceVolcanoUnit, toVolcanoView, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { clock, decodeFixture, emptyState, receive } from "./volcano-fixture";

type Kept = VolcanoUnitState["alerts" | "eruptions" | "ashfalls" | "scheduledAshfalls" | "bulletins"][number];
const recordOf = (state: VolcanoUnitState, subject: string): Kept | undefined => [...state.alerts, ...state.eruptions, ...state.ashfalls,
  ...state.scheduledAshfalls, ...state.bulletins].find((item) => item.subject === subject);

describe("P3-UNIT-V-001 U-V corpus history", () => {
  // corpusHistory: expectedDecisions の 36 step と制御 step、E13（AC11）。
  it("P3-C9-T09 corpusHistory / AC11: the 36 expected steps, O07:8-13, O08:9-10, O10:3-10 and the E13 population", () => {
    const o01 = replay("O01", 15, 40);
    // :18 の訂正は同じ subject・channel の :16 の pending を置き換え、critical の「[訂正] 噴火速報」。
    expect(o01[3].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["critical", "[訂正] 噴火速報"],
      ["critical", "[訂正] 噴火速報"]]);
    expect(o01[3].state.intents.slice(0, 2).map((item) => item.disposition)).toEqual(["superseded", "superseded"]);
    // :17 は同じ版の食い違い（WARN）。:27 は浅間山の噴火の記録が 2 件、:28 は 143900_306 だけを取り消す。
    expect(o01[2].diagnostics).toMatchObject([{ level: "WARN", reason: "volcanoRevisionConflict" }]);
    expect(o01[12].state.eruptions.map((item) => [item.subject, item.effective])).toEqual([
      ["normal/volcano:eruption/20200522144900_306", "active"], ["normal/volcano:eruption/20200522143900_306", "active"]]);
    expect(o01[13].state.eruptions.map((item) => item.effective)).toEqual(["active", "cancelled"]);
    expect(o01[12].intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
    // :29・:30 は継続で区分の code 13 が同じなので info、:31 の火山コードの無い取消は 306 だけを取り消し 315 を変えない。
    expect(o01[14].intents.map((item) => item.payload.level)).toEqual(["info", "info"]);
    expect(o01[15].intents.map((item) => item.payload.level)).toEqual(["info", "info"]);
    expect(o01[16].state.alerts.map((item) => [item.subject, item.effective])).toEqual([["normal/volcano:alert/306", "cancelled"],
      ["normal/volcano:alert/315", "active"]]);
    expect(o01[16].state.eruptions).toBe(o01[15].state.eruptions);
    // :37 の訂正は normal（降灰予報（詳細））、:38 の取消は桜島 506 の降灰を取り消す。
    expect(o01[22].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["normal", "[訂正] 降灰予報（詳細）"],
      ["normal", "[訂正] 降灰予報（詳細）"]]);
    expect(o01[23].intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    replay("O01", 56, 60);
    replay("O02", 36, 37);
    const o07 = replay("O07", 6, 14);
    // :9 の復元は intent を作らず火山 312 を名前から推測しない。:13 の復元の後も取消の記憶が残る。
    expect(o07[3].intents).toEqual([]);
    expect(recordOf(o07[3].state, "normal/volcano:eruption/20140927120000_312")).toMatchObject({ volcanoCode: "312", effective: "active" });
    expect(recordOf(o07[7].state, "normal/volcano:eruption/20140927120000_312")).toMatchObject({ volcanoCode: "312", effective: "cancelled" });
    const o08 = replay("O08", 7, 10);
    // :9（7,999 ms）は flush しない、:10（8,000 ms）で batch の通知を 1 件。
    expect([o08[2].state.batch?.subjects, o08[2].intents]).toEqual([["normal/VFVO53/506"], []]);
    expect([o08[3].state.batch, o08[3].intents.map((item) => [item.subject, item.payload.level, item.payload.body])]).toEqual([null,
      [["normal/VFVO53/batch", "info", "桜島 / 降灰予報（定時） / 小さな噴石の落下"], ["normal/VFVO53/batch", "info", "桜島 / 降灰予報（定時） / 小さな噴石の落下"]]]);
    const o10 = replay("O10", 1, 10);
    // :7 は g1（:3 の保存）を読み直し、:9 の再投入で取消を再確立する。
    expect(recordOf(o10[6].state, "normal/volcano:eruption/20140927120000_312")?.effective).toBe("active");
    expect(recordOf(o10[8].state, "normal/volcano:eruption/20140927120000_312")?.effective).toBe("cancelled");

    const rejected: string[] = [];
    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-V に無い。
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceVolcanoUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toVolcanoView(after).admission), id).toEqual([]);
      rejected.push(...step.decisions.filter((item) => item.decision === "rejected").map(() => id));
    }
    // 空の state では火山コードの無い警報・降灰の取消だけが結び付く記録を持たず identityMissing（P3-C9-CANCEL-SCOPE=A の (3)）。
    expect(rejected).toEqual(["test__fixtures__synthetic_VFVO50_cancel", "test__fixtures__synthetic_VFVO55_cancel"]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
// injectFailure の後の save は書けなかったものとして、直前に保存できた世代（g1）を残す。
function replay(sequenceId: string, from: number, to: number): VolcanoUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state = emptyState();
  let savedPayload: JsonValue | null = null, failing = false;
  const steps: VolcanoUnitStep[] = [];
  const idleStep = (at: number) => reduceVolcanoUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save" || step.action === "injectFailure" || step.action === "recover") {
      // ENOSPC の注入から容量の回復まで、保存は書けない（直前に保存できた世代を残す）。
      if (step.action !== "save") failing = step.action === "injectFailure";
      if (step.action === "save" && !failing) savedPayload = JSON.parse(JSON.stringify(volcanoUnitCodec.encode(state))) as JsonValue;
      steps.push({ ...idleStep(step.evaluatedAt), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : volcanoUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      const next = restored?.kind === "restored" ? reduceVolcanoUnit(emptyState(), { kind: "restore",
        persisted: volcanoUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt, step.evaluatedAt) }) : null;
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      if (next == null) { savedPayload = null; failing = false; }
      steps.push(next ?? idleStep(step.evaluatedAt));
      continue;
    }
    if (step.action === "advanceClock") {
      const result = idleStep(step.evaluatedAt);
      steps.push(result);
      state = result.state;
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = reduceVolcanoUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!, step.receivedAt!));
    steps.push(result);
    const made = result.decisions[0];
    if (expected.decision != null) expect({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
      ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) }, label).toEqual(expected.decision);
    expect(result.decisions.map((item) => item.subject), label).toEqual(expect.arrayContaining(expected.subjects.map((item) => item.subject)));
    for (const subject of expected.subjects) {
      // stale の報の revision は報自身のもので、保存した記録には入らない。
      if (made.decision === "rejected" || made.decision === "unchanged" && made.reason === "stale") break;
      const found = recordOf(result.state, subject.subject);
      expect(found, `${label} ${subject.subject}`).toBeDefined();
      const source = found?.source;
      expect({ reportDateTimeRaw: source?.reportDateTimeRaw, serialRaw: source?.serialRaw === "" ? null : source?.serialRaw,
        infoTypeRaw: source?.infoTypeRaw }, `${label} ${subject.subject}`).toEqual(subject.revision);
    }
    if (expected.effective != null) {
      const found = recordOf(result.state, expected.subjects[0].subject);
      expect(found!.effective === "active" ? { kind: "active" } : { kind: "inactive", cause: { kind: found!.effective } }, label)
        .toEqual(expected.effective);
    }
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
