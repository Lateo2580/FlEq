<script lang="ts">
  // 回帰再現用ハーネス (createPageCycler 再入バグ、2026-07-12)。App.svelte の実経路
  // ({#if mode === "standby"}<待機>{:else}<緊急(QuakePanel 等 cycler 持ち)>) と同じ
  // 「初期 flush 完了後に、待機↔緊急の swap で cycler 持ちコンポーネントをリアクティブに
  // マウントする」構造を最小再現する。emergency=false→true の swap で QuakePanel が
  // マウントされ、createPageCycler のコンストラクタ flushSync が進行中フラッシュへ再入すると
  // destroy_effect が無限再帰していた (修正前は Maximum call stack で落ちる)。
  import QuakePanel from "../QuakePanel.svelte";
  import type { DisplayLargeQuakeInputV1 } from "../../lib/protocol";

  let { emergency, input }: { emergency: boolean; input: DisplayLargeQuakeInputV1 } = $props();
</script>

{#if emergency}
  <QuakePanel {input} />
{:else}
  <div class="standby-placeholder">待機</div>
{/if}
