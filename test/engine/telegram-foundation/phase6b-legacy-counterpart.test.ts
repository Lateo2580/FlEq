import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";
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
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import {
  LEGACY_COUNTERPART_BODY_EXTRACTORS,
  parseLegacyCounterpart,
} from "../../../src/dmdata/legacy-counterpart-parser";
import { displayLegacyCounterpartInfo } from "../../../src/ui/legacy-counterpart-formatter";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
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
