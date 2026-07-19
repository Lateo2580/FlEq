import { describe, it, expect } from "vitest";
import { resolveFloodForecastLevels } from "../../../src/engine/presentation/level-helpers";
import type { ParsedFloodForecastInfo, FloodKindCode, FloodLevel, FloodHeadline, FloodStation } from "../../../src/types";

function mkHeadline(kindCode: FloodKindCode, scope: FloodHeadline["scope"] = "河川"): FloodHeadline {
  return {
    scope,
    rawScopeLabel: scope,
    kindName: "kind",
    kindCode,
    headlineText: "headline",
    condition: "",
    areas: [],
  };
}

function mkStation(headlineKindCode: FloodKindCode): FloodStation {
  const codeToLevel: Record<FloodKindCode, FloodLevel> = {
    "10": "release", "20": "L2", "21": "L2", "30": "L3", "31": "L3",
    "40": "L4", "41": "L4", "51": "L5", "53": "L5", "unknown": "unknown",
  };
  const level = codeToLevel[headlineKindCode];
  return {
    stationName: "S",
    stationCode: "x",
    riverNames: [],
    primaryRiverCode: null,
    primaryRiverName: null,
    prefName: null,
    cityName: null,
    cityCode: null,
    location: null,
    measurement: "water_level",
    measurementUnit: "m",
    rawUnit: "m",
    series: [],
    criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
    stationObservedLevel: "unknown",
    headlineKindCode,
    headlineLevel: level,
    mainItemCode: null,
    mainTextHash: "",
  };
}

function mkInfo(opts: {
  infoType?: "発表" | "訂正" | "取消";
  headlineKindCodes?: FloodKindCode[];
  stationHeadlineCodes?: FloodKindCode[];
} = {}): ParsedFloodForecastInfo {
  return {
    schema: "vxko50", typeCode: "VXKO50",
    infoKind: "指定河川洪水予報", infoType: opts.infoType ?? "発表",
    serial: 1, eventId: "e1",
    controlTitle: "", headTitle: "",
    reportDateTime: "", targetDateTime: null,
    isTest: false, notice: null,
    headlines: (opts.headlineKindCodes ?? []).map(c => mkHeadline(c)),
    rawStations: (opts.stationHeadlineCodes ?? []).map(c => mkStation(c)),
    inundationAreas: [], rainfallSummaries: [], floodAssumptions: [],
    publishingOffice: "", editorialOffice: "",
  };
}

describe("resolveFloodForecastLevels", () => {
  it("取消パスは frame=cancel, sound=cancel, maxLevel=release, maxRank=5", () => {
    const info = mkInfo({ infoType: "取消" });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("cancel");
    expect(r.soundLevel).toBe("cancel");
    expect(r.maxLevel).toBe("release");
  });

  it("Code 10 (release) → frame=cancel, sound=cancel", () => {
    const info = mkInfo({ headlineKindCodes: ["10"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("cancel");
    expect(r.soundLevel).toBe("cancel");
    expect(r.maxLevel).toBe("release");
    expect(r.maxRank).toBe(5);
  });

  it("Code 20 (氾濫注意 = L2) → frame=normal, sound=normal", () => {
    const info = mkInfo({ headlineKindCodes: ["20"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("normal");
    expect(r.soundLevel).toBe("normal");
    expect(r.maxLevel).toBe("L2");
    expect(r.maxRank).toBe(20);
  });

  it("Code 21 (L2) → frame=normal, sound=normal", () => {
    const info = mkInfo({ headlineKindCodes: ["21"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("normal");
    expect(r.soundLevel).toBe("normal");
    expect(r.maxLevel).toBe("L2");
  });

  it("Code 30 (氾濫警戒 = L3) → frame=warning, sound=warning", () => {
    const info = mkInfo({ headlineKindCodes: ["30"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("warning");
    expect(r.soundLevel).toBe("warning");
    expect(r.maxLevel).toBe("L3");
    expect(r.maxRank).toBe(30);
  });

  it("Code 31 (L3) → frame=warning, sound=warning", () => {
    const info = mkInfo({ headlineKindCodes: ["31"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("warning");
    expect(r.soundLevel).toBe("warning");
  });

  it("Code 40 (氾濫危険 = L4) → frame=critical, sound=warning (L4 は音 warning)", () => {
    const info = mkInfo({ headlineKindCodes: ["40"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("warning");
    expect(r.maxLevel).toBe("L4");
  });

  it("Code 41 (L4) は frame=critical かつ sound=warning (critical 音昇格していない、契約 test)", () => {
    const info = mkInfo({ headlineKindCodes: ["41"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("warning");
    expect(r.maxLevel).toBe("L4");
    expect(r.maxRank).toBe(40);
  });

  it("Code 51 (氾濫発生 = L5) → frame=critical, sound=critical", () => {
    const info = mkInfo({ headlineKindCodes: ["51"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("critical");
    expect(r.maxLevel).toBe("L5");
    expect(r.maxRank).toBe(51);
  });

  it("Code 53 (L5) → frame=critical, sound=critical", () => {
    const info = mkInfo({ headlineKindCodes: ["53"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("critical");
    expect(r.maxLevel).toBe("L5");
  });

  it("unknown → frame=info, sound=info, maxLevel=unknown", () => {
    const info = mkInfo({ headlineKindCodes: ["unknown"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.frameLevel).toBe("info");
    expect(r.soundLevel).toBe("info");
    expect(r.maxLevel).toBe("unknown");
    expect(r.maxRank).toBe(-1);
  });

  it("複数 Code 共存: L2 と L4 が両方ある → maxLevel=L4 / frame=critical / sound=warning (最大採用)", () => {
    const info = mkInfo({ headlineKindCodes: ["20", "41"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.maxLevel).toBe("L4");
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("warning");
  });

  it("複数 Code 共存: L4 と L5 → maxLevel=L5 / frame=critical / sound=critical (L5 が勝つ)", () => {
    const info = mkInfo({ headlineKindCodes: ["41", "53"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.maxLevel).toBe("L5");
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("critical");
  });

  it("headlines が空でも station の headlineKindCode を見て maxLevel を決める", () => {
    const info = mkInfo({ headlineKindCodes: [], stationHeadlineCodes: ["30"] });
    const r = resolveFloodForecastLevels(info);
    expect(r.maxLevel).toBe("L3");
    expect(r.frameLevel).toBe("warning");
    expect(r.soundLevel).toBe("warning");
  });

  it("headlines も stations も空 → maxLevel=unknown, frame=info", () => {
    const info = mkInfo({});
    const r = resolveFloodForecastLevels(info);
    expect(r.maxLevel).toBe("unknown");
    expect(r.frameLevel).toBe("info");
    expect(r.soundLevel).toBe("info");
  });

  it("scope=河川 以外の headline は L 算定で考慮するが headline の代表決定では scope=河川 を優先", () => {
    // headlines に scope=府県予報区等 (Code 41) と scope=河川 (Code 30) が混在
    const info: ParsedFloodForecastInfo = {
      ...mkInfo({}),
      headlines: [
        mkHeadline("41", "府県予報区等"),
        mkHeadline("30", "河川"),
      ],
    };
    const r = resolveFloodForecastLevels(info);
    // maxLevel は scope 関係なく最大 → L4
    expect(r.maxLevel).toBe("L4");
    expect(r.frameLevel).toBe("critical");
    expect(r.soundLevel).toBe("warning");
  });
});
