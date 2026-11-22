import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { RuntimeDisplayChange, UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { TsunamiAreaClass, TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import type { KnownCodeTable } from "../../contracts/p4-gis-assets.types";
import type { DisplayWireSnapshot, WireDetailRequest } from "../../contracts/p4-display-wire.types";
import known from "../../assets/gis/known-codes.v1.json";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { executionPlaces, placeOfHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import type { DisplayWireInput, DisplayWireResult, DisplayWireState } from "../../src/view-projector/display-wire";
import { runStage1 } from "../disaster/runner";
import { readScenario } from "../disaster/scenario";
import type { Scenario } from "../disaster/scenario";
import { synthesize } from "../disaster/synth";
import type { Frame } from "../disaster/synth";
import { clock, decodeXml, receive as receiveTsunami } from "../tsunami-unit/tsunami-fixture";
import { baseInput, eewStep, eewXml, emptyEew, emptyTsunami, material, projected, quietLosses, wire } from "./display-wire-fixture";
import type { EewArea } from "./display-wire-fixture";

// P4-DISPLAY-CAPACITY-001 の T06（通常合法最大の manifest、E13a、表 §8）。

// composition root が import する新しい経路の射影を包み、公開した snapshot の全体の byte と要約の数を数える（runner.ts は変えない）。
const seen = vi.hoisted(() => ({ publications: [] as { bytes: number; protectedSummaries: number; summaries: number }[] }));
vi.mock("../../src/view-projector/display-wire", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/view-projector/display-wire")>();
  return { ...actual, projectDisplayWire: (...args: Parameters<typeof actual.projectDisplayWire>) => {
    const result = actual.projectDisplayWire(...args);
    if (result.kind === "projected") {
      const current = result.snapshot.current;
      seen.publications.push({ bytes: Buffer.byteLength(JSON.stringify(result.snapshot)),
        protectedSummaries: [current.eew, current.tsunami, current.earthquake].filter((domain) => "delivery" in domain).length,
        summaries: Object.values(current).filter((domain) => "delivery" in domain && domain.delivery === "summary").length });
    }
    return result;
  } };
});
beforeEach(() => { seen.publications = []; });

const MIB = 1_048_576;
const table: KnownCodeTable = known;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const fixture = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
type Views = DisplayWireInput["views"];
async function baseViews(): Promise<Views> {
  const { input } = await baseInput();
  return { eew: input.eew, tsunami: input.tsunami, earthquake: input.earthquake, weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries,
    nankai: input.nankai, volcano: input.volcano, landslide: input.landslide, flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins,
    typhoon: input.typhoon };
}
async function project(views: Views, changes: readonly RuntimeDisplayChange[], previous: DisplayWireState | null): Promise<DisplayWireResult> {
  const { input } = await baseInput();
  return projectDisplayWire({ projection: { ...input, displayChanges: changes }, views, confirmation: input.confirmation, notices: [], removalLoss: quietLosses }, previous);
}

// owner に 1 通ずつ通す（display-vocab.test.ts の receive と同じ）。
const AT_MS = Date.parse("2099-01-01T09:00:00+09:00");
const empty = (place: ExecutionPlace): OwnerState => restoreOwner({ runId: "run", place, clock: { wallTimeMs: AT_MS, monotonicMs: 1 },
  restored: Object.fromEntries(runtimeUnits.filter((unit) => executionPlaces[unit] === place).map((unit) => [unit, { kind: "empty" }])) }, linkedUnitTable, linkedUnitCodecs).state;
let sequence = 0;
function receive(xml: string, headType: string, owner: OwnerState | null = null) {
  const decoded: DecodedMaterial = material(xml, headType);
  const at = Date.parse(decoded.reportDateTimeRaw);
  return receiveOwner(owner ?? empty(placeOfHeadType(headType)), { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } },
    { wallTimeMs: Number.isFinite(at) ? at + 1000 : AT_MS, monotonicMs: ++sequence }, linkedUnitTable);
}
function withViews(views: Views, step: ReturnType<typeof receive>): Views {
  let next = views;
  for (const view of step.views) {
    if (view.unit === "U-W") next = { ...next, weatherCurrent: view };
    if (view.unit === "U-R") next = { ...next, flood: view };
    if (view.unit === "U-Y") next = { ...next, typhoon: view };
  }
  return next;
}
// 詳細の part=item の 1 応答（http-sse が直列化する {streamId, ...答え}、streamId は composition root の randomUUID の 36 字）。
function itemResponseBytes(owner: OwnerState, unit: "U-Y" | "U-R", snapshot: DisplayWireSnapshot): number {
  const domain = unit === "U-Y" ? snapshot.current.typhoon : snapshot.current.flood;
  if (domain.delivery !== "full") throw new Error(`${unit} summary`);
  const sizes = domain.wire.items.map((item) => {
    const response = detailOwner(owner, { unit, part: "item", id: item.id, revision: item.rev } satisfies WireDetailRequest);
    expect(response.kind).toBe("ok");
    return bytes({ streamId: "0".repeat(36), ...response });
  });
  return Math.max(...sizes);
}

// E4: VXSE45 の写しの EventID と区域を替え、既知の細分区域 188 を全部持たせる（段は EventID ごとにずらす）。
const LEVELS = ["1", "2", "3", "4", "5-", "5+", "6-", "6+"] as const;
const STAGE: Readonly<Record<string, number>> = { "1": 1, "2": 2, "3": 3, "4": 4, "5-": 5, "5+": 6, "6-": 7, "6+": 8 };
const levelOf = (event: number, area: number) => LEVELS[(event + area) % LEVELS.length];
function e4Xml(event: number): string {
  const areas = table.forecastLocalE.map(({ code }, index) => `<Pref><Name>県</Name><Code>9380</Code><Area><Name>区域${code}</Name><Code>${code}</Code>`
    + `<Category><Kind><Name>緊急地震速報（予報）</Name><Code>10</Code></Kind></Category><ForecastInt><From>${levelOf(event, index)}</From><To>${levelOf(event, index)}</To></ForecastInt></Area></Pref>`).join("");
  return fixture("77_01_01_240613_VXSE45").replace("<EventID>20240417231454</EventID>", `<EventID>2024041723${String(event).padStart(4, "0")}</EventID>`)
    .replace("</ForecastLgInt></Forecast>", `</ForecastLgInt>${areas}</Forecast>`);
}
function e4State(): Readonly<{ state: EewUnitState; changes: RuntimeDisplayChange[] }> {
  let state = emptyEew();
  const changes: RuntimeDisplayChange[] = [];
  for (let event = 0; event < 6; event++) {
    const step = eewStep(state, e4Xml(event), "VXSE45");
    state = step.state;
    changes.push(...step.displayChanges);
  }
  return { state, changes };
}
// E5: VTSE41 の写しの予報区を既知の 66 区域（区分を混ぜる）とコードの無い 8 行にし、付加文を 2,048 byte に収める。EventID ごとに区分をずらす。
const KINDS = [["52", "大津波警報", "majorWarning"], ["51", "津波警報", "warning"], ["62", "津波注意報", "advisory"], ["71", "津波予報（若干の海面変動）", "forecast"]] as const;
const RANK: Readonly<Record<TsunamiAreaClass, number>> = { none: 0, released: 0, forecast: 1, advisory: 2, warning: 3, unknown: 3, majorWarning: 4 };
const kindOf = (event: number, area: number) => KINDS[(event + area) % KINDS.length];
const tsunamiId = (event: number) => `2016090107${String(event).padStart(2, "0")}00`;
function e5Forecast(event: number): string {
  const item = (area: string, kind: readonly [string, string, string]) => `<Item><Area>${area}</Area><Category><Kind><Name>${kind[1]}</Name><Code>${kind[0]}</Code></Kind></Category></Item>`;
  const items = [...table.tsunamiArea.map(({ code, name }, index) => item(`<Name>${name}</Name><Code>${code}</Code>`, kindOf(event, index))),
    ...Array.from({ length: 8 }, (_, index) => item(`<Name>コードの無い予報区${index}</Name>`, kindOf(event, index)))].join("");
  // 写しの元は訓練の報なので、運用を通常にする（塗りの合成は通常の報だけ）。
  return fixture("32-39_12_02_250206_VTSE41").replace("<Status>訓練</Status>", "<Status>通常</Status>").replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${tsunamiId(event)}</EventID>`)
    .replace(/(<\/CodeDefine>)[\s\S]*?(<\/Forecast>)/, `$1${items}$2`).replace(/(<WarningComment codeType="固定付加文">\s*<Text>)[^<]*(<\/Text>)/, `$1${"あ".repeat(682)}$2`);
}
// 観測: VTSE51 の写しに観測の節（Observation）を足し、既知の 66 区域に写しの観測点を 1 つずつ置く（72 点から順に、高さは観測の形）。
function e5Observation(): string {
  const xml = fixture("32-39_11_03_250206_VTSE51");
  const stations = [...xml.matchAll(/<Station><Name>([^<]*)<\/Name><Code>(\d+)<\/Code>/g)].map((match) => [match[1], match[2]] as const);
  const items = table.tsunamiArea.map(({ code, name }, index) => `<Item><Area><Name>${name}</Name><Code>${code}</Code></Area><Station><Name>${stations[index][0]}</Name>`
    + `<Code>${stations[index][1]}</Code><MaxHeight><Condition>観測中</Condition><jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m">0.${index % 9 + 1}</jmx_eb:TsunamiHeight>`
    + "</MaxHeight></Station></Item>").join("");
  return xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${tsunamiId(0)}</EventID>`).replace("</Forecast>", `</Forecast><Observation>${items}</Observation>`);
}
function e5State(): Readonly<{ state: TsunamiUnitState; changes: RuntimeDisplayChange[] }> {
  let state = emptyTsunami();
  const changes: RuntimeDisplayChange[] = [];
  const step = (xml: string, headType: "VTSE41" | "VTSE51") => {
    const done = receiveTsunami(state, decodeXml(xml, headType), clock(Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]) + 1000));
    state = done.state;
    changes.push(...done.displayChanges);
  };
  for (let event = 0; event < 3; event++) step(e5Forecast(event), "VTSE41");
  step(e5Observation(), "VTSE51");
  return { state, changes };
}
// E4・E5 の期待集合（入力から組む）。
function expectE4(snapshot: DisplayWireSnapshot) {
  const eew = snapshot.current.eew.wire;
  expect([eew.cards.length, eew.omitted]).toEqual([6, 0]);
  for (const card of eew.cards) {
    const event = Number(card.eventId.slice(-4));
    expect("mini" in card ? card.mini : null).toEqual(table.forecastLocalE.map(({ code }, index) => [code, STAGE[levelOf(event, index)]]));
  }
  const composite = table.forecastLocalE.map(({ code }, index) => [code, Math.max(...[0, 1, 2, 3, 4, 5].map((event) => STAGE[levelOf(event, index)]))]);
  expect([...eew.composites[0]].sort()).toEqual(composite.sort());
}
function expectE5(snapshot: DisplayWireSnapshot) {
  const tsunami = snapshot.current.tsunami.wire;
  expect([tsunami.forecasts.length, tsunami.omittedEvents]).toEqual([3, 0]);
  for (const forecast of tsunami.forecasts) {
    const event = Number(forecast.eventId.slice(-4, -2));
    expect([forecast.omittedUnkeyed, forecast.unknownAreas, forecast.comment?.cut]).toEqual([0, 0, false]);
    expect(forecast.rows.map((row) => [row.c, row.k]).sort()).toEqual(table.tsunamiArea.map(({ code }, index) => [code, kindOf(event, index)[2]]).sort());
    expect(forecast.unkeyed.map((row) => [row.name.text, row.k])).toEqual(Array.from({ length: 8 }, (_, index) => [`コードの無い予報区${index}`, kindOf(event, index)[2]])
      .sort((left, right) => RANK[right[1] as TsunamiAreaClass] - RANK[left[1] as TsunamiAreaClass]));
  }
  const composite = table.tsunamiArea.map(({ code }, index) => [code, [0, 1, 2].map((event) => kindOf(event, index)[2]).reduce((top, kind) => RANK[kind] > RANK[top] ? kind : top)]);
  expect([...tsunami.composites[0].forecast].sort()).toEqual(composite.sort());
}

// 読めない報のカードの区域で 9 分野の包みを重くする（P4-DV-T02 の typhoonCards と同じ組み方）。
const cardOf = (inputId: string, areas: number): UnreadableCardView => ({ kind: "unreadable", inputId, headType: "VPWW54", operation: "normal", receivedAt: 1,
  reason: "xmlInvalid", title: null, headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true,
  areas: Array.from({ length: areas }, () => ({ code: "1000000", name: "地域", value: 0 })) });

// 受入条件 P4-DC-AC06（E13a、統合担当の決め 1）。
describe("P4-DC-T06 acceptance: the normal legal maximum (E13a)", () => {
  it("E1・E2: one U-Y item over every code-table area and the largest real U-R item each answer part=item within 65,536 bytes", async () => {
    const answer = async (xml: string, headType: string, unit: "U-Y" | "U-R") => {
      const step = receive(xml, headType);
      return itemResponseBytes(step.state, unit, projected(await project(withViews(await baseViews(), step), step.displayChanges, null)).snapshot);
    };
    // 確率を全部 100 にすると、1% 以上の区域だけを持つ unit がコード表の全区域を残す（そのままの電文より大きい）。
    const original = fixture("76_01_01_200630_VPTA50"), vpta = original.replace(/>(\d+)<\/FiftyKtWindProbability>/g, ">100</FiftyKtWindProbability>");
    const [e1, untouched, e2] = [await answer(vpta, "VPTA50", "U-Y"), await answer(original, "VPTA50", "U-Y"), await answer(fixture("16_12_01_260312_VXKO50"), "VXKO50", "U-R")];
    expect(e1).toBeGreaterThan(untouched);
    expect([e1 <= 65_536, e2 <= 65_536]).toEqual([true, true]);
  });

  it("E3: U-W stays full within 1 MiB for one national VPWS50 and for a day of normal and training national VPWS50", async () => {
    const one = receive(fixture("15_18_01_250630_VPWS50"), "VPWS50");
    const single = projected(await project(withViews(await baseViews(), one), one.displayChanges, null)).snapshot;
    expect([single.current.weatherCurrent.delivery, bytes(single) <= MIB]).toEqual(["full", true]);
    let owner: OwnerState | null = null, views = await baseViews(), previous: DisplayWireState | null = null, last: DisplayWireSnapshot | null = null;
    for (const name of ["synthetic_VPWS50_national_0907_1300", "synthetic_VPWS50_national_training_0907_1301", "synthetic_VPWS50_national_0907_1302"]) {
      const step = receive(fixture(name), "VPWS50", owner);
      owner = step.state;
      views = withViews(views, step);
      const result = await project(views, step.displayChanges, previous);
      previous = result.state;
      if (result.kind === "projected") last = result.snapshot;
    }
    expect(last == null ? null : [last.current.weatherCurrent.delivery, bytes(last.current.weatherCurrent) > 65_536, bytes(last) <= MIB]).toEqual(["full", true, true]);
  }, 120_000);

  it("E4・E5: the card limit of EEW and the tsunami event limit carry every known area, the composites match and nothing is omitted", async () => {
    const tsunami = e5State(), eew = e4State();
    // 射影の最初の step は view を覆う差分を要る（wire の covering。EEW の 6 件と津波の 3 件・観測 1 件の差分を全部渡す）。
    const snapshot = projected(await wire({ eew: eew.state, tsunami: tsunami.state }, [...eew.changes, ...tsunami.changes], null)).snapshot;
    expectE4(snapshot);
    expectE5(snapshot);
    // 観測点は詳細の stations のページで全部読める（66 区域に 1 点ずつ）。
    const base = empty("urgent"), unit = base.units["U-T"]!;
    const owner: OwnerState = { ...base, units: { ...base.units, "U-T": { ...unit, ...tsunami.state } } };
    const index = detailOwner(owner, { unit: "U-T", part: "index", revision: String(tsunami.state.contentRevision), page: 0 });
    if (index.kind !== "ok" || index.part !== "index" || !("omitted" in index)) throw new Error("index");
    const entry = index.entries.find((item) => item.part === "stations");
    if (entry == null || entry.part !== "stations") throw new Error("stations");
    const stations: number[] = [];
    for (let page = 0; ; page++) {
      const response = detailOwner(owner, { unit: "U-T", part: "stations", id: entry.id, revision: entry.revision, page });
      if (response.kind !== "ok" || response.part !== "stations") throw new Error("page");
      stations.push(...response.items.map((item) => item.index));
      if (page + 1 >= response.pageCount) break;
    }
    expect(stations).toEqual(Array.from({ length: 66 }, (_, index) => index));
  });

  it("E4b: one normal EEW over the card limit enters the composite at each area's maximum and counts as omitted", async () => {
    const AT = "2099-01-01T09:00:00+09:00";
    const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString().replace("Z", "+00:00");
    // 7 件目は 100 でほかより低く、101 でほかより高く、102 は 7 件目だけ（~/dev/p4-b1-many-eew-r1.md の F1 の組み方）。
    const reports: readonly (readonly EewArea[])[] = [[["100", "5+", "5+"]], [["101", "3", "3"]], [["105", "4", "4"]], [["106", "4", "4"]], [["107", "4", "4"]],
      [["110", "4", "4"]], [["100", "4", "4"], ["101", "6-", "6-"], ["102", "5-", "6-"]]];
    let state = emptyEew();
    const changes: RuntimeDisplayChange[] = [];
    reports.forEach((areas, index) => {
      const step = eewStep(state, eewXml({ eventId: `2099010100${String(index + 1).padStart(4, "0")}`, at: at(index + 1), areas }));
      state = step.state;
      changes.push(...step.displayChanges);
    });
    const { input } = await baseInput();
    const snapshot = projected(await project({ ...await baseViews(), eew: { ...input.eew, current: state.current, subjects: changes.flatMap((change) => change.after?.subjects ?? []) } },
      changes, null)).snapshot;
    const top = new Map<string, number>();
    for (const areas of reports) for (const [code, , to] of areas) top.set(code, Math.max(top.get(code) ?? 0, STAGE[to]));
    const eew = snapshot.current.eew.wire;
    expect([eew.cards.length, eew.omitted]).toEqual([6, 1]);
    expect([...eew.composites[0]].sort()).toEqual([...top].sort());
  });

  it("E6: with the nine domains over 1 MiB the summaries stop in the B order and the E4・E5 sets stay whole", async () => {
    const tsunami = e5State(), eew = e4State();
    const snapshot = projected(await wire({ eew: eew.state, tsunami: tsunami.state }, [...eew.changes, ...tsunami.changes], null, (views) => ({ ...views,
      weatherTimeseries: { ...views.weatherTimeseries, unreadableCards: [cardOf("f", 2_000)] }, landslide: { ...views.landslide, unreadableCards: [cardOf("l", 8_000)] },
      flood: { ...views.flood, unreadableCards: [cardOf("r", 6_000)] }, weatherCurrent: { ...views.weatherCurrent, unreadableCards: [cardOf("w", 9_000)] } }))).snapshot;
    expect(bytes(snapshot)).toBeLessThanOrEqual(MIB);
    // 越えた 4 分野（U-F・U-L・U-R・U-W）のうち、B の順の先頭から入るまで（U-F と U-L で入り、U-R・U-W は full）。
    expect(Object.entries(snapshot.current).filter(([, domain]) => "delivery" in domain && domain.delivery === "summary").map(([key]) => key))
      .toEqual(["weatherTimeseries", "landslide"]);
    expect(bytes(snapshot.current.flood) > 65_536 && bytes(snapshot.current.weatherCurrent) > 65_536).toBe(true);
    expectE4(snapshot);
    expectE5(snapshot);
  });

  it("(2) keeps the protected three out of the summary on the new path for the input the old path summarizes (P3-DC-T09)", async () => {
    const MINUTE = 60_000, t0 = Date.parse("2026-06-26T00:00:00+09:00");
    const frames = synthesize("N1", 1, { t0Ms: t0 });
    const quake = Buffer.from(frames.filter((item) => item.headType === "VXSE53").reduce((a, b) => b.body.byteLength > a.body.byteLength ? b : a).body).toString("utf8");
    const forecast = Buffer.from(frames.find((item) => item.headType === "VTSE41")!.body).toString("utf8").replace(/<Comments>[\s\S]*?<\/Comments>/, "");
    const swap = (xml: string, index: number) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${20260626000100 + index}</EventID>`);
    const frame = (atMs: number, headType: string, xml: string): Frame => ({ atMs, headType, body: Buffer.from(xml), origin: "synthetic", source: "test" });
    const inputs = [0, 1, 2, 3].flatMap((index) => [...index < 3 ? [frame(t0 + index * MINUTE, "VXSE53", swap(quake, index))] : [],
      frame(t0 + index * MINUTE + 1_000, "VTSE41", swap(forecast, index))]);
    const scenario: Scenario = { kind: "ready", id: "P4-DC-T06", frames: inputs, digest: "P4-DC-T06", startMs: inputs[0].atMs, endMs: t0 + 10 * MINUTE, checkpoints: [],
      expectations: [], synth: null, t0: null };
    const { result } = await runStage1(scenario);
    // 旧の経路はこの入力で U-T・U-Q を要約にする（P3-DC-T09）。新しい経路は保護 3 分野を要約にせず、全体は 1 MiB 以下。
    expect(result["status"]).toBe("Fail");
    expect(seen.publications.length).toBeGreaterThan(0);
    expect([Math.max(...seen.publications.map((item) => item.protectedSummaries)), Math.max(...seen.publications.map((item) => item.bytes)) <= MIB]).toEqual([0, true]);
  }, 120_000);
});

// E7（AC06 (3)）: 災害の日と実の採取物の日。採取物（repo の外）の dir を FLEQ_B1_E7_DATA で渡したときだけ流す。無ければ skip で、統合担当の配送の記録では blocked と数える。
const E7_DATA = process.env["FLEQ_B1_E7_DATA"];
describe.runIf(E7_DATA != null)("P4-DC-T06 E7: the disaster and archive days on the new path", () => {
  for (const id of ["N1", "N2", "N3", "W1:2026-06-03", "W1:2026-06-26", "W1:2026-09-21", "W2"]) {
    it(`${id}: no summary and every snapshot within 1 MiB`, async () => {
      const scenario = readScenario({ id, dataDir: E7_DATA ?? null, expectedDigest: null });
      expect(scenario.kind).toBe("ready");
      await runStage1(scenario);
      const most = Math.max(...seen.publications.map((item) => item.bytes));
      console.info(`[P4-DC-T06 E7] ${id} publications=${seen.publications.length} maxBytes=${most} summaries=${seen.publications.filter((item) => item.summaries > 0).length}`);
      expect([seen.publications.filter((item) => item.summaries > 0).length, most <= MIB]).toEqual([0, true]);
    }, 3_600_000);
  }
});
