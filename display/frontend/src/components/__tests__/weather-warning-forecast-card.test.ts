import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import WeatherWarningForecastCard from "../WeatherWarningForecastCard.svelte";
import type {
  ActiveStandbyCardV1,
  DisplayWeatherWarningForecastPeriodV1,
  DisplayWeatherWarningForecastTargetV1,
} from "../../lib/protocol";
import {
  buildWeatherWarningForecastAtoms,
  vpwp50ForecastTargetLabel,
} from "../../lib/weather-warning-forecast";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import { legacyImprovedWeatherWarningForecast } from "../../preview/fixtures";

function period(
  key: string,
  anchor: string,
  ordinal: number,
  slot: 0 | 1 | 2 | 3,
): DisplayWeatherWarningForecastPeriodV1 {
  const hour = ordinal * 12 + slot * 3;
  return {
    key,
    tsNum: 1,
    series: "3h",
    startsAt: new Date(Date.UTC(2026, 5, 6, hour)).toISOString(),
    endsAt: new Date(Date.UTC(2026, 5, 6, hour + 3)).toISOString(),
    label: `6月6日 ${String(hour + 9).padStart(2, "0")}:00–${String(hour + 12).padStart(2, "0")}:00`,
    pagerAnchorKey: anchor,
    pagerAnchorOrdinal: ordinal,
    pagerSlot: slot,
  };
}

function forecastCard(restored = true): Extract<ActiveStandbyCardV1, { kind: "weatherWarningForecast" }> {
  return {
    kind: "weatherWarningForecast",
    surface: "corner-right",
    key: "weatherWarningForecast:active",
    sourceEventIds: ["fixture-message-id"],
    updatedAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2026-06-07T00:00:00.000Z",
    restored,
    severity: "warning",
    data: { groups: [
      {
        key: "group-21",
        phenomenonName: "土砂災害危険度",
        significancyCode: "21",
        forecastLabel: "土砂災害（警戒レベル2）の予測",
        displaySeverity: "officialL2",
        severity: "normal",
        targets: [{
          key: "target-area",
          scope: "area",
          name: "長野県北部",
          parentAreaName: "長野県北部",
          areaCode: "200010",
          localCode: null,
          periods: [
            period("p-0", "anchor-0", 0, 0),
            period("p-1", "anchor-0", 0, 1),
            period("p-2", "anchor-1", 1, 0),
          ],
        }],
      },
      {
        key: "group-22",
        phenomenonName: "土砂災害危険度",
        significancyCode: "22",
        forecastLabel: "土砂災害（警戒レベル2相当）の予測",
        displaySeverity: "officialL2",
        severity: "normal",
        targets: [{
          key: "target-local",
          scope: "local",
          name: "沿岸",
          parentAreaName: "長野県南部",
          areaCode: "200020",
          localCode: "001",
          periods: [period("p-3", "anchor-2", 0, 0)],
        }],
      },
    ] },
  };
}

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (value == null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectStringLeaves);
}

function renderedStrings(root: Element): string[] {
  const values = [root.textContent ?? ""];
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (attribute.name === "title" || attribute.name.startsWith("aria-")) values.push(attribute.value);
    }
  }
  return values;
}

describe("WeatherWarningForecastCard", () => {
  it.each([
    [{ scope: "area", parentAreaName: "長野県北部", name: "長野県北部", areaCode: "200010", localCode: null }, "長野県北部（200010）"],
    [{ scope: "area", parentAreaName: "長野県北部", name: "長野県北部", areaCode: null, localCode: null }, "長野県北部"],
    [{ scope: "local", parentAreaName: "長野県北部", name: "沿岸", areaCode: "200010", localCode: "001" }, "長野県北部（200010） / 沿岸（001）"],
    [{ scope: "local", parentAreaName: "長野県北部", name: "沿岸", areaCode: null, localCode: null }, "長野県北部 / 沿岸"],
    [{ scope: "local", parentAreaName: "長野県北部", name: "沿岸", areaCode: "200010", localCode: null }, "長野県北部（200010） / 沿岸"],
    [{ scope: "local", parentAreaName: "長野県北部", name: "沿岸", areaCode: null, localCode: "001" }, "長野県北部 / 沿岸（001）"],
  ] as const)("formats authoritative Area / Local fields", (fields, expected) => {
    const target = { key: "target", periods: [], ...fields } as DisplayWeatherWarningForecastTargetV1;
    expect(vpwp50ForecastTargetLabel(target)).toBe(expected);
  });

  it("renders the engine labels, full target label, JST period, restoration, continuation, and ARIA", () => {
    const item = forecastCard();
    const { container } = render(WeatherWarningForecastCard, { item, pageIndexOverride: 2 });
    const root = container.querySelector("[data-weather-warning-forecast-card]");
    expect(root?.textContent).toContain("気象警報予測");
    expect(root?.textContent).toContain("土砂災害（警戒レベル2相当）の予測");
    expect(root?.textContent).toContain("長野県南部（200020） / 沿岸（001）");
    expect(root?.textContent).toContain("6月6日 09:00–12:00");
    expect(root?.textContent).toContain("続き 3/3");
    expect(root?.textContent).toContain("同期中");
    expect(root?.querySelector(".restored-chip")).toBeTruthy();
    expect(root?.getAttribute("aria-label")).toContain("長野県南部（200020） / 沿岸（001）");
    expect(root?.getAttribute("aria-label")).toContain("6月6日 09:00–12:00");
    expect(root?.getAttribute("data-card-page")).toBe("3/3");
    expect(root?.querySelector("[data-card-page-footer]")).toBeTruthy();
  });

  it("registers each immutable anchor as one independently reachable pager atom", async () => {
    const coordinator = createCardPageCoordinator();
    const item = forecastCard(false);
    const view = render(WeatherWarningForecastCard, {
      item,
      pageCoordinator: coordinator,
      pageScheduling: true,
    });
    await tick();
    expect(coordinator.cardDiagnostics("weatherWarningForecast")).toMatchObject({
      page: "1/3",
      identities: [
        JSON.stringify(["group-21", "target-area", "anchor-0"]),
        JSON.stringify(["group-21", "target-area", "anchor-1"]),
        JSON.stringify(["group-22", "target-local", "anchor-2"]),
      ],
    });
    coordinator.jumpTo("weatherWarningForecast", 2);
    await tick();
    expect(view.container.querySelector("[data-weather-warning-forecast-card]")?.textContent)
      .toContain("警戒レベル2相当");
    view.unmount();
    coordinator.dispose();
  });

  it("partitions the 128-period preview into 32 stable four-period atoms without loss", () => {
    const atoms = buildWeatherWarningForecastAtoms(legacyImprovedWeatherWarningForecast);
    expect(atoms).toHaveLength(32);
    expect(atoms.every((atom) => atom.periods.length === 4)).toBe(true);
    const expected = legacyImprovedWeatherWarningForecast.data.groups.flatMap((group) =>
      group.targets.flatMap((target) => target.periods.map((candidate) => candidate.key)));
    const actual = atoms.flatMap((atom) => atom.periods.map((candidate) => candidate.key));
    expect(actual).toHaveLength(128);
    expect(new Set(actual)).toEqual(new Set(expected));
    expect(new Set(atoms.map((atom) => atom.identity)).size).toBe(32);
  });

  it("keeps 128 one-period targets as 128 independently reachable atoms", () => {
    const item = forecastCard(false);
    const template = item.data.groups[0]!.targets[0]!;
    item.data.groups = [{
      ...item.data.groups[0]!,
      targets: Array.from({ length: 128 }, (_, index) => ({
        ...template,
        key: `target-${String(index).padStart(3, "0")}`,
        name: `地域${index}`,
        parentAreaName: `地域${index}`,
        areaCode: String(200_000 + index),
        periods: [period(`target-period-${index}`, `target-anchor-${index}`, 0, 0)],
      })),
    }];
    const atoms = buildWeatherWarningForecastAtoms(item);
    expect(atoms).toHaveLength(128);
    expect(new Set(atoms.map((atom) => atom.target.key)).size).toBe(128);
    expect(atoms.every((atom) => atom.periods.length === 1)).toBe(true);
    const coordinator = createCardPageCoordinator();
    coordinator.register({
      key: "weatherWarningForecast",
      identities: atoms.map((atom) => atom.identity),
      fingerprints: atoms.map((atom) => atom.fingerprint),
      labels: atoms.map((atom) => atom.label),
      rotationMember: false,
      resetKey: "128-targets",
    });
    for (let index = 0; index < atoms.length; index += 1) {
      coordinator.jumpTo("weatherWarningForecast", index);
      expect(coordinator.activeIndex("weatherWarningForecast")).toBe(index);
    }
    coordinator.dispose();
  });

  it("preserves immutable anchor identities and slot gaps through partial expiry", () => {
    const item = forecastCard(false);
    const target = item.data.groups[0]!.targets[0]!;
    target.periods = Array.from({ length: 12 }, (_, index) =>
      period(`expiry-${index}`, `expiry-anchor-${Math.floor(index / 4)}`, Math.floor(index / 4), (index % 4) as 0 | 1 | 2 | 3));
    item.data.groups = [{ ...item.data.groups[0]!, targets: [target] }];
    const initial = buildWeatherWarningForecastAtoms(item);
    expect(initial).toHaveLength(3);

    target.periods = target.periods.slice(1);
    const partiallyExpired = buildWeatherWarningForecastAtoms(item);
    expect(partiallyExpired.map((atom) => atom.identity)).toEqual(initial.map((atom) => atom.identity));
    expect(partiallyExpired[0]?.periods.map((candidate) => candidate.pagerSlot)).toEqual([1, 2, 3]);

    target.periods = target.periods.filter((candidate) => candidate.pagerAnchorOrdinal !== 0);
    const anchorExpired = buildWeatherWarningForecastAtoms(item);
    expect(anchorExpired.map((atom) => atom.identity)).toEqual(initial.slice(1).map((atom) => atom.identity));
    expect(anchorExpired.map((atom) => atom.pagerAnchorOrdinal)).toEqual([1, 2]);
  });

  it("uses the sum of per-target anchor chunks for a mixed 128-period partition", () => {
    const item = forecastCard(false);
    const template = item.data.groups[0]!.targets[0]!;
    const counts = [1, 2, 4, 5, 7, 109];
    item.data.groups = [{
      ...item.data.groups[0]!,
      targets: counts.map((count, targetIndex) => ({
        ...template,
        key: `mixed-target-${targetIndex}`,
        periods: Array.from({ length: count }, (_, index) =>
          period(
            `mixed-${targetIndex}-${index}`,
            `mixed-anchor-${targetIndex}-${Math.floor(index / 4)}`,
            Math.floor(index / 4),
            (index % 4) as 0 | 1 | 2 | 3,
          )),
      })),
    }];
    const atoms = buildWeatherWarningForecastAtoms(item);
    expect(item.data.groups[0]!.targets.reduce((sum, candidate) => sum + candidate.periods.length, 0)).toBe(128);
    expect(atoms).toHaveLength(counts.reduce((sum, count) => sum + Math.ceil(count / 4), 0));
    expect(atoms.flatMap((atom) => atom.periods)).toHaveLength(128);
  });

  it("never introduces tornado semantics anywhere in the thunder DTO or rendered subtree", () => {
    const item = forecastCard(false);
    item.data.groups = [{
      ...item.data.groups[0]!,
      key: "lightning",
      phenomenonName: "雷",
      significancyCode: "20",
      forecastLabel: "雷注意報級の予測",
    }];
    const forbidden = ["竜巻注意情報", "竜巻", "突風"];
    const dtoStrings = collectStringLeaves(item);
    const { container } = render(WeatherWarningForecastCard, { item });
    const root = container.querySelector("[data-weather-warning-forecast-card]");
    expect(root).not.toBeNull();
    const all = [...dtoStrings, ...renderedStrings(root!)];
    for (const value of all) for (const token of forbidden) expect(value).not.toContain(token);
  });

  it("period spacingをtoken化し、複数atomでも共通header paddingを上書きしない", () => {
    const source = readFileSync(join(__dirname, "..", "WeatherWarningForecastCard.svelte"), "utf8");
    expect(source).toContain(".periods { display: grid; gap: var(--space-1); }");
    expect(source).not.toMatch(/has-page-footer\s+\.standby-card-header/);
    expect(source).toMatch(/\.forecast-card\.has-page-footer\s*\{[^}]*padding-bottom:\s*var\(--card-page-indicator-block-size\);/s);
  });
});
