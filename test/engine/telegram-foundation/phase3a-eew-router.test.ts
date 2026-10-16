import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsDataMessage } from "../../../src/types";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { playSound } from "../../../src/engine/notification/sound-player";
import { notifyMock } from "../../setup";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S3,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_S26,
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

function message(xml: string, id: string, type = "VXSE45"): WsDataMessage {
  return {
    ...createMockWsDataMessageFromXml(xml, type),
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

  // 2026-10-16 千島列島の誤報: 最終報 serial 42 の後に serial 37 の取消が届いた事象の合成。
  it("最終報の後に届いた古い serial の取消を受理し、テロップに1件出して active を空にする", () => {
    const olderCancel = replaceHeadValue(readFixture(FIXTURE_VXSE45_CANCEL), "Serial", "20");
    const olderNormal = replaceHeadValue(readFixture(FIXTURE_VXSE45_S1), "Serial", "21");
    const { feed, store, eewTracker, stats } = cancelHarness();
    const counts = () => ({
      notified: notifyMock.mock.calls.length,
      recorded: stats.getSnapshot().countByType.get("VXSE45") ?? 0,
    });

    expect(feed(finalXml("26"), "final-26")).toHaveLength(1);
    const beforeCancel = counts();
    const cancelled = feed(olderCancel, "cancel-20");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      isCancellation: true,
      tickerSuppressed: false,
      tickerSurface: "none",
      tickerBody: "先ほどの、緊急地震速報（地震動予報）を取り消します。",
    });
    expect(counts()).toEqual({
      notified: beforeCancel.notified + 1,
      recorded: beforeCancel.recorded + 1,
    });
    expect(store.snapshot(1, Date.now()).activeEews).toEqual([]);
    expect(eewTracker.getActiveCount()).toBe(0);

    const afterCancel = counts();
    expect(feed(olderNormal, "normal-21")).toEqual([]);
    expect(feed(olderCancel, "cancel-20-resend")).toEqual([]);
    expect(counts()).toEqual(afterCancel);
    expect(store.snapshot(2, Date.now()).activeEews).toEqual([]);
    expect(eewTracker.getActiveCount()).toBe(0);
  });

  it("最終報と同じ serial の取消も受理してテロップに出す", () => {
    const { feed, store } = cancelHarness();
    feed(finalXml("26"), "final-26");
    const cancelled = feed(
      replaceHeadValue(readFixture(FIXTURE_VXSE45_CANCEL), "Serial", "26"),
      "cancel-26",
    );
    expect(cancelled.filter((dto) => dto.tickerSuppressed !== true)).toHaveLength(1);
    expect(store.snapshot(1, Date.now()).activeEews).toEqual([]);
  });

  it("取消のあと訂正で復活した event は、別 serial の取消で再び閉じる", () => {
    const { feed, store } = cancelHarness();
    feed(finalXml("26"), "final-26");
    feed(replaceHeadValue(readFixture(FIXTURE_VXSE45_CANCEL), "Serial", "20"), "cancel-20");
    const revived = feed(
      replaceHeadValue(replaceHeadValue(readFixture(FIXTURE_VXSE45_S26), "InfoType", "訂正"), "Serial", "26"),
      "correction-26",
    );
    expect(revived).toHaveLength(1);
    expect(store.snapshot(1, Date.now()).activeEews).toHaveLength(1);
    const cancelled = feed(
      replaceHeadValue(readFixture(FIXTURE_VXSE45_CANCEL), "Serial", "21"),
      "cancel-21",
    );
    expect(cancelled.filter((dto) => dto.tickerSuppressed !== true)).toHaveLength(1);
    expect(store.snapshot(2, Date.now()).activeEews).toEqual([]);
  });

  // 取消は type によらず最初の 1 本だけ告知し、2 本目以降は card の解除だけにする。
  it("a: VXSE45 を見ていない event では、VXSE43/44 の取消の後の VXSE45 の取消を告知しない", () => {
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE43_WARNING_S1), "43-normal", "VXSE43"]],
      [[readFixture(FIXTURE_VXSE43_WARNING_S3), "43-cancel", "VXSE43"], [cancel45(), "45-cancel"]],
    )).toEqual(ANNOUNCED_ONCE);
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE44_S10), "44-normal", "VXSE44"]],
      [[cancel44(), "44-cancel", "VXSE44"], [cancel45(), "45-cancel"]],
    )).toEqual(ANNOUNCED_ONCE);
  });

  it("b: VXSE45 の取消を取り逃しても、VXSE44 の取消で 1 回告知する", () => {
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE45_S1), "45-normal"]],
      [[cancel44(), "44-cancel", "VXSE44"]],
    )).toEqual(ANNOUNCED_ONCE);
  });

  it("c: VXSE45 の card は VXSE43 の取消だけでも外れる", () => {
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE45_S1), "45-normal"]],
      [[readFixture(FIXTURE_VXSE43_WARNING_S3), "43-cancel", "VXSE43"]],
    )).toEqual(ANNOUNCED_ONCE);
  });

  it("d: VXSE45 と VXSE44 の取消はどちらの順でも告知 1 回・テロップ 1 行", () => {
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE45_S1), "45-normal"]],
      [[cancel45(), "45-cancel"], [cancel44(), "44-cancel", "VXSE44"]],
    )).toEqual(ANNOUNCED_ONCE);
    expect(cancelDelta(
      [[readFixture(FIXTURE_VXSE45_S1), "45-normal"]],
      [[cancel44(), "44-cancel", "VXSE44"], [cancel45(), "45-cancel"]],
    )).toEqual(ANNOUNCED_ONCE);
  });

  it("VXSE43 の取消（isWarning=true）で警報済みにせず、復活後の初めての警報を通知する", () => {
    const { feed } = cancelHarness();
    feed(readFixture(FIXTURE_VXSE45_S1), "45-forecast-1");
    feed(replaceHeadValue(readFixture(FIXTURE_VXSE43_WARNING_S3), "Serial", "1"), "43-cancel-1", "VXSE43");
    feed(replaceHeadValue(cancel45(), "Serial", "1"), "45-cancel-1");
    feed(replaceHeadValue(readFixture(FIXTURE_VXSE45_S1), "InfoType", "訂正"), "45-correction-1");
    const before = notifyMock.mock.calls.length;
    feed(replaceHeadValue(readFixture(FIXTURE_VXSE45_S26), "Serial", "2"), "45-warning-2");
    expect(notifyMock.mock.calls.length - before).toBe(1);
  });
});

type FeedStep = [xml: string, id: string, type?: string];

const ANNOUNCED_ONCE = { notified: 1, recorded: 1, cli: 1, tickers: 1, releases: 1, activeAfter: 0 };

function cancel45(): string {
  return readFixture(FIXTURE_VXSE45_CANCEL);
}

function cancel44(): string {
  return replaceHeadValue(readFixture(FIXTURE_VXSE45_CANCEL), "Serial", "11");
}

function cancelDelta(normals: FeedStep[], cancels: FeedStep[]) {
  const harness = cancelHarness();
  for (const [xml, id, type] of normals) harness.feed(xml, id, type);
  const before = harness.counts();
  for (const [xml, id, type] of cancels) harness.feed(xml, id, type);
  const after = harness.counts();
  return {
    notified: after.notified - before.notified,
    recorded: after.recorded - before.recorded,
    cli: after.cli - before.cli,
    tickers: after.tickers - before.tickers,
    releases: after.releases - before.releases,
    activeAfter: harness.store.snapshot(1, Date.now()).activeEews.length,
  };
}

function finalXml(serial: string): string {
  return replaceHeadValue(readFixture(FIXTURE_VXSE45_S26), "Serial", serial).replace(
    "</Body>",
    "<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory></Body>",
  );
}

function cancelHarness() {
  const display = mockDisplay();
  const ingested: PresentationEvent[] = [];
  const { handler, eewTracker, stats } = createMessageHandler({
    display,
    displaySink: { ingest: (event) => ingested.push(event) },
  });
  const store = new DisplayStateStore();
  let tickers = 0;
  let releases = 0;
  const activeCount = () => store.snapshot(0, Date.now()).activeEews.length;
  const feed = (xml: string, id: string, type = "VXSE45") => {
    const before = ingested.length;
    handler(message(xml, id, type));
    return ingested.slice(before).map((event) => {
      const dto = projectDisplayEvent(event, "s");
      const activeBefore = activeCount();
      store.applyEvent(dto, Date.now());
      if (dto.isCancellation && dto.tickerSuppressed !== true) tickers += 1;
      if (dto.isCancellation && activeCount() < activeBefore) releases += 1;
      return dto;
    });
  };
  const counts = () => ({
    notified: notifyMock.mock.calls.length,
    recorded: stats.getSnapshot().totalCount,
    cli: vi.mocked(display.displayOutcome).mock.calls.length,
    tickers,
    releases,
  });
  return { feed, store, eewTracker, stats, counts };
}
