<script lang="ts">
  import type { EmergencyPanelModel } from "../lib/derive";
  import type { DisplayEventDtoV1, DisplayLargeQuakeInputV1, DisplayTsunamiInputV1 } from "../lib/protocol";
  import StandbyScreen from "../components/StandbyScreen.svelte";
  import EmergencyScreen from "../components/EmergencyScreen.svelte";
  import Ticker from "../components/Ticker.svelte";
  import TierOverlay from "../components/TierOverlay.svelte";
  import MotionCatalog from "./MotionCatalog.svelte";
  import { fade } from "svelte/transition";
  import { emergencyEnter } from "../lib/transitions";
  import { SPRING_SPATIAL_QUICK_MS, SPRING_EFFECTS_SLOW_MS, EXIT_MS } from "../lib/motion";
  import {
    standbySnapshot,
    recentQuakesRich,
    tickerLines,
    eewWarningInput,
    eewForecastInput,
    tsunamiMajorInput,
    tsunamiWarningInput,
    largeQuakeInput,
    tsunamiBannerDemoted,
    weatherAlertsStandbyCards,
    weatherWarningOnlyStandbyCards,
    weatherAdvisoryOnlyStandbyCards,
    latestQuakeStandbyCards,
    statsStandbyCards,
    stressSnapshot,
    eewStressInput,
    tsunamiStressInput,
    largeQuakeStressInput,
    nankaiSnapshot,
    eewNankaiInput,
    tsunamiNankaiInput,
    largeQuakeNankaiInput,
    longBodyStandbySnapshot,
    tickerLinesConveyor,
    tickerLinesInterruptBase,
    tickerInterruptHigh,
    tickerRevisionV1,
    tickerRevisionV2,
    tickerRevisionV3,
    tickerLinesHighX2,
    tickerLinesCycleSparse,
    tickerLinesLongRun,
    tickerLine,
  } from "./fixtures";
  import { createTipsFeeder } from "../lib/tips-feeder.svelte";

  const SCENARIOS = [
    "standby-quiet",
    "standby-rich",
    "standby-dim",
    "standby-disconnected",
    "standby-tsunami",
    "standby-cards",
    "standby-tier-critical",
    "standby-weather-warning",
    "standby-weather-advisory",
    "standby-stress",
    "standby-nankai",
    "standby-longbody",
    "emergency-1",
    "emergency-2",
    "emergency-3",
    "emergency-stress",
    "emergency-nankai",
    "motion-enter",
    "motion-panels",
    "motion-card-grow",
    "ticker-roles",
    "ticker-visual",
    "ticker-conveyor",
    "ticker-interrupt",
    "ticker-revision",
    "ticker-highx2",
    "ticker-cycle",
    "ticker-longrun",
    "ticker-tips",
    "motion-catalog",
  ] as const;
  type Scenario = (typeof SCENARIOS)[number];

  function parseScenario(hash: string): Scenario {
    const name = hash.replace(/^#/, "");
    return (SCENARIOS as readonly string[]).includes(name) ? (name as Scenario) : "standby-quiet";
  }

  let scenario = $state<Scenario>(parseScenario(window.location.hash));
  let now = $state(new Date());
  const showNav = new URLSearchParams(window.location.search).get("nav") !== "0";

  const PREVIEW_TIPS = [
    "震度は「ある場所の揺れの強さ」、マグニチュードは「地震そのものの規模」です。",
    "津波は必ずしも最初の波が最大とは限りません。後から来る波の方が高いこともあります。",
    "日本には111の活火山があり、世界の活火山の約7%が集中しています。",
  ];

  // ticker-tips シナリオ: 電文テロップ空 + 本物 feeder (Ticker の onJobComplete で連続供給、実時間で確認)
  const tipsFeeder = createTipsFeeder({
    eligible: () => scenario === "ticker-tips",
    fetchTips: async () => PREVIEW_TIPS,
  });
  $effect(() => () => tipsFeeder.destroy());

  $effect(() => {
    const onHashChange = () => {
      scenario = parseScenario(window.location.hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  $effect(() => {
    const id = setInterval(() => {
      now = new Date();
    }, 1000);
    return () => clearInterval(id);
  });

  // モーション振り付けシーン (#motion-enter / #motion-panels / #motion-card-grow) の時間駆動状態。
  // motionStep を一定間隔で進め、各シーンの派生 (mode/panels) が step から状態を決める
  // (PreviewApp.svelte:70-75 の now 更新と同流儀、cleanup で clearInterval)。
  const MOTION_STEP_MS = 2600;
  let motionStep = $state(0);
  const isMotionScene = $derived(
    scenario === "motion-enter" || scenario === "motion-panels" || scenario === "motion-card-grow",
  );
  $effect(() => {
    if (!isMotionScene) return;
    motionStep = 0;
    const id = setInterval(() => {
      motionStep += 1;
    }, MOTION_STEP_MS);
    return () => clearInterval(id);
  });

  // 画面遷移トランジションの duration (App.svelte と同値)。切替後開始分が reduced-motion で 0ms。
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
  const enterDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_QUICK_MS);
  const calmDur = $derived(reducedMotion ? 0 : SPRING_EFFECTS_SLOW_MS);
  const exitDur = $derived(reducedMotion ? 0 : EXIT_MS);

  const quietSnapshot = standbySnapshot();
  const richSnapshot = standbySnapshot({ recentQuakes: recentQuakesRich });
  const tsunamiBannerSnapshot = standbySnapshot({ tsunami: tsunamiBannerDemoted });
  // standby-cards: 気象警報カード + 地震情報カード (headline・地区別震度2グループ・津波マーク) + 計器列 +
  // 津波継続バナーを同時に出し、左上の縦スタック (津波→地震) を確認できるようにする
  const cardsSnapshot = standbySnapshot({
    tsunami: tsunamiBannerDemoted,
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
  });
  // standby-tier-critical: 上と同内容 + severityTier critical (tier overlay の紫の空気 + 数字ウェイト800)
  const cardsTierCriticalSnapshot = standbySnapshot({
    tsunami: tsunamiBannerDemoted,
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
    severityTier: "critical",
  });
  // B2a 目視用: 気象警報/注意報のみのヘッダ container を単独確認する
  const weatherWarningSnapshot = standbySnapshot({ weatherAlerts: weatherWarningOnlyStandbyCards });
  const weatherAdvisorySnapshot = standbySnapshot({ weatherAlerts: weatherAdvisoryOnlyStandbyCards });
  // #standby-stress: 3.11 級ストレステスト (津波継続バナー大量地域 + 地震情報カード + 気象カード)
  const stressStandbySnapshot = stressSnapshot();
  // #standby-nankai: 南海トラフ巨大地震想定ストレステスト (発生5分後、津波継続バナー17予報区 + 震度7 153市町村)
  const nankaiStandbySnapshot = nankaiSnapshot();

  // #motion-enter は待機↔緊急を motionStep で往復する。他の motion シーンは常時緊急。
  const motionEnterEmergency = $derived(scenario === "motion-enter" && motionStep % 2 === 1);
  const mode = $derived(
    scenario === "emergency-1" ||
      scenario === "emergency-2" ||
      scenario === "emergency-3" ||
      scenario === "emergency-stress" ||
      scenario === "emergency-nankai" ||
      scenario === "motion-panels" ||
      scenario === "motion-card-grow" ||
      motionEnterEmergency
      ? "emergency"
      : "standby",
  );
  const snapshot = $derived(
    scenario === "standby-weather-warning"
      ? weatherWarningSnapshot
      : scenario === "standby-weather-advisory"
        ? weatherAdvisorySnapshot
        : scenario === "standby-rich"
          ? richSnapshot
          : scenario === "standby-tsunami"
            ? tsunamiBannerSnapshot
            : scenario === "standby-cards" || scenario === "standby-dim"
              ? cardsSnapshot
              : scenario === "standby-tier-critical"
                ? cardsTierCriticalSnapshot
                : scenario === "standby-stress"
                  ? stressStandbySnapshot
                  : scenario === "standby-nankai"
                    ? nankaiStandbySnapshot
                    : quietSnapshot,
  );
  const dim = $derived(scenario === "standby-dim");
  // standby-rich は数字チップ・深さ・時刻・津波マークに加え、切断バッジの見た目も一望できるようにする
  const sseConnected = $derived(scenario !== "standby-disconnected" && scenario !== "standby-rich");

  const emergencyPanels = $derived.by((): EmergencyPanelModel[] => {
    if (scenario === "emergency-1") {
      return [{ key: "eew:demo1", input: eewWarningInput }];
    }
    if (scenario === "emergency-2") {
      return [
        { key: "tsunami:demo1", input: tsunamiWarningInput },
        { key: "eew:demo2", input: eewForecastInput },
      ];
    }
    if (scenario === "emergency-3") {
      return [
        { key: "tsunami:demo1", input: tsunamiMajorInput },
        { key: "eew:demo1", input: eewWarningInput },
        { key: "quake:demo1", input: largeQuakeInput },
      ];
    }
    if (scenario === "emergency-stress") {
      return [
        { key: "tsunami:stress", input: tsunamiStressInput },
        { key: "eew:stress", input: eewStressInput },
        { key: "quake:stress", input: largeQuakeStressInput },
      ];
    }
    if (scenario === "emergency-nankai") {
      return [
        { key: "tsunami:nankai", input: tsunamiNankaiInput },
        { key: "eew:nankai", input: eewNankaiInput },
        { key: "quake:nankai", input: largeQuakeNankaiInput },
      ];
    }
    if (scenario === "motion-enter") {
      // 待機↔緊急の往復。緊急側は初期パネル群 (パネル外枠は opacity を触らず frame-1 可視、
      // 画面レベルの入場は emergencyEnter が担う)。rAF ゲートの検査対象を含む
      return [
        { key: "tsunami:enter", input: tsunamiMajorInput },
        { key: "eew:enter", input: eewWarningInput },
        { key: "quake:enter", input: largeQuakeInput },
      ];
    }
    if (scenario === "motion-panels") {
      // パネル 1→2→3→2→1: 枚数増減はグリッド track 補間で入場/退場を表現、並べ替えは translate-only FLIP、削除は瞬時退場
      const seq = [1, 2, 3, 2, 1];
      const count = seq[motionStep % seq.length];
      const all: EmergencyPanelModel[] = [
        { key: "quake:panels", input: largeQuakeInput },
        { key: "tsunami:panels", input: tsunamiWarningInput },
        { key: "eew:panels", input: eewWarningInput },
      ];
      return all.slice(0, count);
    }
    if (scenario === "motion-card-grow") {
      // 緊急のまま stat タイル/予報区行を増減。後発要素は revealScaleIn + heightReveal、
      // 兄弟は FLIP。パネル自体のキーは固定 (中身だけ増減) して card 内の reveal を見る
      const grow = motionStep % 4; // 0..3
      const coastCount = [2, 4, 6, 4][grow];
      const quake: DisplayLargeQuakeInputV1 = {
        ...largeQuakeInput,
        maxLgInt: grow >= 1 ? "3" : null,
        tsunamiWarning: grow >= 2,
        originTime: grow >= 3 ? "2026-07-07T09:58:00+09:00" : null,
      };
      const tsunami: DisplayTsunamiInputV1 = {
        ...tsunamiWarningInput,
        coasts: motionCoasts(coastCount),
      };
      return [
        { key: "quake:cardgrow", input: quake },
        { key: "tsunami:cardgrow", input: tsunami },
      ];
    }
    return [];
  });

  function motionCoasts(n: number): DisplayTsunamiInputV1["coasts"] {
    const names = ["岩手県", "宮城県", "福島県", "青森県", "北海道", "茨城県"];
    return Array.from({ length: n }, (_, i) => ({
      name: names[i % names.length],
      kind: "津波警報",
      maxHeight: `${i + 1}m`,
      firstHeight: "10時20分頃",
    }));
  }

  // rAF 自己検査ゲート (spec §5 / §3 検証 3)。#motion-enter で mode が緊急に変わったら、Svelte の
  // DOM 更新後 ($effect のタイミング) に 1 回だけ rAF して frame-1 可視・stacking・領域内を検査し、
  // 結果を root の data-motion-gate 属性 + console に残す。外部ツールに依存せず再現可能にする。
  function describeEl(el: Element): string {
    const kind = el.getAttribute("data-kind");
    return `${el.tagName.toLowerCase()}${kind != null ? `[${kind}]` : ""}.${el.className || "-"}`;
  }
  function runMotionGate(): void {
    const root = document.querySelector("main");
    const screenArea = document.querySelector(".screen-area");
    if (root == null || screenArea == null) return;
    const areaRect = screenArea.getBoundingClientRect();
    const failures: string[] = [];

    const emergencyLayer = document.querySelector('.screen-layer[data-kind="emergency"]');
    const standbyLayer = document.querySelector('.screen-layer[data-kind="standby"]');
    const scaleEls = Array.from(document.querySelectorAll('[data-motion-reveal="scale"]'));
    const heightEls = Array.from(document.querySelectorAll('[data-motion-reveal="height"]'));

    // 1. 全 scale 対象 (緊急レイヤー・内側 body・初期パネル/カード要素) の computed opacity === "1"
    for (const el of scaleEls) {
      const op = getComputedStyle(el).opacity;
      if (op !== "1") failures.push(`scale opacity=${op} on ${describeEl(el)}`);
    }
    // 2. 全 height wrapper が自然高で全開しているか (初期要素が誤って潰れていないか)。
    //    getBoundingClientRect は emergencyEnter の scale 変形で縮むため、layout 値の
    //    offsetHeight/scrollHeight で比較する (transform 非依存)。0 でないこと + 途中開き
    //    (offsetHeight < scrollHeight) の誤 reveal も許容差 1px で捕まえる (レビュー指摘 Medium 2)。
    for (const el of heightEls) {
      const he = el as HTMLElement;
      if (he.offsetHeight < 0.5) {
        failures.push(`height≈0 on ${describeEl(el)}`);
      } else if (he.scrollHeight - he.offsetHeight > 1) {
        failures.push(`height not fully open (${he.offsetHeight}/${he.scrollHeight}) on ${describeEl(el)}`);
      }
    }
    // 3. 緊急レイヤーの実効 z-index > 待機レイヤー
    if (emergencyLayer == null) {
      failures.push("emergency layer not found");
    } else {
      const ez = Number(getComputedStyle(emergencyLayer).zIndex) || 0;
      const sz = standbyLayer != null ? Number(getComputedStyle(standbyLayer).zIndex) || 0 : 0;
      if (!(ez > sz)) failures.push(`z-index emergency(${ez}) !> standby(${sz})`);
    }
    // 4. 全対象の rect が .screen-area 内 (画面外・テロップ領域へのはみ出しでない)
    for (const el of [...scaleEls, ...heightEls]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // 非表示要素はスキップ
      if (
        r.top < areaRect.top - 1 ||
        r.bottom > areaRect.bottom + 1 ||
        r.left < areaRect.left - 1 ||
        r.right > areaRect.right + 1
      ) {
        failures.push(`out of screen-area: ${describeEl(el)}`);
      }
    }

    const pass = failures.length === 0;
    root.setAttribute("data-motion-gate", pass ? "pass" : "fail");
    if (pass) console.info("[motion-gate] pass");
    else console.error("[motion-gate] fail", failures);
  }

  $effect(() => {
    if (scenario !== "motion-enter" || mode !== "emergency") return;
    if (typeof requestAnimationFrame !== "function") return;
    const raf = requestAnimationFrame(() => runMotionGate());
    return () => cancelAnimationFrame(raf);
  });

  // #ticker-visual 専用の固定イベント (high と続報は同 groupKey "tv-high")
  const tvLow = tickerLine({
    id: "tv-low", role: "normal", frameLevel: "normal",
    text: "[通常] 震源・震度情報 宮城県沖 M4.8 震度3", title: "震源・震度情報",
    domain: "quake", type: "VXSE53", tickerCategory: "地震情報",
    tickerSentence: "宮城県沖でマグニチュード4.8の地震。石巻市で最大震度3を観測しています。",
    tickerPriority: "low",
  });
  const tvHigh = tickerLine({
    id: "tv-high-1", groupKey: "tv-high", role: "eewWarning", frameLevel: "critical",
    text: "[重大] 緊急地震速報(警報) 日向灘 M7.1 最大震度6弱", title: "緊急地震速報(警報)",
    domain: "eew", type: "VXSE45", tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 第3報: 日向灘でM7.1の地震。予想最大震度6弱、強い揺れに警戒。",
    tickerPriority: "high",
  });
  const tvHighRevision = tickerLine({
    id: "tv-high-2", groupKey: "tv-high", role: "eewWarning", frameLevel: "critical",
    text: "[重大] 緊急地震速報(警報) 日向灘 M7.3 最大震度6強", title: "緊急地震速報(警報)",
    domain: "eew", type: "VXSE45", tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 第4報: 日向灘でM7.3に更新。予想最大震度6強、厳重に警戒。",
    tickerPriority: "high",
  });
  let visualFeed = $state<DisplayEventDtoV1[]>([tvLow]);
  $effect(() => {
    if (scenario !== "ticker-visual") return;
    visualFeed = [tvLow];
    const t1 = setTimeout(() => { visualFeed = [tvHigh, tvLow]; }, 1000); // high 追加 → tint
    const t2 = setTimeout(() => { visualFeed = [tvHighRevision, tvHigh, tvLow]; }, 2000); // 続報 → バッジ
    return () => { clearTimeout(t1); clearTimeout(t2); };
  });

  // #emergency-stress / #standby-stress / #emergency-nankai / #standby-nankai では
  // 長文テロップのストレス用データに差し替える
  const tickerFeed = $derived(
    scenario === "emergency-stress" || scenario === "standby-stress"
      ? stressStandbySnapshot.recentTicker
      : scenario === "emergency-nankai" || scenario === "standby-nankai"
        ? nankaiStandbySnapshot.recentTicker
        : scenario === "standby-longbody"
          ? longBodyStandbySnapshot().recentTicker
          : scenario === "ticker-visual"
            ? visualFeed
            : scenario === "ticker-conveyor"
              ? tickerLinesConveyor
              : scenario === "ticker-interrupt"
                ? interruptLines
                : scenario === "ticker-revision"
                  ? revisionLines
                  : scenario === "ticker-highx2"
                    ? tickerLinesHighX2
                    : scenario === "ticker-cycle"
                      ? tickerLinesCycleSparse
                      : scenario === "ticker-longrun"
                        ? tickerLinesLongRun
                        : scenario === "ticker-tips"
                          ? tipsFeeder.lines
                          : tickerLines,
  );

  // #ticker-interrupt: low 2本 (別groupKey、下段/上段を埋める) を base に、t+20s で
  // high (EEW警報) を追加投入する (確定タイムライン方式、Spec C Task 6 と同じ流儀)。
  // 上段 (lane0) に流用される長文 low (約200字、セグメント1個≈70字≈14秒) が栞1個を確実に
  // 通過し終えたタイミングで割込ませ、栞復帰 (頭からでなく途中再開) を目視で区別できるようにする。
  // tickerGeneration は据え置きのまま lines へ追加するので、Ticker.svelte 側は「新着 enqueue」
  // 経路 (実運用の割込みと同じ経路) を通る (fixtures.ts の tickerLinesInterruptBase コメント参照)。
  let interruptLines = $state<DisplayEventDtoV1[]>(tickerLinesInterruptBase);
  $effect(() => {
    if (scenario !== "ticker-interrupt") return;
    interruptLines = tickerLinesInterruptBase;
    const id = setTimeout(() => {
      interruptLines = [tickerInterruptHigh, ...tickerLinesInterruptBase];
    }, 20000);
    return () => clearTimeout(id);
  });

  // #ticker-revision: 同一 groupKey の続報を t=0 / +1000ms / +2000ms で 3 版投入する
  // (lines は新しい順につき新版を先頭へ unshift)。
  let revisionLines = $state<DisplayEventDtoV1[]>([tickerRevisionV1]);
  $effect(() => {
    if (scenario !== "ticker-revision") return;
    revisionLines = [tickerRevisionV1];
    const t1 = setTimeout(() => {
      revisionLines = [tickerRevisionV2, ...revisionLines];
    }, 1000);
    const t2 = setTimeout(() => {
      revisionLines = [tickerRevisionV3, ...revisionLines];
    }, 2000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  });

  // シーン切替 (hash 変更) のたびに走行中の旧ジョブを一掃する。SCENARIOS の位置を値に使う
  // (単調増加である必要はなく、直前の scenario と異なりさえすれば Ticker.svelte 側の
  // `gen !== lastGeneration` で全 reset がかかる、preview 専用の簡易対策)。
  const tickerGen = $derived(SCENARIOS.indexOf(scenario));
</script>

{#if showNav}
  <nav class="preview-nav">
    {#each SCENARIOS as s (s)}
      <a href={`#${s}`} class:active={s === scenario}>{s}</a>
    {/each}
  </nav>
{/if}
{#if scenario === "motion-catalog"}
  <MotionCatalog />
{:else}
<main data-tier={snapshot.severityTier}>
  <div class="screen-area">
    {#if mode === "standby"}
      <div
        class="screen-layer"
        data-kind="standby"
        in:fade={{ duration: calmDur }}
        out:fade={{ duration: exitDur }}
      >
        <StandbyScreen {snapshot} {now} {dim} {sseConnected} />
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
      lines={tickerFeed}
      now={mode === "emergency" ? now : null}
      tickerGeneration={tickerGen}
      {dim}
      onJobComplete={(key) => tipsFeeder.notifyComplete(key)}
    />
  </div>
  <TierOverlay tier={snapshot.severityTier} />
</main>
{/if}

<style>
  main {
    /* テロップ高さは theme.css の --ticker-row-h / --ticker-rows が真実源 (App.svelte と同値) */
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
  .screen-area {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: calc(var(--ticker-row-h) * var(--ticker-rows));
  }
  /* App.svelte と同期 (spec §2-a、§6 ソース検査): 待機層・緊急層を重ね z-index で stacking を明示。 */
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
  .preview-nav {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 1000;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.65);
  }
  .preview-nav a {
    font-size: 12px;
    color: #cccccc;
    text-decoration: none;
    white-space: nowrap;
  }
  .preview-nav a.active {
    color: #ffffff;
    font-weight: 700;
    text-decoration: underline;
  }
</style>
