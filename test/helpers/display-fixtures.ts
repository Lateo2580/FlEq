// display protocol の型付きフィクスチャビルダー。
//
// DisplayEventDtoV1 / DisplayStateSnapshotV1 は必須フィールドが増え続けるため、テスト側で
// object literal を直接書くと protocol にフィールドが足されるたび全テストが型エラーになる。
// 既定値を土台に敷き、テストが主張したい値だけ override で上書きする形に寄せる。

import { DISPLAY_PROTOCOL_VERSION } from "../../src/engine/display/types";
import type { DisplayEventDtoV1, DisplayStateSnapshotV1 } from "../../src/engine/display/types";

/** アサート対象にならない詰め物を既定値で埋めた DisplayEventDtoV1 */
export function displayEventDto(over: Partial<DisplayEventDtoV1> = {}): DisplayEventDtoV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: 0,
    id: "m0",
    eventKey: "k0",
    groupKey: null,
    domain: "weather",
    type: "VPWW55",
    infoType: "発表",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    title: "テスト",
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "normal",
    isCancellation: false,
    summary: { text: "t", role: "muted" },
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    ...over,
  };
}

/** アサート対象にならない詰め物を既定値で埋めた DisplayStateSnapshotV1 */
export function displaySnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    generatedAt: "2026-07-06T21:00:00+09:00",
    seq: 0,
    activeEews: [],
    tsunami: null,
    largeQuakes: [],
    weatherAlerts: [],
    recentQuakes: [],
    latestQuake: null,
    stats: null,
    severityTier: "calm",
    connection: { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null },
    recentTicker: [],
    ...over,
  };
}
