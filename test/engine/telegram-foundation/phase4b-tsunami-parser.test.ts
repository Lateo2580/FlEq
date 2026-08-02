import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import { parseTsunamiTelegram } from "../../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  readFixture,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
} from "../../helpers/mock-message";

describe("Phase 4B 津波 parser contract", () => {
  it("VTSE41 fixture の Area/Kind code と巨大・高い・不明を semantic value で保持する", () => {
    const result = parseTsunamiTelegram(createMockWsDataMessage(FIXTURE_VTSE41_WARN));
    expect(result).not.toBeNull();

    const iwate = result!.forecast?.find((item) => item.areaName === "岩手県");
    expect(iwate).toMatchObject({
      areaCode: "210",
      kindCode: "53",
      kindName: "大津波警報：発表",
      maxHeightDescription: "巨大",
    });
    expect(iwate?.maxHeight).toMatchObject({
      raw: "NaN",
      value: null,
      condition: "不明",
      description: "巨大",
      presence: "qualitative",
    });
    expect(iwate?.maxHeight?.value).not.toBe(0);

    const hokkaido = result!.forecast?.find(
      (item) => item.areaName === "北海道太平洋沿岸中部",
    );
    expect(hokkaido).toMatchObject({
      areaCode: "101",
      kindCode: "51",
      maxHeightDescription: "高い",
    });
    expect(hokkaido?.maxHeight).toMatchObject({
      raw: "NaN",
      value: null,
      presence: "qualitative",
      description: "高い",
    });
    expect(hokkaido?.maxHeight?.value).not.toBe(0);

    const unknown = result!.forecast?.find((item) => item.areaCode === "100");
    expect(unknown).toMatchObject({
      areaCode: "100",
      kindCode: "62",
      maxHeightDescription: "",
    });
    expect(unknown?.maxHeight).toMatchObject({
      raw: "NaN",
      value: null,
      presence: "unknown",
      description: "",
    });
    expect(unknown?.maxHeight?.value).not.toBe(0);
    expect(result!.diagnostics).toBeUndefined();
  });

  it.each([
    ["32-39_11_11_250206_VTSE41.xml", "１０ｍ超", 10, null, "岩手県"],
    ["32-39_11_09_250206_VTSE41.xml", "０．２ｍ未満", null, 0.2, "大分県豊後水道沿岸"],
  ] as const)(
    "VTSE41 fixture の %s は From/To 相当の range として保持する",
    (fixture, description, lowerBound, upperBound, areaName) => {
      const result = parseTsunamiTelegram(createMockWsDataMessage(fixture));
      const item = result?.forecast?.find((candidate) => candidate.areaName === areaName);
      expect(item).toMatchObject({ maxHeightDescription: description });
      expect(item?.maxHeight).toMatchObject({
        raw: lowerBound == null ? "0.2" : "10",
        value: null,
        presence: "range",
        lowerBound,
        upperBound,
        description,
      });
    },
  );

  it("VTSE51 fixture の実測値と観測中を同じ TsunamiHeight extractor で保持する", () => {
    const result = parseTsunamiTelegram(
      createMockWsDataMessage(FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT),
    );
    expect(result).not.toBeNull();

    const kamaishi = result!.observations?.find((station) => station.name === "釜石");
    expect(kamaishi).toMatchObject({
      areaCode: "210",
      stationCode: "21003",
      maxHeightValue: "３．２ｍ",
      maxHeightValueCondition: "上昇中",
    });
    expect(kamaishi?.maxHeight).toMatchObject({
      raw: "3.2",
      value: 3.2,
      condition: "上昇中",
      description: "３．２ｍ",
      presence: "value",
    });

    const ofunato = result!.observations?.find((station) => station.name === "大船渡");
    expect(ofunato).toMatchObject({
      maxHeightValue: null,
      maxHeightValueCondition: "",
    });
    expect(ofunato?.maxHeight).toMatchObject({
      raw: "",
      value: null,
      condition: "観測中",
      presence: "qualitative",
    });
    expect(ofunato?.maxHeight?.value).not.toBe(0);
  });

  it("VTSE52 fixture の沖合実測値と観測中を保持する", () => {
    const result = parseTsunamiTelegram(
      createMockWsDataMessage("61_11_02_250206_VTSE52.xml"),
    );
    const observed = result?.observations?.find(
      (station) => station.name === "岩手沖９０ｋｍＡ",
    );
    expect(observed).toMatchObject({
      stationCode: "21050",
      maxHeightValue: "０．５ｍ",
      maxHeightValueCondition: "上昇中",
    });
    expect(observed?.maxHeight).toMatchObject({
      raw: "0.5",
      value: 0.5,
      condition: "上昇中",
      presence: "value",
    });

    const observing = result?.observations?.find(
      (station) => station.name === "岩手釜石沖",
    );
    expect(observing?.maxHeight).toMatchObject({
      raw: "",
      value: null,
      condition: "観測中",
      presence: "qualitative",
    });
    expect(observing?.maxHeight?.value).not.toBe(0);
  });

  it("TsunamiHeight の空要素と From/To range を raw と bounds のまま分類する", () => {
    expect(extractSpecialValue("TsunamiHeight", {})).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: null,
      presence: "empty",
    });
    expect(extractSpecialValue("TsunamiHeight", {
      From: "1",
      To: "3",
    })).toMatchObject({
      raw: "",
      value: null,
      presence: "range",
      lowerBound: 1,
      upperBound: 3,
      rawLowerBound: "1",
      rawUpperBound: "3",
    });
  });

  it("unknown code は名称から推定せず raw と diagnostics を保持する", () => {
    const unknownAreaXml = readFixture(FIXTURE_VTSE41_WARN).replace(
      "<Area><Name>岩手県</Name><Code>210</Code></Area>",
      "<Area><Name>岩手県</Name><Code>999</Code></Area>",
    );
    const unknownArea = parseTsunamiTelegram(
      createMockWsDataMessageFromXml(unknownAreaXml, "VTSE41"),
    );
    const areaItem = unknownArea?.forecast?.find((item) => item.areaName === "岩手県");
    expect(areaItem).toMatchObject({
      areaCode: "999",
      diagnostics: ["unknownTsunamiAreaCode"],
    });
    expect(unknownArea?.diagnostics).toContain("unknownTsunamiAreaCode");

    const unknownKindXml = readFixture(FIXTURE_VTSE41_WARN).replace(
      "<Kind><Name>大津波警報：発表</Name><Code>53</Code></Kind>",
      "<Kind><Name>大津波警報：発表</Name><Code>999</Code></Kind>",
    );
    const unknownKind = parseTsunamiTelegram(
      createMockWsDataMessageFromXml(unknownKindXml, "VTSE41"),
    );
    const kindItem = unknownKind?.forecast?.find((item) => item.areaName === "岩手県");
    expect(kindItem).toMatchObject({
      areaCode: "210",
      kindCode: "999",
      diagnostics: ["unknownTsunamiKindCode"],
    });
    expect(unknownKind?.diagnostics).toContain("unknownTsunamiKindCode");

    const missingAreaCodeXml = readFixture(FIXTURE_VTSE41_WARN).replace(
      "<Area><Name>岩手県</Name><Code>210</Code></Area>",
      "<Area><Name>岩手県</Name><Code></Code></Area>",
    );
    const missingAreaCode = parseTsunamiTelegram(
      createMockWsDataMessageFromXml(missingAreaCodeXml, "VTSE41"),
    );
    const missingItem = missingAreaCode?.forecast?.find((item) => item.areaName === "岩手県");
    expect(missingItem).toMatchObject({
      areaCode: null,
      diagnostics: ["unknownTsunamiAreaCode"],
    });
    expect(missingAreaCode?.diagnostics).toContain("unknownTsunamiAreaCode");
  });

  it("Area/Kind code の前後空白を shadow XML から raw のまま保持して診断する", () => {
    const xml = readFixture(FIXTURE_VTSE41_WARN)
      .replace(
        "<Area><Name>岩手県</Name><Code>210</Code></Area>",
        "<Area><Name>岩手県</Name><Code> 210 </Code></Area>",
      )
      .replace(
        "<Kind><Name>大津波警報：発表</Name><Code>53</Code></Kind>",
        "<Kind><Name>大津波警報：発表</Name><Code> 53 </Code></Kind>",
      );
    const result = parseTsunamiTelegram(
      createMockWsDataMessageFromXml(xml, "VTSE41"),
    );
    const item = result?.forecast?.find((candidate) => candidate.areaName === "岩手県");
    expect(item).toMatchObject({
      areaCode: " 210 ",
      kindCode: " 53 ",
      diagnostics: ["unknownTsunamiAreaCode", "unknownTsunamiKindCode"],
    });
  });

  it("予報 height の canonical description は raw を保ち legacy scalar だけ trim する", () => {
    const source = readFixture(FIXTURE_VTSE41_WARN);
    const xml = source.replace('description="巨大"', 'description="  巨大  "');
    expect(xml).not.toBe(source);
    const result = parseTsunamiTelegram(
      createMockWsDataMessageFromXml(xml, "VTSE41"),
    );
    const item = result?.forecast?.find((candidate) => candidate.areaName === "岩手県");
    expect(item?.maxHeight).toMatchObject({
      description: "  巨大  ",
      presence: "qualitative",
    });
    expect(item?.maxHeightDescription).toBe("巨大");
  });

  it.each([
    ["", null, "qualitative"],
    ["3.2", 3.2, "value"],
  ] as const)(
    "実 XML の TsunamiHeight=%j と親 Condition=観測中を同じ semantic value に統合する",
    (rawHeight, value, presence) => {
      const source = readFixture(FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT);
      const heightXml = rawHeight === ""
        ? '<jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m" />'
        : `<jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m">${rawHeight}</jmx_eb:TsunamiHeight>`;
      const xml = source.replace(
        "<Condition>観測中</Condition>\n\t\t\t\t\t</MaxHeight>",
        `<Condition>観測中</Condition>\n\t\t\t\t\t\t${heightXml}\n\t\t\t\t\t</MaxHeight>`,
      );
      expect(xml).not.toBe(source);
      const result = parseTsunamiTelegram(
        createMockWsDataMessageFromXml(xml, "VTSE51"),
      );
      const station = result?.observations?.find(
        (candidate) => candidate.name === "大船渡",
      );
      expect(station?.maxHeight).toMatchObject({
        raw: rawHeight,
        value,
        condition: "観測中",
        presence,
      });
    },
  );
});
