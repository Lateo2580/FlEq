import { describe, expect, it, vi } from "vitest";
import { withLongestMarks } from "../unreadable-mark/longest-mark";

import { expectRestoreStarted } from "../notice-ledger/notice-fixture";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { TyphoonAnalysisRecord, TyphoonProbabilityRecord, TyphoonUnitState, TyphoonUnitStep } from "../../contracts/p3-typhoon-unit.types";
import { generationBytes, reduceTyphoonUnit, toTyphoonView, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { deliveryGrowth as reserve } from "../../src/notification-delivery/delivery-growth";
import { versionKey } from "../../src/contracts-revision/version";
import { linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import {
  HOUR, maximumPayload, analysisXml, clock, compose, control, decodeFixture, decodeXml, emptyState, eventId, infoType, iso, ms, probabilityXml, receive, replaceTag, retime, send, sendXml,
  serial, six, status, tick,
} from "./typhoon-fixture";

// P3-UNIT-Y-001 の unit 試験（T01〜T08・T12〜T14）。続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る。

const TC2001 = "normal/typhoonAnalysis/TC2001", TC2606 = "normal/typhoonAnalysis/TC2606", P2606 = "normal/typhoonProbability/TC2606", P2001 = "normal/typhoonProbability/TC2001";
const A01 = "10_05_01_200826_VPTW60", A02 = "10_05_02_200826_VPTW60", A03 = "10_05_03_200826_VPTW60", A04 = "10_05_04_200826_VPTW60", TALIM = "10_04_03_170913_VPTW60";
const END = "10_05_05_200826_VPTW61", W62 = "10_05_06_200826_VPTW62", LOWERING = "synthetic_VPTW60_TC2606_lowering";
const P41 = "76_01_02_260531_VPTA50", P87 = "76_01_03_260602_VPTA50", P01 = "76_01_01_200630_VPTA50", PZERO = "synthetic_VPTA50_TC2606_zero";
const CANCEL_A = "synthetic_VPTW60_cancel", CANCEL_P = "synthetic_VPTA50_cancel";
const records = (state: TyphoonUnitState) => [...state.analysis, ...state.probability];
const recordOf = (state: TyphoonUnitState, subject: string) => records(state).find((item) => item.subject === subject);
const pendingOf = (state: TyphoonUnitState, subject: string) => state.intents.filter((item) => item.subject === subject && item.disposition === "pending");
const evictions = (step: TyphoonUnitStep) => step.diagnostics.filter((item) => item.reason === "typhoonCapacityEvicted");
const reasonOf = (step: TyphoonUnitStep) => {
  const made = step.decisions[0];
  return made.decision === "changed" ? "changed" : made.reason;
};
const kindOf = (step: TyphoonUnitStep) => step.decisions.map((made) => made.decision === "changed" ? made.change : made.reason);
function activeAnalysis(state: TyphoonUnitState, subject: string) {
  const found = state.analysis.find((item) => item.subject === subject);
  if (found?.effective !== "active") throw new Error(`${subject} is not an active analysis`);
  return found;
}
function activeProbability(state: TyphoonUnitState, subject: string) {
  const found = state.probability.find((item) => item.subject === subject);
  if (found?.effective !== "active") throw new Error(`${subject} is not an active probability`);
  return found;
}
const day = 24 * HOUR;
// 状態の中の kind の記録のうち最も遅い見える期限（その 1 ms 後に復元すると全部 ended になる）。
const sendRestoreTime = (state: TyphoonUnitState, effective: "active") => Math.max(...[...state.analysis, ...state.probability].flatMap((item) => item.effective === effective ? [item.activeUntil] : []));
// 報の時刻と受信の時計を揃えて送る（headType を指定できる）。
function sendAs(state: TyphoonUnitState, name: string, headType: string, transform?: (xml: string) => string, now?: number): TyphoonUnitStep {
  const material = decodeFixture(name, transform, undefined, headType);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw)));
}
const at = (time: string) => retime(time);
// Head の Title だけ差し替える。
const headTitle = (value: string) => (xml: string) => xml.replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, `$1<Title>${value}</Title>`);
const withoutTag = (tag: string) => (xml: string) => xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>`), "");

// 容量の試験用の入力: 同じ報の EventID と時刻だけを変えた n 番目の報（時刻の順に古い）。
const T0 = ms("2026-05-31T09:00:00+09:00");
const analysisN = (index: number, base = T0, o: Parameters<typeof analysisXml>[0] = {}) => analysisXml({ eventId: `TC${String(index).padStart(4, "0")}`, report: iso(base + index * 60_000),
  target: iso(base + index * 60_000 - 45 * 60_000), serial: "1", ...o });
const probN = (index: number, base = T0, o: Partial<Parameters<typeof probabilityXml>[0]> = {}) => probabilityXml({ eventId: `TC${String(index).padStart(4, "0")}`, report: iso(base + index * 60_000),
  target: iso(base + index * 60_000 - 55 * 60_000), serial: "1", areas: [{ code: "010001", daily: [1, 1, 1, 1, 5], slots: [5] }], ...o });
const fillAnalysis = (count: number, state = emptyState(), base = T0, from = 0) => {
  let current = state;
  for (let index = from; index < from + count; index++) current = sendXml(current, analysisN(index, base), "VPTW60").state;
  return current;
};
const fillProbability = (count: number, state = emptyState(), base = T0, from = 0) => {
  let current = state;
  for (let index = from; index < from + count; index++) current = sendXml(current, probN(index, base), "VPTA50").state;
  return current;
};

describe("P3-UNIT-Y-001 U-Y reducer", () => {
  // contractBoundary: Q-ENUM の順で最初の一 reason だけを返し、state の参照が変わらない。
  it("P3-C14-T01 contractBoundary / AC01: first reason only with the state reference unchanged, a legal empty cancel and the U-Y route", () => {
    const base = emptyState();
    const long = (count: number) => "あ".repeat(count);
    const insert = (marker: string) => (xml: string) => xml.replace("</MeteorologicalInfos>", `${marker}</MeteorologicalInfos>`);
    const cases: readonly [label: string, xml: string, headType: string, reason: string][] = [
      ["EventID missing", analysisXml({ eventId: "" }), "VPTW60", "identityMissing"],
      ["EventID 33", analysisXml({ eventId: "T".repeat(33) }), "VPTW60", "identityInvalid"],
      ["EventID slash", analysisXml({ eventId: "TC/26" }), "VPTW60", "identityInvalid"],
      ["EventID quote", analysisXml({ eventId: 'TC"26' }), "VPTW60", "identityInvalid"],
      ["EventID missing and Title missing: identity first", compose(eventId(""), headTitle(""))(analysisXml()), "VPTW60", "identityMissing"],
      ["Serial not digits", analysisXml({ serial: "1a" }), "VPTW60", "identityInvalid"],
      ["Serial 11 digits", analysisXml({ serial: "12345678901" }), "VPTW60", "identityInvalid"],
      ["Serial bad and InfoType bad: Serial first", analysisXml({ serial: "x", info: "速報" }), "VPTW60", "identityInvalid"],
      ["ReportDateTime raw 50 chars", analysisXml({ report: "2026-05-31T10:45:00.1234567890123456789012345+09:00" }), "VPTW60", "identityInvalid"],
      ["InfoType raw 9 chars", analysisXml({ info: "あ".repeat(9) }), "VPTW60", "identityInvalid"],
      ["Head/Title missing", headTitle("")(analysisXml()), "VPTW60", "requiredStructureMissing"],
      ["Head/Title missing (probability)", headTitle("")(probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1], slots: [1] }] })), "VPTA50", "requiredStructureMissing"],
      ["InfoType outside the vocabulary", analysisXml({ info: "速報" }), "VPTW60", "requiredStructureInvalid"],
      ["analysis TargetDateTime missing", withoutTag("TargetDateTime")(analysisXml()), "VPTW60", "requiredStructureMissing"],
      ["analysis TargetDateTime not a time", replaceTag("TargetDateTime", "未定")(analysisXml()), "VPTW60", "requiredStructureInvalid"],
      // P3-WS-T04: 時刻・軸・欄の読めなさは部分を落として受理する（P3-WS-T04 の it）。ここの 7 行は拒否のまま残す所（Q-WS-REJECTIONS）。
      ["two 実況 with the second as the 25th time", analysisXml({ later: [...Array.from({ length: 23 }, () => "予報　３時間後"), "実況"] }), "VPTW60", "requiredStructureInvalid"],
      ["no 実況 among 25 times", analysisXml({ later: Array.from({ length: 24 }, () => "予報　３時間後") }).replace('type="実況"', 'type="推定　１時間後"'), "VPTW60", "requiredStructureMissing"],
      ["no 実況", analysisXml().replace('type="実況"', 'type="推定　１時間後"'), "VPTW60", "requiredStructureMissing"],
      ["two 実況", analysisXml({ later: ["実況"] }), "VPTW60", "requiredStructureInvalid"],
      ["two Items in a time", analysisXml({ items: 2 }), "VPTW60", "requiredStructureInvalid"],
      ["実況 DateTime not a time", analysisXml().replace(/(<DateTime type="実況">)[^<]*/, "$1未定"), "VPTW60", "requiredStructureInvalid"],
      ["実況 without Item", analysisXml({ later: [] }).replace(/<Item>[\s\S]*<\/Item>/, ""), "VPTW60", "requiredStructureMissing"],
      ["two storm areas of the same type in a forecast time", analysisXml().replace(/<WarningAreaPart(?![\s\S]*<WarningAreaPart)[\s\S]*?<\/WarningAreaPart>/, "$&$&"), "VPTW60", "requiredStructureInvalid"],
      ["probability two sections of the same day", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1], slots: [1] }] }).replace(/<MeteorologicalInfo type="台風の暴風域に入る確率（1日積算）">[\s\S]*?<\/MeteorologicalInfo>/, "$&$&"), "VPTA50", "requiredStructureInvalid"],
      ["probability value 101 beside areas above zero", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 101] }, { code: "010002", daily: [5, 5, 5, 5, 5], slots: [5] }] }), "VPTA50", "requiredStructureInvalid"],
      ["MeteorologicalInfos missing", analysisXml().replace(/<MeteorologicalInfos[\s\S]*<\/MeteorologicalInfos>/, ""), "VPTW60", "requiredStructureMissing"],
      ["probability 5-day section missing", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1], slots: [1] }], skipDays: [4] }), "VPTA50", "requiredStructureMissing"],
      ["probability TimeSeriesInfo missing", insert("")(probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1] }] })).replace(/<TimeSeriesInfo>[\s\S]*<\/TimeSeriesInfo>/, ""), "VPTA50", "requiredStructureMissing"],
    ];
    for (const [label, xml, headType, reason] of cases) {
      const step = sendXml(base, xml, headType);
      expect([label, reasonOf(step)], label).toEqual([label, reason]);
      expect(step.state, label).toBe(base);
      expect(step.intents, label).toEqual([]);
    }
    // inputId の 65 文字と「"」は identityInvalid。
    for (const inputId of ["a".repeat(65), 'quote"id']) {
      const step = receive(base, decodeFixture(A01, undefined, inputId), clock(ms("2020-09-28T15:50:00+09:00")));
      expect([inputId, reasonOf(step)]).toEqual([inputId, "identityInvalid"]);
    }
    // Head の無い報は headMissing、Body の無い取消（解析も確率も）は採用（記憶だけの取消）。
    expect(reasonOf(sendXml(base, analysisXml().replace(/<Head[\s\S]*<\/Head>/, ""), "VPTW60"))).toBe("headMissing");
    const noBody = (xml: string) => xml.replace(/<Body[\s\S]*<\/Body>/, "");
    expect(sendXml(base, noBody(analysisXml({ info: "取消" })), "VPTW60").decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
    expect(send(base, CANCEL_P).decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
    // coverage 表と実行場所: 12 型は ready＋U-Y、VPTI50 は表に無いまま、U-Y は deferred。
    const types = ["VPTW60", "VPTW61", "VPTW62", "VPTW63", "VPTW64", "VPTW65", "VPTA50", "VPTA51", "VPTA52", "VPTA53", "VPTA54", "VPTA55"];
    expect(types.map((type) => classifyHeadType(type))).toEqual(types.map(() => ({ status: "ready", unit: "U-Y" })));
    expect(classifyHeadType("VPTI50")).toEqual({ status: "unlisted" });
    expect(placeOfHeadType("VPTW60")).toBe("deferred");
    expect(linkedUnitTable["U-Y"].unit).toBe("U-Y");
    expect(linkedRuntimeCalls.units["U-Y"]).toBe(linkedUnitTable["U-Y"]);
    expect(linkedUnitCodecs["U-Y"]).toBe(typhoonUnitCodec);
  });

  // acceptance: 解析（P3-C14-SUBJECT・ANALYSIS-FACTS・LIFECYCLE・EXPIRY）。
  it("P3-C14-T02 acceptance / AC02: analysis subjects, every time's numbers, the lifecycle table, expiry and operation separation", () => {
    // 事実: 14 時刻（実況・推定・予報 12）。緯度経度は数、予報円は中心と半径（km）、ノットは読まない。
    const talim = activeAnalysis(send(emptyState(), TALIM).state, "normal/typhoonAnalysis/TC1725");
    expect(talim.frames.map((frame) => `${frame.kind[0]}${frame.hours}`).join(",")).toBe("a0,e1,f3,f6,f9,f12,f15,f18,f21,f24,f48,f72,f96,f120");
    expect(talim.frames.filter((frame) => frame.circleRadiusKm != null)).toHaveLength(12);
    expect(talim).toMatchObject({ name: { name: "TALIM", nameKana: "タリム", number: "1718", remark: null }, baseTime: ms("2017-09-13T21:00:00+09:00"),
      activeUntil: ms("2017-09-13T21:45:00+09:00") + 12 * HOUR, retainUntil: ms("2017-09-13T21:45:00+09:00") + 7 * day, truncated: false });
    expect(talim.frames[0]).toMatchObject({ kind: "analysis", hours: 0, validTime: ms("2017-09-13T21:00:00+09:00"), category: "台風(TY)", intensity: "非常に強い",
      center: { latitude: 25.5, longitude: 125.5 }, circleRadiusKm: null, location: "宮古島の北約80km", moveDirection: "北北西", moveSpeedKmh: 10, pressureHpa: 950,
      maxWindMs: 45, maxGustMs: 60, storm: { thresholdMs: 25, axes: [{ direction: null, radiusKm: 150 }] }, gale: { thresholdMs: 15, axes: [{ direction: null, radiusKm: 390 }] }, stormWarning: null });
    expect(talim.frames[2]).toMatchObject({ kind: "forecast", hours: 3, center: { latitude: 25.7, longitude: 125.1 }, circleRadiusKm: 30, storm: null });
    expect(talim.frames[2].stormWarning).not.toBeNull();
    expect(talim.frames[3]).toMatchObject({ moveCondition: "ゆっくり", moveSpeedKmh: null });
    expect(talim.frames.at(-1)).toMatchObject({ category: "温帯低気圧(LOW)", hours: 120 });
    // 空タグは null で 0 にしない（風速 0 は電文が 0 と書いた値、半径の「なし」は null、座標の空タグは中心 null）。
    const sample = activeAnalysis(send(emptyState(), A01).state, TC2001);
    expect(sample.frames[0]).toMatchObject({ maxWindMs: 15, storm: { thresholdMs: 25, axes: [{ direction: null, radiusKm: null }] } });
    expect(sample.name).toEqual({ name: null, nameKana: null, number: null, remark: "台風発生予想" });
    expect(sample).toMatchObject({ activeUntil: ms("2020-09-28T15:50:00+09:00") + 12 * HOUR, retainUntil: ms("2020-09-28T15:50:00+09:00") + 7 * day });
    expect(sample.frames.some((frame) => frame.maxWindMs === 0)).toBe(true);
    const emptyCenter = activeAnalysis(sendXml(emptyState(), analysisXml({ coordinate: "" }), "VPTW60").state, TC2606);
    expect(emptyCenter.frames[0]).toMatchObject({ center: null });
    // VPTW62 と合成の度分の無い座標。ii は鍵に入れず、VPTW60 と VPTW61 に同じ TC 番号の報を流すと同じ記録。
    expect(activeAnalysis(send(emptyState(), W62).state, "normal/typhoonAnalysis/TC2003").frames).toHaveLength(3);
    expect(activeAnalysis(send(emptyState(), "synthetic_VPTW60_TC2606").state, TC2606).frames[0].center).toEqual({ latitude: 20, longitude: 135 });
    const viaTwo = sendAs(send(emptyState(), A01).state, A01, "VPTW61", compose(at("2020-09-28T15:51:00+09:00"), serial("4")));
    expect([viaTwo.state.analysis.length, viaTwo.state.analysis[0].source.family, reasonOf(viaTwo)]).toEqual([1, "VPTW61", "changed"]);
    // 発生取消（VPTW61）は台風の終わり（ended terminal）。ほかの Remark と表に無い文、階級 LOW だけの報は active。
    const ended = send(emptyState(), END);
    expect(recordOf(ended.state, "normal/typhoonAnalysis/TC2002")).toMatchObject({ effective: "ended", endCause: "terminal" });
    expect(ended.intents).toEqual([]);
    for (const remark of ["台風消滅（温帯低気圧化）", "台風消滅（熱帯低気圧化）", "台風消滅（域外へ出る）", "台風発生の可能性が小さくなった"])
      expect(recordOf(sendXml(emptyState(), analysisXml({ remark }), "VPTW60").state, TC2606), remark).toMatchObject({ effective: "ended", endCause: "terminal" });
    for (const remark of ["台風発生", "台風発生（域外から入る）", "台風発生予想", "温帯低気圧化しつつある", "発表間隔変更（３時間ごと）", "台風消滅（温帯低気圧化）。", "台風消滅"])
      expect(recordOf(sendXml(emptyState(), analysisXml({ remark }), "VPTW60").state, TC2606)?.effective, remark).toBe("active");
    expect(recordOf(sendXml(emptyState(), analysisXml({ category: "温帯低気圧(LOW)" }), "VPTW60").state, TC2606)?.effective).toBe("active");
    // 見える期限（ReportDateTime＋12 時間）の 1 ms 前は残り、到来で無音に ended。記録は +7 日で除く（1 ms 前は残る）。
    const edge = send(emptyState(), A01).state;
    const until = sample.activeUntil;
    expect(tick(edge, until - 1).state.analysis).toBe(edge.analysis);
    const expired = tick(edge, until);
    expect(expired.state.analysis[0]).toMatchObject({ effective: "ended", endCause: "expired" });
    expect([expired.intents, kindOf(expired), expired.displayChanges.length]).toEqual([[], ["semantic"], 1]);
    expect(tick(edge, sample.retainUntil - 1).state.analysis[0].effective).toBe("ended");
    expect(tick(expired.state, sample.retainUntil - 1).state.analysis).toBe(expired.state.analysis);
    expect(tick(expired.state, sample.retainUntil).state.analysis).toEqual([]);
    // 運用区分: training に替えた同じ報は別の subject で、normal の記録と交差しない。
    const both = send(send(emptyState(), A01).state, A01, status("訓練"));
    expect(both.state.analysis.map((item) => [item.operation, item.subject])).toEqual([["normal", TC2001], ["training", TC2001.replace("normal", "training")]]);
    expect(both.intents.map((item) => item.channel)).toEqual(["desktop"]);
  });

  // acceptance: 確率（P3-C14-PROB-FACTS・PROB-VALIDATION・ZERO・EXPIRY）。
  it("P3-C14-T03 acceptance / AC03: probability facts, validation, zero and consecutive zero, truncation and expiry", () => {
    const real = activeProbability(send(emptyState(), P41).state, P2606);
    // 1 以上の地域 273 だけを持ち、daily 5 つ・peak・peakSlot を持つ。3 時間ごとの確率が全部 0 なら peak 0・peakSlot null。府県予報区等の表は採った地域をちょうど覆う。
    expect(real).toMatchObject({ slotCount: 40, maxFiveDay: 100, truncated: false, baseTime: ms("2026-05-31T09:00:00+09:00"), name: { name: "JANGMI", number: "2606", remark: null },
      activeUntil: ms("2026-05-31T09:55:00+09:00") + 12 * HOUR, retainUntil: ms("2026-05-31T09:55:00+09:00") + 7 * day });
    expect(real.areas).toHaveLength(273);
    expect(real.areas.find((area) => area.code === "070011")).toEqual({ code: "070011", name: "中通り北部", prefectureCode: "070000", daily: [0, 0, 0, 1, 1], peak: 0, peakSlot: null });
    expect(real.areas.find((area) => area.code === "473002")).toEqual({ code: "473002", name: "多良間島", prefectureCode: "473000", daily: [2, 2, 2, 2, 2], peak: 2, peakSlot: 7 });
    expect(real.prefectures.map((item) => item.code)).toEqual([...new Set(real.areas.map((area) => area.prefectureCode))].sort());
    expect(real.areas.map((area) => area.code)).toEqual(real.areas.map((area) => area.code).sort());
    const first = activeProbability(send(emptyState(), P01).state, P2001);
    expect([first.areas.length, first.prefectures.length, first.maxFiveDay]).toEqual([273, 45, 100]);
    expect(first.areas.find((area) => area.code === "472000")).toMatchObject({ daily: [100, 100, 100, 100, 100], peak: 100, peakSlot: 6 });
    // 全ゼロの報は zero（見えない、事実を持たない）。
    const zero = send(emptyState(), P87);
    expect(zero.state.probability[0]).toEqual({ subject: P2606, operation: "normal", source: expect.objectContaining({ serialRaw: "87" }), retainUntil: ms("2026-06-02T15:55:00+09:00") + 7 * day, effective: "zero" });
    expect([zero.intents, kindOf(zero), toTyphoonView(zero.state).probability]).toEqual([[], ["revisionOnly"], []]);
    // 見える記録からの zero は info を 1 回（desktop＋sound）、zero の後の zero（連続ゼロ）は revisionOnly で鳴らさない。
    const visible = send(emptyState(), P41);
    const toZero = send(visible.state, PZERO);
    expect([kindOf(toZero), toZero.intents.map((item) => [item.channel, item.payload.level, item.transition, item.payload.body])]).toEqual([["semantic"], [
      ["desktop", "info", "released", "台風第6号（JANGMI） 暴風域に入る確率1%以上の地域なし"], ["sound", "info", "released", "台風第6号（JANGMI） 暴風域に入る確率1%以上の地域なし"]]]);
    expect(toZero.displayChanges).toMatchObject([{ before: { current: { effective: "active" } }, after: null }]);
    const twice = send(toZero.state, P87);
    expect([kindOf(twice), twice.intents, twice.state.probability[0].effective, twice.state.probability[0].source.serialRaw]).toEqual([["revisionOnly"], [], "zero", "87"]);
    // zero から見える記録への戻りは probabilityAppear（記憶から）。
    const back = send(twice.state, P41, compose(at("2026-06-03T09:55:00+09:00"), serial("93")));
    expect([kindOf(back), back.intents.map((item) => item.transition), back.state.probability[0].effective]).toEqual([["semantic"], ["activated", "activated"], "active"]);
    // 地域の無い報・地域の重複する報は拒否（最初の一 reason）。state は同じ参照。
    const noArea = send(emptyState(), "synthetic_VPTA50_TC2606_noarea");
    expect([reasonOf(noArea), noArea.state.probability]).toEqual(["requiredStructureMissing", []]);
    const duplicated = send(visible.state, "typhoon-probability-card/synthetic_VPTA50_duplicate_area");
    expect([reasonOf(duplicated), duplicated.state]).toEqual(["requiredStructureInvalid", visible.state]);
    // 節の検証: 地域の集合の不一致・PT6H（全部の時間帯）・値の範囲外・refID の欠け。時系列の隙間と TimeDefine 65 個は P3-WS-T04 で受理に変わった。
    const base = [{ code: "010001", daily: [1, 2, 3, 4, 5], slots: [5, 9] }, { code: "010002", daily: [0, 0, 0, 0, 1], slots: [1] }] as const;
    const bad = (label: string, xml: string) => expect([label, reasonOf(sendXml(emptyState(), xml, "VPTA50"))], label).toEqual([label, "requiredStructureInvalid"]);
    expect(reasonOf(sendXml(emptyState(), probabilityXml({ areas: base }), "VPTA50"))).toBe("changed");
    bad("series areas differ", probabilityXml({ areas: base, seriesAreas: [base[0], { code: "010003", daily: [0, 0, 0, 0, 1] }] }));
    bad("series misses an area", probabilityXml({ areas: base, seriesAreas: [base[0]] }));
    bad("PT6H", probabilityXml({ areas: base, duration: "PT6H" }));
    bad("first TimeDefine not TargetDateTime", probabilityXml({ areas: base }).replace(/(<TimeDefine timeId="1"><DateTime>)[^<]*/, `$1${iso(T0 + HOUR)}`));
    bad("value 101", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 101] }] }));
    bad("refID skipped", probabilityXml({ areas: base, slotCount: 3 }).replace('refID="2"', 'refID="7"'));
    bad("area code not 6 digits", probabilityXml({ areas: [{ code: "01001", daily: [1, 1, 1, 1, 1] }] }));
    bad("prefecture code with two names", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1] }, { code: "010002", prefecture: "別の名前", daily: [1, 1, 1, 1, 1] }] }));
    bad("5-day section shows a code twice", probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, 1] }, { code: "010001", daily: [1, 1, 1, 1, 1] }] }));
    // 5 日積算が全部 0 で 3 時間ごとだけ 1 以上（積算が単調でない）報は maxFiveDay を決められず拒否する。
    bad("slots above zero but five-day zero", probabilityXml({ areas: [{ code: "010001", daily: [0, 0, 0, 0, 0], slots: [3] }] }));
    // 見える期限（ReportDateTime＋12 時間）の 1 ms 前は残り、到来で無音に ended。記憶は +7 日で除く。
    const until = real.activeUntil;
    expect(tick(visible.state, until - 1).state.probability).toBe(visible.state.probability);
    const expired = tick(visible.state, until);
    expect([expired.state.probability[0], expired.intents, kindOf(expired)]).toMatchObject([{ effective: "ended", endCause: "expired" }, [], ["semantic"]]);
    expect(tick(visible.state, real.retainUntil - 1).state.probability).toHaveLength(1);
    expect(tick(visible.state, real.retainUntil).state.probability).toEqual([]);
    // zero も +7 日で除く。
    expect(tick(zero.state, zero.state.probability[0].retainUntil - 1).state.probability).toHaveLength(1);
    expect(tick(zero.state, zero.state.probability[0].retainUntil).state.probability).toEqual([]);
  });

  // acceptance: slice をまたぐ終わり（P3-C14-TERMINAL・TERMINAL-LATE）。
  it("P3-C14-T04 acceptance / AC04: a terminal analysis ends the same operation's probability once, silently, and its later reports are memory only", () => {
    const visible = send(emptyState(), P41);
    const issued = visible.state.intents.map((item) => item.id);
    expect(issued).toHaveLength(2);
    const lowered = send(visible.state, LOWERING);
    // 一回の参照交換で解析と確率の 2 subject を変える。確率は ended（terminal）で source は自分の版のまま、通知 0、そのsubjectのpendingは全部 superseded。
    expect(lowered.decisions.map((item) => [item.subject, item.decision === "changed" ? item.change : null, item.decision === "changed" && item.currentEstablished != null])).toEqual([
      [TC2606, "revisionOnly", true], [P2606, "semantic", false]]);
    expect(lowered.state.analysis[0]).toMatchObject({ effective: "ended", endCause: "terminal" });
    expect(lowered.state.probability[0]).toMatchObject({ effective: "ended", endCause: "terminal", source: { serialRaw: "41" } });
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる。
    expect([lowered.intents, pendingOf(lowered.state, P2606), lowered.state.intents]).toEqual([[], [], []]);
    // 表示が変わる（確率の見える記録が消える）ので outcome の change は semantic（I-U-Y.currentSemantics(5)）。解析の decision は revisionOnly のまま。
    expect(lowered.outcomes).toMatchObject([{ kind: "accepted", change: "semantic", subjects: [{ subject: TC2606, transition: "ended" }, { subject: P2606, transition: "ended" }] }]);
    expect(lowered.displayChanges).toMatchObject([{ subject: P2606, before: { current: { effective: "active" } }, after: null }]);
    expect(lowered.state.persistence.currentGeneration).toBe(visible.state.persistence.currentGeneration + 1);
    // 解析が terminal の間の確率の報は記憶だけ（ended terminal、source と retainUntil はこの報へ進む）。見せない・鳴らさない。
    const later = sendXml(lowered.state, probN(1, T0, { eventId: "TC2606", serial: "48", report: "2026-05-31T15:55:00+09:00", target: "2026-05-31T15:00:00+09:00",
      areas: [{ code: "010001", daily: [1, 1, 1, 1, 9], slots: [9] }] }), "VPTA50");
    expect([kindOf(later), later.intents, later.state.probability[0]]).toMatchObject([["revisionOnly"], [], { effective: "ended", endCause: "terminal", source: { serialRaw: "48" } }]);
    expect(toTyphoonView(later.state).probability).toEqual([]);
    // 解析の新しい版が active で採られれば、以後の確率の報は見える。
    const revived = sendXml(later.state, analysisXml({ serial: "43", report: "2026-05-31T16:45:00+09:00", target: "2026-05-31T16:00:00+09:00" }), "VPTW60");
    expect(revived.state.analysis[0].effective).toBe("active");
    const seen = sendXml(revived.state, probN(1, T0, { eventId: "TC2606", serial: "49", report: "2026-05-31T21:55:00+09:00", target: "2026-05-31T21:00:00+09:00",
      areas: [{ code: "010001", daily: [1, 1, 1, 1, 9], slots: [9] }] }), "VPTA50");
    expect([seen.state.probability[0].effective, seen.intents.map((item) => item.transition)]).toEqual(["active", ["activated", "activated"]]);
    // 解析の取消は確率を変えない（確率の slice も pending も同じ参照・同じ値）。
    const cancel = sendXml(visible.state, analysisXml({ info: "取消", report: "2026-05-31T10:45:00+09:00" }).replace(/<Body[\s\S]*<\/Body>/, ""), "VPTW60");
    expect(cancel.state.analysis[0].effective).toBe("cancelled");
    expect([cancel.state.probability, pendingOf(cancel.state, P2606).length]).toEqual([visible.state.probability, 2]);
    // training の終わりは normal の確率を変えない。
    const training = send(visible.state, LOWERING, status("訓練"));
    expect([training.state.probability, training.state.analysis.map((item) => item.subject), training.decisions.length]).toEqual([visible.state.probability, [TC2606.replace("normal", "training")], 1]);
    // 確率が zero か記録の無い subject への終わりは確率の slice を変えない。
    const withZero = send(emptyState(), P87);
    const endZero = send(withZero.state, LOWERING, at("2026-06-02T16:45:00+09:00"));
    expect([endZero.state.probability, endZero.decisions.length]).toEqual([withZero.state.probability, 1]);
    // 台風消滅の報が見える解析を終わらせると analysisTerminal を info で 1 回鳴らす（本文は札＋Remark）。
    const shown = send(emptyState(), LOWERING, at("2026-05-31T10:45:00+09:00"));
    const lowerAfter = sendXml(sendXml(emptyState(), analysisXml({ serial: "41", report: "2026-05-31T09:45:00+09:00", target: "2026-05-31T09:00:00+09:00" }), "VPTW60").state,
      analysisXml({ serial: "42", remark: "台風消滅（温帯低気圧化）" }), "VPTW60");
    expect(shown.intents).toEqual([]);
    expect(lowerAfter.intents.map((item) => [item.payload.level, item.transition, item.payload.body])).toEqual([
      ["info", "released", "台風第6号（JANGMI） 台風消滅（温帯低気圧化）"], ["info", "released", "台風第6号（JANGMI） 台風消滅（温帯低気圧化）"]]);
    // 自身を退去した終わりの報は確率を終わらせない（P3-C14-CAPACITY (2): state の参照と保存世代を変えず通知を作らない）。
    // normal の解析 64 で満杯 → training の確率 TC9000 が active → training の TC9000 の台風消滅の解析は退去できる記録が無く自身を退去する。
    const fullAnalysis = fillAnalysis(64);
    const trainingProbability = sendXml(fullAnalysis, status("訓練")(probN(9000)), "VPTA50");
    expect(trainingProbability.state.probability[0]).toMatchObject({ subject: "training/typhoonProbability/TC9000", effective: "active" });
    const reportAt = iso(T0 + 9000 * 60_000 + 3_600_000);
    const selfEvicted = sendXml(trainingProbability.state, status("訓練")(analysisXml({ eventId: "TC9000", serial: "2", report: reportAt, target: iso(T0 + 9000 * 60_000 + 3_000_000),
      remark: "台風消滅（域外へ出る）" })), "VPTW60");
    expect([selfEvicted.state, selfEvicted.intents, kindOf(selfEvicted), evictions(selfEvicted).length]).toEqual([trainingProbability.state, [], ["revisionOnly"], 1]);
    expect(selfEvicted.state.probability[0].effective).toBe("active");
  });

  // acceptance: 版・取消・遅着（Q-ENUM.revisionOrder・P3-C14-CANCEL-SCOPE・P3-C14-RETENTION）。
  it("P3-C14-T05 acceptance / AC05: revision order, same-version conflict, cancel scope and the late arrival rule", () => {
    // 同じ版の重複は duplicate、食い違いは先着を保って stale＋typhoonRevisionConflict（後着の報の未確認の印、P3-VM-AC03・AC04）。
    const first = send(emptyState(), A01);
    const duplicate = send(first.state, A01);
    expect([reasonOf(duplicate), duplicate.state, duplicate.diagnostics]).toEqual(["duplicate", first.state, []]);
    const conflict = send(first.state, A01, (xml) => xml.replace(">1002<", ">1001<"));
    const { unconfirmed: mark, ...kept } = conflict.state.analysis[0];
    expect([reasonOf(conflict), kept, mark?.inputId, conflict.diagnostics]).toMatchObject(["stale", first.state.analysis[0], conflict.diagnostics[0]?.inputId,
      [{ level: "WARN", reason: "typhoonRevisionConflict", component: "typhoon", unit: "U-Y" }]]);
    // 実不具合の再発防止（K7 発注 2b の契約適合の見直し、P3-VM-AC04）: 印は記録が state から消えるまで残る。見える期限で記憶（ended）になっても、
    // 保存・復元の後も同じ印で、retainUntil で記録が消えると印も消える。
    const reported = ms("2020-09-28T15:50:00+09:00");
    const lapsed = tick(conflict.state, reported + 12 * HOUR).state;
    const reread = typhoonUnitCodec.decode(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(lapsed))) as JsonValue);
    expect([lapsed.analysis[0].effective, lapsed.analysis[0].unconfirmed, reread.kind === "restored" && reread.state.analysis[0].unconfirmed,
      tick(lapsed, lapsed.analysis[0].retainUntil).state.analysis]).toEqual(["ended", mark, mark, []]);
    // 訂正の採用（Head・Serial が同じで Control/DateTime が新しい）と、Control/DateTime がさらに新しい 2 通目の訂正の採用（P3-VM-AC03）。
    const corrected = send(first.state, A02);
    expect([kindOf(corrected), corrected.intents.map((item) => item.transition), corrected.state.analysis[0].source.infoTypeRaw]).toEqual([["semantic"], ["updated", "updated"], "訂正"]);
    const second = send(corrected.state, A03);
    expect([reasonOf(second), second.diagnostics, second.state.analysis[0].source.inputId]).toEqual(["changed", [], expect.stringContaining(A03)]);
    // Serial は新旧に使わない（P3-VM-AC03）: 同じ Control/DateTime で Serial だけが違う・欠ける報は duplicate、事実も違えば先着を保って stale。
    const noSerial = send(first.state, A01, withoutTag("Serial"));
    expect([reasonOf(noSerial), noSerial.state]).toEqual(["duplicate", first.state]);
    expect(reasonOf(send(send(emptyState(), A01, withoutTag("Serial")).state, A01))).toBe("duplicate");
    expect(reasonOf(send(send(emptyState(), A01, serial("9")).state, A01, compose(serial("10"), (xml) => xml.replace(">1002<", ">1001<"))))).toBe("stale");
    // 記憶（zero・ended）に同じ版で種類の違う報が来たら stale＋typhoonRevisionConflict、同じ種類なら duplicate。
    const zeroXml = (five: number) => probabilityXml({ eventId: "TC2606", report: "2026-06-02T15:55:00+09:00", target: "2026-06-02T15:00:00+09:00", serial: "87",
      areas: [{ code: "010001", daily: [five, five, five, five, five], slots: [five] }] });
    const zeroed = sendXml(emptyState(), zeroXml(0), "VPTA50");
    expect(zeroed.state.probability[0].effective).toBe("zero");
    const zeroConflict = sendXml(zeroed.state, zeroXml(7), "VPTA50");
    const { unconfirmed: zeroMark, ...zeroKept } = zeroConflict.state.probability[0];
    expect([reasonOf(zeroConflict), zeroKept, zeroMark != null, zeroConflict.diagnostics.map((item) => item.reason)]).toEqual(["stale", zeroed.state.probability[0], true,
      ["typhoonRevisionConflict"]]);
    expect(reasonOf(sendXml(zeroed.state, zeroXml(0), "VPTA50"))).toBe("duplicate");
    // 実不具合の再発防止（K7 発注 2b のレビュー）: 期限で記憶（ended）になった後の同じ時刻の訂正は、見える記録のときと同じく stale で印を付ける
    // （正規化した InfoType の一致は見える・見えない記録に共通、D-SAME-REPORT）。同じ報の再送は duplicate。
    const expired = tick(first.state, ms("2020-09-28T15:50:00+09:00") + 12 * HOUR).state;
    const lateCorrection = send(expired, A01, infoType("訂正"));
    expect([expired.analysis[0].effective, reasonOf(send(expired, A01)), reasonOf(lateCorrection), lateCorrection.state.analysis[0].unconfirmed?.infoTypeRaw])
      .toEqual(["ended", "duplicate", "stale", "訂正"]);
    const terminalEnded = send(emptyState(), END);
    expect(reasonOf(send(terminalEnded.state, END))).toBe("duplicate");
    const endConflict = send(terminalEnded.state, END, (xml) => xml.replace(/<Remark>[^<]*<\/Remark>/, "<Remark>台風発生</Remark>"));
    expect([reasonOf(endConflict), endConflict.diagnostics.map((item) => item.reason)]).toEqual(["stale", ["typhoonRevisionConflict"]]);
    // 取消先着: 記憶だけの取消（通知 0）で、取消以前の報は stale で復活せず、取消より新しい報は新しい報として採る。
    const cancelFirst = send(emptyState(), CANCEL_A);
    expect([kindOf(cancelFirst), cancelFirst.intents, cancelFirst.state.analysis[0].effective]).toEqual([["revisionOnly"], [], "cancelled"]);
    const revived = send(cancelFirst.state, A01);
    expect([reasonOf(revived), revived.state, revived.intents]).toEqual(["stale", cancelFirst.state, []]);
    expect(send(cancelFirst.state, CANCEL_A).decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    const newer = send(cancelFirst.state, A04);
    expect([kindOf(newer), newer.intents.map((item) => item.transition), newer.state.analysis[0].effective]).toEqual([["semantic"], ["activated", "activated"], "active"]);
    expect(reasonOf(send(send(emptyState(), CANCEL_P).state, P01))).toBe("stale");
    // 見える記録への取消は cancel を鳴らし、その subject の pending を全部置き換える。
    const cancelled = send(first.state, CANCEL_A);
    expect([cancelled.intents.map((item) => item.payload.level), pendingOf(cancelled.state, TC2001).map((item) => item.transition), cancelled.state.analysis[0].effective])
      .toEqual([["cancel", "cancel"], ["cancelled", "cancelled"], "cancelled"]);
    // 遅着: 記憶の期限（+7 日）の以後の報は unchanged/stale で state を変えない（1 ms 前は記憶として採る）。
    const reportMs = ms("2020-09-28T15:50:00+09:00");
    const tooLate = send(emptyState(), A01, undefined, reportMs + 7 * day);
    expect([reasonOf(tooLate), tooLate.state.analysis, tooLate.nextDeadline]).toEqual(["stale", [], null]);
    const memory = send(emptyState(), A01, undefined, reportMs + 7 * day - 1);
    expect([kindOf(memory), memory.intents, memory.state.analysis[0]]).toMatchObject([["revisionOnly"], [], { effective: "ended", endCause: "expired" }]);
    // 見える期限（+12 時間）を過ぎ記憶の期限の内側の新しい版は記憶としてだけ採り、前の active を終わらせて pending を 0 にする（changed/semantic、通知 0）。
    const atEdge = send(first.state, A04, undefined, ms("2020-09-28T18:50:00+09:00") + 13 * HOUR);
    expect([kindOf(atEdge), atEdge.intents, atEdge.state.analysis[0].effective, pendingOf(atEdge.state, TC2001), atEdge.displayChanges.length]).toEqual([["semantic"], [], "ended", [], 1]);
    // 満杯の slice に記録の無い subject の遅着は記録を作らず、退去も起こさない（unchanged/stale、同じ参照）。
    const full = fillAnalysis(64);
    const lateNewcomer = sendXml(full, analysisN(100), "VPTW60", ms(iso(T0 + 100 * 60_000)) + 13 * HOUR);
    expect([reasonOf(lateNewcomer), lateNewcomer.state, evictions(lateNewcomer)]).toEqual(["stale", full, []]);
    const fullProb = fillProbability(64);
    const lateProbability = sendXml(fullProb, probN(100), "VPTA50", ms(iso(T0 + 100 * 60_000)) + 13 * HOUR);
    expect([reasonOf(lateProbability), lateProbability.state]).toEqual(["stale", fullProb]);
  });

  // contractBoundary: 容量と受信 1 回の費用（P3-C14-CAPACITY・BOUNDS・PROB-FACTS）。
  it("P3-C14-T06 contractBoundary / AC06: per-slice counts, bounds with code point cuts, pending and terminal budgets, per-record cost", () => {
    const evicted = { level: "INFO", component: "typhoon", reason: "typhoonCapacityEvicted", unit: "U-Y", count: 1 };
    // 解析 64/65・確率 64/65: normal の受理は最も古い見える記録を退去し、診断を返す。もう一方の slice は同じ参照。
    const analysis64 = fillAnalysis(64), probability64 = fillProbability(64, analysis64);
    expect([analysis64.analysis.length, probability64.probability.length]).toEqual([64, 64]);
    expect(evictions(sendXml(fillAnalysis(63), analysisN(63), "VPTW60"))).toEqual([]);
    const a65 = sendXml(probability64, analysisN(64), "VPTW60");
    expect([evictions(a65), a65.state.analysis.length, a65.state.analysis.some((item) => item.subject.endsWith("TC0000")), a65.state.probability]).toEqual([[evicted], 64, false, probability64.probability]);
    const p65 = sendXml(probability64, probN(64), "VPTA50");
    expect([evictions(p65), p65.state.probability.length, p65.state.probability.some((item) => item.subject.endsWith("TC0000")), p65.state.analysis]).toEqual([[evicted], 64, false, probability64.analysis]);
    expect(a65.decisions.some((item) => item.decision === "rejected")).toBe(false);

    // 文字列と件数の上限（ちょうどと +1）: title 64/65・名前 24/25・時刻 24/25・軸 2/3・地域 384/385・府県予報区等 96/97。コードポイントの境界で切る。
    const one = (xml: string) => activeAnalysis(sendXml(emptyState(), xml, "VPTW60").state, TC2606);
    const named = (length: number) => one(headTitle("題".repeat(length))(analysisXml({ name: "名".repeat(length), later: [] })));
    const exact = named(24), over = named(25);
    expect([exact.truncated, exact.name.name?.length]).toEqual([false, 24]);
    expect([over.truncated, over.name.name?.length, over.title.length]).toEqual([true, 24, 25]);
    expect(activeAnalysis(sendXml(emptyState(), headTitle("題".repeat(65))(analysisXml()), "VPTW60").state, TC2606)).toMatchObject({ truncated: true, title: "題".repeat(64) });
    const cutAtPair = one(analysisXml({ name: `${"あ".repeat(23)}𠮷` }));
    expect([cutAtPair.name.name, cutAtPair.truncated, /[\ud800-\udbff]$/.test(cutAtPair.name.name ?? "")]).toEqual(["あ".repeat(23), true, false]);
    expect(one(analysisXml({ later: Array.from({ length: 23 }, () => "予報　３時間後") })).frames).toHaveLength(24);
    expect(one(analysisXml({ axes: 2 })).frames[0].storm?.axes).toHaveLength(2);
    // 確率: 地域 384 はそのまま、385 は 5 日積算の低い方から捨てて truncated（同じなら code の小さい方を残す）。
    const area = (index: number, five: number, prefecture = 10000) => ({ code: six(100000 + index), daily: [1, 1, 1, 1, five], prefectureCode: six(prefecture), prefecture: `県${prefecture}`, slots: [1] });
    const probability = (areas: ReturnType<typeof area>[]) => activeProbability(sendXml(emptyState(), probabilityXml({ areas }), "VPTA50").state, P2606);
    const many = (count: number) => Array.from({ length: count }, (_, index) => area(index, 1 + index % 100));
    const p384 = probability(many(384)), p385 = probability(many(385));
    expect([p384.areas.length, p384.truncated, p385.areas.length, p385.truncated]).toEqual([384, false, 384, true]);
    expect([p385.areas.some((item) => item.code === six(100300)), p385.areas.some((item) => item.code === six(100000))]).toEqual([false, true]);
    // 府県予報区等 96 はそのまま、97 個目になる地域は件数に余裕があっても飛ばす（表は採った地域をちょうど覆う）。
    const spread = (count: number) => Array.from({ length: count }, (_, index) => area(index, 100 - Math.floor(index / 2), 10000 + index * 1000));
    const p96 = probability(spread(96)), p97 = probability(spread(97));
    expect([p96.prefectures.length, p96.truncated, p97.prefectures.length, p97.areas.length, p97.truncated]).toEqual([96, false, 96, 96, true]);
    expect(p97.prefectures.map((item) => item.code)).toEqual([...new Set(p97.areas.map((item) => item.prefectureCode))].sort());
    expect(typhoonUnitCodec.decode(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(sendXml(emptyState(), probabilityXml({ areas: spread(97) }), "VPTA50").state))) as JsonValue).kind).toBe("restored");
    // decode は 97 個の府県予報区等の表を unavailable にする。
    const tooMany = JSON.parse(JSON.stringify(typhoonUnitCodec.encode(sendXml(emptyState(), probabilityXml({ areas: spread(96) }), "VPTA50").state)));
    tooMany.probability[0].prefectures.push({ code: "999999", name: "余分" });
    expect(typhoonUnitCodec.decode(tooMany).kind).toBe("invalid");

    // pending は 128 件まで（64 subject × 2 channel）。129 件目からは新しい intent が外れ、診断 notificationCapacityEvicted を返す。
    const pending = fillAnalysis(64);
    expect(pending.intents.filter((item) => item.disposition === "pending")).toHaveLength(128);
    const over64 = sendXml(pending, analysisN(64), "VPTW60");
    expect(over64.diagnostics).toContainEqual({ level: "INFO", component: "typhoon", reason: "notificationCapacityEvicted", unit: "U-Y", count: 2 });
    expect(over64.state.intents.filter((item) => item.disposition === "pending")).toHaveLength(128);
    // intentUpdate で attempts が 1 桁から 5 桁になっても予約の内側で decode できる。
    const grown = reduceTyphoonUnit(pending, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending.intents.map((item) => ({ ...item, attempts: 12_345,
      nextAttemptAt: T0 + 1_234_567_890, disposition: "pending" as const, lossReason: null })) });
    expect(typhoonUnitCodec.decode(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(grown.state))) as JsonValue).kind).toBe("restored");
    // 終端記録の予算は無くなった（P3-NL-AC05 (2)）: 終端の更新は intent を外す。
    const delivered = reduceTyphoonUnit(pending, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending.intents.map((item) => ({ id: item.id, attempts: 1,
      nextAttemptAt: T0, disposition: "delivered" as const, lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null })) }).state;
    expect(delivered.intents).toEqual([]);
    // pending の「実 byte＋予約」131,072 ちょうどは decode でき、131,073 は unavailable（予約は deliveryGrowth を import して数える）。
    const own = sendXml(emptyState(), analysisXml(), "VPTW60").state.analysis[0];
    const make = (index: number, bodyLength: number) => ({ id: `U-Y:${own.subject}:${String(index).padStart(6, "0")}:desktop`, unit: "U-Y" as const, subject: own.subject,
      operation: "normal" as const, source: own.source, transition: "updated" as const, channel: "desktop" as const,
      payload: { domain: "weather" as const, level: "normal" as const, title: "t".repeat(160), body: "b".repeat(bodyLength) }, createdAt: T0, expiresAt: T0 + 180_000,
      nextAttemptAt: T0, attempts: 0, configRevision: "p3-typhoon-unit-v5", disposition: "pending" as const, lastAttempt: null, replayed: false, priorityGroup: "other" as const });
    const total = (list: readonly ReturnType<typeof make>[]) => 2 + Math.max(list.length - 1, 0) + list.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + reserve(item), 0);
    const lengths: number[] = [];
    while (total(lengths.map((length, index) => make(index, length))) <= 131_072) lengths.push(512);
    let excess = total(lengths.map((length, index) => make(index, length))) - 131_072;
    for (let index = lengths.length - 1; excess > 0; index--) { const cutBy = Math.min(excess, 511); lengths[index] -= cutBy; excess -= cutBy; }
    const exactList = lengths.map((length, index) => make(index, length));
    expect([total(exactList), exactList.length <= 128]).toEqual([131_072, true]);
    const withIntents = (list: readonly object[]) => ({ ...(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(emptyState()))) as Record<string, JsonValue>), intents: list as JsonValue });
    expect(typhoonUnitCodec.decode(withIntents(exactList)).kind).toBe("restored");
    const oneOver = exactList.map((item, index) => index === 0 ? { ...item, payload: { ...item.payload, body: `${item.payload.body}b` } } : item);
    expect([total(oneOver), typhoonUnitCodec.decode(withIntents(oneOver)).kind]).toEqual([131_073, "invalid"]);

    // 受信 1 回の費用は報の要素の数に比例し、state・slice の全体は直列化しない。直列化は intent 1 件ごと（16 KB 未満）で、変えない slice の配列は同じ参照。
    const loaded = fillProbability(64, fillAnalysis(64));
    const material = decodeXml(probN(200), "VPTA50");
    const sizes: number[] = [];
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      const out = stringify(value, replacer as never, space as never);
      sizes.push(out.length);
      return out;
    });
    let probe: TyphoonUnitStep;
    try { probe = receive(loaded, material, clock(Date.parse(material.reportDateTimeRaw))); } finally { spy.mockRestore(); }
    expect(Math.max(...sizes, 0)).toBeLessThan(16_384);
    expect(probe.state.analysis).toBe(loaded.analysis);
    // 1.85 MB の確率の報 1 通の処理（decode・reduce・encode）の所要を記録する（報告用、閾値は置かない）。
    const t0 = performance.now();
    const big = decodeFixture(P41);
    const t1 = performance.now();
    const reduced = receive(emptyState(), big, clock(Date.parse(big.reportDateTimeRaw)));
    const t2 = performance.now();
    JSON.stringify(typhoonUnitCodec.encode(reduced.state));
    const t3 = performance.now();
    console.log(`P3-C14-AC06 1.85MB probability: decode ${(t1 - t0).toFixed(1)} ms, reduce ${(t2 - t1).toFixed(1)} ms, encode ${(t3 - t2).toFixed(1)} ms`);
  });

  // contractBoundary: 保存と復元と view（P3-C14-SNAPSHOT・I-U-Y.decode・I-U-Y.restore）。
  it("P3-C14-T07 contractBoundary / AC07: codec round trip, every decode bound, restore inputs and the view", () => {
    // 記録の全種類: 解析の active・ended（terminal・expired）・cancelled、確率の active・zero・ended・cancelled、intent。
    let state = send(emptyState(), A01).state;
    state = send(state, END).state;
    state = send(state, CANCEL_A, eventId("TC2005")).state;
    state = send(state, P41).state;
    state = send(state, P87, eventId("TC2007")).state;
    state = send(state, CANCEL_P, eventId("TC2008")).state;
    state = sendXml(state, analysisXml({ eventId: "TC2009", report: "2020-09-20T00:00:00+09:00", target: "2020-09-19T23:00:00+09:00" }), "VPTW60", ms("2020-09-20T00:00:00+09:00") + 13 * HOUR).state;
    const kinds = records(state).map((item) => item.effective === "ended" ? `ended:${item.endCause}` : item.effective);
    expect(new Set(kinds)).toEqual(new Set(["active", "ended:terminal", "ended:expired", "cancelled", "zero"]));
    const encoded = JSON.parse(JSON.stringify(typhoonUnitCodec.encode(state))) as Record<string, JsonValue>;
    const decoded = typhoonUnitCodec.decode(encoded);
    expect(decoded.kind).toBe("restored");
    expect(decoded.kind === "restored" ? JSON.parse(JSON.stringify(typhoonUnitCodec.encode(decoded.state))) : null).toEqual(encoded);
    expect(decoded.kind === "restored" ? [decoded.state.contentRevision, decoded.state.persistence.kind] : null).toEqual([0, "saved"]);
    expect(generationBytes(typhoonUnitCodec.encode(state))).toBeLessThan(8_388_608);
    // decode は受理と同じ上限で全部確かめ、一つでも外れれば unavailable。
    const withProbability = send(emptyState(), P41).state, withAnalysis = send(emptyState(), A01).state;
    const isRow = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
    const R = (value: unknown): Record<string, unknown> => { if (!isRow(value)) throw new Error("not an object"); return value; };
    const L = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error("not a list"); return value; };
    const clone = (value: TyphoonUnitState): Record<string, unknown> => R(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(value))));
    const analysis0 = (json: Record<string, unknown>) => R(L(json.analysis)[0]), probability0 = (json: Record<string, unknown>) => R(L(json.probability)[0]);
    const frame = (json: Record<string, unknown>, index: number) => R(L(analysis0(json).frames)[index]);
    const area0 = (json: Record<string, unknown>) => R(L(probability0(json).areas)[0]);
    const intent = (json: Record<string, unknown>, index: number) => R(L(json.intents)[index]);
    const byEffective = (rows: unknown, effective: string) => R(L(rows).find((item) => R(item).effective === effective));
    const bump = (row: Record<string, unknown>, key: string, delta: number) => { row[key] = Number(row[key]) + delta; };
    const mutations: readonly [string, TyphoonUnitState, (json: Record<string, unknown>) => void][] = [
      ["schemaVersion", withAnalysis, (json) => { json.schemaVersion = "p3-typhoon-unit-v0"; }],
      ["analysis 65 records", withAnalysis, (json) => { json.analysis = Array.from({ length: 65 }, (_, index) => ({ ...analysis0(json), subject: `normal/typhoonAnalysis/TC${index}`,
        source: { ...R(analysis0(json).source), subject: `normal/typhoonAnalysis/TC${index}` } })); }],
      ["duplicate subject", withAnalysis, (json) => { L(json.analysis).push(analysis0(json)); }],
      ["subject of the other slice", withAnalysis, (json) => { analysis0(json).subject = "normal/typhoonProbability/TC2001"; }],
      ["source family of the other slice", withAnalysis, (json) => { R(analysis0(json).source).family = "VPTA50"; }],
      ["source subject differs", withAnalysis, (json) => { R(analysis0(json).source).subject = "normal/typhoonAnalysis/TC9999"; }],
      ["mark of another subject", withAnalysis, (json) => { analysis0(json).unconfirmed = { ...R(analysis0(json).source), subject: "normal/typhoonAnalysis/TC9999" }; }],
      ["retainUntil off by one", withAnalysis, (json) => { bump(analysis0(json), "retainUntil", 1); }],
      ["activeUntil off by one", withAnalysis, (json) => { bump(analysis0(json), "activeUntil", -1); }],
      ["no 実況 frame", withAnalysis, (json) => { frame(json, 0).kind = "estimate"; frame(json, 0).hours = 1; }],
      ["frames 25", withAnalysis, (json) => { analysis0(json).frames = Array.from({ length: 25 }, (_, index) => index === 0 ? frame(json, 0) : frame(json, 1)); }],
      ["hours not matching the kind", withAnalysis, (json) => { frame(json, 1).hours = 2; }],
      ["latitude with two decimals", withAnalysis, (json) => { R(frame(json, 0).center).latitude = 25.55; }],
      ["circle radius on a 実況 time", withAnalysis, (json) => { frame(json, 0).circleRadiusKm = 10; }],
      ["axes 3", withAnalysis, (json) => { R(frame(json, 0).storm).axes = [{ direction: null, radiusKm: 1 }, { direction: null, radiusKm: 1 }, { direction: null, radiusKm: 1 }]; }],
      ["validTime outside the Date range", withAnalysis, (json) => { frame(json, 0).validTime = 8.64e15 + 1; }],
      ["validTime a fraction", withAnalysis, (json) => { frame(json, 0).validTime = 1.5; }],
      ["baseTime a huge double", withAnalysis, (json) => { analysis0(json).baseTime = 1e300; }],
      ["probability baseTime outside the Date range", withProbability, (json) => { probability0(json).baseTime = -8.64e15 - 1; }],
      ["ended with facts", state, (json) => { byEffective(json.analysis, "ended").title = "題"; }],
      ["ended with an unknown cause", state, (json) => { byEffective(json.analysis, "ended").endCause = "other"; }],
      ["cancelled with facts", state, (json) => { byEffective(json.analysis, "cancelled").frames = []; }],
      ["zero with facts", state, (json) => { byEffective(json.probability, "zero").areas = []; }],
      ["maxFiveDay differs", withProbability, (json) => { bump(probability0(json), "maxFiveDay", -1); }],
      ["peakSlot not below slotCount", withProbability, (json) => { area0(json).peakSlot = 40; area0(json).peak = 1; }],
      ["peak 0 with a slot", withProbability, (json) => { R(L(probability0(json).areas).find((item) => R(item).peak === 0)).peakSlot = 0; }],
      ["prefecture table lacks one", withProbability, (json) => { L(probability0(json).prefectures).pop(); }],
      ["prefecture table has an extra", withProbability, (json) => { L(probability0(json).prefectures).push({ code: "999999", name: "余分" }); }],
      ["areas out of code order", withProbability, (json) => { L(probability0(json).areas).reverse(); }],
      ["daily with 4 values", withProbability, (json) => { L(area0(json).daily).pop(); }],
      ["area code not 6 digits", withProbability, (json) => { area0(json).code = "1"; }],
      ["no areas in an active record", withProbability, (json) => { probability0(json).areas = []; probability0(json).prefectures = []; }],
      ["intent of another unit", withAnalysis, (json) => { intent(json, 0).unit = "U-M"; }],
      ["intent level outside the table", withAnalysis, (json) => { R(intent(json, 0).payload).level = "warning"; }],
      ["intent domain", withAnalysis, (json) => { R(intent(json, 0).payload).domain = "earthquake-eew"; }],
      ["intent id twice", withAnalysis, (json) => { intent(json, 1).id = intent(json, 0).id; }],
    ];
    for (const [label, from, change] of mutations) {
      const json = clone(from);
      change(json);
      expect([label, typhoonUnitCodec.decode(JSON.parse(JSON.stringify(json))).kind], label).toEqual([label, "invalid"]);
    }
    // 本番の owner の時計は小数なので、intent の時刻は finite で、小数の時刻の intent を持つ世代も restored（I-U-Y.decode）。
    const fractional = send(emptyState(), A01, undefined, Date.parse(decodeFixture(A01).reportDateTimeRaw) + 0.25).state;
    expect(fractional.intents.length).toBeGreaterThan(0);
    expect(fractional.intents.every((item) => !Number.isInteger(item.createdAt))).toBe(true);
    const fractionalJson = JSON.parse(JSON.stringify(typhoonUnitCodec.encode(fractional))) as Record<string, JsonValue>;
    const fractionalBack = typhoonUnitCodec.decode(fractionalJson);
    expect(fractionalBack.kind === "restored" ? JSON.parse(JSON.stringify(typhoonUnitCodec.encode(fractionalBack.state))) : fractionalBack.kind).toEqual(fractionalJson);
    // 受理が通す上限ちょうどの記録は decode も通す（時刻 24・軸 2・地域 384・府県予報区等 96）。
    const widest = analysisXml({ later: Array.from({ length: 23 }, () => "予報　３時間後"), axes: 2 });
    const bigAnalysis = sendXml(emptyState(), widest, "VPTW60").state;
    expect(typhoonUnitCodec.decode(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(bigAnalysis)))).kind).toBe("restored");
    // restore 入力: 期限の前は復元した見える記録だけを displayChanges に載せ、intent を新しく作らない。
    const persisted = typhoonUnitCodec.encode(state);
    const restoreAt = (time: number, from: TyphoonUnitState = emptyState()) => reduceTyphoonUnit(from, { kind: "restore", persisted, clock: clock(time, time) });
    const early = restoreAt(ms("2020-09-28T16:00:00+09:00") - 100 * day);
    expect(early.intents).toEqual([]);
    expect(early.displayChanges.map((item) => item.subject).sort()).toEqual([TC2001, P2606].sort());
    expect(early.state.persistence).toEqual(emptyState().persistence);
    expect(early.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-Y"] }]);
    // 見える期限を過ぎた active は無音で ended、retainUntil を過ぎた記録は除く。どちらも保存世代を進める。
    const past = restoreAt(sendRestoreTime(state, "active") + 1);
    expect(past.state.persistence.currentGeneration).toBe(1);
    expect(records(past.state).some((item) => item.effective === "active")).toBe(false);
    expect([past.displayChanges, past.intents]).toEqual([[], []]);
    const gone = restoreAt(ms("2030-01-01T00:00:00+09:00"));
    // intent の期限の回収は復元の後の最初の期限処理で行うので、残る期限は intent の expiresAt の最小。
    expect([records(gone.state), gone.state.persistence.currentGeneration, gone.nextDeadline]).toEqual([[], 1, { wallTimeMs: Math.min(...gone.state.intents.map((item) => item.expiresAt)), monotonicMs: null }]);
    expect(tick(gone.state, ms("2030-01-01T00:00:00+09:00")).nextDeadline).toBeNull();
    // 復元に失敗した保存物は requiredStructureInvalid の拒否で state を変えない。
    const bad = reduceTyphoonUnit(early.state, { kind: "restore", persisted: { ...persisted, schemaVersion: "x" } as never, clock: clock(0) });
    expect([bad.decisions[0], bad.state]).toMatchObject([{ decision: "rejected", reason: "requiredStructureInvalid" }, early.state]);
    // view は active だけを載せ、ended・cancelled・zero を載せない。
    const view = toTyphoonView(state);
    expect([view.unit, view.analysis.map((item) => item.subject), view.probability.map((item) => item.subject), view.subjects.map((item) => item.subject)]).toEqual([
      "U-Y", [TC2001], [P2606], [TC2001, P2606]]);
    // 受理の変化で contentRevision が進み、不変の入力では進まない。
    expect([reduceTyphoonUnit(emptyState(), { kind: "shutdown", clock: clock(0) }).state.contentRevision, send(emptyState(), A01).state.contentRevision, send(emptyState(), END).state.contentRevision]).toEqual([0, 1, 0]);
  });

  // acceptance: Q-NOTICE（機会・level・silent・overlap・payload・timing・replacement・intentUpdate・operation）。
  it("P3-C14-T08 acceptance / AC08: generation opportunities, levels, silent cases, replacement, payload and operation channels", () => {
    // 新しい subject の見える採用: desktop＋sound の 2 件、normal、activated。時刻は採用の時計から（sound 60 秒・desktop 180 秒）。
    const appeared = send(emptyState(), A01);
    expect(appeared.intents.map((item) => [item.channel, item.payload.level, item.transition, item.payload.domain, item.createdAt, item.expiresAt - item.createdAt, item.unit]))
      .toEqual([["desktop", "normal", "activated", "weather", ms("2020-09-28T15:50:00+09:00"), 180_000, "U-Y"], ["sound", "normal", "activated", "weather", ms("2020-09-28T15:50:00+09:00"), 60_000, "U-Y"]]);
    expect(appeared.intents[0].payload).toEqual({ domain: "weather", level: "normal", title: "台風解析・予報情報", body: "熱帯低気圧（TC2001） 熱帯低気圧(TD) マリアナ諸島" });
    // 階級の変化（category・intensity・size）は normal の updated。位置・予報だけの続報は鳴らさない（記憶の差し替えだけ）。
    const base = analysisXml({ category: "熱帯低気圧(TD)" });
    const v1 = sendXml(emptyState(), base, "VPTW60");
    const moved = sendXml(v1.state, analysisXml({ category: "熱帯低気圧(TD)", serial: "43", coordinate: "+26.5+126.5/", report: "2026-05-31T11:45:00+09:00", target: "2026-05-31T11:00:00+09:00" }), "VPTW60");
    expect([kindOf(moved), moved.intents, moved.state.analysis[0].source.serialRaw]).toEqual([["semantic"], [], "43"]);
    expect(pendingOf(moved.state, TC2606)).toHaveLength(2);
    for (const [label, change] of [["category", { category: "台風(TS)" }], ["intensity", { category: "熱帯低気圧(TD)", intensity: "強い" }], ["size", { category: "熱帯低気圧(TD)", size: "大型" }]] as const) {
      const step = sendXml(v1.state, analysisXml({ ...change, serial: "43", report: "2026-05-31T11:45:00+09:00", target: "2026-05-31T11:00:00+09:00" }), "VPTW60");
      expect([label, step.intents.map((item) => [item.channel, item.transition, item.payload.level])], label).toEqual([label, [["desktop", "updated", "normal"], ["sound", "updated", "normal"]]]);
      // 置換: 同じ subject・channel の古い pending は intents から外れ（P3-NL-AC05 (1)）、新しい pending が 2 件。
      expect([label, step.state.intents.length, pendingOf(step.state, TC2606).length]).toEqual([label, 2, 2]);
    }
    // 訂正は事実が同じでも作る（[訂正]・「訂正: 」）。
    const correction = send(appeared.state, A01, compose(infoType("訂正"), control("2020-09-28T15:52:00+09:00")));
    expect(correction.intents.map((item) => [item.transition, item.payload.title, item.payload.body.startsWith("訂正: 熱帯低気圧（TC2001） ")])).toEqual([
      ["updated", "[訂正] 台風解析・予報情報", true], ["updated", "[訂正] 台風解析・予報情報", true]]);
    // 見えない記録（記憶）への訂正は見える記録への訂正でなく見える採用なので activated（題の前置きは [訂正]）。
    const memory = send(emptyState(), CANCEL_A);
    const reborn = send(memory.state, A04, infoType("訂正"));
    expect(reborn.intents.map((item) => [item.transition, item.payload.title])).toEqual([["activated", "[訂正] 台風解析・予報情報"], ["activated", "[訂正] 台風解析・予報情報"]]);
    // 確率: 立ち上がり・最大の変化は normal、同じ最大は鳴らさない（地域の値が変わっても）。
    const one = (five: number, slots: number, serialNo: string, report: string) => probabilityXml({ areas: [{ code: "010001", daily: [1, 1, 1, 1, five], slots: [slots] }], serial: serialNo, report,
      target: iso(ms(report) - 55 * 60_000) });
    const p1 = sendXml(emptyState(), one(10, 3, "41", "2026-05-31T09:55:00+09:00"), "VPTA50");
    expect(p1.intents.map((item) => [item.transition, item.payload.body])).toEqual([["activated", "台風第6号（JANGMI） 最大 10%（県/地域010001）"], ["activated", "台風第6号（JANGMI） 最大 10%（県/地域010001）"]]);
    const same = sendXml(p1.state, one(10, 4, "42", "2026-05-31T10:55:00+09:00"), "VPTA50");
    expect([kindOf(same), same.intents]).toEqual([["semantic"], []]);
    const changedMax = sendXml(same.state, one(20, 4, "43", "2026-05-31T11:55:00+09:00"), "VPTA50");
    expect(changedMax.intents.map((item) => [item.transition, item.payload.level])).toEqual([["updated", "normal"], ["updated", "normal"]]);
    // 期限・記憶だけの採用・取消の記憶・連続ゼロ・復元・recovery は鳴らさない。
    expect(tick(p1.state, p1.state.probability[0].retainUntil).intents).toEqual([]);
    expect(send(emptyState(), CANCEL_A).intents).toEqual([]);
    expect(send(emptyState(), A01, undefined, ms("2020-09-28T15:50:00+09:00") + 13 * HOUR).intents).toEqual([]);
    expect(reduceTyphoonUnit(emptyState(), { kind: "restore", persisted: typhoonUnitCodec.encode(appeared.state), clock: clock(ms("2020-09-28T16:00:00+09:00")) }).intents).toEqual([]);
    // training/test は desktop だけで、題に接頭辞を置く（接頭辞は切る範囲の外）。
    const training = send(emptyState(), A01, status("訓練")), test = send(emptyState(), A01, status("試験"));
    expect([training.intents.map((item) => [item.channel, item.payload.title]), test.intents.map((item) => [item.channel, item.payload.title])]).toEqual([
      [["desktop", "【訓練】台風解析・予報情報"]], [["desktop", "【試験】台風解析・予報情報"]]]);
    const longTitle = sendXml(emptyState(), headTitle("題".repeat(64))(analysisXml({ info: "訂正" })), "VPTW60");
    expect(longTitle.intents[0].payload.title.length).toBeLessThanOrEqual(160);
    expect(longTitle.intents[0].payload.title.startsWith("[訂正] 題")).toBe(true);
    // 一入力の intent は各 channel 最大 1 件で、id は unit・subject・系列・版の鍵・遷移・channel から決まる（世代番号を含まない、P3-NL-AC01）。
    expect(appeared.intents.map((item) => item.id)).toEqual(appeared.intents.map((item) => JSON.stringify(["U-Y", TC2001, "", versionKey(item.source),
      item.transition, item.channel])));
    // intentUpdate: 既存の id だけを更新し、未知の id と同値は no-op（同じ参照）。delivered は intents から外れる（P3-NL-AC05 (1)）。
    const id = appeared.intents[0].id;
    const delivered = reduceTyphoonUnit(appeared.state, { kind: "intentUpdate", clock: clock(T0), intentUpdate: { id, attempts: 1, nextAttemptAt: T0, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null } });
    expect([delivered.decisions.map((item) => item.decision === "changed" ? item.change : null), delivered.state.intents.some((item) => item.id === id)]).toEqual([["deliveryOnly"], false]);
    const noop = reduceTyphoonUnit(delivered.state, { kind: "intentUpdate", clock: clock(T0), intentUpdate: [{ id, attempts: 1, nextAttemptAt: T0, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null }, { id: "none", attempts: 1, nextAttemptAt: T0, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null }] });
    expect([noop.state, noop.decisions]).toEqual([delivered.state, []]);
  });

  // contractBoundary: origin=recovery は適用しない（P3-C14-N2）。
  it("P3-C14-T12 contractBoundary / AC14: recovery inputs leave every slice unchanged", () => {
    const loaded = send(send(emptyState(), A01).state, P41).state;
    const recovered = (name: string, transform?: (xml: string) => string) => reduceTyphoonUnit(loaded, { kind: "receive",
      material: decodeFixture(name, transform, undefined, undefined, "recovery"), clock: clock(ms("2026-06-01T00:00:00+09:00")) });
    for (const [name, transform] of [[A04, undefined], [CANCEL_A, undefined], [P87, undefined], [CANCEL_P, undefined], [LOWERING, undefined], [A01, eventId("TC9999")]] as const) {
      const step = recovered(name, transform);
      expect([name, step.state, step.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision), step.intents, step.outcomes]).toEqual([name, loaded, ["noChange"], [], []]);
    }
    // 意味検証が先: 不備のある recovery の報は拒否される。
    expect(reasonOf(recovered(A01, eventId("")))).toBe("identityMissing");
  });

  // contractBoundary: 退去の適格性と自身の退去（P3-C14-EVICT-OPERATION、K4・K4N と同じ受入）。
  it("P3-C14-T14 contractBoundary / AC16: eligibility by operation, self eviction and the pending of a self-evicted cancel", () => {
    const training = (index: number, base = T0, o: Parameters<typeof analysisXml>[0] = {}) => status("訓練")(analysisN(index, base, o));
    const cancelOf = (index: number, base = T0) => analysisN(index, base, { info: "取消" }).replace(/<Body[\s\S]*<\/Body>/, "");
    // (a) normal の見える 63＋cancelled の記憶 1 の満杯に training の新しい報: 記憶は残り、受けた記録が自身を退去する。
    const full = sendXml(fillAnalysis(63), cancelOf(63), "VPTW60").state;
    expect([full.analysis.length, full.analysis.filter((item) => item.effective === "cancelled").length]).toEqual([64, 1]);
    const self = sendXml(full, training(70), "VPTW60");
    expect(self.decisions).toEqual([{ subject: "training/typhoonAnalysis/TC0070", operation: "training", decision: "changed", reason: null, change: "revisionOnly", currentEstablished: null }]);
    expect(self.outcomes).toEqual([{ kind: "accepted", change: "revisionOnly", subjects: [] }]);
    expect([self.diagnostics, self.intents, self.state, self.state.persistence.currentGeneration, self.displayChanges]).toEqual([[{ level: "INFO", component: "typhoon", reason: "typhoonCapacityEvicted", unit: "U-Y", count: 1 }], [], full, full.persistence.currentGeneration, []]);
    expect(self.state.analysis.some((item) => item.effective === "cancelled")).toBe(true);
    // 続く取消より古い normal の報は unchanged/stale。
    expect(reasonOf(sendXml(self.state, analysisN(63, T0, { info: "発表", serial: "0" }), "VPTW60"))).toBe("stale");
    // (b) training 1 件を含む満杯では training の記録だけが退去する。
    const mixed = sendXml(fillAnalysis(63), training(80), "VPTW60").state;
    const evictsTraining = sendXml(mixed, training(81), "VPTW60");
    expect([evictions(evictsTraining).length, evictsTraining.state.analysis.filter((item) => item.operation === "training").map((item) => item.subject), evictsTraining.state.analysis.filter((item) => item.operation === "normal").length])
      .toEqual([1, ["training/typhoonAnalysis/TC0081"], 63]);
    // (c) retainUntil を過ぎた normal の記録も training の受理で退去しない。
    const later = T0 + 8 * day;
    const stale = sendXml(full, training(90, later), "VPTW60", ms(iso(later + 90 * 60_000)));
    expect([stale.state, evictions(stale).length]).toEqual([full, 1]);
    // normal の受理は retainUntil を過ぎた記録を最優先で退去する。
    const normalIn = sendXml(full, analysisN(90, later), "VPTW60", ms(iso(later + 90 * 60_000)));
    expect([evictions(normalIn).length, normalIn.state.analysis.some((item) => item.subject === "normal/typhoonAnalysis/TC0000")]).toEqual([1, false]);
    // (d) 自身を退去した training の取消は、そのsubjectの pending を superseded にし、intents が変わったときだけ保存世代を進める。
    const holder = sendXml(sendXml(fillAnalysis(63), training(100), "VPTW60").state, training(101), "VPTW60");
    const pendingBefore = holder.state.intents.filter((item) => item.subject === "training/typhoonAnalysis/TC0100" && item.disposition === "pending");
    expect(pendingBefore).toHaveLength(1);
    const refill = fillAnalysis(64);
    const withPending = { ...refill, intents: holder.state.intents };
    const cancelSelf = sendXml(withPending, status("訓練")(cancelOf(100)), "VPTW60");
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる。
    expect(cancelSelf.state.intents.filter((item) => item.subject === "training/typhoonAnalysis/TC0100")).toEqual([]);
    expect(cancelSelf.state.persistence.currentGeneration).toBe(withPending.persistence.currentGeneration + 1);
    const cancelOther = sendXml(withPending, status("訓練")(cancelOf(110)), "VPTW60");
    expect([cancelOther.state, cancelOther.state.persistence.currentGeneration]).toEqual([withPending, withPending.persistence.currentGeneration]);
    // (e) 確率の満杯でも解析の記録は退去されない。
    const probFull = fillProbability(64, fillAnalysis(3));
    const analysisIn = sendXml(probFull, analysisN(50), "VPTW60");
    expect([analysisIn.state.probability, analysisIn.state.analysis.length, evictions(analysisIn)]).toEqual([probFull.probability, 4, []]);
  });

  // contractBoundary: 最大の保存状態からの閉包（P3-X-C4、I-U-Y.capacityReserve）。保存物を XML でなく JSON で直接組み、
  // 各文字列・配列・数値を decode の上限の最長の形にする（時刻は Date の範囲 ±8.64e15 の内側の最長、報の時刻は 15 桁）。
  it("P3-C14-T13 contractBoundary / AC15: from the largest decodable state every operation re-encodes and re-decodes within the generation budget", () => {
    // P3-VM-AC08: 2a の Control/DateTime と 2b の未確認の印の分を足した静的上界（Q-VM-PRECHECK-2B の (5)）に、見える記録 128 件の期限切れの保留の印
    // （21 byte、P3-EF-AC10 (2)）を足す。
    const BOUND = 7_294_879 + 128 * 21;
    const { payload: unmarked, reportMs, EDGE, pendingTotal, pendingList, eventIdOf } = maximumPayload();
    const payload = { ...unmarked, analysis: unmarked.analysis.map((item) => ({ ...item, expiryPending: true })),
      probability: unmarked.probability.map((item) => ({ ...item, expiryPending: true })) };
    expect(pendingTotal(pendingList)).toBe(131_072);
    const restored = typhoonUnitCodec.decode(JSON.parse(JSON.stringify(payload)));
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") return;
    const maximum = restored.state;
    const measured = generationBytes(typhoonUnitCodec.encode(maximum));
    console.info("P3-C14-AC15 largest decodable generation bytes", measured, "static bound", BOUND, "margin to 8 MiB", 8_388_608 - measured);
    expect(measured).toBeLessThanOrEqual(BOUND);
    // P3-UM-AC03 (6)・RES-09: 解析・確率の全部の記録に読み戻しの上限いっぱいの印と予算いっぱいの原文を足した上界も、広げた器の内で decode が受ける。
    const markedPayload = { ...payload, analysis: withLongestMarks(payload.analysis, "section", [], 131_072), probability: withLongestMarks(payload.probability, "section", [], 0) };
    const markedState = typhoonUnitCodec.decode(JSON.parse(JSON.stringify(markedPayload)));
    expect(markedState.kind === "restored" ? generationBytes(typhoonUnitCodec.encode(markedState.state)) <= typhoonUnitCodec.maxEnvelopeBytes! : markedState)
      .toBe(true);
    const closes = (label: string, next: TyphoonUnitState) => {
      const encoded = JSON.parse(JSON.stringify(typhoonUnitCodec.encode(next))) as JsonValue;
      expect([label, typhoonUnitCodec.decode(encoded).kind], label).toEqual([label, "restored"]);
      expect(generationBytes(typhoonUnitCodec.encode(next)), label).toBeLessThanOrEqual(BOUND);
    };
    const at0 = reportMs + day;
    const subjectId = eventIdOf(5);
    // (i) 解析の続報 (ii) 確率の取消 (iii) 新しい subject の報による退去 (iv) intentUpdate で桁を伸ばす (v) 期限処理 (vi) restore 入力 (vii) 解析の終わりの報。
    closes("analysis follow-up", sendXml(maximum, analysisXml({ eventId: subjectId, serial: "9999999999", report: iso(at0), target: iso(at0 - 45 * 60_000) }), "VPTW60", at0).state);
    closes("probability cancel", sendXml(maximum, probabilityXml({ eventId: subjectId, info: "取消", report: iso(at0), target: iso(at0 - 3_600_000), areas: [] }).replace(/<Body[\s\S]*<\/Body>/, ""), "VPTA50", at0).state);
    const evict = sendXml(maximum, analysisXml({ eventId: "TC7777", report: iso(at0), target: iso(at0 - 45 * 60_000) }), "VPTW60", at0);
    expect(evictions(evict).length).toBe(1);
    closes("new subject evicts", evict.state);
    closes("probability eviction", sendXml(maximum, probabilityXml({ eventId: "TC7777", report: iso(at0), target: iso(at0 - 3_600_000), areas: [{ code: "010001", daily: [1, 1, 1, 1, 1], slots: [1] }] }), "VPTA50", at0).state);
    closes("intentUpdate digits", reduceTyphoonUnit(maximum, { kind: "intentUpdate", clock: clock(T0), intentUpdate: maximum.intents.filter((item) => item.disposition === "pending").map((item) => ({ ...item,
      attempts: 123_456_789_012, nextAttemptAt: EDGE, disposition: "pending" as const, lossReason: null })) }).state);
    closes("visible deadline", tick(maximum, reportMs + 12 * HOUR).state);
    closes("retain deadline", tick(maximum, reportMs + 7 * day).state);
    closes("restore input", reduceTyphoonUnit(emptyState(), { kind: "restore", persisted: typhoonUnitCodec.encode(maximum), clock: clock(reportMs + HOUR) }).state);
    const terminalStep = sendXml(maximum, analysisXml({ eventId: subjectId, serial: "9999999999", remark: "台風消滅（域外へ出る）", report: iso(at0), target: iso(at0 - 45 * 60_000) }), "VPTW60", at0);
    expect(terminalStep.state.probability.find((item) => item.subject === `normal/typhoonProbability/${subjectId}`)).toMatchObject({ effective: "ended", endCause: "terminal" });
    closes("terminal analysis", terminalStep.state);
  });
});

describe("P3-WEATHER-SHAPE-001 U-Y partial reading", () => {
  // contractBoundary: P3-WS-D-TYPHOON=A の (1)〜(7)。拒否のまま残す所は P3-C14-T01 の表の P3-WS-T04 の行と P3-C14-T03 の PT6H。
  it("P3-WS-T04 contractBoundary / P3-WS-AC04: unreadable times, axes, fields, sections and slots are dropped with truncated", () => {
    // 受理され、truncated が立ち、保存の形（codec）にそのまま入る。
    const accepted = (xml: string, headType: string) => {
      const step = sendXml(emptyState(), xml, headType);
      expect(typhoonUnitCodec.decode(JSON.parse(JSON.stringify(typhoonUnitCodec.encode(step.state))) as JsonValue).kind).toBe("restored");
      return step.state;
    };
    const analysis = (xml: string) => {
      const record = activeAnalysis(accepted(xml, "VPTW60"), TC2606);
      expect(record.truncated).toBe(true);
      return record;
    };
    const kinds = (record: ReturnType<typeof analysis>) => record.frames.map((frame) => `${frame.kind[0]}${frame.hours}`);
    const forecasts = (count: number) => Array.from({ length: count }, () => "予報　３時間後");
    const lastTime = /<MeteorologicalInfo>(?![\s\S]*<MeteorologicalInfo>)(<DateTime[^>]*>[^<]*<\/DateTime>)(<Item>[\s\S]*?<\/Item>)/;
    // (1) 表の外の type の時刻を落とす。
    expect(kinds(analysis(analysisXml({ later: ["予報　３時間後", "観測　２時間後"] })))).toEqual(["a0", "f3"]);
    // (2) 25 個は実況と先の 23 個を文書の順に残す。25 個目の Item 2 個は読まない。実況が最後でも残す。
    expect(kinds(analysis(analysisXml({ later: forecasts(24) }).replace(lastTime, "<MeteorologicalInfo>$1$2$2")))).toEqual(["a0", ...forecasts(23).map(() => "f3")]);
    const nowLast = analysisXml({ later: forecasts(24) }).replace(/(<MeteorologicalInfos type="台風情報">)(<MeteorologicalInfo>[\s\S]*?<\/MeteorologicalInfo>)([\s\S]*)(<\/MeteorologicalInfos>)/, "$1$3$2$4");
    expect(kinds(analysis(nowLast))).toEqual([...forecasts(23).map(() => "f3"), "a0"]);
    // (3) 実況でない時刻の Item 2 個はその時刻を落とす。
    expect(kinds(analysis(analysisXml().replace(lastTime, "<MeteorologicalInfo>$1$2$2")))).toEqual(["a0"]);
    // (4) 実況の座標の形の外は中心を null に。(5) 軸 3 本の域は axes [] で閾値を残す。
    expect(analysis(analysisXml({ coordinate: "25.5N125.5E" })).frames[0]).toMatchObject({ kind: "analysis", center: null, pressureHpa: 985 });
    expect(analysis(analysisXml({ axes: 3 })).frames.map((frame) => frame.storm)).toEqual([{ thresholdMs: 25, axes: [] }, { thresholdMs: 25, axes: [] }]);

    const base = [{ code: "010001", daily: [1, 2, 3, 4, 5], slots: [5, 0, 9] }, { code: "010002", daily: [0, 0, 0, 0, 1], slots: [1] }] as const;
    const probability = (xml: string) => {
      const record = activeProbability(accepted(xml, "VPTA50"), P2606);
      expect(record.truncated).toBe(true);
      return record;
    };
    // (6) 知らない節と 6 日積算の節は落とす。その地域（019999）は集合の照合に入らない。
    const extra = (type: string) => `<MeteorologicalInfo type="${type}"><Item><Kind><Property><Type>台風の暴風域に入る確率</Type><FiftyKtWindProbabilityPart>`
      + `<FiftyKtWindProbability unit="%">9</FiftyKtWindProbability></FiftyKtWindProbabilityPart></Property></Kind><Area><Name>余分</Name><Code>019999</Code>`
      + `<Prefecture>県</Prefecture><PrefectureCode>010000</PrefectureCode></Area></Item></MeteorologicalInfo>`;
    const sections = probability(probabilityXml({ areas: base }).replace("<TimeSeriesInfo>", `${extra("未知の節")}${extra("台風の暴風域に入る確率（６日積算）")}<TimeSeriesInfo>`));
    expect(sections.areas.map((area) => area.code)).toEqual(["010001", "010002"]);
    // 1〜5 日と時系列が全部 0 で、落とした節にだけ確率がある報は zero（1%以上の地域なしの通知）にせず拒否する（実不具合の再発防止）。
    expect(reasonOf(sendXml(emptyState(), probabilityXml({ areas: [{ code: "010001" }] }).replace("<TimeSeriesInfo>", `${extra("未知の節")}<TimeSeriesInfo>`), "VPTA50"))).toBe("requiredStructureInvalid");
    // (7) 3 個目が PT6H なら 2 個で止め、後の値（9）は peak に入らない。65 個は 64 個まで。
    const sixHours = probability(probabilityXml({ areas: base }).replace(/(<TimeDefine timeId="3"><DateTime>[^<]*<\/DateTime><Duration>)PT3H/, "$1PT6H"));
    expect([sixHours.slotCount, sixHours.areas[0].peak, sixHours.areas[0].peakSlot]).toEqual([2, 5, 0]);
    expect(probability(probabilityXml({ areas: base, slotCount: 65 })).slotCount).toBe(64);
  });
});
// P3-NL-AC08 (1)(4)・AC15 (4): started の pending は復元で外れ、failed・null の pending は欄ごと戻る。
it("P3-NL-T07 contractBoundary / AC08・AC15 (4): U-Y restores failed and null pending with their fields and drops a started one", () => {
  const issued = send(emptyState(), A01);
  expect(issued.intents.length).toBeGreaterThanOrEqual(2);
  expectRestoreStarted({ intents: [issued.intents[0], issued.intents[1]], make: (intents) => ({ ...issued.state, intents }),
    restore: (state, at) => reduceTyphoonUnit(emptyState(), { kind: "restore", persisted: typhoonUnitCodec.encode(state), clock: at }),
    markOf: (state, subject) => [...state.analysis, ...state.probability].find((item) => item.subject === subject)?.notice });
});
