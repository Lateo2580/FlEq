import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesDetailRequest } from "../../contracts/p2-weather-timeseries-unit.types";
import type { WeatherCurrentDetailRequest, WeatherCurrentDetailResponse } from "../../contracts/p3-uw-canon.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { decode, expectConsistent, projected, projectionInput, received, reference, startup, step } from "../snapshot-sse/projection-fixture";
import type { Step } from "../snapshot-sse/projection-fixture";

// P3-UW-CANON-001 の publisher の側（要約の件数・view の byte・notice・詳細の口の待ちと HTTP）。
const NOW = 1_800_000_000_000;
const KYOTO = "15_16_02_251222_VPWW57";
const cancelled = (time: string) => (xml: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`)
  .replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>").replace(/<Body[\s\S]*<\/Body>/, "<Body/>");
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function material(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: NOW, origin: "replay", kind: "replay",
    body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))), headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const unitReceive = (state: WeatherCurrentUnitState, value: DecodedMaterial) =>
  reduceWeatherCurrentUnit(state, { kind: "receive", material: value, clock: { wallTimeMs: NOW, monotonicMs: 0 } }).state;
// 試験が組んだ U-W の state を、startup の runtime の写しに差し込む（A8 は mirror の view と表示の行だけを読む）。
async function withWeather(unit: WeatherCurrentUnitState): Promise<Step> {
  const started = await startup({ wallTimeMs: NOW, monotonicMs: 1 });
  return { ...started, state: { ...started.state, units: { ...started.state.units, "U-W": unit }, views: { ...started.state.views, "U-W": toWeatherCurrentView(unit) } } };
}

describe("P3-UWC-T10 / T11 contractBoundary (AC05): the summary counts active prefectures and the view bytes add up", () => {
  it("counts only the prefecture with an active area, and the measured view equals its JSON", async () => {
    // 府県 32（松江）は復元して未確認だけ、府県 18（福井）は解除・なしだけ、府県 26（京都）は active。
    const saved = unitReceive(initialUnits["U-W"], material("15_17_01_251222_VPWW55", "VPWW55"));
    let unit = reduceWeatherCurrentUnit(initialUnits["U-W"], { kind: "restore", persisted: weatherCurrentUnitCodec.encode(saved),
      clock: { wallTimeMs: NOW, monotonicMs: 0 } }).state;
    unit = unitReceive(unit, material("18_00_01_260830_VPWW55_fukui_release", "VPWW55"));
    unit = unitReceive(unit, material(KYOTO, "VPWW57"));
    // 監視の行も混ぜる: 京都の読めない新しい版（疑義の freshness）と、福井 L5 の履歴の無い取消（lastKnown つきの unavailable）。
    unit = unitReceive(unit, material(KYOTO, "VPWW57", (xml) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2020-06-22T23:01:00+09:00</ReportDateTime>")
      .replace(/(<Body[\s\S]*?<Status>)[^<]*(<\/Status>)/, "$1未知$2"), "kyoto-invalid"));
    unit = unitReceive(unit, material("15_16_04_251222_VPWW58", "VPWW58"));
    unit = unitReceive(unit, material("15_16_04_251222_VPWW58", "VPWW58", cancelled("2025-12-22T23:59:00+09:00"), "wakkanai-cancel"));
    expect([unit.freshness.some((item) => item.freshnessSuspect), unit.unavailable.map((item) => [item.reason, item.lastKnown != null])])
      .toEqual([true, [["historyUnavailable", true]]]);
    const view = toWeatherCurrentView(unit);
    expect(view.areas.map((item) => [item.prefecture, item.areas.length > 0]).sort()).toEqual([["18", false], ["26", true], ["32", false]]);
    const state = reference(await withWeather(unit), NOW);
    expect(state.domains.weatherCurrent.full.items[0]).toMatchObject({ operation: "normal", activeCount: 1 });
    expectConsistent(state);
  });
});

describe("P3-UWC-T12 acceptance (AC05 (5)): the U-W notice through reduce", () => {
  async function scene(file: string, headType: string, cancelAt: string) {
    const at = Date.parse("2026-11-01T00:00:00+09:00");
    const clock = { wallTimeMs: at, monotonicMs: 1 };
    const started = await startup(clock);
    const first = projected(projectSnapshot(projectionInput(started, at), null));
    const adopted = await step(started.state, received("run", decode(file, headType), clock));
    const second = projected(projectSnapshot(projectionInput(adopted, at), first.state));
    const lost = await step(adopted.state, received("run", decode(file, headType, cancelled(cancelAt), `${file}-cancel`), clock));
    return { adopted, lost, notices: projected(projectSnapshot(projectionInput(lost, at), second.state)).snapshot.notices };
  }
  it("an active report subject that turns unavailable gets one notice; a release-only one gets none; the scopes keep the report subject", async () => {
    const { adopted, lost, notices } = await scene(KYOTO, "VPWW57", "2020-06-22T23:10:00+09:00");
    expect(lost.state.units["U-W"].unavailable).toMatchObject([{ reason: "historyUnavailable" }]);
    expect(notices.map((item) => [item.unit, item.kind, item.text, item.targetId]))
      .toEqual([["U-W", "unavailable", "気象警報の現況を確認できません", sha256(["U-W", "normal", "normal/VPWW57/京都地方気象台"])]]);
    // 確認の scope は報の subject と、その報の区域の token（P3-UWC-AC05 (2)）。
    const tokens = Object.keys(adopted.state.units["U-W"].partials[0].phenomena).sort();
    const scopes = adopted.state.confirmation.units["U-W"].normal.scopes.flatMap(({ scope }) => scope.kind === "area" ? [[scope.subject, scope.token]] : []);
    expect(scopes.map(([subject]) => subject).every((subject) => subject === "normal/VPWW57/京都地方気象台")).toBe(true);
    expect(scopes.map(([, token]) => token).sort()).toEqual(tokens);
    const release = await scene("18_00_01_260830_VPWW55_fukui_release", "VPWW55", "2026-08-30T21:00:00+09:00");
    expect(release.lost.state.units["U-W"].unavailable).toMatchObject([{ reason: "historyUnavailable" }]);
    expect(release.notices).toEqual([]);
  });
});

// P3-UWC-AC07: 詳細の口の publisher の側。execution-split の試験経路（同一 process の owner）で確かめる。
const directories: string[] = [];
const harnesses: Harness[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
  await Promise.allSettled(harnesses.splice(0).map((h) => h.root.diagnostics.flush()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const body = (name: string, edit: (xml: string) => string = (xml) => xml) => Buffer.from(edit(readFileSync(`test/fixtures/${name}.xml`, "utf8")));
const UNAVAILABLE = { kind: "error", reason: "unavailable", revision: null } as const;
async function boot() {
  const path = mkdtempSync(join(tmpdir(), "fleq-uwc-"));
  directories.push(path);
  const at = { wallTimeMs: 1_780_650_000_000, monotonicMs: 1 };
  const published: DisplaySnapshot[] = [];
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "old"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs,
  { clock: () => at, notificationAdapter: manualAdapter().adapter, display: { publish: (snapshot) => { published.push(snapshot); } } });
  harnesses.push(h);
  await startHarness(h, "uwc", at);
  let sequence = 0;
  const input = (headType: string, name: string, xml: Buffer) => envelope("uwc", headType, `${name}-${++sequence}`, xml, at, sequence);
  await submit(h, input("VPWP50", "f", body("81_02_01_260605_VPWP50_high_severity")));
  await submit(h, input("VPWW57", "w", body(KYOTO)));
  const snapshot = published.at(-1)!;
  const uf: WeatherTimeseriesDetailRequest = { part: "index", revision: snapshot.current.weatherTimeseries.contentRevision, page: 0 };
  const uw: WeatherCurrentDetailRequest = { unit: "U-W", part: "index", revision: snapshot.current.weatherCurrent.contentRevision, page: 0 };
  const sentTo = (place: string) => h.sent.filter((item) => item.place === place && item.request.kind === "detail").length;
  const ask = (detail: WeatherTimeseriesDetailRequest | WeatherCurrentDetailRequest) => h.root.requestDetail({ streamId: snapshot.streamId, detail });
  return { h, input, uf, uw, ask, sentTo, streamId: snapshot.streamId };
}

describe("P3-UWC-T07 contractBoundary (AC07 (1)): U-F and U-W share one line", () => {
  it("answers the 9th of both together busy, sends U-W to weatherCurrent and U-F to deferred", async () => {
    const t = await boot();
    const unhold = t.h.holdRequests((_place, request) => request.kind === "detail");
    const asked = [t.uw, t.uf, t.uw, t.uf, t.uw, t.uf, t.uw, t.uf].map((detail) => t.ask(detail));
    expect(await t.ask(t.uw).response).toEqual({ kind: "error", reason: "busy", revision: null });
    await t.h.settle();
    expect([t.sentTo("weatherCurrent"), t.sentTo("deferred")]).toEqual([1, 0]);
    unhold();
    t.h.releaseRequests("weatherCurrent");
    await t.h.settle();
    expect([t.sentTo("weatherCurrent"), t.sentTo("deferred")]).toEqual([4, 4]);
    expect(await asked[0].response).toMatchObject({ kind: "ok", part: "index" });
    expect(await asked[1].response).toMatchObject({ kind: "ok", part: "index" });
    for (const item of asked) item.done();
  });
  it("sends nothing to weatherCurrent while it owes an input reply", async () => {
    const t = await boot();
    const release = t.h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "inputDone");
    await submit(t.h, t.input("VPWW57", "w2", body(KYOTO, (xml) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2020-06-22T23:05:00+09:00</ReportDateTime>"))));
    const waiting = t.ask(t.uw);
    await t.h.settle();
    expect(t.sentTo("weatherCurrent")).toBe(0);
    release();
    t.h.release();
    await t.h.settle();
    expect(t.sentTo("weatherCurrent")).toBe(1);
    // 入力で U-W の内容版が進んだので、送った時点の索引の版は古い。
    expect(await waiting.response).toMatchObject({ kind: "error", reason: "versionChanged" });
    waiting.done();
  });
});

describe("P3-UWC-T13 contractBoundary (AC07 (2)): an owner stop ends only the requests bound for its place", () => {
  it("weatherCurrent stops with a U-W detail in it: that one is unavailable, the waiting U-F one goes to deferred, the late reply is dropped", async () => {
    const t = await boot();
    const unhold = t.h.holdRequests((place, request) => place === "weatherCurrent" && request.kind === "detail");
    const inOwner = t.ask(t.uw), waiting = t.ask(t.uf);
    await t.h.settle();
    expect([t.sentTo("weatherCurrent"), t.sentTo("deferred")]).toEqual([1, 0]);
    t.h.root.ownerFailed("weatherCurrent", new Error("stopped"));
    expect(await inOwner.response).toEqual(UNAVAILABLE);
    await t.h.settle();
    expect(await waiting.response).toMatchObject({ kind: "ok", part: "index" });
    expect(t.sentTo("deferred")).toBe(1);
    expect(await t.ask(t.uw).response).toEqual(UNAVAILABLE);
    unhold();
    t.h.releaseRequests("weatherCurrent");
    await t.h.settle();
    expect(t.h.failures).toEqual([]);
    for (const item of [inOwner, waiting]) item.done();
  });
  it("deferred stops with a U-F detail in it: the waiting U-W one still goes to weatherCurrent", async () => {
    const t = await boot();
    const unhold = t.h.holdRequests((place, request) => place === "deferred" && request.kind === "detail");
    const inOwner = t.ask(t.uf), waiting = t.ask(t.uw);
    await t.h.settle();
    t.h.root.ownerFailed("deferred", new Error("stopped"));
    expect(await inOwner.response).toEqual(UNAVAILABLE);
    await t.h.settle();
    expect(await waiting.response).toMatchObject({ kind: "ok", part: "index" });
    expect(t.sentTo("weatherCurrent")).toBe(1);
    unhold();
    for (const item of [inOwner, waiting]) item.done();
  });
});

function fetchText(port: number, path: string): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text, headers: response.headers }));
    }).on("error", reject);
  });
}

describe("P3-UWC-T14 contractBoundary (AC07 (4)): the U-W detail path over HTTP", () => {
  const PATH = "/api/display/domains/U-W/detail", STREAM = "00000000-0000-4000-8000-000000000000", ID = "a".repeat(64);
  const areas = `${PATH}?streamId=${STREAM}&part=areas&id=${ID}&revision=3&page=0`;
  it("maps the answers to 200 / 409 / 429 / 503 / 504, refuses bad requests with a 400 of at most 256 bytes, and keeps the 1,024-byte limit", async () => {
    const ok: WeatherCurrentDetailResponse = { kind: "ok", part: "areas", id: ID, revision: "3", page: 0, pageCount: 1, rowCount: 0, rows: [], omitted: [] };
    for (const [answer, status] of [[ok, 200], [{ kind: "error", reason: "versionChanged", revision: "4" }, 409], [{ kind: "error", reason: "busy", revision: null }, 429],
      [UNAVAILABLE, 503], [{ kind: "error", reason: "timeout", revision: null }, 504]] as const) {
      const seen: unknown[] = [];
      const done = vi.fn();
      const started = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
        detail: (request) => { seen.push(request); return { response: Promise.resolve(answer), done }; } });
      closers.push(() => started.close());
      const result = await fetchText(started.port, areas);
      expect([result.status, result.headers["cache-control"], JSON.parse(result.body)]).toEqual([status, "no-store", { streamId: STREAM, ...answer }]);
      expect(seen).toEqual([{ streamId: STREAM, detail: { unit: "U-W", part: "areas", id: ID, revision: "3", page: 0 } }]);
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
      if (status !== 200) continue;
      for (const path of [`${areas}&pad=${"9".repeat(1_100)}`, areas.replace("part=areas", "part=current"), areas.replace(ID, "A".repeat(64)),
        `${PATH}?streamId=${STREAM}&part=index&id=${ID}&revision=3&page=0`, areas.replace("page=0", "page=-1")]) {
        const refused = await fetchText(started.port, path);
        expect([refused.status, JSON.parse(refused.body)]).toEqual([400, { kind: "error", reason: "invalidRequest", revision: null }]);
        expect(Buffer.byteLength(refused.body)).toBeLessThanOrEqual(256);
      }
      expect(seen).toHaveLength(1);
      const index = await fetchText(started.port, `${PATH}?streamId=${STREAM}&part=index&revision=12&page=1`);
      expect([index.status, seen.at(-1)]).toEqual([200, { streamId: STREAM, detail: { unit: "U-W", part: "index", revision: "12", page: 1 } }]);
    }
  });
});
