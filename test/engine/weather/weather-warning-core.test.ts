import { describe, it, expect } from "vitest";
import { flattenEntries, summarizeTransitions, weatherCoreDisplaySeverity, weatherCoreFrameLevel } from "../../../src/engine/weather/weather-warning-core";
import type { ParsedWeatherWarning, WeatherAreaLayer } from "../../../src/types";

function item(over: Partial<WeatherAreaLayer["items"][number]> & { areaName: string }): WeatherAreaLayer["items"][number] {
  return {
    areaCode: "000000",
    kinds: [],
    statuses: [],
    ...over,
  };
}

function layer(type: string, items: WeatherAreaLayer["items"]): WeatherAreaLayer {
  return { type, items };
}

function info(layers: WeatherAreaLayer[]): ParsedWeatherWarning {
  return {
    type: "VPWW55", infoType: "発表", title: "t", reportDateTime: "2026-07-10T00:00:00+09:00",
    headline: null, publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "t",
    layers, comments: [], maxSeverity: "warning",
    maxDisplaySeverity: null, maxSoundLevel: null,
    warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
  };
}

describe("flattenEntries: 解除プレースホルダ (Head=Name解除/Code00, Body=元Kind+LastKind) の復元", () => {
  it("Head が解除プレースホルダに潰していても、kindName は Body の LastKind から実体名に復元される", () => {
    const soya = item({
      areaName: "宗谷地方",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [{ kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20" }],
      fullStatus: "一部",
    });
    const [entry] = flattenEntries(layer("気象警報・注意報（府県予報区等）", [soya]));
    expect(entry.status).toBe("解除");
    expect(entry.kindName).toBe("濃霧注意報"); // 旧バグ: ここが "解除" になっていた
    expect(entry.lastKindName).toBe("濃霧注意報");
    expect(entry.lastKindCode).toBe("20");
  });

  it("kindCode/displaySeverity は Head の Code (00) のまま解決する — release-only report の "
    + "frame level (cancel) を壊さないため、判定用の code/name は書き換えない", () => {
    const soya = item({
      areaName: "宗谷地方",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [{ kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20" }],
    });
    const [entry] = flattenEntries(layer("気象警報・注意報（府県予報区等）", [soya]));
    expect(entry.kindCode).toBe("00");
    expect(entry.displaySeverity).toBe("release");
    expect(entry.phenomenonFamily).toBe("release");
  });

  it("解除以外の Kind (通常の kindCode 一致 join) は従来どおり動く (回帰確認)", () => {
    const kumamoto = item({
      areaName: "熊本県",
      kinds: [{ name: "大雨警報", code: "03", severity: "warning" }],
      statuses: [{ kindCode: "03", status: "発表" }],
    });
    const [entry] = flattenEntries(layer("気象警報・注意報（府県予報区等）", [kumamoto]));
    expect(entry.kindName).toBe("大雨警報");
    expect(entry.status).toBe("発表");
    expect(entry.lastKindName).toBeUndefined();
  });

  it("placeholder Kind は Head に 1 件だけでも、Body の Status=解除 全件を展開する "
    + "(気象庁 XML は Head 側で解除を 1 個の Kind にまとめても、Body 側は解除された種別数だけ "
    + "Status=解除 を持ちうる。旧実装は releasedStatuses を出現順 1 対 1 キューで消費しており、"
    + "placeholder Kind が 1 件しか無いこのケースで 2 件目の雷注意報が消えていた)", () => {
    const multi = item({
      areaName: "テスト地方",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [
        { kindCode: "03", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" },
        { kindCode: "14", status: "解除", lastKindName: "雷注意報", lastKindCode: "14" },
      ],
    });
    const entries = flattenEntries(layer("気象警報・注意報（府県予報区等）", [multi]));
    expect(entries.map((e) => e.kindName)).toEqual(["大雨警報", "雷注意報"]);
    expect(entries.every((e) => e.status === "解除")).toBe(true);
  });

  it("Head 側に placeholder Kind が複数並んでいても、Body の Status=解除 は二重展開しない", () => {
    const multi = item({
      areaName: "テスト地方",
      kinds: [
        { name: "解除", code: "00", severity: "release" },
        { name: "解除", code: "00", severity: "release" },
      ],
      statuses: [
        { kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20" },
        { kindCode: "14", status: "解除", lastKindName: "雷注意報", lastKindCode: "14" },
      ],
    });
    const entries = flattenEntries(layer("気象警報・注意報（府県予報区等）", [multi]));
    expect(entries.map((e) => e.kindName)).toEqual(["濃霧注意報", "雷注意報"]);
  });

  it("weatherCoreFrameLevel/weatherCoreDisplaySeverity: 解除のみの report は "
    + "プレースホルダの実体名復元後も release/cancel のまま (frame level 回帰ガード)", () => {
    const soya = item({
      areaName: "宗谷地方",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [{ kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20" }],
    });
    const parsed = info([layer("気象警報・注意報（府県予報区等）", [soya])]);
    expect(weatherCoreDisplaySeverity(parsed)).toBe("release");
    expect(weatherCoreFrameLevel(parsed)).toBe("cancel");
  });

  it("summarizeTransitions: 解除プレースホルダ entry も released としてカウントされる", () => {
    const soya = item({
      areaName: "宗谷地方",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [{ kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20" }],
    });
    const entries = flattenEntries(layer("気象警報・注意報（府県予報区等）", [soya]));
    expect(summarizeTransitions(entries)).toEqual({ added: 0, upgraded: 0, downgraded: 0, released: 1 });
  });
});
