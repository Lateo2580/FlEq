<script lang="ts">
  import type { DisplaySeverityTier } from "../lib/protocol";

  let { tier }: { tier: DisplaySeverityTier } = $props();
</script>

<div class="tier-overlays" data-tier={tier} aria-hidden="true">
  <div class="tier-layer caution"></div>
  <div class="tier-layer alert"></div>
  <div class="tier-layer critical"></div>
</div>

<style>
  .tier-overlays {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }
  .tier-layer {
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity var(--spring-effects-slow-dur) var(--spring-effects-slow);
  }
  /* 色面は静止 (opacity のみアニメ)。縁の「気配」は radial-gradient で内側透明→縁色 */
  .tier-layer.caution {
    background: radial-gradient(120% 120% at 50% 50%, transparent 70%, rgba(240, 228, 66, 0.1) 100%);
  }
  .tier-layer.alert {
    background: radial-gradient(120% 120% at 50% 50%, rgba(213, 94, 0, 0.06) 55%, rgba(213, 94, 0, 0.22) 100%);
  }
  .tier-layer.critical {
    background: radial-gradient(120% 120% at 50% 50%, rgba(160, 48, 160, 0.1) 40%, rgba(160, 48, 160, 0.34) 100%);
  }
  .tier-overlays[data-tier="caution"] .caution,
  .tier-overlays[data-tier="alert"] .alert,
  .tier-overlays[data-tier="critical"] .critical {
    opacity: 1;
  }
  /* calm は全層 opacity 0 = 完全静止。継続パルスなし */
  @media (prefers-reduced-motion: reduce) {
    .tier-layer {
      transition: none; /* opacity は即時切替 (情報は消さない) */
    }
  }
</style>
