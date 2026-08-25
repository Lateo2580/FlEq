import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import BriefingCard from "../BriefingCard.svelte";
import type { ActiveStandbyCardV1 } from "../../lib/protocol";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";

function briefing(entries = 1): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  return {
    kind: "briefing", surface: "corner-right", key: "briefing:active", sourceEventIds: ["card:vpbs:1"],
    updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", restored: false, severity: "warning",
    data: {
      generation: 3,
      entries: Array.from({ length: entries }, (_, index) => ({
        key: `card:vpbs:${index + 1}`, source: "vpbs50" as const, sourceEventId: `event-${index + 1}`,
        title: `防災気象情報 ${index + 1}`, headline: "大雨に警戒してください", conditions: ["発表"],
        targetAreas: [{ name: "宮崎県", code: "450000" }], reportDateTime: "2026-08-25T12:00:00+09:00",
        publishingOffice: "気象庁", infoType: "発表", frameLevel: index === 0 ? "critical" as const : "warning" as const,
        severityEvidence: [], qualifier: null, updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", generation: index + 1,
      })),
    },
  };
}

describe("BriefingCard", () => {
  it("engine frame level をそのまま描画し、raw XML ではなく card payload だけを表示する", () => {
    const { container } = render(BriefingCard, { item: briefing(), shellHeightPx: 260 });
    const entry = container.querySelector<HTMLElement>("[data-briefing-entry]");

    expect(entry?.dataset.frameLevel).toBe("critical");
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

    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/2", identities: ["card:vpbs:1:title:title:0", "card:vpbs:2:title:title:0"] });
    expect(container.querySelectorAll("[data-briefing-entry]")).toHaveLength(1);
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

  it.each([
    ["critical", "critical"], ["warning", "warning"], ["info", "info"], ["cancel", "cancel"],
  ] as const)("%s frame を明示した header class として描画する", (frameLevel, className) => {
    const item = briefing();
    item.data.entries[0]!.frameLevel = frameLevel;
    item.data.entries[0]!.source = frameLevel === "info" ? "vpoa50" : "vpbs50";
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.querySelector("header")?.classList.contains(className)).toBe(true);
    expect(container.textContent).toContain(frameLevel === "info" ? "記録的短時間大雨情報" : "気象速報");
  });
});
