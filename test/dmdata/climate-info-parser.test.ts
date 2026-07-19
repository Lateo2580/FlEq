import { describe, it, expect } from "vitest";
import { parseClimateInfo } from "../../src/dmdata/climate-info-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VPCI50_KANTO_TSUYU,
  FIXTURE_VPCI50_TOHOKU_TSUYU,
  FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE,
} from "../helpers/mock-message";

describe("parseClimateInfo - 全般天候情報 (VPZI50)", () => {
  it("基本フィールドが取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPZI50");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toContain("高温");
    expect(result!.title).toContain("少雨");
    expect(result!.controlTitle).toBe("全般天候情報");
    expect(result!.targetArea?.name).toBe("全国");
    expect(result!.targetArea?.code).toBe("010000");
    expect(result!.reportDateTime).toBe("2024-01-10T16:00:00+09:00");
  });

  it("Headline.Text が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    expect(result!.headline).not.toBeNull();
    expect(result!.headline!).toContain("東日本と西日本");
    expect(result!.headline!).toContain("農作物");
  });

  it("bodyTexts に概況 / 今後の見通し / 防災事項が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    const types = result!.bodyTexts.map((b) => b.textType);
    expect(types).toContain("概況");
    expect(types).toContain("今後の見通し");
    expect(types).toContain("防災事項");
    const overview = result!.bodyTexts.find((b) => b.textType === "概況");
    expect(overview!.text).toContain("移動性の高気圧");
  });

  it("bodyTexts の areas に東日本・西日本が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    const overview = result!.bodyTexts.find((b) => b.textType === "概況");
    const areaNames = overview!.areas.map((a) => a.name);
    expect(areaNames).toContain("東日本");
    expect(areaNames).toContain("西日本");
  });

  it("stations に観測点 7 地点 (東京〜鹿児島) の気候値が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    const names = result!.stations.map((s) => s.stationName);
    expect(names).toEqual([
      "東京",
      "名古屋",
      "大阪",
      "広島",
      "高松",
      "福岡",
      "鹿児島",
    ]);
    // 「表題」だけの Item は stations に入らない (ClimateValuesPart が無いため)
    expect(result!.stations.length).toBe(7);
  });

  it("東京の平均気温・降水量と平年差/比が正しく抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    const tokyo = result!.stations.find((s) => s.stationName === "東京");
    expect(tokyo).toBeDefined();
    expect(tokyo!.stationCode).toBe("47662");
    expect(tokyo!.temperatureCelsius).toBe(9.2);
    expect(tokyo!.temperatureAnomalyCelsius).toBe(1.6);
    expect(tokyo!.precipitationMm).toBe(19.5);
    expect(tokyo!.precipitationAnomalyPercent).toBe(23);
  });

  it("観測点には期間ラベルが付与される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    const tokyo = result!.stations.find((s) => s.stationName === "東京");
    expect(tokyo!.periodLabel).toContain("１１月２６日");
  });

  it("Body.Comment.Text type=末文 が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    expect(result!.comment).not.toBeNull();
    expect(result!.comment!).toContain("今後の気象情報");
  });

  it("メタ情報 (EventID / publishingOffice / editorialOffice) が取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    expect(result!.eventId).toContain("全般天候情報");
    expect(result!.editorialOffice).toBe("気象庁本庁");
    // 通常は xmlReport.control.publishingOffice 経由で「気象庁」が来る
    expect(result!.publishingOffice).toBeTruthy();
  });
});

describe("parseClimateInfo - 地方天候情報 (VPCI50)", () => {
  it("VPCI50 の基本フィールドが取得される (VPZI50 と構造互換)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU);
    const result = parseClimateInfo(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPCI50");
    expect(result!.infoType).toBe("発表");
    expect(result!.controlTitle).toBe("地方天候情報");
    expect(result!.title).toContain("梅雨");
    expect(result!.targetArea?.name).toBe("関東甲信地方");
    expect(result!.targetArea?.code).toBe("10300");
    expect(result!.headline).toContain("梅雨明け");
    expect(result!.bodyTexts.length).toBeGreaterThan(0);
  });

  it("VPCI50 の EventDatePart (梅雨明け) が seasonEvents として抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU);
    const result = parseClimateInfo(msg);
    expect(result!.seasonEvents.length).toBe(1);
    const ev = result!.seasonEvents[0];
    expect(ev.eventType).toBe("梅雨明け");
    expect(ev.dateDescription).toBe("７月１９日ごろ");
    expect(ev.dateDubious).toBe("頃");
    expect(ev.normalDescription).toBe("７月２０日ごろ");
    expect(ev.lastYearDescription).toBe("８月１日ごろ");
    expect(ev.areas[0].name).toBe("関東甲信地方");
  });

  it("Date が無い EventDatePart (梅雨明け発表なし) では dateDescription が null", () => {
    // 30_03 fixture: 東北南部/北部とも梅雨明け非発表 → Date 欠落、Normal/LastYear のみ
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE);
    const result = parseClimateInfo(msg);
    expect(result!.seasonEvents.length).toBe(2);
    const north = result!.seasonEvents.find(
      (ev) => ev.areas[0]?.name === "東北北部",
    );
    expect(north).toBeDefined();
    expect(north!.eventType).toBe("梅雨明け");
    expect(north!.dateDescription).toBeNull();
    expect(north!.dateDubious).toBeNull();
    expect(north!.normalDescription).toBe("７月２７日ごろ");
    expect(north!.lastYearDescription).toBe("８月５日ごろ");
  });

  it("EventDatePart が無い VPZI50 では seasonEvents は空配列", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg);
    expect(result!.seasonEvents).toEqual([]);
  });
});

describe("parseClimateInfo - 平年値ペア (type 違い兄弟要素)", () => {
  // 30_02: ClimateValuesPart type="総降水量と平年値" 内に jmx_eb:Precipitation が
  // 2 兄弟 (type="降水量" 実測 / type="降水量日別平滑平年値合計" 平年値) で入る。
  // 旧実装は dig() が配列を返して nodeText が空になり全フィールド null だった。
  it("30_02: 青森の降水量 (実測) と平年値が両方抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU);
    const result = parseClimateInfo(msg)!;
    const aomori = result.stations.find((s) => s.stationName === "青森");
    expect(aomori).toBeDefined();
    expect(aomori!.precipitationMm).toBe(132.5);
    expect(aomori!.precipitationNormalMm).toBe(153.0);
  });

  it("30_02: 秋田の降水量 (実測) と平年値が両方抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU);
    const result = parseClimateInfo(msg)!;
    const akita = result.stations.find((s) => s.stationName === "秋田");
    expect(akita).toBeDefined();
    expect(akita!.precipitationMm).toBe(283.0);
    expect(akita!.precipitationNormalMm).toBe(265.4);
  });

  it("30_02: 降水のみの観測点では気温系フィールドはすべて null", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU);
    const result = parseClimateInfo(msg)!;
    const aomori = result.stations.find((s) => s.stationName === "青森")!;
    expect(aomori.temperatureCelsius).toBeNull();
    expect(aomori.temperatureAnomalyCelsius).toBeNull();
    expect(aomori.temperatureNormalCelsius).toBeNull();
  });

  it("VPZI50 (29_01): 既存の抽出値は不変で、平年値フィールドは null", () => {
    // 単独要素 (配列にならない) ケースの退行ガード
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY);
    const result = parseClimateInfo(msg)!;
    const tokyo = result.stations.find((s) => s.stationName === "東京")!;
    expect(tokyo.temperatureCelsius).toBe(9.2);
    expect(tokyo.temperatureAnomalyCelsius).toBe(1.6);
    expect(tokyo.precipitationMm).toBe(19.5);
    expect(tokyo.precipitationAnomalyPercent).toBe(23);
    expect(tokyo.temperatureNormalCelsius).toBeNull();
    expect(tokyo.precipitationNormalMm).toBeNull();
  });

  it("Temperature の type 違い兄弟 (実測/平年値) も同様に振り分けられる (合成 XML)", () => {
    // VPZI50/VPCI50 実 fixture に気温平年値ペアの実例が無いため synthetic で固定。
    // Precipitation と同じ構造 (type に「平年値」を含む方が平年値) を想定する。
    const zlib = require("zlib");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>地方天候情報</Title>
    <DateTime>2024-01-10T06:43:49Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト天候情報</Title>
    <ReportDateTime>2024-01-10T16:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <InfoKind>天候情報</InfoKind>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
    <MeteorologicalInfos type="天候情報">
      <MeteorologicalInfo type="気象官署及び特別地域気象観測所">
        <DateTime>2023-11-26T00:00:00+09:00</DateTime>
        <Name>テスト期間</Name>
        <Item>
          <Kind><Property>
            <Type>天候の状況（速報値）</Type>
            <ClimateValuesPart type="平均気温と平年値">
              <jmx_eb:Temperature type="気温" unit="度">10.0</jmx_eb:Temperature>
              <jmx_eb:Temperature type="気温日別平滑平年値" unit="度">9.5</jmx_eb:Temperature>
            </ClimateValuesPart>
          </Property></Kind>
          <Station><Name>仙台</Name><Code type="国際地点番号">47590</Code></Station>
        </Item>
      </MeteorologicalInfo>
    </MeteorologicalInfos>
  </Body>
</Report>`;
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    const msg = createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY, { body });
    const result = parseClimateInfo(msg)!;
    const sendai = result.stations.find((s) => s.stationName === "仙台")!;
    expect(sendai.temperatureCelsius).toBe(10.0);
    expect(sendai.temperatureNormalCelsius).toBe(9.5);
    expect(sendai.precipitationMm).toBeNull();
    expect(sendai.precipitationNormalMm).toBeNull();
  });
});

describe("parseClimateInfo - 異常系", () => {
  /** XML を gzip+base64 化して mock body に流し込むためのヘルパー */
  function makeMsg(xml: string) {
    // require は test 内で十分 (zlib は CommonJS)。
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY, { body });
  }

  it("Head が欠落した XML では null を返す", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>全般天候情報</Title>
  </Control>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseClimateInfo(makeMsg(xml))).toBeNull();
  });

  it("壊れた XML では null を返す (例外を投げない)", () => {
    expect(parseClimateInfo(makeMsg("<<<broken"))).toBeNull();
  });

  it("[R1 W1] Title 単独欠落でも null を返す", () => {
    // Title が空・無い場合、通知タイトルが空になるリスクのため必須扱い
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>全般天候情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <ReportDateTime>2024-01-10T16:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseClimateInfo(makeMsg(xml))).toBeNull();
  });

  it("[R1 W1] InfoType 単独欠落でも null を返す", () => {
    // InfoType が空・無い場合、取消判定不能となるため必須扱い
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>全般天候情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2024-01-10T16:00:00+09:00</ReportDateTime>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseClimateInfo(makeMsg(xml))).toBeNull();
  });
});

describe("parseClimateInfo - 境界値 (合成 XML)", () => {
  function makeMsg(xml: string) {
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY, { body });
  }

  /** Comparison の @_type / Comparison 欠落 / 負値 / 全角符号を検証する基幹 XML */
  const STATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>全般天候情報</Title>
    <DateTime>2024-01-10T06:43:49Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト天候情報</Title>
    <ReportDateTime>2024-01-10T16:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <InfoKind>天候情報</InfoKind>
    <Headline><Text>headline</Text></Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
    <TargetArea codeType="全国・地方予報区等">
      <Name>全国</Name>
      <Code>010000</Code>
    </TargetArea>
    <MeteorologicalInfos type="天候情報">
      <MeteorologicalInfo type="気象官署及び特別地域気象観測所">
        <DateTime>2023-11-26T00:00:00+09:00</DateTime>
        <Name>テスト期間</Name>
        <Item>
          <Kind><Property>
            <Type>天候の状況（速報値）</Type>
            <Text type="表題">表題のみで ClimateValuesPart 無し</Text>
          </Property></Kind>
          <Station><Name>仙台</Name><Code type="国際地点番号">47590</Code></Station>
        </Item>
        <Item>
          <Kind><Property>
            <Type>天候の状況（速報値）</Type>
            <ClimateValuesPart type="平均気温と平年差">
              <jmx_eb:Temperature type="平均気温" unit="度">10.0</jmx_eb:Temperature>
              <jmx_eb:Comparison type="平均気温平年差" unit="度">−0.5</jmx_eb:Comparison>
            </ClimateValuesPart>
            <ClimateValuesPart type="総降水量と平年比">
              <jmx_eb:Precipitation type="降水量" unit="ミリ">30.5</jmx_eb:Precipitation>
            </ClimateValuesPart>
          </Property></Kind>
          <Station><Name>札幌</Name><Code type="国際地点番号">47412</Code></Station>
        </Item>
        <Item>
          <Kind><Property>
            <Type>天候の状況（速報値）</Type>
            <ClimateValuesPart type="平均気温と平年差">
              <jmx_eb:Temperature type="平均気温" unit="度">15.2</jmx_eb:Temperature>
              <jmx_eb:Comparison unit="度">＋2.0</jmx_eb:Comparison>
            </ClimateValuesPart>
          </Property></Kind>
          <Station><Name>那覇</Name><Code type="国際地点番号">47936</Code></Station>
        </Item>
      </MeteorologicalInfo>
    </MeteorologicalInfos>
  </Body>
</Report>`;

  it("「表題」だけの Item (ClimateValuesPart 無し) は stations から除外される", () => {
    const result = parseClimateInfo(makeMsg(STATIONS_XML))!;
    const names = result.stations.map((s) => s.stationName);
    expect(names).not.toContain("仙台");
    expect(names).toEqual(expect.arrayContaining(["札幌", "那覇"]));
  });

  it("[R1 W2] Comparison @_type が空のとき ClimateValuesPart.@_type にフォールバックする", () => {
    // 那覇は Comparison に @_type 無し、partType="平均気温と平年差" → 気温平年差扱い
    const result = parseClimateInfo(makeMsg(STATIONS_XML))!;
    const naha = result.stations.find((s) => s.stationName === "那覇")!;
    expect(naha.temperatureCelsius).toBe(15.2);
    expect(naha.temperatureAnomalyCelsius).toBe(2.0);
    expect(naha.precipitationAnomalyPercent).toBeNull();
  });

  it("Comparison が単独欠落しても他のフィールドは取れる", () => {
    // 札幌は降水量側に Comparison が無い (precipitationAnomalyPercent は null)
    const result = parseClimateInfo(makeMsg(STATIONS_XML))!;
    const sapporo = result.stations.find((s) => s.stationName === "札幌")!;
    expect(sapporo.precipitationMm).toBe(30.5);
    expect(sapporo.precipitationAnomalyPercent).toBeNull();
    expect(sapporo.temperatureCelsius).toBe(10.0);
    // 全角マイナス "−" が負値として認識される (toNumberOrNull 正規化)
    expect(sapporo.temperatureAnomalyCelsius).toBe(-0.5);
  });

  it("全角プラス '＋' が正値として認識される", () => {
    const result = parseClimateInfo(makeMsg(STATIONS_XML))!;
    const naha = result.stations.find((s) => s.stationName === "那覇")!;
    expect(naha.temperatureAnomalyCelsius).toBe(2.0);
  });
});
