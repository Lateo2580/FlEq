import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradeSnapshotToBudget, degradeSyncedStateToBudget } from "../../../src/engine/display/http-server";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { InProcessSseDisplayTransport } from "../../../src/engine/display/transport";
import { DISPLAY_PROTOCOL_VERSION } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { displayEventDto, displaySnapshot } from "../../helpers/display-fixtures";
import type {
  DisplayEventDtoV1,
  DisplayIntensityGroupV1,
  DisplayLargeQuakeStateV1,
  DisplayQuakeIntensityMapEventV1,
  DisplayRecentQuakeV1,
  DisplayServerMessage,
  DisplayStateSnapshotV1,
  DisplayWeatherAlertV1,
} from "../../../src/engine/display/types";

const log = { info: (): void => {}, warn: (): void => {} };

// fetch は URL 正規化 (dot-segment collapsing) を行うため、生の "/../" を含むリクエストラインが
// サーバに届く保証がない。防御分岐に確実に到達させるため node:net で生の HTTP リクエストを送る。
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket();
    let raw = "";
    socket.setEncoding("utf8");
    socket.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("end", () => {
      const [head, ...bodyParts] = raw.split("\r\n\r\n");
      const statusLine = head?.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.\d (\d{3})/.exec(statusLine);
      resolvePromise({ status: match != null ? Number(match[1]) : 0, body: bodyParts.join("\r\n\r\n") });
    });
    socket.on("error", reject);
  });
}

const baseSnapshot = displaySnapshot;

function eewPresentationEvent(): PresentationEvent {
  return {
    id: "eew-E1-1",
    classification: "eew.warning",
    domain: "eew",
    type: "VXSE45",
    infoType: "発表",
    title: "緊急地震速報（警報）",
    headline: null,
    reportDateTime: "2026-07-06T21:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "critical",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    eventId: "E1",
    serial: "1",
    isWarning: true,
    isFinal: false,
    hypocenterName: "能登半島沖",
    forecastMaxInt: "5強",
    forecastMaxIntRank: 6,
    magnitude: "6.5",
  } as PresentationEvent;
}

/** JSON 化後に MAX_SNAPSHOT_BYTES (256KB) を超える recentTicker を生成する */
function hugeRecentTicker(): DisplayEventDtoV1[] {
  const longTitle = "A".repeat(500);
  return Array.from({ length: 1000 }, (_, i) =>
    displayEventDto({ seq: i, id: `m${i}`, eventKey: `k${i}`, title: longTitle }),
  );
}

/** 縮退で latestQuake.intensityGroups が capIntensityGroups で 8 地域まで切られるほど巨大な地域リスト
 *  (単体で約 450KB、ticker 20 件縮退後もなお上限超過となるサイズを狙う) */
function hugeIntensityGroups(): DisplayIntensityGroupV1[] {
  return [
    {
      intensity: "5弱", rank: 50,
      areas: Array.from({ length: 150 }, (_, i) => `テスト地域${i}`.repeat(500)),
      omittedAreaCount: 0,
    },
  ];
}

/** 縮退で weatherAlerts[].items[].shownAreas が 6 地域まで切られるほど巨大な地域リスト (単体で約 450KB) */
function hugeWeatherAlerts(): DisplayWeatherAlertV1[] {
  return [
    {
      source: "vpww56", label: "大雨警報", role: "weatherWarning", totalAreas: 150,
      items: [
        {
          kind: "大雨", displaySeverity: "warning", rank: "warning",
          shownAreas: Array.from({ length: 150 }, (_, i) => `気象地域${i}`.repeat(500)),
          omittedAreaCount: 0,
        },
      ],
      updatedAt: "2026-07-06T21:00:00+09:00",
    },
  ];
}

/** SSE の次の 1 メッセージ ("\n\n" 終端) を、複数 TCP チャンクに跨っても取りこぼさず読む */
async function readNextSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<DisplayServerMessage> {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    if (buf.includes("\n\n")) break;
  }
  const dataLine = buf.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine == null) throw new Error("data 行を受信できなかった: " + buf.slice(0, 200));
  return JSON.parse(dataLine.slice("data: ".length)) as DisplayServerMessage;
}

/** SSE の最初の snapshot を読み、接続を閉じる。 */
async function readFirstSseMessage(res: Response): Promise<{ type: "snapshot"; snapshot: DisplayStateSnapshotV1 }> {
  const reader = res.body!.getReader();
  const message = await readNextSseMessage(reader);
  await reader.cancel();
  if (message.type !== "snapshot") throw new Error(`snapshot ではない初期メッセージ: ${message.type}`);
  return message;
}

/** 通常サイズの recentQuakes (縮退で温存されるべき軽量な地震履歴)。件数を引数で指定する */
function normalRecentQuakes(count: number): DisplayRecentQuakeV1[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `rq${i}`, reportDateTime: "2026-07-06T21:00:00+09:00", originTime: "2026-07-06T21:00:00+09:00",
    hypocenterName: `震源${i}`, magnitude: "M4.0", maxInt: "3", maxIntRank: 30,
    depth: "10km", tsunamiWarning: false,
  }));
}

/** tickerBody が巨大な recentTicker 8 件 (全件が段1 の先頭 N=8 件枠に入るため本文間引きで落ちず、
 *  recentTicker を空にする段まで縮退が進むケース用。約 480KB) */
function hugeBodiedTicker(): DisplayEventDtoV1[] {
  return Array.from({ length: 8 }, (_, i) =>
    displayEventDto({
      seq: i, id: `hb${i}`, eventKey: `hbk${i}`, domain: "weatherExplanation", type: "VPZJ51",
      title: "解説", tickerBody: "本".repeat(20000),
    }),
  );
}

/** intensityGroups が巨大な largeQuakes 1 件 (約 450KB)。この肥大源が recentQuakes より先に
 *  刈られる (空配列化される) ことを検証するための縮退契約テスト用 */
function hugeGroupLargeQuakes(): DisplayLargeQuakeStateV1[] {
  return [{
    kind: "largeQuake" as const, eventId: "lg1", originTime: "2026-07-06T21:00:00+09:00",
    hypocenterName: "テスト沖", magnitude: "M7.0", maxInt: "6強", maxIntRank: 60,
    intensityGroups: [{
      intensity: "6強", rank: 60,
      areas: Array.from({ length: 150 }, (_, i) => `震度域${i}`.repeat(500)),
      omittedAreaCount: 0,
    }],
    reportDateTime: "2026-07-06T21:00:00+09:00", depth: "10km", maxLgInt: null, tsunamiWarning: false,
    updatedAtMs: 0,
  }];
}

/** intensityGroups を空にしても (縮退第7段) なお 256KB を超え続ける largeQuakes (全段縮退が尽きるケース用) */
function hugeLargeQuakes(): DisplayLargeQuakeStateV1[] {
  return Array.from({ length: 2000 }, (_, i) => ({
    kind: "largeQuake" as const,
    eventId: `ev${i}`,
    originTime: "2026-07-06T21:00:00+09:00",
    hypocenterName: `震源地${i}`.repeat(50),
    magnitude: "M7.0",
    maxInt: "6強",
    maxIntRank: 60,
    intensityGroups: [],
    reportDateTime: "2026-07-06T21:00:00+09:00",
    depth: "10km",
    maxLgInt: null,
    tsunamiWarning: false,
    updatedAtMs: 0,
  }));
}

function mapEvent(
  eventKey: string,
  over: Partial<DisplayQuakeIntensityMapEventV1> = {},
): DisplayQuakeIntensityMapEventV1 {
  return {
    eventKey,
    eventId: eventKey,
    sourceType: "VXSE53",
    revision: { reportTimeMs: 1, serial: "1" },
    reportDateTime: "2026-07-06T21:00:00+09:00",
    originTime: null,
    hypocenterName: "test",
    depth: "10km",
    magnitude: "5.0",
    maxInt: "4",
    maxIntRank: 4,
    tsunamiWarning: false,
    intensityGroups: [],
    localAreas: [{ code: "440", rank: 4 }],
    updatedAtMs: 1,
    ...over,
  };
}

describe("degradeSnapshotToBudget (純関数、初回 snapshot と定期 state 配信の共通安全弁)", () => {
  it("縮退段 2 は 20 件を超えても active EEW の最新 DTO を残す", () => {
    const ticker = hugeRecentTicker().slice(0, 25).map((dto, index) =>
      index === 21 ? { ...dto, id: "active-eew", groupKey: "eew:E1", domain: "eew" as const } : dto,
    );
    const full = baseSnapshot({
      recentTicker: ticker,
      activeEews: [{ eventId: "E1" } as never],
      latestQuake: { ...hugeGroupLargeQuakes()[0]!, kind: "recentQuake" } as never,
    });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.snapshot.recentTicker.some((dto) => dto.id === "active-eew")).toBe(true);
  });

  it("上限内に収まる snapshot は level 0 (縮退なし) でそのまま返す", () => {
    const full = baseSnapshot();
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBe(0);
    expect(result!.snapshot).toBe(full);
  });

  it("巨大 recentTicker は縮退段 1〜2 で 20 件以下に切り詰められる", () => {
    const full = baseSnapshot({ recentTicker: hugeRecentTicker() });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBeGreaterThan(0);
    expect(result!.snapshot.recentTicker.length).toBeLessThanOrEqual(20);
  });

  it("msgType 'state' でも同じラダーで縮退する", () => {
    const full = baseSnapshot({ recentTicker: hugeRecentTicker() });
    const result = degradeSnapshotToBudget(full, "state");
    expect(result).not.toBeNull();
    expect(result!.snapshot.recentTicker.length).toBeLessThanOrEqual(20);
  });

  it("recentTicker が既に空でも巨大 largeQuakes で全段を尽くすと null (fail-loud)", () => {
    const full = baseSnapshot({ largeQuakes: hugeLargeQuakes() });
    const result = degradeSnapshotToBudget(full, "state");
    expect(result).toBeNull();
  });

  it("本文付き recentTicker は新段 (段1) で先頭 8 件だけ tickerBody を残し件数は保つ", () => {
    // 40 件 × 中程度の本文。full は超過するが、本文を先頭 8 件以外 null 化するだけで収まる
    const bodied = Array.from({ length: 40 }, (_, i) =>
      displayEventDto({
        seq: i, id: `b${i}`, eventKey: `bk${i}`, domain: "weatherExplanation", type: "VPZJ51",
        title: "解説", tickerBody: "本".repeat(5000),
      }),
    );
    const full = baseSnapshot({ recentTicker: bodied });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBe(1);                          // 本文間引き段で収束
    expect(result!.snapshot.recentTicker.length).toBe(40);  // 件数は削られない
    expect(result!.snapshot.recentTicker[0]!.tickerBody).not.toBeNull();
    expect(result!.snapshot.recentTicker[7]!.tickerBody).not.toBeNull();
    expect(result!.snapshot.recentTicker[8]!.tickerBody).toBeNull();
  });

  it("本文間引き段では tickerEmphasis も tickerBody と一緒に落とす (本文なしの index span は無意味、backlog §3)", () => {
    const bodied = Array.from({ length: 40 }, (_, i) =>
      displayEventDto({
        seq: i, id: `e${i}`, eventKey: `ek${i}`, domain: "weatherExplanation", type: "VPZJ51",
        title: "解説", tickerBody: "970hPa " + "本".repeat(5000),
        tickerEmphasis: [{ start: 0, end: 6 }],
      }),
    );
    const full = baseSnapshot({ recentTicker: bodied });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBe(1);
    // 先頭 8 件は本文・強調とも残る
    expect(result!.snapshot.recentTicker[0]!.tickerBody).not.toBeNull();
    expect(result!.snapshot.recentTicker[0]!.tickerEmphasis).not.toBeNull();
    // 9 件目以降は本文も強調も落ちる
    expect(result!.snapshot.recentTicker[8]!.tickerBody).toBeNull();
    expect(result!.snapshot.recentTicker[8]!.tickerEmphasis).toBeNull();
  });

  it("active largeQuake の文字情報は縮退せず、単独で上限超過なら fail-loud", () => {
    const full = baseSnapshot({ largeQuakes: hugeGroupLargeQuakes(), recentQuakes: normalRecentQuakes(5) });
    const result = degradeSnapshotToBudget(full, "state");
    expect(result).toBeNull();
    expect(full.largeQuakes[0]!.intensityGroups).toEqual(hugeGroupLargeQuakes()[0]!.intensityGroups);
  });

  it("未参照の地図 event だけを原子的に落とし、active host の地図は保護する", () => {
    const active = mapEvent("earthquake:active");
    const stale = mapEvent("earthquake:stale", {
      localAreas: Array.from({ length: 30_000 }, (_, i) => ({
        code: `stale-${i}-${"x".repeat(20)}`,
        rank: 4,
      })),
    });
    const full = baseSnapshot({
      mapLayers: {
        quake: {
          events: [active, stale],
          nonEmergencyHost: { eventKey: active.eventKey, expiresAtMs: 10 },
        },
      },
    });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBeGreaterThan(0);
    expect(result!.snapshot.mapLayers?.quake?.events).toEqual([active]);
  });

  it("active largeQuake と revision 一致する地図を未参照地図の巻き添えにしない", () => {
    const active = mapEvent("earthquake:large");
    const stale = mapEvent("earthquake:stale", {
      localAreas: Array.from({ length: 30_000 }, (_, i) => ({
        code: `stale-${i}-${"x".repeat(20)}`,
        rank: 4,
      })),
    });
    const large = {
      ...hugeGroupLargeQuakes()[0]!,
      intensityGroups: [],
      mapEventKey: active.eventKey,
      mapSourceType: active.sourceType,
      mapRevision: active.revision,
    };
    const full = baseSnapshot({
      largeQuakes: [large],
      mapLayers: { quake: { events: [stale, active], nonEmergencyHost: null } },
    });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.snapshot.largeQuakes).toEqual([large]);
    expect(result!.snapshot.mapLayers?.quake?.events).toEqual([active]);
  });

  it("active host の地図が単独で上限超過なら部分切捨てせず fail-loud", () => {
    const active = mapEvent("earthquake:active", {
      localAreas: Array.from({ length: 30_000 }, (_, i) => ({
        code: `active-${i}-${"x".repeat(20)}`,
        rank: 4,
      })),
    });
    const full = baseSnapshot({
      mapLayers: {
        quake: {
          events: [active],
          nonEmergencyHost: { eventKey: active.eventKey, expiresAtMs: 10 },
        },
      },
    });
    expect(degradeSnapshotToBudget(full, "snapshot")).toBeNull();
    expect(full.mapLayers?.quake?.events[0]?.localAreas).toHaveLength(30_000);
  });

  it("stats.sparklineData はどの縮退段を通っても改変されない (待機画面スパークライン保護、Fix11B)", () => {
    const sparklineData = Array.from({ length: 30 }, (_, i) => i);
    const stats = { sparklineData, totalReceived: 0, todayQuakeCount: 0, todayMaxInt: null, todayMaxIntRank: null };

    // recentTicker を空にする段まで進むケース (旧・段5相当)
    const tickerHeavy = baseSnapshot({
      recentTicker: hugeBodiedTicker(), recentQuakes: normalRecentQuakes(3), stats,
    });
    const tickerResult = degradeSnapshotToBudget(tickerHeavy, "snapshot");
    expect(tickerResult).not.toBeNull();
    expect(tickerResult!.snapshot.recentTicker).toEqual([]);
    expect(tickerResult!.snapshot.stats?.sparklineData).toEqual(sparklineData);

    // weatherAlerts を縮退する段でも維持する
    const weatherHeavy = baseSnapshot({ weatherAlerts: hugeWeatherAlerts(), stats });
    const weatherResult = degradeSnapshotToBudget(weatherHeavy, "state");
    expect(weatherResult).not.toBeNull();
    expect(weatherResult!.snapshot.weatherAlerts[0]!.items[0]!.shownAreas.length).toBeLessThanOrEqual(6);
    expect(weatherResult!.snapshot.stats?.sparklineData).toEqual(sparklineData);

    // recentQuakes が最終段 (空) まで進むケース (段10)
    const heavyRecentQuakesForSparkline: DisplayRecentQuakeV1[] = Array.from({ length: 5 }, (_, i) => ({
      eventId: `sq${i}`, reportDateTime: "2026-07-06T21:00:00+09:00", originTime: "2026-07-06T21:00:00+09:00",
      hypocenterName: `巨大震源${i}`.repeat(20000), magnitude: "M7.0", maxInt: "5弱", maxIntRank: 50,
      depth: "10km", tsunamiWarning: false,
    }));
    const recentQuakesHeavy = baseSnapshot({ recentQuakes: heavyRecentQuakesForSparkline, stats });
    const finalResult = degradeSnapshotToBudget(recentQuakesHeavy, "state");
    expect(finalResult).not.toBeNull();
    expect(finalResult!.snapshot.recentQuakes).toEqual([]);
    expect(finalResult!.snapshot.stats?.sparklineData).toEqual(sparklineData);
  });

  it("recentQuakes[].intensityGroups は件数削減より先に刈られる (各地震度 → 詳細空化 → 件数の順)", () => {
    // 肥大は recentQuakes[].intensityGroups のみ (各地の震度)。cap-to-8 でも収まらないほど巨大にし、
    // 詳細を空配列化する段 (段8) で収束させる。5 件のカード骨子は温存されるべき
    const groupHeavy: DisplayRecentQuakeV1[] = Array.from({ length: 5 }, (_, i) => ({
      eventId: `gq${i}`, reportDateTime: "2026-07-06T21:00:00+09:00", originTime: "2026-07-06T21:00:00+09:00",
      hypocenterName: `震源${i}`, magnitude: "M5.0", maxInt: "3", maxIntRank: 3,
      depth: "10km", tsunamiWarning: false,
      intensityGroups: [{
        intensity: "3", rank: 3,
        areas: Array.from({ length: 200 }, (_, j) => `震度域${j}`.repeat(6000)),
        omittedAreaCount: 0,
      }],
    }));
    const full = baseSnapshot({ recentQuakes: groupHeavy });
    const result = degradeSnapshotToBudget(full, "state");
    expect(result).not.toBeNull();
    expect(result!.snapshot.recentQuakes).toHaveLength(5);                 // カード件数は温存される
    for (const q of result!.snapshot.recentQuakes) {
      expect(q.intensityGroups).toEqual([]);                              // 詳細 (各地震度) だけ諦める
    }
  });

  it("recentQuakes は他の肥大源を刈り尽くした最後にのみ縮退される (5→3→空の順)", () => {
    // recentQuakes 自体が巨大なケース。他の肥大源が無いので最終段 (recentQuakes 空) まで進む
    const heavyRecentQuakes: DisplayRecentQuakeV1[] = Array.from({ length: 5 }, (_, i) => ({
      eventId: `hq${i}`, reportDateTime: "2026-07-06T21:00:00+09:00", originTime: "2026-07-06T21:00:00+09:00",
      hypocenterName: `巨大震源${i}`.repeat(20000), magnitude: "M7.0", maxInt: "5弱", maxIntRank: 50,
      depth: "10km", tsunamiWarning: false,
    }));
    const full = baseSnapshot({ recentQuakes: heavyRecentQuakes });
    const result = degradeSnapshotToBudget(full, "state");
    expect(result).not.toBeNull();
    // 肥大源が hypocenterName (intensityGroups 段では刈れない) なので、intensityGroups 刈り (段7-8)
    // を空振りしたのち 5→3 (段9)・空 (段10) まで到達する
    expect(result!.level).toBe(10);                      // 最終段 (recentQuakes 空) まで到達する
    expect(result!.snapshot.recentQuakes).toEqual([]);   // 最終段で空になる
  });

  it("32KB 本文 × 8 件の最悪ケースは本文間引きで落とし切れず後続ラダー (件数削減) へ落ちる", () => {
    // 8 件すべて先頭 8 件枠に入るため段1 では本文が残り超過継続 → recentTicker を空にする段まで進む
    const worst = Array.from({ length: 8 }, (_, i) =>
      displayEventDto({
        seq: i, id: `w${i}`, eventKey: `wk${i}`, domain: "weatherExplanation", type: "VPZJ51",
        title: "解説", tickerBody: "本".repeat(32 * 1024),
      }),
    );
    const full = baseSnapshot({ recentTicker: worst });
    const result = degradeSnapshotToBudget(full, "snapshot");
    expect(result).not.toBeNull();
    expect(result!.level).toBeGreaterThan(1);              // 段1 では収まらない
    expect(result!.snapshot.recentTicker.length).toBe(0);  // 後続ラダーで件数ごと落ちる
  });
});

describe("degradeSyncedStateToBudget (tickerSynced 専用ラダー、recentTicker は絶対に削らない、レビュー R2 Important 対応)", () => {
  it("上限内に収まる snapshot は level 0 (縮退なし) でそのまま返す", () => {
    const full = baseSnapshot({ recentTicker: [], tickerSynced: true });
    const result = degradeSyncedStateToBudget(full);
    expect(result).not.toBeNull();
    expect(result!.level).toBe(0);
    expect(result!.snapshot).toBe(full);
  });

  it("他フィールド (weatherAlerts) が巨大でも recentTicker はそのまま保ち、他フィールドだけ縮退する", () => {
    const ticker = hugeRecentTicker().slice(0, 3); // 小さめの recentTicker (縮退不要な件数)
    const full = baseSnapshot({ recentTicker: ticker, weatherAlerts: hugeWeatherAlerts(), tickerSynced: true });
    const result = degradeSyncedStateToBudget(full);
    expect(result).not.toBeNull();
    expect(result!.level).toBeGreaterThan(0);
    expect(result!.snapshot.recentTicker.length).toBe(3); // recentTicker は 1 件も削られない
    expect(result!.snapshot.recentTicker).toEqual(ticker); // 中身も無加工
    expect(result!.snapshot.weatherAlerts[0]?.items[0]?.shownAreas.length).toBeLessThanOrEqual(6); // 他フィールドは縮退
  });

  it("recentTicker 自体が巨大で他フィールド縮退では収まらない場合は null (呼び出し元が recentTicker を諦めるラダーへフォールバックする契約)", () => {
    const full = baseSnapshot({ recentTicker: hugeRecentTicker(), tickerSynced: true });
    const result = degradeSyncedStateToBudget(full);
    expect(result).toBeNull();
  });

  it("stats.sparklineData はどの縮退段を通っても改変されない (待機画面スパークライン保護、Fix11B、PreserveTicker ラダー側)", () => {
    const sparklineData = Array.from({ length: 30 }, (_, i) => i);
    const stats = { sparklineData, totalReceived: 0, todayQuakeCount: 0, todayMaxInt: null, todayMaxIntRank: null };
    // weatherAlerts を縮退する段でも recentTicker と stats は変えない
    const full = baseSnapshot({
      recentTicker: hugeRecentTicker().slice(0, 3),
      weatherAlerts: hugeWeatherAlerts(),
      stats,
      tickerSynced: true,
    });
    const result = degradeSyncedStateToBudget(full);
    expect(result).not.toBeNull();
    expect(result!.snapshot.recentTicker.length).toBe(3); // recentTicker は縮退対象外 (不変)
    expect(result!.snapshot.weatherAlerts[0]!.items[0]!.shownAreas.length).toBeLessThanOrEqual(6);
    expect(result!.snapshot.stats?.sparklineData).toEqual(sparklineData);
  });
});

describe("InProcessSseDisplayTransport", () => {
  let distDir: string;
  let transport: InProcessSseDisplayTransport | null = null;

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), "fleq-display-test-"));
    writeFileSync(join(distDir, "index.html"), "<html>hello</html>");
  });

  afterEach(async () => {
    if (transport != null) {
      await transport.stop();
      transport = null;
    }
    rmSync(distDir, { recursive: true, force: true });
  });

  async function startTransport(
    getSnapshot: () => DisplayStateSnapshotV1 = () => baseSnapshot(),
  ): Promise<InProcessSseDisplayTransport> {
    const t = new InProcessSseDisplayTransport({ host: "127.0.0.1", port: 0, distDir, getSnapshot, log });
    await t.start();
    transport = t;
    return t;
  }

  it("① GET /healthz → 200 JSON {ok:true, clients:0}", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, clients: 0 });
  });

  it("GET /tips は知識系 Tips のデッキを JSON で返す", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/tips`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { tips: Array<{ id: string; text: string; hazards: string[] }> };
    expect(Array.isArray(body.tips)).toBe(true);
    expect(body.tips.length).toBeGreaterThan(0);
    for (const tip of body.tips) {
      expect(typeof tip.id).toBe("string");
      expect(typeof tip.text).toBe("string");
      expect(tip.text.startsWith("Tip: ")).toBe(false);
      expect(Array.isArray(tip.hazards)).toBe(true);
    }
  });

  it("GET /tips の context は standby/quakeMap/emergency を受け、未知値は 400", async () => {
    const t = await startTransport();
    const quakeMap = await fetch(`http://127.0.0.1:${t.port()}/tips?context=quakeMap`);
    expect(quakeMap.status).toBe(200);
    const quakeMapBody = (await quakeMap.json()) as { tips: Array<{ id: string }> };
    expect(quakeMapBody.tips.length).toBeGreaterThan(0);
    const emergency = await fetch(`http://127.0.0.1:${t.port()}/tips?context=emergency`);
    expect(emergency.status).toBe(200);
    const body = (await emergency.json()) as { tips: Array<{ id: string }> };
    expect(body.tips).toHaveLength(10);
    expect(new Set(body.tips.map((tip) => tip.id)).size).toBe(10);
    const invalid = await fetch(`http://127.0.0.1:${t.port()}/tips?context=invalid`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "context must be standby, quakeMap, or emergency",
    });
  });

  it("② GET / → index.html の中身", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>hello</html>");
  });

  it("③ パストラバーサル (素の ../・URL エンコード・prefix 衝突) はすべて 404", async () => {
    const evilDir = `${distDir}-evil`;
    mkdirSync(evilDir);
    writeFileSync(join(evilDir, "secret.txt"), "secret");
    const t = await startTransport();
    const port = t.port();
    // fetch は URL 正規化で "/../" を消してしまい防御分岐に届かないため raw socket で送る
    const plain = await rawGet(port, "/../package.json");
    const prefixCollision = await rawGet(port, `/../${basename(evilDir)}/secret.txt`);
    expect(plain.status).toBe(404);
    expect(plain.body).not.toContain("dmdata");
    expect(prefixCollision.status).toBe(404);
    expect(prefixCollision.body).not.toContain("secret");
    // %2f は percent-encoding のため fetch でも正規化されず防御分岐に届く
    const encoded = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
    expect(encoded.status).toBe(404);
  });

  it("④ GET /events → text/event-stream で最初のチャンクに event: snapshot", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    await reader.cancel();
  });

  it("SSE クライアント数の増減を通知し、0→1 は初期 snapshot より先に届く", async () => {
    const clientCounts: number[] = [];
    let countSeenBySnapshot: number | null = null;
    const t = new InProcessSseDisplayTransport({
      host: "127.0.0.1",
      port: 0,
      distDir,
      getSnapshot: () => {
        countSeenBySnapshot = clientCounts.at(-1) ?? null;
        return baseSnapshot();
      },
      log,
      onClientCountChange: (count) => {
        clientCounts.push(count);
      },
    });
    await t.start();
    transport = t;
    const url = `http://127.0.0.1:${t.port()}/events`;

    const first = await fetch(url);
    const firstReader = first.body!.getReader();
    await firstReader.read();
    expect(clientCounts).toEqual([1]);
    expect(countSeenBySnapshot).toBe(1);

    const second = await fetch(url);
    const secondReader = second.body!.getReader();
    await secondReader.read();
    expect(clientCounts).toEqual([1, 2]);

    await firstReader.cancel();
    await secondReader.cancel();
    await vi.waitFor(async () => {
      const health = await fetch(`http://127.0.0.1:${t.port()}/healthz`);
      const body = (await health.json()) as { clients: number };
      expect(body.clients).toBe(0);
    });
    expect(clientCounts.at(-1)).toBe(0);

    const reconnected = await fetch(url);
    const reconnectedReader = reconnected.body!.getReader();
    await reconnectedReader.read();
    expect(clientCounts.at(-1)).toBe(1);
    await reconnectedReader.cancel();
  });

  it("切断中に更新された mapLayers を再接続時の初期 snapshot 一発で復元する", async () => {
    const active = mapEvent("earthquake:reconnect");
    let current = baseSnapshot();
    let snapshotCalls = 0;
    const t = await startTransport(() => {
      snapshotCalls += 1;
      return current;
    });
    const url = `http://127.0.0.1:${t.port()}/events`;

    const first = await fetch(url);
    const initial = await readFirstSseMessage(first);
    expect(initial.snapshot.mapLayers).toBeUndefined();

    current = baseSnapshot({
      mapLayers: {
        quake: {
          events: [active],
          nonEmergencyHost: { eventKey: active.eventKey, expiresAtMs: 10_000 },
        },
      },
    });

    const reconnected = await fetch(url);
    const restored = await readFirstSseMessage(reconnected);
    expect(snapshotCalls).toBe(2);
    expect(restored.snapshot.mapLayers?.quake).toEqual({
      events: [active],
      nonEmergencyHost: { eventKey: active.eventKey, expiresAtMs: 10_000 },
    });
  });

  it("EEW は hub→SSE event と再接続 snapshot のどちらでもテロップに積まれない", async () => {
    const store = new DisplayStateStore();
    const hub = new InfoDisplayHub(store, {
      summarize: () => "EEW要約",
      weatherAlerts: () => [],
      now: () => Date.parse("2026-07-06T21:00:00+09:00"),
    });
    const t = await startTransport(() => hub.buildSnapshot());
    hub.attachTransport(t);

    const live = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const liveReader = live.body!.getReader();
    expect((await readNextSseMessage(liveReader)).type).toBe("snapshot");

    hub.ingest(eewPresentationEvent());
    const eventMessage = await readNextSseMessage(liveReader);
    expect(eventMessage.type).toBe("event");
    if (eventMessage.type !== "event") throw new Error("EEW event が SSE 配信されなかった");
    expect(eventMessage.event.tickerSuppressed).toBe(true);
    await liveReader.cancel();

    const reconnected = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const snapshotMessage = await readFirstSseMessage(reconnected);
    expect(snapshotMessage.snapshot.recentTicker).toEqual([]);
    expect(snapshotMessage.snapshot.activeEews).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventId: "E1" })]),
    );
    hub.stop();
  });

  it("⑤ distDir に index.html が無いと start() が reject", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "fleq-display-empty-"));
    const t = new InProcessSseDisplayTransport({
      host: "127.0.0.1", port: 0, distDir: emptyDir, getSnapshot: () => baseSnapshot(), log,
    });
    await expect(t.start()).rejects.toThrow(/display\/dist が見つかりません/);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("⑥ stop() 後は接続不可", async () => {
    const t = await startTransport();
    const port = t.port();
    await t.stop();
    transport = null;
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("⑦ 巨大 snapshot は接続時送信で recentTicker が縮退する (8 段縮退の第 1〜2 段)", async () => {
    const t = await startTransport(() => baseSnapshot({ recentTicker: hugeRecentTicker() }));
    const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as { snapshot: DisplayStateSnapshotV1 };
    expect(payload.snapshot.recentTicker.length).toBeLessThanOrEqual(20);
    expect(payload.snapshot.recentTicker.length).toBeLessThan(hugeRecentTicker().length);
    await reader.cancel();
  });

  it("⑦-b 巨大 recentTicker + 巨大 weatherAlerts + 巨大 latestQuake.intensityGroups でも "
    + "いずれかの縮退段が送られ、地域リストが上限内に切り詰められ omittedAreaCount が加算される", async () => {
    const huge = hugeWeatherAlerts();
    const hugeGroups = hugeIntensityGroups();
    const t = await startTransport(() => baseSnapshot({
      recentTicker: hugeRecentTicker(),
      weatherAlerts: huge,
      latestQuake: {
        eventId: "ev1", headline: null, originTime: "2026-07-06T21:00:00+09:00",
        hypocenterName: "テスト沖", depth: "10km", magnitude: "M7.0",
        maxInt: "5弱", maxIntRank: 50, tsunamiWarning: false,
        intensityGroups: hugeGroups, reportDateTime: "2026-07-06T21:00:00+09:00",
        updatedAtMs: 0,
      },
    }));
    const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const payload = await readFirstSseMessage(res);

    const originalAreaCount = hugeGroups[0]!.areas.length;
    const sentGroup = payload.snapshot.latestQuake?.intensityGroups[0];
    expect(sentGroup).toBeDefined();
    expect(sentGroup!.areas.length).toBeLessThanOrEqual(8);
    expect(sentGroup!.omittedAreaCount).toBe(originalAreaCount - sentGroup!.areas.length);

    const originalWeatherAreaCount = huge[0]!.items[0]!.shownAreas.length;
    const sentItem = payload.snapshot.weatherAlerts[0]?.items[0];
    expect(sentItem).toBeDefined();
    expect(sentItem!.shownAreas.length).toBeLessThanOrEqual(6);
    expect(sentItem!.omittedAreaCount).toBe(originalWeatherAreaCount - sentItem!.shownAreas.length);
  });

  it("⑦-e 震度6弱以上 (rank 7〜9) の intensityGroups は縮退時も areas を省略しない (目視ゲート第3波 Fix8)", async () => {
    const strongGroup: DisplayIntensityGroupV1 = {
      intensity: "6弱", rank: 7,
      areas: Array.from({ length: 30 }, (_, i) => `強震域${i}`.repeat(500)),
      omittedAreaCount: 0,
    };
    const weakGroup: DisplayIntensityGroupV1 = {
      intensity: "5弱", rank: 5,
      areas: Array.from({ length: 30 }, (_, i) => `弱震域${i}`.repeat(500)),
      omittedAreaCount: 0,
    };
    const t = await startTransport(() => baseSnapshot({
      recentTicker: hugeRecentTicker(),
      latestQuake: {
        eventId: "ev1", headline: null, originTime: "2026-07-06T21:00:00+09:00",
        hypocenterName: "テスト沖", depth: "10km", magnitude: "M7.0",
        maxInt: "6弱", maxIntRank: 7, tsunamiWarning: false,
        intensityGroups: [strongGroup, weakGroup], reportDateTime: "2026-07-06T21:00:00+09:00",
        updatedAtMs: 0,
      },
    }));
    const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const payload = await readFirstSseMessage(res);

    const groups = payload.snapshot.latestQuake?.intensityGroups ?? [];
    const sentStrong = groups.find((g) => g.rank === 7);
    const sentWeak = groups.find((g) => g.rank === 5);
    expect(sentStrong).toBeDefined();
    expect(sentStrong!.areas.length).toBe(30);
    expect(sentStrong!.omittedAreaCount).toBe(0);
    expect(sentWeak).toBeDefined();
    expect(sentWeak!.areas.length).toBeLessThanOrEqual(8);
    expect(sentWeak!.omittedAreaCount).toBeGreaterThan(0);
  });

  it("⑦-c すべての縮退段を尽くしても上限超過なら接続を切断し警告ログを出す", async () => {
    let warnCalled = false;
    const customLog = { info: (): void => {}, warn: (): void => { warnCalled = true; } };
    const t = new InProcessSseDisplayTransport({
      host: "127.0.0.1", port: 0, distDir,
      getSnapshot: () => baseSnapshot({ largeQuakes: hugeLargeQuakes() }),
      log: customLog,
    });
    await t.start();
    transport = t;
    let dataReceived = "";
    try {
      const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        dataReceived += new TextDecoder().decode(value);
      }
    } catch {
      // res.destroy() によって fetch 自体や読み取り中に接続断エラーになる場合もある (期待どおり)
    }
    expect(dataReceived).not.toContain("event: snapshot");
    expect(warnCalled).toBe(true);
  });

  it("⑦-d recentTicker を空にする段でも sparklineData は改変されず、"
    + "軽量な recentQuakes はこの段では温存される (縮退順序の設計原則、Fix11B でスパークライン保護)", async () => {
    const sparklineData = Array.from({ length: 30 }, (_, i) => i); // 古い順: 0..29 (末尾が最新)
    const t = await startTransport(() => baseSnapshot({
      recentTicker: hugeBodiedTicker(),          // ~480KB。recentTicker を空にする段まで進む
      recentQuakes: normalRecentQuakes(3),        // 軽量。この段では刈られない
      stats: { sparklineData, totalReceived: 0, todayQuakeCount: 0, todayMaxInt: null, todayMaxIntRank: null },
    }));
    const res = await fetch(`http://127.0.0.1:${t.port()}/events`);
    const payload = await readFirstSseMessage(res);

    // recentTicker 空の段 (recentQuakes より前に肥大源を刈り切る段) まで進んだ証跡。
    // sparklineData は軽量なため縮退ラダーの対象外 (Fix11B) で、30 点まるごと温存される
    expect(payload.snapshot.recentTicker).toEqual([]);
    expect(payload.snapshot.stats?.sparklineData).toEqual(sparklineData);
    expect(payload.snapshot.recentQuakes).toHaveLength(3); // 軽量な地震履歴は温存される
  });

  it("distDir 直下でない拡張子ファイルも content-type 判定で配信できる", async () => {
    writeFileSync(join(distDir, "app.js"), "console.log(1)");
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("存在しないパスは index.html にフォールバックせず 404 (SPA ルーティング不使用)", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it("decodeURIComponent が throw する不正な %エンコードは 400", async () => {
    const t = await startTransport();
    const res = await fetch(`http://127.0.0.1:${t.port()}/%`);
    expect(res.status).toBe(400);
  });
});
