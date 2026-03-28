import { describe, it, expect } from "vitest";
import { compileTemplateNodes } from "../../../src/engine/template/compiler";
import { parseTemplate } from "../../../src/engine/template/parser";
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

/** parseTemplate → compileTemplateNodes のショートカット */
function compile(template: string) {
  return compileTemplateNodes(parseTemplate(template));
}

describe("compileTemplateNodes", () => {
  it("テキストのみ", () => {
    const render = compile("hello world");
    expect(render(makeEvent())).toBe("hello world");
  });

  it("単純変数展開", () => {
    const render = compile("{{title}}");
    expect(render(makeEvent())).toBe("緊急地震速報（警報）");
  });

  it("複数変数 + テキスト混合", () => {
    const render = compile("{{title}} M{{magnitude}}");
    expect(render(makeEvent())).toBe("緊急地震速報（警報） M6.1");
  });

  it("default フィルタ (null → デフォルト値)", () => {
    const render = compile("{{hypocenterName|default:\"-\"}}");
    expect(render(makeEvent({ hypocenterName: null }))).toBe("-");
    expect(render(makeEvent({ hypocenterName: "日向灘" }))).toBe("日向灘");
  });

  it("if/else ブロック", () => {
    const render = compile("{{#if isWarning}}警報{{else}}予報{{/if}}");
    expect(render(makeEvent({ isWarning: true }))).toBe("警報");
    expect(render(makeEvent({ isWarning: false }))).toBe("予報");
  });

  it("未定義変数 → 空文字", () => {
    const render = compile("震源:{{depth}}");
    expect(render(makeEvent({ depth: undefined }))).toBe("震源:");
  });

  it("配列のデフォルト join", () => {
    const render = compile("{{forecastAreaNames}}");
    expect(render(makeEvent({ forecastAreaNames: ["石川県能登", "新潟県"] }))).toBe("石川県能登, 新潟県");
  });

  it("join フィルタでカスタム区切り", () => {
    const render = compile("{{forecastAreaNames|join:\"/\"}}");
    expect(render(makeEvent({ forecastAreaNames: ["石川県能登", "新潟県"] }))).toBe("石川県能登/新潟県");
  });

  it("upper フィルタ", () => {
    const render = compile("{{domain|upper}}");
    expect(render(makeEvent())).toBe("EEW");
  });
});
