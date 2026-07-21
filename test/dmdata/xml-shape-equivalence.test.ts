import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import { createJmxXmlParser } from "../../src/dmdata/xml-shape";

/**
 * xml-shape の `createJmxXmlParser` が、各系統パーサが従来個別生成していた
 * XMLParser と「実 fixture XML の parse 結果で deep-equal」であることを固定する安全網。
 *
 * とりわけ factory が明示追加した `parseAttributeValue: false` が、
 * 従来の未指定 (既定値 false 頼み) と出力を 1 バイトも変えないことを保証する。
 *
 * `isArray` の集合は各パーサの現行定義をそのまま写経している。集合を変えると
 * ここが割れる (= パーサ側の isArray 集合が動いていないことの検証にもなる)。
 */

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

/** 従来の基礎 4 設定 (parseAttributeValue は未指定 = 既定値 false 頼み) */
function legacyParser(isArray?: (name: string) => boolean): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    ...(isArray ? { isArray } : {}),
  });
}

const inSet =
  (tags: string[]): ((name: string) => boolean) =>
  (name) =>
    tags.includes(name);

/** 各系統: fixture + 現行 isArray predicate */
const cases: { system: string; fixture: string; isArray?: (name: string) => boolean }[] = [
  {
    system: "telegram",
    fixture: "32-35_01_03_100514_VXSE53.xml",
    isArray: inSet([
      "Pref",
      "Area",
      "City",
      "IntensityStation",
      "Item",
      "Kind",
      "Category",
      "ForecastInt",
      "Observation",
      "Station",
      "Estimation",
      "VolcanoInfo",
      "AshInfo",
      "WindAboveCraterElements",
    ]),
  },
  {
    system: "weather",
    fixture: "15_16_01_241031_VPWW56.xml",
    isArray: inSet(["Information", "Warning", "Item", "Kind", "Areas", "Area", "Text", "Office"]),
  },
  {
    system: "flood-forecast",
    fixture: "16_01_01_220728_VXKO50.xml",
    isArray: inSet([
      "Information",
      "Item",
      "Area",
      "Areas",
      "MeteorologicalInfos",
      "MeteorologicalInfo",
      "Warning",
      "Kind",
      "Property",
      "TimeSeriesInfo",
      "TimeDefine",
      "HydrometricStationPart",
      "ChargeSection",
      "FloodAssumptionPart",
      "Station",
      "jmx_eb:Precipitation",
      "jmx_eb:WaterLevel",
      "jmx_eb:Discharge",
      "jmx_eb:PrecipitationBasedIndex",
      "jmx_eb:FloodDepth",
    ]),
  },
  {
    system: "weather-warning-timeseries",
    fixture: "81_01_01_260129_VPWP50.xml",
    isArray: inSet([
      "MeteorologicalInfos",
      "TimeSeriesInfo",
      "TimeDefine",
      "Item",
      "Kind",
      "Property",
      "Areas",
      "Area",
      "Significancy",
      "Local",
      "jmx_eb:Precipitation",
      "jmx_eb:SnowfallDepth",
      "jmx_eb:Humidity",
      "jmx_eb:WindDirection",
      "jmx_eb:WindSpeed",
      "jmx_eb:WaveHeight",
      "jmx_eb:TidalLevel",
      "jmx_eb:Visibility",
      "PeakTime",
      "CriteriaPeriod",
    ]),
  },
  {
    system: "weather-explanation",
    fixture: "84_01_01_260129_VPCJ51.xml",
    isArray: inSet([
      "MeteorologicalInfos",
      "MeteorologicalInfo",
      "Item",
      "Kind",
      "Areas",
      "Area",
      "Text",
      "Information",
      "TimeSeriesInfo",
      "TimeDefine",
      "Local",
      "Sequence",
      "TidalLevelPart",
    ]),
  },
  {
    system: "weather-explanation (VMCJ53 潮位)",
    fixture: "87_01_01_250630_VMCJ53.xml",
    isArray: inSet([
      "MeteorologicalInfos",
      "MeteorologicalInfo",
      "Item",
      "Kind",
      "Areas",
      "Area",
      "Text",
      "Information",
      "TimeSeriesInfo",
      "TimeDefine",
      "Local",
      "Sequence",
      "TidalLevelPart",
    ]),
  },
  {
    system: "heat-alert",
    fixture: "57_03_01_240401_VPFT50.xml",
    // isArray なし (default () => false)
  },
];

describe("createJmxXmlParser の実 fixture 等価性", () => {
  for (const { system, fixture, isArray } of cases) {
    it(`${system}: 旧 config と factory の parse 結果が deep-equal`, () => {
      const xml = readFixture(fixture);
      const legacy = legacyParser(isArray).parse(xml);
      const factory = createJmxXmlParser(isArray).parse(xml);
      expect(factory).toStrictEqual(legacy);
    });
  }
});
