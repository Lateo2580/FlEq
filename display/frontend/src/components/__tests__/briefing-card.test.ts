import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import BriefingCard from "../BriefingCard.svelte";
import { initialState, reduce } from "../../lib/store";
import type { ActiveStandbyCardV1, DisplayEventDtoV1, DisplayStateSnapshotV1 } from "../../lib/protocol";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import { parseWeatherBriefing } from "../../../../../src/dmdata/briefing-parser";
import { StandbyStateStore } from "../../../../../src/engine/display/standby-state-store";
import { fromBriefingOutcome } from "../../../../../src/engine/presentation/events/from-briefing";
import { processBriefing } from "../../../../../src/engine/presentation/processors/process-briefing";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_HJPNA202608270258,
  FIXTURE_VPBS50_HJPNB202608270308,
  FIXTURE_VPBS50_YJPNA202608270448,
  FIXTURE_VPBS50_YJPNB202608270448,
} from "../../../../../test/helpers/mock-message";

function briefing(entries = 1): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  return {
    kind: "briefing", surface: "corner-right", key: "briefing:active", sourceEventIds: ["card:vpbs:1"],
    updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", restored: false, severity: "warning",
    data: {
      generation: 3,
      entries: Array.from({ length: entries }, (_, index) => ({
        key: `card:vpbs:${index + 1}`, source: "vpbs50" as const, sourceEventId: `event-${index + 1}`,
        editorialOffice: "気象庁", phenomenonKind: "linearRainObserved" as const,
        semanticKey: `card:vpbs:semantic:linearRainObserved:気象庁`, serial: "1",
        title: `防災気象情報 ${index + 1}`, headline: "大雨に警戒してください", conditions: ["発表"],
        targetAreas: [{ name: "宮崎県", code: "450000" }], reportDateTime: "2026-08-25T12:00:00+09:00",
        publishingOffice: "気象庁", infoType: "発表", frameLevel: index === 0 ? "critical" as const : "warning" as const,
        severityEvidence: [], qualifier: null, updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", generation: index + 1,
      })),
    },
  };
}

function snapshotWithBriefing(item: Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null): DisplayStateSnapshotV1 {
  return {
    version: 1, generatedAt: "2026-08-25T12:00:00+09:00", seq: 1,
    activeEews: [], tsunami: null, largeQuakes: [], weatherAlerts: [], recentQuakes: [], latestQuake: null,
    stats: null, severityTier: "calm", connection: { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null },
    recentTicker: [], standbyItems: item == null ? [] : [item],
  };
}

function reconcileEvent(): DisplayEventDtoV1 {
  return {
    version: 1, seq: 2, id: "briefing-canonical", eventKey: "briefing:canonical", groupKey: null, domain: "weather", type: "VPBS50",
    infoType: "発表", reportDateTime: "2026-08-25T12:00:00+09:00", title: "t", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "info", isCancellation: false,
    summary: { text: "t", role: "info" }, emergency: null, recentQuake: null, latestQuake: null, tickerDetail: null,
  };
}

function briefingFromFrontendFrame(
  frame: "snapshot" | "reconcile",
  item: Extract<ActiveStandbyCardV1, { kind: "briefing" }>,
): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const state = frame === "snapshot"
    ? reduce(initialState(), { type: "snapshot", snapshot: snapshotWithBriefing(item) })
    : reduce(
        reduce(initialState(), { type: "snapshot", snapshot: snapshotWithBriefing(null) }),
        { type: "reconcile", event: reconcileEvent(), sourceEventKeys: ["briefing:source"], card: item } as unknown as Parameters<typeof reduce>[1],
      );
  const briefingItem = state.snapshot?.standbyItems?.find((candidate) => candidate.kind === "briefing");
  if (briefingItem == null || briefingItem.kind !== "briefing") throw new Error("briefing card was not reduced");
  return briefingItem;
}

function corpusBriefing(fixture: string): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const message = createMockWsDataMessage(fixture);
  const parsed = parseWeatherBriefing(message);
  const outcome = processBriefing(message);
  if (parsed == null || outcome == null) throw new Error(`briefing corpus did not parse: ${fixture}`);
  const store = new StandbyStateStore();
  store.applyEvent(fromBriefingOutcome(outcome), Date.parse(parsed.reportDateTime) + 1);
  const item = store.snapshotBriefingCard();
  if (item == null) throw new Error(`briefing corpus did not reach wire: ${fixture}`);
  return item;
}

describe("BriefingCard", () => {
  it("engine frame level をそのまま描画し、raw XML ではなく card payload だけを表示する", () => {
    const { container } = render(BriefingCard, { item: briefing(), shellHeightPx: 260 });
    const entry = container.querySelector<HTMLElement>("[data-briefing-entry]");
    const header = container.querySelector<HTMLElement>("[data-briefing-card-header]");

    expect(entry?.dataset.frameLevel).toBe("critical");
    expect(header?.classList.contains("critical")).toBe(true);
    expect(header?.querySelector(".updated-stamp")?.textContent).toContain("更新");
    expect(entry?.textContent).toContain("防災気象情報 1");
    expect(entry?.textContent).toContain("対象: 宮崎県");
    expect(container.querySelector<HTMLElement>("[data-briefing-card]")?.style.height).toBe("260px");
  });

  it("entry block identity ごとに pager へ登録し、同じ page shell で描画する", () => {
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item: briefing(2), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 6 ? 261 : 260,
    });

    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/2", identities: ["card:vpbs:1:title:raw-title:0", "card:vpbs:2:headline:raw-headline:0"] });
    expect(container.querySelectorAll("[data-briefing-entry]")).toHaveLength(2);
    expect(container.querySelector("[data-card-page-footer]")).toBeTruthy();
    coordinator.dispose();
  });

  it("単一の長文 entry を安定した行 block に分け、infeasible で丸ごと消さない", async () => {
    const item = briefing();
    item.data.entries[0]!.headline = "長文".repeat(160);
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 261 : 260,
    });

    expect(coordinator.cardDiagnostics("briefing").page).not.toBe("0/0");
    expect(container.querySelectorAll("[data-briefing-block]").length).toBeGreaterThan(0);
    coordinator.jumpTo("briefing", 1);
    await tick();
    expect(container.querySelector("[data-briefing-card]")?.textContent).toContain("長文");
    coordinator.dispose();
  });

  it("単一 block 自体が不適合でも保全ページへ縮退し、empty range にしない", () => {
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item: briefing(), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 1,
      partitionProbe: () => 2,
    });

    expect(coordinator.cardDiagnostics("briefing").page).not.toBe("0/0");
    expect(container.querySelector("[data-briefing-entry]")).toBeTruthy();
    expect(container.querySelectorAll("[data-briefing-block]").length).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it.each(["snapshot", "reconcile"] as const)("%s frame の不正 summary shape は raw headline fallback にする", (frame) => {
    const item = briefing();
    item.data.entries[0]!.title = "raw title";
    item.data.entries[0]!.headline = "raw headline";
    (item.data.entries[0] as unknown as { summary: unknown }).summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "linearRainObserved", lead: "発生", sourceOrdinal: 0, facts: [{ kind: "event", label: "発生", areaName: null, at: null }] }],
    };
    const { container } = render(BriefingCard, { item: briefingFromFrontendFrame(frame, item), shellHeightPx: 260 });
    expect(container.textContent).toContain("raw title");
    expect(container.textContent).toContain("raw headline");
  });

  it.each([
    ["critical", "critical"], ["warning", "warning"], ["info", "advisory"], ["cancel", "advisory"],
  ] as const)("%s frame を card header の severity token として描画する", (frameLevel, className) => {
    const item = briefing();
    item.data.entries[0]!.frameLevel = frameLevel;
    item.data.entries[0]!.source = frameLevel === "info" ? "vpoa50" : "vpbs50";
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.querySelector("[data-briefing-card-header]")?.classList.contains(className)).toBe(true);
    expect(container.textContent).toContain(frameLevel === "info" ? "記録的短時間大雨情報" : "気象速報");
  });

  it("複数 entry は最上位 severity の card header と本文区切りへ集約し、更新時刻を一度だけ表示する", () => {
    const item = briefing(2);
    item.data.entries[0]!.frameLevel = "warning";
    item.data.entries[0]!.updatedAt = "2026-08-25T12:00:00+09:00";
    item.data.entries[1]!.frameLevel = "critical";
    item.data.entries[1]!.updatedAt = "2026-08-25T13:30:00+09:00";
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const header = container.querySelector<HTMLElement>("[data-briefing-card-header]");
    const entries = container.querySelectorAll<HTMLElement>("[data-briefing-entry]");

    expect(header?.classList.contains("critical")).toBe(true);
    expect(header?.getAttribute("style")).toContain("var(--header-weatherEmergency-container)");
    expect(header?.querySelector(".updated-stamp")?.textContent).toContain("13:30");
    expect(container.querySelectorAll("[data-briefing-card-header]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-briefing-entry-label]")).toHaveLength(2);
    expect(entries[1]?.classList.contains("entry-divider")).toBe(true);
  });

  it("現象 lead・観測 fact・取消・VPOA50 の未確認 qualifier を本文で維持する", () => {
    const item = briefing(2);
    const observation = item.data.entries[0]!;
    observation.source = "vpoa50";
    observation.qualifier = "未確認";
    observation.summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [
        { kind: "precipitation", locationName: "美幌町", locationCode: "001", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00" },
      ] }],
    };
    const cancelled = item.data.entries[1]!;
    cancelled.summary = { mode: "cancellation", hasUnknownKind: false, items: [] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("記録的短時間大雨");
    expect(container.textContent).toContain("美幌町 約１００ミリ / 13:10");
    expect(container.textContent).toContain("未確認");
    expect(container.textContent).toContain("気象防災速報を取消");
  });

  it.each([
    null,
    "old-wire",
    { mode: "unknown", items: [], hasUnknownKind: false },
    { mode: "structured", items: [], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [{}] }], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationName: "地点", locationCode: "1", description: "約１００ミリ", unit: "mm", at: null },
    ] }], hasUnknownKind: false },
  ])("summary の不正 shape は raw headline fallback にする: %o", (summary) => {
    const item = briefing();
    item.data.entries[0]!.title = "raw title";
    item.data.entries[0]!.headline = "raw headline";
    (item.data.entries[0] as unknown as { summary: unknown }).summary = summary;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("raw title");
    expect(container.textContent).toContain("raw headline");
  });

  it("長い lead と fact は分割せず、一つの pager semantic block として保つ", () => {
    const item = briefing();
    const lead = "３時間以内に線状降水帯発生のおそれ";
    const fact = "非常に長い地点名 約１００ミリ / 04:40";
    item.data.entries[0]!.summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "linearRainPredicted", lead, sourceOrdinal: 0, facts: [
        { kind: "precipitation", locationName: "非常に長い地点名", locationCode: "1", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-25T04:40:00+09:00" },
      ] }],
    };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const leadBlocks = [...container.querySelectorAll<HTMLElement>("[data-briefing-block]")].filter((block) => block.textContent === lead);
    const factBlocks = [...container.querySelectorAll<HTMLElement>("[data-briefing-block]")].filter((block) => block.textContent === fact);
    expect(leadBlocks).toHaveLength(1);
    expect(factBlocks).toHaveLength(1);
  });

  it("structured summary は lead・先頭3地域・fact を表示し raw title/headline を主面から外す", () => {
    const item = briefing();
    item.data.entries[0]!.title = "長い raw title";
    item.data.entries[0]!.headline = "長い raw headline";
    item.data.entries[0]!.targetAreas = [
      { name: "一", code: "1" }, { name: "二", code: "2" }, { name: "三", code: "3" }, { name: "四", code: "4" },
    ];
    item.data.entries[0]!.summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [
        { kind: "precipitation", locationName: "美幌町", locationCode: "001", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00" },
      ] }],
    };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("記録的短時間大雨");
    expect(container.textContent).toContain("ほか1地域");
    expect(container.textContent).toContain("美幌町 約１００ミリ / 13:10");
    expect(container.textContent).not.toContain("長い raw title");
    expect(container.textContent).not.toContain("長い raw headline");
  });

  it("Phase 1 subject fields が欠落した旧 wire は raw headline fallback にする", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "旧 wire title";
    entry.headline = "旧 wire headline";
    delete entry.editorialOffice;
    delete entry.phenomenonKind;
    delete entry.semanticKey;
    delete entry.serial;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("旧 wire title");
    expect(container.textContent).toContain("旧 wire headline");
  });

  it.each([
    [FIXTURE_VPBS50_HJPNA202608270258, "富山県"],
    [FIXTURE_VPBS50_HJPNB202608270308, "石川県"],
    [FIXTURE_VPBS50_YJPNA202608270448, "富山県"],
    [FIXTURE_VPBS50_YJPNB202608270448, "石川県"],
  ] as const)("corpus %s は実 XML→parser→wire 経由で県文脈を一度だけ、対象地域 DOM には名称だけを描画する", (fixture, prefecture) => {
    const item = corpusBriefing(fixture);
    const entry = item.data.entries[0]!;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");
    const contexts = renderedEntry?.querySelectorAll<HTMLElement>("[data-briefing-prefecture-context]") ?? [];
    const target = renderedEntry?.querySelector<HTMLElement>("[data-briefing-target-regions]");

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.textContent).toBe(prefecture);
    expect(contexts[0]?.classList.contains("pref-group")).toBe(true);
    expect(contexts[0]?.querySelector(".pref-name")?.textContent).toBe(prefecture);
    expect(target?.classList.contains("pref-group")).toBe(true);
    expect([...target?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []].map((city) => city.textContent)).toEqual(
      entry.targetAreas.map((area, index) => `${index === 0 ? "対象: " : ""}${area.name}`),
    );
    for (const area of entry.targetAreas) expect(renderedEntry?.textContent).not.toContain(area.code);
  });

  it("Head.Title から県名を安全に抽出できない場合は対象地域名だけを描画する", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "気象防災速報（対象県不明）";
    entry.targetAreas = [{ name: "西部", code: "160020" }, { name: "東部", code: "160010" }];
    entry.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "linearRainObserved", lead: "線状降水帯が発生", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");

    expect(renderedEntry?.querySelector("[data-briefing-prefecture-context]")).toBeNull();
    const target = renderedEntry?.querySelector<HTMLElement>("[data-briefing-target-regions]");
    expect(target?.classList.contains("pref-group")).toBe(true);
    expect([...target?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []].map((city) => city.textContent)).toEqual(["対象: 西部", "東部"]);
    expect(renderedEntry?.textContent).not.toContain("160020");
    expect(renderedEntry?.textContent).not.toContain("160010");
  });

  it("mixed summary でも県文脈を一度だけ表示し、title の現象詳細は保持する", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "富山県気象防災速報（未分類の現象）";
    entry.targetAreas = [{ name: "西部", code: "160020" }];
    entry.summary = { mode: "mixed", hasUnknownKind: true, items: [{ kind: "linearRainObserved", lead: "線状降水帯が発生", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");

    expect(renderedEntry?.textContent?.match(/富山県/g)).toHaveLength(1);
    expect(renderedEntry?.textContent).toContain("気象防災速報（未分類の現象）");
  });

  it("raw fallback と4地域以上の areaDetail でも areaCode を可視文字列に出さない", () => {
    const raw = briefing();
    raw.data.entries[0]!.targetAreas = [{ name: "西部", code: "160020" }, { name: "東部", code: "160010" }];
    const rawView = render(BriefingCard, { item: raw, shellHeightPx: 260 });
    expect([...rawView.container.querySelectorAll<HTMLElement>("[data-briefing-target-regions] .cities .city-name")].map((city) => city.textContent)).toEqual(["対象: 西部", "東部"]);
    expect(rawView.container.textContent).not.toContain("160020");
    expect(rawView.container.textContent).not.toContain("160010");

    const detailed = briefing();
    detailed.data.entries[0]!.targetAreas = [
      { name: "一", code: "01" }, { name: "二", code: "02" }, { name: "三", code: "03" }, { name: "四", code: "04" },
    ];
    detailed.data.entries[0]!.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const detailView = render(BriefingCard, { item: detailed, shellHeightPx: 260 });
    const targets = [...detailView.container.querySelectorAll<HTMLElement>("[data-briefing-target-regions]")];
    expect(targets.map((target) => [...target.querySelectorAll<HTMLElement>(".cities .city-name")].map((city) => city.textContent))).toEqual([
      ["対象: 一", "二", "三"], ["対象: 一", "二", "三", "四"],
    ]);
    expect(targets.every((target) => target.classList.contains("pref-group") && target.querySelectorAll(".cities .city-name").length > 0)).toBe(true);
    for (const code of ["01", "02", "03", "04"]) expect(detailView.container.textContent).not.toContain(code);
  });

  it("長い4地域は WeatherAlertCard と同じ地域ごとの city-name として実レンダリングされる", () => {
    const item = briefing();
    item.data.entries[0]!.targetAreas = [
      { name: "非常に長い富山県西部の対象地域", code: "01" },
      { name: "非常に長い富山県東部の対象地域", code: "02" },
      { name: "非常に長い石川県加賀の対象地域", code: "03" },
      { name: "非常に長い石川県能登の対象地域", code: "04" },
    ];
    item.data.entries[0]!.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const targetGroups = [...container.querySelectorAll<HTMLElement>("[data-briefing-target-regions]")];
    const cities = [...targetGroups[1]?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []];

    expect(targetGroups).toHaveLength(2);
    expect(cities.map((city) => city.textContent)).toEqual([
      "対象: 非常に長い富山県西部の対象地域", "非常に長い富山県東部の対象地域",
      "非常に長い石川県加賀の対象地域", "非常に長い石川県能登の対象地域",
    ]);
    expect(cities).toHaveLength(4);
  });
});
