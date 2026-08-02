import { describe, expect, it } from "vitest";
import {
  EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS,
  eewRegionFontTier,
  eewRegionListColumnCount,
  paginateEewRegions,
} from "../eew-region-tiers";
import type {
  DisplayEewRegionV1,
  DisplayIntensitySemanticV1,
  DisplayLgIntensitySemanticV1,
} from "../protocol";

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

describe("paginateEewRegions semantic authority", () => {
  const missing: DisplayIntensitySemanticV1 = {
    raw: null, presence: "missing", label: null, condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "notRendered", render: false, safetyLowerRank: null,
    safetyUpperRank: null, safetyRank: null, colorRank: null,
  };
  const region = (name: string, over: Partial<DisplayEewRegionV1> = {}): DisplayEewRegionV1 => ({
    name, intensity: "4", intensityTo: null, isPlum: false, hasArrived: false,
    arrivalTime: null, ...over,
  });

  it("semantic missing は旧 scalar があってもページへ投影しない", () => {
    const pages = paginateEewRegions([
      region("表示地域"),
      region("欠落地域", { intensity: "7", intensitySemantic: missing }),
    ], 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].sections[0].regions.map(({ name }) => name)).toEqual(["表示地域"]);
  });

  it("label が同じでも reason が異なる semantic は別 section に保つ", () => {
    const unknown = (description: string): DisplayIntensitySemanticV1 => ({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電", description,
      lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
      badge: "?", color: "unknown", render: true, safetyLowerRank: null,
      safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const pages = paginateEewRegions([
      region("地域A", { intensity: "", intensitySemantic: unknown("観測網A") }),
      region("地域B", { intensity: "", intensitySemantic: unknown("観測網B") }),
    ], 10);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.sections[0].semantic?.description)).toEqual(["観測網A", "観測網B"]);
  });

  it("震度 missing でも地域 ForecastLgInt semantic があれば page へ保持する", () => {
    const lgRange: DisplayLgIntensitySemanticV1 = {
      raw: "", presence: "range", label: "1〜2", condition: null, description: "地域長周期階級幅",
      lowerBound: "1", upperBound: "2", rawLowerBound: "１", rawUpperBound: "２",
      badge: "↔", color: "safetyUpperRank", render: true, safetyLowerRank: 1,
      safetyUpperRank: 2, safetyRank: 2, colorRank: 2,
    };
    const pages = paginateEewRegions([
      region("長周期のみ地域", {
        intensity: "", intensitySemantic: missing,
        lgIntensity: "1〜2", lgIntensitySemantic: lgRange,
      }),
    ], 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].sections[0]).toMatchObject({
      intensity: "",
      lgIntensity: "1〜2",
      lgRank: 2,
      lgSemantic: expect.objectContaining({ presence: "range", badge: "↔", colorRank: 2 }),
      regions: [expect.objectContaining({ name: "長周期のみ地域" })],
    });
  });
});
