<script module lang="ts">
  let malformedAshfallToneReported = false;
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { formatHm } from "../lib/format";
  import { VOLCANO_LEVEL_LABELS } from "../lib/standby-cards";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import { plumeHeightVisual } from "../lib/plume-height";
  import type { PageRange } from "../lib/legacy-standby/types";
  import {
    pageRangeNeedsFooter,
    sequentialPartitionRanges,
    type PartitionProbe,
  } from "../lib/legacy-standby/page-partition";
  import {
    createCardPageCoordinator,
    type CardPageCoordinator,
  } from "../lib/legacy-standby/time-slice-scheduler.svelte";

  type VolcanoItem = Extract<ActiveStandbyCardV1, { kind: "volcano" }>;
  type VolcanoEntry = VolcanoItem["data"]["volcanoes"][number];
  interface VolcanoPage {
    identity: string;
    label: string;
    volcanoes: VolcanoEntry[];
    showWireOmitted: boolean;
    fingerprint: string;
  }
  type VolcanoAtomKind = "summary" | "ashfall-empty" | "group-label" | "area" | "omitted-area" | "omitted-group" | "wire-omitted";
  interface VolcanoAtom {
    kind: VolcanoAtomKind;
    identity: string;
    label: string;
    volcanoIndex: number | null;
    groupIndex?: number;
    areaIndex?: number;
  }

  let {
    item,
    pageCoordinator: suppliedPageCoordinator,
    rotationMember = false,
    pageScheduling = false,
    pageIndexOverride,
    measurementMaxPage = false,
    measurementRange,
    measurementPageFooter,
    partitionProbe,
    pagePlacement = "side",
    displayMode = "compact",
  }: {
    item: VolcanoItem;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    pageIndexOverride?: number;
    measurementMaxPage?: boolean;
    measurementRange?: PageRange;
    /** Forced-range probes normally infer the split footer from the range. */
    measurementPageFooter?: boolean;
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    displayMode?: "compact" | "full";
  } = $props();

  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;

  function ashfallPageIdentity(volcano: VolcanoEntry, ashCode: string, marker: string): string {
    const ashfall = volcano.ashfall!;
    const stateSubjectKey = `volcano:ashfall:${volcano.code}`;
    return `${stateSubjectKey}|${ashfall.sourceEventId}|${ashfall.generation}|${ashCode}|${marker}`;
  }

  function hasSummary(volcano: VolcanoEntry): boolean {
    return volcano.ashfall == null
      || volcano.alertLevel != null
      || volcano.alertClass?.isActive === true
      || volcano.latestEvent != null
      || (volcano.warningKind?.trim() ?? "") !== ""
      || (volcano.targetKinds?.length ?? 0) > 0;
  }

  function buildAtoms(source: VolcanoItem): VolcanoAtom[] {
    const atoms: VolcanoAtom[] = [];
    for (let volcanoIndex = 0; volcanoIndex < source.data.volcanoes.length; volcanoIndex += 1) {
      const volcano = source.data.volcanoes[volcanoIndex]!;
      const ashfall = volcano.ashfall;
      if (hasSummary(volcano)) {
        atoms.push({
          kind: "summary",
          identity: `volcano:${volcano.code}|summary`,
          label: volcano.name,
          volcanoIndex,
        });
      }
      if (ashfall == null) continue;
      let ashfallAtomCount = 0;
      for (let groupIndex = 0; groupIndex < ashfall.groups.length; groupIndex += 1) {
        const group = ashfall.groups[groupIndex]!;
        atoms.push({
          kind: "group-label",
          identity: ashfallPageIdentity(volcano, group.ashCode, "group-label"),
          label: `${volcano.name} ${group.ashName}`,
          volcanoIndex,
          groupIndex,
        });
        ashfallAtomCount += 1;
        for (let areaIndex = 0; areaIndex < group.areas.length; areaIndex += 1) {
          const area = group.areas[areaIndex]!;
          atoms.push({
            kind: "area",
            identity: ashfallPageIdentity(volcano, group.ashCode, area.identityKey),
            label: `${volcano.name} ${group.ashName} ${area.displayLabel}`,
            volcanoIndex,
            groupIndex,
            areaIndex,
          });
          ashfallAtomCount += 1;
        }
        if (group.omittedAreaCount > 0) {
          atoms.push({
            kind: "omitted-area",
            identity: ashfallPageIdentity(volcano, group.ashCode, `omitted-area:${group.omittedAreaCount}`),
            label: `${volcano.name} ${group.ashName} ほか ${group.omittedAreaCount} 地域`,
            volcanoIndex,
            groupIndex,
          });
          ashfallAtomCount += 1;
        }
      }
      if (ashfall.omittedGroupCount > 0) {
        atoms.push({
          kind: "omitted-group",
          identity: ashfallPageIdentity(volcano, "omitted-group", `omitted-group:${ashfall.omittedGroupCount}`),
          label: `${volcano.name} ほか ${ashfall.omittedGroupCount} 区分`,
          volcanoIndex,
        });
        ashfallAtomCount += 1;
      }
      if (ashfallAtomCount === 0) {
        atoms.push({
          kind: "ashfall-empty",
          identity: ashfallPageIdentity(volcano, "empty", "empty"),
          label: `${volcano.name} ${ashfall.label}`,
          volcanoIndex,
        });
      }
    }
    if ((source.data.ashfallOmittedCount ?? 0) > 0) {
      atoms.push({
        kind: "wire-omitted",
        identity: `volcano:ashfall:wire|${source.sourceEventIds.join(",")}|omitted:${source.data.ashfallOmittedCount}`,
        label: `降灰予報 ほか ${source.data.ashfallOmittedCount} 火山`,
        volcanoIndex: null,
      });
    }
    return atoms;
  }

  function summaryOnly(volcano: VolcanoEntry): VolcanoEntry {
    return { ...structuredClone(volcano), ashfall: null };
  }

  function ashfallOnly(volcano: VolcanoEntry): VolcanoEntry {
    return {
      ...structuredClone(volcano),
      alertLevel: null,
      warningKind: null,
      targetKinds: [],
      alertClass: null,
      latestEvent: null,
      ashfall: volcano.ashfall == null ? null : {
        ...structuredClone(volcano.ashfall),
        groups: [],
        omittedGroupCount: 0,
      },
    };
  }

  function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, member: unknown) => {
      if (member == null || Array.isArray(member) || typeof member !== "object") return member;
      return Object.fromEntries(Object.entries(member as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right)));
    });
  }

  function buildPage(source: VolcanoItem, sourceAtoms: readonly VolcanoAtom[], range: PageRange, footer: boolean): VolcanoPage | null {
    const selectedAtoms = sourceAtoms.slice(range.start, range.end);
    if (selectedAtoms.length === 0) return null;
    const pageVolcanoes = new Map<number, VolcanoEntry>();
    let showWireOmitted = false;
    for (const atom of selectedAtoms) {
      if (atom.kind === "wire-omitted") {
        showWireOmitted = true;
        continue;
      }
      const volcanoIndex = atom.volcanoIndex;
      if (volcanoIndex == null) continue;
      const sourceVolcano = source.data.volcanoes[volcanoIndex];
      if (sourceVolcano == null) continue;
      if (atom.kind === "summary") {
        const existing = pageVolcanoes.get(volcanoIndex);
        const summary = summaryOnly(sourceVolcano);
        if (existing?.ashfall != null) summary.ashfall = existing.ashfall;
        pageVolcanoes.set(volcanoIndex, summary);
        continue;
      }
      const pageVolcano = pageVolcanoes.get(volcanoIndex) ?? ashfallOnly(sourceVolcano);
      const pageAshfall = pageVolcano.ashfall;
      const sourceAshfall = sourceVolcano.ashfall;
      if (pageAshfall == null || sourceAshfall == null) continue;
      if (atom.kind === "omitted-group") {
        pageAshfall.omittedGroupCount = sourceAshfall.omittedGroupCount;
      } else if (atom.kind !== "ashfall-empty") {
        const groupIndex = atom.groupIndex;
        if (groupIndex == null) continue;
        const sourceGroup = sourceAshfall.groups[groupIndex];
        if (sourceGroup == null) continue;
        let pageGroup = pageAshfall.groups.find((group) => group.ashCode === sourceGroup.ashCode);
        if (pageGroup == null) {
          pageGroup = { ...structuredClone(sourceGroup), areas: [], omittedAreaCount: 0 };
          pageAshfall.groups.push(pageGroup);
        }
        if (atom.kind === "area") {
          const area = sourceGroup.areas[atom.areaIndex ?? -1];
          if (area != null) pageGroup.areas.push(structuredClone(area));
        } else if (atom.kind === "omitted-area") {
          pageGroup.omittedAreaCount = sourceGroup.omittedAreaCount;
        }
      }
      pageVolcanoes.set(volcanoIndex, pageVolcano);
    }
    const first = selectedAtoms[0]!;
    const volcanoes = [...pageVolcanoes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, volcano]) => volcano);
    const identity = first.identity;
    return {
      identity,
      label: first.label,
      volcanoes,
      showWireOmitted,
      fingerprint: canonicalJson({
        headerTitle: "火山情報",
        headerTone: source.data.headerTone,
        restored: source.restored,
        updatedAt: source.updatedAt,
        sourceEventIds: source.sourceEventIds,
        allVisibleSlices: source.data.volcanoes,
        wireOmitted: source.data.ashfallOmittedCount ?? 0,
        identity,
        atoms: selectedAtoms.map((atom) => atom.identity),
        page: { volcanoes, showWireOmitted },
        footer,
        pagePlacement,
        displayMode,
      }),
    };
  }

  function singletonRanges(count: number): PageRange[] {
    return Array.from({ length: count }, (_unused, start) => ({
      start,
      end: start + 1,
      tails: [],
      omittedAreaCount: 0,
    }));
  }

  const atoms = $derived(buildAtoms(item));
  const partition = $derived.by(() => {
    if (measurementRange != null) {
      return { ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1 };
    }
    if (partitionProbe != null) {
      return sequentialPartitionRanges("volcano", pagePlacement, atoms.length, 1, partitionProbe, () => []);
    }
    return { ranges: singletonRanges(atoms.length), pending: [], infeasible: false, probeCount: 0 };
  });
  const effectiveRanges = $derived(partition.ranges.length > 0 ? partition.ranges : singletonRanges(atoms.length));
  const pages = $derived(effectiveRanges.flatMap((range) => {
    const footer = measurementRange != null
      ? measurementPageFooter ?? pageRangeNeedsFooter(range, atoms.length)
      : effectiveRanges.length > 1;
    const page = buildPage(item, atoms, range, footer);
    return page == null ? [] : [page];
  }));
  const resetKey = $derived(JSON.stringify({
    sourceEventIds: item.sourceEventIds,
    updatedAt: item.updatedAt,
    headerTone: item.data.headerTone,
    pages: pages.map((page) => [page.identity, page.fingerprint]),
    pagePlacement,
    displayMode,
  }));
  $effect(() => {
    if (!pageScheduling || pages.length === 0 || partition.pending.length > 0) return;
    pageCoordinator.register({
      key: "volcano",
      identities: pages.map((page) => page.identity),
      fingerprints: pages.map((page) => page.fingerprint),
      labels: pages.map((page) => page.label),
      rotationMember,
      resetKey,
    });
  });
  onDestroy(() => { if (ownsPageCoordinator) pageCoordinator.dispose(); });

  const diagnostics = $derived(pageCoordinator.cardDiagnostics("volcano"));
  const selectedPageIndex = $derived(pageScheduling
    ? pageCoordinator.activeIndex("volcano")
    : pageIndexOverride == null || pages.length === 0
      ? 0
      : Math.min(Math.max(0, Math.trunc(pageIndexOverride)), pages.length - 1));
  const currentRange = $derived(measurementRange ?? effectiveRanges[selectedPageIndex] ?? effectiveRanges[0] ?? null);
  const maxAtomPages = $derived(atoms.flatMap((_atom, start) => {
    const range = { start, end: start + 1, tails: [], omittedAreaCount: 0 };
    const page = buildPage(item, atoms, range, atoms.length > 1);
    return page == null ? [] : [page];
  }));
  const measuredPage = $derived(measurementMaxPage
    ? [...maxAtomPages].sort((left, right) => right.fingerprint.length - left.fingerprint.length)[0] ?? null
    : null);
  const activePage = $derived(measuredPage ?? pages[selectedPageIndex] ?? pages[0] ?? null);
  const pagedRender = $derived(pageScheduling || pageIndexOverride != null || measurementMaxPage || measurementRange != null);
  const visibleVolcanoes = $derived(pagedRender
    ? activePage?.volcanoes ?? []
    : item.data.volcanoes);
  const showWireOmitted = $derived(pagedRender
    ? activePage?.showWireOmitted === true
    : (item.data.ashfallOmittedCount ?? 0) > 0);
  const showFooter = $derived(measurementRange != null
    ? measurementPageFooter ?? pageRangeNeedsFooter(measurementRange, atoms.length)
    : pages.length > 1 && (pageScheduling || pageIndexOverride != null));
  const pageLabel = $derived(measurementRange != null
    ? `${measurementRange.start > 0 ? 2 : 1}/${measurementRange.end < atoms.length ? 2 : 1}`
    : pageScheduling
    ? diagnostics.page
    : pages.length === 0 ? "0/0" : `${selectedPageIndex + 1}/${pages.length}`);

  // 見出し帯の段階カラーはカード内最高段階で決める (JMA 配色: レベル2=黄 / レベル3=橙 /
  // レベル4 または噴火速報=赤 / レベル5=紫)。severity では段階が足りないため data から導出する
  const maxAlertLevel = $derived(item.data.volcanoes.reduce((max, v) => Math.max(max, v.alertLevel ?? 0), 0));
  const hasEruptionFlash = $derived(item.data.volcanoes.some((v) => v.latestEvent?.label === "噴火速報"));
  const hasWarningClass = $derived(item.data.volcanoes.some((v) =>
    v.alertClass?.isActive === true && v.alertClass.severity === "warning",
  ));
  const hasAshfall = $derived(item.data.volcanoes.some((v) => v.ashfall != null));
  const hasAshfallSemantics = $derived(hasAshfall || (item.data.ashfallOmittedCount ?? 0) > 0);
  const fallbackBand = $derived(
    maxAlertLevel >= 5 ? "emergency"
      : maxAlertLevel >= 4 || hasEruptionFlash ? "red"
        : maxAlertLevel >= 3 || hasWarningClass ? "warning"
          : maxAlertLevel >= 2 || item.data.volcanoes.some((v) => v.latestEvent != null)
            ? "advisory"
            : "muted",
  );
  const validHeaderTone = $derived(
    item.data.headerTone === "muted"
    || item.data.headerTone === "advisory"
    || item.data.headerTone === "warning"
    || item.data.headerTone === "red"
    || item.data.headerTone === "emergency"
      ? item.data.headerTone
      : null,
  );
  $effect(() => {
    if (hasAshfallSemantics && validHeaderTone == null && !malformedAshfallToneReported) {
      malformedAshfallToneReported = true;
      console.warn("[volcano-card] ashfall semantics arrived without a valid engine headerTone");
    }
  });
  // Old snapshots have neither ashfall semantics nor headerTone.  Once ashfall
  // semantics are present, a malformed/missing tone contributes muted while
  // known alert/eruption fields retain their ordinary fallback tone.
  const band = $derived(validHeaderTone ?? fallbackBand);
  const headerStyle = $derived(band === "emergency"
    ? "--standby-header-container: var(--header-weatherEmergency-container); --standby-header-on: var(--header-weatherEmergency-on); --standby-header-band: var(--header-band-weatherEmergency)"
    : band === "red"
      ? "--standby-header-container: var(--header-tsunamiWarning-container); --standby-header-on: var(--header-tsunamiWarning-on); --standby-header-band: var(--header-band-tsunamiWarning)"
      : band === "warning"
        ? "--standby-header-container: var(--header-weatherWarning-container); --standby-header-on: var(--header-weatherWarning-on); --standby-header-band: var(--header-band-weatherWarning)"
        : band === "muted"
          ? "--standby-header-container: var(--surface-standby); --standby-header-on: var(--fg); --standby-header-band: var(--surface-standby)"
          : "--standby-header-container: var(--header-weatherAdvisory-container); --standby-header-on: var(--header-weatherAdvisory-on); --standby-header-band: var(--header-band-weatherAdvisory)");

  function compactLevelText(value: string): string {
    return value.normalize("NFKC").replace(/\s+/g, "");
  }

  function duplicatesMainAlertLevel(kind: string, alertLevel: number | null): boolean {
    if (alertLevel == null) return false;
    const label = VOLCANO_LEVEL_LABELS[alertLevel];
    if (label == null) return false;
    const normalized = compactLevelText(kind);
    return normalized === compactLevelText(`レベル${alertLevel}（${label}）`)
      || normalized === compactLevelText(`噴火警戒レベル${alertLevel}（${label}）`);
  }

  function alertMeaning(volcano: Extract<ActiveStandbyCardV1, { kind: "volcano" }>["data"]["volcanoes"][number]): string | null {
    const targetKinds = (volcano.targetKinds ?? [])
      .map((kind) => kind.trim())
      .filter((kind, index, all) => kind !== ""
        && all.indexOf(kind) === index
        && !duplicatesMainAlertLevel(kind, volcano.alertLevel));
    const visibleKinds = targetKinds.slice(0, 2);
    if (targetKinds.length > visibleKinds.length) visibleKinds.push(`ほか${targetKinds.length - visibleKinds.length}種`);
    const rawWarningKind = volcano.warningKind?.trim() ?? "";
    const warningKind = duplicatesMainAlertLevel(rawWarningKind, volcano.alertLevel)
      ? ""
      : rawWarningKind;
    const alertClassName = volcano.alertClass?.isActive === true ? volcano.alertClass.name.trim() : "";
    const parts = [warningKind === alertClassName ? "" : warningKind, visibleKinds.join("・")]
      .filter((part) => part !== "");
    return parts.length === 0 ? null : parts.join(" / ");
  }

  function hasEventStats(
    event: NonNullable<Extract<ActiveStandbyCardV1, { kind: "volcano" }>["data"]["volcanoes"][number]["latestEvent"]>,
  ): boolean {
    return event.craterName != null
      || event.eventDateTime != null
      || event.plumeHeightM != null
      || event.plumeHeightUnknown
      || plumeVisual(event).render
      || event.plumeDirection != null;
  }

  function plumeVisual(
    event: NonNullable<Extract<ActiveStandbyCardV1, { kind: "volcano" }>["data"]["volcanoes"][number]["latestEvent"]>,
  ) {
    return plumeHeightVisual(
      event.plumeHeightAboveCraterSemantic,
      event.plumeHeightM,
      event.plumeHeightUnknown,
    );
  }
</script>

<section
  class="standby-card volcano-card band-{band}"
  class:has-page-footer={showFooter}
  class:paged-volcano={pagedRender && (pages.length > 1 || measurementRange != null)}
  class:measurement-range={measurementRange != null}
  data-page-probe-card={measurementRange != null ? "" : undefined}
  data-page-probe-body={measurementRange != null ? "" : undefined}
  data-page-probe-readable={measurementRange != null ? "" : undefined}
  data-partition-probe-count={partition.probeCount}
  data-volcano-page-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`}
  data-card-page-infeasible={partition.infeasible ? "true" : "false"}
  data-card-page-pending={partition.pending.length > 0 ? "true" : "false"}
  data-volcano-card
  data-card-page={pageLabel}
  data-card-page-keys={JSON.stringify(diagnostics.keys)}
  data-card-page-identities={JSON.stringify(diagnostics.identities)}
  data-volcano-page-identity={activePage?.identity}
>
  <header class="standby-card-header" class:standby-card-header--muted={band === "muted"} style={headerStyle}><span class="standby-card-header__title">火山情報</span><span class="standby-card-header__meta">{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></span></header>
  {#each visibleVolcanoes as volcano (volcano.code)}
    {@const meaning = alertMeaning(volcano)}
    <div class="volcano">
      <div class="volcano-main">
        <span>{volcano.name}</span>
        {#if volcano.alertLevel != null}
          <span><NumberUnit prefix="レベル" value={String(volcano.alertLevel)} />（{VOLCANO_LEVEL_LABELS[volcano.alertLevel]}）</span>
        {:else if volcano.alertClass?.isActive}
          <span>{volcano.alertClass.name}</span>
        {/if}
      </div>
      {#if meaning != null}<div class="alert-meaning">{meaning}</div>{/if}
      {#if volcano.latestEvent != null}
        {@const plume = plumeVisual(volcano.latestEvent)}
        <strong>{volcano.latestEvent.label}</strong>
        {#if hasEventStats(volcano.latestEvent)}
          <div class="event-stats">
            {#if volcano.latestEvent.craterName != null}
              <div class="stat crater-stat"><span class="stat-label">火口</span><span class="stat-value">{volcano.latestEvent.craterName}</span></div>
            {/if}
            {#if volcano.latestEvent.eventDateTime != null}
              <div class="stat event-time-stat"><span class="stat-label">噴火時刻</span><span class="stat-value">{formatHm(volcano.latestEvent.eventDateTime)}</span></div>
            {/if}
            {#if plume.render}
              <div class="stat plume-height-stat">
                <span class="stat-label">噴煙高度</span>
                <span class="stat-value" title={plume.tooltip ?? undefined} aria-label={plume.ariaLabel}>
                  {#if plume.numericValue != null}
                    <NumberUnit value={String(plume.numericValue)} unit={plume.unit} />
                  {:else}
                    {plume.label}
                  {/if}
                  {#if plume.badge != null}<b class="semantic-badge" aria-hidden="true">{plume.badge}</b>{/if}
                </span>
              </div>
            {/if}
            {#if volcano.latestEvent.plumeDirection != null}
              <div class="stat plume-direction-stat"><span class="stat-label">流向</span><span class="stat-value">{volcano.latestEvent.plumeDirection}</span></div>
            {/if}
          </div>
        {/if}
      {/if}
      {#if volcano.ashfall != null}
        <div class="ashfall" aria-label={`${volcano.ashfall.label} ${volcano.ashfall.forecastEndLabel}`}>
          <strong>{volcano.ashfall.label}</strong><span class="ashfall-end">{volcano.ashfall.forecastEndLabel}</span>
          {#each volcano.ashfall.groups as group (`${group.hazardClass}:${group.ashCode}`)}
            <div class="ashfall-group">
              <span>{group.ashName}</span>
              <span class="ashfall-areas">
                {#each group.areas as area, areaIndex (area.identityKey)}{#if areaIndex > 0}、{/if}<span class="ashfall-area" aria-label={area.displayLabel} data-ashfall-area-identity={area.identityKey}>{area.displayLabel}</span>{/each}{#if group.omittedAreaCount > 0}{#if group.areas.length > 0}{"　"}{/if}ほか {group.omittedAreaCount} 地域{/if}
              </span>
            </div>
          {/each}
          {#if volcano.ashfall.omittedGroupCount > 0}<div class="ashfall-omitted">ほか {volcano.ashfall.omittedGroupCount} 区分</div>{/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if showWireOmitted && (item.data.ashfallOmittedCount ?? 0) > 0}
    <div class="ashfall-wire-omitted" aria-label={`降灰予報 ほか ${item.data.ashfallOmittedCount} 火山`}>
      降灰予報　ほか {item.data.ashfallOmittedCount} 火山
    </div>
  {/if}
  {#if showFooter}
    <footer class="card-page-footer" data-card-page-footer>
      <span class="card-page-indicator" data-card-page-indicator>{pageLabel}</span>
    </footer>
  {/if}
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  .paged-volcano { max-height: min(44vh, 280px); }
  /* 直近イベント (噴火速報 等) の強調色も帯段階に合わせる */
  .band-advisory strong { color: var(--role-weatherAdvisory); }
  .band-warning strong { color: var(--role-weatherWarning); }
  .band-red strong { color: var(--role-tsunamiWarning); }
  .band-emergency strong { color: var(--role-weatherEmergency); }
  .volcano { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); font-size: max(14px, var(--type-label-l-fluid)); }
  .volcano-main span + span::before { content: "　"; }
  .alert-meaning { margin-top: 2px; color: var(--role-muted); font-size: max(12px, var(--type-label-s-fluid)); }
  strong { display: block; margin-top: 2px; }
  /* 警報補助行との共存時も横一列へ詰め込まず、2列×最大2段で読み順と幅を守る。 */
  .event-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-1) var(--space-3); margin-top: var(--space-1); }
  .stat { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .stat-label { color: var(--role-muted); font-size: var(--type-label-xs-size); }
  .stat-value { color: var(--fg); font-size: max(14px, var(--type-body-l-fluid)); font-weight: var(--num-weight); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
  .ashfall { display: grid; gap: var(--space-1); margin-top: var(--space-2); }
  .ashfall-end, .ashfall-omitted { color: var(--role-muted); font-size: var(--type-label-xs-size); }
  .ashfall-group { display: grid; grid-template-columns: minmax(5em, auto) 1fr; gap: var(--space-2); font-size: max(12px, var(--type-label-s-fluid)); }
  .ashfall-wire-omitted { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-muted); font-size: var(--type-label-xs-size); }
  .volcano-card.has-page-footer { --card-page-indicator-block-size: calc(var(--type-label-xs-size) + 4px); position: relative; padding-bottom: var(--card-page-indicator-block-size); }
  .card-page-footer { position: absolute; inset-inline: 0; bottom: 0; display: flex; align-items: center; justify-content: flex-end; box-sizing: border-box; height: var(--card-page-indicator-block-size); min-height: var(--card-page-indicator-block-size); padding: 0 var(--space-4); overflow: hidden; pointer-events: none; z-index: 1; }
  .card-page-indicator { box-sizing: border-box; block-size: var(--card-page-indicator-block-size); padding: 1px var(--space-2); border: 1px solid var(--hairline); border-radius: var(--radius-s); background: color-mix(in srgb, var(--surface-standby) 92%, transparent); color: var(--role-muted); font-size: var(--type-label-xs-size); line-height: 1; font-variant-numeric: tabular-nums; }
</style>
