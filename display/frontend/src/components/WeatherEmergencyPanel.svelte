<script lang="ts">
  import {
    WEATHER_PAGE_ROW_CAPACITY,
    WEATHER_ROW_AREA_MAX,
    WEATHER_ROW_AREA_MAX_COMPACT,
    WEATHER_SUB_KIND_MAX,
    acceptsMeasurement,
    capRowAreas,
    paginateWeatherRows,
    selectPagedItems,
    selectSubKinds,
    stripLevelPrefix,
    weatherEmergencyHeading,
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
  import UpdatedStamp from "./UpdatedStamp.svelte";

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
  const headingLabel = $derived(weatherEmergencyHeading(input));
  // 新規発表 / 更新発表のバッジ (spec 追補 3)。判定材料が無いときは出さない —
  // 嘘の「新規」を出すより無表示を採る (C5)
  const triggerLabel = $derived(
    input.trigger === "new" ? "新規発表" : input.trigger === "update" ? "更新発表" : null,
  );

  // 主レベルの行 (「何が」の対象)。種別名は L 接頭辞を落とす (ユーザー指摘 2026-07-26):
  // 主レベルは「警戒レベル N 相当」で一度示しているので行ごとの L は情報を足さず、
  // レベル対応/非対応の混在だけが目に付く
  const mainItems = $derived(
    input.items
      .filter((it) => it.level === input.level)
      .map((it) => ({ ...it, kind: stripLevelPrefix(it.kind) })),
  );
  // ページ送り列に載せる行 = 主レベルの全行 + **追加を含む下位レベルの行** (ご主人決定
  // 2026-07-27)。下位レベルの行はレベル印 (行頭の「L4」) を添えて出す — 種別名だけでは
  // 主レベルの行と見分けが付かず、L 接頭辞の有無は電文のラベル次第で当てにならない
  const pagedItems = $derived(
    selectPagedItems(input.items, input.level).map((it) => ({
      ...it,
      kind: stripLevelPrefix(it.kind),
    })),
  );
  // 副セクション (種別名 + 件数の要約) は下位レベルの**全行**を持つ。追加を含む行がページ送り
  // 列にも出ることとは両立する — 要約は「何が出ているか」を常時見せ、ページ送り列は「どこが
  // 増えたか」を見せる。巡回で別ページを表示中でも種別の一覧が消えない
  const subItems = $derived(
    input.items
      .filter((it) => it.level !== input.level)
      .map((it) => ({ ...it, kind: stripLevelPrefix(it.kind) })),
  );

  // 区分 (警報名) の一覧。「どこ」の行は同一現象を跨 source で統合済みだが、表示ラベル違いにも
  // 備えて、この一覧でも重複を畳む。
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
  // 地域件数の可変化に使う実測 (幅と実効フォントサイズ)。高さと同じく未実測は null
  let whereBodyWidth = $state<number | null>(null);
  let whereFontSize = $state<number | null>(null);
  const areaMax = $derived(weatherRowAreaMax(whereBodyWidth, whereFontSize, compact));
  const mainRows = $derived(pagedItems.map((it) => capRowAreas(it, areaMax)));
  // 副セクションは **地域名を持たない要約** (ユーザー決定 2026-07-26)。種別名だけを上限まで
  // 並べ、残りは「ほか N 種別」で明示する。地域行を並べると折返しで高さが青天井になり、
  // ページ送りを持たない固定領域では溢れが黙って切られる (Codex R5)。上限は distinct な種別数
  const subSelection = $derived(selectSubKinds(subItems, WEATHER_SUB_KIND_MAX));
  const subKinds = $derived(subSelection.kinds);
  // 副セクションは地域を描かないので、そこに追加地域が来ても見えない (Codex レビュー
  // 2026-07-27)。**種別名に印を付けて件数で知らせる** — 地域一覧は主レベルが担うという
  // 構造は保ったまま、「この下位レベルでも増えた」ことだけは落とさない
  const subAddedKinds = $derived(
    new Set(subItems.filter((it) => it.addedAreas.length > 0).map((it) => it.kind)),
  );
  const subAddedCount = $derived(
    subItems.reduce((n, it) => n + it.addedAreas.length, 0),
  );
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
  let whereBodyEl = $state<HTMLElement | null>(null);
  // 実測に使う DOM は **作られた時点の点灯キー (token) と一緒に**持つ (spec 追補 C1 の
  // 再点灯 crossfade 対策)。退場中の旧 DOM も ResizeObserver を鳴らし続けるので
  // (`pointer-events: none` では止まらない)、token が現行 activationKey と一致するものだけを
  // 受理する。action は `update` を実装しない = パラメータは**生成時の値で固定**される
  const rowNodes = new Map<HTMLElement, string>();
  // 地域列 (.areas) の実幅を測るための登録。行全体の幅を使うと区分列・gap・縦罫ぶんを
  // 数え込んで件数を過大評価する (Codex R6)
  const areaNodes = new Map<HTMLElement, string>();
  function registerRow(node: HTMLElement, token: string) {
    rowNodes.set(node, token);
    return {
      destroy(): void {
        rowNodes.delete(node);
      },
    };
  }
  function registerAreas(node: HTMLElement, token: string) {
    areaNodes.set(node, token);
    return {
      destroy(): void {
        areaNodes.delete(node);
      },
    };
  }
  /** 現行の点灯に属する DOM だけを返す (退場中の旧 DOM は除く) */
  function liveNodes(nodes: Map<HTMLElement, string>): HTMLElement[] {
    const key = input.activationKey;
    return [...nodes].filter(([, token]) => token === key).map(([node]) => node);
  }
  /** ResizeObserver 未対応環境 (jsdom) では destroy を持たない handle が返る */
  type MeasureHandle = { destroy?: () => void };
  function measureWhereArea(node: HTMLElement, token: string) {
    const handle: MeasureHandle = measureHeight(node, (px) => {
      if (acceptsMeasurement(token, input.activationKey, layoutSettling)) whereAreaHeight = px;
    });
    // 生成時に固定した token を `update` で上書きさせないため、destroy だけを返す
    return { destroy: () => handle.destroy?.() };
  }
  function measureRow(node: HTMLElement, token: string) {
    const handle: MeasureHandle = measureBorderHeight(node, (px) => {
      if (!acceptsMeasurement(token, input.activationKey, layoutSettling)) return;
      if (maxRowHeight == null || px > maxRowHeight) maxRowHeight = px;
    });
    return { destroy: () => handle.destroy?.() };
  }
  function observeWhereArea(node: HTMLElement, token: string) {
    const handle: MeasureHandle = observeResize(node, () => {
      if (acceptsMeasurement(token, input.activationKey, layoutSettling)) remeasureWidth();
    });
    return { destroy: () => handle.destroy?.() };
  }
  /** 地域件数の可変化に使う「地域列の幅」と文字サイズを実測する。取れない環境 (jsdom) では未実測 */
  function remeasureWidth(): void {
    if (whereBodyEl == null || layoutSettling) return;
    // 測るのは .areas 列そのもの。まだ行が無いときだけ領域全幅で代用する (初回描画の暫定値)
    const areaEl = liveNodes(areaNodes)[0];
    const width = (areaEl ?? whereBodyEl).getBoundingClientRect().width;
    if (width > 0) whereBodyWidth = width;
    // 文字サイズは行から採る (行は --panel-scale 連動なので where-body の値とは違う)
    const sample = areaEl ?? liveNodes(rowNodes)[0] ?? whereBodyEl;
    const fontSize = Number.parseFloat(getComputedStyle(sample).fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) whereFontSize = fontSize;
  }
  /** 最終 DOM から実測し直す。0 しか取れない環境 (jsdom) では null を返して未実測へ戻す */
  function remeasureRows(): number | null {
    let max: number | null = null;
    for (const node of liveNodes(rowNodes)) {
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
  // activationKey も契機に含める: 再点灯では `{#key}` ブロックごと DOM が作り直されるので、
  // 前の点灯で観測した行高 (単調増加) をそのまま持ち越すと容量を過小評価したまま固定される
  const measureKey = $derived(
    `${input.generation}|${input.level}|${compact}|${areaMax}|${input.activationKey}`,
  );
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

  // 追加地域を含む行のページから見せる (spec 追補 C11)。10 秒周期の巡回を待たせると、
  // ハイライトを出す意味が薄れる。契機は再点灯 (activationKey) のときだけ
  // 再点灯演出は prefers-reduced-motion で止める。**バッジとハイライトは残す** (情報は落とさない)
  const reducedMotion = $derived(cycler.reducedMotion);
  let lastJumpedActivation: string | undefined;
  $effect(() => {
    const key = input.activationKey;
    const rowKey = input.firstPageRowKey;
    const pageList = pages;
    // **実測が終わるまで activation を消費しない**。fallback 容量で組んだ仮のページ割りで
    // 消費すると、実測後に対象行が別ページへ移っても跳び直せない
    // (Codex レビュー 3 巡目 2026-07-27)
    const measured =
      whereAreaHeight != null
      && maxRowHeight != null
      && whereBodyWidth != null
      && whereFontSize != null;
    untrack(() => {
      if (!measured || key === lastJumpedActivation) return;
      lastJumpedActivation = key;
      if (rowKey == null) return;
      const index = pageList.findIndex((page) => page.some((row) => row.key === rowKey));
      // $effect の中なので flushSync は使わない (Svelte が effect 内の同期フラッシュを許さない)
      if (index > 0) cycler.jumpTo(index, { immediate: false });
    });
  });
</script>

<!-- 再点灯演出 (spec 追補 C1): 外側の panel key は固定のまま、activationKey が変わったら
     **中身だけ**を差し替えて短い fade-in を掛ける (旧内容は outro を持たないので重ねない
     片方向フェード。地図的な位置が変わらない差し替えなので、重ねるより素直に出す)。
     外側 key に混ぜるとレイアウト補間と実測状態が壊れるので、演出は必ずこの内側でやる -->
<div class="weather-panel role-{role} level-{input.level}" class:compact>
  <div class="activation-stack">
  {#key input.activationKey}
  <div
    class="activation"
    in:fade={{ duration: reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS, easing: springEffectsOut }}
    out:fade={{ duration: reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS, easing: springEffectsOut }}
  >
  <div class="heading">
    <span class="heading-title">
      <span class="heading-text">{headingLabel}</span>
      {#if triggerLabel != null}<span class="trigger-badge">{triggerLabel}</span>{/if}
    </span>
    <UpdatedStamp iso={input.updatedAt} />
  </div>
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
      <!-- 実測系の action には**この DOM が作られた時点の点灯キー**を渡す (action は update を
           持たないので生成時の値で固定される)。crossfade で退場中の旧 DOM が鳴らす測定は
           token 不一致で弾かれ、現行ページの容量計算を汚さない -->
      <div
        class="where-body"
        bind:this={whereBodyEl}
        use:observeWhereArea={input.activationKey}
        use:measureWhereArea={input.activationKey}
      >
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
              <div
                class="where-row"
                class:sub-level-row={row.level !== input.level}
                use:registerRow={input.activationKey}
                use:measureRow={input.activationKey}
              >
                <!-- 下位レベルの行 (追加が起きた行だけがここに来る) はレベル印を添える。
                     種別名だけでは主レベルの行と見分けが付かない -->
                <span class="kind"
                  >{#if row.level !== input.level}<span class="row-level">L{row.level}</span>{/if}{row.kind}</span
                >
                <span class="areas" use:registerAreas={input.activationKey}>
                  {#each row.areas as area (area)}<span
                      class="area-name"
                      class:added={row.addedAreas.includes(area)}>{area}</span
                    >{/each}
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
          {#each subKinds as kind (kind)}<span
              class="kind"
              class:added={subAddedKinds.has(kind)}>{kind}</span
            >{/each}{#if subAddedCount > 0}<span class="sub-added">＋{subAddedCount}地域</span>{/if}{#if hiddenSubKindCount > 0}<span class="sub-omitted">ほか{hiddenSubKindCount}種別</span>{/if}
        </div>
      </div>
    {/if}
  </div>
  </div>
  {/key}
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
  /* 再点灯演出 (spec 追補 C1) の器。旧内容と新内容を**同じ grid セルに重ねて** crossfade する。
     `display: contents` だと描画ボックスを持たず opacity が子へ効かない
     (fade を書いても何も起きていなかった、Codex レビュー 3 巡目 2026-07-27) */
  .activation-stack {
    display: grid;
    grid-template: 1fr / 1fr;
    flex: 1;
    min-height: 0;
  }
  .activation {
    grid-area: 1 / 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* 退場中の旧内容は見えるだけでよい。**pointer-events では ResizeObserver は止まらない**ので、
     実測を弾くのは CSS ではなく token ガード (acceptsMeasurement) の役目 */
  .activation:not(:last-child) {
    pointer-events: none;
  }
  /* 新規/更新バッジ。見出し帯の on 色を継承し、輪郭だけで存在を示す
     (帯の container/on ペアは監査済み。独自の文字色・面を作らない) */
  .trigger-badge {
    padding: 0 var(--space-2);
    border: 1px solid currentColor;
    border-radius: var(--radius-s);
    font-size: max(12px, var(--type-label-l-size));
    font-weight: var(--type-body-weight-emphasized);
    white-space: nowrap;
  }
  .heading-text {
    white-space: nowrap;
  }
  .heading-title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
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
  /* L5 ヘッダーだけ気象庁の黒地白文字を反転する。暗色画面で黒帯を沈ませず、本文・凡例・
     地域リストの role 色には触れない。L4 以下は直前の既存配色をそのまま使う。 */
  .level-5 .heading {
    background: #fff;
    color: #000;
    border-bottom-color: #000;
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
  /* 副セクションで増えた種別・件数。地域一覧は主レベルが担うので、ここは印と件数だけ */
  .sub-kinds .kind.added {
    text-decoration: underline solid var(--role-weatherWarning) 3px;
    text-underline-offset: 4px;
  }
  .sub-added {
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
  /* 下位レベルの行 (追加が起きた行だけがページ送り列へ来る、ご主人決定 2026-07-27) は
     主レベルの意味色を借りない — L5 パネルの中の L4 行が特別警報の色で出ると読み違える */
  .role-weatherEmergency .where-row.sub-level-row .kind {
    color: var(--role-weatherWarning);
  }
  /* 行頭のレベル印。色に依らず読める文字の印 (「L4」) で主レベルの行と区別する */
  .row-level {
    font-size: 0.78em;
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-muted);
    margin-inline-end: 0.35em;
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
  /* この点灯で追加された地域 (spec 追補 4)。**文字色を触らない** — critical overlay 下で
     意味色が AA を割ることが実測で分かっているため (2026-07-26)。下線は非テキスト扱い
     (閾値 3:1) で、色に依存しない手掛かり (「＋」) も併記して色覚差にも耐える */
  .area-name.added {
    text-decoration: underline solid var(--role-weatherWarning) 3px;
    text-underline-offset: 4px;
  }
  .role-weatherEmergency .area-name.added {
    text-decoration-color: var(--role-weatherEmergency);
  }
  .area-name.added::before {
    content: "＋";
    color: var(--role-muted);
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
