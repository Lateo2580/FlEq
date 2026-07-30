<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { typhoonHeaderTone } from "../lib/typhoon-header-tone";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import RollingNumber from "./RollingNumber.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "typhoon" }> } = $props();
  const headerTone = $derived(typhoonHeaderTone(item.data.typhoons));
  function title(typhoon: Extract<ActiveStandbyCardV1, { kind: "typhoon" }>['data']['typhoons'][number]): string {
    const number = typhoon.typhoonNumber == null ? null : Number(typhoon.typhoonNumber.slice(2));
    return number == null || Number.isNaN(number) ? "台風" : `台風 ${number} 号${typhoon.nameKana == null ? "" : `（${typhoon.nameKana}）`}`;
  }
  function deltaArrow(delta: number): string {
    return delta < 0 ? "↓" : delta > 0 ? "↑" : "→";
  }
  function trendLabel(trend: "developing" | "weakening" | "steady"): string {
    if (trend === "developing") return "発達傾向";
    if (trend === "weakening") return "衰弱傾向";
    return "横ばい";
  }
</script>

<section class="standby-card typhoon-card">
  <header class:advisory={headerTone === "advisory"} class:warning={headerTone === "warning"} class:emergency={headerTone === "emergency"}>台風情報{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></header>
  {#each item.data.typhoons as typhoon (typhoon.typhoonKey)}
    <!-- 未命名 (発生予想等) は総称の「台風」を出さず remark を主行に昇格させる (2 行の冗長回避) -->
    <div class="typhoon">
      <strong>{typhoon.name == null && typhoon.remark != null ? typhoon.remark : title(typhoon)}</strong>
      {#if typhoon.name != null && typhoon.remark != null}<div class="remark">{typhoon.remark}</div>{/if}
      {#if typhoon.location != null}<div class="location">{typhoon.location}</div>{/if}
      {#if typhoon.pressureHpa != null || typhoon.maxWindMs != null || typhoon.maxGustMs != null || (typhoon.moveDirection != null && typhoon.moveSpeedKmh != null)}
        <!-- LatestQuakeCard の .meta/.stat 列パターン (muted ラベル + 値の縦組みを横並び)。null 列は列ごと省略 -->
        <div class="meta">
          {#if typhoon.pressureHpa != null}
            <div class="stat">
              <span class="stat-label">中心気圧</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(typhoon.pressureHpa)} /><span class="stat-unit">hPa</span></span></span>
            </div>
          {/if}
          {#if typhoon.maxWindMs != null}
            <div class="stat">
              <span class="stat-label">最大風速</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(typhoon.maxWindMs)} /><span class="stat-unit">m/s</span></span></span>
            </div>
          {/if}
          {#if typhoon.maxGustMs != null}
            <div class="stat">
              <span class="stat-label">最大瞬間</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(typhoon.maxGustMs)} /><span class="stat-unit">m/s</span></span></span>
            </div>
          {/if}
          {#if typhoon.moveDirection != null && typhoon.moveSpeedKmh != null}
            <div class="stat">
              <span class="stat-label">進行</span>
              <span class="stat-value">
                <span class="stat-token direction-token">{typhoon.moveDirection}</span>
                <span class="stat-token speed-token"><NumberUnit value={String(typhoon.moveSpeedKmh)} unit="km/h" /></span>
              </span>
            </div>
          {/if}
        </div>
        {#if typhoon.pressureDeltaHpa != null || typhoon.maxWindDeltaMs != null}
          <div class="change-summary">
            {#if typhoon.pressureDeltaHpa != null}<span class="change-item pressure-delta">{deltaArrow(typhoon.pressureDeltaHpa)} {Math.abs(typhoon.pressureDeltaHpa)} hPa</span>{/if}
            {#if typhoon.maxWindDeltaMs != null}<span class="change-item wind-delta">{deltaArrow(typhoon.maxWindDeltaMs)} {Math.abs(typhoon.maxWindDeltaMs)} m/s</span>{/if}
            {#if typhoon.intensityTrend != null && typhoon.pressureDeltaHpa != null && typhoon.maxWindDeltaMs != null}
              <span class="change-item trend-label">{trendLabel(typhoon.intensityTrend)}</span>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 情報級カード: 警報帯は付けず、タイトル級 muted 見出し (直近の地震と同格) で警報とのヒエラルキーを守る */
  header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    color: var(--role-muted);
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
  }
  .advisory {
    background: var(--header-weatherAdvisory-container);
    color: var(--header-weatherAdvisory-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherAdvisory);
  }
  .warning {
    background: var(--header-weatherWarning-container);
    color: var(--header-weatherWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning);
  }
  .emergency {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherEmergency);
  }
  .typhoon { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  .typhoon strong { display: block; font-size: max(14px, var(--type-label-l-fluid)); }
  /* 現在位置: ラベルなしの muted 本文 (層2) */
  .location, .remark { margin-top: 2px; color: var(--role-muted); font-size: max(12px, var(--type-label-s-fluid)); }
  /* 通常幅は VolcanoCard と同じ 2×2。各列に 9rem を確保できない幅では自動的に 1 列へ落とし、
     minmax(0, ...) のように内容幅を無視して親の overflow:hidden へ押し込まない。 */
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
    gap: var(--space-1) var(--space-3);
    margin-top: var(--space-1);
  }
  .stat { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .stat-label { display: inline-block; align-self: flex-start; white-space: nowrap; font-size: var(--type-label-xs-size); color: var(--role-muted); }
  /* 値行はトークン間だけ wrap する。数値+単位、方位語は各 .stat-token 内で分断しない。 */
  .stat-value {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-1);
    min-width: 0;
    font-size: max(14px, var(--type-body-l-fluid));
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
    color: var(--fg);
  }
  .stat-token { display: inline-block; white-space: nowrap; }
  .stat-unit { margin-left: 1px; font-size: max(12px, 0.6em); font-weight: normal; }
  .change-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-3);
    margin-top: 2px;
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
    font-variant-numeric: tabular-nums;
  }
  .change-item { white-space: nowrap; }
</style>
