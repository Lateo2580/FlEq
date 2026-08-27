import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupProductionStandby,
  renderProductionStandby,
} from "../../../display/frontend/src/components/__tests__/phase6b-production-render";
import type {
  DisplayBroadcastResult,
  DisplayServerMessageWithReconcile,
  DisplayTransport,
} from "../../../src/engine/display/types";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { BRIEFING_CARD_CANCEL_TTL_MS, BRIEFING_CARD_MAX_ENTRIES, BRIEFING_CARD_TTL_MS } from "../../../src/engine/display/standby-registry";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { LegacyCounterpartCorrelatorFactory } from "../../../src/engine/messages/legacy-counterpart-correlator";
import {
  LegacyCounterpartCorrelator,
} from "../../../src/engine/messages/legacy-counterpart-correlator";
import {
  createLegacyCounterpartRegistry,
  LEGACY_CORRELATION_WINDOW_AFTER_MS,
  LEGACY_CORRELATION_WINDOW_BEFORE_MS,
  LEGACY_SOURCE_HOLDBACK_MS,
  type LegacyCounterpartCorrelationKey,
} from "../../../src/engine/messages/legacy-counterpart-registry";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757,
  FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633,
  FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727,
  FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757,
  FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633,
  FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727,
  readFixture,
} from "../../helpers/mock-message";
import {
  initialState as initialFrontendState,
  reduce as reduceFrontend,
} from "../../../display/frontend/src/lib/store";

const PAIRS = [
  [FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709, FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709],
  [FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717, FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717],
  [FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727, FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727],
  [FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633, FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633],
  [FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709, FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709],
  [FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757, FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757],
] as const;

const STANDALONE_VPBS50 = [
  "82_01_01_260324_VPBS50.xml",
  "82_03_01_260324_VPBS50.xml",
  "82_01_02_250630_VPBS50.xml",
  "82_01_03_241031_VPBS50.xml",
] as const;

type Delivery = "delivered" | "noClients" | "blockedSkipped" | "byteGuardDropped";

class CapturingTransport implements DisplayTransport {
  readonly messages: DisplayServerMessageWithReconcile[] = [];

  constructor(private readonly delivery: Delivery) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  broadcast(message: DisplayServerMessageWithReconcile): DisplayBroadcastResult {
    this.messages.push(message);
    switch (this.delivery) {
      case "delivered":
        return { total: 1, blockedSkipped: 0 };
      case "noClients":
        return { total: 0, blockedSkipped: 0 };
      case "blockedSkipped":
        return { total: 1, blockedSkipped: 1 };
      case "byteGuardDropped":
        return { total: 1, blockedSkipped: 1, byteGuardDropped: true };
    }
  }

  clientCount(): number {
    return this.delivery === "noClients" ? 0 : 1;
  }
}

interface ProductionHarness {
  standby: StandbyStateStore;
  sink: ReturnType<typeof createDisplaySink>;
  handler: ReturnType<typeof createMessageHandler>;
  cliOutcomes: ProcessOutcome[];
  hub: InfoDisplayHub | null;
  transport: CapturingTransport | null;
  startHub(delivery?: Delivery): InfoDisplayHub;
}

function productionHarness(
  standby = new StandbyStateStore(),
  correlatorFactory?: LegacyCounterpartCorrelatorFactory,
): ProductionHarness {
  let hub: InfoDisplayHub | null = null;
  let transport: CapturingTransport | null = null;
  const cliOutcomes: ProcessOutcome[] = [];
  const sink = createDisplaySink({
    standby: {
      applyEvent: (event, nowMs) => standby.applyEvent(event, nowMs),
      briefingCardGeneration: () => standby.briefingCardGeneration(),
      reconcileBriefingCard: (sourceKey, event, nowMs) => standby.reconcileBriefingCard(sourceKey, event, nowMs),
      snapshotBriefingCard: () => standby.snapshotBriefingCard(),
    },
    promotions: new WeatherPromotionStore(),
    weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
    getHub: () => hub,
    now: () => Date.now(),
  });
  const harness: Partial<ProductionHarness> = { standby, sink };
  harness.startHub = (delivery: Delivery = "delivered") => {
    transport = new CapturingTransport(delivery);
    const state = new DisplayStateStore(() => standby.snapshotItems());
    hub = new InfoDisplayHub(state, {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => Date.now(),
    });
    hub.attachTransport(transport);
    harness.hub = hub;
    harness.transport = transport;
    return hub;
  };
  const handler = createMessageHandler({
    display: {
      displayOutcome: (outcome) => cliOutcomes.push(outcome),
      displayRawHeader: () => undefined,
      displayVolcano: () => undefined,
      displayVolcanoBatch: () => undefined,
      getDisplayMode: () => "normal",
      renderSummaryLine: (event) => event.title,
    },
    displaySink: sink,
    legacyCounterpartCorrelatorFactory: correlatorFactory,
  });
  harness.handler = handler;
  harness.cliOutcomes = cliOutcomes;
  return harness as ProductionHarness;
}

function messageAt(fixture: string, id: string, receivedAtMs: number) {
  return normalizeTelegramMessage({
    ...createMockWsDataMessage(fixture, { id }),
    meta: undefined,
  }, receivedAtMs).message;
}

function xmlMessageAt(xml: string, type: string, id: string, receivedAtMs: number) {
  return normalizeTelegramMessage({
    ...createMockWsDataMessageFromXml(xml, type),
    id,
    meta: undefined,
  }, receivedAtMs).message;
}

function fixtureMeta(fixture: string): { eventId: string; reportDateTime: string; reportDateTimeMs: number } {
  const message = createMockWsDataMessage(fixture);
  const eventId = message.xmlReport?.head.eventId;
  const reportDateTime = message.xmlReport?.head.reportDateTime;
  if (eventId == null || reportDateTime == null) throw new Error(`fixture metadata missing: ${fixture}`);
  const reportDateTimeMs = Date.parse(reportDateTime);
  if (!Number.isFinite(reportDateTimeMs)) throw new Error(`fixture date invalid: ${fixture}`);
  return { eventId, reportDateTime, reportDateTimeMs };
}

type VpbsPhenomenonKind = "linearRainObserved" | "linearRainPredicted" | "recordRain" | "shortSnow";

const VPBS_KIND_PRIORITY: readonly VpbsPhenomenonKind[] = [
  "linearRainObserved",
  "linearRainPredicted",
  "recordRain",
  "shortSnow",
];

function expectedVpbsSemantic(fixture: string): {
  editorialOffice: string;
  phenomenonKind: VpbsPhenomenonKind;
  semanticKey: string;
  serial: string;
} {
  const xml = readFixture(fixture);
  const editorialOffice = xml.match(/<EditorialOffice>([^<]+)<\/EditorialOffice>/)?.[1];
  const serial = xml.match(/<Serial>([^<]+)<\/Serial>/)?.[1];
  if (editorialOffice == null || serial == null) throw new Error(`VPBS semantic metadata missing: ${fixture}`);

  const kinds = new Set<VpbsPhenomenonKind>();
  for (const match of xml.matchAll(/<Condition>([^<]*)<\/Condition>/g)) {
    const condition = match[1]!.normalize("NFKC");
    if (condition.includes("線状降水帯発生")) kinds.add("linearRainObserved");
    if (condition.includes("線状降水帯直前")) kinds.add("linearRainPredicted");
    if (condition.includes("記録雨") || condition.includes("記録的短時間大雨")) kinds.add("recordRain");
    if (condition.includes("短時間大雪")) kinds.add("shortSnow");
  }
  const phenomenonKind = VPBS_KIND_PRIORITY.find((kind) => kinds.has(kind));
  if (phenomenonKind == null) throw new Error(`VPBS phenomenon kind missing: ${fixture}`);
  return {
    editorialOffice,
    phenomenonKind,
    semanticKey: `card:vpbs:semantic:${phenomenonKind}:${editorialOffice}`,
    serial,
  };
}

function cardOf(harness: ProductionHarness) {
  return harness.standby.snapshotBriefingCard();
}

function cardSemantic(card: ReturnType<typeof cardOf>) {
  if (card == null) return null;
  return {
    ...card,
    data: {
      ...card.data,
      generation: 0,
      entries: card.data.entries.map((entry) => ({ ...entry, generation: 0 })),
    },
  };
}

function frontendStateFrom(
  snapshot: ReturnType<InfoDisplayHub["buildSnapshot"]>,
  messages: readonly DisplayServerMessageWithReconcile[],
) {
  let state = initialFrontendState();
  state = reduceFrontend(state, { type: "snapshot", snapshot });
  for (const message of messages) state = reduceFrontend(state, message);
  return state;
}

async function expectCanonicalFrontend(
  state: ReturnType<typeof frontendStateFrom>,
  expectedCard: NonNullable<ReturnType<typeof cardOf>>,
  sourceEventKeys: readonly string[],
  canonicalEventKey: string | null,
): Promise<void> {
  const snapshot = state.snapshot;
  expect(snapshot).not.toBeNull();
  const frontendCard = snapshot?.standbyItems?.find((item) => item.kind === "briefing");
  expect(frontendCard).toEqual(expectedCard);
  for (const sourceEventKey of sourceEventKeys) {
    expect(state.ticker.some((event) => event.eventKey === sourceEventKey)).toBe(false);
  }
  if (canonicalEventKey == null) {
    expect(state.ticker).toHaveLength(0);
  } else {
    expect(state.ticker).toHaveLength(1);
    expect(state.ticker[0]?.eventKey).toBe(canonicalEventKey);
  }

  expect(await renderProductionStandby(snapshot!, expectedCard.data.entries[0]!)).not.toBeNull();
}

async function expectFrontendSnapshotCard(harness: ProductionHarness): Promise<void> {
  if (harness.hub == null) throw new Error("frontend snapshot requires a running hub");
  const card = cardOf(harness);
  if (card == null) throw new Error("frontend snapshot card missing");
  const frontend = frontendStateFrom(harness.hub.buildSnapshot(), []);
  expect(frontend.snapshot?.standbyItems?.find((item) => item.kind === "briefing")).toEqual(card);
  expect(await renderProductionStandby(frontend.snapshot!, card.data.entries[0]!)).not.toBeNull();
}

async function expectCanonicalCard(
  harness: ProductionHarness,
  counterpartFixture: string,
  expectedSource: "vpbs50" | "vpoa50" = "vpbs50",
  expectTicker = true,
): Promise<void> {
  const card = cardOf(harness);
  const meta = fixtureMeta(counterpartFixture);
  expect(card).not.toBeNull();
  expect(card).toMatchObject({
    kind: "briefing",
    surface: "corner-right",
    key: "briefing:active",
  });
  if (card == null) return;
  expect(card.data.entries).toHaveLength(1);
  const semantic = expectedSource === "vpbs50" ? expectedVpbsSemantic(counterpartFixture) : null;
  expect(card.data.entries[0]).toMatchObject({
    key: semantic?.semanticKey ?? `card:vpoa:${meta.eventId}`,
    source: expectedSource,
    sourceEventId: meta.eventId,
    reportDateTime: meta.reportDateTime,
    infoType: "発表",
    ...(semantic == null ? {} : semantic),
  });
  const expectedExpiry = meta.reportDateTimeMs + BRIEFING_CARD_TTL_MS;
  expect(Date.parse(card.data.entries[0]?.expiresAt ?? "")).toBe(expectedExpiry);
  expect(Date.parse(card.expiresAt ?? "")).toBe(expectedExpiry);
  if (harness.hub == null) throw new Error("canonical snapshot requires a running hub");
  const frontend = frontendStateFrom(harness.hub.buildSnapshot(), []);
  expect(frontend.snapshot?.standbyItems?.filter((item) => item.kind === "briefing")).toHaveLength(1);
  const canonicalEventKey = frontend.ticker[0]?.eventKey ?? null;
  if (expectTicker && canonicalEventKey == null) throw new Error("canonical ticker missing");
  if (!expectTicker) expect(canonicalEventKey).toBeNull();
  await expectCanonicalFrontend(frontend, card, [], canonicalEventKey);
}

function ambiguousFactory(): LegacyCounterpartCorrelatorFactory {
  const key: LegacyCounterpartCorrelationKey = {
    officeCode: "PHASE6B-OFFICE",
    areaCodes: ["PHASE6B-AREA"],
    phenomenonCodes: ["PHASE6B-PHENOM"],
    kindCodes: ["PHASE6B-KIND"],
    targetTimeMs: Date.parse("2026-08-22T08:09:00.000Z"),
  };
  const registry = createLegacyCounterpartRegistry([{
    sourceType: "VPOA50",
    status: "confirmed",
    counterpartTypes: ["VPBS50"],
    normalizeEventId: () => "PHASE6B-AMBIGUOUS",
    extractEventKey: () => key,
    windowBeforeMs: LEGACY_CORRELATION_WINDOW_BEFORE_MS,
    windowAfterMs: LEGACY_CORRELATION_WINDOW_AFTER_MS,
    holdbackMs: LEGACY_SOURCE_HOLDBACK_MS,
  }]);
  return ({ actionSink, lifecycleEventSink }) => new LegacyCounterpartCorrelator({
    registry,
    onAction: actionSink,
    onLifecycleEvent: lifecycleEventSink,
  });
}

describe("Phase 6B legacy card production-shaped gate", () => {
  afterEach(() => {
    cleanupProductionStandby();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(PAIRS)("実 XML の pair は両到着順で source card を残さず同じ canonical card へ収束する", async (sourceFixture, counterpartFixture) => {
    vi.useFakeTimers();
    const sourceMeta = fixtureMeta(sourceFixture);
    const counterpartMeta = fixtureMeta(counterpartFixture);

    const sourceFirst = productionHarness();
    sourceFirst.startHub();
    vi.setSystemTime(sourceMeta.reportDateTimeMs);
    sourceFirst.handler.notifier.setAll(true);
    const notifyLegacy = vi.spyOn(sourceFirst.handler.notifier, "notifyLegacyCounterpart");
    const notifyBriefing = vi.spyOn(sourceFirst.handler.notifier, "notifyWeatherBriefing");
    sourceFirst.handler.handler(messageAt(sourceFixture, `production:source:${sourceMeta.eventId}`, sourceMeta.reportDateTimeMs));
    expect(cardOf(sourceFirst)).toBeNull();
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(cardOf(sourceFirst)?.data.entries[0]?.source).toBe("vpoa50");
    const sourceBaseline = sourceFirst.hub?.buildSnapshot();
    if (sourceBaseline == null) throw new Error("source baseline snapshot missing");
    let sourceFrontend = frontendStateFrom(sourceBaseline, []);
    const sourceEventKey = sourceFrontend.ticker[0]?.eventKey;
    expect(sourceEventKey).toBeDefined();
    vi.advanceTimersByTime(599_999);
    sourceFirst.handler.handler(messageAt(counterpartFixture, `production:counterpart:${counterpartMeta.eventId}`, sourceMeta.reportDateTimeMs + 660_000));
    await expectCanonicalCard(sourceFirst, counterpartFixture);
    const sourceStats = sourceFirst.handler.stats.getSnapshot(Date.now());
    expect(sourceStats.foundation.legacyCardDisplayed).toBe(1);
    expect(sourceStats.foundation.legacyCardReconciled).toBe(1);
    expect(sourceStats.foundation.legacyCardEvicted).toBe(0);
    expect(sourceStats.foundation.notified).toBe(2);
    expect(notifyLegacy).toHaveBeenCalledOnce();
    expect(notifyBriefing).toHaveBeenCalledOnce();
    expect(sourceFirst.transport?.messages.filter((message) => message.type === "reconcile")).toHaveLength(1);
    expect(sourceFirst.cliOutcomes).toHaveLength(2);
    expect(sourceFirst.cliOutcomes.map((outcome) => outcome.domain)).toEqual(["legacyCounterpart", "briefing"]);
    expect(sourceFirst.cliOutcomes[1]).toMatchObject({ domain: "briefing", headType: "VPBS50" });
    const sourceCard = cardOf(sourceFirst);
    if (sourceCard == null) throw new Error("canonical source-first card missing");
    const reconcile = [...(sourceFirst.transport?.messages ?? [])]
      .reverse()
      .find((message) => message.type === "reconcile");
    if (reconcile == null || reconcile.type !== "reconcile") throw new Error("reconcile frame missing");
    sourceFrontend = reduceFrontend(sourceFrontend, reconcile);
    expect(reconcile.sourceEventKeys).toContain(sourceEventKey);
    await expectCanonicalFrontend(sourceFrontend, sourceCard, reconcile.sourceEventKeys, reconcile.event.eventKey);
    const sourceAuthoritative = frontendStateFrom(sourceFirst.hub?.buildSnapshot() ?? sourceBaseline, []);
    expect(sourceAuthoritative.snapshot?.standbyItems).toEqual(sourceFrontend.snapshot?.standbyItems);
    expect(sourceAuthoritative.ticker).toEqual(sourceFrontend.ticker);
    sourceFirst.handler.disposeLegacyCounterpartCorrelator();

    const counterpartFirst = productionHarness();
    counterpartFirst.startHub();
    vi.setSystemTime(counterpartMeta.reportDateTimeMs);
    counterpartFirst.handler.handler(messageAt(counterpartFixture, `production:counterpart-first:${counterpartMeta.eventId}`, counterpartMeta.reportDateTimeMs));
    const counterpartBaseline = counterpartFirst.hub?.buildSnapshot();
    const counterpartFrame = counterpartFirst.transport?.messages.find((message) => message.type === "event");
    if (counterpartBaseline == null || counterpartFrame == null || counterpartFrame.type !== "event") {
      throw new Error("counterpart-first canonical baseline missing");
    }
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    counterpartFirst.handler.handler(messageAt(sourceFixture, `production:source-first:${sourceMeta.eventId}`, counterpartMeta.reportDateTimeMs + LEGACY_SOURCE_HOLDBACK_MS + 1));
    await expectCanonicalCard(counterpartFirst, counterpartFixture);
    expect(counterpartFirst.transport?.messages.some((message) => message.type === "reconcile")).toBe(false);
    const counterpartStats = counterpartFirst.handler.stats.getSnapshot(Date.now());
    expect(counterpartStats.foundation.legacyCardDisplayed).toBe(1);
    expect(counterpartStats.foundation.legacyCardReconciled).toBe(0);
    expect(counterpartFirst.cliOutcomes).toHaveLength(1);
    expect(counterpartFirst.cliOutcomes[0]).toMatchObject({ domain: "briefing", headType: "VPBS50" });
    expect(cardSemantic(sourceCard)).toEqual(cardSemantic(cardOf(counterpartFirst)));
    const counterpartCard = cardOf(counterpartFirst);
    if (counterpartCard == null) throw new Error("canonical counterpart-first card missing");
    await expectCanonicalFrontend(
      frontendStateFrom(counterpartBaseline, []),
      counterpartCard,
      [],
      counterpartFrame.event.eventKey,
    );
    counterpartFirst.handler.disposeLegacyCounterpartCorrelator();
  });

  it("補助 bytes fixture は実 hub の snapshot/frame をそのまま保存したものだ", () => {
    vi.useFakeTimers();
    const pair = PAIRS[0];
    const sourceMeta = fixtureMeta(pair[0]);
    const counterpartMeta = fixtureMeta(pair[1]);
    const harness = productionHarness();
    harness.startHub();
    vi.setSystemTime(sourceMeta.reportDateTimeMs);
    harness.handler.handler(messageAt(pair[0], `production:source:${sourceMeta.eventId}`, sourceMeta.reportDateTimeMs));
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1 + 599_999);
    harness.handler.handler(messageAt(pair[1], `production:counterpart:${counterpartMeta.eventId}`, sourceMeta.reportDateTimeMs + 660_000));
    const actual = `${JSON.stringify({ snapshot: harness.hub?.buildSnapshot(), messages: harness.transport?.messages ?? [] }, null, 2)}\n`;
    const fixture = readFileSync(resolve(__dirname, "../../fixtures/phase6b-legacy-card-production.json"), "utf8");
    expect(actual).toBe(fixture);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it.each(STANDALONE_VPBS50)("standalone の実 VPBS50 は pair の有無によらず一つの active card になる: %s", async (fixture) => {
    vi.useFakeTimers();
    const meta = fixtureMeta(fixture);
    const harness = productionHarness();
    harness.startHub();
    vi.setSystemTime(meta.reportDateTimeMs);
    harness.handler.handler(messageAt(fixture, `production:standalone:${meta.eventId}`, meta.reportDateTimeMs));
    await expectCanonicalCard(harness, fixture);
    expect(harness.handler.stats.getSnapshot(Date.now()).foundation.legacyCardDisplayed).toBe(1);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it("Holdback 内 suppression は source card を作らず、実 VPBS50 card／ticker／通知を一回だけ通す", async () => {
    vi.useFakeTimers();
    const sourceFixture = PAIRS[0][0];
    const counterpartFixture = PAIRS[0][1];
    const sourceMeta = fixtureMeta(sourceFixture);
    const counterpartMeta = fixtureMeta(counterpartFixture);
    const harness = productionHarness();
    harness.startHub();
    vi.setSystemTime(sourceMeta.reportDateTimeMs);
    harness.handler.notifier.setAll(true);
    const notifyBriefing = vi.spyOn(harness.handler.notifier, "notifyWeatherBriefing");
    harness.handler.handler(messageAt(sourceFixture, "production:holdback:source", sourceMeta.reportDateTimeMs));
    harness.handler.handler(messageAt(counterpartFixture, "production:holdback:counterpart", counterpartMeta.reportDateTimeMs));
    await expectCanonicalCard(harness, counterpartFixture);
    expect(cardOf(harness)?.data.entries.some((entry) => entry.source === "vpoa50")).toBe(false);
    expect(harness.transport?.messages.filter((message) => message.type === "event")).toHaveLength(1);
    expect(harness.cliOutcomes).toHaveLength(1);
    expect(harness.cliOutcomes[0]).toMatchObject({ domain: "briefing", headType: "VPBS50" });
    expect(notifyBriefing).toHaveBeenCalledOnce();
    expect(harness.handler.summaryTracker.getSnapshot(Date.now())).toMatchObject({
      totalReceived: 1,
      totalMatched: 1,
      byDomain: { briefing: 1 },
    });
    const stats = harness.handler.stats.getSnapshot(Date.now());
    expect(stats.foundation.legacyMatchedSuppressed).toBe(1);
    expect(stats.foundation.legacyCardDisplayed).toBe(1);
    expect(stats.foundation.legacyCardReconciled).toBe(0);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it("unrelated／ambiguous は fail-open し、source／candidateを隠れた canonicalへ合成しない", async () => {
    vi.useFakeTimers();
    const first = PAIRS[0];
    const unrelatedSource = productionHarness();
    unrelatedSource.startHub();
    const sourceMeta = fixtureMeta(first[0]);
    const unrelatedCounterpart = PAIRS[4][1];
    vi.setSystemTime(sourceMeta.reportDateTimeMs);
    unrelatedSource.handler.handler(messageAt(first[0], "production:unrelated:source", sourceMeta.reportDateTimeMs));
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    unrelatedSource.handler.handler(messageAt(unrelatedCounterpart, "production:unrelated:counterpart", sourceMeta.reportDateTimeMs + LEGACY_SOURCE_HOLDBACK_MS + 1));
    expect(cardOf(unrelatedSource)?.data.entries.map((entry) => entry.source)).toEqual(["vpbs50", "vpoa50"]);
    expect(unrelatedSource.handler.stats.getSnapshot(Date.now()).foundation.legacyCardReconciled).toBe(0);
    await expectFrontendSnapshotCard(unrelatedSource);
    unrelatedSource.handler.disposeLegacyCounterpartCorrelator();

    const ambiguous = productionHarness(new StandbyStateStore(), ambiguousFactory());
    ambiguous.startHub();
    const expected = PAIRS[0];
    const expectedMeta = fixtureMeta(expected[0]);
    vi.setSystemTime(expectedMeta.reportDateTimeMs);
    ambiguous.handler.handler(messageAt(expected[1], "production:ambiguous:first", expectedMeta.reportDateTimeMs));
    const secondXml = readFixture(expected[1]).replace(/<EventID>[^<]*<\/EventID>/, "<EventID>KAMBIGUOUS-2</EventID>");
    ambiguous.handler.handler(xmlMessageAt(secondXml, "VPBS50", "production:ambiguous:second", expectedMeta.reportDateTimeMs));
    ambiguous.handler.handler(messageAt(expected[0], "production:ambiguous:source", expectedMeta.reportDateTimeMs));
    expect(cardOf(ambiguous)?.data.entries.some((entry) => entry.source === "vpoa50")).toBe(true);
    expect(cardOf(ambiguous)?.data.entries.some((entry) => entry.source === "vpbs50")).toBe(true);
    expect(ambiguous.handler.stats.getSnapshot(Date.now()).foundation.legacyCardReconciled).toBe(0);
    await expectFrontendSnapshotCard(ambiguous);
    ambiguous.handler.disposeLegacyCounterpartCorrelator();
  });

  it("実 VPBS50 の訂正／取消は同一 card entry を置換し、取消 TTL 境界で消える", async () => {
    vi.useFakeTimers();
    const normalXml = readFixture("synthetic_VPBS50_multi.xml");
    const normalMessage = createMockWsDataMessage("synthetic_VPBS50_multi.xml");
    const reportDateTime = normalMessage.xmlReport?.head.reportDateTime;
    const eventId = normalMessage.xmlReport?.head.eventId;
    if (reportDateTime == null || eventId == null) throw new Error("synthetic fixture metadata missing");
    const reportDateTimeMs = Date.parse(reportDateTime);
    const correctionXml = normalXml
      .replace(/<InfoType>発表<\/InfoType>/, "<InfoType>訂正</InfoType>")
      .replace(/<Serial>6<\/Serial>/, "<Serial>7</Serial>");
    const cancelXml = normalXml
      .replace(/<InfoType>発表<\/InfoType>/, "<InfoType>取消</InfoType>")
      .replace(/<Serial>6<\/Serial>/, "<Serial>8</Serial>");
    const harness = productionHarness();
    harness.startHub();
    vi.setSystemTime(reportDateTimeMs + 1);
    harness.handler.handler(messageAt("synthetic_VPBS50_multi.xml", "production:revision:normal", reportDateTimeMs + 1));
    const semantic = expectedVpbsSemantic("synthetic_VPBS50_multi.xml");
    expect(cardOf(harness)?.data.entries[0]).toMatchObject({
      ...semantic,
      key: semantic.semanticKey,
      sourceEventId: eventId,
      infoType: "発表",
    });
    const firstGeneration = cardOf(harness)?.data.generation;
    harness.handler.handler(xmlMessageAt(correctionXml, "VPBS50", "production:revision:correction", reportDateTimeMs + 2));
    expect(cardOf(harness)?.data.entries[0]).toMatchObject({
      ...semantic,
      key: semantic.semanticKey,
      sourceEventId: eventId,
      serial: "7",
      infoType: "訂正",
    });
    expect(cardOf(harness)?.data.generation).toBeGreaterThan(firstGeneration ?? 0);
    harness.handler.handler(xmlMessageAt(cancelXml, "VPBS50", "production:revision:cancel", reportDateTimeMs + 3));
    expect(cardOf(harness)?.data.entries[0]).toMatchObject({
      ...semantic,
      key: semantic.semanticKey,
      sourceEventId: eventId,
      serial: "8",
      infoType: "取消",
      frameLevel: "cancel",
    });
    await expectFrontendSnapshotCard(harness);
    vi.setSystemTime(reportDateTimeMs + BRIEFING_CARD_CANCEL_TTL_MS);
    expect(harness.standby.sweep(Date.now()).viewChanged).toBe(true);
    expect(cardOf(harness)).toBeNull();
    expect(normalXml).toContain(eventId);
    expect(harness.handler.stats.getSnapshot(Date.now()).foundation.legacyCardDisplayed).toBeGreaterThanOrEqual(3);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it("standalone card は独立 120分 TTL の直前を保持し、境界で expiry する", async () => {
    vi.useFakeTimers();
    const fixture = STANDALONE_VPBS50[0];
    const meta = fixtureMeta(fixture);
    const harness = productionHarness();
    harness.startHub();
    vi.setSystemTime(meta.reportDateTimeMs);
    harness.handler.handler(messageAt(fixture, "production:expiry:normal", meta.reportDateTimeMs));
    vi.setSystemTime(meta.reportDateTimeMs + BRIEFING_CARD_TTL_MS - 1);
    expect(harness.standby.sweep(Date.now()).viewChanged).toBe(false);
    expect(cardOf(harness)).not.toBeNull();
    await expectFrontendSnapshotCard(harness);
    vi.setSystemTime(meta.reportDateTimeMs + BRIEFING_CARD_TTL_MS);
    expect(harness.standby.sweep(Date.now()).viewChanged).toBe(true);
    expect(cardOf(harness)).toBeNull();
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it("receipt 不在の display off late reconcile は card-only mutation 後の on snapshot で収束する", async () => {
    vi.useFakeTimers();
    const sourceFixture = PAIRS[0][0];
    const counterpartFixture = PAIRS[0][1];
    const sourceMeta = fixtureMeta(sourceFixture);
    const counterpartMeta = fixtureMeta(counterpartFixture);
    const harness = productionHarness();
    vi.setSystemTime(sourceMeta.reportDateTimeMs);
    harness.handler.handler(messageAt(sourceFixture, "production:off:source", sourceMeta.reportDateTimeMs));
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(cardOf(harness)?.data.entries[0]?.source).toBe("vpoa50");
    vi.advanceTimersByTime(599_999);
    harness.handler.handler(messageAt(counterpartFixture, "production:off:counterpart", sourceMeta.reportDateTimeMs + 660_000));
    expectCanonicalCardWithoutHub(harness, counterpartFixture);
    const stats = harness.handler.stats.getSnapshot(Date.now());
    expect(stats.foundation.legacyCardDisplayed).toBe(1);
    expect(stats.foundation.legacyCardReconciled).toBe(1);
    expect(stats.foundation.legacyLateCounterpartReconciled).toBe(0);
    harness.startHub();
    await expectCanonicalCard(harness, counterpartFixture, "vpbs50", false);
    expect(counterpartMeta.eventId).not.toBe(sourceMeta.eventId);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });

  it("display off/on と process restart は card state をそれぞれ保持／空から fail-open する", async () => {
    vi.useFakeTimers();
    const fixture = STANDALONE_VPBS50[0];
    const meta = fixtureMeta(fixture);
    const standby = new StandbyStateStore();
    const old = productionHarness(standby);
    vi.setSystemTime(meta.reportDateTimeMs);
    old.handler.handler(messageAt(fixture, "production:restart:old", meta.reportDateTimeMs));
    expect(cardOf(old)).not.toBeNull();
    old.handler.disposeLegacyCounterpartCorrelator();

    const displayOn = productionHarness(standby);
    displayOn.startHub();
    await expectCanonicalCard(displayOn, fixture, "vpbs50", false);
    displayOn.handler.disposeLegacyCounterpartCorrelator();

    const restarted = productionHarness();
    restarted.startHub();
    expect(cardOf(restarted)).toBeNull();
    restarted.handler.handler(messageAt(fixture, "production:restart:new", meta.reportDateTimeMs));
    await expectCanonicalCard(restarted, fixture);
    restarted.handler.disposeLegacyCounterpartCorrelator();
  });

  it.each(["delivered", "noClients", "blockedSkipped", "byteGuardDropped"] as const)(
    "card metric は delivery=%s の成否によらず applied generation 後に一回だけ加算する",
    async (delivery) => {
      vi.useFakeTimers();
      const pair = PAIRS[0];
      const sourceMeta = fixtureMeta(pair[0]);
      const counterpartMeta = fixtureMeta(pair[1]);
      const harness = productionHarness();
      harness.startHub(delivery);
      vi.setSystemTime(sourceMeta.reportDateTimeMs);
      harness.handler.handler(messageAt(pair[0], `production:delivery:source:${delivery}`, sourceMeta.reportDateTimeMs));
      vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1 + 599_999);
      harness.handler.handler(messageAt(pair[1], `production:delivery:counterpart:${delivery}`, sourceMeta.reportDateTimeMs + 660_000));
      harness.handler.handler(messageAt(pair[1], `production:delivery:replay:${delivery}`, counterpartMeta.reportDateTimeMs + 660_000));
      await expectCanonicalCard(harness, pair[1]);
      const snapshot = harness.handler.stats.getSnapshot(Date.now());
      expect(snapshot.foundation.legacyCardDisplayed).toBe(1);
      expect(snapshot.foundation.legacyCardReconciled).toBe(1);
      expect(snapshot.foundation.legacyCardEvicted).toBe(0);
      expect(harness.transport?.messages.filter((message) => message.type === "reconcile")).toHaveLength(1);
      harness.handler.disposeLegacyCounterpartCorrelator();
    },
  );

  it("実 parser／processor／sink の容量 mutation は legacyCardEvicted を generation 単位で記録する", async () => {
    vi.useFakeTimers();
    const fixture = "synthetic_VPBS50_multi.xml";
    const meta = fixtureMeta(fixture);
    const baseXml = readFixture(fixture);
    const harness = productionHarness();
    harness.startHub("noClients");
    vi.setSystemTime(meta.reportDateTimeMs);
    for (let index = 0; index < BRIEFING_CARD_MAX_ENTRIES + 1; index += 1) {
      const eventId = `PRODUCTION-CAP-${String(index).padStart(3, "0")}`;
      const editorialOffice = `容量試験${String(index).padStart(3, "0")}`;
      const xml = baseXml
        .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
        .replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${editorialOffice}</EditorialOffice>`);
      harness.handler.handler(xmlMessageAt(xml, "VPBS50", `production:capacity:${index}`, meta.reportDateTimeMs + index));
    }
    const card = cardOf(harness);
    expect(card?.data.entries).toHaveLength(BRIEFING_CARD_MAX_ENTRIES);
    expect(new Set(card?.data.entries.map((entry) => entry.key)).size).toBe(BRIEFING_CARD_MAX_ENTRIES);
    expect(card?.data.entries.some((entry) => entry.sourceEventId === "PRODUCTION-CAP-000")).toBe(false);
    expect(card?.data.entries.some((entry) => entry.key === "card:vpbs:semantic:recordRain:容量試験000")).toBe(false);
    await expectFrontendSnapshotCard(harness);
    const stats = harness.handler.stats.getSnapshot(Date.now());
    expect(stats.foundation.legacyCardEvicted).toBe(1);
    expect(stats.foundationByHeadType.get("VPBS50")?.legacyCardEvicted).toBe(1);
    harness.handler.disposeLegacyCounterpartCorrelator();
  });
});

function expectCanonicalCardWithoutHub(harness: ProductionHarness, counterpartFixture: string): void {
  const card = cardOf(harness);
  const meta = fixtureMeta(counterpartFixture);
  const semantic = expectedVpbsSemantic(counterpartFixture);
  expect(card?.data.entries).toHaveLength(1);
  expect(card?.data.entries[0]).toMatchObject({
    ...semantic,
    key: semantic.semanticKey,
    source: "vpbs50",
    sourceEventId: meta.eventId,
  });
  expect(Date.parse(card?.data.entries[0]?.expiresAt ?? "")).toBe(meta.reportDateTimeMs + BRIEFING_CARD_TTL_MS);
}
