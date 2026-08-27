<script lang="ts">
  import type {
    DisplayTsunamiHeightSemanticV1,
    DisplayTsunamiInputV1,
    DisplayTsunamiObservationV1,
  } from "../lib/protocol";
  import { normalizeTsunamiEventId } from "../lib/protocol";
  import { formatHm } from "../lib/format";
  import {
    bucketTsunamiHeight,
    bucketTsunamiArrival,
    formatArrivalDisplay,
    maxTsunamiObservation,
  } from "../lib/tsunami-bucket";
  import { TSUNAMI_PAGE_ROW_CAPACITY } from "../lib/instrument-layout";
  import {
    sequentialPartitionRanges,
    type PartitionProbe,
  } from "../lib/legacy-standby/page-partition";
  import type { PageRange, PartitionResult } from "../lib/legacy-standby/types";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import {
    SPRING_EFFECTS_DEFAULT_MS,
    SPRING_SPATIAL_DEFAULT_MS,
    springEffectsOut,
    springSpatialOut,
  } from "../lib/motion";
  import { revealScaleIn, heightReveal } from "../lib/transitions";
  import {
    coastKindGroupKey,
    keyCoastRows,
    keyObsRows,
    type KeyedRow,
  } from "../lib/tsunami-rows";
  import { fade } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { onDestroy } from "svelte";
  import { untrack } from "svelte";
  import PageDots from "./PageDots.svelte";
  import {
    PageAttentionState,
    itemContentFingerprint,
    pageContentFingerprint,
  } from "../lib/page-attention";

  // compact: main-stack の非 main スロット (狭い右列) から true が渡る。情報密度が高い津波パネルを
  // 狭域に収めるため、見出し・計器・行の type と padding を一段圧縮する (下記 .tsunami-panel.compact)。
  // layoutSettling: 緊急画面のレイアウト遷移中 (グリッド track 補間中) は EmergencyScreen から true が
  // 渡る。遷移中はタイル/行の実測が過渡値になり再ページングが暴れるため、測定反映を保留する (spec §4)。
  let {
    input,
    compact = false,
    layoutSettling = false,
    episodeResetKey,
    reducedMotion = false,
  }: { input: DisplayTsunamiInputV1; compact?: boolean; layoutSettling?: boolean; episodeResetKey?: number; reducedMotion?: boolean } = $props();

  // 固定サマリ計器 (spec §2-c) の行動語: level から導出、JMA の呼びかけ表現に準拠
  // 【確定 2026-07-09 レビュー決定】
  const actionWord = $derived(
    input.level === "majorWarning"
      ? "ただちに高台へ避難"
      : input.level === "warning"
        ? "ただちに避難"
        : "海から上がって離れる",
  );

  // 計器のヘッドライン化 (spec §2-c 改訂 2026-07-09): 全分布のスラッシュ羅列はやめ、各バケツの
  // 先頭 (最大波高 / 最速到達時間帯) のラベルと区数だけを見せる。分布の証跡は予報区ページの
  // 各行 (波高列・到達予想列) が担うため、バケツ化純関数自体は生存させヘッドライン導出に使う。
  // 全区不明の縮退時は先頭バケツが自然に「不明」「到達時期不明」になり、そのまま表示してよい
  // (bucketTsunamiHeight/bucketTsunamiArrival は不明系バケツを常に末尾に置くため、全件不明の
  // ときだけ配列の唯一の要素として先頭に来る)
  const heightBuckets = $derived(bucketTsunamiHeight(input.coasts));
  const arrivalBuckets = $derived(bucketTsunamiArrival(input.coasts, input.reportDateTime));
  const maxHeightHeadline = $derived(heightBuckets[0] ?? null);
  const fastestArrivalHeadline = $derived(arrivalBuckets[0] ?? null);
  const HEIGHT_BADGE_LEGEND = [
    { badge: "≥", meaning: "以上（下限値）" },
    { badge: "↔", meaning: "範囲（上限値で比較）" },
    { badge: "?", meaning: "不明・定性値" },
    { badge: "∅", meaning: "空欄" },
  ] as const;

  function displayedHeightBadgeLegend(): ReadonlyArray<(typeof HEIGHT_BADGE_LEGEND)[number]> {
    const badges = new Set<string>();
    const collect = (semantic: DisplayTsunamiHeightSemanticV1 | undefined): void => {
      if (semantic?.render && semantic.presence !== "missing" && semantic.badge != null) {
        badges.add(semantic.badge);
      }
    };
    for (const coast of input.coasts) collect(coast.maxHeightSemantic);
    for (const observation of input.observations) collect(observation.maxHeightSemantic);
    return HEIGHT_BADGE_LEGEND.filter((item) => badges.has(item.badge));
  }

  const heightBadgeLegend = $derived(displayedHeightBadgeLegend());

  function coastKindRoleVar(kind: string): string {
    if (kind === "大津波警報") return "var(--role-tsunamiMajor)";
    if (kind === "津波警報") return "var(--role-tsunamiWarning)";
    if (kind === "津波注意報") return "var(--role-tsunamiAdvisory)";
    return "var(--role-muted)";
  }

  // 予報区ページ領域の種別別背景色面 (spec §2-c 改訂 2026-07-09、2 回再改訂)。
  // 【改訂履歴】① 当初 --role-tsunami* からの color-mix (22%/55%) → 混入率が低く暗面が浅すぎた
  // ② ヘッダ container/on トークンをそのまま流用 → 今度は「同系の明文字」が可読性優先の
  // 予報区ページ (文章を読む面) には合わなかった (ヘッダは文字数が少なく目立たせる用途向け)。
  // 【確定】背景 = 種別色をごく薄く含む暗面 (color-mix で意味色 15% + 最暗 surface `--bg`)、
  // 本文文字 = 色相を乗せずほぼ白 (--fg そのもの)。色相シグナルはページ固定枠の種別ラベルの
  // ヘッダトークン色 (目立たせ枠なので現状維持) と背景のわずかな色味が担う
  function coastKindPageBg(kind: string): string {
    return `color-mix(in srgb, ${coastKindRoleVar(kind)} 15%, var(--bg))`;
  }
  function coastKindHeaderOnVar(kind: string): string {
    if (kind === "大津波警報") return "var(--header-tsunamiMajor-on)";
    if (kind === "津波警報") return "var(--header-tsunamiWarning-on)";
    if (kind === "津波注意報") return "var(--header-tsunamiAdvisory-on)";
    return "var(--fg)";
  }

  function tsunamiHeightRankVar(value: number | null, fallback: string): string {
    if (value == null || !Number.isFinite(value)) return fallback;
    if (value > 3) return "var(--role-tsunamiMajor)";
    if (value > 1) return "var(--role-tsunamiWarning)";
    return "var(--role-tsunamiAdvisory)";
  }

  function tsunamiHeightColorVar(
    semantic: DisplayTsunamiHeightSemanticV1 | undefined,
    fallback: string,
  ): string {
    if (semantic == null) return fallback;
    switch (semantic.color) {
      case "normalRank":
        return tsunamiHeightRankVar(semantic.value, fallback);
      case "safetyRank":
        return tsunamiHeightRankVar(semantic.lowerBound, fallback);
      case "safetyUpperRank":
        return tsunamiHeightRankVar(semantic.upperBound ?? semantic.lowerBound, fallback);
      case "unknown":
        return "var(--c-raspberry)";
      case "neutral":
        return "var(--role-muted)";
      case "notRendered":
        return "var(--role-muted)";
    }
  }

  function tsunamiHeightLabel(
    legacyLabel: string | null | undefined,
    semantic: DisplayTsunamiHeightSemanticV1 | undefined,
  ): string {
    if (semantic == null) return legacyLabel ?? "-";
    if (!semantic.render || semantic.presence === "missing") return "-";
    const label = semantic.label?.trim();
    if (label) return label;
    if (semantic.presence === "empty") return "空欄";
    if (semantic.presence === "unknown") return "不明";
    return "不明";
  }

  function tsunamiHeightMeaning(
    legacyLabel: string | null | undefined,
    semantic: DisplayTsunamiHeightSemanticV1 | undefined,
  ): string | undefined {
    if (semantic == null) return undefined;
    const label = tsunamiHeightLabel(legacyLabel, semantic);
    const state = semantic.presence === "value"
      ? "通常値"
      : semantic.presence === "range"
        ? "範囲"
        : semantic.presence === "qualitative"
          ? "定性値"
          : semantic.presence === "unknown"
            ? "不明"
            : semantic.presence === "empty"
              ? "空欄"
              : "値なし";
    const condition = semantic.condition?.trim();
    const description = semantic.description?.trim();
    const badgeMeaning = semantic.badge === "≥"
      ? "以上（下限値）"
      : semantic.badge === "↔"
        ? "範囲"
        : semantic.badge === "?"
          ? "不明"
          : semantic.badge === "∅"
            ? "空欄"
            : null;
    const details = [
      state,
      badgeMeaning,
      condition == null || condition === "" ? null : `条件: ${condition}`,
      description == null || description === "" || description === label ? null : `説明: ${description}`,
    ].filter((part): part is string => part != null);
    return `高さ: ${label}（${details.join("、")}）`;
  }

  function tsunamiHeightBadge(semantic: DisplayTsunamiHeightSemanticV1 | undefined): string | null {
    if (semantic == null || !semantic.render || semantic.presence === "missing") return null;
    return semantic.badge;
  }
  function heightFingerprint(semantic: DisplayTsunamiHeightSemanticV1 | undefined) {
    return {
      raw: semantic?.raw ?? null, presence: semantic?.presence ?? null, label: semantic?.label ?? null,
      condition: semantic?.condition ?? null, description: semantic?.description ?? null,
      value: semantic?.value ?? null, lowerBound: semantic?.lowerBound ?? null,
      upperBound: semantic?.upperBound ?? null, rawLowerBound: semantic?.rawLowerBound ?? null,
      rawUpperBound: semantic?.rawUpperBound ?? null, badge: semantic?.badge ?? null,
      color: semantic?.color ?? null, render: semantic?.render ?? null,
    };
  }

  const panelRoleVar = $derived(
    input.level === "majorWarning"
      ? "var(--role-tsunamiMajor)"
      : input.level === "warning"
        ? "var(--role-tsunamiWarning)"
        : "var(--role-tsunamiAdvisory)",
  );

  type Coast = DisplayTsunamiInputV1["coasts"][number];

  // 生成時キー snapshot (spec §0-d / §2-c 最終改稿 2): 初期に存在する行キーを素の const で捕まえる。
  // 初期 snapshot も render も必ず同じ純関数 (keyCoastRows/keyObsRows) を通す (別経路で採番すると
  // 初期判定と render のキーがずれ初回行に reveal が付く)。初期行は revealScaleIn/heightReveal の
  // reveal=false で演出なし・frame-1 可視、初期 snapshot に無い後発行だけ reveal=true にする。
  // svelte-ignore state_referenced_locally -- 意図的に生成時の値を捕まえる非リアクティブ snapshot (spec §0-d / 最終改稿 2)
  const initialCoastKeys = new Set(keyCoastRows(input.coasts).map((r) => r.key));
  const coastRows = $derived(keyCoastRows(input.coasts));
  // svelte-ignore state_referenced_locally -- 同上
  const initialObsKeys = new Set(keyObsRows(input.observations).map((r) => r.key));
  const obsRows = $derived(keyObsRows(input.observations));

  const coastGroups = $derived.by(() => {
    const order: string[] = [];
    const map = new Map<string, KeyedRow<Coast>[]>();
    for (const r of coastRows) {
      const groupKey = coastKindGroupKey(r.row);
      if (!map.has(groupKey)) {
        map.set(groupKey, []);
        order.push(groupKey);
      }
      map.get(groupKey)!.push(r);
    }
    return order.map((key) => {
      const coasts = map.get(key)!;
      return { key, kind: coasts[0].row.kind, coasts };
    });
  });

  function observationCondition(o: DisplayTsunamiObservationV1): string {
    const condition = o.condition?.trim() ?? "";
    const heightCondition = o.maxHeightSemantic != null
      ? o.maxHeightSemantic.condition?.trim() ?? ""
      : o.heightCondition?.trim() ?? "";
    if (heightCondition === "" || heightCondition === condition) return condition;
    return `${condition}（${heightCondition}）`;
  }

  // 観測は警報レベルとの対応で間引かない。電文 input の全 identity を一巡列へ一度だけ載せる。
  const visibleObsRows = $derived(obsRows);

  interface EmergencyTsunamiPage {
    identity: string;
    fingerprint: string;
    type: "coast" | "observation";
    kind?: string;
    coasts?: KeyedRow<Coast>[];
    observations?: KeyedRow<DisplayTsunamiObservationV1>[];
    infeasible?: boolean;
    itemCount?: number;
  }
  interface TsunamiPartitionSection {
    id: string;
    type: "coast" | "observation";
    kind?: string;
    coasts: KeyedRow<Coast>[];
    observations: KeyedRow<DisplayTsunamiObservationV1>[];
  }
  interface ProbeMeasurement {
    contentHeight: number;
    availableHeight: number;
  }

  const tsunamiSections = $derived.by((): TsunamiPartitionSection[] => [
    ...coastGroups.map((group) => ({
      id: `coast:${group.key}`,
      type: "coast" as const,
      kind: group.kind,
      coasts: group.coasts,
      observations: [],
    })),
    ...(visibleObsRows.length === 0 ? [] : [{
      id: "observation",
      type: "observation" as const,
      coasts: [],
      observations: visibleObsRows,
    }]),
  ]);
  function sectionEntries(section: TsunamiPartitionSection) {
    if (section.type === "coast") return section.coasts.map((row) => ({
      identity: `coast:${row.key}`,
      fingerprint: itemContentFingerprint({
        name: row.row.name, kind: row.row.kind, maxHeight: row.row.maxHeight,
        maxHeightSemantic: heightFingerprint(row.row.maxHeightSemantic), firstHeight: row.row.firstHeight,
      }),
    }));
    return section.observations.map((row) => ({
      identity: `observation:${row.key}`,
      fingerprint: itemContentFingerprint({
        areaName: row.row.areaName ?? null, areaKind: row.row.areaKind ?? null,
        stationName: row.row.stationName, arrivalTime: row.row.arrivalTime, initial: row.row.initial,
        maxHeightValue: row.row.maxHeightValue, maxHeightSemantic: heightFingerprint(row.row.maxHeightSemantic),
        condition: row.row.condition ?? null, heightCondition: row.row.heightCondition ?? null,
      }),
    }));
  }
  function sectionCount(section: TsunamiPartitionSection): number {
    return section.type === "coast" ? section.coasts.length : section.observations.length;
  }

  // sequentialPartitionRanges の pending range を隠し棚で強制描画する。cache key は表示内容の
  // fingerprint と実測幅・高さを含み、続報・compact 切替・container 寸法変更のどれでも古い高さを再利用しない。
  let probeWidth = $state(0);
  let probeHeight = $state(0);
  let probeMeasurements = $state<Record<string, ProbeMeasurement>>({});
  let pendingProbeBox: { width: number; height: number } | null = null;
  const pendingProbeMeasurements = new Map<string, ProbeMeasurement>();
  const tsunamiProbeFingerprint = $derived(pageContentFingerprint(
    { compact },
    tsunamiSections.flatMap((section) => sectionEntries(section).map((entry) => ({
      identity: `${section.id}:${entry.identity}`,
      fingerprint: entry.fingerprint,
    }))),
  ));
  const tsunamiProbeGeneration = $derived(`${tsunamiProbeFingerprint}:w${Math.round(probeWidth * 100) / 100}:h${Math.round(probeHeight * 100) / 100}`);
  function tsunamiProbeId(sectionId: string, range: Pick<PageRange, "start" | "end">): string {
    return `${tsunamiProbeGeneration}:${sectionId}:${range.start}:${range.end}`;
  }
  function partitionProbeFor(section: TsunamiPartitionSection): PartitionProbe {
    return (_key, _placement, range) => {
      // jsdom has no layout engine. Production always takes the shelf/cache path.
      if (typeof ResizeObserver === "undefined") {
        return range.end - range.start <= TSUNAMI_PAGE_ROW_CAPACITY ? 0 : 2;
      }
      const measured = probeMeasurements[tsunamiProbeId(section.id, range)];
      if (measured == null) return null;
      return measured.contentHeight <= measured.availableHeight + 1 ? 0 : 2;
    };
  }
  const tsunamiPartitions = $derived.by((): Array<{ section: TsunamiPartitionSection; result: PartitionResult }> =>
    tsunamiSections.map((section) => ({
      section,
      result: sequentialPartitionRanges(
        "tsunami",
        compact ? "side" : "center",
        sectionCount(section),
        1,
        partitionProbeFor(section),
        () => [],
      ),
    })),
  );
  const panelPages = $derived.by((): EmergencyTsunamiPage[] => tsunamiPartitions.flatMap(({ section, result }): EmergencyTsunamiPage[] => {
    if (result.infeasible) {
      return [{
        identity: `emergency-tsunami-details:${section.id}:infeasible`,
        fingerprint: pageContentFingerprint(
          { type: section.type, kind: section.kind ?? null, infeasible: true },
          sectionEntries(section),
        ),
        type: section.type,
        kind: section.kind,
        infeasible: true,
        itemCount: sectionCount(section),
      }];
    }
    return result.ranges.map((range) => {
      const entries = sectionEntries(section).slice(range.start, range.end);
      const identity = `emergency-tsunami-details:${section.id}:${entries[0]?.identity ?? range.start}:${entries.at(-1)?.identity ?? range.end}`;
      return {
        identity,
        fingerprint: pageContentFingerprint(
          { type: section.type, kind: section.kind ?? null, start: range.start },
          entries,
        ),
        type: section.type,
        kind: section.kind,
        coasts: section.type === "coast" ? section.coasts.slice(range.start, range.end) : undefined,
        observations: section.type === "observation" ? section.observations.slice(range.start, range.end) : undefined,
      };
    });
  }));
  const tsunamiPartitionPending = $derived(tsunamiPartitions.some(({ result }) => result.pending.length > 0));
  const tsunamiProbePages = $derived(tsunamiPartitions.flatMap(({ section, result }) =>
    result.pending.map((range) => ({
      id: tsunamiProbeId(section.id, range),
      section,
      range,
      coasts: section.coasts.slice(range.start, range.end),
      observations: section.observations.slice(range.start, range.end),
    })),
  ));

  function commitProbeMeasurement(id: string, measurement: ProbeMeasurement): void {
    if (layoutSettling) {
      pendingProbeMeasurements.set(id, measurement);
      return;
    }
    const previous = probeMeasurements[id];
    if (previous?.contentHeight === measurement.contentHeight
      && previous.availableHeight === measurement.availableHeight) return;
    probeMeasurements = { ...probeMeasurements, [id]: measurement };
  }
  function measurePartitionProbe(node: HTMLElement, id: string) {
    let currentId = id;
    const measure = (): void => {
      const measurement = { contentHeight: node.scrollHeight, availableHeight: node.clientHeight };
      if (measurement.contentHeight > 0 && measurement.availableHeight > 0) {
        commitProbeMeasurement(currentId, measurement);
      }
    };
    if (typeof ResizeObserver === "undefined") return { update(next: string) { currentId = next; } };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    queueMicrotask(measure);
    return {
      update(next: string) { currentId = next; measure(); },
      destroy() { observer.disconnect(); },
    };
  }
  function observeProbeBox(node: HTMLElement) {
    if (typeof ResizeObserver === "undefined") return {};
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.getBoundingClientRect().width;
      const height = entries[0]?.contentRect.height ?? node.getBoundingClientRect().height;
      if (!(width > 0) || !(height > 0)) return;
      if (layoutSettling) pendingProbeBox = { width, height };
      else {
        probeWidth = width;
        probeHeight = height;
      }
    });
    observer.observe(node);
    return { destroy() { observer.disconnect(); } };
  }
  $effect(() => {
    if (layoutSettling) return;
    if (pendingProbeBox != null) {
      probeWidth = pendingProbeBox.width;
      probeHeight = pendingProbeBox.height;
      pendingProbeBox = null;
    }
    if (pendingProbeMeasurements.size > 0) {
      probeMeasurements = { ...probeMeasurements, ...Object.fromEntries(pendingProbeMeasurements) };
      pendingProbeMeasurements.clear();
    }
  });

  // resetSeq: episode (VTSE41 EventID) が変わった時点で先頭へ戻す。同一 EventID の
  // 続報は位置を維持し、level 上昇だけは従来どおり見直しとして先頭へ戻す。
  const LEVEL_RANK: Record<DisplayTsunamiInputV1["level"], number> = { advisory: 0, warning: 1, majorWarning: 2 };
  let resetSeq = $state(0);
  let prevLevelRank = -1;
  let prevEpisodeId: string | null | undefined;
  let prevEpisodeResetKey: number | undefined;
  $effect(() => {
    const rank = LEVEL_RANK[input.level];
    const episodeId = normalizeTsunamiEventId(input.eventId);
    const resetAtSnapshotBoundary = episodeResetKey != null
      && prevEpisodeResetKey !== undefined
      && episodeResetKey !== prevEpisodeResetKey;
    if ((prevEpisodeId !== undefined && episodeId !== prevEpisodeId) || resetAtSnapshotBoundary || rank > prevLevelRank) resetSeq += 1;
    prevEpisodeId = episodeId;
    prevEpisodeResetKey = episodeResetKey;
    prevLevelRank = rank;
  });

  const attention = new PageAttentionState();
  const episodeKey = $derived(normalizeTsunamiEventId(input.eventId) ?? `unkeyed:${episodeResetKey ?? 0}`);
  $effect(() => {
    const generation = {
      episodeKey: `tsunami:${episodeKey}`,
      severityRank: LEVEL_RANK[input.level],
      pages: panelPages,
      preserveStablePages: true,
      partitionPending: tsunamiPartitionPending,
    };
    untrack(() => attention.sync(generation));
  });
  const pageCycler = createPageCycler({
    pageCount: () => panelPages.length,
    resetKey: () => resetSeq,
    reducedMotion: () => reducedMotion,
    pageIdentity: () => panelPages[pageCycler.index]?.identity ?? null,
    pageFingerprint: () => panelPages[pageCycler.index]?.fingerprint ?? "",
    onHoldComplete: (_index, identity, fingerprint) => {
      const active = panelPages[pageCycler.index];
      if (identity != null && active?.identity === identity && active.fingerprint === fingerprint) attention.markHoldComplete(identity);
    },
  });
  // unmount (main-stack のモード切替・panel 差替え) で $effect.root のタイマー/matchMedia
  // リスナーがリークしないよう、コンポーネント破棄時に必ず destroy() する (Codex R レビュー M1)
  onDestroy(() => pageCycler.destroy());
  const maxObservation = $derived(maxTsunamiObservation(input.observations));
  const currentTsunamiPage = $derived(panelPages[pageCycler.index] ?? panelPages[0] ?? null);
  const attentionView = $derived(attention.viewModel(pageCycler.index));
  const flipDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);

</script>

<!-- 行の「中身」だけを snippet 化する (spec §2-c Medium 3): animate:flip は keyed each の直接
     child である <li> に置く必要があり snippet 越しの <li> には置けない (animation_invalid_placement)。
     <li> を各 each 内へインライン展開し高さ wrapper 化 (overflow:hidden・padding は body 側)、
     内側 body (.coast-row/.observation-row) をこの snippet が返す。body は transform+opacity の
     revealScaleIn、<li> は高さの heightReveal と位置の flip を担う (軸が異なるため共存可)。 -->
{#snippet coastRowBody(c: Coast, _i: number, tintHeight: boolean, reveal: boolean)}
  <div
    class="coast-row"
    data-motion-reveal="scale"
    in:revealScaleIn={{ reveal, duration: SPRING_SPATIAL_DEFAULT_MS }}
  >
    <span class="coast-name">{c.name}</span>
    <span
      class="coast-height"
      style={tintHeight || c.maxHeightSemantic != null ? `color: ${tsunamiHeightColorVar(c.maxHeightSemantic, panelRoleVar)}` : undefined}
      title={tsunamiHeightMeaning(c.maxHeight, c.maxHeightSemantic)}
      aria-label={tsunamiHeightMeaning(c.maxHeight, c.maxHeightSemantic)}
    >{tsunamiHeightLabel(c.maxHeight, c.maxHeightSemantic)}{#if tsunamiHeightBadge(c.maxHeightSemantic) != null}<b class="semantic-badge height-badge" aria-hidden="true">{tsunamiHeightBadge(c.maxHeightSemantic)}</b>{/if}</span>
    <!-- T7 レビュー決定 (spec §2-c【確定 2026-07-10】): 括弧補足を削り時刻をコロン形式にした
         表示専用整形 (formatArrivalDisplay、tsunami-bucket.ts)。分類 (bucketTsunamiArrival) は
         この整形前の c.firstHeight そのままで行っている (別ロジック、上のスクリプト参照) -->
    <span class="coast-first">{formatArrivalDisplay(c.firstHeight) ?? "-"}</span>
  </div>
{/snippet}

{#snippet observationRowBody(o: DisplayTsunamiObservationV1, _i: number, reveal: boolean)}
  <div
    class="observation-row"
    data-motion-reveal="scale"
    in:revealScaleIn={{ reveal, duration: SPRING_SPATIAL_DEFAULT_MS }}
  >
    <span class="obs-name">{o.stationName}</span>
    <span class="obs-time">{formatHm(o.arrivalTime)}</span>
    <span class="obs-initial">{o.initial ?? ""}</span>
    <span
      class="obs-max-value"
      style={o.maxHeightSemantic != null ? `color: ${tsunamiHeightColorVar(o.maxHeightSemantic, "#fff")}` : undefined}
      title={tsunamiHeightMeaning(o.maxHeightValue, o.maxHeightSemantic)}
      aria-label={tsunamiHeightMeaning(o.maxHeightValue, o.maxHeightSemantic)}
    >{tsunamiHeightLabel(o.maxHeightValue, o.maxHeightSemantic)}{#if tsunamiHeightBadge(o.maxHeightSemantic) != null}<b class="semantic-badge height-badge" aria-hidden="true">{tsunamiHeightBadge(o.maxHeightSemantic)}</b>{/if}</span>
    <span class="obs-condition">{observationCondition(o)}</span>
  </div>
{/snippet}

<div class="tsunami-panel tsunami-{input.level}" class:compact>
  <div class="level-label">{input.levelLabel}</div>
  {#if input.warningComment != null}
    <p class="warning-comment prose">{input.warningComment}</p>
  {/if}
  <div class="instrument">
    <div class="instrument-action">
      <span class="action-word" style="color: {panelRoleVar}">{actionWord}</span>
      <span class="area-count">{input.coasts.length}予報区</span>
    </div>
    {#if maxHeightHeadline != null}
      <div class="instrument-headline">
        <span class="headline-label">予想最大</span>
        <span
          class="headline-value"
          style="color: {tsunamiHeightColorVar(maxHeightHeadline.semantic, panelRoleVar)}"
          title={tsunamiHeightMeaning(maxHeightHeadline.label, maxHeightHeadline.semantic)}
          aria-label={tsunamiHeightMeaning(maxHeightHeadline.label, maxHeightHeadline.semantic)}
        >{tsunamiHeightLabel(maxHeightHeadline.label, maxHeightHeadline.semantic)}{#if tsunamiHeightBadge(maxHeightHeadline.semantic) != null}<b class="semantic-badge height-badge" aria-hidden="true">{tsunamiHeightBadge(maxHeightHeadline.semantic)}</b>{/if}</span>
        <span class="headline-count">{maxHeightHeadline.count}予報区</span>
      </div>
    {/if}
    {#if fastestArrivalHeadline != null}
      <div class="instrument-headline">
        <span class="headline-label">最速到達</span>
        <span class="headline-value" style="color: {panelRoleVar}">{fastestArrivalHeadline.label}</span>
        <span class="headline-count">{fastestArrivalHeadline.count}予報区</span>
      </div>
    {/if}
  </div>
  {#if heightBadgeLegend.length > 0}
    <div class="height-badge-legend" aria-label="津波高さ記号の凡例">
      {#each heightBadgeLegend as item (item.badge)}
        <span class="height-badge-legend-item"><b>{item.badge}</b><span>{item.meaning}</span></span>
      {/each}
    </div>
  {/if}
  {#if input.observations.length > 0}
    <div class="fixed-observation-summary" data-observation-summary>
      <div class="obs-summary-frame">
        <span class="obs-summary-line">{#if maxObservation != null}最大観測: <span class="obs-summary-value">{tsunamiHeightLabel(maxObservation.label, maxObservation.semantic)}</span> {maxObservation.stationName} / {/if}{#if maxObservation != null}{" "}{/if}観測 {input.observations.length}地点</span>
      </div>
    </div>
  {/if}
  <div class="tiles">
    <div
      class="tile tile-coasts unified-page"
      class:page-tinted={currentTsunamiPage?.type === "coast"}
      style={currentTsunamiPage?.type === "coast" ? `--page-bg: ${coastKindPageBg(currentTsunamiPage.kind ?? "")};` : undefined}
      use:observeProbeBox
    >
      {#if currentTsunamiPage != null}
        {#key pageCycler.index}
          <div
            class="page-fade"
            transition:fade={{
              duration: reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
              easing: springEffectsOut,
            }}
            data-page-identity={currentTsunamiPage.identity}
          >
            <div class="page-frame">
              <h2 class="page-heading">{currentTsunamiPage.type === "coast" ? "予報区" : "観測"}</h2>
              {#if currentTsunamiPage.type === "coast"}<span class="page-kind" style="color: {coastKindHeaderOnVar(currentTsunamiPage.kind ?? "")}">{currentTsunamiPage.kind}</span>{/if}
              {#if pageCycler.total > 1}<PageDots total={pageCycler.total} current={pageCycler.index} onJump={(i) => pageCycler.jumpTo(i)} />{/if}
              {#if attentionView.text !== ""}<span class="page-attention" data-page-attention={attentionView.text}>{attentionView.text}</span>{/if}
            </div>
            {#if currentTsunamiPage.infeasible}
              <div class="partition-infeasible-message">表示領域不足・{currentTsunamiPage.itemCount ?? 0}{currentTsunamiPage.type === "coast" ? "予報区" : "地点"}</div>
            {:else if currentTsunamiPage.type === "coast"}
              <ul class="coasts page-list-body">
                {#each currentTsunamiPage.coasts ?? [] as r, i (r.key)}
                  <li class="coast-row-wrap" data-motion-reveal="height" animate:flip={{ duration: flipDur, easing: springSpatialOut }} in:heightReveal={{ reveal: false, duration: SPRING_EFFECTS_DEFAULT_MS }}>
                    {@render coastRowBody(r.row, i, false, false)}
                  </li>
                {/each}
              </ul>
            {:else}
              <ul class="observations page-list-body">
                {#each currentTsunamiPage.observations ?? [] as r, i (r.key)}
                  <li class="observation-row-wrap" data-motion-reveal="height" animate:flip={{ duration: flipDur, easing: springSpatialOut }} in:heightReveal={{ reveal: false, duration: SPRING_EFFECTS_DEFAULT_MS }}>
                    {@render observationRowBody(r.row, i, false)}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/key}
      {/if}
      <div class="partition-probe-shelf" aria-hidden="true" inert data-partition-probe-shelf>
        {#each tsunamiProbePages as probe (probe.id)}
          <div class="partition-probe-page" class:coast-probe={probe.section.type === "coast"}>
            <div class="page-frame">
              <h2 class="page-heading">{probe.section.type === "coast" ? "予報区" : "観測"}</h2>
              {#if probe.section.type === "coast"}<span class="page-kind">{probe.section.kind}</span>{/if}
              {#if panelPages.length > 1}<span class="partition-probe-dots">{#each panelPages as _, index (index)}<i class:current={index === 0}></i>{/each}</span>{/if}
              <span class="page-attention">{panelPages.length > 1 ? `1/${panelPages.length}・未表示${panelPages.length}` : "未表示1"}</span>
            </div>
            {#if probe.section.type === "coast"}
              <ul
                class="coasts page-list-body partition-probe-body"
                data-partition-probe-range={`${probe.range.start}:${probe.range.end}`}
                use:measurePartitionProbe={probe.id}
              >
                {#each probe.coasts as row, rowIndex (row.key)}
                  <li class="coast-row-wrap">{@render coastRowBody(row.row, rowIndex, false, false)}</li>
                {/each}
              </ul>
            {:else}
              <ul
                class="observations page-list-body partition-probe-body"
                data-partition-probe-range={`${probe.range.start}:${probe.range.end}`}
                use:measurePartitionProbe={probe.id}
              >
                {#each probe.observations as row, rowIndex (row.key)}
                  <li class="observation-row-wrap">{@render observationRowBody(row.row, rowIndex, false)}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .tsunami-panel {
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
  .level-label {
    box-sizing: border-box;
    min-height: calc(var(--panel-header-min-h) * var(--panel-scale, 1));
    display: flex;
    align-items: center;
    font-size: calc(var(--panel-header-font-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
    padding: calc(var(--panel-header-padding-v) * var(--panel-scale, 1))
      calc(var(--panel-header-padding-h) * var(--panel-scale, 1));
  }
  .tsunami-majorWarning .level-label {
    background: var(--header-tsunamiMajor-container);
    color: var(--header-tsunamiMajor-on);
    border-bottom: var(--header-band-width) solid var(--header-band-tsunamiMajor);
  }
  .tsunami-warning .level-label {
    background: var(--header-tsunamiWarning-container);
    color: var(--header-tsunamiWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-tsunamiWarning);
  }
  .tsunami-advisory .level-label {
    background: var(--header-tsunamiAdvisory-container);
    color: var(--header-tsunamiAdvisory-on);
    border-bottom: var(--header-band-width) solid var(--header-band-tsunamiAdvisory);
  }
  .warning-comment {
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    color: var(--fg);
    padding: 12px calc(28px * var(--panel-scale, 1)) 0;
    margin: 0;
  }
  .instrument {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) calc(28px * var(--panel-scale, 1)) 0;
  }
  .instrument-action {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-4);
  }
  .action-word {
    font-size: calc(var(--type-headline-s-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
  }
  .area-count {
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
  }
  .instrument-headline {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
    font-weight: var(--type-title-weight-emphasized);
  }
  .headline-label {
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
    color: var(--role-muted);
    letter-spacing: 0.05em;
  }
  /* T6c ③: 「10m超」等の値トークンを途中改行させない (.city-name/.obs-summary-value と同じ規範) */
  .headline-value {
    white-space: nowrap;
  }
  .height-badge {
    margin-inline-start: 0.15em;
    font-weight: var(--type-weight-bold);
  }
  .headline-count {
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
  }
  .height-badge-legend {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    padding: var(--space-2) calc(28px * var(--panel-scale, 1)) 0;
    color: var(--role-muted);
    font-size: max(12px, calc(var(--type-label-s-size) * var(--panel-scale, 1)));
  }
  .height-badge-legend-item {
    display: inline-flex;
    gap: 0.25em;
    white-space: nowrap;
  }
  .height-badge-legend-item b {
    color: var(--fg);
    font-weight: var(--type-weight-bold);
  }
  .fixed-observation-summary {
    flex: 0 0 auto;
    padding: var(--space-2) calc(28px * var(--panel-scale, 1)) 0;
    color: var(--role-muted);
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    font-variant-numeric: tabular-nums;
  }
  .tiles {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: var(--space-3) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
    padding: var(--space-4) var(--space-5);
  }
  .unified-page {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .page-attention {
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .obs-summary-frame {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-bottom: var(--space-2);
  }
  .obs-summary-line {
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
  }
  /* T6c ③: 「8.5m以上」のような値を 1 トークンとして扱い、CJK 文字と英数字の境界で
     途中改行させない (.city-name と同じ規範)。周りの文はこれまで通り自然折返しできる */
  .obs-summary-value {
    white-space: nowrap;
  }
  .page-frame {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }
  .page-heading {
    font-size: calc(var(--type-body-s-size) * var(--panel-scale, 1));
    letter-spacing: 0.2em;
    color: var(--role-muted);
    font-weight: var(--type-body-weight);
    margin: 0;
  }
  .page-kind {
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    font-weight: var(--type-title-weight);
  }
  /* ページ切替の重ねクロスフェード (T5c、spec §3 再々改訂「数十msの短いディップはチカチカする
     ため撤回、旧ページと新ページを重ねる」)。{#key pageCycler.index}/{#key obsPageCycler.index}
     で再マウントされる .page-fade を、position:relative な親 (.tile-coasts.page-tinted /
     .obs-list-host.paged、どちらも flex:1;min-height:0 で .tiles から実測される固定高さを受け取る)
     に position:absolute;inset:0 で重ねる。outro (旧ページ) と intro (新ページ) が同時に走り、
     空白を経由しない。時間/easing は新規定数を作らず既存の spring-effects-default を
     Svelte transition:fade の easing (springEffectsOut、lib/motion.ts) に渡して流用する。
     背景色 (--page-bg) は別要素 (.tile-coasts.page-tinted) 側の CSS transition で同時に
     滑らかに変わる (こちらは JS 管理ではなく CSS 側で同じ spring-effects-default-dur を使う) */
  .page-fade {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  /* sequentialPartitionRanges の pending 候補を live と同じ固定枠で強制描画する棚。
     aria-hidden/inert と absolute + visibility:hidden により表示・通常レイアウトの外に置く。 */
  .partition-probe-shelf,
  .partition-probe-page {
    position: absolute;
    inset: 0;
  }
  .partition-probe-shelf {
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
  }
  .partition-probe-page {
    display: flex;
    flex-direction: column;
  }
  .partition-probe-page {
    padding: var(--space-4) var(--space-5);
  }
  .partition-probe-dots {
    display: flex;
    align-items: center;
    align-self: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: auto;
  }
  .partition-probe-dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .partition-probe-dots i.current {
    width: 8px;
    height: 8px;
  }
  .partition-infeasible-message {
    color: var(--role-muted);
    font-size: calc(var(--type-title-m-size) * var(--panel-scale, 1));
  }
  /* 予報区ページ領域の種別別背景色面 (spec §2-c 改訂、可読性優先の高コントラスト版)。--page-bg
     は coastKindPageBg (種別色 15% + 最暗 --bg の color-mix) で JS 側から差し込む。本文文字は
     色相を乗せない --fg そのもの (page-kind の見出しラベルだけ inline style でヘッダトークン色を
     維持し、色相シグナルの役割を担う)。observation ページは対象外 — 種別色は予報区のみ (レビュー決定) */
  .tile-coasts.page-tinted {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--page-bg);
    color: var(--fg);
    /* 種別またぎのページ切替で背景色も一緒に滑らかに変わる (T5c)。--page-bg の値自体は
       inline style で JS から差し込まれる (このルールは同一要素上で値が変わるだけなので
       遷移が効く。中身の {#key} 再マウントとは別軸)。時間は既存の effects spring トークンを流用 */
    transition: background-color var(--spring-effects-default-dur) var(--spring-effects-default);
  }
  /* ページ見出しはメタ情報 (証跡の主役ではない) なのでミュートする。ページ番号の文字表示は
     T8① でドットインジケータ (PageDots) に置き換わったため、この対象から外れた (PageDots は
     background で自己完結して視認性を保つ、TsunamiPanel.svelte 側の CSS は関与しない)。
     予報区名/波高/到達予想の 3 列は上の .page-tinted { color: var(--fg) } をそのまま継承する */
  .tile-coasts.page-tinted .page-heading {
    color: color-mix(in srgb, var(--fg) 65%, var(--page-bg));
  }
  /* T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
     要素の containing block は「最も近い positioned 祖先の padding box」(CSS 仕様上、border box
     ではなく padding box) になるため、.page-fade (position:absolute;inset:0) は
     .tile-coasts.page-tinted 自身の padding (.tile の padding: var(--space-4) var(--space-5)) を
     内側に含めて塗りつぶし、.tile の padding を実質無かったことにしてしまっていた
     (position:relative の祖先と padding の宿主が同一要素のときに起きる既知の CSS の落とし穴)。
     .page-fade に同じ padding を明示的に持たせて復元する。.tile-coasts の総 footprint
     (coastsBox 実測) はこの padding を元から含んでいた (padding は .tile 自身の border-box の
     一部) ので変わらないが、.page-fade 内部の実行可能な行表示領域はこの分だけ狭くなる
     (coastRowCapacity の PAGE_FADE_PADDING_PX 補正、上のスクリプト参照)。観測 page も同じ
     unified-page の直下で absolute に重なるため、同じ tile 契約の padding をここで復元する。 */
  .tile-coasts.unified-page .page-fade {
    padding: var(--space-4) var(--space-5);
  }
  .coast-group {
    margin-bottom: var(--space-5);
  }
  .coast-group:last-child {
    margin-bottom: 0;
  }
  .coast-kind {
    font-size: calc(var(--type-body-s-size) * var(--panel-scale, 1));
    letter-spacing: 0.2em;
    font-weight: var(--type-body-weight);
    margin: 0 0 8px;
  }
  .coasts {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .observations {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* 行の高さ wrapper (spec §2-c 最終改稿 3): <li> 自身は padding/border/margin 0。heightReveal が
     height:0 で完全に閉じるよう、行の見た目 padding (4px 0) は内側 body (.coast-row/.observation-row)
     側に残す。flip=位置・heightReveal=高さで軸が異なり共存する。overflow はアニメ中だけ heightReveal
     が出すので恒久 hidden は付けない (レビュー指摘 Medium 4、長い値の恒久切断を避ける)。 */
  .coast-row-wrap,
  .observation-row-wrap {
    list-style: none;
    padding: 0;
    border: 0;
    margin: 0;
  }
  /* live と probe の本文は同じ固定領域を受ける。scrollHeight/clientHeight の比較で候補 range
     全体が収まることを証明してから live page に採用する。 */
  .page-list-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .coast-row {
    display: grid;
    /* 到達予想時刻列 (「09時14分頃（地震発生から2分）」等) はカード幅に応じて余白を使い切る
       minmax/1fr にする (第3波 Fix18)。予報区名の桁揃えは em 固定で不変。波高列 (2 列目) は
       T6c ③ で "10m超" 等の値が桁で改行されないよう minmax(4em, max-content) に変更した
       (固定 4em のままだと "10m超" のようなやや長い値が収まりきらず途中改行することがあった) */
    grid-template-columns: 11em minmax(4em, max-content) minmax(11em, 1fr);
    gap: var(--space-4);
    align-items: baseline;
    font-size: calc(var(--type-title-m-size) * var(--panel-scale, 1));
    padding: 4px 0;
  }
  .coast-name {
    font-weight: var(--type-title-weight);
    overflow-wrap: anywhere; /* 「奄美群島・トカラ列島」等の長い区域名基準 (11em) */
  }
  /* T6c ③ (preview 目視指摘): 「10m超」等の値を CJK/英数字境界で途中改行させない
     (.city-name/.headline-value と同じ規範)。列幅は上の grid-template-columns 側で
     max-content まで許容しているため、nowrap にしても隣の列にはみ出さない */
  .coast-height {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: var(--num-weight);
    white-space: nowrap;
  }
  /* 到達予想列は「10時14分頃（地震発生から2分）」のような複合フレーズも入るため、単語境界
     (句読点・括弧) での折返し自体は妨げないが、"10時14分頃" のような値の途中で CJK 境界に
     よって割れるのは同じ見た目バグなので nowrap にする。列は minmax(11em, 1fr) で十分な
     横幅を持てるため、1 行に収まらないほど極端に長い値が来ない限りはみ出さない */
  .coast-first {
    text-align: left;
    font-variant-numeric: tabular-nums;
    color: var(--role-muted);
    white-space: nowrap;
  }
  .observations-heading {
    font-size: calc(var(--type-body-s-size) * var(--panel-scale, 1));
    letter-spacing: 0.2em;
    color: var(--role-muted);
    font-weight: var(--type-body-weight);
    margin: 0;
  }
  .tile-observations ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* T5c: 観測ページングも予報区と同じ「重ねクロスフェード + flex 実測」構造にする。
     .tile-observations.paged は .tiles から flex:1 で高さを受け取り (obsNeedsPaging のときのみ、
     静的表示では content-driven の従来どおり)、.obs-list-host がそれを丸ごと引き継いで
     .page-fade を position:absolute で重ねる。
     M3 派生 (Codex R レビュー): .obs-list-host は静的/ページングどちらの枝でも常時マウントされる
     単一要素にした (旧 .obs-page-host は {#if obsNeedsPaging} の内側にしか存在せず、静的表示中は
     measureHeight の観測対象が無くなり容量を再測定できない鶏卵/stale の原因だった)。
     paged 修飾子が付くときだけ flex:1 化する挙動自体は不変 */
  .tile-observations.paged {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .obs-list-host.paged {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .obs-list-host.paged .page-fade ul {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .observation-row {
    display: grid;
    /* T6c ③: 4 列目 (obs-max-value、"8.5m以上" 等) は固定 4em のままだと桁数の多い値
       (以上・超 等の接尾辞込み) が収まりきらず途中改行することがあったため、
       minmax(4em, max-content) に変更した (.coast-height と同じ理由) */
    grid-template-columns: 10em 5ch 3em minmax(4em, max-content) 6em;
    gap: var(--space-4);
    align-items: baseline;
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
    padding: 4px 0;
  }
  .obs-name {
    overflow-wrap: anywhere; /* 「日向灘沖GPS波浪計」等の長い観測点名基準 (10em) */
  }
  .obs-time {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--role-muted);
  }
  .obs-initial {
    color: var(--role-muted);
  }
  .obs-max-value {
    text-align: right; /* "8.5m" 基準 */
    font-variant-numeric: tabular-nums;
    font-weight: var(--num-weight);
    color: #fff;
    white-space: nowrap; /* T6c ③: 「8.5m以上」等の値を途中改行させない (.city-name と同じ規範) */
  }
  .obs-condition {
    color: var(--role-muted);
  }

  /* compact (main-stack 非 main スロット): 情報密度が高い津波パネルを狭い右列に収めるため、
     見出し・計器・行の type と padding を一段落とす。列構造 (coast-row の grid、em 基準) は
     font-size を落とせば比例縮小するため据え置き、既存の縮退機構 (ページング/2カラム) とは衝突
     させない (Codex R4。他パネルの compact と同じ「type と間隔だけ圧縮」の粒度に合わせる)。 */
  .tsunami-panel.compact .level-label {
    min-height: 0;
    font-size: var(--type-title-m-size);
    padding: var(--space-1) var(--space-3);
  }
  .tsunami-panel.compact .warning-comment {
    font-size: var(--type-label-l-size);
    padding: var(--space-1) var(--space-3) 0;
  }
  .tsunami-panel.compact .instrument {
    padding: var(--space-2) var(--space-3) 0;
    gap: 2px;
  }
  .tsunami-panel.compact .action-word {
    font-size: var(--type-title-m-size);
  }
  .tsunami-panel.compact .instrument-headline {
    font-size: var(--type-title-s-size);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .headline-label,
  .tsunami-panel.compact .headline-count {
    font-size: var(--type-label-m-size);
  }
  .tsunami-panel.compact .tiles {
    padding: var(--space-2) var(--space-3) var(--space-3);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .tile {
    padding: var(--space-2) var(--space-3);
  }
  /* compact でも probe は live page と同じ内側余白で測る。片方だけを狭めると、
     partition の fit 判定が実表示より楽観的になり、末尾行を clip し得る。 */
  .tsunami-panel.compact .tile-coasts.unified-page .page-fade,
  .tsunami-panel.compact .partition-probe-page {
    padding: var(--space-2) var(--space-3);
  }
  .tsunami-panel.compact .coast-row {
    font-size: var(--type-label-l-size);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .observation-row {
    font-size: var(--type-label-m-size);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .fixed-observation-summary {
    font-size: var(--type-label-m-size);
  }

  /* bento: 十分な幅があれば区域リストと観測実況を左右 2 カラムに (観測が無ければ全幅)
     閾値 1200px: 860px だと左右分割/スタック内 (パネル幅 ~950px) で観測実況タイルに
     行が入らず右端が見切れるため、全面幅 (~1870px) でのみ発動するよう引き上げた */
  @container (min-width: 1200px) {
    /* D1-A の単一 pager は 1 枚の固定本文 tile を使う。旧二列 tile の reset を残すと
       観測ページだけ content-height へ縮み、本文が clip するためここでは再配置しない。 */
    .unified-page { min-height: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    /* .page-fade の opacity クロスフェードは Svelte transition:fade の duration を
       cycler.reducedMotion (JS 側、matchMedia 購読) で 0 にして止める。CSS 側では
       背景色 transition (JS 管理外) だけを reduced-motion で瞬時にする */
    .tile-coasts.page-tinted {
      transition: none;
    }
  }
</style>
