import { describe, expect, it } from "vitest";

import type { JsonValue, UnreadableMark } from "../../contracts/p2-shared-runtime.types";
import type { BriefingUnitState } from "../../contracts/p3-briefing-unit.types";
import type { FloodUnitState } from "../../contracts/p3-flood-unit.types";
import type { LandslideUnitState } from "../../contracts/p3-landslide-unit.types";
import type { LocalBulletinsUnitState } from "../../contracts/p3-local-bulletins-unit.types";
import type { TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import type { VolcanoUnitState } from "../../contracts/p3-volcano-unit.types";
import { briefingUnitCodec } from "../../src/units/briefing/briefing-unit";
import { floodUnitCodec, toFloodView } from "../../src/units/flood/flood-unit";
import { compareColumns } from "../../src/units/unreadable";
import * as B from "../briefing-unit/briefing-fixture";
import * as R from "../flood-unit/flood-fixture";
import * as L from "../landslide-unit/landslide-fixture";
import * as M from "../local-bulletins-unit/local-bulletins-fixture";
import * as T from "../tsunami-unit/tsunami-fixture";
import * as V from "../volcano-unit/volcano-fixture";

// P3-UNREADABLE-MARK-001（K14）発注 2 の試験（T04〜T08 と T09 の AC08 の分）。読めない報は既存の fixture の写しを試験の中で壊して作る。

// U-B の i 番目の版（報の時刻と Serial が i で進む。観測実況は rainItem の列）。
const B_START = Date.parse("2024-01-24T06:13:13+09:00");
const vpbs50 = (index: number, edit: (xml: string) => string = (xml) => xml) => (xml: string) =>
  edit(B.serial(String(6 + index))(B.retime(B.iso(B_START + index * 600_000))(xml)));
const brokenOffice = (xml: string) => xml.replace("<EditorialOffice>彦根地方気象台</EditorialOffice>", "<EditorialOffice><x/>彦根地方気象台</EditorialOffice>");
const rain = (code: string, value = "10") => B.rainItem(code, `地点${code}`, value);
function chainB(edits: readonly ((xml: string) => string)[]): number[] {
  let state: BriefingUnitState = B.emptyState();
  return edits.map((edit, index) => {
    const step = B.send(state, "synthetic_VPBS50_multi", vpbs50(index, edit));
    state = step.state;
    return step.intents.length;
  });
}

// U-R の i 番目の版（synthetic_VXKO50_code31 の写し、観測所の列は stationsXml）。restoreAfter の版の後に encode→restore する。
const R_START = Date.parse("2019-05-27T10:00:00+09:00");
const rIso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
type Station = Readonly<{ code: string; levels: readonly string[]; values?: readonly string[] }>;
const station = (code: string, ...levels: string[]): Station => ({ code, levels });
const stationList = (stations: readonly Station[]) => R.stationsXml(4, stations.map((item) => ({ code: item.code, name: `観測所${item.code.slice(-1)}`,
  values: item.values ?? ["1.00", "1.10", "1.20", "1.30"], levels: item.levels })));
const brokenTime = (position: number) => (xml: string) =>
  xml.replace(new RegExp(`(<TimeDefine timeId="${position + 1}"><DateTime>)[^<]*`), "$1x");
const withoutStationCode = (code: string) => (xml: string) => xml.replace(`<Code>${code}</Code></Area>`, "</Area>");
function chainR(edits: readonly ((xml: string) => string)[], restoreAfter = -1): (string | null)[] {
  let state: FloodUnitState = R.emptyState();
  return edits.map((edit, index) => {
    const step = R.send(state, "synthetic_VXKO50_code31", (xml) => edit(R.serial(String(1 + index))(R.retime(rIso(R_START + index * 600_000))(xml))));
    state = step.state;
    if (index === restoreAfter) {
      const restored = floodUnitCodec.decode(JSON.parse(JSON.stringify(floodUnitCodec.encode(state))) as JsonValue);
      if (restored.kind !== "restored") throw new Error(restored.reason);
      state = restored.state;
    }
    return step.intents[0]?.payload.level ?? null;
  });
}

// U-T の観測（synthetic_VTSE51_fragmentA の写し）の i 番目の版。Serial は文字のまま差し替える（"x" は読めない Serial）。
const T_START = Date.parse("2011-03-11T15:02:00+09:00");
function chainT(serials: readonly string[]): string[][] {
  let state: TsunamiUnitState = T.emptyState();
  return serials.map((serial, index) => {
    const at = T_START + index * 60_000;
    const step = T.receive(state, T.decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51", (xml) => xml
      .replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${new Date(at).toISOString()}</DateTime>`)
      .replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>${rIso(at)}`).replace(/<Serial>[^<]*/, `<Serial>${serial}`)), T.clock(at + 1));
    state = step.state;
    return step.intents.map((item) => item.payload.level);
  });
}

// 報の時刻（Head/ReportDateTime と Control/DateTime）を at にする（U-L・U-M の続報）。
const shifted = (at: number) => (xml: string) => xml.replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>${rIso(at)}`)
  .replace(/(<Control>[\s\S]*?<DateTime>)[^<]*/, `$1${new Date(at).toISOString()}`);
// 竜巻（19_01_01 VPHW50 の写し、ValidDateTime 08:40）の i 番目の版の intents の数。
const M_START = Date.parse("2009-08-10T07:38:00+09:00");
function chainM(edits: readonly ((xml: string) => string)[]): number[] {
  let state: LocalBulletinsUnitState = M.emptyState();
  return edits.map((edit, index) => {
    const step = M.send(state, "19_01_01_091210_VPHW50", (xml) => edit(M.serial(String(2 + index))(shifted(M_START + index * 60_000)(xml))));
    state = step.state;
    return step.intents.length;
  });
}
const brokenHeadline = (xml: string) => xml.replace("<Text>東京地方では", "<Text><x/>東京地方では");
const allAreas = (xml: string) => xml.replace(/<Code>(\d{6,})<\/Code>/g, "<Code>x$1</Code>");
// U-L（15_16_01 VPWW56 の写し）の i 番目の版の intents の数。kindless は 3 つ目の Item の Kind/Name を消す（T01 と同じ所）。
const L_START = Date.parse("2024-10-31T05:00:00+09:00");
const kindless = (xml: string) => xml.replace(
  /(<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<Item>[\s\S]*?<\/Item>[\s\S]*?<Item>[\s\S]*?<\/Item>[\s\S]*?<Item>\s*<Kind>\s*)<Name>[^<]*<\/Name>/, "$1");
function chainL(edits: readonly ((xml: string) => string)[]): number[] {
  let state: LandslideUnitState = L.emptyState();
  return edits.map((edit, index) => {
    const step = L.send(state, "15_16_01_241031_VPWW56", (xml) => edit(shifted(L_START + index * 600_000)(xml)));
    state = step.state;
    return step.intents.length;
  });
}
// U-V（synthetic_VFVO50_continuation の写し）の i 番目の版の intents の数（Control/DateTime は fixture の補助が報の時刻に合わせる）。
const V_START = Date.parse("2020-05-22T14:54:00+09:00");
const inBody = (type: string, name: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`(<VolcanoInfo type="噴火警報・予報（${type}）">[\\s\\S]*?)<Name>${name}</Name>`), `$1<Name>${value}</Name>`);
const brokenVolcano = inBody("対象火山", "浅間山", "<x/>浅間山");
const brokenAreaKind = inBody("対象市町村等", "火口周辺警報", "<x/>火口周辺警報");
function chainV(edits: readonly ((xml: string) => string)[]): number[] {
  let state: VolcanoUnitState = V.emptyState();
  return edits.map((edit, index) => {
    const step = V.send(state, "synthetic_VFVO50_continuation", (xml) => edit(V.retime(rIso(V_START + index * 600_000))(xml)));
    state = step.state;
    return step.intents.length;
  });
}

describe("P3-UNREADABLE-MARK-001 order 2", () => {
  // regression: P3-UM-T04（K10 の残存リスク (a)）の U-B の分。
  it("P3-UM-T04 regression / AC04 (1): U-B does not ring for an unreadable editorial office and the next readable report", () => {
    expect(chainB([(xml) => xml, brokenOffice, (xml) => xml])).toEqual([2, 0, 0]);
    // 対照: C の官署が A と違えば鳴る。
    expect(chainB([(xml) => xml, brokenOffice, (xml) => xml.replace(/彦根地方気象台/g, "大津地方気象台")])).toEqual([2, 0, 2]);
  });

  it("P3-UM-T04 regression / AC04 (1)(5): U-M does not ring for an unreadable tornado headline and the next readable report", () => {
    expect(chainM([(xml) => xml, brokenHeadline, (xml) => xml])).toEqual([2, 0, 0]);
    expect(chainM([(xml) => xml, brokenHeadline, (xml) => xml.replace("東京地方では、", "東京都では、")])).toEqual([2, 0, 2]);
  });

  it("P3-UM-T04 regression / AC04 (3): U-L does not ring around an unreadable kind name", () => {
    expect(chainL([(xml) => xml, kindless, (xml) => xml])).toEqual([2, 0, 0]);
    // 対照: 名前の読める版どうしで種別の組が変われば鳴る。
    expect(chainL([(xml) => xml, kindless, L.areas([{ code: "0121400", kind: "09" }])])).toEqual([2, 0, 2]);
  });

  it("P3-UM-T04 regression / AC04 (1)(3): U-V does not ring around an unreadable volcano name or area kind name", () => {
    expect(chainV([(xml) => xml, brokenVolcano, (xml) => xml])).toEqual([2, 0, 0]);
    expect(chainV([(xml) => xml, brokenAreaKind, (xml) => xml])).toEqual([2, 0, 0]);
    expect(chainV([(xml) => xml, brokenVolcano, inBody("対象火山", "浅間山", "浅間山（別名）")])).toEqual([2, 0, 2]);
  });

  // regression: P3-UM-T05（ヘルツ r0 の Q1）。AC04 の場面: B1・B2 は官署名と観測の 1 件が読めない（直す前は B1・B2・C で 1 回ずつ鳴る）。
  it("P3-UM-T05 regression / AC04 (2): U-B observations ring only for a readable new observation", () => {
    const list = (...items: string[]) => B.observations(items);
    const broken = (...items: string[]) => (xml: string) => brokenOffice(list(...items)(xml));
    expect(chainB([list(rain("60026")), broken(rain("60026"), rain("60027", "abc")), broken(rain("60026"), rain("60028"), rain("60027", "abc")),
      list(rain("60026"), rain("60028"))])).toEqual([2, 0, 2, 0]);
  });

  // regression: P3-UM-T07（K10 の残存リスク (b)・ヘルツ r0 の Q2）。直す前は (a)(b)(c) の C が warning で鳴った。
  it("P3-UM-T07 regression / AC05: U-R does not read the observed maximum after an unreadable current as a rise", () => {
    const s3 = stationList([station("27000000000000001", "3", "3", "3", "3")]);
    const a = "27000000000000001";
    // (a) 現況の時刻が読めない B。
    expect(chainR([s3, (xml) => brokenTime(0)(s3(xml)), s3])).toEqual(["warning", null, null]);
    // (b) 唯一の観測所の区域の Code を消して stations が空の B、(c) その B の後に encode→restore。
    expect(chainR([s3, (xml) => withoutStationCode(a)(s3(xml)), s3])).toEqual(["warning", null, null]);
    expect(chainR([s3, (xml) => withoutStationCode(a)(s3(xml)), s3], 1)).toEqual(["warning", null, null]);
    // 対照: C が 4 なら鳴る。
    expect(chainR([s3, (xml) => brokenTime(0)(s3(xml)), stationList([station(a, "4", "4", "4", "4")])])).toEqual(["warning", null, "warning"]);
    // 予測の時刻だけ・水位の数字だけ読めない版は含めない（今どおり C で warning）。
    const s2 = stationList([station(a, "2", "2", "2", "2")]);
    expect(chainR([s3, (xml) => brokenTime(2)(s2(xml)), s3])).toEqual(["warning", null, "warning"]);
    expect(chainR([s3, stationList([{ code: a, levels: ["2", "2", "2", "2"], values: ["abc", "1.10", "1.20", "1.30"] }]), s3]))
      .toEqual(["warning", null, "warning"]);
    // 正規の欠測（空のレベル）は今の比べ方のまま。
    const t = "27000000000000002";
    expect(chainR([stationList([station(a, "3"), station(t, "")]), stationList([station(a, "2"), station(t, "")]),
      stationList([station(a, "3"), station(t, "")])])).toEqual(["warning", null, "warning"]);
  });

  // regression: P3-UM-T06（ヘルツ r3 の P2・r0 の Q3）。直す前は C が info で鳴った。
  it("P3-UM-T06 regression / AC04 (4): U-T does not ring for the same observation around an unreadable Serial", () => {
    expect(chainT(["4", "x", "6"])).toEqual([["info", "info"], [], []]);
    // 対照: Serial の読める版どうしは、同じ中身でも新しい版として今どおり鳴る。
    expect(chainT(["4", "5", "6"])).toEqual([["info", "info"], ["info", "info"], ["info", "info"]]);
  });

  // contractBoundary: AC04 (2) の鍵の上限 128 と、Q-UM-PRECHECK-2 (8)(a) の codec（一覧の欄の site ごとに 1 件だけ compareKeys を持つ）。
  it("P3-UM-T03 contractBoundary / AC04 (2),AC16 (3)(a): 128 compare keys, the overflowing version and the list-site codec", () => {
    const items = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ code: String(from + index) }));
    const part = (keys?: readonly string[]): UnreadableMark => ({ parts: [{ site: "area", reason: "requiredStructureInvalid", raw: null,
      ...keys == null ? {} : { compareKeys: keys } }], headline: null });
    // A の 76 区域 → B は別の 53 区域で一部が読めない（和が 129 で鍵なし）→ C の正しい 53 区域は変化として 1 回鳴る。
    const b = compareColumns(undefined, part(), [{ list: "area", before: items(0, 76), after: items(100, 53) }]);
    expect([b.changed, b.mark?.parts[0].compareKeys]).toEqual([true, undefined]);
    expect(compareColumns(b.mark, undefined, [{ list: "area", before: items(100, 53), after: items(100, 53) }]).changed).toBe(true);
    const fits = compareColumns(undefined, part(), [{ list: "area", before: items(0, 76), after: items(100, 52) }]);
    expect(fits.mark?.parts[0].compareKeys).toHaveLength(128);
    expect(compareColumns(fits.mark, undefined, [{ list: "area", before: items(100, 52), after: [...items(0, 76), ...items(100, 52)] }]).changed)
      .toBe(false);

    const state = B.send(B.emptyState(), "synthetic_VPBS50_multi", B.observations([rain("60026"), rain("60027", "abc")])).state;
    type Payload = { currents: ({ unreadable: Readonly<{ parts: readonly Readonly<Record<string, unknown>>[] }> } & Record<string, unknown>)[] };
    const payload = JSON.parse(JSON.stringify(briefingUnitCodec.encode(state))) as Payload & Record<string, JsonValue>;
    const mark = payload.currents[0].unreadable, observation = mark.parts.find((item) => item.site === "observation")!;
    const keys = (count: number) => Array.from({ length: count }, (_, index) => index.toString(16).padStart(16, "0"));
    const parts = (list: readonly Readonly<Record<string, unknown>>[]) => JSON.parse(JSON.stringify({ ...payload,
      currents: [{ ...payload.currents[0], unreadable: { ...mark, parts: list } }] })) as JsonValue;
    expect([parts([{ ...observation, compareKeys: keys(128) }]), parts([{ ...observation, compareKeys: keys(129) }]),
      parts([{ ...observation, compareKeys: keys(1) }, { ...observation, scope: "x", compareKeys: keys(1) }]),
      parts([{ ...observation, site: "editorialOffice", compareKeys: keys(1) }])].map((value) => briefingUnitCodec.decode(value).kind))
      .toEqual(["restored", "invalid", "invalid", "invalid"]);
  });

  // acceptance: P3-UM-T08（作者裁定 ②、AC06・AC07）。記録の値は空のまま。
  it("P3-UM-T08 acceptance / AC06,AC07: unreadable names and areas read （読めず） in the notification body", () => {
    const tornado = M.send(M.emptyState(), "19_01_01_091210_VPHW50", allAreas);
    const record = tornado.state.tornado[0];
    expect([tornado.intents[0].payload.body, record.effective === "active" ? record.areas : null])
      .toEqual(["発表中 53地域（読めず） / 有効期限 08:40", []]);
    // 一部の区域だけ読めない報の本文は今と同じ。
    const whole = M.send(M.emptyState(), "19_01_01_091210_VPHW50").intents[0].payload.body;
    expect(M.send(M.emptyState(), "19_01_01_091210_VPHW50", (xml) => xml.replace("<Code>130010</Code>", "<Code>x</Code>")).intents[0].payload.body)
      .toBe(whole);

    const headless = (xml: string) => xml.replace(/(<Headline>\s*)<Text>[^<]*<\/Text>/, "$1");
    const flood = R.send(R.emptyState(), "synthetic_VXKO50_code31", (xml) => headless(R.rivers([{ code: "31", name: "<x/>", rivers: [{ code: "1234567890",
      name: "<x/>" }] }])(xml)));
    const river = flood.state.currents[0];
    expect([flood.intents[0].payload.body, river.effective === "active" ? [river.kinds[0].name, river.kinds[0].rivers[0].name] : null])
      .toEqual(["（読めず） （読めず）", ["", ""]]);

    const landslide = L.send(L.emptyState(), "15_16_01_241031_VPWW56", kindless);
    const office = landslide.state.currents[0];
    expect([landslide.intents[0].payload.body.includes(" / （読めず） 8地域 / "), office.effective === "active" ? office.kinds.some((group) => group.name === "")
      : null]).toEqual([true, true]);
  });

  // acceptance: P3-UM-T09 の AC08 の分（K10 の残存リスク (e)）。印 series の scope は読めなかった最初の時刻の位置で、本文は今と同じ。
  it("P3-UM-T09 acceptance / AC08: a TimeDefine unreadable in the middle marks its position and keeps the body", () => {
    const list = stationList([station("27000000000000001", "3", "3", "3", "3")]);
    const broken = R.send(R.emptyState(), "synthetic_VXKO50_code31", (xml) => brokenTime(2)(list(xml)));
    const record = broken.state.currents[0];
    const mark = record.effective === "active" ? record.unreadable : undefined;
    expect([mark?.parts.find((item) => item.site === "series" && item.scope === "2") != null, record.effective === "active" ? record.times.length : null])
      .toEqual([true, 2]);
    expect(toFloodView(broken.state).currents[0]).toMatchObject({ unreadableView: { parts: expect.arrayContaining([{ site: "series", scope: "2", raw: true }]) } });
    expect(broken.intents[0].payload.body).toBe(R.send(R.emptyState(), "synthetic_VXKO50_code31", list).intents[0].payload.body);
  });
});
