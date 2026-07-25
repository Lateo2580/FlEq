<script lang="ts">
  import { untrack } from "svelte";
  import { LANES } from "../lib/ticker-lanes";
  import {
    assignLanes,
    enqueueJob,
    onLineComplete,
    onFadeComplete,
    onBookmarkCapture,
    createSchedulerState,
    resetScheduler,
    toTickerJob,
    foldCatalog,
    collectSchedulerKeys,
    maxLaneGeneration,
    purgeJobs,
    hasNonTipActivity,
    hasAlertActivity,
    hasActiveReplay,
    isRevisionBadgeVisible,
    nextRevisionBadgeDeadline,
    type SchedulerState,
    type DisplayTickerDtoV1,
  } from "../lib/ticker-schedule";
  import TickerLane from "./TickerLane.svelte";

  // 親 Ticker が全体スケジューラを持ち、2 レーンへ優先度で割り当てる (spec §4-2)。固定ハッシュ分配は廃止。
  // now: 緊急画面ではテロップ右端に時計を組み込むため渡される。待機画面では null。
  // tickerGeneration: snapshot 由来の ticker 全差し替え回数。変化でスケジューラ reset (§6)。
  // onJobComplete: 1 つの job の最終 run を完走した (= idle 化した) 瞬間に、その job の eventKey を渡して
  //   1 回呼ぶ (Tips フィラーの deck 送り用、spec 2026-07-13 フィラー化)。発火 generation が現行と一致し、
  //   かつ最終 run 完了 (次 run へ進まず coalescedRevision も無い) のときだけ。未指定でも従来と完全に同挙動。
  // onActivityChange: 非 tip (電文) ジョブがスケジューラ上で active/待機しているかが変化したとき、
  //   その真偽を App へ通知する (2026-07-14 フィラー排他化 v2)。App は feeder の供給ゲート
  //   (hasNonTipActivity 中は Tips を供給しない) にこれを使う。getter を渡すだけでは Svelte 5 runes で
  //   親 $effect が再走しないため、状態変化を push 通知する。未指定でも従来と同挙動。
  // onAlertActivityChange: 警報級 (意味重大度、hasAlertActivity) のジョブがスケジューラ上で掲載中かが
  //   変化したとき、その真偽を App へ通知する (spec D5、2026-07-18 night-dim 自動サスペンド)。App は
  //   effectiveDim = requested && !alertActive の合成 (computeEffectiveDim) に使う。onActivityChange と
  //   同じ push 通知パターン (pull だと親 $effect が再走しない)。未指定でも従来と同挙動。
  // tsunamiGeneration: 津波 snapshot の現行世代 (2026-07-14 津波チップ再生)。enqueueReplay で投入した
  //   replay ジョブはこの世代を持ち、値が変化 (津波の更新/解除) すると世代不一致の replay を purge する
  //   (未開始は除去、走行中も即時停止。防災表示は完走より正確性優先)。
  let {
    lines,
    now = null,
    tickerGeneration = 0,
    tsunamiGeneration = 0,
    dim = false,
    onJobComplete,
    onActivityChange,
    onAlertActivityChange,
  }: {
    lines: DisplayTickerDtoV1[];
    now?: Date | null;
    tickerGeneration?: number;
    tsunamiGeneration?: number;
    dim?: boolean;
    onJobComplete?: (eventKey: string) => void;
    onActivityChange?: (active: boolean) => void;
    onAlertActivityChange?: (active: boolean) => void;
  } = $props();

  /**
   * 津波チップ再生の投入口 (2026-07-14)。App がチップクリックで合成した replay DTO を渡す。Ticker が
   * 状態機械の唯一の所有者なので App 側に queue を分散させず、この関数経由でスケジューラへ enqueue する。
   * 同レベル (同 groupKey) の replay が既に active/queued/deferred なら連打ガードで無視する。
   */
  export function enqueueReplay(dto: DisplayTickerDtoV1): void {
    const job = toTickerJob(dto, ++seqCounter);
    if (job.groupKey != null && hasActiveReplay(scheduler, job.groupKey)) return;
    scheduler = enqueueJob(scheduler, job, Date.now());
    // knownKeys には追加しない (Codex 指摘3)。replay の key は lines には現れないので fresh 判定に
    // 不要で、追加すると完走/purge 後も刈られず、静穏時の繰り返し replay で Set が無限肥大する
    // (kiosk リーク)。lines $effect が走るたび knownKeys は lines + 保持中 job から作り直され、
    // その時点で scheduler に残っている replay だけが自然に含まれる (完走済みは含まれない)。
    runTick();
  }

  let scheduler = $state<SchedulerState>(createSchedulerState([]));
  let seqCounter = 0; // dto.seq=0 用の親 fallback (単調増加)
  let knownKeys = new Set<string>();
  let lastGeneration = -1;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  // 続報バッジ TTL 判定用の時刻。now prop は待機画面で null のため内部で持つ。
  // 毎秒 interval ではなく **失効時刻への one-shot timer** で進める: バッジは REVISION_BADGE_MS 経過の
  // 一点で真→偽へ変わるだけなので、その 1 点以外の再評価は捨ててよい (常設 kiosk で 1 日 86,400 回の
  // 無駄起床を消す)。表示中レーンの期限のうち最も近い 1 本にだけ timer を張り、発火で badgeNow を進める
  // → この effect が再走して次の期限を張り直す。バッジ対象が無ければ timer は 1 本も張らない。
  // 依存は scheduler の lane.current.revisionAt と badgeNow (どちらが動いても期限を計算し直す)。
  let badgeNow = $state(Date.now());
  $effect(() => {
    const deadline = nextRevisionBadgeDeadline(scheduler, badgeNow);
    if (deadline == null) return;
    const id = setTimeout(() => { badgeNow = Date.now(); }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(id);
  });

  function catalogFromLines(ls: DisplayTickerDtoV1[]): SchedulerState["catalog"] {
    // lines は新しい順。dto.seq=0 (preview/旧 fixture) は行順で単調 fallback を振り、先着順
    // (古い=小さい seq) を安定させる (Low)。実データは dto.seq をそのまま使う
    return foldCatalog(ls.map((dto, i) => toTickerJob(dto, ls.length - i)));
  }

  function scheduleWake(wakeAt: number | null): void {
    if (wakeTimer != null) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (wakeAt == null) return;
    const delay = Math.max(0, wakeAt - Date.now());
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      runTick();
    }, delay);
  }

  function runTick(): void {
    const { state, wakeAt } = assignLanes(scheduler, Date.now());
    scheduler = state;
    scheduleWake(wakeAt);
  }

  // lines / tickerGeneration に反応。scheduler の読み書きは untrack して自己ループを避ける
  // (この effect は lines と tickerGeneration の変化だけで再走する)
  $effect(() => {
    const gen = tickerGeneration;
    const ls = lines;
    untrack(() => {
      if (gen !== lastGeneration) {
        // snapshot 由来の ticker 全差し替え → スケジューラ全 reset (§6)。
        // 旧レーンの世代最大値を種に渡し、世代を reset を跨いで単調増加させる (Critical 1)
        lastGeneration = gen;
        scheduler = resetScheduler(catalogFromLines(ls), maxLaneGeneration(scheduler) + 1);
        runTick();
        knownKeys = new Set([...ls.map((l) => l.eventKey), ...collectSchedulerKeys(scheduler)]);
        return;
      }
      // 同一 generation (event 追加) → 新着のみ enqueue。lines は新しい順なので古い順に積む
      const fresh = ls.filter((l) => !knownKeys.has(l.eventKey));
      let next: SchedulerState;
      if (fresh.length > 0) {
        let acc = scheduler;
        for (const dto of [...fresh].reverse()) {
          acc = enqueueJob(acc, toTickerJob(dto, ++seqCounter), Date.now());
        }
        next = { ...acc, catalog: catalogFromLines(ls) };
      } else {
        // fresh が無くても catalog は毎回 lines に同期する。lines が縮む (Tips が外れて空になる等)
        // ときにここを怠ると catalog が古いまま残り、消えたはずの job が巡回補充
        // (assignLanes ③、CYCLE_MIN_INTERVAL_MS=120s 後) で再走してしまう (Codex 指摘 Critical)
        next = { ...scheduler, catalog: catalogFromLines(ls) };
      }
      // lines から外れたフィラー (Tips) を current/queue/deferred から即除去する (緊急遷移で豆知識が
      // 緊急画面に残らないようにする、spec 2026-07-13 フィラー化 R1)。catalog 縮小同期は「巡回補充で
      // 再登場させない」だけで割当済み job は保持するため、mode!==standby で feeder が lines を空にしても
      // 走行中/退避中の Tip が残ってしまう。判定は kind==="tip" (key prefix 判定は廃止、2026-07-14)。
      // 電文 (kind!=="tip") は lines から外れても即除去せず完走まで残す (⑮ の従来契約)。
      // 待機中に feeder が完走で tip を差し替えたときは、外れる旧 tip は既に idle 化済みなので影響なし。
      // 割込みで deferred 中の tip は feeder が lines に保持し続ける (=読みかけ再開) ので purge されない。
      const lineKeys = new Set(ls.map((l) => l.eventKey));
      const purged = purgeJobs(next, (job) => job.kind === "tip" && !lineKeys.has(job.key), Date.now());
      const changed = purged !== next;
      scheduler = purged;
      // 新着 enqueue か purge でレーン割当が動く可能性があれば再割当する
      if (fresh.length > 0 || changed) runTick();
      // known を lines + 保持中 job に刈り込む (常設 kiosk の Set 肥大防止)
      knownKeys = new Set([...ls.map((l) => l.eventKey), ...collectSchedulerKeys(scheduler)]);
    });
  });

  // wake timer の後片付け
  $effect(() => {
    return () => {
      if (wakeTimer != null) clearTimeout(wakeTimer);
    };
  });

  // 非 tip (電文) ジョブの在否を App へ push 通知する (2026-07-14 フィラー排他化 v2)。scheduler が
  // 変わるたび再計算し、真偽が変化したときだけ通知する ($derived が値等価で間引く)。App はこれを
  // feeder の供給ゲートに使う (スケジューラ側の割当ガードとの二重防御)。
  const nonTipActive = $derived(hasNonTipActivity(scheduler));
  $effect(() => {
    const active = nonTipActive;
    untrack(() => onActivityChange?.(active));
  });

  // 警報級 (意味重大度) ジョブの掲載在否を App へ push 通知する (spec D5、2026-07-18 night-dim
  // 自動サスペンド)。scheduler が変わるたび再計算し、真偽が変化したときだけ通知する ($derived が
  // 値等価で間引く)。App はこれで手動意思 (requested) を変えず実効値 (effective) だけを明るい側へ倒す。
  const alertActive = $derived(hasAlertActivity(scheduler));
  $effect(() => {
    const active = alertActive;
    untrack(() => onAlertActivityChange?.(active));
  });

  // 津波世代が変わったら (津波の更新/解除)、投入時と世代が食い違う replay を purge する (2026-07-14)。
  // 未開始 replay は除去、走行中 replay も idle 化で即時停止する (purgeJobs の running→idle 経路。
  // 防災表示は完走より正確性優先で、古い津波区域の再生を残さない)。scheduler の読み書きは untrack して
  // この effect を tsunamiGeneration の変化だけで再走させる。
  $effect(() => {
    const gen = tsunamiGeneration;
    untrack(() => {
      const purged = purgeJobs(
        scheduler,
        (job) => job.kind === "replay" && job.replayGeneration !== gen,
        Date.now(),
      );
      if (purged !== scheduler) {
        scheduler = purged;
        runTick();
      }
    });
  });

  function handleScrollEnd(laneIndex: number, generation: number): void {
    // job 完走 (onJobComplete) 判定は onLineComplete を呼ぶ前に現状態から計算する。onLineComplete の
    // 「最終 run 走破 → idle 化」分岐と同じ前提: 走行中・generation 一致・完了未済 (二重 animationend
    // ガード) かつ「次 run が無い (runIndex が最終)」かつ「昇格すべき coalescedRevision が無い」。この
    // ときだけ job は idle 化＝完走する。次 run へ進む/続報昇格するケースは完走ではないので発火しない。
    const lane = scheduler.lanes[laneIndex];
    const completedKey =
      lane != null && lane.phase === "running" && lane.current != null
      && generation === lane.generation && lane.completedGeneration !== lane.generation
      && lane.current.runIndex >= lane.current.runs.length - 1
      && lane.coalescedRevision == null
        ? lane.current.key
        : null;
    scheduler = onLineComplete(scheduler, laneIndex, generation, Date.now());
    runTick();
    if (completedKey != null) onJobComplete?.(completedKey);
  }

  function handleBookmarkCapture(laneIndex: number, generation: number, index: number, nearBoundary: boolean): void {
    scheduler = onBookmarkCapture(scheduler, laneIndex, generation, index, nearBoundary);
  }

  function handleFadeEnd(laneIndex: number, generation: number): void {
    scheduler = onFadeComplete(scheduler, laneIndex, generation, Date.now());
    runTick();
  }

  function pad2(n: number): string {
    return String(n).padStart(2, "0");
  }
</script>

<div class="ticker">
  <div class="ticker-rows">
    {#each scheduler.lanes.slice(0, LANES) as lane, i (i)}
      <div class="ticker-row">
        <TickerLane
          job={lane.current}
          segmentIndex={lane.current?.segmentIndex ?? 0}
          runEnd={lane.current?.runs[lane.current.runIndex]?.endSegmentIndexExclusive ?? (lane.current?.segments.length ?? 0)}
          generation={lane.generation}
          phase={lane.phase}
          {dim}
          showRevisionBadge={isRevisionBadgeVisible(lane.current, badgeNow)}
          emphasis={lane.phase === "running" && lane.current?.priority === "high" ? "high" : null}
          onScrollEnd={(g) => handleScrollEnd(i, g)}
          onFadeEnd={(g) => handleFadeEnd(i, g)}
          onBookmarkCapture={(g, idx, near) => handleBookmarkCapture(i, g, idx, near)}
        />
      </div>
    {/each}
  </div>
  {#if now != null}
    <div class="ticker-clock">
      <span class="clock-time"
        >{pad2(now.getHours())}:{pad2(now.getMinutes())}<span class="clock-sec"
          >{pad2(now.getSeconds())}</span
        ></span
      >
    </div>
  {/if}
</div>

<style>
  .ticker {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    color: var(--fg);
    font-size: var(--type-headline-s-fluid);
    font-weight: var(--type-headline-weight);
    /* Spec C §2: 帯を計器盤の一部として最暗面の一段上に敷き、上辺を hairline で screen から切り出す。
       帯は画面幅 full-bleed なので角丸は付けない (左右に余白がなく効かない) */
    background: var(--surface-low);
    border-top: 1px solid var(--hairline);
  }
  .ticker-rows {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ticker-row {
    position: relative;
    width: 100%;
    height: var(--ticker-row-h);
    overflow: hidden;
  }
  .ticker-clock {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0 var(--space-5) 0 var(--space-4);
    font-family: var(--font-num);
    font-variant-numeric: tabular-nums;
  }
  .clock-time {
    font-size: var(--type-headline-s-fluid);
    font-weight: var(--type-display-weight);
  }
  .clock-sec {
    font-size: 0.6em;
    color: var(--role-muted);
    margin-left: 0.12em;
  }
</style>
