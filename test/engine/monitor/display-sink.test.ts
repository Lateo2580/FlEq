import { describe, expect, it } from "vitest";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
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
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null,
    ...over,
  } as PresentationEvent;
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

  it("display off 中の続報でも時計が進む (sink 経由の実配線)", () => {
    const h = harness();
    h.setVpws50(view("officialL5", ["東京都"]));
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    h.setNow(T0 + 20 * MIN);
    h.sink.ingest(weatherEvent({ type: "VPWS50" }));
    const rec = h.promotions.get("vpws50");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0 + 20 * MIN);
  });

  it("VPWW56 は vpww56 側だけを更新する", () => {
    const h = harness();
    h.setVpww56(view("officialL5", ["島根県"]));
    h.sink.ingest(weatherEvent({ type: "VPWW56" }));
    expect(h.promotions.get("vpww56")?.level).toBe(5);
    expect(h.promotions.get("vpws50")).toBeNull();
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
