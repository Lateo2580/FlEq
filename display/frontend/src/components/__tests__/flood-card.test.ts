import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import FloodCard from "../FloodCard.svelte";
import FloodWideCard from "../FloodWideCard.svelte";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "../../lib/protocol";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";

function river(key: string, level: "L3" | "L4" | "L5" = "L3", station: DisplayFloodStationV1 | null = null): DisplayFloodRiverV1 {
  return {
    riverKey: key, riverName: `${key}川`, level, levelRank: level === "L3" ? 30 : level === "L4" ? 40 : 51,
    kindName: level === "L3" ? "氾濫警戒情報" : level === "L4" ? "氾濫危険情報" : "氾濫発生情報",
    reportDateTime: "2026-07-21T00:00:00.000Z", station,
  };
}

function floodItem(rivers: DisplayFloodRiverV1[], restored = false): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface: "corner-right", key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored, severity: rivers.some((candidate) => candidate.levelRank >= 40) ? "critical" : "warning",
    data: { rivers },
  };
}

describe("FloodCard", () => {
  it.each([1, 2, 3, 5, 12])("paginates n=%i rivers through every current-page range", async (count) => {
    const coordinator = createCardPageCoordinator();
    const rivers = Array.from({ length: count }, (_, index) => river(`r${index + 1}`));
    const view = render(FloodCard, {
      item: floodItem(rivers), pageCoordinator: coordinator, pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start <= 2 ? 0 : 201,
    });
    await tick();
    const pageCount = Math.ceil(count / 2);
    expect(view.container.querySelector("[data-card-page-footer]") != null).toBe(pageCount > 1);
    const visited = new Set<string>();
    for (let page = 0; page < pageCount; page += 1) {
      coordinator.jumpTo("flood", page);
      await tick();
      for (const entry of view.container.querySelectorAll<HTMLElement>("[data-flood-entry-index]")) visited.add(entry.dataset.floodEntryIndex ?? "");
    }
    expect(visited).toEqual(new Set(rivers.map((_, index) => String(index))));
    view.unmount();
    coordinator.dispose();
  });

  it("draws a provisional pending range without entering the infeasible fallback", async () => {
    const coordinator = createCardPageCoordinator();
    const view = render(FloodCard, {
      item: floodItem([river("r1"), river("r2"), river("r3")]), pageCoordinator: coordinator, pageScheduling: true,
      partitionProbe: () => null,
    });
    await tick();
    expect(view.container.querySelectorAll("[data-flood-entry-index]")).toHaveLength(1);
    expect(view.container.querySelector("[data-flood-aggregate]")).toBeNull();
    expect(view.container.querySelector<HTMLElement>(".flood-card")?.dataset.cardPageInfeasible).toBe("false");
    view.unmount();
    coordinator.dispose();
  });

  it.each([320, 400] as const)("uses the compact %ipx contract at the side/center fit boundary", async (height) => {
    for (const placement of ["side", "center"] as const) {
      const coordinator = createCardPageCoordinator();
      const probes: number[] = [];
      const view = render(FloodCard, {
        item: floodItem([river("r1")]), pageCoordinator: coordinator, pageScheduling: true, pagePlacement: placement,
        measurementFixedHeightPx: height, partitionProbe: (_key, _placement, _range) => { probes.push(height); return height; },
      });
      await tick();
      expect(view.container.querySelector<HTMLElement>(".flood-card")?.dataset.cardPageInfeasible).toBe("false");
      expect(probes).toContain(height);
      view.unmount(); coordinator.dispose();
    }
  });

  it("uses FloodWideCard's 30vh shell, footer, and station content at the 400px side/center boundary", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 / 0.3 });
    for (const placement of ["side", "center"] as const) {
      const coordinator = createCardPageCoordinator();
      const view = render(FloodWideCard, {
        item: { ...floodItem([river("r1", "L4", { name: "観測", levelM: 3.2, trend: "rising", thresholdLabel: "危険" })]), surface: "clock-top-wide" },
        pageCoordinator: coordinator, pageScheduling: true, pagePlacement: placement, measurementFixedHeightPx: 400,
        partitionProbe: (_key, _placement, range) => range.end - range.start <= 1 ? 400 : 401,
      });
      await tick();
      expect(view.container.querySelector(".flood-wide-card")?.textContent).toContain("観測");
      expect(view.container.querySelector("[data-card-page-footer]")).toBeNull();
      view.unmount(); coordinator.dispose();
    }
  });

  it("keeps the confirmed active page through a detail-update pending epoch", async () => {
    const coordinator = createCardPageCoordinator();
    let pending = false;
    const probe = (_key: string, _placement: string, range: { start: number; end: number }) =>
      pending ? null : range.end - range.start <= 1 ? 0 : 201;
    const rivers = [river("r1"), river("r2"), river("r3")];
    const view = render(FloodCard, {
      item: floodItem(rivers), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe,
    });
    await tick();
    coordinator.jumpTo("flood", 1);
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("2/3");

    pending = true;
    await view.rerender({ item: floodItem(rivers.map((entry) => ({ ...entry, station: { name: "更新", levelM: 1, trend: null, thresholdLabel: null } }))), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("2/3");
    expect(view.container.querySelector("[data-flood-aggregate]")).toBeNull();

    pending = false;
    await view.rerender({ item: floodItem(rivers), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("2/3");
    view.unmount();
    coordinator.dispose();
  });

  it("resets live pages independently for river addition, removal, and form changes but not details", async () => {
    const coordinator = createCardPageCoordinator();
    const probe = (_key: string, _placement: string, range: { start: number; end: number }) => range.end - range.start <= 1 ? 0 : 201;
    const base = [river("r1"), river("r2"), river("r3")];
    const view = render(FloodCard, { item: floodItem(base), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe });
    await tick();
    coordinator.jumpTo("flood", 1);
    await tick();
    await view.rerender({ item: floodItem([...base, river("r4")]), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("1/4");

    coordinator.jumpTo("flood", 2);
    await tick();
    await view.rerender({ item: floodItem(base), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("1/3");

    coordinator.jumpTo("flood", 1);
    await tick();
    await view.rerender({ item: floodItem(base), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe, pageForm: "wide" });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("1/3");

    coordinator.jumpTo("flood", 1);
    await tick();
    await view.rerender({ item: floodItem(base.map((entry) => ({ ...entry, station: { name: "詳細", levelM: 2, trend: null, thresholdLabel: null } }))), pageCoordinator: coordinator, pageScheduling: true, partitionProbe: probe, pageForm: "wide" });
    await tick();
    expect(coordinator.cardDiagnostics("flood").page).toBe("2/3");
    view.unmount();
    coordinator.dispose();
  });

  it("uses aggregate fallback and marks clip when even that fallback exceeds the contract", async () => {
    const coordinator = createCardPageCoordinator();
    const view = render(FloodCard, {
      item: floodItem([river("r1")]), pageCoordinator: coordinator, pageScheduling: true,
      partitionProbe: () => 201,
    });
    await tick();
    expect(view.container.querySelector("[data-flood-aggregate]")?.textContent).toBe("ほか 1 河川");
    expect(view.container.querySelector<HTMLElement>(".flood-card")?.dataset.cardPageInfeasible).toBe("clip");
    view.unmount();
    coordinator.dispose();
  });
  it("renders one river per row with kind and level", () => {
    const { container } = render(FloodCard, { item: floodItem([river("多摩", "L4"), river("浅", "L3")]) });
    const rows = [...container.querySelectorAll(".river-row")].map((row) => row.textContent);
    expect(rows).toEqual(["多摩川　氾濫危険情報（L4）", "浅川　氾濫警戒情報（L3）"]);
  });

  it("段階カラー: L3=赤帯 (band-red) / L4=紫帯 (band-emergency) / L5=氾濫発生専用帯 (band-flooding)。カード内最高レベルで決める", () => {
    const l3 = render(FloodCard, { item: floodItem([river("多摩", "L3")]) });
    expect(l3.container.querySelector(".flood-card")?.classList.contains("band-red")).toBe(true);
    expect(l3.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(false);
    l3.unmount();
    // L3 と L4 が混在 → 最高レベル L4 で紫
    const mixed = render(FloodCard, { item: floodItem([river("浅", "L3"), river("多摩", "L4")]) });
    expect(mixed.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(true);
    mixed.unmount();
    // L5 氾濫発生は専用 class (黒帯・白枠・白リボン・黄文字)。最高レベルが L5 なら L4 混在でも flooding
    const l5 = render(FloodCard, { item: floodItem([river("多摩", "L5"), river("浅", "L4")]) });
    expect(l5.container.querySelector(".flood-card")?.classList.contains("band-flooding")).toBe(true);
    expect(l5.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(false);
  });

  it("副行: 水位は NumberUnit (縮小なし・前景色) + 色分き傾向矢印で構造化される", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("大淀", "L4", { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" }),
    ]) });
    const row = container.querySelector(".station-row");
    expect(row?.querySelector(".station-level .nu-value")?.textContent).toBe("3.42");
    expect(row?.querySelector(".station-level .nu-unit")?.textContent).toBe("m");
    expect(row?.querySelector(".trend-rising")?.textContent).toBe("↑");
    expect(row?.textContent).toBe("柏田 3.42m ↑ 氾濫危険水位 3.20m 超過");
  });

  it("副行: levelM 欠測は水位と矢印を出さず、観測所名 + しきい値のみ (旧 formatter の null 契約を維持)", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("五ヶ瀬", "L3", null),
      river("耳", "L3", { name: "山陰", levelM: null, trend: null, thresholdLabel: "避難判断水位超過" }),
    ]) });
    const row = container.querySelector(".station-row");
    expect(row?.querySelector(".station-level")).toBeNull();
    expect(row?.querySelector(".trend-rising, .trend-steady, .trend-falling")).toBeNull();
    expect(row?.textContent).toBe("山陰 避難判断水位超過");
  });

  it("副行: trend のみ欠測は矢印だけ省略、thresholdLabel のみ欠測はしきい値だけ省略 (null 分岐の独立性)", () => {
    const c1 = render(FloodCard, { item: floodItem([
      river("高城", "L3", { name: "高城", levelM: 2.18, trend: null, thresholdLabel: "避難判断水位 2.00m 超過" }),
    ]) }).container;
    expect(c1.querySelector(".station-row")?.textContent).toBe("高城 2.18m 避難判断水位 2.00m 超過");

    const c2 = render(FloodCard, { item: floodItem([
      river("三輪", "L3", { name: "三輪", levelM: 5.6, trend: "steady", thresholdLabel: null }),
    ]) }).container;
    expect(c2.querySelector(".station-row")?.textContent).toBe("三輪 5.60m →");
    expect(c2.querySelector(".trend-steady")).toBeTruthy();
  });

  it("副行 CSS: 水位は前景色 + 縮小なし (--number-unit-affix-size: 1em)、矢印はワイド版と同じ色分け", () => {
    const source = readFileSync(join(__dirname, "..", "FloodCard.svelte"), "utf8");
    expect(source).toContain("--number-unit-affix-size: 1em");
    expect(source).toMatch(/\.station-level[^}]*color: var\(--fg\)/s);
    expect(source).toMatch(/\.trend-rising[^}]*var\(--role-tsunamiWarning\)/s);
    expect(source).toMatch(/\.trend-steady[^}]*var\(--role-muted\)/s);
    expect(source).toMatch(/\.trend-falling[^}]*var\(--role-connectionOk\)/s);
  });

  it("通常幅は nowrap、狭い side card だけ kind と観測所副行を折り返す", () => {
    const source = readFileSync(join(__dirname, "..", "FloodCard.svelte"), "utf8");
    const narrow = /@container \(max-width: 320px\) \{([\s\S]*)\n  \}/.exec(source)?.[1] ?? "";
    expect(source).toContain("container-type: inline-size");
    expect(source).toMatch(/\.river-row\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(source).toMatch(/\.station-row\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(narrow).toMatch(/\.river-row,[\s\S]*\.station-row\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("通常描画は全河川を保持し、集約 CSS は infeasible fallback 以外に残さない", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("大淀", "L5"), river("小丸", "L4"), river("五ヶ瀬", "L4"), river("耳", "L3"), river("一ツ瀬", "L3"),
    ]) });
    const card = container.querySelector(".flood-card");
    expect(card?.classList.contains("height-budgeted")).toBe(true);
    expect(container.querySelectorAll(".river-entry")).toHaveLength(5);
    expect(container.querySelector("[data-flood-aggregate]")).toBeNull();

    const three = render(FloodCard, { item: floodItem([
      river("大淀", "L4"), river("小丸", "L3"), river("五ヶ瀬", "L3"),
    ]) });
    expect(three.container.querySelectorAll(".river-entry")).toHaveLength(3);

    const source = readFileSync(join(__dirname, "..", "FloodCard.svelte"), "utf8");
    expect(source).not.toContain("data-flood-aggregated-normal");
    expect(source).not.toContain("data-flood-aggregated-narrow");
    expect(source).toMatch(/\.height-budgeted\s*\{\s*min-height:\s*200px;/s);
    expect(source).toMatch(/\.more-rivers\s*\{[^}]*padding:\s*var\(--space-1\) var\(--space-4\);/s);
  });

  it("measurement range は指定河川だけを footer 込みの page shell として描画する", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("大淀"), river("小丸"), river("五ヶ瀬"), river("耳"),
    ]), measurementRange: { start: 1, end: 3, tails: [], omittedAreaCount: 0 }, measurementPageFooter: true });
    expect([...container.querySelectorAll(".river-row")].map((row) => row.textContent))
      .toEqual(["小丸川　氾濫警戒情報（L3）", "五ヶ瀬川　氾濫警戒情報（L3）"]);
    expect(container.querySelector("[data-page-probe-card]")).toBeTruthy();
    expect(container.querySelector("[data-page-probe-body]")).toBeTruthy();
    expect(container.querySelector("[data-card-page-footer]")?.textContent).toBe("2/2");
    expect(container.querySelector("[data-flood-aggregate]")).toBeNull();
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(FloodCard, { item: floodItem([river("多摩")], true) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
