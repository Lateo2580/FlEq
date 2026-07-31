import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { WsDataMessage } from "../../../src/types";
import { notifyMock } from "../../setup";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPWS50_AGGREGATE,
  readFixture,
} from "../../helpers/mock-message";

function withHead(xml: string, infoType: string, serial: string, reportDateTime: string): string {
  return xml
    .replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${infoType}</InfoType>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${serial}</Serial>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${reportDateTime}</ReportDateTime>`);
}

function message(xml: string, id: string): WsDataMessage {
  return { ...createMockWsDataMessageFromXml(xml, "VPWS50"), id, meta: undefined };
}

function display(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(), displayRawHeader: vi.fn(), displayTelegramDiagnostic: vi.fn(),
    displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn(), getDisplayMode: () => "normal",
    renderSummaryLine: () => "summary",
  };
}

describe("Phase 3B VPWS50 router", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("同一 revision の訂正を一回だけ表示・通知し、別 transport ID の再送を semantic reject する", () => {
    const base = readFixture(FIXTURE_VPWS50_AGGREGATE);
    const time = "2026-07-30T10:00:00+09:00";
    const normal = withHead(base, "発表", "1", time);
    const correction = withHead(base, "訂正", "1", time);
    const events: PresentationEvent[] = [];
    const sink: DisplayIngestSink = { ingest: (event) => events.push(event) };
    const decisions: boolean[] = [];
    const { handler, stats, notifier } = createMessageHandler({
      display: display(),
      displaySink: sink,
      onVpws50RevisionDecision: (decision) => decisions.push(decision.accepted),
    });
    const notifyWeather = vi.spyOn(notifier, "notifyWeatherWarning");
    handler(message(normal, "vpws-normal"));
    notifyWeather.mockClear();
    handler(message(correction, "vpws-correction-1"));
    handler(message(correction, "vpws-correction-2"));

    expect(events.filter((event) => event.infoType === "訂正")).toHaveLength(1);
    expect(notifyWeather).toHaveBeenCalledTimes(1);
    expect(notifyWeather.mock.calls[0][0].infoType).toBe("訂正");
    expect(stats.getSnapshot().foundation).toMatchObject({
      correctionReplaced: 1,
      correctionNotified: 1,
      semanticDuplicate: 1,
      notified: 2,
      presented: 2,
    });
    expect(decisions).toEqual([true, true, false]);
  }, 20_000);

  it("invalid ReportDateTime は診断表示だけに流し、active state と通知を変えない", () => {
    const base = readFixture(FIXTURE_VPWS50_AGGREGATE);
    const shown = display();
    const events: PresentationEvent[] = [];
    const { handler, vpws50State } = createMessageHandler({
      display: shown,
      displaySink: { ingest: (event) => events.push(event) },
    });
    handler(message(withHead(base, "発表", "1", "invalid-date"), "vpws-invalid"));
    expect(shown.displayTelegramDiagnostic).toHaveBeenCalledTimes(1);
    expect(vpws50State.getCurrentAreasForDisplay()).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].domain).toBe("raw");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("通常報と取消の presented/notified を foundation stats に記録する", () => {
    const base = readFixture(FIXTURE_VPWS50_AGGREGATE);
    const time = "2026-07-30T10:00:00+09:00";
    const { handler, stats } = createMessageHandler({
      display: display(),
      displaySink: { ingest: vi.fn() },
    });
    handler(message(withHead(base, "発表", "1", time), "vpws-normal-metrics"));
    handler(message(withHead(base, "取消", "1", time), "vpws-cancel-metrics"));
    expect(stats.getSnapshot().foundation).toMatchObject({
      cancelApplied: 1,
      notified: 2,
      presented: 2,
    });
  }, 20_000);
});
