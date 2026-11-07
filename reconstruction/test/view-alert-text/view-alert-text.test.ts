import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { JsonValue, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { eewUnitCodec, reduceEewUnit, toEewView } from "../../src/units/eew/eew-unit";
import { toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { toWeatherTimeseriesView } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { allSubjects, atTime, decode, eewReport, projected, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, sentLater, vtse41 } from "../tsunami-unit/tsunami-fixture";

// P3-VIEW-ALERT-TEXT-001: EEW の到達予想・長周期階級と、津波の警告の文を view へ渡す。

const reportTime = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]);
function material(xml: string, headType: string, inputId: string): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const fixture = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const emptyEew = (): EewUnitState => ({ schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [], unreadableNotices: [],
  persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } });
function eewStep(state: EewUnitState, xml: string, headType: string, inputId: string) {
  return reduceEewUnit(state, { kind: "receive", material: material(xml, headType, inputId), clock: { wallTimeMs: reportTime(xml) + 1000, monotonicMs: 0 } });
}
const nextReport = (xml: string) => sentLater(xml.replace(/<Serial>(\d+)<\/Serial>/, (_, serial: string) => `<Serial>${Number(serial) + 1}</Serial>`));
// Q-VAT-MEASURE (2) の合成: ArrivalTime のある最初の Area を写し、最後の Area の後ろへ足して n 件にする。
function grown(xml: string, count: number): string {
  const start = xml.indexOf("<Forecast>", xml.indexOf("<Body")), body = xml.slice(start);
  const areas = [...body.matchAll(/<Area>[\s\S]*?<\/Area>/g)].map((match) => match[0]);
  const model = areas.find((area) => area.includes("ArrivalTime"))!, extra: string[] = [];
  for (let index = areas.length, code = 700; index < count; index++, code++)
    extra.push(model.replace(/<Code>\d+<\/Code>/, `<Code>${code}</Code>`).replace(/<Name>[^<]*<\/Name>/, "<Name>和歌山県南部沿岸</Name>"));
  const at = start + body.lastIndexOf(areas.at(-1)!) + areas.at(-1)!.length;
  return xml.slice(0, at) + extra.join("") + xml.slice(at);
}

describe("P3-VIEW-ALERT-TEXT-001 EEW", () => {
  it("P3-VAT-T01 acceptance / AC01: the view carries each area's name, long-period class and arrival time in prediction.areas order", () => {
    const current = toEewView(eewStep(emptyEew(), fixture("37_01_01_240613_VXSE43"), "VXSE43", "a").state).current[0];
    expect(current.reportAreas.map((area) => area.code)).toEqual(current.prediction.areas.map((area) => area.code));
    expect(current.reportAreas[1]).toEqual({ code: "632", name: "高知県西部", lgInt: { from: "0", to: "0" }, arrivalTimeRaw: "2024-04-17T23:15:02+09:00" });
    expect(current.reportAreas[0].arrivalTimeRaw).toBeNull();
    expect(current.prediction.areas[0].intensity.condition).toBe("既に主要動到達と推測");
    expect(eewStep(emptyEew(), fixture("77_01_01_240613_VXSE45"), "VXSE45", "b").state.current[0].reportAreas).toEqual([]);
  });

  it("P3-VAT-T02 acceptance / AC02: a follow-up replaces the areas, and cancel, final report and restore leave none", () => {
    const xml = fixture("37_01_01_240613_VXSE43");
    const first = eewStep(emptyEew(), xml, "VXSE43", "a");
    const next = eewStep(first.state, nextReport(xml).replaceAll("2024-04-17T23:15:02+09:00", "2024-04-17T23:15:03+09:00"), "VXSE43", "b");
    expect(next.decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
    expect(next.state.current[0].reportAreas[1].arrivalTimeRaw).toBe("2024-04-17T23:15:03+09:00");
    expect(next.state.contentRevision).toBe(first.state.contentRevision + 1);
    expect(eewStep(first.state, fixture("37_01_03_240613_VXSE43"), "VXSE43", "c").state.current).toEqual([]);
    const final = fixture("77_01_30_260101_VXSE45_FINAL"), before = final.replace(/<NextAdvisory>[^<]*<\/NextAdvisory>/, "").replace("<Serial>30</Serial>", "<Serial>29</Serial>");
    const open = eewStep(emptyEew(), before, "VXSE45", "d");
    expect(open.state.current).toHaveLength(1);
    expect(eewStep(open.state, final, "VXSE45", "e").state.current).toEqual([]);
    expect(JSON.stringify(eewUnitCodec.encode(first.state))).not.toContain("高知県西部");
  });

  it("P3-VAT-T03 contractBoundary / AC03: the wrapped domain bytes decide full and summary, with and without a retained prediction", async () => {
    const at = 1_780_650_000_000, now = { wallTimeMs: at, monotonicMs: 1 }, time = "2026-06-05T18:00:00+09:00";
    const report = (transform: (xml: string) => string) => eewReport("20260605180000", "normal", "77_01_26_240613_VXSE45", (xml) => transform(grown(atTime(xml, time), 188)));
    const started = await startup(now);
    const base = await step(started.state, received("run", decode("81_02_01_260605_VPWP50_high_severity", "VPWP50"), now));
    const known = await step(base.state, received("run", report((xml) => xml), now));
    const unknown = await step(known.state, received("run", report((xml) => nextReport(xml).replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>")), now));
    // 全体を 1 MiB 越えにする（U-F の区域 Code の水増し、boundaries.test.ts と同じ形）。
    const overflowing = (state: RuntimeState) => {
      const subject = state.units["U-F"].subjects[0], strings = [...subject.strings];
      strings[subject.areas[0].code] = "x".repeat(1_100_000);
      const timeseries = { ...state.units["U-F"], subjects: [{ ...subject, strings }] };
      const units = { ...state.units, "U-F": timeseries };
      const value: RuntimeState = { ...state, units, views: { ...state.views, "U-F": { ...toWeatherTimeseriesView(timeseries), contentRevision: "1" } } };
      return projected(projectSnapshot(projectionInput({ state: value, outcomes: [], displayChanges: allSubjects(value) }, at), null));
    };
    const full = overflowing(known.state), held = overflowing(unknown.state);
    const domain = full.state.domains.eew;
    expect(domain.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(domain.full)));
    expect(domain.utf8Bytes).toBeLessThanOrEqual(65_536);
    expect(full.snapshot.current.eew.delivery).toBe("full");
    expect(domain.full.view.current[0].reportAreas).toHaveLength(188);
    for (const key of ["prediction", "retainedPrediction"]) expect(domain.full.view.subjects[0].facts).not.toHaveProperty(key);
    expect(known.outcomes.flatMap(({ outcome }) => outcome.kind === "accepted" ? outcome.subjects : [])[0].facts).toHaveProperty("prediction");
    expect(held.state.domains.eew.full.view.current[0].retainedPrediction).not.toBeNull();
    expect(held.state.domains.eew.utf8Bytes).toBeGreaterThan(65_536);
    expect(held.snapshot.current.eew.delivery).toBe("summary");
  });
});

const AT = "2026-03-01T10:00:00+09:00", ID = "20260301100000", MAJOR = [{ code: "311", name: "宮城県", kind: "52" }];
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const withComment = (xml: string, text: string) => xml.replace("</Body>", `<Comments><WarningComment codeType="固定付加文"><Text>${text}</Text><Code>0141</Code></WarningComment></Comments></Body>`);
const forecastXml = (minutes: number, text: string | null) => { const xml = vtse41({ eventId: ID, at: later(minutes), areas: MAJOR }); return text == null ? xml : withComment(xml, text); };
const take = (xml: string, state = emptyState()) => receive(state, decodeXml(xml, "VTSE41"), clock(reportTime(xml) + 1000));

describe("P3-VIEW-ALERT-TEXT-001 tsunami", () => {
  it("P3-VAT-T04 acceptance / AC04: the view carries the VTSE41 warning comment as the telegram wrote it", () => {
    const xml = fixtureXml("32-39_11_11_250206_VTSE41");
    const text = /<WarningComment[^>]*>\s*<Text>([\s\S]*?)<\/Text>/.exec(xml)![1].trim();
    const step = receive(emptyState(), decodeFixture("32-39_11_11_250206_VTSE41", "VTSE41"), clock(reportTime(xml) + 1000));
    const comment = toTsunamiView(step.state).forecasts[0].warningComment;
    expect(comment).toBe(text);
    expect([comment?.length, comment?.startsWith("東日本大震災クラスの津波が来襲します。\n")]).toEqual([691, true]);
    const none = fixtureXml("synthetic_VTSE41_e01_311major");
    expect(take(none).state.forecasts[0]).not.toHaveProperty("warningComment");
  });

  it("P3-VAT-T05 contractBoundary / AC04: 4,096 characters stay, longer text keeps its head, and an unreadable comment does not refuse the report", () => {
    const comment = (text: string) => take(forecastXml(0, text)).state.forecasts[0].warningComment;
    expect(comment("あ".repeat(4096))).toBe("あ".repeat(4096));
    expect(comment("あ".repeat(4097))).toBe(`${"あ".repeat(4095)}…`);
    expect(comment(`${"あ".repeat(4094)}😀い`)).toBe(`${"あ".repeat(4094)}…`);
    const nested = take(forecastXml(0, "あ<Sub>い</Sub>"));
    expect(nested.decisions[0].decision).toBe("changed");
    expect(nested.state.forecasts[0]).not.toHaveProperty("warningComment");
  });

  it("P3-VAT-T06 acceptance / AC05: a follow-up replaces or clears the comment; release and cancel keep none", () => {
    const first = take(forecastXml(0, "ただちに避難してください。"));
    const replaced = take(forecastXml(1, "津波は繰り返し襲ってきます。"), first.state);
    expect(replaced.state.forecasts[0].warningComment).toBe("津波は繰り返し襲ってきます。");
    expect(replaced.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
    expect(take(forecastXml(2, null), replaced.state).state.forecasts[0]).not.toHaveProperty("warningComment");
    const released = fixtureXml("32-39_13_07_250206_VTSE41");
    expect(released).toContain("発表している沿岸はありません");
    expect(take(released).state.forecasts[0]).toMatchObject({ effective: "released" });
    expect(take(released).state.forecasts[0]).not.toHaveProperty("warningComment");
    const cancelled = take(vtse41({ eventId: ID, at: later(3), infoType: "取消" }), replaced.state).state.forecasts[0];
    expect(cancelled).toMatchObject({ effective: "cancelled" });
    expect(cancelled).not.toHaveProperty("warningComment");
  });

  it("P3-VAT-T07 contractBoundary / AC06: the comment survives encode and decode; only an active record may hold a readable one", () => {
    const state = take(forecastXml(0, "ただちに避難してください。")).state;
    const payload = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as Record<string, unknown> & { forecasts: Record<string, unknown>[] };
    const restored = tsunamiUnitCodec.decode(payload as JsonValue);
    expect(restored.kind === "restored" ? restored.state.forecasts[0].warningComment : null).toBe("ただちに避難してください。");
    const forecast = (fields: Record<string, unknown>) => ({ ...payload, forecasts: [{ ...payload.forecasts[0], ...fields }] }) as JsonValue;
    const { warningComment: _comment, ...plain } = payload.forecasts[0];
    expect(tsunamiUnitCodec.decode({ ...payload, forecasts: [plain] } as JsonValue).kind).toBe("restored");
    for (const value of ["", "あ".repeat(4097), 1, null]) expect(tsunamiUnitCodec.decode(forecast({ warningComment: value })).kind).toBe("invalid");
    const released = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(take(fixtureXml("32-39_13_07_250206_VTSE41")).state))) as typeof payload;
    expect(tsunamiUnitCodec.decode({ ...released, forecasts: [{ ...released.forecasts[0], warningComment: "文" }] } as JsonValue).kind).toBe("invalid");
  });
});
