import { describe, expect, it, vi } from "vitest";
import { WEATHER_PROMOTION_DEMOTE_MIN, STATE_DEBOUNCE_MS } from "../../../src/engine/display/constants";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import {
  classifyWeatherPromotion,
  WEATHER_PROMOTION_SOURCES,
  __test_resetUnknownSeverityWarnings,
} from "../../../src/engine/display/weather-promotion";
import {
  isDisplayWeatherSeverity,
  displayWeatherPromotionLevel,
  type DisplayWeatherSeverityV1,
} from "../../../src/engine/display/protocol";
import type {
  DisplayBroadcastResult,
  DisplayServerMessage,
  DisplayTransport,
  DisplayWeatherAlertV1,
} from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { applyWeatherPromotionOnIngest } from "../../../src/engine/display/weather-promotion-ingest";
import type { Vpws50CurrentAreasForDisplay } from "../../../src/types";
import { DISPLAY_SEVERITY_RANK } from "../../../src/dmdata/weather-warning-level";
import * as log from "../../../src/logger";

const MIN = 60_000;
const T0 = Date.parse("2026-07-25T21:00:00+09:00");
const DEMOTE_MS = WEATHER_PROMOTION_DEMOTE_MIN * MIN;

interface ItemSpec {
  severity: string;
  kind: string;
  areas: string[];
}

function alertsOf(source: "vpws50" | "vpww56", items: ItemSpec[]): DisplayWeatherAlertV1[] {
  if (items.length === 0) return [];
  return [
    {
      source,
      label: source === "vpws50" ? "気象警報" : "土砂災害警戒情報",
      role: "weatherWarning",
      totalAreas: new Set(items.flatMap((i) => i.areas)).size,
      items: items.map((i) => ({
        kind: i.kind,
        displaySeverity: i.severity,
        rank: "warning" as const,
        shownAreas: [...i.areas],
        omittedAreaCount: 0,
      })),
      updatedAt: "2026-07-25T21:00:00+09:00",
    },
  ];
}

const L4_TOKYO: ItemSpec[] = [{ severity: "officialL4", kind: "L4 大雨警報", areas: ["東京都"] }];
const L5_TOKYO: ItemSpec[] = [{ severity: "officialL5", kind: "L5 大雨特別警報", areas: ["東京都"] }];
const L5_TOKYO_CHIBA: ItemSpec[] = [
  { severity: "officialL5", kind: "L5 大雨特別警報", areas: ["東京都", "千葉県"] },
];
const L3_TOKYO: ItemSpec[] = [{ severity: "officialL3", kind: "L3 大雨警報", areas: ["東京都"] }];

/** ItemSpec[] を state holder が返す生 view の形へ (受理経路の入力を模す) */
function rawView(items: ItemSpec[]): Vpws50CurrentAreasForDisplay | undefined {
  if (items.length === 0) return undefined;
  return {
    totalAreas: new Set(items.flatMap((i) => i.areas)).size,
    specialAreas: 0,
    warningAreas: 0,
    advisoryAreas: 0,
    kinds: items.map((i) => ({
      kindCode: "03",
      kindShortName: i.kind,
      kindName: i.kind,
      displaySeverity: i.severity as Vpws50CurrentAreasForDisplay["kinds"][number]["displaySeverity"],
      officialAlertLevel: null,
      areas: i.areas.map((a) => ({ areaName: a, areaCode: a })),
    })),
  };
}

function promotionOf(store: DisplayStateStore, nowMs: number) {
  return store.snapshot(1, nowMs).weatherPromotion;
}

// ── classifier (集合ベース) ──

describe("classifyWeatherPromotion (集合ベース判定)", () => {
  it("L5 相当 = officialL5 ∪ nonLevelSpecial、L4 相当 = officialL4", () => {
    expect(classifyWeatherPromotion(alertsOf("vpws50", L5_TOKYO))?.level).toBe(5);
    expect(
      classifyWeatherPromotion(
        alertsOf("vpws50", [{ severity: "nonLevelSpecial", kind: "暴風特別警報", areas: ["東京都"] }]),
      )?.level,
    ).toBe(5);
    expect(classifyWeatherPromotion(alertsOf("vpws50", L4_TOKYO))?.level).toBe(4);
  });

  it("L3 以下だけなら昇格対象外 (null)", () => {
    expect(classifyWeatherPromotion(alertsOf("vpws50", L3_TOKYO))).toBeNull();
  });

  it("rank 1 点代表ではなく集合ベース: L4 と nonLevelSpecial の共存は L5 を採る", () => {
    const mixed = classifyWeatherPromotion(
      alertsOf("vpws50", [
        { severity: "officialL4", kind: "L4 大雨警報", areas: ["東京都"] },
        { severity: "nonLevelSpecial", kind: "暴風特別警報", areas: ["千葉県"] },
      ]),
    );
    expect(mixed?.level).toBe(5);
  });

  it("未知 severity 値は昇格判定に使わず warn ログを出す", () => {
    __test_resetUnknownSeverityWarnings();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const result = classifyWeatherPromotion(
        alertsOf("vpws50", [{ severity: "officialL9", kind: "謎警報", areas: ["東京都"] }]),
      );
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("未知 severity の warn は値ごとに 1 回だけ (電文ごとのログ氾濫を防ぐ)", () => {
    __test_resetUnknownSeverityWarnings();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const view = alertsOf("vpws50", [{ severity: "officialL9", kind: "謎警報", areas: ["東京都"] }]);
      classifyWeatherPromotion(view);
      classifyWeatherPromotion(view);
      classifyWeatherPromotion(view);
      expect(warn).toHaveBeenCalledTimes(1);
      // 別の未知値は改めて 1 回だけ警告する
      classifyWeatherPromotion(
        alertsOf("vpws50", [{ severity: "officialL8", kind: "別の謎警報", areas: ["東京都"] }]),
      );
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("DisplayWeatherSeverityV1 は DisplaySeverity の全値を閉じた union として覆う", () => {
    const vocabulary = Object.keys(DISPLAY_SEVERITY_RANK);
    for (const value of vocabulary) {
      expect(isDisplayWeatherSeverity(value)).toBe(true);
    }
    // 逆向き: union の各値が DisplaySeverity 側にも存在する (網羅 Record が抜けを compile error にする)
    const promoting: DisplayWeatherSeverityV1[] = ["officialL5", "nonLevelSpecial", "officialL4"];
    for (const value of promoting) {
      expect(vocabulary).toContain(value);
      expect(displayWeatherPromotionLevel(value)).not.toBeNull();
    }
    expect(displayWeatherPromotionLevel("officialL3")).toBeNull();
  });
});

// ── state 遷移 ──

describe("weather promotion state (DisplayStateStore)", () => {
  it("L4 相当の受理で昇格する", () => {
    const store = new DisplayStateStore();
    expect(store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0)).toBe(true);
    const p = promotionOf(store, T0)?.vpws50;
    expect(p).not.toBeNull();
    expect(p?.level).toBe(4);
    expect(p?.promotedAt).toBe(new Date(T0).toISOString());
    expect(p?.generation).toBe(1);
  });

  it("同内容の confirmed 続報でも 30 分を再開する (generation は据置)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    const later = T0 + 20 * MIN;
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
    expect(p?.generation).toBe(1);
    // 再開しているので元の 30 分境界を越えても降格しない
    expect(store.sweep(T0 + DEMOTE_MS + 5_000)).toBe(false);
    expect(promotionOf(store, T0 + DEMOTE_MS + 5_000)?.vpws50).not.toBeNull();
  });

  it("上位遷移 L4→L5 は generation 更新 + 再開", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("L5 の地域追加は generation 更新 + 再開", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO_CHIBA), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  // spec は上位遷移しか明記していないが、実装は signature の増減方向を問わず generation を更新する。
  // Phase 2 が generation を再アニメーション契機に使う場合に効くので、意図した挙動として固定する
  it("L5 の地域削減でも generation は更新される (縮退方向も別内容の昇格として扱う)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO_CHIBA), T0);
    expect(promotionOf(store, T0)?.vpws50?.generation).toBe(1);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("L5→L4 は新たな L4 として再開する", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(4);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("高 severity 集合が空になったら即終了 (demote ではなく record 削除)。L3 継続でも終了", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    const later = T0 + 5 * MIN;
    expect(store.applyWeatherSource("vpws50", alertsOf("vpws50", L3_TOKYO), later)).toBe(true);
    expect(promotionOf(store, later)?.vpws50).toBeNull();
    // tier も weather 由来の押し上げを失う
    expect(store.snapshot(1, later).severityTier).toBe("calm");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(false);
  });

  it("generation watermark は record 削除後も保持される (解除→再発表で同じ generation に戻らない)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    store.applyWeatherSource("vpws50", [], T0 + MIN);
    expect(promotionOf(store, T0 + MIN)?.vpws50).toBeNull();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0 + 2 * MIN);
    expect(promotionOf(store, T0 + 2 * MIN)?.vpws50?.generation).toBe(2);
  });

  it("30 分 + 最大 5 秒で降格する (30 分ちょうどでは降格しない)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    expect(store.sweep(T0 + DEMOTE_MS)).toBe(false);
    expect(promotionOf(store, T0 + DEMOTE_MS)?.vpws50).not.toBeNull();
    expect(store.sweep(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(promotionOf(store, T0 + DEMOTE_MS + 5_000)?.vpws50).toBeNull();
  });

  it("降格後も tier は維持し、activeAlertKeys には含めない", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("critical");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(true);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(2, T0 + DEMOTE_MS + 5_000).severityTier).toBe("critical");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(false);
  });

  it("L4 の降格後の tier は alert (level を保持している)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(1, T0 + DEMOTE_MS + 5_000).severityTier).toBe("alert");
  });

  it("demoted は snapshot の weatherPromotion で null に投影される", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    const snap = store.snapshot(1, T0 + DEMOTE_MS + 5_000);
    expect(snap.weatherPromotion).toEqual({ vpws50: null, vpww56: null });
  });

  it("weatherL5Active は demoted 後も警報解除まで true", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    expect(store.snapshot(1, T0).weatherL5Active).toBe(true);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(2, T0 + DEMOTE_MS + 5_000).weatherL5Active).toBe(true);
    store.applyWeatherSource("vpws50", [], T0 + DEMOTE_MS + 10_000);
    expect(store.snapshot(3, T0 + DEMOTE_MS + 10_000).weatherL5Active).toBe(false);
  });

  it("weatherL5Active は L4 のみでは false", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    expect(store.snapshot(1, T0).weatherL5Active).toBe(false);
  });

  it("source は完全独立: 片方の続報で他方の時計は動かない", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    const later = T0 + 25 * MIN;
    store.applyWeatherSource("vpww56", alertsOf("vpww56", L4_TOKYO), later);
    const p = promotionOf(store, later);
    expect(p?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(p?.vpww56?.promotedAt).toBe(new Date(later).toISOString());
    // vpws50 だけが先に降格する
    store.sweep(T0 + DEMOTE_MS + 5_000);
    const after = promotionOf(store, T0 + DEMOTE_MS + 5_000);
    expect(after?.vpws50).toBeNull();
    expect(after?.vpww56).not.toBeNull();
  });

  it("generation watermark は source 別に持つ", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L4_TOKYO), T0);
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0 + MIN);
    store.applyWeatherSource("vpww56", alertsOf("vpww56", L4_TOKYO), T0 + 2 * MIN);
    const p = promotionOf(store, T0 + 2 * MIN);
    expect(p?.vpws50?.generation).toBe(2);
    expect(p?.vpww56?.generation).toBe(1);
  });

  it("永続化入口: export した lifecycle を restore で復元できる", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0);
    const exported = JSON.parse(JSON.stringify(store.exportWeatherPromotions()));

    const restored = new DisplayStateStore();
    restored.restoreWeatherPromotions(exported, T0 + MIN);
    expect(promotionOf(restored, T0 + MIN)?.vpws50?.generation).toBe(1);
    // 残り時間だけ復元する (promotedAt は延命されない)
    expect(promotionOf(restored, T0 + MIN)?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(restored.snapshot(1, T0 + MIN).severityTier).toBe("critical");
    // 復元後も同内容の続報は generation を据置きで再開する
    restored.applyWeatherSource("vpws50", alertsOf("vpws50", L5_TOKYO), T0 + 2 * MIN);
    expect(promotionOf(restored, T0 + 2 * MIN)?.vpws50?.generation).toBe(1);
  });

  it("WEATHER_PROMOTION_SOURCES は vpws50 / vpww56 の 2 source", () => {
    expect([...WEATHER_PROMOTION_SOURCES]).toEqual(["vpws50", "vpww56"]);
  });
});

// ── hub 経由 (source 別分離 / confidence gate) ──

class FakeTransport implements DisplayTransport {
  messages: DisplayServerMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  broadcast(msg: DisplayServerMessage): DisplayBroadcastResult {
    this.messages.push(msg);
    return { total: 1, blockedSkipped: 0 };
  }
  clientCount(): number {
    return 1;
  }
}

function weatherEvent(over: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: `msg-${Math.random()}`, classification: "telegram.weather", domain: "weather",
    type: "VPWS50", infoType: "発表", title: "気象警報・注意報", headline: null,
    reportDateTime: "2026-07-25T21:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null,
    ...over,
  } as PresentationEvent;
}

describe("InfoDisplayHub の weather promotion 配線", () => {
  // monitor の displaySink 相当。昇格は受理経路 (hub の外) で更新し、hub には表示を任せる。
  // 実配線と同じ順序 (promotion → hub) で呼ぶ
  function setup(views: { vpws50: ItemSpec[]; vpww56: ItemSpec[] }) {
    const promotions = new WeatherPromotionStore();
    const store = new DisplayStateStore(undefined, promotions);
    let nowMs = T0;
    const hub = new InfoDisplayHub(store, {
      summarize: () => "s",
      weatherAlerts: () => [
        ...alertsOf("vpws50", views.vpws50),
        ...alertsOf("vpww56", views.vpww56),
      ],
      now: () => nowMs,
    });
    hub.attachTransport(new FakeTransport());
    const viewSources = {
      vpws50: () => rawView(views.vpws50),
      vpww56: () => rawView(views.vpww56),
    };
    const ingest = (event: PresentationEvent): void => {
      applyWeatherPromotionOnIngest(promotions, viewSources, event, nowMs);
      hub.ingest(event);
    };
    return { store, hub, promotions, ingest, setNow: (v: number) => { nowMs = v; }, views };
  }

  it("VPWS50 の confirmed 受信で vpws50 だけが昇格する", () => {
    const { store, ingest } = setup({ vpws50: L5_TOKYO, vpww56: [] });
    ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }));
    const p = promotionOf(store, T0);
    expect(p?.vpws50?.level).toBe(5);
    expect(p?.vpww56).toBeNull();
  });

  it("unsafe 電文は再昇格契機にしない (時計が動かない)", () => {
    const s = setup({ vpws50: L4_TOKYO, vpww56: [] });
    s.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }));
    expect(promotionOf(s.store, T0)?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());

    const later = T0 + 20 * MIN;
    s.setNow(later);
    s.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "unsafe" }));
    expect(promotionOf(s.store, later)?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
  });

  it("VPWW56 受信は vpws50 の時計を動かさない (hub が両 source を再射影しても)", () => {
    const s = setup({ vpws50: L4_TOKYO, vpww56: [] });
    s.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }));

    const later = T0 + 20 * MIN;
    s.setNow(later);
    s.views.vpww56 = L4_TOKYO;
    s.ingest(weatherEvent({ type: "VPWW56", weatherConfidence: "confirmed" }));

    const p = promotionOf(s.store, later);
    expect(p?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(p?.vpww56?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("weatherConfidence 欠落 (旧経路) は confirmed 扱い", () => {
    const { store, ingest } = setup({ vpws50: L4_TOKYO, vpww56: [] });
    ingest(weatherEvent({ type: "VPWS50" }));
    expect(promotionOf(store, T0)?.vpws50?.level).toBe(4);
  });

  // sweepTicker は store.sweep() を呼ばないので、時間を進めても promotion は active のまま。
  // 「昇格中はテロップを TTL 超過でも保護する」契約だけを切り出して固定する
  describe("昇格中のテロップ保護 (groupKey 照合)", () => {
    const EXPIRED = T0 + 400 * MIN; // どの優先度の TTL も確実に超える

    function tickerKeysAfterSweep(
      views: { vpws50: ItemSpec[]; vpww56: ItemSpec[] },
      events: PresentationEvent[],
      demote: "none" | "vpww56" | "vpws50",
    ): string[] {
      const s = setup(views);
      for (const e of events) s.ingest(e);
      if (demote !== "none") {
        // 30 分 + 5 秒を過ぎた 1 回の sweep で active → demoted にする
        s.store.sweep(T0 + DEMOTE_MS + 5_000);
      }
      s.hub.sweepTicker(EXPIRED);
      return s.hub
        .buildSnapshot()
        .recentTicker.map((d) => d.groupKey)
        .filter((k): k is string => k != null);
    }

    const vpww56Event = (office: string) =>
      weatherEvent({ type: "VPWW56", publishingOffice: office, weatherConfidence: "confirmed" });

    it("VPWW56 昇格中は官署別 groupKey のテロップが TTL 超過でも保護される", () => {
      const keys = tickerKeysAfterSweep(
        { vpws50: [], vpww56: L5_TOKYO },
        [vpww56Event("稚内地方気象台"), vpww56Event("旭川地方気象台")],
        "none",
      );
      expect(keys).toContain("weather:VPWW56:稚内地方気象台");
      expect(keys).toContain("weather:VPWW56:旭川地方気象台");
    });

    it("VPWW56 降格後は保護されない (TTL 超過で刈られる)", () => {
      const keys = tickerKeysAfterSweep(
        { vpws50: [], vpww56: L5_TOKYO },
        [vpww56Event("稚内地方気象台")],
        "vpww56",
      );
      expect(keys).not.toContain("weather:VPWW56:稚内地方気象台");
    });

    it("VPWW56 の昇格は他 type (VPWW55) のテロップまでは保護しない", () => {
      const keys = tickerKeysAfterSweep(
        { vpws50: [], vpww56: L5_TOKYO },
        [
          vpww56Event("稚内地方気象台"),
          weatherEvent({ type: "VPWW55", publishingOffice: "稚内地方気象台", weatherConfidence: "confirmed" }),
        ],
        "none",
      );
      expect(keys).toContain("weather:VPWW56:稚内地方気象台");
      expect(keys).not.toContain("weather:VPWW55:稚内地方気象台");
    });

    it("VPWS50 昇格中は完全一致キーで保護され、降格後は刈られる", () => {
      const active = tickerKeysAfterSweep(
        { vpws50: L5_TOKYO, vpww56: [] },
        [weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" })],
        "none",
      );
      expect(active).toContain("weather:vpws50");

      const demoted = tickerKeysAfterSweep(
        { vpws50: L5_TOKYO, vpww56: [] },
        [weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" })],
        "vpws50",
      );
      expect(demoted).not.toContain("weather:vpws50");
    });

    it("昇格が無ければ気象テロップは保護されない", () => {
      const keys = tickerKeysAfterSweep(
        { vpws50: L3_TOKYO, vpww56: L3_TOKYO },
        [weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }), vpww56Event("稚内地方気象台")],
        "none",
      );
      expect(keys).toEqual([]);
    });
  });

  it("hub 単体では昇格を更新しない (更新経路は受理側に一本化、二重適用の防止)", () => {
    const { store, hub } = setup({ vpws50: L5_TOKYO, vpww56: [] });
    hub.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }));
    expect(promotionOf(store, T0)?.vpws50).toBeNull();
  });

  it("5 秒 sweep が active → demoted の遷移を行い state 配信を誘発する", () => {
    vi.useFakeTimers();
    try {
      const s = setup({ vpws50: L5_TOKYO, vpww56: [] });
      const transport = new FakeTransport();
      s.hub.attachTransport(transport);
      s.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "confirmed" }));
      s.hub.startTimers();
      s.setNow(T0 + DEMOTE_MS + 5_000);
      vi.advanceTimersByTime(DEMOTE_MS + 5_000 + STATE_DEBOUNCE_MS);
      expect(promotionOf(s.store, T0 + DEMOTE_MS + 5_000)?.vpws50).toBeNull();
      s.hub.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 受理経路 (display の on/off から独立、ヘルツ 2 巡目 指摘 1) ──

describe("applyWeatherPromotionOnIngest (display off 中も昇格が動く)", () => {
  function views(vpws50: ItemSpec[], vpww56: ItemSpec[] = []) {
    return { vpws50: () => rawView(vpws50), vpww56: () => rawView(vpww56) };
  }

  it("hub が無くても (display off) confirmed 受信で昇格する", () => {
    const store = new WeatherPromotionStore();
    expect(applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0)).toBe(true);
    expect(store.get("vpws50")?.level).toBe(5);
  });

  // 旧実装はこの続報を取りこぼし、T+40 分に on した時点で即 demoted になっていた
  it("display off 中の同内容続報で 30 分が再開する", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    // display off 中の続報 (T+20 分)
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0 + 20 * MIN);
    // T+40 分に display on 相当の経過判定を通しても、まだ 20 分しか経っていないので active
    expect(store.resume(T0 + 40 * MIN)).toBe(false);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0 + 20 * MIN);
  });

  it("display off 中の解除で record が消える", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    applyWeatherPromotionOnIngest(store, views(L3_TOKYO), weatherEvent({ type: "VPWS50" }), T0 + MIN);
    expect(store.get("vpws50")).toBeNull();
  });

  it("display off 中の L4→L5 で generation が更新される", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L4_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0 + MIN);
    const rec = store.get("vpws50");
    expect(rec?.level).toBe(5);
    expect(rec?.generation).toBe(2);
  });

  it("unsafe 報は昇格契機にしない", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L4_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    expect(applyWeatherPromotionOnIngest(
      store, views(L4_TOKYO), weatherEvent({ type: "VPWS50", weatherConfidence: "unsafe" }), T0 + 20 * MIN,
    )).toBe(false);
    const rec = store.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
  });

  it("気象以外の電文では何もしない", () => {
    const store = new WeatherPromotionStore();
    expect(applyWeatherPromotionOnIngest(
      store, views(L5_TOKYO), weatherEvent({ type: "VXSE53", domain: "earthquake" }), T0,
    )).toBe(false);
    expect(store.get("vpws50")).toBeNull();
  });

  it("source は受信した電文の type で選ばれる (VPWW56 は vpww56 だけ)", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views([], L5_TOKYO), weatherEvent({ type: "VPWW56" }), T0);
    expect(store.get("vpww56")?.level).toBe(5);
    expect(store.get("vpws50")).toBeNull();
  });
});
