<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "typhoon" }> } = $props();
  function title(typhoon: Extract<ActiveStandbyCardV1, { kind: "typhoon" }>['data']['typhoons'][number]): string {
    const number = typhoon.typhoonNumber == null ? null : Number(typhoon.typhoonNumber.slice(2));
    return number == null || Number.isNaN(number) ? "台風" : `台風 ${number} 号${typhoon.nameKana == null ? "" : `（${typhoon.nameKana}）`}`;
  }
</script>

<section class="standby-card typhoon-card">
  <header>台風情報{#if item.restored}<RestoredChip />{/if}</header>
  {#each item.data.typhoons as typhoon (typhoon.typhoonKey)}
    <div class="typhoon"><strong>{title(typhoon)}</strong>{#if typhoon.name == null && typhoon.remark != null}<span>{typhoon.remark}</span>{/if}<div class="facts">{#if typhoon.location != null}<span>{typhoon.location}</span>{/if}{#if typhoon.pressureHpa != null}<span>中心気圧 {typhoon.pressureHpa}hPa</span>{/if}{#if typhoon.maxWindMs != null}<span>最大風速 {typhoon.maxWindMs}m/s</span>{/if}{#if typhoon.moveDirection != null && typhoon.moveSpeedKmh != null}<span>{typhoon.moveDirection} {typhoon.moveSpeedKmh}km/h</span>{/if}</div></div>
  {/each}
</section>

<style>
  .standby-card { width: min(360px, 28vw); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  header { padding: var(--space-2) var(--space-4); color: var(--role-muted); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-title-weight-emphasized); }
  .typhoon { padding: var(--space-2) var(--space-4); font-size: max(14px, var(--type-label-l-fluid)); border-top: 1px solid var(--hairline); }
  strong, .facts { display: block; } .facts { color: var(--role-muted); } .facts span + span::before { content: " / "; }
</style>
