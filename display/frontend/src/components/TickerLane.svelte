<script lang="ts">
  // 受動部品 (spec §4-2): 親スケジューラから与えられた 1 ジョブの 1 セグメントを走らせ、
  // 完了 (scroll / fade) を animationName + generation つきで親へ通知するだけ。割当・割込み・
  // 巡回の判断は一切持たない。generation は animationend 誤発火ガードの唯一の真実源 (§4-4)。
  import { fade } from "svelte/transition";
  import type { TickerJob } from "../lib/ticker-schedule";
  import { pageCharsForWidth, pageSplit, readTranslateX, lastPassedBookmark, splitEmphasis, type EmphasisSpan } from "../lib/ticker-segment";
  import { resolveChipTokens, resolveSurfaceTokens } from "../lib/ticker-chip";
  import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { isAlertRole } from "../lib/alert-roles";

  const MIN_DURATION_S = 8; // 極端な短文の保護
  const CHARS_PER_SECOND = 5; // 全角換算で 1 秒あたり 5 文字、全行共通の体感速度
  const MIN_HOLD_S = 3; // reduced-motion 極短ページの保護
  const CHIP_LINGER_MS = 500; // テロップ流れきり (job=null) 後も左端チップを残す時間。目視フィードバック (2026-07-11「流れきった瞬間に消えると不具合に見える」→ その後「2 秒は長い、0.5 秒に」で 2000→500 へ短縮)。消え際フェード (231ms、|global) は 500ms 内に収まる。調整前提

  type LanePhase = "idle" | "running" | "fading";

  let {
    job,
    segmentIndex,
    runEnd,
    generation,
    phase,
    dim = false,
    showRevisionBadge = false,
    emphasis = null,
    onScrollEnd,
    onFadeEnd,
    onBookmarkCapture,
  }: {
    job: TickerJob | null;
    segmentIndex: number;
    runEnd: number; // 現 run の endSegmentIndexExclusive (§2-1)
    generation: number;
    phase: LanePhase;
    dim?: boolean;
    showRevisionBadge?: boolean;
    emphasis?: "high" | null;
    onScrollEnd: (generation: number) => void;
    onFadeEnd: (generation: number) => void;
    onBookmarkCapture: (generation: number, index: number, nearBoundary: boolean) => void;
  } = $props();

  let reducedMotion = $state(false);
  let laneEl = $state<HTMLDivElement | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);
  let lineEl = $state<HTMLDivElement | null>(null);
  let shiftPx = $state(0);
  let durationS = $state(MIN_DURATION_S);
  let pageIndex = $state(0);
  let laneWidth = $state(0); // scrollEl の実測幅 (ResizeObserver で追従、Medium 4)
  let lastGen = -1;
  let fadeCapturedGen = -1; // fade 開始時の栞捕捉を 1 世代 1 回に限定 (自己再走の read/write サイクル防止)
  // 栞 span の DOM 参照。**意図的に非 reactive** (B Task 4 実測根拠: $state 化すると bind:this の
  // 書込みが effect を自己再走させ effect_update_depth_exceeded を招く)。plain let だと Svelte 5 が
  // 「$state 宣言なしの更新」を恒常 warning するため、再代入されない const holder のプロパティ配列に
  // 参照を保持して warning を回避する (挙動は据え置き、最終レビュー finding 7)。
  const bookmarkHolder: { els: HTMLSpanElement[] } = { els: [] };

  // 左端チップの残し (§UX): 走行中は job のチップをそのまま、job=null になった後も CHIP_LINGER_MS だけ
  // 直前のチップを残す (次ジョブ到着で即差替え、走行文字は残さずチップのみ)。reduced-motion でも同挙動。
  type ChipInfo = { category: string; subject: string | null; role: TickerJob["role"] };
  let lingerChip = $state<ChipInfo | null>(null);
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  const currentChip = $derived<ChipInfo | null>(
    job != null && job.category != null && job.category.length > 0
      ? { category: job.category, subject: job.subject, role: job.role }
      : null,
  );
  // ラベルに出すチップ: 走行中は currentChip、job=null 中は残存 lingerChip
  const shownChip = $derived(job != null ? currentChip : lingerChip);
  // チップの container/on を role から解決 (Spec C §3-4)。CSS が var(--chip-*) を消費する
  const chipTokens = $derived(shownChip != null ? resolveChipTokens(shownChip.role) : null);
  const surfaceTokens = $derived(
    job != null && job.surface === "solid" ? resolveSurfaceTokens(job.role) : null,
  );
  // チップの入替キー。role/種別/件名のいずれかが変わったら {#key} が旧チップを outro、新チップを intro
  // させ、割込み・入替を cross-fade で切替える (出現/消滅は #if の in/out が担う)。目視レビュー
  // フィードバック (2026-07-11「出現・消滅・切替もフェード」)。既存のページ切替 (TsunamiPanel) と同文法。
  // transition は **|global 必須**: Svelte 5 の transition は既定 local で、局所 transition は自要素の
  // 直上ブロックの生成/破棄でしか発火しない。ここは {#if shownChip} > {#key} > <div transition> の
  // 入れ子なので、{#if} トグル (=出現/linger 後の消え際) は祖先ブロック起因となり local ではスキップされ
  // ポップイン/アウトになる。|global で {#if} トグル時の intro/outro も発火させる ({#key} 切替の cross-fade は維持)
  const chipKey = $derived(
    shownChip != null ? `${shownChip.role}|${shownChip.category}|${shownChip.subject ?? ""}` : "",
  );

  $effect(() => {
    if (job != null) {
      // 走行中はチップを同期。前の linger タイマーがあれば止めて即差替え
      if (lingerTimer != null) { clearTimeout(lingerTimer); lingerTimer = null; }
      lingerChip = currentChip;
    } else if (lingerChip != null && lingerTimer == null) {
      // 流れきり: CHIP_LINGER_MS 後にチップを消す
      lingerTimer = setTimeout(() => { lingerChip = null; lingerTimer = null; }, CHIP_LINGER_MS);
    }
  });
  $effect(() => () => { if (lingerTimer != null) clearTimeout(lingerTimer); }); // unmount で timer 後始末
  const BOUNDARY_GUARD_PX = 12; // 栞境界近傍のみ一つ前へ丸める (§2-2/§12)
  const SEG_JOIN = "　"; // 連続走行のセグメント間区切り (全角空白)。式展開で渡し Svelte の whitespace trim を回避

  // レーン幅を reactive に追従させる (時計出現・画面幅・font-size 変更で pages/geometry を再計算)
  $effect(() => {
    const el = scrollEl;
    if (el == null || typeof ResizeObserver === "undefined") {
      if (el != null) laneWidth = el.clientWidth;
      return;
    }
    const ro = new ResizeObserver(() => {
      laneWidth = el.clientWidth;
    });
    ro.observe(el);
    laneWidth = el.clientWidth;
    return () => ro.disconnect();
  });

  // 現 run 全体の連結テキスト (§2-1)。描画の span 列 (slice(segmentIndex, runEnd) を SEG_JOIN で連結)
  // と同一の文字列源。走行 geometry (移動距離/尺) と reduced-motion のページ分割は run 全体で計算する
  // ため、run 先頭 1 セグメントではなくここを食う (先頭のみだと run 後半が通過しきらず/表示欠落する)。
  const runText = $derived(
    job != null && job.segments.length > 0
      ? job.segments.slice(segmentIndex, runEnd).join(SEG_JOIN)
      : "",
  );

  // UDEV Gothic は等幅。全角相当 (>=0x100) = 1em、半角相当 = 0.5em で幅を見積もる
  function estimateTextWidthEm(text: string): number {
    let total = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      total += code < 0x100 ? 0.5 : 1;
    }
    return total;
  }

  // generation が変わったら栞参照とページ位置をリセット (新 run/新 job の頭から)。
  // **$effect.pre** で行う: bind:this による bookmarkEls への書き込みは DOM 更新中 (= 通常 $effect
  // より前) に走るため、post-$effect でクリアすると新 run の span 参照を直後に空配列で上書きしてしまい
  // (実測でマウント後 count=3 → クリアで 0)、fade 時の栞実測が全滅する。pre なら span マウント前に
  // 旧参照を消し、マウントが新参照で埋め直す順序になる (§2-2)。
  $effect.pre(() => {
    if (generation !== lastGen) {
      lastGen = generation;
      bookmarkHolder.els = [];
      pageIndex = 0;
    }
  });

  // 通常スクロールの移動距離・duration を実測 font-size とレーン幅から再計算 (§4-4-4 実測 px 継続)
  $effect(() => {
    void generation;
    void runText;
    if (reducedMotion || job == null || phase !== "running" || lineEl == null || laneEl == null) return;
    const fontSizePx = parseFloat(getComputedStyle(lineEl).fontSize) || 16;
    const textWidthPx = estimateTextWidthEm(runText) * fontSizePx;
    const laneWidthPx = laneWidth || scrollEl?.clientWidth || laneEl.clientWidth;
    const distancePx = textWidthPx + laneWidthPx;
    shiftPx = -distancePx;
    durationS = Math.max(MIN_DURATION_S, distancePx / (CHARS_PER_SECOND * fontSizePx));
  });

  // reduced-motion のページ分割 (幅フィット静止ページ、§5)。全文が 1 レーン幅を超えても切れないよう再分割。
  // laneWidth (ResizeObserver 追従) を読むので幅変更で再計算される (Medium 4)
  const pages = $derived.by(() => {
    if (!reducedMotion || job == null) return [runText];
    const fontSizePx = lineEl != null ? parseFloat(getComputedStyle(lineEl).fontSize) || 16 : 16;
    return pageSplit(runText, pageCharsForWidth(laneWidth, fontSizePx));
  });

  // prefers-reduced-motion を購読する (matchMedia 未実装環境はスキップ、既存パターン踏襲)
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

  // reduced-motion: CSS アニメが止まり animationend が発火しないので、ページ静止送りをタイマー駆動する。
  // 全ページ送り終えたら親へ「セグメント完了」を通知 (ページ送りは止めない = 1 枚固定禁止、§5)
  $effect(() => {
    void generation;
    void pageIndex;
    if (!reducedMotion || job == null || phase !== "running") return;
    const pageList = pages;
    const pageChars = Array.from(pageList[pageIndex] ?? "").length;
    const holdS = Math.max(MIN_HOLD_S, pageChars / CHARS_PER_SECOND);
    const timer = setTimeout(() => {
      if (pageIndex < pageList.length - 1) pageIndex += 1;
      else onScrollEnd(generation);
    }, holdS * 1000);
    return () => clearTimeout(timer);
  });

  // 通常フェード開始時、現要素の走行位置 (computed transform) を inline で固定し、opacity だけ
  // フェードさせる (行頭へのジャンプを防ぐ、Medium 5/再修正 Medium 2)。移動距離に % を使わない錨は維持。
  // **$effect.pre** で DOM 更新前 = class:fading 適用前に捕捉する: 通常の $effect は DOM 反映後に
  // 走るため animation-name が既に ticker-fade-out へ変わり scroll が解除され、getComputedStyle は
  // 基底位置 (走行前) を返してしまう。pre なら要素はまだ ticker-scroll 走行中でライブの transform が取れる
  // 通常フェード開始時: 走行位置を inline 固定 + 実測栞を親へ通知 (§2-2)。
  $effect.pre(() => {
    if (phase !== "fading" || reducedMotion || lineEl == null || scrollEl == null) return;
    // 捕捉は fade 1 サイクル (= generation) に 1 回だけ。onBookmarkCapture は cloneState で毎回新
    // scheduler 参照を返すため、無条件に呼ぶと値が不変でも親再描画→pre-effect 再走の read/write
    // サイクルになり effect_update_depth_exceeded で凍結する (§2-2/§4-4)。transform は fade 開始時に
    // 凍結され以降 opacity のみ変化するので 1 回で足りる。generation は onFadeComplete で必ず +1 される
    // ので次の fade は再捕捉される。
    if (fadeCapturedGen === generation) return;
    fadeCapturedGen = generation;
    const tx = readTranslateX(lineEl);
    if (tx != null) lineEl.style.transform = `translate(${tx}px, -50%)`;
    const measured = tx != null ? lastPassedBookmark(bookmarkHolder.els, tx, scrollEl.clientWidth, segmentIndex) : null;
    if (measured == null) {
      onBookmarkCapture(generation, segmentIndex, false);
      return;
    }
    const nearBoundary = isNearNextBookmark(bookmarkHolder.els, measured, segmentIndex, tx, scrollEl.clientWidth);
    onBookmarkCapture(generation, measured, nearBoundary);
  });

  // 次の栞まで BOUNDARY_GUARD_PX 未満かを実測する (§2-2)
  function isNearNextBookmark(
    bookmarks: HTMLSpanElement[],
    measuredIndex: number,
    startIndex: number,
    tx: number,
    scrollWidth: number,
  ): boolean {
    const next = bookmarks[measuredIndex - startIndex + 1];
    const nextOffset = next?.offsetLeft;
    if (nextOffset == null || !Number.isFinite(nextOffset)) return false;
    return scrollWidth + nextOffset - -tx < BOUNDARY_GUARD_PX;
  }

  // reduced-motion のフェードは 0ms 瞬時差替え (§5)。animationend が来ないので microtask で親へ通知。
  // 登録時の generation を捕捉する (遅延実行で prop が変わっても発火要素の世代で判定、Critical 3)。
  // 二重発火は親の completedGeneration ガードが吸収する
  $effect(() => {
    if (job == null || phase !== "fading" || !reducedMotion) return;
    const firedGeneration = generation;
    queueMicrotask(() => onFadeEnd(firedGeneration));
  });

  function onAnimEnd(e: AnimationEvent): void {
    // 世代ガードの真実源は「発火した要素の data-generation」(現在の reactive prop ではない、Critical 3)。
    // フェードで作り直された古い要素の遅延 animationend が新世代値でガードを通過するのを防ぐ
    const el = e.currentTarget as HTMLElement | null;
    const attr = el?.dataset.generation;
    const firedGeneration = attr != null ? Number(attr) : generation;
    // animationName で分岐 (§4-4-1)。名前が一致しないイベント (fade-in など) は無視。
    // Svelte はローカル @keyframes 名をコンポーネントスコープでリネームする (`svelte-<hash>-ticker-scroll`)
    // ので、実行時の AnimationEvent.animationName はスコープ prefix 付きになる。完全一致だと実ブラウザで
    // 常に外れて onScrollEnd/onFadeEnd が発火せず走行が 1 回で凍結するため、suffix で判定する
    const name = e.animationName;
    if (name.endsWith("ticker-fade-out")) {
      onFadeEnd(firedGeneration);
    } else if (name.endsWith("ticker-scroll")) {
      onScrollEnd(firedGeneration);
    }
  }

  // reduced-motion の現ページを「素片/強調片」の列にする (backlog §3、レビュー F3)。走行モードと同じ
  // font-weight 強調を静止ページでも効かせる。runText = segments を SEG_JOIN で連結した文字列、pages は
  // それを pageSplit した単純な連結スライスなので、segmentEmphasis (segment ローカル座標) を
  //   ① run 相対座標へ持ち上げ (前 segment 長 + SEG_JOIN を積む)
  //   ② 現ページ範囲 [pageStart, pageEnd) と交差させ、ページローカル座標へ落とす
  // で写像できる。本文は JMA 電文由来の BMP 文字のみ (絵文字なし) を前提に code unit 長で計算する
  // (走行モードの栞描画・pageSplit と同じ前提)。無強調時は 1 素片 = 従来の displayText と等価。
  const reducedParts = $derived.by((): Array<{ text: string; emph: boolean }> => {
    if (!reducedMotion || job == null) return [];
    const pageList = pages;
    const idx = Math.min(pageIndex, pageList.length - 1);
    const pageText = pageList[idx] ?? "";
    const slice = job.segments.slice(segmentIndex, runEnd);
    const runEmph: EmphasisSpan[] = [];
    let offset = 0;
    for (let r = 0; r < slice.length; r++) {
      for (const rg of job.segmentEmphasis[segmentIndex + r] ?? []) {
        runEmph.push({ start: offset + rg.start, end: offset + rg.end });
      }
      offset += slice[r]!.length;
      if (r < slice.length - 1) offset += SEG_JOIN.length;
    }
    let pageStart = 0;
    for (let i = 0; i < idx; i++) pageStart += (pageList[i] ?? "").length;
    const pageEnd = pageStart + pageText.length;
    const local: EmphasisSpan[] = [];
    for (const s of runEmph) {
      const start = Math.max(s.start, pageStart);
      const end = Math.min(s.end, pageEnd);
      if (end > start) local.push({ start: start - pageStart, end: end - pageStart });
    }
    return splitEmphasis(pageText, local);
  });
</script>

<div
  class="ticker-lane"
  class:dim
  data-emphasis={emphasis}
  style={job != null ? `--tk-c: var(--role-${job.role});` : undefined}
  bind:this={laneEl}
>
  {#if shownChip != null}
    <div class="ticker-label-slot">
      {#key chipKey}
        <div
          class="ticker-label role-{shownChip.role}"
          data-alert={shownChip != null && isAlertRole(shownChip.role) ? "" : undefined}
          style={chipTokens != null ? `--chip-container: ${chipTokens.container}; --chip-on: ${chipTokens.on};` : ""}
          transition:fade|global={{ duration: reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS, easing: springEffectsOut }}
        ><span class="ticker-label-category">{shownChip.category}</span>{#if shownChip.subject != null && shownChip.subject.length > 0}<span class="ticker-label-subject">{shownChip.subject}</span>{/if}{#if showRevisionBadge}<span class="ticker-label-revision">続報</span>{/if}</div>
      {/key}
    </div>
  {/if}
  {#if job != null}
    <div class="ticker-scroll" class:no-mask={reducedMotion} bind:this={scrollEl}>
      {#key generation}
        <div
          bind:this={lineEl}
          class="ticker-line role-{job.role}"
          class:fading={phase === "fading"}
          class:reduced={reducedMotion}
          class:solid={job.surface === "solid"}
          data-generation={generation}
          data-priority={job.priority}
          data-alert={isAlertRole(job.role) ? "" : undefined}
          style={`--scroll-dur: ${durationS}s; --ticker-shift: ${shiftPx}px;${surfaceTokens != null ? ` --ticker-surface-container: ${surfaceTokens.container}; --ticker-surface-on: ${surfaceTokens.on};` : ""}`}
          onanimationend={onAnimEnd}
        >
          {#if reducedMotion}
            {#each reducedParts as part}{#if part.emph}<span class="ticker-emph">{part.text}</span>{:else}{part.text}{/if}{/each}
          {:else}
            {#each job.segments.slice(segmentIndex, runEnd) as segment, relativeIndex}
              <span class="ticker-bookmark" data-bookmark={segmentIndex + relativeIndex} bind:this={bookmarkHolder.els[relativeIndex]}>{#each splitEmphasis(segment, job.segmentEmphasis[segmentIndex + relativeIndex] ?? []) as part}{#if part.emph}<span class="ticker-emph">{part.text}</span>{:else}{part.text}{/if}{/each}</span>{#if relativeIndex < runEnd - segmentIndex - 1}{SEG_JOIN}{/if}
            {/each}
          {/if}
        </div>
      {/key}
    </div>
  {/if}
</div>

<style>
  .ticker-lane {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
    align-items: stretch;
  }
  /* チップの外枠スロット。flex item はこちらが担い、内側は grid の単一セルにする。{#key} で
     入替わる旧/新チップを同じセル (grid-area 1/1) に重ね、cross-fade 中の横並び・幅潰れを防ぐ
     (TsunamiPanel の .page-fade 重ねクロスフェードと同じ設計) */
  .ticker-label-slot {
    flex: 0 0 auto;
    display: grid;
    align-items: stretch;
  }
  .ticker-label {
    grid-area: 1 / 1; /* slot の単一セルに重ねる (cross-fade overlap) */
    display: flex;
    align-items: center;
    padding: 0 var(--ticker-label-pad) 0 0.9em;
    margin: 4px var(--ticker-label-margin) 4px 8px;
    font-size: 0.72em;
    font-weight: var(--type-label-weight-emphasized);
    white-space: nowrap;
    /* Spec C §3-1: 意味色 container 文法。値は resolveChipTokens がインライン --chip-* で供給。
       dim 規則 (下) が background/color を color-mix で上書きできるよう、直値インラインにしない。
       下端 band 帯は目視フィードバック (2026-07-11「ストライプが派手」) により削除。
       意味シグナルは role 色の container 面自体が担う */
    /* rendered トークン: 件名仕切り・続報バッジは生の --chip-* ではなくこれを参照する。
       dim 規則がこれを減光後の値へ差し替えることで、仕切り・バッジも面と同率で沈む (最終レビュー finding 5) */
    --chip-on-rendered: var(--chip-on);
    --chip-container-rendered: var(--chip-container);
    background: var(--chip-container);
    color: var(--chip-on);
    border-radius: var(--radius-s);
    box-shadow: var(--ticker-label-shadow);
    z-index: 1;
  }
  /* Spec C §3-2: 種別 (emphasized) + 件名 (regular)。件名は極細の縦仕切りで区切り、
     長文はチップ幅を暴走させないよう省略する (走行域を圧迫しない)。span は A 由来 */
  .ticker-label-category {
    font-weight: var(--type-label-weight-emphasized);
  }
  .ticker-label-subject {
    margin-left: 0.5em;
    padding-left: 0.5em;
    border-left: 1px solid color-mix(in srgb, var(--chip-on-rendered) 30%, transparent);
    font-weight: var(--type-label-weight);
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ticker-scroll {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 1.25em,
      #000 calc(100% - 1.25em),
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 1.25em,
      #000 calc(100% - 1.25em),
      transparent 100%
    );
  }
  /* reduced-motion は静止ページ表示なので左右マスクを外す (両端の文字が薄れて読みにくいのを防ぐ、Medium 4) */
  .ticker-scroll.no-mask {
    -webkit-mask-image: none;
    mask-image: none;
  }
  /* 走行 (running): 右端から流し、入場を短くフェードイン。fade-in の animationend は
     animationName ガードで無視されるので二重 advance しない (§4-4) */
  .ticker-line {
    position: absolute;
    top: 50%;
    left: 100%;
    transform: translate(0, -50%);
    white-space: nowrap;
    opacity: 1;
    font-variant-numeric: tabular-nums;
    /* scroll の尺は inline の --scroll-dur (実測から算出) で渡す。fade-in は固定 150ms。
       fade-in の animationend は onAnimEnd の animationName ガードで無視される (§4-4) */
    animation-name: ticker-scroll, ticker-fade-in;
    animation-duration: var(--scroll-dur, 8s), 150ms;
    animation-timing-function: linear, ease-out;
    animation-iteration-count: 1, 1;
    animation-fill-mode: forwards, both;
  }
  /* 割込み退避 (fading): 走行位置はそのまま (JS が inline transform で固定、Medium 5)、opacity だけ
     150ms でフェードアウト。position:static へ切替えないので行頭ジャンプしない。完了後は要素破棄で
     opacity:1 の単層に戻る (減光として残さない、§10)。dim 乗算事故を避けるためライフサイクル内に閉じる */
  .ticker-line.fading {
    animation-name: ticker-fade-out;
    animation-duration: 150ms;
    animation-timing-function: ease-in;
    animation-fill-mode: forwards;
  }
  /* 連続走行の栞 (span)。offsetLeft 実測の起点になる。行は white-space:nowrap なので inline のまま並ぶ */
  .ticker-bookmark {
    display: inline;
  }
  /* backlog §3: 情報系 (low) 本文の重要語句 (数値+単位) をウェイト増**のみ**で強調する。
     色替え・点滅はしない (severity 色体系・帯色と干渉させないため)。サーバは low 優先の tickerEmphasis
     だけを載せるので、この span は low 走行文字 (基底 regular) の中でだけ現れ、bold へ 1 段上げる。
     inline のまま並べ、栞 span の offsetLeft 実測に影響しない (色は --tk-c を継承)。 */
  .ticker-emph {
    display: inline;
    font-weight: var(--type-weight-bold);
  }
  /* Spec C §5: 優先度でウェイト段階化 (low=regular / mid=medium / high=bold)。
     走行文字の数字は tabular-nums で等幅に揃える (M7.1 / 最大震度6弱 / 09:17) */
  .ticker-line[data-priority="low"] { font-weight: var(--type-weight-regular); }
  .ticker-line[data-priority="mid"] { font-weight: var(--type-weight-medium); }
  .ticker-line[data-priority="high"] { font-weight: var(--type-weight-bold); }
  /* reduced-motion: 静止ページ表示 (JS タイマーで送る)。scroll/fade アニメは無効化 */
  .ticker-line.reduced {
    position: static;
    top: auto;
    left: auto;
    transform: none;
    display: flex;
    align-items: center;
    height: 100%;
    animation: none;
  }
  @keyframes ticker-scroll {
    from {
      transform: translate(0, -50%);
    }
    to {
      transform: translate(var(--ticker-shift, -200vw), -50%);
    }
  }
  @keyframes ticker-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes ticker-fade-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ticker-line {
      position: static;
      top: auto;
      left: auto;
      transform: none;
      display: flex;
      align-items: center;
      height: 100%;
      animation: none;
    }
  }

  /* 走行文字は role 色 (--tk-c) 直。チップは container 文法 (--chip-on 文字 + --chip-container 面) */
  .ticker-line {
    color: var(--tk-c);
    /* dim on/off をゆっくり暗転/明転させ、待機画面の他要素と体感を揃える。待機画面 .standby は
       `--dur-standby-dim` (StandbyScreen.svelte) を共有し、同じ dim 同期契約に合わせる。
       opacity には**付けない** (テロップ自身の fade-in/out opacity アニメと干渉するため)。
       色ブレンドの遷移なので color / background-color / box-shadow のみを対象にする。
       background-color は大津波警報の反転面 (.role-tsunamiMajor、下) の dim 明転/暗転用。
       他 role は面が透明なので何も動かない。reduced-motion の `.ticker-line { transition: none }`
       (下) が同セレクタ・同詳細度で後勝ちに打ち消すので、この面遷移も reduced-motion で瞬時化される。 */
    transition: color var(--dur-standby-dim) ease, background-color var(--dur-standby-dim) ease;
  }
  .ticker-label {
    transition: color var(--dur-standby-dim) ease, background-color var(--dur-standby-dim) ease, box-shadow var(--dur-standby-dim) ease;
  }
  /* dim: 文字・チップの減光は color-mix 35% (待機画面 dim 実効 ~0.35 と同率)。opacity は使わない */
  .ticker-lane.dim .ticker-line {
    color: color-mix(in srgb, var(--tk-c) 35%, var(--bg));
  }
  .ticker-lane.dim .ticker-label {
    /* rendered トークンも減光後の値へ差し替える。件名仕切り・続報バッジがこれを参照するので、
       面 (35%) と同率で沈み、dim でそこだけ明るく浮く問題を塞ぐ (最終レビュー finding 5) */
    --chip-on-rendered: color-mix(in srgb, var(--chip-on) 35%, var(--bg));
    --chip-container-rendered: color-mix(in srgb, var(--chip-container) 35%, var(--bg));
    background: color-mix(in srgb, var(--chip-container) 35%, var(--bg));
    color: color-mix(in srgb, var(--chip-on) 35%, var(--bg));
    box-shadow: none;
  }
  /* engine が surface=solid と明示した本文だけに role 由来の container/on 面を敷く。
     tsunamiMajor は resolveChipTokens により既存 header token を使うので、従来の紫面を保つ。 */
  .ticker-line.solid {
    background: var(--ticker-surface-container);
    color: var(--ticker-surface-on);
    padding: 0 0.3em;
    border-radius: var(--radius-s);
  }
  /* dim: 面・文字とも header ペアを color-mix 35% で最暗面へ沈める (明点として残さない、§10)。
     基底 dim (.ticker-lane.dim .ticker-line) は --tk-c を混ぜるが、反転表示は header ペアを使うので
     こちらで混ぜ直す。詳細度 (0,3,0) が基底 dim (0,2,0) に勝つため面・文字とも確実に上書きされる。
     high tint (レーン面) との共存: これは走行文字自身の面なのでレーン面 tint と別レイヤに乗る。 */
  .ticker-lane.dim .ticker-line.solid {
    background: color-mix(in srgb, var(--ticker-surface-container) 35%, var(--bg));
    color: color-mix(in srgb, var(--ticker-surface-on) 35%, var(--bg));
  }
  /* spec D5 可読性フロア: 警報級 (意味重大度) の走行本文・チップは dim の 35% 混色から除外して
     素の色を保つ。「夜でも警報は光る」の基底ガード。判定は data-alert (lib/alert-roles.ts が真実源)。
     レーン面の 60% 減光はそのまま = 面が沈むぶん文字コントラストはむしろ上がる。監査は
     generate-design-docs.mjs cat9/11/14 が同じ契約を写し、番兵として常時検証する */
  .ticker-lane.dim .ticker-line[data-alert] {
    color: var(--tk-c);
  }
  .ticker-lane.dim .ticker-label[data-alert] {
    --chip-on-rendered: var(--chip-on);
    --chip-container-rendered: var(--chip-container);
    background: var(--chip-container);
    color: var(--chip-on);
  }
  .ticker-lane.dim .ticker-line.solid[data-alert] {
    background: var(--ticker-surface-container);
    color: var(--ticker-surface-on);
  }
  /* reduced-motion は dim も瞬時に切替える (既存の reduced-motion 方針に従う)。**基底 transition 規則
     より後**に置くこと: 同一詳細度なのでソース順で後勝ち。前に置くと基底 0.6s に上書きされて効かない */
  @media (prefers-reduced-motion: reduce) {
    .ticker-line,
    .ticker-label {
      transition: none;
    }
  }

  /* Spec C §2/§4: レーン面。基底面色 (surface-low) を明示的に持たせる (これが無いと normal lane の
     computed background-color が透明になり Task 7 の computed style 確認と不整合、R1-5)。加えて面色の
     変化 (dim / high tint) をアニメーションさせる transition を .ticker-lane 自体に**新設**する
     (現行は line/label にしか transition が無い、R1-6)。opacity には付けない */
  .ticker-lane {
    background: var(--surface-low);
    transition: background-color var(--dur-standby-dim) ease;
  }
  /* §4-2: high 割込み走行中のレーンだけ面へ role 色を薄く混ぜる (点滅しない)。
     --tk-c はレーンルート <div> の inline style (job.role → var(--role-*)) が供給する。
     CSS custom property は子 (.role-*) から親へ伝播しないため、high tint / dim×high
     (--lane-surface 経由) を親レーンで計算するにはルート自身が --tk-c を持つ必要がある */
  .ticker-lane[data-emphasis="high"] {
    --lane-surface: color-mix(in srgb, var(--tk-c) 12%, var(--surface-low));
    background: var(--lane-surface);
  }
  /* §4-3: high 中は走行文字を 1 段底上げ (bold→heavy)。走行文字は .ticker-bookmark span が
     自前 font-weight を持たず .ticker-line から継承するのでこの規則が効く */
  .ticker-lane[data-emphasis="high"] .ticker-line {
    font-weight: var(--type-weight-heavy);
  }
  /* §4-3: high 中はチップ子 span も 1 段底上げ (種別/続報 semibold→bold、件名 regular→medium)。
     子 span は自前の明示 font-weight を持つため、親 .ticker-label への指定は継承経由で負ける。
     各 span を直接指す (詳細度 0,3,0 > span 素の 0,1,0) 規則で上書きする */
  .ticker-lane[data-emphasis="high"] .ticker-label-category {
    font-weight: var(--type-weight-bold);
  }
  .ticker-lane[data-emphasis="high"] .ticker-label-subject {
    font-weight: var(--type-weight-medium);
  }
  .ticker-lane[data-emphasis="high"] .ticker-label-revision {
    font-weight: var(--type-weight-bold);
  }
  /* §4-4: dim。**high 規則より後**に置く。レーン面の dim 減衰 60% は、文字・チップの 35% とは別 locus。
     high 中は緊急なので通常 dim より色を残す (夜間でも見える) */
  .ticker-lane.dim {
    background: color-mix(in srgb, var(--surface-low) 60%, var(--bg));
  }
  .ticker-lane.dim[data-emphasis="high"] {
    background: color-mix(in srgb, var(--lane-surface) 60%, var(--bg));
  }
  /* reduced-motion: lane 面の transition も止める。**基底 .ticker-lane より後**に置く (R1-6 の穴を塞ぐ) */
  @media (prefers-reduced-motion: reduce) {
    .ticker-lane {
      transition: none;
    }
  }
  /* §3-3: 続報バッジ。container より一段明るい同系面の小 pill。点滅しない。span は Step 4 で C が追加 */
  .ticker-label-revision {
    margin-left: 0.5em;
    padding: 0.05em 0.5em;
    font-size: var(--type-label-xs-size);
    font-weight: var(--type-label-weight-emphasized);
    background: color-mix(in srgb, var(--chip-on-rendered) 18%, var(--chip-container-rendered));
    color: var(--chip-on-rendered);
    border-radius: var(--radius-full);
  }

  .role-critical { --tk-c: var(--role-critical); }
  .role-warning { --tk-c: var(--role-warning); }
  .role-normal { --tk-c: var(--role-normal); }
  .role-info { --tk-c: var(--role-info); }
  .role-cancel { --tk-c: var(--role-cancel); }
  .role-eewWarning { --tk-c: var(--role-eewWarning); }
  .role-eewForecast { --tk-c: var(--role-eewForecast); }
  .role-tsunamiMajor { --tk-c: var(--role-tsunamiMajor); }
  .role-tsunamiWarning { --tk-c: var(--role-tsunamiWarning); }
  .role-tsunamiAdvisory { --tk-c: var(--role-tsunamiAdvisory); }
  .role-quakeMajor { --tk-c: var(--role-quakeMajor); }
  .role-weatherEmergency { --tk-c: var(--role-weatherEmergency); }
  .role-weatherWarning { --tk-c: var(--role-weatherWarning); }
  .role-weatherAdvisory { --tk-c: var(--role-weatherAdvisory); }
  .role-connectionOk { --tk-c: var(--role-connectionOk); }
  .role-connectionStale { --tk-c: var(--role-connectionStale); }
  .role-muted { --tk-c: var(--role-muted); }
</style>
