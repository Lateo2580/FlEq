import { testTelegramMeta } from "../helpers/telegram-meta";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { notifyMock } from "../setup";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

vi.mock("../../src/config", () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

vi.mock("../../src/logger", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { Notifier, resolveIconPath, clearIconPathCache } from "../../src/engine/notification/notifier";
import { loadConfig } from "../../src/config";
import type { ParsedEarthquakeInfo, ParsedEewInfo, ParsedTornadoAdvisory, ParsedTsunamiInfo, ParsedWeatherBriefing, ParsedWeatherExplanation, ParsedWeatherWarning } from "../../src/types";
import type { EewUpdateResult } from "../../src/engine/eew/eew-tracker";
import { playSound } from "../../src/engine/notification/sound-player";
import { parseWeatherExplanation } from "../../src/dmdata/weather-explanation-parser";
import { parseClimateInfo } from "../../src/dmdata/climate-info-parser";
import { parseHeatAlert } from "../../src/dmdata/heat-alert-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VPCI50_CANCEL,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_NO_BODY,
  FIXTURE_VPFT50_TITLE_ESCALATION,
} from "../helpers/mock-message";

const enabledNotifySettings = {
  eew: true,
  earthquake: true,
  tsunami: true,
  seismicText: true,
  nankaiTrough: true,
  lgObservation: true,
  volcano: true,
  weather: true,
  tornado: true,
  briefing: true,
  earlyWeather: true,
  weatherWarningTimeseries: true,
  climateInfo: true,
  weatherExplanation: true,
  heatAlert: true,
  typhoonAnalysis: true,
  typhoonProbability: true,
  floodForecast: true,
};

beforeEach(() => {
  vi.mocked(loadConfig).mockReturnValue({ notify: enabledNotifySettings });
});

describe("Notifier", () => {
  beforeEach(() => {
    clearIconPathCache();
  });

  it("uses the mocked notifier during tests", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      meta: testTelegramMeta(false),
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      eventId: null,
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", code: null, intensity: "3" }],
        municipalities: [],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("巨大地震 description を通知本文へ出し MNaN を出さない", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyEarthquake({
      meta: testTelegramMeta(false),
      type: "VXSE52",
      infoType: "発表",
      title: "震源に関する情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      eventId: "E1",
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "日本海溝付近",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "",
        magnitudeInfo: {
          value: "NaN",
          condition: "不明",
          description: "Ｍ８を超える巨大地震",
        },
      },
      isTest: false,
    });

    const message = (notifyMock.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain("M8 を超える巨大地震");
    expect(message).not.toContain("NaN");
  });

  it("passes category-specific icon to node-notifier", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("earthquake.png");
    });

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      meta: testTelegramMeta(false),
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      eventId: null,
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", code: null, intensity: "3" }],
        municipalities: [],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: expect.stringMatching(/earthquake\.png$/),
      }),
    );

    spy.mockRestore();
  });

  it("omits icon property when no icon file exists", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      meta: testTelegramMeta(false),
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      eventId: null,
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", code: null, intensity: "3" }],
        municipalities: [],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    const callArg = notifyMock.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("icon");

    spy.mockRestore();
  });

  it.each([
    ["津波予報（若干の海面変動）", "warning"],
    ["津波注意報", "critical"],
    ["津波警報", "critical"],
    ["大津波警報", "critical"],
  ] as const)("notifyTsunami は %s を %s 音で通知する", (kind, expectedLevel) => {
    const notifier = new Notifier();
    const info: ParsedTsunamiInfo = {
      meta: testTelegramMeta(false),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2026-07-30T12:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{
        areaName: "三陸沿岸",
        kind,
        maxHeightDescription: "",
        firstHeight: "",
      }],
      warningComment: "",
      isTest: false,
    };
    const playSoundMock = vi.mocked(playSound);
    playSoundMock.mockClear();

    notifier.notifyTsunami(info);

    expect(playSoundMock).toHaveBeenCalledOnce();
    expect(playSoundMock).toHaveBeenCalledWith(expectedLevel);
  });

  it("notifyTsunami は受理済み訂正を title/body の両方で明示する", () => {
    const notifier = new Notifier();
    const info: ParsedTsunamiInfo = {
      meta: testTelegramMeta(false),
      type: "VTSE41",
      infoType: "訂正",
      title: "津波警報・注意報・予報",
      reportDateTime: "2026-07-30T12:00:00+09:00",
      headline: "津波警報を更新しました。",
      publishingOffice: "気象庁",
      forecast: [],
      warningComment: "",
      isTest: false,
    };

    notifier.notifyTsunami(info);

    expect(notifyMock).toHaveBeenCalledOnce();
    const notification = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(notification.title).toBe("[訂正] 津波警報・注意報・予報");
    expect(notification.message).toContain("訂正:");
  });
});

describe("Notifier.notifyEew (第1報発火・eventId 単位の通知履歴)", () => {
  const playSoundMock = vi.mocked(playSound);

  /** ParsedEewInfo の最小スタブ */
  function makeEewInfo(opts: Partial<ParsedEewInfo> & { eventId: string | null }): ParsedEewInfo {
    return {
      meta: testTelegramMeta(false),
      type: "VXSE45",
      infoType: "発表",
      title: "緊急地震速報（予報）",
      reportDateTime: "2026-06-04T13:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      serial: "1",
      isTest: false,
      isWarning: false,
      isAssumedHypocenter: false,
      earthquake: {
        originTime: "2026-06-04T13:00:00+09:00",
        hypocenterName: "テスト震源",
        latitude: "35.0",
        longitude: "139.0",
        depth: "30km",
        magnitude: "5.0",
      },
      forecastIntensity: { areas: [{ name: "東京都", intensity: "3" }] },
      ...opts,
    };
  }

  /** EewUpdateResult のデフォルト (isNew=false) */
  function makeResult(overrides: Partial<EewUpdateResult> = {}): EewUpdateResult {
    return {
      isNew: false,
      isDuplicate: false,
      isCancelled: false,
      isSuppressed: false,
      isUpgradeToWarning: false,
      activeCount: 1,
      colorIndex: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    playSoundMock.mockClear();
    clearIconPathCache();
  });

  it("eewResult.isNew=true の第1報で通知音が鳴る (既存挙動)", () => {
    const notifier = new Notifier();
    notifier.notifyEew(makeEewInfo({ eventId: "EVT-A" }), makeResult({ isNew: true }));
    expect(playSoundMock).toHaveBeenCalledWith("warning");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("eewResult.isNew=false でも eventId 初回なら通知音が鳴る (安全網)", () => {
    // 上流のバグや到着順により isNew=false で第1報が届いても、
    // Notifier 側で初回 eventId を検出して鳴らす。
    const notifier = new Notifier();
    notifier.notifyEew(makeEewInfo({ eventId: "EVT-B" }), makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledWith("warning");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("同じ eventId への 2 回目以降の通常報は鳴らない", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-C" });
    notifier.notifyEew(info, makeResult({ isNew: true }));
    notifier.notifyEew({ ...info, serial: "2" }, makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("isUpgradeToWarning=true は eventId 既通知でも鳴る (警報昇格)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-D" });
    notifier.notifyEew(info, makeResult({ isNew: true }));
    notifier.notifyEew(
      { ...info, isWarning: true, serial: "2", type: "VXSE43" },
      makeResult({ isUpgradeToWarning: true }),
    );
    expect(playSoundMock).toHaveBeenCalledTimes(2);
    expect(playSoundMock).toHaveBeenNthCalledWith(2, "critical");
  });

  it("isFinal (nextAdvisory 付き) は eventId 既通知でも鳴る (最終報)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-E" });
    notifier.notifyEew(info, makeResult({ isNew: true }));
    notifier.notifyEew(
      { ...info, serial: "9", nextAdvisory: "この情報をもって、緊急地震速報を終了します。" },
      makeResult({ isNew: false }),
    );
    expect(playSoundMock).toHaveBeenCalledTimes(2);
  });

  it("isCancelled=true は cancel 音で鳴り、履歴がクリアされる (再発時に再度初回扱い)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-F" });
    // 第1報
    notifier.notifyEew(info, makeResult({ isNew: true }));
    // 取消報
    notifier.notifyEew(
      { ...info, infoType: "取消", serial: "2" },
      makeResult({ isCancelled: true }),
    );
    expect(playSoundMock).toHaveBeenNthCalledWith(2, "cancel");

    // 同じ eventId で再度発表 → 初回扱いで鳴る (実運用ではほぼ無いが安全網)
    notifier.notifyEew({ ...info, serial: "3" }, makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledTimes(3);
  });

  it("受理済み訂正は実質差分がなくても訂正を明示して一回通知する", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-CORRECTION" });
    notifier.notifyEew(info, makeResult({ isNew: true }));
    notifyMock.mockClear();
    playSoundMock.mockClear();

    notifier.notifyEew(
      { ...info, infoType: "訂正" },
      makeResult({ isCorrection: true }),
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0].title).toContain("訂正");
    expect(notifyMock.mock.calls[0][0].message).toContain("訂正");
    expect(playSoundMock).toHaveBeenCalledWith("warning");
  });

  it("semantic duplicate と判定済みの訂正は通知しない", () => {
    const notifier = new Notifier();
    notifier.notifyEew(
      makeEewInfo({
        eventId: "EVT-CORRECTION-DUP",
        infoType: "訂正",
      }),
      makeResult({ isCorrection: true, isDuplicate: true }),
    );

    expect(notifyMock).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("result.isSuppressed=true は何もしない (eventId も記録しない)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-G" });
    notifier.notifyEew(info, makeResult({ isSuppressed: true }));
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();

    // 抑制された後でも、次の正規通知は初回扱いで鳴る
    notifier.notifyEew(info, makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it("eventId=null では従来通り result.isNew にフォールバックする", () => {
    const notifier = new Notifier();
    // eventId なし & isNew=true → 鳴る
    notifier.notifyEew(makeEewInfo({ eventId: null }), makeResult({ isNew: true }));
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    // eventId なし & isNew=false & 全 flag false → 鳴らない
    notifier.notifyEew(makeEewInfo({ eventId: null, serial: "2" }), makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it("settings.eew=false なら何もしない", () => {
    const notifier = new Notifier();
    notifier.toggleCategory("eew"); // eew を OFF に
    notifier.notifyEew(makeEewInfo({ eventId: "EVT-H" }), makeResult({ isNew: true }));
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("result.isDuplicate=true は何もしない (Notifier 単体契約のガード)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({ eventId: "EVT-I" });
    // 通常は processEew 上流で落ちるが、Notifier に直接届いても初回扱いにしない
    notifier.notifyEew(info, makeResult({ isDuplicate: true }));
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();

    // 重複でガードされた後でも、後続の正規通知は初回扱いで鳴る
    notifier.notifyEew(info, makeResult({ isNew: false }));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it("通知本文の最大予測震度は To 基準 (悲観側) で算出される (spec 4.5)", () => {
    const notifier = new Notifier();
    const info = makeEewInfo({
      eventId: "EVT-TO",
      forecastIntensity: {
        areas: [
          { name: "南部", intensity: "4" },
          { name: "北部", intensity: "4", intensityTo: "5-" },
        ],
      },
    });
    notifier.notifyEew(info, makeResult({ isNew: true }));

    const body = notifyMock.mock.calls[0][0].message as string;
    expect(body).toContain("最大予測震度5-");
    expect(body).not.toContain("最大予測震度4");
  });

  describe("TTL cleanup (10分超で履歴削除)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("10分未満経過後の同じ eventId は鳴らない", () => {
      const notifier = new Notifier();
      const info = makeEewInfo({ eventId: "EVT-TTL-1" });
      notifier.notifyEew(info, makeResult({ isNew: true }));
      expect(playSoundMock).toHaveBeenCalledTimes(1);

      // 9 分経過
      vi.advanceTimersByTime(9 * 60 * 1000);
      notifier.notifyEew({ ...info, serial: "2" }, makeResult({ isNew: false }));
      expect(playSoundMock).toHaveBeenCalledTimes(1); // 履歴有効 → 鳴らない
    });

    it("10分超経過後に notifyEew を呼ぶと cleanup され、同じ eventId が再度初回扱いで鳴る", () => {
      const notifier = new Notifier();
      const info = makeEewInfo({ eventId: "EVT-TTL-2" });
      notifier.notifyEew(info, makeResult({ isNew: true }));
      expect(playSoundMock).toHaveBeenCalledTimes(1);

      // 10 分 + 1 秒経過
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      // 次の notifyEew 呼び出し時に cleanup が走り、履歴から削除される
      notifier.notifyEew({ ...info, serial: "2" }, makeResult({ isNew: false }));
      expect(playSoundMock).toHaveBeenCalledTimes(2); // 履歴クリア → 再度鳴る
    });
  });
});

describe("resolveIconPath", () => {
  // 他の describe が通知経路経由でキャッシュを埋めることがあるため、前後両方で clear する
  // (afterEach だけだと実行順によって前段の解決結果が残る)
  beforeEach(() => {
    clearIconPathCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearIconPathCache();
  });
  it("returns {prefix}-{level}.png when it exists", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami-critical\.png$/);
    spy.mockRestore();
  });

  it("falls back to {prefix}.png when level-specific icon is missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("tsunami.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami\.png$/);
    expect(result).not.toMatch(/tsunami-critical/);
    spy.mockRestore();
  });

  it("falls back to default.png when category icon is also missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("default.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/default\.png$/);
    spy.mockRestore();
  });

  it("returns undefined when no icon files exist", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toBeUndefined();
    spy.mockRestore();
  });

  it("skips level-specific candidate when level is undefined", () => {
    const calls: string[] = [];
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      calls.push(String(p));
      return String(p).endsWith("earthquake.png");
    });
    const result = resolveIconPath("earthquake");
    expect(result).toMatch(/earthquake\.png$/);
    expect(calls.some((c) => c.includes("earthquake-"))).toBe(false);
    spy.mockRestore();
  });

  it("maps camelCase categories to kebab-case prefixes", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("seismicText", "info");
    expect(result).toMatch(/seismic-text-info\.png$/);
    spy.mockRestore();
  });
});

describe("Notifier.notifyWeatherWarning (soundLevel override, Codex 最終レビュー F-3)", () => {
  /** ParsedWeatherWarning の最小スタブ (maxDisplaySeverity=null → weatherSoundLevel は "info") */
  function makeWeatherInfo(opts?: Partial<ParsedWeatherWarning>): ParsedWeatherWarning {
    return {
      meta: testTelegramMeta(false),
      type: "VPWS50",
      infoType: "発表",
      title: "気象警報・注意報（全国集約）",
      reportDateTime: "2026-06-12T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      controlTitle: "気象警報・注意報（全国集約）",
      layers: [],
      comments: [],
      maxSeverity: "unknown",
      maxDisplaySeverity: null,
      maxSoundLevel: null,
      warningAreaCount: 0,
      advisoryAreaCount: 0,
      isTest: false,
      ...opts,
    };
  }

  beforeEach(() => {
    clearIconPathCache();
    // playSound はファイル全体で呼び出し履歴が累積するため、toHaveBeenCalledWith の
    // 誤 PASS (他テストの呼び出しヒット) を防いでこの describe では毎回クリアする
    vi.mocked(playSound).mockClear();
  });

  it("カテゴリ OFF でも critical は通知と通知音を出す", () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(
      makeWeatherInfo({ maxDisplaySeverity: "officialL5", maxSoundLevel: "critical" }),
      "critical",
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("critical");
  });

  it("カテゴリ OFF の warning は通知しない", () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(makeWeatherInfo(), "warning");

    expect(notifyMock).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("カテゴリ OFF の取消は critical override でも通知しない", () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(makeWeatherInfo({ infoType: "取消" }), "critical");

    expect(notifyMock).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("保存済みの weather=true は既定 OFF より優先される", () => {
    vi.mocked(loadConfig).mockReturnValue({ notify: { weather: true } });
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(makeWeatherInfo(), "warning");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("warning");
  });

  it("override 指定時: weatherSoundLevel(info) 再計算 (info) ではなく override (warning) が通知音に届く", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    // processWeather の unsafe 昇格相当: outcome.presentation.soundLevel = "warning"
    notifier.notifyWeatherWarning(makeWeatherInfo(), "warning");

    expect(playSound).toHaveBeenCalledWith("warning");
  });

  it("override 無し: 従来どおり weatherSoundLevel(info) ベース (maxDisplaySeverity=null → info)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(makeWeatherInfo());

    expect(playSound).toHaveBeenCalledWith("info");
  });

  // 2026-06-12 目視ゲートでレビュー決定: 通知音は特別警報級 (officialL5/nonLevelSpecial) のみ
  // critical。officialL4 は表示 critical のまま音だけ warning。
  // 共存エッジ解消後、音は parser の集合ベース maxSoundLevel を見る (表示代表とは独立)。
  it("officialL4 (単独): 通知音は warning (表示 critical と分離、2026-06-12 レビュー決定)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(
      makeWeatherInfo({ maxDisplaySeverity: "officialL4", maxSoundLevel: "warning" }),
    );

    expect(playSound).toHaveBeenCalledWith("warning");
  });

  it("officialL5 / nonLevelSpecial (特別警報級): 通知音は critical を維持", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(
      makeWeatherInfo({ maxDisplaySeverity: "officialL5", maxSoundLevel: "critical" }),
    );
    expect(playSound).toHaveBeenLastCalledWith("critical");

    notifier.notifyWeatherWarning(
      makeWeatherInfo({ maxDisplaySeverity: "nonLevelSpecial", maxSoundLevel: "critical" }),
    );
    expect(playSound).toHaveBeenLastCalledWith("critical");
  });

  // 2026-06-12 共存エッジ解消: L4 (rank 上位の表示代表) と特別警報級が共存する電文では
  // maxSoundLevel=critical が通知音に届く (修正前は表示代表経由で warning に潰れていた)
  it("L4 + 特別警報級 共存: 通知音は critical (特別警報側が勝つ)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(
      makeWeatherInfo({ maxDisplaySeverity: "officialL4", maxSoundLevel: "critical" }),
    );

    expect(playSound).toHaveBeenLastCalledWith("critical");
  });

  it("取消は override が来ても cancel 直指定 (早期 return が優先)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);

    notifier.notifyWeatherWarning(makeWeatherInfo({ infoType: "取消" }), "warning");

    expect(playSound).toHaveBeenCalledWith("cancel");
  });

  it("受理済み訂正は通知タイトルと本文の両方に訂正を明示する", () => {
    const notifier = new Notifier();
    notifier.notifyWeatherWarning(makeWeatherInfo({ infoType: "訂正" }), "warning");
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("[訂正]"),
      message: expect.stringContaining("訂正:"),
    }));
  });
});

describe("Notifier.notifyTornadoAdvisory (soundLevelOverride, weather F-3 横展開)", () => {
  /** ParsedTornadoAdvisory の最小スタブ (soundLevel=null → tornadoSoundLevel は "info") */
  function makeTornadoInfo(opts?: Partial<ParsedTornadoAdvisory>): ParsedTornadoAdvisory {
    return {
      meta: testTelegramMeta(false),
      type: "VPHW51",
      infoType: "発表",
      title: "東京都竜巻注意情報",
      controlTitle: "竜巻注意情報",
      reportDateTime: "2026-06-12T00:00:00+09:00",
      validDateTime: null,
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      serial: null,
      layers: [],
      sightingAreas: [],
      isSightingTelegram: false,
      hasSightingAreas: false,
      activeAreaCount: 0,
      displaySeverity: null,
      soundLevel: null,
      isTest: false,
      ...opts,
    };
  }

  beforeEach(() => {
    clearIconPathCache();
    vi.mocked(playSound).mockClear();
  });

  it("override 指定時: 再計算 (null → info) ではなく override (warning) が通知音に届く", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyTornadoAdvisory(makeTornadoInfo({ displaySeverity: null, soundLevel: null }), "warning");
    expect(playSound).toHaveBeenCalledWith("warning");
  });

  it("override 無し: 従来どおり tornadoSoundLevel(info) ベース (null → info)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyTornadoAdvisory(makeTornadoInfo({ displaySeverity: null, soundLevel: null }));
    expect(playSound).toHaveBeenCalledWith("info");
  });

  it("取消: override より cancel 直指定が優先", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyTornadoAdvisory(makeTornadoInfo({ infoType: "取消" }), "warning");
    expect(playSound).toHaveBeenCalledWith("cancel");
  });

  it("通常目撃 (hasSightingAreas=true): 通知本文に「目撃情報あり」が出る", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyTornadoAdvisory(
      makeTornadoInfo({ isSightingTelegram: true, hasSightingAreas: true }),
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("目撃情報あり");
    expect(callArg.message).not.toContain("目撃情報 (地域不明)");
  });

  it("フェイルセーフ (目撃電文だが地域抽出失敗): 通知本文に「目撃情報 (地域不明)」が出る", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyTornadoAdvisory(
      makeTornadoInfo({ isSightingTelegram: true, hasSightingAreas: false }),
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("目撃情報 (地域不明)");
    expect(callArg.message).not.toContain("目撃情報あり");
  });
});

describe("Notifier.notifyWeatherBriefing (soundLevelOverride + summary, weather F-3 横展開)", () => {
  /** ParsedWeatherBriefing の最小スタブ (maxSoundLevel=null + unknown なし → briefingSoundLevel は "info") */
  function makeBriefingInfo(opts?: Partial<ParsedWeatherBriefing>): ParsedWeatherBriefing {
    return {
      meta: testTelegramMeta(false),
      type: "VPBS50",
      infoType: "発表",
      title: "千葉県気象防災速報",
      controlTitle: "気象防災速報",
      reportDateTime: "2026-06-12T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      eventId: null,
      serial: null,
      briefingTag: "other",
      briefingCondition: "",
      briefingConditions: [],
      briefingSeverityEvidence: [],
      maxDisplaySeverity: null,
      maxSoundLevel: null,
      unknownConditions: [],
      targetAreas: [],
      observations: [],
      isTest: false,
      ...opts,
    };
  }

  beforeEach(() => {
    clearIconPathCache();
    vi.mocked(playSound).mockClear();
  });

  it("override 指定時: 再計算 (null → info) ではなく override (warning) が通知音に届く", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyWeatherBriefing(makeBriefingInfo({ maxDisplaySeverity: null, maxSoundLevel: null }), "warning");
    expect(playSound).toHaveBeenCalledWith("warning");
  });

  it("override 無し: briefingSoundLevel(info) ベース (null → info)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyWeatherBriefing(makeBriefingInfo({ maxDisplaySeverity: null, maxSoundLevel: null }));
    expect(playSound).toHaveBeenCalledWith("info");
  });

  it("取消: override より cancel 直指定が優先", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(true);
    notifier.notifyWeatherBriefing(makeBriefingInfo({ infoType: "取消" }), "warning");
    expect(playSound).toHaveBeenCalledWith("cancel");
  });

  it("通知本文: briefingConditions が代表含め最大 3 件まで連結される", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    const info = makeBriefingInfo({
      briefingCondition: "記録的短時間大雨",
      briefingConditions: ["記録的短時間大雨", "短時間大雪あれこれ", "謎の現象", "4件目は出ない"],
    });
    notifier.notifyWeatherBriefing(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("記録的短時間大雨");
    expect(callArg.message).toContain("短時間大雪あれこれ");
    expect(callArg.message).toContain("謎の現象");
    expect(callArg.message).not.toContain("4件目は出ない");
  });

  it("通知本文: 代表 (briefingCondition) が空でも briefingConditions にフォールスルーし、先頭に余計な ' / ' が出ない", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    const info = makeBriefingInfo({
      briefingCondition: "",
      briefingConditions: ["短時間大雪あれこれ"],
    });
    notifier.notifyWeatherBriefing(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("短時間大雪あれこれ");
    // 空代表が join に混ざると "/ 短時間大雪あれこれ" のような先頭区切りが出る
    expect(callArg.message.startsWith("短時間大雪あれこれ")).toBe(true);
  });
});

describe("Notifier.notifyWeatherExplanation (controlTitle 由来通知)", () => {
  /** ParsedWeatherExplanation の最小スタブ */
  function makeExplanationInfo(
    opts: Partial<ParsedWeatherExplanation> & { controlTitle: string },
  ): ParsedWeatherExplanation {
    return {
      meta: testTelegramMeta(false),
      type: "VPCJ51",
      infoType: "発表",
      title: `${opts.controlTitle}（テスト）`,
      reportDateTime: "2026-06-06T12:00:00+09:00",
      targetDateTime: null,
      validDateTime: null,
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      eventId: null,
      serial: null,
      informationTags: [],
      targetAreas: [],
      sections: [],
      forecast: null,
      observation: null,
      tidal: null,
      isTest: false,
      ...opts,
    };
  }

  beforeEach(() => {
    clearIconPathCache();
  });

  it("VPZJ51 (controlTitle=全般気象解説情報) の通常発表: title に controlTitle が含まれる (send(info.title) パス)", () => {
    // 通常発表は info.title を送るパス、controlTitle は取消パスで使う
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      type: "VPZJ51",
      controlTitle: "全般気象解説情報",
      title: "全般気象解説情報（線状降水帯半日前予測）",
    });

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.title).toContain("全般気象解説情報");
    expect(callArg.title).not.toContain("地方気象解説情報");
  });

  it("VPZJ51 取消: 本文が『全般気象解説情報は取り消されました』になる", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      type: "VPZJ51",
      infoType: "取消",
      controlTitle: "全般気象解説情報",
      title: "全般気象解説情報（線状降水帯半日前予測）",
    });

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe("全般気象解説情報は取り消されました");
  });

  it("VPCJ51 (controlTitle=地方気象解説情報) の取消: 本文が『地方気象解説情報は取り消されました』のまま (VPCJ51 回帰)", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      type: "VPCJ51",
      infoType: "取消",
      controlTitle: "地方気象解説情報",
      title: "関東甲信地方気象解説情報（強い冬型・大雪）",
    });

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe("地方気象解説情報は取り消されました");
  });

  it("controlTitle が空文字のとき fallback として『気象解説情報』が使われる", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      infoType: "取消",
      controlTitle: "",
      title: "気象解説情報",
    });

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe("気象解説情報は取り消されました");
  });

  it("VPFJ51 観測実況の最初の remark を通知本文に 1 行加算", () => {
    const msg = createMockWsDataMessage("85_01_01_250630_VPFJ51.xml");
    const info = parseWeatherExplanation(msg);
    expect(info).not.toBeNull();
    expect(info!.observation).not.toBeNull();

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    notifier.notifyWeatherExplanation(info!);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    // 観測実況行が本文に含まれ、station name と sentence を含む
    expect(callArg.message).toContain("観測実況:");
    expect(callArg.message).toContain("三宅島");
    // sentence に既に「観測史上１位」が含まれるので二重表記しない
    expect((callArg.message.match(/観測史上/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("VPCJ51 (observation=null) では observation 行が加算されない", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      type: "VPCJ51",
      controlTitle: "地方気象解説情報",
      title: "関東甲信地方気象解説情報（強い冬型・大雪）",
      // observation は明示的に null (デフォルト)
      observation: null,
    });
    expect(info.observation).toBeNull();

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).not.toContain("観測実況:");
  });

  it("observation の sentence が空でも values 文字列で代替して通知に値が出る", () => {
    // notifier.ts: `const rendered = m.sentence || valueStr` の fallback 分岐を踏む合成テスト
    // sentence="" + values=[{value:10,unit:"mm"}] + remark="観測史上１位" のとき
    // 通知本文に "観測実況: テスト地点 10mm ※観測史上１位" が含まれること、二重表記なしを assert
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info = makeExplanationInfo({
      type: "VPFJ51",
      controlTitle: "府県気象解説情報",
      title: "府県気象解説情報（テスト）",
      observation: {
        fallback: "none",
        series: [
          {
            propertyType: "雨の実況",
            element: null,
            partType: "PrecipitationPart",
            observedAt: "2026-06-06T09:00:00+09:00",
            intro: [],
            supplement: [],
            timeDefines: [],
            stations: [
              {
                stationName: "テスト地点",
                stationCode: "99999",
                stationLocation: "東京都",
                measurements: [
                  {
                    partType: "PrecipitationPart",
                    sentence: "",  // 空 → values fallback が発動するはず
                    time: null,
                    remark: "観測史上１位",
                    values: [
                      {
                        timeRef: "",
                        timeName: null,
                        subType: "",
                        unit: "mm",
                        value: 10,
                        condition: null,
                        description: null,
                        raw: "10",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    notifier.notifyWeatherExplanation(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    // sentence が空でも values から "10mm" が使われる
    expect(callArg.message).toContain("観測実況: テスト地点 10mm");
    // remark は sentence に含まれないので ※ 付きで追記される
    expect(callArg.message).toContain("※観測史上１位");
    // 二重表記なし (※観測史上１位 が 1 回だけ)
    expect((callArg.message.match(/観測史上/g) ?? []).length).toBe(1);
  });
});

describe("Notifier.notifyClimateInfo (controlTitle 由来通知)", () => {
  beforeEach(() => {
    clearIconPathCache();
  });

  it("VPCI50 取消: 本文が『地方天候情報は取り消されました』になる", () => {
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_CANCEL));
    expect(info).not.toBeNull();
    expect(info!.infoType).toBe("取消");
    expect(info!.controlTitle).toBe("地方天候情報");

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    notifier.notifyClimateInfo(info!);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.title).toContain("[取消]");
    expect(callArg.message).toBe("地方天候情報は取り消されました");
  });

  it("VPZI50 取消: 本文が『全般天候情報は取り消されました』のまま (退行ガード)", () => {
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY));
    expect(info).not.toBeNull();
    info!.infoType = "取消";

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    notifier.notifyClimateInfo(info!);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe("全般天候情報は取り消されました");
  });
});

describe("Notifier.notifyHeatAlert (VPFT50)", () => {
  const playSoundMock = vi.mocked(playSound);

  beforeEach(() => {
    playSoundMock.mockClear();
    clearIconPathCache();
  });

  it("発表: title / message (府県 + 本文先頭文) で通知され、soundLevel override が音に届く", () => {
    const notifier = new Notifier();
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;

    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.title).toBe("埼玉県熱中症警戒アラート");
    expect(callArg.message).toContain("埼玉県");
    expect(callArg.message).toContain("熱中症による人の健康に係る被害");
    expect(playSoundMock).toHaveBeenCalledWith("warning");
  });

  it("soundLevel override が再計算 (heatAlertSoundLevel) より優先される (drift 予防の契約)", () => {
    const notifier = new Notifier();
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;

    // 再計算なら warning になるところを override の "info" が勝つこと
    notifier.notifyHeatAlert(info, "info");

    expect(playSoundMock).toHaveBeenCalledWith("info");
  });

  it("題名昇格: 通知タイトルに昇格後の題名がそのまま載り、音は override の warning で送られる", () => {
    const notifier = new Notifier();
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_TITLE_ESCALATION))!;

    // presentation 層の resolveHeatAlertLevels が導く sound (warning) を override で渡す実経路を再現
    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.title).toBe("埼玉県熱中症特別警戒アラート");
    expect(playSoundMock).toHaveBeenCalledWith("warning");
  });

  it("category はアイコン経由で heatAlert が使われる (heat-alert.png)", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("heat-alert.png");
    });

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;

    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: expect.stringMatching(/heat-alert\.png$/),
      }),
    );

    spy.mockRestore();
  });

  it("取消: [取消] プレフィクス + 取消文言 + cancel 音 (override より優先)", () => {
    const notifier = new Notifier();
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_CANCEL))!;

    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.title).toBe("[取消] 埼玉県熱中症警戒アラート");
    expect(callArg.message).toBe("熱中症警戒アラートは取り消されました");
    expect(playSoundMock).toHaveBeenCalledWith("cancel");
  });

  it("settings.heatAlert=false なら通知しない", () => {
    const notifier = new Notifier();
    notifier.toggleCategory("heatAlert"); // デフォルト true → false
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;

    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("本文なし + 府県抽出不能なら通知 body が info.title にフォールバック", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    const parsed = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_NO_BODY))!;
    // NO_BODY fixture は bodyText=null。さらに府県抽出不能ケースを合成し parts 空を再現
    const info = { ...parsed, targetAreaName: null };

    notifier.notifyHeatAlert(info, "warning");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe(info.title);
  });
});
