import { describe, it, expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { extractObservation } from "../../src/dmdata/weather-explanation-observation";
import { dig } from "../../src/dmdata/telegram-parser";
import { readFileSync } from "fs";
import path from "path";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  isArray: (n) =>
    [
      "MeteorologicalInfos",
      "MeteorologicalInfo",
      "Item",
      "Kind",
      "TimeSeriesInfo",
      "TimeDefine",
      "Area",
    ].includes(n),
});

function loadFixture(rel: string): unknown {
  const xml = readFileSync(path.join(__dirname, "../fixtures", rel), "utf-8");
  const parsed = parser.parse(xml);
  return dig(dig(parsed, "Report"), "Body");
}

describe("extractObservation", () => {
  it("MeteorologicalInfos[type=観測実況] が無ければ null", () => {
    const body = loadFixture("synthetic/vpfj51_becoming_chain.xml");
    expect(extractObservation(body)).toBeNull();
  });

  it("パターン (i) TimeSeriesInfo 入れ子で propertyType 別に series を集約 (85_01_01 台風)", () => {
    const body = loadFixture("85_01_01_250630_VPFJ51.xml");
    const obs = extractObservation(body);
    expect(obs).not.toBeNull();
    const types = new Set(obs!.series.map((s) => s.propertyType));
    expect(types.has("雨の実況")).toBe(true);
    expect(types.has("風の実況")).toBe(true);
    const rainSeries = obs!.series.find(
      (s) => s.propertyType === "雨の実況" && s.partType === "PrecipitationPart",
    );
    expect(rainSeries).toBeDefined();
    expect(rainSeries!.stations.some((st) => st.stationName === "三宅島")).toBe(true);
    const station = rainSeries!.stations.find((st) => st.stationName === "三宅島")!;
    expect(station.measurements[0].remark).toBe("観測史上１位");
  });

  it("パターン (ii) MeteorologicalInfo 直下で同 propertyType×別 element を別 series に分離 (85(82)_02_04)", () => {
    const body = loadFixture("85(82)_02_04_260326_VPFJ51.xml");
    const obs = extractObservation(body);
    expect(obs).not.toBeNull();
    const snowSeries = obs!.series.filter((s) => s.propertyType === "雪の実況");
    const elements = new Set(snowSeries.map((s) => s.element));
    expect([...elements].some((e) => e?.includes("１２時間降雪量"))).toBe(true);
    expect([...elements].some((e) => e?.includes("積雪の深さ"))).toBe(true);
  });

  it("WindPart は WindDirection + WindSpeed の両 jmx_eb を measurements.values[] に含む (85_01_01)", () => {
    const body = loadFixture("85_01_01_250630_VPFJ51.xml");
    const obs = extractObservation(body);
    const windSeries = obs!.series.find(
      (s) => s.propertyType === "風の実況" && s.partType === "WindPart",
    );
    expect(windSeries).toBeDefined();
    const station = windSeries!.stations.find((st) => st.stationName === "三宅島")!;
    const subTypes = new Set(station.measurements.flatMap((m) => m.values.map((v) => v.subType)));
    expect(subTypes.has("風向")).toBe(true);
    expect(subTypes.has("最大瞬間風速")).toBe(true);
  });

  it("Station 無し Item の Text 解説/気象要素/補足が intro/element/supplement に振り分けられる", () => {
    const body = loadFixture("85(82)_02_04_260326_VPFJ51.xml");
    const obs = extractObservation(body);
    const snowSeries = obs!.series.find(
      (s) => s.propertyType === "雪の実況" && s.element?.includes("１２時間降雪量"),
    );
    expect(snowSeries).toBeDefined();
    expect(snowSeries!.intro.some((t) => t.includes("１２時間降雪量"))).toBe(true);
  });

  it("Station 無し Text Item の element/intro が後続の Station 付き Part series に継承される", () => {
    const body = loadFixture("85(82)_02_04_260326_VPFJ51.xml");
    const obs = extractObservation(body);
    const series = obs!.series.find(
      (s) => s.propertyType === "雪の実況" && s.element?.includes("１２時間降雪量"),
    );
    expect(series).toBeDefined();
    expect(series!.element).toContain("１２時間降雪量");
    expect(series!.stations.some((st) => st.stationName === "大野市九頭竜")).toBe(true);
  });
});

describe("Station 重複統合 3 段 key", () => {
  const SYNTHETIC_STATION_KEY_XML = `
<MeteorologicalInfos type="観測実況">
  <MeteorologicalInfo>
    <DateTime>2026-06-06T09:00:00+09:00</DateTime>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">10</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name>X</Name><Code type="アメダス地点番号">57176</Code><Location>福井県</Location></Station></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">12</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name>Y</Name><Code type="アメダス地点番号">57176</Code><Location>福井県</Location></Station></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">5</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name>Z</Name><Code type="アメダス地点番号"></Code><Location>福井県</Location></Station></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">7</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name>Z</Name><Code type="アメダス地点番号"></Code><Location>福井県</Location></Station></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">1</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name></Name><Code type="アメダス地点番号"></Code><Location></Location></Station></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">2</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name></Name><Code type="アメダス地点番号"></Code><Location></Location></Station></Item>
  </MeteorologicalInfo>
</MeteorologicalInfos>`;

  it("code 一致は同一 station の measurements[] に統合", () => {
    const parsed = parser.parse(
      `<Body xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${SYNTHETIC_STATION_KEY_XML}</Body>`,
    );
    const obs = extractObservation(parsed.Body);
    const series = obs!.series.find((s) => s.partType === "SnowDepthPart");
    const stationByCode = series!.stations.find((st) => st.stationCode === "57176");
    expect(stationByCode).toBeDefined();
    expect(stationByCode!.measurements.length).toBe(2);
  });

  it("code 空 + name 同じは name|loc キーで統合", () => {
    const parsed = parser.parse(
      `<Body xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${SYNTHETIC_STATION_KEY_XML}</Body>`,
    );
    const obs = extractObservation(parsed.Body);
    const series = obs!.series.find((s) => s.partType === "SnowDepthPart");
    const stationByName = series!.stations.find((st) => st.stationName === "Z");
    expect(stationByName).toBeDefined();
    expect(stationByName!.measurements.length).toBe(2);
  });

  it("code/name 完全空は anon: で別エントリのまま (統合しない)", () => {
    const parsed = parser.parse(
      `<Body xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${SYNTHETIC_STATION_KEY_XML}</Body>`,
    );
    const obs = extractObservation(parsed.Body);
    const series = obs!.series.find((s) => s.partType === "SnowDepthPart");
    const anonStations = series!.stations.filter(
      (st) => st.stationCode === "" && st.stationName === "",
    );
    expect(anonStations.length).toBe(2);
  });
});

describe("pendingContext REPLACE/delete 規則", () => {
  it("Part 注入後の pendingContext は delete され、別 partType series に intro が漏れない", () => {
    // Item 1 (Station-less): Type=雨の実況, Text type=解説 "intro-A"
    // Item 2 (Station): Type=雨の実況, PrecipitationPart, Station "X"  → intro-A 継承、pending delete される
    // Item 3 (Station): Type=雨の実況, WindPart (別 partType), Station "Y"  → intro-A が漏れてはいけない
    // asserts:
    // - rain series (PrecipitationPart) の intro は ["intro-A"]  (Item 2 で消費)
    // - wind series (WindPart) の intro は []  (pending は delete 済み、再注入されない)
    // delete が消えると wind series.intro に intro-A が漏れて FAIL する真の検出テスト
    const xml = `
<MeteorologicalInfos type="観測実況">
  <MeteorologicalInfo>
    <DateTime>2026-06-06T09:00:00+09:00</DateTime>
    <Item><Kind><Property><Type>雨の実況</Type><Text type="解説">intro-A</Text></Property></Kind></Item>
    <Item><Kind><Property><Type>雨の実況</Type><PrecipitationPart><jmx_eb:Precipitation type="降水量" unit="mm">10</jmx_eb:Precipitation></PrecipitationPart></Property></Kind>
      <Station><Name>X</Name><Code type="アメダス地点番号">11111</Code><Location>東京</Location></Station></Item>
    <Item><Kind><Property><Type>雨の実況</Type><WindPart><jmx_eb:WindDirection type="風向" unit="８方位漢字">北</jmx_eb:WindDirection><jmx_eb:WindSpeed type="風速" unit="m/s">5</jmx_eb:WindSpeed></WindPart></Property></Kind>
      <Station><Name>Y</Name><Code type="アメダス地点番号">22222</Code><Location>東京</Location></Station></Item>
  </MeteorologicalInfo>
</MeteorologicalInfos>`;
    const parsed = parser.parse(
      `<Body xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${xml}</Body>`,
    );
    const obs = extractObservation(parsed.Body);
    const rain = obs!.series.find((s) => s.partType === "PrecipitationPart");
    const wind = obs!.series.find((s) => s.partType === "WindPart");
    expect(rain).toBeDefined();
    expect(wind).toBeDefined();
    expect(rain!.intro).toEqual(["intro-A"]);  // Item 2 で pending を消費
    expect(wind!.intro).toEqual([]);             // pending は delete 済み、再注入されない
    expect(rain!.stations.map((st) => st.stationName)).toEqual(["X"]);
    expect(wind!.stations.map((st) => st.stationName)).toEqual(["Y"]);
  });

  it("element 切替時に pendingContext は REPLACE される (前 element の intro/supplement が漏れない)", () => {
    // Item 1 (Station-less): Type=雪の実況, Text type=気象要素 "elementA", Text type=解説 "intro-A"
    // Item 2 (Station-less): Type=雪の実況, Text type=気象要素 "elementB", Text type=解説 "intro-B"  → REPLACE (intro-A 上書き)
    // Item 3 (Station): Type=雪の実況, SnowDepthPart, Station "Z"  → elementB の series に intro-B のみ継承
    // asserts:
    // - 雪の実況 series で elementB を持つ series が 1 件
    // - その series の intro は ["intro-B"] のみ ("intro-A" は混ざらない)
    const xml = `
<MeteorologicalInfos type="観測実況">
  <MeteorologicalInfo>
    <DateTime>2026-06-06T09:00:00+09:00</DateTime>
    <Item><Kind><Property><Type>雪の実況</Type><Text type="気象要素">elementA</Text><Text type="解説">intro-A</Text></Property></Kind></Item>
    <Item><Kind><Property><Type>雪の実況</Type><Text type="気象要素">elementB</Text><Text type="解説">intro-B</Text></Property></Kind></Item>
    <Item><Kind><Property><Type>雪の実況</Type><SnowDepthPart><jmx_eb:SnowDepth type="積雪深" unit="cm">15</jmx_eb:SnowDepth></SnowDepthPart></Property></Kind>
      <Station><Name>Z</Name><Code type="アメダス地点番号">33333</Code><Location>福井</Location></Station></Item>
  </MeteorologicalInfo>
</MeteorologicalInfos>`;
    const parsed = parser.parse(
      `<Body xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${xml}</Body>`,
    );
    const obs = extractObservation(parsed.Body);
    const snowB = obs!.series.find((s) => s.element === "elementB");
    expect(snowB).toBeDefined();
    expect(snowB!.intro).toEqual(["intro-B"]); // intro-A は混ざらない (REPLACE 効果)
    expect(snowB!.stations.map((st) => st.stationName)).toEqual(["Z"]);
    // elementA 用の series が無い (Part 無しで pending のみだったため series 化していない、これが正常)
    const snowA = obs!.series.find((s) => s.element === "elementA");
    expect(snowA).toBeUndefined();
  });
});
