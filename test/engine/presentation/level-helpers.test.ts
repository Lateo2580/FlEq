import { describe, it, expect } from "vitest";
import {
  eewFrameLevel,
  earthquakeFrameLevel,
  tsunamiFrameLevel,
  seismicTextFrameLevel,
  nankaiTroughFrameLevel,
  lgObservationFrameLevel,
  eewSoundLevel,
  earthquakeSoundLevel,
  tsunamiSoundLevel,
  seismicTextSoundLevel,
  nankaiTroughSoundLevel,
  lgObservationSoundLevel,
} from "../../../src/engine/presentation/level-helpers";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
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
        earthquake({ intensity: { maxInt: "6弱", areas: [] } }),
      ),
    ).toBe("critical");
  });

  it("returns critical for intensity 7 (rank 9)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "7", areas: [] } }),
      ),
    ).toBe("critical");
  });

  it("returns warning for intensity 4 (rank 4)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "4", areas: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for intensity 5弱 (rank 5)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "5弱", areas: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns normal for intensity 3 (rank 3)", () => {
    expect(
      earthquakeFrameLevel(
        earthquake({ intensity: { maxInt: "3", areas: [] } }),
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
        earthquake({ intensity: { maxInt: "4", areas: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns warning for intensity 5強 (rank 6)", () => {
    expect(
      earthquakeSoundLevel(
        earthquake({ intensity: { maxInt: "5強", areas: [] } }),
      ),
    ).toBe("warning");
  });

  it("returns normal for intensity rank < 4", () => {
    expect(
      earthquakeSoundLevel(
        earthquake({ intensity: { maxInt: "3", areas: [] } }),
      ),
    ).toBe("normal");
  });

  it("returns normal when no intensity", () => {
    expect(earthquakeSoundLevel(earthquake())).toBe("normal");
  });
});

describe("tsunamiSoundLevel", () => {
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
