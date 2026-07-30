import { describe, it, expect } from "vitest";
import {
  weatherFrameLevel,
  eewFrameLevel,
  earthquakeFrameLevel,
  tsunamiFrameLevel,
  seismicTextFrameLevel,
  nankaiTroughFrameLevel,
  lgObservationFrameLevel,
  weatherExplanationFrameLevel,
  eewSoundLevel,
  earthquakeSoundLevel,
  tsunamiSoundLevel,
  seismicTextSoundLevel,
  nankaiTroughSoundLevel,
  lgObservationSoundLevel,
  weatherSoundLevel,
  tornadoFrameLevel,
  tornadoSoundLevel,
  briefingFrameLevel,
  briefingSoundLevel,
  earlyWeatherFrameLevel,
  earlyWeatherSoundLevel,
  climateInfoSoundLevel,
  weatherExplanationSoundLevel,
  weatherWarningTimeseriesSoundLevel,
  weatherWarningTimeseriesFrameLevel,
  heatAlertFrameLevel,
  heatAlertSoundLevel,
  resolveTyphoonAnalysisLevels,
} from "../../../src/engine/presentation/level-helpers";
import { parseEarlyWeather } from "../../../src/dmdata/early-weather-parser";
import { parseWeatherExplanation } from "../../../src/dmdata/weather-explanation-parser";
import { parseHeatAlert } from "../../../src/dmdata/heat-alert-parser";
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
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_TITLE_ESCALATION,
} from "../../helpers/mock-message";
import {
  computeMaxDisplaySeverity,
  computeMaxSoundLevel,
  DISPLAY_SEVERITY_TO_SOUND_LEVEL,
} from "../../../src/dmdata/weather-warning-level";
import type { SoundLevel } from "../../../src/engine/notification/sound-player";
import type {
  DisplaySeverity,
  FrameLevel,
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  ParsedWeatherWarning,
  ParsedTornadoAdvisory,
  ParsedWeatherBriefing,
  ParsedEarlyWeatherInfo,
  ParsedClimateInfo,
  ParsedWeatherExplanation,
  ParsedWeatherWarningTimeseriesInfo,
} from "../../../src/types";

// ── helpers ──

function eew(overrides: Partial<ParsedEewInfo> = {}): ParsedEewInfo {
  return {
    type: "VXSE44",
    infoType: "発表",
    title: "緊急地震速報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    serial: "1",
    eventId: "20240101000000",
    isAssumedHypocenter: false,
    isTest: false,
    isWarning: false,
    ...overrides,
  };
}

function earthquake(
  overrides: Partial<ParsedEarthquakeInfo> = {},
): ParsedEarthquakeInfo {
  return {
    type: "VXSE53",
    infoType: "発表",
    title: "震源・震度情報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    eventId: null,
    isTest: false,
    ...overrides,
  };
}

function tsunami(
  overrides: Partial<ParsedTsunamiInfo> = {},
): ParsedTsunamiInfo {
  return {
    type: "VTSE41",
    infoType: "発表",
    title: "津波警報・注意報・予報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    warningComment: "",
    isTest: false,
    ...overrides,
  };
}

function seismicText(
  overrides: Partial<ParsedSeismicTextInfo> = {},
): ParsedSeismicTextInfo {
  return {
    type: "VXSE56",
    infoType: "発表",
    title: "地震の活動状況等に関する情報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    bodyText: "テスト",
    isTest: false,
    ...overrides,
  };
}

function nankaiTrough(
  overrides: Partial<ParsedNankaiTroughInfo> = {},
): ParsedNankaiTroughInfo {
  return {
    type: "VYSE50",
    infoType: "発表",
    title: "南海トラフ地震臨時情報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    bodyText: "テスト",
    isTest: false,
    ...overrides,
  };
}

function lgObservation(
  overrides: Partial<ParsedLgObservationInfo> = {},
): ParsedLgObservationInfo {
  return {
    type: "VXSE62",
    infoType: "発表",
    title: "長周期地震動に関する観測情報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    areas: [],
    isTest: false,
    ...overrides,
  };
}

// ── frameLevel tests ──

describe("eewFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(eewFrameLevel(eew({ infoType: "取消" }))).toBe("cancel");
  });

  it("returns critical for warning", () => {
    expect(eewFrameLevel(eew({ isWarning: true }))).toBe("critical");
  });

  it("returns warning for non-warning forecast", () => {
    expect(eewFrameLevel(eew({ isWarning: false }))).toBe("warning");
  });
});

describe("earthquakeFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(earthquakeFrameLevel(earthquake({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("returns critical for intensity 6弱 (rank 7)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "6弱", areas: [], municipalities: [] } }),
      ),
    ).toBe("critical");
  });

  it("returns critical for intensity 7 (rank 9)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "7", areas: [], municipalities: [] } }),
      ),
    ).toBe("critical");
  });

  it("returns warning for intensity 4 (rank 4)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "4", areas: [], municipalities: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for intensity 5弱 (rank 5)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "5弱", areas: [], municipalities: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns normal for intensity 3 (rank 3)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "3", areas: [], municipalities: [] } }),
      ),
    ).toBe("normal");
  });

  it("returns normal when no intensity", () => {
    expect(earthquakeFrameLevel(earthquake())).toBe("normal");
  });
});

describe("tsunamiFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(tsunamiFrameLevel(tsunami({ infoType: "取消" }))).toBe("cancel");
  });

  it("returns critical for 大津波警報", () => {
    expect(
      tsunamiFrameLevel(
        tsunami({
          forecast: [
            {
              areaName: "三陸沿岸",
              kind: "大津波警報",
              maxHeightDescription: "10m超",
              firstHeight: "すぐ来る",
            },
          ],
        }),
      ),
    ).toBe("critical");
  });

  it("returns warning for 津波警報", () => {
    expect(
      tsunamiFrameLevel(
        tsunami({
          forecast: [
            {
              areaName: "三陸沿岸",
              kind: "津波警報",
              maxHeightDescription: "3m",
              firstHeight: "すぐ来る",
            },
          ],
        }),
      ),
    ).toBe("warning");
  });

  it("returns normal for 津波注意報", () => {
    expect(
      tsunamiFrameLevel(
        tsunami({
          forecast: [
            {
              areaName: "三陸沿岸",
              kind: "津波注意報",
              maxHeightDescription: "1m",
              firstHeight: "すぐ来る",
            },
          ],
        }),
      ),
    ).toBe("normal");
  });

  it("returns normal when no forecast", () => {
    expect(tsunamiFrameLevel(tsunami())).toBe("normal");
  });
});

describe("seismicTextFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(seismicTextFrameLevel(seismicText({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("returns info for normal", () => {
    expect(seismicTextFrameLevel(seismicText())).toBe("info");
  });
});

describe("nankaiTroughFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(nankaiTroughFrameLevel(nankaiTrough({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("returns warning when no infoSerial", () => {
    expect(nankaiTroughFrameLevel(nankaiTrough())).toBe("warning");
  });

  it("returns critical for code 120", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "巨大地震警戒", code: "120" } }),
      ),
    ).toBe("critical");
  });

  it("returns warning for code 130", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "巨大地震注意", code: "130" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for code 111", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "調査中", code: "111" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for code 112", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "調査中", code: "112" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for code 113", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "調査中", code: "113" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for code 210", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "定例", code: "210" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for code 219", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "定例", code: "219" } }),
      ),
    ).toBe("warning");
  });

  it("returns info for code 190", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "解除", code: "190" } }),
      ),
    ).toBe("info");
  });

  it("returns info for code 200", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "定例", code: "200" } }),
      ),
    ).toBe("info");
  });

  it("returns warning for unknown code", () => {
    expect(
      nankaiTroughFrameLevel(
        nankaiTrough({ infoSerial: { name: "不明", code: "999" } }),
      ),
    ).toBe("warning");
  });
});

describe("lgObservationFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(lgObservationFrameLevel(lgObservation({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("returns critical for lgInt 4", () => {
    expect(lgObservationFrameLevel(lgObservation({ maxLgInt: "4" }))).toBe(
      "critical",
    );
  });

  it("returns warning for lgInt 3", () => {
    expect(lgObservationFrameLevel(lgObservation({ maxLgInt: "3" }))).toBe(
      "warning",
    );
  });

  it("returns normal for lgInt 2", () => {
    expect(lgObservationFrameLevel(lgObservation({ maxLgInt: "2" }))).toBe(
      "normal",
    );
  });

  it("returns info for lgInt 1", () => {
    expect(lgObservationFrameLevel(lgObservation({ maxLgInt: "1" }))).toBe(
      "info",
    );
  });

  it("returns info when no maxLgInt", () => {
    expect(lgObservationFrameLevel(lgObservation())).toBe("info");
  });
});

function weatherExplanationStub(
  overrides: Partial<ParsedWeatherExplanation> = {},
): ParsedWeatherExplanation {
  return {
    type: "VPCJ51",
    infoType: "発表",
    title: "地方気象解説情報",
    controlTitle: "地方気象解説情報",
    reportDateTime: "2024-01-01T00:00:00+09:00",
    targetDateTime: null,
    validDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁本庁",
    eventId: null,
    serial: null,
    informationTags: [],
    targetAreas: [],
    sections: [],
    isTest: false,
    ...overrides,
  } as ParsedWeatherExplanation;
}

describe("weatherExplanationFrameLevel", () => {
  it("returns cancel for 取消", () => {
    expect(
      weatherExplanationFrameLevel(
        weatherExplanationStub({ infoType: "取消" }),
      ),
    ).toBe("cancel");
  });

  it("returns normal for 発表 (VPZJ51 台風 Headline でも normal 固定)", () => {
    expect(weatherExplanationFrameLevel(weatherExplanationStub())).toBe(
      "normal",
    );
  });

  it("returns normal for 更新", () => {
    expect(
      weatherExplanationFrameLevel(
        weatherExplanationStub({ infoType: "更新" }),
      ),
    ).toBe("normal");
  });
});

// ── soundLevel tests ──

describe("eewSoundLevel", () => {
  it("returns critical for warning", () => {
    expect(eewSoundLevel(eew({ isWarning: true }))).toBe("critical");
  });

  it("returns warning for forecast", () => {
    expect(eewSoundLevel(eew({ isWarning: false }))).toBe("warning");
  });
});

describe("earthquakeSoundLevel", () => {
  it("returns warning for intensity rank >= 4", () => {
    expect(
      earthquakeSoundLevel(
        earthquake({ intensity: { maxInt: "4", areas: [], municipalities: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for intensity 5強 (rank 6)", () => {
    expect(
      earthquakeSoundLevel(
        earthquake({ intensity: { maxInt: "5強", areas: [], municipalities: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns normal for intensity rank < 4", () => {
    expect(
      earthquakeSoundLevel(
        earthquake({ intensity: { maxInt: "3", areas: [], municipalities: [] } }),
      ),
    ).toBe("normal");
  });

  it("returns normal when no intensity", () => {
    expect(earthquakeSoundLevel(earthquake())).toBe("normal");
  });
});

describe("tsunamiSoundLevel", () => {
  it("returns cancel for 取消 even when forecast remains", () => {
    expect(
      tsunamiSoundLevel(
        tsunami({
          infoType: "取消",
          forecast: [
            {
              areaName: "三重県南部",
              kind: "大津波警報",
              maxHeightDescription: "10m超",
              firstHeight: "すぐ来る",
            },
          ],
        }),
      ),
    ).toBe("cancel");
  });

  it("returns critical when forecast has 津波 (not 解除)", () => {
    expect(
      tsunamiSoundLevel(
        tsunami({
          forecast: [
            {
              areaName: "三陸沿岸",
              kind: "津波警報",
              maxHeightDescription: "3m",
              firstHeight: "すぐ来る",
            },
          ],
        }),
      ),
    ).toBe("critical");
  });

  it("returns warning when forecast has 解除", () => {
    expect(
      tsunamiSoundLevel(
        tsunami({
          forecast: [
            {
              areaName: "三陸沿岸",
              kind: "津波警報解除",
              maxHeightDescription: "",
              firstHeight: "",
            },
          ],
        }),
      ),
    ).toBe("warning");
  });

  it("returns normal when no forecast", () => {
    expect(tsunamiSoundLevel(tsunami())).toBe("normal");
  });

  it("returns normal when forecast is empty array", () => {
    expect(tsunamiSoundLevel(tsunami({ forecast: [] }))).toBe("normal");
  });
});

describe("seismicTextSoundLevel", () => {
  it("always returns info", () => {
    expect(seismicTextSoundLevel(seismicText())).toBe("info");
  });
});

describe("nankaiTroughSoundLevel", () => {
  it("returns critical for code 120", () => {
    expect(
      nankaiTroughSoundLevel(
        nankaiTrough({ infoSerial: { name: "巨大地震警戒", code: "120" } }),
      ),
    ).toBe("critical");
  });

  it("returns warning for other codes", () => {
    expect(
      nankaiTroughSoundLevel(
        nankaiTrough({ infoSerial: { name: "巨大地震注意", code: "130" } }),
      ),
    ).toBe("warning");
  });

  it("returns warning when no infoSerial", () => {
    expect(nankaiTroughSoundLevel(nankaiTrough())).toBe("warning");
  });
});

describe("lgObservationSoundLevel", () => {
  it("returns critical for lgInt 4", () => {
    expect(lgObservationSoundLevel(lgObservation({ maxLgInt: "4" }))).toBe(
      "critical",
    );
  });

  it("returns critical for lgInt 3", () => {
    expect(lgObservationSoundLevel(lgObservation({ maxLgInt: "3" }))).toBe(
      "critical",
    );
  });

  it("returns warning for lgInt 2", () => {
    expect(lgObservationSoundLevel(lgObservation({ maxLgInt: "2" }))).toBe(
      "warning",
    );
  });

  it("returns warning for lgInt 1", () => {
    expect(lgObservationSoundLevel(lgObservation({ maxLgInt: "1" }))).toBe(
      "warning",
    );
  });

  it("returns normal when no maxLgInt", () => {
    expect(lgObservationSoundLevel(lgObservation())).toBe("normal");
  });
});

// ── 取消 SoundLevel 横展開回帰テスト (Codex VPCJ51-R2 由来) ──
//
// VPCJ51 R2 で「取消時 soundLevel が "info" のまま」が指摘され、
// presentation 層と通知本体の整合のため "cancel" に統一した。
// 同パターンの 7 helper (weather/tornado/briefing/timeseries/earlyWeather/
// climateInfo/weatherExplanation) すべてが取消で "cancel" を返すことを固定する。

describe("weather 系 7 sound level: 取消は cancel に統一されている", () => {
  function weather(
    overrides: Partial<ParsedWeatherWarning> = {},
  ): ParsedWeatherWarning {
    return {
      type: "VPWW55",
      infoType: "発表",
      title: "気象警報・注意報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      areas: [],
      warningAreaCount: 0,
      advisoryAreaCount: 0,
      maxSeverity: "advisory",
      maxSoundLevel: null,
      isTest: false,
      ...overrides,
    } as ParsedWeatherWarning;
  }

  function tornado(
    overrides: Partial<ParsedTornadoAdvisory> = {},
  ): ParsedTornadoAdvisory {
    return {
      type: "VPHW50",
      infoType: "発表",
      title: "竜巻注意情報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      validDateTime: null,
      areas: [],
      activeAreas: [],
      sightingAreas: [],
      activeAreaCount: 0,
      hasSightingAreas: false,
      isSightingTelegram: false,
      // Phase D: 表示重大度 / 通知音 (表示と独立) の既定値。テストごとに上書きする
      displaySeverity: null,
      soundLevel: null,
      isTest: false,
      ...overrides,
    } as ParsedTornadoAdvisory;
  }

  function briefing(
    overrides: Partial<ParsedWeatherBriefing> = {},
  ): ParsedWeatherBriefing {
    return {
      type: "VPBS50",
      infoType: "発表",
      title: "気象防災速報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      briefingCondition: null,
      briefingTag: null,
      // Phase D: 集合ベースの新フィールド既定値。テストごとに上書きする
      briefingConditions: [],
      briefingSeverityEvidence: [],
      maxDisplaySeverity: null,
      maxSoundLevel: null,
      unknownConditions: [],
      targetAreas: [],
      observations: [],
      bodyText: "",
      isTest: false,
      ...overrides,
    } as ParsedWeatherBriefing;
  }

  function earlyWeather(
    overrides: Partial<ParsedEarlyWeatherInfo> = {},
  ): ParsedEarlyWeatherInfo {
    return {
      type: "VPAW51",
      infoType: "発表",
      title: "早期天候情報",
      controlTitle: "早期天候情報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      targetDateTime: null,
      targetDuration: null,
      validDateTime: null,
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁本庁",
      eventId: null,
      serial: null,
      headlineConditions: [],
      targetArea: null,
      phenomena: [],
      bodyTexts: [],
      isTest: false,
      ...overrides,
    } as ParsedEarlyWeatherInfo;
  }

  function climateInfo(
    overrides: Partial<ParsedClimateInfo> = {},
  ): ParsedClimateInfo {
    return {
      type: "VPZI50",
      infoType: "発表",
      title: "全般天候情報",
      controlTitle: "全般天候情報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      targetDateTime: null,
      validDateTime: null,
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁本庁",
      eventId: null,
      serial: null,
      targetArea: null,
      bodyTexts: [],
      stations: [],
      seasonEvents: [],
      comment: null,
      isTest: false,
      ...overrides,
    } as ParsedClimateInfo;
  }

  function timeseries(
    overrides: Partial<ParsedWeatherWarningTimeseriesInfo> = {},
  ): ParsedWeatherWarningTimeseriesInfo {
    return {
      type: "VPWP50",
      infoType: "発表",
      title: "気象警報・注意報時系列情報",
      reportDateTime: "2024-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      targetArea: null,
      areas: [],
      maxKnownSignificancy: null,
      maxDisplaySeverity: null,
      maxDisplayRankSignificancy: null,
      maxSoundLevel: null,
      unknownCodes: [],
      isTest: false,
      ...overrides,
    } as ParsedWeatherWarningTimeseriesInfo;
  }

  it("weatherSoundLevel: 取消 → cancel", () => {
    expect(weatherSoundLevel(weather({ infoType: "取消" }))).toBe("cancel");
  });

  it("tornadoSoundLevel: 取消 → cancel", () => {
    expect(tornadoSoundLevel(tornado({ infoType: "取消" }))).toBe("cancel");
  });

  it("briefingSoundLevel: 取消 → cancel", () => {
    expect(briefingSoundLevel(briefing({ infoType: "取消" }))).toBe("cancel");
  });

  it("earlyWeatherSoundLevel: 取消 → cancel", () => {
    expect(earlyWeatherSoundLevel(earlyWeather({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("climateInfoSoundLevel: 取消 → cancel", () => {
    expect(climateInfoSoundLevel(climateInfo({ infoType: "取消" }))).toBe(
      "cancel",
    );
  });

  it("weatherExplanationSoundLevel: 取消 → cancel", () => {
    expect(
      weatherExplanationSoundLevel(weatherExplanationStub({ infoType: "取消" })),
    ).toBe("cancel");
  });

  it("weatherWarningTimeseriesSoundLevel: 取消 → cancel", () => {
    expect(
      weatherWarningTimeseriesSoundLevel(timeseries({ infoType: "取消" })),
    ).toBe("cancel");
  });

  // ── Phase B: maxDisplaySeverity ベースの frame/sound 判定 ──

  it("Phase B: L4 相当 (officialL4) は critical (VPWW と整合) — frame", () => {
    const info = timeseries({ maxDisplaySeverity: "officialL4" });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
  });

  // 2026-06-12 目視ゲートでレビュー決定: 通知音は特別警報級 (officialL5/nonLevelSpecial) のみ
  // critical。officialL4 は表示 (frame) critical のまま音だけ warning に分離。
  // 音は parser が集合ベースで導出する maxSoundLevel を見る (共存エッジ解消後)。
  it("officialL4 の音は warning (表示 critical と分離、2026-06-12 レビュー決定)", () => {
    const info = timeseries({ maxDisplaySeverity: "officialL4", maxSoundLevel: "warning" });
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("warning");
  });

  it("Phase B: L5/特別警報級 → critical (音も critical を維持)", () => {
    for (const ds of ["officialL5", "nonLevelSpecial"] as const) {
      expect(
        weatherWarningTimeseriesFrameLevel(timeseries({ maxDisplaySeverity: ds })),
      ).toBe("critical");
      expect(
        weatherWarningTimeseriesSoundLevel(
          timeseries({ maxDisplaySeverity: ds, maxSoundLevel: "critical" }),
        ),
      ).toBe("critical");
    }
  });

  it("Phase B: L3/警報級 → warning", () => {
    for (const ds of ["officialL3", "nonLevelWarning"] as const) {
      expect(
        weatherWarningTimeseriesFrameLevel(timeseries({ maxDisplaySeverity: ds })),
      ).toBe("warning");
      expect(
        weatherWarningTimeseriesSoundLevel(
          timeseries({ maxDisplaySeverity: ds, maxSoundLevel: "warning" }),
        ),
      ).toBe("warning");
    }
  });

  it("Phase B: L2/注意報級 → normal", () => {
    for (const ds of ["officialL2", "nonLevelAdvisory"] as const) {
      expect(
        weatherWarningTimeseriesFrameLevel(timeseries({ maxDisplaySeverity: ds })),
      ).toBe("normal");
      expect(
        weatherWarningTimeseriesSoundLevel(
          timeseries({ maxDisplaySeverity: ds, maxSoundLevel: "normal" }),
        ),
      ).toBe("normal");
    }
  });

  it("Phase B: maxDisplaySeverity=null (maxSoundLevel=null) → info", () => {
    const info = timeseries({ maxDisplaySeverity: null, maxSoundLevel: null });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("info");
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("info");
  });

  it("Phase B: 取消は maxDisplaySeverity より優先 → cancel/frame", () => {
    const info = timeseries({ infoType: "取消", maxDisplaySeverity: "officialL4" });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("cancel");
  });

  it("Phase B: 未知 Code は warning 昇格を維持 (本体最大が低くても)", () => {
    const info = timeseries({
      maxDisplaySeverity: "nonLevelAdvisory",
      maxSoundLevel: "normal",
      unknownCodes: [
        { propertyType: "雷", areaName: "X", code: "87", timeRef: "1" },
      ] as never,
    });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("warning");
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("warning");
  });

  // 2026-06-12 共存エッジ解消: 音は集合ベース maxSoundLevel を見る。
  // Code 41 (officialL4) + 50 (nonLevelSpecial) 共存 = 表示代表 officialL4 / 音 critical
  it("共存: maxDisplaySeverity=officialL4 でも maxSoundLevel=critical なら音は critical (特別警報側が勝つ)", () => {
    const info = timeseries({
      maxDisplaySeverity: "officialL4",
      maxSoundLevel: "critical",
    });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("critical");
  });

  it("共存 + 未知 Code: warning 昇格ガードより critical が勝つ", () => {
    const info = timeseries({
      maxDisplaySeverity: "officialL4",
      maxSoundLevel: "critical",
      unknownCodes: [
        { propertyType: "雷", areaName: "X", code: "87", timeRef: "1" },
      ] as never,
    });
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("critical");
    // 2026-06-12 降格バグ修正: frame も音側ガードと同型 (critical を潰さない)。
    // 旧実装は unknownCodes 非空で本体最大より先に warning を return していた
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
  });

  it("共存 + 未知 Code: L5/特別警報級の frame も warning に降格しない (2026-06-12 修正)", () => {
    for (const ds of ["officialL5", "nonLevelSpecial"] as const) {
      const info = timeseries({
        maxDisplaySeverity: ds,
        maxSoundLevel: "critical",
        unknownCodes: [
          { propertyType: "雷", areaName: "X", code: "87", timeRef: "1" },
        ] as never,
      });
      expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
    }
  });

  it("共存 + 未知 Code: 本体 warning 級 (officialL3) は warning のまま (二重昇格しない)", () => {
    const info = timeseries({
      maxDisplaySeverity: "officialL3",
      maxSoundLevel: "warning",
      unknownCodes: [
        { propertyType: "雷", areaName: "X", code: "87", timeRef: "1" },
      ] as never,
    });
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("warning");
  });

  it("未知 Code のみ (maxSoundLevel=null): warning 昇格 (見落とし防止ガード据置)", () => {
    const info = timeseries({
      maxDisplaySeverity: null,
      maxSoundLevel: null,
      unknownCodes: [
        { propertyType: "雷", areaName: "X", code: "87", timeRef: "1" },
      ] as never,
    });
    expect(weatherWarningTimeseriesSoundLevel(info)).toBe("warning");
    // 降格バグ修正後も「本体なし + 未知 Code → warning 昇格」(base=info からの昇格) は不変
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("warning");
  });

  // ── Phase D: briefing/tornado を parser 段の displaySeverity ベースに ──
  //
  // briefingTag / hasSightingAreas の switch を捨て、parser が導出した
  // maxDisplaySeverity / displaySeverity (表示) と maxSoundLevel / soundLevel (音) を
  // 単一真実源にする。これにより表示 critical のまま音 warning が成立する
  // (2026-06-12 レビュー決定: 線状降水帯発生・記録雨・竜巻目撃の音は warning)。

  describe("Phase D: briefing/tornado displaySeverity ベース", () => {
    it("briefing maxDisplaySeverity=nonLevelSpecial → frame critical / 音 warning", () => {
      const info = briefing({ maxDisplaySeverity: "nonLevelSpecial", maxSoundLevel: "warning" });
      expect(briefingFrameLevel(info)).toBe("critical");
      expect(briefingSoundLevel(info)).toBe("warning");
    });

    it("briefing unknownConditions 非空 → 最低 warning へ昇格 (frame/sound とも)", () => {
      const info = briefing({ maxDisplaySeverity: null, maxSoundLevel: null, unknownConditions: ["謎の現象"] });
      expect(briefingFrameLevel(info)).toBe("warning");
      expect(briefingSoundLevel(info)).toBe("warning");
    });

    it("briefing unknown と nonLevelSpecial の共存では critical 表示が勝つ", () => {
      const info = briefing({
        maxDisplaySeverity: "nonLevelSpecial", maxSoundLevel: "warning", unknownConditions: ["謎の現象"],
      });
      expect(briefingFrameLevel(info)).toBe("critical");
    });

    it("briefing max 系 null (対象なし) → info / 取消 → cancel", () => {
      expect(briefingFrameLevel(briefing({}))).toBe("info");
      expect(briefingSoundLevel(briefing({}))).toBe("info");
      expect(briefingFrameLevel(briefing({ infoType: "取消" }))).toBe("cancel");
      expect(briefingSoundLevel(briefing({ infoType: "取消" }))).toBe("cancel");
    });

    it("tornado displaySeverity=nonLevelSpecial → frame critical / 音 warning、null → info", () => {
      const sighting = tornado({ displaySeverity: "nonLevelSpecial", soundLevel: "warning" });
      expect(tornadoFrameLevel(sighting)).toBe("critical");
      expect(tornadoSoundLevel(sighting)).toBe("warning");
      expect(tornadoFrameLevel(tornado({}))).toBe("info");
      expect(tornadoSoundLevel(tornado({ infoType: "取消" }))).toBe("cancel");
    });
  });
});

// ── Phase C: VPWW55-61/VPWS50 の frame/sound を displaySeverity ベース化 ──
//
// maxDisplaySeverity と infoType だけが意味を持つ最小 mock で
// DISPLAY_SEVERITY_TO_FRAME_LEVEL の全行を網羅する (通知割れ解消、Codex P0)。

describe("weatherFrameLevel / weatherSoundLevel 表テスト (Phase C)", () => {
  function buildMinimalInfo(over: {
    maxDisplaySeverity: DisplaySeverity | null;
    infoType: string;
    maxSoundLevel?: SoundLevel | null;
  }): ParsedWeatherWarning {
    return {
      type: "VPWW55",
      infoType: over.infoType,
      title: "気象警報・注意報",
      reportDateTime: "2026-06-12T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁本庁",
      controlTitle: "気象警報・注意報",
      layers: [],
      comments: [],
      maxSeverity: "unknown",
      maxDisplaySeverity: over.maxDisplaySeverity,
      // 単一 severity の電文では parser の集合ベース maxSoundLevel は
      // DISPLAY_SEVERITY_TO_SOUND_LEVEL[maxDisplaySeverity] と一致する (それを既定値に)
      maxSoundLevel:
        over.maxSoundLevel !== undefined
          ? over.maxSoundLevel
          : over.maxDisplaySeverity == null
            ? null
            : DISPLAY_SEVERITY_TO_SOUND_LEVEL[over.maxDisplaySeverity],
      warningAreaCount: 0,
      advisoryAreaCount: 0,
      isTest: false,
    };
  }

  const frameCases: Array<[DisplaySeverity | null, FrameLevel]> = [
    ["officialL5", "critical"],
    ["officialL4", "critical"],
    ["nonLevelSpecial", "critical"],
    ["officialL3", "warning"],
    ["nonLevelWarning", "warning"],
    ["officialL2", "normal"],
    ["nonLevelAdvisory", "normal"],
    ["officialL1", "info"],
    ["unknown", "info"],
    [null, "info"],
  ];

  it.each(frameCases)("frame: maxDisplaySeverity=%s → %s (表示は据置)", (ds, expected) => {
    const info = buildMinimalInfo({ maxDisplaySeverity: ds, infoType: "発表" });
    expect(weatherFrameLevel(info)).toBe(expected);
  });

  // 2026-06-12 目視ゲートでレビュー決定: 気象警報・注意報系は通知項目が多いため、
  // critical 音は特別警報級 (officialL5/nonLevelSpecial) のみに限定。
  // officialL4 (土砂災害警戒情報・危険警報等) は表示 critical のまま音だけ warning。
  const soundCases: Array<[DisplaySeverity | null, SoundLevel]> = [
    ["officialL5", "critical"],
    ["nonLevelSpecial", "critical"],
    ["officialL4", "warning"],
    ["officialL3", "warning"],
    ["nonLevelWarning", "warning"],
    ["officialL2", "normal"],
    ["nonLevelAdvisory", "normal"],
    ["officialL1", "info"],
    ["unknown", "info"],
    [null, "info"],
  ];

  it.each(soundCases)("sound: maxDisplaySeverity=%s → %s (特別警報級のみ critical)", (ds, expected) => {
    const info = buildMinimalInfo({ maxDisplaySeverity: ds, infoType: "発表" });
    expect(weatherSoundLevel(info)).toBe(expected);
  });

  it("取消は frame/sound とも cancel (maxDisplaySeverity より優先)", () => {
    const info = buildMinimalInfo({
      maxDisplaySeverity: "officialL5",
      infoType: "取消",
    });
    expect(weatherFrameLevel(info)).toBe("cancel");
    expect(weatherSoundLevel(info)).toBe("cancel");
  });

  // ── 2026-06-12 共存エッジ解消 (visual-gate 章 10) の核心テスト ──
  //
  // Code 49 (土砂災害警戒情報 = officialL4, rank 90) と Code 35 (暴風特別警報 =
  // nonLevelSpecial, rank 85) が共存すると、maxDisplaySeverity (rank 1 点代表) は
  // officialL4。旧実装はこれを DISPLAY_SEVERITY_TO_SOUND_LEVEL に通すため音が warning に
  // 潰れていた。集合ベース maxSoundLevel では特別警報側の critical が勝つ
  // (レビュー決定「特別警報級は critical 音」の充足)。
  it("Code 49 + Code 35 共存: 音は critical (特別警報側が勝つ)、表示は critical 据置", () => {
    const layers = [
      {
        type: "気象警報・注意報（府県予報区等）",
        items: [
          {
            areaName: "テスト県",
            areaCode: "999999",
            kinds: [
              { name: "土砂災害警戒情報", code: "49", severity: "warning" as const },
              { name: "暴風特別警報", code: "35", severity: "specialWarning" as const },
            ],
            statuses: [],
          },
        ],
      },
    ];
    const info = buildMinimalInfo({
      maxDisplaySeverity: computeMaxDisplaySeverity(layers),
      maxSoundLevel: computeMaxSoundLevel(layers),
      infoType: "発表",
    });
    // 前提の固定: 表示代表は rank 上位の officialL4
    expect(info.maxDisplaySeverity).toBe("officialL4");
    // 表示は L4 も critical (従来どおり)
    expect(weatherFrameLevel(info)).toBe("critical");
    // 音は集合ベースで特別警報級の critical (修正前は warning に潰れていた)
    expect(weatherSoundLevel(info)).toBe("critical");
  });
});

// ── Phase D 契約: VPAW51/気象解説は内容によらず一律 normal (2026-06-12 レビュー決定) ──
//
// 実装変更なし。現在の earlyWeatherFrameLevel/earlyWeatherSoundLevel/
// weatherExplanationFrameLevel/weatherExplanationSoundLevel が既に一律 normal を
// 返すことを実 fixture で固定し、将来の Headline キーワード解釈による誤昇格を
// テスト差分で検出できるようにする。

describe("Phase D 契約: VPAW51/気象解説は内容によらず一律 normal (2026-06-12 レビュー決定)", () => {
  const earlyFixtures = [
    FIXTURE_VPAW51_HIGH_TEMP,
    FIXTURE_VPAW51_LOW_TEMP,
    FIXTURE_VPAW51_HEAVY_SNOW,
    FIXTURE_VPAW51_SNOW,
    FIXTURE_VPAW51_LOWTEMP_HEAVYSNOW,
    FIXTURE_VPAW51_LOWTEMP_SNOW,
    FIXTURE_VPAW51_HIGHTEMP_HEAVYSNOW,
    FIXTURE_VPAW51_HIGHTEMP_SNOW,
  ];
  it.each(earlyFixtures)("VPAW51 %s: frame/sound = normal", (fx) => {
    const info = parseEarlyWeather(createMockWsDataMessage(fx))!;
    expect(info.infoType).not.toBe("取消"); // 取消 fixture が混ざったら前提から見直す
    expect(earlyWeatherFrameLevel(info)).toBe("normal");
    expect(earlyWeatherSoundLevel(info)).toBe("normal");
  });

  const explanationFixtures = [
    FIXTURE_VPCJ51_KANTO_SNOW,
    FIXTURE_VPCJ51_TOHOKU_HOT,
    FIXTURE_VPZJ51_SENJOU,
    FIXTURE_VPZJ51_SENJOU_2,
    FIXTURE_VPZJ51_TYPHOON,
    FIXTURE_VPFJ51_KANTO,
    FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL,
    FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE,
    FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE,
    // VMCJ53-55 気象解説情報（潮位）も同契約 (副振動 80cm でも normal 固定)
    FIXTURE_VMCJ53_OSHIO,
    FIXTURE_VMCJ54_OSHIO,
    FIXTURE_VMCJ55_FUKUSHINDO,
    FIXTURE_VMCJ55_OSHIO_CHIBA,
  ];
  it.each(explanationFixtures)("気象解説 %s: frame/sound = normal", (fx) => {
    const info = parseWeatherExplanation(createMockWsDataMessage(fx))!;
    expect(weatherExplanationFrameLevel(info)).toBe("normal");
    expect(weatherExplanationSoundLevel(info)).toBe("normal");
  });
});

describe("VPFT50 契約: 入力ケース別の frame/sound 表 (2026-06-12 設計確定)", () => {
  const cases: Array<{
    label: string;
    fixture: string;
    frame: FrameLevel;
    sound: SoundLevel;
  }> = [
    // 通常の発表 = 表示 warning / 音 warning (nonLevelWarning 相当)
    {
      label: "発表",
      fixture: FIXTURE_VPFT50_SAITAMA,
      frame: "warning",
      sound: "warning",
    },
    // タイトル昇格フェイルセーフ = 表示 critical / 音 warning
    // (音の原則: critical 音 = 特別警報そのもののみ)
    {
      label: "題名昇格",
      fixture: FIXTURE_VPFT50_TITLE_ESCALATION,
      frame: "critical",
      sound: "warning",
    },
    {
      label: "取消",
      fixture: FIXTURE_VPFT50_CANCEL,
      frame: "cancel",
      sound: "cancel",
    },
  ];
  it.each(cases)("$label: frame=$frame / sound=$sound", ({ fixture, frame, sound }) => {
    const info = parseHeatAlert(createMockWsDataMessage(fixture))!;
    expect(heatAlertFrameLevel(info)).toBe(frame);
    expect(heatAlertSoundLevel(info)).toBe(sound);
  });

  it("取消はタイトル昇格より優先される", () => {
    const info = parseHeatAlert(
      createMockWsDataMessage(FIXTURE_VPFT50_TITLE_ESCALATION),
    )!;
    const cancelled = { ...info, infoType: "取消" };
    expect(heatAlertFrameLevel(cancelled)).toBe("cancel");
    expect(heatAlertSoundLevel(cancelled)).toBe("cancel");
  });
});

describe("resolveTyphoonAnalysisLevels", () => {
  it("発表 → frame/sound とも normal", () => {
    expect(resolveTyphoonAnalysisLevels({ infoType: "発表" }))
      .toEqual({ frameLevel: "normal", soundLevel: "normal" });
  });
  it("取消 → frame/sound とも cancel", () => {
    expect(resolveTyphoonAnalysisLevels({ infoType: "取消" }))
      .toEqual({ frameLevel: "cancel", soundLevel: "cancel" });
  });
});
