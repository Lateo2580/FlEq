import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import FloodCard from "../FloodCard.svelte";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "../../lib/protocol";

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

  it("200px を超える side 河川は通常幅2件・狭幅1件の集約行へ送る", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("大淀", "L5"), river("小丸", "L4"), river("五ヶ瀬", "L4"), river("耳", "L3"), river("一ツ瀬", "L3"),
    ]) });
    const card = container.querySelector(".flood-card");
    expect(card?.classList.contains("height-budgeted")).toBe(true);
    expect(card?.classList.contains("many-rivers")).toBe(true);
    expect(container.querySelector(".more-many")?.textContent).toBe("ほか 3 河川");
    expect(container.querySelector(".more-narrow")?.textContent).toBe("ほか 4 河川");

    const three = render(FloodCard, { item: floodItem([
      river("大淀", "L4"), river("小丸", "L3"), river("五ヶ瀬", "L3"),
    ]) });
    expect(three.container.querySelector(".flood-card")?.classList.contains("many-rivers")).toBe(true);
    expect(three.container.querySelector(".more-many")?.textContent).toBe("ほか 1 河川");

    const source = readFileSync(join(__dirname, "..", "FloodCard.svelte"), "utf8");
    expect(source).toContain('data-flood-aggregated-normal={index >= 2 ? "true" : undefined}');
    expect(source).toContain('data-flood-aggregated-narrow={index >= 1 ? "true" : undefined}');
    expect(source).toMatch(/\.many-rivers \[data-flood-aggregated-normal\]\s*\{\s*display:\s*none;/s);
    expect(source).toMatch(/@container \(max-width: 320px\)[\s\S]*\[data-flood-aggregated-narrow\]\s*\{\s*display:\s*none;/s);
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
