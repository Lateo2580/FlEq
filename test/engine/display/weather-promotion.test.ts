import { describe, expect, it, vi } from "vitest";
import {
  STATE_DEBOUNCE_MS,
  SWEEP_INTERVAL_MS,
  WEATHER_PROMOTION_DEMOTE_MIN,
} from "../../../src/engine/display/constants";
import { kindCodeToPhenomenonKey } from "../../../src/dmdata/weather-phenomenon-key";
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
  /** 現象キー (電文の kindCode)。省略時は kind から安定に導出する。
   *  **レベルが変わっても同じ現象なら同じ値**にすること — spec 追補 C2 の判定はこれで行う */
  kindCode?: string;
}

/** 既定 kindCode。**実データの気象庁コードを使う** — kindCode はレベルごとに別コードが
 *  振られる (大雨 L4=43 / L5=33) ので、表示名から合成すると実データを再現できず
 *  「L4→L5 を地域追加と誤判定する」バグを隠してしまう (Codex レビュー 2026-07-27) */
function defaultKindCode(kind: string): string {
  if (kind.includes("大雨特別警報")) return "33";
  if (kind.includes("大雨警報")) return "43";
  if (kind.includes("土砂災害")) return kind.includes("特別") ? "39" : "49";
  if (kind.includes("高潮")) return kind.includes("特別") ? "38" : "48";
  if (kind.includes("暴風雪")) return "32";
  if (kind.includes("暴風")) return "35";
  return "03";
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
      kindCode: i.kindCode ?? defaultKindCode(i.kind),
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
    expect(classifyWeatherPromotion(rawView(L5_TOKYO), "vpws50")?.level).toBe(5);
    expect(
      classifyWeatherPromotion(
        rawView([{ severity: "nonLevelSpecial", kind: "暴風特別警報", areas: ["東京都"] }]),
        "vpws50",
      )?.level,
    ).toBe(5);
    expect(classifyWeatherPromotion(rawView(L4_TOKYO), "vpws50")?.level).toBe(4);
  });

  it("L3 以下だけなら昇格対象外 (null)", () => {
    expect(classifyWeatherPromotion(rawView(L3_TOKYO), "vpws50")).toBeNull();
  });

  it("rank 1 点代表ではなく集合ベース: L4 と nonLevelSpecial の共存は L5 を採る", () => {
    const mixed = classifyWeatherPromotion(
      rawView([
        { severity: "officialL4", kind: "L4 大雨警報", areas: ["東京都"] },
        { severity: "nonLevelSpecial", kind: "暴風特別警報", areas: ["千葉県"] },
      ]),
      "vpws50",
    );
    expect(mixed?.level).toBe(5);
  });

  it("未知 severity 値は昇格判定に使わず warn ログを出す", () => {
    __test_resetUnknownSeverityWarnings();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const result = classifyWeatherPromotion(
        rawView([{ severity: "officialL9", kind: "謎警報", areas: ["東京都"] }]),
        "vpws50",
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
      const view = rawView([{ severity: "officialL9", kind: "謎警報", areas: ["東京都"] }]);
      classifyWeatherPromotion(view, "vpws50");
      classifyWeatherPromotion(view, "vpws50");
      classifyWeatherPromotion(view, "vpws50");
      expect(warn).toHaveBeenCalledTimes(1);
      // 別の未知値は改めて 1 回だけ警告する
      classifyWeatherPromotion(
        rawView([{ severity: "officialL8", kind: "別の謎警報", areas: ["東京都"] }]),
        "vpws50",
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
    expect(store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0)).toBe(true);
    const p = promotionOf(store, T0)?.vpws50;
    expect(p).not.toBeNull();
    expect(p?.level).toBe(4);
    expect(p?.promotedAt).toBe(new Date(T0).toISOString());
    expect(p?.generation).toBe(1);
  });

  // spec 追補 2 (2026-07-26): 同内容の再掲では**点灯しない**。VPWS50 は定時通報が来るので、
  // ここで時計を進めると保持時間が延び続け「警報が続く限り出っぱなし」になる (実機観測)
  it("同内容の confirmed 続報では時計を進めない (点灯し直さない)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    const later = T0 + 1 * MIN;
    expect(store.applyWeatherSource("vpws50", rawView(L4_TOKYO), later)).toBe(false);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.promotedAt).toBe(new Date(T0).toISOString()); // 初回の点灯時刻のまま
    expect(p?.generation).toBe(1);
    // 時計が進んでいないので、初回から保持時間を過ぎれば降格する
    expect(store.sweep(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(promotionOf(store, T0 + DEMOTE_MS + 5_000)?.vpws50).toBeNull();
  });

  it("上位遷移 L4→L5 は generation 更新 + 再開", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("L5 の地域追加は generation 更新 + 再開", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO_CHIBA), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  // spec は上位遷移しか明記していないが、実装は signature の増減方向を問わず generation を更新する。
  // Phase 2 が generation を再アニメーション契機に使う場合に効くので、意図した挙動として固定する
  it("L5 の地域削減でも generation は更新される (縮退方向も別内容の昇格として扱う)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO_CHIBA), T0);
    expect(promotionOf(store, T0)?.vpws50?.generation).toBe(1);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(5);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("L5→L4 は新たな L4 として再開する", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    const later = T0 + 10 * MIN;
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), later);
    const p = promotionOf(store, later)?.vpws50;
    expect(p?.level).toBe(4);
    expect(p?.generation).toBe(2);
    expect(p?.promotedAt).toBe(new Date(later).toISOString());
  });

  it("高 severity 集合が空になったら即終了 (demote ではなく record 削除)。L3 継続でも終了", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    const later = T0 + 5 * MIN;
    expect(store.applyWeatherSource("vpws50", rawView(L3_TOKYO), later)).toBe(true);
    expect(promotionOf(store, later)?.vpws50).toBeNull();
    // tier も weather 由来の押し上げを失う
    expect(store.snapshot(1, later).severityTier).toBe("calm");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(false);
  });

  it("generation watermark は record 削除後も保持される (解除→再発表で同じ generation に戻らない)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    store.applyWeatherSource("vpws50", undefined, T0 + MIN);
    expect(promotionOf(store, T0 + MIN)?.vpws50).toBeNull();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0 + 2 * MIN);
    expect(promotionOf(store, T0 + 2 * MIN)?.vpws50?.generation).toBe(2);
  });

  it("保持時間 + 最大 5 秒で降格する (保持時間ちょうどでは降格しない)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    expect(store.sweep(T0 + DEMOTE_MS)).toBe(false);
    expect(promotionOf(store, T0 + DEMOTE_MS)?.vpws50).not.toBeNull();
    expect(store.sweep(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(promotionOf(store, T0 + DEMOTE_MS + 5_000)?.vpws50).toBeNull();
  });

  it("稼働中に壁時計が巻き戻ったら、その時刻から保持時間を測り直す", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L5_TOKYO), T0);
    const onDurable = vi.fn();
    store.onDurable(onDurable);
    const rewoundAt = T0 - MIN;

    expect(store.sweepDemote(rewoundAt)).toBe(true);
    const record = store.get("vpws50");
    expect(record?.state === "active" ? record.promotedAtMs : null).toBe(rewoundAt);
    expect(onDurable).toHaveBeenCalledTimes(1);
    expect(store.sweepDemote(rewoundAt + DEMOTE_MS)).toBe(false);
    expect(store.sweepDemote(rewoundAt + DEMOTE_MS + 1)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("降格後も tier は維持し、activeAlertKeys には含めない", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    expect(store.snapshot(1, T0).severityTier).toBe("critical");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(true);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(2, T0 + DEMOTE_MS + 5_000).severityTier).toBe("critical");
    expect(store.activeAlertKeys().has("weather:vpws50")).toBe(false);
  });

  it("L4 の降格後の tier は alert (level を保持している)", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(1, T0 + DEMOTE_MS + 5_000).severityTier).toBe("alert");
  });

  it("demoted は snapshot の weatherPromotion で null に投影される", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    const snap = store.snapshot(1, T0 + DEMOTE_MS + 5_000);
    expect(snap.weatherPromotion?.vpws50).toBeNull();
    expect(snap.weatherPromotion?.vpww56).toBeNull();
  });

  it("weatherL5Active は demoted 後も警報解除まで true", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    expect(store.snapshot(1, T0).weatherL5Active).toBe(true);
    store.sweep(T0 + DEMOTE_MS + 5_000);
    expect(store.snapshot(2, T0 + DEMOTE_MS + 5_000).weatherL5Active).toBe(true);
    store.applyWeatherSource("vpws50", undefined, T0 + DEMOTE_MS + 10_000);
    expect(store.snapshot(3, T0 + DEMOTE_MS + 10_000).weatherL5Active).toBe(false);
  });

  it("weatherL5Active は L4 のみでは false", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    expect(store.snapshot(1, T0).weatherL5Active).toBe(false);
  });

  it("source は完全独立: 片方の続報で他方の時計は動かない", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    const later = T0 + 25 * MIN;
    store.applyWeatherSource("vpww56", rawView(L4_TOKYO), later);
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
    store.applyWeatherSource("vpws50", rawView(L4_TOKYO), T0);
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0 + MIN);
    store.applyWeatherSource("vpww56", rawView(L4_TOKYO), T0 + 2 * MIN);
    const p = promotionOf(store, T0 + 2 * MIN);
    expect(p?.vpws50?.generation).toBe(2);
    expect(p?.vpww56?.generation).toBe(1);
  });

  it("永続化入口: export した lifecycle を restore で復元できる", () => {
    const store = new DisplayStateStore();
    store.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0);
    const exported = JSON.parse(JSON.stringify(store.exportWeatherPromotions()));

    const restored = new DisplayStateStore();
    restored.restoreWeatherPromotions(exported, T0 + MIN);
    expect(promotionOf(restored, T0 + MIN)?.vpws50?.generation).toBe(1);
    // 残り時間だけ復元する (promotedAt は延命されない)
    expect(promotionOf(restored, T0 + MIN)?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(restored.snapshot(1, T0 + MIN).severityTier).toBe("critical");
    // 復元後も同内容の続報は generation を据置きで再開する
    restored.applyWeatherSource("vpws50", rawView(L5_TOKYO), T0 + 2 * MIN);
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
    weatherStateMutationAccepted: true,
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
    let monotonicMs = 0;
    const hub = new InfoDisplayHub(store, {
      summarize: () => "s",
      weatherAlerts: () => [
        ...alertsOf("vpws50", views.vpws50),
        ...alertsOf("vpww56", views.vpww56),
      ],
      now: () => nowMs,
      monotonicNow: () => monotonicMs,
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
    return {
      store,
      hub,
      promotions,
      ingest,
      setNow: (v: number) => { nowMs = v; },
      setMonotonic: (v: number) => { monotonicMs = v; },
      views,
    };
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
        // 保持時間 + 5 秒を過ぎた 1 回の sweep で active → demoted にする
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

  describe("SSE 無客中の保持時計停止", () => {
    it("(a) 3 分超の無客期間後も、切断前の残り時間から active を再開する", () => {
      const s = setup({ vpws50: L5_TOKYO, vpww56: [] });
      s.hub.startSseClientTracking(1);
      s.promotions.apply("vpws50", rawView(L5_TOKYO), T0);
      const onDurable = vi.fn();
      s.promotions.onDurable(onDurable);

      s.setNow(T0 + MIN); // 1 分は見られていた
      s.setMonotonic(MIN);
      s.hub.onSseClientCountChange(0);
      const reconnectedAt = T0 + 11 * MIN; // 10 分の無客期間
      s.setNow(reconnectedAt);
      s.setMonotonic(11 * MIN);
      s.hub.onSseClientCountChange(1);

      const record = s.promotions.get("vpws50");
      expect(record?.state).toBe("active");
      expect(record?.state === "active" ? record.promotedAtMs : null).toBe(T0 + 10 * MIN);
      expect(onDurable).toHaveBeenCalledTimes(2);

      s.setNow(reconnectedAt + 2 * MIN + 1);
      s.setMonotonic(13 * MIN + 1);
      s.hub.onSseClientCountChange(0);
      expect(s.promotions.get("vpws50")?.state).toBe("demoted");
    });

    it("(b) 短い切断を繰り返しても、可視時間の合計 3 分で降格する", () => {
      const s = setup({ vpws50: L5_TOKYO, vpww56: [] });
      s.hub.startSseClientTracking(1);
      s.promotions.apply("vpws50", rawView(L5_TOKYO), T0);
      let wallMs = T0;
      let monotonicMs = 0;
      const setClocks = (): void => {
        s.setNow(wallMs);
        s.setMonotonic(monotonicMs);
      };

      // 定期 sweep の合間だけ接続しても、1→0 の締め判定で逃れられない。
      for (let cycle = 0; cycle < 6; cycle += 1) {
        const visibleMs = cycle === 5 ? 30_001 : 30_000;
        wallMs += visibleMs;
        monotonicMs += visibleMs;
        setClocks();
        s.hub.onSseClientCountChange(0);

        if (cycle < 5) {
          expect(s.promotions.get("vpws50")?.state).toBe("active");
          wallMs += 10_000;
          monotonicMs += 10_000;
          setClocks();
          s.hub.onSseClientCountChange(1);
        }
      }

      expect(s.promotions.get("vpws50")?.state).toBe("demoted");
    });

    it("(c) 起動直後から無客なら、その間に点灯しても sweep で降格しない", () => {
      vi.useFakeTimers();
      try {
        const s = setup({ vpws50: L5_TOKYO, vpww56: [] });
        s.hub.startSseClientTracking(0);
        s.setNow(T0 + 5 * MIN);
        s.setMonotonic(5 * MIN);
        s.promotions.apply("vpws50", rawView(L5_TOKYO), T0 + 5 * MIN);
        s.hub.startTimers();

        s.setNow(T0 + 20 * MIN);
        s.setMonotonic(20 * MIN);
        vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

        expect(s.promotions.get("vpws50")?.state).toBe("active");
        s.hub.onSseClientCountChange(1);
        const record = s.promotions.get("vpws50");
        expect(record?.state === "active" ? record.promotedAtMs : null).toBe(T0 + 20 * MIN);
        s.hub.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("無客中の壁時計巻き戻りでも、切断前に消費した可視時間を維持する", () => {
      const s = setup({ vpws50: L5_TOKYO, vpww56: [] });
      s.hub.startSseClientTracking(1);
      s.promotions.apply("vpws50", rawView(L5_TOKYO), T0);

      s.setNow(T0 + 2 * MIN);
      s.setMonotonic(2 * MIN);
      s.hub.onSseClientCountChange(0);

      s.setNow(T0 + 30_000);
      s.setMonotonic(3 * MIN);
      s.hub.onSseClientCountChange(1);

      const record = s.promotions.get("vpws50");
      expect(record?.state).toBe("active");
      expect(record?.state === "active" ? record.promotedAtMs : null).toBe(T0 - 90_000);

      s.setNow(T0 + 90_001);
      s.setMonotonic(4 * MIN + 1);
      s.hub.onSseClientCountChange(0);
      expect(s.promotions.get("vpws50")?.state).toBe("demoted");
    });
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

  // spec 追補 2: 同内容の再掲では時計を進めない。旧実装は続報のたびに延長していた
  it("display off 中の同内容続報では時計が進まない", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    // display off 中の同内容続報 (T+1 分) — 点灯契機ではない
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0 + MIN);
    const rec = store.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
  });

  // spec 追補 C6 (ご主人決定 2026-07-27): display off・SSE 断の間に来た点灯は誰にも
  // 見られていないので、display on の時点で保持時間を測り直して見られる機会を作る
  it("display on (resume) で active な昇格の時計を測り直す", () => {
    const store = new WeatherPromotionStore();
    applyWeatherPromotionOnIngest(store, views(L5_TOKYO), weatherEvent({ type: "VPWS50" }), T0);
    const onAt = T0 + 2 * MIN; // 保持時間 (3 分) 内に display on
    expect(store.resume(onAt)).toBe(true);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(onAt);
    // 測り直したので、元の点灯からは 3 分を過ぎていてもまだ降格しない
    expect(store.sweepDemote(T0 + DEMOTE_MS + 5_000)).toBe(false);
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

  it("VPWW56 fail-open event は promotion を更新しない", () => {
    const store = new WeatherPromotionStore();
    expect(applyWeatherPromotionOnIngest(
      store,
      views([], L5_TOKYO),
      weatherEvent({ type: "VPWW56", weatherStateMutationAccepted: false }),
      T0,
    )).toBe(false);
    expect(store.get("vpww56")).toBeNull();
  });
});

// ── spec 追補 (2026-07-26/27): 点灯規則・新規/更新・追加地域 ──

describe("点灯規則 (spec 追補)", () => {
  const L4_TOKYO_CHIBA: ItemSpec[] = [
    { severity: "officialL4", kind: "L4 大雨警報", areas: ["東京都", "千葉県"] },
  ];

  it("新規発表は trigger=new で、追加地域は載せない (全部が新規なので)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    const rec = store.get("vpws50");
    expect(rec?.trigger).toBe("new");
    expect(rec?.addedAreas).toEqual([]);
  });

  it("地域追加は trigger=update で、増えた地域だけが addedAreas に載る", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpws50", rawView(L4_TOKYO_CHIBA), T0 + MIN);
    const rec = store.get("vpws50");
    expect(rec?.trigger).toBe("update");
    expect(rec?.addedAreas.map((m) => m.areaName)).toEqual(["千葉県"]);
  });

  // spec 追補 C2: kind は表示ラベル (L4 大雨警報 / L5 大雨特別警報) なので、それで判定すると
  // レベルが上がっただけの同じ地域が「追加された」に化ける
  it("L4→L5 の悪化では、同じ地域を追加扱いしない", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpws50", rawView(L5_TOKYO), T0 + MIN);
    const rec = store.get("vpws50");
    expect(rec?.trigger).toBe("update");
    expect(rec?.addedAreas).toEqual([]); // 東京都は「追加」ではない
  });

  it("L4→L5 と同時に地域が増えたら、増えた地域だけが追加になる", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpws50", rawView(L5_TOKYO_CHIBA), T0 + MIN);
    expect(store.get("vpws50")?.addedAreas.map((m) => m.areaName)).toEqual(["千葉県"]);
  });

  it("地域が減っただけなら追加は空 (削除はハイライトしない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L5_TOKYO_CHIBA), T0);
    store.apply("vpws50", rawView(L5_TOKYO), T0 + MIN);
    const rec = store.get("vpws50");
    expect(rec?.trigger).toBe("update");
    expect(rec?.addedAreas).toEqual([]);
  });

  it("解除 → 再発表は新規発表として扱う (record が消えているので)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpws50", rawView(L3_TOKYO), T0 + MIN); // 解除
    store.apply("vpws50", rawView(L4_TOKYO), T0 + 2 * MIN);
    expect(store.get("vpws50")?.trigger).toBe("new");
  });

  it("同内容の再掲では点灯しない (apply が false・時計も装飾も据置)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpws50", rawView(L4_TOKYO_CHIBA), T0 + MIN); // update
    const before = store.get("vpws50");
    expect(store.apply("vpws50", rawView(L4_TOKYO_CHIBA), T0 + 2 * MIN)).toBe(false);
    const after = store.get("vpws50");
    expect(after?.state === "active" ? after.promotedAtMs : null).toBe(T0 + MIN);
    expect(after?.trigger).toBe("update");
    expect(after?.addedAreas).toEqual(before?.addedAreas);
  });

  it("保持時間 (3 分) + 最大 5 秒で降格する", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    expect(store.sweepDemote(T0 + DEMOTE_MS)).toBe(false); // ちょうどでは降格しない
    expect(store.sweepDemote(T0 + DEMOTE_MS + 1)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("demoted 中の内容変化で再点灯し、同内容の再掲では demoted のまま", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.sweepDemote(T0 + DEMOTE_MS + 1);
    // 同内容の再掲: demoted のまま
    expect(store.apply("vpws50", rawView(L4_TOKYO), T0 + 5 * MIN)).toBe(false);
    expect(store.get("vpws50")?.state).toBe("demoted");
    // 内容変化: active へ戻って再点灯
    expect(store.apply("vpws50", rawView(L4_TOKYO_CHIBA), T0 + 6 * MIN)).toBe(true);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.trigger).toBe("update");
    expect(rec?.addedAreas.map((m) => m.areaName)).toEqual(["千葉県"]);
  });

  // spec 追補 C13: holder が同じ (現象 × 地域) を二度出しても signature を変えない
  it("重複した member があっても signature は変わらない (点灯が暴れない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    const duplicated = mergeRawViews(rawView(L4_TOKYO), rawView(L4_TOKYO));
    expect(store.apply("vpws50", duplicated, T0 + MIN)).toBe(false);
  });

  // Codex レビュー 3 巡目 2026-07-27: 同内容の再掲でも表示名の訂正は起こりうる。
  // wire は areaName で照合するので、古い名前のままだとハイライトが画面から消える
  it("同内容の再掲で地域名が訂正されたら、追加地域の表示名も追従する", () => {
    const named = (areas: Array<[string, string]>): Vpws50CurrentAreasForDisplay => ({
      totalAreas: areas.length, specialAreas: 0, warningAreas: 0, advisoryAreas: 0,
      kinds: [{
        kindCode: "33", kindShortName: "L5 大雨特別警報", kindName: "L5 大雨特別警報",
        displaySeverity: "officialL5" as Vpws50CurrentAreasForDisplay["kinds"][number]["displaySeverity"],
        officialAlertLevel: null,
        areas: areas.map(([areaCode, areaName]) => ({ areaCode, areaName })),
      }],
    });
    const store = new WeatherPromotionStore();
    store.apply("vpws50", named([["13", "東京都"]]), T0);
    expect(store.apply("vpws50", named([["13", "東京都"], ["12", "千葉"]]), T0 + MIN)).toBe(true);
    expect(store.get("vpws50")?.addedAreas.map((m) => m.areaName)).toEqual(["千葉"]);

    // areaCode は同じで表示名だけ訂正 → signature は不変なので点灯しない
    expect(store.apply("vpws50", named([["13", "東京都"], ["12", "千葉県"]]), T0 + 2 * MIN)).toBe(false);
    expect(store.get("vpws50")?.addedAreas.map((m) => m.areaName)).toEqual(["千葉県"]);
  });
});

/** 同じ view を複数まとめる (holder の重複投影を模す) */
function mergeRawViews(
  ...views: Array<Vpws50CurrentAreasForDisplay | undefined>
): Vpws50CurrentAreasForDisplay {
  const kinds = views.flatMap((v) => v?.kinds ?? []);
  return { totalAreas: 0, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds };
}

// Codex レビュー 2026-07-27: kindCode はレベルごとに別コードなので、生 kindCode で
// 地域追加を判定すると同じ地域が「追加された」に化ける。実コード対で固定する
describe("実データのコード対で追加地域を誤判定しない", () => {
  const cases: Array<[string, string, string, string]> = [
    ["大雨", "43", "33", "L4 大雨警報"],
    ["土砂災害", "49", "39", "L4 土砂災害警戒情報"],
    ["高潮", "48", "38", "L4 高潮警報"],
  ];
  for (const [name, l4Code, l5Code, kindL4] of cases) {
    it(`${name}: ${l4Code} → ${l5Code} の悪化を地域追加と数えない`, () => {
      const store = new WeatherPromotionStore();
      store.apply("vpws50", rawView([
        { severity: "officialL4", kind: kindL4, areas: ["東京都"], kindCode: l4Code },
      ]), T0);
      store.apply("vpws50", rawView([
        { severity: "officialL5", kind: `L5 ${name}特別警報`, areas: ["東京都"], kindCode: l5Code },
      ]), T0 + MIN);
      const rec = store.get("vpws50");
      expect(rec?.trigger).toBe("update");   // 内容は変わっている (再点灯する)
      expect(rec?.addedAreas).toEqual([]);   // が、東京都は「追加」ではない
    });
  }

  // Codex レビュー 3 巡目 2026-07-27: signature も安定キーで組む (spec 追補 C2)。
  // 生 kindCode で組むと、同じ現象・同じ severity にコードの別名があるだけで再点灯する
  it("同じ現象・同じ severity なら kindCode が違っても再点灯しない", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView([
      { severity: "officialL5", kind: "L5 大雨特別警報", areas: ["東京都"], kindCode: "33" },
    ]), T0);
    // 同じ現象キーへ正規化される別コード (kindCodeToPhenomenonKey の対応表が育った場合を想定)
    const alias = kindCodeToPhenomenonKey("33");
    expect(kindCodeToPhenomenonKey("43")).toBe(alias); // 前提: 大雨は L4/L5 とも同じ現象キー
    expect(store.apply("vpws50", rawView([
      { severity: "officialL5", kind: "L5 大雨特別警報", areas: ["東京都"], kindCode: "43" },
    ]), T0 + MIN)).toBe(false);
  });
});

// Codex レビュー 2026-07-27: 保持の時計と点灯イベントを分ける
describe("点灯イベントの通し番号 (activationSeq)", () => {
  it("new / update でだけ増え、同内容の再掲では増えない", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    const first = store.get("vpws50")?.activationSeq ?? 0;
    store.apply("vpws50", rawView(L4_TOKYO), T0 + MIN); // 同内容
    expect(store.get("vpws50")?.activationSeq).toBe(first);
    store.apply("vpws50", rawView(L5_TOKYO), T0 + 2 * MIN); // 内容変化
    expect(store.get("vpws50")?.activationSeq).toBe(first + 1);
  });

  it("display on の測り直し (resume) では増えない (時計と点灯を分離)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    const before = store.get("vpws50");
    store.resume(T0 + MIN);
    const after = store.get("vpws50");
    expect(after?.activationSeq).toBe(before?.activationSeq);
    // 時計だけが動く
    expect(after?.state === "active" ? after.promotedAtMs : null).toBe(T0 + MIN);
  });

  it("source をまたいで単調増加する (発生順の真実源)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView(L4_TOKYO), T0);
    store.apply("vpww56", rawView(L5_TOKYO), T0 + MIN);
    const a = store.get("vpws50")?.activationSeq ?? 0;
    const b = store.get("vpww56")?.activationSeq ?? 0;
    expect(b).toBeGreaterThan(a); // 後に点いた vpww56 が新しい
  });
});
