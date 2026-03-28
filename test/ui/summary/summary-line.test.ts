import { describe, it, expect } from "vitest";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { renderSummaryLine } from "../../../src/ui/summary/summary-line";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T09:30:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false, isWarning: true,
    magnitude: "6.1", hypocenterName: "日向灘", maxInt: "6弱",
    serial: "3", eventId: "ev1",
    areaNames: [], forecastAreaNames: ["石川県能登"], municipalityNames: [],
    observationNames: [], areaCount: 0, forecastAreaCount: 1, municipalityCount: 0,
    observationCount: 0, areaItems: [], raw: null, ...overrides,
  };
}

describe("renderSummaryLine", () => {
  it("EEW PresentationEvent → severity, kind, maxInt が含まれる", () => {
    const event = makeEvent();
    const line = renderSummaryLine(event, 200);

    expect(line).toContain("[緊急]");
    expect(line).toContain("EEW警報");
    expect(line).toContain("震度6弱");
  });

  it("幅を制限した場合に低優先度トークンが除去される", () => {
    const event = makeEvent({
      forecastAreaNames: ["石川県能登", "富山県東部", "新潟県中越"],
    });

    const wideLine = renderSummaryLine(event, 200);
    const narrowLine = renderSummaryLine(event, 30);

    // 広い幅では全情報が出る
    expect(wideLine).toContain("[緊急]");
    expect(wideLine).toContain("EEW警報");

    // 狭い幅でも最低限の情報は残る
    expect(narrowLine).toContain("[緊急]");
    expect(narrowLine).toContain("EEW警報");

    // 狭い幅では低優先度トークンが除去されている（文字列が短い）
    expect(narrowLine.length).toBeLessThan(wideLine.length);
  });

  it("raw ドメイン → 'RAW' が含まれる", () => {
    const event = makeEvent({
      domain: "raw",
      classification: "telegram.weather",
      type: "VPZJ50",
      title: "気象情報",
      isWarning: undefined,
      isCancellation: false,
      frameLevel: "info",
      magnitude: null,
      hypocenterName: null,
      maxInt: null,
      serial: null,
      eventId: null,
      forecastAreaNames: [],
    });

    const line = renderSummaryLine(event, 200);
    expect(line).toContain("RAW");
  });
});
