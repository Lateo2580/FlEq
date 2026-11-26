import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { SeismicRecentQuake, SeismicUnitState } from "../../contracts/p3-seismic-unit.types";
import { seismicUnitCodec } from "../../src/units/seismic/seismic-unit";
import { projected, wire } from "../display-wire/display-wire-fixture";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, vxse53 } from "./seismic-fixture";

// P4-UQ-QUAKE-ROWS-001 の試験（T01〜T03）。

const t = (hm: string) => `2026-11-26T${hm}:00+09:00`;
const reportMs = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]);
const ids = (state: SeismicUnitState) => state.daily.normal.recent.map((row) => row.eventId);
const noOrigin = (xml: string) => xml.replace(/<OriginTime>[^<]*<\/OriginTime>/, "");
const take = (state: SeismicUnitState, xml: string, origin: "replay" | "recovery" = "replay") =>
  receive(state, decodeXml(xml, "VXSE53", undefined, origin), clock(reportMs(xml))).state;
// 震度速報は実の VXSE51 の EventID・ReportDateTime・TargetDateTime を替えた字。
const s51 = (state: SeismicUnitState, eventId: string, report: string, target: string) => {
  const material = decodeFixture("32-35_01_01_260824_VXSE51", (xml) => replaceTag("TargetDateTime", target)(replaceTag("ReportDateTime", report)(replaceTag("EventID", eventId)(xml))));
  return receive(state, material, clock(Date.parse(report))).state;
};
const quake = (eventId: string, at: string, origin: string, serial = 1, infoType?: "訂正" | "取消") => vxse53({ eventId, at, origin, serial, infoType });
const feed = (state: SeismicUnitState, ...xmls: string[]) => xmls.reduce((current, xml) => take(current, xml), state);

describe("P4-UQ-QUAKE-ROWS-001", () => {
  // 受入条件 P4-UQR-AC01・AC07: 表 §3 の 1〜14 の列で行が発生の新しい順に並び、9 行に入らない地震で recent を作り替えない。
  it("P4-UQR-T01 acceptance / AC01・AC07: rows follow the table §3 order", () => {
    const [A, B, C, D, H] = ["20261126080000", "20261126090000", "20261126100000", "20261126110500", "20261126103100"];
    const one = feed(emptyState(), quake(C, t("10:02"), t("10:00")), quake(A, t("10:03"), t("08:00")), quake(B, t("10:04"), t("09:00")));
    expect(ids(one)).toEqual([C, B, A]); // 1
    const two = take(one, quake(A, t("13:30"), t("08:00"), 2, "訂正"));
    expect([ids(two), two.daily.normal.recent[2].reportDateTimeRaw]).toEqual([[C, B, A], t("13:30")]); // 2
    expect(ids(take(one, quake(A, t("13:30"), t("09:30"), 2, "訂正")))).toEqual([C, A, B]); // 3
    const four = take(one, noOrigin(quake(D, t("11:05"), t("11:05"))));
    expect(ids(four)).toEqual([D, C, B, A]); // 4
    expect(ids(take(four, quake(D, t("11:20"), t("09:45"), 2)))).toEqual([C, D, B, A]); // 5
    const fiveDash = take(four, noOrigin(quake(D, t("11:20"), t("11:20"), 2)));
    expect([ids(fiveDash), fiveDash.daily.normal.recent[0].reportDateTimeRaw]).toEqual([[D, C, B, A], t("11:20")]); // 5'
    const flash = s51(one, H, t("10:32"), t("10:31"));
    expect(ids(flash)).toEqual([H, C, B, A]); // 5''
    expect(ids(take(flash, quake(H, t("10:40"), t("09:58"))))).toEqual([C, H, B, A]);
    const [E, F] = ["20261126100001", "20261126100005"];
    expect(ids(feed(emptyState(), quake(F, t("10:01"), t("10:00")), quake(E, t("10:02"), t("10:00"))))).toEqual([F, E]); // 6
    expect(ids(feed(emptyState(), quake(E, t("10:01"), t("10:00")), quake(F, t("10:02"), t("10:00"))))).toEqual([F, E]);

    const Q = Array.from({ length: 11 }, (_, index) => `202611260${String(index).padStart(2, "0")}000`);
    const nine = feed(emptyState(), ...Q.slice(1, 10).map((id, index) => quake(id, t(`0${index + 1}:01`), t(`0${index + 1}:00`))));
    const desc = (...indexes: number[]) => indexes.map((index) => Q[index]);
    expect(ids(nine)).toEqual(desc(9, 8, 7, 6, 5, 4, 3, 2, 1));
    const seven = take(nine, quake(Q[0], t("09:10"), t("00:30")));
    expect(seven.daily.normal.recent).toBe(nine.daily.normal.recent); // 7
    expect(seven.daily.normal.count).toBe(nine.daily.normal.count + 1);
    expect(ids(take(seven, quake(Q[10], t("09:31"), t("09:30"))))).toEqual(desc(10, 9, 8, 7, 6, 5, 4, 3, 2)); // 8
    expect(take(seven, quake(Q[0], t("09:20"), t("00:30"), 2, "訂正")).daily.normal.recent).toBe(seven.daily.normal.recent); // 9
    expect(ids(take(seven, quake(Q[0], t("09:20"), t("05:30"), 2, "訂正")))).toEqual(desc(9, 8, 7, 6, 0, 5, 4, 3, 2)); // 10
    expect(take(seven, quake(Q[0], t("09:20"), t("00:30"), 2, "取消")).daily.normal.recent).toBe(seven.daily.normal.recent); // 11
    const h11 = feed(seven, quake(H, t("09:40"), t("00:30")));
    const h11b = s51(h11, H, t("10:32"), t("10:31"));
    expect(ids(h11b)).toEqual(desc(9, 8, 7, 6, 5, 4, 3, 2, 1));
    expect(ids(take(h11b, quake(H, t("10:40"), t("00:30"), 2, "取消")))).toEqual([H, ...desc(9, 8, 7, 6, 5, 4, 3, 2)]); // 11'
    const twelve = take(seven, quake(Q[5], t("09:20"), t("05:00"), 2, "取消"));
    expect([ids(twelve), twelve.daily.normal.recent[4].cancelled]).toEqual([desc(9, 8, 7, 6, 5, 4, 3, 2, 1), true]); // 12
    const q5 = take(s51(seven, Q[5], t("09:41"), t("09:40")), quake(Q[5], t("09:50"), t("05:00"), 2, "取消"));
    expect([ids(q5), q5.daily.normal.recent[0].cancelled]).toEqual([desc(5, 9, 8, 7, 6, 4, 3, 2, 1), false]); // 12'
    expect(ids(take(seven, quake(Q[9], t("09:20"), t("00:10"), 2, "訂正")))).toEqual(desc(8, 7, 6, 5, 4, 3, 2, 1, 9)); // 13

    const G = "20261126000100";
    const g = take(emptyState(), noOrigin(quake(G, t("00:01"), t("00:01"))));
    const long = "2026-11-25T23:59:00.0000000000000000+09:00";
    for (const origin of ["2026-11-25T23:59:00+09:00", long]) // 14・14'
      expect(take(g, quake(G, t("00:02"), origin, 2)).daily.normal.recent).toEqual(g.daily.normal.recent);
    const late = quake(G, t("00:02"), long, 2);
    const normal = take(emptyState(), late).daily.normal, recovery = take(emptyState(), late, "recovery").daily.normal;
    expect([normal.count, normal.recent.length, recovery.count, recovery.recent.length]).toEqual([1, 0, 0, 0]); // 14''
    // AC01 (2): 今日の時刻でも 40 字を超える発生時刻は今日の判定を通さない（通すと行の発生時刻が null になり報の時刻で並ぶ）。
    expect(take(emptyState(), quake(G, t("00:02"), "2026-11-26T00:01:00.0000000000000000+09:00")).daily.normal.recent).toEqual([]);
    // 時差の無い発生時刻は機械のタイムゾーンで読まれるので、今日の時刻でも判定を通さない（並びと復元が process に依らない）。
    expect(take(emptyState(), quake(G, t("12:01"), "2026-11-26T12:00:00")).daily.normal.recent).toEqual([]);
  });

  // 契約境界 P4-UQR-AC02・AC04: 保存の版 v10 と、行の欄・行の数・並び・EventID の一意の境界。
  it("P4-UQR-T02 contractBoundary / AC02・AC04: v10 round trip at the limits and refusals", () => {
    const row = (index: number): SeismicRecentQuake => ({ eventId: `2026112600000${index}`, originTimeRaw: t(`0${index}:00`), reportDateTimeRaw: t(`0${index}:01`),
      hypocenterName: "合成震央", magnitude: { kind: "missing" }, maxInt: { kind: "missing" }, cancelled: false, depth: { kind: "missing" }, magnitudeDescription: null,
      tsunamiComment: null, strongest: [], omittedStrongest: 0, tsunamiCodes: ["9999", "9999", "9999", "9999"], omittedTsunamiCodes: Number.MAX_SAFE_INTEGER });
    const rows = (...indexes: number[]) => indexes.map(row);
    const history = { dayKey: "2026-11-26", count: 9, maxInt: null, counted: [], recent: rows(8, 7, 6, 5, 4, 3, 2, 1, 0) };
    const state: SeismicUnitState = { ...emptyState(), daily: { normal: history, training: history, test: history } };
    const payload = JSON.parse(JSON.stringify(seismicUnitCodec.encode(state))) as Record<string, JsonValue>;
    const decoded = seismicUnitCodec.decode(payload as JsonValue);
    if (decoded.kind !== "restored") throw new Error(decoded.reason);
    expect(decoded.state.daily).toEqual(state.daily);
    const withRecent = (recent: unknown[]) => seismicUnitCodec.decode(JSON.parse(JSON.stringify({ ...payload,
      daily: { ...state.daily, normal: { ...history, recent } } })) as JsonValue).kind;
    const edited = (patch: Partial<Record<keyof SeismicRecentQuake, unknown>>) => withRecent([{ ...row(0), ...patch }]);
    for (const codes of [["1", "2", "3", "4", "5"].map((n) => n.repeat(4)), ["123"], ["12345"], ["０２１１"]])
      expect(edited({ tsunamiCodes: codes })).toBe("invalid");
    expect(edited({ omittedTsunamiCodes: -1 })).toBe("invalid");
    expect(withRecent(rows(9, 8, 7, 6, 5, 4, 3, 2, 1, 0))).toBe("invalid");
    expect(withRecent([row(8), { ...row(7), eventId: row(8).eventId }])).toBe("invalid");
    expect(withRecent(rows(7, 8))).toBe("invalid");
    // 形は ISO でも読めない時刻（月 99）は最も古い鍵になる（並べ替えと今日の判定の読みをそろえる、P4-UQR-D-KEY）。
    const unreadable = { ...row(9), originTimeRaw: "2026-99-26T12:00:00+09:00" };
    expect([withRecent([row(8), unreadable]), withRecent([unreadable, row(8)])]).toEqual(["restored", "invalid"]);
    expect(withRecent([row(8), { ...row(8), eventId: "20261126000009" }])).toBe("invalid");
    expect(seismicUnitCodec.decode({ ...payload, schemaVersion: "p3-seismic-unit-v9" } as JsonValue).kind).toBe("invalid");
  });

  // corpus 履歴 P4-UQR-AC02・AC03・AC05: 受信から wire の行まで、電文の値で照らす。
  it("P4-UQR-T03 corpusHistory / AC02・AC03・AC05: wire rows carry the telegram's codes and depth bound", async () => {
    const rowOf = async (state: SeismicUnitState, changes: Parameters<typeof wire>[1]) =>
      projected(await wire({ quake: state }, changes, null)).snapshot.current.earthquake.wire.rows[0];
    const at = (file: string) => receive(emptyState(), decodeFixture(file), clock(reportMs(fixtureXml(file)) + 30_000));
    const s52 = at("33_12_01_240613_VXSE52");
    expect(await rowOf(s52.state, s52.displayChanges)).toMatchObject({ tsunamiCodes: ["0215", "0241"], omittedTsunamiCodes: 0, depthBound: null, depth: { v: "-10000" } });
    const s53 = at("telegram-foundation/phase7_5_VXSE53_20260728162718_99e82c812e72");
    expect(await rowOf(s53.state, s53.displayChanges)).toMatchObject({ tsunamiCodes: ["0211", "0241"], omittedTsunamiCodes: 0, depthBound: null });
    const flash = at("32-35_01_01_260824_VXSE51");
    expect(await rowOf(flash.state, flash.displayChanges)).toMatchObject({ tsunamiCodes: ["0217"], omittedTsunamiCodes: 0, tsunami: null, hypo: null, depth: null });
    const deep = at("synthetic_phase5a_depth_600km_or_more");
    expect(deep.state.daily.normal.recent).toEqual([]);
    const depth = deep.state.earthquakes[0].contributions[0].hypocenter?.depthKm;
    expect(depth).toMatchObject({ kind: "range", bound: "lower", raw: "-600000" });
    const moved: SeismicUnitState = { ...s52.state, daily: { ...s52.state.daily, normal: { ...s52.state.daily.normal,
      recent: [{ ...s52.state.daily.normal.recent[0], depth: depth! }] } } };
    expect(await rowOf(moved, s52.displayChanges)).toMatchObject({ depthBound: "lower", depth: { v: "-600000" } });
  });
});
