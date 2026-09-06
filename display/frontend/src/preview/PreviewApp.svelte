<script lang="ts">
  import type { EmergencyPanelModel } from "../lib/derive";
  import type { DisplayEventDtoV1, DisplayLargeQuakeInputV1, DisplayStateSnapshotV1, DisplayTsunamiInputV1 } from "../lib/protocol";
  import StandbyScreen from "../components/StandbyScreen.svelte";
  import WeatherAlertCard from "../components/WeatherAlertCard.svelte";
  import EmergencyScreen from "../components/EmergencyScreen.svelte";
  import Ticker from "../components/Ticker.svelte";
  import TierOverlay from "../components/TierOverlay.svelte";
  import LegacyImprovedMock from "./LegacyImprovedMock.svelte";
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
    tsunamiBanner,
    weatherAlertsStandbyCards,
    syntheticWeatherKindAreaAlerts,
    syntheticWeatherKindAreaFooterBoundaryAlerts,
    weatherWarningOnlyStandbyCards,
    weatherAdvisoryOnlyStandbyCards,
    latestQuakeStandbyCards,
    standbyItemsShowcase,
    briefingStandbyItems,
    briefingPagingStandbyItems,
    briefingDesignAlignmentStandbyItems,
    legacyImprovedWeatherWarningForecast,
    vpta50ProbabilityMutedStandbyItems,
    vpta50ProbabilityNormalStandbyItems,
    designAlignmentCompressedStandbyItems,
    designAlignmentCompressedPayloadSignature,
    designAlignmentRiderReserveCounts,
    designAlignmentCompressedLatestQuake,
    designAlignmentCompressedWeatherExpandedKinds,
    legacyImprovedMaxWeatherAlerts,
    legacyImprovedMaxWeatherAlertsCompact,
    standbyItemsRightStackBudget,
    standbyItemsFloodWide,
    motionStandbyFloodPhases,
    statsStandbyCards,
    stressSnapshot,
    eewStressInput,
    tsunamiStressInput,
    largeQuakeStressInput,
    attentionVisibilityQuakeInput,
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
    weatherEmergencyInput,
    weatherSyncingInput,
    backgroundTonePreviewFixtures,
    legacyStandbyGateSnapshot,
    type LegacyStandbyGateScenario,
    type LegacyStandbyGateFixture,
  } from "./fixtures";
  import { createTipsFeeder } from "../lib/tips-feeder.svelte";

  const SCENARIOS = [
    "standby-quiet",
    "standby-rich",
    "standby-dim",
    "standby-disconnected",
    "standby-tsunami",
    "standby-cards",
    "standby-active-cards",
    "standby-briefing",
    "standby-briefing-pages",
    "standby-briefing-design-alignment",
    "standby-vpwp50-forecast",
    "standby-vpta50-probability-muted",
    "standby-vpta50-probability-normal",
    "standby-design-alignment-compressed",
    "standby-weather-kind-area",
    "standby-weather-kind-area-footer-boundary",
    "weatherAutoFooterNormal",
    "weatherAutoFooterCompressed",
    "standby-active-wide",
    "standby-right-stack-budget",
    "standby-tier-critical",
    "standby-weather-warning",
    "standby-weather-advisory",
    "standby-stress",
    "standby-nankai",
    "standby-longbody",
    "standby-attention-visibility",
    "standby-attention-visibility-dim",
    "standby-attention-visibility-critical",
    "standby-attention-visibility-reduced-motion",
    "attention-visibility-emergency",
    "emergency-1",
    "emergency-2",
    "emergency-3",
    "emergency-stress",
    "emergency-nankai",
    "emergency-weather",
    "emergency-weather-mix",
    "emergency-weather-syncing",
    "motion-enter",
    "motion-panels",
    "motion-card-grow",
    "motion-standby-flood",
    "ticker-roles",
    "ticker-visual",
    "ticker-conveyor",
    "ticker-interrupt",
    "ticker-revision",
    "ticker-highx2",
    "ticker-cycle",
    "ticker-longrun",
    "ticker-tips",
    "tone-matrix",
    "motion-catalog",
    "legacy-improved-mock",
  ] as const;
  type Scenario = (typeof SCENARIOS)[number];

  function parseScenario(hash: string): Scenario {
    const name = hash.replace(/^#/, "");
    return (SCENARIOS as readonly string[]).includes(name) ? (name as Scenario) : "standby-quiet";
  }

  let currentHash = $state(window.location.hash);
  let scenario = $state<Scenario>(parseScenario(window.location.hash));
  let now = $state(new Date());
  const showNav = new URLSearchParams(window.location.search).get("nav") !== "0";
  const gateScenarioParam = new URLSearchParams(window.location.search).get("gateScenario");
  const gateScenario: LegacyStandbyGateScenario = gateScenarioParam === "quiet" || gateScenarioParam === "7" || gateScenarioParam === "max" || gateScenarioParam === "max-floodWide"
    ? gateScenarioParam
    : "4";
  const legacyStandbyGate = $derived(currentHash === "#legacy-standby-gate");
  const gateFixture = $derived.by(() => {
    if (!legacyStandbyGate) return undefined;
    const value = new URLSearchParams(window.location.search).get("gateFixture");
    return value === "overflow" || value === "rotation" || value === "cluster" || value === "cluster-calm"
      || value === "tornado-pages" || value === "tornado-aggregate" || value === "tornado-clip" || value === "tornado-epoch-release" || value === "recent-quakes-narrow" || value === "attention-visibility-standby"
      || value === "briefing-pages" || value === "briefing-single-page" || value === "weather-kind-area" || value === "weather-kind-area-footer-boundary"
      ? value as LegacyStandbyGateFixture : undefined;
  });
  let standbyStage = $state<0 | 1 | 2 | 3>(0);
  const weatherAutoFooterProbe = $derived(scenario === "weatherAutoFooterNormal" || scenario === "weatherAutoFooterCompressed");
  const weatherAutoFooterCompressed = $derived(scenario === "weatherAutoFooterCompressed");
  const weatherAutoFooterRange = { start: 0, end: 1, tails: [], omittedAreaCount: 0 };

  const PREVIEW_TIPS = [
    "震度は「ある場所の揺れの強さ」、マグニチュードは「地震そのものの規模」です。",
    "津波は必ずしも最初の波が最大とは限りません。後から来る波の方が高いこともあります。",
    "日本には111の活火山があり、世界の活火山の約7%が集中しています。",
  ];

  // ticker-tips シナリオ: 電文テロップ空 + 本物 feeder (Ticker の onJobComplete で連続供給、実時間で確認)
  const tipsFeeder = createTipsFeeder({
    context: () => scenario === "ticker-tips" ? "standby" : "emergency",
    fetchTips: async () => PREVIEW_TIPS,
  });
  $effect(() => () => tipsFeeder.destroy());

  $effect(() => {
    const onHashChange = () => {
      currentHash = window.location.hash;
      scenario = parseScenario(currentHash);
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

  // モーション振り付けシーン (#motion-enter / #motion-panels / #motion-card-grow / #motion-standby-flood) の時間駆動状態。
  // motionStep を一定間隔で進め、各シーンの派生 (mode/panels) が step から状態を決める
  // (PreviewApp.svelte:70-75 の now 更新と同流儀、cleanup で clearInterval)。
  const MOTION_STEP_MS = 2600;
  let motionStep = $state(0);
  const isMotionScene = $derived(
    scenario === "motion-enter" ||
    scenario === "motion-panels" ||
    scenario === "motion-card-grow" ||
    scenario === "motion-standby-flood",
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
  const tsunamiBannerSnapshot = standbySnapshot({ tsunami: tsunamiBanner });
  // standby-cards: 気象警報カード + 地震情報カード (headline・地区別震度2グループ・津波マーク) + 計器列 +
  // 津波継続バナーを同時に出し、左上の縦スタック (津波→地震) を確認できるようにする
  const cardsSnapshot = standbySnapshot({
    tsunami: tsunamiBanner,
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
  });
  // standby-active-cards: 待機画面カード拡充 (standbyItems) の全種別同時 active。
  // 右上スタック (洪水3河川・火山・台風2・熱中症=復元中) + 竜巻 rider + 長周期 rider + 南海バッジ
  const activeCardsSnapshot = standbySnapshot({
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
    standbyItems: standbyItemsShowcase,
  });
  // standby-briefing: Phase 3 の card chrome。critical/warning の複数 entry、観測 fact、
  // VPOA50 の未確認 qualifier、取消を一枚の header と本文区切りで確認する。
  const briefingSnapshot = standbySnapshot({ standbyItems: briefingStandbyItems });
  const briefingPagingSnapshot = standbySnapshot({ standbyItems: briefingPagingStandbyItems });
  const briefingDesignAlignmentSnapshot = standbySnapshot({ standbyItems: briefingDesignAlignmentStandbyItems });
  const vpwp50ForecastSnapshot = standbySnapshot({ standbyItems: [legacyImprovedWeatherWarningForecast] });
  const vpta50ProbabilityMutedSnapshot = standbySnapshot({ standbyItems: vpta50ProbabilityMutedStandbyItems });
  const vpta50ProbabilityNormalSnapshot = standbySnapshot({ standbyItems: vpta50ProbabilityNormalStandbyItems });
  const designAlignmentCompressedSnapshot = standbySnapshot({
    tsunami: tsunamiBanner,
    latestQuake: designAlignmentCompressedLatestQuake,
    weatherAlerts: legacyImprovedMaxWeatherAlertsCompact,
    weatherExpandedKinds: designAlignmentCompressedWeatherExpandedKinds,
    standbyItems: designAlignmentCompressedStandbyItems,
  });
  const weatherKindAreaSnapshot = standbySnapshot({
    weatherAlerts: syntheticWeatherKindAreaAlerts,
    weatherExpandedKinds: legacyStandbyGateSnapshot("quiet", "weather-kind-area").weatherExpandedKinds,
  });
  const weatherKindAreaFooterBoundarySnapshot = standbySnapshot({
    weatherAlerts: syntheticWeatherKindAreaFooterBoundaryAlerts,
    weatherExpandedKinds: legacyStandbyGateSnapshot("quiet", "weather-kind-area-footer-boundary").weatherExpandedKinds,
  });
  // standby-active-wide: 洪水 5 河川で時計上ワイド表示へ移行した状態
  const activeWideSnapshot = standbySnapshot({
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
    standbyItems: standbyItemsFloodWide,
  });
  // standby-right-stack-budget: 実機再現 (720p 予算 + 気象カード + volcano/typhoon/heat×2)。
  // measurement shelf の実測選抜で全カードが visible になることを検証する (spec T3)
  const rightStackBudgetSnapshot = standbySnapshot({
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
    standbyItems: standbyItemsRightStackBudget,
  });
  // standby-tier-critical: 上と同内容 + severityTier critical (tier overlay の紫の空気 + 数字ウェイト800)
  const cardsTierCriticalSnapshot = standbySnapshot({
    tsunami: tsunamiBanner,
    latestQuake: latestQuakeStandbyCards,
    weatherAlerts: weatherAlertsStandbyCards,
    stats: statsStandbyCards,
    severityTier: "critical",
  });
  // §6-6: 長大の津波・熱中症・RecentQuakes を一つの fixture に集める。dim / critical /
  // reduced-motion は同一データ面を使い、表示経路だけを比較できるようにする。
  const attentionVisibilitySnapshot = legacyStandbyGateSnapshot("max", "attention-visibility-standby");
  const attentionVisibilityCriticalSnapshot = {
    ...attentionVisibilitySnapshot,
    severityTier: "critical" as const,
  };
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
      scenario === "emergency-weather" ||
      scenario === "emergency-weather-mix" ||
      scenario === "emergency-weather-syncing" ||
      scenario === "attention-visibility-emergency" ||
      scenario === "motion-panels" ||
      scenario === "motion-card-grow" ||
      motionEnterEmergency
      ? "emergency"
      : "standby",
  );
  $effect(() => {
    if (mode !== "standby") standbyStage = 0;
  });
  const snapshot = $derived<DisplayStateSnapshotV1>(
    legacyStandbyGate
      ? legacyStandbyGateSnapshot(gateScenario, gateFixture)
      : scenario === "standby-weather-warning"
      ? weatherWarningSnapshot
      : scenario === "standby-weather-advisory"
        ? weatherAdvisorySnapshot
        : scenario === "standby-rich"
          ? richSnapshot
          : scenario === "standby-tsunami"
            ? tsunamiBannerSnapshot
            : scenario === "standby-cards" || scenario === "standby-dim"
              ? cardsSnapshot
              : scenario === "standby-active-cards"
                ? activeCardsSnapshot
                : scenario === "standby-briefing"
                  ? briefingSnapshot
                : scenario === "standby-briefing-pages"
                  ? briefingPagingSnapshot
                : scenario === "standby-briefing-design-alignment"
                  ? briefingDesignAlignmentSnapshot
                : scenario === "standby-vpwp50-forecast"
                  ? vpwp50ForecastSnapshot
                : scenario === "standby-vpta50-probability-muted"
                  ? vpta50ProbabilityMutedSnapshot
                : scenario === "standby-vpta50-probability-normal"
                  ? vpta50ProbabilityNormalSnapshot
                : scenario === "standby-design-alignment-compressed"
                  ? designAlignmentCompressedSnapshot
                : scenario === "standby-weather-kind-area"
                  ? weatherKindAreaSnapshot
                : scenario === "standby-weather-kind-area-footer-boundary"
                  ? weatherKindAreaFooterBoundarySnapshot
                : scenario === "standby-active-wide"
                  ? activeWideSnapshot
                : scenario === "standby-right-stack-budget"
                  ? rightStackBudgetSnapshot
              : scenario === "motion-standby-flood"
                ? standbySnapshot({ standbyItems: motionStandbyFloodPhases[motionStep % motionStandbyFloodPhases.length] })
              : scenario === "standby-tier-critical"
                ? cardsTierCriticalSnapshot
                : scenario === "standby-stress"
                  ? stressStandbySnapshot
                    : scenario === "standby-nankai"
                      ? nankaiStandbySnapshot
                    : scenario === "standby-attention-visibility" || scenario === "standby-attention-visibility-dim"
                      || scenario === "standby-attention-visibility-reduced-motion"
                      ? attentionVisibilitySnapshot
                    : scenario === "standby-attention-visibility-critical"
                      ? attentionVisibilityCriticalSnapshot
                    : quietSnapshot,
  );
  const dim = $derived(scenario === "standby-dim" || scenario === "standby-attention-visibility-dim");
  const reducedMotionForPreview = $derived(
    reducedMotion || scenario === "standby-attention-visibility-reduced-motion",
  );
  const attentionVisibilityPreviewFixture = $derived(
    scenario.includes("attention-visibility") || gateFixture === "attention-visibility-standby",
  );
  // この fixture は OS の media query を変えず単独で reduced-motion 契約を再現する。
  const forcedReducedMotionFixture = $derived(scenario === "standby-attention-visibility-reduced-motion");
  const fixtureTransitionDuration = $derived(forcedReducedMotionFixture ? 0 : undefined);
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
    if (scenario === "attention-visibility-emergency") {
      return [
        { key: "tsunami:attention-visibility", input: tsunamiStressInput },
        { key: "quake:attention-visibility", input: attentionVisibilityQuakeInput },
      ];
    }
    if (scenario === "emergency-nankai") {
      return [
        { key: "tsunami:nankai", input: tsunamiNankaiInput },
        { key: "eew:nankai", input: eewNankaiInput },
        { key: "quake:nankai", input: largeQuakeNankaiInput },
      ];
    }
    // Spec C Phase 2 の気象主役パネル。単独 (主役スロット) / 併発 (右列 compact) / 中身待ちの 3 場面
    if (scenario === "emergency-weather") {
      return [{ key: "weather:current", input: weatherEmergencyInput }];
    }
    if (scenario === "emergency-weather-mix") {
      return [
        { key: "tsunami:weathermix", input: tsunamiWarningInput },
        { key: "weather:current", input: weatherEmergencyInput },
        { key: "eew:weathermix", input: eewForecastInput },
      ];
    }
    if (scenario === "emergency-weather-syncing") {
      return [{ key: "weather:current", input: weatherSyncingInput }];
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

  let interruptLines = $state<DisplayEventDtoV1[]>(tickerLinesInterruptBase);
  let revisionLines = $state<DisplayEventDtoV1[]>([tickerRevisionV1]);

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
{:else if scenario === "tone-matrix"}
  <section class="tone-matrix" aria-label="背景トーン目視ゲート">
    <h1>背景トーン目視ゲート</h1>
    <p>5 tone × dim 有無 × critical overlay 有無。ご主人裁定で色を差し替える前の実レンダー一覧。</p>
    <div class="tone-matrix-grid">
      {#each backgroundTonePreviewFixtures as tone}
        {#each [false, true] as cellDim}
          {#each [false, true] as criticalOverlay}
            <main
              class:dim={cellDim}
              class:critical-overlay={criticalOverlay}
              class="tone-matrix-cell"
              data-background-tone={tone}
            >
              <div class="tone-matrix-label">{tone} · {cellDim ? "dim" : "normal"} · {criticalOverlay ? "critical overlay" : "overlay none"}</div>
              <div class="tone-matrix-content">
                <span>通常前景</span> /
                <span class="tone-matrix-role">role-weatherWarning 前景</span>
              </div>
              <div class="tone-matrix-solid">solid ticker · 大津波警報</div>
            </main>
          {/each}
        {/each}
      {/each}
    </div>
  </section>
{:else if scenario === "legacy-improved-mock"}
  <LegacyImprovedMock />
{:else if weatherAutoFooterProbe}
  <main class="preview-screen weather-auto-screen" data-preview-mode="standby">
    <div
      class="standby weather-auto-footer-probe"
      class:ladder-compressed={weatherAutoFooterCompressed}
      data-weather-auto-footer-probe={scenario}
      data-weather-auto-forced-range={JSON.stringify(weatherAutoFooterRange)}
      data-measurement-settled="true"
      data-layout-unresolved="false"
      data-measurement-nonconverged="false"
    >
      <WeatherAlertCard
        alerts={legacyImprovedMaxWeatherAlerts}
        pageScheduling={true}
        measurement={{ kind: "weather-page", range: weatherAutoFooterRange, footer: "present", pageIndex: 1, pageCount: 1 }}
      />
    </div>
  </main>
{:else}
<main
  class="preview-screen"
  data-tier={snapshot.severityTier}
  data-background-tone={snapshot.backgroundTone ?? "calm"}
  data-preview-attention-visibility={attentionVisibilityPreviewFixture ? "true" : undefined}
  data-preview-reduced-motion={reducedMotionForPreview ? "true" : undefined}
  data-preview-mode={mode}
  data-design-alignment-payload-signature={scenario === "standby-design-alignment-compressed" ? JSON.stringify(designAlignmentCompressedPayloadSignature) : undefined}
  data-design-alignment-rider-reserve-counts={scenario === "standby-design-alignment-compressed" ? JSON.stringify(designAlignmentRiderReserveCounts) : undefined}
>
  <div class="screen-area">
    {#if mode === "standby"}
      <div
        class="screen-layer"
        data-kind="standby"
        in:fade={{ duration: fixtureTransitionDuration ?? calmDur }}
        out:fade={{ duration: fixtureTransitionDuration ?? exitDur }}
      >
        <StandbyScreen {snapshot} {now} {dim} reducedMotion={reducedMotionForPreview} {sseConnected} {gateFixture} partitionDebug={true} onStageChange={(stage) => { if (mode === "standby") standbyStage = stage; }} />
      </div>
    {:else}
      <div
        class="screen-layer"
        data-kind="emergency"
        data-motion-reveal="scale"
        in:emergencyEnter={{ duration: fixtureTransitionDuration ?? enterDur }}
        out:fade={{ duration: fixtureTransitionDuration ?? calmDur }}
      >
        <EmergencyScreen panels={emergencyPanels} reducedMotion={reducedMotionForPreview} />
      </div>
    {/if}
  </div>
  <div class="ticker-frame">
    <Ticker
      lines={tickerFeed}
      now={mode === "emergency" || (mode === "standby" && standbyStage >= 1) ? now : null}
      tickerGeneration={tickerGen}
      {dim}
      onJobComplete={(key) => tipsFeeder.notifyComplete(key)}
    />
  </div>
  <TierOverlay tier={snapshot.severityTier} />
</main>
{/if}

<style>
  .preview-screen {
    /* テロップ高さは theme.css の --ticker-row-h / --ticker-rows が真実源 (App.svelte と同値) */
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
  .weather-auto-screen { display: grid; place-items: center; background: var(--bg); }
  .weather-auto-footer-probe { width: min(360px, 28vw); }
  .weather-auto-footer-probe.ladder-compressed {
    --space-1: 2px;
    --space-2: 4px;
    --space-3: 6px;
    --space-4: 8px;
    --space-5: 10px;
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
  .tone-matrix {
    min-height: 100vh;
    padding: 2rem;
    background: var(--bg);
    color: var(--fg);
  }
  .tone-matrix h1 { margin: 0 0 0.4rem; font-size: 1.4rem; }
  .tone-matrix p { margin: 0 0 1.25rem; color: var(--role-muted); }
  .tone-matrix-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 0.75rem;
  }
  .tone-matrix-cell {
    position: relative;
    min-height: 8rem;
    overflow: hidden;
    padding: 0.8rem;
    background: var(--bg);
    border: 1px solid color-mix(in srgb, var(--fg) 20%, transparent);
  }
  .tone-matrix-cell.dim { color: color-mix(in srgb, var(--fg) 35%, var(--bg)); }
  .tone-matrix-cell.critical-overlay::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
    background: radial-gradient(120% 120% at 50% 50%, rgba(160, 48, 160, 0.1) 40%, rgba(160, 48, 160, 0.34) 100%);
  }
  .tone-matrix-label, .tone-matrix-content, .tone-matrix-solid { position: relative; z-index: 1; }
  .tone-matrix-label { color: var(--role-muted); font-size: 0.8rem; }
  .tone-matrix-content { margin-top: 1.5rem; }
  .tone-matrix-role { color: var(--role-weatherWarning); }
  .tone-matrix-solid {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.15rem 0.35rem;
    border-radius: var(--radius-s);
    background: var(--header-tsunamiMajor-container);
    color: var(--header-tsunamiMajor-on);
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
