import { testTelegramMeta } from "../../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import { fromWeatherExplanationOutcome } from "../../../../src/engine/presentation/events/from-weather-explanation";
import { processWeatherExplanation } from "../../../../src/engine/presentation/processors/process-weather-explanation";
import { projectDisplayEvent } from "../../../../src/engine/display/project-event";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPZJ51_TYPHOON,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VMCJ55_FUKUSHINDO,
} from "../../../helpers/mock-message";
import type { WeatherExplanationOutcome } from "../../../../src/engine/presentation/types";
import type { ParsedWeatherExplanation } from "../../../../src/types";

const WEATHER_EXPLANATION_PLACEHOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>全般気象解説情報</Title><PublishingOffice>気象庁</PublishingOffice></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>全般気象解説情報（台風第１５号）</Title>
    <ReportDateTime>2026-08-11T10:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <EventID>ZJPTK260036</EventID>
    <Serial>1</Serial>
    <Headline><Text>台風第１５号は茨城県南部に上陸しました。</Text></Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/">
    <MeteorologicalInfos type="付加情報">
      <MeteorologicalInfo><Item><Kind><Property><Type>補足事項</Type>
        <Text type="本文">　本文なし。　</Text>
      </Property></Kind></Item></MeteorologicalInfo>
    </MeteorologicalInfos>
  </Body>
</Report>`;

/**
 * ParsedWeatherExplanation の最低限モック (targetAreas を差し替えるため)
 */
function makeOutcomeWithAreas(
  areas: { name: string; code: string }[],
): WeatherExplanationOutcome {
  const baseParsed: ParsedWeatherExplanation = {
    meta: testTelegramMeta(false),
    type: "VPZJ51",
    infoType: "発表",
    title: "全般気象解説情報（テスト）",
    controlTitle: "全般気象解説情報",
    reportDateTime: "2024-07-13T16:21:00+09:00",
    targetDateTime: null,
    validDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁本庁",
    eventId: "JPTK240001",
    serial: "1",
    informationTags: [],
    targetAreas: areas,
    sections: [],
    forecast: null,
    observation: null,
    tidal: null,
    isTest: false,
  };
  return {
    domain: "weatherExplanation",
    msg: createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU),
    headType: "VPZJ51",
    statsCategory: "weatherExplanation",
    parsed: baseParsed,
    stats: { shouldRecord: true, eventId: null },
    presentation: {
      frameLevel: "normal",
      soundLevel: "normal",
      notifyCategory: "weatherExplanation",
    },
  };
}

describe("fromWeatherExplanationOutcome", () => {
  it("本文なし placeholder だけなら bodyText を落とし headline をテロップに流す", () => {
    const msg = createMockWsDataMessageFromXml(WEATHER_EXPLANATION_PLACEHOLDER_XML, "VPZJ51");
    const outcome = processWeatherExplanation(msg);
    expect(outcome).not.toBeNull();

    const event = fromWeatherExplanationOutcome(outcome!);
    expect(event.bodyText).toBeNull();

    const dto = projectDisplayEvent(event, "要約");
    expect(dto.tickerBody).toBeNull();
    expect(dto.tickerSentence).toBe("台風第１５号は茨城県南部に上陸しました。");
    expect(dto.tickerSentence).not.toContain("本文なし。");
    expect(dto.tickerSuppressed).toBe(false);
  });

  describe("VPZJ51 fixture (線状降水帯予測)", () => {
    it("controlTitle が event に載る", () => {
      const msg = createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.controlTitle).toBe("全般気象解説情報");
    });

    it("domain が weatherExplanation", () => {
      const msg = createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.domain).toBe("weatherExplanation");
    });

    it("sections が event.bodyText に見出し付きで連結される", () => {
      const msg = createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU);
      const outcome = processWeatherExplanation(msg);
      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.bodyText).not.toBeNull();
      expect(event.bodyText).toContain("【");
    });
  });

  describe("全国降格ロジック", () => {
    it("全国 + 細分が混在するとき全国は末尾になる（先頭は細分地域）", () => {
      const outcome = makeOutcomeWithAreas([
        { name: "全国", code: "010000" },
        { name: "東日本", code: "010100" },
        { name: "西日本", code: "010200" },
      ]);
      const event = fromWeatherExplanationOutcome(outcome);
      // 先頭は全国でない
      expect(event.areaNames[0]).not.toBe("全国");
      // 全国は末尾
      expect(event.areaNames[event.areaNames.length - 1]).toBe("全国");
      // 全エリアが含まれる
      expect(event.areaNames).toContain("東日本");
      expect(event.areaNames).toContain("西日本");
    });

    it("全国単独なら全国のまま（降格しない）", () => {
      // VPZJ51_TYPHOON fixture は全国単独
      const msg = createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.areaNames).toContain("全国");
      expect(event.areaNames[0]).toBe("全国");
    });

    it("全国を含まない場合は入力順のまま", () => {
      const outcome = makeOutcomeWithAreas([
        { name: "四国地方", code: "010800" },
        { name: "九州北部地方（山口県を含む）", code: "010900" },
      ]);
      const event = fromWeatherExplanationOutcome(outcome);
      expect(event.areaNames[0]).toBe("四国地方");
      expect(event.areaNames[1]).toBe("九州北部地方（山口県を含む）");
    });
  });

  describe("VPFJ51 fixture (観測実況)", () => {
    it("observationNames に Station 名が入る", () => {
      const msg = createMockWsDataMessage(FIXTURE_VPFJ51_KANTO);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      expect(outcome!.parsed.observation).not.toBeNull();

      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.observationNames.length).toBeGreaterThan(0);
      expect(event.observationCount).toBe(event.observationNames.length);
    });

    it("VPCJ51/VPZJ51 では observationNames は空配列のまま", () => {
      const msg = createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      expect(outcome!.parsed.observation).toBeNull();

      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.observationNames).toEqual([]);
      expect(event.observationCount).toBe(0);
    });
  });

  describe("VMCJ55 fixture (潮位)", () => {
    it("VMCJ55 の潮位観測点が observationNames に集約される (実況+予想、重複排除)", () => {
      const msg = createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO);
      const outcome = processWeatherExplanation(msg);
      expect(outcome).not.toBeNull();
      const event = fromWeatherExplanationOutcome(outcome!);
      expect(event.observationNames).toContain("苫小牧東（港湾局）");
      expect(event.observationNames).toContain("苫小牧西（港湾局）");
      // 苫小牧東は実況と予想の両方に出るが 1 回だけ
      expect(
        event.observationNames.filter((n) => n === "苫小牧東（港湾局）").length,
      ).toBe(1);
      expect(event.observationCount).toBe(event.observationNames.length);
    });
  });
});
