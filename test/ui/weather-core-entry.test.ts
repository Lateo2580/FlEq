import { describe, it, expect } from "vitest";
import {
  flattenEntries,
  pickStatusLayer,
  pickAreaSummaryLayer,
  summarizeTransitions,
  weatherCoreDisplaySeverity,
  weatherCoreFrameLevel,
  type WarningEntry,
} from "../../src/ui/weather-core-entry";
import type { WeatherAreaLayer, ParsedWeatherWarning } from "../../src/types";

const sampleLayer: WeatherAreaLayer = {
  type: "市町村等",
  items: [
    {
      areaName: "千葉県北西部",
      areaCode: "120001",
      kinds: [
        { name: "レベル３大雨警報", code: "03", severity: "warning" },
        { name: "洪水警報", code: "18", severity: "warning" },
      ],
      statuses: [
        { kindCode: "03", status: "発表" },
        { kindCode: "18", status: "継続" },
      ],
      fullStatus: "全域",
    },
  ],
};

describe("flattenEntries", () => {
  it("1 Item × 2 Kind → 2 Entry", () => {
    expect(flattenEntries(sampleLayer).length).toBe(2);
  });
  it("各 entry に解決済みフィールドが乗る", () => {
    const [e1] = flattenEntries(sampleLayer);
    expect(e1.kindCode).toBe("03");
    expect(e1.kindName).toBe("レベル３大雨警報");
    expect(e1.areaName).toBe("千葉県北西部");
    expect(e1.status).toBe("発表");
    expect(e1.displaySeverity).toBe("officialL3");
    expect(e1.officialAlertLevel).toBe(3);
    expect(e1.resolutionSource).toBe("map");
    expect(e1.fullStatus).toBe("全域");
  });
  it("stable id が一意に付く", () => {
    const [e1, e2] = flattenEntries(sampleLayer);
    expect(e1.id).toBe("03|千葉県北西部|officialL3|発表|");
    expect(e2.id).not.toBe(e1.id);
  });
});

function makeLayeredInfo(): ParsedWeatherWarning {
  return {
    type: "VPWW55", infoType: "発表", title: "千葉県大雨警報・注意報",
    reportDateTime: "2026-06-07T17:00:00+09:00", headline: null,
    publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "気象警報・注意報",
    layers: [
      { type: "府県予報区等", items: [] },
      { type: "一次細分区域等", items: [{ areaName: "千葉県北西部", areaCode: "", kinds: [], statuses: [] }] },
      { type: "市町村等をまとめた地域等", items: [{ areaName: "葛南地域", areaCode: "", kinds: [], statuses: [] }] },
      { type: "市町村等", items: [{ areaName: "千葉市", areaCode: "",
        kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
        statuses: [{ kindCode: "03", status: "発表" }] }] },
    ],
    comments: [], maxSeverity: "warning",
    maxDisplaySeverity: null, maxSoundLevel: null,
    warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
  };
}

describe("layer selection (status 層 / area summary 層)", () => {
  const info = makeLayeredInfo();
  it("pickStatusLayer は statuses 非空の最細層 (市町村等)", () => {
    expect(pickStatusLayer(info)?.type).toBe("市町村等");
  });
  it("pickAreaSummaryLayer は coarse 層 (一次細分)", () => {
    expect(pickAreaSummaryLayer(info)?.type).toBe("一次細分区域等");
  });
  it("status を持つ層が無い場合 pickStatusLayer は最細の items 非空層を fallback", () => {
    const noStatus: ParsedWeatherWarning = {
      ...info,
      layers: [{ type: "一次細分区域等", items: [{ areaName: "A", areaCode: "", kinds: [], statuses: [] }] }],
    };
    expect(pickStatusLayer(noStatus)?.type).toBe("一次細分区域等");
  });
});

describe("summarizeTransitions", () => {
  it("発表 + lastKindCode null → added", () => {
    const e = [{ status: "発表", phenomenonFamily: "heavyRain", displaySeverity: "officialL3" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 1, upgraded: 0, downgraded: 0, released: 0 });
  });
  it("発表 + 同 family 低 severity → upgraded", () => {
    const e = [{ status: "発表", lastKindCode: "10", lastKindName: "レベル２大雨注意報",
      phenomenonFamily: "heavyRain", displaySeverity: "officialL3" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 0, upgraded: 1, downgraded: 0, released: 0 });
  });
  it("発表 + 同 family 高 severity → downgraded", () => {
    const e = [{ status: "発表", lastKindCode: "03", lastKindName: "レベル３大雨警報",
      phenomenonFamily: "heavyRain", displaySeverity: "officialL2" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 0, upgraded: 0, downgraded: 1, released: 0 });
  });
  it("解除 → released", () => {
    const e = [{ status: "解除", phenomenonFamily: "thunder", displaySeverity: "release" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 0, upgraded: 0, downgraded: 0, released: 1 });
  });
  it("継続は集計対象外", () => {
    const e = [{ status: "継続", phenomenonFamily: "heavyRain", displaySeverity: "officialL3" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 0, upgraded: 0, downgraded: 0, released: 0 });
  });
  it("release kind (status join 失敗で status=発表) も released として数える (新規と誤カウントしない)", () => {
    const e = [{ status: "発表", displaySeverity: "release", phenomenonFamily: "release" }] as WarningEntry[];
    expect(summarizeTransitions(e)).toEqual({ added: 0, upgraded: 0, downgraded: 0, released: 1 });
  });
});

function makeInfoForLevel(items: { code: string; name: string }[]): ParsedWeatherWarning {
  return {
    type: "VPWW55", infoType: "発表", title: "", reportDateTime: "",
    headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
    layers: [{ type: "市町村等", items: [
      { areaName: "A", areaCode: "",
        kinds: items.map((i) => ({ name: i.name, code: i.code, severity: "warning" as const })),
        statuses: items.map((i) => ({ kindCode: i.code, status: "発表" })) },
    ]}],
    comments: [], maxSeverity: "warning",
    maxDisplaySeverity: null, maxSoundLevel: null,
    warningAreaCount: 1, advisoryAreaCount: 0, isTest: false,
  };
}

describe("weatherCoreDisplaySeverity / weatherCoreFrameLevel", () => {
  it("L5 → officialL5 / critical", () => {
    const info = makeInfoForLevel([{ code: "33", name: "レベル５大雨特別警報" }]);
    expect(weatherCoreDisplaySeverity(info)).toBe("officialL5");
    expect(weatherCoreFrameLevel(info)).toBe("critical");
  });
  it("L4 + nonLevelSpecial 混在 → officialL4 (公式優先 tie-breaker)", () => {
    const info = makeInfoForLevel([
      { code: "49", name: "レベル４土砂災害危険警報" },
      { code: "35", name: "暴風特別警報" },
    ]);
    expect(weatherCoreDisplaySeverity(info)).toBe("officialL4");
  });
  it("nonLevelWarning のみ → warning", () => {
    expect(weatherCoreFrameLevel(makeInfoForLevel([{ code: "05", name: "暴風警報" }]))).toBe("warning");
  });
  it("L2 のみ → normal", () => {
    expect(weatherCoreFrameLevel(makeInfoForLevel([{ code: "10", name: "レベル２大雨注意報" }]))).toBe("normal");
  });
  it("取消 → cancel", () => {
    const info = makeInfoForLevel([{ code: "03", name: "レベル３大雨警報" }]);
    info.infoType = "取消";
    expect(weatherCoreFrameLevel(info)).toBe("cancel");
  });
});
