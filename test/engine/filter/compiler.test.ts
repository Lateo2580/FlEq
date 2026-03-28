import { describe, it, expect } from "vitest";
import { compile } from "../../../src/engine/filter/compiler";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null, ...overrides,
  };
}

function compileFilter(source: string) {
  const ast = parse(tokenize(source), source);
  return compile(ast);
}

describe("compile", () => {
  it("= 完全一致", () => {
    const pred = compileFilter('domain = "eew"');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "earthquake" }))).toBe(false);
  });

  it("!= 不一致", () => {
    const pred = compileFilter('domain != "eew"');
    expect(pred(makeEvent({ domain: "earthquake" }))).toBe(true);
  });

  it(">= number", () => {
    const pred = compileFilter("magnitude >= 6.5");
    expect(pred(makeEvent({ magnitude: "7.3" }))).toBe(true);
    expect(pred(makeEvent({ magnitude: "5.0" }))).toBe(false);
  });

  it(">= enum:intensity", () => {
    const pred = compileFilter('maxInt >= "5-"');
    expect(pred(makeEvent({ maxInt: "6+" }))).toBe(true);
    expect(pred(makeEvent({ maxInt: "4" }))).toBe(false);
    expect(pred(makeEvent({ maxInt: "5-" }))).toBe(true);
  });

  it(">= enum:frameLevel", () => {
    const pred = compileFilter('frameLevel >= "warning"');
    expect(pred(makeEvent({ frameLevel: "critical" }))).toBe(true);
    expect(pred(makeEvent({ frameLevel: "info" }))).toBe(false);
  });

  it("~ regex マッチ", () => {
    const pred = compileFilter('hypocenterName ~ "能登|佐渡"');
    expect(pred(makeEvent({ hypocenterName: "石川県能登地方" }))).toBe(true);
    expect(pred(makeEvent({ hypocenterName: "日向灘" }))).toBe(false);
  });

  it("!~ regex 非マッチ", () => {
    const pred = compileFilter('hypocenterName !~ "能登"');
    expect(pred(makeEvent({ hypocenterName: "日向灘" }))).toBe(true);
  });

  it("in リスト", () => {
    const pred = compileFilter('domain in ["eew", "earthquake"]');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "tsunami" }))).toBe(false);
  });

  it("contains (配列)", () => {
    const pred = compileFilter('forecastAreaNames contains "石川県能登"');
    expect(pred(makeEvent({ forecastAreaNames: ["石川県能登", "新潟県上越"] }))).toBe(true);
    expect(pred(makeEvent({ forecastAreaNames: ["福岡県"] }))).toBe(false);
  });

  it("contains (文字列部分一致)", () => {
    const pred = compileFilter('title contains "警報"');
    expect(pred(makeEvent({ title: "緊急地震速報（警報）" }))).toBe(true);
    expect(pred(makeEvent({ title: "震度速報" }))).toBe(false);
  });

  it("and 結合", () => {
    const pred = compileFilter('domain = "eew" and isWarning = true');
    expect(pred(makeEvent({ domain: "eew", isWarning: true }))).toBe(true);
    expect(pred(makeEvent({ domain: "eew", isWarning: false }))).toBe(false);
  });

  it("or 結合", () => {
    const pred = compileFilter('domain = "eew" or domain = "earthquake"');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "tsunami" }))).toBe(false);
  });

  it("not 演算子", () => {
    const pred = compileFilter("not isTest");
    expect(pred(makeEvent({ isTest: false }))).toBe(true);
    expect(pred(makeEvent({ isTest: true }))).toBe(false);
  });

  it("truthy (boolean フィールド)", () => {
    const pred = compileFilter("isWarning");
    expect(pred(makeEvent({ isWarning: true }))).toBe(true);
    expect(pred(makeEvent({ isWarning: false }))).toBe(false);
  });

  it("null フィールドとの比較は false", () => {
    const pred = compileFilter('maxInt >= "4"');
    expect(pred(makeEvent({ maxInt: null }))).toBe(false);
    expect(pred(makeEvent({}))).toBe(false);
  });
});
