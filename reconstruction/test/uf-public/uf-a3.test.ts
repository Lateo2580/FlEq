import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RuntimeState } from "../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { keyBound } from "./uf-bound";
import { allSubjects, atTime, combine, decode, eewReport, expectConsistent, projectionInput, received, startup } from "../snapshot-sse/projection-fixture";
import type { Step } from "../snapshot-sse/projection-fixture";

// P3-UFP-AC05（監査 A3）: 平常の大きさの U-F の state が地震の分野を要約に落とさない。base にもある物だけを使うので、
// 同じ組み立てを base でも走らせられる（base では地震が要約になって落ちる）。
const at = 1780650000000;
const clock = { wallTimeMs: at, monotonicMs: 1 };
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const EQ = "32-35_01_03_240613_VXSE53";

function naganoState(count: number): WeatherTimeseriesUnitState {
  const xml = readFileSync("test/fixtures/81_09_01_260605_VPWP50.xml", "utf8");
  const entered = ingestXmlData({ inputId: "a3", inputSequence: 1, receivedAt: at, origin: "replay", kind: "replay", body: Buffer.from(xml), headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  const empty: WeatherTimeseriesUnitState = { schemaVersion: "p2-weather-timeseries-unit-v8", contentRevision: 0, subjects: [], gates: [], intents: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
  const seed = reduceWeatherTimeseriesUnit(empty, { kind: "receive", material: decoded.material, clock }).state.subjects[0];
  // 同じ保存内容を官署名だけ替えて並べる。長野の実物の大きさの series を官署の数だけ持つ。
  const subjects = Array.from({ length: count }, (_all, index) => {
    const subject = `normal/VPWP50/office-${String(index).padStart(3, "0")}`;
    return { ...seed, subject, source: { ...seed.source!, subject } };
  });
  return { ...empty, subjects, gates: subjects.map((item) => ({ subject: item.subject, operation: item.operation, source: item.source! })) };
}

describe("P3-UFP-T05 regression (audit A3)", () => {
  it("P3-UFP-T05: with a normal-sized U-F state, three earthquakes, a tsunami and an EEW, the earthquake domain stays full", async () => {
    const started = await startup(clock);
    const quake = (id: string) => decode(EQ, "VXSE53", (xml) => atTime(xml.replace(/<EventID>\d+<\/EventID>/, `<EventID>${id}</EventID>`), "2026-06-05T18:00:00+09:00"), `${EQ}/${id}`);
    const real: Step = await combine(started.state, [
      received("run", quake("20260605170001"), clock), received("run", quake("20260605170002"), clock), received("run", quake("20260605170003"), clock),
      received("run", decode("32-39_11_11_250206_VTSE41", "VTSE41", (xml) => atTime(xml, "2026-06-05T18:00:00+09:00")), clock),
      received("run", eewReport("20260605170004", "normal", "77_01_01_240613_VXSE45", (xml) => atTime(xml, "2026-06-05T18:00:00+09:00")), clock)]);
    const big = naganoState(30);
    // 前提: 保存の計量 B が平常の山の最小（Q-PERIOD.measurement の 15,638,202）に届く。
    const stored = serializedEnvelope({ schemaVersion: big.schemaVersion, unit: "U-F", generation: 0, capturedAt: 0,
      payload: weatherTimeseriesUnitCodec.encode(big), sha256: "0".repeat(64) }).byteLength + 62;
    expect(stored).toBeGreaterThanOrEqual(15_638_202);
    const units: RuntimeState["units"] = { ...real.state.units, "U-F": { ...real.state.units["U-F"], ...big } };
    const state: RuntimeState = { ...real.state, units, views: { ...real.state.views,
      "U-F": { ...toWeatherTimeseriesView(units["U-F"]), contentRevision: "1" } } };
    const assembled: Step = { ...real, state, displayChanges: [...real.displayChanges, ...allSubjects(state).filter((change) => change.unit === "U-F")] };
    const result = projectSnapshot(projectionInput(assembled, at), null);
    if (result.kind !== "projected") throw new Error(result.kind);
    expectConsistent(result.state, result.snapshot, result.utf8Bytes);
    const { current } = result.snapshot;
    if (process.env.UFP_NUMBERS != null) console.log("UFPNUM " + JSON.stringify({ earthquakeBytes: result.state.domains.earthquake.utf8Bytes,
      ufBytes: result.state.domains.weatherTimeseries.utf8Bytes, snapshotBytes: result.utf8Bytes, earthquake: current.earthquake.delivery,
      uf: current.weatherTimeseries.delivery }));
    // 前提: 地震の分野だけで 64 KiB を越え、U-F が大きいと全体が 1 MiB を越える。
    expect(result.state.domains.earthquake.utf8Bytes).toBeGreaterThan(65_536);
    expect(current.earthquake.delivery).toBe("full");
    // 津波と EEW の分野は 64 KiB 未満なので full のままで、ここでは判別に使わない。
    expect([current.tsunami.delivery, current.eew.delivery]).toEqual(["full", "full"]);
    // U-F の view は AC03 の式 V = 512 + Σ b(k) 以下で、分野はそれに wrapper と要約の 3 行を足した分に収まる。
    const bound = 512 + big.subjects.reduce((sum, item) => sum + keyBound(item), 0);
    expect(utf8(state.views["U-F"])).toBeLessThanOrEqual(bound);
    expect(result.state.domains.weatherTimeseries.utf8Bytes).toBeLessThanOrEqual(bound + 4_096);
  }, 60_000);
});
