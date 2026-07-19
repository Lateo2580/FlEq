import { describe, it, expect } from "vitest";
import zlib from "zlib";
import { parseEarlyWeather } from "../../src/dmdata/early-weather-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPAW51_HIGH_TEMP,
  FIXTURE_VPAW51_LOW_TEMP,
  FIXTURE_VPAW51_HEAVY_SNOW,
  FIXTURE_VPAW51_SNOW,
  FIXTURE_VPAW51_LOWTEMP_HEAVYSNOW,
  FIXTURE_VPAW51_LOWTEMP_SNOW,
  FIXTURE_VPAW51_HIGHTEMP_HEAVYSNOW,
  FIXTURE_VPAW51_HIGHTEMP_SNOW,
} from "../helpers/mock-message";

describe("parseEarlyWeather - 高温", () => {
  it("基本フィールドが取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPAW51");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toContain("高温");
    expect(result!.controlTitle).toBe("早期天候情報");
    expect(result!.targetArea?.name).toBe("東北地方");
    expect(result!.targetArea?.code).toBe("010200");
    expect(result!.targetDuration).toBe("P5D");
  });

  it("phenomena に trend=above が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    const aboves = result!.phenomena.filter((p) => p.trend === "above");
    expect(aboves.length).toBeGreaterThan(0);
    const first = aboves[0];
    expect(first.climateKind).toBe("気温");
    expect(first.probabilityPercent).toBe(30);
    expect(first.thresholdValue).toBe(2.4);
    expect(first.thresholdUnit).toBe("℃");
  });

  it("bodyTexts が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    expect(result!.bodyTexts.length).toBeGreaterThan(0);
    expect(result!.bodyTexts[0].text).toContain("東北地方");
  });

  it("headlineConditions に Condition が集約される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    expect(result!.headlineConditions.length).toBeGreaterThan(0);
    expect(result!.headlineConditions[0]).toContain("高温");
  });
});

describe("parseEarlyWeather - 低温", () => {
  it("trend=below と probability が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_LOW_TEMP);
    const result = parseEarlyWeather(msg);
    expect(result!.title).toContain("低温");
    const belows = result!.phenomena.filter((p) => p.trend === "below");
    expect(belows.length).toBeGreaterThan(0);
    const first = belows[0];
    expect(first.climateKind).toBe("気温");
    expect(first.probabilityPercent).toBeGreaterThan(0);
  });
});

describe("parseEarlyWeather - 大雪 / 雪", () => {
  it("大雪は降雪量 trend=above", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HEAVY_SNOW);
    const result = parseEarlyWeather(msg);
    expect(result!.title).toContain("大雪");
    const aboves = result!.phenomena.filter((p) => p.trend === "above");
    expect(aboves.some((p) => p.climateKind === "降雪量")).toBe(true);
  });

  it("雪も降雪量 trend=above (大雪より閾値は低い想定)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_SNOW);
    const result = parseEarlyWeather(msg);
    expect(result!.title).toMatch(/雪/);
    const snowPhen = result!.phenomena.find((p) => p.climateKind === "降雪量");
    expect(snowPhen).toBeDefined();
    expect(snowPhen!.trend).toBe("above");
  });
});

describe("parseEarlyWeather - 複合 (低温と大雪)", () => {
  it("trend=below と trend=above の両方を持つ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_LOWTEMP_HEAVYSNOW);
    const result = parseEarlyWeather(msg);
    expect(result!.title).toContain("低温");
    expect(result!.title).toContain("大雪");
    const hasBelow = result!.phenomena.some((p) => p.trend === "below");
    const hasAbove = result!.phenomena.some((p) => p.trend === "above");
    expect(hasBelow).toBe(true);
    expect(hasAbove).toBe(true);
  });
});

describe("parseEarlyWeather - その他複合パターン", () => {
  it("低温と雪", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_LOWTEMP_SNOW);
    const result = parseEarlyWeather(msg);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("低温");
    expect(result!.title).toContain("雪");
  });

  it("高温と大雪", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGHTEMP_HEAVYSNOW);
    const result = parseEarlyWeather(msg);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("高温");
    expect(result!.title).toContain("大雪");
  });

  it("高温と雪", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGHTEMP_SNOW);
    const result = parseEarlyWeather(msg);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("高温");
    expect(result!.title).toContain("雪");
  });
});

describe("parseEarlyWeather - 異常入力 / フォールバック", () => {
  it("Body 無し XML でも head さえあれば null を返さない", () => {
    // Head だけ持ち Body を空にした最小 XML を作る
    const minimalXml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>早期天候情報</Title>
    <DateTime>2026-06-04T05:00:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>仙台管区気象台</EditorialOffice>
    <PublishingOffice>仙台管区気象台</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>高温に関する早期天候情報（東北地方）</Title>
    <ReportDateTime>2026-06-04T14:30:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
    <InfoKind>早期天候情報</InfoKind>
    <InfoKindVersion>1.0_0</InfoKindVersion>
  </Head>
</Report>`;
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP, {
      body: Buffer.from(
        zlib.gzipSync(Buffer.from(minimalXml, "utf-8")),
      ).toString("base64"),
    });
    const result = parseEarlyWeather(msg);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("高温");
    expect(result!.phenomena.length).toBe(0);
    expect(result!.bodyTexts.length).toBe(0);
    expect(result!.targetArea).toBeNull();
  });

  it("Head が完全に欠落した XML は null を返す (raw フォールバックさせる)", () => {
    const malformedXml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>早期天候情報</Title>
  </Control>
</Report>`;
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP, {
      body: Buffer.from(
        zlib.gzipSync(Buffer.from(malformedXml, "utf-8")),
      ).toString("base64"),
    });
    const result = parseEarlyWeather(msg);
    expect(result).toBeNull();
  });

  it("壊れた XML 文字列でも例外を吐かず null を返す", () => {
    const garbage = "<<<not xml at all>>>";
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP, {
      body: Buffer.from(
        zlib.gzipSync(Buffer.from(garbage, "utf-8")),
      ).toString("base64"),
    });
    const result = parseEarlyWeather(msg);
    expect(result).toBeNull();
  });
});

describe("parseEarlyWeather - 取消", () => {
  it("InfoType=取消 が保持される", () => {
    const cancelXml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>早期天候情報</Title>
    <DateTime>2026-06-04T05:00:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>仙台管区気象台</EditorialOffice>
    <PublishingOffice>仙台管区気象台</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>高温に関する早期天候情報（東北地方）</Title>
    <ReportDateTime>2026-06-04T14:30:00+09:00</ReportDateTime>
    <InfoType>取消</InfoType>
    <InfoKind>早期天候情報</InfoKind>
    <InfoKindVersion>1.0_0</InfoKindVersion>
  </Head>
</Report>`;
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP, {
      body: Buffer.from(
        zlib.gzipSync(Buffer.from(cancelXml, "utf-8")),
      ).toString("base64"),
    });
    const result = parseEarlyWeather(msg);
    expect(result).not.toBeNull();
    expect(result!.infoType).toBe("取消");
  });
});

describe("parseEarlyWeather - 共通フィールド", () => {
  it("publishingOffice / editorialOffice / reportDateTime が取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    // publishingOffice は mock の xmlReport が優先されるので truthy 検証のみ
    expect(result!.publishingOffice).toBeTruthy();
    // editorialOffice は XML 由来 (xmlReport にフィールドなし) のため厳密に検証
    expect(result!.editorialOffice).toBe("仙台管区気象台");
    expect(result!.reportDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("periodLabel / periodStartTime / periodDuration が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    const phen = result!.phenomena.find(
      (p) => p.periodLabel != null && p.climateKind != null,
    );
    expect(phen).toBeDefined();
    expect(phen!.periodLabel).toContain("約５日間");
    expect(phen!.periodDuration).toBe("P5D");
  });

  it("isTest=false がデフォルトで設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP);
    const result = parseEarlyWeather(msg);
    expect(result!.isTest).toBe(false);
  });
});
