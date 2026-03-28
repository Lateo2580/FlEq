import { describe, it, expect } from "vitest";
import { compileTemplate } from "../../../src/engine/template";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T09:30:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false, isWarning: true,
    magnitude: "6.1", hypocenterName: "日向灘", maxInt: "6弱",
    areaNames: [], forecastAreaNames: ["石川県能登"], municipalityNames: [],
    observationNames: [], areaCount: 0, forecastAreaCount: 1, municipalityCount: 0,
    observationCount: 0, areaItems: [], raw: null, ...overrides,
  };
}

describe("テンプレート統合テスト", () => {
  it("EEW 1行要約", () => {
    const render = compileTemplate(
      '{{#if isWarning}}[緊急]{{else}}[警告]{{/if}} {{title}} {{hypocenterName|default:"-"}} M{{magnitude|default:"-"}} 最大{{maxInt|default:"-"}}',
    );

    // 警報
    expect(render(makeEvent())).toBe(
      "[緊急] 緊急地震速報（警報） 日向灘 M6.1 最大6弱",
    );

    // 予報 (isWarning=false, 震源なし)
    expect(render(makeEvent({
      isWarning: false,
      title: "緊急地震速報（予報）",
      hypocenterName: null,
      magnitude: null,
      maxInt: null,
    }))).toBe(
      "[警告] 緊急地震速報（予報） - M- 最大-",
    );
  });

  it("地震テンプレート (震度なし)", () => {
    const render = compileTemplate(
      "{{title}} {{hypocenterName|default:\"不明\"}} M{{magnitude|default:\"?\"}} 最大震度{{maxInt|default:\"不明\"}}",
    );

    expect(render(makeEvent({
      domain: "earthquake",
      title: "震源に関する情報",
      hypocenterName: "能登半島沖",
      magnitude: "4.2",
      maxInt: null,
    }))).toBe("震源に関する情報 能登半島沖 M4.2 最大震度不明");
  });

  it("replace フィルタで文言短縮", () => {
    const render = compileTemplate(
      '{{title|replace:"緊急地震速報":"EEW"}}',
    );

    expect(render(makeEvent({ title: "緊急地震速報（警報）" }))).toBe("EEW（警報）");
  });
});
