<script lang="ts">
  let { now, size = "large" }: { now: Date; size?: "large" | "small" } = $props();

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function pad2(n: number): string {
    return String(n).padStart(2, "0");
  }
</script>

<div class="clock" class:small={size === "small"}>
  <div class="time">{pad2(now.getHours())}:{pad2(now.getMinutes())}<span class="sec">{pad2(now.getSeconds())}</span></div>
  <div class="date">
    {now.getFullYear()}/{pad2(now.getMonth() + 1)}/{pad2(now.getDate())} ({WEEKDAYS[now.getDay()]})
  </div>
</div>

<style>
  .clock {
    text-align: center;
    color: var(--fg);
  }
  .time {
    font-family: var(--font-num);
    font-weight: var(--type-display-weight);
    /* StandbyScreen の中央クラスタは inline-size container。時計はカード幅でなく
       中央 36rem track に追従し、秒を含めた一行を保つ。 */
    font-size: clamp(72px, 16cqw, 160px);
    letter-spacing: 0;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--clock-fg);
  }
  .time .sec {
    font-size: 0.35em;
    font-weight: var(--type-display-weight);
    color: var(--role-muted);
    margin-left: 0.12em;
  }
  .date {
    font-size: clamp(16px, 3.7cqw, 26px);
    color: var(--role-muted);
    letter-spacing: 0.12em;
    margin-top: clamp(6px, 1.2vw, 16px);
  }
  .clock.small .time {
    font-size: var(--type-display-s-size);
    font-weight: var(--type-display-weight);
    color: var(--fg); /* 緊急画面の小時計は非減光対応の暗めトーンを適用しない */
  }
  .clock.small .time .sec {
    font-size: 0.7em;
  }
  .clock.small .date {
    font-size: var(--type-label-m-size); /* spec D1: 常設の日付は層1 (安全・常設 14px 以上) */
    margin-top: 2px;
    letter-spacing: 0.06em;
  }
</style>
