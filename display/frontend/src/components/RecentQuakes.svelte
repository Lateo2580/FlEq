<script lang="ts">
  import type { DisplayRecentQuakeV1 } from "../lib/protocol";
  import { formatMdHm, formatIntShort, recentQuakeId } from "../lib/format";
  import { depthVisual, magnitudeVisual } from "../lib/magnitude";
  import { intensityVisual } from "../lib/quake-map-colors";

  // 呼び出し元 (StandbyScreen) が quakes.length === 0 のときはカードごと非表示にするため、
  // ここでは常に 1 件以上ある前提で render する (履歴なし placeholder は撤去)
  // onSelect: 行クリックで、その地震 DTO と安定 ID を呼び出し元へ渡す (詳細カード再表示、2026-07-14)。
  //   ID は配列 index を含まない recentQuakeId() で、訂正報や新地震挿入で同じ地震のトグル判定が
  //   崩れないようにする (index 混入だと挿入で ID が変わり再クリックが別項目扱いになる回帰、Codex 指摘4)。
  let {
    quakes,
    onSelect,
  }: {
    quakes: DisplayRecentQuakeV1[];
    onSelect?: (quake: DisplayRecentQuakeV1, id: string) => void;
  } = $props();

  const shown = $derived(quakes.slice(0, 5));

  // keyed each の重複クラッシュ回避のため、安定 ID が衝突する退化ケース (eventId null で全項目一致)
  // でも index で一意化する。選択 ID (onSelect へ渡す値) には index を混ぜない。
  function renderKey(q: DisplayRecentQuakeV1, i: number): string {
    return `${recentQuakeId(q)}#${i}`;
  }

  // クリックは必ず stopPropagation する: App.svelte の window click 減光トグルへ伝播させない。
  function handleClick(event: MouseEvent, q: DisplayRecentQuakeV1): void {
    event.stopPropagation();
    onSelect?.(q, recentQuakeId(q));
  }
</script>

<div class="recent-quakes">
  <h2>今日あった地震</h2>
  <ul>
    {#each shown as q, i (renderKey(q, i))}
      {@const visual = intensityVisual(q.maxIntSemantic, formatIntShort(q.maxInt), q.maxIntRank)}
      {@const magnitude = magnitudeVisual(q.magnitudeSemantic, q.magnitude)}
      {@const depth = depthVisual(q.depthSemantic, q.depth)}
      <li data-recent-quake-id={recentQuakeId(q)}>
        <button class="row" type="button" onclick={(e) => handleClick(e, q)}>
          <span class="row-main">
            {#if visual.render}<span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>{/if}
            <span class="hypocenter">{q.hypocenterName ?? "不明"}</span>
            {#if q.tsunamiWarning}<span class="tsunami-mark">津波</span>{/if}
          </span>
          <span class="stats">
            <span class="magnitude" class:magnitude-description={magnitude.numericValue == null} title={magnitude.tooltip ?? undefined} aria-label={q.magnitudeSemantic == null && q.magnitude == null ? "マグニチュード: 空欄" : magnitude.ariaLabel}>{q.magnitudeSemantic == null && q.magnitude == null ? "" : magnitude.label}{#if magnitude.badge != null}<b class="semantic-badge">{magnitude.badge}</b>{/if}</span>
            <span class="depth" title={depth.tooltip ?? undefined} aria-label={depth.ariaLabel}>{depth.label}{#if depth.badge != null}<b class="semantic-badge">{depth.badge}</b>{/if}</span>
            <span class="time">{formatMdHm(q.originTime ?? q.reportDateTime)}</span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .recent-quakes {
    color: var(--fg);
    font-size: var(--type-body-s-fluid);
    min-width: 0;
    max-width: 100%;
    container-type: inline-size;
  }
  h2 {
    font-size: var(--type-label-l-fluid);
    letter-spacing: 0.35em;
    color: var(--role-muted);
    font-weight: var(--type-label-weight-emphasized);
    margin: 0 0 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: block;
  }
  /* 行全体をタッチ/マウス操作のボタンにする (kiosk 想定)。button の既定装飾は消し、元の行
     レイアウト (baseline 揃えの flex) を踏襲する。詳細カード再表示の当たり判定 (2026-07-14) */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 3px 0;
    margin: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-s);
  }
  .row:focus-visible {
    outline: 2px solid var(--role-muted);
    outline-offset: 2px;
  }
  .int-chip {
    min-width: 2.2em;
    max-width: 12em;
    text-align: center;
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-weight: var(--num-weight);
    background: var(--surface-panel-raised);
    overflow-wrap: anywhere;
  }
  .row-main {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    max-width: 100%;
  }
  .int-r0 { color: var(--role-muted); }
  .int-r1 { color: var(--int-1); }
  .int-r2 { color: var(--int-2); }
  .int-r3 { color: var(--int-3); }
  .int-r4 { color: var(--int-4); }
  .int-r5 { color: var(--int-5); }
  .int-r6 { color: var(--int-6); }
  .int-r7 { color: var(--int-7); }
  .int-r8 {
    background: var(--int-8-bg);
    color: #000;
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: #fff;
  }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
  .int-chip.special-unknown { color: var(--c-raspberry); border: 1px dashed currentColor; }
  .int-chip.special-empty { color: var(--role-muted); border: 1px dotted currentColor; }
  .hypocenter {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tsunami-mark {
    flex-shrink: 0;
    color: var(--c-jma-red);
    font-weight: var(--type-body-weight-emphasized);
    white-space: nowrap;
  }
  /* M/深さ/時刻は震源名から離し、右寄せグループとしてまとめる (震源名との間隔詰め) */
  .stats {
    flex-shrink: 0;
    display: flex;
    min-width: 0;
    gap: var(--space-3);
    margin-left: auto;
  }
  .magnitude {
    width: 4.5em;
    text-align: right;
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .magnitude-description {
    width: auto;
  }
  .depth {
    width: 4.5em;
    text-align: right;
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* "M/D HH:MM" (ゼロ埋めなし) の最大幅 "12/31 14:46" = 11ch を確保し、右詰め + tabular-nums で
     行間の時刻部分を縦にそろえる (LatestQuakeCard の formatMdHm 表記と統一) */
  .time {
    width: 11ch;
    text-align: right;
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* 通常 card の最大幅は 36rem = 576px。最大 font 時の統計列は M 4.5em + 深さ 4.5em +
     時刻 11ch + 2 gap で約310px、chip／津波印と主情報 gap は約100px必要になる。
     420px 未満だけを二段化し、通常 card は一段の密度を維持する。 */
  @container (max-width: 420px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
      row-gap: var(--space-1);
    }
    .row-main {
      width: 100%;
      gap: var(--space-1);
    }
    .hypocenter {
      min-width: 0;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .stats {
      grid-column: 1;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      flex-wrap: wrap;
      justify-content: flex-end;
      row-gap: var(--space-1);
      column-gap: var(--space-2);
    }
    .magnitude,
    .depth,
    .time {
      flex: 0 1 auto;
      min-width: 0;
      max-width: 100%;
      width: auto;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
