<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { formatHm } from "../lib/format";
  import { VOLCANO_LEVEL_LABELS } from "../lib/standby-cards";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "volcano" }> } = $props();

  // 見出し帯の段階カラーはカード内最高段階で決める (JMA 配色: レベル2=黄 / レベル3=橙 /
  // レベル4 または噴火速報=赤 / レベル5=紫)。severity では段階が足りないため data から導出する
  const maxAlertLevel = $derived(item.data.volcanoes.reduce((max, v) => Math.max(max, v.alertLevel ?? 0), 0));
  const hasEruptionFlash = $derived(item.data.volcanoes.some((v) => v.latestEvent?.label === "噴火速報"));
  const band = $derived(
    maxAlertLevel >= 5 ? "emergency"
      : maxAlertLevel >= 4 || hasEruptionFlash ? "red"
        : maxAlertLevel >= 3 ? "warning"
          : "advisory",
  );

  function alertMeaning(volcano: Extract<ActiveStandbyCardV1, { kind: "volcano" }>["data"]["volcanoes"][number]): string | null {
    const targetKinds = (volcano.targetKinds ?? [])
      .map((kind) => kind.trim())
      .filter((kind, index, all) => kind !== "" && all.indexOf(kind) === index);
    const visibleKinds = targetKinds.slice(0, 2);
    if (targetKinds.length > visibleKinds.length) visibleKinds.push(`ほか${targetKinds.length - visibleKinds.length}種`);
    const parts = [volcano.warningKind?.trim() ?? "", visibleKinds.join("・")]
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
      || event.plumeDirection != null;
  }
</script>

<section class="standby-card volcano-card band-{band}">
  <header>火山情報{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></header>
  {#each item.data.volcanoes as volcano (volcano.code)}
    {@const meaning = alertMeaning(volcano)}
    <div class="volcano">
      <div class="volcano-main"><span>{volcano.name}</span>{#if volcano.alertLevel != null}<span><NumberUnit prefix="レベル" value={String(volcano.alertLevel)} />（{VOLCANO_LEVEL_LABELS[volcano.alertLevel]}）</span>{/if}</div>
      {#if meaning != null}<div class="alert-meaning">{meaning}</div>{/if}
      {#if volcano.latestEvent != null}
        <strong>{volcano.latestEvent.label}</strong>
        {#if hasEventStats(volcano.latestEvent)}
          <div class="event-stats">
            {#if volcano.latestEvent.craterName != null}
              <div class="stat crater-stat"><span class="stat-label">火口</span><span class="stat-value">{volcano.latestEvent.craterName}</span></div>
            {/if}
            {#if volcano.latestEvent.eventDateTime != null}
              <div class="stat event-time-stat"><span class="stat-label">噴火時刻</span><span class="stat-value">{formatHm(volcano.latestEvent.eventDateTime)}</span></div>
            {/if}
            {#if volcano.latestEvent.plumeHeightM != null || volcano.latestEvent.plumeHeightUnknown}
              <div class="stat plume-height-stat">
                <span class="stat-label">噴煙高度</span>
                <span class="stat-value">
                  {#if volcano.latestEvent.plumeHeightM != null}
                    <NumberUnit value={String(volcano.latestEvent.plumeHeightM)} unit="m" />
                  {:else}
                    不明
                  {/if}
                </span>
              </div>
            {/if}
            {#if volcano.latestEvent.plumeDirection != null}
              <div class="stat plume-direction-stat"><span class="stat-label">流向</span><span class="stat-value">{volcano.latestEvent.plumeDirection}</span></div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 看板ヘッダ帯: 段階カラーは band クラスで切替 (レベル2=黄 / 3=橙 / 4・噴火速報=赤 / 5=紫) */
  header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
  }
  .band-advisory header {
    background: var(--header-weatherAdvisory-container);
    color: var(--header-weatherAdvisory-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherAdvisory);
  }
  .band-warning header {
    background: var(--header-weatherWarning-container);
    color: var(--header-weatherWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning);
  }
  .band-red header {
    background: var(--header-tsunamiWarning-container);
    color: var(--header-tsunamiWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-tsunamiWarning);
  }
  .band-emergency header {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherEmergency);
  }
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
</style>
