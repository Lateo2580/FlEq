import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { PENDING_MARK_BYTES } from "../../src/units/expiry";
import { reduceTsunamiUnit, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import * as T from "../tsunami-unit/tsunami-fixture";

// P3-EF-T09（P3-EF-AC04・AC06・AC10 (5)、D2）: 内容の実測 byte で器いっぱいまで受け入れる U-T と U-F は、印の無い見える記録ごとに期限切れの
// 保留の印の 21 byte を受理と復元の境界で予約する。境界いっぱいの状態から、受信なしで保留・記憶へ移っても保存と復元ができる。

const HOUR = 3_600_000;
const clock = (wallTimeMs: number) => ({ wallTimeMs, monotonicMs: 0 });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
// 器の計量（codec の generationBytes・measure と同じ式を外から数える）: envelope＋generation と capturedAt の 62 byte＋inputBoundary と losses の最大
// ＋pending の配送の予約＋印の無い見える記録ごとの 21 byte。
const envelopeOf = (unit: "U-T" | "U-F", schemaVersion: string, payload: JsonValue) => serializedEnvelope({ schemaVersion, unit, generation: 0,
  capturedAt: 0, payload, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES;
const tsunamiSize = (state: TsunamiUnitState) => envelopeOf("U-T", state.schemaVersion, json(tsunamiUnitCodec.encode(state)))
  + state.intents.reduce((sum, item) => sum + deliveryGrowth(item), 0)
  + PENDING_MARK_BYTES * state.observations.filter((item) => item.effective === "active" && item.expiryPending !== true).length;
// U-F の encode は器を越える状態で throw するので、保存の形（encode が返すのと同じ 4 項目）を直接作って数える。
const timeseriesPayload = (state: WeatherTimeseriesUnitState) => json({ schemaVersion: state.schemaVersion, subjects: state.subjects,
  gates: state.gates, intents: state.intents });
const timeseriesSize = (state: WeatherTimeseriesUnitState) => envelopeOf("U-F", state.schemaVersion, timeseriesPayload(state))
  + state.intents.reduce((sum, item) => sum + (item.disposition === "pending" ? deliveryGrowth(item) : 0), 0)
  + PENDING_MARK_BYTES * state.subjects.filter((item) => item.effective === "active" && item.expiryPending !== true).length;

// 予報の最初の区域名を伸ばして、計量をちょうど target にする。
function padTsunami(state: TsunamiUnitState, target: number): TsunamiUnitState {
  const [forecast, ...rest] = state.forecasts, [area, ...areas] = forecast.areas;
  const next = { ...state, forecasts: [{ ...forecast, areas: [{ ...area, name: area.name + "x".repeat(target - tsunamiSize(state)) }, ...areas] }, ...rest] };
  expect(tsunamiSize(next)).toBe(target);
  return next;
}
// 最初の subject の最後の文字列を伸ばして、計量をちょうど target にする。
function padTimeseries(state: WeatherTimeseriesUnitState, target: number, at = 0): WeatherTimeseriesUnitState {
  const subjects = state.subjects.map((item, index) => index !== at ? item : { ...item, strings: [...item.strings.slice(0, -1),
    item.strings.at(-1)! + "x".repeat(target - timeseriesSize(state))] });
  const next = { ...state, subjects };
  expect(timeseriesSize(next)).toBe(target);
  return next;
}
const roundTrips = <S, P>(codec: Readonly<{ encode: (state: S) => P; decode: (payload: JsonValue) => Readonly<{ kind: string }> }>, state: S) =>
  codec.decode(json(codec.encode(state))).kind;

describe("P3-EF-T09 contractBoundary / AC04,AC06,AC10: the 21-byte reserve at the U-T and U-F boundaries", () => {
  it("U-T: at 4,698,345 bytes the observation goes pending and expired without a receive, saves and restores; one eviction frees its reserve", () => {
    const LIMIT = tsunamiUnitCodec.maxEnvelopeBytes!;
    expect(LIMIT).toBe(4_698_345);
    const forecastAt = Date.parse("2011-03-11T14:49:00+09:00"), observedAt = Date.parse("2011-03-11T15:01:00+09:00");
    const forecast = reduceTsunamiUnit(initialUnits["U-T"], { kind: "receive", clock: clock(forecastAt + 1),
      material: T.decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41") }).state;
    const both = reduceTsunamiUnit(forecast, { kind: "receive", clock: clock(observedAt), material: T.decodeFixture("32-39_11_10_250206_VTSE51", "VTSE51") }).state;
    const full = padTsunami(both, LIMIT);
    expect(roundTrips(tsunamiUnitCodec, full)).toBe("restored");
    // 受信なしで期限を進める: unverified で保留、verified で expired。どちらも保存と復元ができる。
    const until = full.observations[0].validUntil!;
    const pending = reduceTsunamiUnit(full, { kind: "deadline", clock: clock(until), basis: "unverified" }).state;
    const expired = reduceTsunamiUnit(pending, { kind: "deadline", clock: clock(until + 1), basis: "verified" }).state;
    expect([pending.observations[0].expiryPending, tsunamiSize(pending), roundTrips(tsunamiUnitCodec, pending),
      expired.observations[0].effective, roundTrips(tsunamiUnitCodec, expired)]).toEqual([true, LIMIT, "restored", "expired", "restored"]);
    // 予約が無ければ: 実 byte が器ちょうどの状態（予約込みでは 21 byte 超え）は decode が断り、保留の印を付けると実 byte が器を越える。
    const unreserved = padTsunami(both, LIMIT + PENDING_MARK_BYTES);
    const marked = reduceTsunamiUnit(unreserved, { kind: "deadline", clock: clock(until), basis: "unverified" }).state;
    expect([roundTrips(tsunamiUnitCodec, unreserved), tsunamiSize(marked) - LIMIT]).toEqual(["invalid", PENDING_MARK_BYTES]);
    // 境界いっぱいの状態への受信は今どおり受理の境界（fit）で拒否（normal の見える記録は退去しない）。
    const crowded = reduceTsunamiUnit(full, { kind: "receive", clock: clock(observedAt + 60_000),
      material: T.decodeXml(T.observation({ eventId: "20110311144641", at: "2011-03-11T15:02:00+09:00", serial: 1, stations: [{ code: "1", height: "1.0" }] }), "VTSE51") });
    expect(crowded.decisions[0].decision).toBe("capacityExceeded");
    // 退去の境界（ヘルツ r2 の 2）: 訓練の観測 1 件の実 byte と予約の 21 byte を差し引けばちょうど収まる状態に、新しい観測を受ける。
    const training = reduceTsunamiUnit(forecast, { kind: "receive", clock: clock(observedAt),
      material: T.decodeXml(T.observation({ eventId: "20110311144642", at: "2011-03-11T15:01:00+09:00", serial: 1, operation: "training",
        stations: [{ code: "2", height: "0.5" }] }), "VTSE51") }).state;
    const evictable = training.observations[0];
    const incoming = T.decodeXml(T.observation({ eventId: "20110311144643", at: "2011-03-11T15:02:00+09:00", serial: 1,
      stations: [{ code: "3", height: "0.6" }] }), "VTSE51");
    const grow = tsunamiSize(reduceTsunamiUnit(training, { kind: "receive", clock: clock(observedAt + 60_000), material: incoming }).state) - tsunamiSize(training);
    const released = Buffer.byteLength(JSON.stringify(evictable)) + 1 + PENDING_MARK_BYTES;
    const edge = padTsunami(training, LIMIT - grow + released);
    const step = reduceTsunamiUnit(edge, { kind: "receive", clock: clock(observedAt + 60_000), material: incoming });
    expect([step.decisions[0].decision, step.diagnostics.filter((item) => item.reason === "tsunamiCapacityEvicted").map((item) => item.count),
      step.state.observations.map((item) => item.subject), tsunamiSize(step.state)]).toEqual(["changed", [1],
      ["normal/tsunamiObservation:VTSE51/20110311144643"], LIMIT]);
  });

  it("U-F: at 33,565,184 bytes the subjects go pending and lapse without a receive, save and restore; one eviction is enough", () => {
    const LIMIT = weatherTimeseriesUnitCodec.maxEnvelopeBytes!;
    expect(LIMIT).toBe(33_565_184);
    const xml = T.fixtureXml("81_02_01_260605_VPWP50_high_severity");
    const report = Date.parse("2026-06-05T17:00:00+09:00");
    const receive = (state: WeatherTimeseriesUnitState, body: string, at: number, inputId: string) => reduceWeatherTimeseriesUnit(state,
      { kind: "receive", clock: clock(at), material: T.decodeXml(body, "VPWP50", inputId) });
    const seeded = receive(initialUnits["U-F"], xml, report, "uf-normal").state;
    const full = padTimeseries(seeded, LIMIT);
    expect([full.subjects[0].effective, roundTrips(weatherTimeseriesUnitCodec, full)]).toEqual(["active", "restored"]);
    const until = full.subjects[0].validUntil!;
    const pending = reduceWeatherTimeseriesUnit(full, { kind: "deadline", clock: clock(until), basis: "unverified" }).state;
    const lapsed = reduceWeatherTimeseriesUnit(pending, { kind: "deadline", clock: clock(until + 1), basis: "verified" }).state;
    expect([pending.subjects[0].expiryPending, timeseriesSize(pending), roundTrips(weatherTimeseriesUnitCodec, pending),
      [lapsed.subjects[0].effective, lapsed.subjects[0].lapsed], roundTrips(weatherTimeseriesUnitCodec, lapsed)])
      .toEqual([true, LIMIT, "restored", ["noActiveItems", true], "restored"]);
    // 予約が無ければ: 実 byte が器ちょうどの状態は decode が断り、保留の印を付けると実 byte が器を越える。
    const unreserved = padTimeseries(seeded, LIMIT + PENDING_MARK_BYTES);
    const marked = reduceWeatherTimeseriesUnit(unreserved, { kind: "deadline", clock: clock(until), basis: "unverified" }).state;
    expect([weatherTimeseriesUnitCodec.decode(timeseriesPayload(unreserved)).kind, timeseriesSize(marked) - LIMIT]).toEqual(["invalid", PENDING_MARK_BYTES]);
    // 境界いっぱいの状態への別の官署の受信は今どおり容量超過で断る（normal の subject は退去しない）。
    const other = xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, "<EditorialOffice>新潟地方気象台</EditorialOffice>");
    const crowded = receive(full, other, report + 60_000, "uf-other");
    expect([crowded.decisions[0].decision, crowded.state]).toEqual(["capacityExceeded", full]);
    // 退去の境界: 訓練の subject 1 件の退去（数え直しで予約も外れる）でちょうど収まる状態に、別の官署の報を受ける。
    const training = receive(seeded, xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), report, "uf-training").state;
    const grow = timeseriesSize(receive(training, other, report + 60_000, "uf-grow").state) - timeseriesSize(training);
    const trainingSubject = training.subjects.find((item) => item.operation === "training")!;
    const trainingGate = training.gates.find((item) => item.subject === trainingSubject.subject)!;
    const released = Buffer.byteLength(JSON.stringify(trainingSubject)) + 1 + PENDING_MARK_BYTES + Buffer.byteLength(JSON.stringify(trainingGate)) + 1;
    const edge = padTimeseries(training, LIMIT - grow + released, training.subjects.indexOf(training.subjects.find((item) => item.operation === "normal")!));
    const step = receive(edge, other, report + 60_000, "uf-edge");
    expect([step.decisions[0].decision, step.decisions[0].decision === "changed" && step.decisions[0].currentEstablished != null,
      step.state.subjects.map((item) => [item.operation, item.effective]), timeseriesSize(step.state)]).toEqual(["changed", true,
      [["normal", "active"], ["normal", "active"]], LIMIT]);
  });
});
