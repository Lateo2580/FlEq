import { describe, it, expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { buildTimeDefineMap, parseJmxEbElement } from "../../src/dmdata/timeseries-common";

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false,
  isArray: (n) => ["TimeDefine"].includes(n),
});

describe("buildTimeDefineMap", () => {
  it("timeId→name/dateTime/duration を解決", () => {
    const xml = parser.parse(
      `<TimeDefines><TimeDefine timeId="1"><DateTime>2024-08-29T00:00:00+09:00</DateTime><Duration>P1D</Duration><Name>２９日</Name></TimeDefine></TimeDefines>`,
    );
    const map = buildTimeDefineMap(xml.TimeDefines);
    expect(map.get("1")?.name).toBe("２９日");
    expect(map.get("1")?.dateTime).toBe("2024-08-29T00:00:00+09:00");
    expect(map.get("1")?.duration).toBe("P1D");
  });

  it("null/undefined 入力で空 Map を返す (guard カバレッジ)", () => {
    expect(buildTimeDefineMap(null).size).toBe(0);
    expect(buildTimeDefineMap(undefined).size).toBe(0);
  });

  it("TimeDefine が 0 件のときも空 Map を返す", () => {
    const xml = parser.parse(`<TimeDefines></TimeDefines>`);
    expect(buildTimeDefineMap(xml.TimeDefines).size).toBe(0);
  });
});

describe("parseJmxEbElement", () => {
  it("値あり: value/unit/refID/description を保持", () => {
    const xml = parser.parse(
      `<WindSpeed description="２２メートル" refID="2" type="最大風速" unit="m/s">22</WindSpeed>`,
    );
    const r = parseJmxEbElement(xml.WindSpeed);
    expect(r.value).toBe(22);
    expect(r.unit).toBe("m/s");
    expect(r.refID).toBe("2");
    expect(r.type).toBe("最大風速");
    expect(r.description).toBe("２２メートル");
    expect(r.condition).toBeNull();
  });

  it("condition=値なし: value=null・condition 保持", () => {
    const xml = parser.parse(
      `<WindSpeed condition="値なし" refID="1" type="最大風速" unit="m/s"></WindSpeed>`,
    );
    const r = parseJmxEbElement(xml.WindSpeed);
    expect(r.value).toBeNull();
    expect(r.condition).toBe("値なし");
  });

  it("condition=うねり + 値共存: value=6・condition=うねり", () => {
    const xml = parser.parse(
      `<WaveHeight description="６メートル　うねりを伴う" refID="2" type="波高" unit="m" condition="うねり">6</WaveHeight>`,
    );
    const r = parseJmxEbElement(xml.WaveHeight);
    expect(r.value).toBe(6);
    expect(r.condition).toBe("うねり");
  });

  it("value=0 を欠測扱いしない", () => {
    const xml = parser.parse(`<Precipitation refID="1" type="雨量" unit="mm">0</Precipitation>`);
    expect(parseJmxEbElement(xml.Precipitation).value).toBe(0);
  });
});
