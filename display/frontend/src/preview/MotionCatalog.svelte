<script lang="ts">
  // アニメーションカタログ (#motion-catalog、要望 2026-07-12)。実電文待ちでは検証できない
  // アニメーション (地震・津波系は数年待ちも) を、ブラウザ上のボタン操作でいつでも発火・目視する
  // 操作盤。本物のコンポーネント (components/) と本物の motion トークン (lib/motion) をそのまま
  // 使い、複製カタログを作らない (複製は本物とズレる)。production コードは無改変で、この preview
  // ファイルだけで完結する。駆動の流儀は PreviewApp の motionStep / visualFeed パターンに合わせる。
  import type {
    DisplayEewInputV1,
    DisplayLargeQuakeInputV1,
    DisplaySeverityTier,
    DisplayTsunamiInputV1,
    DisplayEventDtoV1,
  } from "../lib/protocol";
  import type { EmergencyPanelModel } from "../lib/derive";
  import StandbyScreen from "../components/StandbyScreen.svelte";
  import EmergencyScreen from "../components/EmergencyScreen.svelte";
  import Ticker from "../components/Ticker.svelte";
  import TierOverlay from "../components/TierOverlay.svelte";
  import { fade } from "svelte/transition";
  import { emergencyEnter } from "../lib/transitions";
  import { SPRING_SPATIAL_QUICK_MS, SPRING_EFFECTS_SLOW_MS, EXIT_MS } from "../lib/motion";
  import {
    standbySnapshot,
    recentQuakes,
    recentQuakesRich,
    tsunamiBannerDemoted,
    latestQuakeStandbyCards,
    weatherAlertsStandbyCards,
    statsStandbyCards,
    eewWarningInput,
    tsunamiWarningInput,
    largeQuakeInput,
    tickerLine,
  } from "./fixtures";

  // ── グループ (タブ) 定義 ──────────────────────────────────────────────
  // 1 画面に全部詰めず、コンポーネント別に 1 グループずつ見せる。各エントリはアニメ名 +
  // duration/トークン名のラベルを持ち、「今どれを見ているか」で迷わないようにする。
  type GroupId = "transition" | "standby" | "panels" | "numbers" | "chips" | "tsunami" | "ticker";
  interface CatalogEntry {
    name: string;
    token: string;
  }
  interface CatalogGroup {
    id: GroupId;
    tab: string;
    title: string;
    entries: CatalogEntry[];
  }
  const GROUPS: CatalogGroup[] = [
    {
      id: "transition",
      tab: "画面遷移",
      title: "待機 ⇄ 緊急 の画面遷移",
      entries: [
        { name: "緊急入場 (scale のみ・情報は 1 フレーム目から可視)", token: "emergencyEnter — spring-spatial-quick 約142ms" },
        { name: "待機の入場 (opacity クロスフェード)", token: "fade — spring-effects-slow" },
        { name: "退場する待機 (消失感を出さない短い fade)", token: "fade — EXIT 200ms" },
      ],
    },
    {
      id: "standby",
      tab: "待機カード",
      title: "待機画面のカード入退場と統計行 FLIP",
      entries: [
        { name: "統計行 WAAPI FLIP (地震カード有⇄無で縦位置が動く)", token: "spring-spatial-default 約435ms" },
        { name: "左上コーナーの入場 (scale) + 並べ替え FLIP", token: "spatialScaleIn / animate:flip — spring-spatial-default" },
        { name: "気象カードの入場・退場", token: "spatialScaleIn / fade — EXIT 200ms" },
      ],
    },
    {
      id: "panels",
      tab: "緊急パネル",
      title: "緊急パネルの追加・削除 (グリッド track 補間 + 並べ替え translate FLIP)",
      entries: [
        { name: "枚数増減の入場/退場 (グリッド track を補間、opacity は不触)", token: "grid-template-columns/rows — spring-spatial-quick 約142ms" },
        { name: "priority 割込みによる並べ替え (translate のみ、scale なし)", token: "animate:flipTranslate — spring-spatial-quick" },
        { name: "初期パネルは演出なし (frame-1 可視、外枠 opacity は不触)", token: "grid track が確定値で描画" },
      ],
    },
    {
      id: "numbers",
      tab: "数値",
      title: "RollingNumber ドラムロール (EewPanel の M・深さ・震度)",
      entries: [
        { name: "桁リールのドラムロール", token: "translateY — spring-effects-default" },
        { name: "着地時のウェイト強調 (bold→heavy→戻す)", token: "font-weight — spring-effects-slow" },
      ],
    },
    {
      id: "chips",
      tab: "続報チップ",
      title: "QuakePanel の続報チップ reveal + tier ウェイトスウェル",
      entries: [
        { name: "後発チップの入場 (津波・発生時刻)", token: "revealScaleIn — spring-spatial-default" },
        { name: "チップ行の高さ開き (初期に行が無い時)", token: "heightReveal — spring-effects-default" },
        { name: "長周期タイルの入場 (横並びは scale のみ)", token: "revealScaleIn — spring-spatial-default" },
        { name: "震央名の tier 連動ウェイトスウェル (上の tier ボタン)", token: "font-weight — dur-weight-swell 200ms" },
      ],
    },
    {
      id: "tsunami",
      tab: "津波行",
      title: "TsunamiPanel の予報区行 追加・並べ替え",
      entries: [
        { name: "後発行の入場 (transform+opacity)", token: "revealScaleIn — spring-spatial-default" },
        { name: "行の高さ開き (縦方向の挿入)", token: "heightReveal — spring-effects-default" },
        { name: "行の並べ替え (位置補正)", token: "animate:flip — spring-spatial-default" },
      ],
    },
    {
      id: "ticker",
      tab: "テロップ",
      title: "テロップの走行・フェード・high tint・続報バッジ",
      entries: [
        { name: "走行 (右→左スクロール) と栞・フェード", token: "TickerLane (実運用の enqueue 経路)" },
        { name: "high レーンの反転強調 tint", token: "emphasis=high (frameLevel critical)" },
        { name: "続報バッジ (同 groupKey の上書き投入)", token: "REVISION_BADGE_MS TTL" },
      ],
    },
  ];

  let group = $state<GroupId>("standby");
  const activeGroup = $derived(GROUPS.find((g) => g.id === group) ?? GROUPS[0]);

  // ── 全域の空気 (tier・dim)。data-tier は root <main> に置き、theme.css の main[data-tier] 経由で
  //    --num-weight を切り替える (パネル数字のウェイトスウェルの入力)。TierOverlay の色面 tint と
  //    dim は下の stage に効く。「空気」グループは独立タブにせず、常時操作できる横断コントロールにする。
  let tier = $state<DisplaySeverityTier>("calm");
  let dim = $state(false);
  const TIERS: DisplaySeverityTier[] = ["calm", "caution", "alert", "critical"];

  // 時計 (待機画面が要求する now)
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  // prefers-reduced-motion 購読 (PreviewApp / 各コンポーネントと同型)。画面遷移の duration を
  // 0ms にするために使う。matchMedia は JS から上書きできないため、コンポーネント内部の
  // reduced-motion 追従は OS 設定でのみ切り替わる (下部の注記参照)。
  let reducedMotion = $state(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
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
  const enterDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_QUICK_MS);
  const calmDur = $derived(reducedMotion ? 0 : SPRING_EFFECTS_SLOW_MS);
  const exitDur = $derived(reducedMotion ? 0 : EXIT_MS);

  // ── グループ: 画面遷移 (待機⇄緊急) ─────────────────────────────────────
  let transitionMode = $state<"standby" | "emergency">("standby");
  const transitionSnapshot = standbySnapshot({ recentQuakes: recentQuakesRich });
  const transitionPanels: EmergencyPanelModel[] = [
    { key: "tsunami:transition", input: tsunamiWarningInput },
    { key: "eew:transition", input: eewWarningInput },
  ];

  // ── グループ: 待機カード (corner in/out + FLIP、統計行 FLIP) ────────────
  let stbTsunami = $state(false);
  let stbQuake = $state(false);
  let stbWeather = $state(false);
  let stbHasRecent = $state(true); // 地震カード有⇄無 = 統計行 FLIP の唯一の入力
  const standbyDemoSnapshot = $derived(
    standbySnapshot({
      tsunami: stbTsunami ? tsunamiBannerDemoted : null,
      latestQuake: stbQuake ? latestQuakeStandbyCards : null,
      weatherAlerts: stbWeather ? weatherAlertsStandbyCards : [],
      stats: statsStandbyCards,
      recentQuakes: stbHasRecent ? recentQuakes : [],
    }),
  );

  // ── グループ: 緊急パネル (追加・削除) ──────────────────────────────────
  // 初期は 1 枚。EmergencyScreen は枚数増減をグリッド track 補間 (grid-template の CSS transition) で
  // 表現するため、追加/削除するとパネルがグリッド展開/収縮で入退場する (production と同じ挙動)。
  const ALL_PANELS: EmergencyPanelModel[] = [
    { key: "quake:catalog", input: largeQuakeInput },
    { key: "tsunami:catalog", input: tsunamiWarningInput },
    { key: "eew:catalog", input: eewWarningInput },
  ];
  let panelCount = $state(1);
  const emergencyPanels = $derived(ALL_PANELS.slice(0, panelCount));

  // ── グループ: 数値 (RollingNumber) ───────────────────────────────────
  // 単一 EewPanel の値を差し替えると、RollingNumber が桁ロール + 着地ウェイト強調を発火する。
  let numMag = $state("7.1");
  let numDepth = $state("20km");
  let numMaxInt = $state("6弱");
  let numSerial = $state(8);
  const NUM_STEPS = [
    { mag: "7.1", depth: "20km", maxInt: "6弱" },
    { mag: "7.3", depth: "18km", maxInt: "6強" },
    { mag: "7.6", depth: "24km", maxInt: "7" },
    { mag: "6.9", depth: "30km", maxInt: "5強" },
  ];
  let numStep = 0;
  function injectFollowup(): void {
    numStep = (numStep + 1) % NUM_STEPS.length;
    const s = NUM_STEPS[numStep];
    numMag = s.mag;
    numDepth = s.depth;
    numMaxInt = s.maxInt;
    numSerial += 1;
  }
  const numbersInput = $derived<DisplayEewInputV1>({
    ...eewWarningInput,
    magnitude: numMag,
    depth: numDepth,
    forecastMaxInt: numMaxInt,
    serial: String(numSerial),
  });
  const numbersPanels = $derived<EmergencyPanelModel[]>([{ key: "eew:numbers", input: numbersInput }]);

  // ── グループ: 続報チップ (QuakePanel reveal + weight swell) ──────────────
  // 初期は全チップ無し (largeQuakeInput の maxLgInt="3" 等を明示的に打ち消す) にして、後から
  // トグルした要素が reveal で入場するようにする。震央名の weight swell は上の tier ボタンで発火。
  let chipTsunami = $state(false);
  let chipOrigin = $state(false);
  let chipLgInt = $state(false);
  let chipCritical = $state(false);
  const chipsInput = $derived<DisplayLargeQuakeInputV1>({
    ...largeQuakeInput,
    tsunamiWarning: chipTsunami,
    originTime: chipOrigin ? "2026-07-07T14:20:00+09:00" : null,
    maxLgInt: chipLgInt ? "3" : null,
    maxInt: chipCritical ? "6強" : "5強",
    maxIntRank: chipCritical ? 8 : 6,
  });
  const chipsPanels = $derived<EmergencyPanelModel[]>([{ key: "quake:chips", input: chipsInput }]);

  // ── グループ: 津波行 (TsunamiPanel reveal/height/FLIP) ──────────────────
  const TS_COASTS: DisplayTsunamiInputV1["coasts"] = [
    { name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
    { name: "大分県瀬戸内海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時10分頃" },
    { name: "愛媛県宇和海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時20分頃" },
    { name: "鹿児島県東部", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
    { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時30分頃" },
    { name: "徳島県", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時40分頃" },
  ];
  let tsCount = $state(2);
  let tsReversed = $state(false);
  const tsCoasts = $derived.by((): DisplayTsunamiInputV1["coasts"] => {
    const slice = TS_COASTS.slice(0, tsCount);
    return tsReversed ? [...slice].reverse() : slice;
  });
  const tsunamiDemoInput = $derived<DisplayTsunamiInputV1>({ ...tsunamiWarningInput, coasts: tsCoasts });
  const tsunamiPanels = $derived<EmergencyPanelModel[]>([{ key: "tsunami:rows", input: tsunamiDemoInput }]);

  // ── グループ: テロップ ────────────────────────────────────────────────
  // Ticker は実運用と同じ enqueue 経路を通す (tickerGeneration 据え置きのまま lines へ追加)。
  // リセット時だけ generation を進めてスケジューラを全 reset する。
  let tickerGen = $state(0);
  let tickerFeed = $state<DisplayEventDtoV1[]>([]);
  const tickerNormal = (): DisplayEventDtoV1 =>
    tickerLine({
      id: `cat-normal-${Date.now()}`,
      role: "normal",
      frameLevel: "normal",
      text: "[通常] 震源・震度情報 宮城県沖 M4.8 震度3",
      title: "震源・震度情報",
      domain: "quake",
      type: "VXSE53",
      tickerCategory: "地震情報",
      tickerSentence: "宮城県沖でマグニチュード4.8の地震。石巻市で最大震度3を観測しています。",
      tickerPriority: "low",
    });
  const tickerHigh = (): DisplayEventDtoV1 =>
    tickerLine({
      id: `cat-high-${Date.now()}`,
      groupKey: "cat-high",
      role: "eewWarning",
      frameLevel: "critical",
      text: "[重大] 緊急地震速報(警報) 日向灘 M7.1 最大震度6弱",
      title: "緊急地震速報(警報)",
      domain: "eew",
      type: "VXSE45",
      tickerCategory: "緊急地震速報",
      tickerSentence: "緊急地震速報 第3報: 日向灘でM7.1の地震。予想最大震度6弱、強い揺れに警戒。",
      tickerPriority: "high",
    });
  const tickerTip = (): DisplayEventDtoV1 =>
    tickerLine({
      id: `cat-tip-${Date.now()}`,
      role: "info",
      frameLevel: "info",
      text: "津波は必ずしも最初の波が最大とは限りません。後から来る波の方が高いこともあります。",
      title: "豆知識",
      domain: "system",
      type: "tip",
      tickerCategory: "豆知識",
      tickerSentence:
        "津波は必ずしも最初の波が最大とは限りません。後から来る波の方が高いこともあります。",
      tickerPriority: "low",
    });
  const tickerRevision = (): DisplayEventDtoV1 =>
    tickerLine({
      id: `cat-high-rev-${Date.now()}`,
      groupKey: "cat-high",
      role: "eewWarning",
      frameLevel: "critical",
      text: "[重大] 緊急地震速報(警報) 日向灘 M7.3 最大震度6強",
      title: "緊急地震速報(警報)",
      domain: "eew",
      type: "VXSE45",
      tickerCategory: "緊急地震速報",
      tickerSentence: "緊急地震速報 第4報: 日向灘でM7.3に更新。予想最大震度6強、厳重に警戒。",
      tickerPriority: "high",
    });
  function pushTicker(line: DisplayEventDtoV1): void {
    tickerFeed = [line, ...tickerFeed]; // lines は新しい順
  }
  function resetTicker(): void {
    tickerFeed = [];
    tickerGen += 1; // generation を進めてスケジューラを全 reset
  }
</script>

<main class="catalog" data-tier={tier}>
  <div class="catalog-body">
    <aside class="rail">
      <div class="rail-section">
        <h2 class="rail-title">アニメーションカタログ</h2>
        <p class="rail-sub">本物のコンポーネントを本物の motion トークンで発火する操作盤</p>
      </div>

      <div class="rail-section">
        <span class="rail-label">空気 (全域)</span>
        <div class="btn-row">
          {#each TIERS as t (t)}
            <button type="button" class="chip-btn" class:active={tier === t} onclick={() => (tier = t)}>{t}</button>
          {/each}
        </div>
        <div class="btn-row">
          <button type="button" class="chip-btn" class:active={dim} onclick={() => (dim = !dim)}>減光 dim</button>
        </div>
      </div>

      <div class="rail-section">
        <span class="rail-label">グループ</span>
        <div class="tab-col">
          {#each GROUPS as g (g.id)}
            <button type="button" class="tab-btn" class:active={group === g.id} onclick={() => (group = g.id)}
              >{g.tab}</button
            >
          {/each}
        </div>
      </div>

      <div class="rail-section rail-controls">
        <span class="rail-label">操作</span>
        {#if group === "transition"}
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={() => (transitionMode = transitionMode === "standby" ? "emergency" : "standby")}
              >待機 ⇄ 緊急 を切替 (現在: {transitionMode === "standby" ? "待機" : "緊急"})</button
            >
          </div>
        {:else if group === "standby"}
          <div class="btn-row">
            <button type="button" class="act-btn" class:active={stbHasRecent} onclick={() => (stbHasRecent = !stbHasRecent)}
              >地震カード 有⇄無 (統計行 FLIP)</button
            >
          </div>
          <div class="btn-row">
            <button type="button" class="chip-btn" class:active={stbTsunami} onclick={() => (stbTsunami = !stbTsunami)}>津波バナー</button>
            <button type="button" class="chip-btn" class:active={stbQuake} onclick={() => (stbQuake = !stbQuake)}>地震カード(左上)</button>
            <button type="button" class="chip-btn" class:active={stbWeather} onclick={() => (stbWeather = !stbWeather)}>気象カード</button>
          </div>
        {:else if group === "panels"}
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={() => (panelCount = Math.min(3, panelCount + 1))}>パネル追加</button>
            <button type="button" class="act-btn" onclick={() => (panelCount = Math.max(1, panelCount - 1))}>パネル削除</button>
            <button type="button" class="chip-btn" onclick={() => (panelCount = 1)}>リセット</button>
          </div>
          <span class="rail-hint">現在 {panelCount} 枚 (最大 3)</span>
        {:else if group === "numbers"}
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={injectFollowup}>続報を注入 (M・深さ・震度を更新)</button>
          </div>
          <span class="rail-hint">第{numSerial}報 / M{numMag} / 深さ{numDepth} / 最大{numMaxInt}</span>
        {:else if group === "chips"}
          <div class="btn-row">
            <button type="button" class="chip-btn" class:active={chipTsunami} onclick={() => (chipTsunami = !chipTsunami)}>津波チップ</button>
            <button type="button" class="chip-btn" class:active={chipOrigin} onclick={() => (chipOrigin = !chipOrigin)}>発生時刻チップ</button>
            <button type="button" class="chip-btn" class:active={chipLgInt} onclick={() => (chipLgInt = !chipLgInt)}>長周期タイル</button>
          </div>
          <div class="btn-row">
            <button type="button" class="chip-btn" class:active={chipCritical} onclick={() => (chipCritical = !chipCritical)}
              >最大震度 5強⇄6強 (ヘッダ critical)</button
            >
          </div>
          <span class="rail-hint">ウェイトスウェルは上の tier を alert/critical へ</span>
        {:else if group === "tsunami"}
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={() => (tsCount = Math.min(TS_COASTS.length, tsCount + 1))}>予報区を追加</button>
            <button type="button" class="act-btn" onclick={() => (tsCount = Math.max(1, tsCount - 1))}>予報区を削除</button>
          </div>
          <div class="btn-row">
            <button type="button" class="chip-btn" class:active={tsReversed} onclick={() => (tsReversed = !tsReversed)}>並べ替え (FLIP)</button>
            <button type="button" class="chip-btn" onclick={() => { tsCount = 2; tsReversed = false; }}>リセット</button>
          </div>
          <span class="rail-hint">現在 {tsCount} 予報区</span>
        {:else if group === "ticker"}
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={() => pushTicker(tickerTip())}>Tip を投入</button>
            <button type="button" class="act-btn" onclick={() => pushTicker(tickerNormal())}>通常を投入</button>
            <button type="button" class="act-btn" onclick={() => pushTicker(tickerHigh())}>high を投入 (tint)</button>
          </div>
          <div class="btn-row">
            <button type="button" class="act-btn" onclick={() => pushTicker(tickerRevision())}>続報を上書き投入 (バッジ)</button>
            <button type="button" class="chip-btn" onclick={resetTicker}>クリア</button>
          </div>
          <span class="rail-hint">巡回・割込みなど作り込んだ時系列は各テロップシーンへ:</span>
          <div class="link-row">
            <a href="#ticker-conveyor">conveyor</a>
            <a href="#ticker-interrupt">interrupt</a>
            <a href="#ticker-revision">revision</a>
            <a href="#ticker-highx2">highx2</a>
            <a href="#ticker-cycle">cycle</a>
            <a href="#ticker-longrun">longrun</a>
          </div>
        {/if}
      </div>

      <div class="rail-section rail-note">
        <span class="rail-label">reduced-motion</span>
        <p class="rail-hint">
          コンポーネント内部の reduced-motion は matchMedia 直読みで JS から上書きできないため、OS の
          「視差効果を減らす / アニメーションを減らす」設定で切り替えて確認する
          (現在: {reducedMotion ? "有効" : "無効"})。
        </p>
      </div>
    </aside>

    <section class="stage-wrap">
      <div class="stage" data-tier={tier}>
        <div class="screen-area" class:with-ticker={group === "ticker"}>
          {#if group === "transition"}
            {#if transitionMode === "standby"}
              <div class="screen-layer" data-kind="standby" in:fade={{ duration: calmDur }} out:fade={{ duration: exitDur }}>
                <StandbyScreen snapshot={transitionSnapshot} {now} {dim} sseConnected={true} />
              </div>
            {:else}
              <div class="screen-layer" data-kind="emergency" in:emergencyEnter={{ duration: enterDur }} out:fade={{ duration: calmDur }}>
                <EmergencyScreen panels={transitionPanels} />
              </div>
            {/if}
          {:else if group === "standby"}
            <StandbyScreen snapshot={standbyDemoSnapshot} {now} {dim} sseConnected={true} />
          {:else if group === "panels"}
            <EmergencyScreen panels={emergencyPanels} />
          {:else if group === "numbers"}
            <EmergencyScreen panels={numbersPanels} />
          {:else if group === "chips"}
            <EmergencyScreen panels={chipsPanels} />
          {:else if group === "tsunami"}
            <EmergencyScreen panels={tsunamiPanels} />
          {:else if group === "ticker"}
            <StandbyScreen snapshot={transitionSnapshot} {now} {dim} sseConnected={true} />
          {/if}
        </div>
        {#if group === "ticker"}
          <div class="ticker-frame">
            <Ticker lines={tickerFeed} tickerGeneration={tickerGen} {dim} />
          </div>
        {/if}
        <TierOverlay {tier} />
      </div>

      <div class="caption">
        <h3 class="caption-title">{activeGroup.title}</h3>
        <ul class="caption-list">
          {#each activeGroup.entries as e (e.name)}
            <li><span class="entry-name">{e.name}</span><span class="entry-token">{e.token}</span></li>
          {/each}
        </ul>
      </div>
    </section>
  </div>
</main>

<style>
  .catalog {
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
  }
  .catalog-body {
    display: flex;
    width: 100%;
    height: 100%;
  }
  /* ── 左の操作レール ── */
  .rail {
    flex: 0 0 300px;
    height: 100%;
    overflow-y: auto;
    padding: var(--space-4) var(--space-5);
    background: var(--surface-low);
    border-right: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .rail-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .rail-title {
    margin: 0;
    font-size: var(--type-title-m-size);
    font-weight: var(--type-title-weight-emphasized);
  }
  .rail-sub {
    margin: 0;
    font-size: var(--type-label-m-size);
    color: var(--role-muted);
    line-height: 1.4;
  }
  .rail-label {
    font-size: var(--type-label-s-size);
    letter-spacing: 0.12em;
    color: var(--role-muted);
    text-transform: uppercase;
  }
  .rail-hint {
    font-size: var(--type-label-m-size);
    color: var(--role-muted);
    line-height: 1.4;
  }
  .rail-controls {
    min-height: 140px;
  }
  .rail-note {
    margin-top: auto;
  }
  .btn-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .link-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .link-row a {
    font-size: var(--type-label-m-size);
    color: var(--role-eewForecast, #8ab4f8);
    text-decoration: underline;
  }
  .tab-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  button {
    font: inherit;
    cursor: pointer;
    border-radius: var(--radius-s);
    border: 1px solid var(--hairline);
    background: var(--surface-panel);
    color: var(--fg);
    padding: 6px 10px;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  button:hover {
    border-color: var(--role-muted);
  }
  .tab-btn {
    text-align: left;
  }
  .tab-btn.active {
    background: var(--surface-panel-raised);
    border-color: var(--fg);
    font-weight: var(--type-body-weight-emphasized);
  }
  .chip-btn {
    font-size: var(--type-label-m-size);
    padding: 4px 10px;
  }
  .chip-btn.active,
  .act-btn.active {
    background: var(--surface-panel-raised);
    border-color: var(--fg);
  }
  .act-btn {
    font-size: var(--type-label-l-size);
    text-align: left;
  }

  /* ── 右のステージ ── */
  .stage-wrap {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    overflow: hidden;
  }
  /* PreviewApp / App.svelte と同じ「flex:1 で確定サイズを受け取る画面枠」構造にする
     (aspect-ratio + transform の組合せは緊急パネルの実測系と相性が悪く再帰を誘発したため使わない)。
     TierOverlay (position:fixed) は contain で containing block をステージに閉じ込める (カタログ
     全画面ではなくステージ内だけを tint する。transform を使わない containment)。 */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-m);
    overflow: hidden;
    contain: layout paint;
  }
  .screen-area {
    position: absolute;
    inset: 0;
  }
  /* テロップグループのときだけ下端にテロップ帯ぶんの余白を空ける (App.svelte / PreviewApp と同値) */
  .screen-area.with-ticker {
    bottom: calc(var(--ticker-row-h) * var(--ticker-rows));
  }
  /* 待機層・緊急層を重ねる (App.svelte / PreviewApp と同期、stacking を z-index で明示) */
  .screen-layer {
    position: absolute;
    inset: 0;
  }
  .screen-layer[data-kind="emergency"] {
    z-index: 2;
  }
  .screen-layer[data-kind="standby"] {
    z-index: 1;
  }
  .ticker-frame {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: calc(var(--ticker-row-h) * var(--ticker-rows));
    background: var(--bg);
  }

  /* ── ステージ下のラベル ── */
  .caption {
    flex: 0 0 auto;
  }
  .caption-title {
    margin: 0 0 var(--space-2);
    font-size: var(--type-title-s-size);
    font-weight: var(--type-title-weight-emphasized);
  }
  .caption-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .caption-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-3);
    font-size: var(--type-label-m-size);
  }
  .entry-name {
    color: var(--fg);
  }
  .entry-token {
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
