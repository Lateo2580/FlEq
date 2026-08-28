import { describe, it, expect } from "vitest";
import {
  parseWeatherBriefing,
  deriveBriefingTag,
} from "../../src/dmdata/briefing-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_LINEAR_OBSERVED,
  FIXTURE_VPBS50_LINEAR_PREDICTED,
  FIXTURE_VPBS50_RECORD_RAIN,
  FIXTURE_VPBS50_SHORT_SNOW,
  FIXTURE_VPBS50_SYNTH_MULTI,
  FIXTURE_VPBS50_SYNTH_UNKNOWN,
  FIXTURE_VPBS50_SYNTH_FALLBACK,
  FIXTURE_VPBS50_SYNTH_EMPTY,
  FIXTURE_VPBS50_SYNTH_CANCEL,
  encodeXml,
  readFixture,
} from "../helpers/mock-message";

describe("deriveBriefingTag", () => {
  it('"線状降水帯発生" → linearRainObserved', () => {
    expect(deriveBriefingTag("線状降水帯発生")).toBe("linearRainObserved");
  });

  it('"線状降水帯直前" → linearRainPredicted', () => {
    expect(deriveBriefingTag("線状降水帯直前")).toBe("linearRainPredicted");
  });

  it('"記録雨" → recordRain', () => {
    expect(deriveBriefingTag("記録雨")).toBe("recordRain");
  });

  it('"短時間大雪" → shortSnow', () => {
    expect(deriveBriefingTag("短時間大雪")).toBe("shortSnow");
  });

  it("不明な Condition は other", () => {
    expect(deriveBriefingTag("")).toBe("other");
    expect(deriveBriefingTag("XX")).toBe("other");
  });
});

describe("parseWeatherBriefing - 線状降水帯発生", () => {
  it("基本フィールドが取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    const result = parseWeatherBriefing(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPBS50");
    expect(result!.infoType).toBe("発表");
    expect(result!.briefingTag).toBe("linearRainObserved");
    expect(result!.briefingCondition).toContain("線状降水帯");
    expect(result!.headline).not.toBeNull();
    expect(result!.targetAreas.length).toBeGreaterThan(0);
    expect(result!.observations.length).toBeGreaterThan(0);
  });

  it("observations に Event type=線状降水帯 が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    const result = parseWeatherBriefing(msg);
    const hasLinearRainObs = result!.observations.some(
      (o) => o.description.includes("線状降水帯"),
    );
    expect(hasLinearRainObs).toBe(true);
  });
});

describe("parseWeatherBriefing - 線状降水帯予想", () => {
  it("briefingTag = linearRainPredicted になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_PREDICTED);
    const result = parseWeatherBriefing(msg);
    expect(result!.briefingTag).toBe("linearRainPredicted");
    expect(result!.briefingCondition).toContain("直前");
  });
});

describe("parseWeatherBriefing - 記録的短時間大雨", () => {
  it("briefingTag = recordRain、PrecipitationPart が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_RECORD_RAIN);
    const result = parseWeatherBriefing(msg);
    expect(result!.briefingTag).toBe("recordRain");
    // PrecipitationPart → observations の value/unit
    const hasPrecipObs = result!.observations.some(
      (o) => o.unit === "mm" && o.value != null,
    );
    expect(hasPrecipObs).toBe(true);
  });

  it("Precipitation の時間幅と約／以上を推測せずに正規化する", () => {
    const bihar = parseWeatherBriefing(createMockWsDataMessage("82_01_02_250630_VPBS50.xml"))!;
    expect(bihar.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationName: "美幌町", value: 100, unit: "mm", duration: "1時間", approximation: "approx" }),
      expect.objectContaining({ locationName: "美幌", value: 93, unit: "mm", duration: "1時間", approximation: "exact" }),
    ]));
    const tokyo = parseWeatherBriefing(createMockWsDataMessage("phase6b_VPBS50_KJPTK202608221709_202608221717.xml"))!;
    expect(tokyo.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 120, unit: "mm", duration: "1時間", approximation: "atLeast" }),
    ]));
  });

  it("Precipitation の未知 condition は description の形にかかわらず unknown を優先する", () => {
    const message = createMockWsDataMessage("82_01_02_250630_VPBS50.xml");
    message.body = encodeXml(readFixture("82_01_02_250630_VPBS50.xml").replace('condition="約"', 'condition="未詳"'));
    expect(parseWeatherBriefing(message)!.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationName: "美幌町", approximation: "unknown" }),
    ]));
  });
});

describe("parseWeatherBriefing - 短時間大雪", () => {
  it("briefingTag = shortSnow、SnowfallDepthPart が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_SHORT_SNOW);
    const result = parseWeatherBriefing(msg);
    expect(result!.briefingTag).toBe("shortSnow");
    // SnowfallDepthPart → observations の value/unit=cm
    const hasSnowObs = result!.observations.some(
      (o) => o.unit === "cm" && o.value != null,
    );
    expect(hasSnowObs).toBe(true);
  });
});

describe("WeatherObservation.partKind", () => {
  it("Property.Type の exact mapping を4値として保持する", () => {
    expect(parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED))!.observations
      .every((observation) => observation.partKind === "event")).toBe(true);
    expect(parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_RECORD_RAIN))!.observations
      .every((observation) => observation.partKind === "precipitation")).toBe(true);
    expect(parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SHORT_SNOW))!.observations
      .every((observation) => observation.partKind === "snowfall")).toBe(true);

    const message = createMockWsDataMessage(FIXTURE_VPBS50_SHORT_SNOW);
    message.body = encodeXml(readFixture(FIXTURE_VPBS50_SHORT_SNOW).replace("<Type>雪の実況</Type>", "<Type>雪の予想</Type>"));
    expect(parseWeatherBriefing(message)!.observations[0]?.partKind).toBe("other");
  });
});

describe("parseWeatherBriefing - 共通", () => {
  it("publishingOffice / editorialOffice / controlTitle が取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_RECORD_RAIN);
    const result = parseWeatherBriefing(msg);
    expect(result!.publishingOffice).toBeTruthy();
    expect(result!.editorialOffice).toBeTruthy();
    expect(result!.controlTitle).toBeTruthy();
  });

  it("eventId が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_RECORD_RAIN);
    const result = parseWeatherBriefing(msg);
    expect(result!.eventId).toBeTruthy();
  });

  it("Area.Code の先頭ゼロが文字列で保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    const result = parseWeatherBriefing(msg);
    for (const area of result!.targetAreas) {
      expect(typeof area.code).toBe("string");
      expect(area.code.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("不正なXMLを渡すと null が返る", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED, {
      body: "invalid-base64-content",
    });
    expect(parseWeatherBriefing(msg)).toBeNull();
  });
});

describe("Phase D: 集合ベース severity (複数 Condition)", () => {
  it("先頭が短時間大雪でも後続の記録雨が maxDisplaySeverity に立つ (先頭単一採用の沈黙バグ回帰)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_MULTI);
    const result = parseWeatherBriefing(msg)!;
    expect(result.briefingConditions.length).toBe(2);
    expect(result.maxDisplaySeverity).toBe("nonLevelSpecial");
    expect(result.maxSoundLevel).toBe("warning");
    // 代表値は最大 displaySeverity を与えた evidence (記録雨側)
    expect(result.briefingTag).toBe("recordRain");
    expect(result.unknownConditions).toEqual([]);
  });

  it("情報タグ由来の未分類 Condition は unknownConditions に分離される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_UNKNOWN);
    const result = parseWeatherBriefing(msg)!;
    expect(result.maxDisplaySeverity).toBeNull();
    expect(result.unknownConditions).toEqual(["謎の現象"]);
    expect(result.briefingTag).toBe("other");
  });

  it("既存単一 Condition fixture: 代表値・max 系が従来挙動と整合する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    const result = parseWeatherBriefing(msg)!;
    expect(result.briefingTag).toBe("linearRainObserved");
    expect(result.briefingConditions).toEqual([result.briefingCondition]);
    expect(result.maxDisplaySeverity).toBe("nonLevelSpecial");
    expect(result.maxSoundLevel).toBe("warning");
    expect(result.briefingSeverityEvidence[0].source).toBe("map");
  });

  it("fallback 由来の未分類 Condition は none 扱い (unknown 昇格しない)", () => {
    const result = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_FALLBACK))!;
    expect(result.unknownConditions).toEqual([]);
    expect(result.maxDisplaySeverity).toBeNull();
    expect(result.briefingSeverityEvidence[0].source).toBe("none");
  });

  it("Condition 0 件: max 系 null・代表値は空文字/other", () => {
    const result = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_EMPTY))!;
    expect(result.briefingConditions).toEqual([]);
    expect(result.maxDisplaySeverity).toBeNull();
    expect(result.briefingTag).toBe("other");
    expect(result.briefingCondition).toBe("");
  });

  it("取消 synthetic: infoType=取消 で Condition 収集が空でも安全に parse できる", () => {
    const result = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_CANCEL))!;
    expect(result.infoType).toBe("取消");
    expect(result.maxDisplaySeverity).toBeNull();
    expect(result.unknownConditions).toEqual([]);
  });
});

describe("briefing route integration smoke", () => {
  it("VPBS50 (線状降水帯発生) が processBriefing → critical frame になる", async () => {
    const { processBriefing } = await import(
      "../../src/engine/presentation/processors/process-briefing"
    );
    const { fromBriefingOutcome } = await import(
      "../../src/engine/presentation/events/from-briefing"
    );

    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    const outcome = processBriefing(msg);
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("briefing");
    expect(outcome!.statsCategory).toBe("briefing");
    expect(outcome!.presentation.notifyCategory).toBe("briefing");
    expect(outcome!.presentation.frameLevel).toBe("critical");
    // 2026-06-12 レビュー決定: 特別警報級でも特別警報の名を持たなければ音は warning
    expect(outcome!.presentation.soundLevel).toBe("warning");

    const event = fromBriefingOutcome(outcome!);
    expect(event.domain).toBe("briefing");
    expect(event.type).toBe("VPBS50");
    expect(event.isWarning).toBe(true);
  });

  it("VPBS50 (短時間大雪) は frameLevel=warning かつ event.isWarning=true", async () => {
    const { processBriefing } = await import(
      "../../src/engine/presentation/processors/process-briefing"
    );
    const { fromBriefingOutcome } = await import(
      "../../src/engine/presentation/events/from-briefing"
    );

    const msg = createMockWsDataMessage(FIXTURE_VPBS50_SHORT_SNOW);
    const outcome = processBriefing(msg);
    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("warning");

    const event = fromBriefingOutcome(outcome!);
    // shortSnow も frameLevel=warning なので isWarning=true
    expect(event.isWarning).toBe(true);
  });

  it("VPBS50 (情報タグ由来 unknownConditions) は出口で warning 級に昇格する (frame/sound/event)", async () => {
    const { processBriefing } = await import(
      "../../src/engine/presentation/processors/process-briefing"
    );
    const { fromBriefingOutcome } = await import(
      "../../src/engine/presentation/events/from-briefing"
    );

    const msg = createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_UNKNOWN);
    const outcome = processBriefing(msg);
    expect(outcome).not.toBeNull();
    // maxDisplaySeverity=null だが unknownConditions があるため出口で warning へ昇格
    expect(outcome!.presentation.frameLevel).toBe("warning");
    expect(outcome!.presentation.soundLevel).toBe("warning");

    const event = fromBriefingOutcome(outcome!);
    expect(event.isWarning).toBe(true);
  });

  // message-router の dynamic import が engine 全体のモジュールグラフを引くため、
  // 並列実行時は既定 5 秒に収まらないことがある (単体では 1 秒未満)
  it("createMessageHandler 経由で VPBS50 が weather→briefing ルートに乗る", { timeout: 30_000 }, async () => {
    const { createMessageHandler } = await import(
      "../../src/engine/messages/message-router"
    );
    const { handler, stats } = createMessageHandler();
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);

    handler(msg);

    // stats に "briefing" カテゴリで記録されている
    const snapshot = stats.getSnapshot();
    const category = snapshot.categoryByType.get("VPBS50");
    expect(category).toBe("briefing");
    expect(snapshot.countByType.get("VPBS50")).toBe(1);
  });
});

describe("parseWeatherBriefing acceptance boundary", () => {
  it.each([
    ["Head", "<Report />"],
    ["InfoType", "<Report><Head><Title>test</Title></Head></Report>"],
    ["Title", "<Report><Head><InfoType>test</InfoType></Head></Report>"],
  ])("returns null when %s is missing", (_, xml) => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    msg.body = encodeXml(xml);

    expect(parseWeatherBriefing(msg)).toBeNull();
  });

  it("returns null for a non-briefing header type", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED);
    msg.head.type = "VPWW55";

    expect(parseWeatherBriefing(msg)).toBeNull();
  });
});
