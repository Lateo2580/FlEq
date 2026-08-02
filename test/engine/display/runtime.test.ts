import { testTelegramMeta } from "../../helpers/telegram-meta";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startDisplayRuntime,
  tsunamiSeedFromParsed,
  weatherAlertsFromVpws50,
  weatherAlertsFromVpww56,
  getActiveDisplayRuntime,
  setActiveDisplayRuntime,
  type DisplayRuntime,
} from "../../../src/engine/display/runtime";
import { KILL_SWITCH_ERRORS } from "../../../src/engine/display/constants";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import {
  canonicalizeLegacyTsunamiInfo,
  canonicalizeLegacyTsunamiObservation,
  type LegacyParsedTsunamiInfoInput,
} from "../../../src/dmdata/tsunami-legacy-adapter";
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type ParsedTsunamiInfo,
  type Vpws50CurrentAreasForDisplay,
} from "../../../src/types";

function tsunamiInfo(over: Partial<LegacyParsedTsunamiInfoInput> = {}): ParsedTsunamiInfo {
  return canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE41",
    infoType: "発表",
    title: "津波警報・注意報・予報a",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    forecast: [
      { areaName: "石川県能登", kind: "津波警報", maxHeightDescription: "３ｍ", firstHeight: "既に到達と推測" },
      { areaName: "新潟県上中下越", kind: "津波注意報", maxHeightDescription: "１ｍ", firstHeight: "０６日２２時００分" },
      { areaName: "北海道太平洋沿岸東部", kind: "津波予報（若干の海面変動）", maxHeightDescription: "0.2m未満", firstHeight: "" },
    ],
    warningComment: "",
    isTest: false,
    ...over,
  });
}

function mockDisplay(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(),
    displayRawHeader: vi.fn(),
    displayVolcano: vi.fn(),
    displayVolcanoBatch: vi.fn(),
    getDisplayMode: () => "normal",
    renderSummaryLine: () => "要約",
  };
}

function testConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, apiKey: "test", display: true, displayPort: 0 };
}

function activePromotionView(): Vpws50CurrentAreasForDisplay {
  return {
    totalAreas: 1, specialAreas: 1, warningAreas: 0, advisoryAreas: 0,
    kinds: [{
      kindCode: "33",
      kindShortName: "大雨",
      kindName: "大雨特別警報",
      displaySeverity: "officialL5",
      officialAlertLevel: 5,
      areas: [{ areaName: "東京都", areaCode: "130000" }],
    }],
  };
}

describe("tsunamiSeedFromParsed", () => {
  it("forecast[].kind から最大レベルを検出し、警報・注意報の沿岸だけを coasts に組む", () => {
    const seed = tsunamiSeedFromParsed(tsunamiInfo());

    expect(seed).not.toBeNull();
    expect(seed!.kind).toBe("tsunami");
    expect(seed!.level).toBe("warning");
    expect(seed!.levelLabel).toBe("津波警報");
    expect(seed!.coasts).toEqual([
      { name: "石川県能登", kind: "津波警報", maxHeight: "３ｍ", firstHeight: "既に到達と推測" },
      { name: "新潟県上中下越", kind: "津波注意報", maxHeight: "１ｍ", firstHeight: "０６日２２時００分" },
    ]);
    expect(seed!.reportDateTime).toBe("2026-07-06T21:00:00+09:00");
  });

  it("warningComment と observations を info から引き継ぐ", () => {
    const seed = tsunamiSeedFromParsed(
      tsunamiInfo({
        warningComment: "満潮と重なるとより高くなります",
        observations: [
          {
            areaName: "石川県能登",
            name: "輪島",
            sensor: "検潮所",
            arrivalTime: "2026-07-06T21:10:00+09:00",
            initial: "押し",
            maxHeightCondition: "観測中",
            maxHeightValue: "0.5m",
          },
        ],
      }),
    );

    expect(seed!.warningComment).toBe("満潮と重なるとより高くなります");
    expect(seed!.observations).toEqual([
      {
        areaName: "石川県能登",
        areaKind: "津波警報",
        stationName: "輪島",
        arrivalTime: "2026-07-06T21:10:00+09:00",
        initial: "押し",
        maxHeightValue: "0.5m",
        condition: "観測中",
      },
    ]);
  });

  it("大津波警報を含むと majorWarning になる", () => {
    const seed = tsunamiSeedFromParsed(
      tsunamiInfo({
        forecast: [
          { areaName: "石川県能登", kind: "大津波警報", maxHeightDescription: "１０ｍ超", firstHeight: "既に到達と推測" },
          { areaName: "新潟県上中下越", kind: "津波警報", maxHeightDescription: "３ｍ", firstHeight: "" },
        ],
      }),
    );

    expect(seed!.level).toBe("majorWarning");
    expect(seed!.levelLabel).toBe("大津波警報");
  });

  it("取消報では null を返す", () => {
    expect(tsunamiSeedFromParsed(tsunamiInfo({ infoType: "取消" }))).toBeNull();
  });

  it("警報なし (津波予報のみ) では null を返す", () => {
    const seed = tsunamiSeedFromParsed(
      tsunamiInfo({
        forecast: [
          { areaName: "北海道太平洋沿岸東部", kind: "津波予報（若干の海面変動）", maxHeightDescription: "0.2m未満", firstHeight: "" },
        ],
      }),
    );
    expect(seed).toBeNull();
  });
});

describe("weatherAlertsFromVpws50", () => {
  const view: Vpws50CurrentAreasForDisplay = {
    totalAreas: 2,
    specialAreas: 0,
    warningAreas: 1,
    advisoryAreas: 2,
    kinds: [
      {
        kindCode: "03",
        kindShortName: "大雨",
        kindName: "レベル３大雨警報",
        displaySeverity: "officialL3",
        officialAlertLevel: 3,
        areas: [{ areaName: "能登北部", areaCode: "390010" }],
      },
      {
        kindCode: "08",
        kindShortName: "高潮",
        kindName: "高潮注意報",
        displaySeverity: "nonLevelAdvisory",
        officialAlertLevel: null,
        areas: [
          { areaName: "能登北部", areaCode: "390010" },
          { areaName: "能登南部", areaCode: "390020" },
        ],
      },
    ],
  };

  it("undefined 入力では [] を返す", () => {
    expect(weatherAlertsFromVpws50(undefined, "2026-07-06T21:00:00+09:00")).toEqual([]);
  });

  it("警報級のみを載せ、注意報 (advisory) は種別を問わず除外する", () => {
    const alerts = weatherAlertsFromVpws50(view, "2026-07-06T21:00:00+09:00");

    // 大雨(officialL3)=warning は載り、高潮(nonLevelAdvisory)=advisory は除外される
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      source: "vpws50",
      label: "気象警報",
      role: "weatherWarning",
      totalAreas: 1,
      items: [
        {
          kind: "L3 大雨警報",
          phenomenonKey: "大雨",
          displaySeverity: "officialL3",
          rank: "warning",
          shownAreas: ["能登北部"],
          omittedAreaCount: 0,
        },
      ],
      updatedAt: "2026-07-06T21:00:00+09:00",
    });
  });

  it("注意報のみなら空配列を返す", () => {
    const advisoryOnly: Vpws50CurrentAreasForDisplay = {
      ...view,
      kinds: [view.kinds[1]],
    };
    const alerts = weatherAlertsFromVpws50(advisoryOnly, "2026-07-06T21:00:00+09:00");
    expect(alerts).toEqual([]);
  });

  it("nonLevelSpecial は emergency バケツに分離され、advisory は種別を問わず除外される", () => {
    const special: Vpws50CurrentAreasForDisplay = {
      totalAreas: 4,
      specialAreas: 1,
      warningAreas: 1,
      advisoryAreas: 1,
      kinds: [
        {
          kindCode: "33",
          kindShortName: "大雨",
          kindName: "大雨特別警報",
          displaySeverity: "nonLevelSpecial",
          officialAlertLevel: null,
          areas: [{ areaName: "能登北部", areaCode: "390010" }],
        },
        {
          kindCode: "49",
          kindShortName: "土砂災害",
          kindName: "レベル４土砂災害危険警報",
          displaySeverity: "officialL4",
          officialAlertLevel: 4,
          areas: [{ areaName: "能登南部", areaCode: "390020" }],
        },
        {
          kindCode: "08",
          kindShortName: "高潮",
          kindName: "高潮注意報",
          displaySeverity: "nonLevelAdvisory",
          officialAlertLevel: null,
          areas: [{ areaName: "能登北部", areaCode: "390010" }],
        },
        {
          kindCode: "14",
          kindShortName: "雷",
          kindName: "雷注意報",
          displaySeverity: "nonLevelAdvisory",
          officialAlertLevel: null,
          areas: [{ areaName: "能登北部", areaCode: "390010" }],
        },
      ],
    };

    const alerts = weatherAlertsFromVpws50(special, "2026-07-06T21:00:00+09:00");

    // advisory (高潮・雷) は種別を問わず除外され、emergency と warning の 2 バケツのみ
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toEqual({
      source: "vpws50",
      label: "気象特別警報",
      role: "weatherEmergency",
      totalAreas: 1,
      items: [
        {
          kind: "大雨特別警報",
          phenomenonKey: "大雨",
          displaySeverity: "nonLevelSpecial",
          rank: "emergency",
          shownAreas: ["能登北部"],
          omittedAreaCount: 0,
        },
      ],
      updatedAt: "2026-07-06T21:00:00+09:00",
    });
    expect(alerts[1]).toEqual({
      source: "vpws50",
      label: "気象警報",
      role: "weatherWarning",
      totalAreas: 1,
      items: [
        {
          kind: "L4 土砂災害危険警報",
          phenomenonKey: "土砂災害",
          displaySeverity: "officialL4",
          rank: "warning",
          shownAreas: ["能登南部"],
          omittedAreaCount: 0,
        },
      ],
      updatedAt: "2026-07-06T21:00:00+09:00",
    });
  });
});

describe("weatherAlertsFromVpww56", () => {
  it("undefined 入力では [] を返す", () => {
    expect(weatherAlertsFromVpww56(undefined, "2026-07-08T12:00:00+09:00")).toEqual([]);
  });

  it("kinds が空なら [] を返す", () => {
    const empty: Vpws50CurrentAreasForDisplay = {
      totalAreas: 0, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds: [],
    };
    expect(weatherAlertsFromVpww56(empty, "2026-07-08T12:00:00+09:00")).toEqual([]);
  });

  it("displaySeverity から rank を導出し 1 件の alert (source: vpww56) に変換する。officialL5 は emergency", () => {
    const view: Vpws50CurrentAreasForDisplay = {
      totalAreas: 1, specialAreas: 0, warningAreas: 0, advisoryAreas: 0,
      kinds: [
        {
          kindCode: "39",
          kindShortName: "土砂災害",
          kindName: "レベル５土砂災害特別警報",
          displaySeverity: "officialL5",
          officialAlertLevel: 5,
          areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
        },
      ],
    };

    const alerts = weatherAlertsFromVpww56(view, "2026-07-08T12:00:00+09:00");

    expect(alerts).toEqual([
      {
        source: "vpww56",
        label: "土砂災害警戒情報",
        role: "weatherEmergency",
        totalAreas: 1,
        items: [
          {
            kind: "L5 土砂災害特別警報",
            phenomenonKey: "土砂災害",
            displaySeverity: "officialL5",
            rank: "emergency",
            shownAreas: ["宗谷地方"],
            omittedAreaCount: 0,
          },
        ],
        updatedAt: "2026-07-08T12:00:00+09:00",
      },
    ]);
  });

  it("実物 fixture (VPWW56 レベル4) の現況は officialL4 → warning ロールになる", () => {
    const view: Vpws50CurrentAreasForDisplay = {
      totalAreas: 1, specialAreas: 0, warningAreas: 0, advisoryAreas: 0,
      kinds: [
        {
          kindCode: "49",
          kindShortName: "土砂災害",
          kindName: "レベル４土砂災害危険警報",
          displaySeverity: "officialL4",
          officialAlertLevel: 4,
          areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
        },
      ],
    };

    const alerts = weatherAlertsFromVpww56(view, "2026-07-08T12:00:00+09:00");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].role).toBe("weatherWarning");
    expect(alerts[0].items[0].rank).toBe("warning");
  });

  it("advisory 級 displaySeverity の item は除外され、全 item が advisory なら [] を返す", () => {
    const view: Vpws50CurrentAreasForDisplay = {
      totalAreas: 1, specialAreas: 0, warningAreas: 0, advisoryAreas: 1,
      kinds: [
        {
          kindCode: "39",
          kindShortName: "土砂災害",
          kindName: "土砂災害注意報",
          displaySeverity: "nonLevelAdvisory",
          officialAlertLevel: null,
          areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
        },
      ],
    };

    expect(weatherAlertsFromVpww56(view, "2026-07-08T12:00:00+09:00")).toEqual([]);
  });

  it("警報級と advisory 級が混在する場合、advisory 級 item だけが除外される", () => {
    const view: Vpws50CurrentAreasForDisplay = {
      totalAreas: 2, specialAreas: 0, warningAreas: 1, advisoryAreas: 1,
      kinds: [
        {
          kindCode: "49",
          kindShortName: "土砂災害",
          kindName: "レベル４土砂災害危険警報",
          displaySeverity: "officialL4",
          officialAlertLevel: 4,
          areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
        },
        {
          kindCode: "39",
          kindShortName: "土砂災害",
          kindName: "土砂災害注意報",
          displaySeverity: "nonLevelAdvisory",
          officialAlertLevel: null,
          areas: [{ areaName: "上川地方", areaCode: "012000" }],
        },
      ],
    };

    const alerts = weatherAlertsFromVpww56(view, "2026-07-08T12:00:00+09:00");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].items).toHaveLength(1);
    expect(alerts[0].items[0].shownAreas).toEqual(["宗谷地方"]);
    expect(alerts[0].items[0].rank).toBe("warning");
  });
});

describe("startDisplayRuntime: seed 統合 (acceptance #12 unit 版)", () => {
  let runtime: DisplayRuntime | null = null;
  let distDir: string | null = null;

  afterEach(async () => {
    if (runtime != null) await runtime.stop();
    runtime = null;
    setActiveDisplayRuntime(null);
    delete process.env.FLEQ_DISPLAY_DIST;
    if (distDir != null) rmSync(distDir, { recursive: true, force: true });
    distDir = null;
  });

  it("TsunamiStateHolder の警報状態が buildSnapshot().tsunami に seed され /healthz が 200 を返す", async () => {
    const holder = new TsunamiStateHolder();
    holder.applyAcceptedObservations("VTSE51", [canonicalizeLegacyTsunamiObservation({
      areaName: "岩手県",
      stationCode: "21001",
      name: "宮古",
      sensor: "検潮所",
      arrivalTime: "2026-07-06T21:10:00+09:00",
      initial: "押し",
      maxHeightCondition: "観測中",
      maxHeightValue: "1.0m",
    })]);
    holder.applyAccepted(tsunamiInfo());
    distDir = mkdtempSync(join(tmpdir(), "fleq-display-"));
    writeFileSync(join(distDir, "index.html"), "<html>ok</html>");
    process.env.FLEQ_DISPLAY_DIST = distDir;

    runtime = await startDisplayRuntime(testConfig(), mockDisplay(), {
      tsunami: () => holder.getLastInfo(),
      tsunamiObservations: () => holder.getObservationGroups(),
      weather: () => undefined,
      landslide: () => undefined,
    });

    expect(runtime).not.toBeNull();
    const snap = runtime!.hub.buildSnapshot();
    expect(snap.tsunami).not.toBeNull();
    expect(snap.tsunami!.levelLabel).toBe("津波警報");
    expect(snap.tsunami!.level).toBe("warning");
    expect(snap.tsunami!.observations).toEqual([
      expect.objectContaining({ stationCode: "21001", stationName: "宮古" }),
    ]);

    const res = await fetch(`http://127.0.0.1:${runtime!.transport.port()}/healthz`);
    expect(res.status).toBe(200);
  });

  it("起動時 seed: VPWS50 の警報と VPWW56 の現況が weatherAlerts に merge される", async () => {
    distDir = mkdtempSync(join(tmpdir(), "fleq-display-"));
    writeFileSync(join(distDir, "index.html"), "<html>ok</html>");
    process.env.FLEQ_DISPLAY_DIST = distDir;

    const vpws50View: Vpws50CurrentAreasForDisplay = {
      totalAreas: 1, specialAreas: 0, warningAreas: 1, advisoryAreas: 0,
      kinds: [
        {
          kindCode: "03",
          kindShortName: "大雨",
          kindName: "レベル３大雨警報",
          displaySeverity: "officialL3",
          officialAlertLevel: 3,
          areas: [{ areaName: "能登北部", areaCode: "390010" }],
        },
      ],
    };
    const vpww56View: Vpws50CurrentAreasForDisplay = {
      totalAreas: 1, specialAreas: 0, warningAreas: 0, advisoryAreas: 0,
      kinds: [
        {
          kindCode: "39",
          kindShortName: "土砂災害",
          kindName: "レベル５土砂災害特別警報",
          displaySeverity: "officialL5",
          officialAlertLevel: 5,
          areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
        },
      ],
    };

    runtime = await startDisplayRuntime(testConfig(), mockDisplay(), {
      tsunami: () => null,
      weather: () => vpws50View,
      landslide: () => vpww56View,
    });

    expect(runtime).not.toBeNull();
    const snap = runtime!.hub.buildSnapshot();
    expect(snap.weatherAlerts).toHaveLength(2);
    const roles = snap.weatherAlerts.map((a) => a.role).sort();
    expect(roles).toEqual(["weatherEmergency", "weatherWarning"]);
  });

  it("kill switch (onFatal) で transport が停止し registry が null になる", async () => {
    distDir = mkdtempSync(join(tmpdir(), "fleq-display-"));
    writeFileSync(join(distDir, "index.html"), "<html>ok</html>");
    process.env.FLEQ_DISPLAY_DIST = distDir;
    const display = mockDisplay();
    display.renderSummaryLine = () => {
      throw new Error("boom");
    };

    runtime = await startDisplayRuntime(testConfig(), display, {
      tsunami: () => null,
      weather: () => undefined,
      landslide: () => undefined,
    });
    expect(runtime).not.toBeNull();
    setActiveDisplayRuntime(runtime);
    const port = runtime!.transport.port();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    const event = { id: "x" } as unknown as PresentationEvent; // summarize が先に throw するので中身は使われない
    for (let i = 0; i < KILL_SWITCH_ERRORS; i++) {
      runtime!.hub.ingest(event);
    }

    expect(runtime!.hub.isStopped()).toBe(true);
    // registry (getActiveDisplayRuntime) は transport.stop() 完了後にクリアされる
    // (EADDRINUSE 窓を塞ぐための順序変更)。null になった時点でポートも解放済みのはず
    await vi.waitFor(() => {
      expect(getActiveDisplayRuntime()).toBeNull();
    });
    let stopped = false;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      stopped = true;
    }
    expect(stopped).toBe(true);
  });

  it("dist 欠落時は warn + null で本体は継続する", async () => {
    process.env.FLEQ_DISPLAY_DIST = join(tmpdir(), "fleq-display-runtime-test-not-exist");
    const promotions = new WeatherPromotionStore();
    const promotedAtMs = Date.parse("2026-07-27T12:00:00+09:00");
    promotions.apply("vpws50", activePromotionView(), promotedAtMs);
    const onDurable = vi.fn();
    promotions.onDurable(onDurable);

    const rt = await startDisplayRuntime(testConfig(), mockDisplay(), {
      tsunami: () => null,
      weather: () => undefined,
      landslide: () => undefined,
      weatherPromotions: () => promotions,
    });

    expect(rt).toBeNull();
    const record = promotions.get("vpws50");
    expect(record?.state === "active" ? record.promotedAtMs : null).toBe(promotedAtMs);
    expect(promotions.export().unseenSinceMs).toBeNull();
    expect(onDurable).not.toHaveBeenCalled();
  });
});

describe("module registry", () => {
  it("set/get が往復し、null クリアできる", () => {
    const fake = { hub: {}, transport: {}, stop: async () => {} } as unknown as DisplayRuntime;
    setActiveDisplayRuntime(fake);
    expect(getActiveDisplayRuntime()).toBe(fake);
    setActiveDisplayRuntime(null);
    expect(getActiveDisplayRuntime()).toBeNull();
  });
});
