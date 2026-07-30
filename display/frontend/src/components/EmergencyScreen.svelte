<script lang="ts">
  import type { EmergencyPanelModel } from "../lib/derive";
  import { layoutPanels } from "../lib/layout";
  import { flipTranslate } from "../lib/transitions";
  import { SPRING_SPATIAL_QUICK_MS, springSpatialOut } from "../lib/motion";
  import EewPanel from "./EewPanel.svelte";
  import TsunamiPanel from "./TsunamiPanel.svelte";
  import QuakePanel from "./QuakePanel.svelte";
  import WeatherEmergencyPanel from "./WeatherEmergencyPanel.svelte";

  // snippet 末尾の網羅ガード (spec C §3)。到達したら kind の追加漏れなので描画せず投げる
  function assertNever(value: never): never {
    throw new Error(`未処理の緊急パネル kind: ${JSON.stringify(value)}`);
  }

  // 時計は第 3 波でテロップ (Ticker) 右端に移設したため、このコンポーネントは now を持たない
  let { panels }: { panels: EmergencyPanelModel[] } = $props();

  // 同時 EEW では並び替え先頭だけを視覚強調する。主役/副役という文言は表示しない。
  const emphasizedEewKey = $derived(panels.find((p) => p.input.kind === "eew")?.key ?? null);

  const layout = $derived(layoutPanels(panels.length));

  // 補間のため右列は常に固定段数 (STACK_ROW_SLOTS) の track を保持する (0fr / 実 fr のトグル +
  // gap track の 0/実で表現し、枚数が変わっても track 数を一定にして CSS transition が効くようにする、
  // spec §2)。緊急パネルの実運用最大は「津波 + EEW + 地震」級 (derive.ts は tsunami + activeEews[] +
  // largeQuakes[] を並べる。ハードな上限は無いが同時多発は稀)。4 段 (= 最大 5 パネル) までを滑らかに
  // 補間できれば実運用は足りる。6 枚以上は track 数が変わり離散化するが、下記 CSS の grid-auto-rows で
  // implicit 段に落ちて「壊れはしない」(Codex R3)。枚数を deriveEmergencyPanels 側で cap すると緊急情報を
  // 隠すことになるため、cap ではなくグリッドの縮退で吸収する。
  const STACK_ROW_SLOTS = 4;

  // prefers-reduced-motion 購読 (StandbyScreen と同型)。切替後に開始する再配置/遷移を 0ms にする。
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
  // 並べ替え FLIP・compact 遅延・レイアウト整定は同じ quick トークン (142ms) を共有する。
  const flipDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_QUICK_MS);

  // ── グリッド track 文字列 (枚数駆動)。列は「主役 / gap / 副役列」、行は右列の段数ぶんの
  //    「content / gap / content …」。値だけを枚数で変え track 数は一定に保つ (spec §2)。
  const gridCols = $derived.by(() => {
    const twoCol = layout.main; // 2 枚以上
    const colMain = twoCol ? "1.6fr" : "1fr";
    const colSide = twoCol ? "1fr" : "0fr";
    const colGap = twoCol ? "var(--space-3)" : "0px";
    return `minmax(0, ${colMain}) ${colGap} minmax(0, ${colSide})`;
  });
  const gridRows = $derived.by(() => {
    // track 数を常に一定にするため rowSlots は固定 (stackCount に追従させない、Codex R3)。
    // stackCount > STACK_ROW_SLOTS の超過分は implicit 段 (grid-auto-rows) に落ちる。
    const rowSlots = STACK_ROW_SLOTS;
    // 先頭段は常に active (1枚時の単一パネル / 2枚以上時の主役行が潰れないように)。以降は stackCount 段。
    const rowActive = (r: number): boolean => r === 0 || r < layout.stackCount;
    const tracks: string[] = [];
    for (let r = 0; r < rowSlots; r++) {
      tracks.push(`minmax(0, ${rowActive(r) ? 1 : 0}fr)`);
      if (r < rowSlots - 1) {
        // gap は「この段と次段がともに active」のときだけ実寸。末尾の 0fr 段間で余白が出ないように。
        tracks.push(rowActive(r) && rowActive(r + 1) ? "var(--space-3)" : "0px");
      }
    }
    return tracks.join(" ");
  });

  // ── compact 切替の遅延 (spec §3): 新規キーは即時に target の compact、既存キーが主役⇔副役を
  //    移るときだけ quick 遷移完了後に反映する。142ms 内の逆転操作では古い timer を取り消す。
  //    タイマーは通常の $effect 内で作り cleanup でキャンセルする (flushSync・$effect.root は使わない)。
  const targetCompact = $derived(new Map(panels.map((p, i) => [p.key, i !== 0])));
  let presentedCompact = $state(new Map<string, boolean>());
  // timer は「今どの目標値へ向けて張っているか (target)」も一緒に持つ。deriveEmergencyPanels() は
  // 毎レンダ新配列を返すため targetCompact も毎レンダ再計算されるが、目標値が同一のまま張り直すと
  // 短周期の内容更新中に timer が永久にリセットされ compact が未反映のままになる。目標値が変わった
  // ときだけ張り直し、同一目標の間は継続させる (Codex R2)。
  const compactTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; target: boolean }>();
  function clearTimer(key: string): void {
    const pending = compactTimers.get(key);
    if (pending != null) {
      clearTimeout(pending.timer);
      compactTimers.delete(key);
    }
  }
  $effect(() => {
    const target = targetCompact;
    const delayMs = flipDur;
    const next = new Map(presentedCompact);
    let immediate = false;
    // 消えたキーを掃除
    for (const key of [...next.keys()]) {
      if (!target.has(key)) {
        next.delete(key);
        immediate = true;
        clearTimer(key);
      }
    }
    for (const [key, want] of target) {
      if (!next.has(key)) {
        // 新規キー: 即時に target の compact 値
        next.set(key, want);
        immediate = true;
        clearTimer(key);
      } else if (next.get(key) === want) {
        // 既に一致: 保留中タイマーがあれば取り消す (逆転操作での誤適用防止)
        clearTimer(key);
      } else if (delayMs === 0) {
        // reduced-motion: 保留せず同期的に最終状態へ
        next.set(key, want);
        immediate = true;
        clearTimer(key);
      } else {
        // 既存キーの役割変更: quick 遷移完了後に反映。同一目標へ既に張っているなら継続 (張り直さない、
        // Codex R2)。目標が変わった / 未着手のときだけ張り直す。
        const pending = compactTimers.get(key);
        if (pending == null || pending.target !== want) {
          if (pending != null) clearTimeout(pending.timer);
          const timer = setTimeout(() => {
            compactTimers.delete(key);
            const m = new Map(presentedCompact);
            m.set(key, want);
            presentedCompact = m;
          }, delayMs);
          compactTimers.set(key, { timer, target: want });
        }
      }
    }
    if (immediate) presentedCompact = next;
  });
  $effect(() => () => {
    for (const pending of compactTimers.values()) clearTimeout(pending.timer);
    compactTimers.clear();
  });
  function compactOf(key: string, index: number): boolean {
    return presentedCompact.get(key) ?? index !== 0;
  }

  // ── レイアウト整定フラグ (spec §4): グリッド track が変わってから遷移完了までを settling とし、
  //    各パネルへ prop で渡して測定反映を保留させる。
  //    完了判定は「新しい遷移が始まるたびに fallback timer を張り直す」方式に統一した (Codex R1)。
  //    旧実装は .panels の transitionend で早期解除していたが、列と行は別々に完了するうえ割込み遷移
  //    (例 1→2 の 142ms 内に 2→3) では先に終わる列の transitionend が settling を解除し、行がまだ
  //    遷移中なのに測定が途中寸法で flush される早抜けが起きた。track 変化のたびに clearTimeout +
  //    張り直す (最後の遷移が窓を張る) ことで、進行中の全 grid-template-* 遷移が収束するまで保つ。
  //    reducedMotion では遷移が無い (CSS transition:none) ため即 false にする。
  let layoutSettling = $state(false);
  let settleFallback: ReturnType<typeof setTimeout> | undefined;
  let prevGridSig: string | undefined;
  $effect(() => {
    const sig = `${gridCols}||${gridRows}`;
    const changed = prevGridSig !== undefined && sig !== prevGridSig;
    prevGridSig = sig;
    // reduced-motion は「同期反映」経路: 遷移中に OS で reduced-motion がオンになると CSS transition は
    // 即時停止するが、grid sig が不変だと changed=false で抜けてしまい fallback timer だけが最大 222ms
    // 残り、layoutSettling と測定保留の解除が遅延して同期しない (Codex R6)。reducedMotion が真なら
    // grid 変化の有無に関わらず進行中の fallback を取り消して settling を即時解除する。パネル側の測定
    // 保留は layoutSettling=false を購読する $effect が同 tick で flush する (QuakePanel/TsunamiPanel)。
    // compact 遅延の pending timer は flipDur→0 で reconcile $effect が delayMs===0 経路に入り即時確定する。
    if (reducedMotion) {
      clearTimeout(settleFallback);
      layoutSettling = false;
      return;
    }
    // grid 文字列が実際に変わったときだけ整定を始める (初期マウント / grid 以外の依存変化では発火しない)。
    if (!changed) return;
    layoutSettling = true;
    // 割込み遷移では最後の遷移が窓を張る (張り直しで早抜けを防ぐ、Codex R1)。
    clearTimeout(settleFallback);
    settleFallback = setTimeout(() => {
      layoutSettling = false;
    }, SPRING_SPATIAL_QUICK_MS + 80);
  });
  $effect(() => () => clearTimeout(settleFallback));
</script>

{#snippet panelBody(p: EmergencyPanelModel, compact: boolean, settling: boolean)}
  <!-- 全 kind を明示分岐する (フォールスルー撲滅、spec C §3)。else へ落とすと新 kind が黙って
       QuakePanel で描画されるため、末尾は assertNever で型と実行時の両方から塞ぐ -->
  {#if p.input.kind === "eew"}
    <EewPanel input={p.input} {compact} {settling} emphasized={p.key === emphasizedEewKey} />
  {:else if p.input.kind === "tsunami"}
    <TsunamiPanel input={p.input} {compact} layoutSettling={settling} />
  {:else if p.input.kind === "largeQuake"}
    <QuakePanel input={p.input} mapEvent={p.quakeMap ?? null} {compact} layoutSettling={settling} />
  {:else if p.input.kind === "weather"}
    <WeatherEmergencyPanel input={p.input} {compact} layoutSettling={settling} />
  {:else}
    {assertNever(p.input)}
  {/if}
{/snippet}

<div class="emergency-screen layout-{layout.class}">
  <div
    class="panels"
    style={`grid-template-columns: ${gridCols}; grid-template-rows: ${gridRows};`}
    data-settling={layoutSettling ? "true" : "false"}
  >
    {#each panels as p, i (p.key)}
      <div
        class="panel-slot"
        class:is-main={layout.main && i === 0}
        data-testid={p.key}
        data-motion-reveal="scale"
        style={i === 0 ? undefined : `grid-column: 3; grid-row: ${2 * (i - 1) + 1};`}
        animate:flipTranslate={{ duration: flipDur, easing: springSpatialOut }}
      >
        {@render panelBody(p, compactOf(p.key, i), layoutSettling)}
      </div>
    {/each}
  </div>
</div>

<style>
  .emergency-screen {
    position: relative;
    /* 親 (.screen-area) がテロップの高さを除いた領域を渡してくる (100vh 固定ははみ出しの元) */
    width: 100%;
    height: 100%;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .panels {
    flex: 1;
    min-height: 0;
    display: grid;
    width: 100%;
    /* gap は grid の gap ではなく track 側 (var(--space-3) の gap track) で表現する (補間のため)。 */
    gap: 0;
    /* STACK_ROW_SLOTS を超える枚数 (6 枚以上、実運用では稀) の副役スロットは明示 track を外れ
       implicit 段に落ちる。その段が content 高さで暴れないよう 1fr で等分する (補間はしないが壊れない)。 */
    grid-auto-rows: minmax(0, 1fr);
    padding: var(--space-3);
    /* 枚数増減はグリッド track の補間で表現する (FLIP はサイズ変更から外し translate のみ、spec §2)。
       時間/easing は spring-spatial-quick トークン (theme.css) を参照する (duration 直値は撒かない)。 */
    transition:
      grid-template-columns var(--spring-spatial-quick-dur) var(--spring-spatial-quick),
      grid-template-rows var(--spring-spatial-quick-dur) var(--spring-spatial-quick);
  }
  .layout-full .panels {
    --panel-scale: 1.5;
  }
  /* 主役スロット (B3 hero moment): main-stack で列全体を占める最大面積 (grid-row span)。
     入場は opacity を触らず、この span 構造 + グリッド track 補間が担う (外枠の scale 入場は撤去済み)。 */
  .layout-main-stack .panel-slot.is-main {
    grid-column: 1;
    grid-row: 1 / -1;
  }
  /* 副役 (スタック) スロットの列/行はインライン style で割り当てる (grid-column:3 + 段ごとの grid-row)。 */
  .panel-slot {
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .panels {
      transition: none;
    }
  }
</style>
