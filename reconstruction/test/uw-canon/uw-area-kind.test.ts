import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { DisplayWireSnapshot, VocabItem } from "../../contracts/p4-display-wire.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, initialUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { executionPlaces, placeOfHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import { areaEntry } from "../../src/units/weather-current/weather-current-public";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import type { DisplayWireResult, DisplayWireState } from "../../src/view-projector/display-wire";
import { baseInput, material, projected, quietLosses } from "../display-wire/display-wire-fixture";

// P4-UW-AREA-KIND-001 の試験 3 本。期待の hash と数は契約 testMapping の値（XML から script で数えた値で、unit の関数は使っていない）。
const NOW = 1_800_000_000_000;
const MIB = 1_048_576;
const fixture = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// 行を [層の名前, 区域 Code, kinds の字] にし、層の名前の字 → Code の昇順に並べた空白なしの JSON の sha256（契約 T01 の作り方）。
const rowsHash = (rows: readonly (readonly [string, string, string])[]) =>
  createHash("sha256").update(JSON.stringify([...rows].sort((l, r) => (l[0] < r[0] ? -1 : l[0] > r[0] ? 1 : l[1] < r[1] ? -1 : l[1] > r[1] ? 1 : 0))), "utf8").digest("hex");

// ---- 新しい経路（owner → 射影 → part=item）。display-capacity-manifest.test.ts の E3 と同じ組み方 ----
type Views = Parameters<typeof projectDisplayWire>[0]["views"];
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
const AT_MS = Date.parse("2099-01-01T09:00:00+09:00");
const emptyOwner = (place: ExecutionPlace): OwnerState => restoreOwner({ runId: "run", place, clock: { wallTimeMs: AT_MS, monotonicMs: 1 },
  restored: Object.fromEntries(runtimeUnits.filter((unit) => executionPlaces[unit] === place).map((unit) => [unit, { kind: "empty" }])) }, linkedUnitTable, linkedUnitCodecs).state;
let sequence = 0;
function ownerReceive(xml: string, headType: string, owner: OwnerState | null) {
  const decoded: DecodedMaterial = material(xml, headType);
  const at = Date.parse(decoded.reportDateTimeRaw);
  return receiveOwner(owner ?? emptyOwner(placeOfHeadType(headType)), { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } },
    { wallTimeMs: Number.isFinite(at) ? at + 1000 : AT_MS, monotonicMs: ++sequence }, linkedUnitTable);
}
type Step = ReturnType<typeof ownerReceive>;
const withWeather = (views: Views, step: Step): Views => {
  const view = step.views.find((item) => item.unit === "U-W");
  return view?.unit === "U-W" ? { ...views, weatherCurrent: view } : views;
};
function areaItems(snapshot: DisplayWireSnapshot): readonly VocabItem[] {
  const domain = snapshot.current.weatherCurrent;
  if (domain.delivery !== "full") throw new Error("U-W is not full");
  return domain.wire.items.filter((item) => item.k === "weatherCurrent.area");
}
const itemRows = (item: VocabItem): [string, string, string][] => item.lists.flatMap((list) => list.role !== "areas" ? [] : list.rows.map((row): [string, string, string] => [String(list.sys), String(row[0]), String(row[2])]));
// 語彙の areas の行は [層, 区域 Code] の昇順（rowsHash は並べ直してから取るので、出した順はここで見る。AC02 (1)）。
const inOrder = (item: VocabItem) => itemRows(item).every((row, index, rows) => index === 0 || rows[index - 1][0] < row[0] || (rows[index - 1][0] === row[0] && rows[index - 1][1] < row[1]));
// 全部の行の kinds を種別ごとに数えた数が phenomena の areaCount と等しい（AC02 (6)）。
function countsMatch(item: VocabItem): boolean {
  const counted = new Map<string, number>();
  for (const [, , kinds] of itemRows(item)) for (const kind of kinds.split(" ")) counted.set(kind, (counted.get(kind) ?? 0) + 1);
  const phenomena = item.lists.find((list) => list.role === "phenomena")?.rows ?? [];
  return phenomena.length === counted.size && phenomena.every((row) => counted.get(String(row[0])) === row[2]);
}
const PART_ITEM_STREAM_ID = "0".repeat(36);
function answerBytes(state: OwnerState, item: VocabItem): number {
  const response = detailOwner(state, { unit: "U-W", part: "item", id: item.id, revision: item.rev });
  expect(response.kind).toBe("ok");
  return bytes({ streamId: PART_ITEM_STREAM_ID, ...response });
}

// P4-UAK-T01 corpusHistory（AC01・AC02・AC06）: XML から数えた hash と数に、新しい経路の areas の行が合う。
describe("P4-UAK-T01 corpusHistory: the areas rows of a national VPWS50 and its Fukui replacement carry the counted kinds", () => {
  it("matches the counted hashes, the areaCount sums, and stays full within 1 MiB and 65,536 bytes per part=item", async () => {
    let owner: OwnerState | null = null, views = await baseViews(), previous: DisplayWireState | null = null;
    const seen: { rows: [string, string, string][]; hash: string }[] = [];
    for (const name of ["15_18_01_250630_VPWS50", "synthetic_VPWS50_fukui_base"]) {
      const step = ownerReceive(fixture(name), "VPWS50", owner);
      owner = step.state; views = withWeather(views, step);
      const result = projected(await project(views, step.displayChanges, previous));
      previous = result.state;
      const items = areaItems(result.snapshot), rows = items.flatMap(itemRows);
      expect([items.every(countsMatch), items.every(inOrder)]).toEqual([true, true]);
      expect([result.snapshot.current.weatherCurrent.delivery, bytes(result.snapshot) <= MIB]).toEqual(["full", true]);
      expect(items.every((item) => answerBytes(step.state, item) <= 65_536)).toBe(true);
      seen.push({ rows, hash: rowsHash(rows) });
    }
    expect([seen[0].rows.length, seen[0].hash]).toEqual([2187, "c9452ce65f0c21e64a8cb0a6bb4031eacd7e7b1b8f95d194ce30261857c2c5e7"]);
    expect([seen[1].rows.length, seen[1].hash]).toEqual([2176, "cd7595b54ec9b17e93b16b20280eae5e811ce3a4f251e2b986e5f8290727dfb2"]);
    const kindsOf = (index: number, code: string) => seen[index].rows.find((row) => row[0] === "municipality" && row[1] === code)?.[2];
    expect([kindsOf(0, "0820200"), kindsOf(0, "1820200"), kindsOf(1, "1820200")]).toEqual(["07 10 14 15 19 49", "14 15 16 19 29", undefined]);
  }, 120_000);
});

// ---- unit だけ（全国報を入れない組） ----
const clock = { wallTimeMs: NOW, monotonicMs: 0 };
const empty = (): WeatherCurrentUnitState => initialUnits["U-W"];
function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: NOW, origin: "replay", kind: "replay",
    body: Buffer.from(transform(fixture(file))), headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const receive = (state: WeatherCurrentUnitState, file: string, headType: string, transform?: (xml: string) => string, inputId?: string) =>
  reduceWeatherCurrentUnit(state, { kind: "receive", material: decode(file, headType, transform, inputId), clock });
const at = (time: string) => (xml: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
const office = (name: string) => (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
const compose = (...steps: ((xml: string) => string)[]) => (xml: string) => steps.reduce((value, step) => step(value), xml);
const FUKUI = "18_00_01_260830_VPWW55_fukui_L5", DOWNGRADE = "18_00_01_260830_VPWW55_fukui_downgrade", RELEASE = "18_00_01_260830_VPWW55_fukui_release", KYOTO = "15_16_02_251222_VPWW57";
// 府県の項目が無いときは null（項目があって areaKinds が空のときの [] と見分ける）。areaKinds の [層, Code] の並びは公開形の areas と同じ順（P4-UAK-AC01）。
const kindsRows = (state: WeatherCurrentUnitState, prefecture: string): [string, string, string][] | null => {
  const entry = areaEntry(state, `normal\u0000${prefecture}`);
  if (entry == null) return null;
  expect(entry.areaKinds.map(([system, code]) => [system, code])).toEqual(entry.area.areas);
  return entry.areaKinds.map(([system, code, kinds]): [string, string, string] => [system, code, kinds.join(" ")]);
};
const kindsOf = (state: WeatherCurrentUnitState, code: string) => kindsRows(state, "18")?.find((row) => row[1] === code)?.[2];
const controlLater = (xml: string) => xml.replace("<DateTime>2026-08-29T21:51:02Z</DateTime>", "<DateTime>2026-08-29T21:55:00Z</DateTime>");
// 1820700 の「レベル３大雨警報（03）」と 1820900 の「レベル２大雨注意報（10）」の Kind を入れ替える（同じ官署の続報、Name・Code ごと）。
const swapKinds = (xml: string) => xml.split("</Item>").map((item) => item.includes("<Code>1820700</Code>")
  ? item.replace(/レベル３大雨警報/g, "レベル２大雨注意報").replace(/<Code>03<\/Code>/g, "<Code>10</Code>")
  : item.includes("<Code>1820900</Code>") ? item.replace(/レベル２大雨注意報/g, "レベル３大雨警報").replace(/<Code>10<\/Code>/g, "<Code>03</Code>") : item).join("</Item>");
const cancel = (time: string) => (xml: string) => at(time)(xml).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>").replace(/<Body[\s\S]*<\/Body>/, "<Body/>");

// P4-UAK-T02 acceptance（AC03・AC04）: 区域×種別の対応が続報・取消・復元で古いまま残らず、触れていない府県の object は動かない。
describe("P4-UAK-T02 acceptance: the kinds follow the winning rows through follow-ups, a cancel and a restore", () => {
  it("(ア) one unit takes L5, downgrade and release in turn: 33 → 43 → gone, and the item stays with no areas after the release", () => {
    let state = receive(empty(), FUKUI, "VPWW55").state;
    expect([rowsHash(kindsRows(state, "18")!), kindsOf(state, "1820100")]).toEqual(["0a12dc708bd83b979aeff8ce094138936f814c6a0cd3a6d8a9e8e68d0e9838bc", "33"]);
    state = receive(state, DOWNGRADE, "VPWW55").state;
    expect([rowsHash(kindsRows(state, "18")!), kindsOf(state, "1820100")]).toEqual(["110aa54a838f54f0d2d56a894b36dbcfb71dee133334290c0fe6aeed486a88ef", "43"]);
    state = receive(state, RELEASE, "VPWW55").state;
    const entry = areaEntry(state, "normal\u000018");
    expect([entry == null, kindsRows(state, "18"), entry?.area.areas, kindsOf(state, "1820100")]).toEqual([false, [], [], undefined]);
  });

  it("(イ)(ウ) moves kinds between areas without a stale pair, leaves Kyoto's object alone, and restores empty", () => {
    const newest = compose(office("福井X"), at("2026-08-30T10:00:00+09:00"), (xml) => xml.replace(/<Code>\d(\d)<\/Code>/g, "<Code>2$1</Code>"));
    let state = receive(empty(), KYOTO, "VPWW57").state;
    const kyoto = areaEntry(state, "normal\u000026");
    state = receive(state, FUKUI, "VPWW55", newest, "newest").state;
    const first = receive(state, FUKUI, "VPWW55");
    const before = areaEntry(first.state, "normal\u000018")!;
    expect([kindsOf(first.state, "1820700"), kindsOf(first.state, "1820900")]).toEqual(["03 23", "10 20"]);
    // 報時刻を変えず Control の時刻だけを進め、2 区域の Kind（Name と Code）を入れ替えた更新でも、使い回しは止まり areaKinds が新しくなる（AC03。Code だけを替える入力は契約 T02 の列の外）。
    const correction = receive(first.state, FUKUI, "VPWW55", compose(controlLater, swapKinds), "control-only");
    const corrected = areaEntry(correction.state, "normal\u000018")!;
    expect([corrected === before, corrected.area.source, corrected.area.areas, kindsOf(correction.state, "1820700"), kindsOf(correction.state, "1820900"),
      correction.displayChanges.some((change) => change.subject === "normal/area/18" && change.after?.unit === "U-W" && change.after.areaKinds != null
        && change.after.areaKinds.some(([, code, kinds]) => code === "1820700" && kinds.join(" ") === "10 23"))])
      .toEqual([false, before.area.source, before.area.areas, "10 23", "03 20", true]);
    const swapped = receive(first.state, FUKUI, "VPWW55", compose(at("2026-08-30T06:52:00+09:00"), swapKinds), "swap");
    const after = areaEntry(swapped.state, "normal\u000018")!;
    expect([after === before, after.area.revision === before.area.revision, after.area.source, after.area.areas, after.area.codes, after.area.names,
      swapped.displayChanges.some((change) => change.subject === "normal/area/18"), kindsOf(swapped.state, "1820700"), kindsOf(swapped.state, "1820900")])
      .toEqual([false, false, before.area.source, before.area.areas, before.area.codes, before.area.names, true, "10 23", "03 20"]);
    const cancelled = receive(swapped.state, FUKUI, "VPWW55", cancel("2026-08-30T06:53:00+09:00"), "cancel");
    expect([kindsOf(cancelled.state, "1820700"), kindsOf(cancelled.state, "1820900")]).toEqual(["03 23", "10 20"]);
    for (const step of [first, correction, swapped, cancelled]) expect(areaEntry(step.state, "normal\u000026")).toBe(kyoto);
    // 保存して復元した直後は復元して未確認で空。続けて downgrade を受けると (ア) の値になり、京都の object は動かない。
    const restored = reduceWeatherCurrentUnit(empty(), { kind: "restore", persisted: weatherCurrentUnitCodec.encode(cancelled.state), clock }).state;
    expect([kindsRows(restored, "18"), kindsRows(restored, "26")]).toEqual([[], []]);
    const restoredKyoto = areaEntry(restored, "normal\u000026");
    expect(restoredKyoto).not.toBeNull();
    const downgraded = receive(restored, DOWNGRADE, "VPWW55");
    expect(rowsHash(kindsRows(downgraded.state, "18")!)).toBe("110aa54a838f54f0d2d56a894b36dbcfb71dee133334290c0fe6aeed486a88ef");
    expect(areaEntry(downgraded.state, "normal\u000026")).toBe(restoredKyoto);
  });
});

// P4-UAK-T03 contractBoundary（AC02・AC05・AC06）: worker をまたいだ写しでも snapshot と part=item が同じ areas を返し、旧の view には areaKinds が出ない。
describe("P4-UAK-T03 contractBoundary: a structuredClone of the owner's changes gives the same areas as part=item", () => {
  it("keeps cols and rows equal, within the byte limits, and leaves the legacy view free of areaKinds", async () => {
    const step = ownerReceive(fixture(KYOTO), "VPWW57", null);
    const cloned = structuredClone(step.displayChanges);
    const result = projected(await project(withWeather(await baseViews(), step), cloned, null));
    const items = areaItems(result.snapshot);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const response = detailOwner(step.state, { unit: "U-W", part: "item", id: item.id, revision: item.rev });
      if (response.kind !== "ok" || response.part !== "item") throw new Error("part=item");
      const lists = (value: VocabItem) => value.lists.filter((list) => list.role === "areas").map(({ sys, cols, rows }) => ({ sys, cols, rows }));
      expect(lists(response.item)).toEqual(lists(item));
      expect(lists(item).length).toBeGreaterThan(0);
      expect(inOrder(item)).toBe(true);
      for (const list of lists(item)) {
        expect(list.cols).toEqual(["kinds"]);
        for (const row of list.rows) {
          const kinds = String(row[2]).split(" ");
          expect([row.length, row[1], kinds.every((kind) => /^\d{2}$/.test(kind)), kinds.every((kind, index) => index === 0 || kinds[index - 1] < kind)]).toEqual([3, null, true, true]);
        }
      }
      expect(answerBytes(step.state, item)).toBeLessThanOrEqual(65_536);
    }
    expect(items.flatMap((item) => item.lists.flatMap((list) => list.role === "areas" && list.sys === "stormSurge" ? list.rows : []))).toEqual([["2635999", null, "48"]]);
    expect([result.snapshot.current.weatherCurrent.delivery, bytes(result.snapshot) <= MIB]).toEqual(["full", true]);
    const weatherRows = step.displayChanges.flatMap((change) => change.after?.unit === "U-W" ? [change.after] : []);
    expect(weatherRows.every((row) => row.current == null ? row.areaKinds == null : row.areaKinds != null)).toBe(true);
    expect(weatherRows.some((row) => row.current != null)).toBe(true);
    const unit = step.state.units["U-W"];
    expect(unit == null ? null : JSON.stringify(toWeatherCurrentView(unit)).includes("areaKinds")).toBe(false);
    expect(JSON.stringify(step.displayChanges).includes("areaKinds")).toBe(true);
  });
});
