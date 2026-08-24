/// <reference lib="dom" />

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationEvent, ProcessOutcome } from "../../../src/engine/presentation/types";
import { classifyMessage } from "../../../src/engine/messages/route-catalog";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import {
  processLegacyCounterpart,
  PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES,
} from "../../../src/engine/presentation/processors/process-legacy-counterpart";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { tickerTtlMs } from "../../../src/engine/display/ticker-ttl";
import type {
  DisplayBroadcastResult,
  DisplayIngestSink,
  DisplayServerMessageWithReconcile,
  DisplayTransport,
} from "../../../src/engine/display/types";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import {
  LEGACY_COUNTERPART_BODY_EXTRACTORS,
  parseLegacyCounterpart,
} from "../../../src/dmdata/legacy-counterpart-parser";
import { displayLegacyCounterpartInfo } from "../../../src/ui/legacy-counterpart-formatter";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartAction,
  type LegacyCounterpartCorrelatorFactory,
} from "../../../src/engine/messages/legacy-counterpart-correlator";
import {
  createLegacyCounterpartRegistry,
  LEGACY_CORRELATION_WINDOW_AFTER_MS,
  LEGACY_CORRELATION_WINDOW_BEFORE_MS,
  LEGACY_SOURCE_HOLDBACK_MS,
  type LegacyCounterpartCorrelationKey,
} from "../../../src/engine/messages/legacy-counterpart-registry";
import { playSound } from "../../../src/engine/notification/sound-player";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import {
  initialState as initialFrontendState,
  reduce as reduceFrontend,
} from "../../../display/frontend/src/lib/store";
import {
  createSchedulerState,
  reconcileScheduler,
  toTickerJob,
} from "../../../display/frontend/src/lib/ticker-schedule";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  createMockWsDataMessage,
  encodeXml,
  FIXTURE_VXSE51_SHINDO,
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
import { notifyMock } from "../../setup";

const SOURCE_TYPES = ["VPOA50", "VPNO50", "VXWW50"] as const;
const BASE_REPORT_DATE_TIME = "2026-08-11T09:00:00+09:00";
const BASE_XML = readFixture(FIXTURE_VXSE51_SHINDO);
const CORPUS_ROOT = resolve(__dirname, "../../../corpus-6b-latter");

interface Phase6bProvenance {
  fixture: string;
  corpusPath: string;
  dmdataMessageId: string;
}

/** 実 fixture の持込 provenance。corpus が無い checkout でも tracked fixture は実行できる。 */
const PHASE6B_PROVENANCE: readonly Phase6bProvenance[] = [
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_37d14748959ccdd394cff1e4a3cc22e4cb0a9bf33015efe6ef49ac78393750cdd25794143c0e2040fed17407419740ec.xml",
    dmdataMessageId: "37d14748959ccdd394cff1e4a3cc22e4cb0a9bf33015efe6ef49ac78393750cdd25794143c0e2040fed17407419740ec",
  },
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_5743e0e4179eaf243736aba8d4fc3a08dd5a298488152d046cc2d746163eb62a6d6ad23c731540596c4332b9c3a38e7e.xml",
    dmdataMessageId: "5743e0e4179eaf243736aba8d4fc3a08dd5a298488152d046cc2d746163eb62a6d6ad23c731540596c4332b9c3a38e7e",
  },
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_7908258df5858dfec3e8435f042796f80849841ee8662c72c7b7f1355e65bdab32287d1dfa6f4ddee3e37b3a3a4ca787.xml",
    dmdataMessageId: "7908258df5858dfec3e8435f042796f80849841ee8662c72c7b7f1355e65bdab32287d1dfa6f4ddee3e37b3a3a4ca787",
  },
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_7bf15d9922457c1447d2746fbc696831f3c8ebef19126a35b921605b06d35aa2e5c93ac7f8ea8d21dee1f34b862363d1.xml",
    dmdataMessageId: "7bf15d9922457c1447d2746fbc696831f3c8ebef19126a35b921605b06d35aa2e5c93ac7f8ea8d21dee1f34b862363d1",
  },
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_81490a2628ef8c6ced5e6e7e76188669cf0bad128a604967fd26f33af4ff5bb6715dfeecc2e17e60ad23d0168f5c7fe0.xml",
    dmdataMessageId: "81490a2628ef8c6ced5e6e7e76188669cf0bad128a604967fd26f33af4ff5bb6715dfeecc2e17e60ad23d0168f5c7fe0",
  },
  {
    fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727,
    corpusPath: "corpus-6b-latter/raw-VPOA50/VPOA50_c299dc9de5e4bd8825157d7029ec27e92ed7db75295fd54574f62737852df867f19249b00234496d3c71f8a6d973ec34.xml",
    dmdataMessageId: "c299dc9de5e4bd8825157d7029ec27e92ed7db75295fd54574f62737852df867f19249b00234496d3c71f8a6d973ec34",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_073ef50e2a1b38748a059fb15ac2a3e987d2e94702187440295588cbf58c29658a1a40ace4b8d843099db5b2ca3a2c2f.xml",
    dmdataMessageId: "073ef50e2a1b38748a059fb15ac2a3e987d2e94702187440295588cbf58c29658a1a40ace4b8d843099db5b2ca3a2c2f",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_2c69280bfc7037910f3a724d820b505d440572008375472c0dac37939fb2b6a0a5a543bcea5f7c2b59e560ae195d7962.xml",
    dmdataMessageId: "2c69280bfc7037910f3a724d820b505d440572008375472c0dac37939fb2b6a0a5a543bcea5f7c2b59e560ae195d7962",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_6209f924aeeff2c658ee82e34b9be4b2496bcce6696c1182f51dde577478a90ffbb1fcf508a6ac780a6ed467bab7c0e2.xml",
    dmdataMessageId: "6209f924aeeff2c658ee82e34b9be4b2496bcce6696c1182f51dde577478a90ffbb1fcf508a6ac780a6ed467bab7c0e2",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_afcdf4446f1afd828298564cadd8cf932079a999edf9f96500fd1efafffe96f04bbda93395c50c03527df230a3947f27.xml",
    dmdataMessageId: "afcdf4446f1afd828298564cadd8cf932079a999edf9f96500fd1efafffe96f04bbda93395c50c03527df230a3947f27",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_dff429c93c1e0a81ec34ce7e62876b6eacf5a5c18ecde00f4da543a927c44024a8accb814cee7b38086df9e88bc5c361.xml",
    dmdataMessageId: "dff429c93c1e0a81ec34ce7e62876b6eacf5a5c18ecde00f4da543a927c44024a8accb814cee7b38086df9e88bc5c361",
  },
  {
    fixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
    corpusPath: "corpus-6b-latter/raw-VPBS50-all/VPBS50_f87ca395fc86184de9e61a301ca6a0b6a8130aaa01dcefdd27004ac9d046dd8c654d9d5a36e17ca8c72ca90dc5f7b8cf.xml",
    dmdataMessageId: "f87ca395fc86184de9e61a301ca6a0b6a8130aaa01dcefdd27004ac9d046dd8c654d9d5a36e17ca8c72ca90dc5f7b8cf",
  },
];

const VPOA_EXPECTATIONS = [
  { fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709, eventId: "JPTK202608221709_202608221709", reportDateTime: "2026-08-22T17:09:00+09:00", serial: "1", area: { code: "130000", name: "東京都" } },
  { fixture: FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757, eventId: "JPDE202608201757_202608201757", reportDateTime: "2026-08-20T17:57:00+09:00", serial: "1", area: { code: "070000", name: "福島県" } },
  { fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717, eventId: "JPTK202608221709_202608221717", reportDateTime: "2026-08-22T17:17:00+09:00", serial: "2", area: { code: "130000", name: "東京都" } },
  { fixture: FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633, eventId: "JPTC202608211633_202608211633", reportDateTime: "2026-08-21T16:33:00+09:00", serial: "1", area: { code: "110000", name: "埼玉県" } },
  { fixture: FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709, eventId: "JPTC202608221709_202608221709", reportDateTime: "2026-08-22T17:09:00+09:00", serial: "1", area: { code: "110000", name: "埼玉県" } },
  { fixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727, eventId: "JPTK202608221709_202608221727", reportDateTime: "2026-08-22T17:27:00+09:00", serial: "3", area: { code: "130000", name: "東京都" } },
] as const;

const PHASE6B_PAIR_EXPECTATIONS = [
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
    sourceEventId: "JPTK202608221709_202608221709",
    counterpartEventId: "KJPTK202608221709_202608221709",
    reportDateTime: "2026-08-22T17:09:00+09:00",
    serial: "1",
  },
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717,
    sourceEventId: "JPTK202608221709_202608221717",
    counterpartEventId: "KJPTK202608221709_202608221717",
    reportDateTime: "2026-08-22T17:17:00+09:00",
    serial: "2",
  },
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727,
    sourceEventId: "JPTK202608221709_202608221727",
    counterpartEventId: "KJPTK202608221709_202608221727",
    reportDateTime: "2026-08-22T17:27:00+09:00",
    serial: "3",
  },
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633,
    sourceEventId: "JPTC202608211633_202608211633",
    counterpartEventId: "KJPTC202608211633_202608211633",
    reportDateTime: "2026-08-21T16:33:00+09:00",
    serial: "1",
  },
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709,
    sourceEventId: "JPTC202608221709_202608221709",
    counterpartEventId: "KJPTC202608221709_202608221709",
    reportDateTime: "2026-08-22T17:09:00+09:00",
    serial: "1",
  },
  {
    sourceFixture: FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757,
    counterpartFixture: FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757,
    sourceEventId: "JPDE202608201757_202608201757",
    counterpartEventId: "KJPDE202608201757_202608201757",
    reportDateTime: "2026-08-20T17:57:00+09:00",
    serial: "1",
  },
] as const;

const corpusByteEqualityTest = existsSync(CORPUS_ROOT) ? it : it.skip;

function makeLegacyMessage(
  type: typeof SOURCE_TYPES[number],
  eventId: string | null = "legacy-event-1",
  id = `${type}:message-1`,
  bodyText?: string,
) {
  const source = createMockWsDataMessageFromXml(BASE_XML, type);
  if (source.xmlReport == null) throw new Error("fixture envelope is missing");
  return normalizeTelegramMessage({
    ...source,
    id,
    classification: "classification.not-expected",
    head: { ...source.head, time: BASE_REPORT_DATE_TIME },
    xmlReport: {
      ...source.xmlReport,
      control: {
        ...source.xmlReport.control,
        title: "旧形式防災情報",
        publishingOffice: "テスト官署",
      },
      head: {
        ...source.xmlReport.head,
        title: "旧形式のタイトル",
        reportDateTime: BASE_REPORT_DATE_TIME,
        eventId,
        serial: "1",
        infoType: "発表",
        headline: "旧形式のヘッドライン",
      },
    },
    body: bodyText == null ? source.body : encodeXml(bodyText),
    meta: undefined,
  }).message;
}

function phase6bMessageWithEventId(
  fixture: string,
  id: string,
  eventId: string,
  receivedAtMs: number,
  titleSuffix = "",
) {
  const message = phase6bMessageAt(fixture, id, receivedAtMs);
  if (message.xmlReport == null) throw new Error("fixture envelope is missing");
  const title = `${message.xmlReport.head.title}${titleSuffix}`;
  const bodyXml = readFixture(fixture)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
    .replace(message.xmlReport.head.title, title);
  return normalizeTelegramMessage({
    ...message,
    body: encodeXml(bodyXml),
    xmlReport: {
      ...message.xmlReport,
      head: {
        ...message.xmlReport.head,
        eventId,
        title,
      },
    },
    meta: undefined,
  }, receivedAtMs).message;
}

function phase6bAmbiguousCorrelatorFactory(): LegacyCounterpartCorrelatorFactory {
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

function withNewMessageId(message: ReturnType<typeof makeLegacyMessage>, id: string) {
  return normalizeTelegramMessage({ ...message, id, meta: undefined }).message;
}

function expectOutcome(outcome: ProcessOutcome | null): ProcessOutcome {
  expect(outcome).not.toBeNull();
  if (outcome == null) throw new Error("expected an outcome");
  return outcome;
}

function phase6bVpoaMessage(xml: string) {
  return createMockWsDataMessageFromXml(xml, "VPOA50");
}

function replaceVpoaKindCode(xml: string, code: string): string {
  return xml.replace(/(<Kind>[\s\S]*?<Code>)1(<\/Code>)/g, `$1${code}$2`);
}

function replaceVpoaBodyKindCode(xml: string, code: string): string {
  return xml.replace(
    /(<Warning type="記録的短時間大雨情報（発表細分）">[\s\S]*?<Code>)1(<\/Code>)/,
    `$1${code}$2`,
  );
}

function removeVpoaKindCode(xml: string): string {
  return xml.replace(/(<Kind>[\s\S]*?)<Code>1<\/Code>/g, "$1");
}

function removeVpoaBodyKindCode(xml: string): string {
  return xml.replace(
    /(<Warning type="記録的短時間大雨情報（発表細分）">[\s\S]*?<Kind>[\s\S]*?)<Code>1<\/Code>/,
    "$1",
  );
}

function duplicateVpoaHeadKindCode(xml: string): string {
  return xml.replace(
    /(<Information type="記録的短時間大雨情報（発表細分）">[\s\S]*?<Code>1<\/Code>)/,
    "$1<Code>1</Code>",
  );
}

function replaceVpoaBodyStatus(xml: string, status: string): string {
  return xml.replace(/(<Kind>[\s\S]*?<Status>)発表(<\/Status>)/g, `$1${status}$2`);
}

function replaceVpoaInfoType(xml: string, infoType: string): string {
  return xml.replace(/<InfoType>発表<\/InfoType>/, `<InfoType>${infoType}</InfoType>`);
}

function replaceVpoaSerial(xml: string, serial: string): string {
  return xml.replace(/<Serial>1<\/Serial>/, `<Serial>${serial}</Serial>`);
}

function withLegacyInfoType(
  message: ReturnType<typeof makeLegacyMessage>,
  infoType: "発表" | "訂正" | "取消",
): ReturnType<typeof makeLegacyMessage> {
  if (message.xmlReport == null) throw new Error("fixture envelope is missing");
  return normalizeTelegramMessage({
    ...message,
    xmlReport: {
      ...message.xmlReport,
      head: { ...message.xmlReport.head, infoType, serial: "2" },
    },
    meta: undefined,
  }, message.meta?.receivedAtMs).message;
}

function createLegacyDisplay(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(),
    displayRawHeader: vi.fn(),
    displayVolcano: vi.fn(),
    displayVolcanoBatch: vi.fn(),
    getDisplayMode: () => "normal",
    renderSummaryLine: () => "要約",
  };
}

function phase6bMessageAt(fixture: string, id: string, receivedAtMs: number) {
  const message = createMockWsDataMessage(fixture, { id });
  return normalizeTelegramMessage({ ...message, meta: undefined }, receivedAtMs).message;
}

type Phase6bDelivery = "delivered" | "noClients" | "blockedSkipped" | "byteGuardDropped";

class Phase6bTransport implements DisplayTransport {
  readonly messages: DisplayServerMessageWithReconcile[] = [];
  constructor(private readonly delivery: Phase6bDelivery) {}

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

class SwitchablePhase6bSink implements DisplayIngestSink {
  hub: InfoDisplayHub | undefined;
  readonly ingested: PresentationEvent[] = [];

  constructor(hub?: InfoDisplayHub) {
    this.hub = hub;
  }

  ingest(event: PresentationEvent) {
    this.ingested.push(event);
    return this.hub?.ingest(event);
  }

  reconcileLateCounterpart(event: PresentationEvent, sourceEventKeys: readonly string[]) {
    return this.hub?.reconcileLateCounterpart(event, sourceEventKeys);
  }
}

function frontendStateFromFrames(messages: readonly DisplayServerMessageWithReconcile[]) {
  let state = initialFrontendState();
  for (const message of messages) {
    if (message.type === "event" || message.type === "reconcile") {
      state = reduceFrontend(state, message);
    }
  }
  return state;
}

function frontendStateFromSnapshot(hub: InfoDisplayHub) {
  return reduceFrontend(initialFrontendState(), { type: "snapshot", snapshot: hub.buildSnapshot() });
}

function createPhase6bHub() {
  return new InfoDisplayHub(new DisplayStateStore(), {
    summarize: (event) => event.title,
    weatherAlerts: () => [],
    now: () => Date.now(),
  });
}

function phase6bCounterpartEvent(
  expected: typeof PHASE6B_PAIR_EXPECTATIONS[number],
  id: string,
  receivedAtMs: number,
) {
  return toPresentationEvent(expectOutcome(processMessage(
    phase6bMessageAt(expected.counterpartFixture, id, receivedAtMs),
    "briefing",
    makeProcessDeps(),
  )));
}

function runPhase6bDisplayPair(
  expected: typeof PHASE6B_PAIR_EXPECTATIONS[number],
  order: "source-first-late" | "counterpart-first",
  options: { delivery?: Phase6bDelivery; replayLateCounterpart?: boolean } = {},
) {
  const reportDateTimeMs = Date.parse(expected.reportDateTime);
  vi.setSystemTime(reportDateTimeMs);
  const sourceId = `phase6b:${expected.sourceEventId}`;
  const counterpartId = `phase6b:${expected.counterpartEventId}`;
  const source = phase6bMessageAt(expected.sourceFixture, sourceId, reportDateTimeMs);
  const counterpart = phase6bMessageAt(expected.counterpartFixture, counterpartId, reportDateTimeMs);
  const hub = new InfoDisplayHub(new DisplayStateStore(), {
    summarize: (event) => event.title,
    weatherAlerts: () => [],
    now: () => Date.now(),
  });
  const transport = new Phase6bTransport(options.delivery ?? "delivered");
  hub.attachTransport(transport);
  const result = createMessageHandler({ displaySink: hub });

  if (order === "source-first-late") {
    result.handler(source);
    vi.advanceTimersByTime(60_001);
    const sourceTicker = hub.buildSnapshot().recentTicker.find((dto) => dto.type === "VPOA50");
    if (sourceTicker == null) throw new Error("source ticker was not released");
    vi.advanceTimersByTime(599_999);
    result.handler(
      phase6bMessageAt(expected.counterpartFixture, counterpartId, reportDateTimeMs + 660_000),
    );
    if (options.replayLateCounterpart === true) {
      result.handler(
        phase6bMessageAt(
          expected.counterpartFixture,
          `${counterpartId}:replay`,
          reportDateTimeMs + 660_000,
        ),
      );
    }
    result.disposeLegacyCounterpartCorrelator();
    const statsSnapshot = result.stats.getSnapshot(Date.now());
    return {
      hub,
      transport,
      ticker: hub.buildSnapshot().recentTicker,
      frontend: frontendStateFromFrames(transport.messages),
      frontendReconnect: frontendStateFromSnapshot(hub),
      sourcePriority: sourceTicker.tickerPriority ?? "low",
      metric: statsSnapshot.foundation.legacyLateCounterpartReconciled,
      localMetric: statsSnapshot.foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0,
    };
  }

  result.handler(counterpart);
  vi.advanceTimersByTime(60_001);
  result.handler(
    phase6bMessageAt(expected.sourceFixture, sourceId, reportDateTimeMs + 60_001),
  );
  result.disposeLegacyCounterpartCorrelator();
  const statsSnapshot = result.stats.getSnapshot(Date.now());
  return {
    hub,
    transport,
    ticker: hub.buildSnapshot().recentTicker,
    frontend: frontendStateFromFrames(transport.messages),
    frontendReconnect: frontendStateFromSnapshot(hub),
    sourcePriority: "mid" as const,
    metric: statsSnapshot.foundation.legacyLateCounterpartReconciled,
    localMetric: statsSnapshot.foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0,
  };
}

describe("Phase 6B legacy counterpart route and VPOA50 production slice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(SOURCE_TYPES)("%s は想定外 classification でも専用 route に入る", (type) => {
    expect(classifyMessage("classification.not-expected", type)).toBe("legacyCounterpart");
    expect(classifyMessage("telegram.weather", type)).toBe("legacyCounterpart");
  });

  it("対象外の既存 ignore type は ignore のまま残る", () => {
    expect(classifyMessage("classification.not-expected", "VPWW53")).toBe("ignore");
    expect(classifyMessage("classification.not-expected", "VPWW54")).toBe("ignore");
  });

  corpusByteEqualityTest("Phase 6B 12 fixture は corpus source と byte equality を持つ", () => {
    expect(PHASE6B_PROVENANCE).toHaveLength(12);
    for (const provenance of PHASE6B_PROVENANCE) {
      const destination = resolve(__dirname, "../../fixtures", provenance.fixture);
      const source = resolve(__dirname, "../../../", provenance.corpusPath);
      expect(readFileSync(destination), provenance.fixture).toEqual(readFileSync(source));
    }
  });

  it("Phase 6B provenance table は 12 XML の元相対 path と dmdata message id を保持する", () => {
    expect(PHASE6B_PROVENANCE).toHaveLength(12);
    for (const provenance of PHASE6B_PROVENANCE) {
      expect(provenance.corpusPath.startsWith("corpus-6b-latter/")).toBe(true);
      expect(provenance.dmdataMessageId).toMatch(/^[0-9a-f]{96}$/);
      const message = createMockWsDataMessage(provenance.fixture, {
        id: provenance.dmdataMessageId,
      });
      expect(message.id).toBe(provenance.dmdataMessageId);
      expect(message.xmlReport?.control.publishingOffice).toBe("気象庁");
      expect(message.xmlReport?.head.infoType).toBe("発表");
    }
  });

  it.each(PHASE6B_PAIR_EXPECTATIONS)("実 pair は EventID/ReportDateTime/官署/serial が対応する ($sourceEventId)", (expected) => {
    const source = createMockWsDataMessage(expected.sourceFixture);
    const counterpart = createMockWsDataMessage(expected.counterpartFixture);
    expect(source.xmlReport?.head).toMatchObject({
      eventId: expected.sourceEventId,
      reportDateTime: expected.reportDateTime,
      serial: expected.serial,
      infoType: "発表",
    });
    expect(counterpart.xmlReport?.head).toMatchObject({
      eventId: expected.counterpartEventId,
      reportDateTime: expected.reportDateTime,
      serial: expected.serial,
      infoType: "発表",
    });
    expect(source.xmlReport?.control.publishingOffice).toBe("気象庁");
    expect(counterpart.xmlReport?.control.publishingOffice).toBe("気象庁");
  });

  it.each(PHASE6B_PAIR_EXPECTATIONS)(
    "実6 pair の late reconcile と counterpart-first は canonical ticker identity/content/expiry を一致させる ($sourceEventId)",
    (expected) => {
      vi.useFakeTimers();
      const sourceFirst = runPhase6bDisplayPair(expected, "source-first-late");
      const counterpartFirst = runPhase6bDisplayPair(expected, "counterpart-first");

      expect(sourceFirst.ticker).toHaveLength(1);
      expect(counterpartFirst.ticker).toHaveLength(1);
      expect(sourceFirst.ticker[0]).toMatchObject({ type: "VPBS50", infoType: "発表" });
      expect(counterpartFirst.ticker[0]).toMatchObject({ type: "VPBS50", infoType: "発表" });
      expect(sourceFirst.ticker.some((dto) => dto.type === "VPOA50")).toBe(false);
      expect(counterpartFirst.ticker.some((dto) => dto.type === "VPOA50")).toBe(false);

      const sourceReconcile = sourceFirst.transport.messages.filter((message) => message.type === "reconcile");
      expect(sourceReconcile).toHaveLength(1);
      expect(sourceReconcile[0]).toMatchObject({
        event: expect.objectContaining({ type: "VPBS50" }),
        sourceEventKeys: expect.any(Array),
      });
      // hub の実 reconcile frame を protocol reducer に通した後、その command を
      // Ticker.svelte と同じ scheduler reducer へ渡す。catalog で source が残らず、
      // canonical が一回だけになることまで fixture pair ごとに固定する。
      const sourceOnlyFrontend = frontendStateFromFrames(
        sourceFirst.transport.messages.filter((message) => message.type === "event"),
      );
      const schedulerBeforeReconcile = createSchedulerState(
        sourceOnlyFrontend.ticker.map((dto, index) => toTickerJob(dto, index + 1)),
      );
      const schedulerAfterReconcile = reconcileScheduler(
        schedulerBeforeReconcile,
        sourceReconcile[0].sourceEventKeys,
        toTickerJob(sourceReconcile[0].event, sourceOnlyFrontend.ticker.length + 1),
        Date.parse(expected.reportDateTime) + 660_000,
      );
      expect(schedulerAfterReconcile.catalog.some(
        (job) => sourceReconcile[0].sourceEventKeys.includes(job.key),
      )).toBe(false);
      expect(schedulerAfterReconcile.catalog.filter(
        (job) => job.key === sourceReconcile[0].event.eventKey,
      )).toHaveLength(1);
      expect(schedulerAfterReconcile.catalog.map((job) => job.key)).toEqual(
        sourceFirst.frontend.ticker.map((dto) => dto.eventKey),
      );
      expect(sourceFirst.frontend.ticker).toEqual(sourceFirst.ticker);
      expect(counterpartFirst.frontend.ticker).toEqual(counterpartFirst.ticker);
      expect(sourceFirst.frontendReconnect.ticker).toEqual(sourceFirst.ticker);
      expect(counterpartFirst.frontendReconnect.ticker).toEqual(counterpartFirst.ticker);
      expect(sourceFirst.frontend.ticker.some((dto) => dto.type === "VPOA50")).toBe(false);
      expect(sourceFirst.frontendReconnect.ticker.some((dto) => dto.type === "VPOA50")).toBe(false);

      const { seq: _sourceSeq, ...sourceCanonical } = sourceFirst.ticker[0]!;
      const { seq: _counterpartSeq, ...counterpartCanonical } = counterpartFirst.ticker[0]!;
      expect(sourceCanonical).toEqual(counterpartCanonical);
      expect(sourceFirst.metric).toBe(1);
      expect(sourceFirst.localMetric).toBe(1);
      expect(counterpartFirst.metric).toBe(0);
      expect(counterpartFirst.localMetric).toBe(0);

      const expectedExpiryAtMs = Math.min(
        Date.parse(expected.reportDateTime) + tickerTtlMs(sourceFirst.sourcePriority, "legacyCounterpart"),
        Date.parse(expected.reportDateTime)
          + tickerTtlMs(sourceFirst.ticker[0]?.tickerPriority ?? "low", sourceFirst.ticker[0]?.domain),
      );
      for (const run of [sourceFirst, counterpartFirst]) {
        expect(run.hub.sweepTicker(expectedExpiryAtMs)).toBe(false);
        expect(run.hub.buildSnapshot().recentTicker).toHaveLength(1);
        expect(run.hub.sweepTicker(expectedExpiryAtMs + 1)).toBe(true);
        expect(run.hub.buildSnapshot().recentTicker).toHaveLength(0);
      }
    },
  );

  it.each([
    "delivered",
    "noClients",
    "blockedSkipped",
    "byteGuardDropped",
  ] as const)("実 pair の reconcile delivery=%s でも metric は receipt generation ごとに一回だけ確定する", (delivery) => {
    vi.useFakeTimers();
    const run = runPhase6bDisplayPair(
      PHASE6B_PAIR_EXPECTATIONS[0]!,
      "source-first-late",
      { delivery, replayLateCounterpart: true },
    );

    expect(run.transport.messages.filter((message) => message.type === "reconcile")).toHaveLength(1);
    expect(run.metric).toBe(1);
    expect(run.localMetric).toBe(1);
    expect(run.hub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
  });

  it("createDisplaySink→InfoDisplayHub→router の production seam で late reconcile を原子的に通す", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);
    vi.setSystemTime(reportDateTimeMs);
    const hub = createPhase6bHub();
    const sink = createDisplaySink({
      standby: { applyEvent: () => undefined },
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => hub,
      now: () => Date.now(),
    });
    const result = createMessageHandler({ displaySink: sink });
    result.handler(phase6bMessageAt(expected.sourceFixture, "production-seam:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    result.handler(phase6bMessageAt(
      expected.counterpartFixture,
      "production-seam:counterpart",
      reportDateTimeMs + 60_001,
    ));

    expect(hub.buildSnapshot().recentTicker).toEqual([expect.objectContaining({ type: "VPBS50" })]);
    expect(hub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
    expect(result.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(1);
    result.disposeLegacyCounterpartCorrelator();
  });

  it("同一 receipt generation の typed reconcileLateCounterpart action 重送は metric と hub 状態を変えない", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);
    vi.setSystemTime(reportDateTimeMs);
    let actionSink: ((action: LegacyCounterpartAction) => void) | undefined;
    const observedActions: LegacyCounterpartAction[] = [];
    const factory: LegacyCounterpartCorrelatorFactory = (context) => {
      actionSink = context.actionSink;
      return new LegacyCounterpartCorrelator({
        onAction: (action) => {
          observedActions.push(action);
          context.actionSink(action);
        },
        onLifecycleEvent: context.lifecycleEventSink,
      });
    };
    const hub = createPhase6bHub();
    const result = createMessageHandler({ displaySink: hub, legacyCounterpartCorrelatorFactory: factory });
    result.handler(phase6bMessageAt(expected.sourceFixture, "duplicate-action:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    const release = observedActions.find(
      (action): action is Extract<LegacyCounterpartAction, { kind: "releaseSource" }> => action.kind === "releaseSource",
    );
    if (release == null || actionSink == null) throw new Error("source receipt action sink was not captured");
    const counterpartOutcome = expectOutcome(processMessage(
      phase6bMessageAt(expected.counterpartFixture, "duplicate-action:counterpart", reportDateTimeMs + 60_001),
      "briefing",
      makeProcessDeps(),
    ));
    const action = {
      kind: "reconcileLateCounterpart" as const,
      outcome: counterpartOutcome,
      sourceOutcome: release.outcome,
      sourceIdentity: release.sourceIdentity,
      decidedAtMs: Date.now(),
    };

    actionSink(action);
    const stateAfterFirstAction = hub.buildSnapshot();
    const metricsAfterFirstAction = result.stats.getSnapshot(Date.now());
    actionSink(action);

    expect(hub.buildSnapshot()).toEqual(stateAfterFirstAction);
    expect(hub.buildSnapshot().recentTicker.filter((dto) => dto.type === "VPBS50")).toHaveLength(1);
    expect(hub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
    expect(result.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled)
      .toBe(metricsAfterFirstAction.foundation.legacyLateCounterpartReconciled);
    expect(result.stats.getSnapshot(Date.now()).foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0)
      .toBe(metricsAfterFirstAction.foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0);

    // consumed marker も元 receipt と同じ t0+660,001ms で timer 破棄する。期限後は
    // typed action が重送抑止されず canonical の通常 ingest へ fail-open する。
    const expiryIngest = vi.spyOn(hub, "ingest");
    vi.advanceTimersByTime(600_000);
    actionSink(action);
    expect(expiryIngest).toHaveBeenLastCalledWith(expect.objectContaining({ type: "VPBS50" }));

    // 新 generation の consumed marker は dispose の唯一の入口でも timer ごと破棄する。
    const disposeSourceReceivedAtMs = Date.now();
    result.handler(phase6bMessageAt(
      expected.sourceFixture,
      "duplicate-action:dispose-source",
      disposeSourceReceivedAtMs,
    ));
    vi.advanceTimersByTime(60_001);
    const disposeRelease = [...observedActions].reverse().find(
      (candidate): candidate is Extract<LegacyCounterpartAction, { kind: "releaseSource" }> => candidate.kind === "releaseSource",
    );
    if (disposeRelease == null) throw new Error("dispose receipt action was not captured");
    const disposeAction = {
      kind: "reconcileLateCounterpart" as const,
      outcome: expectOutcome(processMessage(
        phase6bMessageAt(expected.counterpartFixture, "duplicate-action:dispose-counterpart", Date.now()),
        "briefing",
        makeProcessDeps(),
      )),
      sourceOutcome: disposeRelease.outcome,
      sourceIdentity: disposeRelease.sourceIdentity,
      decidedAtMs: Date.now(),
    };
    actionSink(disposeAction);
    result.disposeLegacyCounterpartCorrelator();
    const disposeIngest = vi.spyOn(hub, "ingest");
    actionSink(disposeAction);
    expect(disposeIngest).toHaveBeenLastCalledWith(expect.objectContaining({ type: "VPBS50" }));
  });

  it("実 pair の sink 不在・source既除去・hub停止・mutation failure は canonical通常経路を保ち metric 0 にする", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);

    vi.setSystemTime(reportDateTimeMs);
    const noSinkDisplay = createLegacyDisplay();
    const noSink = createMessageHandler({ display: noSinkDisplay });
    noSink.handler(phase6bMessageAt(expected.sourceFixture, "failure:no-sink:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    noSink.handler(phase6bMessageAt(expected.counterpartFixture, "failure:no-sink:counterpart", reportDateTimeMs + 60_001));
    expect(noSinkDisplay.displayOutcome).toHaveBeenCalledTimes(2);
    expect(noSink.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    expect(noSink.stats.getSnapshot(Date.now()).foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
    noSink.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const removedHub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => Date.now(),
    });
    const removed = createMessageHandler({ displaySink: removedHub });
    removed.handler(phase6bMessageAt(expected.sourceFixture, "failure:removed:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    const sourceKey = removedHub.buildSnapshot().recentTicker[0]?.eventKey;
    if (sourceKey == null) throw new Error("source ticker missing before external removal");
    expect(removedHub.reconcileLateCounterpart(
      phase6bCounterpartEvent(expected, "failure:removed:external", reportDateTimeMs + 60_001),
      [sourceKey],
    )).toMatchObject({ kind: "applied" });
    const removedIngest = vi.spyOn(removedHub, "ingest");
    removed.handler(phase6bMessageAt(expected.counterpartFixture, "failure:removed:counterpart", reportDateTimeMs + 60_001));
    expect(removedIngest).toHaveBeenCalledWith(expect.objectContaining({ type: "VPBS50" }));
    expect(removedHub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
    expect(removed.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    expect(removed.stats.getSnapshot(Date.now()).foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
    removed.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const stoppedHub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => Date.now(),
    });
    const stopped = createMessageHandler({ displaySink: stoppedHub });
    const stoppedIngest = vi.spyOn(stoppedHub, "ingest");
    stopped.handler(phase6bMessageAt(expected.sourceFixture, "failure:stopped:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    stoppedHub.stop();
    stopped.handler(phase6bMessageAt(expected.counterpartFixture, "failure:stopped:counterpart", reportDateTimeMs + 60_001));
    expect(stoppedIngest).toHaveBeenLastCalledWith(expect.objectContaining({ type: "VPBS50" }));
    expect(stopped.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    expect(stopped.stats.getSnapshot(Date.now()).foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
    stopped.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const ingested: PresentationEvent[] = [];
    const mutationFailure = createMessageHandler({
      displaySink: {
        ingest: (event) => {
          ingested.push(event);
          return { kind: "applied" as const, eventKeys: [`failure:${event.id}`] };
        },
        reconcileLateCounterpart: () => ({
          kind: "failure" as const,
          status: "failure" as const,
          reason: "reconcileMutationFailed" as const,
        }),
      },
    });
    mutationFailure.handler(phase6bMessageAt(expected.sourceFixture, "failure:mutation:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    mutationFailure.handler(phase6bMessageAt(expected.counterpartFixture, "failure:mutation:counterpart", reportDateTimeMs + 60_001));
    expect(ingested).toMatchObject([
      { type: "VPOA50" },
      { type: "VPBS50" },
    ]);
    expect(mutationFailure.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    expect(mutationFailure.stats.getSnapshot(Date.now()).foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
    mutationFailure.disposeLegacyCounterpartCorrelator();
  });

  it("実 pair の display off/on 5分岐と process restart は receipt を遡及せず canonical通常 ingest と metric境界を保つ", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);

    vi.setSystemTime(reportDateTimeMs);
    const onHub = createPhase6bHub();
    const on = new SwitchablePhase6bSink(onHub);
    const onResult = createMessageHandler({ displaySink: on });
    onResult.handler(phase6bMessageAt(expected.sourceFixture, "display:on:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    onResult.handler(phase6bMessageAt(expected.counterpartFixture, "display:on:counterpart", reportDateTimeMs + 60_001));
    expect(onHub.buildSnapshot().recentTicker).toEqual([expect.objectContaining({ type: "VPBS50" })]);
    expect(onResult.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(1);
    onResult.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const offThenOn = new SwitchablePhase6bSink();
    const offThenOnResult = createMessageHandler({ displaySink: offThenOn });
    offThenOnResult.handler(phase6bMessageAt(expected.sourceFixture, "display:off-on:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    const lateHub = createPhase6bHub();
    offThenOn.hub = lateHub;
    offThenOnResult.handler(phase6bMessageAt(expected.counterpartFixture, "display:off-on:counterpart", reportDateTimeMs + 60_001));
    expect(lateHub.buildSnapshot().recentTicker).toEqual([expect.objectContaining({ type: "VPBS50" })]);
    expect(lateHub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
    expect(offThenOn.ingested).toMatchObject([{ type: "VPOA50" }, { type: "VPBS50" }]);
    expect(offThenOnResult.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    offThenOnResult.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const sourceHub = createPhase6bHub();
    const onThenOff = new SwitchablePhase6bSink(sourceHub);
    const onThenOffResult = createMessageHandler({ displaySink: onThenOff });
    onThenOffResult.handler(phase6bMessageAt(expected.sourceFixture, "display:on-off:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    expect(sourceHub.buildSnapshot().recentTicker).toEqual([expect.objectContaining({ type: "VPOA50" })]);
    onThenOff.hub = undefined;
    onThenOffResult.handler(phase6bMessageAt(expected.counterpartFixture, "display:on-off:counterpart", reportDateTimeMs + 60_001));
    const recoveredHub = createPhase6bHub();
    onThenOff.hub = recoveredHub;
    expect(recoveredHub.buildSnapshot().recentTicker).toEqual([]);
    expect(onThenOff.ingested).toMatchObject([{ type: "VPOA50" }, { type: "VPBS50" }]);
    expect(onThenOffResult.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    onThenOffResult.disposeLegacyCounterpartCorrelator();

    vi.setSystemTime(reportDateTimeMs);
    const preRestartHub = createPhase6bHub();
    const preRestart = createMessageHandler({ displaySink: preRestartHub });
    preRestart.handler(phase6bMessageAt(expected.sourceFixture, "display:restart:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    preRestart.disposeLegacyCounterpartCorrelator();
    const restartedHub = createPhase6bHub();
    const restarted = createMessageHandler({ displaySink: restartedHub });
    restarted.handler(phase6bMessageAt(expected.counterpartFixture, "display:restart:counterpart", reportDateTimeMs + 60_001));
    expect(restartedHub.buildSnapshot().recentTicker).toEqual([expect.objectContaining({ type: "VPBS50" })]);
    expect(restartedHub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(false);
    expect(restarted.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    restarted.disposeLegacyCounterpartCorrelator();
  });

  it("negative matrix は router→hub 統合で unrelated／ambiguous／訂正／取消を fail-open し metric 0 にする", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);

    vi.setSystemTime(reportDateTimeMs);
    const unrelatedHub = createPhase6bHub();
    const unrelated = createMessageHandler({ displaySink: unrelatedHub });
    unrelated.handler(phase6bMessageAt(expected.sourceFixture, "negative:unrelated:source", reportDateTimeMs));
    vi.advanceTimersByTime(60_001);
    unrelated.handler(phase6bMessageAt(
      PHASE6B_PAIR_EXPECTATIONS[4]!.counterpartFixture,
      "negative:unrelated:counterpart",
      reportDateTimeMs + 60_001,
    ));
    expect(unrelatedHub.buildSnapshot().recentTicker.map((dto) => dto.type)).toEqual(
      expect.arrayContaining(["VPOA50", "VPBS50"]),
    );
    expect(unrelated.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    unrelated.disposeLegacyCounterpartCorrelator();

    for (const infoType of ["訂正", "取消"] as const) {
      vi.setSystemTime(reportDateTimeMs);
      const hub = createPhase6bHub();
      const result = createMessageHandler({ displaySink: hub });
      const sourceXml = replaceVpoaSerial(replaceVpoaInfoType(
        readFixture(expected.sourceFixture),
        infoType,
      ), "2");
      result.handler(withNewMessageId(
        phase6bVpoaMessage(sourceXml),
        `negative:${infoType}:source`,
      ));
      result.handler(phase6bMessageAt(
        expected.counterpartFixture,
        `negative:${infoType}:counterpart`,
        reportDateTimeMs,
      ));
      expect(hub.buildSnapshot().recentTicker.map((dto) => dto.type)).toEqual(
        expect.arrayContaining(["VPOA50", "VPBS50"]),
      );
      const snapshot = result.stats.getSnapshot(Date.now());
      expect(snapshot.foundation.legacyLateCounterpartReconciled).toBe(0);
      expect(snapshot.foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
      result.disposeLegacyCounterpartCorrelator();
    }

    vi.setSystemTime(reportDateTimeMs);
    const ambiguousHub = createPhase6bHub();
    const ambiguous = createMessageHandler({
      displaySink: ambiguousHub,
      legacyCounterpartCorrelatorFactory: phase6bAmbiguousCorrelatorFactory(),
    });
    ambiguous.handler(phase6bMessageWithEventId(
      expected.counterpartFixture,
      "negative:ambiguous:first",
      "KAMBIGUOUS-1",
      reportDateTimeMs,
    ));
    ambiguous.handler(phase6bMessageWithEventId(
      expected.counterpartFixture,
      "negative:ambiguous:second",
      "KAMBIGUOUS-2",
      reportDateTimeMs,
      "（別候補）",
    ));
    ambiguous.handler(phase6bMessageAt(expected.sourceFixture, "negative:ambiguous:source", reportDateTimeMs));
    expect(ambiguousHub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPOA50")).toBe(true);
    expect(ambiguousHub.buildSnapshot().recentTicker.some((dto) => dto.type === "VPBS50")).toBe(true);
    const ambiguousStats = ambiguous.stats.getSnapshot(Date.now());
    expect(ambiguousStats.foundation.legacyAmbiguousDisplayed).toBe(1);
    expect(ambiguousStats.foundation.legacyLateCounterpartReconciled).toBe(0);
    expect(ambiguousStats.foundationByHeadType.get("VPOA50")?.legacyLateCounterpartReconciled ?? 0).toBe(0);
    ambiguous.disposeLegacyCounterpartCorrelator();
  });

  it("実 pair の t0+660,001ms は receipt expiry 後の通常 ingestへfail-openしsource tickerを残す", () => {
    vi.useFakeTimers();
    const expected = PHASE6B_PAIR_EXPECTATIONS[0]!;
    const reportDateTimeMs = Date.parse(expected.reportDateTime);
    vi.setSystemTime(reportDateTimeMs);
    const hub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => Date.now(),
    });
    const result = createMessageHandler({ displaySink: hub });
    const sourceId = `phase6b:expiry:${expected.sourceEventId}`;
    const counterpartId = `phase6b:expiry:${expected.counterpartEventId}`;
    result.handler(phase6bMessageAt(expected.sourceFixture, sourceId, reportDateTimeMs));
    vi.advanceTimersByTime(660_001);
    result.handler(
      phase6bMessageAt(expected.counterpartFixture, counterpartId, reportDateTimeMs + 660_001),
    );

    const snapshot = hub.buildSnapshot();
    expect(snapshot.recentTicker).toHaveLength(2);
    expect(snapshot.recentTicker.map((dto) => dto.type)).toEqual(
      expect.arrayContaining(["VPOA50", "VPBS50"]),
    );
    expect(result.stats.getSnapshot(Date.now()).foundation.legacyLateCounterpartReconciled).toBe(0);
    result.disposeLegacyCounterpartCorrelator();
  });

  it.each(VPOA_EXPECTATIONS)("VPOA50 実 fixture $fixture は raw evidence から high を確定する", (expected) => {
    expect(PRODUCTION_LEGACY_COUNTERPART_SEVERITY_RULES.size).toBe(1);
    const provenance = PHASE6B_PROVENANCE.find((row) => row.fixture === expected.fixture);
    expect(provenance).toBeDefined();
    if (provenance == null) return;
    const message = createMockWsDataMessage(expected.fixture, { id: provenance.dmdataMessageId });
    const parsed = parseLegacyCounterpart(message);
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    expect(parsed).toMatchObject({
      type: "VPOA50",
      infoType: "発表",
      reportDateTime: expected.reportDateTime,
      publishingOffice: "気象庁",
      eventId: expected.eventId,
      serial: expected.serial,
      areas: [expected.area],
      kinds: [{ code: "1", name: "記録的短時間大雨情報" }],
      severityEvidence: [
        {
          source: "head",
          severity: "high",
          phenomenonCode: null,
          kindCode: "1",
          levelCode: null,
          condition: "発表",
        },
        {
          source: "body",
          severity: "high",
          phenomenonCode: null,
          kindCode: "1",
          levelCode: null,
          status: "発表",
        },
      ],
    });
    const outcome = processLegacyCounterpart(message);
    expect(outcome).not.toBeNull();
    if (outcome == null) return;
    expect(outcome.severity).toBe("high");
    expect(outcome.presentation).toMatchObject({
      frameLevel: "warning",
      soundLevel: "warning",
      notifyCategory: "weather",
    });
  });

  it("VPOA50 の訂正は code 1 と発表状態の raw evidence が揃えば high になる", () => {
    const xml = replaceVpoaInfoType(
      readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709),
      "訂正",
    );
    const outcome = processLegacyCounterpart(phase6bVpoaMessage(xml));
    expect(outcome?.severity).toBe("high");
  });

  it.each([
    ["未知 Kind.Code", (xml: string) => replaceVpoaKindCode(xml, "99")],
    ["Kind.Code 欠落", removeVpoaKindCode],
    ["Head=1 / Body=99 の code 不一致", (xml: string) => replaceVpoaBodyKindCode(xml, "99")],
    ["Body 側だけ Kind.Code 欠落", removeVpoaBodyKindCode],
    ["Head Kind.Code の未知 cardinality", duplicateVpoaHeadKindCode],
    ["Head/Body の状態矛盾", (xml: string) => replaceVpoaBodyStatus(xml, "不明")],
    ["Head Information 欠落", (xml: string) => xml.replace(/<Information type="記録的短時間大雨情報（発表細分）">[\s\S]*?<\/Information>/, "")],
    ["Body Warning 欠落", (xml: string) => xml.replace(/<Warning type="記録的短時間大雨情報（発表細分）">[\s\S]*?<\/Warning>/, "")],
  ] as const)("VPOA50 の $0 は title/headline の語から昇格せず unknown", (_label, mutate) => {
    const xml = mutate(readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709));
    const outcome = processLegacyCounterpart(phase6bVpoaMessage(xml));
    expect(outcome).not.toBeNull();
    if (outcome == null) return;
    expect(outcome.severity).toBe("unknown");
    expect(outcome.presentation.soundLevel).toBeUndefined();
  });

  it("VPOA50 取消は code 1／発表状態を含んでも unknown・非通知 fail-open で表示解除しない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const normalXml = readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const cancellationXml = replaceVpoaSerial(replaceVpoaInfoType(normalXml, "取消"), "2");
    const normal = withNewMessageId(phase6bVpoaMessage(normalXml), "VPOA50:active");
    const cancellation = withNewMessageId(phase6bVpoaMessage(cancellationXml), "VPOA50:cancel");
    const hub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: (event) => event.title,
      weatherAlerts: () => [],
      now: () => Date.now(),
    });
    const display = createLegacyDisplay();
    const { handler, stats } = createMessageHandler({ display, displaySink: hub });

    handler(normal);
    vi.advanceTimersByTime(60_001);
    const beforeCancellation = hub.buildSnapshot();
    expect(beforeCancellation.recentTicker).toEqual([
      expect.objectContaining({ type: "VPOA50", infoType: "発表", serial: "1" }),
    ]);
    const notifiedBeforeCancellation = stats.getSnapshot().foundation.notified;
    notifyMock.mockClear();

    handler(cancellation);
    vi.advanceTimersByTime(60_001);
    const outcome = processLegacyCounterpart(cancellation);
    expect(outcome).not.toBeNull();
    if (outcome == null) return;
    expect(outcome.severity).toBe("unknown");
    expect(outcome.presentation.soundLevel).toBeUndefined();
    const event = toPresentationEvent(outcome);
    expect(event.isCancellation).toBe(true);
    expect(event.legacySeverity).toBe("unknown");
    expect(display.displayOutcome).toHaveBeenCalledTimes(2);
    expect(hub.buildSnapshot().recentTicker).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "VPOA50", infoType: "発表", serial: "1" }),
      expect.objectContaining({ type: "VPOA50", infoType: "取消", serial: "2" }),
    ]));
    expect(notifyMock).not.toHaveBeenCalled();
    expect(stats.getSnapshot().foundation.notified).toBe(notifiedBeforeCancellation);
    expect(stats.getSnapshot().foundation.legacySeverityUnknownNotificationSuppressed).toBe(0);
    expect(stats.getSnapshot().foundation.legacyCancellationMismatch).toBe(0);
  });

  it.each(["VPNO50", "VXWW50"] as const)("%s 取消は既存unknown通知抑止metricを維持してfail-openする", (type) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const result = createMessageHandler();
    result.notifier.setAll(true);
    const cancellation = withLegacyInfoType(makeLegacyMessage(type, `${type}-CANCEL`, `${type}:cancel`), "取消");

    result.handler(cancellation);
    vi.advanceTimersByTime(60_001);

    const snapshot = result.stats.getSnapshot(Date.now());
    expect(notifyMock).not.toHaveBeenCalled();
    expect(snapshot.foundation.legacySeverityUnknownNotificationSuppressed).toBe(1);
    expect(snapshot.foundationByHeadType.get(type)?.legacySeverityUnknownNotificationSuppressed).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedDisplayed).toBe(1);
  });

  it.each(["訂正", "取消"] as const)("pending VPOA50 発表→%s は旧発表を静かに失効しdeadline後も再表示・再通知しない", (infoType) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const normalXml = readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const updateXml = replaceVpoaSerial(replaceVpoaInfoType(normalXml, infoType), "2");
    const display = createLegacyDisplay();
    const { handler, notifier, stats } = createMessageHandler({ display });
    notifier.setAll(true);

    handler(withNewMessageId(phase6bVpoaMessage(normalXml), `pending:${infoType}:normal`));
    handler(withNewMessageId(phase6bVpoaMessage(updateXml), `pending:${infoType}:update`));
    vi.advanceTimersByTime(60_001);

    const snapshot = stats.getSnapshot(Date.now());
    expect(display.displayOutcome).toHaveBeenCalledOnce();
    expect(display.displayOutcome).toHaveBeenCalledWith(expect.objectContaining({
      parsed: expect.objectContaining({ infoType }),
    }));
    expect(notifyMock).toHaveBeenCalledTimes(infoType === "訂正" ? 1 : 0);
    expect(snapshot.foundation.legacyUnmatchedDisplayed).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(infoType === "訂正" ? 1 : 0);
    expect(snapshot.foundation.legacySeverityUnknownNotificationSuppressed).toBe(0);
    expect(snapshot.foundation.notified).toBe(infoType === "訂正" ? 1 : 0);
  });

  it("pending発表→訂正のsemantic replayは旧timerも訂正通知も再実行しない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const normalXml = readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const correctionXml = replaceVpoaSerial(replaceVpoaInfoType(normalXml, "訂正"), "2");
    const display = createLegacyDisplay();
    const { handler, notifier, stats } = createMessageHandler({ display });
    notifier.setAll(true);
    handler(withNewMessageId(phase6bVpoaMessage(normalXml), "pending:replay:normal"));
    const correction = withNewMessageId(phase6bVpoaMessage(correctionXml), "pending:replay:correction");
    handler(correction);
    handler(withNewMessageId(correction, "pending:replay:semantic-replay"));
    vi.advanceTimersByTime(60_001);

    const snapshot = stats.getSnapshot(Date.now());
    expect(display.displayOutcome).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(snapshot.foundation.semanticDuplicate).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedDisplayed).toBe(1);
  });

  it("restart後の空cacheで訂正を受けても失効済みpending発表をreleaseしない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const normalXml = readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const correctionXml = replaceVpoaSerial(replaceVpoaInfoType(normalXml, "訂正"), "2");
    const oldDisplay = createLegacyDisplay();
    const old = createMessageHandler({ display: oldDisplay });
    old.notifier.setAll(true);
    old.handler(withNewMessageId(phase6bVpoaMessage(normalXml), "restart:pending"));
    old.disposeLegacyCounterpartCorrelator();
    vi.advanceTimersByTime(60_001);
    expect(oldDisplay.displayOutcome).not.toHaveBeenCalled();

    const newDisplay = createLegacyDisplay();
    const restarted = createMessageHandler({ display: newDisplay });
    restarted.notifier.setAll(true);
    restarted.handler(withNewMessageId(phase6bVpoaMessage(correctionXml), "restart:correction"));
    vi.advanceTimersByTime(60_001);
    expect(newDisplay.displayOutcome).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(restarted.stats.getSnapshot(Date.now()).foundation.legacyUnmatchedHighSeverityNotified).toBe(1);
  });

  it("source-only VPOA50 発表 Code 1 は60秒後にqualifier付きweather/warning通知とhigh metricを一回だけ発行する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const displayed: PresentationEvent[] = [];
    const result = createMessageHandler({
      displaySink: { ingest: (event) => displayed.push(event) },
    });
    result.notifier.setAll(true);
    vi.mocked(playSound).mockClear();

    result.handler(createMockWsDataMessage(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709));
    expect(displayed).toHaveLength(0);
    expect(notifyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_001);

    const snapshot = result.stats.getSnapshot(Date.now());
    expect(displayed).toMatchObject([{ domain: "legacyCounterpart", type: "VPOA50", legacySeverity: "high" }]);
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("対応電文未確認"),
      message: expect.stringContaining("対応電文未確認"),
    });
    expect(playSound).toHaveBeenCalledWith("warning");
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(1);
    expect(snapshot.foundation.notified).toBe(1);
    expect(snapshot.foundationByHeadType.get("VPOA50")?.legacyUnmatchedHighSeverityNotified).toBe(1);
  });

  it("Holdback内の実 VPOA50→VPBS50 pair はsourceを表示・通知せずVPBS50既存経路だけを一回通す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const displayed: PresentationEvent[] = [];
    const result = createMessageHandler({
      displaySink: { ingest: (event) => displayed.push(event) },
    });
    result.notifier.setAll(true);
    vi.mocked(playSound).mockClear();

    result.handler(createMockWsDataMessage(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709));
    result.handler(createMockWsDataMessage(FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709));

    const snapshot = result.stats.getSnapshot(Date.now());
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({ domain: "briefing", type: "VPBS50" });
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(playSound).toHaveBeenCalledOnce();
    expect(snapshot.foundation.legacyMatchedSuppressed).toBe(1);
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(0);
    expect(snapshot.foundation.notified).toBe(1);
  });

  it("無関係なVPBS50は既存briefing経路を一回だけ通りlegacy suppressionを起こさない", () => {
    const displayed: PresentationEvent[] = [];
    const result = createMessageHandler({ displaySink: { ingest: (event) => displayed.push(event) } });
    result.notifier.setAll(true);

    result.handler(createMockWsDataMessage(FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709));

    const snapshot = result.stats.getSnapshot();
    expect(displayed).toMatchObject([{ domain: "briefing", type: "VPBS50" }]);
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(snapshot.countByType.get("VPBS50")).toBe(1);
    expect(snapshot.foundation.legacyMatchedSuppressed).toBe(0);
  });

  it("unknown VPOA50 は60秒後も表示だけで通知しない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const unknownXml = replaceVpoaKindCode(
      readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709),
      "99",
    );
    const result = createMessageHandler();
    result.notifier.setAll(true);

    result.handler(withNewMessageId(phase6bVpoaMessage(unknownXml), "VPOA50:unknown"));
    vi.advanceTimersByTime(60_001);

    const snapshot = result.stats.getSnapshot(Date.now());
    expect(notifyMock).not.toHaveBeenCalled();
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(0);
    expect(snapshot.foundation.legacySeverityUnknownNotificationSuppressed).toBe(1);
  });

  it("VPOA50 Code 1 訂正は相関へ参加せず即時に訂正/qualifier付き通知を一回だけ発行する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:09:00+09:00"));
    const correctionXml = replaceVpoaSerial(replaceVpoaInfoType(
      readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709),
      "訂正",
    ), "2");
    const result = createMessageHandler();
    result.notifier.setAll(true);

    result.handler(withNewMessageId(phase6bVpoaMessage(correctionXml), "VPOA50:correction"));

    const snapshot = result.stats.getSnapshot(Date.now());
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("[訂正]"),
      message: expect.stringContaining("訂正:"),
    });
    expect(JSON.stringify(notifyMock.mock.calls[0][0])).toContain("対応電文未確認");
    expect(snapshot.foundation.legacyUnmatchedHighSeverityNotified).toBe(1);
    expect(snapshot.foundation.notified).toBe(1);
  });

  it.each(SOURCE_TYPES)("%s は header-only parsed model を作り、body を流出させない", (type) => {
    const parsed = parseLegacyCounterpart(makeLegacyMessage(type, "legacy-event-1", `${type}:parser`, "<SECRET>body-only</SECRET>"));
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    expect(parsed).toMatchObject({
      type,
      title: "旧形式のタイトル",
      headline: "旧形式のヘッドライン",
      reportDateTime: BASE_REPORT_DATE_TIME,
      publishingOffice: "テスト官署",
      eventId: "legacy-event-1",
      serial: "1",
      areas: [],
      phenomena: [],
      kinds: [],
      severityEvidence: [],
    });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(JSON.stringify(parsed)).not.toContain("body-only");
    expect(LEGACY_COUNTERPART_BODY_EXTRACTORS).toContain("VPOA50");
  });

  it("header 欠落時は type/head 時刻/author へ縮退し、parse failure で raw へ落とさない", () => {
    const full = makeLegacyMessage("VPOA50", null, "VPOA50:missing-header");
    if (full.xmlReport == null) throw new Error("fixture envelope is missing");
    const missingHeader = normalizeTelegramMessage({
      ...full,
      xmlReport: {
        ...full.xmlReport,
        control: { ...full.xmlReport.control, title: "", publishingOffice: "" },
        head: {
          ...full.xmlReport.head,
          title: "",
          headline: null,
          eventId: null,
          serial: null,
        },
      },
      meta: undefined,
    }).message;
    const parsed = parseLegacyCounterpart(missingHeader);
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    expect(parsed.type).toBe("VPOA50");
    expect(parsed.title).toBe("VPOA50");
    expect(parsed.controlTitle).toBe("VPOA50");
    expect(parsed.reportDateTime).toBe(BASE_REPORT_DATE_TIME);
    expect(parsed.publishingOffice).toBe(full.head.author);
    expect(parsed.eventId).toBeNull();

    const outcome = processMessage(missingHeader, "legacyCounterpart", makeProcessDeps());
    expect(expectOutcome(outcome)).toMatchObject({ domain: "legacyCounterpart" });
  });

  it("invalid ReportDateTime は共通日時診断へ分離される", () => {
    const source = makeLegacyMessage("VPNO50", "legacy-invalid-date", "VPNO50:invalid-date");
    if (source.xmlReport == null) throw new Error("fixture envelope is missing");
    const invalid = normalizeTelegramMessage({
      ...source,
      xmlReport: {
        ...source.xmlReport,
        head: { ...source.xmlReport.head, reportDateTime: "not-a-date" },
      },
      meta: undefined,
    }).message;
    const outcomes: ProcessOutcome[] = [];
    const { handler, stats } = createMessageHandler({ outcomeTaps: [outcome => outcomes.push(outcome as ProcessOutcome)] });
    handler(invalid);
    expect(outcomes).toHaveLength(0);
    expect(stats.getSnapshot().foundation.invalidDateDiagnosed).toBe(1);
  });

  it("transport duplicate と semantic duplicate は legacy presentation 前で抑止される", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_REPORT_DATE_TIME));
    const outcomes: ProcessOutcome[] = [];
    const { handler, stats } = createMessageHandler({ outcomeTaps: [outcome => outcomes.push(outcome as ProcessOutcome)] });
    const first = makeLegacyMessage("VXWW50", "legacy-duplicate", "VXWW50:first");
    handler(first);
    handler(first);
    handler(withNewMessageId(first, "VXWW50:second"));

    expect(outcomes).toHaveLength(0);
    expect(stats.getSnapshot().countByType.get("VXWW50")).toBe(1);
    vi.advanceTimersByTime(60_001);
    const snapshot = stats.getSnapshot();
    expect(outcomes).toHaveLength(1);
    expect(snapshot.countByType.get("VXWW50")).toBe(1);
    expect(snapshot.categoryByType.get("VXWW50")).toBe("other");
    expect(snapshot.foundation.transportDuplicate).toBe(1);
    expect(snapshot.foundation.semanticDuplicate).toBe(1);
  });

  it("EventID 有/無の presentation identity、summary、formatter、ticker を専用経路で生成する", () => {
    const secretMarker = "PHASE6B_RAW_SECRET_MARKER";
    const message = makeLegacyMessage(
      "VPOA50",
      "legacy-stable",
      "VPOA50:with-event",
      `<SECRET>${secretMarker}</SECRET>`,
    );
    const wirePayload = message.body;
    const withEventId = expectOutcome(
      processMessage(message, "legacyCounterpart", makeProcessDeps()),
    );
    if (withEventId.domain !== "legacyCounterpart") throw new Error("expected legacy counterpart outcome");
    const event = toPresentationEvent(withEventId);
    expect(event.id).toBe("legacy:VPOA50:legacy-stable");
    expect(event.domain).toBe("legacyCounterpart");
    expect(event.raw).toMatchObject({ type: "VPOA50" });
    const parsedJson = JSON.stringify(withEventId.parsed);
    const eventJson = JSON.stringify(event);
    expect(parsedJson).not.toContain(secretMarker);
    expect(parsedJson).not.toContain(wirePayload);
    expect(eventJson).not.toContain(secretMarker);
    expect(eventJson).not.toContain(wirePayload);
    expect(event.legacyReason).toBe("counterpartRuleUnconfirmed");
    expect(event.legacySeverity).toBe("unknown");

    const noEventId = toPresentationEvent(expectOutcome(
      processMessage(makeLegacyMessage("VPNO50", null, "VPNO50:no-event"), "legacyCounterpart", makeProcessDeps()),
    ));
    expect(noEventId.id).toBe("legacy:VPNO50:VPNO50:no-event");
    expect(noEventId.eventId).toBeNull();

    const summary = buildSummaryTokens(event, buildSummaryModel(event)).map((item) => item.text).join(" ");
    expect(summary).toContain("対応電文未確認");
    expect(summary).toContain("VPOA50");
    expect(summary).not.toContain(secretMarker);
    expect(summary).not.toContain(wirePayload);

    const dto = projectDisplayEvent(event, summary);
    expect(dto.id).toBe("legacy:VPOA50:legacy-stable");
    expect(dto.eventKey).toBe(
      `legacy:VPOA50:legacy-stable:revision:${JSON.stringify([
        event.serial,
        event.reportDateTime,
        "VPOA50:with-event",
      ])}`,
    );
    expect(dto.groupKey).toBeNull();
    expect(dto.tickerCategory).toBe("旧形式防災情報");
    expect(dto.tickerDetail).toContain("対応電文未確認");
    expect(dto.tickerSentence).toContain("対応電文未確認");
    const dtoJson = JSON.stringify(dto);
    expect(dtoJson).not.toContain(secretMarker);
    expect(dtoJson).not.toContain(wirePayload);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
    displayLegacyCounterpartInfo(withEventId.parsed, withEventId.reason);
    const output = logs.join("\n");
    expect(output).toContain("VPOA50");
    expect(output).toContain("旧形式のタイトル");
    expect(output).toContain("対応電文未確認");
    expect(output).toContain("テスト官署");
    expect(output).not.toContain(secretMarker);
    expect(output).not.toContain(wirePayload);
  });

  it("legacy 表示境界は title・headline・地域名の改行、C0/C1、ANSI を単一行へ正規化する", () => {
    const source = makeLegacyMessage("VXWW50", "legacy-controls", "VXWW50:controls");
    if (source.xmlReport == null) throw new Error("fixture envelope is missing");
    const message = normalizeTelegramMessage({
      ...source,
      xmlReport: {
        ...source.xmlReport,
        control: {
          ...source.xmlReport.control,
          title: "制御\n電文\x00\x85\x1B[999m赤\x1B[0m",
        },
        head: {
          ...source.xmlReport.head,
          title: "旧形式\nタイトル\x00\x85\x1B[999m赤\x1B[0m",
          headline: "見出し\r\n続き\x1F\x9F\x1B[999m緑\x1B[0m",
        },
      },
      meta: undefined,
    }).message;
    const outcome = expectOutcome(processMessage(message, "legacyCounterpart", makeProcessDeps()));
    if (outcome.domain !== "legacyCounterpart") throw new Error("expected legacy counterpart outcome");
    const baseEvent = toPresentationEvent(outcome);
    const event = {
      ...baseEvent,
      areaNames: ["北\n地域\x80\x1B[999m青\x1B[0m"],
      legacyAreas: [{ code: "01\x00\x9FCODE", name: "北\n地域\x80\x1B[999m青\x1B[0m" }],
    };

    const tokens = buildSummaryTokens(event, buildSummaryModel(event));
    const summary = tokens.map((item) => item.text).join(" ");
    expect(summary).toContain("旧形式 タイトル赤");
    expect(summary).toContain("見出し 続き緑");
    expect(summary).toContain("北 地域青");
    for (const item of tokens) expect(item.text).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);

    const dto = projectDisplayEvent(event, summary);
    expect(dto.title).toBe("旧形式 タイトル赤");
    expect(dto.headline).toBe("見出し 続き緑");
    expect(dto.tickerDetail).toContain("見出し 続き緑");
    expect(dto.tickerDetail).toContain("北 地域青（01CODE）");
    expect(dto.tickerSentence).toContain("見出し 続き緑");
    expect(dto.tickerSentence).toContain("北 地域青（01CODE）");
    expect(dto.tickerDetail).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(dto.tickerSentence).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(JSON.stringify(dto)).not.toContain("\x1B[999m");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
    displayLegacyCounterpartInfo(outcome.parsed, outcome.reason);
    const output = logs.join("\n");
    expect(output).toContain("制御 電文赤");
    expect(output).toContain("旧形式 タイトル赤");
    expect(output).toContain("見出し 続き緑");
    expect(output).not.toContain("\x1B[999m");
    expect(output).not.toContain("\x85");
    expect(output).not.toContain("\x9F");
  });
});
