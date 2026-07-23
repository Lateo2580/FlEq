import { describe, expect, it } from "vitest";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function volcanoEvent(over: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: "message-1",
    classification: "telegram.volcano",
    domain: "volcano",
    type: "VFVO53",
    infoType: "定時",
    title: "降灰予報",
    headline: null,
    reportDateTime: "2026-07-10T12:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "info",
    isCancellation: false,
    eventId: "volcano-event",
    serial: "1",
    volcanoCode: "506",
    volcanoName: "桜島",
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
    ...over,
  } as PresentationEvent;
}

describe("volcano display keys", () => {
  it("uses the volcano code in the replacement group (VFVO53 のみ)", () => {
    expect(projectDisplayEvent(volcanoEvent({ volcanoCode: "506" }), "要約").groupKey)
      .toBe("volcano:volcano-event:506");
    expect(projectDisplayEvent(volcanoEvent({ volcanoCode: "503" }), "要約").groupKey)
      .toBe("volcano:volcano-event:503");
    expect(projectDisplayEvent(volcanoEvent({ volcanoCode: "" }), "要約").groupKey)
      .toBe("volcano:volcano-event");
  });

  it("VFVO53 以外はコード有無に関わらず eventId 系列 (取消のコード欠落で系列分裂させない)", () => {
    // 実例: VFVO56 の取消は Body に VolcanoInfo が無くコードを取得できない
    // (test/fixtures/67_01_04)。発表(コードあり)と取消(コードなし)が同じ groupKey を持つこと
    const announce = projectDisplayEvent(
      volcanoEvent({ type: "VFVO56", volcanoCode: "312", eventId: "20140927120000_312" }), "要約");
    const cancel = projectDisplayEvent(
      volcanoEvent({ type: "VFVO56", volcanoCode: "", eventId: "20140927120000_312", isCancellation: true, infoType: "取消" }), "要約");
    expect(announce.groupKey).toBe("volcano:20140927120000_312");
    expect(cancel.groupKey).toBe(announce.groupKey);
    expect(cancel.eventKey).not.toBe(announce.eventKey); // 別電文としては区別される
  });

  it("keeps same-serial corrections distinct by volcano and report time", () => {
    const first = projectDisplayEvent(volcanoEvent({ volcanoCode: "506" }), "要約");
    const second = projectDisplayEvent(volcanoEvent({
      volcanoCode: "503",
      reportDateTime: "2026-07-10T12:05:00+09:00",
    }), "要約");
    expect(first.eventKey).not.toBe(second.eventKey);
    expect(first.eventKey).toBe("volcano:volcano-event:1:506:2026-07-10T12:00:00+09:00");
    expect(second.eventKey).toBe("volcano:volcano-event:1:503:2026-07-10T12:05:00+09:00");
  });
});
