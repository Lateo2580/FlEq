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
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_PHASE7_5_VXSE53_073528,
  readFixture,
} from "../helpers/mock-message";

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

/** 実 XML の震度値だけを置き換える（要素・属性・階層は保つ）。 */
function withIntensity(xml: string, value: string): string {
  return xml
    .replaceAll("震度５弱以上未入電", value)
    .replace(/<(MaxInt|Int)([^>]*)>[^<]*<\/\1>/g, (_match: string, tag: string, attributes: string) =>
      `<${tag}${attributes}>${value}</${tag}>`);
}

/** 熊本の VXSE53（EventID 20260728162718）を all-unknown にし、時刻を駿河湾の系列の手前（04 時台）へ寄せる。 */
const UNKNOWN_EVENT_ID = "20260728162718";
function allUnknownVxse53(): string {
  return withIntensity(readFixture(FIXTURE_PHASE7_5_VXSE53_073528), "未入電")
    .replaceAll("2026-07-28T16:", "2009-08-11T04:")
    .replaceAll("2026-07-28T07:", "2009-08-10T19:");
}

function harness(initialNowMs: number, restored: { daily?: DailyQuakeCounter; quakeDisplay?: QuakeDisplayStore } = {}) {
  let nowMs = initialNowMs;
  vi.setSystemTime(nowMs);
  const daily = restored.daily ?? new DailyQuakeCounter(nowMs);
  const quakeDisplay = restored.quakeDisplay ?? new QuakeDisplayStore(() => daily.getRecentQuakes());
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
  // 本番の間隔を写す: 表示側（hub）は 5 秒ごと、永続側（monitor）は 60 秒ごとに sweep する。
  // 同時に回すと、両者の期限切れの時刻のずれが隠れる。
  let displaySweptAt = initialNowMs;
  let durableSweptAt = initialNowMs;
  const advance = (toMs: number) => {
    for (let t = displaySweptAt + 5_000; t < toMs; t += 5_000) { display.sweep(t); displaySweptAt = t; }
    for (let t = durableSweptAt + 60_000; t < toMs; t += 60_000) { quakeDisplay.sweep(t); durableSweptAt = t; }
  };
  const deliver = (message: WsDataMessage, atMs: number) => {
    advance(atMs);
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
      displaySweptAt = atMs;
      durableSweptAt = atMs;
    },
    largeQuakes: () => hub!.buildSnapshot().largeQuakes,
    mapLayer: () => hub!.buildSnapshot().mapLayers?.quake,
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
  const quakeDisplay = new QuakeDisplayStore(() => daily.getRecentQuakes());
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
    // 永続の真実源も同じ判定で残す。表示だけ残すと、次の再起動でカードが消える。
    expect(h.quakeDisplay.export().largeQuakes.map((entry) => entry.key)).toEqual([EVENT_ID]);
    const again = restart(h, T51 + 6 * MIN);
    expect(again.largeQuakes()).toHaveLength(1);
    expect(again.largeQuakes()[0]).toMatchObject({ eventId: EVENT_ID, maxInt: "6-" });
  });

  // 実不具合の再発防止（2026-10-24 レビュー P2）: 表示側の sweep が先にカードを消した後の続報で、
  // 永続側だけが保持の切れたカードを更新して延ばし、display off→on で戻していた。
  it("live: 表示側の sweep が先に消した直後の VXSE61 で、永続側も延長せず display off→on で戻らない", () => {
    const h = harness(T51);
    h.deliverFixture(VXSE51, T51);
    h.deliverXml(vxse61At("05:19"), "VXSE61", T51 + 10 * MIN + 10_000);
    expect(h.largeQuakes()).toHaveLength(0);
    expect(h.quakeDisplay.export().largeQuakes).toEqual([]);
    const redisplayed = harness(T51 + 10 * MIN + 11_000, { daily: h.daily, quakeDisplay: h.quakeDisplay });
    expect(redisplayed.largeQuakes()).toHaveLength(0);
  });

  // 実不具合の再発防止（2026-10-24 レビュー P2）: 表示側の sweep が host を消した後の続報で、永続側だけが
  // 残った contribution を保持元にして host を延ばし、display off→on で地図を戻していた。
  it.each([
    { name: "nonEmergencyHost", xml: () => withIntensity(readFixture(VXSE51), "4"), type: "VXSE51", eventId: EVENT_ID },
    { name: "unknownHost", xml: () => withIntensity(readFixture(VXSE51), "未入電"), type: "VXSE51", eventId: EVENT_ID },
  ] as const)("live: 表示側の sweep が $name を消した直後の VXSE61 で、永続側も延長せず display off→on で戻らない", (c) => {
    const h = harness(T51);
    h.deliverXml(c.xml(), c.type, T51 + 10_000);
    expect(h.mapLayer()?.[c.name]).toMatchObject({ eventKey: `earthquake:${c.eventId}` });
    const followup = vxse61At("05:14").replace(`<EventID>${EVENT_ID}</EventID>`, `<EventID>${c.eventId}</EventID>`);
    h.deliverXml(followup, "VXSE61", T51 + 5 * MIN + 15_000);
    expect(h.mapLayer()?.[c.name] ?? null).toBeNull();
    expect(h.quakeDisplay.export()[c.name] ?? null).toBeNull();
    const redisplayed = harness(T51 + 5 * MIN + 16_000, { daily: h.daily, quakeDisplay: h.quakeDisplay });
    expect(redisplayed.mapLayer()).toEqual(h.mapLayer());
  });

  // 実不具合の再発防止（2026-10-24 レビュー P2）: 表示側の sweep が消した別 EventID のカードを、永続側だけが
  // 有効な参照として数え、後から来た all-unknown の unknownHost を選ばなかった。
  it("live: 表示側の sweep が別の地震のカードを消した直後の all-unknown は、両方の owner で unknownHost になる", () => {
    const h = harness(T51);
    h.deliverFixture(VXSE51, T51);
    h.deliverXml(allUnknownVxse53(), "VXSE53", T51 + 10 * MIN + 10_000);
    const unknownHost = { eventKey: `earthquake:${UNKNOWN_EVENT_ID}` };
    expect(h.mapLayer()?.unknownHost).toMatchObject(unknownHost);
    expect(h.quakeDisplay.export().unknownHost).toMatchObject(unknownHost);
    const redisplayed = harness(T51 + 10 * MIN + 11_000, { daily: h.daily, quakeDisplay: h.quakeDisplay });
    expect(redisplayed.mapLayer()).toEqual(h.mapLayer());
  });

  it("restart 保持内・地図の contributions 欠け: 明示の取消では表示と永続の両方から消える", () => {
    const before = harness(T51);
    before.deliverFixture(VXSE51, T51);
    const h = restart(before, T51 + 2 * MIN, (state) => ({ ...state, contributions: [] }));
    expect(h.largeQuakes()).toHaveLength(1);
    const cancel = readFixture("32-35_10_01_220510_VXSE51.xml")
      .replace("<EventID>20220509152315</EventID>", `<EventID>${EVENT_ID}</EventID>`)
      .replace("<ReportDateTime>2022-05-10T18:10:00+09:00", "<ReportDateTime>2009-08-11T05:14:00+09:00");
    h.deliverXml(cancel, "VXSE51", T51 + 5 * MIN);
    expect(h.largeQuakes()).toHaveLength(0);
    expect(h.quakeDisplay.export().largeQuakes).toEqual([]);
    expect(restart(h, T51 + 6 * MIN).largeQuakes()).toHaveLength(0);
  });
});
