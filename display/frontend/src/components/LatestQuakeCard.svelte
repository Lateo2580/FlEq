<script lang="ts">
  import type { DisplayIntensityGroupV1, DisplayLatestQuakeStateV1 } from "../lib/protocol";
  import { formatMdHm, formatIntShort, formatDepth, splitNumberUnit } from "../lib/format";
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
  import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { fade } from "svelte/transition";
  import { onDestroy } from "svelte";
  import PageDots from "./PageDots.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  import NumberUnit from "./NumberUnit.svelte";

  let { quake, longPeriod = null }: { quake: DisplayLatestQuakeStateV1; longPeriod?: { maxLgInt: string; restored: boolean } | null } = $props();

  // 数値深さは「20km」の数値大・単位小で見せる。「ごく浅い」は数値ではないため通常テキスト。
  const formattedDepth = $derived(formatDepth(quake.depth));
  const depthParts = $derived(splitNumberUnit(formattedDepth));

  // 全グループ合計の実効件数。静的リスト ⇔ 詳細ページングの切替判定に使う (spec §4 決定表)。
  // ≤30 のときは topGroupCompact 相当の縮退分岐は実質発火しない (最大震度グループも ≤30 になる
  // ため) — 固定+スクロールの 2 領域構造はやめ、全グループを 1 本の静的リストで並べる
  const totalEffective = $derived(
    quake.intensityGroups.reduce((sum, g) => sum + effectiveAreaCount(g), 0),
  );
  const paging = $derived(shouldPageDetails(totalEffective));

  // ページ本文領域の実測高さ・行高から市町村数バジェットを導出する (T5c、spec §2-c 「LatestQuakeCard
  // は content 駆動なので先にカードへ高さ予算を与える」)。カードは height:100% の grid セルに
  // 属さない (待機画面上を流れる content-driven カード) ため、他パネルのように flex:1 で
  // 「残り画面高さ」を自然に受け取れない。旧 `min-height: calc(6 * 1.6em)` (6行ぶんの見積もり)
  // を「予算」として固定 height に格上げし、そこから実測 → rowCapacity → cityBudgetFromArea の
  // パイプラインに通す (先に予算を与えてから実測、スコープ §2-c 確定文言のとおり)。予算そのものは
  // 画面高さ非依存の固定値だが、font-size (--type-label-s-fluid) は fluid token で viewport 幅に
  // 応じて変わるため、行高実測 → バジェット換算の部分は viewport 変化に追従する
  let pageBodyAreaHeight = $state(0);
  let pageBodyLineHeight = $state(0);
  const cityBudget = $derived(cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET));

  // 詳細ページ配列 (県単位、paging=false のときは空)。旧「1/4」(グループ内番号) の文字表示は
  // T8① でドットインジケータ (PageDots) に撤去済み。ドット列のグループ境界 gap 機能は
  // preview 目視レビューで「間隔が不揃いに見える」と不評だったため T8⑤ で撤去し、pageGroupMeta
  // ベースの境界計算も不要になった (削除済み)
  const pages = $derived(paging ? paginateAreas(quake.intensityGroups, cityBudget, { allowCrossIntensity: true }) : []);

  // 別イベント (eventId 変化) か、同一イベントの続報で severityTier (地震は最大震度 rank) が
  // 「上昇」したときにページを先頭に戻す。下降・同値ではリセットしない (spec §3、Codex R
  // レビュー M2)
  const identityKey = $derived(quake.eventId ?? `${quake.hypocenterName ?? ""}:${quake.originTime ?? ""}`);
  let resetSeq = $state(0);
  let prevIdentityKey: string | null = null;
  let prevMaxIntRank = -1;
  $effect(() => {
    const key = identityKey;
    const rank = quake.maxIntRank ?? -1;
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
  // unmount (待機カードの流れ替え) で $effect.root のタイマー/matchMedia リスナーが
  // リークしないよう、コンポーネント破棄時に必ず destroy() する (Codex R レビュー M1)
  onDestroy(() => cycler.destroy());

  // paging=true なら pages.length>0 が保証される (shouldPageDetails は intensityGroups が
  // 空でない前提でしか true にならない) ため、範囲外 fallback は pages[0] へ (null 経由の
  // 1 フレーム空表示を避ける)
  const currentPage = $derived(pages[cycler.index] ?? pages[0] ?? null);
</script>

{#snippet groupItem(g: DisplayIntensityGroupV1)}
  <li>
    <span class="g-int int-r{g.rank}">震度{g.intensity}</span>
    <div class="g-pref-groups">
      <!-- T7 回帰修正: 静的リストは spec §2-b の例 (「震度6強 宮崎市 日南市」) どおり
           県プレフィックス無しの area (pref:null) はラベル無しで市名だけ出す。
           ページング側 (currentPage.prefGroups、下の分岐) は「その他」ラベルを維持する
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
      {#if g.omittedAreaCount > 0}<span class="g-omitted">ほか{g.omittedAreaCount}地域</span>{/if}
    </div>
  </li>
{/snippet}

<div class="quake-card">
  <div class="banner-header" class:critical={(quake.maxIntRank ?? 0) >= 7}>地震情報</div>
  <div class="card-body">
    <div class="summary-row">
      <span class="int-chip int-r{quake.maxIntRank ?? 0}">{formatIntShort(quake.maxInt)}</span>
      <span class="hypocenter">{quake.hypocenterName ?? "不明"}</span>
      {#if quake.tsunamiWarning}<span class="tsunami-mark">津波</span>{/if}
    </div>
    <div class="meta">
      <div class="stat">
        <span class="stat-label">規模</span>
        <span class="magnitude stat-value">{#if quake.magnitude != null}{#if isNumericMagnitude(quake.magnitude)}<NumberUnit prefix="M" value={quake.magnitude} />{:else}{formatMagnitudeLabel(quake.magnitude)}{/if}{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">深さ</span>
        <span class="depth stat-value">{#if formattedDepth === "ごく浅い"}{formattedDepth}{:else}<NumberUnit value={depthParts.value} unit={depthParts.unit} />{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">発生</span>
        <span class="time stat-value">{formatMdHm(quake.originTime ?? quake.reportDateTime)}</span>
      </div>
    </div>
    {#if longPeriod != null}<div class="long-period-rider">長周期地震動階級 {longPeriod.maxLgInt}{#if longPeriod.restored}<RestoredChip />{/if}</div>{/if}
    {#if quake.intensityGroups.length > 0}
      {#if paging}
        {#if currentPage != null}
          <div class="page-detail">
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
                <ul class="page-body" use:measureHeight={(h) => (pageBodyAreaHeight = h)}>
                  <li class="line-ruler" aria-hidden="true" use:measureHeight={(h) => (pageBodyLineHeight = h)}
                    >測</li
                  >
                  {#each currentPage.sections as section (section.intensity)}
                    <li class="page-section">
                      <span class="g-int int-r{section.rank}">震度{section.intensity}</span>
                      {#each section.prefGroups as pg (pg.pref ?? "その他")}
                        <div class="pref-group">
                          <span class="pref-name">{pg.pref ?? "その他"}{pg.continuation ? "（続き）" : ""}</span>
                          {#if pg.cities.length > 0}<span class="cities">{#each pg.cities as city (city)}<span class="city-name">{city}</span>{/each}</span>{/if}
                        </div>
                      {/each}
                    </li>
                  {/each}
                </ul>
              </div>
            {/key}
          </div>
        {/if}
      {:else}
        <ul class="groups">
          {#each quake.intensityGroups as g (g.intensity)}
            {@render groupItem(g)}
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</div>

<style>
  .quake-card {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-2);
    overflow: hidden;
    width: min(360px, 28vw);
    color: var(--fg);
  }
  /* 看板ヘッダ (D案標準): 意味色 container 背景 + 明るい同系文字 + 下端 CUD 色帯。津波/気象カード
     のようなローカル var 関数は起こさず、QuakePanel の .heading/.heading.critical と同じ二値
     クラス切替で書く (Codex 指示)。critical = maxIntRank>=7 (震度6弱以上、QuakePanel と同じ閾値) */
  .banner-header {
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    padding: 8px 16px;
    background: var(--header-quakeWarning-container);
    color: var(--header-quakeWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeWarning);
  }
  .banner-header.critical {
    background: var(--header-quakeCritical-container);
    color: var(--header-quakeCritical-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeCritical);
  }
  /* 看板ヘッダをカード端まで届かせるため、全周 padding はヘッダ配下の本文側に移した
     (津波/気象カードと同じ構造。旧 .quake-card 直付け padding だとヘッダが内側に浮いてしまう) */
  .card-body {
    padding: var(--space-3) var(--space-4);
  }
  .summary-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .int-chip {
    width: 2.6em;
    text-align: center;
    padding: 2px 6px;
    border-radius: var(--radius-s);
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
    background: var(--surface-panel-raised);
  }
  .int-r0 {
    color: var(--role-muted);
  }
  .int-r1 {
    color: var(--int-1);
  }
  .int-r2 {
    color: var(--int-2);
  }
  .int-r3 {
    color: var(--int-3);
  }
  .int-r4 {
    color: var(--int-4);
  }
  .int-r5 {
    color: var(--int-5);
  }
  .int-r6 {
    color: var(--int-6);
  }
  .int-r7 {
    color: var(--int-7);
  }
  .int-r8 {
    background: var(--int-8-bg);
    color: #000;
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: #fff;
  }
  .hypocenter {
    font-weight: var(--type-title-weight-emphasized);
    font-size: var(--type-title-s-fluid);
  }
  .tsunami-mark {
    color: var(--c-jma-red);
    font-weight: var(--type-body-weight-emphasized);
  }
  .meta {
    display: flex;
    gap: var(--space-3);
    margin: var(--space-2) 0 6px;
  }
  .long-period-rider { margin: 0 0 var(--space-2); padding: var(--space-1) var(--space-2); border-left: 3px solid var(--role-weatherWarning); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-body-weight-emphasized); }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stat-label {
    font-size: var(--type-label-xs-size);
    color: var(--role-muted);
  }
  .stat-value {
    font-size: max(14px, var(--type-body-l-fluid));
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
  }
  /* 静的リスト (paging=false、spec §4 決定表の totalEffective<=30) — 自動スクロールは撤去し、
     全グループを1本の静的リストで並べる (原則5「動くものは読めたら補足まで」) */
  .groups {
    margin: 4px 0 0;
    font-size: var(--type-label-s-fluid);
    list-style: none;
    padding: 0;
  }
  .groups li {
    display: flex;
    gap: 10px;
    padding: 3px 0;
    /* 複数県にまたがり複数行になっても震度チップが縦に伸びないよう行頭固定 (第3波 Fix6) */
    align-items: flex-start;
  }
  .g-int {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    white-space: nowrap;
  }
  /* 都道府県 → 市区町村の階層。WeatherAlertCard の pref-group 文法と揃える (第3波 Fix7) */
  .g-pref-groups {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pref-group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4em;
  }
  .pref-name {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    color: var(--fg);
  }
  /* 市区町村名は個別 span (white-space:nowrap) にし、折返しは名前と名前の間だけで発生させる。
     区切りは文字 (旧「・」) ではなく gap で表現する (第3波 Fix14)。.cities 自体は display:contents
     で flex アイテムから外し、city-name span を .pref-group の直接の子として扱わせる。
     inline-flex のままだと "ブロック単位で次行へ wrap" してしまい、市町村が多い県だけ県名直後で
     改行される不統一が起きていた (review-T5a-2 FIX-B)。常にインラインで自然折返しさせる */
  .cities {
    display: contents;
    color: var(--role-muted);
  }
  .city-name {
    white-space: nowrap;
  }
  .g-omitted {
    display: block;
    margin-top: 2px;
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
  }
  /* 詳細ページング (spec §3): 各ページに見出し・件数・ページ番号を固定枠で常時表示する
     (原則3「任意の瞬間が単独で読める」)。ページ切替は旧ページ・新ページを重ねたクロスフェード
     (T5c、spec §3 再々改訂)。.page-detail に position:relative + 明示 height (予算、下記) を
     与え、{#key cycler.index} で再マウントされる .page-fade を position:absolute で重ねる。
     outro (旧ページ) と intro (新ページ) が同時に走るため空白を経由しない (§8 の減光禁止には
     該当しない、入替表現のため)。フェード完了後は outro 側が DOM から破棄され単層 opacity:1 */
  .page-detail {
    position: relative;
    margin: 4px 0 0;
    /* T5c: LatestQuakeCard は height:100% の grid セルに属さない content-driven カードのため、
       他パネルのように flex:1 で「残り画面高さ」を自然に受け取れない。ヘッダ1行 (概算) + gap +
       page-body の高さ予算 (6行分、review-T5a-2 FIX-1 由来) を合算した固定 height を与える。
       page-fade が position:absolute;inset:0 でこの箱いっぱいに重なり、内部の page-body は
       flex:1 でヘッダの実高さを引いた残りを受け取る (ヘッダ実測ぶんを自動で吸収する) */
    height: calc(7 * 1.6em + 4px);
  }
  .page-fade {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .page-header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5em;
    font-size: var(--type-label-s-fluid);
  }
  .page-title {
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-muted);
  }
  .page-body {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--type-label-s-fluid);
    overflow: hidden;
    /* .page-detail の height 予算から page-header の実高さを引いた残りを flex:1 で受け取る
       (T5c)。そこから measureHeight で実測 → rowCapacity → cityBudgetFromArea
       (lib/instrument-layout.ts) のパイプラインに通す (spec §2-c「先にカードへ高さ予算を
       与えてから実測」)。font-size が fluid token (--type-label-s-fluid) のため、行高実測の
       結果は viewport 幅に追従する */
    flex: 1;
    min-height: 0;
  }
  .line-ruler {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
</style>
