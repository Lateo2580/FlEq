<script lang="ts">
  import type {
    ActiveStandbyCardV1,
    DisplayTyphoonNumericSemanticV1,
  } from "../lib/protocol";
  import { typhoonHeaderTone } from "../lib/typhoon-header-tone";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import RollingNumber from "./RollingNumber.svelte";
  export type TyphoonCardDisplayMode = "full" | "compact";
  let {
    item,
    displayMode = "full",
  }: {
    item: Extract<ActiveStandbyCardV1, { kind: "typhoon" }>;
    displayMode?: TyphoonCardDisplayMode;
  } = $props();
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
  function legacyNumericValue(
    semantic: DisplayTyphoonNumericSemanticV1 | undefined,
    legacyScalar: number | null | undefined,
  ): number | null {
    if (semantic?.presence === "value" && semantic.render && semantic.value != null) {
      return semantic.value;
    }
    return legacyScalar ?? null;
  }
  function movementVisual(
    semantic: DisplayTyphoonNumericSemanticV1 | undefined,
    legacyScalar: number | null | undefined,
  ): {
    render: boolean;
    numericValue: number | null;
    label: string | null;
    badge: DisplayTyphoonNumericSemanticV1["badge"];
  } {
    if (semantic == null) {
      return {
        render: legacyScalar != null,
        numericValue: legacyScalar ?? null,
        label: null,
        badge: null,
      };
    }
    if (semantic.presence === "value") {
      return {
        render: semantic.render && semantic.value != null,
        numericValue: semantic.value,
        label: null,
        badge: null,
      };
    }
    if (semantic.presence !== "qualitative") {
      return {
        render: legacyScalar != null,
        numericValue: legacyScalar ?? null,
        label: null,
        badge: null,
      };
    }
    return {
      render: semantic.render,
      numericValue: null,
      label: semantic.label,
      badge: semantic.badge,
    };
  }
  function movementMeaning(
    semantic: DisplayTyphoonNumericSemanticV1 | undefined,
  ): string | undefined {
    if (semantic == null || semantic.presence !== "qualitative" || !semantic.render) return undefined;
    const label = semantic.label?.trim() || "不明";
    const badgeMeaning = semantic.badge === "≥"
      ? "以上（下限値）"
      : semantic.badge === "↔"
        ? "範囲"
        : semantic.badge === "?"
          ? "不明・定性値"
          : semantic.badge === "∅"
            ? "空欄"
            : null;
    const condition = semantic.condition?.trim();
    const description = semantic.description?.trim();
    const details = [
      "定性値",
      badgeMeaning == null || semantic.badge == null
        ? null
        : `記号 ${semantic.badge}: ${badgeMeaning}`,
      condition ? `条件: ${condition}` : null,
      description ? `説明: ${description}` : null,
    ].filter((detail): detail is string => detail != null);
    return `移動速度: ${label}（${details.join("、")}）`;
  }
</script>

<section class="standby-card typhoon-card" class:compact={displayMode === "compact"}>
  <header class:advisory={headerTone === "advisory"} class:warning={headerTone === "warning"} class:emergency={headerTone === "emergency"}>台風情報{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={item.updatedAt} /></header>
  {#each item.data.typhoons as typhoon (typhoon.typhoonKey)}
    {@const pressure = legacyNumericValue(typhoon.pressureHpaSemantic, typhoon.pressureHpa)}
    {@const maxWind = legacyNumericValue(typhoon.maxWindMsSemantic, typhoon.maxWindMs)}
    {@const maxGust = legacyNumericValue(typhoon.maxGustMsSemantic, typhoon.maxGustMs)}
    {@const moveSpeed = movementVisual(typhoon.moveSpeedKmhSemantic, typhoon.moveSpeedKmh)}
    {@const moveMeaning = movementMeaning(typhoon.moveSpeedKmhSemantic)}
    {@const renderMove = moveSpeed.render && (moveSpeed.numericValue == null || typhoon.moveDirection != null)}
    <!-- 未命名 (発生予想等) は総称の「台風」を出さず remark を主行に昇格させる (2 行の冗長回避) -->
    <div class="typhoon">
      {#if displayMode === "compact"}
        <div class="compact-primary">
          <strong>{typhoon.name == null && typhoon.remark != null ? typhoon.remark : title(typhoon)}</strong>
          {#if typhoon.sizeClass != null || typhoon.intensityClass != null}
            <span class="compact-class">{[typhoon.sizeClass, typhoon.intensityClass].filter((value) => value != null).join("・")}</span>
          {/if}
        </div>
        {#if typhoon.location != null || pressure != null || maxWind != null || renderMove}
          <div class="compact-summary">
            {#if typhoon.location != null}<span class="compact-token compact-location">{typhoon.location}</span>{/if}
            {#if pressure != null}<span class="compact-token"><RollingNumber value={String(pressure)} /><span class="stat-unit">hPa</span></span>{/if}
            {#if maxWind != null}<span class="compact-token">最大 <RollingNumber value={String(maxWind)} /><span class="stat-unit">m/s</span></span>{/if}
            {#if renderMove}
              <span class="compact-token compact-movement">
                {#if typhoon.moveDirection != null}<span class="direction-token">{typhoon.moveDirection}</span>{/if}
                {#if moveSpeed.numericValue != null}
                  <NumberUnit value={String(moveSpeed.numericValue)} unit="km/h" />
                {:else}
                  <span class="semantic-speed" title={moveMeaning} aria-label={moveMeaning}><span class="semantic-text">{moveSpeed.label ?? ""}</span>{#if moveSpeed.badge != null}<b class="semantic-badge" aria-hidden="true">{moveSpeed.badge}</b>{/if}</span>
                {/if}
              </span>
            {/if}
          </div>
        {/if}
      {:else}
        <strong>{typhoon.name == null && typhoon.remark != null ? typhoon.remark : title(typhoon)}</strong>
        {#if typhoon.name != null && typhoon.remark != null}<div class="remark">{typhoon.remark}</div>{/if}
        {#if typhoon.location != null}<div class="location">{typhoon.location}</div>{/if}
        {#if pressure != null || maxWind != null || maxGust != null || renderMove}
        <!-- LatestQuakeCard の .meta/.stat 列パターン (muted ラベル + 値の縦組みを横並び)。null 列は列ごと省略 -->
        <div class="meta">
          {#if pressure != null}
            <div class="stat">
              <span class="stat-label">中心気圧</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(pressure)} /><span class="stat-unit">hPa</span></span></span>
            </div>
          {/if}
          {#if maxWind != null}
            <div class="stat">
              <span class="stat-label">最大風速</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(maxWind)} /><span class="stat-unit">m/s</span></span></span>
            </div>
          {/if}
          {#if maxGust != null}
            <div class="stat">
              <span class="stat-label">最大瞬間</span>
              <span class="stat-value"><span class="stat-token"><RollingNumber value={String(maxGust)} /><span class="stat-unit">m/s</span></span></span>
            </div>
          {/if}
          {#if renderMove}
            <div class="stat">
              <span class="stat-label">進行</span>
              <span class="stat-value">
                {#if typhoon.moveDirection != null}<span class="stat-token direction-token">{typhoon.moveDirection}</span>{/if}
                {#if moveSpeed.numericValue != null}
                  <span class="stat-token speed-token"><NumberUnit value={String(moveSpeed.numericValue)} unit="km/h" /></span>
                {:else}
                  <span class="speed-token semantic-speed" title={moveMeaning} aria-label={moveMeaning}><span class="semantic-text">{moveSpeed.label ?? ""}</span>{#if moveSpeed.badge != null}<b class="semantic-badge" aria-hidden="true">{moveSpeed.badge}</b>{/if}</span>
                {/if}
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
  .semantic-speed { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
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
  .compact .typhoon { padding-block: var(--space-1); }
  .compact-primary, .compact-summary {
    display: flex;
    min-width: 0;
    align-items: baseline;
    flex-wrap: nowrap;
    gap: 0 var(--space-2);
    overflow: hidden;
  }
  .compact-primary strong { flex-shrink: 0; white-space: nowrap; }
  .compact-class, .compact-summary {
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-fluid));
  }
  .compact-class { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compact-summary { margin-top: 2px; }
  .compact-token { display: inline-flex; flex-shrink: 0; align-items: baseline; gap: var(--space-1); white-space: nowrap; }
  .compact-location { flex: 1 1 auto; min-width: 2em; overflow: hidden; text-overflow: ellipsis; }
  .compact .semantic-speed { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
