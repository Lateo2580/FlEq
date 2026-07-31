import { describe, expect, it, vi } from "vitest";
import zlib from "zlib";
import type {
  TelegramMeta,
  WsDataMessage,
} from "../../../src/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { decodeTelegramBody } from "../../../src/dmdata/telegram-body";
import { parseTelegramEnvelopeXml } from "../../../src/dmdata/telegram-envelope";
import {
  normalizeTelegramMessage,
  requireTelegramMeta,
} from "../../../src/dmdata/telegram-ingress";
import { isWsDataMessage } from "../../../src/dmdata/ws-client";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseLgObservationTelegram,
  parseNankaiTroughTelegram,
  parseSeismicTextTelegram,
  parseTsunamiTelegram,
} from "../../../src/dmdata/telegram-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { parseTornadoAdvisory } from "../../../src/dmdata/tornado-parser";
import { parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import { parseEarlyWeather } from "../../../src/dmdata/early-weather-parser";
import { parseWeatherWarningTimeseries } from "../../../src/dmdata/weather-warning-timeseries-parser";
import { parseClimateInfo } from "../../../src/dmdata/climate-info-parser";
import { parseWeatherExplanation } from "../../../src/dmdata/weather-explanation-parser";
import { parseHeatAlert } from "../../../src/dmdata/heat-alert-parser";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import { parseTyphoonProbability } from "../../../src/dmdata/typhoon-probability-parser";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_LINEAR_OBSERVED,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VPAW51_HIGH_TEMP,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPHW50_TOKYO,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VPWW55_OAME,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VXKO50_16_01_01,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE62_LGOBS,
  FIXTURE_VYSE50_INVESTIGATION,
} from "../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

interface ParsedWithTestMeta {
  meta: TelegramMeta;
  isTest: boolean;
}

type TestAwareParser = (msg: WsDataMessage) => ParsedWithTestMeta | null;

interface ParserCase {
  name: string;
  fixture: string;
  parser: TestAwareParser;
}

const PARSER_CASES: readonly ParserCase[] = [
  { name: "earthquake", fixture: FIXTURE_VXSE53_ENCHI, parser: parseEarthquakeTelegram },
  { name: "eew", fixture: FIXTURE_VXSE43_WARNING_S1, parser: parseEewTelegram },
  { name: "tsunami", fixture: FIXTURE_VTSE41_WARN, parser: parseTsunamiTelegram },
  { name: "seismicText", fixture: FIXTURE_VXSE56_ACTIVITY_1, parser: parseSeismicTextTelegram },
  { name: "nankaiTrough", fixture: FIXTURE_VYSE50_INVESTIGATION, parser: parseNankaiTroughTelegram },
  { name: "lgObservation", fixture: FIXTURE_VXSE62_LGOBS, parser: parseLgObservationTelegram },
  { name: "volcano", fixture: FIXTURE_VFVO50_ALERT_LV3, parser: parseVolcanoTelegram },
  { name: "weather", fixture: FIXTURE_VPWW55_OAME, parser: parseWeatherWarning },
  { name: "tornado", fixture: FIXTURE_VPHW50_TOKYO, parser: parseTornadoAdvisory },
  { name: "briefing", fixture: FIXTURE_VPBS50_LINEAR_OBSERVED, parser: parseWeatherBriefing },
  { name: "earlyWeather", fixture: FIXTURE_VPAW51_HIGH_TEMP, parser: parseEarlyWeather },
  {
    name: "weatherWarningTimeseries",
    fixture: FIXTURE_VPWP50_NAGANO,
    parser: parseWeatherWarningTimeseries,
  },
  { name: "climateInfo", fixture: FIXTURE_VPZI50_HOT_DRY, parser: parseClimateInfo },
  {
    name: "weatherExplanation",
    fixture: FIXTURE_VPCJ51_KANTO_SNOW,
    parser: parseWeatherExplanation,
  },
  { name: "heatAlert", fixture: FIXTURE_VPFT50_SAITAMA, parser: parseHeatAlert },
  { name: "typhoonAnalysis", fixture: FIXTURE_VPTW60_2020, parser: parseTyphoonAnalysis },
  {
    name: "typhoonProbability",
    fixture: FIXTURE_VPTA50_DAMREY,
    parser: parseTyphoonProbability,
  },
  { name: "floodForecast", fixture: FIXTURE_VXKO50_16_01_01, parser: parseFloodForecast },
];

const TEST_STATUS_CASES = PARSER_CASES.flatMap((parserCase) =>
  (["訓練", "試験"] as const).map((status) => ({ ...parserCase, status }))
);

function withEnvelopeStatus(
  fixture: string,
  status: "通常" | "訓練" | "試験",
  headTest = false,
): WsDataMessage {
  const source = createMockWsDataMessage(fixture);
  if (source.xmlReport == null) throw new Error(`xmlReport missing: ${fixture}`);
  const { meta: _sourceMeta, ...rawSource } = source;
  return normalizeTelegramMessage({
    ...rawSource,
    head: { ...source.head, test: headTest },
    xmlReport: {
      ...source.xmlReport,
      control: { ...source.xmlReport.control, status },
    },
  }).message;
}

describe("telegram foundation Phase 2 deriveIsTest", () => {
  it("normalize は有効な meta を再導出せず receivedAtMs と参照を保持する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const { meta: _sourceMeta, ...rawSource } = source;
    const first = normalizeTelegramMessage(rawSource, 1_785_460_000_000);
    const second = normalizeTelegramMessage(first.message, 1_785_460_000_001);

    expect(second.message).toBe(first.message);
    expect(second.message.meta).toBe(first.message.meta);
    expect(second.message.meta?.receivedAtMs).toBe(1_785_460_000_000);
  });

  it("normalize は meta 欠落時に指定受信時刻で導出する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const { meta: _sourceMeta, ...rawSource } = source;
    const normalized = normalizeTelegramMessage(rawSource, 1_785_460_000_123);

    expect(normalized.message).not.toBe(rawSource);
    expect(normalized.message.meta).toMatchObject({
      messageId: source.id,
      receivedAtMs: 1_785_460_000_123,
      isTest: false,
    });
  });

  it("normalize は不正な meta を保持せず再導出する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const invalidMeta = { ...source.meta!, receivedAtMs: Number.NaN };
    const normalized = normalizeTelegramMessage(
      { ...source, meta: invalidMeta },
      1_785_460_000_456,
    );

    expect(normalized.message.meta).not.toBe(invalidMeta);
    expect(normalized.message.meta?.receivedAtMs).toBe(1_785_460_000_456);
  });

  it("normalize は envelope と矛盾する meta を不正として再導出する", () => {
    const source = withEnvelopeStatus(FIXTURE_VXSE53_ENCHI, "試験");
    const invalidMeta = { ...source.meta!, isTest: false };
    const normalized = normalizeTelegramMessage(
      { ...source, meta: invalidMeta },
      1_785_460_000_789,
    );

    expect(normalized.message.meta).not.toBe(invalidMeta);
    expect(normalized.message.meta).toMatchObject({
      receivedAtMs: 1_785_460_000_789,
      status: "通常",
      isTest: true,
    });
  });

  it("requireTelegramMeta は後から true になった head.test と矛盾する meta を再導出する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const staleMeta = source.meta!;
    const actual = requireTelegramMeta({
      ...source,
      head: { ...source.head, test: true },
      meta: staleMeta,
    });

    expect(actual).not.toBe(staleMeta);
    expect(actual.isTest).toBe(true);
  });

  it.each(["訓練", "試験"] as const)(
    "requireTelegramMeta は後から %s になった envelope Status と矛盾する meta を再導出する",
    (status) => {
      const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      if (source.xmlReport == null) throw new Error("xmlReport missing");
      const staleMeta = source.meta!;
      const actual = requireTelegramMeta({
        ...source,
        xmlReport: {
          ...source.xmlReport,
          control: { ...source.xmlReport.control, status },
        },
        meta: staleMeta,
      });

      expect(actual).not.toBe(staleMeta);
      expect(actual.isTest).toBe(true);
    },
  );

  it("requireTelegramMeta は meta.status だけが矛盾する場合も再導出する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const staleMeta = { ...source.meta!, status: "試験" };
    const actual = requireTelegramMeta({ ...source, meta: staleMeta });

    expect(actual).not.toBe(staleMeta);
    expect(actual).toMatchObject({
      status: "通常",
      isTest: false,
    });
  });

  it("envelope extractor は 10 MiB 境界を受理し、1 byte 超過を拒否する", () => {
    const source = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const limit = 10 * 1024 * 1024;
    const prefix = "<Report><Control><Status>通常</Status></Control><Head></Head><Body>";
    const suffix = "</Body></Report>";
    const fillerLength =
      limit - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
    const exactXml = `${prefix}${"x".repeat(fillerLength)}${suffix}`;
    const exactMessage: WsDataMessage = {
      ...source,
      body: exactXml,
      compression: null,
      encoding: "utf-8",
    };

    const decoded = decodeTelegramBody(exactMessage);
    expect(Buffer.byteLength(decoded, "utf8")).toBe(limit);
    expect(parseTelegramEnvelopeXml(decoded).control.status).toBe("通常");

    const exactGzipMessage: WsDataMessage = {
      ...exactMessage,
      body: zlib.gzipSync(exactXml).toString("base64"),
      compression: "gzip",
      encoding: "base64",
    };
    expect(Buffer.byteLength(decodeTelegramBody(exactGzipMessage), "utf8"))
      .toBe(limit);

    expect(() =>
      decodeTelegramBody({ ...exactMessage, body: `${exactXml}x` })
    ).toThrow(/上限/);
    const overGzipMessage: WsDataMessage = {
      ...exactGzipMessage,
      body: zlib.gzipSync(`${exactXml}x`).toString("base64"),
    };
    expect(() => decodeTelegramBody(overGzipMessage)).toThrow();
  });

  it("validator は production head.test を必須 boolean とし、Control.Status の型も検証する", () => {
    const valid = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    expect(isWsDataMessage(valid)).toBe(true);
    expect(isWsDataMessage({
      ...valid,
      head: { ...valid.head, test: "false" },
    })).toBe(false);
    const { test: _test, ...headWithoutTest } = valid.head;
    expect(isWsDataMessage({ ...valid, head: headWithoutTest })).toBe(false);
    expect(isWsDataMessage({
      ...valid,
      xmlReport: {
        ...valid.xmlReport,
        control: { ...valid.xmlReport!.control, status: 1 },
      },
    })).toBe(false);
  });

  it("fixture helper は実 XML の Control/Head metadata を envelope と meta に反映する", () => {
    const drill = createMockWsDataMessage(FIXTURE_VXSE53_DRILL_1);
    expect(drill.xmlReport).toMatchObject({
      control: { status: "訓練", title: "震源・震度に関する情報" },
      head: {
        eventId: "20091001134500",
        serial: "1",
        infoType: "発表",
        reportDateTime: "2009-10-01T13:50:00+09:00",
      },
    });
    expect(drill.head.test).toBe(true);
    expect(drill.meta?.isTest).toBe(true);
  });

  it.each(TEST_STATUS_CASES)(
    "$name parser は共通 meta の Status=$status を isTest:true として返す",
    ({ fixture, parser, status }) => {
      const parsed = parser(withEnvelopeStatus(fixture, status));
      expect(parsed).not.toBeNull();
      expect(parsed?.meta.isTest).toBe(true);
      expect(parsed?.isTest).toBe(true);
    },
  );

  it.each(PARSER_CASES)(
    "$name parser は Status=通常かつ head.test=false を isTest:false として返す",
    ({ fixture, parser }) => {
      const parsed = parser(withEnvelopeStatus(fixture, "通常"));
      expect(parsed).not.toBeNull();
      expect(parsed?.meta.isTest).toBe(false);
      expect(parsed?.isTest).toBe(false);
    },
  );

  it.each(TEST_STATUS_CASES)(
    "$name PresentationEvent は Status=$status で parser と同じ TelegramMeta.isTest を参照する",
    ({ fixture, status }) => {
      const events: PresentationEvent[] = [];
      const runtime = createMessageHandler({
        displaySink: { ingest: (event) => events.push(event) },
      });
      runtime.handler(withEnvelopeStatus(fixture, status));
      runtime.flushAndDisposeVolcanoBuffer();
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.isTest)).toBe(true);
    },
  );

  it("metadata mismatch は true 側へ倒れ、router 統計へ記録する", () => {
    const events: PresentationEvent[] = [];
    const runtime = createMessageHandler({
      displaySink: { ingest: (event) => events.push(event) },
    });
    const message = withEnvelopeStatus(FIXTURE_VXSE53_ENCHI, "試験", false);
    const normalized = normalizeTelegramMessage(message);
    expect(normalized.diagnostics).toMatchObject({
      testMetadataMismatch: true,
      headTest: false,
      envelopeControlStatus: "試験",
      rawControlStatus: "通常",
    });

    runtime.handler(message);
    expect(events.at(-1)?.isTest).toBe(true);
    expect(runtime.stats.getSnapshot().testMetadataMismatch).toBe(1);
  });
});
