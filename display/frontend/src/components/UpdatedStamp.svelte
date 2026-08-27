<script lang="ts">
  // カード見出し右端の「最終更新時刻」(ご主人要望 2026-07-26)。気象警報 / 台風情報 / 火山情報 /
  // 津波情報の 4 カードで共有する。
  //
  // 表記は常に月日込み (formatMdHm)。"HH:MM" だけだと、数日前の電文が今日の更新に見えてしまう
  // — 火山情報や台風情報は数時間〜数日更新が空くことがあり、待機画面は「いつの情報か」を
  // 判断する場所なので、桁数より曖昧さの排除を採る (formatMdHm のコメントと同じ判断)。
  // 色は継承 (color: inherit): 見出し帯は種別ごとに container/on ペアが変わるため、独自色を
  // 置くとコントラスト監査の対象ペアが増える。帯の on 色をそのまま使えば既存判定のまま。
  import { formatMdHm } from "../lib/format";

  let { iso }: { iso: string | null } = $props();
</script>

{#if iso != null && iso !== ""}
  <span class="updated-stamp">更新 {formatMdHm(iso)}</span>
{/if}

<style>
  /* 右寄せは standby-card-header__meta が担う。stamp 自身は chip/date と
     同居しても順序を押し替えない。 */
  .updated-stamp {
    padding-left: var(--space-2);
    white-space: nowrap;
    font-size: max(12px, var(--type-label-s-fluid));
    font-weight: normal;
    font-variant-numeric: tabular-nums;
    color: inherit;
  }
</style>
