<script lang="ts">
  import {
    WEATHER_SUB_KIND_MAX,
    acceptsMeasurement,
    buildWeatherBaseFragments,
    evaluateWeatherFragmentRefinement,
    finitePositiveOrNull,
    groupWeatherChangeItems,
    packWeatherFragmentsByHeight,
    provisionalMinimumWeatherFragments,
    resolveWeatherInitialPageIndex,
    selectPagedItems,
    selectSubKinds,
    selectWeatherChangeItems,
    stripLevelPrefix,
    weatherBaseContentFingerprint,
    weatherBaseLayoutEpochKey,
    weatherChangeRowText,
    weatherChangeFadeDuration,
    weatherChangeLogicalFingerprint,
    weatherChangeLogicalTotal,
    weatherChangeMeasurementIdentity,
    weatherChangeOmittedCount,
    weatherChangeReserveFingerprint,
    weatherChangeSummary,
    selectWeatherChangeFitCandidate,
    weatherEmergencyHeading,
    weatherInfeasiblePages,
    weatherPageCyclerResetKey,
    weatherPartitionSignature,
    weatherReferenceGeometrySourceKey,
    weatherRowAreaMax,
    weatherSyncingPages,
    WEATHER_CHANGE_ROW_CAPACITY,
    WEATHER_CHANGE_ROW_CAPACITY_COMPACT,
    type WeatherAreaGroupFragment,
    type WeatherEmergencyInputV1,
    type WeatherGroupFragment,
    type WeatherPublicEntry,
    type WeatherChangeSelectionV1,
  } from "../lib/weather-panel";
  import { measureBorderHeight, observeResize } from "../lib/measure-height";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { fade } from "svelte/transition";
  import { onDestroy, onMount, untrack } from "svelte";
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
    reducedMotionInput = false,
  }: { input: WeatherEmergencyInputV1; compact?: boolean; layoutSettling?: boolean; reducedMotionInput?: boolean } = $props();

  // L5 相当 = officialL5 ∪ nonLevelSpecial (どちらも特別警報級)、L4 相当 = officialL4 (警報級)。
  // 色 role は既存の weatherEmergency / weatherWarning を再利用する (新規トークンを作らない、spec §3)
  const role = $derived(input.level === 5 ? "weatherEmergency" : "weatherWarning");
  const headingLabel = $derived(weatherEmergencyHeading(input));
  // 新規発表 / 更新発表のバッジ (spec 追補 3)。判定材料が無いときは出さない —
  // 嘘の「新規」を出すより無表示を採る (C5)
  const triggerLabel = $derived(
    input.trigger === "new" ? "新規発表" : input.trigger === "update" ? "更新発表" : null,
  );
  const changeLimit = $derived(compact ? WEATHER_CHANGE_ROW_CAPACITY_COMPACT : WEATHER_CHANGE_ROW_CAPACITY);
  const completeChangeSelection = $derived(selectWeatherChangeItems(input.change, Number.MAX_SAFE_INTEGER));
  const changeCandidateLimit = $derived(Math.min(changeLimit, completeChangeSelection.items.length));
  const changeLogicalTotal = $derived(weatherChangeLogicalTotal(completeChangeSelection));
  let selectedChangeCount = $state(0);
  const changeSelection = $derived(selectWeatherChangeItems(input.change, selectedChangeCount));
  const changeVisible = $derived(input.change != null && changeLogicalTotal > 0);

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

  // ── 「どこ」領域: cap → group → fragment → 実高 partition ──
  // areaMax は地域列の実幅から算出する。未測定中だけ既存の normal=12 / compact=6 fallback。
  let measuredAreaColumn = $state<{ referenceKey: string; width: number } | null>(null);
  let whereFontSize = $state<number | null>(null);
  let whereFrameWidth = $state<number | null>(null);
  let whereFrameHeight = $state<number | null>(null);
  let whereFrameEl = $state<HTMLElement | null>(null);

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

  // 省略の告知は行末の「ほか N 地域」「ほか N 種別」に一本化する。

  type MeasureHandle = { destroy?: () => void };
  interface ReferenceMeasurement {
    width: number;
    height: number;
  }
  interface ReferenceMeasurementToken {
    referenceKey: string;
    activationKey: string;
  }
  interface FragmentMeasurementToken {
    baseEpochKey: string;
    fragmentKey: string;
    activationKey: string;
  }
  interface ChangeMeasurementToken {
    batchKey: string;
    candidate: number;
  }

  let referenceMeasurements = $state(new Map<string, ReferenceMeasurement>());
  let activeBaseEpochKey = $state<string | null>(null);
  let refinementFragments = $state<WeatherGroupFragment[]>([]);
  let fragmentHeights = $state(new Map<string, number>());
  let candidateHeights = $state(new Map<string, number>());
  let candidateFragment = $state<WeatherAreaGroupFragment | null>(null);
  let layoutState = $state<"pending" | "ready" | "infeasible">("pending");
  let partitionRefinementCount = $state(0);
  let panelElement = $state<HTMLElement | null>(null);
  let panelWidth = $state<number | null>(null);
  let panelHeight = $state<number | null>(null);
  let panelContentHeight = $state<number | null>(null);
  let reserveHeight = $state<number | null>(null);
  let changeCandidateHeights = $state(new Map<number, number>());
  let activeChangeBatchKey = $state<string | null>(null);
  let changeMeasurementPass = $state(0);
  let changeLayoutUnresolved = $state(false);
  let changeMeasurementNonconverged = $state(false);
  let changeMeasurementSettled = $state(false);
  let fontEpoch = $state(0);
  let settlingEpoch = $state(0);

  function readPanel(node: HTMLElement, token: string): void {
    if (!acceptsMeasurement(token, input.activationKey, layoutSettling)) return;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const verticalInsets = [
      style.borderTopWidth,
      style.borderBottomWidth,
      style.paddingTop,
      style.paddingBottom,
    ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    panelWidth = finitePositiveOrNull(rect.width);
    panelHeight = finitePositiveOrNull(rect.height);
    panelContentHeight = finitePositiveOrNull(rect.height - verticalInsets);
  }

  function observePanel(node: HTMLElement, token: string) {
    let currentToken = token;
    panelElement = node;
    readPanel(node, currentToken);
    const handle: MeasureHandle = observeResize(node, () => readPanel(node, currentToken));
    return {
      update(next: string): void {
        currentToken = next;
        queueMicrotask(() => readPanel(node, currentToken));
      },
      destroy(): void {
        if (panelElement === node) panelElement = null;
        handle.destroy?.();
      },
    };
  }

  function measureReserve(node: HTMLElement, token: string) {
    let currentToken = token;
    const record = (height: number): void => {
      if (currentToken !== changeBatchKey || layoutSettling) return;
      reserveHeight = finitePositiveOrNull(height);
    };
    const immediate = node.getBoundingClientRect().height;
    if (immediate > 0) record(immediate);
    queueMicrotask(() => record(node.getBoundingClientRect().height));
    const handle = measureBorderHeight(node, record);
    return {
      update(next: string): void {
        currentToken = next;
        queueMicrotask(() => record(node.getBoundingClientRect().height));
      },
      destroy: () => handle.destroy?.(),
    };
  }

  function measureChangeCandidate(node: HTMLElement, token: ChangeMeasurementToken) {
    let currentToken = token;
    const record = (height: number): void => {
      if (currentToken.batchKey !== changeBatchKey || layoutSettling) return;
      const measured = finitePositiveOrNull(height);
      if (measured == null || changeCandidateHeights.get(currentToken.candidate) === measured) return;
      changeCandidateHeights = new Map(changeCandidateHeights).set(currentToken.candidate, measured);
    };
    const immediate = node.getBoundingClientRect().height;
    if (immediate > 0) record(immediate);
    queueMicrotask(() => record(node.getBoundingClientRect().height));
    const handle = measureBorderHeight(node, record);
    return {
      update(next: ChangeMeasurementToken): void {
        currentToken = next;
        queueMicrotask(() => record(node.getBoundingClientRect().height));
      },
      destroy: () => handle.destroy?.(),
    };
  }

  onMount(() => {
    let cancelled = false;
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    void fontsReady.then(() => {
      if (!cancelled) fontEpoch += 1;
    });
    return () => { cancelled = true; };
  });

  function readWhereFrame(node: HTMLElement, token: string): void {
    if (!acceptsMeasurement(token, input.activationKey, layoutSettling)) return;
    const rect = node.getBoundingClientRect();
    const width = finitePositiveOrNull(rect.width);
    const height = finitePositiveOrNull(rect.height);
    whereFrameWidth = width;
    whereFrameHeight = height;
  }
  function observeWhereFrame(node: HTMLElement, token: string) {
    whereFrameEl = node;
    readWhereFrame(node, token);
    const handle: MeasureHandle = observeResize(node, () => readWhereFrame(node, token));
    return {
      destroy(): void {
        if (whereFrameEl === node) whereFrameEl = null;
        handle.destroy?.();
      },
    };
  }

  const baseFragmentsBeforeGeometry = $derived.by(() => {
    // referenceKey はこの derived より後で定義されるため、最新の受理済み地域列幅を使う。
    const areaWidth = measuredAreaColumn?.width ?? null;
    const max = weatherRowAreaMax(areaWidth, whereFontSize, compact);
    return { areaMax: max, fragments: buildWeatherBaseFragments(pagedItems, max) };
  });
  const areaMax = $derived(baseFragmentsBeforeGeometry.areaMax);
  const baseFragments = $derived(baseFragmentsBeforeGeometry.fragments);
  const provisionalMinimumFragments = $derived(provisionalMinimumWeatherFragments(baseFragments));
  const pagerReferenceTotal = $derived(provisionalMinimumFragments.length);
  const baseContentFingerprint = $derived(weatherBaseContentFingerprint(baseFragments));
  const referenceGeometrySourceKey = $derived(weatherReferenceGeometrySourceKey({
    compact,
    layoutSettling,
    whereFrameWidth,
    whereFrameHeight,
    whereFontSize,
    pagerReferenceTotal,
  }));
  const referenceMeasurement = $derived(referenceMeasurements.get(referenceGeometrySourceKey) ?? null);
  const stableWhereBodyWidth = $derived(referenceMeasurement?.width ?? null);
  const stableWhereBodyHeight = $derived(referenceMeasurement?.height ?? null);
  const baseLayoutEpochKey = $derived(weatherBaseLayoutEpochKey({
    input,
    referenceGeometrySourceKey,
    stableWhereBodyWidth,
    stableWhereBodyHeight,
    baseContentFingerprint,
    baseFragments,
  }));
  const isSyncingContent = $derived(provisionalMinimumFragments.length === 0);
  // effect による state 初期化より先に新 input が描画されても、旧 epoch の final / 測定 DOM を
  // 一瞬も公開しない。active key が一致するまでは外向きには pending として扱う。
  const baseEpochIsActive = $derived(activeBaseEpochKey === baseLayoutEpochKey);
  const publicLayoutState = $derived(baseEpochIsActive ? layoutState : "pending");
  const reserveFingerprint = $derived(weatherChangeReserveFingerprint({
    level: input.level,
    headingLabel,
    triggerLabel,
    updatedAt: input.updatedAt,
    restored: input.restored,
    compact,
    actionMode: compact ? "inline" : "tile",
    actionLabel: actionOf(input.level),
    alertNames,
    subSectionPresent: subItems.length > 0,
    subKinds,
    subAddedKinds: subKinds.filter((kind) => subAddedKinds.has(kind)),
    subAddedCount,
    hiddenSubKindCount,
    baseContentFingerprint,
  }));
  const changeFingerprint = $derived(
    weatherChangeLogicalFingerprint(input.change, completeChangeSelection),
  );
  const changeBudget = $derived(
    panelContentHeight == null || reserveHeight == null
      ? null
      : panelContentHeight - reserveHeight,
  );
  const changeBudgetQuantized = $derived.by(() => {
    if (changeBudget == null) return null;
    const ratio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
    return Math.round(changeBudget * ratio) / ratio;
  });
  const changeBatchKey = $derived(JSON.stringify([
    input.change?.changeKey ?? null,
    input.activationKey,
    compact,
    panelWidth,
    panelHeight,
    changeBudgetQuantized,
    reserveHeight,
    reserveFingerprint,
    changeFingerprint,
    fontEpoch,
    settlingEpoch,
  ]));
  const changeMeasurementKey = $derived(
    input.change == null || panelWidth == null || panelHeight == null
      || changeBudget == null || changeBudgetQuantized == null || reserveHeight == null
      ? null
      : weatherChangeMeasurementIdentity({
        changeKey: input.change.changeKey,
        activationKey: input.activationKey,
        compact,
        panelWidth,
        panelHeight,
        budget: changeBudget,
        reserveHeight,
        reserveFingerprint,
        changeFingerprint,
        fontEpoch,
        settlingEpoch,
      }),
  );
  const changeCandidateMeasurements = $derived.by(() => (
    Array.from({ length: changeCandidateLimit + 1 }, (_, candidate) => {
      const height = changeCandidateHeights.get(candidate) ?? null;
      return {
        n: candidate,
        height,
        fit: changeBudget == null || height == null
          ? null
          : height <= changeBudget,
      };
    })
  ));

  function readReferenceBody(node: HTMLElement, token: ReferenceMeasurementToken): void {
    if (
      token.referenceKey !== referenceGeometrySourceKey
      || !acceptsMeasurement(token.activationKey, input.activationKey, layoutSettling)
    ) return;
    const width = finitePositiveOrNull(node.clientWidth);
    const height = finitePositiveOrNull(node.clientHeight);
    if (width == null || height == null) {
      if (referenceMeasurements.has(token.referenceKey)) {
        const next = new Map(referenceMeasurements);
        next.delete(token.referenceKey);
        referenceMeasurements = next;
      }
      return;
    }
    const current = referenceMeasurements.get(token.referenceKey);
    if (current?.width === width && current.height === height) return;
    referenceMeasurements = new Map(referenceMeasurements).set(token.referenceKey, { width, height });
  }
  function measureReferenceBody(node: HTMLElement, token: ReferenceMeasurementToken) {
    readReferenceBody(node, token);
    const handle: MeasureHandle = observeResize(node, () => readReferenceBody(node, token));
    return { destroy: () => handle.destroy?.() };
  }
  function readAreaGeometry(node: HTMLElement, token: ReferenceMeasurementToken): void {
    if (
      token.referenceKey !== referenceGeometrySourceKey
      || !acceptsMeasurement(token.activationKey, input.activationKey, layoutSettling)
    ) return;
    const width = finitePositiveOrNull(node.getBoundingClientRect().width);
    const fontSize = finitePositiveOrNull(Number.parseFloat(getComputedStyle(node).fontSize));
    whereFontSize = fontSize;
    measuredAreaColumn = width == null ? null : { referenceKey: token.referenceKey, width };
  }
  function measureAreaGeometry(node: HTMLElement, token: ReferenceMeasurementToken) {
    readAreaGeometry(node, token);
    const handle: MeasureHandle = observeResize(node, () => readAreaGeometry(node, token));
    return { destroy: () => handle.destroy?.() };
  }

  function recordFragmentHeight(token: FragmentMeasurementToken, height: number): void {
    if (
      token.baseEpochKey !== baseLayoutEpochKey
      || !acceptsMeasurement(token.activationKey, input.activationKey, layoutSettling)
    ) return;
    const isCurrent = refinementFragments.some((fragment) => fragment.key === token.fragmentKey);
    const isCandidate = candidateFragment?.key === token.fragmentKey;
    if (!isCurrent && !isCandidate) return;
    if (finitePositiveOrNull(height) == null) {
      if (isCurrent && fragmentHeights.has(token.fragmentKey)) {
        const next = new Map(fragmentHeights);
        next.delete(token.fragmentKey);
        fragmentHeights = next;
      } else if (isCandidate && candidateHeights.has(token.fragmentKey)) {
        const next = new Map(candidateHeights);
        next.delete(token.fragmentKey);
        candidateHeights = next;
      }
      return;
    }
    if (isCurrent) {
      if (fragmentHeights.get(token.fragmentKey) === height) return;
      fragmentHeights = new Map(fragmentHeights).set(token.fragmentKey, height);
    } else {
      if (candidateHeights.get(token.fragmentKey) === height) return;
      candidateHeights = new Map(candidateHeights).set(token.fragmentKey, height);
    }
  }
  function measureFragment(node: HTMLElement, token: FragmentMeasurementToken | null) {
    if (token == null) return {};
    const immediate = node.getBoundingClientRect().height;
    if (immediate > 0) recordFragmentHeight(token, immediate);
    const handle: MeasureHandle = measureBorderHeight(node, (height) => recordFragmentHeight(token, height));
    return { destroy: () => handle.destroy?.() };
  }

  // 整定解除時は ResizeObserver の次回通知を待たず、partition 非依存 frame を読み直す。
  $effect(() => {
    const settling = layoutSettling;
    const activationKey = input.activationKey;
    const node = whereFrameEl;
    untrack(() => {
      if (!settling && node != null) readWhereFrame(node, activationKey);
    });
  });

  let previousLayoutSettling = false;
  $effect(() => {
    const settling = layoutSettling;
    untrack(() => {
      if (previousLayoutSettling && !settling) settlingEpoch += 1;
      previousLayoutSettling = settling;
    });
  });

  // fit identity が変わったら旧候補を破棄し、初回は summary-only へ戻す。
  $effect(() => {
    const batchKey = changeBatchKey;
    untrack(() => {
      if (activeChangeBatchKey === batchKey) return;
      activeChangeBatchKey = batchKey;
      changeCandidateHeights = new Map();
      selectedChangeCount = 0;
      changeMeasurementPass = 0;
      changeLayoutUnresolved = false;
      changeMeasurementNonconverged = false;
      changeMeasurementSettled = false;
    });
  });

  // n=0..limit の同一 batch がすべて揃ってから、一度だけ最大 fitting 候補を publish する。
  // Bq は subpixel noise を同一 publish とみなすための値で、fit 自体は reserve を侵食しない
  // raw B に対して行う（round(B) は最大 0.5px の過配分になり得る）。
  $effect(() => {
    const batchKey = changeBatchKey;
    const measurementKey = changeMeasurementKey;
    const budget = changeBudget;
    const heights = changeCandidateHeights;
    const limit = changeCandidateLimit;
    const settling = layoutSettling;
    untrack(() => {
      if (
        !changeVisible
        || settling
        || activeChangeBatchKey !== batchKey
        || measurementKey == null
        || Array.from({ length: limit + 1 }, (_, candidate) => candidate)
          .some((candidate) => !heights.has(candidate))
      ) return;
      const result = selectWeatherChangeFitCandidate({ budget, candidateHeights: heights, limit });
      if (result == null) return;
      const nextSelected = result.unresolved ? 0 : result.selected;
      const changed = changeMeasurementPass === 0
        || selectedChangeCount !== nextSelected
        || changeLayoutUnresolved !== result.unresolved;
      if (!changed) return;
      if (changeMeasurementPass >= 4) {
        changeMeasurementNonconverged = true;
        changeMeasurementSettled = false;
        return;
      }
      selectedChangeCount = nextSelected;
      changeLayoutUnresolved = result.unresolved;
      changeMeasurementPass += 1;
      changeMeasurementSettled = false;
    });
  });

  // base epoch の変更だけが refinement と infeasible を原子的に初期化する。
  $effect(() => {
    const epochKey = baseLayoutEpochKey;
    const initialFragments = baseFragments;
    untrack(() => {
      if (activeBaseEpochKey === epochKey) return;
      activeBaseEpochKey = epochKey;
      layoutState = "pending";
      refinementFragments = [...initialFragments];
      fragmentHeights = new Map();
      candidateHeights = new Map();
      candidateFragment = null;
      partitionRefinementCount = 0;
    });
  });

  // 同一 epoch 内は split-only。最大 fitting prefix の未測定候補だけを測定棚へ追加する。
  $effect(() => {
    const epochKey = baseLayoutEpochKey;
    const activeEpoch = activeBaseEpochKey;
    const syncing = isSyncingContent;
    const settling = layoutSettling;
    const availableHeight = stableWhereBodyHeight;
    const currentFragments = refinementFragments;
    const currentFragmentHeights = fragmentHeights;
    const currentCandidateHeights = candidateHeights;
    const state = layoutState;
    untrack(() => {
      if (
        activeEpoch !== epochKey
        || syncing
        || settling
        || availableHeight == null
        || state === "infeasible"
      ) return;
      const heights = new Map([...currentFragmentHeights, ...currentCandidateHeights]);
      const result = evaluateWeatherFragmentRefinement(currentFragments, heights, availableHeight);
      if (result.state === "pending") {
        if (candidateFragment?.key !== result.candidate?.key) candidateFragment = result.candidate;
        if (layoutState !== "pending") layoutState = "pending";
        return;
      }
      if (result.state === "split") {
        const nextKeys = new Set(result.fragments.map((fragment) => fragment.key));
        const nextHeights = new Map<string, number>();
        for (const key of nextKeys) {
          const height = currentFragmentHeights.get(key) ?? currentCandidateHeights.get(key);
          if (height != null) nextHeights.set(key, height);
        }
        refinementFragments = result.fragments;
        fragmentHeights = nextHeights;
        candidateHeights = new Map();
        candidateFragment = null;
        layoutState = "pending";
        partitionRefinementCount += 1;
        return;
      }
      candidateFragment = null;
      layoutState = result.state;
    });
  });

  const provisionalPages = $derived(
    provisionalMinimumFragments.map((fragment) => [fragment]),
  );
  const finalPages = $derived.by((): WeatherGroupFragment[][] => {
    if (!baseEpochIsActive || layoutState !== "ready" || stableWhereBodyHeight == null) return [];
    return packWeatherFragmentsByHeight(
      refinementFragments,
      fragmentHeights,
      stableWhereBodyHeight,
    ) ?? [];
  });
  const syncingPages = $derived(weatherSyncingPages(input));
  const infeasiblePages = $derived(weatherInfeasiblePages(input, baseContentFingerprint));
  const publicPages = $derived.by((): WeatherPublicEntry[][] => {
    if (isSyncingContent) return syncingPages;
    if (publicLayoutState === "pending") return provisionalPages;
    if (publicLayoutState === "ready" && finalPages.length > 0) return finalPages;
    return infeasiblePages;
  });
  const partitionSignature = $derived(weatherPartitionSignature(publicPages));
  const pageCyclerResetKey = $derived(weatherPageCyclerResetKey(partitionSignature));
  const changePageRanges = $derived(publicPages.map((page) => page.map((fragment) => fragment.key)));
  const changeLogicalAreaIdentities = $derived(publicPages.flatMap((page) => page.flatMap((fragment) =>
    fragment.fragmentType === "group"
      ? fragment.areas.map((area) => `${area.identity}:${area.sourceIndex}`)
      : [],
  )));

  // 公開 fit と最終 partition が二つの animation frame で不変なら settled とする。
  $effect(() => {
    const signature = JSON.stringify([
      changeMeasurementKey,
      changeBudgetQuantized,
      selectedChangeCount,
      partitionSignature,
      publicLayoutState,
    ]);
    if (!changeVisible || layoutSettling || changeMeasurementPass === 0
      || changeLayoutUnresolved || changeMeasurementNonconverged || publicLayoutState !== "ready") {
      changeMeasurementSettled = false;
      return;
    }
    let cancelled = false;
    const first = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled && signature === JSON.stringify([
          changeMeasurementKey,
          changeBudgetQuantized,
          selectedChangeCount,
          partitionSignature,
          publicLayoutState,
        ])) changeMeasurementSettled = true;
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
    };
  });

  const cycler = createPageCycler({
    pageCount: () => publicPages.length,
    resetKey: () => pageCyclerResetKey,
    reducedMotion: () => reducedMotionInput,
  });
  onDestroy(() => cycler.destroy());
  const currentPage = $derived(publicPages[cycler.index] ?? publicPages[0]!);

  const reducedMotion = $derived(cycler.reducedMotion);
  let consumedActivationKey: string | null = null;
  $effect(() => {
    const activationKey = input.activationKey;
    const firstPageRowKey = input.firstPageRowKey;
    const syncing = isSyncingContent;
    const state = publicLayoutState;
    const pageList = finalPages;
    // change fit の publish 前に一度 ready になった暫定 partition で activation を消費すると、
    // change 自然高を反映した再 partition の resetKey が cycler を 0 へ戻しても、追加地域 page
    // へ再 jump できない。更新欄がある場合は outer fit と最終 partition の連続安定 sample まで
    // 待ち、新 activation の初期 page を最終 range に対して一度だけ選ぶ。
    const presentationSettled = !changeVisible || changeMeasurementSettled;
    untrack(() => {
      if (syncing || state !== "ready" || pageList.length === 0 || !presentationSettled) return;
      if (consumedActivationKey === activationKey) return;
      const targetIndex = resolveWeatherInitialPageIndex(pageList, firstPageRowKey);
      cycler.jumpTo(targetIndex, { immediate: false });
      consumedActivationKey = activationKey;
    });
  });
</script>

{#snippet weatherFragmentRow(
  fragment: WeatherGroupFragment,
  measurementToken: FragmentMeasurementToken | null,
)}
  <div
    class="where-row"
    class:sub-level-row={fragment.level !== input.level}
    data-fragment-key={fragment.key}
    data-fragment-type={fragment.fragmentType}
    data-continued={fragment.fragmentType === "group" ? fragment.continued : false}
    data-group-kind={fragment.fragmentType === "group" ? fragment.group.kind : undefined}
    use:measureFragment={measurementToken}
  >
    <span class="kind"
      >{#if fragment.level !== input.level}<span class="row-level">L{fragment.level}</span>{/if}{fragment.kind}</span
    >
    <div class="areas">
      {#if fragment.fragmentType === "group"}
        <div class="area-group" class:raw-group={fragment.group.kind === "raw"}>
          {#if fragment.group.kind === "prefecture"}
            <span class="prefecture-name">{fragment.group.prefectureName}</span>
          {/if}
          <span class="municipalities">
            {#each fragment.areas as area (`${area.identity}:${area.sourceIndex}`)}<span
                class="area-name"
                class:added={area.added}
                data-area-identity={`${area.identity}:${area.sourceIndex}`}>{area.displayName}</span
              >{/each}
          </span>
        </div>
      {/if}
      {#if fragment.hiddenAreaCount > 0}<span class="omitted">ほか{fragment.hiddenAreaCount}地域</span>{/if}
    </div>
  </div>
{/snippet}

{#snippet weatherChangeSurface(selection: WeatherChangeSelectionV1)}
  <section
    class="weather-change"
    aria-label="気象警報（VPWS50）の今回の変更"
    data-change-selected={selection.items.length}
    data-change-logical-total={weatherChangeLogicalTotal(selection)}
    data-change-omitted={weatherChangeOmittedCount(selection)}
  >
    <header class="change-header">
      <h2 class="change-heading">今回の変更</h2>
      <span class="change-meta">VPWS50 · {weatherChangeLogicalTotal(selection)}件</span>
    </header>
    <div class="change-content">
      <p class="change-summary" aria-live="polite">{weatherChangeSummary(selection)}</p>
      {#if selection.items.length > 0}
        <div class="change-groups">
          {#each groupWeatherChangeItems(selection) as group (group.kind)}
            <div class="change-group" data-change-kind={group.kind}>
              <div class="change-group-heading">
                <span class="change-group-label">{group.label}</span>
                <span class="change-group-count">{group.total}件</span>
              </div>
              <div class="change-chips">
                {#each group.items as item (item.areaCode + ":" + item.phenomenonKey)}
                  <span class="change-chip">{weatherChangeRowText(item)}</span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {#if weatherChangeOmittedCount(selection) > 0}
        <div class="change-omitted-tail">ほか {weatherChangeOmittedCount(selection)} 件</div>
      {/if}
    </div>
  </section>
{/snippet}

<!-- 再点灯演出 (spec 追補 C1): 外側の panel key は固定のまま、activationKey が変わったら
     **中身だけ**を差し替えて短い fade-in を掛ける (旧内容は outro を持たないので重ねない
     片方向フェード。地図的な位置が変わらない差し替えなので、重ねるより素直に出す)。
     外側 key に混ぜるとレイアウト補間と実測状態が壊れるので、演出は必ずこの内側でやる -->
<div
  class="weather-panel role-{role} level-{input.level}"
  class:compact
  use:observePanel={input.activationKey}
  data-change-layout-unresolved={changeLayoutUnresolved}
  data-change-measurement-nonconverged={changeMeasurementNonconverged}
  data-change-measurement-settled={changeVisible ? changeMeasurementSettled : true}
  data-change-measurement-pass={changeMeasurementPass}
  data-change-selected={selectedChangeCount}
  data-change-limit={changeLimit}
  data-change-budget={changeBudget ?? undefined}
  data-change-budget-quantized={changeBudgetQuantized ?? undefined}
  data-change-reserve-height={reserveHeight ?? undefined}
  data-change-panel-width={panelWidth ?? undefined}
  data-change-panel-height={panelHeight ?? undefined}
  data-change-panel-content-height={panelContentHeight ?? undefined}
  data-change-batch-key={changeBatchKey}
  data-change-active-batch-key={activeChangeBatchKey ?? undefined}
  data-change-measurement-key={changeMeasurementKey ?? undefined}
  data-change-candidate-measurements={JSON.stringify(changeCandidateMeasurements)}
  data-change-key={input.change?.changeKey ?? undefined}
  data-change-activation-key={input.activationKey}
  data-change-reserve-fingerprint={reserveFingerprint}
  data-change-logical-fingerprint={changeFingerprint}
  data-change-font-epoch={fontEpoch}
  data-change-settling-epoch={settlingEpoch}
  data-change-partition-signature={partitionSignature}
  data-change-cycler-reset-key={pageCyclerResetKey}
  data-change-target-layout-state={publicLayoutState}
  data-change-target-available-height={stableWhereBodyHeight ?? undefined}
  data-change-target-frame-width={whereFrameWidth ?? undefined}
  data-change-target-frame-height={whereFrameHeight ?? undefined}
  data-change-active-index={cycler.index}
  data-change-page-count={publicPages.length}
  data-change-page-ranges={JSON.stringify(changePageRanges)}
  data-change-logical-area-identities={JSON.stringify(changeLogicalAreaIdentities)}
  data-change-outer-fit-publishes={changeMeasurementPass}
  data-change-partition-refinements={partitionRefinementCount}
>
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
    <div
      class="tile tile-where"
      data-layout-state={isSyncingContent ? "syncing" : publicLayoutState}
      data-pager-reference-total={pagerReferenceTotal}
      bind:this={whereFrameEl}
      use:observeWhereFrame={input.activationKey}
    >
      <!-- 見出し行にページャを置く: 省略の告知 (行末の件数) とページ位置を別の場所で言う。
           同じフッタに並べていた旧構成は「省略＝ページの一部」と誤読された (ユーザー指摘) -->
      <div class="where-head">
        <span class="section-label">対象地域・区分</span>
        {#if cycler.total > 1}
          <PageDots
            total={cycler.total}
            current={cycler.index}
            onJump={(i) => cycler.jumpTo(i)}
            windowed={true}
          />
        {/if}
      </div>
      <div class="where-body">
        {#key `${partitionSignature}:${cycler.index}`}
          <div
            class="page-fade"
            transition:fade={{
              duration: cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
              easing: springEffectsOut,
            }}
          >
            {#if currentPage[0]?.fragmentType === "syncing"}
              <div class="syncing" role="status">{currentPage[0].message}</div>
            {:else if currentPage[0]?.fragmentType === "infeasible"}
              <div class="where-row infeasible-row" role="status">
                <span class="kind">対象地域</span>
                <div class="areas"><span class="infeasible-message">{currentPage[0].message}</span></div>
              </div>
            {:else}
              {#each currentPage as fragment (fragment.key)}
                {@render weatherFragmentRow(fragment as WeatherGroupFragment, null)}
              {/each}
            {/if}
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

  <!-- partition 非依存の基準 geometry と全断片を、実レイアウト外の同型 DOM で測る。 -->
  <div class="measurement-shelf" aria-hidden="true" inert>
    {#key input.activationKey}
    {#if whereFrameWidth != null && whereFrameHeight != null}
      {#key referenceGeometrySourceKey}
        <div
          class="tile tile-where measurement-reference"
          style:width={`${whereFrameWidth}px`}
          style:height={`${whereFrameHeight}px`}
        >
          <div class="where-head">
            <span class="section-label">対象地域・区分</span>
            <PageDots
              total={pagerReferenceTotal}
              current={0}
              onJump={() => {}}
              windowed={true}
            />
          </div>
          <div
            class="where-body"
            use:measureReferenceBody={{
              referenceKey: referenceGeometrySourceKey,
              activationKey: input.activationKey,
            }}
          ></div>
        </div>
      {/key}
    {/if}

    {#if stableWhereBodyWidth != null}
      {#key referenceGeometrySourceKey}
        <div class="measurement-area-probe" style:width={`${stableWhereBodyWidth}px`}>
          <div class="where-row">
            <span class="kind">測定</span>
            <div
              class="areas"
              use:measureAreaGeometry={{
                referenceKey: referenceGeometrySourceKey,
                activationKey: input.activationKey,
              }}
            ><span class="area-name">測定</span></div>
          </div>
        </div>
      {/key}
    {/if}

    {#if baseEpochIsActive && !isSyncingContent && !layoutSettling && stableWhereBodyWidth != null}
      {#key baseLayoutEpochKey}
        <div class="measurement-fragments" style:width={`${stableWhereBodyWidth}px`}>
          {#each refinementFragments as fragment (fragment.key)}
            {@render weatherFragmentRow(fragment, {
              baseEpochKey: baseLayoutEpochKey,
              fragmentKey: fragment.key,
              activationKey: input.activationKey,
            })}
          {/each}
          {#if candidateFragment != null}
            {#key candidateFragment.key}
              {@render weatherFragmentRow(candidateFragment, {
                baseEpochKey: baseLayoutEpochKey,
                fragmentKey: candidateFragment.key,
                activationKey: input.activationKey,
              })}
            {/key}
          {/if}
        </div>
      {/key}
    {/if}

    {#if changeVisible && panelWidth != null}
      <div
        class="change-reserve-shell"
        style:width={`${panelWidth}px`}
        use:measureReserve={changeBatchKey}
      >
        <div class="heading">
          <span class="heading-title">
            <span class="heading-text">{headingLabel}</span>
            {#if triggerLabel != null}<span class="trigger-badge">{triggerLabel}</span>{/if}
          </span>
          <UpdatedStamp iso={input.updatedAt} />
        </div>
        <div class="tiles">
          <div class="tile tile-what">
            <div class="hero" class:merged={compact}>
              <span class="level-label">警戒レベル{input.level}<span class="level-suffix">相当</span></span>
              {#if compact}<span class="hero-sep">—</span><span class="action-main">{actionOf(input.level)}</span>{/if}
            </div>
            <div class="alert-names">
              {#each alertNames as name (name)}<span class="alert-name">{name}</span>{/each}{#if input.restored}<RestoredChip />{/if}
            </div>
          </div>
          {#if !compact}
            <div class="tile tile-action">
              <div class="action-main">{actionOf(input.level)}</div>
              <div class="action-note">自治体が発令する避難指示とは別の防災気象情報です</div>
            </div>
          {/if}
          <div class="tile tile-where change-reserve-where">
            <div class="where-head">
              <span class="section-label">対象地域・区分</span>
              <!-- pending 時の live / reference と同じ pager chrome を reserve する。これを
                   欠くと 24px の dot 行ぶん available body を過大評価する。 -->
              <PageDots
                total={pagerReferenceTotal}
                current={0}
                onJump={() => {}}
                windowed={true}
              />
            </div>
            <div class="where-body change-reserve-where-body">
              {#if provisionalMinimumFragments[0] != null}
                {@render weatherFragmentRow(provisionalMinimumFragments[0], null)}
              {:else}
                <div class="syncing" role="status">対象地域を同期中です</div>
              {/if}
            </div>
          </div>
          {#if subItems.length > 0}
            <div class="tile tile-sub">
              <div class="sub-head"><span class="sub-level">警戒レベル4相当</span><span class="sub-action">{actionOf(4)}</span></div>
              <div class="sub-kinds">
                {#each subKinds as kind (kind)}<span class="kind" class:added={subAddedKinds.has(kind)}>{kind}</span>{/each}{#if subAddedCount > 0}<span class="sub-added">＋{subAddedCount}地域</span>{/if}{#if hiddenSubKindCount > 0}<span class="sub-omitted">ほか{hiddenSubKindCount}種別</span>{/if}
              </div>
            </div>
          {/if}
        </div>
      </div>
      <div class="change-candidate-batch" style:width={`${panelWidth}px`}>
        {#each Array.from({ length: changeCandidateLimit + 1 }, (_, candidate) => candidate) as candidate (candidate)}
          <div
            class="change-candidate weather-change-slot"
            data-change-candidate={candidate}
            use:measureChangeCandidate={{ batchKey: changeBatchKey, candidate }}
          >
            {@render weatherChangeSurface(selectWeatherChangeItems(input.change, candidate))}
          </div>
        {/each}
      </div>
    {/if}
    {/key}
  </div>

  {#if changeVisible && input.change != null}
    {#key input.change.changeKey}
      <div
        class="weather-change-slot"
        in:fade={{ duration: weatherChangeFadeDuration(reducedMotion), easing: springEffectsOut }}
      >
        {@render weatherChangeSurface(changeSelection)}
      </div>
    {/key}
  {/if}
</div>

<style>
  .weather-panel {
    position: relative;
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
  .weather-change-slot {
    flex: 0 0 auto;
    box-sizing: border-box;
    padding: 0 calc(var(--space-7) * var(--panel-scale, 1))
      calc(var(--space-5) * var(--panel-scale, 1));
  }
  .weather-change {
    background: var(--surface-panel-raised);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-m);
    box-shadow: var(--elevation-1);
    overflow: hidden;
  }
  .change-header {
    display: flex;
    align-items: center;
    gap: calc(var(--space-3) * var(--panel-scale, 1));
    padding: calc(var(--space-2) * var(--panel-scale, 1))
      calc(var(--space-4) * var(--panel-scale, 1));
    background: var(--header-weatherWarning-container);
    color: var(--header-weatherWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning);
  }
  .change-heading,
  .change-summary {
    margin: 0;
  }
  .change-heading {
    min-width: 0;
    flex: 1 1 auto;
    font-size: calc(var(--type-label-l-size) * var(--panel-scale, 1));
    font-weight: var(--type-label-weight-emphasized);
  }
  .change-meta {
    flex: 0 0 auto;
    margin-left: auto;
    font-size: calc(var(--type-label-xs-size) * var(--panel-scale, 1));
    font-weight: var(--type-label-weight);
  }
  .change-content {
    display: grid;
    gap: calc(var(--space-2) * var(--panel-scale, 1));
    padding: calc(var(--space-3) * var(--panel-scale, 1))
      calc(var(--space-4) * var(--panel-scale, 1));
  }
  .change-summary {
    color: var(--role-muted);
    font-size: calc(var(--type-label-m-size) * var(--panel-scale, 1));
    font-weight: var(--type-label-weight);
  }
  .change-groups {
    display: grid;
    gap: calc(var(--space-2) * var(--panel-scale, 1));
  }
  .change-group {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: calc(var(--space-1) * var(--panel-scale, 1))
      calc(var(--space-3) * var(--panel-scale, 1));
    min-width: 0;
  }
  .change-group-heading {
    display: inline-flex;
    align-items: baseline;
    gap: calc(var(--space-1) * var(--panel-scale, 1));
    flex: 0 0 auto;
    font-size: calc(var(--type-label-m-size) * var(--panel-scale, 1));
    font-weight: var(--type-label-weight-emphasized);
  }
  .change-group-count {
    color: var(--role-muted);
    font-weight: var(--type-label-weight);
  }
  .change-chips {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: calc(var(--space-1) * var(--panel-scale, 1));
    min-width: 0;
  }
  .change-chip {
    min-width: 0;
    max-width: 100%;
    padding: calc(var(--space-1) * var(--panel-scale, 1))
      calc(var(--space-2) * var(--panel-scale, 1));
    color: var(--fg);
    background: var(--surface-highest);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    font-size: calc(var(--type-body-s-size) * var(--panel-scale, 1));
    font-weight: var(--type-body-weight);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .change-omitted-tail {
    color: var(--role-muted);
    font-size: calc(var(--type-label-xs-size) * var(--panel-scale, 1));
    font-weight: var(--type-label-weight);
  }
  .compact .weather-change-slot {
    padding-right: calc(var(--space-4) * var(--panel-scale, 1));
    padding-bottom: calc(var(--space-3) * var(--panel-scale, 1));
    padding-left: calc(var(--space-4) * var(--panel-scale, 1));
  }
  .compact .change-header {
    padding: calc(var(--space-1) * var(--panel-scale, 1))
      calc(var(--space-3) * var(--panel-scale, 1));
  }
  .compact .change-content {
    gap: calc(var(--space-1) * var(--panel-scale, 1));
    padding: calc(var(--space-2) * var(--panel-scale, 1))
      calc(var(--space-3) * var(--panel-scale, 1));
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
  .infeasible-message {
    color: var(--role-muted);
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
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
    border-inline-start: 1px solid var(--hairline);
    padding-inline-start: var(--space-4);
    color: var(--fg);
  }
  .area-group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    gap: var(--space-1);
  }
  .area-group.raw-group {
    display: contents;
  }
  .prefecture-name {
    color: var(--fg);
    font-weight: var(--type-body-weight-emphasized);
    white-space: nowrap;
  }
  .municipalities {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
    padding-inline-start: var(--space-2);
    color: var(--fg);
  }
  .raw-group .municipalities {
    padding-inline-start: 0;
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
    align-self: flex-end;
  }

  /* 基準 geometry と断片の測定棚。子の box は layout / ResizeObserver 用に残す一方、
     zero-size containment + clip で親 panel の scroll extent には参加させない。 */
  .measurement-shelf {
    position: absolute;
    inset: 0 auto auto 0;
    inline-size: 0;
    block-size: 0;
    contain: size layout;
    visibility: hidden;
    pointer-events: none;
    overflow: clip;
    z-index: -1;
  }
  .measurement-reference {
    box-sizing: border-box;
    flex: none;
  }
  .measurement-area-probe,
  .measurement-fragments {
    box-sizing: border-box;
    position: relative;
    overflow: visible;
  }
  .measurement-area-probe .where-row,
  .measurement-fragments .where-row {
    box-sizing: border-box;
  }
  .change-reserve-shell {
    box-sizing: border-box;
    position: absolute;
    inset: 0 auto auto 0;
    display: flex;
    flex-direction: column;
  }
  .change-reserve-shell > .tiles {
    flex: 0 0 auto;
  }
  .change-reserve-shell .change-reserve-where {
    flex: 0 0 auto;
    block-size: auto;
  }
  .change-reserve-where-body {
    position: static;
    flex: 0 0 auto;
    overflow: visible;
  }
  .change-candidate-batch,
  .change-candidate {
    box-sizing: border-box;
  }
  .change-candidate-batch {
    position: absolute;
    inset: 0 auto auto 0;
    display: grid;
  }
  .change-candidate {
    grid-area: 1 / 1;
    /* 同一 grid row の最大候補高へ stretch させず、各候補の自然高を測る。 */
    align-self: start;
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
