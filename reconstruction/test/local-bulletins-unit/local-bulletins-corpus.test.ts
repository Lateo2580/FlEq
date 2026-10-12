import { describe, expect, it } from "vitest";

import type { LocalBulletinsUnitState, LocalBulletinsUnitStep } from "../../contracts/p3-local-bulletins-unit.types";
import contract from "../../contracts/p3-local-bulletins-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { reduceLocalBulletinsUnit, toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { clock, decodeFixture, emptyState, receive } from "./local-bulletins-fixture";

const recordOf = (state: LocalBulletinsUnitState, subject: string) => [...state.tornado, ...state.heat, ...state.transient].find((item) => item.subject === subject);
const pendingOf = (state: LocalBulletinsUnitState, subject: string) => state.intents.filter((item) => item.subject === subject && item.disposition === "pending");
const TOKYO = "normal/tornado/気象庁本庁/東京都竜巻注意情報";

describe("P3-UNIT-M-001 U-M corpus history", () => {
  // corpusHistory: expectedDecisions の 21 step と制御 step（O01:97・103・108、O02:55、O08:1・3・6・22・25・26・28・30）、E13（AC10）。
  it("P3-C13-T10 corpusHistory / AC10: the 21 expected steps, the control steps and the E13 population", () => {
    const o01 = replay("O01", 97, 111);
    // :98 の対の先着は sighted の通知 1 件（desktop＋sound）。:99 の後着は通知も撤回も無く、areas だけ置き換わる。
    expect(o01[1].intents.map((item) => [item.channel, item.transition, item.payload.level, item.payload.title, item.payload.body])).toEqual([
      ["desktop", "activated", "warning", "東京都竜巻注意情報", "目撃情報あり / 発表中 53地域 / 有効期限 14:30"],
      ["sound", "activated", "warning", "東京都竜巻注意情報", "目撃情報あり / 発表中 53地域 / 有効期限 14:30"]]);
    expect(o01[2].intents).toEqual([]);
    expect(pendingOf(o01[2].state, TOKYO)).toHaveLength(2);
    expect(o01[2].diagnostics).toEqual([]);
    expect(recordOf(o01[2].state, TOKYO)).toMatchObject({ effective: "active", sighted: true, retainUntil: Date.parse("2014-02-14T01:19:00+09:00") });
    // :101 の取消は cancel で鳴り、98 の pending を全部置き換える。:102 の古い報は stale。
    expect(o01[4].intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body])).toEqual([
      ["cancelled", "cancel", "[取消] 東京都竜巻注意情報", "この情報は取り消されました"], ["cancelled", "cancel", "[取消] 東京都竜巻注意情報", "この情報は取り消されました"]]);
    expect(recordOf(o01[4].state, TOKYO)?.effective).toBe("cancelled");
    expect(o01[5].state).toBe(o01[4].state);
    expect(o01[7].intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
    expect(o01[9].intents.map((item) => [item.transition, item.payload.title])).toEqual([
      ["cancelled", "[取消] 梅雨の時期に関する関東甲信地方気象情報"], ["cancelled", "[取消] 梅雨の時期に関する関東甲信地方気象情報"]]);
    // :111 はevidence（保存世代を進めない移行）の後の再採用で、記憶からの activated。
    expect(o01[14].intents.map((item) => item.transition)).toEqual(["activated", "activated"]);

    replay("O02", 46, 46);
    const o02 = replay("O02", 55, 56);
    expect(o02[1].state).toBe(o02[0].state);

    const heat = replay("O08", 1, 6);
    expect(recordOf(heat[1].state, "normal/VPFT50/JPTC240001")).toMatchObject({ effective: "active", activeUntil: 1723388400000, targetDate: "2024-08-11",
      areaName: "埼玉県", retainUntil: Date.parse("2024-08-14T05:00:00+09:00") });
    expect(heat[1].intents.map((item) => item.payload.body)).toEqual(["埼玉県 8月11日", "埼玉県 8月11日"]);
    // :4 の対象日の終わりで無音に ended（changed/semantic）、:5 の逆行は同じ参照、:6 で記憶も除く。
    expect(heat[3].decisions).toMatchObject([{ decision: "changed", change: "semantic" }]);
    expect(heat[3].intents).toEqual([]);
    expect(toLocalBulletinsView(heat[3].state).heat).toEqual([]);
    expect(heat[4].state).toBe(heat[3].state);
    expect([heat[5].state.heat, heat[5].nextDeadline]).toEqual([[], null]);

    const release = replay("O08", 22, 25);
    expect(release[2].intents.map((item) => [item.transition, item.payload.level, item.payload.body])).toEqual([
      ["released", "info", "竜巻注意情報は解除されました"], ["released", "info", "竜巻注意情報は解除されました"]]);
    expect(recordOf(release[2].state, TOKYO)?.effective).toBe("ended");
    expect(release[3].state.tornado).toEqual([]);

    const nagasaki = replay("O08", 26, 30);
    expect(nagasaki[1].intents.map((item) => item.payload.body)).toEqual(["発表中 24地域 / 有効期限 10:30", "発表中 24地域 / 有効期限 10:30"]);
    expect(nagasaki[2].decisions).toEqual([]);
    expect(nagasaki[3].decisions).toMatchObject([{ decision: "changed", change: "semantic" }]);
    expect(nagasaki[4].state.tornado).toEqual([]);

    // E13: fixtureIds の全 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-M に無い。取消 7 本は記憶だけの取消、
    // 拒否は Head の無い synthetic__vpfj51_no_head と竜巻の Item の無い synthetic_VPHW50_tokyo_empty の 2 本。
    const rejected: string[] = [];
    let cancelled = 0;
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceLocalBulletinsUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toLocalBulletinsView(after).admission), id).toEqual([]);
      if (step.decisions.some((item) => item.decision === "rejected")) rejected.push(id);
      else if ([...step.state.tornado, ...step.state.heat, ...step.state.transient].some((item) => item.effective === "cancelled")) cancelled++;
    }
    expect(rejected.sort()).toEqual(["test__fixtures__synthetic_VPHW50_tokyo_empty", "test__fixtures__synthetic__vpfj51_no_head"]);
    expect([contract.contract.fixtureIds.length, cancelled]).toEqual([53, 7]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。restart は codec を通さない（空の状態で始める）。
function replay(sequenceId: string, from: number, to: number): LocalBulletinsUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state: LocalBulletinsUnitState = emptyState();
  const steps: LocalBulletinsUnitStep[] = [];
  const idleStep = (at: number) => reduceLocalBulletinsUnit(state, { kind: "deadline", clock: clock(at, at) });
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "restart") {
      state = emptyState();
      steps.push(idleStep(step.evaluatedAt));
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
    state = reduceLocalBulletinsUnit(state, { kind: "deadline", clock: clock(step.receivedAt!, step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!, step.receivedAt!));
    steps.push(result);
    const made = result.decisions[0];
    if (expected.decision != null) expect({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
      ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) }, label).toEqual(expected.decision);
    expect(result.decisions.map((item) => item.subject), label).toEqual(expected.subjects.map((item) => item.subject));
    const found = recordOf(result.state, expected.subjects[0]?.subject ?? "");
    // stale の報の revision は報自身のもので、保存した記録には入らない。
    if (!(made.decision === "unchanged" && made.reason === "stale") && made.decision !== "rejected")
      for (const subject of expected.subjects)
        expect({ reportDateTimeRaw: found?.source.reportDateTimeRaw, serialRaw: found?.source.serialRaw, infoTypeRaw: found?.source.infoTypeRaw },
          `${label} ${subject.subject}`).toEqual(subject.revision);
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
