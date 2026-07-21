<script lang="ts">
  import type {
    DisplayStateSnapshotV1,
    DisplayTsunamiStateV1,
    DisplayLatestQuakeStateV1,
    DisplayRecentQuakeV1,
    DisplayTsunamiLevel,
    ActiveStandbyCardV1,
  } from "../lib/protocol";
  import { onDestroy, untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { fade } from "svelte/transition";
  import { recentQuakeId } from "../lib/format";
  import Clock from "./Clock.svelte";
  import RecentQuakes from "./RecentQuakes.svelte";
  import QuakeReplayCard from "./QuakeReplayCard.svelte";
  import ConnectionBadge from "./ConnectionBadge.svelte";
  import TsunamiStandbyBanner from "./TsunamiStandbyBanner.svelte";
  import WeatherAlertCard from "./WeatherAlertCard.svelte";
  import LatestQuakeCard from "./LatestQuakeCard.svelte";
  import InstrumentRow from "./InstrumentRow.svelte";
  import HeatAlertCard from "./HeatAlertCard.svelte";
  import TyphoonCard from "./TyphoonCard.svelte";
  import VolcanoCard from "./VolcanoCard.svelte";
  import FloodCard from "./FloodCard.svelte";
  import FloodWideCard from "./FloodWideCard.svelte";
  import StandbyOverflowSummary from "./StandbyOverflowSummary.svelte";
  import NankaiBadge from "./NankaiBadge.svelte";
  import { partitionStandbyItems, selectRightStack } from "../lib/standby-cards";
  import { SPRING_SPATIAL_DEFAULT_MS, EXIT_MS, springSpatialOut, SPRING_LINEARS } from "../lib/motion";
  import { spatialScaleIn } from "../lib/transitions";
  import { measureBorderHeight } from "../lib/measure-height";

  // onTsunamiReplay: 津波チップクリックでその種別のテロップ再生を App へ委譲する (2026-07-14)。
  let { snapshot, now, dim, sseConnected, onTsunamiReplay }: {
    snapshot: DisplayStateSnapshotV1;
    now: Date;
    dim: boolean;
    sseConnected: boolean;
    onTsunamiReplay?: (level: DisplayTsunamiLevel) => void;
  } = $props();

  // 地震履歴クリックで再表示する詳細カード overlay の所有者 (設計 v2 確定事項 5)。selectedRecentQuake が
  // null でなければ overlay を出す。サーバ状態 / deriveMode には一切影響させない (フロントローカル)。
  // 選択は安定 ID (recentQuakeId、index 非依存) で持ち、snapshot 更新に追従する (Codex 指摘2)。
  const QUAKE_CARD_AUTO_CLOSE_MS = 20_000;
  let selectedRecentQuake = $state<DisplayRecentQuakeV1 | null>(null);
  let selectedId = $state<string | null>(null);
  // タイマーは世代管理して stale クローズを防ぐ (差し替え・即クローズで前タイマーの発火を無効化する)。
  let closeGen = 0;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCloseTimer(): void {
    closeGen += 1; // 進行中タイマーが遅れて発火しても世代不一致で no-op になる
    if (closeTimer != null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  // 外部 (App) からも呼べる公開クローズ。emergency 遷移開始時に App が明示的に閉じ、standby outro の
  // 反転で overlay が戻る不整合を防ぐ (Codex 指摘5。onDestroy 依存だけだと outro 中の反転で destroy
  // されず残る)。
  export function closeQuakeCard(): void {
    clearCloseTimer();
    selectedRecentQuake = null;
    selectedId = null;
  }

  function scheduleAutoClose(): void {
    clearCloseTimer();
    const gen = closeGen;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (gen === closeGen) closeQuakeCard();
    }, QUAKE_CARD_AUTO_CLOSE_MS);
  }

  function selectRecentQuake(quake: DisplayRecentQuakeV1, id: string): void {
    if (selectedId === id) {
      closeQuakeCard(); // 同じ項目の再クリックは即クローズ (トグル)
      return;
    }
    selectedRecentQuake = quake; // 別項目は差し替え + タイマーリセット
    selectedId = id;
    scheduleAutoClose();
  }

  // snapshot.recentQuakes 更新への追従 (Codex 指摘2)。選択中の地震が新リストに居れば最新 DTO へ差し替え
  // (訂正報反映)、居なくなれば閉じる (5 件押し出しで消えた地震の overlay を残さない)。DTO 差し替えでは
  // タイマーをリセットせず残存時間を維持する (ユーザーが開いた瞬間からの 20 秒を守る)。
  $effect(() => {
    const list = snapshot.recentQuakes;
    untrack(() => {
      if (selectedId == null) return;
      const matches = list.filter((q) => recentQuakeId(q) === selectedId);
      // 一意でない (0 件=消えた / 2 件以上=ID 衝突) ときは追従を諦めて閉じる。誤った先頭 find で
      // 別の地震を出すより安全 (レビュー再検証)。eventId が途中付与されると ID が変わり 0 件化して
      // 閉じるが、これはサーバ系列 ID 供給 (残課題) までの許容挙動。
      if (matches.length !== 1) {
        closeQuakeCard();
        return;
      }
      const fresh = matches[0]!;
      if (fresh !== selectedRecentQuake) {
        selectedRecentQuake = fresh; // 最新版へ差し替え (タイマーは維持)
      }
    });
  });

  // emergency 遷移 (StandbyScreen unmount) でタイマーが残留しないよう確実に止める (二重防御。主経路は
  // App が closeQuakeCard を明示呼び出しする)。
  onDestroy(() => clearCloseTimer());

  // prefers-reduced-motion を購読する (TickerLane.svelte の既存パターンを踏襲)。
  // matchMedia 未実装環境 (一部テスト環境) ではスキップし、通常の duration のまま動かす。
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
  const flipDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);
  const enterDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);
  const exitDur = $derived(reducedMotion ? 0 : EXIT_MS); // 消失感を出さない短い fade

  // 左上コーナーの表示アイテムを keyed 配列で導出する (animate:flip の並べ替え検出用)。
  // 履歴クリックの詳細カード (replay) は「普通に地震情報を受信したときと同じ位置」= LatestQuakeCard の
  // スロットに出す (実機フィードバック 2026-07-14)。選択中は replay がそのスロットを占有し LatestQuakeCard
  // は隠れる (別スロットに二重表示しない)。閉じると LatestQuakeCard に戻る。
  //
  // 重要: 地震スロットは replay/latest を跨いで同一 key "quake-slot" にする (増分レビュー)。
  // 別 key にすると切替時に旧カードが out:fade の outro 完了 (~200ms) まで残り、新旧 2 枚が同時に
  // corner-left へ積まれて排他占有が視覚的に破れる。同一 key なら外側の corner-item 要素は生死を
  // またがず (outro なし)、内側のコンポーネントだけ即時差し替わる。スロット全体が現れる/消えるとき
  // (地震情報が無い⇔ある) だけ従来どおり in/out する。
  type QuakeSlotPayload =
    | { replay: DisplayRecentQuakeV1; quake: null }
    | { replay: null; quake: DisplayLatestQuakeStateV1 };
  type CornerItem =
    | { key: "tsunami"; tsunami: DisplayTsunamiStateV1 }
    | ({ key: "quake-slot" } & QuakeSlotPayload);
  const quakeSlot = $derived<CornerItem | null>(
    selectedRecentQuake != null
      ? { key: "quake-slot", replay: selectedRecentQuake, quake: null }
      : snapshot.latestQuake != null
        ? { key: "quake-slot", replay: null, quake: snapshot.latestQuake }
        : null,
  );
  const leftStack = $derived<CornerItem[]>([
    ...(snapshot.tsunami != null ? [{ key: "tsunami", tsunami: snapshot.tsunami } as const] : []),
    ...(quakeSlot != null ? [quakeSlot] : []),
  ]);
  const standbyPartitions = $derived(partitionStandbyItems(snapshot.standbyItems ?? []));
  const floodItem = $derived(
    standbyPartitions.cornerRight.find((item) => item.kind === "flood")
      ?? standbyPartitions.clockTopWide.find((item) => item.kind === "flood")
      ?? null,
  );
  const floodSlot = $derived(floodItem == null ? [] : [floodItem]);
  let floodHeightPx = $state(0);
  const floodCornerOffsetPx = $derived(floodItem?.surface === "corner-right" ? floodHeightPx + 12 : 0);
  const rightStack = $derived(selectRightStack(
    standbyPartitions.cornerRight.filter((item) => item.kind !== "flood"),
    700 - (floodItem?.surface === "corner-right" ? 112 : 0),
    (item) => {
      if (item.kind === "typhoon") return 74 + item.data.typhoons.length * 72;
      if (item.kind === "volcano") return 44 + item.data.volcanoes.length * 48;
      return 112;
    },
  ));
  const rightOverflow = $derived([...rightStack.overflow, ...standbyPartitions.unknown]);
  const tornadoItem = $derived(standbyPartitions.weatherRider.find((item) => item.kind === "tornado") as Extract<ActiveStandbyCardV1, { kind: "tornado" }> | undefined ?? null);
  const longPeriodItem = $derived(standbyPartitions.quakeRider.find((item) => item.kind === "longPeriod" && item.data.eventId === snapshot.latestQuake?.eventId) as Extract<ActiveStandbyCardV1, { kind: "longPeriod" }> | undefined ?? null);
  const nankaiItem = $derived(standbyPartitions.clockBelow.find((item) => item.kind === "nankaiTrough") as Extract<ActiveStandbyCardV1, { kind: "nankaiTrough" }> | undefined ?? null);

  // 時計ブロック (切断バッジ + 時刻 + 日付) の実測高さの半分 (px)。時計は .clock-row が
  // top:50% 中央配置なので、その「実下端」= 50% + 高さ/2。統計行の帯はこの実下端から始める
  // (帯上端を素の 50% にすると時計の下半分＝日付行が帯に食い込み、統計行が日付に重なる。
  // Chrome 実測 2026-07-12 で検出した回帰の修正)。時計サイズは min(14vw,25vh) 等で可変な
  // ため px 直値では追えず、measureBorderHeight (既存 ResizeObserver action) で実測して
  // CSS var 経由で calc に渡す。jsdom は ResizeObserver 未実装で 0 のまま (帯上端は 50% に退避)。
  let clockHalfPx = $state(0);

  // 統計行 (計器列) は「地震カード有無」で縦位置が変わる:
  //  - カード無し: 領域 [時計ブロック下端, テロップ上端] の中央に置く
  //  - カード有り: 領域 [時計ブロック下端, カード上端] の中央に置く (カードは従来どおり最下段)
  // どちらも .instrument-slot (flex:1) の垂直中央寄せで実現するため、状態遷移では
  // flex の再配分が起きて要素が瞬間移動する。これを FLIP (First-Last-Invert-Play) で
  // 滑らかに繋ぐ。svelte の animate:flip は keyed each の並べ替え専用で単独要素の
  // 兄弟出現には反応しないため、$effect.pre で遷移前 top を測り $effect で遷移後 top
  // との差を WAAPI translateY アニメに乗せる。easing/duration は spatial spring トークン
  // (SPRING_LINEARS/SPRING_SPATIAL_DEFAULT_MS) を流用し、新規時間定数は作らない。
  const hasCard = $derived(snapshot.recentQuakes.length > 0);
  let instrumentEl = $state<HTMLElement | null>(null);
  let flipReady = false; // 初回マウント時は演出しない (位置差の無い初期描画)
  let flipFirstTop = 0;
  // 走行中の FLIP アニメのハンドル。短時間にカード状態が往復すると、走行中の transform が
  // $effect.pre の計測に混ざって揺れ・アニメ蓄積を起こすため、次回計測前と unmount 時に
  // cancel() する (レビュー Minor)。計測は cancel 後 (transform 除去後) に行う。
  let flipAnim: Animation | null = null;

  $effect.pre(() => {
    hasCard; // カード有無の切替を購読 (これが縦位置を変える唯一の入力)
    if (instrumentEl == null) return;
    flipAnim?.cancel(); // 走行中アニメを止め、計測に in-flight transform を混ぜない
    flipAnim = null;
    flipFirstTop = instrumentEl.getBoundingClientRect().top;
  });
  $effect(() => {
    hasCard; // $effect.pre と同じ切替で発火させる
    if (!flipReady) {
      flipReady = true;
      return;
    }
    const el = instrumentEl;
    if (el == null || reducedMotion) return; // reduced-motion では瞬時切替 (FLIP なし)
    const dy = flipFirstTop - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return; // 位置が動いていなければ何もしない
    flipAnim = el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      { duration: SPRING_SPATIAL_DEFAULT_MS, easing: SPRING_LINEARS["spring-spatial-default"] },
    );
    flipAnim.onfinish = () => {
      flipAnim = null;
    };
  });
  // unmount 時に走行中アニメを確実に停止する (ハンドルのリーク防止)
  $effect(() => () => flipAnim?.cancel());
</script>

<div class="standby" class:dim style="--clock-half: {clockHalfPx}px; --flood-corner-offset: {floodCornerOffsetPx}px">
  {#each floodSlot as item (item.key)}
    <div
      class="flood-slot"
      class:flood-corner={item.surface === "corner-right"}
      class:clock-top-slot={item.surface === "clock-top-wide"}
      use:measureBorderHeight={(height) => (floodHeightPx = height)}
      in:spatialScaleIn|global={{ duration: enterDur, start: 0.97 }}
      out:fade={{ duration: exitDur }}
    >
      {#if item.surface === "clock-top-wide"}
        <FloodWideCard {item} />
      {:else}
        <FloodCard {item} />
      {/if}
    </div>
  {/each}
  <div class="corner-right">
    {#if snapshot.weatherAlerts.length > 0 || tornadoItem != null}
      <div
        class="weather-corner"
        in:spatialScaleIn|global={{ duration: enterDur, start: 0.97 }}
        out:fade={{ duration: exitDur }}
      >
        <WeatherAlertCard alerts={snapshot.weatherAlerts} tornado={tornadoItem} />
      </div>
    {/if}
    {#each rightStack.visible as item (item.key)}
      <div class="standby-corner" in:spatialScaleIn|global={{ duration: enterDur, start: 0.97 }} out:fade={{ duration: exitDur }}>
        {#if item.kind === "heat"}
          <HeatAlertCard {item} />
        {:else if item.kind === "typhoon"}
          <TyphoonCard {item} />
        {:else if item.kind === "volcano"}
          <VolcanoCard {item} />
        {/if}
      </div>
    {/each}
    <StandbyOverflowSummary items={rightOverflow} />
  </div>
  <div class="corner-left">
    {#each leftStack as item (item.key)}
      <div
        class="corner-item"
        class:tsunami-corner={item.key === "tsunami"}
        class:quake-corner={item.key === "quake-slot"}
        animate:flip={{ duration: flipDur, easing: springSpatialOut }}
        in:spatialScaleIn|global={{ duration: enterDur, start: 0.97 }}
        out:fade={{ duration: exitDur }}
      >
        {#if item.key === "tsunami"}
          <TsunamiStandbyBanner tsunami={item.tsunami} onReplayLevel={onTsunamiReplay} />
        {:else if item.replay != null}
          <!-- 同一 key スロットの内側差し替え。replay 選択中は replay を出し LatestQuakeCard は隠す -->
          <QuakeReplayCard quake={item.replay} onClose={closeQuakeCard} />
        {:else}
          <LatestQuakeCard quake={item.quake} longPeriod={longPeriodItem?.data ?? null} />
        {/if}
      </div>
    {/each}
  </div>
  <div class="clock-row">
    <div class="clock-stack" use:measureBorderHeight={(h) => (clockHalfPx = h / 2)}>
      <ConnectionBadge connection={snapshot.connection} {sseConnected} />
      {#if nankaiItem != null}<NankaiBadge item={nankaiItem} />{/if}
      <Clock {now} />
    </div>
  </div>
  <div class="bottom-stack">
    <div class="instrument-slot">
      <div class="instrument-row-wrap" bind:this={instrumentEl}>
        <InstrumentRow stats={snapshot.stats} />
      </div>
    </div>
    {#if snapshot.recentQuakes.length > 0}
      <div class="quakes-card">
        <RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} />
      </div>
    {/if}
  </div>
</div>

<style>
  .standby {
    position: relative;
    /* 親 (.screen-area) がテロップの高さを除いた領域を渡してくるので 100% を使う。
       100vh にすると画面全高に固定されテロップの下へはみ出す */
    width: 100%;
    height: 100%;
    padding: var(--space-12);
    background: var(--bg);
    transition: opacity 0.6s ease;
  }
  .corner-right {
    position: absolute;
    top: calc(24px + var(--flood-corner-offset, 0px));
    right: 32px;
    max-height: calc(100% - 48px - var(--flood-corner-offset, 0px));
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3);
    overflow: hidden;
  }
  .flood-slot {
    z-index: 2;
  }
  .flood-corner {
    position: absolute;
    top: 24px;
    right: 32px;
  }
  .clock-top-slot {
    position: absolute;
    left: 50%;
    bottom: calc(50% + var(--clock-half, 0px) + var(--space-6));
    transform: translateX(-50%);
    max-height: min(30vh, calc(50% - var(--clock-half, 0px) - 48px));
    overflow: hidden;
  }
  .corner-left {
    position: absolute;
    top: 24px;
    left: 32px;
    max-height: calc(100% - 48px);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow: hidden;
  }
  /* 時計 (+切断通知) は画面の垂直方向でも中心に来るよう、下段コンテンツと独立に
     絶対配置で中央固定する (下段の高さに引きずられて上寄りになっていた問題の修正) */
  .clock-row {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .clock-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  /* 下段は「時計ブロックの実下端 (50% + 時計高さ/2)」から「テロップ上端 (bottom:0)」までを
     占める帯。--clock-half は clock-stack の実測 border-box 高さの半分 (px) を JS が渡す。
     この帯の中で .instrument-slot が余白を吸って統計行を垂直中央へ寄せることで、
     カード無し時は帯全体の中央、カード有り時はカード上端までの中央、という「相対配置」を
     ビューポート高さ・時計サイズに依らず成立させる (px 直値を使わない)。時計の下半分を
     帯に含めないので統計行が日付行に重ならない。 */
  .bottom-stack {
    position: absolute;
    left: 24px;
    right: 24px;
    top: calc(50% + var(--clock-half, 0px));
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-6);
  }
  /* 統計行を載せるスロット。flex:1 で「カード上端 (無ければテロップ上端) までの残余」を
     占め、その中央に統計行を置く。overflow を切らないので万一カードが帯を占めても
     統計行がクリップされない (可読性の安全側)。 */
  .instrument-slot {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .instrument-row-wrap {
    display: flex;
    justify-content: center;
    /* WAAPI FLIP が transform を書き換えるため、静止時の合成基準を明示しておく */
    transform: translateY(0);
  }
  .quakes-card {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-2);
    padding: var(--space-4) var(--space-7);
    width: min(600px, calc(100% - 48px));
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .quakes-card::-webkit-scrollbar {
    display: none;
  }

  /* 寝室仕様の減光: 全体 0.35 で時計を暗く沈める。時計以外のカード類は子 0.7 を
     重ねて親 0.35 × 子 0.7 = 実効約 0.25 とし、内容が読み取れる可読性を保つ。 */
  .standby.dim {
    opacity: 0.35;
  }
  .standby.dim .quake-corner,
  .standby.dim .instrument-row-wrap,
  .standby.dim .quakes-card {
    opacity: 0.7;
  }
  /* 警報級の常駐カード (気象警報カード・津波バナー) は一般要素と同じ可読性下限で扱う。
     具体値は実機夜間検証で調整する。 */
  .standby.dim .weather-corner,
  .standby.dim .tsunami-corner,
  .standby.dim .flood-slot {
    opacity: 0.7;
  }
</style>
