<script lang="ts">
  import { createDisplayConnection } from "./lib/connection.svelte";
  import { createClock } from "./lib/clock.svelte";
  import { createDimStore } from "./lib/dim.svelte";
  import {
    deriveEmergencyPanels,
    deriveMode,
    deriveQuakeMapHostEvent,
    deriveTickerLines,
  } from "./lib/derive";
  import { shouldReload } from "./lib/reload";
  import StandbyScreen from "./components/StandbyScreen.svelte";
  import EmergencyScreen from "./components/EmergencyScreen.svelte";
  import QuakeMapScreen from "./components/QuakeMapScreen.svelte";
  import Ticker from "./components/Ticker.svelte";
  import TierOverlay from "./components/TierOverlay.svelte";
  import { fade } from "svelte/transition";
  import { emergencyEnter } from "./lib/transitions";
  import { SPRING_SPATIAL_QUICK_MS, SPRING_EFFECTS_SLOW_MS, EXIT_MS } from "./lib/motion";
  import { createTipsFeeder } from "./lib/tips-feeder.svelte";
  import { deriveEmergencyCompanionControl } from "./lib/emergency-tips-policy";
  import { buildTsunamiReplayDto } from "./lib/tsunami-replay";
  import type { DisplayTsunamiLevel } from "./lib/protocol";
  import type { DisplayTickerDtoV1 } from "./lib/ticker-schedule";
  import { untrack } from "svelte";
  import { normalizeBackgroundTone } from "./lib/display-contract";
  import {
    computeEffectiveDim,
    computeSnapshotAlertActive,
    shouldToggleDimOnClick,
    shouldToggleDimOnKey,
  } from "./lib/dim-interaction";

  const RELOAD_STORAGE_KEY = "fleq-display-last-reload";
  const RELOAD_CHECK_INTERVAL_MS = 60_000;

  const connection = createDisplayConnection();
  const clock = createClock();
  const dim = createDimStore();

  // 警報級掲載中は減光を自動サスペンド (spec D5 強調層)。requested (手動意思) は不変、
  // effective (実効) だけを明るい側へ倒す。収束すれば自動で減光に戻る。合成則は
  // computeEffectiveDim (Task 1 で真理値表テスト済み) を使う。
  let tickerAlertActive = $state(false);
  // snapshot 由来の掲載判定 (待機カード critical + 気象 L5 相当) は純関数へ切り出して真理値表で
  // 固定してある (dim-interaction.ts の computeSnapshotAlertActive、spec D5 + spec C §4)
  const snapshotAlertActive = $derived(computeSnapshotAlertActive(connection.state.snapshot));
  const effectiveDim = $derived(
    computeEffectiveDim(dim.requested, tickerAlertActive || snapshotAlertActive),
  );

  $effect(() => {
    connection.start();
    return () => connection.stop();
  });
  $effect(() => () => clock.stop());

  const nowMs = $derived(clock.now.getTime());
  const mode = $derived(deriveMode(connection.state, nowMs));
  const quakeMapEvent = $derived(
    deriveQuakeMapHostEvent(connection.state, nowMs),
  );
  const tickerLines = $derived(deriveTickerLines(connection.state, nowMs));
  const emergencyPanels = $derived(deriveEmergencyPanels(connection.state, nowMs));
  const severityTier = $derived(connection.state.snapshot?.severityTier ?? "calm");
  // 旧 server・未知 wire 値は、演出を足さない calm に明示的に縮退する。
  const backgroundTone = $derived(normalizeBackgroundTone(connection.state.snapshot?.backgroundTone));

  // テロップ Tips (フィラー排他化 v2, 2026-07-14): standby / quakeMap では電文が 1 件も走行/待機して
  // いないときだけ供給し、emergency は companion policy に従う。電文の走行/待機は Ticker が hasNonTipActivity で判定し onActivityChange
  // で push 通知する (getter pull では Svelte 5 runes の $effect が再走しないため)。走行中の tip は電文
  // 到着で中断せず完走し (blocked=true でも lines は保持)、完了通知でのみ帯を空にする (供給と取消の分離)。
  // スケジューラ側にも同じ排他ガードがあり (割当時に hasNonTipActivity なら tip を載せない)、二重防御。
  let hasNonTipActivity = $state(false);
  const tipsFeeder = createTipsFeeder({
    context: () => mode,
    blocked: () => hasNonTipActivity,
  });
  $effect(() => () => tipsFeeder.destroy());
  // 電文 lines を必ず先に置く (同 priority では実電文が先)。context に合う Tip だけを混ぜる。
  const displayTickerLines = $derived(
    [...tickerLines, ...tipsFeeder.lines],
  );

  // emergency session は mode 遷移でのみ進める。パネル更新では shown 上限/cooldown をリセットしない。
  let emergencySession = $state(0);
  let previousMode: typeof mode | null = null;
  $effect(() => {
    const current = mode;
    untrack(() => {
      if (current === "emergency" && previousMode !== "emergency") emergencySession += 1;
      previousMode = current;
    });
  });
  const emergencyCompanionControl = $derived.by(() => {
    const base = deriveEmergencyCompanionControl(connection.state.snapshot, nowMs);
    return {
      ...base,
      sessionId: mode === "emergency" ? `emergency-${emergencySession}` : mode,
    };
  });

  // 津波チップ再生 (2026-07-14): チップクリックでその種別のテロップを Ticker へ再放送する。
  // Ticker が状態機械の所有者なので App に queue を持たず、bind:this の enqueueReplay 経由で投入する。
  let tickerApi = $state<{ enqueueReplay: (dto: DisplayTickerDtoV1) => void } | null>(null);
  let replaySeq = 0;

  // 地震履歴 overlay を持つ StandbyScreen 参照 (Codex 指摘5)。emergency 遷移開始時に明示的に閉じ、
  // standby outro の反転で overlay が残る不整合を防ぐ (onDestroy 依存だけだと outro 中の反転で
  // destroy されず残る)。bind:this は outro 中も生存し、mode が standby を離れた瞬間に呼べる。
  let standbyRef = $state<{ closeQuakeCard: () => void } | null>(null);
  $effect(() => {
    if (mode !== "standby") untrack(() => standbyRef?.closeQuakeCard());
  });

  // 津波 snapshot の世代。更新 (updatedAtMs 変化) と解除 (null 化) の両方で単調増加させ、Ticker が
  // 世代不一致の replay を purge する基準にする。updatedAtMs は津波 state の更新を一意に追える既存値。
  let tsunamiGeneration = $state(0);
  let prevTsunamiKey: string | null | undefined = undefined;
  $effect(() => {
    const t = connection.state.snapshot?.tsunami ?? null;
    const key = t == null ? null : String(t.updatedAtMs);
    untrack(() => {
      if (prevTsunamiKey === undefined) {
        prevTsunamiKey = key; // 初回観測は世代を進めない (0 のまま)
        return;
      }
      if (key !== prevTsunamiKey) {
        prevTsunamiKey = key;
        tsunamiGeneration += 1;
      }
    });
  });

  function replayTsunami(level: DisplayTsunamiLevel): void {
    const t = connection.state.snapshot?.tsunami;
    if (t == null) return;
    const dto = buildTsunamiReplayDto(t, level, tsunamiGeneration, ++replaySeq);
    if (dto == null) return;
    tickerApi?.enqueueReplay(dto);
  }

  // prefers-reduced-motion を購読する (StandbyScreen/TickerLane の既存パターンを踏襲)。
  // 切替後に開始する画面遷移が 0ms になる (spec §4-b、走行中のものは止めない)。
  let reducedMotion = $state(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  $effect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = mq.matches;
    const onChange = (e: MediaQueryListEvent): void => {
      reducedMotion = e.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
  // 緊急入場は transform のみの短い spring (spec §0-a、~142ms)。緊急→待機の回復と待機の入場は
  // 落ち着いた opacity クロスフェード、待機→緊急で退く待機は消失感を出さない短い fade。
  const enterDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_QUICK_MS);
  const calmDur = $derived(reducedMotion ? 0 : SPRING_EFFECTS_SLOW_MS);
  const exitDur = $derived(reducedMotion ? 0 : EXIT_MS);

  $effect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const lastReloadIso = window.localStorage.getItem(RELOAD_STORAGE_KEY);
      if (!shouldReload(lastReloadIso, now, mode)) return;
      window.localStorage.setItem(RELOAD_STORAGE_KEY, now.toISOString());
      window.location.reload();
    }, RELOAD_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  });
</script>

<svelte:window
  onclick={(e) => { if (shouldToggleDimOnClick(e.target)) dim.toggle(); }}
  onkeydown={(e) => { if (shouldToggleDimOnKey(e)) dim.toggle(); }}
/>

<main data-tier={severityTier} data-mode={mode} data-background-tone={backgroundTone}>
  <h1 class="visually-hidden">FlEq 防災情報ディスプレイ</h1>
  <div class="screen-area">
    {#if connection.state.snapshot == null}
      <div class="loading">接続中…</div>
    {:else if mode === "standby"}
      <div
        class="screen-layer"
        data-kind="standby"
        in:fade={{ duration: calmDur }}
        out:fade={{ duration: exitDur }}
      >
        <StandbyScreen
          bind:this={standbyRef}
          snapshot={connection.state.snapshot}
          now={clock.now}
          dim={effectiveDim}
          sseConnected={connection.state.sseConnected}
          onTsunamiReplay={replayTsunami}
        />
      </div>
    {:else if mode === "quakeMap" && quakeMapEvent != null}
      <div
        class="screen-layer"
        data-kind="quakeMap"
        in:fade={{ duration: calmDur }}
        out:fade={{ duration: calmDur }}
      >
        <QuakeMapScreen event={quakeMapEvent} dim={effectiveDim} />
      </div>
    {:else}
      <div
        class="screen-layer"
        data-kind="emergency"
        data-motion-reveal="scale"
        in:emergencyEnter={{ duration: enterDur }}
        out:fade={{ duration: calmDur }}
      >
        <EmergencyScreen panels={emergencyPanels} />
      </div>
    {/if}
  </div>
  <div class="ticker-frame">
    <Ticker
      bind:this={tickerApi}
      lines={displayTickerLines}
      now={mode === "emergency" ? clock.now : null}
      tickerGeneration={connection.state.tickerGeneration}
      tsunamiGeneration={tsunamiGeneration}
      dim={effectiveDim}
      onJobComplete={(key) => tipsFeeder.notifyComplete(key)}
      onActivityChange={(active) => { hasNonTipActivity = active; }}
      onAlertActivityChange={(active) => { tickerAlertActive = active; }}
      {emergencyCompanionControl}
    />
  </div>
  <TierOverlay tier={severityTier} />
</main>

<style>
  main {
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    cursor: pointer;
  }
  /* 画面領域はテロップの高さ分を常に確保する (テロップが画面下端の情報に重ならない) */
  .screen-area {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: calc(var(--ticker-row-h) * var(--ticker-rows));
  }
  /* 待機層・地震図層・緊急層を同一領域に重ねる (空白を経由しないクロスフェード)。stacking は DOM 順
     任せにせず z-index で明示 (緊急が最上面、spec §2-a)。frame-1 可視の主保証は緊急層の
     in:emergencyEnter が opacity を触らないこと (transitions.ts)。 */
  .screen-layer {
    position: absolute;
    inset: 0;
  }
  .screen-layer[data-kind="emergency"] {
    z-index: 3;
  }
  .screen-layer[data-kind="quakeMap"] {
    z-index: 2;
  }
  .screen-layer[data-kind="standby"] {
    z-index: 1;
  }
  /* クロスフェード中の入力所有権 (Codex 指摘1 → レビュー再検証)。現 mode と一致しない (=退場中の) 層
     だけを pointer-events:none にし、退場中の層が全面を覆って現行モードのクリックを横取りするのを防ぐ。
     緊急モード中の緊急層は対話要素 (PageDots・各パネルのスクロール領域) を持つので auto を維持し、
     待機へ抜ける最中に残存する緊急層だけを無効化する (常時 none は緊急画面の操作を殺すため不可)。
     減光トグルは <svelte:window onclick> が担うので、非活性層を無効化しても減光は従来どおり動く。 */
  main[data-mode="standby"] .screen-layer[data-kind="quakeMap"],
  main[data-mode="standby"] .screen-layer[data-kind="emergency"],
  main[data-mode="quakeMap"] .screen-layer[data-kind="standby"],
  main[data-mode="quakeMap"] .screen-layer[data-kind="emergency"],
  main[data-mode="emergency"] .screen-layer[data-kind="standby"],
  main[data-mode="emergency"] .screen-layer[data-kind="quakeMap"] {
    pointer-events: none;
  }
  .ticker-frame {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: calc(var(--ticker-row-h) * var(--ticker-rows));
    background: var(--bg);
  }
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--role-muted);
    font-size: var(--type-headline-s-size);
  }
</style>
