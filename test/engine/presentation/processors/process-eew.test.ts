import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { fromEewOutcome } from "../../../../src/engine/presentation/events/from-eew";
import { projectDisplayEvent } from "../../../../src/engine/display/project-event";
import { DisplayStateStore } from "../../../../src/engine/display/state-store";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_FINAL,
  readFixture,
} from "../../../helpers/mock-message";

// fs mock for EewEventLogger
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

describe("processEew", () => {
  let eewTracker: EewTracker;
  let eewLogger: EewEventLogger;

  beforeEach(() => {
    eewTracker = new EewTracker();
    eewLogger = new EewEventLogger();
  });

  const vxse45Capability = {
    getDeliveryCapabilities: () => ({
      connected: true,
      effectiveClassifications: ["eew.forecast"],
      guaranteedHeadTypes: new Set(["VXSE45"]),
      source: "contract-and-socket" as const,
    }),
  };

  function phase4aEewXml(
    eventId: string,
    serial: string,
    forecastInt: string,
    options?: { regionless?: boolean },
  ): string {
    let xml = readFixture("synthetic_phase4a_VXSE45_special.xml")
      .replace("<EventID>synthetic-phase4a-eew</EventID>", `<EventID>${eventId}</EventID>`)
      .replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`)
      .replace(
        /<ForecastInt\b[^>]*(?:\/>|>[\s\S]*?<\/ForecastInt>)/g,
        forecastInt,
      );
    if (options?.regionless) {
      xml = xml.replace(/\s*<Pref>[\s\S]*?<\/Pref>/g, "");
    }
    return xml;
  }

  it("正常な EEW を処理して ok + EewOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.domain).toBe("eew");
    expect(result.outcome.parsed.isWarning).toBe(true);
    expect(result.outcome.presentation.frameLevel).toBe("critical");
    expect(result.outcome.presentation.soundLevel).toBe("critical");
    expect(result.outcome.stats.shouldRecord).toBe(true);
    expect(result.outcome.stats.eventId).toBeDefined();
    expect(result.outcome.statsCategory).toBe("eew");
  });

  it("重複報は duplicate を返す", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg2, eewTracker, eewLogger);
    expect(result.kind).toBe("duplicate");
  });

  it("異なる Serial は ok を返す", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S2);
    const result = processEew(msg2, eewTracker, eewLogger);
    expect(result.kind).toBe("ok");
  });

  it("パース失敗は parse-failed を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "eew.forecast",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const result = processEew(msg, eewTracker, eewLogger);
    expect(result.kind).toBe("parse-failed");
  });

  it("取消報の frameLevel は cancel", () => {
    const first = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    processEew(first, eewTracker, eewLogger);

    const cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL);
    const result = processEew(cancel, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.presentation.frameLevel).toBe("cancel");
    expect(result.outcome.presentation.soundLevel).toBe("cancel");
  });

  it("capability unknown では VXSE44 を fail-open で通常処理する", () => {
    const msg44 = createMockWsDataMessage(FIXTURE_VXSE44_S10);
    const result = processEew(msg44, eewTracker, eewLogger);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.eewResult.isSuppressed).toBe(false);
    expect(result.outcome.eewResult.firstReportSignal).toBe(true);
  });

  it("fail-open VXSE44 で logger を開始し後続 VXSE45 は同じ event log へ追記する", async () => {
    const fs = await import("fs");
    const appendFile = vi.mocked(fs.promises.appendFile);
    appendFile.mockClear();

    const first44 = processEew(
      createMockWsDataMessage(FIXTURE_VXSE44_S10),
      eewTracker,
      eewLogger,
    );
    const later45 = processEew(
      createMockWsDataMessage(FIXTURE_VXSE45_S1),
      eewTracker,
      eewLogger,
    );
    expect(first44.kind).toBe("ok");
    expect(later45.kind).toBe("ok");
    await eewLogger.flush();

    expect(appendFile).toHaveBeenCalledTimes(2);
    expect(String(appendFile.mock.calls[0][1])).toContain("記録開始:");
    expect(String(appendFile.mock.calls[1][1])).not.toContain("記録開始:");
  });

  it("capability 抑止 VXSE44 も共通 revision gate を通り、同一報の再送は duplicate", () => {
    const first = createMockWsDataMessage(FIXTURE_VXSE44_S10);
    const repeated = {
      ...createMockWsDataMessage(FIXTURE_VXSE44_S10),
      id: "vxse44-backup",
      meta: undefined,
    };

    expect(processEew(first, eewTracker, eewLogger, vxse45Capability).kind).toBe("suppressed");
    expect(processEew(repeated, eewTracker, eewLogger, vxse45Capability).kind).toBe("duplicate");
  });

  it("VXSE45 受信済みイベントの VXSE44 も suppressed を返す", () => {
    // First, process VXSE45
    const msg45 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const result45 = processEew(msg45, eewTracker, eewLogger);
    expect(result45.kind).toBe("ok");

    // Then process VXSE44 with the same eventId
    const msg44 = createMockWsDataMessage(FIXTURE_VXSE44_S10);
    const result44 = processEew(msg44, eewTracker, eewLogger);
    expect(result44.kind).toBe("suppressed");
  });

  it("capability-suppressed VXSE44 は latch を消費せず後続 VXSE45 が第1報 signal を得る", () => {
    const msg44 = createMockWsDataMessage(FIXTURE_VXSE44_S10);
    const result44 = processEew(msg44, eewTracker, eewLogger, vxse45Capability);
    expect(result44.kind).toBe("suppressed");

    const msg45 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const result45 = processEew(msg45, eewTracker, eewLogger);
    expect(result45.kind).toBe("ok");
    if (result45.kind !== "ok") return;
    expect(result45.outcome.eewResult.isNew).toBe(true);
    expect(result45.outcome.eewResult.firstReportSignal).toBe(true);
  });

  it("実 processor 経路の VXSE44 known → VXSE45 unknown は表示 snapshot だけ置換し safety rank を継承する", () => {
    const eventId = "phase4a-process-44-45";
    const knownXml = phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>6-</From><To>6-</To></ForecastInt>",
    );
    expect(processEew(
      createMockWsDataMessageFromXml(knownXml, "VXSE44"),
      eewTracker,
      eewLogger,
      vxse45Capability,
    ).kind).toBe("suppressed");

    const unknownXml = phase4aEewXml(
      eventId,
      "1",
      '<ForecastInt condition="未入電"/>',
    );
    const result = processEew(
      createMockWsDataMessageFromXml(unknownXml, "VXSE45"),
      eewTracker,
      eewLogger,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.eewResult.isNew).toBe(true);
    expect(result.outcome.eewResult.currentForecastIntensity?.summaryLabel).toBe("未入電");
    expect(result.outcome.eewResult.effectiveForecastSafetyRank).toBe(7);

    const event = {
      ...fromEewOutcome(result.outcome),
      hypocenterName: "合成震源",
    };
    const dto = projectDisplayEvent(event, "summary");
    expect(event.forecastMaxInt).toBe("未入電");
    expect(event.forecastMaxIntRank).toBe(7);
    expect(dto.emergency).toMatchObject({
      kind: "eew",
      forecastMaxInt: "未入電",
      forecastMaxIntRank: 7,
    });
    expect(dto.tickerSentence).toContain("予想最大震度未入電");
    expect(dto.tickerSentence).not.toContain("予想最大震度6弱");
  });

  it("実 processor 経路の VXSE43 4 → VXSE44 6弱 → VXSE45 unknown は VXSE44 safety rank を継承する", () => {
    const eventId = "phase4a-process-43-44-45";
    const first43 = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>4</From><To>4</To></ForecastInt>",
    ), "VXSE43"), eewTracker, eewLogger);
    expect(first43.kind).toBe("ok");
    if (first43.kind !== "ok") return;
    expect(first43.outcome.eewResult.effectiveForecastSafetyRank).toBe(4);

    expect(processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>6-</From><To>6-</To></ForecastInt>",
    ), "VXSE44"), eewTracker, eewLogger, vxse45Capability).kind).toBe("suppressed");

    const unknown45 = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      '<ForecastInt condition="未入電"/>',
    ), "VXSE45"), eewTracker, eewLogger);
    expect(unknown45.kind).toBe("ok");
    if (unknown45.kind !== "ok") return;
    expect(unknown45.outcome.eewResult.currentForecastIntensity?.summaryLabel).toBe("未入電");
    expect(unknown45.outcome.eewResult.effectiveForecastSafetyRank).toBe(7);
  });

  it("VXSE43 serial 3 → 初回 VXSE45 serial 1 を display の type-local gate が受理する", () => {
    const eventId = "phase4a-display-type-local";
    const display = new DisplayStateStore();
    const report43 = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "3",
      "<ForecastInt><From>4</From><To>4</To></ForecastInt>",
    ), "VXSE43"), eewTracker, eewLogger);
    expect(report43.kind).toBe("ok");
    if (report43.kind !== "ok") return;
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(report43.outcome), "summary"),
      Date.now(),
    )).toBe(true);

    const report45 = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>5-</From><To>5-</To></ForecastInt>",
    ), "VXSE45"), eewTracker, eewLogger);
    expect(report45.kind).toBe("ok");
    if (report45.kind !== "ok") return;
    const dto45 = projectDisplayEvent(fromEewOutcome(report45.outcome), "summary");
    expect(dto45.emergency).toMatchObject({ sourceType: "VXSE45", serial: "1" });
    expect(display.applyEvent(dto45, Date.now() + 1_000)).toBe(true);
    expect(display.snapshot(1, Date.now() + 1_000).activeEews[0]).toMatchObject({
      sourceType: "VXSE45",
      serial: "1",
    });
  });

  it("VXSE43 6弱 → VXSE44 4 → VXSE45 unknown は safety cache で逆降格しない", () => {
    const eventId = "phase4a-process-cache-no-downgrade";
    expect(processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>6-</From><To>6-</To></ForecastInt>",
    ), "VXSE43"), eewTracker, eewLogger).kind).toBe("ok");

    expect(processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>4</From><To>4</To></ForecastInt>",
    ), "VXSE44"), eewTracker, eewLogger, vxse45Capability).kind).toBe("suppressed");

    const unknown45 = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      '<ForecastInt condition="未入電"/>',
    ), "VXSE45"), eewTracker, eewLogger);
    expect(unknown45.kind).toBe("ok");
    if (unknown45.kind !== "ok") return;
    expect(unknown45.outcome.eewResult.effectiveForecastSafetyRank).toBe(7);
  });

  it("VXSE45 6弱 → 抑止 VXSE43 4 → VXSE45 unknown でも EventID safety rank は6弱を維持する", () => {
    const eventId = "phase4a-suppressed-43";
    expect(processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>6-</From><To>6-</To></ForecastInt>",
    ), "VXSE45"), eewTracker, eewLogger).kind).toBe("ok");

    expect(processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "1",
      "<ForecastInt><From>4</From><To>4</To></ForecastInt>",
    ), "VXSE43"), eewTracker, eewLogger).kind).toBe("suppressed");

    const result = processEew(createMockWsDataMessageFromXml(phase4aEewXml(
      eventId,
      "2",
      '<ForecastInt condition="未入電"/>',
    ), "VXSE45"), eewTracker, eewLogger);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.eewResult.currentForecastIntensity?.summaryLabel).toBe("未入電");
    expect(result.outcome.eewResult.effectiveForecastSafetyRank).toBe(7);
  });

  it("地域なしの全体 5弱以上未入電を processor から presentation・display・ticker へ投影する", () => {
    const xml = phase4aEewXml(
      "phase4a-regionless",
      "1",
      '<ForecastInt condition="5弱以上未入電" description="予測震度は5弱以上"><From>5-</From></ForecastInt>',
      { regionless: true },
    );
    const result = processEew(
      createMockWsDataMessageFromXml(xml, "VXSE45"),
      eewTracker,
      eewLogger,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const event = {
      ...fromEewOutcome(result.outcome),
      hypocenterName: "合成震源",
    };
    const dto = projectDisplayEvent(event, "summary");
    expect(event.forecastAreaCount).toBe(0);
    expect(event.forecastMaxInt).toBe("5弱以上未入電");
    expect(event.forecastMaxIntRank).toBe(5);
    expect(dto.emergency).toMatchObject({
      kind: "eew",
      forecastMaxInt: "5弱以上未入電",
      forecastMaxIntRank: 5,
      regions: [],
    });
    expect(dto.tickerSentence).toContain("予想最大震度5弱以上未入電");
  });

  it("VXSE45 受信済みイベントの VXSE44 取消報で finalizeEvent が呼ばれる (active カウントから外れる)", () => {
    // VXSE45 を先に処理 → eewTracker に event 登録
    const msg45 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const initial = processEew(msg45, eewTracker, eewLogger);
    expect(initial.kind).toBe("ok");
    if (initial.kind !== "ok") return;
    expect(eewTracker.getActiveCount()).toBe(1);
    const display = new DisplayStateStore();
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(initial.outcome), "summary"),
      Date.now(),
    )).toBe(true);
    expect(display.snapshot(1, Date.now()).activeEews).toHaveLength(1);

    const closeSpy = vi.spyOn(eewLogger, "closeEvent");
    const finalizeSpy = vi.spyOn(eewTracker, "finalizeEvent");

    // 同じ eventId の VXSE45_CANCEL XML (infoType=取消) を VXSE44 として送信。
    // tracker.update() は呼ばれないため、closeEvent + finalizeEvent を直接実行する。
    const msg44cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL, {
      classification: "eew.forecast",
      head: { type: "VXSE44", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const result = processEew(msg44cancel, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.eewResult.isSuppressed).toBe(true);
    expect(result.outcome.stats.shouldRecord).toBe(false);
    const cancelDto = projectDisplayEvent(fromEewOutcome(result.outcome), "summary");
    expect(cancelDto.emergency).toMatchObject({
      kind: "eew",
      sourceType: "VXSE44",
      isCancellation: true,
    });
    expect(display.applyEvent(cancelDto, Date.now() + 1_000)).toBe(true);
    expect(display.snapshot(2, Date.now() + 1_000).activeEews).toHaveLength(0);
    expect(closeSpy).toHaveBeenCalledWith("20240417231454", "取消");
    expect(finalizeSpy).toHaveBeenCalledWith("20240417231454");
    expect(eewTracker.getActiveCount()).toBe(0);
  });

  it("state フィールドが正しく設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.state.activeCount).toBeGreaterThanOrEqual(1);
    expect(result.outcome.state.colorIndex).toBeGreaterThanOrEqual(0);
  });

  it("抑制された取消報でも closeEvent が実行される", () => {
    // VXSE45 を先に処理 → hasSeen45 = true
    const msg45 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    processEew(msg45, eewTracker, eewLogger);

    const closeSpy = vi.spyOn(eewLogger, "closeEvent");

    // VXSE45_CANCEL の XML (infoType=取消, eventId=20240417231454) を
    // head.type=VXSE43 として送信 → 抑制 + 取消のライフサイクル処理
    const msg43cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL, {
      classification: "eew.warning",
      head: { type: "VXSE43", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const result = processEew(msg43cancel, eewTracker, eewLogger);

    expect(result.kind).toBe("suppressed");
    expect(closeSpy).toHaveBeenCalledWith("20240417231454", "取消");
  });

  it("抑制された最終報でも closeEvent + finalizeEvent が実行される", () => {
    // VXSE45_FINAL の eventId (20260101120000) で VXSE45 を先に処理
    const msg45 = createMockWsDataMessage(FIXTURE_VXSE45_FINAL);
    processEew(msg45, eewTracker, eewLogger);

    const closeSpy = vi.spyOn(eewLogger, "closeEvent");
    const finalizeSpy = vi.spyOn(eewTracker, "finalizeEvent");

    // 同じ XML (nextAdvisory 付き) を head.type=VXSE44 として送信 → 抑制 + 最終報処理
    const msg44final = createMockWsDataMessage(FIXTURE_VXSE45_FINAL, {
      classification: "eew.forecast",
      head: { type: "VXSE44", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const result = processEew(msg44final, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.eewResult.isSuppressed).toBe(true);
    expect(closeSpy).toHaveBeenCalledWith("20260101120000", "最終報");
    expect(finalizeSpy).toHaveBeenCalledWith("20260101120000");
  });

  it("VXSE44 最終報後の同一 serial 非最終訂正で active に戻る", () => {
    const finalXml = readFixture(FIXTURE_VXSE45_FINAL);
    const nonFinalXml = finalXml.replace(
      /<NextAdvisory>[^<]*<\/NextAdvisory>/,
      "",
    );
    const correctionXml = nonFinalXml.replace(
      "<InfoType>発表</InfoType>",
      "<InfoType>訂正</InfoType>",
    );

    const active45 = processEew(
      createMockWsDataMessageFromXml(nonFinalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    );
    expect(active45.kind).toBe("ok");
    if (active45.kind !== "ok") return;
    expect(eewTracker.getActiveCount()).toBe(1);
    const display = new DisplayStateStore();
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(active45.outcome), "summary"),
      1_000,
    )).toBe(true);
    expect(display.snapshot(1, 1_000).activeEews).toHaveLength(1);

    const final44 = processEew(
      createMockWsDataMessageFromXml(finalXml, "VXSE44"),
      eewTracker,
      eewLogger,
    );
    expect(final44.kind).toBe("ok");
    if (final44.kind !== "ok") return;
    expect(eewTracker.getActiveCount()).toBe(0);
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(final44.outcome), "summary"),
      2_000,
    )).toBe(true);
    expect(display.snapshot(2, 2_000).activeEews).toHaveLength(0);

    const correction44 = processEew(
      createMockWsDataMessageFromXml(correctionXml, "VXSE44"),
      eewTracker,
      eewLogger,
    );
    expect(correction44.kind).toBe("ok");
    if (correction44.kind !== "ok") return;
    expect(correction44.outcome.eewResult.isSuppressed).toBe(true);
    expect(correction44.outcome.stats.shouldRecord).toBe(false);
    expect(correction44.outcome.parsed.type).toBe("VXSE45");
    expect(eewTracker.getActiveCount()).toBe(1);
    const restoredDto = projectDisplayEvent(
      fromEewOutcome(correction44.outcome),
      "summary",
    );
    expect(restoredDto.emergency).toMatchObject({
      kind: "eew",
      sourceType: "VXSE45",
      isFinal: false,
      isCancellation: false,
      isCorrection: false,
      restoreRevision: {
        sourceType: "VXSE44",
        serial: "30",
        isCorrection: true,
      },
    });
    expect(display.applyEvent(restoredDto, 3_000)).toBe(true);
    expect(display.snapshot(3, 3_000).activeEews).toHaveLength(1);
  });

  it("VXSE43 取消後に拒否された VXSE45 は hasSeen45 を立てず、VXSE43 訂正で表示を復元する", () => {
    const normalXml = readFixture(FIXTURE_VXSE45_S1);
    const cancelXml = readFixture(FIXTURE_VXSE45_CANCEL);
    const correction43Xml = normalXml
      .replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")
      .replace("<Serial>1</Serial>", "<Serial>32</Serial>")
      .replace(
        "<ReportDateTime>2024-04-17T23:14:57+09:00</ReportDateTime>",
        "<ReportDateTime>2024-04-17T23:17:00+09:00</ReportDateTime>",
      );
    const display = new DisplayStateStore();

    const active43 = processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE43"),
      eewTracker,
      eewLogger,
    );
    expect(active43.kind).toBe("ok");
    if (active43.kind !== "ok") return;
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(active43.outcome), "summary"),
      1_000,
    )).toBe(true);

    const cancelled43 = processEew(
      createMockWsDataMessageFromXml(cancelXml, "VXSE43"),
      eewTracker,
      eewLogger,
    );
    expect(cancelled43.kind).toBe("ok");
    if (cancelled43.kind !== "ok") return;
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(cancelled43.outcome), "summary"),
      2_000,
    )).toBe(true);
    expect(display.snapshot(2, 2_000).activeEews).toHaveLength(0);

    expect(processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    ).kind).toBe("suppressed");

    const correction43 = processEew(
      createMockWsDataMessageFromXml(correction43Xml, "VXSE43"),
      eewTracker,
      eewLogger,
    );
    expect(correction43.kind).toBe("ok");
    if (correction43.kind !== "ok") return;
    expect(correction43.outcome.eewResult.isSuppressed).toBe(false);
    expect(eewTracker.getActiveCount()).toBe(1);
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(correction43.outcome), "summary"),
      3_000,
    )).toBe(true);
    expect(display.snapshot(3, 3_000).activeEews).toHaveLength(1);
  });

  it("VXSE45 最終報後の初見 VXSE44 通常報では final を解除しない", () => {
    const finalXml = readFixture(FIXTURE_VXSE45_FINAL);
    const delayedNormalXml = finalXml.replace(
      /<NextAdvisory>[^<]*<\/NextAdvisory>/,
      "",
    );

    expect(processEew(
      createMockWsDataMessageFromXml(finalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    ).kind).toBe("ok");
    expect(eewTracker.getActiveCount()).toBe(0);

    expect(processEew(
      createMockWsDataMessageFromXml(delayedNormalXml, "VXSE44"),
      eewTracker,
      eewLogger,
    ).kind).toBe("suppressed");
    expect(eewTracker.getActiveCount()).toBe(0);
  });

  it("未作成 EventID の先行 VXSE44 終端を tombstone 化し、別 family の通常報を復活させない", () => {
    const finalXml = readFixture(FIXTURE_VXSE45_FINAL);
    const normalXml = finalXml.replace(
      /<NextAdvisory>[^<]*<\/NextAdvisory>/,
      "",
    );

    const terminal44 = processEew(
      createMockWsDataMessageFromXml(finalXml, "VXSE44"),
      eewTracker,
      eewLogger,
      vxse45Capability,
    );
    expect(terminal44.kind).toBe("ok");
    if (terminal44.kind !== "ok") return;
    expect(terminal44.outcome.eewResult.isSuppressed).toBe(true);
    expect(eewTracker.getActiveCount()).toBe(0);

    expect(processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE43"),
      eewTracker,
      eewLogger,
    ).kind).toBe("suppressed");
    expect(processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    ).kind).toBe("suppressed");
    expect(eewTracker.getActiveCount()).toBe(0);
  });

  it("VXSE45 取消後の初見 VXSE44 通常報では cancel を解除しない", () => {
    const normalXml = readFixture(FIXTURE_VXSE45_S1);
    const cancelXml = readFixture(FIXTURE_VXSE45_CANCEL);

    expect(processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    ).kind).toBe("ok");
    expect(processEew(
      createMockWsDataMessageFromXml(cancelXml, "VXSE45"),
      eewTracker,
      eewLogger,
    ).kind).toBe("ok");
    expect(eewTracker.getActiveCount()).toBe(0);

    expect(processEew(
      createMockWsDataMessageFromXml(normalXml, "VXSE44"),
      eewTracker,
      eewLogger,
    ).kind).toBe("suppressed");
    expect(eewTracker.getActiveCount()).toBe(0);
  });

  it("VXSE44 terminal 後の大 serial 非最終続報は同一 family として active に戻す", () => {
    const finalXml = readFixture(FIXTURE_VXSE45_FINAL);
    const nonFinalXml = finalXml.replace(
      /<NextAdvisory>[^<]*<\/NextAdvisory>/,
      "",
    );
    const newerXml = nonFinalXml.replace(
      /<Serial>[^<]*<\/Serial>/,
      "<Serial>99</Serial>",
    );

    const active45 = processEew(
      createMockWsDataMessageFromXml(nonFinalXml, "VXSE45"),
      eewTracker,
      eewLogger,
    );
    expect(active45.kind).toBe("ok");
    if (active45.kind !== "ok") return;
    const display = new DisplayStateStore();
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(active45.outcome), "summary"),
      1_000,
    )).toBe(true);

    const final44 = processEew(
      createMockWsDataMessageFromXml(finalXml, "VXSE44"),
      eewTracker,
      eewLogger,
    );
    expect(final44.kind).toBe("ok");
    if (final44.kind !== "ok") return;
    const finalDto = projectDisplayEvent(fromEewOutcome(final44.outcome), "summary");
    expect(display.applyEvent(finalDto, 2_000)).toBe(true);
    expect(display.snapshot(2, 2_000).activeEews).toHaveLength(0);
    expect(eewTracker.getActiveCount()).toBe(0);

    const reactivated = processEew(
      createMockWsDataMessageFromXml(newerXml, "VXSE44"),
      eewTracker,
      eewLogger,
    );
    expect(reactivated.kind).toBe("ok");
    if (reactivated.kind !== "ok") return;
    expect(reactivated.outcome.eewResult.isSuppressed).toBe(true);
    expect(reactivated.outcome.stats.shouldRecord).toBe(false);
    expect(eewTracker.getActiveCount()).toBe(1);
    const restoreDto = projectDisplayEvent(
      fromEewOutcome(reactivated.outcome),
      "summary",
    );
    expect(restoreDto.emergency).toMatchObject({
      kind: "eew",
      sourceType: "VXSE45",
      serial: "30",
      isCorrection: false,
      restoreRevision: {
        sourceType: "VXSE44",
        serial: "99",
        isCorrection: false,
      },
    });
    expect(display.applyEvent(restoreDto, 3_000)).toBe(true);
    expect(display.snapshot(3, 3_000).activeEews).toHaveLength(1);

    // Restore watermark は VXSE44 serial=99。後着した旧 final=30 は card を消せない。
    expect(display.applyEvent(finalDto, 4_000)).toBe(false);
    expect(display.snapshot(4, 4_000).activeEews).toHaveLength(1);
  });

  it("fail-open VXSE44 owner を capability 抑止の最終報後に同 family 続報で復元する", () => {
    const finalXml = readFixture(FIXTURE_VXSE45_FINAL);
    const nonFinalXml = finalXml
      .replace(/<NextAdvisory>[^<]*<\/NextAdvisory>/, "")
      .replace(/<Serial>[^<]*<\/Serial>/, "<Serial>29</Serial>")
      .replace(
        /<ReportDateTime>[^<]*<\/ReportDateTime>/,
        "<ReportDateTime>2026-01-01T12:00:29+09:00</ReportDateTime>",
      );
    const newerXml = nonFinalXml
      .replace(/<Serial>[^<]*<\/Serial>/, "<Serial>99</Serial>")
      .replace(
        /<ReportDateTime>[^<]*<\/ReportDateTime>/,
        "<ReportDateTime>2026-01-01T12:01:39+09:00</ReportDateTime>",
      );
    const display = new DisplayStateStore();

    const active44 = processEew(
      createMockWsDataMessageFromXml(nonFinalXml, "VXSE44"),
      eewTracker,
      eewLogger,
    );
    expect(active44.kind).toBe("ok");
    if (active44.kind !== "ok") return;
    expect(display.applyEvent(
      projectDisplayEvent(fromEewOutcome(active44.outcome), "summary"),
      1_000,
    )).toBe(true);
    expect(display.snapshot(1, 1_000).activeEews).toHaveLength(1);

    const final44 = processEew(
      createMockWsDataMessageFromXml(finalXml, "VXSE44"),
      eewTracker,
      eewLogger,
      vxse45Capability,
    );
    expect(final44.kind).toBe("ok");
    if (final44.kind !== "ok") return;
    const finalDto = projectDisplayEvent(fromEewOutcome(final44.outcome), "summary");
    expect(display.applyEvent(finalDto, 2_000)).toBe(true);
    expect(display.snapshot(2, 2_000).activeEews).toHaveLength(0);

    const reactivated = processEew(
      createMockWsDataMessageFromXml(newerXml, "VXSE44"),
      eewTracker,
      eewLogger,
      vxse45Capability,
    );
    expect(reactivated.kind).toBe("ok");
    if (reactivated.kind !== "ok") return;
    expect(reactivated.outcome.displayLifecycleOnly).toBe(true);
    expect(reactivated.outcome.eewResult.isSuppressed).toBe(true);
    expect(reactivated.outcome.parsed.type).toBe("VXSE44");
    expect({
      type: reactivated.outcome.msg.head.type,
      serial: reactivated.outcome.msg.xmlReport?.head.serial,
      infoType: reactivated.outcome.msg.xmlReport?.head.infoType,
      reportDateTime: reactivated.outcome.msg.xmlReport?.head.reportDateTime,
    }).toEqual({
      type: reactivated.outcome.parsed.type,
      serial: reactivated.outcome.parsed.serial,
      infoType: reactivated.outcome.parsed.infoType,
      reportDateTime: reactivated.outcome.parsed.reportDateTime,
    });
    expect({
      serial: reactivated.outcome.parsed.serial,
      infoType: reactivated.outcome.parsed.infoType,
      reportDateTime: reactivated.outcome.parsed.reportDateTime,
    }).toEqual({
      serial: "29",
      infoType: "発表",
      reportDateTime: "2026-01-01T12:00:29+09:00",
    });
    const restoreDto = projectDisplayEvent(
      fromEewOutcome(reactivated.outcome),
      "summary",
    );
    expect(restoreDto.emergency).toMatchObject({
      kind: "eew",
      sourceType: "VXSE44",
      serial: "29",
      restoreRevision: {
        sourceType: "VXSE44",
        serial: "99",
        isCorrection: false,
      },
    });
    expect(display.applyEvent(restoreDto, 3_000)).toBe(true);
    expect(display.snapshot(3, 3_000).activeEews).toHaveLength(1);
  });
});
