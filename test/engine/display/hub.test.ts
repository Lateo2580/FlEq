import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KILL_SWITCH_ERRORS,
  RECENT_TICKER_MAX,
  STATE_DEBOUNCE_MS,
  SWEEP_INTERVAL_MS,
  TICKER_SYNC_RETRY_MS,
} from "../../../src/engine/display/constants";
import { InfoDisplayHub, type InfoDisplayHubDeps } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type {
  DisplayBroadcastResult,
  DisplayServerMessage,
  DisplayStatsV1,
  DisplayTransport,
  DisplayWeatherAlertV1,
} from "../../../src/engine/display/types";
import type { PresentationEvent, PresentationTsunamiObservation } from "../../../src/engine/presentation/types";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { weatherAlertsFromVpws50 } from "../../../src/engine/display/runtime";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import type { ParsedWeatherWarning, WeatherItem, WeatherKind } from "../../../src/types";

const T0 = Date.parse("2026-07-06T21:00:00+09:00");

function warnKind(code: string): WeatherKind {
  return { name: `Kind${code}`, code, severity: "warning" };
}

function warnItem(areaName: string, areaCode: string, kinds: WeatherKind[]): WeatherItem {
  return { areaName, areaCode, kinds, statuses: [] };
}

/** VPWS50 の ParsedWeatherWarning を府県予報区 layer だけ組んで返す (e2e state 駆動用) */
function vpws50Info(items: WeatherItem[]): ParsedWeatherWarning {
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    type: "VPWS50", infoType: "発表", title: "気象警報・注意報",
    reportDateTime: "2026-07-06T20:50:00+09:00", headline: null,
    publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "気象警報・注意報",
    layers, comments: [], maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
  };
}

class FakeTransport implements DisplayTransport {
  messages: DisplayServerMessage[] = [];
  /** テストで設定すると broadcast がこの blockedSkipped を返す (finding 2: 一部 client 未達を模す) */
  blockedSkipped = 0;
  clients = 1;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  broadcast(msg: DisplayServerMessage): DisplayBroadcastResult {
    this.messages.push(msg);
    return { total: this.clients, blockedSkipped: this.blockedSkipped };
  }
  clientCount(): number {
    return this.clients;
  }
  events(): Array<Extract<DisplayServerMessage, { type: "event" }>> {
    return this.messages.filter(
      (m): m is Extract<DisplayServerMessage, { type: "event" }> => m.type === "event",
    );
  }
  states(): Array<Extract<DisplayServerMessage, { type: "state" }>> {
    return this.messages.filter(
      (m): m is Extract<DisplayServerMessage, { type: "state" }> => m.type === "state",
    );
  }
}

function baseEvent(over: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: "msg-1", classification: "telegram.weather", domain: "weather",
    type: "VPWW55", infoType: "発表", title: "気象警報・注意報", headline: null,
    reportDateTime: "2026-07-06T21:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "normal", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null,
    ...over,
  } as PresentationEvent;
}

/** 状態を動かさない電文 (weather 系。applyEvent は false を返す) */
function weatherEvent(id: string): PresentationEvent {
  return baseEvent({ id });
}

/** 状態を動かす電文 (EEW。applyEvent が true を返す) */
function eewEvent(eventId: string, serial: string): PresentationEvent {
  return baseEvent({
    id: `eew-${eventId}-${serial}`, classification: "eew.warning", domain: "eew",
    type: "VXSE45", eventId, serial, isWarning: true, isFinal: false,
    hypocenterName: "能登半島沖", forecastMaxInt: "5強", forecastMaxIntRank: 6,
    magnitude: "6.5", frameLevel: "critical",
  });
}

function vpws50Event(reportDateTime: string): PresentationEvent {
  return baseEvent({ id: `vpws50-${reportDateTime}`, type: "VPWS50", reportDateTime });
}

/** VTSE41 (津波警報・注意報・予報)。emergency:tsunami を組む状態確立イベント */
function tsunamiWarningEvent(kind: string): PresentationEvent {
  return baseEvent({
    id: `tsunami-warn-${kind}`, classification: "telegram.earthquake", domain: "tsunami",
    type: "VTSE41", tsunamiKinds: [kind], areaItems: [{ name: "宮崎県", kind }],
    frameLevel: kind === "大津波警報" ? "critical" : "warning",
  });
}

/** VTSE51/52 (津波情報・沖合観測)。Forecast を持たないため emergency は組まれない (tsunamiKinds なし) */
function tsunamiObservationEvent(type: string, observations: PresentationTsunamiObservation[]): PresentationEvent {
  return baseEvent({
    id: `${type}-obs`, classification: "telegram.earthquake", domain: "tsunami",
    type, tsunamiObservations: observations, frameLevel: "info",
  });
}

interface HubSetup {
  hub: InfoDisplayHub;
  store: DisplayStateStore;
  transport: FakeTransport;
}

function makeHub(over: Partial<InfoDisplayHubDeps> = {}): HubSetup {
  const store = new DisplayStateStore();
  const transport = new FakeTransport();
  const deps: InfoDisplayHubDeps = {
    summarize: () => "要約",
    weatherAlerts: () => [],
    now: () => T0,
    ...over,
  };
  const hub = new InfoDisplayHub(store, deps);
  hub.attachTransport(transport);
  return { hub, store, transport };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InfoDisplayHub: ingest / ring buffer", () => {
  it("① ingest が {type:'event'} を seq 昇順で broadcast する", () => {
    const { hub, transport } = makeHub();
    hub.ingest(weatherEvent("w1"));
    hub.ingest(weatherEvent("w2"));
    hub.ingest(weatherEvent("w3"));
    const events = transport.events();
    expect(events.length).toBe(3);
    expect(events.map((m) => m.event.seq)).toEqual([1, 2, 3]);
    expect(events.map((m) => m.event.id)).toEqual(["w1", "w2", "w3"]);
  });

  it("② ring buffer が RECENT_TICKER_MAX で丸まる", () => {
    const { hub } = makeHub();
    for (let i = 1; i <= RECENT_TICKER_MAX + 5; i++) {
      hub.ingest(weatherEvent(`w${i}`));
    }
    const ticker = hub.buildSnapshot().recentTicker;
    expect(ticker.length).toBe(RECENT_TICKER_MAX);
    // 新しい順: 先頭が最後の ingest、末尾は古い 5 件が落ちた後の 6 件目
    expect(ticker[0].id).toBe(`w${RECENT_TICKER_MAX + 5}`);
    expect(ticker[ticker.length - 1].id).toBe("w6");
  });

  it("⑨ buildSnapshot().recentTicker は新しい順 (最後の ingest が先頭)", () => {
    const { hub } = makeHub();
    hub.ingest(weatherEvent("w1"));
    hub.ingest(weatherEvent("w2"));
    hub.ingest(weatherEvent("w3"));
    expect(hub.buildSnapshot().recentTicker.map((d) => d.id)).toEqual(["w3", "w2", "w1"]);
  });

  it("⑦ ingest が connection.lastReceivedAt を更新する", () => {
    const { hub } = makeHub({ now: () => T0 + 5_000 });
    hub.ingest(weatherEvent("w1"));
    expect(hub.buildSnapshot().connection.lastReceivedAt).toBe(new Date(T0 + 5_000).toISOString());
  });
});

describe("sweepTicker: 優先度別 TTL (spec §3-1)", () => {
  it("inactive EEW は 10 分超で除去する", () => {
    const { hub } = makeHub();
    hub.ingest(eewEvent("E1", "1"));
    hub.ingest({ ...eewEvent("E1", "2"), isCancellation: true });
    hub.sweepTicker(T0 + 10 * 60_000 + 1);
    expect(hub.buildSnapshot().recentTicker).toEqual([]);
  });

  it("全 TTL を超えた recent エントリを除去し true を返す", () => {
    const { hub } = makeHub();
    hub.ingest(weatherEvent("w1")); // active な警報 groupKey に該当しない一般電文
    // 全 TTL (最長 low 3h) を超えて sweep
    const removed = hub.sweepTicker(T0 + 3 * 60 * 60_000 + 60_000);
    expect(removed).toBe(true);
    expect(hub.buildSnapshot().recentTicker.length).toBe(0);
  });

  it("active EEW に対応するエントリは TTL 超過でも残す", () => {
    const { hub } = makeHub();
    hub.ingest(eewEvent("E1", "1")); // activeEews に E1 → activeAlertKeys に eew:E1、groupKey も eew:E1
    hub.sweepTicker(T0 + 3 * 60 * 60_000 + 60_000);
    expect(hub.buildSnapshot().recentTicker.some((d) => d.groupKey === "eew:E1")).toBe(true);
  });

  it("TTL 内は除去しない", () => {
    const { hub } = makeHub();
    hub.ingest(weatherEvent("w1"));
    expect(hub.sweepTicker(T0 + 60_000)).toBe(false); // 1 分後は全 TTL 内
    expect(hub.buildSnapshot().recentTicker.length).toBe(1);
  });
});

describe("InfoDisplayHub: state debounce", () => {
  it("③ state 変化イベントの後、debounce 経過で {type:'state'} が 1 回だけ飛ぶ", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.ingest(eewEvent("E1", "1"));
    hub.ingest(eewEvent("E1", "2"));
    expect(transport.states().length).toBe(0);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    const snap = transport.states()[0].snapshot;
    expect(snap.activeEews.length).toBe(1);
    expect(snap.activeEews[0].serial).toBe("2");
    expect(snap.seq).toBe(2);
    // dirty が消えた後は追加の state は飛ばない
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 4);
    expect(transport.states().length).toBe(1);
  });

  it("state 変化のない ingest では state がスケジュールされない", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.ingest(weatherEvent("w1"));
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 4);
    expect(transport.states().length).toBe(0);
    expect(transport.events().length).toBe(1);
  });

  it("⑩ publishConnection が store を更新し、debounce 経過で {type:'state'} が 1 回だけ飛ぶ", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.ingest(weatherEvent("w1")); // lastReceivedAt を先に立てる
    hub.publishConnection({ dmdata: "disconnected", reason: "socket closed" });
    expect(hub.buildSnapshot().connection).toMatchObject({
      dmdata: "disconnected",
      reason: "socket closed",
      disconnectedSince: new Date(T0).toISOString(),
      lastReceivedAt: new Date(T0).toISOString(), // publishConnection で消えない (Minor 4)
    });
    expect(transport.states().length).toBe(0);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    expect(transport.states()[0].snapshot.connection.dmdata).toBe("disconnected");
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 4);
    expect(transport.states().length).toBe(1);
  });
});

describe("InfoDisplayHub: publishStats", () => {
  function makeStats(overrides: Partial<DisplayStatsV1> = {}): DisplayStatsV1 {
    return {
      sparklineData: [0, 1, 2],
      totalReceived: 3,
      todayQuakeCount: 1,
      todayMaxInt: "3",
      todayMaxIntRank: 3,
      ...overrides,
    };
  }

  it("publishStats 後、buildSnapshot().stats が渡した値を反映する", () => {
    const { hub } = makeHub();
    const stats = makeStats();
    hub.publishStats(stats);
    expect(hub.buildSnapshot().stats).toEqual(stats);
  });

  it("同一 stats を 2 回 publish しても state broadcast は 1 回だけ", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    const stats = makeStats();
    hub.publishStats(stats);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    hub.publishStats(makeStats()); // 内容は同一 (別オブジェクト)
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1); // 変化なしなので増えない
  });

  it("変化のある stats を publish すると state broadcast が増える", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.publishStats(makeStats());
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    hub.publishStats(makeStats({ totalReceived: 4 }));
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(2);
  });

  it("hub.stop() 後の publishStats は無視される", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.stop();
    hub.publishStats(makeStats());
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(0);
    expect(hub.buildSnapshot().stats).toBeNull();
  });
});

describe("InfoDisplayHub: 定期 state の recentTicker (SSE バイト上限対策)", () => {
  it("通常時 (sweepTicker 変化なし) の定期 state broadcast は recentTicker を運ばず tickerSynced も立たない (サイズ回帰なし)", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.ingest(eewEvent("E1", "1"));
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    expect(transport.states()[0].snapshot.recentTicker).toEqual([]);
    expect(transport.states()[0].snapshot.tickerSynced).toBeUndefined();
    // buildSnapshot() (接続時 snapshot 用) は従来どおりフル
    expect(hub.buildSnapshot().recentTicker.length).toBeGreaterThan(0);
  });

  it("startTimers の定期 sweep が recentTicker の構成を変えたら次の state 配信に recentTicker + tickerSynced:true が一発同梱される (spec §3-2、レビュー Important 対応)", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { hub, transport } = makeHub({ now: () => nowMs });
    // weatherEvent は state を変えない (applyEvent が false) ので ingest 単体では state は飛ばない
    hub.ingest(weatherEvent("w1")); // active な groupKey に該当しない一般電文 → sweep で刈られる対象
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(0);

    hub.startTimers();
    nowMs = T0 + 3 * 60 * 60_000 + 60_000; // low TTL (3h) 超過
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS); // 定期 sweep が sweepTicker を呼び w1 を刈って dirty 化
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);

    expect(transport.states().length).toBe(1);
    const synced = transport.states()[0]!.snapshot;
    expect(synced.tickerSynced).toBe(true);
    expect(synced.recentTicker.some((d) => d.id === "w1")).toBe(false); // sweep で消えた構成が届く
  });

  it("recentTicker が縮退でも収まらないほど巨大なら tickerSynced を諦めて通常の除外 state で送り、pending は次回に持ち越す (spec §3-2、レビュー R2 Important 対応)", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { hub, transport } = makeHub({ now: () => nowMs, summarize: () => "あ".repeat(5000) });

    hub.ingest(weatherEvent("old")); // T0 受信、low TTL (3h) 超過でやがて消える 1 件
    nowMs = T0 + 170 * 60_000;
    for (let i = 0; i < 60; i++) hub.ingest(weatherEvent(`fresh${i}`)); // まだ TTL 内、それだけで巨大な集団

    nowMs = T0 + 181 * 60_000; // old は 181min > 180min (low TTL) で失効、fresh は 11min でまだ内側
    const removed = hub.sweepTicker(nowMs);
    expect(removed).toBe(true); // old が消えて構成が変わった (tickerSyncPending が立つ)

    hub.publishConnection({}); // markStateDirty を発火 (sweepTicker 自体は dirty 化しない契約)
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);

    expect(transport.states().length).toBe(1);
    const sent = transport.states()[0]!.snapshot;
    // fresh 60 件 (5000 文字 ×60) は degradeSyncedStateToBudget (recentTicker 不可侵) では収まらず、
    // 通常ラダー (recentTicker を諦める) へフォールバックする
    expect(sent.tickerSynced).toBeUndefined();
    expect(sent.recentTicker).toEqual([]);
  });

  it("初回フォールバック後、外部 dirty なしでも再試行タイマーが自動再試行し、縮小後に tickerSynced:true で収束する (spec §3-5、レビュー R3 Important 対応)", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { hub, transport } = makeHub({
      now: () => nowMs,
      summarize: (event) => (event.id === "trigger" ? "小さい要約" : "あ".repeat(5000)),
    });

    hub.ingest(weatherEvent("trigger")); // T0 受信、後で TTL 失効させる 1 件
    nowMs = T0 + 170 * 60_000;
    for (let i = 0; i < 60; i++) hub.ingest(weatherEvent(`fresh${i}`)); // まだ TTL 内、それだけで巨大な集団

    nowMs = T0 + 181 * 60_000; // trigger だけ失効、fresh 60 件はまだ内側
    expect(hub.sweepTicker(nowMs)).toBe(true); // 構成変化 → tickerSyncPending が立つ

    hub.publishConnection({}); // 最初で最後の外部 dirty (以降は一切呼ばない)
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    expect(transport.states()[0]!.snapshot.tickerSynced).toBeUndefined(); // fresh が巨大すぎてフォールバック

    // fresh 60 件が受信 (170min) から low TTL (180min) を超えるところまで進め、sweepTicker だけを
    // 直接呼んで構成を縮小させる (markStateDirty は一切呼ばない = 外部 dirty が来ない想定を模す)
    nowMs = T0 + (170 + 181) * 60_000;
    expect(hub.sweepTicker(nowMs)).toBe(true); // fresh も失効し recent が空になる

    // 外部 dirty を一切呼ばず、再試行タイマー (TICKER_SYNC_RETRY_MS) だけを進める
    vi.advanceTimersByTime(TICKER_SYNC_RETRY_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);

    expect(transport.states().length).toBe(2);
    const resynced = transport.states()[1]!.snapshot;
    expect(resynced.tickerSynced).toBe(true); // 再試行タイマーだけで完全同期に収束する
    expect(resynced.recentTicker).toEqual([]);
  });

  it("tickerSynced:true でも backpressure 中の client に届かない (blockedSkipped>0) 間は pending を保持し、drain 後の再試行で収束する (最終レビュー finding 2)", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { hub, transport } = makeHub({ now: () => nowMs });

    hub.ingest(weatherEvent("w1")); // T0 受信、low TTL 超過でやがて刈られる 1 件
    nowMs = T0 + 3 * 60 * 60_000 + 60_000; // low TTL (3h) 超過
    expect(hub.sweepTicker(nowMs)).toBe(true); // 構成変化 → tickerSyncPending が立つ

    // 1 client が backpressure でこの state を受け取れない状態を模す
    transport.blockedSkipped = 1;
    hub.publishConnection({}); // markStateDirty
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);

    expect(transport.states().length).toBe(1);
    expect(transport.states()[0]!.snapshot.tickerSynced).toBe(true); // 完全同期は「送っては」いる
    // だが blockedSkipped>0 → 一部 client 未達なので pending を落とさず再試行タイマーが再送する
    vi.advanceTimersByTime(TICKER_SYNC_RETRY_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(2); // pending 保持の証拠 (blocked のまま自動再試行)
    expect(transport.states()[1]!.snapshot.tickerSynced).toBe(true);

    // client が drain し全 client へ届くようになった
    transport.blockedSkipped = 0;
    vi.advanceTimersByTime(TICKER_SYNC_RETRY_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(3); // drain 後の再試行で完全配送に収束
    expect(transport.states()[2]!.snapshot.tickerSynced).toBe(true);

    // 完全配送で pending が落ちたので以降は再試行しない (state が増えない)
    vi.advanceTimersByTime(TICKER_SYNC_RETRY_MS * 2);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(3);
  });

  it("巨大 weatherAlerts でも定期 state が縮退されて配信され、fail-loud スキップにならない", () => {
    vi.useFakeTimers();
    const hugeAlerts: DisplayWeatherAlertV1[] = [{
      source: "vpws50", label: "大雨警報", role: "weatherWarning", totalAreas: 150,
      items: [{
        kind: "大雨警報", displaySeverity: "officialL3", rank: "warning",
        shownAreas: Array.from({ length: 150 }, (_, i) => `気象地域${i}`.repeat(500)),
        omittedAreaCount: 0,
      }],
      updatedAt: "2026-07-06T20:50:00+09:00",
    }];
    const { hub, transport } = makeHub({ weatherAlerts: () => hugeAlerts });
    hub.ingest(vpws50Event("2026-07-06T20:50:00+09:00"));
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    const sentAlerts = transport.states()[0].snapshot.weatherAlerts;
    expect(sentAlerts[0]?.items[0]?.shownAreas.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(transport.states()[0]).length).toBeLessThan(JSON.stringify(hugeAlerts).length);
  });
});

describe("InfoDisplayHub: frontendBuildId (フロント自動リロード)", () => {
  it("frontendBuildId getter が無ければ snapshot に載らない (旧サーバ・欠落契約)", () => {
    const { hub } = makeHub();
    expect(hub.buildSnapshot().frontendBuildId).toBeUndefined();
  });

  it("getter があれば接続時 snapshot と定期 state の両方に buildId が載る", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub({ frontendBuildId: () => "build-abc" });
    expect(hub.buildSnapshot().frontendBuildId).toBe("build-abc");
    hub.ingest(eewEvent("E1", "1")); // state を動かす
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states()[0]!.snapshot.frontendBuildId).toBe("build-abc");
  });

  it("getter が null を返す間は snapshot に載らない (dist 未解決)", () => {
    const { hub } = makeHub({ frontendBuildId: () => null });
    expect(hub.buildSnapshot().frontendBuildId).toBeUndefined();
  });

  it("定期 sweep で新 buildId を連続 2 回観測したら (無停止 display:build) 電文契機なしに state を配信する", () => {
    vi.useFakeTimers();
    let id = "build-1";
    const { hub, transport } = makeHub({ frontendBuildId: () => id });
    hub.startTimers();
    // 変化前の sweep では余計な state を出さない (基準は startTimers で据え済み)
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(0);
    // dist が差し替わった。1 回目観測 (pending) ではまだ配信しない (安定化)
    id = "build-2";
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(0);
    // 2 回目観測で同一を確認 → published へ昇格し配信
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    expect(transport.states()[0]!.snapshot.frontendBuildId).toBe("build-2");
    // 変化が落ち着けば以降は増えない
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3 + STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    hub.stopTimers();
  });

  it("buildId がフラッピング (A→B→A→B) しても連続 2 回同一を満たさず、published は昇格せず state を配信しない (レビュー high)", () => {
    vi.useFakeTimers();
    const seq = ["a", "b", "a", "b", "a", "b"];
    let i = 0;
    const { hub, transport } = makeHub({ frontendBuildId: () => seq[Math.min(i, seq.length - 1)]! });
    // startTimers が seq[0]="a" を即 published 採用
    hub.startTimers();
    expect(hub.buildSnapshot().frontendBuildId).toBe("a");
    // 以降 b,a,b,a,b と毎 sweep で揺れ続ける → どの新値も 2 回連続しないので昇格しない
    for (i = 1; i < seq.length; i++) {
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    }
    expect(transport.states().length).toBe(0);
    expect(hub.buildSnapshot().frontendBuildId).toBe("a"); // 配信値は初期のまま
    hub.stopTimers();
  });
});

describe("InfoDisplayHub: kill switch", () => {
  it("④ summarize が throw しても ingest は例外を投げず、以降の ingest は続く", () => {
    let fail = true;
    const { hub, transport } = makeHub({
      summarize: () => {
        if (fail) throw new Error("boom");
        return "ok";
      },
    });
    expect(() => hub.ingest(weatherEvent("w1"))).not.toThrow();
    expect(transport.events().length).toBe(0);
    fail = false;
    hub.ingest(weatherEvent("w2"));
    const events = transport.events();
    expect(events.length).toBe(1);
    expect(events[0].event.id).toBe("w2");
    // 失敗した ingest は seq を消費しない
    expect(events[0].event.seq).toBe(1);
  });

  it("⑤ KILL_SWITCH_ERRORS 回連続エラーで stop() + onFatal、以降 broadcast されない", () => {
    const onFatal = vi.fn();
    const { hub, transport } = makeHub({
      summarize: () => {
        throw new Error("boom");
      },
      onFatal,
    });
    for (let i = 1; i < KILL_SWITCH_ERRORS; i++) {
      hub.ingest(weatherEvent(`w${i}`));
    }
    expect(hub.isStopped()).toBe(false);
    expect(onFatal).not.toHaveBeenCalled();
    hub.ingest(weatherEvent("w-last"));
    expect(hub.isStopped()).toBe(true);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0][0])).toContain("boom");
    // stop 後の ingest は無視される (onFatal の再発火もない)
    hub.ingest(weatherEvent("after"));
    expect(transport.messages.length).toBe(0);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("onFatal が throw しても ingest は例外を投げない (kill switch 発火の瞬間も封じ込め)", () => {
    const { hub, transport } = makeHub({
      summarize: () => {
        throw new Error("boom");
      },
      onFatal: () => {
        throw new Error("fatal handler broken");
      },
    });
    for (let i = 1; i < KILL_SWITCH_ERRORS; i++) {
      hub.ingest(weatherEvent(`w${i}`));
    }
    expect(() => hub.ingest(weatherEvent("w-last"))).not.toThrow();
    expect(hub.isStopped()).toBe(true);
    expect(transport.messages.length).toBe(0);
  });

  it("⑥ 成功 ingest で連続エラーカウンタがリセットされる", () => {
    const onFatal = vi.fn();
    let fail = true;
    const { hub } = makeHub({
      summarize: () => {
        if (fail) throw new Error("boom");
        return "ok";
      },
      onFatal,
    });
    for (let i = 1; i < KILL_SWITCH_ERRORS; i++) {
      hub.ingest(weatherEvent(`a${i}`));
    }
    fail = false;
    hub.ingest(weatherEvent("ok1")); // カウンタリセット
    fail = true;
    for (let i = 1; i < KILL_SWITCH_ERRORS; i++) {
      hub.ingest(weatherEvent(`b${i}`));
    }
    expect(hub.isStopped()).toBe(false);
    expect(onFatal).not.toHaveBeenCalled();
    hub.ingest(weatherEvent("b-last")); // リセット後の 10 連続目で発火
    expect(hub.isStopped()).toBe(true);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});

describe("InfoDisplayHub: state timer の例外封じ込め", () => {
  it("state timer 発火時に broadcast が throw しても uncaught にならず hub は継続する", () => {
    vi.useFakeTimers();
    const store = new DisplayStateStore();
    const transport: DisplayTransport = {
      async start() {},
      async stop() {},
      broadcast(msg): DisplayBroadcastResult {
        if (msg.type === "state") throw new Error("broken pipe");
        return { total: 0, blockedSkipped: 0 };
      },
      clientCount: () => 0,
    };
    const hub = new InfoDisplayHub(store, {
      summarize: () => "要約",
      weatherAlerts: () => [],
      now: () => T0,
    });
    hub.attachTransport(transport);
    hub.ingest(eewEvent("E1", "1"));
    // timer callback からの throw は uncaughtException として monitor を殺すため、握られていること
    expect(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS)).not.toThrow();
    expect(hub.isStopped()).toBe(false);
    // 次の状態変化で state 配信は再試行される (timer が再スケジュールされる)
    expect(() => {
      hub.ingest(eewEvent("E1", "2"));
      vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    }).not.toThrow();
  });
});

describe("InfoDisplayHub: weatherAlerts (VPWS50)", () => {
  it("⑧ VPWS50 の ingest で weatherAlerts が reportDateTime 付きで呼ばれ、snapshot 反映 + state push", () => {
    vi.useFakeTimers();
    const rdt = "2026-07-06T20:50:00+09:00";
    const alerts: DisplayWeatherAlertV1[] = [{
      source: "vpws50", label: "大雨警報", role: "weatherWarning", totalAreas: 3,
      items: [{
        kind: "大雨警報",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["千葉県北西部", "千葉県北東部", "千葉県南部"],
        omittedAreaCount: 0,
      }],
      updatedAt: rdt,
    }];
    const weatherAlerts = vi.fn(() => alerts);
    const { hub, transport } = makeHub({ weatherAlerts });
    hub.ingest(weatherEvent("w1")); // VPWS50 以外では呼ばれない
    expect(weatherAlerts).not.toHaveBeenCalled();
    hub.ingest(vpws50Event(rdt));
    expect(weatherAlerts).toHaveBeenCalledTimes(1);
    expect(weatherAlerts).toHaveBeenCalledWith(rdt);
    expect(hub.buildSnapshot().weatherAlerts).toEqual(alerts);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);
    expect(transport.states()[0].snapshot.weatherAlerts).toEqual(alerts);
  });

  it("⑩ 全種別解除の VPWS50 で weatherAlerts が空配列で配信される (e2e: state → dep → snapshot)", () => {
    vi.useFakeTimers();
    // 本番配線と同型: hub の weatherAlerts dep はライブの state holder を読み直す。
    // process-weather 相当で「先に state を更新 → ingest」の順を守る。
    const vpws50State = new Vpws50StateHolder();
    const { hub, transport } = makeHub({
      weatherAlerts: (updatedAt) =>
        weatherAlertsFromVpws50(vpws50State.getCurrentAreasForDisplay(), updatedAt),
    });

    // 1) 2 種別の大雨警報 (Code 03 = officialL3 = warning ランク) を発表
    vpws50State.diffAndUpdate(
      vpws50Info([
        warnItem("千葉県北西部", "120010", [warnKind("03")]),
        warnItem("千葉県北東部", "120020", [warnKind("03")]),
      ]),
      "msg-1",
    );
    hub.ingest(vpws50Event("2026-07-06T20:50:00+09:00"));
    expect(hub.buildSnapshot().weatherAlerts.length).toBeGreaterThan(0);

    // 2) 全種別一斉解除 (空 items)。abnormal_release_rate ではなく通常経路で current が空に
    vpws50State.diffAndUpdate(vpws50Info([]), "msg-2");
    hub.ingest(vpws50Event("2026-07-06T21:00:00+09:00"));
    expect(hub.buildSnapshot().weatherAlerts).toEqual([]);

    // state push でも空配列が届く (フロントは全置換 → カード消滅)
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    const states = transport.states();
    expect(states[states.length - 1].snapshot.weatherAlerts).toEqual([]);
  });
});

describe("InfoDisplayHub: 津波観測の橋渡し (VTSE51/52 → state-store, Phase 2)", () => {
  it("VTSE41 で津波 state 確立後、VTSE51 の観測 (PresentationEvent.tsunamiObservations) が state に反映される", () => {
    const { hub, store } = makeHub();
    hub.ingest(tsunamiWarningEvent("大津波警報"));
    expect(store.snapshot(1, T0).tsunami).not.toBeNull();

    const obs: PresentationTsunamiObservation[] = [
      {
        areaName: "宮崎県", areaKind: "大津波警報", stationName: "細島",
        arrivalTime: "2026-07-06T21:10:00+09:00", initial: "押し", maxHeightValue: "8.5m", condition: "上昇中",
      },
    ];
    hub.ingest(tsunamiObservationEvent("VTSE51", obs));
    const snap = hub.buildSnapshot();
    expect(snap.tsunami?.observations).toEqual(obs);
    expect(snap.tsunami?.level).toBe("majorWarning"); // level は VTSE41 のまま (VTSE51 で変わらない)
  });

  it("tsunami state が無い状態で VTSE52 (観測のみ) を ingest しても state は作られない", () => {
    const { hub, store } = makeHub();
    const obs: PresentationTsunamiObservation[] = [
      {
        areaName: null, areaKind: null, stationName: "岩手釜石沖",
        arrivalTime: "2026-07-06T21:00:00+09:00", initial: "引き", maxHeightValue: null, condition: "観測中",
      },
    ];
    hub.ingest(tsunamiObservationEvent("VTSE52", obs));
    expect(store.snapshot(1, T0).tsunami).toBeNull();
  });
});

describe("InfoDisplayHub: sweep タイマー", () => {
  it("startTimers 後、sweep の変化 (EEW final hold 超過) が state push につながる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { hub, transport } = makeHub({ now: undefined }); // Date.now (fake) に委ねる
    hub.ingest(baseEvent({
      id: "eew-final", classification: "eew.warning", domain: "eew",
      type: "VXSE45", eventId: "E1", serial: "5", isWarning: true, isFinal: true,
      frameLevel: "critical",
    }));
    hub.startTimers();
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1); // ingest 由来の state
    expect(transport.states()[0].snapshot.activeEews.length).toBe(1);
    // EEW_FINAL_HOLD_SEC (120s) 超過後の sweep tick (125s) → debounce 後に 2 通目
    vi.advanceTimersByTime(126_000 - STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(2);
    expect(transport.states()[1].snapshot.activeEews.length).toBe(0);
    // 変化がなければ以降 state は飛ばない
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
    expect(transport.states().length).toBe(2);
    hub.stopTimers();
  });

  it("stop() でタイマーが止まり、保留中の state broadcast も飛ばない", () => {
    vi.useFakeTimers();
    const { hub, transport } = makeHub();
    hub.ingest(eewEvent("E1", "1"));
    hub.startTimers();
    hub.stop();
    expect(hub.isStopped()).toBe(true);
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 4 + SWEEP_INTERVAL_MS * 4);
    expect(transport.states().length).toBe(0);
    // stop 後の publishConnection も state をスケジュールしない
    hub.publishConnection({ dmdata: "disconnected", reason: "x" });
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 4);
    expect(transport.states().length).toBe(0);
  });

  it("stop() で tickerSync 再試行タイマーも止まる (レビュー R3 Important 対応)", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { hub, transport } = makeHub({ now: () => nowMs, summarize: () => "あ".repeat(5000) });

    hub.ingest(weatherEvent("trigger"));
    nowMs = T0 + 170 * 60_000;
    for (let i = 0; i < 60; i++) hub.ingest(weatherEvent(`fresh${i}`));
    nowMs = T0 + 181 * 60_000;
    hub.sweepTicker(nowMs);
    hub.publishConnection({}); // フォールバック → 再試行タイマーが張られる
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(transport.states().length).toBe(1);

    hub.stop(); // stopTimers() 経由で再試行タイマーもクリアされるはず
    vi.advanceTimersByTime(TICKER_SYNC_RETRY_MS * 4);
    expect(transport.states().length).toBe(1); // 再試行タイマーが生きていれば増えるが、増えない
  });
});

describe("tickerSuppressed の ingest (spec 2026-07-23 T5-2)", () => {
  it("抑制イベントは recentTicker に積まれず、broadcast と seq は通常どおり進む", () => {
    const { hub, transport } = makeHub();
    hub.ingest({
      ...weatherEvent("sup-1"),
      domain: "weatherWarningTimeseries",
      type: "VPWP50",
      bodyText: null,
      raw: { areas: [] },
    } as PresentationEvent);
    hub.ingest(weatherEvent("w-after"));
    const events = transport.events();
    expect(events.length).toBe(2);                    // broadcast は 2 件とも流れる
    expect(events[0].event.seq).toBe(1);
    expect(events[1].event.seq).toBe(2);              // seq は連番 (gap なし)
    const recent = hub.buildSnapshot().recentTicker;
    expect(recent.length).toBe(1);                    // recentTicker には非抑制のみ
    expect(recent[0].id).toBe("w-after");
  });
});
