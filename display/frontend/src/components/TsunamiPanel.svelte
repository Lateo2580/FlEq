<script lang="ts">
  import type { DisplayTsunamiInputV1, DisplayTsunamiObservationV1 } from "../lib/protocol";
  import { formatHm } from "../lib/format";
  import {
    bucketTsunamiHeight,
    bucketTsunamiArrival,
    formatArrivalDisplay,
    maxTsunamiObservation,
  } from "../lib/tsunami-bucket";
  import {
    TSUNAMI_PAGE_ROW_CAPACITY,
    TILES_GAP_PX,
    PAGE_FADE_PADDING_PX,
    PAGE_FRAME_MARGIN_PX,
    OBS_SUMMARY_FRAME_MARGIN_PX,
    TILE_PADDING_PX,
    isStackedLayout,
    rowCapacity,
    sectionAvailableHeight,
  } from "../lib/instrument-layout";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import {
    measureHeight,
    measureBorderHeight,
    observeResize,
    readBox,
    type MeasuredBox,
  } from "../lib/measure-height";
  import {
    SPRING_EFFECTS_DEFAULT_MS,
    SPRING_SPATIAL_DEFAULT_MS,
    springEffectsOut,
    springSpatialOut,
  } from "../lib/motion";
  import { revealScaleIn, heightReveal } from "../lib/transitions";
  import { keyCoastRows, keyObsRows, type KeyedRow } from "../lib/tsunami-rows";
  import { fade } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { onDestroy } from "svelte";
  import PageDots from "./PageDots.svelte";

  // compact: main-stack の非 main スロット (狭い右列) から true が渡る。情報密度が高い津波パネルを
  // 狭域に収めるため、見出し・計器・行の type と padding を一段圧縮する (下記 .tsunami-panel.compact)。
  // layoutSettling: 緊急画面のレイアウト遷移中 (グリッド track 補間中) は EmergencyScreen から true が
  // 渡る。遷移中はタイル/行の実測が過渡値になり再ページングが暴れるため、測定反映を保留する (spec §4)。
  let {
    input,
    compact = false,
    layoutSettling = false,
  }: { input: DisplayTsunamiInputV1; compact?: boolean; layoutSettling?: boolean } = $props();

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
      if (!map.has(r.row.kind)) {
        map.set(r.row.kind, []);
        order.push(r.row.kind);
      }
      map.get(r.row.kind)!.push(r);
    }
    return order.map((kind) => ({ kind, coasts: map.get(kind)! }));
  });

  // 予報区リストのページング (spec §2-c / §3)。全件が 1 ページに収まるなら (種別をまたいでいても)
  // ページャを出さず既存の静的グルーピング表示のまま。収まらない場合のみ、種別ごとに
  // TSUNAMI_PAGE_ROW_CAPACITY 行単位でチャンク化し、種別をまたぐときは必ずページ境界を切る
  interface TsunamiPage {
    kind: string;
    coasts: KeyedRow<Coast>[];
  }

  function observationVisible(o: DisplayTsunamiObservationV1): boolean {
    if (o.areaKind == null) return true; // 対応が取れない実測値は安全側で常に表示
    if (input.level === "majorWarning") return o.areaKind === "大津波警報" || o.areaKind === "津波警報";
    if (input.level === "warning") return o.areaKind === "津波警報";
    return o.areaKind === "津波注意報";
  }

  function observationCondition(o: DisplayTsunamiObservationV1): string {
    const condition = o.condition?.trim() ?? "";
    const heightCondition = o.heightCondition?.trim() ?? "";
    if (heightCondition === "" || heightCondition === condition) return condition;
    return `${condition}（${heightCondition}）`;
  }

  const visibleObsRows = $derived(obsRows.filter((r) => observationVisible(r.row)));
  const visibleObservations = $derived(visibleObsRows.map((r) => r.row));

  // ページ行容量の画面高さ駆動化 (T5c、spec §2-c)。rowHeightPx は実際に描画された行
  // (.coast-row / .observation-row の先頭要素) の実測高さ。行は padding 込みでリスト内の
  // 1 行として縦幅を消費するため border-box で測る (measureBorderHeight、T6b M-b 対応。
  // content-box (measureHeight) だと .coast-row/.observation-row の padding 4px ぶん
  // rowHeightPx を過小評価し、rowCapacity が実際より多く行を詰め込めると誤判定する)。
  //
  // areaHeightPx (容量算出に使う「利用可能高さ」) は T6 (M3 の最終解決) → T6b (2 カラム grid +
  // border-box 対応) で見直した:
  // 旧実装は各タイル自身の実測 clientHeight をそのまま使っていたが、静的表示中のタイルは
  // constrained (flex:1) ではなく content-driven の自然高さで測定されるため、全件が収まる
  // 高さを自分自身が返してしまい needsPaging へ昇格できない自己参照になっていた
  // (Codex レビュー M3 派生、狭い画面で静的表示のまま溢れる不具合)。
  // 代わりに .tiles (両タイルの共通ビューポート、常時 flex:1 constrained) の実測高さから
  // 「相手セクションが今すでに消費している実測高さ + gap」を差し引いた値を使う
  // (sectionAvailableHeight、instrument-layout.ts)。相手の実測高さは静的でもページング中でも
  // 同じ「実際に描画されている高さ」なので分岐が要らず、双方とも相手の $state を読むだけの
  // 相互参照 (非循環) になる。収束の根拠は sectionAvailableHeight のコメント参照。
  //
  // T6b M-a: ただし .tiles は `@container (min-width: 1200px)` で 2 カラム grid に切り替わり
  // (下記 CSS)、その状態では予報区/観測は縦方向に高さを奪い合わない。container query の
  // 判定結果は JS から直接読めないため、両 tile の実測 top/bottom から幾何的に縦積みかどうかを
  // isStackedLayout で逆算し、横並びのときは「相手は競合しない」として sectionAvailableHeight に
  // false を渡す (= 各セクションが tilesHeight をそのまま使える)。
  //
  // T6c (再レビュー M-a 残 major): 両 tile の rect (top/bottom/height) は
  // remeasureTiles() で「常にペアで」読み直す (下記)。片方の tile だけの ResizeObserver
  // コールバックで自分の rect だけ書き込む旧構造 (measureBox) だと、サイズは変わらず位置だけ
  // 動いた相手 tile の rect が古いまま取り残される問題があった (静的→ページング昇格で片方の
  // 高さが変わっても、もう片方は自分のサイズが変わらなければ ResizeObserver が発火しない)。
  let tilesHeight = $state(0);
  let coastsBox = $state<MeasuredBox>({ height: 0, top: 0, bottom: 0 });
  let obsBox = $state<MeasuredBox>({ height: 0, top: 0, bottom: 0 });
  let coastRowHeight = $state(0);
  let obsRowHeight = $state(0);
  // ヘッダ実測補正 (T-a11y-gate fix、preview 実機確認 2026-07-18: 予報区・観測とも末尾行が
  // 切れる)。.page-frame (予報区/観測ページ見出し・PageDots) と .obs-summary-frame (観測サマリ
  // 見出し) は行リストと同じ .tile 内に同居する非リスト領域だが、これまで capacity 計算に
  // 反映されていなかった (下記 coastHeaderOverheadPx/obsHeaderOverheadPx 参照)。.page-frame は
  // ページング枝でしか mount されないため (.coast-row/.observation-row と違い静的枝には存在しない)、
  // 実測値は $state に保持し続け未 mount 中も最後の実測値を使い回す (0 のときだけ「まだ一度も
  // 実測していない」= 加算しない fallback、初回ページング遷移の一瞬だけ粗い見積りになるが
  // coastRowHeight 等の既存 fallback 機構と同じ性質)
  let coastFrameHeight = $state(0);
  let obsSummaryHeight = $state(0);
  let obsFrameHeight = $state(0);
  // isStackedLayout の初期値 (未実測 0,0,0 同士) は true (縦積み扱い) になり、既存の
  // 「未実測時は保守的に fallback へ」という方針と一致する (モバイル/狭い画面優先の既定)
  const stacked = $derived(isStackedLayout(coastsBox.bottom, obsBox.top));
  const coastsAvailableHeight = $derived(
    sectionAvailableHeight(tilesHeight, obsBox.height, TILES_GAP_PX, visibleObservations.length > 0 && stacked),
  );
  const obsAvailableHeight = $derived(sectionAvailableHeight(tilesHeight, coastsBox.height, TILES_GAP_PX, stacked));
  // 予報区ページの本文 (.page-fade) には、可視バグ修正 (T6c ②、preview 目視指摘「文字が
  // カード縁にくっついている」) で `.tile` と同じ内側 padding を復元した。この padding は
  // coastsBox (.tile-coasts の outer border-box) の実測には既に含まれていた (タイル自体の
  // 総footprint は元々変わっていない) ので coastsAvailableHeight/obsAvailableHeight の
  // クロスセクション計算は無修正で正しいが、.page-fade 内部の実際に使える行表示領域は
  // その分だけ狭くなる。coastRowCapacity は「outer tile 高さ」を行数に近似変換する粗い近似
  // (T6 由来) を使っているため、この padding ぶんは PAGE_FADE_PADDING_PX で明示的に差し引く。
  //
  // ヘッダ実測補正 (T-a11y-gate fix、preview 実機確認 2026-07-18: 予報区・観測タイルとも
  // 末尾行が切れる): 上記の近似は page-frame (見出し・種別ラベル・PageDots) や
  // obs-summary-frame (観測サマリ見出し) といった非リスト領域を「元々未補正」のまま容量計算に
  // 含めており、特に PageDots が多ページで折返すと page-frame の実高さが伸びる (PageDots.svelte
  // 参照) ため固定定数では追従できない。coastFrameHeight/obsSummaryHeight/obsFrameHeight
  // (実測 $state、下記テンプレートの measureBorderHeight 配線) を capacity 計算から追加で
  // 差し引く。border-box 実測は margin を含まないため、CSS の margin-bottom と揃えた定数
  // (PAGE_FRAME_MARGIN_PX/OBS_SUMMARY_FRAME_MARGIN_PX) を加算する。観測タイルの .tile 自身の
  // padding (TILE_PADDING_PX) は予報区と違って absolute 重ねの quirk が無く通常フローで直接
  // 効くため、予報区の PAGE_FADE_PADDING_PX とは別に観測側だけへ加える
  const coastHeaderOverheadPx = $derived(
    PAGE_FADE_PADDING_PX + (coastFrameHeight > 0 ? coastFrameHeight + PAGE_FRAME_MARGIN_PX : 0),
  );
  const obsHeaderOverheadPx = $derived(
    TILE_PADDING_PX +
      (obsSummaryHeight > 0 ? obsSummaryHeight + OBS_SUMMARY_FRAME_MARGIN_PX : 0) +
      (obsFrameHeight > 0 ? obsFrameHeight + PAGE_FRAME_MARGIN_PX : 0),
  );
  const coastRowCapacity = $derived(
    rowCapacity(Math.max(0, coastsAvailableHeight - coastHeaderOverheadPx), coastRowHeight, TSUNAMI_PAGE_ROW_CAPACITY),
  );
  const obsRowCapacity = $derived(
    rowCapacity(Math.max(0, obsAvailableHeight - obsHeaderOverheadPx), obsRowHeight, TSUNAMI_PAGE_ROW_CAPACITY),
  );

  // remeasureTiles: 両 tile の rect をまとめて読み直す (T6c M-a rect 鮮度対応)。
  // ① 各 tile 自身の resize (observeResize、下記テンプレート) と
  // ② 表示モード切替 (needsPaging/obsNeedsPaging の変化、下の $effect) の両方から呼ばれる。
  // coastsBox/obsBox への書き込みだけで、両者を読むことは無い (非循環維持: この関数と
  // それを呼ぶ $effect は state を書くだけで、coastsAvailableHeight 等の $derived 側を
  // 読み返さない)
  let coastsTileEl: HTMLElement | undefined = $state();
  let obsTileEl: HTMLElement | undefined = $state();
  // レイアウト遷移中 (layoutSettling) はタイル/行の実測を保留する (最新 1 件だけ保持、完了時に一度だけ
  // 反映)。tilesHeight/coastRowHeight/obsRowHeight は最新値を pending に、tile rect の読み直しは
  // dirty フラグに畳んで、settling 完了時に flush する (spec §4)。reduced-motion では layoutSettling が
  // 常に false になり同期反映になる (EmergencyScreen が settling を立てない)。
  let pendingTilesHeight: number | null = null;
  let pendingCoastRow: number | null = null;
  let pendingObsRow: number | null = null;
  let pendingCoastFrame: number | null = null;
  let pendingObsSummary: number | null = null;
  let pendingObsFrame: number | null = null;
  let pendingRemeasure = false;
  function applyTilesHeight(h: number): void {
    if (layoutSettling) pendingTilesHeight = h;
    else tilesHeight = h;
  }
  function applyCoastRowHeight(h: number): void {
    if (layoutSettling) pendingCoastRow = h;
    else coastRowHeight = h;
  }
  function applyObsRowHeight(h: number): void {
    if (layoutSettling) pendingObsRow = h;
    else obsRowHeight = h;
  }
  function applyCoastFrameHeight(h: number): void {
    if (layoutSettling) pendingCoastFrame = h;
    else coastFrameHeight = h;
  }
  function applyObsSummaryHeight(h: number): void {
    if (layoutSettling) pendingObsSummary = h;
    else obsSummaryHeight = h;
  }
  function applyObsFrameHeight(h: number): void {
    if (layoutSettling) pendingObsFrame = h;
    else obsFrameHeight = h;
  }
  function remeasureTiles(): void {
    if (layoutSettling) {
      pendingRemeasure = true;
      return;
    }
    if (coastsTileEl != null) coastsBox = readBox(coastsTileEl);
    if (obsTileEl != null) obsBox = readBox(obsTileEl);
  }
  $effect(() => {
    if (layoutSettling) return;
    if (pendingTilesHeight != null) {
      tilesHeight = pendingTilesHeight;
      pendingTilesHeight = null;
    }
    if (pendingCoastRow != null) {
      coastRowHeight = pendingCoastRow;
      pendingCoastRow = null;
    }
    if (pendingObsRow != null) {
      obsRowHeight = pendingObsRow;
      pendingObsRow = null;
    }
    if (pendingCoastFrame != null) {
      coastFrameHeight = pendingCoastFrame;
      pendingCoastFrame = null;
    }
    if (pendingObsSummary != null) {
      obsSummaryHeight = pendingObsSummary;
      pendingObsSummary = null;
    }
    if (pendingObsFrame != null) {
      obsFrameHeight = pendingObsFrame;
      pendingObsFrame = null;
    }
    if (pendingRemeasure) {
      pendingRemeasure = false;
      remeasureTiles();
    }
  });

  const needsPaging = $derived(input.coasts.length > coastRowCapacity);

  // 旧「pageInKind/totalInKind」(種別内番号) の文字表示は T8① でドットインジケータ (PageDots)
  // に撤去済み。ドット列のグループ境界 gap 機能 (種別境界に gap を入れる任意機能) は
  // preview 目視レビューで「間隔が不揃いに見える」と不評だったため T8⑤ で撤去し、TsunamiPage の
  // pageInKind/totalInKind フィールド (境界計算専用だった) も不要になったので削除した
  const tsunamiPages = $derived.by((): TsunamiPage[] => {
    if (!needsPaging) return [];
    const pages: TsunamiPage[] = [];
    for (const g of coastGroups) {
      const chunkCount = Math.ceil(g.coasts.length / coastRowCapacity);
      for (let i = 0; i < chunkCount; i++) {
        pages.push({
          kind: g.kind,
          coasts: g.coasts.slice(i * coastRowCapacity, (i + 1) * coastRowCapacity),
        });
      }
    }
    return pages;
  });

  // resetSeq: level が「上がった」ときだけ単調増加させ、ページャの先頭ページへ巻き戻す
  // (spec §3「level 低下では変えない」)。DisplayTsunamiInputV1 に eventId が無いため
  // (protocol §7 自地域フェーズ以降の課題)、この画面で判断できる唯一の昇格シグナルである
  // level ランクの上昇を代理指標として使う
  const LEVEL_RANK: Record<DisplayTsunamiInputV1["level"], number> = { advisory: 0, warning: 1, majorWarning: 2 };
  let resetSeq = $state(0);
  let prevLevelRank = -1;
  $effect(() => {
    const rank = LEVEL_RANK[input.level];
    if (rank > prevLevelRank) resetSeq += 1;
    prevLevelRank = rank;
  });

  const pageCycler = createPageCycler({
    pageCount: () => tsunamiPages.length,
    resetKey: () => resetSeq,
  });
  // unmount (main-stack のモード切替・panel 差替え) で $effect.root のタイマー/matchMedia
  // リスナーがリークしないよう、コンポーネント破棄時に必ず destroy() する (Codex R レビュー M1)
  onDestroy(() => pageCycler.destroy());
  // pageCycler.index の巻き戻し ($effect) はデータ更新と非同期に走るため、テンプレート側の
  // 参照が一瞬 index >= tsunamiPages.length の状態を読む理論上の窓がある。範囲外アクセスで
  // undefined を掴んで落ちないよう `?? tsunamiPages[0]` で防御する (レビュー指摘)

  // 表示中のページ (paging=false のときは null)。予報区 tile 自体を静的/ページングどちらの
  // 枝でも常時マウントされる単一要素にする (下記テンプレート) ための派生値。旧実装は
  // measureHeight が {#if needsPaging} の内側にしか mount されず、(a) 初期 fallback (8行)
  // 以下の件数だと静的枝から一度も抜けられずページングへ昇格できない鶏卵と、(b) 画面縮小後も
  // 静的枝では observer が存在せず容量が更新されない stale の 2 つの不具合を持っていた
  // (Codex R レビュー M3 派生)
  const currentTsunamiPage = $derived(tsunamiPages[pageCycler.index] ?? tsunamiPages[0] ?? null);

  // observationVisible/visibleObservations は上の行容量算出 (coastsAvailableHeight が
  // 観測 tile の有無を見る) でも参照するため、スクリプト冒頭で定義済み

  // 観測実況の 3 層化 (spec §2-c レビュー決定 2026-07-09): 固定計器行「最大観測」+ 全件は
  // 収まれば静的・収まらなければ予報区と同じページャ文法 (行容量は予報区と同じ lib 定数を共有。
  // 両リストとも 1 行 = padding 4px 0 のグリッド行で構造が同型なため、容量を分ける理由が無い)
  const maxObservation = $derived(maxTsunamiObservation(visibleObservations));
  const obsNeedsPaging = $derived(visibleObservations.length > obsRowCapacity);
  const obsPages = $derived.by((): KeyedRow<DisplayTsunamiObservationV1>[][] => {
    if (!obsNeedsPaging) return [];
    const pages: KeyedRow<DisplayTsunamiObservationV1>[][] = [];
    for (let i = 0; i < visibleObsRows.length; i += obsRowCapacity) {
      pages.push(visibleObsRows.slice(i, i + obsRowCapacity));
    }
    return pages;
  });

  // resetSeq (level 上昇) は予報区ページャと共有する。観測実況も同じ「最重要ページから見せ直す」
  // 対象のため、別イベント扱いの基準を分ける理由が無い
  const obsPageCycler = createPageCycler({
    pageCount: () => obsPages.length,
    resetKey: () => resetSeq,
  });
  onDestroy(() => obsPageCycler.destroy());

  // reduced-motion は page-cycler の matchMedia 購読を共有する (2 本目の subscription を作らない)。
  // 後発行の FLIP・reveal は切替後開始分が 0ms になる (spec §4-b)。
  const reducedMotion = $derived(pageCycler.reducedMotion);
  const flipDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);

  // 表示中の観測ページ (obsNeedsPaging=false のときは null)。予報区と同じ理由で、観測リスト
  // ホストも静的/ページングどちらの枝でも常時マウントされる単一要素にする (Codex R レビュー M3 派生)
  const currentObsPage = $derived(obsPages[obsPageCycler.index] ?? obsPages[0] ?? null);

  // T6c (M-a rect 鮮度対応、再レビュー残 major): 表示モード切替 (needsPaging/obsNeedsPaging
  // の変化) は片方の tile の高さを変えるが、もう片方は自分のサイズが変わらなければ
  // ResizeObserver (observeResize、下記テンプレート) が発火せず top/bottom が stale なままになる
  // (縦積みで coasts が static→paged に変わると obs の top が動くが obs 自身の高さは不変、
  // という具体例)。needsPaging/obsNeedsPaging の変化を $effect で追い、Svelte が DOM を更新した
  // 後に remeasureTiles() で両方の rect を読み直す。この $effect は coastsBox/obsBox に
  // 書き込むだけで読み返さないため、非循環は維持される (needsPaging/obsNeedsPaging という
  // primitive の値が実際に変わらない限り Svelte はこの $effect を再スケジュールしない = 実 DOM
  // レイアウトが安定すれば有限回で収束し、無限ループにはならない)
  $effect(() => {
    void needsPaging;
    void obsNeedsPaging;
    remeasureTiles();
  });
</script>

<!-- 行の「中身」だけを snippet 化する (spec §2-c Medium 3): animate:flip は keyed each の直接
     child である <li> に置く必要があり snippet 越しの <li> には置けない (animation_invalid_placement)。
     <li> を各 each 内へインライン展開し高さ wrapper 化 (overflow:hidden・padding は body 側)、
     内側 body (.coast-row/.observation-row) をこの snippet が返す。body は transform+opacity の
     revealScaleIn、<li> は高さの heightReveal と位置の flip を担う (軸が異なるため共存可)。 -->
{#snippet coastRowBody(c: Coast, i: number, tintHeight: boolean, reveal: boolean)}
  <div
    class="coast-row"
    data-motion-reveal="scale"
    use:measureBorderHeight={i === 0 ? applyCoastRowHeight : undefined}
    in:revealScaleIn={{ reveal, duration: SPRING_SPATIAL_DEFAULT_MS }}
  >
    <span class="coast-name">{c.name}</span>
    <span class="coast-height" style={tintHeight ? `color: ${panelRoleVar}` : undefined}>{c.maxHeight ?? "-"}</span>
    <!-- T7 レビュー決定 (spec §2-c【確定 2026-07-10】): 括弧補足を削り時刻をコロン形式にした
         表示専用整形 (formatArrivalDisplay、tsunami-bucket.ts)。分類 (bucketTsunamiArrival) は
         この整形前の c.firstHeight そのままで行っている (別ロジック、上のスクリプト参照) -->
    <span class="coast-first">{formatArrivalDisplay(c.firstHeight) ?? "-"}</span>
  </div>
{/snippet}

{#snippet observationRowBody(o: DisplayTsunamiObservationV1, i: number, reveal: boolean)}
  <div
    class="observation-row"
    data-motion-reveal="scale"
    use:measureBorderHeight={i === 0 ? applyObsRowHeight : undefined}
    in:revealScaleIn={{ reveal, duration: SPRING_SPATIAL_DEFAULT_MS }}
  >
    <span class="obs-name">{o.stationName}</span>
    <span class="obs-time">{formatHm(o.arrivalTime)}</span>
    <span class="obs-initial">{o.initial ?? ""}</span>
    <span class="obs-max-value">{o.maxHeightValue ?? "-"}</span>
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
        <span class="headline-value" style="color: {panelRoleVar}">{maxHeightHeadline.label}</span>
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
  <!-- .tiles: 両タイル共通のビューポート。常時 flex:1;min-height:0 で constrained なため、
       実測高さは静的/ページングどちらの表示モードでも「実際に使える全高」を表す (T6)。
       各タイルの利用可能高さ (coastsAvailableHeight/obsAvailableHeight) はここから
       相手タイルの実測高さを差し引いて導出する (sectionAvailableHeight、instrument-layout.ts) -->
  <div class="tiles" use:measureHeight={applyTilesHeight}>
    <!-- 予報区 tile: 静的/ページングどちらの枝でも同一要素を維持し (中身だけ {#if} で切替)、
         measureHeight を常時マウントする (Codex R レビュー M3 派生。旧実装は {#if needsPaging}
         の外側に別々の div を置いていたため、静的表示中は observer が存在せず measure できなかった) -->
    <div
      class="tile tile-coasts"
      class:page-tinted={currentTsunamiPage != null}
      style={currentTsunamiPage != null ? `--page-bg: ${coastKindPageBg(currentTsunamiPage.kind)};` : undefined}
      bind:this={coastsTileEl}
      use:observeResize={remeasureTiles}
    >
      {#if currentTsunamiPage != null}
        {#key pageCycler.index}
          <div
            class="page-fade"
            transition:fade={{
              duration: pageCycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
              easing: springEffectsOut,
            }}
          >
            <div class="page-frame" use:measureBorderHeight={applyCoastFrameHeight}>
              <h2 class="page-heading">予報区</h2>
              <span class="page-kind" style="color: {coastKindHeaderOnVar(currentTsunamiPage.kind)}"
                >{currentTsunamiPage.kind}</span
              >
              <PageDots total={pageCycler.total} current={pageCycler.index} onJump={(i) => pageCycler.jumpTo(i)} />
            </div>
            <ul class="coasts">
              <!-- ページング枝は page-fade の {#key} 重ねクロスフェードが入替演出を担う。行個別の
                   reveal を付けるとページ送りのたびに再発火して二重演出になる (レビュー指摘 Medium 1、
                   spec「ページング領域は触らない」)。よって reveal:false 固定。後発行の reveal は
                   静的枝だけが担当する。flip は位置補正なので残す。 -->
              {#each currentTsunamiPage.coasts as r, i (r.key)}
                <li
                  class="coast-row-wrap"
                  data-motion-reveal="height"
                  animate:flip={{ duration: flipDur, easing: springSpatialOut }}
                  in:heightReveal={{ reveal: false, duration: SPRING_EFFECTS_DEFAULT_MS }}
                >
                  {@render coastRowBody(r.row, i, false, false)}
                </li>
              {/each}
            </ul>
          </div>
        {/key}
      {:else}
        <!-- A11y (最終レビュー Finding 1): 静的枝には h2「予報区」が無く、h3.coast-kind が
             App の h1 (App.svelte 単一 visually-hidden h1) から直接 h3 になっていた (h1→h3 スキップ)。
             ページング枝は h2.page-heading「予報区」を持つが、その配下の種別ラベルは見出しではない
             単なる span (.page-kind、1 ページ 1 種別のため見出しにする必要が無い)。一方この静的枝は
             複数種別を同時併記するグルーピング構造そのものが「予報区」節の内訳なので、
             coast-kind を新規 h2 でラップし直すのではなく、coast-kind 自身を h2 に昇格させる方が
             構造に合う (この画面の中で「予報区」に相当する唯一の見出しになる)。.coast-kind の
             CSS はクラスセレクタのみ (h3.coast-kind 等の要素型セレクタは存在しない) で見た目は
             不変。ページング枝には対応する coast-kind 相当の見出しが無いため h3 のままにする
             対象自体が無く、両枝の要素型差分は発生しない -->
        {#each coastGroups as g (g.kind)}
          <div class="coast-group">
            <h2 class="coast-kind" style="color: {coastKindRoleVar(g.kind)}">{g.kind}</h2>
            <ul class="coasts">
              {#each g.coasts as r, i (r.key)}
                <li
                  class="coast-row-wrap"
                  data-motion-reveal="height"
                  animate:flip={{ duration: flipDur, easing: springSpatialOut }}
                  in:heightReveal={{
                    reveal: !initialCoastKeys.has(r.key) && !reducedMotion,
                    duration: SPRING_EFFECTS_DEFAULT_MS,
                  }}
                >
                  {@render coastRowBody(r.row, i, true, !initialCoastKeys.has(r.key) && !reducedMotion)}
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </div>
    {#if visibleObservations.length > 0}
      <!-- 観測 tile: 予報区タイルと同じ理由で静的/ページングどちらの枝でも同一要素を維持する
           (Codex R レビュー M3 派生)。この outer tile の実測値は「相手 (予報区) タイルが利用可能
           高さを出すときに差し引く、観測タイルの実測消費高さ + 幾何判定用の top/bottom」として
           使う (obsBox、旧実装は内側の obs-list-host だけを測っていたが、summary-frame ぶんの
           overhead も含めて outer tile を測るほうが coasts 側の available-height 計算の整合性が
           高い)。rect の読み直しは remeasureTiles (observeResize + $effect、T6c) に統合した -->
      <div
        class="tile tile-observations"
        class:paged={obsNeedsPaging}
        bind:this={obsTileEl}
        use:observeResize={remeasureTiles}
      >
        <div class="obs-summary-frame" use:measureBorderHeight={applyObsSummaryHeight}>
          <h2 class="observations-heading">観測された津波</h2>
          <!-- T6c ③ (preview 目視指摘「8.5m以上」等の値が途中で改行される): maxObservation.label
               だけを個別 span (white-space:nowrap、.city-name と同じ「値の途中で折らない」規範) に
               切り出す。1 行のテキストに戻して見せかけの単純さを保つため改行・インデント無しの
               単一行で書く (obsSummaryLine という 1 本の文字列 $derived だった旧実装をやめて
               テンプレート側で組み立てる形に変えたが、textContent は完全に一致する) -->
          <span class="obs-summary-line">{#if maxObservation != null}最大観測: <span class="obs-summary-value">{maxObservation.label}</span> {maxObservation.stationName} / 観測 {visibleObservations.length}地点{:else}観測 {visibleObservations.length}地点{/if}</span>
        </div>
        <div class="obs-list-host" class:paged={currentObsPage != null}>
          {#if currentObsPage != null}
            {#key obsPageCycler.index}
              <div
                class="page-fade"
                transition:fade={{
                  duration: obsPageCycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
                  easing: springEffectsOut,
                }}
              >
                <div class="page-frame" use:measureBorderHeight={applyObsFrameHeight}>
                  <h2 class="page-heading">観測</h2>
                  <PageDots
                    total={obsPageCycler.total}
                    current={obsPageCycler.index}
                    onJump={(i) => obsPageCycler.jumpTo(i)}
                  />
                </div>
                <!-- ページング枝は page-fade のクロスフェードが入替を担うため行 reveal は無効化
                     (レビュー指摘 Medium 1)。flip のみ残す。後発行の reveal は静的枝が担当する。 -->
                <ul>
                  {#each currentObsPage as r, i (r.key)}
                    <li
                      class="observation-row-wrap"
                      data-motion-reveal="height"
                      animate:flip={{ duration: flipDur, easing: springSpatialOut }}
                      in:heightReveal={{ reveal: false, duration: SPRING_EFFECTS_DEFAULT_MS }}
                    >
                      {@render observationRowBody(r.row, i, false)}
                    </li>
                  {/each}
                </ul>
              </div>
            {/key}
          {:else}
            <ul>
              {#each visibleObsRows as r, i (r.key)}
                <li
                  class="observation-row-wrap"
                  data-motion-reveal="height"
                  animate:flip={{ duration: flipDur, easing: springSpatialOut }}
                  in:heightReveal={{
                    reveal: !initialObsKeys.has(r.key) && !reducedMotion,
                    duration: SPRING_EFFECTS_DEFAULT_MS,
                  }}
                >
                  {@render observationRowBody(r.row, i, !initialObsKeys.has(r.key) && !reducedMotion)}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    {/if}
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
  .headline-count {
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
  }
  .tiles {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  .tiles::-webkit-scrollbar {
    display: none;
  }
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
    padding: var(--space-4) var(--space-5);
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
     (coastRowCapacity の PAGE_FADE_PADDING_PX 補正、上のスクリプト参照)。観測側の .page-fade
     (.obs-list-host.paged 内) は position:relative の祖先 (.obs-list-host) が padding を
     持たない別要素なので、この落とし穴の対象外 — padding は追加しない */
  .tile-coasts.page-tinted .page-fade {
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
  /* ページング時 (.page-tinted .page-fade 内) の予報区リストは .page-fade の flex 子として
     残り高さを受け取り、ページ本文領域の固定高さを保つ (spec §2-c「下位ブロックが上下移動
     しないよう固定」)。静的グルーピング表示 (.coast-group 内) の .coasts はこの対象外
     (自然な block 高さのまま) */
  .page-tinted .page-fade .coasts {
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
  .tsunami-panel.compact .coast-row {
    font-size: var(--type-label-l-size);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .observation-row {
    font-size: var(--type-label-m-size);
    gap: var(--space-2);
  }
  .tsunami-panel.compact .obs-summary-line {
    font-size: var(--type-label-m-size);
  }

  /* bento: 十分な幅があれば区域リストと観測実況を左右 2 カラムに (観測が無ければ全幅)
     閾値 1200px: 860px だと左右分割/スタック内 (パネル幅 ~950px) で観測実況タイルに
     行が入らず右端が見切れるため、全面幅 (~1870px) でのみ発動するよう引き上げた */
  @container (min-width: 1200px) {
    .tiles {
      display: grid;
      grid-template-columns: 3fr 2fr;
      align-items: start;
    }
    .tile-coasts:only-child {
      grid-column: 1 / -1;
    }
    /* grid の align-items:start は既定で子を content-driven の高さに揃える (stretch しない)。
       ページング中の flex:1;min-height:0 が実測高さを受け取るには、この 2 タイルだけ
       stretch へ戻す必要がある (T5c) */
    .tile-coasts.page-tinted,
    .tile-observations.paged {
      align-self: stretch;
    }
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
