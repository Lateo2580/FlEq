import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type {
  WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse, WeatherTimeseriesPublicSubject, WeatherTimeseriesSubject,
  WeatherTimeseriesUnitState,
} from "../../contracts/p2-weather-timeseries-unit.types";
import { serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import {
  reduceWeatherTimeseriesUnit, timeseriesPublicSubject, toWeatherTimeseriesView, weatherTimeseriesDetail, weatherTimeseriesUnit,
  weatherTimeseriesUnitCodec,
} from "../../src/units/weather-timeseries/weather-timeseries-unit";

import { keyBound } from "./uf-bound";

const DATE = Date.parse("2026-06-05T17:00:00+09:00");
const LIMIT = 33_554_432;
const FIELDS = ["areaCodes", "effective", "id", "knownCodes", "lastKnownPeriodCount", "office", "operation", "periodCount", "revision",
  "source", "subject", "unavailableReason", "unknownCode", "validUntil"];
const KNOWN = new Set(["00", "01", "11", "20", "21", "22", "30", "31", "41", "50", "51"]);
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const clock = (wallTimeMs = DATE, monotonicMs = 1) => ({ wallTimeMs, monotonicMs });
const empty = (): WeatherTimeseriesUnitState => ({ schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [],
  gates: [], intents: [], persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
    savedAckAt: null, dirtySince: null } });

type Report = Readonly<{ file: string; office?: string; report?: string; operation?: Operation; inputId?: string; edit?: (xml: string) => string }>;
const body = ({ file, office, report, operation = "normal", edit }: Report): string => {
  let xml = edit == null ? readFileSync(`test/fixtures/${file}.xml`, "utf8") : edit(readFileSync(`test/fixtures/${file}.xml`, "utf8"));
  if (office != null) xml = xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${office}</EditorialOffice>`);
  if (report != null) xml = xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${report}</ReportDateTime>`);
  return operation === "normal" ? xml : xml.replace("<Status>通常</Status>", `<Status>${operation === "training" ? "訓練" : "試験"}</Status>`);
};
function material(input: Report): DecodedMaterial {
  const entered = ingestXmlData({ inputId: input.inputId ?? `${input.file}/${input.office ?? ""}/${input.report ?? ""}`, inputSequence: 1, receivedAt: DATE,
    origin: "replay", kind: "replay", body: Buffer.from(body(input)), headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const receive = (state: WeatherTimeseriesUnitState, input: Report, at = DATE) =>
  reduceWeatherTimeseriesUnit(state, { kind: "receive", material: material(input), clock: clock(at) });
// 先頭の subject の持つ文字列 1 つで、保存の大きさを target まで伸ばす（unit の試験の inflated() と同じ）。
function inflated(state: WeatherTimeseriesUnitState, target: number): WeatherTimeseriesUnitState {
  const item = state.subjects[0], at = item.areas[0].name!;
  const base = serializedEnvelope({ schemaVersion: state.schemaVersion, unit: "U-F", generation: 0, capturedAt: 0,
    payload: weatherTimeseriesUnitCodec.encode(state), sha256: "0".repeat(64) }).byteLength + 62;
  return { ...state, subjects: state.subjects.map((subject, position) => position === 0
    ? { ...subject, strings: subject.strings.map((value, index) => index === at ? value + "x".repeat(target - base) : value) } : subject) };
}
const HIGH = "81_02_01_260605_VPWP50_high_severity", UNKNOWN = "81_03_01_260605_VPWP50_unknown_code", CANCEL = "81_04_01_260605_VPWP50_cancel";
const NAGANO = "81_09_01_260605_VPWP50";
const view = (_state: WeatherTimeseriesUnitState, revision = "9") => ({ contentRevision: revision });
const detail = (state: WeatherTimeseriesUnitState, request: WeatherTimeseriesDetailRequest, revision = "9") =>
  weatherTimeseriesDetail(state, request, view(state, revision));
const idOf = (state: WeatherTimeseriesUnitState, subject: string) =>
  timeseriesPublicSubject(state.subjects.find((item) => item.subject === subject)!).id;
const only = (state: WeatherTimeseriesUnitState) => state.subjects[0];

// 期待の件数は保存した表からでなく XML そのものから数える。
function oracle(file: string) {
  const xml = body({ file });
  const areas = [...new Set([...xml.matchAll(/<Area>(?:<Name>[^<]*<\/Name>)?<Code>([^<]*)<\/Code>/g)].map((hit) => hit[1]).filter((code) => code !== ""))].sort();
  const codes = [...xml.matchAll(/<Significancy[^>]*><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/g)].map((hit) => hit[2]);
  return { areas, known: [...new Set(codes.filter((code) => KNOWN.has(code)))].sort(), unknown: codes.filter((code) => code !== "" && !KNOWN.has(code)).length,
    periods: [...xml.matchAll(/<Significancy /g)].length };
}

describe("P3-UFP-AC01 public form", () => {
  it("P3-UFP-T03: the fields, the counts per effective, and one object across view, displayChanges, normal subjects and restore", () => {
    const high = receive(empty(), { file: HIGH, office: "a-office" }).state;
    const withUnknown = receive(high, { file: UNKNOWN, office: "b-office" }).state;
    const cancelled = receive(withUnknown, { file: CANCEL, office: "c-office" });
    // TimeSeriesInfo の無い報は active な項目の無い subject になる。
    const noItems = receive(cancelled.state, { file: HIGH, office: "d-office", edit: (xml) => xml.replace(/<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>/, "") });
    const items = Object.fromEntries(noItems.state.subjects.map((item) => [item.subject.split("/").at(-1), item]));
    const view = toWeatherTimeseriesView(noItems.state);
    const published = Object.fromEntries(view.series.map((item) => [item.office, item]));
    for (const item of view.series) expect(Object.keys(item).sort()).toEqual(FIELDS);
    const expectedHigh = oracle(HIGH), expectedUnknown = oracle(UNKNOWN);
    expect(published["a-office"]).toMatchObject({ effective: "active", areaCodes: expectedHigh.areas, knownCodes: expectedHigh.known,
      unknownCode: { unknown: expectedHigh.unknown, missing: 0, empty: 0 }, periodCount: items["a-office"].periods.length, lastKnownPeriodCount: null });
    expect(published["b-office"]).toMatchObject({ areaCodes: expectedUnknown.areas, knownCodes: expectedUnknown.known,
      unknownCode: { unknown: expectedUnknown.unknown, missing: 0, empty: 0 } });
    expect(expectedUnknown.unknown).toBeGreaterThan(0);
    // active でなければ Code も件数も無い（要約が数えるのは active の subject だけ）。
    expect(published["d-office"]).toMatchObject({ effective: "noActiveItems", areaCodes: [], knownCodes: [], periodCount: 0 });
    expect(published["c-office"]).toMatchObject({ effective: "cancelled", areaCodes: [], knownCodes: [], unknownCode: { unknown: 0, missing: 0, empty: 0 } });
    // lastKnown を持つ unavailable の subject と、持たないもの。
    const a = items["a-office"];
    const keep = { strings: a.strings, attributes: a.attributes, values: a.values, series: a.series, areas: a.areas, locals: a.locals,
      kinds: a.kinds, periods: a.periods };
    const unavailable = (lastKnown: typeof keep | null): WeatherTimeseriesSubject => ({ ...a, subject: `normal/VPWP50/u-${lastKnown == null}`,
      source: null, effective: "unavailable", unavailableReason: "coverageIncomplete", periods: [], validUntil: null, lastKnown });
    const withLast = timeseriesPublicSubject(unavailable(keep)), without = timeseriesPublicSubject(unavailable(null));
    expect(withLast).toMatchObject({ effective: "unavailable", unavailableReason: "coverageIncomplete", periodCount: 0,
      lastKnownPeriodCount: a.periods.length, areaCodes: [], knownCodes: [] });
    expect(without.lastKnownPeriodCount).toBeNull();
    // id は notice の identity、revision は object を作った step の版。
    for (const item of noItems.state.subjects) {
      const shown = published[item.subject.split("/").at(-1)!];
      expect(shown.id).toMatch(/^[0-9a-f]{64}$/);
      expect(shown.revision).toMatch(/^\d{1,16}$/);
    }
    expect(published["d-office"].revision).toBe(String(noItems.state.contentRevision));
    // 公開形式はどの経路でも同じ object（view を作り直しても変わらない subject の period は走査し直さない）。
    expect(toWeatherTimeseriesView(noItems.state).series[0]).toBe(view.series[0]);
    for (const change of noItems.displayChanges) expect(change.after?.unit === "U-F" && change.after.current).toBe(published["d-office"]);
    const restored = reduceWeatherTimeseriesUnit(empty(), { kind: "restore", persisted: weatherTimeseriesUnitCodec.encode(noItems.state), clock: clock() });
    const restoredSeries = toWeatherTimeseriesView(restored.state).series;
    expect(restored.displayChanges).toHaveLength(restoredSeries.length);
    restored.displayChanges.forEach((change, index) => expect(change.after?.unit === "U-F" && change.after.current).toBe(restoredSeries[index]));
  });
});

const withStrings = (item: WeatherTimeseriesSubject, subject: string, source: Partial<NonNullable<WeatherTimeseriesSubject["source"]>>): WeatherTimeseriesSubject =>
  ({ ...item, subject, source: { ...item.source!, ...source, subject } });

describe("P3-UFP-AC03 byte bounds", () => {
  const seed = only(receive(empty(), { file: NAGANO, office: "seed" }).state);
  const one = (item: WeatherTimeseriesSubject) => ({ ...empty(), subjects: [item] });
  const check = (item: WeatherTimeseriesSubject, premises: boolean) => {
    const state = one(item);
    const published = toWeatherTimeseriesView(state);
    const areas = published.series[0].areaCodes.length;
    // keyBound は区域 Code の (J+3) を含むので、ここで 10 x A を足さない（二重に数えない）。
    expect(utf8(published.series[0]) + utf8(published.subjects[0]) + 1 + utf8(published.semanticRevision) - 2).toBeLessThanOrEqual(keyBound(item));
    expect(utf8(published)).toBeLessThanOrEqual(512 + keyBound(item));
    // RuntimeDisplaySubject 1 件の 1,560 + 10 x A は前提の中だけで成り立つ。
    // RuntimeDisplaySubject 1 件は view の公開形式と outcome を 1 つずつ持つ（unit の displaySubject と同じ組立て）。
    const shown = { unit: "U-F", operation: item.operation, subject: item.subject, office: published.series[0].office,
      current: published.series[0], subjects: [published.subjects[0]] };
    if (premises) expect(utf8(shown)).toBeLessThanOrEqual(1_560 + 10 * areas);
    return { bytes: utf8(published.series[0]) + utf8(published.subjects[0]), areas };
  };

  it("P3-UFP-T04: one key stays within 1,510 + 10 x A in the stated premises, and within the formula beyond them", () => {
    // 前提の最長の値: 官署名 33 byte、inputId 22 文字、報時刻 29 文字、Serial 8 桁、InfoType 6 byte。
    // revision は最大桁（16 桁）にするため、内容版を上限近くまで進めた state から reducer で受ける。
    const received = receive({ ...empty(), contentRevision: 9_007_199_254_740_980 }, { file: NAGANO, office: "あ".repeat(11),
      report: "2026-06-05T17:00:00.123+09:00", inputId: `input-${"9".repeat(16)}`, edit: (xml) => xml.replace("<Serial/>", "<Serial>99999999</Serial>") }).state;
    const longest = only(received);
    expect(timeseriesPublicSubject(longest).revision).toHaveLength(16);
    expect(longest.source?.serialRaw).toBe("99999999");
    const result = check(longest, true);
    expect(result.areas).toBeGreaterThan(0);
    // 1,510 + 10 x A は、1 鍵の view の要素 2 つと semanticRevision の 1 subject 分（区切り込み）。
    const piece = utf8(toWeatherTimeseriesView(one(longest)).semanticRevision) - 2 + 1;
    expect(result.bytes + piece).toBeLessThanOrEqual(1_510 + 10 * result.areas);
    // 前提の外でも式は成り立つ: 小数秒 2,000 桁の報時刻、長い官署名、escape の多い文字列。
    check(withStrings(seed, `normal/VPWP50/${"\"\\あ".repeat(500)}`, { inputId: "i\u0001".repeat(5_000),
      reportDateTimeRaw: `2026-06-05T17:00:00.${"0".repeat(2_000)}+09:00`, serialRaw: "\"".repeat(100), infoTypeRaw: "\n".repeat(100) }), false);
  });

  it("P3-UFP-T04: at the normal-sized state (B >= 15,638,202) the restore reply and one report's reply stay within the formula", () => {
    const base = serializedEnvelope({ schemaVersion: "p2-weather-timeseries-unit-v1", unit: "U-F", generation: 0, capturedAt: 0,
      payload: weatherTimeseriesUnitCodec.encode(empty()), sha256: "0".repeat(64) }).byteLength + 62;
    const clone = (index: number) => withStrings(seed, `normal/VPWP50/office-${String(index).padStart(3, "0")}`, {});
    const size = (state: WeatherTimeseriesUnitState) => serializedEnvelope({ schemaVersion: state.schemaVersion, unit: "U-F", generation: 0,
      capturedAt: 0, payload: weatherTimeseriesUnitCodec.encode(state), sha256: "0".repeat(64) }).byteLength + 62;
    const per = utf8(clone(0)) + 1;
    let count = Math.ceil((15_638_202 - base) / per) + 1;
    const build = (n: number): WeatherTimeseriesUnitState => { const subjects = Array.from({ length: n }, (_all, index) => clone(index));
      return { ...empty(), subjects, gates: subjects.map((item) => ({ subject: item.subject, operation: item.operation, source: item.source! })) }; };
    let big = build(count);
    while (size(big) < 15_638_202) big = build(++count);
    const stored = size(big);
    expect(stored).toBeGreaterThanOrEqual(15_638_202);
    expect(stored).toBeLessThan(LIMIT);
    const bound = (state: WeatherTimeseriesUnitState) => 512 + state.subjects.reduce((sum, item) => sum + keyBound(item), 0);
    const pairs = (changes: ReturnType<typeof reduceWeatherTimeseriesUnit>["displayChanges"]) => changes.reduce((sum, change) => sum
      + 2 * (1_560 + 10 * ((change.after?.unit === "U-F" ? change.after.current?.areaCodes.length : 0) ?? 0)), 0);
    const restored = reduceWeatherTimeseriesUnit(empty(), { kind: "restore", persisted: weatherTimeseriesUnitCodec.encode(big), clock: clock() });
    const restoredView = utf8(toWeatherTimeseriesView(restored.state)), restoredChanges = utf8(restored.displayChanges);
    expect(restoredView).toBeLessThanOrEqual(bound(restored.state));
    expect(restoredChanges).toBeLessThanOrEqual(pairs(restored.displayChanges));
    const received = receive(restored.state, { file: HIGH, office: "newcomer" });
    const receivedView = utf8(toWeatherTimeseriesView(received.state)), receivedChanges = utf8(received.displayChanges);
    expect(received.displayChanges).toHaveLength(1);
    expect(receivedView).toBeLessThanOrEqual(bound(received.state));
    expect(receivedChanges).toBeLessThanOrEqual(pairs(received.displayChanges));
    if (process.env.UFP_NUMBERS != null) console.log("UFPNUM " + JSON.stringify({ subjects: count, B: stored, restoredView, restoredChanges,
      restoredRatio: stored / (restoredView + restoredChanges), receivedView, receivedChanges, receivedRatio: stored / (receivedView + receivedChanges),
      viewBound: bound(restored.state) }));
  }, 60_000);
});

describe("P3-UFP-AC06 detail pages (owner side)", () => {
  const STREAM = "00000000-0000-4000-8000-000000000000";
  const ok = (response: WeatherTimeseriesDetailResponse) => { if (response.kind !== "ok") throw new Error(`${response.reason}`); return response; };
  const periodsOf = (response: WeatherTimeseriesDetailResponse) => { const page = ok(response); if (page.part === "index") throw new Error("index"); return page; };
  const stateOf = (...reports: Report[]) => reports.reduce((state, report) => receive(state, report).state, empty());

  it("P3-UFP-T06: pages, bounds, version checks, the normal mask, lastKnown, and no change to the state", () => {
    const state = stateOf({ file: HIGH, office: "a-office" }, { file: NAGANO, office: "n-office" }, { file: HIGH, office: "t-office", operation: "training" });
    const nagano = state.subjects.find((item) => item.subject.endsWith("n-office"))!;
    const pub = timeseriesPublicSubject(nagano);
    const count = nagano.periods.length, pages = Math.ceil(count / 64);
    const current = (page: number, revision = pub.revision, id = pub.id) => detail(state, { part: "current", id, revision, page });
    const persistence = JSON.stringify(state.persistence);
    const last = periodsOf(current(pages - 1));
    expect(last).toMatchObject({ part: "current", id: pub.id, revision: pub.revision, page: pages - 1, pageCount: pages, periodCount: count });
    expect(last.periods.map((row) => row.index)).toEqual(Array.from({ length: count - 64 * (pages - 1) }, (_all, at) => 64 * (pages - 1) + at));
    expect(current(pages)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
    expect(current(-1)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
    expect(current(1.5)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
    // 行は表を引いた保存内容そのもの（区域は [Code, 名前] の文字列）。
    const first = periodsOf(current(0)).periods[0].period;
    expect(first[3]).toEqual([nagano.strings[nagano.areas[nagano.periods[0][1]].code], nagano.strings[nagano.areas[nagano.periods[0][1]].name!]]);
    // 版の照合: subject の版、消えた id、索引の内容版。
    expect(current(0, "999999")).toEqual({ kind: "error", reason: "versionChanged", revision: pub.revision });
    expect(current(0, pub.revision, "0".repeat(64))).toEqual({ kind: "error", reason: "versionChanged", revision: null });
    expect(detail(state, { part: "index", revision: "8", page: 0 })).toEqual({ kind: "error", reason: "versionChanged", revision: "9" });
    expect(detail(state, { part: "index", revision: "9", page: 1 })).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
    // lastKnown が無ければ最初のページが空で、その先のページは invalid。
    expect(detail(state, { part: "lastKnown", id: pub.id, revision: pub.revision, page: 0 })).toMatchObject({ kind: "ok", part: "lastKnown", pageCount: 1, periodCount: 0, periods: [], omitted: [] });
    expect(detail(state, { part: "lastKnown", id: pub.id, revision: pub.revision, page: 1 })).toMatchObject({ kind: "error", reason: "invalidRequest" });
    const carrier: WeatherTimeseriesSubject = { ...nagano, subject: "normal/VPWP50/k-office", source: { ...nagano.source!, subject: "normal/VPWP50/k-office" },
      effective: "unavailable", unavailableReason: "capacityExceeded", periods: [], validUntil: null,
      lastKnown: { strings: nagano.strings, attributes: nagano.attributes, values: nagano.values, series: nagano.series, areas: nagano.areas,
        locals: nagano.locals, kinds: nagano.kinds, periods: nagano.periods } };
    const holder = { ...state, subjects: [...state.subjects, carrier] };
    const carried = timeseriesPublicSubject(carrier);
    expect(weatherTimeseriesDetail(holder, { part: "lastKnown", id: carried.id, revision: carried.revision, page: pages - 1 }, view(holder))).toMatchObject({
      kind: "ok", part: "lastKnown", periodCount: count, pageCount: pages });
    // 索引は view の順で 1 ページ 32 件。normal も載せて返す（P3-CC-AC01(5)）。
    const index = ok(detail(state, { part: "index", revision: "9", page: 0 }));
    expect(index).toMatchObject({ part: "index", subjectCount: 3, pageCount: 1 });
    if (index.part === "index") expect(index.entries.map((entry) => entry.id)).toEqual(state.subjects.map((item) => timeseriesPublicSubject(item).id));
    expect(detail(state, { part: "current", id: pub.id, revision: pub.revision, page: 0 })).toMatchObject({ kind: "ok" });
    const trainingPub = timeseriesPublicSubject(state.subjects[2]);
    expect(detail(state, { part: "current", id: trainingPub.id, revision: trainingPub.revision, page: 0 })).toMatchObject({ kind: "ok" });
    // 40 件は 32 + 8 に分かれ、長い官署名は 256 byte で切って印を付ける。
    const many = { ...empty(), subjects: Array.from({ length: 40 }, (_all, at) => ({ ...carrier, subject: `normal/VPWP50/${at === 0 ? "あ".repeat(400) : `o-${at}`}`, source: null })) };
    const firstPage = ok(detail(many, { part: "index", revision: "9", page: 0 })), secondPage = ok(detail(many, { part: "index", revision: "9", page: 1 }));
    if (firstPage.part === "index" && secondPage.part === "index") {
      expect(firstPage.entries).toHaveLength(32);
      expect(secondPage.entries).toHaveLength(8);
      expect(firstPage).toMatchObject({ pageCount: 2, subjectCount: 40 });
      expect(Buffer.byteLength(firstPage.entries[0].office)).toBe(255);
      expect(firstPage.entries[0]).toMatchObject({ officeTruncated: true });
      expect(firstPage.entries[1].officeTruncated).toBe(false);
    }
    // 読んでも state は変わらない。
    expect(JSON.stringify(state.persistence)).toBe(persistence);
    expect(state.contentRevision).toBe(stateOf({ file: HIGH, office: "a-office" }, { file: NAGANO, office: "n-office" }, { file: HIGH, office: "t-office", operation: "training" }).contentRevision);
  });

  it("P3-UFP-T06: a training subject that is kept, goes unavailable, is evicted and accepted again never reuses a revision", () => {
    const at = (report: string) => Date.parse(report) + 60_000;
    const T1 = "2026-06-05T17:00:00+09:00", T2 = "2026-06-05T17:30:00+09:00";
    const x = (file: string, report?: string): Report => ({ file, office: "x-office", operation: "training", report });
    const seeded = only(receive(empty(), { file: UNKNOWN, office: "blocker" }).state);
    // validUntil を持たせない: 時計が fixture の有効期間を過ぎても、blocker は膨らませたままにする。
    const blockerItem = { ...seeded, subject: "normal/VPWP50/blocker", validUntil: null };
    const base: WeatherTimeseriesUnitState = { ...empty(), subjects: [blockerItem], gates: [{ subject: blockerItem.subject, operation: "normal", source: blockerItem.source! }] };
    const roomy = inflated(base, LIMIT - 300_000);
    const smallBlocker = roomy.subjects[0];
    const pubX = (state: WeatherTimeseriesUnitState) => timeseriesPublicSubject(state.subjects.find((item) => item.subject.endsWith("x-office"))!);
    // t1 は収まる。残り 50 KB に入らない長野の報で、X は t1 を lastKnown に持つ unavailable になる。
    const kept = receive(roomy, x(UNKNOWN, T1), at(T1));
    expect(pubX(kept.state)).toMatchObject({ effective: "active" });
    // 時計は T1/T2 に置く。後の時計だと fixture の有効期間が切れ、押し込む前に lastKnown が空になる。
    const squeezed = receive(inflated(kept.state, LIMIT - 50_000), x(NAGANO), at(T1));
    expect(pubX(squeezed.state)).toMatchObject({ effective: "unavailable", unavailableReason: "capacityExceeded" });
    const t1Count = pubX(squeezed.state).lastKnownPeriodCount!;
    expect(t1Count).toBeGreaterThan(0);
    // 収まらない別の training subject が X を丸ごと退去させる（gate も消える）。そのあと X を t2 として受け直す。
    const evicted = receive(squeezed.state, { file: NAGANO, office: "y-office", operation: "training" });
    expect(evicted.state.subjects.some((item) => item.subject.endsWith("x-office"))).toBe(false);
    expect(evicted.state.gates.some((item) => item.subject.endsWith("x-office"))).toBe(false);
    const again = receive({ ...evicted.state, subjects: [smallBlocker, ...evicted.state.subjects.slice(1)] }, x(HIGH, T2), at(T2));
    expect(pubX(again.state)).toMatchObject({ effective: "active" });
    const second = receive(inflated(again.state, LIMIT - 50_000), x(NAGANO), at(T2));
    const final = pubX(second.state);
    expect(final).toMatchObject({ effective: "unavailable" });
    expect(final.lastKnownPeriodCount).toBeGreaterThan(0);
    expect(final.lastKnownPeriodCount).not.toBe(t1Count);
    const revisions = [kept, squeezed, again, second].map((step) => pubX(step.state).revision);
    expect(new Set(revisions).size).toBe(4);
    // 最初の unavailable の版への要求はもう合わず、今の版なら合う。
    const stale = detail(second.state, { part: "lastKnown", id: final.id, revision: revisions[1], page: 0 });
    expect(stale).toEqual({ kind: "error", reason: "versionChanged", revision: final.revision });
    expect(detail(second.state, { part: "lastKnown", id: final.id, revision: final.revision, page: 0 })).toMatchObject({ kind: "ok", periodCount: final.lastKnownPeriodCount });
  });

  it("P3-UFP-T07: a row over the budget is named, never cut; the page stays complete JSON within 65,536 bytes", () => {
    const seed = only(receive(empty(), { file: NAGANO, office: "heavy" }).state);
    const strings = [...seed.strings];
    strings[seed.areas[0].name!] = "x".repeat(70_000);
    const heavy: WeatherTimeseriesSubject = { ...seed, strings };
    const state = { ...empty(), subjects: [heavy] };
    const pub = timeseriesPublicSubject(heavy);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      let seen = false;
      for (let page = 0; page < Math.ceil(heavy.periods.length / 64) && !seen; page++) {
        const response = detail(state, { part: "current", id: pub.id, revision: pub.revision, page });
        const text = JSON.stringify({ streamId: STREAM, ...response });
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65_536);
        expect(JSON.parse(text)).toBeDefined();
        const result = periodsOf(response);
        if (result.omitted.length === 0) continue;
        seen = true;
        expect(result.omitted.every((row) => row.reason === "pageBudget")).toBe(true);
        expect(result.omitted.length + result.periods.length).toBe(Math.min(64, heavy.periods.length - 64 * page));
        expect(result.periods.length).toBeGreaterThanOrEqual(0);
      }
      expect(seen).toBe(true);
      // 読む側が JSON にするのは subject 全体・snapshot・state 全体のどれでもない。
      for (const [value] of stringify.mock.calls) {
        expect(value === state || value === state.subjects || value === heavy).toBe(false);
        if (value != null && typeof value === "object") expect("strings" in value && "periods" in value).toBe(false);
      }
    } finally { stringify.mockRestore(); }
    // 版違いの答えは 64 文字の streamId でも小さい。
    const small = JSON.stringify({ streamId: "s".repeat(64), ...detail(state, { part: "current", id: pub.id, revision: "1", page: 0 }) });
    expect(Buffer.byteLength(small)).toBeLessThanOrEqual(256);
  });

  it("P3-UFP-T08: Nagano's current has no omitted row on any page; the largest page is recorded", () => {
    const nagano = only(receive(empty(), { file: NAGANO, office: "nagano" }).state);
    const state = { ...empty(), subjects: [nagano] };
    const pub = timeseriesPublicSubject(nagano);
    const pages = Math.ceil(nagano.periods.length / 64);
    let largest = 0, seen = 0;
    for (let page = 0; page < pages; page++) {
      const response = periodsOf(detail(state, { part: "current", id: pub.id, revision: pub.revision, page }));
      expect(response.omitted).toEqual([]);
      seen += response.periods.length;
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify({ streamId: STREAM, ...response })));
    }
    expect(seen).toBe(nagano.periods.length);
    expect(largest).toBeLessThanOrEqual(65_536);
    if (process.env.UFP_NUMBERS != null) console.log("UFPNUM " + JSON.stringify({ naganoPeriods: nagano.periods.length, pages, largestPageBytes: largest }));
  }, 60_000);
});
