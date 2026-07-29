// 「固定サマリ計器 + ページング」転換 (spec: 設計メモ 2026-07-09-summary-instrument-paging.md §4)
// の閾値純関数群。震度別グループの件数から「静的リスト ⇔ 県別件数縮退 ⇔ 詳細ページング」の
// 3 段切替を決める。latest-quake-card-layout.ts の TOP_GROUP_COMPACT_AREA_THRESHOLD と
// 意味論を揃え (30 件)、判定の実効件数 (effectiveAreaCount) をここで一元化する。
import { countByPrefecture, groupByPrefecture, type PrefGroup } from "./prefecture-group";
import type { DisplayIntensityGroupV1 } from "./protocol";

// 静的小リストで全件表示できる合計件数の上限。超えたら詳細ページングへ降ろす
// (既存 TOP_GROUP_COMPACT_AREA_THRESHOLD と同じ 30 に揃える。spec §4)
export const STATIC_LIST_MAX = 30;

// EEW の静的小リスト上限。eew-region-tiers.ts の非 compact 22px 境界 (count <= 10) と整合させる。
// EEW には詳細ページングを設けない (spec §2-a 確定) ため、超過時は計器の県数集約行のみで打ち切る
export const EEW_STATIC_LIST_MAX = 10;

// 詳細ページングで 1 ページに詰める市町村数バジェット (preview 目視調整前提の初期値)。
// 旧・県数固定 (3 県/ページ) は高知県 31 市町村のような大県 1 つで 1 ページに収まらず破綻した
// ため、市町村数ベースのバジェット制へ改訂 (spec §2-b 改訂 2026-07-09、review-T5a-2 FIX-A)
export const PAGE_CITY_BUDGET = 20;

// 津波予報区ページャ (TsunamiPanel、spec §2-c) の 1 ページ行数上限。preview 目視調整前提の
// 初期値 (T5b 申し送り推奨 8 行)。予報区は県のような階層構造を持たない単純な行リストなので
// PAGE_CITY_BUDGET (観測震度の市町村数バジェット) とは別軸の定数として持つ。
// T5c 以降は画面高さ駆動 (rowCapacity) の fallback 初期値 (未マウント・実測0のとき使用)
export const TSUNAMI_PAGE_ROW_CAPACITY = 8;

// 観測震度ページの「1行あたり平均市町村数」概算。県名 + 市町村名が1本の連続テキストとして
// 自然折返しする (display:contents FIX-B) ため、正確な行数はカード幅・地名の文字数で変動する。
// 実測に基づく概算値として据え置く (spec §2-c T5c、review 目視で要調整)。
// PAGE_CITY_BUDGET(=20) のフォールバック相当は ceil(20/4)=5 行 (LatestQuakeCard 既存コメントの
// 「1行あたり平均4トークン、6行確保」の見積もりと同系)
export const AVG_CITIES_PER_LINE = 4;

/** ページ本文領域の実測高さ (px) と実測行高 (px) から、収容可能な行数を導出する純関数。
 *  領域高さ・行高のいずれかが 0/負/NaN (未マウント・実測前) なら fallback を返す
 *  (T5c: 画面高さ駆動化。旧固定定数 TSUNAMI_PAGE_ROW_CAPACITY / PAGE_CITY_BUDGET はこの関数の
 *  fallback 初期値として生存する) */
export function rowCapacity(areaHeightPx: number, rowHeightPx: number, fallback: number): number {
  if (!(areaHeightPx > 0) || !(rowHeightPx > 0)) return fallback;
  const lines = Math.floor(areaHeightPx / rowHeightPx);
  return lines > 0 ? lines : fallback;
}

// TsunamiPanel の .tiles 内 gap (TILES_GAP_PX、T6)。CSS の `gap: var(--space-4)` (theme.css) と
// 値を合わせる必要がある定数。--panel-scale の calc() 倍率がかかっていない生値 (16px) なので
// そのまま px 定数化できる。ずれても sectionAvailableHeight の結果が数 px 前後するだけで、
// rowCapacity の fallback ガードが安全側に吸収する (致命的にはならない)
export const TILES_GAP_PX = 16;

// TsunamiPanel の予報区ページ本文 (.tile-coasts.page-tinted .page-fade) に復元した内側 padding
// (T6c ②、CSS の `padding: var(--space-4) var(--space-5)` と揃える) の縦方向合計。coastRowCapacity
// は「.tile-coasts の outer 実測高さ (coastsAvailableHeight)」を行数近似の入力に流用する粗い
// 近似のままなので (page-frame 見出し等ほかの内部オーバーヘッドは元から未補正)、この padding
// だけは新規に増えた既知の差分として明示的に差し引く。TILES_GAP_PX と同じく、CSS 側の値と
// ズレても rowCapacity の fallback ガードが安全側に吸収する
export const PAGE_FADE_PADDING_PX = 32;

// TsunamiPanel の予報区/観測ページ見出し行 (.page-frame) の margin-bottom (CSS の
// `margin-bottom: var(--space-3)` と揃える)。予報区・観測どちらのページも同じ .page-frame
// ルールを共有するためこの定数も共有する。実測 (measureBorderHeight) は border-box のみを
// 返し margin を含まないため、実測高さに加算してページ見出し行全体の消費高さにする
// (T-a11y-gate fix: ヘッダ実測補正、preview 実機確認 2026-07-18 の行切れ対応)
export const PAGE_FRAME_MARGIN_PX = 12;

// TsunamiPanel の観測サマリ見出し行 (.obs-summary-frame) の margin-bottom (CSS の
// `margin-bottom: var(--space-2)` と揃える)。予報区側の静的グルーピング (.coast-group) には
// 対応物が無い専用要素
export const OBS_SUMMARY_FRAME_MARGIN_PX = 8;

// .tile 共通ルール (`padding: var(--space-4) var(--space-5)`) の縦方向合計。観測タイル
// (.tile-observations) は予報区タイルと違って page-fade を absolute で重ねる quirk 対応が
// 無く (.obs-list-host は position:relative の通常フローの子)、tile 自身の padding が
// そのまま内側コンテンツ (obs-summary-frame + obs-list-host) の利用可能高さを削る。予報区側は
// page-fade 自身が同値の padding を明示的に持ち直しているため (PAGE_FADE_PADDING_PX 参照)、
// この定数は観測側専用として使う (予報区側と役割が違うため PAGE_FADE_PADDING_PX と統合しない)
export const TILE_PADDING_PX = 32;

/** 縦に並ぶ 2 セクション (TsunamiPanel の予報区 tile / 観測 tile) が共有するビューポート
 *  (.tiles) の実測高さから、片方のセクションが「実際に使える高さ」を導出する純関数 (T6、
 *  Codex レビュー M3 の最終解決)。相手セクションの実測高さ (静的表示なら自然な content 高さ、
 *  ページング中なら flex:1 で確定した実測高さ、どちらも同じ「相手が今すでに消費している高さ」
 *  として扱えるため分岐しない) と gap を tilesHeightPx から差し引くだけの対称な相互参照。
 *
 *  相手セクション自身もこの関数を使って自分の利用可能高さを出す (TsunamiPanel.svelte 参照) ため、
 *  循環参照ではなく相互参照になる: 双方とも「自分の可用高さ」の入力に使うのは相手の実測 $state
 *  (ResizeObserver が書き込む生の値) であり、相手の可用高さ ($derived) を読まない。したがって
 *  Svelte の $derived 依存グラフは非循環 (両者とも葉の $state から計算するだけ) で、片方が
 *  ページングへ昇格して実測高さが変わっても、それが相手の可用高さの再計算 → 相手の昇格判定
 *  → (昇格すれば) 相手の実測高さ変化 → 自分の可用高さの再計算、という有限回のフレームで
 *  収束する (双方の実測高さは JS の計算結果ではなく CSS flex が確定させる実測値なので、
 *  一度どちらの表示モードも安定すれば実測値も安定し、無限振動しない)。
 *
 *  otherSectionCompetesForHeight=false のときは gap も含めず tilesHeightPx をそのまま返す。
 *  false になるケースは 2 つ (T6b): ① 相手セクションが未マウント (例: observations が 0 件で
 *  tile 自体が存在しない)。② 相手セクションは存在するが、幅方向に並ぶレイアウト (TsunamiPanel の
 *  `@container (min-width: 1200px)` 2 カラム grid) で縦方向には競合しない
 *  (isStackedLayout で判定、呼び出し側が渡す) */
export function sectionAvailableHeight(
  tilesHeightPx: number,
  otherSectionHeightPx: number,
  gapPx: number,
  otherSectionCompetesForHeight: boolean = true,
): number {
  if (!(tilesHeightPx > 0)) return 0;
  if (!otherSectionCompetesForHeight) return Math.max(0, tilesHeightPx);
  return Math.max(0, tilesHeightPx - otherSectionHeightPx - gapPx);
}

/** 2 つの矩形が縦積み (stacked) か横並び (side-by-side) かを、実測の border-box 上端/下端から
 *  幾何的に判定する純関数 (T6b、M-a 対応)。TsunamiPanel の `.tiles` は `@container
 *  (min-width: 1200px)` で 1 カラム縦積み ⇔ 2 カラム grid に切り替わるが、container query が
 *  今どちらの状態かを JS から直接読む標準 API が無い (container query の評価結果を JS に
 *  伝える手段は現状 CSS Container Query の JS 側ミラーが無い) ため、実測幾何から逆算する。
 *
 *  firstBottomPx (先行要素の下端) と secondTopPx (後続要素の上端) を比較し、後続要素が
 *  先行要素の下端以降から始まっていれば縦積みと判定する。横並び (grid) では両要素が同じ行に
 *  並ぶため secondTopPx は firstBottomPx よりずっと小さくなり false を返す。
 *  epsilonPx は sub-pixel の丸め誤差を吸収するための許容量 (既定 1px、gap があれば縦積み側は
 *  常に "secondTopPx >= firstBottomPx" を満たすためこの許容量が誤判定の原因になることは無い) */
export function isStackedLayout(firstBottomPx: number, secondTopPx: number, epsilonPx: number = 1): boolean {
  return secondTopPx >= firstBottomPx - epsilonPx;
}

/** ページ本文領域の実測高さ・行高から、詳細ページング (観測震度) の市町村数バジェットを導出する。
 *  rowCapacity で行数を出し、AVG_CITIES_PER_LINE を掛けて概算バジェットに換算する
 *  (spec §2-c T5c「領域高さ → 収容可能行数 → バジェット換算」)。fallback は PAGE_CITY_BUDGET を
 *  そのまま行数換算した値を rowCapacity の fallback に渡すことで、未実測時は従来どおり
 *  PAGE_CITY_BUDGET と一致する (jsdom 等 clientHeight=0 環境での既存テスト回帰対策) */
export function cityBudgetFromArea(areaHeightPx: number, rowHeightPx: number, fallback: number): number {
  const fallbackLines = Math.max(1, Math.ceil(fallback / AVG_CITIES_PER_LINE));
  const lines = rowCapacity(areaHeightPx, rowHeightPx, fallbackLines);
  return Math.max(1, lines * AVG_CITIES_PER_LINE);
}

/** 震度別グループの判定用実効件数。表示は areas だけでも、判定は縮退で切られた
 *  omittedAreaCount を足した件数で行う (fixtures に omittedAreaCount が大きいグループが実在) */
export function effectiveAreaCount(group: DisplayIntensityGroupV1): number {
  return group.areas.length + (group.omittedAreaCount ?? 0);
}

/** 全グループ合計の実効件数が静的リストに収まらず、詳細ページングへ降ろすべきか */
export function shouldPageDetails(totalEffective: number): boolean {
  return totalEffective > STATIC_LIST_MAX;
}

// 固定サマリ計器 (最大震度規模行 / 拡大範囲行) の共有ロジック。QuakePanel と LatestQuakeCard の
// 両方が同じ計器行を出すため、ここへ一元化する (spec §2-b 改訂 2026-07-09、review-T5a-3)。
// 旧・震度分布行 (distributionValue) と県別件数行 (topPrefCountsSorted) は「広域」連呼が
// 情報ゼロ・裸の数字が単位不明だったため廃止し、ヘッドライン2行 (最大震度規模 + 拡大範囲) に
// 統合した。県別の内訳は詳細ページ (paginateAreas) が証跡として担う

/** 地域配列中の distinct な都道府県数 (「その他」を除く) */
export function prefectureCountOf(areas: string[]): number {
  return countByPrefecture(areas).filter((c) => c.pref != null).length;
}

/** ヘッドライン2行の集約値。EEW の cumulativePrefCount (EewPanel.svelte) と同じ累積意味論:
 *  拡大範囲行は「2番目のランク以上」= 最大震度グループを含む先頭2グループの distinct 県数 */
export interface QuakeHeadline {
  topIntensity: string;
  topRank: number;
  topPrefectureCount: number;
  topCityCount: number;
  /** 拡大範囲行。グループが1つだけ (2番目が無い) なら null (非表示) */
  expanded: { intensity: string; prefectureCount: number } | null;
}

/** intensityGroups は rank 降順ソート済み (先頭=最大震度) が protocol 前提。空なら null。
 *  T7 preview 実測で見つかった回帰の修正: areas が県プレフィックス無しの市名だけ (「宮崎市」
 *  「日南市」等、spec §2-b の静的リスト例そのもの) だと prefectureCountOf が 0 を返す。
 *  拡大範囲行は「2番目のランク以上」に**新たに広がった県が無い**ことを意味するため、
 *  1 グループのみのとき (second == null) と同じ「拡大なし」= 非表示に統一する
 *  (grouped areas がゼロ件でも topPrefectureCount=0 自体は QuakeHeadline.svelte 側で
 *  「N県」部分を省いて表示するため、こちらは null 化せず 0 のまま返す) */
export function quakeHeadline(groups: DisplayIntensityGroupV1[]): QuakeHeadline | null {
  const top = groups[0];
  if (top == null) return null;
  const second = groups[1] ?? null;
  const expandedPrefectureCount =
    second != null ? prefectureCountOf([...top.areas, ...second.areas]) : 0;
  return {
    topIntensity: top.intensity,
    topRank: top.rank,
    topPrefectureCount: prefectureCountOf(top.areas),
    topCityCount: effectiveAreaCount(top),
    expanded:
      second != null && expandedPrefectureCount > 0
        ? { intensity: second.intensity, prefectureCount: expandedPrefectureCount }
        : null,
  };
}

/** ページ本文に置く都道府県ブロック。1 県が PAGE_CITY_BUDGET を超えてページをまたぐときは
 *  分割後の各ブロックに continuation を立て、2 ブロック目以降を「県名（続き）」で表示する */
export interface DetailPrefGroup extends PrefGroup {
  continuation: boolean;
}

/** 詳細ページング 1 ページ分。ページ番号 (N/M) は呼び出し側で配列の index/length から導出する
 *  (page-cycler の pageCount() getter と二重管理しないため、ここでは埋め込まない) */
export interface DetailPageSection {
  intensity: string;
  rank: number;
  /** このページが属する震度グループの県数 (pref != null の distinct 数、グループ全体) */
  prefectureCount: number;
  /** このページが属する震度グループの市町村数 (effectiveAreaCount、グループ全体) */
  cityCount: number;
  /** このページに割り当てられた都道府県ブロック (合計 PAGE_CITY_BUDGET 件以内、県分断時は例外) */
  prefGroups: DetailPrefGroup[];
}

/** 詳細ページ。sections はページ内の震度別セクションで、既定では常に 1 件である。 */
export interface DetailPage {
  sections: DetailPageSection[];
  /** 旧呼び出し元互換。新規実装は sections を読む。 */
  intensity: string;
  rank: number;
  prefectureCount: number;
  cityCount: number;
  prefGroups: DetailPrefGroup[];
}

export interface PaginateAreasOptions {
  allowCrossIntensity?: boolean;
  widowOrphanMinFillRatio?: number;
}

export const WIDOW_ORPHAN_MIN_FILL_RATIO = 0.5;
export const DETAIL_SECTION_HEADER_WEIGHT = AVG_CITIES_PER_LINE;

/** 都道府県 1 ブロックがページ内で占める「重み」。cities が空 (地域名が県名そのもの) でも
 *  1 行分の高さは占めるため、重みの下限を 1 にする */
function prefWeight(pg: PrefGroup): number {
  return Math.max(pg.cities.length, 1);
}

/** 震度別グループの地域リストを、市町村数バジェットで分割した詳細ページ配列にする。
 *  県はなるべく分断せず同一ページに詰めるが、1 県単独でバジェットを超えるときはページを
 *  またいで分割し、継続ページの県ブロックに continuation を立てる (spec §2-b 改訂)。
 *  震度グループをまたぐときはページ境界を切る (1 ページに複数震度を混在させない、不変)。
 *  budget は省略時 PAGE_CITY_BUDGET (T5c: 呼び出し側が cityBudgetFromArea で画面高さ駆動の
 *  値を渡せるよう引数化。既存呼び出し (省略) の挙動は不変) */
export function paginateAreas(
  groups: DisplayIntensityGroupV1[],
  budget: number = PAGE_CITY_BUDGET,
  options: PaginateAreasOptions = {},
): DetailPage[] {
  // page-body 内では最初の section にも見出しが付くため、地域へ使える予算から常に 1 行分を引く。
  const sectionContentBudget = Math.max(1, budget - DETAIL_SECTION_HEADER_WEIGHT);
  const sections: DetailPageSection[] = [];
  for (const group of groups) {
    const prefGroups = groupByPrefecture(group.areas);
    if (prefGroups.length === 0) continue;
    const prefectureCount = countByPrefecture(group.areas).filter((c) => c.pref != null).length;
    const cityCount = effectiveAreaCount(group);

    const pushPage = (bucket: DetailPrefGroup[]): void => {
      sections.push({ intensity: group.intensity, rank: group.rank, prefectureCount, cityCount, prefGroups: bucket });
    };

    let bucket: DetailPrefGroup[] = [];
    let bucketWeight = 0;
    for (const pg of prefGroups) {
      const weight = prefWeight(pg);
      if (weight > sectionContentBudget) {
        // 単独県がバジェット超: それまでのバケツを確定してから、この県だけでページをまたいで分割する
        if (bucket.length > 0) {
          pushPage(bucket);
          bucket = [];
          bucketWeight = 0;
        }
        for (let i = 0; i < pg.cities.length; i += sectionContentBudget) {
          pushPage([{ pref: pg.pref, cities: pg.cities.slice(i, i + sectionContentBudget), continuation: i > 0 }]);
        }
        continue;
      }
      if (bucketWeight + weight > sectionContentBudget && bucket.length > 0) {
        pushPage(bucket);
        bucket = [];
        bucketWeight = 0;
      }
      bucket.push({ ...pg, continuation: false });
      bucketWeight += weight;
    }
    if (bucket.length > 0) pushPage(bucket);
  }
  const asPage = (pageSections: DetailPageSection[]): DetailPage => {
    const first = pageSections[0]!;
    return { sections: pageSections, ...first };
  };
  if (options.allowCrossIntensity !== true) return sections.map((section) => asPage([section]));

  const minFill = options.widowOrphanMinFillRatio ?? WIDOW_ORPHAN_MIN_FILL_RATIO;
  const pages: DetailPage[] = [];
  for (const section of sections) {
    const previous = pages.at(-1);
    const previousSection = previous?.sections[0];
    const previousWeight = previousSection?.prefGroups.reduce((sum, pg) => sum + prefWeight(pg), 0) ?? 0;
    const sectionWeight = section.prefGroups.reduce((sum, pg) => sum + prefWeight(pg), 0);
    // 異なる震度だけを同居させる。前ページが半分未満の widow でも、予算を超えない限り
    // 次の強度を添えて孤立を避ける。既に複数 section のページは読みやすさ優先で閉じる。
    if (previous != null && previousSection != null && previous.sections.length === 1
      && previousSection.intensity !== section.intensity
      && previousWeight + sectionWeight + (2 * DETAIL_SECTION_HEADER_WEIGHT) <= budget
      && previousWeight / budget < minFill) {
      previous.sections.push(section);
    } else {
      pages.push(asPage([section]));
    }
  }
  return pages;
}

// pageGroupMeta/PageGroupMeta (震度グループ内の通し番号、旧「N/M」表示用) は T8① でドット
// インジケータ (PageDots) に統合され、境界 gap の任意機能でも一時利用したが T8⑤ でその機能も
// 撤去されたため、他に参照が無くなった (QuakePanel.svelte/LatestQuakeCard.svelte を含め grep で
// 確認済み)。死んだコードとして削除した
