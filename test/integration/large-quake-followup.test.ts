import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsDataMessage } from "../../src/types";
import { normalizeTelegramMessage } from "../../src/dmdata/telegram-ingress";
import { createDisplaySink } from "../../src/engine/monitor/display-sink";
import { InfoDisplayHub } from "../../src/engine/display/hub";
import { DisplayStateStore, type DisplayQuakeLifecyclePersistedV1 } from "../../src/engine/display/state-store";
import { StandbyStateStore } from "../../src/engine/display/standby-state-store";
import { WeatherPromotionStore } from "../../src/engine/display/weather-promotion-store";
import { QuakeDisplayStore } from "../../src/engine/display/quake-display-store";
import { DailyQuakeCounter } from "../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../src/engine/messages/daily-quake-persistence";
import { QuakeDisplayPersistence } from "../../src/engine/display/quake-display-persistence";
import { createMessageHandler } from "../../src/engine/messages/message-router";
import { createMockWsDataMessage, createMockWsDataMessageFromXml, readFixture } from "../helpers/mock-message";

// 実系列: 2009-08-11 駿河湾 (EventID 20090811050711)。VXSE51 05:09 最大 6弱、VXSE61 08:55。
const VXSE51 = "32-35_07_01_100915_VXSE51.xml";
const VXSE61 = "32-35_03_02_240613_VXSE61.xml";
const EVENT_ID = "20090811050711";
const T51 = Date.parse("2009-08-11T05:09:00+09:00");
const T61 = Date.parse("2009-08-11T08:55:00+09:00");
const MIN = 60_000;

/** VXSE61 の ReportDateTime だけを受信時刻へ寄せる（未来時刻の電文として捨てられないように）。 */
function vxse61At(hhmm: string): string {
  return readFixture(VXSE61).replaceAll("<ReportDateTime>2009-08-11T08:55", `<ReportDateTime>2009-08-11T${hhmm}`);
}

function harness(initialNowMs: number, restored: { daily?: DailyQuakeCounter; quakeDisplay?: QuakeDisplayStore } = {}) {
  let nowMs = initialNowMs;
  vi.setSystemTime(nowMs);
  const daily = restored.daily ?? new DailyQuakeCounter(nowMs);
  const quakeDisplay = restored.quakeDisplay ?? new QuakeDisplayStore();
  const standby = new StandbyStateStore();
  let hub: InfoDisplayHub | null = null;
  const sink = createDisplaySink({
    standby: { applyEvent: (event, t) => standby.applyEvent(event, t) },
    promotions: new WeatherPromotionStore(),
    quakeDisplay,
    dailyQuakes: daily,
    weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
    getHub: () => hub,
    now: () => nowMs,
  });
  const handler = createMessageHandler({ dailyQuakeCounter: daily, displaySink: sink });
  // runtime.ts と同じく daily の recent を provider に渡し、lifecycle を復元する。
  const display = new DisplayStateStore(
    () => standby.snapshotItems(),
    undefined,
    undefined,
    () => daily.getRecentQuakes(nowMs),
  );
  display.restoreQuakeLifecycle(quakeDisplay.export(), nowMs);
  hub = new InfoDisplayHub(display, { summarize: (e) => e.title, weatherAlerts: () => [], now: () => nowMs });
  let seq = 0;
  const deliver = (message: WsDataMessage, atMs: number) => {
    // 本番の hub は 5 秒ごとに sweep する。受信の直前にも 1 回回して、latest の TTL 切れを再現する。
    display.sweep(atMs - 1_000);
    quakeDisplay.sweep(atMs - 1_000);
    nowMs = atMs;
    vi.setSystemTime(atMs);
    handler.handler(normalizeTelegramMessage({ ...message, id: `followup:${seq++}`, meta: undefined }, atMs).message);
  };
  return {
    daily,
    quakeDisplay,
    deliverFixture: (name: string, atMs: number) => deliver(createMockWsDataMessage(name), atMs),
    deliverXml: (xml: string, type: string, atMs: number) => deliver(createMockWsDataMessageFromXml(xml, type), atMs),
    sweep: (atMs: number) => {
      nowMs = atMs;
      vi.setSystemTime(atMs);
      display.sweep(atMs);
      quakeDisplay.sweep(atMs);
    },
    largeQuakes: () => hub!.buildSnapshot().largeQuakes,
    latest: () => hub!.buildSnapshot().latestQuake,
  };
}

/** プロセス再起動: 本番と同じく daily・quakeDisplay をファイルへ保存して読み戻し、fresh な display を作る。 */
function restart(
  h: ReturnType<typeof harness>,
  atMs: number,
  damage: (state: DisplayQuakeLifecyclePersistedV1) => DisplayQuakeLifecyclePersistedV1 = (state) => state,
) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".large-quake-restart-"));
  tempDirs.push(dir);
  const dailyPersistence = new DailyQuakePersistence(path.join(dir, "daily-quake.json"), 0);
  dailyPersistence.save(h.daily.export(), atMs);
  const dailyLoaded = dailyPersistence.load(atMs);
  dailyPersistence.dispose();
  const daily = new DailyQuakeCounter(atMs);
  expect(dailyLoaded != null && daily.restore(dailyLoaded, atMs)).toBe(true);
  const quakePersistence = new QuakeDisplayPersistence(path.join(dir, "quake-display.json"), 0);
  quakePersistence.save(damage(h.quakeDisplay.export()), atMs);
  const quakeLoaded = quakePersistence.load(atMs);
  quakePersistence.dispose();
  const quakeDisplay = new QuakeDisplayStore();
  if (quakeLoaded != null) quakeDisplay.restore(quakeLoaded, atMs);
  return harness(atMs, { daily, quakeDisplay });
}

const tempDirs: string[] = [];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 実不具合の再発防止（2026-10-24）: 保持の切れた大地震カードが、同じ地震の震度の無い続報で作り直されていた。
describe("保持の切れた大地震カードは、同じ地震の続報で戻らない", () => {
  it("live: sweep の後、latest が残っている間の VXSE61 で戻らない", () => {
    const h = harness(T51);
    h.deliverFixture(VXSE51, T51);
    expect(h.largeQuakes()).toHaveLength(1);
    h.sweep(T51 + 11 * MIN);
    expect(h.largeQuakes()).toHaveLength(0);
    h.deliverXml(vxse61At("05:39"), "VXSE61", T51 + 30 * MIN);
    expect(h.largeQuakes()).toHaveLength(0);
    expect(h.latest()).toMatchObject({ eventId: EVENT_ID, reportDateTime: "2009-08-11T05:39:00+09:00" });
  });

  it("live: latest も切れた後（実時刻 08:55）の VXSE61 で戻らない", () => {
    const h = harness(T51);
    h.deliverFixture(VXSE51, T51);
    h.sweep(T51 + 11 * MIN);
    h.deliverFixture(VXSE61, T61);
    expect(h.largeQuakes()).toHaveLength(0);
    expect(h.latest()).toMatchObject({ eventId: EVENT_ID, reportDateTime: "2009-08-11T08:55:00+09:00" });
  });

  it("restart 保持内: 再起動の後もカードは震度 6弱のまま残り、続報でも保つ", () => {
    const before = harness(T51);
    before.deliverFixture(VXSE51, T51);
    const h = restart(before, T51 + 2 * MIN);
    expect(h.largeQuakes()).toHaveLength(1);
    h.deliverXml(vxse61At("05:14"), "VXSE61", T51 + 5 * MIN);
    expect(h.largeQuakes()).toHaveLength(1);
    expect(h.largeQuakes()[0]).toMatchObject({ eventId: EVENT_ID, maxInt: "6-" });
    expect(h.latest()).toMatchObject({ eventId: EVENT_ID, maxInt: "6-" });
  });

  it("restart 保持切れ: 再起動の後の VXSE61 で戻らない（live と同じ）", () => {
    const before = harness(T51);
    before.deliverFixture(VXSE51, T51);
    const h = restart(before, T51 + 15 * MIN);
    expect(h.largeQuakes()).toHaveLength(0);
    h.deliverFixture(VXSE61, T61);
    expect(h.largeQuakes()).toHaveLength(0);
    expect(h.latest()).toMatchObject({ eventId: EVENT_ID, reportDateTime: "2009-08-11T08:55:00+09:00" });
  });

  // 実不具合の再発防止（2026-10-24 レビュー P2）: 地図の contributions だけが欠けた保存ファイルでも、保持内の続報でカードを消さない。
  it("restart 保持内・地図の contributions 欠け: 続報の後もカードは震度 6弱のまま残る", () => {
    const before = harness(T51);
    before.deliverFixture(VXSE51, T51);
    const h = restart(before, T51 + 2 * MIN, (state) => ({ ...state, contributions: [] }));
    expect(h.largeQuakes()).toHaveLength(1);
    h.deliverXml(vxse61At("05:14"), "VXSE61", T51 + 5 * MIN);
    expect(h.largeQuakes()).toHaveLength(1);
    expect(h.largeQuakes()[0]).toMatchObject({
      eventId: EVENT_ID,
      maxInt: "6-",
      reportDateTime: "2009-08-11T05:14:00+09:00",
    });
  });
});
