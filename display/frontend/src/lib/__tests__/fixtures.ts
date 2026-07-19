import type {
  DisplayConnectionStateV1,
  DisplayEventDtoV1,
  DisplayStateSnapshotV1,
} from "../protocol";
import type { DisplayClientState } from "../store";

function connection(): DisplayConnectionStateV1 {
  return { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null };
}

export function baseSnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: 1,
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
    connection: connection(),
    recentTicker: [],
    ...over,
  };
}

type StateOnlyOverrides = Partial<
  Pick<DisplayClientState, "ticker" | "sseConnected" | "lastSeq" | "lastEventSeq" | "seqGapDetected" | "tickerGeneration">
>;

export function baseState(
  over: Partial<DisplayStateSnapshotV1> & StateOnlyOverrides = {},
): DisplayClientState {
  const { ticker, sseConnected, lastSeq, lastEventSeq, seqGapDetected, tickerGeneration, ...snapshotOver } = over;
  return {
    snapshot: baseSnapshot(snapshotOver),
    ticker: ticker ?? [],
    sseConnected: sseConnected ?? true,
    lastSeq: lastSeq ?? 0,
    lastEventSeq: lastEventSeq ?? 0,
    seqGapDetected: seqGapDetected ?? false,
    tickerGeneration: tickerGeneration ?? 0,
  };
}

export function tickerEvent(
  over: Partial<DisplayEventDtoV1> & { id: string },
): DisplayEventDtoV1 {
  return {
    version: 1,
    seq: 0,
    eventKey: `k-${over.id}`,
    groupKey: null,
    domain: "weather",
    type: "VPWW53",
    infoType: "発表",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    title: "t",
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "info",
    isCancellation: false,
    summary: { text: "t", role: "info" },
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    ...over,
  };
}
