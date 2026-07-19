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

// 旧: compact は kiosk でスクロールできないため、理論上限を超える件数は打ち切って
// 「ほか N 地域」で逃がす安全弁だった。第3波 Fix19 でこの cap は撤廃され、その後「固定サマリ
// 計器 + ページング」転換 (T4/T5) で region リストの自動スクロール自体も撤去された。現在は
// 閾値以下 (EEW_STATIC_LIST_MAX) のときだけ全件を静的表示し、閾値超は震度5弱以上の都道府県
// フラットリストへ切り替える (EewPanel.svelte、spec §2-a)。

// EEW フラット県名リスト (spec §2-a、閾値超 (>10 地域) のときの震度5弱以上の都道府県フラット
// リスト) の件数 → フォントサイズ判定。eewRegionFontTier と同じ件数駆動 tier の流儀。
// 対象は都道府県 (最大 47 distinct) なので region リストより件数レンジが狭く、少数ほど大きく
// 読める上限を持たせつつ (1 県などで見出し級まで肥大しないよう上限あり)、多数側は現行の
// region リスト下限 (16px) と揃える。閾値・段数は preview 目視で調整する前提の暫定値
export function eewPrefListFontTier(count: number): EewRegionFontTier {
  // 2026-07-09 preview 目視レビュー: 拡大にもう少し寛容に、と 1 段ずつ引き上げ (24/19/16 → 32/24/19)
  if (count <= 8) return { fontSizePx: 32 }; // 上限: headline-m 級 (1 県でもこれ以上は肥大させない)
  if (count <= 20) return { fontSizePx: 24 }; // 中間: title-m 級
  return { fontSizePx: 19 }; // 下限: body-l 級 (47 都道府県全部でも読める)
}

// EEW 静的リスト (.region-list) の 2 列分割閾値 (T8⑥)。行数 = 震度バケツ数 (EewPanel.svelte の
// buckets.length、.region-row 1 行 = 1 バケツ)。preview 調整前提の暫定値
export const EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS = 5;

/** 震度バケツ数 (行数) から .region-list の column-count を決める。閾値未満は 1 列、
 *  以上は 2 列の二値のみ (v3 以前のような細かい件数→列数 tier は廃止したまま) */
export function eewRegionListColumnCount(rowCount: number): number {
  return rowCount >= EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS ? 2 : 1;
}
