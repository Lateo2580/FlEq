import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { WeatherCurrentSnapshot, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherCurrentDetailResponse } from "../../contracts/p3-uw-canon.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { VPNO_TYPE, reduceWeatherCurrentMeaning } from "../../src/domains/weather-current/weather-current";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { weatherCurrentAreas, weatherCurrentDetail } from "../../src/units/weather-current/weather-current-public";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { noticeReserve } from "../../src/units/weather-current/weather-current-notice";

// P3-UW-CANON-001 の unit の側（件数・深さ・byte の縮退・合わせ・公開形・詳細の 1 ページ・受信経路の計算量）。
const NOW = 1_800_000_000_000;
const LIMIT = weatherCurrentUnitCodec.maxEnvelopeBytes!;
const empty = (): WeatherCurrentUnitState => initialUnits["U-W"];
const clock = (monotonicMs = 0) => ({ wallTimeMs: NOW, monotonicMs });
const KYOTO = "15_16_02_251222_VPWW57", MATSUE = "15_17_01_251222_VPWW55", NATIONAL = "15_18_01_250630_VPWS50";
const FUKUI = "18_00_01_260830_VPWW55_fukui_L5", RELEASE = "18_00_01_260830_VPWW55_fukui_release";

function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: NOW, origin: "replay", kind: "replay",
    body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))), headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const receive = (state: WeatherCurrentUnitState, material: DecodedMaterial, monotonicMs = 0) =>
  reduceWeatherCurrentUnit(state, { kind: "receive", material, clock: clock(monotonicMs) });
const office = (name: string) => (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
const at = (time: string) => (xml: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
const operation = (value: Operation) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${{ normal: "通常", training: "訓練", test: "試験" }[value]}</Status>`);
const inBody = (change: (body: string) => string) => (xml: string) => { const start = xml.indexOf("<Body"); return xml.slice(0, start) + change(xml.slice(start)); };
const cancel = (time: string) => (xml: string) => at(time)(xml).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>").replace(/<Body[\s\S]*<\/Body>/, "<Body/>");
// 合成の全国報は Body の Warning を区域ごとの Item に直して使う（weather-current-unit.test.ts の bodyWarning と同じ）。
function bodyWarning(xml: string): string {
  const information = xml.match(/<Information type="気象警報・注意報（市町村等）">([\s\S]*?)<\/Information>/)?.[1];
  if (information == null) throw new Error("fixture has no warning information");
  const items = information.replace(/<\/Kind>/g, "<Status>発表</Status></Kind>").replace(/<Areas[^>]*>([\s\S]*?)<\/Areas>/g, "$1");
  return xml.replace(/<Body[^>]*\/>/, `<Body><Warning type="気象警報・注意報（市町村等）">${items}</Warning></Body>`);
}
const compose = (...steps: ((xml: string) => string)[]) => (xml: string) => steps.reduce((value, step) => step(value), xml);
// 公開形の比べ（版と復元の印の数は除く）。
const comparable = (state: WeatherCurrentUnitState) => weatherCurrentAreas(state).map(({ revision: _revision, restoredCellCount: _restored, names: _names, ...rest }) => rest)
  .sort((left, right) => left.subject < right.subject ? -1 : 1);
function rows(state: WeatherCurrentUnitState, prefecture: string, operationValue: Operation = "normal") {
  const area = weatherCurrentAreas(state).find((item) => item.prefecture === prefecture && item.operation === operationValue);
  if (area == null) return null;
  const pages: WeatherCurrentDetailResponse[] = [];
  for (let page = 0, count = 1; page < count; page++) {
    const value = weatherCurrentDetail(state, { unit: "U-W", part: "areas", id: area.id, revision: area.revision, page }, { contentRevision: String(state.contentRevision) });
    pages.push(value);
    count = value.kind === "ok" ? value.pageCount : 0;
  }
  return pages.flatMap((page) => page.kind === "ok" && page.part !== "index" ? page.rows.map((item) => item.row) : []);
}
const codeOf = (token: string): string => { const parsed: unknown = JSON.parse(token); return Array.isArray(parsed) && typeof parsed[4] === "string" ? parsed[4] : ""; };
const without = (values: readonly (readonly unknown[])[] | null) => (values ?? []).map((row) => row.slice(0, 6));

describe("P3-UWC-T01 acceptance (AC01): normal partials up to 384 without eviction, training・test 64 with eviction", () => {
  it("adopts the 129th and the 145th normal subjects, refuses only the 385th, and evicts only within training・test", () => {
    let state = empty();
    for (let index = 0; index < 384; index++) {
      const step = receive(state, decode(MATSUE, "VPWW55", office(`官署${index}`), `n${index}`));
      if (index === 128 || index === 144) expect([index, step.decisions[0].decision]).toEqual([index, "changed"]);
      state = step.state;
    }
    expect(state.partials).toHaveLength(384);
    const refused = receive(state, decode(MATSUE, "VPWW55", office("鍵の外の官署"), "n384"));
    expect(refused.state.unavailable).toMatchObject([{ subject: "normal/VPWW55/鍵の外の官署", reason: "capacityExceeded", lastKnown: null }]);
    expect(refused.diagnostics).toEqual([{ level: "WARN", component: "weather-current", reason: "capacityRejected", unit: "U-W", inputId: "n384" }]);
    expect(refused.state.partials).toEqual(state.partials);
    // training・test は合算 64 件。normal の満杯でも受け、65 件目は training・test の最古を 1 件退去する（normal は消えない）。
    for (let index = 0; index < 64; index++)
      state = receive(state, decode(MATSUE, "VPWW55", compose(office(`訓練${index}`), operation(index % 2 ? "test" : "training"),
        at(`2024-11-02T${12 + Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}:00+09:00`)), `t${index}`)).state;
    expect([state.partials.filter((item) => item.operation === "normal").length, state.partials.length]).toEqual([384, 448]);
    const evicting = receive(state, decode(MATSUE, "VPWW55", compose(office("訓練64"), operation("training"), at("2024-11-02T13:30:00+09:00")), "t64"));
    expect(evicting.diagnostics).toContainEqual({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(evicting.state.partials.some((item) => item.source.inputId === "t0")).toBe(false);
    expect([evicting.state.partials.filter((item) => item.operation === "normal").length, evicting.state.partials.length]).toEqual([384, 448]);
  }, 60_000);
});

describe("P3-UWC-T02 acceptance (AC02): a partial keeps two earlier versions", () => {
  it("rolls back twice and marks the third cancel historyUnavailable", () => {
    let state = empty();
    for (const minute of ["00", "10", "20", "30"]) state = receive(state, decode(KYOTO, "VPWW57", at(`2020-06-22T23:${minute}:00+09:00`), `v${minute}`)).state;
    expect(state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId)).toEqual(["v10", "v20"]);
    state = receive(state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:40:00+09:00"), "c1")).state;
    state = receive(state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:41:00+09:00"), "c2")).state;
    expect([state.partials[0].source.inputId, state.histories]).toEqual(["v10", []]);
    const third = receive(state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:42:00+09:00"), "c3"));
    expect(third.state.unavailable).toMatchObject([{ reason: "historyUnavailable" }]);
  });
});

describe("P3-UWC-T03 contractBoundary (AC08): a v7 save restores the same merge", () => {
  it("keeps the public forms, the detail rows and a same-version winner across encode, decode and restore", () => {
    const kyoto = receive(empty(), decode(KYOTO, "VPWW57")).state.partials[0];
    const clone = (index: number, operationValue: Operation): WeatherCurrentSnapshot => {
      const subject = `${operationValue}/VPWW57/官署${index}`;
      return { ...kyoto, subject, operation: operationValue, office: `官署${index}`, source: { ...kyoto.source, subject, operation: operationValue, inputId: `k${operationValue}${index}` } };
    };
    let state = receive(empty(), decode(NATIONAL, "VPWS50")).state;
    // 同じ版（同じ報時刻と Control/DateTime）の 2 つの partial が同じ区域×Code を持つ。勝つのは compareSnapshot の順で先の報。
    state = receive(state, decode(FUKUI, "VPWW55", office("福井A"), "tie-a")).state;
    state = receive(state, decode(FUKUI, "VPWW55", compose(office("福井B"), inBody((body) => body.replace(/<Status>継続<\/Status>/g, "<Status>発表</Status>"))), "tie-b")).state;
    state = { ...state, partials: [...state.partials, ...Array.from({ length: 382 }, (_, index) => clone(index, "normal")),
      ...Array.from({ length: 64 }, (_, index) => clone(index, index % 2 ? "test" : "training"))] };
    state = { ...state, histories: [{ subject: kyoto.subject, operation: "normal", reports: [clone(1000, "normal"), clone(1001, "normal")]
      .map((item) => ({ ...item, subject: kyoto.subject, source: { ...item.source, subject: kyoto.subject } })) }] };
    const encoded = weatherCurrentUnitCodec.encode(state);
    const restored = reduceWeatherCurrentUnit(empty(), { kind: "restore", persisted: encoded, clock: clock() }).state;
    expect(weatherCurrentUnitCodec.decode(encoded)).toMatchObject({ kind: "restored", state: { partials: state.partials, histories: state.histories } });
    expect(comparable(restored).map(({ areas: _areas, codes: _codes, ...rest }) => rest)).toEqual(comparable(state).map(({ areas: _areas, codes: _codes, ...rest }) => rest));
    // 復元の印の行は active に数えないので、復元した直後は areas・codes が空。採用し直せば元と同じ。
    expect(weatherCurrentAreas(restored).every((item) => item.areas.length === 0 && item.restoredCellCount === item.cellCount)).toBe(true);
    for (const prefecture of ["18", "26", "13"]) expect(without(rows(restored, prefecture))).toEqual(without(rows(state, prefecture)));
    expect(rows(state, "18")?.find((row) => row[1] === "180011" && row[2] === "33")?.[3]).toBe("継続");
    const decoded = weatherCurrentUnitCodec.decode(encoded);
    if (decoded.kind !== "restored") throw new Error("decode");
    expect(comparable({ ...decoded.state, contentRevision: 0 })).toEqual(comparable(state));
  });
});

describe("P3-UWC-T04 acceptance (AC04): the national report and partials merge per area and Code", () => {
  const base = () => receive(empty(), decode(NATIONAL, "VPWS50")).state;
  const code15 = inBody((body) => body.replace(/<Code>(?:03|10)<\/Code>/g, "<Code>15</Code>"));
  it("a newer partial row (a release too) replaces the national row of the same area and Code; an older one does not", () => {
    const national = base();
    const nationalRow = rows(national, "18")!.find((row) => row[1] === "180000" && row[2] === "15")!;
    expect(nationalRow[5]).toBe("2019-10-12T09:09:00+09:00");
    const released = receive(receive(national, decode(FUKUI, "VPWW55")).state, decode(RELEASE, "VPWW55", code15)).state;
    expect(rows(released, "18")!.filter((row) => row[1] === "180000" && row[2] === "15").map((row) => [row[3], row[5]]))
      .toEqual([["解除", "2026-08-30T20:04:00+09:00"]]);
    // 『なし』（Code の無い行）は全国報の行を消さない。180020 は partial が『なし』でも全国報の行のまま。
    expect(rows(released, "18")!.filter((row) => row[1] === "180020").map((row) => row[5])).toEqual(rows(national, "18")!.filter((row) => row[1] === "180020").map((row) => row[5]));
    const older = receive(national, decode(RELEASE, "VPWW55", compose(code15, at("2019-01-01T00:00:00+09:00")), "older")).state;
    expect(rows(older, "18")!.filter((row) => row[1] === "180000" && row[2] === "15").map((row) => [row[3], row[5]])).toEqual([[nationalRow[3], nationalRow[5]]]);
  });
  it("an area the national report still carries after a VPNO50 ending stays the national report's, so an older partial row does not come back", () => {
    // r0 品質の P2: 06:00 の partial が 180000 に Code 03、07:00 の全国報が同じ区域に Code 33 と 180010 に Code 15、11:40 の VPNO50 が 33 を外す。
    const items = (pairs: readonly (readonly [string, string])[]) => (xml: string) => xml.replace(/<Body[\s\S]*<\/Body>/, `<Body><Warning type="気象警報・注意報（府県予報区等）">${
      pairs.map(([area, code]) => `<Item><Kind><Code>${code}</Code><Status>発表</Status></Kind><Area><Code>${area}</Code></Area></Item>`).join("")}</Warning></Body>`);
    let state = receive(empty(), decode(FUKUI, "VPWW55", compose(items([["180000", "03"]]), at("2026-08-30T06:00:00+09:00")), "old-partial")).state;
    state = receive(state, decode(FUKUI, "VPWS50", compose(items([["180000", "33"], ["180010", "15"]]), at("2026-08-30T07:00:00+09:00")), "national")).state;
    const ended = receive(state, decode("18_00_01_260830_VPNO50_switch", "VPNO50"));
    expect(Object.entries(ended.state.national.normal!.phenomena).map(([token, value]) => [codeOf(token), value])).toEqual([["180000", []], ["180010", [{ status: "発表", code: "15", name: null }]]]);
    const restored = reduceWeatherCurrentUnit(empty(), { kind: "restore", persisted: weatherCurrentUnitCodec.encode(ended.state), clock: clock() }).state;
    for (const value of [ended.state, restored]) expect(rows(value, "18")!.map((row) => [row[1], row[2]])).toEqual([["180010", "15"]]);
    // 空になった区域は府県の行も要約の active も変えない（active は 180010 の 15 だけ）。
    expect(weatherCurrentAreas(ended.state)).toMatchObject([{ prefecture: "18", codes: { "15": 1 }, areas: [["prefecture", "180010"]], cellCount: 1 }]);
  });
  it("a storm-surge area the national report does not carry comes from the partial even when it is older", () => {
    const state = receive(base(), decode(KYOTO, "VPWW57", at("2019-01-01T00:00:00+09:00"), "older-kyoto")).state;
    const kyoto = rows(state, "26")!;
    expect(kyoto.filter((row) => row[1] === "2635999").map((row) => row[5])).not.toEqual([]);
    expect(kyoto.filter((row) => row[1] === "2635999").every((row) => row[5] === "2019-01-01T00:00:00+09:00")).toBe(true);
    expect(kyoto.filter((row) => row[1] === "260000").every((row) => row[5] === "2019-10-12T09:09:00+09:00")).toBe(true);
  });
  it("of two partials of the same version the one earlier in the compareSnapshot order stays, before and after a restore", () => {
    let state = receive(empty(), decode(FUKUI, "VPWW55", office("福井B"), "tie-b")).state;
    state = receive(state, decode(FUKUI, "VPWW55", compose(office("福井A"), inBody((body) => body.replace(/<Status>継続<\/Status>/g, "<Status>発表</Status>"))), "tie-a")).state;
    // 福井A が subject の順で先なので、受けた順に依らず 発表 の行が勝つ。
    const winner = (value: WeatherCurrentUnitState) => rows(value, "18")!.filter((row) => row[1] === "180011").map((row) => row[3]);
    expect(winner(state)).toEqual(["発表"]);
    const restored = reduceWeatherCurrentUnit(empty(), { kind: "restore", persisted: weatherCurrentUnitCodec.encode(state), clock: clock() }).state;
    expect(winner(restored)).toEqual(["発表"]);
  });
});

describe("P3-UWC-T05 contractBoundary (AC05): the view carries public forms only", () => {
  it("has no phenomena, exactly the typed fields, areas and codes from the active winners, and a new object when only a winner's value changes", () => {
    // 府県 18 の source は新しい別の報（福井X、Code を 2x に替えて行が重ならない）なので、福井の続報で変わるのは勝った行の値だけ。
    const newest = decode(FUKUI, "VPWW55", compose(office("福井X"), at("2026-08-30T10:00:00+09:00"), inBody((body) => body.replace(/<Code>\d(\d)<\/Code>/g, "<Code>2$1</Code>"))), "newest");
    const first = receive(receive(receive(empty(), decode(NATIONAL, "VPWS50")).state, newest).state, decode(FUKUI, "VPWW55"));
    const view = toWeatherCurrentView(first.state);
    expect(JSON.stringify([view, first.displayChanges]).includes("phenomena")).toBe(false);
    const area = view.areas.find((item) => item.prefecture === "18")!;
    expect(Object.keys(area).sort()).toEqual(["areas", "cellCount", "codes", "id", "names", "operation", "prefecture", "restoredCellCount", "revision", "source", "subject"]);
    const active = rows(first.state, "18")!.filter((row) => row[2] != null && row[2] !== "00" && row[3] !== "解除" && row[3] !== "発表警報・注意報はなし");
    expect(Object.values(area.codes).reduce((sum, value) => sum + value, 0)).toBe(new Set(active.map((row) => `${row[0]}|${row[1]}|${row[2]}`)).size);
    expect(area.areas.length).toBe(new Set(active.map((row) => `${row[0]}|${row[1]}`)).size);
    // 同じ Code のまま 継続→発表 だけが変わる続報（公開形の欄は同じでも勝った行の値が変わる）。
    const next = receive(first.state, decode(FUKUI, "VPWW55", compose(at("2026-08-30T06:52:00+09:00"),
      inBody((body) => body.replace(/<Status>継続<\/Status>/g, "<Status>発表</Status>"))), "status-only"));
    const after = toWeatherCurrentView(next.state).areas.find((item) => item.prefecture === "18")!;
    expect([after === area, after.source, after.codes, after.revision, next.displayChanges.some((change) => change.subject === "normal/area/18")])
      .toEqual([false, area.source, area.codes, String(next.state.contentRevision), true]);
  });
});

describe("P3-UWC-T06 contractBoundary (AC06): one detail page", () => {
  const state = () => {
    const national = receive(empty(), decode(NATIONAL, "VPWS50")).state;
    const lost = receive(receive(national, decode(KYOTO, "VPWW57")).state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:10:00+09:00"), "kyoto-cancel")).state;
    return lost;
  };
  it("answers the last pages, refuses pageCount, and reports a changed version or a vanished id", () => {
    const value = state(), view = { contentRevision: String(value.contentRevision) };
    const index = weatherCurrentDetail(value, { unit: "U-W", part: "index", revision: view.contentRevision, page: 0 }, view);
    if (index.kind !== "ok" || index.part !== "index") throw new Error("index");
    const last = index.pageCount - 1, entries = Array.from({ length: index.pageCount }, (_, page) => {
      const listed = weatherCurrentDetail(value, { unit: "U-W", part: "index", revision: view.contentRevision, page }, view);
      return listed.kind === "ok" && listed.part === "index" ? listed.entries : [];
    }).flat();
    // (operation, part, key) の順。areas の後に lastKnown。
    expect([entries.length, entries.at(-1)?.part, index.entryCount]).toEqual([index.entryCount, "lastKnown", entries.length]);
    expect(weatherCurrentDetail(value, { unit: "U-W", part: "index", revision: view.contentRevision, page: last }, view)).toMatchObject({ kind: "ok", page: last });
    expect(weatherCurrentDetail(value, { unit: "U-W", part: "index", revision: view.contentRevision, page: index.pageCount }, view)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
    expect(weatherCurrentDetail(value, { unit: "U-W", part: "index", revision: "999", page: 0 }, view)).toEqual({ kind: "error", reason: "versionChanged", revision: view.contentRevision });
    for (const entry of entries.filter((item) => item.part === "lastKnown" || item.key === "13")) {
      const pageCount = Math.max(1, Math.ceil(entry.rowCount / 256));
      expect(weatherCurrentDetail(value, { unit: "U-W", part: entry.part, id: entry.id, revision: entry.revision, page: pageCount - 1 }, view)).toMatchObject({ kind: "ok", rowCount: entry.rowCount, pageCount });
      expect(weatherCurrentDetail(value, { unit: "U-W", part: entry.part, id: entry.id, revision: entry.revision, page: pageCount }, view)).toEqual({ kind: "error", reason: "invalidRequest", revision: null });
      expect(weatherCurrentDetail(value, { unit: "U-W", part: entry.part, id: entry.id, revision: "0", page: 0 }, view)).toEqual({ kind: "error", reason: "versionChanged", revision: entry.revision });
    }
    expect(weatherCurrentDetail(value, { unit: "U-W", part: "areas", id: "0".repeat(64), revision: "1", page: 0 }, view)).toEqual({ kind: "error", reason: "versionChanged", revision: null });
  });
  it("keeps the HTTP body with a 64-character streamId at or under 65,536 bytes and names every row of the page once", () => {
    const longName = "名".repeat(20_480), name = "x".repeat(1_000);
    const phenomena = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [
      JSON.stringify(["VPWW55", "partial", "福井地方気象台", "気象警報・注意報（市町村等）", String(1_800_000 + index)]),
      [{ status: "発表", code: "03", name: index === 0 ? longName : name }]]));
    const fukui = receive(empty(), decode(FUKUI, "VPWW55")).state;
    const value: WeatherCurrentUnitState = { ...fukui, partials: [{ ...fukui.partials[0], phenomena }] };
    const area = weatherCurrentAreas(value)[0];
    const page = weatherCurrentDetail(value, { unit: "U-W", part: "areas", id: area.id, revision: area.revision, page: 0 }, { contentRevision: "0" });
    if (page.kind !== "ok" || page.part === "index") throw new Error("page");
    const body = JSON.stringify({ streamId: "s".repeat(64), ...page });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65_536);
    expect(JSON.parse(body)).toEqual({ streamId: "s".repeat(64), ...page });
    expect(page.omitted).toContainEqual({ index: 0, reason: "pageBudget" });
    expect([...page.rows.map((item) => item.index), ...page.omitted.map((item) => item.index)].sort((a, b) => a - b)).toEqual(Array.from({ length: 256 }, (_, index) => index));
    expect(page.rows.length).toBeGreaterThan(0);
  });
});

describe("P3-UWC-T08 acceptance (AC03・AC02): the byte budget drops the oldest normal history versions before refusing", () => {
  const unused = (generation: number) => 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES
    - (JSON.stringify(generation).length - 1) - (JSON.stringify(NOW).length - 1);
  const reserved = (value: WeatherCurrentUnitState) => serializedEnvelope({ schemaVersion: value.schemaVersion, unit: "U-W", generation: value.persistence.currentGeneration,
    capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64) }).byteLength + unused(value.persistence.currentGeneration);
  // 外せない normal の partial を伸ばして、受理の後の予約込みの大きさを器＋over にする（ASCII の詰め物なので byte は線形）。
  const padded = (state: WeatherCurrentUnitState, length: number): WeatherCurrentUnitState => ({ ...state,
    partials: [...state.partials.filter((item) => item.office !== "詰め物"), { ...state.partials[0], subject: "normal/VPWW55/詰め物", office: "詰め物",
      source: { ...state.partials[0].source, subject: "normal/VPWW55/詰め物", inputId: "pad" }, phenomena: { padding: "x".repeat(length) } }] });
  const sized = (state: WeatherCurrentUnitState, material: DecodedMaterial, over: number) => {
    const probe = receive(padded(state, 0), material);
    expect(probe.diagnostics).toEqual([]);
    // P3-WN-AC06 (3)（Q-WN-EXISTING-TESTS (5)）: 受理の器の判定は通知を足す前の state で、intents を 131,072 byte と数え、受けた報の系列の印 1 件の上界を足す。
    return padded(state, LIMIT - reserved({ ...probe.state, intents: [], notices: state.notices }) - 131_072 - noticeReserve(probe.decisions[0]) + over);
  };
  it("adopts by dropping the oldest version, keeps every normal current, and a later cancel goes back to what is left", () => {
    let state = empty();
    for (const minute of ["00", "10", "20"]) state = receive(state, decode(KYOTO, "VPWW57", at(`2020-06-22T23:${minute}:00+09:00`), `v${minute}`)).state;
    state = receive(state, decode(FUKUI, "VPWW55")).state;
    const candidate = decode(KYOTO, "VPWW57", at("2020-06-22T23:30:00+09:00"), "v30");
    const accepted = receive(sized(state, candidate, 1), candidate);
    expect(accepted.diagnostics).toEqual([{ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 }]);
    expect(accepted.state.histories.flatMap((item) => item.reports).map((item) => item.source.inputId)).toEqual(["v20"]);
    expect(accepted.state.partials.map((item) => item.source.inputId).sort()).toEqual([FUKUI, "pad", "v30"].sort());
    const back = receive(accepted.state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:40:00+09:00"), "c1"));
    expect(back.state.partials.find((item) => item.office === "京都地方気象台")?.source.inputId).toBe("v20");
    expect(receive(back.state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:41:00+09:00"), "c2")).state.unavailable).toMatchObject([{ reason: "historyUnavailable" }]);
  });
  it("counts the orphaned series mark so that it drops only A's version, and B's cancel still goes back", () => {
    let state = receive(receive(empty(), decode(KYOTO, "VPWW57", at("2020-06-22T23:00:00+09:00"), "b1")).state, decode(KYOTO, "VPWW57", at("2020-06-22T23:10:00+09:00"), "b2")).state;
    const b = state.partials[0];
    const a1 = { ...b, subject: "normal/VPWW57/A", office: "A", source: { ...b.source, subject: "normal/VPWW57/A", inputId: "a1", reportDateTimeRaw: "2020-06-22T22:00:00+09:00" } };
    state = { ...state, histories: [{ subject: a1.subject, operation: "normal", reports: [a1] }, ...state.histories], unconfirmed: [{ ...a1.source, inputId: "a-mark" }] };
    expect(weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(state)).kind).toBe("restored");
    const entry = Buffer.byteLength(JSON.stringify(state.histories[0])) + 1;
    const candidate = decode(FUKUI, "VPWW55");
    const accepted = receive(sized(state, candidate, entry + 1), candidate);
    expect([accepted.state.histories.map((item) => item.subject), accepted.state.unconfirmed]).toEqual([[b.subject], []]);
    expect(accepted.diagnostics).toContainEqual({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    const back = receive(accepted.state, decode(KYOTO, "VPWW57", cancel("2020-06-22T23:20:00+09:00"), "b-cancel"));
    expect(back.state.partials.find((item) => item.office === "京都地方気象台")?.source.inputId).toBe("b1");
  });
  it("measures the budget the same number of times whether it drops 1 or 100 versions", () => {
    const kyoto = receive(empty(), decode(KYOTO, "VPWW57")).state.partials[0];
    const subjects = Array.from({ length: 100 }, (_, index) => `normal/VPWW57/履歴${index}`);
    const version = (subject: string, index: number) => ({ ...kyoto, subject, office: subject.split("/")[2],
      source: { ...kyoto.source, subject, inputId: `h${index}`, reportDateTimeRaw: `2019-01-01T00:${String(index % 60).padStart(2, "0")}:${String(Math.floor(index / 60)).padStart(2, "0")}+09:00` } });
    const base: WeatherCurrentUnitState = { ...empty(), partials: subjects.map((subject, index) => ({ ...version(subject, index), source: { ...version(subject, index).source, inputId: `c${index}`, reportDateTimeRaw: "2020-06-22T23:00:00+09:00" } })),
      histories: subjects.map((subject, index) => ({ subject, operation: "normal" as const, reports: [version(subject, index)] })) };
    const order = [...base.histories].sort((left, right) => Date.parse(left.reports[0].source.reportDateTimeRaw) - Date.parse(right.reports[0].source.reportDateTimeRaw));
    const freed = (count: number) => order.slice(0, count).reduce((sum, entry, index) => sum + Buffer.byteLength(JSON.stringify(entry)) + (base.histories.length - index >= 2 ? 1 : 0), 0);
    const candidate = decode(FUKUI, "VPWW55");
    const run = (count: number) => {
      const state = sized(base, candidate, freed(count));
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        const step = receive(state, candidate);
        expect(step.diagnostics).toContainEqual({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count });
        // reservedGenerationBytes は呼ぶたびに capturedAt（受信の壁時計）を 1 回 JSON にする。
        return stringify.mock.calls.filter(([value]) => value === NOW).length;
      } finally { stringify.mockRestore(); }
    };
    expect(run(1)).toBe(run(100));
  });
});

describe("P3-UWC-T09 contractBoundary (AC09・AC04 (5)): only the touched prefectures are rebuilt", () => {
  it("a partial changes one prefecture row and its monitor row; a national report leaves a partial-only prefecture out", () => {
    const kyoto = receive(empty(), decode(KYOTO, "VPWW57"));
    expect(kyoto.displayChanges.map((change) => change.subject)).toEqual(["normal/VPWW57/京都地方気象台", "normal/area/26"]);
    const before = receive(kyoto.state, decode("weather-alert-kind-area/synthetic-vpws50-change-density-before", "VPWS50", bodyWarning, "national-before")).state;
    const after = receive(before, decode("weather-alert-kind-area/synthetic-vpws50-change-density-after", "VPWS50", (xml) => at("2026-09-06T11:00:00+09:00")(bodyWarning(xml)), "national-after"));
    expect(after.displayChanges.length).toBeGreaterThan(1);
    expect(after.displayChanges.some((change) => change.subject === "normal/area/26")).toBe(false);
  });
  it("an evicted training partial's prefecture is rebuilt: its Code 03 leaves, the row goes when nothing wins, and a save restores the same", () => {
    const fukui = receive(empty(), decode(FUKUI, "VPWW55", operation("training"), "fukui-training")).state;
    expect(weatherCurrentAreas(fukui)[0]).toMatchObject({ operation: "training", prefecture: "18", codes: expect.objectContaining({ "03": expect.any(Number) }) });
    const kyoto = receive(empty(), decode(KYOTO, "VPWW57", operation("training"), "kyoto-training")).state.partials[0];
    const clones = Array.from({ length: 63 }, (_, index) => ({ ...kyoto, subject: `training/VPWW57/官署${index}`, office: `官署${index}`,
      source: { ...kyoto.source, subject: `training/VPWW57/官署${index}`, inputId: `k${index}`, reportDateTimeRaw: "2026-08-30T07:00:00+09:00" } }));
    const full: WeatherCurrentUnitState = { ...fukui, partials: [...fukui.partials, ...clones] };
    const step = receive(full, decode(KYOTO, "VPWW57", compose(office("新京都"), operation("training"), at("2026-08-30T08:00:00+09:00")), "kyoto-new"));
    expect(step.diagnostics).toContainEqual({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(step.displayChanges.find((change) => change.subject === "training/area/18")).toMatchObject({ after: null });
    expect(weatherCurrentAreas(step.state).map((item) => item.prefecture)).toEqual(["26"]);
    const decoded = weatherCurrentUnitCodec.decode(weatherCurrentUnitCodec.encode(step.state));
    if (decoded.kind !== "restored") throw new Error("decode");
    expect(comparable({ ...decoded.state, contentRevision: 0 })).toEqual(comparable(step.state));
  });
});

describe("P3-UWC-T15 contractBoundary (AC09 (5)): ending and tombstone scans do not multiply", () => {
  it("(a) N VPNO50 tombstones mask an older national report like one at a time, reading a history version the same number of times", () => {
    const national = decode(NATIONAL, "VPWS50");
    const nationalState = receive(empty(), national).state.national.normal!;
    const read = (count: number) => {
      const tombstones = Array.from({ length: count }, (_, index) => {
        const subject = `normal/VPNO50/官署${index}`, code = `${String(index + 1).padStart(2, "0")}0000`;
        return { subject, operation: "normal" as const, source: { ...nationalState.source, family: "VPNO50", subject, inputId: `t${index}`, reportDateTimeRaw: "2020-01-01T00:00:00+09:00" },
          affectedScope: [JSON.stringify(["VPNO50", "partial", `官署${index}`, VPNO_TYPE, code])] };
      });
      // 履歴の版の object を Proxy にして operation の読みを数える（配列でなく版を見るので、履歴を写し直しても数えられる）。
      let reads = 0;
      const version = new Proxy({ ...nationalState, operation: "training" as const }, {
        get(target, key, receiver) { if (key === "operation") reads++; return Reflect.get(target, key, receiver); } });
      const histories = [{ subject: "training/VPWS50/気象庁", operation: "training" as const, reports: [version] }];
      const step = reduceWeatherCurrentMeaning({ ...empty(), tombstones, histories }, { kind: "receive", material: national, clock: clock() });
      const reference = Object.fromEntries(Object.entries(nationalState.phenomena).map(([token, value]) => {
        const ended = tombstones.some((item) => codeOf(item.affectedScope[0]).slice(0, 2) === codeOf(token).slice(0, 2));
        return [token, ended && Array.isArray(value) ? value.filter((row) => !(row != null && typeof row === "object" && !Array.isArray(row)
          && typeof row.code === "string" && /^3\d$/.test(row.code))) : value];
      }));
      expect(step.state.national.normal?.phenomena).toEqual(reference);
      return reads;
    };
    expect(read(1)).toBe(read(64));
  });
  it("(b) an ending report builds and spreads its Code sets the same number of times for 16 and 1,024 held areas", () => {
    const ending = decode("18_00_01_260830_VPNO50_switch", "VPNO50");
    const counts = (areas: number) => {
      const phenomena = Object.fromEntries(Array.from({ length: areas }, (_, index) => [
        JSON.stringify(["VPWS50", "national", "気象庁", "気象警報・注意報（市町村等）", String(1_800_000 + index)]), [{ status: "継続", code: "33", name: null }]]));
      const national: WeatherCurrentSnapshot = { subject: "normal/VPWS50/気象庁", operation: "normal", scope: "national", office: "気象庁", phenomena,
        source: { inputId: "n", origin: "replay", operation: "normal", family: "VPWS50", subject: "normal/VPWS50/気象庁",
          reportDateTimeRaw: "2026-08-30T06:00:00+09:00", controlDateTimeRaw: "2026-08-29T21:00:00Z", serialRaw: "", infoTypeRaw: "発表" } };
      let built = 0, spread = 0;
      const Original = Set;
      class Counted<T> extends Original<T> {
        constructor(values?: Iterable<T> | null) { super(values); built++; }
        [Symbol.iterator]() { spread++; return super[Symbol.iterator](); }
      }
      vi.stubGlobal("Set", Counted);
      let step: ReturnType<typeof reduceWeatherCurrentMeaning>;
      try { step = reduceWeatherCurrentMeaning({ ...empty(), national: { normal: national } }, { kind: "receive", material: ending, clock: clock() }); }
      finally { vi.unstubAllGlobals(); }
      expect(Object.values(step.state.national.normal!.phenomena).every((rows) => Array.isArray(rows) && rows.length === 0)).toBe(true);
      return [built, spread];
    };
    expect(counts(16)).toEqual(counts(1_024));
  });
});
