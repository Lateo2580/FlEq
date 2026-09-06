import { testTelegramMeta } from "../../helpers/telegram-meta";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { __phenomenonKey_internals, kindCodeToPhenomenonKey } from "../../../src/dmdata/weather-phenomenon-key";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { createMockWsDataMessageFromXml } from "../../helpers/mock-message";
import { classifyWeatherPromotion } from "../../../src/engine/display/weather-promotion";
import {
  computeMaxDisplaySeverity,
  computeMaxSoundLevel,
  resolveDisplaySeverity,
  resolvePhenomenonFamily,
} from "../../../src/dmdata/weather-warning-level";
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

function makeInfoWithLayers(layers: ParsedWeatherWarning["layers"]): ParsedWeatherWarning {
  return {
    ...makeInfo([]),
    layers,
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
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

  it("多層電文では市町村等 layer を state・表示 view の入力にする", () => {
    const state = new Vpws50StateHolder();
    const kind = makeKind("03", "warning");
    const info = makeInfoWithLayers([
      { type: "気象警報・注意報（府県予報区等）", items: [makeItem("千葉県", "120000", [kind])] },
      { type: "気象警報・注意報（一次細分区域等）", items: [makeItem("千葉県北西部", "120010", [kind])] },
      { type: "気象警報・注意報（市町村等をまとめた地域等）", items: [makeItem("葛南地域", "120020", [kind])] },
      {
        type: "気象警報・注意報（市町村等）",
        items: [
          makeItem("千葉市", "121000", [kind]),
          makeItem("市原市", "122190", [kind]),
        ],
      },
    ]);

    state.diffAndUpdate(info, "msg-municipalities");

    const display = state.getCurrentAreasForDisplay();
    expect(display?.totalAreas).toBe(2);
    expect(display?.kinds[0]?.areas).toEqual([
      { areaName: "千葉市", areaCode: "121000" },
      { areaName: "市原市", areaCode: "122190" },
    ]);
  });

  it("市町村 A/B → A 昇格・B 解除・C 追加を差分化し、rollback で前報へ戻す", () => {
    const state = new Vpws50StateHolder();
    const l4 = makeKind("43", "warning", "レベル４大雨危険警報");
    const l5 = makeKind("33", "specialWarning", "大雨特別警報");
    const municipalityLayer = (items: WeatherItem[]): ParsedWeatherWarning => makeInfoWithLayers([
      { type: "気象警報・注意報（市町村等）", items },
    ]);

    state.diffAndUpdate(municipalityLayer([
      makeItem("市町村A", "120001", [l4]),
      makeItem("市町村B", "120002", [l4]),
    ]), "msg-before");
    const diff = state.diffAndUpdate(municipalityLayer([
      makeItem("市町村A", "120001", [l5]),
      makeItem("市町村C", "120003", [l4]),
    ]), "msg-after");

    expect(diff.added).toMatchObject([{ areaCode: "120003" }]);
    expect(diff.upgraded).toMatchObject([{ areaCode: "120001", changes: [{
      prevDisplaySeverity: "officialL4",
      newDisplaySeverity: "officialL5",
    }] }]);
    expect(diff.downgraded).toEqual([]);
    expect(diff.released).toMatchObject([{ areaCode: "120002" }]);
    expect(classifyWeatherPromotion(state.getCurrentAreasForDisplay(), "vpws50")?.level).toBe(5);

    const rollback = state.restorePrevious();
    expect(rollback.isCancelRollback).toBe(true);
    expect(state.getCurrentAreasForDisplay()?.kinds[0]?.areas).toEqual([
      { areaName: "市町村A", areaCode: "120001" },
      { areaName: "市町村B", areaCode: "120002" },
    ]);
    expect(classifyWeatherPromotion(state.getCurrentAreasForDisplay(), "vpws50")?.level).toBe(4);
  });

  it("change-density synthetic raw pair は五区分・13表示変更を parser から生成する", () => {
    const fixture = (name: string) => readFileSync(join(
      __dirname,
      "..",
      "..",
      "fixtures",
      "weather-alert-kind-area",
      name,
    ), "utf8");
    const before = parseWeatherWarning(createMockWsDataMessageFromXml(
      fixture("synthetic-vpws50-change-density-before.xml"),
      "VPWS50",
    ));
    const after = parseWeatherWarning(createMockWsDataMessageFromXml(
      fixture("synthetic-vpws50-change-density-after.xml"),
      "VPWS50",
    ));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(before!, "change-density-before");
    const { displayDiff } = state.diffAndUpdateWithDisplay(
      after!,
      "change-density-after",
      { reportDateTime: "2026-09-06T12:01:00+09:00", serial: "2" },
    );
    expect(displayDiff).not.toBeNull();
    const count = (kind: keyof NonNullable<typeof displayDiff>) =>
      displayDiff![kind].reduce((sum, area) => sum + area.changes.length, 0);
    expect({
      upgraded: count("upgraded"),
      added: count("added"),
      kindChanged: count("kindChanged"),
      downgraded: count("downgraded"),
      released: count("released"),
    }).toEqual({ upgraded: 4, added: 3, kindChanged: 2, downgraded: 2, released: 2 });
    expect(Object.values(displayDiff!).flat().some((area) => area.areaCode === "9990100")).toBe(false);
  });

  it("既知 code の同一 phenomenon 内に同一 display severity の別 code 対は存在しない", () => {
    const codesByPhenomenon = new Map<string, string[]>();
    for (const [code, phenomenon] of Object.entries(__phenomenonKey_internals.KIND_CODE_TO_PHENOMENON)) {
      codesByPhenomenon.set(phenomenon, [...(codesByPhenomenon.get(phenomenon) ?? []), code]);
    }
    for (const codes of codesByPhenomenon.values()) {
      const severities = codes.map((code) => resolveDisplaySeverity(
        code,
        "synthetic",
        resolvePhenomenonFamily(code, "synthetic"),
      ).displaySeverity);
      expect(new Set(severities).size).toBe(codes.length);
    }
    expect(kindCodeToPhenomenonKey("98")).not.toBe(kindCodeToPhenomenonKey("99"));
  });
});
