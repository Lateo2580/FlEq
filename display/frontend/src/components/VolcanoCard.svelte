<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { VOLCANO_LEVEL_LABELS } from "../lib/standby-cards";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "volcano" }> } = $props();

  // 見出し帯の段階カラーはカード内最高段階で決める (JMA 配色: レベル2=黄 / レベル3=橙 /
  // レベル4 または噴火速報=赤 / レベル5=紫)。severity では段階が足りないため data から導出する
  const maxAlertLevel = $derived(item.data.volcanoes.reduce((max, v) => Math.max(max, v.alertLevel ?? 0), 0));
  const hasEruptionFlash = $derived(item.data.volcanoes.some((v) => v.latestEvent === "噴火速報"));
  const band = $derived(
    maxAlertLevel >= 5 ? "emergency"
      : maxAlertLevel >= 4 || hasEruptionFlash ? "red"
        : maxAlertLevel >= 3 ? "warning"
          : "advisory",
  );
</script>

<section class="standby-card volcano-card band-{band}">
  <header>火山情報{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></header>
  {#each item.data.volcanoes as volcano (volcano.code)}
    <div class="volcano"><span>{volcano.name}</span>{#if volcano.alertLevel != null}<span><NumberUnit prefix="レベル" value={String(volcano.alertLevel)} />（{VOLCANO_LEVEL_LABELS[volcano.alertLevel]}）</span>{/if}{#if volcano.latestEvent != null}<strong>{volcano.latestEvent}</strong>{/if}</div>
  {/each}
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); max-height: 240px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
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
  .volcano { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); font-size: max(14px, var(--type-label-l-fluid)); } .volcano span + span::before { content: "　"; } strong { display: block; }
</style>
