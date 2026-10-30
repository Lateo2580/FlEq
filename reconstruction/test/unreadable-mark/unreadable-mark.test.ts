import { createHash } from "node:crypto";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { DiagnosticEvent, JsonValue, RuntimeUnitId, UnreadableMark, UnreadableMarkView } from "../../contracts/p2-shared-runtime.types";
import type { FloodUnitState } from "../../contracts/p3-flood-unit.types";
import type { LandslideUnitState } from "../../contracts/p3-landslide-unit.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { CheckpointCoordinator, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { initialUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { briefingUnitCodec, toBriefingView } from "../../src/units/briefing/briefing-unit";
import { floodUnitCodec, toFloodView } from "../../src/units/flood/flood-unit";
import { landslideUnitCodec, reduceLandslideUnit, toLandslideView } from "../../src/units/landslide/landslide-unit";
import { localBulletinsUnitCodec, toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { nankaiUnitCodec, toNankaiView } from "../../src/units/nankai/nankai-unit";
import { seismicUnitCodec, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { toTyphoonView, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { rewriteXml } from "../../src/units/unreadable";
import { toVolcanoView, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import {
  reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, weatherTimeseriesUnitCodec,
} from "../../src/units/weather-timeseries/weather-timeseries-unit";
import * as B from "../briefing-unit/briefing-fixture";
import * as R from "../flood-unit/flood-fixture";
import * as L from "../landslide-unit/landslide-fixture";
import * as M from "../local-bulletins-unit/local-bulletins-fixture";
import * as N from "../nankai-unit/nankai-fixture";
import * as Q from "../seismic-unit/seismic-fixture";
import * as T from "../tsunami-unit/tsunami-fixture";
import * as Y from "../typhoon-unit/typhoon-fixture";
import * as V from "../volcano-unit/volcano-fixture";

// P3-UNREADABLE-MARK-001（K14）発注 1 の試験（T01・T02・T03・T09・T15〜T19・T21）。読めない報は既存の fixture の写しを試験の中で壊して作る。

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const headlineOf = (xml: string) => /<Headline>\s*<Text>([^<]*)<\/Text>/.exec(xml)?.[1] ?? null;
const bytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
// AC03 (1) の数え方を試験の側で数える（実装の関数を使わない）。
const rawBytes = (mark: UnreadableMark | undefined) => mark == null ? 0
  : [...mark.parts.map((part) => part.raw), mark.headline].reduce((sum, value) => sum + (value == null ? 0 : bytes(value)), 0);
// AC10: view の印は site・scope の一覧と原文の有無と旗（U-F の付加事項は一覧に入れず有無だけ）。
const viewOf = (mark: UnreadableMark): UnreadableMarkView => ({
  parts: mark.parts.filter((part) => part.site !== "addition").map((part) => ({ site: part.site, ...part.scope == null ? {} : { scope: part.scope },
    raw: part.raw != null })), headline: mark.headline != null,
  ...mark.parts.some((part) => part.site === "addition" && part.raw != null) ? { addition: true } : {},
  ...mark.rawDropped === true ? { rawDropped: true } : {}, ...mark.partsCut === true ? { partsCut: true } : {} });
// AC10 (1): view に原文の本文が入らないこと。
function expectView(view: unknown, mark: UnreadableMark): void {
  expect(view).toMatchObject({ unreadableView: viewOf(mark) });
  expect(view).not.toHaveProperty("unreadable");
  for (const part of mark.parts) if (part.raw != null) expect(JSON.stringify(view)).not.toContain(JSON.stringify(part.raw).slice(1, -1));
}

const temporary: string[] = [];
afterAll(async () => { for (const path of temporary) await fileSystem.rm(path, { recursive: true, force: true }); });
// T01 の後半（K7 の入口、P3-NL-T07 と同じ作り）: 捨ててよい旧い版の一覧は空（P3-VM-AC05 の一覧の寿命、P3-MIG-AC01）なので、前の版の slot は
// unknownSchema で読み、その unit はこの run で保存しない（P3-VM-AC05 (4)）。
async function rejectsPrevious(unit: RuntimeUnitId, previous: string): Promise<void> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "unreadable-mark-"));
  temporary.push(path);
  expect(linkedUnitCodecs[unit]?.discardableSchemaVersions).toBeUndefined();
  await fileSystem.writeFile(join(path, `${unit}-A.json`), serializedEnvelope(hashEnvelope({ schemaVersion: previous, unit, generation: 1, capturedAt: 1,
    payload: {} })));
  const events: DiagnosticEvent[] = [];
  const coordinator = new CheckpointCoordinator(path, linkedUnitCodecs, nodeCheckpointFileSystem(), () => ({ wallTimeMs: 1, monotonicMs: 1 }),
    (event) => { events.push(event); });
  expect([coordinator.restoreUnit(unit), coordinator.saves(unit), events.map((event) => event.reason)]).toEqual([
    { kind: "unavailable", reason: "unknownSchema" }, false, ["checkpointRestoreRejected"]]);
}

// U-F の受信（weather-timeseries-unit.test.ts の fixture と同じ作り）。
let ufSequence = 0;
function ufMaterial(name: string, transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
  const xml = transform(Y.fixtureXml(name));
  const entered = ingestXmlData({ inputId: `uf-${++ufSequence}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType: "VPWP50",
    body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const ufReceive = (material: DecodedMaterial, state: WeatherTimeseriesUnitState = initialUnits["U-F"]) => reduceWeatherTimeseriesUnit(state,
  { kind: "receive", material, clock: { wallTimeMs: Date.parse(material.reportDateTimeRaw), monotonicMs: 0 } });
const UF = "81_01_01_260129_VPWP50";
const SIGNIFICANCY_BASE = /(<SignificancyPart>\s*<Base>)/;

// U-R の i 番目の報（EventID と時刻が i で決まる）。1 つの観測所の水位が長さ length の形の外の値（T02・T21）。
const R_START = Date.parse("2022-07-28T10:00:00+09:00");
const rIso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const floodReport = (prefix: number, index: number, length: number) => R.decodeFixture("16_02_01_220728_VXKO50", (xml) => R.stationsXml(4, [{
  code: "27000000000000001", name: "観測所", values: ["1.00", "a".repeat(length), "1.20", "1.30"], levels: ["3", "3", "3", "3"] }])(
  R.eventId(String(prefix + index))(R.retime(rIso(R_START + index * 60_000))(xml))));
const floodAt = (index: number) => R.clock(R_START + index * 60_000 + 1);
const floodTotal = (state: FloodUnitState) => state.currents.reduce((sum, item) => sum + (item.effective === "active" ? rawBytes(item.unreadable) : 0), 0);

describe("P3-UNREADABLE-MARK-001 order 1", () => {
  // acceptance: P3-UM-T01（AC01・AC16）と P3-UM-T09（AC10）を 10 unit ごとに。
  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-L keeps the kindName mark with its fragment and headline across encode and restore", async () => {
    const xml = L.fixtureXml("15_16_01_241031_VPWW56");
    const broken = L.send(L.emptyState(), "15_16_01_241031_VPWW56", (source) => source.replace(
      /(<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<Item>[\s\S]*?<\/Item>[\s\S]*?<Item>[\s\S]*?<\/Item>[\s\S]*?<Item>\s*<Kind>\s*)<Name>[^<]*<\/Name>/, "$1"));
    const record = broken.state.currents[0];
    const expected: UnreadableMark = { parts: [{ site: "kindName", reason: "requiredStructureMissing", scope: "0151200",
      raw: "<Kind><Code>29</Code><Status>継続</Status><LastKind><Name>レベル２土砂災害注意報</Name><Code>29</Code></LastKind><Property>"
        + "<Type>土砂災害危険度</Type><SignificancyPart><Base><Significancy type=\"土砂災害危険度\"><Name>警戒レベル２</Name><Code>21</Code>"
        + "</Significancy></Base></SignificancyPart></Property></Kind>" }], headline: headlineOf(xml) };
    expect([broken.diagnostics.map((item) => item.reason), record.effective === "active" ? record.unreadable : null])
      .toEqual([["requiredStructureMissing"], expected]);
    const restored = landslideUnitCodec.decode(json(landslideUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.currents : null).toEqual(broken.state.currents);
    expectView(toLandslideView(broken.state).currents[0], expected);
    // 印の無い記録は欄を書かず、view も今の形のまま。
    const clean = L.send(L.emptyState(), "15_16_01_241031_VPWW56").state;
    expect([Object.keys(clean.currents[0]).includes("unreadable"), JSON.stringify(landslideUnitCodec.encode(clean)).includes("unreadable")])
      .toEqual([false, false]);
    expect(toLandslideView(clean).currents[0]).not.toHaveProperty("unreadableView");
    await rejectsPrevious("U-L", "p3-landslide-unit-v6");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-B keeps the condition mark", async () => {
    const broken = B.send(B.emptyState(), "synthetic_VPBS50_multi", (xml) => xml.replace("<Condition>短時間大雪</Condition>", "<Condition><x/>短時間大雪</Condition>"));
    const record = broken.state.currents.find((item) => item.effective === "active");
    const mark = record?.effective === "active" ? record.unreadable : undefined;
    expect(mark).toEqual({ parts: [{ site: "condition", reason: "requiredStructureInvalid", raw: "<Condition><x></x>短時間大雪</Condition>" }],
      headline: headlineOf(B.fixtureXml("synthetic_VPBS50_multi")) });
    const restored = briefingUnitCodec.decode(json(briefingUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.currents : null).toEqual(broken.state.currents);
    expectView(toBriefingView(broken.state).currents[0], mark!);
    await rejectsPrevious("U-B", "p3-briefing-unit-v6");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-R keeps the series mark scoped to the station", async () => {
    const station = { code: "27000000000000001", name: "観測所", values: ["1.00", "abc", "1.20", "1.30"], levels: ["3", "3", "3", "3"] };
    const broken = R.send(R.emptyState(), "16_02_01_220728_VXKO50", R.stationsXml(4, [station]));
    const record = broken.state.currents[0];
    const mark = record.effective === "active" ? record.unreadable : undefined;
    expect(mark).toEqual({ parts: [{ site: "series", reason: "requiredStructureInvalid", scope: station.code,
      raw: "<jmx_eb:WaterLevel type=\"水位\" refID=\"2\">abc</jmx_eb:WaterLevel>" }], headline: headlineOf(R.fixtureXml("16_02_01_220728_VXKO50")) });
    const restored = floodUnitCodec.decode(json(floodUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.currents : null).toEqual(broken.state.currents);
    expectView(toFloodView(broken.state).currents[0], mark!);
    await rejectsPrevious("U-R", "p3-flood-unit-v7");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-M keeps the headline mark of a tornado report", async () => {
    const broken = M.send(M.emptyState(), "19_01_01_091210_VPHW50", (xml) => xml.replace("<Text>東京地方では", "<Text><b/>東京地方では"));
    const record = broken.state.tornado[0];
    const mark = record.effective === "active" ? record.unreadable : undefined;
    expect(mark?.parts.map((part) => [part.site, part.reason, part.scope, part.raw?.startsWith("<Headline><Text><b></b>東京地方では")]))
      .toEqual([["headline", "requiredStructureInvalid", undefined, true]]);
    expect(mark?.headline?.startsWith("東京地方では")).toBe(true);
    const restored = localBulletinsUnitCodec.decode(json(localBulletinsUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.tornado : null).toEqual(broken.state.tornado);
    expectView(toLocalBulletinsView(broken.state).tornado[0], mark!);
    await rejectsPrevious("U-M", "p3-local-bulletins-unit-v6");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-V keeps the volcano name mark on the land side", async () => {
    const broken = V.send(V.emptyState(), "45_01_01_200522_VFVO50", (xml) => xml.replace(
      /(<VolcanoInfo type="噴火警報・予報（対象火山）">[\s\S]*?)<Name>浅間山<\/Name>/, "$1<Name><x/>浅間山</Name>"));
    const record = broken.state.alerts[0];
    const mark = record.effective === "active" ? record.unreadable : undefined;
    // 名前の warn は scope で欄を分け、前の記録の無い版の compare は null の digest（発注 2、P3-UM-AC04 (1)・Q-UM-PRECHECK-2 (8)(b)）。
    expect([mark?.parts, record.effective === "active" ? record.marineUnreadable : null]).toEqual([
      [{ site: "name", reason: "requiredStructureInvalid", scope: "volcano", compare: createHash("sha256").update("null").digest("hex").slice(0, 16),
        raw: "<Name><x></x>浅間山</Name>" }], undefined]);
    const restored = volcanoUnitCodec.decode(json(volcanoUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.alerts : null).toEqual(broken.state.alerts);
    expectView(toVolcanoView(broken.state).alerts[0], mark!);
    await rejectsPrevious("U-V", "p3-volcano-unit-v5");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-Q keeps the name mark scoped to the station on the contribution", async () => {
    const source = Q.fixtureXml("32-35_01_03_240613_VXSE53");
    const code = /<IntensityStation>\s*<Name>[^<]*<\/Name>\s*<Code>([^<]*)<\/Code>/.exec(source)![1];
    const material = Q.decodeFixture("32-35_01_03_240613_VXSE53", (xml) => xml.replace(/(<IntensityStation>\s*)<Name>[^<]*<\/Name>/, "$1"));
    const broken = Q.receive(Q.emptyState(), material, Q.clock(Date.parse(material.reportDateTimeRaw)));
    const mark = broken.state.earthquakes[0].contributions[0].unreadable;
    expect(mark?.parts.map((part) => [part.site, part.reason, part.scope, part.raw?.startsWith(`<IntensityStation><Code>${code}</Code>`)]))
      .toEqual([["name", "requiredStructureMissing", code, true]]);
    const restored = seismicUnitCodec.decode(json(seismicUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.earthquakes : null).toEqual(broken.state.earthquakes);
    const view = toSeismicView(broken.state).earthquakes[0];
    expect(view.unreadableView).toEqual([{ family: "VXSE53", ...viewOf(mark!) }]);
    expect(JSON.stringify(view)).not.toContain(`<IntensityStation><Code>${code}`);
    await rejectsPrevious("U-Q", "p3-seismic-unit-v5");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-N keeps the infoName mark on the current and the information", async () => {
    const broken = N.send(N.emptyState(), "74_01_04_200512_VYSE50", (xml) => xml.replace("<Name>巨大地震警戒</Name>", "<Name>巨大地震警戒</Name><Name>重複</Name>"));
    const current = broken.state.currents[0], information = broken.state.information[0];
    const mark = current.effective === "active" ? current.unreadable : undefined;
    expect(mark?.parts).toEqual([{ site: "infoName", reason: "requiredStructureInvalid",
      raw: "<InfoSerial codeType=\"地震関連情報番号コード\"><Name>巨大地震警戒</Name><Name>重複</Name><Code>120</Code></InfoSerial>" }]);
    expect(information.effective === "active" ? information.unreadable : null).toEqual(mark);
    const restored = nankaiUnitCodec.decode(json(nankaiUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? [restored.state.currents, restored.state.information] : null)
      .toEqual([broken.state.currents, broken.state.information]);
    const view = toNankaiView(broken.state);
    expectView(view.currents[0], mark!);
    expectView(view.information[0], mark!);
    await rejectsPrevious("U-N", "p3-nankai-unit-v6");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-Y keeps the dropped section of a probability report", async () => {
    const unknown = "<MeteorologicalInfo type=\"未知の節\"><DateTime>2020-06-30T09:00:00+09:00</DateTime></MeteorologicalInfo>";
    const broken = Y.send(Y.emptyState(), "76_01_01_200630_VPTA50", (xml) => xml.replace("<MeteorologicalInfo type=\"台風の暴風域に入る確率（1日積算）\">",
      `${unknown}<MeteorologicalInfo type="台風の暴風域に入る確率（1日積算）">`));
    const record = broken.state.probability[0];
    const mark = record.effective === "active" ? record.unreadable : undefined;
    expect([record.effective === "active" && record.truncated, mark?.parts]).toEqual([true,
      [{ site: "section", reason: "requiredStructureInvalid", raw: unknown }]]);
    const restored = typhoonUnitCodec.decode(json(typhoonUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.probability : null).toEqual(broken.state.probability);
    expectView(toTyphoonView(broken.state).probability[0], mark!);
    await rejectsPrevious("U-Y", "p3-typhoon-unit-v6");
  });

  it("P3-UM-T01・P3-UM-T09 acceptance / AC01,AC16,AC10: U-T keeps the station mark scoped to the station code", async () => {
    const material = T.decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51", (xml) => xml.replace("<Code>20102</Code>", "<Code>20102</Code><Sensor><x/></Sensor>"));
    const broken = T.receive(T.emptyState(), material, T.clock(Date.parse(material.reportDateTimeRaw)));
    const mark = broken.state.observations[0].unreadable;
    expect(mark).toEqual({ parts: [{ site: "station", reason: "requiredStructureInvalid", scope: "20102", raw: "<Sensor><x></x></Sensor>" }],
      headline: headlineOf(T.fixtureXml("synthetic_VTSE51_fragmentA")) });
    const restored = tsunamiUnitCodec.decode(json(tsunamiUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.observations : null).toEqual(broken.state.observations);
    expectView(toTsunamiView(broken.state).observations[0], mark!);
    await rejectsPrevious("U-T", "p3-tsunami-unit-v5");
  });

  // acceptance: P3-UM-T15（AC15・AC02）も同じ入力で。Kind の範囲の区分不明は scope にその Kind の範囲を書き、WARN は今どおり 1 件。
  it("P3-UM-T01・P3-UM-T09・P3-UM-T15 acceptance / AC01,AC16,AC10,AC15,AC02: U-F keeps the Kind scope mark and its fragment", async () => {
    const xml = Y.fixtureXml(UF);
    const firstKind = /<Kind>[\s\S]*?<\/Kind>/.exec(xml)![0];
    const area = /<Area>\s*<Name>[^<]*<\/Name>\s*<Code>([^<]*)<\/Code>/.exec(xml.slice(xml.indexOf("<TimeSeriesInfo>")))![1];
    const types = [...firstKind.matchAll(/<Type>([^<]*)<\/Type>/g)].map((match) => match[1]).join(",");
    const broken = ufReceive(ufMaterial(UF, (source) => source.replace("<Kind>", "<Kind><Remark>x</Remark>")));
    const mark = broken.state.subjects[0].unreadable;
    expect([mark?.parts, broken.diagnostics.map((item) => item.reason)]).toEqual([[{ site: "Kind", reason: "requiredStructureInvalid",
      scope: `${area}/${types}`, raw: "<Remark>x</Remark>" }], ["weatherTimeseriesScopeUnclear"]]);
    const restored = weatherTimeseriesUnitCodec.decode(json(weatherTimeseriesUnitCodec.encode(broken.state)));
    expect(restored.kind === "restored" ? restored.state.subjects : null).toEqual(broken.state.subjects);
    expectView(toWeatherTimeseriesView(broken.state).series[0], mark!);
    expect(ufReceive(ufMaterial(UF)).state.subjects[0]).not.toHaveProperty("unreadable");
    await rejectsPrevious("U-F", "p2-weather-timeseries-unit-v6");
  });

  // contractBoundary: P3-UM-T02（AC03）。U-R の原文の予算の境界、外す順、H39 の数え方、保存→復元の合計。P3-UM-T21（AC17）: 予算を越える
  // 受信 1 回で state と記録の配列を直列化しない。
  it("P3-UM-T02・P3-UM-T21 contractBoundary / AC03,AC17: the oldest raw goes first just over the budget, is counted once and the total survives restore", () => {
    const BUDGET = 131_072, PREFIX = 82_000_000_000;
    const send = (state: FloodUnitState, index: number, length: number) => R.receive(state, floodReport(PREFIX, index, length), floodAt(index));
    // 長さ 1 の値の記録の原文の byte から、値の長さに比例しない分を引く（空の値は合法で印が付かない）。
    const probe = send(R.emptyState(), 0, 1).state.currents[0];
    const fixed = (probe.effective === "active" ? rawBytes(probe.unreadable) : 0) - 1;
    let state = R.emptyState(), next = 0;
    while (BUDGET - floodTotal(state) > 2 * (fixed + 500)) state = send(state, next++, 500).state;
    const fill = BUDGET - floodTotal(state) - fixed;
    expect(fill > 0 && fill < 1_400).toBe(true);
    // 予算ちょうどでは外さない。
    const exact = send(state, next, fill);
    expect([floodTotal(exact.state), exact.diagnostics.some((item) => item.reason === "unreadableDropped"),
      exact.state.currents.some((item) => item.effective === "active" && item.unreadable?.rawDropped === true)]).toEqual([BUDGET, false, false]);
    // 1 byte 越えると最も古い記録（0 番）の原文が外れ、印は残る。
    const spy = vi.spyOn(JSON, "stringify");
    let over: ReturnType<typeof send>;
    try {
      over = send(state, next, fill + 1);
      expect(spy.mock.calls.filter(([value]) => value === state || value === state.currents || value === over.state || value === over.state.currents))
        .toEqual([]);
    } finally { spy.mockRestore(); }
    const oldest = over.state.currents.find((item) => item.eventId === String(PREFIX));
    expect(oldest?.effective === "active" ? [oldest.unreadable?.rawDropped, oldest.unreadable?.parts.map((part) => [part.site, part.raw]),
      oldest.unreadable?.headline] : null).toEqual([true, [["series", null]], null]);
    expect(over.diagnostics).toContainEqual({ level: "INFO", component: "flood", reason: "unreadableDropped", unit: "U-R", count: 1 });
    expect(floodTotal(over.state)).toBeLessThanOrEqual(BUDGET);
    // H39 は owner の数え方（採用の結果の診断）で 1 件。
    const now = floodAt(next);
    const owner = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" }, "U-M": { kind: "empty" }, "U-Y": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = floodReport(PREFIX, next, fill + 1);
    const routed = receiveOwner({ ...owner, units: { ...owner.units, "U-R": state } }, { runId: "run", inputId: material.inputId,
      result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.state.losses["U-R"]).toContainEqual({ reason: "unreadableDropped", count: 1, lastAt: now.wallTimeMs });
    // 続く受信は外した記録を選び直さず、次に古い記録（1 番）だけを外して 1 件と数える。
    const again = send(over.state, next + 1, 1_000);
    const second = again.state.currents.find((item) => item.eventId === String(PREFIX + 1));
    expect([again.state.currents.find((item) => item.eventId === String(PREFIX)), second?.effective === "active" && second.unreadable?.rawDropped,
      again.diagnostics.filter((item) => item.reason === "unreadableDropped")]).toEqual([oldest, true,
      [{ level: "INFO", component: "flood", reason: "unreadableDropped", unit: "U-R", count: 1 }]]);
    // 保存→復元の後の合計は受信の時と同じ（復元で数え直す）。
    const restored = floodUnitCodec.decode(json(floodUnitCodec.encode(again.state)));
    expect(restored.kind === "restored" ? floodTotal(restored.state) : null).toBe(floodTotal(again.state));
  });

  // contractBoundary: P3-UM-T03（AC01・AC16）。part の 16 件、欠片の 1,538 byte、codec の検査、観測点の引き継ぎの partsCut。
  it("P3-UM-T03 contractBoundary / AC01,AC16: 16 parts, the 1,538-byte fragment, the codec checks and partsCut across U-T fragments", () => {
    // 欠片の書き直しは boundedString で切る（ASCII 1,514 文字は切らず 1,516 byte、1,515 文字は印付きで 1,538 byte、日本語 504・505 文字）。
    const cut = (text: string) => [bytes(rewriteXml(text)), rewriteXml(text).endsWith("[truncated:fieldLimit]")];
    expect([cut("a".repeat(1_514)), cut("a".repeat(1_515)), cut("あ".repeat(504)), cut("あ".repeat(505))])
      .toEqual([[1_516, false], [1_538, true], [1_514, false], [1_536, true]]);

    // U-T の観測: 10:00 の A（観測点 x1〜x17 の Sensor が形の外）で 16 part と partsCut、16 点なら partsCut なし。
    const at = "2099-01-01T10:00:00+09:00", at2 = "2099-01-01T10:10:00+09:00";
    const codes = Array.from({ length: 17 }, (_, index) => String(90_001 + index));
    const sensor = (xml: string, broken: readonly string[]) => broken.reduce((text, code) => text.replace(`<Code>${code}</Code>`,
      `<Code>${code}</Code><Sensor><x/></Sensor>`), xml);
    const send = (state: ReturnType<typeof T.emptyState>, xml: string) => {
      const material = T.decodeXml(xml, "VTSE51");
      return T.receive(state, material, T.clock(Date.parse(material.reportDateTimeRaw) + 1)).state;
    };
    const a = (broken: readonly string[]) => sensor(T.observation({ at, serial: 1, stations: codes.map((code) => ({ code })) }), broken);
    const sixteen = send(T.emptyState(), a(codes.slice(0, 16))).observations[0].unreadable;
    expect([sixteen?.parts.length, sixteen?.partsCut]).toEqual([16, undefined]);
    const fragmentA = send(T.emptyState(), a(codes));
    const markA = fragmentA.observations[0].unreadable;
    expect([markA?.parts.length, markA?.partsCut, markA?.parts.map((part) => part.scope)]).toEqual([16, true, codes.slice(0, 16)]);
    // 10:01 の同じ報の fragment B（x1〜x17 を Sensor を省いて含み、y を足す）: 前の x が残るので印の part と partsCut が残る（入力の code で
    // 数えると外れる）。
    const fragmentB = send(fragmentA, T.observation({ at, serial: 1, stations: [...codes, "99999"].map((code) => ({ code })) }));
    const markB = fragmentB.observations[0].unreadable;
    expect([fragmentB.observations[0].stations.length, markB?.parts.length, markB?.partsCut]).toEqual([18, 16, true]);
    // 新しい版 C が x1 を更新すると x1 の part は外れて 15 件になり、partsCut は残る（前の観測点が残るので丸ごとの置き換えでない）。
    const fragmentC = send(fragmentB, T.observation({ at: at2, serial: 2, stations: [{ code: codes[0], condition: "第１波到達" }] }));
    const markC = fragmentC.observations[0].unreadable;
    expect([markC?.parts.length, markC?.partsCut, markC?.parts.some((part) => part.scope === codes[0])]).toEqual([15, true, false]);
    // 前の観測点を全部更新する新しい版は丸ごとの置き換えで、印と旗が外れる。
    const replaced = send(send(T.emptyState(), a([codes[0]])), T.observation({ at: at2, serial: 2, stations: [{ code: codes[0], condition: "第１波到達" }] }));
    expect(replaced.observations[0]).not.toHaveProperty("unreadable");
    // 保存→復元で 16 part と partsCut が戻る。
    const restored = tsunamiUnitCodec.decode(json(tsunamiUnitCodec.encode(fragmentA)));
    expect(restored.kind === "restored" ? restored.state.observations[0].unreadable : null).toEqual(markA);

    // codec は表の外の site・17 件の part・16 hex でない compare・128 byte を越える scope・1,538 byte を越える raw・(site, scope) の重複・
    // 一覧の欄の外の compareKeys（U-L は一覧の欄を持たない、発注 2）・129 件の compareKeys・true でない旗・余分な鍵を読まない。
    const landslide = L.send(L.emptyState(), "15_16_01_241031_VPWW56", (xml) => xml.replace(
      /(<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<Item>\s*<Kind>\s*)<Name>[^<]*<\/Name>/, "$1")).state;
    type Payload = { currents: ({ unreadable: Readonly<{ parts: readonly Readonly<Record<string, unknown>>[] }> } & Record<string, unknown>)[] };
    const payload = json(landslideUnitCodec.encode(landslide)) as Payload & Record<string, JsonValue>;
    const mark = payload.currents[0].unreadable, part = mark.parts[0];
    const withMark = (value: Readonly<Record<string, unknown>>) => json({ ...payload, currents: [{ ...payload.currents[0], unreadable: value }] });
    const parts = (list: readonly Readonly<Record<string, unknown>>[]) => withMark({ ...mark, parts: list });
    const keys = (count: number) => Array.from({ length: count }, (_, index) => index.toString(16).padStart(16, "0"));
    expect(landslideUnitCodec.decode(json(payload)).kind).toBe("restored");
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...part, scope: String(index) }));
    expect([16, 17].map((count) => landslideUnitCodec.decode(parts(many(count))).kind)).toEqual(["restored", "invalid"]);
    expect([
      parts([{ ...part, site: "nope" }]), parts([{ ...part, compare: "xyz" }]), parts([{ ...part, compare: "0".repeat(16) }]),
      parts([{ ...part, scope: "s".repeat(126) }]), parts([{ ...part, scope: "s".repeat(127) }]), parts([{ ...part, raw: "a".repeat(1_536) }]),
      parts([{ ...part, raw: "a".repeat(1_537) }]), parts([part, part]), parts([{ ...part, reason: "identityInvalid" }]),
      parts([{ ...part, compareKeys: keys(128) }]), parts([{ ...part, compareKeys: keys(129) }]),
      withMark({ ...mark, rawDropped: false }), withMark({ ...mark, extra: 1 }), withMark({ ...mark, rawDropped: true, partsCut: true }),
    ].map((value) => landslideUnitCodec.decode(value).kind)).toEqual(["invalid", "invalid", "restored", "restored", "invalid", "restored", "invalid",
      "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "restored"]);
  });

  // regression: r1 ヘルツ P2-1（AC01 (6)）。10:00 の観測所 x の水位が形の外の報の後、10:01 の「（河川）」の無い報は前の事実を引き継ぐので、
  // 引き継ぐ観測所の印と原文を保つ（新しい報の印の null で消さない）。保存→復元でも残る。
  it("P3-UM-T01 regression / AC01,AC16: a report without the river Information keeps the series mark of the facts it inherits", () => {
    const NAME = "16_02_01_220728_VXKO50";
    const station = { code: "27000000000000001", name: "観測所", values: ["1.00", "abc", "1.20", "1.30"], levels: ["3", "3", "3", "3"] };
    const first = R.send(R.emptyState(), NAME, R.stationsXml(4, [station]));
    const before = first.state.currents[0];
    const at = Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(R.fixtureXml(NAME))![1]) + 60_000;
    const second = R.send(first.state, NAME, (xml) => R.retime(rIso(at))(R.stationsXml(4, [{ ...station, values: ["1.00", "1.10", "1.20", "1.30"] }])(xml))
      .replace(/<Information type="指定河川洪水予報（河川）">[\s\S]*?<\/Information>/, ""), at + 1);
    const after = second.state.currents[0];
    expect(before.effective === "active" && after.effective === "active" ? [after.basisReportDateTimeRaw != null, after.stations, after.unreadable]
      : null).toEqual([true, before.effective === "active" ? before.stations : null, before.effective === "active" ? before.unreadable : null]);
    const restored = floodUnitCodec.decode(json(floodUnitCodec.encode(second.state)));
    expect(restored.kind === "restored" ? restored.state.currents : null).toEqual(second.state.currents);
  });

  // regression: r1 ヘルツ P2-2（AC03 (4)）。原文が予算ちょうどの normal の官署 512 件に、原文を持つ 513 件目の官署の報: 仮の state では
  // 最古の原文を外すが、件数超過で拒否して元の state に戻るので unreadableDropped を数えない（再送でも同じ）。
  it("P3-UM-T02 regression / AC03: a refused 513th office does not count the raw it would have dropped, also when resent", () => {
    const unknown = "81_03_01_260605_VPWP50_unknown_code";
    const active = ufReceive(ufMaterial(unknown));
    const seed = active.state.subjects[0];
    // 記録 1 件の原文は 2,048 byte（part と見出し文で各 1,024）、512 件で 1,048,576。
    const mark: UnreadableMark = { parts: [{ site: "bodyOther", reason: "requiredStructureInvalid", raw: "x".repeat(1_022) }], headline: "y".repeat(1_022) };
    const subjects = Array.from({ length: 512 }, (_, index) => {
      const subject = `normal/VPWP50/office${index}`;
      return { ...seed, subject, source: { ...seed.source!, subject }, unreadable: mark };
    });
    const full: WeatherTimeseriesUnitState = { ...active.state, subjects,
      gates: subjects.map((item) => ({ subject: item.subject, operation: item.operation, source: item.source! })) };
    expect(subjects.reduce((sum, item) => sum + rawBytes(item.unreadable), 0)).toBe(1_048_576);
    const material = () => ufMaterial(unknown, (xml) => xml.replaceAll("稚内地方気象台", "new-office").replace(/(<Body[^>]*>)/, "$1<Other>x</Other>"));
    for (const step of [ufReceive(material(), full), ufReceive(material(), full)])
      expect([step.decisions[0].decision, step.state === full, step.diagnostics.some((item) => item.reason === "unreadableDropped")])
        .toEqual(["capacityExceeded", true, false]);
  });

  // regression: r2 ヘルツ P2（AC03 (4)）。原文を外した記録が同じ受信の期限の回収で印の無い期限切れの記憶になったら、返す state に外した原文が
  // 残らないので unreadableDropped を数えない。列: 官署 A の報 → 48 時間後に期限切れの記憶 → 別の 64 官署の原文で予算ちょうど → A の古い
  // ReportDateTime の版が新しい Control の日時で遅着して採用され、最古の A の原文を外し、同じ受信で回収される。
  it("P3-UM-T02 regression / AC03: a late version stripped and collected in the same receive is not counted", () => {
    const NAME = "15_16_01_241031_VPWW56", HOUR = 3_600_000, t0 = Date.parse("2020-06-22T23:00:00+09:00");
    const at = (ms: number) => (xml: string) => L.retime(rIso(ms))(xml);
    const control = (ms: number) => (xml: string) => xml.replace(/(<Control>[\s\S]*?<DateTime>)[^<]*(<\/DateTime>)/, `$1${new Date(ms).toISOString()}$2`);
    const first = L.send(L.emptyState(), NAME, undefined, t0).state;
    let state = reduceLandslideUnit(first, { kind: "deadline", clock: L.clock(t0 + 48 * HOUR) }).state;
    expect(state.currents.map((item) => item.effective)).toEqual(["expired"]);
    for (let index = 0; index < 64; index++)
      state = L.send(state, NAME, (xml) => control(t0 + 49.5 * HOUR)(at(t0 + 49.5 * HOUR)(L.office(`官署${index}`)(xml))), t0 + 49.5 * HOUR).state;
    // 64 官署の記録の原文は各 2,048 byte（part と見出し文で各 1,024）、合計 131,072。
    const mark: UnreadableMark = { parts: [{ site: "kindName", reason: "requiredStructureMissing", raw: "x".repeat(1_022) }], headline: "y".repeat(1_022) };
    const full: LandslideUnitState = { ...state, currents: state.currents.map((item) => item.effective === "active" ? { ...item, unreadable: mark } : item) };
    const others = (value: LandslideUnitState) => value.currents.reduce((sum, item) => sum + (item.effective === "active" ? rawBytes(item.unreadable) : 0), 0);
    expect(others(full)).toBe(131_072);
    const late = L.send(full, NAME, (xml) => control(t0 + 50 * HOUR)(at(t0 + HOUR)(xml)).replace(
      /(<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<Item>\s*<Kind>\s*)<Name>[^<]*<\/Name>/, "$1"), t0 + 50 * HOUR);
    const own = late.state.currents.find((item) => item.subject === first.currents[0].subject);
    expect([late.decisions[0].decision, own?.effective, own != null && "unreadable" in own, others(late.state),
      late.diagnostics.some((item) => item.reason === "unreadableDropped")]).toEqual(["changed", "expired", false, 131_072, false]);
  });

  // regression: r1 ヘルツ P3-3（AC01 (4)(6)）。127 文字の観測点 code の印は scope が 126 文字に切れるので、引き継ぎも切った形で照合する。
  // 先頭 126 文字が同じ観測点がこの版で更新されたら、その scope の part は引き継がない（発注 2、Q-UM-PRECHECK-2 (8)(f)）。
  it("P3-UM-T03 regression / AC01: a 127-character station code keeps its mark when a newer version adds another station", () => {
    const at = "2099-01-01T10:00:00+09:00", at2 = "2099-01-01T10:10:00+09:00", prefix = "1".repeat(126);
    const send = (state: ReturnType<typeof T.emptyState>, xml: string) => {
      const material = T.decodeXml(xml, "VTSE51");
      return T.receive(state, material, T.clock(Date.parse(material.reportDateTimeRaw) + 1)).state;
    };
    const broken = (codes: readonly string[]) => send(T.emptyState(), T.observation({ at, serial: 1, stations: codes.map((code) => ({ code })) })
      .replace(`<Code>${prefix}a</Code>`, `<Code>${prefix}a</Code><Sensor><x/></Sensor>`));
    const first = broken([`${prefix}a`]);
    const mark = first.observations[0].unreadable;
    expect(mark?.parts.map((part) => [part.site, part.scope, part.raw])).toEqual([["station", prefix, "<Sensor><x></x></Sensor>"]]);
    const added = send(first, T.observation({ at: at2, serial: 2, stations: [{ code: "99999" }] }));
    expect(added.observations[0].unreadable).toEqual(mark);
    // 先頭が同じ code b が残り a だけ更新された版では、a の古い欠片を残さない。
    const pair = broken([`${prefix}a`, `${prefix}b`]);
    const updated = send(pair, T.observation({ at: at2, serial: 2, stations: [{ code: `${prefix}a`, condition: "第１波到達" }] }));
    expect(updated.observations[0].unreadable).toBeUndefined();
  });

  // acceptance: P3-UM-T16（AC15、P3-UM-D-ADDITION-MARK）。付加事項は原文の part（site addition、scope は Type）で、view の一覧に出さない。
  // 81_01_01 は Addition を持たないので、Base の直下に足した写しで見る。
  it("P3-UM-T16 acceptance / AC15: an Addition keeps its raw under the Property Type and stays out of the view list", () => {
    const step = ufReceive(ufMaterial(UF, (xml) => xml.replace(SIGNIFICANCY_BASE, "$1<Addition><Note>竜巻</Note></Addition>")));
    const mark = step.state.subjects[0].unreadable;
    expect([mark?.parts, step.diagnostics]).toEqual([[{ site: "addition", reason: "requiredStructureInvalid", scope: "大雨浸水危険度",
      raw: "<Addition><Note>竜巻</Note></Addition>" }], []]);
    const view = toWeatherTimeseriesView(step.state).series[0].unreadableView;
    expect(view).toEqual({ parts: [], headline: mark?.headline != null, addition: true });
    expect(JSON.stringify(view)).not.toContain("竜巻");
  });

  // acceptance: P3-UM-T17（AC15 (3)、H44 の残存リスク (12)）。同じ鍵の 2 つ目は読み飛ばして duplicateValue の part にする。
  it("P3-UM-T17 acceptance / AC15: the second period of the same key keeps the first value and marks duplicateValue", () => {
    const plain = ufReceive(ufMaterial(UF)).state.subjects[0];
    const step = ufReceive(ufMaterial(UF, (xml) => xml.replace(SIGNIFICANCY_BASE, "$1<Remark refID=\"1\">x</Remark><Remark refID=\"1\">y</Remark>")));
    const subject = step.state.subjects[0];
    expect(subject.unreadable?.parts).toEqual([{ site: "duplicateValue", reason: "requiredStructureInvalid", scope: "大雨浸水危険度",
      raw: "<Remark refID=\"1\">y</Remark>" }]);
    expect(subject.periods.length).toBe(plain.periods.length + 1);
    expect(step.diagnostics).toMatchObject([{ reason: "weatherTimeseriesElementSkipped", count: 1 }]);
  });

  // acceptance: P3-UM-T18（AC15 (4)、H44 の残存リスク (13)）。Body の直下の知らない子は bodyOther の part で、区分不明にしない。
  it("P3-UM-T18 acceptance / AC15: an unknown child directly under Body marks bodyOther and not a scope", () => {
    const step = ufReceive(ufMaterial(UF, (xml) => xml.replace(/(<Body[^>]*>)/, "$1<Other>x</Other>")));
    expect([step.state.subjects[0].unreadable?.parts, step.diagnostics]).toEqual([[{ site: "bodyOther", reason: "requiredStructureInvalid",
      raw: "<Other>x</Other>" }], []]);
  });

  // acceptance: P3-UM-T19（AC15 (5)・AC02 (6)）。時間帯を 65 個にした確率の報は truncated で、site slot に最初に落とした時間帯の欠片。
  it("P3-UM-T19 acceptance / AC15,AC02: the 65th time slot is dropped with a slot part and its fragment", () => {
    const step = Y.sendXml(Y.emptyState(), Y.probabilityXml({ slotCount: 65, areas: [{ code: "100000", daily: [10, 20, 30, 40, 50],
      slots: Array.from({ length: 65 }, () => 5) }] }), "VPTA50");
    const record = step.state.probability[0];
    expect(record.effective === "active" ? [record.truncated, record.slotCount, record.unreadable?.parts] : null).toEqual([true, 64,
      [{ site: "slot", reason: "requiredStructureInvalid", raw: `<TimeDefine timeId="65"><DateTime>${Y.iso(Date.parse("2026-05-31T09:00:00+09:00") + 64 * 3 * 3_600_000)}`
        + "</DateTime><Duration>PT3H</Duration></TimeDefine>" }]]);
  });
});
