import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import {
  TelegramRevisionGate,
  type TelegramRevisionDecision,
} from "../../../src/engine/messages/telegram-revision-gate";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { processWeather } from "../../../src/engine/presentation/processors/process-weather";
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

// ── Issue #11: stale partial が容量を占有して新規 subject を恒久拒否する回帰 ──

/** 最小構成の VPWW55 / VPWS50 電文。官署と区域だけを差し替えて 129 subject を合成する。 */
function weatherXml(opts: {
  office: string;
  areaName: string;
  areaCode: string;
  reportDateTime: string;
  kindName?: string;
  kindCode?: string;
}): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_add="http://xml.kishou.go.jp/jmaxml1/addition1/">`,
    `<Control>`,
    `<Title>気象警報・注意報</Title>`,
    `<DateTime>${opts.reportDateTime}</DateTime>`,
    `<Status>通常</Status>`,
    `<EditorialOffice>${opts.office}</EditorialOffice>`,
    `<PublishingOffice>${opts.office}</PublishingOffice>`,
    `</Control>`,
    `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">`,
    `<Title>気象警報・注意報</Title>`,
    `<ReportDateTime>${opts.reportDateTime}</ReportDateTime>`,
    `<TargetDateTime>${opts.reportDateTime}</TargetDateTime>`,
    `<EventID/>`,
    `<InfoType>発表</InfoType>`,
    `<Serial/>`,
    `<InfoKind>気象警報・注意報</InfoKind>`,
    `<InfoKindVersion>1.5_0</InfoKindVersion>`,
    `<Headline>`,
    `<Text/>`,
    `<Information type="気象警報・注意報（府県予報区等）">`,
    `<Item>`,
    `<Kind><Name>${opts.kindName ?? "レベル３大雨警報"}</Name><Code>${opts.kindCode ?? "03"}</Code></Kind>`,
    `<Areas codeType="気象情報／府県予報区・細分区域等">`,
    `<Area><Name>${opts.areaName}</Name><Code>${opts.areaCode}</Code></Area>`,
    `</Areas>`,
    `</Item>`,
    `</Information>`,
    `</Headline>`,
    `</Head>`,
    `</Report>`,
  ].join("\n");
}

function syntheticMessage(type: string, xml: string): WsDataMessage {
  return { ...createMockWsDataMessageFromXml(xml, type), meta: undefined };
}

describe("Issue #11 VPWS50 family capacity", () => {
  const BASE_1 = "2026-09-01T00:00:00+09:00";
  const BASE_2 = "2026-09-05T00:00:00+09:00";

  function deps(): {
    vpws50State: Vpws50StateHolder;
    vpww56State: Vpww56StateHolder;
    revisionGate: TelegramRevisionGate;
    decisions: TelegramRevisionDecision[];
  } {
    const decisions: TelegramRevisionDecision[] = [];
    return {
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      revisionGate: new TelegramRevisionGate(),
      decisions,
    };
  }

  function feed(
    d: ReturnType<typeof deps>,
    type: string,
    xml: string,
  ): ReturnType<typeof processWeather> {
    return processWeather(syntheticMessage(type, xml), {
      vpws50State: d.vpws50State,
      vpww56State: d.vpww56State,
      revisionGate: d.revisionGate,
      onRevisionDecision: (decision) => d.decisions.push(decision),
    });
  }

  function nationwide(reportDateTime: string): string {
    return weatherXml({
      office: "気象庁",
      areaName: "全国区域",
      areaCode: "010000",
      reportDateTime,
    });
  }

  function partial(index: number, reportDateTime: string): string {
    return weatherXml({
      office: `架空第${index.toString().padStart(3, "0")}気象台`,
      areaName: `架空区域${index.toString().padStart(3, "0")}`,
      areaCode: `${(700000 + index).toString()}`,
      reportDateTime,
    });
  }

  it("新しい全国報を受理すると古い partial は active 扱いから外れ、129 件目の新規 subject が受理される", () => {
    const d = deps();
    // 1. base VPWS50 を受理
    expect(feed(d, "VPWS50", nationwide(BASE_1)).kind).toBe("ok");
    // 2. distinct な部分報 subject を 128 件受理する
    for (let i = 1; i <= 128; i += 1) {
      const result = feed(d, "VPWW55", partial(i, "2026-09-02T00:00:00+09:00"));
      expect(result.kind, `partial ${i}`).toBe("ok");
    }
    expect(d.vpws50State.activePartialSubjects()).toHaveLength(128);

    // 3. それらより新しい全国 VPWS50 を受理する
    expect(feed(d, "VPWS50", nationwide(BASE_2)).kind).toBe("ok");

    // 4. 古い partial は active 扱いされない
    expect(d.vpws50State.activePartialSubjects()).toHaveLength(0);

    // 5. 129 件目の新規 subject が capacityExceeded ではなく受理され、表示 state に載る
    d.decisions.length = 0;
    const fresh = feed(d, "VPWW55", partial(129, "2026-09-06T00:00:00+09:00"));
    expect(d.decisions.map((decision) => decision.kind)).not.toContain("capacityExceeded");
    expect(fresh.kind).toBe("ok");
    const areaCodes = d.vpws50State.getCurrentAreasForDisplay()?.kinds
      .flatMap((kind) => kind.areas.map((area) => area.areaCode)) ?? [];
    expect(areaCodes).toContain("700129");

    // 6. base より新しく実際に表示へ寄与している partial は active のまま守られる
    expect(d.vpws50State.activePartialSubjects()).toEqual([
      "weather:VPWW55:架空第129気象台",
    ]);
  }, 60_000);
});
