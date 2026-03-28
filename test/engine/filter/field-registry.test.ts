import { describe, it, expect } from "vitest";
import { resolveField, FILTER_FIELDS } from "../../../src/engine/filter/field-registry";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1",
    classification: "eew.forecast",
    domain: "eew",
    type: "VXSE43",
    infoType: "発表",
    title: "緊急地震速報（警報）",
    headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "critical",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: ["石川県能登"],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 1,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

describe("resolveField", () => {
  it("正式名でフィールドを取得", () => {
    const field = resolveField("domain");
    expect(field).not.toBeNull();
    expect(field!.kind).toBe("string");
  });

  it("エイリアスでフィールドを取得", () => {
    const field = resolveField("type");
    expect(field).not.toBeNull();
  });

  it("未知のフィールドは null", () => {
    expect(resolveField("nonExistent")).toBeNull();
  });
});

describe("field getters", () => {
  it("domain を取得", () => {
    const event = makeEvent({ domain: "eew" });
    const field = resolveField("domain")!;
    expect(field.get(event)).toBe("eew");
  });

  it("frameLevel を取得", () => {
    const event = makeEvent({ frameLevel: "critical" });
    const field = resolveField("frameLevel")!;
    expect(field.get(event)).toBe("critical");
  });

  it("maxInt を取得", () => {
    const event = makeEvent({ maxInt: "6+" });
    const field = resolveField("maxInt")!;
    expect(field.get(event)).toBe("6+");
  });

  it("magnitude (number型) を取得", () => {
    const event = makeEvent({ magnitude: "7.3" });
    const field = resolveField("magnitude")!;
    expect(field.get(event)).toBe(7.3);
  });

  it("isWarning (boolean型) を取得", () => {
    const event = makeEvent({ isWarning: true });
    const field = resolveField("isWarning")!;
    expect(field.get(event)).toBe(true);
  });

  it("forecastAreaNames (string[]型) を取得", () => {
    const event = makeEvent({ forecastAreaNames: ["石川県能登", "新潟県上越"] });
    const field = resolveField("forecastAreaNames")!;
    expect(field.get(event)).toEqual(["石川県能登", "新潟県上越"]);
  });

  it("volcanoName を取得", () => {
    const event = makeEvent({ volcanoName: "桜島" });
    const field = resolveField("volcanoName")!;
    expect(field.get(event)).toBe("桜島");
  });

  it("alertLevel (number型) を取得", () => {
    const event = makeEvent({ alertLevel: 3 });
    const field = resolveField("alertLevel")!;
    expect(field.get(event)).toBe(3);
  });

  it("depth (number型) を取得", () => {
    const event = makeEvent({ depth: "10km" });
    const field = resolveField("depth")!;
    expect(field.get(event)).toBe(10);
  });

  it("depth: 「ごく浅い」は null を返す", () => {
    const event = makeEvent({ depth: "ごく浅い" });
    const field = resolveField("depth")!;
    expect(field.get(event)).toBeNull();
  });

  it("depth: null は null を返す", () => {
    const event = makeEvent({ depth: null });
    const field = resolveField("depth")!;
    expect(field.get(event)).toBeNull();
  });

  it("tsunamiKinds (string[]型) を取得", () => {
    const event = makeEvent({ tsunamiKinds: ["津波警報", "津波注意報"] });
    const field = resolveField("tsunamiKinds")!;
    expect(field.get(event)).toEqual(["津波警報", "津波注意報"]);
  });
});
