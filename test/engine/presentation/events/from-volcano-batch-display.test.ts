import { testTelegramMeta } from "../../../helpers/telegram-meta";
import { describe, expect, it } from "vitest";
import { expandVolcanoBatchForDisplay } from "../../../../src/engine/presentation/events/from-volcano";
import type { VolcanoBatchOutcome } from "../../../../src/engine/presentation/types";
import type { ParsedVolcanoAshfallInfo } from "../../../../src/types";
import type { WsDataMessage } from "../../../../src/types";
import { createMockWsDataMessage, FIXTURE_VFVO53_ASH_REGULAR } from "../../../helpers/mock-message";

function ashfall(over: Partial<ParsedVolcanoAshfallInfo>): ParsedVolcanoAshfallInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "ashfall",
    type: "VFVO53",
    subKind: "scheduled",
    infoType: "定時",
    title: "降灰予報",
    reportDateTime: "2026-07-10T12:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: null,
    isTest: false,
    craterName: null,
    ashForecasts: [],
    plumeHeight: null,
    plumeDirection: null,
    bodyText: "桜島の降灰予報です。",
    ...over,
  };
}

describe("expandVolcanoBatchForDisplay", () => {
  it("splits a VFVO53 batch into source-specific display events", () => {
    const firstMsg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
    const secondMsg: WsDataMessage = {
      ...firstMsg,
      id: "vfvo53-second-volcano",
      head: {
        ...firstMsg.head,
        time: "2026-07-10T12:05:00+09:00",
      },
      xmlReport: firstMsg.xmlReport == null
        ? undefined
        : {
          ...firstMsg.xmlReport,
          head: {
            ...firstMsg.xmlReport.head,
            eventId: "second-volcano-event",
            serial: "2",
            reportDateTime: "2026-07-10T12:05:00+09:00",
          },
        },
    };
    const firstInfo = ashfall({
      volcanoName: "桜島",
      volcanoCode: "506",
      bodyText: "桜島の降灰予報です。",
    });
    const secondInfo = ashfall({
      volcanoName: "霊島",
      volcanoCode: "503",
      bodyText: "霊島の降灰予報です。",
    });
    const outcome = {
      domain: "volcano",
      msg: firstMsg,
      headType: "VFVO53",
      statsCategory: "volcano",
      parsed: [firstInfo, secondInfo],
      isBatch: true,
      volcanoPresentation: { frameLevel: "normal", soundLevel: "normal", summary: "降灰予報" },
      batchReportDateTime: "2026-07-10T12:00:00+09:00",
      batchIsTest: false,
      stats: { shouldRecord: false },
      presentation: { frameLevel: "normal", soundLevel: "normal", notifyCategory: "volcano" },
      sources: [
        { info: firstInfo, msg: firstMsg },
        { info: secondInfo, msg: secondMsg },
      ],
    } as unknown as VolcanoBatchOutcome;

    const events = expandVolcanoBatchForDisplay(outcome);

    expect(events).toHaveLength(2);
    expect(events.map((event) => ({
      id: event.id,
      eventId: event.eventId,
      serial: event.serial,
      reportDateTime: event.reportDateTime,
      volcanoCode: event.volcanoCode,
      volcanoName: event.volcanoName,
    }))).toEqual([
      {
        id: firstMsg.id,
        eventId: firstMsg.xmlReport?.head.eventId ?? null,
        serial: firstMsg.xmlReport?.head.serial ?? null,
        reportDateTime: firstMsg.xmlReport?.head.reportDateTime ?? firstMsg.head.time,
        volcanoCode: "506",
        volcanoName: "桜島",
      },
      {
        id: secondMsg.id,
        eventId: "second-volcano-event",
        serial: "2",
        reportDateTime: "2026-07-10T12:05:00+09:00",
        volcanoCode: "503",
        volcanoName: "霊島",
      },
    ]);
    expect(events[0].bodyText).toContain("桜島");
    expect(events[0].bodyText).not.toContain("霊島");
    expect(events[1].bodyText).toContain("霊島");
    expect(events[1].bodyText).not.toContain("桜島");
  });
});
