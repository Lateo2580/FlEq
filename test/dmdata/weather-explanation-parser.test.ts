import { describe, it, expect } from "vitest";
import { parseWeatherExplanation } from "../../src/dmdata/weather-explanation-parser";
import { joinSections } from "../../src/engine/presentation/events/join-body-sections";
import {
  createMockWsDataMessage,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPCJ51_TOHOKU_HOT,
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPZJ51_SENJOU_2,
  FIXTURE_VPZJ51_TYPHOON,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL,
  FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE,
  FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE,
  FIXTURE_VMCJ53_OSHIO,
  FIXTURE_VMCJ54_OSHIO,
  FIXTURE_VMCJ55_FUKUSHINDO,
  FIXTURE_VMCJ55_OSHIO_CHIBA,
} from "../helpers/mock-message";

describe("parseWeatherExplanation - 関東甲信地方 (強い冬型・大雪)", () => {
  it("基本フィールドが取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPCJ51");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toContain("関東甲信地方");
    expect(result!.title).toContain("強い冬型");
    expect(result!.controlTitle).toBe("地方気象解説情報");
    expect(result!.reportDateTime).toBe("2023-01-20T15:00:00+09:00");
    expect(result!.eventId).toBe("JPTK230150");
  });

  it("Headline.Text が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);
    expect(result!.headline).not.toBeNull();
    expect(result!.headline!).toContain("強い冬型");
    expect(result!.headline!).toContain("大雪");
  });

  it("情報タグの Condition と keywords が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);
    expect(result!.informationTags.length).toBe(1);
    const tag = result!.informationTags[0];
    expect(tag.condition).toBe("強い冬型 大雪");
    expect(tag.keywords).toEqual(["強い冬型", "大雪"]);
  });

  it("targetAreas に関東甲信地方が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);
    expect(result!.targetAreas.length).toBe(1);
    expect(result!.targetAreas[0].name).toBe("関東甲信地方");
    expect(result!.targetAreas[0].code).toBe("010300");
  });

  it("3 つのセクション (概況/防災事項/付加情報) が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);
    expect(result!.sections.length).toBe(3);
    const sectionTypes = result!.sections.map((s) => s.sectionType);
    expect(sectionTypes).toEqual(["概況", "防災事項", "付加情報"]);
    const propTypes = result!.sections.map((s) => s.propertyType);
    expect(propTypes).toEqual(["気象概況", "防災事項", "補足事項"]);
  });

  it("概況セクションの本文が取れる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW);
    const result = parseWeatherExplanation(msg);
    const overview = result!.sections.find((s) => s.sectionType === "概況")!;
    expect(overview.text).toContain("低気圧が発達");
    expect(overview.text).toContain("強い冬型");
  });
});

describe("parseWeatherExplanation - 東北地方 (高温)", () => {
  it("基本フィールドが取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_TOHOKU_HOT);
    const result = parseWeatherExplanation(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPCJ51");
    expect(result!.title).toContain("東北地方");
    expect(result!.title).toContain("高温");
    expect(result!.editorialOffice).toBe("仙台管区気象台");
  });

  it("単一キーワードの情報タグ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_TOHOKU_HOT);
    const result = parseWeatherExplanation(msg);
    expect(result!.informationTags.length).toBe(1);
    const tag = result!.informationTags[0];
    expect(tag.condition).toBe("高温");
    expect(tag.keywords).toEqual(["高温"]);
  });

  it("セクションは概況のみ (防災事項・付加情報なし)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_TOHOKU_HOT);
    const result = parseWeatherExplanation(msg);
    expect(result!.sections.length).toBe(1);
    expect(result!.sections[0].sectionType).toBe("概況");
    expect(result!.sections[0].text).toContain("猛暑日");
  });

  it("targetAreas に東北地方が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCJ51_TOHOKU_HOT);
    const result = parseWeatherExplanation(msg);
    expect(result!.targetAreas[0].name).toBe("東北地方");
    expect(result!.targetAreas[0].code).toBe("010200");
  });
});

describe("parseWeatherExplanation - 異常系", () => {
  function makeMsg(xml: string) {
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW, { body });
  }

  it("Head が欠落した XML では null", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseWeatherExplanation(makeMsg(xml))).toBeNull();
  });

  it("Title 単独欠落でも null (VPZI50 R1 教訓を最初から適用)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseWeatherExplanation(makeMsg(xml))).toBeNull();
  });

  it("InfoType 単独欠落でも null", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseWeatherExplanation(makeMsg(xml))).toBeNull();
  });

  it("壊れた XML では null (例外を投げない)", () => {
    expect(parseWeatherExplanation(makeMsg("<<<broken"))).toBeNull();
  });
});

describe("parseWeatherExplanation - 境界 (合成 XML)", () => {
  function makeMsg(xml: string) {
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW, { body });
  }

  it("Headline.Information が無くても targetAreas / informationTags は空配列で返る", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>地方気象解説情報</Title>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <Headline><Text>本文のみ</Text></Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    const result = parseWeatherExplanation(makeMsg(xml));
    expect(result).not.toBeNull();
    expect(result!.informationTags).toEqual([]);
    expect(result!.targetAreas).toEqual([]);
    expect(result!.sections).toEqual([]);
    expect(result!.headline).toBe("本文のみ");
  });

  it("Text が「本文なし。」だけの section は除外され bodyText は null になる", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title><PublishingOffice>気象庁</PublishingOffice></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>地方気象解説情報（本文なし）</Title>
    <ReportDateTime>2026-08-11T10:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <EventID>ZJPTK260036</EventID>
    <Headline><Text>有意なヘッドライン</Text></Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/">
    <MeteorologicalInfos type="付加情報">
      <MeteorologicalInfo><Item><Kind><Property><Type>補足事項</Type>
        <Text type="本文">　本文なし。　</Text>
      </Property></Kind></Item></MeteorologicalInfo>
    </MeteorologicalInfos>
  </Body>
</Report>`;
    const result = parseWeatherExplanation(makeMsg(xml));
    expect(result).not.toBeNull();
    expect(result!.sections).toEqual([]);
    expect(joinSections(result!.sections)).toBeNull();
  });

  it("[Codex R2 info] 情報タグと別系統が混在しても情報タグのみが採用される (W1 回帰)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <Headline>
      <Text>テスト</Text>
      <Information type="情報タグ">
        <Item>
          <Kind><Name>情報タグ</Name><Condition>大雪</Condition></Kind>
          <Areas codeType="全国・地方予報区等">
            <Area><Name>北陸地方</Name><Code>020600</Code></Area>
          </Areas>
        </Item>
      </Information>
      <Information type="関連情報">
        <Item>
          <Kind><Name>関連情報</Name><Condition>無視されるべき</Condition></Kind>
          <Areas codeType="全国・地方予報区等">
            <Area><Name>架空地方</Name><Code>999999</Code></Area>
          </Areas>
        </Item>
      </Information>
    </Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    const result = parseWeatherExplanation(makeMsg(xml))!;
    // 情報タグのみ
    expect(result.informationTags.length).toBe(1);
    expect(result.informationTags[0].condition).toBe("大雪");
    // targetAreas にも「架空地方」が混入していない
    expect(result.targetAreas.length).toBe(1);
    expect(result.targetAreas[0].name).toBe("北陸地方");
  });

  it("[Codex R2 info] 情報タグが無いときは全件 fallback で走査される (W1 互換性確保)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <Headline>
      <Text>テスト</Text>
      <Information type="(無タイプ系統)">
        <Item>
          <Kind><Name>たぐ</Name><Condition>fallback拾い</Condition></Kind>
          <Areas codeType="全国・地方予報区等">
            <Area><Name>中国地方</Name><Code>020800</Code></Area>
          </Areas>
        </Item>
      </Information>
    </Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    const result = parseWeatherExplanation(makeMsg(xml))!;
    expect(result.informationTags.length).toBe(1);
    expect(result.informationTags[0].condition).toBe("fallback拾い");
    expect(result.targetAreas[0].name).toBe("中国地方");
  });

  it("複数キーワードの Condition が半角・全角スペースの混在でも分割される (VPZJ51 FIXTURE)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>地方気象解説情報</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>テスト</Title>
    <ReportDateTime>2023-01-20T15:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <Headline>
      <Text>テスト</Text>
      <Information type="情報タグ">
        <Item>
          <Kind><Name>情報タグ</Name><Condition>大雨　暴風 高温</Condition></Kind>
          <Areas codeType="全国・地方予報区等">
            <Area><Name>関東地方</Name><Code>020100</Code></Area>
          </Areas>
        </Item>
      </Information>
    </Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    const result = parseWeatherExplanation(makeMsg(xml));
    expect(result!.informationTags[0].keywords).toEqual([
      "大雨",
      "暴風",
      "高温",
    ]);
  });
});

describe("mock-message VPZJ 認識 (Codex R1 Blocker 回帰)", () => {
  it("VPZJ51 fixture が head.type=VPZJ51 / classification=telegram.weather", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU);
    expect(msg.head.type).toBe("VPZJ51");
    expect(msg.classification).toBe("telegram.weather");
  });
});

const WEATHER_EXPLANATION_FIXTURES_WITH_NON_EMPTY_ADDITIONAL_TEXT = [
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPZJ51_SENJOU_2,
  FIXTURE_VPZJ51_TYPHOON,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL,
  FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE,
  FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE,
  FIXTURE_VMCJ53_OSHIO,
  FIXTURE_VMCJ54_OSHIO,
  FIXTURE_VMCJ55_FUKUSHINDO,
  FIXTURE_VMCJ55_OSHIO_CHIBA,
] as const;

describe("parseWeatherExplanation - 既存の付加情報本文回帰", () => {
  it.each(WEATHER_EXPLANATION_FIXTURES_WITH_NON_EMPTY_ADDITIONAL_TEXT)(
    "%s の非空な付加情報本文を維持する",
    (fixtureName) => {
      const result = parseWeatherExplanation(createMockWsDataMessage(fixtureName));
      expect(result).not.toBeNull();
      const additionalSections = result!.sections.filter((s) => s.sectionType === "付加情報");
      expect(additionalSections.length).toBeGreaterThan(0);
      expect(additionalSections.every((s) => s.text.trim() !== "")).toBe(true);

      const bodyText = joinSections(result!.sections);
      expect(bodyText).not.toBeNull();
      for (const section of additionalSections) {
        expect(bodyText).toContain(section.text.trim());
      }
    },
  );
});

describe("extractSections Property listOf 化 (synthetic VPFJ51)", () => {
  it("同一 Kind 内の Property 複数を listOf で吸収し、全 Text を sections に拾う", () => {
    const zlib = require("zlib");
    const xml = require("fs").readFileSync(
      require("path").resolve(__dirname, "../fixtures/synthetic/vpfj51_property_multi.xml"),
      "utf-8",
    );
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    const msg = createMockWsDataMessage(
      "synthetic/vpfj51_property_multi.xml",
      {
        head: { type: "VPFJ51", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
        body,
      },
    );
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    const summaryTexts = info!.sections
      .filter((s) => s.sectionType === "概況")
      .map((s) => s.text);
    expect(summaryTexts.some((t) => t.includes("第一の本文"))).toBe(true);
    expect(summaryTexts.some((t) => t.includes("第二の本文"))).toBe(true);
  });
});

describe("parseWeatherExplanation - VPZJ51 統合", () => {
  it("VPZJ51 は forecast を持ち type/controlTitle が全般", () => {
    const r = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU))!;
    expect(r.type).toBe("VPZJ51");
    expect(r.controlTitle).toBe("全般気象解説情報");
    expect(r.forecast).not.toBeNull();
    expect(r.forecast!.series[0].events.length).toBeGreaterThan(0);
  });

  it("台風コード T2410/TC2412 が情報タグ keyword から除外される", () => {
    const r = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    const kws = r.informationTags.flatMap((t) => t.keywords);
    expect(kws).toContain("台風");
    expect(kws).not.toContain("T2410");
    expect(kws).not.toContain("TC2412");
  });

  it("VPCJ51 は forecast=null (回帰)", () => {
    const r = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW))!;
    expect(r.forecast).toBeNull();
  });
});

describe("parseWeatherExplanation - 気象解説情報（潮位） (VMCJ53/54/55)", () => {
  it("VMCJ53 (全般・大潮) の基本フィールドが取得される", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ53_OSHIO));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VMCJ53");
    expect(result!.controlTitle).toBe("全般気象解説情報（潮位）");
    expect(result!.title).toContain("大潮");
    expect(result!.informationTags.some((t) => t.condition === "大潮")).toBe(true);
    expect(result!.sections.length).toBeGreaterThan(0);
  });

  it("VMCJ55 (府県・副振動) の情報タグと地域が取得される", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));
    expect(result!.type).toBe("VMCJ55");
    expect(result!.controlTitle).toBe("府県気象解説情報（潮位）");
    expect(result!.informationTags.some((t) => t.condition === "副振動")).toBe(true);
    expect(result!.targetAreas.map((a) => a.name)).toContain("胆振地方");
  });

  it("VMCJ55 の空 Text (補足など) が sections に混入しない", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));
    for (const s of result!.sections) {
      expect(s.text.length).toBeGreaterThan(0);
    }
  });
});

describe("parseWeatherExplanation - TidalLevelPart 抽出 (VMCJ55)", () => {
  it("副振動の実況 (高さ・周期・観測点) が tidal.observations に入る", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));
    expect(result!.tidal).not.toBeNull();
    const obs = result!.tidal!.observations;
    expect(obs.length).toBe(1);
    expect(obs[0].sentence).toContain("約８０センチ");
    expect(obs[0].stationName).toBe("苫小牧東（港湾局）");
    expect(obs[0].levelDescription).toBe("約８０センチ");
    expect(obs[0].periodDescription).toBe("約６０分");
    expect(obs[0].rawLevel).toBe("80");
    expect(obs[0].rawPeriod).toBe("60");
    expect(obs[0].time).toBe("2023-09-19T12:20:00+09:00");
  });

  it("潮位の予想 (満潮/干潮時刻) が tidal.forecasts に入る", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));
    const fc = result!.tidal!.forecasts;
    expect(fc.length).toBe(4); // 苫小牧東×2 (満潮/干潮) + 苫小牧西×2
    expect(fc[0].sentence).toContain("満潮時刻");
    expect(fc[0].stationName).toBe("苫小牧東（港湾局）");
    expect(fc[0].refId).toBe("1");
    expect(fc[0].timeName).toBe("９月１９日"); // TimeDefines refID 解決
  });

  it("TidalLevelPart の無い VPCJ51 では tidal は null", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW));
    expect(result!.tidal).toBeNull();
  });
});

describe("parseWeatherExplanation - TidalLevel @type 保全 (満潮/干潮の区別)", () => {
  it("89_01 (副振動): observations/forecasts に levelType が載る", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));
    const obs = result!.tidal!.observations;
    expect(obs[0].levelType).toBe("副振動の山から谷の高さ");
    const fc = result!.tidal!.forecasts;
    expect(fc[0].levelType).toBe("満潮潮位");
    expect(fc[1].levelType).toBe("干潮潮位");
  });

  it("89_02 (千葉・大潮): Sentence に満潮の語が無くても levelType で区別できる", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_OSHIO_CHIBA));
    expect(result!.tidal).not.toBeNull();
    const fc = result!.tidal!.forecasts;
    // 銚子漁港 14 件 + 布良 14 件 (各日 2 回の満潮 × 7 日)
    expect(fc.length).toBe(28);
    expect(fc[0].sentence).toBe("０１時０１分　５０センチ");
    expect(fc[0].sentence).not.toContain("満潮");
    for (const entry of fc) {
      expect(entry.levelType).toBe("満潮潮位");
    }
    expect(fc[0].stationName).toBe("銚子漁港");
    expect(fc[14].stationName).toBe("布良");
  });

  it("89_02: 複数 TimeDefine (refID 1-7) の timeName が正しく解決される", () => {
    const result = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_OSHIO_CHIBA));
    const fc = result!.tidal!.forecasts;
    expect(fc[0].refId).toBe("1");
    expect(fc[0].timeName).toBe("７月　４日");
    expect(fc[2].refId).toBe("2");
    expect(fc[2].timeName).toBe("７月　５日");
    expect(fc[13].refId).toBe("7");
    expect(fc[13].timeName).toBe("７月１０日");
    // 布良側 (Item 2 つ目) でも同じ TimeDefines が解決される
    expect(fc[27].timeName).toBe("７月１０日");
  });
});
