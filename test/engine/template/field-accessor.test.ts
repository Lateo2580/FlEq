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
});
