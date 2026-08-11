import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import {
  LEGACY_COUNTERPART_BODY_EXTRACTORS,
  LEGACY_COUNTERPART_SOURCE_TYPES,
} from "../../../src/dmdata/legacy-counterpart-parser";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartCorrelatorFactory,
} from "../../../src/engine/messages/legacy-counterpart-correlator";
import {
  LEGACY_SOURCE_HOLDBACK_MS,
  PRODUCTION_LEGACY_COUNTERPART_REGISTRY,
} from "../../../src/engine/messages/legacy-counterpart-registry";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { classifyMessage } from "../../../src/engine/messages/route-catalog";
import {
  PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES,
} from "../../../src/engine/presentation/processors/process-legacy-counterpart";
import type { PresentationEvent, ProcessOutcome } from "../../../src/engine/presentation/types";
import type { WsDataMessage } from "../../../src/types";
import { createDisplayAdapter } from "../../../src/ui/display-adapter";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { notifyMock } from "../../setup";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE51_SHINDO,
  readFixture,
} from "../../helpers/mock-message";
import { LEGACY_COUNTERPART_CHARACTERIZATION } from "./phase0-manifest";

const SOURCE_TYPES = ["VPOA50", "VPNO50", "VXWW50"] as const;
const BASE_MS = Date.parse("2026-08-11T00:00:00.000Z");
const BASE_XML = readFixture(FIXTURE_VXSE51_SHINDO);

function makeMessage(options: {
  type: string;
  id: string;
  eventId?: string | null;
  reportDateTime?: string;
  receivedAtMs?: number;
}): WsDataMessage {
  const base = createMockWsDataMessageFromXml(BASE_XML, options.type);
  if (base.xmlReport == null) throw new Error("fixture envelope is missing");
  const receivedAtMs = options.receivedAtMs ?? BASE_MS;
  const reportDateTime = options.reportDateTime ?? new Date(receivedAtMs).toISOString();
  return normalizeTelegramMessage({
    ...base,
    id: options.id,
    classification: "classification.phase6b-synthetic-envelope",
    head: {
      ...base.head,
      type: options.type,
      time: new Date(receivedAtMs).toISOString(),
    },
    xmlReport: {
      ...base.xmlReport,
      control: {
        ...base.xmlReport.control,
        title: "旧形式防災情報",
        publishingOffice: "統合試験官署",
      },
      head: {
        ...base.xmlReport.head,
        title: `${options.type} 統合試験情報`,
        reportDateTime,
        eventId: options.eventId === undefined ? `${options.type}-EVENT` : options.eventId,
        serial: "1",
        infoType: "発表",
        headline: "旧形式情報の統合試験見出し",
      },
    },
    meta: undefined,
  }, receivedAtMs).message;
}

function withNewMessageId(message: WsDataMessage, id: string): WsDataMessage {
  return normalizeTelegramMessage(
    { ...message, id, meta: undefined },
    message.meta?.receivedAtMs ?? BASE_MS,
  ).message;
}

function productionFactory(options: {
  sourceCapacity?: number;
  capture?: (correlator: LegacyCounterpartCorrelator) => void;
} = {}): LegacyCounterpartCorrelatorFactory {
  return ({ actionSink, lifecycleEventSink }) => {
    const correlator = new LegacyCounterpartCorrelator({
      registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY,
      sourceCapacity: options.sourceCapacity,
      onAction: actionSink,
      onLifecycleEvent: lifecycleEventSink,
    });
    options.capture?.(correlator);
    return correlator;
  };
}

function summaryText(event: PresentationEvent): string {
  return buildSummaryTokens(event, buildSummaryModel(event))
    .map((token) => token.text)
    .join(" ");
}

describe("Phase 6B unit 5: skeleton integration gate", () => {
  beforeEach(() => {
    notifyMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Phase 0 characterizationとproduction counterpart/severity/body registryを未確認の三typeへ一対一固定する", () => {
    expect(LEGACY_COUNTERPART_SOURCE_TYPES).toEqual(SOURCE_TYPES);
    expect(LEGACY_COUNTERPART_CHARACTERIZATION.map((entry) => entry.sourceType)).toEqual(SOURCE_TYPES);
    expect(PRODUCTION_LEGACY_COUNTERPART_REGISTRY.rules.map((rule) => rule.sourceType)).toEqual(SOURCE_TYPES);
    expect(PRODUCTION_LEGACY_COUNTERPART_REGISTRY.activeCounterpartTypes.size).toBe(0);
    expect(PRODUCTION_LEGACY_COUNTERPART_REGISTRY.ruleByCounterpartType.size).toBe(0);
    expect(PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES.size).toBe(0);
    expect(LEGACY_COUNTERPART_BODY_EXTRACTORS).toHaveLength(0);

    for (const type of SOURCE_TYPES) {
      const characterization = LEGACY_COUNTERPART_CHARACTERIZATION.find((entry) => entry.sourceType === type);
      const rule = PRODUCTION_LEGACY_COUNTERPART_REGISTRY.ruleBySourceType.get(type);
      expect(characterization).toMatchObject({
        status: "unconfirmed",
        counterpartTypes: [],
        sourceFixtures: [],
        counterpartFixtures: [],
      });
      expect(rule).toMatchObject({ status: "unconfirmed", counterpartTypes: [] });
      const message = makeMessage({ type, id: `${type}:registry` });
      expect(rule?.extractEventKey(message.meta!, null)).toBeNull();
    }
    expect(JSON.stringify(PRODUCTION_LEGACY_COUNTERPART_REGISTRY.rules)).not.toContain("SYNTH");
  });

  it.each(SOURCE_TYPES)("%s は60秒Holdback後だけcounterpartRuleUnconfirmedでqualifier付きfail-open表示される", (type) => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    const ingested: PresentationEvent[] = [];
    const processed: ProcessOutcome[] = [];
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
    const sink: DisplayIngestSink = { ingest: (event) => ingested.push(event) };
    const result = createMessageHandler({
      display: createDisplayAdapter(),
      displaySink: sink,
      outcomeTaps: [(outcome) => processed.push(outcome as ProcessOutcome)],
    });

    result.handler(makeMessage({ type, id: `${type}:e2e` }));
    let snapshot = result.stats.getSnapshot(BASE_MS);
    expect(processed).toHaveLength(0);
    expect(ingested).toHaveLength(0);
    expect(snapshot.foundation.received).toBe(1);
    expect(snapshot.countByType.get(type)).toBe(1);
    expect(snapshot.foundation.presented).toBe(0);

    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS);
    expect(ingested).toHaveLength(0);
    vi.advanceTimersByTime(1);

    snapshot = result.stats.getSnapshot(BASE_MS + LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(processed).toHaveLength(1);
    expect(ingested).toHaveLength(1);
    const event = ingested[0];
    expect(event).toMatchObject({
      domain: "legacyCounterpart",
      type,
      legacyReason: "counterpartRuleUnconfirmed",
      legacySeverity: "unknown",
    });
    expect(summaryText(event)).toContain("対応電文未確認");
    expect(projectDisplayEvent(event, summaryText(event))).toMatchObject({
      tickerCategory: "旧形式防災情報",
    });
    expect(logs.join("\n")).toContain("対応電文未確認");
    expect(snapshot.foundation.received).toBe(1);
    expect(snapshot.countByType.get(type)).toBe(1);
    expect(snapshot.foundation.legacySourceArrivedFirst).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedDisplayed).toBe(1);
    expect(snapshot.foundation.legacySeverityUnknownNotificationSuppressed).toBe(1);
    expect(snapshot.foundation.legacyMatchedSuppressed).toBe(0);
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(0);
    expect(snapshot.foundation.notified).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("foundation gateはtransport/semantic duplicateとinvalid dateを相関・表示より前で拒否する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    const outcomes: ProcessOutcome[] = [];
    const result = createMessageHandler({
      outcomeTaps: [(outcome) => outcomes.push(outcome as ProcessOutcome)],
    });
    const first = makeMessage({ type: "VPOA50", id: "gate:first", eventId: "GATE" });
    result.handler(first);
    result.handler(first);
    result.handler(withNewMessageId(first, "gate:semantic-replay"));

    const invalid = makeMessage({
      type: "VPNO50",
      id: "gate:invalid-date",
      eventId: "INVALID",
      reportDateTime: "not-a-date",
    });
    result.handler(invalid);
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);

    const snapshot = result.stats.getSnapshot(BASE_MS + LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(outcomes).toHaveLength(1);
    expect(snapshot.foundation.received).toBe(4);
    expect(snapshot.foundation.transportDuplicate).toBe(1);
    expect(snapshot.foundation.semanticDuplicate).toBe(1);
    expect(snapshot.foundation.invalidDateDiagnosed).toBe(1);
    expect(snapshot.countByType.get("VPOA50")).toBe(1);
    expect(snapshot.countByType.has("VPNO50")).toBe(false);
  });

  it("production capacity超過だけはHoldbackを省略して即時fail-openする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    const outcomes: ProcessOutcome[] = [];
    let correlator: LegacyCounterpartCorrelator | undefined;
    const result = createMessageHandler({
      outcomeTaps: [(outcome) => outcomes.push(outcome as ProcessOutcome)],
      legacyCounterpartCorrelatorFactory: productionFactory({
        sourceCapacity: 1,
        capture: (instance) => { correlator = instance; },
      }),
    });
    result.handler(makeMessage({ type: "VPOA50", id: "capacity:held", eventId: "HELD" }));
    expect(outcomes).toHaveLength(0);
    result.handler(makeMessage({ type: "VPNO50", id: "capacity:bypass", eventId: "BYPASS" }));

    const snapshot = result.stats.getSnapshot(BASE_MS);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      domain: "legacyCounterpart",
      headType: "VPNO50",
      reason: "counterpartRuleUnconfirmed",
    });
    expect(correlator?.snapshot()).toMatchObject({ sourceCount: 1, tombstoneCount: 0 });
    expect(snapshot.foundation.legacyUnmatchedDisplayed).toBe(1);
    expect(snapshot.countByType.get("VPOA50")).toBe(1);
    expect(snapshot.countByType.get("VPNO50")).toBe(1);
  });

  it("production unmatched sourceは11分超過でexpired tombstoneへ一回だけ移る", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    let correlator: LegacyCounterpartCorrelator | undefined;
    const result = createMessageHandler({
      legacyCounterpartCorrelatorFactory: productionFactory({
        capture: (instance) => { correlator = instance; },
      }),
    });
    result.handler(makeMessage({ type: "VXWW50", id: "expiry:source", eventId: "EXPIRY" }));
    vi.advanceTimersByTime(11 * 60_000);
    expect(correlator?.snapshot()).toMatchObject({ sourceCount: 1, tombstoneCount: 0 });
    vi.advanceTimersByTime(1);

    const snapshot = result.stats.getSnapshot(BASE_MS + 11 * 60_000 + 1);
    expect(correlator?.snapshot()).toMatchObject({ sourceCount: 0, tombstoneCount: 1 });
    expect(snapshot.foundation.legacyCorrelationExpired).toBe(1);
    expect(snapshot.foundation.legacyLateCounterpartExpired).toBe(0);
    expect(snapshot.foundation.legacyLateCounterpartReconciled).toBe(0);
  });

  it("dispose後は旧timerがemitせずrestart後は空cacheから同じsourceをfail-openする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    const oldOutcomes: ProcessOutcome[] = [];
    const oldHandler = createMessageHandler({
      outcomeTaps: [(outcome) => oldOutcomes.push(outcome as ProcessOutcome)],
    });
    oldHandler.handler(makeMessage({ type: "VPOA50", id: "restart:old", eventId: "RESTART" }));
    oldHandler.disposeLegacyCounterpartCorrelator();
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(oldOutcomes).toHaveLength(0);

    const restartedOutcomes: ProcessOutcome[] = [];
    const restarted = createMessageHandler({
      outcomeTaps: [(outcome) => restartedOutcomes.push(outcome as ProcessOutcome)],
    });
    restarted.handler(makeMessage({
      type: "VPOA50",
      id: "restart:new",
      eventId: "RESTART",
      receivedAtMs: BASE_MS + LEGACY_SOURCE_HOLDBACK_MS + 1,
    }));
    vi.advanceTimersByTime(LEGACY_SOURCE_HOLDBACK_MS + 1);
    expect(restartedOutcomes).toHaveLength(1);
    expect(restartedOutcomes[0]).toMatchObject({ reason: "counterpartRuleUnconfirmed" });
  });

  it("三type以外の既存ignore方針はhandler統合後も不変", () => {
    expect(SOURCE_TYPES.map((type) => classifyMessage("unexpected", type)))
      .toEqual(["legacyCounterpart", "legacyCounterpart", "legacyCounterpart"]);
    expect(classifyMessage("unexpected", "VPWW53")).toBe("ignore");
    expect(classifyMessage("unexpected", "VPWW54")).toBe("ignore");

    const result = createMessageHandler();
    result.handler(makeMessage({ type: "VPWW53", id: "ignore:vpww53" }));
    result.handler(makeMessage({ type: "VPWW54", id: "ignore:vpww54" }));
    const snapshot = result.stats.getSnapshot(BASE_MS);
    expect(snapshot.foundation.received).toBe(0);
    expect(snapshot.countByType.size).toBe(0);
  });
});
