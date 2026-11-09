import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { FloodUnitState } from "../../contracts/p3-flood-unit.types";
import type { VolcanoUnitState } from "../../contracts/p3-volcano-unit.types";
import { floodUnitCodec, toFloodView } from "../../src/units/flood/flood-unit";
import { toVolcanoView, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import * as R from "../flood-unit/flood-fixture";
import * as V from "../volcano-unit/volcano-fixture";

// P3-RESTORE-DROPPED-TEXT-001: 火山の防災事項と洪水の浸水想定地区を view へ戻す。

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const PREVENTION = /<VolcanoPrevention>([\s\S]*?)<\/VolcanoPrevention>/;
const A306 = "45_01_01_200522_VFVO50", A350 = "45_03_01_200731_VFVO50", B350 = "44_02_01_200522_VFVO51", MARINE = "46_01_01_170103_VFSVii";
const withPrevention = (text: string) => (xml: string) => xml.replace(PREVENTION, `<VolcanoPrevention>${text}</VolcanoPrevention>`);
const alertOf = (state: VolcanoUnitState, code: string) => state.alerts.find((item) => item.volcanoCode === code);
const preventionOf = (state: VolcanoUnitState, code: string) => { const alert = alertOf(state, code); return alert?.effective === "active" ? alert.prevention : undefined; };
const change = (step: { decisions: readonly object[] }) => step.decisions.map((item) => "change" in item ? item.change : "reason" in item ? item.reason : null);
const corrected = (xml: string) => xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
const raised350 = () => V.send(V.emptyState(), A350, (xml) => V.retime("2020-05-22T13:00:00+09:00")(xml).replaceAll("<Code>11</Code>", "<Code>12</Code>")
  .replace("<Condition>引下げ</Condition>", "<Condition>引上げ</Condition>")).state;

describe("P3-RESTORE-DROPPED-TEXT-001 volcano", () => {
  it("P3-RDT-T01 acceptance / AC01: the view carries the VFVO50 prevention text as sent, the outcome facts stay as they are", () => {
    const step = V.send(V.emptyState(), A306);
    const text = PREVENTION.exec(V.fixtureXml(A306))![1].trim();
    expect(text).toContain("\n");
    expect(toVolcanoView(step.state).alerts[0].prevention).toBe(text);
    const outcome = step.outcomes.find((item) => item.kind === "accepted");
    const facts = outcome?.kind === "accepted" ? outcome.subjects[0].facts : {};
    expect(facts).not.toHaveProperty("prevention");
    expect(facts.volcanoPrevention).toBe(text);
    expect(alertOf(V.send(step.state, "synthetic_VFVO50_cancel").state, "306")).not.toHaveProperty("prevention");
  });

  it("P3-RDT-T02 acceptance / AC02: a follow-up replaces the text without a notice, other reports keep it and release drops it", () => {
    const first = V.send(V.emptyState(), A306);
    const later = V.retime("2020-05-22T13:10:00+09:00");
    const next = V.send(first.state, A306, (xml) => withPrevention("字だけを替えた防災事項")(later(xml)));
    expect(change(next)).toEqual(["semantic"]);
    expect([next.displayChanges.length, next.state.contentRevision, next.intents]).toEqual([1, first.state.contentRevision + 1, []]);
    expect(toVolcanoView(next.state).alerts[0].prevention).toBe("字だけを替えた防災事項");
    expect(V.send(first.state, A306, (xml) => corrected(withPrevention("字だけを替えた防災事項")(later(xml)))).intents.length).toBeGreaterThan(0);
    expect(alertOf(V.send(first.state, A306, (xml) => later(xml).replace(PREVENTION, "")).state, "306")).not.toHaveProperty("prevention");
    // 海上の報は陸上の字を保つ（kind を採る枝と採らない枝）。
    const marine = (xml: string) => xml.replaceAll("<Code>506</Code>", "<Code>306</Code>").replaceAll("<EventID>506</EventID>", "<EventID>306</EventID>");
    const text = preventionOf(first.state, "306");
    expect(preventionOf(V.send(first.state, MARINE, marine).state, "306")).toBe(text);
    expect(preventionOf(V.send(first.state, MARINE, (xml) => V.retime("2020-05-22T13:10:00+09:00")(marine(xml))).state, "306")).toBe(text);
    // 海上の新しい報の後に来た陸上の報（kind は海上のまま、!takeKind の枝）も字を置き換え、要素の無い報では鍵が無くなる。
    const sea = V.send(first.state, MARINE, (xml) => V.retime("2020-05-22T13:40:00+09:00")(marine(xml))).state;
    const between = V.retime("2020-05-22T13:20:00+09:00");
    expect(alertOf(V.send(sea, A306, (xml) => withPrevention("陸上の新しい防災事項")(between(xml))).state, "306"))
      .toMatchObject({ effective: "active", kind: { code: "36" }, prevention: "陸上の新しい防災事項" });
    const bare = alertOf(V.send(sea, A306, (xml) => between(xml).replace(PREVENTION, "")).state, "306");
    expect(bare).toMatchObject({ effective: "active", kind: { code: "36" } });
    expect(bare).not.toHaveProperty("prevention");
    // VFVO51 は同じ区分の継続で保ち、区分の変化で前の区分の字を残さない。
    const raised = raised350();
    const held = preventionOf(raised, "350");
    expect(held).toBeDefined();
    expect(preventionOf(V.send(raised, B350).state, "350")).toBe(held);
    const moved = V.send(raised, B350, (xml) => xml.replaceAll("<Code>12</Code>", "<Code>13</Code>")).state;
    expect([alertOf(moved, "350")?.effective, preventionOf(moved, "350")]).toEqual(["active", undefined]);
    expect(alertOf(V.send(raised, A350).state, "350")).toMatchObject({ effective: "ended" });
    expect(alertOf(V.send(raised, A350).state, "350")).not.toHaveProperty("prevention");
  });

  it("P3-RDT-T03 contractBoundary / AC01,AC02,AC03: the 1,024-character limit stays out of the version compare, and the codec checks the key", () => {
    const of = (length: number) => V.send(V.emptyState(), A306, withPrevention("山".repeat(length))).state;
    const full = alertOf(of(1_024), "306"), long = alertOf(of(1_025), "306");
    expect(full).toMatchObject({ prevention: "山".repeat(1_024), truncated: false });
    expect(long).toMatchObject({ prevention: `${"山".repeat(1_023)}…`, truncated: false });
    expect(change(V.send(of(1_024), A306, withPrevention("山".repeat(1_025))))).toEqual(["duplicate"]);
    const saved = of(1_024), payload = json(volcanoUnitCodec.encode(saved));
    const restored = volcanoUnitCodec.decode(payload);
    expect(restored.kind === "restored" ? restored.state.alerts : null).toEqual(saved.alerts);
    type Row = Record<string, unknown>;
    const edited = (edit: (row: Row) => void) => { const copy = json(payload) as { alerts: Row[] }; edit(copy.alerts[0]); return volcanoUnitCodec.decode(copy as JsonValue); };
    const unmarked = edited((row) => { delete row.prevention; });
    expect(unmarked.kind).toBe("restored");
    // 鍵の無い保存への同じ版の再送は、字が長くても duplicate で鍵は無いまま。
    const resent = V.send(unmarked.kind === "restored" ? unmarked.state : V.emptyState(), A306, withPrevention("山".repeat(1_025)));
    expect(change(resent)).toEqual(["duplicate"]);
    expect(alertOf(resent.state, "306")).not.toHaveProperty("prevention");
    for (const edit of [(row: Row) => { row.prevention = ""; }, (row: Row) => { row.prevention = "山".repeat(1_025); }, (row: Row) => { row.prevention = 1; }])
      expect(edited(edit).kind).toBe("invalid");
    // 海上だけの記録（source が null）は有効な保存で、防災事項の鍵を足した差だけで invalid になる。
    const seaOnly = json(volcanoUnitCodec.encode(V.send(V.emptyState(), MARINE).state)) as { alerts: Row[] };
    expect(seaOnly.alerts[0].source).toBeNull();
    expect(volcanoUnitCodec.decode(seaOnly as JsonValue).kind).toBe("restored");
    seaOnly.alerts[0].prevention = "陸上の字";
    expect(volcanoUnitCodec.decode(seaOnly as JsonValue).kind).toBe("invalid");
    const ended = V.send(raised350(), A350).state;
    const key = json(volcanoUnitCodec.encode(ended)) as { alerts: Row[] };
    key.alerts[0].prevention = "残った字";
    expect(volcanoUnitCodec.decode(key as JsonValue).kind).toBe("invalid");
    expect(volcanoUnitCodec.maxEnvelopeBytes).toBe(10_006_615);
  });
});

describe("P3-RESTORE-DROPPED-TEXT-001 flood", () => {
  const L4 = "16_10_01_260312_VXKO50", OCCUR = "16_12_01_260312_VXKO50", RELEASE = "16_14_01_251222_VXKO50";
  const ITEM = /<Item>\s*<Kind>\s*<Name>浸水想定地区[\s\S]*?<\/Item>/;
  const AREAS = /(<Areas>\s*)(<Area codeType="水位観測所">[\s\S]*?)(\s*<\/Areas>\s*<\/Item>\s*<\/Warning>)/;
  const repeat = (times: number) => (xml: string) => xml.replace(AREAS, (_, open: string, areas: string, close: string) => open + areas.repeat(times) + close);
  const groupsOf = (state: FloodUnitState) => { const record = state.currents[0]; return record.effective === "active" ? record.inundation : undefined; };
  const later = R.retime("2025-08-11T05:00:00+09:00");
  const renamed = (xml: string) => xml.replace("奥古閑校区", "別の校区");

  it("P3-RDT-T04 acceptance / AC04: the view carries the areas as sent, in order, keyed like the stations", () => {
    const current = toFloodView(R.send(R.emptyState(), L4).state).currents[0];
    const areas = current.inundation![0].areas;
    const subCities = [...ITEM.exec(R.fixtureXml(L4))![0].matchAll(/<SubCityList>([^<]*)<\/SubCityList>/g)].map((match) => match[1]);
    expect(areas.map((area) => area.subCities)).toEqual(subCities);
    expect(areas).toHaveLength(16);
    expect(areas[0]).toMatchObject({ name: "城南", stationCode: "89091000010000003", prefecture: "熊本県", city: "熊本市", cityCode: "4310000" });
    const stations = new Set(current.stations.map((station) => `${station.code}\n${station.name}`));
    expect(areas.every((area) => stations.has(`${area.stationCode}\n${area.name}`))).toBe(true);
    const occurred = toFloodView(R.send(R.emptyState(), OCCUR).state).currents[0].inundation![0];
    expect(occurred).toMatchObject({ kindName: "浸水想定地区（氾濫発生情報）", text: "坂東大橋地点からの氾濫による浸水が想定される地区は以下のとおりです。※", omittedAreaCount: 0 });
    expect(occurred.areas[0]).toMatchObject({ name: "茨城県古河市", stationCode: null, subCities: "-" });
    expect(toFloodView(R.send(R.emptyState(), "16_05_01_210630_VXKO50").state).currents[0]).not.toHaveProperty("inundation");
    expect(toFloodView(R.send(R.emptyState(), "91_01_01_241031_VXSU50").state).currents[0]).not.toHaveProperty("inundation");
  });

  it("P3-RDT-T05 contractBoundary / AC05: the areas stop at 32,768 bytes from the head, and a long text shows its cut", () => {
    const active = (xml: string) => xml.replaceAll("<Code>10</Code>", "<Code>20</Code>");
    const groups = groupsOf(R.send(R.emptyState(), RELEASE, (xml) => repeat(20)(active(xml))).state)!;
    expect(Buffer.byteLength(JSON.stringify(groups))).toBeLessThanOrEqual(32_768);
    expect(groups[0].areas.length + groups[0].omittedAreaCount).toBe(100);
    expect(groups[0].omittedAreaCount).toBeGreaterThan(0);
    const once = groupsOf(R.send(R.emptyState(), RELEASE, active).state)![0].areas;
    expect(groups[0].areas.slice(0, once.length)).toEqual(once);
    expect(groupsOf(R.send(R.emptyState(), L4, repeat(5)).state)![0]).toMatchObject({ omittedAreaCount: 0 });
    const text = (length: number) => groupsOf(R.send(R.emptyState(), L4, (xml) => xml.replace(/(<Type>浸水想定地区<\/Type>\s*<Text>)[^<]*/, `$1${"地".repeat(length)}`)).state)![0].text;
    expect(text(256)).toBe("地".repeat(256));
    expect(text(257)).toBe(`${"地".repeat(255)}…`);
  });

  it("P3-RDT-T06 acceptance / AC06: a follow-up replaces the areas without a notice, and the end of the report drops them", () => {
    const first = R.send(R.emptyState(), L4);
    const next = R.send(first.state, L4, (xml) => renamed(later(xml)));
    expect(change(next)).toEqual(["semantic"]);
    expect([next.displayChanges.length, next.state.contentRevision, next.intents]).toEqual([1, first.state.contentRevision + 1, []]);
    expect(toFloodView(next.state).currents[0].inundation![0].areas[0].subCities).toContain("別の校区");
    expect(R.send(first.state, L4, (xml) => corrected(renamed(later(xml)))).intents.length).toBeGreaterThan(0);
    expect(toFloodView(R.send(first.state, L4, (xml) => later(xml).replace(ITEM, "")).state).currents[0]).not.toHaveProperty("inundation");
    const unknown = R.send(first.state, L4, (xml) => later(xml).replace(/<Information type="指定河川洪水予報（河川）">[\s\S]*?<\/Information>/, "")).state;
    expect(groupsOf(unknown)).toEqual(groupsOf(first.state));
    const released = R.send(first.state, L4, (xml) => later(xml).replace(/(<Information type="指定河川洪水予報（河川）">[\s\S]*?<Code>)40(<\/Code>)/, "$110$2")).state;
    expect(released.currents[0]).toMatchObject({ effective: "ended" });
    expect(released.currents[0]).not.toHaveProperty("inundation");
    const cancelled = R.send(first.state, "synthetic_VXKO50_cancel", (xml) => R.eventId("890910000100")(later(xml))).state;
    expect(cancelled.currents[0]).toMatchObject({ effective: "cancelled" });
    expect(cancelled.currents[0]).not.toHaveProperty("inundation");
    expect(change(R.send(first.state, L4, renamed))).toEqual(["duplicate"]);
  });

  it("P3-RDT-T07 contractBoundary / AC07: the areas are not saved and come back with the next report", () => {
    const state = R.send(R.emptyState(), L4).state;
    expect(groupsOf(state)![0].areas[0].subCities).toContain("奥古閑校区");
    const payload = json(floodUnitCodec.encode(state));
    expect(JSON.stringify(payload)).not.toContain("奥古閑校区");
    expect(payload).toMatchObject({ schemaVersion: "p3-flood-unit-v9" });
    const restored = floodUnitCodec.decode(payload);
    if (restored.kind !== "restored") throw new Error("not restored");
    expect(toFloodView(restored.state).currents[0]).not.toHaveProperty("inundation");
    expect(change(R.send(restored.state, L4))).toEqual(["duplicate"]);
    const refilled = groupsOf(R.send(restored.state, L4, later).state)!;
    expect(refilled[0].areas[0]).toMatchObject({ name: "城南", city: "熊本市", subCities: expect.stringContaining("奥古閑校区") });
    expect(refilled).toEqual(groupsOf(state));
    const plain = R.send(R.emptyState(), "16_05_01_210630_VXKO50").state;
    expect(floodUnitCodec.encode(plain).currents[0]).toBe(plain.currents[0]);
  });
});
