import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { WeatherTimeseriesUnitState, WeatherTimeseriesUnitStep } from "../../contracts/p2-weather-timeseries-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import type { SnapshotProjectionState } from "../../contracts/p2-snapshot-sse.types";
import { decode, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import type { Step } from "../snapshot-sse/projection-fixture";

// P3-UFP-AC02 / AC04: 公開形式だけを変えても、owner の state・保存形・採否・outcomes と U-F の要約の行は変わらない。
// 期待の digest は base（9b0248ac に baseOid の commit ff51da45 を足したもの。src と契約は同じ）でこの file を走らせて記録した値。
// UFP_RECORD=1 では比べずに今の値を出す。
const RECORD = process.env.UFP_RECORD != null;
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 16); const baseVersion = (payload: unknown) => withoutControl(JSON.stringify(payload).replaceAll('"p2-weather-timeseries-unit-v7"', '"p2-weather-timeseries-unit-v1"')); // P3-VM-AC05: 版の文字列だけを base に戻して比べる
// P3-VM-AC01: ReportRef の controlDateTimeRaw は base に無いので外して比べる（発注 2b で U-F は Control/DateTime で比べるが、この file の報の採否は変わらない）。
// P3-EF-AC05 (6): validUntil で移った noActiveItems の lapsed も base に無いので外して比べる。
const withoutControl = (json: string) => json.replace(/"controlDateTimeRaw":"[^"]*",/g, "").replaceAll(',"lapsed":true', "");
const office = (xml: string, name: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
// Head の無い報（head_missing の fixture）は報時刻を持たないので、固定の時刻を当てる。
const reportAt = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)<\/ReportDateTime>/.exec(xml)?.[1] ?? "2026-06-05T17:00:00+09:00");
const shiftReport = (xml: string, hours: number) => xml.replace(/<ReportDateTime>([^<]+)<\/ReportDateTime>/, (_all, raw: string) =>
  `<ReportDateTime>${new Date(Date.parse(raw) + hours * 3_600_000).toISOString().replace(".000Z", "+00:00")}</ReportDateTime>`);
const JUNE = ["81_02_01_260605_VPWP50_high_severity", "81_03_01_260605_VPWP50_unknown_code", "81_04_01_260605_VPWP50_cancel",
  "81_05_01_260605_VPWP50_head_missing", "81_06_01_260605_VPWP50_criteria_period", "81_07_01_260605_VPWP50_local_area",
  "81_08_01_260605_VPWP50_criteria_property_sibling", "81_09_01_260605_VPWP50", "81_09_01_260605_VPWP50_local_identity"];
const JANUARY = ["81_01_01_260129_VPWP50", "81_01_02_260129_VPWP50", "81_01_03_260129_VPWP50", "81_01_04_251222_VPWP50"];
// JUNE[0] と同じ官署への続報: 重複・古い報・新しい報。
const FOLLOW: readonly (readonly [string, number])[] = [["duplicate", 0], ["stale", -1], ["newer", 1]];

function material(file: string, name: string, hours: number): Readonly<{ material: DecodedMaterial; at: number }> {
  const xml = shiftReport(office(readFileSync(`test/fixtures/${file}.xml`, "utf8"), name), hours);
  const entered = ingestXmlData({ inputId: `${file}/${name}/${hours}`, inputSequence: 1, receivedAt: reportAt(xml), origin: "replay",
    kind: "replay", body: Buffer.from(xml), headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return { material: decoded.material, at: reportAt(xml) + 60_000 };
}
const empty = (): WeatherTimeseriesUnitState => ({ schemaVersion: "p2-weather-timeseries-unit-v7", contentRevision: 0, subjects: [],
  gates: [], intents: [], persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null,
    dirtySince: null } });

type Trace = { label: string; decision: string; digest: string };
function trace(): Trace[] {
  const rows: Trace[] = [];
  const note = (label: string, result: WeatherTimeseriesUnitStep) => rows.push({ label,
    decision: result.decisions.map((item) => item.decision === "changed" ? item.decision : item.decision === "unchanged" ? item.reason
      : item.decision === "rejected" ? item.reason : item.decision).join(","),
    digest: sha({ encode: sha(baseVersion(weatherTimeseriesUnitCodec.encode(result.state))),
      ...JSON.parse(withoutControl(JSON.stringify({ decisions: result.decisions, outcomes: result.outcomes, intents: result.intents }))),
      nextDeadline: result.nextDeadline }) });
  const receive = (label: string, state: WeatherTimeseriesUnitState, file: string, name: string, hours = 0) => {
    const { material: input, at } = material(file, name, hours);
    const result = reduceWeatherTimeseriesUnit(state, { kind: "receive", material: input, clock: { wallTimeMs: at, monotonicMs: rows.length + 1 } });
    note(label, result);
    return result.state;
  };
  let january = empty();
  JANUARY.forEach((file, index) => { january = receive(`jan:${file}`, january, file, `jan${index}`); });
  let june = empty();
  JUNE.forEach((file, index) => { june = receive(`jun:${file}`, june, file, `jun${index}`); });
  for (const [kind, hours] of FOLLOW) june = receive(`jun:${kind}`, june, JUNE[0], "jun0", hours);
  // 全ての validUntil より後の期限、保存形を空の owner へ復元し、その上へもう 1 通。
  const last = Math.max(...june.subjects.map((item) => item.validUntil ?? 0));
  const expired = reduceWeatherTimeseriesUnit(june, { kind: "deadline", clock: { wallTimeMs: last + 1, monotonicMs: 90 } });
  note("jun:deadline", expired);
  const restored = reduceWeatherTimeseriesUnit(empty(), { kind: "restore", persisted: weatherTimeseriesUnitCodec.encode(expired.state),
    clock: { wallTimeMs: last + 2, monotonicMs: 91 } });
  note("jun:restore", restored);
  receive("jun:afterRestore", restored.state, JUNE[1], "jun1", 2);
  return rows;
}

// T01 と同じ列を runtime（owner と publisher）に通し、各 step で U-F の要約 3 行の digest を取る。1 月の 4 本、6 月の 9 本と続報、
// 期限、restore、restore 後の 1 通。
async function summaryRows(): Promise<{ label: string; digest: string }[]> {
  const rows: { label: string; digest: string }[] = [];
  type Line = { current: Step; previous: SnapshotProjectionState | null };
  const project = (label: string, line: Line, nowMs: number) => {
    // 拒否された報や重複した報では snapshot は変わらない。
    const result = projectSnapshot(projectionInput(line.current, nowMs), line.previous);
    if (result.kind !== "projected") { rows.push({ label, digest: result.kind }); return; }
    line.previous = result.state;
    rows.push({ label, digest: sha(result.snapshot.current.weatherTimeseries.items.map(({ unavailable, unconfirmed, unknownCode, freshness,
      confirmation, ...head }) => ({ ...head, admission: {}, unavailable, unconfirmed, unknownCode, freshness, confirmation }))) });
  };
  const feed = async (label: string, line: Line, file: string, name: string, hours: number) => {
    const { at } = material(file, name, hours);
    const clock = { wallTimeMs: at, monotonicMs: rows.length + 2 };
    line.current = await step(line.current.state, received("run", decode(file, "VPWP50", (xml) => shiftReport(office(xml, name), hours), `${file}/${name}/${hours}`), clock));
    project(label, line, at);
  };
  const open = async (clock: { wallTimeMs: number; monotonicMs: number }, restored?: Parameters<typeof startup>[1]): Promise<Line> =>
    ({ current: await startup(clock, restored), previous: null });
  const january = await open({ wallTimeMs: 1780650000000, monotonicMs: 1 });
  for (const [index, file] of JANUARY.entries()) await feed(`jan:${file}`, january, file, `jan${index}`, 0);
  const june = await open({ wallTimeMs: 1780650000000, monotonicMs: 1 });
  for (const [index, file] of JUNE.entries()) await feed(`jun:${file}`, june, file, `jun${index}`, 0);
  for (const [kind, hours] of FOLLOW) await feed(`jun:${kind}`, june, JUNE[0], "jun0", hours);
  const unit = june.current.state.units["U-F"];
  const last = Math.max(...unit.subjects.map((item) => item.validUntil ?? 0));
  const expiredClock = { wallTimeMs: last + 1, monotonicMs: 90 };
  june.current = await step(june.current.state, { kind: "tick", clock: expiredClock });
  project("jun:deadline", june, last + 1);
  const saved = june.current.state.units["U-F"];
  const none = { kind: "empty" } as const;
  const restoredLine = await open({ wallTimeMs: last + 2, monotonicMs: 91 }, { "U-E": none, "U-W": none, "U-F": { kind: "restored", slot: "A",
    envelope: { schemaVersion: saved.schemaVersion, unit: "U-F", generation: 1, capturedAt: last, payload: linkedUnitCodecs["U-F"]!.encode(saved), sha256: "0".repeat(64) } },
  "U-T": none, "U-Q": none, "U-N": none, "U-V": none, "U-L": none, "U-R": none, "U-B": none, "U-M": none, "U-Y": none });
  project("jun:restore", restoredLine, last + 2);
  await feed("jun:afterRestore", restoredLine, JUNE[1], "jun1", 2);
  return rows;
}

// base で UFP_RECORD=1 により記録した値。手順: ff51da45 の作業木で、変更した追跡 file を `git show HEAD:<path>` で base に戻し、この file だけを
// `UFP_RECORD=1 vitest run` で走らせて出力を写した（BASE_TRACE は 1 巡目から不変）。BASE_ROWS は e37e40ec（P3-CURRENCY-COVERAGE-001 の基準）の
// 記録のまま。要約の items から admission の欄が消えた（P3-CC-AC01）ので、digest は今の items に基準の位置で admission: {} を戻して取る
// （admission を除く以外の差があれば一致しない）。制限の間の行（jun:hidden）は仕組みごと無くなったので外した（Q-CC-EXISTING-TESTS）。
const BASE_DECISIONS: readonly string[] = [
  "jan:81_01_01_260129_VPWP50=changed",
  "jan:81_01_02_260129_VPWP50=changed",
  "jan:81_01_03_260129_VPWP50=changed",
  "jan:81_01_04_251222_VPWP50=changed",
  "jun:81_02_01_260605_VPWP50_high_severity=changed",
  "jun:81_03_01_260605_VPWP50_unknown_code=changed",
  "jun:81_04_01_260605_VPWP50_cancel=changed",
  "jun:81_05_01_260605_VPWP50_head_missing=headMissing",
  "jun:81_06_01_260605_VPWP50_criteria_period=changed",
  "jun:81_07_01_260605_VPWP50_local_area=changed",
  "jun:81_08_01_260605_VPWP50_criteria_property_sibling=changed",
  "jun:81_09_01_260605_VPWP50=changed",
  "jun:81_09_01_260605_VPWP50_local_identity=identityMissing",
  "jun:duplicate=duplicate",
  "jun:stale=stale",
  "jun:newer=changed",
  "jun:deadline=changed,changed,changed",
  "jun:restore=",
  "jun:afterRestore=changed",
];
const BASE_TRACE: readonly string[] = [
  "c132f30b82dab62f",
  "5895db85f72e1fa7",
  "e2b1b0839937284d",
  "09baa5b5315e7051",
  "de74f2fed0e4aca2",
  "834a917369ee12e8",
  "e2c20ff9a3a1ec89",
  "9fe87672665f05f3",
  "ca999842ce29660e",
  "6ab74359965febc7",
  "06965c29a4f88e4a",
  "262a308762d12a42",
  "d9540bacf7850da8",
  "835b9aebe34fe0ae",
  "ad32e0b8a8d259c9",
  "f4bcfeb30a488f34",
  "9c6a7ba89028931d",
  "48b90f68aa665204",
  "50ec10948b95d76a",
];
const BASE_ROWS: readonly string[] = [
  "jan:81_01_01_260129_VPWP50=7f8d00ae20a2cdad",
  "jan:81_01_02_260129_VPWP50=fddac77fed583d4b",
  "jan:81_01_03_260129_VPWP50=35f7a2de3f845005",
  "jan:81_01_04_251222_VPWP50=b9fd63c3c97c3aa4",
  "jun:81_02_01_260605_VPWP50_high_severity=78b1412b424e2df6",
  "jun:81_03_01_260605_VPWP50_unknown_code=f7043ce2a0c6139c",
  "jun:81_04_01_260605_VPWP50_cancel=f7043ce2a0c6139c",
  "jun:81_05_01_260605_VPWP50_head_missing=f7043ce2a0c6139c",
  "jun:81_06_01_260605_VPWP50_criteria_period=474b722c6fefecc2",
  "jun:81_07_01_260605_VPWP50_local_area=868c52f151b02c8a",
  "jun:81_08_01_260605_VPWP50_criteria_property_sibling=4f9abf49f1393cdc",
  "jun:81_09_01_260605_VPWP50=04b152ffc06dfae9",
  "jun:81_09_01_260605_VPWP50_local_identity=04b152ffc06dfae9",
  "jun:duplicate=unchanged",
  "jun:stale=unchanged",
  "jun:newer=e7979b13a783784f",
  "jun:deadline=df1e4992694f91c0",
  "jun:restore=fd7d04685be0d7a1",
  "jun:afterRestore=61972a124b106f9d",
];

describe("P3-UFP-T01 / T02 corpus history: the owner's state and the summary rows do not move", () => {
  it("P3-UFP-T01: encode hash, decisions, outcomes, intents and nextDeadline match the base at every step", () => {
    const rows = trace();
    if (RECORD) console.log("UFPREC trace " + JSON.stringify(rows));
    else {
      // 入力が狙った採否になっていること（同じ鍵の重複だと比較が空振りする）。
      expect(rows.map((row) => `${row.label}=${row.decision}`)).toEqual(BASE_DECISIONS);
      expect(rows.map((row) => row.digest)).toEqual(BASE_TRACE);
    }
  });

  it("P3-UFP-T02: the U-F summary rows (three operations) match the base after every report", async () => {
    const rows = await summaryRows();
    if (RECORD) console.log("UFPREC rows " + JSON.stringify(rows));
    else expect(rows.map((row) => `${row.label}=${row.digest}`)).toEqual(BASE_ROWS);
  });
});
