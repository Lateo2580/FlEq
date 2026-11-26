import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { EewCurrent } from "../../contracts/p2-eew-unit.types";
import type { DiagnosticReason, JsonValue, ReportRef, RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { DisplayAreaSystem, DisplaySummaryItem } from "../../contracts/p2-snapshot-sse.types";
import { CARD_TEXT } from "../../src/checkpoint/checkpoint";
import type { EarthquakeEventView, SeismicRecentQuake } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiObservationSubject } from "../../contracts/p3-tsunami-unit.types";
import type { KnownCodeTable } from "../../contracts/p4-gis-assets.types";
import type {
  DisplayCutText, DisplayDetailRef, DisplayPaint, DisplayStateMark, DisplayValueText, DisplayWireCard, EarthquakeRowWire, EarthquakeWire, EewAreaRow, EewCardHeader,
  EewMini, EewWire, LongPeriodWire, TsunamiClosedWire, TsunamiForecastRow, TsunamiForecastWire, TsunamiWire,
} from "../../contracts/p4-display-wire.types";
import known from "../../assets/gis/known-codes.v1.json";
import { currentSubject, reduceEewUnit } from "../../src/units/eew/eew-unit";
import { reduceSeismicUnit, seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { reduceTsunamiUnit, toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { deadlineOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { WIRE_COUNTS, WIRE_LIMITS } from "../../src/view-projector/display-wire";
import { decodeFixture, receive as receiveQuake, vxse53 } from "../seismic-unit/seismic-fixture";
import { clock, decodeXml, observation, receive as receiveTsunami, vtse41 } from "../tsunami-unit/tsunami-fixture";
import { eewStep, eewXml, emptyEew, emptyQuake, emptyTsunami, fixture, projected, wire } from "./display-wire-fixture";

const table: KnownCodeTable = known;
const AT = "2099-01-01T09:00:00+09:00";
const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString().replace("Z", "+00:00");
const eewId = (index: number) => `2099010100${String(index).padStart(4, "0")}`;
function eewChange(before: EewCurrent | null, after: EewCurrent | null): RuntimeDisplayChange {
  const one = (item: EewCurrent) => ({ unit: "U-E" as const, operation: item.operation, subject: item.subject, office: null, current: item, subjects: [currentSubject(item)] });
  const value = (after ?? before)!;
  return { unit: "U-E", operation: value.operation, subject: value.subject, before: before == null ? null : one(before), ...(after == null ? { after: null, removal: "unknown" as const } : { after: one(after) }) };
}

// 契約の境界 P4-DW-AC04・AC03（型の最大値）: display-wire.ts の型と上限の表で最大の形を組み、script の組 A短 の数と照らす。
describe("P4-DW-T01 contractBoundary: the protected three fit 262,144 bytes", () => {
  it("builds the widest wire from the types and limits and matches the script's group A短", () => {
    const MS = Number.MAX_SAFE_INTEGER;
    const x = (n: number) => "x".repeat(n);
    // 同じ欄に入りうる値のうち直列化が最も長いもの（null・false・負の番号を含む）。
    const cut = (n: number): DisplayCutText => ({ text: x(n), cut: false });
    const value = (): DisplayValueText => ({ v: x(WIRE_LIMITS.valueRaw), desc: x(WIRE_LIMITS.description), cut: false });
    const marks: readonly DisplayStateMark[] = ["unconfirmed", "restored", "expiryPending", "capacityExceeded"];
    const ref: DisplayDetailRef = { id: x(64), rev: x(64) };
    const fromTo = { f: null, t: null };
    const subareas = table.forecastLocalE.length, cities = table.city.length, tsunamiAreas = table.tsunamiArea.length;
    const paint = (code: string, n: number): readonly DisplayPaint[] => Array.from({ length: n }, () => [code, -1] as const);
    const header: Omit<EewCardHeader, "letter"> = { eventId: x(WIRE_LIMITS.eventId), operation: "training", warning: false, serial: MS, final: false,
      reportTime: x(WIRE_LIMITS.time), max: fromTo, hypo: cut(WIRE_LIMITS.hypocenter), mag: value(), depth: value(), epi: cut(WIRE_LIMITS.coordinate),
      assumed: false, detectOnly: false, place: cut(WIRE_LIMITS.place), lg: fromTo, unread: false, marks, unknownAreas: MS, dupAreas: MS, ref };
    const row: EewAreaRow = { c: "622", f: null, t: null, cd: "arrived", ks: null, at: x(WIRE_LIMITS.time), lg: fromTo };
    const mini: readonly EewMini[] = Array.from({ length: subareas }, () => ["622", null] as const);
    const eewBytes = Math.max(...[1, 2, WIRE_COUNTS.eewCards].map((count): number => {
      const cards = Array.from({ length: count }, () => count === 1 ? { ...header, letter: "A" as const, rows: Array.from({ length: subareas }, () => row) }
        : count === 2 ? { ...header, letter: "A" as const, mini, top: [row, row] } : { ...header, letter: "A" as const, mini });
      const eew: EewWire = { cards, composites: [paint("622", subareas)], omitted: MS };
      return Buffer.byteLength(JSON.stringify(eew));
    }));
    const forecastRow: TsunamiForecastRow = { c: "100", k: "majorWarning", first: { raw: x(WIRE_LIMITS.time), cond: cut(WIRE_LIMITS.firstWave) }, h: { raw: x(WIRE_LIMITS.height), cut: false } };
    const forecast: TsunamiForecastWire = { eventId: x(WIRE_LIMITS.eventId), operation: "training", serial: MS, reportTime: x(WIRE_LIMITS.time),
      comment: cut(WIRE_LIMITS.comment), unread: false, marks, omittedUnkeyed: MS, unknownAreas: MS, dupAreas: MS, ref,
      rows: Array.from({ length: tsunamiAreas }, () => forecastRow), unkeyed: Array.from({ length: WIRE_COUNTS.unkeyed }, () => ({ name: cut(WIRE_LIMITS.unkeyedName), k: "majorWarning" as const })) };
    const closed: TsunamiClosedWire = { eventId: x(WIRE_LIMITS.eventId), family: "VTSE51", closedAt: MS };
    const tsunami: TsunamiWire = { forecasts: Array.from({ length: WIRE_COUNTS.tsunamiEvents }, () => forecast), omittedEvents: MS,
      composites: [{ forecast: Array.from({ length: tsunamiAreas }, () => ["100", "majorWarning"] as const), observed: Array.from({ length: tsunamiAreas }, () => ["100", x(WIRE_LIMITS.height)] as const) }],
      closed: Array.from({ length: 3 }, () => ({ items: Array.from({ length: WIRE_COUNTS.closed }, () => closed), omitted: MS })) };
    const quakeRow: EarthquakeRowWire = { eventId: x(WIRE_LIMITS.eventId), operation: "training", origin: x(WIRE_LIMITS.time), reportTime: x(WIRE_LIMITS.time),
      hypo: cut(WIRE_LIMITS.hypocenter), mag: value(), depth: value(), depthBound: "upper", maxInt: null, cancelled: false, tsunami: cut(WIRE_LIMITS.tsunamiEval),
      strongest: Array.from({ length: 8 }, () => "99999999"), omittedStrongest: MS, tsunamiCodes: Array.from({ length: 4 }, () => "9999"), omittedTsunamiCodes: MS, marks, unknownAreas: MS, ref: { id: x(64), rev: x(64) } };
    const longPeriod: LongPeriodWire = { eventId: x(WIRE_LIMITS.eventId), operation: "training", reportTime: x(WIRE_LIMITS.time), maxLg: null, marks, unknownAreas: MS, ref };
    // 今日の地震は区分ごとに 9 行（U-Q の recent の上限、P4-UQR-D-ROWS=A）で 27 行。
    const quake: EarthquakeWire = { rows: Array.from({ length: 27 }, () => quakeRow), daily: Array.from({ length: 3 }, () => ({ operation: "training" as const, count: MS, maxInt: null })),
      composites: [{ areas: paint("2230600", cities), unknownAreas: MS }], longPeriods: [longPeriod, longPeriod], omittedLongPeriods: MS,
      longPeriodComposites: [{ areas: paint("622", subareas), unknownAreas: MS }] };
    // 分野の包み（unit・contentRevision・items 3 つ）と読めない報のカード 8 枚も型の最大の形で組む。
    const counts = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, MS]));
    const item = (informationType: DisplaySummaryItem["informationType"], systems: readonly DisplayAreaSystem[]): DisplaySummaryItem => ({ operation: "training", informationType,
      activeCount: MS, highestSeverity: "specialWarning", areaCounts: counts(systems), updatedAt: MS,
      unavailable: counts(["capacityExceeded", "historyUnavailable", "coverageIncomplete"]),
      unconfirmed: counts(["startup", "disconnected", "scopeCapacity", "scopeRetired", "capacityExceeded", "freshnessSuspect", "unreadableReport"]),
      unknownCode: counts(["unknown", "missing", "empty"]),
      freshness: counts(["headMissing", "reportDateTimeMissing", "reportDateTimeInvalid", "identityMissing", "identityInvalid", "requiredStructureMissing", "requiredStructureInvalid", "stale"]),
      confirmation: { state: "unconfirmed", confirmedAt: MS } });
    // 保護 3 分野のカードは区域の一覧（U-Y だけが持つ）を持たない。理由の語は DiagnosticReason の最長の語。
    const card: DisplayWireCard = { kind: "unidentified", inputId: x(64), headType: x(CARD_TEXT.headType), operation: "training", receivedAt: MS,
      reason: "notificationExpiredClockUnverified" satisfies DiagnosticReason, title: cut(WIRE_LIMITS.cardTitle), headline: cut(WIRE_LIMITS.cardHeadline),
      reportDateTimeRaw: x(CARD_TEXT.reportDateTimeRaw), rawCut: false, rawDropped: true, count: MS, hasRaw: false };
    const domain = <W>(unit: "U-E" | "U-T" | "U-Q", wire: W, informationType: DisplaySummaryItem["informationType"], systems: readonly DisplayAreaSystem[]) =>
      Buffer.byteLength(JSON.stringify({ unit, contentRevision: String(MS), items: [item(informationType, systems), item(informationType, systems), item(informationType, systems)],
        wire, cards: Array.from({ length: 8 }, () => card) })) - Buffer.byteLength(JSON.stringify(wire));
    const wrappers = domain("U-E", 0, "eew", ["eewArea"]) + domain("U-T", 0, "tsunami", ["tsunamiForecastArea", "tsunamiStation"])
      + domain("U-Q", 0, "earthquake", ["prefecture", "seismicArea", "municipality"]);
    const parts = [eewBytes, Buffer.byteLength(JSON.stringify(tsunami)), Buffer.byteLength(JSON.stringify(quake))];
    const total = parts.reduce((sum, value) => sum + value, 0) + wrappers;
    const script: unknown = JSON.parse(execFileSync(process.execPath, ["reconstruction/contracts/p4-display-wire-max.mjs"], { encoding: "utf8" }));
    const groups = typeof script === "object" && script != null && "groups" in script && Array.isArray(script.groups) ? script.groups : [];
    const ruled = groups.find((group: { name?: unknown }) => group.name === "A短");
    // 保護 3 分野の wire は script の組 A短 と同じ数。包みとカードは型から組んだ数で、script の 3 × 3,882 と 459 byte の置き値とは違う（成果物に書く）。
    expect(parts).toEqual([ruled?.eew, ruled?.tsunami, ruled?.earthquake]);
    expect(total).toBeLessThanOrEqual(262_144);
  });
});

// 受入条件 P4-DW-AC02（区域の規則）。
describe("P4-DW-T03 acceptance: the area rule", () => {
  it("paints known codes once at the heaviest level, counts duplicates and unknown codes, for EEW, tsunami and earthquake", async () => {
    const eew = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "5-", "5-", "11"], ["632", "4", "4"], ["622", "6-", "6-"], ["998", "7", "7"]] }));
    // U-T の parser は同じコードの重なりを断るので、津波の dupAreas は受理の経路では 0。
    const tsunami = receiveTsunami(emptyTsunami(), decodeXml(vtse41({ at: AT, areas: [{ code: "100", name: "北海道太平洋沿岸東部", kind: "51" },
      { code: "999", name: "不明の区", kind: "51" }, { name: "コードなし", kind: "71" }] }), "VTSE41"), clock(Date.parse(AT) + 1000));
    const city = (code: string, value: string) => `<City><Name>市${code}</Name><Code>${code}</Code><MaxInt>${value}</MaxInt></City>`;
    const quake = receiveQuake(emptyQuake(), decodeXml(vxse53({ at: AT, maxInt: "5-", city: city("0110100", "5-") + city("9999999", "4") }), "VXSE53"), clock(Date.parse(AT) + 1000));
    const result = projected(await wire({ eew: eew.state, tsunami: tsunami.state, quake: quake.state }, [...eew.displayChanges, ...tsunami.displayChanges, ...quake.displayChanges], null));
    const card = result.snapshot.current.eew.wire.cards[0];
    expect(card).toMatchObject({ unknownAreas: 1, dupAreas: 1, letter: "A" });
    expect("rows" in card ? card.rows.map((row) => [row.c, row.t, row.ks]) : null).toEqual([["622", 7, 0], ["632", 4, 0]]);
    expect(result.snapshot.current.eew.wire.composites).toEqual([[["622", 7], ["632", 4]]]);
    const forecast = result.snapshot.current.tsunami.wire.forecasts[0];
    expect(forecast).toMatchObject({ unknownAreas: 1, dupAreas: 0, omittedUnkeyed: 0 });
    expect(forecast.rows.map((row) => [row.c, row.k])).toEqual([["100", "warning"]]);
    expect(forecast.unkeyed.map((row) => row.name.text)).toEqual(["コードなし"]);
    expect(result.snapshot.current.tsunami.wire.composites[0].forecast).toEqual([["100", "warning"]]);
    const composite = result.snapshot.current.earthquake.wire.composites[0];
    expect(composite).toEqual({ areas: [["0110100", 5]], unknownAreas: 1 });
    // 復元の後の view からも同じ結果（保存の中身から作り直した state を、起動の追加として渡す）。
    const restored = (payload: JsonValue) => { const value = tsunamiUnitCodec.decode(payload); if (value.kind !== "restored") throw new Error("restore"); return value.state; };
    const tsunamiBack = reduceTsunamiUnit(emptyTsunami(), { kind: "restore", persisted: (() => { const r = restored(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(tsunami.state)))); return tsunamiUnitCodec.encode(r); })(), clock: clock(Date.parse(AT) + 2000) });
    const quakeDecoded = seismicUnitCodec.decode(JSON.parse(JSON.stringify(seismicUnitCodec.encode(quake.state))));
    if (quakeDecoded.kind !== "restored") throw new Error("restore");
    const quakeBack = reduceSeismicUnit(emptyQuake(), { kind: "restore", persisted: seismicUnitCodec.encode(quakeDecoded.state), clock: clock(Date.parse(AT) + 2000) });
    const again = projected(await wire({ tsunami: tsunamiBack.state, quake: quakeBack.state }, [...tsunamiBack.displayChanges, ...quakeBack.displayChanges], null));
    expect(again.snapshot.current.tsunami.wire.forecasts[0].rows).toEqual(forecast.rows);
    expect(again.snapshot.current.tsunami.wire.composites).toEqual(result.snapshot.current.tsunami.wire.composites);
    expect(again.snapshot.current.earthquake.wire.composites).toEqual(result.snapshot.current.earthquake.wire.composites);
  });
});

// 受入条件 P4-DW-AC10・AC03（合成の引き直しと札の字・7 件目の通常の報）。
describe("P4-DW-T04 acceptance: recomputing the composite and the card letters", () => {
  it("falls back to the next level, keeps −1 apart from no paint, and assigns letters in order", async () => {
    const strong = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "6+", "6+"]] }));
    const weak = eewStep(strong.state, eewXml({ eventId: eewId(2), at: at(1), areas: [["622", "4", "4"], ["632", "不明", "不明"]] }));
    let result = projected(await wire({ eew: weak.state }, [...strong.displayChanges, ...weak.displayChanges], null));
    expect(result.snapshot.current.eew.wire.composites[0]).toEqual([["622", 8], ["632", -1]]);
    expect(result.snapshot.current.eew.wire.cards.map((card) => card.letter)).toEqual(["A", "B"]);
    const cancelled = eewStep(weak.state, eewXml({ eventId: eewId(1), at: at(2), serial: 2, cancel: true }));
    result = projected(await wire({ eew: cancelled.state }, cancelled.displayChanges, result.state));
    expect(result.snapshot.current.eew.wire.composites[0]).toEqual([["622", 4], ["632", -1]]);
    // 空いたら次の字（A が空いても C）、F の次は空いている一番前、0 枚で A から。
    let state = cancelled.state;
    const letters: string[][] = [];
    for (const index of [3, 4, 5, 6]) {
      const next = eewStep(state, eewXml({ eventId: eewId(index), at: at(index), areas: [["752", "3", "3"]] }));
      state = next.state;
      result = projected(await wire({ eew: state }, next.displayChanges, result.state));
      letters.push(result.snapshot.current.eew.wire.cards.map((card) => card.letter));
    }
    expect(letters.at(-1)).toEqual(["B", "C", "D", "E", "F"]);
    const wrap = eewStep(state, eewXml({ eventId: eewId(7), at: at(7), areas: [["752", "3", "3"]] }));
    result = projected(await wire({ eew: wrap.state }, wrap.displayChanges, result.state));
    expect(result.snapshot.current.eew.wire.cards.map((card) => card.letter)).toEqual(["B", "C", "D", "E", "F", "A"]);
  });

  it("puts a seventh normal report on a card by dropping the oldest training card, which then only counts", async () => {
    let state = emptyEew();
    let previous = null;
    const changes: RuntimeDisplayChange[] = [];
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const step = eewStep(state, eewXml({ eventId: eewId(index), at: at(index), status: index <= 2 ? "訓練" : "通常", areas: [["622", "3", "3"]] }));
      state = step.state;
      changes.push(...step.displayChanges);
    }
    let result = projected(await wire({ eew: state }, changes, previous));
    previous = result.state;
    const seventh = eewStep(state, eewXml({ eventId: eewId(7), at: at(7), areas: [["632", "4", "4"]] }));
    result = projected(await wire({ eew: seventh.state }, seventh.displayChanges, previous));
    const wire7 = result.snapshot.current.eew.wire;
    expect(wire7.cards.map((card) => [card.eventId, card.operation])).toEqual([[eewId(2), "training"], [eewId(3), "normal"], [eewId(4), "normal"],
      [eewId(5), "normal"], [eewId(6), "normal"], [eewId(7), "normal"]]);
    expect(wire7.omitted).toBe(1);
    // 訓練は地図に塗らない（P4-DW-D-OPERATION=A）。
    expect(wire7.composites).toEqual([[["622", 3], ["632", 4]]]);
    // 7 件目が訓練の報なら、カードに出ず件数だけ（仮の規則）。
    const eighth = eewStep(seventh.state, eewXml({ eventId: eewId(8), at: at(8), status: "訓練", areas: [["752", "5-", "5-"]] }));
    result = projected(await wire({ eew: eighth.state }, eighth.displayChanges, result.state));
    expect(result.snapshot.current.eew.wire.omitted).toBe(2);
    expect(result.snapshot.current.eew.wire.cards).toHaveLength(6);
  });
});

describe("P4-DW-T04 acceptance: normal reports first when the tsunami and long-period slots are full", () => {
  it("puts a normal tsunami EventID and a normal long period before training ones, and counts the dropped ones", async () => {
    // 津波: 訓練の大津波警報 3 件の後の通常の注意報は行に入り、最も古い訓練の 1 件が件数になる（spec:1636 を当てる、統合担当の決め）。
    let tsunami = emptyTsunami();
    const changes: RuntimeDisplayChange[] = [];
    for (const [index, operation, kind] of [[1, "training", "52"], [2, "training", "52"], [3, "training", "52"], [4, "normal", "62"]] as const) {
      const step = receiveTsunami(tsunami, decodeXml(vtse41({ eventId: `2099010100000${index}`, at: at(index), operation, areas: [{ code: "100", name: "区", kind }] }), "VTSE41"),
        clock(Date.parse(at(index)) + 1000));
      tsunami = step.state;
      changes.push(...step.displayChanges);
    }
    const wired = projected(await wire({ tsunami }, changes, null)).snapshot.current.tsunami.wire;
    expect(wired.forecasts.map((item) => [item.eventId, item.operation])).toEqual([["20990101000004", "normal"], ["20990101000003", "training"], ["20990101000002", "training"]]);
    expect(wired.omittedEvents).toBe(1);
    // 長周期: 新しい訓練の 2 件より古い通常の 1 件が先に入る。
    const lpMaterial = decodeFixture("synthetic_phase4a_VXSE62_special");
    const quake = receiveQuake(emptyQuake(), lpMaterial, clock(Date.parse(lpMaterial.reportDateTimeRaw) + 1000));
    const found = quake.displayChanges.find((item) => item.after?.unit === "U-Q" && item.after.current != null && !("sources" in item.after.current))?.after;
    if (found?.unit !== "U-Q" || found.current == null || "sources" in found.current) throw new Error("no long period");
    const template = found.current;
    const long = (index: number, operation: "normal" | "training"): RuntimeDisplayChange => {
      const subject = `${operation}/VXSE62/L${index}`;
      const current = { ...template, subject, eventId: `L${index}`, operation, source: { ...template.source, operation, subject, reportDateTimeRaw: at(index) } };
      return { unit: "U-Q", operation, subject, before: null, after: { ...found, operation, subject, current } };
    };
    const longs = projected(await wire({ quake: quake.state }, [long(1, "normal"), long(2, "training"), long(3, "training")], null)).snapshot.current.earthquake.wire;
    expect(longs.longPeriods.map((item) => [item.eventId, item.operation])).toEqual([["L1", "normal"], ["L3", "training"]]);
    expect(longs.omittedLongPeriods).toBe(1);
  });
});

describe("P4-DW-T04 acceptance: one card per EventID, refill, expiry and eviction", () => {
  it("shows one card for the VXSE45 and VXSE43 of the same EventID with the newer report", async () => {
    const forecast = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, family: "VXSE45", areas: [["622", "3", "3"]] }), "VXSE45");
    const warning = eewStep(forecast.state, eewXml({ eventId: eewId(1), at: at(1), family: "VXSE43", areas: [["622", "5-", "5-"], ["632", "4", "4"]] }));
    expect(warning.state.current).toHaveLength(2);
    const wired = projected(await wire({ eew: warning.state }, [...forecast.displayChanges, ...warning.displayChanges], null)).snapshot.current.eew.wire;
    expect(wired.cards.map((card) => [card.letter, card.warning, "rows" in card ? card.rows.length : -1])).toEqual([["A", true, 2]]);
    expect(wired.omitted).toBe(0);
  });

  it("puts a waiting normal report on the card freed by a cancel, first come first", async () => {
    let state = emptyEew();
    const changes: RuntimeDisplayChange[] = [];
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const step = eewStep(state, eewXml({ eventId: eewId(index), at: at(index), areas: [["622", "3", "3"]] }));
      state = step.state;
      changes.push(...step.displayChanges);
    }
    let result = projected(await wire({ eew: state }, changes, null));
    expect([result.snapshot.current.eew.wire.cards.length, result.snapshot.current.eew.wire.omitted]).toEqual([6, 2]);
    const cancel = eewStep(state, eewXml({ eventId: eewId(2), at: at(20), serial: 2, cancel: true }));
    result = projected(await wire({ eew: cancel.state }, cancel.displayChanges, result.state));
    expect(result.snapshot.current.eew.wire.cards.map((card) => [card.eventId, card.letter])).toEqual([[eewId(1), "A"], [eewId(3), "C"], [eewId(4), "D"],
      [eewId(5), "E"], [eewId(6), "F"], [eewId(7), "B"]]);
    expect(result.snapshot.current.eew.wire.omitted).toBe(1);
  });

  it("falls back to the next level when the strongest EEW expires", async () => {
    const strong = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "6+", "6+"]] }));
    const weak = eewStep(strong.state, eewXml({ eventId: eewId(2), at: at(30), areas: [["622", "4", "4"]] }));
    let result = projected(await wire({ eew: weak.state }, [...strong.displayChanges, ...weak.displayChanges], null));
    const expired = reduceEewUnit(weak.state, { kind: "deadline", clock: { wallTimeMs: Date.parse(AT) + 600_000 + 10, monotonicMs: 0 } });
    expect(expired.state.current.map((item) => item.eventId)).toEqual([eewId(2)]);
    result = projected(await wire({ eew: expired.state }, expired.displayChanges, result.state));
    expect(result.snapshot.current.eew.wire.composites).toEqual([[["622", 4]]]);
  });

  it("removes the card of a training EEW evicted for capacity and lets the normal report in", async () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: eewId(0), at: AT, status: "訓練", areas: [["622", "3", "3"]] }));
    const template = first.state.current[0], gate = first.state.gates[0];
    const ids = Array.from({ length: 512 }, (_, index) => eewId(index));
    const current = ids.map((id) => ({ ...template, eventId: id, subject: `training/VXSE43/${id}`, source: { ...template.source, subject: `training/VXSE43/${id}` } }));
    const full = { ...first.state, current, gates: current.map((item) => ({ ...gate, subject: item.subject, source: item.source })) };
    let result = projected(await wire({ eew: full }, current.map((item) => eewChange(null, item)), null));
    expect([result.snapshot.current.eew.wire.cards.length, result.snapshot.current.eew.wire.omitted]).toEqual([6, 506]);
    const normal = eewStep(full, eewXml({ eventId: "20990101009999", at: at(5), areas: [["632", "4", "4"]] }));
    expect(normal.displayChanges.some((change) => change.after == null)).toBe(true);
    result = projected(await wire({ eew: normal.state }, normal.displayChanges, result.state));
    const cards = result.snapshot.current.eew.wire.cards;
    expect(cards.some((card) => card.operation === "normal")).toBe(true);
    expect(cards).toHaveLength(6);
    expect(result.snapshot.current.eew.wire.composites).toEqual([[["632", 4]]]);
  });
});

// 契約の境界 P4-DW-AC05（P2-A8-COST の継承の計数と受信経路の計算量）。
describe("P4-DW-T02 contractBoundary: the work per update", () => {
  it("reads only the changed subject's areas near capacity, for EEW, earthquake and tsunami", async () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "5-", "5-"], ["632", "4", "4"], ["752", "3", "3"]] }));
    const template = first.state.current[0];
    const clones: EewCurrent[] = Array.from({ length: 511 }, (_, index) => ({ ...template, eventId: eewId(index), subject: `normal/VXSE43/${eewId(index)}` }));
    let result = projected(await wire({ eew: { ...first.state, current: clones } }, clones.map((item) => eewChange(null, item)), null));
    const updated: EewCurrent = { ...clones[5], prediction: { ...clones[5].prediction, areas: clones[5].prediction.areas.slice(0, 1) },
      reportAreas: clones[5].reportAreas.slice(0, 1) };
    const step1 = await wire({ eew: { ...first.state, current: clones.map((item) => item === clones[5] ? updated : item) } }, [eewChange(clones[5], updated)], result.state);
    // (1) 変わった subject の before 3 区域と after 1 区域、(2) 参照数が変わった 3 区域、(3) 配列を 1 回組む。ほかの EEW の区域は読まない。
    expect(step1.counts.eew).toEqual({ read: 4, recomputed: 3, built: 1, hashed: 1 });
    const remaining = clones.map((item) => item === clones[5] ? updated : item).filter((item) => item !== clones[6]);
    const step2 = await wire({ eew: { ...first.state, current: remaining } }, [eewChange(clones[6], null)], step1.state);
    expect(step2.counts.eew).toEqual({ read: 3, recomputed: 3, built: 1, hashed: 0 });
    // metadata だけ（表示差分なし）は内容を読まない。
    const step3 = await wire({ eew: { ...first.state, current: remaining } }, [], step2.state);
    expect(step3.counts.eew).toEqual({ read: 0, recomputed: 0, built: 0, hashed: 0 });
    expect(step3.kind).toBe("unchanged");
    result = projected(step2);
    expect(result.snapshot.current.eew.wire.composites[0]).toEqual([["622", 5], ["632", 4], ["752", 3]]);

    const quake = receiveQuake(emptyQuake(), decodeFixture("32-35_01_03_240613_VXSE53"), clock(Date.parse("2009-10-01T13:51:00+09:00")));
    const change = quake.displayChanges.find((item) => item.after?.unit === "U-Q" && "sources" in (item.after.current ?? {}));
    if (change?.after?.unit !== "U-Q" || change.after.current == null || !("sources" in change.after.current)) throw new Error("no event");
    const event: EarthquakeEventView = change.after.current, items = event.intensity?.items.length ?? 0;
    const eventChange = (before: EarthquakeEventView | null, after: EarthquakeEventView | null): RuntimeDisplayChange => {
      const one = (item: EarthquakeEventView) => ({ unit: "U-Q" as const, operation: item.operation, subject: item.subject, office: null, current: item, subjects: [] });
      const value = (after ?? before)!;
      return { unit: "U-Q", operation: value.operation, subject: value.subject, before: before == null ? null : one(before), ...(after == null ? { after: null, removal: "unknown" as const } : { after: one(after) }) };
    };
    const events = Array.from({ length: 1023 }, (_, index): EarthquakeEventView => ({ ...event, operation: "normal", subject: `normal/earthquake/E${index}`, eventId: `E${index}` }));
    const filled = await wire({ quake: quake.state }, events.map((item) => eventChange(null, item)), null);
    const moved = await wire({ quake: quake.state }, [eventChange(events[9], null)], filled.state);
    const keyed = event.intensity?.items.filter((item) => item.code != null && (item.level === "city" || item.level === "area")).length ?? 0;
    expect(items).toBeGreaterThan(0);
    // 読むのは消えた 1 件の塗りだけで、event の数に比例しない。
    expect(moved.counts.earthquake.read).toBeLessThanOrEqual(keyed);
    expect(moved.counts.earthquake.recomputed).toBeLessThanOrEqual(keyed);

    const forecast = receiveTsunami(emptyTsunami(), decodeXml(vtse41({ at: AT, areas: [{ code: "100", name: "区", kind: "51" }, { code: "101", name: "区", kind: "62" }] }), "VTSE41"), clock(Date.parse(AT) + 1000));
    const record = forecast.displayChanges[0].after;
    if (record?.unit !== "U-T" || record.current == null) throw new Error("no forecast");
    const one = record.current;
    const tsunamiChanges = Array.from({ length: 511 }, (_, index): RuntimeDisplayChange => ({ unit: "U-T", operation: "normal", subject: `normal/VTSE41/T${index}`,
      before: null, after: { ...record, subject: `normal/VTSE41/T${index}`, current: { ...one, subject: `normal/VTSE41/T${index}` } } }));
    const tsunamiFilled = await wire({ tsunami: forecast.state }, tsunamiChanges, null);
    const tsunamiMoved = await wire({ tsunami: forecast.state }, [{ ...tsunamiChanges[3], before: tsunamiChanges[3].after, after: null, removal: "unknown" as const }], tsunamiFilled.state);
    expect(tsunamiMoved.counts.tsunami.read).toBe(2 + 0);
    expect(tsunamiMoved.counts.tsunami.recomputed).toBe(0 + 2);
  });

  it("keeps the closed marks from the changed records, without reading every expired record on each view", () => {
    const source = (index: number): ReportRef => ({ inputId: `input-${index}`, origin: "replay", operation: "normal", family: "VTSE51",
      subject: `normal/tsunamiObservation:VTSE51/E${index}`, reportDateTimeRaw: AT, controlDateTimeRaw: AT, serialRaw: "1", infoTypeRaw: "発表" });
    let reads = 0;
    const counted = (index: number): TsunamiObservationSubject => {
      const record = { subject: `normal/tsunamiObservation:VTSE51/E${index}`, eventId: `E${index}`, operation: "normal" as const, family: "VTSE51" as const,
        source: source(index), controlDateTimeRaw: AT, effective: "expired" as const, stations: [], estimations: [], validUntil: null, retainUntil: 0 };
      // 閉じた時刻（retainUntil）を読むたびに数える。
      Object.defineProperty(record, "retainUntil", { get: () => { reads++; return Date.parse(AT) + 604_800_000 + index * 1000; }, enumerable: true });
      return record;
    };
    const live = receiveTsunami(emptyTsunami(), decodeXml(observation({ at: AT, serial: 1, stations: [{ code: "21001", height: "0.3" }] }), "VTSE51"), clock(Date.parse(AT) + 1000));
    const base = { ...live.state, observations: [...Array.from({ length: 50 }, (_, index) => counted(index)), ...live.state.observations] };
    toTsunamiView(base);
    reads = 0;
    const validUntil = live.state.observations[0].validUntil!;
    // step の中の期限の回収は既存の走査で期限切れの記録を読む（P3 の reducer）。数えるのは view を作るときの読み直し。
    const closed = reduceTsunamiUnit(base, { kind: "deadline", clock: clock(validUntil + 1), basis: "verified" });
    reads = 0;
    const view = toTsunamiView(closed.state);
    toTsunamiView(closed.state);
    toTsunamiView(closed.state);
    // 3 回の view で、閉じた印のために期限切れの記録を読み直さない（変わった 1 件は step の中で足し引きした）。
    expect(reads).toBe(0);
    expect(view.closedObservations.normal.items[0]).toEqual({ eventId: "20990101000011", family: "VTSE51", closedAt: validUntil });
    expect(view.closedObservations.normal.omitted).toBe(47);
  });

  it("reads only the closed marks the unit listed, however many records expired", async () => {
    const source = (index: number): ReportRef => ({ inputId: `input-${index}`, origin: "replay", operation: "normal", family: "VTSE51",
      subject: `normal/tsunamiObservation:VTSE51/E${index}`, reportDateTimeRaw: AT, controlDateTimeRaw: AT, serialRaw: "1", infoTypeRaw: "発表" });
    const expired = Array.from({ length: 50 }, (_, index): TsunamiObservationSubject => ({ subject: `normal/tsunamiObservation:VTSE51/E${index}`, eventId: `E${index}`,
      operation: "normal", family: "VTSE51", source: source(index), controlDateTimeRaw: AT, effective: "expired", stations: [], estimations: [], validUntil: null,
      retainUntil: Date.parse(AT) + index * 1000 + 604_800_000 }));
    const result = projected(await wire({ tsunami: { ...emptyTsunami(), observations: expired } }, [], null));
    expect(result.snapshot.current.tsunami.wire.closed[0].items.map((item) => item.eventId)).toEqual(["E49", "E48", "E47", "E46"]);
    expect(result.snapshot.current.tsunami.wire.closed[0].omitted).toBe(46);
    expect(result.counts.tsunami.read).toBe(4);
  });
});

// 実際の不具合の再発防止 P4-DW-AC07（表 §1.6 の 2 件）。
describe("P4-DW-T05 regression: values that did not reach the screen", () => {
  it("re-emits the tsunami view when an observation waiting for the clock expires and when its record is deleted", () => {
    const start = Date.parse(AT);
    const adopted = receiveTsunami(emptyTsunami(), decodeXml(observation({ at: AT, serial: 1, stations: [{ code: "21001", height: "0.3" }] }), "VTSE51"), clock(start + 1000));
    const validUntil = adopted.state.observations[0].validUntil!;
    const pending = reduceTsunamiUnit(adopted.state, { kind: "deadline", clock: clock(validUntil + 1), basis: "unverified" });
    expect(pending.state.observations[0].expiryPending).toBe(true);
    const closed = reduceTsunamiUnit(pending.state, { kind: "deadline", clock: clock(validUntil + 2), basis: "verified" });
    expect(closed.displayChanges).toEqual([]);
    expect(closed.state.contentRevision).toBe(pending.state.contentRevision + 1);
    expect(toTsunamiView(closed.state).closedObservations.normal.items).toEqual([{ eventId: "20990101000011", family: "VTSE51", closedAt: validUntil }]);
    const deleted = reduceTsunamiUnit(closed.state, { kind: "deadline", clock: clock(closed.state.observations[0].retainUntil! + 1), basis: "verified" });
    expect(deleted.state.contentRevision).toBe(closed.state.contentRevision + 1);
    expect(toTsunamiView(deleted.state).closedObservations.normal).toEqual({ items: [], omitted: 0 });
  });

  it("re-emits the U-T view from the owner when only the closed set changes", () => {
    const owner = restoreOwner({ runId: "run", place: "urgent", clock: { wallTimeMs: Date.parse(AT), monotonicMs: 1 }, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const xml = observation({ at: AT, serial: 1, stations: [{ code: "21001", height: "0.3" }] });
    const decoded = decodeXml(xml, "VTSE51");
    const received = receiveOwner(owner, { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } }, { wallTimeMs: Date.parse(AT) + 1000, monotonicMs: 2 }, linkedUnitTable);
    const validUntil = received.state.units["U-T"]!.observations[0].validUntil!;
    const pending = deadlineOwner(received.state, { wallTimeMs: validUntil + 1, monotonicMs: 3 }, linkedUnitTable, "unverified");
    const closed = deadlineOwner(pending.state, { wallTimeMs: validUntil + 2, monotonicMs: 4 }, linkedUnitTable, "verified");
    const view = closed.views.find((item) => item.unit === "U-T");
    expect(view?.unit === "U-T" ? view.closedObservations.normal.items.length : -1).toBe(1);
  });

  it("keeps the unconfirmed mark on the current when a timed report is adopted after a held one without a readable time", () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "4", "4"]] }));
    const untimed = eewXml({ eventId: eewId(1), at: AT, serial: 2, areas: [["622", "5-", "5-"]] }).replace(/<DateTime>[^<]*<\/DateTime>/, "<DateTime></DateTime>");
    const held = eewStep(first.state, untimed);
    expect(held.decisions[0]).toMatchObject({ decision: "unchanged" });
    expect(held.state.current[0].unconfirmed).toBeDefined();
    const adopted = eewStep(held.state, eewXml({ eventId: eewId(1), at: at(3), serial: 3, areas: [["622", "5+", "5+"]] }));
    expect(adopted.decisions[0]).toMatchObject({ decision: "changed" });
    expect(adopted.state.gates[0].unconfirmed).toBeDefined();
    expect(adopted.state.current[0].unconfirmed).toBe(adopted.state.gates[0].unconfirmed);
    const after = adopted.displayChanges[0].after;
    expect(after?.unit === "U-E" ? after.current?.unconfirmed : null).toBe(adopted.state.gates[0].unconfirmed);
  });

  it("copies the unconfirmed mark of a held EEW report to its current with a display change, keeping the decision and the version", () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "4", "4"]] }));
    const held = eewStep(first.state, eewXml({ eventId: eewId(1), at: AT, areas: [["622", "5-", "5-"]] }));
    expect(held.decisions[0]).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(held.state.current[0].source).toBe(first.state.current[0].source);
    expect(held.state.current[0].unconfirmed).toBeDefined();
    expect(held.displayChanges).toHaveLength(1);
    expect(held.state.contentRevision).toBe(first.state.contentRevision + 1);
  });
});

// 受入条件 P4-DW-AC09（EEW と今日の地震の行に足す値）。
describe("P4-DW-T09 acceptance: values added to the EEW card and the quake rows", () => {
  const detect = (edit: (xml: string) => string = (xml) => xml) => {
    const xml = edit(fixture("77_01_01_240613_VXSE45").replace(/<OriginTime>[^<]*<\/OriginTime>/, "")
      .replace("</Intensity>", "</Intensity><Text>最大予測震度のみ\n石川県能登地方　　震度５弱程度以上</Text>"));
    return eewStep(emptyEew(), xml, "VXSE45").state.current[0];
  };
  it("sets detectOnly only when all six conditions hold, and cuts the place out of the second line", async () => {
    const only = detect();
    expect([only.detectOnly, only.place]).toEqual([true, "石川県能登地方"]);
    expect(detect((xml) => xml.replace("<Text>最大予測震度のみ\n石川県能登地方　　震度５弱程度以上</Text>", "")).detectOnly).toBe(false);
    expect(detect((xml) => xml.replace("</Hypocenter>", "</Hypocenter>").replace("<ArrivalTime>", "<OriginTime>2024-04-17T23:14:47+09:00</OriginTime><ArrivalTime>")).detectOnly).toBe(false);
    expect(detect((xml) => xml.replace("</ForecastLgInt>", "</ForecastLgInt><Pref><Name>石川</Name><Code>9170</Code><Area><Name>石川県能登</Name><Code>390</Code><ForecastInt><From>5-</From><To>5-</To></ForecastInt></Area></Pref>")).detectOnly).toBe(false);
    const asVxse43 = eewStep(emptyEew(), fixture("77_01_01_240613_VXSE45").replace(/<OriginTime>[^<]*<\/OriginTime>/, "").replace("</Intensity>", "</Intensity><Text>a\nb c</Text>"), "VXSE43");
    expect(asVxse43.state.current[0]?.detectOnly ?? false).toBe(false);
    // P4-ENI-AC04 (2)・AC01 (7): OriginTime が無く Text のある Intensity の無い報は current を作るが、detectOnly は偽・place は null（台帳 98）。
    expect([detect((xml) => xml.replace(/<Intensity>[\s\S]*<\/Intensity>/, "")).detectOnly, detect((xml) => xml.replace(/<Intensity>[\s\S]*<\/Intensity>/, "")).place]).toEqual([false, null]);
    // 非取消: 取消の報は current を作らない。Intensity はあるが全体の ForecastInt が無い報も受理しない（台帳 98 は別の契約）。
    expect(eewStep(emptyEew(), fixture("77_01_01_240613_VXSE45").replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"), "VXSE45").state.current).toEqual([]);
    expect(eewStep(emptyEew(), fixture("77_01_01_240613_VXSE45").replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, ""), "VXSE45").state.current).toEqual([]);
    // 2 行目が空白で始まると、切り出した字が空なので null。192 byte を越える場所の文は wire で切って印を付ける。
    expect(detect((xml) => xml.replace("石川県能登地方　　震度５弱程度以上", "　　震度５弱程度以上")).place).toBeNull();
    const longPlace = detect((xml) => xml.replace("石川県能登地方　　", `${"能".repeat(80)}　　`));
    expect(longPlace.place).toBe("能".repeat(80));
    const longCard = projected(await wire({ eew: { ...emptyEew(), current: [longPlace] } }, [eewChange(null, longPlace)], null)).snapshot.current.eew.wire.cards[0];
    expect(longCard.place).toEqual({ text: "能".repeat(64), cut: true });
    expect(detect((xml) => xml.replace("\n石川県能登地方　　震度５弱程度以上", "")).place).toBeNull();
    expect(detect((xml) => xml.replace("石川県能登地方　　震度５弱程度以上", "石川県能登地方")).place).toBeNull();
    // 仮定震源の報は M と深さを出さない。
    const assumed = eewStep(emptyEew(), eewXml({ eventId: eewId(1), at: AT, areas: [["622", "4", "4"]],
      body: (body) => body.replace("<OriginTime>", "<Condition>仮定震源要素</Condition><OriginTime>") }));
    const header = projected(await wire({ eew: assumed.state }, assumed.displayChanges, null)).snapshot.current.eew.wire.cards[0];
    expect([header.assumed, header.mag, header.depth, header.hypo?.text]).toEqual([true, null, null, "豊後水道"]);
  });

  it("carries depth, magnitude description and the tsunami comment on a VXSE53 row", async () => {
    const quake = receiveQuake(emptyQuake(), decodeFixture("32-35_01_03_240613_VXSE53"), clock(Date.parse("2009-10-01T13:51:00+09:00")));
    const row = projected(await wire({ quake: quake.state }, quake.displayChanges, null)).snapshot.current.earthquake.wire.rows[0];
    const recent: SeismicRecentQuake = quake.state.daily.training.recent[0];
    expect(row).toMatchObject({ operation: "training", depth: { v: recent.depth.kind === "missing" ? "" : recent.depth.raw },
      mag: { desc: recent.magnitudeDescription }, tsunami: { text: recent.tsunamiComment, cut: false }, strongest: [], omittedStrongest: 0 });
    expect(recent.tsunamiComment).not.toBeNull();
    expect(row.ref.rev).not.toBeNull();
  });
});

// 契約の境界 P4-DW-AC16（U-Q の保存の版）。
describe("P4-DW-T12 contractBoundary: the U-Q save version", () => {
  const filled = () => {
    const quake = receiveQuake(emptyQuake(), decodeFixture("32-35_01_03_240613_VXSE53"), clock(Date.parse("2009-10-01T13:51:00+09:00")));
    const wide = (n: number) => "\u0001".repeat(n);
    const row: SeismicRecentQuake = { ...quake.state.daily.training.recent[0], depth: { kind: "text", value: wide(32), raw: wide(32) },
      magnitudeDescription: wide(32), tsunamiComment: wide(128), strongest: Array.from({ length: 8 }, () => "99999999"), omittedStrongest: Number.MAX_SAFE_INTEGER, tsunamiCodes: Array.from({ length: 4 }, () => "9999"), omittedTsunamiCodes: Number.MAX_SAFE_INTEGER };
    return { ...quake.state, daily: { ...quake.state.daily, training: { ...quake.state.daily.training, recent: [row] } } };
  };
  const roundTrip = (payload: unknown) => seismicUnitCodec.decode(JSON.parse(JSON.stringify(payload)));
  it("round-trips a row whose new fields are full, refuses one over each limit and the v8 save, and grows by the script's amount", () => {
    const state = filled();
    const decoded = roundTrip(seismicUnitCodec.encode(state));
    if (decoded.kind !== "restored") throw new Error(decoded.reason);
    expect(decoded.state.daily).toEqual(state.daily);
    const encoded = seismicUnitCodec.encode(state);
    const over = (edit: (row: Record<string, unknown>) => Record<string, unknown>) => {
      const daily = JSON.parse(JSON.stringify(encoded.daily));
      daily.training.recent[0] = edit(daily.training.recent[0]);
      return roundTrip({ ...encoded, daily }).kind;
    };
    expect(over((row) => ({ ...row, magnitudeDescription: "a".repeat(33) }))).toBe("invalid");
    expect(over((row) => ({ ...row, tsunamiComment: "a".repeat(129) }))).toBe("invalid");
    expect(over((row) => ({ ...row, strongest: Array.from({ length: 9 }, () => "1") }))).toBe("invalid");
    expect(over((row) => ({ ...row, strongest: ["123456789"] }))).toBe("invalid");
    expect(over((row) => ({ ...row, depth: { kind: "text", value: "a", raw: "a".repeat(33) } }))).toBe("invalid");
    expect(over((row) => ({ ...row, omittedStrongest: -1 }))).toBe("invalid");
    expect(roundTrip({ ...encoded, schemaVersion: "p3-seismic-unit-v8" }).kind).toBe("invalid");
    // 増え分は 1 字 6 byte で数えた 7 欄の上限いっぱい（script の seismicRecent）と同じ。
    const row = state.daily.training.recent[0];
    const { depth, magnitudeDescription, tsunamiComment, strongest, omittedStrongest, tsunamiCodes, omittedTsunamiCodes, ...rest } = row;
    const added = Buffer.byteLength(JSON.stringify(row)) - Buffer.byteLength(JSON.stringify(rest));
    const script: unknown = JSON.parse(execFileSync(process.execPath, ["reconstruction/contracts/p4-display-wire-max.mjs"], { encoding: "utf8" }));
    const recent = typeof script === "object" && script != null && "seismicRecent" in script ? script.seismicRecent : null;
    expect(recent).toEqual({ perRow: added, baseRow: 2_310, rows: 27, reservedRows: 15, reservedRow: 1_206, growth: 27 * (added + 2_310) - 15 * 1_206 });
    expect(toSeismicView(state).daily.training.recent[0].strongest).toHaveLength(8);
  });
});
