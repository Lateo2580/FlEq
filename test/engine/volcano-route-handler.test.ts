import { testTelegramMeta } from "../helpers/telegram-meta";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ParsedVolcanoAlertInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoTextInfo,
  WsDataMessage,
} from "../../src/types";
import type { ProcessOutcome, VolcanoBatchOutcome } from "../../src/engine/presentation/types";
import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";
import { VolcanoRouteHandler } from "../../src/engine/messages/volcano-route-handler";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";

vi.mock("../../src/dmdata/volcano-parser", () => ({
  parseVolcanoTelegram: vi.fn(),
}));

function createMessage(id: string, headType: string): WsDataMessage {
  return {
    type: "data",
    version: "2.0",
    classification: "telegram.volcano",
    id,
    passing: [],
    head: {
      type: headType,
      author: "JMA",
      time: "2025-01-01T00:00:00+09:00",
      test: false,
      xml: true,
    },
    format: "xml",
    compression: null,
    encoding: "utf-8",
    body: "",
  };
}

function createVfvo53(): ParsedVolcanoAshfallInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "ashfall",
    type: "VFVO53",
    subKind: "scheduled",
    infoType: "発表",
    title: "降灰予報（定時）",
    reportDateTime: "2025-01-01T09:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: "+31.58+130.66/",
    isTest: false,
    craterName: "南岳山頂火口",
    ashForecasts: [],
    plumeHeight: 1000,
    plumeDirection: "南東",
    bodyText: "定時の降灰予報",
  };
}

function createFlashReport(): ParsedVolcanoEruptionInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "eruption",
    type: "VFVO56",
    infoType: "発表",
    title: "噴火速報",
    reportDateTime: "2025-01-01T09:01:00+09:00",
    eventDateTime: "2025-01-01T09:00:30+09:00",
    headline: "桜島で噴火が発生",
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: "+31.58+130.66/",
    isTest: false,
    phenomenonCode: "52",
    phenomenonName: "噴火",
    craterName: "南岳山頂火口",
    plumeHeight: null,
    plumeHeightUnknown: true,
    plumeDirection: null,
    isFlashReport: true,
    bodyText: "噴火速報本文",
  };
}

function createAlert(
  reportDateTime: string,
  action: ParsedVolcanoAlertInfo["action"],
  alertLevel: ParsedVolcanoAlertInfo["alertLevel"],
): ParsedVolcanoAlertInfo {
  return {
    meta: createTelegramMeta({
      messageId: `volcano-${reportDateTime}-${action}`,
      eventId: "volcano-alert-506",
      type: "VFVO50",
      reportDateTime,
      serial: null,
      infoType: "発表",
      receivedAtMs: Date.parse(reportDateTime),
      status: "通常",
      isTest: false,
    }),
    domain: "volcano",
    kind: "alert",
    type: "VFVO50",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime,
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: "+31.58+130.66/",
    isTest: false,
    alertLevel,
    alertLevelCode: String(10 + (alertLevel ?? 0)),
    alertClass: null,
    action,
    previousLevelCode: null,
    warningKind: action === "release" ? "噴火予報" : "噴火警報",
    municipalities: [],
    marineAreas: [],
    marineWarningKind: null,
    marineAlertLevelCode: null,
    bodyText: "",
    preventionText: "",
    isMarine: false,
  };
}

function createWarningClassText(code: "22" | "23"): ParsedVolcanoTextInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "text",
    type: "VFVO51",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime: "2025-01-01T09:00:00+09:00",
    eventDateTime: null,
    headline: "火山の状況に関する解説情報",
    publishingOffice: "気象庁",
    volcanoName: "",
    volcanoCode: "",
    coordinate: null,
    isTest: false,
    alertLevel: null,
    alertLevelCode: null,
    alertClasses: [{
      volcanoCode: "506",
      volcanoName: "桜島",
      alertClass: {
        code,
        name: code === "22" ? "火口周辺危険" : "入山危険",
        severity: "warning",
        isActive: true,
      },
    }],
    isExtraordinary: false,
    bodyText: "",
    nextAdvisory: null,
  };
}

describe("VolcanoRouteHandler", () => {
  const parseMock = vi.mocked(parseVolcanoTelegram);
  let state: VolcanoStateHolder;
  let outcomes: Array<ProcessOutcome | VolcanoBatchOutcome>;
  let notifyVolcano: ReturnType<typeof vi.fn>;
  let displayVolcano: ReturnType<typeof vi.fn>;
  let handler: VolcanoRouteHandler;

  beforeEach(() => {
    parseMock.mockReset();
    state = new VolcanoStateHolder();
    outcomes = [];
    notifyVolcano = vi.fn();
    displayVolcano = vi.fn();
    handler = new VolcanoRouteHandler({
      volcanoState: state,
      notifier: {
        notifyVolcano,
        notifyVolcanoBatch: vi.fn(),
      } as never,
      runDisplayPipeline: (outcome, displayFn) => {
        outcomes.push(outcome);
        displayFn();
        return true;
      },
      display: {
        displayVolcano,
        displayVolcanoBatch: vi.fn(),
      } as never,
    });
  });

  it("keeps each source message across a same-volcano interrupt flush", () => {
    const bufferedMsg = createMessage("vfvo53-message", "VFVO53");
    const interruptMsg = createMessage("vfvo56-message", "VFVO56");
    parseMock
      .mockReturnValueOnce(createVfvo53())
      .mockReturnValueOnce(createFlashReport());

    handler.handle(bufferedMsg);
    handler.handle(interruptMsg);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => ({
      id: outcome.msg.id,
      headType: outcome.headType,
      parsedType: (outcome.parsed as ParsedVolcanoInfo).type,
    }))).toEqual([
      { id: "vfvo53-message", headType: "VFVO53", parsedType: "VFVO53" },
      { id: "vfvo56-message", headType: "VFVO56", parsedType: "VFVO56" },
    ]);
    expect(displayVolcano).toHaveBeenCalledTimes(2);
  });

  it("suppresses an older warning that arrives after a release", () => {
    handler = new VolcanoRouteHandler({
      volcanoState: state,
      notifier: { notifyVolcano, notifyVolcanoBatch: vi.fn() } as never,
      revisionGate: new TelegramRevisionGate(),
      runDisplayPipeline: (outcome, displayFn) => {
        outcomes.push(outcome);
        displayFn();
        return true;
      },
      display: { displayVolcano, displayVolcanoBatch: vi.fn() } as never,
    });
    const warning = createAlert("2025-01-01T10:00:00+09:00", "issue", 3);
    const release = createAlert("2025-01-01T12:00:00+09:00", "release", 1);
    const staleWarning = createAlert("2025-01-01T11:00:00+09:00", "issue", 3);
    parseMock
      .mockReturnValueOnce(warning)
      .mockReturnValueOnce(release)
      .mockReturnValueOnce(staleWarning);

    handler.handle(createMessage("warning", "VFVO50"));
    handler.handle(createMessage("release", "VFVO50"));
    handler.handle(createMessage("stale-warning", "VFVO50"));

    expect(state.getEntry("506")).toBeUndefined();
    expect(outcomes.map((outcome) => outcome.msg.id)).toEqual(["warning", "release"]);
    expect(notifyVolcano).toHaveBeenCalledTimes(2);
    expect(displayVolcano).toHaveBeenCalledTimes(2);
  });

  it.each(["22", "23"] as const)(
    "VFVO51 Code %s の warning 音を notifyVolcano まで渡す",
    (code) => {
      const info = createWarningClassText(code);
      parseMock.mockReturnValueOnce(info);

      handler.handle(createMessage(`vfvo51-${code}`, "VFVO51"));

      expect(notifyVolcano).toHaveBeenCalledWith(
        info,
        expect.objectContaining({ soundLevel: "warning" }),
      );
    },
  );
});
