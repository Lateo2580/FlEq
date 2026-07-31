import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import type { ParsedWeatherWarning, WeatherItem, WeatherKind } from "../../../src/types";

function makeKind(code: string, severity: WeatherKind["severity"], name?: string): WeatherKind {
  const defaultName = code === "03" ? "大雨警報" : `Kind${code}`;
  return { name: name ?? defaultName, code, severity };
}

function makeItem(areaName: string, areaCode: string, kinds: WeatherKind[]): WeatherItem {
  return { areaName, areaCode, kinds, statuses: [] };
}

function makeInfo(items: WeatherItem[]): ParsedWeatherWarning {
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 0,
    advisoryAreaCount: 0,
    isTest: false,
  };
}

describe("Vpws50StateHolder.getCurrentAreasForDisplay", () => {
  it("未受信時は undefined", () => {
    expect(new Vpws50StateHolder().getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("diffAndUpdate 後は totalAreas > 0 の集約ビューを返す", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]),
      "msg-1",
    );
    const display = state.getCurrentAreasForDisplay();
    expect(display).not.toBeUndefined();
    expect(display?.totalAreas).toBeGreaterThan(0);
  });
});
