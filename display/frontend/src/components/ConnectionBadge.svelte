<script lang="ts">
  import type { DisplayConnectionStateV1 } from "../lib/protocol";
  import { formatHm } from "../lib/format";

  let { connection, sseConnected }: {
    connection: DisplayConnectionStateV1;
    sseConnected: boolean;
  } = $props();

  // SSE 切断中は dmdata の状態に関わらず接続断として扱う (SSE が絶たれれば
  // dmdata の生死は端末側から観測できないため)
  const disconnected = $derived(!sseConnected || connection.dmdata === "disconnected");
</script>

<!-- 正常時は何も出さない (方針: 右上の常時ドットを廃止し、切断時のみ時計上に表示) -->
{#if disconnected}
  <div class="connection-badge role-connectionStale">
    <span class="label">切断されています</span>
    <span class="last-received">最終受信 {formatHm(connection.lastReceivedAt)}</span>
  </div>
{/if}

<style>
  .connection-badge {
    text-align: center;
    color: var(--role-connectionStale);
  }
  .label {
    display: block;
    font-size: var(--type-body-s-fluid);
    font-weight: var(--type-body-weight-emphasized);
  }
  .last-received {
    display: block;
    font-weight: var(--type-label-weight);
    font-size: var(--type-label-s-fluid);
    color: var(--role-muted);
    margin-top: 2px;
  }
</style>
