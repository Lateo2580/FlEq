import { describe, expect, it } from "vitest";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { getFieldValue } from "../../../src/engine/template/field-accessor";

function asEvent(value: unknown): PresentationEvent {
  return value as PresentationEvent;
}

describe("getFieldValue", () => {
  it("先頭セグメントが raw のとき undefined を返す (二重防御)", () => {
    expect(getFieldValue(asEvent({ raw: { title: "raw event" } }), ["raw"])).toBeUndefined();
  });

  it("単一セグメントで値を取得する", () => {
    expect(getFieldValue(asEvent({ title: "earthquake" }), ["title"])).toBe("earthquake");
  });

  it("ネストしたパスで値を取得する", () => {
    const event = asEvent({ earthquake: { magnitude: 6.5 } });

    expect(getFieldValue(event, ["earthquake", "magnitude"])).toBe(6.5);
  });

  it.each([null, undefined])("途中の値が %s のとき undefined を返す", (value) => {
    const event = asEvent({ earthquake: value });

    expect(getFieldValue(event, ["earthquake", "magnitude"])).toBeUndefined();
  });

  it.each(["earthquake", 42])("途中の値が非オブジェクト (%s) のとき undefined を返す", (value) => {
    const event = asEvent({ earthquake: value });

    expect(getFieldValue(event, ["earthquake", "magnitude"])).toBeUndefined();
  });

  it("存在しないキーは undefined を返す", () => {
    expect(getFieldValue(asEvent({ title: "earthquake" }), ["missing"])).toBeUndefined();
  });

  it("additive な magnitudeLabel/depthLabel は canonical を優先し旧変数を変えない", () => {
    const event = asEvent({
      magnitude: "5.0",
      depth: "600km",
      magnitudeValue: {
        raw: "NaN", condition: "不明", description: null, presence: "unknown",
      },
      depthValue: {
        raw: "600", condition: "以上", description: "深さ600km以上", presence: "range",
        lowerBound: 600, upperBound: null,
      },
    });
    expect(getFieldValue(event, ["magnitude"])).toBe("5.0");
    expect(getFieldValue(event, ["magnitudeLabel"])).toBe("M不明");
    expect(getFieldValue(event, ["depthLabel"])).toBe("600km以上");
  });
});
