import { describe, expect, it, vi } from "vitest";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { QuakeExtremeStore } from "../../../src/engine/display/quake-extreme-store";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import type {
  DisplayIngestResult,
  DisplayIngestSink,
} from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { Vpws50CurrentAreasForDisplay } from "../../../src/types";

const MIN = 60_000;
const T0 = Date.parse("2026-07-25T21:00:00+09:00");

function view(severity: string, areas: string[]): Vpws50CurrentAreasForDisplay {
  return {
    totalAreas: areas.length,
    specialAreas: 0,
    warningAreas: 0,
    advisoryAreas: 0,
    kinds: [
      {
        kindCode: "03",
        kindShortName: "大雨",
        kindName: "大雨警報",
        displaySeverity: severity as Vpws50CurrentAreasForDisplay["kinds"][number]["displaySeverity"],
        officialAlertLevel: null,
        areas: areas.map((a) => ({ areaName: a, areaCode: a })),
      },
    ],
  };
}

function weatherEvent(over: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: `m-${Math.random()}`, classification: "telegram.weather", domain: "weather",
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

function cardEvent(
  domain: "briefing" | "legacyCounterpart",
  type: "VPBS50" | "VPOA50",
  eventId: string,
): PresentationEvent {
  return {
    ...weatherEvent({ domain, type }),
    raw: { eventId } as unknown as PresentationEvent["raw"],
  };
}

interface Harness {
  sink: DisplayIngestSink;
  promotions: WeatherPromotionStore;
  standbyCalls: number;
  hubCalls: number;
  setHub(hub: DisplayIngestSink | null): void;
  setNow(ms: number): void;
  setVpws50(v: Vpws50CurrentAreasForDisplay | undefined): void;
  setVpww56(v: Vpws50CurrentAreasForDisplay | undefined): void;
}

function harness(): Harness {
  const promotions = new WeatherPromotionStore();
  let hub: DisplayIngestSink | null = null;
  let nowMs = T0;
  let vpws50: Vpws50CurrentAreasForDisplay | undefined;
  let vpww56: Vpws50CurrentAreasForDisplay | undefined;
  const h: Partial<Harness> = { promotions, standbyCalls: 0, hubCalls: 0 };
  const sink = createDisplaySink({
    standby: { applyEvent: () => { (h.standbyCalls as number) += 1; } },
    promotions,
    weatherViews: { vpws50: () => vpws50, vpww56: () => vpww56 },
    getHub: () => hub,
    now: () => nowMs,
  });
  h.sink = sink;
  h.setHub = (v) => { hub = v; };
  h.setNow = (ms) => { nowMs = ms; };
  h.setVpws50 = (v) => { vpws50 = v; };
  h.setVpww56 = (v) => { vpww56 = v; };
  return h as Harness;
}

// monitor が router へ渡す実 sink の配線を突く。helper を直接呼ぶテストとは別に、
// 「sink が確かに昇格更新を通す」という肯定側を固定する
describe("createDisplaySink (monitor の実配線)", () => {
  it("VPWW55 特別警報を受けると weatherAlerts を直ちに常設表示 state へ渡す", () => {
    const applyWeatherAlerts = vi.fn();
    const promotions = new WeatherPromotionStore();
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, applyWeatherAlerts },
      promotions,
      weatherViews: { vpws50: () => view("officialL5", ["福井市"]), vpww56: () => undefined },
      getHub: () => null,
      now: () => T0,
    });

    sink.ingest(weatherEvent({ type: "VPWW55", title: "福井県気象警報・注意報" }));

    expect(applyWeatherAlerts).toHaveBeenCalledWith(
      "vpws50",
      [expect.objectContaining({ role: "weatherEmergency", items: [expect.objectContaining({ shownAreas: ["福井市"] })] })],
      "2026-07-25T21:00:00+09:00",
      null,
      T0,
    );
    expect(promotions.get("vpws50")?.level).toBe(5);
  });

  it("VPWW57 特別警報も VPWW55 と同じ weatherAlerts/promotion state へ反映する", () => {
    const applyWeatherAlerts = vi.fn();
    const promotions = new WeatherPromotionStore();
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, applyWeatherAlerts },
      promotions,
      weatherViews: { vpws50: () => view("officialL5", ["高松市"]), vpww56: () => undefined },
      getHub: () => null,
      now: () => T0,
    });

    sink.ingest(weatherEvent({ type: "VPWW57", title: "香川県高潮警報・注意報" }));

    expect(applyWeatherAlerts).toHaveBeenCalledWith(
      "vpws50",
      [expect.objectContaining({ role: "weatherEmergency", items: [expect.objectContaining({ shownAreas: ["高松市"] })] })],
      "2026-07-25T21:00:00+09:00",
      null,
      T0,
    );
    expect(promotions.get("vpws50")?.level).toBe(5);
  });

  it("hub が無くても (display off) 昇格が更新される", () => {
    const h = harness();
    h.setVpws50(view("officialL5", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    expect(h.promotions.get("vpws50")?.level).toBe(5);
  });

  it("hub があるときも昇格が更新され、hub へも渡る", () => {
    const h = harness();
    let hubCalls = 0;
    h.setHub({ ingest: () => { hubCalls += 1; } });
    h.setVpws50(view("officialL4", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    expect(h.promotions.get("vpws50")?.level).toBe(4);
    expect(hubCalls).toBe(1);
  });

  it("hub の ingest result を router 側へ返す", () => {
    const result: DisplayIngestResult = {
      kind: "applied",
      eventKeys: ["legacy:source:1"],
      delivery: "noClients",
    };
    const h = harness();
    h.setHub({ ingest: () => result });

    expect(h.sink.ingest(weatherEvent({ type: "VPWS50" }))).toBe(result);
  });

  it("coordinator が先に standby projection を commit した電文は snapshot dirty を通知する", () => {
    const applyEvent = vi.fn();
    const markDirty = vi.fn();
    const sink = createDisplaySink({
      standby: { applyEvent },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, markExternalStateDirty: markDirty }),
      now: () => T0,
    });

    sink.ingest(weatherEvent({
      domain: "volcano",
      type: "VFVO54",
      standbyStateProjectionCommitted: true,
    }));

    expect(applyEvent).not.toHaveBeenCalled();
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("late reconcile の ticker result は card result と分離して hub へ転送する", () => {
    const result: DisplayIngestResult = { kind: "applied", delivery: "delivered" };
    const reconcile = vi.fn(() => result);
    const h = harness();
    h.setHub({ ingest: () => undefined, reconcileLateCounterpart: reconcile });
    const event = weatherEvent({ type: "VPWS50" });

    expect(h.sink.reconcileLateCounterpart?.(event, ["source:key"])).toEqual({ tickerResult: result });
    expect(reconcile).toHaveBeenCalledWith(event, ["source:key"]);

    h.setHub(null);
    expect(h.sink.reconcileLateCounterpart?.(event, ["source:key"])).toEqual({});
  });

  it("combined reconcile は card/ticker を別結果にし、standby dirty を追加配信しない", () => {
    const tickerResult: DisplayIngestResult = { kind: "applied", delivery: "delivered" };
    const cardResult = {
      kind: "applied" as const, status: "applied" as const, applied: true as const,
      sourceKey: "card:vpoa:source", canonicalKey: "card:vpbs:canonical",
      generation: 2, expiresAt: "2026-07-25T23:00:00.000Z", canonicalInserted: true as const, evictedKey: null,
    };
    const reconcileTicker = vi.fn(() => tickerResult);
    const markDirty = vi.fn();
    let suppressions = 0;
    const sink = createDisplaySink({
      standby: {
        applyEvent: () => undefined,
        reconcileBriefingCard: vi.fn(() => cardResult),
        snapshotBriefingCard: () => null,
      },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, reconcileLateCounterpart: reconcileTicker, markExternalStateDirty: markDirty }),
      withStandbyDirtySuppressed: (callback) => { suppressions += 1; return callback(); },
      now: () => T0,
    });
    const source = cardEvent("legacyCounterpart", "VPOA50", "source");
    const canonical = cardEvent("briefing", "VPBS50", "canonical");

    expect(sink.reconcileLateCounterpart?.(canonical, ["ticker:source"], { sourceEvent: source })).toEqual({
      tickerResult, cardResult,
    });
    expect(suppressions).toBe(1);
    expect(markDirty).not.toHaveBeenCalled();
    expect(reconcileTicker).toHaveBeenCalledWith(canonical, ["ticker:source"], expect.objectContaining({ card: null }));
  });

  it("combined reconcile で card snapshot の取得に失敗した場合は snapshot 再同期を予約する", () => {
    const markDirty = vi.fn();
    const reconcileTicker = vi.fn(() => ({ kind: "applied" as const }));
    const cardResult = {
      kind: "applied" as const, status: "applied" as const, applied: true as const,
      sourceKey: "card:vpoa:source", canonicalKey: "card:vpbs:canonical",
      generation: 2, expiresAt: "2026-07-25T23:00:00.000Z", canonicalInserted: true as const, evictedKey: null,
    };
    const sink = createDisplaySink({
      standby: {
        applyEvent: () => undefined,
        reconcileBriefingCard: () => cardResult,
        snapshotBriefingCard: () => { throw new Error("snapshot failed"); },
      },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, reconcileLateCounterpart: reconcileTicker, markExternalStateDirty: markDirty }),
      now: () => T0,
    });
    const source = cardEvent("legacyCounterpart", "VPOA50", "source");
    const canonical = cardEvent("briefing", "VPBS50", "canonical");

    expect(sink.reconcileLateCounterpart?.(canonical, ["ticker:source"], { sourceEvent: source })).toMatchObject({
      tickerResult: { kind: "applied" }, cardResult: { kind: "applied" },
    });
    expect(reconcileTicker).toHaveBeenCalledWith(canonical, ["ticker:source"], { sourceEvent: source });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("card reconcile の失敗は ticker reconcile を止めない", () => {
    const reconcileTicker = vi.fn(() => ({ kind: "applied" as const }));
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, reconcileBriefingCard: () => { throw new Error("card failure"); } },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, reconcileLateCounterpart: reconcileTicker }),
      now: () => T0,
    });
    const source = cardEvent("legacyCounterpart", "VPOA50", "source");
    const canonical = cardEvent("briefing", "VPBS50", "canonical");

    expect(sink.reconcileLateCounterpart?.(canonical, ["ticker:source"], { sourceEvent: source })).toMatchObject({
      tickerResult: { kind: "applied" }, cardResult: { kind: "failure", reason: "cardReconcileFailed" },
    });
    expect(reconcileTicker).toHaveBeenCalledTimes(1);
  });

  it("combined ticker failure 後は card を snapshot dirty で収束させる", () => {
    const markDirty = vi.fn();
    const cardResult = {
      kind: "applied" as const, status: "applied" as const, applied: true as const,
      sourceKey: "card:vpoa:source", canonicalKey: "card:vpbs:canonical",
      generation: 2, expiresAt: "2026-07-25T23:00:00.000Z", canonicalInserted: true as const, evictedKey: null,
    };
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, reconcileBriefingCard: () => cardResult, snapshotBriefingCard: () => null },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({
        ingest: () => undefined,
        reconcileLateCounterpart: () => ({ kind: "failure" as const, reason: "hubStopped" }),
        markExternalStateDirty: markDirty,
      }),
      now: () => T0,
    });
    const source = cardEvent("legacyCounterpart", "VPOA50", "source");
    const canonical = cardEvent("briefing", "VPBS50", "canonical");

    expect(sink.reconcileLateCounterpart?.(canonical, ["ticker:source"], { sourceEvent: source })).toMatchObject({
      tickerResult: { kind: "failure" }, cardResult: { kind: "applied" },
    });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("card-only reconcile は ticker を触らず authoritative state を一回 dirty にする", () => {
    const markDirty = vi.fn();
    const cardResult = {
      kind: "applied" as const, status: "applied" as const, applied: true as const,
      sourceKey: "card:vpoa:source", canonicalKey: "card:vpbs:canonical",
      generation: 2, expiresAt: "2026-07-25T23:00:00.000Z", canonicalInserted: true as const, evictedKey: null,
    };
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, reconcileBriefingCard: () => cardResult, snapshotBriefingCard: () => null },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: vi.fn(), markExternalStateDirty: markDirty }),
      now: () => T0,
    });
    const source = cardEvent("legacyCounterpart", "VPOA50", "source");
    const canonical = cardEvent("briefing", "VPBS50", "canonical");

    expect(sink.reconcileLateCounterpartCard?.(canonical, { sourceEvent: source })).toEqual({ cardResult });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("通常 briefing ingest は card generation を ticker result と別に返す", () => {
    let generation = 1;
    const tickerResult: DisplayIngestResult = { kind: "applied", eventKey: "briefing:canonical" };
    const sink = createDisplaySink({
      standby: { applyEvent: () => { generation += 1; }, briefingCardGeneration: () => generation },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => tickerResult }),
      now: () => T0,
    });
    generation = 0;
    expect(sink.ingest(weatherEvent({ domain: "briefing", type: "VPBS50", eventId: "canonical" }))).toEqual({
      tickerResult,
      cardResult: { kind: "applied", status: "applied", applied: true, generation: 1 },
    });
  });

  it("hub が無くても気象警報カード現況を monitor 所有 store へ渡す", () => {
    const applyWeatherAlerts = vi.fn();
    const current = view("officialL3", ["東京都"]);
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, applyWeatherAlerts },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => current, vpww56: () => undefined },
      getHub: () => null,
      now: () => T0,
    });

    sink.ingest(weatherEvent({ type: "VPWS50" }));

    expect(applyWeatherAlerts).toHaveBeenCalledWith(
      "vpws50",
      [expect.objectContaining({ source: "vpws50", label: "気象警報" })],
      "2026-07-25T21:00:00+09:00",
      null,
      T0,
    );
  });

  it("VPWS50 取消 rollback は active identity をカード updatedAt と revision の両方へ使う", () => {
    const applyWeatherAlerts = vi.fn();
    const activeReportDateTime = "2026-07-25T20:00:00+09:00";
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined, applyWeatherAlerts },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => view("officialL3", ["東京都"]), vpww56: () => undefined },
      vpws50Identity: () => ({ reportDateTime: activeReportDateTime, serial: "1" }),
      getHub: () => null,
      now: () => T0,
    });

    sink.ingest(weatherEvent({
      type: "VPWS50",
      infoType: "取消",
      isCancellation: true,
      reportDateTime: "2026-07-25T21:00:00+09:00",
      serial: "2",
    }));

    expect(applyWeatherAlerts).toHaveBeenCalledWith(
      "vpws50",
      [expect.objectContaining({ updatedAt: activeReportDateTime })],
      activeReportDateTime,
      "1",
      T0,
    );
  });

  it("monitor 側で quakeExtreme が変わると hub の snapshot 再配信を要求する", () => {
    const promotions = new WeatherPromotionStore();
    const quakeExtreme = new QuakeExtremeStore();
    let dirtyCalls = 0;
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined },
      promotions,
      quakeExtreme,
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, markExternalStateDirty: () => { dirtyCalls += 1; } }),
      now: () => T0,
    });
    sink.ingest({
      ...weatherEvent({ domain: "earthquake", type: "VXSE53" }),
      eventId: "Q1",
      originTime: new Date(T0).toISOString(),
      maxIntRank: 9,
    });
    expect(dirtyCalls).toBe(1);
  });

  it("display off 中も地震履歴を monitor 所有の日次状態へ記録する", () => {
    const dailyQuakes = new DailyQuakeCounter(T0);
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined },
      promotions: new WeatherPromotionStore(),
      dailyQuakes,
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => null,
      now: () => T0,
    });
    sink.ingest({
      ...weatherEvent({ domain: "earthquake", type: "VXSE53" }),
      eventId: "Q1", maxInt: "4", maxIntRank: 4,
      originTime: new Date(T0).toISOString(), hypocenterName: "東京湾",
    });
    expect(dailyQuakes.getRecentQuakes(T0)).toMatchObject([{ eventId: "Q1", maxInt: "4" }]);
  });

  it("monitor 所有の地震履歴が変わると hub の state 再配信を要求する", () => {
    let dirtyCalls = 0;
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined },
      promotions: new WeatherPromotionStore(),
      dailyQuakes: new DailyQuakeCounter(T0),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: () => undefined, markExternalStateDirty: () => { dirtyCalls += 1; } }),
      now: () => T0,
    });
    sink.ingest({
      ...weatherEvent({ domain: "earthquake", type: "VXSE53" }),
      eventId: "Q1", maxInt: "4", maxIntRank: 4,
      originTime: new Date(T0).toISOString(), hypocenterName: "東京湾",
    });
    expect(dirtyCalls).toBe(1);
  });

  // spec 追補 2 (2026-07-26): 点灯契機は「新規発表」と「内容変化」だけ。
  // 同内容の定時再掲で時計が進むと、警報が続く限り主役パネルが出っぱなしになる
  it("display off 中でも内容変化なら時計が進む (sink 経由の実配線)", () => {
    const h = harness();
    h.setVpws50(view("officialL5", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    h.setNow(T0 + 2 * MIN);
    h.setVpws50(view("officialL5", ["東京都", "千葉県"])); // 地域追加 = 内容変化
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    const rec = h.promotions.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0 + 2 * MIN);
  });

  it("display off 中の同内容再掲では時計が進まない (sink 経由の実配線)", () => {
    const h = harness();
    h.setVpws50(view("officialL5", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    h.setNow(T0 + 2 * MIN);
    h.sink.ingest(weatherEvent({ type: "VPWS50" })); // 同内容
    const rec = h.promotions.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
  });

  it("VPWW56 は vpww56 側だけを更新する", () => {
    const h = harness();
    h.setVpww56(view("officialL5", ["島根県"]));
    h.sink.ingest(weatherEvent({ type: "VPWW56" }));
    expect(h.promotions.get("vpww56")?.level).toBe(5);
    expect(h.promotions.get("vpws50")).toBeNull();
  });

  it("VPWW56 fail-open event は durable weather state と promotion を更新せず hub へは渡す", () => {
    const applyWeatherAlerts = vi.fn();
    const hubIngest = vi.fn();
    const promotions = new WeatherPromotionStore();
    const sink = createDisplaySink({
      standby: { applyEvent: vi.fn(), applyWeatherAlerts },
      promotions,
      weatherViews: { vpws50: () => undefined, vpww56: () => view("officialL4", ["島根県"]) },
      getHub: () => ({ ingest: hubIngest }),
      now: () => T0,
    });

    sink.ingest(weatherEvent({
      type: "VPWW56",
      publishingOffice: "",
      weatherStateMutationAccepted: false,
    }));

    expect(applyWeatherAlerts).not.toHaveBeenCalled();
    expect(promotions.get("vpww56")).toBeNull();
    expect(hubIngest).toHaveBeenCalledTimes(1);
  });

  it("VPWW56 union は event 自身でなく active subject 群の正規 revision を使う", () => {
    const applyWeatherAlerts = vi.fn();
    const activeReportDateTime = "2026-07-25T21:00:00+09:00";
    const sink = createDisplaySink({
      standby: { applyEvent: vi.fn(), applyWeatherAlerts },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => view("officialL4", ["島根県"]) },
      getHub: () => null,
      now: () => T0,
    });

    sink.ingest(weatherEvent({
      type: "VPWW56",
      reportDateTime: "2026-07-23T21:00:00+09:00",
      serial: "1",
      weatherStateRevision: { reportDateTime: activeReportDateTime, serial: "9" },
    }));

    expect(applyWeatherAlerts).toHaveBeenCalledWith(
      "vpww56",
      [expect.objectContaining({ updatedAt: activeReportDateTime })],
      activeReportDateTime,
      "9",
      T0,
    );
  });

  it("unsafe 報では昇格の時計が動かない", () => {
    const h = harness();
    h.setVpws50(view("officialL4", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    h.setNow(T0 + 20 * MIN);
    h.sink.ingest(weatherEvent({ type: "VPWS50", weatherConfidence: "unsafe" }));
    const rec = h.promotions.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
  });

  it("unsafe VPWS50 は legacy weatherAlerts の revision も更新しない", () => {
    const applyWeatherAlerts = vi.fn();
    const hubIngest = vi.fn();
    const sink = createDisplaySink({
      standby: { applyEvent: vi.fn(), applyWeatherAlerts },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => view("officialL3", ["東京都"]), vpww56: () => undefined },
      getHub: () => ({ ingest: hubIngest }),
      now: () => T0,
    });

    sink.ingest(weatherEvent({
      type: "VPWS50",
      reportDateTime: "2026-07-25T22:00:00+09:00",
      serial: "9",
      weatherConfidence: "unsafe",
    }));

    expect(applyWeatherAlerts).not.toHaveBeenCalled();
    expect(hubIngest).toHaveBeenCalledTimes(1);
  });

  it("standby state も hub の有無に関わらず更新される", () => {
    const h = harness();
    h.sink.ingest(weatherEvent({ type: "VXSE53", domain: "earthquake" }));
    expect(h.standbyCalls).toBe(1);
  });

  it("standby・昇格・hub がすべて同じ nowMs で呼ばれる", () => {
    const h = harness();
    h.setVpws50(view("officialL5", ["東京都"]));
    h.setNow(T0 + 5 * MIN);
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    const rec = h.promotions.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0 + 5 * MIN);
  });
});
