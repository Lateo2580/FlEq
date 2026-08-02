<script lang="ts">
  import type { DisplayLargeQuakeInputV1, DisplayQuakeMapEventV1 } from "../lib/protocol";
  import { formatHm, formatMdHm, formatIntShort } from "../lib/format";
  import { formatMagnitudeLabel, isNumericMagnitude } from "../lib/magnitude";
  import { groupByPrefecture } from "../lib/prefecture-group";
  import {
    PAGE_CITY_BUDGET,
    cityBudgetFromArea,
    effectiveAreaCount,
    paginateAreas,
    shouldPageDetails,
  } from "../lib/instrument-layout";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { measureHeight } from "../lib/measure-height";
  import { SPRING_EFFECTS_DEFAULT_MS, SPRING_SPATIAL_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { revealScaleIn, heightReveal } from "../lib/transitions";
  import { fade } from "svelte/transition";
  import { onDestroy } from "svelte";
  import PageDots from "./PageDots.svelte";
  import QuakeMap from "./QuakeMap.svelte";
  import { intensityVisual } from "../lib/quake-map-colors";

  // compact: main-stack の非 main スロット (EewPanel と同じ縮小パターンを適用し、
  // emergency-3 等で tile-main + tile-stats + 震度別グループが縦に収まりきらず
  // 見切れる問題を解消する)
  // layoutSettling: 緊急画面のレイアウト遷移中 (グリッド track 補間中) は EmergencyScreen から
  // true が渡る。遷移中は本文領域の実測が過渡値になり再ページングが暴れるため、測定反映を保留する (spec §4)。
  let {
    input,
    mapEvent = null,
    compact = false,
    layoutSettling = false,
  }: {
    input: DisplayLargeQuakeInputV1;
    mapEvent?: DisplayQuakeMapEventV1 | null;
    compact?: boolean;
    layoutSettling?: boolean;
  } = $props();

  const hasChips = $derived(input.tsunamiWarning || input.originTime != null);
  const originTimeLabel = $derived(input.originTime == null ? "-" : compact ? formatHm(input.originTime) : formatMdHm(input.originTime));

  // 生成時キー snapshot (spec §0-d / §2-c 最終改稿 1): 初期に存在する個別要素を素の const で
  // 捕まえる。行全体の bool ではなく要素ごとのキーで持つ (初期に origin チップだけ在り後から
  // tsunami チップが増えるケースを識別するため)。初期から在る要素は revealScaleIn の reveal=false
  // で演出なし・frame-1 可視、初期 snapshot に無い後発要素だけ reveal=true にする。
  // svelte-ignore state_referenced_locally -- 意図的に生成時の値を捕まえる非リアクティブ snapshot (spec §0-d)
  const initialHasLgInt = input.maxLgInt != null;
  // svelte-ignore state_referenced_locally -- 同上 (個別チップキーの生成時 snapshot、最終改稿 1)
  const initialElementKeys = new Set<string>([
    ...(input.tsunamiWarning ? ["chip:tsunami"] : []),
    ...(input.originTime != null ? ["chip:origin"] : []),
  ]);
  // chip-row の heightReveal は「初期に行が無く、最初のチップが後発した場合」だけ (行が既にあって
  // 2 つ目のチップが増えるケースは行の高さが変わらないので個別チップの scale のみ、spec §2-c)
  const chipRowInitiallyAbsent =
    !initialElementKeys.has("chip:tsunami") && !initialElementKeys.has("chip:origin");

  // 全グループ合計の実効件数。静的リスト ⇔ 詳細ページングの切替判定に使う (spec §4 決定表)
  const displayGroups = $derived(input.intensityGroups.filter((group) =>
    intensityVisual(group.intensitySemantic, formatIntShort(group.intensity), group.rank).render
  ));
  const totalEffective = $derived(
    displayGroups.reduce((sum, g) => sum + effectiveAreaCount(g), 0),
  );
  const paging = $derived(shouldPageDetails(totalEffective));

  // ページ本文領域の実測高さ・行高から市町村数バジェットを導出する (T5c、spec §2-c「画面高さ
  // 駆動の可変」)。未マウント・実測0 (jsdom 含む) のときは PAGE_CITY_BUDGET と同値の fallback
  // に落ちる (cityBudgetFromArea 内部で保証、既存テストの回帰対策)
  let pageBodyAreaHeight = $state(0);
  let pageBodyLineHeight = $state(0);
  const cityBudget = $derived(cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET));

  // レイアウト遷移中 (layoutSettling) の測定は最新 1 件だけ保持し、完了時に一度だけ反映する (spec §4)。
  // 途中で逆方向へ遷移しても最新 target に合流する (pending は上書き)。reduced-motion では
  // layoutSettling が常に false になり同期反映になる (EmergencyScreen が settling を立てない)。
  let pendingArea: number | null = null;
  let pendingLine: number | null = null;
  function applyPageBodyArea(h: number): void {
    if (layoutSettling) pendingArea = h;
    else pageBodyAreaHeight = h;
  }
  function applyPageBodyLine(h: number): void {
    if (layoutSettling) pendingLine = h;
    else pageBodyLineHeight = h;
  }
  $effect(() => {
    if (layoutSettling) return;
    if (pendingArea != null) {
      pageBodyAreaHeight = pendingArea;
      pendingArea = null;
    }
    if (pendingLine != null) {
      pageBodyLineHeight = pendingLine;
      pendingLine = null;
    }
  });

  // 詳細ページ配列 (県単位、paging=false のときは空)。旧「1/4」(グループ内番号) の文字表示は
  // T8① でドットインジケータ (PageDots) に撤去済み。ドット列のグループ境界 gap 機能は
  // preview 目視レビューで「間隔が不揃いに見える」と不評だったため T8⑤ で撤去し、pageGroupMeta
  // ベースの境界計算も不要になった (削除済み)
  const pages = $derived(paging ? paginateAreas(displayGroups, cityBudget, { allowCrossIntensity: true }) : []);

  // 別イベント (eventId 変化) か、同一イベントの続報で severityTier (地震は最大震度 rank) が
  // 「上昇」したときにページを先頭に戻す。下降・同値ではリセットしない (spec §3、Codex R
  // レビュー M2)。$derived ではなく変化検知の $effect + $state カウンタで単調増加させる
  // (resetKey に同一値の再代入を渡してもリセットされない page-cycler の契約に合わせる)
  const identityKey = $derived(input.eventId ?? `${input.hypocenterName ?? ""}:${input.originTime ?? ""}`);
  let resetSeq = $state(0);
  let prevIdentityKey: string | null = null;
  let prevMaxIntRank = -1;
  $effect(() => {
    const key = identityKey;
    const rank = input.maxIntRank;
    if (prevIdentityKey != null && (key !== prevIdentityKey || rank > prevMaxIntRank)) {
      resetSeq += 1;
    }
    prevIdentityKey = key;
    prevMaxIntRank = rank;
  });

  const cycler = createPageCycler({
    pageCount: () => pages.length,
    resetKey: () => resetSeq,
  });
  // unmount (main-stack のモード切替・panel 差替え) で $effect.root のタイマー/matchMedia
  // リスナーがリークしないよう、コンポーネント破棄時に必ず destroy() する (Codex R レビュー M1)
  onDestroy(() => cycler.destroy());

  // paging=true なら pages.length>0 が保証される (shouldPageDetails は intensityGroups が
  // 空でない前提でしか true にならない) ため、範囲外 fallback は pages[0] へ (null 経由の
  // 1 フレーム空表示を避ける)
  const currentPage = $derived(pages[cycler.index] ?? pages[0] ?? null);
  const showMap = $derived(!compact && mapEvent != null);
  const maxVisual = $derived(intensityVisual(input.maxIntSemantic, formatIntShort(input.maxInt), input.maxIntRank));
  const maxSeverityRank = $derived(input.maxIntSemantic == null ? input.maxIntRank : input.maxIntSemantic.safetyRank);

  function groupVisual(intensity: string, rank: number) {
    const group = displayGroups.find((item) => item.intensity === intensity && item.rank === rank);
    return intensityVisual(group?.intensitySemantic, formatIntShort(intensity), rank);
  }
</script>

<div class="quake-panel role-quakeMajor" class:compact>
  <div class="heading" class:critical={(maxSeverityRank ?? 0) >= 7}>
    <span class="heading-text">地震情報</span>
  </div>
  <div class="tiles">
    <div class="tile tile-main">
      <div class="hypocenter">{input.hypocenterName ?? "震源調査中"}</div>
      {#if maxVisual.render}<div class="max-int" title={maxVisual.tooltip ?? undefined} aria-label={`最大${maxVisual.ariaLabel ?? "震度不明"}`}>最大震度{maxVisual.label ?? ""}{#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}</div>{/if}
      {#if hasChips}
        <div
          class="reveal-wrap chip-reveal-wrap"
          data-motion-reveal="height"
          in:heightReveal={{
            reveal: chipRowInitiallyAbsent && !cycler.reducedMotion,
            duration: SPRING_EFFECTS_DEFAULT_MS,
          }}
        >
          <div class="chip-row">
            {#if input.tsunamiWarning}
              <span
                class="chip tsunami-mark"
                data-motion-reveal="scale"
                in:revealScaleIn={{
                  reveal: !initialElementKeys.has("chip:tsunami") && !cycler.reducedMotion,
                  duration: SPRING_SPATIAL_DEFAULT_MS,
                }}>津波</span
              >
            {/if}
            {#if input.originTime != null}
              <span
                class="chip origin-time"
                data-motion-reveal="scale"
                in:revealScaleIn={{
                  reveal: !initialElementKeys.has("chip:origin") && !cycler.reducedMotion,
                  duration: SPRING_SPATIAL_DEFAULT_MS,
                }}>{originTimeLabel} 発生</span
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
    <div class="tile-stats">
      <div class="tile stat-tile">
        <span class="stat-label">{isNumericMagnitude(input.magnitude) ? "M" : "規模"}</span>
        <span class="stat-value">{input.magnitude != null ? (isNumericMagnitude(input.magnitude) ? input.magnitude : formatMagnitudeLabel(input.magnitude)) : "M不明"}</span>
      </div>
      {#if input.depth != null}
        <div class="tile stat-tile">
          <span class="stat-label">深さ</span>
          <span class="stat-value">{input.depth}</span>
        </div>
      {/if}
      {#if input.maxLgInt != null}
        <!-- 長周期は続報で後から現れる後発要素 (spec §2-c)。ただし横並び flex 行では M・深さ
             タイルが既に行高を確保しており、heightReveal は周囲を押し下げず「長周期だけ上から開く」
             不自然な動きになる (レビュー指摘 Medium 3)。行の高さは兄弟が固定するので scale のみへ縮退し、
             タイル自身に revealScaleIn を付ける (縦方向挿入のチップ行・津波行は heightReveal を維持)。 -->
        <div
          class="tile stat-tile"
          data-motion-reveal="scale"
          in:revealScaleIn={{
            reveal: !initialHasLgInt && !cycler.reducedMotion,
            duration: SPRING_SPATIAL_DEFAULT_MS,
          }}
        >
          <span class="stat-label">長周期</span>
          <span class="stat-value lg">{input.maxLgInt}</span>
        </div>
      {/if}
    </div>
    <div class="quake-detail" class:with-map={showMap}>
      {#if showMap && mapEvent != null}
        <div class="map-slot">
          <QuakeMap event={mapEvent} />
        </div>
      {/if}
      <div class="detail-text">
        {#if paging}
          {#if currentPage != null}
            <div class="tile tile-page-detail">
              {#key cycler.index}
                <div
                  class="page-fade"
                  transition:fade={{
                    duration: cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
                    easing: springEffectsOut,
                  }}
                >
                  <div class="page-header">
                    <span class="page-title">観測震度 詳細</span>
                    <PageDots total={cycler.total} current={cycler.index} onJump={(i) => cycler.jumpTo(i)} />
                  </div>
                  <div class="page-body" use:measureHeight={applyPageBodyArea}>
                    <span class="line-ruler" aria-hidden="true" use:measureHeight={applyPageBodyLine}
                      >測</span
                    >
                    {#each currentPage.sections as section (section.intensity)}
                      {@const visual = groupVisual(section.intensity, section.rank)}
                      <div class="page-section">
                        <span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
                        {#each section.prefGroups as pg (pg.pref ?? "その他")}
                          <div class="pref-group">
                            <span class="pref-name">{pg.pref ?? "その他"}{pg.continuation ? "（続き）" : ""}</span>
                            {#if pg.cities.length > 0}<span class="cities">{#each pg.cities as city (city)}<span class="city-name">{city}</span>{/each}</span>{/if}
                          </div>
                        {/each}
                      </div>
                    {/each}
                  </div>
                </div>
              {/key}
            </div>
          {/if}
        {:else if displayGroups.length > 0}
          <div class="tile tile-groups">
            <div class="groups">
              {#each displayGroups as g (g.intensity)}
                {@const visual = intensityVisual(g.intensitySemantic, formatIntShort(g.intensity), g.rank)}
                <div class="group">
                  <span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
                  <div class="group-pref-groups">
                    <!-- T7 回帰修正: 静的リストは spec §2-b の例 (「震度6強 宮崎市 日南市」) どおり
                         県プレフィックス無しの area (pref:null) はラベル無しで市名だけ出す。
                         ページング側 (currentPage.prefGroups、上の分岐) は「その他」ラベルを維持する
                         (原則3のラベル明示はページ側にだけ意味がある、レビュー指示) -->
                    {#each groupByPrefecture(g.areas) as pg (pg.pref ?? "その他")}
                      <div class="pref-group">
                        {#if pg.pref != null}<span class="pref-name">{pg.pref}</span>{/if}
                        {#if pg.cities.length > 0}
                          <span class="cities">
                            {#each pg.cities as city (city)}<span class="city-name">{city}</span>{/each}
                          </span>
                        {/if}
                      </div>
                    {/each}
                    {#if g.omittedAreaCount > 0}<span class="group-omitted">ほか{g.omittedAreaCount}地域</span>{/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .quake-panel {
    container-type: inline-size;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0;
    color: var(--fg);
    background: var(--surface-panel);
    border-radius: var(--radius-panel);
    box-shadow: var(--elevation-3);
    overflow: hidden;
  }
  .heading {
    box-sizing: border-box;
    min-height: calc(var(--panel-header-min-h) * var(--panel-scale, 1));
    display: flex;
    align-items: center;
    font-size: calc(var(--panel-header-font-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
    padding: calc(var(--panel-header-padding-v) * var(--panel-scale, 1))
      calc(var(--panel-header-padding-h) * var(--panel-scale, 1));
    background: var(--header-quakeWarning-container);
    color: var(--header-quakeWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeWarning);
  }
  .heading.critical {
    background: var(--header-quakeCritical-container);
    color: var(--header-quakeCritical-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeCritical);
  }
  .tiles {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
  }
  .tile-main {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .hypocenter {
    /* 地震情報は「確定情報の記録」で EEW ヒーロー (display-l) ほどの緊急性は不要。一段落とす */
    font-size: calc(var(--type-headline-l-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .max-int {
    margin-top: var(--space-2);
    font-size: calc(var(--type-headline-s-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    color: var(--role-quakeMajor);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
  }
  .chip {
    background: var(--surface-panel);
    border-radius: var(--radius-m);
    padding: 4px var(--space-3);
  }
  .tsunami-mark {
    color: var(--c-jma-red);
    font-weight: var(--type-title-weight-emphasized);
  }
  .origin-time {
    color: var(--role-muted);
  }
  /* 後発チップ行の高さ reveal wrapper (spec §2-c Medium 2): padding/border/margin 0。
     heightReveal は scrollHeight を CSS height に代入するため wrapper 側に padding/border/margin が
     あると height:0 で閉じ切らない (内側 padding は body 側)。overflow はアニメ中だけ heightReveal
     が出すので恒久 hidden は付けない (レビュー指摘 Medium 4、chip の shadow/overshoot 切断を避ける)。 */
  .reveal-wrap {
    padding: 0;
    border: 0;
    margin: 0;
  }
  .tile-stats {
    display: flex;
    flex-direction: row;
    gap: var(--space-3);
  }
  .stat-tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-4);
  }
  .stat-label {
    font-size: var(--type-label-m-size);
    color: var(--role-muted);
  }
  .stat-value {
    font-size: var(--type-headline-m-size);
    font-weight: var(--num-weight);
  }
  .stat-value.lg {
    color: var(--c-orange);
  }
  .tile-groups {
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-5);
  }
  .quake-detail {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .quake-detail.with-map {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.85fr);
    gap: var(--space-3);
  }
  .map-slot,
  .detail-text {
    min-width: 0;
    min-height: 0;
  }
  .detail-text {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .groups {
    height: 100%;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .groups::-webkit-scrollbar {
    display: none;
  }
  /* 詳細ページング (spec §3): 各ページに見出し・ページ位置を固定枠で常時表示する
     (原則3「任意の瞬間が単独で読める」)。ページ切替は旧ページ・新ページを重ねたクロスフェード
     (T5c、spec §3 再々改訂「チカチカする短いディップは撤回、重ねる」)。{#key cycler.index} で
     再マウントされる .page-fade は position:absolute で親 (.tile-page-detail、position:relative +
     flex:1 で実測される固定高さ) に重ねて配置する。outro (旧ページ) と intro (新ページ) が
     同時に走ることで空白を経由しない。減光ではなく入替表現なので opacity 禁じ手 (§8) には
     該当しない。フェード完了後は outro 側が DOM から破棄され単層 opacity:1 に戻る (Svelte 標準) */
  .tile-page-detail {
    position: relative;
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-5);
  }
  /* T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘、TsunamiPanel と同型)。
     position:absolute な .page-fade (inset:0) の containing block は「最も近い positioned
     祖先の padding box」(CSS 仕様上、border box ではなく padding box) になるため、.tile-page-detail
     自身の padding (position:relative の祖先と padding の宿主が同一要素) が実質無かったことに
     なっていた。同じ padding を .page-fade にも明示的に持たせて復元する。ここは pageBodyAreaHeight
     (.page-body を直接 measureHeight する、T5c) が capacity を出しているため、この padding は
     次回の ResizeObserver 実測で自動的に反映される (outer tile 近似を使う TsunamiPanel の
     coastRowCapacity のような明示補正定数は不要 — 直接測定なので自己整合する) */
  .page-fade {
    position: absolute;
    inset: 0;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .page-header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: calc(var(--type-label-m-size) * var(--panel-scale, 1));
  }
  .page-title {
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-muted);
  }
  .page-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
  }
  /* 実測用の隠しルーラー (T5c)。.page-body と同じ font-size を継承させ、1 行ぶんの実高さを
     ResizeObserver で読む (measureHeight action)。position:absolute で flex レイアウトから
     外し、表示にも読み上げにも影響させない */
  .line-ruler {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
  .group {
    display: flex;
    gap: 14px;
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
    /* 複数県にまたがり複数行になっても震度チップが縦に伸びないよう行頭固定 (第3波 Fix6) */
    align-items: flex-start;
  }
  /* 都道府県 → 市区町村の階層。WeatherAlertCard/LatestQuakeCard の pref-group 文法と揃える (第3波 Fix7) */
  .group-pref-groups {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pref-group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4em;
  }
  .pref-name {
    flex-shrink: 0;
    font-weight: var(--type-title-weight-emphasized);
    color: var(--fg);
  }
  /* 市区町村名は個別 span (white-space:nowrap) にし、折返しは名前と名前の間だけで発生させる。
     区切りは文字 (旧「・」) ではなく gap で表現する (第3波 Fix14)。.cities 自体は display:contents
     で flex アイテムから外し、city-name span を .pref-group の直接の子として扱わせる。
     inline-flex のままだと "ブロック単位で次行へ wrap" してしまい、市町村が多い県だけ県名直後で
     改行される不統一が起きていた (review-T5a-2 FIX-B)。常にインラインで自然折返しさせる */
  .cities {
    display: contents;
    color: var(--fg);
  }
  .city-name {
    white-space: nowrap;
  }
  .group-omitted {
    display: block;
    margin-top: 2px;
    color: var(--role-muted);
    font-size: 0.7em;
  }
  /* 待機画面 (RecentQuakes/LatestQuakeCard) と同じ int-chip 形式に統一する */
  .int-chip {
    flex-shrink: 0;
    min-width: 3.2em;
    max-width: 12em;
    text-align: center;
    padding: 2px 10px;
    border-radius: var(--radius-s);
    font-weight: var(--type-title-weight-emphasized);
    font-variant-numeric: tabular-nums;
    background: var(--surface-panel);
    overflow-wrap: anywhere;
  }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
  .int-r1 { color: var(--int-1); }
  .int-r2 { color: var(--int-2); }
  .int-r3 { color: var(--int-3); }
  .int-r4 { color: var(--int-4); }
  .int-r5 { color: var(--int-5); }
  .int-r6 { color: var(--int-6); }
  .int-r7 { color: var(--int-7); }
  .int-r8 {
    background: var(--int-8-bg);
    color: #000;
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: #fff;
  }
  .int-chip.special-unknown { color: var(--c-raspberry); border: 1px dashed currentColor; }
  .int-chip.special-empty { color: var(--role-muted); border: 1px dotted currentColor; }
  /* compact (main-stack 非 main スロット): ヒーロー部をさらに凝縮しリスト領域にカード高を
     渡す (第3波 Fix20)。震央名は headline-m(32px) → title-l(26px) へもう一段降格し、推定
     最大震度と近接2行にする。M/深さ/長周期の stat タイルは箱型をやめ、既存チップ文法
     (radius-full + surface) のインライン小チップ列へ置き換える */
  .quake-panel.compact .hypocenter {
    font-size: var(--type-title-l-size);
  }
  .quake-panel.compact .max-int {
    margin-top: 2px;
    font-size: var(--type-title-m-size);
  }
  .quake-panel.compact .chip-row {
    margin-top: 2px;
    gap: var(--space-1);
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .chip {
    padding: 1px var(--space-2);
  }
  .quake-panel.compact .tile-main {
    padding: var(--space-1) var(--space-2);
  }
  .quake-panel.compact .tile-stats {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .quake-panel.compact .stat-tile {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-1);
    padding: 1px 8px;
    border: none;
    box-shadow: none;
    border-radius: var(--radius-full);
    background: var(--surface-panel);
  }
  .quake-panel.compact .stat-value {
    font-size: var(--type-body-m-size);
  }
  .quake-panel.compact .origin-time {
    font-size: var(--type-body-m-size);
  }
  .quake-panel.compact .stat-label {
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .tiles {
    padding: var(--space-2) var(--space-3) var(--space-3);
    gap: var(--space-1);
  }
  .quake-panel.compact .tile-groups {
    padding: var(--space-1) var(--space-2);
    /* 静的リスト表示 (自動スクロールは撤去、原則5「動くものは読めたら補足まで」)。
       収まらない分はネイティブスクロール (.groups の overflow-y:auto、非アニメ) に委ねる */
    overflow: hidden;
  }
  .quake-panel.compact .groups {
    gap: var(--space-1);
  }
  .quake-panel.compact .group {
    font-size: var(--type-label-l-size);
    gap: var(--space-2);
  }
  .quake-panel.compact .tile-page-detail {
    padding: var(--space-1) var(--space-2);
    gap: var(--space-1);
  }
  /* 実効 padding は inset:0 の .page-fade 側が持つ (containing block = padding box のため祖先
     padding は absolute 子に効かない)。compact の縮小 padding も .page-fade へ追従させる */
  .quake-panel.compact .page-fade {
    padding: var(--space-1) var(--space-2);
  }
  .quake-panel.compact .page-header {
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .page-body {
    font-size: var(--type-label-l-size);
    gap: var(--space-1);
  }

  /* bento: 十分な幅があれば震度別グループを 2 カラムに流し込む */
  @container (min-width: 860px) {
    .groups {
      display: block;
      columns: 2;
      column-gap: var(--space-6);
    }
    .group {
      break-inside: avoid;
      margin-bottom: var(--space-3);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hypocenter,
    .max-int {
      transition: none;
    }
  }
</style>
