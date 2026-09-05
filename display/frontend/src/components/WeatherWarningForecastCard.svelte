<script module lang="ts">
  export {
    buildWeatherWarningForecastAtoms,
    vpwp50ForecastTargetDisplayLabel,
    vpwp50ForecastTargetLabel,
  } from "../lib/weather-warning-forecast";
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import {
    buildWeatherWarningForecastAtoms,
    vpwp50ForecastTargetDisplayLabel,
    vpwp50ForecastTargetLabel,
  } from "../lib/weather-warning-forecast";
  import {
    createCardPageCoordinator,
    type CardPageCoordinator,
  } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import RestoredChip from "./RestoredChip.svelte";

  let {
    item,
    pageCoordinator: suppliedPageCoordinator,
    rotationMember = false,
    pageScheduling = false,
    measurementMaxAtom = false,
    pageIndexOverride,
  }: {
    item: Extract<ActiveStandbyCardV1, { kind: "weatherWarningForecast" }>;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    measurementMaxAtom?: boolean;
    pageIndexOverride?: number;
  } = $props();

  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;
  const atoms = $derived(buildWeatherWarningForecastAtoms(item));
  const pagerLogicalItems = $derived(atoms.map((candidate) => candidate.identity));
  const pagerLogicalFingerprints = $derived(atoms.map((candidate) => candidate.fingerprint));
  const pagerResetItems = $derived([...item.sourceEventIds, item.updatedAt]);
  const resetKey = $derived(item.sourceEventIds.join(",") + ":" + item.updatedAt);
  $effect(() => {
    if (!pageScheduling || atoms.length === 0) return;
    pageCoordinator.register({
      key: "weatherWarningForecast",
      identities: atoms.map((atom) => atom.identity),
      fingerprints: atoms.map((atom) => atom.fingerprint),
      labels: atoms.map((atom) => atom.label),
      rotationMember,
      resetKey,
    });
  });
  onDestroy(() => { if (ownsPageCoordinator) pageCoordinator.dispose(); });

  const diagnostics = $derived(pageCoordinator.cardDiagnostics("weatherWarningForecast"));
  const activeIndex = $derived(pageScheduling
    ? pageCoordinator.activeIndex("weatherWarningForecast")
    : pageIndexOverride == null || atoms.length === 0
      ? 0
      : Math.min(Math.max(0, Math.trunc(pageIndexOverride)), atoms.length - 1));
  const atom = $derived(measurementMaxAtom
    ? [...atoms].sort((left, right) => right.periods.length - left.periods.length)[0] ?? null
    : atoms[activeIndex] ?? atoms[0] ?? null);
  const showFooter = $derived(atoms.length > 1);
  const pageLabel = $derived(pageScheduling
    ? diagnostics.page
    : atoms.length === 0 ? "0/0" : `${activeIndex + 1}/${atoms.length}`);

  function headerContainer(): string {
    if (item.severity === "critical") return "var(--header-weatherEmergency-container)";
    if (item.severity === "warning") return "var(--header-weatherWarning-container)";
    return "var(--header-weatherAdvisory-container)";
  }
  function headerOn(): string {
    if (item.severity === "critical") return "var(--header-weatherEmergency-on)";
    if (item.severity === "warning") return "var(--header-weatherWarning-on)";
    return "var(--header-weatherAdvisory-on)";
  }
  function headerBand(): string {
    if (item.severity === "critical") return "var(--header-band-weatherEmergency)";
    if (item.severity === "warning") return "var(--header-band-weatherWarning)";
    return "var(--header-band-weatherAdvisory)";
  }
  const seriesLabel = (series: "3h" | "24h" | "day"): string =>
    series === "3h" ? "3時間" : series === "24h" ? "24時間" : "日単位";
</script>

<section
  class="standby-card forecast-card"
  aria-label={atom?.accessibleLabel ?? "気象警報予測"}
  data-weather-warning-forecast-card
  data-card-page={pageLabel}
  data-card-page-keys={JSON.stringify(diagnostics.keys)}
  data-card-page-identities={JSON.stringify(diagnostics.identities)}
  data-card-page-active-identity={diagnostics.activeKey ?? undefined}
  data-pager-namespace="card-page-coordinator"
  data-pager-key="weatherWarningForecast"
  data-pager-logical-items={JSON.stringify(pagerLogicalItems)}
  data-pager-logical-fingerprints={JSON.stringify(pagerLogicalFingerprints)}
  data-pager-reset-items={JSON.stringify(pagerResetItems)}
  data-pager-logical-source-count={pagerLogicalItems.length}
>
  <header class="standby-card-header" style="--standby-header-container: {headerContainer()}; --standby-header-on: {headerOn()}; --standby-header-band: {headerBand()}">
    <span class="standby-card-header__title">気象警報予測</span>
    <span class="standby-card-header__meta">
      {#if item.restored}<RestoredChip />{/if}
      <UpdatedStamp iso={item.updatedAt} />
    </span>
  </header>
  {#if atom != null}
    <article class="forecast-atom" data-forecast-atom={atom.identity} aria-label={atom.accessibleLabel}>
      <div class="forecast-label" title={atom.group.forecastLabel}>{atom.group.forecastLabel}</div>
      <div class="target-row"><span class="target" title={vpwp50ForecastTargetLabel(atom.target)}>{vpwp50ForecastTargetDisplayLabel(atom.target)}</span></div>
      <div class="periods">
        {#each atom.periods as period (period.key)}
          <div class="period" title={period.label} data-forecast-period={period.key}>
            <span>{seriesLabel(period.series)}</span><span>{period.label}</span>
          </div>
        {/each}
      </div>
    </article>
  {/if}
  {#if showFooter}
    <footer class="card-page-footer" data-card-page-footer>
      <span class="card-page-indicator" data-card-page-indicator>{pageLabel}</span>
    </footer>
  {/if}
</section>

<style>
  .forecast-card {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
    box-shadow: var(--elevation-2);
    color: var(--fg);
  }
  .forecast-atom { display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-4); }
  .forecast-label { overflow: hidden; font-size: var(--type-label-l-fluid); font-weight: var(--type-body-weight-emphasized); text-overflow: ellipsis; white-space: nowrap; }
  /* A single target still uses the old baseline flex line so removing the
     continuation node does not change the atom's natural line box. */
  .target-row { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .target { min-width: 0; overflow: hidden; font-size: var(--type-label-s-fluid); text-overflow: ellipsis; white-space: nowrap; }
  .periods { display: grid; gap: var(--space-1); }
  .period { display: grid; grid-template-columns: 3.2rem minmax(0, 1fr); gap: var(--space-2); color: var(--role-muted); font-size: var(--type-label-s-fluid); white-space: nowrap; }
  .period span:last-child { overflow: hidden; text-overflow: ellipsis; }
</style>
