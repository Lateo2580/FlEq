import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";

import type { MaterialValue } from "../../contracts/p1-parser-boundary.types";
import type { RuntimeDisplayChange, RuntimeUnitView, UnreadableMark } from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { DisplayVocabDomain, DisplayWireSnapshot, VocabItem, VocabItemOf, VocabKind, VocabUnit, WireDetailRequest } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, finalizeOwner, ownerViews, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { classifyHeadType, executionPlaces, placeOfHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import { weatherCurrentDetail } from "../../src/units/weather-current/weather-current-public";
import { timeseriesPublicSubject } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import type { DisplayWireInput, DisplayWireResult, DisplayWireState } from "../../src/view-projector/display-wire";
import manifest from "../../tools/corpus/manifest.json";
import sequences from "../../tools/corpus/sequences.json";
import contract from "../../contracts/p4-display-vocab.json";
import { baseInput, material, projected } from "./display-wire-fixture";

// P4-DISPLAY-VOCAB-001 の試験。owner の 1 step の表示差分と view を新しい経路に渡し、同じ owner の state に詳細を問う（snapshot と詳細が同じ object から作られる）。

const AT = Date.parse("2099-01-01T09:00:00+09:00");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const empty = (place: ExecutionPlace): OwnerState => restoreOwner({ runId: "run", place, clock: { wallTimeMs: AT, monotonicMs: 1 },
  restored: Object.fromEntries(runtimeUnits.filter((unit) => executionPlaces[unit] === place).map((unit) => [unit, { kind: "empty" }])) }, linkedUnitTable, linkedUnitCodecs).state;
const fixtures = new Map(manifest.fixtures.map((item) => [item.fixtureId, item]));
let sequence = 0;
// 1 通を空の owner（または渡した owner）に通す。
function receive(fixtureId: string, owner: OwnerState | null = null, transform: (xml: string) => string = (xml) => xml) {
  const fixture = fixtures.get(fixtureId);
  const headType = fixture?.transport.headType;
  if (fixture == null || headType == null) throw new Error(fixtureId);
  const decoded = material(transform(readFileSync(fixture.path, "utf8")), headType);
  const at = Date.parse(decoded.reportDateTimeRaw), place = placeOfHeadType(headType);
  const clock = { wallTimeMs: Number.isFinite(at) ? at + 1000 : AT, monotonicMs: ++sequence };
  const step = receiveOwner(owner ?? empty(place), { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } }, clock, linkedUnitTable);
  return { step, clock, place };
}
type Views = DisplayWireInput["views"];
function withView(views: Views, view: RuntimeUnitView): Views {
  switch (view.unit) {
    case "U-E": return { ...views, eew: view };
    case "U-T": return { ...views, tsunami: view };
    case "U-Q": return { ...views, earthquake: view };
    case "U-W": return { ...views, weatherCurrent: view };
    case "U-F": return { ...views, weatherTimeseries: view };
    case "U-N": return { ...views, nankai: view };
    case "U-V": return { ...views, volcano: view };
    case "U-L": return { ...views, landslide: view };
    case "U-R": return { ...views, flood: view };
    case "U-B": return { ...views, briefing: view };
    case "U-M": return { ...views, localBulletins: view };
    case "U-Y": return { ...views, typhoon: view };
  }
}
async function baseViews(): Promise<Views> {
  const { input } = await baseInput();
  return { eew: input.eew, tsunami: input.tsunami, earthquake: input.earthquake, weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries,
    nankai: input.nankai, volcano: input.volcano, landslide: input.landslide, flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins,
    typhoon: input.typhoon };
}
async function publish(views: Views, changes: readonly RuntimeDisplayChange[], previous: DisplayWireState | null = null): Promise<DisplayWireResult> {
  const { input } = await baseInput();
  return projectDisplayWire({ projection: { ...input, displayChanges: changes }, views, confirmation: input.confirmation, notices: [] }, previous);
}
const KEYS: Readonly<Record<VocabUnit, keyof Views>> = { "U-W": "weatherCurrent", "U-F": "weatherTimeseries", "U-N": "nankai", "U-V": "volcano", "U-L": "landslide",
  "U-R": "flood", "U-B": "briefing", "U-M": "localBulletins", "U-Y": "typhoon" };
const VOCAB_UNITS: readonly VocabUnit[] = ["U-W", "U-F", "U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"];
const isVocab = (unit: string): unit is VocabUnit => unit in KEYS;
const domainOf = (snapshot: DisplayWireSnapshot, unit: VocabUnit): DisplayVocabDomain<VocabUnit> => {
  const domain = snapshot.current[KEYS[unit]];
  if (!("delivery" in domain)) throw new Error("protected");
  return domain;
};
const itemsOf = (snapshot: DisplayWireSnapshot, unit: VocabUnit): readonly VocabItem[] => {
  const domain = domainOf(snapshot, unit);
  return domain.delivery === "full" ? domain.wire.items : [];
};
// view の要素（k、subject、object）。U-V の不足の subject は unit の形（volcano-unit.ts の resolveShortfall）。
type Element = Readonly<{ k: VocabKind; unit: VocabUnit; operation: string; subject: string; value: Readonly<Record<string, unknown>>; id?: string; revision?: string }>;
function elementsOf(view: RuntimeUnitView): readonly Element[] {
  const of = (k: VocabKind, unit: VocabUnit, value: Readonly<{ operation: string; subject: string }>): Element => ({ k, unit, operation: value.operation, subject: value.subject, value });
  switch (view.unit) {
    case "U-W": return view.areas.map((item) => ({ ...of("weatherCurrent.area", "U-W", item), id: item.id, revision: item.revision }));
    case "U-F": return view.series.map((item) => ({ ...of("weatherTimeseries.subject", "U-F", item), id: item.id, revision: item.revision }));
    case "U-N": return [...view.currents.map((item) => of("nankai.current", "U-N", item)), ...view.information.map((item) => of("nankai.information", "U-N", item))];
    case "U-V": return [...view.alerts.map((item) => of("volcano.alert", "U-V", item)), ...view.eruptions.map((item) => of("volcano.eruption", "U-V", item)),
      ...view.ashfalls.map((item) => of("volcano.ashfall", "U-V", item)), ...view.bulletins.map((item) => of("volcano.bulletin", "U-V", item)),
      ...view.shortfalls.map((item) => ({ k: "volcano.shortfall" as const, unit: "U-V" as const, operation: item.operation, subject: `${item.operation}/shortfall/${item.id}`, value: item }))];
    case "U-L": return view.currents.map((item) => of("landslide.office", "U-L", item));
    case "U-R": return view.currents.map((item) => of("flood.event", "U-R", item));
    case "U-B": return view.currents.map((item) => of("briefing.current", "U-B", item));
    case "U-M": return [...view.tornado.map((item) => of("localBulletins.tornado", "U-M", item)), ...view.heat.map((item) => of("localBulletins.heat", "U-M", item)),
      ...view.transient.map((item) => of("localBulletins.transient", "U-M", item))];
    case "U-Y": return [...view.analysis.map((item) => of("typhoon.analysis", "U-Y", item)), ...view.probability.map((item) => of("typhoon.probability", "U-Y", item))];
    default: return [];
  }
}
const expectedIds = (element: Element) => ({ id: element.id ?? sha([element.unit, element.operation, element.subject]), rev: element.revision ?? sha(element.value) });
// 表 §1.3 の載せない欄。effective は active だけの配列で値が 1 つ（U-F と U-B は複数の値なので載せる）。
const NOT_CARRIED = new Set(["subject", "landEventId", "marineEventId"]);
const ALIAS: Readonly<Record<string, (item: VocabItem) => boolean>> = {
  id: (item) => item.id.length === 64, revision: (item) => item.rev !== "", operation: (item) => item.op !== undefined, title: (item) => item.title !== undefined,
  source: (item) => item.time !== undefined && item.facts.some(([label]) => label === "source.family"), unconfirmed: (item) => item.marks.includes("unconfirmed"),
  unreadableView: (item) => item.unread && item.lists.some((list) => list.role === "unreadable"), codes: (item) => item.lists.some((list) => list.role === "phenomena"),
  names: (item) => item.lists.some((list) => list.role === "phenomena"), groups: (item) => item.lists.some((list) => list.role === "ashGroup"),
  times: (item) => item.special?.kind === "floodSeries", stations: (item) => item.special?.kind === "floodSeries", frames: (item) => item.special?.kind === "typhoonFrames",
  marineUnreadableView: (item) => item.lists.some((list) => list.role === "marineUnreadable"),
};
function uncovered(element: Element, item: VocabItem): readonly string[] {
  return Object.keys(element.value).filter((key) => {
    if (NOT_CARRIED.has(key)) return false;
    // group ごとの一覧（表 §1.3 の構造の列）は group が 0 件なら一覧も 0 件。
    const value = element.value[key];
    if (Array.isArray(value) && value.length === 0) return false;
    // 文の欄（texts）は字のあるものだけを並べ、null は並べない（表 §1.2）。
    if (value === null && (key === "headline" || key === "prevention")) return false;
    if (key === "effective" && element.k !== "weatherTimeseries.subject" && element.k !== "briefing.current") return false;
    const alias = ALIAS[key];
    if (alias != null) return !alias(item);
    return !(item.facts.some(([label]) => label === key || label.startsWith(`${key}.`)) || item.lists.some((list) => list.role === key)
      || item.texts.some(([role]) => role === key));
  });
}
// 表 §1.5 の写す期限の欄。
const EXPIRY: Readonly<Record<VocabKind, readonly string[]>> = {
  "weatherCurrent.area": [], "weatherTimeseries.subject": ["validUntil"], "nankai.current": ["validUntil", "warningUntil", "retainUntil"],
  "nankai.information": ["validUntil", "retainUntil"], "volcano.alert": ["retainUntil"], "volcano.eruption": ["validUntil", "retainUntil"],
  "volcano.ashfall": ["forecastStartsAt", "forecastEndsAt", "retainUntil"], "volcano.bulletin": ["retainUntil"], "volcano.shortfall": [], "landslide.office": ["retainUntil"],
  "flood.event": ["retainUntil"], "briefing.current": ["retainUntil"], "localBulletins.tornado": ["activeUntil", "retainUntil"],
  "localBulletins.heat": ["activeUntil", "retainUntil"], "localBulletins.transient": ["visibleUntil", "retainUntil"], "typhoon.analysis": ["activeUntil", "retainUntil"],
  "typhoon.probability": ["activeUntil", "retainUntil"],
};
const fact = (item: VocabItem, label: string) => item.facts.find(([name]) => name === label)?.[1];
// 1 通の電文を新しい経路に流した結果（owner の state、view、snapshot）。
async function onePublication(fixtureId: string, transform?: (xml: string) => string) {
  const { step } = receive(fixtureId, null, transform);
  let views = await baseViews();
  for (const view of step.views) views = withView(views, view);
  const snapshot = projected(await publish(views, step.displayChanges)).snapshot;
  return { owner: step.state, views: step.views, snapshot };
}
const FIXTURE_IDS: readonly string[] = contract.contract.fixtureIds;
// fixtureIds に無い種類（降灰・解説・熱中症）は corpus の同じ headType の最初の 1 通で足す。
const EXTRA_IDS: readonly string[] = ["VFVO54", "VFVO55", "VFVO60", "VZVO40", "VPFT50"].flatMap((headType) => manifest.fixtures.find((item) => item.transport.headType === headType
  && item.path.startsWith("test/fixtures/"))?.fixtureId ?? []);

// 受入条件 P4-DV-AC01・AC02・AC08・AC09。
describe("P4-DV-T01 acceptance: the vocabulary of the nine domains", () => {
  it("carries every view field of every element in fixtureIds with its id, rev, id order and display deadlines", async () => {
    const seen = new Set<VocabKind>();
    for (const fixtureId of [...FIXTURE_IDS, ...EXTRA_IDS]) {
      const { views, snapshot } = await onePublication(fixtureId);
      expect(snapshot.schemaVersion).toBe("p4-display-wire-v2");
      expect(Object.keys(snapshot.current)).toEqual(["eew", "tsunami", "earthquake", "weatherCurrent", "weatherTimeseries", "nankai", "volcano", "landslide", "flood", "briefing",
        "localBulletins", "typhoon"]);
      expect(snapshot.semanticRevision).toBe(JSON.stringify(Object.values(snapshot.current).map((domain) => domain.contentRevision)));
      expect(JSON.stringify(snapshot.current)).not.toContain('"view"');
      for (const view of views) {
        if (!isVocab(view.unit)) continue;
        const items = itemsOf(snapshot, view.unit);
        expect(items.map((item) => item.id)).toEqual([...items.map((item) => item.id)].sort());
        const elements = elementsOf(view);
        expect([fixtureId, items.length]).toEqual([fixtureId, elements.length]);
        for (const element of elements) {
          const ids = expectedIds(element), item = items.find((entry) => entry.id === ids.id);
          if (item == null) throw new Error(`${fixtureId} ${element.subject}`);
          seen.add(item.k);
          expect([fixtureId, item.k, item.rev]).toEqual([fixtureId, element.k, ids.rev]);
          expect([fixtureId, element.k, uncovered(element, item)]).toEqual([fixtureId, element.k, []]);
          expect([element.k, EXPIRY[element.k].filter((label) => !item.facts.some(([name]) => name === label))]).toEqual([element.k, []]);
          const mark = element.value.unreadableView;
          if (mark != null && typeof mark === "object" && "parts" in mark && Array.isArray(mark.parts))
            expect([item.unread, item.lists.find((list) => list.role === "unreadable")?.rows.length]).toEqual([true, mark.parts.length]);
          if (element.k === "weatherCurrent.area" && item.k === "weatherCurrent.area") {
            const value = view.unit === "U-W" ? view.areas.find((area) => area.id === item.id) : undefined;
            const phenomena = item.lists.find((list) => list.role === "phenomena");
            expect(phenomena?.rows.map((row) => row[0])).toEqual(Object.keys(value?.codes ?? {}).sort());
            for (const row of phenomena?.rows ?? []) expect(row[1]).toEqual(value?.names[String(row[0])] == null ? null : { text: value.names[String(row[0])], cut: false });
          }
          if (item.k === "volcano.eruption" && view.unit === "U-V") {
            // 表 §1.3 の sv の表（kind ごとに value・bound・raw）。
            const eruption = view.eruptions.find((entry) => entry.subject === element.subject);
            const sv = (value: MaterialValue) => value.kind === "number" || value.kind === "text" ? ["sv", value.kind, value.value, null, value.raw]
              : value.kind === "range" ? ["sv", "range", value.value, value.bound, value.raw] : value.kind === "missing" ? ["sv", "missing", null, null, null]
                : ["sv", value.kind, null, null, value.raw];
            if (eruption == null) throw new Error("eruption");
            expect([fact(item, "plumeAboveCrater"), fact(item, "plumeAboveSeaLevel")]).toEqual([sv(eruption.plumeAboveCrater), sv(eruption.plumeAboveSeaLevel)]);
          }
        }
      }
    }
    // 17 種のうち不足（復元の移行だけが作る）を除く 16 種（VPOA50 は対応報待ちの held で view に載らない。不足は次の it）。
    expect([...seen].sort()).toEqual(["briefing.current", "flood.event", "landslide.office", "localBulletins.heat", "localBulletins.tornado", "localBulletins.transient",
      "nankai.current", "nankai.information", "typhoon.analysis", "typhoon.probability", "volcano.alert", "volcano.ashfall", "volcano.bulletin", "volcano.eruption",
      "weatherCurrent.area", "weatherTimeseries.subject"]);
  });

  it("keeps a shortfall's id apart from a record whose subject is the shortfall id, and fixes labels and roles per kind", async () => {
    const { views } = await onePublication("test__fixtures__45_01_01_200522_VFVO50");
    const volcano = views.find((view) => view.unit === "U-V");
    if (volcano?.unit !== "U-V") throw new Error("no volcano");
    const alert = volcano.alerts[0];
    // 不足の id を通常の記録の subject と同じ字にした手製の形。
    const view = { ...volcano, shortfalls: [{ id: alert.subject, operation: alert.operation, slice: "alert" as const, scope: "volcano" as const, volcanoCode: alert.volcanoCode,
      lastKnown: null, reason: "provenanceMissing" as const }] };
    const changes: RuntimeDisplayChange[] = [{ unit: "U-V", operation: alert.operation, subject: alert.subject, before: null,
      after: { unit: "U-V", operation: alert.operation, subject: alert.subject, office: null, current: alert, subjects: volcano.subjects } }];
    const snapshot = projected(await publish(withView(await baseViews(), view), changes)).snapshot;
    const items = itemsOf(snapshot, "U-V");
    expect(items.map((item) => item.k).sort()).toEqual(["volcano.alert", "volcano.shortfall"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.find((item) => item.k === "volcano.shortfall")?.id).toBe(sha(["U-V", alert.operation, `${alert.operation}/shortfall/${alert.subject}`]));
    // 型に無い label・role は作れない（spec:1268）。
    // @ts-expect-error U-N の現況は区域の一覧の label を持たない
    const label: VocabItemOf<"nankai.current">["facts"][number] = ["areas", 1];
    // @ts-expect-error 土砂の一覧は phenomena を持たない
    const role: VocabItemOf<"landslide.office">["lists"][number]["role"] = "phenomena";
    // @ts-expect-error 台風の確率は専用部品を持たない
    const special: VocabItemOf<"typhoon.probability">["special"] = { kind: "typhoonFrames", frames: [] };
    expect([label, role, special]).toHaveLength(3);
  });
});

// 契約の境界 P4-DV-AC04。
type Big = Readonly<{ unit: "U-L" | "U-R" | "U-B"; count: number; title: number }>;
async function bigViews(templates: Templates, bigs: readonly Big[], typhoonCards = 0) {
  let views = await baseViews();
  const changes: RuntimeDisplayChange[] = [];
  const many = <T extends Readonly<{ subject: string; title: string }>>(template: T, count: number, title: number): T[] =>
    Array.from({ length: count }, (_, index) => ({ ...template, subject: `${template.subject}/${index}`, title: "題".repeat(title) }));
  for (const { unit, count, title } of bigs) {
    if (unit === "U-L") {
      const currents = many(templates["U-L"].currents[0], count, title);
      for (const current of currents) changes.push({ unit, operation: current.operation, subject: current.subject, before: null,
        after: { unit, operation: current.operation, subject: current.subject, office: null, current, subjects: [] } });
      views = { ...views, landslide: { ...templates["U-L"], subjects: [], currents } };
    } else if (unit === "U-R") {
      const currents = many(templates["U-R"].currents[0], count, title);
      for (const current of currents) changes.push({ unit, operation: current.operation, subject: current.subject, before: null,
        after: { unit, operation: current.operation, subject: current.subject, office: null, current, subjects: [] } });
      views = { ...views, flood: { ...templates["U-R"], subjects: [], currents } };
    } else {
      const currents = many(templates["U-B"].currents[0], count, title);
      for (const current of currents) changes.push({ unit, operation: current.operation, subject: current.subject, before: null,
        after: { unit, operation: current.operation, subject: current.subject, office: null, current, subjects: [] } });
      views = { ...views, briefing: { ...templates["U-B"], subjects: [], currents } };
    }
  }
  if (typhoonCards > 0) {
    const card = { kind: "unreadable" as const, inputId: "input-y", headType: "VPTA50", operation: "normal" as const, receivedAt: 1, reason: "xmlInvalid" as const, title: null,
      headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true,
      areas: Array.from({ length: 384 }, (_, index) => ({ code: String(1000000 + index), name: "地域", value: index % 100 })) };
    views = { ...views, typhoon: { ...views.typhoon, unreadableCards: Array.from({ length: typhoonCards }, (_, index) => ({ ...card, inputId: `input-y${index}` })) } };
  }
  return { views, changes };
}
type Templates = Readonly<{ "U-L": DisplayWireInput["views"]["landslide"]; "U-R": DisplayWireInput["views"]["flood"]; "U-B": DisplayWireInput["views"]["briefing"] }>;
async function templates(): Promise<Templates> {
  const landslide = receive("test__fixtures__15_16_01_241031_VPWW56").step.views.find((view) => view.unit === "U-L");
  const flood = receive("test__fixtures__16_01_01_220728_VXKO50").step.views.find((view) => view.unit === "U-R");
  const briefing = receive("test__fixtures__82_01_01_260324_VPBS50").step.views.find((view) => view.unit === "U-B");
  if (landslide?.unit !== "U-L" || flood?.unit !== "U-R" || briefing?.unit !== "U-B") throw new Error("templates");
  return { "U-L": landslide, "U-R": flood, "U-B": briefing };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
describe("P4-DV-T02 contractBoundary: the summary rule of the nine domains", () => {
  it("keeps an over-budget domain full under 1 MiB, summarizes only the over-budget nine above it, and stays within 1 MiB and 967,258", async () => {
    const shapes = await templates();
    // (a) 全体が 1 MiB 以下: 65,536 を越えた U-L も full。
    const under = await bigViews(shapes, [{ unit: "U-L", count: 40, title: 1000 }]);
    const fullOnly = projected(await publish(under.views, under.changes)).snapshot;
    expect(domainOf(fullOnly, "U-L").delivery).toBe("full");
    expect(bytes(domainOf(fullOnly, "U-L"))).toBeGreaterThan(65_536);
    expect(bytes(fullOnly)).toBeLessThanOrEqual(1_048_576);
    // (b) 全体が越える: 65,536 を越えた 9 分野（U-L・U-R・U-Y のカード 8 枚）だけ要約、少し下の U-B は full、保護 3 分野は full。
    // U-B は 1 件の byte を量って 65,536 の 1 件ぶん下に合わせる。
    const briefingBytes = async (count: number) => { const one = await bigViews(shapes, [{ unit: "U-B", count, title: 1000 }]);
      return bytes(domainOf(projected(await publish(one.views, one.changes)).snapshot, "U-B")); };
    const [one, two] = [await briefingBytes(1), await briefingBytes(2)], per = two - one, count = Math.floor((65_536 - one) / per) + 1;
    const over = await bigViews(shapes, [{ unit: "U-L", count: 200, title: 1000 }, { unit: "U-R", count: 200, title: 1000 }, { unit: "U-B", count, title: 1000 }], 8);
    const result = projected(await publish(over.views, over.changes)).snapshot;
    expect(VOCAB_UNITS.map((unit) => [unit, domainOf(result, unit).delivery])).toEqual(VOCAB_UNITS.map((unit) => [unit, ["U-L", "U-R", "U-Y"].includes(unit) ? "summary" : "full"]));
    expect(bytes(domainOf(result, "U-B"))).toBeLessThanOrEqual(65_536);
    expect(bytes(domainOf(result, "U-B"))).toBeGreaterThan(65_536 - per);
    for (const unit of ["U-L", "U-R", "U-Y"] as const) {
      const domain = domainOf(result, unit);
      expect(Object.keys(domain)).toEqual(["unit", "contentRevision", "items", "delivery", "reason", "originalBytes", "budgetBytes"]);
      expect(bytes(domain)).toBeLessThanOrEqual(3_882);
      if (domain.delivery === "summary") expect(domain.originalBytes).toBeGreaterThan(65_536);
    }
    expect("delivery" in result.current.eew).toBe(false);
    expect(bytes(result)).toBeLessThanOrEqual(967_258);
  });

  it("publishes each step of O09 (its restart and receive steps) within 1 MiB", async () => {
    const o09 = sequences.sequences.find((item) => item.sequenceId === "O09");
    if (o09 == null) throw new Error("O09");
    let owners = new Map<ExecutionPlace, OwnerState>(), previous: DisplayWireState | null = null, views = await baseViews(), published = 0;
    for (const step of o09.steps) {
      // restart は新しい stream（空の owner から、前の state を持たない）。injectFailure は射影の入力に写せないので流さない。
      if (step.action === "restart") { owners = new Map(); previous = null; views = await baseViews(); continue; }
      if (step.action !== "receive" || step.fixtureId == null) continue;
      const headType = fixtures.get(step.fixtureId)?.transport.headType;
      if (headType == null || classifyHeadType(headType).status !== "ready") continue;
      const place = placeOfHeadType(headType);
      const { step: done } = receive(step.fixtureId, owners.get(place) ?? null);
      owners.set(place, done.state);
      for (const view of done.views) views = withView(views, view);
      const result = await publish(views, done.displayChanges, previous);
      previous = result.state;
      if (result.kind === "projected") { expect(bytes(result.snapshot)).toBeLessThanOrEqual(1_048_576); published++; }
    }
    expect(published).toBeGreaterThan(0);
  });
});

// 契約の境界 P4-DV-AC06。
describe("P4-DV-T03 contractBoundary: the work per update in a 512-item domain", () => {
  it("rebuilds and serializes only the changed subjects and merges in at most N + K moves", async () => {
    const shapes = await templates();
    const filled = await bigViews(shapes, [{ unit: "U-L", count: 512, title: 4 }]);
    let result = await publish(filled.views, filled.changes);
    const base = filled.views.landslide, list = base.currents;
    const update = (indexes: readonly number[], title: string, remove = false) => indexes.map((index): RuntimeDisplayChange => {
      const before = list[index], after = { ...before, title };
      return { unit: "U-L", operation: before.operation, subject: before.subject, before: { unit: "U-L", operation: before.operation, subject: before.subject, office: null,
        current: before, subjects: [] }, after: remove ? null : { unit: "U-L", operation: before.operation, subject: before.subject, office: null, current: after, subjects: [] } };
    });
    const step = async (changes: readonly RuntimeDisplayChange[], view = base) => {
      result = await publish({ ...filled.views, landslide: view }, changes, result.state);
      return result.vocabCounts.landslide;
    };
    expect(await step(update([7], "更新"))).toEqual({ rebuilt: 1, serialized: 1, moved: 512 });
    expect(await step(update([8], "", true))).toEqual({ rebuilt: 0, serialized: 0, moved: 511 });
    const many = await step(update(Array.from({ length: 64 }, (_, index) => 100 + index), "まとめて"));
    expect([many.rebuilt, many.serialized]).toEqual([64, 64]);
    expect(many.moved).toBeLessThanOrEqual(511 + 64);
    // metadata だけ（表示差分なし・同じ view）。
    expect(await step([])).toEqual({ rebuilt: 0, serialized: 0, moved: 0 });
    // 項目の無い subject の差分（前も後も無い）は並びを動かさず、公開もしない。
    const absent: RuntimeDisplayChange = { unit: "U-L", operation: "normal", subject: "normal/VPWW56/absent", before: null, after: null };
    expect(await step([absent])).toEqual({ rebuilt: 0, serialized: 0, moved: 0 });
    expect(result.kind).toBe("unchanged");
    // 要約から full への戻り: ほかの分野で全体を 1 MiB の上に上げて U-L を要約にし、外すと full に戻る。どちらの step も U-L の作り直しは 0。
    const heavy = await bigViews(shapes, [{ unit: "U-R", count: 400, title: 1000 }, { unit: "U-B", count: 400, title: 1000 }]);
    result = await publish({ ...heavy.views, landslide: base }, heavy.changes, result.state);
    expect(projected(result).snapshot.current.landslide.delivery).toBe("summary");
    expect(result.vocabCounts.landslide).toEqual({ rebuilt: 0, serialized: 0, moved: 0 });
    const removals = heavy.changes.map((change) => ({ ...change, before: change.after, after: null }));
    result = await publish({ ...filled.views, landslide: base }, removals, result.state);
    expect(projected(result).snapshot.current.landslide.delivery).toBe("full");
    expect(result.vocabCounts.landslide).toEqual({ rebuilt: 0, serialized: 0, moved: 0 });
  });
});

// 受入条件 P4-DV-AC05・AC03。
type IndexUnit = "U-N" | "U-V" | "U-L" | "U-R" | "U-B" | "U-M" | "U-Y";
const INDEX_UNITS: readonly IndexUnit[] = ["U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"];
function allPages(owner: OwnerState, unit: IndexUnit) {
  const entries: { id: string; revision: string; item: VocabItem }[] = [], omitted: { index: number }[] = [];
  const revision = String(owner.units[unit]?.contentRevision);
  for (let page = 0; ; page++) {
    const response = detailOwner(owner, { unit, part: "index", revision, page });
    if (response.kind !== "ok" || response.part !== "index" || !("omitted" in response)) throw new Error(`${unit} index`);
    expect(bytes({ streamId: "x".repeat(64), ...response })).toBeLessThanOrEqual(65_536);
    for (const entry of response.entries) if (entry.part === "item") entries.push(entry);
    omitted.push(...response.omitted);
    if (page + 1 >= response.pageCount) return { entries, omitted };
  }
}
describe("P4-DV-T04 acceptance: the index of the seven domains reaches every item", () => {
  it("lists every view item once with the same vocabulary as the snapshot, opens the text by the ref, and carries what does not fit to the next page", async () => {
    let checked = 0;
    for (const fixtureId of [...FIXTURE_IDS, ...EXTRA_IDS]) {
      const { owner, views, snapshot } = await onePublication(fixtureId);
      for (const view of views) {
        if (!INDEX_UNITS.some((unit) => unit === view.unit)) continue;
        const unit = INDEX_UNITS.find((item) => item === view.unit)!;
        const { entries, omitted } = allPages(owner, unit);
        expect([fixtureId, omitted]).toEqual([fixtureId, []]);
        // 字を切らないことのほかは snapshot の項目と同じ（corpus には切る長さの字が無い）。
        expect(entries.map((entry) => entry.item)).toEqual(elementsOf(view).map((element) => itemsOf(snapshot, unit).find((item) => item.id === expectedIds(element).id)));
        expect(entries.map((entry) => [entry.id, entry.revision])).toEqual(elementsOf(view).map((element) => [expectedIds(element).id, expectedIds(element).rev]));
        for (const entry of entries) if (entry.item.ref?.part === "text") {
          expect(detailOwner(owner, { unit: unit === "U-N" ? "U-N" : "U-V", part: "text", id: entry.item.ref.id, revision: entry.item.ref.rev })).toMatchObject({ kind: "ok", part: "text" });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    // 32 件に入らない byte の項目は次のページの先頭へ繰り越し、1 件だけで 1 応答に入らない項目は印だけのページになる。
    const { step } = receive("test__fixtures__15_16_01_241031_VPWW56");
    const unit = step.state.units["U-L"]!, record = unit.currents[0];
    const wide = Array.from({ length: 40 }, (_, index) => ({ ...record, subject: `${record.subject}/${index}`, title: "題".repeat(index === 5 ? 30_000 : 1_000) }));
    const owner: OwnerState = { ...step.state, units: { ...step.state.units, "U-L": { ...unit, contentRevision: 99, currents: wide } } };
    const { entries, omitted } = allPages(owner, "U-L");
    expect(omitted).toEqual([{ index: 5, reason: "pageBudget", id: sha(["U-L", record.operation, `${record.subject}/5`]), revision: expect.any(String) }]);
    expect(entries.map((entry) => entry.id)).toEqual(wide.flatMap((item, index) => index === 5 ? [] : [sha(["U-L", item.operation, item.subject])]));
    const first = detailOwner(owner, { unit: "U-L", part: "index", revision: "99", page: 0 });
    expect(first.kind === "ok" && first.part === "index" ? [first.entries.length < 32, first.pageCount > 2] : []).toEqual([true, true]);
  });

  it("cuts a 1,537-byte inundation area name in the snapshot and returns it whole in the index", async () => {
    const { step } = receive("test__fixtures__16_01_01_220728_VXKO50");
    const unit = step.state.units["U-R"]!, record = unit.currents[0];
    if (record.effective !== "active") throw new Error("flood");
    const name = "x".repeat(1_537);
    const marked = { ...record, inundation: [{ kindName: "浸水", text: "想定", areas: [{ name, stationCode: "1", prefecture: "県", city: "市", cityCode: "100", subCities: "" }],
      omittedAreaCount: 0 }] };
    const owner: OwnerState = { ...step.state, units: { ...step.state.units, "U-R": { ...unit, contentRevision: 7, currents: [marked] } } };
    const view = ownerViews(owner, linkedUnitTable).find((item) => item.unit === "U-R");
    if (view?.unit !== "U-R") throw new Error("view");
    const current = view.currents[0];
    const snapshot = projected(await publish(withView(await baseViews(), view), [{ unit: "U-R", operation: current.operation, subject: current.subject, before: null,
      after: { unit: "U-R", operation: current.operation, subject: current.subject, office: null, current, subjects: view.subjects } }])).snapshot;
    const row = (item: VocabItem | undefined) => item?.lists.find((list) => list.role === "inundation")?.rows[0][1];
    expect(row(itemsOf(snapshot, "U-R")[0])).toEqual({ text: "x".repeat(1_536), cut: true });
    expect(row(allPages(owner, "U-R").entries[0]?.item)).toEqual({ text: name, cut: false });
  });
});

// corpus 履歴 P4-DV-AC03。
describe("P4-DV-T05 corpusHistory: the legal corpus cuts nothing new in the snapshot", () => {
  it("leaves every new cut field uncut and every raw field readable over test/fixtures of the nine domains", async () => {
    let items = 0;
    for (const fixture of manifest.fixtures) {
      const headType = fixture.transport.headType;
      if (headType == null || !fixture.path.startsWith("test/fixtures/") || classifyHeadType(headType).status !== "ready") continue;
      const row = classifyHeadType(headType);
      if (row.status !== "ready" || !isVocab(row.unit)) continue;
      // 受理の前に断られる電文（ingress・decode の拒否）は corpus の履歴の対象外（P4-DW-T06 と同じ読み方）。
      try { material(readFileSync(fixture.path, "utf8"), headType); } catch { continue; }
      const published = await onePublication(fixture.fixtureId);
      for (const view of published.views) {
        if (!isVocab(view.unit)) continue;
        for (const element of elementsOf(view)) {
          const item = itemsOf(published.snapshot, view.unit).find((entry) => entry.id === expectedIds(element).id);
          if (item == null) throw new Error(fixture.fixtureId);
          items++;
          const cuts = JSON.stringify(item).match(/"cut":true/g) ?? [];
          expect([fixture.fixtureId, cuts.length]).toEqual([fixture.fixtureId, 0]);
          const source = element.value.source;
          if (source != null && typeof source === "object" && "reportDateTimeRaw" in source && "serialRaw" in source && "infoTypeRaw" in source)
            expect([fixture.fixtureId, item.time, item.serial, fact(item, "source.infoType")]).toEqual([fixture.fixtureId, source.reportDateTimeRaw, source.serialRaw, source.infoTypeRaw]);
        }
      }
    }
    expect(items).toBeGreaterThan(50);
  });
});

// 実際の不具合の再発防止 P4-DV-AC11（台帳 147）。
describe("P4-DV-T06 regression: the items count from the new path's own changes", () => {
  it("drops a flood collected by the shutdown finalization from activeCount, the vocabulary and the index, full or summary", async () => {
    const { step, clock } = receive("test__fixtures__16_01_01_220728_VXKO50");
    const unit = step.state.units["U-R"]!, record = unit.currents[0];
    if (record.effective !== "active") throw new Error("flood");
    let views = await baseViews();
    for (const view of step.views) views = withView(views, view);
    let result = await publish(views, step.displayChanges);
    expect(projected(result).snapshot.current.flood.items[0].activeCount).toBe(1);
    // 停止の確定で期限の回収が表示差分を出す（新しい経路にだけ渡る、composition-root の wireChanges）。
    const finalized = finalizeOwner(step.state, { wallTimeMs: record.retainUntil + 1, monotonicMs: clock.monotonicMs + 1 }, linkedUnitTable);
    expect(finalized.displayChanges.length).toBeGreaterThan(0);
    for (const view of finalized.views) views = withView(views, view);
    result = await publish(views, finalized.displayChanges, result.state);
    const flood = projected(result).snapshot.current.flood;
    expect([flood.items[0].activeCount, flood.delivery === "full" ? flood.wire.items.length : -1]).toEqual([0, 0]);
    expect(allPages(finalized.state, "U-R").entries).toEqual([]);
    // 要約のときも同じ items（訓練の大きな記録を残し、ほかの分野で全体を 1 MiB の上に上げる）。
    const shapes = await templates();
    const heavy = await bigViews(shapes, [{ unit: "U-L", count: 400, title: 1000 }, { unit: "U-B", count: 400, title: 1000 }]);
    const big = { ...record, operation: "training" as const, subject: `${record.subject}/training`, title: "題".repeat(30_000) };
    const normal = { ...record };
    const viewWith = (currents: readonly typeof record[]) => ({ ...views.flood, subjects: [], currents });
    const add = (item: typeof record): RuntimeDisplayChange => ({ unit: "U-R", operation: item.operation, subject: item.subject, before: null,
      after: { unit: "U-R", operation: item.operation, subject: item.subject, office: null, current: item, subjects: [] } });
    let summary = await publish({ ...heavy.views, flood: viewWith([normal, big]) }, [...heavy.changes, add(normal), add(big)]);
    expect(projected(summary).snapshot.current.flood.items[0].activeCount).toBe(1);
    summary = await publish({ ...heavy.views, flood: viewWith([big]) }, [{ ...add(normal), before: add(normal).after, after: null }], summary.state);
    const after = projected(summary).snapshot.current.flood;
    expect([after.delivery, after.items[0].activeCount, after.items[1].activeCount]).toEqual(["summary", 0, 1]);
  });
});

// 受入条件 P4-DV-AC12。
describe("P4-DV-T07 acceptance: the item and unreadable parts over HTTP", () => {
  async function serve(state: () => OwnerState, run: (get: (query: string) => Promise<Readonly<{ status: number; body: Record<string, unknown> }>>) => Promise<void>) {
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      detail: (input) => ({ response: Promise.resolve(detailOwner(state(), input.detail)), done: () => {} }) });
    const get = (query: string) => new Promise<Readonly<{ status: number; body: Record<string, unknown> }>>((resolve, reject) => {
      const sent = httpRequest({ host: "127.0.0.1", port: server.port, path: `/api/display/wire/detail?streamId=s&${query}`, agent: false }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      });
      sent.on("error", reject);
      sent.end();
    });
    try { await run(get); } finally { await server.close(); }
  }
  const mark = (parts: readonly (readonly [site: string, scope: string | undefined, raw: string | null])[], headline: string | null = null): UnreadableMark =>
    ({ parts: parts.map(([site, scope, raw]) => ({ site, reason: "requiredStructureInvalid" as const, ...scope == null ? {} : { scope }, raw })), headline });

  it("returns the whole Kind/Name and office, the fragments by side, 409 and a vanished target, and keeps the U-W parts", async () => {
    // U-W の Kind/Name（snapshot は 1,536 byte で切る）。
    const longName = "レベル３大雨警報" + "あ".repeat(600);
    const uw = await onePublication("test__fixtures__15_17_01_251222_VPWW55", (xml) => xml.replaceAll("<Name>レベル３大雨警報</Name>", `<Name>${longName}</Name>`));
    const area = itemsOf(uw.snapshot, "U-W")[0];
    const phenomena = (item: unknown) => typeof item === "object" && item != null && "lists" in item && Array.isArray(item.lists)
      ? item.lists.find((list: { role: string }) => list.role === "phenomena")?.rows : null;
    expect(phenomena(area)?.some((row: unknown[]) => JSON.stringify(row[1]).includes('"cut":true'))).toBe(true);
    await serve(() => uw.owner, async (get) => {
      const answer = await get(`unit=U-W&part=item&id=${area.id}&revision=${area.rev}`);
      expect(answer.status).toBe(200);
      expect(phenomena(answer.body.item)?.some((row: unknown[]) => JSON.stringify(row[1]) === JSON.stringify({ text: longName, cut: false }))).toBe(true);
      expect((await get(`unit=U-W&part=item&id=${area.id}&revision=${Number(area.rev) + 1}`)).body).toMatchObject({ reason: "versionChanged", revision: area.rev });
      expect((await get(`unit=U-W&part=item&id=${"0".repeat(64)}&revision=${area.rev}`)).body).toMatchObject({ reason: "versionChanged", revision: null });
      // 今の U-W の口（index・areas）は今の答えのまま。
      const unit = uw.owner.units["U-W"]!, revision = String(unit.contentRevision);
      const index = detailOwner(uw.owner, { unit: "U-W", part: "index", revision, page: 0 });
      expect(index).toEqual(weatherCurrentDetail(unit, { unit: "U-W", part: "index", revision, page: 0 }, { contentRevision: revision }));
      const areas: WireDetailRequest | Parameters<typeof detailOwner>[1] = { unit: "U-W", part: "areas", id: area.id, revision: area.rev, page: 0 };
      expect(detailOwner(uw.owner, areas)).toEqual(weatherCurrentDetail(unit, { unit: "U-W", part: "areas", id: area.id, revision: area.rev, page: 0 }, { contentRevision: revision }));
      expect(index).toMatchObject({ kind: "ok", part: "index" });
    });
    // U-F の官署名（snapshot は 256 byte で切る）と付加事項の欠片。
    const office = "官".repeat(100);
    const uf = await onePublication("test__fixtures__81_01_01_260129_VPWP50", (xml) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${office}</EditorialOffice>`));
    const subject = itemsOf(uf.snapshot, "U-F")[0];
    expect(fact(subject, "office")).toEqual({ text: "官".repeat(85), cut: true });
    const ufUnit = uf.owner.units["U-F"]!, original = ufUnit.subjects[0];
    const addition = { ...original, unreadable: mark([["Item", undefined, "<Item/>"], ["addition", undefined, "<Addition>注意</Addition>"]]) };
    const ufMarked: OwnerState = { ...uf.owner, units: { ...uf.owner.units, "U-F": { ...ufUnit, subjects: [addition] } } };
    const markedPublic = timeseriesPublicSubject(addition);
    await serve(() => uf.owner, async (get) => {
      const answer = await get(`unit=U-F&part=item&id=${subject.id}&revision=${subject.rev}`);
      expect([answer.status, answer.body.item && fact(answer.body.item as VocabItem, "office")]).toEqual([200, { text: office, cut: false }]);
    });
    await serve(() => ufMarked, async (get) => {
      const answer = await get(`unit=U-F&part=unreadable&id=${markedPublic.id}&revision=${markedPublic.revision}`);
      expect(answer.body).toMatchObject({ kind: "ok", part: "unreadable", sides: [{ side: "land", headline: null,
        parts: [{ site: "Item", scope: null, raw: "<Item/>" }, { site: "addition", scope: null, raw: "<Addition>注意</Addition>" }] }] });
    });
    // 同じ site で scope の違う 2 つの欠片（U-L）と、陸上・海上の印が並ぶ U-V の警報。
    const ul = receive("test__fixtures__15_16_01_241031_VPWW56").step.state, ulUnit = ul.units["U-L"]!;
    const ulMarked: OwnerState = { ...ul, units: { ...ul.units, "U-L": { ...ulUnit, contentRevision: 11,
      currents: ulUnit.currents.map((item) => item.effective === "active" ? { ...item, unreadable: mark([["kindName", "a", "<Kind>a</Kind>"], ["kindName", "b", "<Kind>b</Kind>"]]) } : item) } } };
    const ulEntry = allPages(ulMarked, "U-L").entries[0];
    const uv = receive("test__fixtures__45_01_01_200522_VFVO50").step.state, uvUnit = uv.units["U-V"]!;
    const uvMarked: OwnerState = { ...uv, units: { ...uv.units, "U-V": { ...uvUnit, contentRevision: 12, alerts: uvUnit.alerts.map((item) => item.effective === "active"
      ? { ...item, unreadable: mark([["name", undefined, "<Name/>"]], "<Headline/>"), marineUnreadable: mark([["対象海上予報区", "x", null]]) } : item) } } };
    const uvEntry = allPages(uvMarked, "U-V").entries.find((entry) => entry.item.k === "volcano.alert");
    if (ulEntry == null || uvEntry == null) throw new Error("entries");
    await serve(() => ulMarked, async (get) => {
      const answer = await get(`unit=U-L&part=unreadable&id=${ulEntry.id}&revision=${ulEntry.revision}`);
      expect(answer.body).toMatchObject({ sides: [{ side: "land", parts: [{ site: "kindName", scope: "a", raw: "<Kind>a</Kind>" }, { site: "kindName", scope: "b", raw: "<Kind>b</Kind>" }] }] });
      expect((await get(`unit=U-L&part=unreadable&id=${ulEntry.id}&revision=${"0".repeat(64)}`)).status).toBe(409);
      expect((await get(`unit=U-L&part=unreadable&id=${ulEntry.id}&revision=1`)).status).toBe(400);
    });
    await serve(() => uvMarked, async (get) => {
      const answer = await get(`unit=U-V&part=unreadable&id=${uvEntry.id}&revision=${uvEntry.revision}`);
      expect(answer.body).toMatchObject({ sides: [{ side: "land", headline: "<Headline/>", parts: [{ site: "name", scope: null, raw: "<Name/>" }] },
        { side: "marine", headline: null, parts: [{ site: "対象海上予報区", scope: "x", raw: null }] }] });
    });
  });
});
