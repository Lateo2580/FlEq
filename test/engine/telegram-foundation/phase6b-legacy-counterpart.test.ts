import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";
import { classifyMessage } from "../../../src/engine/messages/route-catalog";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
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
  encodeXml,
  FIXTURE_VXSE51_SHINDO,
  readFixture,
} from "../../helpers/mock-message";

const SOURCE_TYPES = ["VPOA50", "VPNO50", "VXWW50"] as const;
const BASE_REPORT_DATE_TIME = "2026-08-11T09:00:00+09:00";
const BASE_XML = readFixture(FIXTURE_VXSE51_SHINDO);

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

describe("Phase 6B unit 2: legacy counterpart route and presentation slice", () => {
  afterEach(() => {
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
    expect(LEGACY_COUNTERPART_BODY_EXTRACTORS).toHaveLength(0);
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
    const outcomes: ProcessOutcome[] = [];
    const { handler, stats } = createMessageHandler({ outcomeTaps: [outcome => outcomes.push(outcome as ProcessOutcome)] });
    const first = makeLegacyMessage("VXWW50", "legacy-duplicate", "VXWW50:first");
    handler(first);
    handler(first);
    handler(withNewMessageId(first, "VXWW50:second"));

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
    expect(dto.eventKey).toBe(dto.id);
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
