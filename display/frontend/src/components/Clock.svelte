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
    /* 36rem center track での旧解決値 92.16px を丸めて固定する。
       解像度による時計クラスタ高の揺れをなくし、秒を含めた一行を保つ。 */
    font-size: 92px;
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
    /* time と同じ 36rem 基準の旧解決値 21.31px を固定する。 */
    font-size: 21px;
    color: var(--role-muted);
    letter-spacing: 0.12em;
    margin-top: 16px;
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
