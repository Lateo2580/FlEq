// EEW 地域リストの密度 tier 判定 (件数 → フォントサイズ) と表示上限のガード。
// v4: 列数の手動指定 (column-count) は廃止し、font-size だけを返す。
// 列数は CSS 側の column-width (行合計幅を em 指定) に任せ、パネル幅から自動導出させる
// (手動 tier だと画面幅が同じでもシナリオ間で列数がずれ、視覚的な不統一を生んでいた)。
// 純関数化してテスト容易性を確保する (.svelte の <script module> エクスポートは
// 生 tsc が型解決できないため。lib/ticker-lanes.ts と同じ理由)。
//
// v5 (T8⑥、preview 目視レビュー): v4 の column-width 自動分割だと、emergency-1 のような
// 震度バケツ 4 個程度 (行数が少ない) でもパネル横幅が十分あると 2 列に割れてしまい、
// 「この程度の行数で 2 列に区切る必要性は薄い」と判断された。列数だけは行数 (震度バケツ数)
// 駆動の明示制御 (1 列 ⇔ 2 列の二値) に戻し、font-size は引き続き件数 tier に任せる
// (v3 以前のような細かい件数→列数 tier ではなく、単純な閾値 1 本にする)。
//
// v4 の「シナリオ間で列数がずれる」問題への再抵触は無い: 当時 (v3 以前) の手動 tier は
// 件数と無関係にパネル幅そのものに応じて列数を変える仕組みで、同じ行数でも画面幅が違う
// シナリオ (例: 通常パネル幅 vs 分割レイアウトで幅が狭いパネル) では列数が食い違っていた。
// v5 の eewRegionListColumnCount は行数のみを入力にする純関数で、パネル幅を一切見ないため、
// 同じ行数なら常に同じ列数になる (シナリオ間で決定的)。v4 で問題だった「幅依存のブレ」自体を
// 再導入していない

export interface EewRegionFontTier {
  fontSizePx: number;
}

export interface EewRegionPage {
  sections: Array<{
    intensity: string;
    rank: number;
    semantic: DisplayEewRegionV1["intensitySemantic"];
    regions: DisplayEewRegionV1[];
  }>;
}

import type { DisplayEewRegionV1 } from "./protocol";
import { intensityRank } from "./format";
import { intensityVisual } from "./quake-map-colors";

export function eewIntensityRangeLabel(region: Pick<DisplayEewRegionV1, "intensity" | "intensityTo" | "intensitySemantic">): string {
  if (region.intensitySemantic != null) {
    const visual = intensityVisual(region.intensitySemantic, region.intensity, null);
    return visual.render ? visual.label ?? "" : "";
  }
  const from = region.intensity;
  if (region.intensityTo == null || region.intensityTo === region.intensity) return from;
  if (region.intensityTo === "over") return `${from}程度以上`;
  return `${from}〜${region.intensityTo}`;
}

export function eewIntensityRangeRank(region: Pick<DisplayEewRegionV1, "intensity" | "intensityTo" | "intensitySemantic">): number {
  if (region.intensitySemantic != null) {
    return intensityVisual(region.intensitySemantic, region.intensity, null).colorRank ?? 0;
  }
  const fromRank = intensityRank(region.intensity) ?? 0;
  const toRank = region.intensityTo != null ? intensityRank(region.intensityTo) ?? 0 : 0;
  return Math.max(fromRank, toRank);
}

function rangeKey(region: Pick<DisplayEewRegionV1, "intensity" | "intensityTo" | "intensitySemantic">): string {
  if (region.intensitySemantic != null) {
    const visual = intensityVisual(region.intensitySemantic, region.intensity, null);
    return `${region.intensitySemantic.presence}\u0000${visual.label ?? ""}\u0000${visual.badge ?? ""}\u0000${visual.colorRank ?? ""}\u0000${visual.tooltip ?? ""}`;
  }
  return `${region.intensity}\u0000${region.intensityTo ?? ""}`;
}

/** 強度ごとの意味を保ったまま、地域数バジェットで EEW ページを作る。 */
export function paginateEewRegions(regions: DisplayEewRegionV1[], budget: number): EewRegionPage[] {
  const buckets = new Map<string, DisplayEewRegionV1[]>();
  for (const region of regions) {
    if (!intensityVisual(region.intensitySemantic, eewIntensityRangeLabel(region), eewIntensityRangeRank(region)).render) {
      continue;
    }
    const key = rangeKey(region);
    buckets.set(key, [...(buckets.get(key) ?? []), region]);
  }
  const pages: EewRegionPage[] = [];
  for (const [, items] of [...buckets].sort((a, b) => eewIntensityRangeRank(b[1][0]) - eewIntensityRangeRank(a[1][0]))) {
    const intensity = eewIntensityRangeLabel(items[0]);
    for (let start = 0; start < items.length; start += budget) {
      pages.push({ sections: [{
        intensity,
        rank: eewIntensityRangeRank(items[0]),
        semantic: items[0].intensitySemantic,
        regions: items.slice(start, start + budget),
      }] });
    }
  }
  return pages;
}

// compact: main-stack の非 main スロット (kiosk はスクロール不可、縦幅が乏しい)。
// 非 compact: full (1枚) / main-stack の主役スロット (縦横とも余裕がある)。
export function eewRegionFontTier(count: number, compact: boolean): EewRegionFontTier {
  if (compact) {
    // 最終レビュー Finding 2 (spec D1): EEW 予測地域は安全情報 = 層1 (14px 以上床)。
    // 旧実装は 9〜14 件で 13px、15 件以上で 11px を返しており、どちらも層1床を割っていた。
    // 15 件以上の枝は呼び出し元 (EewPanel.svelte) が showStaticList で
    // count <= EEW_STATIC_LIST_MAX (=10) のときしかこの tier を使わないため実質未到達だが、
    // 将来上限が変わっても床割れを再導入しないよう 8 件超は一律 14px に統合する
    // (旧 13px/11px の 2 段階分岐を廃止)
    if (count <= 8) return { fontSizePx: 16 };
    return { fontSizePx: 14 };
  }
  if (count <= 10) return { fontSizePx: 22 };
  if (count <= 24) return { fontSizePx: 20 };
  if (count <= 40) return { fontSizePx: 18 };
  return { fontSizePx: 16 };
}

// 閾値以下 (EEW_STATIC_LIST_MAX) は全件を静的表示し、閾値超は強度別ページャへ切り替える。

// EEW 静的リスト (.region-list) の 2 列分割閾値 (T8⑥)。行数 = 震度バケツ数 (EewPanel.svelte の
// buckets.length、.region-row 1 行 = 1 バケツ)。preview 調整前提の暫定値
export const EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS = 5;

/** 震度バケツ数 (行数) から .region-list の column-count を決める。閾値未満は 1 列、
 *  以上は 2 列の二値のみ (v3 以前のような細かい件数→列数 tier は廃止したまま) */
export function eewRegionListColumnCount(rowCount: number): number {
  return rowCount >= EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS ? 2 : 1;
}
