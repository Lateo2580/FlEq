import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsDataMessage } from "../../../src/types";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { playSound } from "../../../src/engine/notification/sound-player";
import { notifyMock } from "../../setup";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE45_S1,
  readFixture,
} from "../../helpers/mock-message";

vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

const { appendFileMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (path: string) =>
      path.includes("eew-logs") || actual.existsSync(path),
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: appendFileMock,
    },
  };
});

function message(xml: string, id: string): WsDataMessage {
  return {
    ...createMockWsDataMessageFromXml(xml, "VXSE45"),
    id,
    meta: undefined,
  };
}

function replaceHeadValue(
  xml: string,
  element: "EventID" | "InfoType" | "Serial" | "ReportDateTime",
  value: string,
): string {
  return xml.replace(
    new RegExp(`<${element}>[^<]*</${element}>`),
    `<${element}>${value}</${element}>`,
  );
}

function correctionXml(input: {
  serial?: string;
  magnitude?: string;
} = {}): string {
  let xml = readFixture(FIXTURE_VXSE45_S1);
  xml = replaceHeadValue(xml, "InfoType", "訂正");
  if (input.serial != null) {
    xml = replaceHeadValue(xml, "Serial", input.serial);
  }
  if (input.magnitude != null) {
    xml = xml.replace(
      /(<jmx_eb:Magnitude[^>]*>)[^<]*(<\/jmx_eb:Magnitude>)/,
      `$1${input.magnitude}$2`,
    );
  }
  return xml;
}

function mockDisplay(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(),
    displayRawHeader: vi.fn(),
    displayTelegramDiagnostic: vi.fn(),
    displayVolcano: vi.fn(),
    displayVolcanoBatch: vi.fn(),
    getDisplayMode: () => "normal",
    renderSummaryLine: () => "summary",
  };
}

describe("Phase 3A EEW router", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    vi.mocked(playSound).mockClear();
    appendFileMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("同一 serial 訂正を表示へ渡し、訂正通知を一回だけ発行する", () => {
    const display = mockDisplay();
    const ingested: PresentationEvent[] = [];
    const { handler, stats } = createMessageHandler({
      display,
      displaySink: { ingest: (event) => ingested.push(event) },
    });
    handler(message(readFixture(FIXTURE_VXSE45_S1), "normal"));
    notifyMock.mockClear();
    vi.mocked(playSound).mockClear();

    handler(message(correctionXml({ magnitude: "4.5" }), "correction-1"));
    handler(message(correctionXml({ magnitude: "4.5" }), "correction-2"));

    const corrections = ingested.filter((event) => event.infoType === "訂正");
    expect(corrections).toHaveLength(1);
    expect(corrections[0].magnitude).toBe("4.5");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0].title).toContain("訂正");
    expect(vi.mocked(playSound)).toHaveBeenCalledTimes(1);
    expect(stats.getSnapshot().foundation).toMatchObject({
      correctionReplaced: 1,
      correctionNotified: 1,
      semanticDuplicate: 1,
    });
  });

  it("実質差分なしの訂正も一回通知する", () => {
    const { handler } = createMessageHandler({ display: mockDisplay() });
    handler(message(readFixture(FIXTURE_VXSE45_S1), "normal-no-diff"));
    notifyMock.mockClear();
    vi.mocked(playSound).mockClear();

    handler(message(correctionXml(), "correction-no-diff"));

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0].message).toContain("訂正");
    expect(vi.mocked(playSound)).toHaveBeenCalledTimes(1);
  });

  it("小さい serial の訂正は state を巻き戻さず通知しない", () => {
    const normalSerial2 = replaceHeadValue(
      readFixture(FIXTURE_VXSE45_S1),
      "Serial",
      "2",
    );
    const display = mockDisplay();
    const { handler, eewTracker, stats } = createMessageHandler({ display });
    handler(message(normalSerial2, "normal-2"));
    notifyMock.mockClear();
    vi.mocked(playSound).mockClear();

    handler(message(correctionXml({ serial: "1", magnitude: "4.5" }), "stale"));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(vi.mocked(playSound)).not.toHaveBeenCalled();
    expect(eewTracker.getActiveCount()).toBe(1);
    expect(stats.getSnapshot().foundation.stale).toBe(1);
  });

  it("primary/backup の同一 messageId は transport 層で一回だけ処理する", () => {
    const display = mockDisplay();
    const { handler, stats } = createMessageHandler({ display });
    const primary = message(readFixture(FIXTURE_VXSE45_S1), "shared-id");
    const backup = message(readFixture(FIXTURE_VXSE45_S1), "shared-id");

    handler(primary);
    handler(backup);

    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
    expect(stats.getSnapshot().foundation.transportDuplicate).toBe(1);
  });

  it("異なる transport ID の同一通常報を semantic gate で一回にする", () => {
    const display = mockDisplay();
    const { handler, stats } = createMessageHandler({ display });
    const xml = readFixture(FIXTURE_VXSE45_S1);

    handler(message(xml, "semantic-normal-1"));
    handler(message(xml, "semantic-normal-2"));

    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(stats.getSnapshot().foundation).toMatchObject({
      transportDuplicate: 0,
      semanticDuplicate: 1,
    });
  });

  it("EventID 欠落の訂正も gate 後に訂正通知し、同 payload 再送を拒否する", () => {
    const xml = replaceHeadValue(
      correctionXml({ magnitude: "4.5" }),
      "EventID",
      "",
    );
    const display = mockDisplay();
    const { handler, eewTracker, stats } = createMessageHandler({ display });

    handler(message(xml, "single-correction-1"));
    handler(message(xml, "single-correction-2"));

    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0].title).toContain("訂正");
    expect(eewTracker.getActiveCount()).toBe(0);
    expect(stats.getSnapshot().foundation).toMatchObject({
      correctionNotified: 1,
      semanticDuplicate: 1,
    });
  });

  it("EventID 欠落でも不正 serial は表示・通知しない", () => {
    let xml = replaceHeadValue(
      readFixture(FIXTURE_VXSE45_S1),
      "EventID",
      "",
    );
    xml = replaceHeadValue(xml, "Serial", "invalid");
    const display = mockDisplay();
    const { handler, stats } = createMessageHandler({ display });

    handler(message(xml, "single-invalid-revision"));

    expect(display.displayOutcome).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(stats.getSnapshot().foundation.invalidRevision).toBe(1);
  });

  it("invalid ReportDateTime は CLI と診断テロップだけへ出す", () => {
    const invalid = replaceHeadValue(
      readFixture(FIXTURE_VXSE45_S1),
      "ReportDateTime",
      "invalid-date",
    );
    const display = mockDisplay();
    const ingested: PresentationEvent[] = [];
    const sink: DisplayIngestSink = {
      ingest: (event) => ingested.push(event),
    };
    const { handler, eewTracker, stats } = createMessageHandler({
      display,
      displaySink: sink,
    });

    handler(message(invalid, "invalid-date"));

    expect(display.displayTelegramDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "20240417231454",
        reportDateTimeRaw: "invalid-date",
        receivedAtIso: expect.any(String),
        futureSkewMs: null,
      }),
    );
    expect(display.displayOutcome).not.toHaveBeenCalled();
    expect(eewTracker.getActiveCount()).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(vi.mocked(playSound)).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    const projected = projectDisplayEvent(ingested[0], "diagnostic");
    expect(projected).toMatchObject({
      tickerCategory: "診断",
      emergency: null,
      recentQuake: null,
      latestQuake: null,
    });
    expect(projected.tickerSentence).toContain("日時不正");
    expect(projected.tickerSentence).toContain("EventID");
    expect(projected.tickerSentence).toContain("受信時刻");
    expect(stats.getSnapshot().foundation.invalidDateDiagnosed).toBe(1);
  });

  it("15分超の未来日時を futureSkewExceeded として診断する", () => {
    const future = new Date(Date.now() + 16 * 60_000).toISOString();
    const xml = replaceHeadValue(
      readFixture(FIXTURE_VXSE45_S1),
      "ReportDateTime",
      future,
    );
    const display = mockDisplay();
    const { handler, stats } = createMessageHandler({ display });

    handler(message(xml, "future-date"));

    expect(display.displayTelegramDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "futureSkewExceeded",
        eventId: "20240417231454",
        receivedAtIso: expect.any(String),
        futureSkewMs: expect.any(Number),
      }),
    );
    const auditOutput = vi.mocked(console.log).mock.calls
      .flat()
      .map(String)
      .join("\n");
    expect(auditOutput).toContain("receivedAt=");
    expect(auditOutput).toContain("futureSkewMs=");
    expect(stats.getSnapshot().foundation.futureDateDiagnosed).toBe(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("15分以内の未来日時は通常の EEW として処理する", () => {
    const future = new Date(Date.now() + 14 * 60_000).toISOString();
    const xml = replaceHeadValue(
      readFixture(FIXTURE_VXSE45_S1),
      "ReportDateTime",
      future,
    );
    const display = mockDisplay();
    const { handler, eewTracker } = createMessageHandler({ display });

    handler(message(xml, "future-within-skew"));

    expect(display.displayTelegramDiagnostic).not.toHaveBeenCalled();
    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
    expect(eewTracker.getActiveCount()).toBe(1);
  });
});
