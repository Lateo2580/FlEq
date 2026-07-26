<script lang="ts">
  import {
    WEATHER_PAGE_ROW_CAPACITY,
    WEATHER_ROW_AREA_MAX,
    WEATHER_ROW_AREA_MAX_COMPACT,
    WEATHER_SUB_KIND_MAX,
    capRowAreas,
    paginateWeatherRows,
    selectSubKinds,
    stripLevelPrefix,
    weatherPageCapacity,
    weatherRowAreaMax,
    type WeatherEmergencyInputV1,
  } from "../lib/weather-panel";
  import { measureHeight, measureBorderHeight, observeResize } from "../lib/measure-height";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { fade } from "svelte/transition";
  import { onDestroy, untrack } from "svelte";
  import PageDots from "./PageDots.svelte";
  import RestoredChip from "./RestoredChip.svelte";

  // compact: main-stack の非 main スロット (狭い右列) から true が渡る。3 固定領域の構成は変えず、
  // type と padding を一段圧縮する (EewPanel / TsunamiPanel と同じ作法)。
  // layoutSettling: 緊急画面のレイアウト遷移中 (グリッド track 補間中) は EmergencyScreen から
  // true が渡る。遷移中の実測は過渡値なので、最新 1 件だけ保持して整定後に反映する
  // (QuakePanel / TsunamiPanel と同じ契約。特に maxRowHeight は単調増加なので、遷移中の
  //  折返しで膨らんだ値を最終レイアウトへ持ち越すと以後ずっと容量を過小評価する、Codex R3)
  let {
    input,
    compact = false,
    layoutSettling = false,
  }: { input: WeatherEmergencyInputV1; compact?: boolean; layoutSettling?: boolean } = $props();

  // L5 相当 = officialL5 ∪ nonLevelSpecial (どちらも特別警報級)、L4 相当 = officialL4 (警報級)。
  // 色 role は既存の weatherEmergency / weatherWarning を再利用する (新規トークンを作らない、spec §3)
  const role = $derived(input.level === 5 ? "weatherEmergency" : "weatherWarning");
  const headingLabel = $derived(input.level === 5 ? "気象特別警報" : "気象警報");

  // 主レベルの行 (「何が」「どこ」の対象)。L5 昇格中の L4 行は副セクションへ回す。
  // 種別名は L 接頭辞を落とす (ユーザー指摘 2026-07-26): 主レベルは「警戒レベル N 相当」で一度
  // 示しているので行ごとの L は情報を足さず、レベル対応/非対応の混在だけが目に付く
  const mainItems = $derived(
    input.items
      .filter((it) => it.level === input.level)
      .map((it) => ({ ...it, kind: stripLevelPrefix(it.kind) })),
  );
  const subItems = $derived(
    input.items
      .filter((it) => it.level !== input.level)
      .map((it) => ({ ...it, kind: stripLevelPrefix(it.kind) })),
  );

  // 区分 (警報名) の一覧。source 間で同名でも統合しない契約 (spec §3) は「どこ」の行の話で、
  // この一覧は重複を畳む。
  //
  // **上限を掛けず、折り返して全種別を載せる** (ユーザー決定 2026-07-26)。以前は上限 + 「ほか N
  // 種別」で畳んでいたが、狭い枠では**最上級レベルに何が出ているかが件数へ丸められた**。
  // 表示の優先順位は「レベル + 行動文 ＞ 区分一覧 ＞ 地域」で、高さが足りないときは
  // **ページ送りを持つ地域カード側が縮む** (どの区分が出ているかは常に一目で読める)
  const alertNames = $derived([...new Set(mainItems.map((it) => it.kind))]);

  // 行動文 (spec §3 D 確定): レベル相当ごとに固定文。パネル内の副セクションも同じ語彙を使う
  function actionOf(level: 4 | 5): string {
    return level === 5 ? "命の危険 直ちに安全確保" : "危険な場所にいる人は全員避難";
  }

  // ── 「どこ」領域のページング (Codex R1 Important: overflow:hidden の無言切り捨て封じ) ──
  // QuakePanel / TsunamiPanel と同じ作法: 領域と行を実測して 1 ページの行数を出し、
  // createPageCycler で自動巡回する。jsdom は ResizeObserver 未実装で測定が一度も走らないため、
  // weatherPageCapacity の「未実測 = fallback (WEATHER_PAGE_ROW_CAPACITY)」経路に落ちる。
  // 1 行に並べる地域名の件数は**領域の実測幅**から決める (固定件数だと、ゆとりがあるのに
  // 省略してしまう / 狭いのに詰め込む、の両方が起きる)。未実測のうちは fallback
  const areaMax = $derived(weatherRowAreaMax(whereBodyWidth, whereFontSize, compact));
  const mainRows = $derived(mainItems.map((it) => capRowAreas(it, areaMax)));
  // 副セクションは **地域名を持たない要約** (ユーザー決定 2026-07-26)。種別名だけを上限まで
  // 並べ、残りは「ほか N 種別」で明示する。地域行を並べると折返しで高さが青天井になり、
  // ページ送りを持たない固定領域では溢れが黙って切られる (Codex R5)。上限は distinct な種別数
  const subSelection = $derived(selectSubKinds(subItems, WEATHER_SUB_KIND_MAX));
  const subKinds = $derived(subSelection.kinds);
  /** 副セクションに載らなかった種別数。黙って消さず件数で明示する */
  const hiddenSubKindCount = $derived(subSelection.hiddenKindCount);

  // 省略の告知は**行末の「ほか N 地域」「ほか N 種別」に一本化**する (ユーザー決定 2026-07-26、
  // spec §3 の「縮退省略時は『表示は一部です』固定表示」から変更)。旧実装は領域下端にも固定文を
  // 出していたが、主語が無く「ページの一部」と誤読される一方、同じことを行末表記が件数付きで
  // 既に言っていた。件数の方が具体的なので、重複する固定文を落として行末表記に寄せる

  // null = まだ測っていない (ResizeObserver 未発火・jsdom)。実測して 0 だった場合と区別する
  // — 同一視すると「潰れて見えない領域」に fallback 行数を描いて黙って消すことになる (Codex R2)
  let whereAreaHeight = $state<number | null>(null);
  // 行高は**観測した中の最大**を使う。地域名の折返しで行高は不揃いになり、先頭行を代表値にすると
  // 後続の高い行が溢れる (Codex R2)。多めに見積もる方向へ倒すのでページが増えるだけで情報は残る
  let maxRowHeight = $state<number | null>(null);
  // レイアウト遷移中の実測は**採らない**。過渡値を確定値に昇格させると、遷移中に折り返して
  // 膨らんだ行高が最終レイアウトへ residue として残り、以後ずっと余分にページを割る (Codex R4)。
  // 整定が解けた時点で最終 DOM から測り直す — ResizeObserver は「サイズが変わらなければ鳴らない」
  // ので、次の通知を待つ設計にすると整定後に一度も更新されない経路ができる。
  let whereBodyEl: HTMLElement | null = null;
  // 地域件数の可変化に使う実測 (幅と実効フォントサイズ)。高さと同じく未実測は null
  let whereBodyWidth = $state<number | null>(null);
  let whereFontSize = $state<number | null>(null);
  const rowNodes = new Set<HTMLElement>();
  // 地域列 (.areas) の実幅を測るための登録。行全体の幅を使うと区分列・gap・縦罫ぶんを
  // 数え込んで件数を過大評価する (Codex R6)
  const areaNodes = new Set<HTMLElement>();
  function registerRow(node: HTMLElement) {
    rowNodes.add(node);
    return {
      destroy(): void {
        rowNodes.delete(node);
      },
    };
  }
  function registerAreas(node: HTMLElement) {
    areaNodes.add(node);
    return {
      destroy(): void {
        areaNodes.delete(node);
      },
    };
  }
  const applyWhereArea = (px: number): void => {
    if (!layoutSettling) whereAreaHeight = px;
  };
  const applyRowHeight = (px: number): void => {
    if (layoutSettling) return;
    if (maxRowHeight == null || px > maxRowHeight) maxRowHeight = px;
  };
  /** 地域件数の可変化に使う「地域列の幅」と文字サイズを実測する。取れない環境 (jsdom) では未実測 */
  function remeasureWidth(): void {
    if (whereBodyEl == null || layoutSettling) return;
    // 測るのは .areas 列そのもの。まだ行が無いときだけ領域全幅で代用する (初回描画の暫定値)
    const areaEl = areaNodes.values().next().value;
    const width = (areaEl ?? whereBodyEl).getBoundingClientRect().width;
    if (width > 0) whereBodyWidth = width;
    // 文字サイズは行から採る (行は --panel-scale 連動なので where-body の値とは違う)
    const sample = areaEl ?? rowNodes.values().next().value ?? whereBodyEl;
    const fontSize = Number.parseFloat(getComputedStyle(sample).fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) whereFontSize = fontSize;
  }
  /** 最終 DOM から実測し直す。0 しか取れない環境 (jsdom) では null を返して未実測へ戻す */
  function remeasureRows(): number | null {
    let max: number | null = null;
    for (const node of rowNodes) {
      const h = node.getBoundingClientRect().height;
      if (h > 0 && (max == null || h > max)) max = h;
    }
    return max;
  }
  // 測り直しの契機は「整定の解除」と「内容・レベル・スロット幅の変化」の 2 つ。
  // 契機は**値**で判定する (`measureKey`) — `input.generation` を直接 $effect で読むと、
  // 中身が同じ続報でも prop の識別子が変わるたびに effect が走り、実測値を毎回捨ててしまう
  // (ResizeObserver は寸法が変わらなければ鳴らないので、捨てた後 fallback のまま固定される)
  // areaMax も契機に含める (Codex R6): 行高の観測は最大値の片方向なので、狭幅 → 広幅で
  // 折返しが解けても maxRowHeight が下がらず、余分なページが残り続ける。1 行に並ぶ地域数が
  // 変わったら DOM 更新後に測り直して、現在のレイアウトの値へ置き換える
  const measureKey = $derived(`${input.generation}|${input.level}|${compact}|${areaMax}`);
  let wasSettling = false;
  let lastMeasureKey: string | undefined;
  $effect(() => {
    const key = measureKey;
    const settling = layoutSettling;
    untrack(() => {
      if (settling) {
        wasSettling = true;
        return;
      }
      const keyChanged = lastMeasureKey !== undefined && key !== lastMeasureKey;
      lastMeasureKey = key;
      if (!keyChanged && !wasSettling) return;
      wasSettling = false;
      // 過渡値・前の内容の行高は捨て、確定した DOM から測り直す
      const areaPx = whereBodyEl?.getBoundingClientRect().height ?? 0;
      if (areaPx > 0) whereAreaHeight = areaPx;
      maxRowHeight = remeasureRows();
      remeasureWidth();
    });
  });
  const pageCapacity = $derived(weatherPageCapacity(whereAreaHeight, maxRowHeight, WEATHER_PAGE_ROW_CAPACITY));
  const pages = $derived(paginateWeatherRows(mainRows, pageCapacity));

  // 内容が変わったら (generation 更新・主レベル変化) 先頭ページへ戻す。generation は engine 側が
  // 縮退方向の変化でも上げる契約なので、地域が減ったときも先頭から読み直しになる
  const cycler = createPageCycler({
    pageCount: () => pages.length,
    resetKey: () => `${input.generation}|${input.level}`,
  });
  onDestroy(() => cycler.destroy());
  const currentPage = $derived(pages[cycler.index] ?? pages[0] ?? []);
</script>

<div class="weather-panel role-{role} level-{input.level}" class:compact>
  <div class="heading">{headingLabel}</div>
  <div class="tiles">
    <!-- 何が + どうする: レベルと行動文を 1 行に束ねたヒーロー。続けて区分を全種別ぶん並べる
         (ユーザー決定 2026-07-26。ページ送りの待ちを地域だけに閉じ込め、
          「何が起きていて何をするか」は常に一目で読めるようにする) -->
    <div class="tile tile-what">
      <!-- 主役スロット (ゆとりのある単独/主役表示) はレベルを単独行のヒーローに置き、行動文は
           独立した行動レールへ分ける。compact だけ 1 行に束ねて縦を節約する (ユーザー決定 2026-07-26) -->
      <div class="hero" class:merged={compact}>
        <span class="level-label"
          >警戒レベル{input.level}<span class="level-suffix">相当</span></span
        >{#if compact}<span class="hero-sep">—</span><span class="action-main">{actionOf(input.level)}</span>{/if}
      </div>
      <div class="alert-names">
        {#each alertNames as name (name)}<span class="alert-name">{name}</span>{/each}{#if input.restored}<RestoredChip />{/if}
      </div>
    </div>

    {#if !compact}
      <!-- どうする: 面ではなく role 色の縦レールで主張する行動レール。補助行もここに置く
           (compact では上のヒーロー行に束ね、補助行は省いて主情報へ高さを回す) -->
      <div class="tile tile-action">
        <div class="action-main">{actionOf(input.level)}</div>
        <div class="action-note">自治体が発令する避難指示とは別の防災気象情報です</div>
      </div>
    {/if}

    <!-- どこ: 種別ごとに shownAreas + ほか N 地域 (source 間の合算はしない)。
         行が領域に収まらないときは切り捨てず自動ページ送りで全種別を巡回する。
         パネル内で唯一の「面」を持つタイル (一覧・ページャを抱える領域だけを囲う) -->
    <div class="tile tile-where">
      <!-- 見出し行にページャを置く: 省略の告知 (行末の件数) とページ位置を別の場所で言う。
           同じフッタに並べていた旧構成は「省略＝ページの一部」と誤読された (ユーザー指摘) -->
      <div class="where-head">
        <span class="section-label">対象地域・区分</span>
        {#if cycler.total > 1}
          <PageDots total={cycler.total} current={cycler.index} onJump={(i) => cycler.jumpTo(i)} />
        {/if}
      </div>
      <div class="where-body" bind:this={whereBodyEl} use:observeResize={remeasureWidth} use:measureHeight={applyWhereArea}>
        {#key cycler.index}
          <div
            class="page-fade"
            transition:fade={{
              duration: cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
              easing: springEffectsOut,
            }}
          >
            {#if currentPage.length === 0}
              <!-- engine は昇格を指示しているが、まだ当該レベルの item を組めていない状態
                   (電文待ち・一時的な不整合)。主役表示は畳まず「まだ届いていない」ことを描く -->
              <div class="syncing">対象地域を同期中です</div>
            {/if}
            {#each currentPage as row (row.key)}
              <div class="where-row" use:registerRow use:measureBorderHeight={applyRowHeight}>
                <span class="kind">{row.kind}</span>
                <span class="areas" use:registerAreas>
                  {#each row.areas as area (area)}<span class="area-name">{area}</span>{/each}
                  {#if row.hiddenAreaCount > 0}<span class="omitted">ほか{row.hiddenAreaCount}地域</span>{/if}
                </span>
              </div>
            {/each}
          </div>
        {/key}
      </div>
    </div>

    {#if subItems.length > 0}
      <!-- 副セクション: L5 昇格中に併存する L4 相当。**地域名を持たない要約**にして高さを
           予測可能に保つ (ユーザー決定 2026-07-26)。地域は主レベルの「どこ」が担う -->
      <div class="tile tile-sub">
        <div class="sub-head">
          <span class="sub-level">警戒レベル4相当</span>
          <span class="sub-action">{actionOf(4)}</span>
        </div>
        <div class="sub-kinds">
          {#each subKinds as kind (kind)}<span class="kind">{kind}</span>{/each}{#if hiddenSubKindCount > 0}<span class="sub-omitted">ほか{hiddenSubKindCount}種別</span>{/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .weather-panel {
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
  /* 主見出しは 3 パネル共通トークンで高さを揃える (--panel-header-*、第4波) */
  .heading {
    box-sizing: border-box;
    min-height: calc(var(--panel-header-min-h) * var(--panel-scale, 1));
    display: flex;
    align-items: center;
    font-size: calc(var(--panel-header-font-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
    padding: calc(var(--panel-header-padding-v) * var(--panel-scale, 1))
      calc(var(--panel-header-padding-h) * var(--panel-scale, 1));
    background: var(--header-weatherWarning-container);
    color: var(--header-weatherWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning);
  }
  .role-weatherEmergency .heading {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherEmergency);
  }
  .tiles {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  /* 「面」を持つのは詳細一覧 (.tile-where) だけ。「何が」「どうする」「副節」を同格のタイルに
     すると重要度が横並びになり、EEW/津波/地震の「主役 + 計器 + リスト」構成と比べて平板に見える
     (ユーザー指摘 2026-07-26)。**主役以外を囲う**のではなく、詳細だけを囲う方向へ反転した */
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
  }
  .tile-what,
  .tile-action,
  .tile-sub {
    background: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  /* 何が + どうする: 面を持たないヒーロー。ここは**縮まない** (flex:0 0 auto) —
     高さが足りないときに縮むのはページ送りを持つ地域カード側 (優先順位の明示) */
  .tile-what {
    flex: 0 0 auto;
    padding: var(--space-2) var(--space-2) 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  /* 主役スロットはレベル単独行。compact のときだけ (.merged) 行動文を同じ行へ束ねる */
  .hero {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-3);
  }
  .hero-sep {
    color: var(--role-muted);
  }
  /* 「相当」は「警戒レベル5」に従属する語なので一段小さく (ユーザー指摘 2026-07-26) */
  .level-suffix {
    font-size: 0.62em;
    margin-inline-start: 0.15em;
  }
  .level-label {
    font-size: calc(var(--type-display-l-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
  }
  .role-weatherEmergency .level-label {
    color: var(--role-weatherEmergency);
  }
  .role-weatherWarning .level-label {
    color: var(--role-weatherWarning);
  }
  /* 区分一覧: 上限なしで折り返して全種別を載せる (件数へ丸めない) */
  .alert-names {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
    font-size: calc(var(--type-title-m-size) * var(--panel-scale, 1));
    font-weight: var(--type-body-weight-emphasized);
    line-height: 1.3;
  }
  .alert-name {
    white-space: nowrap;
  }
  .tile-where {
    flex: 1 1 auto;
    /* 「何が」「どうする」「副節」に押されても 1 行 + フッタぶんは必ず残す (実測 0 で
       ページ容量 1 行に落ちても描画面が無い、という状態を作らない) */
    min-height: 5em;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* ページ本文。旧ページと新ページを重ねてクロスフェードするため position:relative の器にする
     (QuakePanel .tile-page-detail と同型)。実測 (measureHeight) の対象もこの器 */
  .where-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  /* 行間は CSS gap ではなく行自身の padding で持つ: measureBorderHeight (border-box) が
     行間込みの消費高さを返すようになり、ページ容量の計算に gap 補正が要らなくなる (Codex R2) */
  .page-fade {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  /* 詳細一覧の見出し行。ページャはここに置き、省略の告知 (行末の件数) とは場所を分ける */
  .where-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .section-label {
    font-size: var(--type-label-l-size);
    color: var(--role-muted);
  }
  /* 副セクションの種別列。地域は持たないので高さは行数で決まり、折返しても 1〜2 行に収まる */
  .sub-kinds {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
    font-size: calc(var(--type-body-m-size) * var(--panel-scale, 1));
  }
  .sub-omitted {
    color: var(--role-muted);
    font-size: var(--type-label-m-size);
  }
  /* 中身待ちの明示 (engine は昇格中、フロントはまだ item を組めていない) */
  .syncing {
    color: var(--role-muted);
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
  }
  /* 「何が」の上限超過ぶん。警報名と同じ行に、控えめなトーンで件数だけ添える */
  .name-omitted {
    color: var(--role-muted);
    font-size: var(--type-label-l-size);
    font-weight: normal;
    white-space: nowrap;
  }
  /* 区分と地域は「別の軸」なので、太さではなく**列と罫線**で分ける。遠見・夜間減光では
     font-weight の差が最初に消えるため、太さだけの分離は成立しない (ユーザー指摘 2026-07-26) */
  .where-row {
    padding-block: var(--space-1);
    display: grid;
    grid-template-columns: minmax(9em, 0.4fr) minmax(0, 1fr);
    align-items: start;
    column-gap: var(--space-4);
    line-height: 1.3;
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
  }
  .kind {
    font-weight: var(--type-title-weight-emphasized);
    color: var(--role-weatherWarning);
    white-space: nowrap;
  }
  .role-weatherEmergency .where-row .kind {
    color: var(--role-weatherEmergency);
  }
  /* 地域名は個別 span (nowrap) にし、折返しは名前と名前の間だけで起こす (第3波 Fix14 と同じ作法) */
  .areas {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
    border-inline-start: 1px solid var(--hairline);
    padding-inline-start: var(--space-4);
  }
  .area-name {
    white-space: nowrap;
  }
  .omitted {
    white-space: nowrap;
    color: var(--role-muted);
  }
  /* どうする: 面ではなく role 色の縦レールで主張する行動レール (主役スロットのみ) */
  .tile-action {
    flex: 0 0 auto;
    padding: var(--space-2) var(--space-5);
    border-inline-start: var(--header-band-width) solid var(--role-weatherWarning);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .role-weatherEmergency .tile-action {
    border-inline-start-color: var(--role-weatherEmergency);
  }
  /* 行動文は**折り返させない** (ユーザー指摘 2026-07-26)。「危険な場所にいる人は全員避難」は
     14 文字あり、行動レールの幅次第で 2 行になって視線が切れる。パネルは container-type:
     inline-size を持つので、コンテナ幅に対する上限 (cqw) と既存トークンの min() で、
     読める範囲まで自動的に縮める。係数は「全角 1 文字 ≒ 1em・最長 14 文字 (危険な場所にいる人は
     全員避難) + 余白」から算出した上限より小さく取ってある (縦積み 5cqw / bento 1.6cqw)。
     **nowrap なので係数が甘いと折返しではなくクリップになる** — 必ず安全側へ倒すこと */
  .action-main {
    font-size: min(calc(var(--type-headline-m-size) * var(--panel-scale, 1)), 5cqw);
    font-weight: var(--type-headline-weight-emphasized);
    white-space: nowrap;
  }
  .role-weatherEmergency .action-main {
    color: var(--role-weatherEmergency);
  }
  .role-weatherWarning .action-main {
    color: var(--role-weatherWarning);
  }
  .action-note {
    font-size: var(--type-label-l-size);
    color: var(--role-muted);
  }

  /* critical tier (L5 発表中・大津波警報併発など) は TierOverlay の全画面フィルム (最大 α=0.34) が
     文字にも背景にも掛かる。合成後の実測で意味色は AA を割る (weatherEmergency 3.21〜3.66:1 /
     weatherWarning 3.90〜4.44:1、`--fg` なら 6.85〜7.81:1) ため、**主要な文字だけ --fg へ退避**する。
     意味色は看板ヘッダ帯と行動レール (非テキスト、閾値 3:1) に残るので、種別の識別は保たれる。
     監査は cat10 に該当ペアを載せて「使わない組合せ」として明示してある */
  :global(main[data-tier="critical"]) .weather-panel .level-label,
  :global(main[data-tier="critical"]) .weather-panel .action-main,
  :global(main[data-tier="critical"]) .weather-panel .where-row .kind,
  :global(main[data-tier="critical"]) .weather-panel .sub-kinds .kind,
  :global(main[data-tier="critical"]) .weather-panel .sub-level {
    color: var(--fg);
  }
  /* 副節: 面を持たず、主節との間に髪の毛罫だけを引く */
  .tile-sub {
    padding: var(--space-3) var(--space-2) 0;
    border-top: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .sub-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }
  .sub-level {
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-weatherWarning);
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
  }
  .sub-action {
    font-size: var(--type-body-m-size);
    color: var(--fg);
  }

  /* compact (main-stack 非 main スロット): 見出し部を凝縮し「どこ」領域にカード高を渡す */
  .weather-panel.compact .tiles {
    padding: var(--space-2) var(--space-3) var(--space-3);
    gap: var(--space-1);
  }
  .weather-panel.compact .tile-what {
    padding: var(--space-2) var(--space-3);
    gap: var(--space-1);
  }
  .weather-panel.compact .level-label {
    font-size: var(--type-headline-m-size);
    line-height: 1.15;
  }
  .weather-panel.compact .alert-names {
    font-size: var(--type-body-l-size);
  }
  .weather-panel.compact .where-row {
    font-size: var(--type-body-m-size);
  }
  .weather-panel.compact .tile-where,
  .weather-panel.compact .tile-sub {
    padding: var(--space-2) var(--space-3);
  }
  /* compact はヒーロー行に束ねる構成で、行全体の折返しは許容する (レベルと行動文が別行になる)。
     行動文そのものが途中で切れないよう nowrap は維持し、上限だけ compact 用に下げる */
  .weather-panel.compact .action-main {
    font-size: min(var(--type-body-l-size), 6cqw);
  }
  .weather-panel.compact .action-note {
    font-size: var(--type-label-m-size);
  }

  /* bento: 十分な幅があれば「何が」と「どうする」を横並びにし、「どこ」を全幅で下段に置く */
  @container (min-width: 860px) {
    .tiles {
      display: grid;
      grid-template-areas:
        "what action"
        "where where"
        "sub sub";
      grid-template-columns: 2fr 1fr;
      grid-template-rows: auto 1fr auto;
    }
    .tile-what {
      grid-area: what;
    }
    .tile-action {
      grid-area: action;
      justify-content: center;
    }
    /* bento では行動レールが 1fr 列 (パネル幅の約 1/3) に入るので、上限もその幅で採り直す */
    .action-main {
      font-size: min(calc(var(--type-headline-m-size) * var(--panel-scale, 1)), 1.6cqw);
    }
    .tile-where {
      grid-area: where;
    }
    .tile-sub {
      grid-area: sub;
    }
  }
</style>
