import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, JsonValue, ReportRef, UnitCodec } from "../../contracts/p2-shared-runtime.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { NankaiUnitState } from "../../contracts/p3-nankai-unit.types";
import type { SeismicUnitState } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import manifest from "../../tools/corpus/manifest.json";
import { compareVersion, versionKey } from "../../src/contracts-revision/version";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { briefingUnitCodec, reduceBriefingUnit } from "../../src/units/briefing/briefing-unit";
import { eewUnitCodec, reduceEewUnit } from "../../src/units/eew/eew-unit";
import { floodUnitCodec, reduceFloodUnit } from "../../src/units/flood/flood-unit";
import { landslideUnitCodec, reduceLandslideUnit } from "../../src/units/landslide/landslide-unit";
import { localBulletinsUnitCodec, reduceLocalBulletinsUnit } from "../../src/units/local-bulletins/local-bulletins-unit";
import { nankaiUnitCodec, reduceNankaiUnit } from "../../src/units/nankai/nankai-unit";
import { reduceSeismicUnit, seismicUnitCodec } from "../../src/units/seismic/seismic-unit";
import { reduceTsunamiUnit, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { reduceTyphoonUnit, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { reduceVolcanoUnit, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { reduceWeatherCurrentUnit, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { observation, vtse41 } from "../tsunami-unit/tsunami-fixture";

// P3-VERSION-MATERIAL-001（K7）の発注 2a の試験（testMapping の P3-VM-T01〜T04・T07）。fixture は corpus manifest のものを使い、
// 後の送信は Control/DateTime（XML の最初の DateTime）を進めて作る。

let sequence = 0;
const pathOf = (fixtureId: string) => manifest.fixtures.find((item) => item.fixtureId === `test__fixtures__${fixtureId}`)!.path;
function decode(xml: string, headType: string): DecodedMaterial {
  const entered = ingestXmlData({ inputId: `vm-${++sequence}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType,
    body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const fixture = (fixtureId: string, headType: string, transform: (xml: string) => string = (xml) => xml) =>
  decode(transform(readFileSync(pathOf(fixtureId), "utf8")), headType);
const sentLater = (seconds: number) => (xml: string) => xml.replace(/<DateTime>([^<]*)<\/DateTime>/, (_, at: string) =>
  `<DateTime>${new Date(Date.parse(at) + seconds * 1000).toISOString()}</DateTime>`);
const withoutControl = (xml: string) => xml.replace(/<DateTime>[^<]*<\/DateTime>/, "<DateTime></DateTime>");
const clockAt = (material: DecodedMaterial, laterMs = 0): ClockReading => ({ wallTimeMs: Date.parse(material.reportDateTimeRaw) + laterMs, monotonicMs: 0 });
// 本文の最初の Name（観測・予報の中身）を替える。
const bodyName = (name: string) => (xml: string) => xml.replace(/(<Body[\s\S]*?<Name>)[^<]*/, `$1${name}`);
const outcome = (decision: { decision: string; reason?: string | null }) => decision.decision === "unchanged" ? decision.reason : decision.decision;

describe("P3-VERSION-MATERIAL-001 発注 2a", () => {
  // regression（台帳 91）: 報番号でなく Control/DateTime で比べる。同じ秒の EEW の続報だけは Serial の大きい方を新しい版とする。
  it("P3-VM-T01 regression / AC03: a later-sent cancel with a smaller Serial is adopted, the reverse is stale, same-second follow-ups advance", () => {
    const FINAL = "77_01_30_260101_VXSE45_FINAL";
    const final42 = fixture(FINAL, "VXSE45", (xml) => xml.replace("<Serial>30</Serial>", "<Serial>42</Serial>"));
    const cancel37 = fixture(FINAL, "VXSE45", (xml) => sentLater(40)(xml.replace("<Serial>30</Serial>", "<Serial>37</Serial>")
      .replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")));
    const eew = (state: EewUnitState, material: DecodedMaterial) => reduceEewUnit(state, { kind: "receive", material, clock: clockAt(final42, 40_000) });
    const forward = eew(eew(initialUnits["U-E"], final42).state, cancel37);
    expect([outcome(forward.decisions[0]), forward.state.gates[0].source.inputId]).toEqual(["changed", cancel37.inputId]);
    const reverse = eew(eew(initialUnits["U-E"], cancel37).state, final42);
    expect([outcome(reverse.decisions[0]), reverse.state.gates[0].source.inputId]).toEqual(["stale", cancel37.inputId]);
    // 同じ Control/DateTime の取消は Serial の例外より先に勝つ（作者裁定 2026-10-21 昼、全分野）。
    const sameCancel = fixture(FINAL, "VXSE45", (xml) => xml.replace("<Serial>30</Serial>", "<Serial>37</Serial>")
      .replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"));
    const issuedFirst = eew(eew(initialUnits["U-E"], final42).state, sameCancel);
    expect([outcome(issuedFirst.decisions[0]), issuedFirst.state.gates[0].source.inputId]).toEqual(["changed", sameCancel.inputId]);
    const cancelledFirst = eew(eew(initialUnits["U-E"], sameCancel).state, final42);
    expect([outcome(cancelledFirst.decisions[0]), cancelledFirst.state.gates[0].source.inputId]).toEqual(["stale", sameCancel.inputId]);
    // 気象庁のサンプルの同じ秒の Control/DateTime の続報 Serial 3・4・5（VXSE44 は新築では受けない）。
    const sameSecond = ["77_01_03_240613_VXSE45", "77_01_04_240613_VXSE45", "77_01_05_240613_VXSE45"].map((id) => fixture(id, "VXSE45"));
    expect(new Set(sameSecond.map((item) => item.controlDateTimeRaw)).size).toBe(1);
    let state = initialUnits["U-E"];
    const steps = sameSecond.map((material) => {
      const step = reduceEewUnit(state, { kind: "receive", material, clock: clockAt(material) });
      state = step.state;
      return [outcome(step.decisions[0]), step.intents.length];
    });
    // 通知の有無は今の U-E の通知条件のまま（Serial の増加だけでは決めない）。
    expect(steps).toEqual([["changed", 2], ["changed", 2], ["changed", 0]]);
    expect([state.current[0].serial, state.gates[0].serial]).toEqual([5, 5]);
    // 逆に #5 の後の #3 は older。
    expect(outcome(reduceEewUnit(state, { kind: "receive", material: sameSecond[0], clock: clockAt(sameSecond[0]) }).decisions[0])).toBe("stale");
  });

  // contractBoundary: 比べる時刻の表（Control だけの種類と Head→Control の種類）、時刻の欠け、版の鍵。
  it("P3-VM-T02 contractBoundary / AC02,AC03: the time table, missing times and the version key", () => {
    const ref = (family: string, head: string, control: string, serialRaw = "1"): ReportRef => ({ inputId: "i", origin: "replay",
      operation: "normal", family, subject: "s", reportDateTimeRaw: head, controlDateTimeRaw: control, serialRaw, infoTypeRaw: "発表" });
    const at = (minute: string) => `2026-10-21T10:${minute}:00Z`;
    const rows: [ReportRef | null, ReportRef, string][] = [
      // Control だけの種類は Head と Control の前後が逆なら Control の新しい方。
      [ref("VXSE53", at("00"), at("05")), ref("VXSE53", at("05"), at("00")), "older"],
      [ref("VXSE53", at("05"), at("00")), ref("VXSE53", at("00"), at("05")), "newer"],
      [ref("VXSE53", at("00"), at("05")), ref("VXSE53", at("09"), at("05")), "same"],
      // Head→Control の種類は Head が先で、Head が同じなら Control。Head が違えば Control の欠けは問わない。
      [ref("VPFJ51", at("00"), at("10")), ref("VPFJ51", at("05"), at("01")), "newer"],
      [ref("VPFJ51", at("00"), at("01")), ref("VPFJ51", at("00"), at("02")), "newer"],
      [ref("VPFJ51", at("00"), ""), ref("VPFJ51", at("05"), ""), "newer"],
      // 欠け: 受けた報の比べる時刻が読めなければ undecidable、手元の版だけが読めなければ newer。
      [ref("VPFJ51", at("00"), at("02")), ref("VPFJ51", at("00"), ""), "undecidable"],
      [ref("VPFJ51", at("00"), ""), ref("VPFJ51", at("00"), at("01")), "newer"],
      [ref("VXSE53", at("00"), at("00")), ref("VXSE53", at("00"), "not a time"), "undecidable"],
      // 表の別の側の種類どうしは両方が持つ Control/DateTime だけ。
      [ref("VPFJ51", at("00"), at("02")), ref("VPHW50", at("05"), at("01")), "older"],
      // 手元の版が無い。
      [null, ref("VXSE53", at("00"), ""), "undecidable"], [null, ref("VPFJ51", at("00"), ""), "newer"],
    ];
    expect(rows.map(([a, b]) => compareVersion(a, b))).toEqual(rows.map(([, , expected]) => expected));
    // 版の鍵: 同じ時刻の書き方の違いは同じ鍵、報番号は EEW だけが鍵に入る。
    expect(versionKey(ref("VXSE53", at("00"), "2026-10-21T19:00:00+09:00", "1"))).toBe(versionKey(ref("VXSE53", at("09"), at("00"), "9")));
    expect(versionKey(ref("VXSE45", at("00"), at("00"), "4"))).not.toBe(versionKey(ref("VXSE45", at("00"), at("00"), "5")));

    // U-Q（VXSE53）: Control/DateTime の欠けた報は断らない。手元の版があれば版を残して印、無ければ採って鳴らし、後の時刻の読める報で
    // 置き換えても時刻の無い版の印は残る（P3-VM-D-MISSING=A）。
    const S53 = "32-35_04_04_240613_VXSE53";
    const timed = fixture(S53, "VXSE53"), untimed = fixture(S53, "VXSE53", withoutControl);
    const quake = (state: SeismicUnitState, material: DecodedMaterial) => reduceSeismicUnit(state, { kind: "receive", material, clock: clockAt(timed) });
    const family = (state: SeismicUnitState) => state.earthquakes[0].contributions.find((item) => item.family === "VXSE53")!;
    const first = quake(initialUnits["U-Q"], timed);
    const held = quake(first.state, untimed);
    expect([outcome(held.decisions[0]), held.diagnostics.map((item) => item.reason), family(held.state).source.inputId,
      family(held.state).unconfirmed?.inputId]).toEqual(["stale", ["requiredStructureMissing"], timed.inputId, untimed.inputId]);
    const alone = quake(initialUnits["U-Q"], untimed);
    expect([outcome(alone.decisions[0]), alone.intents.length > 0, alone.diagnostics.map((item) => item.reason)])
      .toEqual(["changed", true, ["requiredStructureMissing"]]);
    const replaced = quake(alone.state, timed);
    expect([outcome(replaced.decisions[0]), family(replaced.state).source.inputId, family(replaced.state).unconfirmed?.inputId])
      .toEqual(["changed", timed.inputId, untimed.inputId]);

    // U-T（VTSE41）の D-MISSING=A の例: 時刻の欠けた取消を初報で採り、保存→復元の後に時刻の読める古い警報①で置き換わって鳴り、
    // 印は取消のまま残る。①より新しい警報②でも残り、系列が取消で消えると外れる。
    const forecast = (options: Parameters<typeof vtse41>[0]) => decode(vtse41(options), "VTSE41");
    const tsunami = (state: TsunamiUnitState, material: DecodedMaterial) => reduceTsunamiUnit(state, { kind: "receive", material,
      clock: { wallTimeMs: Date.parse("2099-01-01T09:30:00+09:00"), monotonicMs: 0 } });
    const areas = [{ code: "311", name: "千葉県内房", kind: "51" }];
    const cancel = forecast({ at: "2099-01-01T09:20:00+09:00", infoType: "取消", control: "" });
    const cancelled = tsunami(initialUnits["U-T"], cancel);
    expect([outcome(cancelled.decisions[0]), cancelled.diagnostics.map((item) => item.reason)]).toEqual(["changed", ["requiredStructureMissing"]]);
    const decoded = tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(cancelled.state))) as JsonValue);
    if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
    const restored = reduceTsunamiUnit(initialUnits["U-T"], { kind: "restore", persisted: tsunamiUnitCodec.encode(decoded.state),
      clock: { wallTimeMs: Date.parse("2099-01-01T09:30:00+09:00"), monotonicMs: 0 } }).state;
    const warning1 = tsunami(restored, forecast({ at: "2099-01-01T09:00:00+09:00", areas }));
    expect([warning1.state.forecasts[0].effective, warning1.intents.length > 0, warning1.state.forecasts[0].unconfirmed?.inputId])
      .toEqual(["active", true, cancel.inputId]);
    const warning2 = tsunami(warning1.state, forecast({ at: "2099-01-01T09:10:00+09:00", areas: [{ code: "311", name: "千葉県内房", kind: "52" }] }));
    expect([outcome(warning2.decisions[0]), warning2.state.forecasts[0].unconfirmed?.inputId]).toEqual(["changed", cancel.inputId]);
    const ended = tsunami(warning2.state, forecast({ at: "2099-01-01T09:25:00+09:00", infoType: "取消" }));
    expect([ended.state.forecasts[0].effective, ended.state.forecasts[0].unconfirmed]).toEqual(["cancelled", undefined]);
  });

  // contractBoundary: 未確認の印の付け外し（U-Q を代表に。津波観測の fragment の食い違いは tsunami-unit.test.ts の P3-C5-T03）。
  it("P3-VM-T03 contractBoundary / AC03,AC04: a same-time conflict marks the series, survives save and restore and resends, and newer adoption clears it", () => {
    const S53 = "32-35_04_04_240613_VXSE53";
    const original = fixture(S53, "VXSE53");
    const quake = (state: SeismicUnitState, material: DecodedMaterial) => reduceSeismicUnit(state, { kind: "receive", material, clock: clockAt(original) });
    const family = (state: SeismicUnitState) => state.earthquakes[0].contributions.find((item) => item.family === "VXSE53")!;
    const first = quake(initialUnits["U-Q"], original).state;
    const other = fixture(S53, "VXSE53", bodyName("別の震央"));
    const marked = quake(first, other);
    expect([outcome(marked.decisions[0]), marked.diagnostics.map((item) => item.reason), family(marked.state).source.inputId,
      family(marked.state).unconfirmed?.inputId]).toEqual(["stale", ["seismicRevisionConflict"], original.inputId, other.inputId]);
    const restored = seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(marked.state))) as JsonValue);
    expect(restored.kind === "restored" && restored.state.earthquakes).toEqual(marked.state.earthquakes);
    // 同じ中身の再送は duplicate で印を保つ。印と同じ版の鍵の別の中身は印を書き換えない。
    const resent = quake(marked.state, fixture(S53, "VXSE53"));
    expect([outcome(resent.decisions[0]), family(resent.state).unconfirmed?.inputId]).toEqual(["duplicate", other.inputId]);
    const third = quake(marked.state, fixture(S53, "VXSE53", bodyName("三つ目の震央")));
    expect([outcome(third.decisions[0]), third.state]).toEqual(["stale", marked.state]);
    // 新しい版の採用で（時刻の読める）印は外れる。
    const newer = quake(marked.state, fixture(S53, "VXSE53", sentLater(60)));
    expect([outcome(newer.decisions[0]), family(newer.state).unconfirmed]).toEqual(["changed", undefined]);
  });

  // regression（K7 発注 2a のレビュー）: 中身の比べに InfoType を入れる（同じ時刻・同じ観測値の訂正は未確認）。U-N は再起動の後の証拠だけの
  // 情報 subject では現況の版で判定し、保存の証拠の時刻の値を時刻の文字列に戻さない。
  it("P3-VM-T03 regression / AC03,AC04: a same-time correction of equal values is marked, and U-N judges its current behind evidence", () => {
    const tsunami = (state: TsunamiUnitState, material: DecodedMaterial) => reduceTsunamiUnit(state, { kind: "receive", material,
      clock: { wallTimeMs: Date.parse("2099-01-01T09:00:00+09:00"), monotonicMs: 0 } });
    const at = "2099-01-01T09:00:00+09:00", stations = [{ code: "21001", height: "1.0" }];
    const first = tsunami(initialUnits["U-T"], decode(observation({ at, serial: 1, stations }), "VTSE51")).state;
    const correction = decode(observation({ at, serial: 1, stations, infoType: "訂正", control: first.observations[0].controlDateTimeRaw }), "VTSE51");
    const marked = tsunami(first, correction);
    expect([outcome(marked.decisions[0]), marked.diagnostics.map((item) => item.reason), marked.state.observations[0].unconfirmed?.inputId])
      .toEqual(["stale", ["tsunamiRevisionConflict"], correction.inputId]);

    const N = "selected_xml__74_01_05_200512_VYSE50";
    const advisory = fixture(N, "VYSE50");
    const nankai = (state: NankaiUnitState, material: DecodedMaterial) => reduceNankaiUnit(state, { kind: "receive", material, clock: clockAt(advisory) });
    const restore = (payload: JsonValue) => {
      const decoded = nankaiUnitCodec.decode(payload);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      return reduceNankaiUnit(initialUnits["U-N"], { kind: "restore", persisted: nankaiUnitCodec.encode(decoded.state), clock: clockAt(advisory) }).state;
    };
    const saved = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(nankai(initialUnits["U-N"], advisory).state))) as { evidence: Record<string, unknown>[] };
    const restored = restore(saved as unknown as JsonValue);
    const other = fixture(N, "VYSE50", (xml) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"));
    const held = nankai(restored, other);
    expect([held.decisions.map(outcome), held.state.currents[0].unconfirmed?.inputId]).toEqual([["stale", "stale"], other.inputId]);
    const far = restore({ ...saved, evidence: saved.evidence.map((item) => ({ ...item, reportDateTimeMs: Number.MAX_SAFE_INTEGER })) } as unknown as JsonValue);
    expect(nankai(far, advisory).decisions.map(outcome)).toEqual(["duplicate", "duplicate"]);
  });

  // corpusHistory: 同じ報の組の今の出方を保つ（P3-VM-D-SAME-REPORT=A）。降灰の速報と詳細は volcano-unit.test.ts の P3-ORDER-T02、
  // 竜巻の対（U-M）は発注 2b。
  it("P3-VM-T04 corpusHistory / AC03: fragments merge in either order, keep the largest Control/DateTime, and a correction is a new version", () => {
    const tsunami = (state: TsunamiUnitState, material: DecodedMaterial) => reduceTsunamiUnit(state, { kind: "receive", material,
      clock: { wallTimeMs: Date.parse("2011-03-11T15:02:30+09:00"), monotonicMs: 0 } });
    const feed = (...materials: DecodedMaterial[]) => materials.reduce((state, material) => tsunami(state, material).state, initialUnits["U-T"]);
    // 通知の印は着いた順の記録なので比べない（版が変われば fragments は新しい版の 1 件から始める、P3-NL-AC03 (2)）。
    const strip = (state: TsunamiUnitState) => state.observations.map(({ source: _source, notice: _notice, ...rest }) => ({ ...rest,
      stations: rest.stations.map((item) => ({ ...item, revision: null })).sort((left, right) => left.code.localeCompare(right.code)) }));
    const between = (state: TsunamiUnitState) => outcome(tsunami(state, fixture("synthetic_VTSE51_fragmentA", "VTSE51",
      (xml) => sentLater(5)(xml.replace("<Serial>4</Serial>", "<Serial>5</Serial>")))).decisions[0]);
    // Control/DateTime の違う同じ報の fragment A（06:02:00）と B（06:02:10）は両順で同じ記録になり、比べる用の時刻は大きい方。
    const a = fixture("synthetic_VTSE51_fragmentA", "VTSE51"), b = fixture("synthetic_VTSE51_fragmentB", "VTSE51", sentLater(10));
    const ab = feed(a, b), ba = feed(b, a);
    expect(strip(ab)).toEqual(strip(ba));
    expect(ab.observations[0].controlDateTimeRaw).toBe(b.controlDateTimeRaw);
    // A と B の間の時刻（06:02:05）の別の報（Serial 5）は両順とも older。
    expect([between(ab), between(ba)]).toEqual(["stale", "stale"]);
    // 本文が同じで Control/DateTime だけが違う fragment: 後着は通知 0 で比べる用の時刻だけを進め、保存→復元の後も間の報は older。
    const late = fixture("synthetic_VTSE51_fragmentA", "VTSE51", sentLater(10));
    const second = tsunami(feed(a), late);
    expect([second.intents, second.state.observations[0].controlDateTimeRaw]).toEqual([[], late.controlDateTimeRaw]);
    for (const state of [second.state, feed(late, a)]) {
      const decoded = tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as JsonValue);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      expect(between(decoded.state)).toBe("stale");
    }
    // 同じ時刻・同じ報番号で InfoType の違う訂正は同じ報にしない。後の送信なら新しい版で、推定区域は訂正の分で丸ごと置き換わる。
    const merged = feed(fixture("synthetic_VTSE52_fragmentA", "VTSE52"), fixture("synthetic_VTSE52_fragmentB", "VTSE52"));
    const correction = fixture("synthetic_VTSE52_correction", "VTSE52", sentLater(30));
    const corrected = tsunami(merged, correction);
    const parsed = tsunami(initialUnits["U-T"], correction).state.observations[0];
    expect([outcome(corrected.decisions[0]), corrected.state.observations[0].estimations]).toEqual(["changed", parsed.estimations]);
    // Q-VM-FRAGMENT: 気象庁のサンプルの VTSE51 の取消（同じ秒の同じ報の部分）は、もう一度受けても値の食い違いにならない。
    const cancelPart = fixture("38-39_03_03_210805_VTSE51", "VTSE51");
    const twice = tsunami(tsunami(initialUnits["U-T"], cancelPart).state, fixture("38-39_03_03_210805_VTSE51", "VTSE51"));
    expect([outcome(twice.decisions[0]), twice.diagnostics]).toEqual(["duplicate", []]);
  });

  // acceptance: 12 unit の新しい形の保存→復元（表で 1 本）。印を持つ unit（U-T・U-Q・U-N・U-V）は同じ時刻で中身の違う報で印を付けて往復する。
  // U-E は印を保存しない（Q-VM-PRECHECK-2A の (1)(c)）。controlDateTimeRaw の型の違う payload は invalid。
  it("P3-VM-T07 acceptance / AC01,AC08: every unit's new form round-trips with Control/DateTime and marks, and a mistyped one is invalid", () => {
    type Receive<S> = (state: S, input: { kind: "receive"; material: DecodedMaterial; clock: ClockReading }) => { state: S };
    const row = <S, P extends JsonValue>(reduce: Receive<S>, codec: UnitCodec<S, P>, start: S, fixtureId: string, headType: string,
      conflict?: (xml: string) => string) => () => {
      const material = fixture(fixtureId, headType);
      let state = reduce(start, { kind: "receive", material, clock: clockAt(material) }).state;
      if (conflict != null) state = reduce(state, { kind: "receive", material: fixture(fixtureId, headType, conflict), clock: clockAt(material) }).state;
      const json = JSON.stringify(codec.encode(state));
      const decoded = codec.decode(JSON.parse(json) as JsonValue);
      return { roundTrip: decoded.kind === "restored" && isDeepStrictEqual(JSON.parse(JSON.stringify(codec.encode(decoded.state))), JSON.parse(json)),
        control: json.includes(`"controlDateTimeRaw":${JSON.stringify(material.controlDateTimeRaw)}`), marked: /"unconfirmed":\[?\{/.test(json),
        mistyped: codec.decode(JSON.parse(json.replace(/"controlDateTimeRaw":"[^"]*"/, '"controlDateTimeRaw":0')) as JsonValue).kind };
    };
    const headline = (xml: string) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し");
    // 発注 2b: 同じ時刻の訂正（InfoType が違う同じ版）で 7 unit に印を付ける。
    const corrected = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>");
    const rows = {
      "U-E": row(reduceEewUnit, eewUnitCodec, initialUnits["U-E"], "77_01_01_240613_VXSE45", "VXSE45"),
      "U-W": row(reduceWeatherCurrentUnit, weatherCurrentUnitCodec, initialUnits["U-W"], "15_16_02_251222_VPWW57", "VPWW57", corrected),
      "U-F": row(reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec, initialUnits["U-F"], "81_01_01_260129_VPWP50", "VPWP50", corrected),
      "U-T": row(reduceTsunamiUnit, tsunamiUnitCodec, initialUnits["U-T"], "32-39_11_02_250206_VTSE41", "VTSE41", bodyName("別の区域")),
      "U-Q": row(reduceSeismicUnit, seismicUnitCodec, initialUnits["U-Q"], "32-35_04_04_240613_VXSE53", "VXSE53", bodyName("別の震央")),
      "U-N": row(reduceNankaiUnit, nankaiUnitCodec, initialUnits["U-N"], "selected_xml__74_01_05_200512_VYSE50", "VYSE50", headline),
      "U-V": row(reduceVolcanoUnit, volcanoUnitCodec, initialUnits["U-V"], "45_01_01_200522_VFVO50", "VFVO50", headline),
      "U-L": row(reduceLandslideUnit, landslideUnitCodec, initialUnits["U-L"], "15_16_01_241031_VPWW56", "VPWW56", corrected),
      "U-R": row(reduceFloodUnit, floodUnitCodec, initialUnits["U-R"], "16_01_01_220728_VXKO50", "VXKO50", corrected),
      "U-B": row(reduceBriefingUnit, briefingUnitCodec, initialUnits["U-B"], "82_01_01_260324_VPBS50", "VPBS50", corrected),
      "U-M": row(reduceLocalBulletinsUnit, localBulletinsUnitCodec, initialUnits["U-M"], "19_01_01_091210_VPHW50", "VPHW50", corrected),
      "U-Y": row(reduceTyphoonUnit, typhoonUnitCodec, initialUnits["U-Y"], "10_04_03_170913_VPTW60", "VPTW60", corrected),
    };
    const marked = new Set(["U-T", "U-Q", "U-N", "U-V", "U-W", "U-F", "U-L", "U-R", "U-B", "U-M", "U-Y"]);
    expect(Object.fromEntries(Object.entries(rows).map(([unit, run]) => [unit, run()]))).toEqual(Object.fromEntries(Object.keys(rows)
      .map((unit) => [unit, { roundTrip: true, control: true, marked: marked.has(unit), mistyped: "invalid" }])));
  });
});
