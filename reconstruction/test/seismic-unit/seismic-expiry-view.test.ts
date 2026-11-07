import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { PersistedSeismicUnit, SeismicUnitState } from "../../contracts/p3-seismic-unit.types";
import { reduceSeismicUnit, seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { clock, decodeFixture, emptyState, receive, replaceTag } from "./seismic-fixture";

// P3-SEISMIC-EXPIRY-VIEW-001: 時計を確かめられない間の表示の期限切れ（AC01〜AC04、AC08 の場面）。

const HOUR = 3_600_000;
const W4 = "32-35_04_04_240613_VXSE53", W3 = "32-35_04_03_240613_VXSE52", LP = "selected_xml/78_01_01_240613_VXSE62", CANCEL = "synthetic_VXSE53_cancel";
const EVENT = "20100125161517", R = Date.parse("2010-01-25T16:19:00+09:00"), CONTROL = "2010-01-25T07:19:20Z";
const iso = (ms: number) => new Date(ms + 9 * HOUR).toISOString().replace(".000Z", "+09:00");
const at = (material: DecodedMaterial) => clock(Date.parse(material.reportDateTimeRaw) + 1_000);
const deadline = (state: SeismicUnitState, wall: number, basis: WallBasis) => reduceSeismicUnit(state, { kind: "deadline", clock: clock(wall), basis });
const take = (state: SeismicUnitState, material: DecodedMaterial, wall: number, basis: WallBasis) =>
  reduceSeismicUnit(state, { kind: "receive", material, clock: clock(wall), basis });
const stored = (state: SeismicUnitState) => ({ ...state, persistence: null, contentRevision: 0 });
const expiredIn = (outcomes: ReturnType<typeof deadline>["outcomes"]) => outcomes.flatMap((item) => "subjects" in item ? item.subjects : [])
  .filter((item) => item.transition === "expired").length;
// 長周期の報は地震の報と同じ時刻へ移す。retainUntil は R＋36 時間。
const longPeriod = () => decodeFixture(LP, replaceTag("ReportDateTime", iso(R)));
const quake = () => decodeFixture(W4);
const seeded = () => {
  const first = receive(emptyState(), quake(), at(quake())).state;
  return receive(first, longPeriod(), clock(R + 1_000)).state;
};
const event = () => receive(emptyState(), quake(), at(quake())).state;
// 同じ地震の取消。Control/DateTime を手で揃える（新旧は Control/DateTime で決まる）。
const cancel = (reportMs: number, control: string) => decodeFixture(CANCEL,
  (xml) => replaceTag("DateTime", control)(replaceTag("ReportDateTime", iso(reportMs))(replaceTag("EventID", EVENT)(xml))));
const heard = (state: SeismicUnitState): SeismicUnitState => ({ ...state, earthquakes: state.earthquakes.map((item) => ({ ...item,
  contributions: item.contributions.map((entry) => ({ ...entry, notice: { ...entry.notice!, evidence: "possible" as const } })) })) });
const FAR = R + 37 * HOUR;

describe("P3-SEISMIC-EXPIRY-VIEW-001 the display expiry of U-Q", () => {
  it("P3-SEV-T01 acceptance / AC01,AC02: unverified hides the records and keeps the facts, the guard and the day's history", () => {
    const seed = seeded(), waiting = deadline(seed, FAR, "awaiting"), step = deadline(seed, FAR, "unverified"), state = step.state;
    expect([waiting.state === seed, toSeismicView(seed).earthquakes.length, toSeismicView(seed).longPeriods.length]).toEqual([true, 1, 1]);
    const view = toSeismicView(state);
    expect([view.earthquakes, view.longPeriods, view.subjects]).toEqual([[], [], []]);
    expect(view.semanticRevision.includes(EVENT)).toBe(false);
    expect([state.earthquakes, state.longPeriods]).toEqual([seed.earthquakes.map((item) => ({ ...item, expiryPending: true })),
      seed.longPeriods.map((item) => ({ ...item, expiryPending: true }))]);
    expect([state.daily === seed.daily, view.daily.normal.recent.length, view.daily.normal.count]).toEqual([true, 1, 1]);
    expect([state.intents === seed.intents, step.intents, step.outcomes, step.displayChanges.map((item) => item.after)]).toEqual([true, [], [], [null, null]]);
    expect([state.contentRevision, step.nextDeadline, state.persistence.currentGeneration]).toEqual([seed.contentRevision + 1, waiting.nextDeadline, seed.persistence.currentGeneration + 1]);
    expect(deadline(state, FAR + 1, "unverified").state).toBe(state);
  });

  it("P3-SEV-T02 acceptance / AC03,AC08: verified moves the mark to the memory, silently, with one expired outcome on every path", () => {
    const seed = seeded(), marked = deadline(seed, FAR, "unverified");
    const direct = deadline(seed, FAR + 1, "verified"), through = deadline(marked.state, FAR + 1, "verified");
    expect(stored(through.state)).toEqual(stored(direct.state));
    expect([expiredIn(marked.outcomes), expiredIn(through.outcomes), through.intents, through.displayChanges]).toEqual([0, 2, [], []]);
    expect(through.state.persistence.currentGeneration).toBeGreaterThan(marked.state.persistence.currentGeneration);
    // 場面 F: 時計が後ろへ直っても見える状態に戻さない。
    const back = deadline(marked.state, R + HOUR, "verified");
    expect([back.state.earthquakes[0].contributions[0].effective, back.state.earthquakes[0].expiryPending, back.state.earthquakes[0].retainUntil,
      back.state.longPeriods[0].effective, expiredIn(back.outcomes), back.intents]).toEqual(["expired", undefined, R + 30 * HOUR, "expired", 2, []]);
    // 保留を保存して復元: unverified は印のまま、verified は記憶へ移して recoveryApplied に 1 回だけ載り、続く期限では出ない。
    const persisted = JSON.parse(JSON.stringify(seismicUnitCodec.encode(marked.state))) as JsonValue as PersistedSeismicUnit;
    const restore = (basis: WallBasis) => reduceSeismicUnit(emptyState(), { kind: "restore", persisted, clock: clock(FAR + 1), basis });
    expect([restore("awaiting").state.earthquakes[0].expiryPending, restore("unverified").state.longPeriods[0].expiryPending, expiredIn(restore("unverified").outcomes),
      toSeismicView(restore("awaiting").state).earthquakes]).toEqual([true, true, 0, []]);
    const restored = restore("verified");
    expect([expiredIn(restored.outcomes), restored.outcomes[0].kind, expiredIn(deadline(restored.state, FAR + 2, "verified").outcomes)]).toEqual([2, "recoveryApplied", 0]);
    // 印の無い期限切れの記録を restore で移したときも 1 回。
    const plain = JSON.parse(JSON.stringify(seismicUnitCodec.encode(seed))) as JsonValue as PersistedSeismicUnit;
    expect(expiredIn(reduceSeismicUnit(emptyState(), { kind: "restore", persisted: plain, clock: clock(FAR), basis: "verified" }).outcomes)).toBe(2);
  });

  it("P3-SEV-T03 acceptance / AC04,AC08: a report to a pending record", () => {
    const later = (ms: number) => (xml: string) => replaceTag("ReportDateTime", iso(ms))(xml);
    const seed = event(), wall = R + 25 * HOUR, marked = deadline(seed, wall, "unverified").state;
    expect(marked.earthquakes[0].expiryPending).toBe(true);
    // 同じ版は duplicate、古い版は stale で印のまま。
    const same = take(marked, quake(), wall, "unverified"), old = take(marked, decodeFixture(W4, later(R - HOUR)), wall, "unverified");
    expect([same.state, same.decisions[0], old.state, old.decisions[0]]).toMatchObject([marked, { decision: "unchanged", reason: "duplicate" },
      marked, { decision: "unchanged", reason: "stale" }]);
    // 同じ版で中身が違う報は held: 未確認の印を足し、保留の印は残り、鳴らない。
    const differ = take(marked, decodeFixture(W4, (xml) => xml.replace(/<MaxInt>[^<]*<\/MaxInt>/, "<MaxInt>5-</MaxInt>")), wall, "unverified");
    expect([differ.decisions[0], differ.state.earthquakes[0].expiryPending, differ.state.earthquakes[0].contributions[0].unconfirmed != null, differ.intents,
      toSeismicView(differ.state).earthquakes]).toMatchObject([{ decision: "unchanged", reason: "stale" }, true, true, [], []]);
    // 場面 A: 新しい版で印が外れ activated で鳴り、verified で記録に何も当てない。24 時間後に記憶へ移り outcome は 1 回。
    const newer = take(marked, decodeFixture(W4, later(wall)), wall + 1_000, "unverified");
    expect([newer.state.earthquakes[0].expiryPending, newer.state.earthquakes[0].retainUntil, toSeismicView(newer.state).earthquakes.length,
      [...new Set(newer.intents.map((item) => item.transition))]]).toEqual([undefined, wall + 24 * HOUR, 1, ["activated"]]);
    const checked = deadline(newer.state, wall + HOUR, "verified");
    expect(checked.state.earthquakes).toBe(newer.state.earthquakes);
    expect(expiredIn(deadline(checked.state, wall + 24 * HOUR, "verified").outcomes)).toBe(1);
    // 別 family の遅着は見える期限の内へ戻らないので印を残す。awaiting（復元の直後）も同じ。
    for (const basis of ["unverified", "awaiting"] as const) {
      const late = take(marked, decodeFixture(W3), wall, basis);
      expect([late.state.earthquakes[0].contributions.length, late.state.earthquakes[0].expiryPending, late.intents, toSeismicView(late.state).earthquakes])
        .toEqual([2, true, [], []]);
    }
    // 場面 C と順序の差（AC04 (5)(6)）: 元報と同じ時刻の取消。heard で 1 回鳴り、どちらの順でも同じ。
    const sameTime = () => cancel(R, CONTROL);
    const pendingOrder = take(heard(marked), sameTime(), wall, "unverified");
    const memoryOrder = take(deadline(heard(seed), wall, "verified").state, sameTime(), wall, "verified");
    const outcomeOf = (step: typeof pendingOrder) => [step.intents.map((item) => item.payload.level), step.state.earthquakes[0].contributions[0].effective,
      step.state.earthquakes[0].retainUntil, step.state.earthquakes[0].expiryPending];
    expect(outcomeOf(pendingOrder)).toEqual([["cancel", "cancel"], "cancelled", R + 30 * HOUR, undefined]);
    expect(outcomeOf(memoryOrder)).toEqual(outcomeOf(pendingOrder));
    expect([toSeismicView(pendingOrder.state).earthquakes[0].cancelledSummary?.hypocenterName != null, pendingOrder.state.daily.normal.count]).toEqual([true, 0]);
    // heard でない報の取消は鳴らない。記憶の期限より後の取消も heard なら鳴る。
    expect(take(marked, sameTime(), wall, "unverified").intents).toEqual([]);
    expect(take(heard(marked), sameTime(), R + 31 * HOUR, "unverified").intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
  });

  it("P3-SEV-T03 acceptance / AC04,AC08: one family cancelled keeps the mark, the other family hidden and the day's row not cancelled", () => {
    const both = receive(receive(emptyState(), decodeFixture(W3), clock(R)).state, quake(), clock(R + 1_000)).state;
    // 進んだ時計で印を付け、同じ日の手元の時計で取消を受ける（当日の履歴の行に触れる道）。
    const marked = deadline(both, R + 25 * HOUR, "unverified").state, wall = R + HOUR;
    const step = take(marked, cancel(wall, new Date(wall).toISOString()), wall, "unverified");
    expect([step.state.earthquakes[0].expiryPending, step.state.earthquakes[0].contributions.map((item) => item.effective), toSeismicView(step.state).earthquakes,
      step.intents, step.state.daily.normal.recent.map((item) => item.cancelled)]).toEqual([true, ["active", "cancelled"], [], [], [false]]);
    const memory = deadline(step.state, wall + 1_000, "verified");
    expect([memory.state.earthquakes[0].contributions.map((item) => item.effective), expiredIn(memory.outcomes)]).toEqual([["expired", "cancelled"], 1]);
  });

  it("P3-SEV-T03 acceptance / AC02,AC04: the long period takes the same table", () => {
    const seed = receive(emptyState(), longPeriod(), clock(R + 1_000)).state, wall = R + 37 * HOUR, marked = deadline(seed, wall, "unverified").state;
    const same = take(marked, longPeriod(), wall, "unverified");
    expect([same.state, same.decisions[0]]).toMatchObject([marked, { decision: "unchanged", reason: "duplicate" }]);
    // 事実が同じ新しい版でも見える記録に戻る。
    const newer = take(marked, decodeFixture(LP, replaceTag("ReportDateTime", iso(wall))), wall + 1_000, "unverified");
    expect([newer.state.longPeriods[0].expiryPending, toSeismicView(newer.state).longPeriods.length, newer.decisions[0],
      [...new Set(newer.intents.map((item) => item.transition))]]).toMatchObject([undefined, 1, { change: "semantic" }, ["activated"]]);
    const cancelled = () => decodeFixture(LP, (xml) => replaceTag("ReportDateTime", iso(R))(xml).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
      .replace(/<Body([^>]*)>[\s\S]*<\/Body>/, "<Body$1><Text>取消</Text></Body>"));
    const heardLong = (state: SeismicUnitState): SeismicUnitState => ({ ...state, longPeriods: state.longPeriods.map((item) => ({ ...item, notice: { ...item.notice!, evidence: "possible" as const } })) });
    const outcomeOf = (step: ReturnType<typeof take>) => [step.intents.map((item) => item.payload.level), step.state.longPeriods[0].effective,
      step.state.longPeriods[0].retainUntil, step.state.longPeriods[0].expiryPending];
    const pendingOrder = take(heardLong(marked), cancelled(), wall, "unverified");
    expect(outcomeOf(pendingOrder)).toEqual([["cancel", "cancel"], "cancelled", R + 42 * HOUR, undefined]);
    expect(outcomeOf(take(deadline(heardLong(seed), wall, "verified").state, cancelled(), wall, "verified"))).toEqual(outcomeOf(pendingOrder));
    expect(take(marked, cancelled(), wall, "unverified").intents).toEqual([]);
  });

  it("P3-SEV-T03 acceptance / AC08: a cancel before the deadline stays a cancel memory without a mark until verified", () => {
    const wall = R + 5 * HOUR, seed = event();
    const cancelled = take(seed, cancel(wall, new Date(wall).toISOString()), wall, "unverified").state;
    const past = deadline(cancelled, wall + 25 * HOUR, "unverified");
    expect([past.state, cancelled.earthquakes[0].expiryPending, toSeismicView(cancelled).earthquakes.length]).toEqual([cancelled, undefined, 1]);
    const gone = deadline(cancelled, wall + 25 * HOUR, "verified");
    expect([gone.state.earthquakes, expiredIn(gone.outcomes)]).toEqual([[], 0]);
  });
});

