import { describe, expect, it } from "vitest";

import type { DiagnosticDetails, JsonValue } from "../../contracts/p2-shared-runtime.types";
import { briefingUnitCodec } from "../../src/units/briefing/briefing-unit";
import { floodUnitCodec } from "../../src/units/flood/flood-unit";
import { landslideUnitCodec } from "../../src/units/landslide/landslide-unit";
import { localBulletinsUnitCodec } from "../../src/units/local-bulletins/local-bulletins-unit";
import { tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import * as B from "../briefing-unit/briefing-fixture";
import * as L from "../landslide-unit/landslide-fixture";
import * as M from "../local-bulletins-unit/local-bulletins-fixture";
import * as R from "../flood-unit/flood-fixture";
import * as T from "../tsunami-unit/tsunami-fixture";
import * as V from "../volcano-unit/volcano-fixture";

// P3-EXPIRY-FORM-001（K10）発注 2 の試験 P3-EF-T08（AC13、H51）。報は corpus の fixture を試験の中で書き換えて作る（新しい fixture file を足さない）。

type Step = Readonly<{ decisions: readonly Readonly<{ decision: string; reason?: unknown }>[]; diagnostics: readonly DiagnosticDetails[] }>;
// 決定と WARN の理由（INFO の容量の診断などは見ない）。
const shape = (step: Step) => [step.decisions.map((item) => item.decision === "rejected" ? `rejected:${String(item.reason)}` : item.decision),
  step.diagnostics.filter((item) => item.level === "WARN").map((item) => item.reason)];
// 保存して読み戻した記録（読み戻せなければ decode の kind）。
function restored<S>(codec: Readonly<{ encode: (state: S) => unknown; decode: (value: JsonValue) => Readonly<{ kind: string; state?: S }> }>, state: S,
  pick: (state: S) => unknown): unknown {
  const result = codec.decode(JSON.parse(JSON.stringify(codec.encode(state))) as JsonValue);
  return result.kind === "restored" && result.state != null ? pick(result.state) : result.kind;
}
const MISSING = "requiredStructureMissing", INVALID = "requiredStructureInvalid";

describe("P3-EXPIRY-FORM-001 reports with unreadable parts (H51)", () => {
  it("P3-EF-T08 acceptance / AC13: B parts are accepted with one WARN each and the readable parts in state, C parts stay rejected", () => {
    // U-T: 観測の Serial の欠け、予報区の高さの形の外（null）。予報区の Kind の欠けと鍵の形の外は C。
    const tAt = "2099-01-01T09:00:00+09:00", tClock = T.clock(Date.parse(tAt));
    const station = (code: string) => T.observation({ at: tAt, serial: 1, stations: [{ code }] }).replace("<Serial>1</Serial>", "<Serial></Serial>");
    const tSerial = T.receive(T.emptyState(), T.decodeXml(station("21001"), "VTSE51"), tClock);
    expect([shape(tSerial), tSerial.state.observations.map((item) => [item.source.serialRaw, item.stations.map((value) => value.code)])])
      .toEqual([[["changed"], [MISSING]], [["", ["21001"]]]]);
    const tKind = T.receive(T.emptyState(), T.decodeXml(T.vtse41({ at: tAt, areas: [{ code: "311", name: "区域311", kind: "51" }] })
      .replace("<Code>51</Code></Kind>", "</Kind>"), "VTSE41"), tClock);
    expect(shape(tKind)).toEqual([[`rejected:${MISSING}`], [MISSING]]);
    const height = T.decodeFixture("32-39_11_09_250206_VTSE41", "VTSE41");
    const tHeight = T.receive(T.emptyState(), T.decodeXml(T.fixtureXml("32-39_11_09_250206_VTSE41")
      .replace(">10</jmx_eb:TsunamiHeight>", ">高い</jmx_eb:TsunamiHeight>"), "VTSE41"), T.clock(Date.parse(height.reportDateTimeRaw)));
    expect([shape(tHeight), tHeight.state.forecasts[0].effective]).toEqual([[["changed"], [INVALID]], "active"]);
    expect(shape(T.receive(T.emptyState(), T.decodeXml(T.vtse41({ at: tAt, areas: [{ code: "31", name: "区域31", kind: "51" }] }), "VTSE41"), tClock)))
      .toEqual([[`rejected:${INVALID}`], [INVALID]]);
    // AC13 (5): Serial の読めない同じ報の fragment は足し合わせない（P3-C5-OBS-MERGE は Serial が読めた報どうし）。
    const tOther = T.receive(tSerial.state, T.decodeXml(station("21002"), "VTSE51"), tClock);
    // 同じ時刻の別の中身として印を付けて保留し、手元の観測点を残す（K7 の比べ方）。
    expect([shape(tOther), tOther.state.observations[0].stations.map((item) => item.code), tOther.state.observations[0].unconfirmed != null])
      .toEqual([[["unchanged"], [MISSING, "tsunamiRevisionConflict"]], ["21001"], true]);

    // U-V: Serial の形の外、火山名の 2 個（名前は空）、結び付く相手が 2 件の取消（手元を変えない）。降灰の期間の時刻の形の外は C。
    const vAt = V.clock(Date.parse("2020-05-22T13:03:00+09:00"));
    const vSerial = V.send(V.emptyState(), "45_01_01_200522_VFVO50", V.replaceTag("Serial", "1a"));
    expect([shape(vSerial), vSerial.state.alerts.map((item) => [item.volcanoCode, item.source?.serialRaw])]).toEqual([[["changed"], [INVALID]], [["306", ""]]]);
    const vName = V.send(V.emptyState(), "45_01_01_200522_VFVO50", (xml) => xml.replaceAll("<Name>浅間山</Name>", "<Name>浅間山</Name><Name>浅間山</Name>"));
    expect([shape(vName), vName.state.alerts.map((item) => "volcanoName" in item ? [item.volcanoCode, item.volcanoName, item.level] : null)]).toEqual([[["changed"], [INVALID]], [["306", "", 3]]]);
    const one = V.send(V.emptyState(), "45_01_01_200522_VFVO50").state;
    const two = V.receive(one, V.decodeXml(V.fixtureXml("45_01_01_200522_VFVO50").replaceAll("<Code>306</Code>", "<Code>999</Code>"), "VFVO50"), vAt).state;
    const vCancel = V.send(two, "synthetic_VFVO50_cancel");
    // P3-UM-AC19 (1): 2 件とも手元は変えず、記録ごとの決定と取消の報の印（subject は記録の subject）。
    expect([shape(vCancel), vCancel.intents.length, vCancel.state.alerts.map((item) => item.unconfirmed?.subject), two.alerts.length])
      .toEqual([[["unchanged", "unchanged"], [MISSING]], 0, ["normal/volcano:alert/306", "normal/volcano:alert/999"], 2]);
    expect(vCancel.state.alerts.map(({ unconfirmed: _mark, ...item }) => item)).toEqual(two.alerts);
    expect((["eruptions", "ashfalls", "shortfalls", "scheduledAshfalls", "batch", "bulletins"] as const).map((key) => vCancel.state[key] === two[key])).toEqual(Array(6).fill(true));
    expect(shape(V.send(V.emptyState(), "66_01_03_210514_VFVO55", (xml) => xml.replace("<StartTime>2021-05-14T12:31:00+09:00</StartTime>",
      "<StartTime>昼</StartTime>")))).toEqual([[`rejected:${INVALID}`], [INVALID]]);
    // 解説の対象火山の上限（128）を超えた VFVO51 は上限の後を読まず truncated で受ける。
    const areas = Array.from({ length: 129 }, (_, index) => `<Area><Name>火山${index}</Name><Code>V${index}</Code></Area>`).join("");
    const vMany = V.receive(V.emptyState(), V.decodeXml(V.fixtureXml("44_02_01_200522_VFVO51").replace(/(<Areas codeType="火山名">)\s*<Area>[\s\S]*?<\/Area>/,
      `$1${areas}`), "VFVO51"), vAt);
    expect([shape(vMany)[1], vMany.decisions.some((item) => item.decision === "rejected"), vMany.state.bulletins.map((item) => "truncated" in item && item.truncated)])
      .toEqual([[INVALID], false, [true]]);

    // U-L: Serial の形の外、Kind/Name の欠け（名前は空、区分は Code）。Status の表の外は C。
    const lSerial = L.send(L.emptyState(), "15_16_01_241031_VPWW56", L.replaceTag("Serial", "1a"));
    expect([shape(lSerial), lSerial.state.currents.map((item) => item.source.serialRaw)]).toEqual([[["changed"], [INVALID]], [""]]);
    const lName = L.send(L.emptyState(), "15_16_01_241031_VPWW56", (xml) => xml.replaceAll("<Name>レベル４土砂災害危険警報</Name>", ""));
    const lKinds = lName.state.currents[0].effective === "active" ? lName.state.currents[0].kinds : [];
    expect([shape(lName), lKinds.map((item) => [item.code, item.name, item.level])[0]]).toEqual([[["changed"], [MISSING]], ["49", "", 4]]);
    expect(shape(L.send(L.emptyState(), "15_16_01_241031_VPWW56", (xml) => xml.replaceAll("<Status>発表</Status>", "<Status>不明</Status>"))))
      .toEqual([[`rejected:${INVALID}`], [INVALID]]);

    // U-R: Serial の欠け、水位の値の形の外（その値は null）、河川の名前の制御文字（河川は code で残し、名前は空）。
    const rSerial = R.send(R.emptyState(), "16_02_01_220728_VXKO50", (xml) => xml.replace("<Serial>3</Serial>", ""));
    expect([shape(rSerial), rSerial.state.currents.map((item) => item.source.serialRaw)]).toEqual([[["changed"], [MISSING]], [""]]);
    const rValue = R.send(R.emptyState(), "16_02_01_220728_VXKO50", (xml) => xml.replace(">143.00<", ">143.0001<"));
    expect(shape(rValue)).toEqual([["changed"], [INVALID]]);
    // 実不具合（r2）: 河川名が全部読めない新しい版と、次の正しい版で、通知の比べの鍵（河川の code）を替えず鳴らさない。
    const rBase = R.send(R.emptyState(), "16_02_01_220728_VXKO50").state;
    const sent = (second: string) => (xml: string) => xml.replace("<DateTime>2019-05-27T00:00:00Z</DateTime>", `<DateTime>2019-05-27T00:00:0${second}Z</DateTime>`);
    const rRiver = R.send(rBase, "16_02_01_220728_VXKO50", (xml) => sent("1")(xml).replace(/<Information type="指定河川洪水予報（河川）">[\s\S]*?<\/Information>/,
      (part) => part.replace("<Name>○○川</Name>", "<Name>○○\t川</Name>").replace("<Name>△△川</Name>", "<Name>△△\t川</Name>")));
    const rCurrent = rRiver.state.currents[0];
    const rBack = R.send(rRiver.state, "16_02_01_220728_VXKO50", sent("2"));
    expect([shape(rRiver), rCurrent.effective === "active" ? rCurrent.kinds.map((item) => item.rivers.map((river) => [river.code, river.name])) : null,
      rRiver.intents, shape(rBack), rBack.intents]).toEqual([[["changed"], [INVALID]], [[["1234567890", ""], ["9876543210", ""]]], [], [["changed"], []], []]);
    // 実不具合（r1）: 現況の時刻だけ読めない新しい版で、予測の値を現況の位置へ繰り上げて上昇の通知を作らない。
    const rShift = R.send(rBase, "16_02_01_220728_VXKO50", (xml) => xml.replace("<DateTime>2019-05-27T00:00:00Z</DateTime>", "<DateTime>2019-05-27T00:00:01Z</DateTime>")
      .replace(/<MeteorologicalInfos type="水位・流量情報">[\s\S]*?<\/MeteorologicalInfos>/, (part) => part.replace("<DateTime>2019-05-27T09:00:00+09:00</DateTime>",
        "<DateTime>朝</DateTime>")));
    expect([shape(rShift), rShift.intents.filter((item) => item.payload.level === "warning")]).toEqual([[["changed"], [INVALID]], []]);

    // U-B: Serial の欠け、観測の時刻の形の外（その観測を除き truncated）。VPOA50 の記録雨の Kind の外は C。
    const bSerial = B.send(B.emptyState(), "phase6b_VPBS50_KJPTK202608221709_202608221709", (xml) => xml.replace("<Serial>1</Serial>", ""));
    expect([shape(bSerial), bSerial.state.currents.map((item) => item.source.serialRaw)]).toEqual([[["changed"], [MISSING]], [""]]);
    const bFull = B.send(B.emptyState(), "phase6b_VPBS50_KJPTK202608221709_202608221709").state.currents[0];
    const bTime = B.send(B.emptyState(), "phase6b_VPBS50_KJPTK202608221709_202608221709", (xml) => xml.replace("<Time>2026-08-22T17:00:00+09:00</Time>",
      "<Time>2026-08-22T17:00:00Z</Time>"));
    const bCurrent = bTime.state.currents[0];
    expect([shape(bTime), "observations" in bCurrent && "observations" in bFull ? [bCurrent.observations.length + 1 === bFull.observations.length, bCurrent.truncated] : null])
      .toEqual([[["changed"], [INVALID]], [true, true]]);
    expect(shape(B.send(B.emptyState(), "phase6b_VPOA50_JPTK202608221709_202608221709", (xml) => xml.replace("<Code>1</Code>", "<Code>2</Code>"))))
      .toEqual([[`rejected:${INVALID}`], [INVALID]]);

    // U-M: 竜巻の ValidDateTime の形の外は ValidDateTime の無い報と同じ（AC13 (7)）、熱中症の官署の欠けは空。
    const mValid = M.send(M.emptyState(), "19_03_01_130906_VPHW50", M.replaceTag("ValidDateTime", "夕方"));
    const mNone = M.send(M.emptyState(), "19_03_01_130906_VPHW50", (xml) => xml.replace(/<ValidDateTime>[^<]*<\/ValidDateTime>/, ""));
    expect([shape(mValid), mValid.state.tornado.map((item) => item.effective === "active" ? item.activeUntil : null)])
      .toEqual([[["changed"], [INVALID]], mNone.state.tornado.map((item) => item.effective === "active" ? item.activeUntil : null)]);
    // 最も細かい層の区域が全部読めない竜巻も、通知の地域数は同じ層で数える（読めない区域で数える層を替えない）。
    const mFull = M.send(M.emptyState(), "19_03_01_130906_VPHW50");
    const mArea = M.send(M.emptyState(), "19_03_01_130906_VPHW50", (xml) => xml.replace(/<Information type="竜巻注意情報（市町村等）">[\s\S]*?<\/Information>/,
      (part) => part.replace(/<Code>(\d{6,})<\/Code>/g, "<Code>$1x</Code>")));
    // 読めなかった区域の数を添える（P3-UNREADABLE-MARK-001 の AC06、作者裁定 2026-10-26 夜の B）。
    expect([shape(mArea), mArea.intents.map((item) => item.payload.body)]).toEqual([[["changed"], [INVALID]], mFull.intents.map((item) =>
      item.payload.body.replace("発表中 24地域", "発表中 24地域（うち 24 地域は名前を読めず）"))]);
    const mOffice = M.send(M.emptyState(), "57_03_01_240401_VPFT50", M.office(""));
    expect([shape(mOffice), mOffice.state.heat.map((item) => "editorialOffice" in item ? item.editorialOffice : null)]).toEqual([[["changed"], [MISSING]], [""]]);

    // Q-EF-PRECHECK-2 (a): 受け取った報は再起動の復元で捨てられない（空の Serial・空の名前と官署・除いた所の truncated を読み戻す）。
    for (const [label, before, after] of [
      ["U-T Serial", tSerial.state.observations, restored(tsunamiUnitCodec, tSerial.state, (state) => state.observations)],
      ["U-V name", vName.state.alerts, restored(volcanoUnitCodec, vName.state, (state) => state.alerts)],
      ["U-L name", lName.state.currents, restored(landslideUnitCodec, lName.state, (state) => state.currents)],
      ["U-R Serial", rSerial.state.currents, restored(floodUnitCodec, rSerial.state, (state) => state.currents)],
      ["U-R river", rRiver.state.currents, restored(floodUnitCodec, rRiver.state, (state) => state.currents)],
      ["U-B Serial", bSerial.state.currents, restored(briefingUnitCodec, bSerial.state, (state) => state.currents)],
      ["U-B observation", bTime.state.currents, restored(briefingUnitCodec, bTime.state, (state) => state.currents)],
      ["U-M office", mOffice.state.heat, restored(localBulletinsUnitCodec, mOffice.state, (state) => state.heat)],
    ] as const) expect(after, label).toEqual(before);
  });
});
