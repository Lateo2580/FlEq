import { describe, expect, it, vi } from "vitest";

import { expectRestoreStarted } from "../notice-ledger/notice-fixture";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, ReportRef } from "../../contracts/p2-shared-runtime.types";
import type {
  EarthquakeContribution, EarthquakeEvent, LongPeriodSubject, SeismicDailyHistory, SeismicIntent, SeismicUnitState, SeismicUnitStep,
} from "../../contracts/p3-seismic-unit.types";
import contract from "../../contracts/p3-seismic-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, serializedEnvelope, UNREADABLE_CARDS_MAX_BYTES } from "../../src/checkpoint/checkpoint";
import { knownStage, safetyRank } from "../../src/domains/seismic/seismic";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { reduceSeismicUnit, seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { FAILURE_MARKS_MAX_BYTES, noticeMarkBytes } from "../../src/units/notice-mark";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, sentLater, vxse53 } from "./seismic-fixture";

const EVENT = "20260728162718";
const P75 = (name: string) => `telegram-foundation/phase7_5_${name}`;
const F = {
  s51a: P75("VXSE51_20260728162718_fd74a5616fbb"), s51b: P75("VXSE51_20260728162718_10e84031ad8b"),
  s51c: P75("VXSE51_20260728162718_6854218b287a"), s51d: P75("VXSE51_20260728162718_059a2b392646"),
  s53a: P75("VXSE53_20260728162718_99e82c812e72"), s53b: P75("VXSE53_20260728162718_bf35e8ea1825"),
  s62: P75("VXSE62_20260728162718_f9786edc27df"), s61: P75("VXSE61_20260728162718_d7e630bbb653"),
} as const;
const HOUR = 3_600_000;
// seismic-unit.ts の HOLD_GROWTH・RESERVE_BYTES（P3-VM-AC08・P3-NL-D-CAPACITY=A）。器は 4 MiB＋同時最大状態の
// Control/DateTime と印の分＋HOLD_GROWTH＋通知の印（寄与 512×4・長周期 256）＋失敗の印−外した終端 intent の予算 131,072
// ＋P3-UNIT-Q-CAPACITY-001 の増え（cancelledSummary 512×372・counted 3×2048×4・記憶の guard 768×50、P3-QC-AC05）。
const MARK = noticeMarkBytes("notice"), CONTRIBUTION_MARKS = 512 * 4 * MARK, NOTICE_GROWTH = CONTRIBUTION_MARKS + 256 * MARK;
const MEMORY_GROWTH = 512 * 372 + 3 * 2048 * 4 + 768 * 50;
const HOLD_GROWTH = seismicUnitCodec.maxEnvelopeBytes! - 4_194_304 - 121_513 - NOTICE_GROWTH - FAILURE_MARKS_MAX_BYTES + 131_072 - MEMORY_GROWTH;
const RESERVE_BYTES = 1_470_281 + NOTICE_GROWTH + MEMORY_GROWTH;
const ORIGIN = Date.parse("2026-07-28T16:27:00+09:00");
const decision = (step: SeismicUnitStep) => step.decisions[0];
const eventOf = (state: SeismicUnitState, eventId = EVENT, operation: Operation = "normal") =>
  state.earthquakes.find((item) => item.eventId === eventId && item.operation === operation);
const viewOf = (state: SeismicUnitState, eventId = EVENT, operation: Operation = "normal") =>
  toSeismicView(state).earthquakes.find((item) => item.eventId === eventId && item.operation === operation);
// 受信時刻は報の時刻（期限の手前）。
function send(state: SeismicUnitState, file: string, transform?: (xml: string) => string, now?: number): SeismicUnitStep {
  const material = decodeFixture(file, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw)));
}
function chain(files: readonly string[], state = emptyState()): SeismicUnitStep[] {
  const steps: SeismicUnitStep[] = [];
  for (const file of files) { const step = send(state, file); steps.push(step); state = step.state; }
  return steps;
}
const facts = (state: SeismicUnitState) => {
  const view = viewOf(state);
  return view == null ? null : { origin: view.originTimeRaw, hypocenter: view.hypocenter, intensity: view.intensity,
    comment: view.tsunamiComment, commentFamily: view.tsunamiCommentFamily,
    // 保持を作った報（establishedBy）は出所の記録で、公開事実の比較に入れない。
    hold: view.strongHold == null ? null : { originTimeRaw: view.strongHold.originTimeRaw, until: view.strongHold.until } };
};
const levels = (step: SeismicUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
const pending = (state: SeismicUnitState) => state.intents.filter((item) => item.disposition === "pending");

// 実 byte が 131,072 ちょうどで、配送の更新の予約を足すと超える pending（P3-IUR-AC01）。
function reserveOver(intent: Record<string, unknown>): Record<string, unknown>[] {
  const make = (index: number, pad: number) => ({ ...intent, id: `fit-${index}`, disposition: "pending",
    payload: { ...(intent.payload as Record<string, unknown>), body: "x".repeat(1 + pad) } });
  const items = Array.from({ length: 64 }, (_, index) => make(index, 0));
  items[0] = make(0, 131_072 - Buffer.byteLength(JSON.stringify(items)));
  if (Buffer.byteLength(JSON.stringify(items)) !== 131_072) throw new Error("pending is not 131,072 bytes");
  return items;
}

describe("P3-UNIT-Q-001 U-Q reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C7-T01 contractBoundary / AC01: first reason only, unchanged state, legal reduced forms and the U-Q route", () => {
    const base = emptyState();
    const now = clock(Date.parse("2099-01-01T09:00:00+09:00"));
    const reject = (xml: string, headType = "VXSE53") => {
      const step = receive(base, decodeXml(xml, headType), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges]).toEqual([[], [], []]);
      expect(step.diagnostics).toHaveLength(1);
      const result = decision(step);
      return result.decision === "rejected" ? result.reason : result.decision;
    };
    const quake = (patch: Partial<Parameters<typeof vxse53>[0]> = {}) => vxse53({ at: "2099-01-01T09:00:00+09:00", ...patch });
    const station = (code: string, name = "観測点") => `<IntensityStation><Name>${name}</Name><Code>${code}</Code><Int>4</Int></IntensityStation>`;
    const city = (stations: string) => `<City><Name>合成市</Name><Code>9900100</Code><MaxInt>4</MaxInt>${stations}</City>`;
    const cases: [string, string, string][] = [
      [quake({ eventId: "" }), "VXSE53", "identityMissing"],
      [quake({ eventId: "   " }), "VXSE53", "identityMissing"],
      [quake({ eventId: "2099 0101" }), "VXSE53", "identityInvalid"],
      [quake({ eventId: "2099/0101" }), "VXSE53", "identityInvalid"],
      [quake({ eventId: "a".repeat(41) }), "VXSE53", "identityInvalid"],
      // 「"」と「\」は JSON のエスケープで byte が増えるので EventID に許さない（I-U-Q.capacityReserve）。
      [quake({ eventId: 'a"b' }), "VXSE53", "identityInvalid"],
      [quake({ eventId: "a\\b" }), "VXSE53", "identityInvalid"],
      // Serial の形の外・Magnitude と OriginTime の欠け・Observation の無い Intensity（Earthquake あり）・Name の欠けは受ける（P3-QC-T06）。
      [quake().replace(/<Earthquake>[\s\S]*<\/Intensity>/, ""), "VXSE53", "requiredStructureMissing"],
      [fixtureXml(F.s51d).replace(/<Intensity>[\s\S]*<\/Intensity>/, ""), "VXSE51", "requiredStructureMissing"],
      [fixtureXml(F.s51d).replace("<Code>743</Code><MaxInt>", "<Code>741</Code><MaxInt>"), "VXSE51", "requiredStructureInvalid"],
      [quake({ city: city(station("9900101") + station("9900101")) }), "VXSE53", "requiredStructureInvalid"],
      // P3-QC-AC09 (4): Name の欠けは断らないので、同じ報の code の重複で断る。
      [quake({ city: city(station("9900101") + station("9900101") + "<IntensityStation><Code>9900102</Code><Int>1</Int></IntensityStation>") }),
        "VXSE53", "requiredStructureInvalid"],
      [fixtureXml("selected_xml/78_01_01_240613_VXSE62").replace("<MaxLgInt>3</MaxLgInt>", ""), "VXSE62", "requiredStructureMissing"],
      [quake().replace("<InfoType>発表</InfoType>", "<InfoType>不明</InfoType>"), "VXSE53", "requiredStructureInvalid"],
    ];
    expect(cases.map(([xml, headType]) => reject(xml, headType))).toEqual(cases.map(([, , reason]) => reason));
    // 識別できない拒否の subject は空文字、識別できた拒否は family の subject。
    expect(decision(receive(base, decodeXml(quake({ eventId: "" }), "VXSE53"), now)).subject).toBe("");
    expect(decision(receive(base, decodeXml(quake().replace(/<Earthquake>[\s\S]*<\/Intensity>/, ""), "VXSE53"), now)).subject)
      .toBe("normal/VXSE53/20990101000000");

    // 合法: 14 桁でない EventID、取消の Body 縮退、Code の無い区域、NaN の規模、射影できない震度の文字。
    const adopted = (step: SeismicUnitStep) => decision(step).decision;
    expect(adopted(send(base, "synthetic_phase4a_VXSE53_special"))).toBe("changed");
    for (const file of ["32-35_10_01_220510_VXSE51", "32-35_06_02_100915_VXSE52", "32-35_06_10_100915_VXSE61"])
      expect(adopted(send(base, file)), file).toBe("changed");
    const unkeyed = receive(base, decodeXml(quake({ city: "<City><Name>名前市</Name><MaxInt>4</MaxInt></City>" }), "VXSE53"), now);
    expect(viewOf(unkeyed.state, "20990101000000")!.intensity!.items.find((item) => item.level === "city"))
      .toMatchObject({ code: null, name: "名前市", parentCode: "990" });
    expect(viewOf(send(base, "33_12_01_240613_VXSE52").state, "20120214214013")!.hypocenter!.magnitude).toMatchObject({ kind: "unknown" });
    for (const text of ["不明", "8弱"])
      expect(adopted(receive(base, decodeXml(quake({ maxInt: text }), "VXSE53"), now)), text).toBe("changed");

    for (const headType of ["VXSE51", "VXSE52", "VXSE53", "VXSE61", "VXSE62"]) {
      expect(classifyHeadType(headType)).toEqual({ status: "ready", unit: "U-Q" });
      expect(placeOfHeadType(headType)).toBe("seismic");
    }
    for (const headType of ["VXSE45", "VTSE41"]) expect(placeOfHeadType(headType), headType).toBe("urgent");
    expect(classifyHeadType("VXSE47")).toMatchObject({ status: "notPorted", candidate: "U-Q", reason: expect.stringMatching(/^C7で確認/) });
    // 一入力は U-Q だけへ届き、seismic の owner は U-Q だけを持つ（P3-SP-D-MEMBERS=A）。
    const owner = restoreOwner({ runId: "run", place: "seismic", clock: now, restored: { "U-Q": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.s53a);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } },
      clock(Date.parse(material.reportDateTimeRaw)), linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-Q"]);
    expect(Object.keys(routed.state.units)).toEqual(["U-Q"]);
  });

  // acceptance: I-U-Q.earthquakeSemantics と Q-ENUM.revisionOrder、view（AC02・AC07）。
  it("P3-C7-T02 acceptance / AC02,AC07: the 20260728162718 series, both 16:31 orders, a late VXSE51, family-only cancels, operations", () => {
    const series = chain([F.s51a, F.s51b, F.s51c, F.s51d, F.s53a, F.s53b, F.s62, F.s61]);
    expect(series.map((step) => { const made = decision(step); return [made.subject, made.decision, made.decision === "changed" ? made.change : null]; }))
      .toEqual([...[1, 2, 3, 4].map(() => [`normal/VXSE51/${EVENT}`, "changed", "semantic"]),
        [`normal/VXSE53/${EVENT}`, "changed", "semantic"], [`normal/VXSE53/${EVENT}`, "changed", "semantic"],
        [`normal/VXSE62/${EVENT}`, "changed", "semantic"], [`normal/VXSE61/${EVENT}`, "changed", "semantic"]]);
    const after53 = series[5].state;
    // 公開事実: 震源・震度は VXSE53、発生時刻は OriginTime、津波の有無は VXSE53。
    expect(viewOf(after53)).toMatchObject({ subject: `normal/earthquake/${EVENT}`, originTimeRaw: "2026-07-28T16:27:00+09:00",
      hypocenter: { name: "熊本県熊本地方", magnitude: { kind: "number", value: 7.1 } }, intensity: { maxInt: { kind: "number", value: 7 } },
      tsunamiComment: { codes: ["0211", "0241"] }, tsunamiCommentFamily: "VXSE53" });
    // view は観測点を載せず（P3-C7-AC12）、観測点の全件は state の寄与に残る。
    const kept = eventOf(after53)!.contributions.find((item) => item.family === "VXSE53")!.intensity!;
    expect(viewOf(after53)!.intensity).toEqual({ ...kept, items: kept.items.filter((item) => item.level !== "station") });
    expect(kept.items.filter((item) => item.level === "station")).toHaveLength(1248);
    // VXSE51 だけのとき: 発生時刻は Head/TargetDateTime、津波の有無は VXSE51 の評価でない付加文。
    expect(viewOf(series[0].state)).toMatchObject({ originTimeRaw: "2026-07-28T16:27:00+09:00", hypocenter: null });
    expect(viewOf(series[0].state)!.tsunamiCommentFamily === null || viewOf(series[0].state)!.tsunamiCommentFamily === "VXSE51").toBe(true);
    // VXSE62 は別 subject で event を変えない。
    expect(eventOf(series[6].state)).toBe(eventOf(series[5].state));
    expect(toSeismicView(series[6].state).longPeriods.map((item) => item.subject)).toEqual([`normal/VXSE62/${EVENT}`]);
    // VXSE61: 震源だけを変え、震度と強震保持は保つ（P3-C7-INTENSITY-CARRY=A）。津波の有無は VXSE61 から取らない。
    const after61 = series[7].state;
    expect(viewOf(after61)!.hypocenter!.depthKm).toMatchObject({ kind: "number", value: 20 });
    expect(viewOf(after61)!.intensity).toBe(viewOf(after53)!.intensity);
    expect(viewOf(after61)!.strongHold).toEqual(viewOf(after53)!.strongHold);
    expect(viewOf(after61)!.tsunamiCommentFamily).toBe("VXSE53");
    expect(series[7].outcomes).toMatchObject([{ kind: "accepted", change: "semantic", subjects: [{ subject: `normal/VXSE61/${EVENT}`,
      changedFields: ["hypocenter"], facts: { subject: `normal/earthquake/${EVENT}` } }] }]);
    expect(series[7].displayChanges).toMatchObject([{ unit: "U-Q", subject: `normal/earthquake/${EVENT}`,
      after: { unit: "U-Q", current: { eventId: EVENT } } }]);

    // 16:31 の VXSE51 と VXSE53 の両順序で事実が同じ（family が別なので比べない）。
    const either = [chain([F.s51d, F.s53a]).at(-1)!.state, chain([F.s53a, F.s51d]).at(-1)!.state].map(facts);
    expect(either[0]).toEqual(either[1]);
    // VXSE53 の後に投入した 16:28 の VXSE51 は revisionOnly で事実を変えない。
    const first53 = send(emptyState(), F.s53a).state;
    const late = send(first53, F.s51a);
    expect(decision(late)).toMatchObject({ decision: "changed", change: "revisionOnly" });
    expect(facts(late.state)).toEqual(facts(first53));
    expect(late.intents).toEqual([]);
    // 同じ family の古い報は stale、同じ報は duplicate。
    expect(decision(send(series[3].state, F.s51b))).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(decision(send(series[3].state, F.s51d))).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    // 同じ時刻（Control/DateTime）で寄与が違えば先着を保って stale＋WARN、family の系列に未確認の印（P3-VM-AC03・AC04）。
    const conflicting = send(first53, F.s53a, (xml) => xml.replace("<Name>熊本県熊本地方</Name>", "<Name>別の震央</Name>"));
    expect(decision(conflicting)).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(facts(conflicting.state)).toEqual(facts(first53));
    expect(eventOf(conflicting.state)!.contributions.find((item) => item.family === "VXSE53")!.unconfirmed?.inputId)
      .toBe(conflicting.diagnostics[0].inputId);
    expect(conflicting.diagnostics).toMatchObject([{ level: "WARN", reason: "seismicRevisionConflict", unit: "U-Q" }]);

    // family だけの取消（P3-C7-CANCEL-SCOPE=A）: VXSE53 の取消の後も VXSE51 の震度 7 と強震保持が残る。
    const cancelled = send(series[5].state, "synthetic_VXSE53_cancel");
    expect(eventOf(cancelled.state)!.contributions.map((item) => [item.family, item.effective]))
      .toEqual([["VXSE51", "active"], ["VXSE53", "cancelled"]]);
    expect(viewOf(cancelled.state)).toMatchObject({ intensity: { maxInt: { kind: "number", value: 7 } }, hypocenter: null,
      strongHold: { originTimeRaw: "2026-07-28T16:27:00+09:00" } });
    // 取消以前の報は stale、取消より新しい報は採用して active に戻す。
    expect(decision(send(cancelled.state, F.s53b))).toMatchObject({ decision: "unchanged", reason: "stale" });
    const readopted = send(cancelled.state, F.s53b, (xml) => xml.replace(/2026-07-28T16:35:00\+09:00/g, "2026-07-28T16:40:00+09:00")
      .replace("<Serial>2</Serial>", "<Serial>3</Serial>"));
    expect(eventOf(readopted.state)!.contributions.find((item) => item.family === "VXSE53")!.effective).toBe("active");
    // 20080614084350: VXSE52 と VXSE61 の取消は family ごとに別の取消記憶。
    const vxse52 = send(emptyState(), "32-35_06_02_100915_VXSE52");
    const vxse61 = send(vxse52.state, "32-35_06_10_100915_VXSE61");
    expect(decision(vxse61)).toMatchObject({ subject: "normal/VXSE61/20080614084350", decision: "changed" });
    expect(eventOf(vxse61.state, "20080614084350")!.contributions.map((item) => [item.family, item.effective]))
      .toEqual([["VXSE52", "cancelled"], ["VXSE61", "cancelled"]]);
    expect(toSeismicView(vxse61.state).earthquakes).toEqual([]);

    // 訓練（32-35_01_02・32-35_01_03_240613）は別 event。通常の同じ EventID と交差しない。
    const normalCopy = send(emptyState(), "32-35_01_02_240613_VXSE52", (xml) => xml.replace("<Status>訓練</Status>", "<Status>通常</Status>"));
    const training = chain(["32-35_01_02_240613_VXSE52", "32-35_01_03_240613_VXSE53"], normalCopy.state).at(-1)!;
    expect(training.state.earthquakes.map((item) => [item.operation, item.eventId, item.contributions.length]))
      .toEqual([["normal", "20091001134500", 1], ["training", "20091001134500", 2]]);
    expect(eventOf(training.state, "20091001134500")).toBe(eventOf(normalCopy.state, "20091001134500"));
    expect(training.state.daily.normal).toBe(normalCopy.state.daily.normal);
    expect(training.intents.map((item) => item.channel)).toEqual(["desktop"]);
  });

  // acceptance: I-U-Q.longPeriodSemantics（AC03）。
  it("P3-C7-T03 acceptance / AC03: VXSE62 subject, its cancel and 36 h, the event untouched, classes apart from intensity", () => {
    const quake = send(emptyState(), F.s53b).state;
    const adopted = send(quake, F.s62);
    expect(adopted.state.earthquakes).toBe(quake.earthquakes);
    const subject = adopted.state.longPeriods[0];
    expect(subject).toMatchObject({ subject: `normal/VXSE62/${EVENT}`, eventId: EVENT, effective: "active",
      intensity: { maxLgInt: { kind: "number", value: 4 } }, retainUntil: Date.parse("2026-07-28T16:37:00+09:00") + 36 * HOUR });
    // 階級は震度と混ぜない: event の震度は VXSE53 のまま。
    expect(viewOf(adopted.state)!.intensity!.maxInt).toMatchObject({ kind: "number", value: 7 });
    // 取消は事実を捨て、view から外れる。event は同じ参照のまま。
    const cancel = send(adopted.state, F.s62, (xml) => xml.replace(/2026-07-28T16:37:00\+09:00/g, "2026-07-28T16:50:00+09:00")
      .replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>").replace(/<Body([^>]*)>[\s\S]*<\/Body>/, "<Body$1><Text>取消</Text></Body>"));
    expect(cancel.state.longPeriods[0]).toMatchObject({ effective: "cancelled", title: "", headline: null, hypocenter: null, intensity: null });
    expect(cancel.state.earthquakes).toBe(quake.earthquakes);
    expect(toSeismicView(cancel.state).longPeriods).toEqual([]);
    expect(cancel.intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    // 36 時間で期限切れの記憶にし（P3-QC-AC08）、event の期限（24 時間）を変えない。
    const reported = Date.parse("2026-07-28T16:37:00+09:00");
    const effectives = (state: SeismicUnitState) => [state.earthquakes.map((item) => item.contributions.map((entry) => entry.effective)),
      state.longPeriods.map((item) => item.effective)];
    const day = reduceSeismicUnit(adopted.state, { kind: "deadline", clock: clock(reported + 24 * HOUR) }).state;
    expect(effectives(day)).toEqual([[["expired"]], ["active"]]);
    expect(effectives(reduceSeismicUnit(day, { kind: "deadline", clock: clock(reported + 36 * HOUR) }).state)).toEqual([[], ["expired"]]);
    // 78_01_01 と合成の特殊値: 階級 3 は critical、未入電の階級は normal、Earthquake の無い報の震源は null。
    expect(levels(send(emptyState(), "selected_xml/78_01_01_240613_VXSE62"))).toEqual(["desktop:critical", "sound:critical"]);
    const special = send(emptyState(), "synthetic_phase4a_VXSE62_special");
    expect(special.state.longPeriods[0]).toMatchObject({ hypocenter: null, intensity: { maxLgInt: { kind: "empty" },
      items: [{ level: "pref", code: "99", maxLgInt: { kind: "fromTo" } }, { level: "area", code: "990" }, { level: "area", code: "991" },
        { level: "area", code: "992", maxLgInt: { kind: "missing" } }] } });
    expect(levels(special)).toEqual(["desktop:normal", "sound:normal"]);
    // 階級 1 は warning、2 は critical（Q-NOTICE.level、P3-QC-AC06 (2)）。
    for (const [lg, level] of [["1", "warning"], ["2", "critical"]]) expect(levels(send(emptyState(), "synthetic_phase4a_VXSE62_special",
      (xml) => xml.replace('<MaxLgInt condition="未入電" description="最大長周期階級未入電"/>', `<MaxLgInt>${lg}</MaxLgInt>`))), lg)
      .toEqual([`desktop:${level}`, `sound:${level}`]);
  });

  // acceptance: 強震保持・intensityScale・当日履歴（AC04）。
  it("P3-C7-T04 acceptance / AC04: strong hold, the intensity scale and the daily history", () => {
    const hold = (state: SeismicUnitState) => eventOf(state)?.strongHold ?? null;
    const base = send(emptyState(), F.s53a).state;
    expect(hold(base)).toMatchObject({ originTimeRaw: "2026-07-28T16:27:00+09:00", until: ORIGIN + 12 * HOUR,
      establishedBy: { family: "VXSE53", serialRaw: "1" } });
    const synthetic = (minute: number, maxInt: string, infoType: "発表" | "訂正" = "発表", serial = 3) => decodeXml(vxse53({ eventId: EVENT,
      at: `2026-07-28T16:${minute}:00+09:00`, origin: "2026-07-28T16:27:00+09:00", maxInt, infoType, serial }), "VXSE53");
    const at = (minute: number) => clock(Date.parse(`2026-07-28T16:${minute}:00+09:00`));
    // 外れない: VXSE61 の到着・遅れて届いた古い VXSE51・全震度 unknown の続報・range lower の続報。延長もしない。
    for (const step of [send(base, F.s61), send(base, F.s51a), send(base, "synthetic_VXSE53_intensity_unknown"),
      receive(base, synthetic(40, "5弱以上"), at(40))]) expect(hold(step.state)).toEqual(hold(base));
    // 既知の段階 6 強の訂正で外れる。
    const corrected = receive(base, synthetic(40, "6+", "訂正"), at(40));
    expect(hold(corrected.state)).toBeNull();
    expect(corrected.outcomes).toMatchObject([{ subjects: [{ changedFields: expect.arrayContaining(["intensity", "strongHold"]) }] }]);
    // 震度を持つ寄与の全取消で外れる（VXSE51 が残れば保つ）。
    expect(hold(send(base, "synthetic_VXSE53_cancel").state)).toBeNull();
    expect(hold(send(send(base, F.s51d).state, "synthetic_VXSE53_cancel").state)).toEqual(hold(base));
    // 発生時刻 + 12 時間で外れる（11 時間 59 分と 12 時間）。
    expect(hold(reduceSeismicUnit(base, { kind: "deadline", clock: clock(ORIGIN + 12 * HOUR - 60_000) }).state)).toEqual(hold(base));
    const expired = reduceSeismicUnit(base, { kind: "deadline", clock: clock(ORIGIN + 12 * HOUR) });
    expect(hold(expired.state)).toBeNull();
    expect(expired.displayChanges).toMatchObject([{ after: { current: { strongHold: null } } }]);
    expect(expired.intents).toEqual([]);

    // I-U-Q.intensityScale の表。
    const text = (value: string) => ({ kind: "text" as const, value, raw: value });
    const range = (bound: "lower" | "upper", value: number) => ({ kind: "range" as const, bound, value, raw: "" });
    expect([text("5-"), text("6+"), text("５弱"), { kind: "number" as const, value: 4, raw: "4" }, range("lower", 5), text("8弱"),
      { kind: "number" as const, value: 5, raw: "5" }].map(knownStage)).toEqual([5, 8, 5, 4, null, null, null]);
    expect([{ kind: "missing" as const }, { kind: "empty" as const, raw: "" }, text("8弱"), { kind: "unknown" as const, raw: "不明" },
      range("upper", 5), range("lower", 5), range("lower", 6), { kind: "fromTo" as const, from: text("４"), to: text("５－") },
      { kind: "fromTo" as const, from: text("4"), to: { kind: "missing" as const } }].map(safetyRank))
      .toEqual([null, null, null, null, 6, 5, 7, 5, 4]);
    // 「震度５弱以上未入電」と City の Condition だけの嘉島町は range lower 5、段階は持たない。
    const big = eventOf(send(emptyState(), F.s53b).state)!.contributions[0].intensity!.items;
    expect(big.find((item) => item.name === "嘉島町")!.maxInt).toMatchObject({ kind: "range", bound: "lower", value: 5 });
    expect(big.find((item) => item.name === "宇城市小川町＊")!.maxInt).toMatchObject({ kind: "range", bound: "lower", value: 5 });
    // 通知の段階: 全体 MaxInt の missing・empty・表に無い text は normal、unknown は info、range の upper 5 は 5強で critical（P3-QC-AC06）。
    const level = (maxInt: string) => levels(receive(emptyState(), decodeXml(vxse53({ at: "2099-01-01T09:00:00+09:00", maxInt }), "VXSE53"),
      clock(Date.parse("2099-01-01T09:00:00+09:00"))))[0];
    expect(["", "8弱", "不明", "5強以下", "3", "4"].map(level))
      .toEqual(["desktop:normal", "desktop:normal", "desktop:info", "desktop:critical", "desktop:normal", "desktop:warning"]);

    // 当日履歴（P3-C7-DAILY=A・P3-C7-DAILY-BASIS=B）。
    const day = (state: SeismicUnitState) => state.daily.normal;
    const series = chain([F.s51a, F.s53a, F.s53b]);
    expect(day(series[2].state)).toMatchObject({ dayKey: "2026-07-28", count: 1, counted: [[EVENT, 9]], maxInt: { value: 7 } });
    expect(day(series[2].state).recent.map((item) => item.eventId)).toEqual([EVENT]);
    // VXSE51 の寄与が残る event の VXSE53 だけの取消では減らさない（P3-QC-AC07 (1)）。range だけの地震は数えない。
    const cancelled = send(series[2].state, "synthetic_VXSE53_cancel");
    expect(day(cancelled.state)).toMatchObject({ count: 1, maxInt: { value: 7 } });
    expect(day(send(emptyState(), "synthetic_phase4a_VXSE51_special").state)).toMatchObject({ count: 0, maxInt: null });
    // 件数・最大震度は受信日（23 時 59 分 59 秒着と 0 時 0 分着）。
    const report = (eventId: string, at: string, origin: string, maxInt = "3") => decodeXml(vxse53({ eventId, at, origin, maxInt }), "VXSE53");
    const late = Date.parse("2026-08-01T23:59:59+09:00"), midnight = Date.parse("2026-08-02T00:00:00+09:00");
    expect(day(receive(emptyState(), report("20260801235900", "2026-08-01T23:59:00+09:00", "2026-08-01T23:58:00+09:00"), clock(late)).state))
      .toMatchObject({ dayKey: "2026-08-01", count: 1 });
    expect(day(receive(emptyState(), report("20260801235900", "2026-08-01T23:59:00+09:00", "2026-08-01T23:58:00+09:00"), clock(midnight)).state))
      .toMatchObject({ dayKey: "2026-08-02", count: 1, recent: [] });
    // recent は発生日（発生 23 時 59 分と 0 時 0 分）。23 時 59 分発生・0 時 1 分着は件数と最大震度が受信日に入り、recent には入らない。
    const firstMinute = Date.parse("2026-08-02T00:01:00+09:00");
    const crossing = receive(emptyState(), report("20260801235901", "2026-08-02T00:01:00+09:00", "2026-08-01T23:59:00+09:00", "4"), clock(firstMinute));
    expect(day(crossing.state)).toMatchObject({ dayKey: "2026-08-02", count: 1, maxInt: { value: 4 }, recent: [] });
    const sameDay = receive(emptyState(), report("20260802000001", "2026-08-02T00:01:00+09:00", "2026-08-02T00:00:00+09:00"), clock(firstMinute));
    expect(day(sameDay.state).recent.map((item) => item.eventId)).toEqual(["20260802000001"]);
    // VXSE51 の発生日は TargetDateTime、発生時刻が無ければ ReportDateTime。
    expect(day(send(emptyState(), F.s51a).state).recent).toMatchObject([{ originTimeRaw: "2026-07-28T16:27:00+09:00" }]);
    const noOrigin = send(emptyState(), "synthetic_phase4a_VXSE53_special");
    expect(day(noOrigin.state).recent).toMatchObject([{ originTimeRaw: null, reportDateTimeRaw: "2026-08-01T21:00:30+09:00" }]);
    // 同じ EventID の続報で件数を足さない。recent の 6 行目は落ち、counted の 2049 件目は組に足さずに数える。
    let state = emptyState();
    for (let index = 0; index < 6; index++)
      state = receive(state, report(`2026080200000${index}`, "2026-08-02T00:10:00+09:00", "2026-08-02T00:05:00+09:00"),
        clock(Date.parse("2026-08-02T00:10:00+09:00"))).state;
    state = receive(state, report("20260802000005", "2026-08-02T00:11:00+09:00", "2026-08-02T00:05:00+09:00"),
      clock(Date.parse("2026-08-02T00:11:00+09:00"))).state;
    expect(day(state).count).toBe(6);
    expect(day(state).recent.map((item) => item.eventId)).toEqual(["20260802000005", "20260802000004", "20260802000003", "20260802000002",
      "20260802000001"]);
    const ids = Array.from({ length: 2048 }, (_, index) => `full-${index}`);
    const full: SeismicUnitState = { ...emptyState(), daily: { ...emptyState().daily, normal: { dayKey: "2026-08-02", count: 2048, maxInt: null,
      counted: ids.map((id) => [id, 3] as const), recent: [] } } };
    const beyond = receive(full, report("20260802000099", "2026-08-02T00:10:00+09:00", "2026-08-02T00:05:00+09:00"),
      clock(Date.parse("2026-08-02T00:10:00+09:00"))).state;
    expect([day(beyond).count, day(beyond).counted.length]).toEqual([2049, 2048]);
    // 時計の JST 0 時で空へ戻す。
    const reset = reduceSeismicUnit(series[2].state, { kind: "deadline", clock: clock(Date.parse("2026-07-29T00:00:00+09:00")) }).state;
    expect(day(reset)).toEqual({ dayKey: null, count: 0, maxInt: null, counted: [], recent: [] });
    expect(reset.contentRevision).toBe(series[2].state.contentRevision + 1);
  });

  // contractBoundary（P3-VM-AC08、作者裁定 2026-10-21 午後）: decode の受ける上限いっぱいの欄で組んだ未確認の印と容量不足の印を、強震保持の event
  // の 4 family の寄与の全部に付けても、旧い形からの増え分は 1 件あたり HOLD_GROWTH/512 以下。上限を 1 つ越える inputId の印は invalid。
  it("P3-VM-T05 contractBoundary / AC08: the largest marks a decode accepts grow a strong-hold event by at most HOLD_GROWTH / 512", () => {
    const eventId = "E".repeat(40), time = "2026-07-28T16:35:00+09:00";
    const ref = (family: string, inputId = "i".repeat(64)): ReportRef => ({ inputId, origin: "recovery", operation: "normal", family,
      subject: `normal/${family}/${eventId}`, reportDateTimeRaw: time, controlDateTimeRaw: time, serialRaw: "9".repeat(10), infoTypeRaw: "取消" });
    const real = eventOf(chain([F.s51d, F.s53b, F.s61]).at(-1)!.state)!;
    const vxse52 = eventOf(send(emptyState(), "32-35_04_03_240613_VXSE52").state, "20100125161517")!.contributions[0];
    const base: EarthquakeEvent = { ...real, eventId, contributions: [...real.contributions, vxse52]
      .sort((a, b) => a.family.localeCompare(b.family)).map((item) => ({ ...item, source: ref(item.family) })) };
    const largest = (inputId?: string): EarthquakeEvent => ({ ...base,
      contributions: base.contributions.map((item) => ({ ...item, unconfirmed: ref(item.family, inputId) })),
      unavailable: base.contributions.map((item) => ({ reason: "capacityExceeded" as const, source: ref(item.family, inputId) })) });
    const decode = (event: EarthquakeEvent) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode({ ...emptyState(),
      earthquakes: [event] }))) as JsonValue).kind;
    expect([largest().contributions.length, decode(largest()), decode(largest("i".repeat(65))), decode(largest('i"'))])
      .toEqual([4, "restored", "invalid", "invalid"]);
    const json = JSON.stringify(largest()), old = json.replace(/,"unconfirmed":\{[^}]*\}/g, "").replace(/,"controlDateTimeRaw":"[^"]*"/g, "");
    expect(Buffer.byteLength(json) - Buffer.byteLength(old)).toBeLessThanOrEqual(HOLD_GROWTH / 512);
  });

  // contractBoundary: P3-C7-CAPACITY=A・P3-C7-CAPACITY-BUDGET=A と受信 1 回の費用（AC05）。
  it("P3-C7-T05 contractBoundary / AC05: 511/512/513 events, 255/256/257 subjects, the budget state +1, eviction order and no whole encode", () => {
    const now = Date.parse("2099-01-01T09:00:00+09:00");
    // 件数の境界は同じ地震の VXSE52（32-35_04_03）の EventID を替えて作る。32-35_04_04（寄与 約 38 KB）の 512 件は 4 MiB を超え、
    // 件数より先に byte の上限に当たる。
    const seed = eventOf(send(emptyState(), "32-35_04_03_240613_VXSE52").state, "20100125161517")!;
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    const retime = <T extends { source: EarthquakeContribution["source"] }>(item: T, eventId: string, operation: Operation, offset: number): T =>
      ({ ...item, source: { ...item.source, operation, subject: `${operation}/${item.source.family}/${eventId}`, reportDateTimeRaw: iso(offset) } });
    const clone = (index: number, patch: Partial<EarthquakeEvent> = {}, from: EarthquakeEvent = seed): EarthquakeEvent => {
      const operation = patch.operation ?? "normal";
      const eventId = `E${String(index).padStart(13, "0")}`;
      return { ...from, eventId, operation, strongHold: null, retainUntil: now + HOUR,
        contributions: from.contributions.map((item) => retime(item, eventId, operation, (1000 - index) * 1000)), ...patch };
    };
    const at = clock(now);
    const quake = (eventId: string, operation: "通常" | "訓練" = "通常") => decodeXml(vxse53({ eventId, at: iso(0), operation }), "VXSE53");
    const withEvents = (earthquakes: readonly EarthquakeEvent[], longPeriods: readonly LongPeriodSubject[] = []): SeismicUnitState =>
      ({ ...emptyState(), earthquakes, longPeriods });
    // 511 → 512 は収まり、512 の 513 件目は最古の normal（強震保持の無い事実の event）を退去する。
    const full = withEvents(Array.from({ length: 512 }, (_, index) => clone(index)));
    expect(receive(withEvents(full.earthquakes.slice(1)), quake("N0001"), at).diagnostics).toEqual([]);
    const pushed = receive(full, quake("N0001"), at);
    expect(pushed.diagnostics).toEqual([{ level: "INFO", component: "seismic", reason: "seismicCapacityEvicted", unit: "U-Q", count: 1 }]);
    expect(pushed.state.earthquakes.some((item) => item.eventId === clone(0).eventId)).toBe(false);
    expect(pushed.displayChanges.some((item) => item.subject === `normal/earthquake/${clone(0).eventId}` && item.after == null)).toBe(true);
    // training の受理は normal を退去させない（capacityExceeded で記録は不変、結果は空）。P3-CC-AC10・AC07: 新しい event には印を
    // 付けず、入るのは拒否した報の段階の training の失敗警報（warning 以上のときだけ）と capacityRejected の 1 行。
    const refused = receive(full, quake("T0001", "訓練"), at);
    expect(decision(refused)).toMatchObject({ decision: "capacityExceeded" });
    expect(refused.state.earthquakes).toBe(full.earthquakes);
    // 最大震度 4 の訓練報なので、training の warning の失敗警報が desktop だけに 1 件入る。
    expect(refused.intents.map((item) => [item.subject, item.channel, item.payload.level])).toEqual([["training/capacityRejected", "desktop", "warning"]]);
    expect(refused.intents[0].payload.title).toMatch(/^【訓練】【処理できていません】.+（\d{2}:\d{2} 発表）$/);
    expect([refused.outcomes, refused.displayChanges]).toEqual([[], []]);
    expect(refused.diagnostics.map((item) => item.reason)).toEqual(["capacityRejected"]);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) training/test → (3) 最古の守らない normal。守る地震と取消記憶は件数の超過でも後回し
    // （P3-QC-AC02 (4)。強震保持は守る線に置き換えた、P3-QC-AC01 (4)）。
    const guard = { guard: { from: now - HOUR, on: 1 as const } };
    const memory = (index: number) => clone(index, { contributions: seed.contributions.map((item) => ({ ...retime(item, clone(index).eventId,
      "normal", (1000 - index) * 1000), effective: "cancelled" as const, targetDateTimeRaw: null, title: "", headline: null, hypocenter: null,
      intensity: null, tsunamiComment: null })) });
    let state = withEvents([clone(0, guard), memory(1), clone(2, { retainUntil: now }),
      clone(3, { operation: "training" }), ...Array.from({ length: 508 }, (_, index) => clone(index + 10))]);
    const evicted: string[] = [];
    for (const eventId of ["N0002", "N0003", "N0004"]) {
      const before = new Set(state.earthquakes.map((item) => `${item.operation}/${item.eventId}`));
      state = receive(state, quake(eventId), at).state;
      evicted.push(...[...before].filter((key) => !state.earthquakes.some((item) => `${item.operation}/${item.eventId}` === key)));
    }
    expect(evicted).toEqual([`normal/${clone(2).eventId}`, `training/${clone(3).eventId}`, `normal/${clone(10).eventId}`]);
    // 件数が満杯で事実の event が守る地震だけなら、最古の取消記憶だけの event を退去して新しい取消を受ける。
    const holds = withEvents([memory(1), memory(2), ...Array.from({ length: 510 }, (_, index) => clone(index + 10, guard))]);
    const cancel = receive(holds, decodeXml(vxse53({ eventId: "N0005", at: iso(0), infoType: "取消" }), "VXSE53"), at);
    expect(decision(cancel).decision).toBe("changed");
    expect(cancel.state.earthquakes.some((item) => item.eventId === memory(1).eventId)).toBe(false);
    // 退去した event に遅れて届いた続報は、取消記憶が無いので新しく採用される。
    const lateFollow = decodeXml(vxse53({ eventId: memory(1).eventId, at: iso((1000 - 1) * 1000) }), "VXSE53");
    expect(decision(receive(cancel.state, lateFollow, at))).toMatchObject({ decision: "changed" });
    // 守らない報のためには守る地震を退去しない（件数の超過で候補が尽きれば capacityExceeded、P3-QC-D-SMALL-PUSH=B）。
    const onlyHolds = withEvents(Array.from({ length: 512 }, (_, index) => clone(index, guard)));
    expect(decision(receive(onlyHolds, quake("N0006"), at)).decision).toBe("capacityExceeded");
    // 件数が満杯で事実の event が守る地震だけなら、新しい地震（取消でない報）も最古の取消記憶だけの event を退去して入る（(4)）。
    const quakeIn = receive(holds, quake("N0012"), at);
    expect(decision(quakeIn).decision).toBe("changed");
    expect(quakeIn.state.earthquakes.some((item) => item.eventId === memory(1).eventId)).toBe(false);
    expect(quakeIn.state.earthquakes.filter((item) => item.guard?.on === 1)).toHaveLength(510);
    // 長周期 255/256/257。
    // 長周期も小さい合成の報（synthetic_phase4a_VXSE62_special）で数える（f9786edc27df の 256 件は 4 MiB を超える）。
    const lpSeed = send(emptyState(), "synthetic_phase4a_VXSE62_special").state.longPeriods[0];
    const lp = (index: number, patch: Partial<LongPeriodSubject> = {}): LongPeriodSubject => {
      const eventId = `L${String(index).padStart(13, "0")}`, operation = patch.operation ?? "normal";
      const subject = `${operation}/VXSE62/${eventId}`;
      return { ...lpSeed, subject, eventId, operation, source: { ...lpSeed.source, subject, operation, reportDateTimeRaw: iso((1000 - index) * 1000) },
        retainUntil: now + HOUR, ...patch };
    };
    const lgReport = (eventId: string) => decodeFixture("synthetic_phase4a_VXSE62_special", (xml) => replaceTag("EventID", eventId)(xml)
      .replace(/2026-08-01T21:02:00\+09:00/g, iso(0)));
    expect(receive(withEvents([], Array.from({ length: 255 }, (_, index) => lp(index))), lgReport("N0007"), at).diagnostics).toEqual([]);
    const lgPushed = receive(withEvents([], Array.from({ length: 256 }, (_, index) => lp(index))), lgReport("N0007"), at);
    expect(lgPushed.diagnostics).toMatchObject([{ reason: "seismicCapacityEvicted", count: 1 }]);
    expect(lgPushed.state.longPeriods).toHaveLength(256);
    expect(lgPushed.state.longPeriods.some((item) => item.subject === lp(0).subject)).toBe(false);

    // byte の超過（4 MiB）では event と長周期の両方が候補。最大の寄与（bf35e8ea1825）を複製して作る。
    const giant = eventOf(send(emptyState(), F.s53b).state)!;
    const heavy = (index: number) => clone(index, {}, giant);
    const fill: EarthquakeEvent[] = [];
    let probe = withEvents([], [lp(0)]);
    for (let index = 1; ; index++) {
      const next = withEvents([...fill, heavy(index)], [lp(0)]);
      if (seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(next))) as JsonValue).kind !== "restored") break;
      fill.push(heavy(index));
      probe = next;
    }
    // P3-QC-AC02 (1): 退去の前に、守らない記録の観測点を古い順に畳む（最古の長周期は観測点を持たない）。
    const byBytes = receive(probe, decodeFixture(F.s53b, (xml) => replaceTag("EventID", "N0008")(xml).replace(/2026-07-28T16:35:00\+09:00/g, iso(0))), at);
    expect(decision(byBytes).decision).toBe("changed");
    expect(byBytes.diagnostics.map((item) => item.reason)).toEqual(["seismicStationsFolded"]);
    expect(byBytes.state.earthquakes.find((item) => item.eventId === heavy(1).eventId)?.contributions.find((item) => item.family === "VXSE53"))
      .toMatchObject({ folded: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // normal の事実だけで超えるなら capacityExceeded（training の受理は normal を退去させない）。
    const trainingGiant = decodeFixture(F.s53b, (xml) => replaceTag("EventID", "N0009")(xml).replace(/2026-07-28T16:35:00\+09:00/g, iso(0))
      .replace("<Status>通常</Status>", "<Status>訓練</Status>"));
    expect(decision(receive(probe, trainingGiant, at)).decision).toBe("capacityExceeded");
    // P3-C7-CAPACITY-BUDGET=A の同時最大状態: 取消記憶だけの event 505＋最大の実例の event 7＋その長周期 7＋取消記憶だけの長周期 249
    // ＋当日履歴 3 operation の上限＋intent の上限。decode が受け、+1 件は件数の超過で training の取消記憶を退去する。
    const budget = budgetState(now);
    const json = JSON.stringify(seismicUnitCodec.encode(budget)), encoded = Buffer.byteLength(json);
    // P3-VM-AC08: K7 の Control/DateTime と未確認の印を外した形との差が、器を広げた量（seismic-unit.ts の GENERATION_LIMIT）の根拠。
    const k7 = encoded - Buffer.byteLength(json.replace(/,"unconfirmed":\{[^}]*\}/g, "").replace(/,"controlDateTimeRaw":"[^"]*"/g, ""));
    console.info("P3-C7 capacity budget state payload bytes", encoded, "contract 3,979,110", "K7 growth", k7);
    const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const reserve = budget.earthquakes.slice(0, 505).reduce((sum, item) => sum + sizeOf(item), 0)
      + budget.longPeriods.slice(7).reduce((sum, item) => sum + sizeOf(item), 0) + sizeOf(budget.daily);
    console.info("P3-C7 capacity budget parts", JSON.stringify({ memoryEvent: sizeOf(budget.earthquakes[0]), largestEvent: sizeOf(budget.earthquakes[505]),
      memoryLongPeriod: sizeOf(budget.longPeriods[255]), longPeriod: sizeOf(budget.longPeriods[0]), history: sizeOf(budget.daily.normal),
      recentRow: sizeOf(budget.daily.normal.recent[0]), daily: sizeOf(budget.daily), intents: sizeOf(budget.intents), reserve }));
    expect(reserve).toBeLessThanOrEqual(RESERVE_BYTES);
    expect(encoded).toBeLessThanOrEqual(seismicUnitCodec.maxEnvelopeBytes!);
    expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(budget))) as JsonValue).kind).toBe("restored");
    const plusOne = receive(budget, quake("N0010"), at);
    expect(decision(plusOne).decision).toBe("changed");
    // pending も上限（128 件）なので、期限の遅い新しい intent は外れる（Q-NOTICE.capacity）。
    expect(plusOne.diagnostics).toMatchObject([{ reason: "seismicCapacityEvicted", count: 1 }, { reason: "notificationCapacityEvicted", count: 2 }]);
    expect(plusOne.state.earthquakes.filter((item) => item.operation === "training")).toHaveLength(504);

    // 保持上限付近で受信 1 回は event・寄与単位の加算だけ（state・配列・既存の event と寄与を直列化しない）。
    receive(probe, quake("N0011"), at);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(probe, quake("N0011"), at);
      const whole = new Set<unknown>([probe, probe.earthquakes, probe.longPeriods, probe.intents, probe.daily,
        ...probe.earthquakes, ...probe.earthquakes.flatMap((item) => item.contributions), ...probe.longPeriods]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  // contractBoundary: I-U-Q.persisted・I-U-Q.decode、復元で intent を作らない（AC06）。
  it("P3-C7-T06 contractBoundary / AC06: one codec, persisted fields only, every decode check and restore without new intents", () => {
    const state = chain([F.s51d, F.s53a, F.s62, "synthetic_VXSE53_cancel"]).at(-1)!.state;
    const payload = JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["daily", "earthquakes", "failureMarks", "intents", "longPeriods", "schemaVersion"]);
    expect(seismicUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...state, contentRevision: 0, persistence: { kind: "saved",
      currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { earthquakes: Row[]; longPeriods: Row[]; intents: Row[]; daily: Record<Operation, Row> };
    const quake = value.earthquakes[0], contributions = quake.contributions as Row[];
    const active = contributions.find((item) => item.effective === "active")!, cancelled = contributions.find((item) => item.effective === "cancelled")!;
    const withQuake = (patch: Row) => ({ ...value, earthquakes: [{ ...quake, ...patch }] });
    const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));
    const eventN = (index: number) => ({ ...quake, eventId: `E${index}`, contributions: contributions.map((item) => ({ ...item,
      source: { ...(item.source as Row), subject: `normal/${String(item.family)}/E${index}` } })) });
    const lp = value.longPeriods[0];
    const lpN = (index: number) => ({ ...lp, eventId: `L${index}`, subject: `normal/VXSE62/L${index}`,
      source: { ...(lp.source as Row), subject: `normal/VXSE62/L${index}` } });
    const hold = quake.strongHold as Row | null;
    // 実 byte は世代の上限ちょうどで、予約を足すと超える世代（P3-IUR-AC02）。終端記録は無くなった（P3-NL-AC05）ので寄与の title で埋める。
    const live = value.intents.find((item) => item.disposition === "pending")!;
    const withPad = (pad: number) => ({ ...value, intents: [live], earthquakes: [{ ...quake, contributions: contributions.map((item) => item === active
      ? { ...item, title: `${String(item.title)}${"x".repeat(pad)}` } : item) }, ...value.earthquakes.slice(1)] });
    const generation = (pad: number) => serializedEnvelope({ schemaVersion: "p3-seismic-unit-v4", unit: "U-Q", generation: 0, capturedAt: 0,
      payload: withPad(pad) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES;
    const limit = seismicUnitCodec.maxEnvelopeBytes!;
    const generationPad = limit - generation(0);
    expect(generation(generationPad)).toBe(limit);
    expect(seismicUnitCodec.decode(withPad(generationPad - deliveryGrowth(pending(state)[0])) as JsonValue).kind).toBe("restored");
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-seismic-unit-v0" }],
      ["events > 512", { ...value, earthquakes: many(513, eventN) }],
      ["long periods > 256", { ...value, longPeriods: many(257, lpN) }],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...value.intents[0], id: `pending-${index}`, disposition: "pending" })) }],
      ["pending > 131072 bytes", { ...value, intents: many(100, (index) => ({ ...value.intents[0], id: `big-${index}`, disposition: "pending",
        payload: { ...(value.intents[0].payload as Row), body: "x".repeat(1400) } })) }],
      ["pending real 131072 + reserve", { ...value, intents: reserveOver(live) }],
      ["generation real limit + reserve", withPad(generationPad)],
      ["generation over the limit", { ...value, earthquakes: many(Math.ceil(seismicUnitCodec.maxEnvelopeBytes! / 300_000), (index) => ({ ...eventN(index), contributions: [{ ...active,
        headline: "x".repeat(300_000), source: { ...(active.source as Row), subject: `normal/${String(active.family)}/E${index}` } }] })) }],
      ["EventID not printable ASCII", withQuake({ eventId: "地震" })],
      ["EventID over 40 bytes", withQuake({ eventId: "a".repeat(41) })],
      ["duplicate event", { ...value, earthquakes: [quake, quake] }],
      ["duplicate family", withQuake({ contributions: [active, active] })],
      ["cancelled keeps facts", withQuake({ contributions: contributions.map((item) => item === cancelled ? { ...item, title: "震源・震度情報" } : item) })],
      ["cancelled long period keeps facts", { ...value, longPeriods: [{ ...lp, effective: "cancelled" }] }],
      ["duplicate long period", { ...value, longPeriods: [lp, lp] }],
      // 取消記憶だけの記録の byte は文字列長の上限から決まる。上限の外の長さ（inputId）で I-U-Q.capacityReserve を超えた保存物。
      ["reserve exceeded", { ...value, earthquakes: many(512, (index) => ({ ...eventN(index), guard: { ...(quake.guard as Row), on: 0 }, contributions: [{ ...cancelled,
        source: { ...(cancelled.source as Row), inputId: "x".repeat(3_100), subject: `normal/${String(cancelled.family)}/E${index}` } }] })) }],
      ["strongHold until", withQuake({ strongHold: hold == null ? null : { ...hold, until: Number(hold.until) + 1 } })],
      ["recent > 5", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, recent: many(6, () => (value.daily.normal.recent as Row[])[0]) } } }],
      ["recent string limit", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, recent: [{ ...(value.daily.normal.recent as Row[])[0],
        hypocenterName: "x".repeat(65) }] } } }],
      ["counted > 2048", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, counted: many(2049, (index) => [`c${index}`, 1]) } } }],
      ["counted duplicate", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, counted: [[EVENT, 9], [EVENT, 9]] } } }],
      ["intent of another unit", { ...value, intents: [{ ...value.intents[0], unit: "U-T" }] }],
      ["intent subject form", { ...value, intents: [{ ...value.intents[0], subject: "normal/VTSE41/20110311144640",
        source: { ...(value.intents[0].source as Row), subject: "normal/VTSE41/20110311144640" } }] }],
    ];
    expect(hold).not.toBeNull();
    for (const [name, candidate] of invalid) expect(seismicUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 容量退去の直後でも intent の subject が state に無いことは unavailable の理由にしない。
    expect(seismicUnitCodec.decode({ ...value, earthquakes: [], longPeriods: [] } as JsonValue).kind).toBe("restored");

    // 実不具合の再発防止（予約の境界）: 上限の長さの取消を受信 → encode → JSON → decode まで通す。取消記憶だけの event 512 件（4 family、
    // training、EventID 40 文字・Serial 10 桁・ReportDateTime 25 文字）と長周期 256 件は予約の内側で、保存物を decode が受ける。
    const cancelXml = (family: string, eventId: string, serial: string, at = "2099-01-01T09:00:00+09:00") => `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Report xmlns="http://xml.kishou.go.jp/jmaxml1/"><Control><Title>取消</Title><DateTime>2099-01-01T00:00:00Z</DateTime>`
      + `<Status>訓練</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>`
      + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>取消</Title><ReportDateTime>${at}</ReportDateTime>`
      + `<TargetDateTime>${at}</TargetDateTime><EventID>${eventId}</EventID><InfoType>取消</InfoType><Serial>${serial}</Serial>`
      + `<InfoKind>地震情報</InfoKind><InfoKindVersion>1.0_1</InfoKindVersion><Headline><Text>取消</Text></Headline></Head>`
      + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/"><Text>取り消します。</Text></Body></Report>`;
    const now = clock(Date.parse("2099-01-01T09:00:00+09:00"));
    const id40 = (prefix: string, index: number) => `${prefix}${String(index).padStart(39, "0")}`;
    let bounded = emptyState();
    for (let index = 0; index < 512; index++) for (const family of ["VXSE51", "VXSE52", "VXSE53", "VXSE61"])
      bounded = receive(bounded, decodeXml(cancelXml(family, id40("q", index), "1234567890"), family), now).state;
    for (let index = 0; index < 256; index++)
      bounded = receive(bounded, decodeXml(cancelXml("VXSE62", id40("l", index), "1234567890"), "VXSE62"), now).state;
    expect([bounded.earthquakes.length, bounded.longPeriods.length]).toEqual([512, 256]);
    expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(bounded))) as JsonValue).kind).toBe("restored");
    // 空白で長くした Serial の取消は trim した値で保存し（予約の式の 10 桁を超えない）、保存物を decode が受ける。
    const padded = receive(emptyState(), decodeXml(cancelXml("VXSE53", "PAD", `${" ".repeat(2_000)}1`), "VXSE53"), now);
    expect(eventOf(padded.state, "PAD", "training")!.contributions[0].source.serialRaw).toBe("1");
    expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(padded.state))) as JsonValue).kind).toBe("restored");
    // ReportDateTime の小数秒で 25 文字を超える報も拒否する。
    expect(decision(receive(emptyState(), decodeXml(cancelXml("VXSE53", "LONGTIME", "1", "2099-01-01T09:00:00.000000+09:00"), "VXSE53"), now)))
      .toMatchObject({ decision: "rejected", reason: "reportDateTimeInvalid" });
    // 契約境界: 桁の多い座標は Number() が Infinity になるので unknown にし、受信 → JSON の往復 → decode を通す（P3-C7-VALUE-UNKNOWN=A）。
    const huge = `+${"9".repeat(400)}`;
    const infinite = send(emptyState(), "32-35_04_03_240613_VXSE52", (xml) => xml.replace(/>\+[\d.]+\+[\d.]+-\d+\/</, `>${huge}${huge}-${"9".repeat(400)}/<`));
    expect(viewOf(infinite.state, "20100125161517")!.hypocenter).toMatchObject({ latitude: { kind: "unknown" }, longitude: { kind: "unknown" },
      depthKm: { kind: "unknown" } });
    expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(infinite.state))) as JsonValue).kind).toBe("restored");

    const restoredAt = Date.parse("2026-07-28T16:37:30+09:00");
    const restored = reduceSeismicUnit(emptyState(), { kind: "restore", persisted: seismicUnitCodec.encode(state), clock: clock(restoredAt) });
    expect(restored.intents).toEqual([]);
    expect(restored.state.intents).toEqual(state.intents.filter((item) => item.expiresAt > restoredAt));
    expect(restored.state.intents.length).toBeGreaterThan(0);
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-Q"] }]);
  });

  // 契約境界: 桁あふれの範囲（400 桁の 9＋以上）は P1 の materialValue が text に落とし（main 81649a97）、保存と復元を通る。
  // ae343ce6 の P1 は value=Infinity の range にするので、その版では skip する（統合担当が 81649a97 の上で通ることを確かめる）。
  it("P3-C7-T06 contractBoundary / AC06: an overflowing range value is kept as P1 text and survives encode, JSON and decode", (context) => {
    const at = clock(Date.parse("2099-01-01T09:00:00+09:00"));
    const step = receive(emptyState(), decodeXml(vxse53({ at: "2099-01-01T09:00:00+09:00", maxInt: `${"9".repeat(400)}以上` }), "VXSE53"), at);
    const maxInt = eventOf(step.state, "20990101000000")!.contributions[0].intensity!.maxInt;
    if (maxInt.kind === "range" && !Number.isFinite(maxInt.value)) context.skip();
    expect(maxInt).toMatchObject({ kind: "text" });
    expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(step.state))) as JsonValue).kind).toBe("restored");
  });

  // 実不具合の再発防止（台帳 73）: 受理の上限ちょうどの pending が配送の更新で伸びても、保存した世代を復元できる。
  it("P3-IUR-T02 regression / P3-IUR-AC01,AC03: pending admitted at its budget survives delivery updates, save and restore through the owner", () => {
    const now = clock(Date.parse("2099-01-01T09:00:00+09:00"));
    const raw = "2099-01-01T09:00:00+09:00";
    const next = decodeXml(vxse53({ at: raw, eventId: "20990101000022" }), "VXSE53");
    const pair = receive(emptyState(), next, now).intents;
    const held = receive(emptyState(), decodeXml(vxse53({ at: raw, eventId: "20990101000011" }), "VXSE53"), now).intents[0];
    const body = `${held.payload.body}境界`;
    const reserved = (items: readonly SeismicIntent[]) => items.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const padding = 131_072 - Buffer.byteLength(JSON.stringify([{ ...held, payload: { ...held.payload, body } }, ...pair])) - reserved([held, ...pair]);
    let admitted: SeismicUnitState | null = null;
    for (const extra of [0, 1]) {
      const padded = { ...held, payload: { ...held.payload, body: body + "x".repeat(padding + extra) } };
      expect(Buffer.byteLength(JSON.stringify([padded, ...pair])) + reserved([padded, ...pair])).toBe(131_072 + extra);
      const step = receive({ ...emptyState(), intents: [padded] }, next, now);
      // +1 byte では選択順の後ろの pending が 1 件置き換えられる（予約込みで上限を超えるため）。
      expect(pending(step.state).length).toBe(extra === 0 ? 3 : 2);
      if (extra === 0) admitted = step.state;
    }
    const roundTrip = (state: SeismicUnitState) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue);
    const first = roundTrip(admitted!);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-Q": first.state } };
    const update = (from: Parameters<typeof intentUpdateOwner>[0], split: boolean) => intentUpdateOwner(from, "U-Q", pending(from.units["U-Q"]!).map((item, index) => ({ ...item, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: split && index % 3 === 1 ? "superseded" as const : "pending" as const, lossReason: null })), now, linkedUnitTable);
    // 全 pending が最長へ伸びる更新（予約の不変条件、AC03）→ 3 件に 1 件が終端になる更新、のそれぞれの後で保存と復元ができる。
    const widened = update(owner, false);
    expect(widened.adopted).toBe(true);
    expect(roundTrip(widened.state.units["U-Q"]!).kind).toBe("restored");
    const grown = update(widened.state, true);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-Q"]!).kind).toBe("restored");
  });

  // acceptance: Q-NOTICE の地震分（AC08）。
  it("P3-C7-T07 acceptance / AC08: opportunities, level formula, replacement, body, capacity, intentUpdate, training, recovery", () => {
    const series = chain([F.s51a, F.s51b, F.s51c, F.s51d, F.s53a, F.s53b, F.s62, F.s61]);
    // 報自身の震度で決める: 震度 7 の震度速報・震源震度情報は critical（P3-QC-AC06）、20:30 の VXSE61 は normal、長周期階級 4 は critical。
    expect(series.map((step) => levels(step)[0])).toEqual([...Array(7).fill("desktop:critical"), "desktop:normal"]);
    expect(series[7].intents.map((item) => [item.payload.title, item.payload.body]))
      .toEqual([["顕著な地震の震源要素更新のお知らせ", "熊本県熊本地方 / M7.1"], ["顕著な地震の震源要素更新のお知らせ", "熊本県熊本地方 / M7.1"]]);
    expect(series[5].intents[0].payload.body).toBe("熊本県熊本地方 / M7.1 / 最大震度7");
    expect(series[6].intents[0].payload.body).toBe("熊本県熊本地方 / 長周期階級4 / 最大震度7");
    expect(series[0].intents.map((item) => [item.expiresAt - item.createdAt, item.nextAttemptAt - item.createdAt]))
      .toEqual([[180_000, 0], [60_000, 0]]);
    // 震度の無い VXSE52 は normal。5 弱以上未入電は critical（range lower 5、P3-QC-AC06）。
    expect(levels(send(emptyState(), "32-35_04_03_240613_VXSE52"))).toEqual(["desktop:normal", "sound:normal"]);
    expect(levels(send(emptyState(), "synthetic_phase4a_VXSE51_special"))).toEqual(["desktop:critical", "sound:critical"]);
    expect(send(emptyState(), "synthetic_phase4a_VXSE51_special").intents[0].payload.body).toBe("最大震度5弱以上");
    // revisionOnly・duplicate・stale では作らない。訂正は事実が同じでも作る。
    const first53 = send(emptyState(), F.s53a).state;
    expect(send(first53, F.s51a).intents).toEqual([]);
    expect(send(first53, F.s53a).intents).toEqual([]);
    // 訂正は後の送信（同じ Control/DateTime の訂正は未確認、P3-VM-AC03）。
    const sameFacts = send(first53, F.s53a, (xml) => sentLater(xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")));
    expect(decision(sameFacts)).toMatchObject({ decision: "changed", change: "revisionOnly" });
    expect(sameFacts.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")]))
      .toEqual([["critical", "[訂正] 震源・震度情報", true], ["critical", "[訂正] 震源・震度情報", true]]);
    // 取消: active だった family だけ。未受信の取消は作らない。
    expect(send(emptyState(), "synthetic_VXSE53_cancel").intents).toEqual([]);
    const cancel = send(series[5].state, "synthetic_VXSE53_cancel");
    expect(cancel.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body]))
      .toEqual([["cancel", "[取消] 震源・震度情報（熊本県熊本地方 16:35 発表）", "熊本県熊本地方 16:35 発表の震源・震度情報を取り消しました"], ["cancel", "[取消] 震源・震度情報（熊本県熊本地方 16:35 発表）", "熊本県熊本地方 16:35 発表の震源・震度情報を取り消しました"]]);
    // 置換（P3-C7-REPLACEMENT=A）: 同じ event・系統・channel の古い pending を置き換える。長周期は別系統。
    const pendingOf = (state: SeismicUnitState) => pending(state).map((item) => `${item.subject.split("/")[1]}:${item.channel}`);
    expect(pendingOf(series[6].state)).toEqual(["VXSE53:desktop", "VXSE53:sound", "VXSE62:desktop", "VXSE62:sound"]);
    // VXSE53 の取消は pending の VXSE51 の震度 7 の通知を消さない。
    const with51 = send(first53, F.s51a, (xml) => xml.replace(/2026-07-28T16:28:00\+09:00/g, "2026-07-28T16:33:00+09:00")).state;
    const fresh51 = send(emptyState(), F.s51d).state;
    const mixed: SeismicUnitState = { ...with51, intents: [...with51.intents.filter((item) => item.disposition !== "pending"),
      ...pending(fresh51)] };
    expect(pendingOf(send(mixed, "synthetic_VXSE53_cancel").state)).toEqual(["VXSE51:desktop", "VXSE51:sound", "VXSE53:desktop", "VXSE53:sound"]);
    // 満杯（128 件）: 同じ群の中で A7 の選択順の後ろのものを外す（新しい intent が外れることもある）。
    const seeded = (count: number, createdAt: number): SeismicIntent[] => Array.from({ length: count }, (_, index) => ({ ...series[0].intents[0],
      id: `seed-${index}`, subject: `normal/VXSE52/S${index}`, source: { ...series[0].intents[0].source, subject: `normal/VXSE52/S${index}`,
        family: "VXSE52" }, createdAt, expiresAt: createdAt + 180_000 }));
    const reported = Date.parse("2026-07-28T16:31:00+09:00");
    // 選択順は期限が先: 既存より期限の遅い desktop が外れ、期限の早い sound は既存の最後の 1 件を外して入る。
    const older = send({ ...emptyState(), intents: seeded(128, reported - 1000) }, F.s53a);
    expect(older.intents.map((item) => item.channel)).toEqual(["sound"]);
    expect(older.diagnostics).toMatchObject([{ reason: "notificationCapacityEvicted", count: 2 }]);
    const newer = send({ ...emptyState(), intents: seeded(128, reported + 500_000) }, F.s53a);
    expect(newer.intents).toHaveLength(2);
    expect(pending(newer.state)).toHaveLength(128);
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = series[0].intents;
    const updated = reduceSeismicUnit(series[0].state, { kind: "intentUpdate", clock: clock(reported), intentUpdate: [{ ...desktop, attempts: 1,
      nextAttemptAt: reported + 1_000, disposition: "pending", lossReason: null }, { id: "unknown", attempts: 1, nextAttemptAt: 0, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null }] });
    expect(updated.state.persistence.currentGeneration).toBe(series[0].state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(reduceSeismicUnit(updated.state, { kind: "intentUpdate", clock: clock(reported), intentUpdate: { ...desktop, attempts: 1,
      nextAttemptAt: reported + 1_000, disposition: "pending", lossReason: null } }).state).toBe(updated.state);
    // training/test は desktop だけ。
    const training = send(emptyState(), "32-35_01_03_240613_VXSE53");
    expect(training.intents.map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【訓練】震源・震度情報"]]);
    // origin=recovery（C16 発注 4a）は live と同じ意味を当てて intent を作らず（P3-REC-AC12・UNIT-ENTRANCE=A、live では critical）、
    // 版が決まらない本文は印も WARN も置かずに noChange（owner が held にする、P3-REC-AC05 の (a)）。
    const recovery = receive(first53, decodeXml(fixtureXml(F.s53b), "VXSE53", "recovered", "recovery"), clock(reported)), unsure = receive(first53, decodeXml(fixtureXml(F.s53a).replace("<Name>熊本県熊本地方</Name>", "<Name>別の震央</Name>"), "VXSE53", "unsure", "recovery"), clock(reported));
    expect([decision(recovery).decision, facts(recovery.state), recovery.intents]).toEqual(["changed", facts(receive(first53, decodeXml(fixtureXml(F.s53b), "VXSE53"), clock(reported)).state), []]);
    expect([unsure.state === first53, unsure.decisions, unsure.diagnostics]).toEqual([true, [expect.objectContaining({ decision: "unchanged", reason: "noChange" })], []]);
    // 復元直後の続報は復元した state との差で決める（同じ報は duplicate で鳴らさない）。
    const restored = reduceSeismicUnit(emptyState(), { kind: "restore", persisted: seismicUnitCodec.encode(first53), clock: clock(reported + 1) }).state;
    expect(send(restored, F.s53a).intents).toEqual([]);
    expect(levels(send(restored, F.s53b))).toEqual(["desktop:critical", "sound:critical"]);
  });

  // corpusHistory: expectedDecisions の 14 step・O07:1〜4・E13（AC10）。
  it("P3-C7-T09 corpusHistory / AC10: O01:49-55, O02:26-38, O07:1-5 and the E13 population", () => {
    const o01 = replay("O01", 49, 55);
    // :52 の訂正は強震保持を保ち until を延ばさない（震度 7 の訂正は critical、P3-QC-AC06）。:53 の取消は同じ subject の pending を
    // 両 channel とも置き換え、強震保持を外す。
    expect(eventOf(o01[3].state)!.strongHold).toEqual(eventOf(o01[1].state)!.strongHold);
    expect(o01[3].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["critical", "[訂正] 震源・震度情報"],
      ["critical", "[訂正] 震源・震度情報"]]);
    expect(pending(o01[4].state).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    // P3-QC-AC07: 全部の寄与が取消になった地震は取消の印を付けて一覧に残り、その日の件数から引いて最大震度を数え直す。
    expect(eventOf(o01[4].state)!.strongHold).toBeNull();
    expect(toSeismicView(o01[4].state).earthquakes).toMatchObject([{ sources: [], cancelledSummary: { hypocenterName: "熊本県熊本地方" } }]);
    expect(o01[4].state.daily.normal).toMatchObject({ count: 0, maxInt: null, counted: [] });
    expect(o01[2].state.daily.normal.count).toBe(1);
    const o02 = replay("O02", 26, 38);
    expect(o02[12].intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
    expect(eventOf(o02[12].state, "P0-ZERO")!.contributions[0].intensity!.items.filter((item) => item.level === "station").map((item) => item.maxInt))
      .toMatchObject([{ kind: "number", value: 0 }, { kind: "empty" }, { kind: "missing" }, { kind: "unknown" }, { kind: "range", bound: "lower", value: 5 }]);
    expect(viewOf(o02[3].state, "20260809000300")!.hypocenter!.depthKm).toEqual({ kind: "missing" });
    expect(viewOf(o02[5].state, "20260809000200")!.hypocenter!.depthKm).toMatchObject({ kind: "number", value: 0 });
    expect(viewOf(o02[7].state, "20260809000400")!.hypocenter!.depthKm).toMatchObject({ kind: "range", bound: "lower", value: 600 });
    expect(viewOf(o02[9].state, "20260809000100")!.hypocenter!.magnitude).toMatchObject({ kind: "unknown" });
    const o07 = replay("O07", 1, 5);
    // :4 復元（時計 16:31:01）で震度 7 と元の絶対期限を維持し、:5 の unknown の続報で外さず延ばさない。level は info。
    expect(eventOf(o07[3].state)!.strongHold).toEqual(eventOf(o07[1].state)!.strongHold);
    expect(eventOf(o07[3].state)!.retainUntil).toBe(eventOf(o07[1].state)!.retainUntil);
    expect(eventOf(o07[4].state)!.strongHold).toMatchObject({ until: ORIGIN + 12 * HOUR });
    expect(o07[4].intents.map((item) => item.payload.level)).toEqual(["info", "info"]);
    expect(o07[4].state.daily.normal).toMatchObject({ count: 1, maxInt: { value: 7 } });

    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-Q に無い。
    const groups: Record<string, string[]> = { changed: [], rejected: [] };
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceSeismicUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      groups[decision(step).decision === "changed" ? "changed" : "rejected"].push(id);
    }
    // synthetic_phase4a_VXSE61_special は Magnitude を持たないが、設計メモ §13 の欠けとして受ける（P3-QC-AC09 (3)）。
    expect(groups.rejected).toEqual([]);
    expect(groups.changed).toHaveLength(38);
  });

  // contractBoundary: 期限の境界（P3-C7-SEM-01・02、I-U-Q.deadlines、AC02〜AC04）。
  it("P3-C7-T11 contractBoundary / AC02,AC03,AC04: 24 h event, 36 h long period, overdue adoption and not-due deadlines", () => {
    const adopted = send(emptyState(), "32-35_04_04_240613_VXSE53").state;
    const reported = Date.parse("2010-01-25T16:19:00+09:00");
    const event = eventOf(adopted, "20100125161517")!;
    expect(event.retainUntil).toBe(reported + 24 * HOUR);
    const quiet = reduceSeismicUnit(adopted, { kind: "deadline", clock: clock(reported + 180_000) }).state;
    const dayBefore = reduceSeismicUnit(quiet, { kind: "deadline", clock: clock(reported + 24 * HOUR - 60_000) });
    // 当日履歴の 0 時は 24 時間の前に来るので、event だけを見る。
    expect(dayBefore.state.earthquakes).toBe(reduceSeismicUnit(quiet, { kind: "deadline", clock: clock(Date.parse("2010-01-26T00:00:00+09:00")) }).state.earthquakes);
    expect(dayBefore.state.earthquakes).toEqual(quiet.earthquakes);
    // P3-QC-AC08: 24 時間で期限切れの記憶になり（view から消え、通知しない）、さらに 6 時間で記憶ごと消える（P3-QC-T05 が境界を見る）。
    const gone = reduceSeismicUnit(quiet, { kind: "deadline", clock: clock(reported + 24 * HOUR) });
    expect(gone.state.earthquakes.map((item) => item.contributions.map((entry) => entry.effective))).toEqual([["expired"]]);
    expect([gone.intents, gone.displayChanges.map((item) => item.after)]).toEqual([[], [null]]);
    expect(reduceSeismicUnit(gone.state, { kind: "deadline", clock: clock(reported + 30 * HOUR) }).state.earthquakes).toEqual([]);
    const lg = send(emptyState(), "selected_xml/78_01_01_240613_VXSE62").state;
    const lgAt = Date.parse("2020-11-21T02:33:10+09:00");
    expect(reduceSeismicUnit(lg, { kind: "deadline", clock: clock(lgAt + 36 * HOUR - 60_000) }).state.longPeriods.map((item) => item.effective))
      .toEqual(["active"]);
    expect(reduceSeismicUnit(lg, { kind: "deadline", clock: clock(lgAt + 36 * HOUR) }).state.longPeriods.map((item) => item.effective))
      .toEqual(["expired"]);
    // 到着の時点で期限を過ぎた報は採用して同じ reduce で回収する（view に載らず通知もしない）。当日履歴には入る。
    const overdue = send(emptyState(), "32-35_04_04_240613_VXSE53", undefined, reported + 25 * HOUR);
    expect(decision(overdue)).toMatchObject({ decision: "changed" });
    expect([overdue.state.earthquakes, overdue.intents, overdue.displayChanges]).toEqual([[], [], []]);
    expect(overdue.state.daily.normal.count).toBe(1);
    // 到来していない deadline 入力は同じ state 参照と空の結果。
    const notDue = reduceSeismicUnit(quiet, { kind: "deadline", clock: clock(reported + 200_000) });
    expect(notDue.state).toBe(quiet);
    expect([notDue.decisions, notDue.outcomes, notDue.displayChanges, notDue.intents, notDue.diagnostics]).toEqual([[], [], [], [], []]);
  });

  // 版の比較（P3-REVISION-ORDER-001）: 32-35_08_03 の VXSE51 を t−60 秒の初報にし、同じ時刻 t の Serial と InfoType だけを替えた報を当てる。
  const ORDER_FILE = "32-35_08_03_100915_VXSE51", ORDER_AT = Date.parse("2010-07-05T06:58:00+09:00");
  const ordered = () => send(emptyState(), ORDER_FILE, replaceTag("ReportDateTime", "2010-07-05T06:57:00+09:00")).state;
  const version = ([serial, infoType]: readonly [string, string]) =>
    decodeFixture(ORDER_FILE, (xml) => replaceTag("InfoType", infoType)(replaceTag("Serial", serial)(xml)));
  const verdict = (step: SeismicUnitStep) => step.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision);
  const contributionOf = (state: SeismicUnitState) => eventOf(state, "20100705065511")?.contributions.find((item) => item.family === "VXSE51");
  const encodeDecode = (state: SeismicUnitState) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue);

  // regression（監査 F02）: 同時刻（同じ Control/DateTime）の Serial 2 の発表・Serial 空の訂正・Serial 1 の取消は、報番号と InfoType の順位を
  // 比べず（P3-VM-D-SAMETIME=A）、同じ時刻の取消が勝つので（作者裁定 2026-10-21 昼）、6 順列とも各手順の前に復元を挟んでも取消で終わる。
  it("P3-ORDER-T01 regression / AC02: the F02 triple ends in the Serial 1 cancel in all 6 orders, with and without a restore before each step", () => {
    const first = ordered();
    const reports = { A: version(["2", "発表"]), B: version(["", "訂正"]), C: version(["1", "取消"]) };
    // owner の復元と同じく、保存物（encode→JSON）を保存世代を引き継いだ state へ restore で戻す。
    const restart = (state: SeismicUnitState) => {
      const decoded = encodeDecode(state);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      const generation = state.persistence.currentGeneration;
      return reduceSeismicUnit({ ...emptyState(), persistence: { kind: "saved", currentGeneration: generation, savedGeneration: generation,
        savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, { kind: "restore", persisted: seismicUnitCodec.encode(decoded.state),
        clock: clock(ORDER_AT) }).state;
    };
    const finals = [false, true].flatMap((restarting) => ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"].map((order) => [...order].reduce(
      (state, key) => receive(restarting ? restart(state) : state, reports[key as keyof typeof reports], clock(ORDER_AT)).state, first)));
    // 同じ時刻の取消は、どの順でも訂正と発表に勝つ（作者裁定 2026-10-21 昼）。取消の採用で印は外れ、取消の後の取消でない報は stale。
    expect(finals.map((state) => [contributionOf(state)?.source.inputId, contributionOf(state)?.unconfirmed, encodeDecode(state).kind]))
      .toEqual(Array(12).fill([reports.C.inputId, undefined, "restored"]));
  });

  // contractBoundary: 同時刻（同じ Control/DateTime）の 2 報は InfoType と Serial を比べず、取消は取消でない報に勝ち（作者裁定 2026-10-21 昼）、
  // ほかは中身（InfoType を含む）が違えば到着順によらず
  // 先着を残して未確認の印、同じなら Serial が違っても duplicate（P3-VM-D-SAMETIME=A。P3-VM-AC09(1) で K1 の表を置き換える）。
  it("P3-ORDER-T02 contractBoundary / AC01,AC03: same-time reports keep the first arrival and mark a different one, in both orders", () => {
    const first = ordered();
    // [一方, 他方, 中身が違うか]
    const rows: [readonly [string, string], readonly [string, string], boolean][] = [
      [["9", "発表"], ["1", "訂正"], true], [["", "訂正"], ["1", "取消"], true], [["2", "発表"], ["1", "発表"], false], [["", "発表"], ["1", "発表"], false],
      [["", "発表"], ["", "発表"], false]];
    for (const [one, other, differs] of rows) for (const [early, late] of [[one, other], [other, one]] as const) {
      const lateMaterial = version(late);
      const step = receive(receive(first, version(early), clock(ORDER_AT)).state, lateMaterial, clock(ORDER_AT));
      // 取消がどちらか一方だけなら取消が勝つ（作者裁定 2026-10-21 昼）。ほかの中身違いは先着を残して後着を印にする。
      const cancelWins = (early[1] === "取消") !== (late[1] === "取消"), lateWins = cancelWins && late[1] === "取消";
      const held = differs && !cancelWins;
      expect([verdict(step), step.diagnostics.map((item) => item.reason), [contributionOf(step.state)?.source.serialRaw,
        contributionOf(step.state)?.source.infoTypeRaw], contributionOf(step.state)?.unconfirmed?.inputId], `${early}→${late}`)
        .toEqual([[lateWins ? "changed" : differs ? "stale" : "duplicate"], held ? ["seismicRevisionConflict"] : [], lateWins ? late : early,
          held ? lateMaterial.inputId : undefined]);
    }
  });

  // regression（監査 F05・F16）: 満杯の event 512・長周期 256 に到着の時点で期限を過ぎた別の EventID を受けても有効な記録を退去せず、
  // 最終の state に無い subject を accepted・currentEstablished・表示に出さない（P3-FINAL-AC01・AC02）。当日履歴だけが変われば保存する。
  it("P3-FINAL-T01 regression / F05・F16: an expired newcomer evicts nothing and is not reported as current", () => {
    const t = Date.parse("2026-01-01T10:00:00+09:00");
    const at = (ms: number) => new Date(ms + 9 * HOUR).toISOString().replace(".000Z", "+09:00");
    for (const [file, count, late, list, saved] of [["32-35_08_03_100915_VXSE51", 512, 25 * HOUR, "earthquakes", 1],
      ["selected_xml/78_01_01_240613_VXSE62", 256, 37 * HOUR, "longPeriods", 0]] as const) {
      const report = (id: number, time: number) => decodeFixture(file, (xml) => replaceTag("ReportDateTime", at(time))(
        replaceTag("EventID", String(id).padStart(14, "0"))(xml)));
      let state = emptyState();
      for (let id = 1; id <= count; id++) state = receive(state, report(id, t), clock(t)).state;
      const step = receive(state, report(count + 1, t - late), clock(t));
      expect(step.state[list]).toEqual(state[list]);
      expect(step.decisions).toEqual([expect.objectContaining({ decision: "changed", change: "revisionOnly", currentEstablished: null })]);
      expect([step.outcomes, step.intents, step.displayChanges, step.diagnostics]).toEqual([[{ kind: "accepted", change: "revisionOnly", subjects: [] }], [], [], []]);
      expect(step.state.persistence.currentGeneration - state.persistence.currentGeneration).toBe(saved);
    }
  });
});

// P3-CURRENCY-COVERAGE-001（C1）の U-Q: 容量の拒否の印（family ごと・長周期）、系統の desktop の title、失敗警報。
describe("P3-CURRENCY-COVERAGE-001 U-Q", () => {
  const QUAKE = "20100125161517", FAIL = "normal/capacityRejected";
  const T52 = "2010-01-25T16:18:00+09:00", T53 = "2010-01-25T16:19:00+09:00";
  const s52 = () => decodeFixture("32-35_04_03_240613_VXSE52");
  const s53 = (at = T53) => decodeFixture("32-35_04_04_240613_VXSE53", (xml) => xml.replace(new RegExp(T53.replace("+", "\\+"), "g"), at));
  // 32-35_04_03 と同じ地震の VXSE51（phase7_5 の報の EventID と時刻を置き換え、強震保持を作らない震度 3 にした境界入力）。
  const s51 = (at: string) => decodeFixture(F.s51a, (xml) => replaceTag("EventID", QUAKE)(xml)
    .replace(/2026-07-28T16:2[78]:00\+09:00/g, at).replace(/<MaxInt>7<\/MaxInt>/g, "<MaxInt>3</MaxInt>"));
  const atOf = (iso: string, plus = 0) => clock(Date.parse(iso) + plus);
  const notices = (state: SeismicUnitState) => state.intents.filter((item) => item.subject === FAIL);
  const generation = (state: SeismicUnitState) => serializedEnvelope({ schemaVersion: "p3-seismic-unit-v4", unit: "U-Q", generation: 0,
    capturedAt: 0, payload: seismicUnitCodec.encode(state) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES
    + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES + pending(state).reduce((sum, item) => sum + deliveryGrowth(item), 0);
  // 世代を器の上限 − slack にする。normal の受理は普通は退去で収まるので、退去の候補にならない記録だけで埋める: 観測点を持たない守る地震
  // （guard の on 1、P3-QC-D-SMALL-PUSH=B で守らない報のためには退去しない）、取消記憶だけの記録（長周期は通知の印つき）と当日履歴（予約の内、crowd）、
  // 他の系統の pending（終端記録は P3-NL-AC05 で無くなった）。
  const pad = (now: number) => {
    const iso = new Date(now).toISOString();
    const source = (family: string, eventId: string, extra: Partial<EarthquakeContribution["source"]> = {}) => ({ inputId: "pad",
      origin: "replay" as const, operation: "normal" as const, family, subject: `normal/${family}/${eventId}`, reportDateTimeRaw: iso,
      controlDateTimeRaw: iso, serialRaw: "1", infoTypeRaw: "発表", ...extra });
    const hold = (headline: string): EarthquakeEvent => ({ eventId: "99990101000001", operation: "normal", retainUntil: now + 24 * HOUR,
      guard: { from: now, on: 1 },
      strongHold: { originTimeRaw: iso, until: now + 12 * HOUR, establishedBy: { family: "VXSE53", reportDateTimeRaw: iso, serialRaw: "1",
        infoTypeRaw: "発表" } },
      contributions: [{ family: "VXSE52", source: source("VXSE52", "99990101000001"), effective: "active", targetDateTimeRaw: iso, title: "pad",
        headline, hypocenter: null, intensity: null, tsunamiComment: null }] });
    const intent = (id: string, disposition: SeismicIntent["disposition"], body: string): SeismicIntent => ({ id, unit: "U-Q",
      subject: "normal/VXSE52/99990101000003", operation: "normal", source: source("VXSE52", "99990101000003"), transition: "activated",
      channel: "desktop", payload: { domain: "earthquake-eew", level: "normal", title: "pad", body }, createdAt: now, expiresAt: now + HOUR,
      nextAttemptAt: now, attempts: 0, configRevision: "test", disposition, lastAttempt: null, replayed: false, priorityGroup: "other" as const });
    const holdSize = (headline: string) => Buffer.byteLength(JSON.stringify(hold(headline)));
    // 大きさは K11 の前の強震保持の事実の予算（HOLD_FACTS_BYTES）に、器を広げた MEMORY_GROWTH を足したもの。
    const size = 2_574_775 + HOLD_GROWTH + CONTRIBUTION_MARKS + MEMORY_GROWTH;
    return { held: hold("x".repeat(size - holdSize(""))), pending: intent("U-Q:pad:pending", "pending", "x".repeat(124_000)) };
  };
  // 予約の側（取消記憶だけの event・長周期と training・test の当日履歴）は、読み戻しの上限（inputId 64 文字、P3-VM-AC08）の内の記録で埋め、
  // 最後に inputId を削って世代を max − slack ちょうどにする。件数は上限の内に収め、続く受信で件数の退去が起きないようにする。
  const crowd = (state: SeismicUnitState, slack: number, now: number): SeismicUnitState => {
    const { held, pending: waiting } = pad(now);
    const notice = { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"] as const, evidence: "unattempted" as const };
    const reserve = budgetState(now);
    const widen = (source: EarthquakeContribution["source"], length = 64) => ({ ...source, inputId: "i".repeat(length), origin: "recovery" as const });
    const template = reserve.earthquakes[0];
    const memoryEvent = (index: number, length = 64): EarthquakeEvent => {
      const eventId = `m${String(index).padStart(39, "0")}`;
      return { ...template, eventId, retainUntil: now + 24 * HOUR, contributions: template.contributions.map(({ notice: _notice, ...item }) => ({ ...item,
        source: widen({ ...item.source, subject: `${item.source.operation}/${item.family}/${eventId}` }, length) })) };
    };
    const periods = reserve.longPeriods.filter((item) => item.effective === "cancelled")
      .slice(0, 256 - state.longPeriods.length).map((item) => ({ ...item, notice, retainUntil: now + 24 * HOUR, source: widen(item.source) }));
    const count = 512 - state.earthquakes.length - 1;
    const fill = (lengths: readonly number[]): SeismicUnitState => ({ ...state,
      earthquakes: [...state.earthquakes, held, ...lengths.map((length, index) => memoryEvent(index, length))],
      longPeriods: [...state.longPeriods, ...periods], daily: { ...state.daily, training: reserve.daily.training, test: reserve.daily.test },
      intents: [...state.intents, waiting] });
    const lengths = Array.from({ length: count }, () => 64);
    let excess = generation(fill(lengths)) - (seismicUnitCodec.maxEnvelopeBytes! - slack);
    expect(excess).toBeGreaterThanOrEqual(0);
    // 1 文字削ると 4 寄与の inputId で 4 byte 減る。端数は最後の event の 1 寄与を別に削れないので、event ごとに 4 の倍数で削り、残りは長周期で合わせる。
    for (let index = 0; index < count && excess >= 4; index++) {
      const cut = Math.min(63, Math.floor(excess / 4));
      lengths[index] -= cut;
      excess -= cut * 4;
    }
    for (let index = 0; index < excess; index++) periods[index] = { ...periods[index], source: widen(periods[index].source, 63) };
    const crowded = fill(lengths);
    expect(generation(crowded)).toBe(seismicUnitCodec.maxEnvelopeBytes! - slack);
    // 取消記憶だけの記録と当日履歴の予約（RESERVE_BYTES）の内。
    const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(crowded.earthquakes.filter((item) => item.contributions.every((entry) => entry.effective === "cancelled")).reduce((sum, item) => sum + sizeOf(item), 0)
      + crowded.longPeriods.filter((item) => item.effective === "cancelled").reduce((sum, item) => sum + sizeOf(item), 0) + sizeOf(crowded.daily))
      .toBeLessThanOrEqual(RESERVE_BYTES);
    return crowded;
  };
  const free = (state: SeismicUnitState): SeismicUnitState => ({ ...state,
    earthquakes: state.earthquakes.filter((item) => !item.eventId.startsWith("m")) });
  const refused53 = () => {
    const adopted = receive(emptyState(), s52(), atOf(T52));
    expect(decision(adopted).decision).toBe("changed");
    // P3-QC-AC03: 守らない target は畳んでから入るかを見るので、slack は畳んだ VXSE53（約 15 KB）より小さくする。
    return { adopted: adopted.state, refused: receive(crowd(adopted.state, 10_000, Date.parse(T53)), s53(), atOf(T53)) };
  };

  it("P3-CC-T13 acceptance / AC03・AC04・AC10: a VXSE53 refused by bytes marks its family, warns, and stamps the VXSE52 desktop title", () => {
    const { adopted, refused } = refused53();
    expect(decision(refused)).toEqual({ subject: `normal/VXSE53/${QUAKE}`, operation: "normal", decision: "changed", reason: null,
      change: "semantic", currentEstablished: null });
    const event = eventOf(refused.state, QUAKE)!;
    expect(event.contributions.map((item) => item.family)).toEqual(["VXSE52"]);
    expect(event.unavailable).toMatchObject([{ reason: "capacityExceeded", source: { family: "VXSE53", reportDateTimeRaw: T53 } }]);
    expect(viewOf(refused.state, QUAKE)?.unavailable).toEqual(event.unavailable);
    // 最大震度 4 の報なので warning の失敗警報（desktop と sound）。系統の VXSE52 の pending は置き換わらず、desktop の title にだけ時刻。
    expect(notices(refused.state).map((item) => [item.channel, item.payload.level, item.disposition])).toEqual([
      ["desktop", "warning", "pending"], ["sound", "warning", "pending"]]);
    expect(notices(refused.state)[0].payload.title).toMatch(/^【処理できていません】.+（16:19 発表）$/);
    const line = (state: SeismicUnitState) => pending(state).filter((item) => item.subject === `normal/VXSE52/${QUAKE}`)
      .map((item) => [item.id, item.channel, item.payload.title]);
    expect(line(refused.state)).toEqual(line(adopted).map(([id, channel, title]) => [id, channel,
      channel === "desktop" ? `【16:18 発表】${title}` : title]));
    expect(refused.diagnostics.map((item) => item.reason)).toEqual(["capacityRejected"]);
    // 同じ VXSE53 の採用（場所が空いた後）で印が消える。
    const cleared = receive(free(refused.state), s53(), atOf(T53, 1_000));
    expect(decision(cleared).decision).toBe("changed");
    expect(eventOf(cleared.state, QUAKE)).not.toHaveProperty("unavailable");
  });

  it("P3-CC-T04 contractBoundary / AC03(3): an event mark stays on another family's or an older adoption of its family", () => {
    const { refused } = refused53();
    const other = receive(refused.state, s51("2010-01-25T16:17:30+09:00"), atOf(T53, 1_000));
    expect(decision(other).decision).toBe("changed");
    expect(eventOf(other.state, QUAKE)?.unavailable).toEqual(eventOf(refused.state, QUAKE)?.unavailable);
    const older = receive(free(other.state), s53("2010-01-25T16:18:30+09:00"), atOf(T53, 2_000));
    expect(decision(older).decision).toBe("changed");
    expect(eventOf(older.state, QUAKE)?.contributions.map((item) => item.family)).toEqual(["VXSE51", "VXSE52", "VXSE53"]);
    expect(eventOf(older.state, QUAKE)?.unavailable).toEqual(eventOf(refused.state, QUAKE)?.unavailable);
  });

  it("P3-CC-T04 contractBoundary / AC03(2): a VXSE53 no newer than its family mark is covered by it and does not unconfirm the unit", () => {
    const { refused } = refused53();
    // 同じ報の再送と、印より古い同じ family の報。どちらも印が覆うので負の証拠を返さず、decision は capacityExceeded のまま。
    for (const at of [T53, "2010-01-25T16:18:30+09:00"]) {
      const again = receive(refused.state, s53(at), atOf(T53, 1_000));
      expect(decision(again)).toEqual({ subject: `normal/VXSE53/${QUAKE}`, operation: "normal", decision: "capacityExceeded" });
      expect(again.confirmationEvidence).toEqual([]);
      expect(again.state).toBe(refused.state);
    }
  });

  // P3-NL-AC05 (2): 終端記録の予算（131,072）は無くなったので、昇格の失敗警報が軽い失敗警報を置き換えて入る行だけを残す。
  it("P3-CC-T17 contractBoundary / AC10(5): a refused promotion replaces the lighter failure notice, which leaves the intents", () => {
    // 軽い（warning の）失敗警報が待つ state から、退去の候補になる記録（この地震の event）を外す。残るのは退去できない詰め物だけなので、
    // 長周期の新しい報は byte の上限で拒否になる。
    const { refused } = refused53();
    const base: SeismicUnitState = { ...refused.state, earthquakes: refused.state.earthquakes.filter((item) => item.eventId !== QUAKE) };
    // 長周期の critical（階級 4）の新しい報（F.s62 をこの地震へ移した境界入力）。見出しを伸ばして byte の上限で拒否させる。
    // 階級 4 は守る報なので、発生時刻をこの地震（詰め物の守る地震より前）に移し、詰め物を第 6 段で消せないようにする（P3-QC-AC02 (1) の (6)）。
    const lg = () => decodeFixture(F.s62, (xml) => replaceTag("EventID", QUAKE)(xml)
      .replace(/2026-07-28T16:37:00\+09:00/g, "2010-01-25T16:20:00+09:00").replace(/2026-07-28T16:27:00\+09:00/g, "2010-01-25T16:15:00+09:00")
      .replace(/<Headline>\s*<Text>/, `<Headline><Text>${"長".repeat(10_000)}`));
    const promoted = receive(base, lg(), atOf(T53, 60_000));
    expect(decision(promoted).decision).toBe("capacityExceeded");
    expect(notices(promoted.state).map((item) => [item.payload.level, item.disposition])).toEqual([["critical", "pending"], ["critical", "pending"]]);
  });

  it("P3-CC-T14 contractBoundary / AC03(4)・AC02: an older cancel of a marked long period drops the mark into the unit's unconfirmed", () => {
    const T0 = "2099-01-01T09:00:00+09:00";
    const lg = (minute: number, serial: number, transform: (xml: string) => string = (xml) => xml) => decodeFixture(
      "synthetic_phase4a_VXSE62_special", (xml) => transform(replaceTag("EventID", "20990101000001")(xml)
        .replace(/2026-08-01T21:02:00\+09:00/g, `2099-01-01T09:0${minute}:00+09:00`).replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`)));
    const first = receive(emptyState(), lg(0, 1), atOf(T0));
    expect(decision(first).decision).toBe("changed");
    const crowded = crowd(first.state, 20_000, Date.parse(T0));
    const wide = lg(2, 3, (xml) => xml.replace("<Text>Phase 4A synthetic</Text>", `<Text>${"長".repeat(10_000)}</Text>`));
    const refused = receive(crowded, wide, atOf(T0, 120_000));
    expect(refused.state.longPeriods[0].unavailable).toMatchObject({ reason: "capacityExceeded", source: { serialRaw: "3" } });
    expect(refused.confirmationEvidence).toEqual([]);
    const cancel = receive(refused.state, lg(1, 2, (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
      .replace(/<Body([^>]*)>[\s\S]*<\/Body>/, "<Body$1><Text>取消</Text></Body>")), atOf(T0, 180_000));
    expect(decision(cancel).decision).toBe("changed");
    expect(cancel.state.longPeriods[0]).toMatchObject({ effective: "cancelled", source: { serialRaw: "2" } });
    expect(cancel.state.longPeriods[0]).not.toHaveProperty("unavailable");
    expect(cancel.confirmationEvidence).toEqual([{ source: "capacityExceeded", scopes: [{ unit: "U-Q", operation: "normal", kind: "unit" }] }]);
  });

  it("P3-CC-T09 contractBoundary / AC05: U-Q round-trips event and long-period marks and failure notices, and rejects foreign marks", () => {
    const roundTrip = (state: SeismicUnitState) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue);
    const { refused } = refused53();
    const restored = roundTrip(refused.state);
    if (restored.kind !== "restored") throw new Error("marked state does not restore");
    expect([restored.state.earthquakes, restored.state.intents]).toEqual([refused.state.earthquakes, refused.state.intents]);
    type Row = Record<string, unknown>;
    const value = JSON.parse(JSON.stringify(seismicUnitCodec.encode(refused.state))) as { earthquakes: Row[]; longPeriods: Row[]; intents: Row[] };
    const quake = value.earthquakes[0], mark = (quake.unavailable as Row[])[0], source = mark.source as Row;
    const markOf = (family: string) => ({ ...mark, source: { ...source, family, subject: `normal/${family}/${QUAKE}` } });
    // 4 family の印と長周期の印も読み戻す。
    const fourMarks = { ...value, earthquakes: [{ ...quake, unavailable: ["VXSE51", "VXSE52", "VXSE53", "VXSE61"].map(markOf) }, ...value.earthquakes.slice(1)] };
    expect(seismicUnitCodec.decode(fourMarks as JsonValue).kind).toBe("restored");
    const lgState = send(emptyState(), "synthetic_phase4a_VXSE62_special").state;
    const lg = JSON.parse(JSON.stringify(seismicUnitCodec.encode(lgState))) as typeof value;
    const lgSubject = lg.longPeriods[0], lgMark = { reason: "capacityExceeded", source: lgSubject.source };
    expect(seismicUnitCodec.decode({ ...lg, longPeriods: [{ ...lgSubject, unavailable: lgMark }] } as JsonValue).kind).toBe("restored");
    const withMarks = (marks: unknown) => ({ ...value, earthquakes: [{ ...quake, unavailable: marks }, ...value.earthquakes.slice(1)] });
    const notice = value.intents.find((item) => item.subject === FAIL)!;
    const invalid: [string, unknown][] = [
      ["reason", withMarks([{ ...mark, reason: "historyUnavailable" }])],
      ["source missing", withMarks([{ reason: "capacityExceeded" }])],
      ["other operation", withMarks([{ ...mark, source: { ...source, operation: "training", subject: `training/VXSE53/${QUAKE}` } }])],
      ["other EventID", withMarks([{ ...mark, source: { ...source, subject: "normal/VXSE53/20990101000099" } }])],
      ["VXSE62 on an event", withMarks([markOf("VXSE62")])],
      ["duplicate family", withMarks([mark, mark])],
      ["five marks", withMarks([...["VXSE51", "VXSE52", "VXSE53", "VXSE61"].map(markOf), mark])],
      ["empty marks", withMarks([])],
      ["memory-only event", { ...value, earthquakes: value.earthquakes.map((item) => String(item.eventId).startsWith("m")
        ? { ...item, unavailable: [{ ...mark, source: { ...source, operation: "training", subject: `training/VXSE53/${String(item.eventId)}` } }] } : item) }],
      ["cancelled long period", { ...lg, longPeriods: [{ ...lgSubject, effective: "cancelled", title: "", headline: null, hypocenter: null,
        intensity: null, unavailable: lgMark }] }],
      ["notice of another operation", { ...value, intents: [...value.intents, { ...notice, id: "x", source: { ...(notice.source as Row),
        operation: "training", subject: `training/VXSE53/${QUAKE}` } }] }],
      ["notice of another unit", { ...value, intents: [...value.intents, { ...notice, id: "y", source: { ...(notice.source as Row),
        family: "VTSE41", subject: "normal/VTSE41/20990101000012" } }] }],
    ];
    for (const [label, payload] of invalid) expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(payload)) as JsonValue).kind, label).toBe("invalid");
  });

  // P3-NL-AC08 (1)(4)・AC15 (4): 失敗警報の started も復元で外れ、もう一方は戻る。
  it("P3-NL-T07 contractBoundary / AC08・AC15 (4): a started failure notice is dropped at restore and the other one returns", () => {
    const { refused } = refused53();
    const [desktop, sound] = notices(refused.state);
    expectRestoreStarted({ intents: [desktop, sound], make: (intents) => ({ ...refused.state, intents }),
      restore: (state, at) => reduceSeismicUnit(emptyState(), { kind: "restore", persisted: seismicUnitCodec.encode(state), clock: at }) });
  });

  it("P3-CC-T19 regression / AC10(9): an older VXSE51 replaces the line's pending but not the failure notice, and VXSE53 still notifies on adoption", () => {
    const { refused } = refused53();
    const warned = notices(refused.state);
    const older = receive(refused.state, s51("2010-01-25T16:17:30+09:00"), atOf(T53, 1_000));
    expect(older.intents.map((item) => item.subject)).toEqual([`normal/VXSE51/${QUAKE}`, `normal/VXSE51/${QUAKE}`]);
    // P3-NL-AC05 (1): 置き換えた系統の pending は intents から外れる。
    expect(older.state.intents.filter((item) => item.subject === `normal/VXSE52/${QUAKE}`)).toEqual([]);
    expect(notices(older.state)).toEqual(warned);
    const adopted = receive(free(older.state), s53(), atOf(T53, 2_000));
    expect(adopted.intents.map((item) => [item.subject, item.payload.level])).toEqual([
      [`normal/VXSE53/${QUAKE}`, "warning"], [`normal/VXSE53/${QUAKE}`, "warning"]]);
    expect(notices(adopted.state)).toEqual(warned);
  });
});

// P3-C7-CAPACITY-BUDGET=A の同時最大状態（I-U-Q.capacityReserve の文字列長の上限で組む）。
function budgetState(now: number): SeismicUnitState {
  // EventID は上限の 40 byte（Q-ENUM.identity）。当日履歴の文字列は上限の長さを 3 byte の文字で埋める（最悪の byte）。
  const id40 = (prefix: string, index: number) => `${prefix}${String(index).padStart(39, "0")}`;
  const wide = (length: number) => "震".repeat(length);
  const source = (operation: Operation, family: string, eventId: string, infoTypeRaw: string) => ({ inputId: `input-${"9".repeat(16)}`,
    origin: "replay" as const, operation, family, subject: `${operation}/${family}/${eventId}`,
    // JMA の ReportDateTime の形（25 文字）。
    reportDateTimeRaw: new Date(now - 1000 + 32_400_000).toISOString().replace(".000Z", "+09:00"),
    controlDateTimeRaw: new Date(now - 1000 + 32_400_000).toISOString().replace(".000Z", "+09:00"), serialRaw: "1234567890", infoTypeRaw });
  const memoryEvent = (index: number): EarthquakeEvent => {
    const eventId = id40("m", index);
    return { eventId, operation: "training", strongHold: null, retainUntil: now + HOUR, contributions: (["VXSE51", "VXSE52", "VXSE53", "VXSE61"] as const)
      .map((family) => ({ family, source: source("training", family, eventId, "取消"), effective: "cancelled" as const, targetDateTimeRaw: null,
        title: "", headline: null, hypocenter: null, intensity: null, tsunamiComment: null })) };
  };
  const real = chain([F.s51d, F.s53b, F.s61, F.s62]).at(-1)!.state;
  const realEvent = eventOf(real)!, realLp = real.longPeriods[0];
  const largest = (index: number): EarthquakeEvent => {
    const eventId = id40("r", index);
    // P3-VM-AC04: active の系列ごとに未確認の印を 1 件持つ（同時最大状態に印の分を入れる）。
    return { ...realEvent, eventId, strongHold: null, retainUntil: now + HOUR, contributions: realEvent.contributions.map((item) => ({ ...item,
      source: source("normal", item.family, eventId, "発表"), unconfirmed: source("normal", item.family, eventId, "訂正") })) };
  };
  // training の記録は守りの欄を持たない（P3-QC-AC01 (5)）。normal の長周期は同じ EventID の event と同じ from を持つ。
  const { guard: _guard, ...unguarded } = realLp;
  const lp = (index: number, memory: boolean): LongPeriodSubject => {
    const eventId = id40(memory ? "m" : "r", index), operation: Operation = memory ? "training" : "normal";
    const base: LongPeriodSubject = { ...memory ? unguarded : realLp, eventId, operation, subject: `${operation}/VXSE62/${eventId}`,
      source: source(operation, "VXSE62", eventId, memory ? "取消" : "発表"), retainUntil: now + HOUR,
      ...memory ? {} : { unconfirmed: source(operation, "VXSE62", eventId, "訂正") } };
    return memory ? { ...base, effective: "cancelled", title: "", headline: null, hypocenter: null, intensity: null } : base;
  };
  const text = (length: number) => ({ kind: "text" as const, value: wide(length), raw: wide(length) });
  const history = (prefix: string): SeismicDailyHistory => ({ dayKey: new Date(now + 32_400_000).toISOString().slice(0, 10), count: 9_999,
    maxInt: text(32), counted: Array.from({ length: 2048 }, (_, index) => [id40(prefix, index), 9] as const),
    recent: Array.from({ length: 5 }, (_, index) => ({ eventId: id40(prefix, index), originTimeRaw: wide(40), reportDateTimeRaw: "2099-01-01T08:59:59+09:00",
      hypocenterName: wide(64), magnitude: text(32), maxInt: { kind: "fromTo" as const, from: text(32), to: text(32) }, cancelled: false })) });
  const intent = (index: number): SeismicIntent => {
    const eventId = id40("i", index), subject = `normal/VXSE53/${eventId}`;
    return { id: `U-Q:${subject}:${index}:desktop`, unit: "U-Q", subject, operation: "normal", source: source("normal", "VXSE53", eventId, "発表"),
      transition: "activated", channel: "desktop", payload: { domain: "earthquake-eew", level: "warning", title: "震源・震度情報",
        body: "x".repeat(100) }, createdAt: now - 1000, expiresAt: now + 179_000, nextAttemptAt: now, attempts: 0, configRevision: "p3-seismic-unit-v4",
      disposition: "pending", lastAttempt: null, replayed: false, priorityGroup: "other" as const };
  };
  // P3-NL-AC15 (2): 寄与と長周期の全部に最長の通知の印、失敗の印は 3 operation。終端記録は無い（P3-NL-AC05）。pending の本文は
  // intent の欄が増えた分（P3-NL-AC06）だけ短くし、予約込み 131,072 byte の内に収める。
  const notice = { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"] as const, evidence: "unattempted" as const };
  const marked = (event: EarthquakeEvent): EarthquakeEvent => ({ ...event, contributions: event.contributions.map((item) => ({ ...item, notice })) });
  return { ...emptyState(), earthquakes: [...Array.from({ length: 505 }, (_, index) => marked(memoryEvent(index))),
    ...Array.from({ length: 7 }, (_, index) => marked(largest(index)))],
  longPeriods: [...Array.from({ length: 7 }, (_, index) => lp(index, false)), ...Array.from({ length: 249 }, (_, index) => lp(index, true))]
    .map((item) => ({ ...item, notice })),
  daily: { normal: history("n"), training: history("t"), test: history("s") },
  intents: Array.from({ length: 128 }, (_, index) => intent(index)),
  failureMarks: (["normal", "training", "test"] as const).map((operation) => ({ operation, level: "critical" as const, until: now + HOUR })) };
}

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。U-Q でない step は飛ばす。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): SeismicUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state = emptyState();
  let saved: Readonly<{ payload: JsonValue; generation: number }> | null = null;
  const steps: SeismicUnitStep[] = [];
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      saved = { payload: JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue, generation: state.persistence.currentGeneration };
      steps.push({ ...reduceSeismicUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) }), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = saved == null ? null : seismicUnitCodec.decode(saved.payload);
      const persistence = { kind: "saved" as const, currentGeneration: saved?.generation ?? 0, savedGeneration: saved?.generation ?? 0,
        savedCapturedAt: step.evaluatedAt, savedAckAt: null, dirtySince: null };
      const next = restored?.kind === "restored" ? reduceSeismicUnit({ ...emptyState(), persistence }, { kind: "restore",
        persisted: seismicUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt) }) : null;
      if (restored != null) expect(restored.kind, label).toBe("restored");
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      saved = null;
      steps.push(next ?? reduceSeismicUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) }));
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    if (classifyHeadType(fixture.transport.headType ?? "").status !== "ready"
      || !/^VXSE(5[123]|6[12])$/.test(fixture.transport.headType ?? "")) { steps.push(reduceSeismicUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) })); continue; }
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = reduceSeismicUnit(state, { kind: "deadline", clock: clock(step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!));
    steps.push(result);
    const made = result.decisions[0];
    if (expected.decision != null) expect({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
      ...(made.decision === "unchanged" ? { reason: made.reason } : {}) }, label).toEqual(expected.decision);
    const subject = expected.subjects[0];
    if (expected.decision != null && subject != null) {
      expect(made.subject, label).toBe(subject.subject);
      const [, family, eventId] = subject.subject.split("/");
      const contribution = family === "VXSE62" ? result.state.longPeriods.find((item) => item.subject === subject.subject)
        : eventOf(result.state, eventId)?.contributions.find((item) => item.family === family);
      expect(contribution, label).toBeDefined();
      if (made.decision === "changed") expect({ reportDateTimeRaw: contribution!.source.reportDateTimeRaw,
        serialRaw: contribution!.source.serialRaw, infoTypeRaw: contribution!.source.infoTypeRaw }, label).toEqual(subject.revision);
      if (expected.effective != null) expect(contribution!.effective === "active" ? { kind: "active" }
        : { kind: "inactive", cause: { kind: "cancelled" } }, label).toEqual(expected.effective);
    }
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}

// P3-NL-AC08 (1)(4)・AC15 (4): started の pending は復元で外れ、failed・null の pending は欄ごと戻る。
it("P3-NL-T07 contractBoundary / AC08・AC15 (4): U-Q restores failed and null pending with their fields and drops a started one", () => {
  const issued = send(emptyState(), "32-35_04_03_240613_VXSE52");
  expectRestoreStarted({ intents: [issued.intents[0], issued.intents[1]], make: (intents) => ({ ...issued.state, intents }),
    restore: (state, at) => reduceSeismicUnit(emptyState(), { kind: "restore", persisted: seismicUnitCodec.encode(state), clock: at }),
    markOf: (state, subject) => state.earthquakes.flatMap((item) => item.contributions).find((item) => item.source.subject === subject)?.notice });
});

// P3-NL-T07 の取消の文面の行（P3-NL-AC10、Q-NL-CANCEL-TEXT の U-Q の行）: 取り消した記録の震源名と発表時刻、種類は取消の報の Head/Title。
it("P3-NL-T07 contractBoundary / AC10: the VXSE53 cancel names the cancelled report's hypocenter and time", () => {
  const cancel = send(send(emptyState(), F.s53a).state, "synthetic_VXSE53_cancel");
  const row = ["cancel", "[取消] 震源・震度情報（熊本県熊本地方 16:31 発表）", "熊本県熊本地方 16:31 発表の震源・震度情報を取り消しました"];
  expect(cancel.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body])).toEqual([row, row]);
});

// 実不具合の再発防止（C16 発注 4a の品質レビュー r0 の P2 と同じ形）: 取り直しは intent を作らないが、live なら新しい intent が置き換える古い pending は外す。
describe("P3-REC-T19 regression (U-Q): a recovered report withdraws the pending it would replace", () => {
  it("the pending of the same line and channel goes away and nothing new is made", () => {
    const first53 = send(emptyState(), F.s53a).state, at = clock(Date.parse(decodeFixture(F.s53b).reportDateTimeRaw));
    const live = receive(first53, decodeXml(fixtureXml(F.s53b), "VXSE53"), at), recovery = receive(first53, decodeXml(fixtureXml(F.s53b), "VXSE53", "recovered", "recovery"), at);
    expect([first53.intents.length, live.intents.length, recovery.state.intents, recovery.intents]).toEqual([2, 2, [], []]);
  });
});

// P3-REC-T22 acceptance（C16 発注 4c、Q-REC-PRECHECK-6 の N1、作者の裁定 2026-10-29 朝「数えない」）: 取り直しの報は counted に無い地震を、発生時刻
// （recent と同じ originTime。ReportDateTime へ代えない）が受理の日のときだけ当日の件数・最大震度に数え、一度数えたものは引かない。live は受信日のまま。
describe("P3-REC-T22 acceptance (U-Q): the daily count of recovered reports", () => {
  const ID = "20990101235900", OTHER = "20990102060000";
  const now = clock(Date.parse("2099-01-02T07:00:00+09:00")), yesterday = "2099-01-01T23:59:00+09:00";
  const day = (step: SeismicUnitStep) => step.state.daily.normal;
  const s53 = (options: Parameters<typeof vxse53>[0], origin: "replay" | "recovery" = "recovery") => decodeXml(vxse53(options), "VXSE53", undefined, origin);
  // TargetDateTime の無い VXSE51（originTime が読めない）。震度 4。
  const s51 = decodeXml(replaceTag("EventID", ID)(replaceTag("ReportDateTime", "2099-01-02T00:00:30+09:00")(replaceTag("DateTime", "2099-01-01T15:00:30Z")(
    fixtureXml(F.s51a).replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, "").replaceAll("<MaxInt>7</MaxInt>", "<MaxInt>4</MaxInt>")))), "VXSE51", undefined, "recovery");
  it("(a)(b) a recovered VXSE51 without an origin time counts nothing; the VXSE53 counts only an origin of today", () => {
    const first = receive(emptyState(), s51, now);
    expect(day(first)).toMatchObject({ count: 0, maxInt: null, counted: [] });
    expect(day(receive(first.state, s53({ eventId: ID, at: "2099-01-02T00:01:00+09:00", origin: yesterday }), now))).toMatchObject({ count: 0, maxInt: null, counted: [] });
    expect(day(receive(first.state, s53({ eventId: ID, at: "2099-01-02T06:32:00+09:00", origin: "2099-01-02T06:30:00+09:00" }), now)))
      .toMatchObject({ count: 1, maxInt: { value: 4 }, counted: [[ID, 4]] });
  });
  it("(c) a live count of yesterday's quake is raised by a recovered correction and never taken back", () => {
    const live = receive(emptyState(), s53({ eventId: ID, at: "2099-01-02T00:01:00+09:00", origin: yesterday, maxInt: "3" }, "replay"), now);
    expect(day(live)).toMatchObject({ count: 1, maxInt: { value: 3 }, counted: [[ID, 3]] });
    const corrected = receive(live.state, s53({ eventId: ID, at: "2099-01-02T00:01:00+09:00", origin: yesterday, infoType: "訂正" }), now);
    expect(day(corrected)).toMatchObject({ count: 1, maxInt: { value: 4 }, counted: [[ID, 4]] });
    const s61 = decodeXml(replaceTag("EventID", ID)(replaceTag("OriginTime", yesterday)(replaceTag("TargetDateTime", "2099-01-02T04:00:00+09:00")(replaceTag(
      "ReportDateTime", "2099-01-02T04:00:00+09:00")(replaceTag("DateTime", "2099-01-01T19:00:00Z")(fixtureXml(F.s61)))))), "VXSE61", undefined, "recovery");
    expect(day(receive(corrected.state, s61, now))).toMatchObject({ count: 1, maxInt: { value: 4 }, counted: [[ID, 4]] });
  });
  it("(d) a recovered quake of yesterday above today's maximum does not enter through the higher maximum", () => {
    const live = receive(emptyState(), s53({ eventId: OTHER, at: "2099-01-02T06:02:00+09:00", origin: "2099-01-02T06:00:00+09:00", maxInt: "3" }, "replay"), now);
    expect(day(live)).toMatchObject({ count: 1, maxInt: { value: 3 }, counted: [[OTHER, 3]] });
    expect(day(receive(live.state, s53({ eventId: ID, at: "2099-01-02T00:01:00+09:00", origin: yesterday, maxInt: "5-" }), now)))
      .toMatchObject({ count: 1, maxInt: { value: 3 }, counted: [[OTHER, 3]] });
  });
});
