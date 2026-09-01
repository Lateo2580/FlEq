import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedTyphoonProbability, TyphoonProbRegion } from "../../../src/types";
import { parseTyphoonProbability } from "../../../src/dmdata/typhoon-probability-parser";
import {
  canonicalizeVptaInfoType,
  normalizeVpta50Serial,
  projectTyphoonProbability,
  validateTyphoonProbabilityEventId,
  type TyphoonProbabilityCandidateClassification,
} from "../../../src/engine/display/project-typhoon-probability";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../../helpers/mock-message";

const EXPECTATIONS = JSON.parse(readFileSync(resolve(
  __dirname,
  "../../fixtures/typhoon-probability-card/expectations.json",
), "utf8")) as {
  eventId: string;
  slotCount: number;
  slotDuration: string;
  baseTimeMs: number;
  forecastEndsAtMs: number;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: Array<{ prefectureCode: string; prefectureName: string; fiveDayProbability: number }>;
  worstArea: {
    areaCode: string; areaName: string; prefectureCode: string; prefectureName: string;
    fiveDayProbability: number; peakAtMs: number;
  };
};

function parsedFixture(fixture = FIXTURE_VPTA50_DAMREY): ParsedTyphoonProbability {
  const parsed = parseTyphoonProbability(createMockWsDataMessage(fixture));
  if (parsed == null || parsed.baseTime == null) throw new Error("VPTA fixture did not parse");
  return parsed;
}

function project(
  parsed: ParsedTyphoonProbability,
): TyphoonProbabilityCandidateClassification {
  return projectTyphoonProbability(parsed, "発表", Date.parse(parsed.baseTime!) + 1);
}

function activeCandidate(parsed: ParsedTyphoonProbability) {
  const classification = project(parsed);
  expect(classification.result.kind).toBe("active");
  if (classification.result.kind !== "active") throw new Error("expected active candidate");
  return classification.result.candidate;
}

describe("projectTyphoonProbability", () => {
  it("canonicalizes serial and EventID boundaries without trimming invalid serials", () => {
    expect(normalizeVpta50Serial(null)).toEqual({ kind: "missing" });
    expect(normalizeVpta50Serial("")).toEqual({ kind: "missing" });
    expect(normalizeVpta50Serial("01")).toEqual({
      kind: "numeric", numeric: 1, canonicalRaw: "1",
    });
    expect(normalizeVpta50Serial("1")).toEqual({
      kind: "numeric", numeric: 1, canonicalRaw: "1",
    });
    for (const invalid of [" 1", "+1", "1.0", "x", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(normalizeVpta50Serial(invalid), invalid).toEqual({ kind: "invalid" });
    }
    expect(validateTyphoonProbabilityEventId(` ${"x".repeat(128)} `))
      .toBe("x".repeat(128));
    expect(validateTyphoonProbabilityEventId("x".repeat(129))).toBeNull();
  });

  it("requires one byte-identical canonical InfoType across envelope and decoded XML", () => {
    const meta = createTelegramMeta({
      messageId: "vpta-info-type", eventId: "TC2606", type: "VPTA50",
      reportDateTime: "2026-08-31T00:00:00Z", serial: "1", infoType: "発表",
      receivedAtMs: Date.parse("2026-08-31T00:00:01Z"), status: "通常", isTest: false,
    });
    expect(canonicalizeVptaInfoType(meta, "発表")).toEqual({
      kind: "canonical", value: "発表",
    });
    expect(canonicalizeVptaInfoType(meta, "取消")).toEqual({
      kind: "invalid", reason: "infoTypeMismatch",
    });
    expect(canonicalizeVptaInfoType({
      ...meta,
      infoType: { raw: " 発表", value: "発表", valid: true },
    }, "発表")).toEqual({ kind: "invalid", reason: "invalidRevision" });
  });

  it("projects the real 40-slot fixture into the fixed compact literal", () => {
    const parsed = parsedFixture();
    const candidate = activeCandidate(parsed);
    expect(parsed.timeDefines).toHaveLength(EXPECTATIONS.slotCount);
    expect(parsed.timeDefines.every((slot) => slot.duration === EXPECTATIONS.slotDuration)).toBe(true);
    expect(parsed.regions.every((region) => region.series40.length === EXPECTATIONS.slotCount)).toBe(true);
    expect(candidate).toMatchObject({
      eventId: EXPECTATIONS.eventId,
      baseTimeMs: EXPECTATIONS.baseTimeMs,
      expiresAtMs: EXPECTATIONS.forecastEndsAtMs,
      maxFiveDayProbability: EXPECTATIONS.maxFiveDayProbability,
      activePrefectureCount: EXPECTATIONS.activePrefectureCount,
      topPrefectures: EXPECTATIONS.topPrefectures,
      worstArea: EXPECTATIONS.worstArea,
    });
    expect(JSON.stringify(candidate)).not.toContain("timeDefines");
    expect(JSON.stringify(candidate)).not.toContain("series40");
    expect(JSON.stringify(candidate)).not.toContain("regions");
  });

  it("keeps parser duplicate evidence after Map merging and refuses both active and zero projection", () => {
    const xml = readFileSync(resolve(
      __dirname,
      "../../fixtures/typhoon-probability-card/synthetic_VPTA50_duplicate_area.xml",
    ), "utf8");
    const parsed = parseTyphoonProbability(createMockWsDataMessageFromXml(xml, "VPTA50"));
    expect(parsed).not.toBeNull();
    expect(parsed?.regions).toHaveLength(1);
    expect(parsed?.parserDiagnostics.duplicateCodes).toEqual(["130001"]);
    expect(projectTyphoonProbability(
      parsed!, "発表", Date.parse("2026-08-31T09:01:00+09:00"),
    ).result).toEqual({ kind: "nonProjectable", reason: "parserDuplicateDiagnostic" });
    parsed!.regions[0]!.daily = [0, 0, 0, 0, 0];
    parsed!.regions[0]!.series40 = [0];
    expect(projectTyphoonProbability(
      parsed!, "発表", Date.parse("2026-08-31T09:01:00+09:00"),
    ).result).toEqual({ kind: "nonProjectable", reason: "parserDuplicateDiagnostic" });
  });

  it("is independent of region input order", () => {
    const parsed = parsedFixture();
    const reversed = structuredClone(parsed);
    reversed.regions.reverse();
    expect(activeCandidate(reversed)).toEqual(activeCandidate(parsed));
  });

  it("accepts exactly 60 contiguous fixed slots and rejects 61 as compactOnly", () => {
    const parsed = parsedFixture();
    const baseTimeMs = Date.parse(parsed.baseTime!);
    parsed.timeDefines = Array.from({ length: 60 }, (_, index) => ({
      timeId: index + 1,
      dateTime: new Date(baseTimeMs + index * 2 * 60 * 60_000).toISOString(),
      duration: "PT2H",
    }));
    parsed.regions = [{
      ...parsed.regions[0]!,
      daily: [1, 2, 3, 4, 5],
      series40: Array.from({ length: 60 }, () => 1),
    }];
    parsed.fallback = "none";
    expect(project(parsed).result.kind).toBe("active");
    parsed.timeDefines.push({
      timeId: 61,
      dateTime: new Date(baseTimeMs + 120 * 60 * 60_000).toISOString(),
      duration: "PT1H",
    });
    parsed.regions[0]!.series40.push(1);
    parsed.fallback = "compactOnly";
    expect(project(parsed).result).toEqual({ kind: "nonProjectable", reason: "compactOnly" });
  });

  it("accepts a fixed one-day ISO duration at the per-slot boundary", () => {
    const parsed = parsedFixture();
    parsed.timeDefines = [{ timeId: 1, dateTime: parsed.baseTime!, duration: "P1D" }];
    parsed.regions = [{
      ...parsed.regions[0]!,
      daily: [1, 2, 3, 4, 5],
      series40: [5],
    }];
    parsed.fallback = "none";
    const candidate = activeCandidate(parsed);
    expect(candidate.expiresAtMs - candidate.baseTimeMs).toBe(24 * 60 * 60_000);
  });

  it("requires a fully valid grid before strict all-zero deactivation", () => {
    const zero = parsedFixture(FIXTURE_VPTA50_JANGMI_GONE);
    expect(project(zero).result).toEqual({ kind: "deactivateAllZero" });
    zero.regions[0]!.series40[0] = null;
    expect(project(zero).result).toEqual({ kind: "nonProjectable", reason: "noActiveProbability" });
  });

  it("classifies the forecast-end boundary as expired even for a strict all-zero grid", () => {
    const zero = parsedFixture(FIXTURE_VPTA50_JANGMI_GONE);
    const forecastEndsAt = Date.parse(zero.timeDefines.at(-1)!.dateTime)
      + 3 * 60 * 60_000;
    expect(projectTyphoonProbability(zero, "発表", forecastEndsAt).result)
      .toEqual({ kind: "expired" });
  });

  it.each([
    ["timezone-less base", (p: ParsedTyphoonProbability) => { p.baseTime = "2020-09-30T15:00:00"; }],
    ["non-ISO base", (p: ParsedTyphoonProbability) => { p.baseTime = "2020-09-30 15:00:00+09:00"; }],
    ["duplicate time id", (p: ParsedTyphoonProbability) => { p.timeDefines[1]!.timeId = 1; }],
    ["time id gap", (p: ParsedTyphoonProbability) => { p.timeDefines[1]!.timeId = 99; }],
    ["zero duration", (p: ParsedTyphoonProbability) => { p.timeDefines[0]!.duration = "PT0H"; }],
    ["fractional duration", (p: ParsedTyphoonProbability) => { p.timeDefines[0]!.duration = "PT0.5H"; }],
    ["calendar duration", (p: ParsedTyphoonProbability) => { p.timeDefines[0]!.duration = "P1M"; }],
    ["slot overlap", (p: ParsedTyphoonProbability) => { p.timeDefines[1]!.dateTime = p.timeDefines[0]!.dateTime; }],
    ["daily out of range", (p: ParsedTyphoonProbability) => { p.regions[0]!.daily[4] = 101; }],
    ["series mismatch", (p: ParsedTyphoonProbability) => { p.regions[0]!.series40.pop(); }],
    ["series fraction", (p: ParsedTyphoonProbability) => { p.regions[0]!.series40[0] = 0.5; }],
    ["parser duplicate evidence", (p: ParsedTyphoonProbability) => { p.parserDiagnostics.duplicateCodes = ["x"]; }],
    ["raw duplicate area", (p: ParsedTyphoonProbability) => { p.regions.push(structuredClone(p.regions[0]!)); }],
    ["prefecture identity conflict", (p: ParsedTyphoonProbability) => {
      const extra = structuredClone(p.regions[0]!);
      extra.areaCode += "-other";
      extra.prefName += "-other";
      p.regions.push(extra);
    }],
  ])("rejects invalid grid: %s", (_label, mutate) => {
    const parsed = parsedFixture();
    mutate(parsed);
    expect(project(parsed).result.kind).toBe("nonProjectable");
  });

  it("forces the series-worst sixth prefecture into the deterministic top five", () => {
    const parsed = parsedFixture();
    const baseRegion = parsed.regions[0]!;
    const region = (index: number): TyphoonProbRegion => ({
      ...structuredClone(baseRegion),
      areaCode: `A${index}`,
      areaName: `area-${index}`,
      prefCode: `P${index}`,
      prefName: `pref-${index}`,
      daily: [0, 0, 0, 0, 100],
      series40: [index === 6 ? 90 : 10],
    });
    parsed.timeDefines = [{
      timeId: 1,
      dateTime: parsed.baseTime!,
      duration: "PT3H",
    }];
    parsed.regions = [1, 2, 3, 4, 5, 6].map(region).reverse();
    parsed.fallback = "none";
    const candidate = activeCandidate(parsed);
    expect(candidate.topPrefectures.map((item) => item.prefectureCode))
      .toEqual(["P1", "P2", "P3", "P4", "P6"]);
    expect(candidate.worstArea).toMatchObject({ prefectureCode: "P6", peakAtMs: candidate.baseTimeMs });
  });
});
