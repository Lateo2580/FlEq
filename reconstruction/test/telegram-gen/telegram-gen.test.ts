import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { parseSeismic } from "../../src/domains/seismic/seismic";
import { parseTsunami } from "../../src/domains/tsunami/tsunami";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import { reduceSeismicUnit, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { reduceTsunamiUnit } from "../../src/units/tsunami/tsunami-unit";
import { emptyState as seismicEmpty } from "../seismic-unit/seismic-fixture";
import { emptyState as tsunamiEmpty } from "../tsunami-unit/tsunami-fixture";
import type { GenerateInput } from "../../tools/telegram-gen/telegram-gen.mjs";
import { choices, generateTelegrams } from "../../tools/telegram-gen/telegram-gen.mjs";

// コード表の読みはプロセスに 1 回なので、この file は資料なし（公開サンプルの範囲）で動かす（T11・T13・T16）。
delete process.env.FLEQ_JMA_CODES;

const ORIGIN = "2026-11-01T21:10:00+09:00";
const EVENT_ID = "20261101211000";
const FAMILIES = ["VXSE43", "VXSE45", "VXSE51", "VXSE52", "VXSE53", "VTSE41", "VTSE51", "VTSE52"] as const;

let sequence = 0;
function decode(xml: string, headType: string): DecodedMaterial {
  const entered = ingestXmlData({ inputId: `gen-${++sequence}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const reportMs = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)![1]);
const clock = (xml: string) => ({ wallTimeMs: reportMs(xml), monotonicMs: 0 });
const raw = (value: { kind: string; raw?: string }) => value.raw;

// 資料なしのとき、分野ごとの「先頭の震央地名・区域」で作る入力（分野に無い項目は渡さない）。
function valid(family: string): Record<string, unknown> {
  const place = { placeCode: choices(family).places[0]?.code, lat: 34.8, lon: 138.5, depthKm: 10, magnitude: 6.5 };
  const area = { maxInt: "5+", areaCode: choices(family).areas[0]?.code };
  const byFamily: Record<string, Record<string, unknown>> = {
    VXSE43: { ...place, ...area }, VXSE45: { ...place, ...area }, VXSE51: area, VXSE52: place, VXSE53: { ...place, ...area },
    VTSE41: place, VTSE51: place, VTSE52: place,
  };
  return { family, originTime: ORIGIN, ...byFamily[family] };
}
const gen = (input: Record<string, unknown>) => generateTelegrams(input as GenerateInput);
function made(input: Record<string, unknown>) {
  const result = gen(input);
  if (result.kind !== "generated") throw new Error(`${result.reason} (${result.field})`);
  return result;
}

function eewState(): EewUnitState {
  return { schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [], unreadableNotices: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}

describe("telegram-gen", () => {
  // P3-RW2-T11 acceptance (AC07・AC09・AC11)
  it.each(FAMILIES)("%s: the parser reads back what was asked for", (family) => {
    const input = valid(family);
    const result = made(input);
    expect(result.headType).toBe(family);
    expect(result.eventId).toBe(EVENT_ID); // eventIdAt(起点)。型の EventID が残っていない
    expect(result.originTime).toBe(ORIGIN);
    const [report] = result.reports;
    const material = decode(report.xml, family);
    expect(material.operation).toBe("normal");
    const hypocenter = { name: choices(family).places[0]?.name, code: input.placeCode, latitude: 34.8, longitude: 138.5, depthKm: 10, magnitude: 6.5 };
    if (family === "VXSE43" || family === "VXSE45") {
      const step = reduceEewUnit(eewState(), { kind: "receive", material, clock: clock(report.xml) });
      expect(step.decisions[0]).toMatchObject({ decision: "changed" });
      const current = step.state.current[0];
      expect(current).toMatchObject({ eventId: EVENT_ID, serial: 1, warningClass: family === "VXSE43" ? "warning" : "forecast" });
      expect(raw(current.prediction.maximum.from)).toBe("5+");
      expect(current.prediction.areas.map((area) => area.code)).toEqual([input.areaCode]);
      const facts = step.outcomes[0].subjects[0].facts;
      if (facts.family === "VXSE43" || facts.family === "VXSE45") {
        expect(facts.report).toMatchObject({ hypocenter: hypocenter.name, originTimeRaw: ORIGIN, landOrSea: null,
          coordinate: { raw: "+34.8+138.5-10000/" }, magnitude: { raw: "6.5" } });
      }
    } else if (family.startsWith("VXSE")) {
      const parsed = parseSeismic(material);
      if (parsed.kind !== "accepted" || parsed.candidate.kind !== "earthquake") throw new Error("not accepted");
      const { contribution, eventId, operation } = parsed.candidate;
      expect({ eventId, operation, serialRaw: parsed.candidate.source.serialRaw }).toEqual({ eventId: EVENT_ID, operation: "normal", serialRaw: family === "VXSE53" ? "1" : "" });
      if (family === "VXSE51") expect(contribution.targetDateTimeRaw).toBe(ORIGIN);
      else {
        const h = contribution.hypocenter!;
        expect({ originTimeRaw: h.originTimeRaw, name: h.name, code: h.code }).toEqual({ originTimeRaw: ORIGIN, name: hypocenter.name, code: hypocenter.code });
        expect([h.latitude, h.longitude, h.depthKm, h.magnitude].map((v) => v.kind === "number" ? v.value : null)).toEqual([34.8, 138.5, 10, 6.5]);
      }
      if (family !== "VXSE52") {
        const intensity = contribution.intensity!;
        expect(raw(intensity.maxInt as { kind: string; raw?: string })).toBe("5+");
        const area = intensity.items.find((item) => item.level === "area")!;
        expect([area.code, raw(area.maxInt as { kind: string; raw?: string })]).toEqual([input.areaCode, "5+"]);
        if (family === "VXSE53") {
          // 資料なしのとき、市町村は型のその区域の市町村と同じ集合
          const fixture = readFileSync("test/fixtures/32-35_01_03_240613_VXSE53.xml", "utf8");
          const block = new RegExp(`<Area>\\s*<Name>[^<]*</Name>\\s*<Code>${input.areaCode}</Code>\\s*<MaxInt>[\\s\\S]*?</Area>`).exec(fixture)![0];
          const expected = [...block.matchAll(/<City>\s*<Name>[^<]*<\/Name>\s*<Code>(\d+)<\/Code>/g)].map((m) => m[1]).sort();
          expect(intensity.items.filter((item) => item.level === "city").map((item) => item.code).sort()).toEqual(expected);
        }
      }
    } else {
      const parsed = parseTsunami(material);
      if (parsed.kind !== "accepted") throw new Error("not accepted");
      expect({ eventId: parsed.candidate.eventId, operation: parsed.candidate.operation, serialRaw: parsed.candidate.source.serialRaw })
        .toEqual({ eventId: EVENT_ID, operation: "normal", serialRaw: family === "VTSE41" ? "" : "1" });
    }
  });

  it("keeps the EventID when the serial moves on from the same origin", () => {
    const first = made({ ...valid("VXSE53"), serial: 1 });
    const second = made({ ...valid("VXSE53"), serial: 2 });
    expect(second.eventId).toBe(first.eventId);
    expect(second.reports[0].serial).toBe(2);
    // 同じ秒に続けて作っても 2 報目の時刻が進み、unit が採る（非 EEW は Serial を見ない）
    const step1 = reduceSeismicUnit(seismicEmpty(), { kind: "receive", material: decode(first.reports[0].xml, "VXSE53"), clock: clock(first.reports[0].xml) });
    const step2 = reduceSeismicUnit(step1.state, { kind: "receive", material: decode(second.reports[0].xml, "VXSE53"), clock: clock(second.reports[0].xml) });
    expect([step1.decisions[0].decision, step2.decisions[0].decision]).toEqual(["changed", "changed"]);
  });

  // P3-RW2-T12 acceptance (AC10・AC11)
  it("builds a final and a cancelled EEW series that the unit takes in order", () => {
    for (const end of ["final", "cancel"] as const) {
      const result = made({ ...valid("VXSE45"), reports: 3, end });
      expect(result.reports.map((r) => r.serial)).toEqual(end === "final" ? [1, 2, 3] : [1, 2, 3, 4]);
      const times = result.reports.map((r) => reportMs(r.xml));
      times.slice(1).forEach((at, i) => expect(at - times[i]).toBe(4000));
      expect(result.reports.map((r) => r.xml.includes("<NextAdvisory>"))).toEqual(end === "final" ? [false, false, true] : [false, false, false, false]);
      if (end === "cancel") expect(result.reports[3].xml).toContain("<InfoType>取消</InfoType>");
      let state = eewState();
      result.reports.forEach((report, i) => {
        const step = reduceEewUnit(state, { kind: "receive", material: decode(report.xml, "VXSE45"), clock: clock(report.xml) });
        expect(step.decisions[0].decision).toBe("changed");
        const last = i === result.reports.length - 1;
        expect(step.state.current.some((c) => c.eventId === result.eventId)).toBe(!last);
        state = step.state;
      });
    }
  });

  // P3-RW2-T13 contractBoundary (AC07・AC08)
  it("rejects values outside the contract with a closed reason", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const table: [string, Record<string, unknown>, string | null][] = [
      ["VXSE45", { magnitude: 9.9 }, null], ["VXSE45", { magnitude: 10.0 }, "magnitudeOutOfRange"],
      ["VXSE45", { depthKm: 700 }, null], ["VXSE45", { depthKm: 701 }, "depthOutOfRange"],
      ["VXSE45", { lat: 90.1 }, "coordinateOutOfRange"], ["VXSE45", { lon: -0.1 }, "coordinateOutOfRange"],
      ["VXSE45", { originTime: soon }, "originTimeInvalid"], ["VXSE45", { placeCode: "000" }, "placeUnknown"],
      ["VXSE45", { serial: 0 }, "serialOutOfRange"], ["VXSE45", { reports: 61 }, "reportsOutOfRange"], ["VXSE45", { end: "later" }, "endInvalid"],
      ["VXSE43", { maxInt: "4" }, "intensityOutOfRange"], ["VXSE51", { maxInt: "2" }, "intensityOutOfRange"],
      ["VXSE51", { lat: 34.8 }, "fieldNotInFamily"], ["VTSE41", { serial: 1 }, "fieldNotInFamily"],
      ["VXSE53", { cancel: true }, "cancelTemplateMissing"], ["VXSE45", { cancel: true, magnitude: 6.5 }, "cancelWithContent"],
      ["VXSE61", {}, "unknownFamily"], ["VXSE45", { originTime: "2026-02-30T00:00:00+09:00" }, "originTimeInvalid"], ["VXSE45", { cancel: "true" }, "fieldNotInFamily"], ["VXSE45", { cancel: null }, "fieldNotInFamily"], ["VXSE53", { maxInt: undefined }, "missingField"],
      ["VXSE45", { serial: 998, reports: 2, end: "cancel" }, "serialOutOfRange"], ["VXSE53", { areaCode: "999" }, "areaUnknown"],
    ];
    for (const [family, patch, reason] of table) {
      const input: Record<string, unknown> = family === "VXSE61" ? { family } : { ...valid(family), ...patch };
      // 取消の入力は中身を持たない。cancelWithContent の行（震源の欄を添える）だけが magnitude を残す。
      if (patch.cancel === true) for (const key of ["placeCode", "lat", "lon", "depthKm", "magnitude", "maxInt", "areaCode"]) if (key !== Object.keys(patch)[1]) delete input[key];
      const result = gen(input);
      expect([family, JSON.stringify(patch), result.kind === "rejected" ? result.reason : null]).toEqual([family, JSON.stringify(patch), reason]);
    }
    expect(choices("VXSE45").areas).toHaveLength(44);
  });

  // P3-RW2-T16 acceptance (AC10・AC11・D-CANCEL)
  it("cancels each of the five families that have a public cancel template", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const family of ["VXSE43", "VXSE45", "VXSE51", "VTSE41", "VTSE51"] as const) {
        const start = Date.now();
        vi.setSystemTime(start);
        const normal = made(valid(family));
        vi.setSystemTime(start + 5000); // 取消は後の送信（新旧は Control/DateTime で決まる）
        const cancel = made({ family, originTime: ORIGIN, cancel: true, ...(["VXSE51", "VTSE41"].includes(family) ? {} : { serial: 2 }) });
        expect(cancel.eventId).toBe(normal.eventId);
        const at = (xml: string) => clock(xml);
        if (family === "VXSE43" || family === "VXSE45") {
          const first = reduceEewUnit(eewState(), { kind: "receive", material: decode(normal.reports[0].xml, family), clock: at(normal.reports[0].xml) });
          expect(first.decisions[0].decision).toBe("changed");
          const after = reduceEewUnit(first.state, { kind: "receive", material: decode(cancel.reports[0].xml, family), clock: at(cancel.reports[0].xml) });
          expect(after.decisions[0].decision).toBe("changed");
          expect(after.state.current.some((c) => c.eventId === normal.eventId)).toBe(false);
        } else if (family === "VXSE51") {
          const first = reduceSeismicUnit(seismicEmpty(), { kind: "receive", material: decode(normal.reports[0].xml, family), clock: at(normal.reports[0].xml) });
          expect(first.decisions[0].decision).toBe("changed");
          const after = reduceSeismicUnit(first.state, { kind: "receive", material: decode(cancel.reports[0].xml, family), clock: at(cancel.reports[0].xml) });
          expect(after.decisions[0].decision).toBe("changed");
          const event = after.state.earthquakes.find((e) => e.eventId === normal.eventId)!;
          expect(event.contributions.every((c) => c.effective === "cancelled")).toBe(true);
          expect(event.cancelledSummary).toBeDefined();
          expect(toSeismicView(after.state).earthquakes.some((e) => e.eventId === normal.eventId)).toBe(true); // 取り消した地震は一覧に残る
        } else {
          const first = reduceTsunamiUnit(tsunamiEmpty(), { kind: "receive", material: decode(normal.reports[0].xml, family), clock: at(normal.reports[0].xml) });
          expect(first.decisions[0].decision).toBe("changed");
          const after = reduceTsunamiUnit(first.state, { kind: "receive", material: decode(cancel.reports[0].xml, family), clock: at(cancel.reports[0].xml) });
          expect(after.decisions[0].decision).toBe("changed");
          if (family === "VTSE41") {
            const record = after.state.forecasts.find((f) => f.eventId === normal.eventId)!;
            expect([record.effective, record.areas]).toEqual(["cancelled", []]);
          } else {
            const record = after.state.observations.find((o) => o.eventId === normal.eventId)!;
            expect([record.effective, record.stations, record.estimations]).toEqual(["cancelled", [], []]);
          }
        }
      }
    } finally { vi.useRealTimers(); }
  });
});
