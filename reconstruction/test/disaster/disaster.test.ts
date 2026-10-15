import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ClockReading, JsonValue, RuntimeUnitDeadline } from "../../contracts/p2-shared-runtime.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { linkedUnitTable } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { shiftTimestamps } from "../eew-e01/frames.mjs";
import { envelope, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { runStage1 } from "./runner";
import { readScenario } from "./scenario";
import type { Expectation, Scenario } from "./scenario";
import { synthesize } from "./synth";
import type { Frame } from "./synth";

// P3-DISASTER-CAPACITY-001 の T01〜T10。repo の公開 fixture だけで回る（外部の採取物と大きい筋書きは FLEQ_DISASTER の口だけ）。

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const temporary: string[] = [];
afterAll(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "fleq-disaster-"));
  temporary.push(path);
  return path;
}

// 公開 fixture の報を at に置いた形（全時刻を同じだけ動かし、運用を通常にする）。
function variant(name: string, at: number, fields: Readonly<{ eventId?: string; office?: string; serial?: string }> = {}): string {
  let xml = readFileSync(`test/fixtures/${name}.xml`, "utf8");
  xml = shiftTimestamps(xml, at - Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(xml)![1])).replace(/<Status>[^<]*<\/Status>/, "<Status>通常</Status>");
  if (fields.eventId != null) xml = xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${fields.eventId}</EventID>`);
  if (fields.office != null) xml = xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${fields.office}</EditorialOffice>`);
  if (fields.serial != null) xml = xml.replace(/<Serial>[^<]*<\/Serial>/, `<Serial>${fields.serial}</Serial>`);
  return xml;
}
// VTSE41 の Body の全区域を解除（Kind 50）にした報。
const releasedOf = (xml: string) => xml.slice(0, xml.indexOf("<Body")) + xml.slice(xml.indexOf("<Body"))
  .replace(/<Kind><Name>[^<]*<\/Name><Code>\d+<\/Code><\/Kind>/g, "<Kind><Name>津波注意報解除</Name><Code>50</Code></Kind>");
const frame = (atMs: number, headType: string, xml: string | Uint8Array): Frame =>
  ({ atMs, headType, body: typeof xml === "string" ? Buffer.from(xml) : xml, origin: "synthetic", source: "test" });
function ready(id: string, frames: readonly Frame[], endMs: number, expectations: readonly Expectation[] = [], checkpoints: readonly number[] = []): Scenario {
  return { kind: "ready", id, frames, digest: sha256(id), startMs: frames[0].atMs, endMs, checkpoints: checkpoints.map((atMs) => ({ atMs, label: "test" })),
    expectations, synth: null, t0: null };
}
const listOf = (result: Readonly<Record<string, JsonValue>>, key: string): readonly JsonValue[] => {
  const value = result[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not a list`);
  return value;
};
const isRecord = (value: JsonValue | undefined): value is Readonly<{ [key: string]: JsonValue }> =>
  typeof value === "object" && value != null && !Array.isArray(value);
const recordOf = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> => {
  if (!isRecord(value)) throw new Error("not a record");
  return value;
};
const limit = (result: Readonly<Record<string, JsonValue>>, id: string) => listOf(result, "limits").map(recordOf).find((item) => item["id"] === id);
// 結果の file の本体（run の所要と自己 hash を除く）の sha256。
const bodyHash = (text: string) => {
  const { timing: _timing, selfSha256: _self, ...body } = recordOf(JSON.parse(text));
  return sha256(JSON.stringify(body));
};

describe("P3-DISASTER-CAPACITY-001 stage 1", () => {
  it("P3-DC-T01 contractBoundary / AC05: the 513th U-Q event evicts the oldest normal one; the loss is kept past its own deadline", async () => {
    const base = Date.parse("2026-07-01T00:00:00+09:00");
    const frames = Array.from({ length: 513 }, (_, index) =>
      frame(base + index * 2_000, "VXSE52", variant("32-35_01_02_240613_VXSE52", base + index * 2_000, { eventId: String(20260701000000 + index) })));
    const { result } = await runStage1(ready("T01", frames, base + 26 * HOUR));
    expect(result["status"]).toBe("Fail");
    expect(listOf(result, "losses")).toEqual([{ subject: "normal/VXSE52/20260701000000", unit: "U-Q", operation: "normal",
      atMs: base + 512 * 2_000, inputId: "input-513", reason: "seismicCapacityEvicted", deadlineMs: base + DAY, counted: true }]);
    expect(recordOf(recordOf(result["evictions"])["total"])["U-Q"]).toBe(1);
  }, 180_000);

  it("P3-DC-T02 acceptance / AC01・AC03・AC04: the small R2 runs 30 h, expires observations on the grid and seals the same body twice", async () => {
    const scenario = readScenario({ id: "R2S", dataDir: null, expectedDigest: null });
    const dir = scratch();
    const first = await runStage1(scenario, { out: join(dir, "first.json") });
    const second = await runStage1(scenario, { out: join(dir, "second.json") });
    const { result } = first;
    for (const id of ["U-T.forecasts", "U-T.observations:VTSE51", "U-T.stations:VTSE51", "U-T.stations:VTSE52", "U-T.bytes"])
      expect(limit(result, id), id).toMatchObject({ max: expect.any(Number), atMs: expect.any(Number) });
    expect(listOf(result, "expectations").map(recordOf).every((item) => item["ok"] === true)).toBe(true);
    expect(recordOf(result["pass"])).toMatchObject({ inputRejections: 0, capacityLosses: 0 });
    // 公開サンプルは筋書きの入力なので不正は blocked、Observation の無い 32-39_11_03 は明示した unchanged（実電文の不正の数は空）。
    expect(result["realInvalid"]).toEqual({});
    expect(result["status"]).toBe("Pass");
    expect(readFileSync(join(dir, "first.json"), "utf8")).toBe(first.text);
    expect(bodyHash(first.text)).toBe(bodyHash(second.text));
    console.info(`[P3-DC-T02] runMs=${recordOf(result["timing"])["runMs"]} bytes=${first.text.length}\n${first.text}`);
  }, 120_000);

  it("P3-DC-T03 contractBoundary / AC02: the N1 main VXSE53 carries the upper bounds, keeps OriginTime and the hold; seeds decide the bytes", async () => {
    const t0 = Date.parse("2026-06-26T00:00:00+09:00");
    const frames = synthesize("N1", 1, { t0Ms: t0 });
    const eventId = /<EventID>([^<]*)<\/EventID>/.exec(Buffer.from(frames.find((item) => item.headType === "VXSE51")!.body).toString("utf8"))![1];
    const own = (item: Frame) => Buffer.from(item.body).toString("utf8").includes(`<EventID>${eventId}</EventID>`);
    const main = frames.filter((item) => item.headType === "VXSE53" && own(item));
    expect(main).toHaveLength(3);
    const text = (item: Frame) => Buffer.from(item.body).toString("utf8");
    const last = text(main[2]), body = last.slice(last.indexOf("<Body"));
    const count = (tag: string) => body.split(`<${tag}>`).length - 1;
    expect([count("IntensityStation"), count("City"), count("Area") - 1, count("Pref")]).toEqual([4_361, 1_894, 188, 47]);
    expect(new Set(main.map((item) => /<OriginTime>([^<]*)<\/OriginTime>/.exec(text(item))![1])).size).toBe(1);
    const tsunami = frames.find((item) => item.headType === "VTSE41" && own(item))!;
    // VXSE51 は TargetDateTime を発生時刻に使う。51 だけを採用した直後と、53 の各報の後とで強震保持の期限が同じ（53 の第 1 報は 2 秒遅らせて受ける）。
    const quick = frames.find((item) => item.headType === "VXSE51" && own(item))!;
    expect(/<TargetDateTime>([^<]*)<\/TargetDateTime>/.exec(text(quick))![1]).toBe(/<OriginTime>([^<]*)<\/OriginTime>/.exec(text(main[0]))![1]);
    const received = [{ ...main[0], atMs: main[0].atMs + 2_000 }, main[1], main[2]];
    const holds: number[] = [];
    const hold = (atMs: number): Expectation => ({ atMs, label: "hold", check: (h: Harness) => {
      holds.push(h.unit("U-Q").earthquakes.find((item) => item.eventId === eventId)?.strongHold?.until ?? -1);
      return true;
    } });
    const { result } = await runStage1(ready("T03", [quick, ...received, tsunami].sort((a, b) => a.atMs - b.atMs), t0 + HOUR, [
      hold(quick.atMs + 1_000), ...received.map((item) => hold(item.atMs + 1_000)),
      { atMs: t0 + HOUR, label: "VTSE41 の 66 区域", check: (h) => h.unit("U-T").forecasts.find((item) => item.eventId === eventId)?.areas.length === 66 },
    ]));
    expect(holds).toEqual([t0 + 12 * HOUR, t0 + 12 * HOUR, t0 + 12 * HOUR, t0 + 12 * HOUR]);
    expect(listOf(result, "expectations").map(recordOf).every((item) => item["ok"] === true)).toBe(true);
    const digest = (seed: number) => sha256(Buffer.concat(synthesize("N1", seed, { t0Ms: t0 }).map((item) => Buffer.from(item.body))));
    const same = digest(1);
    expect(same).toBe(sha256(Buffer.concat(frames.map((item) => Buffer.from(item.body)))));
    expect(digest(2)).not.toBe(same);
    console.info(`[P3-DC-T03] VXSE53 bytes=${main[2].body.byteLength} U-Q.bytes max=${limit(result, "U-Q.bytes")?.["max"]}`);
  }, 180_000);

  it("P3-DC-T04 / T08(b)(c) contractBoundary / AC04・AC05: input rejections and the unresolved state are two counts; capacity rejections fail the run", async () => {
    // (b): U-E の family 512 を 10 分の内の normal の EventID で満たした後の新しい EventID。
    const base = Date.parse("2026-07-01T00:00:00+09:00");
    const eew = Array.from({ length: 513 }, (_, index) =>
      frame(base + index * 1_000, "VXSE45", variant("77_01_01_240613_VXSE45", base + index * 1_000, { eventId: String(20260701000000 + index) })));
    const { result: urgent } = await runStage1(ready("T04b", eew, base + 513_000));
    expect(urgent["status"]).toBe("Fail");
    // U-E は報ごとの時刻を書かず件数だけ（P3-DC-AC01 (4)）。
    expect([urgent["eewRejections"], listOf(urgent, "rejections"), recordOf(urgent["pass"])["inputRejections"]]).toEqual([1, [], 1]);
    expect(recordOf(listOf(urgent, "unresolved").map(recordOf).at(-1)!["counts"])).toEqual({ "U-E": { normal: 1, training: 0, test: 0, marks: 0 } });
    // (a)(c): U-W の partial 128 の後の新しい官署を 2 通（admissionCounts は増えず、印は 1 のまま）。
    const weather = Array.from({ length: 130 }, (_, index) => {
      const at = base + index * 60_000;
      return frame(at, "VPWW57", variant("15_16_02_251222_VPWW57", at, { office: `試験気象台${index < 128 ? index : 128}` }));
    });
    const { result: partial } = await runStage1(ready("T04a", weather, base + 131 * 60_000));
    expect(partial["status"]).toBe("Fail");
    expect(listOf(partial, "rejections").map(recordOf).map((item) => [item["inputId"], item["unit"], item["kind"]]))
      .toEqual([["input-129", "U-W", "unavailable"], ["input-130", "U-W", "unavailable"]]);
    expect(listOf(partial, "unresolved").map(recordOf).map((item) => item["counts"]))
      .toEqual([{ "U-W": { normal: 0, training: 0, test: 0, marks: 1 } }]);
  }, 180_000);

  it("P3-DC-T06 contractBoundary / AC05: correct transitions are not losses", async () => {
    // (a) VTSE51 の版 2 が観測点 B を落としても B が残る。
    const first = readFileSync("test/fixtures/32-39_11_10_250206_VTSE51.xml", "utf8");
    const at = Date.parse("2011-03-11T15:01:00+09:00");
    const stations = [...first.matchAll(/<Station><Name>[^<]*<\/Name><Code>([^<]*)<\/Code>[\s\S]*?<\/Station>/g)];
    const dropped = variant("32-39_11_10_250206_VTSE51", at + 20 * MINUTE, { serial: "4" }).replace(/<Station><Name>[^<]*<\/Name><Code>21002<\/Code>[\s\S]*?<\/Station>/, "");
    expect(stations.map((item) => item[1])).toContain("21002");
    const coastal = "normal/tsunamiObservation:VTSE51/20110311144640";
    const { result: merged } = await runStage1(ready("T06a", [frame(at, "VTSE51", first), frame(at + 20 * MINUTE, "VTSE51", dropped)], at + HOUR, [
      { atMs: at + HOUR, label: "B が残る", check: (h) => h.unit("U-T").observations.find((item) => item.subject === coastal)?.stations.some((item) => item.code === "21002") === true },
    ]));
    expect(merged["status"]).toBe("Pass");
    // (b) U-F の官署の subject が報時刻＋7 日で回収されても、容量の診断の無い step なので欠けにならない。
    const series = readFileSync("test/fixtures/81_01_04_251222_VPWP50.xml", "utf8");
    const reported = Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(series)![1]);
    const { result: collected } = await runStage1(ready("T06b", [frame(reported, "VPWP50", series)], reported + 7 * DAY + MINUTE, [
      { atMs: reported + 7 * DAY + MINUTE, label: "7 日で回収", check: (h) => h.unit("U-F").subjects.length === 0 },
    ]));
    expect(collected["status"]).toBe("Pass");
    expect(listOf(collected, "losses")).toEqual([]);
    // (c) 世代の上限の近くまで非 active の予報を持つ U-T で、active の予報 X の解除報（区域を足した報）が別の非 active を退去させる。
    const { units, prepare, xRelease } = nearTsunamiLimit();
    const { result: released } = await runStage1(ready("T06c", [frame(xRelease.atMs, "VTSE41", xRelease.xml)], xRelease.atMs + MINUTE, [
      { atMs: xRelease.atMs + MINUTE, label: "X は released で残る", check: (h) => h.unit("U-T").forecasts.find((item) => item.eventId === X_EVENT)?.effective === "released" },
    ]), { units, prepare });
    expect(released["status"]).toBe("Pass");
    expect(recordOf(recordOf(released["evictions"])["total"])["U-T"]).toBe(1);
  }, 180_000);

  it("P3-DC-T07 contractBoundary / AC01・AC03: digest mismatch, missing data and the time budget block with a result file", async () => {
    const dir = scratch();
    const day = join(dir, "x-2026-06-03");
    mkdirSync(day);
    const rows = [
      { filename: "a.xml", format: "xml", head: { type: "VPWW57" }, receivedTime: "2026-06-03T00:10:00.000Z", fixture: "15_16_02_251222_VPWW57" },
      { filename: "b.xml", format: "xml", head: { type: "VPWW55" }, receivedTime: "2026-06-03T00:20:00.000Z", fixture: "15_17_01_251222_VPWW55" },
      { filename: "b.json", format: "json", head: { type: "VPWW55" }, receivedTime: "2026-06-03T00:20:00.000Z", fixture: null },
    ];
    const write = (list: readonly (typeof rows)[number][]) => writeFileSync(join(day, "telegrams.json"), JSON.stringify(list.map(({ fixture: _fixture, ...row }) => row)));
    for (const row of rows) writeFileSync(join(day, row.filename), row.fixture == null ? "{}" : readFileSync(`test/fixtures/${row.fixture}.xml`));
    write(rows);
    const original = readScenario({ id: "W1:2026-06-03", dataDir: dir, expectedDigest: null });
    if (original.kind !== "ready") throw new Error("the archive did not read");
    expect(original.frames.map((item) => item.headType)).toEqual(["VPWW57", "VPWW55"]);
    write([{ ...rows[0], receivedTime: "2026-06-03T00:11:00.000Z" }, rows[1], rows[2]]);
    expect(readScenario({ id: "W1:2026-06-03", dataDir: dir, expectedDigest: original.digest })).toMatchObject({ kind: "blocked", reason: "digestMismatch" });
    write([{ ...rows[0], head: { type: "VPWW58" } }, rows[1], rows[2]]);
    expect(readScenario({ id: "W1:2026-06-03", dataDir: dir, expectedDigest: original.digest })).toMatchObject({ kind: "blocked", reason: "digestMismatch" });
    // N1・N2・N3 は同じ t0 を 06-26 の採取物から求めるので、採取物が無ければ 3 つとも blocked（既定の t0 で走らせない）。
    for (const id of ["N1", "N2", "N3"]) expect(readScenario({ id, dataDir: null, expectedDigest: null })).toMatchObject({ kind: "blocked", reason: "dataMissing" });
    const missing = readScenario({ id: "W1:2026-06-03", dataDir: join(dir, "absent"), expectedDigest: null });
    expect(missing).toMatchObject({ kind: "blocked", reason: "dataMissing" });
    await runStage1(missing, { out: join(dir, "missing.json") });
    expect(JSON.parse(readFileSync(join(dir, "missing.json"), "utf8"))).toMatchObject({ status: "blocked", blocked: { reason: "dataMissing" } });
    await runStage1(readScenario({ id: "R2S", dataDir: null, expectedDigest: null }), { out: join(dir, "budget.json"), budgetMs: 0 });
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"))).toMatchObject({ status: "blocked", blocked: { reason: "timeBudget" } });
  }, 60_000);

  it("P3-DC-T08(a) contractBoundary / AC05: a synthetic VTSE52 with a duplicated station code blocks the run without capacity values", async () => {
    const at = Date.parse("2016-09-01T07:20:00+09:00");
    const xml = variant("32-39_12_05_250206_VTSE52", at);
    const station = /<Station>[\s\S]*?<\/Station>/.exec(xml)![0];
    const { result } = await runStage1(ready("T08a", [frame(at, "VTSE52", xml.replace(station, `${station}\n${station}`))], at + MINUTE));
    expect(result).toMatchObject({ status: "blocked", blocked: { reason: "inputNotAdopted" } });
    expect(result["limits"]).toBeUndefined();
  });

  it("P3-DC-T09 contractBoundary / AC06: a U-T or U-Q summary fails the run (ruling A'), with the bytes at the summary time", async () => {
    const t0 = Date.parse("2026-06-26T00:00:00+09:00");
    const frames = synthesize("N1", 1, { t0Ms: t0 });
    const quake = Buffer.from(frames.filter((item) => item.headType === "VXSE53").reduce((a, b) => b.body.byteLength > a.body.byteLength ? b : a).body).toString("utf8");
    const forecast = Buffer.from(frames.find((item) => item.headType === "VTSE41")!.body).toString("utf8");
    const swap = (xml: string, index: number) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${20260626000100 + index}</EventID>`);
    // U-Q の view 3 件（1 件約 330 KB）と U-T の view 4 件（1 件約 20 KB、計 64 KiB 超）で全体が 1 MiB を越える。
    const inputs = [0, 1, 2, 3].flatMap((index) => [...index < 3 ? [frame(t0 + index * MINUTE, "VXSE53", swap(quake, index))] : [],
      frame(t0 + index * MINUTE + 1_000, "VTSE41", swap(forecast, index))]);
    const { result } = await runStage1(ready("T09a", inputs, t0 + 10 * MINUTE));
    expect(result["status"]).toBe("Fail");
    expect(recordOf(result["pass"])["failingSummaries"]).toEqual(expect.arrayContaining(["U-T", "U-Q"]));
    const first = recordOf(listOf(result, "summaryTransitions")[0]);
    expect(first["withoutWeatherOver1MiB"]).toBe(true);
    expect(recordOf(result["summaries"])["U-T"]).toEqual([{ fromMs: expect.any(Number), toMs: null }]);
    // 1 MiB の境界: U-T の区域名を伸ばし、製品が U-Q を要約にする最小の文字数 n を製品の判定（要約の有無）だけで二分探索する。
    // 外枠の計量が製品と同じなら、n で製品が要約にした publish の total（要約の始まりの記録）は 1 MiB を越え、その差は 152 byte 未満
    // （外枠を 152 byte 少なく数えると 1 MiB 以下になって落ちる）。n-1 では製品はどの publish でも要約にしない。区切りの snapshot は
    // 保存の後の外枠で、要約の始まりの publish（保存の前）と数 byte 違うので、ここでは比べない。
    const forecastAt = t0 + 5 * MINUTE;
    const base = variant("32-39_12_02_250206_VTSE41", forecastAt, { eventId: "20260626000200" });
    const body = base.indexOf("<Body");
    const padded = (chars: number) => {
      let left = chars;
      return base.slice(0, body) + base.slice(body).replace(/<Area><Name>([^<]*)<\/Name>/g, (_whole, name: string) => {
        const take = Math.min(left, 12_000);
        left -= take;
        return `<Area><Name>${name}${"x".repeat(take)}</Name>`;
      });
    };
    const boundary = async (chars: number) => {
      const { result: run } = await runStage1(ready("T09c", [...inputs.filter((item) => item.headType === "VXSE53"), frame(forecastAt, "VTSE41", padded(chars))],
        t0 + 10 * MINUTE, [], [t0 + 10 * MINUTE]));
      return { summarized: recordOf(run["summaries"])["U-Q"] != null, transitions: listOf(run, "summaryTransitions").map(recordOf) };
    };
    let low = 0, high = 48_000;
    expect([(await boundary(low)).summarized, (await boundary(high)).summarized]).toEqual([false, true]);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await boundary(middle)).summarized) high = middle; else low = middle;
    }
    const [before, after] = [await boundary(high - 1), await boundary(high)];
    expect(before.transitions).toEqual([]);
    const start = after.transitions[0];
    expect(start["summarized"]).toEqual(["U-Q"]);
    expect(Number(start["total"]) - 1_048_576).toBeGreaterThan(0);
    expect(Number(start["total"]) - 1_048_576).toBeLessThan(152);
    // 印は U-W・U-F（空でも分野ごとに約 1.2 KB）を除いた合計なので、製品の境界ではまだ false。
    expect(start["withoutWeatherOver1MiB"]).toBe(Number(start["withoutWeather"]) > 1_048_576);
    console.info(`[P3-DC-T09] boundary n=${high} total(n)=${start["total"]} withoutWeather(n)=${start["withoutWeather"]}`);
    // U-W（partial 1 件の view 約 13 KB）と U-F（官署 1 件約 1.3 KB）だけが要約になる run は、要約の時刻を報告して Pass。
    const weather = [...Array.from({ length: 100 }, (_, index) => {
      const at = t0 + index * MINUTE;
      return frame(at, "VPWW57", variant("15_16_02_251222_VPWW57", at, { office: `試験気象台${index}` }));
    }), ...Array.from({ length: 55 }, (_, index) => {
      const at = t0 + index * MINUTE + 30_000;
      return frame(at, "VPWP50", variant("81_01_04_251222_VPWP50", at, { office: `試験気象台${index}` }));
    })].sort((a, b) => a.atMs - b.atMs);
    const { result: calm } = await runStage1(ready("T09b", weather, t0 + 2 * HOUR));
    expect(calm["status"]).toBe("Pass");
    expect(Object.keys(recordOf(calm["summaries"])).sort()).toEqual(["U-F", "U-W"]);
    expect(recordOf(listOf(calm, "summaryTransitions").at(-1))["withoutWeatherOver1MiB"]).toBe(false);
  }, 180_000);

  it("P3-DC-T10 contractBoundary / AC03: skipped ticks match 1 s ticks around each deadline; a failed save blocks", async () => {
    const t = Date.parse("2026-07-01T00:00:00+09:00");
    const series = readFileSync("test/fixtures/81_01_04_251222_VPWP50.xml", "utf8");
    const seriesAt = t + 3 * HOUR;
    const frames = [
      frame(t, "VTSE51", variant("32-39_11_10_250206_VTSE51", t)),
      frame(t + HOUR, "VTSE41", variant("32-39_11_02_250206_VTSE41", t + HOUR, { eventId: "20260701010000" })),
      frame(t + 2 * HOUR, "VTSE41", releasedOf(variant("32-39_11_02_250206_VTSE41", t + 2 * HOUR, { eventId: "20260701010000" }))),
      frame(t + 2 * HOUR + MINUTE, "VXSE45", variant("77_01_01_240613_VXSE45", t + 2 * HOUR + MINUTE, { eventId: "20260701020100" })),
      frame(seriesAt, "VPWP50", shiftTimestamps(series, seriesAt - Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(series)![1]))),
    ];
    // 期限: U-T の観測 24 時間・解除の後の予報 7 日・U-E の current 10 分・U-F の subject 7 日。
    const deadlines = [t + DAY, t + 2 * HOUR + 7 * DAY, t + 2 * HOUR + 11 * MINUTE, seriesAt + 7 * DAY];
    const eewAt = t + 2 * HOUR + 11 * MINUTE;
    const current = (h: Harness) => h.unit("U-E").current.some((item) => item.eventId === "20260701020100");
    const gateOpen = (h: Harness) => h.unit("U-E").gates.find((item) => item.subject === "normal/VXSE45/20260701020100")?.currentUntil === null;
    // 各期限の前後 10 秒で、対象が区間の中で変わることを両方式で確かめる（区間が期限を外していないこと）。
    const observation = (h: Harness) => h.unit("U-T").observations.find((item) => item.subject === "normal/tsunamiObservation:VTSE51/20110311144640")?.effective;
    const forecastHeld = (h: Harness) => h.unit("U-T").forecasts.some((item) => item.eventId === "20260701010000");
    const seriesHeld = (h: Harness) => h.unit("U-F").subjects.length === 1;
    const around = (atMs: number, label: string, before: (h: Harness) => boolean, after: (h: Harness) => boolean): Expectation[] => [
      { atMs: atMs - 10_000, label: `${label}の前`, check: before }, { atMs: atMs + 10_000, label: `${label}の後`, check: after }];
    const expectations: Expectation[] = [
      ...around(deadlines[0], "U-T の観測の 24 時間", (h) => observation(h) === "active", (h) => observation(h) === "expired"),
      ...around(deadlines[1], "解除の後の予報の 7 日", forecastHeld, (h) => !forecastHeld(h)),
      ...around(eewAt, "U-E の current の 10 分", current, (h) => !current(h) && gateOpen(h)),
      ...around(deadlines[3], "U-F の subject の 7 日", seriesHeld, (h) => !seriesHeld(h)),
    ];
    const scenario = ready("T10", frames, seriesAt + 7 * DAY + MINUTE, expectations);
    const skipped = await runStage1(scenario);
    const everySecond = await runStage1(scenario, { everySecond: deadlines.map((atMs) => ({ fromMs: atMs - 10_000, toMs: atMs + 10_000 })) });
    const compared = (result: Readonly<Record<string, JsonValue>>) => [result["status"], result["final"], result["limits"], result["rejections"],
      result["eewRejections"], result["losses"], result["eewLosses"], result["summaries"], result["expectations"]];
    expect(compared(everySecond.result)).toEqual(compared(skipped.result));
    expect(listOf(skipped.result, "expectations").map(recordOf).every((item) => item["ok"] === true)).toBe(true);
    const timing = (result: Readonly<Record<string, JsonValue>>) => recordOf(result["timing"]);
    expect(Number(timing(everySecond.result)["ticks"])).toBeGreaterThan(Number(timing(skipped.result)["ticks"]));
    console.info(`[P3-DC-T10] skipped ${JSON.stringify(timing(skipped.result))} everySecond ${JSON.stringify(timing(everySecond.result))}`);
    // (b) 保存を 1 回失敗させると、再試行の時刻を越えて測らずに checkpointFailed で止まる。
    const { result: failed } = await runStage1(scenario, { checkpointFileSystem: failingOnce() });
    expect(failed).toMatchObject({ status: "blocked", blocked: { reason: "checkpointFailed" } });
  }, 180_000);
});

// 保存の最初の open だけを失敗させるメモリの file system。
function failingOnce(): CheckpointFileSystem {
  const files = new Map<string, Uint8Array>();
  let failed = false;
  return { readFile: (path) => files.get(path) ?? null, unlinkSync: (path) => { files.delete(path); },
    mkdir: async () => {}, rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, syncDirectory: async () => {},
    open: async (path) => {
      if (!failed) { failed = true; throw new Error("injected open failure"); }
      let bytes = new Uint8Array();
      return { write: async (data) => { bytes = data.slice(); }, sync: async () => {}, close: async () => { files.set(path, bytes); } };
    } };
}

// T06(c) の前置き: U-T の reducer を直接回して、世代の上限の近くまで非 active の予報を積んだ state を作る（66 区域の解除済みで詰め、
// 1 区域の解除済みで隙間を埋める）。X は 1 区域の active で、解除報は 66 区域（区域を足すので X が上限を越え、最古の非 active を退去させる）。
const X_EVENT = "20260601000000";
function nearTsunamiLimit() {
  const unit = linkedUnitTable["U-T"];
  const base = Date.parse("2026-06-01T00:00:00+09:00");
  const full = variant("32-39_12_02_250206_VTSE41", base);
  const body = full.indexOf("<Body");
  const single = full.slice(0, body) + full.slice(body).replace(/(<\/CodeDefine>\s*<Item>[\s\S]*?<\/Item>)[\s\S]*?(\s*<\/Forecast>)/, "$1$2");
  const at = (xml: string, atMs: number, eventId: string) => shiftTimestamps(xml, atMs - base).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  let state = initialUnits["U-T"];
  let deadline: RuntimeUnitDeadline | null = null;
  let sequence = 0, clock = base;
  // 製品の tick と同じく、期限の来た通知の記録を受信の前に回収する（無いと回収されない記録で上限の近さを見誤る）。
  const feed = (xml: string, atMs: number) => {
    const now: ClockReading = { wallTimeMs: atMs, monotonicMs: 1 };
    while (deadline?.wallTimeMs != null && deadline.wallTimeMs <= atMs) {
      const due = unit.reduce(state, { kind: "deadline", clock: now });
      state = due.state;
      deadline = due.nextDeadline;
    }
    const decoded = decodeMaterial(envelope("pre", "VTSE41", `pre-${++sequence}`, Buffer.from(xml), now, sequence).payload.item);
    if (decoded.kind !== "decoded") throw new Error("pre-fill report did not decode");
    const step = unit.reduce(state, { kind: "receive", material: decoded.material, clock: now });
    return step.diagnostics.some((item) => item.reason === "tsunamiCapacityEvicted") ? null : step;
  };
  const issued = feed(at(single, base, X_EVENT), base)!;
  state = issued.state;
  deadline = issued.nextDeadline;
  // 退去が出る直前まで、発表と解除の組を積む。
  const fill = (template: string) => {
    for (;;) {
      const eventId = String(20260601010000 + sequence);
      clock += 2 * MINUTE;
      const before = state;
      const issue = feed(at(template, clock, eventId), clock);
      if (issue == null) return;
      state = issue.state;
      const release = feed(at(releasedOf(template), clock + MINUTE, eventId), clock + MINUTE);
      if (release == null) { state = before; return; }
      state = release.state;
      deadline = release.nextDeadline;
    }
  };
  fill(full);
  fill(single);
  // X の解除報は、最後に収まらなかった報と同じ時刻に置く（期限の過ぎた通知の回収で空く量を、収まらなかった時と揃える）。
  const xRelease = { atMs: clock, xml: at(releasedOf(full), clock, X_EVENT) };
  // 前置きの state を 1 つの入力で U-T に置く。owner-harness の seeded と違い、表示の差分（全 subject の追加）も返して
  // snapshot の射影の参照を state と揃える（無いと次の表示の差分の before が射影に無く、view-projector が止まる）。
  const seed = state, seedDeadline = deadline;
  let pending = true;
  const units: UnitTable = { ...linkedUnitTable, "U-T": { ...unit, reduce: (current, input) => {
    if (!pending || input.kind !== "receive" || input.material.inputId !== "seed:1") return unit.reduce(current, input);
    pending = false;
    return { state: seed, nextDeadline: seedDeadline, decisions: [], intents: [], outcomes: [], diagnostics: [], confirmationEvidence: [],
      displayChanges: [...unit.normalDisplaySubjects(seed)].map((after) => ({ unit: "U-T" as const, operation: after.operation, subject: after.subject, before: null, after })) };
  } } };
  const prepare = (h: Harness, now: ClockReading) => submit(h, envelope(h.root.state.runId, "VTSE41", "seed:1", Buffer.from(full), now, 100_000));
  return { units, prepare, xRelease };
}

// Q-DC-RUN の口（統合担当が配送の後に回す）。既定の run では走らない（P3-DC-AC07 (2)）。
const env = process.env;
describe.runIf(env["FLEQ_DISASTER"] === "1")("P3-DISASTER-CAPACITY-001 formal run", () => {
  // P3-DC-RES-01 の 60 分に余裕を足した timeout。予算を越えたら流し手が自分で止めて blocked の結果を書く。
  it("runs FLEQ_DISASTER_SCENARIO and seals the result into FLEQ_DISASTER_OUT", async () => {
    const id = env["FLEQ_DISASTER_SCENARIO"], out = env["FLEQ_DISASTER_OUT"];
    if (id == null || out == null) throw new Error("FLEQ_DISASTER_SCENARIO and FLEQ_DISASTER_OUT are required");
    const scenario = readScenario({ id, dataDir: env["FLEQ_DISASTER_DATA"] ?? null, expectedDigest: env["FLEQ_DISASTER_DIGEST"] ?? null });
    const { result } = await runStage1(scenario, { out });
    console.info(`[P3-DC] ${id} status=${String(result["status"])} digest=${String(result["digest"])} timing=${JSON.stringify(result["timing"])}`);
  }, 75 * 60_000);
});
