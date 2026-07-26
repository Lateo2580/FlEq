<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "typhoon" }> } = $props();
  function title(typhoon: Extract<ActiveStandbyCardV1, { kind: "typhoon" }>['data']['typhoons'][number]): string {
    const number = typhoon.typhoonNumber == null ? null : Number(typhoon.typhoonNumber.slice(2));
    return number == null || Number.isNaN(number) ? "台風" : `台風 ${number} 号${typhoon.nameKana == null ? "" : `（${typhoon.nameKana}）`}`;
  }
</script>

<section class="standby-card typhoon-card">
  <header>台風情報{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></header>
  {#each item.data.typhoons as typhoon (typhoon.typhoonKey)}
    <!-- 未命名 (発生予想等) は総称の「台風」を出さず remark を主行に昇格させる (2 行の冗長回避) -->
    <div class="typhoon">
      <strong>{typhoon.name == null && typhoon.remark != null ? typhoon.remark : title(typhoon)}</strong>
      {#if typhoon.location != null}<div class="location">{typhoon.location}</div>{/if}
      {#if typhoon.pressureHpa != null || typhoon.maxWindMs != null || (typhoon.moveDirection != null && typhoon.moveSpeedKmh != null)}
        <!-- LatestQuakeCard の .meta/.stat 列パターン (muted ラベル + 値の縦組みを横並び)。null 列は列ごと省略 -->
        <div class="meta">
          {#if typhoon.pressureHpa != null}<div class="stat"><span class="stat-label">中心気圧</span><span class="stat-value"><NumberUnit value={String(typhoon.pressureHpa)} unit="hPa" /></span></div>{/if}
          {#if typhoon.maxWindMs != null}<div class="stat"><span class="stat-label">最大風速</span><span class="stat-value"><NumberUnit value={String(typhoon.maxWindMs)} unit="m/s" /></span></div>{/if}
          {#if typhoon.moveDirection != null && typhoon.moveSpeedKmh != null}<div class="stat"><span class="stat-label">進行</span><span class="stat-value">{typhoon.moveDirection} <NumberUnit value={String(typhoon.moveSpeedKmh)} unit="km/h" /></span></div>{/if}
        </div>
      {/if}
    </div>
  {/each}
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); max-height: 240px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 情報級カード: 警報帯は付けず、タイトル級 muted 見出し (直近の地震と同格) で警報とのヒエラルキーを守る */
  header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    color: var(--role-muted);
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
  }
  .typhoon { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  .typhoon strong { display: block; font-size: max(14px, var(--type-label-l-fluid)); }
  /* 現在位置: ラベルなしの muted 本文 (層2) */
  .location { margin-top: 2px; color: var(--role-muted); font-size: max(12px, var(--type-label-s-fluid)); }
  /* ラベル付き 3 列 (LatestQuakeCard .meta と同構造・同トークン): ラベル muted 層2 / 値 fg 層1 */
  .meta { display: flex; gap: var(--space-3); margin-top: var(--space-1); }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat-label { font-size: var(--type-label-xs-size); color: var(--role-muted); }
  .stat-value { font-size: max(14px, var(--type-body-l-fluid)); font-weight: var(--num-weight); font-variant-numeric: tabular-nums; color: var(--fg); }
</style>
