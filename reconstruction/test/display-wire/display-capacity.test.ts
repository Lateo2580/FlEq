import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { RuntimeDisplayChange, UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { SnapshotProjectionInput } from "../../contracts/p2-snapshot-sse.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { executionPlaces, placeOfHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import type { DisplayWireInput, DisplayWireResult, DisplayWireState } from "../../src/view-projector/display-wire";
import manifest from "../../tools/corpus/manifest.json";
import { decodeXml as decodeQuake, receive as receiveQuake, vxse53 } from "../seismic-unit/seismic-fixture";
import { clock, decodeXml, observation, receive as receiveTsunami, vtse41 } from "../tsunami-unit/tsunami-fixture";
import { baseInput, eewStep, eewXml, emptyEew, emptyQuake, emptyTsunami, material, projected, quietLosses, wire } from "./display-wire-fixture";

// P4-DISPLAY-CAPACITY-001 の T01・T02・T03・T07（要約の順・容量の境界・待つ・待たないの判定・定数の結び付け）。

const MIB = 1_048_576;
const KEYS = ["weatherCurrent", "weatherTimeseries", "nankai", "volcano", "landslide", "flood", "briefing", "localBulletins", "typhoon"] as const;
type Views = DisplayWireInput["views"];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const summaries = (snapshot: DisplayWireSnapshot) => KEYS.filter((key) => snapshot.current[key].delivery === "summary");
// 全部を full にしたときの全体（要約にした分野は originalBytes に戻して数える）。
const fullTotal = (snapshot: DisplayWireSnapshot) => KEYS.reduce((sum, key) => {
  const domain = snapshot.current[key];
  return domain.delivery === "summary" ? sum - bytes(domain) + domain.originalBytes : sum;
}, bytes(snapshot));
const unprotected = (snapshot: DisplayWireSnapshot) => (["eew", "tsunami", "earthquake"] as const).filter((key) => "delivery" in snapshot.current[key]);

async function baseViews(): Promise<Views> {
  const { input } = await baseInput();
  return { eew: input.eew, tsunami: input.tsunami, earthquake: input.earthquake, weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries,
    nankai: input.nankai, volcano: input.volcano, landslide: input.landslide, flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins,
    typhoon: input.typhoon };
}
async function project(views: Views, changes: readonly RuntimeDisplayChange[], previous: DisplayWireState | null,
  edit: (input: SnapshotProjectionInput) => SnapshotProjectionInput = (input) => input): Promise<DisplayWireResult> {
  const { input } = await baseInput();
  return projectDisplayWire({ projection: edit({ ...input, displayChanges: changes }), views, confirmation: input.confirmation, notices: [], removalLoss: quietLosses }, previous);
}

// 読めない報のカードの区域で分野の包みを重くする（P4-DV-T02 の typhoonCards と同じ組み方）。区域 1 つは 45 byte（区切りの , を含む）、wide の区域は 1 byte 多い。
const AREA = { code: "1000000", name: "地域", value: 0 }, WIDE = { code: "1000000", name: "地域", value: 10 };
const card = (inputId: string, areas: number, wide = 0, operation: Operation = "normal"): UnreadableCardView => ({ kind: "unreadable", inputId, headType: "VPWW54",
  operation, receivedAt: 1, reason: "xmlInvalid", title: null, headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true,
  areas: Array.from({ length: areas }, (_, index) => index < wide ? WIDE : AREA) });
type Cards = Partial<Record<"weatherCurrent" | "weatherTimeseries" | "landslide" | "flood", readonly UnreadableCardView[]>>;
const heavy = (views: Views, cards: Cards): Views => ({ ...views,
  weatherCurrent: cards.weatherCurrent == null ? views.weatherCurrent : { ...views.weatherCurrent, unreadableCards: cards.weatherCurrent },
  weatherTimeseries: cards.weatherTimeseries == null ? views.weatherTimeseries : { ...views.weatherTimeseries, unreadableCards: cards.weatherTimeseries },
  landslide: cards.landslide == null ? views.landslide : { ...views.landslide, unreadableCards: cards.landslide },
  flood: cards.flood == null ? views.flood : { ...views.flood, unreadableCards: cards.flood } });

// 受入条件 P4-DC-AC01（作者裁定 P4-DC-D-SUMMARY-ORDER=B）。
describe("P4-DC-T01 acceptance: the summary order", () => {
  it("summarizes the over-budget nine one at a time in the order U-F → … → U-W, stops once within 1 MiB, and counts the real summary bytes", async () => {
    const views = await baseViews();
    const run = async (cards: Cards) => projected(await project(heavy(views, cards), [], null)).snapshot;
    const check = (snapshot: DisplayWireSnapshot) => {
      expect(fullTotal(snapshot)).toBeGreaterThan(MIB);
      expect(bytes(snapshot)).toBeLessThanOrEqual(MIB);
      expect(unprotected(snapshot)).toEqual([]);
    };
    // (a) U-F・U-W・U-L が 65,536 を越え、U-F 1 つで入る。
    const a = await run({ weatherTimeseries: [card("f", 11_100)], weatherCurrent: [card("w", 6_700)], landslide: [card("l", 6_700)] });
    check(a);
    expect(summaries(a)).toEqual(["weatherTimeseries"]);
    // (b) U-F を要約にしても入らず、U-L まで要る。U-W（7 番目）は full のまま。
    const b = await run({ weatherTimeseries: [card("f", 1_800)], landslide: [card("l", 6_700)], weatherCurrent: [card("w", 16_700)] });
    check(b);
    expect(summaries(b)).toEqual(["weatherTimeseries", "landslide"]);
    expect(bytes(b.current.weatherCurrent)).toBeGreaterThan(65_536);
    // (c) 要約の包みの実の byte で数えると U-F 1 つで入り、上界 3,882 で代用すると 2 つ目が要る組。
    const fitted = { weatherTimeseries: [card("f", 2_200)], landslide: [card("l", 6_700)] };
    const full = await run({ ...fitted, weatherCurrent: [card("w", 10_000)] });
    expect(summaries(full)).toEqual([]);
    const domain = full.current.weatherTimeseries, fBytes = bytes(domain);
    const summaryBytes = bytes({ unit: "U-F", contentRevision: domain.contentRevision, items: domain.items, delivery: "summary", reason: "snapshotBudget",
      originalBytes: fBytes, budgetBytes: 65_536 });
    const added = Math.floor((MIB + fBytes - summaryBytes - 8 - bytes(full)) / 45), total = bytes(full) + 45 * added;
    expect([total > MIB, total - fBytes + summaryBytes <= MIB, total - fBytes + 3_882 > MIB]).toEqual([true, true, true]);
    const c = await run({ ...fitted, weatherCurrent: [card("w", 10_000 + added)] });
    check(c);
    expect(summaries(c)).toEqual(["weatherTimeseries"]);
    expect(bytes(c)).toBe(total - fBytes + summaryBytes);
    // 順の逆: U-W だけが 65,536 を越えるなら U-W が要約になる。
    const w = await run({ weatherCurrent: [card("w", 24_500)] });
    check(w);
    expect(summaries(w)).toEqual(["weatherCurrent"]);
  });
});

// 1 通を空の owner（または渡した owner）に通す（display-vocab.test.ts の receive と同じ）。
const AT_MS = Date.parse("2099-01-01T09:00:00+09:00");
const empty = (place: ExecutionPlace): OwnerState => restoreOwner({ runId: "run", place, clock: { wallTimeMs: AT_MS, monotonicMs: 1 },
  restored: Object.fromEntries(runtimeUnits.filter((unit) => executionPlaces[unit] === place).map((unit) => [unit, { kind: "empty" }])) }, linkedUnitTable, linkedUnitCodecs).state;
const fixtures = new Map(manifest.fixtures.map((item) => [item.fixtureId, item]));
let sequence = 0;
function receive(fixtureId: string, owner: OwnerState | null = null) {
  const fixture = fixtures.get(fixtureId), headType = fixture?.transport.headType;
  if (fixture == null || headType == null) throw new Error(fixtureId);
  const decoded = material(readFileSync(fixture.path, "utf8"), headType);
  const at = Date.parse(decoded.reportDateTimeRaw), place = placeOfHeadType(headType);
  return receiveOwner(owner ?? empty(place), { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } },
    { wallTimeMs: Number.isFinite(at) ? at + 1000 : AT_MS, monotonicMs: ++sequence }, linkedUnitTable);
}
function withSteps(views: Views, steps: readonly ReturnType<typeof receive>[]): Views {
  let next = views;
  for (const step of steps) for (const view of step.views) {
    if (view.unit === "U-L") next = { ...next, landslide: view };
    if (view.unit === "U-B") next = { ...next, briefing: view };
    if (view.unit === "U-R") next = { ...next, flood: view };
    if (view.unit === "U-W") next = { ...next, weatherCurrent: view };
  }
  return next;
}

type Stream = { response: IncomingMessage; frames: string[] };
function open(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/api/display/wire/events", agent: false }, (response) => {
      const stream: Stream = { response, frames: [] };
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) { stream.frames.push(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      });
      response.on("error", () => {});
      resolve(stream);
    });
    request.on("error", reject);
  });
}
const dataOf = (frame: string) => frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
const until = async (check: () => boolean) => { for (let index = 0; index < 400 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// 契約境界 P4-DC-AC02（D-AC19・D-AC20・D-AC22、O11:9）。
describe("P4-DC-T02 contractBoundary: the 1 MiB boundary, a cancel while summarized and full → summary → full", () => {
  it("keeps every snapshot within 1 MiB at −1・=・+1, loses nothing of the in-budget domains and the common part, and never cuts the SSE", async () => {
    // U-L は通常と訓練を別の subject にした 60 件ずつ（O11:9）、U-R は区域の数で全体の byte を 1 byte 単位に合わせるカード、U-B の 1 件は取消に使う。
    const landslide = receive("test__fixtures__15_16_01_241031_VPWW56"), briefing = receive("test__fixtures__82_01_01_260324_VPBS50");
    const template = landslide.views.find((view) => view.unit === "U-L");
    if (template?.unit !== "U-L") throw new Error("U-L");
    const currents = Array.from({ length: 120 }, (_, index) => {
      const operation: Operation = index % 2 === 0 ? "normal" : "training", base = template.currents[0];
      return { ...base, operation, subject: `${base.subject.replace(/^normal\//, `${operation}/`)}/${index}`, title: "題".repeat(1000) };
    });
    const adds: RuntimeDisplayChange[] = [...currents.map((current): RuntimeDisplayChange => ({ unit: "U-L", operation: current.operation, subject: current.subject, before: null,
      after: { unit: "U-L", operation: current.operation, subject: current.subject, office: null, current, subjects: [] } })), ...briefing.displayChanges];
    const base = { ...withSteps(await baseViews(), [briefing]), landslide: { ...template, subjects: [], currents } };
    const sized = (areas: number, wide: number) => heavy(base, { flood: [card("r", areas, wide)] });
    const probe = projected(await project(sized(2_000, 0), adds, null)).snapshot;
    expect(summaries(probe)).toEqual([]);
    const at = (target: number) => { const delta = target - bytes(probe), added = Math.floor(delta / 45); return sized(2_000 + added, delta - 45 * added); };
    expect(bytes(probe)).toBeLessThan(MIB - 50_000);
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } });
    try {
      const watcher = await open(server.port);
      let previous: DisplayWireState | null = null;
      const publish = async (views: Views, changes: readonly RuntimeDisplayChange[] = []) => {
        const result = projected(await project(views, changes, previous));
        previous = result.state;
        server.publishWire(result.snapshot, true);
        await until(() => watcher.frames.some((frame) => frame.startsWith(`event: snapshot\nid: ${result.snapshot.sequence}\n`)));
        expect(bytes(result.snapshot)).toBeLessThanOrEqual(MIB);
        return result.snapshot;
      };
      const exact = await publish(at(MIB), adds);
      expect([bytes(exact), summaries(exact)]).toEqual([MIB, []]);
      const over = await publish(at(MIB + 1));
      // U-L（5 番目）と U-R（6 番目）が 65,536 を越え、U-L 1 つで入る。
      expect([fullTotal(over), summaries(over), bytes(over.current.flood) > 65_536]).toEqual([MIB + 1, ["landslide"], true]);
      // 要約の間につないだ新しい客は、1 通で同じ要約の状態を読む（D-AC22）。
      const joined = await open(server.port);
      await until(() => joined.frames.length > 0);
      expect([joined.frames.length, dataOf(joined.frames[0])]).toEqual([1, JSON.stringify(over)]);
      const common = (snapshot: DisplayWireSnapshot) => ({ connection: snapshot.connection, worker: snapshot.worker, persistence: snapshot.persistence,
        recovery: snapshot.recovery, channels: snapshot.channels, notices: snapshot.notices, eew: snapshot.current.eew, tsunami: snapshot.current.tsunami,
        earthquake: snapshot.current.earthquake });
      // 予算内の分野と共通部の欠け 0（U-R の区域は全部ある、ほかの分野は = の時と同じ）。
      expect(common(over)).toEqual(common(exact));
      for (const key of KEYS) if (key !== "landslide" && key !== "flood") expect(over.current[key]).toEqual(exact.current[key]);
      expect(over.current.flood.delivery === "full" ? over.current.flood.cards[0].areas : null).toEqual(at(MIB + 1).flood.unreadableCards?.[0].areas);
      const summarized = over.current.landslide;
      expect(summarized.delivery === "summary" ? [summarized.originalBytes > 65_536, summarized.items] : null).toEqual([true, exact.current.landslide.items]);
      const under = await publish(at(MIB - 1));
      expect([bytes(under), summaries(under)]).toEqual([MIB - 1, []]);
      // 要約のまま別の分野（U-B）を取消す。次の snapshot に取消が出て、要約の分野の最小事実と共通部は残る（D-AC20）。
      const kept = await publish(at(MIB + 20_000));
      expect(summaries(kept)).toEqual(["landslide"]);
      const cancel = briefing.displayChanges.map((change): RuntimeDisplayChange => ({ unit: change.unit, operation: change.operation, subject: change.subject,
        before: change.after, after: null, removal: "cancelled" }));
      const cancelled = await publish(at(MIB + 20_000), cancel);
      expect(summaries(cancelled)).toEqual(["landslide"]);
      expect(cancelled.current.briefing.delivery === "full" ? cancelled.current.briefing.wire.items : null).toEqual([]);
      expect(cancelled.removals["U-B"]?.items.map((item) => item.reason)).toEqual(cancel.map(() => "cancelled"));
      expect([cancelled.current.landslide.items, common(cancelled)]).toEqual([kept.current.landslide.items, common(kept)]);
      // full → 要約 → full の後に、新しい客は 1 通で同じ状態を読む（D-AC22）。容量だけを理由に切らない。
      const back = await publish(at(MIB - 1));
      expect(summaries(back)).toEqual([]);
      const late = await open(server.port);
      await until(() => late.frames.length > 0);
      expect([late.frames.length, dataOf(late.frames[0])]).toEqual([1, JSON.stringify(back)]);
      expect([watcher.response.destroyed, joined.response.destroyed, server.wireClientCount()]).toEqual([false, false, 3]);
      for (const stream of [watcher, joined, late]) stream.response.destroy();
    } finally {
      await server.close();
    }
  }, 60_000);
});

// 受入条件 P4-DC-AC03（表 §4.2）。
describe("P4-DC-T03 acceptance: urgent or held per source", () => {
  it("marks EEW, earthquake, tsunami issue/upgrade/expand/release/downgrade/cancel, cancelled/ended removals and lost U-W areas urgent, and holds the rest", async () => {
    const AT = "2099-01-01T09:00:00+09:00", later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString().replace("Z", "+00:00");
    // 公開しない step（unchanged）は待つ・待たないを持たないので、表に unchanged と出す。
    const urgent = (result: DisplayWireResult) => result.kind === "projected" ? result.urgent : "unchanged";
    const rows: [string, boolean | "unchanged"][] = [];
    const eew = eewStep(emptyEew(), eewXml({ eventId: "20990101000001", at: AT, areas: [["100", "4", "4"]] }));
    rows.push(["U-E", urgent(await wire({ eew: eew.state }, eew.displayChanges, (await wire({}, [], null)).state))]);
    const quake = receiveQuake(emptyQuake(), decodeQuake(vxse53({ at: AT, maxInt: "3" }), "VXSE53"), clock(Date.parse(AT) + 1000));
    rows.push(["U-Q", urgent(await wire({ quake: quake.state }, quake.displayChanges, (await wire({}, [], null)).state))]);
    // 津波の予報は同じ EventID の続報の列（区分は 62 注意報・51 警報・60 解除）、観測は VTSE51、取消は別の EventID。
    let tsunami = emptyTsunami(), state = (await wire({}, [], null)).state;
    const tsunamiStep = async (name: string, xml: string, headType: "VTSE41" | "VTSE51", minutes: number) => {
      const step = receiveTsunami(tsunami, decodeXml(xml, headType), clock(Date.parse(later(minutes)) + 1000));
      tsunami = step.state;
      const result = await wire({ tsunami }, step.displayChanges, state);
      state = result.state;
      rows.push([name, urgent(result)]);
    };
    const forecast = (name: string, minutes: number, areas: Parameters<typeof vtse41>[0]["areas"], eventId = "20990101000011", infoType?: "取消") =>
      tsunamiStep(name, vtse41({ eventId, at: later(minutes), areas, infoType }), "VTSE41", minutes);
    await forecast("U-T issued", 0, [{ code: "100", name: "区", kind: "62" }]);
    await tsunamiStep("U-T observation", observation({ at: later(1), serial: 1, stations: [{ code: "21001", height: "0.3" }] }), "VTSE51", 1);
    await forecast("U-T upgraded", 2, [{ code: "100", name: "区", kind: "51" }]);
    await forecast("U-T expanded", 3, [{ code: "100", name: "区", kind: "51" }, { code: "101", name: "区", kind: "51" }]);
    await forecast("U-T same classes", 4, [{ code: "100", name: "区の続報", kind: "51" }, { code: "101", name: "区", kind: "51" }]);
    await forecast("U-T downgraded", 5, [{ code: "100", name: "区", kind: "62" }, { code: "101", name: "区", kind: "62" }]);
    await forecast("U-T released", 6, [{ code: "100", name: "区", kind: "60" }, { code: "101", name: "区", kind: "60" }]);
    await forecast("U-T second issued", 7, [{ code: "102", name: "区", kind: "62" }], "20990101000012");
    await forecast("U-T cancelled", 8, [], "20990101000012", "取消");
    // 9 分野の差分: 洪水の記録と U-W の府県の行を入れた後の 1 step（state は step ごとに組み直す。射影の state は使い回さない）。
    const flood = receive("test__fixtures__16_01_01_220728_VXKO50"), weather = receive("test__fixtures__15_16_02_251222_VPWW57");
    const floodAdd = flood.displayChanges.find((change) => change.unit === "U-R" && change.after != null);
    const row = weather.displayChanges.find((change) => change.after?.unit === "U-W" && change.after.current != null && change.after.current.areas.length >= 2);
    if (floodAdd?.after == null || row?.after?.unit !== "U-W" || row.after.current == null) throw new Error("inputs");
    const rowAfter = row.after, rowCurrent = row.after.current;
    const views = withSteps(await baseViews(), [flood, weather]);
    const next = async (changes: readonly RuntimeDisplayChange[], edit?: (input: SnapshotProjectionInput) => SnapshotProjectionInput) =>
      urgent(await project(views, changes, (await project(views, [...flood.displayChanges, ...weather.displayChanges], null)).state, edit));
    const removed = (removal: "cancelled" | "ended" | "expired" | "evicted"): RuntimeDisplayChange =>
      ({ unit: "U-R", operation: floodAdd.operation, subject: floodAdd.subject, before: floodAdd.after, after: null, removal });
    for (const removal of ["cancelled", "ended", "expired", "evicted"] as const) rows.push([`U-R ${removal}`, await next([removed(removal)])]);
    const rowChange = (current: typeof rowCurrent): RuntimeDisplayChange => ({ unit: "U-W", operation: row.operation, subject: row.subject, before: rowAfter,
      after: { ...rowAfter, current } });
    const [system, code] = rowCurrent.areas[rowCurrent.areas.length - 1];
    const kinds = Object.keys(rowCurrent.codes);
    const fewerKinds = rowChange({ ...rowCurrent, codes: Object.fromEntries(Object.entries(rowCurrent.codes).slice(1)), names: Object.fromEntries(Object.entries(rowCurrent.names).filter(([kind]) => kind !== kinds[0])) });
    rows.push(["U-W replaced", await next([rowChange({ ...rowCurrent, areas: [...rowCurrent.areas.slice(0, -1), [system, `${code}9`]] })])]);
    rows.push(["U-W fewer kinds", await next([fewerKinds])]);
    rows.push(["U-W more areas", await next([rowChange({ ...rowCurrent, areas: [...rowCurrent.areas, [system, "9999999"]] })])]);
    rows.push(["held update with a cancel", await next([fewerKinds, removed("cancelled")])]);
    rows.push(["connection only", await next([], (input) => ({ ...input, connection: { ...input.connection, lastInputAt: 1 } }))]);
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    expect(rows).toEqual([["U-E", true], ["U-Q", true], ["U-T issued", true], ["U-T observation", false], ["U-T upgraded", true], ["U-T expanded", true],
      ["U-T same classes", false], ["U-T downgraded", true], ["U-T released", true], ["U-T second issued", true], ["U-T cancelled", true], ["U-R cancelled", true], ["U-R ended", true],
      ["U-R expired", false], ["U-R evicted", false], ["U-W replaced", true], ["U-W fewer kinds", false], ["U-W more areas", false],
      ["held update with a cancel", true], ["connection only", false]]);
  });
});

// 契約境界 P4-DC-AC07（統合担当の決め 5）。
describe("P4-DC-T07 contractBoundary: the fixed bound and the script", () => {
  it("exports NEW_PATH_FIXED_BOUND from the display-wire dist equal to the script's newPath.sum", () => {
    const script: unknown = JSON.parse(execFileSync(process.execPath, ["reconstruction/contracts/p4-display-wire-max.mjs"], { encoding: "utf8" }));
    const sum = typeof script === "object" && script != null && "newPath" in script && typeof script.newPath === "object" && script.newPath != null && "sum" in script.newPath
      ? script.newPath.sum : null;
    const dist: unknown = createRequire(resolve("package.json"))(resolve("reconstruction/dist/src/view-projector/display-wire.js"));
    const bound = typeof dist === "object" && dist != null && "NEW_PATH_FIXED_BOUND" in dist ? dist.NEW_PATH_FIXED_BOUND : undefined;
    expect(typeof sum).toBe("number");
    expect(bound).toBe(sum);
  });
});
