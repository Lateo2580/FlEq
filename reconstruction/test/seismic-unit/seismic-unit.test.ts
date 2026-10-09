import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type {
  EarthquakeContribution, EarthquakeEvent, LongPeriodSubject, SeismicDailyHistory, SeismicIntent, SeismicUnitState, SeismicUnitStep,
} from "../../contracts/p3-seismic-unit.types";
import contract from "../../contracts/p3-seismic-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { knownStage, safetyRank } from "../../src/domains/seismic/seismic";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { reduceSeismicUnit, seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, vxse53 } from "./seismic-fixture";

const EVENT = "20260728162718";
const P75 = (name: string) => `telegram-foundation/phase7_5_${name}`;
const F = {
  s51a: P75("VXSE51_20260728162718_fd74a5616fbb"), s51b: P75("VXSE51_20260728162718_10e84031ad8b"),
  s51c: P75("VXSE51_20260728162718_6854218b287a"), s51d: P75("VXSE51_20260728162718_059a2b392646"),
  s53a: P75("VXSE53_20260728162718_99e82c812e72"), s53b: P75("VXSE53_20260728162718_bf35e8ea1825"),
  s62: P75("VXSE62_20260728162718_f9786edc27df"), s61: P75("VXSE61_20260728162718_d7e630bbb653"),
} as const;
const HOUR = 3_600_000;
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
      [quake().replace("<Serial>1</Serial>", "<Serial>0</Serial>"), "VXSE53", "identityInvalid"],
      [quake().replace("<Serial>1</Serial>", "<Serial>12345678901</Serial>"), "VXSE53", "identityInvalid"],
      [quake().replace(/<Earthquake>[\s\S]*<\/Intensity>/, ""), "VXSE53", "requiredStructureMissing"],
      [quake().replace(/<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/, ""), "VXSE53", "requiredStructureMissing"],
      [quake().replace("<Observation>", "<Other>").replace("</Observation>", "</Other>"), "VXSE53", "requiredStructureMissing"],
      [fixtureXml(F.s51d).replace(/<Intensity>[\s\S]*<\/Intensity>/, ""), "VXSE51", "requiredStructureMissing"],
      [fixtureXml(F.s51d).replace("<Name>熊本県</Name>", ""), "VXSE51", "requiredStructureMissing"],
      [fixtureXml(F.s51d).replace("<Code>743</Code><MaxInt>", "<Code>741</Code><MaxInt>"), "VXSE51", "requiredStructureInvalid"],
      [quake({ city: city(station("9900101") + station("9900101")) }), "VXSE53", "requiredStructureInvalid"],
      // 存在が妥当性より先（Q-ENUM.priorityRule）。
      [quake({ city: city(station("9900101") + station("9900101") + "<IntensityStation><Code>9900102</Code><Int>1</Int></IntensityStation>") }),
        "VXSE53", "requiredStructureMissing"],
      [fixtureXml("32-35_04_03_240613_VXSE52").replace(/<OriginTime>[^<]*<\/OriginTime>/, ""), "VXSE52", "requiredStructureMissing"],
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
      expect(placeOfHeadType(headType)).toBe("urgent");
    }
    expect(classifyHeadType("VXSE47")).toMatchObject({ status: "notPorted", candidate: "U-Q", reason: expect.stringMatching(/^C7で確認/) });
    // 一入力は U-Q だけへ届き、U-E・U-T の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.s53a);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } },
      clock(Date.parse(material.reportDateTimeRaw)), linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-Q"]);
    expect([routed.state.units["U-E"], routed.state.units["U-T"]]).toEqual([owner.units["U-E"], owner.units["U-T"]]);
    expect(routed.state.units["U-E"]).toBe(owner.units["U-E"]);
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
    // 同じ revision・同じ InfoType で寄与が違えば先着を保って stale＋WARN。
    const conflicting = send(first53, F.s53a, (xml) => xml.replace("<Name>熊本県熊本地方</Name>", "<Name>別の震央</Name>"));
    expect(decision(conflicting)).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(conflicting.state).toBe(first53);
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
    // 36 時間で回収し、event の期限（24 時間）を変えない。
    const reported = Date.parse("2026-07-28T16:37:00+09:00");
    const day = reduceSeismicUnit(adopted.state, { kind: "deadline", clock: clock(reported + 24 * HOUR) }).state;
    expect([day.earthquakes, day.longPeriods.length]).toEqual([[], 1]);
    expect(reduceSeismicUnit(day, { kind: "deadline", clock: clock(reported + 36 * HOUR) }).state.longPeriods).toEqual([]);
    // 78_01_01 と合成の特殊値: 階級 3 は critical、未入電の階級は normal、Earthquake の無い報の震源は null。
    expect(levels(send(emptyState(), "selected_xml/78_01_01_240613_VXSE62"))).toEqual(["desktop:critical", "sound:critical"]);
    const special = send(emptyState(), "synthetic_phase4a_VXSE62_special");
    expect(special.state.longPeriods[0]).toMatchObject({ hypocenter: null, intensity: { maxLgInt: { kind: "empty" },
      items: [{ level: "pref", code: "99", maxLgInt: { kind: "fromTo" } }, { level: "area", code: "990" }, { level: "area", code: "991" },
        { level: "area", code: "992", maxLgInt: { kind: "missing" } }] } });
    expect(levels(special)).toEqual(["desktop:normal", "sound:normal"]);
    // 階級 1〜2 は warning（Q-NOTICE.level）。
    for (const lg of ["1", "2"]) expect(levels(send(emptyState(), "synthetic_phase4a_VXSE62_special", (xml) => xml.replace(
      '<MaxLgInt condition="未入電" description="最大長周期階級未入電"/>', `<MaxLgInt>${lg}</MaxLgInt>`))), lg)
      .toEqual(["desktop:warning", "sound:warning"]);
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
    // 通知の段階: 全体 MaxInt の missing・empty・表に無い text は normal、unknown は info、range の upper 5 は 5強で warning。
    const level = (maxInt: string) => levels(receive(emptyState(), decodeXml(vxse53({ at: "2099-01-01T09:00:00+09:00", maxInt }), "VXSE53"),
      clock(Date.parse("2099-01-01T09:00:00+09:00"))))[0];
    expect(["", "8弱", "不明", "5強以下", "3", "4"].map(level))
      .toEqual(["desktop:normal", "desktop:normal", "desktop:info", "desktop:warning", "desktop:normal", "desktop:warning"]);

    // 当日履歴（P3-C7-DAILY=A・P3-C7-DAILY-BASIS=B）。
    const day = (state: SeismicUnitState) => state.daily.normal;
    const series = chain([F.s51a, F.s53a, F.s53b]);
    expect(day(series[2].state)).toMatchObject({ dayKey: "2026-07-28", count: 1, countedEventIds: [EVENT], maxInt: { value: 7 } });
    expect(day(series[2].state).recent.map((item) => item.eventId)).toEqual([EVENT]);
    // 取消で減らさない。range だけの地震は数えない。
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
    // 同じ EventID の続報で件数を足さない。recent の 6 行目は落ち、countedEventIds の 2049 件目は集合に足さずに数える。
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
      countedEventIds: ids, recent: [] } } };
    const beyond = receive(full, report("20260802000099", "2026-08-02T00:10:00+09:00", "2026-08-02T00:05:00+09:00"),
      clock(Date.parse("2026-08-02T00:10:00+09:00"))).state;
    expect([day(beyond).count, day(beyond).countedEventIds.length]).toEqual([2049, 2048]);
    // 時計の JST 0 時で空へ戻す。
    const reset = reduceSeismicUnit(series[2].state, { kind: "deadline", clock: clock(Date.parse("2026-07-29T00:00:00+09:00")) }).state;
    expect(day(reset)).toEqual({ dayKey: null, count: 0, maxInt: null, countedEventIds: [], recent: [] });
    expect(reset.contentRevision).toBe(series[2].state.contentRevision + 1);
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
    // training の受理は normal を退去させない（capacityExceeded で state・nextDeadline は不変、結果は空）。
    const refused = receive(full, quake("T0001", "訓練"), at);
    expect(decision(refused)).toMatchObject({ decision: "capacityExceeded", rejection: { family: "VXSE53", affectedScope: "subject" } });
    expect(refused.state).toBe(full);
    expect(refused.nextDeadline).toEqual({ wallTimeMs: Math.min(...full.earthquakes.map((item) => item.retainUntil)), monotonicMs: null });
    expect([refused.intents, refused.outcomes, refused.diagnostics, refused.displayChanges]).toEqual([[], [], [], []]);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) training/test → (3) 最古の normal。強震保持と取消記憶は件数の超過でも後回し。
    const hold = { originTimeRaw: iso(0), until: now + HOUR, establishedBy: { family: "VXSE53", reportDateTimeRaw: iso(0), serialRaw: "1",
      infoTypeRaw: "発表" } };
    const memory = (index: number) => clone(index, { contributions: seed.contributions.map((item) => ({ ...retime(item, clone(index).eventId,
      "normal", (1000 - index) * 1000), effective: "cancelled" as const, targetDateTimeRaw: null, title: "", headline: null, hypocenter: null,
      intensity: null, tsunamiComment: null })) });
    let state = withEvents([clone(0, { strongHold: { ...hold, originTimeRaw: iso(0) } }), memory(1), clone(2, { retainUntil: now }),
      clone(3, { operation: "training" }), ...Array.from({ length: 508 }, (_, index) => clone(index + 10))]);
    const evicted: string[] = [];
    for (const eventId of ["N0002", "N0003", "N0004"]) {
      const before = new Set(state.earthquakes.map((item) => `${item.operation}/${item.eventId}`));
      state = receive(state, quake(eventId), at).state;
      evicted.push(...[...before].filter((key) => !state.earthquakes.some((item) => `${item.operation}/${item.eventId}` === key)));
    }
    expect(evicted).toEqual([`normal/${clone(2).eventId}`, `training/${clone(3).eventId}`, `normal/${clone(10).eventId}`]);
    // 件数が満杯で事実の event が強震保持だけなら、最古の取消記憶だけの event を退去して新しい取消を受ける。
    const holds = withEvents([memory(1), memory(2), ...Array.from({ length: 510 }, (_, index) => clone(index + 10, { strongHold: hold }))]);
    const cancel = receive(holds, decodeXml(vxse53({ eventId: "N0005", at: iso(0), infoType: "取消" }), "VXSE53"), at);
    expect(decision(cancel).decision).toBe("changed");
    expect(cancel.state.earthquakes.some((item) => item.eventId === memory(1).eventId)).toBe(false);
    // 退去した event に遅れて届いた続報は、取消記憶が無いので新しく採用される。
    const lateFollow = decodeXml(vxse53({ eventId: memory(1).eventId, at: iso((1000 - 1) * 1000) }), "VXSE53");
    expect(decision(receive(cancel.state, lateFollow, at))).toMatchObject({ decision: "changed" });
    // 強震保持の event は事実の合計が 2,574,775 byte 以下なら退去しない（件数の超過で候補が尽きれば capacityExceeded）。
    const onlyHolds = withEvents(Array.from({ length: 512 }, (_, index) => clone(index, { strongHold: hold })));
    expect(decision(receive(onlyHolds, quake("N0006"), at)).decision).toBe("capacityExceeded");
    // 件数が満杯で事実の event が強震保持だけなら、新しい地震（取消でない報）も最古の取消記憶だけの event を退去して入る（(4)）。
    const quakeIn = receive(holds, quake("N0012"), at);
    expect(decision(quakeIn).decision).toBe("changed");
    expect(quakeIn.state.earthquakes.some((item) => item.eventId === memory(1).eventId)).toBe(false);
    expect(quakeIn.state.earthquakes.filter((item) => item.strongHold != null)).toHaveLength(510);

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
    const byBytes = receive(probe, decodeFixture(F.s53b, (xml) => replaceTag("EventID", "N0008")(xml).replace(/2026-07-28T16:35:00\+09:00/g, iso(0))), at);
    expect(decision(byBytes).decision).toBe("changed");
    expect(byBytes.state.longPeriods).toEqual([]);
    expect(byBytes.state.earthquakes.some((item) => item.eventId === heavy(1).eventId)).toBe(false);
    // normal の事実だけで超えるなら capacityExceeded（training の受理は normal を退去させない）。
    const trainingGiant = decodeFixture(F.s53b, (xml) => replaceTag("EventID", "N0009")(xml).replace(/2026-07-28T16:35:00\+09:00/g, iso(0))
      .replace("<Status>通常</Status>", "<Status>訓練</Status>"));
    expect(decision(receive(probe, trainingGiant, at)).decision).toBe("capacityExceeded");
    // (5): 強震保持の event の事実の合計が 2,574,775 byte を超え byte も超えるときは、最古の強震保持の event を退去する。
    const holdGiants = withEvents(Array.from({ length: 13 }, (_, index) => clone(index + 1, { strongHold: hold }, giant)));
    const pressed = receive(holdGiants, decodeFixture(F.s53b, (xml) => replaceTag("EventID", "N0013")(xml)
      .replace(/2026-07-28T16:35:00\+09:00/g, iso(0))), at);
    expect(decision(pressed).decision).toBe("changed");
    expect(pressed.diagnostics[0]).toMatchObject({ reason: "seismicCapacityEvicted", count: 1 });
    expect(pressed.state.earthquakes.some((item) => item.eventId === clone(1).eventId)).toBe(false);

    // P3-C7-CAPACITY-BUDGET=A の同時最大状態: 取消記憶だけの event 505＋最大の実例の event 7＋その長周期 7＋取消記憶だけの長周期 249
    // ＋当日履歴 3 operation の上限＋intent の上限。decode が受け、+1 件は件数の超過で training の取消記憶を退去する。
    const budget = budgetState(now);
    const encoded = Buffer.byteLength(JSON.stringify(seismicUnitCodec.encode(budget)));
    console.info("P3-C7 capacity budget state payload bytes", encoded, "contract 3,979,110");
    const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const reserve = budget.earthquakes.slice(0, 505).reduce((sum, item) => sum + sizeOf(item), 0)
      + budget.longPeriods.slice(7).reduce((sum, item) => sum + sizeOf(item), 0) + sizeOf(budget.daily);
    console.info("P3-C7 capacity budget parts", JSON.stringify({ memoryEvent: sizeOf(budget.earthquakes[0]), largestEvent: sizeOf(budget.earthquakes[505]),
      memoryLongPeriod: sizeOf(budget.longPeriods[255]), longPeriod: sizeOf(budget.longPeriods[0]), history: sizeOf(budget.daily.normal),
      recentRow: sizeOf(budget.daily.normal.recent[0]), daily: sizeOf(budget.daily), intents: sizeOf(budget.intents), reserve }));
    expect(reserve).toBeLessThanOrEqual(1_357_385);
    expect(encoded).toBeLessThanOrEqual(4_194_304);
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
    expect(Object.keys(payload as object).sort()).toEqual(["daily", "earthquakes", "intents", "longPeriods", "schemaVersion"]);
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
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-seismic-unit-v0" }],
      ["events > 512", { ...value, earthquakes: many(513, eventN) }],
      ["long periods > 256", { ...value, longPeriods: many(257, lpN) }],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...value.intents[0], id: `pending-${index}`, disposition: "pending" })) }],
      ["pending > 131072 bytes", { ...value, intents: many(100, (index) => ({ ...value.intents[0], id: `big-${index}`, disposition: "pending",
        payload: { ...(value.intents[0].payload as Row), body: "x".repeat(1400) } })) }],
      ["generation > 4 MiB", { ...value, earthquakes: many(14, (index) => ({ ...eventN(index), contributions: [{ ...active,
        headline: "x".repeat(300_000), source: { ...(active.source as Row), subject: `normal/${String(active.family)}/E${index}` } }] })) }],
      ["EventID not printable ASCII", withQuake({ eventId: "地震" })],
      ["EventID over 40 bytes", withQuake({ eventId: "a".repeat(41) })],
      ["duplicate event", { ...value, earthquakes: [quake, quake] }],
      ["duplicate family", withQuake({ contributions: [active, active] })],
      ["cancelled keeps facts", withQuake({ contributions: contributions.map((item) => item === cancelled ? { ...item, title: "震源・震度情報" } : item) })],
      ["cancelled long period keeps facts", { ...value, longPeriods: [{ ...lp, effective: "cancelled" }] }],
      ["duplicate long period", { ...value, longPeriods: [lp, lp] }],
      // 取消記憶だけの記録の byte は文字列長の上限から決まる。上限の外の長さ（inputId）で I-U-Q.capacityReserve を超えた保存物。
      ["reserve exceeded", { ...value, earthquakes: many(512, (index) => ({ ...eventN(index), contributions: [{ ...cancelled,
        source: { ...(cancelled.source as Row), inputId: "x".repeat(3_100), subject: `normal/${String(cancelled.family)}/E${index}` } }] })) }],
      ["strongHold until", withQuake({ strongHold: hold == null ? null : { ...hold, until: Number(hold.until) + 1 } })],
      ["recent > 5", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, recent: many(6, () => (value.daily.normal.recent as Row[])[0]) } } }],
      ["recent string limit", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, recent: [{ ...(value.daily.normal.recent as Row[])[0],
        hypocenterName: "x".repeat(65) }] } } }],
      ["countedEventIds > 2048", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, countedEventIds: many(2049, (index) => `c${index}`) } } }],
      ["countedEventIds duplicate", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, countedEventIds: [EVENT, EVENT] } } }],
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

  // acceptance: Q-NOTICE の地震分（AC08）。
  it("P3-C7-T07 acceptance / AC08: opportunities, level formula, replacement, body, capacity, intentUpdate, training, recovery", () => {
    const series = chain([F.s51a, F.s51b, F.s51c, F.s51d, F.s53a, F.s53b, F.s62, F.s61]);
    // 報自身の震度で決める: 震度速報・震源震度情報は warning、20:30 の VXSE61 は normal、長周期階級 4 は critical。
    expect(series.map((step) => levels(step)[0])).toEqual([...Array(6).fill("desktop:warning"), "desktop:critical", "desktop:normal"]);
    expect(series[7].intents.map((item) => [item.payload.title, item.payload.body]))
      .toEqual([["顕著な地震の震源要素更新のお知らせ", "熊本県熊本地方 / M7.1"], ["顕著な地震の震源要素更新のお知らせ", "熊本県熊本地方 / M7.1"]]);
    expect(series[5].intents[0].payload.body).toBe("熊本県熊本地方 / M7.1 / 最大震度7");
    expect(series[6].intents[0].payload.body).toBe("熊本県熊本地方 / 長周期階級4 / 最大震度7");
    expect(series[0].intents.map((item) => [item.expiresAt - item.createdAt, item.nextAttemptAt - item.createdAt]))
      .toEqual([[180_000, 0], [60_000, 0]]);
    // 震度の無い VXSE52 は normal。5 弱以上未入電は warning。
    expect(levels(send(emptyState(), "32-35_04_03_240613_VXSE52"))).toEqual(["desktop:normal", "sound:normal"]);
    expect(levels(send(emptyState(), "synthetic_phase4a_VXSE51_special"))).toEqual(["desktop:warning", "sound:warning"]);
    expect(send(emptyState(), "synthetic_phase4a_VXSE51_special").intents[0].payload.body).toBe("最大震度5弱以上");
    // revisionOnly・duplicate・stale では作らない。訂正は事実が同じでも作る。
    const first53 = send(emptyState(), F.s53a).state;
    expect(send(first53, F.s51a).intents).toEqual([]);
    expect(send(first53, F.s53a).intents).toEqual([]);
    const sameFacts = send(first53, F.s53a, (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"));
    expect(decision(sameFacts)).toMatchObject({ decision: "changed", change: "revisionOnly" });
    expect(sameFacts.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")]))
      .toEqual([["warning", "[訂正] 震源・震度情報", true], ["warning", "[訂正] 震源・震度情報", true]]);
    // 取消: active だった family だけ。未受信の取消は作らない。
    expect(send(emptyState(), "synthetic_VXSE53_cancel").intents).toEqual([]);
    const cancel = send(series[5].state, "synthetic_VXSE53_cancel");
    expect(cancel.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body]))
      .toEqual([["cancel", "[取消] 震源・震度情報", "この情報は取り消されました"], ["cancel", "[取消] 震源・震度情報", "この情報は取り消されました"]]);
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
    const updated = reduceSeismicUnit(series[0].state, { kind: "intentUpdate", clock: clock(reported), intentUpdate: [{ id: desktop.id, attempts: 1,
      nextAttemptAt: reported + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0, disposition: "delivered" }] });
    expect(updated.state.persistence.currentGeneration).toBe(series[0].state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(reduceSeismicUnit(updated.state, { kind: "intentUpdate", clock: clock(reported), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: reported + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // training/test は desktop だけ。
    const training = send(emptyState(), "32-35_01_03_240613_VXSE53");
    expect(training.intents.map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【訓練】震源・震度情報"]]);
    // origin=recovery は適用しない（同じ state 参照、unchanged/noChange）。
    const recovery = receive(first53, decodeXml(fixtureXml(F.s53b), "VXSE53", "recovered", "recovery"), clock(reported));
    expect(recovery.state).toBe(first53);
    expect(recovery.decisions).toMatchObject([{ decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence]).toEqual([[], [], []]);
    // 復元直後の続報は復元した state との差で決める（同じ報は duplicate で鳴らさない）。
    const restored = reduceSeismicUnit(emptyState(), { kind: "restore", persisted: seismicUnitCodec.encode(first53), clock: clock(reported + 1) }).state;
    expect(send(restored, F.s53a).intents).toEqual([]);
    expect(levels(send(restored, F.s53b))).toEqual(["desktop:warning", "sound:warning"]);
  });

  // corpusHistory: expectedDecisions の 14 step・O07:1〜4・E13（AC10）。
  it("P3-C7-T09 corpusHistory / AC10: O01:49-55, O02:26-38, O07:1-5 and the E13 population", () => {
    const o01 = replay("O01", 49, 55);
    // :52 の訂正は強震保持を保ち until を延ばさない。:53 の取消は同じ subject の pending を両 channel とも置き換え、強震保持を外す。
    expect(eventOf(o01[3].state)!.strongHold).toEqual(eventOf(o01[1].state)!.strongHold);
    expect(o01[3].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["warning", "[訂正] 震源・震度情報"],
      ["warning", "[訂正] 震源・震度情報"]]);
    expect(pending(o01[4].state).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect([eventOf(o01[4].state)!.strongHold, toSeismicView(o01[4].state).earthquakes]).toEqual([null, []]);
    expect(o01[4].state.daily.normal).toMatchObject({ count: 1, maxInt: { value: 7 } });
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
      expect(Object.keys(toSeismicView(after).admission), id).toEqual([]);
      groups[decision(step).decision === "changed" ? "changed" : "rejected"].push(id);
    }
    // synthetic_phase4a_VXSE61_special は Magnitude を持たず、Q-ENUM の VXSE61.required（VXSE52 の必須構造）で拒否する。
    expect(groups.rejected).toEqual(["test__fixtures__synthetic_phase4a_VXSE61_special"]);
    expect(groups.changed).toHaveLength(37);
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
    const gone = reduceSeismicUnit(quiet, { kind: "deadline", clock: clock(reported + 24 * HOUR) });
    expect(gone.state.earthquakes).toEqual([]);
    expect([gone.intents, gone.displayChanges.map((item) => item.after)]).toEqual([[], [null]]);
    const lg = send(emptyState(), "selected_xml/78_01_01_240613_VXSE62").state;
    const lgAt = Date.parse("2020-11-21T02:33:10+09:00");
    expect(reduceSeismicUnit(lg, { kind: "deadline", clock: clock(lgAt + 36 * HOUR - 60_000) }).state.longPeriods).toHaveLength(1);
    expect(reduceSeismicUnit(lg, { kind: "deadline", clock: clock(lgAt + 36 * HOUR) }).state.longPeriods).toEqual([]);
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
    serialRaw: "1234567890", infoTypeRaw });
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
    return { ...realEvent, eventId, strongHold: null, retainUntil: now + HOUR, contributions: realEvent.contributions.map((item) => ({ ...item,
      source: source("normal", item.family, eventId, "発表") })) };
  };
  const lp = (index: number, memory: boolean): LongPeriodSubject => {
    const eventId = id40(memory ? "m" : "r", index), operation: Operation = memory ? "training" : "normal";
    const base: LongPeriodSubject = { ...realLp, eventId, operation, subject: `${operation}/VXSE62/${eventId}`,
      source: source(operation, "VXSE62", eventId, memory ? "取消" : "発表"), retainUntil: now + HOUR };
    return memory ? { ...base, effective: "cancelled", title: "", headline: null, hypocenter: null, intensity: null } : base;
  };
  const text = (length: number) => ({ kind: "text" as const, value: wide(length), raw: wide(length) });
  const history = (prefix: string): SeismicDailyHistory => ({ dayKey: new Date(now + 32_400_000).toISOString().slice(0, 10), count: 9_999,
    maxInt: text(32), countedEventIds: Array.from({ length: 2048 }, (_, index) => id40(prefix, index)),
    recent: Array.from({ length: 5 }, (_, index) => ({ eventId: id40(prefix, index), originTimeRaw: wide(40), reportDateTimeRaw: "2099-01-01T08:59:59+09:00",
      hypocenterName: wide(64), magnitude: text(32), maxInt: { kind: "fromTo" as const, from: text(32), to: text(32) }, cancelled: false })) });
  const intent = (index: number, disposition: SeismicIntent["disposition"]): SeismicIntent => {
    const eventId = id40("i", index), subject = `normal/VXSE53/${eventId}`;
    return { id: `U-Q:${subject}:${index}:desktop`, unit: "U-Q", subject, operation: "normal", source: source("normal", "VXSE53", eventId, "発表"),
      transition: "activated", channel: "desktop", payload: { domain: "earthquake-eew", level: "warning", title: "震源・震度情報",
        body: "x".repeat(180) }, createdAt: now - 1000, expiresAt: now + 179_000, nextAttemptAt: now, attempts: 0, configRevision: "p3-seismic-unit-v1",
      disposition };
  };
  return { ...emptyState(), earthquakes: [...Array.from({ length: 505 }, (_, index) => memoryEvent(index)),
    ...Array.from({ length: 7 }, (_, index) => largest(index))],
  longPeriods: [...Array.from({ length: 7 }, (_, index) => lp(index, false)), ...Array.from({ length: 249 }, (_, index) => lp(index, true))],
  daily: { normal: history("n"), training: history("t"), test: history("s") },
  intents: [...Array.from({ length: 128 }, (_, index) => intent(index, "pending")), ...Array.from({ length: 128 }, (_, index) => intent(index + 128, "delivered"))] };
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
