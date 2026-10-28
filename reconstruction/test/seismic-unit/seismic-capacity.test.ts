import { describe, expect, it } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { EarthquakeEvent, LongPeriodSubject, SeismicUnitState, SeismicUnitStep } from "../../contracts/p3-seismic-unit.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, lossReasons, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { FAILURE_MARKS_MAX_BYTES, noticeMarkBytes } from "../../src/units/notice-mark";
import { unreadableMarkBytes } from "../../src/units/unreadable";
import { longestMarks } from "../unreadable-mark/longest-mark";
import { reduceSeismicUnit, seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { shiftTimestamps } from "../eew-e01/frames.mjs";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, sentLater, vxse53 } from "./seismic-fixture";

// P3-UNIT-Q-CAPACITY-001（K11）: 守る線・退去と畳みの順・N_guard・H08・H18・H23・§13 の 4 か所・v5 の保存。

const HOUR = 3_600_000, MINUTE = 60_000;
const L = seismicUnitCodec.maxEnvelopeBytes!;
const P75 = (name: string) => `telegram-foundation/phase7_5_${name}`;
const W4 = "32-35_04_04_240613_VXSE53", S5 = "32-35_01_03_240613_VXSE53", S7 = P75("VXSE53_20260728162718_99e82c812e72");
const BIG51 = P75("VXSE51_20260728162718_059a2b392646"), BIG53 = P75("VXSE53_20260728162718_bf35e8ea1825");
const BIG61 = P75("VXSE61_20260728162718_d7e630bbb653"), BIG62 = P75("VXSE62_20260728162718_f9786edc27df");
const iso = (ms: number) => new Date(ms + 9 * HOUR).toISOString().replace(".000Z", "+09:00");
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const pending = (state: SeismicUnitState) => state.intents.filter((item) => item.disposition === "pending");
const decision = (step: SeismicUnitStep) => step.decisions[0];
const reasons = (step: SeismicUnitStep) => step.diagnostics.map((item) => item.reason);
const eventOf = (state: SeismicUnitState, eventId: string, operation: Operation = "normal") =>
  state.earthquakes.find((item) => item.eventId === eventId && item.operation === operation);
const longOf = (state: SeismicUnitState, eventId: string) => state.longPeriods.find((item) => item.eventId === eventId);
const roundTrip = (state: SeismicUnitState) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as JsonValue);
const at = (material: DecodedMaterial) => clock(Date.parse(material.reportDateTimeRaw));
const step = (state: SeismicUnitState, material: DecodedMaterial, basis: WallBasis = "verified", now = at(material)) =>
  reduceSeismicUnit(state, { kind: "receive", material, clock: now, basis });

// seismic-unit.ts の世代の数え方（envelope・inputBoundary と losses の最大・世代の桁の 62・pending の配送の予約）。
function generation(state: SeismicUnitState): number {
  return serializedEnvelope({ schemaVersion: "p3-seismic-unit-v7", unit: "U-Q", generation: 0, capturedAt: 0,
    payload: seismicUnitCodec.encode(state) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES
    + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES + pending(state).reduce((sum, item) => sum + deliveryGrowth(item), 0);
}
// fixture の報の全時刻を atMs へ平行移動し、EventID を替え、運用を通常にする（送信の時刻 Control/DateTime も同じだけ動く）。
function report(file: string, atMs: number, eventId: string, transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
  const xml = fixtureXml(file);
  const delta = atMs - Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(xml)![1]);
  return decodeFixture(file, () => transform(shiftTimestamps(xml, delta).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
    .replace(/<Status>[^<]*<\/Status>/, "<Status>通常</Status>")));
}
function feed(state: SeismicUnitState, ...materials: readonly DecodedMaterial[]): SeismicUnitState {
  return materials.reduce((current, material) => receive(current, material, at(material)).state, state);
}
// 畳めない事実の byte（観測点でない市町村を足す）。XML の文字の上限（16,384）の内の名前 1,000 文字の市町村を、bytes の分だけ最初の
// Intensity の Area に足す。
function cities(bytes: number): string {
  return Array.from({ length: Math.ceil(bytes / 1_130) }, (_, index) =>
    `<City><Name>${"x".repeat(1_000)}</Name><Code>98${String(index).padStart(5, "0")}</Code><MaxInt>1</MaxInt></City>`).join("");
}
// 名前 16,000 文字の「\」の市町村（JSON で 1 文字 2 byte）を、名前の文字数が count に届くまで並べる。
function escapedCities(count: number): string {
  return Array.from({ length: Math.ceil(count / 16_000) }, (_, index) =>
    `<City><Name>${"\\".repeat(16_000)}</Name><Code>97${String(index).padStart(5, "0")}</Code><MaxInt>1</MaxInt></City>`).join("");
}
const widened = (bytes: number, make: (bytes: number) => string = cities) => (xml: string) => {
  const at = xml.indexOf("</Area>", xml.indexOf("<Intensity>"));
  return bytes === 0 ? xml : `${xml.slice(0, at)}${make(bytes)}${xml.slice(at)}`;
};
// 最初の観測点の震度を 1 つ替える（観測点の列の指紋が変わる）。
const station = (xml: string) => xml.replace(/(<IntensityStation>[\s\S]*?<Int>)([^<]*)(<\/Int>)/, (_, head: string, value: string, tail: string) =>
  `${head}${value === "1" ? "2" : "1"}${tail}`);
const normal = (xml: string) => xml.replace(/<Status>[^<]*<\/Status>/, "<Status>通常</Status>");
const cancelOf = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
  .replace(/<Body([^>]*)>[\s\S]*<\/Body>/, "<Body$1><Text>取消</Text></Body>");
const CITY = "<City><Name>合成市</Name><Code>9900100</Code><MaxInt>5-</MaxInt>"
  + ["9900101", "9900102", "9900103"].map((code) => `<IntensityStation><Name>観測点${code}</Name><Code>${code}</Code><Int>5-</Int></IntensityStation>`).join("")
  + "</City>";
// 合成の VXSE53（観測点 3 つ）。big は畳めない事実の byte。
const quake = (eventId: string, atMs: number, options: Readonly<{ maxInt?: string; originMs?: number; big?: number; operation?: "通常" | "訓練" }> = {}) =>
  decodeXml(widened(options.big ?? 0)(vxse53({ eventId, at: iso(atMs), origin: iso(options.originMs ?? atMs), maxInt: options.maxInt ?? "5-",
    city: CITY, operation: options.operation })), "VXSE53");

// 退去も畳みもできない詰め物: 観測点の無い守る地震（from が最も新しいので第 6 段でも消えない）。length は見出しの byte。
function pad(length: number, atMs: number): EarthquakeEvent {
  const source = { inputId: "pad", origin: "replay" as const, operation: "normal" as const, family: "VXSE52", subject: "normal/VXSE52/PAD",
    reportDateTimeRaw: iso(atMs), controlDateTimeRaw: iso(atMs), serialRaw: "1", infoTypeRaw: "発表" };
  return { eventId: "PAD", operation: "normal", retainUntil: atMs + 24 * HOUR, strongHold: null, guard: { from: atMs, on: 1 },
    contributions: [{ family: "VXSE52", source, effective: "active", targetDateTimeRaw: null, title: "pad", headline: "x".repeat(length),
      hypocenter: null, intensity: null, tsunamiComment: null }] };
}
// 受けた後の採用の案がちょうど L＋deficit byte になるよう詰め物を足してから受ける（受信の前の state は器の内）。案の byte は詰め物の
// 無い state で受けた結果の世代に、詰め物の byte を足した値（詰め物は案の中で変わらない）。
function pressed(state: SeismicUnitState, target: DecodedMaterial, deficit: number, padAt: number, basis: WallBasis = "verified") {
  const roomy = step({ ...state, earthquakes: [...state.earthquakes, pad(0, padAt)] }, target, basis);
  expect(reasons(roomy).filter((reason) => reason.startsWith("seismic") || reason === "capacityRejected")).toEqual([]);
  const before: SeismicUnitState = { ...state, earthquakes: [...state.earthquakes, pad(L + deficit - generation(roomy.state), padAt)] };
  expect(generation(before)).toBeLessThanOrEqual(L);
  const result = step(before, target, basis);
  return { roomy: roomy.state, before, step: result };
}
// 畳んだ形（観測点の要素を外して指紋を足す）の byte。畳みで減る byte と、畳んだ記録を退去して減る byte を数える。
function foldedForm(record: EarthquakeEvent | LongPeriodSubject): unknown {
  const items = (value: EarthquakeEvent["contributions"][number]["intensity"]) => value == null ? value
    : { ...value, items: value.items.filter((item) => item.level !== "station") };
  const has = (value: EarthquakeEvent["contributions"][number]["intensity"]) => value?.items.some((item) => item.level === "station") === true;
  if ("contributions" in record) return { ...record, contributions: record.contributions.map((item) => has(item.intensity)
    ? { ...item, intensity: items(item.intensity), folded: "0".repeat(16) } : item) };
  return has(record.intensity) ? { ...record, intensity: items(record.intensity), folded: "0".repeat(16) } : record;
}
const foldSave = (record: EarthquakeEvent | LongPeriodSubject) => sizeOf(record) - sizeOf(foldedForm(record));
const evictSave = (record: EarthquakeEvent | LongPeriodSubject) => sizeOf(foldedForm(record)) + 1;
const isFolded = (record: EarthquakeEvent | LongPeriodSubject | undefined) => record != null
  && ("contributions" in record ? record.contributions.some((item) => item.folded != null) : record.folded != null);

// T01 の地震の器: 守らない長周期 L1（最古）・守らない event W1・W2（震度 4）・守る event S1（5-）と S1 の長周期（階級は 4 だが on を 0 にし、
// S1 の on で守る）・守る event S2・取消記憶 M。from は S1 → S2 → 受ける X の順に新しい。
const T = Date.parse("2026-08-01T00:00:00+09:00");
const ID = { L1: "20260801000001", W1: "20260801000101", W2: "20260801000102", S1: "20260801000201", S2: "20260801000202", M: "20260801000301",
  X: "20260801000401" } as const;
function quakeWorld(): SeismicUnitState {
  const state = feed(emptyState(), report(BIG62, T, ID.L1), report(W4, T + 10 * MINUTE, ID.W1), report(W4, T + 20 * MINUTE, ID.W2),
    report(S5, T + 30 * MINUTE, ID.S1), report(BIG62, T + 31 * MINUTE, ID.S1), report(S5, T + 40 * MINUTE, ID.S2),
    decodeXml(vxse53({ eventId: ID.M, at: iso(T + 45 * MINUTE), maxInt: "3" }), "VXSE53"),
    decodeXml(vxse53({ eventId: ID.M, at: iso(T + 50 * MINUTE), infoType: "取消" }), "VXSE53"));
  return { ...state, longPeriods: state.longPeriods.map((item) => ({ ...item, guard: { from: item.guard!.from, on: 0 as const } })) };
}
const PAD_AT = T + 5 * HOUR;

describe("P3-UNIT-Q-CAPACITY-001 U-Q capacity", () => {
  it("P3-QC-T01 acceptance / P3-QC-AC01・AC02・AC03: fold the unguarded, evict the unguarded, fold the guarded, evict the oldest guarded quake", () => {
    const world = quakeWorld();
    const x = quake(ID.X, T + 60 * MINUTE, { originMs: T + 55 * MINUTE, big: 400_000 });
    const probe = pressed(world, x, 1, PAD_AT).roomy;
    const record = (id: string) => eventOf(probe, id)!;
    const l1 = longOf(probe, ID.L1)!, s1Long = longOf(probe, ID.S1)!;
    expect([s1Long.guard?.from, l1.guard?.on, record(ID.S1).guard?.on, record(ID.W1).guard?.on, record(ID.X).guard?.on])
      .toEqual([record(ID.S1).guard?.from, 0, 1, 0, 1]);
    const third = foldSave(l1) + foldSave(record(ID.W1)) + foldSave(record(ID.W2));
    const fourth = evictSave(l1) + evictSave(record(ID.W1)) + evictSave(record(ID.W2));
    const fifth = foldSave(record(ID.S1)) + foldSave(s1Long) + foldSave(record(ID.S2)) + foldSave(record(ID.X));
    const sixth = evictSave(record(ID.S1)) + evictSave(s1Long) + evictSave(record(ID.S2));
    const shape = (state: SeismicUnitState) => Object.fromEntries([["L1", longOf(state, ID.L1)], ["W1", eventOf(state, ID.W1)],
      ["W2", eventOf(state, ID.W2)], ["S1", eventOf(state, ID.S1)], ["S1long", longOf(state, ID.S1)], ["S2", eventOf(state, ID.S2)],
      ["X", eventOf(state, ID.X)], ["M", eventOf(state, ID.M)]].map(([key, value]) => [key, value == null ? "gone"
        : isFolded(value as EarthquakeEvent) ? "folded" : "kept"]));
    // (3) 守らない記録の観測点を古い順に畳む（長周期の畳みは表示の変化に出て、通知は作らない）。
    const first = pressed(world, x, 1, PAD_AT).step;
    expect(shape(first.state)).toEqual({ L1: "folded", W1: "kept", W2: "kept", S1: "kept", S1long: "kept", S2: "kept", X: "kept", M: "kept" });
    expect(first.diagnostics).toContainEqual({ level: "INFO", component: "seismic", reason: "seismicStationsFolded", unit: "U-Q", count: 1 });
    expect(first.displayChanges.map((item) => item.subject).sort()).toEqual([`normal/VXSE62/${ID.L1}`, `normal/earthquake/${ID.X}`]);
    expect(first.displayChanges.find((item) => item.subject === `normal/VXSE62/${ID.L1}`)?.after?.current).toMatchObject({ folded: expect.any(String) });
    expect(new Set(first.intents.map((item) => item.subject))).toEqual(new Set([`normal/VXSE53/${ID.X}`]));
    // (4) 次に守らない記録を古い順に退去する。event の畳みは表示の変化にしない。
    const second = pressed(world, x, third + 1, PAD_AT).step;
    expect(shape(second.state)).toEqual({ L1: "gone", W1: "folded", W2: "folded", S1: "kept", S1long: "kept", S2: "kept", X: "kept", M: "kept" });
    expect(second.displayChanges.map((item) => item.subject).sort()).toEqual([`normal/VXSE62/${ID.L1}`, `normal/earthquake/${ID.X}`]);
    // (5) 守る記録の観測点を古い順に畳む。
    expect(shape(pressed(world, x, third + fourth + 1, PAD_AT).step.state))
      .toEqual({ L1: "gone", W1: "gone", W2: "gone", S1: "folded", S1long: "kept", S2: "kept", X: "kept", M: "kept" });
    // (6) from の最も古い守る地震（S1 の event と長周期）をまとめて退去し、守る報は入る。取消記憶は byte の超過で残る（r3 の 3 記録の例）。
    const sixthStep = pressed(world, x, third + fourth + fifth + 1, PAD_AT).step;
    expect(shape(sixthStep.state)).toEqual({ L1: "gone", W1: "gone", W2: "gone", S1: "gone", S1long: "gone", S2: "folded", X: "folded", M: "kept" });
    expect(sixthStep.diagnostics).toContainEqual({ level: "INFO", component: "seismic", reason: "seismicCapacityEvicted", unit: "U-Q", count: 5 });
    expect(roundTrip(sixthStep.state).kind).toBe("restored");
    // (7) 第 6 段で退去できる守る地震を全部当てても越えれば、畳み・退去の案を確定せずに断る。
    const refused = pressed(world, x, third + fourth + fifth + sixth + 1, PAD_AT);
    expect([decision(refused.step).decision, refused.step.state.earthquakes, refused.step.state.longPeriods])
      .toEqual(["capacityExceeded", refused.before.earthquakes, refused.before.longPeriods]);

    // 古い守る地震の遅い報（r7）: S1 の新しい版はより新しい守る地震（S2）を消さずに断る（印は P3-CC-AC10 のとおり置く）。
    const late = report(S5, T + 61 * MINUTE, ID.S1, widened(400_000));
    const lateProbe = pressed(world, late, 1, PAD_AT).roomy;
    const lateDeficit = third + fourth + foldSave(longOf(lateProbe, ID.S1)!) + foldSave(eventOf(lateProbe, ID.S2)!)
      + foldSave(eventOf(lateProbe, ID.S1)!) + 1;
    const lateStep = pressed(world, late, lateDeficit, PAD_AT).step;
    expect(reasons(lateStep)).toEqual(["capacityRejected"]);
    expect(eventOf(lateStep.state, ID.S1)?.unavailable).toMatchObject([{ reason: "capacityExceeded" }]);
    expect([isFolded(eventOf(lateStep.state, ID.S2)), longOf(lateStep.state, ID.S1) != null]).toEqual([false, true]);
    // 守らない報は第 5 段までで足りなければ断る（P3-QC-D-SMALL-PUSH=B）。守る記録は消えず、畳みも確定しない。
    const small = quake("20260801000501", T + 60 * MINUTE, { maxInt: "3", big: 400_000 });
    const smallProbe = pressed(world, small, 1, PAD_AT).roomy;
    const smallDeficit = third + foldSave(eventOf(smallProbe, "20260801000501")!) + fourth + fifth - foldSave(record(ID.X)) + 1;
    const pushed = pressed(world, small, smallDeficit, PAD_AT);
    expect([decision(pushed.step).decision, pushed.step.state.earthquakes]).toEqual(["capacityExceeded", pushed.before.earthquakes]);
    // training の受理は normal を畳まない。
    const training = pressed(world, quake("20260801000601", T + 60 * MINUTE, { maxInt: "3", operation: "訓練" }), 1, PAD_AT);
    expect([decision(training.step).decision, training.step.state.longPeriods]).toEqual(["capacityExceeded", training.before.longPeriods]);
    // 1 件で器を越える報は何も畳まず退去せず断る（(0)(a)）。P3-UM-RES-09 で器が入力の上限（8 MiB）を越えたので、JSON で 2 byte になる
    // 「\」の名前の市町村で記録を器より大きくする。
    const huge = step(world, decodeXml(widened(L / 2 + 16_000, escapedCities)(vxse53({ eventId: "20260801000701", at: iso(T + 60 * MINUTE),
      origin: iso(T + 60 * MINUTE), maxInt: "5-", city: CITY })), "VXSE53"));
    expect([decision(huge).decision, reasons(huge), huge.state.longPeriods]).toEqual(["capacityExceeded", ["capacityRejected"], world.longPeriods]);

    // 畳んだ寄与の比べ方（P3-QC-AC03 (3)）。詰め物を外して器に余りのある state で受ける。
    const relaxed: SeismicUnitState = { ...second.state, earthquakes: second.state.earthquakes.filter((item) => item.eventId !== "PAD") };
    const w1 = (transform: (xml: string) => string = (xml) => xml) => report(W4, T + 10 * MINUTE, ID.W1, transform);
    expect(decision(step(relaxed, w1()))).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    const conflict = step(relaxed, w1(station));
    expect([decision(conflict).decision, reasons(conflict)]).toEqual(["unchanged", ["seismicRevisionConflict"]]);
    // 同じ時刻の取消は指紋を比べずに勝つ。
    expect(eventOf(step(relaxed, w1(cancelOf)).state, ID.W1)?.contributions[0].effective).toBe("cancelled");
    // 新しい版: 観測点が畳む前と同じなら semantic にせず鳴らさない。同じ指紋の訂正は通知する。観測点が違えば semantic。
    const same = step(relaxed, w1(sentLater));
    expect([decision(same), same.intents]).toMatchObject([{ decision: "changed", change: "revisionOnly" }, []]);
    expect(eventOf(same.state, ID.W1)?.contributions[0]).not.toHaveProperty("folded");
    const corrected = step(relaxed, w1((xml) => sentLater(xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"))));
    expect(corrected.intents.map((item) => item.transition)).toEqual(["updated", "updated"]);
    expect(decision(step(relaxed, w1((xml) => sentLater(station(xml)))))).toMatchObject({ decision: "changed", change: "semantic" });
  });

  it("P3-QC-T01 acceptance / P3-QC-AC02 (0)(c): the guard is judged after the first stage, and a held clock keeps the overdue record guarding", () => {
    // A の長周期（発生時刻なし、20 時）が先に起点を決め、遅れて 0 時の A の event（5-、retainUntil は翌 0 時）が from を写す。翌 1 時の受信。
    const D0 = Date.parse("2026-08-02T00:00:00+09:00"), D = (hours: number) => D0 + hours * HOUR;
    const world = feed(emptyState(), report(BIG62, D(20), "A", (xml) => xml.replace(/<OriginTime>[^<]*<\/OriginTime>/, "")),
      report(S5, D(0), "A"), report(S5, D(22), "B"));
    const lp = longOf(world, "A")!;
    const own = { ...world, longPeriods: [{ ...lp, guard: { from: lp.guard!.from, on: 0 as const } }] };
    expect([lp.guard?.from, eventOf(own, "A")?.guard?.from, eventOf(own, "A")?.retainUntil]).toEqual([D(20), D(20), D(24)]);
    const x = quake(ID.X, D(25), { originMs: D(24.9), big: 400_000 });
    const overdue = sizeOf(eventOf(own, "A")) + 1;
    // 確かめた時計: 第 1 段で A の event が消え、守りを失った A の長周期が B より先に畳まれる。
    const verified = pressed(own, x, overdue + 1, D(30)).step;
    expect([eventOf(verified.state, "A") == null, isFolded(longOf(verified.state, "A")), isFolded(eventOf(verified.state, "B"))])
      .toEqual([true, true, false]);
    // K10 の保留（確かめていない時計）: 第 1 段は止まり、A の event は active のまま A の長周期を守る。守る記録として古い順に畳む。
    const held = pressed(own, x, overdue + 1, D(30), "unverified").step;
    expect([isFolded(eventOf(held.state, "A")), isFolded(eventOf(held.state, "B"))]).toEqual([true, true]);
  });

  // 実不具合の再発防止（K11 r2 の品質レビュー P2）: 配列の最後の記録を退去しても区切りのカンマは無いので、ちょうど L の世代は採り、L＋1 は断る
  // （L＋1 を採ると保存は通り、再起動で codec が拒んで前の世代に戻る）。
  it("P3-QC-T02 regression / P3-QC-AC02: evicting the last long period counts no separator, so L is taken and L + 1 refused", () => {
    const old = decodeFixture(BIG62, (xml) => xml.replace(/<IntensityStation\b[^>]*>[\s\S]*?<\/IntensityStation>/g, "")
      .replace(/<MaxLgInt>4<\/MaxLgInt>/g, "<MaxLgInt>1</MaxLgInt>"));
    const now = Date.parse(old.reportDateTimeRaw) + 1_000;
    // P3-UM-RES-09 で広げた器の分は、退去も畳みもできない詰め物で埋める（前の器のときと同じ余りで境界を見る。入力は 8 MiB まで）。
    const filled = feed(emptyState(), old);
    const base = { ...filled, earthquakes: [...filled.earthquakes, pad(L - 5_627_794, now)] };
    // 観測点を持たない大きな VXSE53（畳めない市町村の名前で byte を合わせる）。inputId は固定する（実行の順で桁が変わると byte がずれる）。
    const big = (bytes: number) => decodeXml(vxse53({ eventId: "NEW", at: iso(now), maxInt: "3", city: Array.from({ length: 500 }, (_, index) =>
      `<City><Name>${"x".repeat(Math.min(12_000, Math.max(0, bytes - index * 12_000)))}</Name><Code>${1_000_000 + index}</Code><MaxInt>3</MaxInt></City>`)
      .join("") }), "VXSE53", "target");
    const ideal = step(base, big(0), "verified", clock(now)).state;
    const room = L - generation({ ...ideal, longPeriods: [] });
    const exact = step(base, big(room), "verified", clock(now));
    expect([decision(exact).decision, exact.state.longPeriods, generation(exact.state), roundTrip(exact.state).kind]).toEqual(["changed", [], L, "restored"]);
    expect(decision(step(base, big(room + 1), "verified", clock(now))).decision).toBe("capacityExceeded");
  });

  it("P3-QC-T03 acceptance / P3-QC-AC06: the level formula of H08", () => {
    const level = (material: DecodedMaterial) => step(emptyState(), material).intents.map((item) => item.payload.level)[0];
    const lg = (value: string) => (xml: string) => xml.replace("</CodeDefine>", `</CodeDefine><MaxLgInt>${value}</MaxLgInt>`);
    const lgClass = (value: string) => decodeFixture("synthetic_phase4a_VXSE62_special", (xml) => xml.replace(
      '<MaxLgInt condition="未入電" description="最大長周期階級未入電"/>', `<MaxLgInt>${value}</MaxLgInt>`));
    const rows: [string, DecodedMaterial, string][] = [
      ["5-", decodeFixture(S5, normal), "critical"], ["7", decodeFixture(S7), "critical"], ["4", decodeFixture(W4), "warning"],
      ["3", decodeXml(vxse53({ at: "2099-01-01T09:00:00+09:00", maxInt: "3" }), "VXSE53"), "normal"],
      ["VXSE52", decodeFixture("32-35_04_03_240613_VXSE52"), "normal"], ["VXSE61", decodeFixture(BIG61), "normal"],
      ["unknown", decodeFixture("synthetic_VXSE53_intensity_unknown"), "info"],
      ["unknown and MaxLgInt 2", decodeFixture("synthetic_VXSE53_intensity_unknown", lg("2")), "critical"],
      ["4 and MaxLgInt 2", decodeFixture(W4, lg("2")), "critical"],
      ["5弱以上未入電", decodeFixture("synthetic_phase4a_VXSE51_special"), "critical"],
      ["class 4", decodeFixture(BIG62), "critical"], ["class 3", decodeFixture("selected_xml/78_01_01_240613_VXSE62"), "critical"],
      ["class 2", lgClass("2"), "critical"], ["class 1", lgClass("1"), "warning"],
    ];
    expect(rows.map(([label, material]) => [label, level(material)])).toEqual(rows.map(([label, , expected]) => [label, expected]));
    const cancelled = step(feed(emptyState(), decodeFixture(S7)), decodeFixture("synthetic_VXSE53_cancel"));
    expect(cancelled.intents.map((item) => [item.payload.level, item.priorityGroup])).toEqual([["cancel", "other"], ["cancel", "other"]]);
    expect(step(emptyState(), decodeFixture(S5, normal)).intents.map((item) => item.priorityGroup)).toEqual(["other", "other"]);
  });

  it("P3-QC-T06 contractBoundary / P3-QC-AC09: the four sites of §13 are received with a WARN", () => {
    const now = "2099-01-01T09:00:00+09:00";
    const accepted = (xml: string, headType = "VXSE53") => {
      const result = step(emptyState(), decodeXml(xml, headType));
      return [decision(result).decision, result.diagnostics.map((item) => [item.level, item.reason]), result.state] as const;
    };
    const contributionOf = (state: SeismicUnitState) => state.earthquakes[0].contributions[0];
    const [serialZero, serialWarn, serialState] = accepted(vxse53({ at: now }).replace("<Serial>1</Serial>", "<Serial>0</Serial>"));
    const [, longWarn, longState] = accepted(vxse53({ at: now }).replace("<Serial>1</Serial>", "<Serial>12345678901</Serial>"));
    expect([serialZero, serialWarn, contributionOf(serialState).source.serialRaw, longWarn, contributionOf(longState).source.serialRaw])
      .toEqual(["changed", [["WARN", "requiredStructureInvalid"]], "", [["WARN", "requiredStructureInvalid"]], ""]);
    const [observed, observedWarn, observedState] = accepted(vxse53({ at: now }).replace("<Observation>", "<Other>").replace("</Observation>", "</Other>"));
    expect([observed, observedWarn, contributionOf(observedState).intensity]).toEqual(["changed", [["WARN", "requiredStructureMissing"]], null]);
    const [bare, bareWarn, bareState] = accepted(vxse53({ at: now }).replace(/<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/, "")
      .replace(/<OriginTime>[^<]*<\/OriginTime>/, ""));
    expect([bare, bareWarn, contributionOf(bareState).hypocenter]).toMatchObject(["changed", [["WARN", "requiredStructureMissing"]],
      { originTimeRaw: null, magnitude: { kind: "missing" } }]);
    const [vxse52, vxse52Warn] = accepted(fixtureXml("32-35_04_03_240613_VXSE52").replace(/<OriginTime>[^<]*<\/OriginTime>/, ""), "VXSE52");
    expect([vxse52, vxse52Warn]).toEqual(["changed", [["WARN", "requiredStructureMissing"]]]);
    const [named, namedWarn, namedState] = accepted(fixtureXml(BIG51).replace("<Name>熊本県</Name>", ""), "VXSE51");
    expect([named, namedWarn, contributionOf(namedState).intensity?.items.find((item) => item.code === "43")?.name])
      .toEqual(["changed", [["WARN", "requiredStructureMissing"]], ""]);
  });

  it("P3-QC-T09 acceptance / P3-QC-AC01: the guard bits, the shared origin, release and re-establishment", () => {
    const at0 = Date.parse("2009-10-01T13:50:00+09:00"), origin = Date.parse("2009-10-01T13:45:00+09:00");
    const lg2 = (xml: string) => xml.replace(/(<\/CodeDefine>\s*<MaxInt>[^<]*<\/MaxInt>)/, "$1<MaxLgInt>2</MaxLgInt>");
    const guardOf = (state: SeismicUnitState) => eventOf(state, "20091001134500")?.guard;
    const restored = (state: SeismicUnitState) => { const back = roundTrip(state); return back.kind === "restored" ? back.state : null; };
    // 5- で全体 MaxLgInt 2 の報で bit 1・2 が立ち、from は発生時刻。
    const both = feed(emptyState(), decodeFixture(S5, (xml) => lg2(normal(xml))));
    expect(guardOf(both)).toEqual({ from: origin, on: 3 });
    const later = (minutes: number, transform: (xml: string) => string) => decodeFixture(S5, (xml) => transform(normal(xml).replace(/2009-10-01T13:50:00\+09:00/g,
      iso(at0 + minutes * MINUTE))));
    const maxInt = (value: string) => (xml: string) => xml.replace(/(<\/CodeDefine>\s*<MaxInt>)[^<]*(<\/MaxInt>)/, `$1${value}$2`);
    // unknown の続報では外れない。全体 MaxInt が既知の 3 に下がると bit 1 だけ外れ、もう片方も既知の 1 で解除される。
    const unknown = feed(both, later(5, (xml) => maxInt("不明")(xml).replace(/(<\/CodeDefine>\s*<MaxInt>[^<]*<\/MaxInt>)/, "$1<MaxLgInt>不明</MaxLgInt>")));
    const three = feed(unknown, later(10, (xml) => lg2(maxInt("3")(xml))));
    const released = feed(three, later(15, (xml) => maxInt("3")(xml).replace(/(<\/CodeDefine>\s*<MaxInt>[^<]*<\/MaxInt>)/, "$1<MaxLgInt>1</MaxLgInt>")));
    const again = feed(released, later(20, maxInt("5-")));
    expect([unknown, three, released, again].map((state) => [guardOf(state), guardOf(restored(state)!)]))
      .toEqual([[{ from: origin, on: 3 }, { from: origin, on: 3 }], [{ from: origin, on: 2 }, { from: origin, on: 2 }],
        [{ from: origin, on: 0 }, { from: origin, on: 0 }], [{ from: origin, on: 1 }, { from: origin, on: 1 }]]);
    // 一部の取消: 51（5 弱）→ 53（5 弱）→ 51 の取消で、残った 53 が 5 弱なので bit 1 は立ったまま。続く 53 の取消で 0。
    const T0 = Date.parse("2026-08-03T00:00:00+09:00");
    const s51 = report(BIG51, T0, "C", (xml) => xml.replace(/<MaxInt>7<\/MaxInt>/g, "<MaxInt>5-</MaxInt>"));
    const s53 = decodeXml(vxse53({ eventId: "C", at: iso(T0 + MINUTE), maxInt: "5-" }), "VXSE53");
    const partial = feed(emptyState(), s51, s53, report(BIG51, T0 + 2 * MINUTE, "C", cancelOf));
    expect(eventOf(partial, "C")?.guard?.on).toBe(1);
    expect(eventOf(feed(partial, decodeXml(vxse53({ eventId: "C", at: iso(T0 + 3 * MINUTE), infoType: "取消" }), "VXSE53")), "C")?.guard?.on).toBe(0);
    // 根拠になれる寄与が残らない取消（r8）: 53（5 弱・MaxLgInt 2）で on 3 の event に 52 が残る state で 53 を取り消すと 0。
    const s52 = report("32-35_04_03_240613_VXSE52", T0 + 5 * MINUTE, "D");
    const s53lg = decodeXml(vxse53({ eventId: "D", at: iso(T0 + 6 * MINUTE), maxInt: "5-" }).replace("<Observation>", "<Observation><MaxLgInt>2</MaxLgInt>"),
      "VXSE53");
    const r8 = feed(emptyState(), s52, s53lg);
    expect(eventOf(r8, "D")?.guard?.on).toBe(3);
    const r8cancel = feed(r8, decodeXml(vxse53({ eventId: "D", at: iso(T0 + 7 * MINUTE), infoType: "取消" }), "VXSE53"));
    expect([eventOf(r8cancel, "D")?.guard?.on, eventOf(restored(r8cancel)!, "D")?.guard?.on]).toEqual([0, 0]);
    // 起点の共有（r3）: 発生時刻の読めない震度 3 の VXSE51 を 0 時と 1 時に採り、2 時の 5 弱で初めて線に当たっても from は 0 時。
    const noOrigin = (hour: number, value: string) => report(BIG51, T0 + hour * HOUR, "E", (xml) => xml.replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, "")
      .replace(/<MaxInt>7<\/MaxInt>/g, `<MaxInt>${value}</MaxInt>`));
    const shared = feed(restored(feed(emptyState(), noOrigin(0, "3"), noOrigin(1, "3")))!, noOrigin(2, "5-"));
    expect(eventOf(shared, "E")?.guard).toEqual({ from: T0, on: 1 });
    // 長周期だけ先に採った EventID に後から event が来ると、event は長周期の from を写す。
    const lpFirst = feed(emptyState(), report(BIG62, T0, "F"), report(S5, T0 + HOUR, "F"));
    expect(eventOf(lpFirst, "F")?.guard?.from).toBe(longOf(lpFirst, "F")?.guard?.from);
  });

  it("P3-QC-T02 contractBoundary / P3-QC-AC02・AC04・AC05: L, RESERVE, S, S_f, T_f, N_guard, N_keep and the cases at their bounds", () => {
    const MARK = noticeMarkBytes("notice"), NOTICE_GROWTH = 512 * 4 * MARK + 256 * MARK;
    const RESERVE = 1_470_281 + NOTICE_GROWTH + 512 * 372 + 3 * 2048 * 4 + 768 * 50;
    // P3-UM-RES-09: 前の器＋記録の上限（寄与 512×4＋長周期 256）×印 1 件＋原文の予算＋カード。
    expect([L, RESERVE]).toEqual([5_627_794 + 2304 * unreadableMarkBytes("unreadable") + 131_072 + UNREADABLE_CARDS_MAX_BYTES, 1_958_729]);
    // N_guard の式（P3-QC-AC04 (1)）。S は最大の実例の守る地震（VXSE51＋53＋61 の event と VXSE62）の観測点つき、S_f は畳んだ後、
    // T_f は最大の実例を守らない報として受けて畳んだ後（event 1 件）。
    const EVENT = "20260728162718";
    const real = feed(emptyState(), decodeFixture(BIG51), decodeFixture(BIG53), decodeFixture(BIG61), decodeFixture(BIG62));
    const event = eventOf(real, EVENT)!, lp = longOf(real, EVENT)!;
    const E = generation(emptyState()), PENDING = 131_072, FAILURE = FAILURE_MARKS_MAX_BYTES;
    const S = sizeOf(event) + sizeOf(lp) + 2, S_f = sizeOf(foldedForm(event)) + sizeOf(foldedForm(lp)) + 2, T_f = sizeOf(foldedForm(event)) + 1;
    const G = L - E - RESERVE - PENDING - FAILURE - T_f, N_guard = Math.floor(G / (S + 1)), N_keep = Math.floor(G / (S_f + 1));
    console.info("P3-QC-T02 capacity", JSON.stringify({ L, E, RESERVE, PENDING, FAILURE, S, S_f, T_f, G, N_guard, N_keep }));

    const now = Date.parse("2026-07-29T00:00:00+09:00"), originMs = Date.parse("2026-07-28T16:27:00+09:00");
    const tag = <R extends { source: EarthquakeEvent["contributions"][number]["source"] }>(item: R, family: string, eventId: string): R =>
      ({ ...item, source: { ...item.source, subject: `normal/${family}/${eventId}` } });
    const strip = <V extends { intensity: EarthquakeEvent["contributions"][number]["intensity"] }>(item: V): V => item.intensity == null
      || !item.intensity.items.some((entry) => entry.level === "station") ? item
      : { ...item, intensity: { ...item.intensity, items: item.intensity.items.filter((entry) => entry.level !== "station") }, folded: "0".repeat(16) };
    // 守る地震 k（from は受ける報より古く、24 時間の内）。folded は畳んだ形。
    const guarded = (k: number, folded: boolean): [EarthquakeEvent, LongPeriodSubject] => {
      const id = `G${String(k).padStart(4, "0")}`, from = originMs - HOUR + k * 1_000;
      const one: EarthquakeEvent = { ...event, eventId: id, retainUntil: now + 24 * HOUR, guard: { from, on: 1 },
        contributions: event.contributions.map((item) => (folded ? strip : <V>(value: V) => value)(tag(item, item.family, id))) };
      const two: LongPeriodSubject = { ...(folded ? strip(lp) : lp), eventId: id, subject: `normal/VXSE62/${id}`,
        source: { ...lp.source, subject: `normal/VXSE62/${id}` }, retainUntil: now + 36 * HOUR, guard: { from, on: 2 } };
      return [one, two];
    };
    const quakes = (count: number, folded: boolean) => Array.from({ length: count }, (_, k) => guarded(k, folded));
    const world = (pairs: readonly [EarthquakeEvent, LongPeriodSubject][], extra: readonly EarthquakeEvent[] = []): SeismicUnitState =>
      ({ ...emptyState(), earthquakes: [...pairs.map(([one]) => one), ...extra], longPeriods: pairs.map(([, two]) => two) });
    const weak = eventOf(feed(emptyState(), report(W4, now - HOUR, "W")), "W")!;
    const weakN = (k: number): EarthquakeEvent => { const id = `W${String(k).padStart(4, "0")}`;
      return { ...weak, eventId: id, contributions: weak.contributions.map((item) => tag(item, item.family, id)) }; };
    // pending の上限の近く（予約込みで 131,072 byte の内）。
    const intent = step(emptyState(), decodeFixture(W4)).intents[0];
    const waiting = { ...intent, id: "U-Q:fill:pending", payload: { ...intent.payload, body: "x".repeat(120_000) } };

    // (1) N_guard 件の守る地震・pending・守らない記録で器を埋めた state に、最大の実例を守らない報として受けても守る記録は畳まれない。
    const filled: EarthquakeEvent[] = [];
    const base = (): SeismicUnitState => ({ ...world(quakes(N_guard, false), filled), intents: [waiting] });
    while (generation({ ...base(), earthquakes: [...base().earthquakes, weakN(filled.length)] }) <= L) filled.push(weakN(filled.length));
    const loose = report(BIG53, Date.parse("2026-07-28T16:35:00+09:00"), "U0001", (xml) => xml.replace(/(<\/CodeDefine>\s*<MaxInt>)7(<\/MaxInt>)/, "$14$2"));
    const before = base(), candidate = eventOf(step(emptyState(), loose).state, "U0001")!;
    expect([generation(before) <= L, generation(before) + sizeOf(candidate) + 1 > L]).toEqual([true, true]);
    const kept = step(before, loose, "verified", clock(now));
    expect(decision(kept).decision).toBe("changed");
    expect(reasons(kept)).toContain("seismicStationsFolded");
    expect(kept.state.earthquakes.filter((item) => item.eventId.startsWith("G") && isFolded(item))).toEqual([]);
    expect(roundTrip(kept.state).kind).toBe("restored");

    // (2) 畳んだ守る地震 N_keep＋1 件の state に守る報を受け、第 1〜5 段の後もなお L を越える案は、最古の守る地震が記録ごと消える。
    const big = report(BIG53, Date.parse("2026-07-28T16:35:00+09:00"), "K0001");
    const keepWorld = world(quakes(N_keep + 1, true));
    const probe = pressed(keepWorld, big, 1, now).roomy;
    const pushed = pressed(keepWorld, big, foldSave(eventOf(probe, "K0001")!) + 1, now).step;
    expect([decision(pushed).decision, eventOf(pushed.state, "G0000"), longOf(pushed.state, "G0000"), eventOf(pushed.state, "G0001") != null,
      isFolded(eventOf(pushed.state, "K0001"))]).toEqual(["changed", undefined, undefined, true, true]);
    expect(pushed.diagnostics).toContainEqual({ level: "INFO", component: "seismic", reason: "seismicCapacityEvicted", unit: "U-Q", count: 2 });

    // (3) 同じ EventID の記録だけで器を越える守る報（r5）: 市町村を足した長周期と、同じ EventID の守る event を畳んでも L を越える。
    // 市町村の名前は JSON で 2 byte の「\」（P3-UM-RES-09 で広げた器を、入力の上限 8 MiB の報 2 つで越える）。
    const lpZ = report(BIG62, now, "Z", widened(L / 4 + 16_000, escapedCities));
    const zWorld = feed(emptyState(), lpZ);
    const zEvent = decodeXml(widened(L / 4 + 16_000, escapedCities)(vxse53({ eventId: "Z", at: iso(now + MINUTE), origin: iso(now + MINUTE),
      maxInt: "5-", city: CITY })), "VXSE53");
    const refused = step(zWorld, zEvent);
    expect([decision(refused).decision, refused.state.longPeriods, reasons(refused)]).toEqual(["capacityExceeded", zWorld.longPeriods, ["capacityRejected"]]);

    // 読み戻しの上限いっぱいの記憶（取消の一覧の印・counted・記憶の guard）の state は RESERVE の内で読み戻せ、上限の外の byte で越えれば読み戻さない。
    const memory = reserveState(now);
    const reserve = (state: SeismicUnitState) => state.earthquakes.reduce((sum, item) => sum + sizeOf(item), 0)
      + state.longPeriods.reduce((sum, item) => sum + sizeOf(item), 0) + sizeOf(state.daily);
    console.info("P3-QC-T02 reserve state", JSON.stringify({ reserve: reserve(memory), RESERVE, slack: RESERVE - reserve(memory) }));
    expect([reserve(memory) <= RESERVE, roundTrip(memory).kind]).toEqual([true, "restored"]);
    // JSON で 6 byte になる制御文字は 1 文字 3 byte の仮定の外（cut は文字数で切る）。
    const escapes = Math.ceil((RESERVE - reserve(memory) + 1) / (64 * 3));
    const over = { ...memory, earthquakes: memory.earthquakes.map((item, index) => index < escapes
      ? { ...item, cancelledSummary: { hypocenterName: "\u0001".repeat(64), originTimeRaw: item.cancelledSummary!.originTimeRaw } } : item) };
    expect([reserve(over) > RESERVE, roundTrip(over).kind]).toEqual([true, "invalid"]);

    // P3-UM-AC03 (6)・RES-09: 記録の上限（寄与 512×4・長周期 256）の全部に読み戻しの上限いっぱいの印と予算いっぱいの原文を足すと、
    // 前の器（印・原文・カードの項の前）ちょうどの state も、カードの予約（計量に入る、P3-UM-AC11 (10)）を足して器の内で decode が受ける。
    // 小さい実例の 4 family の寄与と長周期（詰め物は最初の地震の VXSE52 の見出し）。
    const small = feed(emptyState(), ...["32-35_01_01_260824_VXSE51", "32-35_04_03_240613_VXSE52", "32-35_01_03_100514_VXSE53",
      "32-35_03_02_240613_VXSE61", "synthetic_phase4a_VXSE62_special"].map((file, index) => report(file, now + index * MINUTE, "S")));
    const four = eventOf(small, "S")!, slp = longOf(small, "S")!;
    expect(four.contributions.map((item) => item.family).sort()).toEqual(["VXSE51", "VXSE52", "VXSE53", "VXSE61"]);
    const marks = longestMarks(512 * 4 + 256, "hypocenter", [], 131_072);
    const bounded = (length: number, marked: boolean): SeismicUnitState => {
      const id = (k: number) => `B${String(k).padStart(4, "0")}`;
      const earthquakes = Array.from({ length: 512 }, (_, k): EarthquakeEvent => ({ ...four, eventId: id(k),
        contributions: four.contributions.map((item, index) => ({ ...tag(item, item.family, id(k)),
          ...k === 0 && item.family === "VXSE52" ? { headline: "x".repeat(length) } : {}, ...marked ? { unreadable: marks[k * 4 + index] } : {} })) }));
      const longPeriods = Array.from({ length: 256 }, (_, k): LongPeriodSubject => ({ ...slp, eventId: id(k), subject: `normal/VXSE62/${id(k)}`,
        source: { ...slp.source, subject: `normal/VXSE62/${id(k)}` }, ...marked ? { unreadable: marks[2048 + k] } : {} }));
      return { ...emptyState(), earthquakes, longPeriods };
    };
    const atLimit = L - generation(bounded(0, false));
    expect([generation(bounded(atLimit, false)), roundTrip(bounded(atLimit, false)).kind, roundTrip(bounded(atLimit + 1, false)).kind])
      .toEqual([L, "restored", "invalid"]);
    const marked = bounded(atLimit - 2304 * unreadableMarkBytes("unreadable") - 131_072, true);
    console.info("P3-UM-AC03 (6) U-Q", JSON.stringify({ marked: generation(marked), limit: L, cards: UNREADABLE_CARDS_MAX_BYTES }));
    expect([generation(marked) <= L, roundTrip(marked).kind]).toEqual([true, "restored"]);
  });

  it("P3-QC-T04 acceptance / P3-QC-AC07・AC10: the whole cancel leaves a marked card, leaves today's count and recomputes the maximum", () => {
    const EVENT = "20260728162718", cancel = decodeFixture("synthetic_VXSE53_cancel");
    const four = decodeXml(vxse53({ eventId: "20260728170000", at: "2026-07-28T17:00:00+09:00", maxInt: "4" }), "VXSE53");
    const both = feed(emptyState(), decodeFixture(S7), four);
    expect(both.daily.normal).toMatchObject({ count: 2, maxInt: { value: 7 } });
    const cancelled = step(both, cancel);
    expect(cancelled.state.daily.normal).toMatchObject({ count: 1, maxInt: { kind: "text", value: "4" }, counted: [["20260728170000", 4]] });
    const summary = { hypocenterName: "熊本県熊本地方", originTimeRaw: "2026-07-28T16:27:00+09:00" };
    expect(toSeismicView(cancelled.state).earthquakes.find((item) => item.eventId === EVENT)).toMatchObject({ sources: [], hypocenter: null,
      cancelledSummary: summary });
    expect(cancelled.displayChanges.find((item) => item.subject === `normal/earthquake/${EVENT}`)?.after).toMatchObject({ subjects: [],
      current: { cancelledSummary: summary } });
    // 同じ取消の受け直しで二重に引かない。取消の後に新しい版の発表で active に戻ると数え直し、印を外す。
    expect([decision(step(cancelled.state, cancel)).decision, step(cancelled.state, cancel).state.daily.normal.count]).toEqual(["unchanged", 1]);
    const back = step(cancelled.state, decodeFixture(S7, (xml) => sentLater(xml, 600)));
    expect([back.state.daily.normal.count, eventOf(back.state, EVENT)?.cancelledSummary]).toEqual([2, undefined]);
    // VXSE51 の寄与が残る event の VXSE53 だけの取消では引かない。
    const partial = feed(emptyState(), decodeFixture(BIG51), decodeFixture(S7), cancel);
    expect([partial.daily.normal.count, eventOf(partial, EVENT)?.cancelledSummary]).toEqual([1, undefined]);
    // 51 が期限切れ・53 が取消の event は印を持たず、保存→復元で同じ state に戻る。
    const expiredAt = Date.parse("2026-07-28T16:36:00+09:00") + 24 * HOUR;
    const mixed = reduceSeismicUnit(partial, { kind: "deadline", clock: clock(expiredAt) }).state;
    expect(eventOf(mixed, EVENT)?.contributions.map((item) => item.effective)).toEqual(["expired", "cancelled"]);
    expect(eventOf(mixed, EVENT)).not.toHaveProperty("cancelledSummary");
    const restored = roundTrip(mixed);
    expect(restored.kind === "restored" ? restored.state.earthquakes : null).toEqual(mixed.earthquakes);
    // その日に数えた地震なら、後の 51 の取消で件数を引き、印は事実を持たないので両方 null（数えた日の当日履歴を試験の中で置く）。
    const dayKey = new Date(expiredAt + MINUTE + 9 * HOUR).toISOString().slice(0, 10);
    const counted = { ...mixed, daily: { ...mixed.daily, normal: { ...mixed.daily.normal, dayKey, count: 1, maxInt: { kind: "text" as const, value: "7", raw: "7" },
      counted: [[EVENT, 9] as const] } } };
    const ended = step(counted, report(BIG51, expiredAt + MINUTE, EVENT, cancelOf));
    expect([ended.state.daily.normal.count, ended.state.daily.normal.maxInt, eventOf(ended.state, EVENT)?.cancelledSummary])
      .toEqual([0, null, { hypocenterName: null, originTimeRaw: null }]);
  });

  // 実不具合の再発防止（K11 r2 の契約適合レビュー P2）: 容量で記録が退去された地震の取消でも、その日に数えた組が残っていれば件数を引き、
  // 最大震度を数え直す（P3-QC-AC07 (2)(3)）。記録の無い取消なので一覧の印は付けない。
  it("P3-QC-T04 regression / P3-QC-AC07: a cancel after the record was evicted still leaves today's count and recomputes the maximum", () => {
    const EVENT = "20260728162718";
    const four = decodeXml(vxse53({ eventId: "20260728170000", at: "2026-07-28T17:00:00+09:00", maxInt: "4" }), "VXSE53");
    const both = feed(emptyState(), decodeFixture(S7), four);
    const evicted: SeismicUnitState = { ...both, earthquakes: both.earthquakes.filter((item) => item.eventId !== EVENT) };
    const cancelled = step(evicted, decodeFixture("synthetic_VXSE53_cancel"));
    expect([cancelled.state.daily.normal.count, cancelled.state.daily.normal.maxInt, cancelled.state.daily.normal.counted])
      .toEqual([1, { kind: "text", value: "4", raw: "4" }, [["20260728170000", 4]]]);
    expect(eventOf(cancelled.state, EVENT)).not.toHaveProperty("cancelledSummary");
  });

  it("P3-QC-T05 acceptance / P3-QC-AC08: expiry keeps a memory for 6 h, and the table of reports against it", () => {
    const EVENT = "20260728162718", reported = Date.parse("2026-07-28T16:31:00+09:00");
    const live = feed(emptyState(), decodeFixture(S7), decodeFixture(BIG62));
    const expiry = reduceSeismicUnit(live, { kind: "deadline", clock: clock(reported + 24 * HOUR) });
    const memory = eventOf(expiry.state, EVENT)!, source = eventOf(live, EVENT)!.contributions[0].source;
    expect(memory).toMatchObject({ strongHold: null, guard: { from: eventOf(live, EVENT)!.guard!.from, on: 0 }, retainUntil: reported + 30 * HOUR,
      contributions: [{ family: "VXSE53", source, effective: "expired", targetDateTimeRaw: null, title: "", headline: null, hypocenter: null,
        intensity: null, tsunamiComment: null, notice: expect.any(Object) }] });
    // 同じ EventID の長周期は自分の on（階級 4）で守られる。期限切れの記録は view に載らず、通知しない。
    expect([longOf(expiry.state, EVENT)?.guard?.on, toSeismicView(expiry.state).earthquakes, expiry.intents]).toEqual([2, [], []]);
    expect(expiry.outcomes).toMatchObject([{ kind: "deadlineApplied", subjects: [{ transition: "expired", source }] }]);
    // 記憶への報の遷移（P3-QC-AC08 (4)）。受信は記憶の間。
    const now = clock(reported + 24 * HOUR + MINUTE);
    const towards = (transform: (xml: string) => string) => step(expiry.state, decodeFixture(S7, transform), "verified", now);
    expect(decision(towards((xml) => xml))).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    expect(decision(towards((xml) => sentLater(xml, -60)))).toMatchObject({ decision: "unchanged", reason: "stale" });
    const sameCancel = towards(cancelOf);
    expect([decision(sameCancel).decision, eventOf(sameCancel.state, EVENT)?.contributions[0].effective, sameCancel.intents]).toEqual(["changed", "cancelled", []]);
    // 通知したかの印の証拠があれば、記憶の間に届いた取消を通知する（H19）。
    const heard: SeismicUnitState = { ...expiry.state, earthquakes: expiry.state.earthquakes.map((item) => ({ ...item,
      contributions: item.contributions.map((entry) => ({ ...entry, notice: { ...entry.notice!, evidence: "unknown" as const } })) })) };
    expect(step(heard, decodeFixture(S7, cancelOf), "verified", now).intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    const untimed = towards((xml) => xml.replace(/<DateTime>[^<]*<\/DateTime>/, "<DateTime>x</DateTime>"));
    expect([decision(untimed).decision, eventOf(untimed.state, EVENT)?.contributions[0].unconfirmed != null]).toEqual(["unchanged", true]);
    // newer は active に戻り、保存→復元を挟んでも guard の from は変わらず、守る線に当たれば同じ from で再成立する。
    const restoredMemory = roundTrip(expiry.state);
    if (restoredMemory.kind !== "restored") throw new Error("memory does not restore");
    const revived = step(restoredMemory.state, report(S7, reported + 24 * HOUR + MINUTE, EVENT));
    expect([eventOf(revived.state, EVENT)?.contributions[0].effective, eventOf(revived.state, EVENT)?.guard,
      eventOf(revived.state, EVENT)?.retainUntil]).toEqual(["active", { from: memory.guard!.from, on: 1 }, reported + 48 * HOUR + MINUTE]);
    // 記憶の長さ 6 時間の境界（1 分前と当日）。長周期も同じ（36 時間で記憶、42 時間で消える）。
    const at = (ms: number) => reduceSeismicUnit(expiry.state, { kind: "deadline", clock: clock(ms) }).state;
    expect([eventOf(at(reported + 30 * HOUR - MINUTE), EVENT) != null, eventOf(at(reported + 30 * HOUR), EVENT)]).toEqual([true, undefined]);
    const lgAt = Date.parse("2026-07-28T16:37:00+09:00");
    expect([longOf(at(lgAt + 36 * HOUR), EVENT)?.effective, longOf(at(lgAt + 42 * HOUR - MINUTE), EVENT)?.effective, longOf(at(lgAt + 42 * HOUR), EVENT)])
      .toEqual(["expired", "expired", undefined]);
    // 件数の超過では期限切れの記憶が、生きている守らない地震より先に退去する（記憶が最も新しくても）。
    const seed = eventOf(feed(emptyState(), decodeFixture("32-35_04_03_240613_VXSE52")), "20100125161517")!;
    const clone = (k: number): EarthquakeEvent => { const id = `C${String(k).padStart(4, "0")}`;
      return { ...seed, eventId: id, retainUntil: reported + 48 * HOUR, contributions: seed.contributions.map((item) =>
        ({ ...item, source: { ...item.source, subject: `normal/${item.family}/${id}` } })) }; };
    const crowded: SeismicUnitState = { ...emptyState(), earthquakes: [...Array.from({ length: 511 }, (_, k) => clone(k)), { ...memory, retainUntil: reported + 48 * HOUR }] };
    const pushedOut = step(crowded, decodeXml(vxse53({ eventId: "NEW", at: iso(reported + 24 * HOUR), maxInt: "1" }), "VXSE53"));
    expect([eventOf(pushedOut.state, EVENT), eventOf(pushedOut.state, "C0000") != null]).toEqual([undefined, true]);
  });

  it("P3-QC-T07 contractBoundary / P3-QC-AC10・AC13: v5 round trip of every new field, the next eviction, the decode checks and the loss row", () => {
    // 畳んだ event と長周期・取り消した地震の印・counted・守る地震（event と長周期で from を共有）は T01 の器から、期限切れの記憶と
    // 51 が expired・53 が cancelled の event は T04・T05 の筋書きから組む。
    const world = quakeWorld();
    const x = quake(ID.X, T + 60 * MINUTE, { originMs: T + 55 * MINUTE, big: 400_000 });
    const folded = pressed(world, x, 1, PAD_AT).step.state;
    const reported = Date.parse("2026-07-28T16:31:00+09:00");
    const memories = reduceSeismicUnit(feed(emptyState(), decodeFixture(BIG51), decodeFixture(S7), decodeFixture("synthetic_VXSE53_cancel"),
      report(S7, reported + HOUR, "20260728172700"), report(BIG62, reported + HOUR, "20260728172700")), { kind: "deadline", clock: clock(reported + 24 * HOUR + 2 * HOUR) }).state;
    // 詰め物は外す（器の内に戻す）。
    const state: SeismicUnitState = { ...folded, earthquakes: [...folded.earthquakes.filter((item) => item.eventId !== "PAD"), ...memories.earthquakes],
      longPeriods: [...folded.longPeriods, ...memories.longPeriods] };
    expect([isFolded(longOf(state, ID.L1)), eventOf(state, ID.M)?.cancelledSummary != null, eventOf(state, "20260728162718")?.contributions.map((item) => item.effective),
      eventOf(state, "20260728172700")?.contributions[0].effective, longOf(state, "20260728172700")?.guard]).toEqual([true, true, ["expired", "cancelled"],
      "expired", { from: eventOf(state, "20260728172700")!.guard!.from, on: 2 }]);
    const restored = roundTrip(state);
    if (restored.kind !== "restored") throw new Error("v5 state does not restore");
    expect([restored.state.earthquakes, restored.state.longPeriods, restored.state.daily]).toEqual([state.earthquakes, state.longPeriods, state.daily]);
    // 次の受信の退去の順も同じ。
    const next = quake("20260801000801", T + 70 * MINUTE, { originMs: T + 65 * MINUTE, big: 400_000 });
    const order = (from: SeismicUnitState) => { const result = pressed(from, next, 60_000, PAD_AT).step;
      return [result.state.earthquakes.map((item) => [item.eventId, isFolded(item)]), result.state.longPeriods.map((item) => [item.eventId, isFolded(item)])]; };
    expect(order(restored.state)).toEqual(order(state));
    expect(seismicUnitCodec.discardableSchemaVersions).toContain("p3-seismic-unit-v4");
    // H39: U-Q の行は 9 語（畳みの 1 語と原文の外し・読めない報、P3-UM-AC11 (11)）で、losses の上界は 9 語の最長の組（913 byte）。
    expect([lossReasons("U-Q").length, lossReasons("U-Q").includes("seismicStationsFolded"), LOSS_TALLY_MAX_BYTES]).toEqual([9, true, 913]);

    type Row = Record<string, unknown>;
    const value = JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as { earthquakes: Row[]; longPeriods: Row[]; daily: Record<Operation, Row> };
    const index = (list: Row[], eventId: string) => list.findIndex((item) => item.eventId === eventId);
    const patchEvent = (eventId: string, patch: (row: Row) => Row) => ({ ...value, earthquakes: value.earthquakes.map((item, at) =>
      at === index(value.earthquakes, eventId) ? patch(item) : item) });
    const patchLong = (eventId: string, patch: (row: Row) => Row) => ({ ...value, longPeriods: value.longPeriods.map((item, at) =>
      at === index(value.longPeriods, eventId) ? patch(item) : item) });
    const contributions = (row: Row) => row.contributions as Row[];
    const withContribution = (row: Row, patch: (item: Row) => Row) => ({ ...row, contributions: contributions(row).map((item, at) => at === 0 ? patch(item) : item) });
    const W1 = value.earthquakes[index(value.earthquakes, ID.W1)];
    const station = { level: "station", code: "1", name: "x", parentCode: null, maxInt: { kind: "missing" }, maxLgInt: { kind: "missing" } };
    const invalid: [string, unknown][] = [
      ["folded with a station", patchLong(ID.L1, (row) => ({ ...row, intensity: { ...(row.intensity as Row),
        items: [...((row.intensity as Row).items as Row[]), station] } }))],
      ["folded form", patchLong(ID.L1, (row) => ({ ...row, folded: "XYZ" }))],
      ["expired keeps facts", patchEvent("20260728172700", (row) => withContribution(row, (item) => ({ ...item, title: "震源・震度情報" })))],
      ["memory keeps strongHold", patchEvent("20260728172700", (row) => ({ ...row, strongHold: (W1.strongHold ?? { originTimeRaw: "2026-07-28T16:27:00+09:00",
        until: Date.parse("2026-07-28T16:27:00+09:00") + 12 * HOUR, establishedBy: { family: "VXSE53", reportDateTimeRaw: "x", serialRaw: "1", infoTypeRaw: "発表" } }) }))],
      ["memory guard on", patchEvent("20260728172700", (row) => ({ ...row, guard: { ...(row.guard as Row), on: 1 } }))],
      ["guard on 4", patchEvent(ID.S1, (row) => ({ ...row, guard: { ...(row.guard as Row), on: 4 } }))],
      ["normal record without guard", patchEvent(ID.W1, ({ guard: _guard, ...row }) => row)],
      ["event and long period apart", patchLong(ID.S1, (row) => ({ ...row, guard: { ...(row.guard as Row), from: Number((row.guard as Row).from) + 1 } }))],
      ["summary on a live event", patchEvent(ID.W1, (row) => ({ ...row, cancelledSummary: { hypocenterName: null, originTimeRaw: null } }))],
      ["counted duplicate", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, counted: [["E", 1], ["E", 2]] } } }],
      ["counted stage", { ...value, daily: { ...value.daily, normal: { ...value.daily.normal, counted: [["E", 10]] } } }],
    ];
    for (const [label, payload] of invalid) expect(seismicUnitCodec.decode(JSON.parse(JSON.stringify(payload)) as JsonValue).kind, label).toBe("invalid");
  });
});

// 読み戻しの上限いっぱいの退去できない記録: normal の取消記憶 512 件（4 family・取消の一覧の印・on 0 の guard）と長周期 256 件、当日履歴の上限。
// 取消の一覧の印・counted・guard は読み戻しの上限の長さ（印字の文字は 1 文字 3 byte、from は有限な数の JSON の最長 25 文字）。
function reserveState(now: number): SeismicUnitState {
  const id40 = (prefix: string, index: number) => `${prefix}${String(index).padStart(39, "0")}`;
  const wide = (length: number) => "震".repeat(length);
  const time = "2099-01-01T08:59:59+09:00";
  // inputId は host の input-N の形（22 文字）。RESERVE の式（P3-C7-CAPACITY-BUDGET の取消記憶 2,029 byte）と同じ形。
  const source = (family: string, eventId: string) => ({ inputId: `input-${"9".repeat(16)}`, origin: "replay" as const, operation: "normal" as const, family,
    subject: `normal/${family}/${eventId}`, reportDateTimeRaw: time, controlDateTimeRaw: time, serialRaw: "1234567890", infoTypeRaw: "取消" });
  const notice = { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"] as const, evidence: "unattempted" as const };
  const guard = { from: -0.0000012345678901234567, on: 0 as const };
  const forgotten = { effective: "cancelled" as const, targetDateTimeRaw: null, title: "", headline: null, hypocenter: null, intensity: null, tsunamiComment: null, notice };
  const earthquakes = Array.from({ length: 512 }, (_, index): EarthquakeEvent => {
    const eventId = id40("m", index);
    return { eventId, operation: "normal", strongHold: null, retainUntil: now + HOUR, guard,
      contributions: (["VXSE51", "VXSE52", "VXSE53", "VXSE61"] as const).map((family) => ({ family, source: source(family, eventId), ...forgotten })),
      cancelledSummary: { hypocenterName: wide(64), originTimeRaw: wide(40) } };
  });
  const longPeriods = Array.from({ length: 256 }, (_, index): LongPeriodSubject => {
    const eventId = id40("l", index);
    return { subject: `normal/VXSE62/${eventId}`, eventId, operation: "normal", source: source("VXSE62", eventId), effective: "cancelled", title: "",
      headline: null, hypocenter: null, intensity: null, retainUntil: now + HOUR, notice, guard };
  });
  const text = (length: number) => ({ kind: "text" as const, value: wide(length), raw: wide(length) });
  const history = (prefix: string) => ({ dayKey: "2099-01-01", count: 9_999, maxInt: text(32),
    counted: Array.from({ length: 2048 }, (_, index) => [id40(prefix, index), 9] as const),
    recent: Array.from({ length: 5 }, (_, index) => ({ eventId: id40(prefix, index), originTimeRaw: wide(40), reportDateTimeRaw: time,
      hypocenterName: wide(64), magnitude: text(32), maxInt: { kind: "fromTo" as const, from: text(32), to: text(32) }, cancelled: false })) });
  return { ...emptyState(), earthquakes, longPeriods, daily: { normal: history("n"), training: history("t"), test: history("s") } };
}
