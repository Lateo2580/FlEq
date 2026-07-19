import { describe, expect, it } from "vitest";
import {
  buildMarqueeSegments,
  clampSegmentIndex,
  isChipEmphasized,
  isMultiSegment,
  joinMarqueeSegments,
  nextSegmentIndex,
} from "../tsunami-marquee-sequence";
import type { CoastGroup } from "../tsunami-banner";

const groups: CoastGroup[] = [
  { level: "majorWarning", label: "大津波警報", names: ["宮崎県", "高知県"] },
  { level: "warning", label: "津波警報", names: ["大分県瀬戸内海沿岸"] },
  { level: "advisory", label: "津波注意報", names: ["沖縄本島地方"] },
];

describe("buildMarqueeSegments", () => {
  it("各グループを【label】region・region 形式のセグメントへ変換する", () => {
    const segments = buildMarqueeSegments(groups);
    expect(segments).toEqual([
      { level: "majorWarning", text: "【大津波警報】宮崎県・高知県" },
      { level: "warning", text: "【津波警報】大分県瀬戸内海沿岸" },
      { level: "advisory", text: "【津波注意報】沖縄本島地方" },
    ]);
  });

  it("label が null (未分類) のグループはラベルなしでそのまま並べる", () => {
    const segments = buildMarqueeSegments([{ level: null, label: null, names: ["大阪府"] }]);
    expect(segments).toEqual([{ level: null, text: "大阪府" }]);
  });
});

describe("joinMarqueeSegments", () => {
  it("全セグメントを全角スペースで連結する (reduced-motion 静的フォールバック用)", () => {
    const segments = buildMarqueeSegments(groups);
    expect(joinMarqueeSegments(segments)).toBe(
      "【大津波警報】宮崎県・高知県　【津波警報】大分県瀬戸内海沿岸　【津波注意報】沖縄本島地方",
    );
  });

  it("空配列は空文字", () => {
    expect(joinMarqueeSegments([])).toBe("");
  });
});

describe("isMultiSegment", () => {
  it("2 種別以上なら true", () => {
    expect(isMultiSegment(buildMarqueeSegments(groups))).toBe(true);
  });

  it("1 種別以下なら false (現行と同じ単一ループ)", () => {
    expect(isMultiSegment(buildMarqueeSegments(groups.slice(0, 1)))).toBe(false);
    expect(isMultiSegment([])).toBe(false);
  });
});

describe("nextSegmentIndex", () => {
  it("末尾なら先頭へ循環する", () => {
    expect(nextSegmentIndex(0, 3)).toBe(1);
    expect(nextSegmentIndex(1, 3)).toBe(2);
    expect(nextSegmentIndex(2, 3)).toBe(0);
  });

  it("長さ 0 は 0 を返す", () => {
    expect(nextSegmentIndex(0, 0)).toBe(0);
  });
});

describe("clampSegmentIndex", () => {
  it("範囲内ならそのまま", () => {
    expect(clampSegmentIndex(1, 3)).toBe(1);
  });

  it("範囲外 (種別が減って index が溢れた) なら 0 に丸める", () => {
    expect(clampSegmentIndex(2, 1)).toBe(0);
  });

  it("長さ 0 は 0 を返す", () => {
    expect(clampSegmentIndex(0, 0)).toBe(0);
  });
});

describe("isChipEmphasized", () => {
  it("多種別巡回時は一致する種別だけ強調する", () => {
    expect(isChipEmphasized("majorWarning", "majorWarning", true)).toBe(true);
    expect(isChipEmphasized("warning", "majorWarning", true)).toBe(false);
    expect(isChipEmphasized("advisory", "majorWarning", true)).toBe(false);
  });

  it("単一種別 (isMultiSegment=false) なら常時強調", () => {
    expect(isChipEmphasized("majorWarning", "majorWarning", false)).toBe(true);
    expect(isChipEmphasized("warning", "majorWarning", false)).toBe(true);
  });

  it("未分類セグメント巡回中 (currentLevel=null) は差をつけない (常時強調のまま)", () => {
    expect(isChipEmphasized("majorWarning", null, true)).toBe(true);
    expect(isChipEmphasized("warning", null, true)).toBe(true);
  });
});
