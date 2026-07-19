import { describe, it, expect } from "vitest";
import {
  resolvePhenomenonFamily,
  resolveAlertLevel,
  resolveDisplaySeverity,
  resolveVpwp50Significancy,
  computeMaxDisplaySeverity,
  computeMaxSoundLevel,
  VPWP50_SIGNIFICANCY_ALERT_LEVEL,
  DISPLAY_SEVERITY_RANK,
  DISPLAY_SEVERITY_TO_FRAME_LEVEL,
  DISPLAY_SEVERITY_TO_SOUND_LEVEL,
  resolveBriefingSeverity,
  resolveTornadoSeverity,
  type DisplaySeverity,
  type ResolvedTelegramSeverity,
} from "../../src/dmdata/weather-warning-level";
import type { WeatherAreaLayer, WeatherKind, FrameLevel, SoundLevel } from "../../src/types";
import { classifySignificancyCode } from "../../src/dmdata/weather-warning-timeseries-significancy";

describe("resolvePhenomenonFamily", () => {
  it("Code 03 → heavyRain", () => {
    expect(resolvePhenomenonFamily("03", "レベル３大雨警報")).toBe("heavyRain");
  });
  it("Code 09 → landslide", () => {
    expect(resolvePhenomenonFamily("09", "レベル３土砂災害警報")).toBe("landslide");
  });
  it("Code 08 → stormSurge", () => {
    expect(resolvePhenomenonFamily("08", "レベル３高潮警報")).toBe("stormSurge");
  });
  it("Code 05 → storm", () => {
    expect(resolvePhenomenonFamily("05", "暴風警報")).toBe("storm");
  });
  it("Code 02 → blizzard", () => {
    expect(resolvePhenomenonFamily("02", "暴風雪警報")).toBe("blizzard");
  });
  it("Code 06 → snow", () => {
    expect(resolvePhenomenonFamily("06", "大雪警報")).toBe("snow");
  });
  it("Code 07 → wave", () => {
    expect(resolvePhenomenonFamily("07", "波浪警報")).toBe("wave");
  });
  it("Code 14 → thunder", () => {
    expect(resolvePhenomenonFamily("14", "雷注意報")).toBe("thunder");
  });
  it("Code 04 → flood (洪水警報、警戒レベル非対応扱い)", () => {
    expect(resolvePhenomenonFamily("04", "洪水警報")).toBe("flood");
  });
  it("Code 18 → flood (洪水注意報)", () => {
    expect(resolvePhenomenonFamily("18", "洪水注意報")).toBe("flood");
  });
  it("Code 00 → release", () => {
    expect(resolvePhenomenonFamily("00", "解除")).toBe("release");
  });
  it("Unknown Code → other", () => {
    expect(resolvePhenomenonFamily("87", "未知")).toBe("other");
  });
});

describe("DISPLAY_SEVERITY_RANK", () => {
  it("全 DisplaySeverity を持つ", () => {
    const expected: DisplaySeverity[] = [
      "officialL5", "officialL4", "officialL3", "officialL2", "officialL1",
      "nonLevelSpecial", "nonLevelWarning", "nonLevelAdvisory",
      "release", "unknown",
    ];
    for (const s of expected) {
      expect(DISPLAY_SEVERITY_RANK[s]).toBeDefined();
    }
  });
  it("officialL5(100) > officialL4(90) > nonLevelSpecial(85) > officialL3(80)", () => {
    expect(DISPLAY_SEVERITY_RANK.officialL5).toBe(100);
    expect(DISPLAY_SEVERITY_RANK.officialL4).toBe(90);
    expect(DISPLAY_SEVERITY_RANK.nonLevelSpecial).toBe(85);
    expect(DISPLAY_SEVERITY_RANK.officialL3).toBe(80);
  });
  it("nonLevelWarning(75) > officialL2(60) > nonLevelAdvisory(55) > officialL1(40) > unknown(30) > release(10)", () => {
    expect(DISPLAY_SEVERITY_RANK.nonLevelWarning).toBe(75);
    expect(DISPLAY_SEVERITY_RANK.officialL2).toBe(60);
    expect(DISPLAY_SEVERITY_RANK.nonLevelAdvisory).toBe(55);
    expect(DISPLAY_SEVERITY_RANK.officialL1).toBe(40);
    expect(DISPLAY_SEVERITY_RANK.unknown).toBe(30);
    expect(DISPLAY_SEVERITY_RANK.release).toBe(10);
  });
});

describe("resolveAlertLevel", () => {
  it("heavyRain 33/43/03/10 → L5/L4/L3/L2", () => {
    expect(resolveAlertLevel("33", "heavyRain")).toBe(5);
    expect(resolveAlertLevel("43", "heavyRain")).toBe(4);
    expect(resolveAlertLevel("03", "heavyRain")).toBe(3);
    expect(resolveAlertLevel("10", "heavyRain")).toBe(2);
  });
  it("landslide 39/49/09/29 → L5/L4/L3/L2", () => {
    expect(resolveAlertLevel("39", "landslide")).toBe(5);
    expect(resolveAlertLevel("49", "landslide")).toBe(4);
    expect(resolveAlertLevel("09", "landslide")).toBe(3);
    expect(resolveAlertLevel("29", "landslide")).toBe(2);
  });
  it("stormSurge 38/48/08/19 → L5/L4/L3/L2", () => {
    expect(resolveAlertLevel("38", "stormSurge")).toBe(5);
    expect(resolveAlertLevel("48", "stormSurge")).toBe(4);
    expect(resolveAlertLevel("08", "stormSurge")).toBe(3);
    expect(resolveAlertLevel("19", "stormSurge")).toBe(2);
  });
  it("非対応 family は null", () => {
    expect(resolveAlertLevel("05", "storm")).toBeNull();
    expect(resolveAlertLevel("07", "wave")).toBeNull();
    expect(resolveAlertLevel("14", "thunder")).toBeNull();
  });
  it("未知 Code は null", () => {
    expect(resolveAlertLevel("87", "heavyRain")).toBeNull();
  });
});

describe("resolveDisplaySeverity", () => {
  it("公式 L5 (heavyRain 33) → officialL5/source=map", () => {
    const r = resolveDisplaySeverity("33", "大雨特別警報", "heavyRain");
    expect(r.displaySeverity).toBe("officialL5");
    expect(r.officialAlertLevel).toBe(5);
    expect(r.source).toBe("map");
  });
  it("公式 L4 (landslide 49) → officialL4", () => {
    const r = resolveDisplaySeverity("49", "土砂災害警戒情報", "landslide");
    expect(r.displaySeverity).toBe("officialL4");
    expect(r.officialAlertLevel).toBe(4);
    expect(r.source).toBe("map");
  });
  it("nonLevelSpecial (storm 35) → nonLevelSpecial/source=map", () => {
    const r = resolveDisplaySeverity("35", "暴風特別警報", "storm");
    expect(r.displaySeverity).toBe("nonLevelSpecial");
    expect(r.officialAlertLevel).toBeNull();
    expect(r.source).toBe("map");
  });
  it("nonLevelWarning (storm 05) → nonLevelWarning", () => {
    const r = resolveDisplaySeverity("05", "暴風警報", "storm");
    expect(r.displaySeverity).toBe("nonLevelWarning");
    expect(r.source).toBe("map");
  });
  it("nonLevelAdvisory (thunder 14) → nonLevelAdvisory", () => {
    const r = resolveDisplaySeverity("14", "雷注意報", "thunder");
    expect(r.displaySeverity).toBe("nonLevelAdvisory");
    expect(r.source).toBe("map");
  });
  it("flood (洪水警報 04) → nonLevelWarning/source=map (riverFlood とは別、非対応扱い)", () => {
    const r = resolveDisplaySeverity("04", "洪水警報", "flood");
    expect(r.displaySeverity).toBe("nonLevelWarning");
    expect(r.officialAlertLevel).toBeNull();
    expect(r.source).toBe("map");
  });
  it("解除 Code 00 → release", () => {
    const r = resolveDisplaySeverity("00", "解除", "release");
    expect(r.displaySeverity).toBe("release");
    expect(r.source).toBe("map");
  });
  it("map 不在で名前に「特別警報」→ nameFallback", () => {
    const r = resolveDisplaySeverity("99", "未知特別警報", "other");
    expect(r.displaySeverity).toBe("nonLevelSpecial");
    expect(r.source).toBe("nameFallback");
  });
  it("全く未知 → unknown/source=unknown", () => {
    const r = resolveDisplaySeverity("99", "謎", "other");
    expect(r.displaySeverity).toBe("unknown");
    expect(r.source).toBe("unknown");
  });
});

describe("resolveVpwp50Significancy (Phase B)", () => {
  it.each([
    ["21", "officialL2", 2],
    ["22", "officialL2", 2],
    ["31", "officialL3", 3],
    ["41", "officialL4", 4],
    ["51", "officialL5", 5],
  ] as const)("alertLevel 系 %s → %s (L%d)", (code, ds, level) => {
    const r = resolveVpwp50Significancy(classifySignificancyCode("土砂災害危険度", code));
    expect(r).not.toBeNull();
    expect(r!.displaySeverity).toBe(ds);
    expect(r!.officialAlertLevel).toBe(level);
    expect(r!.source).toBe("map");
  });

  it.each([
    ["20", "nonLevelAdvisory"],
    ["30", "nonLevelWarning"],
    ["50", "nonLevelSpecial"],
  ] as const)("grade 系 %s → %s (officialAlertLevel=null)", (code, ds) => {
    const r = resolveVpwp50Significancy(classifySignificancyCode("濃霧危険度", code));
    expect(r!.displaySeverity).toBe(ds);
    expect(r!.officialAlertLevel).toBeNull();
  });

  it("未知 Code → unknown / below・none (00/01/11) → null", () => {
    expect(resolveVpwp50Significancy(classifySignificancyCode("融雪危険度", "12"))!.displaySeverity).toBe("unknown");
    for (const [pt, code] of [["高潮危険度", "00"], ["雷危険度", "01"], ["高潮危険度", "11"]] as const) {
      expect(resolveVpwp50Significancy(classifySignificancyCode(pt, code))).toBeNull();
    }
  });

  it("dict と COMMON 表の rank 整合 (乖離したら落ちる)", () => {
    for (const code of Object.keys(VPWP50_SIGNIFICANCY_ALERT_LEVEL)) {
      const sig = classifySignificancyCode("土砂災害危険度", code);
      expect(resolveVpwp50Significancy(sig)!.officialAlertLevel, code).toBe(sig.rank);
    }
  });

  // VPWW/VPWP50 横断契約 (Codex W: cross-test): 同じ displaySeverity は同じ prefix/frame になる
  it("VPWW と VPWP50 が同じ DisplaySeverity 契約に従う (officialL4 = critical = ★)", async () => {
    // DISPLAY_SEVERITY_TO_FRAME_LEVEL は weather-warning-level.ts (dmdata) 配置で確定 (v2.1)
    const { DISPLAY_SEVERITY_TO_FRAME_LEVEL } = await import("../../src/dmdata/weather-warning-level");
    const { getDisplaySeverityTierPrefix } = await import("../../src/ui/weather-warning-level-theme");
    const r = resolveVpwp50Significancy(classifySignificancyCode("土砂災害危険度", "41"))!;
    expect(DISPLAY_SEVERITY_TO_FRAME_LEVEL[r.displaySeverity]).toBe("critical");
    expect(getDisplaySeverityTierPrefix(r.displaySeverity)).toBe("★");
  });
});

// ── computeMaxSoundLevel (集合ベース通知音、2026-06-12 共存エッジ解消) ──
//
// maxDisplaySeverity (DISPLAY_SEVERITY_RANK 最大の 1 点代表) と違い、全 Kind を
// 音レベルに写してから最大を取る。officialL4 (rank 90) > nonLevelSpecial (rank 85) の
// rank tie-break で特別警報級の critical 音が潰れないことを固定する
// (visual-gate 章 10 の「既知の辺縁」解消)。

describe("computeMaxSoundLevel", () => {
  function makeLayers(kinds: WeatherKind[]): WeatherAreaLayer[] {
    return [
      {
        type: "気象警報・注意報（府県予報区等）",
        items: [
          { areaName: "テスト県", areaCode: "999999", kinds, statuses: [] },
        ],
      },
    ];
  }

  it("空 layers → null", () => {
    expect(computeMaxSoundLevel([])).toBeNull();
  });

  it("解除 Kind のみ → null (release は対象外)", () => {
    const layers = makeLayers([{ name: "解除", code: "00", severity: "release" }]);
    expect(computeMaxSoundLevel(layers)).toBeNull();
  });

  it("officialL4 (Code 49) のみ → warning (据置: L4 単独の音は warning)", () => {
    const layers = makeLayers([
      { name: "土砂災害警戒情報", code: "49", severity: "warning" },
    ]);
    expect(computeMaxSoundLevel(layers)).toBe("warning");
  });

  it("officialL5 (Code 33) のみ → critical", () => {
    const layers = makeLayers([
      { name: "大雨特別警報", code: "33", severity: "specialWarning" },
    ]);
    expect(computeMaxSoundLevel(layers)).toBe("critical");
  });

  it("注意報 (Code 14) のみ → normal", () => {
    const layers = makeLayers([
      { name: "雷注意報", code: "14", severity: "advisory" },
    ]);
    expect(computeMaxSoundLevel(layers)).toBe("normal");
  });

  it("共存最大: L4 (49) + 暴風特別警報 (35) → critical (rank 代表 officialL4 に潰されない)", () => {
    const layers = makeLayers([
      { name: "土砂災害警戒情報", code: "49", severity: "warning" },
      { name: "暴風特別警報", code: "35", severity: "specialWarning" },
    ]);
    // 表示代表は rank 最大の officialL4 (90) — 音はこれと独立に critical
    expect(computeMaxDisplaySeverity(layers)).toBe("officialL4");
    expect(computeMaxSoundLevel(layers)).toBe("critical");
  });

  it("layer 横断でも集合ベース (別 layer の特別警報級が勝つ)", () => {
    const layers: WeatherAreaLayer[] = [
      ...makeLayers([{ name: "土砂災害警戒情報", code: "49", severity: "warning" }]),
      ...makeLayers([{ name: "暴風特別警報", code: "35", severity: "specialWarning" }]),
    ];
    expect(computeMaxSoundLevel(layers)).toBe("critical");
  });
});

describe("Phase D: resolveBriefingSeverity / resolveTornadoSeverity", () => {
  it("線状降水帯発生・記録雨 → 表示 nonLevelSpecial / 音 warning (2026-06-12 レビュー決定)", () => {
    for (const tag of ["linearRainObserved", "recordRain"] as const) {
      const r = resolveBriefingSeverity(tag, "tagInformation");
      expect(r).toEqual({ displaySeverity: "nonLevelSpecial", soundLevel: "warning", source: "map" });
    }
  });

  it("線状降水帯予想・短時間大雪 → nonLevelWarning / warning", () => {
    for (const tag of ["linearRainPredicted", "shortSnow"] as const) {
      const r = resolveBriefingSeverity(tag, "fallback");
      expect(r).toEqual({ displaySeverity: "nonLevelWarning", soundLevel: "warning", source: "map" });
    }
  });

  it("other は origin で unknown / none に分かれる", () => {
    expect(resolveBriefingSeverity("other", "tagInformation").source).toBe("unknown");
    expect(resolveBriefingSeverity("other", "fallback").source).toBe("none");
    expect(resolveBriefingSeverity("other", "tagInformation").displaySeverity).toBeNull();
  });

  it("竜巻: 目撃あり/フェイルセーフ → nonLevelSpecial / warning、通常発表 → nonLevelWarning、地域0 → none", () => {
    expect(resolveTornadoSeverity(true, true, 5)).toEqual(
      { displaySeverity: "nonLevelSpecial", soundLevel: "warning", source: "map" });
    expect(resolveTornadoSeverity(false, true, 0)).toEqual(
      { displaySeverity: "nonLevelSpecial", soundLevel: "warning", source: "map" });
    expect(resolveTornadoSeverity(false, false, 3)).toEqual(
      { displaySeverity: "nonLevelWarning", soundLevel: "warning", source: "map" });
    expect(resolveTornadoSeverity(false, false, 0)).toEqual(
      { displaySeverity: null, soundLevel: null, source: "none" });
  });

  it("【契約】全入力ケースの ds/frame/sound を表で固定 (音の逸脱は明示 ID のみ — Codex R3 P1-2)", () => {
    // 音が DISPLAY_SEVERITY_TO_SOUND_LEVEL から逸脱してよい入力 ID (レビュー決定 2026-06-12:
    // 特別警報の名を持たない特別警報「級」は音 warning。決定としては 2 件、入力 ID では 4 つ)
    const SOUND_DEVIATION_ALLOWED = new Set([
      "briefing:linearRainObserved", "briefing:recordRain",
      "tornado:sightingAreas", "tornado:sightingTelegramFallback",
    ]);
    const cases: { id: string; r: ResolvedTelegramSeverity; ds: DisplaySeverity | null; frame: FrameLevel | null; sound: Exclude<SoundLevel, "cancel"> | null }[] = [
      { id: "briefing:linearRainObserved", r: resolveBriefingSeverity("linearRainObserved", "tagInformation"),
        ds: "nonLevelSpecial", frame: "critical", sound: "warning" },
      { id: "briefing:recordRain", r: resolveBriefingSeverity("recordRain", "fallback"),
        ds: "nonLevelSpecial", frame: "critical", sound: "warning" },
      { id: "briefing:linearRainPredicted", r: resolveBriefingSeverity("linearRainPredicted", "tagInformation"),
        ds: "nonLevelWarning", frame: "warning", sound: "warning" },
      { id: "briefing:shortSnow", r: resolveBriefingSeverity("shortSnow", "fallback"),
        ds: "nonLevelWarning", frame: "warning", sound: "warning" },
      { id: "briefing:other-tag", r: resolveBriefingSeverity("other", "tagInformation"),
        ds: null, frame: null, sound: null },
      { id: "briefing:other-fallback", r: resolveBriefingSeverity("other", "fallback"),
        ds: null, frame: null, sound: null },
      { id: "tornado:sightingAreas", r: resolveTornadoSeverity(true, true, 1),
        ds: "nonLevelSpecial", frame: "critical", sound: "warning" },
      { id: "tornado:sightingTelegramFallback", r: resolveTornadoSeverity(false, true, 0),
        ds: "nonLevelSpecial", frame: "critical", sound: "warning" },
      { id: "tornado:active", r: resolveTornadoSeverity(false, false, 1),
        ds: "nonLevelWarning", frame: "warning", sound: "warning" },
      { id: "tornado:none", r: resolveTornadoSeverity(false, false, 0),
        ds: null, frame: null, sound: null },
    ];
    for (const c of cases) {
      expect(c.r.displaySeverity).toBe(c.ds);
      expect(c.r.soundLevel).toBe(c.sound);
      if (c.r.displaySeverity == null) continue;
      // frame は専用の逸脱を持たない: 既存対応表の値そのものが期待 frame
      expect(DISPLAY_SEVERITY_TO_FRAME_LEVEL[c.r.displaySeverity]).toBe(c.frame);
      // sound の逸脱は許可 ID のみ、逸脱先は warning のみ
      const tableSound = DISPLAY_SEVERITY_TO_SOUND_LEVEL[c.r.displaySeverity];
      if (c.r.soundLevel !== tableSound) {
        expect(SOUND_DEVIATION_ALLOWED.has(c.id)).toBe(true);
        expect(c.r.soundLevel).toBe("warning");
      }
    }
  });
});
