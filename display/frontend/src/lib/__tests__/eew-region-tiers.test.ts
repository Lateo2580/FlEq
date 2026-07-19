import { describe, expect, it } from "vitest";
import {
  EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS,
  eewPrefListFontTier,
  eewRegionFontTier,
  eewRegionListColumnCount,
} from "../eew-region-tiers";

// 最終レビュー Finding 2 (spec D1、確信度 0.97-0.99): compact 枝は EEW 予測地域 = 層1
// (安全情報、14px 以上床) を割ってはいけない。旧実装は 9〜14 件で 13px、15 件以上で 11px を
// 返しており両方床割れだった。床を割らないことをここで固定する
describe("eewRegionFontTier compact (spec D1: 層1 14px 床)", () => {
  it("8 件以下は 16px", () => {
    expect(eewRegionFontTier(1, true).fontSizePx).toBe(16);
    expect(eewRegionFontTier(8, true).fontSizePx).toBe(16);
  });

  it("9 件以上は床の 14px (旧 13px/11px 分岐は廃止)", () => {
    expect(eewRegionFontTier(9, true).fontSizePx).toBe(14);
    expect(eewRegionFontTier(14, true).fontSizePx).toBe(14);
    expect(eewRegionFontTier(15, true).fontSizePx).toBe(14);
    expect(eewRegionFontTier(47, true).fontSizePx).toBe(14); // 上限を大きく超えても床のまま
  });

  it("非 compact は従来どおり 16px 以上を維持する (層1床を割る組み合わせが無いことの確認)", () => {
    expect(eewRegionFontTier(10, false).fontSizePx).toBe(22);
    expect(eewRegionFontTier(24, false).fontSizePx).toBe(20);
    expect(eewRegionFontTier(40, false).fontSizePx).toBe(18);
    expect(eewRegionFontTier(41, false).fontSizePx).toBe(16);
  });
});

describe("eewPrefListFontTier", () => {
  it("8 県以下は上限サイズ (32px、1 県でもこれ以上肥大しない)", () => {
    expect(eewPrefListFontTier(1).fontSizePx).toBe(32);
    expect(eewPrefListFontTier(8).fontSizePx).toBe(32);
  });

  it("9〜20 県は中間サイズ (24px)", () => {
    expect(eewPrefListFontTier(9).fontSizePx).toBe(24);
    expect(eewPrefListFontTier(20).fontSizePx).toBe(24);
  });

  it("21 県以上は下限サイズ (19px)", () => {
    expect(eewPrefListFontTier(21).fontSizePx).toBe(19);
    expect(eewPrefListFontTier(47).fontSizePx).toBe(19); // 全 47 都道府県でも下限で頭打ち
  });

  it("0 県 (呼び出し側で非表示にする想定だが、関数自体は上限サイズを返す)", () => {
    expect(eewPrefListFontTier(0).fontSizePx).toBe(32);
  });
});

// T8⑥ (preview 目視レビュー): EEW 静的リストの列数を行数 (震度バケツ数) 駆動にする。
// 閾値未満は 1 列、以上は 2 列の二値のみ
describe("eewRegionListColumnCount", () => {
  it(`${EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS} 行未満は 1 列`, () => {
    expect(eewRegionListColumnCount(0)).toBe(1);
    expect(eewRegionListColumnCount(1)).toBe(1);
    expect(eewRegionListColumnCount(EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS - 1)).toBe(1);
  });

  it(`${EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS} 行以上は 2 列`, () => {
    expect(eewRegionListColumnCount(EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS)).toBe(2);
    expect(eewRegionListColumnCount(EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS + 1)).toBe(2);
    expect(eewRegionListColumnCount(10)).toBe(2); // EEW_STATIC_LIST_MAX の上限件数でも 2 のまま
  });
});
